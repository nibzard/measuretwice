// SPDX-License-Identifier: Apache-2.0
//! The policy revision boundary: which stored assessments one revision
//! may replay, and what two policies change on the same cases.
//!
//! MVP_SPEC.md section 8 states the rule: one policy-only change can
//! reuse compatible stored assessments for fitting, but it still requires
//! independent validation before promotion. Changing question wording,
//! criteria, schema, input projection, preprocessing, model, prompt
//! translation, or evaluator code invalidates the prior qualification.
//!
//! [`check_revision`] owns the first half. One revision states its prior
//! calibration: the candidate profile, the fitting report, and the stored
//! measurement runs. The core verifies every artifact before one
//! assessment is replayed:
//!
//! - The prior profile passes the complete profile contract and its
//!   stored self-hash, and its origin is `calibration`, because one
//!   calibration alone records the evidence and the measurements one
//!   revision replays.
//! - The prior profile and the revision plan bind the loaded definition
//!   by name and content hash, so one changed question, criterion,
//!   schema, or input projection names itself: all four live inside the
//!   definition hash.
//! - The plan measures with the evaluator the prior profile bound, under
//!   the same adapter version, the same translated question, and the same
//!   requested model, and the live registry state serves that same
//!   binding today. One changed adapter, translation, model resolution,
//!   or preprocessing identity refuses with the compatibility code of
//!   the registry before any replay.
//! - The fitting split of the loaded dataset carries the content hash the
//!   prior profile recorded, so the stored assessments measured the
//!   inputs the revision reads. One edited record, one renamed dataset,
//!   or one exchanged split refuses with `hash_mismatch`.
//! - Every stored run rebuilds through the run report contract, states
//!   one shared measurement profile, binds the definition by hash, names
//!   one case of one split of the revision with the input hash of the
//!   loaded record, and holds one stored assessment of every question
//!   check whose evaluator record matches the binding the prior profile
//!   records. The fitting assessments cross into the result, and nothing
//!   else does.
//!
//! The boundary then classifies the validation data. The prior runs that
//! name cases of the loaded validation split are the prior validation
//! measurements: that content was consumed, its assessments may be
//! replayed, and one new qualification claim needs fresh independent
//! evidence. The prior runs that name cases of no loaded split are the
//! validation measurements of one earlier dataset revision: they are
//! retained host data, they are never replayed, and the prior
//! qualification of one fresh split rests on measurements the revision
//! makes itself. The qualification status of the prior profile and the
//! search status of the prior fitting report cross-check the stated runs,
//! so one calibration that validated one candidate cannot drop its
//! validation measurements and one unfinished calibration cannot invent
//! ones it never made.
//!
//! [`compare_revision`] owns the second half. One revision states the
//! applied policy of the prior profile and the applied policy of its
//! frozen candidate; the core replays the stored fitting assessments
//! under both, lists every case whose component outcomes changed with
//! both aggregate outcomes, and states the metric tradeoffs with the
//! counts and the denominators of both sides over the same cases. The
//! comparison is fitting evidence: it guides development and supports no
//! validation claim, exactly as the comparison contract records.
//!
//! Neither operation selects, promotes, or rewrites one profile. One
//! revision produces one new candidate identity, and the host reviews the
//! recorded evidence and selects one reviewed content hash through its
//! own code.

use crate::comparison::{ChangedCase, ChangedCheck, EvidenceClass, MetricRow, MetricTradeoff};
use crate::dataset::{self, CaseRecord, SplitPurpose};
use crate::definition::{is_artifact_id, CheckKind, ValidatedDefinition};
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::fitting::{self, Answer};
use crate::hashing;
use crate::metrics::{self, ConfusionMatrix, MetricSet};
use crate::plan::{self, ValidatedPlan};
use crate::policy;
use crate::profile::{self, LiveBinding, ProfileOrigin, ValidatedProfile};
use crate::report::{self, AppliedPolicy, RecordKind, RunMode};
use crate::splits::{self, SplitIdentity};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// The standing statement that every reuse result carries.
pub const REUSE_STATEMENT: &str = "A policy revision reuses the stored assessments of one compatible calibration and measures nothing on the fitting split. Reuse establishes no qualification: one changed definition, evaluator, adapter, translation, model resolution, preprocessing identity, or input needs new measurements, and one new qualification claim needs fresh independent validation evidence.";

/// The standing statement that every revision comparison carries.
pub const COMPARISON_STATEMENT: &str = "A revision comparison replays the stored fitting assessments under two policies. It is fitting evidence from the fitting split alone: it guides development, it supports no validation claim, and it selects nothing.";

/// The greatest number of stored measurement runs one revision may state.
///
/// One calibration stores one run per measured case, so one prior
/// calibration of one dataset holds at most [`dataset::MAX_DATASET_RECORDS`]
/// runs. The stated set may add the validation runs of one earlier
/// dataset revision, so the bound leaves room for two complete sets and
/// refuses one unbounded input before one report is rebuilt.
pub const MAX_STORED_RUNS: usize = 2 * dataset::MAX_DATASET_RECORDS;

/// The greatest number of policy decisions of one revision comparison:
/// one decision is one policy replayed over one fitting case, and the
/// comparison states two policies.
pub const MAX_COMPARISON_DECISIONS: usize = fitting::MAX_FIT_DECISIONS;

/// One identity reference with an identifier and a content hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IdentityRow {
    /// Stable artifact identifier.
    pub id: String,
    /// Content hash of the artifact.
    pub content_hash: String,
}

/// One binding of the prior profile with the identity the reuse verified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RevisionBindingRow {
    /// The bound check.
    pub check: String,
    /// The registered evaluator that serves it.
    pub evaluator: String,
    /// The adapter version of the binding.
    pub adapter_version: String,
    /// The content hash of the recorded translated question.
    pub translation_hash: String,
    /// The requested model alias, when the binding records one.
    pub model_requested: Option<String>,
    /// The model version the stored assessments resolved, when the runs
    /// or the binding recorded one.
    pub model_resolved: Option<String>,
    /// The preprocessing identity, when the binding records one.
    pub preprocessing: Option<String>,
}

/// One split of the loaded dataset, with the identity the reuse read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoadedSplitRow {
    /// Stable split identifier.
    pub id: String,
    /// Dataset revision of the split.
    pub revision: String,
    /// Computed content hash of the split records.
    pub content_hash: String,
    /// Case records of the split.
    pub record_count: usize,
}

/// The validation data of one revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "disposition")]
pub enum ValidationData {
    /// The prior calibration measured this validation split, so its
    /// stored assessments may be replayed and its content is development
    /// data: one new qualification claim needs fresh independent
    /// evidence.
    Reused {
        /// Validation cases the stored runs measured.
        cases: usize,
    },
    /// No stored assessment names one case of this validation split, so
    /// the revision measures it through the registered evaluator.
    Fresh,
}

impl ValidationData {
    /// Returns the contract word of this disposition.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Reused { .. } => "reused",
            Self::Fresh => "fresh",
        }
    }
}

/// The verified reuse of the stored assessments of one prior calibration.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RevisionReuse {
    /// Stable identifier of the prior profile.
    pub prior_profile_id: String,
    /// Verified self-hash of the prior profile artifact.
    pub prior_profile_content_hash: String,
    /// The plan the prior profile records.
    pub prior_plan: IdentityRow,
    /// The dataset the prior profile records.
    pub prior_dataset: String,
    /// The splits the prior profile records.
    pub prior_splits: Vec<IdentityRow>,
    /// Name of the definition both artifacts bind.
    pub definition_name: String,
    /// Content hash of the definition both artifacts bind.
    pub definition_hash: String,
    /// Every binding of the prior profile with its verified identity.
    pub bindings: Vec<RevisionBindingRow>,
    /// The fitting split of the loaded dataset, verified against the
    /// recorded split of the prior profile.
    pub fitting_split: LoadedSplitRow,
    /// The validation split of the loaded dataset.
    pub validation_split: LoadedSplitRow,
    /// Fitting cases the stored runs measured.
    pub stored_fitting_cases: usize,
    /// The classification of the validation data.
    pub validation_data: ValidationData,
    /// Every model version the stored fitting assessments resolved, when
    /// the runs recorded one.
    pub resolved_models: Vec<String>,
    /// The stored fitting assessments, keyed by case identifier, then by
    /// question check identifier.
    pub fitting_assessments: Value,
    /// The stored validation assessments of the loaded validation split,
    /// present exactly when the disposition is `reused`.
    pub validation_assessments: Option<Value>,
    /// What the check verified, with the counts it read.
    pub statement: String,
    /// The standing limits of this reuse.
    pub limitations: Vec<String>,
}

/// One applied policy row of one revision side.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PolicyRow {
    /// The question check this policy decides.
    pub check: String,
    /// The applied parameters.
    pub policy: AppliedPolicy,
}

/// One side of one revision comparison.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RevisionSide {
    /// The prior profile of the baseline side, or the plan of the
    /// candidate side, with its identity.
    pub source: IdentityRow,
    /// The applied policy of every question check, in definition order.
    pub policy: Vec<PolicyRow>,
}

/// The matching of one revision comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RevisionMatching {
    /// Fitting cases both policies replayed.
    pub matched_cases: usize,
    /// Matched cases with at least one changed component outcome.
    pub changed_cases: usize,
    /// Matched cases whose outcomes stayed equal.
    pub unchanged_cases: usize,
}

/// The tradeoffs of one revision comparison over the same cases.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RevisionTradeoffs {
    /// One row per scope and metric, in the check order of the
    /// definition.
    pub metrics: Vec<MetricTradeoff>,
}

/// The complete comparison of one prior policy and one revised policy
/// over the same stored fitting assessments.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RevisionComparison {
    /// The schema version of the core result documents.
    pub schema_version: u32,
    /// The prior side: the profile the stored assessments measured under.
    pub baseline: RevisionSide,
    /// The revised side: the plan that froze the candidate.
    pub candidate: RevisionSide,
    /// The evidence class of the comparison. Always `fitting`.
    pub evidence_class: EvidenceClass,
    /// Dataset of the fitting split.
    pub dataset: String,
    /// Revision of the fitting split.
    pub revision: String,
    /// Fitting split identifier.
    pub split: String,
    /// The matching of the two policies.
    pub matching: RevisionMatching,
    /// Every matched case with one changed component outcome, in fitting
    /// order.
    pub changed: Vec<ChangedCase>,
    /// The metric tradeoffs over the same cases.
    pub tradeoffs: RevisionTradeoffs,
    /// One row per scope and metric with the counts and the denominators
    /// of both sides.
    pub metrics: Vec<MetricRow>,
    /// The standing development-evidence statement.
    pub statement: &'static str,
    /// The standing limits of this comparison.
    pub limitations: Vec<String>,
}

