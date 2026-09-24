// SPDX-License-Identifier: Apache-2.0
//! Conformance runs of the shared fixtures through the Rust core.
//!
//! The fixtures in `fixtures/` pin the frozen contracts. These tests run the
//! groups that the parse boundary, the hashing boundary, the report boundary,
//! and the run state boundary own: the valid definition artifacts, the
//! structural definition rejections, the input validation records, the
//! hashing rejection records, the canonical hash fixtures, the serialization
//! round trips, the profile self-hashes, the outcome and completion records,
//! and the runtime traces replayed event by event through the run state.
//! Later tasks add the remaining groups as their validation lands. The tests
//! read local files only, so they stay offline and deterministic.

use measuretwice_core::definition::{CheckKind, WhenUncertain};
use measuretwice_core::error::ReasonCode;
use measuretwice_core::hashing::{self, Domain};
use measuretwice_core::run_state::{AttemptResolution, CheckPlace, Phase, RunLimits, RunState};
use measuretwice_core::testing::SplitMix64;
use measuretwice_core::{case, definition, json, report, rule};
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

#[test]
fn hashing_canonical_fixtures_match_forms_and_digests() {
    let document = fixture_document("hashing/canonical.json");
    let records = document["hashes"].as_array().expect("a hash array");
    assert!(records.len() >= 15, "the fixture group lost records");

    let mut domains: BTreeSet<&str> = BTreeSet::new();
    for record in records {
        let note = record["note"].as_str().expect("a note");
        let tag = record["domain"].as_str().expect("a domain");
        let domain = hashing::Domain::from_tag(tag)
            .unwrap_or_else(|| panic!("{note}: the tag {tag} names no domain"));
        domains.insert(tag);
        let value = &record["value"];
        let expected_form = record["canonical"].as_str().expect("a canonical form");
        let expected_hash = record["content_hash"].as_str().expect("a digest");

        // Every domain runs the same canonicalizer. The definition boundary
        // materializes the documented default, and the profile and plan
        // boundaries remove the self-hash field, so those three run through
        // their dedicated paths.
        let (actual_form, actual_hash) = match domain {
            Domain::Definition => {
                let text = serde_json::to_string(value).expect("the artifact serializes");
                let validated = definition::validate_definition_str(&text)
                    .unwrap_or_else(|error| panic!("{note}: {error}"));
                (
                    hashing::definition_canonical_form(&validated),
                    hashing::definition_hash(&validated),
                )
            }
            Domain::Profile | Domain::Plan => (
                hashing::canonical_form(value),
                hashing::compute_self_hash(domain, value)
                    .unwrap_or_else(|error| panic!("{note}: {error}")),
            ),
            Domain::Dataset | Domain::Split => {
                let records = value.as_array().expect("a record array");
                let hash = match domain {
                    Domain::Dataset => hashing::dataset_hash(records),
                    _ => hashing::split_hash(records),
                }
                .unwrap_or_else(|error| panic!("{note}: {error}"));
                // Reordering the JSONL file does not change the dataset hash.
                // A seeded shuffle keeps the run deterministic.
                let mut shuffled = records.clone();
                SplitMix64::seeded(shuffled.len() as u64).shuffle(&mut shuffled);
                let shuffled_hash = match domain {
                    Domain::Dataset => hashing::dataset_hash(&shuffled),
                    _ => hashing::split_hash(&shuffled),
                }
                .unwrap_or_else(|error| panic!("{note}: {error}"));
                assert_eq!(
                    shuffled_hash, hash,
                    "{note}: the record order changed the hash"
                );
                (hashing::canonical_form(value), hash)
            }
            _ => (
                hashing::canonical_form(value),
                hashing::content_hash(domain, value),
            ),
        };
        assert_eq!(actual_form, expected_form, "{note}");
        assert_eq!(actual_hash, expected_hash, "{note}");
    }
    for tag in [
        "definition",
        "input",
        "translation",
        "profile",
        "plan",
        "dataset",
        "split",
    ] {
        assert!(domains.contains(tag), "no fixture record covers {tag}");
    }
}

