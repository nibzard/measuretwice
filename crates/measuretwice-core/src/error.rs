// SPDX-License-Identifier: Apache-2.0
//! Stable typed errors for contract validation.
//!
//! Every rejection at the Rust boundary carries a reason code from the
//! stable registry in `contracts/README.md`, a JSON Pointer to the rejected
//! field, and a short sanitized cause. A cause holds no credentials and no
//! raw case content. [`fragment`] truncates every echoed name.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Reason codes from the stable registry in `contracts/README.md`.
///
/// A code keeps its meaning across releases. Codes are never renamed. The
/// string form of every variant matches the registry exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasonCode {
    // Validation reasons, reported before execution.
    /// The data is not valid JSON.
    InvalidJson,
    /// The artifact states an unsupported `schema_version`.
    UnsupportedSchemaVersion,
    /// The artifact has a field outside its contract.
    UnknownField,
    /// A required field is absent.
    MissingField,
    /// A field has the wrong type or an invalid value.
    InvalidFieldType,
    /// Two artifacts or checks share one identifier.
    DuplicateId,
    /// A selected answer label or level does not exist.
    UnknownLabel,
    /// `using` names an input that is not declared.
    UnknownInputName,
    /// The accept and review sets are not disjoint.
    AcceptReviewOverlap,
    /// The scale is empty, short, or has duplicate levels.
    InvalidScale,
    /// The definition has no checks.
    EmptyCheckSet,
    /// The input schema uses a keyword outside the supported subset.
    UnsupportedKeyword,
    /// Authoring produced a value that JSON cannot preserve.
    NonportableValue,
    /// A stored self-hash differs from the computed digest.
    HashMismatch,
    /// An input or evidence item exceeds its published limit.
    OversizedInput,
    /// A path names YAML or TypeScript source, which loaders do not accept.
    UnsupportedFormat,
    // Execution reasons, reported in check records.
    /// The evaluator reported an operational failure.
    EvaluatorError,
    /// One attempt exceeded its attempt budget.
    EvaluatorTimeout,
    /// The evaluator response did not match the assessment contract.
    InvalidAssessment,
    /// All attempts failed. The last reason is kept.
    RetriesExhausted,
    /// The total run deadline passed.
    DeadlineExceeded,
    /// The caller cancelled the run.
    RunCancelled,
    /// A result arrived after a terminal state.
    LateResultRejected,
    /// An event does not fit the run state.
    InvalidStateTransition,
    // Skip reasons, reported in check records.
    /// The pending-work limit stopped this check from starting.
    QueueFull,
    /// The run was cancelled before this check started.
    CancelledBeforeStart,
    /// The deadline passed before this check started.
    DeadlineBeforeStart,
    // Compatibility reasons, reported before execution.
    /// The profile binds a different definition hash.
    DefinitionMismatch,
    /// A bound evaluator is not registered, or its version differs.
    EvaluatorMismatch,
    /// The translated question hash differs.
    TranslationMismatch,
    /// A model alias resolved to a different version.
    ModelResolutionChanged,
    /// The policy family or parameters do not fit the definition.
    PolicyMismatch,
    /// The declared scope differs from the requested use.
    ScopeMismatch,
    /// Enforcement needs a validated profile.
    QualificationInsufficient,
    // Qualification reasons, recorded in profiles.
    /// The profile uses starter thresholds without qualification evidence.
    StarterPolicy,
    /// The qualification rests on recorded evaluation evidence.
    MeasuredEvidence,
    /// The qualification rests on exact rules.
    ExactRulesOnly,
    // Statistics reasons, reported in evaluation and calibration results.
    /// A denominator or sample requirement is not met.
    InsufficientEvidence,
    /// A rate has no value because its denominator is zero.
    ZeroDenominator,
    /// The interval method does not support the declared sampling.
    UnsupportedSampling,
    /// No feasible candidate satisfied the plan constraints.
    CriteriaNotMet,
}

