#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The measuretwice command-line interface: command parsing, help text,
 * output formats, exit behavior, and the dispatch of the commands.
 *
 * The CLI consumes explicit JSON data files and the `.measuretwice`
 * convention of MVP_SPEC.md section 11. It loads no YAML and executes no
 * TypeScript source. The bounded validated readers live in
 * `cli-files.ts`; this module owns the surface and the commands:
 *
 * - `parseCliArguments` parses one command, its options, and its artifact
 *   paths into one typed invocation. One bare identifier resolves inside
 *   the convention folder of its kind. Usage failures exit with code 2 and
 *   one stable reason code.
 * - `runCli` executes one parsed invocation and returns the exit code.
 *   Command results print to stdout. Diagnostics print to stderr, so
 *   machine-readable output stays separate. With `--format json`, one
 *   failure prints one JSON error object on stderr.
 * - Exit codes: 0 for one completed command, 1 for one failure of files,
 *   artifacts, or data, 2 for one usage error. One completed `run` exits
 *   with code 0, whatever outcome its report states, because one report
 *   outcome is no command failure.
 * - The CLI reads no credential option and no credential variable. The
 *   host keeps its credentials in its own mechanism.
 *
 * The `validate`, `run`, and `inspect` commands of MVP_SPEC.md section 11
 * run in this module. `validate` states the meaning that the Rust core
 * established for one exported definition, with no evaluator and no
 * provider call. `run` assesses one case through the same `load` and `run`
 * path as the library, renders the report through the shared renderer, and
 * writes the artifact with `--out`. The CLI registers no evaluator
 * adapter, because one loaded file installs no evaluator and the CLI
 * executes no host code, so one definition with one question check refuses
 * `run` with `evaluator_mismatch` before any work starts. Enforcement
 * needs one host-selected profile hash, so the CLI refuses
 * `--mode enforcement` with `profile_not_selected`. `inspect` renders one
 * profile through the shared renderer, and its JSON form prints the stored
 * artifact. The `calibrate`, `evaluate`, and `compare` commands arrive
 * with their task; this build reports `not_implemented` after one
 * accepted parse.
 */
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { contractVersion } from "./index.js";
import {
  CliFailure,
  cliFailureOf,
  datasetMetadataPath,
  readCaseFile,
  readDefinitionFile,
  readProfileFile,
  resolveCliPath,
  type CliArtifactKind,
  type DefinitionFile,
} from "./cli-files.js";
import type { CheckDefinition, ExactRule, JSONValue, JsonSchemaNode } from "./define-checks.js";
import { renderProfileSummary, renderRunReport } from "./render.js";
import {
  load,
  type FileAccess,
  type RunReport,
} from "./run.js";

/** The help text of the CLI. It documents every command and rule of the surface. */
export const USAGE = `measuretwice — semantic checks with measured reliability

Usage:
  measuretwice <command> [options]
  measuretwice --help
  measuretwice --version

Commands:
  validate <definition>              Check one exported JSON definition.
  run <definition>                   Assess one case.
                                     Options: --case, --profile, --mode.
  calibrate <definition>             Fit one candidate profile.
                                     Options: --plan, --out.
  evaluate <definition>              Assess one dataset.
                                     Options: --profile, --cases, --metadata,
                                     --purpose, --out.
  compare <baseline> <candidate>     Compare two stored evaluation reports.
  inspect <profile>                  Show one profile summary.
                                     Options: --detail.

Artifact paths:
  Every artifact argument names one explicit .json or .jsonl file. One bare
  name resolves inside the .measuretwice convention folder of its kind:
  definitions/, profiles/, cases/, reports/, and calibration-plan.json.
  The CLI loads no YAML and executes no TypeScript source. Export the
  artifact with one trusted application script first. The README of the
  package documents one script that writes the result of defineChecks.

Options:
  --format <text|json>      Select the output format. Default: text. The
                            text form prints the readable view. The json
                            form prints the complete artifact of the
                            command: the summary object of validate, the
                            run report of run, and the stored profile of
                            inspect.
  --mode <shadow|enforcement>
                            Select the run mode. Default: shadow.
  --detail <summary|detailed>
                            Select the inspect level. Default: summary. The
                            detailed level adds the bindings, the policy,
                            the execution limits, the evidence, and the
                            recorded performance.
  --purpose <exploration|fitting|independent_validation>
                            Declare the purpose of one evaluation.
  --case <path>             One case file. Required for run.
  --cases <path>            One .jsonl dataset records file.
  --metadata <path>         One dataset metadata file. Default: the records
                            path with .json.
  --plan <path>             One calibration plan. Required for calibrate.
  --profile <path>          One profile file.
  --out <path>              One output path for one written artifact. The
                            run command writes its report artifact there.
  --help                    Print this help text.
  --version                 Print the package and contract schema versions.

Evaluators and modes:
  The CLI executes exact rules through the Rust core. It registers no
  evaluator adapter, because one loaded file installs no evaluator and the
  CLI executes no host code. One definition with one question check refuses
  run with evaluator_mismatch before any work starts. Run question checks
  through the library in your application. Enforcement selects one profile
  through host review, and the CLI states no selection, so --mode
  enforcement refuses with profile_not_selected.

Output and exit codes:
  Command results print to stdout. Diagnostics print to stderr. With
  --format json, one failure prints one JSON error object on stderr.
  Exit 0: the command completed. One completed run exits with code 0,
  whatever outcome its report states. Exit 1: one failure of files,
  artifacts, or data. Exit 2: one usage error.

Credentials:
  The CLI reads no credential option and no credential variable. Keep
  credentials in the credential mechanism of the host.

The commands above are specified in MVP_SPEC.md section 11. This build
implements validate, run, and inspect. The calibrate, evaluate, and compare
commands arrive with their task.
`;

