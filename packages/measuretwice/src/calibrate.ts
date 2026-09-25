// SPDX-License-Identifier: Apache-2.0
/**
 * `calibrate`: one complete calibration, from stored plan to candidate.
 *
 * MVP_SPEC.md section 7 fixes the procedure: run the evaluator on the
 * development cases, let Rust search the bounded policy family against the
 * agreed objectives, freeze the candidate, then validate it on held-out
 * cases and compute counts, intervals, slice results, and goal satisfaction
 * in code. This module owns the orchestration alone. The Rust core owns
 * every rule: the plan contract, the dataset contract, the binding checks,
 * the fitting search, the frozen validation, and the profile contract.
 *
 * The workflow reads the explicit plan, the dataset metadata, and the
 * dataset records through one file access, exactly as `loadDataset` accepts
 * them. The plan binds the definition by content hash, one registered
 * evaluator, and one fitting and one validation split of the dataset. The
 * core checks every binding before one case runs, so no spend happens on a
 * plan that the loaded world refuses.
 *
 * Development assessment runs through the same validated execution path as
 * an ordinary run. The generator of `exploration.ts` derives one
 * measurement profile that binds every question check to the evaluator the
 * plan names, `load` binds it, and every case of the two splits runs as one
 * shadow run inside the effective execution configuration. The runs bound
 * every attempt, every retry, the total deadline, and the cancellation, and
 * the report of each run holds the raw assessment of each question check
 * exactly as the core accepted it. Those stored assessments, and nothing
 * else, enter the search: no reference label, no tag, and no provenance
 * field reaches an evaluator request, and the fitting replay reads the
 * assessments alone, so the same stored assessments support a later
 * policy-only revision.
 *
 * The long calculations never touch the Node event loop. The fitting search
 * and the frozen validation run on one libuv worker thread through the
 * native boundary, as one pure computation over the plan text, the dataset
 * texts, and the stored assessments: no JavaScript runs during them, no
 * callback reaches user code, and each result crosses as one JSON document.
 * The frozen validation re-runs the deterministic search over the same
 * fitting assessments first, so the candidate it validates is the candidate
 * the search selected, and no serialized fit report can drift between the
 * two phases of one calibration.
 *
 * The result holds one candidate profile and the reports behind it. The
 * profile is one artifact of the frozen profile contract, signed with the
 * core self-hash, validated through the complete contract and the shadow
 * compatibility check, and loaded once through the public `load` before it
 * returns, so the host receives one artifact that binds as generated. Its
 * qualification states what the evidence established: `validated_for_scope`
 * only when every declared goal held on its declared basis, and
 * `insufficient_evidence` or `criteria_not_met` otherwise. No feasible
 * candidate is one valid result: the profile then records the objective-best
 * candidate of the permitted family with `criteria_not_met`, the fitting
 * report states every unmet goal, and the calibration spends no validation
 * budget, because no frozen candidate exists to validate. Whatever the
 * status, the calibration promotes nothing: the host reviews the recorded
 * evidence, stores it, and selects one reviewed content hash through its own
 * code. Enforcement still refuses the candidate until the host selects it.
 *
 * Failure behavior: one absent or malformed option, one plan or dataset that
 * fails its contract, one plan that binds another definition, evaluator, or
 * dataset, and one calculation that exceeds the published fitting budget
 * throw one public {@link ValidationError} with a stable reason code and a
 * field path. One evaluator failure on one measured case refuses the
 * calibration with the operational code of the record, because one stored
 * assessment is missing and no search may invent one. One model alias that
 * resolved to two versions during the measurements refuses with
 * `model_resolution_changed`, because one calibration measures with one
 * model. One aborted `signal` refuses with `run_cancelled`, and one aborted
 * before the first case with `cancelled_before_start`. One unreadable path
 * throws one ordinary `Error` that names the path.
 */
import type { Definition } from "./define-checks.js";
import type { Dataset, DatasetIdentity, DatasetSplitIdentity, LabelReview } from "./dataset.js";
import { datasetOf, readDatasetTexts } from "./dataset.js";
import type { EvaluatorRegistry } from "./evaluator.js";
import { createExplorationProfile } from "./exploration.js";
import { ValidationError } from "./error.js";
import {
  NativeFailure,
  nativeCheckCalibrationBinding,
  nativeCheckCalibrationDatasets,
  nativeComputeSelfHash,
  nativeFitPolicy,
  nativeQualifyCandidate,
  nativeValidateDefinition,
  nativeValidatePlan,
  nativeValidateProfile,
  type NativePlanInfo,
} from "./native.js";
import {
  deepFreeze,
  defaultFiles,
  jsonText,
  load,
  readText,
  requireJsonPath,
  throughCore,
  type ExecutionConfig,
  type FileAccess,
  type Profile,
  type ProfilePerformance,
  type QualificationStatus,
  type Reviewer,
  type RunReport,
} from "./run.js";

// ---------------------------------------------------------------------------
// Public types of the calibration path.
// ---------------------------------------------------------------------------

/** The declared sampling model of the frozen validation. */
export type CalibrationSampling = "independent_cases" | "grouped_cases";

/**
 * The options of one calibration. Every field except the noted optional ones
 * is required, because one calibration states its complete procedure: the
 * plan, the dataset, the evaluator registry, the sampling model, and where
 * the host stores the evidence reports.
 */
