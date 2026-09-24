// SPDX-License-Identifier: Apache-2.0
//! The comparison of two evaluation reports on matching cases.
//!
//! MVP_SPEC.md section 10 states the rule: compare profiles on matching
//! case identifiers and input hashes. Expose the missing, the changed, the
//! errored, and the skipped cases. Show the quality, the coverage, the
//! latency, and the cost tradeoffs with the actual changed cases. Keep
//! profile fitting comparisons apart from independent validation evidence,
//! and require new measurements when evaluator behavior or inputs change.
//!
//! This module owns that comparison. [`parse_evaluation_report`] first
//! rebuilds one stored evaluation report artifact through its contract, so
//! one edited copy fails before any number computes. The parser checks
//! more than the shape: the stored aggregate of every case must fold from
//! its component outcomes, every case must state every check of the
//! report, the stored counts of every metric set must agree with the case
//! outcomes, the three whole-population denominators must equal the case
//! count, and the label coverage of one check must equal its labeled
//! cases. Every rate keeps its numerator, its denominator, and its value,
//! and one zero denominator keeps the value absent.
//!
//! [`compare_reports`] then matches the two rebuilt reports. A case
//! matches only when its identifier and its input hash agree. One changed
//! input hash never matches: the case appears under
//! `changed_input_cases` and new measurements are required. One case that
//! one report omits appears under `missing_in_candidate` or
//! `missing_in_baseline`. One matched case that holds one error or one
//! skip component outcome on either side appears under `errored_cases` or
//! `skipped_cases`, because one error and one skip decided nothing. Every
//! matched case with one changed component outcome appears under `changed`
//! with its changed checks and both aggregate outcomes.
//!
//! The tradeoffs read the stored metric sets, so every value keeps its
//! counts and its denominator on both sides through [`MetricRow`]. The
//! comparison computes one cost only when the recorded usage of that side
//! and the declared cost inputs support it: one usage key with no declared
//! cost leaves the cost absent and one limitation names the fact.
//!
//! The evidence class follows the declared purposes of the two reports.
//! Both must state `independent_validation` for one comparison that
//! counts as independent validation evidence. Every other pairing is one
//! fitting comparison that guides development and supports no validation
//! claim, as the comparison contract states.
//!
//! The comparison changes no qualification and selects no profile. It
//! reads two stored reports and states no claim that its inputs do not
//! support: the input hashes detect changed inputs alone, and one change
//! of evaluator behavior needs new measurements that no comparison can
//! replace.

use crate::definition::parse_bounded_string;
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::metrics::{MetricName, OutcomeCounts, Rate, ALL_CHECKS};
use crate::report::{
    parse_artifact_reference, parse_profile_reference, parse_reason, parse_word, AggregateOutcome,
    ArtifactReference, CompletionStatus, Outcome, ProfileReference,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The greatest length of one stored-report reference, in characters.
pub const MAX_REPORT_REF_CHARS: usize = 500;

/// The greatest length of one cost input key, in characters.
pub const MAX_COST_KEY_CHARS: usize = 128;

/// The standing statement that one fitting comparison supports no
/// validation claim.
pub const FITTING_COMPARISON: &str = "This comparison is fitting evidence. At least one report declared a purpose beside independent_validation. It guides development and supports no validation claim.";

/// The standing statement of one comparison over two independent
/// validations.
pub const VALIDATION_COMPARISON: &str = "Both reports declared independent_validation. This comparison changes no qualification and selects no profile.";

/// The standing statement that two metric values carry their denominators.
pub const DENOMINATOR_RULE: &str = "Every metric row states its numerator and its denominator on both sides. Two values with different denominators cover different case sets.";

/// The standing statement that changed evaluator behavior needs new
/// measurements.
pub const NEW_MEASUREMENTS: &str = "The comparison reads two stored reports. Input hashes detect changed inputs alone. New measurements are required when the evaluator, the resolved model, the translation, or the preprocessing changed.";

/// The fields of one evaluation report artifact.
const REPORT_FIELDS: [&str; 10] = [
    "schema_version",
    "definition",
    "profile",
    "dataset",
    "purpose",
    "cases",
    "metrics",
    "slices",
    "operational",
    "method",
];

/// The fields of one reported case.
const CASE_FIELDS: [&str; 6] = [
    "id",
    "input_hash",
    "outcomes",
    "aggregate",
    "completion",
    "reference_match",
];

/// The fields of one metric set.
const METRIC_SET_FIELDS: [&str; 3] = ["scope", "counts", "rates"];

/// The fields of one operational block.
const OPERATIONAL_FIELDS: [&str; 4] = ["errors", "attempts", "elapsed_ms", "usage"];

/// The count fields of one metric set, in the contract order.
const COUNT_FIELDS: [&str; 5] = ["pass", "fail", "review", "error", "skipped"];

/// The fields of one rate record.
const RATE_FIELDS: [&str; 4] = ["metric", "numerator", "denominator", "value"];

/// Returns one field path under one report base, so every failure names
/// the report that holds the broken field.
fn at(base: &str, field: &str) -> String {
    format!("{base}{field}")
}

/// Moves one failure of a fixed-path helper under one report base.
fn under(mut error: ValidationError, base: &str) -> ValidationError {
    if base.is_empty() {
        return error;
    }
    error.field_path = if error.field_path.is_empty() {
        base.to_owned()
    } else {
        format!("{base}{}", error.field_path)
    };
    error
}

/// Returns the component outcome word of one aggregate outcome. The
/// aggregate folds one skip into review, so the complete check set counts
/// no skipped case of its own.
const fn component_of(aggregate: AggregateOutcome) -> Outcome {
    match aggregate {
        AggregateOutcome::Pass => Outcome::Pass,
        AggregateOutcome::Fail => Outcome::Fail,
        AggregateOutcome::Review => Outcome::Review,
        AggregateOutcome::Error => Outcome::Error,
    }
}

/// The declared purpose of one evaluation, as the report contract states
/// it. Fitting results are not validation evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationPurpose {
    /// The evaluation explores one bound reviewer.
    Exploration,
    /// The evaluation guides development. It is not validation evidence.
    Fitting,
    /// The evaluation measures independent validation data.
    IndependentValidation,
}

impl EvaluationPurpose {
    /// Returns the contract word of this purpose.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Exploration => "exploration",
            Self::Fitting => "fitting",
            Self::IndependentValidation => "independent_validation",
        }
    }

    /// Returns the purpose of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "exploration" => Some(Self::Exploration),
            "fitting" => Some(Self::Fitting),
            "independent_validation" => Some(Self::IndependentValidation),
            _ => None,
        }
    }
}

/// The dataset identity of one evaluation report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasetReference {
    /// Stable dataset identifier.
    pub id: String,
    /// Dataset revision of the evaluation.
    pub revision: String,
    /// Dataset-domain content hash of the evaluated records.
    pub content_hash: String,
}

/// One reported case of one evaluation report.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReportedCase {
    /// Stable case identifier, as the report states it.
    pub id: String,
    /// The input-domain content hash of the case input.
    pub input_hash: String,
    /// The predicted outcome of every check of the report.
    pub outcomes: BTreeMap<String, Outcome>,
    /// The derived aggregate outcome of the case.
    pub aggregate: AggregateOutcome,
    /// The terminal execution status of the case.
    pub completion: CompletionStatus,
    /// The reference match of every check: `true` or `false` where one
    /// reference label exists, `None` without one.
    pub reference_match: BTreeMap<String, Option<bool>>,
}

/// One metric set of one evaluation report, as stored.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReportedMetricSet {
    /// Check identifier, or `all_checks`.
    pub scope: String,
    /// The stored predicted outcome counts of the scope.
    pub counts: OutcomeCounts,
    /// The six contract rates with their counts and denominators.
    pub rates: BTreeMap<MetricName, Rate>,
}

/// One rebuilt evaluation report artifact.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EvaluationReport {
    /// The definition that produced the checks.
    pub definition: ArtifactReference,
    /// The profile that assessed every case.
    pub profile: ProfileReference,
    /// The identity of the evaluated dataset.
    pub dataset: DatasetReference,
    /// The declared purpose of the evaluation.
    pub purpose: EvaluationPurpose,
    /// Every evaluated case, in evaluation order.
    pub cases: Vec<ReportedCase>,
    /// The metric-set order of the stored artifact: one check identifier
    /// per set, then `all_checks`.
    pub scope_order: Vec<String>,
    /// One metric set per scope of the scope order.
    pub metric_sets: BTreeMap<String, ReportedMetricSet>,
    /// The summed elapsed time of the evaluation, when one was recorded.
    pub elapsed_ms: Option<f64>,
    /// The summed usage of the evaluation, when one was recorded.
    pub usage: BTreeMap<String, f64>,
}

impl EvaluationReport {
    /// Returns the metric set of one scope.
    pub fn metric_set(&self, scope: &str) -> Option<&ReportedMetricSet> {
        self.metric_sets.get(scope)
    }

    /// Returns the stored rate of one scope and one metric.
    ///
    /// # Panics
    ///
    /// Panics when the scope names no stored set, because the parser
    /// required one set per check and one `all_checks` set.
    pub fn rate(&self, scope: &str, metric: MetricName) -> &Rate {
        self.metric_sets
            .get(scope)
            .unwrap_or_else(|| panic!("the report states no set for {scope}"))
            .rates
            .get(&metric)
            .expect("the parser required all six metrics")
    }
}

/// The evidence class of one comparison, as the comparison contract states
/// it. Fitting comparisons guide development. They are not independent
/// validation evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceClass {
    /// At least one report declared a purpose beside
    /// `independent_validation`.
    Fitting,
    /// Both reports declared `independent_validation`.
    IndependentValidation,
}

