// SPDX-License-Identifier: Apache-2.0
//! Component outcomes, the aggregate outcome, completion, and the immutable
//! run report record.
//!
//! This module implements the record side of the run report contract in
//! `contracts/v0/run-report.schema.json` and the report rules of the contracts
//! README. One run assesses one case. Every defined check appears in
//! `checks`, because all checks are required in v0 and no cost-based
//! short-circuiting exists.
//!
//! Three separations hold the record together:
//!
//! - The component [`Outcome`] of one check, the derived
//!   [`AggregateOutcome`] of the case, and the [`CompletionStatus`] of the
//!   execution are three different facts. A cancelled run keeps the
//!   components it completed, and a completed run can still end in `error`.
//! - [`aggregate`] folds components with the fixed order of the contracts:
//!   any `fail` gives `fail`, otherwise any `error` gives `error`, otherwise
//!   any `review` or `skipped` gives `review`, otherwise `pass`. A skipped
//!   check surfaces as `review` in the aggregate while its reason stays in
//!   its own record. Every component record stays visible, including an error
//!   that accompanies a fail.
//! - The report records measurements, never application authorization. No
//!   field states that an action is approved, and a pass never authorizes a
//!   send or bypasses host policy. [`RunMode`] records how the host declared
//!   the run; it changes no record content. The host consumes the report and
//!   decides.
//!
//! A finished [`RunReport`] is immutable. The type offers read accessors
//! only, so a late result cannot enter a completed record. Build a new report
//! instead of editing one. [`parse_run_report`] rebuilds a stored report
//! under the same rules and rejects a stored aggregate that disagrees with
//! its component outcomes.
//!
//! Each component [`CheckRecord`] keeps the raw assessment, the executed
//! rule, the applied policy parameters, the actual evaluator versions,
//! attempts, timing, usage, and a sanitized reason for `error` and `skipped`
//! outcomes. Evidence that the evaluator selected stays inside the
//! assessment, exactly as returned. Supplied source references are case
//! inputs, and the report offers no field that could present them as
//! evaluator-selected support.
//!
//! The assessment keeps its recorded spelling. This module enforces the
//! structural assessment contract at the report boundary; the semantic
//! normalization, such as evidence authorization against the `using` list of
//! the check, belongs to the evaluator adapter boundary.

use crate::artifact::{expect_object, reject_unknown_fields};
use crate::case::ValidatedCase;
use crate::definition::{is_artifact_id, parse_bounded_string, CheckKind, ValidatedDefinition};
use crate::error::{ReasonCode, ValidationError};
use crate::hashing;
use crate::rule::{validate_parameter, AppliedRule, RuleKeyword, RuleOutcome, RuleResult};
use serde::{Serialize, Serializer};
use serde_json::{Map, Number, Value};

/// Fields of one run report object, from the schema file.
const REPORT_FIELDS: &[&str] = &[
    "schema_version",
    "run_id",
    "mode",
    "definition",
    "profile",
    "case",
    "baseline",
    "checks",
    "aggregate",
    "completion",
    "totals",
];

/// Fields of one component record, from the schema file.
const CHECK_RECORD_FIELDS: &[&str] = &[
    "check",
    "kind",
    "outcome",
    "assessment",
    "applied_rule",
    "applied_policy",
    "evaluator",
    "attempts",
    "timing",
    "usage",
    "reason",
];

/// Fields of one sanitized reason, from `common.schema.json`.
const REASON_FIELDS: &[&str] = &["code", "message", "field_path"];

/// Fields of one applied rule record, from the schema file.
const APPLIED_RULE_FIELDS: &[&str] = &["rule", "input", "parameters"];

/// Fields of one applied policy record, from the schema file.
const APPLIED_POLICY_FIELDS: &[&str] = &["accept_cutoff", "rejection_cutoff", "confidence_floor"];

/// Fields of one evaluator version record, from the schema file.
const EVALUATOR_FIELDS: &[&str] = &["id", "adapter_version", "model_resolved"];

/// Fields of one timing record, from the schema file.
const TIMING_FIELDS: &[&str] = &["queued_ms", "execution_ms"];

/// Fields of one assessment object, from the assessment schema file.
const ASSESSMENT_FIELDS: &[&str] = &[
    "kind",
    "label",
    "value",
    "level",
    "position",
    "distribution",
    "confidence",
    "evidence",
];

/// Fields of one distribution entry, from the assessment schema file.
const DISTRIBUTION_FIELDS: &[&str] = &["name", "mass"];

/// Fields of one evidence entry, from the assessment schema file.
const EVIDENCE_FIELDS: &[&str] = &["input", "reference"];

/// The outcome of one check, as `common.schema.json` defines it.
///
/// Pass meets the acceptance meaning of the check under the selected
/// profile. Fail meets an unacceptable meaning. Review needs a human
/// decision. Error reports an execution or validation failure. Skipped
/// reports that the check was not attempted, with a specific reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The assessment meets the acceptance meaning.
    Pass,
    /// The assessment meets an unacceptable meaning.
    Fail,
    /// The evidence or assessment supports no automatic decision.
    Review,
    /// Execution or validation failed.
    Error,
    /// The check was not attempted, with a specific reason.
    Skipped,
}

impl Outcome {
    /// Returns the stable outcome string of the contracts.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
            Self::Review => "review",
            Self::Error => "error",
            Self::Skipped => "skipped",
        }
    }

    /// Returns the outcome of one contract string, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "pass" => Some(Self::Pass),
            "fail" => Some(Self::Fail),
            "review" => Some(Self::Review),
            "error" => Some(Self::Error),
            "skipped" => Some(Self::Skipped),
            _ => None,
        }
    }
}

impl From<RuleOutcome> for Outcome {
    fn from(outcome: RuleOutcome) -> Self {
        match outcome {
            RuleOutcome::Pass => Self::Pass,
            RuleOutcome::Fail => Self::Fail,
        }
    }
}

/// The aggregate outcome of one case, as `common.schema.json` defines it.
///
/// The aggregate is derived state. [`aggregate`] computes it from the
/// component outcomes with the fixed order of the contracts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AggregateOutcome {
    /// Every check passed.
    Pass,
    /// At least one check failed.
    Fail,
    /// No check failed or errored, and at least one needs a human decision
    /// or was skipped.
    Review,
    /// No check failed, and at least one errored.
    Error,
}

impl AggregateOutcome {
    /// Returns the stable outcome string of the contracts.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
            Self::Review => "review",
            Self::Error => "error",
        }
    }

    /// Returns the aggregate of one contract string, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "pass" => Some(Self::Pass),
            "fail" => Some(Self::Fail),
            "review" => Some(Self::Review),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

/// The execution status of one run, as `common.schema.json` defines it.
///
/// Completion is independent of the aggregate outcome. Every status is
/// terminal: a report in any of these states is immutable, and a late result
/// cannot change it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionStatus {
    /// The run reached a terminal state on its own.
    Completed,
    /// The caller cancelled the run.
    Cancelled,
    /// The total run deadline passed.
    DeadlineExceeded,
}

impl CompletionStatus {
    /// Returns the stable status string of the contracts.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::DeadlineExceeded => "deadline_exceeded",
        }
    }

    /// Returns the status of one contract string, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "completed" => Some(Self::Completed),
            "cancelled" => Some(Self::Cancelled),
            "deadline_exceeded" => Some(Self::DeadlineExceeded),
            _ => None,
        }
    }
}

/// How the host declared the run, as `common.schema.json` defines it.
///
/// Shadow records the new outcome next to the existing decision without
/// performing application actions. Enforcement returns a report that the
/// host uses to decide. The mode changes no record content, and no mode
/// turns a report into an authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// Record the outcome next to the existing decision.
    Shadow,
    /// Return a report that the host uses to decide.
    Enforcement,
}

impl RunMode {
    /// Returns the stable mode string of the contracts.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Shadow => "shadow",
            Self::Enforcement => "enforcement",
        }
    }

    /// Returns the mode of one contract string, or `None` for any other text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "shadow" => Some(Self::Shadow),
            "enforcement" => Some(Self::Enforcement),
            _ => None,
        }
    }
}

/// Whether a question or a rule was assessed, as the run report contract
/// states it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    /// An evaluator assessed a question.
    Question,
    /// The core executed a deterministic rule.
    Rule,
}

impl RecordKind {
    /// Returns the stable kind string of the contracts.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Question => "question",
            Self::Rule => "rule",
        }
    }

    /// Returns the kind of one contract string, or `None` for any other text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "question" => Some(Self::Question),
            "rule" => Some(Self::Rule),
            _ => None,
        }
    }

    /// Returns the record kind of one check kind. Every non-rule check puts
    /// a question to an evaluator.
    pub const fn of(check_kind: CheckKind) -> Self {
        match check_kind {
            CheckKind::Rule => Self::Rule,
            CheckKind::Categorical | CheckKind::Binary | CheckKind::Ordered => Self::Question,
        }
    }
}

/// Folds component outcomes into the aggregate outcome.
///
/// The order is fixed by the contracts: any `fail` gives `fail`, otherwise
/// any `error` gives `error`, otherwise any `review` or `skipped` gives
/// `review`, otherwise `pass`. A skipped check surfaces as `review` in the
/// aggregate, and its own record keeps its reason.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `empty_check_set` when the slice holds
/// no outcome. All checks are required in v0, so a report with no component
/// outcome is not a run state.
pub fn aggregate(outcomes: &[Outcome]) -> Result<AggregateOutcome, ValidationError> {
    if outcomes.is_empty() {
        return Err(ValidationError::new(
            ReasonCode::EmptyCheckSet,
            "/checks",
            "The report holds no component outcome. All checks are required.",
        ));
    }
    let any = |outcome: Outcome| outcomes.contains(&outcome);
    if any(Outcome::Fail) {
        Ok(AggregateOutcome::Fail)
    } else if any(Outcome::Error) {
        Ok(AggregateOutcome::Error)
    } else if any(Outcome::Review) || any(Outcome::Skipped) {
        Ok(AggregateOutcome::Review)
    } else {
        Ok(AggregateOutcome::Pass)
    }
}

/// One sanitized reason, as `common.schema.json` defines it.
///
/// The code comes from the stable registry. The message is a short cause
/// that holds no credentials and no raw case content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SanitizedReason {
    /// Stable reason code from the registry.
    pub code: ReasonCode,
    /// Short sanitized cause, 1 to 500 characters.
    pub message: String,
    /// JSON Pointer to the rejected field, when the reason is a validation
    /// failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_path: Option<String>,
}

impl SanitizedReason {
    /// Builds one reason from a registry code and a short cause.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_field_type` when the
    /// message holds no character or more than 500 characters.
    pub fn new(code: ReasonCode, message: impl Into<String>) -> Result<Self, ValidationError> {
        let message = message.into();
        if message.is_empty() || message.chars().count() > 500 {
            return Err(ValidationError::invalid_field_type(
                "/reason/message",
                "The reason message must hold 1 to 500 characters.",
            ));
        }
        Ok(Self {
            code,
            message,
            field_path: None,
        })
    }

    /// Builds one reason from one validation failure, keeping its pointer.
    ///
    /// The message of a [`ValidationError`] is already sanitized by
    /// construction, so this conversion moves it without rewording.
    pub fn from_validation_error(error: &ValidationError) -> Self {
        Self {
            code: error.code,
            message: error.message.clone(),
            field_path: (!error.field_path.is_empty()).then(|| error.field_path.clone()),
        }
    }

    /// Checks this reason against the contract bounds.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_field_type` when the
    /// message or the pointer breaks its length bound.
    pub fn validate(&self, base: &str) -> Result<(), ValidationError> {
        if self.message.is_empty() || self.message.chars().count() > 500 {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/message"),
                "The reason message must hold 1 to 500 characters.",
            ));
        }
        if let Some(path) = &self.field_path {
            if path.is_empty() || path.chars().count() > 500 {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/field_path"),
                    "The reason field path must hold 1 to 500 characters.",
                ));
            }
        }
        Ok(())
    }
}

/// The numerical policy that produced one question outcome, as executed.
///
/// The report records the executed parameters. Fitting policies is a
/// separate concern that never runs inside a report.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppliedPolicy {
    /// Acceptance cutoff, above 0.5 and at most 1.
    pub accept_cutoff: f64,
    /// Rejection cutoff, above 0.5 and at most 1.
    pub rejection_cutoff: f64,
    /// Confidence floor, above 0.5 and at most 1, when one applied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence_floor: Option<f64>,
}