export interface CalibrateOptions {
  /** One explicit path to the JSON calibration plan. */
  readonly plan: string;
  /** One explicit path to the JSON dataset metadata file. */
  readonly metadata: string;
  /** One explicit path to the JSONL record file. */
  readonly records: string;
  /**
   * The registered evaluators. The plan names one of them, and one entry
   * outside the registry changes nothing: one loaded file installs no
   * evaluator.
   */
  readonly evaluators: EvaluatorRegistry;
  /**
   * The declared sampling model of every validation interval:
   * `independent_cases` needs every case of one denominator in its own
   * group, `grouped_cases` makes the group the draw.
   */
  readonly sampling: CalibrationSampling;
  /**
   * The validation splits that earlier qualification claims consumed, as the
   * loaded dataset states them. One reused holdout is development data,
   * whatever its name. Optional.
   */
  readonly previouslyUsed?: readonly DatasetSplitIdentity[];
  /**
   * The references to the evaluation reports of this calibration in the
   * storage of the host. One candidate profile records them in its evidence,
   * because the profile contract requires the complete evidence set and the
   * host owns the storage. State where the returned reports are stored.
   */
  readonly evaluationReports: readonly string[];
  /** Stable identifier of the candidate profile. Default: the definition name plus `-calibrated`. */
  readonly id?: string;
  /** Declared population and scope of the candidate. Default: the intended population of the plan. */
  readonly intendedUse?: string;
  /** Effective execution configuration overrides of the measurement defaults. */
  readonly execution?: Partial<ExecutionConfig>;
  /**
   * The cancellation signal of the caller. One abort refuses the
   * calibration: no partial fit runs, because the search needs one stored
   * assessment for every case of its split. Optional.
   */
  readonly signal?: AbortSignal;
  /** The file access that reads the stated paths. The default uses Node APIs. */
  readonly files?: FileAccess;
  /** The clock of the wrapper, in epoch milliseconds. The default reads the system clock. */
  readonly now?: () => number;
  /** The identifier source of the measurement runs. The default draws one random identifier. */
  readonly nextRunId?: () => string;
  /**
   * Arms one wake-up at one epoch-millisecond instant, and returns one
   * operation that cancels the wake-up. The measurement runs use it for
   * their total deadline. Optional.
   */
  readonly setTimer?: (atMs: number, onWake: () => void) => () => void;
}

/** One rate of one metric set, with its numerator and its denominator. */
export interface CalibrationRate {
  /** Published metric name of `common.schema.json`. */
  readonly metric: string;
  /** Cases in the numerator. */
  readonly numerator: number;
  /** Denominator of the rate. */
  readonly denominator: number;
  /** Numerator over denominator, or `null` when the denominator is zero. */
  readonly value: number | null;
}

/** The predicted outcome counts of one metric set. */
export interface CalibrationCounts {
  /** Predicted passes. */
  readonly pass: number;
  /** Predicted failures. */
  readonly fail: number;
  /** Predicted review outcomes. */
  readonly review: number;
  /** Predicted execution failures. */
  readonly error: number;
  /** Predicted skips. */
  readonly skipped: number;
}

/** One metric set: the measurement of one scope. */
export interface CalibrationMetricSet {
  /** Check identifier, or `all_checks` for the complete check set. */
  readonly scope: string;
  /** Predicted outcome counts over every measured case of the scope. */
  readonly counts: CalibrationCounts;
  /** The contract rates, each with its counts and its denominator. */
  readonly rates: readonly CalibrationRate[];
}

/** One candidate of the permitted family. */
export interface CalibrationCandidate {
  /** The acceptance cutoff. */
  readonly accept_cutoff: number;
  /** The rejection cutoff. */
  readonly rejection_cutoff: number;
  /** The confidence floor, or `null` when the candidate abstains nowhere. */
  readonly confidence_floor: number | null;
}

/** The direction of one declared limit. */
export type GoalComparison = "at_most" | "at_least";

/** The evidence basis one declared limit reads. */
export type GoalBasis = "upper_confidence_bound" | "observed_value";

/** The evidence state behind one measured goal. */
export type GoalEvidence =
  | { readonly evidence: "measured" }
  | { readonly evidence: "zero_denominator" }
  | { readonly evidence: "below_minimum"; readonly stated: number; readonly measured: number }
  | { readonly evidence: "unsupported_sampling" };

/** One declared goal of the plan, as one procedure measured it. */
export interface CalibrationGoal {
  /** The constrained metric of the published set. */
  readonly metric: string;
  /** The declared direction of the limit. */
  readonly comparison: GoalComparison;
  /** The declared limit, unchanged by the measurement. */
  readonly limit: number;
  /** The declared evidence basis. */
  readonly basis: GoalBasis;
  /** Cases in the numerator of the rate. */
  readonly numerator: number;
  /** Cases in the denominator of the rate. */
  readonly denominator: number;
  /** The observed rate, or `null` when the denominator holds no case. */
  readonly observed: number | null;
  /** The upper bound the bound basis reads, when it computed one. */
  readonly upper_bound: number | null;
  /** Whether the measured candidate meets the goal on the declared basis. */
  readonly met: boolean;
  /** The evidence state behind the comparison. */
  readonly evidence: GoalEvidence;
}

/** One enumerated candidate of the fitting search. */
export interface FittingCandidate {
  /** The position of the candidate in the declared enumeration order. */
  readonly index: number;
  /** The enumerated candidate. */
  readonly candidate: CalibrationCandidate;
  /** Whether the candidate meets every declared constraint. */
  readonly feasible: boolean;
  /** The objective metric rate of the complete check set. */
  readonly objective: CalibrationRate;
  /** One row per declared constraint, in written order. */
  readonly constraints: readonly CalibrationGoal[];
}

/** The selected candidate of the fitting search, with its complete measurement. */
export interface SelectedCandidate extends FittingCandidate {
  /** One metric set per check of the definition, then the complete check set. */
  readonly scopes: readonly CalibrationMetricSet[];
}

/** Whether the search found one feasible candidate. */
export type FittingStatus = "feasible" | "no_feasible_candidate";

/** The complete result of one fitting search. Development evidence alone. */
export interface FittingReport {
  /** Stable plan identifier. */
  readonly plan_id: string;
  /** Computed identity of the plan in the plan domain. */
  readonly plan_content_hash: string;
  /** Name of the calibrated definition. */
  readonly definition_name: string;
  /** Content hash of the calibrated definition. */
  readonly definition_hash: string;
  /** Dataset of the fitting split. */
  readonly dataset: string;
  /** Revision of the fitting split. */
  readonly revision: string;
  /** Fitting split identifier. */
  readonly split: string;
  /** Computed hash of the fitting split records. */
  readonly split_content_hash: string;
  /** Groups the fitting split declares, in declared order. */
  readonly split_groups: readonly string[];
  /** Fitting cases the search measured. */
  readonly case_count: number;
  /** Permitted candidates the search enumerated. */
  readonly candidate_count: number;
  /** The fitting method word. Always `bounded_grid_search`. */
  readonly method: string;
  /** The interval method behind every upper bound. Always `wilson_score`. */
  readonly interval_method: string;
  /** The declared confidence level of the bounds. */
  readonly confidence_level: number;
  /** The minimum counts the plan states, by denominator name. */
  readonly minimum_samples: Readonly<Record<string, number>>;
  /** What the fitting optimizes after every constraint holds. */
  readonly objective: Readonly<{
    readonly metric: "review_rate" | "automatic_coverage";
    readonly direction: "minimize" | "maximize";
  }>;
  /** Whether one feasible candidate exists. */
  readonly status: FittingStatus;
  /** The selected candidate, or `null` when no candidate is feasible. */
  readonly selected: SelectedCandidate | null;
  /** Every enumerated candidate in declared order. */
  readonly candidates: readonly FittingCandidate[];
  /** The standing development-evidence statement. */
  readonly statement: string;
}

