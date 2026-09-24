// SPDX-License-Identifier: Apache-2.0
//! Canonical content hashes for every portable artifact.
//!
//! This module implements the canonical hashing contract in
//! `contracts/v0/hashing.md`, which freezes RFC 8785 (JSON
//! Canonicalization Scheme) with the stated strictness. One Rust procedure
//! owns it. Wrappers call this module. They never compute a canonical form
//! or a hash on their own.
//!
//! Canonicalization serializes the parsed value, never the input spelling:
//!
//! - The output is UTF-8 text with no whitespace between tokens.
//! - Object members appear once, sorted by UTF-16 code unit order.
//! - Strings escape `\"`, `\\`, and every control character below U+0020.
//!   The short escapes `\b`, `\t`, `\n`, `\f`, and `\r` apply. Every other
//!   control character becomes `\u00xx` with lowercase hexadecimal digits.
//!   All other characters, including astral-plane characters, are literal.
//! - Numbers serialize by the ECMAScript `Number::toString` algorithm, as
//!   RFC 8785 section 3.2.2.6 specifies. A zero fractional part below 2^53
//!   serializes as a plain integer. Integers above 2^53 round to their
//!   binary64 value, and negative zero canonicalizes as `0`.
//! - Arrays keep their written order. Scale order and candidate-grid order
//!   carry meaning. Set-like arrays keep their written order too, the
//!   deliberate strictness of the contract.
//!
//! A digest is `SHA-256( tag_utf8 || 0x00 || canonical_utf8 )`, written as
//! 64 lowercase hexadecimal characters. The tag keeps artifacts with equal
//! content from sharing one hash across kinds.
//!
//! Canonicalize only values that passed the strict JSON gate
//! ([`crate::json::parse_strict`]) or one contract parser, and hash only
//! validated content. The hash of invalid content is undefined and never
//! published. External text must not reach [`canonical_form`] directly.

use crate::definition::ValidatedDefinition;
use crate::error::{ReasonCode, ValidationError};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fmt;

/// The one field that the contracts hash with its own value removed, as the
/// self-hash rule of `contracts/v0/hashing.md` states.
const SELF_HASH_FIELD: &str = "content_hash";

/// The materialized value of an omitted `when_uncertain`, the one documented
/// default of the contracts.
const WHEN_UNCERTAIN_DEFAULT: &str = "review";

/// The field that holds the uncertainty behavior of a definition.
const WHEN_UNCERTAIN_FIELD: &str = "when_uncertain";

/// A hash domain from `contracts/v0/hashing.md`.
///
/// A domain names the boundary of one hashed value and the tag of its
/// digest. Domains keep artifacts with equal content from sharing one hash
/// across kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Domain {
    /// The complete validated definition artifact.
    Definition,
    /// The case `input` object alone.
    Input,
    /// One complete translated question value.
    Translation,
    /// The complete profile artifact with its own content hash removed.
    Profile,
    /// The complete calibration plan with its own content hash removed.
    Plan,
    /// The complete case records as one array, ordered by case identifier.
    Dataset,
    /// The records of one split as one array, ordered by case identifier.
    Split,
}

impl Domain {
    /// Returns the domain tag, the first input of the digest formula.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Definition => "definition",
            Self::Input => "input",
            Self::Translation => "translation",
            Self::Profile => "profile",
            Self::Plan => "plan",
            Self::Dataset => "dataset",
            Self::Split => "split",
        }
    }

    /// Returns the domain of one tag, or `None` for any other text.
    pub fn from_tag(tag: &str) -> Option<Self> {
        match tag {
            "definition" => Some(Self::Definition),
            "input" => Some(Self::Input),
            "translation" => Some(Self::Translation),
            "profile" => Some(Self::Profile),
            "plan" => Some(Self::Plan),
            "dataset" => Some(Self::Dataset),
            "split" => Some(Self::Split),
            _ => None,
        }
    }
}

