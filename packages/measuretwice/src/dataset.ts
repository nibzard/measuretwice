// SPDX-License-Identifier: Apache-2.0
/**
 * `loadDataset` and the versioned JSONL case records it returns.
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
 * One failure throws one public {@link ValidationError} whose field path
 * names the line and the field, `/records/<line>/<field>`.
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
import { nativeValidateDataset } from "./native.js";
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
  /** Every case record, in file order. */
  readonly cases: readonly DatasetCase[];
  /** The definition that validated every input object. */
  readonly definition: Readonly<{ readonly name: string; readonly content_hash: string }>;
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
 * the declared record count, and every input object against the input
 * schema of the definition.
 *
 * @param options The definition, the metadata path, the records path, and
 * the optional file access.
 * @returns The frozen dataset: metadata, every case record with its
 * reference labels and label provenance, and the `runCase` operation that
 * strips every label field.
 * @throws {ValidationError} when one path names one wrong format, when the
 * metadata or one record fails its contract, or when one input object
 * fails the definition input schema. Every record failure names its line
 * and its field.
 * @throws {Error} when one stated path stays unreadable.
 */
export async function loadDataset(options: LoadDatasetOptions): Promise<Dataset> {
  const files = options.files ?? defaultFiles;

  let definitionText: string;
  if (typeof options.definition === "string") {
    requireJsonPath(options.definition, "/definition");
    definitionText = await readText(files, options.definition);
  } else {
    definitionText = jsonText(options.definition, "");
  }

  requireJsonPath(options.metadata, "/metadata");
  const metadataText = await readText(files, options.metadata);
  requireJsonlPath(options.records, "/records");
  const recordsText = await readText(files, options.records);

  const info = throughCore(() =>
    nativeValidateDataset(metadataText, recordsText, definitionText),
  );

  const metadata: unknown = JSON.parse(metadataText);
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

  const dataset: Dataset = {
    metadata: metadata as DatasetMetadata,
    cases,
    definition: { name: info.definitionName, content_hash: info.definitionHash },
    runCase(record) {
      // One identifier and one input object alone. Every other record
      // field stays outside, and `run` validates the case again.
      const runCase = { id: record.id, input: record.input };
      deepFreeze(runCase);
      return runCase;
    },
  };
  deepFreeze(dataset);
  return dataset;
}
