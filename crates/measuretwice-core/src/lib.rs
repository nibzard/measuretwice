// SPDX-License-Identifier: Apache-2.0
//! Shared core of measuretwice.
//!
//! This crate owns contract validation, input projection, the exact string
//! rules, profile compatibility, decision policy, outcome aggregation,
//! canonical content hashes, and statistical calculations. The frozen
//! contracts in `contracts/v0` define the artifact formats.
//!
//! This crate never owns provider calls, network clients, credentials,
//! application storage, or report rendering. Do not add a dependency on a
//! provider SDK, an HTTP client, a database, or a terminal library. The
//! Node binding in `measuretwice-node` stays thin. Rust types do not become
//! the public TypeScript API.

#![forbid(unsafe_code)]

/// Deterministic test utilities. See the module documentation for the rules.
pub mod testing;

/// Portable contract schema version implemented by this core. The v0
/// contracts state `schema_version` 1, as `contracts/README.md` records.
pub const CONTRACT_SCHEMA_VERSION: u32 = 1;
