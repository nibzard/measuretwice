// SPDX-License-Identifier: Apache-2.0
/**
 * `evaluate`: one bounded evaluation over one labeled dataset.
 *
 * An evaluation runs every record of one dataset through the same validated
 * execution path as an ordinary run, then measures the outcomes against the
 * reference labels of the records, as MVP_SPEC.md section 10 states. The
 * host states the dataset through one metadata path and one JSONL records
 * path, exactly as `loadDataset` accepts them, and declares the purpose of
 * the evaluation: `exploration`, `fitting`, or `independent_validation`.
 * Fitting results are not validation evidence, and the declared purpose
 * states which of the three this evaluation is.
 *
 * Every case runs as one shadow run of the bound reviewer. The evaluation
 * changes no mode gate: it states no selected profile hash, requests no
 * scope, and changes no qualification, because measuring one profile never
 * promotes it. The runs follow each other in record order, one case at one
 * time, so the effective execution configuration of the profile bounds every
 * case and the total work stays bounded by the case count. One aborted
 * `signal` cancels the case in flight and stops the evaluation there; the
 * records that never ran stay counted as unevaluated, never silently
 * missing.
 *
 * The Rust core owns the measurement. It rebuilds every run report through
 * the run report contract, reads each evaluated case out of it, and returns
 * one metric set per check plus the `all_checks` set, one metric row per
 * slice tag, the operational totals, and the resolved reference of every
 * check of every case. The public value holds two parts:
 *
 * - `report`, the evaluation report artifact of
 *   `contracts/v0/evaluation-report.schema.json`. It holds the per-case
 *   outcomes with their reference matches, the metric sets with their
 *   counts and denominators, the per-slice rows, and the operational
 *   failures over all attempts. `JSON.stringify` writes the portable
 *   artifact, and the host that stores it owns its retention.
 * - `runs`, one run report per evaluated case, in evaluation order. The
 *   report artifact holds no raw case content, so the actual evaluator
 *   versions, the per-check timing, the usage, and the sanitized reasons
 *   live here.
 *
 * Missing labels leave only the metrics that need them. The three error
 * rates count labeled cases alone, the review rate, the automatic coverage,
 * and the label coverage count every evaluated case, and one case that
 * errored or was skipped stays in the denominator of every rate whose
 * population holds it. One rate with one zero denominator holds no value.
 * `population` and `limitations` keep the population statement of the
 * dataset and the standing limits of these numbers beside the artifact,
 * because one targeted challenge set states no prevalence and supports no
 * qualification claim.
 *
 * The optional `intervals` option adds the uncertainty half of the
 * measurement. The Rust core computes one Wilson score interval per metric
 * of every scope and every slice under the stated sampling model,
 * confidence level, and minimum sample count, with the case counts and the
 * draws of every row beside its bounds. One row without one denominator,
 * below the stated minimum, or under a sampling assumption the dataset
 * groups break states `insufficient_evidence` or `unsupported_sampling`
 * with its counts instead of one bound. The report artifact cites the
 * method statement in its `method` field, and `intervals` carries the rows,
 * because the frozen schema holds no interval block of its own.
 *
 * Failure behavior: one absent or unknown purpose, one reviewer without one
 * bound profile, one wrong path format, and every dataset contract failure
 * throw one public {@link ValidationError} before any case runs. One
 * evaluation where no case ran, one empty dataset, or one evaluation
 * cancelled before its first case ended refuses with `insufficient_evidence`
 * at `/cases`, because no metric has one denominator and the report contract
 * holds no empty evaluation. One unreadable path throws one ordinary `Error`
 * that names the path.
 */
import type { JSONValue } from "./define-checks.js";
import type {
  DatasetKind,
  DatasetSource,
  PopulationStatement,
} from "./dataset.js";
import { datasetOf, readDatasetTexts } from "./dataset.js";
import { ValidationError } from "./error.js";
import {
  nativeEvaluateDataset,
  nativeParseIntervalRequest,
  nativeUncertaintyIntervals,
} from "./native.js";
import {
  deepFreeze,
  defaultFiles,
  jsonText,
  throughCore,
  type FileAccess,
} from "./run.js";
import type {
  AggregateOutcome,
  CheckOutcome,
  CompletionStatus,
  Reviewer,
  RunReport,
  SanitizedReason,
} from "./run.js";

