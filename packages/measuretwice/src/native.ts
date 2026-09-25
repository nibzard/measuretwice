// SPDX-License-Identifier: Apache-2.0
/**
 * Internal access to the native measuretwice core.
 *
 * The binding is not public API. Never re-export its types or its values
 * from the package entry point. This module is the one place that turns the
 * failures of the Rust boundary into stable TypeScript errors.
 *
 * The binding itself is the NAPI-RS loader that `npm run build:native`
 * generates and copies next to the compiled package as `binding.cjs`. The
 * loader picks the prebuilt binary of its platform. Development finds the
 * locally built binary beside it. Installation finds the binary of the
 * matching `measuretwice-<target>` package.
 *
 * Every fallible binding call throws one native error whose message holds
 * the serialized `ValidationError` of the core: `code`, `message`, and
 * `field_path`. The helpers below rebuild that record into one
 * {@link NativeFailure}, so no safe cause is lost. A bridge failure, such as
 * a JavaScript argument of the wrong type, carries no domain data and passes
 * through unchanged.
 */
import { createRequire } from "node:module";
import type { JSONValue } from "./define-checks.js";
import type {
  CaseInfo,
  DatasetInfo,
  DefinitionInfo,
  RuleAssessment,
  RunState,
} from "../binding.cjs";

/**
 * The declared native targets of the published packages. The list matches
 * `napi.targets` in `crates/measuretwice-node/package.json` and the
 * `optionalDependencies` that `scripts/build-packages.mjs` injects. The
 * repository packaging test keeps the three lists equal.
 */
const DECLARED_NATIVE_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-x64-msvc",
] as const;

/**
 * Loads the generated NAPI-RS loader of this package.
 *
 * A failed load keeps its cause and names the declared targets, so an
 * unsupported platform reports one clear error instead of the generic
 * missing-binary advice of the generated loader.
 */
function loadBinding(): typeof import("../binding.cjs") {
  const requireBinding = createRequire(import.meta.url);
  try {
    // The loader is CommonJS. Named access works because it assigns every
    // export of the binary at the end of the file.
    return requireBinding("../binding.cjs") as typeof import("../binding.cjs");
  } catch (error) {
    const target = `${process.platform}-${process.arch}`;
    throw new Error(
      `measuretwice found no native binding for ${target}. ` +
        `The declared targets are: ${DECLARED_NATIVE_TARGETS.join(", ")}. ` +
        "When the target is declared, reinstall measuretwice so its binary package installs. " +
        "No Rust compiler and no source build exists as a fallback.",
      { cause: error },
    );
  }
}

const binding = loadBinding();

/** One typed failure reported by the Rust boundary. */
export class NativeFailure extends Error {
  /** Stable reason code from the published registry. */
  readonly code: string;
  /** JSON Pointer to the rejected field. Empty means the whole document. */
  readonly fieldPath: string;

  constructor(code: string, message: string, fieldPath: string) {
    super(message);
    this.name = "NativeFailure";
    this.code = code;
    this.fieldPath = fieldPath;
  }
}

/** The serialized failure shape of `measuretwice_core::ValidationError`. */
interface FailureRecord {
  code: string;
  message: string;
  field_path: string;
}

/** Reads one serialized failure out of one thrown native error. */
function failureRecord(error: unknown): FailureRecord | null {
  if (!(error instanceof Error)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.message);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Partial<FailureRecord>;
  if (
    typeof record.code !== "string" ||
    typeof record.message !== "string" ||
    typeof record.field_path !== "string"
  ) {
    return null;
  }
  return { code: record.code, message: record.message, field_path: record.field_path };
}

/** Runs one binding call and rethrows its domain failure in the stable shape. */
function call<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const record = failureRecord(error);
    if (record === null) {
      throw error;
    }
    throw new NativeFailure(record.code, record.message, record.field_path);
  }
}

/** Returns the contract schema version reported by the Rust core. */
export function nativeContractVersion(): number {
  return binding.contractVersion();
}

