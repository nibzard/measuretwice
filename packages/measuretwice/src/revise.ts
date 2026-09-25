// SPDX-License-Identifier: Apache-2.0
/**
 * `revise`: one policy-only revision of one stored calibration.
 *
 * MVP_SPEC.md section 8 states the rule: one policy-only change can reuse
 * compatible stored assessments for fitting, but it still requires
 * independent validation before promotion. This module owns the
 * orchestration alone. The Rust core owns every rule: the reuse boundary
 * of `measuretwice_core::revision` verifies the prior artifacts and the
 * identity of every input and evaluator, the fitting search replays the
 * stored assessments under the revised plan, the frozen validation
 * measures the candidate on independent cases, and the same core module
 * compares the prior policy with the revised policy over the same stored
 * assessments.
 *
 * The workflow states its prior calibration: the value `calibrate`
 * returned and the host stored. The core verifies it before one
 * assessment is replayed. The prior profile passes the complete contract
 * and its stored self-hash, and the prior profile and the revision plan
 * bind the loaded definition, so one changed question, criterion, schema,
 * or input projection refuses with `definition_mismatch`: all four live
 * inside the definition hash. The plan measures with the evaluator the
 * prior profile bound, under the same adapter version, the same
 * translated question, and the same requested model, and the live
 * registry state serves that same binding today, so one changed adapter,
 * translation, model resolution, or preprocessing identity refuses with
 * the compatibility code of the registry. The fitting split of the loaded
 * dataset carries the content hash the prior profile recorded, and every
 * stored run rebuilds through the run report contract, binds the prior
 * profile, and names one case of one loaded split with the input hash of
 * the loaded record, so one edited record, one exchanged split, or one
 * foreign run refuses with `hash_mismatch` before any search runs.
 *
 * Reuse measures nothing on the fitting split: the search replays the
 * stored assessments under every candidate of the revised plan, exactly
 * as the fitting boundary permits. The validation split decides what the
 * revision measures:
 *
 * - The prior calibration measured the loaded validation split when its
 *   stored runs name its cases. That content was consumed: the revision
 *   replays the stored validation assessments under the frozen candidate,
 *   declares the split as previously used, and the frozen validation
 *   classifies it as development data, so the new candidate states
 *   `insufficient_evidence` with its counts and needs fresh independent
 *   evidence. No spend happens, and the prior validation cannot validate
 *   one revised policy, however better it looks on development data.
 * - No stored assessment names one case of the loaded validation split,
 *   because the host loaded one fresh split of one later dataset
 *   revision. The revision measures that split through the registered
 *   evaluator on the same validated execution path as one ordinary run,
 *   and the frozen validation reads the fresh independent evidence.
 *
 * The result holds one new candidate profile, one fitting report, one
 * qualification report, the measurement runs of the fresh split alone,
 * the revision comparison, and the verified reuse. The profile is one new
 * artifact with its own content hash and its own identifier: one policy
 * change never edits one stored profile, and the prior artifact stays
 * byte-identical. Whatever the evidence established, the revision
 * promotes nothing: the host reviews the recorded evidence and selects
 * one reviewed content hash through its own code.
 *
 * Failure behavior: one absent or malformed option, one prior artifact
 * that fails its contract, one changed identity of the definition, the
 * evaluator, the adapter, the translation, the model, the preprocessing,
 * or the inputs, one plan or dataset that fails its contract, and one
 * calculation that exceeds the published fitting budget throw one public
 * {@link ValidationError} with a stable reason code and a field path. One
 * evaluator failure on one measured case of one fresh split refuses with
 * the operational code of the record. One model alias that resolved to
 * two versions across the stored and the fresh measurements refuses with
 * `model_resolution_changed`. One aborted `signal` refuses with
 * `run_cancelled`, and one aborted before the first case with
 * `cancelled_before_start`. One unreadable path throws one ordinary
 * `Error` that names the path.
 */
