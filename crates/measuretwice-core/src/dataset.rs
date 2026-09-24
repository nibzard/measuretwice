// SPDX-License-Identifier: Apache-2.0
//! Versioned JSONL case datasets and their metadata.
//!
//! A dataset is one JSONL record file plus one metadata file, as the
//! contracts README states. Each nonempty line of the record file holds
//! exactly one case record. The metadata file declares the intended
//! population, the sampling method, the revision, the label guidelines,
//! and the grouped splits.
//!
//! [`parse_case_record`] checks one record against the case-record
//! contract: a stable identifier, an optional group, optional slice tags,
//! one input object, optional reference labels, and the provenance of the
//! label. [`parse_dataset_metadata_str`] checks the metadata artifact the
//! same way. [`load_dataset`] reads the complete record file line by line
//! and returns one [`Dataset`], or one typed failure that names the line
//! and the field: the field path states `/records/<line>` plus the pointer
//! inside the record.
//!
//! Reference labels stay outside the input object, and the run-case
//! envelope of [`crate::case`] accepts `id` and `input` alone, so no label,
//! expected outcome, or provenance field can reach an evaluator request.
//! [`validate_dataset`] runs every input object through the case boundary
//! of one validated definition and returns one [`ValidatedDataset`] whose
//! records project only the inputs that each check `using` list names.
//!
//! The same call checks every reference label against the meaning of the
//! definition. One reference that names no declared check, one answer or
//! level outside the declared labels, and one reference answer on a rule
//! check each fail with their field path. One reference answer whose
//! acceptance meaning disagrees with the stated expected outcome stays as
//! written and becomes one [`LabelFinding`] of the [`LabelReview`] that
//! [`ValidatedDataset::label_review`] returns, because the contracts state
//! that such a conflict is flagged for review, never resolved silently. The
//! review also summarizes the provenance of every reference, so one
//! unreviewed model proposal cannot appear as one reviewed human judgment.
//!
//! The loader enforces the published limits: one record line holds at most
//! [`MAX_RECORD_BYTES`] bytes, one dataset holds at most
//! [`MAX_DATASET_RECORDS`] records, and the record file holds at most
//! [`MAX_DATASET_BYTES`] bytes. Nothing is truncated. The loader retains
//! the complete parsed records in memory and writes no file: report
//! retention and source snapshots stay with the host.
//!
//! The deeper split invariants, group coverage, and content hashes of a
//! dataset arrive with the split-identity task.

use crate::artifact::{expect_object, reject_unknown_fields, schema_version};
use crate::case::{is_case_id, Case, ProjectedInputs, ValidatedCase};
use crate::definition::{is_artifact_id, CheckKind, ValidatedDefinition};
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::hashing::is_hash_hex;
use crate::report::Outcome;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Returns true when one review marker is absent. Serde skips one false
/// `review` field with this predicate.
fn is_false(value: &bool) -> bool {
    !*value
}

/// Size bound for one record line, in bytes.
pub const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;

/// Record bound for one dataset.
pub const MAX_DATASET_RECORDS: usize = 100_000;

/// Size bound for the complete record file, in bytes.
pub const MAX_DATASET_BYTES: usize = 512 * 1024 * 1024;

/// Fields of one case record, from the schema file.
const RECORD_FIELDS: &[&str] = &["id", "group", "tags", "input", "expected", "label"];

/// Fields of one expected-label object.
const EXPECTED_FIELDS: &[&str] = &["checks", "outcome"];

/// Fields of one expected check reference.
const EXPECTED_CHECK_FIELDS: &[&str] = &["answer", "level", "review", "outcome"];

/// Fields of one label provenance record.
const LABEL_FIELDS: &[&str] = &[
    "author_type",
    "origin",
    "reviewed",
    "reviewer",
    "reason",
    "history",
];

/// Fields of one dataset metadata artifact.
const METADATA_FIELDS: &[&str] = &[
    "schema_version",
    "id",
    "name",
    "revision",
    "kind",
    "intended_population",
    "sampling_method",
    "label_guidelines",
    "languages",
    "record_count",
    "content_hash",
    "splits",
];

/// Fields of one split declaration.
const SPLIT_FIELDS: &[&str] = &["id", "purpose", "groups", "content_hash"];

/// Who produced one reference label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelAuthor {
    /// A person wrote the reference.
    Human,
    /// A model proposed the reference. A coding agent counts as a model
    /// author.
    Model,
}

impl LabelAuthor {
    /// Returns the contract word of this author type.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Model => "model",
        }
    }

    /// Returns the author of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "human" => Some(Self::Human),
            "model" => Some(Self::Model),
            _ => None,
        }
    }
}

/// How the reference of one label came to exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelOrigin {
    /// Written for the dataset.
    Synthetic,
    /// Collected from real traffic.
    Collected,
}

impl LabelOrigin {
    /// Returns the contract word of this origin.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Synthetic => "synthetic",
            Self::Collected => "collected",
        }
    }

    /// Returns the origin of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "synthetic" => Some(Self::Synthetic),
            "collected" => Some(Self::Collected),
            _ => None,
        }
    }
}

/// The provenance of one reference label.
///
/// The record keeps who produced the reference and whether a human
/// reviewed it. A model suggestion that no human reviewed is not a human
/// judgment. Earlier label records stay in `history` when one correction
/// replaces a reference.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LabelProvenance {
    /// Who produced the reference.
    pub author_type: LabelAuthor,
    /// How the reference came to exist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<LabelOrigin>,
    /// Whether a human reviewed the reference after it was proposed.
    pub reviewed: bool,
    /// Reviewer attribution, required when `reviewed` is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
    /// Short statement of why the reference applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Earlier label records, kept across one correction.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<LabelProvenance>,
}

/// One expected reference of one check.
///
/// The reference holds a named answer, a scale level, a review marker for
/// an ambiguous case, or an expected policy outcome. A conflict between an
/// answer and an outcome stays as written; [`validate_dataset`] flags it
/// through the label review instead of changing either field.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExpectedCheck {
    /// Reference answer label, for a question with named answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    /// Reference scale level, for an ordered question.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// The reference is ambiguous and needs one human review.
    #[serde(skip_serializing_if = "is_false")]
    pub review: bool,
    /// Expected policy outcome of this check, where labeled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

/// The reference labels of one case record.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExpectedLabels {
    /// Reference answers and expected outcomes, by check identifier.
    pub checks: BTreeMap<String, ExpectedCheck>,
    /// Expected overall outcome, where labeled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

/// The kind of one flagged label conflict.
///
/// A finding reports one reference that one human must review. It states no
/// rejection: the record keeps every field as written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelFindingKind {
    /// One reference answer or review marker implies one outcome that
    /// differs from the stated expected outcome of the same check.
    CheckOutcomeConflict,
    /// The stated overall outcome differs from the aggregate of the stated
    /// per-check outcomes.
    OverallOutcomeConflict,
}

impl LabelFindingKind {
    /// Returns the contract word of this kind.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CheckOutcomeConflict => "check_outcome_conflict",
            Self::OverallOutcomeConflict => "overall_outcome_conflict",
        }
    }

    /// Returns the kind of one contract word, or `None` for any other text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "check_outcome_conflict" => Some(Self::CheckOutcomeConflict),
            "overall_outcome_conflict" => Some(Self::OverallOutcomeConflict),
            _ => None,
        }
    }
}

/// One flagged label conflict of one validated dataset.
///
/// The finding names the record, the check, and the field that needs one
/// human decision. It never changes the record, and it carries no case
/// content: the message names the labels and the outcomes alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LabelFinding {
    /// Line of the record inside the record file, counted from 1.
    pub line: usize,
    /// Stable case identifier of the record.
    pub case_id: String,
    /// Check identifier, when the conflict belongs to one check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_id: Option<String>,
    /// Kind of the conflict.
    pub kind: LabelFindingKind,
    /// Field path of the conflicting reference, prefixed with the record
    /// line, for example `/records/3/expected/checks/support/outcome`.
    pub field_path: String,
    /// Short statement of the conflict.
    pub message: String,
}

/// The provenance summary of the reference labels of one dataset.
///
/// Every count covers the records that state one expected-label object,
/// except `records` and `unlabeled`, which cover the complete dataset. Only
/// the reviewed counts are reviewed evidence: one model proposal that no
/// human reviewed stays inside `model_unreviewed`, whatever the dataset
/// metadata states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LabelSummary {
    /// Number of case records of the dataset.
    pub records: usize,
    /// Number of records that state one expected-label object.
    pub labeled: usize,
    /// Number of records without reference labels. Missing labels leave the
    /// metrics that need them, never the records that carry them.
    pub unlabeled: usize,
    /// Human-written references with one recorded human review.
    pub human_reviewed: usize,
    /// Human-written references with no recorded review.
    pub human_unreviewed: usize,
    /// Model-proposed references with one recorded human review.
    pub model_reviewed: usize,
    /// Model-proposed references that no human reviewed.
    pub model_unreviewed: usize,
    /// References with one correction, so `label.history` keeps the earlier
    /// provenance records.
    pub corrected: usize,
    /// References that state one review marker or carry one flagged
    /// conflict. One human must review them before they serve as reference
    /// labels.
    pub review_required: usize,
}

impl LabelFinding {
    /// Moves one finding into one record line, prefixing `/records/<line>`
    /// onto its field path, the way one validation failure states its
    /// location.
    fn at_line(mut self, line: usize) -> Self {
        if line > 0 {
            let prefix = format!("/records/{line}");
            self.field_path = if self.field_path.is_empty() {
                prefix
            } else {
                format!("{prefix}{}", self.field_path)
            };
        }
        self
    }
}

impl LabelSummary {
    /// Returns the number of references that carry one recorded human
    /// review. This is the only count that states reviewed evidence.
    pub fn reviewed(&self) -> usize {
        self.human_reviewed + self.model_reviewed
    }

    /// Returns the number of references that no human reviewed. These are
    /// proposals, not judgments.
    pub fn unreviewed(&self) -> usize {
        self.human_unreviewed + self.model_unreviewed
    }
}

/// The label review of one validated dataset.
///
/// The review keeps human judgments distinct from model suggestions: the
/// summary counts the provenance of every reference, and the findings name
/// the references whose stated outcome disagrees with the acceptance
/// meaning of their check.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LabelReview {
    /// Provenance summary of every reference label.
    summary: LabelSummary,
    /// Every flagged conflict, in record order.
    findings: Vec<LabelFinding>,
}

impl LabelReview {
    /// Returns the provenance summary of every reference label.
    pub fn summary(&self) -> &LabelSummary {
        &self.summary
    }

