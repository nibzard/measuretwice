// SPDX-License-Identifier: Apache-2.0
//! Thin Node binding for the measuretwice core.
//!
//! The binding exposes the serializable operations of the core: definition
//! and case validation, input projection, canonical content hashes, the
//! exact string rules, report construction, and run state validation. It
//! makes no provider calls, holds no credentials, and writes no files.
//! Loading the binding performs no I/O beyond loading the shared library.
//! Public TypeScript types live in the `measuretwice` package, never here.
//!
//! Artifacts cross the boundary as strict JSON text, the one input shape the
//! core already owns: the strict gate in `measuretwice_core::json` rejects
//! malformed text, repeated keys, non-finite numbers, and unpaired
//! surrogates before any parser runs. Small structured results, such as the
//! projected inputs, cross as plain values.
//!
//! Every domain failure is thrown as one native error whose message is the
//! failure serialized as JSON: `code`, `message`, and `field_path`, exactly
//! as the `ValidationError` contract states them. `native.ts` in the public
//! package parses that message back into one stable TypeScript error, so no
//! safe cause is lost. Failures of the bridge itself, such as a JavaScript
//! argument of the wrong type, throw ordinary native errors that carry no
//! domain data.

#[macro_use]
extern crate napi_derive;

use measuretwice_core::error::{ReasonCode, ValidationError};
use measuretwice_core::report::parse_check_record;
use measuretwice_core::run_state::AttemptResolution;
use measuretwice_core::{
    assessment, case, comparison, dataset, definition, hashing, intervals, json, metrics, policy,
    profile, report, review, rule, run_state, splits,
};
use serde_json::Value;

// Every exported signature states `Result<T, napi::Error>` in full. The
// derive macro detects a thrown failure by reading the `Result` path, so a
// type alias would hide the error channel and return the failure as a value
// instead of throwing it.

/// Converts one validation failure into the thrown native error.
///
/// The message is the failure serialized as JSON. The wrapper layer is the
/// only reader of that message, and it rebuilds the failure from the same
/// three fields the Rust contract states.
fn failure(error: ValidationError) -> napi::Error {
    let reason = serde_json::to_string(&error).unwrap_or_else(|_| error.to_string());
    napi::Error::new(napi::Status::GenericFailure, reason)
}

/// Lifts one core result into the binding result.
fn lift<T>(result: Result<T, ValidationError>) -> Result<T, napi::Error> {
    result.map_err(failure)
}

/// Parses one artifact through the strict JSON gate.
fn strict(text: &str) -> Result<Value, napi::Error> {
    lift(json::parse_strict(text))
}

/// The kind of one check of a validated definition, as the contracts name it.
#[napi(object)]
pub struct CheckKindEntry {
    /// The check identifier.
    pub id: String,
    /// The semantic kind: rule, categorical, binary, or ordered.
    pub kind: String,
}

/// The result of validating one definition artifact.
#[napi(object)]
pub struct DefinitionInfo {
    /// The definition name.
    pub name: String,
    /// The definition-domain content hash.
    pub definition_hash: String,
    /// The effective uncertainty behavior. An omitted `when_uncertain`
    /// means review, the one documented default.
    pub effective_when_uncertain: String,
    /// Whether every check of the definition is an exact rule.
    pub is_exact_only: bool,
    /// The kind of every check, in definition order.
    pub check_kinds: Vec<CheckKindEntry>,
}

/// Returns the portable contract schema version implemented by the core.
#[napi]
pub fn contract_version() -> u32 {
    measuretwice_core::CONTRACT_SCHEMA_VERSION
}

/// Validates one definition artifact and establishes every check meaning.
///
/// The definition text must pass the strict JSON gate and every contract
/// invariant: unique check identifiers, declared inputs, disjoint label
/// selections, closed scales, and an input schema inside the supported
/// subset.
#[napi]
pub fn validate_definition(definition_text: String) -> Result<DefinitionInfo, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let artifact = validated.as_definition();
    Ok(DefinitionInfo {
        name: artifact.name.clone(),
        definition_hash: hashing::definition_hash(&validated),
        effective_when_uncertain: when_uncertain_word(validated.effective_when_uncertain())
            .to_owned(),
        is_exact_only: validated.is_exact_only(),
        check_kinds: artifact
            .checks
            .iter()
            .zip(validated.check_kinds())
            .map(|(check, kind)| CheckKindEntry {
                id: check.id.clone(),
                kind: check_word(*kind).to_owned(),
            })
            .collect(),
    })
}

/// The authorized inputs of one check, projected for one evaluator request.
#[napi(object)]
pub struct ProjectedInputsEntry {
    /// The check that these inputs serve.
    pub check_id: String,
    /// The declared inputs of the check, by name. No other field appears
    /// here.
    pub inputs: Value,
}

/// The result of validating one case against one definition.
#[napi(object)]
pub struct CaseInfo {
    /// The stable case identifier.
    pub id: String,
    /// The input-domain content hash of the complete input object.
    pub input_hash: String,
    /// The projection of every check, in definition order.
    pub projected_inputs: Vec<ProjectedInputsEntry>,
}

/// Validates one case against one validated definition and projects the
/// authorized inputs of every check.
///
/// The case text must pass the strict JSON gate and the case envelope, and
/// the input object must satisfy the definition input schema and every
/// published data limit. Validation fails before any evaluator call.
#[napi]
pub fn validate_case(definition_text: String, case_text: String) -> Result<CaseInfo, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let validated_case = lift(case::validate_case_str(&case_text, &validated))?;
    Ok(CaseInfo {
        id: validated_case.id().to_owned(),
        input_hash: hashing::input_hash(validated_case.input()),
        projected_inputs: validated_case
            .projected_inputs()
            .into_iter()
            .map(|projected| ProjectedInputsEntry {
                check_id: projected.check_id,
                inputs: Value::Object(projected.inputs),
            })
            .collect(),
    })
}

/// One assessed exact rule with the record text that reports it.
#[napi(object)]
pub struct RuleAssessment {
    /// The assessed check identifier.
    pub check: String,
    /// The outcome of the executed rule: pass or fail.
    pub outcome: String,
    /// The executed rule with its parameter and its one input.
    pub applied_rule: Value,
    /// The sanitized explanation of the outcome.
    pub reason: String,
    /// The serialized check record of this result. Pass this text unchanged
    /// to `acceptResult`.
    pub record: String,
}

