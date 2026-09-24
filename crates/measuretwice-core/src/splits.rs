// SPDX-License-Identifier: Apache-2.0
//! Grouped splits and dataset identities.
//!
//! Fitting data and validation data are separate evidence, as MVP_SPEC.md
//! section 7 states. One dataset declares its grouped splits in its
//! metadata; [`crate::dataset`] rejects one group that two splits declare,
//! so related conversations stay inside one split. This module turns the
//! declared grouping into the facts that a plan, a profile, or a report
//! references:
//!
//! - [`dataset_splits`] assigns every record to the split of its group,
//!   computes the dataset content hash and every split content hash over
//!   the records as the loader read them, and verifies each stored hash.
//!   One changed input changes the hash, so one stored hash that differs
//!   fails with `hash_mismatch`: the revision no longer covers the records.
//! - [`DatasetIdentity`] records the revision, the kind, the population,
//!   the sampling method, the record count, the content hash, and the
//!   group assignments. [`PopulationStatement`] states what the kind
//!   declares: one targeted synthetic challenge set supports no
//!   qualification claim and states no prevalence, whatever its size.
//! - [`split_overlap`] detects fitting and validation overlap between two
//!   splits, and [`require_separated`] refuses it for one calibration that
//!   needs separated data.
//! - [`validation_evidence`] classifies the evidence of one validation
//!   split against the holdouts that earlier claims consumed. One reused
//!   holdout is development data, and a new qualification claim needs fresh
//!   validation evidence.
//!
//! The hashes are the ones of [`crate::hashing`]: the dataset domain covers
//! the complete records ordered by case identifier, and the split domain
//! covers the records of one split the same way. Reordering the record file
//! changes no hash, so one split reproduces from the same records under any
//! file order. The core holds no clock and writes no file, so the host
//! states which validation splits its earlier claims used.

use crate::artifact::reject_unknown_fields;
use crate::dataset::{CaseRecord, Dataset, DatasetKind, SplitPurpose};
use crate::definition::is_artifact_id;
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::hashing::{self, is_hash_hex};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// Fields of one split identity, from the boundary contract of
/// [`parse_split_identity`].
const IDENTITY_FIELDS: &[&str] = &[
    "dataset",
    "revision",
    "split",
    "purpose",
    "groups",
    "record_count",
    "content_hash",
    "case_ids",
];

/// What the kind of one dataset states about the population it samples.
///
/// The kind is one declaration of the dataset author, not one measurement.
/// [`PopulationStatement::of`] maps it to the claims it supports, so one
/// targeted challenge set cannot silently become one representative sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PopulationStatement {
    /// Development fixtures of one project. They state no population and
    /// support no qualification claim.
    DevelopmentFixture,
    /// Targeted synthetic challenge set. Hard cases selected by design
    /// change the sampling, so the set states no prevalence.
    TargetedChallengeSet,
    /// Representative sample of the declared population. The one kind that
    /// supports one qualification claim.
    RepresentativeSample,
}

impl PopulationStatement {
    /// Returns the statement of one dataset kind.
    pub const fn of(kind: DatasetKind) -> Self {
        match kind {
            DatasetKind::DevelopmentFixture => Self::DevelopmentFixture,
            DatasetKind::SyntheticChallenge => Self::TargetedChallengeSet,
            DatasetKind::RepresentativeSample => Self::RepresentativeSample,
        }
    }

    /// Returns the contract word of this statement.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DevelopmentFixture => "development_fixture",
            Self::TargetedChallengeSet => "targeted_challenge_set",
            Self::RepresentativeSample => "representative_sample",
        }
    }

    /// Returns the statement of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "development_fixture" => Some(Self::DevelopmentFixture),
            "targeted_challenge_set" => Some(Self::TargetedChallengeSet),
            "representative_sample" => Some(Self::RepresentativeSample),
            _ => None,
        }
    }

    /// Returns true when one qualification claim may rest on data of this
    /// kind. Only a representative sample supports one.
    pub const fn supports_qualification(self) -> bool {
        matches!(self, Self::RepresentativeSample)
    }

    /// Returns true when data of this kind states one estimate of the
    /// production prevalence. Actively selected cases change the sampling,
    /// so no challenge set states one.
    pub const fn states_prevalence(self) -> bool {
        matches!(self, Self::RepresentativeSample)
    }
}

/// One group of related cases and the split that holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroupAssignment {
    /// Group of related cases, as the records state it.
    pub group: String,
    /// Split that the metadata assigns to this group.
    pub split_id: String,
    /// Records of this group.
    pub record_count: usize,
}

/// One group that no declared split covers.
///
/// The records of such a group are neither fitting nor validation data. The
/// identity states the fact; one revision that assigns the group repairs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnassignedGroup {
    /// Group of related cases that no split declares.
    pub group: String,
    /// Records of this group.
    pub record_count: usize,
    /// Line of the first record of this group, counted from 1.
    pub first_line: usize,
}

/// The identity of one dataset: what one plan, profile, or report binds to.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DatasetIdentity {
    /// Stable dataset identifier.
    pub dataset_id: String,
    /// Dataset revision. Changed content needs one new revision.
    pub revision: String,
    /// Dataset kind, as the metadata states it.
    pub kind: DatasetKind,
    /// What the kind states about the sampled population.
    pub population: PopulationStatement,
    /// Population that the sampling procedure targets.
    pub intended_population: String,
    /// How the cases were selected.
    pub sampling_method: String,
    /// Number of case records.
    pub record_count: usize,
    /// Computed hash of the canonical case records, in the dataset domain.
    pub content_hash: String,
    /// Group assignments, ordered by group.
    pub group_assignments: Vec<GroupAssignment>,
    /// Groups of records that no declared split covers, ordered by group.
    pub unassigned_groups: Vec<UnassignedGroup>,
}

