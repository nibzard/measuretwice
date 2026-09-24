// SPDX-License-Identifier: Apache-2.0
//! Strict parsing of the portable check definition contract.
//!
//! This module is the first consumer of the parse boundary. It reads one
//! definition artifact and returns either a validated [`Definition`] or a
//! [`ValidationError`] with a stable reason code and a JSON Pointer to the
//! rejected field. The checks follow the shape of
//! `contracts/v0/definition.schema.json`:
//!
//! - The [`artifact`] module checks the `schema_version` envelope first.
//! - Every field outside the contract fails with `unknown_field`.
//! - Every absent required field fails with `missing_field`.
//! - Every wrong type, broken pattern, or out-of-range length fails with
//!   `invalid_field_type`.
//!
//! The parser keeps the authored shape of every field. It does not coerce a
//! value and applies no default. An omitted `when_uncertain` stays `None`;
//! the semantic layer owns the one documented default.
//!
//! The parser does not judge meaning. The cross-field invariants of the
//! contracts README, such as unique check identifiers, known labels, closed
//! scales, and the supported input schema subset, belong to
//! [`validate_definition`], which runs after this parser and returns a
//! [`ValidatedDefinition`] with the kind of every check established. For the
//! same reason, a definition with an empty check list parses, and validation
//! rejects it with `empty_check_set`.

use crate::artifact::{self, expect_object, reject_unknown_fields};
use crate::error::{fragment, ReasonCode, ValidationError};
use crate::input_schema;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Fields of the definition object, from the schema file.
const DEFINITION_FIELDS: &[&str] = &[
    "schema_version",
    "name",
    "when_uncertain",
    "inputs",
    "checks",
];

/// Fields of one check object, from the schema file.
const CHECK_FIELDS: &[&str] = &[
    "id", "name", "using", "question", "answers", "scale", "accept", "review", "rule",
];

/// The one documented uncertainty behavior in v0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WhenUncertain {
    /// An uncertain assessment produces review.
    Review,
}

/// One ordered level of a descriptive scale. The array order is meaning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScaleLevel {
    /// Level name, for example `minor`.
    pub name: String,
    /// Level description, as authored.
    pub description: String,
}

impl Serialize for ScaleLevel {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // One level is one single-key object. The authored form and the
        // serialized form agree, so a round trip keeps the artifact.
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry(&self.name, &self.description)?;
        map.end()
    }
}

/// One or many selected labels, in the authored form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum LabelSelection {
    /// One label, serialized as a string.
    One(String),
    /// Many labels, serialized as an array in the written order.
    Many(Vec<String>),
}

/// The acceptance selection of one question check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Accept {
    /// Scale acceptance. The named level and every higher level pass.
    AtLeast {
        /// First acceptable level.
        at_least: String,
    },
    /// Label acceptance for named answers.
    Labels(LabelSelection),
}

/// One deterministic rule on exactly one string input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Rule {
    /// The input passes when its code point length is at most the bound.
    MaxLength {
        /// Nonnegative bound, at most 2^53 minus 1.
        #[serde(rename = "maxLength")]
        max_length: u64,
    },
    /// The input passes when it contains the parameter.
    Includes {
        /// Nonempty code point sequence to find.
        includes: String,
    },
    /// The input passes when it does not contain the parameter.
    Excludes {
        /// Nonempty code point sequence to refuse.
        excludes: String,
    },
}

/// One check of a definition, with every authored field kept in its form.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Check {
    /// Stable check identifier, unique inside the definition.
    pub id: String,
    /// Readable statement of the requirement.
    pub name: String,
    /// Declared inputs that this check may read.
    pub using: Vec<String>,
    /// Question put to the evaluator, when this is a question check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    /// Named answers with descriptions, for a categorical or binary check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<BTreeMap<String, String>>,
    /// Ordered levels, lowest first, for an ordered check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<Vec<ScaleLevel>>,
    /// Accepted answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accept: Option<Accept>,
    /// Answers that produce review.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<LabelSelection>,
    /// Deterministic rule, when this is a rule check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<Rule>,
}

/// A parsed portable check definition.
///
/// A `Definition` value states that the artifact passed the structural
/// contract. It carries no evaluator name and no numerical cutoff, because
/// the contract forbids both.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Definition {
    /// Artifact schema version. The core supports version 1.
    pub schema_version: u32,
    /// Definition name.
    pub name: String,
    /// The only uncertainty behavior. `None` records an omitted field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when_uncertain: Option<WhenUncertain>,
    /// Root input schema, as one JSON object. The supported subset check
    /// runs in the semantic layer.
    pub inputs: Map<String, Value>,
    /// The checks of this definition.
    pub checks: Vec<Check>,
}

/// Parses one definition from strict JSON text.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the text fails the strict JSON gate or
/// the definition contract.
pub fn parse_definition_str(text: &str) -> Result<Definition, ValidationError> {
    crate::json::parse_strict(text).and_then(|value| parse_definition(&value))
}

/// Parses one definition from strict JSON bytes.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the bytes fail the UTF-8 check, the
/// strict JSON gate, or the definition contract.
pub fn parse_definition_bytes(bytes: &[u8]) -> Result<Definition, ValidationError> {
    crate::json::parse_bytes_strict(bytes).and_then(|value| parse_definition(&value))
}

