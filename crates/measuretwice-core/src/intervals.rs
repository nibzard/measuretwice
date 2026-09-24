// SPDX-License-Identifier: Apache-2.0
//! Uncertainty intervals for the contract metrics.
//!
//! An observed rate states one number over one denominator. This module
//! states what that number still allows, as MVP_SPEC.md section 7 requires:
//! tested statistical routines with an explicit method, an explicit
//! confidence level, and explicit sampling assumptions, validated against
//! independent reference fixtures.
//!
//! The method is the Wilson score interval of one binomial proportion.
//! It needs no approximation of the normal distribution beyond the two
//! quantiles it states, it stays inside `[0, 1]` at every denominator, and
//! it holds one upper bound at zero observed errors, which is the point of
//! the method: zero observed errors is not proof of zero risk, and
//! qualification compares an upper bound with the declared limit instead of
//! the observed rate alone.
//!
//! One interval is one statement about draws, not about cases alone:
//!
//! - `independent_cases` states that every case of the denominator is one
//!   independent draw. The dataset groups contradict that statement when
//!   one group holds two cases of the same denominator, because two cases
//!   of one conversation or one source are correlated. Such a scope holds
//!   no interval: the row states `unsupported_sampling` instead of one
//!   bound computed from an assumption the data breaks.
//! - `grouped_cases` makes the group the draw. The interval then bounds the
//!   share of groups that hold at least one counted event, beside the case
//!   counts of the rate. That is a different quantity than the case rate,
//!   and the row keeps both visible rather than blending them.
//!
//! Evidence comes before arithmetic. One metric without a denominator, and
//! one denominator below the declared minimum of draws, states
//! `insufficient_evidence` with its counts, because a small sample states
//! no bound worth citing. Every row keeps the numerator and the denominator
//! of its rate, the draws behind the interval, the method, the confidence
//! level, and the sampling word, so one report that cites an interval can
//! state where the number came from.
//!
//! The boundary rejects what it cannot compute rather than guessing: one
//! confidence level outside the three supported levels, one count that is
//! not one whole number inside the dataset limit, and one numerator above
//! its own denominator fail with their field paths, and one sampling word
//! the methods do not support fails with `unsupported_sampling`.

use crate::dataset::ValidatedDataset;
use crate::error::{ReasonCode, ValidationError};
use crate::metrics::{self, CaseOutcome, ConfusionMatrix, MetricName, MetricSet};
use crate::report::{AggregateOutcome, Outcome};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// The named interval method of this core, as one profile records it in its
/// `performance.intervals` block: the Wilson score interval of one binomial
/// proportion.
pub const METHOD: &str = "wilson_score";

/// The confidence levels one plan may declare, in the order of the
/// calibration plan contract.
pub const SUPPORTED_LEVELS: [f64; 3] = [0.9, 0.95, 0.99];

/// The standing assumption of `independent_cases`.
pub const INDEPENDENT_CASES_ASSUMPTION: &str = "Every case of the denominator is one independent draw: no group of the dataset holds two cases of the same denominator.";

/// The standing assumption of `grouped_cases`.
pub const GROUPED_CASES_ASSUMPTION: &str = "The group is the draw. The interval bounds the share of groups that hold at least one counted event, beside the case counts of the rate.";

/// The standing statement that zero observed errors bound no zero risk.
pub const ZERO_ERRORS_STATEMENT: &str = "Zero observed errors is not proof of zero risk: the upper bound states the risk the counts still allow.";

/// One confidence level an interval may state.
///
/// The calibration plan contract declares exactly these three levels, so an
/// interval rejects every other number. The standard normal quantile of
/// each level is the two-sided value at that level, correctly rounded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConfidenceLevel {
    /// 0.9, with the quantile 1.6448536269514726.
    Ninety,
    /// 0.95, with the quantile 1.9599639845400543.
    NinetyFive,
    /// 0.99, with the quantile 2.575829303548901.
    NinetyNine,
}

impl Serialize for ConfidenceLevel {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_f64(self.as_f64())
    }
}

impl ConfidenceLevel {
    /// Returns the number of this level, as the plan contract states it.
    pub const fn as_f64(self) -> f64 {
        match self {
            Self::Ninety => 0.9,
            Self::NinetyFive => 0.95,
            Self::NinetyNine => 0.99,
        }
    }

    /// Returns the whole percent of this level, for one readable statement.
    pub const fn percent(self) -> u8 {
        match self {
            Self::Ninety => 90,
            Self::NinetyFive => 95,
            Self::NinetyNine => 99,
        }
    }

    /// Returns the two-sided standard normal quantile of this level.
    pub const fn z(self) -> f64 {
        match self {
            Self::Ninety => 1.644_853_626_951_472_6,
            Self::NinetyFive => 1.959_963_984_540_054_3,
            Self::NinetyNine => 2.575_829_303_548_901,
        }
    }

    /// Returns the level of one declared number, or `None` when the number
    /// states no supported level.
    pub fn from_number(number: f64) -> Option<Self> {
        match number {
            value if value == Self::Ninety.as_f64() => Some(Self::Ninety),
            value if value == Self::NinetyFive.as_f64() => Some(Self::NinetyFive),
            value if value == Self::NinetyNine.as_f64() => Some(Self::NinetyNine),
            _ => None,
        }
    }
}

/// One declared sampling model behind an interval.
///
/// The model states what counts as one draw. It is a declaration, not one
/// observation: [`evaluate_intervals`] compares it with the groups of the
/// measured cases and reports `unsupported_sampling` when the data breaks
/// the declared assumption.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SamplingModel {
    /// Every case of one denominator is one independent draw.
    IndependentCases,
    /// The group is the draw.
    GroupedCases,
}

impl SamplingModel {
    /// Returns the contract word of this model.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::IndependentCases => "independent_cases",
            Self::GroupedCases => "grouped_cases",
        }
    }

    /// Returns the standing assumption statement of this model.
    pub const fn assumption(self) -> &'static str {
        match self {
            Self::IndependentCases => INDEPENDENT_CASES_ASSUMPTION,
            Self::GroupedCases => GROUPED_CASES_ASSUMPTION,
        }
    }

    /// Returns the model of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "independent_cases" => Some(Self::IndependentCases),
            "grouped_cases" => Some(Self::GroupedCases),
            _ => None,
        }
    }
}

/// One interval request: the declared sampling model, the confidence level,
/// and the minimum number of draws one interval needs.
///
/// `minimum_samples` states the smallest draw count that carries evidence,
/// as the plan of one calibration declares for its denominators. One
/// denominator below it states `insufficient_evidence`, not one wide bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct IntervalRequest {
    /// The declared sampling model.
    pub sampling: SamplingModel,
    /// The declared confidence level.
    pub confidence_level: ConfidenceLevel,
    /// The minimum number of draws one interval needs.
    pub minimum_samples: usize,
}