/** Validates one definition artifact and returns its meaning and hash. */
export function nativeValidateDefinition(definitionText: string): DefinitionInfo {
  return call(() => binding.validateDefinition(definitionText));
}

/** Validates one case and projects each check's authorized inputs. */
export function nativeValidateCase(definitionText: string, caseText: string): CaseInfo {
  return call(() => binding.validateCase(definitionText, caseText));
}

/** Assesses every exact rule of one case, with the record text of each result. */
export function nativeAssessRuleChecks(
  definitionText: string,
  caseText: string,
): RuleAssessment[] {
  return call(() => binding.assessRuleChecks(definitionText, caseText));
}

/** The validated assessment of one check, as the core accepted it. */
export interface ValidatedAssessment {
  /** The assessed check identifier. */
  check: string;
  /** The answer kind of the assessment. */
  kind: string;
  /** The validated assessment value, unchanged. */
  assessment: JSONValue;
}

/** Validates one normalized assessment against the check that asked for it. */
export function nativeValidateAssessment(
  definitionText: string,
  checkId: string,
  assessmentText: string,
): ValidatedAssessment {
  return call(() => binding.validateAssessment(definitionText, checkId, assessmentText));
}

/** Builds the canonical form of one strict JSON document. */
export function nativeCanonicalForm(text: string): string {
  return call(() => binding.canonicalForm(text));
}

/** One decided question check: its outcome and its complete record text. */
export interface DecidedQuestion {
  /** The outcome of the decision: pass, fail, or review. */
  outcome: "pass" | "fail" | "review";
  /** The serialized check record of this decision, ready for `acceptResult`. */
  record: string;
}

/**
 * Decides one question check under its selected policy and builds its record.
 *
 * The policy text states the applied-policy fields of the check exactly as
 * the bound profile records them. The measurements text states the evaluator
 * versions, the timing, and the usage of the execution that produced the
 * assessment. Every failure throws one native failure with the code and the
 * field path of the broken rule.
 */
export function nativeDecideQuestionCheck(
  definitionText: string,
  checkId: string,
  assessmentText: string,
  policyText: string,
  measurementsText: string,
): DecidedQuestion {
  // The binding states the outcome as one plain string; the core decides
  // only the three semantic words, so the narrowing holds by construction.
  return call((): DecidedQuestion =>
    binding.decideQuestionCheck(
      definitionText,
      checkId,
      assessmentText,
      policyText,
      measurementsText,
    ) as DecidedQuestion,
  );
}

/** The result of validating one profile artifact through the core. */
export interface ProfileInfo {
  /** Stable profile identifier. */
  id: string;
  /** The profile origin: exploration, calibration, or exact. */
  origin: string;
  /** The name of the bound definition. */
  definitionName: string;
  /** The content hash of the bound definition. */
  definitionHash: string;
  /** The decision-rule family: probability_mass_v0 or exact. */
  policyFamily: string;
  /** The qualification status of the profile. */
  qualificationStatus: string;
  /** The scope that the status covers, when stated. */
  qualificationScope?: string | null;
  /** The verified self-hash of the artifact. */
  contentHash: string;
}

/** Validates one profile artifact through the complete core contract. */
export function nativeValidateProfile(profileText: string): ProfileInfo {
  return call(() => binding.validateProfile(profileText));
}

/** Validates one JSONL case dataset with its metadata through the core. */
export function nativeValidateDataset(
  metadataText: string,
  recordsText: string,
  definitionText: string,
): DatasetInfo {
  return call(() => binding.validateDataset(metadataText, recordsText, definitionText));
}

/** One split identity that crosses the boundary as strict JSON text. */
export interface NativeSplitIdentity {
  /** Stable dataset identifier. */
  dataset: string;
  /** Dataset revision of this split. */
  revision: string;
  /** Stable split identifier. */
  split: string;
  /** Fitting or validation. */
  purpose: string;
  /** Groups assigned to this split. */
  groups: string[];
  /** Records of this split. */
  record_count: number;
  /** Computed hash of the canonical records of this split. */
  content_hash: string;
  /** Case identifiers of this split, ordered by identifier. */
  case_ids: string[];
}

