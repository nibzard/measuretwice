// SPDX-License-Identifier: Apache-2.0
/**
 * `exportShadowReviews` and `validateReviewLabels`: the human review loop
 * of one shadow deployment.
 *
 * One shadow run records the new outcome beside the existing decision of
 * the host, and no report field combines the two. The export step selects
 * which of the stored shadow reports one human must review, as MVP_SPEC.md
 * section 10 states: every disagreement, every report without one baseline,
 * every report whose candidate aggregate outcome is an error, and one
 * reproducible sample of the agreements, so baseline passes and silent
 * baseline cases stay auditable and not only suspicious cases reach one
 * reviewer.
 *
 * The host owns the meaning of its own decision vocabulary. It states one
 * meaning for every baseline outcome word through the `baselineMeanings`
 * option: `pass`, `fail`, `review`, or `silent`. One silent baseline reads
 * as one absent decision, not as one wrong decision. The comparison stays
 * outside `run`, so one shadow run measures identically whatever its
 * baseline states; the export reads the stored reports only.
 *
 * The Rust core owns the selection. It classifies every report through one
 * fixed rule order, ranks the agreements by the SHA-256 of the seed, the
 * case identifier, and the input hash, and selects the first ranks up to
 * the stated size. The same reports, meanings, seed, and size always select
 * the same records, so the returned provenance states the seed, the
 * algorithm, the sizes, the inclusion rules, and the stated meanings.
 * `jsonl` holds the selected records as JSON Lines text, one record per
 * line, for the review tool of the host.
 *
 * Every record states the stable case identifier, the input hash, the run
 * identifier, the host snapshot reference when the run stated one, the
 * recorded baseline with its meaning, and the candidate outcomes. The
 * export holds no raw case content: replay needs the explicit
 * host-supplied snapshot reference that `run` recorded, and the library
 * copies no case body into any review record. Baseline agreement stays one
 * observation, so no field of the result states one accuracy or one
 * correctness claim.
 *
 * `validateReviewLabels` closes the loop when the labels return. Each
 * returned line states one `{ case_id, expected, label }` object for one
 * exported case. The validation checks every reference against the meaning
 * of its check, exactly as `loadDataset` checks one dataset record, and
 * counts the provenance that keeps human judgments apart from model
 * proposals. It reads no baseline, because baseline agreement is not
 * correctness: one label that contradicts the baseline outcome of its case
 * is one valid label. The case content stays with the host, so the host
 * joins the validated labels with its own stored inputs when it authors
 * one dataset.
 *
 * Failure behavior: one absent option, one empty meaning map, one bound
 * breach of the seed or the sample size, one batch with no report, one
 * enforcement report, one repeated case identifier, one report of another
 * definition or another profile, and one baseline word with no stated
 * meaning throw one public {@link ValidationError} before any selection.
 * One label return with no line refuses with `insufficient_evidence`, and
 * every broken label line names its line and its field. The wrapper reads
 * no file and writes no review record: storage stays with the host.
 */
import type { Definition } from "./define-checks.js";
import type { ExpectedLabels, LabelFinding, LabelProvenance } from "./dataset.js";
import { ValidationError } from "./error.js";
import { nativeExportShadowReviews, nativeValidateReviewLabels } from "./native.js";
import { deepFreeze, jsonText, throughCore } from "./run.js";
import type {
  AggregateOutcome,
  CheckOutcome,
  CompletionStatus,
  RunReport,
} from "./run.js";

// ---------------------------------------------------------------------------
// Public types of the review export.
// ---------------------------------------------------------------------------

/**
 * What one word of the host decision vocabulary means.
 *
 * `pass`, `fail`, and `review` name the aggregate outcome vocabulary of the
 * run report. `silent` names one absent decision: the existing path
 * proposed nothing.
 */
export type BaselineMeaning = "pass" | "fail" | "review" | "silent";

/** Why one stored shadow report entered the review export. */
export type SelectionReason =
  | "disagreement"
  | "sampled_agreement"
  | "missing_baseline"
  | "candidate_error";

/** The declared meaning of every word of one host decision vocabulary. */
export type BaselineMeanings = Readonly<Record<string, BaselineMeaning>>;

/** The seeded sample of the agreements. */
export interface AgreementSample {
  /** The sampling seed. The same seed selects the same records. */
  readonly seed: string;
  /** How many agreements the sample selects, 0 to 100000. */
  readonly agreements: number;
}

