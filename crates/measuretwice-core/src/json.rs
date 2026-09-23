// SPDX-License-Identifier: Apache-2.0
//! Strict JSON gate for external artifact text.
//!
//! Every artifact enters the core as text or bytes through this module. The
//! gate rejects four classes of bad input before any contract parser runs:
//!
//! - Text that is not JSON, with reason code `invalid_json`.
//! - An object that repeats one key, with `invalid_json`. Two readers could
//!   keep different members, so no downstream value is defined.
//! - A number that is not finite, with `invalid_field_type`, as the hashing
//!   contract requires.
//! - A string with an unpaired surrogate code point, with
//!   `nonportable_value`. Canonical UTF-8 text cannot carry it.
//!
//! The gate also bounds one document. A document above [`MAX_JSON_BYTES`] or
//! deeper than [`MAX_JSON_DEPTH`] is rejected with `invalid_json`. Nothing is
//! truncated. The published input limits in `contracts/v0/input-schema.md`
//! stay far below these document bounds.
//!
//! The gate never mutates data, never coerces a type, and never applies a
//! default. Validation passes or fails.

use crate::error::{fragment, ReasonCode, ValidationError};
use serde::de::{self, DeserializeSeed, Visitor};
use serde_json::{Deserializer, Map, Value};
use std::fmt;

/// Size bound for one artifact document, in bytes.
pub const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;

/// Nesting bound for one artifact document. The root sits at depth 0.
pub const MAX_JSON_DEPTH: usize = 64;

/// Marker text for a repeated object key.
const DUPLICATE_KEY: &str = "the object repeats one key";
/// Marker text for a non-finite number.
const NOT_FINITE: &str = "the number is not finite";
/// Marker text for a document that nests too deeply.
const TOO_DEEP: &str = "the document nests too deeply";

/// Parses one JSON document strictly, with the default bounds.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the text is malformed, repeats an
/// object key, holds a non-finite number, holds an unpaired surrogate, or
/// breaks a document bound.
pub fn parse_strict(text: &str) -> Result<Value, ValidationError> {
    parse_with_bounds(text, MAX_JSON_BYTES, MAX_JSON_DEPTH)
}

/// Parses JSON bytes strictly. The bytes must be valid UTF-8.
///
/// # Errors
///
/// Returns `invalid_json` when the bytes are not valid UTF-8, in addition to
/// the failures of [`parse_strict`].
pub fn parse_bytes_strict(bytes: &[u8]) -> Result<Value, ValidationError> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        ValidationError::new(
            ReasonCode::InvalidJson,
            "",
            "The bytes are not valid UTF-8.",
        )
    })?;
    parse_strict(text)
}

fn parse_with_bounds(
    text: &str,
    max_bytes: usize,
    max_depth: usize,
) -> Result<Value, ValidationError> {
    if text.len() > max_bytes {
        return Err(ValidationError::new(
            ReasonCode::InvalidJson,
            "",
            format!("The document is larger than {max_bytes} bytes."),
        ));
    }
    let mut deserializer = Deserializer::from_str(text);
    let seed = StrictVisitor {
        depth: 0,
        max_depth,
    };
    let value = seed
        .deserialize(&mut deserializer)
        .map_err(|error| classify(&error))?;
    deserializer.end().map_err(|error| classify(&error))?;
    Ok(value)
}

/// Maps one `serde_json` failure to a stable reason code.
///
/// The pinned `serde_json` version words its failures as follows, and the
/// conformance fixtures cover every row of this mapping. A dependency bump
/// that changes a wording fails those fixtures, so the mapping cannot drift
/// silently.
///
/// - `number out of range`: the text holds a number beyond the finite range.
/// - `lone leading surrogate in hex escape` and
///   `unexpected end of hex escape`: a `\u` escape names an unpaired
///   surrogate. Truncated or invalid hex digits report other messages.
/// - Any other message: the text is not JSON.
fn classify(error: &serde_json::Error) -> ValidationError {
    let text = error.to_string();
    let (code, cause) = if text.contains(NOT_FINITE) || text.contains("number out of range") {
        (ReasonCode::InvalidFieldType, "The number is not finite.")
    } else if text.contains("surrogate") || text.contains("unexpected end of hex escape") {
        (
            ReasonCode::NonportableValue,
            "The string holds an unpaired surrogate code point.",
        )
    } else if text.contains(DUPLICATE_KEY) {
        (ReasonCode::InvalidJson, "The object repeats one key.")
    } else if text.contains(TOO_DEEP) {
        (
            ReasonCode::InvalidJson,
            "The document nests deeper than the limit.",
        )
    } else {
        (ReasonCode::InvalidJson, "The text is not valid JSON.")
    };
    let message = if error.line() == 0 && error.column() == 0 {
        cause.to_owned()
    } else {
        format!(
            "{cause} At line {} column {}.",
            error.line(),
            error.column()
        )
    };
    ValidationError::new(code, "", message)
}

/// A visitor that rejects repeated keys, non-finite numbers, and deep nesting.
struct StrictVisitor {
    depth: usize,
    max_depth: usize,
}

impl StrictVisitor {
    /// The visitor for one nested container.
    fn child(&self) -> Self {
        Self {
            depth: self.depth + 1,
            max_depth: self.max_depth,
        }
    }
}