impl AppliedPolicy {
    /// Checks one cutoff against the contract range.
    fn cutoff_in_range(value: f64) -> bool {
        (0.5..=1.0).contains(&value) && value != 0.5
    }

    /// Checks this policy against the contract bounds.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_field_type` when a cutoff
    /// sits at 0.5 or below, or above 1.
    pub fn validate(&self, base: &str) -> Result<(), ValidationError> {
        for (name, value) in [
            ("accept_cutoff", self.accept_cutoff),
            ("rejection_cutoff", self.rejection_cutoff),
        ] {
            if !Self::cutoff_in_range(value) {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/{name}"),
                    "The cutoff must stay above 0.5 and at most 1.",
                ));
            }
        }
        if let Some(floor) = self.confidence_floor {
            if !Self::cutoff_in_range(floor) {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/confidence_floor"),
                    "The confidence floor must stay above 0.5 and at most 1.",
                ));
            }
        }
        Ok(())
    }
}

/// The actual evaluator versions that served one check execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvaluatorVersions {
    /// Registered evaluator identifier.
    pub id: String,
    /// Version of the adapter that made the call.
    pub adapter_version: String,
    /// Model version that actually served this execution, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_resolved: Option<String>,
}

impl EvaluatorVersions {
    /// Checks this record against the contract bounds.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] when the identifier breaks the artifact
    /// identifier rule or a version string breaks its length bound.
    pub fn validate(&self, base: &str) -> Result<(), ValidationError> {
        if !is_artifact_id(&self.id) {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/id"),
                "The evaluator identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        if self.adapter_version.is_empty() || self.adapter_version.chars().count() > 64 {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/adapter_version"),
                "The adapter version must hold 1 to 64 characters.",
            ));
        }
        if let Some(model) = &self.model_resolved {
            if model.is_empty() || model.chars().count() > 128 {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/model_resolved"),
                    "The resolved model version must hold 1 to 128 characters.",
                ));
            }
        }
        Ok(())
    }
}

/// The timing of one check execution. Numbers keep their recorded spelling.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Timing {
    /// Time spent waiting for a slot, in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_ms: Option<Number>,
    /// Time spent executing, in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_ms: Option<Number>,
}

impl Timing {
    /// Checks this record against the contract bounds.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_field_type` when one
    /// duration is negative.
    pub fn validate(&self, base: &str) -> Result<(), ValidationError> {
        for (name, value) in [
            ("queued_ms", &self.queued_ms),
            ("execution_ms", &self.execution_ms),
        ] {
            if let Some(number) = value {
                if !matches!(number.as_f64(), Some(duration) if duration >= 0.0) {
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/{name}"),
                        "The duration must be zero or positive.",
                    ));
                }
            }
        }
        Ok(())
    }
}

/// One component outcome of a run, as the run report contract states it.
///
/// A rule record keeps the executed rule. A question record keeps the raw
/// assessment and the applied policy. An `error` or `skipped` outcome keeps
/// a sanitized reason. Every other field is optional measurement metadata
/// that stays absent when it was not measured.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CheckRecord {
    /// The assessed check identifier.
    pub check: String,
    /// Whether a question or a rule was assessed.
    pub kind: RecordKind,
    /// The outcome of this check.
    pub outcome: Outcome,
    /// The raw measurement, for a question check, exactly as returned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assessment: Option<Value>,
    /// The executed rule, for a rule check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_rule: Option<AppliedRule>,
    /// The executed policy parameters, for a question check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_policy: Option<AppliedPolicy>,
    /// The actual evaluator versions used for this check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluator: Option<EvaluatorVersions>,
    /// Attempts made, including retries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u64>,
    /// Timing of this execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<Timing>,
    /// Usage amounts reported by this execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Map<String, Value>>,
    /// Sanitized reason, required for `error` and `skipped` outcomes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<SanitizedReason>,
}

impl CheckRecord {
    /// Builds one rule record from one assessed rule result.
    ///
    /// The rule explanation of [`RuleResult`] is generated text, not a
    /// sanitized failure reason, so it stays out of the record. The default
    /// explanation of a report comes from the check criteria and the executed
    /// policy, and the caller supplies it through
    /// [`ReportBuilder::explanation`](ReportBuilder::explanation).
    pub fn from_rule_result(result: &RuleResult) -> Self {
        Self {
            check: result.check.clone(),
            kind: RecordKind::Rule,
            outcome: Outcome::from(result.outcome),
            assessment: None,
            applied_rule: Some(result.applied_rule.clone()),
            applied_policy: None,
            evaluator: None,
            attempts: None,
            timing: None,
            usage: None,
            reason: None,
        }
    }

    /// Checks one record against the run report contract.
    ///
    /// `base` is the JSON Pointer of this record, for example `/checks/0`.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] when the identifier breaks its rule,
    /// when a rule record holds no executed rule or a question record holds
    /// one, when an `error` or `skipped` outcome holds no reason, or when a
    /// nested record breaks its bounds.
    pub fn validate(&self, base: &str) -> Result<(), ValidationError> {
        if !is_artifact_id(&self.check) {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/check"),
                "The check identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        match self.kind {
            RecordKind::Rule => {
                if self.applied_rule.is_none() {
                    return Err(ValidationError::missing(format!("{base}/applied_rule")));
                }
                if self.assessment.is_some() {
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/assessment"),
                        "A rule check records its executed rule, not an assessment.",
                    ));
                }
                if self.applied_policy.is_some() {
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/applied_policy"),
                        "A rule check records its executed rule, not a numerical policy.",
                    ));
                }
            }
            RecordKind::Question => {
                if self.applied_rule.is_some() {
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/applied_rule"),
                        "A question check records an assessment, not an executed rule.",
                    ));
                }
            }
        }
        if matches!(self.outcome, Outcome::Error | Outcome::Skipped) && self.reason.is_none() {
            return Err(ValidationError::missing(format!("{base}/reason")));
        }
        if let Some(rule) = &self.applied_rule {
            if !crate::definition::is_input_name(&rule.input) {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/applied_rule/input"),
                    "The rule input name must use letters, digits, or underscores, 64 characters at most.",
                ));
            }
            validate_parameter(&rule.parameters, &format!("{base}/applied_rule/parameters"))?;
        }
        if let Some(policy) = &self.applied_policy {
            policy.validate(&format!("{base}/applied_policy"))?;
        }
        if let Some(evaluator) = &self.evaluator {
            evaluator.validate(&format!("{base}/evaluator"))?;
        }
        if let Some(attempts) = self.attempts {
            if attempts == 0 {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/attempts"),
                    "The attempt count must be at least 1.",
                ));
            }
        }
        if let Some(timing) = &self.timing {
            timing.validate(&format!("{base}/timing"))?;
        }
        if let Some(usage) = &self.usage {
            check_usage(usage, &format!("{base}/usage"))?;
        }
        if let Some(reason) = &self.reason {
            reason.validate(&format!("{base}/reason"))?;
        }
        if let Some(assessment) = &self.assessment {
            check_assessment(assessment, &format!("{base}/assessment"))?;
        }
        Ok(())
    }
}

/// The shadow baseline: the existing decision recorded next to the new
/// outcome. Agreement with the baseline is not correctness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Baseline {
    /// The existing decision, 1 to 64 characters.
    pub outcome: String,
    /// Revision of the existing decision path, 1 to 128 characters.
    pub revision: String,
}

/// Reference to one artifact by stable name and canonical content hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtifactReference {
    /// Stable artifact name.
    pub name: String,
    /// Canonical content hash of the artifact.
    pub content_hash: String,
}

impl ArtifactReference {
    /// References one validated definition by name and content hash.
    ///
    /// The hash comes from [`hashing::definition_hash`], the one definition
    /// boundary. A formatting change to the artifact keeps this reference.
    pub fn for_definition(definition: &ValidatedDefinition) -> Self {
        Self {
            name: definition.as_definition().name.clone(),
            content_hash: hashing::definition_hash(definition),
        }
    }

    /// Checks this reference against the contract rules.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] when the name breaks the artifact
    /// identifier rule or the hash is not 64 lowercase hexadecimal
    /// characters.
    pub fn validate(&self, base: &str) -> Result<(), ValidationError> {
        if !is_artifact_id(&self.name) {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/name"),
                "The artifact name must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        if !hashing::is_hash_hex(&self.content_hash) {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/content_hash"),
                "The content hash must hold 64 lowercase hexadecimal characters.",
            ));
        }
        Ok(())
    }
}

/// Reference to one profile by identifier and canonical content hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProfileReference {
    /// Stable profile identifier.
    pub id: String,
    /// Canonical content hash of the profile.
    pub content_hash: String,
}

impl ProfileReference {
    /// Checks this reference against the contract rules.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] when the identifier breaks the artifact
    /// identifier rule or the hash is not 64 lowercase hexadecimal
    /// characters.
    pub fn validate(&self, base: &str) -> Result<(), ValidationError> {
        if !is_artifact_id(&self.id) {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/id"),
                "The profile identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        if !hashing::is_hash_hex(&self.content_hash) {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/content_hash"),
                "The content hash must hold 64 lowercase hexadecimal characters.",
            ));
        }
        Ok(())
    }
}

/// Reference to one case by stable identifier and input content hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CaseReference {
    /// Stable case identifier.
    pub id: String,
    /// Hash of the canonical case input object.
    pub input_hash: String,
}

impl CaseReference {
    /// References one validated case by identifier and input hash.
    ///
    /// The hash comes from [`hashing::input_hash`] and covers the complete
    /// input object, including inputs that no check reads.
    pub fn for_case(case: &ValidatedCase<'_>) -> Self {
        Self {
            id: case.id().to_owned(),
            input_hash: hashing::input_hash(case.input()),
        }
    }

    /// Checks this reference against the contract rules.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] when the identifier breaks the case
    /// identifier rule or the hash is not 64 lowercase hexadecimal
    /// characters.
    pub fn validate(&self, base: &str) -> Result<(), ValidationError> {
        if !crate::case::is_case_id(&self.id) {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/id"),
                "The case identifier must start with a lowercase letter or a digit, then hold lowercase letters, digits, dots, underscores, or hyphens, 128 characters at most.",
            ));
        }
        if !hashing::is_hash_hex(&self.input_hash) {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/input_hash"),
                "The input hash must hold 64 lowercase hexadecimal characters.",
            ));
        }
        Ok(())
    }
}

/// The execution status of one run with its terminal time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Completion {
    /// Terminal status of the run.
    pub status: CompletionStatus,
    /// Time at which the run reached its terminal state, in RFC 3339 format.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

impl Completion {
    /// Checks this completion against the contract rules.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_field_type` when the
    /// terminal time is not one RFC 3339 date-time.
    pub fn validate(&self, base: &str) -> Result<(), ValidationError> {
        if let Some(time) = &self.completed_at {
            if !is_rfc3339(time) {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/completed_at"),
                    "The terminal time must be one RFC 3339 date-time in UTC or with an offset.",
                ));
            }
        }
        Ok(())
    }
}

/// The run totals. Numbers keep their recorded spelling.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Totals {
    /// Total elapsed time from submission to terminal state, in
    /// milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<Number>,
    /// Usage amounts summed over the run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Map<String, Value>>,
}

impl Totals {
    /// Checks these totals against the contract bounds.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_field_type` when the
    /// elapsed time is negative or one usage value is not a number.
    pub fn validate(&self, base: &str) -> Result<(), ValidationError> {
        if let Some(number) = &self.elapsed_ms {
            if !matches!(number.as_f64(), Some(elapsed) if elapsed >= 0.0) {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/elapsed_ms"),
                    "The elapsed time must be zero or positive.",
                ));
            }
        }
        if let Some(usage) = &self.usage {
            check_usage(usage, &format!("{base}/usage"))?;
        }
        Ok(())
    }
}

/// The aggregate block of one report: the derived outcome and its
/// explanation. The explanation comes from the check criteria and the
/// executed policy, never from an invented evaluator rationale.
#[derive(Debug, Clone, PartialEq, Serialize)]
struct AggregateEntry {
    outcome: AggregateOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    explanation: Option<String>,
}

