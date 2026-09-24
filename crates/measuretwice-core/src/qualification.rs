// SPDX-License-Identifier: Apache-2.0
//! The frozen validation of one selected candidate.
//!
//! Fitting selects one candidate on development data. Qualification then
//! answers one separate question: does that exact candidate, unchanged,
//! meet the declared goals on independent cases? MVP_SPEC.md section 7
//! fixes the procedure. Freeze the candidate, evaluate it on held-out
//! cases, and compute counts, intervals, slice results, and goal
//! satisfaction in code.
//!
//! [`qualify_candidate`] runs that validation:
//!
//! - The freeze comes first. The fitting result must bind the offered plan
//!   by identifier and content hash, the definition the plan binds, the
//!   fitting split the plan names, and one candidate of the permitted grid
//!   at its recorded position. One broken clause refuses the validation
//!   before one validation case is read, because one candidate that was
//!   fitted under another plan, another definition, or another family
//!   measures something else. The recorded evaluator configuration of the
//!   plan travels into the result unchanged, so one changed translation,
//!   adapter, or model resolution stays one changed binding that this
//!   result no longer covers.
//! - The validation split comes through the plan's own validation
//!   selection, must carry the validation purpose, and must share no group
//!   and no case with the fitting split the search read. One assessment
//!   that names any other case fails with its path, so fitting data cannot
//!   enter the validation as extra evidence.
//! - Each validation case replays once under the frozen policy, exactly as
//!   one run decides, and the outcomes fold with the shared metric
//!   definitions of [`metrics`]. The search never reruns here: no other
//!   candidate is enumerated, no parameter moves, and the result returns
//!   the candidate it received. One plan whose validation data favors
//!   another candidate of the grid states `criteria_not_met`, never one
//!   retuned policy. Validation feedback cannot select one host profile
//!   either, because this computation owns no profile state. The host
//!   reviews the recorded evidence and selects one reviewed hash through
//!   its own code.
//! - Evidence comes before arithmetic, exactly as the fitting boundary and
//!   the interval methods state it. [`splits::validation_evidence`]
//!   classifies the validation split first: one reused holdout, one
//!   dataset that states no representative sample, and one empty split are
//!   development data, and one qualification claim needs fresh independent
//!   evidence. Every declared goal then needs its denominator, the plan
//!   minimum of that denominator, and one sampling model the validation
//!   groups support. One missing piece states `insufficient_evidence` with
//!   its counts, because zero observed errors prove no zero risk and one
//!   small denominator bounds no goal.
//! - The `upper_confidence_bound` basis reads the upper bound of the
//!   shared interval method at the declared confidence level, under the
//!   declared sampling model. `independent_cases` needs every case of one
//!   denominator in its own group; one group that holds two of them
//!   states `unsupported_sampling`, because no bound may rest on one
//!   assumption the data breaks. `grouped_cases` makes the group the draw.
//! - The plan minimums gate the validation as one whole, and every
//!   important slice carries its own evidence floor. One unmet floor,
//!   including one slice the validation split holds no case of, states
//!   `insufficient_evidence` and names the denominator and the counts.
//! - The result is one of the four contract statuses with calculated
//!   reasons: `insufficient_evidence` when the evidence falls short,
//!   `criteria_not_met` when the evidence exists and one goal fails, and
//!   `validated_for_scope` when every goal holds on its declared basis.
//!   `unvalidated` is the status of one exploration profile. The frozen
//!   validation never sets it, exactly as the checked qualification model
//!   records: one starter artifact stays unvalidated until one frozen
//!   validation computes another status for one new candidate.
//!
//! The interval request inside this validation states one draw at least,
//! because the plan states its own evidence floors per denominator and
//! this module reads them per goal, per slice, and for the complete
//! validation.

use crate::dataset::{SplitPurpose, ValidatedDataset};
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::fitting::{self, Answer, FitReport};
use crate::hashing;
use crate::intervals::{self, Interval, IntervalRequest, IntervalSet, SamplingModel};
use crate::metrics::{self, ConfusionMatrix, MetricName, MetricSet};
use crate::plan::{self, Candidate, Comparison, LimitBasis, PlanConstraint, ValidatedPlan};
use crate::policy;
use crate::profile::Qualification;
use crate::report::{self, AppliedPolicy, CompletionStatus, Outcome};
use crate::splits::{self, SplitIdentity};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// The named qualification method: the frozen validation of one selected
/// candidate on independent cases.
pub const METHOD: &str = "frozen_validation";

/// The standing statement that every qualification result carries.
///
/// The checked qualification model of `models/qualification` maps the
/// `Qualify` transition onto this boundary: the candidate is returned,
/// never selected.
pub const CANDIDATE_STATEMENT: &str = "A qualification result returns one frozen candidate and selects nothing. The validation outcome changes no parameter of the candidate, no host profile selection, and no application authorization. The host reviews the recorded evidence and selects one reviewed profile hash through its own code.";

/// Fields of one validation request, as the boundary reads it.
const REQUEST_FIELDS: &[&str] = &["sampling", "previously_used"];

/// The evidence state of one declared goal on the validation split.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "evidence")]
pub enum GoalEvidence {
    /// The rate states one denominator that meets the plan minimum, and the
    /// declared sampling model holds for it.
    Measured,
    /// The rate states no denominator, so no value and no bound exist.
    ZeroDenominator,
    /// The denominator sits below the plan minimum of its own population,
    /// so the plan itself declares the evidence too small for the goal.
    BelowMinimum {
        /// The minimum the plan states for the denominator.
        stated: usize,
        /// The denominator the validation measured.
        measured: usize,
    },
    /// The declared sampling model does not hold for the denominator, so
    /// the interval method states no bound for the goal.
    UnsupportedSampling,
}

/// One declared goal as the frozen validation measured it.
///
/// The row keeps the declared limit beside the measured evidence, so one
/// unmet goal states by how much it failed instead of one bare flag.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct QualificationGoal {
    /// The constrained metric of the published set.
    pub metric: MetricName,
    /// The declared direction of the limit.
    pub comparison: Comparison,
    /// The declared limit, unchanged by the validation.
    pub limit: f64,
    /// The declared evidence basis.
    pub basis: LimitBasis,
    /// Cases in the numerator of the rate.
    pub numerator: usize,
    /// Cases in the denominator of the rate.
    pub denominator: usize,
    /// The observed rate, or `None` when the denominator holds no case.
    pub observed: Option<f64>,
    /// The upper bound the `upper_confidence_bound` basis reads, present
    /// when that basis computes one.
    pub upper_bound: Option<f64>,
    /// Draws behind the interval: cases under `independent_cases`, groups
    /// under `grouped_cases`.
    pub draws: usize,
    /// Whether the candidate meets the goal on the declared basis.
    pub met: bool,
    /// The evidence state behind the comparison.
    pub evidence: GoalEvidence,
}

/// One stated sample requirement of the plan as the validation measured it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SampleRequirement {
    /// The denominator name the plan states one minimum for.
    pub denominator: String,
    /// The stated minimum.
    pub stated: usize,
    /// The cases the validation split holds.
    pub measured: usize,
    /// Whether the validation meets the stated minimum.
    pub met: bool,
}

/// One important slice of the plan as the validation measured it.
///
/// The row keeps the declared minimums beside the measured counts, so one
/// limited slice states its own limitation instead of one silent gap.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SliceResult {
    /// The case tag of the slice.
    pub tag: String,
    /// The minimum counts the plan states for this slice, by denominator
    /// name.
    pub minimum_samples: BTreeMap<String, usize>,
    /// The counts the validation measured, by denominator name.
    pub denominators: BTreeMap<String, usize>,
    /// Whether every stated minimum of this slice is met.
    pub met: bool,
    /// The metric set of the complete check set of this slice.
    pub metrics: MetricSet,
    /// The interval rows of the complete check set of this slice, absent
    /// when the validation split holds no case.
    pub intervals: Option<IntervalSet>,
    /// The plain statement of this slice, linked to the counts above.
    pub statement: String,
}

/// One calculated reason behind the qualification status.
///
/// `code` holds one word of the stable registry, the one a profile records
/// in its `qualification.reasons` block. `statement` cites the counts that
/// produced it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QualificationReason {
    /// One reason code of the published registry.
    pub code: ReasonCode,
    /// The calculated statement behind the code.
    pub statement: String,
}

/// The complete result of one frozen validation.
///
/// The value states the status, the calculated reasons, every goal row,
/// every sample requirement, every important slice, the metric sets of the
/// validation, and the complete identity of the frozen candidate. Nothing
/// in it selects, promotes, or rewrites one profile.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QualificationReport {
    /// Stable plan identifier.
    pub plan_id: String,
    /// Computed identity of the plan in the plan domain.
    pub plan_content_hash: String,
    /// Name of the calibrated definition.
    pub definition_name: String,
    /// Content hash of the calibrated definition.
    pub definition_hash: String,
    /// The evaluator configuration of the plan, recorded unchanged.
    pub evaluator: plan::EvaluatorConfiguration,
    /// The qualification method word. Always [`METHOD`].
    pub method: &'static str,
    /// The interval method behind every upper bound. Always
    /// [`intervals::METHOD`].
    pub interval_method: &'static str,
    /// The declared confidence level of the bounds.
    pub confidence_level: f64,
    /// The declared sampling model.
    pub sampling: &'static str,
    /// The standing assumption of the sampling model.
    pub assumption: &'static str,
    /// The complete statistical method statement, the text one profile
    /// records in `statistical_method`.
    pub method_statement: String,
    /// The position of the frozen candidate in the declared enumeration
    /// order of the plan grid.
    pub candidate_index: usize,
    /// The frozen candidate, unchanged by the validation.
    pub candidate: Candidate,
    /// The policy every question check applies under this candidate.
    pub applied: AppliedPolicy,
    /// Dataset of the validation split.
    pub dataset: String,
    /// Revision of the validation split.
    pub revision: String,
    /// Validation split identifier.
    pub split: String,
    /// Computed hash of the validation split records.
    pub split_content_hash: String,
    /// Groups the validation split declares, in declared order.
    pub split_groups: Vec<String>,
    /// Validation cases the validation measured.
    pub case_count: usize,
    /// The evidence classification of the validation split.
    pub evidence: splits::ValidationEvidence,
    /// The minimum counts the plan states, by denominator name.
    pub minimum_samples: BTreeMap<String, usize>,
    /// One row per stated plan minimum, in the order of the plan map.
    pub sample_requirements: Vec<SampleRequirement>,
    /// One row per declared goal, in written order.
    pub goals: Vec<QualificationGoal>,
    /// One metric set per check of the definition, then the complete check
    /// set, in the order of the evaluation contract.
    pub scopes: Vec<MetricSet>,
    /// The interval rows of the complete check set, absent when the
    /// validation split holds no case.
    pub intervals: Option<IntervalSet>,
    /// One row per important slice of the plan, in written order.
    pub slices: Vec<SliceResult>,
    /// The computed qualification status.
    pub status: Qualification,
    /// The calculated reasons behind the status, in decision order.
    pub reasons: Vec<QualificationReason>,
    /// The standing candidate statement. Always [`CANDIDATE_STATEMENT`].
    pub statement: &'static str,
}

