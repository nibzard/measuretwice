// SPDX-License-Identifier: Apache-2.0
//! Profile validation and evaluator compatibility.
//!
//! A profile is one immutable artifact that binds one definition to
//! evaluators, decision rules, execution limits, and evidence. This module
//! is the one authority for its contract. [`validate_profile_str`] returns
//! one [`ValidatedProfile`] or one typed rejection with a field path.
//! [`check_compatibility`] then compares one validated profile against one
//! loaded definition, the registered evaluators, and the requested use,
//! before any evaluator runs. [`check_evidence`] compares the recorded
//! evidence of one selected profile against the artifacts that the host
//! retained at its own explicit locations.
//!
//! Artifact validation covers the schema file and the cross-field rules
//! that the contracts README states:
//!
//! - An exploration profile stays `unvalidated`. Starter thresholds carry
//!   no qualification evidence.
//! - An exact profile binds no evaluator and takes the `exact` policy
//!   family. The family `exact` belongs to the exact origin alone.
//! - A calibration profile records its complete evidence: plan, datasets,
//!   splits, label provenance, evaluation-report references, and
//!   statistical method.
//! - Both cutoffs of the `probability_mass_v0` family stay above 0.5 and
//!   at most 1, so one assessment cannot pass and fail together.
//! - The stored `content_hash` equals the computed self-hash of the
//!   artifact. An edited or corrupted copy fails with `hash_mismatch`.
//!
//! Compatibility fails before execution with the compatibility reason
//! codes of the registry. One changed definition, evaluator, adapter
//! version, translation, preprocessing identity, or resolved model breaks
//! the binding, as MVP_SPEC.md section 8 states. Enforcement adds the
//! scope, qualification, and selection clauses of the checked
//! qualification model.
//!
//! The comparison verifies content consistency. It cannot authenticate
//! one label, one population claim, or one host approval: one forged
//! dataset that states `validated_for_scope` is indistinguishable here.
//! The host reviews and selects one profile hash; the qualification flag
//! records evidence, and no report or profile grants an application
//! action. Profiles hold no credentials and no raw case content, and the
//! field contract keeps it that way: every foreign field rejects with
//! `unknown_field`.

use crate::artifact::{expect_object, reject_unknown_fields, schema_version};
use crate::definition::{is_artifact_id, parse_bounded_string, CheckKind, ValidatedDefinition};
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::hashing::{self, Domain};
use crate::policy;
use crate::report::{AppliedPolicy, RunMode};
use serde::Serialize;
use serde_json::{Map, Value};

/// Fields of one profile artifact, from the schema file.
const PROFILE_FIELDS: &[&str] = &[
    "schema_version",
    "id",
    "content_hash",
    "origin",
    "intended_use",
    "definition",
    "bindings",
    "policy",
    "execution",
    "evidence",
    "performance",
    "qualification",
];

/// Fields of one binding entry, from the schema file.
const BINDING_FIELDS: &[&str] = &[
    "check",
    "evaluator",
    "adapter_version",
    "translation",
    "model",
    "preprocessing",
];

/// Fields of one policy object, from the schema file.
const POLICY_FIELDS: &[&str] = &["family", "checks"];

/// Fields of one execution object, from the schema file.
const EXECUTION_FIELDS: &[&str] = &[
    "max_active",
    "max_pending",
    "deadline_ms",
    "max_attempts",
    "backoff_ms",
];

/// Fields of one evidence object, from the schema file.
const EVIDENCE_FIELDS: &[&str] = &[
    "plan",
    "datasets",
    "splits",
    "label_provenance",
    "evaluation_reports",
    "statistical_method",
];

/// Fields of one performance object, from the schema file.
const PERFORMANCE_FIELDS: &[&str] = &[
    "metrics",
    "intervals",
    "sample_counts",
    "sample_minimums",
    "slice_limitations",
];

/// Fields of one qualification object, from the schema file.
const QUALIFICATION_FIELDS: &[&str] = &["status", "scope", "reasons"];

/// The metric names of `common.schema.json`.
const METRIC_NAMES: &[&str] = &[
    "false_acceptance_rate",
    "error_among_accepted",
    "false_rejection_rate",
    "review_rate",
    "automatic_coverage",
    "label_coverage",
];

/// The confidence levels that an interval may state.
const CONFIDENCE_LEVELS: [f64; 3] = [0.9, 0.95, 0.99];

/// The origin of one profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProfileOrigin {
    /// Starter policy without qualification evidence. Evaluation and shadow
    /// use only.
    Exploration,
    /// Measured evidence from one calibration.
    Calibration,
    /// Exact rules only, with one structural basis.
    Exact,
}

impl ProfileOrigin {
    /// Returns the contract word of this origin.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Exploration => "exploration",
            Self::Calibration => "calibration",
            Self::Exact => "exact",
        }
    }

    /// Returns the origin of one contract word, or `None` for any other text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "exploration" => Some(Self::Exploration),
            "calibration" => Some(Self::Calibration),
            "exact" => Some(Self::Exact),
            _ => None,
        }
    }
}

/// The qualification status of one profile.
///
/// The words are the four contract statuses. The frozen validation of
/// [`crate::qualification`] returns the same value, so one candidate result
/// and the profile it becomes state one status through one type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Qualification {
    /// Starter thresholds without qualification evidence.
    Unvalidated,
    /// The recorded evidence does not meet the plan requirements.
    InsufficientEvidence,
    /// The recorded evidence exists but fails the declared goals.
    CriteriaNotMet,
    /// The recorded evidence establishes the declared scope.
    ValidatedForScope,
}

impl Qualification {
    /// Returns the contract word of this status.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unvalidated => "unvalidated",
            Self::InsufficientEvidence => "insufficient_evidence",
            Self::CriteriaNotMet => "criteria_not_met",
            Self::ValidatedForScope => "validated_for_scope",
        }
    }

    /// Returns the status of one contract word, or `None` for any other text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "unvalidated" => Some(Self::Unvalidated),
            "insufficient_evidence" => Some(Self::InsufficientEvidence),
            "criteria_not_met" => Some(Self::CriteriaNotMet),
            "validated_for_scope" => Some(Self::ValidatedForScope),
            _ => None,
        }
    }
}

/// The decision-rule family of one profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PolicyFamily {
    /// Acceptance and rejection on probability mass.
    ProbabilityMassV0,
    /// Exact rules only.
    Exact,
}

impl PolicyFamily {
    /// Returns the contract word of this family.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProbabilityMassV0 => "probability_mass_v0",
            Self::Exact => "exact",
        }
    }

    /// Returns the family of one contract word, or `None` for any other text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "probability_mass_v0" => Some(Self::ProbabilityMassV0),
            "exact" => Some(Self::Exact),
            _ => None,
        }
    }
}

/// The model binding of one evaluator binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelBinding {
    /// The model the binding requested, one versioned identifier or alias.
    pub requested: String,
    /// The model version that served the measurement, when one is known.
    pub resolved: Option<String>,
}

/// One evaluator binding of one validated profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileBindingEntry {
    /// The bound check.
    pub check: String,
    /// The registered evaluator identifier.
    pub evaluator: String,
    /// The adapter version of the binding.
    pub adapter_version: String,
    /// The content hash of the recorded translated question.
    pub translation_hash: String,
    /// The model binding, when the profile records one.
    pub model: Option<ModelBinding>,
    /// The preprocessing identity, when the profile records one.
    pub preprocessing: Option<String>,
}

/// One numerical policy entry of one validated profile.
#[derive(Debug, Clone, PartialEq)]
pub struct PolicyCheckEntry {
    /// The question check that this policy decides.
    pub check: String,
    /// The recorded parameters.
    pub policy: AppliedPolicy,
}

/// One profile artifact that passed the complete contract check.
///
/// The value states that the artifact holds no contract violation and that
/// its stored self-hash covers its content. The authored artifact stays
/// unchanged inside it.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedProfile {
    /// The artifact, as authored and hashed.
    artifact: Value,
    /// Stable profile identifier.
    id: String,
    /// Profile origin.
    origin: ProfileOrigin,
    /// The declared population and scope.
    intended_use: String,
    /// The name of the bound definition.
    definition_name: String,
    /// The content hash of the bound definition.
    definition_hash: String,
    /// The verified self-hash.
    content_hash: String,
    /// One entry per recorded evaluator binding, in written order.
    bindings: Vec<ProfileBindingEntry>,
    /// The decision-rule family.
    family: PolicyFamily,
    /// The numerical policy entries, in written order.
    policy_checks: Vec<PolicyCheckEntry>,
    /// The qualification status.
    qualification: Qualification,
    /// The scope that the status covers, when stated.
    qualification_scope: Option<String>,
}

impl ValidatedProfile {
    /// Returns the artifact, unchanged.
    pub fn as_artifact(&self) -> &Value {
        &self.artifact
    }

    /// Returns the stable profile identifier.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Returns the profile origin.
    pub fn origin(&self) -> ProfileOrigin {
        self.origin
    }

    /// Returns the declared population and scope.
    pub fn intended_use(&self) -> &str {
        &self.intended_use
    }

    /// Returns the name of the bound definition.
    pub fn definition_name(&self) -> &str {
        &self.definition_name
    }

    /// Returns the content hash of the bound definition.
    pub fn definition_hash(&self) -> &str {
        &self.definition_hash
    }

    /// Returns the verified self-hash of the artifact.
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    /// Returns every evaluator binding, in written order.
    pub fn bindings(&self) -> &[ProfileBindingEntry] {
        &self.bindings
    }

    /// Returns the decision-rule family.
    pub fn family(&self) -> PolicyFamily {
        self.family
    }

    /// Returns every numerical policy entry, in written order.
    pub fn policy_checks(&self) -> &[PolicyCheckEntry] {
        &self.policy_checks
    }

    /// Returns the qualification status.
    pub fn qualification(&self) -> Qualification {
        self.qualification
    }

    /// Returns the scope that the status covers, when stated.
    pub fn qualification_scope(&self) -> Option<&str> {
        self.qualification_scope.as_deref()
    }
}

/// Validates one profile artifact from strict JSON text.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the text fails the strict JSON gate,
/// the profile contract, or the stored self-hash.
pub fn validate_profile_str(text: &str) -> Result<ValidatedProfile, ValidationError> {
    crate::json::parse_strict(text).and_then(|value| validate_profile(&value))
}

/// Validates one profile artifact from strict JSON bytes.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the bytes fail the UTF-8 check, the
/// strict JSON gate, the profile contract, or the stored self-hash.
pub fn validate_profile_bytes(bytes: &[u8]) -> Result<ValidatedProfile, ValidationError> {
    crate::json::parse_bytes_strict(bytes).and_then(|value| validate_profile(&value))
}

/// Validates one profile artifact that passed the strict JSON gate.
///
/// Every field is checked against the schema file and the cross-field rules
/// of the contracts README. The stored self-hash is verified last, so one
/// field defect names its field and not the digest.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the artifact breaks the profile
/// contract or its stored self-hash differs from the computed digest.
pub fn validate_profile(value: &Value) -> Result<ValidatedProfile, ValidationError> {
    let root = expect_object(value, "")?;
    let _schema_version = schema_version(root)?;
    reject_unknown_fields(root, PROFILE_FIELDS, "")?;

    let id = required_artifact_id(root, "id", "/id")?;
    let origin = match root.get("origin") {
        Some(Value::String(text)) => ProfileOrigin::from_word(text).ok_or_else(|| {
            ValidationError::invalid_field_type(
                "/origin",
                "The origin must hold exploration, calibration, or exact.",
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/origin",
                "The origin must hold exploration, calibration, or exact.",
            ));
        }
        None => return Err(ValidationError::missing("/origin")),
    };
    let intended_use = required_bounded_string(root, "intended_use", "/intended_use", 2000)?;
    let definition = required_object(root, "definition", "")?;
    let definition_name = required_artifact_id(definition, "name", "/definition/name")?;
    let definition_hash = required_hash(definition, "content_hash", "/definition/content_hash")?;

    let bindings = match root.get("bindings") {
        Some(Value::Array(items)) => {
            let mut parsed = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let binding = parse_binding(item, index)?;
                if parsed
                    .iter()
                    .any(|earlier: &ProfileBindingEntry| earlier.check == binding.check)
                {
                    return Err(ValidationError::new(
                        ReasonCode::DuplicateId,
                        format!("/bindings/{index}/check"),
                        format!("Two bindings name the check {}.", fragment(&binding.check)),
                    ));
                }
                parsed.push(binding);
            }
            parsed
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/bindings",
                "The bindings field must hold one array.",
            ));
        }
        None => Vec::new(),
    };

    let policy = required_object(root, "policy", "")?;
    reject_unknown_fields(policy, POLICY_FIELDS, "/policy")?;
    let family = match policy.get("family") {
        Some(Value::String(text)) => PolicyFamily::from_word(text).ok_or_else(|| {
            ValidationError::invalid_field_type(
                "/policy/family",
                "The policy family must hold probability_mass_v0 or exact.",
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/policy/family",
                "The policy family must hold probability_mass_v0 or exact.",
            ));
        }
        None => return Err(ValidationError::missing("/policy/family")),
    };
    let policy_checks = match (family, policy.get("checks")) {
        (PolicyFamily::Exact, None) => Vec::new(),
        (PolicyFamily::Exact, Some(_)) => {
            return Err(ValidationError::invalid_field_type(
                "/policy/checks",
                "The exact family states no numerical parameters. Keep the checks list absent.",
            ));
        }
        (PolicyFamily::ProbabilityMassV0, None) => {
            return Err(ValidationError::missing("/policy/checks"));
        }
        (PolicyFamily::ProbabilityMassV0, Some(Value::Array(items))) => {
            let mut parsed = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let entry = parse_policy_check(item, index)?;
                if parsed
                    .iter()
                    .any(|earlier: &PolicyCheckEntry| earlier.check == entry.check)
                {
                    return Err(ValidationError::new(
                        ReasonCode::DuplicateId,
                        format!("/policy/checks/{index}/check"),
                        format!(
                            "Two policy entries name the check {}.",
                            fragment(&entry.check)
                        ),
                    ));
                }
                parsed.push(entry);
            }
            if parsed.is_empty() {
                return Err(ValidationError::invalid_field_type(
                    "/policy/checks",
                    "The probability_mass_v0 family must state one policy entry at least.",
                ));
            }
            parsed
        }
        (PolicyFamily::ProbabilityMassV0, Some(_)) => {
            return Err(ValidationError::invalid_field_type(
                "/policy/checks",
                "The policy checks field must hold one array.",
            ));
        }
    };

    validate_execution(root)?;
    validate_evidence(root, origin)?;
    validate_performance(root)?;

    let qualification = required_object(root, "qualification", "")?;
    reject_unknown_fields(qualification, QUALIFICATION_FIELDS, "/qualification")?;
    let status = match qualification.get("status") {
        Some(Value::String(text)) => Qualification::from_word(text),
        _ => None,
    }
    .ok_or_else(|| {
        ValidationError::invalid_field_type(
            "/qualification/status",
            "The status must hold unvalidated, insufficient_evidence, criteria_not_met, or validated_for_scope.",
        )
    })?;
    let qualification_scope = parse_bounded_string(
        qualification.get("scope"),
        "/qualification/scope",
        2000,
        "The qualification scope",
    )?;
    let reasons = match qualification.get("reasons") {
        Some(Value::Array(items)) if !items.is_empty() => items.clone(),
        Some(Value::Array(_)) => {
            return Err(ValidationError::invalid_field_type(
                "/qualification/reasons",
                "The qualification must state one reason at least.",
            ));
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/qualification/reasons",
                "The reasons field must hold one array of reason codes.",
            ));
        }
        None => return Err(ValidationError::missing("/qualification/reasons")),
    };
    for (index, reason) in reasons.iter().enumerate() {
        let Value::String(text) = reason else {
            return Err(ValidationError::invalid_field_type(
                format!("/qualification/reasons/{index}"),
                "Every reason must hold one code of the published registry.",
            ));
        };
        if ReasonCode::from_registry(text).is_none() {
            return Err(ValidationError::invalid_field_type(
                format!("/qualification/reasons/{index}"),
                format!(
                    "The reason {} names no code of the published registry.",
                    fragment(text)
                ),
            ));
        }
    }

    // The cross-field origin rules of the contracts README.
    if origin == ProfileOrigin::Exploration && status != Qualification::Unvalidated {
        return Err(ValidationError::invalid_field_type(
            "/qualification/status",
            "An exploration profile stays unvalidated. Starter thresholds carry no qualification evidence.",
        ));
    }
    if origin == ProfileOrigin::Exact {
        if family != PolicyFamily::Exact {
            return Err(ValidationError::invalid_field_type(
                "/policy/family",
                "An exact profile takes the exact policy family.",
            ));
        }
        if !bindings.is_empty() {
            return Err(ValidationError::invalid_field_type(
                "/bindings/0",
                "An exact profile binds no evaluator. Exact rules need no stochastic measurement.",
            ));
        }
    } else if family == PolicyFamily::Exact {
        return Err(ValidationError::invalid_field_type(
            "/policy/family",
            "The exact family belongs to the exact origin alone. One exploration or calibration profile states its decision rule as probability_mass_v0.",
        ));
    }

    // The stored digest and the stored self-hash are read last. Every field
    // defect above names its own field, so one edited copy reports the edit
    // when the fields still parse, and one stripped copy loses the digest
    // field before any digest is computed.
    let content_hash = required_hash(root, "content_hash", "/content_hash")?;
    hashing::verify_self_hash(Domain::Profile, value)?;

    Ok(ValidatedProfile {
        artifact: value.clone(),
        id,
        origin,
        intended_use,
        definition_name,
        definition_hash,
        content_hash,
        bindings,
        family,
        policy_checks,
        qualification: status,
        qualification_scope,
    })
}