/// Checks whether one revision may replay the stored assessments of one
/// prior calibration.
///
/// `prior_profile_text` is the candidate profile of the prior
/// calibration, `prior_fitting_text` its fitting report, and `prior_runs`
/// the stored measurement runs it produced, each as stored. `plan_text`
/// is the revision plan, `definition_text` the loaded definition,
/// `registered` the live registry, `live` the live binding state, and the
/// two dataset texts the loaded dataset of the revision. The texts cross
/// exactly as the wrappers read them.
///
/// The check changes nothing it reads. The returned assessments are the
/// stored values of the verified runs, keyed by case identifier and then
/// by question check identifier, ready for the fitting search and the
/// frozen validation.
///
/// # Errors
///
/// Returns a [`ValidationError`] with the failure of the profile, plan,
/// definition, or dataset contract for one broken artifact, with
/// `invalid_field_type` when the prior profile states another origin or
/// the stated runs disagree with the stated calibration, with
/// `definition_mismatch` when the prior profile or the plan binds another
/// definition, with `evaluator_mismatch`, `translation_mismatch`, or
/// `model_resolution_changed` when one binding identity changed, with
/// `hash_mismatch` when the loaded fitting split is not the recorded
/// split of the prior profile, when one stored run measured another
/// input, or when the stated runs bind two measurement profiles, and with
/// `duplicate_id` when two stored runs name one case.
// The boundary states every artifact the way the wrappers read them, so
// one input struct would name the same texts without grouping them.
#[allow(clippy::too_many_arguments)]
pub fn check_revision(
    prior_profile_text: &str,
    prior_fitting_text: &str,
    prior_runs: &[&str],
    plan_text: &str,
    definition_text: &str,
    registered: &[plan::RegisteredEvaluator],
    live: &[LiveBinding],
    metadata_text: &str,
    records_text: &str,
) -> Result<RevisionReuse, ValidationError> {
    if prior_runs.len() > MAX_STORED_RUNS {
        return Err(ValidationError::new(
            ReasonCode::OversizedInput,
            "/prior/runs",
            format!(
                "The revision states {} stored runs, above the limit {}. One calibration stores one run per measured case.",
                prior_runs.len(),
                MAX_STORED_RUNS
            ),
        ));
    }

    // The loaded definition, the prior profile, and the revision plan all
    // pass their own contracts first, so one broken artifact names its
    // field before one identity is compared.
    let definition = crate::definition::validate_definition_str(definition_text)?;
    let prior = profile::validate_profile_str(prior_profile_text)?;
    if prior.origin() != ProfileOrigin::Calibration {
        return Err(ValidationError::invalid_field_type(
            "/prior/origin",
            format!(
                "The prior profile {} states the origin {}. One revision replays the stored assessments of one calibration: an exploration profile states starter thresholds and an exact profile states no question check.",
                fragment(prior.id()),
                prior.origin().as_str()
            ),
        ));
    }
    let revision_plan = plan::validate_plan_str(plan_text)?;

    // The definition identity. One changed question, criterion, schema, or
    // input projection changes the definition hash, and both the prior
    // profile and the revision plan must bind the loaded revision.
    let definition_hash = hashing::definition_hash(&definition);
    if prior.definition_name() != definition.as_definition().name
        || prior.definition_hash() != definition_hash
    {
        return Err(ValidationError::new(
            ReasonCode::DefinitionMismatch,
            "/prior/definition",
            format!(
                "The prior profile binds the definition {} with one content hash of its own. The loaded definition differs, so one changed question, criterion, schema, or input projection changed the meaning that the stored assessments measured. Calibrate the loaded definition again.",
                fragment(prior.definition_name())
            ),
        ));
    }
    plan::check_plan_definition(&revision_plan, &definition, "/plan")?;

    // The evaluator identity. The plan measures with the registered
    // evaluator the prior profile bound, and the live state serves that
    // same binding today. `check_compatibility` in shadow mode compares
    // every binding, the coverage, and the policy fit with the registry
    // codes, exactly as one load does.
    plan::check_plan_evaluator(&revision_plan, registered, "/plan")?;
    check_plan_matches_bindings(&revision_plan, &prior)?;
    profile::check_compatibility(
        &prior,
        &definition,
        live,
        &profile::CompatibilityRequest {
            mode: RunMode::Shadow,
            requested_scope: None,
            selected_hash: None,
        },
        "/prior",
    )?;

    // The input identity. The loaded dataset validates against the
    // definition, offers both splits of the plan, and states the fitting
    // content the prior profile recorded.
    let dataset = dataset::load_dataset(metadata_text, records_text)?;
    dataset::validate_dataset(&dataset, &definition)?;
    let grouped = splits::dataset_splits(&dataset)?;
    let fitting_split = fitting::plan_split(&revision_plan, &grouped, SplitPurpose::Fitting)?;
    let validation_split = fitting::plan_split(&revision_plan, &grouped, SplitPurpose::Validation)?;
    splits::require_separated(fitting_split.identity(), validation_split.identity()).map_err(
        |mut error| {
            error.field_path = "/plan/datasets/validation".to_owned();
            error
        },
    )?;
    let fitting_identity = fitting_split.identity();
    let validation_identity = validation_split.identity();

    let evidence = prior_evidence(&prior)?;
    if evidence.dataset_id != grouped.identity().dataset_id {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/prior/evidence/datasets/0/id",
            format!(
                "The revision loads the dataset {}, but the prior profile records the dataset {}. The dataset identity names the calibration that stored the assessments.",
                fragment(&grouped.identity().dataset_id),
                fragment(&evidence.dataset_id)
            ),
        ));
    }
    if !evidence
        .splits
        .iter()
        .any(|split| split.content_hash == fitting_identity.content_hash)
    {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/prior/evidence/splits",
            format!(
                "The revision offers the fitting split {} with the content hash {}, but the prior profile records the split hashes {}. One changed or exchanged input needs new measurements, so calibrate the fitting split again.",
                fragment(&fitting_identity.split_id),
                fragment(&fitting_identity.content_hash),
                evidence
                    .splits
                    .iter()
                    .map(|split| fragment(&split.content_hash))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    // The dataset content hash is compared nowhere. One revision may load
    // one later revision of the same dataset that keeps the fitting
    // records and adds fresh validation data. The split content hashes
    // carry the input identity.

    // The prior fitting report binds the prior calibration, and its
    // status states which measurements exist.
    let prior_fitting = crate::json::parse_strict(prior_fitting_text)?;
    check_prior_fitting(&prior_fitting, &evidence, fitting_identity)?;

    // Every stored run rebuilds through the run report contract. One
    // calibration measures through one measurement profile and binds every
    // run to it, so the runs state one shared reference. The assessments
    // themselves carry their own identity: the definition hash, the case
    // input hash, and the evaluator record of every question check, which
    // the loop compares with the binding the prior profile records.
    let binding_of = |check: &str| {
        prior
            .bindings()
            .iter()
            .find(|binding| binding.check == check)
    };
    let fitting_records: Vec<&CaseRecord> = fitting_split.records().to_vec();
    let validation_records: Vec<&CaseRecord> = validation_split.records().to_vec();
    let mut fitting_assessments: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut validation_assessments: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut earlier_validation: usize = 0;
    let mut resolved_models: Vec<String> = Vec::new();
    let mut measurement: Option<(String, String)> = None;
    for (index, text) in prior_runs.iter().enumerate() {
        let run = report::parse_run_report_str(text).map_err(|error| at_run(error, index))?;
        let base = format!("/prior/runs/{index}");
        let bound = (run.profile().id.clone(), run.profile().content_hash.clone());
        match &measurement {
            None => measurement = Some(bound),
            Some(stated) if *stated != bound => {
                return Err(ValidationError::new(
                    ReasonCode::HashMismatch,
                    format!("{base}/profile/content_hash"),
                    format!(
                        "The stored run {} binds the measurement profile {}, but the stated runs measured under {}. One calibration measures through one measurement profile, so the stated runs mix two calibrations.",
                        fragment(run.run_id()),
                        fragment(&bound.0),
                        fragment(&stated.0)
                    ),
                ));
            }
            _ => {}
        }
        if run.definition().content_hash != definition_hash {
            return Err(ValidationError::new(
                ReasonCode::DefinitionMismatch,
                format!("{base}/definition/content_hash"),
                "The stored run binds another content hash of the definition. The revision replays assessments that measured the loaded definition.",
            ));
        }
        let fitting_record = fitting_records
            .iter()
            .find(|record| record.id == *run.case().id);
        let validation_record = validation_records
            .iter()
            .find(|record| record.id == *run.case().id);
        let record = match (fitting_record, validation_record) {
            (Some(record), _) | (_, Some(record)) => *record,
            (None, None) => {
                // The run measures one case of one earlier dataset
                // revision, which the loaded splits do not hold. It is
                // the prior validation measurement of other content: the
                // replay reads the splits of the plan alone, and the run
                // counts toward the measurements the prior calibration
                // claims.
                earlier_validation += 1;
                continue;
            }
        };
        if fitting_assessments.contains_key(record.id.as_str())
            || validation_assessments.contains_key(record.id.as_str())
        {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("{base}/case/id"),
                format!(
                    "Two stored runs name the case {}. One calibration stores one run per measured case.",
                    fragment(record.id.as_str())
                ),
            ));
        }
        if run.case().input_hash != hashing::input_hash(&record.input) {
            return Err(ValidationError::new(
                ReasonCode::HashMismatch,
                format!("{base}/case/input_hash"),
                format!(
                    "The stored run {} names the case {} with another input hash. One edited input needs new measurements, so measure the case again.",
                    fragment(run.run_id()),
                    fragment(record.id.as_str())
                ),
            ));
        }
        let mut by_check: Map<String, Value> = Map::new();
        for check in run.checks() {
            if check.kind == RecordKind::Rule {
                continue;
            }
            let Some(binding) = binding_of(&check.check) else {
                return Err(ValidationError::new(
                    ReasonCode::EvaluatorMismatch,
                    format!("{base}/checks/{}", check.check),
                    format!(
                        "The stored run {} names the check {}, which the prior profile binds no evaluator for. One revision replays the assessments of the checks the prior profile measured.",
                        fragment(run.run_id()),
                        fragment(&check.check)
                    ),
                ));
            };
            if let Some(versions) = &check.evaluator {
                if versions.id != binding.evaluator
                    || versions.adapter_version != binding.adapter_version
                {
                    return Err(ValidationError::new(
                        ReasonCode::EvaluatorMismatch,
                        format!("{base}/checks/{}/evaluator", check.check),
                        format!(
                            "The stored assessment of the check {} was measured with the evaluator {} of the adapter version {}, but the prior profile binds {} of {}. One changed evaluator needs new measurements.",
                            fragment(&check.check),
                            fragment(&versions.id),
                            fragment(&versions.adapter_version),
                            fragment(&binding.evaluator),
                            fragment(&binding.adapter_version)
                        ),
                    ));
                }
            }
            let Some(assessment) = &check.assessment else {
                return Err(ValidationError::new(
                    ReasonCode::MissingField,
                    format!("{base}/checks/{}", check.check),
                    format!(
                        "The stored run {} records the outcome {} of the check {} with no assessment. One revision replays one stored assessment of every question check, so calibrate the case again.",
                        fragment(run.run_id()),
                        check.outcome.as_str(),
                        fragment(&check.check)
                    ),
                ));
            };
            if let Some(model) = check
                .evaluator
                .as_ref()
                .and_then(|versions| versions.model_resolved.as_deref())
            {
                if let Some(recorded) = binding
                    .model
                    .as_ref()
                    .and_then(|model| model.resolved.as_deref())
                {
                    if model != recorded {
                        return Err(ValidationError::new(
                            ReasonCode::ModelResolutionChanged,
                            format!("{base}/checks/{}/evaluator/model_resolved", check.check),
                            format!(
                                "The stored assessment of the check {} resolved the model {}, but the prior profile records {}. One changed resolution needs new measurements.",
                                fragment(&check.check),
                                fragment(model),
                                fragment(recorded)
                            ),
                        ));
                    }
                }
                if !resolved_models.iter().any(|stated| stated == model) {
                    if !resolved_models.is_empty() {
                        return Err(ValidationError::new(
                            ReasonCode::ModelResolutionChanged,
                            format!("{base}/checks/{}/evaluator/model_resolved", check.check),
                            format!(
                                "The stored assessments resolved {} model versions ({}). One revision replays assessments that measured with one model.",
                                resolved_models.len() + 1,
                                resolved_models
                                    .iter()
                                    .map(|stated| fragment(stated))
                                    .chain([fragment(model)])
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                        ));
                    }
                    resolved_models.push(model.to_owned());
                }
            }
            by_check.insert(check.check.clone(), assessment.clone());
        }
        if fitting_record.is_some() {
            fitting_assessments.insert(record.id.clone(), by_check);
        } else {
            validation_assessments.insert(record.id.clone(), by_check);
        }
    }

    // The fitting coverage: one stored assessment of every fitting case.
    let stored_fitting = fitting_assessments.len();
    if stored_fitting != fitting_records.len() {
        let missing = fitting_records
            .iter()
            .find(|record| !fitting_assessments.contains_key(record.id.as_str()))
            .expect("the counts differ, so one fitting case states no run");
        return Err(ValidationError::new(
            ReasonCode::MissingField,
            format!("/prior/runs (the case {})", missing.id),
            format!(
                "The stored runs measure {} of the {} fitting cases, and the case {} states none. One revision replays one stored assessment of every fitting case, so state the complete prior calibration.",
                stored_fitting,
                fitting_records.len(),
                fragment(&missing.id)
            ),
        ));
    }

    // The validation data. The stored runs that name cases of the loaded
    // validation split are the prior validation measurements, and the
    // prior calibration itself cross-checks that they exist.
    let stored_validation = validation_assessments.len();
    let validation_data = if stored_validation == 0 {
        ValidationData::Fresh
    } else {
        ValidationData::Reused {
            cases: stored_validation,
        }
    };
    check_prior_claimed_validation(
        &prior,
        &prior_fitting,
        stored_validation + earlier_validation,
    )?;

    let bindings = prior
        .bindings()
        .iter()
        .map(|binding| RevisionBindingRow {
            check: binding.check.clone(),
            evaluator: binding.evaluator.clone(),
            adapter_version: binding.adapter_version.clone(),
            translation_hash: binding.translation_hash.clone(),
            model_requested: binding.model.as_ref().map(|model| model.requested.clone()),
            model_resolved: binding
                .model
                .as_ref()
                .and_then(|model| model.resolved.clone())
                .or_else(|| resolved_models.first().cloned()),
            preprocessing: binding.preprocessing.clone(),
        })
        .collect();
    Ok(RevisionReuse {
        statement: reuse_statement(
            prior.id(),
            fitting_identity,
            stored_fitting,
            validation_identity,
            &validation_data,
        ),
        prior_profile_id: prior.id().to_owned(),
        prior_profile_content_hash: prior.content_hash().to_owned(),
        prior_plan: evidence.plan,
        prior_dataset: evidence.dataset_id,
        prior_splits: evidence.splits,
        definition_name: definition.as_definition().name.clone(),
        definition_hash,
        bindings,
        fitting_split: LoadedSplitRow {
            id: fitting_identity.split_id.clone(),
            revision: fitting_identity.revision.clone(),
            content_hash: fitting_identity.content_hash.clone(),
            record_count: fitting_records.len(),
        },
        validation_split: LoadedSplitRow {
            id: validation_identity.split_id.clone(),
            revision: validation_identity.revision.clone(),
            content_hash: validation_identity.content_hash.clone(),
            record_count: validation_records.len(),
        },
        stored_fitting_cases: stored_fitting,
        validation_data,
        resolved_models,
        fitting_assessments: Value::Object(
            fitting_assessments
                .into_iter()
                .map(|(case, by_check)| (case, Value::Object(by_check)))
                .collect(),
        ),
        validation_assessments: match stored_validation {
            0 => None,
            _ => Some(Value::Object(
                validation_assessments
                    .into_iter()
                    .map(|(case, by_check)| (case, Value::Object(by_check)))
                    .collect(),
            )),
        },
        limitations: vec![
            REUSE_STATEMENT.to_owned(),
            "The reuse check verifies content consistency alone. It cannot verify the truth of one forged dataset, one label, or one host approval, and the evaluation-report references name host storage that it reads none of.".to_owned(),
        ],
    })
}

