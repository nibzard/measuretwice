// SPDX-License-Identifier: Apache-2.0
//! Conformance runs of the shared fixtures through the Rust core.
//!
//! The fixtures in `fixtures/` pin the frozen contracts. These tests run the
//! groups that the parse boundary owns: the valid definition artifacts, the
//! structural definition rejections, and the hashing rejection records.
//! Later tasks add the remaining groups as their validation lands. The tests
//! read local files only, so they stay offline and deterministic.

use measuretwice_core::{definition, json};
use serde_json::Value;
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

/// The rejection records that the parse boundary owns. The records with
/// semantic codes, such as `duplicate_id` or the input-schema subset, belong
/// to the definition-validation tasks that follow parsing.
const STRUCTURAL_REJECTIONS: &[(&str, &str)] = &[
    ("unsupported_schema_version", "/schema_version"),
    ("unknown_field", "/evaluator"),
    ("unknown_field", "/checks/0/cutoffs"),
    ("missing_field", "/inputs"),
    ("invalid_field_type", "/when_uncertain"),
    ("invalid_field_type", "/checks/0/rule/includes"),
    ("invalid_field_type", "/checks/0/rule/maxLength"),
];

#[test]
fn structural_definition_rejections_report_the_stated_codes_and_paths() {
    let document = fixture_document("definitions/invalid.json");
    let records = document["records"].as_array().expect("a record array");
    assert!(records.len() >= 20, "the fixture group lost records");

    let mut matched = 0;
    for record in records {
        let note = record["note"].as_str().expect("a note");
        let expected = &record["expected"];
        let code = expected["reason_code"].as_str().expect("a code");
        let path = expected["field_path"].as_str().expect("a path");
        if !STRUCTURAL_REJECTIONS.contains(&(code, path)) {
            continue;
        }
        matched += 1;
        let text = serde_json::to_string(&record["raw"]).expect("the raw artifact serializes");
        let error = definition::parse_definition_str(&text)
            .err()
            .unwrap_or_else(|| panic!("{note}: the artifact was accepted"));
        assert_eq!(error.code.as_str(), code, "{note}: {error}");
        assert_eq!(error.field_path, path, "{note}: {error}");
        assert!(!error.message.is_empty(), "{note}: the cause is empty");
    }
    assert_eq!(
        matched,
        STRUCTURAL_REJECTIONS.len(),
        "the fixture group no longer covers every structural rejection"
    );
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