impl QualificationReport {
    /// Returns true when this result establishes the declared scope.
    pub fn is_validated(&self) -> bool {
        self.status == Qualification::ValidatedForScope
    }
}

/// One declared validation procedure: what counts as one draw, and which
/// validation splits earlier qualification claims consumed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationRequest {
    /// The declared sampling model behind every interval.
    pub sampling: SamplingModel,
    /// The validation splits that earlier qualification claims used, as
    /// split identities. One split of the same content is development
    /// data, whatever its name.
    pub previously_used: Vec<SplitIdentity>,
}

/// Parses one validation request out of one JSON value.
///
/// The object states `sampling` as one contract word of the two sampling
/// models and `previously_used` as one optional array of split identities,
/// each exactly as [`splits::SplitIdentity`] serializes it. Two entries
/// that name one split state one requirement twice, so they refuse with
/// `duplicate_id`.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `unsupported_sampling` at `/sampling`
/// when the word names no supported model, with `invalid_field_type` at
/// `/sampling` when the field holds no word, with `missing_field` when the
/// request states no sampling model, with the failure of
/// [`splits::parse_split_identity`] at `/previously_used/<index>` for one
/// broken identity, with `duplicate_id` when two entries name one split,
/// and with `missing_field`, `unknown_field`, or `invalid_field_type` for
/// the fields of the object.
pub fn parse_validation_request(value: &Value) -> Result<ValidationRequest, ValidationError> {
    let root = value.as_object().ok_or_else(|| {
        ValidationError::invalid_field_type("", "One validation request must hold one object.")
    })?;
    crate::artifact::reject_unknown_fields(root, REQUEST_FIELDS, "")?;
    let sampling = match root.get("sampling") {
        Some(Value::String(word)) => SamplingModel::from_word(word).ok_or_else(|| {
            ValidationError::new(
                ReasonCode::UnsupportedSampling,
                "/sampling",
                format!(
                    "The interval methods support no sampling model {}. State independent_cases or grouped_cases.",
                    fragment(word)
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
    let previously_used = match root.get("previously_used") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut parsed = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let identity =
                    splits::parse_split_identity(item).map_err(|error| ValidationError {
                        field_path: format!("/previously_used/{index}{}", error.field_path),
                        ..error
                    })?;
                if parsed.iter().any(|earlier: &SplitIdentity| {
                    earlier.dataset_id == identity.dataset_id
                        && earlier.revision == identity.revision
                        && earlier.split_id == identity.split_id
                }) {
                    return Err(ValidationError::new(
                        ReasonCode::DuplicateId,
                        format!("/previously_used/{index}/split"),
                        format!(
                            "Two stated splits name {} of one revision, so one requirement repeats.",
                            fragment(&identity.split_id)
                        ),
                    ));
                }
                parsed.push(identity);
            }
            parsed
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/previously_used",
                "The previously used splits must hold one array of split identities.",
            ));
        }
    };
    Ok(ValidationRequest {
        sampling,
        previously_used,
    })
}

/// Parses one validation request out of its artifact text.
///
/// # Errors
///
/// Returns the failure of [`crate::json::parse_strict`] for malformed text,
/// otherwise the failure of [`parse_validation_request`].
pub fn parse_validation_request_str(text: &str) -> Result<ValidationRequest, ValidationError> {
    crate::json::parse_strict(text).and_then(|value| parse_validation_request(&value))
}

/// Qualifies the frozen candidate of one fitting result on independent
/// validation cases.
///
/// `fit` is the immutable fitting result of [`fitting::fit_policy`] over the
/// fitting selection of the plan. `request` states the declared sampling
/// model and the validation splits that earlier claims consumed.
/// `assessments` is one object keyed by case identifier; each entry is one
/// object keyed by question check identifier holding the stored assessment
/// of that check, exactly as the evaluator recorded it. Every validation
/// case and every question check must state one assessment, one assessment
/// names no other case and no rule check, and each assessment must pass the
/// assessment contract of its check.
///
/// The computation changes nothing it reads. It returns the candidate it
/// received, whatever the validation data shows, and it owns no profile and
/// no host selection.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `policy_mismatch` when the loaded
/// definition is exact-only or the recorded candidate sits outside the grid
/// of the plan, with `definition_mismatch` when the plan binds another
/// definition or the fitting result records another one, with `hash_mismatch`
/// when the fitting result records another plan identity or another
/// fitting-split digest, with `invalid_field_type` at `/fit/<field>` when
/// the fitting result names another dataset, revision, or split, with
/// `criteria_not_met` at `/fit/selected` when the search found no feasible
/// candidate, with the refusal of the plan dataset boundary at
/// `/plan/datasets/<field>` when the validation selection names no offered
/// split, one of the wrong purpose, or one that shares one group or one
/// case with the fitting split, and with `missing_field`, `unknown_field`,
/// `invalid_assessment`, or `invalid_field_type` at
/// `/assessments/<case>/<check>` when one stored assessment breaks its
/// input contract.
pub fn qualify_candidate(
    plan: &ValidatedPlan,
    dataset: &ValidatedDataset<'_>,
    fit: &FitReport,
    request: &ValidationRequest,
    assessments: &Value,
) -> Result<QualificationReport, ValidationError> {
    // The freeze. Every clause refuses before one validation case is read.
    plan::check_plan_definition(plan, dataset.definition(), "/plan")?;
    check_frozen_plan(plan, fit)?;
    check_frozen_definition(plan, fit)?;

    let grouped = splits::dataset_splits(dataset.dataset())?;
    let fitting_split = fitting::plan_split(plan, &grouped, SplitPurpose::Fitting)?;
    check_frozen_split(fitting_split.identity(), fit)?;
    let validation_split = fitting::plan_split(plan, &grouped, SplitPurpose::Validation)?;
    splits::require_separated(fitting_split.identity(), validation_split.identity()).map_err(
        |mut error| {
            error.field_path = "/plan/datasets/validation".to_owned();
            error
        },
    )?;

    let selected = fit.selected().ok_or_else(|| {
        ValidationError::new(
            ReasonCode::CriteriaNotMet,
            "/fit/selected",
            format!(
                "The fitting search of the plan {} found no feasible candidate, so no frozen candidate exists to validate. The fitting result states the unmet goals.",
                fragment(plan.id())
            ),
        )
    })?;
    let candidates = plan.candidates();
    let recorded = candidates
        .get(selected.index)
        .ok_or_else(frozen_candidate_refusal)?;
    if recorded != &selected.candidate {
        return Err(frozen_candidate_refusal());
    }
    let candidate = selected.candidate;
    let policy = fitting::applied_policy(candidate);

    // The replay. Every validation case decides once under the frozen
    // policy, exactly as one run decides, and the fold reads the shared
    // metric definitions.
    let definition = dataset.definition();
    let checks = &definition.as_definition().checks;
    let check_ids: Vec<&str> = checks.iter().map(|check| check.id.as_str()).collect();
    let records = validation_split.records();
    let cases = fitting::prepare_cases(
        definition,
        records,
        assessments,
        "validation",
        "The frozen validation",
    )?;
    let mut outcomes = Vec::with_capacity(cases.len());
    for (record, case) in records.iter().zip(&cases) {
        let mut decided: BTreeMap<String, Outcome> = BTreeMap::new();
        let mut component = Vec::with_capacity(checks.len());
        for (slot, answer) in case.answers.iter().enumerate() {
            let outcome = match answer {
                Answer::Question(value) => {
                    policy::decide(definition, check_ids[slot], value, &policy)
                        .map_err(|error| at(error, &case.path, check_ids[slot]))?
                }
                Answer::Rule(outcome) => *outcome,
            };
            decided.insert(check_ids[slot].to_owned(), outcome);
            component.push(outcome);
        }
        let aggregate =
            report::aggregate(&component).expect("the definition states one check at least");
        outcomes.push(metrics::CaseOutcome {
            case_id: record.id.clone(),
            checks: decided,
            aggregate,
            completion: CompletionStatus::Completed,
            attempts: 0,
            elapsed_ms: None,
            usage: BTreeMap::new(),
        });
    }

    // The measurement and the intervals come from the shared boundaries, so
    // one rate, one bound, and one denominator can never disagree. The
    // request states one draw at least, because the plan states its own
    // floors per denominator and this module reads them below.
    let sampling = request.sampling;
    let interval_request = IntervalRequest {
        sampling,
        confidence_level: plan.confidence_level(),
        minimum_samples: 1,
    };
    let mut slice_confusions: BTreeMap<String, ConfusionMatrix> = plan
        .important_slices()
        .iter()
        .map(|slice| (slice.tag.clone(), ConfusionMatrix::default()))
        .collect();
    let (scopes, intervals) = if outcomes.is_empty() {
        (Vec::new(), None)
    } else {
        let measurement = metrics::evaluate_metrics(dataset, &outcomes)?;
        let interval_report = intervals::evaluate_intervals(dataset, &outcomes, &interval_request)?;
        for (tag, confusion) in slice_confusions.iter_mut() {
            if let Some(measured) = measurement.slice(tag) {
                *confusion = measured
                    .metrics
                    .iter()
                    .find(|set| set.scope == metrics::ALL_CHECKS)
                    .expect("evaluate_metrics states every scope of one slice")
                    .confusion;
            }
        }
        let whole = interval_report
            .set(metrics::ALL_CHECKS)
            .expect("the interval report states the complete check set")
            .clone();
        (measurement.scopes, Some(whole))
    };
    let confusion = scopes
        .iter()
        .find(|set| set.scope == metrics::ALL_CHECKS)
        .map(|set| set.confusion)
        .unwrap_or_default();

    // The evidence classification comes before every goal, because one
    // reused holdout and one non-representative dataset are development
    // data however the goals read.
    let evidence = splits::validation_evidence(
        validation_split.identity(),
        grouped.identity().population,
        &request.previously_used,
    );

    let goals: Vec<QualificationGoal> = plan
        .constraints()
        .iter()
        .map(|constraint| {
            measure_goal(
                constraint,
                &confusion,
                intervals
                    .as_ref()
                    .map(|set| set.interval(constraint.metric)),
                plan.minimum_of(constraint.denominator()),
            )
        })
        .collect();
    let sample_requirements: Vec<SampleRequirement> = plan
        .minimum_samples()
        .iter()
        .map(|(name, stated)| {
            let measured = denominator_count(name, &confusion);
            SampleRequirement {
                denominator: name.clone(),
                stated: *stated,
                measured,
                met: measured >= *stated,
            }
        })
        .collect();
    let slices: Vec<SliceResult> = plan
        .important_slices()
        .iter()
        .map(|slice| measure_slice(slice, &slice_confusions, intervals.as_ref()))
        .collect();

    let (status, reasons) =
        decide_status(&evidence, &goals, &sample_requirements, &slices, &confusion);

    let identity = validation_split.identity();
    Ok(QualificationReport {
        plan_id: plan.id().to_owned(),
        plan_content_hash: plan.content_hash().to_owned(),
        definition_name: plan.definition_name().to_owned(),
        definition_hash: hashing::definition_hash(definition),
        evaluator: plan.evaluator().clone(),
        method: METHOD,
        interval_method: intervals::METHOD,
        confidence_level: plan.confidence_level().as_f64(),
        sampling: sampling.as_str(),
        assumption: sampling.assumption(),
        method_statement: intervals::method_statement(&interval_request),
        candidate_index: selected.index,
        candidate,
        applied: policy,
        dataset: identity.dataset_id.clone(),
        revision: identity.revision.clone(),
        split: identity.split_id.clone(),
        split_content_hash: identity.content_hash.clone(),
        split_groups: identity.groups.clone(),
        case_count: records.len(),
        evidence,
        minimum_samples: plan.minimum_samples().clone(),
        sample_requirements,
        goals,
        scopes,
        intervals,
        slices,
        status,
        reasons,
        statement: CANDIDATE_STATEMENT,
    })
}