impl EvidenceClass {
    /// Returns the contract word of this class.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fitting => "fitting",
            Self::IndependentValidation => "independent_validation",
        }
    }
}

/// One side of the comparison: the profile that produced the stored report
/// and the host-managed reference to that report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReportSet {
    /// The profile that assessed every case of the report.
    pub profile: ProfileReference,
    /// Reference to the stored report in host-managed storage.
    pub report: String,
}

/// The matching of the two report sets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Matching {
    /// Cases with one equal identifier and one equal input hash in both
    /// reports.
    pub matched_cases: usize,
    /// Cases whose input hash differs between the reports, ordered by
    /// identifier.
    pub changed_input_cases: Vec<String>,
    /// Cases of the baseline report that the candidate report omits.
    pub missing_in_candidate: Vec<String>,
    /// Cases of the candidate report that the baseline report omits.
    pub missing_in_baseline: Vec<String>,
    /// Matched cases that hold one error component outcome on either side.
    pub errored_cases: Vec<String>,
    /// Matched cases that hold one skipped component outcome on either
    /// side.
    pub skipped_cases: Vec<String>,
}

/// One changed check of one changed case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangedCheck {
    /// The check whose outcome changed.
    pub check: String,
    /// The outcome of the baseline report.
    pub baseline: Outcome,
    /// The outcome of the candidate report.
    pub candidate: Outcome,
}

/// One matched case with at least one changed component outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangedCase {
    /// Stable case identifier.
    pub id: String,
    /// Every check whose outcome changed, in the scope order of the
    /// baseline report.
    pub checks: Vec<ChangedCheck>,
    /// The aggregate outcome of the baseline report.
    pub baseline_aggregate: AggregateOutcome,
    /// The aggregate outcome of the candidate report.
    pub candidate_aggregate: AggregateOutcome,
}

/// One metric tradeoff row of the comparison artifact: the two stored
/// values beside each other.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MetricTradeoff {
    /// Check identifier, or `all_checks`.
    pub scope: String,
    /// The metric of the row.
    pub metric: MetricName,
    /// The stored value of the baseline report, or `None` at one zero
    /// denominator.
    pub baseline_value: Option<f64>,
    /// The stored value of the candidate report, or `None` at one zero
    /// denominator.
    pub candidate_value: Option<f64>,
}

/// The latency tradeoff, in milliseconds. One side stays absent when that
/// report recorded no elapsed time.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ElapsedTradeoff {
    /// The summed elapsed time of the baseline report.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<f64>,
    /// The summed elapsed time of the candidate report.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<f64>,
}

/// The usage tradeoff. One side stays absent when that report recorded no
/// usage.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageTradeoff {
    /// The summed usage of the baseline report.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<BTreeMap<String, f64>>,
    /// The summed usage of the candidate report.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<BTreeMap<String, f64>>,
}

/// The tradeoffs of the comparison.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Tradeoffs {
    /// One row per scope and metric, in the scope order of the baseline
    /// report.
    pub metrics: Vec<MetricTradeoff>,
    /// The latency of both reports, when at least one recorded one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<ElapsedTradeoff>,
    /// The usage of both reports, when at least one recorded one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageTradeoff>,
    /// The computed cost of each side, when the recorded usage and the
    /// declared cost inputs support it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<BTreeMap<String, f64>>,
}

/// One metric row of the public value: the stored rate of both sides, each
/// with its numerator and its denominator.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MetricRow {
    /// Check identifier, or `all_checks`.
    pub scope: String,
    /// The metric of the row.
    pub metric: MetricName,
    /// The stored rate of the baseline report.
    pub baseline: Rate,
    /// The stored rate of the candidate report.
    pub candidate: Rate,
}

/// The complete comparison of two stored evaluation reports.
///
/// The first seven fields are the portable comparison artifact of
/// `contracts/v0/comparison.schema.json`. `metrics` and `limitations`
/// stay beside the artifact, because the artifact holds the values alone
/// while the public value keeps the counts, the denominators, and the
/// standing limits visible.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Comparison {
    /// The portable contract schema version.
    pub schema_version: u32,
    /// The baseline report set.
    pub baseline: ReportSet,
    /// The candidate report set.
    pub candidate: ReportSet,
    /// The evidence class derived from the declared purposes.
    pub evidence_class: EvidenceClass,
    /// The matching of the two report sets.
    pub matching: Matching,
    /// Every matched case with one changed component outcome, in baseline
    /// order.
    pub changed: Vec<ChangedCase>,
    /// The tradeoffs over the stored metric sets and operational totals.
    pub tradeoffs: Tradeoffs,
    /// One row per scope and metric with the counts and the denominators
    /// of both sides.
    pub metrics: Vec<MetricRow>,
    /// The standing limits of this comparison.
    pub limitations: Vec<String>,
}

/// Parses the declared cost inputs of one comparison.
///
/// The value maps one usage key to its unit cost. One key holds 1 to 128
/// characters and one cost is zero or positive.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` when the value
/// holds no object, when one key breaks its bound, or when one cost is
/// negative.
pub fn parse_cost_inputs(value: &Value) -> Result<BTreeMap<String, f64>, ValidationError> {
    let root = crate::artifact::expect_object(value, "/costs")?;
    let mut costs = BTreeMap::new();
    for (key, entry) in root {
        if key.is_empty() || key.chars().count() > MAX_COST_KEY_CHARS {
            return Err(ValidationError::invalid_field_type(
                "/costs",
                "Each cost key must hold 1 to 128 characters, the bound of one usage key.",
            ));
        }
        let Some(amount) = entry.as_f64() else {
            return Err(ValidationError::invalid_field_type(
                format!("/costs/{key}"),
                "Each cost must hold one number.",
            ));
        };
        if amount < 0.0 {
            return Err(ValidationError::invalid_field_type(
                format!("/costs/{key}"),
                "Each cost must be zero or positive.",
            ));
        }
        costs.insert(key.clone(), amount);
    }
    Ok(costs)
}

/// Parses one stored evaluation report artifact at `base`.
///
/// The parser owns the complete contract of the stored artifact: the
/// strict field set, the identifier and hash rules, the fold of every
/// aggregate, the uniform check set of every case, the metric set of every
/// check plus the `all_checks` set, the stored counts against the case
/// outcomes, the rate arithmetic, and the three whole-population
/// denominators. One edited copy fails with its field path before any
/// comparison computes.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value breaks the evaluation
/// report contract. Every path sits under `base`.
pub fn parse_evaluation_report(
    value: &Value,
    base: &str,
) -> Result<EvaluationReport, ValidationError> {
    let root = crate::artifact::expect_object(value, base)?;
    crate::artifact::schema_version(root).map_err(|error| under(error, base))?;
    crate::artifact::reject_unknown_fields(root, &REPORT_FIELDS, base)?;

    let definition = parse_artifact_reference(root.get("definition"), &at(base, "/definition"))?;
    let profile = parse_profile_reference(root.get("profile"), &at(base, "/profile"))?;
    let dataset = parse_dataset_reference(root.get("dataset"), &at(base, "/dataset"))?;
    let purpose = parse_word(
        root.get("purpose"),
        &at(base, "/purpose"),
        EvaluationPurpose::from_word,
        "evaluation purpose",
    )?;
    let (cases, check_set) = parse_reported_cases(root, base)?;
    let (scope_order, metric_sets) = parse_reported_metrics(root, base, &cases, &check_set)?;
    parse_reported_slices(root, base, &metric_sets)?;
    let (elapsed_ms, usage) = parse_reported_operational(root, base)?;
    if let Some(method) = root.get("method") {
        parse_bounded_string(Some(method), &at(base, "/method"), 2000, "The method")?;
    }

    Ok(EvaluationReport {
        definition,
        profile,
        dataset,
        purpose,
        cases,
        scope_order,
        metric_sets,
        elapsed_ms,
        usage,
    })
}

/// Parses every reported case and returns the uniform check set of the
/// report.
fn parse_reported_cases(
    root: &serde_json::Map<String, Value>,
    base: &str,
) -> Result<(Vec<ReportedCase>, BTreeSet<String>), ValidationError> {
    let raw_cases = match root.get("cases") {
        Some(Value::Array(items)) if !items.is_empty() => items,
        Some(Value::Array(_)) => {
            return Err(ValidationError::invalid_field_type(
                at(base, "/cases"),
                "The report states at least one evaluated case.",
            ));
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                at(base, "/cases"),
                "The cases field must hold one array.",
            ));
        }
        None => return Err(ValidationError::missing(at(base, "/cases"))),
    };
    let mut cases = Vec::with_capacity(raw_cases.len());
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut check_set: Option<BTreeSet<String>> = None;
    for (index, item) in raw_cases.iter().enumerate() {
        let case_base = at(base, &format!("/cases/{index}"));
        let case = parse_reported_case(item, &case_base)?;
        if !seen.insert(case.id.clone()) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                at(&case_base, "/id"),
                format!(
                    "The case identifier {} repeats an earlier case.",
                    fragment(&case.id)
                ),
            ));
        }
        let checks: BTreeSet<String> = case.outcomes.keys().cloned().collect();
        match &check_set {
            None => check_set = Some(checks),
            Some(expected) => verify_check_set(expected, &checks, &case_base)?,
        }
        cases.push(case);
    }
    Ok((cases, check_set.expect("the cases array holds one case")))
}