    /// Returns every flagged conflict, in record order.
    pub fn findings(&self) -> &[LabelFinding] {
        &self.findings
    }

    /// Returns true when no reference carries one flagged conflict.
    pub fn is_conflict_free(&self) -> bool {
        self.findings.is_empty()
    }
}

/// One parsed case record.
///
/// A `CaseRecord` value states that the record passed the case-record
/// contract. The input object is unchecked here; the semantic check runs
/// against one definition, because only one definition states the input
/// schema. Reference labels and provenance stay outside the input object.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CaseRecord {
    /// Line of this record inside the record file, counted from 1. Zero
    /// when one record was parsed outside one file.
    #[serde(skip)]
    pub line: usize,
    /// Stable case identifier, unique inside one dataset.
    pub id: String,
    /// Group of related cases. One record without a group forms its own
    /// group, so this field never stays empty.
    pub group: String,
    /// Slice and failure-type tags.
    pub tags: Vec<String>,
    /// The complete input object, as supplied.
    pub input: Map<String, Value>,
    /// Reference labels and expected policy outcomes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<ExpectedLabels>,
    /// Provenance of the reference label.
    pub label: LabelProvenance,
}

/// The kind of one dataset, as the metadata contract states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetKind {
    /// Development fixtures for one project. Not a population sample.
    DevelopmentFixture,
    /// Targeted synthetic challenge set. Selected hard cases change the
    /// sampling, so they state no prevalence.
    SyntheticChallenge,
    /// Representative sample of the declared population. Qualification
    /// claims need this kind.
    RepresentativeSample,
}

impl DatasetKind {
    /// Returns the contract word of this kind.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DevelopmentFixture => "development_fixture",
            Self::SyntheticChallenge => "synthetic_challenge",
            Self::RepresentativeSample => "representative_sample",
        }
    }

    /// Returns the kind of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "development_fixture" => Some(Self::DevelopmentFixture),
            "synthetic_challenge" => Some(Self::SyntheticChallenge),
            "representative_sample" => Some(Self::RepresentativeSample),
            _ => None,
        }
    }
}

/// The purpose of one split.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitPurpose {
    /// Candidate tuning.
    Fitting,
    /// Independent evidence.
    Validation,
}

impl SplitPurpose {
    /// Returns the contract word of this purpose.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fitting => "fitting",
            Self::Validation => "validation",
        }
    }

    /// Returns the purpose of one contract word, or `None` for any other
    /// text.
    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "fitting" => Some(Self::Fitting),
            "validation" => Some(Self::Validation),
            _ => None,
        }
    }
}

/// One declared split of one dataset.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SplitDeclaration {
    /// Stable split identifier, unique inside the dataset.
    pub id: String,
    /// Fitting or validation.
    pub purpose: SplitPurpose,
    /// Groups assigned to this split, in the declared order.
    pub groups: Vec<String>,
    /// Stored hash of the canonical records of this split.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

/// One parsed dataset metadata artifact.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DatasetMetadata {
    /// Artifact schema version. The core supports version 1.
    pub schema_version: u32,
    /// Stable dataset identifier.
    pub id: String,
    /// Readable dataset name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Dataset revision. Changed content needs one new revision.
    pub revision: String,
    /// Dataset kind.
    pub kind: DatasetKind,
    /// Population that the sampling procedure targets.
    pub intended_population: String,
    /// How the cases were selected.
    pub sampling_method: String,
    /// Written label guidelines, or one explicit reference to them.
    pub label_guidelines: String,
    /// Language tags that occur in the cases.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub languages: Vec<String>,
    /// Declared record count, checked against the record file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_count: Option<usize>,
    /// Stored hash of the canonical case-record content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// Declared grouped splits.
    pub splits: Vec<SplitDeclaration>,
}

/// One loaded dataset: the metadata artifact and the complete records.
#[derive(Debug, Clone, PartialEq)]
pub struct Dataset {
    metadata: DatasetMetadata,
    records: Vec<CaseRecord>,
}

impl Dataset {
    /// Returns the metadata artifact of this dataset.
    pub fn metadata(&self) -> &DatasetMetadata {
        &self.metadata
    }

    /// Returns every case record, in file order.
    pub fn records(&self) -> &[CaseRecord] {
        &self.records
    }

    /// Returns the number of case records.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Returns true when the dataset holds no record.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
}

/// One record of one dataset validated against one definition.
#[derive(Debug)]
pub struct ValidatedDatasetRecord<'a> {
    record: &'a CaseRecord,
    case: &'a ValidatedCase<'a>,
}

impl<'a> ValidatedDatasetRecord<'a> {
    /// Returns the line of this record inside the record file.
    pub fn line(&self) -> usize {
        self.record.line
    }

    /// Returns the stable case identifier.
    pub fn id(&self) -> &str {
        &self.record.id
    }

    /// Returns the group of related cases.
    pub fn group(&self) -> &str {
        &self.record.group
    }

    /// Returns the slice tags of this record.
    pub fn tags(&self) -> &[String] {
        &self.record.tags
    }

    /// Returns the complete input object, unchanged.
    pub fn input(&self) -> &Map<String, Value> {
        self.case.input()
    }

    /// Returns the reference labels, when one is present.
    pub fn expected(&self) -> Option<&ExpectedLabels> {
        self.record.expected.as_ref()
    }

    /// Returns the label provenance.
    pub fn label(&self) -> &LabelProvenance {
        &self.record.label
    }

    /// Projects the authorized inputs of every check, in definition order.
    ///
    /// Each projected map holds only the inputs that the check `using`
    /// list names. The case identifier, the labels, and every undeclared
    /// field stay outside.
    pub fn projected_inputs(&self) -> Vec<ProjectedInputs> {
        self.case.projected_inputs()
    }
}

/// One dataset whose every input object passed the schema of one
/// definition.
#[derive(Debug)]
pub struct ValidatedDataset<'a> {
    definition: &'a ValidatedDefinition,
    dataset: &'a Dataset,
    cases: Vec<ValidatedCase<'a>>,
    labels: LabelReview,
}

impl<'a> ValidatedDataset<'a> {
    /// Returns the definition that validated the inputs.
    pub fn definition(&self) -> &'a ValidatedDefinition {
        self.definition
    }

    /// Returns the metadata artifact of this dataset.
    pub fn metadata(&self) -> &DatasetMetadata {
        self.dataset.metadata()
    }

    /// Returns the label review of this dataset: the provenance summary of
    /// every reference label and every flagged conflict that one human must
    /// decide.
    pub fn label_review(&self) -> &LabelReview {
        &self.labels
    }

    /// Returns every case record, in file order.
    pub fn records(&self) -> &[CaseRecord] {
        self.dataset.records()
    }

    /// Returns the number of case records.
    pub fn len(&self) -> usize {
        self.dataset.len()
    }

    /// Returns true when the dataset holds no record.
    pub fn is_empty(&self) -> bool {
        self.dataset.is_empty()
    }

    /// Returns one validated record by position, in file order.
    pub fn record(&self, index: usize) -> Option<ValidatedDatasetRecord<'_>> {
        let record = self.dataset.records.get(index)?;
        let case = self.cases.get(index)?;
        Some(ValidatedDatasetRecord { record, case })
    }
}

/// Parses one case record from a JSON value that passed the strict gate.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value breaks the case-record
/// contract: an unknown field, a missing field, a wrong type, an invalid
/// identifier, or one reviewed label without one reviewer.
pub fn parse_case_record(value: &Value) -> Result<CaseRecord, ValidationError> {
    let root = expect_object(value, "")?;
    reject_unknown_fields(root, RECORD_FIELDS, "")?;

    let id = match root.get("id") {
        Some(Value::String(text)) if is_case_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/id",
                "The case identifier must start with a lowercase letter or a digit, then hold lowercase letters, digits, dots, underscores, or hyphens, 128 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing("/id")),
    };

    let group = match root.get("group") {
        None => None,
        Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= 128 => {
            Some(text.clone())
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/group",
                "The group must hold 1 to 128 characters.",
            ));
        }
    };

    let tags = match root.get("tags") {
        None => Vec::new(),
        Some(Value::Array(items)) => parse_tags(items, "/tags")?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/tags",
                "The tags must hold one array of strings.",
            ));
        }
    };

    let input = match root.get("input") {
        Some(value) if value.is_object() => value.as_object().expect("checked").clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/input",
                "The case input must be one object.",
            ));
        }
        None => return Err(ValidationError::missing("/input")),
    };

    let expected = match root.get("expected") {
        None => None,
        Some(value) => Some(parse_expected(value)?),
    };

    let label = match root.get("label") {
        Some(value) => parse_label(value)?,
        None => return Err(ValidationError::missing("/label")),
    };

    // One record without a group forms its own group, so every record
    // carries one group and the later split work needs no special case.
    let group = group.unwrap_or_else(|| id.clone());
    Ok(CaseRecord {
        line: 0,
        id,
        group,
        tags,
        input,
        expected,
        label,
    })
}

/// Parses the tags of one record, rejecting repeats and long values.
fn parse_tags(items: &[Value], path: &str) -> Result<Vec<String>, ValidationError> {
    let mut tags = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let Value::String(text) = item else {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/{index}"),
                "Each tag must hold 1 to 64 characters.",
            ));
        };
        if text.is_empty() || text.chars().count() > 64 {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/{index}"),
                "Each tag must hold 1 to 64 characters.",
            ));
        }
        if tags.contains(text) {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/{index}"),
                format!("The tags repeat {}.", fragment(text)),
            ));
        }
        tags.push(text.clone());
    }
    Ok(tags)
}

/// Parses one expected-label object of one record.
fn parse_expected(value: &Value) -> Result<ExpectedLabels, ValidationError> {
    let root = expect_object(value, "/expected")?;
    reject_unknown_fields(root, EXPECTED_FIELDS, "/expected")?;

    let checks = match root.get("checks") {
        None => BTreeMap::new(),
        Some(Value::Object(entries)) => {
            if entries.is_empty() {
                return Err(ValidationError::invalid_field_type(
                    "/expected/checks",
                    "The expected checks must name at least one check.",
                ));
            }
            let mut checks = BTreeMap::new();
            for (check_id, entry) in entries {
                checks.insert(check_id.clone(), parse_expected_check(entry, check_id)?);
            }
            checks
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/expected/checks",
                "The expected checks must hold one object.",
            ));
        }
    };

    let outcome = parse_expected_outcome(root.get("outcome"), "/expected/outcome")?;

    Ok(ExpectedLabels { checks, outcome })
}

