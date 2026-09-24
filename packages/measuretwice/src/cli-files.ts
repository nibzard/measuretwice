// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded, validated JSON file reading for the measuretwice command-line
 * interface.
 *
 * The CLI accepts explicit JSON data files and the `.measuretwice`
 * convention of MVP_SPEC.md section 11. This module owns the read path that
 * every command shares:
 *
 * - `resolveCliPath` maps one bare identifier into its convention folder and
 *   refuses one explicit path that names no accepted format before any read.
 *   The CLI loads no YAML and executes no TypeScript source, so a `.ts` or
 *   `.yaml` path fails with the registry code `unsupported_format` while the
 *   file stays untouched.
 * - Every reader bounds its file before the read, through the file size, and
 *   after the read, through the UTF-8 byte count of the returned text. One
 *   file above the bound fails with `oversized_input`. Nothing is truncated.
 * - Artifacts with one Rust validator cross that validator: definitions
 *   through the definition contract, profiles through the stored self-hash
 *   and the complete profile contract, and cases through the run-case
 *   boundary of the loaded definition. The reason codes and the field paths
 *   of the core pass through without change, so one executable field fails
 *   with `unknown_field` and one credential field fails the same way.
 * - Calibration plans and evaluation reports state no core reader in this
 *   build. Their readers gate the structure that the frozen schemas freeze:
 *   one JSON object, `schema_version` 1, and every required top-level
 *   field. The complete contracts arrive with their validation tasks.
 * - A profile reader that receives one evaluator registry rejects every
 *   binding that names one unregistered evaluator with
 *   `evaluator_mismatch`. One loaded file never installs one evaluator and
 *   never executes code.
 *
 * The module reads credentials nowhere: no reader opens one credential
 * store, and no artifact field may carry one, because the contract rejects
 * unknown fields. The host keeps its credentials in its own mechanism.
 *
 * Every failure is one {@link CliFailure} with one stable code, one short
 * actionable message, and one exit class: usage failures exit with 2, every
 * other failure with 1. Messages contain no credentials and no raw case
 * content.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Definition, JSONValue } from "./define-checks.js";
import { ValidationError } from "./error.js";
import {
  nativeValidateCase,
  nativeValidateDefinition,
  nativeValidateProfile,
  nativeVerifySelfHash,
} from "./native.js";
import { readDatasetTexts, type DatasetSource } from "./dataset.js";
import {
  deepFreeze,
  requireJsonPath,
  throughCore,
  type FileAccess,
  type Profile,
} from "./run.js";

// ---------------------------------------------------------------------------
// The CLI failure type.
// ---------------------------------------------------------------------------

/**
 * One typed CLI failure with one stable reason code.
 *
 * Codes from the published registry in `contracts/README.md` pass through
 * with their meaning. Codes that only the CLI produces are `unknown_command`,
 * `unknown_option`, `unsupported_option`, `missing_argument`,
 * `unexpected_argument`, `invalid_argument`, `unreadable_file`,
 * `unwritable_output`, `not_implemented`, and `internal_error`. A code keeps
 * its meaning across releases. The `exit` field states the process exit code
 * of the failure class: 2 for one usage failure, 1 for every other failure.
 */
export class CliFailure extends Error {
  /** Stable reason code. */
  readonly code: string;
  /** JSON Pointer to the rejected field, when the failure names one. */
  readonly fieldPath: string;
  /** The process exit code of this failure class. */
  readonly exit: 1 | 2;

