// SPDX-License-Identifier: Apache-2.0
//! The bounded fitting search of one calibration plan.
//!
//! Fitting answers one question: which candidate of the permitted family
//! the development data supports best. MVP_SPEC.md section 7 fixes the
//! procedure. The evaluator has already measured the development cases, the
//! Rust core searches the bounded policy family against the agreed
//! objectives, and the frozen validation of held-out cases stays one
//! separate later step that this module never performs.
//!
//! [`fit_policy`] runs that search:
//!
//! - It reads the fitting selection of the plan from one offered dataset.
//!   The offered split must carry the fitting purpose, so validation data
//!   cannot enter the search: the split is located through the plan's own
//!   selection, its records are the only cases measured, and one assessment
//!   that names any other case fails with its path.
//! - It enumerates the permitted candidates in the declared order, which the
//!   plan module fixes: the accept dimension outermost, the rejection
//!   dimension inner, the confidence floor innermost with no floor first.
//! - It replays every case through [`policy::decide`] under the candidate
//!   policy, exactly as one run decides, and folds the outcomes with the
//!   shared metric definitions of [`metrics`]. Rule checks run through
//!   [`rule::assess_check`], because they need no evaluator and no policy.
//! - The plan states no scope, so every constraint and the objective read
//!   the complete check set, the aggregate decision the owner governs. The
//!   selected candidate also returns one metric set per check for
//!   inspection.
//! - One constraint is met only when its evidence exists: its rate states
//!   one denominator, the denominator meets the plan minimum, and the
//!   comparison holds on the declared basis. The `upper_confidence_bound`
//!   basis reads the Wilson upper bound of the rate at the declared
//!   confidence level, so zero observed errors still bound one risk above
//!   zero, and one missing bound satisfies no goal.
//! - The first candidate that meets every constraint and optimizes the
//!   objective wins one tie, exactly as the contracts README states. The
//!   objective comparison is exact over the rate counts, so two candidates
//!   with equal counts tie without float doubt.
//! - No feasible candidate is one valid result, not one failure. The report
//!   states the status, keeps every owner limit as declared, and returns
//!   the measured constraint fit of every candidate, so the unmet goals
//!   stay visible. Nothing weakens one goal to qualify one candidate.
//!
//! The search is bounded before it runs. One grid above
//! [`MAX_FIT_CANDIDATES`] candidates and one search above
//! [`MAX_FIT_DECISIONS`] policy decisions fail explicitly with their
//! counts, because the fitting budget is one declared resource limit, not
//! one silent truncation.
//!
//! The result is development evidence. It selects one candidate and
//! establishes no qualification claim, and it states nothing about the
//! validation data. [`DEVELOPMENT_EVIDENCE_STATEMENT`] states this on every
//! report.

use crate::case::ProjectedInputs;
use crate::dataset::{CaseRecord, SplitPurpose, ValidatedDataset};
use crate::definition::{Check, CheckKind, ValidatedDefinition};
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::hashing;
use crate::intervals::{self, ConfidenceLevel};
use crate::metrics::{self, ConfusionMatrix, MetricName, MetricSet, Rate};
use crate::plan::{
    self, Candidate, Comparison, Direction, LimitBasis, ObjectiveMetric, PlanConstraint,
    PlanObjective, ValidatedPlan,
};
use crate::policy;
use crate::report::{self, AppliedPolicy, Outcome};
use crate::rule;
use crate::splits;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// The named fitting method: the bounded grid search over the permitted
/// candidate family, evaluated with the shared metric definitions.
pub const METHOD: &str = "bounded_grid_search";

/// The largest permitted candidate count of one fitting search.
///
/// One plan grid above this count states more candidates than the fitting
/// budget measures. The search refuses the grid with its count instead of
/// truncating the family, because one silently narrowed search changes the
/// tie-break rule the owner declared.
pub const MAX_FIT_CANDIDATES: usize = 1_024;

/// The largest permitted number of policy decisions of one fitting search:
/// one decision is one candidate replayed over one fitting case.
///
/// The dataset record limit bounds the cases alone. This bound bounds the
/// product, so one wide grid over one large split fails before the search
/// spends its budget.
pub const MAX_FIT_DECISIONS: usize = 1_048_576;

/// The standing statement that every fitting report carries.
pub const DEVELOPMENT_EVIDENCE_STATEMENT: &str = "A fitting result is development evidence from the fitting split alone. It selects one candidate of the permitted family and establishes no qualification claim. Qualification rests on the frozen validation of held-out cases, which this search never reads.";

/// The evidence state of one measured goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "evidence")]
pub enum ConstraintEvidence {
    /// The rate states one denominator that meets the plan minimum.
    Measured,
    /// The rate states no denominator, so no value and no bound exist.
    ZeroDenominator,
    /// The denominator sits below the plan minimum of its own population,
    /// so the plan itself declares the evidence too small for the goal.
    BelowMinimum {
        /// The minimum the plan states for the denominator.
        stated: usize,
        /// The denominator the candidate measured.
        measured: usize,
    },
}

/// One goal of the plan as the fitting measured it on one candidate.
///
/// The row keeps the declared limit beside the measured evidence, so one
/// unmet goal states by how much it failed instead of one bare flag.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ConstraintFit {
    /// The constrained metric of the published set.
    pub metric: MetricName,
    /// The declared direction of the limit.
    pub comparison: Comparison,
    /// The declared limit, unchanged by the search.
    pub limit: f64,
    /// The declared evidence basis.
    pub basis: LimitBasis,
    /// Cases in the numerator of the rate.
    pub numerator: usize,
    /// Cases in the denominator of the rate.
    pub denominator: usize,
    /// The observed rate, or `None` when the denominator holds no case.
    pub observed: Option<f64>,
    /// The Wilson upper bound at the declared confidence level, present when
    /// the basis reads it.
    pub upper_bound: Option<f64>,
    /// Whether the candidate meets the goal on the declared basis.
    pub met: bool,
    /// The evidence state behind the comparison.
    pub evidence: ConstraintEvidence,
}

/// One enumerated candidate with its measured goal rows.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CandidateFit {
    /// The position of the candidate in the declared enumeration order.
    pub index: usize,
    /// The enumerated candidate.
    pub candidate: Candidate,
    /// Whether the candidate meets every declared constraint.
    pub feasible: bool,
    /// The objective metric rate of the complete check set.
    pub objective: Rate,
    /// One row per declared constraint, in written order.
    pub constraints: Vec<ConstraintFit>,
}

/// The selected candidate with its complete measurement.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SelectedFit {
    /// The position of the candidate in the declared enumeration order.
    pub index: usize,
    /// The selected candidate.
    pub candidate: Candidate,
    /// The objective metric rate of the complete check set.
    pub objective: Rate,
    /// One row per declared constraint, in written order.
    pub constraints: Vec<ConstraintFit>,
    /// One metric set per check of the definition, then the complete check
    /// set, in the order of the evaluation contract.
    pub scopes: Vec<MetricSet>,
}

/// Whether the search found one feasible candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FitStatus {
    /// One candidate meets every constraint; the selected one optimizes the
    /// objective and wins ties by enumeration order.
    Feasible,
    /// No candidate of the permitted family meets every constraint.
    NoFeasibleCandidate,
}

impl FitStatus {
    /// Returns the contract word of this status.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Feasible => "feasible",
            Self::NoFeasibleCandidate => "no_feasible_candidate",
        }
    }
}