/// Parses one expected check reference of one record.
fn parse_expected_check(value: &Value, check_id: &str) -> Result<ExpectedCheck, ValidationError> {
    let path = format!("/expected/checks/{check_id}");
    let root = expect_object(value, &path)?;
    reject_unknown_fields(root, EXPECTED_CHECK_FIELDS, &path)?;

    let bounded = |field: &str| -> Result<Option<String>, ValidationError> {
        match root.get(field) {
            None => Ok(None),
            Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= 64 => {
                Ok(Some(text.clone()))
            }
            Some(_) => Err(ValidationError::invalid_field_type(
                format!("{path}/{field}"),
                "The reference must hold 1 to 64 characters.",
            )),
        }
    };

    let answer = bounded("answer")?;
    let level = bounded("level")?;
    let review = match root.get("review") {
        None => false,
        Some(Value::Bool(true)) => true,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/review"),
                "The review marker must be true.",
            ));
        }
    };
    let outcome = parse_expected_outcome(root.get("outcome"), &format!("{path}/outcome"))?;

    if answer.is_none() && level.is_none() && !review && outcome.is_none() {
        return Err(ValidationError::invalid_field_type(
            path,
            "One expected check states at least one of answer, level, review, or outcome.",
        ));
    }

    Ok(ExpectedCheck {
        answer,
        level,
        review,
        outcome,
    })
}

/// Parses one expected outcome word, `pass`, `fail`, or `review`.
fn parse_expected_outcome(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<String>, ValidationError> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) if matches!(text.as_str(), "pass" | "fail" | "review") => {
            Ok(Some(text.clone()))
        }
        Some(_) => Err(ValidationError::invalid_field_type(
            path,
            "The expected outcome must be pass, fail, or review.",
        )),
    }
}

/// Parses one label provenance record.
fn parse_label(value: &Value) -> Result<LabelProvenance, ValidationError> {
    parse_label_at(value, "/label")
}

/// Parses one label provenance record at one path. The entries of
/// `label.history` reuse the same rules at their own path.
fn parse_label_at(value: &Value, path: &str) -> Result<LabelProvenance, ValidationError> {
    let root = expect_object(value, path)?;
    reject_unknown_fields(root, LABEL_FIELDS, path)?;

    let author_type = match root.get("author_type") {
        Some(Value::String(text)) => LabelAuthor::from_word(text).ok_or_else(|| {
            ValidationError::invalid_field_type(
                format!("{path}/author_type"),
                "The author type must be human or model.",
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/author_type"),
                "The author type must be human or model.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{path}/author_type"))),
    };

    let origin = match root.get("origin") {
        None => None,
        Some(Value::String(text)) => Some(LabelOrigin::from_word(text).ok_or_else(|| {
            ValidationError::invalid_field_type(
                format!("{path}/origin"),
                "The origin must be synthetic or collected.",
            )
        })?),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/origin"),
                "The origin must be synthetic or collected.",
            ));
        }
    };

    let reviewed = match root.get("reviewed") {
        Some(Value::Bool(reviewed)) => *reviewed,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/reviewed"),
                "The reviewed field must be true or false.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{path}/reviewed"))),
    };

    let reviewer = match root.get("reviewer") {
        None => None,
        Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= 128 => {
            Some(text.clone())
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/reviewer"),
                "The reviewer must hold 1 to 128 characters.",
            ));
        }
    };
    if reviewed && reviewer.is_none() {
        return Err(ValidationError::missing(format!("{path}/reviewer")));
    }

    let reason = match root.get("reason") {
        None => None,
        Some(Value::String(text)) if text.chars().count() <= 1000 => Some(text.clone()),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/reason"),
                "The reason must hold 1000 characters at most.",
            ));
        }
    };

    let history = match root.get("history") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut history = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                history.push(parse_label_at(item, &format!("{path}/history/{index}"))?);
            }
            history
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/history"),
                "The label history must hold one array of label records.",
            ));
        }
    };

    Ok(LabelProvenance {
        author_type,
        origin,
        reviewed,
        reviewer,
        reason,
        history,
    })
}

/// Parses one dataset metadata artifact from strict JSON text.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the text fails the strict JSON gate
/// or the dataset metadata contract.
pub fn parse_dataset_metadata_str(text: &str) -> Result<DatasetMetadata, ValidationError> {
    crate::json::parse_strict(text).and_then(|value| parse_dataset_metadata(&value))
}

/// Parses one dataset metadata artifact from a JSON value that passed the
/// strict gate.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value breaks the dataset
/// metadata contract: an unknown field, a missing field, a wrong type, an
/// invalid identifier, a repeated split identifier, or one repeated
/// language tag.
pub fn parse_dataset_metadata(value: &Value) -> Result<DatasetMetadata, ValidationError> {
    let root = expect_object(value, "")?;
    reject_unknown_fields(root, METADATA_FIELDS, "")?;
    let version = schema_version(root)?;

    let id = read_artifact_id(root.get("id"), "/id", "The dataset identifier")?;
    let name = read_optional_text(root.get("name"), "/name", 200, "The dataset name")?;
    let revision = read_required_text(
        root.get("revision"),
        "/revision",
        64,
        "The dataset revision",
    )?;
    let kind = match root.get("kind") {
        Some(Value::String(text)) => DatasetKind::from_word(text).ok_or_else(|| {
            ValidationError::invalid_field_type(
                "/kind",
                "The dataset kind must be development_fixture, synthetic_challenge, or representative_sample.",
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/kind",
                "The dataset kind must be development_fixture, synthetic_challenge, or representative_sample.",
            ));
        }
        None => return Err(ValidationError::missing("/kind")),
    };
    let intended_population = read_required_text(
        root.get("intended_population"),
        "/intended_population",
        2000,
        "The intended population",
    )?;
    let sampling_method = read_required_text(
        root.get("sampling_method"),
        "/sampling_method",
        2000,
        "The sampling method",
    )?;
    let label_guidelines = read_required_text(
        root.get("label_guidelines"),
        "/label_guidelines",
        4000,
        "The label guidelines",
    )?;

    let languages = match root.get("languages") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut languages = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let Value::String(text) = item else {
                    return Err(ValidationError::invalid_field_type(
                        format!("/languages/{index}"),
                        "Each language tag must hold 2 to 35 characters.",
                    ));
                };
                if text.chars().count() < 2 || text.chars().count() > 35 {
                    return Err(ValidationError::invalid_field_type(
                        format!("/languages/{index}"),
                        "Each language tag must hold 2 to 35 characters.",
                    ));
                }
                if languages.contains(text) {
                    return Err(ValidationError::invalid_field_type(
                        format!("/languages/{index}"),
                        format!("The languages repeat {}.", fragment(text)),
                    ));
                }
                languages.push(text.clone());
            }
            languages
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/languages",
                "The languages must hold one array of strings.",
            ));
        }
    };

    let record_count = match root.get("record_count") {
        None => None,
        Some(Value::Number(number)) => {
            let count = number.as_u64().filter(|count| *count >= 1).ok_or_else(|| {
                ValidationError::invalid_field_type(
                    "/record_count",
                    "The record count must be one whole number of at least 1.",
                )
            })?;
            Some(count as usize)
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/record_count",
                "The record count must be one whole number of at least 1.",
            ));
        }
    };

    let content_hash = read_optional_hash(root.get("content_hash"), "/content_hash")?;

    let splits = match root.get("splits") {
        Some(Value::Array(items)) if !items.is_empty() => {
            let mut splits = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                splits.push(parse_split(item, index)?);
            }
            for (index, split) in splits.iter().enumerate() {
                if splits[..index].iter().any(|other| other.id == split.id) {
                    return Err(ValidationError::new(
                        ReasonCode::DuplicateId,
                        format!("/splits/{index}/id"),
                        format!("Two splits share one identifier: {}.", fragment(&split.id)),
                    ));
                }
            }
            splits
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/splits",
                "The splits must hold one array with at least one split.",
            ));
        }
        None => return Err(ValidationError::missing("/splits")),
    };

    Ok(DatasetMetadata {
        schema_version: version,
        id,
        name,
        revision,
        kind,
        intended_population,
        sampling_method,
        label_guidelines,
        languages,
        record_count,
        content_hash,
        splits,
    })
}

/// Parses one split declaration at its array position.
fn parse_split(value: &Value, index: usize) -> Result<SplitDeclaration, ValidationError> {
    let path = format!("/splits/{index}");
    let root = expect_object(value, &path)?;
    reject_unknown_fields(root, SPLIT_FIELDS, &path)?;

    let id = read_artifact_id(
        root.get("id"),
        &format!("{path}/id"),
        "The split identifier",
    )?;

    let purpose = match root.get("purpose") {
        Some(Value::String(text)) => SplitPurpose::from_word(text).ok_or_else(|| {
            ValidationError::invalid_field_type(
                format!("{path}/purpose"),
                "The split purpose must be fitting or validation.",
            )
        })?,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/purpose"),
                "The split purpose must be fitting or validation.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{path}/purpose"))),
    };

    let groups = match root.get("groups") {
        Some(Value::Array(items)) if !items.is_empty() => {
            let mut groups = Vec::with_capacity(items.len());
            for (position, item) in items.iter().enumerate() {
                let Value::String(text) = item else {
                    return Err(ValidationError::invalid_field_type(
                        format!("{path}/groups/{position}"),
                        "Each group must hold 1 to 128 characters.",
                    ));
                };
                if text.is_empty() || text.chars().count() > 128 {
                    return Err(ValidationError::invalid_field_type(
                        format!("{path}/groups/{position}"),
                        "Each group must hold 1 to 128 characters.",
                    ));
                }
                if groups.contains(text) {
                    return Err(ValidationError::invalid_field_type(
                        format!("{path}/groups/{position}"),
                        format!("The split repeats the group {}.", fragment(text)),
                    ));
                }
                groups.push(text.clone());
            }
            groups
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/groups"),
                "The split groups must hold one array with at least one group.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{path}/groups"))),
    };

    let content_hash =
        read_optional_hash(root.get("content_hash"), &format!("{path}/content_hash"))?;

    Ok(SplitDeclaration {
        id,
        purpose,
        groups,
        content_hash,
    })
}

/// Reads one required artifact identifier field.
fn read_artifact_id(
    value: Option<&Value>,
    path: &str,
    what: &str,
) -> Result<String, ValidationError> {
    match value {
        Some(Value::String(text)) if is_artifact_id(text) => Ok(text.clone()),
        Some(_) => Err(ValidationError::invalid_field_type(
            path,
            format!("{what} must hold lowercase segments joined by single hyphens, 64 characters at most, starting with a letter."),
        )),
        None => Err(ValidationError::missing(path)),
    }
}

