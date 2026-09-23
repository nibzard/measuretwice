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
//! scales, and the supported input schema subset, belong to the definition
//! validation that runs after this parser. For the same reason, a definition
//! with an empty check list parses, and the semantic layer rejects it with
//! `empty_check_set`.

use crate::artifact;
use crate::error::{fragment, ReasonCode, ValidationError};
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

/// Highest safe integer, 2^53 minus 1. The hashing contract fixes this bound
/// for a `maxLength` parameter.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

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
    match keyword.as_str() {
        "maxLength" => match parameter {
            Value::Number(number) if number.is_u64() => {
                let bound = number.as_u64().expect("checked");
                if bound <= MAX_SAFE_INTEGER {
                    Ok(Some(Rule::MaxLength { max_length: bound }))
                } else {
                    Err(ValidationError::invalid_field_type(
                        format!("{path}/maxLength"),
                        "The maxLength bound must stay at 2^53 minus 1 or below.",
                    ))
                }
            }
            _ => Err(ValidationError::invalid_field_type(
                format!("{path}/maxLength"),
                "The maxLength bound must be a nonnegative integer.",
            )),
        },
        "includes" => Ok(Some(Rule::Includes {
            includes: rule_text(parameter, &format!("{path}/includes"))?,
        })),
        "excludes" => Ok(Some(Rule::Excludes {
            excludes: rule_text(parameter, &format!("{path}/excludes"))?,
        })),
        other => Err(ValidationError::invalid_field_type(
            path,
            format!(
                "The rule keyword {} is outside the contract. State maxLength, includes, or excludes.",
                fragment(other)
            ),
        )),
    }
}

/// Reads one nonempty rule parameter of at most 1000 characters.
fn rule_text(value: &Value, path: &str) -> Result<String, ValidationError> {
    match value {
        Value::String(text) if !text.is_empty() && text.chars().count() <= 1000 => Ok(text.clone()),
        _ => Err(ValidationError::invalid_field_type(
            path,
            "The rule parameter must hold 1 to 1000 characters.",
        )),
    }
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

/// Rejects every key outside the allowed fields of one object.
fn reject_unknown_fields(
    object: &Map<String, Value>,
    allowed: &[&str],
    base: &str,
) -> Result<(), ValidationError> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(ValidationError::new(
                ReasonCode::UnknownField,
                format!("{base}/{key}"),
                format!(
                    "The artifact has a field outside its contract: {}.",
                    fragment(key)
                ),
            ));
        }
    }
    Ok(())
}

/// Reads one object value or rejects it with `invalid_field_type`.
fn expect_object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, ValidationError> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(ValidationError::invalid_field_type(
            path,
            "The value must be an object.",
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
fn is_input_name(value: &str) -> bool {
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
}