/// Compares the prior policy and one revised policy over the same stored
/// fitting assessments.
///
/// `prior_profile_text` is the prior profile, which states the applied
/// policy the stored assessments last served. `plan_text` is the revision
/// plan, `revised_policy_text` one applied-policy row per question check
/// of the frozen candidate, and `assessments_text` the stored fitting
/// assessments exactly as [`check_revision`] returned them. The dataset
/// texts cross as the wrapper read them.
///
/// Every case of the fitting split replays under both policies through
/// the same decision one run reads, so one row of the result states two
/// outcomes of the same stored assessment. The comparison holds no raw
/// case content and changes no qualification.
///
/// # Errors
///
/// Returns a [`ValidationError`] with the failure of the profile, plan,
/// definition, or dataset contract for one broken artifact, with
/// `policy_mismatch` at `/revised_policy/<field>` for one policy row that
/// fits no question check, with the failure of [`fitting::prepare_cases`]
/// at `/assessments/<case>/<check>` for one broken stored assessment, and
/// with `invalid_field_type` when the two policies state more decisions
/// than the published limit.
pub fn compare_revision(
    prior_profile_text: &str,
    plan_text: &str,
    revised_policy_text: &str,
    metadata_text: &str,
    records_text: &str,
    definition_text: &str,
    assessments_text: &str,
) -> Result<RevisionComparison, ValidationError> {
    let definition = crate::definition::validate_definition_str(definition_text)?;
    let prior = profile::validate_profile_str(prior_profile_text)?;
    let revision_plan = plan::validate_plan_str(plan_text)?;
    plan::check_plan_definition(&revision_plan, &definition, "/plan")?;
    let dataset = dataset::load_dataset(metadata_text, records_text)?;
    dataset::validate_dataset(&dataset, &definition)?;
    let grouped = splits::dataset_splits(&dataset)?;
    let fitting_split = fitting::plan_split(&revision_plan, &grouped, SplitPurpose::Fitting)?;
    let identity = fitting_split.identity();
    let records = fitting_split.records();
    if records.is_empty() {
        return Err(ValidationError::new(
            ReasonCode::InsufficientEvidence,
            "/plan/datasets/fitting",
            "The fitting split holds no record, so no case replays under either policy.",
        ));
    }
    if 2 * records.len() > MAX_COMPARISON_DECISIONS {
        return Err(ValidationError::invalid_field_type(
            "/plan/datasets/fitting",
            format!(
                "The comparison states {} policy decisions over {} fitting cases, above the limit {}. Narrow the fitting split.",
                2 * records.len(),
                records.len(),
                MAX_COMPARISON_DECISIONS
            ),
        ));
    }

    let baseline_policy = read_profile_policy(&prior, &definition, "/prior/policy/checks")?;
    let candidate_policy = read_policy_rows(revised_policy_text, &definition, "/revised_policy")?;
    let assessments = crate::json::parse_strict(assessments_text)?;
    let cases = fitting::prepare_cases(
        &definition,
        records,
        &assessments,
        "fitting",
        "The revision comparison",
    )?;
    let checks = &definition.as_definition().checks;
    let check_ids: Vec<&str> = checks.iter().map(|check| check.id.as_str()).collect();

    let mut changed = Vec::new();
    let mut baseline_confusions = vec![ConfusionMatrix::default(); checks.len() + 1];
    let mut candidate_confusions = vec![ConfusionMatrix::default(); checks.len() + 1];
    for (record, case) in records.iter().zip(&cases) {
        let mut baseline_changed_checks = Vec::new();
        let mut baseline_outcomes = Vec::with_capacity(checks.len());
        let mut candidate_outcomes = Vec::with_capacity(checks.len());
        for (slot, answer) in case.answers.iter().enumerate() {
            let (baseline, candidate) = match answer {
                Answer::Question(value) => {
                    let baseline = policy::decide(
                        &definition,
                        check_ids[slot],
                        value,
                        baseline_policy[slot]
                            .as_ref()
                            .expect("one question check states one policy"),
                    )
                    .map_err(|error| at(error, &case.path, check_ids[slot]))?;
                    let candidate = policy::decide(
                        &definition,
                        check_ids[slot],
                        value,
                        candidate_policy[slot]
                            .as_ref()
                            .expect("one question check states one policy"),
                    )
                    .map_err(|error| at(error, &case.path, check_ids[slot]))?;
                    (baseline, candidate)
                }
                Answer::Rule(outcome) => (*outcome, *outcome),
            };
            baseline_outcomes.push(baseline);
            candidate_outcomes.push(candidate);
            baseline_confusions[slot].record(case.references[slot], baseline);
            candidate_confusions[slot].record(case.references[slot], candidate);
            if baseline != candidate {
                baseline_changed_checks.push(ChangedCheck {
                    check: check_ids[slot].to_owned(),
                    baseline,
                    candidate,
                });
            }
        }
        let baseline_aggregate = report::aggregate(&baseline_outcomes)
            .expect("the definition states one check at least");
        let candidate_aggregate = report::aggregate(&candidate_outcomes)
            .expect("the definition states one check at least");
        baseline_confusions[checks.len()]
            .record(case.overall, metrics::component(baseline_aggregate));
        candidate_confusions[checks.len()]
            .record(case.overall, metrics::component(candidate_aggregate));
        if !baseline_changed_checks.is_empty() {
            changed.push(ChangedCase {
                id: record.id.clone(),
                checks: baseline_changed_checks,
                baseline_aggregate,
                candidate_aggregate,
            });
        }
    }

    // One metric set per check of the definition, then the complete check
    // set, exactly as the fitting search and the evaluation state them.
    let scope_names = metrics::scope_names(&check_ids);
    let baseline_scopes: Vec<MetricSet> = scope_names
        .iter()
        .zip(baseline_confusions)
        .map(|(scope, confusion)| MetricSet::assemble(scope.clone(), confusion))
        .collect();
    let candidate_scopes: Vec<MetricSet> = scope_names
        .into_iter()
        .zip(candidate_confusions)
        .map(|(scope, confusion)| MetricSet::assemble(scope, confusion))
        .collect();
    let mut tradeoff_rows = Vec::new();
    let mut metric_rows = Vec::new();
    for (baseline_set, candidate_set) in baseline_scopes.iter().zip(&candidate_scopes) {
        for (baseline_rate, candidate_rate) in baseline_set.rates.iter().zip(&candidate_set.rates) {
            tradeoff_rows.push(MetricTradeoff {
                scope: baseline_set.scope.clone(),
                metric: baseline_rate.metric,
                baseline_value: baseline_rate.value,
                candidate_value: candidate_rate.value,
            });
            metric_rows.push(MetricRow {
                scope: baseline_set.scope.clone(),
                metric: baseline_rate.metric,
                baseline: *baseline_rate,
                candidate: *candidate_rate,
            });
        }
    }

    let matched = cases.len();
    let changed_count = changed.len();
    Ok(RevisionComparison {
        schema_version: crate::CONTRACT_SCHEMA_VERSION,
        baseline: RevisionSide {
            source: IdentityRow {
                id: prior.id().to_owned(),
                content_hash: prior.content_hash().to_owned(),
            },
            policy: policy_rows(&check_ids, &baseline_policy),
        },
        candidate: RevisionSide {
            source: IdentityRow {
                id: revision_plan.id().to_owned(),
                content_hash: revision_plan.content_hash().to_owned(),
            },
            policy: policy_rows(&check_ids, &candidate_policy),
        },
        evidence_class: EvidenceClass::Fitting,
        dataset: identity.dataset_id.clone(),
        revision: identity.revision.clone(),
        split: identity.split_id.clone(),
        matching: RevisionMatching {
            matched_cases: matched,
            changed_cases: changed_count,
            unchanged_cases: matched - changed_count,
        },
        changed,
        tradeoffs: RevisionTradeoffs {
            metrics: tradeoff_rows,
        },
        metrics: metric_rows,
        statement: COMPARISON_STATEMENT,
        limitations: vec![
            COMPARISON_STATEMENT.to_owned(),
            "Input hashes detect changed inputs alone, so one change of evaluator behavior needs new measurements that no comparison can replace.".to_owned(),
        ],
    })
}

