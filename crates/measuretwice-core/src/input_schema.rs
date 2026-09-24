// SPDX-License-Identifier: Apache-2.0
//! Validation of the supported input schema subset.
//!
//! `contracts/v0/input-schema.md` freezes the supported subset of JSON Schema
//! 2020-12 for the `inputs` field of a definition. This module is the
//! authority for that subset. It rejects every keyword and every form outside
//! the subset with a field path, and it returns one typed schema tree that
//! keeps the accepted constraints. Case validation walks that tree, so the
//! data rules and the schema rules cannot drift apart.
//!
//! The subset is closed. A keyword that the subset never lists is rejected
//! with `unsupported_keyword` before its type is known, so a reference such as
//! `$ref` cannot pass as a schema without a type. A keyword of another type is
//! rejected with the same code after the type is known. A supported keyword
//! with a wrong or out-of-range value is rejected with `invalid_field_type`.
//!
//! Validation never mutates the schema, never adds a keyword, and never reads
//! an external resource. The TypeBox authoring conversion may remove only its
//! documented metadata; that conversion belongs to the wrapper.

use crate::definition::is_input_name;
use crate::error::{fragment, ReasonCode, ValidationError};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Deepest nesting level. The root sits at depth 0. Every `properties` value
/// and every `items` value adds one level.
pub const MAX_DEPTH: usize = 8;

/// Most properties on one object schema.
pub const MAX_PROPERTIES: usize = 64;

/// Most schemas in one input schema, root included.
pub const MAX_SCHEMAS: usize = 1024;

/// Highest `minLength` and `maxLength` bound.
pub const MAX_LENGTH_BOUND: u64 = 250_000;

/// Highest `minItems` and `maxItems` bound.
pub const MAX_ITEMS_BOUND: u64 = 10_000;

/// Most UTF-8 bytes in one string input value, from the data limits table.
pub const MAX_STRING_BYTES: usize = 1_048_576;

/// Most items in one array input value, from the data limits table.
pub const MAX_ARRAY_ITEMS: usize = 10_000;

/// Most UTF-8 bytes in the serialized complete input object, from the data
/// limits table. The limit covers the compact JSON serialization of the
/// input object.
pub const MAX_INPUT_BYTES: usize = 4_194_304;

/// Numeric bounds of one `number` or `integer` schema, as authored.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NumericBounds {
    /// Inclusive lower bound.
    pub minimum: Option<f64>,
    /// Inclusive upper bound.
    pub maximum: Option<f64>,
    /// Exclusive lower bound.
    pub exclusive_minimum: Option<f64>,
    /// Exclusive upper bound.
    pub exclusive_maximum: Option<f64>,
}

/// One accepted schema of the supported subset, with its constraints kept.
#[derive(Debug, Clone, PartialEq)]
pub enum Schema {
    /// A string input, bounded by code point length.
    String {
        /// Fewest code points.
        min_length: Option<u64>,
        /// Most code points.
        max_length: Option<u64>,
    },
    /// A finite number input.
    Number {
        /// Authored bounds.
        bounds: NumericBounds,
    },
    /// A finite number input with a zero fractional part.
    Integer {
        /// Authored bounds, each an integer.
        bounds: NumericBounds,
    },
    /// A boolean input.
    Boolean,
    /// An array input. Every element matches `items`.
    Array {
        /// Schema of every element.
        items: Box<Schema>,
        /// Fewest elements.
        min_items: Option<u64>,
        /// Most elements.
        max_items: Option<u64>,
    },
    /// An object input. The object is closed; `properties` names every
    /// permitted property, and `required` names the properties that must be
    /// present.
    Object {
        /// Declared properties, by name.
        properties: BTreeMap<String, Schema>,
        /// Names of the properties that must be present.
        required: Vec<String>,
    },
}

impl Schema {
    /// Returns the declared properties when this is an object schema.
    pub fn properties(&self) -> Option<&BTreeMap<String, Schema>> {
        match self {
            Self::Object { properties, .. } => Some(properties),
            _ => None,
        }
    }
}

/// Every keyword of the subset, across all types. A keyword outside this set
/// is outside the subset for every type, whatever the stated type is.
const SUBSET_KEYWORDS: &[&str] = &[
    "type",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "items",
    "minItems",
    "maxItems",
    "properties",
    "required",
    "additionalProperties",
];

/// The keywords that fit each type, from the subset contract.
const KEYWORDS_BY_TYPE: &[(&str, &[&str])] = &[
    ("string", &["type", "minLength", "maxLength"]),
    (
        "number",
        &[
            "type",
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
        ],
    ),
    (
        "integer",
        &[
            "type",
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
        ],
    ),
    ("boolean", &["type"]),
    ("array", &["type", "items", "minItems", "maxItems"]),
    (
        "object",
        &["type", "properties", "required", "additionalProperties"],
    ),
];

/// Rejects the first keyword that no type of the subset supports.
fn reject_outside_keywords(schema: &Map<String, Value>, path: &str) -> Result<(), ValidationError> {
    for keyword in schema.keys() {
        if !SUBSET_KEYWORDS.contains(&keyword.as_str()) {
            return Err(ValidationError::new(
                ReasonCode::UnsupportedKeyword,
                path,
                format!(
                    "The keyword {} is outside the supported input schema subset.",
                    fragment(keyword)
                ),
            ));
        }
    }
    Ok(())
}