/// Assesses every exact rule of one case, in definition order.
///
/// Question checks stay outside, because they need an evaluator. A
/// definition and a case that validate cannot fail this step.
#[napi]
pub fn assess_rule_checks(
    definition_text: String,
    case_text: String,
) -> Result<Vec<RuleAssessment>, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let validated_case = lift(case::validate_case_str(&case_text, &validated))?;
    let results = lift(rule::assess_rule_checks(&validated_case))?;
    Ok(results
        .iter()
        .map(|result| RuleAssessment {
            check: result.check.clone(),
            outcome: result.outcome.as_str().to_owned(),
            applied_rule: serde_json::to_value(&result.applied_rule).expect("serializes"),
            reason: result.reason.clone(),
            record: serde_json::to_string(&report::CheckRecord::from_rule_result(result))
                .expect("serializes"),
        })
        .collect())
}

/// The result of validating one assessment against its check.
#[napi(object)]
pub struct AssessmentInfo {
    /// The assessed check identifier.
    pub check: String,
    /// The answer kind of the assessment, as the core read it.
    pub kind: String,
    /// The validated assessment, unchanged. The run report records this
    /// value exactly as it stands here.
    pub assessment: Value,
}

/// Validates one normalized assessment against the check that asked for it.
///
/// The definition text must pass the strict JSON gate and the definition
/// contract. The assessment text must pass the strict gate, the structural
/// assessment schema, and the semantic rules of its check: the matching
/// kind, the declared labels and levels, one position inside the scale, one
/// distribution that names declared answers or levels and sums to one, and
/// evidence references that the `using` list authorizes. A failure throws
/// `invalid_assessment` with the field path of the broken rule.
#[napi]
pub fn validate_assessment(
    definition_text: String,
    check_id: String,
    assessment_text: String,
) -> Result<AssessmentInfo, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let value = strict(&assessment_text)?;
    lift(assessment::validate_assessment(
        &validated, &check_id, &value,
    ))?;
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok(AssessmentInfo {
        check: check_id,
        kind,
        assessment: value,
    })
}

/// Builds the canonical form of one strict JSON document.
///
/// Two values with one parsed meaning produce one canonical form, whatever
/// their formatting, key order, or number spelling was. Array order stays.
#[napi]
pub fn canonical_form(text: String) -> Result<String, napi::Error> {
    let value = strict(&text)?;
    Ok(hashing::canonical_form(&value))
}

/// One decided question check: its outcome and its complete record.
#[napi(object)]
pub struct DecidedQuestion {
    /// The outcome of the decision: pass, fail, or review.
    pub outcome: String,
    /// The serialized check record of this decision. Pass this text
    /// unchanged to `acceptResult`.
    pub record: String,
}

/// Decides one question check under its selected policy and builds its
/// record.
///
/// The definition text must pass the definition contract. The assessment
/// text must pass the strict gate and the assessment contract of its check.
/// The policy text states `{ accept_cutoff, rejection_cutoff,
/// confidence_floor? }` of the `probability_mass_v0` family, exactly as the
/// bound profile records it for the check. The measurements text states
/// `{ evaluator?, timing?, usage? }`. The boundary decides through the core
/// policy, builds the question record with the assessment, the applied
/// policy, and the measurements, validates the complete record, and returns
/// it with its outcome word.
#[napi]
pub fn decide_question_check(
    definition_text: String,
    check_id: String,
    assessment_text: String,
    policy_text: String,
    measurements_text: String,
) -> Result<DecidedQuestion, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let assessment = strict(&assessment_text)?;
    let policy_value = strict(&policy_text)?;
    let policy = lift(report::parse_applied_policy(&policy_value, "/policy"))?;
    let outcome = lift(policy::decide(&validated, &check_id, &assessment, &policy))?;
    let measurements_value = strict(&measurements_text)?;
    let measurements = lift(report::QuestionMeasurements::parse(
        &measurements_value,
        "/measurements",
    ))?;
    let record =
        report::CheckRecord::from_question(&check_id, outcome, assessment, policy, measurements);
    lift(record.validate(""))?;
    Ok(DecidedQuestion {
        outcome: outcome.as_str().to_owned(),
        record: serde_json::to_string(&record).expect("the record serializes"),
    })
}

/// The result of validating one profile artifact.
#[napi(object)]
pub struct ProfileInfo {
    /// Stable profile identifier.
    pub id: String,
    /// The profile origin: exploration, calibration, or exact.
    pub origin: String,
    /// The name of the bound definition.
    pub definition_name: String,
    /// The content hash of the bound definition.
    pub definition_hash: String,
    /// The decision-rule family: probability_mass_v0 or exact.
    pub policy_family: String,
    /// The qualification status of the profile.
    pub qualification_status: String,
    /// The scope that the status covers, when stated.
    pub qualification_scope: Option<String>,
    /// The verified self-hash of the artifact.
    pub content_hash: String,
}

/// Validates one profile artifact through the complete contract check.
///
/// The artifact must pass the strict JSON gate, every field rule, the
/// cross-field origin rules, and the stored self-hash. One field defect
/// names its field; one edited or corrupted copy fails with `hash_mismatch`.
#[napi]
pub fn validate_profile(profile_text: String) -> Result<ProfileInfo, napi::Error> {
    let validated = lift(profile::validate_profile_str(&profile_text))?;
    Ok(ProfileInfo {
        id: validated.id().to_owned(),
        origin: validated.origin().as_str().to_owned(),
        definition_name: validated.definition_name().to_owned(),
        definition_hash: validated.definition_hash().to_owned(),
        policy_family: validated.family().as_str().to_owned(),
        qualification_status: validated.qualification().as_str().to_owned(),
        qualification_scope: validated.qualification_scope().map(str::to_owned),
        content_hash: validated.content_hash().to_owned(),
    })
}

/// One declared split of one dataset, as data.
#[napi(object)]
pub struct DatasetSplitEntry {
    /// Stable split identifier.
    pub id: String,
    /// Fitting or validation.
    pub purpose: String,
    /// Groups assigned to this split, in the declared order.
    pub groups: Vec<String>,
    /// Records of this split, by group assignment.
    pub record_count: u32,
    /// Computed hash of the canonical records of this split.
    pub content_hash: String,
    /// Case identifiers of this split, ordered by identifier.
    pub case_ids: Vec<String>,
}

/// One group of related cases and the split that holds it, as data.
#[napi(object)]
pub struct GroupAssignmentEntry {
    /// Group of related cases.
    pub group: String,
    /// Split that the metadata assigns to this group.
    pub split_id: String,
    /// Records of this group.
    pub record_count: u32,
}

/// One group of records that no declared split covers, as data.
#[napi(object)]
pub struct UnassignedGroupEntry {
    /// Group of related cases that no split declares.
    pub group: String,
    /// Records of this group.
    pub record_count: u32,
    /// Line of the first record of this group, counted from 1.
    pub first_line: u32,
}

