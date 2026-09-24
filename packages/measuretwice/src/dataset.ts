// SPDX-License-Identifier: Apache-2.0
/**
 * `loadDataset`, the versioned JSONL case records it returns, and the
 * grouped splits that keep fitting data apart from validation data.
 *
 * A dataset is one JSONL record file plus one metadata file, as the
 * contracts README states. `loadDataset` reads both through explicit
 * paths: the metadata path names one `.json` file, the records path names
 * one `.jsonl` file. It loads no YAML and executes no TypeScript source,
 * as the reason code `unsupported_format` states.
 *
 * The Rust core is the one validation authority. It parses every record
 * line through the strict JSON gate, checks the case-record contract and
 * the metadata contract, rejects one repeated case identifier, and checks
 * every input object against the input schema of the stated definition.
 * It also checks every reference label against the meaning of its check:
 * one reference that names no declared check, one answer or level outside
 * the declared labels, and one reference answer on a rule check each fail
 * with their line and field. One reference whose acceptance meaning
 * disagrees with its stated expected outcome loads, stays as written, and
 * appears under `labels.findings`, because one human must decide it. The
 * `labels.summary` counts keep human judgments apart from model proposals.
 * One failure throws one public {@link ValidationError} whose field path
 * names the line and the field, `/records/<line>/<field>`.
 *
 * The same load computes the grouped splits. One group appears in one
 * split only, so related conversations stay inside one split, and one
 * group that two splits declare fails the metadata contract. `identity`
 * records the revision, the kind, the population statement, the sampling
 * provenance, the record count, the dataset content hash, and the group
 * assignments; `splits` records each split with its record count, its
 * content hash, and its case identifiers. One stored dataset or split hash
 * that differs from the computed digest fails with `hash_mismatch`, so one
 * changed input cannot hide inside one revision. `detectSplitOverlap`
 * finds shared groups and duplicated cases between one fitting selection
 * and one validation selection, `requireSeparatedSplits` refuses one
 * overlap, and `classifyValidationEvidence` marks one reused holdout as
 * development data that supports no new qualification claim.
 *
 * Reference labels, expected outcomes, and label provenance stay outside
 * the input object. `runCase` copies one identifier and one input object
 * alone, so no label field can reach the `run` boundary, which validates
 * the case again before any evaluator runs.
 *
 * The loader writes no file and retains only the returned dataset. The
 * published limits: one record line holds at most 8,388,608 bytes, the
 * record file holds at most 536,870,912 bytes, and one dataset holds at
 * most 100,000 records. Nothing is truncated. Report retention stays with
 * the host.
 */
import type { Definition, JSONValue } from "./define-checks.js";
import { ValidationError } from "./error.js";
import {
  nativeRequireSeparatedSplits,
  nativeSplitOverlap,
  nativeValidateDataset,
  nativeValidationEvidence,
  type DatasetInfo,
  type NativeSplitIdentity,
} from "./native.js";
import {
  deepFreeze,
  defaultFiles,
  jsonText,
  readText,
  requireJsonPath,
  throughCore,
  type FileAccess,
} from "./run.js";
import type { RunCase } from "./run.js";

/** The kind of one dataset, as the metadata contract states. */
export type DatasetKind =
  | "development_fixture"
  | "synthetic_challenge"
  | "representative_sample";

/** The purpose of one split: candidate tuning or independent evidence. */
export type SplitPurpose = "fitting" | "validation";

/**
 * What the kind of one dataset states about the population it samples.
 *
 * A targeted challenge set and a development fixture state no prevalence
 * and support no qualification claim. Only a representative sample does.
 */
export type PopulationStatement =
  | "development_fixture"
  | "targeted_challenge_set"
  | "representative_sample";

/** Who produced one reference label. A coding agent counts as a model. */
export type LabelAuthorType = "human" | "model";

/** How one reference came to exist: written for the dataset, or collected. */
export type LabelOrigin = "synthetic" | "collected";

/** One expected overall outcome of one case: pass, fail, or review. */
export type ExpectedOutcome = "pass" | "fail" | "review";