/// Rejects the first keyword that the stated type does not support.
fn reject_keywords_of_other_types(
    schema: &Map<String, Value>,
    type_name: &str,
    path: &str,
) -> Result<(), ValidationError> {
    let Some((_, allowed)) = KEYWORDS_BY_TYPE
        .iter()
        .find(|(known, _)| *known == type_name)
    else {
        return Ok(());
    };
    for keyword in schema.keys() {
        if !allowed.contains(&keyword.as_str()) {
            return Err(ValidationError::new(
                ReasonCode::UnsupportedKeyword,
                path,
                format!(
                    "The keyword {} does not fit the {} type of the supported subset.",
                    fragment(keyword),
                    fragment(type_name)
                ),
            ));
        }
    }
    Ok(())
}

/// Reads the stated type of one schema.
fn stated_type<'a>(schema: &'a Map<String, Value>, path: &str) -> Result<&'a str, ValidationError> {
    let Some(field) = schema.get("type") else {
        return Err(ValidationError::missing(format!("{path}/type")));
    };
    let Value::String(type_name) = field else {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/type"),
            "The type field must be one string, never an array.",
        ));
    };
    if KEYWORDS_BY_TYPE
        .iter()
        .any(|(known, _)| *known == type_name.as_str())
    {
        Ok(type_name)
    } else {
        Err(ValidationError::new(
            ReasonCode::UnsupportedKeyword,
            path,
            format!(
                "The type {} is outside the supported input schema subset.",
                fragment(type_name)
            ),
        ))
    }
}

/// Reads one integer bound with a published range.
fn integer_bound(
    schema: &Map<String, Value>,
    keyword: &str,
    path: &str,
    limit: u64,
) -> Result<Option<u64>, ValidationError> {
    let Some(field) = schema.get(keyword) else {
        return Ok(None);
    };
    let Value::Number(number) = field else {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/{keyword}"),
            format!("The {keyword} bound must be an integer."),
        ));
    };
    match number.as_u64() {
        Some(bound) if bound <= limit => Ok(Some(bound)),
        _ => Err(ValidationError::invalid_field_type(
            format!("{path}/{keyword}"),
            format!("The {keyword} bound must be an integer from 0 to {limit}."),
        )),
    }
}

/// Reads one numeric bound. An `integer` schema takes integer bounds only.
fn numeric_bound(
    schema: &Map<String, Value>,
    keyword: &str,
    path: &str,
    integer: bool,
) -> Result<Option<f64>, ValidationError> {
    let Some(field) = schema.get(keyword) else {
        return Ok(None);
    };
    let Value::Number(number) = field else {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/{keyword}"),
            format!("The {keyword} bound must be a number."),
        ));
    };
    let Some(value) = number.as_f64() else {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/{keyword}"),
            format!("The {keyword} bound must be a finite number."),
        ));
    };
    if !value.is_finite() {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/{keyword}"),
            format!("The {keyword} bound must be a finite number."),
        ));
    }
    if integer && !(number.is_u64() || number.is_i64() || value.fract() == 0.0) {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/{keyword}"),
            "Every bound of an integer schema is an integer.",
        ));
    }
    Ok(Some(value))
}

/// Rejects sibling numeric bounds that no value can satisfy.
fn reject_conflicting_bounds(bounds: &NumericBounds, path: &str) -> Result<(), ValidationError> {
    let NumericBounds {
        minimum,
        maximum,
        exclusive_minimum,
        exclusive_maximum,
    } = *bounds;
    let conflict =
        |left: Option<f64>, right: Option<f64>, exclusive_right: bool| match (left, right) {
            (Some(left), Some(right)) => {
                if exclusive_right {
                    left >= right
                } else {
                    left > right
                }
            }
            _ => false,
        };
    let conflicting = conflict(minimum, maximum, false)
        || conflict(minimum, exclusive_maximum, true)
        || conflict(exclusive_minimum, maximum, true)
        || conflict(exclusive_minimum, exclusive_maximum, true);
    if conflicting {
        return Err(ValidationError::invalid_field_type(
            path,
            "The lower bound of this schema sits above its upper bound.",
        ));
    }
    Ok(())
}

/// Reads the `required` list of one object schema. Every entry must name a
/// declared property.
fn required_names(
    schema: &Map<String, Value>,
    properties: &Map<String, Value>,
    path: &str,
) -> Result<Option<Vec<String>>, ValidationError> {
    let Some(field) = schema.get("required") else {
        return Ok(None);
    };
    let Value::Array(entries) = field else {
        return Err(ValidationError::invalid_field_type(
            format!("{path}/required"),
            "The required field is an array of property names.",
        ));
    };
    let mut required = Vec::with_capacity(entries.len());
    let mut seen: Vec<&str> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let Value::String(name) = entry else {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/required/{index}"),
                "Every required entry is a property name.",
            ));
        };
        if !is_input_name(name) {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/required/{index}"),
                "Every required entry follows the input name rule.",
            ));
        }
        if seen.contains(&name.as_str()) {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/required"),
                "The required list repeats one property name.",
            ));
        }
        if !properties.contains_key(name) {
            return Err(ValidationError::new(
                ReasonCode::UnknownField,
                format!("{path}/required/{index}"),
                format!(
                    "The required entry {} names no declared property.",
                    fragment(name)
                ),
            ));
        }
        seen.push(name);
        required.push(name.clone());
    }
    Ok(Some(required))
}

/// Walks one schema and returns its typed form.
struct Walker {
    /// Schemas seen so far, root included.
    count: usize,
}