/** One computed uncertainty interval of the frozen validation. */
export interface QualificationInterval {
  /** Check identifier, or `all_checks`. */
  readonly scope: string;
  /** Published metric name. */
  readonly metric: string;
  /** Named interval method. Always `wilson_score`. */
  readonly method: string;
  /** The stated confidence level. */
  readonly confidence_level: number;
  /** The declared sampling model. */
  readonly sampling: string;
  /** Cases in the numerator, as the rate states them. */
  readonly numerator: number;
  /** Cases in the denominator, as the rate states them. */
  readonly denominator: number;
  /** Draws behind the interval. */
  readonly draws: number;
  /** Draws that hold at least one counted event. */
  readonly event_draws: number;
  /** Lower bound, or `null` when no bound computes. */
  readonly lower: number | null;
  /** Upper bound, or `null` when no bound computes. */
  readonly upper: number | null;
  /** The reason no bound computes, or `null` when the bounds exist. */
  readonly reason: string | null;
}

/** The intervals of one scope. */
export interface QualificationIntervalSet {
  /** Check identifier, or `all_checks`. */
  readonly scope: string;
  /** One interval per contract metric. */
  readonly intervals: readonly QualificationInterval[];
}

/** The evidence classification of the validation split. */
export interface QualificationEvidence {
  /** The class this split supports. */
  readonly class: "independent_validation" | "development";
  /** True when the dataset kind states one representative sample. */
  readonly representative_sample: boolean;
  /** Records of the split. */
  readonly record_count: number;
  /** References of the earlier uses that hold the same validation content. */
  readonly reused_from: readonly string[];
  /** True when one new qualification claim needs fresh validation evidence. */
  readonly needs_fresh_evidence: boolean;
  /** Plain statement of the classification, linked to the counts above. */
  readonly statement: string;
}

/** One stated sample requirement of the plan as the validation measured it. */
export interface SampleRequirement {
  /** The denominator name the plan states one minimum for. */
  readonly denominator: string;
  /** The stated minimum. */
  readonly stated: number;
  /** The cases the validation split holds. */
  readonly measured: number;
  /** Whether the validation meets the stated minimum. */
  readonly met: boolean;
}

/** One important slice of the plan as the validation measured it. */
export interface QualificationSlice {
  /** The case tag of the slice. */
  readonly tag: string;
  /** The minimum counts the plan states for this slice, by denominator name. */
  readonly minimum_samples: Readonly<Record<string, number>>;
  /** The counts the validation measured, by denominator name. */
  readonly denominators: Readonly<Record<string, number>>;
  /** Whether every stated minimum of this slice is met. */
  readonly met: boolean;
  /** The metric set of the complete check set of this slice. */
  readonly metrics: CalibrationMetricSet;
  /** The interval rows of the complete check set of this slice, when cases exist. */
  readonly intervals?: QualificationIntervalSet;
  /** The plain statement of this slice, linked to the counts above. */
  readonly statement: string;
}

/** One declared goal as the frozen validation measured it. */
export interface QualificationGoal extends CalibrationGoal {
  /** Draws behind the interval: cases or groups, as the sampling model states. */
  readonly draws: number;
}

/** One calculated reason behind the qualification status. */
export interface QualificationReason {
  /** One reason code of the published registry. */
  readonly code: string;
  /** The calculated statement behind the code. */
  readonly statement: string;
}

/** The complete result of one frozen validation. It selects nothing. */
export interface QualificationReport {
  /** Stable plan identifier. */
  readonly plan_id: string;
  /** Computed identity of the plan in the plan domain. */
  readonly plan_content_hash: string;
  /** Name of the calibrated definition. */
  readonly definition_name: string;
  /** Content hash of the calibrated definition. */
  readonly definition_hash: string;
  /** The evaluator configuration of the plan, recorded unchanged. */
  readonly evaluator: Readonly<{
    readonly evaluator: string;
    readonly adapter_version: string;
    readonly translation_hash?: string;
    readonly model_requested?: string;
  }>;
  /** The qualification method word. Always `frozen_validation`. */
  readonly method: string;
  /** The interval method behind every upper bound. Always `wilson_score`. */
  readonly interval_method: string;
  /** The declared confidence level of the bounds. */
  readonly confidence_level: number;
  /** The declared sampling model. */
  readonly sampling: string;
  /** The standing assumption of the sampling model. */
  readonly assumption: string;
  /** The complete statistical method statement. */
  readonly method_statement: string;
  /** The position of the frozen candidate in the declared enumeration order. */
  readonly candidate_index: number;
  /** The frozen candidate, unchanged by the validation. */
  readonly candidate: CalibrationCandidate;
  /** The policy every question check applies under this candidate. */
  readonly applied: Readonly<{
    readonly accept_cutoff: number;
    readonly rejection_cutoff: number;
    readonly confidence_floor?: number;
  }>;
  /** Dataset of the validation split. */
  readonly dataset: string;
  /** Revision of the validation split. */
  readonly revision: string;
  /** Validation split identifier. */
  readonly split: string;
  /** Computed hash of the validation split records. */
  readonly split_content_hash: string;
  /** Groups the validation split declares, in declared order. */
  readonly split_groups: readonly string[];
  /** Validation cases the validation measured. */
  readonly case_count: number;
  /** The evidence classification of the validation split. */
  readonly evidence: QualificationEvidence;
  /** The minimum counts the plan states, by denominator name. */
  readonly minimum_samples: Readonly<Record<string, number>>;
  /** One row per stated plan minimum, in the order of the plan map. */
  readonly sample_requirements: readonly SampleRequirement[];
  /** One row per declared goal, in written order. */
  readonly goals: readonly QualificationGoal[];
  /** One metric set per check of the definition, then the complete check set. */
  readonly scopes: readonly CalibrationMetricSet[];
  /** The interval rows of the complete check set, when cases exist. */
  readonly intervals?: QualificationIntervalSet;
  /** One row per important slice of the plan, in written order. */
  readonly slices: readonly QualificationSlice[];
  /** The computed qualification status. */
  readonly status: QualificationStatus;
  /** The calculated reasons behind the status, in decision order. */
  readonly reasons: readonly QualificationReason[];
  /** The standing candidate statement. */
  readonly statement: string;
}