/** The options of one review export. */
export interface ExportShadowReviewsOptions {
  /**
   * The meaning of every word of the host decision vocabulary. One word of
   * one recorded baseline that this map does not cover refuses the export,
   * because one silent drop would hide one reviewable case.
   */
  readonly baselineMeanings: BaselineMeanings;
  /** The seeded sample of the agreements. */
  readonly sample: AgreementSample;
}

/** The recorded baseline of one review record, with its stated meaning. */
export interface RecordedBaseline {
  /** The existing decision of the host, as the run recorded it. */
  readonly outcome: string;
  /** The revision of the existing decision path, as the run recorded it. */
  readonly revision: string;
  /** The meaning the host stated for the decision word. */
  readonly meaning: BaselineMeaning;
}

/** The candidate outcomes of one review record. */
export interface CandidateOutcomes {
  /** The derived aggregate outcome of the run. */
  readonly aggregate: AggregateOutcome;
  /** The terminal execution status of the run. */
  readonly completion: CompletionStatus;
  /** The component outcome of every check, by check identifier. */
  readonly checks: Readonly<Record<string, CheckOutcome>>;
}

/** One exported review record: one shadow case one human must review. */
export interface ShadowReviewRecord {
  /** Stable case identifier, as the run recorded it. */
  readonly case_id: string;
  /** The input-domain content hash of the case input. */
  readonly input_hash: string;
  /** The identifier of the run that measured the case. */
  readonly run_id: string;
  /**
   * The host snapshot reference of the case input, when the run stated one.
   * The record holds no raw case content, so replay needs this reference
   * and the storage of the host.
   */
  readonly snapshot?: string;
  /** The recorded baseline with its stated meaning. Absent when the run
   * stated no baseline. */
  readonly baseline?: RecordedBaseline;
  /** The candidate outcomes of the run. */
  readonly candidate: CandidateOutcomes;
  /** Why this record entered the export. */
  readonly selection_reason: SelectionReason;
}

/** The sampling provenance of one export. */
export interface ReviewSamplingProvenance {
  /** The seed the host stated. */
  readonly seed: string;
  /** The word that names the sampling algorithm. */
  readonly algorithm: string;
  /** The agreements among the reports, selected or not. */
  readonly agreements: number;
  /** The sample size the host stated. */
  readonly requested: number;
  /** The agreements the sample selected. */
  readonly selected: number;
  /** Plain statement of the sample. */
  readonly statement: string;
}

/** The counts of one export. */
export interface ShadowReviewSummary {
  /** The reports the export received. */
  readonly reports: number;
  /** The reports classified as one agreement, selected or not. */
  readonly agreements: number;
  /** The reports classified as one disagreement. */
  readonly disagreements: number;
  /** The reports that state no baseline. */
  readonly missing_baselines: number;
  /** The reports whose candidate aggregate outcome is an error. */
  readonly candidate_errors: number;
  /** The records the export holds. */
  readonly selected: number;
  /** The selected records by selection reason. Every reason key is present. */
  readonly selected_by_reason: Readonly<Record<string, number>>;
  /**
   * The selected records that state one baseline, by its meaning. Every
   * meaning key is present, so baseline passes and silent baseline cases
   * stay countable.
   */
  readonly selected_by_baseline_meaning: Readonly<Record<string, number>>;
}

/** The complete review export of one batch of stored shadow reports. */
export interface ShadowReviewExport {
  /** The portable contract schema version. */
  readonly schema_version: 1;
  /** The definition that produced the checks of every report. */
  readonly definition: Readonly<{ readonly name: string; readonly content_hash: string }>;
  /** The profile that assessed every case. */
  readonly profile: Readonly<{ readonly id: string; readonly content_hash: string }>;
  /** The stated meanings of the host decision vocabulary. */
  readonly baseline_meanings: BaselineMeanings;
  /** The sampling provenance. */
  readonly sampling: ReviewSamplingProvenance;
  /** The inclusion rule sentence of every selection reason. */
  readonly inclusion_rules: Readonly<Record<string, string>>;
  /** Every selected record, in report order. */
  readonly records: readonly ShadowReviewRecord[];
  /**
   * The selected records as JSON Lines text, one record per line, with one
   * trailing newline. The host writes this text to the review tool.
   */
  readonly jsonl: string;
  /** The counts of the export. */
  readonly summary: ShadowReviewSummary;
  /** The standing limits of these records. */
  readonly limitations: readonly string[];
}

// ---------------------------------------------------------------------------
// Public types of the label return.
// ---------------------------------------------------------------------------

/** One returned human label of one exported case. */
export interface ReturnedReviewLabel {
  /** Line of this label inside the returned file, counted from 1. */
  readonly line: number;
  /** The exported case the label answers. */
  readonly case_id: string;
  /** The reference labels the reviewer stated. */
  readonly expected: ExpectedLabels;
  /** The provenance of the reference. */
  readonly label: LabelProvenance;
}