/// Parses one evaluator binding at `/bindings/{index}`.
fn parse_binding(value: &Value, index: usize) -> Result<ProfileBindingEntry, ValidationError> {
    let base = format!("/bindings/{index}");
    let binding = expect_object(value, &base)?;
    reject_unknown_fields(binding, BINDING_FIELDS, &base)?;
    let check = required_artifact_id(binding, "check", &format!("{base}/check"))?;
    let evaluator = required_artifact_id(binding, "evaluator", &format!("{base}/evaluator"))?;
    let adapter_version = required_bounded_string(
        binding,
        "adapter_version",
        &format!("{base}/adapter_version"),
        64,
    )?;
    let translation = required_object(binding, "translation", &base)?;
    let translation_hash = required_hash(
        translation,
        "content_hash",
        &format!("{base}/translation/content_hash"),
    )?;
    parse_bounded_string(
        translation.get("question"),
        &format!("{base}/translation/question"),
        16000,
        "The translated question",
    )?
    .ok_or_else(|| ValidationError::missing(format!("{base}/translation/question")))?;
    let model = match binding.get("model") {
        None => None,
        Some(model) => {
            let model = expect_object(model, &format!("{base}/model"))?;
            reject_unknown_fields(model, &["requested", "resolved"], &format!("{base}/model"))?;
            Some(ModelBinding {
                requested: required_bounded_string(
                    model,
                    "requested",
                    &format!("{base}/model/requested"),
                    128,
                )?,
                resolved: parse_bounded_string(
                    model.get("resolved"),
                    &format!("{base}/model/resolved"),
                    128,
                    "The resolved model version",
                )?,
            })
        }
    };
    let preprocessing = parse_bounded_string(
        binding.get("preprocessing"),
        &format!("{base}/preprocessing"),
        128,
        "The preprocessing identity",
    )?;
    Ok(ProfileBindingEntry {
        check,
        evaluator,
        adapter_version,
        translation_hash,
        model,
        preprocessing,
    })
}

/// Parses one policy entry at `/policy/checks/{index}`.
fn parse_policy_check(value: &Value, index: usize) -> Result<PolicyCheckEntry, ValidationError> {
    let base = format!("/policy/checks/{index}");
    let entry = expect_object(value, &base)?;
    reject_unknown_fields(
        entry,
        &[
            "check",
            "accept_cutoff",
            "rejection_cutoff",
            "confidence_floor",
        ],
        &base,
    )?;
    let check = required_artifact_id(entry, "check", &format!("{base}/check"))?;
    let applied = AppliedPolicy {
        accept_cutoff: required_number(entry, "accept_cutoff", &base)?,
        rejection_cutoff: required_number(entry, "rejection_cutoff", &base)?,
        confidence_floor: match entry.get("confidence_floor") {
            None => None,
            Some(_) => Some(required_number(entry, "confidence_floor", &base)?),
        },
    };
    applied.validate(&base)?;
    Ok(PolicyCheckEntry {
        check,
        policy: applied,
    })
}

/// Validates the effective execution configuration at `/execution`.
fn validate_execution(root: &Map<String, Value>) -> Result<(), ValidationError> {
    let execution = required_object(root, "execution", "")?;
    reject_unknown_fields(execution, EXECUTION_FIELDS, "/execution")?;
    required_whole(execution, "max_active", "/execution", 1, None)?;
    required_whole(execution, "max_pending", "/execution", 0, None)?;
    required_whole(execution, "deadline_ms", "/execution", 1, None)?;
    required_whole(execution, "max_attempts", "/execution", 1, Some(10))?;
    required_whole(execution, "backoff_ms", "/execution", 0, None)?;
    Ok(())
}

/// Validates the qualification evidence at `/evidence`.
///
/// A calibration origin records the complete evidence. Every other origin
/// states its evidence optionally, and every stated part must be complete.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `missing_field` when one required
/// evidence reference is absent, or with `invalid_field_type` when one
/// stated part breaks its shape.
fn validate_evidence(
    root: &Map<String, Value>,
    origin: ProfileOrigin,
) -> Result<(), ValidationError> {
    let Some(evidence) = root.get("evidence") else {
        if origin == ProfileOrigin::Calibration {
            return Err(ValidationError::missing("/evidence"));
        }
        return Ok(());
    };
    let evidence = expect_object(evidence, "/evidence")?;
    reject_unknown_fields(evidence, EVIDENCE_FIELDS, "/evidence")?;

    let plan = match evidence.get("plan") {
        None => None,
        Some(plan) => {
            let plan = expect_object(plan, "/evidence/plan")?;
            reject_unknown_fields(plan, &["id", "content_hash"], "/evidence/plan")?;
            required_artifact_id(plan, "id", "/evidence/plan/id")?;
            required_hash(plan, "content_hash", "/evidence/plan/content_hash")?;
            Some(())
        }
    };
    let datasets = match evidence.get("datasets") {
        None => None,
        Some(Value::Array(items)) => {
            if items.is_empty() {
                return Err(ValidationError::invalid_field_type(
                    "/evidence/datasets",
                    "The evidence must state one dataset at least.",
                ));
            }
            for (index, item) in items.iter().enumerate() {
                let base = format!("/evidence/datasets/{index}");
                let dataset = expect_object(item, &base)?;
                reject_unknown_fields(dataset, &["id", "revision", "content_hash"], &base)?;
                required_artifact_id(dataset, "id", &format!("{base}/id"))?;
                required_bounded_string(dataset, "revision", &format!("{base}/revision"), 64)?;
                required_hash(dataset, "content_hash", &format!("{base}/content_hash"))?;
            }
            Some(())
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/evidence/datasets",
                "The datasets field must hold one array.",
            ));
        }
    };
    let splits = match evidence.get("splits") {
        None => None,
        Some(Value::Array(items)) => {
            for (index, item) in items.iter().enumerate() {
                let base = format!("/evidence/splits/{index}");
                let split = expect_object(item, &base)?;
                reject_unknown_fields(split, &["id", "content_hash"], &base)?;
                required_artifact_id(split, "id", &format!("{base}/id"))?;
                required_hash(split, "content_hash", &format!("{base}/content_hash"))?;
            }
            Some(())
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/evidence/splits",
                "The splits field must hold one array.",
            ));
        }
    };
    let label_provenance = parse_bounded_string(
        evidence.get("label_provenance"),
        "/evidence/label_provenance",
        2000,
        "The label provenance",
    )?
    .is_some();
    let reports = match evidence.get("evaluation_reports") {
        None => false,
        Some(Value::Array(items)) => {
            for (index, item) in items.iter().enumerate() {
                parse_bounded_string(
                    Some(item),
                    &format!("/evidence/evaluation_reports/{index}"),
                    500,
                    "Every evaluation-report reference",
                )?;
            }
            !items.is_empty()
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/evidence/evaluation_reports",
                "The evaluation-report references must hold one array of strings.",
            ));
        }
    };
    let method = parse_bounded_string(
        evidence.get("statistical_method"),
        "/evidence/statistical_method",
        2000,
        "The statistical method",
    )?
    .is_some();

    if origin == ProfileOrigin::Calibration {
        // The contracts require the complete evidence set. Each missing part
        // names itself, so one incomplete candidate states what it lacks.
        for (present, path, what) in [
            (plan.is_some(), "/evidence/plan", "plan"),
            (datasets.is_some(), "/evidence/datasets", "datasets"),
            (splits.is_some(), "/evidence/splits", "splits"),
            (
                label_provenance,
                "/evidence/label_provenance",
                "label provenance",
            ),
            (
                reports,
                "/evidence/evaluation_reports",
                "evaluation-report references",
            ),
            (method, "/evidence/statistical_method", "statistical method"),
        ] {
            if !present {
                return Err(ValidationError::new(
                    ReasonCode::MissingField,
                    path,
                    format!("A calibration profile records its {what}."),
                ));
            }
        }
    }
    Ok(())
}

/// Validates the recorded performance at `/performance`.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` when one stated
/// metric, interval, count, or limitation breaks its shape.
fn validate_performance(root: &Map<String, Value>) -> Result<(), ValidationError> {
    let Some(performance) = root.get("performance") else {
        return Ok(());
    };
    let performance = expect_object(performance, "/performance")?;
    reject_unknown_fields(performance, PERFORMANCE_FIELDS, "/performance")?;
    if let Some(Value::Array(metrics)) = performance.get("metrics") {
        for (index, item) in metrics.iter().enumerate() {
            let base = format!("/performance/metrics/{index}");
            let metric = expect_object(item, &base)?;
            reject_unknown_fields(
                metric,
                &["scope", "metric", "numerator", "denominator", "value"],
                &base,
            )?;
            required_bounded_string(metric, "scope", &format!("{base}/scope"), 64)?;
            match metric.get("metric") {
                Some(Value::String(name)) if METRIC_NAMES.contains(&name.as_str()) => {}
                _ => {
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/metric"),
                        "The metric must name one metric of the published set.",
                    ));
                }
            }
            required_whole(metric, "numerator", &base, 0, None)?;
            required_whole(metric, "denominator", &base, 0, None)?;
            match metric.get("value") {
                Some(Value::Null) | None => {}
                Some(value) => {
                    let number = as_finite(value).ok_or_else(|| {
                        ValidationError::invalid_field_type(
                            format!("{base}/value"),
                            "The metric value must hold one number from 0 to 1, or null.",
                        )
                    })?;
                    if !(0.0..=1.0).contains(&number) {
                        return Err(ValidationError::invalid_field_type(
                            format!("{base}/value"),
                            "The metric value must hold one number from 0 to 1, or null.",
                        ));
                    }
                }
            }
        }
    } else if performance.get("metrics").is_some() {
        return Err(ValidationError::invalid_field_type(
            "/performance/metrics",
            "The metrics field must hold one array.",
        ));
    }
    if let Some(Value::Array(intervals)) = performance.get("intervals") {
        for (index, item) in intervals.iter().enumerate() {
            let base = format!("/performance/intervals/{index}");
            let interval = expect_object(item, &base)?;
            reject_unknown_fields(
                interval,
                &[
                    "scope",
                    "metric",
                    "method",
                    "confidence_level",
                    "lower",
                    "upper",
                ],
                &base,
            )?;
            required_bounded_string(interval, "scope", &format!("{base}/scope"), 64)?;
            match interval.get("metric") {
                Some(Value::String(name)) if METRIC_NAMES.contains(&name.as_str()) => {}
                _ => {
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/metric"),
                        "The metric must name one metric of the published set.",
                    ));
                }
            }
            required_bounded_string(interval, "method", &format!("{base}/method"), 128)?;
            match interval.get("confidence_level") {
                Some(value) => {
                    let level = as_finite(value).ok_or_else(|| {
                        ValidationError::invalid_field_type(
                            format!("{base}/confidence_level"),
                            "The confidence level must hold 0.9, 0.95, or 0.99.",
                        )
                    })?;
                    if !CONFIDENCE_LEVELS.contains(&level) {
                        return Err(ValidationError::invalid_field_type(
                            format!("{base}/confidence_level"),
                            "The confidence level must hold 0.9, 0.95, or 0.99.",
                        ));
                    }
                }
                None => return Err(ValidationError::missing(format!("{base}/confidence_level"))),
            }
            let lower = required_number(interval, "lower", &base)?;
            let upper = required_number(interval, "upper", &base)?;
            for (name, value) in [("lower", lower), ("upper", upper)] {
                if !(0.0..=1.0).contains(&value) {
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/{name}"),
                        "The interval bound must hold one number from 0 to 1.",
                    ));
                }
            }
            if lower > upper {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/lower"),
                    "The lower bound must not exceed the upper bound.",
                ));
            }
        }
    } else if performance.get("intervals").is_some() {
        return Err(ValidationError::invalid_field_type(
            "/performance/intervals",
            "The intervals field must hold one array.",
        ));
    }
    if let Some(counts) = performance.get("sample_counts") {
        let counts = expect_object(counts, "/performance/sample_counts")?;
        for (name, count) in counts {
            if !count.is_number() {
                return Err(ValidationError::invalid_field_type(
                    format!("/performance/sample_counts/{name}"),
                    "Every sample count must hold one whole number of zero or more.",
                ));
            }
            required_whole(counts, name, "/performance/sample_counts", 0, None)?;
        }
    }
    if let Some(minimums) = performance.get("sample_minimums") {
        let minimums = expect_object(minimums, "/performance/sample_minimums")?;
        for (name, minimum) in minimums {
            if !minimum.is_number() {
                return Err(ValidationError::invalid_field_type(
                    format!("/performance/sample_minimums/{name}"),
                    "Every sample minimum must hold one whole number of zero or more.",
                ));
            }
            required_whole(minimums, name, "/performance/sample_minimums", 0, None)?;
        }
    }
    if let Some(Value::Array(limitations)) = performance.get("slice_limitations") {
        for (index, item) in limitations.iter().enumerate() {
            parse_bounded_string(
                Some(item),
                &format!("/performance/slice_limitations/{index}"),
                500,
                "Every slice limitation",
            )?;
        }
    } else if performance.get("slice_limitations").is_some() {
        return Err(ValidationError::invalid_field_type(
            "/performance/slice_limitations",
            "The slice limitations must hold one array of strings.",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Compatibility.
// ---------------------------------------------------------------------------

/// The live state of one evaluator binding, supplied by the host.
///
/// One entry states what one registered evaluator serves for one bound
/// check today: the adapter version, the live translated question, the
/// resolved model version, and the preprocessing identity. Every optional
/// part that the host cannot state stays absent, and one absent part is
/// not compared. The core resolves no model and reads no clock, so the
/// host owns every live value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveBinding {
    /// The bound check that this entry serves.
    pub check: String,
    /// The registered evaluator identifier.
    pub evaluator: String,
    /// The adapter version of the registered evaluator.
    pub adapter_version: String,
    /// The content hash of the live translated question, when the adapter
    /// states one.
    pub translation: Option<String>,
    /// The model version that the requested alias resolves to today, when
    /// the host states one.
    pub resolved_model: Option<String>,
    /// The preprocessing identity that applies today, when one applies.
    pub preprocessing: Option<String>,
}

/// Parses one array of live bindings from one strict JSON value.
///
/// The entries cross as data, because the core never sees an evaluator
/// object. One entry names one check once.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` when one entry
/// breaks its shape, and with `duplicate_id` when two entries name one
/// check.
pub fn parse_live_bindings(value: &Value, base: &str) -> Result<Vec<LiveBinding>, ValidationError> {
    let Value::Array(items) = value else {
        return Err(ValidationError::invalid_field_type(
            base.to_owned(),
            "The live bindings must hold one array.",
        ));
    };
    let mut parsed = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let entry_base = format!("{base}/{index}");
        let entry = expect_object(item, &entry_base)?;
        reject_unknown_fields(
            entry,
            &[
                "check",
                "evaluator",
                "adapter_version",
                "translation",
                "resolved_model",
                "preprocessing",
            ],
            &entry_base,
        )?;
        let binding = LiveBinding {
            check: required_artifact_id(entry, "check", &format!("{entry_base}/check"))?,
            evaluator: required_artifact_id(
                entry,
                "evaluator",
                &format!("{entry_base}/evaluator"),
            )?,
            adapter_version: required_bounded_string(
                entry,
                "adapter_version",
                &format!("{entry_base}/adapter_version"),
                64,
            )?,
            translation: match entry.get("translation") {
                None => None,
                Some(_) => Some(required_hash(
                    entry,
                    "translation",
                    &format!("{entry_base}/translation"),
                )?),
            },
            resolved_model: parse_bounded_string(
                entry.get("resolved_model"),
                &format!("{entry_base}/resolved_model"),
                128,
                "The resolved model version",
            )?,
            preprocessing: parse_bounded_string(
                entry.get("preprocessing"),
                &format!("{entry_base}/preprocessing"),
                128,
                "The preprocessing identity",
            )?,
        };
        if parsed
            .iter()
            .any(|earlier: &LiveBinding| earlier.check == binding.check)
        {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("{entry_base}/check"),
                format!(
                    "Two live bindings name the check {}.",
                    fragment(&binding.check)
                ),
            ));
        }
        parsed.push(binding);
    }
    Ok(parsed)
}

