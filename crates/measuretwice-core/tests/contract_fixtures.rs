// SPDX-License-Identifier: Apache-2.0
//! Conformance runs of the shared fixtures through the Rust core.
//!
//! The fixtures in `fixtures/` pin the frozen contracts. These tests run the
//! groups that the parse boundary owns: the valid definition artifacts, the
//! structural definition rejections, and the hashing rejection records.
//! Later tasks add the remaining groups as their validation lands. The tests
//! read local files only, so they stay offline and deterministic.

use measuretwice_core::definition::{CheckKind, WhenUncertain};
use measuretwice_core::error::ReasonCode;
use measuretwice_core::{case, definition, json};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn fixture(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(relative)
}

fn fixture_document(relative: &str) -> Value {
    let text = fs::read_to_string(fixture(relative))
        .unwrap_or_else(|error| panic!("{}: {error}", relative));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{relative}: {error}"))
}

#[test]
fn every_valid_definition_parses_and_round_trips() {
    let directory = fixture("definitions/valid");
    let mut files: Vec<PathBuf> = fs::read_dir(&directory)
        .expect("the valid definition directory exists")
        .map(|entry| entry.expect("a directory entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    assert!(files.len() >= 6, "the fixture group lost files");

    for file in files {
        let text = fs::read_to_string(&file).expect("the fixture file reads");
        let parsed = definition::parse_definition_str(&text)
            .unwrap_or_else(|error| panic!("{}: {error}", file.display()));
        // A serialized domain value parses again and equals the source
        // artifact. Field presence and array order survive unchanged.
        let serialized = serde_json::to_value(&parsed).expect("the definition serializes");
        let parsed_again = definition::parse_definition(&serialized)
            .unwrap_or_else(|error| panic!("{} round trip: {error}", file.display()));
        let serialized_again =
            serde_json::to_value(&parsed_again).expect("the definition serializes");
        assert_eq!(serialized, serialized_again, "{}", file.display());
        let source: Value = serde_json::from_str(&text).expect("the fixture parses");
        assert_eq!(serialized, source, "{}", file.display());
    }
}

#[test]
fn the_ordered_scale_keeps_its_written_order() {
    let text = fs::read_to_string(fixture("definitions/valid/ordered-scale.json")).unwrap();
    let parsed = definition::parse_definition_str(&text).expect("the fixture is valid");
    let scale = parsed.checks[0]
        .scale
        .as_ref()
        .expect("the check holds a scale");
    let names: Vec<&str> = scale.iter().map(|level| level.name.as_str()).collect();
    assert_eq!(names, ["minor", "meaningful", "serious"]);
}

/// The reason codes that the definitions-invalid group covers, as the fixture
/// manifest states. Every record runs through parsing and definition
/// validation, so the core owns the whole group.
const DEFINITION_REJECTION_CODES: &[&str] = &[
    "duplicate_id",
    "unknown_input_name",
    "accept_review_overlap",
    "unknown_label",
    "invalid_scale",
    "empty_check_set",
    "unsupported_keyword",
    "unsupported_schema_version",
    "unknown_field",
    "missing_field",
    "invalid_field_type",
];

#[test]
fn definition_rejections_report_the_stated_codes_and_paths() {
    let document = fixture_document("definitions/invalid.json");
    let records = document["records"].as_array().expect("a record array");
    assert!(records.len() >= 20, "the fixture group lost records");

    let mut covered: BTreeSet<&str> = BTreeSet::new();
    for record in records {
        let note = record["note"].as_str().expect("a note");
        let expected = &record["expected"];
        let code = expected["reason_code"].as_str().expect("a code");
        let path = expected["field_path"].as_str().expect("a path");
        covered.insert(code);
        let text = serde_json::to_string(&record["raw"]).expect("the raw artifact serializes");
        let error = definition::validate_definition_str(&text)
            .err()
            .unwrap_or_else(|| panic!("{note}: the artifact was accepted"));
        assert_eq!(error.code.as_str(), code, "{note}: {error}");
        assert_eq!(error.field_path, path, "{note}: {error}");
        assert!(!error.message.is_empty(), "{note}: the cause is empty");
    }
    for code in DEFINITION_REJECTION_CODES {
        assert!(covered.contains(code), "no fixture record covers {code}");
    }
}

/// Every valid artifact, its check kinds, and the one documented default.
const VALID_KINDS: &[(&str, &[CheckKind])] = &[
    ("all-input-types", &[CheckKind::Binary, CheckKind::Rule]),
    ("binary-question", &[CheckKind::Binary]),
    ("categorical-question", &[CheckKind::Categorical]),
    (
        "exact-rules",
        &[CheckKind::Rule, CheckKind::Rule, CheckKind::Rule],
    ),
    ("memory-length", &[CheckKind::Rule]),
    ("memory-length-explicit", &[CheckKind::Rule]),
    ("ordered-scale", &[CheckKind::Ordered]),
];

#[test]
fn every_valid_definition_validates_with_its_stated_kinds() {
    assert!(VALID_KINDS.len() >= 6, "the expectation table lost files");
    let mut exact_only_seen = false;
    for (stem, kinds) in VALID_KINDS {
        let path = fixture(&format!("definitions/valid/{stem}.json"));
        let text = fs::read_to_string(&path).expect("the fixture file reads");
        let validated = definition::validate_definition_str(&text)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        assert_eq!(validated.check_kinds(), *kinds, "{stem}");
        // The one documented default: an omitted when_uncertain means review.
        assert_eq!(
            validated.effective_when_uncertain(),
            WhenUncertain::Review,
            "{stem}"
        );
        // The validated value still serializes to the source artifact.
        let source: Value = serde_json::from_str(&text).expect("the fixture parses");
        let serialized = serde_json::to_value(&validated).expect("the definition serializes");
        assert_eq!(serialized, source, "{stem}");
        exact_only_seen |= validated.is_exact_only();
    }
    assert!(exact_only_seen, "no fixture covers an exact-only set");

    // The memory pair validates on both sides of the when_uncertain default.
    let omitted = definition::validate_definition_str(
        &fs::read_to_string(fixture("definitions/valid/memory-length.json")).unwrap(),
    )
    .expect("the omitted side validates");
    let stated = definition::validate_definition_str(
        &fs::read_to_string(fixture("definitions/valid/memory-length-explicit.json")).unwrap(),
    )
    .expect("the stated side validates");
    assert_eq!(
        omitted.effective_when_uncertain(),
        stated.effective_when_uncertain()
    );
    assert_eq!(omitted.check_kinds(), stated.check_kinds());
}

/// Builds one minimal validated definition that declares the given root
/// input schema, so each input record runs through the complete case path.
/// The probe check names the first declared input, whatever its type is.
fn definition_for_inputs(inputs: &Value) -> measuretwice_core::definition::ValidatedDefinition {
    let first = inputs["properties"]
        .as_object()
        .expect("declared properties")
        .keys()
        .next()
        .cloned()
        .expect("one declared input");
    let artifact = serde_json::json!({
        "schema_version": 1,
        "name": "input-validation",
        "inputs": inputs,
        "checks": [{
            "id": "probe",
            "name": "The probe check",
            "using": [first],
            "question": "Does the input satisfy the record?",
            "answers": {"yes": "It does.", "no": "It does not."}
        }]
    });
    definition::validate_definition_str(&artifact.to_string())
        .expect("the probe definition validates")
}

/// Materializes one oversized input object from its fixture description, as
/// the record note states. The described value becomes the single declared
/// input of the record schema.
fn materialize_oversized(record: &Value) -> Value {
    let name = record["inputs"]["properties"]
        .as_object()
        .expect("declared properties")
        .keys()
        .next()
        .cloned()
        .expect("one declared input");
    let oversized = &record["oversized"];
    let value = match oversized["kind"].as_str().expect("a kind") {
        "string" => {
            let fill = oversized["fill"].as_str().expect("a fill character");
            let bytes = oversized["utf8_bytes"].as_u64().expect("a byte count") as usize;
            let text = fill.repeat(bytes / fill.len());
            assert_eq!(
                text.len(),
                bytes,
                "the materialized string matches the stated size"
            );
            Value::String(text)
        }
        "array" => {
            let fill = oversized["fill"].as_str().expect("a fill value");
            let count = oversized["items"].as_u64().expect("an item count") as usize;
            Value::Array(vec![Value::String(fill.to_owned()); count])
        }
        other => panic!("an unknown oversized kind: {other}"),
    };
    serde_json::json!({ name.clone(): value })
}

#[test]
fn input_validation_records_report_the_stated_codes_and_paths() {
    let document = fixture_document("inputs/validation.json");
    let records = document["records"].as_array().expect("a record array");
    assert!(records.len() >= 20, "the fixture group lost records");

    let mut oversized_seen = false;
    for record in records {
        let note = record["note"].as_str().expect("a note");
        let definition = definition_for_inputs(&record["inputs"]);
        let input = record
            .get("input")
            .cloned()
            .unwrap_or_else(|| materialize_oversized(record));
        let case_text = serde_json::to_string(&serde_json::json!({
            "id": "input-validation",
            "input": input
        }))
        .expect("the case serializes");
        let result = case::validate_case_str(&case_text, &definition);
        if record["valid"].as_bool() == Some(true) {
            let validated = result.unwrap_or_else(|error| panic!("{note}: {error}"));
            assert_eq!(validated.id(), "input-validation");
            // The probe projection holds only its declared input.
            let projected = validated.projected_inputs();
            assert_eq!(projected.len(), 1, "{note}");
            assert_eq!(projected[0].check_id, "probe", "{note}");
            assert_eq!(projected[0].inputs.len(), 1, "{note}");
        } else {
            let error = result
                .err()
                .unwrap_or_else(|| panic!("{note}: the input was accepted"));
            let expected = &record["expected"];
            assert_eq!(
                error.code.as_str(),
                expected["reason_code"].as_str().expect("a code"),
                "{note}: {error}"
            );
            assert_eq!(
                error.field_path,
                expected["field_path"].as_str().expect("a path"),
                "{note}: {error}"
            );
            assert!(!error.message.is_empty(), "{note}: the cause is empty");
            oversized_seen |= error.code == ReasonCode::OversizedInput;
        }
    }
    assert!(oversized_seen, "no fixture record covered oversized_input");
}

#[test]
fn hashing_rejections_report_the_stated_codes() {
    let document = fixture_document("hashing/invalid.json");
    let records = document["records"].as_array().expect("a record array");
    assert!(records.len() >= 5, "the fixture group lost records");
    let mut codes = std::collections::BTreeSet::new();

    for record in records {
        let note = record["note"].as_str().expect("a note");
        let code = record["expected"]["reason_code"]
            .as_str()
            .expect("a code")
            .to_owned();
        codes.insert(code.clone());
        let error = if let Some(text) = record["raw_text"].as_str() {
            json::parse_strict(text)
                .err()
                .unwrap_or_else(|| panic!("{note}: the text was accepted"))
        } else {
            let hex = record["bytes_hex"].as_str().expect("text or bytes");
            let bytes = decode_hex(hex);
            json::parse_bytes_strict(&bytes)
                .err()
                .unwrap_or_else(|| panic!("{note}: the bytes were accepted"))
        };
        assert_eq!(error.code.as_str(), code, "{note}: {error}");
    }
    assert_eq!(
        codes,
        ["invalid_field_type", "invalid_json", "nonportable_value"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        "the fixture group no longer covers every parse rejection"
    );
}

/// Decodes an even-length lowercase hexadecimal string.
fn decode_hex(hex: &str) -> Vec<u8> {
    assert!(
        hex.len().is_multiple_of(2),
        "the hexadecimal string has odd length"
    );
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("a hexadecimal byte"))
        .collect()
}