/// Parses one interval request out of one JSON object.
///
/// The object states `sampling` as one contract word, `confidence_level` as
/// one supported number, and `minimum_samples` as one whole number of at
/// least one. Nothing else is accepted, no field is optional, and no value
/// is coerced.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `unsupported_sampling` at `/sampling`
/// when the word names no supported model, with `invalid_field_type` at
/// `/confidence_level` when the number states no supported level, with
/// `invalid_field_type` at `/minimum_samples` when the value is not one
/// whole number of at least one, with `missing_field` and `unknown_field`
/// for the fields of the object, and with `invalid_json` for malformed
/// text in [`parse_interval_request_str`].
pub fn parse_interval_request(value: &Value) -> Result<IntervalRequest, ValidationError> {
    let Value::Object(fields) = value else {
        return Err(ValidationError::invalid_field_type(
            "",
            "One interval request must hold one object.",
        ));
    };
    for key in fields.keys() {
        if !matches!(
            key.as_str(),
            "sampling" | "confidence_level" | "minimum_samples"
        ) {
            return Err(ValidationError::new(
                ReasonCode::UnknownField,
                format!("/{key}"),
                format!(
                    "The interval request holds no {} field. State sampling, confidence_level, and minimum_samples.",
                    crate::error::fragment(key)
                ),
            ));
        }
    }
    let sampling = match fields.get("sampling") {
        Some(Value::String(word)) => SamplingModel::from_word(word).ok_or_else(|| {
            ValidationError::new(
                ReasonCode::UnsupportedSampling,
                "/sampling",
                format!(
                    "The interval methods support no sampling model {}. State independent_cases or grouped_cases.",
                    crate::error::fragment(word)
                ),
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/sampling",
                "The sampling model must hold one word.",
            ));
        }
        None => return Err(ValidationError::missing("/sampling")),
    };
    let confidence_level = match fields.get("confidence_level") {
        Some(Value::Number(number)) => {
            let value = number.as_f64().ok_or_else(level_rejection)?;
            ConfidenceLevel::from_number(value).ok_or_else(level_rejection)?
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/confidence_level",
                "The confidence level must hold one number.",
            ));
        }
        None => return Err(ValidationError::missing("/confidence_level")),
    };
    let minimum_samples = match fields.get("minimum_samples") {
        Some(value) => parse_count(value, "/minimum_samples")?,
        None => return Err(ValidationError::missing("/minimum_samples")),
    };
    if minimum_samples < 1 {
        return Err(ValidationError::invalid_field_type(
            "/minimum_samples",
            "The minimum sample count must hold one whole number of at least one.",
        ));
    }
    Ok(IntervalRequest {
        sampling,
        confidence_level,
        minimum_samples,
    })
}

/// Builds the rejection of one unsupported confidence level.
fn level_rejection() -> ValidationError {
    ValidationError::invalid_field_type(
        "/confidence_level",
        "The interval methods support the confidence levels 0.9, 0.95, and 0.99 alone.",
    )
}

/// Parses one interval request out of its artifact text.
///
/// # Errors
///
/// Returns the failure of [`crate::json::parse_strict`] for malformed text,
/// otherwise the failure of [`parse_interval_request`].
pub fn parse_interval_request_str(text: &str) -> Result<IntervalRequest, ValidationError> {
    let value = crate::json::parse_strict(text)?;
    parse_interval_request(&value)
}

/// Parses one count of one rate or one interval.
///
/// A count is one whole number from zero to the dataset record limit, the
/// largest denominator one evaluation may hold. One fraction, one negative
/// number, one non-finite number, and one value above the limit all fail,
/// because no count of one evaluation takes that shape.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` at the stated
/// field path.
pub fn parse_count(value: &Value, field_path: &str) -> Result<usize, ValidationError> {
    let Value::Number(number) = value else {
        return Err(ValidationError::invalid_field_type(
            field_path,
            "A count must hold one whole number.",
        ));
    };
    let amount = number
        .as_f64()
        .ok_or_else(|| invalid_count(field_path, "one whole number"))?;
    if !amount.is_finite() || amount < 0.0 || amount.fract() != 0.0 {
        return Err(invalid_count(
            field_path,
            "one whole number of zero or more",
        ));
    }
    if amount > crate::dataset::MAX_DATASET_RECORDS as f64 {
        return Err(invalid_count(
            field_path,
            format!(
                "one whole number of at most {}, the dataset record limit",
                crate::dataset::MAX_DATASET_RECORDS
            ),
        ));
    }
    Ok(amount as usize)
}

/// Builds the rejection of one count outside its bounds.
fn invalid_count(field_path: &str, expected: impl Into<String>) -> ValidationError {
    ValidationError::invalid_field_type(
        field_path,
        format!("A count must hold {}.", expected.into()),
    )
}

/// Computes the Wilson score interval of one proportion.
///
/// With `p = numerator / denominator`, `z` the two-sided quantile of the
/// level, and `f = z^2 / denominator`:
///
/// ```text
/// center = (p + f / 2) / (1 + f)
/// half   = z / (1 + f) * sqrt(p * (1 - p) / denominator + f / (4 * denominator))
/// lower  = clamp(center - half), upper = clamp(center + half)
/// ```
///
/// The bounds clamp to `[0, 1]`, so one observed zero states the lower
/// bound zero and one observed all states the upper bound one, and the
/// small negative cancellation of one observed zero clamps to zero.
///
/// The method states its assumption: the `denominator` counts independent
/// draws of one binomial sample. Correlated draws need the grouping
/// strategy of [`evaluate_intervals`], not this function alone.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` at `/numerator`
/// when the numerator exceeds the denominator and with
/// `insufficient_evidence` at `/denominator` when the denominator is zero,
/// because one rate without one denominator holds no evidence.
pub fn wilson_interval(
    numerator: usize,
    denominator: usize,
    level: ConfidenceLevel,
) -> Result<(f64, f64), ValidationError> {
    if numerator > denominator {
        return Err(ValidationError::invalid_field_type(
            "/numerator",
            "The numerator must not exceed the denominator, because one rate counts one share of its own denominator.",
        ));
    }
    if denominator == 0 {
        return Err(ValidationError::new(
            ReasonCode::InsufficientEvidence,
            "/denominator",
            "A rate without one denominator holds no evidence, so no interval computes.",
        ));
    }
    let draws = denominator as f64;
    let observed = numerator as f64 / draws;
    let factor = level.z() * level.z() / draws;
    let scale = 1.0 + factor;
    let center = (observed + factor / 2.0) / scale;
    let spread = (observed * (1.0 - observed) / draws + factor / (4.0 * draws)).sqrt();
    let half = level.z() / scale * spread;
    Ok((
        (center - half).clamp(0.0, 1.0),
        (center + half).clamp(0.0, 1.0),
    ))
}

/// One computed interval of one metric of one scope.
///
/// A row states everything one report needs to cite it: the counts of the
/// rate, the draws behind the interval, the named method, the confidence
/// level, and the sampling word. The fields `scope`, `metric`, `method`,
/// `confidence_level`, `lower`, and `upper` are the fields of the interval
/// block of the profile contract, so one qualification records the row
/// without renaming it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Interval {
    /// Check identifier, or `all_checks`.
    pub scope: String,
    /// The metric of the rate this interval covers.
    pub metric: MetricName,
    /// The named interval method. Always [`METHOD`].
    pub method: &'static str,
    /// The stated confidence level.
    pub confidence_level: f64,
    /// The declared sampling model.
    pub sampling: &'static str,
    /// Cases in the numerator, as the rate states them.
    pub numerator: usize,
    /// Cases in the denominator, as the rate states them.
    pub denominator: usize,
    /// Draws behind the interval: cases under `independent_cases`, groups
    /// under `grouped_cases`.
    pub draws: usize,
    /// Draws that hold at least one counted event.
    pub event_draws: usize,
    /// Lower bound, or `None` when no bound computes.
    pub lower: Option<f64>,
    /// Upper bound, or `None` when no bound computes.
    pub upper: Option<f64>,
    /// The reason no bound computes, or `None` when the bounds exist.
    pub reason: Option<ReasonCode>,
}

impl Interval {
    /// Returns the upper bound of this interval.
    ///
    /// Qualification compares this bound with the declared limit, because
    /// one observed rate alone understates the risk of one small sample.
    pub fn upper_bound(&self) -> Option<f64> {
        self.upper
    }

    /// Returns true when this interval states `insufficient_evidence`.
    pub fn is_insufficient(&self) -> bool {
        self.reason == Some(ReasonCode::InsufficientEvidence)
    }

    /// Returns true when this interval states `unsupported_sampling`.
    pub fn is_unsupported_sampling(&self) -> bool {
        self.reason == Some(ReasonCode::UnsupportedSampling)
    }