/// The requested use of one compatibility check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatibilityRequest {
    /// The run mode of the requested use. Shadow compares the bindings
    /// alone. Enforcement adds the scope, qualification, and selection
    /// clauses.
    pub mode: RunMode,
    /// The scope that the host requests, when it states one. Enforcement
    /// compares it with the declared scope of the profile.
    pub requested_scope: Option<String>,
    /// The reviewed profile content hash that the host selected, when it
    /// states one. Enforcement requires one selection, and the bound
    /// artifact must be the selected one.
    pub selected_hash: Option<String>,
}

/// Checks one validated profile against one loaded definition and the live
/// evaluator state.
///
/// The order is fixed, so one pairing reports one failure:
///
/// 1. An exact-only definition takes the structural exact profile, then the
///    definition reference. Every other definition checks the definition
///    reference first, then the policy family.
/// 2. Every binding compares its live state: one registered evaluator, the
///    bound adapter version, the preprocessing identity, the translated
///    question, and the resolved model version.
/// 3. The bindings cover every question check of the definition.
/// 4. The numerical policy covers every question check and fits it.
/// 5. Enforcement compares the declared scope, requires one profile
///    validated for scope, and requires the artifact that the host
///    selected by its reviewed content hash.
///
/// `base` is the JSON Pointer that failures report under, for example
/// `/profile` inside one load.
///
/// The check verifies content consistency. It cannot authenticate one
/// label, one population claim, or one host approval, and no outcome of
/// this function authorizes one application action.
///
/// # Errors
///
/// Returns a [`ValidationError`] with one compatibility reason code of the
/// registry when one material mismatch exists. Every failure happens
/// before any evaluator runs.
pub fn check_compatibility(
    profile: &ValidatedProfile,
    definition: &ValidatedDefinition,
    live: &[LiveBinding],
    request: &CompatibilityRequest,
    base: &str,
) -> Result<(), ValidationError> {
    let definition_hash = hashing::definition_hash(definition);
    let binds_definition = profile.definition_name() == definition.as_definition().name
        && profile.definition_hash() == definition_hash;

    if definition.is_exact_only() {
        // The structural rule of the exact family comes first: one profile
        // with evaluator bindings or one numerical family never fits one
        // exact-only definition, whatever definition it binds.
        let structural = profile.family() == PolicyFamily::Exact
            && profile.origin() == ProfileOrigin::Exact
            && profile.bindings().is_empty();
        if !structural {
            return Err(ValidationError::new(
                ReasonCode::PolicyMismatch,
                format!("{base}/policy"),
                "An exact-only definition takes the structural exact profile: origin exact, policy family exact, and no evaluator bindings.",
            ));
        }
        if !binds_definition {
            return Err(definition_mismatch(profile, base));
        }
    } else {
        if !binds_definition {
            return Err(definition_mismatch(profile, base));
        }
        if profile.family() == PolicyFamily::Exact || profile.origin() == ProfileOrigin::Exact {
            return Err(ValidationError::new(
                ReasonCode::PolicyMismatch,
                format!("{base}/policy"),
                "One definition with question checks takes one profile with evaluator bindings and the probability_mass_v0 family, not the exact profile.",
            ));
        }
        check_live_bindings(profile, definition, live, base)?;
        check_binding_coverage(profile, definition, base)?;
        check_policy_coverage(profile, definition, base)?;
    }

    if request.mode == RunMode::Enforcement {
        check_enforcement_gate(profile, request, base)?;
    }
    Ok(())
}

/// Builds the failure of one profile that binds another definition.
fn definition_mismatch(profile: &ValidatedProfile, base: &str) -> ValidationError {
    ValidationError::new(
        ReasonCode::DefinitionMismatch,
        format!("{base}/definition"),
        format!(
            "The profile binds the definition {} with one content hash of its own. The loaded definition differs, so the pairing changes the meaning that the profile measured. Bind the profile of this revision.",
            fragment(profile.definition_name())
        ),
    )
}

