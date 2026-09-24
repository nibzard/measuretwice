// SPDX-License-Identifier: Apache-2.0
//! Semantic validation of one assessment against the check that asked for
//! it.
//!
//! The report boundary in [`report`] checks the structural assessment
//! contract: known fields, the field that each answer kind requires and
//! forbids, the mass and confidence ranges, and the evidence entry shape.
//! That boundary cannot see the check, so it cannot judge meaning. This
//! module owns the semantic half: the assessment must fit the check that
//! produced the request, as `contracts/README.md` states.
//!
//! The rules:
//!
//! - The stated identifier names one question check of the definition. One
//!   rule check accepts no assessment, because it records its executed rule.
//! - The assessment kind matches the check kind: named answers give
//!   `categorical`, the answers `yes` and `no` give `binary`, and one scale
//!   gives `ordered`.
//! - A selected label or level is one declared answer or level of the check.
//! - One reported position stays inside the scale range, from the first
//!   level at zero to the last level. The recorded spelling never rounds.
//! - One distribution names declared answers or levels only, and its masses
//!   sum to one within a published tolerance. One distribution is one
//!   measurement input, never one calibrated probability of correctness.
//! - One evidence reference names one input that the `using` list of the
//!   check authorizes. Supplied source references stay case inputs.
//!
//! Every failure reports [`ReasonCode::InvalidAssessment`], because the value
//! is one evaluator response that did not match the assessment contract of
//! its check. The message and the JSON Pointer of the underlying rule stay,
//! so the adapter can name the defect. An optional measurement that the
//! evaluator did not report stays absent; this module adds no field and
//! invents no measurement.

use crate::definition::{CheckKind, ValidatedDefinition};
use crate::error::{ReasonCode, ValidationError};
use crate::report;
use serde_json::Value;

/// The greatest distance between one summed distribution and one.
///
/// Binary64 addition of several reported masses sits many orders of
/// magnitude below this bound. One honest distribution cannot miss it, and
/// one invented or truncated distribution cannot pass as honest.
const MASS_SUM_TOLERANCE: f64 = 1e-6;

/// Validates one assessment against the question check that requested it.
///
/// The definition must already be validated, because the check meaning comes
/// from it. The assessment value is the record the evaluator returned, as it
/// will appear inside the run report.
///
/// # Errors
///
/// Returns a [`ValidationError`] with [`ReasonCode::InvalidAssessment`] when
/// the identifier names no question check, when the assessment breaks the
/// structural contract, or when it breaks one semantic rule above.
pub fn validate_assessment(
    definition: &ValidatedDefinition,
    check_id: &str,
    assessment: &Value,
) -> Result<(), ValidationError> {
    let check = definition
        .as_definition()
        .checks
        .iter()
        .find(|check| check.id == check_id)
        .ok_or_else(|| invalid("/check", "The identifier names no check of the definition."))?;
    match definition
        .check_kind(check_id)
        .expect("the check was found")
    {
        CheckKind::Rule => Err(invalid(
            "/check",
            "One rule check accepts no assessment. It records its executed rule.",
        )),
        CheckKind::Categorical => {
            let answers = check
                .answers
                .as_ref()
                .expect("one categorical check declares answers");
            validate_against(
                assessment,
                &check.using,
                answers.keys().map(String::as_str),
                "categorical",
            )
        }
        CheckKind::Binary => validate_against(
            assessment,
            &check.using,
            ["yes", "no"].into_iter(),
            "binary",
        ),
        CheckKind::Ordered => {
            let scale = check
                .scale
                .as_ref()
                .expect("one ordered check declares a scale");
            validate_against(
                assessment,
                &check.using,
                scale.iter().map(|level| level.name.as_str()),
                "ordered",
            )
        }
    }
}

