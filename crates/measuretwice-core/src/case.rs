// SPDX-License-Identifier: Apache-2.0
//! Strict parsing, validation, and input projection of one case.
//!
//! One case supplies the data of one run: a stable identifier and one input
//! object. The shape comes from the public `run` operation in the contracts
//! README: `id` and `input`, and nothing else. Reference labels, expected
//! outcomes, label provenance, baseline decisions, and every other field
//! stay outside a case, so they cannot reach an evaluator request.
//!
//! Validation runs in two steps, as for a definition. [`parse_case`] checks
//! the envelope and returns a [`Case`]. [`validate_case`] then checks the
//! input object against the input schema of one
//! [`ValidatedDefinition`](crate::definition::ValidatedDefinition), using
//! [`validate_input`](crate::input_schema::validate_input) on the typed
//! schema tree. Every failure returns before any evaluator call, because
//! projection starts from a [`ValidatedCase`] only.
//!
//! [`ValidatedCase::projected_inputs`] copies the inputs that each check
//! `using` list names into one new map per check. The case input object
//! stays unchanged. A projected request holds no case identifier, no labels,
//! and no input that the check did not declare.

use crate::artifact::{expect_object, reject_unknown_fields};
use crate::definition::{Check, ValidatedDefinition};
use crate::error::ValidationError;
use crate::input_schema;
use serde::Serialize;
use serde_json::{Map, Value};

/// Fields of one case, from the public `run` operation.
const CASE_FIELDS: &[&str] = &["id", "input"];

/// One parsed case.
///
/// A `Case` value states that the envelope passed the structural contract:
/// an identifier that follows the case identifier rule and one input object.
/// The input data itself is unchecked here. The semantic check runs against
/// one definition, because only a definition states the input schema.
#[derive(Debug, Clone, PartialEq)]
pub struct Case {
    /// Stable case identifier, unique inside one dataset.
    pub id: String,
    /// The complete input object, as supplied.
    pub input: Map<String, Value>,
}

/// The authorized inputs of one check, projected for one evaluator request.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectedInputs {
    /// The check that these inputs serve.
    pub check_id: String,
    /// The declared inputs of the check, by name. No other field appears
    /// here.
    pub inputs: Map<String, Value>,
}

/// One case validated against one definition.
///
/// The value states that the input object satisfies the definition input
/// schema and every published data limit. Projection reads this value only,
/// so an unvalidated case can never reach an evaluator request.
#[derive(Debug, Clone)]
pub struct ValidatedCase<'a> {
    /// The definition that validated the input object.
    definition: &'a ValidatedDefinition,
    /// Stable case identifier.
    id: String,
    /// The complete input object, unchanged.
    input: Map<String, Value>,
}

impl<'a> ValidatedCase<'a> {
    /// Returns the definition that validated this case.
    pub fn definition(&self) -> &'a ValidatedDefinition {
        self.definition
    }

    /// Returns the stable case identifier.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Returns the complete input object, unchanged.
    pub fn input(&self) -> &Map<String, Value> {
        &self.input
    }

    /// Projects the authorized inputs of every check, in definition order.
    ///
    /// Each projected map holds only the inputs that the check `using` list
    /// names. Values are copied, so the case input object stays unchanged.
    /// The case identifier and every undeclared field stay outside.
    pub fn projected_inputs(&self) -> Vec<ProjectedInputs> {
        self.definition
            .as_definition()
            .checks
            .iter()
            .map(|check| ProjectedInputs {
                check_id: check.id.clone(),
                inputs: self.project(check),
            })
            .collect()
    }

    /// Copies the declared inputs of one check into one new map.
    fn project(&self, check: &Check) -> Map<String, Value> {
        let mut inputs = Map::new();
        for name in &check.using {
            let value = self
                .input
                .get(name)
                .expect("validation requires every top-level input");
            inputs.insert(name.clone(), value.clone());
        }
        inputs
    }
}

/// Parses one case from strict JSON text.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the text fails the strict JSON gate or
/// the case envelope.
pub fn parse_case_str(text: &str) -> Result<Case, ValidationError> {
    crate::json::parse_strict(text).and_then(|value| parse_case(&value))
}