/** The commands that MVP_SPEC.md section 11 specifies. */
export type CliCommand = "validate" | "run" | "calibrate" | "evaluate" | "compare" | "inspect";

/** The output formats of one command. */
export type CliFormat = "text" | "json";

/** The run modes of `run`. */
export type CliRunMode = "shadow" | "enforcement";

/** The declared purposes of one evaluation. */
export type CliPurpose = "exploration" | "fitting" | "independent_validation";

/** The inspection levels of `inspect`. */
export type CliDetail = "summary" | "detailed";

/** One parsed command invocation with resolved artifact paths. */
export type CliInvocation =
  | { readonly command: "validate"; readonly definition: string; readonly format: CliFormat }
  | {
      readonly command: "run";
      readonly definition: string;
      readonly case: string;
      readonly profile?: string;
      readonly mode: CliRunMode;
      readonly out?: string;
      readonly format: CliFormat;
    }
  | {
      readonly command: "calibrate";
      readonly definition: string;
      readonly plan: string;
      readonly out?: string;
      readonly format: CliFormat;
    }
  | {
      readonly command: "evaluate";
      readonly definition: string;
      readonly cases: string;
      readonly metadata: string;
      readonly profile?: string;
      readonly purpose?: CliPurpose;
      readonly out?: string;
      readonly format: CliFormat;
    }
  | {
      readonly command: "compare";
      readonly baseline: string;
      readonly candidate: string;
      readonly format: CliFormat;
    }
  | {
      readonly command: "inspect";
      readonly profile: string;
      readonly detail: CliDetail;
      readonly format: CliFormat;
    };

/** The options of `parseCliArguments`. */
export interface ParseOptions {
  /** The working directory of the `.measuretwice` convention. */
  readonly cwd?: string | undefined;
}

/** One positional argument of one command. */
interface PositionalSpec {
  /** The argument name that error messages use. */
  readonly name: string;
  /** The artifact kind that resolves the value. */
  readonly kind: CliArtifactKind;
}

/** The parsing rule of one command. */
interface CommandSpec {
  /** The positional arguments, in order. */
  readonly positionals: readonly PositionalSpec[];
  /** The string options that the command accepts. */
  readonly stringOptions: readonly string[];
  /** The options that must hold one value. */
  readonly requiredOptions: readonly { readonly name: string; readonly purpose: string }[];
  /** The enum options with their accepted values. */
  readonly enums: Readonly<Record<string, readonly string[]>>;
}

const FORMAT_VALUES: readonly string[] = ["text", "json"];

