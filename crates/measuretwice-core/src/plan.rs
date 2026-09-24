// SPDX-License-Identifier: Apache-2.0
//! The versioned calibration plan contract.
//!
//! A calibration plan declares the goals of one owner, the data procedure
//! that measures them, and the candidate family the search may use. The plan
//! carries no universal default tolerance, as MVP_SPEC.md section 7 states:
//! the owner states what errors matter and how much review is tolerable, and
//! [`validate_plan`] refuses every plan that states its goal set partly.
//!
//! This module is the one authority for the artifact. It covers the schema
//! file and the cross-field rules that the contracts README states:
//!
//! - Both cutoff families of `candidate_grid` exceed 0.5 for every value and
//!   stay at or below 1, so one assessment cannot pass and fail together.
//! - The fitting and the validation selection name different splits. The
//!   complete separation, no shared group and no shared case, is checked
//!   against the loaded split identities by [`check_plan_datasets`].
//! - Every constraint names one metric of the published set, so it names its
//!   denominator exactly. A plan that constrains one error metric states the
//!   minimum sample count of that denominator.
//! - The false acceptance rate and the error among accepted cases stay two
//!   metrics. One constraint names one of them, never one shared "error
//!   rate", and one metric appears in one constraint alone.
//! - The evaluator configuration is complete, and [`check_plan_evaluator`]
//!   compares it with the registered evaluators of the host.
//! - One stored `content_hash` equals the computed self-hash of the plan
//!   domain. One edited or corrupted copy fails with `hash_mismatch`.
//!
//! The plan also fixes the enumeration order of its candidate family, which
//! the fitting task searches: the accept dimension is the outer loop, the
//! rejection dimension is the inner loop, and the confidence floor is the
//! innermost dimension with no floor first. The first candidate that meets
//! every constraint and optimizes the objective wins one tie, so one plan
//! states its tie-break rule through array order alone.
//!
//! The module measures nothing. No plan states one observed rate, and no
//! validation here qualifies one candidate. The fitting, the frozen
//! validation, and the candidate profile belong to later tasks.

use crate::artifact::{expect_object, reject_unknown_fields, schema_version};
use crate::dataset::SplitPurpose;
use crate::definition::{is_artifact_id, parse_bounded_string, ValidatedDefinition};
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::hashing::{self, Domain};
use crate::intervals::ConfidenceLevel;
use crate::metrics::{self, MetricName};
use crate::splits::{self, SplitIdentity};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Fields of one plan artifact, from the schema file.
const PLAN_FIELDS: &[&str] = &[
    "schema_version",
    "id",
    "name",
    "definition",
    "intended_population",
    "sampling_assumptions",
    "confidence_level",
    "constraints",
    "objective",
    "minimum_samples",
    "important_slices",
    "candidate_grid",
    "evaluator",
    "datasets",
    "content_hash",
];

/// Fields of one constraint, from the schema file.
const CONSTRAINT_FIELDS: &[&str] = &["metric", "comparison", "limit", "basis"];

/// Fields of one objective, from the schema file.
const OBJECTIVE_FIELDS: &[&str] = &["metric", "direction"];

/// Fields of one important slice, from the schema file.
const SLICE_FIELDS: &[&str] = &["tag", "minimum_samples"];

/// Fields of one candidate grid, from the schema file.
const GRID_FIELDS: &[&str] = &["accept_cutoffs", "rejection_cutoffs", "confidence_floors"];

/// Fields of one evaluator configuration, from the schema file.
const EVALUATOR_FIELDS: &[&str] = &[
    "evaluator",
    "adapter_version",
    "translation_hash",
    "model_requested",
];

/// Fields of one dataset selection object, from the schema file.
const DATASETS_FIELDS: &[&str] = &["fitting", "validation"];

/// Fields of one dataset selection, from the schema file.
const SELECTION_FIELDS: &[&str] = &["dataset", "revision", "split", "content_hash"];

/// The direction of one constraint limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Comparison {
    /// The measured quantity stays at or below the limit. Error and review
    /// metrics use this direction.
    AtMost,
    /// The measured quantity stays at or above the limit. Coverage metrics
    /// use this direction.
    AtLeast,
}

impl Comparison {
    /// Returns the contract word of this direction.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AtMost => "at_most",
            Self::AtLeast => "at_least",
        }
    }

    /// Returns the direction of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "at_most" => Some(Self::AtMost),
            "at_least" => Some(Self::AtLeast),
            _ => None,
        }
    }
}

/// The evidence one constraint compares with its limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitBasis {
    /// The interval upper bound of the rate. Zero observed errors still
    /// bound one risk above zero, so this basis is the stricter one.
    UpperConfidenceBound,
    /// The observed rate alone. The owner states this basis knowingly.
    ObservedValue,
}

impl LimitBasis {
    /// Returns the contract word of this basis.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UpperConfidenceBound => "upper_confidence_bound",
            Self::ObservedValue => "observed_value",
        }
    }

    /// Returns the basis of one contract word, or `None` for any other text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "upper_confidence_bound" => Some(Self::UpperConfidenceBound),
            "observed_value" => Some(Self::ObservedValue),
            _ => None,
        }
    }
}

/// One metric the objective optimizes after every constraint holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectiveMetric {
    /// The share of cases that need one human decision.
    ReviewRate,
    /// The share of cases the policy decides without review.
    AutomaticCoverage,
}

impl ObjectiveMetric {
    /// Returns the contract word of this metric.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReviewRate => "review_rate",
            Self::AutomaticCoverage => "automatic_coverage",
        }
    }

    /// Returns the metric of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "review_rate" => Some(Self::ReviewRate),
            "automatic_coverage" => Some(Self::AutomaticCoverage),
            _ => None,
        }
    }

    /// Returns the direction that improves this metric: one plan minimizes
    /// the review rate and maximizes the automatic coverage. Every other
    /// pairing works against the owner goal, so the plan refuses it.
    pub const fn improving_direction(self) -> Direction {
        match self {
            Self::ReviewRate => Direction::Minimize,
            Self::AutomaticCoverage => Direction::Maximize,
        }
    }
}

/// The direction the objective optimizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// Smaller is better.
    Minimize,
    /// Larger is better.
    Maximize,
}

impl Direction {
    /// Returns the contract word of this direction.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Minimize => "minimize",
            Self::Maximize => "maximize",
        }
    }

    /// Returns the direction of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "minimize" => Some(Self::Minimize),
            "maximize" => Some(Self::Maximize),
            _ => None,
        }
    }
}

/// One goal a candidate must satisfy.
///
/// The metric names the denominator exactly, because every metric of the
/// published set carries its own denominator. The limit stays inside `[0, 1]`,
/// and the basis states whether the comparison reads the observed rate or the
/// upper bound of its interval.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanConstraint {
    /// The constrained metric of the published set.
    pub metric: MetricName,
    /// The direction of the limit.
    pub comparison: Comparison,
    /// The limit of the measured quantity.
    pub limit: f64,
    /// The evidence the comparison reads.
    pub basis: LimitBasis,
}

impl PlanConstraint {
    /// Returns the denominator name of this constraint, the one of its
    /// metric.
    pub fn denominator(&self) -> &'static str {
        self.metric.denominator()
    }
}

/// What the fitting optimizes after every constraint holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct PlanObjective {
    /// The metric of the objective.
    pub metric: ObjectiveMetric,
    /// The direction of the optimization.
    pub direction: Direction,
}

/// One case tag that must meet its own evidence requirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportantSlice {
    /// The case tag of the slice.
    pub tag: String,
    /// The minimum counts of the slice, by denominator name.
    pub minimum_samples: BTreeMap<String, usize>,
}