#[test]
fn string_rule_records_match_their_outcomes_and_lengths() {
    let document = fixture_document("hashing/string-rules.json");
    let records = document["string_rules"].as_array().expect("a record array");
    assert!(records.len() >= 20, "the fixture group lost records");

    let mut keywords: BTreeSet<&str> = BTreeSet::new();
    for record in records {
        let note = record["note"].as_str().expect("a note");
        let keyword = record["rule"].as_str().expect("a keyword");
        keywords.insert(keyword);
        let rule = rule::parse_rule_parameter(keyword, &record["parameter"], "/rule")
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let outcome = rule::assess_rule(&rule, &record["input"])
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        assert_eq!(
            outcome.as_str(),
            record["outcome"].as_str().expect("an outcome"),
            "{note}"
        );
        // A maxLength record also pins the code point count of its input.
        if let Some(length) = record.get("length") {
            let Value::String(text) = &record["input"] else {
                panic!("{note}: the rule input is not a string");
            };
            assert_eq!(
                rule::code_point_length(text),
                length.as_u64().expect("a length"),
                "{note}"
            );
        }
    }
    for keyword in ["maxLength", "includes", "excludes"] {
        assert!(keywords.contains(keyword), "no record covers {keyword}");
    }
}

#[test]
fn the_exact_rules_definition_assesses_through_its_projections() {
    let text = fs::read_to_string(fixture("definitions/valid/exact-rules.json")).unwrap();
    let validated = definition::validate_definition_str(&text).expect("the fixture validates");
    assert!(validated.is_exact_only(), "the fixture holds rules only");

    let case_text = serde_json::to_string(&serde_json::json!({
        "id": "case-1",
        "input": {
            "summary": "The delivery limit for this summary is eighty characters.",
            "notice": "One public notice."
        }
    }))
    .expect("the case serializes");
    let case = case::validate_case_str(&case_text, &validated).expect("the case validates");
    let results = rule::assess_rule_checks(&case).expect("the rule checks assess");
    assert_eq!(results.len(), 3);

    // The applied rules match the first two check-record samples of the
    // outcomes group, which name the same checks in the same order.
    let outcomes = fixture_document("reports/outcomes.json");
    let samples = outcomes["check_records"]
        .as_array()
        .expect("a record array");
    for (result, sample) in results.iter().zip(samples.iter().take(2)) {
        let record = &sample["record"];
        let serialized = serde_json::to_value(result).expect("the result serializes");
        assert_eq!(serialized["check"], record["check"], "{result:?}");
        assert_eq!(serialized["kind"], record["kind"], "{result:?}");
        assert_eq!(
            serialized["applied_rule"], record["applied_rule"],
            "{result:?}"
        );
    }

    // With this case, every rule passes and names its executed input.
    let serialized: Vec<Value> = results
        .iter()
        .map(|result| serde_json::to_value(result).expect("the result serializes"))
        .collect();
    assert_eq!(serialized[0]["outcome"], "pass");
    assert_eq!(serialized[1]["outcome"], "pass");
    assert_eq!(serialized[2]["outcome"], "pass");
    assert_eq!(serialized[2]["applied_rule"]["input"], "notice");
    assert!(serialized[2]["reason"]
        .as_str()
        .expect("a reason")
        .contains("excluded"));
}