/// Parses one definition from a JSON value that passed the strict gate.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value breaks the definition
/// contract.
pub fn parse_definition(value: &Value) -> Result<Definition, ValidationError> {
    let root = expect_object(value, "")?;
    let schema_version = artifact::schema_version(root)?;
    reject_unknown_fields(root, DEFINITION_FIELDS, "")?;

    let name = match root.get("name") {
        Some(Value::String(text)) if is_artifact_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/name",
                "The name must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing("/name")),
    };

    let when_uncertain = match root.get("when_uncertain") {
        None => None,
        Some(Value::String(text)) if text == "review" => Some(WhenUncertain::Review),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/when_uncertain",
                "The when_uncertain field accepts the value review only.",
            ));
        }
    };

    let inputs = match root.get("inputs") {
        Some(value) if value.is_object() => value.as_object().expect("checked").clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/inputs",
                "The inputs field must hold one object schema.",
            ));
        }
        None => return Err(ValidationError::missing("/inputs")),
    };

    let raw_checks = match root.get("checks") {
        Some(Value::Array(items)) => items,
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                "/checks",
                "The checks field must be an array.",
            ));
        }
        None => return Err(ValidationError::missing("/checks")),
    };
    let mut checks = Vec::with_capacity(raw_checks.len());
    for (index, item) in raw_checks.iter().enumerate() {
        checks.push(parse_check(item, index)?);
    }

    Ok(Definition {
        schema_version,
        name,
        when_uncertain,
        inputs,
        checks,
    })
}

/// The semantic shape of one check, from its authored fields.
///
/// The kinds match the assessment kinds of the contracts: a rule is exact,
/// named answers give `categorical` or `binary`, and a scale gives `ordered`.
/// A question is binary only when its answer keys are exactly `yes` and `no`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    /// One deterministic rule on one string input.
    Rule,
    /// Named answers other than the exact `yes` and `no` pair.
    Categorical,
    /// Named answers with exactly the keys `yes` and `no`.
    Binary,
    /// An ordered scale of named levels.
    Ordered,
}

/// One definition with its check meaning established.
///
/// The value states that the definition passed the parser and holds no
/// contract violation: unique identifiers, declared inputs, known and disjoint
/// label selections, closed scales, and an input schema inside the supported
/// subset. The authored artifact stays unchanged inside it.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedDefinition {
    /// The parsed artifact, kept as authored.
    definition: Definition,
    /// The typed root input schema.
    input_schema: input_schema::Schema,
    /// The kind of each check, in check order.
    kinds: Vec<CheckKind>,
}

impl ValidatedDefinition {
    /// Returns the parsed artifact, unchanged.
    pub fn as_definition(&self) -> &Definition {
        &self.definition
    }

    /// Returns the typed root input schema.
    pub fn input_schema(&self) -> &input_schema::Schema {
        &self.input_schema
    }

    /// Returns the effective uncertainty behavior. An omitted `when_uncertain`
    /// means `review`, the one documented default of the contracts.
    pub fn effective_when_uncertain(&self) -> WhenUncertain {
        self.definition
            .when_uncertain
            .unwrap_or(WhenUncertain::Review)
    }

    /// Returns the kind of every check, in check order.
    pub fn check_kinds(&self) -> &[CheckKind] {
        &self.kinds
    }

    /// Returns the kind of the check with the stated identifier.
    pub fn check_kind(&self, id: &str) -> Option<CheckKind> {
        self.definition
            .checks
            .iter()
            .position(|check| check.id == id)
            .map(|index| self.kinds[index])
    }

    /// Returns true when every check is an exact rule. Such a definition has
    /// no stochastic evaluator, as the contracts README records.
    pub fn is_exact_only(&self) -> bool {
        self.kinds.iter().all(|kind| *kind == CheckKind::Rule)
    }
}

impl Serialize for ValidatedDefinition {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // The validated value serializes to the artifact it came from. The
        // derived kinds are meaning, not artifact fields.
        self.definition.serialize(serializer)
    }
}

/// Validates one parsed definition against the cross-field invariants of the
/// contracts README.
///
/// The invariants cover check identity, the declared inputs, label
/// selections, scales, the shape of each check, and the supported input schema
/// subset. Check meaning is established here, before any evaluator exists.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the definition breaks one invariant.
pub fn validate_definition(
    definition: &Definition,
) -> Result<ValidatedDefinition, ValidationError> {
    if definition.checks.is_empty() {
        return Err(ValidationError::new(
            ReasonCode::EmptyCheckSet,
            "/checks",
            "The definition declares no checks.",
        ));
    }
    let input_schema = input_schema::validate_root(&definition.inputs, "/inputs")?;

    // Identity comes first, so a repeated identifier is reported even when
    // the repeated check has other faults.
    let mut seen: Vec<&str> = Vec::with_capacity(definition.checks.len());
    for (index, check) in definition.checks.iter().enumerate() {
        if seen.contains(&check.id.as_str()) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("/checks/{index}/id"),
                format!(
                    "The check identifier {} repeats an earlier check.",
                    fragment(&check.id)
                ),
            ));
        }
        seen.push(&check.id);
    }

    let mut kinds = Vec::with_capacity(definition.checks.len());
    for (index, check) in definition.checks.iter().enumerate() {
        kinds.push(validate_check(check, index, &input_schema)?);
    }
    Ok(ValidatedDefinition {
        definition: definition.clone(),
        input_schema,
        kinds,
    })
}

