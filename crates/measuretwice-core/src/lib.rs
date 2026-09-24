// SPDX-License-Identifier: Apache-2.0
//! Shared core of measuretwice.
//!
//! This crate owns contract validation, input projection, the exact string
//! rules, profile compatibility, decision policy, outcome aggregation,
//! canonical content hashes, and statistical calculations. The frozen
//! contracts in `contracts/v0` define the artifact formats.
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
/// The run-case envelope, input validation, and authorized input projection.
pub mod case;
/// The portable check definition contract.
pub mod definition;
/// Stable typed validation errors.
pub mod error;
/// Canonical content hashes for every portable artifact.
pub mod hashing;
/// The supported input schema subset of a definition.
pub mod input_schema;
/// The strict JSON gate for external artifact text.
pub mod json;
/// Deterministic test utilities. See the module documentation for the rules.
pub mod testing;

/// Portable contract schema version implemented by this core. The v0
/// contracts state `schema_version` 1, as `contracts/README.md` records.
pub const CONTRACT_SCHEMA_VERSION: u32 = 1;