/// Qualifies the frozen candidate of one fitting result from assessment
/// text.
///
/// # Errors
///
/// Returns the failure of [`crate::json::parse_strict`] for malformed text,
/// otherwise the failure of [`qualify_candidate`].
pub fn qualify_candidate_str(
    plan: &ValidatedPlan,
    dataset: &ValidatedDataset<'_>,
    fit: &FitReport,
    request: &ValidationRequest,
    assessments_text: &str,
) -> Result<QualificationReport, ValidationError> {
    let assessments = crate::json::parse_strict(assessments_text)?;
    qualify_candidate(plan, dataset, fit, request, &assessments)
}

/// Checks that the fitting result ran under the offered plan.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` at `/fit/plan_id`
/// when the identifiers differ, and with `hash_mismatch` at
/// `/fit/plan_content_hash` when the computed plan identity differs, because
/// one plan that moved its limits, its grid, or its datasets measures
/// another goal set.
fn check_frozen_plan(plan: &ValidatedPlan, fit: &FitReport) -> Result<(), ValidationError> {
    if fit.plan_id != plan.id() {
        return Err(ValidationError::invalid_field_type(
            "/fit/plan_id",
            format!(
                "The fitting result names the plan {}, but the offered plan is {}. One candidate fitted under another plan measures another goal set.",
                fragment(&fit.plan_id),
                fragment(plan.id())
            ),
        ));
    }
    if fit.plan_content_hash != plan.content_hash() {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/fit/plan_content_hash",
            format!(
                "The fitting result records the plan identity {} of the plan {}, but the offered plan computes {}. The plan changed after the search, so the frozen candidate binds another goal set. Fit again under the offered plan.",
                fragment(&fit.plan_content_hash),
                fragment(plan.id()),
                fragment(plan.content_hash())
            ),
        ));
    }
    Ok(())
}

/// Checks that the fitting result measured the definition the plan binds.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `definition_mismatch` at
/// `/fit/definition_name` or `/fit/definition_hash`.
fn check_frozen_definition(plan: &ValidatedPlan, fit: &FitReport) -> Result<(), ValidationError> {
    if fit.definition_name != plan.definition_name() {
        return Err(ValidationError::new(
            ReasonCode::DefinitionMismatch,
            "/fit/definition_name",
            format!(
                "The fitting result names the definition {}, but the plan calibrates {}. One changed definition changes the meaning the validation measures.",
                fragment(&fit.definition_name),
                fragment(plan.definition_name())
            ),
        ));
    }
    if fit.definition_hash != plan.definition_hash() {
        return Err(ValidationError::new(
            ReasonCode::DefinitionMismatch,
            "/fit/definition_hash",
            format!(
                "The fitting result records another revision of the definition {}. One changed definition changes the meaning the validation measures.",
                fragment(plan.definition_name())
            ),
        ));
    }
    Ok(())
}

/// Checks that the fitting result read the fitting split of the plan.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` at `/fit/dataset`,
/// `/fit/revision`, or `/fit/split` when the names differ, and with
/// `hash_mismatch` at `/fit/split_content_hash` when the recorded digest
/// covers other records. One validation over another fitting split cannot
/// prove the separation of the two selections.
fn check_frozen_split(identity: &SplitIdentity, fit: &FitReport) -> Result<(), ValidationError> {
    if fit.dataset != identity.dataset_id {
        return Err(ValidationError::invalid_field_type(
            "/fit/dataset",
            format!(
                "The fitting result names the dataset {}, but the plan fits on {}.",
                fragment(&fit.dataset),
                fragment(&identity.dataset_id)
            ),
        ));
    }
    if fit.revision != identity.revision {
        return Err(ValidationError::invalid_field_type(
            "/fit/revision",
            format!(
                "The fitting result names the revision {}, but the plan fits on revision {}.",
                fragment(&fit.revision),
                fragment(&identity.revision)
            ),
        ));
    }
    if fit.split != identity.split_id {
        return Err(ValidationError::invalid_field_type(
            "/fit/split",
            format!(
                "The fitting result names the split {}, but the plan fits on {}.",
                fragment(&fit.split),
                fragment(&identity.split_id)
            ),
        ));
    }
    if fit.split_content_hash != identity.content_hash {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/fit/split_content_hash",
            format!(
                "The fitting result records another digest for the split {}, so the revision no longer covers the records the search measured.",
                fragment(&identity.split_id)
            ),
        ));
    }
    Ok(())
}

/// Builds the refusal of one candidate outside the permitted grid.
fn frozen_candidate_refusal() -> ValidationError {
    ValidationError::new(
        ReasonCode::PolicyMismatch,
        "/fit/selected/candidate",
        "The fitting result selects one candidate that the grid of the plan permits not. The frozen validation replays one permitted candidate alone. Fit again under the offered plan.",
    )
}

/// Measures one declared goal on the validation data.
///
/// Evidence comes before arithmetic: one rate without one denominator, one
/// denominator below the plan minimum, and one sampling model the
/// validation groups break state no value worth comparing, so the goal
/// stays unmet with its counts.
fn measure_goal(
    constraint: &PlanConstraint,
    confusion: &ConfusionMatrix,
    interval: Option<&Interval>,
    minimum: Option<usize>,
) -> QualificationGoal {
    let rate = metrics::rate_of(constraint.metric, confusion);
    let evidence = if rate.denominator == 0 {
        GoalEvidence::ZeroDenominator
    } else if minimum.is_some_and(|stated| rate.denominator < stated) {
        GoalEvidence::BelowMinimum {
            stated: minimum.unwrap_or_default(),
            measured: rate.denominator,
        }
    } else if interval.is_some_and(|row| row.is_unsupported_sampling()) {
        GoalEvidence::UnsupportedSampling
    } else {
        GoalEvidence::Measured
    };
    let mut upper_bound = None;
    let mut met = false;
    if evidence == GoalEvidence::Measured {
        match constraint.basis {
            LimitBasis::UpperConfidenceBound => {
                // One missing bound satisfies no goal. The interval rows of
                // the shared boundary state their own reasons, which the
                // evidence branch above already read.
                if let Some(bound) = interval.and_then(|row| row.upper_bound()) {
                    met = holds(constraint.comparison, bound, constraint.limit);
                    upper_bound = Some(bound);
                }
            }
            LimitBasis::ObservedValue => {
                met = holds(
                    constraint.comparison,
                    rate.value.expect("the denominator holds one case at least"),
                    constraint.limit,
                );
            }
        }
    }
    QualificationGoal {
        metric: constraint.metric,
        comparison: constraint.comparison,
        limit: constraint.limit,
        basis: constraint.basis,
        numerator: rate.numerator,
        denominator: rate.denominator,
        observed: rate.value,
        upper_bound,
        draws: interval.map_or(0, |row| row.draws),
        met,
        evidence,
    }
}

/// Measures one important slice of the plan on the validation data.
fn measure_slice(
    slice: &plan::ImportantSlice,
    confusions: &BTreeMap<String, ConfusionMatrix>,
    intervals: Option<&IntervalSet>,
) -> SliceResult {
    let confusion = confusions.get(&slice.tag).copied().unwrap_or_default();
    let denominators: BTreeMap<String, usize> = slice
        .minimum_samples
        .keys()
        .map(|name| (name.clone(), denominator_count(name, &confusion)))
        .collect();
    let short = slice
        .minimum_samples
        .iter()
        .find(|(name, stated)| denominators.get(*name).copied().unwrap_or_default() < **stated);
    let met = short.is_none();
    let statement = if confusion.predicted_totals().total() == 0 {
        format!(
            "The validation split holds no case of the slice {}, so the plan states one evidence requirement the validation cannot read.",
            fragment(&slice.tag)
        )
    } else if met {
        format!(
            "The slice {} meets every stated minimum of the validation split.",
            fragment(&slice.tag)
        )
    } else {
        let (name, stated) = short.expect("one unmet minimum exists");
        format!(
            "The slice {} holds {} cases of the denominator {}, of the stated {}.",
            fragment(&slice.tag),
            denominators.get(name).copied().unwrap_or_default(),
            fragment(name),
            stated
        )
    };
    SliceResult {
        tag: slice.tag.clone(),
        minimum_samples: slice.minimum_samples.clone(),
        denominators,
        met,
        metrics: MetricSet::assemble(metrics::ALL_CHECKS.to_owned(), confusion),
        intervals: intervals.cloned(),
        statement,
    }
}

/// Returns the case count of one published denominator name.
///
/// The mapping is the one [`metrics::rate_of`] reads through its metrics, so
/// one stated minimum and one stated rate count one population the same
/// way.
fn denominator_count(name: &str, confusion: &ConfusionMatrix) -> usize {
    match name {
        "accepted_cases" => confusion.labeled_predicted(Outcome::Pass),
        "evaluated_cases" => confusion.predicted_totals().total(),
        "labeled_cases" => confusion.labeled(),
        "reference_fail_or_review_cases" => {
            confusion.counts(Outcome::Fail).total() + confusion.counts(Outcome::Review).total()
        }
        "reference_pass_cases" => confusion.counts(Outcome::Pass).total(),
        _ => unreachable!("the plan validated its denominator names"),
    }
}