/** The complete result of one calibration. */
export interface Calibration {
  /** The candidate profile artifact. Frozen, signed, and loadable as generated. */
  readonly profile: Profile;
  /** The fitting report: the search over the development assessments. */
  readonly fitting: FittingReport;
  /**
   * The frozen validation of the selected candidate. Absent when the search
   * found no feasible candidate, because no frozen candidate exists to
   * validate and the calibration spent no validation budget.
   */
  readonly qualification: QualificationReport | undefined;
  /** One run report per measured case, in measurement order. */
  readonly runs: readonly RunReport[];
  /** Standing statements that keep the limits of these numbers visible. */
  readonly limitations: readonly string[];
}

/** The greatest length of one evaluation-report reference, from the profile contract. */
const REPORT_REFERENCE_LIMIT = 500;

/**
 * The standing retention rule of every calibration.
 *
 * The profile records the references of its evaluation reports, and the
 * host owns the storage. One folder that version control ignores, such as
 * the default `reports/` convention, holds no required copy of the
 * qualification evidence that one selected profile needs.
 */
export const RETENTION_STATEMENT =
  "The profile records the references of its evaluation reports, and the host owns that storage. Store one reviewed copy of the fitting report, the qualification report, and the plan beside the selected profile. One folder that version control ignores holds no required copy of the qualification evidence.";

/** The synthetic path that serves the measurement profile to `load`. */
export const MEASUREMENT_PROFILE_PATH = "measuretwice://calibration/measurement-profile.json";

/** The synthetic path that proves the candidate profile loads. */
export const CANDIDATE_PROFILE_PATH = "measuretwice://calibration/candidate-profile.json";

// ---------------------------------------------------------------------------
// The calibration workflow.
// ---------------------------------------------------------------------------

/**
 * Runs one complete calibration and returns the candidate profile.
 *
 * The workflow reads the plan and the dataset, checks every binding of the
 * plan against the loaded world, measures every case of the fitting split
 * through the registered evaluator, searches the permitted candidate family
 * in the Rust core, freezes the selected candidate, and validates it on the
 * independent validation split. The returned profile records the evidence
 * and the measured performance, and its qualification states what the
 * evidence established. The calibration writes no file, stores no report,
 * changes no host selection, and promotes nothing: the host reviews the
 * recorded evidence and selects one reviewed content hash through its own
 * code.
 *
 * @param definition The calibrated definition: the result of `defineChecks`
 * as one trusted import, or one explicit path to a JSON definition file.
 * @param options The plan, the dataset, the evaluator registry, the sampling
 * model, the evaluation-report references, and the optional execution,
 * cancellation, and file-access controls.
 * @returns The frozen calibration: the candidate profile, the fitting
 * report, the qualification report of the frozen candidate, one run report
 * per measured case, and the standing limitations.
 * @throws {ValidationError} when one option breaks its shape, when the plan
 * or the dataset fails its contract, when the plan binds another definition,
 * evaluator, or dataset, when one measured case ends without one stored
 * assessment, when the measurements resolved two model versions, or when one
 * calculation exceeds the published fitting budget.
 * @throws {Error} when one stated path stays unreadable.
 */