// ---------------------------------------------------------------------------
// Public types of the evaluation path.
// ---------------------------------------------------------------------------

/** The declared purpose of one evaluation. Fitting results are not
 * validation evidence. */
export type EvaluationPurpose = "exploration" | "fitting" | "independent_validation";

/** The options of one evaluation. */
export interface EvaluateOptions {
  /** One explicit path to the JSON dataset metadata file. */
  readonly metadata: string;
  /** One explicit path to the JSONL record file. */
  readonly records: string;
  /**
   * The declared purpose of this evaluation. The evaluation records it in
   * the report artifact and states the fitting limit when it is `fitting`.
   */
  readonly purpose: EvaluationPurpose;
  /**
   * The uncertainty intervals of the measured metrics. When stated, the
   * core computes one interval per metric of every scope and every slice
   * under the declared sampling model, confidence level, and minimum
   * sample count, the report artifact cites the method statement in its
   * `method` field, and {@link Evaluation.intervals} carries the rows.
   * Optional.
   */
  readonly intervals?: IntervalOptions;
  /**
   * The cancellation signal of the caller. The evaluation cancels the case
   * in flight, keeps its frozen report, and runs no further record. The
   * records that never ran stay counted as unevaluated. Optional.
   */
  readonly signal?: AbortSignal;
  /** The file access that reads the stated paths. The default uses Node APIs. */
  readonly files?: FileAccess;
}

/**
 * One uncertainty interval request: what counts as one draw, the confidence
 * level, and the smallest draw count that carries evidence.
 *
 * The sampling model states an assumption, and the core compares it with
 * the groups of the dataset: `independent_cases` holds only while no group
 * holds two cases of one denominator, and `grouped_cases` makes the group
 * the draw. One unsupported model, one unsupported confidence level, and
 * one broken count refuse with their field paths before any case runs.
 */
export interface IntervalOptions {
  /**
   * The declared sampling model: `independent_cases` or `grouped_cases`.
   */
  readonly sampling: "independent_cases" | "grouped_cases";
  /**
   * The confidence level of every interval. The plan contract supports
   * 0.9, 0.95, and 0.99 alone.
   */
  readonly confidence_level: 0.9 | 0.95 | 0.99;
  /**
   * The minimum number of draws one interval needs. One denominator below
   * it states `insufficient_evidence`, not one wide bound.
   */
  readonly minimum_samples: number;
}

/** One computed uncertainty interval of one metric of one scope. */
export interface EvaluationInterval {
  /** Check identifier, or `all_checks`. */
  readonly scope: string;
  /** Published metric name of `common.schema.json`. */
  readonly metric: string;
  /** Named interval method. Always `wilson_score`. */
  readonly method: string;
  /** The stated confidence level. */
  readonly confidence_level: number;
  /** The declared sampling model. */
  readonly sampling: string;
  /** Cases in the numerator, as the rate of the metric set states them. */
  readonly numerator: number;
  /** Cases in the denominator, as the rate of the metric set states them. */
  readonly denominator: number;
  /**
   * Draws behind the interval: cases under `independent_cases`, groups
   * under `grouped_cases`.
   */
  readonly draws: number;
  /** Draws that hold at least one counted event. */
  readonly event_draws: number;
  /** Lower bound, or `null` when no bound computes. */
  readonly lower: number | null;
  /**
   * Upper bound, or `null` when no bound computes. Qualification compares
   * this bound with the declared limit, not the observed rate alone.
   */
  readonly upper: number | null;
  /**
   * The reason no bound computes, or `null` when the bounds exist:
   * `insufficient_evidence` or `unsupported_sampling`.
   */
  readonly reason: string | null;
}

/** The intervals of one scope. */
export interface EvaluationIntervalSet {
  /** Check identifier, or `all_checks`. */
  readonly scope: string;
  /** One interval per contract metric, in the order of the metric set. */
  readonly intervals: readonly EvaluationInterval[];
}

/** The intervals of one slice tag. */
export interface EvaluationSliceIntervals {
  /** The case tag that groups these intervals. */
  readonly tag: string;
  /** One interval set per scope, in the order of the complete result. */
  readonly scopes: readonly EvaluationIntervalSet[];
}