/// The permitted candidate family of one calibration.
///
/// Both cutoff families stay above 0.5 and at or below 1. The array order is
/// the enumeration order, so it fixes the tie-break rule of the search.
#[derive(Debug, Clone, PartialEq)]
pub struct CandidateGrid {
    /// The permitted acceptance cutoffs, in enumeration order.
    pub accept_cutoffs: Vec<f64>,
    /// The permitted rejection cutoffs, in enumeration order.
    pub rejection_cutoffs: Vec<f64>,
    /// The permitted confidence floors, in enumeration order. One empty list
    /// permits no abstention.
    pub confidence_floors: Vec<f64>,
}

/// One candidate of the permitted family, in enumeration order.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Candidate {
    /// The acceptance cutoff.
    pub accept_cutoff: f64,
    /// The rejection cutoff.
    pub rejection_cutoff: f64,
    /// The confidence floor, or `None` when the candidate abstains nowhere.
    pub confidence_floor: Option<f64>,
}

/// The evaluator configuration one plan measures with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvaluatorConfiguration {
    /// The registered evaluator identifier.
    pub evaluator: String,
    /// The adapter version of the measurement.
    pub adapter_version: String,
    /// The content hash of the translated questions, when the plan freezes
    /// one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation_hash: Option<String>,
    /// The model identifier the plan requests, one versioned identifier or
    /// one alias.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_requested: Option<String>,
}

/// One dataset selection of a plan: the split of one dataset revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatasetSelection {
    /// Stable dataset identifier.
    pub dataset: String,
    /// Dataset revision.
    pub revision: String,
    /// Stable split identifier.
    pub split: String,
    /// The content hash of the canonical split content, when the plan states
    /// one.
    pub content_hash: Option<String>,
}

impl DatasetSelection {
    /// Returns the readable reference of this selection.
    pub fn reference(&self) -> String {
        format!(
            "{} revision {} split {}",
            self.dataset, self.revision, self.split
        )
    }
}

/// The fitting and the validation data of one plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanDatasets {
    /// The data the search uses.
    pub fitting: DatasetSelection,
    /// The data the frozen validation uses.
    pub validation: DatasetSelection,
}

/// One plan artifact that passed the complete contract check.
///
/// The value states that the artifact holds no contract violation and that
/// one stored self-hash, when the artifact states one, covers its content.
/// The authored artifact stays unchanged inside it.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedPlan {
    /// The artifact, as authored and hashed.
    artifact: Value,
    /// Stable plan identifier.
    id: String,
    /// Readable plan name, when the plan states one.
    name: Option<String>,
    /// The name of the calibrated definition.
    definition_name: String,
    /// The content hash of the calibrated definition.
    definition_hash: String,
    /// The declared population of the qualification claim.
    intended_population: String,
    /// The declared grouping strategy and independence assumptions.
    sampling_assumptions: String,
    /// The declared confidence level of the uncertainty intervals.
    confidence_level: ConfidenceLevel,
    /// The goals a candidate must satisfy, in written order.
    constraints: Vec<PlanConstraint>,
    /// What the fitting optimizes after every constraint holds.
    objective: PlanObjective,
    /// The minimum counts by denominator name.
    minimum_samples: BTreeMap<String, usize>,
    /// The slices the plan checks separately, in written order.
    important_slices: Vec<ImportantSlice>,
    /// The permitted candidate family.
    grid: CandidateGrid,
    /// The evaluator configuration of every measurement of this plan.
    evaluator: EvaluatorConfiguration,
    /// The fitting and the validation selections.
    datasets: PlanDatasets,
    /// The stored self-hash, when the artifact states one.
    stored_content_hash: Option<String>,
    /// The computed identity of the artifact in the plan domain.
    content_hash: String,
}

impl ValidatedPlan {
    /// Returns the artifact, unchanged.
    pub fn as_artifact(&self) -> &Value {
        &self.artifact
    }

    /// Returns the stable plan identifier.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Returns the readable plan name, when the plan states one.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// Returns the name of the calibrated definition.
    pub fn definition_name(&self) -> &str {
        &self.definition_name
    }

    /// Returns the content hash of the calibrated definition.
    pub fn definition_hash(&self) -> &str {
        &self.definition_hash
    }

    /// Returns the declared population of the qualification claim.
    pub fn intended_population(&self) -> &str {
        &self.intended_population
    }

    /// Returns the declared grouping strategy and independence assumptions.
    pub fn sampling_assumptions(&self) -> &str {
        &self.sampling_assumptions
    }

    /// Returns the declared confidence level of the uncertainty intervals.
    pub fn confidence_level(&self) -> ConfidenceLevel {
        self.confidence_level
    }

    /// Returns every goal a candidate must satisfy, in written order.
    pub fn constraints(&self) -> &[PlanConstraint] {
        &self.constraints
    }

    /// Returns what the fitting optimizes after every constraint holds.
    pub fn objective(&self) -> PlanObjective {
        self.objective
    }

    /// Returns the minimum counts by denominator name.
    pub fn minimum_samples(&self) -> &BTreeMap<String, usize> {
        &self.minimum_samples
    }

    /// Returns the minimum count of one denominator name, or `None` when the
    /// plan states none.
    pub fn minimum_of(&self, denominator: &str) -> Option<usize> {
        self.minimum_samples.get(denominator).copied()
    }

    /// Returns the slices the plan checks separately, in written order.
    pub fn important_slices(&self) -> &[ImportantSlice] {
        &self.important_slices
    }

    /// Returns the permitted candidate family.
    pub fn grid(&self) -> &CandidateGrid {
        &self.grid
    }

    /// Returns the evaluator configuration of every measurement of this
    /// plan.
    pub fn evaluator(&self) -> &EvaluatorConfiguration {
        &self.evaluator
    }

    /// Returns the fitting and the validation selections.
    pub fn datasets(&self) -> &PlanDatasets {
        &self.datasets
    }

    /// Returns the stored self-hash, when the artifact states one.
    pub fn stored_content_hash(&self) -> Option<&str> {
        self.stored_content_hash.as_deref()
    }

    /// Returns the computed identity of the artifact in the plan domain.
    ///
    /// The digest covers the artifact with its own `content_hash` field
    /// removed. One plan without one stored digest still states its identity
    /// here, so the calibration output can record it.
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    /// Returns the number of candidates the plan permits.
    pub fn candidate_count(&self) -> usize {
        self.grid.accept_cutoffs.len()
            * self.grid.rejection_cutoffs.len()
            * (1 + self.grid.confidence_floors.len())
    }

    /// Returns every permitted candidate in enumeration order.
    ///
    /// The accept dimension is the outer loop, the rejection dimension is the
    /// inner loop, and the confidence floor is the innermost dimension with
    /// no floor first. The fitting task searches this order, and the first
    /// optimum in it wins one tie.
    pub fn candidates(&self) -> Vec<Candidate> {
        let floors = std::iter::once(None)
            .chain(self.grid.confidence_floors.iter().map(|floor| Some(*floor)));
        let mut candidates = Vec::with_capacity(self.candidate_count());
        for accept in &self.grid.accept_cutoffs {
            for rejection in &self.grid.rejection_cutoffs {
                for floor in floors.clone() {
                    candidates.push(Candidate {
                        accept_cutoff: *accept,
                        rejection_cutoff: *rejection,
                        confidence_floor: floor,
                    });
                }
            }
        }
        candidates
    }
}

/// Validates one plan artifact from strict JSON text.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the text fails the strict JSON gate,
/// the plan contract, or the stored self-hash.
pub fn validate_plan_str(text: &str) -> Result<ValidatedPlan, ValidationError> {
    crate::json::parse_strict(text).and_then(|value| validate_plan(&value))
}

/// Validates one plan artifact from strict JSON bytes.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the bytes fail the UTF-8 check, the
/// strict JSON gate, the plan contract, or the stored self-hash.
pub fn validate_plan_bytes(bytes: &[u8]) -> Result<ValidatedPlan, ValidationError> {
    crate::json::parse_bytes_strict(bytes).and_then(|value| validate_plan(&value))
}