impl ReasonCode {
    /// Returns the stable registry string of this code.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::UnsupportedSchemaVersion => "unsupported_schema_version",
            Self::UnknownField => "unknown_field",
            Self::MissingField => "missing_field",
            Self::InvalidFieldType => "invalid_field_type",
            Self::DuplicateId => "duplicate_id",
            Self::UnknownLabel => "unknown_label",
            Self::UnknownInputName => "unknown_input_name",
            Self::AcceptReviewOverlap => "accept_review_overlap",
            Self::InvalidScale => "invalid_scale",
            Self::EmptyCheckSet => "empty_check_set",
            Self::UnsupportedKeyword => "unsupported_keyword",
            Self::NonportableValue => "nonportable_value",
            Self::HashMismatch => "hash_mismatch",
            Self::OversizedInput => "oversized_input",
            Self::UnsupportedFormat => "unsupported_format",
            Self::EvaluatorError => "evaluator_error",
            Self::EvaluatorTimeout => "evaluator_timeout",
            Self::InvalidAssessment => "invalid_assessment",
            Self::RetriesExhausted => "retries_exhausted",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::RunCancelled => "run_cancelled",
            Self::LateResultRejected => "late_result_rejected",
            Self::InvalidStateTransition => "invalid_state_transition",
            Self::QueueFull => "queue_full",
            Self::CancelledBeforeStart => "cancelled_before_start",
            Self::DeadlineBeforeStart => "deadline_before_start",
            Self::DefinitionMismatch => "definition_mismatch",
            Self::EvaluatorMismatch => "evaluator_mismatch",
            Self::TranslationMismatch => "translation_mismatch",
            Self::ModelResolutionChanged => "model_resolution_changed",
            Self::PolicyMismatch => "policy_mismatch",
            Self::ScopeMismatch => "scope_mismatch",
            Self::QualificationInsufficient => "qualification_insufficient",
            Self::StarterPolicy => "starter_policy",
            Self::MeasuredEvidence => "measured_evidence",
            Self::ExactRulesOnly => "exact_rules_only",
            Self::InsufficientEvidence => "insufficient_evidence",
            Self::ZeroDenominator => "zero_denominator",
            Self::UnsupportedSampling => "unsupported_sampling",
            Self::CriteriaNotMet => "criteria_not_met",
        }
    }
}

impl ReasonCode {
    /// Returns the code of one registry string, or `None` for any other text.
    ///
    /// The deserializer is the one authority, so a new variant becomes
    /// readable here without a second list to keep in step.
    pub fn from_registry(text: &str) -> Option<Self> {
        serde_json::from_str::<Self>(&serde_json::to_string(text).expect("a string serializes"))
            .ok()
    }
}

impl fmt::Display for ReasonCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One typed validation failure at the Rust boundary.
///
/// The field path is a JSON Pointer, as RFC 6901 defines it. An empty path
/// means that the whole document is rejected. The message is a short
/// sanitized cause, never a copy of the rejected data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationError {
    /// Stable reason code from the registry.
    pub code: ReasonCode,
    /// Short sanitized cause. It holds no credentials and no raw case content.
    pub message: String,
    /// JSON Pointer to the rejected field. Empty means the whole document.
    pub field_path: String,
}

impl ValidationError {
    /// Builds one validation failure.
    pub fn new(
        code: ReasonCode,
        field_path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            field_path: field_path.into(),
        }
    }

    /// Builds a `missing_field` failure for one path.
    pub fn missing(field_path: impl Into<String>) -> Self {
        Self::new(
            ReasonCode::MissingField,
            field_path,
            "The artifact omits this required field.",
        )
    }

    /// Builds an `invalid_field_type` failure for one path.
    pub fn invalid_field_type(field_path: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ReasonCode::InvalidFieldType, field_path, message)
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)?;
        if !self.field_path.is_empty() {
            write!(formatter, " (at {})", self.field_path)?;
        }
        Ok(())
    }
}

impl std::error::Error for ValidationError {}