/// Validates the meaning of one check and returns its kind.
fn validate_check(
    check: &Check,
    index: usize,
    input_schema: &input_schema::Schema,
) -> Result<CheckKind, ValidationError> {
    let base = format!("/checks/{index}");

    // A check states exactly one of question or rule. A rule states no
    // question fields at all.
    match (check.question.is_some(), check.rule.is_some()) {
        (true, true) => {
            return Err(ValidationError::invalid_field_type(
                &base,
                "A check states exactly one of question or rule.",
            ));
        }
        (false, false) => {
            return Err(ValidationError::missing(format!("{base}/question")));
        }
        _ => {}
    }
    if check.rule.is_some()
        && (check.answers.is_some()
            || check.scale.is_some()
            || check.accept.is_some()
            || check.review.is_some())
    {
        return Err(ValidationError::invalid_field_type(
            &base,
            "A rule check states no answers, scale, accept, or review.",
        ));
    }

    // Every using entry names a declared input.
    let declared = input_schema.properties().expect("the root is an object");
    for name in &check.using {
        if !declared.contains_key(name) {
            return Err(ValidationError::new(
                ReasonCode::UnknownInputName,
                format!("{base}/using"),
                format!(
                    "The using entry {} names no declared input.",
                    fragment(name)
                ),
            ));
        }
    }

    if check.rule.is_some() {
        if check.using.len() != 1 {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/using"),
                "A rule check reads exactly one input.",
            ));
        }
        let only = &check.using[0];
        if !matches!(
            declared.get(only),
            Some(input_schema::Schema::String { .. })
        ) {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/using"),
                "A rule check reads one string input.",
            ));
        }
        return Ok(CheckKind::Rule);
    }

    // A question states named answers or an ordered scale, never both.
    match (check.answers.as_ref(), check.scale.as_ref()) {
        (Some(_), Some(_)) => {
            return Err(ValidationError::invalid_field_type(
                &base,
                "A question states named answers or an ordered scale, never both.",
            ));
        }
        (None, None) => {
            return Err(ValidationError::missing(format!("{base}/answers")));
        }
        _ => {}
    }

    if let Some(answers) = check.answers.as_ref() {
        let accepted = match &check.accept {
            Some(Accept::AtLeast { .. }) => {
                return Err(ValidationError::invalid_field_type(
                    format!("{base}/accept"),
                    "An answers check accepts labels. State at_least on a scale check only.",
                ));
            }
            Some(Accept::Labels(selection)) => {
                let labels = selected_labels(selection);
                for label in &labels {
                    if !answers.contains_key(*label) {
                        return Err(unknown_label(&format!("{base}/accept"), label));
                    }
                }
                labels
            }
            None => Vec::new(),
        };
        if let Some(selection) = &check.review {
            for label in selected_labels(selection) {
                if !answers.contains_key(label) {
                    return Err(unknown_label(&format!("{base}/review"), label));
                }
                if accepted.contains(&label) {
                    return Err(ValidationError::new(
                        ReasonCode::AcceptReviewOverlap,
                        format!("{base}/review"),
                        format!("The review label {} is also accepted.", fragment(label)),
                    ));
                }
            }
        }
        // Exactly the keys yes and no declare a binary question.
        let binary =
            answers.len() == 2 && answers.contains_key("yes") && answers.contains_key("no");
        return Ok(if binary {
            CheckKind::Binary
        } else {
            CheckKind::Categorical
        });
    }

    let Some(scale) = check.scale.as_ref() else {
        unreachable!("a question with no answers holds a scale");
    };
    if scale.len() < 2 {
        return Err(ValidationError::new(
            ReasonCode::InvalidScale,
            format!("{base}/scale"),
            "A scale declares two levels at least.",
        ));
    }
    let mut levels: Vec<&str> = Vec::with_capacity(scale.len());
    for level in scale {
        if levels.contains(&level.name.as_str()) {
            return Err(ValidationError::new(
                ReasonCode::InvalidScale,
                format!("{base}/scale"),
                format!(
                    "The scale repeats the level name {}.",
                    fragment(&level.name)
                ),
            ));
        }
        levels.push(&level.name);
    }
    // A scale accepts at_least and every higher level. A review level below
    // at_least stays valid; a review level inside the accepted range overlaps.
    let accepted_from = match &check.accept {
        Some(Accept::Labels(_)) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/accept"),
                "A scale check accepts at_least only.",
            ));
        }
        Some(Accept::AtLeast { at_least }) => {
            match levels.iter().position(|name| *name == at_least) {
                Some(position) => position,
                None => return Err(unknown_label(&format!("{base}/accept/at_least"), at_least)),
            }
        }
        None => levels.len(),
    };
    if let Some(selection) = &check.review {
        for label in selected_labels(selection) {
            let Some(position) = levels.iter().position(|name| *name == label) else {
                return Err(unknown_label(&format!("{base}/review"), label));
            };
            if position >= accepted_from {
                return Err(ValidationError::new(
                    ReasonCode::AcceptReviewOverlap,
                    format!("{base}/review"),
                    format!("The review label {} is also accepted.", fragment(label)),
                ));
            }
        }
    }
    Ok(CheckKind::Ordered)
}

/// Returns the labels of one selection, in written order.
fn selected_labels(selection: &LabelSelection) -> Vec<&str> {
    match selection {
        LabelSelection::One(label) => vec![label.as_str()],
        LabelSelection::Many(labels) => labels.iter().map(String::as_str).collect(),
    }
}

/// Builds an `unknown_label` failure for one selection path.
fn unknown_label(path: &str, label: &str) -> ValidationError {
    ValidationError::new(
        ReasonCode::UnknownLabel,
        path,
        format!(
            "The label {} is not an answer or a level of this check.",
            fragment(label)
        ),
    )
}

/// Parses and validates one definition from strict JSON text.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the text fails the strict JSON gate, the
/// definition contract, or one cross-field invariant.
pub fn validate_definition_str(text: &str) -> Result<ValidatedDefinition, ValidationError> {
    parse_definition_str(text).and_then(|parsed| validate_definition(&parsed))
}

/// Parses and validates one definition from strict JSON bytes.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the bytes fail the UTF-8 check, the
/// strict JSON gate, the definition contract, or one cross-field invariant.
pub fn validate_definition_bytes(bytes: &[u8]) -> Result<ValidatedDefinition, ValidationError> {
    parse_definition_bytes(bytes).and_then(|parsed| validate_definition(&parsed))
}