/** One declared split of one dataset. */
export interface DatasetSplit {
  /** Stable split identifier. */
  readonly id: string;
  /** Fitting or validation. */
  readonly purpose: SplitPurpose;
  /** Groups assigned to this split. One group appears in one split only. */
  readonly groups: readonly string[];
}

/** One group of related cases and the split that holds it. */
export interface GroupAssignment {
  /** Group of related cases, as the records state it. */
  readonly group: string;
  /** Split that the metadata assigns to this group. */
  readonly split_id: string;
  /** Records of this group. */
  readonly record_count: number;
}

/** One group of records that no declared split covers. */
export interface UnassignedGroup {
  /** Group of related cases that no split declares. */
  readonly group: string;
  /** Records of this group. */
  readonly record_count: number;
  /** Line of the first record of this group, counted from 1. */
  readonly first_line: number;
}

/** The identity of one dataset: what a plan, a profile, or a report binds to. */
export interface DatasetIdentity {
  /** Stable dataset identifier. */
  readonly dataset_id: string;
  /** Dataset revision. Changed content needs one new revision. */
  readonly revision: string;
  /** Dataset kind, as the metadata states it. */
  readonly kind: DatasetKind;
  /** What the kind states about the sampled population. */
  readonly population: PopulationStatement;
  /** True when one qualification claim may rest on data of this kind. */
  readonly supports_qualification: boolean;
  /** True when data of this kind states one production prevalence. */
  readonly states_prevalence: boolean;
  /** Population that the sampling procedure targets. */
  readonly intended_population: string;
  /** How the cases were selected. */
  readonly sampling_method: string;
  /** Number of case records. */
  readonly record_count: number;
  /** Computed hash of the canonical case records. */
  readonly content_hash: string;
  /** Group assignments, ordered by group. */
  readonly group_assignments: readonly GroupAssignment[];
  /** Groups of records that no declared split covers, ordered by group. */
  readonly unassigned_groups: readonly UnassignedGroup[];
}

/**
 * The identity of one split of one dataset.
 *
 * The field names follow one dataset selection of a calibration plan, so
 * the value a loaded dataset returns states the reference that a plan
 * states. Pass it to `detectSplitOverlap`, `requireSeparatedSplits`, and
 * `classifyValidationEvidence`.
 */
export interface DatasetSplitIdentity {
  /** Stable dataset identifier. */
  readonly dataset: string;
  /** Dataset revision of this split. */
  readonly revision: string;
  /** Stable split identifier. */
  readonly split: string;
  /** Fitting or validation. */
  readonly purpose: SplitPurpose;
  /** Groups assigned to this split, in the declared order. */
  readonly groups: readonly string[];
  /** Records of this split. */
  readonly record_count: number;
  /** Computed hash of the canonical records of this split. */
  readonly content_hash: string;
  /** Case identifiers of this split, ordered by identifier. */
  readonly case_ids: readonly string[];
}

/** The overlap between one fitting selection and one validation selection. */
export interface SplitOverlap {
  /** True when both selections name one dataset revision. */
  readonly same_dataset: boolean;
  /** Groups that both splits declare, ordered by group. */
  readonly shared_groups: readonly string[];
  /** Case identifiers that both splits hold, ordered by identifier. */
  readonly shared_cases: readonly string[];
  /** True when the two selections share no group and no case. */
  readonly separated: boolean;
}

/** The class of evidence that one validation split supports. */
export type EvidenceClass = "independent_validation" | "development";

/** The evidence classification of one validation split. */
export interface ValidationEvidence {
  /** The class this split supports. */
  readonly class: EvidenceClass;
  /** True when the dataset kind states one representative sample. */
  readonly representative_sample: boolean;
  /** Records of the split. */
  readonly record_count: number;
  /** References of the earlier uses that hold the same validation content. */
  readonly reused_from: readonly string[];
  /** True when one new qualification claim needs fresh validation evidence. */
  readonly needs_fresh_evidence: boolean;
  /** Plain statement of the classification, linked to the facts above. */
  readonly statement: string;
}