/// Parses one reported case at `base`.
fn parse_reported_case(value: &Value, base: &str) -> Result<ReportedCase, ValidationError> {
    let map = crate::artifact::expect_object(value, base)?;
    crate::artifact::reject_unknown_fields(map, &CASE_FIELDS, base)?;
    let id = match map.get("id") {
        Some(Value::String(text)) if crate::case::is_case_id(text) => text.clone(),
        _ => {
            return Err(ValidationError::invalid_field_type(
                at(base, "/id"),
                "The case identifier must start with a lowercase letter or a digit, then hold lowercase letters, digits, dots, underscores, or hyphens, 128 characters at most.",
            ));
        }
    };
    let input_hash = match map.get("input_hash") {
        Some(Value::String(text)) if crate::hashing::is_hash_hex(text) => text.clone(),
        _ => {
            return Err(ValidationError::invalid_field_type(
                at(base, "/input_hash"),
                "The input hash must hold 64 lowercase hexadecimal characters.",
            ));
        }
    };
    let outcomes = parse_case_outcomes(map, base)?;
    let stored_aggregate = parse_word(
        map.get("aggregate"),
        &at(base, "/aggregate"),
        AggregateOutcome::from_word,
        "aggregate outcome",
    )?;
    let folded = crate::report::aggregate(&outcomes.values().copied().collect::<Vec<_>>());
    if folded != Ok(stored_aggregate) {
        return Err(ValidationError::invalid_field_type(
            at(base, "/aggregate"),
            "The stored aggregate outcome disagrees with the component outcomes.",
        ));
    }
    let completion = parse_word(
        map.get("completion"),
        &at(base, "/completion"),
        CompletionStatus::from_word,
        "completion status",
    )?;
    let reference_match = parse_reference_match(map, base, &outcomes)?;
    Ok(ReportedCase {
        id,
        input_hash,
        outcomes,
        aggregate: stored_aggregate,
        completion,
        reference_match,
    })
}

/// Parses the outcome object of one reported case at `base`.
fn parse_case_outcomes(
    map: &serde_json::Map<String, Value>,
    base: &str,
) -> Result<BTreeMap<String, Outcome>, ValidationError> {
    let raw_outcomes = match map.get("outcomes") {
        Some(Value::Object(outcomes)) if !outcomes.is_empty() => outcomes,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                at(base, "/outcomes"),
                "The outcomes must hold one nonempty object of check identifiers.",
            ));
        }
        None => return Err(ValidationError::missing(at(base, "/outcomes"))),
    };
    let mut outcomes = BTreeMap::new();
    for (check, raw) in raw_outcomes {
        if !crate::definition::is_artifact_id(check) {
            return Err(ValidationError::invalid_field_type(
                at(base, &format!("/outcomes/{check}")),
                "The check identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        let outcome = parse_word(
            Some(raw),
            &at(base, &format!("/outcomes/{check}")),
            Outcome::from_word,
            "outcome",
        )?;
        outcomes.insert(check.clone(), outcome);
    }
    Ok(outcomes)
}

/// Parses the reference matches of one reported case at `base`.
fn parse_reference_match(
    map: &serde_json::Map<String, Value>,
    base: &str,
    outcomes: &BTreeMap<String, Outcome>,
) -> Result<BTreeMap<String, Option<bool>>, ValidationError> {
    let mut reference_match = BTreeMap::new();
    let Some(raw_matches) = map.get("reference_match") else {
        return Ok(reference_match);
    };
    let matches = crate::artifact::expect_object(raw_matches, &at(base, "/reference_match"))?;
    for (check, raw) in matches {
        if !outcomes.contains_key(check) {
            return Err(ValidationError::new(
                ReasonCode::UnknownField,
                at(base, &format!("/reference_match/{check}")),
                format!(
                    "The reference match names no check of the case: {}.",
                    fragment(check)
                ),
            ));
        }
        let matched = match raw {
            Value::Bool(matched) => Some(*matched),
            Value::Null => None,
            _ => {
                return Err(ValidationError::invalid_field_type(
                    at(base, &format!("/reference_match/{check}")),
                    "The reference match must hold one boolean or null.",
                ));
            }
        };
        reference_match.insert(check.clone(), matched);
    }
    Ok(reference_match)
}

/// Requires one case check set that equals the check set of the report.
fn verify_check_set(
    expected: &BTreeSet<String>,
    stated: &BTreeSet<String>,
    base: &str,
) -> Result<(), ValidationError> {
    for check in expected {
        if !stated.contains(check) {
            return Err(ValidationError::missing(at(
                base,
                &format!("/outcomes/{check}"),
            )));
        }
    }
    for check in stated {
        if !expected.contains(check) {
            return Err(ValidationError::new(
                ReasonCode::UnknownField,
                at(base, &format!("/outcomes/{check}")),
                format!(
                    "The case states one check that the report does not cover: {}.",
                    fragment(check)
                ),
            ));
        }
    }
    Ok(())
}

/// Parses the metric sets of one report and verifies them against its
/// cases. Returns the stored scope order and one set per scope.
fn parse_reported_metrics(
    root: &serde_json::Map<String, Value>,
    base: &str,
    cases: &[ReportedCase],
    check_set: &BTreeSet<String>,
) -> Result<(Vec<String>, BTreeMap<String, ReportedMetricSet>), ValidationError> {
    let raw_metrics = match root.get("metrics") {
        Some(Value::Array(items)) if !items.is_empty() => items,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                at(base, "/metrics"),
                "The metrics field must hold one nonempty array.",
            ));
        }
        None => return Err(ValidationError::missing(at(base, "/metrics"))),
    };
    let mut scope_order = Vec::with_capacity(raw_metrics.len());
    let mut metric_sets = BTreeMap::new();
    for (index, item) in raw_metrics.iter().enumerate() {
        let set_base = at(base, &format!("/metrics/{index}"));
        let set = parse_metric_set(item, &set_base)?;
        if set.scope != ALL_CHECKS && !check_set.contains(&set.scope) {
            return Err(ValidationError::new(
                ReasonCode::UnknownField,
                at(&set_base, "/scope"),
                format!(
                    "The scope {} names no check of the report.",
                    fragment(&set.scope)
                ),
            ));
        }
        if metric_sets.contains_key(&set.scope) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                at(&set_base, "/scope"),
                format!("The scope {} repeats an earlier set.", fragment(&set.scope)),
            ));
        }
        verify_metric_set(&set, cases, &set_base)?;
        scope_order.push(set.scope.clone());
        metric_sets.insert(set.scope.clone(), set);
    }
    for check in check_set {
        if !metric_sets.contains_key(check) {
            return Err(ValidationError::new(
                ReasonCode::MissingField,
                at(base, "/metrics"),
                format!(
                    "The report states no metric set for the check {}.",
                    fragment(check)
                ),
            ));
        }
    }
    if !metric_sets.contains_key(ALL_CHECKS) {
        return Err(ValidationError::new(
            ReasonCode::MissingField,
            at(base, "/metrics"),
            "The report states no metric set for the complete check set.",
        ));
    }
    Ok((scope_order, metric_sets))
}

/// Parses one metric set at `base`.
///
/// The set crosses the complete structural gate: the five counts, the six
/// contract rates each stated once, one numerator inside its denominator,
/// and one value that agrees with its counts. One zero denominator keeps
/// the value absent.
fn parse_metric_set(value: &Value, base: &str) -> Result<ReportedMetricSet, ValidationError> {
    let map = crate::artifact::expect_object(value, base)?;
    crate::artifact::reject_unknown_fields(map, &METRIC_SET_FIELDS, base)?;
    let scope = parse_bounded_string(map.get("scope"), &at(base, "/scope"), 64, "The scope")?
        .ok_or_else(|| ValidationError::missing(at(base, "/scope")))?;
    let counts = parse_metric_counts(map, base)?;
    let rates = parse_metric_rates(map, base)?;
    Ok(ReportedMetricSet {
        scope,
        counts,
        rates,
    })
}

/// Parses the five outcome counts of one metric set at `base`.
fn parse_metric_counts(
    map: &serde_json::Map<String, Value>,
    base: &str,
) -> Result<OutcomeCounts, ValidationError> {
    let raw_counts = match map.get("counts") {
        Some(Value::Object(counts)) => counts,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                at(base, "/counts"),
                "The counts must hold one object.",
            ));
        }
        None => return Err(ValidationError::missing(at(base, "/counts"))),
    };
    crate::artifact::reject_unknown_fields(raw_counts, &COUNT_FIELDS, &at(base, "/counts"))?;
    let count_of = |field: &str| -> Result<usize, ValidationError> {
        match raw_counts.get(field) {
            Some(Value::Number(number)) if number.as_u64().is_some() => {
                Ok(number.as_u64().expect("checked") as usize)
            }
            Some(_) => Err(ValidationError::invalid_field_type(
                at(base, &format!("/counts/{field}")),
                "The count must hold one integer of at least zero.",
            )),
            None => Err(ValidationError::missing(at(
                base,
                &format!("/counts/{field}"),
            ))),
        }
    };
    Ok(OutcomeCounts {
        pass: count_of("pass")?,
        fail: count_of("fail")?,
        review: count_of("review")?,
        error: count_of("error")?,
        skipped: count_of("skipped")?,
    })
}