impl fmt::Display for Domain {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Builds the canonical form of one JSON value.
///
/// Two values with one parsed meaning produce one canonical form, whatever
/// their formatting, key order, or number spelling was. Array order stays.
/// The caller passes only values that passed the strict gate or one contract
/// parser.
pub fn canonical_form(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

/// Computes the content hash of one value in one domain.
///
/// The result is the SHA-256 of the domain tag, one zero byte, and the
/// canonical form, written as 64 lowercase hexadecimal characters.
pub fn content_hash(domain: Domain, value: &Value) -> String {
    let canonical = canonical_form(value);
    digest(domain, &canonical)
}

/// Computes the digest of one canonical text in one domain.
///
/// Use this only with a canonical form that this module produced. The
/// formula is `SHA-256( tag_utf8 || 0x00 || canonical_utf8 )`.
pub fn digest(domain: Domain, canonical: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_str().as_bytes());
    hasher.update([0]);
    hasher.update(canonical.as_bytes());
    let finished = hasher.finalize();
    let mut hex = String::with_capacity(finished.len() * 2);
    for byte in finished {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Builds the canonical form of one validated definition.
///
/// The definition boundary materializes the one documented default: an
/// omitted `when_uncertain` canonicalizes as `"review"`. A definition that
/// omits the field and a definition that states it produce one canonical
/// form and one hash. Every other omitted field stays absent.
pub fn definition_canonical_form(definition: &ValidatedDefinition) -> String {
    canonical_form(&definition_with_default(definition))
}

/// Computes the definition-domain content hash of one validated definition.
pub fn definition_hash(definition: &ValidatedDefinition) -> String {
    content_hash(Domain::Definition, &definition_with_default(definition))
}

/// Computes the input-domain content hash of one case input object.
///
/// The boundary covers the complete input object, including inputs that no
/// check reads. The case identifier, labels, and expected outcomes stay
/// outside. Pass the input of one validated case.
pub fn input_hash(input: &Map<String, Value>) -> String {
    let mut canonical = String::new();
    write_object(input, None, &mut canonical);
    digest(Domain::Input, &canonical)
}

/// Computes the self-hash of one profile or plan artifact.
///
/// The canonical form covers the complete artifact with its own
/// `content_hash` field removed. The field is removed, never read, so the
/// same function serves the generator, which holds the artifact without the
/// field. The generator validates every other field first, then inserts the
/// returned digest. Key sorting makes the insertion position irrelevant.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the artifact is not an object.
pub fn compute_self_hash(domain: Domain, artifact: &Value) -> Result<String, ValidationError> {
    let map = artifact.as_object().ok_or_else(|| {
        ValidationError::invalid_field_type("", "The artifact must be one object.")
    })?;
    let mut canonical = String::new();
    write_object(map, Some(SELF_HASH_FIELD), &mut canonical);
    Ok(digest(domain, &canonical))
}

/// Verifies the stored self-hash of one profile or plan artifact.
///
/// A reader removes the field, canonicalizes, computes the digest, and
/// compares. A stored value that differs from the computed digest fails
/// with `hash_mismatch`. The artifact is an edited or corrupted copy.
///
/// # Errors
///
/// Returns a [`ValidationError`] when the artifact is not an object, when
/// `content_hash` is absent or malformed, or when the stored value differs
/// from the computed digest.
pub fn verify_self_hash(domain: Domain, artifact: &Value) -> Result<(), ValidationError> {
    let map = artifact.as_object().ok_or_else(|| {
        ValidationError::invalid_field_type("", "The artifact must be one object.")
    })?;
    let Some(stored) = map.get(SELF_HASH_FIELD) else {
        return Err(ValidationError::missing(format!("/{SELF_HASH_FIELD}")));
    };
    let Value::String(text) = stored else {
        return Err(ValidationError::invalid_field_type(
            format!("/{SELF_HASH_FIELD}"),
            "The content_hash field must hold 64 lowercase hexadecimal characters.",
        ));
    };
    if !is_hash_hex(text) {
        return Err(ValidationError::invalid_field_type(
            format!("/{SELF_HASH_FIELD}"),
            "The content_hash field must hold 64 lowercase hexadecimal characters.",
        ));
    }
    let mut canonical = String::new();
    write_object(map, Some(SELF_HASH_FIELD), &mut canonical);
    if digest(domain, &canonical) == *text {
        Ok(())
    } else {
        Err(ValidationError::new(
            ReasonCode::HashMismatch,
            format!("/{SELF_HASH_FIELD}"),
            "The stored content hash differs from the computed digest.",
        ))
    }
}

/// Computes the dataset-domain content hash of one record set.
///
/// The boundary covers the complete case records as one array, ordered by
/// case identifier. Reordering the records does not change the hash. Each
/// record must be an object that holds a string `id`. The loader rejects
/// duplicate identifiers, so the order is total. Record fields are not
/// validated here; the record loader owns that contract.
///
/// # Errors
///
/// Returns a [`ValidationError`] when one record is not an object, when one
/// `id` is not a string, or when one identifier repeats.
pub fn dataset_hash(records: &[Value]) -> Result<String, ValidationError> {
    record_set_hash(Domain::Dataset, records)
}

/// Computes the split-domain content hash of one record set.
///
/// The boundary and the failures match [`dataset_hash`]. The split tag keeps
/// the same records from sharing one hash with the complete dataset.
///
/// # Errors
///
/// Returns a [`ValidationError`] when one record is not an object, when one
/// `id` is not a string, or when one identifier repeats.
pub fn split_hash(records: &[Value]) -> Result<String, ValidationError> {
    record_set_hash(Domain::Split, records)
}

/// Hashes one record set in one domain, ordered by case identifier.
fn record_set_hash(domain: Domain, records: &[Value]) -> Result<String, ValidationError> {
    let mut ordered: Vec<(&str, &Map<String, Value>)> = Vec::with_capacity(records.len());
    for (index, record) in records.iter().enumerate() {
        let map = record.as_object().ok_or_else(|| {
            ValidationError::invalid_field_type(
                format!("/{index}"),
                "Every record must be one object.",
            )
        })?;
        let id = match map.get("id") {
            Some(Value::String(text)) => text.as_str(),
            _ => {
                return Err(ValidationError::invalid_field_type(
                    format!("/{index}/id"),
                    "Every record identifier must be a string.",
                ));
            }
        };
        if ordered.iter().any(|(seen, _)| *seen == id) {
            return Err(ValidationError::new(
                ReasonCode::DuplicateId,
                format!("/{index}/id"),
                format!(
                    "The record identifier {} repeats an earlier record.",
                    crate::error::fragment(id)
                ),
            ));
        }
        ordered.push((id, map));
    }
    ordered.sort_by(|left, right| utf16_cmp(left.0, right.0));
    let mut canonical = String::new();
    canonical.push('[');
    for (index, (_, record)) in ordered.iter().enumerate() {
        if index > 0 {
            canonical.push(',');
        }
        write_object(record, None, &mut canonical);
    }
    canonical.push(']');
    Ok(digest(domain, &canonical))
}

/// Serializes one definition with the documented default materialized.
fn definition_with_default(definition: &ValidatedDefinition) -> Value {
    let mut value =
        serde_json::to_value(definition.as_definition()).expect("a definition serializes");
    let map = value
        .as_object_mut()
        .expect("a definition serializes to an object");
    map.insert(
        WHEN_UNCERTAIN_FIELD.to_owned(),
        Value::String(WHEN_UNCERTAIN_DEFAULT.to_owned()),
    );
    value
}

/// Writes the canonical form of one value.
fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(number, out),
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => write_object(map, None, out),
    }
}

/// Writes one object with sorted keys. `skip` names one excluded field, the
/// self-hash rule, or `None` for the complete object.
fn write_object(map: &Map<String, Value>, skip: Option<&str>, out: &mut String) {
    let mut entries: Vec<(&String, &Value)> = map
        .iter()
        .filter(|(key, _)| Some(key.as_str()) != skip)
        .collect();
    entries.sort_by(|left, right| utf16_cmp(left.0, right.0));
    out.push('{');
    for (index, (key, value)) in entries.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_string(key, out);
        out.push(':');
        write_value(value, out);
    }
    out.push('}');
}