/// Reads one required bounded text field. An empty text is invalid.
fn read_required_text(
    value: Option<&Value>,
    path: &str,
    max: usize,
    what: &str,
) -> Result<String, ValidationError> {
    match value {
        Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= max => {
            Ok(text.clone())
        }
        Some(_) => Err(ValidationError::invalid_field_type(
            path,
            format!("{what} must hold 1 to {max} characters."),
        )),
        None => Err(ValidationError::missing(path)),
    }
}

/// Reads one optional bounded text field. An empty text is invalid.
fn read_optional_text(
    value: Option<&Value>,
    path: &str,
    max: usize,
    what: &str,
) -> Result<Option<String>, ValidationError> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) if !text.is_empty() && text.chars().count() <= max => {
            Ok(Some(text.clone()))
        }
        Some(_) => Err(ValidationError::invalid_field_type(
            path,
            format!("{what} must hold 1 to {max} characters."),
        )),
    }
}

/// Reads one optional content-hash field and checks its shape alone. The
/// stored value is compared with the record content by the split-identity
/// work, not here.
fn read_optional_hash(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<String>, ValidationError> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) if is_hash_hex(text) => Ok(Some(text.clone())),
        Some(_) => Err(ValidationError::invalid_field_type(
            path,
            "The content hash must hold 64 lowercase hexadecimal characters.",
        )),
    }
}

/// Loads the case records of one complete JSONL record file.
///
/// Every failure names its line: the field path states `/records/<line>`
/// plus the pointer inside the record. One empty line, one malformed
/// line, one repeated identifier, and one oversized line each fail before
/// any later record is read.
///
/// # Errors
///
/// Returns a [`ValidationError`] with a line path when one line breaks
/// the strict JSON gate or the case-record contract, when one identifier
/// repeats, or when one published limit is exceeded.
pub fn load_case_records(records_text: &str) -> Result<Vec<CaseRecord>, ValidationError> {
    load_case_records_bounded(
        records_text,
        MAX_RECORD_BYTES,
        MAX_DATASET_RECORDS,
        MAX_DATASET_BYTES,
    )
}

/// Loads one dataset: the metadata artifact and the complete records.
///
/// A declared `record_count` that differs from the record file fails at
/// `/record_count`, because one revision states the exact content it
/// covers.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the metadata fails its contract, or
/// when one record fails the checks of [`load_case_records`].
pub fn load_dataset(metadata_text: &str, records_text: &str) -> Result<Dataset, ValidationError> {
    let metadata = parse_dataset_metadata_str(metadata_text)?;
    let records = load_case_records(records_text)?;
    if let Some(declared) = metadata.record_count {
        if declared != records.len() {
            return Err(ValidationError::invalid_field_type(
                "/record_count",
                format!(
                    "The metadata states {declared} records. The record file holds {}.",
                    records.len()
                ),
            ));
        }
    }
    Ok(Dataset { metadata, records })
}

/// Validates every input object and every reference label of one dataset
/// against one definition.
///
/// Each record crosses the run-case boundary of [`crate::case`], so the
/// input object satisfies the definition input schema and every published
/// data limit before any evaluator exists. Each reference label then
/// crosses the meaning of its check: one reference that names no declared
/// check, one answer or level outside the declared labels, and one
/// reference answer on a rule check each fail. One failure names its line
/// and its field inside the record.
///
/// One reference answer whose acceptance meaning disagrees with the stated
/// expected outcome fails nothing. The conflict stays as written and
/// appears in the [`LabelReview`] of the returned dataset, because one
/// human must decide it.
///
/// # Errors
///
/// Returns a [`ValidationError`] with one `/records/<line>` path when one
/// input object fails the definition input schema or one reference label
/// fails the meaning of its check.
pub fn validate_dataset<'a>(
    dataset: &'a Dataset,
    definition: &'a ValidatedDefinition,
) -> Result<ValidatedDataset<'a>, ValidationError> {
    let mut cases = Vec::with_capacity(dataset.records.len());
    let mut findings = Vec::new();
    let mut summary = LabelSummary {
        records: dataset.records.len(),
        ..LabelSummary::zeroed()
    };
    for record in &dataset.records {
        let case = Case {
            id: record.id.clone(),
            input: record.input.clone(),
        };
        let validated = crate::case::validate_case(&case, definition)
            .map_err(|error| error.at_line(record.line))?;
        cases.push(validated);
        let record_findings = validate_record_labels(record, definition)
            .map_err(|error| error.at_line(record.line))?;
        count_record_labels(record, &record_findings, &mut summary);
        findings.extend(
            record_findings
                .into_iter()
                .map(|finding| finding.at_line(record.line)),
        );
    }
    Ok(ValidatedDataset {
        definition,
        dataset,
        cases,
        labels: LabelReview { summary, findings },
    })
}

/// Counts the provenance of the reference labels of one record.
///
/// Every count except `records` covers the records that state one
/// expected-label object, because one record without references carries no
/// label provenance to summarize.
fn count_record_labels(record: &CaseRecord, findings: &[LabelFinding], summary: &mut LabelSummary) {
    let Some(expected) = record.expected.as_ref() else {
        summary.unlabeled += 1;
        return;
    };
    summary.labeled += 1;
    match (record.label.author_type, record.label.reviewed) {
        (LabelAuthor::Human, true) => summary.human_reviewed += 1,
        (LabelAuthor::Human, false) => summary.human_unreviewed += 1,
        (LabelAuthor::Model, true) => summary.model_reviewed += 1,
        (LabelAuthor::Model, false) => summary.model_unreviewed += 1,
    }
    if !record.label.history.is_empty() {
        summary.corrected += 1;
    }
    let ambiguous = expected.checks.values().any(|check| check.review);
    if ambiguous || !findings.is_empty() {
        summary.review_required += 1;
    }
}

/// Checks the reference labels of one record against the meaning of the
/// definition and returns every conflict that needs one human review.
///
/// The reference stays as written in every case. A conflict between the
/// acceptance meaning of one reference and its stated outcome is one
/// finding, not one failure, as the contracts README states.
///
/// # Errors
///
/// Returns a [`ValidationError`] when one reference names no declared
/// check, when one answer or level names no declared label of its check,
/// when one answer or level appears on a check of the other question kind,
/// or when one reference answer, level, or review marker appears on one
/// rule check.
fn validate_record_labels(
    record: &CaseRecord,
    definition: &ValidatedDefinition,
) -> Result<Vec<LabelFinding>, ValidationError> {
    let mut findings = Vec::new();
    let Some(expected) = record.expected.as_ref() else {
        return Ok(findings);
    };

    // The stated outcome of each check, kept for the overall comparison.
    let mut stated: Vec<&str> = Vec::new();
    for (check_id, reference) in &expected.checks {
        let base = format!("/expected/checks/{check_id}");
        let check = definition
            .as_definition()
            .checks
            .iter()
            .find(|check| check.id == *check_id)
            .ok_or_else(|| {
                ValidationError::new(
                    ReasonCode::UnknownField,
                    &base,
                    format!(
                        "The reference names no check of the definition: {}.",
                        fragment(check_id)
                    ),
                )
            })?;
        let kind = definition.check_kind(check_id).expect("the check exists");

        // One reference states one answer or one level, and it fits the
        // question kind of its check. One rule check takes one expected
        // outcome alone.
        let label = match (&reference.answer, &reference.level) {
            (Some(_), Some(_)) => {
                return Err(ValidationError::invalid_field_type(
                    &base,
                    "One reference states one answer or one level, never both.",
                ));
            }
            (Some(answer), None) => Some(answer.as_str()),
            (None, Some(level)) => Some(level.as_str()),
            (None, None) => None,
        };
        match kind {
            CheckKind::Rule => {
                if label.is_some() || reference.review {
                    let field = if reference.answer.is_some() {
                        "answer"
                    } else if reference.level.is_some() {
                        "level"
                    } else {
                        "review"
                    };
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/{field}"),
                        "One rule check states one expected outcome only. Its rule decides the answer.",
                    ));
                }
            }
            CheckKind::Categorical | CheckKind::Binary => {
                if reference.level.is_some() {
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/level"),
                        "An answers check states one named answer, not one scale level.",
                    ));
                }
                if let Some(answer) = label {
                    if !check
                        .answers
                        .as_ref()
                        .is_some_and(|answers| answers.contains_key(answer))
                    {
                        return Err(unknown_reference_label(&format!("{base}/answer"), answer));
                    }
                }
            }
            CheckKind::Ordered => {
                if reference.answer.is_some() {
                    return Err(ValidationError::invalid_field_type(
                        format!("{base}/answer"),
                        "One ordered check states one scale level, not one named answer.",
                    ));
                }
                if let Some(level) = label {
                    let scale = check.scale.as_ref().expect("one scale check holds a scale");
                    if !scale.iter().any(|entry| entry.name == level) {
                        return Err(unknown_reference_label(&format!("{base}/level"), level));
                    }
                }
            }
        }

        // The acceptance meaning of the reference implies one outcome. The
        // review marker states one ambiguous reference, so it implies one
        // review whatever answer the record also states.
        let implied = if reference.review {
            Some(Outcome::Review)
        } else if let Some(label) = label {
            let sets = crate::policy::answer_sets(check);
            if sets.acceptable.iter().any(|name| name == label) {
                Some(Outcome::Pass)
            } else if sets.review.iter().any(|name| name == label) {
                Some(Outcome::Review)
            } else {
                Some(Outcome::Fail)
            }
        } else {
            None
        };
        if let (Some(stated_outcome), Some(implied)) = (reference.outcome.as_deref(), implied) {
            if stated_outcome != implied.as_str() {
                findings.push(LabelFinding {
                    line: record.line,
                    case_id: record.id.clone(),
                    check_id: Some(check_id.clone()),
                    kind: LabelFindingKind::CheckOutcomeConflict,
                    field_path: format!("{base}/outcome"),
                    message: format!(
                        "The reference {} means {}, but the expected outcome states {}.",
                        reference_word(reference, label),
                        implied.as_str(),
                        stated_outcome
                    ),
                });
            }
        }
        if let Some(stated_outcome) = reference.outcome.as_deref() {
            stated.push(stated_outcome);
        }
    }

    // The overall outcome follows the aggregate order of the run report
    // with no error and no skip: any fail gives fail, otherwise any review
    // gives review, otherwise pass.
    if expected.outcome.is_some() && !stated.is_empty() {
        let overall = expected.outcome.as_deref().expect("one outcome exists");
        let aggregate = if stated.contains(&"fail") {
            "fail"
        } else if stated.contains(&"review") {
            "review"
        } else {
            "pass"
        };
        if overall != aggregate {
            findings.push(LabelFinding {
                line: record.line,
                case_id: record.id.clone(),
                check_id: None,
                kind: LabelFindingKind::OverallOutcomeConflict,
                field_path: "/expected/outcome".to_owned(),
                message: format!(
                    "The stated check outcomes aggregate to {aggregate}, but the overall outcome states {overall}."
                ),
            });
        }
    }
    Ok(findings)
}