// ---------------------------------------------------------------------------
// The readers of the prior artifacts.
// ---------------------------------------------------------------------------

/// The recorded evidence of one prior calibration profile.
struct PriorEvidence {
    /// The plan the profile records.
    plan: IdentityRow,
    /// The dataset identifier the profile records.
    dataset_id: String,
    /// Every recorded split.
    splits: Vec<IdentityRow>,
}

/// Reads the recorded evidence of one prior calibration profile.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `missing_field` when the profile
/// records no complete evidence set, and with `invalid_field_type` for
/// one broken reference.
fn prior_evidence(prior: &ValidatedProfile) -> Result<PriorEvidence, ValidationError> {
    let root = prior.as_artifact();
    let Some(evidence) = root.get("evidence") else {
        return Err(ValidationError::missing("/prior/evidence"));
    };
    let evidence = crate::artifact::expect_object(evidence, "/prior/evidence")?;
    let plan = required_object(evidence, "plan", "/prior/evidence/plan")?;
    let plan_row = IdentityRow {
        id: required_artifact_id(plan, "id", "/prior/evidence/plan/id")?,
        content_hash: required_hash(plan, "content_hash", "/prior/evidence/plan/content_hash")?,
    };
    let Value::Array(datasets) = evidence.get("datasets").ok_or_else(missing_datasets)? else {
        return Err(ValidationError::invalid_field_type(
            "/prior/evidence/datasets",
            "The datasets field must hold one array.",
        ));
    };
    if datasets.len() != 1 {
        return Err(ValidationError::invalid_field_type(
            "/prior/evidence/datasets",
            format!(
                "The evidence records {} datasets. One calibration reads one dataset revision, so the reuse verifies one recorded dataset.",
                datasets.len()
            ),
        ));
    }
    let dataset = crate::artifact::expect_object(&datasets[0], "/prior/evidence/datasets/0")?;
    let dataset_id = required_artifact_id(dataset, "id", "/prior/evidence/datasets/0/id")?;
    let Value::Array(splits) = evidence.get("splits").ok_or_else(missing_splits)? else {
        return Err(ValidationError::invalid_field_type(
            "/prior/evidence/splits",
            "The splits field must hold one array.",
        ));
    };
    if splits.is_empty() {
        return Err(missing_splits());
    }
    let mut rows = Vec::with_capacity(splits.len());
    for (index, split) in splits.iter().enumerate() {
        let base = format!("/prior/evidence/splits/{index}");
        let split = crate::artifact::expect_object(split, &base)?;
        rows.push(IdentityRow {
            id: required_artifact_id(split, "id", &format!("{base}/id"))?,
            content_hash: required_hash(split, "content_hash", &format!("{base}/content_hash"))?,
        });
    }
    Ok(PriorEvidence {
        plan: plan_row,
        dataset_id,
        splits: rows,
    })
}

/// The failure of one absent dataset reference.
fn missing_datasets() -> ValidationError {
    ValidationError::missing("/prior/evidence/datasets")
}

/// The failure of one absent split reference.
fn missing_splits() -> ValidationError {
    ValidationError::new(
        ReasonCode::MissingField,
        "/prior/evidence/splits",
        "One calibration profile records its splits. The reuse compares the recorded fitting split with the loaded split.",
    )
}

/// Checks that the revision plan measures with the evaluator the prior
/// profile bound.
///
/// The plan states one evaluator configuration for every check, and the
/// prior profile binds one evaluator per check, so one shared
/// configuration means every stored assessment measured under the
/// configuration the revision requests.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `evaluator_mismatch` when the plan
/// names another evaluator or adapter version, with `translation_mismatch`
/// when the plan freezes another translated question, and with
/// `model_resolution_changed` when the plan requests another model.
fn check_plan_matches_bindings(
    plan: &ValidatedPlan,
    prior: &ValidatedProfile,
) -> Result<(), ValidationError> {
    let configuration = plan.evaluator();
    for binding in prior.bindings() {
        let base = format!("/plan/evaluator (the check {})", binding.check);
        if configuration.evaluator != binding.evaluator
            || configuration.adapter_version != binding.adapter_version
        {
            return Err(ValidationError::new(
                ReasonCode::EvaluatorMismatch,
                base,
                format!(
                    "The revision plan measures with the evaluator {} of the adapter version {}, but the stored assessments measured with {} of {}. One changed evaluator needs new measurements.",
                    fragment(&configuration.evaluator),
                    fragment(&configuration.adapter_version),
                    fragment(&binding.evaluator),
                    fragment(&binding.adapter_version)
                ),
            ));
        }
        if let Some(plan_hash) = &configuration.translation_hash {
            if *plan_hash != binding.translation_hash {
                return Err(ValidationError::new(
                    ReasonCode::TranslationMismatch,
                    format!("{base}/translation"),
                    format!(
                        "The revision plan freezes the translated question {}, but the stored assessments measured the translated question {}. One changed translation needs new measurements.",
                        fragment(plan_hash),
                        fragment(&binding.translation_hash)
                    ),
                ));
            }
        }
        let requested = binding.model.as_ref().map(|model| model.requested.as_str());
        if configuration.model_requested.as_deref() != requested {
            return Err(ValidationError::new(
                ReasonCode::ModelResolutionChanged,
                format!("{base}/model"),
                format!(
                    "The revision plan requests the model {}, but the stored assessments measured with {}. One changed model needs new measurements.",
                    fragment(configuration.model_requested.as_deref().unwrap_or("no model")),
                    fragment(requested.unwrap_or("no model"))
                ),
            ));
        }
    }
    Ok(())
}

/// Checks that the stated prior fitting report is the report of the prior
/// calibration.
///
/// The report states many fields the reuse needs none of, so this reader
/// states the three it reads and compares: the plan identity the profile
/// records, the fitting split the revision loads, and the search status
/// that states which measurements exist.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` when the
/// report holds no object, with `hash_mismatch` when it binds another
/// plan or another fitting split, and with `invalid_field_type` when its
/// status words no search result.
fn check_prior_fitting(
    fitting: &Value,
    evidence: &PriorEvidence,
    fitting_identity: &SplitIdentity,
) -> Result<(), ValidationError> {
    let root = crate::artifact::expect_object(fitting, "/prior/fitting")?;
    let plan_hash = required_hash(
        root,
        "plan_content_hash",
        "/prior/fitting/plan_content_hash",
    )?;
    if plan_hash != evidence.plan.content_hash {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/prior/fitting/plan_content_hash",
            format!(
                "The stated fitting report binds the plan {}, but the prior profile records the plan {}. State the fitting report of the stated calibration.",
                fragment(&plan_hash),
                fragment(&evidence.plan.content_hash)
            ),
        ));
    }
    let split_hash = required_hash(
        root,
        "split_content_hash",
        "/prior/fitting/split_content_hash",
    )?;
    if split_hash != fitting_identity.content_hash {
        return Err(ValidationError::new(
            ReasonCode::HashMismatch,
            "/prior/fitting/split_content_hash",
            format!(
                "The stated fitting report measured the split with the content hash {}, but the revision loads {}. State the fitting report of the stated calibration.",
                fragment(&split_hash),
                fragment(&fitting_identity.content_hash)
            ),
        ));
    }
    match root.get("status").and_then(Value::as_str) {
        Some("feasible") | Some("no_feasible_candidate") => Ok(()),
        _ => Err(ValidationError::invalid_field_type(
            "/prior/fitting/status",
            "The stated fitting report states no search status. It names whether the prior search found one feasible candidate, and the reuse reads it to state which measurements exist.",
        )),
    }
}