/** The provenance counts of one label return. */
export interface ReviewLabelSummary {
  /** Number of returned lines. */
  readonly lines: number;
  /** Human-written references with one recorded human review. */
  readonly human_reviewed: number;
  /** Human-written references with no recorded review. */
  readonly human_unreviewed: number;
  /** Model-proposed references with one recorded human review. */
  readonly model_reviewed: number;
  /** Model-proposed references that no human reviewed. */
  readonly model_unreviewed: number;
  /** References with one correction, so their history keeps the earlier
   * provenance records. */
  readonly corrected: number;
  /** References that state one review marker or carry one flagged
   * conflict. */
  readonly review_required: number;
}

/** The validation of one label return. */
export interface ReviewLabelValidation {
  /** Every validated label, in return order. */
  readonly labels: readonly ReturnedReviewLabel[];
  /** The provenance counts of the return. */
  readonly summary: ReviewLabelSummary;
  /** Every flagged conflict, in return order. */
  readonly findings: readonly LabelFinding[];
  /** The standing limits of this validation. */
  readonly limitations: readonly string[];
}

/** The options of one label validation. */
export interface ValidateReviewLabelsOptions {
  /**
   * The definition that owns the meaning of every check. Pass the artifact
   * that `defineChecks` returned, or the definition of the bound reviewer.
   */
  readonly definition: Definition;
  /** The review export that the labels answer. */
  readonly exported: ShadowReviewExport;
  /**
   * The complete JSONL return: one `{ case_id, expected, label }` object
   * per nonempty line.
   */
  readonly labels: string;
}

// ---------------------------------------------------------------------------
// The boundary shape of the core.
// ---------------------------------------------------------------------------

/** One review record of the core export, before it freezes. */
interface NativeReviewRecord {
  readonly case_id: string;
  readonly input_hash: string;
  readonly run_id: string;
  readonly snapshot?: string;
  readonly baseline?: RecordedBaseline;
  readonly candidate: CandidateOutcomes;
  readonly selection_reason: SelectionReason;
}

/** The complete export of the core, parsed from its serialized document. */
interface NativeReviewExport {
  readonly schema_version: number;
  readonly definition: { readonly name: string; readonly content_hash: string };
  readonly profile: { readonly id: string; readonly content_hash: string };
  readonly baseline_meanings: Readonly<Record<string, BaselineMeaning>>;
  readonly sampling: ReviewSamplingProvenance;
  readonly inclusion_rules: Readonly<Record<string, string>>;
  readonly records: readonly NativeReviewRecord[];
  readonly summary: ShadowReviewSummary;
  readonly limitations: readonly string[];
}

/** One returned label of the core validation, before it freezes. */
interface NativeReturnedLabel {
  readonly line: number;
  readonly case_id: string;
  readonly expected: ExpectedLabels;
  readonly label: LabelProvenance;
}

/** The label validation of the core, parsed from its serialized document. */
interface NativeLabelValidation {
  readonly labels: readonly NativeReturnedLabel[];
  readonly summary: ReviewLabelSummary;
  readonly findings: readonly {
    readonly line: number;
    readonly case_id: string;
    readonly check_id?: string | null;
    readonly kind: string;
    readonly field_path: string;
    readonly message: string;
  }[];
  readonly limitations: readonly string[];
}

/**
 * Exports the stored shadow reports that need one human review.
 *
 * Every disagreement, every report without one baseline, and every report
 * whose candidate aggregate outcome is an error is always exported. The
 * agreements enter through the seeded sample alone. The records keep report
 * order, and the returned provenance states the seed, the algorithm, the
 * sizes, the inclusion rules, and the stated baseline meanings, so the
 * selection reproduces.
 *
 * @param reports The stored shadow run reports of one shadow deployment.
 * The reports must share one definition and one profile, and every case
 * identifier must appear once.
 * @param options The baseline meanings and the seeded sample.
 * @returns The frozen export: the selected records, their JSON Lines text,
 * the sampling provenance, the inclusion rules, the summary counts, and the
 * standing limits.
 * @throws {ValidationError} when one option is absent or breaks its bound,
 * when one report is no shadow report, when one report binds another
 * definition or another profile, when one case identifier repeats, or when
 * one baseline word names no stated meaning. Every report failure names its
 * position under `/reports/<index>`.
 */