/// The immutable record of one assessed case.
///
/// A finished report offers read accessors only. There is no mutation
/// method, so a late result cannot change a completed record: build a new
/// report instead. The record holds measurements and outcomes, never an
/// application authorization.
#[derive(Debug, Clone, PartialEq)]
pub struct RunReport {
    /// Artifact schema version.
    schema_version: u32,
    /// Identifier of this run, supplied by the wrapper or host.
    run_id: String,
    /// How the host declared this run.
    mode: RunMode,
    /// The definition that produced the checks.
    definition: ArtifactReference,
    /// The profile used for this run.
    profile: ProfileReference,
    /// The assessed case.
    case: CaseReference,
    /// The shadow baseline, in shadow mode.
    baseline: Option<Baseline>,
    /// One record per defined check. All checks are required in v0.
    checks: Vec<CheckRecord>,
    /// The derived aggregate outcome with its explanation.
    aggregate: AggregateEntry,
    /// The terminal execution status.
    completion: Completion,
    /// The run totals.
    totals: Option<Totals>,
}

impl RunReport {
    /// Returns the identifier of this run.
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// Returns how the host declared this run.
    pub fn mode(&self) -> RunMode {
        self.mode
    }

    /// Returns the definition reference of this run.
    pub fn definition(&self) -> &ArtifactReference {
        &self.definition
    }

    /// Returns the profile reference of this run.
    pub fn profile(&self) -> &ProfileReference {
        &self.profile
    }

    /// Returns the case reference of this run.
    pub fn case(&self) -> &CaseReference {
        &self.case
    }

    /// Returns the shadow baseline, when one was recorded.
    pub fn baseline(&self) -> Option<&Baseline> {
        self.baseline.as_ref()
    }

    /// Returns every component record, including errors that accompany a
    /// fail.
    pub fn checks(&self) -> &[CheckRecord] {
        &self.checks
    }

    /// Returns the component outcome of one check.
    pub fn outcome_of(&self, check_id: &str) -> Option<Outcome> {
        self.checks
            .iter()
            .find(|record| record.check == check_id)
            .map(|record| record.outcome)
    }

    /// Returns the derived aggregate outcome.
    pub fn aggregate(&self) -> AggregateOutcome {
        self.aggregate.outcome
    }

    /// Returns the generated explanation, when one was recorded.
    pub fn explanation(&self) -> Option<&str> {
        self.aggregate.explanation.as_deref()
    }

    /// Returns the terminal execution status with its time.
    pub fn completion(&self) -> &Completion {
        &self.completion
    }

    /// Returns the run totals, when they were recorded.
    pub fn totals(&self) -> Option<&Totals> {
        self.totals.as_ref()
    }

    /// Validates every part and assembles one immutable report.
    ///
    /// The aggregate is computed here from the component outcomes, so a
    /// built report cannot state an aggregate that its checks do not
    /// support. Callers reach this through [`ReportBuilder::finish`] and
    /// [`parse_run_report`].
    #[allow(clippy::too_many_arguments)]
    fn assemble(
        run_id: String,
        mode: RunMode,
        definition: ArtifactReference,
        profile: ProfileReference,
        case: CaseReference,
        baseline: Option<Baseline>,
        checks: Vec<CheckRecord>,
        explanation: Option<String>,
        completion: Completion,
        totals: Option<Totals>,
    ) -> Result<Self, ValidationError> {
        if run_id.is_empty() || run_id.chars().count() > 128 {
            return Err(ValidationError::invalid_field_type(
                "/run_id",
                "The run identifier must hold 1 to 128 characters.",
            ));
        }
        definition.validate("/definition")?;
        profile.validate("/profile")?;
        case.validate("/case")?;
        if let Some(baseline) = &baseline {
            if baseline.outcome.is_empty() || baseline.outcome.chars().count() > 64 {
                return Err(ValidationError::invalid_field_type(
                    "/baseline/outcome",
                    "The baseline outcome must hold 1 to 64 characters.",
                ));
            }
            if baseline.revision.is_empty() || baseline.revision.chars().count() > 128 {
                return Err(ValidationError::invalid_field_type(
                    "/baseline/revision",
                    "The baseline revision must hold 1 to 128 characters.",
                ));
            }
        }
        if checks.is_empty() {
            return Err(ValidationError::new(
                ReasonCode::EmptyCheckSet,
                "/checks",
                "The report holds no check record. All checks are required.",
            ));
        }
        for (index, record) in checks.iter().enumerate() {
            record.validate(&format!("/checks/{index}"))?;
            if checks[..index]
                .iter()
                .any(|seen| seen.check == record.check)
            {
                return Err(ValidationError::new(
                    ReasonCode::DuplicateId,
                    format!("/checks/{index}/check"),
                    format!(
                        "The check identifier {} repeats an earlier record.",
                        crate::error::fragment(&record.check)
                    ),
                ));
            }
        }
        if let Some(text) = &explanation {
            if text.chars().count() > 2000 {
                return Err(ValidationError::invalid_field_type(
                    "/aggregate/explanation",
                    "The explanation must hold at most 2000 characters.",
                ));
            }
        }
        completion.validate("/completion")?;
        if let Some(totals) = &totals {
            totals.validate("/totals")?;
        }
        let outcome = aggregate(
            &checks
                .iter()
                .map(|record| record.outcome)
                .collect::<Vec<_>>(),
        )?;
        Ok(Self {
            schema_version: crate::CONTRACT_SCHEMA_VERSION,
            run_id,
            mode,
            definition,
            profile,
            case,
            baseline,
            checks,
            aggregate: AggregateEntry {
                outcome,
                explanation,
            },
            completion,
            totals,
        })
    }
}

impl Serialize for RunReport {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        // The fixed shape of the run report contract. No field names an
        // application action, an approval, or an authorization.
        let size = 9 + usize::from(self.baseline.is_some()) + usize::from(self.totals.is_some());
        let mut map = serializer.serialize_map(Some(size))?;
        map.serialize_entry("schema_version", &self.schema_version)?;
        map.serialize_entry("run_id", &self.run_id)?;
        map.serialize_entry("mode", &self.mode)?;
        map.serialize_entry("definition", &self.definition)?;
        map.serialize_entry("profile", &self.profile)?;
        map.serialize_entry("case", &self.case)?;
        if let Some(baseline) = &self.baseline {
            map.serialize_entry("baseline", baseline)?;
        }
        map.serialize_entry("checks", &self.checks)?;
        map.serialize_entry("aggregate", &self.aggregate)?;
        map.serialize_entry("completion", &self.completion)?;
        if let Some(totals) = &self.totals {
            map.serialize_entry("totals", totals)?;
        }
        map.end()
    }
}

/// Collects the parts of one report, then finishes it into an immutable
/// record.
///
/// The scheduler pushes one [`CheckRecord`] per check as its result arrives,
/// states the [`Completion`] at the terminal event, and calls
/// [`finish`](Self::finish). Nothing validates before `finish`, so a partial
/// report cannot exist.
#[derive(Debug, Clone)]
pub struct ReportBuilder {
    run_id: String,
    mode: RunMode,
    definition: ArtifactReference,
    profile: ProfileReference,
    case: CaseReference,
    baseline: Option<Baseline>,
    checks: Vec<CheckRecord>,
    explanation: Option<String>,
    completion: Completion,
    totals: Option<Totals>,
}

impl ReportBuilder {
    /// Starts one report with its binding and its terminal status.
    pub fn new(
        run_id: impl Into<String>,
        mode: RunMode,
        definition: ArtifactReference,
        profile: ProfileReference,
        case: CaseReference,
        completion: Completion,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            mode,
            definition,
            profile,
            case,
            baseline: None,
            checks: Vec::new(),
            explanation: None,
            completion,
            totals: None,
        }
    }

    /// Records the shadow baseline of the existing decision path.
    pub fn baseline(mut self, baseline: Baseline) -> Self {
        self.baseline = Some(baseline);
        self
    }

    /// Adds one component record. Every defined check must appear before
    /// `finish`.
    pub fn check(mut self, record: CheckRecord) -> Self {
        self.checks.push(record);
        self
    }

    /// States the generated explanation. It comes from the check criteria
    /// and the executed policy, never from an evaluator rationale.
    pub fn explanation(mut self, text: impl Into<String>) -> Self {
        self.explanation = Some(text.into());
        self
    }

    /// Records the run totals.
    pub fn totals(mut self, totals: Totals) -> Self {
        self.totals = Some(totals);
        self
    }

    /// Validates every part and finishes the immutable report.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] under the same conditions as
    /// [`RunReport::assemble`].
    pub fn finish(self) -> Result<RunReport, ValidationError> {
        RunReport::assemble(
            self.run_id,
            self.mode,
            self.definition,
            self.profile,
            self.case,
            self.baseline,
            self.checks,
            self.explanation,
            self.completion,
            self.totals,
        )
    }
}

/// Parses one immutable run report from a JSON value that passed the strict
/// gate.
///
/// The parser enforces the run report contract, then checks that the stored
/// aggregate agrees with the component outcomes. A stored report that
/// disagrees is an edited or corrupted copy.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value breaks the run report
/// contract or the stored aggregate disagrees with its checks.
pub fn parse_run_report(value: &Value) -> Result<RunReport, ValidationError> {
    let root = expect_object(value, "")?;
    let _schema_version = crate::artifact::schema_version(root)?;
    reject_unknown_fields(root, REPORT_FIELDS, "")?;

    let run_id = match root.get("run_id") {
        Some(Value::String(text)) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/run_id",
                "The run identifier must hold one string.",
            ));
        }
        None => return Err(ValidationError::missing("/run_id")),
    };
    let mode = parse_word(root.get("mode"), "/mode", RunMode::from_word, "run mode")?;
    let definition = parse_artifact_reference(root.get("definition"), "/definition")?;
    let profile = parse_profile_reference(root.get("profile"), "/profile")?;
    let case = parse_case_reference(root.get("case"), "/case")?;
    let baseline = match root.get("baseline") {
        None => None,
        Some(value) => Some(parse_baseline(value, "/baseline")?),
    };

    let raw_checks = match root.get("checks") {
        Some(Value::Array(items)) => items,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/checks",
                "The checks field must be an array.",
            ));
        }
        None => return Err(ValidationError::missing("/checks")),
    };
    if raw_checks.is_empty() {
        return Err(ValidationError::new(
            ReasonCode::EmptyCheckSet,
            "/checks",
            "The report holds no check record. All checks are required.",
        ));
    }
    let mut checks = Vec::with_capacity(raw_checks.len());
    for (index, item) in raw_checks.iter().enumerate() {
        checks.push(parse_check_record(item, &format!("/checks/{index}"))?);
    }

    let aggregate_value = match root.get("aggregate") {
        Some(value) => value,
        None => return Err(ValidationError::missing("/aggregate")),
    };
    let aggregate_object = expect_object(aggregate_value, "/aggregate")?;
    reject_unknown_fields(aggregate_object, &["outcome", "explanation"], "/aggregate")?;
    let stored_aggregate = parse_word(
        aggregate_object.get("outcome"),
        "/aggregate/outcome",
        AggregateOutcome::from_word,
        "aggregate outcome",
    )?;
    let explanation = parse_bounded_string(
        aggregate_object.get("explanation"),
        "/aggregate/explanation",
        2000,
        "The explanation",
    )?;

    let completion = parse_completion(root.get("completion"), "/completion")?;
    let totals = match root.get("totals") {
        None => None,
        Some(value) => Some(parse_totals(value, "/totals")?),
    };

    let report = RunReport::assemble(
        run_id,
        mode,
        definition,
        profile,
        case,
        baseline,
        checks,
        explanation,
        completion,
        totals,
    )?;
    if report.aggregate() != stored_aggregate {
        return Err(ValidationError::invalid_field_type(
            "/aggregate/outcome",
            "The stored aggregate outcome disagrees with the component outcomes.",
        ));
    }
    Ok(report)
}

/// Parses one immutable run report from strict JSON text.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the text fails the strict JSON gate or
/// the run report contract.
pub fn parse_run_report_str(text: &str) -> Result<RunReport, ValidationError> {
    crate::json::parse_strict(text).and_then(|value| parse_run_report(&value))
}