impl Walker {
    /// Counts one more schema and enforces the total limit.
    fn enter(&mut self, path: &str) -> Result<(), ValidationError> {
        self.count += 1;
        if self.count > MAX_SCHEMAS {
            return Err(ValidationError::invalid_field_type(
                path,
                format!("The input schema holds more than {MAX_SCHEMAS} schemas."),
            ));
        }
        Ok(())
    }

    /// Walks one nested schema at `path` and `depth`. The root sits at depth 0.
    fn walk(&mut self, value: &Value, path: &str, depth: usize) -> Result<Schema, ValidationError> {
        if depth > MAX_DEPTH {
            return Err(ValidationError::invalid_field_type(
                path,
                format!("The input schema nests deeper than {MAX_DEPTH} levels."),
            ));
        }
        self.enter(path)?;
        let Value::Object(schema) = value else {
            return Err(if matches!(value, Value::Bool(_)) {
                ValidationError::new(
                    ReasonCode::UnsupportedKeyword,
                    path,
                    "Boolean schemas are outside the supported input schema subset.",
                )
            } else {
                ValidationError::invalid_field_type(
                    path,
                    "Every schema inside the input schema is an object.",
                )
            });
        };
        let type_name = self.type_of(schema, path)?;
        self.walk_typed(schema, type_name, path, depth)
    }

    /// Reads the type after the closed keyword scan.
    fn type_of<'a>(
        &mut self,
        schema: &'a Map<String, Value>,
        path: &str,
    ) -> Result<&'a str, ValidationError> {
        reject_outside_keywords(schema, path)?;
        stated_type(schema, path)
    }

    /// Walks one schema whose type is known.
    fn walk_typed(
        &mut self,
        schema: &Map<String, Value>,
        type_name: &str,
        path: &str,
        depth: usize,
    ) -> Result<Schema, ValidationError> {
        reject_keywords_of_other_types(schema, type_name, path)?;
        match type_name {
            "string" => {
                let min_length = integer_bound(schema, "minLength", path, MAX_LENGTH_BOUND)?;
                let max_length = integer_bound(schema, "maxLength", path, MAX_LENGTH_BOUND)?;
                if let (Some(min), Some(max)) = (min_length, max_length) {
                    if min > max {
                        return Err(ValidationError::invalid_field_type(
                            path,
                            "The minLength bound sits above the maxLength bound.",
                        ));
                    }
                }
                Ok(Schema::String {
                    min_length,
                    max_length,
                })
            }
            "number" | "integer" => {
                let integer = type_name == "integer";
                let bounds = NumericBounds {
                    minimum: numeric_bound(schema, "minimum", path, integer)?,
                    maximum: numeric_bound(schema, "maximum", path, integer)?,
                    exclusive_minimum: numeric_bound(schema, "exclusiveMinimum", path, integer)?,
                    exclusive_maximum: numeric_bound(schema, "exclusiveMaximum", path, integer)?,
                };
                reject_conflicting_bounds(&bounds, path)?;
                Ok(if integer {
                    Schema::Integer { bounds }
                } else {
                    Schema::Number { bounds }
                })
            }
            "boolean" => Ok(Schema::Boolean),
            "array" => {
                let Some(items) = schema.get("items") else {
                    return Err(ValidationError::missing(format!("{path}/items")));
                };
                let items = self.walk(items, &format!("{path}/items"), depth + 1)?;
                let min_items = integer_bound(schema, "minItems", path, MAX_ITEMS_BOUND)?;
                let max_items = integer_bound(schema, "maxItems", path, MAX_ITEMS_BOUND)?;
                if let (Some(min), Some(max)) = (min_items, max_items) {
                    if min > max {
                        return Err(ValidationError::invalid_field_type(
                            path,
                            "The minItems bound sits above the maxItems bound.",
                        ));
                    }
                }
                Ok(Schema::Array {
                    items: Box::new(items),
                    min_items,
                    max_items,
                })
            }
            "object" => self.walk_object(schema, path, depth, false),
            _ => Err(ValidationError::invalid_field_type(
                format!("{path}/type"),
                "The type field must be one string.",
            )),
        }
    }

    /// Walks one object schema. The root adds the rule that every declared
    /// input is required.
    fn walk_object(
        &mut self,
        schema: &Map<String, Value>,
        path: &str,
        depth: usize,
        root: bool,
    ) -> Result<Schema, ValidationError> {
        match schema.get("additionalProperties") {
            Some(Value::Bool(false)) => {}
            Some(_) => {
                return Err(ValidationError::invalid_field_type(
                    path,
                    "Every object schema closes additionalProperties with false.",
                ));
            }
            None => {
                return Err(ValidationError::missing(format!(
                    "{path}/additionalProperties"
                )));
            }
        }

        let Some(Value::Object(declared)) = schema.get("properties") else {
            return Err(match schema.get("properties") {
                None => ValidationError::missing(format!("{path}/properties")),
                Some(_) => ValidationError::invalid_field_type(
                    format!("{path}/properties"),
                    "The properties field holds a map of schemas.",
                ),
            });
        };
        if declared.is_empty() || declared.len() > MAX_PROPERTIES {
            return Err(ValidationError::invalid_field_type(
                format!("{path}/properties"),
                format!("An object schema declares 1 to {MAX_PROPERTIES} properties."),
            ));
        }
        let mut properties = BTreeMap::new();
        for (name, subschema) in declared {
            if !is_input_name(name) {
                return Err(ValidationError::invalid_field_type(
                    format!("{path}/properties/{name}"),
                    "Every property name follows the input name rule.",
                ));
            }
            let walked = self.walk(subschema, &format!("{path}/properties/{name}"), depth + 1)?;
            properties.insert(name.clone(), walked);
        }

        let required = match required_names(schema, declared, path)? {
            Some(required) => required,
            None if root => {
                return Err(ValidationError::missing(format!("{path}/required")));
            }
            None => Vec::new(),
        };
        if root {
            for name in properties.keys() {
                if !required.contains(name) {
                    return Err(ValidationError::new(
                        ReasonCode::MissingField,
                        format!("{path}/required"),
                        format!(
                            "Every top-level input is required. The required list omits {}.",
                            fragment(name)
                        ),
                    ));
                }
            }
        }
        Ok(Schema::Object {
            properties,
            required,
        })
    }
}