/// Builds one `unknown_label` failure for one reference answer or level.
fn unknown_reference_label(path: &str, label: &str) -> ValidationError {
    ValidationError::new(
        ReasonCode::UnknownLabel,
        path,
        format!(
            "The reference label {} is not an answer or a level of this check.",
            fragment(label)
        ),
    )
}

/// Returns the word that names one reference in one finding message.
///
/// The message quotes the answer or the level when the record states one,
/// so the reviewer sees the exact reference that conflicts. One ambiguous
/// reference names its review marker alone.
fn reference_word(reference: &ExpectedCheck, label: Option<&str>) -> String {
    if reference.review {
        "marker review".to_owned()
    } else if reference.answer.is_some() {
        format!("answer {}", fragment(label.expect("one answer exists")))
    } else {
        format!("level {}", fragment(label.expect("one level exists")))
    }
}

impl LabelSummary {
    /// Returns one summary with every count at zero, so the caller fills
    /// the fields it counts.
    const fn zeroed() -> Self {
        Self {
            records: 0,
            labeled: 0,
            unlabeled: 0,
            human_reviewed: 0,
            human_unreviewed: 0,
            model_reviewed: 0,
            model_unreviewed: 0,
            corrected: 0,
            review_required: 0,
        }
    }
}

/// Loads case records under explicit bounds, so tests exercise each limit
/// without building one published-size file.
fn load_case_records_bounded(
    records_text: &str,
    max_record_bytes: usize,
    max_records: usize,
    max_dataset_bytes: usize,
) -> Result<Vec<CaseRecord>, ValidationError> {
    if records_text.is_empty() {
        // One file with no bytes holds no line, so no empty line exists.
        return Ok(Vec::new());
    }
    if records_text.len() > max_dataset_bytes {
        return Err(ValidationError::new(
            ReasonCode::OversizedInput,
            "/records",
            format!("The record file is larger than {max_dataset_bytes} bytes."),
        ));
    }

    let mut records: Vec<CaseRecord> = Vec::new();
    let mut lines_of: BTreeMap<String, usize> = BTreeMap::new();
    for (index, line) in record_lines(records_text).enumerate() {
        let number = index + 1;
        let path = format!("/records/{number}");

        if line.trim().is_empty() {
            return Err(ValidationError::new(
                ReasonCode::InvalidJson,
                &path,
                "The line holds no case record.",
            ));
        }
        if line.len() > max_record_bytes {
            return Err(ValidationError::new(
                ReasonCode::OversizedInput,
                &path,
                format!("The record is larger than {max_record_bytes} bytes."),
            ));
        }
        let value = crate::json::parse_strict(line).map_err(|error| error.at_line(number))?;
        let record = parse_case_record(&value).map_err(|error| error.at_line(number))?;
        if let Some(first) = lines_of.get(&record.id) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("{path}/id"),
                format!(
                    "The case identifier {} appears at lines {first} and {number}.",
                    fragment(&record.id)
                ),
            ));
        }
        lines_of.insert(record.id.clone(), number);
        records.push(CaseRecord {
            line: number,
            ..record
        });
        if records.len() > max_records {
            return Err(ValidationError::new(
                ReasonCode::OversizedInput,
                "/records",
                format!("The dataset holds more than {max_records} records."),
            ));
        }
    }
    Ok(records)
}

/// Splits one record file into its lines. A single trailing newline ends
/// the last line; every further empty line is one empty record line.
fn record_lines(records_text: &str) -> impl Iterator<Item = &str> {
    let mut lines = records_text.split('\n');
    if records_text.ends_with('\n') {
        lines.next_back();
    }
    lines
}