/// Validates one plan artifact that passed the strict JSON gate.
///
/// Every field is checked against the schema file and the cross-field rules
/// of the contracts README. One stored self-hash is verified last, so one
/// field defect names its field and not the digest.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the artifact breaks the plan contract
/// or its stored self-hash differs from the computed digest.
pub fn validate_plan(value: &Value) -> Result<ValidatedPlan, ValidationError> {
    let root = expect_object(value, "")?;
    let _schema_version = schema_version(root)?;
    reject_unknown_fields(root, PLAN_FIELDS, "")?;

    let id = required_artifact_id(root, "id", "/id")?;
    let name = parse_bounded_string(root.get("name"), "/name", 200, "The plan name")?;
    let definition = required_object(root, "definition", "")?;
    reject_unknown_fields(definition, &["name", "content_hash"], "/definition")?;
    let definition_name = required_artifact_id(definition, "name", "/definition/name")?;
    let definition_hash = required_hash(definition, "content_hash", "/definition/content_hash")?;
    let intended_population =
        required_bounded_string(root, "intended_population", "/intended_population", 2000)?;
    let sampling_assumptions =
        required_bounded_string(root, "sampling_assumptions", "/sampling_assumptions", 2000)?;
    let confidence_level = match root.get("confidence_level") {
        Some(value) => {
            let number = as_finite(value).ok_or_else(|| {
                ValidationError::invalid_field_type(
                    "/confidence_level",
                    "The confidence level must hold one number.",
                )
            })?;
            ConfidenceLevel::from_number(number).ok_or_else(|| {
                ValidationError::invalid_field_type(
                    "/confidence_level",
                    "The confidence level must hold 0.9, 0.95, or 0.99, the levels the interval methods support.",
                )
            })?
        }
        None => return Err(ValidationError::missing("/confidence_level")),
    };

    // Every constraint names one metric of the published set. One repeated
    // metric leaves the goal ambiguous, so it refuses the plan.
    let constraints = match root.get("constraints") {
        Some(Value::Array(items)) => {
            if items.is_empty() {
                return Err(ValidationError::invalid_field_type(
                    "/constraints",
                    "The plan must state one constraint at least. No universal default tolerance exists.",
                ));
            }
            let mut parsed = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let constraint = parse_constraint(item, index)?;
                if parsed
                    .iter()
                    .any(|earlier: &PlanConstraint| earlier.metric == constraint.metric)
                {
                    return Err(ValidationError::new(
                        ReasonCode::DuplicateId,
                        format!("/constraints/{index}/metric"),
                        format!(
                            "Two constraints name the metric {}. One metric appears in one constraint alone.",
                            fragment(constraint.metric.as_str())
                        ),
                    ));
                }
                parsed.push(constraint);
            }
            parsed
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/constraints",
                "The constraints field must hold one array.",
            ));
        }
        None => return Err(ValidationError::missing("/constraints")),
    };

    let objective = parse_objective(root)?;

    // The minimum counts state the evidence floor of every goal. One key
    // outside the published names states one requirement that no evaluation
    // reads, and one constrained error metric without its denominator
    // minimum leaves its goal without one floor.
    let minimum_samples =
        parse_minimum_samples(root.get("minimum_samples"), "/minimum_samples", true)?;
    for constraint in &constraints {
        if constraint.metric.is_error_metric() {
            let denominator = constraint.denominator();
            if !minimum_samples.contains_key(denominator) {
                return Err(ValidationError::invalid_field_type(
                    "/minimum_samples",
                    format!(
                        "The plan constrains the metric {} over the denominator {}, but states no minimum count for it. One small denominator bounds no goal.",
                        fragment(constraint.metric.as_str()),
                        fragment(denominator)
                    ),
                ));
            }
        }
    }

    let important_slices = match root.get("important_slices") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut parsed = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let slice = parse_slice(item, index)?;
                if parsed
                    .iter()
                    .any(|earlier: &ImportantSlice| earlier.tag == slice.tag)
                {
                    return Err(ValidationError::new(
                        ReasonCode::DuplicateId,
                        format!("/important_slices/{index}/tag"),
                        format!(
                            "Two important slices name the tag {}.",
                            fragment(&slice.tag)
                        ),
                    ));
                }
                parsed.push(slice);
            }
            parsed
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/important_slices",
                "The important slices must hold one array.",
            ));
        }
    };

    let grid = parse_grid(root)?;
    let evaluator = parse_evaluator(root)?;
    let datasets = parse_datasets(root)?;

    // The stored digest is read last. Every field defect above names its own
    // field, so one edited copy reports the edit when the fields still parse.
    let stored_content_hash = match root.get("content_hash") {
        None => None,
        Some(_) => {
            let stored = required_hash(root, "content_hash", "/content_hash")?;
            hashing::verify_self_hash(Domain::Plan, value)?;
            Some(stored)
        }
    };
    let content_hash = hashing::compute_self_hash(Domain::Plan, value)?;

    Ok(ValidatedPlan {
        artifact: value.clone(),
        id,
        name,
        definition_name,
        definition_hash,
        intended_population,
        sampling_assumptions,
        confidence_level,
        constraints,
        objective,
        minimum_samples,
        important_slices,
        grid,
        evaluator,
        datasets,
        stored_content_hash,
        content_hash,
    })
}

/// Parses one constraint at `/constraints/{index}`.
fn parse_constraint(value: &Value, index: usize) -> Result<PlanConstraint, ValidationError> {
    let base = format!("/constraints/{index}");
    let constraint = expect_object(value, &base)?;
    reject_unknown_fields(constraint, CONSTRAINT_FIELDS, &base)?;
    let metric = match constraint.get("metric") {
        Some(Value::String(word)) => MetricName::from_word(word).ok_or_else(|| {
            ValidationError::invalid_field_type(
                format!("{base}/metric"),
                format!(
                    "The metric must name one metric of the published set, so it names its denominator exactly. The word {} names none.",
                    fragment(word)
                ),
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/metric"),
                "The metric must name one metric of the published set.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/metric"))),
    };
    let comparison = match constraint.get("comparison") {
        Some(Value::String(word)) => Comparison::from_word(word).ok_or_else(|| {
            ValidationError::invalid_field_type(
                format!("{base}/comparison"),
                "The comparison must hold at_most or at_least.",
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/comparison"),
                "The comparison must hold at_most or at_least.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/comparison"))),
    };
    let limit = match constraint.get("limit") {
        Some(value) => {
            let number = as_finite(value).ok_or_else(|| {
                ValidationError::invalid_field_type(
                    format!("{base}/limit"),
                    "The limit must hold one finite number.",
                )
            })?;
            if !(0.0..=1.0).contains(&number) {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/limit"),
                    "The limit must hold one share from 0 to 1.",
                ));
            }
            number
        }
        None => return Err(ValidationError::missing(format!("{base}/limit"))),
    };
    let basis = match constraint.get("basis") {
        Some(Value::String(word)) => LimitBasis::from_word(word).ok_or_else(|| {
            ValidationError::invalid_field_type(
                format!("{base}/basis"),
                "The basis must hold upper_confidence_bound or observed_value.",
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/basis"),
                "The basis must hold upper_confidence_bound or observed_value.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/basis"))),
    };
    if comparison == Comparison::AtLeast && basis == LimitBasis::UpperConfidenceBound {
        return Err(ValidationError::invalid_field_type(
            format!("{base}/basis"),
            "One at_least limit takes the observed value, because the upper bound of one rate cannot establish one minimum.",
        ));
    }
    Ok(PlanConstraint {
        metric,
        comparison,
        limit,
        basis,
    })
}