export async function calibrate(
  definition: Definition | string,
  options: CalibrateOptions,
): Promise<Calibration> {
  checkOptions(options);
  if (options.signal?.aborted) {
    throw new ValidationError(
      "cancelled_before_start",
      "The calibration signal aborted before one case was measured. No calibration ran, no candidate exists, and nothing was promoted.",
      "/cases",
    );
  }

  const files = options.files ?? defaultFiles;
  let definitionText: string;
  let artifact: Definition | undefined;
  if (typeof definition === "string") {
    requireJsonPath(definition, "/definition");
    definitionText = await readText(files, definition);
  } else {
    definitionText = jsonText(definition, "");
    artifact = definition;
  }
  const info = throughCore(() => nativeValidateDefinition(definitionText));
  if (artifact === undefined) {
    const parsed: unknown = JSON.parse(definitionText);
    deepFreeze(parsed);
    artifact = parsed as Definition;
  }

  // The plan and the dataset cross through the same bounded readers the
  // library uses everywhere, and the core stays the one validation
  // authority over both. The definition and the evaluator checks of the
  // plan run before one dataset is read, so one plan that cannot measure
  // the loaded definition refuses before any data work.
  requireJsonPath(options.plan, "/plan");
  const planText = await readText(files, options.plan);
  const plan = throughCore(() => nativeValidatePlan(planText));
  const registered = options.evaluators.ids.map((id) => {
    const evaluator = options.evaluators.get(id);
    if (evaluator === undefined) {
      throw new Error(
        `measuretwice found no registered evaluator ${JSON.stringify(id)} that the registry names. This is one internal inconsistency.`,
      );
    }
    return { evaluator: id, adapter_version: evaluator.adapter_version };
  });
  throughCore(() =>
    nativeCheckCalibrationBinding(planText, definitionText, JSON.stringify(registered)),
  );
  const source = await readDatasetTexts(options.metadata, options.records, files);
  const dataset = datasetOf(source, definitionText);

  // The dataset checks of the plan run before one case is measured: both
  // selections name the offered splits of their declared purpose, and the
  // two share no group and no case.
  const fittingSplit = splitOf(dataset.splits, plan.fitting, "fitting");
  const validationSplit = splitOf(dataset.splits, plan.validation, "validation");
  throughCore(() =>
    nativeCheckCalibrationDatasets(
      planText,
      JSON.stringify(splitIdentityValue(fittingSplit)),
      JSON.stringify(splitIdentityValue(validationSplit)),
    ),
  );

  // The measurement profile binds every question check to the evaluator the
  // plan names, with the model the plan requests. Its starter policy decides
  // the measurement runs alone; the search replays the stored assessments
  // under every candidate, so no starter threshold reaches the candidate.
  const questionChecks = info.checkKinds.filter((entry) => entry.kind !== "rule");
  const bindings: Record<string, string | { evaluator: string; model?: string }> = {};
  for (const check of questionChecks) {
    bindings[check.id] =
      plan.modelRequested === undefined || plan.modelRequested === null
        ? plan.evaluator
        : { evaluator: plan.evaluator, model: plan.modelRequested };
  }
  const measurement = createExplorationProfile(artifact, options.evaluators, {
    bindings,
    ...(options.execution === undefined ? {} : { execution: options.execution }),
  });
  const reviewer = await load(artifact, {
    profile: MEASUREMENT_PROFILE_PATH,
    evaluators: options.evaluators,
    files: servingFiles(files, MEASUREMENT_PROFILE_PATH, JSON.stringify(measurement)),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.nextRunId === undefined ? {} : { nextRunId: options.nextRunId }),
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
  });

  // Phase one: measure the fitting split, then search the permitted family.
  // One case without one stored assessment refuses here, because the search
  // replays one stored assessment of every fitting case.
  const runs: RunReport[] = [];
  const resolvedModels: string[] = [];
  const fittingAssessments = await measureSplit(reviewer, dataset, fittingSplit, options.signal, runs, resolvedModels);
  const fitting = parseFittingReport(
    await throughCoreAsync(() =>
      nativeFitPolicy(
        planText,
        source.metadataText,
        source.recordsText,
        definitionText,
        JSON.stringify(fittingAssessments),
      ),
    ),
  );

  // No feasible candidate is one valid result: the profile records the
  // objective-best candidate with `criteria_not_met`, the fitting report
  // states every unmet goal, and the validation budget stays unspent.
  const resolved = fitting.selected ?? objectiveBest(fitting);
  if (resolved === undefined) {
    throw new Error(
      "measuretwice received one fitting report that states no feasible candidate and enumerates none. This is one internal inconsistency.",
    );
  }
  if (fitting.selected === null) {
    const value: Calibration = {
      profile: await candidateProfile({
        measurement,
        plan,
        dataset: dataset.identity,
        labels: dataset.labels,
        fittingSplit,
        validationSplit,
        candidate: resolved.candidate,
        status: "criteria_not_met",
        reasons: ["criteria_not_met"],
        methodStatement: noCandidateMethod(fitting),
        performance: undefined,
        resolvedModel: singleResolution(resolvedModels),
        definition: artifact,
        evaluators: options.evaluators,
        files,
        options,
      }),
      fitting,
      qualification: undefined,
      runs: Object.freeze([...runs]),
      limitations: noCandidateLimitations(fitting, dataset.identity),
    };
    deepFreeze(value);
    return value;
  }
  refuseOnAbort(options.signal, "fitting");

  // Phase two: freeze the selected candidate and validate it on the
  // independent split. The core re-runs the deterministic search over the
  // same fitting assessments, so the validated candidate is the selected
  // candidate.
  const validationAssessments = await measureSplit(
    reviewer,
    dataset,
    validationSplit,
    options.signal,
    runs,
    resolvedModels,
  );
  const request = JSON.stringify({
    sampling: options.sampling,
    ...(options.previouslyUsed === undefined
      ? {}
      : { previously_used: options.previouslyUsed.map(splitIdentityValue) }),
  });
  const qualification = parseQualificationReport(
    await throughCoreAsync(() =>
      nativeQualifyCandidate(
        planText,
        source.metadataText,
        source.recordsText,
        definitionText,
        JSON.stringify(fittingAssessments),
        request,
        JSON.stringify(validationAssessments),
      ),
    ),
  );

  const limitations: string[] = [fitting.statement, qualification.statement];
  if (!dataset.identity.states_prevalence) {
    limitations.push(
      `The dataset kind ${dataset.identity.kind} states no production prevalence. No rate of this calibration estimates production prevalence.`,
    );
  }
  if (!dataset.identity.supports_qualification) {
    limitations.push(
      `The population statement ${dataset.identity.population} supports no qualification claim.`,
    );
  }
  limitations.push(qualification.evidence.statement);
  limitations.push(RETENTION_STATEMENT);
  const value: Calibration = {
    profile: await candidateProfile({
      measurement,
      plan,
      dataset: dataset.identity,
      labels: dataset.labels,
      fittingSplit,
      validationSplit,
      candidate: resolved.candidate,
      status: qualification.status,
      reasons: qualification.reasons.map((reason) => reason.code),
      methodStatement: qualification.method_statement,
      performance: performanceOf(qualification),
      resolvedModel: singleResolution(resolvedModels),
      definition: artifact,
      evaluators: options.evaluators,
      files,
      options,
    }),
    fitting,
    qualification,
    runs: Object.freeze([...runs]),
    limitations: Object.freeze(limitations),
  };
  deepFreeze(value);
  return value;
}

// ---------------------------------------------------------------------------
// Option and input checks.
// ---------------------------------------------------------------------------

/**
 * Checks the stated options before one read happens.
 *
 * # Errors
 *
 * Returns one {@link ValidationError} with `missing_field` or
 * `invalid_field_type` at the field of the broken option.
 */