/** The overlap between one fitting selection and one validation selection. */
export interface NativeSplitOverlap {
  /** True when both selections name one dataset revision. */
  sameDataset: boolean;
  /** Groups that both splits declare. */
  sharedGroups: string[];
  /** Case identifiers that both splits hold. */
  sharedCases: string[];
  /** True when the two selections share no group and no case. */
  separated: boolean;
}

/** Detects fitting and validation overlap between two split selections. */
export function nativeSplitOverlap(
  fitting: NativeSplitIdentity,
  validation: NativeSplitIdentity,
): NativeSplitOverlap {
  return call(() =>
    binding.splitOverlap(JSON.stringify(fitting), JSON.stringify(validation)),
  );
}

/** Requires fitting and validation selections that share no group and no case. */
export function nativeRequireSeparatedSplits(
  fitting: NativeSplitIdentity,
  validation: NativeSplitIdentity,
): void {
  call(() =>
    binding.requireSeparatedSplits(JSON.stringify(fitting), JSON.stringify(validation)),
  );
}

/** The evidence classification of one validation split. */
export interface NativeValidationEvidence {
  /** The evidence class: independent_validation or development. */
  class: string;
  /** True when the dataset kind states one representative sample. */
  representativeSample: boolean;
  /** Records of the split. */
  recordCount: number;
  /** References of the earlier uses that hold the same validation content. */
  reusedFrom: string[];
  /** True when one new qualification claim needs fresh validation evidence. */
  needsFreshEvidence: boolean;
  /** Plain statement of the classification. */
  statement: string;
}

/** Classifies the validation evidence of one split selection. */
export function nativeValidationEvidence(
  validation: NativeSplitIdentity,
  datasetKind: string,
  previouslyUsed: readonly NativeSplitIdentity[],
): NativeValidationEvidence {
  return call(() =>
    binding.validationEvidence(
      JSON.stringify(validation),
      datasetKind,
      JSON.stringify(previouslyUsed),
    ),
  );
}

/** One live evaluator binding of one compatibility check, as data. */
export interface LiveBindingEntry {
  /** The bound check that the registered evaluator serves. */
  check: string;
  /** The registered evaluator identifier. */
  evaluator: string;
  /** The adapter version of the registered evaluator. */
  adapter_version: string;
  /** The live translated-question hash, when the adapter states one. */
  translation?: string;
  /** The resolved model version, when the host states one. */
  resolved_model?: string;
  /** The preprocessing identity, when one applies. */
  preprocessing?: string;
}

/**
 * Checks one profile against one definition and the live evaluator state.
 *
 * Every material mismatch throws one compatibility failure with a stable
 * reason code, before any evaluator runs. Shadow mode compares the bindings
 * alone; enforcement adds the scope, qualification, and selection clauses,
 * so it also needs the requested scope and the reviewed content hash that
 * the host selected.
 */
export function nativeCheckProfileCompatibility(
  profileText: string,
  definitionText: string,
  live: readonly LiveBindingEntry[],
  mode: "shadow" | "enforcement",
  requestedScope?: string,
  selectedHash?: string,
): void {
  call(() =>
    binding.checkProfileCompatibility(
      profileText,
      definitionText,
      JSON.stringify(live),
      mode,
      requestedScope ?? null,
      selectedHash ?? null,
    ),
  );
}

/** Computes the content hash of one strict JSON document in one domain. */
export function nativeContentHash(domain: string, text: string): string {
  return call(() => binding.contentHash(domain, text));
}

/** The verified plan reference of one evidence check. */
export interface NativeEvidencePlan {
  /** Stable plan identifier, equal to the recorded identifier. */
  readonly id: string;
  /** Computed identity of the plan, equal to the recorded hash. */
  readonly contentHash: string;
}