/// Runs the structural boundary and the semantic rules against one name set.
///
/// `names` lists the declared answers or levels of the check.
/// `expected_kind` is the answer kind of the check, which the assessment
/// kind must equal and which fixes the rules that apply.
fn validate_against<'a>(
    assessment: &Value,
    using: &[String],
    names: impl Iterator<Item = &'a str>,
    expected_kind: &str,
) -> Result<(), ValidationError> {
    report::check_assessment(assessment, "/assessment").map_err(|error| {
        invalid(
            &error.field_path,
            &format!(
                "The assessment breaks the assessment contract: {}",
                error.message
            ),
        )
    })?;
    let map = assessment
        .as_object()
        .expect("the boundary checked an object");
    let kind = map.get("kind").and_then(Value::as_str).expect("checked");
    let declared: Vec<&str> = names.collect();

    // The assessment kind follows the check shape exactly: one scale gives
    // `ordered`, one answer set gives `categorical` or `binary`.
    if kind != expected_kind {
        return Err(invalid(
            "/assessment/kind",
            "The assessment kind does not match the question of the check.",
        ));
    }

    // The selected answer names one declared answer or level.
    match kind {
        "categorical" => {
            let label = map
                .get("label")
                .and_then(Value::as_str)
                .expect("the boundary checked the label");
            if !declared.contains(&label) {
                return Err(invalid(
                    "/assessment/label",
                    "The selected label names no declared answer of the check.",
                ));
            }
        }
        "ordered" => {
            let level = map
                .get("level")
                .and_then(Value::as_str)
                .expect("the boundary checked the level");
            if !declared.contains(&level) {
                return Err(invalid(
                    "/assessment/level",
                    "The selected level names no declared level of the check.",
                ));
            }
            if let Some(position) = map.get("position").and_then(Value::as_f64) {
                let last = declared.len() as f64 - 1.0;
                if !(0.0..=last).contains(&position) {
                    return Err(invalid(
                        "/assessment/position",
                        "The reported position sits outside the scale range.",
                    ));
                }
            }
        }
        _ => {}
    }

    // One distribution names declared answers or levels, and its masses sum
    // to one.
    if let Some(Value::Array(entries)) = map.get("distribution") {
        let mut sum = 0.0f64;
        for (index, entry) in entries.iter().enumerate() {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .expect("the boundary checked the name");
            if !declared.contains(&name) {
                return Err(invalid(
                    &format!("/assessment/distribution/{index}/name"),
                    "The distribution names one answer or level that the check does not declare.",
                ));
            }
            sum += entry
                .get("mass")
                .and_then(Value::as_f64)
                .expect("the boundary checked the mass");
        }
        if (sum - 1.0).abs() > MASS_SUM_TOLERANCE {
            return Err(invalid(
                "/assessment/distribution",
                "The distribution masses do not sum to one.",
            ));
        }
    }

    // One evidence reference names one authorized input of the `using` list.
    if let Some(Value::Array(entries)) = map.get("evidence") {
        for (index, entry) in entries.iter().enumerate() {
            let input = entry
                .get("input")
                .and_then(Value::as_str)
                .expect("the boundary checked the input");
            if !using.iter().any(|authorized| authorized == input) {
                return Err(invalid(
                    &format!("/assessment/evidence/{index}/input"),
                    "The evidence names one input that the using list of the check does not authorize.",
                ));
            }
        }
    }
    Ok(())
}