/// Validates one root input schema and returns its typed tree.
///
/// `base` is the JSON Pointer of the schema inside its artifact, for example
/// `/inputs`.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the schema leaves the supported subset,
/// breaks a cross-field rule, or exceeds a published limit.
pub fn validate_root(schema: &Map<String, Value>, base: &str) -> Result<Schema, ValidationError> {
    let mut walker = Walker { count: 0 };
    walker.enter(base)?;
    reject_outside_keywords(schema, base)?;
    match schema.get("type") {
        Some(Value::String(type_name)) if type_name == "object" => {}
        Some(Value::String(_)) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/type"),
                "The root input schema states type object.",
            ));
        }
        Some(_) => {
            return Err(ValidationError::invalid_field_type(
                format!("{base}/type"),
                "The type field must be one string.",
            ));
        }
        None => return Err(ValidationError::missing(format!("{base}/type"))),
    }
    walker.walk_object(schema, base, 0, true)
}

/// Validates one complete input object against one validated root schema.
///
/// `base` is the JSON Pointer of the input object inside its case record, for
/// example `/input`.
///
/// The root scan reports an undeclared property with `unknown_field`, as the
/// input fixtures record: a top-level input is a named field of the case. A
/// nested object reports the same situation with `invalid_field_type`,
/// because the closed-object rule is a constraint on that value.
///
/// # Errors
///
/// Returns a [`ValidationError`] when one value breaks a constraint of the
/// schema or exceeds a published data limit. The code and the field path
/// follow the errors table of the subset contract.
pub fn validate_input(
    schema: &Schema,
    input: &Map<String, Value>,
    base: &str,
) -> Result<(), ValidationError> {
    let Schema::Object {
        properties,
        required,
    } = schema
    else {
        return Err(ValidationError::invalid_field_type(
            base,
            "The root input schema must be an object schema.",
        ));
    };
    validate_object(properties, required, input, base, ReasonCode::UnknownField)
}

/// Validates one input value against one schema of the subset.
///
/// `path` is the JSON Pointer of the value inside its case record, for
/// example `/input/tickets/1`. Validation never coerces a value, never
/// mutates it, and never creates an absent property.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the value breaks the schema or exceeds
/// a published data limit.
pub fn validate_value(schema: &Schema, value: &Value, path: &str) -> Result<(), ValidationError> {
    match schema {
        Schema::String {
            min_length,
            max_length,
        } => validate_string(*min_length, *max_length, value, path),
        Schema::Number { bounds } => validate_number(bounds, false, value, path),
        Schema::Integer { bounds } => validate_number(bounds, true, value, path),
        Schema::Boolean => match value {
            Value::Bool(_) => Ok(()),
            _ => Err(ValidationError::invalid_field_type(
                path,
                "The input value must be a boolean. A number never passes for a boolean.",
            )),
        },
        Schema::Array {
            items,
            min_items,
            max_items,
        } => validate_array(items, *min_items, *max_items, value, path),
        Schema::Object {
            properties,
            required,
        } => match value {
            Value::Object(map) => validate_object(
                properties,
                required,
                map,
                path,
                ReasonCode::InvalidFieldType,
            ),
            _ => Err(ValidationError::invalid_field_type(
                path,
                "The input value must be an object.",
            )),
        },
    }
}

/// Validates one string value. The size limit comes before the length bounds.
fn validate_string(
    min_length: Option<u64>,
    max_length: Option<u64>,
    value: &Value,
    path: &str,
) -> Result<(), ValidationError> {
    let Value::String(text) = value else {
        return Err(ValidationError::invalid_field_type(
            path,
            "The input value must be a string.",
        ));
    };
    if text.len() > MAX_STRING_BYTES {
        return Err(ValidationError::new(
            ReasonCode::OversizedInput,
            path,
            format!("The string holds more than {MAX_STRING_BYTES} bytes in UTF-8 encoding."),
        ));
    }
    let length = text.chars().count() as u64;
    if let Some(min) = min_length {
        if length < min {
            return Err(ValidationError::invalid_field_type(
                path,
                "The string holds fewer code points than minLength permits.",
            ));
        }
    }
    if let Some(max) = max_length {
        if length > max {
            return Err(ValidationError::invalid_field_type(
                path,
                "The string holds more code points than maxLength permits.",
            ));
        }
    }
    Ok(())
}