/// Parses one case from strict JSON bytes.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the bytes fail the UTF-8 check, the
/// strict JSON gate, or the case envelope.
pub fn parse_case_bytes(bytes: &[u8]) -> Result<Case, ValidationError> {
    crate::json::parse_bytes_strict(bytes).and_then(|value| parse_case(&value))
}

/// Parses one case from a JSON value that passed the strict gate.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value breaks the case envelope:
/// an unknown field, a missing field, a wrong type, or an invalid identifier.
pub fn parse_case(value: &Value) -> Result<Case, ValidationError> {
    let root = expect_object(value, "")?;
    reject_unknown_fields(root, CASE_FIELDS, "")?;

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

    Ok(Case { id, input })
}

/// Validates one parsed case against one validated definition.
///
/// The input object must satisfy the definition input schema and every
/// published data limit, including the limit on the complete input object.
///
/// # Errors
///
/// Returns a [`ValidationError`] before any evaluator call, with a field
/// path inside the case record.
pub fn validate_case<'a>(
    case: &Case,
    definition: &'a ValidatedDefinition,
) -> Result<ValidatedCase<'a>, ValidationError> {
    let encoded = serde_json::to_vec(&case.input).expect("a JSON value serializes");
    if encoded.len() > input_schema::MAX_INPUT_BYTES {
        return Err(ValidationError::new(
            crate::error::ReasonCode::OversizedInput,
            "/input",
            format!(
                "The complete input object serializes to more than {} bytes.",
                input_schema::MAX_INPUT_BYTES
            ),
        ));
    }
    input_schema::validate_input(definition.input_schema(), &case.input, "/input")?;
    Ok(ValidatedCase {
        definition,
        id: case.id.clone(),
        input: case.input.clone(),
    })
}

/// Parses and validates one case from strict JSON text.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the text fails the strict JSON gate,
/// the case envelope, or the input schema of the definition.
pub fn validate_case_str<'a>(
    text: &str,
    definition: &'a ValidatedDefinition,
) -> Result<ValidatedCase<'a>, ValidationError> {
    parse_case_str(text).and_then(|case| validate_case(&case, definition))
}

/// Parses and validates one case from strict JSON bytes.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the bytes fail the UTF-8 check, the
/// strict JSON gate, the case envelope, or the input schema of the
/// definition.
pub fn validate_case_bytes<'a>(
    bytes: &[u8],
    definition: &'a ValidatedDefinition,
) -> Result<ValidatedCase<'a>, ValidationError> {
    parse_case_bytes(bytes).and_then(|case| validate_case(&case, definition))
}