const COMMAND_SPECS: Record<CliCommand, CommandSpec> = {
  validate: {
    positionals: [{ name: "definition", kind: "definition" }],
    stringOptions: [],
    requiredOptions: [],
    enums: { format: FORMAT_VALUES },
  },
  run: {
    positionals: [{ name: "definition", kind: "definition" }],
    stringOptions: ["profile", "case", "mode", "out"],
    requiredOptions: [
      { name: "case", purpose: "Pass one case file through --case." },
    ],
    enums: { format: FORMAT_VALUES, mode: ["shadow", "enforcement"] },
  },
  calibrate: {
    positionals: [{ name: "definition", kind: "definition" }],
    stringOptions: ["plan", "out"],
    requiredOptions: [
      {
        name: "plan",
        purpose: "Pass one calibration plan through --plan, or the name calibration-plan.",
      },
    ],
    enums: { format: FORMAT_VALUES },
  },
  evaluate: {
    positionals: [{ name: "definition", kind: "definition" }],
    stringOptions: ["profile", "cases", "metadata", "purpose", "out"],
    requiredOptions: [
      { name: "cases", purpose: "Pass one dataset records file through --cases." },
    ],
    enums: {
      format: FORMAT_VALUES,
      purpose: ["exploration", "fitting", "independent_validation"],
    },
  },
  compare: {
    positionals: [
      { name: "baseline report", kind: "report" },
      { name: "candidate report", kind: "report" },
    ],
    stringOptions: [],
    requiredOptions: [],
    enums: { format: FORMAT_VALUES },
  },
  inspect: {
    positionals: [{ name: "profile", kind: "profile" }],
    stringOptions: ["detail"],
    requiredOptions: [],
    enums: { format: FORMAT_VALUES, detail: ["summary", "detailed"] },
  },
};

const KNOWN_COMMANDS: readonly CliCommand[] = [
  "calibrate",
  "compare",
  "evaluate",
  "inspect",
  "run",
  "validate",
];

/**
 * Parses one command line into one typed invocation with resolved paths.
 *
 * The function reads no file: one bare name resolves into its convention
 * path, and one explicit path that names no accepted format fails before
 * any read. Usage failures throw one {@link CliFailure} with exit code 2.
 *
 * @param argv The arguments after `node` and the program path.
 * @param options The parsing options.
 * @throws {CliFailure} when the command line breaks one parsing rule.
 */
export function parseCliArguments(
  argv: readonly string[],
  options: ParseOptions = {},
): CliInvocation {
  const [first] = argv;
  if (first === undefined) {
    throw new CliFailure(
      "missing_argument",
      `The command line states no command. Pass one of: ${KNOWN_COMMANDS.join(", ")}.`,
      { exit: 2 },
    );
  }
  if (!(KNOWN_COMMANDS as readonly string[]).includes(first)) {
    throw new CliFailure(
      "unknown_command",
      `The command ${JSON.stringify(first)} does not exist. The known commands are: ${KNOWN_COMMANDS.join(", ")}.`,
      { exit: 2 },
    );
  }
  const command = first as CliCommand;
  const spec = COMMAND_SPECS[command];

  const values = parseCommandOptions(command, spec, argv.slice(1));

  const positionals = values.positionals;
  if (positionals.length < spec.positionals.length) {
    const missing = spec.positionals[positionals.length];
    throw new CliFailure(
      "missing_argument",
      `The ${command} command states no ${missing?.name ?? "argument"}. Pass ${spec.positionals
        .map((entry) => `<${entry.name}>`)
        .join(" ")}.`,
      { exit: 2, fieldPath: `/${command}` },
    );
  }
  if (positionals.length > spec.positionals.length) {
    throw new CliFailure(
      "unexpected_argument",
      `The ${command} command accepts ${spec.positionals.length} argument${spec.positionals.length === 1 ? "" : "s"} and received ${positionals.length}. Quote one path that holds spaces, and pass options as --option value.`,
      { exit: 2, fieldPath: `/${command}` },
    );
  }

  for (const required of spec.requiredOptions) {
    if (values.options[required.name] === undefined) {
      throw new CliFailure(
        "missing_argument",
        `The ${command} command states no --${required.name}. ${required.purpose}`,
        { exit: 2, fieldPath: `/${required.name}` },
      );
    }
  }

  const format = enumValue(command, spec, values, "format", "text") as CliFormat;
  const resolved = spec.positionals.map((entry, index) =>
    resolveCliPath(entry.kind, positionals[index] as string, options.cwd),
  );

  switch (command) {
    case "validate":
      return { command, definition: resolved[0] as string, format };
    case "run":
      return {
        command,
        definition: resolved[0] as string,
        case: resolveCliPath("case", stringValue(values, "case"), options.cwd),
        ...(values.options.profile === undefined
          ? {}
          : { profile: resolveCliPath("profile", values.options.profile, options.cwd) }),
        mode: enumValue(command, spec, values, "mode", "shadow") as CliRunMode,
        ...(values.options.out === undefined ? {} : { out: stringValue(values, "out") }),
        format,
      };
    case "calibrate":
      return {
        command,
        definition: resolved[0] as string,
        plan: resolveCliPath("plan", stringValue(values, "plan"), options.cwd),
        ...(values.options.out === undefined
          ? {}
          : { out: stringValue(values, "out") }),
        format,
      };
    case "evaluate": {
      const cases = resolveCliPath("dataset-records", stringValue(values, "cases"), options.cwd);
      return {
        command,
        definition: resolved[0] as string,
        cases,
        metadata:
          values.options.metadata === undefined
            ? datasetMetadataPath(cases)
            : resolveCliPath("dataset-metadata", values.options.metadata, options.cwd),
        ...(values.options.profile === undefined
          ? {}
          : { profile: resolveCliPath("profile", values.options.profile, options.cwd) }),
        ...(values.options.purpose === undefined
          ? {}
          : { purpose: enumValue(command, spec, values, "purpose", "") as CliPurpose }),
        ...(values.options.out === undefined ? {} : { out: stringValue(values, "out") }),
        format,
      };
    }
    case "compare":
      return {
        command,
        baseline: resolved[0] as string,
        candidate: resolved[1] as string,
        format,
      };
    case "inspect":
      return {
        command,
        profile: resolved[0] as string,
        detail: enumValue(command, spec, values, "detail", "summary") as CliDetail,
        format,
      };
  }
}