/// The identity of one dataset, as data.
#[napi(object)]
pub struct DatasetIdentityEntry {
    /// Stable dataset identifier.
    pub dataset_id: String,
    /// Dataset revision. Changed content needs one new revision.
    pub revision: String,
    /// Dataset kind, as the metadata states it.
    pub kind: String,
    /// What the kind states about the sampled population.
    pub population: String,
    /// True when one qualification claim may rest on data of this kind.
    pub supports_qualification: bool,
    /// True when data of this kind states one production prevalence.
    pub states_prevalence: bool,
    /// Population that the sampling procedure targets.
    pub intended_population: String,
    /// How the cases were selected.
    pub sampling_method: String,
    /// Number of case records.
    pub record_count: u32,
    /// Computed hash of the canonical case records.
    pub content_hash: String,
    /// Group assignments, ordered by group.
    pub group_assignments: Vec<GroupAssignmentEntry>,
    /// Groups of records that no declared split covers, ordered by group.
    pub unassigned_groups: Vec<UnassignedGroupEntry>,
}

/// The metadata of one validated dataset.
#[napi(object)]
pub struct DatasetMetadataEntry {
    /// Stable dataset identifier.
    pub id: String,
    /// Readable dataset name, when stated.
    pub name: Option<String>,
    /// Dataset revision.
    pub revision: String,
    /// Dataset kind: development_fixture, synthetic_challenge, or
    /// representative_sample.
    pub kind: String,
    /// Population that the sampling procedure targets.
    pub intended_population: String,
    /// How the cases were selected.
    pub sampling_method: String,
    /// Written label guidelines, or one reference to them.
    pub label_guidelines: String,
    /// Language tags that occur in the cases.
    pub languages: Vec<String>,
    /// The declared splits.
    pub splits: Vec<DatasetSplitEntry>,
}

/// One case record of one validated dataset, as data.
#[napi(object)]
pub struct DatasetCaseEntry {
    /// Line of this record inside the record file, counted from 1.
    pub line: u32,
    /// Stable case identifier.
    pub id: String,
    /// Group of related cases. One record without a group forms its own
    /// group.
    pub group: String,
    /// Slice and failure-type tags.
    pub tags: Vec<String>,
    /// The complete input object, unchanged.
    pub input: Value,
    /// The input-domain content hash of the complete input object.
    pub input_hash: String,
    /// Reference labels and expected outcomes, when one is present.
    pub expected: Option<Value>,
    /// The provenance of the reference label.
    pub label: Value,
}

/// One flagged label conflict of one validated dataset, as data.
#[napi(object)]
pub struct LabelFindingEntry {
    /// Line of the record inside the record file, counted from 1.
    pub line: u32,
    /// Stable case identifier of the record.
    pub case_id: String,
    /// Check identifier, when the conflict belongs to one check.
    pub check_id: Option<String>,
    /// Kind of the conflict: check_outcome_conflict or
    /// overall_outcome_conflict.
    pub kind: String,
    /// Field path of the conflicting reference, prefixed with the record
    /// line.
    pub field_path: String,
    /// Short statement of the conflict.
    pub message: String,
}

/// The provenance summary of the reference labels of one dataset.
#[napi(object)]
pub struct DatasetLabelsEntry {
    /// Number of case records of the dataset.
    pub records: u32,
    /// Number of records that state one expected-label object.
    pub labeled: u32,
    /// Number of records without reference labels.
    pub unlabeled: u32,
    /// Human-written references with one recorded human review.
    pub human_reviewed: u32,
    /// Human-written references with no recorded review.
    pub human_unreviewed: u32,
    /// Model-proposed references with one recorded human review.
    pub model_reviewed: u32,
    /// Model-proposed references that no human reviewed.
    pub model_unreviewed: u32,
    /// References with one correction, so their history keeps the earlier
    /// provenance records.
    pub corrected: u32,
    /// References that state one review marker or carry one flagged
    /// conflict.
    pub review_required: u32,
    /// Every flagged conflict, in record order.
    pub findings: Vec<LabelFindingEntry>,
}

/// The result of validating one dataset through the core.
#[napi(object)]
pub struct DatasetInfo {
    /// The name of the definition that validated every input object.
    pub definition_name: String,
    /// The content hash of that definition.
    pub definition_hash: String,
    /// The metadata artifact, as the core validated it.
    pub metadata: DatasetMetadataEntry,
    /// The identity of the dataset: revision, kind, population statement,
    /// sampling provenance, record count, content hash, and group
    /// assignments.
    pub identity: DatasetIdentityEntry,
    /// The number of case records.
    pub record_count: u32,
    /// Every case record, in file order.
    pub records: Vec<DatasetCaseEntry>,
    /// The label review: the provenance summary of every reference label
    /// and every flagged conflict that one human must decide.
    pub labels: DatasetLabelsEntry,
}