/// Cross-checks the stated stored runs against the prior calibration.
///
/// One calibration that froze one candidate measured its validation
/// split, and one calibration without one feasible candidate measured
/// none. The qualification status of the prior profile and the search
/// status of the prior fitting report state which one ran, so the stated
/// runs cannot drop the validation measurements of one consumed split
/// and cannot invent validation measurements that one unfinished
/// calibration never made.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` at `/prior`
/// when the stated runs disagree with the stated calibration.
fn check_prior_claimed_validation(
    prior: &ValidatedProfile,
    prior_fitting: &Value,
    stored_validation: usize,
) -> Result<(), ValidationError> {
    let fitting_status = prior_fitting
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let claimed_one = prior.qualification() == profile::Qualification::ValidatedForScope
        || prior.qualification() == profile::Qualification::InsufficientEvidence
        || fitting_status == "feasible";
    if claimed_one && stored_validation == 0 {
        return Err(ValidationError::invalid_field_type(
            "/prior/runs",
            format!(
                "The prior calibration of the profile {} froze one candidate and measured one validation split, but the stated runs hold no validation case. State the complete prior calibration.",
                fragment(prior.id())
            ),
        ));
    }
    if fitting_status == "no_feasible_candidate" && stored_validation > 0 {
        return Err(ValidationError::invalid_field_type(
            "/prior/runs",
            format!(
                "The stated fitting report of the profile {} found no feasible candidate, so that calibration measured no validation case, but the stated runs hold {}. State the runs of the stated calibration.",
                fragment(prior.id()),
                stored_validation
            ),
        ));
    }
    Ok(())
}

/// Reads the applied policy of one prior profile, one row per check of
/// the definition in definition order. One rule check states `None`,
/// because no policy decides it.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `policy_mismatch` when the profile
/// states no policy for one question check of the definition.
fn read_profile_policy(
    prior: &ValidatedProfile,
    definition: &ValidatedDefinition,
    base: &str,
) -> Result<Vec<Option<AppliedPolicy>>, ValidationError> {
    let by_check: BTreeMap<&str, AppliedPolicy> = prior
        .policy_checks()
        .iter()
        .map(|entry| (entry.check.as_str(), entry.policy.clone()))
        .collect();
    let mut policies = Vec::with_capacity(definition.as_definition().checks.len());
    for check in &definition.as_definition().checks {
        match definition.check_kind(&check.id) {
            Some(CheckKind::Rule) => policies.push(None),
            _ => {
                let Some(policy) = by_check.get(check.id.as_str()) else {
                    return Err(ValidationError::new(
                        ReasonCode::PolicyMismatch,
                        format!("{base} (the check {})", check.id),
                        format!(
                            "The prior profile states no policy for the question check {}. The comparison replays one policy of every question check.",
                            fragment(&check.id)
                        ),
                    ));
                };
                policies.push(Some(policy.clone() as AppliedPolicy));
            }
        }
    }
    Ok(policies)
}

/// Reads one applied-policy row per question check, one row per check of
/// the definition in definition order. One rule check states `None`.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` for one broken
/// row, with `policy_mismatch` when one row names no question check or
/// one question check states no row, and with `duplicate_id` when one
/// check states two rows.
fn read_policy_rows(
    text: &str,
    definition: &ValidatedDefinition,
    base: &str,
) -> Result<Vec<Option<AppliedPolicy>>, ValidationError> {
    let value = crate::json::parse_strict(text)?;
    let Value::Array(rows) = value else {
        return Err(ValidationError::invalid_field_type(
            base,
            "The revised policy must hold one array of one applied-policy row per question check.",
        ));
    };
    let mut by_check: BTreeMap<String, AppliedPolicy> = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let row_base = format!("{base}/{index}");
        let row = crate::artifact::expect_object(row, &row_base)?;
        crate::artifact::reject_unknown_fields(
            row,
            &[
                "check",
                "accept_cutoff",
                "rejection_cutoff",
                "confidence_floor",
            ],
            &row_base,
        )?;
        let check = required_artifact_id(row, "check", &format!("{row_base}/check"))?;
        match definition.check_kind(&check) {
            None => {
                return Err(ValidationError::new(
                    ReasonCode::PolicyMismatch,
                    format!("{row_base}/check"),
                    format!(
                        "The revised policy names no check of the definition: {}.",
                        fragment(&check)
                    ),
                ));
            }
            Some(CheckKind::Rule) => {
                return Err(ValidationError::new(
                    ReasonCode::PolicyMismatch,
                    format!("{row_base}/check"),
                    format!(
                        "The revised policy names one rule check: {}. One rule check records its executed rule and takes no decision policy.",
                        fragment(&check)
                    ),
                ));
            }
            _ => {}
        }
        if by_check.contains_key(&check) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("{row_base}/check"),
                format!(
                    "Two revised policy rows name the check {}.",
                    fragment(&check)
                ),
            ));
        }
        let policy = AppliedPolicy {
            accept_cutoff: required_cutoff(row, "accept_cutoff", &row_base)?,
            rejection_cutoff: required_cutoff(row, "rejection_cutoff", &row_base)?,
            confidence_floor: match row.get("confidence_floor") {
                None => None,
                Some(_) => Some(required_cutoff(row, "confidence_floor", &row_base)?),
            },
        };
        policy::validate_policy(definition, &check, &policy, &row_base)?;
        by_check.insert(check, policy);
    }
    let mut policies = Vec::with_capacity(definition.as_definition().checks.len());
    for check in &definition.as_definition().checks {
        match definition.check_kind(&check.id) {
            Some(CheckKind::Rule) => policies.push(None),
            _ => {
                let Some(policy) = by_check.remove(check.id.as_str()) else {
                    return Err(ValidationError::new(
                        ReasonCode::PolicyMismatch,
                        format!("{base} (the check {})", check.id),
                        format!(
                            "The revised policy states no row for the question check {}. One candidate applies one policy to every question check.",
                            fragment(&check.id)
                        ),
                    ));
                };
                policies.push(Some(policy));
            }
        }
    }
    Ok(policies)
}

/// Builds the policy rows of one side, in definition order.
fn policy_rows(check_ids: &[&str], policies: &[Option<AppliedPolicy>]) -> Vec<PolicyRow> {
    check_ids
        .iter()
        .zip(policies)
        .filter_map(|(check, policy)| {
            policy.clone().map(|policy| PolicyRow {
                check: (*check).to_owned(),
                policy,
            })
        })
        .collect()
}

/// Moves one failure under the run index it crossed with.
fn at_run(mut error: ValidationError, index: usize) -> ValidationError {
    error.field_path = format!("/prior/runs/{index}{}", error.field_path);
    error
}

/// Moves one failure under one case and check prefix.
fn at(mut error: ValidationError, case: &str, check: &str) -> ValidationError {
    error.field_path = format!("{case}/{check}{}", error.field_path);
    error
}

/// Reads one required artifact identifier at `base`.
fn required_artifact_id(
    object: &Map<String, Value>,
    name: &str,
    base: &str,
) -> Result<String, ValidationError> {
    match object.get(name) {
        Some(Value::String(value)) if is_artifact_id(value) => Ok(value.clone()),
        Some(_) => Err(ValidationError::invalid_field_type(
            base,
            "The identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
        )),
        None => Err(ValidationError::missing(base)),
    }
}

/// Reads one required content hash at `base`.
fn required_hash(
    object: &Map<String, Value>,
    name: &str,
    base: &str,
) -> Result<String, ValidationError> {
    match object.get(name) {
        Some(Value::String(value)) if hashing::is_hash_hex(value) => Ok(value.clone()),
        Some(_) => Err(ValidationError::invalid_field_type(
            base,
            "The content hash must hold 64 lowercase hexadecimal characters.",
        )),
        None => Err(ValidationError::missing(base)),
    }
}

/// Reads one required object at `base`.
fn required_object<'a>(
    object: &'a Map<String, Value>,
    name: &str,
    base: &str,
) -> Result<&'a Map<String, Value>, ValidationError> {
    match object.get(name) {
        Some(value) => crate::artifact::expect_object(value, base),
        None => Err(ValidationError::missing(base)),
    }
}

/// Reads one required policy cutoff at `base`, above 0.5 and at most 1.
fn required_cutoff(
    object: &Map<String, Value>,
    name: &str,
    base: &str,
) -> Result<f64, ValidationError> {
    let base = format!("{base}/{name}");
    match object.get(name) {
        Some(Value::Number(number)) => match number.as_f64() {
            Some(value) if value > 0.5 && value <= 1.0 => Ok(value),
            _ => Err(ValidationError::invalid_field_type(
                base,
                "The cutoff must hold one number above 0.5 and at most 1.",
            )),
        },
        Some(_) => Err(ValidationError::invalid_field_type(
            base,
            "The cutoff must hold one number above 0.5 and at most 1.",
        )),
        None => Err(ValidationError::missing(base)),
    }
}