/// Parses the objective at `/objective`.
fn parse_objective(root: &Map<String, Value>) -> Result<PlanObjective, ValidationError> {
    let objective = required_object(root, "objective", "")?;
    reject_unknown_fields(objective, OBJECTIVE_FIELDS, "/objective")?;
    let metric = match objective.get("metric") {
        Some(Value::String(word)) => ObjectiveMetric::from_word(word).ok_or_else(|| {
            ValidationError::invalid_field_type(
                "/objective/metric",
                format!(
                    "The objective metric must hold review_rate or automatic_coverage. The word {} names none.",
                    fragment(word)
                ),
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/objective/metric",
                "The objective metric must hold review_rate or automatic_coverage.",
            ));
        }
        None => return Err(ValidationError::missing("/objective/metric")),
    };
    let direction = match objective.get("direction") {
        Some(Value::String(word)) => Direction::from_word(word).ok_or_else(|| {
            ValidationError::invalid_field_type(
                "/objective/direction",
                "The objective direction must hold minimize or maximize.",
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/objective/direction",
                "The objective direction must hold minimize or maximize.",
            ));
        }
        None => return Err(ValidationError::missing("/objective/direction")),
    };
    if direction != metric.improving_direction() {
        return Err(ValidationError::invalid_field_type(
            "/objective/direction",
            format!(
                "The objective {} takes the direction {}, because the opposite direction works against the owner goal.",
                fragment(metric.as_str()),
                fragment(metric.improving_direction().as_str())
            ),
        ));
    }
    Ok(PlanObjective { metric, direction })
}

/// Parses one minimum sample map, by denominator name.
///
/// `required` states whether one empty map refuses, which holds for the plan
/// root and for every stated slice. Every key must name one population of
/// [`metrics::DENOMINATOR_NAMES`], and every value must hold one whole number
/// from one to the dataset record limit.
fn parse_minimum_samples(
    value: Option<&Value>,
    path: &str,
    required: bool,
) -> Result<BTreeMap<String, usize>, ValidationError> {
    let Some(value) = value else {
        if required {
            return Err(ValidationError::missing(path));
        }
        return Ok(BTreeMap::new());
    };
    let Value::Object(entries) = value else {
        return Err(ValidationError::invalid_field_type(
            path,
            "The minimum sample counts must hold one object keyed by denominator name.",
        ));
    };
    let mut parsed = BTreeMap::new();
    for (name, count) in entries {
        if metrics::denominator_name(name).is_none() {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/{name}"),
                format!(
                    "The name {} states no denominator of the published set. State one of {}.",
                    fragment(name),
                    metrics::DENOMINATOR_NAMES.join(", ")
                ),
            ));
        }
        let entry_path = format!("{path}/{name}");
        let count = crate::intervals::parse_count(count, &entry_path)?;
        if count < 1 {
            return Err(ValidationError::invalid_field_type(
                entry_path,
                "The minimum sample count must hold one whole number of at least one.",
            ));
        }
        parsed.insert(name.clone(), count);
    }
    if required && parsed.is_empty() {
        return Err(ValidationError::invalid_field_type(
            path,
            "The plan must state one minimum sample count at least, so every goal keeps one evidence floor.",
        ));
    }
    Ok(parsed)
}

/// Parses one important slice at `/important_slices/{index}`.
fn parse_slice(value: &Value, index: usize) -> Result<ImportantSlice, ValidationError> {
    let base = format!("/important_slices/{index}");
    let slice = expect_object(value, &base)?;
    reject_unknown_fields(slice, SLICE_FIELDS, &base)?;
    let tag = match slice.get("tag") {
        Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= 64 => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/tag"),
                "The slice tag must hold 1 to 64 characters.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/tag"))),
    };
    let minimum_samples = parse_minimum_samples(
        slice.get("minimum_samples"),
        &format!("{base}/minimum_samples"),
        true,
    )?;
    Ok(ImportantSlice {
        tag,
        minimum_samples,
    })
}

/// Parses the permitted candidate grid at `/candidate_grid`.
fn parse_grid(root: &Map<String, Value>) -> Result<CandidateGrid, ValidationError> {
    let grid = required_object(root, "candidate_grid", "")?;
    reject_unknown_fields(grid, GRID_FIELDS, "/candidate_grid")?;
    let accept_cutoffs =
        parse_cutoff_list(grid.get("accept_cutoffs"), "/candidate_grid/accept_cutoffs")?;
    let rejection_cutoffs = parse_cutoff_list(
        grid.get("rejection_cutoffs"),
        "/candidate_grid/rejection_cutoffs",
    )?;
    // One empty floor list permits no abstention, exactly as one absent list.
    let confidence_floors = match grid.get("confidence_floors") {
        None => Vec::new(),
        Some(Value::Array(items)) if items.is_empty() => Vec::new(),
        Some(value) => parse_cutoff_list(Some(value), "/candidate_grid/confidence_floors")?,
    };
    Ok(CandidateGrid {
        accept_cutoffs,
        rejection_cutoffs,
        confidence_floors,
    })
}

/// Parses one cutoff list. Every value stays above 0.5 and at or below 1, and
/// one repeated value enumerates one candidate twice.
fn parse_cutoff_list(value: Option<&Value>, path: &str) -> Result<Vec<f64>, ValidationError> {
    let Some(value) = value else {
        return Err(ValidationError::missing(path));
    };
    let Value::Array(items) = value else {
        return Err(ValidationError::invalid_field_type(
            path,
            "The cutoff list must hold one array of numbers.",
        ));
    };
    if items.is_empty() {
        return Err(ValidationError::invalid_field_type(
            path,
            "The cutoff list must hold one value at least, so the grid permits one candidate.",
        ));
    }
    let mut parsed = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let entry_path = format!("{path}/{index}");
        let number = as_finite(item).ok_or_else(|| {
            ValidationError::invalid_field_type(
                entry_path.clone(),
                "The cutoff must hold one finite number.",
            )
        })?;
        if number <= 0.5 || number > 1.0 {
            return Err(ValidationError::invalid_field_type(
                entry_path,
                "The cutoff must stay above 0.5 and at most 1, so one assessment cannot pass and fail together.",
            ));
        }
        if parsed.contains(&number) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                entry_path,
                "The cutoff list repeats one value, so it enumerates one candidate twice.",
            ));
        }
        parsed.push(number);
    }
    Ok(parsed)
}

/// Parses the evaluator configuration at `/evaluator`.
fn parse_evaluator(root: &Map<String, Value>) -> Result<EvaluatorConfiguration, ValidationError> {
    let evaluator = required_object(root, "evaluator", "")?;
    reject_unknown_fields(evaluator, EVALUATOR_FIELDS, "/evaluator")?;
    let identifier = required_artifact_id(evaluator, "evaluator", "/evaluator/evaluator")?;
    let adapter_version = required_bounded_string(
        evaluator,
        "adapter_version",
        "/evaluator/adapter_version",
        64,
    )?;
    let translation_hash = match evaluator.get("translation_hash") {
        None => None,
        Some(_) => Some(required_hash(
            evaluator,
            "translation_hash",
            "/evaluator/translation_hash",
        )?),
    };
    let model_requested = parse_bounded_string(
        evaluator.get("model_requested"),
        "/evaluator/model_requested",
        128,
        "The requested model",
    )?;
    Ok(EvaluatorConfiguration {
        evaluator: identifier,
        adapter_version,
        translation_hash,
        model_requested,
    })
}

/// Parses the dataset selections at `/datasets`.
fn parse_datasets(root: &Map<String, Value>) -> Result<PlanDatasets, ValidationError> {
    let datasets = required_object(root, "datasets", "")?;
    reject_unknown_fields(datasets, DATASETS_FIELDS, "/datasets")?;
    let fitting = parse_selection(datasets.get("fitting"), "/datasets/fitting")?;
    let validation = parse_selection(datasets.get("validation"), "/datasets/validation")?;
    if fitting == validation {
        return Err(ValidationError::new(
            ReasonCode::DuplicateId,
            "/datasets/validation",
            format!(
                "The validation selection names the same split as the fitting selection: {}. One calibration needs separated data.",
                fragment(&validation.reference())
            ),
        ));
    }
    Ok(PlanDatasets {
        fitting,
        validation,
    })
}