/// Validates one JSONL case dataset with its metadata through the core.
///
/// The metadata text must pass the strict JSON gate and the dataset
/// metadata contract. The records text holds one complete record file:
/// every nonempty line is one case record, and one failure names its line
/// and its field. Every input object must satisfy the input schema of the
/// definition text, and every reference label must satisfy the meaning of
/// its check: one reference that names no declared check, one answer or
/// level outside the declared labels, and one reference answer on one rule
/// check each fail with their line and field. One reference whose
/// acceptance meaning disagrees with its stated expected outcome loads and
/// appears under `labels.findings`, because one human must decide it.
/// Reference labels and label provenance stay outside the input object; the
/// run-case boundary keeps them out of every evaluator request.
///
/// The result also carries the grouped splits: `identity` records the
/// revision, the kind, the population statement, the sampling provenance,
/// the record count, the dataset content hash, and the group assignments,
/// and each split of `metadata.splits` records its record count, its
/// content hash, and its case identifiers. One group that two splits
/// declare fails the metadata contract, and one stored dataset or split
/// hash that differs from the computed digest fails with `hash_mismatch`.
#[napi]
pub fn validate_dataset(
    metadata_text: String,
    records_text: String,
    definition_text: String,
) -> Result<DatasetInfo, napi::Error> {
    let validated_definition = lift(definition::validate_definition_str(&definition_text))?;
    let loaded = lift(dataset::load_dataset(&metadata_text, &records_text))?;
    let validated = lift(dataset::validate_dataset(&loaded, &validated_definition))?;
    let grouped = lift(splits::dataset_splits(&loaded))?;
    let metadata = validated.metadata();
    let identity = grouped.identity();
    let review = validated.label_review();
    let summary = review.summary();
    let mut records = Vec::with_capacity(validated.len());
    for index in 0..validated.len() {
        let record = validated.record(index).expect("the index is in range");
        records.push(DatasetCaseEntry {
            line: record.line() as u32,
            id: record.id().to_owned(),
            group: record.group().to_owned(),
            tags: record.tags().to_vec(),
            input: Value::Object(record.input().clone()),
            input_hash: hashing::input_hash(record.input()),
            expected: record
                .expected()
                .map(|expected| serde_json::to_value(expected).expect("the labels serialize")),
            label: serde_json::to_value(record.label()).expect("the label serializes"),
        });
    }
    Ok(DatasetInfo {
        definition_name: validated_definition.as_definition().name.clone(),
        definition_hash: hashing::definition_hash(&validated_definition),
        metadata: DatasetMetadataEntry {
            id: metadata.id.clone(),
            name: metadata.name.clone(),
            revision: metadata.revision.clone(),
            kind: metadata.kind.as_str().to_owned(),
            intended_population: metadata.intended_population.clone(),
            sampling_method: metadata.sampling_method.clone(),
            label_guidelines: metadata.label_guidelines.clone(),
            languages: metadata.languages.clone(),
            splits: grouped
                .splits()
                .iter()
                .map(|split| {
                    let split_identity = split.identity();
                    DatasetSplitEntry {
                        id: split_identity.split_id.clone(),
                        purpose: split_identity.purpose.as_str().to_owned(),
                        groups: split_identity.groups.clone(),
                        record_count: split_identity.record_count as u32,
                        content_hash: split_identity.content_hash.clone(),
                        case_ids: split_identity.case_ids.clone(),
                    }
                })
                .collect(),
        },
        identity: DatasetIdentityEntry {
            dataset_id: identity.dataset_id.clone(),
            revision: identity.revision.clone(),
            kind: identity.kind.as_str().to_owned(),
            population: identity.population.as_str().to_owned(),
            supports_qualification: identity.population.supports_qualification(),
            states_prevalence: identity.population.states_prevalence(),
            intended_population: identity.intended_population.clone(),
            sampling_method: identity.sampling_method.clone(),
            record_count: identity.record_count as u32,
            content_hash: identity.content_hash.clone(),
            group_assignments: identity
                .group_assignments
                .iter()
                .map(|assignment| GroupAssignmentEntry {
                    group: assignment.group.clone(),
                    split_id: assignment.split_id.clone(),
                    record_count: assignment.record_count as u32,
                })
                .collect(),
            unassigned_groups: identity
                .unassigned_groups
                .iter()
                .map(|unassigned| UnassignedGroupEntry {
                    group: unassigned.group.clone(),
                    record_count: unassigned.record_count as u32,
                    first_line: unassigned.first_line as u32,
                })
                .collect(),
        },
        record_count: validated.len() as u32,
        records,
        labels: DatasetLabelsEntry {
            records: summary.records as u32,
            labeled: summary.labeled as u32,
            unlabeled: summary.unlabeled as u32,
            human_reviewed: summary.human_reviewed as u32,
            human_unreviewed: summary.human_unreviewed as u32,
            model_reviewed: summary.model_reviewed as u32,
            model_unreviewed: summary.model_unreviewed as u32,
            corrected: summary.corrected as u32,
            review_required: summary.review_required as u32,
            findings: review
                .findings()
                .iter()
                .map(|finding| LabelFindingEntry {
                    line: finding.line as u32,
                    case_id: finding.case_id.clone(),
                    check_id: finding.check_id.clone(),
                    kind: finding.kind.as_str().to_owned(),
                    field_path: finding.field_path.clone(),
                    message: finding.message.clone(),
                })
                .collect(),
        },
    })
}

/// The overlap between one fitting selection and one validation selection,
/// as data.
#[napi(object)]
pub struct SplitOverlapEntry {
    /// True when both selections name one dataset revision.
    pub same_dataset: bool,
    /// Groups that both splits declare, ordered by group.
    pub shared_groups: Vec<String>,
    /// Case identifiers that both splits hold, ordered by identifier.
    pub shared_cases: Vec<String>,
    /// True when the two selections share no group and no case.
    pub separated: bool,
}

/// Detects fitting and validation overlap between two split selections.
///
/// Each text holds one split identity: the words of one dataset selection
/// of a calibration plan (`dataset`, `revision`, `split`) plus `purpose`,
/// `groups`, `record_count`, `content_hash`, and `case_ids`, exactly as the
/// public wrapper composes it from one loaded dataset. Shared groups break
/// the declared grouping strategy; shared case identifiers are duplicated
/// cases that supplied fitting and validation evidence. The detection
/// computes no rate and changes no artifact: it names the shared names.
#[napi]
pub fn split_overlap(
    fitting_text: String,
    validation_text: String,
) -> Result<SplitOverlapEntry, napi::Error> {
    let fitting = parse_split(&fitting_text)?;
    let validation = parse_split(&validation_text)?;
    let overlap = splits::split_overlap(&fitting, &validation);
    Ok(SplitOverlapEntry {
        same_dataset: overlap.same_dataset,
        separated: overlap.is_disjoint(),
        shared_groups: overlap.shared_groups,
        shared_cases: overlap.shared_cases,
    })
}

/// Requires fitting and validation selections that share no group and no
/// case.
///
/// The inputs match `splitOverlap`. One overlap throws `duplicate_id` at
/// `/datasets/validation`, because the validation data is the one that
/// loses its independence. One calibration plan states this rule for its
/// two dataset selections.
#[napi]
pub fn require_separated_splits(
    fitting_text: String,
    validation_text: String,
) -> Result<(), napi::Error> {
    let fitting = parse_split(&fitting_text)?;
    let validation = parse_split(&validation_text)?;
    lift(splits::require_separated(&fitting, &validation))
}

/// Parses one split identity text through the strict gate.
fn parse_split(text: &str) -> Result<splits::SplitIdentity, napi::Error> {
    lift(splits::parse_split_identity(&strict(text)?))
}

/// The evidence classification of one validation split, as data.
#[napi(object)]
pub struct ValidationEvidenceEntry {
    /// The evidence class: independent_validation or development.
    pub class: String,
    /// True when the dataset kind states one representative sample.
    pub representative_sample: bool,
    /// Records of the split.
    pub record_count: u32,
    /// References of the earlier uses that hold the same validation content.
    pub reused_from: Vec<String>,
    /// True when one new qualification claim needs fresh validation
    /// evidence, because this split is development data.
    pub needs_fresh_evidence: bool,
    /// Plain statement of the classification.
    pub statement: String,
}

