// SPDX-License-Identifier: Apache-2.0
//! The `probability_mass_v0` decision policy family.
//!
//! One policy of this family decides one question outcome from the
//! probability mass that the assessment reports on the acceptable and the
//! unacceptable answers or levels of its check:
//!
//! - Acceptable mass at or above `accept_cutoff` passes.
//! - Unacceptable mass at or above `rejection_cutoff` fails.
//! - Every other assessment reviews.
//!
//! The check meaning fixes the three sets, and the measurement supplies the
//! mass. The accepted answers or levels come from `accept`, with scale
//! acceptance expanded over the declared order. The declared review answers
//! or levels review. Every remaining declared answer or level is
//! unacceptable.
//!
//! - One categorical assessment sums its reported distribution over each
//!   set. One answer that the check declares as review stays review,
//!   whatever the distribution reports.
//! - One ordered assessment sums its reported distribution over each set of
//!   levels. The reported level and position name and place the answer.
//!   They are not mass, and one ordinal mean cannot replace the
//!   distribution.
//! - One binary assessment derives the masses from its value and the
//!   accepted answer, exactly zero or one, because Noul reports one value
//!   and no distribution.
//!
//! One optional confidence floor abstains where the answer kind supports
//! confidence. One reported confidence below the floor reviews, and one
//! absent confidence reviews too, because it cannot support the floor. One
//! floor on one binary check fits no definition: Noul defines no confidence
//! field, so no floor there can be evaluated.
//!
//! Both cutoffs must exceed 0.5, so one assessment cannot pass and fail at
//! the same time. Acceptance is evaluated first. That fixed order covers
//! one distribution whose masses sit on both sides through the published
//! sum tolerance.
//!
//! The family claims no calibrated probability of correctness. One
//! provider distribution or confidence is one measurement input. The
//! cutoffs record one decision rule, not one measured error rate, as
//! MVP_SPEC.md section 6 states.

use crate::assessment;
use crate::definition::{Accept, Check, CheckKind, LabelSelection, ValidatedDefinition};
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::report::{AppliedPolicy, Outcome};
use serde_json::Value;

/// The family name of the contracts, as `profile.schema.json` states it.
pub const FAMILY: &str = "probability_mass_v0";

/// The JSON Pointer base that [`decide`] reports parameter failures under.
///
/// One decision happens inside one check record of a run report, so one
/// invalid parameter names its field there. One profile-scoped caller passes
/// its own base to [`validate_policy`].
const PARAMETER_BASE: &str = "/applied_policy";

/// The probability mass of one assessment on the two decisive answer sets.
///
/// The two masses are measurement inputs read from one distribution, or the
/// zero-one masses derived from one binary value. Their sum stays at or
/// below one, because the review mass belongs to neither set.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Masses {
    /// Mass on the accepted answers or levels of the check.
    pub acceptable: f64,
    /// Mass on the answers or levels that are neither accepted nor review.
    pub unacceptable: f64,
}

/// Computes the two masses of one assessment under the sets of its check.
///
/// The assessment must pass [`assessment::validate_assessment`] first, which
/// this function runs, so the masses come only from one assessment that
/// fits its check.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the identifier names no question
/// check, when the assessment breaks the assessment contract of its check,
/// or when one categorical or ordered assessment states no distribution.
pub fn masses(
    definition: &ValidatedDefinition,
    check_id: &str,
    assessment: &Value,
) -> Result<Masses, ValidationError> {
    let check = question_check(definition, check_id)?;
    assessment::validate_assessment(definition, check_id, assessment)?;
    compute_masses(
        check,
        definition
            .check_kind(check_id)
            .expect("the check was found"),
        assessment,
    )
}