/** The verified dataset reference of one evidence check. */
export interface NativeEvidenceDataset {
  /** Stable dataset identifier, equal to the recorded identifier. */
  readonly id: string;
  /** Dataset revision, equal to the recorded revision. */
  readonly revision: string;
  /** Dataset kind, as the retained metadata states it. */
  readonly kind: string;
  /** Case records of the dataset. */
  readonly recordCount: number;
  /** Computed hash of the dataset records, equal to the recorded hash. */
  readonly contentHash: string;
}

/** One verified split reference of one evidence check. */
export interface NativeEvidenceSplit {
  /** Stable split identifier, as the profile records it. */
  readonly id: string;
  /** Fitting or validation, as the retained dataset declares the split. */
  readonly purpose: string;
  /** Groups of the split, in the declared order. */
  readonly groups: readonly string[];
  /** Case records of the split. */
  readonly recordCount: number;
  /** Computed hash of the split records, equal to the recorded hash. */
  readonly contentHash: string;
}

/** The result of one evidence check over one selected profile. */
export interface NativeEvidenceCheck {
  /** Stable profile identifier. */
  readonly profileId: string;
  /** Verified self-hash of the profile artifact. */
  readonly profileContentHash: string;
  /** Content hash of the definition that the profile and the plan bind. */
  readonly definitionHash: string;
  /** The retained plan, with the recorded identity. */
  readonly plan: NativeEvidencePlan;
  /** The retained dataset, with the recorded identity. */
  readonly dataset: NativeEvidenceDataset;
  /** Every recorded split, with the identity of the retained dataset. */
  readonly splits: readonly NativeEvidenceSplit[];
  /** The evaluation-report references, as the profile records them. */
  readonly evaluationReports: readonly string[];
  /** What the check verified, with the counts it read. */
  readonly statement: string;
  /** The standing limits of this check. */
  readonly limitations: readonly string[];
}

/**
 * Checks the recorded evidence of one profile against the retained
 * artifacts.
 *
 * The core validates every artifact, compares the recorded plan, dataset,
 * and split identities with the computed identities of the retained copies,
 * and verifies that the plan and the dataset state one consistent
 * calibration. One mismatch throws one native failure with `hash_mismatch`
 * at the field path of the recorded reference.
 */
export function nativeCheckProfileEvidence(
  profileText: string,
  planText: string,
  metadataText: string,
  recordsText: string,
): NativeEvidenceCheck {
  return call(() =>
    binding.checkProfileEvidence(profileText, planText, metadataText, recordsText),
  );
}

/** Computes the self-hash of one profile or plan artifact. */
export function nativeComputeSelfHash(domain: string, artifactText: string): string {
  return call(() => binding.computeSelfHash(domain, artifactText));
}

/** Verifies the stored self-hash of one profile or plan artifact. */
export function nativeVerifySelfHash(domain: string, artifactText: string): void {
  call(() => binding.verifySelfHash(domain, artifactText));
}

/** Computes the dataset-domain content hash of one record-set array. */
export function nativeDatasetHash(recordsText: string): string {
  return call(() => binding.datasetHash(recordsText));
}

/** Computes the split-domain content hash of one record-set array. */
export function nativeSplitHash(recordsText: string): string {
  return call(() => binding.splitHash(recordsText));
}

/**
 * Measures one dataset against the stored run reports of its evaluated
 * cases.
 *
 * Each report text is one stored run report. The core rebuilds every report
 * through the run report contract, reads each evaluated case out of it, and
 * measures the outcomes against the reference labels of the records. The
 * result is the complete measurement as one JSON document: the metric sets,
 * the slices, and the operational totals under `metrics`, and one entry per
 * evaluated case under `cases` with its resolved references and matches.
 */
export function nativeEvaluateDataset(
  metadataText: string,
  recordsText: string,
  definitionText: string,
  reportsText: readonly string[],
): string {
  return call(() =>
    binding.evaluateDataset(metadataText, recordsText, definitionText, [...reportsText]),
  );
}