function checkOptions(options: CalibrateOptions): void {
  if (options.plan === undefined) {
    throw new ValidationError("missing_field", "The calibration states no plan.", "/plan");
  }
  if (options.metadata === undefined) {
    throw new ValidationError(
      "missing_field",
      "The calibration states no dataset metadata path.",
      "/metadata",
    );
  }
  if (options.records === undefined) {
    throw new ValidationError(
      "missing_field",
      "The calibration states no dataset records path.",
      "/records",
    );
  }
  if (
    typeof options.evaluators !== "object" ||
    options.evaluators === null ||
    !Array.isArray(options.evaluators.ids) ||
    typeof options.evaluators.get !== "function"
  ) {
    throw new ValidationError(
      "invalid_field_type",
      "The calibration states no evaluator registry. Pass the registry of registerEvaluators, because one loaded plan installs no evaluator.",
      "/evaluators",
    );
  }
  if (options.sampling === undefined) {
    throw new ValidationError(
      "missing_field",
      "The calibration states no sampling model. Declare independent_cases or grouped_cases, because every validation interval rests on the stated model.",
      "/sampling",
    );
  }
  if (options.sampling !== "independent_cases" && options.sampling !== "grouped_cases") {
    throw new ValidationError(
      "invalid_field_type",
      `The sampling model ${JSON.stringify(options.sampling)} names no supported model. State independent_cases or grouped_cases.`,
      "/sampling",
    );
  }
  if (options.evaluationReports === undefined) {
    throw new ValidationError(
      "missing_field",
      "The calibration states no evaluation-report references. One candidate profile records where its evidence lives, and the host owns that storage.",
      "/evaluationReports",
    );
  }
  if (!Array.isArray(options.evaluationReports) || options.evaluationReports.length === 0) {
    throw new ValidationError(
      "invalid_field_type",
      "The evaluation-report references must hold one nonempty array of strings. State where the returned reports are stored.",
      "/evaluationReports",
    );
  }
  for (const [index, reference] of options.evaluationReports.entries()) {
    if (
      typeof reference !== "string" ||
      reference === "" ||
      reference.length > REPORT_REFERENCE_LIMIT
    ) {
      throw new ValidationError(
        "invalid_field_type",
        `The evaluation-report reference at ${index} states no nonempty string of at most ${REPORT_REFERENCE_LIMIT} characters.`,
        `/evaluationReports/${index}`,
      );
    }
  }
}

/**
 * Locates one split of the loaded dataset for one plan selection.
 *
 * The dataset states the identity of every split it declares, and one
 * selection receives the true identity of the split it names, whatever
 * purpose the dataset declares, so the core reports one purpose, dataset, or
 * revision mismatch as itself. One selection that names no declared split
 * refuses here with the wording of the core split locator, because no
 * identity exists for the core to compare.
 */
export function splitOf(
  splits: readonly DatasetSplitIdentity[],
  selection: Readonly<{ dataset: string; revision: string; split: string }>,
  role: "fitting" | "validation",
): DatasetSplitIdentity {
  const declared = splits.find((split) => split.split === selection.split);
  if (declared === undefined) {
    throw new ValidationError(
      "invalid_field_type",
      `The selection names the split ${JSON.stringify(selection.split)}, but the dataset declares no split of that identifier.`,
      `/plan/datasets/${role}/split`,
    );
  }
  return declared;
}

/** Moves one public split identity into the boundary shape of the core. */
export function splitIdentityValue(split: DatasetSplitIdentity): Record<string, unknown> {
  return {
    dataset: split.dataset,
    revision: split.revision,
    split: split.split,
    purpose: split.purpose,
    groups: [...split.groups],
    record_count: split.record_count,
    content_hash: split.content_hash,
    case_ids: [...split.case_ids],
  };
}

/** Serves one synthetic artifact through one file access and delegates every other read. */
export function servingFiles(base: FileAccess, path: string, text: string): FileAccess {
  return {
    async read(filePath: string): Promise<string> {
      if (filePath === path) {
        return text;
      }
      return base.read(filePath);
    },
  };
}

// ---------------------------------------------------------------------------
// The measurement phase.
// ---------------------------------------------------------------------------

/**
 * Measures every case of one split and returns the stored assessments.
 *
 * Every case runs as one shadow run of the bound reviewer, in split order,
 * inside the effective execution configuration of the measurement profile.
 * One run that ends without one stored assessment of one question check
 * refuses the calibration with the operational code of its record, because
 * no search may invent one assessment. Every model version the executions
 * reported joins `resolvedModels`, so one alias that resolved two versions
 * refuses the calibration after the phase ends.
 */
export async function measureSplit(
  reviewer: Reviewer<Readonly<Record<string, unknown>>>,
  dataset: Dataset,
  split: DatasetSplitIdentity,
  signal: AbortSignal | undefined,
  runs: RunReport[],
  resolvedModels: string[],
): Promise<Record<string, Record<string, unknown>>> {
  const byId = new Map(dataset.cases.map((record) => [record.id, record]));
  const assessments: Record<string, Record<string, unknown>> = {};
  for (const caseId of split.case_ids) {
    refuseOnAbort(signal, "measurement");
    const record = byId.get(caseId);
    if (record === undefined) {
      throw new Error(
        `measuretwice found no record for the case ${JSON.stringify(caseId)} of the split ${JSON.stringify(split.split)}. The core validated the dataset and its splits, so this is one internal inconsistency.`,
      );
    }
    const run = await reviewer.run(
      dataset.runCase(record),
      signal === undefined ? {} : { signal },
    );
    runs.push(run);
    if (run.completion.status === "cancelled") {
      throw new ValidationError(
        "run_cancelled",
        `The measurement of the case ${JSON.stringify(caseId)} cancelled before it stored one assessment of every question check, so no calibration can run on partial data. Nothing was promoted.`,
        `/cases/${caseId}`,
      );
    }
    if (run.completion.status === "deadline_exceeded") {
      throw new ValidationError(
        "deadline_exceeded",
        `The measurement of the case ${JSON.stringify(caseId)} ended at its total deadline before it stored one assessment of every question check. Widen the execution configuration of the calibration and run it again.`,
        `/cases/${caseId}`,
      );
    }
    const byCheck: Record<string, unknown> = {};
    for (const check of run.checks) {
      if (check.kind === "rule") {
        continue;
      }
      if (check.outcome === "error" || check.outcome === "skipped") {
        const reason = check.reason;
        throw new ValidationError(
          reason?.code ?? "evaluator_error",
          `The check ${JSON.stringify(check.check)} of the case ${JSON.stringify(caseId)} stored no assessment: ${reason === undefined ? "the record states no reason" : `${reason.code}: ${reason.message}`}. One calibration replays one stored assessment of every question check of every measured case, so measure the case again.`,
          `/assessments/${caseId}/${check.check}`,
        );
      }
      if (check.assessment === undefined) {
        throw new Error(
          `measuretwice received one ${check.outcome} record of the check ${JSON.stringify(check.check)} that states no assessment. This is one internal inconsistency.`,
        );
      }
      byCheck[check.check] = check.assessment;
      const resolved = check.evaluator?.model_resolved;
      if (resolved !== undefined && !resolvedModels.includes(resolved)) {
        resolvedModels.push(resolved);
      }
    }
    assessments[caseId] = byCheck;
  }
  return assessments;
}