/// Parses the six contract rates of one metric set at `base`.
fn parse_metric_rates(
    map: &serde_json::Map<String, Value>,
    base: &str,
) -> Result<BTreeMap<MetricName, Rate>, ValidationError> {
    let raw_rates = match map.get("rates") {
        Some(Value::Array(rates)) if !rates.is_empty() => rates,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                at(base, "/rates"),
                "The rates must hold one nonempty array.",
            ));
        }
        None => return Err(ValidationError::missing(at(base, "/rates"))),
    };
    let mut rates = BTreeMap::new();
    for (index, item) in raw_rates.iter().enumerate() {
        let rate_base = at(base, &format!("/rates/{index}"));
        let map = crate::artifact::expect_object(item, &rate_base)?;
        crate::artifact::reject_unknown_fields(map, &RATE_FIELDS, &rate_base)?;
        let metric = parse_word(
            map.get("metric"),
            &at(&rate_base, "/metric"),
            MetricName::from_word,
            "metric name",
        )?;
        if rates.contains_key(&metric) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                at(&rate_base, "/metric"),
                format!(
                    "The metric {} repeats an earlier rate of this set.",
                    metric.as_str()
                ),
            ));
        }
        let numerator = parse_count(map.get("numerator"), &at(&rate_base, "/numerator"))?;
        let denominator = parse_count(map.get("denominator"), &at(&rate_base, "/denominator"))?;
        if numerator > denominator {
            return Err(ValidationError::invalid_field_type(
                at(&rate_base, "/numerator"),
                "The numerator must stay inside its denominator.",
            ));
        }
        let value = match map.get("value") {
            None | Some(Value::Null) => None,
            Some(Value::Number(_)) => map.get("value").and_then(Value::as_f64),
            Some(_) => {
                return Err(ValidationError::invalid_field_type(
                    at(&rate_base, "/value"),
                    "The value must hold one number or null.",
                ));
            }
        };
        let expected = (denominator > 0).then_some(numerator as f64 / denominator as f64);
        if value != expected {
            return Err(ValidationError::invalid_field_type(
                at(&rate_base, "/value"),
                if denominator == 0 {
                    "One zero denominator holds no value. State null."
                } else {
                    "The value disagrees with its numerator and its denominator."
                },
            ));
        }
        rates.insert(
            metric,
            Rate {
                metric,
                numerator,
                denominator,
                value,
            },
        );
    }
    if rates.len() != MetricName::ALL.len() {
        return Err(ValidationError::invalid_field_type(
            at(base, "/rates"),
            "The set states each of the six contract metrics once.",
        ));
    }
    Ok(rates)
}

/// Parses one nonnegative integer count at `base`.
fn parse_count(value: Option<&Value>, base: &str) -> Result<usize, ValidationError> {
    match value {
        Some(Value::Number(number)) if number.as_u64().is_some() => {
            Ok(number.as_u64().expect("checked") as usize)
        }
        Some(_) => Err(ValidationError::invalid_field_type(
            base,
            "The count must hold one integer of at least zero.",
        )),
        None => Err(ValidationError::missing(base)),
    }
}

/// Verifies one metric set against the cases of its report.
///
/// The stored counts must agree with the case outcomes: one tally per
/// check, one tally of the aggregates for the complete set. The three
/// whole-population denominators must equal the case count, and the label
/// coverage of one check must equal its labeled cases.
fn verify_metric_set(
    set: &ReportedMetricSet,
    cases: &[ReportedCase],
    base: &str,
) -> Result<(), ValidationError> {
    let is_complete = set.scope == ALL_CHECKS;
    let mut tally = OutcomeCounts::default();
    let mut labeled = 0;
    for case in cases {
        let outcome = if is_complete {
            component_of(case.aggregate)
        } else {
            case.outcomes[&set.scope]
        };
        tally.record(outcome);
        if !is_complete
            && case
                .reference_match
                .get(&set.scope)
                .is_some_and(Option::is_some)
        {
            labeled += 1;
        }
    }
    if tally != set.counts {
        return Err(ValidationError::invalid_field_type(
            at(base, "/counts"),
            "The stored counts disagree with the case outcomes.",
        ));
    }
    let total = set.counts.total();
    for metric in [
        MetricName::ReviewRate,
        MetricName::AutomaticCoverage,
        MetricName::LabelCoverage,
    ] {
        if set.rates[&metric].denominator != total {
            return Err(ValidationError::invalid_field_type(
                at(base, "/rates"),
                format!(
                    "The {} denominator must equal the case count of its scope.",
                    metric.as_str()
                ),
            ));
        }
    }
    if !is_complete && set.rates[&MetricName::LabelCoverage].numerator != labeled {
        return Err(ValidationError::invalid_field_type(
            at(base, "/rates"),
            format!(
                "The {} numerator must equal the labeled cases of {}.",
                MetricName::LabelCoverage.as_str(),
                fragment(&set.scope)
            ),
        ));
    }
    if is_complete && set.counts.skipped != 0 {
        return Err(ValidationError::invalid_field_type(
            at(base, "/counts"),
            "The complete check set states no skipped case, because the aggregate folds one skip into review.",
        ));
    }
    Ok(())
}

/// Parses the slice rows of one report at `base`.
///
/// The slices fold subsets of the same cases, so their metric sets cross
/// the structural gate of [`parse_metric_set`] without the case
/// cross-checks.
fn parse_reported_slices(
    root: &serde_json::Map<String, Value>,
    base: &str,
    metric_sets: &BTreeMap<String, ReportedMetricSet>,
) -> Result<(), ValidationError> {
    let Some(raw_slices) = root.get("slices") else {
        return Ok(());
    };
    let Value::Array(items) = raw_slices else {
        return Err(ValidationError::invalid_field_type(
            at(base, "/slices"),
            "The slices field must hold one array.",
        ));
    };
    let mut tags: BTreeSet<String> = BTreeSet::new();
    for (index, item) in items.iter().enumerate() {
        let slice_base = at(base, &format!("/slices/{index}"));
        let slice = crate::artifact::expect_object(item, &slice_base)?;
        crate::artifact::reject_unknown_fields(slice, &["tag", "metrics"], &slice_base)?;
        let tag = parse_bounded_string(
            slice.get("tag"),
            &at(&slice_base, "/tag"),
            64,
            "The slice tag",
        )?
        .ok_or_else(|| ValidationError::missing(at(&slice_base, "/tag")))?;
        if !tags.insert(tag.clone()) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                at(&slice_base, "/tag"),
                format!("The slice tag {} repeats an earlier slice.", fragment(&tag)),
            ));
        }
        let raw_rows = match slice.get("metrics") {
            Some(Value::Array(rows)) if !rows.is_empty() => rows,
            Some(_) => {
                return Err(ValidationError::invalid_field_type(
                    at(&slice_base, "/metrics"),
                    "The slice metrics must hold one nonempty array.",
                ));
            }
            None => return Err(ValidationError::missing(at(&slice_base, "/metrics"))),
        };
        let mut scopes: BTreeSet<String> = BTreeSet::new();
        for (row, item) in raw_rows.iter().enumerate() {
            let row_base = at(&slice_base, &format!("/metrics/{row}"));
            let set = parse_metric_set(item, &row_base)?;
            if !metric_sets.contains_key(&set.scope) {
                return Err(ValidationError::new(
                    ReasonCode::UnknownField,
                    at(&row_base, "/scope"),
                    format!(
                        "The scope {} names no scope of the report.",
                        fragment(&set.scope)
                    ),
                ));
            }
            if !scopes.insert(set.scope.clone()) {
                return Err(ValidationError::new(
                    ReasonCode::DuplicateId,
                    at(&row_base, "/scope"),
                    format!(
                        "The scope {} repeats an earlier set of this slice.",
                        fragment(&set.scope)
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// Parses the operational block of one report at `base`. The comparison
/// reads the latency and the usage, but the stored block crosses whole.
fn parse_reported_operational(
    root: &serde_json::Map<String, Value>,
    base: &str,
) -> Result<(Option<f64>, BTreeMap<String, f64>), ValidationError> {
    let mut elapsed_ms = None;
    let mut usage = BTreeMap::new();
    let Some(raw_operational) = root.get("operational") else {
        return Ok((elapsed_ms, usage));
    };
    let block_base = at(base, "/operational");
    let block = crate::artifact::expect_object(raw_operational, &block_base)?;
    crate::artifact::reject_unknown_fields(block, &OPERATIONAL_FIELDS, &block_base)?;
    if let Some(raw_errors) = block.get("errors") {
        let Value::Array(items) = raw_errors else {
            return Err(ValidationError::invalid_field_type(
                at(&block_base, "/errors"),
                "The errors field must hold one array.",
            ));
        };
        for (index, item) in items.iter().enumerate() {
            parse_reason(item, &at(&block_base, &format!("/errors/{index}")))?;
        }
    }
    if let Some(raw_attempts) = block.get("attempts") {
        if raw_attempts.as_u64().is_none() {
            return Err(ValidationError::invalid_field_type(
                at(&block_base, "/attempts"),
                "The attempt count must hold one integer of at least zero.",
            ));
        }
    }
    if let Some(raw_elapsed) = block.get("elapsed_ms") {
        let Some(value) = raw_elapsed.as_f64() else {
            return Err(ValidationError::invalid_field_type(
                at(&block_base, "/elapsed_ms"),
                "The elapsed time must hold one number.",
            ));
        };
        if value < 0.0 {
            return Err(ValidationError::invalid_field_type(
                at(&block_base, "/elapsed_ms"),
                "The elapsed time must be zero or positive.",
            ));
        }
        elapsed_ms = Some(value);
    }
    if let Some(raw_usage) = block.get("usage") {
        usage = parse_usage_map(raw_usage, &at(&block_base, "/usage"))?;
    }
    Ok((elapsed_ms, usage))
}

/// Parses one usage map at `base`.
fn parse_usage_map(value: &Value, base: &str) -> Result<BTreeMap<String, f64>, ValidationError> {
    let map = crate::artifact::expect_object(value, base)?;
    let mut usage = BTreeMap::new();
    for (key, entry) in map {
        if key.is_empty() || key.chars().count() > MAX_COST_KEY_CHARS {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/{key}"),
                "Each usage key must hold 1 to 128 characters.",
            ));
        }
        let Some(amount) = entry.as_f64() else {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/{key}"),
                "Each usage amount must hold one number.",
            ));
        };
        if amount < 0.0 {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/{key}"),
                "Each usage amount must be zero or positive.",
            ));
        }
        usage.insert(key.clone(), amount);
    }
    Ok(usage)
}