/// Checks the case identifier rule of `common.schema.json`: a lowercase
/// letter or a digit first, then lowercase letters, digits, dots,
/// underscores, or hyphens, 128 characters at most.
pub(crate) fn is_case_id(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(
        characters.next(),
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit()
    ) && characters.all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || character == '.'
            || character == '_'
            || character == '-'
    }) && value.chars().count() <= 128
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ReasonCode;
    use serde_json::json;

    /// One validated definition with three declared inputs and two checks
    /// that read different projections.
    fn definition() -> ValidatedDefinition {
        let artifact = json!({
            "schema_version": 1,
            "name": "message-review",
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
                    "id": "decision-contradicted",
                    "name": "An earlier decision is being contradicted",
                    "using": ["prior_decision", "conversation"],
                    "question": "Does the conversation contradict the earlier decision?",
                    "answers": {"yes": "It contradicts.", "no": "It does not."},
                    "accept": "yes"
                },
                {
                    "id": "message-length",
                    "name": "The message fits the limit",
                    "using": ["proposed_message"],
                    "rule": {"maxLength": 900}
                }
            ]
        });
        crate::definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates")
    }

    /// One complete case for that definition.
    fn complete_case() -> Value {
        json!({
            "id": "case.1_b-x",
            "input": {
                "prior_decision": "Ship on Friday.",
                "conversation": "We agreed to ship on Thursday.",
                "proposed_message": "We now ship on Thursday."
            }
        })
    }

    /// Parses and validates one case value against the test definition. The
    /// definition lives for the whole test, so the returned borrow is valid.
    fn validate(value: &Value) -> Result<ValidatedCase<'static>, ValidationError> {
        let text = serde_json::to_string(value).expect("the case serializes");
        let definition: &'static ValidatedDefinition = Box::leak(Box::new(definition()));
        validate_case_str(&text, definition)
    }

    #[test]
    fn a_complete_case_parses_with_its_fields() {
        let parsed = parse_case(&complete_case()).expect("the case parses");
        assert_eq!(parsed.id, "case.1_b-x");
        assert_eq!(parsed.input["prior_decision"], "Ship on Friday.");
        // Digits and dots pass the identifier rule.
        for id in ["a", "007", "case-1.2_x"] {
            let mut value = complete_case();
            value["id"] = json!(id);
            assert!(parse_case(&value).is_ok(), "{id}");
        }
    }

    #[test]
    fn missing_fields_carry_their_pointer() {
        for field in ["id", "input"] {
            let mut value = complete_case();
            value.as_object_mut().expect("an object").remove(field);
            let error = parse_case(&value).expect_err("a missing field");
            assert_eq!(error.code, ReasonCode::MissingField, "{field}: {error}");
            assert_eq!(error.field_path, format!("/{field}"), "{field}");
        }
    }

    #[test]
    fn unknown_fields_are_rejected_with_their_pointer() {
        // Labels, expected outcomes, provenance, baselines, and metadata
        // never enter a case, so they cannot reach an evaluator request.
        for field in ["expected", "label", "baseline", "tags", "group"] {
            let mut value = complete_case();
            value[field] = json!({"outcome": "pass"});
            let error = parse_case(&value).expect_err("an unknown field");
            assert_eq!(error.code, ReasonCode::UnknownField, "{field}: {error}");
            assert_eq!(error.field_path, format!("/{field}"), "{field}");
        }
    }

    #[test]
    fn wrong_field_types_fail_with_their_pointer() {
        let mut value = complete_case();
        value["id"] = json!(3);
        let error = parse_case(&value).expect_err("a numeric identifier");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/id");

        let mut value = complete_case();
        value["input"] = json!(["summary"]);
        let error = parse_case(&value).expect_err("an array input");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/input");

        let error = parse_case(&json!("text")).expect_err("a non-object root");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "");
    }

    #[test]
    fn invalid_identifiers_fail() {
        let long = "a".repeat(129);
        for id in [
            "Case-1",
            "case 1",
            "-case",
            ".case",
            "case!",
            "café",
            long.as_str(),
        ] {
            let mut value = complete_case();
            value["id"] = json!(id);
            let error = parse_case(&value).expect_err("an invalid identifier");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{id}: {error}");
            assert_eq!(error.field_path, "/id", "{id}");
        }
        // The 128-character bound passes.
        let mut value = complete_case();
        value["id"] = json!("a".repeat(128));
        assert!(parse_case(&value).is_ok());
    }

    #[test]
    fn the_text_entry_point_reports_json_failures() {
        let error = parse_case_str("{\"id\": ").expect_err("truncated");
        assert_eq!(error.code, ReasonCode::InvalidJson);
        let error = parse_case_bytes(&[0xc3, 0x28]).expect_err("not UTF-8");
        assert_eq!(error.code, ReasonCode::InvalidJson);
    }

    #[test]
    fn input_failures_return_before_projection() {
        // An unknown input property.
        let mut value = complete_case();
        value["input"]["notice"] = json!("Extra field");
        let error = validate(&value).expect_err("an unknown input property");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/input/notice");

        // A missing required input.
        let mut value = complete_case();
        value["input"]
            .as_object_mut()
            .expect("an object")
            .remove("conversation");
        let error = validate(&value).expect_err("a missing input");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/input/conversation");

        // A broken constraint.
        let mut value = complete_case();
        value["input"]["proposed_message"] = json!("");
        let error = validate(&value).expect_err("an empty string");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/input/proposed_message");

        // A wrong type.
        let mut value = complete_case();
        value["input"]["prior_decision"] = json!(7);
        let error = validate(&value).expect_err("a number for a string");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/input/prior_decision");
    }

    #[test]
    fn the_complete_input_object_limit_holds() {
        // Five strings of 900,000 bytes serialize above the 4,194,304-byte
        // limit, while each string stays below its own 1,048,576-byte limit.
        let mut properties = serde_json::Map::new();
        let mut required = Vec::new();
        let mut input = Map::new();
        for index in 0..5 {
            let name = format!("text_{index}");
            properties.insert(name.clone(), json!({"type": "string"}));
            required.push(json!(name));
            input.insert(name, Value::String("a".repeat(900_000)));
        }
        let artifact = json!({
            "schema_version": 1,
            "name": "large-inputs",
            "inputs": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false
            },
            "checks": [{
                "id": "probe",
                "name": "The probe check",
                "using": ["text_0"],
                "question": "Does the input satisfy the record?",
                "answers": {"yes": "It does.", "no": "It does not."}
            }]
        });
        let definition = crate::definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates");
        let case = Case {
            id: "large".to_owned(),
            input,
        };
        let error = validate_case(&case, &definition).expect_err("an oversized input object");
        assert_eq!(error.code, ReasonCode::OversizedInput, "{error}");
        assert_eq!(error.field_path, "/input");

        // The same five inputs below the limit stay valid. Five strings of
        // 800,000 bytes serialize below the bound.
        let Case { id, .. } = case;
        let mut smaller = Map::new();
        for index in 0..5 {
            smaller.insert(format!("text_{index}"), Value::String("a".repeat(800_000)));
        }
        let smaller = Case { id, input: smaller };
        assert!(validate_case(&smaller, &definition).is_ok());
    }

    #[test]
    fn projection_copies_only_the_declared_inputs() {
        let validated = validate(&complete_case()).expect("the case validates");
        let projected = validated.projected_inputs();
        assert_eq!(projected.len(), 2);

        // Each projection holds exactly its using list.
        assert_eq!(projected[0].check_id, "decision-contradicted");
        assert_eq!(
            projected[0].inputs,
            json!({
                "prior_decision": "Ship on Friday.",
                "conversation": "We agreed to ship on Thursday."
            })
            .as_object()
            .expect("an object")
            .clone()
        );
        assert_eq!(projected[1].check_id, "message-length");
        assert_eq!(
            projected[1].inputs,
            json!({"proposed_message": "We now ship on Thursday."})
                .as_object()
                .expect("an object")
                .clone()
        );

        // The case identifier and the unrelated input stay outside every
        // projected request.
        for projection in &projected {
            assert!(!projection.inputs.contains_key("id"));
        }
        assert!(!projected[0].inputs.contains_key("proposed_message"));
        assert!(!projected[1].inputs.contains_key("conversation"));
    }

    #[test]
    fn projection_leaves_the_original_case_unchanged() {
        let value = complete_case();
        let parsed = parse_case(&value).expect("the case parses");
        let before = parsed.clone();
        let definition = definition();
        let validated = validate_case(&parsed, &definition).expect("the case validates");
        let projected = validated.projected_inputs();

        // A change to one projected map cannot reach the case input object.
        let mut first = projected.into_iter().next().expect("one projection");
        first.inputs.insert(
            "prior_decision".to_owned(),
            Value::String("rewritten".to_owned()),
        );
        assert_eq!(validated.input()["prior_decision"], "Ship on Friday.");
        assert_eq!(parsed, before, "the parsed case keeps its original value");
        assert_eq!(value["input"]["prior_decision"], "Ship on Friday.");
    }

    #[test]
    fn a_validated_case_reports_its_binding() {
        let validated = validate(&complete_case()).expect("the case validates");
        assert_eq!(validated.id(), "case.1_b-x");
        assert_eq!(
            validated.definition().as_definition().name,
            "message-review"
        );
        assert_eq!(
            validated.input()["proposed_message"],
            "We now ship on Thursday."
        );
    }
}