/// Parses one immutable run report from strict JSON bytes.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the bytes fail the UTF-8 check, the
/// strict JSON gate, or the run report contract.
pub fn parse_run_report_bytes(bytes: &[u8]) -> Result<RunReport, ValidationError> {
    crate::json::parse_bytes_strict(bytes).and_then(|value| parse_run_report(&value))
}

/// Parses one component record at `base`.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value breaks the check record
/// contract, including its conditional rules.
pub fn parse_check_record(value: &Value, base: &str) -> Result<CheckRecord, ValidationError> {
    let map = expect_object(value, base)?;
    reject_unknown_fields(map, CHECK_RECORD_FIELDS, base)?;

    let check = match map.get("check") {
        Some(Value::String(text)) if is_artifact_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/check"),
                "The check identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/check"))),
    };
    let kind = parse_word(
        map.get("kind"),
        &format!("{base}/kind"),
        RecordKind::from_word,
        "record kind",
    )?;
    let outcome = parse_word(
        map.get("outcome"),
        &format!("{base}/outcome"),
        Outcome::from_word,
        "outcome",
    )?;
    let assessment = match map.get("assessment") {
        None => None,
        Some(value) => {
            check_assessment(value, &format!("{base}/assessment"))?;
            Some(value.clone())
        }
    };
    let applied_rule = match map.get("applied_rule") {
        None => None,
        Some(value) => Some(parse_applied_rule(value, &format!("{base}/applied_rule"))?),
    };
    let applied_policy = match map.get("applied_policy") {
        None => None,
        Some(value) => Some(parse_applied_policy(
            value,
            &format!("{base}/applied_policy"),
        )?),
    };
    let evaluator = match map.get("evaluator") {
        None => None,
        Some(value) => Some(parse_evaluator(value, &format!("{base}/evaluator"))?),
    };
    let attempts = match map.get("attempts") {
        None => None,
        Some(Value::Number(number))
            if number.is_u64() && number.as_u64().expect("checked") >= 1 =>
        {
            Some(number.as_u64().expect("checked"))
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/attempts"),
                "The attempt count must be an integer of at least 1.",
            ));
        }
    };
    let timing = match map.get("timing") {
        None => None,
        Some(value) => Some(parse_timing(value, &format!("{base}/timing"))?),
    };
    let usage = match map.get("usage") {
        None => None,
        Some(value) => Some(parse_usage(value, &format!("{base}/usage"))?),
    };
    let reason = match map.get("reason") {
        None => None,
        Some(value) => Some(parse_reason(value, &format!("{base}/reason"))?),
    };

    let record = CheckRecord {
        check,
        kind,
        outcome,
        assessment,
        applied_rule,
        applied_policy,
        evaluator,
        attempts,
        timing,
        usage,
        reason,
    };
    record.validate(base)?;
    Ok(record)
}

/// Parses one applied rule record at `base`.
fn parse_applied_rule(value: &Value, base: &str) -> Result<AppliedRule, ValidationError> {
    let map = expect_object(value, base)?;
    reject_unknown_fields(map, APPLIED_RULE_FIELDS, base)?;
    let keyword = match map.get("rule") {
        Some(Value::String(text)) => RuleKeyword::from_word(text),
        _ => None,
    }
    .ok_or_else(|| {
        ValidationError::invalid_field_type(
            format!("{base}/rule"),
            "The rule must be maxLength, includes, or excludes.",
        )
    })?;
    let input = match map.get("input") {
        Some(Value::String(text)) if crate::definition::is_input_name(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/input"),
                "The rule input name must use letters, digits, or underscores, 64 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/input"))),
    };
    let parameters = match map.get("parameters") {
        Some(value) => value,
        None => return Err(ValidationError::missing(format!("{base}/parameters"))),
    };
    let parameter_map = expect_object(parameters, &format!("{base}/parameters"))?;
    if parameter_map.len() != 1 || !parameter_map.contains_key(keyword.as_str()) {
        return Err(ValidationError::invalid_field_type(
            format!("{base}/parameters"),
            "The parameters must hold exactly the executed rule keyword.",
        ));
    }
    let parameter = parameter_map.get(keyword.as_str()).expect("checked");
    let rule = crate::rule::parse_rule_parameter(
        keyword.as_str(),
        parameter,
        &format!("{base}/parameters"),
    )?;
    Ok(AppliedRule {
        rule: keyword,
        input,
        parameters: rule,
    })
}

/// Parses one applied policy record at `base`.
fn parse_applied_policy(value: &Value, base: &str) -> Result<AppliedPolicy, ValidationError> {
    let map = expect_object(value, base)?;
    reject_unknown_fields(map, APPLIED_POLICY_FIELDS, base)?;
    let accept_cutoff = required_cutoff(map, "accept_cutoff", base)?;
    let rejection_cutoff = required_cutoff(map, "rejection_cutoff", base)?;
    let confidence_floor = match map.get("confidence_floor") {
        None => None,
        Some(value) => Some(cutoff(
            value,
            &format!("{base}/confidence_floor"),
            "confidence floor",
        )?),
    };
    Ok(AppliedPolicy {
        accept_cutoff,
        rejection_cutoff,
        confidence_floor,
    })
}

/// Reads one required policy cutoff.
fn required_cutoff(
    map: &Map<String, Value>,
    name: &str,
    base: &str,
) -> Result<f64, ValidationError> {
    match map.get(name) {
        Some(value) => cutoff(value, &format!("{base}/{name}"), "cutoff"),
        None => Err(ValidationError::missing(format!("{base}/{name}"))),
    }
}

/// Checks one policy cutoff against the contract range.
fn cutoff(value: &Value, path: &str, what: &str) -> Result<f64, ValidationError> {
    let Value::Number(number) = value else {
        return Err(ValidationError::invalid_field_type(
            path,
            format!("The {what} must be a number above 0.5 and at most 1."),
        ));
    };
    let parsed = number.as_f64().expect("a JSON number is finite");
    if (0.5..=1.0).contains(&parsed) && parsed != 0.5 {
        Ok(parsed)
    } else {
        Err(ValidationError::invalid_field_type(
            path,
            format!("The {what} must be a number above 0.5 and at most 1."),
        ))
    }
}

/// Parses one evaluator version record at `base`.
fn parse_evaluator(value: &Value, base: &str) -> Result<EvaluatorVersions, ValidationError> {
    let map = expect_object(value, base)?;
    reject_unknown_fields(map, EVALUATOR_FIELDS, base)?;
    let id = match map.get("id") {
        Some(Value::String(text)) if is_artifact_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/id"),
                "The evaluator identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/id"))),
    };
    let adapter_version = parse_bounded_string(
        map.get("adapter_version"),
        &format!("{base}/adapter_version"),
        64,
        "The adapter version",
    )?
    .ok_or_else(|| ValidationError::missing(format!("{base}/adapter_version")))?;
    let model_resolved = parse_bounded_string(
        map.get("model_resolved"),
        &format!("{base}/model_resolved"),
        128,
        "The resolved model version",
    )?;
    Ok(EvaluatorVersions {
        id,
        adapter_version,
        model_resolved,
    })
}

/// Parses one timing record at `base`.
fn parse_timing(value: &Value, base: &str) -> Result<Timing, ValidationError> {
    let map = expect_object(value, base)?;
    reject_unknown_fields(map, TIMING_FIELDS, base)?;
    let queued_ms = optional_duration(map.get("queued_ms"), &format!("{base}/queued_ms"))?;
    let execution_ms = optional_duration(map.get("execution_ms"), &format!("{base}/execution_ms"))?;
    let timing = Timing {
        queued_ms,
        execution_ms,
    };
    timing.validate(base)?;
    Ok(timing)
}

/// Reads one optional duration number.
fn optional_duration(value: Option<&Value>, path: &str) -> Result<Option<Number>, ValidationError> {
    match value {
        None => Ok(None),
        Some(Value::Number(number)) if matches!(number.as_f64(), Some(duration) if duration >= 0.0) => {
            Ok(Some(number.clone()))
        }
        Some(_) => Err(ValidationError::invalid_field_type(
            path,
            "The duration must be a number of zero or more.",
        )),
    }
}

/// Parses one usage object at `base`.
fn parse_usage(value: &Value, base: &str) -> Result<Map<String, Value>, ValidationError> {
    let map = expect_object(value, base)?;
    check_usage(map, base)?;
    Ok(map.clone())
}

/// Checks one usage object: every value is a number.
fn check_usage(map: &Map<String, Value>, base: &str) -> Result<(), ValidationError> {
    for (key, value) in map {
        if !value.is_number() {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/{key}"),
                "Every usage value must be a number.",
            ));
        }
    }
    Ok(())
}

/// Parses one sanitized reason at `base`.
fn parse_reason(value: &Value, base: &str) -> Result<SanitizedReason, ValidationError> {
    let map = expect_object(value, base)?;
    reject_unknown_fields(map, REASON_FIELDS, base)?;
    let code = match map.get("code") {
        Some(Value::String(text)) => ReasonCode::from_registry(text),
        _ => None,
    }
    .ok_or_else(|| {
        ValidationError::invalid_field_type(
            format!("{base}/code"),
            "The reason code must come from the published registry.",
        )
    })?;
    let message = parse_bounded_string(
        map.get("message"),
        &format!("{base}/message"),
        500,
        "The reason message",
    )?
    .ok_or_else(|| ValidationError::missing(format!("{base}/message")))?;
    let field_path = match map.get("field_path") {
        None => None,
        Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= 500 => {
            Some(text.clone())
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/field_path"),
                "The reason field path must hold 1 to 500 characters.",
            ));
        }
    };
    Ok(SanitizedReason {
        code,
        message,
        field_path,
    })
}

/// Parses one artifact reference at `base`.
fn parse_artifact_reference(
    value: Option<&Value>,
    base: &str,
) -> Result<ArtifactReference, ValidationError> {
    let map = expect_object(value.ok_or_else(|| ValidationError::missing(base))?, base)?;
    reject_unknown_fields(map, &["name", "content_hash"], base)?;
    let name = match map.get("name") {
        Some(Value::String(text)) if is_artifact_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/name"),
                "The artifact name must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/name"))),
    };
    let content_hash = match map.get("content_hash") {
        Some(Value::String(text)) if hashing::is_hash_hex(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/content_hash"),
                "The content hash must hold 64 lowercase hexadecimal characters.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/content_hash"))),
    };
    Ok(ArtifactReference { name, content_hash })
}

/// Parses one profile reference at `base`.
///
/// The run state boundary reads the binding of an offered attempt through
/// this parser, so a reference that crosses a language boundary meets the
/// same rules as one stored inside a report.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value is absent, is not an object,
/// holds an unknown field, or breaks the identifier or hash rules.
pub fn parse_profile_reference(
    value: Option<&Value>,
    base: &str,
) -> Result<ProfileReference, ValidationError> {
    let map = expect_object(value.ok_or_else(|| ValidationError::missing(base))?, base)?;
    reject_unknown_fields(map, &["id", "content_hash"], base)?;
    let id = match map.get("id") {
        Some(Value::String(text)) if is_artifact_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/id"),
                "The profile identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/id"))),
    };
    let content_hash = match map.get("content_hash") {
        Some(Value::String(text)) if hashing::is_hash_hex(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/content_hash"),
                "The content hash must hold 64 lowercase hexadecimal characters.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/content_hash"))),
    };
    Ok(ProfileReference { id, content_hash })
}

/// Parses one case reference at `base`.
///
/// The run state boundary reads the binding of an offered attempt through
/// this parser, so a reference that crosses a language boundary meets the
/// same rules as one stored inside a report.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value is absent, is not an object,
/// holds an unknown field, or breaks the identifier or hash rules.
pub fn parse_case_reference(
    value: Option<&Value>,
    base: &str,
) -> Result<CaseReference, ValidationError> {
    let map = expect_object(value.ok_or_else(|| ValidationError::missing(base))?, base)?;
    reject_unknown_fields(map, &["id", "input_hash"], base)?;
    let id = match map.get("id") {
        Some(Value::String(text)) if crate::case::is_case_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/id"),
                "The case identifier must start with a lowercase letter or a digit, then hold lowercase letters, digits, dots, underscores, or hyphens, 128 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/id"))),
    };
    let input_hash = match map.get("input_hash") {
        Some(Value::String(text)) if hashing::is_hash_hex(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/input_hash"),
                "The input hash must hold 64 lowercase hexadecimal characters.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/input_hash"))),
    };
    Ok(CaseReference { id, input_hash })
}