/// Classifies the validation evidence of one split selection.
///
/// The validation text holds one split identity as `splitOverlap` states.
/// The population word is the population statement of the dataset identity,
/// `development_fixture`, `targeted_challenge_set`, or
/// `representative_sample`. The used text holds one array of the split
/// identities that earlier qualification claims consumed; the host records
/// them, because the core holds no clock and no storage. One reused holdout
/// is development data however it is renamed, one challenge set or one
/// development fixture supports no claim, and one empty split holds no
/// evidence.
#[napi]
pub fn validation_evidence(
    validation_text: String,
    population_word: String,
    used_text: String,
) -> Result<ValidationEvidenceEntry, napi::Error> {
    let validation = parse_split(&validation_text)?;
    let population =
        splits::PopulationStatement::from_word(&population_word).ok_or_else(|| {
            failure(ValidationError::invalid_field_type(
                "/population",
                "The population statement must be development_fixture, targeted_challenge_set, or representative_sample.",
            ))
        })?;
    let used = strict(&used_text)?;
    let Value::Array(entries) = &used else {
        return Err(failure(ValidationError::invalid_field_type(
            "/used",
            "The used holdouts must hold one array of split identities.",
        )));
    };
    let mut previously_used = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        // One broken entry names its position inside the array of used
        // holdouts, so the host sees which recorded claim broke.
        let parsed = splits::parse_split_identity(entry).map_err(|mut error| {
            error.field_path = format!("/used/{index}{}", error.field_path);
            error
        });
        previously_used.push(lift(parsed)?);
    }
    let evidence = splits::validation_evidence(&validation, population, &previously_used);
    Ok(ValidationEvidenceEntry {
        class: evidence.class.as_str().to_owned(),
        representative_sample: evidence.representative_sample,
        record_count: evidence.record_count as u32,
        reused_from: evidence.reused_from,
        needs_fresh_evidence: evidence.needs_fresh_evidence,
        statement: evidence.statement,
    })
}

/// Checks one profile artifact against one definition and the live
/// evaluator state of the requested mode.
///
/// The profile text must validate through `validateProfile`. The definition
/// text must pass the definition contract. The live text holds one array of
/// `{ check, evaluator, adapter_version, translation?, resolved_model?,
/// preprocessing? }` entries, one per bound check that one registered
/// evaluator serves. The mode is shadow or enforcement. Shadow compares the
/// bindings alone; enforcement adds the scope, the qualification, and the
/// selection clauses, so it also needs the reviewed content hash that the
/// host selected. Every material mismatch throws one compatibility reason
/// code before any evaluator runs.
#[napi]
pub fn check_profile_compatibility(
    profile_text: String,
    definition_text: String,
    live_text: String,
    mode: String,
    requested_scope: Option<String>,
    selected_hash: Option<String>,
) -> Result<(), napi::Error> {
    let validated_profile = lift(profile::validate_profile_str(&profile_text))?;
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let live = strict(&live_text)?;
    let live = lift(profile::parse_live_bindings(&live, "/live"))?;
    let mode = report::RunMode::from_word(&mode).ok_or_else(|| {
        failure(ValidationError::invalid_field_type(
            "/mode",
            "The run mode must be shadow or enforcement.",
        ))
    })?;
    let requested_scope = match requested_scope.as_deref() {
        None => None,
        Some("") => {
            return lift(Err(ValidationError::invalid_field_type(
                "/requested_scope",
                "The requested scope must hold 1 to 2000 characters.",
            )));
        }
        Some(scope) => {
            if scope.chars().count() > 2000 {
                return lift(Err(ValidationError::invalid_field_type(
                    "/requested_scope",
                    "The requested scope must hold 1 to 2000 characters.",
                )));
            }
            Some(scope.to_owned())
        }
    };
    let selected_hash = match selected_hash.as_deref() {
        None => None,
        Some(hash) => {
            if !hashing::is_hash_hex(hash) {
                return lift(Err(ValidationError::invalid_field_type(
                    "/selected_profile_hash",
                    "The selected profile hash must hold 64 lowercase hexadecimal characters.",
                )));
            }
            Some(hash.to_owned())
        }
    };
    let request = profile::CompatibilityRequest {
        mode,
        requested_scope,
        selected_hash,
    };
    lift(profile::check_compatibility(
        &validated_profile,
        &validated,
        &live,
        &request,
        "/profile",
    ))
}

/// Reads one hash domain from its contract tag, or rejects the text.
fn domain_from_tag(tag: &str) -> Result<hashing::Domain, napi::Error> {
    hashing::Domain::from_tag(tag).ok_or_else(|| {
        failure(ValidationError::invalid_field_type(
            "/domain",
            "The domain must be definition, input, translation, profile, plan, dataset, or split.",
        ))
    })
}

/// Computes the content hash of one strict JSON document in one domain.
///
/// The result is the SHA-256 of the domain tag, one zero byte, and the
/// canonical form, written as 64 lowercase hexadecimal characters.
#[napi]
pub fn content_hash(domain: String, text: String) -> Result<String, napi::Error> {
    let value = strict(&text)?;
    let domain = domain_from_tag(&domain)?;
    Ok(hashing::content_hash(domain, &value))
}

/// Computes the self-hash of one profile or plan artifact.
///
/// The canonical form covers the complete artifact with its own
/// `content_hash` field removed. The generator validates every other field
/// first, then inserts the returned digest.
#[napi]
pub fn compute_self_hash(domain: String, artifact_text: String) -> Result<String, napi::Error> {
    let value = strict(&artifact_text)?;
    let domain = domain_from_tag(&domain)?;
    lift(hashing::compute_self_hash(domain, &value))
}

/// Verifies the stored self-hash of one profile or plan artifact.
///
/// A stored value that differs from the computed digest fails with
/// `hash_mismatch`. The artifact is an edited or corrupted copy.
#[napi]
pub fn verify_self_hash(domain: String, artifact_text: String) -> Result<(), napi::Error> {
    let value = strict(&artifact_text)?;
    let domain = domain_from_tag(&domain)?;
    lift(hashing::verify_self_hash(domain, &value))
}

/// Computes the dataset-domain content hash of one record set.
///
/// The boundary covers the complete case records as one array, ordered by
/// case identifier, so reordering the records does not change the hash.
/// The records text must hold one strict JSON array.
#[napi]
pub fn dataset_hash(records_text: String) -> Result<String, napi::Error> {
    let value = strict(&records_text)?;
    let Value::Array(records) = value else {
        return lift(Err(ValidationError::invalid_field_type(
            "",
            "The dataset must be one array of case records.",
        )));
    };
    lift(hashing::dataset_hash(&records))
}