/// Parses one dataset selection.
fn parse_selection(value: Option<&Value>, path: &str) -> Result<DatasetSelection, ValidationError> {
    let Some(value) = value else {
        return Err(ValidationError::missing(path));
    };
    let selection = expect_object(value, path)?;
    reject_unknown_fields(selection, SELECTION_FIELDS, path)?;
    let dataset = match selection.get("dataset") {
        Some(Value::String(text)) if is_artifact_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/dataset"),
                "The dataset identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{path}/dataset"))),
    };
    let revision = match selection.get("revision") {
        Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= 64 => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/revision"),
                "The revision must hold 1 to 64 characters.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{path}/revision"))),
    };
    let split = match selection.get("split") {
        Some(Value::String(text)) if is_artifact_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/split"),
                "The split identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{path}/split"))),
    };
    let content_hash = match selection.get("content_hash") {
        None => None,
        Some(_) => Some(required_hash(
            selection,
            "content_hash",
            &format!("{path}/content_hash"),
        )?),
    };
    Ok(DatasetSelection {
        dataset,
        revision,
        split,
        content_hash,
    })
}

// ---------------------------------------------------------------------------
// Bindings.
// ---------------------------------------------------------------------------

/// One evaluator that the host registered, supplied as data.
///
/// The core never sees one evaluator object. The host states what serves
/// today, and [`check_plan_evaluator`] compares the plan against it, so one
/// loaded file installs no evaluator and executes no code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredEvaluator {
    /// The registered evaluator identifier.
    pub evaluator: String,
    /// The adapter version of the registered evaluator.
    pub adapter_version: String,
}

/// Parses one array of registered evaluators from one strict JSON value.
///
/// One entry names one evaluator once. The list is host data, not one
/// artifact, so it carries no stored digest.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` when one entry
/// breaks its shape, and with `duplicate_id` when two entries name one
/// evaluator.
pub fn parse_registered_evaluators(
    value: &Value,
    base: &str,
) -> Result<Vec<RegisteredEvaluator>, ValidationError> {
    let Value::Array(items) = value else {
        return Err(ValidationError::invalid_field_type(
            base.to_owned(),
            "The registered evaluators must hold one array.",
        ));
    };
    let mut parsed = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let entry_base = format!("{base}/{index}");
        let entry = expect_object(item, &entry_base)?;
        reject_unknown_fields(entry, &["evaluator", "adapter_version"], &entry_base)?;
        let registered = RegisteredEvaluator {
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
        };
        if parsed
            .iter()
            .any(|earlier: &RegisteredEvaluator| earlier.evaluator == registered.evaluator)
        {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("{entry_base}/evaluator"),
                format!(
                    "Two registered evaluators name the identifier {}.",
                    fragment(&registered.evaluator)
                ),
            ));
        }
        parsed.push(registered);
    }
    Ok(parsed)
}

/// Checks one validated plan against one loaded definition.
///
/// An exact-only definition holds no measured error source, so no calibration
/// plan fits it. Every other definition must be the one the plan binds by
/// name and content hash, because one changed definition changes the meaning
/// the plan measures.
///
/// `base` is the JSON Pointer that failures report under, for example
/// `/plan` inside one calibration.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `policy_mismatch` when the loaded
/// definition is exact-only, and with `definition_mismatch` when the plan
/// binds another definition.
pub fn check_plan_definition(
    plan: &ValidatedPlan,
    definition: &ValidatedDefinition,
    base: &str,
) -> Result<(), ValidationError> {
    if definition.is_exact_only() {
        return Err(ValidationError::new(
            ReasonCode::PolicyMismatch,
            format!("{base}/candidate_grid"),
            "An exact-only definition takes no calibration plan. Exact rules have no measured error source, so no cutoff family fits.",
        ));
    }
    if plan.definition_name() != definition.as_definition().name
        || plan.definition_hash() != hashing::definition_hash(definition)
    {
        return Err(ValidationError::new(
            ReasonCode::DefinitionMismatch,
            format!("{base}/definition"),
            format!(
                "The plan binds the definition {} with one content hash of its own. The loaded definition differs, so the pairing changes the meaning the plan measures. Bind the plan of this revision.",
                fragment(plan.definition_name())
            ),
        ));
    }
    Ok(())
}

/// Checks the evaluator configuration of one plan against the registered
/// evaluators of the host.
///
/// One plan measures with one evaluator, so the registered entry must name
/// that evaluator and its adapter version. One changed version needs new
/// qualification, and one loaded file registers nothing.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `evaluator_mismatch` when no registered
/// evaluator serves the plan, or when the registered adapter version differs.
pub fn check_plan_evaluator(
    plan: &ValidatedPlan,
    registered: &[RegisteredEvaluator],
    base: &str,
) -> Result<(), ValidationError> {
    let configuration = plan.evaluator();
    let Some(entry) = registered
        .iter()
        .find(|entry| entry.evaluator == configuration.evaluator)
    else {
        return Err(ValidationError::new(
            ReasonCode::EvaluatorMismatch,
            format!("{base}/evaluator/evaluator"),
            format!(
                "The plan measures with the evaluator {}, but no registered evaluator serves it. Register the evaluator with its version. One loaded file installs no evaluator.",
                fragment(&configuration.evaluator)
            ),
        ));
    };
    if entry.adapter_version != configuration.adapter_version {
        return Err(ValidationError::new(
            ReasonCode::EvaluatorMismatch,
            format!("{base}/evaluator/adapter_version"),
            format!(
                "The plan measures with the adapter version {} of the evaluator {}, but the registered adapter states {}. One changed version needs new qualification.",
                fragment(&configuration.adapter_version),
                fragment(&configuration.evaluator),
                fragment(&entry.adapter_version)
            ),
        ));
    }
    Ok(())
}

/// Checks the two dataset selections of one plan against the loaded splits.
///
/// Each selection must name the offered split of the offered dataset
/// revision, the declared purpose must match the role of the selection, and
/// one stored split hash must equal the computed digest of the loaded
/// records. The two selections must then share no group and no case, which
/// [`splits::require_separated`] decides.
///
/// `base` is the JSON Pointer that failures report under, for example
/// `/plan` inside one calibration.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` when one selection
/// names another dataset, revision, or split, or one of the wrong purpose,
/// with `hash_mismatch` when one stored split hash differs, and with
/// `duplicate_id` when the two selections share one group or one case.
pub fn check_plan_datasets(
    plan: &ValidatedPlan,
    fitting: &SplitIdentity,
    validation: &SplitIdentity,
    base: &str,
) -> Result<(), ValidationError> {
    check_selection(
        &plan.datasets().fitting,
        fitting,
        SplitPurpose::Fitting,
        &format!("{base}/datasets/fitting"),
    )?;
    check_selection(
        &plan.datasets().validation,
        validation,
        SplitPurpose::Validation,
        &format!("{base}/datasets/validation"),
    )?;
    splits::require_separated(fitting, validation).map_err(|mut error| {
        error.field_path = format!("{base}/datasets/validation");
        error
    })
}

