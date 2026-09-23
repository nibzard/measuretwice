// SPDX-License-Identifier: Apache-2.0
/**
 * measuretwice public API.
 *
 * Development build. The public operations `defineChecks`, `load`, `run`,
 * `calibrate`, `evaluate`, and `compare` are specified in MVP_SPEC.md but
 * not implemented yet. This package never exposes provider SDK types or
 * native binding types.
 */

import { nativeContractVersion } from "./native.js";

/**
 * Returns the portable contract schema version that the Rust core
 * implements. The v0 contracts use version 1.
 */
export function contractVersion(): number {
  return nativeContractVersion();
}