/// Computes the status and the calculated reasons of one validation.
///
/// Evidence comes before arithmetic at every step: one development
/// validation split, one goal without its evidence, one unmet plan minimum,
/// and one limited slice state `insufficient_evidence` before any measured
/// value decides one goal. The measured goals then decide, and every
/// failure keeps its calculated statement beside the status, so the owner
/// sees the number that failed and not one bare flag.
fn decide_status(
    evidence: &splits::ValidationEvidence,
    goals: &[QualificationGoal],
    requirements: &[SampleRequirement],
    slices: &[SliceResult],
    confusion: &ConfusionMatrix,
) -> (Qualification, Vec<QualificationReason>) {
    let mut reasons = Vec::new();
    if !evidence.is_independent() {
        reasons.push(QualificationReason {
            code: ReasonCode::InsufficientEvidence,
            statement: evidence.statement.clone(),
        });
    }
    for goal in goals {
        match goal.evidence {
            GoalEvidence::Measured => {}
            GoalEvidence::ZeroDenominator => reasons.push(QualificationReason {
                code: ReasonCode::ZeroDenominator,
                statement: format!(
                    "The metric {} states no denominator on the validation split, so no value and no bound exist.",
                    fragment(goal.metric.as_str())
                ),
            }),
            GoalEvidence::BelowMinimum { stated, measured } => reasons.push(QualificationReason {
                code: ReasonCode::InsufficientEvidence,
                statement: format!(
                    "The denominator of {} holds {} validation cases of the stated {}, so the plan declares the evidence too small for the goal.",
                    fragment(goal.metric.as_str()),
                    measured,
                    stated
                ),
            }),
            GoalEvidence::UnsupportedSampling => reasons.push(QualificationReason {
                code: ReasonCode::UnsupportedSampling,
                statement: format!(
                    "The declared sampling model holds not for {} on the validation split: the groups correlate cases of its denominator, so no bound computes.",
                    fragment(goal.metric.as_str())
                ),
            }),
        }
    }
    for requirement in requirements.iter().filter(|row| !row.met) {
        reasons.push(QualificationReason {
            code: ReasonCode::InsufficientEvidence,
            statement: format!(
                "The plan minimum of {} states {} and the validation split holds {}.",
                fragment(&requirement.denominator),
                requirement.stated,
                requirement.measured
            ),
        });
    }
    for slice in slices.iter().filter(|row| !row.met) {
        reasons.push(QualificationReason {
            code: ReasonCode::InsufficientEvidence,
            statement: slice.statement.clone(),
        });
    }
    if !reasons.is_empty() {
        return (Qualification::InsufficientEvidence, reasons);
    }

    let mut unmet = Vec::new();
    for goal in goals.iter().filter(|goal| !goal.met) {
        let value = match goal.basis {
            LimitBasis::UpperConfidenceBound => goal
                .upper_bound
                .map(|bound| {
                    format!(
                        "the upper bound {} at the declared confidence level",
                        share(bound)
                    )
                })
                .unwrap_or_else(|| "no bound the interval method states".to_owned()),
            LimitBasis::ObservedValue => format!(
                "the observed value {}",
                share(goal.observed.unwrap_or_default())
            ),
        };
        unmet.push(QualificationReason {
            code: ReasonCode::CriteriaNotMet,
            statement: format!(
                "The metric {} states {} over {} cases, and the plan limits it to {}.",
                fragment(goal.metric.as_str()),
                value,
                goal.denominator,
                share(goal.limit)
            ),
        });
    }
    if !unmet.is_empty() {
        return (Qualification::CriteriaNotMet, unmet);
    }

    (
        Qualification::ValidatedForScope,
        vec![QualificationReason {
            code: ReasonCode::MeasuredEvidence,
            statement: format!(
                "Every declared goal holds on the validation split: {} cases, {} with one reference label, every goal met on its declared basis, every plan minimum and every important-slice minimum met.",
                confusion.predicted_totals().total(),
                confusion.labeled()
            ),
        }],
    )
}

/// Returns true when the value meets the limit on the declared direction.
fn holds(comparison: Comparison, value: f64, limit: f64) -> bool {
    match comparison {
        Comparison::AtMost => value <= limit,
        Comparison::AtLeast => value >= limit,
    }
}

/// Formats one share for one readable statement, four decimals at most.
///
/// The exact value stays in the row fields. The statements cite one rounded
/// number for one human reader.
fn share(value: f64) -> String {
    let text = format!("{value:.4}");
    text.trim_end_matches('0').trim_end_matches('.').to_owned()
}