/** One parsed option set of one command. */
interface ParsedOptions {
  readonly options: Readonly<Record<string, string | undefined>>;
  readonly positionals: readonly string[];
}

/** Parses the options of one command and maps usage failures. */
function parseCommandOptions(
  command: CliCommand,
  spec: CommandSpec,
  args: readonly string[],
): ParsedOptions {
  const optionTable: Record<string, { type: "string" | "boolean" }> = {
    help: { type: "boolean" },
    version: { type: "boolean" },
  };
  for (const name of spec.stringOptions) {
    optionTable[name] = { type: "string" };
  }
  for (const name of Object.keys(spec.enums)) {
    optionTable[name] = { type: "string" };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: optionTable,
      allowPositionals: true,
      strict: true,
    });
  } catch (cause) {
    throw usageFailure(command, cause);
  }
  const options: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(parsed.values)) {
    if (typeof value === "string") {
      options[name] = value;
    }
  }
  return { options, positionals: parsed.positionals };
}

/** Maps one parse failure of Node into one stable usage failure. */
function usageFailure(command: CliCommand, cause: unknown): CliFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  const option = /'(--[\w-]+)'/.exec(message)?.[1];
  if (/^Unknown option/i.test(message) && option !== undefined) {
    return new CliFailure(
      "unsupported_option",
      `The ${command} command accepts no ${option} option. Run 'measuretwice --help' for the usage.`,
      { exit: 2, fieldPath: `/${command}`, cause },
    );
  }
  const code = /^Unknown option/i.test(message)
    ? "unknown_option"
    : /argument missing|missing value|requires an argument/i.test(message)
      ? "missing_argument"
      : "invalid_argument";
  return new CliFailure(code, `${message} Run 'measuretwice --help' for the usage.`, {
    exit: 2,
    cause,
  });
}

/** Reads one required string option. */
function stringValue(values: ParsedOptions, name: string): string {
  return values.options[name] as string;
}

/** Reads one enum option with its documented default. */
function enumValue(
  command: CliCommand,
  spec: CommandSpec,
  values: ParsedOptions,
  name: string,
  fallback: string,
): string {
  const stated = values.options[name] ?? fallback;
  const accepted = spec.enums[name] as readonly string[];
  if (!accepted.includes(stated)) {
    throw new CliFailure(
      "invalid_argument",
      `The value ${JSON.stringify(stated)} of --${name} names no accepted value. The accepted values are: ${accepted.join(", ")}.`,
      { exit: 2, fieldPath: `/${command}/${name}` },
    );
  }
  return stated;
}

// ---------------------------------------------------------------------------
// Output, exit behavior, and dispatch.
// ---------------------------------------------------------------------------

/** The output streams of one CLI run. Diagnostics stay separate from results. */
export interface CliIo {
  /** Writes one command result. */
  writeOut(text: string): void;
  /** Writes one diagnostic. */
  writeErr(text: string): void;
}