/// Parses one check at `/checks/{index}`.
fn parse_check(value: &Value, index: usize) -> Result<Check, ValidationError> {
    let base = format!("/checks/{index}");
    let check = expect_object(value, &base)?;
    reject_unknown_fields(check, CHECK_FIELDS, &base)?;

    let id = match check.get("id") {
        Some(Value::String(text)) if is_artifact_id(text) => text.clone(),
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/id"),
                "The check identifier must use lowercase segments joined by single hyphens, 64 characters at most.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/id"))),
    };

    let name = parse_bounded_string(
        check.get("name"),
        &format!("{base}/name"),
        200,
        "The check name",
    )?
    .ok_or_else(|| ValidationError::missing(format!("{base}/name")))?;

    let using_path = format!("{base}/using");
    let using = match check.get("using") {
        Some(Value::Array(items)) => {
            let mut names = Vec::with_capacity(items.len());
            let mut seen: Vec<&str> = Vec::new();
            for item in items {
                let Value::String(text) = item else {
                    return Err(ValidationError::invalid_field_type(
                        &using_path,
                        "Every using entry must be a string.",
                    ));
                };
                if !is_input_name(text) {
                    return Err(ValidationError::invalid_field_type(
                        &using_path,
                        "Every using entry must start with a letter or an underscore, and hold 64 characters at most.",
                    ));
                }
                if seen.contains(&text.as_str()) {
                    return Err(ValidationError::invalid_field_type(
                        &using_path,
                        "The using list repeats one input name.",
                    ));
                }
                seen.push(text.as_str());
                names.push(text.clone());
            }
            if names.is_empty() {
                return Err(ValidationError::invalid_field_type(
                    &using_path,
                    "The using list must name one input at least.",
                ));
            }
            names
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                &using_path,
                "The using field must be an array.",
            ));
        }
        None => return Err(ValidationError::missing(&using_path)),
    };

    let question = parse_bounded_string(
        check.get("question"),
        &format!("{base}/question"),
        8000,
        "The question",
    )?;

    let answers_path = format!("{base}/answers");
    let answers = match check.get("answers") {
        Some(Value::Object(map)) => {
            if map.len() < 2 {
                return Err(ValidationError::invalid_field_type(
                    &answers_path,
                    "A question with named answers must declare two answers at least.",
                ));
            }
            let mut answers = BTreeMap::new();
            for (label, description) in map {
                let Value::String(text) = description else {
                    return Err(ValidationError::invalid_field_type(
                        &answers_path,
                        "Every answer description must be a string.",
                    ));
                };
                if text.is_empty() || text.chars().count() > 1000 {
                    return Err(ValidationError::invalid_field_type(
                        &answers_path,
                        "Every answer description must hold 1 to 1000 characters.",
                    ));
                }
                answers.insert(label.clone(), text.clone());
            }
            Some(answers)
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                &answers_path,
                "The answers field must be an object.",
            ));
        }
        None => None,
    };

    let scale_path = format!("{base}/scale");
    let scale = match check.get("scale") {
        Some(Value::Array(items)) => {
            let mut levels = Vec::with_capacity(items.len());
            for item in items {
                let Value::Object(level) = item else {
                    return Err(ValidationError::invalid_field_type(
                        &scale_path,
                        "Every scale level must be an object with one property.",
                    ));
                };
                if level.len() != 1 {
                    return Err(ValidationError::invalid_field_type(
                        &scale_path,
                        "Every scale level must be an object with one property.",
                    ));
                }
                let (name, description) = level.iter().next().expect("one property");
                let Value::String(text) = description else {
                    return Err(ValidationError::invalid_field_type(
                        &scale_path,
                        "Every level description must be a string.",
                    ));
                };
                if text.is_empty() || text.chars().count() > 1000 {
                    return Err(ValidationError::invalid_field_type(
                        &scale_path,
                        "Every level description must hold 1 to 1000 characters.",
                    ));
                }
                levels.push(ScaleLevel {
                    name: name.clone(),
                    description: text.clone(),
                });
            }
            // The scale length and duplicate level names are semantic rules.
            Some(levels)
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                &scale_path,
                "The scale must be an array of levels.",
            ));
        }
        None => None,
    };

    let accept = parse_accept(check.get("accept"), &base)?;
    let review = parse_label_selection(check.get("review"), &base, "review")?;
    let rule = parse_rule(check.get("rule"), &base)?;

    Ok(Check {
        id,
        name,
        using,
        question,
        answers,
        scale,
        accept,
        review,
        rule,
    })
}

/// Parses the `accept` field: labels or an `at_least` object.
fn parse_accept(value: Option<&Value>, base: &str) -> Result<Option<Accept>, ValidationError> {
    let path = format!("{base}/accept");
    match value {
        None => Ok(None),
        Some(Value::Object(map)) => {
            if map.len() != 1 || !map.contains_key("at_least") {
                return Err(ValidationError::invalid_field_type(
                    path,
                    "The accept field must name labels or state at_least.",
                ));
            }
            match map.get("at_least") {
                Some(Value::String(text)) if is_label(text) => Ok(Some(Accept::AtLeast {
                    at_least: text.clone(),
                })),
                _ => Err(ValidationError::invalid_field_type(
                    format!("{path}/at_least"),
                    "The at_least field must name one scale level, 64 characters at most.",
                )),
            }
        }
        Some(other) => {
            if let Some(selection) = as_label_selection(other, &path)? {
                Ok(Some(Accept::Labels(selection)))
            } else {
                Err(ValidationError::invalid_field_type(
                    path,
                    "The accept field must name labels or state at_least.",
                ))
            }
        }
    }
}

/// Parses the `review` field: one label or a list of labels.
fn parse_label_selection(
    value: Option<&Value>,
    base: &str,
    field: &str,
) -> Result<Option<LabelSelection>, ValidationError> {
    let path = format!("{base}/{field}");
    match value {
        None => Ok(None),
        Some(other) => Ok(Some(as_label_selection(other, &path)?.ok_or_else(
            || {
                ValidationError::invalid_field_type(
                    path,
                    format!("The {field} field must name one label or a list of labels."),
                )
            },
        )?)),
    }
}

/// Reads one label or one list of labels. Returns `Ok(None)` for a value of
/// another type, so the caller can name the field in its own message.
fn as_label_selection(
    value: &Value,
    path: &str,
) -> Result<Option<LabelSelection>, ValidationError> {
    match value {
        Value::String(text) if is_label(text) => Ok(Some(LabelSelection::One(text.clone()))),
        Value::Array(items) => {
            let mut labels = Vec::with_capacity(items.len());
            let mut seen: Vec<&str> = Vec::new();
            for item in items {
                let Value::String(text) = item else {
                    return Err(ValidationError::invalid_field_type(
                        path,
                        "Every selected label must be a string.",
                    ));
                };
                if !is_label(text) {
                    return Err(ValidationError::invalid_field_type(
                        path,
                        "Every selected label must hold 1 to 64 characters.",
                    ));
                }
                if seen.contains(&text.as_str()) {
                    return Err(ValidationError::invalid_field_type(
                        path,
                        "The selection repeats one label.",
                    ));
                }
                seen.push(text.as_str());
                labels.push(text.clone());
            }
            if labels.is_empty() {
                return Err(ValidationError::invalid_field_type(
                    path,
                    "The selection must name one label at least.",
                ));
            }
            Ok(Some(LabelSelection::Many(labels)))
        }
        _ => Ok(None),
    }
}