/// Computes the split-domain content hash of one record set.
///
/// The boundary and the failures match `datasetHash`. The split tag keeps
/// the same records from sharing one hash with the complete dataset.
#[napi]
pub fn split_hash(records_text: String) -> Result<String, napi::Error> {
    let value = strict(&records_text)?;
    let Value::Array(records) = value else {
        return lift(Err(ValidationError::invalid_field_type(
            "",
            "The split must be one array of case records.",
        )));
    };
    lift(hashing::split_hash(&records))
}

/// Measures one dataset against the stored run reports of its evaluated
/// cases.
///
/// The metadata text, the records text, and the definition text follow the
/// rules of `validateDataset`, and the definition must be the one that
/// assessed the cases. Each report text is one stored run report: the parser
/// of the run report contract rebuilds it, so one edited report fails with
/// its field path before any metric computes. The core reads each evaluated
/// case out of its report, measures the outcomes against the reference
/// labels, and resolves the reference of every check of every case.
///
/// The result is the complete measurement as one JSON document: the metric
/// sets, the slices, and the operational totals under `metrics`, and one
/// entry per evaluated case under `cases` with its resolved references and
/// matches. Every failure of the measurement crosses as one native failure,
/// including `insufficient_evidence` at `/cases` when no report arrived.
#[napi]
pub fn evaluate_dataset(
    metadata_text: String,
    records_text: String,
    definition_text: String,
    reports_text: Vec<String>,
) -> Result<String, napi::Error> {
    let validated_definition = lift(definition::validate_definition_str(&definition_text))?;
    let loaded = lift(dataset::load_dataset(&metadata_text, &records_text))?;
    let validated = lift(dataset::validate_dataset(&loaded, &validated_definition))?;
    let mut outcomes = Vec::with_capacity(reports_text.len());
    for text in &reports_text {
        let parsed = lift(report::parse_run_report_str(text))?;
        outcomes.push(metrics::CaseOutcome::from_report(&parsed));
    }
    let measurement = lift(metrics::evaluate(&validated, &outcomes))?;
    Ok(serde_json::to_string(&measurement).expect("the measurement serializes"))
}

/// Computes the uncertainty intervals of one measured evaluation.
///
/// The metadata text, the records text, the definition text, and the report
/// texts follow the rules of `evaluateDataset`, which this boundary runs
/// first, so one measurement failure crosses unchanged. The request text
/// holds one interval request object (`sampling`, `confidence_level`,
/// `minimum_samples`); one unsupported sampling word, one unsupported
/// confidence level, and one broken count fail with their field paths
/// before any interval computes.
///
/// The result is the complete interval report as one JSON document: the
/// method, the confidence level, the sampling model with its assumption,
/// the minimum sample count, the complete method statement, and one
/// interval row per metric of every scope and every slice. One row states
/// the counts of its rate, its draws, and either its bounds or the reason
/// no bound computes.
#[napi]
pub fn uncertainty_intervals(
    metadata_text: String,
    records_text: String,
    definition_text: String,
    reports_text: Vec<String>,
    request_text: String,
) -> Result<String, napi::Error> {
    let request = lift(intervals::parse_interval_request_str(&request_text))?;
    let validated_definition = lift(definition::validate_definition_str(&definition_text))?;
    let loaded = lift(dataset::load_dataset(&metadata_text, &records_text))?;
    let validated = lift(dataset::validate_dataset(&loaded, &validated_definition))?;
    let mut outcomes = Vec::with_capacity(reports_text.len());
    for text in &reports_text {
        let parsed = lift(report::parse_run_report_str(text))?;
        outcomes.push(metrics::CaseOutcome::from_report(&parsed));
    }
    let report = lift(intervals::evaluate_intervals(
        &validated, &outcomes, &request,
    ))?;
    Ok(serde_json::to_string(&report).expect("the interval report serializes"))
}

/// Validates one interval request.
///
/// The request text holds one interval request object (`sampling`,
/// `confidence_level`, `minimum_samples`). The core parses it alone, so one
/// wrapper checks one request before it reads one dataset or runs one case.
/// The result is the parsed request as one JSON document: the sampling
/// model, the confidence level, and the minimum sample count.
#[napi]
pub fn parse_interval_request(request_text: String) -> Result<String, napi::Error> {
    let request = lift(intervals::parse_interval_request_str(&request_text))?;
    Ok(serde_json::to_string(&request).expect("the request serializes"))
}

/// Moves one failure into one report position, prefixing
/// `/reports/<index>` onto its field path.
fn at_report(mut error: ValidationError, index: usize) -> ValidationError {
    let prefix = format!("/reports/{index}");
    error.field_path = if error.field_path.is_empty() {
        prefix
    } else {
        format!("{prefix}{}", error.field_path)
    };
    error
}

/// Exports the stored shadow reports that need one human review.
///
/// Each report text is one stored run report, rebuilt through the run
/// report contract; one edited report fails with its field path under
/// `/reports/<index>` before any selection runs. The meanings text holds
/// one object that maps every word of the host decision vocabulary to
/// `pass`, `fail`, `review`, or `silent`. The seed names the sampling seed
/// and the sample size states how many agreements the sample selects.
///
/// The core classifies every report, samples the agreements by the seeded
/// SHA-256 rank, and returns the complete export as one JSON document: the
/// review records, the sampling provenance, the inclusion rules, the stated
/// baseline meanings, the summary counts, and the standing limits.
#[napi]
pub fn export_shadow_reviews(
    reports_text: Vec<String>,
    meanings_text: String,
    seed: String,
    agreement_sample: f64,
) -> Result<String, napi::Error> {
    let mut reports = Vec::with_capacity(reports_text.len());
    for (index, text) in reports_text.iter().enumerate() {
        let parsed = match report::parse_run_report_str(text) {
            Ok(parsed) => parsed,
            Err(error) => return Err(failure(at_report(error, index))),
        };
        reports.push(parsed);
    }
    let meanings = lift(review::parse_baseline_meanings(&strict(&meanings_text)?))?;
    // The number is read as a double so that a fractional or wrapped value
    // cannot slip through an integer conversion unnoticed.
    if !agreement_sample.is_finite()
        || agreement_sample.fract() != 0.0
        || !(0.0..=review::MAX_SAMPLED_AGREEMENTS as f64).contains(&agreement_sample)
    {
        return lift(Err(ValidationError::invalid_field_type(
            "/sample/agreements",
            format!(
                "The agreement sample size must be a whole number from 0 to {}.",
                review::MAX_SAMPLED_AGREEMENTS
            ),
        )));
    }
    let export = lift(review::export_reviews(
        &reports,
        &meanings,
        &seed,
        agreement_sample as usize,
    ))?;
    Ok(serde_json::to_string(&export).expect("the export serializes"))
}