/**
 * Validates one interval request.
 *
 * The core parses the request alone, so one wrapper checks it before it
 * reads one dataset or runs one case. The result is the parsed request as
 * one JSON document.
 */
export function nativeParseIntervalRequest(requestText: string): string {
  return call(() => binding.parseIntervalRequest(requestText));
}

/**
 * Computes the uncertainty intervals of one measured evaluation.
 *
 * The texts follow the rules of `nativeEvaluateDataset`, which the core runs
 * first, and the request text holds one interval request object. The result
 * is the complete interval report as one JSON document.
 */
export function nativeUncertaintyIntervals(
  metadataText: string,
  recordsText: string,
  definitionText: string,
  reportsText: readonly string[],
  requestText: string,
): string {
  return call(() =>
    binding.uncertaintyIntervals(
      metadataText,
      recordsText,
      definitionText,
      [...reportsText],
      requestText,
    ),
  );
}

/** One dataset selection of one validated plan. */
export interface NativePlanSelection {
  /** Stable dataset identifier the selection names. */
  dataset: string;
  /** Dataset revision the selection names. */
  revision: string;
  /** Stable split identifier the selection names. */
  split: string;
}

/** The validated meaning of one calibration plan, as the core reads it. */
export interface NativePlanInfo {
  /** Stable plan identifier. */
  id: string;
  /** Computed identity of the plan in the plan domain. */
  contentHash: string;
  /** Name of the calibrated definition. */
  definitionName: string;
  /** Content hash of the calibrated definition. */
  definitionHash: string;
  /** The declared population of the qualification claim. */
  intendedPopulation: string;
  /** The declared grouping and independence assumptions. */
  samplingAssumptions: string;
  /** The declared confidence level of every interval. */
  confidenceLevel: number;
  /** The registered evaluator the plan measures with. */
  evaluator: string;
  /** The adapter version of the measurement. */
  adapterVersion: string;
  /** The content hash of the translated questions the plan freezes. */
  translationHash?: string | null;
  /** The model identifier the plan requests. */
  modelRequested?: string | null;
  /** The fitting selection of the plan. */
  fitting: NativePlanSelection;
  /** The validation selection of the plan. */
  validation: NativePlanSelection;
  /** Candidates the permitted grid enumerates, in declared order. */
  candidateCount: number;
}

/** Validates one calibration plan through the complete core contract. */
export function nativeValidatePlan(planText: string): NativePlanInfo {
  return call(() => binding.validatePlan(planText));
}

/**
 * Checks one validated plan against the loaded definition and the registered
 * evaluators, before any data is read.
 *
 * The definition text holds the loaded definition and the registered text
 * one array of the evaluators the host registered. The core runs the two
 * binding checks of the plan boundary that need no data, so one plan that
 * the loaded definition or the registry refuses fails here before one
 * dataset is read.
 */
export function nativeCheckCalibrationBinding(
  planText: string,
  definitionText: string,
  registeredText: string,
): void {
  call(() => binding.checkCalibrationBinding(planText, definitionText, registeredText));
}

/**
 * Checks the two dataset selections of one validated plan against the loaded
 * splits, before any case is measured.
 *
 * The two split texts hold the fitting and the validation split identities
 * of the loaded dataset, each as `loadDataset` states them. Each selection
 * must name the offered split of the offered revision and the declared
 * purpose of its role, and the two selections must share no group and no
 * case.
 */
export function nativeCheckCalibrationDatasets(
  planText: string,
  fittingText: string,
  validationText: string,
): void {
  call(() => binding.checkCalibrationDatasets(planText, fittingText, validationText));
}

/**
 * Checks whether one policy revision may replay the stored assessments of
 * one prior calibration.
 *
 * The prior profile text, the prior fitting report text, and the stored
 * run texts cross exactly as the host stored them; the plan text, the
 * definition text, the registered text, the live text, and the two
 * dataset texts cross exactly as the wrapper read them. One changed
 * definition, evaluator, adapter, translation, model resolution,
 * preprocessing identity, or input throws one native failure with the
 * compatibility code of the registry before one assessment is replayed.
 * The result is the verified reuse as one JSON document.
 */