/// The complete result of one fitting search.
///
/// Every enumerated candidate appears with its goal rows, feasible or not,
/// so one report can explain the selection and every unmet goal from the
/// same data. The validation selection of the plan appears nowhere in this
/// result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FitReport {
    /// Stable plan identifier.
    pub plan_id: String,
    /// Computed identity of the plan in the plan domain.
    pub plan_content_hash: String,
    /// Name of the calibrated definition.
    pub definition_name: String,
    /// Content hash of the calibrated definition.
    pub definition_hash: String,
    /// Dataset of the fitting split.
    pub dataset: String,
    /// Revision of the fitting split.
    pub revision: String,
    /// Fitting split identifier.
    pub split: String,
    /// Computed hash of the fitting split records.
    pub split_content_hash: String,
    /// Groups the fitting split declares, in declared order.
    pub split_groups: Vec<String>,
    /// Fitting cases the search measured.
    pub case_count: usize,
    /// Permitted candidates the search enumerated.
    pub candidate_count: usize,
    /// The fitting method word. Always [`METHOD`].
    pub method: &'static str,
    /// The interval method behind every upper bound. Always
    /// [`intervals::METHOD`].
    pub interval_method: &'static str,
    /// The declared confidence level of the bounds.
    pub confidence_level: f64,
    /// The minimum counts the plan states, by denominator name.
    pub minimum_samples: BTreeMap<String, usize>,
    /// What the fitting optimizes after every constraint holds.
    pub objective: PlanObjective,
    /// Whether one feasible candidate exists.
    pub status: FitStatus,
    /// The selected candidate, or `None` when no candidate is feasible.
    pub selected: Option<SelectedFit>,
    /// Every enumerated candidate in declared order.
    pub candidates: Vec<CandidateFit>,
    /// The standing development-evidence statement. Always
    /// [`DEVELOPMENT_EVIDENCE_STATEMENT`].
    pub statement: &'static str,
}

impl FitReport {
    /// Returns the selected candidate, or `None` when no candidate is
    /// feasible.
    pub fn selected(&self) -> Option<&SelectedFit> {
        self.selected.as_ref()
    }
}

/// Returns the policy that one candidate applies to every question check.
///
/// One candidate of the plan grid states one parameter set of the
/// `probability_mass_v0` family. The profile records the same set for every
/// question check of the calibrated definition.
pub const fn applied_policy(candidate: Candidate) -> AppliedPolicy {
    AppliedPolicy {
        accept_cutoff: candidate.accept_cutoff,
        rejection_cutoff: candidate.rejection_cutoff,
        confidence_floor: candidate.confidence_floor,
    }
}

/// Searches the permitted candidate family on the fitting split.
///
/// `assessments` is one object keyed by case identifier; each entry is one
/// object keyed by question check identifier holding the stored assessment
/// of that check, exactly as the evaluator recorded it. Every fitting case
/// and every question check must state one assessment, one assessment names
/// no other case and no rule check, and each assessment must pass the
/// assessment contract of its check. The stored assessments are replayed
/// under every candidate, so one policy-only search reuses them exactly as
/// MVP_SPEC.md section 8 permits.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `policy_mismatch` when the loaded
/// definition is exact-only, with `definition_mismatch` when the plan binds
/// another definition, with `invalid_field_type` when the offered dataset
/// names no fitting split of the plan selection or one of the wrong
/// purpose, with `hash_mismatch` when one stored split hash differs, with
/// `invalid_field_type` at `/plan/candidate_grid` when the grid or the
/// decision count exceeds the published fitting limits, with
/// `insufficient_evidence` when the fitting split holds no record, with
/// `missing_field`, `unknown_field`, or `invalid_assessment` at
/// `/assessments/<case>/<check>` when one stored assessment breaks its
/// input contract, and with `invalid_field_type` when one rule input breaks
/// its exact rule.
pub fn fit_policy(
    plan: &ValidatedPlan,
    dataset: &ValidatedDataset<'_>,
    assessments: &Value,
) -> Result<FitReport, ValidationError> {
    // The plan binds the definition that validated the offered inputs, so
    // the search reads the same meaning one run reads.
    plan::check_plan_definition(plan, dataset.definition(), "/plan")?;

    let candidates = plan.candidates();
    if candidates.len() > MAX_FIT_CANDIDATES {
        return Err(ValidationError::invalid_field_type(
            "/plan/candidate_grid",
            format!(
                "The permitted candidate count {} exceeds the fitting limit {}. Narrow the grid of the plan.",
                candidates.len(),
                MAX_FIT_CANDIDATES
            ),
        ));
    }

    // The fitting split comes through the plan's own selection, so the
    // search cannot read the validation data of the same dataset.
    let grouped = splits::dataset_splits(dataset.dataset())?;
    let split = plan_split(plan, &grouped, SplitPurpose::Fitting)?;
    let records = split.records();
    if records.is_empty() {
        return Err(ValidationError::new(
            ReasonCode::InsufficientEvidence,
            "/cases",
            "The fitting split holds no record, so no candidate has one denominator.",
        ));
    }
    let decisions = candidates.len().saturating_mul(records.len());
    if decisions > MAX_FIT_DECISIONS {
        return Err(ValidationError::invalid_field_type(
            "/plan/candidate_grid",
            format!(
                "The search states {} policy decisions over {} candidates and {} fitting cases, above the fitting limit {}. Narrow the grid or the fitting split.",
                decisions, candidates.len(), records.len(), MAX_FIT_DECISIONS
            ),
        ));
    }

    let definition = dataset.definition();
    let checks = &definition.as_definition().checks;
    let check_ids: Vec<&str> = checks.iter().map(|check| check.id.as_str()).collect();
    let cases = prepare_cases(
        definition,
        records,
        assessments,
        "fitting",
        "The fitting search",
    )?;
    let objective_name = objective_metric(plan.objective().metric);
    let level = plan.confidence_level();

    let mut fits = Vec::with_capacity(candidates.len());
    let mut best: Option<BestFit> = None;
    for (index, candidate) in candidates.iter().enumerate() {
        let policy = applied_policy(*candidate);
        let mut confusions = vec![ConfusionMatrix::default(); checks.len() + 1];
        for case in &cases {
            let mut outcomes = Vec::with_capacity(checks.len());
            for (slot, answer) in case.answers.iter().enumerate() {
                let outcome = match answer {
                    Answer::Question(value) => {
                        policy::decide(definition, check_ids[slot], value, &policy)
                            .map_err(|error| at(error, &case.path, check_ids[slot]))?
                    }
                    Answer::Rule(outcome) => *outcome,
                };
                outcomes.push(outcome);
                confusions[slot].record(case.references[slot], outcome);
            }
            let aggregate =
                report::aggregate(&outcomes).expect("the definition states one check at least");
            confusions[checks.len()].record(case.overall, metrics::component(aggregate));
        }

        let whole = &confusions[checks.len()];
        let constraints: Vec<ConstraintFit> = plan
            .constraints()
            .iter()
            .map(|constraint| {
                measure_constraint(
                    constraint,
                    whole,
                    level,
                    plan.minimum_of(constraint.denominator()),
                )
            })
            .collect();
        let feasible = constraints.iter().all(|fit| fit.met);
        let objective = metrics::rate_of(objective_name, whole);
        let improves = best.as_ref().is_none_or(|current| {
            strictly_better(plan.objective().direction, &objective, &current.objective)
        });
        if feasible && improves {
            best = Some(BestFit {
                index,
                candidate: *candidate,
                objective,
                constraints: constraints.clone(),
                confusions,
            });
        }
        fits.push(CandidateFit {
            index,
            candidate: *candidate,
            feasible,
            objective,
            constraints,
        });
    }

    let identity = split.identity();
    let selected = best.map(|best| {
        let scopes = metrics::scope_names(&check_ids)
            .into_iter()
            .zip(best.confusions)
            .map(|(scope, confusion)| MetricSet::assemble(scope, confusion))
            .collect();
        SelectedFit {
            index: best.index,
            candidate: best.candidate,
            objective: best.objective,
            constraints: best.constraints,
            scopes,
        }
    });
    let status = match &selected {
        Some(_) => FitStatus::Feasible,
        None => FitStatus::NoFeasibleCandidate,
    };
    Ok(FitReport {
        plan_id: plan.id().to_owned(),
        plan_content_hash: plan.content_hash().to_owned(),
        definition_name: plan.definition_name().to_owned(),
        definition_hash: hashing::definition_hash(definition),
        dataset: identity.dataset_id.clone(),
        revision: identity.revision.clone(),
        split: identity.split_id.clone(),
        split_content_hash: identity.content_hash.clone(),
        split_groups: identity.groups.clone(),
        case_count: records.len(),
        candidate_count: candidates.len(),
        method: METHOD,
        interval_method: intervals::METHOD,
        confidence_level: level.as_f64(),
        minimum_samples: plan.minimum_samples().clone(),
        objective: plan.objective(),
        status,
        selected,
        candidates: fits,
        statement: DEVELOPMENT_EVIDENCE_STATEMENT,
    })
}