/** The complete interval result of one evaluation. */
export interface EvaluationIntervals {
  /** Named interval method. Always `wilson_score`. */
  readonly method: string;
  /** The stated confidence level. */
  readonly confidence_level: number;
  /** The declared sampling model. */
  readonly sampling: string;
  /** The standing assumption of the sampling model. */
  readonly assumption: string;
  /** The minimum number of draws one interval needs. */
  readonly minimum_samples: number;
  /**
   * The complete method statement, for the `method` field of one
   * evaluation report and the `statistical_method` field of one profile.
   */
  readonly method_statement: string;
  /** One interval set per check, then the complete check set. */
  readonly scopes: readonly EvaluationIntervalSet[];
  /** One interval set row per slice tag, ordered by tag. */
  readonly slices: readonly EvaluationSliceIntervals[];
}

/** One rate of one metric set, with its numerator and its denominator. */
export interface EvaluationRate {
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
export interface EvaluationCounts {
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
export interface EvaluationMetricSet {
  /** Check identifier, or `all_checks` for the complete check set. */
  readonly scope: string;
  /** Predicted outcome counts over every evaluated case of the scope. */
  readonly counts: EvaluationCounts;
  /** The contract rates, each with its counts and its denominator. */
  readonly rates: readonly EvaluationRate[];
}

/** The metric rows of one slice tag. */
export interface EvaluationSlice {
  /** The case tag that groups these results. */
  readonly tag: string;
  /** One metric set per scope, in the order of the complete result. */
  readonly metrics: readonly EvaluationMetricSet[];
}

/** One evaluated case of the report artifact. */
export interface EvaluatedCase {
  /** Stable case identifier, as the dataset record states it. */
  readonly id: string;
  /** The input-domain content hash of the case input. */
  readonly input_hash: string;
  /** The predicted outcome of every check, by check identifier. */
  readonly outcomes: Readonly<Record<string, CheckOutcome>>;
  /** The derived aggregate outcome of the case. */
  readonly aggregate: AggregateOutcome;
  /** The terminal execution status of the case. */
  readonly completion: CompletionStatus;
  /**
   * The reference match of every check: `true` or `false` where one
   * reference label exists, `null` without one. One error and one skip
   * never match.
   */
  readonly reference_match?: Readonly<Record<string, boolean | null>>;
}

/** The operational totals of one evaluation. */
export interface EvaluationOperational {
  /** The sanitized reasons of every predicted error, over all attempts. */
  readonly errors: readonly SanitizedReason[];
  /** Attempts across all cases and checks, as the runs recorded them. */
  readonly attempts: number;
  /** Sum of the elapsed times of the cases that state one, in milliseconds. */
  readonly elapsed_ms?: number;
  /** Usage amounts summed over the evaluated cases. */
  readonly usage?: Readonly<Record<string, number>>;
}

/**
 * The evaluation report artifact.
 *
 * The value is the portable contract artifact itself: `JSON.stringify`
 * produces the document of `contracts/v0/evaluation-report.schema.json`,
 * with no extra field. The per-case run reports, which hold the actual
 * evaluator versions, the timing, and the usage of each check, stay in
 * {@link Evaluation.runs}, because the artifact holds no raw case content.
 */
export interface EvaluationReport {
  /** The portable contract schema version. */
  readonly schema_version: 1;
  /** The definition that produced the checks. */
  readonly definition: Readonly<{ readonly name: string; readonly content_hash: string }>;
  /** The profile that assessed every case. */
  readonly profile: Readonly<{ readonly id: string; readonly content_hash: string }>;
  /** The identity of the evaluated dataset. */
  readonly dataset: Readonly<{
    readonly id: string;
    readonly revision: string;
    readonly content_hash: string;
  }>;
  /** The declared purpose of this evaluation. */
  readonly purpose: EvaluationPurpose;
  /** One entry per evaluated case, in evaluation order. */
  readonly cases: readonly EvaluatedCase[];
  /** One metric set per check, then the complete check set. */
  readonly metrics: readonly EvaluationMetricSet[];
  /** One metric row per slice tag of the evaluated records. */
  readonly slices?: readonly EvaluationSlice[];
  /** The operational totals of the evaluation. */
  readonly operational?: EvaluationOperational;
  /**
   * The statistical method statement behind every interval that cites this
   * report. Present only when the options stated one interval request.
   */
  readonly method?: string;
}

/** The population facts of the evaluated dataset. */
export interface EvaluationPopulation {
  /** Dataset kind, as the metadata states it. */
  readonly kind: DatasetKind;
  /** What the kind states about the sampled population. */
  readonly statement: PopulationStatement;
  /** True when one qualification claim may rest on data of this kind. */
  readonly supports_qualification: boolean;
  /** True when data of this kind states one production prevalence. */
  readonly states_prevalence: boolean;
  /** Population that the sampling procedure targets. */
  readonly intended_population: string;
  /** How the cases were selected. */
  readonly sampling_method: string;
}

/** The complete result of one evaluation. */
export interface Evaluation {
  /** The evaluation report artifact of the frozen contract. */
  readonly report: EvaluationReport;
  /** One run report per evaluated case, in evaluation order. */
  readonly runs: readonly RunReport[];
  /** Dataset records that this evaluation did not measure. */
  readonly unevaluated_records: number;
  /** The population facts of the evaluated dataset. */
  readonly population: EvaluationPopulation;
  /** Standing statements that keep the limits of these numbers visible. */
  readonly limitations: readonly string[];
  /**
   * The uncertainty intervals of the measured metrics, present only when
   * the options stated one interval request.
   */
  readonly intervals?: EvaluationIntervals;
}

/** The declared purpose words of the evaluation report contract. */
const PURPOSES: readonly EvaluationPurpose[] = [
  "exploration",
  "fitting",
  "independent_validation",
];

// ---------------------------------------------------------------------------
// The measurement of the core.
// ---------------------------------------------------------------------------

/** One metric set of the core measurement, before it freezes. */
interface NativeMetricSet {
  readonly scope: string;
  readonly counts: EvaluationCounts;
  readonly rates: readonly EvaluationRate[];
}

/** The measurement of the core, parsed from its serialized document. */
interface NativeMeasurement {
  readonly metrics: {
    readonly case_count: number;
    readonly unevaluated_records: number;
    readonly scopes: readonly NativeMetricSet[];
    readonly slices: readonly { readonly tag: string; readonly metrics: readonly NativeMetricSet[] }[];
    readonly attempts: number;
    readonly latency_ms: number | null;
    readonly latency_cases: number;
    readonly usage: Readonly<Record<string, number>>;
    readonly independence: string;
  };
  readonly cases: readonly {
    readonly case_id: string;
    readonly reference: Readonly<Record<string, string | null>>;
    readonly matched: Readonly<Record<string, boolean | null>>;
  }[];
}

/** One interval row of the core, before it freezes. */
type NativeInterval = Omit<EvaluationInterval, "lower" | "upper" | "reason"> & {
  readonly lower: number | null;
  readonly upper: number | null;
  readonly reason: string | null;
};

/** The interval report of the core, parsed from its serialized document. */
interface NativeIntervals extends Omit<EvaluationIntervals, "scopes" | "slices"> {
  readonly scopes: readonly { readonly scope: string; readonly intervals: readonly NativeInterval[] }[];
  readonly slices: readonly {
    readonly tag: string;
    readonly scopes: readonly { readonly scope: string; readonly intervals: readonly NativeInterval[] }[];
  }[];
}

/** Freezes one interval row of the core report. */
function intervalOf(row: NativeInterval): EvaluationInterval {
  const value = { ...row };
  deepFreeze(value);
  return value as EvaluationInterval;
}

/** Freezes the interval sets of one population of the core report. */
function intervalSets(
  sets: readonly { readonly scope: string; readonly intervals: readonly NativeInterval[] }[],
): EvaluationIntervalSet[] {
  return sets.map((set) => {
    const value = {
      scope: set.scope,
      intervals: Object.freeze(set.intervals.map(intervalOf)),
    };
    deepFreeze(value);
    return value as EvaluationIntervalSet;
  });
}

/** Freezes one metric set of the core measurement. */
function metricSetOf(set: NativeMetricSet): EvaluationMetricSet {
  const value = {
    scope: set.scope,
    counts: set.counts,
    rates: Object.freeze([...set.rates]),
  };
  deepFreeze(value);
  return value as EvaluationMetricSet;
}

/**
 * Runs one bounded evaluation over one labeled dataset.
 *
 * Every record of the dataset runs through the bound reviewer as one shadow
 * run, in record order. The Rust core then measures the outcomes against
 * the reference labels and resolves the reference of every check.
 *
 * @param reviewer The bound reviewer of `load`. Its profile assesses every
 * case, and the evaluation changes neither its qualification nor any host
 * selection.
 * @param options The dataset paths, the declared purpose, and the optional
 * cancellation signal and file access.
 * @returns The frozen evaluation: the contract report artifact, one run
 * report per evaluated case, the count of unevaluated records, the
 * population facts of the dataset, and the standing limitations.
 * @throws {ValidationError} when the purpose is absent or unknown, when the
 * reviewer holds no bound profile, when one path names one wrong format,
 * when the dataset fails its contract, or when no case ran, which refuses
 * with `insufficient_evidence` because no metric has one denominator.
 * @throws {Error} when one stated path stays unreadable.
 */
export async function evaluate(
  reviewer: Reviewer<Readonly<Record<string, JSONValue>>>,
  options: EvaluateOptions,
): Promise<Evaluation> {
  if (options.purpose === undefined) {
    throw new ValidationError(
      "missing_field",
      "The evaluation states no purpose. Declare exploration, fitting, or independent_validation, because fitting results are not validation evidence.",
      "/purpose",
    );
  }
  if (!PURPOSES.includes(options.purpose)) {
    throw new ValidationError(
      "invalid_field_type",
      `The purpose ${JSON.stringify(options.purpose)} names no declared evaluation purpose. Pass exploration, fitting, or independent_validation.`,
      "/purpose",
    );
  }
  // One question check needs one bound profile, and the report artifact
  // states the profile identity, so the gate fires before any read and
  // before any case runs.
  const profile = reviewer.profile;
  if (profile === undefined) {
    throw new ValidationError(
      "evaluator_mismatch",
      "The evaluation needs one bound profile, because its bindings name the evaluators and its policy states how the answers decide. Pass one profile through the profile option of load and register its evaluators.",
      "/profile",
    );
  }

  const files = options.files ?? defaultFiles;
  const definitionText = jsonText(reviewer.definition, "");
  // One stated interval request is checked before one dataset is read and
  // before one case runs, because one malformed request must spend no
  // evaluator call. The request crosses exactly as the caller stated it, so
  // one field outside the contract refuses here too.
  const requestText = options.intervals === undefined
    ? undefined
    : JSON.stringify(options.intervals);
  if (requestText !== undefined) {
    throughCore(() => nativeParseIntervalRequest(requestText));
  }
  const source: DatasetSource = await readDatasetTexts(
    options.metadata,
    options.records,
    files,
  );
  const dataset = datasetOf(source, definitionText);

  // One case at one time, in record order. An aborted signal cancels the
  // case in flight and stops the loop, so the remaining records stay
  // unevaluated instead of silently missing.
  const runs: RunReport[] = [];
  for (const record of dataset.cases) {
    if (options.signal?.aborted) {
      break;
    }
    runs.push(
      await reviewer.run(
        dataset.runCase(record),
        options.signal === undefined ? {} : { signal: options.signal },
      ),
    );
  }

  // The core rebuilds every report, measures the outcomes, and resolves the
  // references. One evaluation with no case refuses here.
  const measurementText = throughCore(() =>
    nativeEvaluateDataset(
      source.metadataText,
      source.recordsText,
      definitionText,
      runs.map((run) => JSON.stringify(run)),
    ),
  );
  const measurement = JSON.parse(measurementText) as NativeMeasurement;

  const cases: EvaluatedCase[] = measurement.cases.map((measured, index) => {
    const run = runs[index];
    if (run === undefined) {
      throw new Error(
        "measuretwice received one measurement for one case it never ran. This is one internal inconsistency.",
      );
    }
    const outcomes: Record<string, CheckOutcome> = {};
    for (const record of run.checks) {
      outcomes[record.check] = record.outcome;
    }
    const value = {
      id: measured.case_id,
      input_hash: run.case.input_hash,
      outcomes,
      aggregate: run.aggregate.outcome,
      completion: run.completion.status,
      reference_match: measured.matched,
    };
    deepFreeze(value);
    return value as EvaluatedCase;
  });
  Object.freeze(cases);

  // The operational failures over all attempts: one sanitized reason per
  // predicted error, in evaluation order. Skips stay visible in the counts
  // of every metric set and in the run reports.
  const errors: SanitizedReason[] = [];
  for (const run of runs) {
    for (const record of run.checks) {
      if (record.outcome === "error" && record.reason !== undefined) {
        errors.push(record.reason);
      }
    }
  }
  Object.freeze(errors);

  const population: EvaluationPopulation = {
    kind: dataset.identity.kind,
    statement: dataset.identity.population,
    supports_qualification: dataset.identity.supports_qualification,
    states_prevalence: dataset.identity.states_prevalence,
    intended_population: dataset.identity.intended_population,
    sampling_method: dataset.identity.sampling_method,
  };
  deepFreeze(population);

  const limitations: string[] = [measurement.metrics.independence];
  if (!population.states_prevalence) {
    limitations.push(
      `The dataset kind ${population.kind} states no production prevalence. No rate of this evaluation estimates production prevalence.`,
    );
  }
  if (!population.supports_qualification) {
    limitations.push(
      `The population statement ${population.statement} supports no qualification claim.`,
    );
  }
  if (measurement.metrics.unevaluated_records > 0) {
    limitations.push(
      `${measurement.metrics.unevaluated_records} record${measurement.metrics.unevaluated_records === 1 ? "" : "s"} of the dataset hold${measurement.metrics.unevaluated_records === 1 ? "s" : ""} no evaluated outcome. No metric of this report covers ${measurement.metrics.unevaluated_records === 1 ? "it" : "them"}.`,
    );
  }
  if (options.purpose === "fitting") {
    limitations.push(
      "The declared purpose is fitting. Fitting results are not validation evidence.",
    );
  }

  // The intervals read the same measured cases under the stated request.
  // One row that holds no bound states its reason, so one scope without
  // evidence limits itself instead of limiting the evaluation.
  let intervals: EvaluationIntervals | undefined;
  if (options.intervals !== undefined && requestText !== undefined) {
    const reportText = throughCore(() =>
      nativeUncertaintyIntervals(
        source.metadataText,
        source.recordsText,
        definitionText,
        runs.map((run) => JSON.stringify(run)),
        requestText,
      ),
    );
    const native = JSON.parse(reportText) as NativeIntervals;
    const scopes = Object.freeze(intervalSets(native.scopes));
    const slices = native.slices.map((slice) => {
      const value = { tag: slice.tag, scopes: Object.freeze(intervalSets(slice.scopes)) };
      deepFreeze(value);
      return value as EvaluationSliceIntervals;
    });
    Object.freeze(slices);
    const value = {
      method: native.method,
      confidence_level: native.confidence_level,
      sampling: native.sampling,
      assumption: native.assumption,
      minimum_samples: native.minimum_samples,
      method_statement: native.method_statement,
      scopes,
      slices,
    };
    deepFreeze(value);
    intervals = value as EvaluationIntervals;
    limitations.push(intervals.assumption);
  }
  Object.freeze(limitations);

  const metrics = Object.freeze(measurement.metrics.scopes.map(metricSetOf));
  const slices = measurement.metrics.slices.map((slice) => {
    const value = { tag: slice.tag, metrics: Object.freeze(slice.metrics.map(metricSetOf)) };
    deepFreeze(value);
    return value as EvaluationSlice;
  });
  Object.freeze(slices);

  const operational: EvaluationOperational = {
    errors,
    attempts: measurement.metrics.attempts,
    ...(measurement.metrics.latency_ms !== null
      ? { elapsed_ms: measurement.metrics.latency_ms }
      : {}),
    ...(Object.keys(measurement.metrics.usage).length > 0
      ? { usage: measurement.metrics.usage }
      : {}),
  };
  deepFreeze(operational);

  const report: EvaluationReport = {
    schema_version: 1,
    definition: {
      name: reviewer.definition.name,
      content_hash: reviewer.definitionHash,
    },
    profile: { id: profile.id, content_hash: profile.content_hash },
    dataset: {
      id: dataset.identity.dataset_id,
      revision: dataset.identity.revision,
      content_hash: dataset.identity.content_hash,
    },
    purpose: options.purpose,
    cases,
    metrics,
    ...(slices.length > 0 ? { slices } : {}),
    operational,
    ...(intervals !== undefined ? { method: intervals.method_statement } : {}),
  };
  deepFreeze(report);

  const evaluation: Evaluation = {
    report,
    runs: Object.freeze([...runs]),
    unevaluated_records: measurement.metrics.unevaluated_records,
    population,
    limitations,
    ...(intervals !== undefined ? { intervals } : {}),
  };
  deepFreeze(evaluation);
  return evaluation;
}
