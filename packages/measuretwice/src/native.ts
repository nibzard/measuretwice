// SPDX-License-Identifier: Apache-2.0
/**
 * Internal access to the native measuretwice core.
 *
 * The binding is not public API. Never re-export its types or its values
 * from the package entry point.
 */
import { contractVersion } from "measuretwice-node";

/** Returns the contract schema version reported by the Rust core. */
export function nativeContractVersion(): number {
  return contractVersion();
}