export function exportShadowReviews(
  reports: readonly RunReport[],
  options: ExportShadowReviewsOptions,
): ShadowReviewExport {
  if (options?.baselineMeanings === undefined) {
    throw new ValidationError(
      "missing_field",
      "The export states no baseline meanings. State one meaning for every word of the host decision vocabulary, because the library cannot know what one host decision means.",
      "/baselineMeanings",
    );
  }
  if (options?.sample === undefined || options.sample.seed === undefined) {
    throw new ValidationError(
      "missing_field",
      "The export states no sample. State one seed and one agreement size, because one sample without provenance cannot reproduce.",
      "/sample",
    );
  }
  const exportText = throughCore(() =>
    nativeExportShadowReviews(
      reports.map((report) => jsonText(report, "")),
      jsonText(options.baselineMeanings, "/baselineMeanings"),
      options.sample.seed,
      options.sample.agreements,
    ),
  );
  const parsed = JSON.parse(exportText) as NativeReviewExport;

  const records: ShadowReviewRecord[] = parsed.records.map((record) => {
    const value = {
      case_id: record.case_id,
      input_hash: record.input_hash,
      run_id: record.run_id,
      ...(record.snapshot !== undefined ? { snapshot: record.snapshot } : {}),
      ...(record.baseline !== undefined ? { baseline: record.baseline } : {}),
      candidate: record.candidate,
      selection_reason: record.selection_reason,
    };
    deepFreeze(value);
    return value as ShadowReviewRecord;
  });
  Object.freeze(records);

  // One line per record, in the field order of the public value, so the
  // review tool of the host reads one stable JSON Lines file.
  const jsonl =
    records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

  const value: ShadowReviewExport = {
    schema_version: 1,
    definition: parsed.definition,
    profile: parsed.profile,
    baseline_meanings: parsed.baseline_meanings,
    sampling: parsed.sampling,
    inclusion_rules: parsed.inclusion_rules,
    records,
    jsonl,
    summary: parsed.summary,
    limitations: Object.freeze([...parsed.limitations]),
  };
  deepFreeze(value);
  return value;
}

/**
 * Validates the labels one human returned for one review export.
 *
 * Every reference crosses the meaning of its check, exactly as `loadDataset`
 * checks one dataset record. One reference whose acceptance meaning
 * disagrees with its stated outcome stays as written and appears under
 * `findings`. The validation reads no baseline, because baseline agreement
 * is not correctness: one label that contradicts the baseline outcome of
 * its case is one valid label.
 *
 * @param options The definition, the review export, and the JSONL return.
 * @returns The frozen validation: the validated labels, the provenance
 * counts, the flagged conflicts, and the standing limits.
 * @throws {ValidationError} when the return holds no line, or when one line
 * breaks the label contract, names no exported case, repeats one case, or
 * states one reference that breaks the meaning of its check. Every failure
 * names its line under `/labels/<line>`.
 */
export function validateReviewLabels(
  options: ValidateReviewLabelsOptions,
): ReviewLabelValidation {
  if (options?.definition === undefined) {
    throw new ValidationError(
      "missing_field",
      "The validation states no definition. Pass the artifact that owns the meaning of every check.",
      "/definition",
    );
  }
  if (options?.exported === undefined) {
    throw new ValidationError(
      "missing_field",
      "The validation states no review export. Pass the export that the labels answer, because one label that names no exported case is no label of this review.",
      "/exported",
    );
  }
  if (options?.labels === undefined) {
    throw new ValidationError(
      "missing_field",
      "The validation states no label return. Pass the complete JSON Lines text that the review returned.",
      "/labels",
    );
  }
  const validationText = throughCore(() =>
    nativeValidateReviewLabels(
      jsonText(options.definition, ""),
      JSON.stringify(options.exported.records.map((record) => record.case_id)),
      options.labels,
    ),
  );
  const parsed = JSON.parse(validationText) as NativeLabelValidation;

  const labels: ReturnedReviewLabel[] = parsed.labels.map((label) => {
    const value = {
      line: label.line,
      case_id: label.case_id,
      expected: label.expected,
      label: label.label,
    };
    deepFreeze(value);
    return value as ReturnedReviewLabel;
  });
  Object.freeze(labels);

  const findings = parsed.findings.map((finding) => {
    const value = {
      line: finding.line,
      case_id: finding.case_id,
      check_id: finding.check_id ?? null,
      kind: finding.kind,
      field_path: finding.field_path,
      message: finding.message,
    };
    deepFreeze(value);
    return value as LabelFinding;
  });
  Object.freeze(findings);

  const value: ReviewLabelValidation = {
    labels,
    summary: parsed.summary,
    findings,
    limitations: Object.freeze([...parsed.limitations]),
  };
  deepFreeze(value);
  return value;
}