/** The metadata of one dataset. */
export interface DatasetMetadata {
  /** The portable contract schema version. */
  readonly schema_version: 1;
  /** Stable dataset identifier. */
  readonly id: string;
  /** Readable dataset name. */
  readonly name?: string;
  /** Dataset revision. Changed content needs one new revision. */
  readonly revision: string;
  /** Dataset kind. A synthetic challenge set states no prevalence. */
  readonly kind: DatasetKind;
  /** Population that the sampling procedure targets. */
  readonly intended_population: string;
  /** How the cases were selected. */
  readonly sampling_method: string;
  /** Written label guidelines, or one explicit reference to them. */
  readonly label_guidelines: string;
  /** Language tags that occur in the cases. */
  readonly languages?: readonly string[];
  /** Declared record count. Must match the record file. */
  readonly record_count?: number;
  /** Stored hash of the canonical case-record content. */
  readonly content_hash?: string;
  /** Declared grouped splits. */
  readonly splits: readonly DatasetSplit[];
}

/** The provenance of one reference label. */
export interface LabelProvenance {
  /** Who produced the reference. */
  readonly author_type: LabelAuthorType;
  /** Whether a human reviewed the reference after it was proposed. */
  readonly reviewed: boolean;
  /** How the reference came to exist. */
  readonly origin?: LabelOrigin;
  /** Reviewer attribution. Present when `reviewed` is true. */
  readonly reviewer?: string;
  /** Short statement of why the reference applies. */
  readonly reason?: string;
  /** Earlier label records, kept across one correction. */
  readonly history?: readonly LabelProvenance[];
}

/** One expected reference of one check. */
export interface ExpectedCheckLabel {
  /** Reference answer label, for a question with named answers. */
  readonly answer?: string;
  /** Reference scale level, for an ordered question. */
  readonly level?: string;
  /** The reference is ambiguous and needs one human review. */
  readonly review?: true;
  /** Expected policy outcome of this check, where labeled. */
  readonly outcome?: ExpectedOutcome;
}

/** The reference labels of one case record. */
export interface ExpectedLabels {
  /** Reference answers and expected outcomes, by check identifier. */
  readonly checks: Readonly<Record<string, ExpectedCheckLabel>>;
  /** Expected overall outcome, where labeled. */
  readonly outcome?: ExpectedOutcome;
}

/** The kind of one flagged label conflict. */
export type LabelFindingKind =
  | "check_outcome_conflict"
  | "overall_outcome_conflict";

/** One flagged label conflict that one human must review. */
export interface LabelFinding {
  /** Line of the record inside the record file, counted from 1. */
  readonly line: number;
  /** Stable case identifier of the record. */
  readonly case_id: string;
  /** Check identifier, when the conflict belongs to one check. */
  readonly check_id?: string | null;
  /** Kind of the conflict. */
  readonly kind: LabelFindingKind;
  /** Field path of the conflicting reference, prefixed with the record line. */
  readonly field_path: string;
  /** Short statement of the conflict. */
  readonly message: string;
}

/**
 * The provenance summary of the reference labels of one dataset.
 *
 * Every count except `records` and `unlabeled` covers the records that state
 * one expected-label object. Only the reviewed counts are reviewed evidence:
 * one model proposal that no human reviewed stays inside `model_unreviewed`,
 * whatever the dataset metadata states.
 */
export interface LabelSummary {
  /** Number of case records of the dataset. */
  readonly records: number;
  /** Number of records that state one expected-label object. */
  readonly labeled: number;
  /** Number of records without reference labels. */
  readonly unlabeled: number;
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
  /** References that state one review marker or carry one flagged conflict. */
  readonly review_required: number;
}

/** The label review of one dataset: its summary and every flagged conflict. */
export interface LabelReview {
  /** Provenance summary of every reference label. */
  readonly summary: LabelSummary;
  /** Every flagged conflict, in record order. */
  readonly findings: readonly LabelFinding[];
}

/** One case record of one loaded dataset. */
export interface DatasetCase {
  /** Line of this record inside the record file, counted from 1. */
  readonly line: number;
  /** Stable case identifier, unique inside the dataset. */
  readonly id: string;
  /** Group of related cases. One record without a group forms its own group. */
  readonly group: string;
  /** Slice and failure-type tags. */
  readonly tags: readonly string[];
  /** The complete input object, as supplied. */
  readonly input: Readonly<Record<string, JSONValue>>;
  /** The input-domain content hash of the complete input object. */
  readonly input_hash: string;
  /** Reference labels and expected outcomes, when one is present. */
  readonly expected?: ExpectedLabels;
  /** Provenance of the reference label. */
  readonly label: LabelProvenance;
}