/// Builds one `invalid_assessment` failure with one pointer and one cause.
fn invalid(field_path: &str, message: &str) -> ValidationError {
    ValidationError::new(ReasonCode::InvalidAssessment, field_path, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One definition with one categorical, one binary, one ordered, and one
    /// rule check, so every semantic rule has its check.
    fn definition() -> ValidatedDefinition {
        let artifact = json!({
            "schema_version": 1,
            "name": "assessment-rules",
            "inputs": {
                "type": "object",
                "properties": {
                    "prior_decision": {"type": "string", "minLength": 1},
                    "conversation": {"type": "string", "minLength": 1},
                    "proposed_message": {"type": "string", "minLength": 1}
                },
                "required": ["prior_decision", "conversation", "proposed_message"],
                "additionalProperties": false
            },
            "checks": [
                {
                    "id": "message-supported",
                    "name": "Our message accurately describes the evidence",
                    "using": ["prior_decision", "conversation", "proposed_message"],
                    "question": "Does every claim follow from the evidence?",
                    "answers": {
                        "supported": "All claims are supported.",
                        "contradicted": "One claim conflicts with the evidence.",
                        "incomplete": "Support for one claim is missing."
                    },
                    "accept": "supported",
                    "review": "incomplete"
                },
                {
                    "id": "adds-information",
                    "name": "We are adding something new",
                    "using": ["conversation", "proposed_message"],
                    "question": "Has the conversation acknowledged this concern?",
                    "answers": {
                        "yes": "One participant recognizes the concern.",
                        "no": "No message recognizes the concern."
                    },
                    "accept": "no"
                },
                {
                    "id": "consequence",
                    "name": "The concern warrants one interruption",
                    "using": ["prior_decision", "conversation", "proposed_message"],
                    "question": "What consequence does the concern have?",
                    "scale": [
                        {"minor": "No identified consequence."},
                        {"meaningful": "One coordination problem."},
                        {"serious": "One conflict with one commitment."}
                    ],
                    "accept": {"at_least": "meaningful"}
                },
                {
                    "id": "message-length",
                    "name": "The message fits the delivery limit",
                    "using": ["proposed_message"],
                    "rule": {"maxLength": 900}
                }
            ]
        });
        crate::definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates")
    }

    #[test]
    fn one_assessment_of_each_kind_validates_against_its_check() {
        let definition = definition();
        for (check, assessment) in [
            (
                "message-supported",
                json!({"kind": "categorical", "label": "supported"}),
            ),
            ("adds-information", json!({"kind": "binary", "value": true})),
            (
                "consequence",
                json!({"kind": "ordered", "level": "meaningful", "position": 1.5}),
            ),
            (
                "message-supported",
                json!({
                    "kind": "categorical",
                    "label": "supported",
                    "distribution": [
                        {"name": "supported", "mass": 0.82},
                        {"name": "incomplete", "mass": 0.18}
                    ],
                    "confidence": 0.9,
                    "evidence": [
                        {"input": "prior_decision", "reference": "decision-2026-03"}
                    ]
                }),
            ),
        ] {
            validate_assessment(&definition, check, &assessment)
                .unwrap_or_else(|error| panic!("{check}: {error}"));
        }
    }

    #[test]
    fn the_identifier_and_kind_must_name_one_question_check() {
        let definition = definition();
        for (check, assessment, path) in [
            (
                "unknown-check",
                json!({"kind": "categorical", "label": "supported"}),
                "/check",
            ),
            (
                "message-length",
                json!({"kind": "categorical", "label": "supported"}),
                "/check",
            ),
            (
                "message-supported",
                json!({"kind": "binary", "value": true}),
                "/assessment/kind",
            ),
            (
                "adds-information",
                json!({"kind": "categorical", "label": "yes"}),
                "/assessment/kind",
            ),
            (
                "consequence",
                json!({"kind": "categorical", "label": "minor"}),
                "/assessment/kind",
            ),
        ] {
            let error = validate_assessment(&definition, check, &assessment)
                .err()
                .unwrap_or_else(|| panic!("{check}: the assessment was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidAssessment, "{check}");
            assert_eq!(error.field_path, path, "{check}: {error}");
        }
    }

    #[test]
    fn labels_levels_positions_and_distributions_stay_inside_the_check() {
        let definition = definition();
        for (check, assessment, path) in [
            (
                "message-supported",
                json!({"kind": "categorical", "label": "excellent"}),
                "/assessment/label",
            ),
            (
                "consequence",
                json!({"kind": "ordered", "level": "critical", "position": 1.0}),
                "/assessment/level",
            ),
            (
                "consequence",
                json!({"kind": "ordered", "level": "minor", "position": 3.0}),
                "/assessment/position",
            ),
            (
                "consequence",
                json!({"kind": "ordered", "level": "minor", "position": -0.5}),
                "/assessment/position",
            ),
            (
                "message-supported",
                json!({
                    "kind": "categorical",
                    "label": "supported",
                    "distribution": [
                        {"name": "supported", "mass": 0.7},
                        {"name": "excellent", "mass": 0.3}
                    ]
                }),
                "/assessment/distribution/1/name",
            ),
            (
                "message-supported",
                json!({
                    "kind": "categorical",
                    "label": "supported",
                    "distribution": [
                        {"name": "supported", "mass": 0.7},
                        {"name": "incomplete", "mass": 0.2}
                    ]
                }),
                "/assessment/distribution",
            ),
        ] {
            let error = validate_assessment(&definition, check, &assessment)
                .err()
                .unwrap_or_else(|| panic!("{check}: the assessment was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidAssessment, "{check}");
            assert_eq!(error.field_path, path, "{check}: {error}");
        }
        // The boundary positions pass, and one partial distribution that
        // sums to one passes, because closure and the sum are the contract.
        validate_assessment(
            &definition,
            "consequence",
            &json!({"kind": "ordered", "level": "serious", "position": 2.0}),
        )
        .expect("the last position validates");
        validate_assessment(
            &definition,
            "consequence",
            &json!({"kind": "ordered", "level": "minor", "position": 0.0}),
        )
        .expect("the first position validates");
    }

    #[test]
    fn evidence_names_only_authorized_inputs() {
        let definition = definition();
        // The binary check authorizes conversation and proposed_message only.
        let error = validate_assessment(
            &definition,
            "adds-information",
            &json!({
                "kind": "binary",
                "value": false,
                "evidence": [{"input": "prior_decision", "reference": "decision-2026-03"}]
            }),
        )
        .expect_err("the evidence was accepted");
        assert_eq!(error.code, ReasonCode::InvalidAssessment);
        assert_eq!(error.field_path, "/assessment/evidence/0/input");
        // One authorized input passes.
        validate_assessment(
            &definition,
            "adds-information",
            &json!({
                "kind": "binary",
                "value": false,
                "evidence": [{"input": "conversation", "reference": "message-14"}]
            }),
        )
        .expect("the using list of the check authorizes the input");
    }

    #[test]
    fn structural_failures_report_invalid_assessment_with_their_pointers() {
        let definition = definition();
        for (check, assessment, path) in [
            (
                "message-supported",
                json!({"kind": "categorical"}),
                "/assessment/label",
            ),
            (
                "message-supported",
                json!({"kind": "categorical", "label": "supported", "extra": 1}),
                "/assessment/extra",
            ),
            (
                "message-supported",
                json!({"kind": "categorical", "label": "supported", "confidence": 1.5}),
                "/assessment/confidence",
            ),
            ("message-supported", json!("supported"), "/assessment"),
        ] {
            let error = validate_assessment(&definition, check, &assessment)
                .err()
                .unwrap_or_else(|| panic!("{check}: the assessment was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidAssessment, "{check}");
            assert_eq!(error.field_path, path, "{check}: {error}");
        }
    }
}