import type { Definition } from "./define-checks.js";
import type { DatasetSplitIdentity } from "./dataset.js";
import { datasetOf, readDatasetTexts } from "./dataset.js";
import type { EvaluatorRegistry } from "./evaluator.js";
import { createExplorationProfile } from "./exploration.js";
import { ValidationError } from "./error.js";
import {
  nativeCheckCalibrationBinding,
  nativeCheckCalibrationDatasets,
  nativeCheckRevision,
  nativeCompareRevision,
  nativeFitPolicy,
  nativeQualifyCandidate,
  nativeValidateDefinition,
  nativeValidatePlan,
  type NativePlanInfo,
} from "./native.js";
import type { ChangedCase, ComparisonMetric } from "./compare.js";
import {
  MEASUREMENT_PROFILE_PATH,
  RETENTION_STATEMENT,
  candidateProfile,
  measureSplit,
  noCandidateLimitations,
  noCandidateMethod,
  objectiveBest,
  parseFittingReport,
  parseQualificationReport,
  performanceOf,
  refuseOnAbort,
  servingFiles,
  singleResolution,
  splitIdentityValue,
  splitOf,
  throughCoreAsync,
  type Calibration,
  type CalibrationCandidate,
  type CalibrationSampling,
  type FittingReport,
  type QualificationReport,
} from "./calibrate.js";
import {
  deepFreeze,
  defaultFiles,
  jsonText,
  load,
  liveEvaluatorBindings,
  readText,
  requireJsonPath,
  throughCore,
  type ExecutionConfig,
  type FileAccess,
  type Profile,
  type ProfilePerformance,
  type QualificationStatus,
  type RunReport,
} from "./run.js";

// ---------------------------------------------------------------------------
// Public types of the revision path.
// ---------------------------------------------------------------------------

/** The disposition of the validation data of one revision. */
export type ValidationDisposition =
  | { readonly disposition: "reused"; readonly cases: number }
  | { readonly disposition: "fresh" };

/** One binding of the prior profile with the identity the reuse verified. */
export interface RevisionBinding {
  /** The bound check. */
  readonly check: string;
  /** The registered evaluator that serves it. */
  readonly evaluator: string;
  /** The adapter version of the binding. */
  readonly adapter_version: string;
  /** The content hash of the recorded translated question. */
  readonly translation_hash: string;
  /** The requested model alias, when the binding records one. */
  readonly model_requested?: string;
  /** The model version the stored assessments resolved, when one is recorded. */
  readonly model_resolved?: string;
  /** The preprocessing identity, when the binding records one. */
  readonly preprocessing?: string;
}

/** One split of the loaded dataset, with the identity the reuse read. */
export interface RevisionSplit {
  /** Stable split identifier. */
  readonly id: string;
  /** Dataset revision of the split. */
  readonly revision: string;
  /** Computed content hash of the split records. */
  readonly content_hash: string;
  /** Case records of the split. */
  readonly record_count: number;
}

/** The verified reuse of the stored assessments of one prior calibration. */
export interface RevisionReuse {
  /** Stable identifier of the prior profile. */
  readonly prior_profile_id: string;
  /** Verified self-hash of the prior profile artifact. */
  readonly prior_profile_content_hash: string;
  /** The plan the prior profile records. */
  readonly prior_plan: Readonly<{ readonly id: string; readonly content_hash: string }>;
  /** The dataset the prior profile records. */
  readonly prior_dataset: string;
  /** The splits the prior profile records. */
  readonly prior_splits: readonly Readonly<{
    readonly id: string;
    readonly content_hash: string;
  }>[];
  /** Name of the definition both artifacts bind. */
  readonly definition_name: string;
  /** Content hash of the definition both artifacts bind. */
  readonly definition_hash: string;
  /** Every binding of the prior profile with its verified identity. */
  readonly bindings: readonly RevisionBinding[];
  /** The fitting split of the loaded dataset. */
  readonly fitting_split: RevisionSplit;
  /** The validation split of the loaded dataset. */
  readonly validation_split: RevisionSplit;
  /** Fitting cases the stored runs measured. */
  readonly stored_fitting_cases: number;
  /** The classification of the validation data. */
  readonly validation_data: ValidationDisposition;
  /** Every model version the stored fitting assessments resolved. */
  readonly resolved_models: readonly string[];
  /** What the check verified, with the counts it read. */
  readonly statement: string;
  /** The standing limits of this reuse. */
  readonly limitations: readonly string[];
}

/** One applied policy row of one side of one revision comparison. */
export interface RevisionPolicyRow {
  /** The question check this policy decides. */
  readonly check: string;
  /** The applied parameters. */
  readonly policy: Readonly<{
    readonly accept_cutoff: number;
    readonly rejection_cutoff: number;
    readonly confidence_floor?: number;
  }>;
}

/** One side of one revision comparison. */
export interface RevisionSide {
  /** The prior profile of the baseline side, or the plan of the candidate side. */
  readonly source: Readonly<{ readonly id: string; readonly content_hash: string }>;
  /** The applied policy of every question check, in definition order. */
  readonly policy: readonly RevisionPolicyRow[];
}