/// Validates the labels one human returned for one review export.
///
/// The definition text must pass the definition contract. The exported text
/// holds one JSON array of the case identifiers of one review export. The
/// labels text holds one complete JSONL return: every nonempty line is one
/// `{ case_id, expected, label }` object.
///
/// The result is the complete validation as one JSON document: the
/// validated labels, the provenance counts, the flagged conflicts, and the
/// standing limits. The validation reads no baseline, because baseline
/// agreement is not correctness.
#[napi]
pub fn validate_review_labels(
    definition_text: String,
    exported_text: String,
    labels_text: String,
) -> Result<String, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let exported_value = strict(&exported_text)?;
    let Value::Array(entries) = &exported_value else {
        return lift(Err(ValidationError::invalid_field_type(
            "/exported",
            "The exported case identifiers must hold one array of strings.",
        )));
    };
    let mut exported = std::collections::BTreeSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let Value::String(id) = entry else {
            return lift(Err(ValidationError::invalid_field_type(
                format!("/exported/{index}"),
                "Each exported case identifier must hold one string.",
            )));
        };
        exported.insert(id.clone());
    }
    let validation = lift(review::validate_review_labels(
        &validated,
        &exported,
        &labels_text,
    ))?;
    Ok(serde_json::to_string(&validation).expect("the validation serializes"))
}

/// Moves one failure under one report side of the comparison.
fn at_side(mut error: ValidationError, side: &str) -> ValidationError {
    let prefix = format!("/{side}");
    error.field_path = if error.field_path.is_empty() {
        prefix
    } else {
        format!("{prefix}{}", error.field_path)
    };
    error
}

/// Compares two stored evaluation reports on their matching cases.
///
/// Each report text is one stored evaluation report artifact, rebuilt
/// through the evaluation report contract; one edited report fails with
/// its field path under `/baseline` or `/candidate` before any number
/// computes. The two reference strings name where the host stored the
/// reports, and the artifact states them beside the profile references.
/// The optional costs text maps one usage key to its unit cost; one cost
/// appears only when the recorded usage of that side and the declared cost
/// inputs support it.
///
/// The result is the complete comparison as one JSON document: the
/// comparison artifact fields, the metric rows with the counts and the
/// denominators of both sides, and the standing limits. Every failure
/// crosses as one native failure, including `definition_mismatch` when
/// the reports bind different definitions and `insufficient_evidence` at
/// `/matching` when no case matches.
#[napi]
pub fn compare_evaluations(
    baseline_text: String,
    candidate_text: String,
    baseline_report: String,
    candidate_report: String,
    costs_text: Option<String>,
) -> Result<String, napi::Error> {
    let baseline_value =
        lift(json::parse_strict(&baseline_text).map_err(|error| at_side(error, "baseline")))?;
    let candidate_value =
        lift(json::parse_strict(&candidate_text).map_err(|error| at_side(error, "candidate")))?;
    let costs = match &costs_text {
        None => std::collections::BTreeMap::new(),
        Some(text) => lift(comparison::parse_cost_inputs(&strict(text)?))?,
    };
    let comparison = lift(comparison::compare_reports(
        &baseline_value,
        &candidate_value,
        &baseline_report,
        &candidate_report,
        &costs,
    ))?;
    Ok(serde_json::to_string(&comparison).expect("the comparison serializes"))
}

/// The observable state of one check of a run.
#[napi(object)]
pub struct CheckStatusInfo {
    /// Where the check sits: pending, active, or recorded.
    pub place: String,
    /// Attempts started, counting the first attempt and every retry.
    pub attempts: u32,
}

/// The resolution of one failed attempt.
#[napi(object)]
pub struct AttemptOutcome {
    /// Whether the check returns to the queue, or its attempt budget is
    /// spent and it recorded one error outcome.
    pub resolution: String,
    /// Attempts started so far, counting the attempt that just failed. Only
    /// a retrying check states it.
    pub attempts: Option<u32>,
}

/// One validated run of one case, driven through the core state boundary.
///
/// The wrapper owns the queue, the deadline, the backoff, and the
/// cancellation. It states each event to this boundary, which validates it
/// against the checked execution model before any state changes. A refusal
/// throws and changes no state. After one terminal event, `reportText`
/// returns the frozen report and every further event is refused.
#[napi]
pub struct RunState {
    inner: run_state::RunState,
}

/// Starts one run of one case.
///
/// The definition text and both reference texts must pass the strict JSON
/// gate. The case reference plus the profile reference fix the run binding:
/// every accepted attempt repeats both, and a drifted offer is refused.
/// The case reference may state one optional host snapshot reference, which
/// the frozen report records for replay; it is provenance, not case
/// identity, and no raw case content crosses.
///
/// The optional baseline text states one shadow baseline: the existing
/// decision of the host recorded beside the new outcome. The parser of the
/// run report contract owns its rules, and the state boundary refuses one
/// baseline in enforcement mode or outside its bounds before any attempt
/// starts.
#[napi]
pub fn create_run_state(
    definition_text: String,
    case_reference_text: String,
    profile_reference_text: String,
    run_id: String,
    mode: String,
    max_attempts: f64,
    baseline_text: Option<String>,
) -> Result<RunState, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let case_reference = case_reference(&case_reference_text)?;
    let profile_reference = profile_reference(&profile_reference_text)?;
    let mode = report::RunMode::from_word(&mode).ok_or_else(|| {
        failure(ValidationError::invalid_field_type(
            "/mode",
            "The run mode must be shadow or enforcement.",
        ))
    })?;
    // The number is read as a double so that a fractional or wrapped value
    // cannot slip through an integer conversion unnoticed.
    if !max_attempts.is_finite()
        || max_attempts.fract() != 0.0
        || !(1.0..=u32::MAX as f64).contains(&max_attempts)
    {
        return lift(Err(ValidationError::invalid_field_type(
            "/max_attempts",
            "The attempt limit must be a whole number from 1 to 4294967295.",
        )));
    }
    let baseline = match &baseline_text {
        None => None,
        Some(text) => {
            let value = strict(text)?;
            Some(lift(report::parse_baseline(&value, "/baseline"))?)
        }
    };
    let limits = run_state::RunLimits {
        max_attempts: max_attempts as u32,
    };
    let inner = lift(run_state::RunState::new(
        &validated,
        case_reference,
        profile_reference,
        run_id,
        mode,
        baseline,
        limits,
    ))?;
    Ok(RunState { inner })
}

/// Parses one case reference from its strict JSON text.
fn case_reference(text: &str) -> Result<report::CaseReference, napi::Error> {
    let value = strict(text)?;
    lift(report::parse_case_reference(Some(&value), "/case"))
}