/// Writes one string with the canonical escapes.
fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{0009}' => out.push_str("\\t"),
            '\u{000A}' => out.push_str("\\n"),
            '\u{000C}' => out.push_str("\\f"),
            '\u{000D}' => out.push_str("\\r"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            literal => out.push(literal),
        }
    }
    out.push('"');
}

/// Writes one number in the ECMAScript `Number::toString` form.
///
/// A JSON number in a `Value` is finite, so the conversion always succeeds.
/// Integers above 2^53 round to their binary64 value, as RFC 8785 requires:
/// canonicalization serializes the parsed value, and a binary64 value cannot
/// hold every integer above that bound.
fn write_number(number: &Number, out: &mut String) {
    let value = number.as_f64().expect("a JSON number is finite");
    if value == 0.0 {
        // Negative zero canonicalizes as 0. The sign of zero never reaches
        // a hash.
        out.push('0');
        return;
    }
    let mut text = String::new();
    if value.is_sign_negative() {
        text.push('-');
    }
    // Rust's LowerExp formatting gives the shortest digit sequence that
    // round-trips, in scientific form. The ECMAScript algorithm below needs
    // exactly those digits and their exponent.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent_text) = scientific
        .split_once('e')
        .expect("LowerExp holds an exponent");
    let exponent: i32 = exponent_text.parse().expect("an exponent in range");
    let digits: String = mantissa
        .chars()
        .filter(|character| *character != '.')
        .collect();
    // The decimal point sits after `n` digits: value = 0.digits × 10^n.
    let n = exponent + 1;
    let k = digits.len() as i32;
    // ECMAScript prints decimal notation while `-6 < n <= 21` holds.
    if (-5..=21).contains(&n) {
        if k <= n {
            text.push_str(&digits);
            for _ in 0..(n - k) {
                text.push('0');
            }
        } else if n > 0 {
            text.push_str(&digits[..n as usize]);
            text.push('.');
            text.push_str(&digits[n as usize..]);
        } else {
            text.push_str("0.");
            for _ in 0..(-n) {
                text.push('0');
            }
            text.push_str(&digits);
        }
    } else {
        text.push_str(&digits[..1]);
        if k > 1 {
            text.push('.');
            text.push_str(&digits[1..]);
        }
        text.push('e');
        let adjusted = n - 1;
        if adjusted < 0 {
            text.push('-');
        } else {
            text.push('+');
        }
        text.push_str(&adjusted.unsigned_abs().to_string());
    }
    out.push_str(&text);
}