/** The matching of one revision comparison. */
export interface RevisionMatching {
  /** Fitting cases both policies replayed. */
  readonly matched_cases: number;
  /** Matched cases with at least one changed component outcome. */
  readonly changed_cases: number;
  /** Matched cases whose outcomes stayed equal. */
  readonly unchanged_cases: number;
}

/** The comparison of one prior policy and one revised policy. */
export interface RevisionComparison {
  /** The prior side: the profile the stored assessments measured under. */
  readonly baseline: RevisionSide;
  /** The revised side: the plan that froze the candidate. */
  readonly candidate: RevisionSide;
  /** The evidence class. Always `fitting`. */
  readonly evidence_class: "fitting";
  /** Dataset of the fitting split. */
  readonly dataset: string;
  /** Revision of the fitting split. */
  readonly revision: string;
  /** Fitting split identifier. */
  readonly split: string;
  /** The matching of the two policies. */
  readonly matching: RevisionMatching;
  /** Every matched case with one changed component outcome, in fitting order. */
  readonly changed: readonly ChangedCase[];
  /** One row per scope and metric with the counts and the denominators of both sides. */
  readonly metrics: readonly ComparisonMetric[];
  /** The standing development-evidence statement. */
  readonly statement: string;
  /** The standing limits of this comparison. */
  readonly limitations: readonly string[];
}

/**
 * The options of one revision. Every field except the noted optional ones
 * is required, because one revision states its complete procedure: the
 * prior calibration, the revised plan, the dataset, the evaluator
 * registry, the sampling model, and where the host stores the evidence
 * reports.
 */
