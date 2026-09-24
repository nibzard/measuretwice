// SPDX-License-Identifier: Apache-2.0
/**
 * measuretwice public API.
 *
 * `defineChecks` authors one check definition with a TypeBox input schema
 * and returns the validated, serializable portable definition. The public
 * operations `load`, `run`, `calibrate`, `evaluate`, and `compare` are
 * specified in MVP_SPEC.md and arrive with their tasks.
 *
 * This package never exposes provider SDK types or native binding types.
 * Invalid data fails with one {@link ValidationError} before execution.
 */
import { nativeContractVersion } from "./native.js";

export { defineChecks } from "./define-checks.js";
export type {
  Acceptance,
  CaseInput,
  CheckAuthoring,
  CheckDefinition,
  ChecksAuthoring,
  DefinedChecks,
  Definition,
  ExactRule,
  InputName,
  JSONValue,
  JsonSchemaNode,
  ScaleLevel,
} from "./define-checks.js";
export { ValidationError } from "./error.js";

/**
 * Returns the portable contract schema version that the Rust core
 * implements. The v0 contracts use version 1.
 */
export function contractVersion(): number {
  return nativeContractVersion();
}
