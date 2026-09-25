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
 * same load computes the grouped splits: one group appears in one split
 * only, the returned `identity` records the revision, the population
 * statement, the sampling provenance, the content hashes, and the group
 * assignments, and `detectSplitOverlap`, `requireSeparatedSplits`, and
 * `classifyValidationEvidence` keep fitting data apart from independent
 * validation data, so one reused holdout is marked as development data that
 * supports no new qualification claim. The package also ships
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
 * the new outcome without merging the two facts. `evaluate` runs every
 * record of one dataset through the same validated execution path, measures
 * the outcomes against the reference labels in the Rust core, and returns
 * the evaluation report artifact beside one run report per case, with the
 * label coverage, the population limits, and the unevaluated records kept
 * visible, and with no qualification and no host selection changed.
 * `exportShadowReviews` selects the stored shadow reports that need one
 * human review: every disagreement, every report without one baseline,
 * every candidate error, and one reproducible seeded sample of the
 * agreements. It returns JSON Lines review records with their sampling
 * provenance and no raw case content, so baseline passes and silent
 * baseline cases stay auditable. `validateReviewLabels` checks the
 * returned human labels against the meaning of their checks, without
 * treating baseline agreement as correctness. `compare` compares two
 * stored evaluation reports on their matching cases: one case matches
 * only when its identifier and its input hash agree, the changed, the
 * missing, the errored, and the skipped cases stay listed, and every
 * metric row keeps the counts and the denominators of both sides, with
 * the evidence class derived from the declared purposes and the cost
 * tradeoff computed only when the recorded usage and the declared cost
 * inputs support it. The public operation `calibrate` runs one complete
 * calibration: it reads the explicit plan and the datasets, checks every
 * binding of the plan against the loaded world, measures the development
 * cases through the registered evaluator on the same validated execution
 * path as one ordinary run, searches the permitted candidate family in the
 * Rust core on one worker thread, freezes the selected candidate, validates
 * it on the independent split, and returns the candidate profile with the
 * fitting and qualification reports. No feasible candidate is one valid
 * result, and whatever the evidence established, the calibration promotes
 * nothing: the host reviews the recorded evidence and selects one reviewed
 * content hash through its own code. The public operation `revise` runs one
 * policy-only revision of one stored calibration: the Rust core verifies
 * that the prior profile, the revision plan, the loaded definition, the
 * live evaluator state, and the fitting inputs carry one identity, the
 * search replays the stored fitting assessments under the revised plan,
 * one consumed validation split replays its stored assessments and
 * declares itself as development data that one new claim cannot reuse,
 * one fresh validation split is measured through the registered
 * evaluator, and the result holds one new profile with its own content
 * hash beside the revision comparison with its concrete changed cases.
 * The prior validation never validates one revised policy, so the
 * revision promotes nothing either. `checkEvidence` verifies the retained
 * evidence of one selected profile: the host states the explicit locations
 * of its plan, its dataset metadata, and its dataset records, and the Rust
 * core compares every recorded identity with the computed identity of the
 * retained copy, so one selected profile never rests on evidence that
 * drifted after the review.
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
export {
  classifyValidationEvidence,
  detectSplitOverlap,
  loadDataset,
  requireSeparatedSplits,
} from "./dataset.js";
export type {
  Dataset,
  DatasetCase,
  DatasetIdentity,
  DatasetKind,
  DatasetMetadata,
  DatasetSplit,
  DatasetSplitIdentity,
  EvidenceClass,
  ExpectedCheckLabel,
  ExpectedLabels,
  ExpectedOutcome,
  GroupAssignment,
  LabelAuthorType,
  LabelFinding,
  LabelFindingKind,
  LabelOrigin,
  LabelProvenance,
  LabelReview,
  LabelSummary,
  LoadDatasetOptions,
  PopulationStatement,
  SplitOverlap,
  SplitPurpose,
  UnassignedGroup,
  ValidationEvidence,
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
export { evaluate } from "./evaluate.js";
export type {
  EvaluatedCase,
  EvaluateOptions,
  Evaluation,
  EvaluationCounts,
  EvaluationInterval,
  EvaluationIntervalSet,
  EvaluationIntervals,
  EvaluationMetricSet,
  EvaluationOperational,
  EvaluationPopulation,
  EvaluationPurpose,
  EvaluationRate,
  EvaluationReport,
  EvaluationSlice,
  EvaluationSliceIntervals,
  IntervalOptions,
} from "./evaluate.js";
export { calibrate } from "./calibrate.js";
export type {
  Calibration,
  CalibrationCandidate,
  CalibrationCounts,
  CalibrationGoal,
  CalibrationMetricSet,
  CalibrationRate,
  CalibrationSampling,
  CalibrateOptions,
  FittingCandidate,
  FittingReport,
  FittingStatus,
  GoalBasis,
  GoalComparison,
  GoalEvidence,
  QualificationEvidence,
  QualificationGoal,
  QualificationInterval,
  QualificationIntervalSet,
  QualificationReason,
  QualificationReport,
  QualificationSlice,
  SampleRequirement,
  SelectedCandidate,
} from "./calibrate.js";
export { revise } from "./revise.js";
export type {
  Revision,
  RevisionBinding,
  RevisionComparison,
  RevisionMatching,
  RevisionPolicyRow,
  RevisionReuse,
  RevisionSide,
  RevisionSplit,
  ReviseOptions,
  ValidationDisposition,
} from "./revise.js";
export { checkEvidence } from "./evidence.js";
export type {
  CheckEvidenceOptions,
  EvidenceCheck,
  EvidenceDataset,
  EvidencePlan,
  EvidenceSplit,
} from "./evidence.js";
export { exportShadowReviews, validateReviewLabels } from "./review.js";
export type {
  AgreementSample,
  BaselineMeaning,
  BaselineMeanings,
  CandidateOutcomes,
  ExportShadowReviewsOptions,
  RecordedBaseline,
  ReturnedReviewLabel,
  ReviewLabelSummary,
  ReviewLabelValidation,
  ReviewSamplingProvenance,
  SelectionReason,
  ShadowReviewExport,
  ShadowReviewRecord,
  ShadowReviewSummary,
  ValidateReviewLabelsOptions,
} from "./review.js";
export { compare } from "./compare.js";
export type {
  ChangedCase,
  ChangedCheckPair,
  Comparison,
  ComparisonArtifact,
  ComparisonMatching,
  ComparisonMetric,
  ComparisonRate,
  ComparisonTradeoffs,
  CompareOptions,
  ComparisonEvidenceClass,
  MetricTradeoffRow,
  ReportSetReference,
} from "./compare.js";
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
