// SPDX-License-Identifier: Apache-2.0
//! Conformance runs of the shared fixtures through the Rust core.
//!
//! The fixtures in `fixtures/` pin the frozen contracts. These tests run the
//! groups that the parse boundary, the hashing boundary, the report boundary,
//! and the run state boundary own: the valid definition artifacts, the
//! structural definition rejections, the input validation records, the
//! dataset loading records, the
//! reference-label meaning and provenance records, the grouped splits and
//! dataset identities, the
//! evaluation metrics with their confusion matrices, counts, and rates, the
//! uncertainty intervals with their methods, evidence, and bounds, the
//! calibration plans with their goals, grids, identities, and bindings, the
//! fitting search with its selections, statuses, and goal rows, the
//! frozen validation with its statuses, goal rows, and refusals, the
//! hashing rejection records, the canonical hash fixtures, the Jev
//! translation questions with their translation-domain digests, the
//! serialization round trips, the profile self-hashes, the outcome and
//! completion records, and the runtime traces replayed event by event
//! through the run state.
//! Later tasks add the remaining groups as their validation lands. The tests
//! read local files only, so they stay offline and deterministic.

use measuretwice_core::definition::{CheckKind, WhenUncertain};
use measuretwice_core::error::ReasonCode;
use measuretwice_core::hashing::{self, Domain};
use measuretwice_core::profile::{
    self, CompatibilityRequest, LiveBinding, ProfileOrigin, Qualification,
};
use measuretwice_core::run_state::{AttemptResolution, CheckPlace, Phase, RunLimits, RunState};
use measuretwice_core::splits;
use measuretwice_core::testing::SplitMix64;
use measuretwice_core::{
    case, dataset, definition, fitting, intervals, json, metrics, plan, qualification, report, rule,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
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

/// The dataset loading group covers valid and invalid loads through the
/// dataset boundary of the core, as the fixture manifest states.
const DATASET_REJECTION_CODES: &[&str] = &[
    "duplicate_id",
    "invalid_field_type",
    "invalid_json",
    "missing_field",
    "oversized_input",
    "unknown_field",
];

/// Builds the records text of one dataset fixture record, materializing the
/// one padded input field that its note states. The oversized record is too
/// large to embed.
fn dataset_records_text(record: &Value) -> String {
    let text = record["records"].as_str().expect("the records text");
    let Some(rule) = record.get("materialize") else {
        return text.to_owned();
    };
    let field = rule["pad_field"].as_str().expect("a padded field");
    let bytes = rule["pad_bytes"].as_u64().expect("a byte count") as usize;
    let template = text.lines().next().expect("one template line");
    let mut value: Value = serde_json::from_str(template).expect("the template record parses");
    value["input"][field] = Value::String("a".repeat(bytes));
    serde_json::to_string(&value).expect("the materialized record serializes")
}

/// The reference-label group pins the label meaning and the provenance
/// summary of the dataset boundary, as the fixture manifest states.
const LABEL_REJECTION_CODES: &[&str] = &["invalid_field_type", "unknown_field", "unknown_label"];

/// Loads the definition file that one dataset fixture record names.
fn dataset_definition(record: &Value, document: &Value) -> definition::ValidatedDefinition {
    let name = record
        .get("definition")
        .or_else(|| document.get("definition"))
        .and_then(Value::as_str)
        .expect("one definition file name");
    let text = fs::read_to_string(fixture(&format!("definitions/valid/{name}")))
        .unwrap_or_else(|error| panic!("{name}: {error}"));
    definition::validate_definition_str(&text).unwrap_or_else(|error| panic!("{name}: {error}"))
}

#[test]
fn reference_label_records_flag_conflicts_and_count_provenance() {
    let document = fixture_document("datasets/labels.json");
    let default_metadata = &document["metadata"];

    let valid = document["valid"].as_array().expect("valid records");
    assert!(valid.len() >= 6, "the fixture group lost valid records");
    let mut conflicts_seen = false;
    let mut ambiguous_seen = false;
    for record in valid {
        let note = record["note"].as_str().expect("a note");
        let metadata = record
            .get("metadata")
            .unwrap_or(default_metadata)
            .to_owned();
        let metadata_text = serde_json::to_string(&metadata).expect("the metadata serializes");
        let records = record["records"].as_str().expect("the records text");
        let definition = dataset_definition(record, &document);
        let loaded = dataset::load_dataset(&metadata_text, records)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let validated = dataset::validate_dataset(&loaded, &definition)
            .unwrap_or_else(|error| panic!("{note}: {error}"));

        // Every flagged conflict matches its stated kind, line, case, check,
        // and field path.
        let findings = validated.label_review().findings();
        let stated = record["expected"]["findings"].as_array().expect("findings");
        assert_eq!(
            findings.len(),
            stated.len(),
            "{note}: {} findings",
            findings.len()
        );
        for (finding, expected) in findings.iter().zip(stated) {
            let line = expected["line"].as_u64().expect("a line") as usize;
            assert_eq!(
                finding.kind.as_str(),
                expected["kind"].as_str().expect("a kind"),
                "{note}"
            );
            assert_eq!(finding.line, line, "{note}");
            assert_eq!(
                finding.case_id,
                expected["case"].as_str().expect("a case"),
                "{note}"
            );
            assert_eq!(
                finding.check_id.as_deref(),
                expected["check"].as_str(),
                "{note}"
            );
            assert_eq!(
                finding.field_path,
                expected["field_path"].as_str().expect("a path"),
                "{note}"
            );
            assert!(!finding.message.is_empty(), "{note}: the cause is empty");
            conflicts_seen |= finding.kind.as_str() == "check_outcome_conflict"
                || finding.kind.as_str() == "overall_outcome_conflict";
        }

        // The provenance summary keeps human judgments apart from model
        // proposals.
        let summary = validated.label_review().summary();
        let stated = &record["expected"]["summary"];
        for field in [
            "records",
            "labeled",
            "unlabeled",
            "human_reviewed",
            "human_unreviewed",
            "model_reviewed",
            "model_unreviewed",
            "corrected",
            "review_required",
        ] {
            assert_eq!(
                serde_json::to_value(summary).expect("serializes")[field],
                stated[field],
                "{note}: {field}"
            );
        }
        assert_eq!(
            summary.labeled + summary.unlabeled,
            summary.records,
            "{note}"
        );
        assert_eq!(
            summary.human_reviewed
                + summary.human_unreviewed
                + summary.model_reviewed
                + summary.model_unreviewed,
            summary.labeled,
            "{note}"
        );
        ambiguous_seen |= summary.review_required > 0 && findings.is_empty();
    }
    assert!(conflicts_seen, "no fixture record covered one conflict");
    assert!(
        ambiguous_seen,
        "no fixture record covered one ambiguous reference"
    );

    let invalid = document["invalid"].as_array().expect("invalid records");
    assert!(invalid.len() >= 8, "the fixture group lost invalid records");
    let mut covered = BTreeSet::new();
    for record in invalid {
        let note = record["note"].as_str().expect("a note");
        let metadata = record
            .get("metadata")
            .unwrap_or(default_metadata)
            .to_owned();
        let metadata_text = serde_json::to_string(&metadata).expect("the metadata serializes");
        let records = record["records"].as_str().expect("the records text");
        let definition = dataset_definition(record, &document);
        let error = match dataset::load_dataset(&metadata_text, records) {
            Ok(loaded) => dataset::validate_dataset(&loaded, &definition)
                .err()
                .unwrap_or_else(|| panic!("{note}: the dataset was accepted")),
            Err(error) => error,
        };
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
        covered.insert(error.code.as_str().to_owned());
    }
    let covered: Vec<&str> = covered.iter().map(String::as_str).collect();
    assert_eq!(covered, LABEL_REJECTION_CODES);
}

#[test]
fn dataset_loading_records_report_the_stated_codes_and_paths() {
    let document = fixture_document("datasets/loading.json");
    let definition_text =
        fs::read_to_string(fixture("definitions/valid/categorical-question.json"))
            .expect("the definition file reads");
    let definition = definition::validate_definition_str(&definition_text)
        .expect("the fixture definition validates");
    let default_metadata = &document["metadata"];

    let valid = document["valid"].as_array().expect("valid records");
    assert!(valid.len() >= 3, "the fixture group lost valid records");
    for record in valid {
        let note = record["note"].as_str().expect("a note");
        let metadata = record
            .get("metadata")
            .unwrap_or(default_metadata)
            .to_owned();
        let metadata_text = serde_json::to_string(&metadata).expect("the metadata serializes");
        let records = dataset_records_text(record);
        let loaded = dataset::load_dataset(&metadata_text, &records)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        dataset::validate_dataset(&loaded, &definition)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        // A declared record count that loads must match the records.
        if let Some(declared) = metadata["record_count"].as_u64() {
            assert_eq!(loaded.len() as u64, declared, "{note}");
        }
    }

    let invalid = document["invalid"].as_array().expect("invalid records");
    assert!(
        invalid.len() >= 10,
        "the fixture group lost invalid records"
    );
    let mut covered = BTreeSet::new();
    for record in invalid {
        let note = record["note"].as_str().expect("a note");
        let metadata = record
            .get("metadata")
            .unwrap_or(default_metadata)
            .to_owned();
        let metadata_text = serde_json::to_string(&metadata).expect("the metadata serializes");
        let records = dataset_records_text(record);
        let error = match dataset::load_dataset(&metadata_text, &records) {
            Ok(loaded) => dataset::validate_dataset(&loaded, &definition)
                .err()
                .unwrap_or_else(|| panic!("{note}: the dataset was accepted")),
            Err(error) => error,
        };
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
        covered.insert(error.code.as_str().to_owned());
    }
    let covered: Vec<&str> = covered.iter().map(String::as_str).collect();
    assert_eq!(covered, DATASET_REJECTION_CODES);
}

/// The dataset splits group pins the identities, the group rule, the content
/// hashes, the evidence classes, and the overlap facts, as the fixture
/// manifest states.
#[test]
fn dataset_split_records_pin_identities_hashes_and_evidence() {
    let document = fixture_document("datasets/splits.json");
    let definition = dataset_definition(&json!({}), &document);
    let default_metadata = &document["metadata"];

    // Every valid dataset computes the stated identity and the stated split
    // identities, including every content hash.
    let valid = document["valid"].as_array().expect("valid records");
    assert!(valid.len() >= 4, "the fixture group lost valid records");
    let mut computed: Vec<splits::SplitIdentity> = Vec::new();
    let mut identities: Vec<splits::DatasetIdentity> = Vec::new();
    for record in valid {
        let note = record["note"].as_str().expect("a note");
        let metadata = record
            .get("metadata")
            .unwrap_or(default_metadata)
            .to_owned();
        let metadata_text = serde_json::to_string(&metadata).expect("the metadata serializes");
        let records = record["records"].as_str().expect("the records text");
        let loaded = dataset::load_dataset(&metadata_text, records)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        dataset::validate_dataset(&loaded, &definition)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let grouped =
            splits::dataset_splits(&loaded).unwrap_or_else(|error| panic!("{note}: {error}"));
        let identity = grouped.identity();
        let stated = &record["expected"];

        assert_eq!(
            identity.population.as_str(),
            stated["population"].as_str().expect("a population"),
            "{note}"
        );
        assert_eq!(
            identity.population.supports_qualification(),
            stated["supports_qualification"].as_bool().expect("a flag"),
            "{note}"
        );
        assert_eq!(
            identity.population.states_prevalence(),
            stated["states_prevalence"].as_bool().expect("a flag"),
            "{note}"
        );
        assert_eq!(
            identity.record_count,
            stated["record_count"].as_u64().expect("a count") as usize,
            "{note}"
        );
        assert_eq!(
            identity.content_hash,
            stated["content_hash"].as_str().expect("a hash"),
            "{note}"
        );
        assert_eq!(
            serde_json::to_value(&identity.group_assignments).expect("serializes"),
            stated["group_assignments"],
            "{note}"
        );
        assert_eq!(
            serde_json::to_value(&identity.unassigned_groups).expect("serializes"),
            stated["unassigned_groups"],
            "{note}"
        );

        let stated_splits = stated["splits"].as_array().expect("the split expectations");
        assert_eq!(
            grouped.splits().len(),
            stated_splits.len(),
            "{note}: every declared split appears"
        );
        for (split, stated) in grouped.splits().iter().zip(stated_splits) {
            let split_identity = split.identity();
            if let Some(id) = stated["split"].as_str() {
                assert_eq!(split_identity.split_id, id, "{note}");
            }
            if let Some(purpose) = stated["purpose"].as_str() {
                assert_eq!(split_identity.purpose.as_str(), purpose, "{note}");
            }
            if let Some(count) = stated["record_count"].as_u64() {
                assert_eq!(split_identity.record_count, count as usize, "{note}");
            }
            if let Some(cases) = stated["case_ids"].as_array() {
                assert_eq!(
                    serde_json::to_value(&split_identity.case_ids).expect("serializes"),
                    Value::Array(cases.clone()),
                    "{note}"
                );
            }
            if let Some(hash) = stated["content_hash"].as_str() {
                assert_eq!(split_identity.content_hash, hash, "{note}");
            }
            computed.push(split_identity.clone());
        }
        identities.push(identity.clone());

        // One changed input of one split changes that split alone.
        if stated["fitting_hash_unchanged"].as_bool() == Some(true) {
            let base_loaded = loaded_fixture_dataset(&document, 0);
            let base = splits::dataset_splits(&base_loaded).expect("the splits compute");
            let changed_fit = grouped
                .split("fit")
                .expect("the fitting split")
                .identity()
                .content_hash
                .clone();
            let base_fit = base
                .split("fit")
                .expect("the fitting split")
                .identity()
                .content_hash
                .clone();
            assert_eq!(
                changed_fit, base_fit,
                "{note}: the fitting split is unchanged"
            );
            assert_ne!(
                grouped
                    .split("holdout")
                    .expect("the split")
                    .identity()
                    .content_hash,
                base.split("holdout")
                    .expect("the split")
                    .identity()
                    .content_hash,
                "{note}: the validation content changed"
            );
        }
    }

    // Every invalid dataset fails with its stated reason code and field path.
    let invalid = document["invalid"].as_array().expect("invalid records");
    assert!(invalid.len() >= 3, "the fixture group lost invalid records");
    for record in invalid {
        let note = record["note"].as_str().expect("a note");
        let metadata = record
            .get("metadata")
            .unwrap_or(default_metadata)
            .to_owned();
        let metadata_text = serde_json::to_string(&metadata).expect("the metadata serializes");
        let records = record["records"].as_str().expect("the records text");
        let error = match dataset::load_dataset(&metadata_text, records) {
            Ok(loaded) => splits::dataset_splits(&loaded)
                .err()
                .unwrap_or_else(|| panic!("{note}: the dataset was accepted")),
            Err(error) => error,
        };
        assert_eq!(
            error.code.as_str(),
            record["expected"]["reason_code"].as_str().expect("a code"),
            "{note}: {error}"
        );
        assert_eq!(
            error.field_path,
            record["expected"]["field_path"].as_str().expect("a path"),
            "{note}: {error}"
        );
    }

    // Every evidence row classifies as stated. One reused holdout is
    // development data, whatever the dataset names state.
    let evidence = document["evidence"].as_array().expect("evidence rows");
    assert!(evidence.len() >= 5, "the fixture group lost evidence rows");
    for row in evidence {
        let note = row["note"].as_str().expect("a note");
        let loaded = loaded_fixture_dataset(&document, row["dataset"].as_u64().expect("a dataset"));
        let grouped = splits::dataset_splits(&loaded).expect("the splits compute");
        let validation = grouped
            .split(row["split"].as_str().expect("a split"))
            .unwrap_or_else(|| panic!("{note}: the split exists"))
            .identity()
            .clone();
        let population = row
            .get("population")
            .and_then(Value::as_str)
            .map(|word| {
                splits::PopulationStatement::from_word(word)
                    .unwrap_or_else(|| panic!("{note}: one stated population word"))
            })
            .unwrap_or(grouped.identity().population);
        let used: Vec<splits::SplitIdentity> = row["used"]
            .as_array()
            .expect("the used holdouts")
            .iter()
            .map(|entry| {
                let used_loaded =
                    loaded_named_dataset(&document, entry["from"].as_str().expect("a dataset"));
                let mut identity = splits::dataset_splits(&used_loaded)
                    .expect("the splits compute")
                    .split(entry["split"].as_str().expect("a split"))
                    .unwrap_or_else(|| panic!("{note}: the used split exists"))
                    .identity()
                    .clone();
                if let Some(rename) = entry.get("rename") {
                    if let Some(dataset) = rename["dataset"].as_str() {
                        identity.dataset_id = dataset.to_owned();
                    }
                    if let Some(revision) = rename["revision"].as_str() {
                        identity.revision = revision.to_owned();
                    }
                    if let Some(split) = rename["split"].as_str() {
                        identity.split_id = split.to_owned();
                    }
                }
                identity
            })
            .collect();
        let result = splits::validation_evidence(&validation, population, &used);
        let stated = &row["expected"];
        assert_eq!(
            result.class.as_str(),
            stated["class"].as_str().expect("a class"),
            "{note}"
        );
        if let Some(flag) = stated["representative_sample"].as_bool() {
            assert_eq!(result.representative_sample, flag, "{note}");
        }
        if let Some(flag) = stated["needs_fresh_evidence"].as_bool() {
            assert_eq!(result.needs_fresh_evidence, flag, "{note}");
        }
        if let Some(reused) = stated["reused_from"].as_array() {
            assert_eq!(
                serde_json::to_value(&result.reused_from).expect("serializes"),
                Value::Array(reused.clone()),
                "{note}"
            );
        }
        assert!(!result.statement.is_empty(), "{note}: no statement");
    }

    // Every overlap row states the shared groups and the shared cases.
    let overlap = document["overlap"].as_array().expect("overlap rows");
    assert!(overlap.len() >= 3, "the fixture group lost overlap rows");
    for row in overlap {
        let note = row["note"].as_str().expect("a note");
        let fitting = fixture_split_identity(&document, &row["fitting"]);
        let validation = fixture_split_identity(&document, &row["validation"]);
        let result = splits::split_overlap(&fitting, &validation);
        let stated = &row["expected"];
        assert_eq!(
            result.same_dataset,
            stated["same_dataset"].as_bool().expect("a flag"),
            "{note}"
        );
        assert_eq!(
            serde_json::to_value(&result.shared_groups).expect("serializes"),
            stated["shared_groups"],
            "{note}"
        );
        assert_eq!(
            serde_json::to_value(&result.shared_cases).expect("serializes"),
            stated["shared_cases"],
            "{note}"
        );
        assert_eq!(
            result.is_disjoint(),
            stated["separated"].as_bool().expect("a flag"),
            "{note}"
        );
        // The requirement refuses every overlap that the facts state.
        let refused = splits::require_separated(&fitting, &validation);
        assert_eq!(
            refused.is_err(),
            !result.is_disjoint(),
            "{note}: the requirement agrees with the facts"
        );
    }

    // One split identity round trips through the boundary contract.
    let value = serde_json::to_value(&computed[0]).expect("the identity serializes");
    assert_eq!(
        splits::parse_split_identity(&value).expect("the identity parses"),
        computed[0]
    );
    assert_eq!(identities.len(), valid.len());
}

/// Loads one valid fixture dataset by its position in the valid records.
fn loaded_fixture_dataset(document: &Value, index: u64) -> dataset::Dataset {
    let record = &document["valid"][index as usize];
    let metadata = record
        .get("metadata")
        .cloned()
        .unwrap_or_else(|| document["metadata"].clone());
    dataset::load_dataset(
        &serde_json::to_string(&metadata).expect("serializes"),
        record["records"].as_str().expect("the records text"),
    )
    .expect("the dataset loads")
}

/// Loads one valid fixture dataset by the name its evidence rows state:
/// base, unassigned, changed, or the position of one later dataset.
fn loaded_named_dataset(document: &Value, name: &str) -> dataset::Dataset {
    let index = match name {
        "base" => 0,
        "unassigned" => 1,
        "changed" => 3,
        other => other
            .parse::<usize>()
            .unwrap_or_else(|_| panic!("one stated dataset name: {other}")),
    };
    loaded_fixture_dataset(document, index as u64)
}

/// Returns one split identity of one fixture selection row.
fn fixture_split_identity(document: &Value, entry: &Value) -> splits::SplitIdentity {
    splits::dataset_splits(&loaded_fixture_dataset(
        document,
        entry["dataset"].as_u64().expect("a dataset"),
    ))
    .expect("the splits compute")
    .split(entry["split"].as_str().expect("a split"))
    .expect("the split exists")
    .identity()
    .clone()
}

/// The evaluation-metrics group covers the rejections of the metrics
/// boundary, as the fixture manifest states.
const METRICS_REJECTION_CODES: &[&str] = &[
    "insufficient_evidence",
    "unknown_field",
    "duplicate_id",
    "missing_field",
    "invalid_field_type",
];

/// Builds one evaluated case from one fixture outcome object.
fn case_outcome_of(value: &Value) -> metrics::CaseOutcome {
    let mut checks = BTreeMap::new();
    for (check_id, word) in value["checks"].as_object().expect("the check outcomes") {
        let outcome = report::Outcome::from_word(word.as_str().expect("one outcome word"))
            .unwrap_or_else(|| panic!("{check_id}: one outcome word"));
        checks.insert(check_id.clone(), outcome);
    }
    metrics::CaseOutcome {
        case_id: value["id"]
            .as_str()
            .expect("one case identifier")
            .to_owned(),
        checks,
        aggregate: report::AggregateOutcome::from_word(
            value["aggregate"].as_str().expect("one aggregate word"),
        )
        .expect("one aggregate word"),
        completion: report::CompletionStatus::from_word(
            value["completion"].as_str().expect("one completion word"),
        )
        .expect("one completion word"),
        attempts: value["attempts"].as_u64().expect("one attempt count"),
        elapsed_ms: value.get("elapsed_ms").and_then(Value::as_f64),
        usage: value
            .get("usage")
            .map(|usage| {
                usage
                    .as_object()
                    .expect("one usage object")
                    .iter()
                    .map(|(key, amount)| (key.clone(), amount.as_f64().expect("one usage number")))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Compares one computed metric set with one stated fixture expectation.
/// The expectation states the scope, the counts, the confusion matrix, and
/// the rates with their numerators, denominators, and values.
fn assert_metric_set(computed: &metrics::MetricSet, stated: &Value, note: &str) {
    assert_eq!(
        computed.scope,
        stated["scope"].as_str().expect("a scope"),
        "{note}"
    );
    assert_eq!(
        serde_json::to_value(computed.counts).expect("serializes"),
        stated["counts"],
        "{note}: {}",
        computed.scope
    );
    if let Some(confusion) = stated.get("confusion") {
        assert_eq!(
            serde_json::to_value(computed.confusion).expect("serializes"),
            *confusion,
            "{note}: {}",
            computed.scope
        );
    }
    let rates = stated["rates"].as_array().expect("the stated rates");
    assert_eq!(
        computed.rates.len(),
        rates.len(),
        "{note}: {}",
        computed.scope
    );
    for (rate, stated_rate) in computed.rates.iter().zip(rates) {
        let scope = format!("{} of {}", rate.metric.as_str(), computed.scope);
        assert_eq!(
            rate.metric.as_str(),
            stated_rate["metric"].as_str().expect("a metric word"),
            "{note}: {scope}"
        );
        assert_eq!(
            rate.numerator,
            stated_rate["numerator"].as_u64().expect("a numerator") as usize,
            "{note}: {scope}"
        );
        assert_eq!(
            rate.denominator,
            stated_rate["denominator"].as_u64().expect("a denominator") as usize,
            "{note}: {scope}"
        );
        // One zero denominator states one null value, and one present
        // denominator states one number.
        if stated_rate["value"].is_null() {
            assert!(rate.is_unavailable(), "{note}: {scope} states no value");
            assert_eq!(rate.value, None, "{note}: {scope}");
        } else {
            assert_eq!(
                rate.value,
                Some(stated_rate["value"].as_f64().expect("a value")),
                "{note}: {scope}"
            );
        }
    }
}

#[test]
fn evaluation_metric_rows_pin_counts_confusion_and_rates() {
    let document = fixture_document("metrics/evaluation.json");
    let definition = dataset_definition(&json!({}), &document);
    let metadata_text =
        serde_json::to_string(&document["metadata"]).expect("the metadata serializes");

    // Every valid row computes the stated metric sets, slices, and
    // operational totals. The fixture expectations come from one
    // independent implementation of the metric definitions.
    let valid = document["valid"].as_array().expect("valid records");
    assert!(valid.len() >= 6, "the fixture group lost valid records");
    for record in valid {
        let note = record["note"].as_str().expect("a note");
        let loaded =
            dataset::load_dataset(&metadata_text, record["records"].as_str().expect("records"))
                .unwrap_or_else(|error| panic!("{note}: {error}"));
        let validated = dataset::validate_dataset(&loaded, &definition)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let outcomes: Vec<metrics::CaseOutcome> = record["outcomes"]
            .as_array()
            .expect("the outcomes")
            .iter()
            .map(case_outcome_of)
            .collect();
        let computed = metrics::evaluate_metrics(&validated, &outcomes)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let stated = &record["expected"];

        assert_eq!(
            computed.case_count,
            stated["case_count"].as_u64().expect("a count") as usize,
            "{note}"
        );
        assert_eq!(
            computed.unevaluated_records,
            stated["unevaluated_records"].as_u64().expect("a count") as usize,
            "{note}"
        );
        assert_eq!(
            computed.attempts,
            stated["attempts"].as_u64().expect("a count"),
            "{note}"
        );
        assert_eq!(
            computed.latency_cases,
            stated["latency_cases"].as_u64().expect("a count") as usize,
            "{note}"
        );
        if let Some(elapsed) = stated.get("elapsed_ms") {
            assert_eq!(
                computed.latency_ms,
                Some(elapsed.as_f64().expect("a latency total")),
                "{note}"
            );
        } else {
            assert_eq!(computed.latency_ms, None, "{note}");
        }
        if let Some(usage) = stated.get("usage").and_then(Value::as_object) {
            assert_eq!(computed.usage.len(), usage.len(), "{note}");
            for (key, amount) in usage {
                assert_eq!(
                    computed.usage.get(key),
                    Some(&amount.as_f64().expect("a usage total")),
                    "{note}: {key}"
                );
            }
        }

        let scopes = stated["scopes"].as_array().expect("the stated scopes");
        assert_eq!(computed.scopes.len(), scopes.len(), "{note}");
        for (set, stated_set) in computed.scopes.iter().zip(scopes) {
            assert_metric_set(set, stated_set, note);
        }
        // The complete check set is the last scope.
        assert_eq!(
            computed
                .metric_set(metrics::ALL_CHECKS)
                .expect("the complete set")
                .scope,
            metrics::ALL_CHECKS,
            "{note}"
        );

        let slices = stated["slices"].as_array().cloned().unwrap_or_default();
        assert_eq!(computed.slices.len(), slices.len(), "{note}");
        for (slice, stated_slice) in computed.slices.iter().zip(&slices) {
            assert_eq!(
                slice.tag,
                stated_slice["tag"].as_str().expect("a tag"),
                "{note}"
            );
            let stated_metrics = stated_slice["metrics"].as_array().expect("the stated sets");
            assert_eq!(slice.metrics.len(), stated_metrics.len(), "{note}");
            for (set, stated_set) in slice.metrics.iter().zip(stated_metrics) {
                assert_metric_set(set, stated_set, note);
            }
        }

        // No metric set adds up as independent evidence.
        assert_eq!(computed.independence, metrics::NO_INDEPENDENCE, "{note}");
    }

    // Every invalid row fails with its stated reason code and field path.
    let invalid = document["invalid"].as_array().expect("invalid records");
    assert!(invalid.len() >= 5, "the fixture group lost invalid records");
    let mut covered: BTreeSet<&str> = BTreeSet::new();
    for record in invalid {
        let note = record["note"].as_str().expect("a note");
        let loaded =
            dataset::load_dataset(&metadata_text, record["records"].as_str().expect("records"))
                .unwrap_or_else(|error| panic!("{note}: {error}"));
        let validated = dataset::validate_dataset(&loaded, &definition)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let outcomes: Vec<metrics::CaseOutcome> = record["outcomes"]
            .as_array()
            .expect("the outcomes")
            .iter()
            .map(case_outcome_of)
            .collect();
        let error = metrics::evaluate_metrics(&validated, &outcomes)
            .err()
            .unwrap_or_else(|| panic!("{note}: the evaluation was accepted"));
        assert_eq!(
            error.code.as_str(),
            record["expected"]["reason_code"].as_str().expect("a code"),
            "{note}: {error}"
        );
        assert_eq!(
            error.field_path,
            record["expected"]["field_path"].as_str().expect("a path"),
            "{note}: {error}"
        );
        covered.insert(error.code.as_str());
    }
    let expected_codes: BTreeSet<&str> = METRICS_REJECTION_CODES.iter().copied().collect();
    assert_eq!(
        covered, expected_codes,
        "the fixture group lost a rejection"
    );
}

/// The interval group covers the rejections of the interval boundary, as the
/// fixture manifest states.
const INTERVAL_REJECTION_CODES: &[&str] = &[
    "invalid_field_type",
    "unsupported_sampling",
    "missing_field",
    "unknown_field",
    "insufficient_evidence",
];

/// The tolerance of the bound comparison. The stated bounds come from one
/// independent implementation of the documented formula, so two rounding
/// orders may differ in their last digits and nowhere else.
const BOUND_TOLERANCE: f64 = 1e-12;

/// Compares one stated bound with one computed bound.
fn assert_bound(computed: f64, stated: &Value, note: &str) {
    let expected = stated.as_f64().expect("one bound");
    assert!(
        (computed - expected).abs() <= BOUND_TOLERANCE,
        "{note}: bound {computed} against {expected}"
    );
}

/// Compares one computed interval set with one stated fixture expectation.
/// Every row states its metric, the case counts of its rate, its draws, and
/// either its bounds or the reason no bound computes.
fn assert_interval_set(computed: &intervals::IntervalSet, stated: &Value, note: &str) {
    assert_eq!(
        computed.scope,
        stated["scope"].as_str().expect("a scope"),
        "{note}"
    );
    let rows = stated["intervals"].as_array().expect("the stated rows");
    assert_eq!(
        computed.intervals.len(),
        rows.len(),
        "{note}: {}",
        computed.scope
    );
    for (interval, stated_interval) in computed.intervals.iter().zip(rows) {
        let row = format!("{} of {}", interval.metric.as_str(), computed.scope,);
        assert_eq!(
            interval.metric.as_str(),
            stated_interval["metric"].as_str().expect("a metric word"),
            "{note}: {row}"
        );
        assert_eq!(
            interval.numerator,
            stated_interval["numerator"].as_u64().expect("a numerator") as usize,
            "{note}: {row}"
        );
        assert_eq!(
            interval.denominator,
            stated_interval["denominator"]
                .as_u64()
                .expect("a denominator") as usize,
            "{note}: {row}"
        );
        assert_eq!(
            interval.draws,
            stated_interval["draws"].as_u64().expect("a draw count") as usize,
            "{note}: {row}"
        );
        assert_eq!(
            interval.event_draws,
            stated_interval["event_draws"]
                .as_u64()
                .expect("an event count") as usize,
            "{note}: {row}"
        );
        // One row states either its bounds or the reason no bound computes.
        match stated_interval.get("reason").and_then(Value::as_str) {
            Some(reason) => {
                assert_eq!(
                    interval.reason.expect("a reason").as_str(),
                    reason,
                    "{note}: {row}"
                );
                assert_eq!(interval.lower, None, "{note}: {row} states no bound");
                assert_eq!(interval.upper, None, "{note}: {row} states no bound");
            }
            None => {
                assert_eq!(interval.reason, None, "{note}: {row} states no reason");
                assert_bound(
                    interval.lower.expect("a lower bound"),
                    &stated_interval["lower"],
                    &format!("{note}: {row} lower"),
                );
                assert_bound(
                    interval.upper.expect("an upper bound"),
                    &stated_interval["upper"],
                    &format!("{note}: {row} upper"),
                );
            }
        }
    }
}

#[test]
fn interval_rows_pin_methods_evidence_and_bounds() {
    let document = fixture_document("metrics/intervals.json");
    let definition = dataset_definition(&json!({}), &document);
    let metadata_text =
        serde_json::to_string(&document["metadata"]).expect("the metadata serializes");

    // Every count row states the bounds of one independent implementation of
    // the documented formula, or the rejection of one broken count. Both
    // halves feed the coverage check at the end.
    let counts = document["counts"].as_array().expect("count records");
    assert!(counts.len() >= 20, "the fixture group lost count records");
    let mut covered: BTreeSet<&str> = BTreeSet::new();
    for record in counts {
        let note = record["note"].as_str().expect("a note");
        let computed = intervals::parse_count(&record["numerator"], "/numerator")
            .and_then(|numerator| {
                intervals::parse_count(&record["denominator"], "/denominator")
                    .map(|denominator| (numerator, denominator))
            })
            .and_then(|(numerator, denominator)| {
                let level = intervals::ConfidenceLevel::from_number(
                    record["confidence_level"].as_f64().unwrap_or(f64::NAN),
                )
                .ok_or_else(|| {
                    measuretwice_core::error::ValidationError::invalid_field_type(
                        "/confidence_level",
                        "The interval methods support the confidence levels 0.9, 0.95, and 0.99 alone.",
                    )
                })?;
                intervals::wilson_interval(numerator, denominator, level)
            });
        match computed {
            Ok((lower, upper)) => {
                assert_bound(
                    lower,
                    &record["expected"]["lower"],
                    &format!("{note}: lower"),
                );
                assert_bound(
                    upper,
                    &record["expected"]["upper"],
                    &format!("{note}: upper"),
                );
            }
            Err(error) => {
                assert_eq!(
                    error.code.as_str(),
                    record["expected"]["reason_code"].as_str().expect("a code"),
                    "{note}: {error}"
                );
                assert_eq!(
                    error.field_path,
                    record["expected"]["field_path"].as_str().expect("a path"),
                    "{note}: {error}"
                );
                covered.insert(error.code.as_str());
            }
        }
    }

    // Every valid row computes the stated intervals of every scope and every
    // slice under its declared sampling model and evidence requirement.
    let valid = document["valid"].as_array().expect("valid records");
    assert!(valid.len() >= 4, "the fixture group lost valid records");
    for record in valid {
        let note = record["note"].as_str().expect("a note");
        let loaded =
            dataset::load_dataset(&metadata_text, record["records"].as_str().expect("records"))
                .unwrap_or_else(|error| panic!("{note}: {error}"));
        let validated = dataset::validate_dataset(&loaded, &definition)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let outcomes: Vec<metrics::CaseOutcome> = record["outcomes"]
            .as_array()
            .expect("the outcomes")
            .iter()
            .map(case_outcome_of)
            .collect();
        let request = intervals::parse_interval_request(&json!({
            "sampling": record["sampling"],
            "confidence_level": record["confidence_level"],
            "minimum_samples": record["minimum_samples"],
        }))
        .unwrap_or_else(|error| panic!("{note}: {error}"));
        let computed = intervals::evaluate_intervals(&validated, &outcomes, &request)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let stated = &record["expected"];

        // The header states the method, the level, the sampling model, the
        // minimum evidence, and the complete method statement.
        assert_eq!(computed.method, intervals::METHOD, "{note}");
        assert_eq!(
            computed.method,
            stated["method"].as_str().expect("a method"),
            "{note}"
        );
        assert_eq!(
            computed.sampling,
            stated["sampling"].as_str().expect("a sampling model"),
            "{note}"
        );
        assert_eq!(
            computed.confidence_level,
            stated["confidence_level"].as_f64().expect("a level"),
            "{note}"
        );
        assert_eq!(
            computed.minimum_samples,
            stated["minimum_samples"].as_u64().expect("a minimum") as usize,
            "{note}"
        );
        assert_eq!(
            computed.method_statement,
            stated["method_statement"].as_str().expect("a statement"),
            "{note}"
        );
        assert!(computed.method_statement.len() <= 2000, "{note}");

        let scopes = stated["scopes"].as_array().expect("the stated scopes");
        assert_eq!(computed.scopes.len(), scopes.len(), "{note}");
        for (set, stated_set) in computed.scopes.iter().zip(scopes) {
            assert_interval_set(set, stated_set, note);
        }
        let slices = stated["slices"].as_array().cloned().unwrap_or_default();
        assert_eq!(computed.slices.len(), slices.len(), "{note}");
        for (slice, stated_slice) in computed.slices.iter().zip(&slices) {
            assert_eq!(
                slice.tag,
                stated_slice["tag"].as_str().expect("a tag"),
                "{note}"
            );
            let stated_scopes = stated_slice["scopes"].as_array().expect("the stated sets");
            assert_eq!(slice.scopes.len(), stated_scopes.len(), "{note}");
            for (set, stated_set) in slice.scopes.iter().zip(stated_scopes) {
                assert_interval_set(set, stated_set, note);
            }
        }
    }

    // Every invalid row fails with its stated reason code and field path.
    let invalid = document["invalid"].as_array().expect("invalid records");
    assert!(invalid.len() >= 8, "the fixture group lost invalid records");
    for record in invalid {
        let note = record["note"].as_str().expect("a note");
        let error = intervals::parse_interval_request(&record["request"])
            .err()
            .unwrap_or_else(|| panic!("{note}: the request was accepted"));
        assert_eq!(
            error.code.as_str(),
            record["expected"]["reason_code"].as_str().expect("a code"),
            "{note}: {error}"
        );
        assert_eq!(
            error.field_path,
            record["expected"]["field_path"].as_str().expect("a path"),
            "{note}: {error}"
        );
        covered.insert(error.code.as_str());
    }
    let expected_codes: BTreeSet<&str> = INTERVAL_REJECTION_CODES.iter().copied().collect();
    assert_eq!(
        covered, expected_codes,
        "the fixture group lost a rejection"
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

/// Checks one translated question record against the core canonicalizer.
fn assert_translated_question(record: &Value, note: &str) {
    let question = &record["question"];
    let expected_form = record["canonical"].as_str().expect("a canonical form");
    let expected_hash = record["content_hash"].as_str().expect("a digest");
    assert_eq!(hashing::canonical_form(question), expected_form, "{note}");
    assert_eq!(
        hashing::content_hash(Domain::Translation, question),
        expected_hash,
        "{note}"
    );
}

#[test]
fn jev_translation_fixtures_hash_through_the_core() {
    let document = fixture_document("translations/jev.json");
    let cases = document["cases"].as_array().expect("a case array");
    assert!(cases.len() >= 3, "the fixture group lost cases");

    // The mapping covers every question kind and its Jev primitive.
    let mut primitives: BTreeSet<&str> = BTreeSet::new();
    for row in document["mapping"].as_array().expect("a mapping array") {
        let kind = row["question_kind"].as_str().expect("a question kind");
        let primitive = row["primitive"].as_str().expect("a primitive");
        let expected = match kind {
            "categorical" => "choice",
            "binary" => "noul",
            "ordered" => "score",
            other => panic!("unknown question kind {other}"),
        };
        assert_eq!(primitive, expected, "{kind} maps to {expected}");
        primitives.insert(primitive);
    }
    assert_eq!(
        primitives,
        BTreeSet::from(["choice", "noul", "score"]),
        "every Jev primitive appears"
    );

    let mut base_hashes: BTreeMap<String, &str> = BTreeMap::new();
    for case in cases {
        let note = case["note"].as_str().expect("a note");
        assert_translated_question(case, note);
        let key = format!(
            "{}/{}",
            case["definition"].as_str().expect("a definition file"),
            case["check"].as_str().expect("a check identifier")
        );
        base_hashes.insert(key, case["content_hash"].as_str().expect("a digest"));

        // The evidence state holds exactly the projected inputs of using.
        let state = case["expected_state"].as_object().expect("a state object");
        assert_eq!(state.len(), 1, "{note}: the state holds one envelope key");
        let evidence = state["evidence"].as_object().expect("an evidence object");
        let using = case["using"].as_array().expect("a using list");
        let mut named: BTreeSet<&str> = BTreeSet::new();
        for name in using {
            named.insert(name.as_str().expect("an input name"));
        }
        let evidence_names: BTreeSet<&str> = evidence.keys().map(|key| key.as_str()).collect();
        assert_eq!(evidence_names, named, "{note}: the state names only using");
        let input = case["case_input"].as_object().expect("a case input");
        for (name, value) in evidence {
            assert_eq!(Some(value), input.get(name), "{note}: the value of {name}");
        }
    }

    // Every identity variant changes the digest of its base case.
    let identity = document["identity"].as_array().expect("an identity array");
    assert!(identity.len() >= 3, "the fixture group lost variants");
    for record in identity {
        let note = record["note"].as_str().expect("a note");
        assert_translated_question(record, note);
        let key = format!(
            "{}/{}",
            record["base"].as_str().expect("a definition file"),
            record["check"].as_str().expect("a check identifier")
        );
        let base = *base_hashes
            .get(&key)
            .unwrap_or_else(|| panic!("{note}: no base case named {key}"));
        assert_ne!(
            record["content_hash"].as_str().expect("a digest"),
            base,
            "{note}: the variant kept the base digest"
        );
    }

    // Every state rejection names one registered reason code.
    for record in document["state_rejections"]
        .as_array()
        .expect("a rejection array")
    {
        let note = record["note"].as_str().expect("a note");
        let code = record["expected"]["reason_code"]
            .as_str()
            .expect("a reason code");
        assert!(
            ReasonCode::from_registry(code).is_some(),
            "{note}: {code} names no registered reason"
        );
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

/// Reads one stated profile of the states group by its identifier.
fn stated_profile(document: &Value, id: &str) -> Value {
    document["profiles"]
        .as_array()
        .expect("a profile array")
        .iter()
        .find(|profile| profile["id"].as_str() == Some(id))
        .cloned()
        .unwrap_or_else(|| panic!("no stated profile holds the identifier {id}"))
}

#[test]
fn profile_state_artifacts_validate_through_the_profile_boundary() {
    let document = fixture_document("profiles/states.json");
    let profiles = document["profiles"].as_array().expect("a profile array");

    // Every valid artifact passes the complete contract check. The group
    // covers every qualification status, both stochastic origins, and the
    // exact origin.
    let mut statuses = BTreeSet::new();
    for profile in profiles {
        let id = profile["id"].as_str().expect("an identifier");
        let validated =
            profile::validate_profile(profile).unwrap_or_else(|error| panic!("{id}: {error}"));
        assert_eq!(validated.id(), id);
        assert_eq!(
            validated.content_hash(),
            profile["content_hash"].as_str().expect("a digest"),
            "{id}: the verified self-hash equals the stored digest"
        );
        statuses.insert(validated.qualification().as_str().to_owned());
        // The accessors agree with the artifact on every read field.
        assert_eq!(
            validated.definition_name(),
            profile["definition"]["name"].as_str().expect("a name"),
            "{id}"
        );
    }
    assert_eq!(
        statuses,
        BTreeSet::from([
            "unvalidated".to_owned(),
            "insufficient_evidence".to_owned(),
            "criteria_not_met".to_owned(),
            "validated_for_scope".to_owned(),
        ]),
        "every qualification status appears at least once"
    );
    let exploration =
        profile::validate_profile(&stated_profile(&document, "message-supported-exploration"))
            .expect("the exploration artifact");
    assert_eq!(exploration.origin(), ProfileOrigin::Exploration);
    assert_eq!(exploration.qualification(), Qualification::Unvalidated);
    assert_eq!(exploration.bindings().len(), 1);

    // Every invalid artifact rejects with the stated code and path, before
    // any self-hash complaint: the defect names its own field.
    for record in document["invalid"].as_array().expect("an invalid array") {
        let expected = &record["expected"];
        let error = profile::validate_profile(&record["profile"])
            .err()
            .unwrap_or_else(|| panic!("{}: the artifact was accepted", record["note"]));
        assert_eq!(
            error.code.as_str(),
            expected["reason_code"].as_str().expect("a code"),
            "{}: {error}",
            record["note"]
        );
        assert_eq!(
            error.field_path,
            expected["field_path"].as_str().expect("a path"),
            "{}: {error}",
            record["note"]
        );
    }

    // An edited copy of one valid artifact keeps its fields but fails its
    // stored self-hash, and one stripped copy loses the digest field.
    let mut edited = stated_profile(&document, "message-supported-exploration");
    edited["intended_use"] = Value::String("Edited after hashing.".to_owned());
    let error = profile::validate_profile(&edited).expect_err("the edited copy fails");
    assert_eq!(error.code, ReasonCode::HashMismatch);
    assert_eq!(error.field_path, "/content_hash");
}

/// Reads one live binding of one compatibility row.
fn live_binding(row: &Value) -> Vec<LiveBinding> {
    match row.get("live") {
        None => Vec::new(),
        Some(entries) => profile::parse_live_bindings(entries, "/live")
            .unwrap_or_else(|error| panic!("{}: {error}", row["note"])),
    }
}

#[test]
fn compatibility_pairings_fail_or_load_with_the_stated_codes() {
    let document = fixture_document("profiles/states.json");
    let records = document["compatibility"]
        .as_array()
        .expect("a compatibility array");
    assert!(records.len() >= 9, "the fixture group lost pairings");

    let mut refused = BTreeSet::new();
    for row in records {
        let note = row["note"].as_str().expect("a note");
        let artifact = stated_profile(&document, row["profile_id"].as_str().expect("an id"));
        let validated =
            profile::validate_profile(&artifact).unwrap_or_else(|error| panic!("{note}: {error}"));
        let definition_text = fs::read_to_string(fixture(&format!(
            "definitions/valid/{}",
            row["against_definition"]
                .as_str()
                .expect("a definition file")
        )))
        .expect("the definition file reads");
        let definition = definition::validate_definition_str(&definition_text)
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let request = CompatibilityRequest {
            mode: match row.get("mode").and_then(Value::as_str) {
                Some("enforcement") => report::RunMode::Enforcement,
                _ => report::RunMode::Shadow,
            },
            requested_scope: row
                .get("requested_scope")
                .and_then(Value::as_str)
                .map(str::to_owned),
            selected_hash: row
                .get("selected_hash")
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
        let outcome = profile::check_compatibility(
            &validated,
            &definition,
            &live_binding(row),
            &request,
            "/profile",
        );
        match row.get("expected") {
            Some(expected) => {
                let error = outcome.err().unwrap_or_else(|| {
                    panic!("{note}: the pairing was accepted where one refusal was stated")
                });
                assert_eq!(
                    error.code.as_str(),
                    expected["reason_code"].as_str().expect("a code"),
                    "{note}: {error}"
                );
                if let Some(path) = expected["field_path"].as_str() {
                    assert_eq!(error.field_path, path, "{note}: {error}");
                }
                refused.insert(error.code.as_str().to_owned());
            }
            None => {
                assert!(
                    row["loads"].as_bool().unwrap_or(false),
                    "{note}: one row without one refusal must state that it loads"
                );
                outcome.unwrap_or_else(|error| panic!("{note}: {error}"));
            }
        }
    }

    // The group covers every compatibility family of the registry that one
    // pairing can state: the definition, the policy, the evaluator, the
    // translation, the model, the scope, the qualification, and the host
    // selection.
    for code in [
        "definition_mismatch",
        "policy_mismatch",
        "evaluator_mismatch",
        "translation_mismatch",
        "model_resolution_changed",
        "scope_mismatch",
        "qualification_insufficient",
        "profile_not_selected",
    ] {
        assert!(refused.contains(code), "no pairing states {code}");
    }
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
                snapshot: None,
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
                snapshot: None,
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

#[test]
fn case_reference_rows_pin_the_private_data_defaults() {
    let document = fixture_document("reports/outcomes.json");
    let group = &document["case_references"];
    let valid = group["valid"].as_array().expect("a valid array");
    let invalid = group["invalid"].as_array().expect("an invalid array");
    assert!(valid.len() >= 2, "the fixture group lost valid rows");
    assert!(invalid.len() >= 4, "the fixture group lost invalid rows");

    let materialize = |snapshot: &Value| -> Value {
        match snapshot.as_str() {
            Some("s256") => Value::String("s".repeat(256)),
            Some("x257") => Value::String("x".repeat(257)),
            _ => snapshot.clone(),
        }
    };

    let mut snapshots_seen = false;
    for row in valid {
        let note = row["note"].as_str().expect("a note");
        let mut reference = row["reference"].clone();
        if let Some(snapshot) = reference.get("snapshot").cloned() {
            reference["snapshot"] = materialize(&snapshot);
            snapshots_seen = true;
        }
        // The row parses through the same boundary that reads one offered
        // attempt binding, and it round-trips through one stored report.
        let parsed = report::parse_case_reference(Some(&reference), "/case")
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        let built = report::ReportBuilder::new(
            "conformance-000003",
            report::RunMode::Shadow,
            report::ArtifactReference {
                name: "message-review".to_owned(),
                content_hash: "a".repeat(64),
            },
            report::ProfileReference {
                id: "message-profile".to_owned(),
                content_hash: "b".repeat(64),
            },
            parsed,
            report::Completion {
                status: report::CompletionStatus::Completed,
                completed_at: None,
            },
        )
        .check(outcome_record(0, report::Outcome::Pass))
        .finish()
        .unwrap_or_else(|error| panic!("{note}: {error}"));
        let serialized = serde_json::to_value(&built).expect("the report serializes");
        assert_eq!(serialized["case"], reference, "{note}");
        let reparsed =
            report::parse_run_report(&serialized).unwrap_or_else(|error| panic!("{note}: {error}"));
        assert_eq!(
            serde_json::to_value(reparsed.case()).unwrap(),
            reference,
            "{note}"
        );
    }
    assert!(snapshots_seen, "no valid row states one snapshot");

    for row in invalid {
        let note = row["note"].as_str().expect("a note");
        let mut reference = row["reference"].clone();
        if let Some(snapshot) = reference.get("snapshot").cloned() {
            reference["snapshot"] = materialize(&snapshot);
        }
        let code = row["reason_code"].as_str().expect("a reason code");
        let path = row["field_path"].as_str().expect("a field path");
        let error = report::parse_case_reference(Some(&reference), "/case")
            .err()
            .unwrap_or_else(|| panic!("{note}: the reference was accepted"));
        assert_eq!(error.code.as_str(), code, "{note}: {error}");
        assert_eq!(error.field_path, path, "{note}: {error}");
    }
}

#[test]
fn baseline_rows_pin_the_shadow_baseline_contract() {
    let document = fixture_document("reports/outcomes.json");
    let group = &document["baselines"];
    let valid = group["valid"].as_array().expect("a valid array");
    let invalid = group["invalid"].as_array().expect("an invalid array");
    assert!(valid.len() >= 3, "the fixture group lost valid rows");
    assert!(invalid.len() >= 5, "the fixture group lost invalid rows");

    // The size tokens of the notes materialize before the row crosses.
    let materialize = |baseline: &Value| -> Value {
        let mut value = baseline.clone();
        for (field, token, text) in [
            ("outcome", "o64", "o".repeat(64)),
            ("outcome", "o65", "o".repeat(65)),
            ("revision", "r128", "r".repeat(128)),
            ("revision", "r129", "r".repeat(129)),
        ] {
            if value.get(field).and_then(Value::as_str) == Some(token) {
                value[field] = Value::String(text);
            }
        }
        value
    };

    for row in valid {
        let note = row["note"].as_str().expect("a note");
        let stated = materialize(&row["baseline"]);
        let baseline = report::parse_baseline(&stated, "/baseline")
            .unwrap_or_else(|error| panic!("{note}: {error}"));
        // The baseline crosses one shadow report beside the new outcome, and
        // the stored report parses again with the same two separate facts.
        let built = report::ReportBuilder::new(
            "conformance-000004",
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
                snapshot: None,
            },
            report::Completion {
                status: report::CompletionStatus::Completed,
                completed_at: None,
            },
        )
        .baseline(baseline)
        .check(outcome_record(0, report::Outcome::Pass))
        .finish()
        .unwrap_or_else(|error| panic!("{note}: {error}"));
        // The new outcome stays the aggregate of the component records. The
        // baseline agrees or disagrees on its own, and no field states which.
        assert_eq!(built.aggregate(), report::AggregateOutcome::Pass, "{note}");
        let serialized = serde_json::to_value(&built).expect("the report serializes");
        assert_eq!(serialized["baseline"], stated, "{note}");
        let reparsed =
            report::parse_run_report(&serialized).unwrap_or_else(|error| panic!("{note}: {error}"));
        assert_eq!(
            serde_json::to_value(reparsed.baseline()).unwrap(),
            stated,
            "{note}"
        );
    }

    for row in invalid {
        let note = row["note"].as_str().expect("a note");
        let code = row["reason_code"].as_str().expect("a reason code");
        let path = row["field_path"].as_str().expect("a field path");
        let error = report::parse_baseline(&materialize(&row["baseline"]), "/baseline")
            .err()
            .unwrap_or_else(|| panic!("{note}: the baseline was accepted"));
        assert_eq!(error.code.as_str(), code, "{note}: {error}");
        assert_eq!(error.field_path, path, "{note}: {error}");
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
            None,
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
                    if event["permanent"].as_bool().unwrap_or(false) {
                        // The wrapper declined the retry, so the permanent
                        // failure records its error at the failing attempt.
                        run.fail_permanent(check, code, "The adapter failed the attempt.")
                            .unwrap_or_else(|error| panic!("{note} event {index}: {error}"));
                    } else {
                        let resolution = run
                            .fail_attempt(check, code, "The adapter failed the attempt.")
                            .unwrap_or_else(|error| panic!("{note} event {index}: {error}"));
                        if let AttemptResolution::Exhausted = resolution {
                            skip_codes.insert(code.as_str());
                        }
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

// ---------------------------------------------------------------------------
// Assessment fixtures: every sample against the check that asked for it.
// ---------------------------------------------------------------------------

/// The check identifier of each answer kind, as the fixture definitions use
/// them.
fn assessment_check(kind: &str) -> &'static str {
    match kind {
        "binary" => "adds-information",
        "ordered" => "consequence",
        _ => "message-supported",
    }
}

/// Builds one validated definition with one question check of the stated
/// kind, whose `using` list is the stated one.
fn assessment_definition(kind: &str, using: &[&str]) -> definition::ValidatedDefinition {
    let check = match kind {
        "binary" => json!({
            "id": "adds-information",
            "name": "We are adding something new",
            "using": using,
            "question": "Has the conversation already acknowledged this concern?",
            "answers": {
                "yes": "One participant explicitly recognizes this specific concern.",
                "no": "No supplied message explicitly recognizes this specific concern."
            },
            "accept": "no"
        }),
        "ordered" => json!({
            "id": "consequence",
            "name": "The concern warrants an interruption",
            "using": using,
            "question": "What consequence does this concern have, based on the evidence?",
            "scale": [
                {"minor": "A wording difference with no identified operational consequence."},
                {"meaningful": "A coordination problem causing rework or delay."},
                {"serious": "A conflict affecting an explicit customer commitment."}
            ],
            "accept": {"at_least": "meaningful"}
        }),
        _ => json!({
            "id": "message-supported",
            "name": "Our message accurately describes the evidence",
            "using": using,
            "question": "Does every material claim in the proposed message follow from the evidence?",
            "answers": {
                "supported": "All claims are supported with appropriate certainty and attribution.",
                "contradicted": "A material claim conflicts with the supplied evidence.",
                "incomplete": "Support for a material claim is missing or ambiguous."
            },
            "accept": "supported",
            "review": "incomplete"
        }),
    };
    let artifact = json!({
        "schema_version": 1,
        "name": "assessment-samples",
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
        "checks": [check]
    });
    definition::validate_definition_str(&artifact.to_string())
        .unwrap_or_else(|error| panic!("the fixture definition for {kind} failed: {error}"))
}

#[test]
fn assessment_samples_validate_against_their_checks() {
    let document = fixture_document("assessments/samples.json");
    let valid = document["valid"].as_array().expect("valid records");
    assert!(valid.len() >= 4, "the fixture group lost valid records");
    for record in valid {
        let note = record["note"].as_str().expect("a note");
        let assessment = &record["assessment"];
        let kind = assessment["kind"].as_str().expect("a kind");
        let definition = assessment_definition(
            kind,
            &["prior_decision", "conversation", "proposed_message"],
        );
        measuretwice_core::assessment::validate_assessment(
            &definition,
            assessment_check(kind),
            assessment,
        )
        .unwrap_or_else(|error| panic!("{note}: {error}"));
    }

    let invalid = document["invalid"].as_array().expect("invalid records");
    assert!(invalid.len() >= 6, "the fixture group lost invalid records");
    for record in invalid {
        let note = record["note"].as_str().expect("a note");
        let assessment = &record["assessment"];
        let kind = assessment["kind"].as_str().expect("a kind");
        let using: Vec<&str> = record["using"]
            .as_array()
            .expect("the using list of the check")
            .iter()
            .map(|name| name.as_str().expect("an input name"))
            .collect();
        let definition = assessment_definition(kind, &using);
        let error = measuretwice_core::assessment::validate_assessment(
            &definition,
            assessment_check(kind),
            assessment,
        )
        .err()
        .unwrap_or_else(|| panic!("{note}: the assessment was accepted"));
        let expected = record["expected"]["reason_code"]
            .as_str()
            .expect("an expected reason code");
        assert_eq!(error.code.as_str(), expected, "{note}: {error}");
        // The pointer names the broken rule inside the assessment.
        assert!(
            error.field_path.starts_with("/assessment"),
            "{note}: {}",
            error.field_path
        );
    }
}

// ---------------------------------------------------------------------------
// Policy decisions: every sample and the frozen review record.
// ---------------------------------------------------------------------------

/// Decides one sample of the assessments group under one policy of the
/// `probability_mass_v0` family. The `assessments` map of the sample's kind
/// holds one acceptable and one unacceptable answer, so the cutoffs decide.
fn sample_policy() -> measuretwice_core::report::AppliedPolicy {
    measuretwice_core::report::AppliedPolicy {
        accept_cutoff: 0.75,
        rejection_cutoff: 0.65,
        confidence_floor: None,
    }
}

#[test]
fn assessment_samples_decide_under_the_probability_mass_family() {
    use measuretwice_core::policy;
    use measuretwice_core::report::Outcome;

    let document = fixture_document("assessments/samples.json");
    let valid = document["valid"].as_array().expect("valid records");

    // One row per valid sample: the expected decision of the family, or the
    // expected rejection when the sample states no measurement that the
    // family requires.
    let rows: &[(&str, &str, Outcome)] = &[
        // One label-only categorical answer states no distribution, so the
        // family fails explicitly instead of inventing mass.
        (
            "A label-only categorical assessment",
            "missing",
            Outcome::Review,
        ),
        // The distribution puts 0.82 on the accepted label.
        (
            "A categorical assessment with every optional measurement present.",
            "pass",
            Outcome::Pass,
        ),
        // The binary check accepts no, and the value selects yes.
        (
            "A binary assessment holds a value and nothing else.",
            "fail",
            Outcome::Fail,
        ),
        // The distribution puts 0.9 on the levels from at_least upward.
        (
            "An ordered assessment keeps a fractional position without rounding and reports its distribution over the named levels.",
            "pass",
            Outcome::Pass,
        ),
    ];
    assert_eq!(valid.len(), rows.len(), "the sample table changed");
    for (record, (prefix, decision, expected)) in valid.iter().zip(rows.iter()) {
        let note = record["note"].as_str().expect("a note");
        assert!(
            note.starts_with(prefix),
            "{note} no longer matches {prefix}"
        );
        let assessment = &record["assessment"];
        let kind = assessment["kind"].as_str().expect("a kind");
        let definition = assessment_definition(
            kind,
            &["prior_decision", "conversation", "proposed_message"],
        );
        if decision == &"missing" {
            let error = policy::decide(
                &definition,
                assessment_check(kind),
                assessment,
                &sample_policy(),
            )
            .err()
            .unwrap_or_else(|| panic!("{note}: the assessment without mass was accepted"));
            assert_eq!(error.code, ReasonCode::MissingField, "{note}: {error}");
            assert_eq!(error.field_path, "/assessment/distribution");
            continue;
        }
        let outcome = policy::decide(
            &definition,
            assessment_check(kind),
            assessment,
            &sample_policy(),
        )
        .unwrap_or_else(|error| panic!("{note}: {error}"));
        assert_eq!(
            outcome, *expected,
            "{note}: expected the decision {decision}"
        );
        assert_eq!(outcome.as_str(), *decision, "{note}");
    }
}

#[test]
fn the_frozen_review_record_reproduces_through_the_policy() {
    use measuretwice_core::policy;
    use measuretwice_core::report::Outcome;

    // The review sample of the outcomes group states one label-only
    // categorical assessment of the check message-supported with one applied
    // policy. The selected label is one declared review label, so the family
    // reproduces the frozen outcome without reading any mass.
    let document = fixture_document("reports/outcomes.json");
    let sample = document["check_records"]
        .as_array()
        .expect("a record array")
        .iter()
        .find(|sample| sample["record"]["applied_policy"].is_object())
        .expect("one question record with one applied policy");
    let record = &sample["record"];
    let applied = &record["applied_policy"];
    let parameters = measuretwice_core::report::AppliedPolicy {
        accept_cutoff: applied["accept_cutoff"].as_f64().expect("an accept cutoff"),
        rejection_cutoff: applied["rejection_cutoff"]
            .as_f64()
            .expect("a rejection cutoff"),
        confidence_floor: applied["confidence_floor"].as_f64(),
    };
    let definition = assessment_definition(
        "categorical",
        &["prior_decision", "conversation", "proposed_message"],
    );
    let outcome = policy::decide(
        &definition,
        record["check"].as_str().expect("a check"),
        &record["assessment"],
        &parameters,
    )
    .unwrap_or_else(|error| panic!("the frozen record decides: {error}"));
    assert_eq!(
        outcome,
        Outcome::from_word(record["outcome"].as_str().expect("an outcome"))
            .expect("a contract outcome")
    );
    assert_eq!(outcome, Outcome::Review);
}

// ---------------------------------------------------------------------------
// Calibration plans.
// ---------------------------------------------------------------------------

/// Loads one dataset of the plans group by its role: `primary` or `other`.
fn plan_dataset(document: &Value, role: &str) -> dataset::Dataset {
    let field = match role {
        "primary" => "dataset",
        "other" => "other_dataset",
        other => panic!("one stated dataset role: {other}"),
    };
    dataset::load_dataset(
        &serde_json::to_string(&document[field]).expect("the metadata serializes"),
        document[&format!("{field}_records")]
            .as_str()
            .expect("the records text"),
    )
    .expect("the dataset loads")
}

/// Returns one split identity of the plans group. One plain name names one
/// split of the primary dataset; `other:<split>` names one split of the
/// second dataset.
fn plan_split(document: &Value, name: &str) -> splits::SplitIdentity {
    let (role, split) = match name.split_once(':') {
        Some(("other", split)) => ("other", split),
        _ => ("primary", name),
    };
    let loaded = plan_dataset(document, role);
    let grouped = splits::dataset_splits(&loaded).expect("the splits compute");
    grouped
        .split(split)
        .unwrap_or_else(|| panic!("one declared split: {split}"))
        .identity()
        .clone()
}

/// Reads one stated plan of the plans group by its identifier.
fn stated_plan(document: &Value, id: &str) -> Value {
    document["plans"]
        .as_array()
        .expect("a plan array")
        .iter()
        .find(|plan| plan["id"].as_str() == Some(id))
        .cloned()
        .unwrap_or_else(|| panic!("no stated plan holds the identifier {id}"))
}

/// The plans group pins the artifact contract, the stored self-hash, and the
/// derived facts of every valid plan, as the fixture manifest states.
#[test]
fn calibration_plans_validate_with_their_identity_and_derived_facts() {
    let document = fixture_document("plans/validation.json");
    let plans = document["plans"].as_array().expect("a plan array");
    assert!(plans.len() >= 4, "the fixture group lost plans");

    for plan in plans {
        let id = plan["id"].as_str().expect("an identifier");
        let validated = plan::validate_plan(plan).unwrap_or_else(|error| panic!("{id}: {error}"));

        // The computed identity covers the artifact with its own digest
        // removed, and one stored digest must equal it.
        let computed = hashing::compute_self_hash(Domain::Plan, plan).expect("one object");
        assert_eq!(validated.content_hash(), computed, "{id}");
        if let Some(stored) = plan["content_hash"].as_str() {
            assert_eq!(validated.stored_content_hash(), Some(stored), "{id}");
            hashing::verify_self_hash(Domain::Plan, plan)
                .unwrap_or_else(|error| panic!("{id}: {error}"));
        } else {
            assert_eq!(validated.stored_content_hash(), None, "{id}");
        }
        // The accessors agree with the artifact on every read field.
        assert_eq!(validated.id(), id);
        assert_eq!(
            validated.definition_name(),
            plan["definition"]["name"].as_str().expect("a name"),
            "{id}"
        );
        assert_eq!(
            validated
                .constraints()
                .iter()
                .map(|constraint| constraint.metric.as_str())
                .collect::<Vec<_>>(),
            plan["constraints"]
                .as_array()
                .expect("constraints")
                .iter()
                .map(|constraint| constraint["metric"].as_str().expect("a metric"))
                .collect::<Vec<_>>(),
            "{id}"
        );

        // The derived facts of the group pin the enumeration order and the
        // stated goal set.
        let facts = &document["facts"][id];
        assert!(
            !facts.is_null(),
            "{id}: the group states no facts for this plan"
        );
        assert_eq!(
            validated.candidate_count(),
            facts["candidate_count"].as_u64().expect("a count") as usize,
            "{id}"
        );
        let candidates: Vec<Value> = validated
            .candidates()
            .iter()
            .map(|candidate| {
                json!({
                    "accept_cutoff": candidate.accept_cutoff,
                    "rejection_cutoff": candidate.rejection_cutoff,
                    "confidence_floor": candidate.confidence_floor,
                })
            })
            .collect();
        assert_eq!(
            candidates.len(),
            facts["candidate_count"].as_u64().expect("a count") as usize,
            "{id}"
        );
        let stated = facts["candidates"].as_array().expect("the candidate order");
        for (index, expected) in stated.iter().enumerate() {
            assert_eq!(
                serde_json::to_value(&candidates[index]).expect("serializes"),
                json!({
                    "accept_cutoff": expected["accept_cutoff"],
                    "rejection_cutoff": expected["rejection_cutoff"],
                    "confidence_floor": expected["confidence_floor"],
                }),
                "{id}: candidate {index}"
            );
        }
        let objective = validated.objective();
        assert_eq!(
            json!({
                "metric": objective.metric.as_str(),
                "direction": objective.direction.as_str(),
            }),
            facts["objective"],
            "{id}"
        );
        assert_eq!(
            validated.confidence_level().as_f64(),
            facts["confidence_level"].as_f64().expect("a level"),
            "{id}"
        );
        assert_eq!(
            validated.minimum_samples().keys().collect::<Vec<_>>(),
            facts["denominators"]
                .as_array()
                .expect("denominator names")
                .iter()
                .map(|name| name.as_str().expect("a name"))
                .collect::<Vec<_>>(),
            "{id}"
        );
    }

    // One edited copy of one stored plan fails its digest, and one stripped
    // copy loses the digest field first.
    let mut edited = stated_plan(&document, "message-supported-calibration");
    edited["intended_population"] = Value::String("Edited after hashing.".to_owned());
    let error = plan::validate_plan(&edited).expect_err("the edited copy was accepted");
    assert_eq!(error.code, ReasonCode::HashMismatch, "{error}");
    assert_eq!(error.field_path, "/content_hash");

    // A plan without one stored digest still states its computed identity,
    // so the calibration output can record it.
    let unhashed = stated_plan(&document, "message-supported-review-plan");
    let validated = plan::validate_plan(&unhashed).expect("the plan validates");
    assert_eq!(validated.stored_content_hash(), None);
    assert_eq!(
        validated.content_hash(),
        document["facts"]["message-supported-review-plan"]["content_hash"]
            .as_str()
            .expect("a computed digest")
    );
}

/// Every invalid plan of the group rejects with its stated reason code and
/// field path, before the stored digest is read.
#[test]
fn invalid_calibration_plans_reject_with_their_stated_codes() {
    let document = fixture_document("plans/validation.json");
    let invalid = document["invalid"].as_array().expect("an invalid array");
    assert!(
        invalid.len() >= 30,
        "the fixture group lost invalid records"
    );

    let mut covered = BTreeSet::new();
    for record in invalid {
        let expected = &record["expected"];
        let error = plan::validate_plan(&record["plan"])
            .err()
            .unwrap_or_else(|| panic!("{}: the plan was accepted", record["note"]));
        assert_eq!(
            error.code.as_str(),
            expected["reason_code"].as_str().expect("a code"),
            "{}: {error}",
            record["note"]
        );
        assert_eq!(
            error.field_path,
            expected["field_path"].as_str().expect("a path"),
            "{}: {error}",
            record["note"]
        );
        covered.insert(error.code.as_str().to_owned());
    }
    // The group covers every validation code the plan boundary states.
    for code in [
        "unsupported_schema_version",
        "unknown_field",
        "missing_field",
        "invalid_field_type",
        "duplicate_id",
        "hash_mismatch",
    ] {
        assert!(covered.contains(code), "the group covers no {code} row");
    }
}

/// Every binding row of the group pairs one valid plan with the loaded
/// definition, the loaded split identities, or the registered evaluators.
#[test]
fn calibration_plan_bindings_check_definition_datasets_and_evaluator() {
    let document = fixture_document("plans/validation.json");
    let bindings = document["bindings"].as_array().expect("a bindings array");
    assert!(bindings.len() >= 8, "the fixture group lost binding rows");

    let mut definition_cache: BTreeMap<String, definition::ValidatedDefinition> = BTreeMap::new();
    let mut loaded = 0;
    for row in bindings {
        let note = row["note"].as_str().expect("a note");
        let artifact = match row.get("plan_id") {
            Some(Value::String(id)) => stated_plan(&document, id),
            _ => row["plan"].clone(),
        };
        let plan = plan::validate_plan(&artifact).unwrap_or_else(|error| {
            panic!("{note}: the pairing plan is no valid artifact: {error}")
        });

        let mut failure: Option<measuretwice_core::error::ValidationError> = None;
        if let Some(Value::String(name)) = row.get("definition") {
            let definition = definition_cache
                .entry(name.clone())
                .or_insert_with(|| {
                    let text = fs::read_to_string(fixture(&format!("definitions/valid/{name}")))
                        .unwrap_or_else(|error| panic!("{name}: {error}"));
                    definition::validate_definition_str(&text)
                        .unwrap_or_else(|error| panic!("{name}: {error}"))
                })
                .clone();
            failure = plan::check_plan_definition(&plan, &definition, "/plan").err();
        }
        if failure.is_none() && row.get("fitting").is_some() {
            let fitting = plan_split(&document, row["fitting"].as_str().expect("a split"));
            let validation = plan_split(&document, row["validation"].as_str().expect("a split"));
            failure = plan::check_plan_datasets(&plan, &fitting, &validation, "/plan").err();
        }
        if failure.is_none() && row.get("evaluators").is_some() {
            let registered = plan::parse_registered_evaluators(&row["evaluators"], "/evaluators")
                .unwrap_or_else(|error| panic!("{note}: {error}"));
            failure = plan::check_plan_evaluator(&plan, &registered, "/plan").err();
        }

        match (row.get("expected"), failure) {
            (Some(expected), Some(error)) => {
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
            }
            (Some(expected), None) => {
                panic!(
                    "{}: the pairing loaded, expected {}",
                    note, expected["reason_code"]
                );
            }
            (None, Some(error)) => panic!("{note}: the pairing refused one load: {error}"),
            (None, None) => loaded += 1,
        }
    }
    assert!(loaded >= 1, "the group states no pairing that loads");
}

// ---------------------------------------------------------------------------
// Fitting search fixtures (task T048).
// ---------------------------------------------------------------------------

/// Loads the shared definition of the fitting group and validates it.
fn fitting_definition(document: &Value) -> definition::ValidatedDefinition {
    let name = document["definition"].as_str().expect("a definition file");
    let text = fs::read_to_string(fixture(&format!("definitions/valid/{name}")))
        .unwrap_or_else(|error| panic!("{name}: {error}"));
    definition::validate_definition_str(&text).unwrap_or_else(|error| panic!("{name}: {error}"))
}

/// Loads the shared dataset of the fitting group.
fn fitting_dataset(document: &Value) -> dataset::Dataset {
    dataset::load_dataset(
        &serde_json::to_string(&document["dataset"]).expect("the metadata serializes"),
        document["dataset_records"]
            .as_str()
            .expect("the records text"),
    )
    .expect("the dataset loads")
}

/// Compares one computed goal row with one stated fixture expectation. The
/// expectation states the metric, the met flag, the counts of the rate, the
/// observed value and the upper bound, and the evidence state.
fn assert_constraint_fit(computed: &fitting::ConstraintFit, stated: &Value, note: &str) {
    let metric = computed.metric.as_str();
    assert_eq!(
        metric,
        stated["metric"].as_str().expect("a metric word"),
        "{note}"
    );
    assert_eq!(
        computed.met,
        stated["met"].as_bool().expect("a met flag"),
        "{note}"
    );
    assert_eq!(
        computed.numerator,
        stated["numerator"].as_u64().expect("a numerator") as usize,
        "{note}: {metric}"
    );
    assert_eq!(
        computed.denominator,
        stated["denominator"].as_u64().expect("a denominator") as usize,
        "{note}: {metric}"
    );
    match (computed.observed, stated["observed"].as_f64()) {
        (Some(observed), Some(expected)) => assert_bound(observed, &json!(expected), note),
        (None, None) => {}
        pair => panic!("{note}: {metric}: the observed value states {pair:?}"),
    }
    match (computed.upper_bound, stated["upper_bound"].as_f64()) {
        (Some(bound), Some(expected)) => assert_bound(bound, &json!(expected), note),
        (None, None) => {}
        pair => panic!("{note}: {metric}: the upper bound states {pair:?}"),
    }
    match computed.evidence {
        fitting::ConstraintEvidence::Measured => {
            assert_eq!(stated["evidence"], json!("measured"), "{note}: {metric}");
        }
        fitting::ConstraintEvidence::ZeroDenominator => {
            assert_eq!(
                stated["evidence"],
                json!("zero_denominator"),
                "{note}: {metric}"
            );
        }
        fitting::ConstraintEvidence::BelowMinimum {
            stated: minimum,
            measured: count,
        } => {
            assert_eq!(
                stated["evidence"],
                json!("below_minimum"),
                "{note}: {metric}"
            );
            assert_eq!(
                (minimum, count),
                (
                    stated["stated"].as_u64().expect("a stated minimum") as usize,
                    stated["measured"].as_u64().expect("a measured count") as usize,
                ),
                "{note}: {metric}"
            );
        }
    }
}

/// Compares one computed candidate row with one stated fixture expectation.
/// The expectation states the enumeration index, the candidate, the feasible
/// flag, the objective counts, the unmet metric words, and the evidence
/// states of every goal.
fn assert_candidate_fit(computed: &fitting::CandidateFit, stated: &Value, note: &str) {
    assert_eq!(
        computed.index,
        stated["index"].as_u64().expect("an index") as usize,
        "{note}"
    );
    assert_eq!(
        serde_json::to_value(computed.candidate).expect("serializes"),
        stated["candidate"],
        "{note}"
    );
    assert_eq!(
        computed.feasible,
        stated["feasible"].as_bool().expect("a feasible flag"),
        "{note}"
    );
    assert_eq!(
        (computed.objective.numerator, computed.objective.denominator),
        (
            stated["objective"]["numerator"]
                .as_u64()
                .expect("a numerator") as usize,
            stated["objective"]["denominator"]
                .as_u64()
                .expect("a denominator") as usize,
        ),
        "{note}"
    );
    let unmet: Vec<&str> = computed
        .constraints
        .iter()
        .filter(|row| !row.met)
        .map(|row| row.metric.as_str())
        .collect();
    let stated_unmet: Vec<&str> = stated["unmet"]
        .as_array()
        .expect("the unmet metric words")
        .iter()
        .map(|word| word.as_str().expect("a metric word"))
        .collect();
    assert_eq!(unmet, stated_unmet, "{note}");
    let evidence: Vec<&str> = computed
        .constraints
        .iter()
        .map(|row| match row.evidence {
            fitting::ConstraintEvidence::Measured => "measured",
            fitting::ConstraintEvidence::ZeroDenominator => "zero_denominator",
            fitting::ConstraintEvidence::BelowMinimum { .. } => "below_minimum",
        })
        .collect();
    let stated_evidence: Vec<&str> = stated["evidence"]
        .as_array()
        .expect("the evidence words")
        .iter()
        .map(|word| word.as_str().expect("an evidence word"))
        .collect();
    assert_eq!(evidence, stated_evidence, "{note}");
}

/// The fitting group pins the selection, the status, and the goal rows of
/// every valid plan, as the fixture manifest states: one known feasible
/// candidate, one tie between two cutoffs that decide the same outcomes,
/// two conflicting goals, one unachievable goal, one plan minimum that
/// gates one goal, and one upper-bound basis.
#[test]
fn fitting_search_rows_pin_selection_status_and_goal_rows() {
    let document = fixture_document("fitting/search.json");
    let definition = fitting_definition(&document);
    let loaded = fitting_dataset(&document);
    let validated = dataset::validate_dataset(&loaded, &definition)
        .unwrap_or_else(|error| panic!("the dataset validates: {error}"));
    let assessments = &document["assessments"];
    let plans = document["plans"].as_array().expect("a plan array");
    assert!(plans.len() >= 6, "the fixture group lost plans");

    for artifact in plans {
        let id = artifact["id"].as_str().expect("an identifier");
        let plan = plan::validate_plan(artifact).unwrap_or_else(|error| panic!("{id}: {error}"));
        let report = fitting::fit_policy(&plan, &validated, assessments)
            .unwrap_or_else(|error| panic!("{id}: {error}"));
        let facts = &document["facts"][id];
        assert!(!facts.is_null(), "{id}: the group states no facts");

        // The status, the counts, and the fitting-split identity.
        assert_eq!(
            report.status.as_str(),
            facts["status"].as_str().expect("a status"),
            "{id}"
        );
        assert_eq!(
            report.case_count,
            facts["case_count"].as_u64().expect("a case count") as usize,
            "{id}"
        );
        assert_eq!(
            report.candidate_count,
            facts["candidate_count"]
                .as_u64()
                .expect("a candidate count") as usize,
            "{id}"
        );
        assert_eq!(
            report.split_content_hash,
            facts["split_content_hash"]
                .as_str()
                .expect("a split digest"),
            "{id}"
        );
        assert_eq!(report.plan_id, id);
        assert_eq!(report.method, fitting::METHOD);
        assert_eq!(report.interval_method, intervals::METHOD);
        assert_eq!(report.statement, fitting::DEVELOPMENT_EVIDENCE_STATEMENT);
        assert_eq!(
            serde_json::to_value(report.objective).expect("serializes"),
            artifact["objective"],
            "{id}"
        );

        // The selected candidate, or the valid absence of one.
        match (report.selected(), facts["selected"].is_null()) {
            (Some(selected), false) => {
                let stated = &facts["selected"];
                assert_eq!(
                    selected.index,
                    stated["index"].as_u64().expect("an index") as usize,
                    "{id}"
                );
                assert_eq!(
                    serde_json::to_value(selected.candidate).expect("serializes"),
                    stated["candidate"],
                    "{id}"
                );
                assert_eq!(
                    selected.objective.metric.as_str(),
                    stated["objective"]["metric"]
                        .as_str()
                        .expect("a metric word"),
                    "{id}"
                );
                assert_eq!(
                    (selected.objective.numerator, selected.objective.denominator),
                    (
                        stated["objective"]["numerator"]
                            .as_u64()
                            .expect("a numerator") as usize,
                        stated["objective"]["denominator"]
                            .as_u64()
                            .expect("a denominator") as usize,
                    ),
                    "{id}"
                );
                assert_bound(
                    selected.objective.value.expect("the objective value"),
                    &stated["objective"]["value"],
                    id,
                );
                let rows = stated["constraints"]
                    .as_array()
                    .expect("the stated goal rows");
                assert_eq!(selected.constraints.len(), rows.len(), "{id}");
                for (row, stated_row) in selected.constraints.iter().zip(rows) {
                    let note = format!("{id}: the selected goal row");
                    assert_constraint_fit(row, stated_row, &note);
                }
                let scopes = stated["scopes"].as_array().expect("the stated scopes");
                assert_eq!(selected.scopes.len(), scopes.len(), "{id}");
                for (set, stated_set) in selected.scopes.iter().zip(scopes) {
                    assert_eq!(
                        set.scope,
                        stated_set["scope"].as_str().expect("a scope"),
                        "{id}"
                    );
                    assert_eq!(
                        serde_json::to_value(set.counts).expect("serializes"),
                        stated_set["counts"],
                        "{id}: {}",
                        set.scope
                    );
                }
            }
            (None, true) => {}
            pair => panic!("{id}: the selected candidate states {pair:?}"),
        }

        // Every enumerated candidate, feasible or not.
        let rows = facts["candidates"]
            .as_array()
            .expect("the stated candidates");
        assert_eq!(report.candidates.len(), rows.len(), "{id}");
        for (fit, stated) in report.candidates.iter().zip(rows) {
            let note = format!("{id}: candidate {}", fit.index);
            assert_candidate_fit(fit, stated, &note);
        }
    }

    // The tie row stays explicit: two feasible candidates state the same
    // objective counts and the first in the declared order wins.
    let tie = &document["facts"]["tie-plan"];
    let first = &tie["candidates"][0];
    let second = &tie["candidates"][1];
    assert_eq!(
        first["objective"], second["objective"],
        "the tie states equal counts"
    );
    assert_eq!(
        tie["selected"]["index"],
        json!(0),
        "the tie takes the first candidate"
    );
}

/// Every invalid row of the fitting group rejects with its stated reason
/// code and field path, before any candidate is enumerated.
#[test]
fn invalid_fitting_rows_reject_with_their_stated_codes() {
    let document = fixture_document("fitting/search.json");
    let definition = fitting_definition(&document);
    let loaded = fitting_dataset(&document);
    let validated = dataset::validate_dataset(&loaded, &definition)
        .unwrap_or_else(|error| panic!("the dataset validates: {error}"));
    let invalid = document["invalid"].as_array().expect("an invalid array");
    assert!(invalid.len() >= 6, "the fixture group lost invalid rows");

    for row in invalid {
        let note = row["note"].as_str().expect("a note");
        let artifact = match row.get("plan") {
            Some(plan) => plan.clone(),
            None => stated_plan(
                &document,
                row["plan_id"].as_str().expect("a plan identifier"),
            ),
        };
        let plan = plan::validate_plan(&artifact)
            .unwrap_or_else(|error| panic!("{note}: the plan itself must validate: {error}"));
        let assessments = row.get("assessments").unwrap_or(&document["assessments"]);
        let error = fitting::fit_policy(&plan, &validated, assessments)
            .err()
            .unwrap_or_else(|| panic!("{note}: the fitting search was accepted"));
        let expected = &row["expected"];
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
    }
}

// ---------------------------------------------------------------------------
// Frozen validation fixtures (task T049).
// ---------------------------------------------------------------------------

/// Loads the shared definition of the qualification group and validates it.
fn qualification_definition(document: &Value) -> definition::ValidatedDefinition {
    let name = document["definition"].as_str().expect("a definition file");
    let text = fs::read_to_string(fixture(&format!("definitions/valid/{name}")))
        .unwrap_or_else(|error| panic!("{name}: {error}"));
    definition::validate_definition_str(&text).unwrap_or_else(|error| panic!("{name}: {error}"))
}

/// One loaded dataset of the qualification group: the metadata artifact, the
/// records text, and the parsed dataset, so one validated view can borrow
/// all three inside one test.
struct QualificationDataset {
    dataset: dataset::Dataset,
}

impl QualificationDataset {
    /// Loads the primary dataset or the correlated one.
    fn load(document: &Value, correlated: bool) -> Self {
        let (metadata, records) = if correlated {
            (
                &document["other_dataset"],
                &document["other_dataset_records"],
            )
        } else {
            (&document["dataset"], &document["dataset_records"])
        };
        let metadata_text = serde_json::to_string(metadata).expect("the metadata serializes");
        let dataset =
            dataset::load_dataset(&metadata_text, records.as_str().expect("the records text"))
                .unwrap_or_else(|error| panic!("the dataset loads: {error}"));
        Self { dataset }
    }

    /// Validates the dataset against one definition.
    fn validated<'a>(
        &'a self,
        definition: &'a definition::ValidatedDefinition,
    ) -> dataset::ValidatedDataset<'a> {
        dataset::validate_dataset(&self.dataset, definition)
            .unwrap_or_else(|error| panic!("the dataset validates: {error}"))
    }
}

/// Builds one validation request of the qualification group: the default
/// request of the document, the per-plan override when one exists, and the
/// split identities the `previously_used` names state.
fn qualification_request(
    document: &Value,
    plan_id: &str,
    loaded: &QualificationDataset,
) -> qualification::ValidationRequest {
    let mut stated = document["requests"]
        .get(plan_id)
        .unwrap_or(&document["request"])
        .clone();
    // The fixture states the used splits by name; the boundary reads split
    // identities, so the names resolve against the loaded dataset first.
    let used_names = stated
        .as_object_mut()
        .expect("one request object")
        .remove("previously_used")
        .map(|names| names.as_array().expect("an array").clone());
    let mut request = qualification::parse_validation_request(&stated)
        .unwrap_or_else(|error| panic!("{plan_id}: the request parses: {error}"));
    if let Some(used) = used_names {
        let grouped = splits::dataset_splits(&loaded.dataset).expect("the splits compute");
        let mut identities = Vec::with_capacity(used.len());
        for name in used {
            let split = name.as_str().expect("one split name");
            identities.push(
                grouped
                    .splits()
                    .iter()
                    .find(|entry| entry.identity().split_id == split)
                    .unwrap_or_else(|| panic!("{plan_id}: the dataset declares no {split}"))
                    .identity()
                    .clone(),
            );
        }
        request.previously_used = identities;
    }
    request
}

/// Runs one plan of the qualification group through the fit and the frozen
/// validation, and states the computed facts of the result.
fn qualification_facts(report: &qualification::QualificationReport) -> Value {
    let goals: Vec<Value> = report
        .goals
        .iter()
        .map(|goal| {
            let mut row = json!({
                "metric": goal.metric.as_str(),
                "met": goal.met,
                "numerator": goal.numerator,
                "denominator": goal.denominator,
                "observed": goal.observed,
                "upper_bound": goal.upper_bound,
                "draws": goal.draws,
                "evidence": match goal.evidence {
                    qualification::GoalEvidence::Measured => json!("measured"),
                    qualification::GoalEvidence::ZeroDenominator => json!("zero_denominator"),
                    qualification::GoalEvidence::UnsupportedSampling => {
                        json!("unsupported_sampling")
                    }
                    qualification::GoalEvidence::BelowMinimum { stated, measured } => {
                        json!({"below_minimum": {"stated": stated, "measured": measured}})
                    }
                }
            });
            if let qualification::GoalEvidence::BelowMinimum { stated, measured } = goal.evidence {
                row["stated"] = json!(stated);
                row["measured"] = json!(measured);
            }
            row
        })
        .collect();
    let requirements: Vec<Value> = report
        .sample_requirements
        .iter()
        .map(|row| {
            json!({
                "denominator": row.denominator,
                "stated": row.stated,
                "measured": row.measured,
                "met": row.met,
            })
        })
        .collect();
    let slices: Vec<Value> = report
        .slices
        .iter()
        .map(|row| {
            json!({
                "tag": row.tag,
                "met": row.met,
                "denominators": row.denominators,
            })
        })
        .collect();
    let reasons: Vec<&str> = report.reasons.iter().map(|row| row.code.as_str()).collect();
    json!({
        "status": report.status.as_str(),
        "reasons": reasons,
        "evidence_class": report.evidence.class.as_str(),
        "case_count": report.case_count,
        "candidate_index": report.candidate_index,
        "candidate": report.candidate,
        "applied": report.applied,
        "goals": goals,
        "sample_requirements": requirements,
        "slices": slices,
        "counts": report
            .scopes
            .iter()
            .find(|set| set.scope == metrics::ALL_CHECKS)
            .map(|set| set.counts)
            .value_or_null(),
    })
}

/// One temporary value helper: `None` states null.
trait ValueOrNull {
    fn value_or_null(&self) -> Value;
}

impl ValueOrNull for Option<metrics::OutcomeCounts> {
    fn value_or_null(&self) -> Value {
        match self {
            Some(counts) => serde_json::to_value(counts).expect("the counts serialize"),
            None => Value::Null,
        }
    }
}

/// Runs one plan row of the qualification group through the fit and the
/// frozen validation, with the row's stated overrides applied.
fn qualification_row(
    document: &Value,
    primary: &QualificationDataset,
    correlated: &QualificationDataset,
    artifact: &Value,
    fit_of: Option<&Value>,
    patch: Option<&Value>,
    assessment_patch: Option<&Value>,
) -> Result<qualification::QualificationReport, measuretwice_core::error::ValidationError> {
    let definition = qualification_definition(document);
    let primary_validated = primary.validated(&definition);
    let correlated_validated = correlated.validated(&definition);
    let uses_primary =
        artifact["datasets"]["fitting"]["dataset"].as_str() == Some("qualification-cases");
    let (loaded, validated) = if uses_primary {
        (primary, &primary_validated)
    } else {
        (correlated, &correlated_validated)
    };

    let plan = plan::validate_plan(artifact)
        .unwrap_or_else(|error| panic!("{}: the row plan validates: {error}", artifact["id"]));
    let fit_source = fit_of.unwrap_or(artifact);
    let fit_plan = plan::validate_plan(fit_source)
        .unwrap_or_else(|error| panic!("{}: the fit plan validates: {error}", fit_source["id"]));
    let mut fit = fitting::fit_policy(&fit_plan, validated, &document["fitting_assessments"])
        .unwrap_or_else(|error| panic!("{}: the fit runs: {error}", fit_source["id"]));
    if let Some(patch) = patch {
        if let Some(hash) = patch["definition_hash"].as_str() {
            fit.definition_hash = hash.to_owned();
        }
        if let Some(split) = patch["split"].as_str() {
            fit.split = split.to_owned();
        }
        if let Some(hash) = patch["split_content_hash"].as_str() {
            fit.split_content_hash = hash.to_owned();
        }
        if let Some(accept) = patch["candidate_accept"].as_f64() {
            fit.selected
                .as_mut()
                .expect("one candidate")
                .candidate
                .accept_cutoff = accept;
        }
        if let Some(index) = patch["candidate_index"].as_u64() {
            fit.selected.as_mut().expect("one candidate").index = index as usize;
        }
    }

    let request = qualification_request(document, plan.id(), loaded);
    let mut assessments = document["assessment_overrides"]
        .get(plan.id())
        .cloned()
        .unwrap_or(match artifact["datasets"]["fitting"]["dataset"].as_str() {
            Some("qualification-cases") => document["assessments"].clone(),
            _ => document["other_assessments"].clone(),
        });
    if let Some(Value::Object(fields)) = assessment_patch.cloned() {
        if let Some(added) = fields.get("add").and_then(Value::as_object) {
            for (case, entry) in added {
                assessments[case] = entry.clone();
            }
        }
        if let Some(removed) = fields.get("remove").and_then(Value::as_str) {
            assessments
                .as_object_mut()
                .expect("one assessment object")
                .remove(removed);
        }
    }
    qualification::qualify_candidate(&plan, validated, &fit, &request, &assessments)
}

/// The qualification group pins the status, the reasons, the goal rows, the
/// sample requirements, and the slice floors of every valid plan, as the
/// fixture manifest states: one validated scope on the observed value, one
/// on the upper confidence bound, one unmet goal with the frozen candidate
/// unchanged, one plan minimum above the validation counts, one important
/// slice below its floor, one reused holdout, one correlated-group
/// validation under independent cases, and the same validation under
/// grouped cases.
#[test]
fn qualification_rows_pin_status_reasons_and_goal_rows() {
    let document = fixture_document("qualification/validation.json");
    let primary = QualificationDataset::load(&document, false);
    let correlated = QualificationDataset::load(&document, true);
    let plans = document["plans"].as_array().expect("a plan array");
    assert!(plans.len() >= 8, "the fixture group lost plans");

    let mut covered: BTreeSet<String> = BTreeSet::new();
    for artifact in plans {
        let id = artifact["id"].as_str().expect("an identifier");
        let report =
            qualification_row(&document, &primary, &correlated, artifact, None, None, None)
                .unwrap_or_else(|error| panic!("{id}: {error}"));
        let facts = &document["facts"][id];
        assert!(!facts.is_null(), "{id}: the group states no facts");

        // The status, the reasons in decision order, and the evidence class.
        assert_eq!(
            report.status.as_str(),
            facts["status"].as_str().expect("a status"),
            "{id}"
        );
        assert_ne!(report.status.as_str(), "unvalidated", "{id}");
        let codes: Vec<&str> = report.reasons.iter().map(|row| row.code.as_str()).collect();
        let stated: Vec<&str> = facts["reasons"]
            .as_array()
            .expect("the reason codes")
            .iter()
            .map(|code| code.as_str().expect("a code"))
            .collect();
        assert_eq!(codes, stated, "{id}");
        assert_eq!(
            report.evidence.class.as_str(),
            facts["evidence_class"].as_str().expect("a class"),
            "{id}"
        );
        covered.insert(report.status.as_str().to_owned());

        // The frozen candidate and its position, unchanged by the validation.
        assert_eq!(
            report.candidate_index,
            facts["candidate_index"].as_u64().expect("an index") as usize,
            "{id}"
        );
        assert_eq!(
            serde_json::to_value(report.candidate).expect("serializes"),
            facts["candidate"],
            "{id}"
        );
        assert_eq!(
            serde_json::to_value(report.applied).expect("serializes"),
            facts["applied"],
            "{id}"
        );
        assert_eq!(report.method, qualification::METHOD, "{id}");
        assert_eq!(report.statement, qualification::CANDIDATE_STATEMENT, "{id}");
        assert_eq!(
            report.case_count,
            facts["case_count"].as_u64().expect("a count") as usize,
            "{id}"
        );

        // One row per declared goal, with the counts, the bounds, and the
        // evidence state.
        let goals = facts["goals"].as_array().expect("the goal rows");
        assert_eq!(report.goals.len(), goals.len(), "{id}");
        for (computed, stated) in report.goals.iter().zip(goals) {
            assert_eq!(
                computed.metric.as_str(),
                stated["metric"].as_str().expect("a metric"),
                "{id}"
            );
            assert_eq!(
                computed.met,
                stated["met"].as_bool().expect("a flag"),
                "{id}"
            );
            assert_eq!(
                (computed.numerator, computed.denominator, computed.draws),
                (
                    stated["numerator"].as_u64().expect("a numerator") as usize,
                    stated["denominator"].as_u64().expect("a denominator") as usize,
                    stated["draws"].as_u64().expect("the draws") as usize
                ),
                "{id}"
            );
            match (computed.observed, stated["observed"].as_f64()) {
                (Some(observed), Some(expected)) => assert_bound(observed, &json!(expected), id),
                (None, None) => {}
                pair => panic!("{id}: the observed value states {pair:?}"),
            }
            match (computed.upper_bound, stated["upper_bound"].as_f64()) {
                (Some(bound), Some(expected)) => assert_bound(bound, &json!(expected), id),
                (None, None) => {}
                pair => panic!("{id}: the upper bound states {pair:?}"),
            }
            match computed.evidence {
                qualification::GoalEvidence::Measured => {
                    assert_eq!(stated["evidence"], json!("measured"), "{id}");
                }
                qualification::GoalEvidence::ZeroDenominator => {
                    assert_eq!(stated["evidence"], json!("zero_denominator"), "{id}");
                }
                qualification::GoalEvidence::UnsupportedSampling => {
                    assert_eq!(stated["evidence"], json!("unsupported_sampling"), "{id}");
                }
                qualification::GoalEvidence::BelowMinimum {
                    stated: floor,
                    measured,
                } => {
                    assert_eq!(
                        stated["evidence"],
                        json!({"below_minimum": {"stated": floor, "measured": measured}}),
                        "{id}"
                    );
                }
            }
        }

        // The sample requirements and the important slices.
        let requirements = facts["sample_requirements"]
            .as_array()
            .expect("the requirement rows");
        assert_eq!(report.sample_requirements.len(), requirements.len(), "{id}");
        for (computed, stated) in report.sample_requirements.iter().zip(requirements) {
            assert_eq!(
                (
                    computed.denominator.as_str(),
                    computed.stated,
                    computed.measured,
                    computed.met
                ),
                (
                    stated["denominator"].as_str().expect("a denominator"),
                    stated["stated"].as_u64().expect("a minimum") as usize,
                    stated["measured"].as_u64().expect("a count") as usize,
                    stated["met"].as_bool().expect("a flag")
                ),
                "{id}"
            );
        }
        let slices = facts["slices"].as_array().expect("the slice rows");
        assert_eq!(report.slices.len(), slices.len(), "{id}");
        for (computed, stated) in report.slices.iter().zip(slices) {
            assert_eq!(computed.tag, stated["tag"].as_str().expect("a tag"), "{id}");
            assert_eq!(
                computed.met,
                stated["met"].as_bool().expect("a flag"),
                "{id}"
            );
            assert_eq!(
                serde_json::to_value(&computed.denominators).expect("serializes"),
                stated["denominators"],
                "{id}"
            );
        }

        // The predicted outcome counts of the complete check set.
        let counts = report
            .scopes
            .iter()
            .find(|set| set.scope == metrics::ALL_CHECKS)
            .map(|set| serde_json::to_value(set.counts).expect("serializes"));
        assert_eq!(counts, Some(facts["counts"].clone()), "{id}");
    }
    // The group covers the three statuses one frozen validation computes.
    for status in [
        "validated_for_scope",
        "criteria_not_met",
        "insufficient_evidence",
    ] {
        assert!(covered.contains(status), "the group covers no {status} row");
    }
}

/// Every invalid row of the qualification group refuses with its stated
/// reason code and field path.
#[test]
fn invalid_qualification_rows_refuse_with_their_stated_codes() {
    let document = fixture_document("qualification/validation.json");
    let primary = QualificationDataset::load(&document, false);
    let correlated = QualificationDataset::load(&document, true);
    let invalid = document["invalid"].as_array().expect("an invalid array");
    assert!(invalid.len() >= 13, "the fixture group lost invalid rows");

    let mut covered = BTreeSet::new();
    for row in invalid {
        let note = row["note"].as_str().expect("a note");
        let mut artifact = match row.get("plan_id") {
            Some(Value::String(id)) => document["plans"]
                .as_array()
                .expect("a plan array")
                .iter()
                .find(|plan| plan["id"] == *id)
                .unwrap_or_else(|| panic!("{note}: the group states no plan {id}"))
                .clone(),
            _ => row["plan"].clone(),
        };

        // One row may move the validation selection, name another dataset,
        // or edit one limit after the search, so the freeze or the selection
        // check names the moved field.
        if let Some(split) = row["validation_split"].as_str() {
            artifact["datasets"]["validation"]["split"] = json!(split);
            let grouped = splits::dataset_splits(&primary.dataset).expect("the splits compute");
            if let Some(offered) = grouped
                .splits()
                .iter()
                .find(|entry| entry.identity().split_id == split)
            {
                artifact["datasets"]["validation"]["content_hash"] =
                    json!(offered.identity().content_hash);
            }
        }
        if row["foreign_validation_dataset"].as_bool() == Some(true) {
            artifact["datasets"]["validation"]["dataset"] = json!("other-cases");
        }
        if let Some(limit) = row["edited_plan_limit"].as_f64() {
            artifact["constraints"][0]["limit"] = json!(limit);
        }
        let fit_of = match row["fit_plan"].as_str() {
            Some(id) => Some(
                document["plans"]
                    .as_array()
                    .expect("a plan array")
                    .iter()
                    .find(|plan| plan["id"] == json!(id))
                    .unwrap_or_else(|| panic!("{note}: the group states no plan {id}"))
                    .clone(),
            ),
            None => None,
        };

        let error = qualification_row(
            &document,
            &primary,
            &correlated,
            &artifact,
            fit_of.as_ref(),
            row.get("fit_patch"),
            row.get("assessment_patch"),
        )
        .err()
        .unwrap_or_else(|| panic!("{note}: the qualification was accepted"));
        let expected = &row["expected"];
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
        covered.insert(error.code.as_str().to_owned());
    }
    for code in [
        "invalid_field_type",
        "hash_mismatch",
        "definition_mismatch",
        "policy_mismatch",
        "criteria_not_met",
        "unknown_field",
        "missing_field",
    ] {
        assert!(covered.contains(code), "the group covers no {code} row");
    }
}