/// Compares every recorded binding against the live evaluator state.
fn check_live_bindings(
    profile: &ValidatedProfile,
    definition: &ValidatedDefinition,
    live: &[LiveBinding],
    base: &str,
) -> Result<(), ValidationError> {
    for (index, binding) in profile.bindings().iter().enumerate() {
        let binding_base = format!("{base}/bindings/{index}");
        let Some(entry) = live.iter().find(|entry| entry.check == binding.check) else {
            return Err(ValidationError::new(
                ReasonCode::EvaluatorMismatch,
                format!("{binding_base}/evaluator"),
                format!(
                    "The profile binds the evaluator {} for the check {}, but no registered evaluator serves it. Register the bound evaluator with its version. One loaded file installs no evaluator.",
                    fragment(&binding.evaluator),
                    fragment(&binding.check)
                ),
            ));
        };
        if definition.check_kind(&binding.check).is_none() {
            return Err(ValidationError::new(
                ReasonCode::EvaluatorMismatch,
                format!("{binding_base}/check"),
                format!(
                    "The binding names no check of the definition: {}.",
                    fragment(&binding.check)
                ),
            ));
        }
        if definition.check_kind(&binding.check) == Some(CheckKind::Rule) {
            return Err(ValidationError::new(
                ReasonCode::EvaluatorMismatch,
                format!("{binding_base}/check"),
                format!(
                    "The binding names one rule check: {}. Exact rules record their executed rule and take no evaluator.",
                    fragment(&binding.check)
                ),
            ));
        }
        if entry.evaluator != binding.evaluator {
            return Err(ValidationError::new(
                ReasonCode::EvaluatorMismatch,
                format!("{binding_base}/evaluator"),
                format!(
                    "The profile binds the evaluator {}, but the registered evaluator for this check is {}.",
                    fragment(&binding.evaluator),
                    fragment(&entry.evaluator)
                ),
            ));
        }
        if entry.adapter_version != binding.adapter_version {
            return Err(ValidationError::new(
                ReasonCode::EvaluatorMismatch,
                format!("{binding_base}/adapter_version"),
                format!(
                    "The profile binds the adapter version {} of the evaluator {}, but the registered adapter states {}. One changed version needs new qualification.",
                    fragment(&binding.adapter_version),
                    fragment(&binding.evaluator),
                    fragment(&entry.adapter_version)
                ),
            ));
        }
        if let (Some(bound), Some(current)) = (&binding.preprocessing, &entry.preprocessing) {
            if bound != current {
                return Err(ValidationError::new(
                    ReasonCode::EvaluatorMismatch,
                    format!("{binding_base}/preprocessing"),
                    format!(
                        "The profile records the preprocessing identity {}, but the live preprocessing is {}. One changed preprocessing invalidates the qualification.",
                        fragment(bound),
                        fragment(current)
                    ),
                ));
            }
        }
        if let Some(live_translation) = &entry.translation {
            if *live_translation != binding.translation_hash {
                return Err(ValidationError::new(
                    ReasonCode::TranslationMismatch,
                    format!("{binding_base}/translation/content_hash"),
                    format!(
                        "The profile records one translated question whose content hash differs from the live translation of the check {}. One changed translation changes the binding and needs new qualification.",
                        fragment(&binding.check)
                    ),
                ));
            }
        }
        if let (Some(bound), Some(current)) = (
            binding
                .model
                .as_ref()
                .and_then(|model| model.resolved.as_ref()),
            entry.resolved_model.as_ref(),
        ) {
            if bound != current {
                return Err(ValidationError::new(
                    ReasonCode::ModelResolutionChanged,
                    format!("{binding_base}/model/resolved"),
                    format!(
                        "The profile records the resolved model {}, but the requested alias resolves to {} today. One changed resolution invalidates the qualification.",
                        fragment(bound),
                        fragment(current)
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// Checks that the bindings cover every question check of the definition.
fn check_binding_coverage(
    profile: &ValidatedProfile,
    definition: &ValidatedDefinition,
    base: &str,
) -> Result<(), ValidationError> {
    for check in &definition.as_definition().checks {
        if definition.check_kind(&check.id) == Some(CheckKind::Rule) {
            continue;
        }
        let bound = profile
            .bindings()
            .iter()
            .any(|binding| binding.check == check.id);
        if !bound {
            return Err(ValidationError::new(
                ReasonCode::EvaluatorMismatch,
                format!("{base}/bindings"),
                format!(
                    "The profile binds no evaluator for the question check {}. One definition with question checks needs one binding per question check.",
                    fragment(&check.id)
                ),
            ));
        }
    }
    Ok(())
}

/// Checks that the numerical policy covers every question check and fits it.
fn check_policy_coverage(
    profile: &ValidatedProfile,
    definition: &ValidatedDefinition,
    base: &str,
) -> Result<(), ValidationError> {
    for (index, entry) in profile.policy_checks().iter().enumerate() {
        let entry_base = format!("{base}/policy/checks/{index}");
        match definition.check_kind(&entry.check) {
            None => {
                return Err(ValidationError::new(
                    ReasonCode::PolicyMismatch,
                    format!("{entry_base}/check"),
                    format!(
                        "The policy names no check of the definition: {}.",
                        fragment(&entry.check)
                    ),
                ));
            }
            Some(CheckKind::Rule) => {
                return Err(ValidationError::new(
                    ReasonCode::PolicyMismatch,
                    format!("{entry_base}/check"),
                    format!(
                        "The policy names one rule check: {}. One rule check records its executed rule and takes no decision policy.",
                        fragment(&entry.check)
                    ),
                ));
            }
            _ => {}
        }
        policy::validate_policy(definition, &entry.check, &entry.policy, &entry_base)?;
    }
    for check in &definition.as_definition().checks {
        if definition.check_kind(&check.id) == Some(CheckKind::Rule) {
            continue;
        }
        let covered = profile
            .policy_checks()
            .iter()
            .any(|entry| entry.check == check.id);
        if !covered {
            return Err(ValidationError::new(
                ReasonCode::PolicyMismatch,
                format!("{base}/policy/checks"),
                format!(
                    "The policy states no parameters for the question check {}. Every question check takes one policy entry.",
                    fragment(&check.id)
                ),
            ));
        }
    }
    Ok(())
}

/// Applies the enforcement clauses: the declared scope, the qualification,
/// and the host selection.
fn check_enforcement_gate(
    profile: &ValidatedProfile,
    request: &CompatibilityRequest,
    base: &str,
) -> Result<(), ValidationError> {
    if let Some(requested) = request.requested_scope.as_deref() {
        let (declared, path) = match profile.qualification_scope() {
            Some(scope) => (scope, format!("{base}/qualification/scope")),
            None => (profile.intended_use(), format!("{base}/intended_use")),
        };
        if declared != requested {
            return Err(ValidationError::new(
                ReasonCode::ScopeMismatch,
                path,
                "The declared scope of the profile differs from the requested use. Scope changes need new evidence; one hash cannot detect population drift.",
            ));
        }
    }
    if profile.qualification() != Qualification::ValidatedForScope {
        return Err(ValidationError::new(
            ReasonCode::QualificationInsufficient,
            format!("{base}/qualification/status"),
            format!(
                "The profile {} holds the qualification {}. Enforcement needs one profile validated for the declared scope.",
                fragment(profile.id()),
                profile.qualification().as_str()
            ),
        ));
    }
    // The selection clause closes the qualification model's gate: the host
    // selects one reviewed hash through its own code or configuration
    // review, and the library admits the selected artifact alone. The
    // clause authenticates nothing; the host review carries that trust.
    match request.selected_hash.as_deref() {
        None => {
            return Err(ValidationError::new(
                ReasonCode::ProfileNotSelected,
                format!("{base}/content_hash"),
                format!(
                    "Enforcement selects one profile through host review, and no selection crossed. State the reviewed content hash of the profile {} with the enforcement run.",
                    fragment(profile.id())
                ),
            ));
        }
        Some(selected) if selected != profile.content_hash() => {
            return Err(ValidationError::new(
                ReasonCode::ProfileNotSelected,
                format!("{base}/content_hash"),
                format!(
                    "The host selected the content hash {}, but the bound profile {} carries {}. Bind the selected artifact or select the bound hash through host review.",
                    fragment(selected),
                    fragment(profile.id()),
                    fragment(profile.content_hash())
                ),
            ));
        }
        _ => {}
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Retained qualification evidence.
// ---------------------------------------------------------------------------

/// The verified plan reference of one evidence check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidencePlanRow {
    /// Stable plan identifier, equal to the recorded identifier.
    pub id: String,
    /// Computed identity of the plan, equal to the recorded hash.
    pub content_hash: String,
}

/// The verified dataset reference of one evidence check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidenceDatasetRow {
    /// Stable dataset identifier, equal to the recorded identifier.
    pub id: String,
    /// Dataset revision, equal to the recorded revision.
    pub revision: String,
    /// Dataset kind, as the retained metadata states it.
    pub kind: String,
    /// Case records of the dataset.
    pub record_count: usize,
    /// Computed hash of the dataset records, equal to the recorded hash.
    pub content_hash: String,
}

/// One verified split reference of one evidence check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidenceSplitRow {
    /// Stable split identifier, as the profile records it.
    pub id: String,
    /// Fitting or validation, as the retained dataset declares the split.
    pub purpose: String,
    /// Groups of the split, in the declared order.
    pub groups: Vec<String>,
    /// Case records of the split.
    pub record_count: usize,
    /// Computed hash of the split records, equal to the recorded hash.
    pub content_hash: String,
}

/// The result of one evidence check over one selected profile.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EvidenceCheck {
    /// Stable profile identifier.
    pub profile_id: String,
    /// Verified self-hash of the profile artifact.
    pub profile_content_hash: String,
    /// Content hash of the definition that the profile and the plan bind.
    pub definition_hash: String,
    /// The retained plan, with the recorded identity.
    pub plan: EvidencePlanRow,
    /// The retained dataset, with the recorded identity.
    pub dataset: EvidenceDatasetRow,
    /// Every recorded split, with the identity of the retained dataset.
    pub splits: Vec<EvidenceSplitRow>,
    /// The evaluation-report references, as the profile records them.
    pub evaluation_reports: Vec<String>,
    /// What the check verified, with the counts it read.
    pub statement: String,
    /// The standing limits of this check.
    pub limitations: Vec<String>,
}

/// Checks the recorded evidence of one profile against the retained
/// artifacts.
///
/// The host owns the storage of the qualification evidence, so it states the
/// explicit locations of the retained artifacts: the plan text, the dataset
/// metadata text, and the dataset records text. The check verifies, in one
/// fixed order, that every recorded identity names the retained artifact:
///
/// 1. The profile artifact passes the complete contract and its stored
///    self-hash, and it records evidence at all.
/// 2. The retained plan carries the recorded identifier and the recorded
///    computed identity, and it binds the definition that the profile binds.
/// 3. The retained dataset carries the recorded identifier, revision, and
///    computed record hash.
/// 4. Every recorded split exists in the retained dataset and carries its
///    computed record hash, and the two dataset selections of the plan name
///    recorded splits of the declared purpose that share no group and no
///    case.
///
/// The comparison verifies content consistency alone. It cannot verify the
/// truth of a forged dataset, one label, or one population claim, and it
/// authenticates no host approval. The evaluation-report references name
/// host-managed storage; the check reads none, so one ignored folder can
/// hold no required copy of the evidence.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `missing_field` when the profile
/// records no complete evidence set, with `hash_mismatch` when one retained
/// artifact differs from the recorded identity, and with
/// `definition_mismatch` when the retained plan binds another definition
/// revision.
pub fn check_evidence(
    profile_text: &str,
    plan_text: &str,
    metadata_text: &str,
    records_text: &str,
) -> Result<EvidenceCheck, ValidationError> {
    let profile = validate_profile_str(profile_text)?;
    let root = profile.as_artifact();
    let no_evidence = || {
        ValidationError::new(
            ReasonCode::MissingField,
            "/evidence",
            format!(
                "The profile {} records no evidence. Only one calibration profile records the plan, the datasets, the splits, and the reports that this check verifies.",
                fragment(profile.id())
            ),
        )
    };
    let evidence = match root.get("evidence") {
        Some(value) => expect_object(value, "/evidence").map_err(|_| no_evidence())?,
        None => return Err(no_evidence()),
    };

    // The retained plan states its own identity, which the calibration
    // recorded. One edited plan keeps its identifier but changes its
    // computed identity, and one foreign plan changes both.
    let plan = crate::plan::validate_plan_str(plan_text)?;
    let recorded_plan = required_object(evidence, "plan", "/evidence")?;
    let recorded_plan_id = required_artifact_id(recorded_plan, "id", "/evidence/plan/id")?;
    let recorded_plan_hash =
        required_hash(recorded_plan, "content_hash", "/evidence/plan/content_hash")?;
    if recorded_plan_id != plan.id() {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/evidence/plan/id",
            format!(
                "The retained plan is {}. The profile records the plan {}. Retain the plan that the profile names.",
                fragment(plan.id()),
                fragment(&recorded_plan_id)
            ),
        ));
    }
    if recorded_plan_hash != plan.content_hash() {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/evidence/plan/content_hash",
            format!(
                "The retained plan {} computes the identity {}. The profile records {}. One edited plan is one new plan, so the retained copy is not the evidence of this profile.",
                fragment(plan.id()),
                fragment(plan.content_hash()),
                fragment(&recorded_plan_hash)
            ),
        ));
    }
    if plan.definition_hash() != profile.definition_hash() {
        return Err(ValidationError::new(
            ReasonCode::DefinitionMismatch,
            "/definition",
            "The retained plan binds another content hash of the definition. The profile measured one revision and the plan states another, so the two artifacts report different evidence. Retain the plan that the profile records.",
        ));
    }

    // The retained dataset states its identity through its records: the
    // loader computes the dataset hash and the split hashes from the loaded
    // content, so one edited record changes every identity that follows.
    let dataset = crate::dataset::load_dataset(metadata_text, records_text)?;
    let loaded = crate::splits::dataset_splits(&dataset)?;
    let identity = loaded.identity();
    let recorded_datasets = match evidence.get("datasets") {
        Some(Value::Array(items)) => items,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/evidence/datasets",
                "The datasets field must hold one array.",
            ));
        }
        None => {
            return Err(ValidationError::new(
                ReasonCode::MissingField,
                "/evidence/datasets",
                "A calibration profile records its datasets. The retained evidence needs one dataset at least.",
            ));
        }
    };
    if recorded_datasets.len() != 1 {
        return Err(ValidationError::invalid_field_type(
            "/evidence/datasets",
            format!(
                "The evidence check verifies one retained dataset, and the profile records {}. The calibration of one plan reads one dataset revision. Retain the dataset that the profile records.",
                recorded_datasets.len()
            ),
        ));
    }
    let recorded_dataset = expect_object(&recorded_datasets[0], "/evidence/datasets/0")?;
    let recorded_dataset_id =
        required_artifact_id(recorded_dataset, "id", "/evidence/datasets/0/id")?;
    let recorded_dataset_revision = required_bounded_string(
        recorded_dataset,
        "revision",
        "/evidence/datasets/0/revision",
        64,
    )?;
    let recorded_dataset_hash = required_hash(
        recorded_dataset,
        "content_hash",
        "/evidence/datasets/0/content_hash",
    )?;
    if recorded_dataset_id != identity.dataset_id {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/evidence/datasets/0/id",
            format!(
                "The retained dataset is {}. The profile records the dataset {}. Retain the dataset that the profile names.",
                fragment(&identity.dataset_id),
                fragment(&recorded_dataset_id)
            ),
        ));
    }
    if recorded_dataset_revision != identity.revision {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/evidence/datasets/0/revision",
            format!(
                "The retained dataset {} states the revision {}. The profile records {}. One changed revision is one new dataset, so the retained copy is not the evidence of this profile.",
                fragment(&identity.dataset_id),
                fragment(&identity.revision),
                fragment(&recorded_dataset_revision)
            ),
        ));
    }
    if recorded_dataset_hash != identity.content_hash {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/evidence/datasets/0/content_hash",
            format!(
                "The retained dataset {} revision {} computes the content hash {}. The profile records {}. One edited record changes the hash, so the retained records are not the evidence of this profile.",
                fragment(&identity.dataset_id),
                fragment(&identity.revision),
                fragment(&identity.content_hash),
                fragment(&recorded_dataset_hash)
            ),
        ));
    }

    // Every recorded split must exist in the retained dataset with the
    // recorded content, and the plan must name recorded splits for both of
    // its selections, so no retained set mixes two calibrations.
    let recorded_splits = match evidence.get("splits") {
        Some(Value::Array(items)) => items,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/evidence/splits",
                "The splits field must hold one array.",
            ));
        }
        None => {
            return Err(ValidationError::new(
                ReasonCode::MissingField,
                "/evidence/splits",
                "A calibration profile records its splits. The retained evidence needs the fitting split and the validation split.",
            ));
        }
    };
    let mut rows = Vec::with_capacity(recorded_splits.len());
    for (index, item) in recorded_splits.iter().enumerate() {
        let base = format!("/evidence/splits/{index}");
        let recorded = expect_object(item, &base)?;
        let recorded_id = required_artifact_id(recorded, "id", &format!("{base}/id"))?;
        let recorded_hash =
            required_hash(recorded, "content_hash", &format!("{base}/content_hash"))?;
        let Some(split) = loaded.split(&recorded_id) else {
            return Err(ValidationError::new(
                ReasonCode::HashMismatch,
                format!("{base}/id"),
                format!(
                    "The profile records the split {}, but the retained dataset {} declares no split of that identifier. Retain the dataset that the profile records.",
                    fragment(&recorded_id),
                    fragment(&identity.dataset_id)
                ),
            ));
        };
        let split_identity = split.identity();
        if recorded_hash != split_identity.content_hash {
            return Err(ValidationError::new(
                ReasonCode::HashMismatch,
                format!("{base}/content_hash"),
                format!(
                    "The retained split {} of the dataset {} computes the content hash {}. The profile records {}. One edited record changes the hash, so the retained split is not the evidence of this profile.",
                    fragment(&recorded_id),
                    fragment(&identity.dataset_id),
                    fragment(&split_identity.content_hash),
                    fragment(&recorded_hash)
                ),
            ));
        }
        rows.push(EvidenceSplitRow {
            id: split_identity.split_id.clone(),
            purpose: split_identity.purpose.as_str().to_owned(),
            groups: split_identity.groups.clone(),
            record_count: split_identity.record_count,
            content_hash: split_identity.content_hash.clone(),
        });
    }
    let recorded_split_ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    let fitting = plan_split(&plan, &loaded, "fitting")?;
    let validation = plan_split(&plan, &loaded, "validation")?;
    for (role, selection) in [("fitting", &fitting), ("validation", &validation)] {
        if !recorded_split_ids.contains(&selection.split_id.as_str()) {
            return Err(ValidationError::new(
                ReasonCode::MissingField,
                "/evidence/splits",
                format!(
                    "The plan names the split {} for the {} selection, but the profile records no split of that identifier. The retained evidence must cover every split that the plan measured.",
                    fragment(&selection.split_id),
                    role
                ),
            ));
        }
    }
    crate::plan::check_plan_datasets(&plan, &fitting, &validation, "/evidence")?;

    let evaluation_reports = match evidence.get("evaluation_reports") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str().map(str::to_owned).ok_or_else(|| {
                    ValidationError::invalid_field_type(
                        "/evidence/evaluation_reports",
                        "The evaluation-report references must hold one array of strings.",
                    )
                })
            })
            .collect::<Result<Vec<String>, ValidationError>>()?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/evidence/evaluation_reports",
                "The evaluation-report references must hold one array of strings.",
            ));
        }
        None => {
            return Err(ValidationError::new(
                ReasonCode::MissingField,
                "/evidence/evaluation_reports",
                "A calibration profile records its evaluation reports. The retained evidence needs the references of the reports in host storage.",
            ));
        }
    };

    let statement = format!(
        "The retained plan {}, the dataset {} revision {}, and {} recorded split(s) carry the identities that the profile {} records. The dataset holds {} case records.",
        fragment(plan.id()),
        fragment(&identity.dataset_id),
        fragment(&identity.revision),
        rows.len(),
        fragment(profile.id()),
        identity.record_count
    );
    Ok(EvidenceCheck {
        profile_id: profile.id().to_owned(),
        profile_content_hash: profile.content_hash().to_owned(),
        definition_hash: profile.definition_hash().to_owned(),
        plan: EvidencePlanRow {
            id: plan.id().to_owned(),
            content_hash: plan.content_hash().to_owned(),
        },
        dataset: EvidenceDatasetRow {
            id: identity.dataset_id.clone(),
            revision: identity.revision.clone(),
            kind: identity.kind.as_str().to_owned(),
            record_count: identity.record_count,
            content_hash: identity.content_hash.clone(),
        },
        splits: rows,
        evaluation_reports,
        statement,
        limitations: vec![
            "This check verifies content consistency. It cannot verify the truth of a forged dataset, one label, or one population claim, and it authenticates no host approval.".to_owned(),
            "The evaluation reports live in host storage at the recorded references. Retain one reviewed copy outside every folder that version control ignores, because one ignored report is no required copy of the qualification evidence.".to_owned(),
        ],
    })
}

/// Reads one dataset selection of one plan as the split identity that the
/// retained dataset computes.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `hash_mismatch` when the plan names a
/// split that the retained dataset does not declare.
fn plan_split(
    plan: &crate::plan::ValidatedPlan,
    loaded: &crate::splits::DatasetSplits<'_>,
    role: &str,
) -> Result<crate::splits::SplitIdentity, ValidationError> {
    let selection = match role {
        "fitting" => &plan.datasets().fitting,
        _ => &plan.datasets().validation,
    };
    let Some(split) = loaded.split(&selection.split) else {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            format!("/evidence/datasets/{role}/split"),
            format!(
                "The plan names the split {}, but the retained dataset declares no split of that identifier.",
                fragment(&selection.split)
            ),
        ));
    };
    Ok(split.identity().clone())
}

// ---------------------------------------------------------------------------
// Field readers.
// ---------------------------------------------------------------------------

/// Reads one required artifact identifier.
fn required_artifact_id(
    object: &Map<String, Value>,
    name: &str,
    path: &str,
) -> Result<String, ValidationError> {
    match object.get(name) {
        Some(Value::String(text)) if is_artifact_id(text) => Ok(text.clone()),
        Some(_) => Err(ValidationError::invalid_field_type(
            path,
            "The identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
        )),
        None => Err(ValidationError::missing(path)),
    }
}