  constructor(
    code: string,
    message: string,
    options: { fieldPath?: string; exit?: 1 | 2; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliFailure";
    this.code = code;
    this.fieldPath = options.fieldPath ?? "";
    this.exit = options.exit ?? 1;
  }
}

/**
 * Maps one library or core failure into the CLI shape without changing its
 * stable code or its field path. Every other error passes through.
 */
export function cliFailureOf(error: unknown): unknown {
  if (error instanceof CliFailure) {
    return error;
  }
  if (error instanceof ValidationError) {
    return new CliFailure(error.code, error.message, {
      fieldPath: error.fieldPath,
      exit: 1,
      cause: error,
    });
  }
  return error;
}

// ---------------------------------------------------------------------------
// File access and the size bound.
// ---------------------------------------------------------------------------

/**
 * The file access of the CLI: one UTF-8 read and one size in bytes.
 *
 * The size operation runs before every read, so one oversized file fails
 * before the CLI reads it. Tests inject one counting access to prove the
 * order.
 */
export interface CliFileAccess extends FileAccess {
  /** Returns the size of one file in bytes. */
  size(filePath: string): Promise<number>;
}

/** The default access: reads and sizes through the Node file APIs. */
export const defaultCliFiles: CliFileAccess = {
  async read(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
  },
  async size(filePath: string): Promise<number> {
    return (await stat(filePath)).size;
  },
};

/**
 * The published size limit of one CLI JSON file: 8,388,608 bytes, the same
 * limit as one dataset record line. Nothing is truncated.
 */
export const CLI_JSON_LIMIT_BYTES = 8_388_608;

/** The options that every CLI reader accepts. */
export interface CliReadOptions {
  /** The file access that reads the stated paths. The default uses Node APIs. */
  readonly files?: CliFileAccess;
  /** The byte limit of one file. The default is {@link CLI_JSON_LIMIT_BYTES}. */
  readonly limitBytes?: number;
}

/** Runs one core operation and maps its failure into the CLI shape. */
function core<T>(operation: () => T): T {
  try {
    return throughCore(operation);
  } catch (error) {
    throw cliFailureOf(error);
  }
}

/** Builds the failure of one unreadable path, with the cause of the system. */
function unreadablePath(filePath: string, cause: unknown, fieldPath: string): CliFailure {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new CliFailure(
    "unreadable_file",
    `measuretwice cannot read the path ${JSON.stringify(filePath)}: ${reason}. Check that the path names one readable file.`,
    { fieldPath, exit: 1, cause },
  );
}

/** Builds the failure of one oversized file. No truncation occurs. */
function oversizedPath(
  kind: string,
  filePath: string,
  bytes: number,
  limitBytes: number,
  fieldPath: string,
): CliFailure {
  return new CliFailure(
    "oversized_input",
    `The ${kind} file ${JSON.stringify(filePath)} holds ${bytes} bytes. The limit is ${limitBytes} bytes. No truncation occurs: export one smaller artifact or split the file.`,
    { fieldPath, exit: 1 },
  );
}

/** Reads one bounded UTF-8 text and keeps the cause of one failed read. */
async function readBoundedText(
  files: CliFileAccess,
  filePath: string,
  kind: string,
  limitBytes: number,
  fieldPath: string,
): Promise<string> {
  let size: number;
  try {
    size = await files.size(filePath);
  } catch (cause) {
    throw unreadablePath(filePath, cause, fieldPath);
  }
  if (size > limitBytes) {
    throw oversizedPath(kind, filePath, size, limitBytes, fieldPath);
  }
  let text: string;
  try {
    text = await files.read(filePath);
  } catch (cause) {
    throw unreadablePath(filePath, cause, fieldPath);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > limitBytes) {
    throw oversizedPath(kind, filePath, bytes, limitBytes, fieldPath);
  }
  return text;
}

/** Parses one JSON text. The failure names the position and echoes no content. */
function parseJsonText(text: string, kind: string, filePath: string, fieldPath: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    const location = /\(([^()]*line[^()]*)\)/.exec(
      cause instanceof Error ? cause.message : String(cause),
    );
    const where = location === null ? "" : ` (${location[1]})`;
    throw new CliFailure(
      "invalid_json",
      `The ${kind} file ${JSON.stringify(filePath)} holds no valid JSON${where}. Export the artifact again with one trusted application script.`,
      { fieldPath, exit: 1, cause },
    );
  }
}

/** Rejects one value that is no plain JSON object. */
function requireObject(value: unknown, kind: string, filePath: string, fieldPath: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliFailure(
      "invalid_field_type",
      `The ${kind} file ${JSON.stringify(filePath)} holds no JSON object. One artifact is one object.`,
      { fieldPath, exit: 1 },
    );
  }
}