/** One loaded dataset: the validated metadata and every case record. */
export interface Dataset {
  /** The metadata artifact, as the core validated it. */
  readonly metadata: DatasetMetadata;
  /**
   * The identity of the dataset: revision, kind, population statement,
   * sampling provenance, record count, content hash, and group
   * assignments.
   */
  readonly identity: DatasetIdentity;
  /** Every declared split with its identity, in the declared order. */
  readonly splits: readonly DatasetSplitIdentity[];
  /** Every case record, in file order. */
  readonly cases: readonly DatasetCase[];
  /** The definition that validated every input object. */
  readonly definition: Readonly<{ readonly name: string; readonly content_hash: string }>;
  /**
   * The label review of the dataset. Every reference label that loads passed
   * the meaning of its check; `findings` names the references whose stated
   * outcome disagrees with the acceptance meaning of their check, and
   * `summary` counts the provenance that keeps human judgments apart from
   * model proposals.
   */
  readonly labels: LabelReview;
  /**
   * Returns the run case of one dataset record: one identifier and one
   * input object alone. Reference labels, tags, and provenance stay
   * outside, so they cannot reach an evaluator request.
   */
  runCase(record: DatasetCase): RunCase<Readonly<Record<string, JSONValue>>>;
}

/** The options of `loadDataset`. */
export interface LoadDatasetOptions {
  /**
   * The definition that validates every input object. Pass the result of
   * `defineChecks` as one trusted import, or one explicit path to a JSON
   * definition file.
   */
  readonly definition: Definition | string;
  /** One explicit path to the JSON dataset metadata file. */
  readonly metadata: string;
  /** One explicit path to the JSONL record file. */
  readonly records: string;
  /** The file access that reads the stated paths. The default uses Node APIs. */
  readonly files?: FileAccess;
}

/** Rejects one path that names no JSONL record file. */
function requireJsonlPath(filePath: string, fieldPath: string): void {
  if (!filePath.endsWith(".jsonl")) {
    throw new ValidationError(
      "unsupported_format",
      `The path ${JSON.stringify(filePath)} names no JSONL record file. The dataset loader accepts one explicit .jsonl records path and one explicit .json metadata path. It loads no YAML and executes no TypeScript source.`,
      fieldPath,
    );
  }
}

/**
 * Loads one versioned JSONL case dataset with its metadata.
 *
 * The Rust core validates the complete dataset before any value returns:
 * the metadata contract, every record line, the unique case identifiers,
 * the declared record count, every input object against the input
 * schema of the definition, and every reference label against the meaning
 * of its check.
 *
 * @param options The definition, the metadata path, the records path, and
 * the optional file access.
 * @returns The frozen dataset: metadata, every case record with its
 * reference labels and label provenance, the `labels` review that flags
 * every conflicting reference and counts the label provenance, and the
 * `runCase` operation that strips every label field.
 * @throws {ValidationError} when one path names one wrong format, when the
 * metadata or one record fails its contract, when one input object
 * fails the definition input schema, or when one reference label breaks
 * the meaning of its check. Every record failure names its line
 * and its field.
 * @throws {Error} when one stated path stays unreadable.
 */
export async function loadDataset(options: LoadDatasetOptions): Promise<Dataset> {
  const files = options.files ?? defaultFiles;
  const definitionText = await definitionTextOf(options.definition, files);
  const source = await readDatasetTexts(options.metadata, options.records, files);
  return datasetOf(source, definitionText);
}

/** The read source of one dataset: its metadata text and its records text. */
export interface DatasetSource {
  /** The complete metadata file text, as read. */
  readonly metadataText: string;
  /** The complete record file text, as read. */
  readonly recordsText: string;
}