/// Parses one profile reference from its strict JSON text.
fn profile_reference(text: &str) -> Result<report::ProfileReference, napi::Error> {
    let value = strict(text)?;
    lift(report::parse_profile_reference(Some(&value), "/profile"))
}

#[napi]
impl RunState {
    /// The phase of the run: running, completed, cancelled, or
    /// deadline_exceeded. Every phase except running is terminal.
    #[napi(getter)]
    pub fn phase(&self) -> String {
        match self.inner.phase() {
            run_state::Phase::Running => "running",
            run_state::Phase::Completed => "completed",
            run_state::Phase::Cancelled => "cancelled",
            run_state::Phase::DeadlineExceeded => "deadline_exceeded",
        }
        .to_owned()
    }

    /// The identifiers of every check of the run, in definition order.
    #[napi]
    pub fn check_ids(&self) -> Vec<String> {
        self.inner.check_ids().map(str::to_owned).collect()
    }

    /// The observable state of one check, or null when the identifier names
    /// no check of this run.
    #[napi]
    pub fn status(&self, check_id: String) -> Option<CheckStatusInfo> {
        self.inner.status(&check_id).map(|status| CheckStatusInfo {
            place: match status.place {
                run_state::CheckPlace::Pending => "pending",
                run_state::CheckPlace::Active => "active",
                run_state::CheckPlace::Recorded => "recorded",
            }
            .to_owned(),
            attempts: status.attempts,
        })
    }

    /// Starts the next attempt of one check, offering the run binding.
    ///
    /// The boundary refuses a drifted offer: the case identity, the case
    /// input hash, the profile identity, and the profile content hash must
    /// equal the run binding. Returns the attempts started so far.
    #[napi]
    pub fn start_attempt(
        &mut self,
        check_id: String,
        case_reference_text: String,
        profile_reference_text: String,
    ) -> Result<u32, napi::Error> {
        let case = case_reference(&case_reference_text)?;
        let profile = profile_reference(&profile_reference_text)?;
        lift(self.inner.start_attempt(&check_id, &case, &profile))
    }

    /// Resolves one in-flight attempt with an operational failure.
    ///
    /// The code must name an operational failure: evaluator_error,
    /// evaluator_timeout, or invalid_assessment. With attempts left, the
    /// check returns to the queue. Without attempts left, it records one
    /// error outcome.
    #[napi]
    pub fn fail_attempt(
        &mut self,
        check_id: String,
        code: String,
        message: String,
    ) -> Result<AttemptOutcome, napi::Error> {
        let code = ReasonCode::from_registry(&code).ok_or_else(|| {
            failure(ValidationError::invalid_field_type(
                "/code",
                "An attempt failure must carry an operational reason code: evaluator_error, evaluator_timeout, or invalid_assessment.",
            ))
        })?;
        lift(self.inner.fail_attempt(&check_id, code, &message)).map(
            |resolution| match resolution {
                AttemptResolution::RetryQueued { attempts } => AttemptOutcome {
                    resolution: "retry_queued".to_owned(),
                    attempts: Some(attempts),
                },
                AttemptResolution::Exhausted => AttemptOutcome {
                    resolution: "exhausted".to_owned(),
                    attempts: None,
                },
            },
        )
    }

    /// Resolves one in-flight attempt with one permanent operational
    /// failure.
    ///
    /// The wrapper states that the failure is permanent: the check records
    /// its error outcome at the failing attempt, whatever attempts remain,
    /// and no retry starts. The code must name an operational failure:
    /// evaluator_error, evaluator_timeout, or invalid_assessment.
    #[napi]
    pub fn fail_permanent(
        &mut self,
        check_id: String,
        code: String,
        message: String,
    ) -> Result<(), napi::Error> {
        let code = ReasonCode::from_registry(&code).ok_or_else(|| {
            failure(ValidationError::invalid_field_type(
                "/code",
                "An attempt failure must carry an operational reason code: evaluator_error, evaluator_timeout, or invalid_assessment.",
            ))
        })?;
        lift(self.inner.fail_permanent(&check_id, code, &message))
    }

    /// Resolves one in-flight attempt with its component record.
    ///
    /// The record text must hold one check record of the run report
    /// contract. An exact-rule record comes from `assessRuleChecks`; a
    /// question record comes from a validated assessment. The boundary
    /// refuses a late, duplicate, or mismatched result.
    #[napi]
    pub fn accept_result(
        &mut self,
        check_id: String,
        record_text: String,
    ) -> Result<(), napi::Error> {
        let value = strict(&record_text)?;
        let record = lift(parse_check_record(&value, ""))?;
        lift(self.inner.accept_result(&check_id, record))
    }

    /// Records one skipped outcome with reason queue_full for work that
    /// never started. The wrapper calls this when its pending-work limit
    /// cannot accept the check.
    #[napi]
    pub fn skip_queue_full(&mut self, check_id: String) -> Result<(), napi::Error> {
        lift(self.inner.skip_queue_full(&check_id))
    }

    /// Cancels the run and freezes its report.
    ///
    /// `completedAt` states the terminal time the wrapper observed. The
    /// boundary reads no clock.
    #[napi]
    pub fn cancel(&mut self, completed_at: Option<String>) -> Result<(), napi::Error> {
        lift(self.inner.cancel(completed_at.as_deref()))
    }

    /// Ends the run at its total deadline and freezes its report.
    #[napi]
    pub fn deadline(&mut self, completed_at: Option<String>) -> Result<(), napi::Error> {
        lift(self.inner.deadline(completed_at.as_deref()))
    }

    /// Completes the run and freezes its report. Every check must already
    /// hold its record.
    #[napi]
    pub fn complete(&mut self, completed_at: Option<String>) -> Result<(), napi::Error> {
        lift(self.inner.complete(completed_at.as_deref()))
    }

    /// The serialized run report, present once the run reached a terminal
    /// state. The report is immutable: no later event can change it.
    #[napi]
    pub fn report_text(&self) -> Option<String> {
        self.inner
            .report()
            .map(|report| serde_json::to_string(report).expect("the report serializes"))
    }
}

/// Names one check kind with its contract word.
fn check_word(kind: definition::CheckKind) -> &'static str {
    match kind {
        definition::CheckKind::Rule => "rule",
        definition::CheckKind::Categorical => "categorical",
        definition::CheckKind::Binary => "binary",
        definition::CheckKind::Ordered => "ordered",
    }
}

/// Names one uncertainty behavior with its contract word.
fn when_uncertain_word(value: definition::WhenUncertain) -> &'static str {
    match value {
        definition::WhenUncertain::Review => "review",
    }
}
