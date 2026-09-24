// SPDX-License-Identifier: Apache-2.0
/**
 * `compare`: one comparison of two evaluation reports on their matching
 * cases.
 *
 * MVP_SPEC.md section 10 states the rule: compare profiles on matching
 * case identifiers and input hashes. The Rust core owns the comparison.
 * It rebuilds both stored evaluation report artifacts through the
 * evaluation report contract, so one edited copy fails before any number
 * computes, and it verifies the stored counts against the case outcomes,
 * the rate arithmetic, and the whole-population denominators of every
 * metric set. The core then matches the cases: one case matches only when
 * its identifier and its input hash agree, one changed input hash never
 * matches, and no comparison of two reports that share no case states one
 * tradeoff.
 *
 * The public value holds two parts:
 *
 * - `report`, the comparison artifact of
 *   `contracts/v0/comparison.schema.json`. It states the two report sets
 *   with the stored-report references the host stated, the evidence
 *   class, the matching with its case lists, the changed cases with their
 *   changed checks and both aggregate outcomes, and the tradeoffs.
 *   `JSON.stringify` writes the portable artifact.
 * - `metrics`, one row per scope and metric, where each side keeps its
 *   numerator and its denominator beside its value, because two values
 *   with different denominators cover different case sets.
 *
 * The evidence class follows the declared purposes of the two reports:
 * both must state `independent_validation` for one comparison that counts
 * as independent validation evidence. One fitting evaluation makes the
 * whole comparison one fitting comparison that guides development and
 * supports no validation claim.
 *
 * The cost tradeoff computes only when the recorded usage of that side and
 * the declared cost inputs support it: one usage key with no declared cost
 * leaves the cost of that side absent and one limitation names the fact.
 * Usage and latency appear only when a report recorded them.
 *
 * The comparison changes no qualification and selects no profile. It
 * reads two stored reports and holds no raw case content: the case
 * identifiers, the input hashes, and the host references alone cross.
 * Input hashes detect changed inputs alone, so one change of evaluator
 * behavior needs new measurements that no comparison can replace.
 *
 * Failure behavior: one absent option, one absent stored-report
 * reference, and one absent report throw one public
 * {@link ValidationError} before any parse. One report that breaks the
 * evaluation report contract throws with its field path under `/baseline`
 * or `/candidate`, two reports that bind different definitions throw with
 * `definition_mismatch`, two reports that share no case refuse with
 * `insufficient_evidence` at `/matching`, and one broken cost input
 * throws with its key under `/costs`.
 */
import type { EvaluationReport } from "./evaluate.js";
import { ValidationError } from "./error.js";
import { nativeCompareEvaluations } from "./native.js";
import { deepFreeze, jsonText, throughCore } from "./run.js";
import type { AggregateOutcome, CheckOutcome } from "./run.js";

// ---------------------------------------------------------------------------
// Public types of the comparison.
// ---------------------------------------------------------------------------

/**
 * The evidence class of one comparison. Fitting comparisons guide
 * development. They are not independent validation evidence.
 */
export type ComparisonEvidenceClass = "fitting" | "independent_validation";

/** One side of the comparison: the stored report and the profile it used. */
export interface ReportSetReference {
  /** The profile that assessed every case of the report. */
  readonly profile: Readonly<{ readonly id: string; readonly content_hash: string }>;
  /** Reference to the stored report in host-managed storage. */
  readonly report: string;
}

/** The matching of the two report sets. */
export interface ComparisonMatching {
  /** Cases with one equal identifier and one equal input hash in both
   * reports. */
  readonly matched_cases: number;
  /** Cases whose input hash differs between the reports, ordered by
   * identifier. Their outcomes never match. */
  readonly changed_input_cases: readonly string[];
  /** Cases of the baseline report that the candidate report omits. */
  readonly missing_in_candidate: readonly string[];
  /** Cases of the candidate report that the baseline report omits. */
  readonly missing_in_baseline: readonly string[];
  /** Matched cases that hold one error component outcome on either side. */
  readonly errored_cases?: readonly string[];
  /** Matched cases that hold one skipped component outcome on either
   * side. */
  readonly skipped_cases?: readonly string[];
}