/** Refuses one calibration whose signal aborted during its measurements. */
export function refuseOnAbort(signal: AbortSignal | undefined, phase: string): void {
  if (signal?.aborted) {
    throw new ValidationError(
      "run_cancelled",
      `The calibration signal aborted during the ${phase} measurements, so no calibration can run on partial data. No candidate exists, and nothing was promoted.`,
      "/cases",
    );
  }
}

/** Returns the one model version the measurements resolved, or undefined. */
export function singleResolution(resolvedModels: readonly string[]): string | undefined {
  if (resolvedModels.length > 1) {
    throw new ValidationError(
      "model_resolution_changed",
      `The measurements resolved ${resolvedModels.length} model versions (${resolvedModels.map((model) => JSON.stringify(model)).join(", ")}). One calibration measures with one model, so no candidate profile can record one binding. Resolve one model version and calibrate again.`,
      "/bindings/0/model/resolved",
    );
  }
  return resolvedModels[0];
}

// ---------------------------------------------------------------------------
// The candidate artifact.
// ---------------------------------------------------------------------------

/** The inputs of one candidate profile. */
/** The candidate-naming options the shared profile builder reads. */
export interface CandidateNaming {
  /** The stable identifier of the candidate profile. */
  readonly id?: string;
  /** The declared population and scope of the candidate. */
  readonly intendedUse?: string;
  /** The references to the evaluation reports in host storage. */
  readonly evaluationReports: readonly string[];
}

/**
 * The inputs of one candidate profile. Internal to the package: the
 * revision workflow of `revise.ts` shares this builder, and the package
 * entry point re-exports none of it.
 */
export interface CandidateInput {
  readonly measurement: Profile;
  readonly plan: NativePlanInfo;
  readonly dataset: DatasetIdentity;
  readonly labels: LabelReview;
  readonly fittingSplit: DatasetSplitIdentity;
  readonly validationSplit: DatasetSplitIdentity;
  readonly candidate: CalibrationCandidate;
  readonly status: QualificationStatus;
  readonly reasons: readonly string[];
  readonly methodStatement: string;
  readonly performance: ProfilePerformance | undefined;
  readonly resolvedModel: string | undefined;
  readonly definition: Definition;
  readonly evaluators: EvaluatorRegistry;
  readonly files: FileAccess;
  readonly options: CandidateNaming;
}

/**
 * Builds, signs, and proves one candidate profile.
 *
 * The artifact copies the evaluator bindings of the measurement profile
 * with the resolved model version, applies the frozen candidate to every
 * question check, records the complete evidence the profile contract
 * requires, and states the qualification the evidence established. The core
 * signs it with the profile self-hash and validates the complete contract.
 * One load through the public boundary then proves the artifact binds to
 * the definition and the live evaluators as generated, so the host receives
 * one profile that `load` accepts.
 */
export async function candidateProfile(input: CandidateInput): Promise<Profile> {
  const bindings = input.measurement.bindings.map((binding) => ({
    ...binding,
    ...(input.resolvedModel !== undefined && binding.model !== undefined
      ? { model: { ...binding.model, resolved: input.resolvedModel } }
      : {}),
  }));
  const artifact: Omit<Profile, "content_hash"> = {
    schema_version: 1,
    id: input.options.id ?? calibratedId(input.plan, input.measurement),
    origin: "calibration",
    intended_use: input.options.intendedUse ?? input.plan.intendedPopulation,
    definition: {
      name: input.plan.definitionName,
      content_hash: input.plan.definitionHash,
    },
    bindings,
    policy: {
      family: "probability_mass_v0",
      checks: (input.measurement.policy.checks ?? []).map((entry) => ({
        check: entry.check,
        accept_cutoff: input.candidate.accept_cutoff,
        rejection_cutoff: input.candidate.rejection_cutoff,
        ...(input.candidate.confidence_floor === null
          ? {}
          : { confidence_floor: input.candidate.confidence_floor }),
      })),
    },
    execution: input.measurement.execution,
    evidence: {
      plan: { id: input.plan.id, content_hash: input.plan.contentHash },
      datasets: [
        {
          id: input.dataset.dataset_id,
          revision: input.dataset.revision,
          content_hash: input.dataset.content_hash,
        },
      ],
      splits: [
        { id: input.fittingSplit.split, content_hash: input.fittingSplit.content_hash },
        { id: input.validationSplit.split, content_hash: input.validationSplit.content_hash },
      ],
      label_provenance: labelProvenance(input.labels, input.dataset.dataset_id),
      evaluation_reports: [...input.options.evaluationReports],
      statistical_method: input.methodStatement,
    },
    ...(input.performance === undefined ? {} : { performance: input.performance }),
    qualification: {
      status: input.status,
      scope: input.options.intendedUse ?? input.plan.intendedPopulation,
      reasons: [...input.reasons],
    },
  };
  const contentHash = throughCore(() =>
    nativeComputeSelfHash("profile", JSON.stringify(artifact)),
  );
  const profile: Profile = { ...artifact, content_hash: contentHash };
  const profileText = JSON.stringify(profile);

  // The core validates the signed artifact, then the public boundary proves
  // it loads: the complete contract, the stored self-hash, and the shadow
  // compatibility of every binding.
  const validated = throughCore(() => nativeValidateProfile(profileText));
  if (
    validated.id !== profile.id ||
    validated.origin !== "calibration" ||
    validated.qualificationStatus !== profile.qualification.status
  ) {
    throw new Error(
      "measuretwice generated one candidate profile that the core read differently. This is one internal inconsistency.",
    );
  }
  const bound = await load(input.definition, {
    profile: CANDIDATE_PROFILE_PATH,
    evaluators: input.evaluators,
    files: servingFiles(input.files, CANDIDATE_PROFILE_PATH, profileText),
  });
  if (bound.profile?.content_hash !== profile.content_hash) {
    throw new Error(
      "measuretwice generated one candidate profile that the load boundary refused. This is one internal inconsistency.",
    );
  }
  deepFreeze(profile);
  return profile;
}