    /// Compares the upper bound with one declared limit of the plan.
    ///
    /// Returns `true` when the bound stays at or below the limit, `false`
    /// when it exceeds it, and `None` when this interval states no bound,
    /// because one missing bound satisfies no constraint.
    pub fn upper_within(&self, limit: f64) -> Option<bool> {
        self.upper.map(|upper| upper <= limit)
    }
}

/// The intervals of one scope.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IntervalSet {
    /// Check identifier, or `all_checks`.
    pub scope: String,
    /// One interval per contract metric, in the order of the metric enum.
    pub intervals: Vec<Interval>,
}

impl IntervalSet {
    /// Returns the interval of one metric.
    ///
    /// # Panics
    ///
    /// Panics when the metric names no interval of this set, because every
    /// set holds the six contract metrics.
    pub fn interval(&self, metric: MetricName) -> &Interval {
        self.intervals
            .iter()
            .find(|interval| interval.metric == metric)
            .unwrap_or_else(|| panic!("the interval set holds {}", metric.as_str()))
    }
}

/// The intervals of one slice tag.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SliceIntervals {
    /// The case tag that groups these intervals.
    pub tag: String,
    /// One interval set per scope, in the order of the complete result.
    pub scopes: Vec<IntervalSet>,
}

/// The complete interval result of one evaluation.
///
/// Every scope of the measurement appears once: one interval set per check
/// of the definition, in definition order, then the `all_checks` set. Every
/// slice tag appears once with the same scopes. Each row carries its own
/// reason, so one scope with no evidence states it instead of blocking the
/// rest.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IntervalReport {
    /// The named interval method. Always [`METHOD`].
    pub method: &'static str,
    /// The stated confidence level.
    pub confidence_level: f64,
    /// The declared sampling model.
    pub sampling: &'static str,
    /// The standing assumption of the sampling model.
    pub assumption: &'static str,
    /// The minimum number of draws one interval needs.
    pub minimum_samples: usize,
    /// The complete method statement, for the `method` field of one
    /// evaluation report and the `statistical_method` field of one profile.
    pub method_statement: String,
    /// One interval set per check, then the complete check set.
    pub scopes: Vec<IntervalSet>,
    /// One interval set row per slice tag, ordered by tag.
    pub slices: Vec<SliceIntervals>,
}

impl IntervalReport {
    /// Returns the interval set of one scope, check identifier or
    /// `all_checks`.
    pub fn set(&self, scope: &str) -> Option<&IntervalSet> {
        self.scopes.iter().find(|set| set.scope == scope)
    }

    /// Returns the interval sets of one slice tag.
    pub fn slice(&self, tag: &str) -> Option<&SliceIntervals> {
        self.slices.iter().find(|slice| slice.tag == tag)
    }
}

/// One evaluated case with the facts the grouping needs: the predicted
/// outcome and the resolved reference of every scope.
struct PreparedCase<'a> {
    /// The evaluated case.
    outcome: &'a CaseOutcome,
    /// The resolved reference of every defined check.
    references: Vec<Option<Outcome>>,
    /// The predicted outcome of every defined check, then the component
    /// outcome of the aggregate.
    predicted: Vec<Outcome>,
    /// The resolved overall reference.
    overall: Option<Outcome>,
}

/// The grouping evidence of one metric inside one population.
#[derive(Debug, Default, Clone, Copy)]
struct MetricEvidence {
    /// Cases in the denominator.
    cases: usize,
    /// Cases in the numerator.
    events: usize,
    /// Groups that hold at least one denominator case.
    groups: usize,
    /// Groups that hold at least one numerator event.
    event_groups: usize,
    /// The most denominator cases one group holds.
    widest_group: usize,
}

/// Computes the uncertainty intervals of one measured evaluation.
///
/// The measurement itself comes from [`metrics::evaluate_metrics`], so every
/// validation rule of that boundary applies unchanged and every interval
/// reads the counts of the stated rates. The grouping then reads the groups
/// of the dataset records: one group folds into one confusion matrix per
/// scope, and [`metrics::rate_of`] reads every metric count of that group
/// exactly the way the complete scope reads it.
///
/// The declared sampling model decides what counts as one draw. Under
/// `independent_cases`, one metric whose denominator holds two cases of one
/// group states `unsupported_sampling`, because the binomial assumption of
/// the method is broken, not merely inconvenient. Under `grouped_cases`,
/// the group is the draw and the interval bounds the share of groups with
/// at least one counted event.
///
/// # Errors
///
/// Returns the failure of [`metrics::evaluate_metrics`], which includes
/// `insufficient_evidence` at `/cases` when no evaluated case exists.
pub fn evaluate_intervals(
    dataset: &ValidatedDataset<'_>,
    outcomes: &[CaseOutcome],
    request: &IntervalRequest,
) -> Result<IntervalReport, ValidationError> {
    let measurement = metrics::evaluate_metrics(dataset, outcomes)?;
    let definition = dataset.definition();
    let check_ids: Vec<&str> = definition
        .as_definition()
        .checks
        .iter()
        .map(|check| check.id.as_str())
        .collect();

    // The predicted outcomes and the resolved references of every scope,
    // computed once, because the complete result and every slice count the
    // same pairs.
    let positions: BTreeMap<&str, usize> = dataset
        .records()
        .iter()
        .enumerate()
        .map(|(index, record)| (record.id.as_str(), index))
        .collect();
    let prepared: Vec<PreparedCase<'_>> = outcomes
        .iter()
        .map(|outcome| {
            let record = dataset
                .record(positions[outcome.case_id.as_str()])
                .expect("evaluate_metrics accepted the case identifier");
            let expected = record.expected();
            let references: Vec<Option<Outcome>> = check_ids
                .iter()
                .map(|check_id| {
                    expected.and_then(|labels| {
                        labels
                            .checks
                            .get(*check_id)
                            .and_then(|one| metrics::reference_outcome(definition, check_id, one))
                    })
                })
                .collect();
            let predicted = check_ids
                .iter()
                .map(|check_id| outcome.checks[*check_id])
                .collect();
            PreparedCase {
                outcome,
                references,
                predicted,
                overall: expected
                    .and_then(|labels| metrics::overall_reference_outcome(definition, labels)),
            }
        })
        .collect();
    let predicted = |case: &PreparedCase<'_>| {
        let mut values = case.predicted.clone();
        values.push(component(case.outcome.aggregate));
        values
    };

    // The cases of one population, read through the groups and the tags of
    // their records. One group holds the positions of its cases in
    // `prepared`, because the sampling model needs the groups, not the
    // splits: one group inside one split still correlates two cases.
    let case_groups: Vec<String> = prepared
        .iter()
        .map(|case| {
            dataset
                .record(positions[case.outcome.case_id.as_str()])
                .expect("evaluate_metrics accepted the case identifier")
                .group()
                .to_owned()
        })
        .collect();
    let case_tags: Vec<Vec<String>> = prepared
        .iter()
        .map(|case| {
            dataset
                .record(positions[case.outcome.case_id.as_str()])
                .expect("evaluate_metrics accepted the case identifier")
                .tags()
                .to_vec()
        })
        .collect();
    let groups_of = |cases: &[usize]| -> BTreeMap<&str, Vec<usize>> {
        let mut groups: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        for index in cases {
            groups
                .entry(case_groups[*index].as_str())
                .or_default()
                .push(*index);
        }
        groups
    };
    let tags_of = |cases: &[usize]| -> BTreeMap<String, Vec<usize>> {
        let mut tags: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for index in cases {
            for tag in &case_tags[*index] {
                tags.entry(tag.clone()).or_default().push(*index);
            }
        }
        tags
    };

    let whole: Vec<usize> = (0..prepared.len()).collect();
    let scopes = scope_intervals(
        &groups_of(&whole),
        &prepared,
        &predicted,
        &measurement.scopes,
        request,
    );
    let slices = tags_of(&whole)
        .into_iter()
        .map(|(tag, cases)| SliceIntervals {
            tag: tag.clone(),
            scopes: scope_intervals(
                &groups_of(&cases),
                &prepared,
                &predicted,
                &measurement
                    .slice(&tag)
                    .expect("the slice was measured")
                    .metrics,
                request,
            ),
        })
        .collect();
    Ok(IntervalReport {
        method: METHOD,
        confidence_level: request.confidence_level.as_f64(),
        sampling: request.sampling.as_str(),
        assumption: request.sampling.assumption(),
        minimum_samples: request.minimum_samples,
        method_statement: method_statement(request),
        scopes,
        slices,
    })
}