#[test]
fn serialization_round_trips_keep_one_canonical_form() {
    let document = fixture_document("serialization/round-trips.json");

    for record in document["values"].as_array().expect("a value array") {
        let note = record["note"].as_str().expect("a note");
        let expected = record["canonical"].as_str().expect("a canonical form");
        let canonical = hashing::canonical_form(&record["value"]);
        assert_eq!(canonical, expected, "{note}");
        // A canonical form parses again through the strict gate and
        // canonicalizes to itself.
        let parsed =
            json::parse_strict(&canonical).unwrap_or_else(|error| panic!("{note}: {error}"));
        assert_eq!(
            hashing::canonical_form(&parsed),
            canonical,
            "{note}: the canonical form does not round trip"
        );
    }

    for record in document["order_invariance"].as_array().expect("an array") {
        let note = record["note"].as_str().expect("a note");
        let expected = record["canonical"].as_str().expect("a canonical form");
        let left = hashing::canonical_form(&record["left"]);
        let right = hashing::canonical_form(&record["right"]);
        assert_eq!(left, expected, "{note}");
        assert_eq!(right, expected, "{note}");
        assert_eq!(
            hashing::content_hash(Domain::Input, &record["left"]),
            hashing::content_hash(Domain::Input, &record["right"]),
            "{note}"
        );
    }

    for record in document["order_strictness"].as_array().expect("an array") {
        let note = record["note"].as_str().expect("a note");
        assert!(
            !record["same_hash"].as_bool().expect("a flag"),
            "{note}: the fixture no longer states strictness"
        );
        let left = hashing::canonical_form(&record["left"]);
        let right = hashing::canonical_form(&record["right"]);
        assert_eq!(
            left,
            record["canonical_left"].as_str().expect("a form"),
            "{note}"
        );
        assert_eq!(
            right,
            record["canonical_right"].as_str().expect("a form"),
            "{note}"
        );
        assert_ne!(left, right, "{note}");
        assert_ne!(
            hashing::content_hash(Domain::Input, &record["left"]),
            hashing::content_hash(Domain::Input, &record["right"]),
            "{note}"
        );
    }

    for record in document["absent_stays_absent"]
        .as_array()
        .expect("an array")
    {
        let note = record["note"].as_str().expect("a note");
        let with = hashing::canonical_form(&record["with_field"]);
        let without = hashing::canonical_form(&record["without_field"]);
        assert_eq!(
            with,
            record["canonical_with"].as_str().expect("a form"),
            "{note}"
        );
        assert_eq!(
            without,
            record["canonical_without"].as_str().expect("a form"),
            "{note}"
        );
        assert_ne!(
            hashing::content_hash(Domain::Input, &record["with_field"]),
            hashing::content_hash(Domain::Input, &record["without_field"]),
            "{note}: canonicalization inserted the omitted field"
        );
    }
}

#[test]
fn typebox_pairs_pin_their_definition_hashes() {
    let document = fixture_document("authoring/typebox-pairs.json");
    let pairs = document["pairs"].as_array().expect("a pair array");
    assert!(pairs.len() >= 3, "the fixture group lost pairs");
    for pair in pairs {
        let file = pair["definition"].as_str().expect("a file name");
        let text =
            fs::read_to_string(fixture(&format!("definitions/valid/{file}"))).expect("the file");
        let validated = definition::validate_definition_str(&text)
            .unwrap_or_else(|error| panic!("{file}: {error}"));
        assert_eq!(
            hashing::definition_canonical_form(&validated),
            pair["canonical"].as_str().expect("a canonical form"),
            "{file}"
        );
        assert_eq!(
            hashing::definition_hash(&validated),
            pair["content_hash"].as_str().expect("a digest"),
            "{file}"
        );
    }
}

