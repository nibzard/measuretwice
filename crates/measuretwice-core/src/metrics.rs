// SPDX-License-Identifier: Apache-2.0
//! Evaluation metrics with explicit counts and denominators.
//!
//! An evaluation runs labeled cases through the same execution path as an
//! ordinary run and then measures the outcomes against the reference
//! labels, as MVP_SPEC.md section 10 states. This module owns the
//! measurement half. It computes no interval and states no qualification;
//! the uncertainty methods of one later task add them.
//!
//! The module answers three questions:
//!
//! - What did the policy predict? [`CaseOutcome`] carries the component
//!   outcome of every check, the aggregate outcome, the completion status,
//!   and the operational measurements of one evaluated case.
//!   [`CaseOutcome::from_report`] reads them out of one immutable
//!   [`RunReport`](crate::report::RunReport).
//! - What does the reference state? [`reference_outcome`] resolves one
//!   check reference of a dataset record into the outcome it means: the
//!   stated expected outcome when the record states one, otherwise the
//!   acceptance meaning of its answer, level, or review marker, read from
//!   the same answer sets the decision policy reads. One record without a
//!   reference for that check holds no reference outcome.
//! - How do the two compare? [`evaluate_metrics`] folds one validated
//!   dataset and its evaluated cases into [`MetricSet`] values: predicted
//!   outcome counts, one [`ConfusionMatrix`] over the reference
//!   categories, and the six contract rates, each with its numerator and
//!   its denominator.
//!
//! The metric definitions, with their exact numerators and denominators:
//!
//! - `false_acceptance_rate`: predicted passes among reference fail and
//!   reference review cases. Denominator: every labeled case whose
//!   reference states fail or review, including one that errored or was
//!   skipped. An operational failure never leaves the denominator.
//! - `error_among_accepted`: reference fail and reference review cases
//!   among predicted passes. Denominator: the labeled predicted passes.
//!   The numerator equals the one of the false acceptance rate; the two
//!   metrics answer different questions, and the contracts README keeps
//!   them apart.
//! - `false_rejection_rate`: predicted failures among reference pass
//!   cases. Denominator: every labeled case whose reference states pass.
//! - `review_rate`: predicted review and predicted skipped cases over all
//!   evaluated cases. One skipped check needs one human decision the same
//!   way one review outcome does, and the aggregate already folds one
//!   skip into review.
//! - `automatic_coverage`: predicted passes and predicted failures over
//!   all evaluated cases. This metric needs no reference label.
//! - `label_coverage`: evaluated cases that hold a reference outcome over
//!   all evaluated cases of the scope.
//!
//! Missing labels leave only the metrics that need them: the three error
//! rates count labeled cases alone, the two coverage rates count every
//! evaluated case, and `label_coverage` states the share of the scope that
//! carries one reference. Errors and skips leave no metric: they stay in
//! the counts of every metric set and in the denominator of every rate
//! whose population holds them.
//!
//! One rate with a zero denominator holds no value. `value` stays `None`
//! and [`Rate::is_unavailable`] states the fact, as the `zero_denominator`
//! reason of the registry names it. Unavailable is one valid result, not
//! one failure.
//!
//! Every metric set of one evaluation covers the same cases, so the
//! complete check set is one measurement, not independent evidence.
//! [`EvaluationMetrics::independence`] states this on every result, and no
//! field of this module claims independence between checks.

use crate::dataset::{ExpectedCheck, ExpectedLabels, ValidatedDataset};
use crate::definition::ValidatedDefinition;
use crate::error::{ReasonCode, ValidationError};
use crate::report::{AggregateOutcome, CompletionStatus, Outcome, RunReport};
use serde::Serialize;
use std::collections::BTreeMap;

/// The scope word of the complete check set, as the evaluation report
/// contract states it.
pub const ALL_CHECKS: &str = "all_checks";

/// The population names one calibration plan may state in its minimum sample
/// counts, as `calibration-plan.schema.json` records them.
///
/// Each name is one denominator of one metric of this module, or the labeled
/// share of the evaluated population. A count keyed by any other name states
/// one requirement that no evaluation reads, so the plan boundary keeps the
/// set closed.
pub const DENOMINATOR_NAMES: [&str; 5] = [
    "accepted_cases",
    "evaluated_cases",
    "labeled_cases",
    "reference_fail_or_review_cases",
    "reference_pass_cases",
];

/// Returns the denominator name of one population word, or `None` for any
/// other text.
pub fn denominator_name(word: &str) -> Option<&'static str> {
    DENOMINATOR_NAMES
        .iter()
        .find(|name| **name == word)
        .copied()
}

/// The standing statement that no evaluation result repeats per check and
/// adds up as independent evidence.
pub const NO_INDEPENDENCE: &str = "Every metric set of this evaluation covers the same cases. The complete check set is one measurement, not independent evidence, and multiple apparently good checks do not establish aggregate reliability. No check of this evaluation is independent of another.";

/// One evaluation metric name, as `common.schema.json` defines it.
///
/// Every name keeps its meaning across releases. The six names and their
/// denominators are the metric definitions of this module. The order of
/// the variants is the fixed contract order, so one comparison keeps the
/// rows of two reports beside each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricName {
    /// Predicted passes among reference fail and review cases.
    FalseAcceptanceRate,
    /// Reference fail and review cases among predicted passes.
    ErrorAmongAccepted,
    /// Predicted failures among reference pass cases.
    FalseRejectionRate,
    /// Predicted review and skipped cases over all evaluated cases.
    ReviewRate,
    /// Predicted passes and failures over all evaluated cases.
    AutomaticCoverage,
    /// Evaluated cases with a reference outcome over all evaluated cases.
    LabelCoverage,
}

impl MetricName {
    /// Returns the contract word of this metric.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FalseAcceptanceRate => "false_acceptance_rate",
            Self::ErrorAmongAccepted => "error_among_accepted",
            Self::FalseRejectionRate => "false_rejection_rate",
            Self::ReviewRate => "review_rate",
            Self::AutomaticCoverage => "automatic_coverage",
            Self::LabelCoverage => "label_coverage",
        }
    }

    /// Returns the metric of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "false_acceptance_rate" => Some(Self::FalseAcceptanceRate),
            "error_among_accepted" => Some(Self::ErrorAmongAccepted),
            "false_rejection_rate" => Some(Self::FalseRejectionRate),
            "review_rate" => Some(Self::ReviewRate),
            "automatic_coverage" => Some(Self::AutomaticCoverage),
            "label_coverage" => Some(Self::LabelCoverage),
            _ => None,
        }
    }

    /// Every metric name in the fixed order of the contract enum.
    pub const ALL: [Self; 6] = [
        Self::FalseAcceptanceRate,
        Self::ErrorAmongAccepted,
        Self::FalseRejectionRate,
        Self::ReviewRate,
        Self::AutomaticCoverage,
        Self::LabelCoverage,
    ];

    /// Returns the denominator name of this metric, one word of
    /// [`DENOMINATOR_NAMES`].
    ///
    /// A calibration plan states its minimum sample counts under these names,
    /// so the plan boundary reads the denominator of every metric it
    /// constrains from here. The two error metrics of the shared numerator
    /// keep their different denominators.
    pub const fn denominator(self) -> &'static str {
        match self {
            Self::FalseAcceptanceRate => "reference_fail_or_review_cases",
            Self::ErrorAmongAccepted => "accepted_cases",
            Self::FalseRejectionRate => "reference_pass_cases",
            Self::ReviewRate => "evaluated_cases",
            Self::AutomaticCoverage => "evaluated_cases",
            Self::LabelCoverage => "evaluated_cases",
        }
    }

    /// Returns true when this metric counts errors against one labeled
    /// reference category.
    ///
    /// The three error metrics are the ones whose denominator a small
    /// evaluation can lose, so one plan that constrains one of them states
    /// the minimum sample count of that denominator. The review, coverage,
    /// and label metrics count the complete evaluated population.
    pub const fn is_error_metric(self) -> bool {
        matches!(
            self,
            Self::FalseAcceptanceRate | Self::ErrorAmongAccepted | Self::FalseRejectionRate
        )
    }
}

/// One rate with its explicit numerator and denominator.
///
/// `value` is `None` exactly when the denominator is zero. A zero
/// denominator produces no value, as the contracts README states, so an
/// unavailable rate stays a valid result that names its counts.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Rate {
    /// The metric of this rate.
    pub metric: MetricName,
    /// Cases in the numerator.
    pub numerator: usize,
    /// Cases in the denominator.
    pub denominator: usize,
    /// Numerator over denominator, or `None` when the denominator is zero.
    pub value: Option<f64>,
}

impl Rate {
    /// Builds one rate from its counts. A zero denominator keeps the value
    /// absent.
    const fn new(metric: MetricName, numerator: usize, denominator: usize) -> Self {
        let value = if denominator == 0 {
            None
        } else {
            Some(numerator as f64 / denominator as f64)
        };
        Self {
            metric,
            numerator,
            denominator,
            value,
        }
    }

    /// Returns true when this rate holds no value because its denominator
    /// is zero.
    pub fn is_unavailable(&self) -> bool {
        self.denominator == 0
    }
}