/// States one reuse with its counts.
fn reuse_statement(
    profile_id: &str,
    fitting: &SplitIdentity,
    stored_fitting: usize,
    validation: &SplitIdentity,
    data: &ValidationData,
) -> String {
    match data {
        ValidationData::Reused { cases } => format!(
            "The revision reuses the stored assessments of the profile {} for the {} cases of the fitting split {} and the {} cases of the validation split {}. The prior calibration measured that validation split, so it is development data: one new qualification claim needs fresh independent evidence.",
            fragment(profile_id),
            stored_fitting,
            fitting.reference(),
            cases,
            validation.reference()
        ),
        ValidationData::Fresh => format!(
            "The revision reuses the stored assessments of the profile {} for the {} cases of the fitting split {}. No stored assessment names one case of the validation split {}, so the revision measures it through the registered evaluator.",
            fragment(profile_id),
            stored_fitting,
            fitting.reference(),
            validation.reference()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::load_dataset;
    use crate::definition::validate_definition_str;
    use crate::report::Outcome;
    use serde_json::json;

    /// The authored text of one definition with one categorical question
    /// and one exact rule, so one revision replays both kinds and the
    /// aggregate folds them. One optional mutation changes the question
    /// wording, the input schema, or the input projection, and every one
    /// of the three changes the definition hash.
    fn definition_text(mutation: Option<&str>) -> String {
        let mut question = "Does every material claim follow from the evidence?";
        let mut inputs = json!({
            "prior_decision": {"type": "string", "minLength": 1},
            "conversation": {"type": "string", "minLength": 1},
            "proposed_message": {"type": "string", "minLength": 1}
        });
        let mut using = json!(["prior_decision", "conversation", "proposed_message"]);
        match mutation {
            Some("question") => question = "Does every claim follow from the evidence?",
            Some("schema") => {
                inputs["proposed_message"] = json!({"type": "string", "minLength": 2});
            }
            Some("projection") => {
                using = json!(["prior_decision", "conversation"]);
            }
            _ => {}
        }
        serde_json::to_string(&json!({
            "schema_version": 1,
            "name": "message-supported",
            "inputs": {
                "type": "object",
                "properties": inputs,
                "required": ["prior_decision", "conversation", "proposed_message"],
                "additionalProperties": false
            },
            "checks": [
                {
                    "id": "message-supported",
                    "name": "Our message accurately describes the evidence",
                    "using": using,
                    "question": question,
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
        }))
        .expect("serializes")
    }

    /// One validated definition of the shared tests.
    fn definition() -> ValidatedDefinition {
        validate_definition_str(&definition_text(None)).expect("the definition validates")
    }

    /// One metadata artifact whose fitting split holds one group and whose
    /// validation split holds one stated group, so one fresh validation
    /// split names another group of the same dataset.
    fn metadata(validation_group: &str) -> Value {
        json!({
            "schema_version": 1,
            "id": "revision-cases",
            "revision": "2026-09-24.1",
            "kind": "representative_sample",
            "intended_population": "Proposed messages in support conversations.",
            "sampling_method": "Sampled at random from reviewed traffic of one week.",
            "label_guidelines": "See docs/labeling.md revision 3.",
            "splits": [
                {"id": "fit", "purpose": "fitting", "groups": ["conversation-a"]},
                {"id": "holdout", "purpose": "validation", "groups": [validation_group]}
            ]
        })
    }

    /// One record of one designed case. The exact rule passes every case.
    fn record(id: &str, group: &str, reference: &str) -> Value {
        json!({
            "id": id,
            "group": group,
            "input": {
                "prior_decision": "Customer exports stay in the EU.",
                "conversation": "The new export worker stays in the EU region.",
                "proposed_message": "The export worker serves EU customers."
            },
            "expected": {
                "checks": {
                    "message-supported": {"answer": reference},
                    "message-length": {"outcome": "pass"}
                }
            },
            "label": {"author_type": "human", "reviewed": true, "reviewer": "reviewer-1"}
        })
    }

    /// The fitting cases: two clear passes, one clear failure, and one
    /// 0.75 case that accepts at one 0.6 cutoff and reviews at one 0.85
    /// cutoff, so one revision changes its outcome.
    fn fitting_records() -> Vec<Value> {
        vec![
            record("fit-1", "conversation-a", "supported"),
            record("fit-2", "conversation-a", "supported"),
            record("fit-3", "conversation-a", "contradicted"),
            record("fit-4", "conversation-a", "supported"),
        ]
    }

    /// The validation cases of the loaded holdout.
    fn validation_records() -> Vec<Value> {
        vec![
            record("hold-1", "conversation-b", "supported"),
            record("hold-2", "conversation-b", "contradicted"),
        ]
    }

    /// Serializes records into one record file.
    fn file(records: &[Value]) -> String {
        records
            .iter()
            .map(|value| serde_json::to_string(value).expect("serializes"))
            .collect::<Vec<_>>()
            .join("\n")
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

    /// The stored assessments of the fitting cases, keyed as the reuse
    /// returns them.
    fn fitting_assessments() -> Value {
        json!({
            "fit-1": {"message-supported": assessment(0.95, 0.03, 0.02)},
            "fit-2": {"message-supported": assessment(0.90, 0.06, 0.04)},
            "fit-3": {"message-supported": assessment(0.05, 0.10, 0.85)},
            "fit-4": {"message-supported": assessment(0.75, 0.15, 0.10)}
        })
    }

    /// The stored assessments of the loaded validation cases.
    fn validation_assessments() -> Value {
        json!({
            "hold-1": {"message-supported": assessment(0.95, 0.03, 0.02)},
            "hold-2": {"message-supported": assessment(0.05, 0.10, 0.85)}
        })
    }

    /// The translation content hash of the shared binding.
    const TRANSLATION: &str = "a5065efe5f955d002a550c9598efeb1217b0b402db10efda842f10682a2ec65b";

    /// One live binding entry of the shared tests.
    fn live() -> Vec<LiveBinding> {
        vec![LiveBinding {
            check: "message-supported".to_owned(),
            evaluator: "jev-choice".to_owned(),
            adapter_version: "0.1.0".to_owned(),
            translation: Some(TRANSLATION.to_owned()),
            resolved_model: Some("scripted-1.4.0".to_owned()),
            preprocessing: None,
        }]
    }

    /// The registered evaluators of the shared tests.
    fn registered() -> Vec<plan::RegisteredEvaluator> {
        vec![plan::RegisteredEvaluator {
            evaluator: "jev-choice".to_owned(),
            adapter_version: "0.1.0".to_owned(),
        }]
    }

    /// One revision plan artifact over the shared definition. The grid
    /// holds two accept cutoffs, so the revised policy differs from the
    /// prior one.
    fn plan_artifact(id: &str) -> Value {
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
            "constraints": [{
                "metric": "error_among_accepted",
                "comparison": "at_most",
                "limit": 0.5,
                "basis": "observed_value"
            }],
            "objective": {"metric": "review_rate", "direction": "minimize"},
            "minimum_samples": {"accepted_cases": 2},
            "candidate_grid": {
                "accept_cutoffs": [0.6, 0.85],
                "rejection_cutoffs": [0.6]
            },
            "evaluator": {
                "evaluator": "jev-choice",
                "adapter_version": "0.1.0",
                "translation_hash": TRANSLATION,
                "model_requested": "scripted"
            },
            "datasets": {
                "fitting": {
                    "dataset": "revision-cases",
                    "revision": "2026-09-24.1",
                    "split": "fit"
                },
                "validation": {
                    "dataset": "revision-cases",
                    "revision": "2026-09-24.1",
                    "split": "holdout"
                }
            }
        })
    }

    /// One loaded dataset of the shared tests, with its grouped splits.
    /// The dataset is leaked, because the grouped splits borrow it.
    fn loaded(validation_group: &str) -> (String, String, splits::DatasetSplits<'static>) {
        let metadata = serde_json::to_string(&metadata(validation_group)).expect("serializes");
        let mut records = fitting_records();
        records.extend(validation_records());
        let records = file(&records);
        let dataset = Box::leak(Box::new(
            load_dataset(&metadata, &records).expect("the dataset loads"),
        ));
        let grouped = splits::dataset_splits(dataset).expect("the splits group");
        (metadata, records, grouped)
    }

    /// One prior calibration profile over the shared artifacts, signed
    /// with its computed self-hash. `status` states its qualification.
    fn prior_profile(
        definition: &ValidatedDefinition,
        plan_artifact: &Value,
        grouped: &splits::DatasetSplits<'_>,
        status: &str,
    ) -> Value {
        let plan = plan::validate_plan(plan_artifact).expect("the plan validates");
        let identity = grouped.identity();
        let mut artifact = json!({
            "schema_version": 1,
            "id": "message-supported-calibrated",
            "origin": "calibration",
            "intended_use": "Proposed messages in support conversations.",
            "definition": {
                "name": "message-supported",
                "content_hash": hashing::definition_hash(definition)
            },
            "bindings": [{
                "check": "message-supported",
                "evaluator": "jev-choice",
                "adapter_version": "0.1.0",
                "translation": {
                    "content_hash": TRANSLATION,
                    "question": "Does every material claim follow from the evidence?"
                },
                "model": {
                    "requested": "scripted",
                    "resolved": "scripted-1.4.0"
                }
            }],
            "policy": {
                "family": "probability_mass_v0",
                "checks": [{
                    "check": "message-supported",
                    "accept_cutoff": 0.6,
                    "rejection_cutoff": 0.6
                }]
            },
            "execution": {
                "max_active": 4,
                "max_pending": 16,
                "deadline_ms": 30000,
                "max_attempts": 2,
                "backoff_ms": 200
            },
            "evidence": {
                "plan": {"id": plan.id(), "content_hash": plan.content_hash()},
                "datasets": [{
                    "id": identity.dataset_id,
                    "revision": identity.revision,
                    "content_hash": identity.content_hash
                }],
                "splits": grouped
                    .splits()
                    .iter()
                    .map(|split| {
                        let identity = split.identity();
                        json!({"id": identity.split_id, "content_hash": identity.content_hash})
                    })
                    .collect::<Vec<_>>(),
                "label_provenance": "The dataset holds human reviewed references.",
                "evaluation_reports": ["reports/message-supported-validation.json"],
                "statistical_method": "Wilson score intervals at 95 percent confidence."
            },
            "qualification": {
                "status": status,
                "scope": "Proposed messages in support conversations.",
                "reasons": if status == "validated_for_scope" {
                    json!(["measured_evidence"])
                } else {
                    json!(["insufficient_evidence"])
                }
            }
        });
        let hash = hashing::compute_self_hash(hashing::Domain::Profile, &artifact).expect("hashes");
        artifact["content_hash"] = json!(hash);
        artifact
    }

    /// Signs one edited profile artifact with its computed self-hash.
    fn signed(mut artifact: Value) -> Value {
        artifact
            .as_object_mut()
            .expect("one object")
            .remove("content_hash");
        let hash = hashing::compute_self_hash(hashing::Domain::Profile, &artifact).expect("hashes");
        artifact["content_hash"] = json!(hash);
        artifact
    }

    /// One prior fitting report over the shared artifacts.
    fn prior_fitting(plan_artifact: &Value, grouped: &splits::DatasetSplits<'_>) -> Value {
        let plan = plan::validate_plan(plan_artifact).expect("the plan validates");
        let fitting = grouped
            .splits()
            .iter()
            .find(|split| split.identity().purpose == SplitPurpose::Fitting)
            .expect("the dataset declares one fitting split");
        json!({
            "plan_id": plan.id(),
            "plan_content_hash": plan.content_hash(),
            "split_content_hash": fitting.identity().content_hash,
            "status": "feasible"
        })
    }

    /// One stored measurement run of one case, as one calibration stored
    /// it: one question record with its assessment and its resolved model,
    /// and one rule record beside it.
    fn run_report(
        prior: &Value,
        definition: &ValidatedDefinition,
        case: &Value,
        mass: (f64, f64, f64),
    ) -> Value {
        let id = case["id"].as_str().expect("one case identifier");
        json!({
            "schema_version": 1,
            "run_id": format!("run-{id}"),
            "mode": "shadow",
            "definition": {
                "name": "message-supported",
                "content_hash": hashing::definition_hash(definition)
            },
            "profile": {
                "id": prior["id"],
                "content_hash": prior["content_hash"]
            },
            "case": {
                "id": id,
                "input_hash": hashing::input_hash(case["input"].as_object().expect("one object"))
            },
            "checks": [
                {
                    "check": "message-supported",
                    "kind": "question",
                    "outcome": if mass.0 >= 0.6 { "pass" } else { "fail" },
                    "assessment": assessment(mass.0, mass.1, mass.2),
                    "applied_policy": {"accept_cutoff": 0.6, "rejection_cutoff": 0.6},
                    "evaluator": {
                        "id": "jev-choice",
                        "adapter_version": "0.1.0",
                        "model_resolved": "scripted-1.4.0"
                    }
                },
                {
                    "check": "message-length",
                    "kind": "rule",
                    "outcome": "pass",
                    "applied_rule": {
                        "rule": "maxLength",
                        "input": "proposed_message",
                        "parameters": {"maxLength": 40}
                    }
                }
            ],
            "aggregate": {"outcome": if mass.0 >= 0.6 { "pass" } else { "fail" }},
            "completion": {"status": "completed"}
        })
    }

    /// The stored assessments of the shared cases, by case identifier.
    const MASSES: [(&str, (f64, f64, f64)); 6] = [
        ("fit-1", (0.95, 0.03, 0.02)),
        ("fit-2", (0.90, 0.06, 0.04)),
        ("fit-3", (0.05, 0.10, 0.85)),
        ("fit-4", (0.75, 0.15, 0.10)),
        ("hold-1", (0.95, 0.03, 0.02)),
        ("hold-2", (0.05, 0.10, 0.85)),
    ];

    /// The complete stored runs of one prior calibration that measured
    /// both splits of the loaded dataset.
    fn stored_runs(prior: &Value, definition: &ValidatedDefinition) -> Vec<String> {
        let mut cases = fitting_records();
        cases.extend(validation_records());
        MASSES
            .iter()
            .map(|(id, mass)| {
                let case = cases
                    .iter()
                    .find(|record| record["id"].as_str() == Some(*id))
                    .expect("one shared case");
                serde_json::to_string(&run_report(prior, definition, case, *mass))
                    .expect("serializes")
            })
            .collect()
    }

    /// One applied-policy row of the shared definition.
    fn policy_row(accept: f64) -> String {
        serde_json::to_string(&json!([{
            "check": "message-supported",
            "accept_cutoff": accept,
            "rejection_cutoff": 0.6
        }]))
        .expect("serializes")
    }

    /// The inputs of one reuse check, as one wrapper states them.
    struct Reuse {
        prior_profile: String,
        prior_fitting: String,
        runs: Vec<String>,
        plan: String,
        definition: String,
        registered: Vec<plan::RegisteredEvaluator>,
        live: Vec<LiveBinding>,
        metadata: String,
        records: String,
    }

    /// Builds one reuse check over the shared world: one validated prior
    /// calibration, one revision plan, and one loaded dataset whose
    /// holdout states the named validation group.
    fn shared(validation_group: &str) -> Reuse {
        let definition = definition();
        let plan = plan_artifact("message-supported-revision");
        let (_metadata, _records, grouped) = loaded("conversation-b");
        let prior = prior_profile(&definition, &plan, &grouped, "validated_for_scope");
        let fitting = prior_fitting(&plan, &grouped);
        let runs = stored_runs(&prior, &definition);
        let mut loaded_records = fitting_records();
        loaded_records.extend(validation_records());
        let mut metadata_value = metadata_value(validation_group);
        if validation_group != "conversation-b" {
            loaded_records.truncate(4);
            loaded_records.extend([
                record("fresh-1", validation_group, "supported"),
                record("fresh-2", validation_group, "contradicted"),
            ]);
        }
        let _ = &mut metadata_value;
        Reuse {
            prior_profile: serde_json::to_string(&prior).expect("serializes"),
            prior_fitting: serde_json::to_string(&fitting).expect("serializes"),
            runs,
            plan: serde_json::to_string(&plan).expect("serializes"),
            definition: definition_text(None),
            registered: registered(),
            live: live(),
            metadata: serde_json::to_string(&metadata_value).expect("serializes"),
            records: file(&loaded_records),
        }
    }

    /// One metadata artifact of the loaded dataset.
    fn metadata_value(validation_group: &str) -> Value {
        metadata(validation_group)
    }

    /// Runs one reuse check with the stated inputs.
    fn check(input: &Reuse) -> Result<RevisionReuse, ValidationError> {
        let runs: Vec<&str> = input.runs.iter().map(String::as_str).collect();
        check_revision(
            &input.prior_profile,
            &input.prior_fitting,
            &runs,
            &input.plan,
            &input.definition,
            &input.registered,
            &input.live,
            &input.metadata,
            &input.records,
        )
    }

    #[test]
    fn one_compatible_revision_reuses_the_fitting_assessments() {
        let input = shared("conversation-b");
        let reuse = check(&input).expect("the reuse verifies");

        // The identity rows state what the check verified.
        assert_eq!(reuse.prior_profile_id, "message-supported-calibrated");
        assert_eq!(reuse.stored_fitting_cases, 4);
        assert_eq!(reuse.validation_data, ValidationData::Reused { cases: 2 });
        assert_eq!(reuse.fitting_assessments, fitting_assessments());
        assert_eq!(
            reuse.validation_assessments.expect("the prior holdout ran"),
            validation_assessments()
        );
        assert_eq!(reuse.resolved_models, vec!["scripted-1.4.0"]);
        assert_eq!(
            reuse.definition_hash,
            hashing::definition_hash(&definition())
        );
        assert_eq!(
            reuse.bindings[0].model_resolved.as_deref(),
            Some("scripted-1.4.0")
        );
        assert_eq!(reuse.fitting_split.id, "fit");
        assert_eq!(reuse.fitting_split.record_count, 4);
        assert_eq!(reuse.validation_split.id, "holdout");
        assert_eq!(reuse.validation_split.record_count, 2);
        assert!(reuse.statement.contains("4 cases"));
        assert!(reuse.statement.contains("fresh independent evidence"));
        assert_eq!(reuse.limitations.len(), 2);
    }

    #[test]
    fn one_fresh_validation_split_states_fresh() {
        // The loaded dataset swaps the validation group, so the prior
        // validation runs measure cases of no loaded split: they count as
        // the claimed validation measurements, no assessment is replayed
        // for the loaded holdout, and the disposition names fresh data.
        let input = shared("conversation-c");
        let reuse = check(&input).expect("the reuse verifies");
        assert_eq!(reuse.validation_data, ValidationData::Fresh);
        assert!(reuse.validation_assessments.is_none());
        assert_eq!(reuse.stored_fitting_cases, 4);
        assert!(reuse
            .statement
            .contains("measures it through the registered evaluator"));
    }

    #[test]
    fn one_changed_question_schema_or_projection_refuses() {
        let mut input = shared("conversation-b");
        for mutation in ["question", "schema", "projection"] {
            input.definition = definition_text(Some(mutation));
            let error = check(&input).expect_err("the definition changed");
            assert_eq!(error.code, ReasonCode::DefinitionMismatch, "{mutation}");
            assert_eq!(error.field_path, "/prior/definition", "{mutation}");
        }
    }

    #[test]
    fn one_changed_adapter_or_evaluator_refuses() {
        let mut input = shared("conversation-b");

        // The plan names another adapter version.
        let mut plan: Value = serde_json::from_str(&input.plan).expect("one plan");
        plan["evaluator"]["adapter_version"] = json!("0.2.0");
        input.plan = serde_json::to_string(&plan).expect("serializes");
        let error = check(&input).expect_err("the adapter changed");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch);
        assert!(error.field_path.starts_with("/plan/evaluator"));

        // The live registry serves another adapter version.
        let mut plan: Value = serde_json::from_str(&input.plan).expect("one plan");
        plan["evaluator"]["adapter_version"] = json!("0.1.0");
        input.plan = serde_json::to_string(&plan).expect("serializes");
        input.live[0].adapter_version = "0.2.0".to_owned();
        let error = check(&input).expect_err("the live adapter changed");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch);
        assert_eq!(error.field_path, "/prior/bindings/0/adapter_version");
    }

    #[test]
    fn one_changed_translation_refuses() {
        let mut input = shared("conversation-b");

        // The plan freezes another translated question.
        let mut plan: Value = serde_json::from_str(&input.plan).expect("one plan");
        plan["evaluator"]["translation_hash"] = json!("b".repeat(64));
        input.plan = serde_json::to_string(&plan).expect("serializes");
        let error = check(&input).expect_err("the plan translation changed");
        assert_eq!(error.code, ReasonCode::TranslationMismatch);
        assert!(error.field_path.starts_with("/plan/evaluator"));

        // The live translation of the check changed.
        let mut plan: Value = serde_json::from_str(&input.plan).expect("one plan");
        plan["evaluator"]["translation_hash"] = json!(TRANSLATION);
        input.plan = serde_json::to_string(&plan).expect("serializes");
        input.live[0].translation = Some("c".repeat(64));
        let error = check(&input).expect_err("the live translation changed");
        assert_eq!(error.code, ReasonCode::TranslationMismatch);
        assert_eq!(
            error.field_path,
            "/prior/bindings/0/translation/content_hash"
        );
    }

    #[test]
    fn one_changed_model_refuses() {
        let mut input = shared("conversation-b");

        // The plan requests another model alias.
        let mut plan: Value = serde_json::from_str(&input.plan).expect("one plan");
        plan["evaluator"]["model_requested"] = json!("scripted-next");
        input.plan = serde_json::to_string(&plan).expect("serializes");
        let error = check(&input).expect_err("the requested model changed");
        assert_eq!(error.code, ReasonCode::ModelResolutionChanged);
        assert!(error.field_path.starts_with("/plan/evaluator"));

        // The requested alias resolves to another version today.
        let mut plan: Value = serde_json::from_str(&input.plan).expect("one plan");
        plan["evaluator"]["model_requested"] = json!("scripted");
        input.plan = serde_json::to_string(&plan).expect("serializes");
        input.live[0].resolved_model = Some("scripted-2.0.0".to_owned());
        let error = check(&input).expect_err("the resolution changed");
        assert_eq!(error.code, ReasonCode::ModelResolutionChanged);
        assert_eq!(error.field_path, "/prior/bindings/0/model/resolved");

        // The stored assessments themselves resolved two versions.
        input.live[0].resolved_model = Some("scripted-1.4.0".to_owned());
        input.runs[1] = input.runs[1].replace("scripted-1.4.0", "scripted-1.5.0");
        let error = check(&input).expect_err("the measurements changed model");
        assert_eq!(error.code, ReasonCode::ModelResolutionChanged);
        assert!(error.field_path.starts_with("/prior/runs/"));
    }

    #[test]
    fn one_changed_preprocessing_refuses() {
        let mut input = shared("conversation-b");

        // The prior profile records one preprocessing identity, and the
        // live preprocessing changed.
        let mut prior: Value = serde_json::from_str(&input.prior_profile).expect("one profile");
        prior["bindings"][0]["preprocessing"] = json!("plain-v1");
        input.prior_profile = serde_json::to_string(&signed(prior)).expect("serializes");
        input.live[0].preprocessing = Some("plain-v2".to_owned());
        let error = check(&input).expect_err("the preprocessing changed");
        assert_eq!(error.code, ReasonCode::EvaluatorMismatch);
        assert_eq!(error.field_path, "/prior/bindings/0/preprocessing");
    }

    #[test]
    fn one_changed_fitting_input_refuses() {
        let mut input = shared("conversation-b");

        // One edited fitting record changes the loaded fitting split hash,
        // which the prior profile no longer records.
        let mut records: Vec<Value> = fitting_records()
            .into_iter()
            .filter(|record| record["id"] != json!("fit-4"))
            .collect();
        records.extend(validation_records());
        records.push(record("fit-4", "conversation-a", "contradicted"));
        input.records = file(&records);
        let error = check(&input).expect_err("the fitting input changed");
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/prior/evidence/splits");
    }

    #[test]
    fn one_edited_or_foreign_prior_artifact_refuses() {
        let mut input = shared("conversation-b");

        // One edited prior profile fails its stored self-hash first.
        input.prior_profile = input.prior_profile.replace("2026", "2027");
        let error = check(&input).expect_err("the prior profile was edited");
        assert_eq!(error.code, ReasonCode::HashMismatch);

        // One stored run of another measurement profile mixes two
        // calibrations: the first run states the shared reference and the
        // second disagrees with it.
        let mut input = shared("conversation-b");
        let mut foreign: Value = serde_json::from_str(&input.runs[0]).expect("one run");
        foreign["profile"]["content_hash"] = json!("0".repeat(64));
        input.runs[0] = serde_json::to_string(&foreign).expect("serializes");
        let error = check(&input).expect_err("the runs mix two calibrations");
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/prior/runs/1/profile/content_hash");

        // One stored run with another input hash of one known case.
        let mut input = shared("conversation-b");
        let mut edited_input: Value = serde_json::from_str(&input.runs[0]).expect("one run");
        edited_input["case"]["input_hash"] = json!("1".repeat(64));
        input.runs[0] = serde_json::to_string(&edited_input).expect("serializes");
        let error = check(&input).expect_err("the input hash differs");
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/prior/runs/0/case/input_hash");

        // Two stored runs of one case.
        let mut input = shared("conversation-b");
        input.runs.push(input.runs[0].clone());
        let error = check(&input).expect_err("one case ran twice");
        assert_eq!(error.code, ReasonCode::DuplicateId);
    }

    #[test]
    fn one_incomplete_or_inconsistent_prior_refuses() {
        // One dropped fitting run leaves one fitting case without one
        // stored assessment.
        let mut input = shared("conversation-b");
        input.runs.remove(2);
        let error = check(&input).expect_err("one fitting case is missing");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert!(error.field_path.starts_with("/prior/runs"));

        // One stored run that records no assessment of the question check.
        let mut input = shared("conversation-b");
        let mut bare: Value = serde_json::from_str(&input.runs[0]).expect("one run");
        bare["checks"][0]
            .as_object_mut()
            .expect("one record")
            .remove("assessment");
        input.runs[0] = serde_json::to_string(&bare).expect("serializes");
        let error = check(&input).expect_err("no assessment is stored");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/prior/runs/0/checks/message-supported");

        // One validated prior that states no validation run.
        let mut input = shared("conversation-c");
        input.runs.truncate(4);
        let error = check(&input).expect_err("the validation runs are missing");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/prior/runs");

        // One unfinished prior that states validation runs.
        let mut input = shared("conversation-b");
        let definition = definition();
        let plan: Value = serde_json::from_str(&input.plan).expect("one plan");
        let (_, _, grouped) = loaded("conversation-b");
        let mut unfinished = prior_profile(&definition, &plan, &grouped, "criteria_not_met");
        unfinished["qualification"]["reasons"] = json!(["criteria_not_met"]);
        unfinished = signed(unfinished);
        input.prior_profile = serde_json::to_string(&unfinished).expect("serializes");
        input.runs = stored_runs(&unfinished, &definition);
        let mut fitting: Value =
            serde_json::from_str(&input.prior_fitting).expect("one fitting report");
        fitting["status"] = json!("no_feasible_candidate");
        input.prior_fitting = serde_json::to_string(&fitting).expect("serializes");
        let error = check(&input).expect_err("the unfinished prior validated nothing");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/prior/runs");

        // An exploration profile states no calibration evidence.
        let mut input = shared("conversation-b");
        let mut exploration: Value =
            serde_json::from_str(&input.prior_profile).expect("one profile");
        exploration["origin"] = json!("exploration");
        exploration
            .as_object_mut()
            .expect("one object")
            .remove("evidence");
        exploration["qualification"] =
            json!({"status": "unvalidated", "reasons": ["starter_policy"]});
        input.prior_profile = serde_json::to_string(&signed(exploration)).expect("serializes");
        let error = check(&input).expect_err("an exploration profile is no prior");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/prior/origin");

        // One stated fitting report of another plan.
        let mut input = shared("conversation-b");
        let mut fitting: Value =
            serde_json::from_str(&input.prior_fitting).expect("one fitting report");
        fitting["plan_content_hash"] = json!("2".repeat(64));
        input.prior_fitting = serde_json::to_string(&fitting).expect("serializes");
        let error = check(&input).expect_err("the fitting report binds another plan");
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/prior/fitting/plan_content_hash");
    }

    #[test]
    fn one_revision_comparison_lists_the_changed_cases() {
        let input = shared("conversation-b");

        // The revised candidate raises the accept cutoff to 0.85, so
        // fit-4 (0.75 supported) changes from pass to review and its
        // aggregate changes with it. Every other case decides the same.
        let comparison = compare_revision(
            &input.prior_profile,
            &input.plan,
            &policy_row(0.85),
            &input.metadata,
            &input.records,
            &input.definition,
            &serde_json::to_string(&fitting_assessments()).expect("serializes"),
        )
        .expect("the comparison replays");
        assert_eq!(comparison.evidence_class, EvidenceClass::Fitting);
        assert_eq!(
            comparison.baseline.source.id,
            "message-supported-calibrated"
        );
        assert_eq!(comparison.candidate.source.id, "message-supported-revision");
        assert_eq!(comparison.baseline.policy[0].policy.accept_cutoff, 0.6);
        assert_eq!(comparison.matching.matched_cases, 4);
        assert_eq!(comparison.matching.changed_cases, 1);
        assert_eq!(comparison.matching.unchanged_cases, 3);
        let changed = &comparison.changed[0];
        assert_eq!(changed.id, "fit-4");
        assert_eq!(changed.checks.len(), 1);
        assert_eq!(changed.checks[0].check, "message-supported");
        assert_eq!(changed.checks[0].baseline, Outcome::Pass);
        assert_eq!(changed.checks[0].candidate, Outcome::Review);
        assert_eq!(changed.baseline_aggregate, report::AggregateOutcome::Pass);
        assert_eq!(
            changed.candidate_aggregate,
            report::AggregateOutcome::Review
        );

        // The metric rows keep the counts and the denominators of both
        // sides over the same four cases.
        let review = comparison
            .metrics
            .iter()
            .find(|row| row.scope == "all_checks" && row.metric == metrics::MetricName::ReviewRate)
            .expect("the review rate row");
        assert_eq!(review.baseline.denominator, 4);
        assert_eq!(review.candidate.denominator, 4);
        assert_eq!(review.baseline.value, Some(0.0));
        assert_eq!(review.candidate.value, Some(0.25));
        assert_eq!(comparison.statement, COMPARISON_STATEMENT);
        assert_eq!(comparison.limitations.len(), 2);
    }

    #[test]
    fn one_unchanged_policy_changes_no_case() {
        let input = shared("conversation-b");
        let comparison = compare_revision(
            &input.prior_profile,
            &input.plan,
            &policy_row(0.6),
            &input.metadata,
            &input.records,
            &input.definition,
            &serde_json::to_string(&fitting_assessments()).expect("serializes"),
        )
        .expect("the comparison replays");
        assert!(comparison.changed.is_empty());
        assert_eq!(comparison.matching.changed_cases, 0);
        assert_eq!(comparison.matching.unchanged_cases, 4);
    }

    #[test]
    fn one_broken_revised_policy_row_refuses() {
        let input = shared("conversation-b");
        let assessments = serde_json::to_string(&fitting_assessments()).expect("serializes");

        // One row names one rule check.
        let error = compare_revision(
            &input.prior_profile,
            &input.plan,
            &serde_json::to_string(&json!([{
                "check": "message-length",
                "accept_cutoff": 0.85,
                "rejection_cutoff": 0.6
            }]))
            .expect("serializes"),
            &input.metadata,
            &input.records,
            &input.definition,
            &assessments,
        )
        .expect_err("one rule check takes no policy");
        assert_eq!(error.code, ReasonCode::PolicyMismatch);
        assert_eq!(error.field_path, "/revised_policy/0/check");

        // One cutoff sits at the open bound.
        let error = compare_revision(
            &input.prior_profile,
            &input.plan,
            &serde_json::to_string(&json!([{
                "check": "message-supported",
                "accept_cutoff": 0.5,
                "rejection_cutoff": 0.6
            }]))
            .expect("serializes"),
            &input.metadata,
            &input.records,
            &input.definition,
            &assessments,
        )
        .expect_err("one cutoff breaks its bound");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/revised_policy/0/accept_cutoff");

        // One question check states no row.
        let error = compare_revision(
            &input.prior_profile,
            &input.plan,
            &serde_json::to_string(&json!([])).expect("serializes"),
            &input.metadata,
            &input.records,
            &input.definition,
            &assessments,
        )
        .expect_err("one check states no policy");
        assert_eq!(error.code, ReasonCode::PolicyMismatch);
        assert_eq!(
            error.field_path,
            "/revised_policy (the check message-supported)"
        );

        // One stored assessment of one fitting case is absent.
        let mut broken = fitting_assessments();
        broken.as_object_mut().expect("one object").remove("fit-2");
        let error = compare_revision(
            &input.prior_profile,
            &input.plan,
            &policy_row(0.85),
            &input.metadata,
            &input.records,
            &input.definition,
            &serde_json::to_string(&broken).expect("serializes"),
        )
        .expect_err("one fitting case states no assessment");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/assessments/fit-2");
    }
}