/// Searches the permitted candidate family from assessment text.
///
/// # Errors
///
/// Returns the failure of [`crate::json::parse_strict`] for malformed text,
/// otherwise the failure of [`fit_policy`].
pub fn fit_policy_str(
    plan: &ValidatedPlan,
    dataset: &ValidatedDataset<'_>,
    assessments_text: &str,
) -> Result<FitReport, ValidationError> {
    let assessments = crate::json::parse_strict(assessments_text)?;
    fit_policy(plan, dataset, &assessments)
}

/// The leading candidate of the search.
struct BestFit {
    index: usize,
    candidate: Candidate,
    objective: Rate,
    constraints: Vec<ConstraintFit>,
    confusions: Vec<ConfusionMatrix>,
}

/// One measured case with everything the replay reads.
///
/// The fitting search and the frozen validation of
/// [`crate::qualification`] replay the same value, so one case prepares
/// once for both.
pub(crate) struct PreparedCase<'a> {
    /// The path prefix of this case under `/assessments`.
    pub(crate) path: String,
    /// The resolved reference outcome of every defined check.
    pub(crate) references: Vec<Option<Outcome>>,
    /// The resolved overall reference of the record.
    pub(crate) overall: Option<Outcome>,
    /// The answer of every defined check, in definition order.
    pub(crate) answers: Vec<Answer<'a>>,
}

/// One prepared check answer: one stored assessment or one exact rule
/// outcome.
pub(crate) enum Answer<'a> {
    /// The stored assessment of one question check.
    Question(&'a Value),
    /// The outcome of one exact rule, which no policy changes.
    Rule(Outcome),
}

/// Locates one split of a plan selection inside one offered dataset.
///
/// The plan's own selection names the split, so the caller cannot offer one
/// split of the other role: one selection that names another dataset,
/// revision, or absent split fails with its field, and one split of the
/// other purpose fails the purpose check. The fitting search reads its
/// single offered split through here, and the frozen validation of
/// [`crate::qualification`] reads both selections through the same rules,
/// so one selection failure has one wording and one path.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` at
/// `/plan/datasets/<role>/<field>` when the selection names no split of
/// the offered dataset or one of the wrong purpose, and with
/// `hash_mismatch` when one stored split hash differs from the computed
/// digest of the loaded records.
pub(crate) fn plan_split<'data>(
    plan: &ValidatedPlan,
    grouped: &'data splits::DatasetSplits<'_>,
    purpose: SplitPurpose,
) -> Result<&'data splits::SplitData<'data>, ValidationError> {
    let role = purpose.as_str();
    let base = format!("/plan/datasets/{role}");
    let selection = match purpose {
        SplitPurpose::Fitting => &plan.datasets().fitting,
        SplitPurpose::Validation => &plan.datasets().validation,
    };
    let Some(offered) = grouped
        .splits()
        .iter()
        .find(|split| split.identity().split_id == selection.split)
    else {
        let identity = grouped.identity();
        if identity.dataset_id != selection.dataset {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/dataset"),
                format!(
                    "The selection names the dataset {}, but the offered dataset is {}. The {} data comes from the dataset the plan names.",
                    fragment(&selection.dataset),
                    fragment(&identity.dataset_id),
                    role
                ),
            ));
        }
        if identity.revision != selection.revision {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/revision"),
                format!(
                    "The selection names the revision {}, but the offered dataset is revision {}. The {} data comes from the revision the plan names.",
                    fragment(&selection.revision),
                    fragment(&identity.revision),
                    role
                ),
            ));
        }
        return Err(ValidationError::invalid_field_type(
            format!("{base}/split"),
            format!(
                "The selection names the split {}, but the offered dataset declares no split of that identifier.",
                fragment(&selection.split)
            ),
        ));
    };
    plan::check_selection(selection, offered.identity(), purpose, &base)?;
    Ok(offered)
}

/// Prepares every case of one measured split: the reference outcomes, the
/// exact rule outcomes, and the stored assessments.
///
/// `split` names the role the records play, `fitting` or `validation`, and
/// `procedure` names the reader in one message, for example `The fitting
/// search`. The frozen validation of [`crate::qualification`] prepares its
/// validation cases through the same rules, so one broken assessment fails
/// one way at both boundaries.
///
/// # Errors
///
/// Returns a [`ValidationError`] at `/assessments` when the value holds no
/// object keyed by case identifier, `missing_field` at
/// `/assessments/<case>` or `/assessments/<case>/<check>` when one case of
/// the split or one question check states no assessment, `unknown_field`
/// when one assessment names no case of the split or no question check, and
/// the failure of [`crate::assessment::validate_assessment`] with the case
/// and check prefix when one stored assessment breaks its contract.
pub(crate) fn prepare_cases<'a>(
    definition: &ValidatedDefinition,
    records: &[&CaseRecord],
    assessments: &'a Value,
    split: &str,
    procedure: &str,
) -> Result<Vec<PreparedCase<'a>>, ValidationError> {
    let Value::Object(by_case) = assessments else {
        return Err(ValidationError::invalid_field_type(
            "/assessments",
            format!("The {split} assessments must hold one object keyed by case identifier."),
        ));
    };
    let checks = &definition.as_definition().checks;
    let mut cases = Vec::with_capacity(records.len());
    for record in records {
        let path = format!("/assessments/{}", record.id);
        let entry = by_case
            .get(record.id.as_str())
            .ok_or_else(|| ValidationError::missing(path.clone()))?;
        let Value::Object(by_check) = entry else {
            return Err(ValidationError::invalid_field_type(
                path.clone(),
                "The assessments of one case must hold one object keyed by check identifier.",
            ));
        };

        let mut answers = Vec::with_capacity(checks.len());
        for check in checks {
            let check_path = format!("{path}/{}", check.id);
            match definition.check_kind(&check.id) {
                Some(CheckKind::Rule) => {
                    if by_check.contains_key(check.id.as_str()) {
                        return Err(ValidationError::new(
                            ReasonCode::UnknownField,
                            check_path,
                            "One rule check records its executed rule, so it takes no stored assessment.",
                        ));
                    }
                    answers.push(Answer::Rule(rule_outcome(record, check, &check_path)?));
                }
                Some(_) => {
                    let assessment = by_check
                        .get(check.id.as_str())
                        .ok_or_else(|| ValidationError::missing(check_path.clone()))?;
                    crate::assessment::validate_assessment(definition, &check.id, assessment)
                        .map_err(|error| at(error, &path, &check.id))?;
                    answers.push(Answer::Question(assessment));
                }
                None => unreachable!("the definition validated its own checks"),
            }
        }

        let expected = record.expected.as_ref();
        let references: Vec<Option<Outcome>> = checks
            .iter()
            .map(|check| {
                expected.and_then(|labels| {
                    labels.checks.get(&check.id).and_then(|reference| {
                        metrics::reference_outcome(definition, &check.id, reference)
                    })
                })
            })
            .collect();
        let overall =
            expected.and_then(|labels| metrics::overall_reference_outcome(definition, labels));
        cases.push(PreparedCase {
            path,
            references,
            overall,
            answers,
        });
    }

    // One assessment that names no case of the split states measurement of
    // data the procedure never reads, so it fails instead of passing
    // silently.
    for case_id in by_case.keys() {
        if !records.iter().any(|record| record.id == *case_id) {
            return Err(ValidationError::new(
                ReasonCode::UnknownField,
                format!("/assessments/{case_id}"),
                format!(
                    "The assessment names the case {}, which the {split} split does not hold. {procedure} measures the cases of its split alone.",
                    fragment(case_id)
                ),
            ));
        }
    }
    Ok(cases)
}