impl ValidationError {
    /// Moves one failure into one record line, prefixing `/records/<line>`
    /// onto its field path.
    fn at_line(mut self, line: usize) -> Self {
        if line > 0 {
            let prefix = format!("/records/{line}");
            self.field_path = if self.field_path.is_empty() {
                prefix
            } else {
                format!("{prefix}{}", self.field_path)
            };
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ReasonCode;
    use serde_json::json;

    /// One minimal record that passes the contract.
    fn record(id: &str) -> Value {
        json!({
            "id": id,
            "input": {"text": "Hello."},
            "label": {"author_type": "human", "reviewed": false}
        })
    }

    /// One complete metadata artifact.
    fn metadata() -> Value {
        json!({
            "schema_version": 1,
            "id": "intervention-cases",
            "name": "Intervention review cases",
            "revision": "2026-09-24.1",
            "kind": "development_fixture",
            "intended_population": "Interventions proposed in product support conversations.",
            "sampling_method": "Selected from reviewed development work. No prevalence claim.",
            "label_guidelines": "See docs/labeling.md revision 3.",
            "languages": ["en", "de"],
            "splits": [
                {"id": "fit", "purpose": "fitting", "groups": ["a", "b"]},
                {"id": "holdout", "purpose": "validation", "groups": ["c"]}
            ]
        })
    }

    /// Serializes one value to strict JSON text.
    fn text(value: &Value) -> String {
        serde_json::to_string(value).expect("the value serializes")
    }

    #[test]
    fn one_complete_record_parses_with_its_fields() {
        let value = json!({
            "id": "case.1_a-b",
            "group": "conversation-7",
            "tags": ["basic", "pass"],
            "input": {"text": "Hello."},
            "expected": {
                "checks": {
                    "message-supported": {"answer": "supported", "outcome": "pass"},
                    "consequence": {"level": "serious"},
                    "ambiguous-check": {"review": true}
                },
                "outcome": "pass"
            },
            "label": {
                "author_type": "model",
                "origin": "synthetic",
                "reviewed": true,
                "reviewer": "Reviewer One",
                "reason": "The answer matches the supplied evidence.",
                "history": [
                    {"author_type": "model", "origin": "synthetic", "reviewed": false,
                     "reason": "First proposal."}
                ]
            }
        });
        let parsed = parse_case_record(&value).expect("the record parses");
        assert_eq!(parsed.id, "case.1_a-b");
        assert_eq!(parsed.group, "conversation-7");
        assert_eq!(parsed.tags, ["basic", "pass"]);
        assert_eq!(parsed.label.author_type, LabelAuthor::Model);
        assert_eq!(parsed.label.origin, Some(LabelOrigin::Synthetic));
        assert!(parsed.label.reviewed);
        assert_eq!(parsed.label.reviewer.as_deref(), Some("Reviewer One"));
        assert_eq!(parsed.label.history.len(), 1);
        assert_eq!(
            parsed.label.history[0].reason.as_deref(),
            Some("First proposal.")
        );

        let expected = parsed.expected.as_ref().expect("labels are present");
        assert_eq!(expected.outcome.as_deref(), Some("pass"));
        let check = expected.checks.get("message-supported").expect("the check");
        assert_eq!(check.answer.as_deref(), Some("supported"));
        assert_eq!(check.outcome.as_deref(), Some("pass"));
        assert!(
            expected
                .checks
                .get("ambiguous-check")
                .expect("reviewed")
                .review
        );
        assert_eq!(
            expected
                .checks
                .get("consequence")
                .and_then(|c| c.level.as_deref()),
            Some("serious")
        );
        // The serialized record keeps every stated field.
        let serialized = serde_json::to_value(&parsed).expect("serializes");
        assert_eq!(serialized["label"]["author_type"], "model");
        assert_eq!(
            serialized["expected"]["checks"]["consequence"]["level"],
            "serious"
        );
    }

    #[test]
    fn one_record_without_one_group_forms_its_own_group() {
        let parsed = parse_case_record(&record("case-1")).expect("the record parses");
        assert_eq!(parsed.group, "case-1");
        assert!(parsed.tags.is_empty());
        assert!(parsed.expected.is_none());
    }

    #[test]
    fn record_fields_outside_the_contract_are_rejected() {
        for field in ["baseline", "dataset", "notes"] {
            let mut value = record("case-1");
            value[field] = json!("extra");
            let error = parse_case_record(&value).expect_err("one unknown field");
            assert_eq!(error.code, ReasonCode::UnknownField, "{field}: {error}");
            assert_eq!(error.field_path, format!("/{field}"), "{field}");
        }
    }

    #[test]
    fn one_label_inside_the_input_object_changes_no_parser_rule() {
        // The parser holds the input object unchanged. A label that hides
        // inside the input is one ordinary property: the definition input
        // schema rejects it, because every fixture definition closes its
        // inputs. The check runs in the validation test below.
        let mut value = record("case-1");
        value["input"]["label"] = json!({"author_type": "human"});
        let parsed = parse_case_record(&value).expect("the record parses");
        assert!(parsed.input.contains_key("label"));
    }

    #[test]
    fn missing_record_fields_carry_their_pointer() {
        for field in ["id", "input", "label"] {
            let mut value = record("case-1");
            value.as_object_mut().expect("an object").remove(field);
            let error = parse_case_record(&value).expect_err("one missing field");
            assert_eq!(error.code, ReasonCode::MissingField, "{field}: {error}");
            assert_eq!(error.field_path, format!("/{field}"), "{field}");
        }
    }

    #[test]
    fn wrong_record_field_types_fail_with_their_pointer() {
        let value = record("Case 1");
        let error = parse_case_record(&value).expect_err("one invalid identifier");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/id");

        let mut value = record("case-1");
        value["group"] = json!(7);
        let error = parse_case_record(&value).expect_err("one numeric group");
        assert_eq!(error.field_path, "/group", "{error}");

        let long = "g".repeat(129);
        let mut value = record("case-1");
        value["group"] = json!(long);
        let error = parse_case_record(&value).expect_err("one long group");
        assert_eq!(error.field_path, "/group", "{error}");

        let mut value = record("case-1");
        value["tags"] = json!("basic");
        let error = parse_case_record(&value).expect_err("one string tag list");
        assert_eq!(error.field_path, "/tags", "{error}");

        let mut value = record("case-1");
        value["tags"] = json!(["basic", "basic"]);
        let error = parse_case_record(&value).expect_err("one repeated tag");
        assert_eq!(error.field_path, "/tags/1", "{error}");

        let mut value = record("case-1");
        value["input"] = json!(["text"]);
        let error = parse_case_record(&value).expect_err("one array input");
        assert_eq!(error.field_path, "/input", "{error}");
    }

    #[test]
    fn broken_expected_labels_report_their_field_paths() {
        let mut value = record("case-1");
        value["expected"] = json!({"checks": {}});
        let error = parse_case_record(&value).expect_err("one empty check set");
        assert_eq!(error.field_path, "/expected/checks", "{error}");

        let mut value = record("case-1");
        value["expected"] = json!({"checks": {"c": {}}});
        let error = parse_case_record(&value).expect_err("one empty reference");
        assert_eq!(error.field_path, "/expected/checks/c", "{}", error);

        let mut value = record("case-1");
        value["expected"] = json!({"checks": {"c": {"review": false}}});
        let error = parse_case_record(&value).expect_err("one false review marker");
        assert_eq!(error.field_path, "/expected/checks/c/review", "{error}");

        let mut value = record("case-1");
        value["expected"] = json!({"outcome": "error"});
        let error = parse_case_record(&value).expect_err("one operational outcome word");
        assert_eq!(error.field_path, "/expected/outcome", "{error}");

        let mut value = record("case-1");
        value["expected"] = json!({"checks": {"c": {"answer": "ok"}}, "extra": 1});
        let error = parse_case_record(&value).expect_err("one unknown expected field");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/expected/extra", "{error}");
    }

    #[test]
    fn broken_label_provenance_reports_its_field_paths() {
        let mut value = record("case-1");
        value["label"] = json!({"reviewed": false});
        let error = parse_case_record(&value).expect_err("one missing author");
        assert_eq!(error.field_path, "/label/author_type", "{error}");

        let mut value = record("case-1");
        value["label"] = json!({"author_type": "agent", "reviewed": false});
        let error = parse_case_record(&value).expect_err("one unknown author");
        assert_eq!(error.field_path, "/label/author_type", "{error}");

        let mut value = record("case-1");
        value["label"] = json!({"author_type": "human"});
        let error = parse_case_record(&value).expect_err("one missing reviewed flag");
        assert_eq!(error.field_path, "/label/reviewed", "{error}");

        // One reviewed label needs one reviewer.
        let mut value = record("case-1");
        value["label"] = json!({"author_type": "human", "reviewed": true});
        let error = parse_case_record(&value).expect_err("one missing reviewer");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/label/reviewer", "{error}");

        let mut value = record("case-1");
        value["label"] = json!({
            "author_type": "human",
            "reviewed": false,
            "history": [{"author_type": "human"}]
        });
        let error = parse_case_record(&value).expect_err("one broken history entry");
        assert_eq!(error.field_path, "/label/history/0/reviewed", "{error}");

        let mut value = record("case-1");
        value["label"] = json!({"author_type": "human", "reviewed": false, "extra": 1});
        let error = parse_case_record(&value).expect_err("one unknown label field");
        assert_eq!(error.field_path, "/label/extra", "{error}");
    }

    #[test]
    fn one_complete_metadata_artifact_parses() {
        let parsed = parse_dataset_metadata(&metadata()).expect("the metadata parses");
        assert_eq!(parsed.id, "intervention-cases");
        assert_eq!(parsed.revision, "2026-09-24.1");
        assert_eq!(parsed.kind, DatasetKind::DevelopmentFixture);
        assert_eq!(parsed.languages, ["en", "de"]);
        assert_eq!(parsed.record_count, None);
        assert_eq!(parsed.splits.len(), 2);
        assert_eq!(parsed.splits[0].id, "fit");
        assert_eq!(parsed.splits[0].purpose, SplitPurpose::Fitting);
        assert_eq!(parsed.splits[0].groups, ["a", "b"]);
        assert_eq!(parsed.splits[1].purpose, SplitPurpose::Validation);
        // Every kind word parses.
        for (word, kind) in [
            ("development_fixture", DatasetKind::DevelopmentFixture),
            ("synthetic_challenge", DatasetKind::SyntheticChallenge),
            ("representative_sample", DatasetKind::RepresentativeSample),
        ] {
            let mut value = metadata();
            value["kind"] = json!(word);
            let parsed = parse_dataset_metadata(&value).expect("the kind parses");
            assert_eq!(parsed.kind, kind, "{word}");
        }
    }

    #[test]
    fn broken_metadata_reports_its_field_paths() {
        // Every required field.
        for field in [
            "id",
            "revision",
            "kind",
            "intended_population",
            "sampling_method",
            "label_guidelines",
            "splits",
        ] {
            let mut value = metadata();
            value.as_object_mut().expect("an object").remove(field);
            let error = parse_dataset_metadata(&value).expect_err("one missing field");
            assert_eq!(error.code, ReasonCode::MissingField, "{field}: {error}");
            assert_eq!(error.field_path, format!("/{field}"), "{field}");
        }

        let mut value = metadata();
        value["id"] = json!("Intervention");
        let error = parse_dataset_metadata(&value).expect_err("one invalid identifier");
        assert_eq!(error.field_path, "/id", "{error}");

        let mut value = metadata();
        value["extra"] = json!(1);
        let error = parse_dataset_metadata(&value).expect_err("one unknown field");
        assert_eq!(error.field_path, "/extra", "{error}");

        let mut value = metadata();
        value["languages"] = json!(["en", "en"]);
        let error = parse_dataset_metadata(&value).expect_err("one repeated language");
        assert_eq!(error.field_path, "/languages/1", "{error}");

        let mut value = metadata();
        value["languages"] = json!(["e"]);
        let error = parse_dataset_metadata(&value).expect_err("one short language");
        assert_eq!(error.field_path, "/languages/0", "{error}");

        let mut value = metadata();
        value["record_count"] = json!(0);
        let error = parse_dataset_metadata(&value).expect_err("one zero count");
        assert_eq!(error.field_path, "/record_count", "{error}");

        let mut value = metadata();
        value["record_count"] = json!(2.5);
        let error = parse_dataset_metadata(&value).expect_err("one fractional count");
        assert_eq!(error.field_path, "/record_count", "{error}");

        let mut value = metadata();
        value["content_hash"] = json!("XYZ");
        let error = parse_dataset_metadata(&value).expect_err("one malformed hash");
        assert_eq!(error.field_path, "/content_hash", "{error}");
    }

    #[test]
    fn broken_splits_report_their_positions() {
        let mut value = metadata();
        value["splits"] = json!([]);
        let error = parse_dataset_metadata(&value).expect_err("one empty split set");
        assert_eq!(error.field_path, "/splits", "{error}");

        let mut value = metadata();
        value["splits"][1]["id"] = json!("fit");
        let error = parse_dataset_metadata(&value).expect_err("one repeated split");
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/splits/1/id", "{error}");

        let mut value = metadata();
        value["splits"][0]["purpose"] = json!("holdout");
        let error = parse_dataset_metadata(&value).expect_err("one unknown purpose");
        assert_eq!(error.field_path, "/splits/0/purpose", "{error}");

        let mut value = metadata();
        value["splits"][0]["groups"] = json!([]);
        let error = parse_dataset_metadata(&value).expect_err("one empty group set");
        assert_eq!(error.field_path, "/splits/0/groups", "{error}");

        let mut value = metadata();
        value["splits"][0]["groups"] = json!(["a", "a"]);
        let error = parse_dataset_metadata(&value).expect_err("one repeated group");
        assert_eq!(error.field_path, "/splits/0/groups/1", "{error}");

        let mut value = metadata();
        value["splits"][0]["content_hash"] = json!("nothex");
        let error = parse_dataset_metadata(&value).expect_err("one malformed split hash");
        assert_eq!(error.field_path, "/splits/0/content_hash", "{error}");
    }

    #[test]
    fn one_valid_record_file_loads_with_its_lines() {
        let file = [
            text(&record("case-1")),
            text(&json!({
                "id": "case-2", "group": "conversation-7",
                "input": {"text": "Hello again."},
                "label": {"author_type": "model", "reviewed": true, "reviewer": "R."}
            })),
        ]
        .join("\n");
        let records = load_case_records(&file).expect("the file loads");
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].line, 1);
        assert_eq!(records[1].line, 2);
        assert_eq!(records[1].group, "conversation-7");

        // One trailing newline ends the last line and adds no empty line.
        let with_newline = format!("{file}\n");
        assert_eq!(load_case_records(&with_newline).expect("loads").len(), 2);

        // Windows line endings parse, because one carriage return is
        // trailing JSON whitespace.
        let windows = format!(
            "{}\r\n{}\r\n",
            text(&record("case-1")),
            text(&record("case-2"))
        );
        assert_eq!(load_case_records(&windows).expect("loads").len(), 2);
    }

    #[test]
    fn broken_lines_report_their_line_numbers() {
        // One empty line.
        let file = format!("{}\n\n", text(&record("case-1")));
        let error = load_case_records(&file).expect_err("one empty line");
        assert_eq!(error.code, ReasonCode::InvalidJson, "{error}");
        assert_eq!(error.field_path, "/records/2", "{error}");

        // One whitespace-only line.
        let file = format!(
            "{}\n   \n{}",
            text(&record("case-1")),
            text(&record("case-2"))
        );
        let error = load_case_records(&file).expect_err("one blank line");
        assert_eq!(error.field_path, "/records/2", "{error}");

        // One malformed line.
        let file = format!("{}\n{{\"id\": ", text(&record("case-1")));
        let error = load_case_records(&file).expect_err("one malformed line");
        assert_eq!(error.code, ReasonCode::InvalidJson, "{error}");
        assert_eq!(error.field_path, "/records/2", "{error}");

        // One repeated identifier names both lines.
        let file = [
            text(&record("case-1")),
            text(&record("case-2")),
            text(&record("case-1")),
        ]
        .join("\n");
        let error = load_case_records(&file).expect_err("one repeated identifier");
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/records/3/id", "{error}");

        // One broken field inside one record keeps its field pointer.
        let mut broken = record("case-1");
        broken["input"] = json!(3);
        let file = format!("{}\n{}", text(&record("case-2")), text(&broken));
        let error = load_case_records(&file).expect_err("one broken record");
        assert_eq!(error.field_path, "/records/2/input", "{error}");
    }

    #[test]
    fn one_duplicate_key_inside_one_line_fails_the_strict_gate() {
        let line = "{\"id\": \"case-1\", \"id\": \"case-2\", \"input\": {}, \"label\": {\"author_type\": \"human\", \"reviewed\": false}}";
        let error = load_case_records(line).expect_err("one repeated key");
        assert_eq!(error.code, ReasonCode::InvalidJson, "{error}");
        assert_eq!(error.field_path, "/records/1", "{error}");
    }