/// The identity of one split of one dataset.
///
/// The identity is the reference that a calibration plan states and that a
/// profile records. `case_ids` names the records of the split in the order
/// of the content hash, so one consumer can find duplicated cases without
/// the records. [`SplitIdentity::same_content`] compares two identities by
/// content, because one renamed split that holds the same records is the
/// same holdout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SplitIdentity {
    /// Stable dataset identifier. The boundary names it `dataset`, the word
    /// of one dataset selection of a calibration plan.
    #[serde(rename = "dataset")]
    pub dataset_id: String,
    /// Dataset revision of this split.
    pub revision: String,
    /// Stable split identifier. The boundary names it `split`, the word of
    /// one dataset selection of a calibration plan.
    #[serde(rename = "split")]
    pub split_id: String,
    /// Fitting or validation.
    pub purpose: SplitPurpose,
    /// Groups assigned to this split, in the declared order.
    pub groups: Vec<String>,
    /// Records of this split.
    pub record_count: usize,
    /// Computed hash of the canonical records of this split, in the split
    /// domain.
    pub content_hash: String,
    /// Case identifiers of this split, ordered by identifier.
    pub case_ids: Vec<String>,
}

impl SplitIdentity {
    /// Returns the readable reference of this split.
    pub fn reference(&self) -> String {
        format!(
            "{} revision {} split {}",
            self.dataset_id, self.revision, self.split_id
        )
    }

    /// Returns true when two identities cover the same record content. The
    /// content hash decides, not the names, because one dataset revision
    /// can rename a split that holds the same records.
    pub fn same_content(&self, other: &Self) -> bool {
        self.content_hash == other.content_hash
    }
}

/// One split with its identity and its records, in file order.
#[derive(Debug)]
pub struct SplitData<'a> {
    identity: SplitIdentity,
    records: Vec<&'a CaseRecord>,
}

impl<'a> SplitData<'a> {
    /// Returns the identity of this split.
    pub fn identity(&self) -> &SplitIdentity {
        &self.identity
    }

    /// Returns the records of this split, in file order.
    pub fn records(&self) -> &[&'a CaseRecord] {
        &self.records
    }
}

/// The grouped splits of one dataset with their records.
#[derive(Debug)]
pub struct DatasetSplits<'a> {
    identity: DatasetIdentity,
    splits: Vec<SplitData<'a>>,
}

impl<'a> DatasetSplits<'a> {
    /// Returns the identity of the dataset.
    pub fn identity(&self) -> &DatasetIdentity {
        &self.identity
    }

    /// Returns every declared split with its records, in the declared
    /// order.
    pub fn splits(&self) -> &[SplitData<'a>] {
        &self.splits
    }

    /// Returns the split of one identifier.
    pub fn split(&self, split_id: &str) -> Option<&SplitData<'a>> {
        self.splits
            .iter()
            .find(|split| split.identity.split_id == split_id)
    }
}

/// The overlap between one fitting selection and one validation selection.
///
/// Shared groups break the declared grouping strategy inside one dataset
/// and across datasets that draw their cases from the same source groups.
/// Shared case identifiers are duplicated cases: the same case supplied
/// fitting and validation evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SplitOverlap {
    /// True when both selections name one dataset revision.
    pub same_dataset: bool,
    /// Groups that both splits declare, ordered by group.
    pub shared_groups: Vec<String>,
    /// Case identifiers that both splits hold, ordered by identifier.
    pub shared_cases: Vec<String>,
}

impl SplitOverlap {
    /// Returns true when the two selections share no group and no case.
    pub fn is_disjoint(&self) -> bool {
        self.shared_groups.is_empty() && self.shared_cases.is_empty()
    }
}

/// The class of evidence that one validation split supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceClass {
    /// Independent validation evidence for one qualification claim.
    IndependentValidation,
    /// Development data. The split cannot support one new qualification
    /// claim, and one report that records it states the fitting class.
    Development,
}

impl EvidenceClass {
    /// Returns the contract word of this class.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::IndependentValidation => "independent_validation",
            Self::Development => "development",
        }
    }
}

/// The evidence classification of one validation split.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ValidationEvidence {
    /// The class this split supports.
    pub class: EvidenceClass,
    /// True when the dataset kind states one representative sample of the
    /// declared population.
    pub representative_sample: bool,
    /// Records of the split.
    pub record_count: usize,
    /// References of the earlier uses that hold the same validation
    /// content.
    pub reused_from: Vec<String>,
    /// True when one new qualification claim needs fresh validation
    /// evidence, because this split is development data.
    pub needs_fresh_evidence: bool,
    /// Plain statement of the classification, linked to the facts above.
    pub statement: String,
}

impl ValidationEvidence {
    /// Returns true when this split supports one qualification claim as
    /// independent validation evidence.
    pub fn is_independent(&self) -> bool {
        self.class == EvidenceClass::IndependentValidation
    }
}