/** One check whose outcome changed between the two reports. */
export interface ChangedCheckPair {
  /** The check whose outcome changed. */
  readonly check: string;
  /** The outcome of the baseline report. */
  readonly baseline: CheckOutcome;
  /** The outcome of the candidate report. */
  readonly candidate: CheckOutcome;
}

/** One matched case with at least one changed component outcome. */
export interface ChangedCase {
  /** Stable case identifier. */
  readonly id: string;
  /** Every check whose outcome changed, in the check order of the
   * baseline report. */
  readonly checks: readonly ChangedCheckPair[];
  /** The aggregate outcome of the baseline report. */
  readonly baseline_aggregate: AggregateOutcome;
  /** The aggregate outcome of the candidate report. */
  readonly candidate_aggregate: AggregateOutcome;
}

/** One metric tradeoff row of the artifact: the two stored values. */
export interface MetricTradeoffRow {
  /** Check identifier, or `all_checks`. */
  readonly scope: string;
  /** The metric of the row. */
  readonly metric: string;
  /** The stored value of the baseline report, or `null` at one zero
   * denominator. */
  readonly baseline_value: number | null;
  /** The stored value of the candidate report, or `null` at one zero
   * denominator. */
  readonly candidate_value: number | null;
}

/** The tradeoffs of the comparison. */
export interface ComparisonTradeoffs {
  /** One row per scope and metric, in the check order of the baseline
   * report. */
  readonly metrics: readonly MetricTradeoffRow[];
  /** The latency of both reports, in milliseconds, when at least one
   * recorded one. One side stays absent when its report recorded none. */
  readonly elapsed_ms?: Readonly<{
    readonly baseline?: number;
    readonly candidate?: number;
  }>;
  /** The usage of both reports, when at least one recorded one. One side
   * stays absent when its report recorded none. */
  readonly usage?: Readonly<{
    readonly baseline?: Readonly<Record<string, number>>;
    readonly candidate?: Readonly<Record<string, number>>;
  }>;
  /** The computed cost of each side, when the recorded usage and the
   * declared cost inputs support it. */
  readonly cost?: Readonly<Record<string, number>>;
}

/** The comparison artifact of the frozen contract. */
export interface ComparisonArtifact {
  /** The portable contract schema version. */
  readonly schema_version: 1;
  /** The baseline report set. */
  readonly baseline: ReportSetReference;
  /** The candidate report set. */
  readonly candidate: ReportSetReference;
  /** The evidence class derived from the declared purposes. */
  readonly evidence_class: ComparisonEvidenceClass;
  /** The matching of the two report sets. */
  readonly matching: ComparisonMatching;
  /** Every matched case with one changed component outcome, in baseline
   * order. */
  readonly changed: readonly ChangedCase[];
  /** The tradeoffs over the stored metric sets and operational totals. */
  readonly tradeoffs: ComparisonTradeoffs;
}

/** One stored rate of one metric row, with its counts and denominator. */
export interface ComparisonRate {
  /** The metric of the rate. */
  readonly metric: string;
  /** Cases in the numerator. */
  readonly numerator: number;
  /** Denominator of the rate. */
  readonly denominator: number;
  /** Numerator over denominator, or `null` when the denominator is zero. */
  readonly value: number | null;
}

/** One metric row: the stored rate of both sides. */
export interface ComparisonMetric {
  /** Check identifier, or `all_checks`. */
  readonly scope: string;
  /** The metric of the row. */
  readonly metric: string;
  /** The stored rate of the baseline report. */
  readonly baseline: ComparisonRate;
  /** The stored rate of the candidate report. */
  readonly candidate: ComparisonRate;
}

/** The options of one comparison. */
export interface CompareOptions {
  /**
   * Where the host stored the baseline report. The artifact states this
   * reference beside the profile of the baseline.
   */
  readonly baselineReport: string;
  /**
   * Where the host stored the candidate report. The artifact states this
   * reference beside the profile of the candidate.
   */
  readonly candidateReport: string;
  /**
   * One unit cost per usage key, for example `input_tokens`. One cost of
   * one side appears only when that report recorded usage and every
   * recorded key carries one declared cost. Optional.
   */
  readonly costs?: Readonly<Record<string, number>>;
}