/// Truncates one echoed name so that a cause stays short and safe.
///
/// A field name is metadata, not case content, so a cause may echo it. A
/// hostile artifact can still place a long or noisy name in a field key, so
/// this function cuts every echo to 60 characters.
pub(crate) fn fragment(text: &str) -> String {
    const LIMIT: usize = 60;
    if text.chars().count() <= LIMIT {
        return format!("{text:?}");
    }
    let mut cut: String = text.chars().take(LIMIT).collect();
    cut.push_str("...");
    format!("{cut:?}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_matches_the_registry_string() {
        let expected = [
            ("invalid_json", ReasonCode::InvalidJson),
            (
                "unsupported_schema_version",
                ReasonCode::UnsupportedSchemaVersion,
            ),
            ("unknown_field", ReasonCode::UnknownField),
            ("missing_field", ReasonCode::MissingField),
            ("invalid_field_type", ReasonCode::InvalidFieldType),
            ("duplicate_id", ReasonCode::DuplicateId),
            ("unknown_label", ReasonCode::UnknownLabel),
            ("unknown_input_name", ReasonCode::UnknownInputName),
            ("accept_review_overlap", ReasonCode::AcceptReviewOverlap),
            ("invalid_scale", ReasonCode::InvalidScale),
            ("empty_check_set", ReasonCode::EmptyCheckSet),
            ("unsupported_keyword", ReasonCode::UnsupportedKeyword),
            ("nonportable_value", ReasonCode::NonportableValue),
            ("hash_mismatch", ReasonCode::HashMismatch),
            ("oversized_input", ReasonCode::OversizedInput),
            ("unsupported_format", ReasonCode::UnsupportedFormat),
            ("evaluator_error", ReasonCode::EvaluatorError),
            ("evaluator_timeout", ReasonCode::EvaluatorTimeout),
            ("invalid_assessment", ReasonCode::InvalidAssessment),
            ("retries_exhausted", ReasonCode::RetriesExhausted),
            ("deadline_exceeded", ReasonCode::DeadlineExceeded),
            ("run_cancelled", ReasonCode::RunCancelled),
            ("late_result_rejected", ReasonCode::LateResultRejected),
            (
                "invalid_state_transition",
                ReasonCode::InvalidStateTransition,
            ),
            ("queue_full", ReasonCode::QueueFull),
            ("cancelled_before_start", ReasonCode::CancelledBeforeStart),
            ("deadline_before_start", ReasonCode::DeadlineBeforeStart),
            ("definition_mismatch", ReasonCode::DefinitionMismatch),
            ("evaluator_mismatch", ReasonCode::EvaluatorMismatch),
            ("translation_mismatch", ReasonCode::TranslationMismatch),
            (
                "model_resolution_changed",
                ReasonCode::ModelResolutionChanged,
            ),
            ("policy_mismatch", ReasonCode::PolicyMismatch),
            ("scope_mismatch", ReasonCode::ScopeMismatch),
            (
                "qualification_insufficient",
                ReasonCode::QualificationInsufficient,
            ),
            ("starter_policy", ReasonCode::StarterPolicy),
            ("measured_evidence", ReasonCode::MeasuredEvidence),
            ("exact_rules_only", ReasonCode::ExactRulesOnly),
            ("insufficient_evidence", ReasonCode::InsufficientEvidence),
            ("zero_denominator", ReasonCode::ZeroDenominator),
            ("unsupported_sampling", ReasonCode::UnsupportedSampling),
            ("criteria_not_met", ReasonCode::CriteriaNotMet),
        ];
        for (text, code) in expected {
            assert_eq!(code.as_str(), text);
            assert_eq!(code.to_string(), text);
            assert_eq!(ReasonCode::from_registry(text), Some(code));
            let serialized = serde_json::to_string(&code).expect("serializes");
            assert_eq!(serialized, format!("\"{text}\""));
            let parsed: ReasonCode = serde_json::from_str(&serialized).expect("parses");
            assert_eq!(parsed, code);
        }
        // Every registry string is distinct.
        let texts: Vec<&str> = expected.iter().map(|(text, _)| *text).collect();
        let unique: std::collections::HashSet<&str> = texts.iter().copied().collect();
        assert_eq!(unique.len(), texts.len());
        // A text outside the registry names no code.
        assert_eq!(ReasonCode::from_registry("not_a_code"), None);
        assert_eq!(ReasonCode::from_registry(""), None);
    }

    #[test]
    fn the_error_serializes_with_code_message_and_path() {
        let error = ValidationError::new(
            ReasonCode::UnknownField,
            "/evaluator",
            "The definition has a field outside its contract.",
        );
        let value = serde_json::to_value(&error).expect("serializes");
        assert_eq!(value["code"], "unknown_field");
        assert_eq!(value["field_path"], "/evaluator");
        assert_eq!(
            value["message"],
            "The definition has a field outside its contract."
        );
        let text = error.to_string();
        assert!(text.starts_with("unknown_field: "), "{text}");
        assert!(text.ends_with("(at /evaluator)"), "{text}");
    }

    #[test]
    fn fragments_are_truncated_and_quoted() {
        assert_eq!(fragment("evaluator"), "\"evaluator\"");
        let long = "x".repeat(200);
        let cut = fragment(&long);
        assert_eq!(cut.len(), 60 + 3 + 2);
        assert!(cut.ends_with("...\""));
    }
}