/// Reads one required nonempty bounded string.
fn required_bounded_string(
    object: &Map<String, Value>,
    name: &str,
    path: &str,
    max: usize,
) -> Result<String, ValidationError> {
    parse_bounded_string(object.get(name), path, max, "The field")
        .and_then(|value| value.ok_or_else(|| ValidationError::missing(path)))
}

/// Reads one required content hash.
fn required_hash(
    object: &Map<String, Value>,
    name: &str,
    path: &str,
) -> Result<String, ValidationError> {
    match object.get(name) {
        Some(Value::String(text)) if hashing::is_hash_hex(text) => Ok(text.clone()),
        Some(_) => Err(ValidationError::invalid_field_type(
            path,
            "The content hash must hold 64 lowercase hexadecimal characters.",
        )),
        None => Err(ValidationError::missing(path)),
    }
}

/// Reads one required object field.
fn required_object<'a>(
    object: &'a Map<String, Value>,
    name: &str,
    base: &str,
) -> Result<&'a Map<String, Value>, ValidationError> {
    match object.get(name) {
        Some(value) => expect_object(value, &format!("{base}/{name}")),
        None => Err(ValidationError::missing(format!("{base}/{name}"))),
    }
}

/// Reads one required whole number inside its bounds.
fn required_whole(
    object: &Map<String, Value>,
    name: &str,
    base: &str,
    minimum: u64,
    maximum: Option<u64>,
) -> Result<u64, ValidationError> {
    let path = format!("{base}/{name}");
    let within = |value: u64| value >= minimum && maximum.map(|max| value <= max).unwrap_or(true);
    match object.get(name) {
        Some(Value::Number(number)) => {
            // A number with a fraction, such as 1.5, is not the integer
            // form. The gate does not coerce it.
            let Some(value) = number.as_u64().or_else(|| {
                number
                    .as_i64()
                    .and_then(|signed| u64::try_from(signed).ok())
            }) else {
                return Err(ValidationError::invalid_field_type(
                    path,
                    "The field must hold one whole number.",
                ));
            };
            if !within(value) {
                return Err(ValidationError::invalid_field_type(
                    path,
                    "The field holds one whole number outside its bounds.",
                ));
            }
            Ok(value)
        }
        Some(_) => Err(ValidationError::invalid_field_type(
            path,
            "The field must hold one whole number.",
        )),
        None => Err(ValidationError::missing(path)),
    }
}

/// Reads one required finite number.
fn required_number(
    object: &Map<String, Value>,
    name: &str,
    base: &str,
) -> Result<f64, ValidationError> {
    let path = format!("{base}/{name}");
    match object.get(name) {
        Some(value) => as_finite(value).ok_or_else(|| {
            ValidationError::invalid_field_type(path, "The field must hold one finite number.")
        }),
        None => Err(ValidationError::missing(path)),
    }
}