/** The complete comparison of two stored evaluation reports. */
export interface Comparison {
  /** The comparison artifact of the frozen contract. */
  readonly report: ComparisonArtifact;
  /** One row per scope and metric, with the counts and the denominators
   * of both sides. */
  readonly metrics: readonly ComparisonMetric[];
  /** The standing limits of this comparison. */
  readonly limitations: readonly string[];
}

// ---------------------------------------------------------------------------
// The comparison of the core.
// ---------------------------------------------------------------------------

/** The complete comparison of the core, parsed from its document. */
interface NativeComparison {
  readonly schema_version: number;
  readonly baseline: ReportSetReference;
  readonly candidate: ReportSetReference;
  readonly evidence_class: ComparisonEvidenceClass;
  readonly matching: ComparisonMatching;
  readonly changed: readonly ChangedCase[];
  readonly tradeoffs: ComparisonTradeoffs;
  readonly metrics: readonly ComparisonMetric[];
  readonly limitations: readonly string[];
}

/**
 * Compares two evaluation reports on their matching cases.
 *
 * The Rust core rebuilds both report artifacts through the evaluation
 * report contract, matches the cases on equal identifiers and equal input
 * hashes, lists the changed, the missing, the errored, and the skipped
 * cases, and reads the metric tradeoffs with their counts and their
 * denominators. One fitting declared purpose makes the whole comparison
 * one fitting comparison.
 *
 * @param baseline The stored evaluation report artifact of the baseline.
 * @param candidate The stored evaluation report artifact of the candidate.
 * @param options The stored-report references and the optional declared
 * costs.
 * @returns The frozen comparison: the contract artifact, the metric rows
 * with the counts and the denominators of both sides, and the standing
 * limits.
 * @throws {ValidationError} when one option is absent, when one report is
 * absent, when one report breaks its contract, when the two reports bind
 * different definitions or share no case, or when one declared cost breaks
 * its bound.
 */
export function compare(
  baseline: EvaluationReport,
  candidate: EvaluationReport,
  options: CompareOptions,
): Comparison {
  if (options?.baselineReport === undefined) {
    throw new ValidationError(
      "missing_field",
      "The comparison states no baseline report reference. Name where the host stored the baseline report, because the artifact states the storage it came from.",
      "/baselineReport",
    );
  }
  if (options?.candidateReport === undefined) {
    throw new ValidationError(
      "missing_field",
      "The comparison states no candidate report reference. Name where the host stored the candidate report, because the artifact states the storage it came from.",
      "/candidateReport",
    );
  }
  if (baseline === undefined) {
    throw new ValidationError(
      "missing_field",
      "The comparison states no baseline report. Pass the evaluation report artifact that evaluate returned and the host stored.",
      "/baseline",
    );
  }
  if (candidate === undefined) {
    throw new ValidationError(
      "missing_field",
      "The comparison states no candidate report. Pass the evaluation report artifact that evaluate returned and the host stored.",
      "/candidate",
    );
  }
  const comparisonText = throughCore(() =>
    nativeCompareEvaluations(
      jsonText(baseline, "/baseline"),
      jsonText(candidate, "/candidate"),
      options.baselineReport,
      options.candidateReport,
      options.costs === undefined ? null : jsonText(options.costs, "/costs"),
    ),
  );
  const parsed = JSON.parse(comparisonText) as NativeComparison;

  const report: ComparisonArtifact = {
    schema_version: 1,
    baseline: parsed.baseline,
    candidate: parsed.candidate,
    evidence_class: parsed.evidence_class,
    matching: parsed.matching,
    changed: Object.freeze([...parsed.changed]),
    tradeoffs: parsed.tradeoffs,
  };
  deepFreeze(report);

  const value: Comparison = {
    report,
    metrics: Object.freeze([...parsed.metrics]),
    limitations: Object.freeze([...parsed.limitations]),
  };
  deepFreeze(value);
  return value;
}