/// Counts of predicted outcomes, as the `counts` block of one metric set
/// states them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct OutcomeCounts {
    /// Predicted passes.
    pub pass: usize,
    /// Predicted failures.
    pub fail: usize,
    /// Predicted review outcomes.
    pub review: usize,
    /// Predicted execution failures.
    pub error: usize,
    /// Predicted skips.
    pub skipped: usize,
}

impl OutcomeCounts {
    /// Records one predicted outcome.
    pub fn record(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Pass => self.pass += 1,
            Outcome::Fail => self.fail += 1,
            Outcome::Review => self.review += 1,
            Outcome::Error => self.error += 1,
            Outcome::Skipped => self.skipped += 1,
        }
    }

    /// Returns the count of one predicted outcome.
    pub fn of(&self, outcome: Outcome) -> usize {
        match outcome {
            Outcome::Pass => self.pass,
            Outcome::Fail => self.fail,
            Outcome::Review => self.review,
            Outcome::Error => self.error,
            Outcome::Skipped => self.skipped,
        }
    }

    /// Returns the sum of every count.
    pub fn total(&self) -> usize {
        self.pass + self.fail + self.review + self.error + self.skipped
    }
}

/// One confusion matrix: predicted outcome counts per reference category.
///
/// A reference states pass, fail, or review, so the matrix holds one row
/// per reference category plus one row for the evaluated cases without a
/// reference. Each row keeps the full predicted outcome distribution,
/// because one error and one skip stay visible in every metric set. The
/// matrix is the fact behind the rates; every rate of [`MetricSet`]
/// computes from it, so the two can never disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct ConfusionMatrix {
    /// Predicted outcomes of the cases whose reference states pass.
    #[serde(rename = "pass")]
    pub reference_pass: OutcomeCounts,
    /// Predicted outcomes of the cases whose reference states fail.
    #[serde(rename = "fail")]
    pub reference_fail: OutcomeCounts,
    /// Predicted outcomes of the cases whose reference states review.
    #[serde(rename = "review")]
    pub reference_review: OutcomeCounts,
    /// Predicted outcomes of the evaluated cases without a reference.
    pub unlabeled: OutcomeCounts,
}

impl ConfusionMatrix {
    /// Records one pair. `reference` is `None` when the case holds no
    /// reference outcome.
    pub fn record(&mut self, reference: Option<Outcome>, predicted: Outcome) {
        match reference {
            Some(Outcome::Pass) => self.reference_pass.record(predicted),
            Some(Outcome::Fail) => self.reference_fail.record(predicted),
            Some(Outcome::Review) => self.reference_review.record(predicted),
            _ => self.unlabeled.record(predicted),
        }
    }

    /// Returns the predicted outcome counts of one reference category.
    ///
    /// # Panics
    ///
    /// Panics when the reference states error or skipped, because the
    /// dataset contract permits no such reference.
    pub fn counts(&self, reference: Outcome) -> &OutcomeCounts {
        match reference {
            Outcome::Pass => &self.reference_pass,
            Outcome::Fail => &self.reference_fail,
            Outcome::Review => &self.reference_review,
            outcome => unreachable!("one reference states no {outcome:?}"),
        }
    }

    /// Returns the count of one cell.
    pub fn cell(&self, reference: Outcome, predicted: Outcome) -> usize {
        self.counts(reference).of(predicted)
    }

    /// Returns the number of evaluated cases that hold one reference.
    pub fn labeled(&self) -> usize {
        self.reference_pass.total() + self.reference_fail.total() + self.reference_review.total()
    }

    /// Returns the number of evaluated cases without one reference.
    pub fn unlabeled(&self) -> usize {
        self.unlabeled.total()
    }

    /// Returns the labeled cases with one stated predicted outcome.
    pub fn labeled_predicted(&self, predicted: Outcome) -> usize {
        self.reference_pass.of(predicted)
            + self.reference_fail.of(predicted)
            + self.reference_review.of(predicted)
    }

    /// Returns the predicted outcome counts over every case of the scope,
    /// labeled and unlabeled.
    pub fn predicted_totals(&self) -> OutcomeCounts {
        let mut totals = OutcomeCounts::default();
        for row in [
            &self.reference_pass,
            &self.reference_fail,
            &self.reference_review,
            &self.unlabeled,
        ] {
            totals.pass += row.pass;
            totals.fail += row.fail;
            totals.review += row.review;
            totals.error += row.error;
            totals.skipped += row.skipped;
        }
        totals
    }
}

/// One metric set: the measurements of one scope.
///
/// The scope is one check identifier or [`ALL_CHECKS`]. `counts` holds the
/// predicted outcome distribution over every evaluated case of the scope,
/// `confusion` holds the reference categories behind it, and `rates` holds
/// the six contract rates in their fixed order. The serialized shape is
/// the `metric_set` block of the evaluation report contract; the
/// confusion matrix is Rust-side state that the rates state through their
/// numerators and denominators.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MetricSet {
    /// Check identifier, or `all_checks`.
    pub scope: String,
    /// Predicted outcome counts over every evaluated case of the scope.
    pub counts: OutcomeCounts,
    /// The confusion matrix behind the counts and the rates.
    #[serde(skip)]
    pub confusion: ConfusionMatrix,
    /// The six contract rates in the order of the contract enum.
    pub rates: Vec<Rate>,
}

/// Computes one contract rate of one confusion matrix.
///
/// Every metric set builds its six rates through this function, so the
/// rate of one complete scope and the same rate of one part of that scope
/// read the same definition. The interval methods of
/// [`crate::intervals`] apply it to one group at a time, which makes one
/// interval count its denominator exactly the way the stated rate does.
pub fn rate_of(metric: MetricName, confusion: &ConfusionMatrix) -> Rate {
    // The numerator of the false acceptance rate and of the error among
    // accepted cases is the same cell sum. The denominators differ, and
    // that difference is the point.
    let accepted_in_error = confusion.cell(Outcome::Fail, Outcome::Pass)
        + confusion.cell(Outcome::Review, Outcome::Pass);
    let totals = confusion.predicted_totals();
    match metric {
        MetricName::FalseAcceptanceRate => Rate::new(
            metric,
            accepted_in_error,
            confusion.counts(Outcome::Fail).total() + confusion.counts(Outcome::Review).total(),
        ),
        MetricName::ErrorAmongAccepted => Rate::new(
            metric,
            accepted_in_error,
            confusion.labeled_predicted(Outcome::Pass),
        ),
        MetricName::FalseRejectionRate => Rate::new(
            metric,
            confusion.cell(Outcome::Pass, Outcome::Fail),
            confusion.counts(Outcome::Pass).total(),
        ),
        MetricName::ReviewRate => Rate::new(metric, totals.review + totals.skipped, totals.total()),
        MetricName::AutomaticCoverage => {
            Rate::new(metric, totals.pass + totals.fail, totals.total())
        }
        MetricName::LabelCoverage => Rate::new(metric, confusion.labeled(), totals.total()),
    }
}

impl MetricSet {
    /// Assembles one metric set from its scope and its confusion matrix.
    pub(crate) fn assemble(scope: String, confusion: ConfusionMatrix) -> Self {
        let counts = confusion.predicted_totals();
        let rates = MetricName::ALL
            .map(|metric| rate_of(metric, &confusion))
            .to_vec();
        Self {
            scope,
            counts,
            confusion,
            rates,
        }
    }

    /// Returns the rate of one metric.
    ///
    /// # Panics
    ///
    /// Panics when the metric names no rate of this set, because every
    /// set holds the six contract rates.
    pub fn rate(&self, metric: MetricName) -> &Rate {
        self.rates
            .iter()
            .find(|rate| rate.metric == metric)
            .unwrap_or_else(|| panic!("the metric set holds {}", metric.as_str()))
    }
}

/// One evaluated case: the predicted outcomes of one run beside the
/// operational measurements it recorded.
///
/// The evaluate boundary builds one value per evaluated case, either from
/// one immutable run report through [`CaseOutcome::from_report`] or from
/// its own execution records. The case identifier binds the value to one
/// record of the dataset, which holds the tags and the reference labels.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CaseOutcome {
    /// Stable case identifier, as the dataset record states it.
    pub case_id: String,
    /// Component outcome of every check of the definition.
    pub checks: BTreeMap<String, Outcome>,
    /// Aggregate outcome of the case.
    pub aggregate: AggregateOutcome,
    /// Terminal execution status of the run.
    pub completion: CompletionStatus,
    /// Attempts made across the checks of this case, including retries.
    pub attempts: u64,
    /// Elapsed time of the case, in milliseconds, when one was recorded.
    pub elapsed_ms: Option<f64>,
    /// Usage amounts of the case, summed over its checks.
    pub usage: BTreeMap<String, f64>,
}