/** Reads the definition text of one dataset load: one path or one artifact. */
async function definitionTextOf(
  definition: Definition | string,
  files: FileAccess,
): Promise<string> {
  if (typeof definition === "string") {
    requireJsonPath(definition, "/definition");
    return readText(files, definition);
  }
  return jsonText(definition, "");
}

/**
 * Reads one dataset source through one file access.
 *
 * The paths keep the rules of `loadDataset`: one `.json` metadata path and
 * one `.jsonl` records path, checked before one read. The evaluation path
 * of `evaluate.ts` reads once and validates through the same boundary.
 */
export async function readDatasetTexts(
  metadata: string,
  records: string,
  files: FileAccess,
): Promise<DatasetSource> {
  requireJsonPath(metadata, "/metadata");
  const metadataText = await readText(files, metadata);
  requireJsonlPath(records, "/records");
  const recordsText = await readText(files, records);
  return { metadataText, recordsText };
}

/**
 * Validates one dataset source against one definition text and builds the
 * public dataset.
 *
 * The Rust core stays the one validation authority, so the value that
 * `loadDataset` returns and the value one evaluation runs come from the
 * same boundary.
 */
export function datasetOf(source: DatasetSource, definitionText: string): Dataset {
  const info = throughCore(() =>
    nativeValidateDataset(source.metadataText, source.recordsText, definitionText),
  );

  const metadata: unknown = JSON.parse(source.metadataText);
  deepFreeze(metadata);
  const cases = info.records.map((record) => {
    const value = {
      line: record.line,
      id: record.id,
      group: record.group,
      tags: Object.freeze([...record.tags]),
      input: record.input,
      input_hash: record.inputHash,
      expected: record.expected,
      label: record.label,
    };
    deepFreeze(value);
    return value as DatasetCase;
  });
  Object.freeze(cases);

  // The label review arrives as data from the core, so the counts and the
  // flagged conflicts state what the core measured, never a wrapper guess.
  const summary = {
    records: info.labels.records,
    labeled: info.labels.labeled,
    unlabeled: info.labels.unlabeled,
    human_reviewed: info.labels.humanReviewed,
    human_unreviewed: info.labels.humanUnreviewed,
    model_reviewed: info.labels.modelReviewed,
    model_unreviewed: info.labels.modelUnreviewed,
    corrected: info.labels.corrected,
    review_required: info.labels.reviewRequired,
  };
  deepFreeze(summary);
  const findings = info.labels.findings.map((finding) => {
    const value = {
      line: finding.line,
      case_id: finding.caseId,
      check_id: finding.checkId ?? null,
      kind: finding.kind,
      field_path: finding.fieldPath,
      message: finding.message,
    };
    deepFreeze(value);
    return value as LabelFinding;
  });
  Object.freeze(findings);
  const labels: LabelReview = {
    summary: summary as LabelSummary,
    findings,
  };
  deepFreeze(labels);

  const dataset: Dataset = {
    metadata: metadata as DatasetMetadata,
    identity: identityOf(info),
    splits: info.metadata.splits.map((split) => {
      const value = {
        dataset: info.identity.datasetId,
        revision: info.identity.revision,
        split: split.id,
        purpose: split.purpose as SplitPurpose,
        groups: Object.freeze([...split.groups]),
        record_count: split.recordCount,
        content_hash: split.contentHash,
        case_ids: Object.freeze([...split.caseIds]),
      };
      deepFreeze(value);
      return value as DatasetSplitIdentity;
    }),
    cases,
    definition: { name: info.definitionName, content_hash: info.definitionHash },
    labels,
    runCase(record) {
      // One identifier and one input object alone. Every other record
      // field stays outside, and `run` validates the case again.
      const runCase = { id: record.id, input: record.input };
      deepFreeze(runCase);
      return runCase;
    },
  };
  Object.freeze(dataset.splits);
  deepFreeze(dataset);
  return dataset;
}