export interface ReviseOptions {
  /** The stored calibration this revision revises. */
  readonly prior: Calibration;
  /** One explicit path to the JSON revision plan. */
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
   * The declared sampling model of every validation interval, exactly as
   * `calibrate` states it.
   */
  readonly sampling: CalibrationSampling;
  /**
   * The validation splits that earlier qualification claims consumed
   * beyond the prior validation of the stated calibration, as the loaded
   * dataset states them. The revision declares the prior validation split
   * itself. Optional.
   */
  readonly previouslyUsed?: readonly DatasetSplitIdentity[];
  /**
   * The references to the evaluation reports of this revision in the
   * storage of the host. One candidate profile records them in its
   * evidence. State where the returned reports are stored.
   */
  readonly evaluationReports: readonly string[];
  /** Stable identifier of the revised profile. Default: the definition name plus `-revised`. */
  readonly id?: string;
  /** Declared population and scope of the candidate. Default: the intended population of the plan. */
  readonly intendedUse?: string;
  /** Effective execution configuration overrides of the fresh measurements. */
  readonly execution?: Partial<ExecutionConfig>;
  /**
   * The cancellation signal of the caller. One abort refuses the
   * revision: no partial validation runs. Optional.
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

/** The complete result of one policy revision. */
export interface Revision {
  /** The revised profile artifact. One new artifact with its own content hash. */
  readonly profile: Profile;
  /** The fitting report: the search over the reused assessments. */
  readonly fitting: FittingReport;
  /**
   * The frozen validation of the revised candidate. Absent when the
   * search found no feasible candidate, because no frozen candidate
   * exists to validate and the revision spent no validation budget.
   */
  readonly qualification: QualificationReport | undefined;
  /** One run report per freshly measured case, in measurement order. Empty when the revision measured nothing. */
  readonly runs: readonly RunReport[];
  /** The verified reuse of the stored assessments. */
  readonly reuse: RevisionReuse;
  /** The comparison of the prior policy and the revised policy. */
  readonly comparison: RevisionComparison;
  /** Standing statements that keep the limits of these numbers visible. */
  readonly limitations: readonly string[];
}

/** The greatest length of one evaluation-report reference, from the profile contract. */
const REPORT_REFERENCE_LIMIT = 500;

// ---------------------------------------------------------------------------
// The revision workflow.
// ---------------------------------------------------------------------------

/**
 * Runs one policy-only revision of one stored calibration and returns the
 * revised candidate profile.
 *
 * The workflow verifies the prior calibration against the loaded world,
 * replays its stored fitting assessments under the revised plan, freezes
 * the selected candidate, and either replays the stored validation
 * assessments of one consumed split or measures one fresh validation
 * split through the registered evaluator. The returned profile is one new
 * artifact with its own content hash, and the prior artifact stays
 * unchanged. The revision writes no file, stores no report, changes no
 * host selection, and promotes nothing: the host reviews the recorded
 * evidence and selects one reviewed content hash through its own code.
 *
 * @param definition The calibrated definition: the result of `defineChecks`
 * as one trusted import, or one explicit path to a JSON definition file.
 * @param options The prior calibration, the revised plan, the dataset, the
 * evaluator registry, the sampling model, the evaluation-report references,
 * and the optional execution, cancellation, and file-access controls.
 * @returns The revision: the revised profile, the fitting report, the
 * qualification report of the frozen candidate, the runs of the freshly
 * measured cases, the verified reuse, the revision comparison, and the
 * standing limitations.
 * @throws {ValidationError} when one option breaks its shape, when one
 * prior artifact fails its contract, when one identity of the definition,
 * the evaluator, the adapter, the translation, the model, the
 * preprocessing, or the inputs changed, when the plan or the dataset fails
 * its contract, when one measured case ends without one stored assessment,
 * when the measurements resolved two model versions, or when one
 * calculation exceeds the published fitting budget.
 * @throws {Error} when one stated path stays unreadable.
 */
export async function revise(
  definition: Definition | string,
  options: ReviseOptions,
): Promise<Revision> {
  checkOptions(options);
  if (options.signal?.aborted) {
    throw new ValidationError(
      "cancelled_before_start",
      "The revision signal aborted before one case was measured. No revision ran, no candidate exists, and nothing was promoted.",
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

  // The revised plan crosses through the same boundary as one first
  // calibration, and its definition and evaluator checks run before one
  // dataset is read, so one plan that cannot measure the loaded world
  // refuses before any data work.
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
  const fittingSplit = splitOf(dataset.splits, plan.fitting, "fitting");
  const validationSplit = splitOf(dataset.splits, plan.validation, "validation");
  throughCore(() =>
    nativeCheckCalibrationDatasets(
      planText,
      JSON.stringify(splitIdentityValue(fittingSplit)),
      JSON.stringify(splitIdentityValue(validationSplit)),
    ),
  );

  // The reuse boundary: the prior artifacts cross exactly as stored, and
  // the core verifies every identity before one assessment is replayed.
  // The stored assessments cross back as data, so the wrapper hand-builds
  // no replay input.
  const reuseDocument = parseReuseDocument(
    throughCore(() =>
      nativeCheckRevision(
        jsonText(options.prior.profile, "/prior/profile"),
        jsonText(options.prior.fitting, "/prior/fitting"),
        options.prior.runs.map((run) => jsonText(run, "/prior/runs")),
        planText,
        definitionText,
        JSON.stringify(registered),
        JSON.stringify(liveEvaluatorBindings(options.prior.profile, info, artifact, options.evaluators)),
        source.metadataText,
        source.recordsText,
      ),
    ),
  );
  const reuse: RevisionReuse = reuseOf(reuseDocument);
  const fittingAssessmentsText = jsonText(
    reuseDocument.fitting_assessments,
    "/prior/assessments",
  );

  // Phase one: the search over the reused assessments. No evaluator runs,
  // because the fitting split measured already.
  const fitting = parseFittingReport(
    await throughCoreAsync(() =>
      nativeFitPolicy(
        planText,
        source.metadataText,
        source.recordsText,
        definitionText,
        fittingAssessmentsText,
      ),
    ),
  );
  const resolved = fitting.selected ?? objectiveBest(fitting);
  if (resolved === undefined) {
    throw new Error(
      "measuretwice received one fitting report that states no feasible candidate and enumerates none. This is one internal inconsistency.",
    );
  }

  // Phase two: the validation data. The disposition decides what the
  // revision measures, and the revision declares one consumed split.
  const runs: RunReport[] = [];
  const resolvedModels = [...reuse.resolved_models];
  let qualification: QualificationReport | undefined;
  let measurement: Profile = options.prior.profile;
  if (fitting.selected !== null) {
    refuseOnAbort(options.signal, "revision");
    let validationAssessmentsText: string;
    const previouslyUsed: Record<string, unknown>[] = (options.previouslyUsed ?? []).map(
      splitIdentityValue,
    );
    if (reuseDocument.validation_assessments !== null) {
      // The prior calibration measured this split, so its content was
      // consumed: the stored assessments replay under the frozen
      // candidate, the split is declared as previously used, and the
      // validation classifies it as development data that one new claim
      // cannot reuse.
      validationAssessmentsText = jsonText(
        reuseDocument.validation_assessments,
        "/prior/validation_assessments",
      );
      const consumed = splitIdentityValue(validationSplit);
      if (
        !previouslyUsed.some(
          (entry) =>
            entry.dataset === consumed.dataset &&
            entry.revision === consumed.revision &&
            entry.split === consumed.split,
        )
      ) {
        previouslyUsed.push(consumed);
      }
    } else {
      // One fresh validation split: the revision measures it through the
      // registered evaluator on the same validated execution path as one
      // ordinary run, inside the effective execution configuration.
      const questionChecks = info.checkKinds.filter((entry) => entry.kind !== "rule");
      const bindings: Record<string, string | { evaluator: string; model?: string }> = {};
      for (const check of questionChecks) {
        bindings[check.id] =
          plan.modelRequested === undefined || plan.modelRequested === null
            ? plan.evaluator
            : { evaluator: plan.evaluator, model: plan.modelRequested };
      }
      measurement = createExplorationProfile(artifact, options.evaluators, {
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
      validationAssessmentsText = jsonText(
        await measureSplit(
          reviewer,
          dataset,
          validationSplit,
          options.signal,
          runs,
          resolvedModels,
        ),
        "/assessments",
      );
    }
    const request = JSON.stringify({
      sampling: options.sampling,
      ...(previouslyUsed.length === 0 ? {} : { previously_used: previouslyUsed }),
    });
    qualification = parseQualificationReport(
      await throughCoreAsync(() =>
        nativeQualifyCandidate(
          planText,
          source.metadataText,
          source.recordsText,
          definitionText,
          fittingAssessmentsText,
          request,
          validationAssessmentsText,
        ),
      ),
    );
  }

  // The revision comparison: the prior policy and the frozen candidate
  // over the same stored fitting assessments, as concrete changed cases.
  const comparison = parseComparison(
    throughCore(() =>
      nativeCompareRevision(
        jsonText(options.prior.profile, "/prior/profile"),
        planText,
        JSON.stringify(appliedRows(info.checkKinds, resolved.candidate)),
        source.metadataText,
        source.recordsText,
        definitionText,
        fittingAssessmentsText,
      ),
    ),
  );

  // The resolved model spans the stored and the fresh measurements: one
  // alias that resolved two versions refuses the revision.
  const resolvedModel = singleResolution(resolvedModels);
  const naming = {
    id: options.id ?? revisedId(plan, options.prior.profile),
    ...(options.intendedUse === undefined ? {} : { intendedUse: options.intendedUse }),
    evaluationReports: options.evaluationReports,
  };
  const shared = {
    measurement,
    plan,
    dataset: dataset.identity,
    labels: dataset.labels,
    fittingSplit,
    validationSplit,
    candidate: resolved.candidate,
    resolvedModel,
    definition: artifact,
    evaluators: options.evaluators,
    files,
    options: naming,
  };
  const standing: string[] = [fitting.statement, reuse.statement, comparison.statement];
  if (fitting.selected === null) {
    const value: Revision = {
      profile: await candidateProfile({
        ...shared,
        status: "criteria_not_met",
        reasons: ["criteria_not_met"],
        methodStatement: noCandidateMethod(fitting),
        performance: undefined,
      }),
      fitting,
      qualification: undefined,
      runs: Object.freeze([...runs]),
      reuse,
      comparison,
      // The no-candidate list opens with the fitting statement, which the
      // standing list states already, so the slice drops that one row.
      limitations: Object.freeze([
        ...standing,
        ...noCandidateLimitations(fitting, dataset.identity).slice(1),
      ]),
    };
    deepFreeze(value);
    return value;
  }

  const qualificationReport = qualification;
  if (qualificationReport === undefined) {
    throw new Error(
      "measuretwice received one fitting report with one feasible candidate and no validation. This is one internal inconsistency.",
    );
  }
  if (!dataset.identity.states_prevalence) {
    standing.push(
      `The dataset kind ${dataset.identity.kind} states no production prevalence. No rate of this revision estimates production prevalence.`,
    );
  }
  if (!dataset.identity.supports_qualification) {
    standing.push(
      `The population statement ${dataset.identity.population} supports no qualification claim.`,
    );
  }
  standing.push(qualificationReport.evidence.statement);
  standing.push(RETENTION_STATEMENT);
  const value: Revision = {
    profile: await candidateProfile({
      ...shared,
      status: qualificationReport.status,
      reasons: qualificationReport.reasons.map((reason) => reason.code),
      methodStatement: qualificationReport.method_statement,
      performance: performanceOf(qualificationReport),
    }),
    fitting,
    qualification: qualificationReport,
    runs: Object.freeze([...runs]),
    reuse,
    comparison,
    limitations: Object.freeze(standing),
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
function checkOptions(options: ReviseOptions): void {
  if (options.prior === undefined || options.prior === null) {
    throw new ValidationError(
      "missing_field",
      "The revision states no prior calibration. Pass the value that calibrate returned and the host stored.",
      "/prior",
    );
  }
  if (
    typeof options.prior !== "object" ||
    options.prior.profile === undefined ||
    options.prior.fitting === undefined ||
    !Array.isArray(options.prior.runs)
  ) {
    throw new ValidationError(
      "invalid_field_type",
      "The prior calibration must hold the value that calibrate returned: one profile, one fitting report, and one run per measured case. One partial copy states no complete reuse.",
      "/prior",
    );
  }
  if (options.plan === undefined) {
    throw new ValidationError("missing_field", "The revision states no plan.", "/plan");
  }
  if (options.metadata === undefined) {
    throw new ValidationError(
      "missing_field",
      "The revision states no dataset metadata path.",
      "/metadata",
    );
  }
  if (options.records === undefined) {
    throw new ValidationError(
      "missing_field",
      "The revision states no dataset records path.",
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
      "The revision states no evaluator registry. Pass the registry of registerEvaluators, because one loaded plan installs no evaluator.",
      "/evaluators",
    );
  }
  if (options.sampling === undefined) {
    throw new ValidationError(
      "missing_field",
      "The revision states no sampling model. Declare independent_cases or grouped_cases, because every validation interval rests on the stated model.",
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
      "The revision states no evaluation-report references. One candidate profile records where its evidence lives, and the host owns that storage.",
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

/** Names one revised profile after its definition. */
function revisedId(plan: NativePlanInfo, prior: Profile): string {
  const id = `${prior.definition.name}-revised`;
  // The artifact identifier rule bounds the length at 64 characters.
  return id.length <= 64 ? id : `revised-${plan.contentHash.slice(0, 52)}`;
}

/** One applied-policy input row, as the comparison boundary parses it. */
interface AppliedRow {
  readonly check: string;
  readonly accept_cutoff: number;
  readonly rejection_cutoff: number;
  readonly confidence_floor?: number;
}

/** Builds the applied-policy rows of one candidate, one per question check. */
function appliedRows(
  checkKinds: readonly Readonly<{ readonly id: string; readonly kind: string }>[],
  candidate: CalibrationCandidate,
): AppliedRow[] {
  return checkKinds
    .filter((check) => check.kind !== "rule")
    .map((check) => ({
      check: check.id,
      accept_cutoff: candidate.accept_cutoff,
      rejection_cutoff: candidate.rejection_cutoff,
      ...(candidate.confidence_floor === null
        ? {}
        : { confidence_floor: candidate.confidence_floor }),
    }));
}

// ---------------------------------------------------------------------------
// The core results.
// ---------------------------------------------------------------------------

/** The reuse document of the core, with the stored assessments beside the public rows. */
interface NativeReuseDocument extends RevisionReuse {
  readonly fitting_assessments: unknown;
  readonly validation_assessments: unknown | null;
}

/** Parses and freezes one reuse document of the core. */
function parseReuseDocument(text: string): NativeReuseDocument {
  const value: unknown = JSON.parse(text);
  deepFreeze(value);
  return value as NativeReuseDocument;
}

/** Reads the public rows of one reuse document. */
function reuseOf(document: NativeReuseDocument): RevisionReuse {
  return {
    prior_profile_id: document.prior_profile_id,
    prior_profile_content_hash: document.prior_profile_content_hash,
    prior_plan: document.prior_plan,
    prior_dataset: document.prior_dataset,
    prior_splits: [...document.prior_splits],
    definition_name: document.definition_name,
    definition_hash: document.definition_hash,
    bindings: [...document.bindings],
    fitting_split: document.fitting_split,
    validation_split: document.validation_split,
    stored_fitting_cases: document.stored_fitting_cases,
    validation_data: document.validation_data,
    resolved_models: [...document.resolved_models],
    statement: document.statement,
    limitations: [...document.limitations],
  };
}

/** Parses and freezes one revision comparison of the core. */
function parseComparison(text: string): RevisionComparison {
  const value: unknown = JSON.parse(text);
  deepFreeze(value);
  return value as RevisionComparison;
}
