// SPDX-License-Identifier: Apache-2.0
//! Shared core of measuretwice.
//!
//! This crate owns contract validation, input projection, the exact string
//! rules, profile compatibility, decision policy, outcome aggregation,
//! canonical content hashes, run state transitions, and statistical
//! calculations. The frozen contracts in `contracts/v0` define the artifact
//! formats.
//!
//! External artifact text enters through one strict gate: [`json::parse_strict`]
//! rejects malformed text, duplicate object keys, non-finite numbers, and
//! unpaired surrogates before any type sees the data. Each artifact then
//! passes through its parser, for example [`definition::parse_definition_str`]
//! and [`case::parse_case_str`], which returns either a validated domain
//! value or a [`error::ValidationError`] with a stable reason code and a
//! field path. No parser coerces a value, applies a silent default, or
//! exposes unvalidated data.
//!
//! This crate never owns provider calls, network clients, credentials,
//! application storage, or report rendering. Do not add a dependency on a
//! provider SDK, an HTTP client, a database, or a terminal library. The
//! Node binding in `measuretwice-node` stays thin. Rust types do not become
//! the public TypeScript API.

#![forbid(unsafe_code)]

/// Shared envelope rules for every portable artifact.
pub mod artifact;
/// Semantic validation of one assessment against its check.
pub mod assessment;
/// The run-case envelope, input validation, and authorized input projection.
pub mod case;
/// The comparison of two evaluation reports on matching cases.
pub mod comparison;
/// Versioned JSONL case datasets and their metadata.
pub mod dataset;
/// The portable check definition contract.
pub mod definition;
/// Stable typed validation errors.
pub mod error;
/// The bounded fitting search of one calibration plan.
pub mod fitting;
/// Canonical content hashes for every portable artifact.
pub mod hashing;
/// The supported input schema subset of a definition.
pub mod input_schema;
/// Uncertainty intervals with their method, assumptions, and evidence.
pub mod intervals;
/// The strict JSON gate for external artifact text.
pub mod json;
/// Evaluation metrics with explicit counts and denominators.
pub mod metrics;
/// The versioned calibration plan contract.
pub mod plan;
/// The `probability_mass_v0` decision policy family for question checks.
pub mod policy;
/// Profile validation and evaluator compatibility.
pub mod profile;
/// The frozen validation of one selected candidate on independent data.
pub mod qualification;
/// Component outcomes, the aggregate, completion, and the immutable run
/// report record.
pub mod report;
/// The shadow review export and the validation of returned human labels.
pub mod review;
/// The exact string rules: maxLength, includes, and excludes.
pub mod rule;
/// Deterministic run state transitions, checked against the TLA+ execution
/// model.
pub mod run_state;
/// Grouped splits and dataset identities.
pub mod splits;
/// Deterministic test utilities. See the module documentation for the rules.
pub mod testing;

/// Portable contract schema version implemented by this core. The v0
/// contracts state `schema_version` 1, as `contracts/README.md` records.
pub const CONTRACT_SCHEMA_VERSION: u32 = 1;