    #[test]
    fn the_published_limits_hold() {
        // One record line above the line bound.
        let mut large = record("case-1");
        large["input"]["text"] = json!("a".repeat(200));
        let file = text(&large);
        let error = load_case_records_bounded(&file, 64, MAX_DATASET_RECORDS, MAX_DATASET_BYTES)
            .expect_err("one oversized record");
        assert_eq!(error.code, ReasonCode::OversizedInput, "{error}");
        assert_eq!(error.field_path, "/records/1", "{error}");

        // One file above the file bound fails before any line is read.
        let error = load_case_records_bounded(&file, MAX_RECORD_BYTES, MAX_DATASET_RECORDS, 64)
            .expect_err("one oversized file");
        assert_eq!(error.code, ReasonCode::OversizedInput, "{error}");
        assert_eq!(error.field_path, "/records", "{error}");

        // One record count above the record bound fails at the record that
        // exceeds it.
        let file = [text(&record("case-1")), text(&record("case-2"))].join("\n");
        let error = load_case_records_bounded(&file, MAX_RECORD_BYTES, 1, MAX_DATASET_BYTES)
            .expect_err("one oversized dataset");
        assert_eq!(error.code, ReasonCode::OversizedInput, "{error}");
        assert_eq!(error.field_path, "/records", "{error}");

        // The same file inside every bound loads.
        let loaded = load_case_records_bounded(&file, MAX_RECORD_BYTES, 2, MAX_DATASET_BYTES)
            .expect("the file loads");
        assert_eq!(loaded.len(), 2);
    }

    #[test]
    fn one_empty_record_file_loads_as_one_empty_dataset() {
        assert!(load_case_records("")
            .expect("the empty file loads")
            .is_empty());
    }

    #[test]
    fn one_declared_record_count_must_match_the_file() {
        let file = [text(&record("case-1")), text(&record("case-2"))].join("\n");

        let mut declared = metadata();
        declared["record_count"] = json!(2);
        let dataset = load_dataset(&text(&declared), &file).expect("the dataset loads");
        assert_eq!(dataset.len(), 2);
        assert_eq!(dataset.metadata().record_count, Some(2));

        let mut declared = metadata();
        declared["record_count"] = json!(3);
        let error = load_dataset(&text(&declared), &file).expect_err("one wrong count");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/record_count", "{error}");
    }

    #[test]
    fn one_broken_metadata_file_fails_before_any_record_work() {
        let file = text(&record("case-1"));
        let mut broken = metadata();
        broken["revision"] = json!("");
        let error = load_dataset(&text(&broken), &file).expect_err("one empty revision");
        assert_eq!(error.field_path, "/revision", "{error}");
    }