/// Moves one failure of one replayed answer under its case and check path.
fn at(error: ValidationError, case_path: &str, check: &str) -> ValidationError {
    ValidationError {
        field_path: format!("{case_path}/{check}{}", error.field_path),
        ..error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::{self, load_dataset};
    use crate::definition::{validate_definition_str, ValidatedDefinition};
    use serde_json::json;

    /// One definition with one categorical question and one exact rule, so
    /// the replay decides both kinds and the aggregate folds them.
    fn definition() -> ValidatedDefinition {
        let artifact = json!({
            "schema_version": 1,
            "name": "message-supported",
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
                    "question": "Does every material claim follow from the evidence?",
                    "answers": {
                        "supported": "All claims are supported.",
                        "contradicted": "One claim conflicts with the evidence.",
                        "incomplete": "Support for one claim is missing."
                    },
                    "accept": "supported",
                    "review": "incomplete"
                },
                {
                    "id": "message-length",
                    "name": "The message fits the delivery limit",
                    "using": ["proposed_message"],
                    "rule": {"maxLength": 40}
                }
            ]
        });
        validate_definition_str(&artifact.to_string()).expect("the definition validates")
    }

    /// One metadata artifact whose fitting split holds one group and whose
    /// validation split holds the stated groups.
    fn metadata(kind: &str, validation: &[&str]) -> Value {
        json!({
            "schema_version": 1,
            "id": "qualification-cases",
            "revision": "2026-09-24.1",
            "kind": kind,
            "intended_population": "Proposed messages in support conversations.",
            "sampling_method": "Sampled at random from reviewed traffic of one week.",
            "label_guidelines": "See docs/labeling.md revision 3.",
            "splits": [
                {"id": "fit", "purpose": "fitting", "groups": ["conversation-a"]},
                {"id": "holdout", "purpose": "validation", "groups": validation}
            ]
        })
    }

    /// One record of one designed case. `label` names the reference answer
    /// of the question check and `tags` names the slices the record joins.
    /// The exact rule passes every case.
    fn record(id: &str, group: &str, label: Option<&str>, tags: &[&str]) -> Value {
        let mut value = json!({
            "id": id,
            "group": group,
            "input": {
                "prior_decision": "Customer exports stay in the EU.",
                "conversation": "The new export worker stays in the EU region.",
                "proposed_message": "The export worker serves EU customers."
            },
            "label": {"author_type": "model", "origin": "synthetic", "reviewed": false}
        });
        if let Some(label) = label {
            value["expected"] = json!({
                "checks": {
                    "message-supported": {"answer": label},
                    "message-length": {"outcome": "pass"}
                }
            });
        }
        if !tags.is_empty() {
            value["tags"] = json!(tags);
        }
        value
    }

    /// One categorical assessment with its mass on the three answers.
    fn assessment(supported: f64, incomplete: f64, contradicted: f64) -> Value {
        let mut best = (supported, "supported");
        if incomplete > best.0 {
            best = (incomplete, "incomplete");
        }
        if contradicted > best.0 {
            best = (contradicted, "contradicted");
        }
        json!({
            "kind": "categorical",
            "label": best.1,
            "distribution": [
                {"name": "supported", "mass": supported},
                {"name": "incomplete", "mass": incomplete},
                {"name": "contradicted", "mass": contradicted}
            ]
        })
    }

    /// Serializes records into one record file.
    fn file(records: &[Value]) -> String {
        records
            .iter()
            .map(|value| serde_json::to_string(value).expect("serializes"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The fitting cases of the shared tests: five supported cases the
    /// evaluator accepts, one contradicted case it rejects, and one
    /// incomplete case that reviews at every cutoff. The first candidate
    /// accepts five cases without one error, and the 0.85 candidate accepts
    /// three and reviews one more, so the objective keeps the first.
    fn fitting_records() -> Vec<Value> {
        vec![
            record("fit-case-1", "conversation-a", Some("supported"), &[]),
            record("fit-case-2", "conversation-a", Some("supported"), &[]),
            record("fit-case-5", "conversation-a", Some("supported"), &[]),
            record("fit-case-6", "conversation-a", Some("supported"), &[]),
            record("fit-case-7", "conversation-a", Some("supported"), &[]),
            record("fit-case-3", "conversation-a", Some("contradicted"), &[]),
            record("fit-case-4", "conversation-a", Some("incomplete"), &[]),
        ]
    }

    /// The stored assessments of the fitting cases, in the same order.
    fn fitting_assessments() -> Value {
        json!({
            "fit-case-1": {"message-supported": assessment(0.95, 0.03, 0.02)},
            "fit-case-2": {"message-supported": assessment(0.90, 0.06, 0.04)},
            "fit-case-5": {"message-supported": assessment(0.85, 0.10, 0.05)},
            "fit-case-6": {"message-supported": assessment(0.80, 0.12, 0.08)},
            "fit-case-7": {"message-supported": assessment(0.75, 0.15, 0.10)},
            "fit-case-3": {"message-supported": assessment(0.05, 0.10, 0.85)},
            "fit-case-4": {"message-supported": assessment(0.20, 0.60, 0.20)}
        })
    }

    /// One plan artifact over the shared definition. The grid holds the
    /// selected candidate first and one higher cutoff second, and the
    /// validation selection names the holdout split.
    fn plan_artifact(
        id: &str,
        constraints: Value,
        minimum_samples: Value,
        important_slices: Value,
    ) -> Value {
        let definition = definition();
        json!({
            "schema_version": 1,
            "id": id,
            "definition": {
                "name": "message-supported",
                "content_hash": hashing::definition_hash(&definition)
            },
            "intended_population": "Proposed messages in support conversations.",
            "sampling_assumptions": "Cases grouped by conversation. Groups are independent draws.",
            "confidence_level": 0.95,
            "constraints": constraints,
            "objective": {"metric": "review_rate", "direction": "minimize"},
            "minimum_samples": minimum_samples,
            "important_slices": important_slices,
            "candidate_grid": {
                "accept_cutoffs": [0.55, 0.85],
                "rejection_cutoffs": [0.6]
            },
            "evaluator": {
                "evaluator": "jev-choice",
                "adapter_version": "0.1.0"
            },
            "datasets": {
                "fitting": {
                    "dataset": "qualification-cases",
                    "revision": "2026-09-24.1",
                    "split": "fit"
                },
                "validation": {
                    "dataset": "qualification-cases",
                    "revision": "2026-09-24.1",
                    "split": "holdout"
                }
            }
        })
    }

    /// One error goal among accepted cases, the smallest constraint body of
    /// the shared tests.
    fn error_goal(limit: f64, basis: &str) -> Value {
        json!([{
            "metric": "error_among_accepted",
            "comparison": "at_most",
            "limit": limit,
            "basis": basis
        }])
    }

    /// One coverage goal that no candidate of the fitting data reaches,
    /// because the incomplete case reviews at every cutoff.
    fn unreachable_goal() -> Value {
        json!([{
            "metric": "automatic_coverage",
            "comparison": "at_least",
            "limit": 0.95,
            "basis": "observed_value"
        }])
    }

    /// Runs one complete calibration: load, fit on the fitting split, then
    /// qualify the frozen candidate on the validation split.
    fn calibrated(
        plan_artifact: &Value,
        metadata: &Value,
        records_text: &str,
        request: &ValidationRequest,
        validation_assessments: &Value,
    ) -> Result<QualificationReport, ValidationError> {
        let fit = fitted(plan_artifact, metadata, records_text)?;
        let definition = definition();
        let metadata_text = serde_json::to_string(metadata).expect("serializes");
        let dataset = load_dataset(&metadata_text, records_text).expect("the dataset loads");
        let validated =
            dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        let plan = plan::validate_plan(plan_artifact).expect("the plan validates");
        qualify_candidate(&plan, &validated, &fit, request, validation_assessments)
    }

    /// Fits the shared fitting split under one plan.
    fn fitted(
        plan_artifact: &Value,
        metadata: &Value,
        records_text: &str,
    ) -> Result<FitReport, ValidationError> {
        let definition = definition();
        let metadata_text = serde_json::to_string(metadata).expect("serializes");
        let dataset = load_dataset(&metadata_text, records_text).expect("the dataset loads");
        let validated =
            dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        let plan = plan::validate_plan(plan_artifact).expect("the plan validates");
        fitting::fit_policy(&plan, &validated, &fitting_assessments())
    }

    /// The shared dataset: the fitting split and the validation split.
    fn shared_records(validation: &[Value]) -> String {
        let mut records = fitting_records();
        records.extend(validation.iter().cloned());
        file(&records)
    }

    /// The independent validation request of the shared tests.
    fn independent() -> ValidationRequest {
        ValidationRequest {
            sampling: SamplingModel::IndependentCases,
            previously_used: Vec::new(),
        }
    }

    /// Four labeled validation cases, one group per case, so every
    /// denominator holds one case per group. Two accepted cases without one
    /// error, one rejected case, and one reviewed case.
    fn clean_validation() -> Vec<Value> {
        vec![
            record(
                "hold-case-1",
                "conversation-b",
                Some("supported"),
                &["later-corrections"],
            ),
            record("hold-case-2", "conversation-c", Some("contradicted"), &[]),
            record(
                "hold-case-3",
                "conversation-d",
                Some("supported"),
                &["later-corrections"],
            ),
            record("hold-case-4", "conversation-e", Some("incomplete"), &[]),
        ]
    }

    /// The stored assessments of the clean validation cases.
    fn clean_assessments() -> Value {
        json!({
            "hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)},
            "hold-case-2": {"message-supported": assessment(0.05, 0.05, 0.90)},
            "hold-case-3": {"message-supported": assessment(0.80, 0.12, 0.08)},
            "hold-case-4": {"message-supported": assessment(0.20, 0.60, 0.20)}
        })
    }

    #[test]
    fn the_evaluator_identity_travels_unchanged_into_the_result() {
        // One plan that freezes one translation hash and one requested model
        // states the evaluator identity of the measurement. The validation
        // records it unchanged, so one changed translation, adapter, or model
        // resolution stays one changed binding that this result no longer
        // covers, whatever the validation data shows.
        let mut artifact = plan_artifact(
            "bound-evaluator-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        artifact["evaluator"]["translation_hash"] =
            json!("a5065efe5f955d002a550c9598efeb1217b0b402db10efda842f10682a2ec65b");
        artifact["evaluator"]["model_requested"] = json!("jev-1.2.0");
        let metadata = metadata(
            "representative_sample",
            &[
                "conversation-b",
                "conversation-c",
                "conversation-d",
                "conversation-e",
            ],
        );
        let report = calibrated(
            &artifact,
            &metadata,
            &shared_records(&clean_validation()),
            &independent(),
            &clean_assessments(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.evaluator.evaluator, "jev-choice");
        assert_eq!(report.evaluator.adapter_version, "0.1.0");
        assert_eq!(
            report.evaluator.translation_hash.as_deref(),
            Some("a5065efe5f955d002a550c9598efeb1217b0b402db10efda842f10682a2ec65b")
        );
        assert_eq!(
            report.evaluator.model_requested.as_deref(),
            Some("jev-1.2.0")
        );
        assert_eq!(report.status, Qualification::ValidatedForScope);
    }

    #[test]
    fn one_frozen_candidate_validates_for_the_declared_scope() {
        let plan = plan_artifact(
            "validated-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([{"tag": "later-corrections", "minimum_samples": {"labeled_cases": 2}}]),
        );
        let metadata = metadata(
            "representative_sample",
            &[
                "conversation-b",
                "conversation-c",
                "conversation-d",
                "conversation-e",
            ],
        );
        let report = calibrated(
            &plan,
            &metadata,
            &shared_records(&clean_validation()),
            &independent(),
            &clean_assessments(),
        )
        .unwrap_or_else(|error| panic!("{error}"));

        assert_eq!(report.status, Qualification::ValidatedForScope);
        assert!(report.is_validated());
        assert_eq!(report.reasons.len(), 1);
        assert_eq!(report.reasons[0].code, ReasonCode::MeasuredEvidence);
        assert!(
            report.reasons[0]
                .statement
                .contains("4 cases, 4 with one reference label"),
            "{}",
            report.reasons[0].statement
        );

        // The frozen candidate: the first of the grid, unchanged, with the
        // policy it applies and the enumeration position it won.
        assert_eq!(report.candidate_index, 0);
        assert_eq!(report.candidate.accept_cutoff, 0.55);
        assert_eq!(report.candidate.rejection_cutoff, 0.6);
        assert_eq!(report.candidate.confidence_floor, None);
        assert_eq!(report.applied.accept_cutoff, 0.55);

        // The goal row: two accepted cases, no error, measured on the
        // observed value, with two draws under independent cases.
        assert_eq!(report.goals.len(), 1);
        let goal = &report.goals[0];
        assert_eq!(goal.metric, MetricName::ErrorAmongAccepted);
        assert_eq!((goal.numerator, goal.denominator), (0, 2));
        assert_eq!(goal.observed, Some(0.0));
        assert_eq!(goal.upper_bound, None);
        assert_eq!(goal.draws, 2);
        assert_eq!(goal.evidence, GoalEvidence::Measured);
        assert!(goal.met);

        // The counts, the sample requirement, and the slice floor.
        assert_eq!(report.case_count, 4);
        assert_eq!(
            report.evidence.class,
            splits::EvidenceClass::IndependentValidation
        );
        assert!(!report.evidence.needs_fresh_evidence);
        assert_eq!(report.sample_requirements.len(), 1);
        assert_eq!(
            (
                report.sample_requirements[0].stated,
                report.sample_requirements[0].measured
            ),
            (2, 2)
        );
        assert!(report.sample_requirements[0].met);
        assert_eq!(report.slices.len(), 1);
        let slice = &report.slices[0];
        assert_eq!(slice.tag, "later-corrections");
        assert!(slice.met);
        assert_eq!(slice.denominators["labeled_cases"], 2);

        // The identities of the validation: plan, definition, dataset,
        // split, evaluator, method, and the standing statements.
        assert_eq!(report.plan_id, "validated-plan");
        assert_eq!(report.plan_content_hash.len(), 64);
        assert_eq!(report.definition_name, "message-supported");
        assert_eq!(report.definition_hash.len(), 64);
        assert_eq!(report.evaluator.evaluator, "jev-choice");
        assert_eq!(report.evaluator.adapter_version, "0.1.0");
        assert_eq!(report.dataset, "qualification-cases");
        assert_eq!(report.split, "holdout");
        assert_eq!(report.split_content_hash.len(), 64);
        assert_eq!(report.method, METHOD);
        assert_eq!(report.interval_method, intervals::METHOD);
        assert_eq!(report.confidence_level, 0.95);
        assert_eq!(report.sampling, "independent_cases");
        assert!(report.method_statement.contains("Wilson"));
        assert_eq!(report.statement, CANDIDATE_STATEMENT);

        // One metric set per check, then the complete check set, with the
        // interval rows of the complete check set beside them.
        let scopes: Vec<&str> = report.scopes.iter().map(|set| set.scope.as_str()).collect();
        assert_eq!(
            scopes,
            ["message-supported", "message-length", "all_checks"]
        );
        let whole = report
            .scopes
            .iter()
            .find(|set| set.scope == metrics::ALL_CHECKS)
            .expect("the complete check set");
        assert_eq!(whole.counts.pass, 2);
        assert_eq!(whole.counts.fail, 1);
        assert_eq!(whole.counts.review, 1);
        let intervals = report.intervals.as_ref().expect("the interval rows");
        assert_eq!(intervals.intervals.len(), MetricName::ALL.len());
        let row = intervals.interval(MetricName::ErrorAmongAccepted);
        assert_eq!((row.numerator, row.denominator), (0, 2));
        assert!(row.upper.is_some());
    }

    #[test]
    fn the_upper_bound_basis_qualifies_zero_observed_errors() {
        // Two constraints of one goal set: the observed value meets a tight
        // limit easily, and the upper bound of the same counts decides.
        let plan = plan_artifact(
            "bound-plan",
            json!([
                {
                    "metric": "error_among_accepted",
                    "comparison": "at_most",
                    "limit": 0.7,
                    "basis": "upper_confidence_bound"
                }
            ]),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        let metadata = metadata(
            "representative_sample",
            &[
                "conversation-b",
                "conversation-c",
                "conversation-d",
                "conversation-e",
            ],
        );
        let report = calibrated(
            &plan,
            &metadata,
            &shared_records(&clean_validation()),
            &independent(),
            &clean_assessments(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::ValidatedForScope);
        let goal = &report.goals[0];
        assert_eq!(goal.observed, Some(0.0));
        let (_, upper) = intervals::wilson_interval(
            0,
            2,
            plan::validate_plan(&plan)
                .expect("validates")
                .confidence_level(),
        )
        .expect("computes");
        assert_eq!(goal.upper_bound, Some(upper));
        assert!(upper > 0.0);
        assert!(goal.met);

        // Zero observed errors establish no zero risk: the same counts fail
        // one limit the observed value meets.
        let tight = plan_artifact(
            "tight-bound-plan",
            json!([{
                "metric": "error_among_accepted",
                "comparison": "at_most",
                "limit": 0.5,
                "basis": "upper_confidence_bound"
            }]),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        let report = calibrated(
            &tight,
            &metadata,
            &shared_records(&clean_validation()),
            &independent(),
            &clean_assessments(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::CriteriaNotMet);
        let goal = &report.goals[0];
        assert_eq!(goal.observed, Some(0.0));
        assert_eq!(goal.evidence, GoalEvidence::Measured);
        assert!(!goal.met);
        assert_eq!(report.reasons[0].code, ReasonCode::CriteriaNotMet);
        assert!(
            report.reasons[0].statement.contains("the upper bound"),
            "{}",
            report.reasons[0].statement
        );
    }

    #[test]
    fn unmet_goals_state_criteria_not_met_and_retune_nothing() {
        // The validation data holds one accepted case whose reference
        // contradicts. The frozen 0.55 cutoff accepts it and fails the goal;
        // the 0.85 cutoff of the same grid would review it and meet the
        // goal. The validation returns the frozen candidate unchanged.
        let plan = plan_artifact(
            "unmet-plan",
            error_goal(0.25, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        let metadata = metadata(
            "representative_sample",
            &["conversation-b", "conversation-c"],
        );
        let validation = vec![
            record("hold-case-1", "conversation-b", Some("supported"), &[]),
            record("hold-case-2", "conversation-c", Some("contradicted"), &[]),
        ];
        let assessments = json!({
            "hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)},
            "hold-case-2": {"message-supported": assessment(0.70, 0.05, 0.25)}
        });
        let fit = fitted(&plan, &metadata, &shared_records(&validation))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(fit.status, fitting::FitStatus::Feasible);
        assert_eq!(fit.selected().expect("one candidate").index, 0);
        assert_eq!(
            fit.selected()
                .expect("one candidate")
                .candidate
                .accept_cutoff,
            0.55
        );

        let report = calibrated(
            &plan,
            &metadata,
            &shared_records(&validation),
            &independent(),
            &assessments,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::CriteriaNotMet);
        assert!(!report.is_validated());
        let goal = &report.goals[0];
        assert_eq!((goal.numerator, goal.denominator), (1, 2));
        assert_eq!(goal.observed, Some(0.5));
        assert_eq!(goal.evidence, GoalEvidence::Measured);
        assert!(!goal.met);
        assert_eq!(report.reasons.len(), 1);
        assert_eq!(report.reasons[0].code, ReasonCode::CriteriaNotMet);
        assert!(
            report.reasons[0]
                .statement
                .contains("the observed value 0.5"),
            "{}",
            report.reasons[0].statement
        );

        // The validation data favors the second candidate of the grid. The
        // result returns the frozen one and changes no parameter of it.
        assert_eq!(report.candidate.accept_cutoff, 0.55);
        assert_eq!(report.candidate_index, 0);
        assert_eq!(report.applied.accept_cutoff, 0.55);
        assert_eq!(report.statement, CANDIDATE_STATEMENT);
    }

    #[test]
    fn small_samples_state_insufficient_evidence() {
        // The plan minimum of the accepted denominator sits above the two
        // accepted validation cases, so the plan itself declares the
        // evidence too small for the goal and for the complete validation.
        let plan = plan_artifact(
            "small-sample-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 5}),
            json!([]),
        );
        let metadata = metadata(
            "representative_sample",
            &[
                "conversation-b",
                "conversation-c",
                "conversation-d",
                "conversation-e",
            ],
        );
        let report = calibrated(
            &plan,
            &metadata,
            &shared_records(&clean_validation()),
            &independent(),
            &clean_assessments(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::InsufficientEvidence);
        assert!(!report.is_validated());

        // The goal row states the floor, and the comparison never runs.
        let goal = &report.goals[0];
        assert_eq!(
            goal.evidence,
            GoalEvidence::BelowMinimum {
                stated: 5,
                measured: 2
            }
        );
        assert_eq!((goal.numerator, goal.denominator), (0, 2));
        assert!(!goal.met);
        assert_eq!(goal.upper_bound, None);

        // The complete validation states the same fact through its own row.
        let requirement = &report.sample_requirements[0];
        assert_eq!(
            (requirement.stated, requirement.measured, requirement.met),
            (5, 2, false)
        );
        let codes: Vec<ReasonCode> = report.reasons.iter().map(|row| row.code).collect();
        assert!(
            codes.contains(&ReasonCode::InsufficientEvidence),
            "{codes:?}"
        );
        assert!(
            report
                .reasons
                .iter()
                .any(|row| row.statement.contains("of the stated 5")),
            "{:?}",
            report.reasons
        );
    }

    #[test]
    fn unlabeled_validation_cases_leave_no_denominator() {
        // Two validation cases without one reference: the review and the
        // coverage rates count them, the error metric keeps no denominator,
        // and no observed zero decides the goal.
        let plan = plan_artifact(
            "unlabeled-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        let metadata = metadata(
            "representative_sample",
            &["conversation-b", "conversation-c"],
        );
        let validation = vec![
            record("hold-case-1", "conversation-b", None, &[]),
            record("hold-case-2", "conversation-c", None, &[]),
        ];
        let assessments = json!({
            "hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)},
            "hold-case-2": {"message-supported": assessment(0.80, 0.12, 0.08)}
        });
        let report = calibrated(
            &plan,
            &metadata,
            &shared_records(&validation),
            &independent(),
            &assessments,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::InsufficientEvidence);
        let goal = &report.goals[0];
        assert_eq!(goal.evidence, GoalEvidence::ZeroDenominator);
        assert_eq!(goal.denominator, 0);
        assert_eq!(goal.observed, None);
        assert!(!goal.met);
        let codes: Vec<ReasonCode> = report.reasons.iter().map(|row| row.code).collect();
        assert!(codes.contains(&ReasonCode::ZeroDenominator), "{codes:?}");
    }

    #[test]
    fn correlated_groups_state_unsupported_sampling() {
        // Two accepted validation cases share one group. The independent
        // model breaks, so no bound computes and the goal keeps its counts
        // without one comparison. The grouped model makes the group the
        // draw and states one bound.
        let plan = plan_artifact(
            "grouped-plan",
            error_goal(0.7, "upper_confidence_bound"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        let metadata = metadata(
            "representative_sample",
            &["conversation-b", "conversation-c"],
        );
        let validation = vec![
            record("hold-case-1", "conversation-b", Some("supported"), &[]),
            record("hold-case-2", "conversation-b", Some("supported"), &[]),
            record("hold-case-3", "conversation-c", Some("supported"), &[]),
            record("hold-case-4", "conversation-c", Some("supported"), &[]),
        ];
        let assessments = json!({
            "hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)},
            "hold-case-2": {"message-supported": assessment(0.80, 0.12, 0.08)},
            "hold-case-3": {"message-supported": assessment(0.85, 0.10, 0.05)},
            "hold-case-4": {"message-supported": assessment(0.75, 0.15, 0.10)}
        });
        let records = shared_records(&validation);

        let report = calibrated(&plan, &metadata, &records, &independent(), &assessments)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::InsufficientEvidence);
        let goal = &report.goals[0];
        assert_eq!(goal.evidence, GoalEvidence::UnsupportedSampling);
        assert_eq!((goal.numerator, goal.denominator), (0, 4));
        assert_eq!(goal.upper_bound, None);
        assert!(!goal.met);
        assert_eq!(report.reasons[0].code, ReasonCode::UnsupportedSampling);
        assert!(
            report.reasons[0].statement.contains("correlate"),
            "{}",
            report.reasons[0].statement
        );

        let grouped = ValidationRequest {
            sampling: SamplingModel::GroupedCases,
            previously_used: Vec::new(),
        };
        let report = calibrated(&plan, &metadata, &records, &grouped, &assessments)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::ValidatedForScope);
        let goal = &report.goals[0];
        assert_eq!(goal.evidence, GoalEvidence::Measured);
        assert_eq!(goal.draws, 2);
        assert!(goal.upper_bound.is_some());
        assert!(goal.met);
        assert_eq!(report.sampling, "grouped_cases");
    }

    #[test]
    fn one_reused_holdout_is_development_data() {
        let plan = plan_artifact(
            "fresh-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        let metadata = metadata("representative_sample", &["conversation-b"]);
        let validation = vec![record(
            "hold-case-1",
            "conversation-b",
            Some("supported"),
            &[],
        )];
        let assessments =
            json!({"hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)}});
        let records = shared_records(&validation);

        // The holdout of one earlier claim carries the same content, so the
        // validation is development data and needs fresh evidence, whatever
        // the goals read.
        let metadata_text = serde_json::to_string(&metadata).expect("serializes");
        let dataset = load_dataset(&metadata_text, &records).expect("the dataset loads");
        let grouped = splits::dataset_splits(&dataset).expect("the splits compute");
        let used = grouped
            .splits()
            .iter()
            .find(|split| split.identity().split_id == "holdout")
            .expect("the holdout")
            .identity()
            .clone();
        let request = ValidationRequest {
            sampling: SamplingModel::IndependentCases,
            previously_used: vec![used],
        };
        let report = calibrated(&plan, &metadata, &records, &request, &assessments)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::InsufficientEvidence);
        assert_eq!(report.evidence.class, splits::EvidenceClass::Development);
        assert!(report.evidence.needs_fresh_evidence);
        assert_eq!(report.evidence.reused_from.len(), 1);
        assert_eq!(report.reasons[0].code, ReasonCode::InsufficientEvidence);
        assert!(
            report.reasons[0].statement.contains("was used before"),
            "{}",
            report.reasons[0].statement
        );
    }

    #[test]
    fn one_non_representative_dataset_supports_no_claim() {
        let plan = plan_artifact(
            "fixture-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 1}),
            json!([]),
        );
        let metadata = metadata("development_fixture", &["conversation-b"]);
        let validation = vec![record(
            "hold-case-1",
            "conversation-b",
            Some("supported"),
            &[],
        )];
        let assessments =
            json!({"hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)}});
        let report = calibrated(
            &plan,
            &metadata,
            &shared_records(&validation),
            &independent(),
            &assessments,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::InsufficientEvidence);
        assert!(!report.evidence.representative_sample);
        assert!(
            report.reasons[0]
                .statement
                .contains("no representative sample"),
            "{}",
            report.reasons[0].statement
        );
    }

    #[test]
    fn important_slices_carry_their_own_floors() {
        // The plan requires two labeled cases of the later-corrections
        // slice. One present slice below its floor and one absent slice
        // each state insufficient evidence with their own counts.
        let plan = plan_artifact(
            "slice-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 1}),
            json!([{"tag": "later-corrections", "minimum_samples": {"labeled_cases": 2}}]),
        );
        let two_groups = metadata(
            "representative_sample",
            &["conversation-b", "conversation-c"],
        );
        let validation = vec![
            record(
                "hold-case-1",
                "conversation-b",
                Some("supported"),
                &["later-corrections"],
            ),
            record("hold-case-2", "conversation-c", Some("contradicted"), &[]),
        ];
        let assessments = json!({
            "hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)},
            "hold-case-2": {"message-supported": assessment(0.05, 0.05, 0.90)}
        });
        let report = calibrated(
            &plan,
            &two_groups,
            &shared_records(&validation),
            &independent(),
            &assessments,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::InsufficientEvidence);
        let slice = &report.slices[0];
        assert!(!slice.met);
        assert_eq!(slice.denominators["labeled_cases"], 1);
        assert_eq!(slice.minimum_samples["labeled_cases"], 2);
        assert!(
            slice.statement.contains("of the stated 2"),
            "{}",
            slice.statement
        );
        assert_eq!(report.reasons[0].code, ReasonCode::InsufficientEvidence);
        assert!(
            report.reasons[0].statement.contains("later-corrections"),
            "{}",
            report.reasons[0].statement
        );

        // One slice the validation split holds no case of states the empty
        // floor, whatever the goals read.
        let empty = plan_artifact(
            "empty-slice-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 1}),
            json!([{"tag": "later-corrections", "minimum_samples": {"labeled_cases": 2}}]),
        );
        let single = metadata("representative_sample", &["conversation-b"]);
        let validation = vec![record(
            "hold-case-1",
            "conversation-b",
            Some("supported"),
            &[],
        )];
        let assessments =
            json!({"hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)}});
        let report = calibrated(
            &empty,
            &single,
            &shared_records(&validation),
            &independent(),
            &assessments,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::InsufficientEvidence);
        let slice = &report.slices[0];
        assert!(!slice.met);
        assert_eq!(slice.denominators["labeled_cases"], 0);
        assert!(
            slice.statement.contains("holds no case of the slice"),
            "{}",
            slice.statement
        );
    }

    #[test]
    fn one_empty_validation_split_states_insufficient_evidence() {
        // The holdout names one group that holds no record, so the split
        // carries no evidence and every goal keeps no denominator.
        let plan = plan_artifact(
            "empty-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        let metadata = metadata("representative_sample", &["absent-group"]);
        let report = calibrated(
            &plan,
            &metadata,
            &shared_records(&[]),
            &independent(),
            &json!({}),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::InsufficientEvidence);
        assert_eq!(report.case_count, 0);
        assert_eq!(report.evidence.class, splits::EvidenceClass::Development);
        assert_eq!(report.evidence.record_count, 0);
        assert_eq!(report.goals[0].evidence, GoalEvidence::ZeroDenominator);
        assert!(report.intervals.is_none());
        assert!(report.scopes.is_empty());
        let codes: Vec<ReasonCode> = report.reasons.iter().map(|row| row.code).collect();
        assert!(
            codes.contains(&ReasonCode::InsufficientEvidence),
            "{codes:?}"
        );
        assert!(codes.contains(&ReasonCode::ZeroDenominator), "{codes:?}");
    }

    #[test]
    fn unvalidated_is_never_one_validation_result() {
        // The four contract words round trip, and the frozen validation
        // computes the three measured ones alone. One exploration profile
        // stays unvalidated, as the checked qualification model records.
        for (word, status) in [
            ("unvalidated", Qualification::Unvalidated),
            ("insufficient_evidence", Qualification::InsufficientEvidence),
            ("criteria_not_met", Qualification::CriteriaNotMet),
            ("validated_for_scope", Qualification::ValidatedForScope),
        ] {
            assert_eq!(status.as_str(), word);
            assert_eq!(Qualification::from_word(word), Some(status));
        }
        let metadata = metadata(
            "representative_sample",
            &[
                "conversation-b",
                "conversation-c",
                "conversation-d",
                "conversation-e",
            ],
        );
        let clean = shared_records(&clean_validation());
        // One validation split with one accepted error: the same plan family
        // reads it, and one goal fails on its measured evidence.
        let unmet = vec![
            record("hold-case-1", "conversation-b", Some("supported"), &[]),
            record("hold-case-2", "conversation-c", Some("contradicted"), &[]),
        ];
        let unmet_records = shared_records(&unmet);
        let unmet_assessments = json!({
            "hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)},
            "hold-case-2": {"message-supported": assessment(0.70, 0.05, 0.25)}
        });
        let rows: [(&str, Value, Value, &str, &Value); 3] = [
            (
                "validated-plan",
                error_goal(0.5, "observed_value"),
                json!({"accepted_cases": 2}),
                &clean,
                &clean_assessments(),
            ),
            (
                "unmet-plan",
                error_goal(0.25, "observed_value"),
                json!({"accepted_cases": 2}),
                &unmet_records,
                &unmet_assessments,
            ),
            (
                "small-sample-plan",
                error_goal(0.5, "observed_value"),
                json!({"accepted_cases": 5}),
                &clean,
                &clean_assessments(),
            ),
        ];
        let mut statuses = Vec::new();
        for (id, constraints, minimums, records, assessments) in rows {
            let report = calibrated(
                &plan_artifact(id, constraints, minimums, json!([])),
                &metadata,
                records,
                &independent(),
                assessments,
            )
            .unwrap_or_else(|error| panic!("{id}: {error}"));
            assert_ne!(report.status, Qualification::Unvalidated, "{id}");
            statuses.push(report.status);
        }
        assert!(statuses.contains(&Qualification::ValidatedForScope));
        assert!(statuses.contains(&Qualification::CriteriaNotMet));
        assert!(statuses.contains(&Qualification::InsufficientEvidence));
    }

    #[test]
    fn the_freeze_refuses_every_foreign_fitting_result() {
        let metadata = metadata(
            "representative_sample",
            &[
                "conversation-b",
                "conversation-c",
                "conversation-d",
                "conversation-e",
            ],
        );
        let records = shared_records(&clean_validation());
        let definition = definition();
        let metadata_text = serde_json::to_string(&metadata).expect("serializes");
        let dataset = load_dataset(&metadata_text, &records).expect("the dataset loads");
        let validated =
            dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        let plan = plan_artifact(
            "frozen-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        let plan = plan::validate_plan(&plan).expect("the plan validates");
        let fit =
            fitting::fit_policy(&plan, &validated, &fitting_assessments()).expect("the fit runs");

        // One plan edited after the search moves its limit, so its computed
        // identity differs and the frozen candidate binds another goal set.
        let mut edited = plan.as_artifact().clone();
        edited["constraints"][0]["limit"] = json!(0.4);
        let edited = plan::validate_plan(&edited).expect("the plan validates");
        let error = qualify_candidate(
            &edited,
            &validated,
            &fit,
            &independent(),
            &clean_assessments(),
        )
        .expect_err("the plan changed after the search");
        assert_eq!(error.code, ReasonCode::HashMismatch, "{error}");
        assert_eq!(error.field_path, "/fit/plan_content_hash", "{error}");

        // One fitting result of another plan.
        let mut other = plan.as_artifact().clone();
        other["id"] = json!("other-plan");
        let other = plan::validate_plan(&other).expect("the plan validates");
        let other_fit =
            fitting::fit_policy(&other, &validated, &fitting_assessments()).expect("the fit runs");
        let error = qualify_candidate(
            &plan,
            &validated,
            &other_fit,
            &independent(),
            &clean_assessments(),
        )
        .expect_err("the fit names another plan");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/fit/plan_id", "{error}");

        // One fitting result that records another definition revision.
        let mut foreign = fit.clone();
        foreign.definition_hash =
            "88c86b66dd45adbd34e4a409dd3a37a2cbe6f94990fefb35c7f0d97dcaf94970".to_owned();
        let error = qualify_candidate(
            &plan,
            &validated,
            &foreign,
            &independent(),
            &clean_assessments(),
        )
        .expect_err("the fit records another definition");
        assert_eq!(error.code, ReasonCode::DefinitionMismatch, "{error}");
        assert_eq!(error.field_path, "/fit/definition_hash", "{error}");

        // One fitting result that read another split of another revision.
        let mut moved = fit.clone();
        moved.split = "holdout".to_owned();
        let error = qualify_candidate(
            &plan,
            &validated,
            &moved,
            &independent(),
            &clean_assessments(),
        )
        .expect_err("the fit read another split");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/fit/split", "{error}");
        let mut rehashed = fit.clone();
        rehashed.split_content_hash =
            "88c86b66dd45adbd34e4a409dd3a37a2cbe6f94990fefb35c7f0d97dcaf94970".to_owned();
        let error = qualify_candidate(
            &plan,
            &validated,
            &rehashed,
            &independent(),
            &clean_assessments(),
        )
        .expect_err("the fit records another digest");
        assert_eq!(error.code, ReasonCode::HashMismatch, "{error}");
        assert_eq!(error.field_path, "/fit/split_content_hash", "{error}");

        // One selected candidate outside the permitted grid.
        let mut retuned = fit.clone();
        retuned
            .selected
            .as_mut()
            .expect("one candidate")
            .candidate
            .accept_cutoff = 0.7;
        let error = qualify_candidate(
            &plan,
            &validated,
            &retuned,
            &independent(),
            &clean_assessments(),
        )
        .expect_err("the candidate sits outside the grid");
        assert_eq!(error.code, ReasonCode::PolicyMismatch, "{error}");
        assert_eq!(error.field_path, "/fit/selected/candidate", "{error}");

        // One search that found no feasible candidate holds no frozen
        // candidate to validate.
        let unfeasible = plan_artifact(
            "no-candidate-plan",
            unreachable_goal(),
            json!({"evaluated_cases": 1}),
            json!([]),
        );
        let unfeasible = plan::validate_plan(&unfeasible).expect("the plan validates");
        let unfeasible_fit = fitting::fit_policy(&unfeasible, &validated, &fitting_assessments())
            .expect("the fit runs");
        assert_eq!(
            unfeasible_fit.status,
            fitting::FitStatus::NoFeasibleCandidate
        );
        let error = qualify_candidate(
            &unfeasible,
            &validated,
            &unfeasible_fit,
            &independent(),
            &clean_assessments(),
        )
        .expect_err("no candidate exists");
        assert_eq!(error.code, ReasonCode::CriteriaNotMet, "{error}");
        assert_eq!(error.field_path, "/fit/selected", "{error}");
    }

    #[test]
    fn the_validation_selection_binds_its_own_purpose_and_separation() {
        let metadata = metadata(
            "representative_sample",
            &[
                "conversation-b",
                "conversation-c",
                "conversation-d",
                "conversation-e",
            ],
        );
        let records = shared_records(&clean_validation());
        let definition = definition();
        let metadata_text = serde_json::to_string(&metadata).expect("serializes");
        let dataset = load_dataset(&metadata_text, &records).expect("the dataset loads");
        let validated =
            dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        let grouped = splits::dataset_splits(&dataset).expect("the splits compute");
        let fit_digest = grouped
            .split("fit")
            .expect("the fitting split")
            .identity()
            .content_hash
            .clone();

        // One validation selection that names the fitting split states one
        // stored digest, so the plan stays valid and the purpose refuses it.
        let mut swapped = plan_artifact(
            "swapped-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        swapped["datasets"]["validation"]["split"] = json!("fit");
        swapped["datasets"]["validation"]["content_hash"] = json!(fit_digest);
        let plan = plan::validate_plan(&swapped).expect("the plan validates");
        let fit =
            fitting::fit_policy(&plan, &validated, &fitting_assessments()).expect("the fit runs");
        let error = qualify_candidate(
            &plan,
            &validated,
            &fit,
            &independent(),
            &clean_assessments(),
        )
        .expect_err("the fitting split is no validation data");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(
            error.field_path, "/plan/datasets/validation/split",
            "{error}"
        );

        // One validation selection that names one absent split.
        let mut absent = plan_artifact(
            "absent-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        absent["datasets"]["validation"]["split"] = json!("absent");
        let plan = plan::validate_plan(&absent).expect("the plan validates");
        let fit =
            fitting::fit_policy(&plan, &validated, &fitting_assessments()).expect("the fit runs");
        let error = qualify_candidate(
            &plan,
            &validated,
            &fit,
            &independent(),
            &clean_assessments(),
        )
        .expect_err("the split names no declared split");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(
            error.field_path, "/plan/datasets/validation/split",
            "{error}"
        );
    }

    #[test]
    fn the_validation_selection_names_the_offered_dataset() {
        // One validation selection that names another dataset reads data the
        // calibration never offered. The loader keeps the groups of one
        // dataset inside one split, so the plan boundary refuses the foreign
        // selection before any case is read.
        let metadata = metadata("representative_sample", &["conversation-b"]);
        let records = shared_records(&[record(
            "hold-case-1",
            "conversation-b",
            Some("supported"),
            &[],
        )]);
        let assessments =
            json!({"hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)}});
        let mut foreign = plan_artifact(
            "foreign-dataset-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        foreign["datasets"]["validation"]["dataset"] = json!("other-cases");
        let error = calibrated(&foreign, &metadata, &records, &independent(), &assessments)
            .expect_err("the selection names another dataset");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(
            error.field_path, "/plan/datasets/validation/dataset",
            "{error}"
        );

        // One validation selection that names another revision of the same
        // dataset reads other content.
        let mut other_revision = plan_artifact(
            "foreign-revision-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 2}),
            json!([]),
        );
        other_revision["datasets"]["validation"]["revision"] = json!("2026-09-24.2");
        let error = calibrated(
            &other_revision,
            &metadata,
            &records,
            &independent(),
            &assessments,
        )
        .expect_err("the selection names another revision");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(
            error.field_path, "/plan/datasets/validation/revision",
            "{error}"
        );
    }

    #[test]
    fn stored_assessments_report_their_case_and_check_paths() {
        let metadata = metadata(
            "representative_sample",
            &["conversation-b", "conversation-c"],
        );
        let validation = vec![
            record("hold-case-1", "conversation-b", Some("supported"), &[]),
            record("hold-case-2", "conversation-c", Some("contradicted"), &[]),
        ];
        let records = shared_records(&validation);
        let assessments = json!({
            "hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)},
            "hold-case-2": {"message-supported": assessment(0.05, 0.05, 0.90)}
        });
        let plan = plan_artifact(
            "assessment-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 1}),
            json!([]),
        );

        // One assessment that names one fitting case states measurement of
        // data the validation never reads.
        let mut with_fit_case = assessments.clone();
        with_fit_case["fit-case-1"] = json!({"message-supported": assessment(0.9, 0.05, 0.05)});
        let error = calibrated(&plan, &metadata, &records, &independent(), &with_fit_case)
            .expect_err("the fitting case is no validation case");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/assessments/fit-case-1", "{error}");

        // One validation case without its assessment.
        let mut missing = assessments.clone();
        missing
            .as_object_mut()
            .expect("an object")
            .remove("hold-case-2");
        let error = calibrated(&plan, &metadata, &records, &independent(), &missing)
            .expect_err("the case states no assessment");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/assessments/hold-case-2", "{error}");

        // One assessment for the exact rule of the definition.
        let mut with_rule = assessments.clone();
        with_rule["hold-case-2"]["message-length"] = json!({"outcome": "pass"});
        let error = calibrated(&plan, &metadata, &records, &independent(), &with_rule)
            .expect_err("one rule check takes no assessment");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(
            error.field_path, "/assessments/hold-case-2/message-length",
            "{error}"
        );

        // One assessment that names no declared answer of its check.
        let mut broken = assessments.clone();
        broken["hold-case-2"]["message-supported"]["label"] = json!("unsupported-answer");
        let error = calibrated(&plan, &metadata, &records, &independent(), &broken)
            .expect_err("the label names no declared answer");
        assert_eq!(error.code, ReasonCode::InvalidAssessment, "{error}");
        assert_eq!(
            error.field_path, "/assessments/hold-case-2/message-supported/assessment/label",
            "{error}"
        );

        // One value that holds no assessment object at all.
        let error = calibrated(&plan, &metadata, &records, &independent(), &json!([]))
            .expect_err("the assessments hold no object");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/assessments", "{error}");
    }

    #[test]
    fn validation_requests_parse_through_the_strict_gate() {
        let identity = json!({
            "dataset": "qualification-cases",
            "revision": "2026-09-24.1",
            "split": "holdout",
            "purpose": "validation",
            "groups": ["conversation-b"],
            "record_count": 2,
            "content_hash": "a5065efe5f955d002a550c9598efeb1217b0b402db10efda842f10682a2ec65b",
            "case_ids": ["hold-case-1", "hold-case-2"]
        });
        let request = parse_validation_request(&json!({
            "sampling": "grouped_cases",
            "previously_used": [identity]
        }))
        .expect("the request parses");
        assert_eq!(request.sampling, SamplingModel::GroupedCases);
        assert_eq!(request.previously_used.len(), 1);
        assert_eq!(request.previously_used[0].split_id, "holdout");

        // One omitted list of used splits states none.
        let request = parse_validation_request(&json!({"sampling": "independent_cases"}))
            .expect("the request parses");
        assert!(request.previously_used.is_empty());

        // One sampling word outside the two models.
        let error = parse_validation_request(&json!({"sampling": "clustered"}))
            .expect_err("one unsupported model");
        assert_eq!(error.code, ReasonCode::UnsupportedSampling, "{error}");
        assert_eq!(error.field_path, "/sampling", "{error}");

        // One request without one sampling model states no procedure.
        let error = parse_validation_request(&json!({"previously_used": []}))
            .expect_err("no sampling model");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/sampling", "{error}");

        // One foreign field and one repeated split.
        let error = parse_validation_request(&json!({"sampling": "grouped_cases", "level": 0.9}))
            .expect_err("one foreign field");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/level", "{error}");
        let error = parse_validation_request(&json!({
            "sampling": "grouped_cases",
            "previously_used": [identity, identity]
        }))
        .expect_err("one repeated split");
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/previously_used/1/split", "{error}");

        // One broken identity names its field under the list.
        let mut broken = identity.clone();
        broken["dataset"] = json!("Qualification-Cases");
        let error = parse_validation_request(&json!({
            "sampling": "grouped_cases",
            "previously_used": [broken]
        }))
        .expect_err("one broken identity");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/previously_used/0/dataset", "{error}");

        // Malformed text fails at the gate, and one array holds no request.
        let error = parse_validation_request_str("{\"sampling\": ").expect_err("malformed text");
        assert_eq!(error.code, ReasonCode::InvalidJson, "{error}");
        let error = parse_validation_request(&json!([])).expect_err("no object");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
    }

    #[test]
    fn validation_reads_assessment_text_through_the_strict_gate() {
        let plan = plan_artifact(
            "text-plan",
            error_goal(0.5, "observed_value"),
            json!({"accepted_cases": 1}),
            json!([]),
        );
        let metadata = metadata("representative_sample", &["conversation-b"]);
        let records = shared_records(&[record(
            "hold-case-1",
            "conversation-b",
            Some("supported"),
            &[],
        )]);
        let text = serde_json::to_string(&json!({
            "hold-case-1": {"message-supported": assessment(0.90, 0.05, 0.05)}
        }))
        .expect("serializes");
        // One empty assessment object omits the validation case.
        let error = calibrated(&plan, &metadata, &records, &independent(), &json!({}))
            .expect_err("the case states no assessment");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/assessments/hold-case-1", "{error}");

        // The text path runs the same validation.
        let definition = definition();
        let metadata_text = serde_json::to_string(&metadata).expect("serializes");
        let dataset = load_dataset(&metadata_text, &records).expect("the dataset loads");
        let validated =
            dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        let plan = plan::validate_plan(&plan).expect("the plan validates");
        let fit =
            fitting::fit_policy(&plan, &validated, &fitting_assessments()).expect("the fit runs");
        let report = qualify_candidate_str(&plan, &validated, &fit, &independent(), &text)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, Qualification::ValidatedForScope);

        // Malformed text fails at the gate before any case is read.
        let error = qualify_candidate_str(
            &plan,
            &validated,
            &fit,
            &independent(),
            "{\"hold-case-1\": ",
        )
        .expect_err("malformed text");
        assert_eq!(error.code, ReasonCode::InvalidJson, "{error}");
    }
}