const processIo: CliIo = {
  writeOut(text: string): void {
    process.stdout.write(text);
  },
  writeErr(text: string): void {
    process.stderr.write(text);
  },
};

/** The options of `runCli`. */
export interface CliOptions extends ParseOptions {
  /** The output streams. The default writes to the process streams. */
  readonly io?: CliIo;
}

/**
 * Runs one command line and returns the exit code.
 *
 * The command results print to stdout. The diagnostics print to stderr: one
 * human-readable line in text mode, one JSON error object with
 * `--format json`. The CLI writes no file in this build.
 *
 * @param argv The arguments after `node` and the program path.
 * @param options The streams and the convention directory.
 * @returns The exit code: 0, 1, or 2.
 */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? processIo;
  if (argv.length === 0 || argv.includes("--help")) {
    io.writeOut(USAGE);
    return 0;
  }
  if (argv.includes("--version")) {
    io.writeOut(`measuretwice ${packageVersion()} (contracts v${contractVersion()})\n`);
    return 0;
  }
  let invocation: CliInvocation;
  try {
    invocation = parseCliArguments(argv, options);
  } catch (error) {
    return reportFailure(io, statedFormat(argv), error);
  }
  try {
    return await dispatch(invocation, { io, cwd: options.cwd });
  } catch (error) {
    return reportFailure(io, invocation.format, error);
  }
}

/** Reads the stated output format from one raw command line. */
function statedFormat(argv: readonly string[]): CliFormat {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--format") {
      return argv[index + 1] === "json" ? "json" : "text";
    }
    if (argument.startsWith("--format=")) {
      return argument.slice("--format=".length) === "json" ? "json" : "text";
    }
  }
  return "text";
}

/** The context that one command handler receives. */
interface CommandContext {
  readonly io: CliIo;
  readonly cwd: string | undefined;
}

/** Dispatches one parsed invocation to its command. */
async function dispatch(
  invocation: CliInvocation,
  context: CommandContext,
): Promise<number> {
  switch (invocation.command) {
    case "validate":
      return validateCommand(invocation, context);
    case "run":
      return runCommand(invocation, context);
    case "inspect":
      return inspectCommand(invocation, context);
    default:
      // The calibrate, evaluate, and compare commands arrive with their
      // task. The accepted parse keeps its exit code 1 and its stable code.
      throw new CliFailure(
        "not_implemented",
        `The ${invocation.command} command is specified in MVP_SPEC.md section 11 and is not implemented in this build. This build implements validate, run, and inspect.`,
        { exit: 1 },
      );
  }
}

// ---------------------------------------------------------------------------
// validate: the meaning that the core established for one definition.
// ---------------------------------------------------------------------------

/** One check row of the validate output. */
interface CheckRow {
  /** The check identifier. */
  readonly id: string;
  /** The readable statement of the requirement. */
  readonly name: string;
  /** The kind that the Rust core established: rule or one answer kind. */
  readonly kind: string;
  /** The declared inputs of the check. */
  readonly using: readonly string[];
  /** The executed rule, for one exact rule check. */
  readonly rule?: ExactRule;
  /** The question put to an evaluator, for one question check. */
  readonly question?: string;
  /** The acceptable answers or levels, expanded for one scale. */
  readonly accept?: readonly string[];
  /** The declared review answers or levels. */
  readonly review?: readonly string[];
}

/** Reads the declared input names of one definition input schema. */
function inputNamesOf(inputs: JsonSchemaNode): readonly string[] {
  const properties = inputs.properties;
  if (typeof properties !== "object" || properties === null) {
    return [];
  }
  return Object.keys(properties);
}

/** Reads the acceptable answers or levels of one check, with scale expansion. */
function acceptListOf(check: CheckDefinition): readonly string[] {
  const accept = check.accept;
  if (accept === undefined) {
    return [];
  }
  if (typeof accept === "string") {
    return [accept];
  }
  if ("at_least" in accept) {
    const levels = (check.scale ?? []).map((level) => Object.keys(level)[0] ?? "");
    const start = levels.indexOf(accept.at_least);
    return start === -1 ? [] : levels.slice(start);
  }
  return [...accept];
}

/** Reads the declared review answers or levels of one check. */
function reviewListOf(check: CheckDefinition): readonly string[] {
  const review = check.review;
  if (review === undefined) {
    return [];
  }
  return typeof review === "string" ? [review] : [...review];
}