/// Parses one shadow baseline at `base`.
fn parse_baseline(value: &Value, base: &str) -> Result<Baseline, ValidationError> {
    let map = expect_object(value, base)?;
    reject_unknown_fields(map, &["outcome", "revision"], base)?;
    let outcome = parse_bounded_string(
        map.get("outcome"),
        &format!("{base}/outcome"),
        64,
        "The baseline outcome",
    )?
    .ok_or_else(|| ValidationError::missing(format!("{base}/outcome")))?;
    let revision = parse_bounded_string(
        map.get("revision"),
        &format!("{base}/revision"),
        128,
        "The baseline revision",
    )?
    .ok_or_else(|| ValidationError::missing(format!("{base}/revision")))?;
    Ok(Baseline { outcome, revision })
}

/// Parses one completion record at `base`.
fn parse_completion(value: Option<&Value>, base: &str) -> Result<Completion, ValidationError> {
    let map = expect_object(value.ok_or_else(|| ValidationError::missing(base))?, base)?;
    reject_unknown_fields(map, &["status", "completed_at"], base)?;
    let status = parse_word(
        map.get("status"),
        &format!("{base}/status"),
        CompletionStatus::from_word,
        "completion status",
    )?;
    let completed_at = match map.get("completed_at") {
        None => None,
        Some(Value::String(text)) if is_rfc3339(text) => Some(text.clone()),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/completed_at"),
                "The terminal time must be one RFC 3339 date-time in UTC or with an offset.",
            ));
        }
    };
    Ok(Completion {
        status,
        completed_at,
    })
}

/// Parses one totals record at `base`.
fn parse_totals(value: &Value, base: &str) -> Result<Totals, ValidationError> {
    let map = expect_object(value, base)?;
    reject_unknown_fields(map, &["elapsed_ms", "usage"], base)?;
    let elapsed_ms = optional_duration(map.get("elapsed_ms"), &format!("{base}/elapsed_ms"))?;
    let usage = match map.get("usage") {
        None => None,
        Some(value) => Some(parse_usage(value, &format!("{base}/usage"))?),
    };
    let totals = Totals { elapsed_ms, usage };
    totals.validate(base)?;
    Ok(totals)
}

/// Reads one required contract word through its parser.
fn parse_word<T>(
    value: Option<&Value>,
    path: &str,
    words: fn(&str) -> Option<T>,
    what: &str,
) -> Result<T, ValidationError> {
    match value {
        Some(Value::String(text)) => words(text).ok_or_else(|| {
            ValidationError::invalid_field_type(
                path,
                format!(
                    "The {what} names no contract value: {}.",
                    crate::error::fragment(text)
                ),
            )
        }),
        Some(_) => Err(ValidationError::invalid_field_type(
            path,
            format!("The {what} must hold one string."),
        )),
        None => Err(ValidationError::missing(path)),
    }
}

/// Checks one recorded assessment against the structural assessment
/// contract.
///
/// The boundary covers the schema file: known fields, the answer kind, the
/// field that each kind requires and forbids, the distribution range, the
/// confidence range, and the evidence entry shape. The evaluator adapter
/// boundary owns the semantic rules that need the check, such as closing the
/// distribution names against the declared answers and authorizing every
/// evidence reference against the `using` list.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the assessment breaks one structural
/// rule of the assessment schema.
fn check_assessment(value: &Value, base: &str) -> Result<(), ValidationError> {
    let map = expect_object(value, base)?;
    reject_unknown_fields(map, ASSESSMENT_FIELDS, base)?;
    let kind = match map.get("kind") {
        Some(Value::String(text))
            if matches!(text.as_str(), "categorical" | "binary" | "ordered") =>
        {
            text.as_str()
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/kind"),
                "The assessment kind must be categorical, binary, or ordered.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/kind"))),
    };
    let label = parse_bounded_string(map.get("label"), &format!("{base}/label"), 64, "The label")?;
    let level = parse_bounded_string(map.get("level"), &format!("{base}/level"), 64, "The level")?;
    let (has_label, has_value, has_level, has_position) = (
        label.is_some(),
        matches!(map.get("value"), Some(Value::Bool(_))),
        level.is_some(),
        map.get("position").is_some(),
    );
    match kind {
        "categorical" => {
            if !has_label {
                return Err(ValidationError::missing(format!("{base}/label")));
            }
            if has_value || has_level || has_position {
                return Err(ValidationError::invalid_field_type(
                    base,
                    "A categorical assessment holds a label and no value, level, or position.",
                ));
            }
        }
        "binary" => {
            if !has_value {
                return Err(ValidationError::missing(format!("{base}/value")));
            }
            if has_label || has_level || has_position {
                return Err(ValidationError::invalid_field_type(
                    base,
                    "A binary assessment holds a value and no label, level, or position.",
                ));
            }
        }
        "ordered" => {
            if !has_level {
                return Err(ValidationError::missing(format!("{base}/level")));
            }
            if has_label || has_value {
                return Err(ValidationError::invalid_field_type(
                    base,
                    "An ordered assessment holds a level and no label or value.",
                ));
            }
            if let Some(position) = map.get("position") {
                if !position.is_number() {
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/position"),
                        "The reported position must be a number.",
                    ));
                }
            }
        }
        _ => unreachable!("the kind word was checked"),
    }
    if let Some(distribution) = map.get("distribution") {
        let Value::Array(entries) = distribution else {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/distribution"),
                "The distribution must be an array.",
            ));
        };
        if entries.len() < 2 {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/distribution"),
                "The distribution must hold at least two entries.",
            ));
        }
        let mut names: Vec<String> = Vec::with_capacity(entries.len());
        for (index, entry) in entries.iter().enumerate() {
            let path = format!("{base}/distribution/{index}");
            let entry_map = expect_object(entry, &path)?;
            reject_unknown_fields(entry_map, DISTRIBUTION_FIELDS, &path)?;
            let name = parse_bounded_string(
                entry_map.get("name"),
                &format!("{path}/name"),
                64,
                "The entry name",
            )?
            .ok_or_else(|| ValidationError::missing(format!("{path}/name")))?;
            let mass_ok = matches!(
                entry_map.get("mass"),
                Some(Value::Number(number))
                    if matches!(number.as_f64(), Some(mass) if (0.0..=1.0).contains(&mass))
            );
            if !mass_ok {
                return Err(ValidationError::invalid_field_type(
                    format!("{path}/mass"),
                    "The probability mass must be a number from 0 to 1.",
                ));
            }
            if names.contains(&name) {
                return Err(ValidationError::invalid_field_type(
                    format!("{path}/name"),
                    "The distribution names one entry twice.",
                ));
            }
            names.push(name);
        }
    }
    if let Some(confidence) = map.get("confidence") {
        if !matches!(confidence.as_f64(), Some(value) if (0.0..=1.0).contains(&value)) {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/confidence"),
                "The reported confidence must be a number from 0 to 1.",
            ));
        }
    }
    if let Some(Value::Array(entries)) = map.get("evidence") {
        for (index, entry) in entries.iter().enumerate() {
            let path = format!("{base}/evidence/{index}");
            let entry_map = expect_object(entry, &path)?;
            reject_unknown_fields(entry_map, EVIDENCE_FIELDS, &path)?;
            match entry_map.get("input") {
                Some(Value::String(text)) if crate::definition::is_input_name(text) => {}
                _ => {
                    return Err(ValidationError::invalid_field_type(
                        format!("{path}/input"),
                        "The evidence input name must use letters, digits, or underscores, 64 characters at most.",
                    ));
                }
            }
            parse_bounded_string(
                entry_map.get("reference"),
                &format!("{path}/reference"),
                500,
                "The evidence reference",
            )?
            .ok_or_else(|| ValidationError::missing(format!("{path}/reference")))?;
        }
    } else if map.get("evidence").is_some() {
        return Err(ValidationError::invalid_field_type(
            format!("{base}/evidence"),
            "The evidence must be an array.",
        ));
    }
    Ok(())
}

/// Checks one RFC 3339 date-time: `YYYY-MM-DDTHH:MM:SS` with an optional
/// fractional part and either `Z` or a numeric offset.
///
/// The rule accepts the lower-case `t` and `z` that RFC 3339 permits, a
/// leap-second `60`, and the true month lengths with leap years. Anything
/// else, including a date without a zone, fails.
fn is_rfc3339(text: &str) -> bool {
    let bytes = text.as_bytes();
    // A date, a separator, and a time: 19 characters before the fraction and
    // the zone.
    if bytes.len() < 20 {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|slice| slice.iter().all(|byte| byte.is_ascii_digit()))
    };
    if !digits(0..4)
        || bytes[4] != b'-'
        || !digits(5..7)
        || bytes[7] != b'-'
        || !digits(8..10)
        || !matches!(bytes[10], b'T' | b't')
        || !digits(11..13)
        || bytes[13] != b':'
        || !digits(14..16)
        || bytes[16] != b':'
        || !digits(17..19)
    {
        return false;
    }
    let year: u32 = text[0..4].parse().expect("digits were checked");
    let month: u32 = text[5..7].parse().expect("digits were checked");
    let day: u32 = text[8..10].parse().expect("digits were checked");
    let hour: u32 = text[11..13].parse().expect("digits were checked");
    let minute: u32 = text[14..16].parse().expect("digits were checked");
    let second: u32 = text[17..19].parse().expect("digits were checked");
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return false;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return false;
    }
    let mut rest = &text[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let fraction_digits = fraction
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .count();
        if fraction_digits == 0 {
            return false;
        }
        rest = &fraction[fraction_digits..];
    }
    match rest {
        "Z" | "z" => true,
        offset
            if offset.len() == 6
                && matches!(offset.as_bytes()[0], b'+' | b'-')
                && offset.as_bytes()[1..3]
                    .iter()
                    .all(|byte| byte.is_ascii_digit())
                && offset.as_bytes()[3] == b':'
                && offset.as_bytes()[4..6]
                    .iter()
                    .all(|byte| byte.is_ascii_digit()) =>
        {
            let offset_hour: u32 = offset[1..3].parse().expect("digits were checked");
            let offset_minute: u32 = offset[4..6].parse().expect("digits were checked");
            offset_hour <= 23 && offset_minute <= 59
        }
        _ => false,
    }
}