/// Validates one number value against its bounds. An `integer` schema accepts
/// a zero fractional part only. Every `serde_json` number is finite, so no
/// separate finite check exists.
fn validate_number(
    bounds: &NumericBounds,
    integer: bool,
    value: &Value,
    path: &str,
) -> Result<(), ValidationError> {
    let Value::Number(number) = value else {
        return Err(ValidationError::invalid_field_type(
            path,
            if integer {
                "The input value must be an integer."
            } else {
                "The input value must be a number."
            },
        ));
    };
    let parsed = number
        .as_f64()
        .expect("a serde_json number converts to one finite double");
    if integer && parsed.fract() != 0.0 {
        return Err(ValidationError::invalid_field_type(
            path,
            "The input value must be an integer. A fraction is not an integer.",
        ));
    }
    let NumericBounds {
        minimum,
        maximum,
        exclusive_minimum,
        exclusive_maximum,
    } = *bounds;
    if let Some(bound) = minimum {
        if parsed < bound {
            return Err(ValidationError::invalid_field_type(
                path,
                "The value sits below the minimum bound.",
            ));
        }
    }
    if let Some(bound) = maximum {
        if parsed > bound {
            return Err(ValidationError::invalid_field_type(
                path,
                "The value sits above the maximum bound.",
            ));
        }
    }
    if let Some(bound) = exclusive_minimum {
        if parsed <= bound {
            return Err(ValidationError::invalid_field_type(
                path,
                "The value sits at or below the exclusive minimum bound.",
            ));
        }
    }
    if let Some(bound) = exclusive_maximum {
        if parsed >= bound {
            return Err(ValidationError::invalid_field_type(
                path,
                "The value sits at or above the exclusive maximum bound.",
            ));
        }
    }
    Ok(())
}

/// Validates one array value. The item-count limit comes before the item
/// bounds, and every element follows in order.
fn validate_array(
    items: &Schema,
    min_items: Option<u64>,
    max_items: Option<u64>,
    value: &Value,
    path: &str,
) -> Result<(), ValidationError> {
    let Value::Array(elements) = value else {
        return Err(ValidationError::invalid_field_type(
            path,
            "The input value must be an array.",
        ));
    };
    if elements.len() > MAX_ARRAY_ITEMS {
        return Err(ValidationError::new(
            ReasonCode::OversizedInput,
            path,
            format!("The array holds more than {MAX_ARRAY_ITEMS} items."),
        ));
    }
    let count = elements.len() as u64;
    if let Some(min) = min_items {
        if count < min {
            return Err(ValidationError::invalid_field_type(
                path,
                "The array holds fewer items than minItems permits.",
            ));
        }
    }
    if let Some(max) = max_items {
        if count > max {
            return Err(ValidationError::invalid_field_type(
                path,
                "The array holds more items than maxItems permits.",
            ));
        }
    }
    for (index, element) in elements.iter().enumerate() {
        validate_value(items, element, &format!("{path}/{index}"))?;
    }
    Ok(())
}