/// Checks that one policy of the family fits one question check.
///
/// `base` is the JSON Pointer that parameter failures report under, for
/// example `/profile/policy/checks/0` inside one profile.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `policy_mismatch` when the identifier
/// names no question check of the definition, with `invalid_field_type`
/// when one parameter sits at 0.5 or below, or above 1, and with
/// `policy_mismatch` when one binary check carries one confidence floor.
pub fn validate_policy(
    definition: &ValidatedDefinition,
    check_id: &str,
    policy: &AppliedPolicy,
    base: &str,
) -> Result<(), ValidationError> {
    question_check(definition, check_id)?;
    policy.validate(base)?;
    if policy.confidence_floor.is_some()
        && definition.check_kind(check_id) == Some(CheckKind::Binary)
    {
        return Err(ValidationError::new(
            ReasonCode::PolicyMismatch,
            format!("{base}/confidence_floor"),
            format!(
                "The binary check {} takes no confidence floor. Noul reports no confidence, so no floor can be evaluated.",
                fragment(check_id)
            ),
        ));
    }
    Ok(())
}

/// Decides one question outcome under the `probability_mass_v0` family.
///
/// The order is fixed. The policy parameters and their fit come first, then
/// the assessment contract, then one declared review label of one
/// categorical answer, then the confidence floor, then the two cutoffs.
///
/// # Errors
///
/// Returns a [`ValidationError`] under the conditions of
/// [`validate_policy`], of [`assessment::validate_assessment`], or when one
/// categorical or ordered assessment states no distribution.
pub fn decide(
    definition: &ValidatedDefinition,
    check_id: &str,
    assessment: &Value,
    policy: &AppliedPolicy,
) -> Result<Outcome, ValidationError> {
    validate_policy(definition, check_id, policy, PARAMETER_BASE)?;
    assessment::validate_assessment(definition, check_id, assessment)?;
    let check = definition
        .as_definition()
        .checks
        .iter()
        .find(|check| check.id == check_id)
        .expect("validate_policy found the check");
    let kind = definition
        .check_kind(check_id)
        .expect("the check was found");
    let sets = answer_sets(check);
    let map = assessment
        .as_object()
        .expect("validation checked an object");

    // One review-labeled Choice answer stays review. The selected label
    // states the review meaning on its own, so this rule needs no mass and
    // no distribution.
    if kind == CheckKind::Categorical {
        let label = map
            .get("label")
            .and_then(Value::as_str)
            .expect("validation checked the label");
        if sets.review.iter().any(|review| review == label) {
            return Ok(Outcome::Review);
        }
    }

    // One confidence floor abstains where the answer kind supports
    // confidence. The policy boundary already rejected one floor on one
    // binary check. One absent confidence reviews, because it cannot
    // support the floor that the selected policy requires.
    if let Some(floor) = policy.confidence_floor {
        let meets = matches!(map.get("confidence"), Some(Value::Number(_)))
            && map.get("confidence").and_then(Value::as_f64) >= Some(floor);
        if !meets {
            return Ok(Outcome::Review);
        }
    }

    let reported = compute_masses(check, kind, assessment)?;
    if reported.acceptable >= policy.accept_cutoff {
        Ok(Outcome::Pass)
    } else if reported.unacceptable >= policy.rejection_cutoff {
        Ok(Outcome::Fail)
    } else {
        Ok(Outcome::Review)
    }
}

/// Returns the question check with the stated identifier.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `policy_mismatch` when the identifier
/// names no check of the definition, or names one rule check, because one
/// rule check records its executed rule and takes no decision policy.
fn question_check<'a>(
    definition: &'a ValidatedDefinition,
    check_id: &str,
) -> Result<&'a Check, ValidationError> {
    let check = definition
        .as_definition()
        .checks
        .iter()
        .find(|check| check.id == check_id)
        .ok_or_else(|| {
            ValidationError::new(
                ReasonCode::PolicyMismatch,
                "/check",
                format!(
                    "The policy names no check of the definition: {}.",
                    fragment(check_id)
                ),
            )
        })?;
    if definition.check_kind(check_id) == Some(CheckKind::Rule) {
        return Err(ValidationError::new(
            ReasonCode::PolicyMismatch,
            "/check",
            "One rule check takes no decision policy. It records its executed rule.",
        ));
    }
    Ok(check)
}