/// Parses the `rule` field: exactly one rule keyword with a valid parameter.
/// The parameter itself passes through [`rule::parse_rule_parameter`], the
/// one authority for rule parameter validity.
fn parse_rule(value: Option<&Value>, base: &str) -> Result<Option<Rule>, ValidationError> {
    let path = format!("{base}/rule");
    let Some(Value::Object(map)) = value else {
        return match value {
            None => Ok(None),
            Some(_) => Err(ValidationError::invalid_field_type(
                path,
                "The rule field must be an object.",
            )),
        };
    };
    if map.len() != 1 {
        return Err(ValidationError::invalid_field_type(
            path,
            "A rule states exactly one of maxLength, includes, or excludes.",
        ));
    }
    let (keyword, parameter) = map.iter().next().expect("one property");
    crate::rule::parse_rule_parameter(keyword, parameter, &path).map(Some)
}

/// Reads one required-or-optional bounded string field.
fn parse_bounded_string(
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

/// Checks the artifact identifier rule of `common.schema.json`: lowercase
/// segments joined by single hyphens, 64 characters at most, starting with a
/// letter.
fn is_artifact_id(value: &str) -> bool {
    value.len() <= 64
        && value
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_lowercase())
        && value.split('-').all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        })
}

/// Checks the input name rule of `common.schema.json`: a letter or an
/// underscore first, then letters, digits, or underscores, 64 characters at
/// most.
pub(crate) fn is_input_name(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
        && value.len() <= 64
}