impl CaseOutcome {
    /// Reads one evaluated case out of one immutable run report.
    ///
    /// The attempt count sums the recorded attempts of the component
    /// records. The elapsed time comes from the run totals. The usage
    /// amounts come from the run totals when one exists, otherwise from
    /// the sum of the component usage records.
    pub fn from_report(report: &RunReport) -> Self {
        let checks = report
            .checks()
            .iter()
            .map(|record| (record.check.clone(), record.outcome))
            .collect();
        let attempts = report
            .checks()
            .iter()
            .map(|record| record.attempts.unwrap_or(0))
            .sum();
        let elapsed_ms = report
            .totals()
            .and_then(|totals| totals.elapsed_ms.as_ref())
            .and_then(|number| number.as_f64());
        let mut usage = BTreeMap::new();
        let usage_records = report
            .totals()
            .and_then(|totals| totals.usage.as_ref())
            .map(|totals| vec![totals])
            .unwrap_or_else(|| {
                report
                    .checks()
                    .iter()
                    .filter_map(|record| record.usage.as_ref())
                    .collect()
            });
        for recorded in usage_records {
            for (key, value) in recorded {
                if let Some(amount) = value.as_f64() {
                    *usage.entry(key.clone()).or_insert(0.0) += amount;
                }
            }
        }
        Self {
            case_id: report.case().id.clone(),
            checks,
            aggregate: report.aggregate(),
            completion: report.completion().status,
            attempts,
            elapsed_ms,
            usage,
        }
    }
}

/// Resolves the reference outcome of one check reference.
///
/// The stated expected outcome wins, because the record states it as the
/// expected policy outcome. Without one, the acceptance meaning of the
/// reference applies: one review marker means review, one answer or level
/// of the accept set means pass, one answer or level of the review set
/// means review, and every other declared answer or level means fail.
/// The answer sets come from the same source the decision policy reads,
/// so one reference and one assessment answer from one meaning.
///
/// Returns `None` when the reference states neither an outcome nor an
/// answer, level, or review marker. Such a reference exists only when the
/// dataset loader accepted one reference of another check, so the case
/// holds no reference outcome for this check.
pub fn reference_outcome(
    definition: &ValidatedDefinition,
    check_id: &str,
    reference: &ExpectedCheck,
) -> Option<Outcome> {
    if let Some(stated) = reference.outcome.as_deref() {
        return Outcome::from_word(stated);
    }
    if reference.review {
        return Some(Outcome::Review);
    }
    let label = reference.answer.as_deref().or(reference.level.as_deref())?;
    let check = definition
        .as_definition()
        .checks
        .iter()
        .find(|check| check.id == check_id)?;
    let sets = crate::policy::answer_sets(check);
    if sets.acceptable.iter().any(|name| name == label) {
        Some(Outcome::Pass)
    } else if sets.review.iter().any(|name| name == label) {
        Some(Outcome::Review)
    } else {
        Some(Outcome::Fail)
    }
}

/// Resolves the overall reference outcome of one record.
///
/// The stated overall outcome wins. Without one, the reference outcomes of
/// the checks aggregate the same way the label review aggregates stated
/// outcomes: any fail gives fail, otherwise any review gives review,
/// otherwise pass. One record without any reference outcome holds no
/// overall reference.
pub fn overall_reference_outcome(
    definition: &ValidatedDefinition,
    expected: &ExpectedLabels,
) -> Option<Outcome> {
    if let Some(stated) = expected.outcome.as_deref() {
        return Outcome::from_word(stated);
    }
    let mut resolved = Vec::with_capacity(expected.checks.len());
    for (check_id, reference) in &expected.checks {
        if let Some(outcome) = reference_outcome(definition, check_id, reference) {
            resolved.push(outcome);
        }
    }
    if resolved.is_empty() {
        return None;
    }
    if resolved.contains(&Outcome::Fail) {
        Some(Outcome::Fail)
    } else if resolved.contains(&Outcome::Review) {
        Some(Outcome::Review)
    } else {
        Some(Outcome::Pass)
    }
}

/// Returns the reference match of one predicted outcome: `true` or `false`
/// where one reference outcome exists, `None` without one.
///
/// One error and one skip never match, because no reference states them.
pub fn reference_match(predicted: Outcome, reference: Option<Outcome>) -> Option<bool> {
    reference.map(|reference| predicted == reference)
}

/// The metric sets of one slice tag.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SliceMetrics {
    /// The case tag that groups these results.
    pub tag: String,
    /// One metric set per scope, in the order of the complete result.
    pub metrics: Vec<MetricSet>,
}

/// The complete measurement of one evaluation.
///
/// Every scope appears once: one metric set per check of the definition,
/// in definition order, then the [`ALL_CHECKS`] set. Every slice tag of
/// the evaluated records appears once with the same scopes. The
/// operational totals cover the evaluated cases alone, and
/// `unevaluated_records` states how many dataset records the evaluation
/// did not measure, so one missing case stays visible instead of silent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EvaluationMetrics {
    /// Evaluated cases behind every metric set.
    pub case_count: usize,
    /// Dataset records without one evaluated outcome.
    pub unevaluated_records: usize,
    /// One metric set per check, then the complete check set.
    pub scopes: Vec<MetricSet>,
    /// One metric set row per slice tag, ordered by tag.
    pub slices: Vec<SliceMetrics>,
    /// Attempts across all cases and checks.
    pub attempts: u64,
    /// Sum of the elapsed times of the cases that state one, in
    /// milliseconds.
    pub latency_ms: Option<f64>,
    /// Cases that state one elapsed time. The latency denominator.
    pub latency_cases: usize,
    /// Usage amounts summed over the evaluated cases.
    pub usage: BTreeMap<String, f64>,
    /// The standing statement that no scope adds up as independent
    /// evidence. Always [`NO_INDEPENDENCE`].
    pub independence: &'static str,
}

impl EvaluationMetrics {
    /// Returns the metric set of one scope, check identifier or
    /// [`ALL_CHECKS`].
    pub fn metric_set(&self, scope: &str) -> Option<&MetricSet> {
        self.scopes.iter().find(|set| set.scope == scope)
    }

    /// Returns the metric sets of one slice tag.
    pub fn slice(&self, tag: &str) -> Option<&SliceMetrics> {
        self.slices.iter().find(|slice| slice.tag == tag)
    }
}

/// Measures one validated dataset against the evaluated cases.
///
/// The outcome order changes no result: every metric set folds the same
/// pairs. One outcome that names no record of the dataset, one repeated
/// case identifier, one outcome that names no check of the definition, one
/// outcome that omits one check of the definition, one negative elapsed
/// time, and one negative usage amount each fail with their field path
/// under `/cases/<index>`, because a measurement over cases the dataset
/// never held states nothing.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `insufficient_evidence` at
/// `/cases` when no evaluated case exists, with `unknown_field` when one
/// outcome names no dataset record or no check of the definition, with
/// `duplicate_id` when one case identifier repeats, with `missing_field`
/// when one outcome omits one check of the definition, and with
/// `invalid_field_type` when one elapsed time or one usage amount is
/// negative.
pub fn evaluate_metrics(
    dataset: &ValidatedDataset<'_>,
    outcomes: &[CaseOutcome],
) -> Result<EvaluationMetrics, ValidationError> {
    if outcomes.is_empty() {
        return Err(ValidationError::new(
            ReasonCode::InsufficientEvidence,
            "/cases",
            "The evaluation holds no evaluated case, so no metric has a denominator.",
        ));
    }
    let definition = dataset.definition();
    let check_ids: Vec<&str> = definition
        .as_definition()
        .checks
        .iter()
        .map(|check| check.id.as_str())
        .collect();

    // One outcome must name one record of the dataset and one outcome of
    // every defined check. The record positions bind the tags and the
    // references to the cases.
    let mut positions: BTreeMap<&str, usize> = BTreeMap::new();
    for (index, record) in dataset.records().iter().enumerate() {
        positions.insert(record.id.as_str(), index);
    }
    for (index, outcome) in outcomes.iter().enumerate() {
        let base = format!("/cases/{index}");
        if !positions.contains_key(outcome.case_id.as_str()) {
            return Err(ValidationError::new(
                ReasonCode::UnknownField,
                format!("{base}/id"),
                format!(
                    "The evaluated case {} names no record of the dataset {}.",
                    crate::error::fragment(&outcome.case_id),
                    crate::error::fragment(&dataset.metadata().id)
                ),
            ));
        }
        if outcomes[..index]
            .iter()
            .any(|earlier| earlier.case_id == outcome.case_id)
        {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("{base}/id"),
                format!(
                    "The evaluated case {} repeats an earlier case.",
                    crate::error::fragment(&outcome.case_id)
                ),
            ));
        }
        for check_id in &check_ids {
            if !outcome.checks.contains_key(*check_id) {
                return Err(ValidationError::missing(format!(
                    "{base}/checks/{check_id}"
                )));
            }
        }
        for check_id in outcome.checks.keys() {
            if !check_ids.contains(&check_id.as_str()) {
                return Err(ValidationError::new(
                    ReasonCode::UnknownField,
                    format!("{base}/checks/{check_id}"),
                    format!(
                        "The outcome names no check of the definition: {}.",
                        crate::error::fragment(check_id)
                    ),
                ));
            }
        }
        if let Some(elapsed) = outcome.elapsed_ms {
            if elapsed < 0.0 {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/elapsed_ms"),
                    "The elapsed time must be zero or positive.",
                ));
            }
        }
        for (key, amount) in &outcome.usage {
            if *amount < 0.0 {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/usage/{key}"),
                    "Every usage amount must be zero or positive.",
                ));
            }
        }
    }

    // One accumulator per scope, for the complete result and per slice.
    let mut whole: Vec<ConfusionMatrix> = vec![ConfusionMatrix::default(); check_ids.len() + 1];
    let mut slices: BTreeMap<String, Vec<ConfusionMatrix>> = BTreeMap::new();
    let mut attempts = 0;
    let mut latency_ms = 0.0;
    let mut latency_cases = 0;
    let mut usage: BTreeMap<String, f64> = BTreeMap::new();
    for outcome in outcomes {
        let position = positions[outcome.case_id.as_str()];
        let record = dataset
            .record(position)
            .expect("the position came from the dataset");
        let expected = record.expected();

        // The reference outcomes resolve once per case, because the whole
        // result and every slice count the same pairs.
        let references: Vec<Option<Outcome>> = check_ids
            .iter()
            .map(|check_id| {
                expected.and_then(|labels| {
                    labels
                        .checks
                        .get(*check_id)
                        .and_then(|reference| reference_outcome(definition, check_id, reference))
                })
            })
            .collect();
        let overall_predicted = component(outcome.aggregate);
        let overall_reference =
            expected.and_then(|labels| overall_reference_outcome(definition, labels));

        let rows = |row: &mut [ConfusionMatrix]| {
            for (slot, reference) in references.iter().enumerate() {
                row[slot].record(*reference, outcome.checks[check_ids[slot]]);
            }
            row[check_ids.len()].record(overall_reference, overall_predicted);
        };
        rows(&mut whole);

        // One record with several tags joins every named slice.
        for tag in record.tags() {
            rows(
                slices
                    .entry(tag.clone())
                    .or_insert_with(|| vec![ConfusionMatrix::default(); check_ids.len() + 1]),
            );
        }

        attempts += outcome.attempts;
        if let Some(elapsed) = outcome.elapsed_ms {
            latency_ms += elapsed;
            latency_cases += 1;
        }
        for (key, amount) in &outcome.usage {
            *usage.entry(key.clone()).or_insert(0.0) += *amount;
        }
    }

    let scopes = scope_names(&check_ids)
        .into_iter()
        .zip(whole)
        .map(|(scope, confusion)| MetricSet::assemble(scope, confusion))
        .collect();
    let slices = slices
        .into_iter()
        .map(|(tag, confusions)| SliceMetrics {
            tag,
            metrics: scope_names(&check_ids)
                .into_iter()
                .zip(confusions)
                .map(|(scope, confusion)| MetricSet::assemble(scope, confusion))
                .collect(),
        })
        .collect();
    Ok(EvaluationMetrics {
        case_count: outcomes.len(),
        unevaluated_records: dataset.len() - outcomes.len(),
        scopes,
        slices,
        attempts,
        latency_ms: (latency_cases > 0).then_some(latency_ms),
        latency_cases,
        usage,
        independence: NO_INDEPENDENCE,
    })
}