/** Rejects one artifact that states one unsupported schema version. */
function requireSchemaVersion(
  artifact: Record<string, unknown>,
  kind: string,
  filePath: string,
): void {
  const stated = artifact.schema_version;
  if (stated !== 1) {
    throw new CliFailure(
      "unsupported_schema_version",
      `The ${kind} file ${JSON.stringify(filePath)} states schema_version ${JSON.stringify(stated)}. This build supports version 1 and never coerces. Export one artifact with one supported version.`,
      { fieldPath: "/schema_version", exit: 1 },
    );
  }
}

/** Rejects one artifact that omits one required top-level field. */
function requireFields(
  artifact: Record<string, unknown>,
  fields: readonly string[],
  kind: string,
  filePath: string,
): void {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(artifact, field)) {
      throw new CliFailure(
        "missing_field",
        `The ${kind} file ${JSON.stringify(filePath)} states no ${field}. Export one complete artifact with one trusted application script.`,
        { fieldPath: `/${field}`, exit: 1 },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Path resolution and the .measuretwice convention.
// ---------------------------------------------------------------------------

/** The artifact kinds that the CLI reads. */
export type CliArtifactKind =
  | "definition"
  | "profile"
  | "case"
  | "plan"
  | "report"
  | "dataset-metadata"
  | "dataset-records";

/** The folder and the file suffix of one artifact kind. */
interface KindRule {
  /** The file suffix that one explicit path must carry. */
  readonly suffix: string;
  /** The convention folder. `null` when the kind holds one fixed file. */
  readonly folder: string | null;
  /** The fixed convention file name, when the kind holds one. */
  readonly fixedName?: string;
}

const CONVENTION_ROOT = ".measuretwice";

const KIND_RULES: Record<CliArtifactKind, KindRule> = {
  definition: { suffix: ".json", folder: "definitions" },
  profile: { suffix: ".json", folder: "profiles" },
  case: { suffix: ".json", folder: "cases" },
  "dataset-metadata": { suffix: ".json", folder: "cases" },
  "dataset-records": { suffix: ".jsonl", folder: "cases" },
  plan: { suffix: ".json", folder: null, fixedName: "calibration-plan.json" },
  report: { suffix: ".json", folder: "reports" },
};

/** Names the accepted suffix of one kind inside one failure message. */
function kindPhrase(kind: CliArtifactKind): string {
  const rule = KIND_RULES[kind];
  const name = kind === "dataset-records" ? "dataset records" : kind.replace("-", " ");
  return `one ${rule.suffix} ${name} file`;
}

/**
 * Resolves one command argument into one explicit file path.
 *
 * One argument that holds one path separator or one dot names one explicit
 * path and stays as stated. One bare identifier resolves into the
 * `.measuretwice` convention folder of its kind, so `intervention` names
 * `.measuretwice/definitions/intervention.json` inside the working
 * directory. The plan kind accepts the bare name `calibration-plan` for its
 * fixed convention file.
 *
 * One explicit path that names no accepted format fails with the registry
 * code `unsupported_format` before any read, so one `.yaml` or `.ts` path
 * never touches the file system.
 *
 * @throws {CliFailure} with `unsupported_format` and exit code 1.
 */
export function resolveCliPath(
  kind: CliArtifactKind,
  value: string,
  cwd: string = process.cwd(),
): string {
  const rule = KIND_RULES[kind];
  const explicit = value.includes("/") || value.includes("\\") || value.includes(".");
  if (!explicit) {
    if (rule.folder !== null) {
      return path.join(cwd, CONVENTION_ROOT, rule.folder, `${value}${rule.suffix}`);
    }
    const fixedName = rule.fixedName ?? "artifact.json";
    if (value !== path.basename(fixedName, path.extname(fixedName))) {
      throw new CliFailure(
        "unsupported_format",
        `The name ${JSON.stringify(value)} names no calibration plan. Pass one explicit .json path, or the name calibration-plan for ${CONVENTION_ROOT}/${fixedName}.`,
        { fieldPath: "/plan", exit: 1 },
      );
    }
    return path.join(cwd, CONVENTION_ROOT, fixedName);
  }
  if (!value.endsWith(rule.suffix)) {
    throw new CliFailure(
      "unsupported_format",
      `The path ${JSON.stringify(value)} must name ${kindPhrase(kind)}. The CLI loads no YAML and executes no TypeScript source. Export the artifact with one trusted application script, or pass one bare name that resolves inside ${CONVENTION_ROOT}.`,
      { fieldPath: `/${kind}`, exit: 1 },
    );
  }
  return value;
}

/** Derives the default metadata path of one dataset records path. */
export function datasetMetadataPath(recordsPath: string): string {
  return recordsPath.endsWith(".jsonl")
    ? `${recordsPath.slice(0, -".jsonl".length)}.json`
    : `${recordsPath}.json`;
}

// ---------------------------------------------------------------------------
// The readers.
// ---------------------------------------------------------------------------

/** One definition file: the validated artifact, its name, and its hash. */
export interface DefinitionFile {
  /** The explicit path that was read. */
  readonly path: string;
  /** The complete file text, as read. */
  readonly text: string;
  /** The validated definition artifact, frozen. */
  readonly artifact: Definition;
  /** The definition name. */
  readonly name: string;
  /** The definition-domain content hash. */
  readonly contentHash: string;
  /** True when every check of the definition is one exact rule. */
  readonly isExactOnly: boolean;
  /** The kind of every check that the core established, in definition order. */
  readonly checkKinds: readonly Readonly<{ readonly id: string; readonly kind: string }>[];
}

/**
 * Reads one exported JSON definition file and validates it through the Rust
 * core.
 *
 * @throws {CliFailure} when the path names no `.json` file, when the file
 * stays unreadable or oversized, when the text holds no valid JSON, or when
 * the artifact breaks the definition contract. The core keeps its reason
 * code and its field path.
 */
export async function readDefinitionFile(
  filePath: string,
  options: CliReadOptions = {},
): Promise<DefinitionFile> {
  const files = options.files ?? defaultCliFiles;
  const limitBytes = options.limitBytes ?? CLI_JSON_LIMIT_BYTES;
  try {
    requireJsonPath(filePath, "/definition");
  } catch (error) {
    throw cliFailureOf(error);
  }
  const text = await readBoundedText(files, filePath, "definition", limitBytes, "/definition");
  const value = parseJsonText(text, "definition", filePath, "/definition");
  const info = core(() => nativeValidateDefinition(text));
  deepFreeze(value);
  return {
    path: filePath,
    text,
    artifact: value as Definition,
    name: info.name,
    contentHash: info.definitionHash,
    isExactOnly: info.isExactOnly,
    checkKinds: info.checkKinds.map((entry) => ({ id: entry.id, kind: entry.kind })),
  };
}

/** One profile file: the validated artifact with its verified self-hash. */
export interface ProfileFile {
  /** The explicit path that was read. */
  readonly path: string;
  /** The complete file text, as read. */
  readonly text: string;
  /** The validated profile artifact, frozen. */
  readonly artifact: Profile;
}

/** The options of `readProfileFile`. */
export interface ProfileReadOptions extends CliReadOptions {
  /**
   * The identifiers of the evaluators that the host registered. Every
   * binding that names one identifier outside this set fails with
   `evaluator_mismatch` before any command runs. Absent for one read that
   * inspects one profile without one registry.
   */
  readonly evaluators?: ReadonlySet<string>;
}

/**
 * Reads one JSON profile file and verifies it through the Rust core: the
 * stored self-hash first, then the complete profile contract.
 *
 * @throws {CliFailure} when the path names no `.json` file, when the file
 * stays unreadable or oversized, when the text holds no valid JSON, when the
 * artifact breaks the profile contract or its stored self-hash fails with
 * `hash_mismatch`, or when one binding names one unregistered evaluator.
 */
export async function readProfileFile(
  filePath: string,
  options: ProfileReadOptions = {},
): Promise<ProfileFile> {
  const files = options.files ?? defaultCliFiles;
  const limitBytes = options.limitBytes ?? CLI_JSON_LIMIT_BYTES;
  try {
    requireJsonPath(filePath, "/profile");
  } catch (error) {
    throw cliFailureOf(error);
  }
  const text = await readBoundedText(files, filePath, "profile", limitBytes, "/profile");
  const value = parseJsonText(text, "profile", filePath, "/profile");
  core(() => nativeVerifySelfHash("profile", text));
  core(() => nativeValidateProfile(text));
  requireObject(value, "profile", filePath, "/profile");
  deepFreeze(value);
  const profile = value as Profile;
  if (options.evaluators !== undefined) {
    for (const [index, binding] of (profile.bindings ?? []).entries()) {
      if (!options.evaluators.has(binding.evaluator)) {
        throw new CliFailure(
          "evaluator_mismatch",
          `The profile ${JSON.stringify(profile.id)} binds the evaluator ${JSON.stringify(binding.evaluator)} for the check ${JSON.stringify(binding.check)}. No evaluator with this identifier is registered. The registered identifiers are: ${[...options.evaluators].join(", ")}. Register the evaluator in the host, or bind one that is registered.`,
          { fieldPath: `/bindings/${index}/evaluator`, exit: 1 },
        );
      }
    }
  }
  return { path: filePath, text, artifact: profile };
}

/** One case file: the validated run case with its input hash. */
export interface CaseFile {
  /** The explicit path that was read. */
  readonly path: string;
  /** The complete file text, as read. */
  readonly text: string;
  /** The case artifact, frozen. */
  readonly artifact: Readonly<Record<string, JSONValue>>;
  /** The stable case identifier. */
  readonly caseId: string;
  /** The input-domain content hash of the case input. */
  readonly inputHash: string;
}

/**
 * Reads one JSON case file and validates it against the text of the loaded
 * definition, through the same run-case boundary that `run` uses.
 *
 * @throws {CliFailure} when the path names no `.json` file, when the file
 * stays unreadable or oversized, when the text holds no valid JSON, or when
 * the case breaks the input schema of the definition. The core keeps its
 * reason code and its field path.
 */
export async function readCaseFile(
  filePath: string,
  definitionText: string,
  options: CliReadOptions = {},
): Promise<CaseFile> {
  const files = options.files ?? defaultCliFiles;
  const limitBytes = options.limitBytes ?? CLI_JSON_LIMIT_BYTES;
  try {
    requireJsonPath(filePath, "/case");
  } catch (error) {
    throw cliFailureOf(error);
  }
  const text = await readBoundedText(files, filePath, "case", limitBytes, "/case");
  const value = parseJsonText(text, "case", filePath, "/case");
  const info = core(() => nativeValidateCase(definitionText, text));
  requireObject(value, "case", filePath, "/case");
  deepFreeze(value);
  return {
    path: filePath,
    text,
    artifact: value as Readonly<Record<string, JSONValue>>,
    caseId: info.id,
    inputHash: info.inputHash,
  };
}

/** The required top-level fields of one calibration plan artifact. */
const PLAN_REQUIRED_FIELDS = [
  "id",
  "definition",
  "intended_population",
  "sampling_assumptions",
  "confidence_level",
  "constraints",
  "objective",
  "minimum_samples",
  "candidate_grid",
  "evaluator",
  "datasets",
] as const;

/** One plan file: the artifact text and its gated value. */
export interface PlanFile {
  /** The explicit path that was read. */
  readonly path: string;
  /** The complete file text, as read. */
  readonly text: string;
  /** The plan artifact, frozen. */
  readonly artifact: Readonly<Record<string, JSONValue>>;
}

/**
 * Reads one JSON calibration plan file and gates its frozen structure: one
 * JSON object, `schema_version` 1, and every required top-level field.
 *
 * The complete plan contract, its cross-field invariants, and its self-hash
 * arrive with the calibration plan task. This reader rejects the same
 * wrong-format and wrong-size inputs as every other reader.
 *
 * @throws {CliFailure} with `unsupported_format`, `unreadable_file`,
 * `oversized_input`, `invalid_json`, `invalid_field_type`,
 * `unsupported_schema_version`, or `missing_field`.
 */
export async function readPlanFile(
  filePath: string,
  options: CliReadOptions = {},
): Promise<PlanFile> {
  const files = options.files ?? defaultCliFiles;
  const limitBytes = options.limitBytes ?? CLI_JSON_LIMIT_BYTES;
  try {
    requireJsonPath(filePath, "/plan");
  } catch (error) {
    throw cliFailureOf(error);
  }
  const text = await readBoundedText(files, filePath, "calibration plan", limitBytes, "/plan");
  const value = parseJsonText(text, "calibration plan", filePath, "/plan");
  requireObject(value, "calibration plan", filePath, "/plan");
  const artifact = value as Record<string, unknown>;
  requireSchemaVersion(artifact, "calibration plan", filePath);
  requireFields(artifact, PLAN_REQUIRED_FIELDS, "calibration plan", filePath);
  deepFreeze(artifact);
  return { path: filePath, text, artifact: artifact as PlanFile["artifact"] };
}

/** The required top-level fields of one evaluation report artifact. */
const REPORT_REQUIRED_FIELDS = [
  "definition",
  "profile",
  "dataset",
  "purpose",
  "cases",
  "metrics",
] as const;

/** One report file: the artifact text and its gated value. */
export interface ReportFile {
  /** The explicit path that was read. */
  readonly path: string;
  /** The complete file text, as read. */
  readonly text: string;
  /** The report artifact, frozen. */
  readonly artifact: Readonly<Record<string, JSONValue>>;
}

/**
 * Reads one JSON evaluation report file and gates its frozen structure: one
 * JSON object, `schema_version` 1, and every required top-level field.
 *
 * The complete evaluation report contract is verified by the Rust core when
 * one command consumes the report. This reader rejects the same wrong-format
 * and wrong-size inputs as every other reader.
 *
 * @throws {CliFailure} with `unsupported_format`, `unreadable_file`,
 * `oversized_input`, `invalid_json`, `invalid_field_type`,
 * `unsupported_schema_version`, or `missing_field`.
 */
export async function readReportFile(
  filePath: string,
  options: CliReadOptions = {},
): Promise<ReportFile> {
  const files = options.files ?? defaultCliFiles;
  const limitBytes = options.limitBytes ?? CLI_JSON_LIMIT_BYTES;
  try {
    requireJsonPath(filePath, "/report");
  } catch (error) {
    throw cliFailureOf(error);
  }
  const text = await readBoundedText(files, filePath, "evaluation report", limitBytes, "/report");
  const value = parseJsonText(text, "evaluation report", filePath, "/report");
  requireObject(value, "evaluation report", filePath, "/report");
  const artifact = value as Record<string, unknown>;
  requireSchemaVersion(artifact, "evaluation report", filePath);
  requireFields(artifact, REPORT_REQUIRED_FIELDS, "evaluation report", filePath);
  deepFreeze(artifact);
  return { path: filePath, text, artifact: artifact as ReportFile["artifact"] };
}

/**
 * Reads one dataset source: one `.json` metadata file and one `.jsonl`
 * records file, through the same library gate that `loadDataset` uses.
 *
 * The dataset limits stay with the Rust core: one record line holds at most
 * 8,388,608 bytes, one record file holds at most 536,870,912 bytes, and one
 * dataset holds at most 100,000 records. Nothing is truncated.
 *
 * @throws {CliFailure} when one path names one wrong format or one stated
 * path stays unreadable.
 */
export async function readDatasetFiles(
  metadataPath: string,
  recordsPath: string,
  options: CliReadOptions = {},
): Promise<DatasetSource> {
  const files = options.files ?? defaultCliFiles;
  try {
    return await readDatasetTexts(metadataPath, recordsPath, files);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw cliFailureOf(error);
    }
    if (error instanceof Error) {
      throw new CliFailure("unreadable_file", error.message, {
        exit: 1,
        cause: error,
      });
    }
    throw error;
  }
}