/// Computes the outcome of one exact rule check of one fitting record.
///
/// # Errors
///
/// Returns a [`ValidationError`] with the failure of [`rule::assess_check`]
/// under the case and check prefix. One dataset validated against this
/// definition states the declared string input, so the failures name one
/// broken caller rather than broken data.
pub(crate) fn rule_outcome(
    record: &CaseRecord,
    check: &Check,
    path: &str,
) -> Result<Outcome, ValidationError> {
    let name = check
        .using
        .first()
        .expect("a rule check reads exactly one input");
    let value = record
        .input
        .get(name)
        .expect("the dataset validated the inputs of this definition");
    let projected = ProjectedInputs {
        check_id: check.id.clone(),
        inputs: std::iter::once((name.clone(), value.clone())).collect(),
    };
    let result = rule::assess_check(check, &projected).map_err(|error| at(error, path, ""))?;
    Ok(match result.outcome {
        rule::RuleOutcome::Pass => Outcome::Pass,
        rule::RuleOutcome::Fail => Outcome::Fail,
    })
}

/// Measures one declared goal on one candidate.
///
/// Evidence comes before arithmetic: one rate without one denominator and
/// one denominator below the plan minimum state no value worth comparing,
/// so the goal stays unmet with its counts, exactly as the contracts README
/// states for the interval rows.
fn measure_constraint(
    constraint: &PlanConstraint,
    confusion: &ConfusionMatrix,
    level: ConfidenceLevel,
    minimum: Option<usize>,
) -> ConstraintFit {
    let rate = metrics::rate_of(constraint.metric, confusion);
    let evidence = if rate.denominator == 0 {
        ConstraintEvidence::ZeroDenominator
    } else if minimum.is_some_and(|stated| rate.denominator < stated) {
        ConstraintEvidence::BelowMinimum {
            stated: minimum.unwrap_or_default(),
            measured: rate.denominator,
        }
    } else {
        ConstraintEvidence::Measured
    };
    let mut upper_bound = None;
    let mut met = false;
    if evidence == ConstraintEvidence::Measured {
        match constraint.basis {
            LimitBasis::UpperConfidenceBound => {
                let (_, upper) =
                    intervals::wilson_interval(rate.numerator, rate.denominator, level)
                        .expect("the denominator holds one case at least");
                met = holds(constraint.comparison, upper, constraint.limit);
                upper_bound = Some(upper);
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
    ConstraintFit {
        metric: constraint.metric,
        comparison: constraint.comparison,
        limit: constraint.limit,
        basis: constraint.basis,
        numerator: rate.numerator,
        denominator: rate.denominator,
        observed: rate.value,
        upper_bound,
        met,
        evidence,
    }
}

/// Returns true when the value meets the limit on the declared direction.
fn holds(comparison: Comparison, value: f64, limit: f64) -> bool {
    match comparison {
        Comparison::AtMost => value <= limit,
        Comparison::AtLeast => value >= limit,
    }
}

/// Returns the metric the objective optimizes at the complete check set.
const fn objective_metric(objective: ObjectiveMetric) -> MetricName {
    match objective {
        ObjectiveMetric::ReviewRate => MetricName::ReviewRate,
        ObjectiveMetric::AutomaticCoverage => MetricName::AutomaticCoverage,
    }
}

/// Returns true when one feasible candidate improves on the incumbent.
///
/// The cross product of the counts compares two rates exactly, so equal
/// counts tie and the earlier candidate of the enumeration order stays.
fn strictly_better(direction: Direction, candidate: &Rate, incumbent: &Rate) -> bool {
    let left = (candidate.numerator as u128) * (incumbent.denominator as u128);
    let right = (incumbent.numerator as u128) * (candidate.denominator as u128);
    match direction {
        Direction::Minimize => left < right,
        Direction::Maximize => left > right,
    }
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
    use crate::dataset::load_dataset;
    use crate::definition::validate_definition_str;
    use serde_json::{json, Map};

    /// One definition with one categorical question and one exact rule, so
    /// the search replays both kinds and the aggregate folds them.
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

    /// One metadata artifact with one fitting and one validation split.
    fn metadata() -> Value {
        json!({
            "schema_version": 1,
            "id": "fitting-cases",
            "revision": "2026-09-24.1",
            "kind": "representative_sample",
            "intended_population": "Proposed messages in support conversations.",
            "sampling_method": "Sampled at random from reviewed traffic.",
            "label_guidelines": "See docs/labeling.md revision 3.",
            "splits": [
                {"id": "fit", "purpose": "fitting", "groups": ["conversation-a"]},
                {"id": "holdout", "purpose": "validation", "groups": ["conversation-b"]}
            ]
        })
    }

    /// One fitting record of one designed case. `label` names the reference
    /// answer of the question check and `rule` names the expected outcome of
    /// the rule check.
    fn record(id: &str, group: &str, label: Option<&str>, rule: Option<&str>) -> Value {
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
        let mut checks = Map::new();
        if let Some(label) = label {
            checks.insert("message-supported".to_owned(), json!({"answer": label}));
        }
        if let Some(rule) = rule {
            checks.insert("message-length".to_owned(), json!({"outcome": rule}));
        }
        if !checks.is_empty() {
            value["expected"] = json!({"checks": checks});
        }
        value
    }

    /// One categorical assessment with its mass on the three answers.
    fn assessment(supported: f64, incomplete: f64, contradicted: f64) -> Value {
        json!({
            "kind": "categorical",
            "label": label_of(supported, incomplete, contradicted),
            "distribution": [
                {"name": "supported", "mass": supported},
                {"name": "incomplete", "mass": incomplete},
                {"name": "contradicted", "mass": contradicted}
            ]
        })
    }

    /// Names the answer with the greatest mass.
    fn label_of(supported: f64, incomplete: f64, contradicted: f64) -> &'static str {
        let mut best = (supported, "supported");
        if incomplete > best.0 {
            best = (incomplete, "incomplete");
        }
        if contradicted > best.0 {
            best = (contradicted, "contradicted");
        }
        best.1
    }

    /// Serializes records into one record file.
    fn file(records: &[Value]) -> String {
        records
            .iter()
            .map(|value| serde_json::to_string(value).expect("serializes"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// One plan artifact over the shared definition.
    fn plan_artifact(
        id: &str,
        accept: &[f64],
        rejection: &[f64],
        constraints: Value,
        minimum_samples: Value,
        objective: Value,
        fitting_split: &str,
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
            "objective": objective,
            "minimum_samples": minimum_samples,
            "candidate_grid": {
                "accept_cutoffs": accept,
                "rejection_cutoffs": rejection
            },
            "evaluator": {"evaluator": "jev-choice", "adapter_version": "0.1.0"},
            "datasets": {
                "fitting": {
                    "dataset": "fitting-cases",
                    "revision": "2026-09-24.1",
                    "split": fitting_split
                },
                "validation": {
                    "dataset": "fitting-cases",
                    "revision": "2026-09-24.1",
                    "split": "holdout"
                }
            }
        })
    }

    /// One review-rate goal, the smallest plan body of the shared tests.
    fn review_goal(limit: f64) -> Value {
        json!([{
            "metric": "review_rate",
            "comparison": "at_most",
            "limit": limit,
            "basis": "observed_value"
        }])
    }

    /// The minimize-review objective of the shared tests.
    fn minimize_review() -> Value {
        json!({"metric": "review_rate", "direction": "minimize"})
    }

    /// The designed fitting cases of the shared tests. Every number is
    /// stated in the test that reads it.
    ///
    /// - `fit-case-1` to `fit-case-4`: reference pass, mass 0.95, 0.92,
    ///   0.85, and 0.75 on `supported`.
    /// - `fit-case-5`: reference fail, mass 0.88 on `supported`, so the
    ///   evaluator is confidently wrong on one fail case.
    /// - `fit-case-6`: reference fail, mass 0.83 on `contradicted`.
    /// - `fit-case-7`: reference review, review-labeled answer.
    /// - `fit-case-8`: reference pass, mass 0.58 on `supported`.
    fn designed_records() -> Vec<Value> {
        vec![
            record(
                "fit-case-1",
                "conversation-a",
                Some("supported"),
                Some("pass"),
            ),
            record(
                "fit-case-2",
                "conversation-a",
                Some("supported"),
                Some("pass"),
            ),
            record(
                "fit-case-3",
                "conversation-a",
                Some("supported"),
                Some("pass"),
            ),
            record(
                "fit-case-4",
                "conversation-a",
                Some("supported"),
                Some("pass"),
            ),
            record(
                "fit-case-5",
                "conversation-a",
                Some("contradicted"),
                Some("pass"),
            ),
            record(
                "fit-case-6",
                "conversation-a",
                Some("contradicted"),
                Some("pass"),
            ),
            record(
                "fit-case-7",
                "conversation-a",
                Some("incomplete"),
                Some("pass"),
            ),
            record(
                "fit-case-8",
                "conversation-a",
                Some("supported"),
                Some("pass"),
            ),
            record(
                "hold-case-1",
                "conversation-b",
                Some("supported"),
                Some("pass"),
            ),
            record(
                "hold-case-2",
                "conversation-b",
                Some("contradicted"),
                Some("pass"),
            ),
        ]
    }

    /// The stored assessments of the designed fitting cases, in the same
    /// order.
    fn designed_assessments() -> Value {
        json!({
            "fit-case-1": {"message-supported": assessment(0.95, 0.03, 0.02)},
            "fit-case-2": {"message-supported": assessment(0.92, 0.04, 0.04)},
            "fit-case-3": {"message-supported": assessment(0.85, 0.10, 0.05)},
            "fit-case-4": {"message-supported": assessment(0.75, 0.15, 0.10)},
            "fit-case-5": {"message-supported": assessment(0.88, 0.07, 0.05)},
            "fit-case-6": {"message-supported": assessment(0.05, 0.12, 0.83)},
            "fit-case-7": {"message-supported": assessment(0.20, 0.60, 0.20)},
            "fit-case-8": {"message-supported": assessment(0.58, 0.22, 0.20)}
        })
    }

    /// Validates one dataset of the shared tests against the definition and
    /// runs one plan over it.
    fn fitted(
        records_text: &str,
        plan_artifact: &Value,
        assessments: &Value,
    ) -> Result<FitReport, ValidationError> {
        let definition = definition();
        let metadata_text = serde_json::to_string(&metadata()).expect("serializes");
        let dataset = load_dataset(&metadata_text, records_text).expect("the dataset loads");
        let validated =
            crate::dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        let plan = plan::validate_plan(plan_artifact).expect("the plan validates");
        fit_policy(&plan, &validated, assessments)
    }

    #[test]
    fn fitting_selects_the_known_feasible_candidate() {
        let plan = plan_artifact(
            "feasible-plan",
            &[0.55, 0.72, 0.85],
            &[0.6, 0.85],
            json!([{
                "metric": "error_among_accepted",
                "comparison": "at_most",
                "limit": 0.25,
                "basis": "observed_value"
            }]),
            json!({"accepted_cases": 4}),
            minimize_review(),
            "fit",
        );
        let report = fitted(&file(&designed_records()), &plan, &designed_assessments())
            .unwrap_or_else(|error| panic!("{error}"));

        // The rule check passes every case, so the aggregate follows the
        // question check: six accepted cases at the first candidate, one
        // wrong among them, and one review from the review-labeled answer.
        assert_eq!(report.status, FitStatus::Feasible);
        assert_eq!(report.candidate_count, 6);
        assert_eq!(report.case_count, 8);
        let selected = report.selected().expect("one feasible candidate");
        assert_eq!(selected.index, 0);
        assert_eq!(selected.candidate.accept_cutoff, 0.55);
        assert_eq!(selected.candidate.rejection_cutoff, 0.6);
        assert_eq!(selected.candidate.confidence_floor, None);
        assert_eq!(selected.objective.metric, MetricName::ReviewRate);
        assert_eq!(
            (selected.objective.numerator, selected.objective.denominator),
            (1, 8)
        );
        let goal = &selected.constraints[0];
        assert_eq!(goal.metric, MetricName::ErrorAmongAccepted);
        assert_eq!((goal.numerator, goal.denominator), (1, 6));
        assert_eq!(goal.observed, Some(1.0 / 6.0));
        assert_eq!(goal.upper_bound, None);
        assert_eq!(goal.evidence, ConstraintEvidence::Measured);
        assert!(goal.met);

        // The selected candidate returns one metric set per check, then the
        // complete check set, exactly as one evaluation states them.
        let scopes: Vec<&str> = selected
            .scopes
            .iter()
            .map(|set| set.scope.as_str())
            .collect();
        assert_eq!(
            scopes,
            ["message-supported", "message-length", "all_checks"]
        );
        let question = &selected.scopes[0];
        assert_eq!(question.counts.pass, 6);
        assert_eq!(question.counts.fail, 1);
        assert_eq!(question.counts.review, 1);
        let rule = &selected.scopes[1];
        assert_eq!(rule.counts.pass, 8);

        // The identities of the search: the plan, the definition, and the
        // fitting split alone.
        assert_eq!(report.plan_id, "feasible-plan");
        assert_eq!(report.plan_content_hash.len(), 64);
        assert_eq!(report.definition_name, "message-supported");
        assert_eq!(report.definition_hash.len(), 64);
        assert_eq!(report.dataset, "fitting-cases");
        assert_eq!(report.split, "fit");
        assert_eq!(report.split_groups, ["conversation-a"]);
        assert_eq!(report.method, METHOD);
        assert_eq!(report.interval_method, intervals::METHOD);
        assert_eq!(report.confidence_level, 0.95);
        assert_eq!(
            report.minimum_samples,
            BTreeMap::from([("accepted_cases".to_owned(), 4)])
        );
        assert_eq!(report.statement, DEVELOPMENT_EVIDENCE_STATEMENT);

        // Every enumerated candidate appears with its goal row, feasible or
        // not, and the limit stays as the owner declared it.
        assert_eq!(report.candidates.len(), 6);
        for fit in &report.candidates {
            assert_eq!(fit.constraints.len(), 1);
            assert_eq!(fit.constraints[0].limit, 0.25);
            assert_eq!(fit.constraints[0].basis, LimitBasis::ObservedValue);
        }
        // The candidates of the 0.85 acceptance cutoff accept four cases
        // with one wrong among them: an observed 0.25 meets 0.25 exactly.
        assert!(report.candidates[4].feasible, "{:?}", report.candidates[4]);
        assert_eq!(
            (
                report.candidates[4].constraints[0].numerator,
                report.candidates[4].constraints[0].denominator
            ),
            (1, 4)
        );
        assert_eq!(report.candidates[4].constraints[0].observed, Some(0.25));
    }

    #[test]
    fn equal_objectives_tie_to_the_first_candidate_in_order() {
        let plan = plan_artifact(
            "tie-plan",
            &[0.55, 0.58, 0.72],
            &[0.6],
            json!([{
                "metric": "error_among_accepted",
                "comparison": "at_most",
                "limit": 0.25,
                "basis": "observed_value"
            }]),
            json!({"accepted_cases": 4}),
            minimize_review(),
            "fit",
        );
        let report = fitted(&file(&designed_records()), &plan, &designed_assessments())
            .unwrap_or_else(|error| panic!("{error}"));

        // The 0.55 and 0.58 cutoffs decide the same outcomes: case 8 states
        // 0.58 acceptable mass, so both pass it. Both candidates state the
        // same counts, tie, and the first in the declared order wins.
        let first = &report.candidates[0];
        let second = &report.candidates[1];
        assert!(first.feasible && second.feasible);
        assert_eq!(first.objective, second.objective);
        assert_eq!(
            (first.objective.numerator, first.objective.denominator),
            (1, 8)
        );
        let selected = report.selected().expect("one feasible candidate");
        assert_eq!(selected.index, 0);
        assert_eq!(selected.candidate.accept_cutoff, 0.55);

        // The 0.72 cutoff reviews case 8, so it loses on the objective
        // alone: one more review over the same denominator.
        let third = &report.candidates[2];
        assert!(third.feasible);
        assert_eq!(
            (third.objective.numerator, third.objective.denominator),
            (2, 8)
        );
    }

    #[test]
    fn conflicting_goals_leave_no_feasible_candidate() {
        let plan = plan_artifact(
            "conflicting-goals-plan",
            &[0.55, 0.72, 0.92],
            &[0.6],
            json!([
                {
                    "metric": "error_among_accepted",
                    "comparison": "at_most",
                    "limit": 0.0,
                    "basis": "observed_value"
                },
                {
                    "metric": "automatic_coverage",
                    "comparison": "at_least",
                    "limit": 0.75,
                    "basis": "observed_value"
                }
            ]),
            json!({"accepted_cases": 2}),
            minimize_review(),
            "fit",
        );
        let report = fitted(&file(&designed_records()), &plan, &designed_assessments())
            .unwrap_or_else(|error| panic!("{error}"));

        // Each goal alone is met inside the grid, never together: the 0.92
        // cutoff keeps the wrong case out but reviews too much, and the two
        // lower cutoffs cover enough cases but accept the wrong one.
        assert_eq!(report.status, FitStatus::NoFeasibleCandidate);
        assert!(report.selected().is_none());
        assert_eq!(report.candidates.len(), 3);
        let unmet: Vec<Vec<bool>> = report
            .candidates
            .iter()
            .map(|fit| fit.constraints.iter().map(|row| row.met).collect())
            .collect();
        assert_eq!(
            unmet,
            [[false, true], [false, true], [true, false]],
            "{unmet:?}"
        );

        // The unmet rows keep the measured counts beside the declared
        // limits, so the owner sees by how much each goal failed.
        let first_goal = &report.candidates[0].constraints[0];
        assert_eq!((first_goal.numerator, first_goal.denominator), (1, 6));
        assert_eq!(first_goal.observed, Some(1.0 / 6.0));
        assert_eq!(first_goal.limit, 0.0);
        let second_goal = &report.candidates[2].constraints[1];
        assert_eq!(
            (second_goal.numerator, second_goal.denominator),
            (3, 8),
            "the 0.92 cutoff decides three of eight cases"
        );
        assert_eq!(second_goal.limit, 0.75);
    }

    #[test]
    fn one_unachievable_goal_is_a_result_not_a_failure() {
        let plan = plan_artifact(
            "no-review-plan",
            &[0.55],
            &[0.6],
            review_goal(0.0),
            json!({"evaluated_cases": 8}),
            json!({"metric": "automatic_coverage", "direction": "maximize"}),
            "fit",
        );
        let report = fitted(&file(&designed_records()), &plan, &designed_assessments())
            .unwrap_or_else(|error| panic!("{error}"));

        // The review-labeled answer reviews at every cutoff, so no candidate
        // reaches one zero review rate. The result states the fact and
        // weakens no goal: the limit stays 0.0 and the counts stay visible.
        assert_eq!(report.status, FitStatus::NoFeasibleCandidate);
        assert!(report.selected().is_none());
        let only = &report.candidates[0];
        assert!(!only.feasible);
        assert_eq!(only.constraints[0].limit, 0.0);
        assert_eq!(
            (
                only.constraints[0].numerator,
                only.constraints[0].denominator
            ),
            (1, 8)
        );
        assert_eq!(only.objective.metric, MetricName::AutomaticCoverage);
        assert_eq!(
            (only.objective.numerator, only.objective.denominator),
            (7, 8)
        );
    }

    #[test]
    fn the_plan_minimum_gates_every_goal() {
        let plan = plan_artifact(
            "evidence-floor-plan",
            &[0.55, 0.72],
            &[0.6],
            json!([{
                "metric": "error_among_accepted",
                "comparison": "at_most",
                "limit": 0.5,
                "basis": "observed_value"
            }]),
            json!({"accepted_cases": 6}),
            minimize_review(),
            "fit",
        );
        let report = fitted(&file(&designed_records()), &plan, &designed_assessments())
            .unwrap_or_else(|error| panic!("{error}"));

        // The first candidate accepts six cases and meets its minimum. The
        // second accepts five, so the plan itself declares the evidence too
        // small and the goal stays unmet without one comparison.
        let first = &report.candidates[0];
        assert!(first.feasible);
        assert_eq!(first.constraints[0].evidence, ConstraintEvidence::Measured);
        let second = &report.candidates[1];
        assert!(!second.feasible);
        assert_eq!(
            second.constraints[0].evidence,
            ConstraintEvidence::BelowMinimum {
                stated: 6,
                measured: 5
            }
        );
        assert_eq!(second.constraints[0].observed, Some(0.2));

        // One candidate that predicts no pass at all leaves the goal without
        // one denominator, and the row states the fact.
        let empty = plan_artifact(
            "empty-population-plan",
            &[0.99],
            &[0.6],
            json!([{
                "metric": "error_among_accepted",
                "comparison": "at_most",
                "limit": 0.5,
                "basis": "observed_value"
            }]),
            json!({"accepted_cases": 1}),
            minimize_review(),
            "fit",
        );
        let report = fitted(&file(&designed_records()), &empty, &designed_assessments())
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, FitStatus::NoFeasibleCandidate);
        assert_eq!(
            report.candidates[0].constraints[0].evidence,
            ConstraintEvidence::ZeroDenominator
        );
        assert!(!report.candidates[0].constraints[0].met);
        assert_eq!(report.candidates[0].constraints[0].observed, None);
    }

    #[test]
    fn the_upper_bound_basis_reads_the_wilson_bound() {
        let constraints = json!([{
            "metric": "error_among_accepted",
            "comparison": "at_most",
            "limit": 0.6,
            "basis": "upper_confidence_bound"
        }]);
        let plan = plan_artifact(
            "bound-plan",
            &[0.55],
            &[0.6],
            constraints,
            json!({"accepted_cases": 6}),
            minimize_review(),
            "fit",
        );
        let report = fitted(&file(&designed_records()), &plan, &designed_assessments())
            .unwrap_or_else(|error| panic!("{error}"));

        // One observed error over six accepted cases: the observed rate
        // meets the limit easily, and the bound of the same counts decides
        // the goal. The bound comes from the shared interval routine at the
        // declared level, and it stays above the observed rate.
        let selected = report.selected().expect("the bound meets the limit");
        let goal = &selected.constraints[0];
        assert!(goal.met);
        assert_eq!(goal.observed, Some(1.0 / 6.0));
        let (_, upper) =
            intervals::wilson_interval(1, 6, ConfidenceLevel::NinetyFive).expect("computes");
        assert_eq!(goal.upper_bound, Some(upper));
        assert!(upper > 1.0 / 6.0);
        assert_eq!(report.interval_method, "wilson_score");

        // One tighter limit fails the same counts on the bound alone,
        // although the observed rate meets it: small evidence is not zero
        // risk.
        let tight = plan_artifact(
            "tight-bound-plan",
            &[0.55],
            &[0.6],
            json!([{
                "metric": "error_among_accepted",
                "comparison": "at_most",
                "limit": 0.5,
                "basis": "upper_confidence_bound"
            }]),
            json!({"accepted_cases": 6}),
            minimize_review(),
            "fit",
        );
        let report = fitted(&file(&designed_records()), &tight, &designed_assessments())
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, FitStatus::NoFeasibleCandidate);
        let goal = &report.candidates[0].constraints[0];
        assert!(!goal.met);
        assert_eq!(goal.observed, Some(1.0 / 6.0));
        assert_eq!(goal.upper_bound, Some(upper));
    }

    #[test]
    fn validation_data_stays_outside_the_fitting_search() {
        // One plan that names the validation split as its fitting data. The
        // validation selection moves to the fitting split, so the plan
        // itself stays valid.
        let mut swapped = plan_artifact(
            "swapped-plan",
            &[0.55],
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "holdout",
        );
        swapped["datasets"]["validation"]["split"] = json!("fit");
        let error = fitted(&file(&designed_records()), &swapped, &json!({}))
            .expect_err("the validation split is no fitting data");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/plan/datasets/fitting/split", "{error}");

        // One plan whose fitting selection names one absent split.
        let absent = plan_artifact(
            "absent-plan",
            &[0.55],
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "absent",
        );
        let error = fitted(&file(&designed_records()), &absent, &json!({}))
            .expect_err("the split names no declared split");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/plan/datasets/fitting/split", "{error}");

        // One plan that names another dataset revision.
        let mut foreign = plan_artifact(
            "foreign-plan",
            &[0.55],
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "fit",
        );
        foreign["datasets"]["fitting"]["revision"] = json!("2026-09-24.2");
        let error = fitted(&file(&designed_records()), &foreign, &json!({}))
            .expect_err("the revision names other content");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(
            error.field_path, "/plan/datasets/fitting/revision",
            "{error}"
        );

        // One assessment set that names one holdout case never enters the
        // search, not even as extra data.
        let mut with_holdout = designed_assessments();
        with_holdout["hold-case-1"] = json!({"message-supported": assessment(0.9, 0.05, 0.05)});
        let plan = plan_artifact(
            "feasible-plan",
            &[0.55],
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "fit",
        );
        let error = fitted(&file(&designed_records()), &plan, &with_holdout)
            .expect_err("the holdout case is no fitting case");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/assessments/hold-case-1", "{error}");
    }

    #[test]
    fn stored_assessments_report_their_case_and_check_paths() {
        let plan = plan_artifact(
            "feasible-plan",
            &[0.55],
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "fit",
        );

        // One omitted case.
        let mut missing_case = designed_assessments();
        missing_case
            .as_object_mut()
            .expect("an object")
            .remove("fit-case-8");
        let error = fitted(&file(&designed_records()), &plan, &missing_case)
            .expect_err("the case states no assessment");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/assessments/fit-case-8", "{error}");

        // One omitted check of one stated case.
        let mut missing_check = designed_assessments();
        missing_check["fit-case-8"]
            .as_object_mut()
            .expect("an object")
            .remove("message-supported");
        let error = fitted(&file(&designed_records()), &plan, &missing_check)
            .expect_err("the check states no assessment");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(
            error.field_path, "/assessments/fit-case-8/message-supported",
            "{error}"
        );

        // One assessment for the exact rule of the definition.
        let mut with_rule = designed_assessments();
        with_rule["fit-case-8"]["message-length"] = json!({"outcome": "pass"});
        let error = fitted(&file(&designed_records()), &plan, &with_rule)
            .expect_err("one rule check takes no assessment");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(
            error.field_path, "/assessments/fit-case-8/message-length",
            "{error}"
        );

        // One assessment that names no declared answer of its check.
        let mut broken = designed_assessments();
        broken["fit-case-8"]["message-supported"]["label"] = json!("unsupported-answer");
        let error = fitted(&file(&designed_records()), &plan, &broken)
            .expect_err("the label names no declared answer");
        assert_eq!(error.code, ReasonCode::InvalidAssessment, "{error}");
        assert_eq!(
            error.field_path, "/assessments/fit-case-8/message-supported/assessment/label",
            "{error}"
        );

        // One value that holds no assessment object at all.
        let error = fitted(&file(&designed_records()), &plan, &json!([]))
            .expect_err("the assessments hold no object");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/assessments", "{error}");
    }

    #[test]
    fn the_fitting_budget_fails_explicitly() {
        // One grid above the candidate limit: 1025 distinct cutoffs above
        // 0.5 and at most 1.
        let oversized: Vec<f64> = (1..=MAX_FIT_CANDIDATES + 1)
            .map(|step| 0.5 + (step as f64) / 2050.0)
            .collect();
        assert_eq!(oversized.len(), MAX_FIT_CANDIDATES + 1);
        assert!(*oversized.last().expect("one value") <= 1.0);
        let plan = plan_artifact(
            "oversized-plan",
            &oversized,
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "fit",
        );
        let error = fitted(&file(&designed_records()), &plan, &designed_assessments())
            .expect_err("the grid exceeds the candidate limit");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/plan/candidate_grid", "{error}");
        assert!(
            error.message.contains("1025"),
            "the cause names the count: {error}"
        );

        // One search above the decision limit: one full-permitted grid over
        // one fitting split of 1025 cases. The failure states the counts
        // and refuses to run, so the assessments never matter.
        let full: Vec<f64> = (1..=MAX_FIT_CANDIDATES)
            .map(|step| 0.5 + (step as f64) / 2050.0)
            .collect();
        assert_eq!(full.len(), MAX_FIT_CANDIDATES);
        let mut many = designed_records();
        let bulk: Vec<Value> = (0..1_017)
            .map(|index| {
                record(
                    &format!("bulk-case-{index}"),
                    "conversation-c",
                    Some("supported"),
                    Some("pass"),
                )
            })
            .collect();
        many.extend(bulk);
        let mut bulk_metadata = metadata();
        bulk_metadata["splits"][0]["groups"] = json!(["conversation-a", "conversation-c"]);
        let definition = definition();
        let metadata_text = serde_json::to_string(&bulk_metadata).expect("serializes");
        let dataset = load_dataset(&metadata_text, &file(&many)).expect("the dataset loads");
        let validated =
            crate::dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        let plan = plan::validate_plan(&plan_artifact(
            "bulk-plan",
            &full,
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "fit",
        ))
        .expect("the plan validates");
        let error = fit_policy(&plan, &validated, &json!({}))
            .expect_err("the search exceeds the decision limit");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/plan/candidate_grid", "{error}");
        assert!(
            error.message.contains("policy decisions"),
            "the cause names the budget: {error}"
        );
    }

    #[test]
    fn an_empty_fitting_split_states_insufficient_evidence() {
        let mut empty_metadata = metadata();
        empty_metadata["splits"][0]["groups"] = json!(["absent-group"]);
        let definition = definition();
        let metadata_text = serde_json::to_string(&empty_metadata).expect("serializes");
        let dataset =
            load_dataset(&metadata_text, &file(&designed_records())).expect("the dataset loads");
        let validated =
            crate::dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        let plan = plan::validate_plan(&plan_artifact(
            "empty-plan",
            &[0.55],
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "fit",
        ))
        .expect("the plan validates");
        let error =
            fit_policy(&plan, &validated, &json!({})).expect_err("the split holds no record");
        assert_eq!(error.code, ReasonCode::InsufficientEvidence, "{error}");
        assert_eq!(error.field_path, "/cases", "{error}");
    }

    #[test]
    fn fitting_binds_the_plan_to_the_loaded_definition() {
        // One plan that binds the hash of another revision of the
        // definition, so the pairing changes the measured meaning.
        let mut foreign = plan_artifact(
            "foreign-definition-plan",
            &[0.55],
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "fit",
        );
        foreign["definition"]["content_hash"] =
            json!("88c86b66dd45adbd34e4a409dd3a37a2cbe6f94990fefb35c7f0d97dcaf94970");
        let error = fitted(
            &file(&designed_records()),
            &foreign,
            &designed_assessments(),
        )
        .expect_err("the plan binds another definition");
        assert_eq!(error.code, ReasonCode::DefinitionMismatch, "{error}");
        assert_eq!(error.field_path, "/plan/definition", "{error}");

        // One exact-only definition holds no measured error source.
        let exact = json!({
            "schema_version": 1,
            "name": "delivery-limits",
            "inputs": {
                "type": "object",
                "properties": {"text": {"type": "string", "minLength": 1}},
                "required": ["text"],
                "additionalProperties": false
            },
            "checks": [
                {
                    "id": "text-length",
                    "name": "The text fits the limit",
                    "using": ["text"],
                    "rule": {"maxLength": 10}
                }
            ]
        });
        let exact = validate_definition_str(&exact.to_string()).expect("the definition validates");
        let mut exact_plan = plan_artifact(
            "exact-plan",
            &[0.55],
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "fit",
        );
        exact_plan["definition"]["name"] = json!("delivery-limits");
        exact_plan["definition"]["content_hash"] = json!(hashing::definition_hash(&exact));
        let plan = plan::validate_plan(&exact_plan).expect("the plan validates");
        let records = file(&[json!({
            "id": "limit-case-1",
            "group": "conversation-a",
            "input": {"text": "short"},
            "label": {"author_type": "model", "origin": "synthetic", "reviewed": false}
        })]);
        let metadata_text = serde_json::to_string(&metadata()).expect("serializes");
        let dataset = load_dataset(&metadata_text, &records).expect("the dataset loads");
        let validated =
            crate::dataset::validate_dataset(&dataset, &exact).expect("the dataset validates");
        let error = fit_policy(&plan, &validated, &json!({}))
            .expect_err("one exact-only definition takes no plan");
        assert_eq!(error.code, ReasonCode::PolicyMismatch, "{error}");
        assert_eq!(error.field_path, "/plan/candidate_grid", "{error}");
    }

    #[test]
    fn unlabeled_cases_count_the_coverage_denominators() {
        // Half the fitting split states no reference. The review and
        // coverage rates count every case, the error metrics count the
        // labeled ones alone, and the label coverage states the share.
        let records = file(&[
            record(
                "fit-case-1",
                "conversation-a",
                Some("supported"),
                Some("pass"),
            ),
            record("fit-case-2", "conversation-a", None, None),
            record(
                "hold-case-1",
                "conversation-b",
                Some("supported"),
                Some("pass"),
            ),
        ]);
        let plan = plan_artifact(
            "partial-labels-plan",
            &[0.55],
            &[0.6],
            json!([{
                "metric": "error_among_accepted",
                "comparison": "at_most",
                "limit": 0.5,
                "basis": "observed_value"
            }]),
            json!({"accepted_cases": 1}),
            minimize_review(),
            "fit",
        );
        let assessments = json!({
            "fit-case-1": {"message-supported": assessment(0.9, 0.05, 0.05)},
            "fit-case-2": {"message-supported": assessment(0.55, 0.25, 0.20)}
        });
        let report =
            fitted(&records, &plan, &assessments).unwrap_or_else(|error| panic!("{error}"));
        let selected = report.selected().expect("both cases pass");
        assert_eq!(
            (selected.objective.numerator, selected.objective.denominator),
            (0, 2)
        );
        // One labeled predicted pass alone carries the error denominator.
        let goal = &selected.constraints[0];
        assert_eq!((goal.numerator, goal.denominator), (0, 1));
        let whole = &selected.scopes[2];
        assert_eq!(whole.rate(MetricName::LabelCoverage).value, Some(0.5));
    }

    #[test]
    fn fitting_reads_assessment_text_through_the_strict_gate() {
        let plan = plan_artifact(
            "feasible-plan",
            &[0.55],
            &[0.6],
            review_goal(0.5),
            json!({"evaluated_cases": 1}),
            minimize_review(),
            "fit",
        );
        let definition = definition();
        let metadata_text = serde_json::to_string(&metadata()).expect("serializes");
        let dataset =
            load_dataset(&metadata_text, &file(&designed_records())).expect("the dataset loads");
        let validated =
            crate::dataset::validate_dataset(&dataset, &definition).expect("the dataset validates");
        let validated_plan = plan::validate_plan(&plan).expect("the plan validates");
        let text = serde_json::to_string(&designed_assessments()).expect("serializes");
        let report = fit_policy_str(&validated_plan, &validated, &text)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.status, FitStatus::Feasible);

        // Malformed text fails at the gate before any case is read.
        let error = fit_policy_str(&validated_plan, &validated, "{\"fit-case-1\": ")
            .expect_err("malformed text");
        assert_eq!(error.code, ReasonCode::InvalidJson, "{error}");
    }
}
