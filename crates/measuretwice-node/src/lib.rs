// SPDX-License-Identifier: Apache-2.0
//! Thin Node binding for the measuretwice core.
//!
//! The binding exposes serializable operations of the core. It makes no
//! provider calls, holds no credentials, and writes no files. Loading the
//! binding performs no I/O beyond loading the shared library. Public
//! TypeScript types live in the `measuretwice` package, never here.

#[macro_use]
extern crate napi_derive;

/// Returns the portable contract schema version implemented by the core.
#[napi]
pub fn contract_version() -> u32 {
    measuretwice_core::CONTRACT_SCHEMA_VERSION
}