/// Parses one dataset identity at `base`.
fn parse_dataset_reference(
    value: Option<&Value>,
    base: &str,
) -> Result<DatasetReference, ValidationError> {
    let map =
        crate::artifact::expect_object(value.ok_or_else(|| ValidationError::missing(base))?, base)?;
    crate::artifact::reject_unknown_fields(map, &["id", "revision", "content_hash"], base)?;
    let id = match map.get("id") {
        Some(Value::String(text)) if crate::definition::is_artifact_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                at(base, "/id"),
                "The dataset identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing(at(base, "/id"))),
    };
    let revision = parse_bounded_string(
        map.get("revision"),
        &at(base, "/revision"),
        64,
        "The dataset revision",
    )?
    .ok_or_else(|| ValidationError::missing(at(base, "/revision")))?;
    let content_hash = match map.get("content_hash") {
        Some(Value::String(text)) if crate::hashing::is_hash_hex(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                at(base, "/content_hash"),
                "The content hash must hold 64 lowercase hexadecimal characters.",
            ));
        }
        None => return Err(ValidationError::missing(at(base, "/content_hash"))),
    };
    Ok(DatasetReference {
        id,
        revision,
        content_hash,
    })
}

/// Returns the computed cost of one usage record, or `None` when the
/// declared costs cover no usage or miss one recorded key.
fn cost_of(usage: &BTreeMap<String, f64>, costs: &BTreeMap<String, f64>) -> Option<f64> {
    if usage.is_empty() {
        return None;
    }
    let mut total = 0.0;
    for (key, amount) in usage {
        let unit = *costs.get(key)?;
        total += unit * amount;
    }
    Some(total)
}

/// Matches the two rebuilt reports and collects the changed cases.
///
/// A case matches only when its identifier and its input hash agree in
/// both reports. The changed cases follow baseline order, and every list
/// of the matching follows the identifier order, so one reordered report
/// changes no result.
fn match_reports(
    baseline: &EvaluationReport,
    candidate: &EvaluationReport,
) -> Result<(Matching, Vec<ChangedCase>), ValidationError> {
    let candidate_cases: BTreeMap<&str, &ReportedCase> = candidate
        .cases
        .iter()
        .map(|case| (case.id.as_str(), case))
        .collect();
    let baseline_ids: BTreeSet<&str> = baseline.cases.iter().map(|case| case.id.as_str()).collect();
    let mut changed_input_cases = BTreeSet::new();
    let mut missing_in_candidate = Vec::new();
    let mut errored_cases = BTreeSet::new();
    let mut skipped_cases = BTreeSet::new();
    let mut changed = Vec::new();
    let mut matched_cases = 0;
    for case in &baseline.cases {
        let Some(other) = candidate_cases.get(case.id.as_str()) else {
            missing_in_candidate.push(case.id.clone());
            continue;
        };
        if case.input_hash != other.input_hash {
            changed_input_cases.insert(case.id.clone());
            continue;
        }
        matched_cases += 1;
        let mut checks = Vec::new();
        for scope in &baseline.scope_order {
            if scope == ALL_CHECKS {
                continue;
            }
            let before = case.outcomes[scope];
            let after = other.outcomes[scope];
            if before != after {
                checks.push(ChangedCheck {
                    check: scope.clone(),
                    baseline: before,
                    candidate: after,
                });
            }
        }
        if !checks.is_empty() {
            changed.push(ChangedCase {
                id: case.id.clone(),
                checks,
                baseline_aggregate: case.aggregate,
                candidate_aggregate: other.aggregate,
            });
        }
        let holds = |outcome: Outcome| {
            case.outcomes
                .values()
                .chain(other.outcomes.values())
                .any(|stated| *stated == outcome)
        };
        if holds(Outcome::Error) {
            errored_cases.insert(case.id.clone());
        }
        if holds(Outcome::Skipped) {
            skipped_cases.insert(case.id.clone());
        }
    }
    if matched_cases == 0 {
        return Err(ValidationError::new(
            ReasonCode::InsufficientEvidence,
            "/matching",
            "No case of the two reports states one equal identifier with one equal input hash. No tradeoff covers one shared case. Measure one report set again over the cases of the other.",
        ));
    }
    let missing_in_baseline: Vec<String> = candidate
        .cases
        .iter()
        .filter(|case| !baseline_ids.contains(case.id.as_str()))
        .map(|case| case.id.clone())
        .collect();
    Ok((
        Matching {
            matched_cases,
            changed_input_cases: changed_input_cases.into_iter().collect(),
            missing_in_candidate,
            missing_in_baseline,
            errored_cases: errored_cases.into_iter().collect(),
            skipped_cases: skipped_cases.into_iter().collect(),
        },
        changed,
    ))
}

/// Builds the metric rows and the tradeoff rows of one comparison.
fn metric_rows(
    baseline: &EvaluationReport,
    candidate: &EvaluationReport,
) -> (Vec<MetricTradeoff>, Vec<MetricRow>) {
    let mut tradeoffs = Vec::new();
    let mut rows = Vec::new();
    for scope in &baseline.scope_order {
        for metric in MetricName::ALL {
            let before = baseline.rate(scope, metric);
            let after = candidate.rate(scope, metric);
            tradeoffs.push(MetricTradeoff {
                scope: scope.clone(),
                metric,
                baseline_value: before.value,
                candidate_value: after.value,
            });
            rows.push(MetricRow {
                scope: scope.clone(),
                metric,
                baseline: *before,
                candidate: *after,
            });
        }
    }
    (tradeoffs, rows)
}

/// Compares two stored evaluation reports on their matching cases.
///
/// Both values are evaluation report artifacts. `baseline_ref` and
/// `candidate_ref` name where the host stored the two reports, and the
/// comparison artifact states them beside the profile references. The
/// costs map one usage key to its unit cost; one cost appears only when
/// the recorded usage of that side and the declared cost inputs support
/// it.
///
/// A case matches only when its identifier and its input hash agree in
/// both reports. The comparison refuses with `definition_mismatch` when
/// the two reports bind different definitions, and with
/// `insufficient_evidence` at `/matching` when no case matches, because no
/// tradeoff then covers one shared case.
///
/// # Errors
///
/// Returns a [`ValidationError`] when one stored report breaks its
/// contract, with every path under `/baseline` or `/candidate`, when one
/// stored-report reference breaks its bound, when the two reports bind
/// different definitions or state different checks, or when no case
/// matches.
pub fn compare_reports(
    baseline_value: &Value,
    candidate_value: &Value,
    baseline_ref: &str,
    candidate_ref: &str,
    costs: &BTreeMap<String, f64>,
) -> Result<Comparison, ValidationError> {
    for (reference, path) in [
        (baseline_ref, "/baselineReport"),
        (candidate_ref, "/candidateReport"),
    ] {
        if reference.is_empty() || reference.chars().count() > MAX_REPORT_REF_CHARS {
            return Err(ValidationError::invalid_field_type(
                path,
                "The stored-report reference must hold 1 to 500 characters.",
            ));
        }
    }
    let baseline = parse_evaluation_report(baseline_value, "/baseline")?;
    let candidate = parse_evaluation_report(candidate_value, "/candidate")?;

    if baseline.definition != candidate.definition {
        return Err(ValidationError::new(
            ReasonCode::DefinitionMismatch,
            "/candidate/definition/content_hash",
            "The candidate report binds another definition. Compare the reports of one definition, because one comparison states one check meaning.",
        ));
    }
    let baseline_scopes: BTreeSet<&str> = baseline.scope_order.iter().map(String::as_str).collect();
    let candidate_scopes: BTreeSet<&str> =
        candidate.scope_order.iter().map(String::as_str).collect();
    if baseline_scopes != candidate_scopes {
        return Err(ValidationError::invalid_field_type(
            "/candidate/metrics",
            "The candidate report states another check set. Compare the reports of one definition, because one metric row names one scope.",
        ));
    }

    let (matching, changed) = match_reports(&baseline, &candidate)?;
    let (tradeoff_rows, rows) = metric_rows(&baseline, &candidate);

    // The latency, the usage, and the cost of both sides. One side states
    // one number only when its report recorded one.
    let elapsed_ms = (baseline.elapsed_ms.is_some() || candidate.elapsed_ms.is_some()).then_some(
        ElapsedTradeoff {
            baseline: baseline.elapsed_ms,
            candidate: candidate.elapsed_ms,
        },
    );
    let usage =
        (!baseline.usage.is_empty() || !candidate.usage.is_empty()).then_some(UsageTradeoff {
            baseline: (!baseline.usage.is_empty()).then(|| baseline.usage.clone()),
            candidate: (!candidate.usage.is_empty()).then(|| candidate.usage.clone()),
        });
    let baseline_cost = cost_of(&baseline.usage, costs);
    let candidate_cost = cost_of(&candidate.usage, costs);
    let cost = match (baseline_cost, candidate_cost) {
        (None, None) => None,
        _ => {
            let mut cost = BTreeMap::new();
            if let Some(value) = baseline_cost {
                cost.insert("baseline".to_owned(), value);
            }
            if let Some(value) = candidate_cost {
                cost.insert("candidate".to_owned(), value);
            }
            Some(cost)
        }
    };

    // One fitting evaluation makes the whole comparison one fitting
    // comparison.
    let evidence_class = if baseline.purpose == EvaluationPurpose::IndependentValidation
        && candidate.purpose == EvaluationPurpose::IndependentValidation
    {
        EvidenceClass::IndependentValidation
    } else {
        EvidenceClass::Fitting
    };

    let limitations = limitations_of(&baseline, &candidate, &matching, evidence_class, costs);

    Ok(Comparison {
        schema_version: crate::CONTRACT_SCHEMA_VERSION,
        baseline: ReportSet {
            profile: baseline.profile.clone(),
            report: baseline_ref.to_owned(),
        },
        candidate: ReportSet {
            profile: candidate.profile.clone(),
            report: candidate_ref.to_owned(),
        },
        evidence_class,
        matching,
        changed,
        tradeoffs: Tradeoffs {
            metrics: tradeoff_rows,
            elapsed_ms,
            usage,
            cost,
        },
        metrics: rows,
        limitations,
    })
}