/// Checks one dataset selection against one loaded split identity.
///
/// The fitting search of [`crate::fitting`] runs the same check over its
/// single offered split, so the field-by-field wording of one selection
/// failure has one source.
pub(crate) fn check_selection(
    selection: &DatasetSelection,
    identity: &SplitIdentity,
    purpose: SplitPurpose,
    path: &str,
) -> Result<(), ValidationError> {
    if selection.dataset != identity.dataset_id {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/dataset"),
            format!(
                "The selection names the dataset {}, but the offered split belongs to {}.",
                fragment(&selection.dataset),
                fragment(&identity.dataset_id)
            ),
        ));
    }
    if selection.revision != identity.revision {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/revision"),
            format!(
                "The selection names the revision {}, but the offered split belongs to revision {}.",
                fragment(&selection.revision),
                fragment(&identity.revision)
            ),
        ));
    }
    if selection.split != identity.split_id {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/split"),
            format!(
                "The selection names the split {}, but the offered split is {}.",
                fragment(&selection.split),
                fragment(&identity.split_id)
            ),
        ));
    }
    if identity.purpose != purpose {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/split"),
            format!(
                "The selection names the split {}, which the dataset declares for {}. One calibration reads its fitting data and its validation data from the splits of their declared purpose.",
                fragment(&identity.split_id),
                fragment(identity.purpose.as_str())
            ),
        ));
    }
    if let Some(stored) = &selection.content_hash {
        if *stored != identity.content_hash {
            return Err(ValidationError::new(
                ReasonCode::HashMismatch,
                format!("{path}/content_hash"),
                format!(
                    "The stored hash of the split {} differs from the computed digest of the loaded records, so the revision no longer covers the records the plan binds.",
                    fragment(&identity.split_id)
                ),
            ));
        }
    }
    Ok(())
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
    use crate::dataset::load_dataset;
    use serde_json::json;

    /// One definition hash of the right shape.
    const HASH_A: &str = "a5065efe5f955d002a550c9598efeb1217b0b402db10efda842f10682a2ec65b";
    /// One second hash of the right shape.
    const HASH_B: &str = "88c86b66dd45adbd34e4a409dd3a37a2cbe6f94990fefb35c7f0d97dcaf94970";

    /// One minimal valid plan, without one stored digest.
    fn base_plan() -> Value {
        json!({
            "schema_version": 1,
            "id": "message-supported-plan",
            "definition": {"name": "message-supported", "content_hash": HASH_A},
            "intended_population": "Proposed messages in support conversations.",
            "sampling_assumptions": "Cases grouped by conversation. Groups are independent draws.",
            "confidence_level": 0.95,
            "constraints": [
                {
                    "metric": "error_among_accepted",
                    "comparison": "at_most",
                    "limit": 0.05,
                    "basis": "upper_confidence_bound"
                }
            ],
            "objective": {"metric": "review_rate", "direction": "minimize"},
            "minimum_samples": {
                "labeled_cases": 200,
                "accepted_cases": 80,
                "reference_fail_or_review_cases": 60
            },
            "important_slices": [
                {"tag": "later-corrections", "minimum_samples": {"labeled_cases": 30}}
            ],
            "candidate_grid": {
                "accept_cutoffs": [0.6, 0.8],
                "rejection_cutoffs": [0.7, 0.9],
                "confidence_floors": [0.75]
            },
            "evaluator": {
                "evaluator": "jev-choice",
                "adapter_version": "0.1.0"
            },
            "datasets": {
                "fitting": {
                    "dataset": "plan-cases",
                    "revision": "2026-09-24.1",
                    "split": "fit"
                },
                "validation": {
                    "dataset": "plan-cases",
                    "revision": "2026-09-24.1",
                    "split": "holdout"
                }
            }
        })
    }

    /// One categorical question definition for the binding checks.
    fn definition(name: &str) -> ValidatedDefinition {
        let text = json!({
            "schema_version": 1,
            "name": name,
            "inputs": {
                "type": "object",
                "properties": {
                    "message": {"type": "string", "minLength": 1},
                    "evidence": {"type": "string", "minLength": 1}
                },
                "required": ["message", "evidence"],
                "additionalProperties": false
            },
            "checks": [
                {
                    "id": "message-supported",
                    "name": "Our message accurately describes the evidence",
                    "using": ["message", "evidence"],
                    "question": "Does every material claim follow from the evidence?",
                    "answers": {
                        "supported": "All claims are supported.",
                        "contradicted": "One claim conflicts with the evidence."
                    },
                    "accept": "supported"
                }
            ]
        });
        let text = serde_json::to_string(&text).expect("serializes");
        crate::definition::validate_definition_str(&text).expect("the definition validates")
    }

    /// One exact-only definition for the binding checks.
    fn exact_definition() -> ValidatedDefinition {
        let text = json!({
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
        let text = serde_json::to_string(&text).expect("serializes");
        crate::definition::validate_definition_str(&text).expect("the definition validates")
    }

    /// One record of one group.
    fn record(id: &str, group: &str) -> Value {
        json!({
            "id": id,
            "group": group,
            "input": {"message": "Hello.", "evidence": "The notes state the source."},
            "label": {"author_type": "human", "reviewed": false}
        })
    }

    /// One metadata artifact that declares one fitting and one validation
    /// split over the stated groups.
    fn metadata(id: &str, revision: &str, fitting: &[&str], validation: &[&str]) -> Value {
        json!({
            "schema_version": 1,
            "id": id,
            "revision": revision,
            "kind": "representative_sample",
            "intended_population": "Proposed messages in support conversations.",
            "sampling_method": "Sampled at random from reviewed traffic.",
            "label_guidelines": "See docs/labeling.md revision 3.",
            "splits": [
                {"id": "fit", "purpose": "fitting", "groups": fitting},
                {"id": "holdout", "purpose": "validation", "groups": validation}
            ]
        })
    }

    /// Loads one dataset from one metadata artifact and one records text.
    fn splits_of(metadata: &Value, records: &str) -> Vec<splits::SplitIdentity> {
        let text = serde_json::to_string(metadata).expect("serializes");
        let dataset = load_dataset(&text, records).expect("the dataset loads");
        let grouped = splits::dataset_splits(&dataset).expect("the splits compute");
        grouped
            .splits()
            .iter()
            .map(|split| split.identity().clone())
            .collect()
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
    fn one_valid_plan_reads_every_declared_goal() {
        let plan = validate_plan(&base_plan()).expect("the plan validates");
        assert_eq!(plan.id(), "message-supported-plan");
        assert_eq!(plan.name(), None);
        assert_eq!(plan.definition_name(), "message-supported");
        assert_eq!(plan.definition_hash(), HASH_A);
        assert_eq!(
            plan.intended_population(),
            "Proposed messages in support conversations."
        );
        assert_eq!(plan.confidence_level(), ConfidenceLevel::NinetyFive);
        assert_eq!(plan.constraints().len(), 1);
        let constraint = plan.constraints()[0];
        assert_eq!(constraint.metric, MetricName::ErrorAmongAccepted);
        assert_eq!(constraint.comparison, Comparison::AtMost);
        assert_eq!(constraint.limit, 0.05);
        assert_eq!(constraint.basis, LimitBasis::UpperConfidenceBound);
        assert_eq!(constraint.denominator(), "accepted_cases");
        assert_eq!(plan.objective().metric, ObjectiveMetric::ReviewRate);
        assert_eq!(plan.objective().direction, Direction::Minimize);
        assert_eq!(plan.minimum_of("accepted_cases"), Some(80));
        assert_eq!(plan.minimum_of("evaluated_cases"), None);
        assert_eq!(plan.important_slices().len(), 1);
        assert_eq!(plan.important_slices()[0].tag, "later-corrections");
        assert_eq!(
            plan.important_slices()[0]
                .minimum_samples
                .get("labeled_cases"),
            Some(&30)
        );
        assert_eq!(plan.evaluator().evaluator, "jev-choice");
        assert_eq!(plan.evaluator().adapter_version, "0.1.0");
        assert_eq!(plan.evaluator().translation_hash, None);
        assert_eq!(plan.datasets().fitting.split, "fit");
        assert_eq!(plan.datasets().validation.split, "holdout");
        assert_eq!(plan.stored_content_hash(), None);
        assert_eq!(plan.content_hash().len(), 64);
        // The artifact stays unchanged inside the validated value.
        assert_eq!(plan.as_artifact(), &base_plan());

        // The same plan crosses the strict text gate with one digest added.
        let mut stored = base_plan();
        stored["content_hash"] = json!(plan.content_hash());
        let text = serde_json::to_string(&stored).expect("serializes");
        let validated = validate_plan_str(&text).expect("the stored plan validates");
        assert_eq!(validated.stored_content_hash(), Some(plan.content_hash()));
    }

    #[test]
    fn the_candidate_enumeration_fixes_the_tie_break_order() {
        let plan = validate_plan(&base_plan()).expect("the plan validates");
        assert_eq!(plan.candidate_count(), 2 * 2 * 2);
        let order: Vec<(f64, f64, Option<f64>)> = plan
            .candidates()
            .iter()
            .map(|candidate| {
                (
                    candidate.accept_cutoff,
                    candidate.rejection_cutoff,
                    candidate.confidence_floor,
                )
            })
            .collect();
        // The accept dimension is the outer loop, the rejection dimension is
        // the inner loop, and the floor is innermost with no floor first.
        assert_eq!(
            order,
            [
                (0.6, 0.7, None),
                (0.6, 0.7, Some(0.75)),
                (0.6, 0.9, None),
                (0.6, 0.9, Some(0.75)),
                (0.8, 0.7, None),
                (0.8, 0.7, Some(0.75)),
                (0.8, 0.9, None),
                (0.8, 0.9, Some(0.75)),
            ]
        );

        // One grid without one floor list enumerates one floor-free family,
        // and one empty floor list states the same permission.
        let mut plain = base_plan();
        plain["candidate_grid"]
            .as_object_mut()
            .expect("one grid")
            .remove("confidence_floors");
        let plan = validate_plan(&plain).expect("the plan validates");
        assert_eq!(plan.grid().confidence_floors, Vec::<f64>::new());
        assert_eq!(plan.candidate_count(), 4);
        assert!(plan
            .candidates()
            .iter()
            .all(|candidate| candidate.confidence_floor.is_none()));

        let mut empty = base_plan();
        empty["candidate_grid"]["confidence_floors"] = json!([]);
        let plan = validate_plan(&empty).expect("the plan validates");
        assert_eq!(plan.grid().confidence_floors, Vec::<f64>::new());
        assert_eq!(plan.candidate_count(), 4);
    }

    #[test]
    fn broken_plans_name_their_field_and_code() {
        let cases: Vec<(Value, ReasonCode, &str)> = vec![
            {
                let mut broken = base_plan();
                broken["tolerance"] = json!(0.05);
                (broken, ReasonCode::UnknownField, "/tolerance")
            },
            {
                let mut broken = base_plan();
                broken
                    .as_object_mut()
                    .expect("an object")
                    .remove("objective");
                (broken, ReasonCode::MissingField, "/objective")
            },
            {
                let mut broken = base_plan();
                broken["id"] = json!("Plan");
                (broken, ReasonCode::InvalidFieldType, "/id")
            },
            {
                let mut broken = base_plan();
                broken["definition"]["content_hash"] = json!("nothex");
                (
                    broken,
                    ReasonCode::InvalidFieldType,
                    "/definition/content_hash",
                )
            },
            {
                let mut broken = base_plan();
                broken["confidence_level"] = json!(0.9);
                broken["confidence_level"] = json!(0.98);
                (broken, ReasonCode::InvalidFieldType, "/confidence_level")
            },
            {
                let mut broken = base_plan();
                broken["constraints"][0]["metric"] = json!("error_rate");
                (
                    broken,
                    ReasonCode::InvalidFieldType,
                    "/constraints/0/metric",
                )
            },
            {
                let mut broken = base_plan();
                broken["constraints"][0]["basis"] = json!("posterior_mean");
                (broken, ReasonCode::InvalidFieldType, "/constraints/0/basis")
            },
            {
                let mut broken = base_plan();
                broken["constraints"][0]["limit"] = json!(-0.1);
                (broken, ReasonCode::InvalidFieldType, "/constraints/0/limit")
            },
            {
                let mut broken = base_plan();
                broken["objective"]["direction"] = json!("maximize");
                (broken, ReasonCode::InvalidFieldType, "/objective/direction")
            },
            {
                let mut broken = base_plan();
                broken["minimum_samples"]["labeled_case"] = json!(200);
                (
                    broken,
                    ReasonCode::InvalidFieldType,
                    "/minimum_samples/labeled_case",
                )
            },
            {
                let mut broken = base_plan();
                broken["minimum_samples"]["labeled_cases"] = json!(1.5);
                (
                    broken,
                    ReasonCode::InvalidFieldType,
                    "/minimum_samples/labeled_cases",
                )
            },
            {
                let mut broken = base_plan();
                broken["candidate_grid"]["accept_cutoffs"][0] = json!(0.5);
                (
                    broken,
                    ReasonCode::InvalidFieldType,
                    "/candidate_grid/accept_cutoffs/0",
                )
            },
            {
                let mut broken = base_plan();
                broken["candidate_grid"]["rejection_cutoffs"][1] = json!(1.0001);
                (
                    broken,
                    ReasonCode::InvalidFieldType,
                    "/candidate_grid/rejection_cutoffs/1",
                )
            },
            {
                let mut broken = base_plan();
                broken["datasets"]["fitting"]["revision"] = json!("");
                (
                    broken,
                    ReasonCode::InvalidFieldType,
                    "/datasets/fitting/revision",
                )
            },
            {
                let mut broken = base_plan();
                broken["evaluator"]["evaluator"] = json!("Jev-Choice");
                (broken, ReasonCode::InvalidFieldType, "/evaluator/evaluator")
            },
        ];
        for (broken, code, path) in cases {
            let error = validate_plan(&broken)
                .err()
                .unwrap_or_else(|| panic!("the plan was accepted: {path}"));
            assert_eq!(error.code, code, "{path}: {error}");
            assert_eq!(error.field_path, path, "{path}: {error}");
        }

        // One plan that constrains one error metric without the minimum of
        // its denominator leaves its goal without one evidence floor.
        let mut broken = base_plan();
        broken["constraints"][0]["metric"] = json!("false_rejection_rate");
        let error = validate_plan(&broken).expect_err("the denominator minimum is absent");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/minimum_samples", "{error}");
        assert!(error.message.contains("reference_pass_cases"), "{error}");

        // One stored digest that differs fails with the mismatch code.
        let mut edited = base_plan();
        edited["content_hash"] = json!(HASH_B);
        let error = validate_plan(&edited).expect_err("the digest differs");
        assert_eq!(error.code, ReasonCode::HashMismatch, "{error}");
        assert_eq!(error.field_path, "/content_hash", "{error}");

        // Malformed text fails at the strict gate before any field is read.
        let error = validate_plan_str("{\"id\": ").expect_err("malformed text");
        assert_eq!(error.code, ReasonCode::InvalidJson, "{error}");
    }

    #[test]
    fn the_definition_binding_refuses_exact_rules_and_foreign_definitions() {
        // One definition with one question check loads, and the plan binds
        // its computed hash.
        let loaded = definition("message-supported");
        let mut artifact = base_plan();
        artifact["definition"]["content_hash"] = json!(hashing::definition_hash(&loaded));
        let plan = validate_plan(&artifact).expect("the plan validates");
        check_plan_definition(&plan, &loaded, "/plan").expect("the definition binds");

        // One exact-only definition holds no measured error source.
        let error =
            check_plan_definition(&plan, &exact_definition(), "/plan").expect_err("exact only");
        assert_eq!(error.code, ReasonCode::PolicyMismatch, "{error}");
        assert_eq!(error.field_path, "/plan/candidate_grid", "{error}");

        // One other definition changes the meaning the plan measures.
        let other = definition("release-notes");
        let error = check_plan_definition(&plan, &other, "/plan").expect_err("another definition");
        assert_eq!(error.code, ReasonCode::DefinitionMismatch, "{error}");
        assert_eq!(error.field_path, "/plan/definition", "{error}");

        // One plan that binds the hash of another revision fails the same
        // way, whatever its name.
        let mut foreign = base_plan();
        foreign["definition"]["content_hash"] = json!(HASH_B);
        let foreign_plan = validate_plan(&foreign).expect("the plan validates");
        let error =
            check_plan_definition(&foreign_plan, &loaded, "/plan").expect_err("another revision");
        assert_eq!(error.code, ReasonCode::DefinitionMismatch, "{error}");
    }

    #[test]
    fn the_evaluator_binding_compares_the_registered_state() {
        let plan = validate_plan(&base_plan()).expect("the plan validates");
        let registered = parse_registered_evaluators(
            &json!([{"evaluator": "jev-choice", "adapter_version": "0.1.0"}]),
            "/evaluators",
        )
        .expect("the registry parses");
        check_plan_evaluator(&plan, &registered, "/plan").expect("the evaluator serves the plan");

        // One unregistered evaluator installs nothing.
        let empty = Vec::new();
        let error = check_plan_evaluator(&plan, &empty, "/plan").expect_err("nothing serves");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch, "{error}");
        assert_eq!(error.field_path, "/plan/evaluator/evaluator", "{error}");

        // One other registered evaluator does not serve the plan.
        let other = parse_registered_evaluators(
            &json!([{"evaluator": "scripted-choice", "adapter_version": "0.1.0"}]),
            "/evaluators",
        )
        .expect("the registry parses");
        let error = check_plan_evaluator(&plan, &other, "/plan").expect_err("another evaluator");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch, "{error}");
        assert_eq!(error.field_path, "/plan/evaluator/evaluator", "{error}");

        // One changed adapter version needs new qualification.
        let changed = parse_registered_evaluators(
            &json!([{"evaluator": "jev-choice", "adapter_version": "0.2.0"}]),
            "/evaluators",
        )
        .expect("the registry parses");
        let error = check_plan_evaluator(&plan, &changed, "/plan").expect_err("another version");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch, "{error}");
        assert_eq!(
            error.field_path, "/plan/evaluator/adapter_version",
            "{error}"
        );

        // One registry entry names one evaluator once, and one broken entry
        // names its field.
        let error = parse_registered_evaluators(
            &json!([
                {"evaluator": "jev-choice", "adapter_version": "0.1.0"},
                {"evaluator": "jev-choice", "adapter_version": "0.2.0"}
            ]),
            "/evaluators",
        )
        .expect_err("one repeated evaluator");
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/evaluators/1/evaluator", "{error}");
        let error =
            parse_registered_evaluators(&json!([{"evaluator": "jev-choice"}]), "/evaluators")
                .expect_err("one incomplete entry");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/evaluators/0/adapter_version", "{error}");
        let error =
            parse_registered_evaluators(&json!("jev-choice"), "/evaluators").expect_err("no array");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
    }

    #[test]
    fn the_dataset_binding_checks_references_purposes_hashes_and_separation() {
        let records = file(&[
            record("case-1", "conversation-a"),
            record("case-2", "conversation-a"),
            record("case-3", "conversation-b"),
            record("case-4", "conversation-b"),
        ]);
        let identities = splits_of(
            &metadata(
                "plan-cases",
                "2026-09-24.1",
                &["conversation-a"],
                &["conversation-b"],
            ),
            &records,
        );
        let fitting = &identities[0];
        let validation = &identities[1];

        // One plan that names the offered splits loads, with one stored
        // split hash that agrees.
        let mut plan = base_plan();
        plan["datasets"]["fitting"]["content_hash"] = json!(fitting.content_hash);
        plan["datasets"]["validation"]["content_hash"] = json!(validation.content_hash);
        let plan = validate_plan(&plan).expect("the plan validates");
        check_plan_datasets(&plan, fitting, validation, "/plan")
            .expect("the two selections bind the offered splits");

        // One other revision names other content.
        let mut broken = base_plan();
        broken["datasets"]["fitting"]["revision"] = json!("2026-09-24.2");
        let plan = validate_plan(&broken).expect("the plan validates");
        let error =
            check_plan_datasets(&plan, fitting, validation, "/plan").expect_err("another revision");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(
            error.field_path, "/plan/datasets/fitting/revision",
            "{error}"
        );

        // One stored split hash that differs fails the revision.
        let mut broken = base_plan();
        broken["datasets"]["validation"]["content_hash"] = json!(HASH_A);
        let plan = validate_plan(&broken).expect("the plan validates");
        let error = check_plan_datasets(&plan, fitting, validation, "/plan")
            .expect_err("one stored hash differs");
        assert_eq!(error.code, ReasonCode::HashMismatch, "{error}");
        assert_eq!(
            error.field_path, "/plan/datasets/validation/content_hash",
            "{error}"
        );

        // One fitting selection that names the validation split reads the
        // split of the wrong purpose.
        let mut swapped = base_plan();
        swapped["datasets"]["fitting"]["split"] = json!("holdout");
        swapped["datasets"]["fitting"]["content_hash"] = json!(validation.content_hash);
        let plan = validate_plan(&swapped).expect("the plan validates");
        let error =
            check_plan_datasets(&plan, validation, fitting, "/plan").expect_err("wrong purpose");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/plan/datasets/fitting/split", "{error}");

        // Two datasets that share one group hold no independent validation
        // data, whatever their split names.
        let other_records = file(&[record("case-9", "conversation-a")]);
        let other_identities = splits_of(
            &metadata(
                "plan-cases-2",
                "2026-09-24.2",
                &["conversation-z"],
                &["conversation-a"],
            ),
            &other_records,
        );
        let mut shared = base_plan();
        shared["datasets"]["validation"]["dataset"] = json!("plan-cases-2");
        shared["datasets"]["validation"]["revision"] = json!("2026-09-24.2");
        shared["datasets"]["validation"]["content_hash"] = json!(other_identities[1].content_hash);
        let plan = validate_plan(&shared).expect("the plan validates");
        let error = check_plan_datasets(&plan, fitting, &other_identities[1], "/plan")
            .expect_err("one shared group");
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/plan/datasets/validation", "{error}");
        assert!(error.message.contains("conversation-a"), "{error}");
    }

    #[test]
    fn the_contract_words_round_trip() {
        for (word, comparison) in [
            ("at_most", Comparison::AtMost),
            ("at_least", Comparison::AtLeast),
        ] {
            assert_eq!(comparison.as_str(), word);
            assert_eq!(Comparison::from_word(word), Some(comparison));
        }
        for (word, basis) in [
            ("upper_confidence_bound", LimitBasis::UpperConfidenceBound),
            ("observed_value", LimitBasis::ObservedValue),
        ] {
            assert_eq!(basis.as_str(), word);
            assert_eq!(LimitBasis::from_word(word), Some(basis));
        }
        for (word, metric) in [
            ("review_rate", ObjectiveMetric::ReviewRate),
            ("automatic_coverage", ObjectiveMetric::AutomaticCoverage),
        ] {
            assert_eq!(metric.as_str(), word);
            assert_eq!(ObjectiveMetric::from_word(word), Some(metric));
            assert_eq!(metric.improving_direction().as_str(), word_direction(word));
        }
        for (word, direction) in [
            ("minimize", Direction::Minimize),
            ("maximize", Direction::Maximize),
        ] {
            assert_eq!(direction.as_str(), word);
            assert_eq!(Direction::from_word(word), Some(direction));
        }
        assert_eq!(Comparison::from_word("below"), None);
        assert_eq!(LimitBasis::from_word("lower_bound"), None);
        assert_eq!(ObjectiveMetric::from_word("error_rate"), None);
        assert_eq!(Direction::from_word("reduce"), None);
    }

    /// Returns the direction that improves one objective metric word.
    fn word_direction(word: &str) -> &'static str {
        match word {
            "review_rate" => "minimize",
            _ => "maximize",
        }
    }
}