#[test]
fn valid_definitions_hash_identically_across_formatting() {
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

    for file in files {
        let text = fs::read_to_string(&file).expect("the fixture file reads");
        let validated = definition::validate_definition_str(&text)
            .unwrap_or_else(|error| panic!("{}: {error}", file.display()));
        let hash = hashing::definition_hash(&validated);

        // A pretty-printed copy of the same artifact keeps one hash. JSON
        // formatting does not establish a content hash.
        let source: Value = serde_json::from_str(&text).expect("the fixture parses");
        let pretty = serde_json::to_string_pretty(&source).expect("the artifact serializes");
        let reparsed = definition::validate_definition_str(&pretty)
            .unwrap_or_else(|error| panic!("{} pretty: {error}", file.display()));
        assert_eq!(
            hashing::definition_hash(&reparsed),
            hash,
            "{}: formatting changed the hash",
            file.display()
        );
    }

    // The when_uncertain pair holds two files with one canonical form and
    // one hash, the cross-file link the fixture README states.
    let omitted = definition::validate_definition_str(
        &fs::read_to_string(fixture("definitions/valid/memory-length.json")).unwrap(),
    )
    .expect("the omitted side validates");
    let stated = definition::validate_definition_str(
        &fs::read_to_string(fixture("definitions/valid/memory-length-explicit.json")).unwrap(),
    )
    .expect("the stated side validates");
    assert_eq!(
        hashing::definition_canonical_form(&omitted),
        hashing::definition_canonical_form(&stated)
    );
    assert_eq!(
        hashing::definition_hash(&omitted),
        hashing::definition_hash(&stated)
    );
}

#[test]
fn profile_state_artifacts_verify_their_self_hash() {
    let document = fixture_document("profiles/states.json");
    let profiles = document["profiles"].as_array().expect("a profile array");
    assert!(profiles.len() >= 5, "the fixture group lost profiles");

    let mut stored_hashes = Vec::new();
    for profile in profiles {
        let id = profile["id"].as_str().expect("an identifier");
        hashing::verify_self_hash(Domain::Profile, profile)
            .unwrap_or_else(|error| panic!("{id}: {error}"));
        stored_hashes.push(
            profile["content_hash"]
                .as_str()
                .expect("a digest")
                .to_owned(),
        );

        // An edited copy fails verification. The artifact is an edited or
        // corrupted copy of the one the digest covered.
        let mut edited = profile.clone();
        edited["intended_use"] = Value::String("Edited after hashing.".to_owned());
        let error = hashing::verify_self_hash(Domain::Profile, &edited)
            .err()
            .unwrap_or_else(|| panic!("{id}: the edited copy was accepted"));
        assert_eq!(error.code, ReasonCode::HashMismatch, "{id}: {error}");
        assert_eq!(error.field_path, "/content_hash");
    }

    // A digest moved from one artifact to another fails the same way.
    let mut swapped = profiles[0].clone();
    swapped["content_hash"] = Value::String(stored_hashes[1].clone());
    let error = hashing::verify_self_hash(Domain::Profile, &swapped)
        .err()
        .unwrap_or_else(|| panic!("the moved digest was accepted"));
    assert_eq!(error.code, ReasonCode::HashMismatch);
}

/// One question record with the stated outcome. Error and skipped outcomes
/// carry the sanitized reason that the contract requires.
fn outcome_record(index: usize, outcome: report::Outcome) -> report::CheckRecord {
    let reason = match outcome {
        report::Outcome::Error => Some(report::SanitizedReason {
            code: ReasonCode::EvaluatorError,
            message: "The adapter reported a network failure.".to_owned(),
            field_path: None,
        }),
        report::Outcome::Skipped => Some(report::SanitizedReason {
            code: ReasonCode::QueueFull,
            message: "The pending-work limit stopped this check.".to_owned(),
            field_path: None,
        }),
        _ => None,
    };
    report::CheckRecord {
        check: format!("check-{index}"),
        kind: report::RecordKind::Question,
        outcome,
        assessment: None,
        applied_rule: None,
        applied_policy: None,
        evaluator: None,
        attempts: None,
        timing: None,
        usage: None,
        reason,
    }
}