/// Builds the complete method statement of one request.
///
/// The statement names the method, the confidence level, the sampling
/// assumption, the minimum evidence, and the meaning of one observed zero,
/// so one report that cites one interval states where its numbers came
/// from. It stays inside the 2000 characters the report and profile
/// contracts allow. The frozen validation of [`crate::qualification`]
/// records the same statement, because one profile cites one method for
/// its fitting rows and its validation rows together.
pub(crate) fn method_statement(request: &IntervalRequest) -> String {
    format!(
        "Wilson score intervals at {} percent confidence. {} One interval needs its own denominator and at least {} {}. {}",
        request.confidence_level.percent(),
        request.sampling.assumption(),
        request.minimum_samples,
        draw_word(request.sampling),
        ZERO_ERRORS_STATEMENT,
    )
}

/// Returns the noun of one draw under one sampling model.
const fn draw_word(sampling: SamplingModel) -> &'static str {
    match sampling {
        SamplingModel::IndependentCases => "independent cases",
        SamplingModel::GroupedCases => "groups",
    }
}

/// Computes the interval sets of one population: the whole scope list, or
/// the same list of one slice.
///
/// `groups` holds the cases of the population per group and `measured`
/// holds the metric sets of the same population in the same scope order, so
/// every interval keeps the counts of the stated rate. `predicted` builds
/// the predicted outcome of every scope of one case, because the check
/// scopes read their own check and the complete scope reads the aggregate.
fn scope_intervals(
    groups: &BTreeMap<&str, Vec<usize>>,
    prepared: &[PreparedCase<'_>],
    predicted: &dyn Fn(&PreparedCase<'_>) -> Vec<Outcome>,
    measured: &[MetricSet],
    request: &IntervalRequest,
) -> Vec<IntervalSet> {
    let scope_count = measured.len();
    let mut sets = Vec::with_capacity(scope_count);
    for slot in 0..scope_count {
        // One confusion matrix per group, so the evidence of every metric
        // reads its counts from the same definition the stated rate reads.
        let mut evidence: Vec<MetricEvidence> = MetricName::ALL
            .iter()
            .map(|_| MetricEvidence::default())
            .collect();
        for members in groups.values() {
            let mut matrix = ConfusionMatrix::default();
            for index in members {
                let case = &prepared[*index];
                let values = predicted(case);
                matrix.record(
                    if slot < case.references.len() {
                        case.references[slot]
                    } else {
                        case.overall
                    },
                    values[slot],
                );
            }
            for (position, metric) in MetricName::ALL.into_iter().enumerate() {
                let rate = metrics::rate_of(metric, &matrix);
                let entry = &mut evidence[position];
                entry.cases += rate.denominator;
                entry.events += rate.numerator;
                if rate.denominator > 0 {
                    entry.groups += 1;
                    entry.widest_group = entry.widest_group.max(rate.denominator);
                    if rate.numerator > 0 {
                        entry.event_groups += 1;
                    }
                }
            }
        }
        let set = &measured[slot];
        let intervals = MetricName::ALL
            .into_iter()
            .zip(evidence)
            .map(|(metric, evidence)| {
                let rate = set.rate(metric);
                // The group fold counts the same pairs the measurement
                // counted, so the counts agree or the fold is broken.
                debug_assert_eq!(
                    (evidence.events, evidence.cases),
                    (rate.numerator, rate.denominator),
                    "the group fold of {} disagrees with the measurement",
                    metric.as_str()
                );
                let (draws, event_draws, unsupported) = match request.sampling {
                    SamplingModel::IndependentCases => {
                        (evidence.cases, evidence.events, evidence.widest_group > 1)
                    }
                    SamplingModel::GroupedCases => (evidence.groups, evidence.event_groups, false),
                };
                let (lower, upper, reason) = if rate.denominator == 0 {
                    (None, None, Some(ReasonCode::InsufficientEvidence))
                } else if unsupported {
                    (None, None, Some(ReasonCode::UnsupportedSampling))
                } else if draws < request.minimum_samples {
                    (None, None, Some(ReasonCode::InsufficientEvidence))
                } else {
                    let (lower, upper) =
                        wilson_interval(event_draws, draws, request.confidence_level)
                            .expect("the denominator holds the draws");
                    (Some(lower), Some(upper), None)
                };
                Interval {
                    scope: set.scope.clone(),
                    metric,
                    method: METHOD,
                    confidence_level: request.confidence_level.as_f64(),
                    sampling: request.sampling.as_str(),
                    numerator: rate.numerator,
                    denominator: rate.denominator,
                    draws,
                    event_draws,
                    lower,
                    upper,
                    reason,
                }
            })
            .collect();
        sets.push(IntervalSet {
            scope: set.scope.clone(),
            intervals,
        });
    }
    sets
}

/// Returns the component outcome word of one aggregate outcome. The
/// aggregate folds one skip into review, so the complete check set counts
/// no skipped case of its own.
const fn component(aggregate: AggregateOutcome) -> Outcome {
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
    use serde_json::json;

    /// One valid definition with one binary question and one rule check.
    fn definition() -> crate::definition::ValidatedDefinition {
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

    /// One metadata artifact of the interval tests.
    fn metadata() -> Value {
        json!({
            "schema_version": 1,
            "id": "interval-cases",
            "revision": "2026-09-24.1",
            "kind": "development_fixture",
            "intended_population": "Release notes of one product area.",
            "sampling_method": "Selected from reviewed development work. No prevalence claim.",
            "label_guidelines": "See docs/labeling.md revision 3.",
            "splits": [{"id": "all", "purpose": "fitting", "groups": ["notes"]}]
        })
    }

    /// One record of the interval tests. Every reference states its
    /// expected outcome, so the reference of each check resolves exactly as
    /// written.
    fn record(id: &str, group: &str, tags: &[&str], expected: Value) -> Value {
        let mut value = json!({
            "id": id,
            "group": group,
            "input": {
                "summary": "The search index now refreshes nightly.",
                "severity": 2,
                "confidence": 0.9,
                "breaking": false,
                "tickets": ["SRCH-101"],
                "metadata": {"team": "search"}
            },
            "label": {"author_type": "human", "reviewed": false},
            "expected": expected
        });
        if !tags.is_empty() {
            value["tags"] = json!(tags);
        }
        value
    }

    /// One labels object that states the outcome of every check and the
    /// overall outcome.
    fn labels(question: &str, rule: &str, overall: &str) -> Value {
        json!({
            "checks": {
                "notes-complete": {"outcome": question},
                "summary-free-of-todos": {"outcome": rule}
            },
            "outcome": overall
        })
    }

    /// One evaluated case of the interval tests.
    fn case(id: &str, question: &str, rule: &str, aggregate: &str) -> CaseOutcome {
        CaseOutcome {
            case_id: id.to_owned(),
            checks: BTreeMap::from([
                ("notes-complete".to_owned(), word(question)),
                ("summary-free-of-todos".to_owned(), word(rule)),
            ]),
            aggregate: match aggregate {
                "pass" => AggregateOutcome::Pass,
                "fail" => AggregateOutcome::Fail,
                "review" => AggregateOutcome::Review,
                _ => AggregateOutcome::Error,
            },
            completion: crate::report::CompletionStatus::Completed,
            attempts: 1,
            elapsed_ms: None,
            usage: BTreeMap::new(),
        }
    }

    /// One outcome word of the tests.
    fn word(word: &str) -> Outcome {
        Outcome::from_word(word).expect("one outcome word")
    }

    /// Validates one dataset of the interval tests and computes its
    /// intervals.
    fn intervals(
        records: &str,
        outcomes: &[CaseOutcome],
        request: &IntervalRequest,
    ) -> IntervalReport {
        let definition = definition();
        let metadata_text = serde_json::to_string(&metadata()).expect("serializes");
        let dataset = load_dataset(&metadata_text, records).expect("the dataset loads");
        let validated =
            crate::dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        evaluate_intervals(&validated, outcomes, request).expect("the intervals compute")
    }

    /// Serializes records into one record file.
    fn file(records: &[Value]) -> String {
        records
            .iter()
            .map(|value| serde_json::to_string(value).expect("serializes"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_supported_levels_round_trip_and_reject_every_other_number() {
        for level in [
            ConfidenceLevel::Ninety,
            ConfidenceLevel::NinetyFive,
            ConfidenceLevel::NinetyNine,
        ] {
            assert_eq!(ConfidenceLevel::from_number(level.as_f64()), Some(level));
            assert_eq!(level.percent() as f64, level.as_f64() * 100.0);
        }
        assert_eq!(SUPPORTED_LEVELS, [0.9, 0.95, 0.99]);
        for rejected in [0.8, 0.0, 1.0, 0.975, 0.995, f64::NAN, f64::INFINITY] {
            assert_eq!(ConfidenceLevel::from_number(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn the_sampling_models_state_their_words_and_assumptions() {
        assert_eq!(
            SamplingModel::from_word("independent_cases"),
            Some(SamplingModel::IndependentCases)
        );
        assert_eq!(
            SamplingModel::from_word("grouped_cases"),
            Some(SamplingModel::GroupedCases)
        );
        for word in ["bootstrap", "", "independent", "GROUPED_CASES", "cluster"] {
            assert_eq!(SamplingModel::from_word(word), None, "{word}");
        }
        assert_eq!(
            SamplingModel::IndependentCases.assumption(),
            INDEPENDENT_CASES_ASSUMPTION
        );
        assert_eq!(
            SamplingModel::GroupedCases.assumption(),
            GROUPED_CASES_ASSUMPTION
        );
        assert!(INDEPENDENT_CASES_ASSUMPTION.contains("independent draw"));
        assert!(GROUPED_CASES_ASSUMPTION.contains("The group is the draw"));
    }

    #[test]
    fn one_request_parses_and_one_broken_request_names_its_field() {
        let request = parse_interval_request(&json!({
            "sampling": "independent_cases",
            "confidence_level": 0.95,
            "minimum_samples": 30
        }))
        .expect("the request parses");
        assert_eq!(
            request,
            IntervalRequest {
                sampling: SamplingModel::IndependentCases,
                confidence_level: ConfidenceLevel::NinetyFive,
                minimum_samples: 30,
            }
        );
        assert_eq!(
            parse_interval_request_str(
                "{\"sampling\":\"grouped_cases\",\"confidence_level\":0.9,\"minimum_samples\":1}"
            )
            .expect("the text parses"),
            IntervalRequest {
                sampling: SamplingModel::GroupedCases,
                confidence_level: ConfidenceLevel::Ninety,
                minimum_samples: 1,
            }
        );

        // One unsupported sampling word states the code of its registry.
        let error = parse_interval_request(&json!({
            "sampling": "bootstrap",
            "confidence_level": 0.95,
            "minimum_samples": 30
        }))
        .expect_err("the request was accepted");
        assert_eq!(error.code, ReasonCode::UnsupportedSampling, "{error}");
        assert_eq!(error.field_path, "/sampling", "{error}");

        // One unsupported confidence level and one broken minimum.
        for (level, path) in [
            (json!(0.8), "/confidence_level"),
            (json!("95"), "/confidence_level"),
            (json!(null), "/confidence_level"),
        ] {
            let error = parse_interval_request(&json!({
                "sampling": "independent_cases",
                "confidence_level": level,
                "minimum_samples": 30
            }))
            .expect_err("the request was accepted");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
            assert_eq!(error.field_path, path, "{error}");
        }
        for minimum in [json!(0), json!(-1), json!(2.5), json!("30"), Value::Null] {
            let error = parse_interval_request(&json!({
                "sampling": "independent_cases",
                "confidence_level": 0.95,
                "minimum_samples": minimum
            }))
            .expect_err("the request was accepted");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
            assert_eq!(error.field_path, "/minimum_samples", "{error}");
        }

        // One missing field and one unknown field.
        let error = parse_interval_request(&json!({
            "confidence_level": 0.95,
            "minimum_samples": 30
        }))
        .expect_err("the request was accepted");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/sampling", "{error}");
        let error = parse_interval_request(&json!({
            "sampling": "independent_cases",
            "confidence_level": 0.95,
            "minimum_samples": 30,
            "stratified": true
        }))
        .expect_err("the request was accepted");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/stratified", "{error}");

        // One count above the dataset limit names the limit.
        let error =
            parse_count(&json!(100_001), "/minimum_samples").expect_err("the count was accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert!(error.message.contains("100000"), "{error}");
        assert_eq!(
            parse_count(&json!(100_000), "/minimum_samples"),
            Ok(100_000)
        );
        // Malformed text keeps its strict gate.
        let error =
            parse_interval_request_str("{\"sampling\": }").expect_err("the text was accepted");
        assert_eq!(error.code, ReasonCode::InvalidJson, "{error}");
    }

    /// One Wilson reference value, as one independent implementation of the
    /// documented formula computed it with the stated quantiles. The values
    /// cover the zero counts, the small denominators, and the observed-all
    /// counts of the reference fixtures.
    const REFERENCE: &[(usize, usize, ConfidenceLevel, f64, f64)] = &[
        (0, 20, ConfidenceLevel::NinetyFive, 0.0, 0.16112515805281938),
        (
            1,
            20,
            ConfidenceLevel::NinetyFive,
            0.008881448800795375,
            0.23613119344674205,
        ),
        (
            5,
            20,
            ConfidenceLevel::NinetyFive,
            0.1118617014076656,
            0.468700877618744,
        ),
        (
            3,
            10,
            ConfidenceLevel::Ninety,
            0.1268765839031979,
            0.558300204130165,
        ),
        (
            3,
            10,
            ConfidenceLevel::NinetyFive,
            0.10779126740630104,
            0.6032218525388547,
        ),
        (
            3,
            10,
            ConfidenceLevel::NinetyNine,
            0.07956631652306578,
            0.6799753207988974,
        ),
        (
            7,
            8,
            ConfidenceLevel::NinetyFive,
            0.5291118177871464,
            0.9775825085499433,
        ),
        (0, 1, ConfidenceLevel::NinetyFive, 0.0, 0.7934506856227626),
        (0, 2, ConfidenceLevel::NinetyFive, 0.0, 0.657619772493347),
        (0, 5, ConfidenceLevel::Ninety, 0.0, 0.35111650076510137),
        (0, 5, ConfidenceLevel::NinetyFive, 0.0, 0.43448246478317487),
        (0, 5, ConfidenceLevel::NinetyNine, 0.0, 0.5702583210270091),
        (1, 1, ConfidenceLevel::NinetyFive, 0.20654931437723745, 1.0),
        (2, 2, ConfidenceLevel::Ninety, 0.42503060900634626, 1.0),
        (2, 2, ConfidenceLevel::NinetyNine, 0.23161829173072757, 1.0),
        (
            2,
            3,
            ConfidenceLevel::NinetyFive,
            0.20765960080204776,
            0.9385080552796039,
        ),
        (
            4,
            6,
            ConfidenceLevel::NinetyFive,
            0.299993315138392,
            0.9032285888942195,
        ),
        (
            1,
            4,
            ConfidenceLevel::NinetyFive,
            0.04558726080970055,
            0.6993581574175981,
        ),
        (
            1,
            3,
            ConfidenceLevel::NinetyFive,
            0.06149194472039626,
            0.7923403991979523,
        ),
        (
            1,
            3,
            ConfidenceLevel::Ninety,
            0.07826572633372836,
            0.746466131718776,
        ),
        (6, 6, ConfidenceLevel::NinetyFive, 0.6096657120978346, 1.0),
        (0, 4, ConfidenceLevel::NinetyFive, 0.0, 0.48989083645459736),
        (
            4,
            4,
            ConfidenceLevel::NinetyFive,
            0.5101091635454026,
            0.9999999999999999,
        ),
        (3, 3, ConfidenceLevel::NinetyFive, 0.4385029682449545, 1.0),
        (
            2,
            4,
            ConfidenceLevel::NinetyFive,
            0.15003898915214953,
            0.8499610108478505,
        ),
        (
            1,
            2,
            ConfidenceLevel::NinetyFive,
            0.09453120573423074,
            0.9054687942657693,
        ),
        (
            4,
            8,
            ConfidenceLevel::NinetyFive,
            0.2152160622138775,
            0.7847839377861225,
        ),
        (
            3,
            8,
            ConfidenceLevel::Ninety,
            0.16117233776067344,
            0.6520085615952674,
        ),
        (0, 3, ConfidenceLevel::NinetyFive, 0.0, 0.5614970317550456),
    ];

    #[test]
    fn the_wilson_bounds_match_their_reference_values() {
        // The stated values come from one independent implementation of the
        // documented formula with the stated quantiles. The comparison
        // allows the last digits of two rounding orders, and nothing more.
        for (numerator, denominator, level, stated_lower, stated_upper) in REFERENCE {
            let (lower, upper) =
                wilson_interval(*numerator, *denominator, *level).expect("the bounds compute");
            assert!(
                (lower - stated_lower).abs() <= 1e-12,
                "{numerator}/{} at {}: lower {lower} against {stated_lower}",
                denominator,
                level.as_f64()
            );
            assert!(
                (upper - stated_upper).abs() <= 1e-12,
                "{numerator}/{} at {}: upper {upper} against {stated_upper}",
                denominator,
                level.as_f64()
            );
            assert!((0.0..=1.0).contains(&lower));
            assert!((0.0..=1.0).contains(&upper));
            assert!(lower <= upper);
        }
        // Every reference row states one zero lower bound at one observed
        // zero, whatever the rounding order of the subtraction states.
        for (numerator, _, _, stated_lower, _) in REFERENCE {
            if *numerator == 0 {
                assert_eq!(*stated_lower, 0.0);
            }
        }

        // Zero observed errors bound one risk above zero, at every level and
        // every small denominator, and one wider level bounds it higher.
        let (_, small) =
            wilson_interval(0, 5, ConfidenceLevel::NinetyFive).expect("the bounds compute");
        let (_, wide) =
            wilson_interval(0, 5, ConfidenceLevel::NinetyNine).expect("the bounds compute");
        assert!(small > 0.0);
        assert!(wide > small);
        // One observed zero and one observed all reach the bounds of the
        // unit range without leaving them.
        let (lower, upper) =
            wilson_interval(0, 4, ConfidenceLevel::NinetyFive).expect("the bounds compute");
        assert!(lower.abs() <= 1e-12);
        assert!(upper > 0.0);
        let (lower, upper) =
            wilson_interval(4, 4, ConfidenceLevel::NinetyFive).expect("the bounds compute");
        assert!(lower > 0.0);
        assert!((upper - 1.0).abs() <= 1e-12);
    }

    #[test]
    fn broken_counts_and_denominators_fail_with_their_paths() {
        let error = wilson_interval(4, 3, ConfidenceLevel::NinetyFive)
            .expect_err("the bounds were accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/numerator", "{error}");
        let error = wilson_interval(0, 0, ConfidenceLevel::NinetyFive)
            .expect_err("the bounds were accepted");
        assert_eq!(error.code, ReasonCode::InsufficientEvidence, "{error}");
        assert_eq!(error.field_path, "/denominator", "{error}");
        // One count outside its shape fails at its stated path.
        for (value, path) in [
            (json!(-1), "/numerator"),
            (json!(1.5), "/numerator"),
            (json!("3"), "/denominator"),
            (json!(null), "/denominator"),
        ] {
            let error = parse_count(&value, path).expect_err("the count was accepted");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
            assert_eq!(error.field_path, path, "{error}");
        }
        assert_eq!(parse_count(&json!(0), "/numerator"), Ok(0));
    }

    #[test]
    fn independent_cases_compute_the_bounds_of_every_scope() {
        // Six records of six distinct groups, so every denominator holds one
        // case per group and the independent model applies.
        let records = file(&[
            record(
                "interval-cases-1",
                "g1",
                &[],
                labels("fail", "pass", "fail"),
            ),
            record(
                "interval-cases-2",
                "g2",
                &[],
                labels("fail", "pass", "fail"),
            ),
            record(
                "interval-cases-3",
                "g3",
                &[],
                labels("pass", "pass", "pass"),
            ),
            record(
                "interval-cases-4",
                "g4",
                &[],
                labels("pass", "pass", "pass"),
            ),
            record(
                "interval-cases-5",
                "g5",
                &[],
                labels("review", "pass", "review"),
            ),
            record(
                "interval-cases-6",
                "g6",
                &[],
                labels("pass", "pass", "pass"),
            ),
        ]);
        let outcomes = [
            case("interval-cases-1", "pass", "pass", "pass"),
            case("interval-cases-2", "error", "error", "error"),
            case("interval-cases-3", "pass", "pass", "pass"),
            case("interval-cases-4", "fail", "fail", "fail"),
            case("interval-cases-5", "review", "pass", "review"),
            case("interval-cases-6", "pass", "pass", "pass"),
        ];
        let request = IntervalRequest {
            sampling: SamplingModel::IndependentCases,
            confidence_level: ConfidenceLevel::NinetyFive,
            minimum_samples: 1,
        };
        let report = intervals(&records, &outcomes, &request);

        // The header states the method, the level, the model, and the
        // minimum evidence.
        assert_eq!(report.method, METHOD);
        assert_eq!(report.confidence_level, 0.95);
        assert_eq!(report.sampling, "independent_cases");
        assert_eq!(report.assumption, INDEPENDENT_CASES_ASSUMPTION);
        assert_eq!(report.minimum_samples, 1);
        assert!(report.method_statement.contains("Wilson"));
        assert!(report.method_statement.contains("95 percent"));
        assert!(report.method_statement.contains("independent cases"));
        assert!(report.method_statement.contains("Zero observed errors"));
        assert!(report.method_statement.len() <= 2000);
        assert!(report.slices.is_empty(), "no record states one tag");

        // One set per check plus the complete set, and one row per metric.
        let scopes: Vec<&str> = report.scopes.iter().map(|set| set.scope.as_str()).collect();
        assert_eq!(
            scopes,
            [
                "notes-complete",
                "summary-free-of-todos",
                metrics::ALL_CHECKS
            ]
        );
        let question = report.set("notes-complete").expect("the check set");
        assert_eq!(question.intervals.len(), 6);

        // The false rejection rate: one predicted failure among the three
        // reference pass cases, over three independent draws.
        let rejection = question.interval(MetricName::FalseRejectionRate);
        assert_eq!((rejection.numerator, rejection.denominator), (1, 3));
        assert_eq!((rejection.event_draws, rejection.draws), (1, 3));
        assert_eq!(rejection.reason, None);
        let (lower, upper) =
            wilson_interval(1, 3, ConfidenceLevel::NinetyFive).expect("the bounds compute");
        assert_eq!(rejection.lower, Some(lower));
        assert_eq!(rejection.upper, Some(upper));
        assert_eq!(rejection.method, METHOD);
        assert_eq!(rejection.confidence_level, 0.95);
        assert_eq!(rejection.sampling, "independent_cases");
        assert_eq!(rejection.upper_bound(), Some(upper));
        assert!(!rejection.is_insufficient());
        // The bound compares with one declared limit of a plan.
        assert_eq!(rejection.upper_within(0.9), Some(true));
        assert_eq!(rejection.upper_within(0.5), Some(false));

        // The false acceptance rate: one predicted pass among the two
        // reference fail cases and the one reference review case.
        let acceptance = question.interval(MetricName::FalseAcceptanceRate);
        assert_eq!((acceptance.numerator, acceptance.denominator), (1, 3));
        let (lower, upper) =
            wilson_interval(1, 3, ConfidenceLevel::NinetyFive).expect("the bounds compute");
        assert_eq!(acceptance.lower, Some(lower));
        assert_eq!(acceptance.upper, Some(upper));

        // The complete check set counts the aggregate outcomes: three
        // passes, one fail, one review, one error.
        let complete = report.set(metrics::ALL_CHECKS).expect("the complete set");
        let review = complete.interval(MetricName::ReviewRate);
        assert_eq!((review.numerator, review.denominator), (1, 6));
        let coverage = complete.interval(MetricName::AutomaticCoverage);
        assert_eq!((coverage.numerator, coverage.denominator), (4, 6));
        let labeled = complete.interval(MetricName::LabelCoverage);
        assert_eq!((labeled.numerator, labeled.denominator), (6, 6));
        let (lower, upper) =
            wilson_interval(6, 6, ConfidenceLevel::NinetyFive).expect("the bounds compute");
        assert_eq!(labeled.lower, Some(lower));
        assert_eq!(labeled.upper, Some(upper));

        // The serialized row states the fields of the profile interval
        // block beside its counts.
        let value = serde_json::to_value(rejection).expect("the row serializes");
        let (lower, upper) =
            wilson_interval(1, 3, ConfidenceLevel::NinetyFive).expect("the bounds compute");
        assert_eq!(value["scope"], "notes-complete");
        assert_eq!(value["metric"], "false_rejection_rate");
        assert_eq!(value["method"], "wilson_score");
        assert_eq!(value["confidence_level"], 0.95);
        assert_eq!(value["lower"], lower);
        assert_eq!(value["upper"], upper);
        assert_eq!(value["numerator"], 1);
        assert_eq!(value["denominator"], 3);
        assert_eq!(value["draws"], 3);
        assert_eq!(value["sampling"], "independent_cases");
        assert_eq!(value["event_draws"], 1);
        assert_eq!(value["reason"], Value::Null);
    }

    #[test]
    fn one_repeated_group_blocks_the_independent_model_alone() {
        // Group g1 holds two reference fail cases, and every denominator
        // that counts every case holds them both. The false rejection rate
        // counts reference pass cases alone, so g1 holds none of them and
        // its denominator keeps one case per group.
        let records = file(&[
            record(
                "interval-cases-1",
                "g1",
                &[],
                labels("fail", "pass", "fail"),
            ),
            record(
                "interval-cases-2",
                "g1",
                &[],
                labels("fail", "pass", "fail"),
            ),
            record(
                "interval-cases-3",
                "g2",
                &[],
                labels("pass", "pass", "pass"),
            ),
            record(
                "interval-cases-4",
                "g3",
                &[],
                labels("pass", "pass", "pass"),
            ),
        ]);
        let outcomes = [
            case("interval-cases-1", "pass", "pass", "pass"),
            case("interval-cases-2", "fail", "fail", "fail"),
            case("interval-cases-3", "pass", "pass", "pass"),
            case("interval-cases-4", "fail", "fail", "fail"),
        ];
        let request = IntervalRequest {
            sampling: SamplingModel::IndependentCases,
            confidence_level: ConfidenceLevel::NinetyFive,
            minimum_samples: 1,
        };
        let report = intervals(&records, &outcomes, &request);
        let question = report.set("notes-complete").expect("the check set");

        // The false acceptance denominator holds both cases of g1, so the
        // binomial assumption is broken and no bound computes.
        let acceptance = question.interval(MetricName::FalseAcceptanceRate);
        assert_eq!((acceptance.numerator, acceptance.denominator), (1, 2));
        assert!(acceptance.is_unsupported_sampling());
        assert_eq!(acceptance.lower, None);
        assert_eq!(acceptance.upper, None);
        assert_eq!(acceptance.upper_within(1.0), None);

        // The false rejection rate holds one reference pass case per group:
        // one predicted failure among two, over two draws.
        let rejection = question.interval(MetricName::FalseRejectionRate);
        assert_eq!((rejection.numerator, rejection.denominator), (1, 2));
        assert_eq!((rejection.event_draws, rejection.draws), (1, 2));
        assert_eq!(rejection.reason, None);
        let (lower, upper) =
            wilson_interval(1, 2, ConfidenceLevel::NinetyFive).expect("the bounds compute");
        assert_eq!(rejection.lower, Some(lower));
        assert_eq!(rejection.upper, Some(upper));

        // The error among accepted cases counts the labeled predicted
        // passes: one case of g1 and one of g2, so the denominator keeps one
        // case per group and the interval computes.
        let accepted = question.interval(MetricName::ErrorAmongAccepted);
        assert_eq!((accepted.numerator, accepted.denominator), (1, 2));
        assert_eq!(accepted.reason, None);

        // Every denominator that counts every case is unsupported, because
        // g1 holds two of them.
        for metric in [
            MetricName::ReviewRate,
            MetricName::AutomaticCoverage,
            MetricName::LabelCoverage,
        ] {
            let row = question.interval(metric);
            assert!(
                row.is_unsupported_sampling(),
                "{}: {}",
                metric.as_str(),
                serde_json::to_value(row).expect("serializes")
            );
        }
    }

    #[test]
    fn grouped_cases_make_the_group_the_draw() {
        // Three groups of two cases. The complete scope counts six cases;
        // the interval counts three groups.
        let records = file(&[
            record(
                "interval-cases-1",
                "g1",
                &["later"],
                labels("fail", "pass", "fail"),
            ),
            record(
                "interval-cases-2",
                "g1",
                &["later"],
                labels("pass", "pass", "pass"),
            ),
            record(
                "interval-cases-3",
                "g2",
                &["early"],
                labels("pass", "pass", "pass"),
            ),
            record(
                "interval-cases-4",
                "g2",
                &["early"],
                labels("pass", "pass", "pass"),
            ),
            record(
                "interval-cases-5",
                "g3",
                &["later"],
                labels("fail", "pass", "fail"),
            ),
            record(
                "interval-cases-6",
                "g3",
                &["later"],
                labels("pass", "pass", "pass"),
            ),
        ]);
        let outcomes = [
            case("interval-cases-1", "pass", "pass", "pass"),
            case("interval-cases-2", "pass", "pass", "pass"),
            case("interval-cases-3", "pass", "pass", "pass"),
            case("interval-cases-4", "pass", "pass", "pass"),
            case("interval-cases-5", "fail", "fail", "fail"),
            case("interval-cases-6", "pass", "pass", "pass"),
        ];
        let request = IntervalRequest {
            sampling: SamplingModel::GroupedCases,
            confidence_level: ConfidenceLevel::Ninety,
            minimum_samples: 2,
        };
        let report = intervals(&records, &outcomes, &request);
        assert_eq!(report.sampling, "grouped_cases");
        assert_eq!(report.assumption, GROUPED_CASES_ASSUMPTION);
        assert!(report.method_statement.contains("at least 2 groups"));

        // The false rejection rate: no predicted failure among four
        // reference pass cases, over three groups that all hold one of
        // them. Zero observed errors still bound one risk above zero.
        let question = report.set("notes-complete").expect("the check set");
        let rejection = question.interval(MetricName::FalseRejectionRate);
        assert_eq!((rejection.numerator, rejection.denominator), (0, 4));
        assert_eq!((rejection.event_draws, rejection.draws), (0, 3));
        let (rejection_lower, rejection_upper) =
            wilson_interval(0, 3, ConfidenceLevel::Ninety).expect("the bounds compute");
        assert_eq!(rejection.lower, Some(rejection_lower));
        assert_eq!(rejection.upper, Some(rejection_upper));
        assert!(rejection_upper > 0.0);
        assert_eq!(rejection.confidence_level, 0.9);

        // The false acceptance rate: one predicted pass among two reference
        // fail cases, one group of each, so the event covers one group of
        // the two draws.
        let acceptance = question.interval(MetricName::FalseAcceptanceRate);
        assert_eq!((acceptance.numerator, acceptance.denominator), (1, 2));
        assert_eq!((acceptance.event_draws, acceptance.draws), (1, 2));
        let (acceptance_lower, acceptance_upper) =
            wilson_interval(1, 2, ConfidenceLevel::Ninety).expect("the bounds compute");
        assert_eq!(acceptance.lower, Some(acceptance_lower));
        assert_eq!(acceptance.upper, Some(acceptance_upper));

        // The slices follow the tags. The later slice holds two groups, so
        // its rows compute; the early slice holds one group, below the
        // declared minimum, so it states insufficient evidence with its
        // counts.
        let later = report.slice("later").expect("the slice");
        let later_question = later
            .scopes
            .iter()
            .find(|set| set.scope == "notes-complete")
            .expect("the check set");
        let row = later_question.interval(MetricName::FalseRejectionRate);
        assert_eq!((row.numerator, row.denominator), (0, 2));
        assert_eq!((row.event_draws, row.draws), (0, 2));
        let (lower, upper) =
            wilson_interval(0, 2, ConfidenceLevel::Ninety).expect("the bounds compute");
        assert_eq!(row.lower, Some(lower));
        assert_eq!(row.upper, Some(upper));
        // The label coverage of the slice counts every case, so it holds two
        // groups with one event each.
        let labeled = later_question.interval(MetricName::LabelCoverage);
        assert_eq!((labeled.numerator, labeled.denominator), (4, 4));
        assert_eq!((labeled.event_draws, labeled.draws), (2, 2));
        let (lower, upper) =
            wilson_interval(2, 2, ConfidenceLevel::Ninety).expect("the bounds compute");
        assert_eq!(labeled.lower, Some(lower));
        assert_eq!(labeled.upper, Some(upper));
        // The early slice holds one group alone.
        let early = report.slice("early").expect("the slice");
        let early_question = early
            .scopes
            .iter()
            .find(|set| set.scope == "notes-complete")
            .expect("the check set");
        let labeled = early_question.interval(MetricName::LabelCoverage);
        assert_eq!((labeled.numerator, labeled.denominator), (2, 2));
        assert_eq!((labeled.event_draws, labeled.draws), (1, 1));
        assert!(labeled.is_insufficient());
        assert_eq!(labeled.reason, Some(ReasonCode::InsufficientEvidence));
    }

    #[test]
    fn missing_denominators_and_unmet_minimums_state_insufficient_evidence() {
        // Every reference states pass, so the false acceptance rate holds
        // no denominator at all.
        let records = file(&[
            record(
                "interval-cases-1",
                "g1",
                &[],
                labels("pass", "pass", "pass"),
            ),
            record(
                "interval-cases-2",
                "g2",
                &[],
                labels("pass", "pass", "pass"),
            ),
            record(
                "interval-cases-3",
                "g3",
                &[],
                labels("pass", "pass", "pass"),
            ),
        ]);
        let outcomes = [
            case("interval-cases-1", "pass", "pass", "pass"),
            case("interval-cases-2", "pass", "pass", "pass"),
            case("interval-cases-3", "pass", "pass", "pass"),
        ];

        // One denominator below the declared minimum states no bound.
        let request = IntervalRequest {
            sampling: SamplingModel::IndependentCases,
            confidence_level: ConfidenceLevel::NinetyFive,
            minimum_samples: 10,
        };
        let report = intervals(&records, &outcomes, &request);
        let question = report.set("notes-complete").expect("the check set");
        let rejection = question.interval(MetricName::FalseRejectionRate);
        assert_eq!((rejection.numerator, rejection.denominator), (0, 3));
        assert!(rejection.is_insufficient());
        assert_eq!(rejection.reason, Some(ReasonCode::InsufficientEvidence));
        assert_eq!(rejection.lower, None);
        assert_eq!(rejection.upper, None);
        // The statement names the minimum.
        assert!(report.method_statement.contains("at least 10"));

        // Zero observed errors state one bound above zero when the evidence
        // meets the minimum.
        let request = IntervalRequest {
            sampling: SamplingModel::IndependentCases,
            confidence_level: ConfidenceLevel::NinetyFive,
            minimum_samples: 3,
        };
        let report = intervals(&records, &outcomes, &request);
        let question = report.set("notes-complete").expect("the check set");
        let acceptance = question.interval(MetricName::FalseAcceptanceRate);
        assert_eq!(acceptance.denominator, 0);
        assert!(acceptance.is_insufficient());
        let rejection = question.interval(MetricName::FalseRejectionRate);
        assert_eq!(rejection.reason, None);
        assert!(rejection.lower.expect("the bound computes").abs() <= 1e-12);
        assert!(rejection.upper.unwrap_or(0.0) > 0.0);
        // The serialized row states the reason word of the registry and one
        // null bound, as the contract states one null value.
        let value = serde_json::to_value(acceptance).expect("the row serializes");
        assert_eq!(value["reason"], "insufficient_evidence");
        assert_eq!(value["lower"], Value::Null);
        assert_eq!(value["upper"], Value::Null);

        // One evaluation without one case refuses before any interval.
        let definition = definition();
        let metadata_text = serde_json::to_string(&metadata()).expect("serializes");
        let dataset = load_dataset(&metadata_text, &records).expect("the dataset loads");
        let validated =
            crate::dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        let error = evaluate_intervals(&validated, &[], &request).expect_err("it was accepted");
        assert_eq!(error.code, ReasonCode::InsufficientEvidence, "{error}");
        assert_eq!(error.field_path, "/cases", "{error}");
    }

    #[test]
    fn one_record_without_one_group_forms_its_own_group() {
        // The dataset contract states that one record without a group forms
        // its own group, so the independent model still applies.
        let mut first = record(
            "interval-cases-1",
            "g1",
            &[],
            labels("fail", "pass", "fail"),
        );
        let mut second = record(
            "interval-cases-2",
            "g2",
            &[],
            labels("fail", "pass", "fail"),
        );
        let object = first.as_object_mut().expect("an object");
        object.remove("group");
        let object = second.as_object_mut().expect("an object");
        object.remove("group");
        let records = file(&[first, second]);
        let outcomes = [
            case("interval-cases-1", "pass", "pass", "pass"),
            case("interval-cases-2", "pass", "pass", "pass"),
        ];
        let request = IntervalRequest {
            sampling: SamplingModel::IndependentCases,
            confidence_level: ConfidenceLevel::NinetyNine,
            minimum_samples: 2,
        };
        let report = intervals(&records, &outcomes, &request);
        let question = report.set("notes-complete").expect("the check set");
        let acceptance = question.interval(MetricName::FalseAcceptanceRate);
        assert_eq!((acceptance.numerator, acceptance.denominator), (2, 2));
        assert_eq!(acceptance.reason, None);
        let (lower, upper) =
            wilson_interval(2, 2, ConfidenceLevel::NinetyNine).expect("the bounds compute");
        assert_eq!(acceptance.lower, Some(lower));
        assert_eq!(acceptance.upper, Some(upper));
    }
}