/// One evaluated case with its resolved reference.
///
/// `reference` and `matched` hold one entry per check of the definition, so
/// one evaluation report case states every check, including one that carries
/// no reference label.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CaseReference {
    /// Stable case identifier, as the dataset record states it.
    pub case_id: String,
    /// The resolved reference outcome of every defined check, or `None` for
    /// one check without a reference.
    pub reference: BTreeMap<String, Option<Outcome>>,
    /// The reference match of every defined check: `true` or `false` where a
    /// reference exists, `None` without one.
    pub matched: BTreeMap<String, Option<bool>>,
}

/// The complete measurement of one evaluation: the metric sets and the
/// resolved reference of every evaluated case.
///
/// [`evaluate`] measures the same inputs as [`evaluate_metrics`] and adds the
/// per-case references behind the `reference_match` field of the evaluation
/// report contract. Both resolve through [`reference_outcome`], so a rate and
/// a stated match can never disagree.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EvaluationMeasurement {
    /// The metric sets, the slices, and the operational totals.
    pub metrics: EvaluationMetrics,
    /// One entry per evaluated case, in the order of the outcomes.
    pub cases: Vec<CaseReference>,
}

/// Measures one validated dataset and resolves the reference of every
/// evaluated case.
///
/// The measurement runs [`evaluate_metrics`] first, so every rule of that
/// boundary applies unchanged: one outcome that names no dataset record or no
/// check of the definition fails with its field path, and one evaluation with
/// no case fails with `insufficient_evidence`. The references then resolve
/// once per case and per check, through the same [`reference_outcome`] the
/// rates read.
///
/// # Errors
///
/// Returns the failure of [`evaluate_metrics`].
pub fn evaluate(
    dataset: &ValidatedDataset<'_>,
    outcomes: &[CaseOutcome],
) -> Result<EvaluationMeasurement, ValidationError> {
    let metrics = evaluate_metrics(dataset, outcomes)?;
    let definition = dataset.definition();
    let check_ids: Vec<&str> = definition
        .as_definition()
        .checks
        .iter()
        .map(|check| check.id.as_str())
        .collect();
    // evaluate_metrics accepted every case identifier, so every position
    // exists and no lookup can fail.
    let positions: BTreeMap<&str, usize> = dataset
        .records()
        .iter()
        .enumerate()
        .map(|(index, record)| (record.id.as_str(), index))
        .collect();
    let cases = outcomes
        .iter()
        .map(|outcome| {
            let record = dataset
                .record(positions[outcome.case_id.as_str()])
                .expect("evaluate_metrics accepted the case identifier");
            let expected = record.expected();
            let mut reference = BTreeMap::new();
            let mut matched = BTreeMap::new();
            for check_id in &check_ids {
                let resolved = expected.and_then(|labels| {
                    labels
                        .checks
                        .get(*check_id)
                        .and_then(|one| reference_outcome(definition, check_id, one))
                });
                matched.insert(
                    (*check_id).to_owned(),
                    reference_match(outcome.checks[*check_id], resolved),
                );
                reference.insert((*check_id).to_owned(), resolved);
            }
            CaseReference {
                case_id: outcome.case_id.clone(),
                reference,
                matched,
            }
        })
        .collect();
    Ok(EvaluationMeasurement { metrics, cases })
}

/// Returns the scope names of one measurement: one per check of the
/// definition, then [`ALL_CHECKS`].
pub(crate) fn scope_names(check_ids: &[&str]) -> Vec<String> {
    check_ids
        .iter()
        .map(|check_id| (*check_id).to_owned())
        .chain([ALL_CHECKS.to_owned()])
        .collect()
}

