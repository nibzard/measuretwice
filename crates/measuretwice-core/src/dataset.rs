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
//! The loader enforces the published limits: one record line holds at most
//! [`MAX_RECORD_BYTES`] bytes, one dataset holds at most
//! [`MAX_DATASET_RECORDS`] records, and the record file holds at most
//! [`MAX_DATASET_BYTES`] bytes. Nothing is truncated. The loader retains
//! the complete parsed records in memory and writes no file: report
//! retention and source snapshots stay with the host.
//!
//! The deeper split invariants, group coverage, and content hashes of a
//! dataset arrive with the split-identity task. This module checks the
//! structural contract alone.

use crate::artifact::{expect_object, reject_unknown_fields, schema_version};
use crate::case::{is_case_id, Case, ProjectedInputs, ValidatedCase};
use crate::definition::{is_artifact_id, ValidatedDefinition};
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::hashing::is_hash_hex;
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
/// answer and an outcome stays as written; the deeper meaning check that
/// flags conflicts arrives with the label-provenance task.
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

/// Validates every input object of one dataset against one definition.
///
/// Each record crosses the run-case boundary of [`crate::case`], so the
/// input object satisfies the definition input schema and every published
/// data limit before any evaluator exists. One failure names its line and
/// its field inside the record.
///
/// # Errors
///
/// Returns a [`ValidationError`] with one `/records/<line>` path when one
/// input object fails the definition input schema.
pub fn validate_dataset<'a>(
    dataset: &'a Dataset,
    definition: &'a ValidatedDefinition,
) -> Result<ValidatedDataset<'a>, ValidationError> {
    let mut cases = Vec::with_capacity(dataset.records.len());
    for record in &dataset.records {
        let case = Case {
            id: record.id.clone(),
            input: record.input.clone(),
        };
        let validated = crate::case::validate_case(&case, definition)
            .map_err(|error| error.at_line(record.line))?;
        cases.push(validated);
    }
    Ok(ValidatedDataset {
        definition,
        dataset,
        cases,
    })
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
}