#[test]
fn outcome_rows_build_reports_with_the_stated_aggregates() {
    let document = fixture_document("reports/outcomes.json");
    let rows = document["aggregate_table"].as_array().expect("a row array");
    assert!(rows.len() >= 15, "the fixture group lost rows");

    let mut words: BTreeSet<&str> = BTreeSet::new();
    for row in rows {
        let note = row["note"].as_str().expect("a note");
        let outcomes: Vec<report::Outcome> = row["outcomes"]
            .as_array()
            .expect("an outcome array")
            .iter()
            .map(|word| {
                let text = word.as_str().expect("an outcome word");
                words.insert(text);
                report::Outcome::from_word(text)
                    .unwrap_or_else(|| panic!("{note}: {text} names no outcome"))
            })
            .collect();
        let expected = row["expected_aggregate"].as_str().expect("an aggregate");

        // One complete report per row, through the same builder the run path
        // will use.
        let mut builder = report::ReportBuilder::new(
            "conformance-000001",
            report::RunMode::Shadow,
            report::ArtifactReference {
                name: "message-review".to_owned(),
                content_hash: "a".repeat(64),
            },
            report::ProfileReference {
                id: "message-profile".to_owned(),
                content_hash: "b".repeat(64),
            },
            report::CaseReference {
                id: "case-1".to_owned(),
                input_hash: "c".repeat(64),
            },
            report::Completion {
                status: report::CompletionStatus::Completed,
                completed_at: None,
            },
        );
        for (index, outcome) in outcomes.iter().enumerate() {
            builder = builder.check(outcome_record(index, *outcome));
        }
        let built = builder
            .finish()
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        assert_eq!(built.aggregate().as_str(), expected, "{note}");

        // Every component outcome stays in the record, including an error
        // that accompanies a fail.
        let serialized = serde_json::to_value(&built).expect("the report serializes");
        let checks = serialized["checks"].as_array().expect("a record array");
        assert_eq!(checks.len(), outcomes.len(), "{note}");
        for (record, outcome) in checks.iter().zip(outcomes.iter()) {
            assert_eq!(record["outcome"], outcome.as_str(), "{note}");
        }
        // The stored report parses again under the same aggregate.
        let reparsed =
            report::parse_run_report(&serialized).unwrap_or_else(|error| panic!("{note}: {error}"));
        assert_eq!(reparsed.aggregate().as_str(), expected, "{note}");
    }
    for word in ["pass", "fail", "review", "error", "skipped"] {
        assert!(words.contains(word), "no row covers {word}");
    }
}

#[test]
fn check_record_samples_match_the_run_report_contract() {
    let document = fixture_document("reports/outcomes.json");
    let samples = document["check_records"]
        .as_array()
        .expect("a record array");
    assert!(samples.len() >= 5, "the fixture group lost records");

    let mut kinds: BTreeSet<&str> = BTreeSet::new();
    let mut outcomes: BTreeSet<&str> = BTreeSet::new();
    for sample in samples {
        let note = sample["note"].as_str().expect("a note");
        let record = &sample["record"];
        kinds.insert(record["kind"].as_str().expect("a kind"));
        outcomes.insert(record["outcome"].as_str().expect("an outcome"));

        // Each sample parses against the contract and serializes back to the
        // same record.
        let parsed = report::parse_check_record(record, "")
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let serialized = serde_json::to_value(&parsed).expect("the record serializes");
        assert_eq!(serialized, *record, "{note}");
        assert!(parsed.validate("/checks/0").is_ok(), "{note}");
    }
    for kind in ["question", "rule"] {
        assert!(kinds.contains(kind), "no sample covers {kind}");
    }
    for outcome in ["pass", "fail", "review", "error", "skipped"] {
        assert!(outcomes.contains(outcome), "no sample covers {outcome}");
    }
}