/// Validates one object value. An undeclared property fails first, then an
/// absent required property, then each present value in key order.
/// `unknown_code` names the code for an undeclared property: `unknown_field`
/// at the input root, `invalid_field_type` inside a nested value.
fn validate_object(
    properties: &BTreeMap<String, Schema>,
    required: &[String],
    map: &Map<String, Value>,
    path: &str,
    unknown_code: ReasonCode,
) -> Result<(), ValidationError> {
    for key in map.keys() {
        if !properties.contains_key(key) {
            return Err(ValidationError::new(
                unknown_code,
                format!("{path}/{key}"),
                format!(
                    "The input object has a property outside its schema: {}.",
                    fragment(key)
                ),
            ));
        }
    }
    for name in required {
        if !map.contains_key(name) {
            return Err(ValidationError::missing(format!("{path}/{name}")));
        }
    }
    for (key, value) in map {
        let schema = properties
            .get(key)
            .expect("the unknown-property scan passed every key");
        validate_value(schema, value, &format!("{path}/{key}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One root schema value with one declared input.
    fn root_with(property: Value) -> Value {
        json!({
            "type": "object",
            "properties": {"summary": property},
            "required": ["summary"],
            "additionalProperties": false
        })
    }

    fn validate(schema: &Value) -> Result<Schema, ValidationError> {
        validate_root(schema.as_object().expect("an object"), "/inputs")
    }

    #[test]
    fn a_schema_using_every_supported_type_validates() {
        let schema = json!({
            "type": "object",
            "properties": {
                "summary": {"type": "string", "minLength": 1, "maxLength": 200},
                "severity": {"type": "integer", "minimum": 1, "maximum": 5},
                "confidence": {"type": "number", "minimum": 0, "exclusiveMaximum": 1},
                "breaking": {"type": "boolean"},
                "tickets": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                    "minItems": 1,
                    "maxItems": 50
                },
                "metadata": {
                    "type": "object",
                    "properties": {"team": {"type": "string"}, "area": {"type": "string"}},
                    "required": ["team"],
                    "additionalProperties": false
                }
            },
            "required": [
                "summary", "severity", "confidence", "breaking", "tickets", "metadata"
            ],
            "additionalProperties": false
        });
        let validated = validate(&schema).expect("the schema validates");
        let properties = validated.properties().expect("the root is an object");
        assert_eq!(properties.len(), 6);
        assert_eq!(
            properties["summary"],
            Schema::String {
                min_length: Some(1),
                max_length: Some(200)
            }
        );
        assert_eq!(
            properties["severity"],
            Schema::Integer {
                bounds: NumericBounds {
                    minimum: Some(1.0),
                    maximum: Some(5.0),
                    exclusive_minimum: None,
                    exclusive_maximum: None
                }
            }
        );
        let Schema::Array {
            items,
            min_items,
            max_items,
        } = &properties["tickets"]
        else {
            panic!("an array schema");
        };
        assert_eq!(min_items, &Some(1));
        assert_eq!(max_items, &Some(50));
        assert_eq!(
            **items,
            Schema::String {
                min_length: Some(1),
                max_length: None
            }
        );
        let Schema::Object { required, .. } = &properties["metadata"] else {
            panic!("an object schema");
        };
        assert_eq!(required, &["team".to_owned()]);
    }

    #[test]
    fn every_unsupported_keyword_is_rejected() {
        let unsupported = [
            ("$ref", json!("common.schema.json#/$defs/x")),
            ("$defs", json!({})),
            ("$id", json!("https://example.test/schema")),
            ("$anchor", json!("main")),
            ("$dynamicRef", json!("#x")),
            ("$dynamicAnchor", json!("main")),
            ("allOf", json!([])),
            ("anyOf", json!([])),
            ("oneOf", json!([])),
            ("not", json!({})),
            ("if", json!({})),
            ("then", json!({})),
            ("else", json!({})),
            ("dependentSchemas", json!({})),
            ("dependentRequired", json!({})),
            ("patternProperties", json!({})),
            ("propertyNames", json!({})),
            ("unevaluatedProperties", json!(false)),
            ("minProperties", json!(1)),
            ("maxProperties", json!(4)),
            ("prefixItems", json!([])),
            ("contains", json!({})),
            ("minContains", json!(1)),
            ("maxContains", json!(1)),
            ("uniqueItems", json!(true)),
            ("unevaluatedItems", json!(false)),
            ("pattern", json!("^[a-z]+$")),
            ("format", json!("date")),
            ("multipleOf", json!(2)),
            ("enum", json!([1, 2])),
            ("const", json!(1)),
            ("title", json!("Summary")),
            ("description", json!("The summary text.")),
            ("examples", json!([])),
            ("default", json!("")),
            ("readOnly", json!(true)),
            ("writeOnly", json!(true)),
            ("deprecated", json!(true)),
        ];
        for (keyword, value) in unsupported {
            let mut schema = root_with(json!({"type": "string"}));
            let schema = schema.as_object_mut().expect("an object");
            schema.insert(keyword.to_owned(), value.clone());
            let error = validate_root(schema, "/inputs").err().unwrap_or_else(|| {
                panic!("the keyword {keyword} was accepted with {value}");
            });
            assert_eq!(
                error.code,
                ReasonCode::UnsupportedKeyword,
                "{keyword}: {error}"
            );
            assert_eq!(error.field_path, "/inputs", "{keyword}: {error}");
        }
    }

    #[test]
    fn forms_outside_the_subset_are_rejected() {
        // The null type and unknown types.
        for type_name in ["null", "any"] {
            let error = validate(&json!({
                "type": "object",
                "properties": {"summary": {"type": type_name}},
                "required": ["summary"],
                "additionalProperties": false
            }))
            .expect_err("an unsupported type");
            assert_eq!(error.code, ReasonCode::UnsupportedKeyword, "{error}");
            assert_eq!(error.field_path, "/inputs/properties/summary", "{error}");
        }

        // Boolean schemas are not schemas here.
        let error = validate(&json!({
            "type": "object",
            "properties": {"summary": true},
            "required": ["summary"],
            "additionalProperties": false
        }))
        .expect_err("a boolean schema");
        assert_eq!(error.code, ReasonCode::UnsupportedKeyword, "{error}");
        assert_eq!(error.field_path, "/inputs/properties/summary");

        // An array type.
        let error = validate(&json!({
            "type": "object",
            "properties": {"summary": {"type": ["string", "null"]}},
            "required": ["summary"],
            "additionalProperties": false
        }))
        .expect_err("an array type");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/properties/summary/type");

        // A keyword of another type.
        let error = validate(&root_with(json!({"type": "string", "minItems": 1})))
            .expect_err("a keyword of another type");
        assert_eq!(error.code, ReasonCode::UnsupportedKeyword, "{error}");
        assert_eq!(error.field_path, "/inputs/properties/summary");

        // The tuple form of items.
        let error = validate(&json!({
            "type": "object",
            "properties": {"tickets": {"type": "array", "items": [{"type": "string"}]}},
            "required": ["tickets"],
            "additionalProperties": false
        }))
        .expect_err("tuple items");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/properties/tickets/items");
    }

    #[test]
    fn wrong_keyword_values_fail_with_their_keyword_path() {
        for bound in [json!(-1), json!("3"), json!(80.5), json!(250_001)] {
            let error = validate(&root_with(json!({"type": "string", "maxLength": bound})))
                .expect_err("an invalid bound");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{bound}: {error}");
            assert_eq!(error.field_path, "/inputs/properties/summary/maxLength");
        }
        for bound in [json!(-1), json!("1"), json!(10_001)] {
            let error = validate(&json!({
                "type": "object",
                "properties": {"tickets": {"type": "array", "items": {"type": "string"}, "minItems": bound}},
                "required": ["tickets"],
                "additionalProperties": false
            }))
            .expect_err("an invalid item bound");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{bound}: {error}");
            assert_eq!(error.field_path, "/inputs/properties/tickets/minItems");
        }
        let error = validate(&root_with(json!({"type": "number", "minimum": "0"})))
            .expect_err("a non-number bound");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/properties/summary/minimum");

        // A bound of an integer schema is an integer.
        let error = validate(&root_with(json!({"type": "integer", "minimum": 0.5})))
            .expect_err("a fractional integer bound");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/properties/summary/minimum");
        // A zero fraction is an integer.
        assert!(validate(&root_with(json!({"type": "integer", "minimum": 3.0}))).is_ok());
    }

    #[test]
    fn required_keywords_must_be_present() {
        let cases: [(Value, &str); 5] = [
            (
                json!({"properties": {"summary": {"type": "string"}}, "required": ["summary"], "additionalProperties": false}),
                "/inputs/type",
            ),
            (
                json!({"type": "object", "required": ["summary"], "additionalProperties": false}),
                "/inputs/properties",
            ),
            (
                json!({"type": "object", "properties": {"summary": {"type": "string"}}, "additionalProperties": false}),
                "/inputs/required",
            ),
            (
                json!({"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}),
                "/inputs/additionalProperties",
            ),
            (
                json!({
                    "type": "object",
                    "properties": {"tickets": {"type": "array"}},
                    "required": ["tickets"],
                    "additionalProperties": false
                }),
                "/inputs/properties/tickets/items",
            ),
        ];
        for (schema, path) in cases {
            let error = validate(&schema).expect_err("a required keyword is absent");
            assert_eq!(error.code, ReasonCode::MissingField, "{schema}: {error}");
            assert_eq!(error.field_path, path, "{schema}: {error}");
        }

        // A nested object without additionalProperties.
        let error = validate(&json!({
            "type": "object",
            "properties": {
                "metadata": {"type": "object", "properties": {"team": {"type": "string"}}}
            },
            "required": ["metadata"],
            "additionalProperties": false
        }))
        .expect_err("an open nested object");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(
            error.field_path,
            "/inputs/properties/metadata/additionalProperties"
        );
    }

    #[test]
    fn sibling_bounds_must_not_conflict() {
        let conflicting = [
            json!({"type": "string", "minLength": 5, "maxLength": 2}),
            json!({"type": "number", "minimum": 2, "maximum": 1}),
            json!({"type": "number", "minimum": 1, "exclusiveMaximum": 1}),
            json!({"type": "number", "exclusiveMinimum": 1, "maximum": 1}),
            json!({"type": "number", "exclusiveMinimum": 2, "exclusiveMaximum": 2}),
            json!({"type": "integer", "exclusiveMinimum": 5, "exclusiveMaximum": 5}),
        ];
        for property in conflicting {
            let error = validate(&root_with(property.clone())).expect_err("conflicting bounds");
            assert_eq!(
                error.code,
                ReasonCode::InvalidFieldType,
                "{property}: {error}"
            );
            assert_eq!(error.field_path, "/inputs/properties/summary", "{property}");
        }
        // Touching inclusive bounds stay valid.
        assert!(validate(&root_with(
            json!({"type": "number", "minimum": 1, "maximum": 1})
        ))
        .is_ok());
        // An exclusive lower bound below an inclusive upper bound stays valid.
        assert!(validate(&root_with(
            json!({"type": "number", "exclusiveMinimum": 1, "maximum": 2})
        ))
        .is_ok());
        // Conflicting array bounds.
        let error = validate(&json!({
            "type": "object",
            "properties": {
                "tickets": {"type": "array", "items": {"type": "string"}, "minItems": 5, "maxItems": 2}
            },
            "required": ["tickets"],
            "additionalProperties": false
        }))
        .expect_err("conflicting item bounds");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/properties/tickets");
    }

    #[test]
    fn required_names_declared_properties_only() {
        // An undeclared entry on the root.
        let error = validate(&json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary", "body"],
            "additionalProperties": false
        }))
        .expect_err("an undeclared root entry");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/inputs/required/1");

        // An undeclared entry on a nested object.
        let error = validate(&json!({
            "type": "object",
            "properties": {
                "metadata": {
                    "type": "object",
                    "properties": {"team": {"type": "string"}},
                    "required": ["team", "area"],
                    "additionalProperties": false
                }
            },
            "required": ["metadata"],
            "additionalProperties": false
        }))
        .expect_err("an undeclared nested entry");
        assert_eq!(error.code, ReasonCode::UnknownField, "{error}");
        assert_eq!(error.field_path, "/inputs/properties/metadata/required/1");

        // A repeated entry.
        let error = validate(&json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary", "summary"],
            "additionalProperties": false
        }))
        .expect_err("a repeated entry");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/required");

        // A non-string entry.
        let error = validate(&json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": [3],
            "additionalProperties": false
        }))
        .expect_err("a non-string entry");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/required/0");
    }

    #[test]
    fn the_root_names_every_declared_input() {
        let error = validate(&json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}, "notice": {"type": "string"}},
            "required": ["summary"],
            "additionalProperties": false
        }))
        .expect_err("an unrequired root input");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/inputs/required");

        // Every order of the required list is accepted.
        assert!(validate(&json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}, "notice": {"type": "string"}},
            "required": ["notice", "summary"],
            "additionalProperties": false
        }))
        .is_ok());
    }

    #[test]
    fn object_schemas_must_close_additional_properties() {
        // The root stays open.
        let error = validate(&json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"],
            "additionalProperties": true
        }))
        .expect_err("an open root");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs");

        // A nested object stays open.
        let error = validate(&json!({
            "type": "object",
            "properties": {
                "metadata": {
                    "type": "object",
                    "properties": {"team": {"type": "string"}},
                    "required": ["team"],
                    "additionalProperties": true
                }
            },
            "required": ["metadata"],
            "additionalProperties": false
        }))
        .expect_err("an open nested object");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/properties/metadata");
    }

    #[test]
    fn the_root_holds_no_other_keyword() {
        let mut schema = root_with(json!({"type": "string"}));
        schema
            .as_object_mut()
            .expect("an object")
            .insert("title".to_owned(), json!("Inputs"));
        let error = validate(&schema).expect_err("an extra root keyword");
        assert_eq!(error.code, ReasonCode::UnsupportedKeyword, "{error}");
        assert_eq!(error.field_path, "/inputs");
    }

    #[test]
    fn the_root_states_type_object() {
        let error = validate(&json!({
            "type": "string",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"],
            "additionalProperties": false
        }))
        .expect_err("a non-object root");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/type");

        let error = validate(&json!({"properties": {}, "additionalProperties": false}))
            .expect_err("a root without type");
        assert_eq!(error.code, ReasonCode::MissingField, "{error}");
        assert_eq!(error.field_path, "/inputs/type");
    }

    #[test]
    fn property_names_follow_the_input_name_rule() {
        let error = validate(&json!({
            "type": "object",
            "properties": {"bad name": {"type": "string"}},
            "required": ["bad name"],
            "additionalProperties": false
        }))
        .expect_err("an invalid property name");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/properties/bad name");
    }

    #[test]
    fn an_object_schema_declares_one_property_at_least() {
        let error = validate(&json!({
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
        }))
        .expect_err("no properties");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/properties");
    }

    #[test]
    fn the_schema_limits_hold() {
        // Depth: a string at level eight stays valid, a string at level nine
        // fails. The root is level zero.
        let wrap = |inner: Value| {
            json!({
                "type": "object",
                "properties": {"nested": inner},
                "required": ["nested"],
                "additionalProperties": false
            })
        };
        let mut chain = json!({"type": "string"});
        for _ in 0..8 {
            chain = wrap(chain);
        }
        assert!(
            validate(&chain).is_ok(),
            "a string at level eight stays valid"
        );
        let too_deep = wrap(chain);
        let error = validate(&too_deep).expect_err("a string at level nine");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert!(
            error.field_path.starts_with("/inputs/properties"),
            "{error}"
        );

        // Properties: 64 stay valid, 65 fail.
        let root_of = |count: usize| {
            let mut properties = Map::new();
            let mut required: Vec<Value> = Vec::new();
            for index in 0..count {
                let name = format!("input_{index}");
                properties.insert(name.clone(), json!({"type": "string"}));
                required.push(Value::String(name));
            }
            let mut schema = Map::new();
            schema.insert("type".to_owned(), json!("object"));
            schema.insert("properties".to_owned(), Value::Object(properties));
            schema.insert("required".to_owned(), Value::Array(required));
            schema.insert("additionalProperties".to_owned(), json!(false));
            schema
        };
        assert!(
            validate_root(&root_of(64), "/inputs").is_ok(),
            "64 properties stay valid"
        );
        let error = validate_root(&root_of(65), "/inputs").expect_err("65 properties");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/inputs/properties");

        // Schema count: the limit is 1024 schemas, root included. Sixteen
        // groups of 62 strings give 1 + 16 + 992 schemas. Fifteen top-level
        // strings reach 1024 exactly.
        let mut wide = Map::new();
        let mut properties = Map::new();
        for group in 0..16 {
            let mut inner = Map::new();
            for index in 0..62 {
                inner.insert(format!("field_{index}"), json!({"type": "string"}));
            }
            let required: Vec<Value> = inner.keys().map(|key| Value::String(key.clone())).collect();
            let mut object = Map::new();
            object.insert("type".to_owned(), json!("object"));
            object.insert("properties".to_owned(), Value::Object(inner));
            object.insert("required".to_owned(), Value::Array(required));
            object.insert("additionalProperties".to_owned(), json!(false));
            properties.insert(format!("group_{group}"), Value::Object(object));
        }
        let mut required: Vec<Value> = properties
            .keys()
            .map(|key| Value::String(key.clone()))
            .collect();
        for index in 0..15 {
            let name = format!("plain_{index}");
            properties.insert(name.clone(), json!({"type": "string"}));
            required.push(Value::String(name));
        }
        wide.insert("type".to_owned(), json!("object"));
        wide.insert("properties".to_owned(), Value::Object(properties));
        wide.insert("required".to_owned(), Value::Array(required));
        wide.insert("additionalProperties".to_owned(), json!(false));
        assert!(
            validate_root(&wide, "/inputs").is_ok(),
            "1024 schemas stay valid"
        );

        // One more schema crosses the limit.
        if let Some(list) = wide
            .get_mut("properties")
            .and_then(|value| value.as_object_mut())
        {
            if let Some(group) = list
                .get_mut("group_0")
                .and_then(|value| value.as_object_mut())
            {
                if let Some(inner) = group
                    .get_mut("properties")
                    .and_then(|value| value.as_object_mut())
                {
                    let mut names: Vec<Value> =
                        inner.keys().map(|key| Value::String(key.clone())).collect();
                    inner.insert("extra".to_owned(), json!({"type": "string"}));
                    names.push(json!("extra"));
                    group.insert("required".to_owned(), Value::Array(names));
                }
            }
        }
        let error = validate_root(&wide, "/inputs").expect_err("1025 schemas");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
    }
}