/** Builds the check rows of the validate output from the validated artifact. */
function checkRows(file: DefinitionFile): readonly CheckRow[] {
  const kinds = new Map(file.checkKinds.map((entry) => [entry.id, entry.kind]));
  return file.artifact.checks.map((check) => ({
    id: check.id,
    name: check.name,
    kind: kinds.get(check.id) ?? (check.rule !== undefined ? "rule" : "question"),
    using: [...check.using],
    ...(check.rule !== undefined
      ? { rule: check.rule }
      : {
          question: check.question ?? "",
          accept: acceptListOf(check),
          review: reviewListOf(check),
        }),
  }));
}

/** The summary object of the validate command. */
function definitionSummary(file: DefinitionFile): Readonly<Record<string, unknown>> {
  return {
    definition: file.name,
    content_hash: file.contentHash,
    exact_only: file.isExactOnly,
    inputs: inputNamesOf(file.artifact.inputs),
    checks: checkRows(file),
  };
}

/** Names the executed rule of one exact rule check for the text view. */
function rulePhrase(rule: ExactRule): string {
  if ("maxLength" in rule) {
    return `maxLength ${rule.maxLength}`;
  }
  if ("includes" in rule) {
    return `includes ${JSON.stringify(rule.includes)}`;
  }
  return `excludes ${JSON.stringify(rule.excludes)}`;
}

/** Renders the readable validate view of one validated definition. */
function renderDefinitionSummary(file: DefinitionFile): string {
  const rows = checkRows(file);
  const questions = rows.filter((row) => row.rule === undefined).length;
  const rules = rows.length - questions;
  const lines: string[] = [
    `${file.name} · valid definition`,
    `Content hash: ${file.contentHash}`,
    `Inputs: ${inputNamesOf(file.artifact.inputs).join(", ")}`,
    `Checks: ${rows.length} (${rules} exact rules, ${questions} question checks)`,
  ];
  if (rows.length > 0) {
    lines.push("");
  }
  for (const row of rows) {
    lines.push(`${row.id} · ${row.name}`);
    if (row.rule !== undefined) {
      lines.push(`  ${row.kind} ${rulePhrase(row.rule)} on ${row.using.join(", ")}`);
    } else {
      const parts = [
        `${row.kind} question on ${row.using.join(", ")}`,
        `accepts ${row.accept?.join(", ") || "(none)"}`,
      ];
      if ((row.review?.length ?? 0) > 0) {
        parts.push(`reviews ${row.review?.join(", ")}`);
      }
      lines.push(`  ${parts.join(" · ")}`);
    }
  }
  lines.push(
    "",
    file.isExactOnly
      ? "The definition holds exact rules only. The CLI runs them through the Rust core, with no evaluator and no provider call."
      : "One question check needs one evaluator that the host registers. The CLI registers none, so run this definition through the library in your application.",
  );
  return lines.join("\n");
}