impl<'de> DeserializeSeed<'de> for StrictVisitor {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
        Ok(Value::from(value))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
        Ok(Value::from(value))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        // JSON text cannot carry a non-finite number: the parser rejects the
        // literal first. This check keeps the promise for every caller.
        if value.is_finite() {
            Ok(Value::from(value))
        } else {
            Err(E::custom(NOT_FINITE))
        }
    }

    fn visit_str<E>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Value, A::Error>
    where
        A: de::SeqAccess<'de>,
    {
        if self.depth >= self.max_depth {
            return Err(de::Error::custom(TOO_DEEP));
        }
        let mut items = Vec::new();
        while let Some(item) = sequence.next_element_seed(self.child())? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Value, A::Error>
    where
        A: de::MapAccess<'de>,
    {
        if self.depth >= self.max_depth {
            return Err(de::Error::custom(TOO_DEEP));
        }
        let mut object = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if object.contains_key(&key) {
                let cause = format!("{DUPLICATE_KEY}: {}", fragment(&key));
                return Err(de::Error::custom(cause));
            }
            let value = map.next_value_seed(self.child())?;
            object.insert(key, value);
        }
        Ok(Value::Object(object))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_documents_parse_to_equal_values() {
        for text in [
            "{\"b\":1,\"a\":2}",
            "[1,2,3]",
            "\"text\"",
            "true",
            "null",
            "0.5",
            "-0",
            "1e+21",
            "\"café 😀\"",
        ] {
            let value = parse_strict(text).unwrap_or_else(|error| panic!("{text}: {error}"));
            let again: Value = serde_json::from_str(text).expect("serde_json agrees");
            assert_eq!(value, again, "{text}");
        }
    }

    #[test]
    fn malformed_text_is_rejected_as_invalid_json() {
        for text in [
            "",
            "{",
            "[1,2",
            "{} {}",
            "{\"a\":1} tail",
            "NaN",
            "Infinity",
            "'x'",
        ] {
            let error = parse_strict(text)
                .err()
                .unwrap_or_else(|| panic!("{text} was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidJson, "{text}: {error}");
        }
    }

    #[test]
    fn repeated_keys_are_rejected_as_invalid_json() {
        let error = parse_strict("{\"text\":\"a\",\"text\":\"b\"}")
            .expect_err("the repeated key was accepted");
        assert_eq!(error.code, ReasonCode::InvalidJson);
        assert!(error.message.contains("repeats one key"), "{error}");
        // Nested repeats fail too.
        let nested = parse_strict("{\"outer\":{\"a\":1,\"a\":2}}")
            .expect_err("the nested repeat was accepted");
        assert_eq!(nested.code, ReasonCode::InvalidJson);
    }

    #[test]
    fn numbers_outside_the_finite_range_are_rejected() {
        for text in ["1e400", "-1e400"] {
            let error = parse_strict(text)
                .err()
                .unwrap_or_else(|| panic!("{text} was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{text}: {error}");
        }
    }

    #[test]
    fn unpaired_surrogates_are_rejected_as_nonportable() {
        for text in [
            r#""\ud800""#,
            r#""\udc00""#,
            r#""\ud800\ud800""#,
            r#"{"text":"\ud800"}"#,
        ] {
            let error = parse_strict(text)
                .err()
                .unwrap_or_else(|| panic!("{text} was accepted"));
            assert_eq!(error.code, ReasonCode::NonportableValue, "{text}: {error}");
        }
    }

    #[test]
    fn a_paired_surrogate_escape_stays_one_code_point() {
        let value = parse_strict(r#""😀""#).expect("the paired escape is valid");
        assert_eq!(value, Value::String("😀".to_owned()));
    }

    #[test]
    fn bytes_that_are_not_utf8_are_rejected() {
        let error = parse_bytes_strict(&[0xc3, 0x28]).expect_err("the bytes were accepted");
        assert_eq!(error.code, ReasonCode::InvalidJson);
        assert_eq!(error.field_path, "");
    }

    #[test]
    fn valid_utf8_bytes_parse_like_text() {
        let value = parse_bytes_strict(b"{\"a\":1}").expect("the bytes parse");
        assert_eq!(value["a"], 1);
    }

    #[test]
    fn documents_deeper_than_the_bound_are_rejected() {
        let deep = format!(
            "{}{}",
            "[".repeat(MAX_JSON_DEPTH + 1),
            "]".repeat(MAX_JSON_DEPTH + 1)
        );
        let error = parse_strict(&deep).expect_err("the deep document was accepted");
        assert_eq!(error.code, ReasonCode::InvalidJson);
        assert!(error.message.contains("nests"), "{error}");
        // A document at the bound itself parses.
        let at_bound = format!(
            "{}{}",
            "[".repeat(MAX_JSON_DEPTH),
            "]".repeat(MAX_JSON_DEPTH)
        );
        assert!(parse_strict(&at_bound).is_ok());
    }

    #[test]
    fn documents_above_the_size_bound_are_rejected() {
        let oversized = format!("{}1", " ".repeat(MAX_JSON_BYTES));
        assert_eq!(oversized.len(), MAX_JSON_BYTES + 1);
        let error = parse_strict(&oversized).expect_err("the large document was accepted");
        assert_eq!(error.code, ReasonCode::InvalidJson);
        assert!(error.message.contains("larger"), "{error}");
    }
}