#[test]
fn completion_samples_terminate_immutable_reports() {
    let document = fixture_document("reports/outcomes.json");
    let samples = document["completion_samples"]
        .as_array()
        .expect("a sample array");
    assert!(samples.len() >= 3, "the fixture group lost samples");

    let mut statuses: BTreeSet<&str> = BTreeSet::new();
    for sample in samples {
        let note = sample["note"].as_str().expect("a note");
        let completion = &sample["completion"];
        let status_text = completion["status"].as_str().expect("a status");
        statuses.insert(status_text);
        let completed_at = completion["completed_at"]
            .as_str()
            .expect("a terminal time");
        let status = report::CompletionStatus::from_word(status_text)
            .unwrap_or_else(|| panic!("{note}: {status_text} names no status"));

        // A report in any terminal state keeps its component outcomes. The
        // status never rewrites the aggregate.
        let built = report::ReportBuilder::new(
            "conformance-000002",
            report::RunMode::Enforcement,
            report::ArtifactReference {
                name: "message-review".to_owned(),
                content_hash: "a".repeat(64),
            },
            report::ProfileReference {
                id: "message-profile".to_owned(),
                content_hash: "b".repeat(64),
            },
            report::CaseReference {
                id: "case-1".to_owned(),
                input_hash: "c".repeat(64),
            },
            report::Completion {
                status,
                completed_at: Some(completed_at.to_owned()),
            },
        )
        .check(outcome_record(0, report::Outcome::Pass))
        .check(outcome_record(1, report::Outcome::Review))
        .finish()
        .unwrap_or_else(|error| panic!("{note}: {error}"));
        assert_eq!(built.completion().status, status, "{note}");
        assert_eq!(
            built.completion().completed_at.as_deref(),
            Some(completed_at),
            "{note}"
        );
        assert_eq!(
            built.aggregate(),
            report::AggregateOutcome::Review,
            "{note}"
        );
        assert_eq!(built.checks().len(), 2, "{note}");

        // The stored report parses again with the same terminal state.
        let serialized = serde_json::to_value(&built).expect("the report serializes");
        let reparsed =
            report::parse_run_report(&serialized).unwrap_or_else(|error| panic!("{note}: {error}"));
        assert_eq!(reparsed.completion().status, status, "{note}");
        assert_eq!(reparsed.checks().len(), 2, "{note}");
    }
    for status in ["completed", "cancelled", "deadline_exceeded"] {
        assert!(statuses.contains(status), "no sample covers {status}");
    }
}

/// One fixed profile binding for the trace replays. The traces state no
/// profile, so every replay runs under one reference profile.
fn trace_profile() -> report::ProfileReference {
    report::ProfileReference {
        id: "trace-profile".to_owned(),
        content_hash: "1f".repeat(32),
    }
}

/// Builds the component record of one trace result. A rule check records its
/// assessed rule; a question check records the trace outcome.
fn trace_record(
    rules: &std::collections::BTreeMap<String, rule::RuleResult>,
    check_id: &str,
    outcome: &str,
) -> report::CheckRecord {
    if let Some(result) = rules.get(check_id) {
        let record = report::CheckRecord::from_rule_result(result);
        assert_eq!(
            record.outcome.as_str(),
            outcome,
            "{check_id}: the trace outcome disagrees with the exact rule"
        );
        record
    } else {
        report::CheckRecord {
            check: check_id.to_owned(),
            kind: report::RecordKind::Question,
            outcome: report::Outcome::from_word(outcome)
                .unwrap_or_else(|| panic!("{check_id}: {outcome} names no outcome")),
            assessment: None,
            applied_rule: None,
            applied_policy: None,
            evaluator: None,
            attempts: None,
            timing: None,
            usage: None,
            reason: None,
        }
    }
}