/// Computes the grouped splits of one dataset with their content hashes.
///
/// Every record joins the split of its group, so one group never spans two
/// splits. The dataset hash covers the complete records and each split hash
/// covers the records of its split, both ordered by case identifier, so the
/// file order changes no hash. One stored hash that differs from the
/// computed digest fails with `hash_mismatch`, because one revision states
/// the exact content it covers.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `hash_mismatch` at `/content_hash`
/// when the stored dataset hash differs from the computed digest, or at
/// `/splits/<index>/content_hash` when one stored split hash differs.
pub fn dataset_splits(dataset: &Dataset) -> Result<DatasetSplits<'_>, ValidationError> {
    let metadata = dataset.metadata();
    let records = dataset.records();

    // Record positions by group. The positions keep the file order, and the
    // raw record objects sit at the same positions.
    let mut grouped: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (index, record) in records.iter().enumerate() {
        grouped
            .entry(record.group.as_str())
            .or_default()
            .push(index);
    }

    // The dataset hash covers the records as the loader read them.
    let content_hash = hashing::dataset_hash(dataset.raw_records())?;
    if let Some(stored) = &metadata.content_hash {
        if stored != &content_hash {
            return Err(ValidationError::new(
                ReasonCode::HashMismatch,
                "/content_hash",
                "The stored dataset hash differs from the computed digest of the records.",
            ));
        }
    }

    let mut splits = Vec::with_capacity(metadata.splits.len());
    let mut assigned: BTreeMap<&str, &str> = BTreeMap::new();
    for (index, declaration) in metadata.splits.iter().enumerate() {
        let mut positions: Vec<usize> = Vec::new();
        for group in &declaration.groups {
            assigned.insert(group.as_str(), declaration.id.as_str());
            if let Some(members) = grouped.get(group.as_str()) {
                positions.extend(members.iter().copied());
            }
        }
        let split_records: Vec<&CaseRecord> = positions
            .iter()
            .map(|position| &records[*position])
            .collect();
        let split_hash = hashing::split_hash(
            &positions
                .iter()
                .map(|position| dataset.raw_records()[*position].clone())
                .collect::<Vec<Value>>(),
        )?;
        if let Some(stored) = &declaration.content_hash {
            if stored != &split_hash {
                return Err(ValidationError::new(
                    ReasonCode::HashMismatch,
                    format!("/splits/{index}/content_hash"),
                    format!(
                        "The stored hash of split {} differs from the computed digest of its records.",
                        fragment(&declaration.id)
                    ),
                ));
            }
        }
        // The case identifiers follow the order of the content hash, not
        // the file order.
        let mut case_ids: Vec<String> = split_records
            .iter()
            .map(|record| record.id.clone())
            .collect();
        case_ids.sort_by(|left, right| utf16_order(left, right));
        splits.push(SplitData {
            identity: SplitIdentity {
                dataset_id: metadata.id.clone(),
                revision: metadata.revision.clone(),
                split_id: declaration.id.clone(),
                purpose: declaration.purpose,
                groups: declaration.groups.clone(),
                record_count: split_records.len(),
                content_hash: split_hash,
                case_ids,
            },
            records: split_records,
        });
    }

    // One group of records that no split declares is neither fitting nor
    // validation data. The identity states the fact for one human decision.
    let unassigned_groups: Vec<UnassignedGroup> = grouped
        .iter()
        .filter(|(group, _)| !assigned.contains_key(**group))
        .map(|(group, members)| UnassignedGroup {
            group: (*group).to_owned(),
            record_count: members.len(),
            first_line: records[members[0]].line,
        })
        .collect();
    let group_assignments: Vec<GroupAssignment> = assigned
        .iter()
        .map(|(group, split_id)| GroupAssignment {
            group: (*group).to_owned(),
            split_id: (*split_id).to_owned(),
            record_count: grouped.get(*group).map_or(0, Vec::len),
        })
        .collect();

    Ok(DatasetSplits {
        identity: DatasetIdentity {
            dataset_id: metadata.id.clone(),
            revision: metadata.revision.clone(),
            kind: metadata.kind,
            population: PopulationStatement::of(metadata.kind),
            intended_population: metadata.intended_population.clone(),
            sampling_method: metadata.sampling_method.clone(),
            record_count: records.len(),
            content_hash,
            group_assignments,
            unassigned_groups,
        },
        splits,
    })
}

/// Detects fitting and validation overlap between two splits.
///
/// The facts come from the identities: `shared_groups` names the groups that
/// both splits declare and `shared_cases` names the case identifiers that
/// both splits hold, so duplicated cases surface even when two datasets
/// declare unrelated group names.
pub fn split_overlap(fitting: &SplitIdentity, validation: &SplitIdentity) -> SplitOverlap {
    let same_dataset =
        fitting.dataset_id == validation.dataset_id && fitting.revision == validation.revision;
    let mut shared_groups: Vec<String> = fitting
        .groups
        .iter()
        .filter(|group| validation.groups.contains(group))
        .cloned()
        .collect();
    shared_groups.sort();
    let mut shared_cases: Vec<String> = fitting
        .case_ids
        .iter()
        .filter(|case_id| validation.case_ids.contains(case_id))
        .cloned()
        .collect();
    shared_cases.sort();
    SplitOverlap {
        same_dataset,
        shared_groups,
        shared_cases,
    }
}

/// Requires separated fitting and validation selections.
///
/// One calibration needs fitting data and validation data that share no
/// group and no case, as the contracts README states for one plan. One
/// overlap fails with `duplicate_id` at the validation selection, because
/// the validation data is the one that loses its independence.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `duplicate_id` at
/// `/datasets/validation` when the two selections share one group or one
/// case.
pub fn require_separated(
    fitting: &SplitIdentity,
    validation: &SplitIdentity,
) -> Result<(), ValidationError> {
    let overlap = split_overlap(fitting, validation);
    if overlap.is_disjoint() {
        return Ok(());
    }
    let mut shared: Vec<String> = Vec::new();
    if !overlap.shared_groups.is_empty() {
        shared.push(name_list("group", &overlap.shared_groups));
    }
    if !overlap.shared_cases.is_empty() {
        shared.push(name_list("case", &overlap.shared_cases));
    }
    Err(ValidationError::new(
        ReasonCode::DuplicateId,
        "/datasets/validation",
        format!(
            "The validation split and the fitting split share {}.",
            shared.join(" and ")
        ),
    ))
}