    /// One definition with one closed input schema for the input checks.
    fn definition() -> ValidatedDefinition {
        let artifact = json!({
            "schema_version": 1,
            "name": "message-review",
            "inputs": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "minLength": 1}
                },
                "required": ["text"],
                "additionalProperties": false
            },
            "checks": [{
                "id": "text-length",
                "name": "The text fits the limit",
                "using": ["text"],
                "rule": {"maxLength": 80}
            }]
        });
        crate::definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates")
    }

    #[test]
    fn every_input_object_validates_against_the_definition() {
        let file = [text(&record("case-1")), text(&record("case-2"))].join("\n");
        let dataset = load_dataset(&text(&metadata()), &file).expect("the dataset loads");
        let definition = definition();
        let validated = validate_dataset(&dataset, &definition).expect("the inputs validate");
        assert_eq!(validated.len(), 2);
        let first = validated.record(0).expect("one record");
        assert_eq!(first.line(), 1);
        assert_eq!(first.id(), "case-1");
        assert_eq!(first.group(), "case-1");
        assert_eq!(first.label().author_type, LabelAuthor::Human);
        assert_eq!(first.input()["text"], "Hello.");

        // The projection holds only the declared inputs.
        let projected = first.projected_inputs();
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].check_id, "text-length");
        assert_eq!(projected[0].inputs["text"], "Hello.");
        assert_eq!(
            validated.definition().as_definition().name,
            "message-review"
        );
        assert!(validated.record(2).is_none(), "no third record exists");
    }

    #[test]
    fn one_invalid_input_names_its_line_and_field() {
        let mut broken = record("case-1");
        broken["input"]["text"] = json!("");
        let file = [text(&record("case-2")), text(&broken)].join("\n");
        let dataset = load_dataset(&text(&metadata()), &file).expect("the dataset loads");
        let definition = definition();
        let error = validate_dataset(&dataset, &definition).expect_err("one invalid input");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/records/2/input/text", "{error}");

        // One unknown input property reports its own field.
        let mut extra = record("case-1");
        extra["input"]["label"] = json!("hidden");
        let file = text(&extra);
        let dataset = load_dataset(&text(&metadata()), &file).expect("the dataset loads");
        let error = validate_dataset(&dataset, &definition).expect_err("one hidden label field");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/records/1/input/label", "{error}");
    }

    /// One categorical question with one accepted, one review, and one
    /// unacceptable answer.
    fn question_definition() -> ValidatedDefinition {
        let artifact = json!({
            "schema_version": 1,
            "name": "message-review",
            "inputs": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "minLength": 1}
                },
                "required": ["text"],
                "additionalProperties": false
            },
            "checks": [{
                "id": "message-supported",
                "name": "Our message describes the evidence",
                "using": ["text"],
                "question": "Does every claim follow from the evidence?",
                "answers": {
                    "supported": "Every claim follows.",
                    "contradicted": "One claim conflicts.",
                    "incomplete": "Support is missing."
                },
                "accept": "supported",
                "review": "incomplete"
            }]
        });
        crate::definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates")
    }

    /// One ordered scale with acceptance from one level upward.
    fn ordered_definition() -> ValidatedDefinition {
        let artifact = json!({
            "schema_version": 1,
            "name": "consequence-level",
            "inputs": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "minLength": 1}
                },
                "required": ["text"],
                "additionalProperties": false
            },
            "checks": [{
                "id": "consequence",
                "name": "The concern warrants an interruption",
                "using": ["text"],
                "question": "What consequence does this concern have?",
                "scale": [
                    {"minor": "No identified consequence."},
                    {"meaningful": "Rework or delay."},
                    {"serious": "One explicit commitment breaks."}
                ],
                "accept": {"at_least": "meaningful"}
            }]
        });
        crate::definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates")
    }

    /// One record that states one reference label of one question check.
    fn labeled_record(id: &str, reference: Value, provenance: Value) -> Value {
        let mut value = record(id);
        value["expected"] = json!({"checks": {"message-supported": reference}, "outcome": "pass"});
        value["label"] = provenance;
        value
    }

    /// One human-reviewed provenance record with one correction.
    fn reviewed_label() -> Value {
        json!({
            "author_type": "model",
            "origin": "synthetic",
            "reviewed": true,
            "reviewer": "Reviewer One",
            "reason": "The reference matches the evidence.",
            "history": [
                {"author_type": "model", "origin": "synthetic", "reviewed": false,
                 "reason": "First proposal."}
            ]
        })
    }

    /// Loads one records text and returns the label review of its
    /// validation.
    fn review_of(file: &str, definition: &ValidatedDefinition) -> LabelReview {
        let dataset = load_dataset(&text(&metadata()), file).expect("the dataset loads");
        let validated = validate_dataset(&dataset, definition).expect("the labels validate");
        validated.label_review().clone()
    }

    /// Loads one records text and returns the first record of its validated
    /// dataset, unchanged.
    fn record_of(file: &str, definition: &ValidatedDefinition) -> CaseRecord {
        let dataset = load_dataset(&text(&metadata()), file).expect("the dataset loads");
        let validated = validate_dataset(&dataset, definition).expect("the labels validate");
        validated.records()[0].clone()
    }

    #[test]
    fn the_summary_keeps_human_judgments_apart_from_model_proposals() {
        let human = json!({"author_type": "human", "reviewed": true, "reviewer": "Owner"});
        let proposal = json!({"author_type": "model", "origin": "synthetic", "reviewed": false});
        let reviewed = json!({"author_type": "model", "origin": "synthetic",
            "reviewed": true, "reviewer": "Owner"});
        let human_unreviewed = json!({"author_type": "human", "reviewed": false});
        let reference = json!({"answer": "supported", "outcome": "pass"});
        let file = [
            text(&labeled_record("case-1", reference.clone(), human)),
            text(&labeled_record(
                "case-2",
                reference.clone(),
                proposal.clone(),
            )),
            text(&labeled_record("case-3", reference.clone(), reviewed)),
            text(&labeled_record("case-4", reference, human_unreviewed)),
            text(&record("case-5")),
        ]
        .join("\n");
        let review = review_of(&file, &question_definition());
        let summary = review.summary();
        assert_eq!(summary.records, 5);
        assert_eq!(summary.labeled, 4);
        assert_eq!(summary.unlabeled, 1);
        assert_eq!(summary.human_reviewed, 1);
        assert_eq!(summary.human_unreviewed, 1);
        assert_eq!(summary.model_reviewed, 1);
        assert_eq!(summary.model_unreviewed, 1);
        assert_eq!(summary.reviewed(), 2);
        assert_eq!(summary.unreviewed(), 2);
        assert!(review.is_conflict_free());

        // One dataset of proposals alone states no reviewed evidence,
        // whatever its metadata declares.
        let file = [text(&labeled_record("case-1", reference_only(), proposal))].join("\n");
        let review = review_of(&file, &question_definition());
        assert_eq!(review.summary().reviewed(), 0);
        assert_eq!(review.summary().unreviewed(), 1);
    }

    /// One reference with no expected outcome, so no conflict can arise.
    fn reference_only() -> Value {
        json!({"answer": "supported"})
    }

    #[test]
    fn corrected_references_keep_their_earlier_provenance() {
        let file = [text(&labeled_record(
            "case-1",
            reference_only(),
            reviewed_label(),
        ))]
        .join("\n");
        assert_eq!(
            review_of(&file, &question_definition()).summary().corrected,
            1
        );

        // The record exports with the original provenance: the history keeps
        // the unreviewed proposal, and the current record names the reviewer.
        let exported =
            serde_json::to_value(record_of(&file, &question_definition())).expect("serializes");
        assert_eq!(exported["label"]["author_type"], "model");
        assert_eq!(exported["label"]["reviewed"], true);
        assert_eq!(exported["label"]["reviewer"], "Reviewer One");
        assert_eq!(exported["label"]["history"][0]["reviewed"], false);
        assert_eq!(exported["label"]["history"][0]["reason"], "First proposal.");
    }

    #[test]
    fn consistent_references_report_no_conflict() {
        for (reference, outcome) in [
            (json!({"answer": "supported"}), Some("pass")),
            (json!({"answer": "incomplete"}), Some("review")),
            (json!({"answer": "contradicted"}), Some("fail")),
            (json!({"review": true}), Some("review")),
            // One accepted answer beside one ambiguous marker keeps the
            // review meaning, so one review outcome agrees.
            (
                json!({"answer": "supported", "review": true}),
                Some("review"),
            ),
        ] {
            let mut value = record("case-1");
            let mut reference = reference;
            if let Some(outcome) = outcome {
                reference["outcome"] = json!(outcome);
            }
            value["expected"] = json!({"checks": {"message-supported": reference}});
            value["label"] = reviewed_label();
            let review = review_of(&text(&value), &question_definition());
            assert!(
                review.is_conflict_free(),
                "{reference}: one conflict was reported"
            );
        }

        // One ordered level follows the same acceptance meaning.
        for (level, outcome) in [
            (json!("serious"), json!("pass")),
            (json!("meaningful"), json!("pass")),
            (json!("minor"), json!("fail")),
        ] {
            let mut value = record("case-1");
            value["expected"] =
                json!({"checks": {"consequence": {"level": level, "outcome": outcome}}});
            value["label"] = reviewed_label();
            let review = review_of(&text(&value), &ordered_definition());
            assert!(
                review.is_conflict_free(),
                "{level}: one conflict was reported"
            );
        }

        // One rule check states one expected outcome alone.
        let mut value = record("case-1");
        value["expected"] =
            json!({"checks": {"text-length": {"outcome": "pass"}}, "outcome": "pass"});
        value["label"] = reviewed_label();
        assert!(review_of(&text(&value), &definition()).is_conflict_free());
    }

    #[test]
    fn conflicting_outcomes_are_flagged_and_kept_as_written() {
        // One accepted answer beside one failing outcome.
        let conflicting = labeled_record(
            "case-1",
            json!({"answer": "supported", "outcome": "fail"}),
            reviewed_label(),
        );
        let review = review_of(&text(&conflicting), &question_definition());
        let findings = review.findings();
        // Both conflicts surface: the answer disagrees with its check
        // outcome, and the stated check outcome disagrees with the overall
        // outcome.
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].kind, LabelFindingKind::CheckOutcomeConflict);
        assert_eq!(findings[0].case_id, "case-1");
        assert_eq!(findings[0].check_id.as_deref(), Some("message-supported"));
        assert_eq!(
            findings[0].field_path,
            "/records/1/expected/checks/message-supported/outcome"
        );
        assert_eq!(findings[0].line, 1);
        assert!(
            findings[0].message.contains("supported"),
            "{}",
            findings[0].message
        );
        assert!(
            findings[0].message.contains("fail"),
            "{}",
            findings[0].message
        );
        assert_eq!(findings[1].kind, LabelFindingKind::OverallOutcomeConflict);

        // Nothing was resolved: the record keeps both fields as written.
        let kept = record_of(&text(&conflicting), &question_definition());
        let expected = kept.expected.as_ref().expect("labels exist");
        assert_eq!(
            expected.checks["message-supported"].answer.as_deref(),
            Some("supported")
        );
        assert_eq!(
            expected.checks["message-supported"].outcome.as_deref(),
            Some("fail")
        );

        // One ambiguous reference beside one passing outcome conflicts too.
        let ambiguous = labeled_record(
            "case-2",
            json!({"review": true, "outcome": "pass"}),
            reviewed_label(),
        );
        let review = review_of(&text(&ambiguous), &question_definition());
        let findings = review.findings();
        assert_eq!(findings.len(), 1, "{}", findings[0].message);
        assert_eq!(findings[0].kind, LabelFindingKind::CheckOutcomeConflict);

        // One ordered level below acceptance states one fail, not one pass.
        let mut level = record("case-3");
        level["expected"] =
            json!({"checks": {"consequence": {"level": "minor", "outcome": "pass"}}});
        level["label"] = reviewed_label();
        assert_eq!(
            review_of(&text(&level), &ordered_definition())
                .findings()
                .len(),
            1
        );
    }

    #[test]
    fn one_overall_outcome_that_disagrees_with_its_checks_is_flagged() {
        // The stated check outcome passes, so the overall outcome cannot
        // fail.
        let mut value = record("case-1");
        value["expected"] = json!({
            "checks": {"message-supported": {"answer": "supported", "outcome": "pass"}},
            "outcome": "fail"
        });
        value["label"] = reviewed_label();
        let review = review_of(&text(&value), &question_definition());
        let findings = review.findings();
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, LabelFindingKind::OverallOutcomeConflict);
        assert_eq!(findings[0].check_id, None);
        assert_eq!(findings[0].field_path, "/records/1/expected/outcome");
        assert_eq!(review.summary().review_required, 1);

        // Any review aggregates to review, not pass.
        let mut value = record("case-1");
        value["expected"] = json!({
            "checks": {
                "message-supported": {"answer": "supported", "outcome": "pass"},
                "text-length": {"outcome": "review"}
            },
            "outcome": "pass"
        });
        value["label"] = reviewed_label();
        let review = review_of(&text(&value), &mixed_definition());
        let findings = review.findings();
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, LabelFindingKind::OverallOutcomeConflict);

        // One overall outcome with no stated check outcome stays
        // unverified: no finding invents one.
        let mut value = record("case-1");
        value["expected"] =
            json!({"checks": {"message-supported": {"answer": "supported"}}, "outcome": "fail"});
        value["label"] = reviewed_label();
        assert!(review_of(&text(&value), &question_definition()).is_conflict_free());
    }

    /// One definition with one categorical question and one rule check, so
    /// one record states two expected outcomes.
    fn mixed_definition() -> ValidatedDefinition {
        let artifact = json!({
            "schema_version": 1,
            "name": "message-review",
            "inputs": {
                "type": "object",
                "properties": {"text": {"type": "string", "minLength": 1}},
                "required": ["text"],
                "additionalProperties": false
            },
            "checks": [
                {
                    "id": "message-supported",
                    "name": "Our message describes the evidence",
                    "using": ["text"],
                    "question": "Does every claim follow?",
                    "answers": {
                        "supported": "Every claim follows.",
                        "contradicted": "One claim conflicts."
                    },
                    "accept": "supported"
                },
                {
                    "id": "text-length",
                    "name": "The text fits the limit",
                    "using": ["text"],
                    "rule": {"maxLength": 80}
                }
            ]
        });
        crate::definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates")
    }

    #[test]
    fn references_outside_the_check_meaning_fail_with_their_field() {
        // One reference that names no declared check.
        let mut value = record("case-1");
        value["expected"] = json!({"checks": {"unknown-check": {"outcome": "pass"}}});
        value["label"] = reviewed_label();
        let error = label_error(&value, &question_definition());
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(
            error.field_path, "/records/1/expected/checks/unknown-check",
            "{error}"
        );
        assert!(
            error.message.contains("unknown-check"),
            "{error}: the cause names the check"
        );

        // One answer that names no declared answer.
        let mut value = record("case-1");
        value["expected"] =
            json!({"checks": {"message-supported": {"answer": "maybe", "outcome": "pass"}}});
        value["label"] = reviewed_label();
        let error = label_error(&value, &question_definition());
        assert_eq!(error.code, ReasonCode::UnknownLabel, "{error}");
        assert_eq!(
            error.field_path, "/records/1/expected/checks/message-supported/answer",
            "{error}"
        );

        // One level that names no declared level.
        let mut value = record("case-1");
        value["expected"] =
            json!({"checks": {"consequence": {"level": "critical", "outcome": "pass"}}});
        value["label"] = reviewed_label();
        let error = label_error(&value, &ordered_definition());
        assert_eq!(error.code, ReasonCode::UnknownLabel, "{error}");
        assert_eq!(
            error.field_path, "/records/1/expected/checks/consequence/level",
            "{error}"
        );

        // One scale level on one answers check.
        let mut value = record("case-1");
        value["expected"] =
            json!({"checks": {"message-supported": {"level": "supported", "outcome": "pass"}}});
        value["label"] = reviewed_label();
        let error = label_error(&value, &question_definition());
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(
            error.field_path, "/records/1/expected/checks/message-supported/level",
            "{error}"
        );

        // One named answer on one ordered check.
        let mut value = record("case-1");
        value["expected"] =
            json!({"checks": {"consequence": {"answer": "supported", "outcome": "pass"}}});
        value["label"] = reviewed_label();
        let error = label_error(&value, &ordered_definition());
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(
            error.field_path, "/records/1/expected/checks/consequence/answer",
            "{error}"
        );

        // One answer and one level together.
        let mut value = record("case-1");
        value["expected"] = json!({"checks":
            {"message-supported": {"answer": "supported", "level": "minor", "outcome": "pass"}}
        });
        value["label"] = reviewed_label();
        let error = label_error(&value, &question_definition());
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(
            error.field_path, "/records/1/expected/checks/message-supported",
            "{error}"
        );

        // One rule check takes one expected outcome alone.
        for (field, reference) in [
            ("answer", json!({"answer": "supported", "outcome": "pass"})),
            ("level", json!({"level": "minor", "outcome": "pass"})),
            ("review", json!({"review": true, "outcome": "pass"})),
        ] {
            let mut value = record("case-1");
            value["expected"] = json!({"checks": {"text-length": reference}});
            value["label"] = reviewed_label();
            let error = label_error(&value, &definition());
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{field}: {error}");
            assert_eq!(
                error.field_path,
                format!("/records/1/expected/checks/text-length/{field}"),
                "{field}: {error}"
            );
        }
    }

    /// Loads one record and returns the label failure of its validation.
    fn label_error(value: &Value, definition: &ValidatedDefinition) -> ValidationError {
        let dataset = load_dataset(&text(&metadata()), &text(value)).expect("the dataset loads");
        validate_dataset(&dataset, definition).expect_err("the reference loaded")
    }

    #[test]
    fn ambiguous_references_need_one_human_review() {
        // One review marker with no stated outcome and no conflict still
        // needs one human decision, and the count names it.
        let mut value = record("case-1");
        value["expected"] = json!({"checks": {"message-supported": {"review": true}}});
        value["label"] = json!({"author_type": "model", "origin": "synthetic", "reviewed": false});
        let mut value2 = record("case-2");
        value2["expected"] = json!({"checks": {"message-supported": {"answer": "supported"}}});
        value2["label"] = json!({"author_type": "model", "origin": "synthetic", "reviewed": false});
        let file = format!("{}\n{}", text(&value), text(&value2));
        let review = review_of(&file, &question_definition());
        let summary = review.summary();
        assert_eq!(summary.review_required, 1);
        assert_eq!(summary.model_unreviewed, 2);
        assert_eq!(summary.reviewed(), 0);
    }
}