#[test]
fn runtime_traces_replay_through_the_run_state_boundary() {
    let document = fixture_document("runtime/traces.json");
    let traces = document["traces"].as_array().expect("a trace array");
    assert!(traces.len() >= 10, "the fixture group lost traces");

    let profile = trace_profile();
    let mut skip_codes = BTreeSet::new();
    let mut statuses = BTreeSet::new();
    for trace in traces {
        let note = trace["id"].as_str().expect("a trace identifier");
        let file = trace["definition"].as_str().expect("a definition file");
        let text =
            fs::read_to_string(fixture(&format!("definitions/valid/{file}"))).expect("the file");
        let validated = definition::validate_definition_str(&text)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let case_text = serde_json::to_string(&serde_json::json!({
            "id": note,
            "input": trace["case_input"]
        }))
        .expect("the case serializes");
        let validated_case = case::validate_case_str(&case_text, &validated)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let case_reference = report::CaseReference::for_case(&validated_case);

        // The exact rules of the trace definition, when it holds any.
        let rules: std::collections::BTreeMap<String, rule::RuleResult> =
            rule::assess_rule_checks(&validated_case)
                .unwrap_or_else(|error| panic!("{note}: {error}"))
                .into_iter()
                .map(|result| (result.check.clone(), result))
                .collect();

        let config = &trace["config"];
        let mut run = RunState::new(
            &validated,
            case_reference.clone(),
            profile.clone(),
            note,
            report::RunMode::Shadow,
            RunLimits {
                max_attempts: config["max_attempts"].as_u64().expect("an attempt limit") as u32,
            },
        )
        .unwrap_or_else(|error| panic!("{note}: {error}"));

        // Every event runs through the boundary. A refusal is recorded, never
        // applied, exactly as the wrapper conformance suite observes it.
        let mut rejections: Vec<(usize, ReasonCode)> = Vec::new();
        let events = trace["events"].as_array().expect("an event array");
        for (index, event) in events.iter().enumerate() {
            let kind = event["type"].as_str().expect("an event type");
            let check = event["check"].as_str();
            match kind {
                "submit" => assert!(index == 0 && check.is_none(), "{note}: the submit event"),
                "check_started" => {
                    let check = check.expect("a check");
                    run.start_attempt(check, &case_reference, &profile)
                        .unwrap_or_else(|error| panic!("{note} event {index}: {error}"));
                }
                "check_result" => {
                    let check = check.expect("a check");
                    let outcome = event["outcome"].as_str().expect("an outcome");
                    // The wrapper restarts a retrying check before its result.
                    if matches!(
                        run.status(check).map(|status| status.place),
                        Some(CheckPlace::Pending)
                    ) && run.phase() == Phase::Running
                    {
                        run.start_attempt(check, &case_reference, &profile)
                            .unwrap_or_else(|error| panic!("{note} event {index}: {error}"));
                    }
                    let record = trace_record(&rules, check, outcome);
                    if let Err(error) = run.accept_result(check, record) {
                        rejections.push((index, error.code));
                    }
                }
                "late_result" => {
                    // A late result arrives after the run ended. The wrapper
                    // completed the drained run before this result arrived.
                    if run.phase() == Phase::Running {
                        run.complete(None)
                            .unwrap_or_else(|error| panic!("{note} event {index}: {error}"));
                    }
                    let check = check.expect("a check");
                    let outcome = event["outcome"].as_str().expect("an outcome");
                    let record = trace_record(&rules, check, outcome);
                    if let Err(error) = run.accept_result(check, record) {
                        rejections.push((index, error.code));
                    }
                }
                "attempt_failed" => {
                    let check = check.expect("a check");
                    if matches!(
                        run.status(check).map(|status| status.place),
                        Some(CheckPlace::Pending)
                    ) {
                        run.start_attempt(check, &case_reference, &profile)
                            .unwrap_or_else(|error| panic!("{note} event {index}: {error}"));
                    }
                    let code =
                        ReasonCode::from_registry(event["code"].as_str().expect("a failure code"))
                            .unwrap_or_else(|| panic!("{note} event {index} names no code"));
                    let resolution = run
                        .fail_attempt(check, code, "The adapter failed the attempt.")
                        .unwrap_or_else(|error| panic!("{note} event {index}: {error}"));
                    if let AttemptResolution::Exhausted = resolution {
                        skip_codes.insert(code.as_str());
                    }
                }
                "check_skipped" => {
                    let check = check.expect("a check");
                    assert_eq!(
                        event["code"].as_str(),
                        Some("queue_full"),
                        "{note} event {index}: an unknown skip code"
                    );
                    run.skip_queue_full(check)
                        .unwrap_or_else(|error| panic!("{note} event {index}: {error}"));
                }
                "cancel" => run
                    .cancel(None)
                    .unwrap_or_else(|error| panic!("{note} event {index}: {error}")),
                "deadline" => run
                    .deadline(None)
                    .unwrap_or_else(|error| panic!("{note} event {index}: {error}")),
                other => panic!("{note} event {index}: unknown event type {other}"),
            }
        }

        // A drained run completes; a terminal run is already frozen.
        if run.phase() == Phase::Running {
            run.complete(None)
                .unwrap_or_else(|error| panic!("{note}: {error}"));
        }

        let expected = &trace["expected"];
        let report_built = run.report().expect("the terminal report exists");
        statuses.insert(report_built.completion().status.as_str());
        assert_eq!(
            report_built.completion().status.as_str(),
            expected["completion"].as_str().expect("a status"),
            "{note}"
        );
        assert_eq!(
            report_built.aggregate().as_str(),
            expected["aggregate"].as_str().expect("an aggregate"),
            "{note}"
        );

        // Every expected check record matches the report record of its check.
        let serialized = serde_json::to_value(report_built).expect("the report serializes");
        let recorded = serialized["checks"].as_array().expect("a record array");
        let wanted = expected["checks"].as_array().expect("a record array");
        assert_eq!(recorded.len(), wanted.len(), "{note}");
        for (record, want) in recorded.iter().zip(wanted.iter()) {
            let check = want["check"].as_str().expect("a check");
            assert_eq!(record["check"].as_str(), Some(check), "{note}");
            assert_eq!(
                record["outcome"].as_str(),
                Some(want["outcome"].as_str().expect("an outcome")),
                "{note}: {check}"
            );
            if let Some(attempts) = want.get("attempts") {
                assert_eq!(
                    record["attempts"].as_u64(),
                    attempts.as_u64(),
                    "{note}: {check} attempts"
                );
            }
            if let Some(reason) = want.get("reason") {
                let code = reason["code"].as_str().expect("a reason code");
                assert_eq!(
                    record["reason"]["code"].as_str(),
                    Some(code),
                    "{note}: {check} reason"
                );
                skip_codes.insert(code);
            }
            if let Some(applied) = want.get("applied_rule") {
                assert_eq!(
                    &record["applied_rule"], applied,
                    "{note}: {check} applied rule"
                );
            }
        }

        // The refused events carry the stated indexes and reason codes.
        let wanted_rejections = expected["rejected_events"]
            .as_array()
            .expect("a rejection array");
        assert_eq!(rejections.len(), wanted_rejections.len(), "{note}");
        for ((index, code), want) in rejections.iter().zip(wanted_rejections.iter()) {
            assert_eq!(
                *index as u64,
                want["event"].as_u64().expect("an index"),
                "{note}"
            );
            assert_eq!(
                code.as_str(),
                want["reason_code"].as_str().expect("a code"),
                "{note}"
            );
        }

        // The attempts of one check never switch the run binding.
        if expected["attempts_share_binding"].as_bool() == Some(true) {
            assert_eq!(run.binding_case().id, note, "{note}");
            assert_eq!(
                run.binding_case().input_hash,
                case_reference.input_hash,
                "{note}"
            );
            assert_eq!(
                run.binding_profile().content_hash,
                profile.content_hash,
                "{note}"
            );
        }
    }
    for code in [
        "queue_full",
        "deadline_before_start",
        "deadline_exceeded",
        "cancelled_before_start",
        "run_cancelled",
        "retries_exhausted",
        "evaluator_error",
    ] {
        assert!(
            skip_codes.contains(code),
            "no replayed trace recorded {code}"
        );
    }
    for status in ["completed", "cancelled", "deadline_exceeded"] {
        assert!(
            statuses.contains(status),
            "no replayed trace ended {status}"
        );
    }
}