/// Compares two strings by UTF-16 code unit order, the RFC 8785 key order.
///
/// UTF-8 byte order and UTF-16 code unit order differ for keys that hold
/// astral-plane characters beside characters from U+E000 to U+FFFF. The
/// canonical form follows the UTF-16 rule, and record arrays order by the
/// same rule.
fn utf16_cmp(left: &str, right: &str) -> Ordering {
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

/// Checks the content-hash rule of `common.schema.json`: 64 lowercase
/// hexadecimal characters.
fn is_hash_hex(text: &str) -> bool {
    text.len() == 64
        && text
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::SplitMix64;
    use serde_json::json;

    /// Parses one JSON text through the strict gate.
    fn parsed(text: &str) -> Value {
        crate::json::parse_strict(text).expect("the test text is strict JSON")
    }

    /// One validated definition, with `when_uncertain` stated or omitted.
    fn validated_definition(when_uncertain: Option<&str>) -> ValidatedDefinition {
        let mut artifact = json!({
            "schema_version": 1,
            "name": "memory-supported",
            "inputs": {
                "type": "object",
                "properties": {"text": {"type": "string", "minLength": 1}},
                "required": ["text"],
                "additionalProperties": false
            },
            "checks": [{
                "id": "text-length",
                "name": "The memory fits the length limit",
                "using": ["text"],
                "rule": {"maxLength": 10}
            }]
        });
        if let Some(value) = when_uncertain {
            artifact["when_uncertain"] = json!(value);
        }
        crate::definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates")
    }

    #[test]
    fn the_worked_examples_match_the_published_digests() {
        // Both digests appear in contracts/v0/hashing.md and reproduce with
        // sha256sum over the tag, one zero byte, and the canonical text.
        let input = parsed(r#"{"proposed_message": "Hello, EU export!"}"#);
        assert_eq!(
            content_hash(Domain::Input, &input),
            "ebf29f3107f775b64d775c4acbe22d2ba495509039f10f93fb7a6b460547b558"
        );
        assert_eq!(
            definition_hash(&validated_definition(None)),
            "2a9b1c7f4537bd4248a7c89ec1aae104b2cc92aad8c285a0b3ae9b9b17d83df6"
        );
    }

    #[test]
    fn numbers_canonicalize_by_the_ecmascript_algorithm() {
        let cases = [
            ("0", "0"),
            ("-0", "0"),
            ("1.0", "1"),
            ("-0.0", "0"),
            ("0.5", "0.5"),
            ("900", "900"),
            ("-42.75", "-42.75"),
            ("100", "100"),
            ("1e-6", "0.000001"),
            ("1e-7", "1e-7"),
            ("1e-27", "1e-27"),
            ("1e20", "100000000000000000000"),
            ("1e21", "1e+21"),
            ("1e22", "1e+22"),
            ("9007199254740991", "9007199254740991"),
            // 2^53 plus one rounds to its binary64 value, as RFC 8785 records.
            ("9007199254740993", "9007199254740992"),
            ("5e-324", "5e-324"),
            ("1.7976931348623157e308", "1.7976931348623157e+308"),
            ("123456789012345678901234567890", "1.2345678901234568e+29"),
            ("0.1", "0.1"),
            ("3.141592653589793", "3.141592653589793"),
            // The values below parse one unit in the last place away from
            // the binary64 value without the serde_json `float_roundtrip`
            // feature. Their canonical forms pin that feature: a default
            // parser that rounds differently changes hashes. ECMAScript and
            // Node agree with these forms.
            ("-1.602176634e-19", "-1.602176634e-19"),
            ("7.87732350919411e-178", "7.87732350919411e-178"),
            ("1.0858219721122314e98", "1.0858219721122314e+98"),
        ];
        for (text, expected) in cases {
            assert_eq!(canonical_form(&parsed(text)), expected, "parsed {text}");
        }
    }

    #[test]
    fn strings_escape_only_the_required_characters() {
        let cases = [
            (r#""text""#, "\"text\""),
            (r#""a\"b""#, "\"a\\\"b\""),
            (r#""a\\b""#, "\"a\\\\b\""),
            (r#""a\u0000b""#, "\"a\\u0000b\""),
            (r#""a\u001fb""#, "\"a\\u001fb\""),
            (r#""\b\t\n\f\r""#, "\"\\b\\t\\n\\f\\r\""),
            ("\"café\"", "\"café\""),
            ("\"cafe\\u0301\"", "\"cafe\u{301}\""),
            ("\"😀\"", "\"😀\""),
            ("\"a😀b\"", "\"a😀b\""),
            ("\"\\u007f\"", "\"\u{7f}\""),
        ];
        for (text, expected) in cases {
            assert_eq!(canonical_form(&parsed(text)), expected, "parsed {text}");
        }
    }

    #[test]
    fn object_keys_sort_by_utf16_code_unit_order() {
        // U+FFFD sorts after the surrogate pair of U+10000 in UTF-16 order,
        // but before it in UTF-8 byte order. The canonical form follows the
        // UTF-16 rule.
        let value = json!({"\u{fffd}": 1, "😀": 2});
        assert_eq!(canonical_form(&value), "{\"😀\":2,\"\u{fffd}\":1}");
        // Plain ASCII keys sort by code unit, as byte order does.
        let value = json!({"b": 1, "a": 2, "B": 3});
        assert_eq!(canonical_form(&value), "{\"B\":3,\"a\":2,\"b\":1}");
    }

    #[test]
    fn arrays_keep_their_written_order() {
        let value = parsed("[3,1,2]");
        assert_eq!(canonical_form(&value), "[3,1,2]");
        let scale = json!([{"minor": "First."}, {"serious": "Second."}]);
        assert_eq!(
            canonical_form(&scale),
            "[{\"minor\":\"First.\"},{\"serious\":\"Second.\"}]"
        );
    }

    #[test]
    fn formatting_and_key_order_never_change_a_hash() {
        let left = parsed("{\n  \"b\" : 1,\n  \"a\": 2.0\n}");
        let right = parsed("{\"a\":2,\"b\":1}");
        assert_eq!(canonical_form(&left), "{\"a\":2,\"b\":1}");
        assert_eq!(
            content_hash(Domain::Input, &left),
            content_hash(Domain::Input, &right)
        );
    }

    #[test]
    fn literals_and_nesting_canonicalize() {
        let value = parsed("{\"outer\":{\"leaf\":null},\"flag\":true,\"off\":false,\"list\":[]}");
        assert_eq!(
            canonical_form(&value),
            "{\"flag\":true,\"list\":[],\"off\":false,\"outer\":{\"leaf\":null}}"
        );
        assert_eq!(canonical_form(&Value::Null), "null");
        assert_eq!(canonical_form(&parsed(" true ")), "true");
    }

    #[test]
    fn every_domain_uses_its_tag_and_no_other() {
        for domain in [
            Domain::Definition,
            Domain::Input,
            Domain::Translation,
            Domain::Profile,
            Domain::Plan,
            Domain::Dataset,
            Domain::Split,
        ] {
            assert_eq!(Domain::from_tag(domain.as_str()), Some(domain));
            assert_eq!(domain.to_string(), domain.as_str());
        }
        assert_eq!(Domain::from_tag("case"), None);
        assert_eq!(Domain::from_tag(""), None);
        // Equal content under different tags gives different digests.
        let value = parsed("{\"text\":\"a\"}");
        let hashes: Vec<String> = [
            Domain::Definition,
            Domain::Input,
            Domain::Translation,
            Domain::Profile,
            Domain::Plan,
            Domain::Dataset,
            Domain::Split,
        ]
        .iter()
        .map(|domain| content_hash(*domain, &value))
        .collect();
        let unique: std::collections::BTreeSet<&String> = hashes.iter().collect();
        assert_eq!(unique.len(), hashes.len(), "two domains share one digest");
    }

    #[test]
    fn the_definition_domain_materializes_the_documented_default() {
        let omitted = validated_definition(None);
        let stated = validated_definition(Some("review"));
        let canonical = definition_canonical_form(&omitted);
        assert!(
            canonical.contains("\"when_uncertain\":\"review\""),
            "the canonical form materializes the default: {canonical}"
        );
        assert_eq!(canonical, definition_canonical_form(&stated));
        assert_eq!(definition_hash(&omitted), definition_hash(&stated));

        // A different uncertainty behavior is not expressible in v0, so a
        // changed question wording instead shows that content binds the hash.
        // The generic value hash differs from the definition-domain hash,
        // because only the materialized form is hashed in that domain.
        let raw = serde_json::to_value(omitted.as_definition()).expect("serializes");
        assert_ne!(
            definition_hash(&omitted),
            content_hash(Domain::Definition, &raw)
        );
    }

    #[test]
    fn the_input_hash_covers_the_complete_input_object() {
        let input = parsed("{\"prior_decision\":\"EU.\",\"conversation\":\"Move to US.\"}")
            .as_object()
            .expect("an object")
            .clone();
        let hash = input_hash(&input);
        assert_eq!(
            hash,
            content_hash(Domain::Input, &Value::Object(input.clone()))
        );
        // A change to any declared input makes a changed case, and the
        // digest changes with it.
        let mut changed = input.clone();
        changed.insert("conversation".to_owned(), json!("Move later."));
        assert_ne!(input_hash(&changed), hash);
        let mut removed = input.clone();
        removed.remove("prior_decision");
        assert_ne!(input_hash(&removed), hash);
    }

    #[test]
    fn a_self_hash_computes_and_verifies() {
        let artifact = json!({
            "schema_version": 1,
            "id": "delivery-limits-exact",
            "origin": "exact",
            "policy": {"family": "exact"}
        });
        let computed = compute_self_hash(Domain::Profile, &artifact).expect("the artifact hashes");
        let mut stored = artifact.clone();
        stored["content_hash"] = json!(computed);
        assert_eq!(
            compute_self_hash(Domain::Profile, &stored).expect("the field is removed"),
            computed,
            "the stored field never changes the digest"
        );
        assert!(verify_self_hash(Domain::Profile, &stored).is_ok());

        // A stored value that differs fails with hash_mismatch.
        let mut tampered = stored.clone();
        tampered["origin"] = json!("calibration");
        let error = verify_self_hash(Domain::Profile, &tampered)
            .expect_err("the edited copy fails verification");
        assert_eq!(error.code, ReasonCode::HashMismatch);
        assert_eq!(error.field_path, "/content_hash");

        // A wrong stored value fails the same way.
        let mut wrong = stored.clone();
        wrong["content_hash"] = json!("0".repeat(64));
        let error = verify_self_hash(Domain::Profile, &wrong).expect_err("the wrong digest fails");
        assert_eq!(error.code, ReasonCode::HashMismatch);

        // Absent, malformed, and non-string fields fail before the digest.
        let error =
            verify_self_hash(Domain::Profile, &artifact).expect_err("the absent field fails");
        assert_eq!(error.code, ReasonCode::MissingField);
        assert_eq!(error.field_path, "/content_hash");
        for bad in [
            json!(""),
            json!("ABC"),
            json!("z".repeat(64)),
            json!(64),
            json!(null),
        ] {
            let mut malformed = stored.clone();
            malformed["content_hash"] = bad.clone();
            let error = verify_self_hash(Domain::Profile, &malformed)
                .err()
                .unwrap_or_else(|| panic!("{bad}: the malformed field was accepted"));
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{bad}: {error}");
        }
        let error = verify_self_hash(Domain::Profile, &json!([1]))
            .expect_err("a non-object artifact fails");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
        assert_eq!(error.field_path, "");
        let error = compute_self_hash(Domain::Plan, &json!("text"))
            .expect_err("a non-object artifact fails");
        assert_eq!(error.code, ReasonCode::InvalidFieldType);
    }

    #[test]
    fn record_sets_order_by_case_identifier() {
        let later = json!({
            "id": "z-late",
            "input": {"text": "The later record in file order."}
        });
        let early = json!({
            "id": "a-early",
            "input": {"text": "The earlier record in identifier order."}
        });
        let middle = json!({
            "id": "m-middle",
            "group": "standard",
            "input": {"text": "The middle record."}
        });
        let hash = dataset_hash(&[later.clone(), early.clone(), middle.clone()])
            .expect("the records hash");
        // Any file order gives one dataset hash.
        let ordered = [early.clone(), middle.clone(), later.clone()];
        assert_eq!(dataset_hash(&ordered).expect("the records hash"), hash);

        // The canonical array orders by identifier, in UTF-16 order.
        let canonical = canonical_form(&Value::Array(ordered.to_vec()));
        assert_eq!(hash, digest(Domain::Dataset, &canonical));

        // A seeded shuffle keeps the hash, and the split tag separates the
        // same records from the dataset domain.
        let mut shuffled = [later, early, middle];
        SplitMix64::seeded(7).shuffle(&mut shuffled);
        assert_eq!(dataset_hash(&shuffled).expect("the records hash"), hash);
        assert_ne!(split_hash(&shuffled).expect("the records hash"), hash);

        // An empty record set hashes the empty array.
        assert_eq!(
            dataset_hash(&[]).expect("the empty set hashes"),
            digest(Domain::Dataset, "[]")
        );
    }

    #[test]
    fn record_set_failures_carry_their_pointers() {
        let good = json!({"id": "case-1", "input": {}});
        for (records, path, code) in [
            (
                vec![good.clone(), json!({"id": "case-1", "input": {}})],
                "/1/id",
                ReasonCode::DuplicateId,
            ),
            (
                vec![json!({"input": {}})],
                "/0/id",
                ReasonCode::InvalidFieldType,
            ),
            (
                vec![json!({"id": 7})],
                "/0/id",
                ReasonCode::InvalidFieldType,
            ),
            (vec![json!("record")], "/0", ReasonCode::InvalidFieldType),
        ] {
            let error = dataset_hash(&records)
                .err()
                .unwrap_or_else(|| panic!("{path}: the records were accepted"));
            assert_eq!(error.code, code, "{path}: {error}");
            assert_eq!(error.field_path, path, "{path}: {error}");
            assert!(!error.message.is_empty());
            assert!(split_hash(&records).is_err(), "the split domain agrees");
        }
    }
}