export function nativeCheckRevision(
  priorProfileText: string,
  priorFittingText: string,
  priorRuns: readonly string[],
  planText: string,
  definitionText: string,
  registeredText: string,
  liveText: string,
  metadataText: string,
  recordsText: string,
): string {
  return call(() =>
    binding.checkRevision(
      priorProfileText,
      priorFittingText,
      [...priorRuns],
      planText,
      definitionText,
      registeredText,
      liveText,
      metadataText,
      recordsText,
    ),
  );
}

/**
 * Compares the prior policy and one revised policy over the same stored
 * fitting assessments.
 *
 * The prior profile text states the applied policy the stored assessments
 * last served, the plan text is the revision plan, and the revised policy
 * text holds one applied-policy row per question check of the frozen
 * candidate. The result is the complete comparison as one JSON document:
 * the changed cases with both aggregate outcomes, the metric tradeoffs
 * with the counts and the denominators of both sides, and the standing
 * limits of one fitting comparison.
 */
export function nativeCompareRevision(
  priorProfileText: string,
  planText: string,
  revisedPolicyText: string,
  metadataText: string,
  recordsText: string,
  definitionText: string,
  assessmentsText: string,
): string {
  return call(() =>
    binding.compareRevision(
      priorProfileText,
      planText,
      revisedPolicyText,
      metadataText,
      recordsText,
      definitionText,
      assessmentsText,
    ),
  );
}

/** Runs one binding call that resolves asynchronously and lifts its failure. */
async function callAsync<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const record = failureRecord(error);
    if (record === null) {
      throw error;
    }
    throw new NativeFailure(record.code, record.message, record.field_path);
  }
}

/**
 * Searches the permitted candidate family on the fitting split.
 *
 * The texts follow the rules of `nativeValidatePlan` and
 * `nativeValidateDataset`, and the assessments text holds one object keyed by
 * case identifier, then by question check identifier, holding the stored
 * assessment of that check. The libuv worker thread runs the search, so the
 * Node event loop stays free, and no JavaScript code runs during it. The
 * result is the complete fitting report as one JSON document.
 */
export function nativeFitPolicy(
  planText: string,
  metadataText: string,
  recordsText: string,
  definitionText: string,
  assessmentsText: string,
): Promise<string> {
  return callAsync(() =>
    binding.fitPolicy(planText, metadataText, recordsText, definitionText, assessmentsText),
  );
}

/**
 * Qualifies the frozen candidate of one calibration on independent cases.
 *
 * The texts follow the rules of `nativeFitPolicy`. The fitting assessments
 * text holds the same stored assessments the search read, so the core
 * re-derives the frozen candidate itself, and the validation assessments
 * text holds the stored assessments of the validation split. The request
 * text holds one validation request object. The libuv worker thread runs the
 * computation, and the result is the complete qualification report as one
 * JSON document.
 */
export function nativeQualifyCandidate(
  planText: string,
  metadataText: string,
  recordsText: string,
  definitionText: string,
  fittingAssessmentsText: string,
  requestText: string,
  validationAssessmentsText: string,
): Promise<string> {
  return callAsync(() =>
    binding.qualifyCandidate(
      planText,
      metadataText,
      recordsText,
      definitionText,
      fittingAssessmentsText,
      requestText,
      validationAssessmentsText,
    ),
  );
}

/**
 * Exports the stored shadow reports that need one human review.
 *
 * Each report text is one stored run report, rebuilt through the run report
 * contract. The meanings text holds one object that maps every word of the
 * host decision vocabulary to one meaning word. The core classifies every
 * report, samples the agreements by the seeded rank, and returns the
 * complete export as one JSON document.
 */
export function nativeExportShadowReviews(
  reports: readonly string[],
  meanings: string,
  seed: string,
  agreementSample: number,
): string {
  return call(() =>
    binding.exportShadowReviews([...reports], meanings, seed, agreementSample),
  );
}