/// The three answer sets of one question check, from its authored meaning.
pub(crate) struct AnswerSets {
    /// Accepted answers or levels. Scale acceptance expands over the order.
    pub(crate) acceptable: Vec<String>,
    /// Declared review answers or levels.
    pub(crate) review: Vec<String>,
    /// Declared answers or levels that are neither accepted nor review.
    pub(crate) unacceptable: Vec<String>,
}

/// Resolves the three answer sets of one question check.
///
/// The sets state the acceptance meaning of the authored labels. The policy
/// family reads them for one assessment, and the dataset boundary reads
/// them for one reference label, so both answer from the same meaning.
pub(crate) fn answer_sets(check: &Check) -> AnswerSets {
    let review: Vec<String> = check
        .review
        .as_ref()
        .map(|selection| {
            labels_of(selection)
                .into_iter()
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let acceptable: Vec<String> = match &check.accept {
        Some(Accept::AtLeast { at_least }) => {
            let scale = check.scale.as_ref().expect("one scale check holds a scale");
            scale
                .iter()
                .skip_while(|level| level.name != *at_least)
                .map(|level| level.name.clone())
                .collect()
        }
        Some(Accept::Labels(selection)) => labels_of(selection)
            .into_iter()
            .map(str::to_owned)
            .collect(),
        None => Vec::new(),
    };
    let declared: Vec<String> = check
        .answers
        .as_ref()
        .map(|answers| answers.keys().cloned().collect())
        .unwrap_or_else(|| {
            check
                .scale
                .as_ref()
                .expect("one question check declares answers or a scale")
                .iter()
                .map(|level| level.name.clone())
                .collect()
        });
    let unacceptable = declared
        .into_iter()
        .filter(|name| !acceptable.contains(name) && !review.contains(name))
        .collect();
    AnswerSets {
        acceptable,
        review,
        unacceptable,
    }
}

/// Returns the labels of one selection, in written order.
fn labels_of(selection: &LabelSelection) -> Vec<&str> {
    match selection {
        LabelSelection::One(label) => vec![label.as_str()],
        LabelSelection::Many(labels) => labels.iter().map(|label| label.as_str()).collect(),
    }
}

/// Computes the two masses of one assessment that passed validation.
fn compute_masses(
    check: &Check,
    kind: CheckKind,
    assessment: &Value,
) -> Result<Masses, ValidationError> {
    let map = assessment
        .as_object()
        .expect("validation checked an object");
    let sets = answer_sets(check);
    match kind {
        CheckKind::Binary => {
            // One binary assessment derives its masses from its value and
            // the accepted answer. Noul reports one value and no
            // distribution, so the masses are exactly zero or one. One
            // distribution that another evaluator reports is not read.
            let value = map
                .get("value")
                .and_then(Value::as_bool)
                .expect("validation checked the value");
            let selected = if value { "yes" } else { "no" };
            Ok(Masses {
                acceptable: member(&sets.acceptable, selected),
                unacceptable: member(&sets.unacceptable, selected),
            })
        }
        CheckKind::Categorical | CheckKind::Ordered => {
            // One categorical or ordered assessment states its distribution.
            // The selected label, the reported level, and the reported
            // position are not mass, and no mean can replace the reported
            // distribution.
            let Some(Value::Array(entries)) = map.get("distribution") else {
                return Err(ValidationError::new(
                    ReasonCode::MissingField,
                    "/assessment/distribution",
                    "The assessment states no distribution, and the probability_mass_v0 family decides on reported mass. One level, one position, and one ordinal mean cannot replace it.",
                ));
            };
            Ok(Masses {
                acceptable: mass_over(entries, &sets.acceptable),
                unacceptable: mass_over(entries, &sets.unacceptable),
            })
        }
        CheckKind::Rule => unreachable!("the policy boundary rejected the rule check"),
    }
}

/// Sums one reported distribution over one set of names.
fn mass_over(entries: &[Value], names: &[String]) -> f64 {
    entries
        .iter()
        .filter_map(|entry| {
            let name = entry.get("name").and_then(Value::as_str)?;
            names.iter().any(|wanted| wanted == name).then(|| {
                entry
                    .get("mass")
                    .and_then(Value::as_f64)
                    .unwrap_or_default()
            })
        })
        .sum()
}

/// Returns one when the set holds the name, and zero when it does not.
fn member(names: &[String], name: &str) -> f64 {
    u8::from(names.iter().any(|wanted| wanted == name)).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One definition with one check of every shape that the family decides:
    /// one categorical check with one review label, one binary check, one
    /// ordered check, one ordered check with one review level, one
    /// categorical check with one multi-label accept, one binary check with
    /// one review label, and one rule check.
    fn definition() -> ValidatedDefinition {
        let artifact = json!({
            "schema_version": 1,
            "name": "policy-rules",
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
                    "id": "correction-risk",
                    "name": "One correction stays inside the group",
                    "using": ["prior_decision", "conversation"],
                    "question": "What risk does one late correction carry?",
                    "scale": [
                        {"none": "No identified risk."},
                        {"minor": "One local rework."},
                        {"material": "One commitment slips."}
                    ],
                    "accept": {"at_least": "material"},
                    "review": "minor"
                },
                {
                    "id": "impact-scope",
                    "name": "The impact stays bounded",
                    "using": ["prior_decision", "conversation"],
                    "question": "How wide is the impact?",
                    "answers": {
                        "broad": "Every conversation changes.",
                        "narrow": "One conversation changes.",
                        "local": "One message changes.",
                        "unknown": "The impact is not clear."
                    },
                    "accept": ["narrow", "local"],
                    "review": "unknown"
                },
                {
                    "id": "risk-accepted",
                    "name": "The group accepted this risk",
                    "using": ["prior_decision", "conversation"],
                    "question": "Did the group accept this risk?",
                    "answers": {
                        "yes": "One recorded decision accepts it.",
                        "no": "No decision accepts it."
                    },
                    "accept": "no",
                    "review": "yes"
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

    /// One policy without one confidence floor.
    fn policy(accept_cutoff: f64, rejection_cutoff: f64) -> AppliedPolicy {
        AppliedPolicy {
            accept_cutoff,
            rejection_cutoff,
            confidence_floor: None,
        }
    }

    #[test]
    fn cutoffs_decide_pass_fail_and_review_from_reported_mass() {
        let definition = definition();
        // Every row states its own policy, so the boundary values sit inside
        // one table instead of one shared setup. Dyadic fractions keep the
        // boundary sums exact, and one single entry copies its literal.
        let rows: &[(&str, Value, AppliedPolicy, Outcome)] = &[
            // One clear categorical pass.
            (
                "message-supported",
                json!({
                    "kind": "categorical",
                    "label": "supported",
                    "distribution": [
                        {"name": "supported", "mass": 0.9},
                        {"name": "incomplete", "mass": 0.05},
                        {"name": "contradicted", "mass": 0.05}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Pass,
            ),
            // Acceptable mass exactly at the cutoff passes.
            (
                "message-supported",
                json!({
                    "kind": "categorical",
                    "label": "supported",
                    "distribution": [
                        {"name": "supported", "mass": 0.75},
                        {"name": "incomplete", "mass": 0.25}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Pass,
            ),
            // One clear categorical fail.
            (
                "message-supported",
                json!({
                    "kind": "categorical",
                    "label": "contradicted",
                    "distribution": [
                        {"name": "supported", "mass": 0.05},
                        {"name": "incomplete", "mass": 0.05},
                        {"name": "contradicted", "mass": 0.9}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Fail,
            ),
            // Unacceptable mass exactly at the cutoff fails.
            (
                "message-supported",
                json!({
                    "kind": "categorical",
                    "label": "contradicted",
                    "distribution": [
                        {"name": "supported", "mass": 0.35},
                        {"name": "contradicted", "mass": 0.65}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Fail,
            ),
            // Review mass between the two cutoffs reviews.
            (
                "message-supported",
                json!({
                    "kind": "categorical",
                    "label": "supported",
                    "distribution": [
                        {"name": "supported", "mass": 0.6},
                        {"name": "incomplete", "mass": 0.2},
                        {"name": "contradicted", "mass": 0.2}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Review,
            ),
            // One multi-label accept sums the mass of every accepted label.
            (
                "impact-scope",
                json!({
                    "kind": "categorical",
                    "label": "narrow",
                    "distribution": [
                        {"name": "broad", "mass": 0.05},
                        {"name": "narrow", "mass": 0.5},
                        {"name": "local", "mass": 0.4},
                        {"name": "unknown", "mass": 0.05}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Pass,
            ),
            (
                "impact-scope",
                json!({
                    "kind": "categorical",
                    "label": "broad",
                    "distribution": [
                        {"name": "broad", "mass": 0.9},
                        {"name": "narrow", "mass": 0.05},
                        {"name": "local", "mass": 0.0},
                        {"name": "unknown", "mass": 0.05}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Fail,
            ),
            // One ordered pass: the acceptable mass sums the levels from
            // at_least upward.
            (
                "consequence",
                json!({
                    "kind": "ordered",
                    "level": "meaningful",
                    "position": 1.5,
                    "distribution": [
                        {"name": "minor", "mass": 0.1},
                        {"name": "meaningful", "mass": 0.55},
                        {"name": "serious", "mass": 0.35}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Pass,
            ),
            (
                "consequence",
                json!({
                    "kind": "ordered",
                    "level": "serious",
                    "position": 2.0,
                    "distribution": [
                        {"name": "minor", "mass": 0.25},
                        {"name": "meaningful", "mass": 0.25},
                        {"name": "serious", "mass": 0.5}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Pass,
            ),
            // One ordered fail: every lower level is unacceptable mass.
            (
                "consequence",
                json!({
                    "kind": "ordered",
                    "level": "minor",
                    "position": 0.0,
                    "distribution": [
                        {"name": "minor", "mass": 0.8},
                        {"name": "meaningful", "mass": 0.1},
                        {"name": "serious", "mass": 0.1}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Fail,
            ),
            (
                "consequence",
                json!({
                    "kind": "ordered",
                    "level": "meaningful",
                    "position": 1.0,
                    "distribution": [
                        {"name": "minor", "mass": 0.45},
                        {"name": "meaningful", "mass": 0.1},
                        {"name": "serious", "mass": 0.45}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Review,
            ),
            // One review level carries no unacceptable mass, so one split
            // below at_least reviews instead of failing.
            (
                "correction-risk",
                json!({
                    "kind": "ordered",
                    "level": "minor",
                    "position": 1.0,
                    "distribution": [
                        {"name": "none", "mass": 0.2},
                        {"name": "minor", "mass": 0.5},
                        {"name": "material", "mass": 0.3}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Review,
            ),
            // The review-level rule of Choice does not extend to Score:
            // the nearest level names one review level, and the acceptable
            // mass still passes.
            (
                "correction-risk",
                json!({
                    "kind": "ordered",
                    "level": "minor",
                    "position": 1.2,
                    "distribution": [
                        {"name": "none", "mass": 0.05},
                        {"name": "minor", "mass": 0.1},
                        {"name": "material", "mass": 0.85}
                    ]
                }),
                policy(0.75, 0.65),
                Outcome::Pass,
            ),
            // One binary value derives exact zero-one masses.
            (
                "adds-information",
                json!({"kind": "binary", "value": false}),
                policy(0.9, 0.9),
                Outcome::Pass,
            ),
            (
                "adds-information",
                json!({"kind": "binary", "value": true}),
                policy(0.9, 0.9),
                Outcome::Fail,
            ),
            // One review answer of one binary check reviews, because the
            // accepted answer is the other one and no answer stays
            // unacceptable.
            (
                "risk-accepted",
                json!({"kind": "binary", "value": true}),
                policy(0.9, 0.9),
                Outcome::Review,
            ),
            (
                "risk-accepted",
                json!({"kind": "binary", "value": false}),
                policy(0.9, 0.9),
                Outcome::Pass,
            ),
        ];
        for (check, assessment, policy, expected) in rows {
            let decided = decide(&definition, check, assessment, policy)
                .unwrap_or_else(|error| panic!("{check}: {error}"));
            assert_eq!(decided, *expected, "{check}: {assessment}");
        }
    }

    #[test]
    fn review_labels_and_confidence_floors_abstain() {
        let definition = definition();
        let floor = AppliedPolicy {
            accept_cutoff: 0.75,
            rejection_cutoff: 0.65,
            confidence_floor: Some(0.8),
        };
        let supported = json!({
            "kind": "categorical",
            "label": "supported",
            "distribution": [
                {"name": "supported", "mass": 0.9},
                {"name": "incomplete", "mass": 0.05},
                {"name": "contradicted", "mass": 0.05}
            ]
        });

        // One review-labeled Choice answer stays review, whatever the
        // distribution reports.
        let review_labeled = json!({
            "kind": "categorical",
            "label": "incomplete",
            "distribution": [
                {"name": "supported", "mass": 0.9},
                {"name": "incomplete", "mass": 0.1}
            ]
        });
        assert_eq!(
            decide(
                &definition,
                "message-supported",
                &review_labeled,
                &policy(0.75, 0.65)
            )
            .expect("the review label decides"),
            Outcome::Review
        );

        // The review-label rule reads the label alone, so one label-only
        // review answer reviews without one distribution.
        let label_only = json!({"kind": "categorical", "label": "incomplete"});
        assert_eq!(
            decide(
                &definition,
                "message-supported",
                &label_only,
                &policy(0.75, 0.65)
            )
            .expect("the review label needs no mass"),
            Outcome::Review
        );

        // One reported confidence at the floor keeps the mass outcome.
        let at_floor = json!({
            "kind": "categorical",
            "label": "supported",
            "confidence": 0.8,
            "distribution": [
                {"name": "supported", "mass": 0.9},
                {"name": "incomplete", "mass": 0.05},
                {"name": "contradicted", "mass": 0.05}
            ]
        });
        assert_eq!(
            decide(&definition, "message-supported", &at_floor, &floor).expect("the floor is met"),
            Outcome::Pass
        );

        // One reported confidence below the floor reviews, although the
        // acceptable mass would pass.
        let below_floor = json!({
            "kind": "categorical",
            "label": "supported",
            "confidence": 0.7,
            "distribution": [
                {"name": "supported", "mass": 0.9},
                {"name": "incomplete", "mass": 0.05},
                {"name": "contradicted", "mass": 0.05}
            ]
        });
        assert_eq!(
            decide(&definition, "message-supported", &below_floor, &floor)
                .expect("the floor abstains"),
            Outcome::Review
        );

        // One absent confidence reviews under one declared floor, because
        // no reported measurement supports the floor.
        assert_eq!(
            decide(&definition, "message-supported", &supported, &floor)
                .expect("the absent confidence abstains"),
            Outcome::Review
        );
        // The same assessment passes under one policy without one floor.
        assert_eq!(
            decide(
                &definition,
                "message-supported",
                &supported,
                &policy(0.75, 0.65)
            )
            .expect("no floor applies"),
            Outcome::Pass
        );

        // The floor abstains on one ordered answer too.
        let ordered = json!({
            "kind": "ordered",
            "level": "meaningful",
            "position": 1.5,
            "confidence": 0.6,
            "distribution": [
                {"name": "minor", "mass": 0.1},
                {"name": "meaningful", "mass": 0.55},
                {"name": "serious", "mass": 0.35}
            ]
        });
        assert_eq!(
            decide(&definition, "consequence", &ordered, &floor)
                .expect("the floor abstains on one ordered answer"),
            Outcome::Review
        );
    }

    #[test]
    fn invalid_policy_parameters_are_rejected() {
        let definition = definition();
        let assessment = json!({"kind": "binary", "value": false});
        let rows: &[(AppliedPolicy, &str)] = &[
            (policy(0.5, 0.65), "/applied_policy/accept_cutoff"),
            (policy(0.49, 0.65), "/applied_policy/accept_cutoff"),
            (policy(1.01, 0.65), "/applied_policy/accept_cutoff"),
            (policy(-0.75, 0.65), "/applied_policy/accept_cutoff"),
            (policy(0.75, 0.5), "/applied_policy/rejection_cutoff"),
            (policy(0.75, 0.0), "/applied_policy/rejection_cutoff"),
            (
                AppliedPolicy {
                    accept_cutoff: 0.75,
                    rejection_cutoff: 0.65,
                    confidence_floor: Some(0.5),
                },
                "/applied_policy/confidence_floor",
            ),
            (
                AppliedPolicy {
                    accept_cutoff: 0.75,
                    rejection_cutoff: 0.65,
                    confidence_floor: Some(1.5),
                },
                "/applied_policy/confidence_floor",
            ),
        ];
        for (policy, path) in rows {
            let error = decide(&definition, "adds-information", &assessment, policy)
                .err()
                .unwrap_or_else(|| panic!("{path}: the policy was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{path}: {error}");
            assert_eq!(error.field_path, *path, "{path}: {error}");
            assert!(!error.message.is_empty(), "{path}: the cause is empty");
        }
    }

    #[test]
    fn policies_that_fit_no_check_are_rejected() {
        let definition = definition();
        let assessment = json!({"kind": "binary", "value": false});

        // One unknown check identifier fits no definition.
        let error = decide(
            &definition,
            "unknown-check",
            &assessment,
            &policy(0.75, 0.65),
        )
        .expect_err("the unknown check was rejected");
        assert_eq!(error.code, ReasonCode::PolicyMismatch);
        assert_eq!(error.field_path, "/check");

        // One rule check records its executed rule, so it takes no policy.
        let error = decide(
            &definition,
            "message-length",
            &json!({"kind": "categorical", "label": "supported"}),
            &policy(0.75, 0.65),
        )
        .expect_err("the rule check was rejected");
        assert_eq!(error.code, ReasonCode::PolicyMismatch);
        assert_eq!(error.field_path, "/check");

        // One confidence floor on one binary check fits no definition,
        // because Noul reports no confidence.
        let floor = AppliedPolicy {
            accept_cutoff: 0.75,
            rejection_cutoff: 0.65,
            confidence_floor: Some(0.8),
        };
        let error = decide(&definition, "adds-information", &assessment, &floor)
            .expect_err("the binary floor was rejected");
        assert_eq!(error.code, ReasonCode::PolicyMismatch);
        assert_eq!(error.field_path, "/applied_policy/confidence_floor");

        // The profile-scoped base names the parameter inside one profile.
        let error = validate_policy(
            &definition,
            "adds-information",
            &floor,
            "/profile/policy/checks/0",
        )
        .expect_err("the profile-scoped check was rejected");
        assert_eq!(
            error.field_path, "/profile/policy/checks/0/confidence_floor",
            "{}",
            error
        );
        // One fitting policy validates under the same base.
        validate_policy(
            &definition,
            "message-supported",
            &policy(0.75, 0.65),
            "/profile/policy/checks/1",
        )
        .expect("the fitting policy validates");
    }

    #[test]
    fn missing_required_measurements_fail_explicitly() {
        let definition = definition();

        // One label-only categorical answer states no distribution, so the
        // family fails instead of inventing mass.
        let error = decide(
            &definition,
            "message-supported",
            &json!({"kind": "categorical", "label": "supported"}),
            &policy(0.75, 0.65),
        )
        .expect_err("the missing distribution was rejected");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/assessment/distribution");

        // One ordered answer that states its level and its fractional
        // position still fails, because one position is no mass.
        let error = decide(
            &definition,
            "consequence",
            &json!({"kind": "ordered", "level": "serious", "position": 2.0}),
            &policy(0.75, 0.65),
        )
        .expect_err("the missing score distribution was rejected");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/assessment/distribution");
        assert!(
            error.message.contains("mean"),
            "the cause names the mean: {error}"
        );

        // One binary answer without one value breaks the assessment
        // contract first.
        let error = decide(
            &definition,
            "adds-information",
            &json!({"kind": "binary"}),
            &policy(0.75, 0.65),
        )
        .expect_err("the valueless binary answer was rejected");
        assert_eq!(error.code, ReasonCode::InvalidAssessment);

        // One assessment of the wrong kind breaks the assessment contract.
        let error = decide(
            &definition,
            "adds-information",
            &json!({"kind": "categorical", "label": "yes"}),
            &policy(0.75, 0.65),
        )
        .expect_err("the wrong kind was rejected");
        assert_eq!(error.code, ReasonCode::InvalidAssessment);
    }

    #[test]
    fn score_means_cannot_replace_distribution_mass() {
        let definition = definition();

        // The mean of this distribution sits exactly at the accepted level
        // meaningful: 0.45 times 0, plus 0.1 times 1, plus 0.45 times 2.
        // One mean-based rule would pass. The family reads the mass, so the
        // outcome reviews and the unacceptable mass stays visible.
        let split = json!({
            "kind": "ordered",
            "level": "meaningful",
            "position": 1.0,
            "distribution": [
                {"name": "minor", "mass": 0.45},
                {"name": "meaningful", "mass": 0.1},
                {"name": "serious", "mass": 0.45}
            ]
        });
        let reported = masses(&definition, "consequence", &split)
            .unwrap_or_else(|error| panic!("the split distribution reports mass: {error}"));
        assert!((reported.acceptable - 0.55).abs() < 1e-12, "{reported:?}");
        assert!((reported.unacceptable - 0.45).abs() < 1e-12, "{reported:?}");
        assert_eq!(
            decide(&definition, "consequence", &split, &policy(0.75, 0.65))
                .expect("the split distribution decides"),
            Outcome::Review
        );

        // One distribution with the same mean and no split concentrates its
        // acceptable mass, so the same policy passes it. Two equal means and
        // two different outcomes pin that the reported mass decides, not the
        // ordinal position of the mean.
        let concentrated = json!({
            "kind": "ordered",
            "level": "meaningful",
            "position": 1.0,
            "distribution": [
                {"name": "minor", "mass": 0.1},
                {"name": "meaningful", "mass": 0.8},
                {"name": "serious", "mass": 0.1}
            ]
        });
        let concentrated_masses = masses(&definition, "consequence", &concentrated)
            .unwrap_or_else(|error| panic!("the distribution reports mass: {error}"));
        assert!(
            (concentrated_masses.acceptable - 0.9).abs() < 1e-12,
            "{concentrated_masses:?}"
        );
        assert_eq!(
            decide(
                &definition,
                "consequence",
                &concentrated,
                &policy(0.75, 0.65)
            )
            .expect("the concentrated distribution decides"),
            Outcome::Pass
        );
    }

    #[test]
    fn noul_values_derive_exact_zero_one_masses() {
        let definition = definition();
        for (value, acceptable, unacceptable) in [(false, 1.0, 0.0), (true, 0.0, 1.0)] {
            let reported = masses(
                &definition,
                "adds-information",
                &json!({"kind": "binary", "value": value}),
            )
            .unwrap_or_else(|error| panic!("the value derives mass: {error}"));
            assert_eq!(reported.acceptable, acceptable, "value {value}");
            assert_eq!(reported.unacceptable, unacceptable, "value {value}");
        }

        // One distribution on one binary assessment is not read, because
        // the family derives the binary masses from the value.
        let with_distribution = json!({
            "kind": "binary",
            "value": false,
            "distribution": [
                {"name": "yes", "mass": 0.9},
                {"name": "no", "mass": 0.1}
            ]
        });
        let reported = masses(&definition, "adds-information", &with_distribution)
            .unwrap_or_else(|error| panic!("the value derives mass: {error}"));
        assert_eq!(reported.acceptable, 1.0);
        assert_eq!(reported.unacceptable, 0.0);
    }
}