/// Checks the answer label rule of the definition schema: 1 to 64
/// characters.
fn is_label(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= 64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rule::MAX_SAFE_INTEGER;
    use serde_json::json;

    fn minimal_definition() -> Value {
        json!({
            "schema_version": 1,
            "name": "delivery-limits",
            "inputs": {
                "type": "object",
                "properties": {"summary": {"type": "string"}},
                "required": ["summary"],
                "additionalProperties": false
            },
            "checks": [
                {"id": "summary-length", "name": "The summary fits", "using": ["summary"], "rule": {"maxLength": 80}}
            ]
        })
    }

    #[test]
    fn a_minimal_definition_parses_with_its_authored_fields() {
        let parsed = parse_definition(&minimal_definition()).expect("the definition parses");
        assert_eq!(parsed.schema_version, 1);
        assert_eq!(parsed.name, "delivery-limits");
        assert_eq!(parsed.when_uncertain, None);
        assert_eq!(parsed.checks.len(), 1);
        let check = &parsed.checks[0];
        assert_eq!(check.id, "summary-length");
        assert_eq!(check.using, ["summary"]);
        assert_eq!(check.rule, Some(Rule::MaxLength { max_length: 80 }));
        assert_eq!(check.question, None);
    }

    #[test]
    fn a_stated_when_uncertain_is_kept_separate_from_an_omitted_one() {
        let mut value = minimal_definition();
        value["when_uncertain"] = json!("review");
        let stated = parse_definition(&value).expect("the definition parses");
        assert_eq!(stated.when_uncertain, Some(WhenUncertain::Review));
        // The serialized forms differ, because absence stays absence.
        let omitted = parse_definition(&minimal_definition()).expect("the definition parses");
        assert_ne!(
            serde_json::to_value(&stated).expect("serializes"),
            serde_json::to_value(&omitted).expect("serializes")
        );
    }

    #[test]
    fn an_empty_check_list_parses_here_and_fails_later() {
        // The semantic layer rejects an empty check set with
        // empty_check_set. The parser stays responsible for structure only.
        let mut value = minimal_definition();
        value["checks"] = json!([]);
        let parsed = parse_definition(&value).expect("the definition parses");
        assert!(parsed.checks.is_empty());
    }

    #[test]
    fn the_root_must_be_an_object() {
        for value in [json!([]), json!("text"), json!(1), json!(null)] {
            let error = parse_definition(&value).expect_err("not an object");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{value}: {error}");
            assert_eq!(error.field_path, "");
        }
    }

    #[test]
    fn unknown_fields_carry_their_pointer() {
        let mut value = minimal_definition();
        value["evaluator"] = json!("jev-choice");
        let error = parse_definition(&value).expect_err("unknown field");
        assert_eq!(error.code, ReasonCode::UnknownField);
        assert_eq!(error.field_path, "/evaluator");

        let mut nested = minimal_definition();
        nested["checks"][0]["cutoffs"] = json!({"accept": 0.8});
        let error = parse_definition(&nested).expect_err("unknown check field");
        assert_eq!(error.code, ReasonCode::UnknownField);
        assert_eq!(error.field_path, "/checks/0/cutoffs");
    }

    #[test]
    fn missing_required_fields_carry_their_pointer() {
        for field in ["name", "inputs", "checks"] {
            let mut value = minimal_definition();
            value.as_object_mut().expect("an object").remove(field);
            let error = parse_definition(&value).expect_err("missing field");
            assert_eq!(error.code, ReasonCode::MissingField, "{field}: {error}");
            assert_eq!(error.field_path, format!("/{field}"));
        }
        let mut missing_check_field = minimal_definition();
        missing_check_field["checks"][0]
            .as_object_mut()
            .expect("an object")
            .remove("using");
        let error = parse_definition(&missing_check_field).expect_err("missing using");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/checks/0/using");
    }

    #[test]
    fn identifiers_and_names_follow_their_patterns() {
        let long = "x".repeat(65);
        for name in [
            "Delivery",
            "has space",
            long.as_str(),
            "-leading",
            "a--double",
            "trailing-",
        ] {
            let mut value = minimal_definition();
            value["name"] = json!(name);
            let error = parse_definition(&value).expect_err("invalid name");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{name}: {error}");
            assert_eq!(error.field_path, "/name");
        }
        for id in ["Bad ID", "UPPER", "a_b"] {
            let mut value = minimal_definition();
            value["checks"][0]["id"] = json!(id);
            let error = parse_definition(&value).expect_err("invalid id");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{id}: {error}");
            assert_eq!(error.field_path, "/checks/0/id");
        }
    }

    #[test]
    fn long_text_fields_fail_with_their_pointer() {
        let mut long_name = minimal_definition();
        long_name["checks"][0]["name"] = json!("x".repeat(201));
        let error = parse_definition(&long_name).expect_err("long name");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/checks/0/name");

        let mut long_question = minimal_definition();
        long_question["checks"][0]["question"] = json!("x".repeat(8001));
        let error = parse_definition(&long_question).expect_err("long question");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/checks/0/question");
    }

    #[test]
    fn using_entries_must_be_declared_input_names() {
        for using in [
            json!("summary"),
            json!([]),
            json!(["summary", "summary"]),
            json!([1]),
            json!(["bad name"]),
        ] {
            let mut value = minimal_definition();
            value["checks"][0]["using"] = using.clone();
            let error = parse_definition(&value).expect_err("invalid using");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{using}: {error}");
            assert_eq!(error.field_path, "/checks/0/using");
        }
    }

    #[test]
    fn answers_need_two_described_entries_at_least() {
        let mut value = minimal_definition();
        value["checks"][0] = json!({
            "id": "summary-checked",
            "name": "The summary is checked",
            "using": ["summary"],
            "question": "Is the summary fit?",
            "answers": {"yes": "Fit."},
            "accept": "yes"
        });
        let error = parse_definition(&value).expect_err("one answer");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/checks/0/answers");

        value["checks"][0]["answers"] = json!({"yes": "Fit.", "no": 3});
        let error = parse_definition(&value).expect_err("non-string description");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/checks/0/answers");
    }

    #[test]
    fn scale_levels_hold_one_property() {
        let mut value = minimal_definition();
        value["checks"][0] = json!({
            "id": "consequence",
            "name": "The concern warrants an interruption",
            "using": ["summary"],
            "question": "What consequence does this concern have?",
            "scale": [{"minor": "Small.", "extra": "Second property."}, {"serious": "Large."}],
            "accept": {"at_least": "minor"}
        });
        let error = parse_definition(&value).expect_err("two properties");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/checks/0/scale");

        value["checks"][0]["scale"] = json!(["minor"]);
        let error = parse_definition(&value).expect_err("not an object");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/checks/0/scale");
    }

    #[test]
    fn accept_and_review_keep_their_authored_shapes() {
        let mut value = minimal_definition();
        value["checks"][0] = json!({
            "id": "message-supported",
            "name": "Our message accurately describes the evidence",
            "using": ["summary"],
            "question": "Does every claim follow from the evidence?",
            "answers": {"supported": "Yes.", "incomplete": "Partly."},
            "accept": ["supported"],
            "review": "incomplete"
        });
        let parsed = parse_definition(&value).expect("the definition parses");
        let serialized = serde_json::to_value(&parsed).expect("serializes");
        assert_eq!(serialized["checks"][0]["accept"], json!(["supported"]));
        assert_eq!(serialized["checks"][0]["review"], json!("incomplete"));

        // A scale acceptance keeps its single-key object.
        value["checks"][0]["accept"] = json!({"at_least": "supported"});
        let parsed = parse_definition(&value).expect("the definition parses");
        let serialized = serde_json::to_value(&parsed).expect("serializes");
        assert_eq!(
            serialized["checks"][0]["accept"],
            json!({"at_least": "supported"})
        );
    }

    #[test]
    fn malformed_accept_and_review_selections_fail() {
        let mut value = minimal_definition();
        value["checks"][0] = json!({
            "id": "message-supported",
            "name": "Our message accurately describes the evidence",
            "using": ["summary"],
            "question": "Does every claim follow from the evidence?",
            "answers": {"supported": "Yes.", "incomplete": "Partly."},
            "accept": 4
        });
        let error = parse_definition(&value).expect_err("numeric accept");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/checks/0/accept");

        value["checks"][0]["accept"] = json!({"at_least": "supported", "extra": true});
        let error = parse_definition(&value).expect_err("extra accept key");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/checks/0/accept");

        value["checks"][0]["accept"] = json!("supported");
        value["checks"][0]["review"] = json!([1]);
        let error = parse_definition(&value).expect_err("numeric review label");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "/checks/0/review");
    }

    #[test]
    fn rules_state_one_keyword_with_a_valid_parameter() {
        for rule in [
            json!({"maxLength": 80, "includes": "x"}),
            json!({}),
            json!({"pattern": "x"}),
            json!({"maxLength": -1}),
            json!({"maxLength": 80.5}),
            json!({"maxLength": MAX_SAFE_INTEGER + 1}),
            json!({"includes": ""}),
            json!({"excludes": "x".repeat(1001)}),
        ] {
            let mut value = minimal_definition();
            value["checks"][0]["rule"] = rule.clone();
            let error = parse_definition(&value).expect_err("invalid rule");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{rule}: {error}");
            assert!(
                error.field_path.starts_with("/checks/0/rule"),
                "{rule}: {error}"
            );
        }
        // The largest safe bound is accepted.
        let mut value = minimal_definition();
        value["checks"][0]["rule"] = json!({"maxLength": MAX_SAFE_INTEGER});
        assert!(parse_definition(&value).is_ok());
    }

    #[test]
    fn serialized_definitions_keep_the_source_artifact() {
        let value = minimal_definition();
        let parsed = parse_definition(&value).expect("the definition parses");
        let serialized = serde_json::to_value(&parsed).expect("serializes");
        assert_eq!(serialized, value);
    }

    #[test]
    fn the_text_entry_point_reports_json_failures() {
        let error = parse_definition_str("{\"name\": ").expect_err("truncated");
        assert_eq!(error.code, ReasonCode::InvalidJson);
        let error = parse_definition_bytes(&[0xc3, 0x28]).expect_err("not UTF-8");
        assert_eq!(error.code, ReasonCode::InvalidJson);
    }

    // Semantic validation tests. The parser above checks structure; the
    // validator checks check meaning, as the contracts README states.

    /// One categorical question. The accept and review labels follow the
    /// stated answers, so the helper fits every answer set.
    fn question_definition(answers: Value) -> Value {
        let keys: Vec<&String> = answers.as_object().expect("an object").keys().collect();
        let accepted = keys.last().expect("answers");
        let reviewed = keys[0];
        json!({
            "schema_version": 1,
            "name": "message-supported",
            "inputs": {
                "type": "object",
                "properties": {"proposed_message": {"type": "string"}},
                "required": ["proposed_message"],
                "additionalProperties": false
            },
            "checks": [{
                "id": "message-supported",
                "name": "Our message accurately describes the evidence",
                "using": ["proposed_message"],
                "question": "Does every claim follow from the evidence?",
                "answers": answers,
                "accept": accepted,
                "review": reviewed
            }]
        })
    }

    /// Parses and validates one definition value.
    fn validate(value: &Value) -> Result<ValidatedDefinition, ValidationError> {
        parse_definition(value).and_then(|parsed| validate_definition(&parsed))
    }

    #[test]
    fn validation_reports_kinds_and_the_uncertainty_default() {
        let validated = validate(&minimal_definition()).expect("the rule definition validates");
        assert_eq!(validated.check_kinds(), [CheckKind::Rule]);
        assert_eq!(
            validated.effective_when_uncertain(),
            WhenUncertain::Review,
            "an omitted when_uncertain defaults to review"
        );
        assert!(validated.is_exact_only(), "one rule check is exact only");

        let answers = json!({
            "supported": "All claims are supported.",
            "contradicted": "A claim conflicts.",
            "incomplete": "Support is missing."
        });
        let validated = validate(&question_definition(answers)).expect("validates");
        assert_eq!(validated.check_kinds(), [CheckKind::Categorical]);
        assert!(!validated.is_exact_only());
        assert_eq!(
            validated.check_kind("message-supported"),
            Some(CheckKind::Categorical)
        );
        assert_eq!(validated.check_kind("unknown-check"), None);
    }

    #[test]
    fn a_binary_question_needs_exactly_yes_and_no() {
        let binary = json!({
            "yes": "A participant recognizes the concern.",
            "no": "No supplied message recognizes the concern."
        });
        let validated = validate(&question_definition(binary.clone())).expect("validates");
        assert_eq!(validated.check_kinds(), [CheckKind::Binary]);

        // A third answer turns the question categorical.
        let mut three = binary;
        three["unclear"] = json!("The evidence is unclear.");
        let validated = validate(&question_definition(three)).expect("validates");
        assert_eq!(validated.check_kinds(), [CheckKind::Categorical]);

        // Other label pairs stay categorical.
        let translated = json!({
            "oui": "The concern is recognized.",
            "non": "The concern is not recognized."
        });
        let validated = validate(&question_definition(translated)).expect("validates");
        assert_eq!(validated.check_kinds(), [CheckKind::Categorical]);
    }

    #[test]
    fn duplicate_identifiers_fail_at_the_later_check() {
        let mut value = minimal_definition();
        let repeat = value["checks"][0].clone();
        value["checks"]
            .as_array_mut()
            .expect("an array")
            .push(repeat);
        value["checks"][1]["name"] = json!("The summary fits again");
        let error = validate(&value).expect_err("duplicate identifiers");
        assert_eq!(error.code, ReasonCode::DuplicateId, "{error}");
        assert_eq!(error.field_path, "/checks/1/id");
    }

    #[test]
    fn an_empty_check_set_fails_validation() {
        let mut value = minimal_definition();
        value["checks"] = json!([]);
        let error = validate(&value).expect_err("empty check set");
        assert_eq!(error.code, ReasonCode::EmptyCheckSet, "{error}");
        assert_eq!(error.field_path, "/checks");
    }

    #[test]
    fn a_check_states_exactly_one_question_or_rule() {
        // A question beside a rule.
        let mut value = minimal_definition();
        value["checks"][0]["question"] = json!("Is the summary fit?");
        value["checks"][0]["answers"] = json!({"yes": "Fit.", "no": "Not fit."});
        value["checks"][0]["accept"] = json!("yes");
        let error = validate(&value).expect_err("question beside rule");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/checks/0");

        // A rule beside an accept selection.
        let mut value = minimal_definition();
        value["checks"][0]["accept"] = json!("yes");
        let error = validate(&value).expect_err("rule beside accept");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/checks/0");

        // Neither a question nor a rule.
        let mut value = minimal_definition();
        value["checks"][0]
            .as_object_mut()
            .expect("an object")
            .remove("rule");
        let error = validate(&value).expect_err("no question and no rule");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/checks/0/question");
    }

    #[test]
    fn a_question_states_one_answer_map_or_scale() {
        // Both.
        let mut value = question_definition(json!({
            "supported": "All claims are supported.",
            "incomplete": "Support is missing."
        }));
        value["checks"][0]["scale"] = json!([
            {"minor": "No consequence."},
            {"serious": "A conflict with a commitment."}
        ]);
        let error = validate(&value).expect_err("answers beside scale");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/checks/0");

        // Neither.
        let mut value = question_definition(json!({
            "supported": "All claims are supported.",
            "incomplete": "Support is missing."
        }));
        value["checks"][0]
            .as_object_mut()
            .expect("an object")
            .remove("answers");
        let error = validate(&value).expect_err("no answers and no scale");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/checks/0/answers");
    }

    #[test]
    fn selections_name_declared_labels_only() {
        let answers = json!({
            "supported": "All claims are supported.",
            "incomplete": "Support is missing."
        });

        let mut value = question_definition(answers.clone());
        value["checks"][0]["accept"] = json!("excellent");
        let error = validate(&value).expect_err("unknown accept label");
        assert_eq!(error.code, ReasonCode::UnknownLabel, "{error}");
        assert_eq!(error.field_path, "/checks/0/accept");

        let mut value = question_definition(answers);
        value["checks"][0]["review"] = json!("missing");
        let error = validate(&value).expect_err("unknown review label");
        assert_eq!(error.code, ReasonCode::UnknownLabel, "{error}");
        assert_eq!(error.field_path, "/checks/0/review");
    }

    #[test]
    fn accept_and_review_selections_stay_disjoint() {
        let mut value = question_definition(json!({
            "supported": "All claims are supported.",
            "contradicted": "A claim conflicts.",
            "incomplete": "Support is missing."
        }));
        value["checks"][0]["accept"] = json!(["supported", "contradicted"]);
        value["checks"][0]["review"] = json!("contradicted");
        let error = validate(&value).expect_err("overlap");
        assert_eq!(error.code, ReasonCode::AcceptReviewOverlap, "{error}");
        assert_eq!(error.field_path, "/checks/0/review");
    }

    /// One ordered-scale check.
    fn scale_definition() -> Value {
        json!({
            "schema_version": 1,
            "name": "consequence-level",
            "inputs": {
                "type": "object",
                "properties": {"conversation": {"type": "string"}},
                "required": ["conversation"],
                "additionalProperties": false
            },
            "checks": [{
                "id": "consequence",
                "name": "The concern warrants an interruption",
                "using": ["conversation"],
                "question": "What consequence does this concern have?",
                "scale": [
                    {"minor": "No identified operational consequence."},
                    {"meaningful": "A coordination problem causing rework."},
                    {"serious": "A conflict with an explicit commitment."}
                ],
                "accept": {"at_least": "meaningful"}
            }]
        })
    }

    #[test]
    fn scales_hold_two_unique_levels_at_least() {
        let mut value = scale_definition();
        value["checks"][0]["scale"] = json!([{"minor": "Only one level."}]);
        let error = validate(&value).expect_err("one level");
        assert_eq!(error.code, ReasonCode::InvalidScale, "{error}");
        assert_eq!(error.field_path, "/checks/0/scale");

        let mut value = scale_definition();
        value["checks"][0]["scale"] = json!([
            {"minor": "No identified operational consequence."},
            {"minor": "A repeated level name."}
        ]);
        let error = validate(&value).expect_err("repeated level");
        assert_eq!(error.code, ReasonCode::InvalidScale, "{error}");
        assert_eq!(error.field_path, "/checks/0/scale");
    }

    #[test]
    fn scale_acceptance_uses_at_least_on_a_declared_level() {
        let mut value = scale_definition();
        value["checks"][0]["accept"] = json!({"at_least": "critical"});
        let error = validate(&value).expect_err("unknown level");
        assert_eq!(error.code, ReasonCode::UnknownLabel, "{error}");
        assert_eq!(error.field_path, "/checks/0/accept/at_least");

        // A label selection never fits a scale check.
        let mut value = scale_definition();
        value["checks"][0]["accept"] = json!("serious");
        let error = validate(&value).expect_err("labels on a scale");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/checks/0/accept");

        // At least never fits an answers check.
        let mut value = question_definition(json!({
            "supported": "All claims are supported.",
            "incomplete": "Support is missing."
        }));
        value["checks"][0]["accept"] = json!({"at_least": "supported"});
        let error = validate(&value).expect_err("at least on answers");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/checks/0/accept");
    }

    #[test]
    fn scale_review_stays_below_the_accepted_range() {
        // A review level below at_least is valid.
        let mut value = scale_definition();
        value["checks"][0]["review"] = json!("minor");
        assert!(validate(&value).is_ok());

        // A review level inside the accepted range overlaps.
        let mut value = scale_definition();
        value["checks"][0]["review"] = json!("serious");
        let error = validate(&value).expect_err("review inside the accepted range");
        assert_eq!(error.code, ReasonCode::AcceptReviewOverlap, "{error}");
        assert_eq!(error.field_path, "/checks/0/review");

        // A review level outside the scale is unknown.
        let mut value = scale_definition();
        value["checks"][0]["review"] = json!("critical");
        let error = validate(&value).expect_err("unknown review level");
        assert_eq!(error.code, ReasonCode::UnknownLabel, "{error}");
        assert_eq!(error.field_path, "/checks/0/review");
    }

    #[test]
    fn a_rule_uses_exactly_one_string_input() {
        // Two inputs.
        let mut value = minimal_definition();
        value["inputs"]["properties"]["notice"] = json!({"type": "string"});
        value["inputs"]["required"] = json!(["summary", "notice"]);
        value["checks"][0]["using"] = json!(["summary", "notice"]);
        let error = validate(&value).expect_err("two inputs");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/checks/0/using");

        // One number input.
        let mut value = minimal_definition();
        let properties = value["inputs"]["properties"]
            .as_object_mut()
            .expect("an object");
        properties.remove("summary");
        properties.insert("severity".to_owned(), json!({"type": "integer"}));
        value["inputs"]["required"] = json!(["severity"]);
        value["checks"][0]["using"] = json!(["severity"]);
        let error = validate(&value).expect_err("number input");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/checks/0/using");

        // One undeclared input.
        let mut value = minimal_definition();
        value["checks"][0]["using"] = json!(["body"]);
        let error = validate(&value).expect_err("undeclared input");
        assert_eq!(error.code, ReasonCode::UnknownInputName, "{error}");
        assert_eq!(error.field_path, "/checks/0/using");
    }

    #[test]
    fn a_validated_definition_serializes_to_its_artifact() {
        let value = scale_definition();
        let validated = validate(&value).expect("validates");
        assert_eq!(validated.as_definition().name, "consequence-level");
        let serialized = serde_json::to_value(&validated).expect("serializes");
        assert_eq!(serialized, value);
    }
}