/// Builds the standing limits of one comparison.
fn limitations_of(
    baseline: &EvaluationReport,
    candidate: &EvaluationReport,
    matching: &Matching,
    evidence_class: EvidenceClass,
    costs: &BTreeMap<String, f64>,
) -> Vec<String> {
    let mut limitations = vec![
        match evidence_class {
            EvidenceClass::Fitting => FITTING_COMPARISON,
            EvidenceClass::IndependentValidation => VALIDATION_COMPARISON,
        }
        .to_owned(),
        DENOMINATOR_RULE.to_owned(),
        NEW_MEASUREMENTS.to_owned(),
    ];
    if !matching.changed_input_cases.is_empty() {
        let count = matching.changed_input_cases.len();
        limitations.push(format!(
            "{count} case{} of the two reports hold{} one changed input hash. Their outcomes never match. Measure these cases again before you compare the two profiles.",
            if count == 1 { "" } else { "s" },
            if count == 1 { "s" } else { "" },
        ));
    }
    if !matching.missing_in_candidate.is_empty() || !matching.missing_in_baseline.is_empty() {
        let omitted = matching.missing_in_candidate.len();
        let added = matching.missing_in_baseline.len();
        limitations.push(format!(
            "The candidate report omits {omitted} case{} of the baseline, and the baseline omits {added} case{} of the candidate. No metric row covers one omitted case.",
            if omitted == 1 { "" } else { "s" },
            if added == 1 { "" } else { "s" },
        ));
    }
    if !matching.errored_cases.is_empty() || !matching.skipped_cases.is_empty() {
        let errored = matching.errored_cases.len();
        let skipped = matching.skipped_cases.len();
        limitations.push(format!(
            "The matched cases hold {errored} case{} with one error outcome and {skipped} case{} with one skipped outcome. One error and one skip decided nothing.",
            if errored == 1 { "" } else { "s" },
            if skipped == 1 { "" } else { "s" },
        ));
    }
    for (side, report) in [("baseline", baseline), ("candidate", candidate)] {
        if report.usage.is_empty() || cost_of(&report.usage, costs).is_some() {
            continue;
        }
        let uncovered: Vec<String> = report
            .usage
            .keys()
            .filter(|key| !costs.contains_key(*key))
            .take(3)
            .map(|key| fragment(key))
            .collect();
        limitations.push(format!(
            "The {side} report recorded usage that the declared costs do not cover: {}. Its cost stays absent.",
            uncovered.join(", ")
        ));
    }
    limitations
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One 64-character hexadecimal hash from one repeated character.
    fn hash_hex(character: char) -> String {
        std::iter::repeat_n(character, 64).collect()
    }

    /// One case of one report artifact.
    #[derive(Clone)]
    struct CaseSpec {
        id: &'static str,
        hash: char,
        outcomes: Vec<(&'static str, &'static str)>,
        aggregate: &'static str,
        labeled: bool,
    }

    /// Clones one case spec with new outcomes.
    fn reoutcomed(case: &CaseSpec, outcomes: Vec<(&'static str, &'static str)>) -> CaseSpec {
        let aggregate = if outcomes.iter().any(|(_, outcome)| *outcome == "fail") {
            "fail"
        } else if outcomes.iter().any(|(_, outcome)| *outcome == "error") {
            "error"
        } else if outcomes
            .iter()
            .any(|(_, outcome)| *outcome == "review" || *outcome == "skipped")
        {
            "review"
        } else {
            "pass"
        };
        CaseSpec {
            id: case.id,
            hash: case.hash,
            outcomes,
            aggregate,
            labeled: case.labeled,
        }
    }

    /// Builds one evaluation report artifact from its cases. The metric
    /// sets stay consistent with the cases: the counts tally the outcomes,
    /// the whole-population denominators equal the case count, and the
    /// label coverage counts the labeled cases.
    fn artifact(
        definition: char,
        profile: char,
        purpose: &str,
        cases: &[CaseSpec],
        elapsed_ms: Option<f64>,
        usage: Option<Value>,
    ) -> Value {
        let checks: Vec<&str> = cases
            .first()
            .expect("one case")
            .outcomes
            .iter()
            .map(|(check, _)| *check)
            .collect();
        let mut metric_sets = Vec::new();
        for scope in checks.iter().copied().map(Some).chain([None]) {
            let scope_name = scope.unwrap_or(ALL_CHECKS);
            let mut counts = serde_json::Map::new();
            for outcome in ["pass", "fail", "review", "error", "skipped"] {
                let tally = cases
                    .iter()
                    .filter(|case| {
                        let stated = case
                            .outcomes
                            .iter()
                            .find(|(name, _)| *name == scope_name)
                            .map(|(_, outcome)| *outcome)
                            .or(if scope.is_none() {
                                Some(case.aggregate)
                            } else {
                                None
                            });
                        stated == Some(outcome)
                    })
                    .count();
                counts.insert(outcome.to_owned(), json!(tally));
            }
            let total = cases.len();
            let labeled = cases.iter().filter(|case| case.labeled).count();
            let review_and_skip = counts["review"].as_u64().expect("a count")
                + counts["skipped"].as_u64().expect("a count");
            let automatic = counts["pass"].as_u64().expect("a count")
                + counts["fail"].as_u64().expect("a count");
            metric_sets.push(json!({
                "scope": scope_name,
                "counts": counts,
                "rates": [
                    {"metric": "false_acceptance_rate", "numerator": 0, "denominator": 0, "value": null},
                    {"metric": "error_among_accepted", "numerator": 0, "denominator": 0, "value": null},
                    {"metric": "false_rejection_rate", "numerator": 0, "denominator": 0, "value": null},
                    {"metric": "review_rate", "numerator": review_and_skip, "denominator": total, "value": review_and_skip as f64 / total as f64},
                    {"metric": "automatic_coverage", "numerator": automatic, "denominator": total, "value": automatic as f64 / total as f64},
                    {"metric": "label_coverage", "numerator": labeled, "denominator": total, "value": labeled as f64 / total as f64},
                ],
            }));
        }
        let mut reported_cases = Vec::new();
        for case in cases {
            let outcomes: serde_json::Map<String, Value> = case
                .outcomes
                .iter()
                .map(|(check, outcome)| ((*check).to_owned(), json!(outcome)))
                .collect();
            let matches: serde_json::Map<String, Value> = case
                .outcomes
                .iter()
                .map(|(check, _)| {
                    (
                        (*check).to_owned(),
                        if case.labeled {
                            json!(true)
                        } else {
                            Value::Null
                        },
                    )
                })
                .collect();
            reported_cases.push(json!({
                "id": case.id,
                "input_hash": hash_hex(case.hash),
                "outcomes": outcomes,
                "aggregate": case.aggregate,
                "completion": "completed",
                "reference_match": matches,
            }));
        }
        let mut operational = json!({"errors": [], "attempts": cases.len()});
        if let Some(value) = elapsed_ms {
            operational["elapsed_ms"] = json!(value);
        }
        if let Some(value) = usage {
            operational["usage"] = value;
        }
        json!({
            "schema_version": 1,
            "definition": {"name": "notes-review", "content_hash": hash_hex(definition)},
            "profile": {"id": "notes-profile", "content_hash": hash_hex(profile)},
            "dataset": {"id": "notes-cases", "revision": "2026-09-24.1", "content_hash": hash_hex('e')},
            "purpose": purpose,
            "cases": reported_cases,
            "metrics": metric_sets,
            "operational": operational,
        })
    }

    /// Two cases over two checks, the shared shape of the tests.
    fn standard_cases() -> Vec<CaseSpec> {
        vec![
            CaseSpec {
                id: "case-1",
                hash: 'c',
                outcomes: vec![("notes-complete", "pass"), ("summary-clean", "pass")],
                aggregate: "pass",
                labeled: true,
            },
            CaseSpec {
                id: "case-2",
                hash: 'd',
                outcomes: vec![("notes-complete", "fail"), ("summary-clean", "pass")],
                aggregate: "fail",
                labeled: true,
            },
        ]
    }

    #[test]
    fn one_stored_report_rebuilds_through_its_contract() {
        let value = artifact('a', 'b', "fitting", &standard_cases(), Some(1200.0), None);
        let report = parse_evaluation_report(&value, "").expect("the report parses");
        assert_eq!(report.definition.name, "notes-review");
        assert_eq!(report.profile.id, "notes-profile");
        assert_eq!(report.dataset.id, "notes-cases");
        assert_eq!(report.purpose, EvaluationPurpose::Fitting);
        assert_eq!(report.cases.len(), 2);
        assert_eq!(
            report.scope_order,
            ["notes-complete", "summary-clean", ALL_CHECKS]
        );
        let complete = report.metric_set(ALL_CHECKS).expect("the complete set");
        assert_eq!(complete.counts.pass, 1);
        assert_eq!(complete.counts.fail, 1);
        let question = report.metric_set("notes-complete").expect("the check set");
        assert_eq!(question.counts.fail, 1);
        let coverage = &question.rates[&MetricName::LabelCoverage];
        assert_eq!((coverage.numerator, coverage.denominator), (2, 2));
        assert_eq!(report.elapsed_ms, Some(1200.0));
        // The purpose words round trip.
        for (word, purpose) in [
            ("exploration", EvaluationPurpose::Exploration),
            ("fitting", EvaluationPurpose::Fitting),
            (
                "independent_validation",
                EvaluationPurpose::IndependentValidation,
            ),
        ] {
            assert_eq!(EvaluationPurpose::from_word(word), Some(purpose));
            assert_eq!(purpose.as_str(), word);
        }
        assert_eq!(EvaluationPurpose::from_word("validation"), None);
    }

    #[test]
    fn edited_copies_fail_with_their_field_paths() {
        let value = artifact('a', 'b', "fitting", &standard_cases(), None, None);
        // The aggregate no longer folds from the component outcomes.
        let mut edited = value.clone();
        edited["cases"][0]["aggregate"] = json!("fail");
        let error = parse_evaluation_report(&edited, "/baseline").unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/baseline/cases/0/aggregate");
        // One case omits one check of the report.
        let mut edited = value.clone();
        edited["cases"][1]["outcomes"]
            .as_object_mut()
            .expect("an object")
            .remove("summary-clean");
        edited["cases"][1]["reference_match"]
            .as_object_mut()
            .expect("an object")
            .remove("summary-clean");
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/cases/1/outcomes/summary-clean");
        // One repeated case identifier.
        let mut edited = value.clone();
        edited["cases"][1]["id"] = json!("case-1");
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::DuplicateId);
        assert_eq!(error.field_path, "/cases/1/id");
        // One metric set of the checks of the report is absent.
        let mut edited = value.clone();
        edited["metrics"]
            .as_array_mut()
            .expect("an array")
            .remove(0);
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/metrics");
        assert!(error.message.contains("notes-complete"));
        // The stored counts disagree with the case outcomes.
        let mut edited = value.clone();
        edited["metrics"][0]["counts"]["pass"] = json!(9);
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/metrics/0/counts");
        // One whole-population denominator disagrees with the case count.
        let mut edited = value.clone();
        edited["metrics"][0]["rates"][5]["denominator"] = json!(7);
        edited["metrics"][0]["rates"][5]["value"] = json!(2.0 / 7.0);
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/metrics/0/rates");
        // One value disagrees with its numerator and its denominator.
        let mut edited = value.clone();
        edited["metrics"][0]["rates"][3]["value"] = json!(0.9);
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/metrics/0/rates/3/value");
        // One label coverage disagrees with the labeled cases.
        let mut edited = value.clone();
        edited["metrics"][0]["rates"][5]["numerator"] = json!(1);
        edited["metrics"][0]["rates"][5]["value"] = json!(0.5);
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/metrics/0/rates");
        // One unknown field of the artifact.
        let mut edited = value.clone();
        edited["note"] = json!("edited");
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::UnknownField);
        assert_eq!(error.field_path, "/note");
        // One reference match names no check of the case.
        let mut edited = value.clone();
        edited["cases"][0]["reference_match"]["absent-check"] = json!(true);
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::UnknownField);
        assert_eq!(error.field_path, "/cases/0/reference_match/absent-check");
        // One numerator above its denominator.
        let mut edited = value.clone();
        edited["metrics"][0]["rates"][3]["numerator"] = json!(3);
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/metrics/0/rates/3/numerator");
        // One rate repeats one metric, so one contract metric is absent.
        let mut edited = value.clone();
        edited["metrics"][0]["rates"][4]["metric"] = json!("review_rate");
        let error = parse_evaluation_report(&edited, "").unwrap_err();
        assert_eq!(error.code, ReasonCode::DuplicateId);
        assert_eq!(error.field_path, "/metrics/0/rates/4/metric");
        // One broken envelope refuses before any field parses.
        let error = parse_evaluation_report(&json!("[]"), "").unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
    }

    #[test]
    fn one_comparison_matches_only_equal_ids_with_equal_hashes() {
        let baseline_cases = vec![
            CaseSpec {
                id: "case-1",
                hash: 'c',
                outcomes: vec![("notes-complete", "pass"), ("summary-clean", "pass")],
                aggregate: "pass",
                labeled: true,
            },
            CaseSpec {
                id: "case-2",
                hash: 'd',
                outcomes: vec![("notes-complete", "fail"), ("summary-clean", "pass")],
                aggregate: "fail",
                labeled: true,
            },
            CaseSpec {
                id: "case-3",
                hash: 'e',
                outcomes: vec![("notes-complete", "pass"), ("summary-clean", "pass")],
                aggregate: "pass",
                labeled: false,
            },
        ];
        // The candidate changed the input of case-3, omitted case-2, and
        // added case-4.
        let candidate_cases = vec![
            reoutcomed(
                &baseline_cases[0],
                vec![("notes-complete", "fail"), ("summary-clean", "pass")],
            ),
            CaseSpec {
                id: "case-3",
                hash: 'f',
                outcomes: vec![("notes-complete", "pass"), ("summary-clean", "pass")],
                aggregate: "pass",
                labeled: false,
            },
            CaseSpec {
                id: "case-4",
                hash: '9',
                outcomes: vec![("notes-complete", "pass"), ("summary-clean", "pass")],
                aggregate: "pass",
                labeled: false,
            },
        ];
        let baseline = artifact(
            'a',
            'b',
            "independent_validation",
            &baseline_cases,
            None,
            None,
        );
        let candidate = artifact(
            'a',
            'f',
            "independent_validation",
            &candidate_cases,
            None,
            None,
        );
        let comparison = compare_reports(
            &baseline,
            &candidate,
            "reports/baseline.json",
            "reports/candidate.json",
            &BTreeMap::new(),
        )
        .expect("the comparison builds");

        assert_eq!(comparison.schema_version, 1);
        assert_eq!(
            comparison.evidence_class,
            EvidenceClass::IndependentValidation
        );
        assert_eq!(
            comparison.baseline,
            ReportSet {
                profile: ProfileReference {
                    id: "notes-profile".to_owned(),
                    content_hash: hash_hex('b'),
                },
                report: "reports/baseline.json".to_owned(),
            }
        );
        assert_eq!(comparison.candidate.report, "reports/candidate.json");
        assert_eq!(comparison.matching.matched_cases, 1);
        assert_eq!(comparison.matching.changed_input_cases, ["case-3"]);
        assert_eq!(comparison.matching.missing_in_candidate, ["case-2"]);
        assert_eq!(comparison.matching.missing_in_baseline, ["case-4"]);
        // Case-1 is the one matched case, and its question check changed.
        assert_eq!(comparison.changed.len(), 1);
        let changed = &comparison.changed[0];
        assert_eq!(changed.id, "case-1");
        assert_eq!(changed.checks.len(), 1);
        assert_eq!(changed.checks[0].check, "notes-complete");
        assert_eq!(changed.checks[0].baseline, Outcome::Pass);
        assert_eq!(changed.checks[0].candidate, Outcome::Fail);
        assert_eq!(changed.baseline_aggregate, AggregateOutcome::Pass);
        assert_eq!(changed.candidate_aggregate, AggregateOutcome::Fail);
        // The changed input case appears in no changed entry, whatever its
        // outcomes state.
        assert!(comparison.changed.iter().all(|case| case.id != "case-3"));
        // The limitations state the changed inputs, the omitted cases, and
        // the new-measurement rule.
        assert!(comparison
            .limitations
            .iter()
            .any(|text| text.contains("changed input hash")));
        assert!(comparison
            .limitations
            .iter()
            .any(|text| text.contains("omits 1 case of the baseline")));
        assert!(comparison
            .limitations
            .iter()
            .any(|text| text == NEW_MEASUREMENTS));
    }

    #[test]
    fn errored_and_skipped_matched_cases_stay_listed() {
        let baseline_cases = vec![
            CaseSpec {
                id: "case-1",
                hash: 'c',
                outcomes: vec![("notes-complete", "error"), ("summary-clean", "pass")],
                aggregate: "error",
                labeled: true,
            },
            CaseSpec {
                id: "case-2",
                hash: 'd',
                outcomes: vec![("notes-complete", "pass"), ("summary-clean", "skipped")],
                aggregate: "review",
                labeled: true,
            },
        ];
        // The candidate resolved the error of case-1. The skip of case-2
        // stays.
        let candidate_cases = vec![
            reoutcomed(
                &baseline_cases[0],
                vec![("notes-complete", "pass"), ("summary-clean", "pass")],
            ),
            baseline_cases[1].clone(),
        ];
        let baseline = artifact('a', 'b', "fitting", &baseline_cases, None, None);
        let candidate = artifact('a', 'f', "fitting", &candidate_cases, None, None);
        let comparison = compare_reports(
            &baseline,
            &candidate,
            "r/b.json",
            "r/c.json",
            &BTreeMap::new(),
        )
        .expect("the comparison builds");
        // Case-1 holds one baseline error, case-2 one skip on both sides.
        assert_eq!(comparison.matching.errored_cases, ["case-1"]);
        assert_eq!(comparison.matching.skipped_cases, ["case-2"]);
        // The error of case-1 changed into one pass, so the case appears
        // under changed too. The skip of case-2 never changed.
        assert_eq!(comparison.changed.len(), 1);
        assert_eq!(comparison.changed[0].id, "case-1");
        assert!(comparison
            .limitations
            .iter()
            .any(|text| text.contains("one error outcome")));
    }

    #[test]
    fn one_fitting_purpose_makes_the_whole_comparison_fitting() {
        let cases = standard_cases();
        for (baseline_purpose, candidate_purpose, class) in [
            (
                "independent_validation",
                "independent_validation",
                EvidenceClass::IndependentValidation,
            ),
            ("fitting", "independent_validation", EvidenceClass::Fitting),
            (
                "independent_validation",
                "exploration",
                EvidenceClass::Fitting,
            ),
            ("exploration", "fitting", EvidenceClass::Fitting),
        ] {
            let baseline = artifact('a', 'b', baseline_purpose, &cases, None, None);
            let candidate = artifact('a', 'f', candidate_purpose, &cases, None, None);
            let comparison = compare_reports(
                &baseline,
                &candidate,
                "r/b.json",
                "r/c.json",
                &BTreeMap::new(),
            )
            .expect("the comparison builds");
            assert_eq!(comparison.evidence_class, class);
            let expected = match class {
                EvidenceClass::Fitting => FITTING_COMPARISON,
                EvidenceClass::IndependentValidation => VALIDATION_COMPARISON,
            };
            assert!(comparison.limitations.contains(&expected.to_owned()));
        }
    }

    #[test]
    fn metric_rows_keep_their_counts_and_denominators() {
        let baseline = artifact('a', 'b', "fitting", &standard_cases(), None, None);
        // The candidate holds one unlabeled case, so its label coverage
        // differs while its case count stays.
        let mut candidate_cases = standard_cases();
        candidate_cases[1].labeled = false;
        let candidate = artifact('a', 'f', "fitting", &candidate_cases, None, None);
        let comparison = compare_reports(
            &baseline,
            &candidate,
            "r/b.json",
            "r/c.json",
            &BTreeMap::new(),
        )
        .expect("the comparison builds");
        // One row per scope and metric, in the scope order of the baseline.
        assert_eq!(comparison.metrics.len(), 3 * MetricName::ALL.len());
        assert_eq!(comparison.metrics[0].scope, "notes-complete");
        assert_eq!(
            comparison.metrics[0].metric,
            MetricName::FalseAcceptanceRate
        );
        let coverage = comparison
            .metrics
            .iter()
            .find(|row| row.scope == "notes-complete" && row.metric == MetricName::LabelCoverage)
            .expect("the coverage row");
        assert_eq!(
            (coverage.baseline.numerator, coverage.baseline.denominator),
            (2, 2)
        );
        assert_eq!(
            (coverage.candidate.numerator, coverage.candidate.denominator),
            (1, 2)
        );
        assert_eq!(coverage.baseline.value, Some(1.0));
        assert_eq!(coverage.candidate.value, Some(0.5));
        // The tradeoff rows state the two values beside each other.
        let tradeoff = comparison
            .tradeoffs
            .metrics
            .iter()
            .find(|row| row.scope == "notes-complete" && row.metric == MetricName::LabelCoverage)
            .expect("the tradeoff row");
        assert_eq!(tradeoff.baseline_value, Some(1.0));
        assert_eq!(tradeoff.candidate_value, Some(0.5));
    }

    #[test]
    fn latency_usage_and_cost_need_recorded_data_and_declared_costs() {
        let baseline = artifact(
            'a',
            'b',
            "fitting",
            &standard_cases(),
            Some(1200.0),
            Some(json!({"input_tokens": 100.0, "output_tokens": 40.0})),
        );
        // The candidate recorded no latency and one usage key the costs do
        // not cover.
        let candidate = artifact(
            'a',
            'f',
            "fitting",
            &standard_cases(),
            None,
            Some(json!({"input_tokens": 200.0, "requests": 5.0})),
        );
        let costs = BTreeMap::from([
            ("input_tokens".to_owned(), 0.001),
            ("output_tokens".to_owned(), 0.002),
        ]);
        let comparison = compare_reports(&baseline, &candidate, "r/b.json", "r/c.json", &costs)
            .expect("the comparison builds");
        let elapsed = comparison.tradeoffs.elapsed_ms.expect("one latency row");
        assert_eq!(elapsed.baseline, Some(1200.0));
        assert_eq!(elapsed.candidate, None);
        let usage = comparison.tradeoffs.usage.expect("one usage row");
        assert_eq!(
            usage.baseline.expect("one baseline usage"),
            BTreeMap::from([
                ("input_tokens".to_owned(), 100.0),
                ("output_tokens".to_owned(), 40.0),
            ])
        );
        assert_eq!(
            usage.candidate.expect("one candidate usage"),
            BTreeMap::from([
                ("input_tokens".to_owned(), 200.0),
                ("requests".to_owned(), 5.0),
            ])
        );
        // The baseline cost covers every recorded key. The candidate cost
        // stays absent, because no declared cost covers its records.
        let cost = comparison.tradeoffs.cost.expect("one cost row");
        assert_eq!(cost.len(), 1);
        assert_eq!(cost["baseline"], 0.001 * 100.0 + 0.002 * 40.0);
        assert!(!cost.contains_key("candidate"));
        assert!(comparison
            .limitations
            .iter()
            .any(|text| text.contains("declared costs do not cover")));

        // Without declared costs no cost appears.
        let comparison = compare_reports(
            &baseline,
            &candidate,
            "r/b.json",
            "r/c.json",
            &BTreeMap::new(),
        )
        .expect("the comparison builds");
        assert!(comparison.tradeoffs.cost.is_none());
    }

    #[test]
    fn broken_comparisons_report_their_codes_and_paths() {
        let cases = standard_cases();
        let baseline = artifact('a', 'b', "fitting", &cases, None, None);
        let candidate = artifact('a', 'f', "fitting", &cases, None, None);

        // One report of another definition.
        let foreign = artifact('b', 'f', "fitting", &cases, None, None);
        let error = compare_reports(
            &baseline,
            &foreign,
            "r/b.json",
            "r/c.json",
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert_eq!(error.code, ReasonCode::DefinitionMismatch);
        assert_eq!(error.field_path, "/candidate/definition/content_hash");

        // No case matches, because every input hash changed.
        let mut other_hash = cases.clone();
        for case in &mut other_hash {
            case.hash = '9';
        }
        let disjoint = artifact('a', 'f', "fitting", &other_hash, None, None);
        let error = compare_reports(
            &baseline,
            &disjoint,
            "r/b.json",
            "r/c.json",
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert_eq!(error.code, ReasonCode::InsufficientEvidence);
        assert_eq!(error.field_path, "/matching");

        // One edited stored report fails under its own side.
        let mut edited = candidate.clone();
        edited["cases"][0]["input_hash"] = json!("not-a-hash");
        let error = compare_reports(&baseline, &edited, "r/b.json", "r/c.json", &BTreeMap::new())
            .unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/candidate/cases/0/input_hash");

        // One broken stored-report reference.
        let error =
            compare_reports(&baseline, &candidate, "", "r/c.json", &BTreeMap::new()).unwrap_err();
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/baselineReport");
        let error = compare_reports(
            &baseline,
            &candidate,
            "r/b.json",
            &"x".repeat(501),
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert_eq!(error.field_path, "/candidateReport");

        // One broken cost input.
        assert_eq!(
            parse_cost_inputs(&json!({"input_tokens": -1.0}))
                .unwrap_err()
                .code,
            ReasonCode::InvalidFieldType
        );
        assert_eq!(
            parse_cost_inputs(&json!(1)).unwrap_err().field_path,
            "/costs"
        );
        assert_eq!(
            parse_cost_inputs(&json!({"k".repeat(129): 1.0}))
                .unwrap_err()
                .field_path,
            "/costs"
        );
        assert_eq!(
            parse_cost_inputs(&json!({"input_tokens": "1"}))
                .unwrap_err()
                .field_path,
            "/costs/input_tokens"
        );
    }

    #[test]
    fn the_artifact_serializes_inside_the_frozen_schema() {
        let baseline = artifact(
            'a',
            'b',
            "fitting",
            &standard_cases(),
            Some(1200.0),
            Some(json!({"input_tokens": 100.0})),
        );
        let candidate = artifact('a', 'f', "fitting", &standard_cases(), None, None);
        let comparison = compare_reports(
            &baseline,
            &candidate,
            "r/b.json",
            "r/c.json",
            &BTreeMap::from([("input_tokens".to_owned(), 0.5)]),
        )
        .expect("the comparison builds");
        let value = serde_json::to_value(&comparison).expect("the comparison serializes");
        // The artifact fields and the two public fields sit beside each
        // other.
        let keys: BTreeSet<&str> = value
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "baseline",
                "candidate",
                "changed",
                "evidence_class",
                "limitations",
                "matching",
                "metrics",
                "schema_version",
                "tradeoffs",
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(value["evidence_class"], "fitting");
        assert_eq!(value["matching"]["matched_cases"], 2);
        assert_eq!(value["tradeoffs"]["cost"]["baseline"], 50.0);
        assert_eq!(value["tradeoffs"]["elapsed_ms"]["baseline"], 1200.0);
        assert!(value["tradeoffs"]["elapsed_ms"].get("candidate").is_none());
        // The comparison holds no raw case content: the identifiers, the
        // hashes, and the host references alone cross.
        let text = value.to_string();
        assert!(
            !text.contains("\"outcomes\""),
            "one case outcome map leaked"
        );
        assert!(!text.contains("input\""), "one case input leaked");
    }
}