/// Returns the number of days in one month, with the leap-year rule.
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One valid content hash for the reference fields.
    fn hash_hex(character: char) -> String {
        std::iter::repeat_n(character, 64).collect()
    }

    /// One question record with the stated outcome and a reason where the
    /// contract requires one.
    fn record(index: usize, outcome: Outcome) -> CheckRecord {
        let reason = match outcome {
            Outcome::Error => Some(SanitizedReason {
                code: ReasonCode::EvaluatorError,
                message: "The adapter reported a network failure.".to_owned(),
                field_path: None,
            }),
            Outcome::Skipped => Some(SanitizedReason {
                code: ReasonCode::QueueFull,
                message: "The pending-work limit stopped this check.".to_owned(),
                field_path: None,
            }),
            _ => None,
        };
        CheckRecord {
            check: format!("check-{index}"),
            kind: RecordKind::Question,
            outcome,
            assessment: None,
            applied_rule: None,
            applied_policy: None,
            evaluator: None,
            attempts: None,
            timing: None,
            usage: None,
            reason,
        }
    }

    /// One finished report with the stated component outcomes.
    fn finished(outcomes: &[Outcome]) -> RunReport {
        builder(outcomes).finish().expect("the report finishes")
    }

    /// One report builder with the stated component outcomes.
    fn builder(outcomes: &[Outcome]) -> ReportBuilder {
        let mut builder = ReportBuilder::new(
            "run-000001",
            RunMode::Shadow,
            ArtifactReference {
                name: "message-review".to_owned(),
                content_hash: hash_hex('a'),
            },
            ProfileReference {
                id: "message-profile".to_owned(),
                content_hash: hash_hex('b'),
            },
            CaseReference {
                id: "case-1".to_owned(),
                input_hash: hash_hex('c'),
            },
            Completion {
                status: CompletionStatus::Completed,
                completed_at: Some("2026-09-23T10:00:02.500Z".to_owned()),
            },
        );
        for (index, outcome) in outcomes.iter().enumerate() {
            builder = builder.check(record(index, *outcome));
        }
        builder
    }

    #[test]
    fn the_aggregate_follows_the_fixed_order() {
        // The table pins the order: fail, then error, then review or skipped,
        // then pass.
        let cases: &[(&[Outcome], AggregateOutcome)] = &[
            (&[Outcome::Pass], AggregateOutcome::Pass),
            (&[Outcome::Fail], AggregateOutcome::Fail),
            (&[Outcome::Error], AggregateOutcome::Error),
            (&[Outcome::Review], AggregateOutcome::Review),
            (&[Outcome::Skipped], AggregateOutcome::Review),
            (&[Outcome::Pass, Outcome::Pass], AggregateOutcome::Pass),
            (&[Outcome::Pass, Outcome::Fail], AggregateOutcome::Fail),
            (&[Outcome::Error, Outcome::Fail], AggregateOutcome::Fail),
            (&[Outcome::Review, Outcome::Fail], AggregateOutcome::Fail),
            (&[Outcome::Skipped, Outcome::Fail], AggregateOutcome::Fail),
            (&[Outcome::Pass, Outcome::Error], AggregateOutcome::Error),
            (&[Outcome::Review, Outcome::Error], AggregateOutcome::Error),
            (&[Outcome::Skipped, Outcome::Error], AggregateOutcome::Error),
            (&[Outcome::Pass, Outcome::Review], AggregateOutcome::Review),
            (&[Outcome::Pass, Outcome::Skipped], AggregateOutcome::Review),
            (
                &[Outcome::Review, Outcome::Skipped],
                AggregateOutcome::Review,
            ),
            (
                &[
                    Outcome::Pass,
                    Outcome::Fail,
                    Outcome::Error,
                    Outcome::Review,
                    Outcome::Skipped,
                ],
                AggregateOutcome::Fail,
            ),
        ];
        for (outcomes, expected) in cases {
            assert_eq!(
                aggregate(outcomes).expect("the set is not empty"),
                *expected,
                "{outcomes:?}"
            );
        }
    }

    #[test]
    fn an_empty_outcome_set_is_not_a_run_state() {
        let error = aggregate(&[]).expect_err("the empty set was accepted");
        assert_eq!(error.code, ReasonCode::EmptyCheckSet);
        assert_eq!(error.field_path, "/checks");
        let error = builder(&[]).finish().expect_err("a report without checks");
        assert_eq!(error.code, ReasonCode::EmptyCheckSet);
        assert_eq!(error.field_path, "/checks");
    }

    #[test]
    fn every_contract_word_round_trips() {
        for (word, outcome) in [
            ("pass", Outcome::Pass),
            ("fail", Outcome::Fail),
            ("review", Outcome::Review),
            ("error", Outcome::Error),
            ("skipped", Outcome::Skipped),
        ] {
            assert_eq!(outcome.as_str(), word);
            assert_eq!(Outcome::from_word(word), Some(outcome));
        }
        for (word, aggregate_outcome) in [
            ("pass", AggregateOutcome::Pass),
            ("fail", AggregateOutcome::Fail),
            ("review", AggregateOutcome::Review),
            ("error", AggregateOutcome::Error),
        ] {
            assert_eq!(aggregate_outcome.as_str(), word);
            assert_eq!(AggregateOutcome::from_word(word), Some(aggregate_outcome));
        }
        for (word, status) in [
            ("completed", CompletionStatus::Completed),
            ("cancelled", CompletionStatus::Cancelled),
            ("deadline_exceeded", CompletionStatus::DeadlineExceeded),
        ] {
            assert_eq!(status.as_str(), word);
            assert_eq!(CompletionStatus::from_word(word), Some(status));
        }
        for (word, mode) in [
            ("shadow", RunMode::Shadow),
            ("enforcement", RunMode::Enforcement),
        ] {
            assert_eq!(mode.as_str(), word);
            assert_eq!(RunMode::from_word(word), Some(mode));
        }
        for (word, kind) in [
            ("question", RecordKind::Question),
            ("rule", RecordKind::Rule),
        ] {
            assert_eq!(kind.as_str(), word);
            assert_eq!(RecordKind::from_word(word), Some(kind));
        }
        // A skipped outcome is a component fact, never an aggregate word.
        assert_eq!(AggregateOutcome::from_word("skipped"), None);
        assert_eq!(Outcome::from_word("passed"), None);
        assert_eq!(CompletionStatus::from_word("error"), None);
        assert_eq!(RunMode::from_word("silent"), None);
        assert_eq!(RecordKind::from_word("scale"), None);
    }

    #[test]
    fn every_check_kind_maps_to_one_record_kind() {
        use crate::definition::CheckKind;
        for (check_kind, kind) in [
            (CheckKind::Rule, RecordKind::Rule),
            (CheckKind::Categorical, RecordKind::Question),
            (CheckKind::Binary, RecordKind::Question),
            (CheckKind::Ordered, RecordKind::Question),
        ] {
            assert_eq!(RecordKind::of(check_kind), kind);
        }
    }

    #[test]
    fn a_report_records_every_component_outcome() {
        // A fail wins the aggregate while the error, the review, and the skip
        // stay visible beside it.
        let report = finished(&[
            Outcome::Pass,
            Outcome::Fail,
            Outcome::Error,
            Outcome::Review,
            Outcome::Skipped,
        ]);
        assert_eq!(report.aggregate(), AggregateOutcome::Fail);
        assert_eq!(report.checks().len(), 5);
        assert_eq!(report.outcome_of("check-0"), Some(Outcome::Pass));
        assert_eq!(report.outcome_of("check-2"), Some(Outcome::Error));
        assert_eq!(
            report.checks()[2].reason.as_ref().expect("a reason").code,
            ReasonCode::EvaluatorError
        );
        assert_eq!(
            report.checks()[4].reason.as_ref().expect("a reason").code,
            ReasonCode::QueueFull
        );
        assert_eq!(report.outcome_of("missing-check"), None);

        // A skip alone surfaces as review and keeps its reason.
        let report = finished(&[Outcome::Skipped]);
        assert_eq!(report.aggregate(), AggregateOutcome::Review);
        assert_eq!(
            report.checks()[0].reason.as_ref().expect("a reason").code,
            ReasonCode::QueueFull
        );

        // Every error with no fail gives error.
        let report = finished(&[Outcome::Pass, Outcome::Error, Outcome::Review]);
        assert_eq!(report.aggregate(), AggregateOutcome::Error);
    }

    #[test]
    fn a_built_report_serializes_to_the_contract_shape() {
        let report = builder(&[Outcome::Pass, Outcome::Fail])
            .baseline(Baseline {
                outcome: "silent".to_owned(),
                revision: "v7".to_owned(),
            })
            .explanation("The candidate intervention repeats an acknowledged concern.")
            .totals(Totals {
                elapsed_ms: Some(json!(2500).as_number().expect("a number").clone()),
                usage: Some(
                    json!({"input_tokens": 1200, "output_tokens": 300})
                        .as_object()
                        .expect("an object")
                        .clone(),
                ),
            })
            .finish()
            .expect("the report finishes");
        let serialized = serde_json::to_value(&report).expect("the report serializes");
        let keys: std::collections::BTreeSet<&str> = serialized
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect::<Vec<&str>>()
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        // The key set is the contract shape. Serialization order carries no
        // meaning, so both sides compare as one set.
        assert_eq!(
            keys,
            [
                "aggregate",
                "baseline",
                "case",
                "checks",
                "completion",
                "definition",
                "mode",
                "profile",
                "run_id",
                "schema_version",
                "totals"
            ]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
        );
        assert_eq!(serialized["schema_version"], 1);
        assert_eq!(serialized["run_id"], "run-000001");
        assert_eq!(serialized["mode"], "shadow");
        assert_eq!(serialized["definition"]["name"], "message-review");
        assert_eq!(serialized["definition"]["content_hash"], hash_hex('a'));
        assert_eq!(serialized["profile"]["id"], "message-profile");
        assert_eq!(serialized["case"]["id"], "case-1");
        assert_eq!(serialized["baseline"]["outcome"], "silent");
        assert_eq!(serialized["aggregate"]["outcome"], "fail");
        assert_eq!(
            serialized["aggregate"]["explanation"],
            "The candidate intervention repeats an acknowledged concern."
        );
        assert_eq!(serialized["completion"]["status"], "completed");
        assert_eq!(
            serialized["completion"]["completed_at"],
            "2026-09-23T10:00:02.500Z"
        );
        assert_eq!(serialized["totals"]["elapsed_ms"], 2500);
        assert_eq!(serialized["checks"].as_array().expect("an array").len(), 2);

        // The stored report parses again into the same immutable record.
        let reparsed = parse_run_report(&serialized).expect("the report parses");
        assert_eq!(reparsed, report);
        assert_eq!(
            parse_run_report_str(&serialized.to_string()).expect("the text parses"),
            report
        );

        // Optional parts stay absent when they were not recorded.
        let lean = finished(&[Outcome::Pass]);
        let serialized = serde_json::to_value(&lean).expect("the report serializes");
        let keys: std::collections::BTreeSet<&str> = serialized
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect::<Vec<&str>>()
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            keys,
            [
                "aggregate",
                "case",
                "checks",
                "completion",
                "definition",
                "mode",
                "profile",
                "run_id",
                "schema_version"
            ]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
        );
        assert_eq!(serialized["aggregate"]["outcome"], "pass");
        assert!(serialized["aggregate"].get("explanation").is_none());
    }

    #[test]
    fn a_report_holds_no_application_authorization() {
        let report = finished(&[Outcome::Pass]);
        let serialized = serde_json::to_value(&report).expect("the report serializes");
        for forbidden in ["authorized", "approved", "action", "send", "decision"] {
            assert!(
                serialized.get(forbidden).is_none(),
                "the report states {forbidden}"
            );
        }
        // A host cannot smuggle an authorization field into a stored report.
        let mut smuggled = serialized.clone();
        smuggled["authorized"] = json!(true);
        let error = parse_run_report(&smuggled).expect_err("the smuggled field was accepted");
        assert_eq!(error.code, ReasonCode::UnknownField);
        assert_eq!(error.field_path, "/authorized");

        // A passing enforcement report still records measurements only.
        let enforced = ReportBuilder::new(
            "run-000002",
            RunMode::Enforcement,
            ArtifactReference {
                name: "message-review".to_owned(),
                content_hash: hash_hex('a'),
            },
            ProfileReference {
                id: "message-profile".to_owned(),
                content_hash: hash_hex('b'),
            },
            CaseReference {
                id: "case-1".to_owned(),
                input_hash: hash_hex('c'),
            },
            Completion {
                status: CompletionStatus::Completed,
                completed_at: None,
            },
        )
        .check(record(0, Outcome::Pass))
        .finish()
        .expect("the report finishes");
        assert_eq!(enforced.mode(), RunMode::Enforcement);
        assert_eq!(enforced.aggregate(), AggregateOutcome::Pass);
        let serialized = serde_json::to_value(&enforced).expect("the report serializes");
        assert_eq!(serialized["mode"], "enforcement");
        for forbidden in ["authorized", "approved", "action"] {
            assert!(serialized.get(forbidden).is_none());
        }
    }

    #[test]
    fn a_stored_aggregate_that_disagrees_is_rejected() {
        let serialized = serde_json::to_value(finished(&[Outcome::Pass, Outcome::Fail]))
            .expect("the report serializes");
        let mut corrupt = serialized.clone();
        corrupt["aggregate"]["outcome"] = json!("pass");
        let error = parse_run_report(&corrupt).expect_err("the corrupt aggregate was accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/aggregate/outcome");
        // A fail that became a pass in the records is caught the same way.
        let mut edited = serialized;
        edited["checks"][1]["outcome"] = json!("pass");
        let error = parse_run_report(&edited).expect_err("the edited record was accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/aggregate/outcome");
    }

    #[test]
    fn missing_and_mistyped_fields_carry_their_pointers() {
        let serialized = serde_json::to_value(finished(&[Outcome::Pass])).expect("serializes");
        for field in [
            "run_id",
            "mode",
            "definition",
            "profile",
            "case",
            "checks",
            "aggregate",
            "completion",
        ] {
            let mut value = serialized.clone();
            value.as_object_mut().expect("an object").remove(field);
            let error = parse_run_report(&value)
                .err()
                .unwrap_or_else(|| panic!("{field}: the field was not required"));
            assert_eq!(error.code, ReasonCode::MissingField, "{field}: {error}");
            assert_eq!(error.field_path, format!("/{field}"), "{field}: {error}");
        }
        for (field, bad) in [
            ("run_id", json!(7)),
            ("mode", json!("silent")),
            ("checks", json!({})),
            ("aggregate", json!("fail")),
            ("completion", json!("completed")),
        ] {
            let mut value = serialized.clone();
            value[field] = bad.clone();
            let error = parse_run_report(&value)
                .err()
                .unwrap_or_else(|| panic!("{field}: the value was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{field}: {error}");
            assert_eq!(error.field_path, format!("/{field}"), "{field}: {error}");
        }
        // The envelope rule holds for reports.
        let mut value = serialized.clone();
        value["schema_version"] = json!(2);
        let error = parse_run_report(&value).expect_err("the version was accepted");
        assert_eq!(error.code, ReasonCode::UnsupportedSchemaVersion);
        let error = parse_run_report_str("{\"run_id\": ").expect_err("truncated");
        assert_eq!(error.code, ReasonCode::InvalidJson);
    }

    #[test]
    fn identifiers_and_hashes_follow_their_rules() {
        let reference = ArtifactReference {
            name: "message-review".to_owned(),
            content_hash: hash_hex('a'),
        };
        let profile = ProfileReference {
            id: "message-profile".to_owned(),
            content_hash: hash_hex('b'),
        };
        let case = CaseReference {
            id: "case-1".to_owned(),
            input_hash: hash_hex('c'),
        };
        let completion = Completion {
            status: CompletionStatus::Completed,
            completed_at: None,
        };
        for (name, hash) in [
            ("Message-Review", hash_hex('a')),
            ("message review", hash_hex('a')),
            ("message-review", "abc".to_owned()),
            ("message-review", hash_hex('A')),
            ("message-review", hash_hex('g')),
        ] {
            let error = ReportBuilder::new(
                "run-000001",
                RunMode::Shadow,
                ArtifactReference {
                    name: name.to_owned(),
                    content_hash: hash.clone(),
                },
                profile.clone(),
                case.clone(),
                completion.clone(),
            )
            .check(record(0, Outcome::Pass))
            .finish()
            .err()
            .unwrap_or_else(|| panic!("{name}: the reference was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{name}: {error}");
            assert!(
                error.field_path.starts_with("/definition"),
                "{name}: {error}"
            );
        }
        // A case identifier follows the case rule, not the artifact rule.
        let error = ReportBuilder::new(
            "run-000001",
            RunMode::Shadow,
            reference.clone(),
            profile.clone(),
            CaseReference {
                id: "Case-1".to_owned(),
                input_hash: hash_hex('c'),
            },
            completion,
        )
        .check(record(0, Outcome::Pass))
        .finish()
        .expect_err("the case identifier was accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/case/id");
        // Dots pass the case rule while they fail the artifact rule.
        assert!(ReportBuilder::new(
            "run-000001",
            RunMode::Shadow,
            reference,
            profile,
            CaseReference {
                id: "case.1_b-x".to_owned(),
                input_hash: hash_hex('c'),
            },
            Completion {
                status: CompletionStatus::Cancelled,
                completed_at: None,
            },
        )
        .check(record(0, Outcome::Error))
        .finish()
        .is_ok());
    }

    #[test]
    fn run_identifiers_and_baselines_are_bounded() {
        let reference = ArtifactReference {
            name: "message-review".to_owned(),
            content_hash: hash_hex('a'),
        };
        let profile = ProfileReference {
            id: "message-profile".to_owned(),
            content_hash: hash_hex('b'),
        };
        let case = CaseReference {
            id: "case-1".to_owned(),
            input_hash: hash_hex('c'),
        };
        let completion = Completion {
            status: CompletionStatus::Completed,
            completed_at: None,
        };
        for run_id in [String::new(), "x".repeat(129)] {
            let error = ReportBuilder::new(
                run_id.clone(),
                RunMode::Shadow,
                reference.clone(),
                profile.clone(),
                case.clone(),
                completion.clone(),
            )
            .check(record(0, Outcome::Pass))
            .finish()
            .err()
            .unwrap_or_else(|| panic!("{run_id}: the identifier was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{run_id}");
            assert_eq!(error.field_path, "/run_id");
        }
        for (outcome, revision) in [
            (String::new(), "v7".to_owned()),
            ("silent".to_owned(), String::new()),
            ("x".repeat(65), "v7".to_owned()),
            ("silent".to_owned(), "y".repeat(129)),
        ] {
            let note = format!("{}/{}", outcome, revision);
            let error = ReportBuilder::new(
                "run-000001",
                RunMode::Shadow,
                reference.clone(),
                profile.clone(),
                case.clone(),
                completion.clone(),
            )
            .baseline(Baseline { outcome, revision })
            .check(record(0, Outcome::Pass))
            .finish()
            .err()
            .unwrap_or_else(|| panic!("{note}: the baseline was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidFieldType);
            assert!(
                error.field_path.starts_with("/baseline"),
                "{}",
                error.field_path
            );
        }
        // The bounds themselves pass, and a long explanation is rejected.
        assert!(ReportBuilder::new(
            "x".repeat(128),
            RunMode::Shadow,
            reference,
            profile,
            case,
            completion,
        )
        .baseline(Baseline {
            outcome: "x".repeat(64),
            revision: "y".repeat(128),
        })
        .explanation("e".repeat(2000))
        .check(record(0, Outcome::Pass))
        .finish()
        .is_ok());
        let error = builder(&[Outcome::Pass])
            .explanation("e".repeat(2001))
            .finish()
            .expect_err("the long explanation was accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/aggregate/explanation");
    }

    #[test]
    fn check_records_enforce_their_conditional_rules() {
        // An error outcome without a reason fails.
        let mut no_reason = record(0, Outcome::Error);
        no_reason.reason = None;
        let error = builder(&[])
            .check(no_reason.clone())
            .finish()
            .expect_err("accepted");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/checks/0/reason");

        // A skipped outcome without a reason fails the same way.
        let mut no_reason = record(0, Outcome::Skipped);
        no_reason.reason = None;
        let error = builder(&[])
            .check(no_reason)
            .finish()
            .expect_err("accepted");
        assert_eq!(error.field_path, "/checks/0/reason");

        // A rule record without an executed rule fails.
        let mut no_rule = record(0, Outcome::Pass);
        no_rule.kind = RecordKind::Rule;
        let error = builder(&[]).check(no_rule).finish().expect_err("accepted");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/checks/0/applied_rule");

        // A question record with an executed rule fails.
        let mut wrong_kind = record(0, Outcome::Pass);
        wrong_kind.applied_rule = Some(AppliedRule::new(
            crate::definition::Rule::MaxLength { max_length: 80 },
            "summary",
        ));
        let error = builder(&[])
            .check(wrong_kind)
            .finish()
            .expect_err("accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/checks/0/applied_rule");

        // A rule record with an assessment or a policy fails.
        let mut with_assessment = CheckRecord {
            assessment: Some(json!({"kind": "categorical", "label": "supported"})),
            ..CheckRecord::from_rule_result(&rule_result())
        };
        with_assessment.check = "summary-length".to_owned();
        let error = builder(&[])
            .check(with_assessment)
            .finish()
            .expect_err("accepted");
        assert_eq!(error.field_path, "/checks/0/assessment");
        let mut with_policy = CheckRecord {
            applied_policy: Some(AppliedPolicy {
                accept_cutoff: 0.75,
                rejection_cutoff: 0.65,
                confidence_floor: None,
            }),
            ..CheckRecord::from_rule_result(&rule_result())
        };
        with_policy.check = "summary-length".to_owned();
        let error = builder(&[])
            .check(with_policy)
            .finish()
            .expect_err("accepted");
        assert_eq!(error.field_path, "/checks/0/applied_policy");

        // A pass record needs no reason, and an unknown check identifier
        // fails its own rule.
        let mut bad_id = record(0, Outcome::Pass);
        bad_id.check = "Summary Length".to_owned();
        let error = builder(&[]).check(bad_id).finish().expect_err("accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/checks/0/check");

        // One check cannot appear twice.
        let error = builder(&[])
            .check(record(0, Outcome::Pass))
            .check(record(0, Outcome::Fail))
            .finish()
            .expect_err("the repeated check was accepted");
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/checks/1/check");
    }

    /// One assessed rule result for the record tests.
    fn rule_result() -> RuleResult {
        RuleResult {
            check: "summary-length".to_owned(),
            outcome: RuleOutcome::Fail,
            applied_rule: AppliedRule::new(
                crate::definition::Rule::MaxLength { max_length: 80 },
                "summary",
            ),
            reason: "The input holds 81 code points, above the maxLength bound of 80.".to_owned(),
        }
    }

    #[test]
    fn a_rule_result_becomes_a_rule_record() {
        let record = CheckRecord::from_rule_result(&rule_result());
        let serialized = serde_json::to_value(&record).expect("the record serializes");
        assert_eq!(
            serialized,
            json!({
                "check": "summary-length",
                "kind": "rule",
                "outcome": "fail",
                "applied_rule": {
                    "rule": "maxLength",
                    "input": "summary",
                    "parameters": {"maxLength": 80}
                }
            })
        );
        // The record validates and parses again.
        record.validate("").expect("the record validates");
        assert_eq!(parse_check_record(&serialized, "").expect("parses"), record);

        // A passing rule result maps to a passing outcome.
        let passing = RuleResult {
            outcome: RuleOutcome::Pass,
            ..rule_result()
        };
        assert_eq!(
            CheckRecord::from_rule_result(&passing).outcome,
            Outcome::Pass
        );
    }

    #[test]
    fn policy_cutoffs_stay_above_half_and_at_most_one() {
        for (accept, rejection, floor, accepted) in [
            (0.75, 0.65, None, true),
            (1.0, 0.99, Some(0.9), true),
            (0.5, 0.65, None, false),
            (0.75, 0.5, None, false),
            (1.01, 0.65, None, false),
            (0.75, 0.65, Some(0.5), false),
            (0.75, 0.65, Some(1.01), false),
        ] {
            let mut question = record(0, Outcome::Review);
            question.applied_policy = Some(AppliedPolicy {
                accept_cutoff: accept,
                rejection_cutoff: rejection,
                confidence_floor: floor,
            });
            let finished = builder(&[]).check(question).finish();
            assert_eq!(finished.is_ok(), accepted, "{accept} {rejection} {floor:?}");
        }
        // The parse path checks the same range.
        let mut value = serde_json::to_value(record(0, Outcome::Review)).expect("serializes");
        value["applied_policy"] = json!({"accept_cutoff": 0.5, "rejection_cutoff": 0.65});
        let error = parse_check_record(&value, "").expect_err("the cutoff was accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/applied_policy/accept_cutoff");
        value["applied_policy"] = json!({"accept_cutoff": 0.75});
        let error = parse_check_record(&value, "").expect_err("the missing cutoff was accepted");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/applied_policy/rejection_cutoff");
    }

    #[test]
    fn reasons_come_from_the_registry_and_stay_bounded() {
        let reason = SanitizedReason::new(
            ReasonCode::EvaluatorError,
            "The adapter reported a network failure.",
        )
        .expect("the reason builds");
        assert_eq!(reason.field_path, None);
        let serialized = serde_json::to_value(&reason).expect("serializes");
        assert_eq!(
            serialized,
            json!({
                "code": "evaluator_error",
                "message": "The adapter reported a network failure."
            })
        );
        // A registry code with a pointer survives a conversion.
        let converted = SanitizedReason::from_validation_error(&ValidationError::new(
            ReasonCode::InvalidAssessment,
            "/assessment/label",
            "The assessment holds no label.",
        ));
        assert_eq!(converted.code, ReasonCode::InvalidAssessment);
        assert_eq!(converted.field_path.as_deref(), Some("/assessment/label"));

        // A message outside its bound fails.
        assert!(SanitizedReason::new(ReasonCode::EvaluatorError, "").is_err());
        assert!(SanitizedReason::new(ReasonCode::EvaluatorError, "x".repeat(501)).is_err());

        // A code outside the registry fails at the parse boundary.
        let mut value = serde_json::to_value(record(0, Outcome::Error)).expect("serializes");
        value["reason"] = json!({"code": "not_a_code", "message": "Broken."});
        let error = parse_check_record(&value, "").expect_err("the code was accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/reason/code");
        value["reason"] = json!({"code": "evaluator_error", "message": ""});
        let error = parse_check_record(&value, "").expect_err("the empty message was accepted");
        assert_eq!(error.field_path, "/reason/message");
    }

    #[test]
    fn evaluator_versions_attempts_and_numbers_are_checked() {
        let mut value = serde_json::to_value(record(0, Outcome::Pass)).expect("serializes");
        value["evaluator"] = json!({
            "id": "jev-choice",
            "adapter_version": "1.2.3",
            "model_resolved": "jev-2026-09"
        });
        value["attempts"] = json!(2);
        value["timing"] = json!({"queued_ms": 12, "execution_ms": 2400});
        value["usage"] = json!({"input_tokens": 1200});
        let parsed = parse_check_record(&value, "").expect("the record parses");
        assert_eq!(
            parsed.evaluator.as_ref().expect("versions").id,
            "jev-choice"
        );
        assert_eq!(
            parsed
                .evaluator
                .as_ref()
                .expect("versions")
                .model_resolved
                .as_deref(),
            Some("jev-2026-09")
        );
        assert_eq!(parsed.attempts, Some(2));
        assert_eq!(
            parsed.timing.as_ref().expect("timing").execution_ms,
            Some(Number::from(2400))
        );

        // A wrong evaluator identifier, a zero attempt count, a negative
        // duration, and a non-number usage value all fail with their
        // pointers.
        for (path, bad) in [
            (
                "/evaluator/id",
                json!({"id": "Jev", "adapter_version": "1"}),
            ),
            ("/attempts", json!(0)),
            ("/attempts", json!(1.5)),
            ("/timing/queued_ms", json!({"queued_ms": -1})),
            ("/usage/requests", json!({"requests": "many"})),
        ] {
            let mut value = serde_json::to_value(record(0, Outcome::Pass)).expect("serializes");
            let (field, replacement) = if path == "/evaluator/id" {
                ("evaluator", bad.clone())
            } else if path == "/attempts" {
                ("attempts", bad.clone())
            } else if path == "/timing/queued_ms" {
                ("timing", bad.clone())
            } else {
                ("usage", bad.clone())
            };
            value[field] = replacement;
            let error = parse_check_record(&value, "")
                .err()
                .unwrap_or_else(|| panic!("{path}: the value was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{path}: {error}");
            assert_eq!(error.field_path, path, "{path}: {error}");
        }
    }

    #[test]
    fn timestamps_must_be_rfc3339() {
        for good in [
            "2026-09-23T10:00:02Z",
            "2026-09-23T10:00:02.500Z",
            "2026-09-23t10:00:02z",
            "2026-09-23T10:00:02+02:00",
            "2026-09-23T10:00:02.5-11:30",
            "2024-02-29T23:59:60Z",
            "2000-02-29T00:00:00Z",
        ] {
            assert!(is_rfc3339(good), "{good}");
            let mut value = serde_json::to_value(finished(&[Outcome::Pass])).expect("serializes");
            value["completion"]["completed_at"] = json!(good);
            parse_run_report(&value).unwrap_or_else(|error| panic!("{good}: {error}"));
        }
        for bad in [
            "",
            "2026-09-23",
            "2026-09-23T10:00:02",
            "2026-13-01T10:00:02Z",
            "2026-09-31T10:00:02Z",
            "2023-02-29T10:00:02Z",
            "2026-00-10T10:00:02Z",
            "2026-09-23T24:00:02Z",
            "2026-09-23T10:60:02Z",
            "2026-09-23T10:00:61Z",
            "2026-09-23T10:00:02.Z",
            "2026-09-23T10:00:02+24:00",
            "2026-09-23T10:00:02+02:60",
            "2026-09-23 10:00:02Z",
            "not a time",
        ] {
            assert!(!is_rfc3339(bad), "{bad}");
        }
        // A bad terminal time fails at the completion boundary.
        let error = Completion {
            status: CompletionStatus::Completed,
            completed_at: Some("2026-09-23".to_owned()),
        }
        .validate("/completion")
        .expect_err("the date without a time was accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/completion/completed_at");
    }

    #[test]
    fn assessments_keep_their_recorded_shape() {
        // Every valid sample of the assessment fixtures records as it was
        // returned.
        for good in [
            json!({"kind": "categorical", "label": "supported"}),
            json!({"kind": "binary", "value": true}),
            json!({"kind": "ordered", "level": "meaningful", "position": 1.5}),
            json!({"kind": "categorical", "label": "supported", "confidence": 0.9}),
        ] {
            let mut value = serde_json::to_value(record(0, Outcome::Review)).expect("serializes");
            value["assessment"] = good.clone();
            let parsed =
                parse_check_record(&value, "").unwrap_or_else(|error| panic!("{good}: {error}"));
            assert_eq!(parsed.assessment.as_ref(), Some(&good));
        }
        // Evidence that the evaluator selected stays inside the assessment.
        let with_evidence = json!({
            "kind": "categorical",
            "label": "supported",
            "evidence": [{"input": "prior_decision", "reference": "decision-2026-03"}]
        });
        let mut value = serde_json::to_value(record(0, Outcome::Review)).expect("serializes");
        value["assessment"] = with_evidence;
        parse_check_record(&value, "").expect("the evidence entry parses");

        // Structural failures of the assessment schema.
        for (bad, code, path) in [
            (
                json!({"kind": "categorical"}),
                ReasonCode::MissingField,
                "/assessment/label",
            ),
            (json!("text"), ReasonCode::InvalidFieldType, "/assessment"),
            (
                json!({"label": "supported"}),
                ReasonCode::MissingField,
                "/assessment/kind",
            ),
            (
                json!({"kind": "scale", "label": "supported"}),
                ReasonCode::InvalidFieldType,
                "/assessment/kind",
            ),
            (
                json!({"kind": "categorical", "label": "supported", "value": true}),
                ReasonCode::InvalidFieldType,
                "/assessment",
            ),
            (
                json!({"kind": "binary", "label": "yes"}),
                ReasonCode::MissingField,
                "/assessment/value",
            ),
            (
                json!({"kind": "ordered", "position": 1.5}),
                ReasonCode::MissingField,
                "/assessment/level",
            ),
            (
                json!({"kind": "ordered", "level": "minor", "value": true}),
                ReasonCode::InvalidFieldType,
                "/assessment",
            ),
            (
                json!({"kind": "categorical", "label": "supported", "extra": 1}),
                ReasonCode::UnknownField,
                "/assessment/extra",
            ),
            (
                json!({"kind": "categorical", "label": "supported", "confidence": 1.5}),
                ReasonCode::InvalidFieldType,
                "/assessment/confidence",
            ),
            (
                json!({"kind": "categorical", "label": "supported", "position": 1.0}),
                ReasonCode::InvalidFieldType,
                "/assessment",
            ),
        ] {
            let mut value = serde_json::to_value(record(0, Outcome::Review)).expect("serializes");
            value["assessment"] = bad.clone();
            let error = parse_check_record(&value, "")
                .err()
                .unwrap_or_else(|| panic!("{bad}: the assessment was accepted"));
            assert_eq!(error.code, code, "{bad}: {error}");
            assert_eq!(error.field_path, path, "{bad}: {error}");
        }
        // Distribution failures: too short, a bad mass, and a repeated name.
        for (bad, path) in [
            (
                json!({"kind": "categorical", "label": "supported", "distribution": [
                    {"name": "supported", "mass": 1.0}
                ]}),
                "/assessment/distribution",
            ),
            (
                json!({"kind": "categorical", "label": "supported", "distribution": [
                    {"name": "supported", "mass": 0.7},
                    {"name": "incomplete", "mass": 1.2}
                ]}),
                "/assessment/distribution/1/mass",
            ),
            (
                json!({"kind": "categorical", "label": "supported", "distribution": [
                    {"name": "supported", "mass": 0.7},
                    {"name": "supported", "mass": 0.3}
                ]}),
                "/assessment/distribution/1/name",
            ),
            (
                json!({"kind": "categorical", "label": "supported", "evidence": [
                    {"input": "prior_decision"}
                ]}),
                "/assessment/evidence/0/reference",
            ),
            (
                json!({"kind": "categorical", "label": "supported", "evidence": [
                    {"input": "prior decision", "reference": "decision-2026-03"}
                ]}),
                "/assessment/evidence/0/input",
            ),
        ] {
            let mut value = serde_json::to_value(record(0, Outcome::Review)).expect("serializes");
            value["assessment"] = bad.clone();
            let error = parse_check_record(&value, "")
                .err()
                .unwrap_or_else(|| panic!("{bad}: the assessment was accepted"));
            assert_eq!(error.field_path, path, "{bad}: {error}");
        }
    }

    #[test]
    fn references_bind_the_hashing_module() {
        let artifact = json!({
            "schema_version": 1,
            "name": "delivery-limits",
            "inputs": {
                "type": "object",
                "properties": {"summary": {"type": "string", "minLength": 1}},
                "required": ["summary"],
                "additionalProperties": false
            },
            "checks": [{
                "id": "summary-length",
                "name": "The summary fits the delivery limit",
                "using": ["summary"],
                "rule": {"maxLength": 10}
            }]
        });
        let definition = crate::definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates");
        let reference = ArtifactReference::for_definition(&definition);
        assert_eq!(reference.name, "delivery-limits");
        assert_eq!(
            reference.content_hash,
            hashing::definition_hash(&definition)
        );

        let case = crate::case::validate_case_str(
            &json!({"id": "case-1", "input": {"summary": "0123456789"}}).to_string(),
            &definition,
        )
        .expect("the case validates");
        let case_reference = CaseReference::for_case(&case);
        assert_eq!(case_reference.id, "case-1");
        assert_eq!(case_reference.input_hash, hashing::input_hash(case.input()));
        // A changed input gives a changed reference.
        let changed = crate::case::validate_case_str(
            &json!({"id": "case-1", "input": {"summary": "changed text"}}).to_string(),
            &definition,
        )
        .expect("the case validates");
        assert_ne!(
            CaseReference::for_case(&changed).input_hash,
            case_reference.input_hash
        );

        // A report that binds both references hashes consistently.
        let report = ReportBuilder::new(
            "run-000001",
            RunMode::Enforcement,
            reference,
            ProfileReference {
                id: "delivery-limits-exact".to_owned(),
                content_hash: hash_hex('b'),
            },
            case_reference,
            Completion {
                status: CompletionStatus::Completed,
                completed_at: None,
            },
        )
        .check(CheckRecord::from_rule_result(
            &crate::rule::assess_rule_checks(&case).expect("the rule assesses")[0],
        ))
        .finish()
        .expect("the report finishes");
        assert_eq!(report.aggregate(), AggregateOutcome::Pass);
        let serialized = serde_json::to_value(&report).expect("serializes");
        assert_eq!(
            serialized["checks"][0]["applied_rule"]["parameters"],
            json!({"maxLength": 10})
        );
    }

    #[test]
    fn a_completed_record_stays_unchanged() {
        // A finished report is a value. Later results go to a new report, and
        // the first record keeps every component outcome it captured.
        let first = finished(&[Outcome::Pass, Outcome::Fail]);
        let before = serde_json::to_value(&first).expect("serializes");
        let second = builder(&[Outcome::Pass, Outcome::Error])
            .finish()
            .expect("the report finishes");
        assert_eq!(second.aggregate(), AggregateOutcome::Error);
        assert_eq!(
            serde_json::to_value(&first).expect("serializes"),
            before,
            "building another report changed the first record"
        );
        // A clone is a separate record with the same value. The type offers
        // no mutation method, so a copy cannot drift from its source here.
        let clone = first.clone();
        assert_eq!(clone, first);
        assert_eq!(first.checks().len(), 2);
        assert_eq!(first.aggregate(), AggregateOutcome::Fail);
        // A reparsed stored report computes the same aggregate again.
        assert_eq!(
            parse_run_report(&before).expect("parses").aggregate(),
            AggregateOutcome::Fail
        );
    }
}