/// Joins the shared names of one kind into one bounded list.
fn name_list(kind: &str, names: &[String]) -> String {
    const SHOWN: usize = 5;
    let shown: Vec<String> = names
        .iter()
        .take(SHOWN)
        .map(|name| fragment(name))
        .collect();
    let mut text = format!("{kind} {}", shown.join(", "));
    if names.len() > SHOWN {
        text.push_str(&format!(" and {} more", names.len() - SHOWN));
    }
    text
}

/// Classifies the evidence of one validation split.
///
/// `population` states what the dataset kind declares and `previously_used`
/// lists the validation splits that earlier qualification claims consumed.
/// The classification needs three facts: fresh validation content, one
/// representative sample, and records. One reused holdout is development
/// data however it is renamed, because [`SplitIdentity::same_content`]
/// decides by content; one challenge set or one development fixture
/// supports no claim; one empty split holds no evidence.
pub fn validation_evidence(
    validation: &SplitIdentity,
    population: PopulationStatement,
    previously_used: &[SplitIdentity],
) -> ValidationEvidence {
    let reused_from: Vec<String> = previously_used
        .iter()
        .filter(|used| used.same_content(validation))
        .map(SplitIdentity::reference)
        .collect();
    let reused = !reused_from.is_empty();
    let class = if reused || !population.supports_qualification() || validation.record_count == 0 {
        EvidenceClass::Development
    } else {
        EvidenceClass::IndependentValidation
    };
    let statement = if reused {
        format!(
            "The validation split {} was used before: {}. It is development data, and one new qualification claim needs fresh validation evidence.",
            validation.reference(),
            reused_from
                .iter()
                .map(|reference| fragment(reference))
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else if !population.supports_qualification() {
        format!(
            "The dataset of the validation split {} states the kind {}. It is no representative sample of the declared population, so it supports no qualification claim and states no prevalence.",
            validation.reference(),
            population.as_str()
        )
    } else if validation.record_count == 0 {
        format!(
            "The validation split {} holds no record, so it carries no evidence.",
            validation.reference()
        )
    } else {
        format!(
            "The validation split {} holds {} records of one representative sample that no earlier claim used. It is independent validation evidence.",
            validation.reference(),
            validation.record_count
        )
    };
    ValidationEvidence {
        class,
        representative_sample: population.supports_qualification(),
        record_count: validation.record_count,
        reused_from,
        needs_fresh_evidence: class == EvidenceClass::Development,
        statement,
    }
}

/// Parses one split identity from a JSON value that passed the strict gate.
///
/// The boundary accepts the identity exactly as [`SplitIdentity`]
/// serializes it, so one wrapper sends the split it loaded back to the
/// core. Every field is checked: one unknown field, one invalid identifier,
/// one unknown purpose word, one malformed hash, one repeated group or case,
/// and one count that disagrees with `case_ids` each fail with their field
/// path.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value breaks the split identity
/// contract.
pub fn parse_split_identity(value: &Value) -> Result<SplitIdentity, ValidationError> {
    let root = value
        .as_object()
        .ok_or_else(|| invalid_identity("", "The split identity must be one object."))?;
    reject_unknown_fields(root, IDENTITY_FIELDS, "")?;

    let dataset_id = read_artifact_id(root.get("dataset"), "/dataset", "The dataset identifier")?;
    let revision = read_bounded_text(root.get("revision"), "/revision", 64, "The revision")?;
    let split_id = read_artifact_id(root.get("split"), "/split", "The split identifier")?;
    let purpose = match root.get("purpose") {
        Some(Value::String(text)) => SplitPurpose::from_word(text).ok_or_else(|| {
            invalid_identity(
                "/purpose",
                "The split purpose must be fitting or validation.",
            )
        })?,
        Some(_) => {
            return Err(invalid_identity(
                "/purpose",
                "The split purpose must be fitting or validation.",
            ));
        }
        None => return Err(ValidationError::missing("/purpose")),
    };
    let groups = read_name_list(root.get("groups"), "/groups", "The split groups")?;
    let record_count = match root.get("record_count") {
        Some(Value::Number(number)) => number.as_u64().ok_or_else(|| {
            invalid_identity(
                "/record_count",
                "The record count must be one whole number of at least 0.",
            )
        })? as usize,
        Some(_) => {
            return Err(invalid_identity(
                "/record_count",
                "The record count must be one whole number of at least 0.",
            ));
        }
        None => return Err(ValidationError::missing("/record_count")),
    };
    let content_hash = match root.get("content_hash") {
        Some(Value::String(text)) if is_hash_hex(text) => text.clone(),
        Some(_) => {
            return Err(invalid_identity(
                "/content_hash",
                "The content hash must hold 64 lowercase hexadecimal characters.",
            ));
        }
        None => return Err(ValidationError::missing("/content_hash")),
    };
    let case_ids = read_name_list(root.get("case_ids"), "/case_ids", "The case identifiers")?;
    if case_ids.len() != record_count {
        return Err(invalid_identity(
            "/record_count",
            format!(
                "The record count states {record_count}, but the identity names {} cases.",
                case_ids.len()
            ),
        ));
    }
    Ok(SplitIdentity {
        dataset_id,
        revision,
        split_id,
        purpose,
        groups,
        record_count,
        content_hash,
        case_ids,
    })
}

/// Builds one invalid-field failure of the split identity boundary.
fn invalid_identity(path: impl Into<String>, message: impl Into<String>) -> ValidationError {
    ValidationError::invalid_field_type(path, message)
}

/// Reads one artifact identifier field of one split identity.
fn read_artifact_id(
    value: Option<&Value>,
    path: &str,
    what: &str,
) -> Result<String, ValidationError> {
    match value {
        Some(Value::String(text)) if is_artifact_id(text) => Ok(text.clone()),
        Some(_) => Err(invalid_identity(
            path,
            format!(
                "{what} must hold lowercase segments joined by single hyphens, 64 characters at most, starting with a letter."
            ),
        )),
        None => Err(ValidationError::missing(path)),
    }
}

/// Reads one required bounded text field of one split identity.
fn read_bounded_text(
    value: Option<&Value>,
    path: &str,
    max: usize,
    what: &str,
) -> Result<String, ValidationError> {
    match value {
        Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= max => {
            Ok(text.clone())
        }
        Some(_) => Err(invalid_identity(
            path,
            format!("{what} must hold 1 to {max} characters."),
        )),
        None => Err(ValidationError::missing(path)),
    }
}

/// Reads one bounded name list of one split identity, rejecting repeats.
fn read_name_list(
    value: Option<&Value>,
    path: &str,
    what: &str,
) -> Result<Vec<String>, ValidationError> {
    let Some(value) = value else {
        return Err(ValidationError::missing(path));
    };
    let Value::Array(items) = value else {
        return Err(invalid_identity(
            path,
            format!("{what} must hold one array of names."),
        ));
    };
    let mut names = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let Value::String(text) = item else {
            return Err(invalid_identity(
                format!("{path}/{index}"),
                "Each name must hold 1 to 128 characters.",
            ));
        };
        if text.is_empty() || text.chars().count() > 128 {
            return Err(invalid_identity(
                format!("{path}/{index}"),
                "Each name must hold 1 to 128 characters.",
            ));
        }
        if names.contains(text) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("{path}/{index}"),
                format!("The list repeats the name {}.", fragment(text)),
            ));
        }
        names.push(text.clone());
    }
    Ok(names)
}