/** Builds the frozen identity of one dataset from the core result. */
function identityOf(info: DatasetInfo): DatasetIdentity {
  const identity: DatasetIdentity = {
    dataset_id: info.identity.datasetId,
    revision: info.identity.revision,
    kind: info.identity.kind as DatasetKind,
    population: info.identity.population as PopulationStatement,
    supports_qualification: info.identity.supportsQualification,
    states_prevalence: info.identity.statesPrevalence,
    intended_population: info.identity.intendedPopulation,
    sampling_method: info.identity.samplingMethod,
    record_count: info.identity.recordCount,
    content_hash: info.identity.contentHash,
    group_assignments: info.identity.groupAssignments.map((assignment) => {
      const value = {
        group: assignment.group,
        split_id: assignment.splitId,
        record_count: assignment.recordCount,
      };
      deepFreeze(value);
      return value as GroupAssignment;
    }),
    unassigned_groups: info.identity.unassignedGroups.map((unassigned) => {
      const value = {
        group: unassigned.group,
        record_count: unassigned.recordCount,
        first_line: unassigned.firstLine,
      };
      deepFreeze(value);
      return value as UnassignedGroup;
    }),
  };
  Object.freeze(identity.group_assignments);
  Object.freeze(identity.unassigned_groups);
  deepFreeze(identity);
  return identity;
}

/** Moves one public split identity into the boundary shape of the core. */
function splitIdentityOf(split: DatasetSplitIdentity): NativeSplitIdentity {
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

/**
 * Detects fitting and validation overlap between two split selections.
 *
 * Shared groups break the declared grouping strategy. Shared case
 * identifiers are duplicated cases: the same case supplied fitting and
 * validation evidence. The Rust core computes the facts; nothing is
 * changed and no rate is computed.
 *
 * @param fitting The fitting split selection of one calibration.
 * @param validation The validation split selection of one calibration.
 * @returns The overlap facts of the two selections.
 */
export function detectSplitOverlap(
  fitting: DatasetSplitIdentity,
  validation: DatasetSplitIdentity,
): SplitOverlap {
  const overlap = throughCore(() =>
    nativeSplitOverlap(splitIdentityOf(fitting), splitIdentityOf(validation)),
  );
  return {
    same_dataset: overlap.sameDataset,
    shared_groups: Object.freeze([...overlap.sharedGroups]),
    shared_cases: Object.freeze([...overlap.sharedCases]),
    separated: overlap.separated,
  };
}

/**
 * Requires fitting and validation selections that share no group and no
 * case.
 *
 * One overlap throws one {@link ValidationError} with `duplicate_id` at
 * `/datasets/validation`, because the validation data is the one that loses
 * its independence. A calibration plan states this rule for its two dataset
 * selections.
 *
 * @param fitting The fitting split selection of one calibration.
 * @param validation The validation split selection of one calibration.
 * @throws {ValidationError} when the two selections share one group or one
 * case.
 */
export function requireSeparatedSplits(
  fitting: DatasetSplitIdentity,
  validation: DatasetSplitIdentity,
): void {
  throughCore(() =>
    nativeRequireSeparatedSplits(splitIdentityOf(fitting), splitIdentityOf(validation)),
  );
}

/**
 * Classifies the validation evidence of one split selection.
 *
 * One reused holdout is development data however it is renamed, because the
 * content hash decides; a new qualification claim then needs fresh
 * validation evidence. One challenge set or one development fixture
 * supports no claim, and one empty split holds no evidence. The host states
 * which validation splits its earlier claims consumed, because the library
 * holds no clock and no storage.
 *
 * @param validation The validation split selection to classify.
 * @param dataset The identity of the dataset that holds the split.
 * @param previouslyUsed The validation splits that earlier qualification
 * claims consumed.
 * @returns The evidence classification with its plain statement.
 */
export function classifyValidationEvidence(
  validation: DatasetSplitIdentity,
  dataset: DatasetIdentity,
  previouslyUsed: readonly DatasetSplitIdentity[] = [],
): ValidationEvidence {
  const evidence = throughCore(() =>
    nativeValidationEvidence(
      splitIdentityOf(validation),
      dataset.population,
      previouslyUsed.map(splitIdentityOf),
    ),
  );
  return {
    class: evidence.class as EvidenceClass,
    representative_sample: evidence.representativeSample,
    record_count: evidence.recordCount,
    reused_from: Object.freeze([...evidence.reusedFrom]),
    needs_fresh_evidence: evidence.needsFreshEvidence,
    statement: evidence.statement,
  };
}
