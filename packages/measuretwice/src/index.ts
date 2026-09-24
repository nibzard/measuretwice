// SPDX-License-Identifier: Apache-2.0
/**
 * measuretwice public API.
 *
 * `defineChecks` authors one check definition with a TypeBox input schema
 * and returns the validated, serializable portable definition. `load` binds
 * one definition to one profile and returns the reviewer whose `run`
 * operation assesses one case and returns the frozen run report. The Rust
 * core validates the complete profile contract, its stored self-hash, and
 * the compatibility of every binding before any execution. Exact rules run
 * in the Rust core; question checks run through evaluators that the host
 * registers with `registerEvaluators`, inside the bounds of the effective
 * execution configuration, and the core validates, decides, and records
 * every answer.
 * `createExplorationProfile` generates the explicitly unvalidated starter
 * profile from one validated definition and the registered evaluators, so
 * one developer can try semantic checks before any qualification evidence
 * exists. `loadDataset` loads one versioned JSONL case dataset with its
 * metadata through the Rust core, which checks every record line and
 * validates every input object and every reference label against the
 * meaning of its check, so reference labels and label provenance
 * stay outside every evaluator request, one conflicting reference loads
 * with one flagged finding, and the returned `labels` review counts the
 * provenance that keeps human judgments apart from model proposals. The
 * package also ships
 * two test adapters, `createScriptedEvaluator` and
 * `createLabelOnlyEvaluator`, that stay offline and prove the contract
 * needs no Jev response shape, `translateJevQuestion`, the versioned
 * translation of one question check into one Jev question, and
 * `createJevEvaluator`, the adapter that normalizes one Jev answer into one
 * typed assessment with its operational record. The renderers
 * `renderRunReport`, `renderRunReportMarkdown`, `renderProfileSummary`, and
 * `renderProfileSummaryMarkdown` turn one frozen report or one profile
 * artifact into terminal text or Markdown, with one summary view and one
 * detailed view. One shadow run states the existing decision of the host
 * through the `baseline` option of `run`, and the report records it beside
 * the new outcome without merging the two facts. The public operations
 * `calibrate`, `evaluate`, and `compare` are specified in MVP_SPEC.md and
 * arrive with their tasks.
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
export { registerEvaluators } from "./evaluator.js";
export type {
  AnswerKind,
  Assessment,
  BinaryQuestion,
  CategoricalQuestion,
  DistributionMass,
  Evaluator,
  EvaluatorExecution,
  EvaluatorTranslation,
  EvaluatorFailure,
  EvaluatorFailureCode,
  EvaluatorRegistry,
  EvaluatorRequest,
  EvidenceReference,
  ExecutionBudget,
  ExecutionMeasurements,
  OrderedQuestion,
  ScaleEntry,
  ValidatedQuestion,
} from "./evaluator.js";
export {
  createLabelOnlyEvaluator,
  createScriptedEvaluator,
  decideLabelOnly,
  labelRuleChecks,
} from "./test-evaluator.js";
export type {
  LabelOnlyAnswer,
  LabelOnlyEvaluator,
  LabelOnlyEvaluatorOptions,
  LabelRuleCheck,
  ScriptedEvaluator,
  ScriptedEvaluatorOptions,
  TestEvaluatorControl,
} from "./test-evaluator.js";
export { JEV_TRANSLATION_VERSION, jevEvidenceState, translateJevQuestion } from "./jev.js";
export type {
  JevChoiceQuestion,
  JevEvidenceState,
  JevNoulQuestion,
  JevPrimitive,
  JevQuestionValue,
  JevScoreQuestion,
  JevTranslation,
} from "./jev.js";
export {
  createJevEvaluator,
  JEV_ADAPTER_VERSION,
  JEV_DEFAULT_MODEL,
  JEV_STATE_BUDGET_BYTES,
  mapJevError,
  normalizeJevExecution,
} from "./jev-assessment.js";
export type {
  JevAnswerValue,
  JevCall,
  JevChoiceAnswer,
  JevEvaluator,
  JevEvaluatorOptions,
  JevExecution,
  JevNoulAnswer,
  JevOperationalRecord,
  JevRequestOptions,
  JevScoreAnswer,
  JevSystemOneRequest,
  JevSystemOneResult,
  JevUsage,
} from "./jev-assessment.js";
export { load } from "./run.js";
export { loadDataset } from "./dataset.js";
export type {
  Dataset,
  DatasetCase,
  DatasetKind,
  DatasetMetadata,
  DatasetSplit,
  ExpectedCheckLabel,
  ExpectedLabels,
  ExpectedOutcome,
  LabelAuthorType,
  LabelFinding,
  LabelFindingKind,
  LabelOrigin,
  LabelProvenance,
  LabelReview,
  LabelSummary,
  LoadDatasetOptions,
  SplitPurpose,
} from "./dataset.js";
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
  ProfileEvidence,
  ProfileInterval,
  ProfileMetric,
  ProfileOrigin,
  ProfilePerformance,
  QualificationStatus,
  Reviewer,
  RuleKeyword,
  RunCase,
  RunCheckRecord,
  RunMode,
  RunOptions,
  RunReport,
  SanitizedReason,
  ShadowBaseline,
} from "./run.js";
export {
  renderProfileSummary,
  renderProfileSummaryMarkdown,
  renderRunReport,
  renderRunReportMarkdown,
} from "./render.js";
export type { RenderDetail, RenderOptions } from "./render.js";
export { createExplorationProfile } from "./exploration.js";
export type {
  ExplorationBinding,
  ExplorationOptions,
  ExplorationStarterPolicy,
} from "./exploration.js";
export { ValidationError } from "./error.js";

/**
 * Returns the portable contract schema version that the Rust core
 * implements. The v0 contracts use version 1.
 */
export function contractVersion(): number {
  return nativeContractVersion();
}