/// Orders two strings by UTF-16 code unit order, the order of the record
/// arrays of the hashing contract.
fn utf16_order(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut left = left.encode_utf16();
    let mut right = right.encode_utf16();
    loop {
        match (left.next(), right.next()) {
            (Some(left_unit), Some(right_unit)) => match left_unit.cmp(&right_unit) {
                Ordering::Equal => continue,
                other => return other,
            },
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dataset::load_dataset;
    use serde_json::json;

    /// One minimal record of one group.
    fn record(id: &str, group: &str) -> Value {
        json!({
            "id": id,
            "group": group,
            "input": {"text": "Hello."},
            "label": {"author_type": "human", "reviewed": false}
        })
    }

    /// One metadata artifact that declares one fitting and one validation
    /// split over the given groups.
    fn metadata(kind: &str, fitting: &[&str], validation: &[&str]) -> Value {
        json!({
            "schema_version": 1,
            "id": "intervention-cases",
            "revision": "2026-09-24.1",
            "kind": kind,
            "intended_population": "Proposed messages in support conversations.",
            "sampling_method": "Selected from reviewed development work. No prevalence claim.",
            "label_guidelines": "See docs/labeling.md revision 3.",
            "splits": [
                {"id": "fit", "purpose": "fitting", "groups": fitting},
                {"id": "holdout", "purpose": "validation", "groups": validation}
            ]
        })
    }

    /// Loads one dataset from one metadata artifact and one records text.
    fn loaded_with(metadata: &Value, records: &str) -> Dataset {
        let text = serde_json::to_string(metadata).expect("serializes");
        load_dataset(&text, records).expect("the dataset loads")
    }

    /// Loads one dataset of the default identity from one metadata artifact
    /// and one records text.
    fn loaded(kind: &str, fitting: &[&str], validation: &[&str], records: &str) -> Dataset {
        loaded_with(&metadata(kind, fitting, validation), records)
    }

    /// Serializes records into one record file.
    fn file(records: &[Value]) -> String {
        records
            .iter()
            .map(|value| serde_json::to_string(value).expect("serializes"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The default record file: two groups of two records each.
    fn default_records() -> String {
        file(&[
            record("case-1", "conversation-a"),
            record("case-2", "conversation-a"),
            record("case-3", "conversation-b"),
            record("case-4", "conversation-b"),
        ])
    }

    /// The identity of one split of one computed dataset.
    fn identity_of(splits: &DatasetSplits<'_>, split_id: &str) -> SplitIdentity {
        splits
            .split(split_id)
            .unwrap_or_else(|| panic!("the split {split_id}"))
            .identity()
            .clone()
    }

    #[test]
    fn one_dataset_identity_records_its_revision_hashes_and_assignments() {
        let dataset = loaded(
            "representative_sample",
            &["conversation-a"],
            &["conversation-b"],
            &default_records(),
        );
        let splits = dataset_splits(&dataset).expect("the splits compute");
        let identity = splits.identity();
        assert_eq!(identity.dataset_id, "intervention-cases");
        assert_eq!(identity.revision, "2026-09-24.1");
        assert_eq!(identity.kind, DatasetKind::RepresentativeSample);
        assert_eq!(
            identity.population,
            PopulationStatement::RepresentativeSample
        );
        assert_eq!(
            identity.intended_population,
            "Proposed messages in support conversations."
        );
        assert_eq!(
            identity.sampling_method,
            "Selected from reviewed development work. No prevalence claim."
        );
        assert_eq!(identity.record_count, 4);
        assert_eq!(identity.content_hash.len(), 64);
        assert_eq!(
            identity
                .group_assignments
                .iter()
                .map(|assignment| (
                    assignment.group.as_str(),
                    assignment.split_id.as_str(),
                    assignment.record_count
                ))
                .collect::<Vec<_>>(),
            [
                ("conversation-a", "fit", 2),
                ("conversation-b", "holdout", 2)
            ]
        );
        assert!(identity.unassigned_groups.is_empty());

        // The dataset hash is the digest of the records as supplied, the
        // same boundary the hashing module publishes.
        let records = [
            record("case-1", "conversation-a"),
            record("case-2", "conversation-a"),
            record("case-3", "conversation-b"),
            record("case-4", "conversation-b"),
        ];
        assert_eq!(
            identity.content_hash,
            hashing::dataset_hash(&records).expect("the records hash")
        );
    }

    #[test]
    fn one_group_stays_inside_one_split_with_its_records() {
        let dataset = loaded(
            "development_fixture",
            &["conversation-a"],
            &["conversation-b"],
            &default_records(),
        );
        let splits = dataset_splits(&dataset).expect("the splits compute");
        let fitting = splits.split("fit").expect("the fitting split");
        let validation = splits.split("holdout").expect("the validation split");
        assert_eq!(fitting.identity().purpose, SplitPurpose::Fitting);
        assert_eq!(fitting.identity().groups, ["conversation-a"]);
        assert_eq!(fitting.identity().record_count, 2);
        assert_eq!(fitting.identity().case_ids, ["case-1", "case-2"]);
        assert_eq!(
            fitting
                .records()
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            ["case-1", "case-2"]
        );
        assert_eq!(validation.identity().purpose, SplitPurpose::Validation);
        assert_eq!(validation.identity().case_ids, ["case-3", "case-4"]);
        assert_eq!(
            splits
                .splits()
                .iter()
                .map(|split| split.identity().split_id.as_str())
                .collect::<Vec<_>>(),
            ["fit", "holdout"]
        );
        assert!(splits.split("absent").is_none());
    }

    #[test]
    fn one_record_without_one_group_forms_one_unassigned_group() {
        let plain = json!({
            "id": "case-plain",
            "input": {"text": "Hello."},
            "label": {"author_type": "human", "reviewed": false}
        });
        let records = file(&[record("case-1", "conversation-a"), plain]);
        let dataset = loaded(
            "development_fixture",
            &["conversation-a"],
            &["conversation-b"],
            &records,
        );
        let splits = dataset_splits(&dataset).expect("the splits compute");
        let identity = splits.identity();
        assert_eq!(identity.unassigned_groups.len(), 1);
        let unassigned = &identity.unassigned_groups[0];
        assert_eq!(unassigned.group, "case-plain");
        assert_eq!(unassigned.record_count, 1);
        assert_eq!(unassigned.first_line, 2);
        // The declared group that no record states keeps its assignment
        // with zero records, and the empty split hashes the empty array.
        let holdout = splits.split("holdout").expect("the validation split");
        assert_eq!(holdout.identity().record_count, 0);
        assert_eq!(
            holdout.identity().content_hash,
            hashing::split_hash(&[]).expect("the empty set hashes")
        );
    }

    #[test]
    fn splits_reproduce_deterministically_under_any_file_order() {
        let records = default_records();
        let first_dataset = loaded(
            "representative_sample",
            &["conversation-a"],
            &["conversation-b"],
            &records,
        );
        let first = dataset_splits(&first_dataset).expect("the splits compute");

        let mut lines: Vec<&str> = records.split('\n').collect();
        crate::testing::SplitMix64::seeded(11).shuffle(&mut lines);
        let second_dataset = loaded(
            "representative_sample",
            &["conversation-a"],
            &["conversation-b"],
            &lines.join("\n"),
        );
        let second = dataset_splits(&second_dataset).expect("the splits compute");
        assert_eq!(
            first.identity().content_hash,
            second.identity().content_hash
        );
        for (left, right) in first.splits().iter().zip(second.splits()) {
            assert_eq!(left.identity(), right.identity());
        }

        // A changed input changes both hashes, so one stored hash catches
        // the changed content of one revision.
        let mut changed = record("case-3", "conversation-b");
        changed["input"]["text"] = json!("The input changed.");
        let third_dataset = loaded(
            "representative_sample",
            &["conversation-a"],
            &["conversation-b"],
            &file(&[
                record("case-1", "conversation-a"),
                record("case-2", "conversation-a"),
                changed,
                record("case-4", "conversation-b"),
            ]),
        );
        let third = dataset_splits(&third_dataset).expect("the splits compute");
        assert_ne!(third.identity().content_hash, first.identity().content_hash);
        assert_ne!(
            identity_of(&third, "holdout").content_hash,
            identity_of(&first, "holdout").content_hash
        );
        // The fitting split is unchanged, so its hash stays.
        assert_eq!(
            identity_of(&third, "fit").content_hash,
            identity_of(&first, "fit").content_hash
        );
    }

    #[test]
    fn one_stored_hash_that_differs_fails_with_hash_mismatch() {
        let records = default_records();
        let computed_dataset = loaded(
            "development_fixture",
            &["conversation-a"],
            &["conversation-b"],
            &records,
        );
        let computed = dataset_splits(&computed_dataset).expect("the splits compute");

        // One stored dataset hash that differs names the dataset field.
        let mut declared = metadata(
            "development_fixture",
            &["conversation-a"],
            &["conversation-b"],
        );
        declared["content_hash"] = json!("0".repeat(64));
        let text = serde_json::to_string(&declared).expect("serializes");
        let dataset = load_dataset(&text, &records).expect("the dataset loads");
        let error = dataset_splits(&dataset).expect_err("the stored hash differs");
        assert_eq!(error.code, ReasonCode::HashMismatch, "{error}");
        assert_eq!(error.field_path, "/content_hash", "{error}");

        // One stored split hash that differs names its split.
        let mut declared = metadata(
            "development_fixture",
            &["conversation-a"],
            &["conversation-b"],
        );
        declared["splits"][1]["content_hash"] = json!("0".repeat(64));
        let text = serde_json::to_string(&declared).expect("serializes");
        let dataset = load_dataset(&text, &records).expect("the dataset loads");
        let error = dataset_splits(&dataset).expect_err("the stored split hash differs");
        assert_eq!(error.code, ReasonCode::HashMismatch, "{error}");
        assert_eq!(error.field_path, "/splits/1/content_hash", "{error}");

        // One stored hash that agrees changes nothing.
        let mut declared = metadata(
            "development_fixture",
            &["conversation-a"],
            &["conversation-b"],
        );
        declared["content_hash"] = json!(computed.identity().content_hash);
        declared["splits"][0]["content_hash"] = json!(identity_of(&computed, "fit").content_hash);
        let text = serde_json::to_string(&declared).expect("serializes");
        let dataset = load_dataset(&text, &records).expect("the dataset loads");
        assert!(dataset_splits(&dataset).is_ok());
    }

    #[test]
    fn one_group_that_two_splits_declare_fails_at_load() {
        let declared = metadata(
            "development_fixture",
            &["conversation-a", "conversation-b"],
            &["conversation-b"],
        );
        let text = serde_json::to_string(&declared).expect("serializes");
        let error = load_dataset(&text, &default_records()).expect_err("the group repeats");
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/splits/1/groups/0", "{error}");
    }

    #[test]
    fn the_population_statement_keeps_challenge_sets_apart_from_samples() {
        for (kind, statement, qualification, prevalence) in [
            (
                DatasetKind::DevelopmentFixture,
                PopulationStatement::DevelopmentFixture,
                false,
                false,
            ),
            (
                DatasetKind::SyntheticChallenge,
                PopulationStatement::TargetedChallengeSet,
                false,
                false,
            ),
            (
                DatasetKind::RepresentativeSample,
                PopulationStatement::RepresentativeSample,
                true,
                true,
            ),
        ] {
            assert_eq!(PopulationStatement::of(kind), statement);
            assert_eq!(
                statement.supports_qualification(),
                qualification,
                "{kind:?}"
            );
            assert_eq!(statement.states_prevalence(), prevalence, "{kind:?}");
            assert_eq!(
                PopulationStatement::from_word(statement.as_str()),
                Some(statement)
            );
        }
        assert_eq!(PopulationStatement::from_word("challenge"), None);
    }

    #[test]
    fn separated_selections_of_one_dataset_report_no_overlap() {
        let dataset = loaded(
            "representative_sample",
            &["conversation-a"],
            &["conversation-b"],
            &default_records(),
        );
        let splits = dataset_splits(&dataset).expect("the splits compute");
        let fitting = identity_of(&splits, "fit");
        let validation = identity_of(&splits, "holdout");
        let overlap = split_overlap(&fitting, &validation);
        assert!(overlap.same_dataset);
        assert!(overlap.is_disjoint());
        assert!(require_separated(&fitting, &validation).is_ok());
    }

    #[test]
    fn duplicated_cases_and_shared_groups_report_their_overlap() {
        // Two datasets that declare unrelated group names still share one
        // case: the same record reached both files.
        let fitting_dataset = loaded(
            "representative_sample",
            &["conversation-a", "conversation-b"],
            &["conversation-c"],
            &file(&[
                record("case-1", "conversation-a"),
                record("case-3", "conversation-b"),
            ]),
        );
        let mut other_metadata = metadata(
            "representative_sample",
            &["conversation-x"],
            &["conversation-y"],
        );
        other_metadata["revision"] = json!("2026-09-24.2");
        let validation_dataset = loaded_with(
            &other_metadata,
            &file(&[
                record("case-3", "conversation-y"),
                record("case-9", "conversation-y"),
            ]),
        );
        let fitting = dataset_splits(&fitting_dataset).expect("the splits compute");
        let validation = dataset_splits(&validation_dataset).expect("the splits compute");
        let fitting_identity = identity_of(&fitting, "fit");
        let validation_identity = identity_of(&validation, "holdout");

        let overlap = split_overlap(&fitting_identity, &validation_identity);
        assert!(!overlap.same_dataset);
        assert!(overlap.shared_groups.is_empty());
        assert_eq!(overlap.shared_cases, ["case-3"]);
        assert!(!overlap.is_disjoint());
        let error = require_separated(&fitting_identity, &validation_identity)
            .expect_err("one case repeats");
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/datasets/validation", "{error}");
        assert!(error.message.contains("case"), "{error}");

        // One shared group name across two datasets is overlap of the
        // declared grouping strategy.
        let other_dataset = loaded(
            "representative_sample",
            &["conversation-x"],
            &["conversation-a"],
            &file(&[
                record("case-5", "conversation-a"),
                record("case-6", "conversation-a"),
            ]),
        );
        let other = dataset_splits(&other_dataset).expect("the splits compute");
        let overlap = split_overlap(&fitting_identity, &identity_of(&other, "holdout"));
        assert_eq!(overlap.shared_groups, ["conversation-a"]);
        assert!(overlap.shared_cases.is_empty());
        assert!(!overlap.is_disjoint());
        let error = require_separated(&fitting_identity, &identity_of(&other, "holdout"))
            .expect_err("one group repeats");
        assert!(error.message.contains("group"), "{error}");
    }

    #[test]
    fn one_reused_holdout_is_development_data() {
        let dataset = loaded(
            "representative_sample",
            &["conversation-a"],
            &["conversation-b"],
            &default_records(),
        );
        let splits = dataset_splits(&dataset).expect("the splits compute");
        let holdout = identity_of(&splits, "holdout");

        let fresh = validation_evidence(&holdout, PopulationStatement::RepresentativeSample, &[]);
        assert_eq!(fresh.class, EvidenceClass::IndependentValidation);
        assert!(fresh.is_independent());
        assert!(fresh.representative_sample);
        assert!(!fresh.needs_fresh_evidence);
        assert_eq!(fresh.record_count, 2);
        assert!(fresh.statement.contains("2 records"), "{}", fresh.statement);

        // The same holdout that one earlier claim consumed is development
        // data, and one new claim needs fresh evidence.
        let reused = validation_evidence(
            &holdout,
            PopulationStatement::RepresentativeSample,
            std::slice::from_ref(&holdout),
        );
        assert_eq!(reused.class, EvidenceClass::Development);
        assert!(reused.needs_fresh_evidence);
        assert_eq!(
            reused.reused_from,
            [holdout.reference()],
            "the reference names the earlier use"
        );
        assert!(
            reused.statement.contains("development data"),
            "{}",
            reused.statement
        );

        // One renamed split that holds the same records is the same
        // holdout: the content decides, not the names.
        let mut renamed = holdout.clone();
        renamed.split_id = "holdout-2".to_owned();
        renamed.dataset_id = "other-cases".to_owned();
        assert!(renamed.same_content(&holdout));
        let reused = validation_evidence(
            &holdout,
            PopulationStatement::RepresentativeSample,
            &[renamed],
        );
        assert_eq!(reused.class, EvidenceClass::Development);
        assert_eq!(reused.reused_from.len(), 1);

        // One changed holdout is fresh content.
        let changed_dataset = loaded(
            "representative_sample",
            &["conversation-a"],
            &["conversation-b", "conversation-c"],
            &file(&[
                record("case-1", "conversation-a"),
                record("case-3", "conversation-b"),
                record("case-7", "conversation-c"),
            ]),
        );
        let changed = dataset_splits(&changed_dataset).expect("the splits compute");
        let other_holdout = identity_of(&changed, "holdout");
        assert!(!other_holdout.same_content(&holdout));
        let fresh = validation_evidence(
            &other_holdout,
            PopulationStatement::RepresentativeSample,
            &[holdout],
        );
        assert!(fresh.is_independent());
    }

    #[test]
    fn one_challenge_set_and_one_empty_split_support_no_claim() {
        let challenge_dataset = loaded(
            "synthetic_challenge",
            &["conversation-a"],
            &["conversation-b"],
            &default_records(),
        );
        let challenge = dataset_splits(&challenge_dataset).expect("the splits compute");
        let evidence = validation_evidence(
            &identity_of(&challenge, "holdout"),
            PopulationStatement::TargetedChallengeSet,
            &[],
        );
        assert_eq!(evidence.class, EvidenceClass::Development);
        assert!(!evidence.representative_sample);
        assert!(evidence.needs_fresh_evidence);
        assert!(
            evidence.statement.contains("targeted_challenge_set"),
            "{}",
            evidence.statement
        );

        // One declared group that no record states holds no evidence.
        let empty_dataset = loaded(
            "representative_sample",
            &["conversation-a"],
            &["conversation-b"],
            &file(&[
                record("case-1", "conversation-a"),
                record("case-2", "conversation-a"),
            ]),
        );
        let empty = dataset_splits(&empty_dataset).expect("the splits compute");
        let evidence = validation_evidence(
            &identity_of(&empty, "holdout"),
            PopulationStatement::RepresentativeSample,
            &[],
        );
        assert_eq!(evidence.class, EvidenceClass::Development);
        assert!(
            evidence.statement.contains("no record"),
            "{}",
            evidence.statement
        );
    }

    #[test]
    fn one_split_identity_round_trips_through_its_serialized_form() {
        let dataset = loaded(
            "representative_sample",
            &["conversation-a"],
            &["conversation-b"],
            &default_records(),
        );
        let splits = dataset_splits(&dataset).expect("the splits compute");
        let holdout = identity_of(&splits, "holdout");
        let value = serde_json::to_value(&holdout).expect("the identity serializes");
        assert_eq!(value["dataset"], "intervention-cases");
        assert_eq!(value["case_ids"], json!(["case-3", "case-4"]));
        assert_eq!(
            parse_split_identity(&value).expect("the identity parses"),
            holdout
        );
    }

    #[test]
    fn broken_split_identities_report_their_field_paths() {
        let dataset = loaded(
            "development_fixture",
            &["conversation-a"],
            &["conversation-b"],
            &default_records(),
        );
        let splits = dataset_splits(&dataset).expect("the splits compute");
        let value = serde_json::to_value(identity_of(&splits, "holdout")).expect("serializes");

        let mut broken = value.clone();
        broken["split"] = json!("Holdout");
        let error = parse_split_identity(&broken).expect_err("one invalid identifier");
        assert_eq!(error.field_path, "/split", "{error}");

        let mut broken = value.clone();
        broken["purpose"] = json!("holdout");
        let error = parse_split_identity(&broken).expect_err("one unknown purpose");
        assert_eq!(error.field_path, "/purpose", "{error}");

        let mut broken = value.clone();
        broken["content_hash"] = json!("nothex");
        let error = parse_split_identity(&broken).expect_err("one malformed hash");
        assert_eq!(error.field_path, "/content_hash", "{error}");

        let mut broken = value.clone();
        broken["record_count"] = json!(7);
        let error = parse_split_identity(&broken).expect_err("one wrong count");
        assert_eq!(error.field_path, "/record_count", "{error}");

        let mut broken = value.clone();
        broken["case_ids"][0] = broken["case_ids"][1].clone();
        let error = parse_split_identity(&broken).expect_err("one repeated case");
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/case_ids/1", "{error}");

        let mut broken = value.clone();
        broken["extra"] = json!(1);
        let error = parse_split_identity(&broken).expect_err("one unknown field");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");

        let error = parse_split_identity(&json!("text")).expect_err("one non-object identity");
        assert_eq!(error.field_path, "", "{error}");

        for field in [
            "dataset",
            "revision",
            "split",
            "purpose",
            "record_count",
            "content_hash",
            "case_ids",
        ] {
            let mut broken = value.clone();
            broken.as_object_mut().expect("an object").remove(field);
            let error = parse_split_identity(&broken).expect_err("one missing field");
            assert_eq!(error.code, ReasonCode::MissingField, "{field}: {error}");
            assert_eq!(error.field_path, format!("/{field}"), "{field}");
        }
    }
}