/// Returns the component outcome word of one aggregate outcome. The
/// aggregate folds one skip into review, so the complete check set counts
/// no skipped case of its own.
pub(crate) const fn component(aggregate: AggregateOutcome) -> Outcome {
    match aggregate {
        AggregateOutcome::Pass => Outcome::Pass,
        AggregateOutcome::Fail => Outcome::Fail,
        AggregateOutcome::Review => Outcome::Review,
        AggregateOutcome::Error => Outcome::Error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::load_dataset;
    use crate::report::{
        ArtifactReference, CaseReference, CheckRecord, Completion, ProfileReference, ReportBuilder,
        RunMode, Totals,
    };
    use serde_json::{json, Value};
    use std::collections::BTreeSet;

    /// One valid definition with one binary question and one rule check.
    fn definition() -> ValidatedDefinition {
        let text = fs_artifact("definitions/valid/all-input-types.json");
        crate::definition::validate_definition_str(&text).expect("the definition validates")
    }

    /// Reads one fixture artifact relative to the fixtures directory.
    fn fs_artifact(relative: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures")
            .join(relative);
        std::fs::read_to_string(path).expect("the fixture reads")
    }

    /// One metadata artifact of the metrics tests.
    fn metadata() -> Value {
        json!({
            "schema_version": 1,
            "id": "metric-cases",
            "revision": "2026-09-24.1",
            "kind": "development_fixture",
            "intended_population": "Release notes of one product area.",
            "sampling_method": "Selected from reviewed development work. No prevalence claim.",
            "label_guidelines": "See docs/labeling.md revision 3.",
            "splits": [{"id": "all", "purpose": "fitting", "groups": ["notes"]}]
        })
    }

    /// One record of the metrics tests. `expected` is one expected-label
    /// object or `None`.
    fn record(id: &str, tags: &[&str], expected: Option<Value>) -> Value {
        let mut value = json!({
            "id": id,
            "group": "notes",
            "input": {
                "summary": "The search index now refreshes nightly.",
                "severity": 2,
                "confidence": 0.9,
                "breaking": false,
                "tickets": ["SRCH-101"],
                "metadata": {"team": "search"}
            },
            "label": {"author_type": "human", "reviewed": false}
        });
        if !tags.is_empty() {
            value["tags"] = json!(tags);
        }
        if let Some(expected) = expected {
            value["expected"] = expected;
        }
        value
    }

    /// Serializes records into one record file.
    fn file(records: &[Value]) -> String {
        records
            .iter()
            .map(|value| serde_json::to_string(value).expect("serializes"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Validates one dataset of the metrics tests against the shared
    /// definition fixture and measures it.
    fn computed(records: &str, outcomes: &[CaseOutcome]) -> EvaluationMetrics {
        let definition = definition();
        let metadata_text = serde_json::to_string(&metadata()).expect("serializes");
        let dataset = load_dataset(&metadata_text, records).expect("the dataset loads");
        let validated =
            crate::dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        evaluate_metrics(&validated, outcomes).expect("the metrics compute")
    }

    /// Validates one dataset of the metrics tests and measures it with the
    /// references of every evaluated case.
    fn measured(records: &str, outcomes: &[CaseOutcome]) -> EvaluationMeasurement {
        let definition = definition();
        let metadata_text = serde_json::to_string(&metadata()).expect("serializes");
        let dataset = load_dataset(&metadata_text, records).expect("the dataset loads");
        let validated =
            crate::dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        evaluate(&validated, outcomes).expect("the measurement computes")
    }

    /// Validates one dataset of the metrics tests and returns the
    /// measurement failure.
    fn failing(records: &str, outcomes: &[CaseOutcome]) -> ValidationError {
        let definition = definition();
        let metadata_text = serde_json::to_string(&metadata()).expect("serializes");
        let dataset = load_dataset(&metadata_text, records).expect("the dataset loads");
        let validated =
            crate::dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        evaluate_metrics(&validated, outcomes).expect_err("the measurement was accepted")
    }

    /// One evaluated case of the metrics tests.
    fn case(
        id: &str,
        notes: &str,
        todos: &str,
        aggregate: &str,
        attempts: u64,
        elapsed_ms: Option<f64>,
    ) -> CaseOutcome {
        CaseOutcome {
            case_id: id.to_owned(),
            checks: BTreeMap::from([
                ("notes-complete".to_owned(), word(notes)),
                ("summary-free-of-todos".to_owned(), word(todos)),
            ]),
            aggregate: aggregate_word(aggregate),
            completion: CompletionStatus::Completed,
            attempts,
            elapsed_ms,
            usage: BTreeMap::from([("input_tokens".to_owned(), 100.0)]),
        }
    }

    /// One outcome word of the tests.
    fn word(word: &str) -> Outcome {
        Outcome::from_word(word).expect("one outcome word")
    }

    /// One aggregate word of the tests.
    fn aggregate_word(word: &str) -> AggregateOutcome {
        AggregateOutcome::from_word(word).expect("one aggregate word")
    }

    #[test]
    fn every_metric_name_round_trips() {
        for name in MetricName::ALL {
            assert_eq!(MetricName::from_word(name.as_str()), Some(name));
            assert_eq!(
                serde_json::to_value(name).expect("serializes"),
                Value::String(name.as_str().to_owned())
            );
        }
        assert_eq!(MetricName::ALL.len(), 6);
        assert_eq!(MetricName::from_word("accuracy"), None);
        assert_eq!(MetricName::from_word("false_acceptance"), None);
    }

    #[test]
    fn every_metric_names_one_denominator_of_the_published_set() {
        for name in MetricName::ALL {
            let denominator = name.denominator();
            assert_eq!(
                denominator_name(denominator),
                Some(denominator),
                "{}",
                name.as_str()
            );
        }
        // The two error metrics of one numerator keep two denominators, as
        // the contracts README states.
        assert_eq!(
            MetricName::FalseAcceptanceRate.denominator(),
            "reference_fail_or_review_cases"
        );
        assert_eq!(
            MetricName::ErrorAmongAccepted.denominator(),
            "accepted_cases"
        );
        assert_eq!(
            MetricName::FalseRejectionRate.denominator(),
            "reference_pass_cases"
        );
        for name in [
            MetricName::ReviewRate,
            MetricName::AutomaticCoverage,
            MetricName::LabelCoverage,
        ] {
            assert_eq!(name.denominator(), "evaluated_cases");
            assert!(!name.is_error_metric());
        }
        for name in [
            MetricName::FalseAcceptanceRate,
            MetricName::ErrorAmongAccepted,
            MetricName::FalseRejectionRate,
        ] {
            assert!(name.is_error_metric());
        }
        // One name outside the published set states no requirement.
        assert_eq!(denominator_name("labeled_case"), None);
        assert_eq!(denominator_name(""), None);
    }

    #[test]
    fn one_zero_denominator_holds_no_value() {
        let rate = Rate::new(MetricName::FalseAcceptanceRate, 0, 0);
        assert!(rate.is_unavailable());
        assert_eq!(rate.value, None);
        assert_eq!(rate.numerator, 0);
        let rate = Rate::new(MetricName::ReviewRate, 1, 4);
        assert!(!rate.is_unavailable());
        assert_eq!(rate.value, Some(0.25));
        let rate = Rate::new(MetricName::AutomaticCoverage, 7, 7);
        assert_eq!(rate.value, Some(1.0));
    }

    #[test]
    fn the_confusion_matrix_keeps_every_predicted_outcome() {
        let mut matrix = ConfusionMatrix::default();
        let pairs = [
            (Some(Outcome::Pass), Outcome::Pass),
            (Some(Outcome::Pass), Outcome::Fail),
            (Some(Outcome::Pass), Outcome::Error),
            (Some(Outcome::Fail), Outcome::Pass),
            (Some(Outcome::Fail), Outcome::Review),
            (Some(Outcome::Review), Outcome::Skipped),
            (None, Outcome::Pass),
            (None, Outcome::Skipped),
        ];
        for (reference, predicted) in pairs {
            matrix.record(reference, predicted);
        }
        assert_eq!(matrix.counts(Outcome::Pass).total(), 3);
        assert_eq!(matrix.cell(Outcome::Pass, Outcome::Fail), 1);
        assert_eq!(matrix.cell(Outcome::Fail, Outcome::Pass), 1);
        assert_eq!(matrix.cell(Outcome::Review, Outcome::Skipped), 1);
        assert_eq!(matrix.labeled(), 6);
        assert_eq!(matrix.unlabeled(), 2);
        assert_eq!(matrix.labeled_predicted(Outcome::Pass), 2);
        let totals = matrix.predicted_totals();
        assert_eq!(totals.total(), 8);
        assert_eq!(totals.pass, 3);
        assert_eq!(totals.fail, 1);
        assert_eq!(totals.review, 1);
        assert_eq!(totals.error, 1);
        assert_eq!(totals.skipped, 2);
        // The serialized rows name the reference categories.
        let value = serde_json::to_value(matrix).expect("the matrix serializes");
        assert_eq!(
            value["pass"]["error"], 1,
            "one reference pass case predicted error"
        );
        assert_eq!(value["unlabeled"]["skipped"], 1);
    }

    /// Parses one record that states one reference for one check.
    fn reference_of(raw: Value) -> crate::dataset::ExpectedCheck {
        let parsed = crate::dataset::parse_case_record(&json!({
            "id": "metric-cases-1",
            "input": {},
            "expected": {"checks": {"notes-complete": raw}},
            "label": {"author_type": "human", "reviewed": false}
        }))
        .expect("the record parses");
        parsed
            .expected
            .expect("labels are present")
            .checks
            .get("notes-complete")
            .expect("the check reference")
            .clone()
    }

    #[test]
    fn one_reference_resolves_from_its_stated_or_implied_outcome() {
        let definition = definition();
        // The acceptance meaning of the answer implies the outcome.
        for (raw, expected) in [
            (json!({"answer": "yes"}), Some(Outcome::Pass)),
            (json!({"answer": "no"}), Some(Outcome::Fail)),
            (json!({"review": true}), Some(Outcome::Review)),
            // The stated expected outcome wins over the answer meaning.
            (
                json!({"answer": "yes", "outcome": "fail"}),
                Some(Outcome::Fail),
            ),
            (json!({"outcome": "review"}), Some(Outcome::Review)),
        ] {
            assert_eq!(
                reference_outcome(&definition, "notes-complete", &reference_of(raw.clone())),
                expected,
                "{raw}"
            );
        }

        // One record without any reference for one check holds no
        // reference outcome for it.
        let parsed = crate::dataset::parse_case_record(&record(
            "metric-cases-1",
            &[],
            Some(json!({"checks": {"summary-free-of-todos": {"outcome": "pass"}}})),
        ))
        .expect("the record parses");
        let labels = parsed.expected.as_ref().expect("labels are present");
        assert!(!labels.checks.contains_key("notes-complete"));
        assert!(record_without_labels().expected.is_none());

        // One ordered scale resolves through the accept threshold of its
        // check, because the answer sets expand it.
        let scale_definition = crate::definition::validate_definition_str(&fs_artifact(
            "definitions/valid/ordered-scale.json",
        ))
        .expect("the scale definition validates");
        for (level, expected) in [
            ("minor", Some(Outcome::Fail)),
            ("meaningful", Some(Outcome::Pass)),
            ("serious", Some(Outcome::Pass)),
        ] {
            let parsed = crate::dataset::parse_case_record(&json!({
                "id": "metric-cases-1",
                "input": {},
                "expected": {"checks": {"consequence": {"level": level}}},
                "label": {"author_type": "human", "reviewed": false}
            }))
            .expect("the record parses");
            let reference = parsed
                .expected
                .as_ref()
                .expect("labels are present")
                .checks
                .get("consequence")
                .expect("the check reference");
            assert_eq!(
                reference_outcome(&scale_definition, "consequence", reference),
                expected,
                "{level}"
            );
        }
    }

    /// One parsed record without reference labels.
    fn record_without_labels() -> crate::dataset::CaseRecord {
        crate::dataset::parse_case_record(&record("metric-cases-1", &[], None))
            .expect("the record parses")
    }

    #[test]
    fn the_overall_reference_aggregates_the_check_references() {
        let definition = definition();
        for (raw, expected) in [
            // Any fail gives fail.
            (
                json!({
                    "checks": {
                        "notes-complete": {"answer": "no"},
                        "summary-free-of-todos": {"outcome": "pass"}
                    }
                }),
                Some(Outcome::Fail),
            ),
            // The stated overall outcome wins over the aggregate.
            (
                json!({
                    "outcome": "pass",
                    "checks": {
                        "notes-complete": {"answer": "no"},
                        "summary-free-of-todos": {"outcome": "pass"}
                    }
                }),
                Some(Outcome::Pass),
            ),
            // Otherwise any review gives review.
            (
                json!({
                    "checks": {
                        "notes-complete": {"review": true},
                        "summary-free-of-todos": {"outcome": "pass"}
                    }
                }),
                Some(Outcome::Review),
            ),
            // Otherwise pass.
            (
                json!({"checks": {"notes-complete": {"answer": "yes"}}}),
                Some(Outcome::Pass),
            ),
        ] {
            let parsed = crate::dataset::parse_case_record(&json!({
                "id": "metric-cases-1",
                "input": {},
                "expected": raw,
                "label": {"author_type": "human", "reviewed": false}
            }))
            .expect("the record parses");
            assert_eq!(
                overall_reference_outcome(
                    &definition,
                    parsed.expected.as_ref().expect("labels are present")
                ),
                expected,
                "{raw}"
            );
        }
        // One record without any reference holds no overall reference.
        let parsed = record_without_labels();
        assert!(parsed.expected.is_none());
    }

    #[test]
    fn one_reference_match_never_counts_one_error_or_one_skip() {
        assert_eq!(
            reference_match(Outcome::Pass, Some(Outcome::Pass)),
            Some(true)
        );
        assert_eq!(
            reference_match(Outcome::Fail, Some(Outcome::Pass)),
            Some(false)
        );
        assert_eq!(
            reference_match(Outcome::Error, Some(Outcome::Pass)),
            Some(false)
        );
        assert_eq!(
            reference_match(Outcome::Skipped, Some(Outcome::Review)),
            Some(false)
        );
        assert_eq!(reference_match(Outcome::Review, None), None);
        assert_eq!(reference_match(Outcome::Pass, None), None);
    }

    #[test]
    fn one_evaluation_states_every_scope_slice_and_denominator() {
        let records = file(&[
            // Reference fail on the question check, predicted pass: one
            // false acceptance and one error among the accepted.
            record(
                "metric-cases-1",
                &["dates"],
                Some(
                    json!({"checks": {"notes-complete": {"answer": "no"}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "fail"}),
                ),
            ),
            // Reference pass, predicted pass.
            record(
                "metric-cases-2",
                &["dates"],
                Some(
                    json!({"checks": {"notes-complete": {"answer": "yes"}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "pass"}),
                ),
            ),
            // Reference review, predicted review.
            record(
                "metric-cases-3",
                &["limits"],
                Some(
                    json!({"checks": {"notes-complete": {"review": true}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "review"}),
                ),
            ),
            // Reference pass, one predicted failure on the rule check: one
            // false rejection.
            record(
                "metric-cases-4",
                &["limits"],
                Some(
                    json!({"checks": {"notes-complete": {"answer": "yes"}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "pass"}),
                ),
            ),
            // No labels, and no evaluated outcome.
            record("metric-cases-5", &["limits"], None),
        ]);
        let outcomes = [
            case("metric-cases-1", "pass", "pass", "pass", 2, Some(1500.0)),
            case("metric-cases-2", "pass", "pass", "pass", 1, Some(500.0)),
            case("metric-cases-3", "review", "pass", "review", 1, None),
            case("metric-cases-4", "pass", "fail", "fail", 3, Some(2500.0)),
        ];
        let metrics = computed(&records, &outcomes);

        // One set per check plus the complete check set, in definition
        // order.
        let scopes: Vec<&str> = metrics
            .scopes
            .iter()
            .map(|set| set.scope.as_str())
            .collect();
        assert_eq!(
            scopes,
            ["notes-complete", "summary-free-of-todos", ALL_CHECKS]
        );
        assert_eq!(metrics.case_count, 4);
        assert_eq!(metrics.unevaluated_records, 1);

        // The question check: one reference fail, one reference review, two
        // reference pass, and no unlabeled evaluated case.
        let question = metrics.metric_set("notes-complete").expect("the check set");
        assert_eq!(
            serde_json::to_value(question.counts).expect("serializes"),
            json!({"pass": 3, "fail": 0, "review": 1, "error": 0, "skipped": 0})
        );
        // The false acceptance rate counts predicted passes among the two
        // reference fail and reference review cases.
        let far = question.rate(MetricName::FalseAcceptanceRate);
        assert_eq!((far.numerator, far.denominator), (1, 2));
        assert_eq!(far.value, Some(0.5));
        // The error among accepted cases counts the same case over the
        // labeled predicted passes: three passes, one with one reference
        // fail. The two metrics share one numerator and no denominator.
        let accepted = question.rate(MetricName::ErrorAmongAccepted);
        assert_eq!((accepted.numerator, accepted.denominator), (1, 3));
        assert_eq!(accepted.value, Some(1.0 / 3.0));
        // No predicted failure among the two reference pass cases.
        let frr = question.rate(MetricName::FalseRejectionRate);
        assert_eq!((frr.numerator, frr.denominator), (0, 2));
        assert_eq!(frr.value, Some(0.0));
        // Every evaluated case holds one reference for this check.
        let coverage = question.rate(MetricName::LabelCoverage);
        assert_eq!((coverage.numerator, coverage.denominator), (4, 4));
        let review = question.rate(MetricName::ReviewRate);
        assert_eq!((review.numerator, review.denominator), (1, 4));
        let automatic = question.rate(MetricName::AutomaticCoverage);
        assert_eq!((automatic.numerator, automatic.denominator), (3, 4));

        // The rule check: four reference pass cases, one predicted failure.
        let rule_set = metrics
            .metric_set("summary-free-of-todos")
            .expect("the rule set");
        let frr = rule_set.rate(MetricName::FalseRejectionRate);
        assert_eq!((frr.numerator, frr.denominator), (1, 4));
        assert_eq!(frr.value, Some(0.25));
        // No reference fail or review exists, so the false acceptance rate
        // holds no denominator.
        assert!(rule_set
            .rate(MetricName::FalseAcceptanceRate)
            .is_unavailable());

        // The complete check set counts the aggregate outcomes.
        let complete = metrics.metric_set(ALL_CHECKS).expect("the complete set");
        assert_eq!(
            serde_json::to_value(complete.counts).expect("serializes"),
            json!({"pass": 2, "fail": 1, "review": 1, "error": 0, "skipped": 0})
        );
        let far = complete.rate(MetricName::FalseAcceptanceRate);
        assert_eq!((far.numerator, far.denominator), (1, 2));
        let frr = complete.rate(MetricName::FalseRejectionRate);
        assert_eq!((frr.numerator, frr.denominator), (1, 2));
        let coverage = complete.rate(MetricName::LabelCoverage);
        assert_eq!((coverage.numerator, coverage.denominator), (4, 4));

        // The slices follow the tags of the evaluated records.
        let tags: Vec<&str> = metrics
            .slices
            .iter()
            .map(|slice| slice.tag.as_str())
            .collect();
        assert_eq!(tags, ["dates", "limits"]);
        let dates = metrics.slice("dates").expect("the slice");
        let dates_complete = dates
            .metrics
            .iter()
            .find(|set| set.scope == ALL_CHECKS)
            .expect("the complete set");
        assert_eq!(dates_complete.counts.total(), 2);
        assert_eq!(
            dates_complete.rate(MetricName::LabelCoverage).value,
            Some(1.0)
        );
        let limits = metrics.slice("limits").expect("the slice");
        let limits_question = limits
            .metrics
            .iter()
            .find(|set| set.scope == "notes-complete")
            .expect("the check set");
        assert_eq!(limits_question.counts.total(), 2);
        // The slice holds no reference fail case, so its false acceptance
        // rate counts the one reference review case alone: no pass among
        // one denominator.
        let far = limits_question.rate(MetricName::FalseAcceptanceRate);
        assert_eq!((far.numerator, far.denominator), (0, 1));
        assert_eq!(far.value, Some(0.0));

        // The operational totals state their denominators.
        assert_eq!(metrics.attempts, 7);
        assert_eq!(metrics.latency_ms, Some(4500.0));
        assert_eq!(metrics.latency_cases, 3);
        assert_eq!(
            metrics.usage,
            BTreeMap::from([("input_tokens".to_owned(), 400.0)])
        );
        // No result claims independence between checks.
        assert_eq!(metrics.independence, NO_INDEPENDENCE);
        assert!(metrics.independence.contains("not independent evidence"));
    }

    #[test]
    fn errors_and_skips_stay_in_every_denominator() {
        let records = file(&[
            // Reference fail, predicted pass: one false acceptance.
            record(
                "metric-cases-1",
                &[],
                Some(
                    json!({"checks": {"notes-complete": {"answer": "no"}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "fail"}),
                ),
            ),
            // Reference fail, predicted error: no pass, but the case stays
            // in the denominator.
            record(
                "metric-cases-2",
                &[],
                Some(
                    json!({"checks": {"notes-complete": {"answer": "no"}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "fail"}),
                ),
            ),
            // Reference review, predicted skip.
            record(
                "metric-cases-3",
                &[],
                Some(
                    json!({"checks": {"notes-complete": {"review": true}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "review"}),
                ),
            ),
        ]);
        let outcomes = [
            case("metric-cases-1", "pass", "pass", "pass", 1, None),
            case("metric-cases-2", "error", "error", "error", 2, None),
            case("metric-cases-3", "skipped", "skipped", "review", 0, None),
        ];
        let metrics = computed(&records, &outcomes);
        let question = metrics.metric_set("notes-complete").expect("the check set");
        assert_eq!(
            serde_json::to_value(question.counts).expect("serializes"),
            json!({"pass": 1, "fail": 0, "review": 0, "error": 1, "skipped": 1})
        );
        // All three labeled cases sit in the false acceptance denominator,
        // whatever the operation returned.
        let far = question.rate(MetricName::FalseAcceptanceRate);
        assert_eq!((far.numerator, far.denominator), (1, 3));
        // The review rate counts the error case in its denominator and the
        // skip in its numerator: one skip needs one human too.
        let review = question.rate(MetricName::ReviewRate);
        assert_eq!((review.numerator, review.denominator), (1, 3));
        // The automatic coverage counts the one predicted pass alone.
        let automatic = question.rate(MetricName::AutomaticCoverage);
        assert_eq!((automatic.numerator, automatic.denominator), (1, 3));
        // The complete check set holds no skipped case, because the
        // aggregate folds the skip into review.
        let complete = metrics.metric_set(ALL_CHECKS).expect("the complete set");
        assert_eq!(
            serde_json::to_value(complete.counts).expect("serializes"),
            json!({"pass": 1, "fail": 0, "review": 1, "error": 1, "skipped": 0})
        );
        // The attempts of the errored case stay counted.
        assert_eq!(metrics.attempts, 3);
    }

    #[test]
    fn zero_denominators_return_unavailable_values() {
        // Every reference states pass, so the false acceptance rate holds
        // no denominator. Nothing predicts pass, so the error among the
        // accepted cases holds none either.
        let records = file(&[
            record(
                "metric-cases-1",
                &[],
                Some(
                    json!({"checks": {"notes-complete": {"answer": "yes"}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "pass"}),
                ),
            ),
            record(
                "metric-cases-2",
                &[],
                Some(
                    json!({"checks": {"notes-complete": {"answer": "yes"}, "summary-free-of-todos": {"outcome": "fail"}}, "outcome": "fail"}),
                ),
            ),
        ]);
        let outcomes = [
            case("metric-cases-1", "fail", "fail", "fail", 1, None),
            case("metric-cases-2", "review", "review", "review", 1, None),
        ];
        let metrics = computed(&records, &outcomes);
        let question = metrics.metric_set("notes-complete").expect("the check set");
        let far = question.rate(MetricName::FalseAcceptanceRate);
        assert_eq!((far.numerator, far.denominator), (0, 0));
        assert!(far.is_unavailable());
        assert_eq!(far.value, None);
        let accepted = question.rate(MetricName::ErrorAmongAccepted);
        assert_eq!(accepted.denominator, 0);
        assert_eq!(accepted.value, None);
        // The false rejection rate holds one denominator and one value.
        let frr = question.rate(MetricName::FalseRejectionRate);
        assert_eq!((frr.numerator, frr.denominator), (1, 2));
        assert_eq!(frr.value, Some(0.5));

        // One dataset without any reference leaves the three error rates
        // unavailable and the label coverage at zero.
        let records = file(&[
            record("metric-cases-1", &[], None),
            record("metric-cases-2", &[], None),
        ]);
        let outcomes = [
            case("metric-cases-1", "pass", "pass", "pass", 1, None),
            case("metric-cases-2", "pass", "pass", "pass", 1, None),
        ];
        let metrics = computed(&records, &outcomes);
        for scope in ["notes-complete", ALL_CHECKS] {
            let set = metrics.metric_set(scope).expect("the scope");
            for metric in [
                MetricName::FalseAcceptanceRate,
                MetricName::ErrorAmongAccepted,
                MetricName::FalseRejectionRate,
            ] {
                let rate = set.rate(metric);
                assert_eq!(rate.denominator, 0, "{}: {scope}", metric.as_str());
                assert!(rate.is_unavailable());
            }
            let coverage = set.rate(MetricName::LabelCoverage);
            assert_eq!((coverage.numerator, coverage.denominator), (0, 2));
            assert_eq!(coverage.value, Some(0.0));
        }

        // One slice without one reference denominator states it too.
        let records = file(&[
            record(
                "metric-cases-1",
                &["seen"],
                Some(
                    json!({"checks": {"notes-complete": {"answer": "yes"}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "pass"}),
                ),
            ),
            record("metric-cases-2", &["unseen"], None),
        ]);
        let outcomes = [
            case("metric-cases-1", "pass", "pass", "pass", 1, None),
            case("metric-cases-2", "pass", "pass", "pass", 1, None),
        ];
        let metrics = computed(&records, &outcomes);
        let unseen = metrics.slice("unseen").expect("the slice");
        let complete = unseen
            .metrics
            .iter()
            .find(|set| set.scope == ALL_CHECKS)
            .expect("the complete set");
        assert!(complete
            .rate(MetricName::FalseRejectionRate)
            .is_unavailable());
    }

    #[test]
    fn broken_evaluations_report_their_field_paths() {
        let records = file(&[record(
            "metric-cases-1",
            &[],
            Some(
                json!({"checks": {"notes-complete": {"answer": "yes"}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "pass"}),
            ),
        )]);

        // No evaluated case is no evidence.
        let error = failing(&records, &[]);
        assert_eq!(error.code, ReasonCode::InsufficientEvidence, "{error}");
        assert_eq!(error.field_path, "/cases", "{error}");

        // One outcome that names no record of the dataset.
        let error = failing(
            &records,
            &[case("absent-case", "pass", "pass", "pass", 1, None)],
        );
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/cases/0/id", "{error}");

        // One repeated case identifier.
        let error = failing(
            &records,
            &[
                case("metric-cases-1", "pass", "pass", "pass", 1, None),
                case("metric-cases-1", "fail", "fail", "fail", 1, None),
            ],
        );
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/cases/1/id", "{error}");

        // One outcome that names no check of the definition.
        let mut foreign = case("metric-cases-1", "pass", "pass", "pass", 1, None);
        foreign
            .checks
            .insert("absent-check".to_owned(), Outcome::Pass);
        let error = failing(&records, &[foreign]);
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/cases/0/checks/absent-check", "{error}");

        // One outcome that omits one check of the definition.
        let mut missing = case("metric-cases-1", "pass", "pass", "pass", 1, None);
        missing.checks.remove("summary-free-of-todos");
        let error = failing(&records, &[missing]);
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(
            error.field_path, "/cases/0/checks/summary-free-of-todos",
            "{error}"
        );

        // One negative elapsed time and one negative usage amount.
        let mut negative = case("metric-cases-1", "pass", "pass", "pass", 1, Some(-1.0));
        let error = failing(&records, &[negative.clone()]);
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/cases/0/elapsed_ms", "{error}");
        negative.elapsed_ms = Some(1.0);
        negative.usage.insert("input_tokens".to_owned(), -5.0);
        let error = failing(&records, &[negative]);
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/cases/0/usage/input_tokens", "{error}");
    }

    #[test]
    fn one_metric_set_serializes_to_the_contract_shape() {
        let records = file(&[record(
            "metric-cases-1",
            &[],
            Some(
                json!({"checks": {"notes-complete": {"answer": "no"}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "fail"}),
            ),
        )]);
        let outcomes = [case(
            "metric-cases-1",
            "pass",
            "pass",
            "pass",
            1,
            Some(10.0),
        )];
        let metrics = computed(&records, &outcomes);
        let set = metrics.metric_set("notes-complete").expect("the check set");
        let value = serde_json::to_value(set).expect("the set serializes");
        // The serialized shape is the metric_set block of the evaluation
        // report contract. The confusion matrix stays Rust-side state.
        let keys: BTreeSet<&str> = value
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["counts", "rates", "scope"].into_iter().collect());
        let rate = &value["rates"][0];
        assert_eq!(rate["metric"], "false_acceptance_rate");
        assert_eq!(rate["numerator"], 1);
        assert_eq!(rate["denominator"], 1);
        assert_eq!(rate["value"], 1.0);
        // One unavailable rate serializes one null value, not zero.
        let unavailable = metrics
            .metric_set(ALL_CHECKS)
            .expect("the complete set")
            .rate(MetricName::FalseRejectionRate);
        let serialized = serde_json::to_value(unavailable).expect("the rate serializes");
        assert_eq!(serialized["value"], Value::Null);
    }

    #[test]
    fn one_measurement_states_the_reference_of_every_case() {
        let records = file(&[
            // Reference fail on the question check, predicted pass.
            record(
                "metric-cases-1",
                &[],
                Some(
                    json!({"checks": {"notes-complete": {"answer": "no"}, "summary-free-of-todos": {"outcome": "pass"}}, "outcome": "fail"}),
                ),
            ),
            // No labels at all.
            record("metric-cases-2", &[], None),
            // One review marker on the question check alone, so the rule
            // check of this case holds no reference.
            record(
                "metric-cases-3",
                &[],
                Some(json!({"checks": {"notes-complete": {"review": true}}})),
            ),
        ]);
        let outcomes = [
            case("metric-cases-1", "pass", "pass", "pass", 1, None),
            case("metric-cases-2", "pass", "fail", "fail", 1, None),
            case("metric-cases-3", "review", "pass", "review", 1, None),
        ];
        let measurement = measured(&records, &outcomes);

        // The cases follow the order of the outcomes, and every check of the
        // definition appears, including one without a reference.
        let ids: Vec<&str> = measurement
            .cases
            .iter()
            .map(|case| case.case_id.as_str())
            .collect();
        assert_eq!(ids, ["metric-cases-1", "metric-cases-2", "metric-cases-3"]);
        assert_eq!(measurement.metrics.case_count, 3);
        assert_eq!(measurement.metrics.unevaluated_records, 0);

        // One predicted pass against one reference fail states one false
        // match, and the rule check of the same case states one true match.
        let first = &measurement.cases[0];
        assert_eq!(
            first.reference,
            BTreeMap::from([
                ("notes-complete".to_owned(), Some(Outcome::Fail)),
                ("summary-free-of-todos".to_owned(), Some(Outcome::Pass)),
            ])
        );
        assert_eq!(
            first.matched,
            BTreeMap::from([
                ("notes-complete".to_owned(), Some(false)),
                ("summary-free-of-todos".to_owned(), Some(true)),
            ])
        );

        // One case without labels holds no reference and no match.
        let second = &measurement.cases[1];
        assert!(second.reference.values().all(Option::is_none));
        assert!(second.matched.values().all(Option::is_none));

        // One reference on one check alone leaves the other check without
        // one, and the review match counts as true.
        let third = &measurement.cases[2];
        assert_eq!(
            third.reference,
            BTreeMap::from([
                ("notes-complete".to_owned(), Some(Outcome::Review)),
                ("summary-free-of-todos".to_owned(), None),
            ])
        );
        assert_eq!(
            third.matched,
            BTreeMap::from([
                ("notes-complete".to_owned(), Some(true)),
                ("summary-free-of-todos".to_owned(), None),
            ])
        );

        // The serialized shape names the fields the report contract states.
        let value = serde_json::to_value(&measurement.cases[0]).expect("the case serializes");
        let keys: BTreeSet<&str> = value
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["case_id", "matched", "reference"].into_iter().collect()
        );
        assert_eq!(value["reference"]["notes-complete"], "fail");

        // One evaluation without one case refuses exactly as the metric
        // boundary does, because the measurement runs it first.
        let error = {
            let definition = definition();
            let metadata_text = serde_json::to_string(&metadata()).expect("serializes");
            let dataset = load_dataset(&metadata_text, &records).expect("the dataset loads");
            let validated = crate::dataset::validate_dataset(&dataset, &definition)
                .expect("the dataset validates");
            evaluate(&validated, &[]).expect_err("the evaluation was accepted")
        };
        assert_eq!(error.code, ReasonCode::InsufficientEvidence, "{error}");
        assert_eq!(error.field_path, "/cases", "{error}");
    }

    #[test]
    fn one_run_report_becomes_one_evaluated_case() {
        /// One valid content hash for the reference fields.
        fn hash_hex(character: char) -> String {
            std::iter::repeat_n(character, 64).collect()
        }
        let mut question = CheckRecord::from_question(
            "notes-complete",
            Outcome::Pass,
            json!({"kind": "binary", "value": true}),
            crate::report::AppliedPolicy {
                accept_cutoff: 0.75,
                rejection_cutoff: 0.65,
                confidence_floor: None,
            },
            crate::report::QuestionMeasurements::parse(
                &json!({"usage": {"input_tokens": 120, "output_tokens": 30}}),
                "/measurements",
            )
            .expect("the measurements parse"),
        );
        question.attempts = Some(2);
        let mut rule = CheckRecord::from_rule_result(&crate::rule::RuleResult {
            check: "summary-free-of-todos".to_owned(),
            outcome: crate::rule::RuleOutcome::Pass,
            applied_rule: crate::rule::AppliedRule::new(
                crate::definition::Rule::Excludes {
                    excludes: "TODO".to_owned(),
                },
                "summary",
            ),
            reason: "The summary holds no TODO marker.".to_owned(),
        });
        rule.attempts = Some(1);
        let report = ReportBuilder::new(
            "run-000001",
            RunMode::Shadow,
            ArtifactReference {
                name: "release-notes-review".to_owned(),
                content_hash: hash_hex('a'),
            },
            ProfileReference {
                id: "notes-profile".to_owned(),
                content_hash: hash_hex('b'),
            },
            CaseReference {
                id: "metric-cases-1".to_owned(),
                input_hash: hash_hex('c'),
                snapshot: None,
            },
            Completion {
                status: CompletionStatus::Completed,
                completed_at: None,
            },
        )
        .check(question)
        .check(rule)
        .totals(Totals {
            elapsed_ms: Some(json!(2100).as_number().expect("a number").clone()),
            usage: Some(
                json!({"input_tokens": 120, "output_tokens": 30})
                    .as_object()
                    .expect("an object")
                    .clone(),
            ),
        })
        .finish()
        .expect("the report finishes");
        let outcome = CaseOutcome::from_report(&report);
        assert_eq!(outcome.case_id, "metric-cases-1");
        assert_eq!(
            outcome.checks,
            BTreeMap::from([
                ("notes-complete".to_owned(), Outcome::Pass),
                ("summary-free-of-todos".to_owned(), Outcome::Pass),
            ])
        );
        assert_eq!(outcome.aggregate, AggregateOutcome::Pass);
        assert_eq!(outcome.completion, CompletionStatus::Completed);
        assert_eq!(outcome.attempts, 3);
        assert_eq!(outcome.elapsed_ms, Some(2100.0));
        assert_eq!(
            outcome.usage,
            BTreeMap::from([
                ("input_tokens".to_owned(), 120.0),
                ("output_tokens".to_owned(), 30.0),
            ])
        );

        // Without run totals, the usage sums over the component records
        // and the elapsed time stays absent.
        let bare = ReportBuilder::new(
            "run-000002",
            RunMode::Shadow,
            ArtifactReference {
                name: "release-notes-review".to_owned(),
                content_hash: hash_hex('a'),
            },
            ProfileReference {
                id: "notes-profile".to_owned(),
                content_hash: hash_hex('b'),
            },
            CaseReference {
                id: "metric-cases-1".to_owned(),
                input_hash: hash_hex('c'),
                snapshot: None,
            },
            Completion {
                status: CompletionStatus::Cancelled,
                completed_at: None,
            },
        )
        .check(CheckRecord::from_question(
            "notes-complete",
            Outcome::Review,
            json!({"kind": "binary", "value": true}),
            crate::report::AppliedPolicy {
                accept_cutoff: 0.75,
                rejection_cutoff: 0.65,
                confidence_floor: None,
            },
            crate::report::QuestionMeasurements::parse(
                &json!({"usage": {"input_tokens": 40}}),
                "/measurements",
            )
            .expect("the measurements parse"),
        ))
        .check(CheckRecord::from_rule_result(&crate::rule::RuleResult {
            check: "summary-free-of-todos".to_owned(),
            outcome: crate::rule::RuleOutcome::Fail,
            applied_rule: crate::rule::AppliedRule::new(
                crate::definition::Rule::Excludes {
                    excludes: "TODO".to_owned(),
                },
                "summary",
            ),
            reason: "The summary holds one TODO marker.".to_owned(),
        }))
        .finish()
        .expect("the report finishes");
        let outcome = CaseOutcome::from_report(&bare);
        assert_eq!(outcome.attempts, 0);
        assert_eq!(outcome.elapsed_ms, None);
        assert_eq!(
            outcome.usage,
            BTreeMap::from([("input_tokens".to_owned(), 40.0)])
        );
        assert_eq!(outcome.completion, CompletionStatus::Cancelled);
    }
}