/** Validates one exported JSON definition and states its meaning. */
async function validateCommand(
  invocation: Extract<CliInvocation, { readonly command: "validate" }>,
  context: CommandContext,
): Promise<number> {
  const file = await readDefinitionFile(invocation.definition);
  const text =
    invocation.format === "json"
      ? JSON.stringify(definitionSummary(file), null, 2)
      : renderDefinitionSummary(file);
  context.io.writeOut(`${text}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// run: one case through the same validated path as the library.
// ---------------------------------------------------------------------------

/** The note that the CLI adds to one boundary failure of the run path. */
const EVALUATOR_NOTE =
  "The CLI registers no evaluator adapter, because one loaded file installs no evaluator and the CLI executes no host code. Run question checks through the library in your application.";

/** The note that the CLI adds to one enforcement refusal of the run path. */
const SELECTION_NOTE =
  "The CLI states no host profile selection. Run enforcement through the library in your application, where your code states the reviewed profile hash.";

/**
 * Adds the CLI boundary to one failure of the run path that the host can
 * resolve only in its own code. The stable code and the field path stay.
 */
function withCliBoundary(error: unknown): unknown {
  const mapped = cliFailureOf(error);
  if (mapped instanceof CliFailure) {
    if (mapped.code === "evaluator_mismatch") {
      return new CliFailure(mapped.code, `${mapped.message} ${EVALUATOR_NOTE}`, {
        fieldPath: mapped.fieldPath,
        exit: 1,
        cause: error,
      });
    }
    if (mapped.code === "profile_not_selected") {
      return new CliFailure(mapped.code, `${mapped.message} ${SELECTION_NOTE}`, {
        fieldPath: mapped.fieldPath,
        exit: 1,
        cause: error,
      });
    }
  }
  return mapped;
}

/** Serves the artifacts that the CLI already read, so `load` reads no file twice. */
function readAccess(texts: ReadonlyMap<string, string>): FileAccess {
  return {
    async read(filePath: string): Promise<string> {
      const text = texts.get(filePath);
      if (text === undefined) {
        throw new Error(
          `measuretwice read the path ${JSON.stringify(filePath)} already and holds no second copy.`,
        );
      }
      return text;
    },
  };
}

/** Writes one artifact as JSON and refuses one failed write explicitly. */
async function writeArtifact(filePath: string, artifact: unknown): Promise<void> {
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  try {
    await writeFile(filePath, text, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new CliFailure(
      "unwritable_output",
      `measuretwice cannot write the path ${JSON.stringify(filePath)}: ${reason}. The command wrote no artifact.`,
      { fieldPath: "/out", exit: 1, cause },
    );
  }
}

/** Assesses one case and renders its report. */
async function runCommand(
  invocation: Extract<CliInvocation, { readonly command: "run" }>,
  context: CommandContext,
): Promise<number> {
  const definition = await readDefinitionFile(invocation.definition);
  const caseFile = await readCaseFile(invocation.case, definition.text);
  const profileFile =
    invocation.profile === undefined ? undefined : await readProfileFile(invocation.profile);
  // The texts that the bounded readers hold cross again through the library
  // boundary, so `load` reads no file twice and no unbounded read happens.
  let report: RunReport;
  try {
    const reviewer = await load(definition.artifact, {
      ...(profileFile === undefined
        ? {}
        : {
            profile: profileFile.path,
            files: readAccess(new Map([[profileFile.path, profileFile.text]])),
          }),
    });
    report = await reviewer.run(
      {
        id: caseFile.caseId,
        input: caseFile.artifact.input as Readonly<Record<string, JSONValue>>,
      },
      { mode: invocation.mode },
    );
  } catch (error) {
    throw withCliBoundary(error);
  }
  if (invocation.out !== undefined) {
    await writeArtifact(invocation.out, report);
  }
  const text =
    invocation.format === "json"
      ? JSON.stringify(report, null, 2)
      : renderRunReport(definition.artifact, report);
  context.io.writeOut(`${text}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// inspect: one profile through the shared renderer.
// ---------------------------------------------------------------------------

/** Renders one profile summary or its stored artifact. */
async function inspectCommand(
  invocation: Extract<CliInvocation, { readonly command: "inspect" }>,
  context: CommandContext,
): Promise<number> {
  const file = await readProfileFile(invocation.profile);
  const text =
    invocation.format === "json"
      ? JSON.stringify(file.artifact, null, 2)
      : renderProfileSummary(file.artifact, {
          detail: invocation.detail === "detailed" ? "detail" : "summary",
        });
  context.io.writeOut(`${text}\n`);
  return 0;
}

/** Renders one failure on the diagnostic stream and returns its exit code. */
function reportFailure(io: CliIo, format: CliFormat, error: unknown): number {
  const failure = asCliFailure(error);
  if (format === "json") {
    io.writeErr(
      `${JSON.stringify({
        tool: "measuretwice",
        error: {
          code: failure.code,
          message: failure.message,
          field_path: failure.fieldPath,
        },
      })}\n`,
    );
    return failure.exit;
  }
  io.writeErr(`measuretwice: ${failure.code}: ${failure.message}\n`);
  return failure.exit;
}

/** Reads one thrown failure as one CLI failure, without losing one cause. */
function asCliFailure(error: unknown): CliFailure {
  const mapped = cliFailureOf(error);
  if (mapped instanceof CliFailure) {
    return mapped;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliFailure(
    "internal_error",
    `The command hit one internal error: ${message}. Report this failure with the command line.`,
    { exit: 1, cause: error },
  );
}

/** Reads the package version through one require of the manifest. */
function packageVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest = require("../package.json") as { version: string };
  return manifest.version;
}

// ---------------------------------------------------------------------------
// The entry point.
// ---------------------------------------------------------------------------

/** True when Node runs this module as the program, through one symlink or not. */
function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