/// Returns one finite number, or `None` for any other value.
fn as_finite(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::definition::validate_definition_str;
    use serde_json::json;

    /// One 64-character hexadecimal digest of the right shape.
    const HASH_A: &str = "a5065efe5f955d002a550c9598efeb1217b0b402db10efda842f10682a2ec65b";
    /// One second digest of the right shape.
    const HASH_B: &str = "88c86b66dd45adbd34e4a409dd3a37a2cbe6f94990fefb35c7f0d97dcaf94970";

    /// The categorical question definition that the profiles below bind.
    const CATEGORICAL: &str = r#"{
        "schema_version": 1,
        "name": "message-supported",
        "inputs": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "minLength": 1},
                "evidence": {"type": "string", "minLength": 1}
            },
            "required": ["message", "evidence"],
            "additionalProperties": false
        },
        "checks": [{
            "id": "message-supported",
            "name": "Our message accurately describes the evidence",
            "using": ["message", "evidence"],
            "question": "Does every material claim in the proposed message follow from the evidence?",
            "answers": {
                "supported": "All claims follow from the evidence.",
                "contradicted": "One claim conflicts with the evidence.",
                "incomplete": "Support for one claim is missing."
            },
            "accept": "supported",
            "review": ["incomplete"]
        }]
    }"#;

    /// One binary question definition, for the confidence-floor rule.
    const BINARY: &str = r#"{
        "schema_version": 1,
        "name": "duplicate-concern",
        "inputs": {
            "type": "object",
            "properties": {"concern": {"type": "string", "minLength": 1}},
            "required": ["concern"],
            "additionalProperties": false
        },
        "checks": [{
            "id": "adds-information",
            "name": "The concern adds information",
            "using": ["concern"],
            "question": "Does the conversation already acknowledge this concern?",
            "answers": {"yes": "The concern is acknowledged.", "no": "The concern is new."},
            "accept": "no"
        }]
    }"#;

    /// One exact-only definition, for the structural exact profile.
    const EXACT_ONLY: &str = r#"{
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
            "rule": {"maxLength": 80}
        }]
    }"#;

    /// One definition with two question checks, for the coverage rules.
    const TWO_QUESTIONS: &str = r#"{
        "schema_version": 1,
        "name": "intervention",
        "inputs": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "minLength": 1},
                "evidence": {"type": "string", "minLength": 1}
            },
            "required": ["message", "evidence"],
            "additionalProperties": false
        },
        "checks": [{
            "id": "message-supported",
            "name": "Our message accurately describes the evidence",
            "using": ["message", "evidence"],
            "question": "Does every material claim in the proposed message follow from the evidence?",
            "answers": {
                "supported": "All claims follow from the evidence.",
                "contradicted": "One claim conflicts with the evidence.",
                "incomplete": "Support for one claim is missing."
            },
            "accept": "supported",
            "review": ["incomplete"]
        }, {
            "id": "adds-information",
            "name": "We are adding something new",
            "using": ["message", "evidence"],
            "question": "Does the conversation already acknowledge this concern?",
            "answers": {"yes": "It is acknowledged.", "no": "It is new."},
            "accept": "no"
        }]
    }"#;

    /// One validated definition of the stated text.
    fn validated(text: &str) -> ValidatedDefinition {
        validate_definition_str(text).expect("the test definition validates")
    }

    /// Builds one exploration profile that binds the categorical definition.
    fn exploration_artifact() -> Value {
        let bound = validated(CATEGORICAL);
        let mut artifact = json!({
            "schema_version": 1,
            "id": "message-supported-exploration",
            "origin": "exploration",
            "intended_use": "Development use in evaluation and shadow mode.",
            "definition": {
                "name": "message-supported",
                "content_hash": hashing::definition_hash(&bound)
            },
            "bindings": [{
                "check": "message-supported",
                "evaluator": "jev-choice",
                "adapter_version": "0.1.0",
                "translation": {
                    "content_hash": HASH_A,
                    "question": "Does every material claim in the proposed message follow from the evidence?"
                },
                "model": {"requested": "jev-1.13", "resolved": "jev-1.13-2026-09-01"},
                "preprocessing": "plain-v1"
            }],
            "policy": {
                "family": "probability_mass_v0",
                "checks": [{"check": "message-supported", "accept_cutoff": 0.75, "rejection_cutoff": 0.65}]
            },
            "execution": {
                "max_active": 4, "max_pending": 16, "deadline_ms": 30000,
                "max_attempts": 2, "backoff_ms": 200
            },
            "qualification": {
                "status": "unvalidated",
                "scope": "Development use in evaluation and shadow mode.",
                "reasons": ["starter_policy"]
            }
        });
        signed(&mut artifact);
        artifact
    }

    /// Builds one calibration profile with complete evidence.
    fn calibration_artifact() -> Value {
        let bound = validated(CATEGORICAL);
        let mut artifact = json!({
            "schema_version": 1,
            "id": "message-supported-validated",
            "origin": "calibration",
            "intended_use": "The pilot conversation population declared in the plan.",
            "definition": {
                "name": "message-supported",
                "content_hash": hashing::definition_hash(&bound)
            },
            "bindings": [{
                "check": "message-supported",
                "evaluator": "jev-choice",
                "adapter_version": "0.1.0",
                "translation": {
                    "content_hash": HASH_A,
                    "question": "Does every material claim in the proposed message follow from the evidence?"
                },
                "model": {"requested": "jev-1.13", "resolved": "jev-1.13-2026-09-01"},
                "preprocessing": "plain-v1"
            }],
            "policy": {
                "family": "probability_mass_v0",
                "checks": [{"check": "message-supported", "accept_cutoff": 0.8, "rejection_cutoff": 0.7}]
            },
            "execution": {
                "max_active": 4, "max_pending": 16, "deadline_ms": 30000,
                "max_attempts": 2, "backoff_ms": 200
            },
            "evidence": {
                "plan": {"id": "message-supported-plan", "content_hash": HASH_B},
                "datasets": [{
                    "id": "message-supported-cases",
                    "revision": "2026-09-23",
                    "content_hash": HASH_A
                }],
                "splits": [
                    {"id": "fitting", "content_hash": HASH_A},
                    {"id": "validation", "content_hash": HASH_B}
                ],
                "label_provenance": "Synthetic cases proposed by one agent, then human reviewed.",
                "evaluation_reports": ["reports/message-supported-validation.json"],
                "statistical_method": "Wilson score intervals at 95 percent confidence."
            },
            "performance": {
                "metrics": [{
                    "scope": "message-supported",
                    "metric": "error_among_accepted",
                    "numerator": 0,
                    "denominator": 80,
                    "value": 0
                }],
                "intervals": [{
                    "scope": "message-supported",
                    "metric": "error_among_accepted",
                    "method": "wilson_score",
                    "confidence_level": 0.95,
                    "lower": 0,
                    "upper": 0.0458
                }],
                "sample_counts": {"labeled_cases": 200, "accepted_cases": 80},
                "sample_minimums": {"labeled_cases": 200, "accepted_cases": 80},
                "slice_limitations": ["The later-corrections slice holds 31 labeled cases."]
            },
            "qualification": {
                "status": "validated_for_scope",
                "scope": "The pilot conversation population declared in the plan.",
                "reasons": ["measured_evidence"]
            }
        });
        signed(&mut artifact);
        artifact
    }

    /// Builds the structural exact profile of the exact-only definition.
    fn exact_artifact() -> Value {
        let bound = validated(EXACT_ONLY);
        let mut artifact = json!({
            "schema_version": 1,
            "id": "delivery-limits-exact",
            "origin": "exact",
            "intended_use": "Delivery limits in any population. Exact rules need no calibration.",
            "definition": {
                "name": "delivery-limits",
                "content_hash": hashing::definition_hash(&bound)
            },
            "bindings": [],
            "policy": {"family": "exact"},
            "execution": {
                "max_active": 4, "max_pending": 16, "deadline_ms": 30000,
                "max_attempts": 1, "backoff_ms": 0
            },
            "qualification": {
                "status": "validated_for_scope",
                "scope": "Any input that satisfies the definition schema.",
                "reasons": ["exact_rules_only"]
            }
        });
        signed(&mut artifact);
        artifact
    }

    /// Signs one artifact with its computed self-hash.
    fn signed(artifact: &mut Value) {
        let digest = hashing::compute_self_hash(Domain::Profile, artifact)
            .expect("the test artifact hashes");
        artifact["content_hash"] = Value::String(digest);
    }

    /// Validates one signed artifact and signs it again after one edit.
    fn resigned(edited: &Value) -> String {
        let mut copy = edited.clone();
        copy.as_object_mut()
            .expect("an object")
            .remove("content_hash");
        signed(&mut copy);
        serde_json::to_string(&copy).expect("serializes")
    }

    /// One live binding that matches the exploration profile.
    fn matching_live() -> Vec<LiveBinding> {
        vec![LiveBinding {
            check: "message-supported".to_owned(),
            evaluator: "jev-choice".to_owned(),
            adapter_version: "0.1.0".to_owned(),
            translation: Some(HASH_A.to_owned()),
            resolved_model: Some("jev-1.13-2026-09-01".to_owned()),
            preprocessing: Some("plain-v1".to_owned()),
        }]
    }

    /// One shadow request with no stated scope.
    fn shadow() -> CompatibilityRequest {
        CompatibilityRequest {
            mode: RunMode::Shadow,
            requested_scope: None,
            selected_hash: None,
        }
    }

    /// One enforcement request for the stated scope, with no host selection.
    fn enforcement(scope: Option<&str>) -> CompatibilityRequest {
        CompatibilityRequest {
            mode: RunMode::Enforcement,
            requested_scope: scope.map(str::to_owned),
            selected_hash: None,
        }
    }

    /// One enforcement request that selects the stated profile by its
    /// reviewed content hash.
    fn enforcement_of(scope: Option<&str>, profile: &ValidatedProfile) -> CompatibilityRequest {
        CompatibilityRequest {
            mode: RunMode::Enforcement,
            requested_scope: scope.map(str::to_owned),
            selected_hash: Some(profile.content_hash().to_owned()),
        }
    }

    /// The scope that the calibration artifact declares.
    const CALIBRATION_SCOPE: &str = "The pilot conversation population declared in the plan.";

    #[test]
    fn one_valid_exploration_profile_validates() {
        let text = serde_json::to_string(&exploration_artifact()).expect("serializes");
        let profile = validate_profile_str(&text).expect("the artifact validates");
        assert_eq!(profile.id(), "message-supported-exploration");
        assert_eq!(profile.origin(), ProfileOrigin::Exploration);
        assert_eq!(profile.family(), PolicyFamily::ProbabilityMassV0);
        assert_eq!(profile.qualification(), Qualification::Unvalidated);
        assert_eq!(profile.bindings().len(), 1);
        assert_eq!(profile.bindings()[0].translation_hash, HASH_A);
        assert_eq!(
            profile.bindings()[0]
                .model
                .as_ref()
                .and_then(|model| model.resolved.as_deref()),
            Some("jev-1.13-2026-09-01")
        );
        assert_eq!(
            profile.bindings()[0].preprocessing.as_deref(),
            Some("plain-v1")
        );
        assert_eq!(profile.policy_checks().len(), 1);
        // The artifact stays unchanged, self-hash included.
        assert_eq!(
            profile.as_artifact()["content_hash"],
            Value::String(profile.content_hash().to_owned())
        );
    }

    #[test]
    fn artifact_rejections_name_their_codes_and_paths() {
        let base = exploration_artifact();
        let rows: Vec<(&str, Value, ReasonCode, &str)> = vec![
            (
                "no identifier",
                {
                    let mut edited = base.clone();
                    edited.as_object_mut().unwrap().remove("id");
                    edited
                },
                ReasonCode::MissingField,
                "/id",
            ),
            (
                "one identifier outside the rule",
                {
                    let mut edited = base.clone();
                    edited["id"] = json!("Message Supported");
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/id",
            ),
            (
                "one credential field",
                {
                    let mut edited = base.clone();
                    edited["api_key"] = json!("sk-secret");
                    edited
                },
                ReasonCode::UnknownField,
                "/api_key",
            ),
            (
                "one raw case body",
                {
                    let mut edited = base.clone();
                    edited["case_content"] = json!({"message": "Private text."});
                    edited
                },
                ReasonCode::UnknownField,
                "/case_content",
            ),
            (
                "one unknown origin",
                {
                    let mut edited = base.clone();
                    edited["origin"] = json!("starter");
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/origin",
            ),
            (
                "one unknown status",
                {
                    let mut edited = base.clone();
                    edited["qualification"]["status"] = json!("trusted");
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/qualification/status",
            ),
            (
                "one exploration profile that claims one qualification",
                {
                    let mut edited = base.clone();
                    edited["qualification"]["status"] = json!("validated_for_scope");
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/qualification/status",
            ),
            (
                "no qualification reason",
                {
                    let mut edited = base.clone();
                    edited["qualification"]["reasons"] = json!([]);
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/qualification/reasons",
            ),
            (
                "one reason outside the registry",
                {
                    let mut edited = base.clone();
                    edited["qualification"]["reasons"] = json!(["not_a_code"]);
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/qualification/reasons/0",
            ),
            (
                "one exact profile with one binding",
                {
                    let mut edited = exact_artifact();
                    edited["bindings"] = json!([{
                        "check": "summary-length",
                        "evaluator": "jev-choice",
                        "adapter_version": "0.1.0",
                        "translation": {"content_hash": HASH_A, "question": "How long?"}
                    }]);
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/bindings/0",
            ),
            (
                "one exploration profile with the exact family",
                {
                    let mut edited = base.clone();
                    edited["policy"] = json!({"family": "exact"});
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/policy/family",
            ),
            (
                "one exact family with one checks list",
                {
                    let mut edited = exact_artifact();
                    edited["policy"] = json!({
                        "family": "exact",
                        "checks": [{"check": "summary-length", "accept_cutoff": 0.8, "rejection_cutoff": 0.7}]
                    });
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/policy/checks",
            ),
            (
                "one probability family without parameters",
                {
                    let mut edited = base.clone();
                    edited["policy"] = json!({"family": "probability_mass_v0"});
                    edited
                },
                ReasonCode::MissingField,
                "/policy/checks",
            ),
            (
                "one cutoff at one half",
                {
                    let mut edited = base.clone();
                    edited["policy"]["checks"][0]["accept_cutoff"] = json!(0.5);
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/policy/checks/0/accept_cutoff",
            ),
            (
                "one cutoff above one",
                {
                    let mut edited = base.clone();
                    edited["policy"]["checks"][0]["rejection_cutoff"] = json!(1.2);
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/policy/checks/0/rejection_cutoff",
            ),
            (
                "one policy entry per check",
                {
                    let mut edited = base.clone();
                    let mut checks = edited["policy"]["checks"].as_array().unwrap().clone();
                    checks.push(checks[0].clone());
                    edited["policy"]["checks"] = Value::Array(checks);
                    edited
                },
                ReasonCode::DuplicateId,
                "/policy/checks/1/check",
            ),
            (
                "one binding per check",
                {
                    let mut edited = base.clone();
                    let mut bindings = edited["bindings"].as_array().unwrap().clone();
                    bindings.push(bindings[0].clone());
                    edited["bindings"] = Value::Array(bindings);
                    edited
                },
                ReasonCode::DuplicateId,
                "/bindings/1/check",
            ),
            (
                "one malformed translation hash",
                {
                    let mut edited = base.clone();
                    edited["bindings"][0]["translation"]["content_hash"] = json!("digest");
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/bindings/0/translation/content_hash",
            ),
            (
                "one model without one requested alias",
                {
                    let mut edited = base.clone();
                    edited["bindings"][0]["model"] = json!({"resolved": "jev-1.13-2026-09-01"});
                    edited
                },
                ReasonCode::MissingField,
                "/bindings/0/model/requested",
            ),
            (
                "one attempt limit above the bound",
                {
                    let mut edited = base.clone();
                    edited["execution"]["max_attempts"] = json!(11);
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/execution/max_attempts",
            ),
            (
                "no execution configuration",
                {
                    let mut edited = base.clone();
                    edited.as_object_mut().unwrap().remove("execution");
                    edited
                },
                ReasonCode::MissingField,
                "/execution",
            ),
            (
                "one calibration profile without evidence",
                {
                    let mut edited = calibration_artifact();
                    edited.as_object_mut().unwrap().remove("evidence");
                    edited
                },
                ReasonCode::MissingField,
                "/evidence",
            ),
            (
                "one calibration profile with one incomplete evidence set",
                {
                    let mut edited = calibration_artifact();
                    edited["evidence"]
                        .as_object_mut()
                        .unwrap()
                        .remove("label_provenance");
                    edited
                },
                ReasonCode::MissingField,
                "/evidence/label_provenance",
            ),
            (
                "one calibration profile with no evaluation report",
                {
                    let mut edited = calibration_artifact();
                    edited["evidence"]["evaluation_reports"] = json!([]);
                    edited
                },
                ReasonCode::MissingField,
                "/evidence/evaluation_reports",
            ),
            (
                "one metric outside the published set",
                {
                    let mut edited = calibration_artifact();
                    edited["performance"]["metrics"][0]["metric"] = json!("accuracy");
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/performance/metrics/0/metric",
            ),
            (
                "one inverted interval",
                {
                    let mut edited = calibration_artifact();
                    edited["performance"]["intervals"][0]["lower"] = json!(0.9);
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/performance/intervals/0/lower",
            ),
            (
                "one unsupported confidence level",
                {
                    let mut edited = calibration_artifact();
                    edited["performance"]["intervals"][0]["confidence_level"] = json!(0.8);
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/performance/intervals/0/confidence_level",
            ),
            (
                "one negative sample count",
                {
                    let mut edited = calibration_artifact();
                    edited["performance"]["sample_counts"]["labeled_cases"] = json!(-1);
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/performance/sample_counts/labeled_cases",
            ),
            (
                "one fractional sample minimum",
                {
                    let mut edited = calibration_artifact();
                    edited["performance"]["sample_minimums"]["accepted_cases"] = json!(2.5);
                    edited
                },
                ReasonCode::InvalidFieldType,
                "/performance/sample_minimums/accepted_cases",
            ),
        ];
        for (note, edited, code, path) in rows {
            let text = resigned(&edited);
            let error = validate_profile_str(&text)
                .err()
                .unwrap_or_else(|| panic!("{note}: the artifact was accepted"));
            assert_eq!(error.code, code, "{note}: {error}");
            assert_eq!(error.field_path, path, "{note}: {error}");
            assert!(!error.message.is_empty(), "{note}");
        }
    }

    #[test]
    fn an_edited_or_corrupted_copy_fails_its_self_hash() {
        // A field edited after hashing keeps every rule but fails the digest.
        let mut edited = exploration_artifact();
        edited["intended_use"] = json!("Enforcement use, edited after hashing.");
        let text = serde_json::to_string(&edited).expect("serializes");
        let error = validate_profile_str(&text).expect_err("the edited copy fails");
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/content_hash");

        // A field defect reports its field first, not the stale digest: the
        // defect rows above resign their artifacts for exactly that reason.
        edited["qualification"]["status"] = json!("validated_for_scope");
        let text = serde_json::to_string(&edited).expect("serializes");
        let error = validate_profile_str(&text).expect_err("the defect reports first");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/qualification/status");

        // An absent digest is one missing field, and one moved digest fails.
        let mut absent = exploration_artifact();
        absent.as_object_mut().unwrap().remove("content_hash");
        let error = validate_profile_str(&serde_json::to_string(&absent).expect("serializes"))
            .expect_err("the absent digest fails");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/content_hash");
        let mut moved = exploration_artifact();
        moved["content_hash"] = json!("0".repeat(64));
        let error = validate_profile_str(&serde_json::to_string(&moved).expect("serializes"))
            .expect_err("the wrong digest fails");
        assert_eq!(error.code, ReasonCode::HashMismatch);
    }

    #[test]
    fn one_complete_calibration_profile_validates() {
        let text = serde_json::to_string(&calibration_artifact()).expect("serializes");
        let profile = validate_profile_str(&text).expect("the artifact validates");
        assert_eq!(profile.origin(), ProfileOrigin::Calibration);
        assert_eq!(profile.qualification(), Qualification::ValidatedForScope);
        assert_eq!(
            profile.qualification_scope(),
            Some("The pilot conversation population declared in the plan.")
        );
    }

    // -----------------------------------------------------------------------
    // The retained-evidence check.
    // -----------------------------------------------------------------------

    /// The retained artifacts of the evidence tests: one calibration
    /// profile, the plan it records, and the dataset that the plan measured.
    struct Retained {
        profile: String,
        plan: String,
        metadata: String,
        records: String,
    }

    /// One dataset metadata of the evidence tests: one fitting and one
    /// validation split over two conversation groups.
    fn evidence_metadata() -> String {
        serde_json::to_string(&json!({
            "schema_version": 1,
            "id": "evidence-cases",
            "name": "Evidence cases",
            "revision": "2026-09-24.1",
            "kind": "representative_sample",
            "intended_population": "Proposed messages in the reviewed support traffic.",
            "sampling_method": "Sampled at random from reviewed traffic of one week.",
            "label_guidelines": "See docs/labeling.md revision 3.",
            "splits": [
                {"id": "fitting", "purpose": "fitting", "groups": ["conversation-a"]},
                {"id": "holdout", "purpose": "validation", "groups": ["conversation-b"]}
            ]
        }))
        .expect("serializes")
    }

    /// One case record of the evidence tests.
    fn evidence_record(id: &str, group: &str) -> Value {
        json!({
            "id": id,
            "group": group,
            "input": {
                "message": "The export worker serves EU customers.",
                "evidence": "Customer exports stay in the EU."
            },
            "label": {"author_type": "human", "reviewed": true, "reviewer": "reviewer-1"}
        })
    }

    /// One plan artifact over the categorical definition and the evidence
    /// dataset.
    fn evidence_plan(definition_hash: String) -> String {
        serde_json::to_string(&json!({
            "schema_version": 1,
            "id": "message-supported-plan",
            "name": "Limit wrong messages, then minimize review",
            "definition": {"name": "message-supported", "content_hash": definition_hash},
            "intended_population": "Proposed messages in the reviewed support traffic.",
            "sampling_assumptions": "Cases grouped by conversation. Groups are independent draws.",
            "confidence_level": 0.95,
            "constraints": [{
                "metric": "error_among_accepted",
                "comparison": "at_most",
                "limit": 0.5,
                "basis": "observed_value"
            }],
            "objective": {"metric": "review_rate", "direction": "minimize"},
            "minimum_samples": {"accepted_cases": 2},
            "candidate_grid": {"accept_cutoffs": [0.6, 0.8], "rejection_cutoffs": [0.6]},
            "evaluator": {"evaluator": "jev-choice", "adapter_version": "0.1.0"},
            "datasets": {
                "fitting": {"dataset": "evidence-cases", "revision": "2026-09-24.1", "split": "fitting"},
                "validation": {"dataset": "evidence-cases", "revision": "2026-09-24.1", "split": "holdout"}
            }
        }))
        .expect("serializes")
    }

    /// Builds one retained evidence set and one calibration profile that
    /// records the computed identities of its artifacts.
    fn retained() -> Retained {
        let definition_hash = hashing::definition_hash(&validated(CATEGORICAL));
        let plan = evidence_plan(definition_hash);
        let metadata = evidence_metadata();
        let records = [
            evidence_record("fit-1", "conversation-a"),
            evidence_record("fit-2", "conversation-a"),
            evidence_record("hold-1", "conversation-b"),
            evidence_record("hold-2", "conversation-b"),
        ]
        .iter()
        .map(|record| serde_json::to_string(record).expect("serializes"))
        .collect::<Vec<String>>()
        .join("\n");

        let validated_plan =
            crate::plan::validate_plan_str(&plan).expect("the test plan validates");
        let dataset =
            crate::dataset::load_dataset(&metadata, &records).expect("the test dataset loads");
        let loaded = crate::splits::dataset_splits(&dataset).expect("the splits compute");
        let identity = loaded.identity();
        let fitting = loaded
            .split("fitting")
            .expect("the fitting split")
            .identity();
        let holdout = loaded
            .split("holdout")
            .expect("the holdout split")
            .identity();

        let mut profile = json!({
            "schema_version": 1,
            "id": "message-supported-calibrated",
            "origin": "calibration",
            "intended_use": "Proposed messages in the reviewed support traffic.",
            "definition": {"name": "message-supported", "content_hash": validated_plan.definition_hash()},
            "bindings": [{
                "check": "message-supported",
                "evaluator": "jev-choice",
                "adapter_version": "0.1.0",
                "translation": {
                    "content_hash": HASH_A,
                    "question": "Does every material claim in the proposed message follow from the evidence?"
                }
            }],
            "policy": {
                "family": "probability_mass_v0",
                "checks": [{"check": "message-supported", "accept_cutoff": 0.8, "rejection_cutoff": 0.6}]
            },
            "execution": {
                "max_active": 4, "max_pending": 16, "deadline_ms": 30000,
                "max_attempts": 2, "backoff_ms": 200
            },
            "evidence": {
                "plan": {"id": validated_plan.id(), "content_hash": validated_plan.content_hash()},
                "datasets": [{
                    "id": identity.dataset_id,
                    "revision": identity.revision,
                    "content_hash": identity.content_hash
                }],
                "splits": [
                    {"id": fitting.split_id, "content_hash": fitting.content_hash},
                    {"id": holdout.split_id, "content_hash": holdout.content_hash}
                ],
                "label_provenance": "Two reviewed human references per split. No model proposal.",
                "evaluation_reports": [".measuretwice/reports/message-supported-validation.json"],
                "statistical_method": "Wilson score intervals at 95 percent confidence over grouped cases."
            },
            "performance": {
                "metrics": [{
                    "scope": "message-supported",
                    "metric": "error_among_accepted",
                    "numerator": 0,
                    "denominator": 2,
                    "value": 0
                }],
                "sample_counts": {"accepted_cases": 2},
                "sample_minimums": {"accepted_cases": 2}
            },
            "qualification": {
                "status": "validated_for_scope",
                "scope": "Proposed messages in the reviewed support traffic.",
                "reasons": ["measured_evidence"]
            }
        });
        signed(&mut profile);
        Retained {
            profile: serde_json::to_string(&profile).expect("serializes"),
            plan,
            metadata,
            records,
        }
    }

    /// Runs one evidence check and expects the stated rejection.
    fn evidence_error(
        set: &Retained,
        plan: Option<String>,
        metadata: Option<String>,
        records: Option<String>,
    ) -> ValidationError {
        check_evidence(
            &set.profile,
            plan.as_deref().unwrap_or(&set.plan),
            metadata.as_deref().unwrap_or(&set.metadata),
            records.as_deref().unwrap_or(&set.records),
        )
        .expect_err("the retained set fails")
    }

    #[test]
    fn one_retained_set_verifies_against_the_recorded_identities() {
        let set = retained();
        let check = check_evidence(&set.profile, &set.plan, &set.metadata, &set.records)
            .expect("the retained evidence verifies");
        let plan = crate::plan::validate_plan_str(&set.plan).expect("the plan validates");
        assert_eq!(check.profile_id, "message-supported-calibrated");
        assert_eq!(check.plan.id, plan.id());
        assert_eq!(check.plan.content_hash, plan.content_hash());
        assert_eq!(check.dataset.id, "evidence-cases");
        assert_eq!(check.dataset.revision, "2026-09-24.1");
        assert_eq!(check.dataset.kind, "representative_sample");
        assert_eq!(check.dataset.record_count, 4);
        assert_eq!(check.splits.len(), 2);
        assert_eq!(check.splits[0].id, "fitting");
        assert_eq!(check.splits[0].purpose, "fitting");
        assert_eq!(check.splits[0].groups, vec!["conversation-a".to_owned()]);
        assert_eq!(check.splits[0].record_count, 2);
        assert_eq!(check.splits[1].id, "holdout");
        assert_eq!(check.splits[1].purpose, "validation");
        assert_eq!(check.evaluation_reports.len(), 1);
        assert!(
            check.statement.contains("evidence-cases"),
            "{}",
            check.statement
        );
        assert_eq!(check.limitations.len(), 2);
        // The check verifies content consistency, and the statement keeps
        // the counts it read beside the identities it compared.
        assert!(
            check.statement.contains("4 case records"),
            "{}",
            check.statement
        );
        assert!(check.limitations[1].contains("version control ignores"));
    }

    #[test]
    fn one_edited_plan_fails_its_recorded_identity() {
        let set = retained();
        // One edited limit keeps the identifier and changes the computed
        // identity, so the retained copy is one new plan.
        let edited = set.plan.replace("\"limit\":0.5", "\"limit\":0.4");
        assert_ne!(edited, set.plan);
        let error = evidence_error(&set, Some(edited), None, None);
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/evidence/plan/content_hash");
    }

    #[test]
    fn one_foreign_plan_fails_its_recorded_identifier() {
        let set = retained();
        let definition_hash = hashing::definition_hash(&validated(CATEGORICAL));
        let foreign = evidence_plan(definition_hash)
            .replace("\"message-supported-plan\"", "\"another-supported-plan\"");
        let error = evidence_error(&set, Some(foreign), None, None);
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/evidence/plan/id");
    }

    #[test]
    fn one_swapped_definition_binding_of_the_profile_fails() {
        let set = retained();
        // The retained plan stays the recorded plan, but the profile binds
        // another definition revision than the plan measured. The pairing
        // reports two evidences for two different requirements.
        let mut edited = serde_json::from_str::<Value>(&set.profile).expect("parses");
        edited["definition"]["content_hash"] = json!(HASH_B);
        let error = check_evidence(&resigned(&edited), &set.plan, &set.metadata, &set.records)
            .expect_err("the swapped definition fails");
        assert_eq!(error.code, ReasonCode::DefinitionMismatch);
        assert_eq!(error.field_path, "/definition");
    }

    #[test]
    fn one_edited_record_fails_the_dataset_identity() {
        let set = retained();
        let extra = format!(
            "{}\n{}",
            set.records,
            serde_json::to_string(&evidence_record("hold-3", "conversation-b"))
                .expect("serializes")
        );
        let error = evidence_error(&set, None, None, Some(extra));
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/evidence/datasets/0/content_hash");
    }

    #[test]
    fn one_revised_dataset_fails_its_recorded_revision() {
        let set = retained();
        let revised = set.metadata.replace("2026-09-24.1", "2026-09-24.2");
        let error = evidence_error(&set, None, Some(revised), None);
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/evidence/datasets/0/revision");
    }

    #[test]
    fn one_renamed_dataset_fails_its_recorded_identifier() {
        let set = retained();
        let renamed = set
            .metadata
            .replace("\"evidence-cases\"", "\"other-cases\"");
        let error = evidence_error(&set, None, Some(renamed), None);
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/evidence/datasets/0/id");
    }

    #[test]
    fn one_absent_split_fails_its_recorded_reference() {
        let set = retained();
        let mut edited = serde_json::from_str::<Value>(&set.profile).expect("parses");
        edited["evidence"]["splits"][1]["id"] = json!("holdout-two");
        let error = check_evidence(&resigned(&edited), &set.plan, &set.metadata, &set.records)
            .expect_err("the absent split fails");
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/evidence/splits/1/id");
    }

    #[test]
    fn one_missing_recorded_split_fails_the_plan_selection() {
        let set = retained();
        // The plan measures the holdout split, so one profile that records
        // the fitting split alone states an incomplete retained set.
        let mut edited = serde_json::from_str::<Value>(&set.profile).expect("parses");
        edited["evidence"]["splits"]
            .as_array_mut()
            .expect("an array")
            .remove(1);
        let error = check_evidence(&resigned(&edited), &set.plan, &set.metadata, &set.records)
            .expect_err("the incomplete evidence fails");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/evidence/splits");
    }

    #[test]
    fn one_profile_without_evidence_states_what_is_missing() {
        let set = retained();
        let error = check_evidence(
            &serde_json::to_string(&exploration_artifact()).expect("serializes"),
            &set.plan,
            &set.metadata,
            &set.records,
        )
        .expect_err("the exploration profile records no evidence");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/evidence");
    }

    #[test]
    fn one_matching_profile_passes_in_every_mode() {
        let profile =
            validate_profile_str(&resigned(&calibration_artifact())).expect("the artifact");
        let definition = validated(CATEGORICAL);
        let scope = "The pilot conversation population declared in the plan.";
        for request in [
            shadow(),
            // One enforcement request that selects this artifact, with and
            // without one stated scope.
            enforcement_of(None, &profile),
            enforcement_of(Some(scope), &profile),
        ] {
            check_compatibility(
                &profile,
                &definition,
                &matching_live(),
                &request,
                "/profile",
            )
            .unwrap_or_else(|error| panic!("{:?}: {error}", request.mode));
        }
    }

    #[test]
    fn one_changed_definition_fails_in_every_mode_with_definition_mismatch() {
        let profile =
            validate_profile_str(&resigned(&exploration_artifact())).expect("the artifact");
        // One changed wording, one changed schema, and one changed projection
        // each change the definition hash, so the profile binds another
        // revision.
        for note in [
            CATEGORICAL.replace(
                "follow from the evidence?",
                "follow from the supplied evidence?",
            ),
            CATEGORICAL.replace(
                "\"evidence\": {\"type\": \"string\", \"minLength\": 1}",
                "\"evidence\": {\"type\": \"string\", \"minLength\": 2}",
            ),
            CATEGORICAL.replace(
                "\"using\": [\"message\", \"evidence\"]",
                "\"using\": [\"message\"]",
            ),
        ] {
            let changed = validated(&note);
            let error =
                check_compatibility(&profile, &changed, &matching_live(), &shadow(), "/profile")
                    .expect_err("the changed definition fails");
            assert_eq!(
                error.code,
                ReasonCode::DefinitionMismatch,
                "{note}: {error}"
            );
            assert_eq!(error.field_path, "/profile/definition");
            // The same refusal holds for enforcement.
            let error = check_compatibility(
                &profile,
                &changed,
                &matching_live(),
                &enforcement(None),
                "/profile",
            )
            .expect_err("enforcement refuses too");
            assert_eq!(error.code, ReasonCode::DefinitionMismatch);
        }
    }

    #[test]
    fn the_policy_family_must_fit_the_definition_shape() {
        let question_definition = validated(CATEGORICAL);
        let exact_definition = validated(EXACT_ONLY);

        // One exact profile binds another definition first, so its family
        // never reaches the comparison against one question definition. The
        // definition reference decides, exactly as the wrapper does.
        let exact_profile =
            validate_profile_str(&resigned(&exact_artifact())).expect("the artifact");
        let error = check_compatibility(
            &exact_profile,
            &question_definition,
            &[],
            &shadow(),
            "/profile",
        )
        .expect_err("the exact profile fails");
        assert_eq!(error.code, ReasonCode::DefinitionMismatch);
        assert_eq!(error.field_path, "/profile/definition");

        // One numerical profile never fits one exact-only definition. The
        // structural rule fires before the definition reference.
        let numerical = validate_profile_str(&resigned(&exploration_artifact())).expect("hashes");
        let error = check_compatibility(&numerical, &exact_definition, &[], &shadow(), "/profile")
            .expect_err("the numerical profile fails");
        assert_eq!(error.code, ReasonCode::PolicyMismatch);
        assert_eq!(error.field_path, "/profile/policy");

        // The structural exact profile fits its definition and needs no
        // registered evaluator. Its structural basis satisfies the
        // qualification clause, and enforcement still needs the host
        // selection of its reviewed hash.
        check_compatibility(
            &exact_profile,
            &exact_definition,
            &[],
            &enforcement_of(None, &exact_profile),
            "/profile",
        )
        .expect("the structural exact profile fits");
        let error = check_compatibility(
            &exact_profile,
            &exact_definition,
            &[],
            &enforcement(None),
            "/profile",
        )
        .expect_err("one unselected exact profile cannot enforce");
        assert_eq!(error.code, ReasonCode::ProfileNotSelected);
    }

    #[test]
    fn the_policy_must_cover_and_fit_every_question_check() {
        let definition = validated(CATEGORICAL);

        // One policy entry that names no check of the definition.
        let mut edited = exploration_artifact();
        edited["policy"]["checks"][0]["check"] = json!("unknown-check");
        let unknown = validate_profile_str(&resigned(&edited)).expect("the artifact");
        let error = check_compatibility(
            &unknown,
            &definition,
            &matching_live(),
            &shadow(),
            "/profile",
        )
        .expect_err("the unknown check fails");
        assert_eq!(error.code, ReasonCode::PolicyMismatch);
        assert_eq!(error.field_path, "/profile/policy/checks/0/check");

        // One missing policy entry for one question check. Both checks stay
        // bound, so the binding coverage holds and the policy gap decides.
        let two_checks = validated(TWO_QUESTIONS);
        assert_eq!(two_checks.as_definition().checks.len(), 2);
        let mut bound = exploration_artifact();
        bound["id"] = json!("intervention-exploration");
        bound["definition"] = json!({
            "name": "intervention",
            "content_hash": hashing::definition_hash(&two_checks)
        });
        bound["bindings"] = json!([{
            "check": "message-supported",
            "evaluator": "jev-choice",
            "adapter_version": "0.1.0",
            "translation": {"content_hash": HASH_A, "question": "Follows from the evidence?"}
        }, {
            "check": "adds-information",
            "evaluator": "jev-noul",
            "adapter_version": "0.1.0",
            "translation": {"content_hash": HASH_A, "question": "Already acknowledged?"}
        }]);
        bound["policy"]["checks"] = json!([{
            "check": "adds-information",
            "accept_cutoff": 0.8,
            "rejection_cutoff": 0.7
        }]);
        let half_covered = validate_profile_str(&resigned(&bound)).expect("the artifact");
        let half_live = vec![
            LiveBinding {
                check: "message-supported".to_owned(),
                evaluator: "jev-choice".to_owned(),
                adapter_version: "0.1.0".to_owned(),
                translation: Some(HASH_A.to_owned()),
                resolved_model: None,
                preprocessing: None,
            },
            LiveBinding {
                check: "adds-information".to_owned(),
                evaluator: "jev-noul".to_owned(),
                adapter_version: "0.1.0".to_owned(),
                translation: Some(HASH_A.to_owned()),
                resolved_model: None,
                preprocessing: None,
            },
        ];
        let error = check_compatibility(
            &half_covered,
            &two_checks,
            &half_live,
            &shadow(),
            "/profile",
        )
        .expect_err("the uncovered check fails");
        assert_eq!(error.code, ReasonCode::PolicyMismatch);
        assert_eq!(error.field_path, "/profile/policy/checks");
        assert!(error.message.contains("message-supported"), "{error}");

        // One confidence floor on one binary check fits no definition,
        // because Noul reports no confidence.
        let binary_definition = validated(BINARY);
        let mut bound = exploration_artifact();
        bound["id"] = json!("duplicate-concern-exploration");
        bound["definition"] = json!({
            "name": "duplicate-concern",
            "content_hash": hashing::definition_hash(&binary_definition)
        });
        bound["bindings"] = json!([{
            "check": "adds-information",
            "evaluator": "jev-noul",
            "adapter_version": "0.1.0",
            "translation": {"content_hash": HASH_A, "question": "Already acknowledged?"}
        }]);
        bound["policy"]["checks"] = json!([{
            "check": "adds-information",
            "accept_cutoff": 0.8,
            "rejection_cutoff": 0.7,
            "confidence_floor": 0.7
        }]);
        let floored = validate_profile_str(&resigned(&bound)).expect("the artifact");
        let live = vec![LiveBinding {
            check: "adds-information".to_owned(),
            evaluator: "jev-noul".to_owned(),
            adapter_version: "0.1.0".to_owned(),
            translation: Some(HASH_A.to_owned()),
            resolved_model: None,
            preprocessing: None,
        }];
        let error = check_compatibility(&floored, &binary_definition, &live, &shadow(), "/profile")
            .expect_err("the binary floor fails");
        assert_eq!(error.code, ReasonCode::PolicyMismatch);
        assert_eq!(
            error.field_path, "/profile/policy/checks/0/confidence_floor",
            "{}",
            error
        );
    }

    #[test]
    fn the_evaluator_bindings_must_match_the_registry() {
        let definition = validated(CATEGORICAL);
        let profile =
            validate_profile_str(&resigned(&exploration_artifact())).expect("the artifact");

        // No registered evaluator serves the bound check.
        let error = check_compatibility(&profile, &definition, &[], &shadow(), "/profile")
            .expect_err("the unregistered evaluator fails");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch);
        assert_eq!(error.field_path, "/profile/bindings/0/evaluator");
        assert!(error.message.contains("jev-choice"), "{error}");

        // One changed adapter version.
        let changed = vec![LiveBinding {
            check: "message-supported".to_owned(),
            evaluator: "jev-choice".to_owned(),
            adapter_version: "0.2.0".to_owned(),
            translation: Some(HASH_A.to_owned()),
            resolved_model: Some("jev-1.13-2026-09-01".to_owned()),
            preprocessing: Some("plain-v1".to_owned()),
        }];
        let error = check_compatibility(&profile, &definition, &changed, &shadow(), "/profile")
            .expect_err("the changed version fails");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch);
        assert_eq!(error.field_path, "/profile/bindings/0/adapter_version");
        assert!(error.message.contains("0.1.0"), "{error}");
        assert!(error.message.contains("0.2.0"), "{error}");

        // One registered evaluator under another identifier.
        let rebound = vec![LiveBinding {
            check: "message-supported".to_owned(),
            evaluator: "label-only-test".to_owned(),
            adapter_version: "0.1.0".to_owned(),
            translation: None,
            resolved_model: None,
            preprocessing: None,
        }];
        let error = check_compatibility(&profile, &definition, &rebound, &shadow(), "/profile")
            .expect_err("the rebound identifier fails");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch);
        assert_eq!(error.field_path, "/profile/bindings/0/evaluator");

        // One binding that names no check of the definition, and one that
        // names one rule check.
        let exact_definition = validated(EXACT_ONLY);
        let error = check_compatibility(
            &profile,
            &exact_definition,
            &matching_live(),
            &shadow(),
            "/profile",
        )
        .expect_err("the exact-only definition refuses the numerical profile");
        assert_eq!(error.code, ReasonCode::PolicyMismatch);
        let mut edited = exploration_artifact();
        edited["bindings"][0]["check"] = json!("summary-length");
        let on_rule = validate_profile_str(&resigned(&edited)).expect("the artifact");
        let on_rule_live = vec![LiveBinding {
            check: "summary-length".to_owned(),
            evaluator: "jev-choice".to_owned(),
            adapter_version: "0.1.0".to_owned(),
            translation: None,
            resolved_model: None,
            preprocessing: None,
        }];
        let error =
            check_compatibility(&on_rule, &definition, &on_rule_live, &shadow(), "/profile")
                .expect_err("the rule binding fails");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch);
        assert_eq!(error.field_path, "/profile/bindings/0/check");

        // One profile that binds no evaluator for one question check.
        let mut edited = exploration_artifact();
        edited["bindings"] = json!([]);
        let unbound = validate_profile_str(&resigned(&edited)).expect("validates alone");
        let error = check_compatibility(&unbound, &definition, &[], &shadow(), "/profile")
            .expect_err("the missing binding fails");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch);
        assert_eq!(error.field_path, "/profile/bindings");
        assert!(error.message.contains("message-supported"), "{error}");
    }

    #[test]
    fn one_changed_translation_or_preprocessing_changes_the_binding() {
        let definition = validated(CATEGORICAL);
        let profile =
            validate_profile_str(&resigned(&exploration_artifact())).expect("the artifact");

        // One live translated question whose hash differs.
        let reframed = vec![LiveBinding {
            check: "message-supported".to_owned(),
            evaluator: "jev-choice".to_owned(),
            adapter_version: "0.1.0".to_owned(),
            translation: Some(HASH_B.to_owned()),
            resolved_model: Some("jev-1.13-2026-09-01".to_owned()),
            preprocessing: Some("plain-v1".to_owned()),
        }];
        let error = check_compatibility(&profile, &definition, &reframed, &shadow(), "/profile")
            .expect_err("the changed translation fails");
        assert_eq!(error.code, ReasonCode::TranslationMismatch);
        assert_eq!(
            error.field_path, "/profile/bindings/0/translation/content_hash",
            "{error}"
        );

        // One changed preprocessing identity.
        let preprocessed = vec![LiveBinding {
            check: "message-supported".to_owned(),
            evaluator: "jev-choice".to_owned(),
            adapter_version: "0.1.0".to_owned(),
            translation: Some(HASH_A.to_owned()),
            resolved_model: Some("jev-1.13-2026-09-01".to_owned()),
            preprocessing: Some("normalized-v2".to_owned()),
        }];
        let error =
            check_compatibility(&profile, &definition, &preprocessed, &shadow(), "/profile")
                .expect_err("the changed preprocessing fails");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch);
        assert_eq!(error.field_path, "/profile/bindings/0/preprocessing");

        // One adapter that states no live translation and no preprocessing
        // cannot be compared on those parts, and the pairing holds.
        let silent = vec![LiveBinding {
            check: "message-supported".to_owned(),
            evaluator: "jev-choice".to_owned(),
            adapter_version: "0.1.0".to_owned(),
            translation: None,
            resolved_model: None,
            preprocessing: None,
        }];
        check_compatibility(&profile, &definition, &silent, &shadow(), "/profile")
            .expect("one silent adapter states nothing to compare");
    }

    #[test]
    fn one_changed_model_resolution_invalidates_the_binding() {
        let definition = validated(CATEGORICAL);
        let profile =
            validate_profile_str(&resigned(&calibration_artifact())).expect("the artifact");

        // The alias resolves to another model today.
        let drifted = vec![LiveBinding {
            check: "message-supported".to_owned(),
            evaluator: "jev-choice".to_owned(),
            adapter_version: "0.1.0".to_owned(),
            translation: Some(HASH_A.to_owned()),
            resolved_model: Some("jev-1.14-2026-10-01".to_owned()),
            preprocessing: Some("plain-v1".to_owned()),
        }];
        for request in [shadow(), enforcement(None)] {
            let error = check_compatibility(&profile, &definition, &drifted, &request, "/profile")
                .expect_err("the drifted resolution fails");
            assert_eq!(error.code, ReasonCode::ModelResolutionChanged);
            assert_eq!(error.field_path, "/profile/bindings/0/model/resolved");
            assert!(error.message.contains("jev-1.14-2026-10-01"), "{error}");
        }

        // One host that states no resolution compares nothing, and one
        // binding that records none compares nothing either.
        let mut edited = calibration_artifact();
        edited["bindings"][0]["model"] = json!({"requested": "jev-1.13"});
        let unrecorded = validate_profile_str(&resigned(&edited)).expect("the artifact");
        check_compatibility(
            &unrecorded,
            &definition,
            &matching_live(),
            &shadow(),
            "/profile",
        )
        .expect("one unrecorded resolution compares nothing");
    }

    #[test]
    fn enforcement_compares_the_declared_scope() {
        let definition = validated(CATEGORICAL);
        let profile =
            validate_profile_str(&resigned(&calibration_artifact())).expect("the artifact");
        let scope = "The pilot conversation population declared in the plan.";

        // One requested scope that the profile does not declare.
        let error = check_compatibility(
            &profile,
            &definition,
            &matching_live(),
            &enforcement(Some("One other population.")),
            "/profile",
        )
        .expect_err("the foreign scope fails");
        assert_eq!(error.code, ReasonCode::ScopeMismatch);
        assert_eq!(error.field_path, "/profile/qualification/scope");

        // The declared scope satisfies the clause.
        check_compatibility(
            &profile,
            &definition,
            &matching_live(),
            &enforcement_of(Some(scope), &profile),
            "/profile",
        )
        .expect("the declared scope fits");

        // One profile that states no qualification scope declares its use
        // through the intended-use field.
        let mut edited = calibration_artifact();
        edited["qualification"]
            .as_object_mut()
            .unwrap()
            .remove("scope");
        let unscoped = validate_profile_str(&resigned(&edited)).expect("the artifact");
        check_compatibility(
            &unscoped,
            &definition,
            &matching_live(),
            &enforcement_of(Some(CALIBRATION_SCOPE), &unscoped),
            "/profile",
        )
        .expect("the intended use satisfies the request");
        let error = check_compatibility(
            &unscoped,
            &definition,
            &matching_live(),
            &enforcement(Some("One other population.")),
            "/profile",
        )
        .expect_err("the intended use refuses the foreign scope");
        assert_eq!(error.code, ReasonCode::ScopeMismatch);
        assert_eq!(error.field_path, "/profile/intended_use");
    }

    #[test]
    fn enforcement_needs_one_validated_profile_in_every_other_respect() {
        let definition = validated(CATEGORICAL);
        let exploration =
            validate_profile_str(&resigned(&exploration_artifact())).expect("the artifact");
        let error = check_compatibility(
            &exploration,
            &definition,
            &matching_live(),
            &enforcement(None),
            "/profile",
        )
        .expect_err("one unvalidated profile cannot enter enforcement");
        assert_eq!(error.code, ReasonCode::QualificationInsufficient);
        assert_eq!(error.field_path, "/profile/qualification/status");
        // The same profile runs in shadow mode.
        check_compatibility(
            &exploration,
            &definition,
            &matching_live(),
            &shadow(),
            "/profile",
        )
        .expect("shadow admits one compatible unvalidated profile");

        // One calibration profile that fell short of the goals.
        let mut edited = calibration_artifact();
        edited["qualification"]["status"] = json!("criteria_not_met");
        let not_met = validate_profile_str(&resigned(&edited)).expect("the artifact");
        let error = check_compatibility(
            &not_met,
            &definition,
            &matching_live(),
            &enforcement(None),
            "/profile",
        )
        .expect_err("criteria not met refuses enforcement");
        assert_eq!(error.code, ReasonCode::QualificationInsufficient);
    }

    #[test]
    fn enforcement_requires_the_profile_that_the_host_selected() {
        let definition = validated(CATEGORICAL);
        let profile =
            validate_profile_str(&resigned(&calibration_artifact())).expect("the artifact");

        // No selection crossed: the gate refuses before any evaluator runs,
        // whatever the qualification of the artifact.
        let error = check_compatibility(
            &profile,
            &definition,
            &matching_live(),
            &enforcement(Some(CALIBRATION_SCOPE)),
            "/profile",
        )
        .expect_err("enforcement without one selection fails");
        assert_eq!(error.code, ReasonCode::ProfileNotSelected);
        assert_eq!(error.field_path, "/profile/content_hash");
        assert!(error.message.contains("no selection crossed"), "{error}");

        // One selection of another hash names another artifact, not this
        // one. The sanitized cause truncates both digests, so the check
        // reads their visible prefixes.
        let mut foreign = enforcement_of(Some(CALIBRATION_SCOPE), &profile);
        foreign.selected_hash = Some(HASH_B.to_owned());
        let error = check_compatibility(
            &profile,
            &definition,
            &matching_live(),
            &foreign,
            "/profile",
        )
        .expect_err("one foreign selection fails");
        assert_eq!(error.code, ReasonCode::ProfileNotSelected);
        assert_eq!(error.field_path, "/profile/content_hash");
        assert!(error.message.contains(&HASH_B[..32]), "{error}");

        // The selected hash admits the validated profile.
        check_compatibility(
            &profile,
            &definition,
            &matching_live(),
            &enforcement_of(Some(CALIBRATION_SCOPE), &profile),
            "/profile",
        )
        .expect("the selected hash admits the artifact");

        // The clauses keep their order: the scope and the qualification
        // refuse before the selection, so one refusal names its own clause.
        let error = check_compatibility(
            &profile,
            &definition,
            &matching_live(),
            &enforcement_of(Some("One other population."), &profile),
            "/profile",
        )
        .expect_err("the scope refuses first");
        assert_eq!(error.code, ReasonCode::ScopeMismatch);
        let mut edited = calibration_artifact();
        edited["qualification"]["status"] = json!("insufficient_evidence");
        let weak = validate_profile_str(&resigned(&edited)).expect("the artifact");
        let error = check_compatibility(
            &weak,
            &definition,
            &matching_live(),
            &enforcement_of(Some(CALIBRATION_SCOPE), &weak),
            "/profile",
        )
        .expect_err("the qualification refuses first");
        assert_eq!(error.code, ReasonCode::QualificationInsufficient);

        // Shadow states no gate, so one selection changes nothing there.
        let mut shadow_selected = shadow();
        shadow_selected.selected_hash = Some(HASH_B.to_owned());
        check_compatibility(
            &profile,
            &definition,
            &matching_live(),
            &shadow_selected,
            "/profile",
        )
        .expect("shadow ignores the selection");
    }

    #[test]
    fn every_status_admits_shadow_and_only_validated_admits_enforcement() {
        let definition = validated(CATEGORICAL);
        // One artifact per qualification status. The exploration origin
        // stays unvalidated, so the other statuses use the calibration
        // artifact with one edited status.
        let rows: [(&str, String); 4] = [
            (
                "unvalidated",
                serde_json::to_string(&exploration_artifact()).expect("serializes"),
            ),
            ("insufficient_evidence", {
                let mut edited = calibration_artifact();
                edited["qualification"]["status"] = json!("insufficient_evidence");
                resigned(&edited)
            }),
            ("criteria_not_met", {
                let mut edited = calibration_artifact();
                edited["qualification"]["status"] = json!("criteria_not_met");
                resigned(&edited)
            }),
            (
                "validated_for_scope",
                serde_json::to_string(&calibration_artifact()).expect("serializes"),
            ),
        ];
        for (word, text) in rows {
            let profile = validate_profile_str(&text).expect("the artifact validates");
            assert_eq!(profile.qualification().as_str(), word);
            // Shadow, the admission that evaluation reuses, admits every
            // compatible profile whatever its status.
            check_compatibility(
                &profile,
                &definition,
                &matching_live(),
                &shadow(),
                "/profile",
            )
            .unwrap_or_else(|error| panic!("{word}: {error}"));
            // Enforcement admits the validated status alone, and it needs
            // the host selection of the artifact. The exploration profile
            // declares another scope, so its request states none: the
            // qualification clause must refuse before any selection
            // question.
            let scope = match word {
                "unvalidated" => None,
                _ => Some(CALIBRATION_SCOPE),
            };
            let outcome = check_compatibility(
                &profile,
                &definition,
                &matching_live(),
                &enforcement_of(scope, &profile),
                "/profile",
            );
            match word {
                "validated_for_scope" => {
                    outcome.unwrap_or_else(|error| panic!("{word}: {error}"));
                }
                _ => {
                    let error = outcome.expect_err("only one validated profile enforces");
                    assert_eq!(error.code, ReasonCode::QualificationInsufficient, "{word}");
                }
            }
        }
    }

    #[test]
    fn content_consistency_authenticates_no_label_or_approval() {
        // One forged calibration profile that states validated_for_scope
        // over invented evidence passes every structural check and the
        // enforcement gate. The gate verifies content consistency only:
        // one hash binds one artifact to itself, never one dataset to the
        // truth. The host review owns that trust, and no profile grants an
        // application action.
        let mut forged = calibration_artifact();
        forged["id"] = json!("forged-validated");
        forged["evidence"]["datasets"][0]["content_hash"] = json!(HASH_B.to_owned());
        let profile = validate_profile_str(&resigned(&forged)).expect("the forgery validates");
        check_compatibility(
            &profile,
            &validated(CATEGORICAL),
            &matching_live(),
            &enforcement_of(Some(CALIBRATION_SCOPE), &profile),
            "/profile",
        )
        .expect("the gate reports content consistency, never authenticity");
    }

    #[test]
    fn live_bindings_parse_with_their_own_contract() {
        let value = json!([
            {
                "check": "message-supported",
                "evaluator": "jev-choice",
                "adapter_version": "0.1.0",
                "translation": HASH_A,
                "resolved_model": "jev-1.13-2026-09-01",
                "preprocessing": "plain-v1"
            }
        ]);
        let parsed = parse_live_bindings(&value, "/live").expect("the entry parses");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].translation.as_deref(), Some(HASH_A));
        assert_eq!(
            parsed[0].resolved_model.as_deref(),
            Some("jev-1.13-2026-09-01")
        );

        for (note, value, code, path) in [
            (
                "not one array",
                json!({"check": "message-supported"}),
                ReasonCode::InvalidFieldType,
                "/live",
            ),
            (
                "one unknown field",
                json!([{"check": "c", "evaluator": "e", "adapter_version": "1", "client": "x"}]),
                ReasonCode::UnknownField,
                "/live/0/client",
            ),
            (
                "one malformed hash",
                json!([{
                    "check": "message-supported",
                    "evaluator": "jev-choice",
                    "adapter_version": "0.1.0",
                    "translation": "digest"
                }]),
                ReasonCode::InvalidFieldType,
                "/live/0/translation",
            ),
            (
                "one repeated check",
                json!([
                    {"check": "c", "evaluator": "e", "adapter_version": "1"},
                    {"check": "c", "evaluator": "e", "adapter_version": "1"}
                ]),
                ReasonCode::DuplicateId,
                "/live/1/check",
            ),
        ] {
            let error = parse_live_bindings(&value, "/live")
                .err()
                .unwrap_or_else(|| panic!("{note}: the value was accepted"));
            assert_eq!(error.code, code, "{note}: {error}");
            assert_eq!(error.field_path, path, "{note}: {error}");
        }
    }
}
