// SPDX-License-Identifier: Apache-2.0
/**
 * measuretwice public API.
 *
 * `defineChecks` authors one check definition with a TypeBox input schema
 * and returns the validated, serializable portable definition. `load` binds
 * one definition to one profile and returns the reviewer whose `run`
 * operation assesses one case and returns the frozen run report. The exact
 * rules run in the Rust core today; question checks need one registered
 * evaluator. The public operations `calibrate`, `evaluate`, and `compare`
 * are specified in MVP_SPEC.md and arrive with their tasks.
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
export { load } from "./run.js";
export type {
  AggregateOutcome,
  AppliedRuleRecord,
  CheckOutcome,
  CompletionStatus,
  EvaluatorVersionsRecord,
  ExecutionConfig,
  FileAccess,
  LoadOptions,
  PolicyFamily,
  Profile,
  ProfileBinding,
  ProfileOrigin,
  QualificationStatus,
  Reviewer,
  RuleKeyword,
  RunCase,
  RunCheckRecord,
  RunMode,
  RunOptions,
  RunReport,
  SanitizedReason,
} from "./run.js";
export { ValidationError } from "./error.js";

/**
 * Returns the portable contract schema version that the Rust core
 * implements. The v0 contracts use version 1.
 */
export function contractVersion(): number {
  return nativeContractVersion();
}