/** Names one candidate profile after its definition. */
function calibratedId(plan: NativePlanInfo, measurement: Profile): string {
  const id = `${measurement.definition.name}-calibrated`;
  // The artifact identifier rule bounds the length at 64 characters.
  return id.length <= 64 ? id : `calibrated-${plan.contentHash.slice(0, 52)}`;
}

/**
 * States the label provenance of one calibration from the counted review.
 *
 * The statement counts what the dataset states, keeps human judgments apart
 * from model proposals, and adds no claim of its own.
 */
export function labelProvenance(labels: LabelReview, datasetId: string): string {
  const summary = labels.summary;
  return (
    `The dataset ${datasetId} holds ${summary.records} records: ${summary.labeled} labeled ` +
    `(${summary.human_reviewed} human reviewed, ${summary.model_reviewed} model proposals reviewed, ` +
    `${summary.human_unreviewed} human references without review, ${summary.model_unreviewed} model ` +
    "proposals without review). Model suggestions are not human judgments."
  );
}

/**
 * Reads the recorded performance of one qualification report.
 *
 * Every rate of every scope, the bounds of the complete check set, the
 * measured sample counts with the stated minimums of the plan, and the
 * statement of every important slice cross unchanged, so one profile states
 * what the validation measured and the limits that the plan declared, and
 * nothing else.
 */
export function performanceOf(report: QualificationReport): ProfilePerformance {
  const metrics = report.scopes.flatMap((set) =>
    set.rates.map((rate) => ({
      scope: set.scope,
      metric: rate.metric,
      numerator: rate.numerator,
      denominator: rate.denominator,
      value: rate.value,
    })),
  );
  const intervals = (report.intervals?.intervals ?? [])
    .filter((interval) => interval.lower !== null && interval.upper !== null)
    .map((interval) => ({
      scope: interval.scope,
      metric: interval.metric,
      method: interval.method,
      confidence_level: interval.confidence_level,
      lower: interval.lower as number,
      upper: interval.upper as number,
    }));
  const sample_counts: Record<string, number> = {};
  const sample_minimums: Record<string, number> = {};
  for (const requirement of report.sample_requirements) {
    sample_counts[requirement.denominator] = requirement.measured;
    sample_minimums[requirement.denominator] = requirement.stated;
  }
  return {
    metrics,
    ...(intervals.length === 0 ? {} : { intervals }),
    sample_counts,
    sample_minimums,
    ...(report.slices.length === 0
      ? {}
      : { slice_limitations: report.slices.map((slice) => slice.statement) }),
  };
}

/** The statistical-method statement of one calibration without one feasible candidate. */
export function noCandidateMethod(fitting: FittingReport): string {
  return (
    `The fitting method ${fitting.method} measured ${fitting.case_count} fitting cases of the split ` +
    `${JSON.stringify(fitting.split)} at confidence ${fitting.confidence_level}, with ` +
    `${fitting.interval_method} bounds. No frozen validation ran, because no candidate of the ` +
    "permitted family meets the declared goals, so this profile states no validation evidence."
  );
}

/** The standing limitations of one calibration without one feasible candidate. */
export function noCandidateLimitations(fitting: FittingReport, identity: DatasetIdentity): string[] {
  const limitations: string[] = [fitting.statement];
  if (!identity.states_prevalence) {
    limitations.push(
      `The dataset kind ${identity.kind} states no production prevalence. No rate of this calibration estimates production prevalence.`,
    );
  }
  if (!identity.supports_qualification) {
    limitations.push(
      `The population statement ${identity.population} supports no qualification claim.`,
    );
  }
  limitations.push(
    "No candidate of the permitted family meets the declared goals. The recorded policy is the objective-best candidate of the family, it fails the declared goals, and it supports no enforcement use.",
  );
  limitations.push(RETENTION_STATEMENT);
  return limitations;
}

// ---------------------------------------------------------------------------
// The core results.
// ---------------------------------------------------------------------------

/** Runs one core operation that resolves asynchronously and lifts its failure. */
export async function throughCoreAsync<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof NativeFailure) {
      throw new ValidationError(error.code, error.message, error.fieldPath);
    }
    throw error;
  }
}

/** Parses and freezes one fitting report of the core. */
export function parseFittingReport(text: string): FittingReport {
  const value: unknown = JSON.parse(text);
  deepFreeze(value);
  return value as FittingReport;
}

/** Parses and freezes one qualification report of the core. */
export function parseQualificationReport(text: string): QualificationReport {
  const value: unknown = JSON.parse(text);
  deepFreeze(value);
  return value as QualificationReport;
}

/**
 * Returns the candidate that optimizes the objective when none is feasible.
 *
 * The comparison is exact over the rate counts, exactly as the search
 * compares two feasible candidates, and the earlier candidate of the
 * enumeration order wins one tie. The result records what the family offers;
 * the profile states `criteria_not_met`, so it supports no enforcement use.
 */
export function objectiveBest(fitting: FittingReport): FittingCandidate | undefined {
  let best: FittingCandidate | undefined;
  for (const candidate of fitting.candidates) {
    if (best === undefined || betterOnObjective(fitting, candidate.objective, best.objective)) {
      best = candidate;
    }
  }
  return best;
}

/** Returns true when one rate improves on another in the declared direction. */
function betterOnObjective(
  fitting: FittingReport,
  candidate: CalibrationRate,
  incumbent: CalibrationRate,
): boolean {
  const left = candidate.numerator * incumbent.denominator;
  const right = incumbent.numerator * candidate.denominator;
  return fitting.objective.direction === "minimize" ? left < right : left > right;
}