/**
 * Validates the labels one human returned for one review export.
 *
 * The exported text holds one JSON array of the case identifiers of one
 * review export. The labels text holds one complete JSONL return. The core
 * validates every reference against the meaning of its check and returns
 * the complete validation as one JSON document. It reads no baseline,
 * because baseline agreement is not correctness.
 */
export function nativeValidateReviewLabels(
  definitionText: string,
  exported: string,
  labelsText: string,
): string {
  return call(() => binding.validateReviewLabels(definitionText, exported, labelsText));
}

/**
 * Compares two stored evaluation reports on their matching cases.
 *
 * Each report text is one stored evaluation report artifact, rebuilt
 * through the evaluation report contract; one edited report fails with its
 * field path under `/baseline` or `/candidate`. The two reference strings
 * name where the host stored the reports. The optional costs text maps one
 * usage key to its unit cost. The result is the complete comparison as one
 * JSON document: the comparison artifact fields, the metric rows with the
 * counts and the denominators of both sides, and the standing limits.
 */
export function nativeCompareEvaluations(
  baselineText: string,
  candidateText: string,
  baselineReport: string,
  candidateReport: string,
  costsText: string | null,
): string {
  return call(() =>
    binding.compareEvaluations(
      baselineText,
      candidateText,
      baselineReport,
      candidateReport,
      costsText,
    ),
  );
}

/**
 * Starts one run of one case through the core state boundary.
 *
 * The optional baseline text states one shadow baseline: the existing
 * decision of the host and the revision of its decision path. The core
 * validates it against the run report contract and refuses one baseline that
 * reaches an enforcement run or breaks its bounds, before any work starts.
 */
export function nativeCreateRunState(
  definitionText: string,
  caseReferenceText: string,
  profileReferenceText: string,
  runId: string,
  mode: string,
  maxAttempts: number,
  baselineText: string | null,
): RunState {
  return call(() =>
    binding.createRunState(
      definitionText,
      caseReferenceText,
      profileReferenceText,
      runId,
      mode,
      maxAttempts,
      baselineText,
    ),
  );
}

/** Starts the next attempt of one check, offering the run binding. */
export function runStartAttempt(
  run: RunState,
  checkId: string,
  caseReferenceText: string,
  profileReferenceText: string,
): number {
  return call(() => run.startAttempt(checkId, caseReferenceText, profileReferenceText));
}

/** Resolves one in-flight attempt with an operational failure. */
export function runFailAttempt(
  run: RunState,
  checkId: string,
  code: string,
  message: string,
): { resolution: string; attempts?: number } {
  return call(() => run.failAttempt(checkId, code, message));
}

/**
 * Resolves one in-flight attempt with one permanent operational failure.
 *
 * The wrapper states that it declines the retry, so the check records its
 * error at the failing attempt, whatever attempts remain.
 */
export function runFailPermanent(run: RunState, checkId: string, code: string, message: string): void {
  call(() => run.failPermanent(checkId, code, message));
}

/** Resolves one in-flight attempt with its component record. */
export function runAcceptResult(run: RunState, checkId: string, recordText: string): void {
  call(() => run.acceptResult(checkId, recordText));
}

/** Records one queue-full skip for work that never started. */
export function runSkipQueueFull(run: RunState, checkId: string): void {
  call(() => run.skipQueueFull(checkId));
}

/** Cancels the run and freezes its report. */
export function runCancel(run: RunState, completedAt?: string | null): void {
  call(() => run.cancel(completedAt ?? null));
}

/** Ends the run at its total deadline and freezes its report. */
export function runDeadline(run: RunState, completedAt?: string | null): void {
  call(() => run.deadline(completedAt ?? null));
}

/** Completes the run and freezes its report. */
export function runComplete(run: RunState, completedAt?: string | null): void {
  call(() => run.complete(completedAt ?? null));
}

export type { CaseInfo, DatasetInfo, DefinitionInfo, RuleAssessment, RunState };
