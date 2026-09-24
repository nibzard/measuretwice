// SPDX-License-Identifier: Apache-2.0
/**
 * `load` and the exact-rule run path.
 *
 * `load` binds one validated definition to one profile and returns one
 * reviewer. The definition is a trusted import, the result of
 * `defineChecks`, or one explicit path to a JSON definition file. The
 * optional profile is one explicit path to a JSON profile file. Loaders
 * accept `.json` paths only. They load no YAML and execute no TypeScript
 * source, as the reason code `unsupported_format` states.
 *
 * `run` assesses one case through the Rust core only: case validation with
 * input projection, the exact string rules, the run state boundary, and the
 * frozen run report. Question checks need one registered evaluator. No
 * evaluator registration exists in this delivery, so `run` rejects a
 * definition with one question check before any work starts.
 *
 * The wrapper owns the boundaries that the core does not. File access, the
 * clock, and the run identifiers arrive as load options, so tests and hosts
 * inject their own. The wrapper stores no report, reads no credential, and
 * takes no application action. The host consumes the report and decides.
 *
 * Failure behavior: every invalid artifact, invalid case, and incompatible
 * binding throws one public {@link ValidationError} with a stable reason
 * code and a field path, before any execution. An unreadable file throws one
 * ordinary `Error` that names the path and keeps the cause, because file
 * access is host territory, not contract validation.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DefinedChecks, Definition, ExactRule, JSONValue } from "./define-checks.js";
import { ValidationError } from "./error.js";
import {
  NativeFailure,
  nativeAssessRuleChecks,
  nativeComputeSelfHash,
  nativeCreateRunState,
  nativeValidateCase,
  nativeValidateDefinition,
  nativeVerifySelfHash,
  runAcceptResult,
  runComplete,
  runStartAttempt,
  type DefinitionInfo,
} from "./native.js";

// ---------------------------------------------------------------------------
// Public types of the run path.
// ---------------------------------------------------------------------------

/** How the host declared one run. The mode changes no record content. */
export type RunMode = "shadow" | "enforcement";

/** The outcome of one check. */
export type CheckOutcome = "pass" | "fail" | "review" | "error" | "skipped";

/** The derived outcome of one case. */
export type AggregateOutcome = "pass" | "fail" | "review" | "error";

/** The terminal execution status of one run. */
export type CompletionStatus = "completed" | "cancelled" | "deadline_exceeded";

/** One sanitized reason of one check record. */
export interface SanitizedReason {
  /** Stable reason code from the published registry. */
  readonly code: string;
  /** Short sanitized cause. */
  readonly message: string;
  /** JSON Pointer to the rejected field, for one validation failure. */
  readonly field_path?: string;
}

/** The exact rule keyword of one executed rule. */
export type RuleKeyword = "maxLength" | "includes" | "excludes";

/** The executed rule of one rule record. */
export interface AppliedRuleRecord {
  /** The rule keyword that ran. */
  readonly rule: RuleKeyword;
  /** The one input that the rule read. */
  readonly input: string;
  /** The executed parameter. */
  readonly parameters: ExactRule;
}

/** The evaluator versions that served one check execution. */
export interface EvaluatorVersionsRecord {
  /** Registered evaluator identifier. */
  readonly id: string;
  /** Version of the adapter that made the call. */
  readonly adapter_version: string;
  /** Model version that actually served the execution, when known. */
  readonly model_resolved?: string;
}

/** One component record of one run report. */
export interface RunCheckRecord {
  /** The assessed check identifier. */
  readonly check: string;
  /** Whether one question or one rule was assessed. */
  readonly kind: "question" | "rule";
  /** The outcome of this check. */
  readonly outcome: CheckOutcome;
  /** The raw measurement of one question check, exactly as returned. */
  readonly assessment?: Readonly<Record<string, JSONValue>>;
  /** The executed rule of one rule check. */
  readonly applied_rule?: AppliedRuleRecord;
  /** The executed policy parameters of one question check. */
  readonly applied_policy?: Readonly<{
    readonly accept_cutoff: number;
    readonly rejection_cutoff: number;
    readonly confidence_floor?: number;
  }>;
  /** The evaluator versions that served this check. */
  readonly evaluator?: EvaluatorVersionsRecord;
  /** Attempts made, including retries. Present when the check needed more than one. */
  readonly attempts?: number;
  /** Timing of this execution. */
  readonly timing?: Readonly<{ readonly queued_ms?: number; readonly execution_ms?: number }>;
  /** Usage amounts that this execution reported. */
  readonly usage?: Readonly<Record<string, number>>;
  /** Sanitized reason, required for `error` and `skipped` outcomes. */
  readonly reason?: SanitizedReason;
}

/** The immutable report of one assessed case. Plain JSON data. */
export interface RunReport {
  /** The portable contract schema version. */
  readonly schema_version: 1;
  /** Identifier of this run, drawn from the injected identifier source. */
  readonly run_id: string;
  /** How the host declared this run. */
  readonly mode: RunMode;
  /** The definition that produced the checks. */
  readonly definition: Readonly<{ readonly name: string; readonly content_hash: string }>;
  /** The profile that the run bound. */
  readonly profile: Readonly<{ readonly id: string; readonly content_hash: string }>;
  /** The assessed case. */
  readonly case: Readonly<{ readonly id: string; readonly input_hash: string }>;
  /** The shadow baseline, in shadow mode. */
  readonly baseline?: Readonly<{ readonly outcome: string; readonly revision: string }>;
  /** One record per defined check, in definition order. */
  readonly checks: readonly RunCheckRecord[];
  /** The derived aggregate outcome. */
  readonly aggregate: Readonly<{
    readonly outcome: AggregateOutcome;
    readonly explanation?: string;
  }>;
  /** The terminal execution status. */
  readonly completion: Readonly<{
    readonly status: CompletionStatus;
    readonly completed_at?: string;
  }>;
  /** The run totals. */
  readonly totals?: Readonly<{
    readonly elapsed_ms?: number;
    readonly usage?: Readonly<Record<string, number>>;
  }>;
}

/** One case for `run`: a stable identifier and the complete input object. */
export interface RunCase<TInput> {
  /** Stable case identifier. */
  readonly id: string;
  /** The complete input object. Rust validates it against the definition. */
  readonly input: TInput;
}

/** The options of one run. */
export interface RunOptions {
  /** How the host declares the run. The default is `shadow`. */
  readonly mode?: RunMode;
}

/** Reads one file as UTF-8 text. The default reads through Node file APIs. */
export interface FileAccess {
  /** Returns the complete text of one file.
   * @param path The explicit file path to read. */
  read(path: string): Promise<string>;
}

/** The options of `load`. */
export interface LoadOptions {
  /** One explicit path to a JSON profile file. Optional. */
  readonly profile?: string;
  /** The file access that reads the stated paths. The default uses Node APIs. */
  readonly files?: FileAccess;
  /** The clock of the wrapper, in epoch milliseconds. The default reads the system clock. */
  readonly now?: () => number;
  /** The identifier source of runs. The default draws one random identifier. */
  readonly nextRunId?: () => string;
}

/** The origin of one profile. */
export type ProfileOrigin = "exploration" | "calibration" | "exact";

/** The decision-rule family of one profile. */
export type PolicyFamily = "probability_mass_v0" | "exact";

/** The qualification status of one profile. */
export type QualificationStatus =
  | "unvalidated"
  | "insufficient_evidence"
  | "criteria_not_met"
  | "validated_for_scope";

/** The effective execution configuration of one profile. */
export interface ExecutionConfig {
  /** Maximum check executions active at one time. */
  readonly max_active: number;
  /** Maximum check executions waiting. */
  readonly max_pending: number;
  /** Total deadline of one case, in milliseconds. */
  readonly deadline_ms: number;
  /** Attempts per check, counting the first attempt. */
  readonly max_attempts: number;
  /** Base backoff delay between attempts, in milliseconds. */
  readonly backoff_ms: number;
}

/** One evaluator binding of one profile. */
export interface ProfileBinding {
  /** The bound check. */
  readonly check: string;
  /** The registered evaluator identifier. */
  readonly evaluator: string;
  /** The adapter version of the binding. */
  readonly adapter_version: string;
  /** The complete translated question. */
  readonly translation: Readonly<{ readonly content_hash: string; readonly question: string }>;
  /** The requested model and its resolved version, when known. */
  readonly model?: Readonly<{ readonly requested: string; readonly resolved?: string }>;
  /** The preprocessing identity, when one applies. */
  readonly preprocessing?: string;
}

/**
 * One profile artifact that a reviewer bound.
 *
 * The type states the fields that the wrapper reads and writes. The stored
 * artifact keeps every field it holds. Full profile validation belongs to
 * the Rust core and arrives with its own task.
 */
export interface Profile {
  /** The portable contract schema version. */
  readonly schema_version: 1;
  /** Stable profile identifier. */
  readonly id: string;
  /** The profile origin. */
  readonly origin: ProfileOrigin;
  /** The declared population and scope. */
  readonly intended_use: string;
  /** The definition that this profile binds. */
  readonly definition: Readonly<{ readonly name: string; readonly content_hash: string }>;
  /** One entry per question check. Empty for an exact-only definition. */
  readonly bindings: readonly ProfileBinding[];
  /** The decision-rule family and its parameters. */
  readonly policy: Readonly<{
    readonly family: PolicyFamily;
    readonly checks?: readonly Readonly<{
      readonly check: string;
      readonly accept_cutoff: number;
      readonly rejection_cutoff: number;
      readonly confidence_floor?: number;
    }>[];
  }>;
  /** The effective execution configuration. */
  readonly execution: ExecutionConfig;
  /** The qualification of the profile. */
  readonly qualification: Readonly<{
    readonly status: QualificationStatus;
    readonly scope?: string;
    readonly reasons: readonly string[];
  }>;
  /** The verified self-hash of the artifact. */
  readonly content_hash: string;
}

/** One loaded definition, bound to one profile, that assesses cases. */
export interface Reviewer<TInput> {
  /** The validated definition artifact. */
  readonly definition: Definition;
  /** The definition-domain content hash of the artifact. */
  readonly definitionHash: string;
  /** The bound profile artifact. Absent while no registered evaluator can serve the definition. */
  readonly profile: Profile | undefined;
  /**
   * Assesses one case and returns the frozen run report.
   *
   * @throws {ValidationError} when the case breaks the contract, when the
   * definition holds one question check that no registered evaluator serves,
   * or when enforcement mode meets one profile without one validated
   * qualification. Every failure happens before execution.
   */
  run(caseInput: RunCase<TInput>, options?: RunOptions): Promise<RunReport>;
}

// ---------------------------------------------------------------------------
// Wrapper boundaries.
// ---------------------------------------------------------------------------

/** The default file access: UTF-8 reads through the Node file APIs. */
const defaultFiles: FileAccess = {
  async read(path: string): Promise<string> {
    return readFile(path, "utf8");
  },
};

/** Draws one default run identifier. Inject `nextRunId` for a stable sequence. */
function defaultRunId(): string {
  return `run-${randomUUID()}`;
}

/** Runs one core operation and rethrows its failure as the public error. */
function throughCore<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof NativeFailure) {
      throw new ValidationError(error.code, error.message, error.fieldPath);
    }
    throw error;
  }
}

/** Serializes one artifact and rejects what JSON cannot preserve. */
function jsonText(value: unknown, fieldPath: string): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new ValidationError(
      "nonportable_value",
      `The value ${fieldPath === "" ? "at the root" : `at ${fieldPath}`} holds one value that JSON cannot preserve: ${error instanceof Error ? error.message : String(error)}. Pass one JSON value.`,
      fieldPath,
    );
  }
}

/** Returns true when the value is one plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reads one own field of one plain object. */
function field(object: Record<string, unknown>, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, name) ? object[name] : undefined;
}

/** Reads one required field and reports its pointer on absence. */
function requiredField(object: Record<string, unknown>, name: string, base: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, name)) {
    throw new ValidationError(
      "missing_field",
      `The artifact omits the field ${base}/${name}.`,
      `${base}/${name}`,
    );
  }
  return object[name];
}

/** Reads one required nonempty string. */
function requiredString(object: Record<string, unknown>, name: string, base: string): string {
  const value = requiredField(object, name, base);
  if (typeof value !== "string" || value === "") {
    throw new ValidationError(
      "invalid_field_type",
      `The field ${base}/${name} must hold one nonempty string.`,
      `${base}/${name}`,
    );
  }
  return value;
}

/** Reads one required string that must name one word of one fixed set. */
function requiredWord<T extends string>(
  object: Record<string, unknown>,
  name: string,
  base: string,
  words: readonly T[],
): T {
  const value = requiredString(object, name, base);
  if (!words.includes(value as T)) {
    throw new ValidationError(
      "invalid_field_type",
      `The field ${base}/${name} must hold one of ${words.join(", ")}.`,
      `${base}/${name}`,
    );
  }
  return value as T;
}

/** Reads one required object. */
function requiredObject(
  object: Record<string, unknown>,
  name: string,
  base: string,
): Record<string, unknown> {
  const value = requiredField(object, name, base);
  if (!isPlainObject(value)) {
    throw new ValidationError(
      "invalid_field_type",
      `The field ${base}/${name} must hold one object.`,
      `${base}/${name}`,
    );
  }
  return value;
}

/** Reads one required whole number inside its bounds. */
function requiredWholeNumber(
  object: Record<string, unknown>,
  name: string,
  base: string,
  minimum: number,
  maximum?: number,
): number {
  const value = requiredField(object, name, base);
  const within =
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    (maximum === undefined || value <= maximum);
  if (!within) {
    throw new ValidationError(
      "invalid_field_type",
      `The field ${base}/${name} must hold one whole number ${
        maximum === undefined ? `of at least ${minimum}` : `from ${minimum} to ${maximum}`
      }.`,
      `${base}/${name}`,
    );
  }
  return value;
}

/** Rejects one path that names no JSON file. */
function requireJsonPath(filePath: string, fieldPath: string): void {
  if (!filePath.endsWith(".json")) {
    throw new ValidationError(
      "unsupported_format",
      `The path ${JSON.stringify(filePath)} names no JSON file. Loaders accept explicit .json paths only: they load no YAML and execute no TypeScript source. Export the artifact with one trusted application script first.`,
      fieldPath,
    );
  }
}

/** Reads one file through the injected access and keeps the cause of one failure. */
async function readText(files: FileAccess, filePath: string): Promise<string> {
  try {
    return await files.read(filePath);
  } catch (cause) {
    throw new Error(
      `measuretwice cannot read the path ${JSON.stringify(filePath)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** Formats one terminal time from the injected clock, in RFC 3339 UTC. */
function terminalTime(now: () => number): string {
  const value = now();
  try {
    return new Date(value).toISOString();
  } catch {
    throw new Error(`measuretwice received one invalid clock value: ${value}`);
  }
}

/** Freezes one JSON value deeply. Mirrors the twin in `define-checks.ts`. */
function deepFreeze(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    Object.freeze(value);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
}

// ---------------------------------------------------------------------------
// Profile binding.
// ---------------------------------------------------------------------------

/** The execution configuration of one synthesized exact profile. */
const EXACT_EXECUTION: ExecutionConfig = {
  max_active: 4,
  max_pending: 16,
  deadline_ms: 30000,
  max_attempts: 1,
  backoff_ms: 0,
};

/** Names one structural exact profile after its definition. */
function exactProfileId(name: string, definitionHash: string): string {
  const id = `${name}-exact`;
  // The artifact identifier rule bounds the length at 64 characters.
  return id.length <= 64 ? id : `exact-${definitionHash.slice(0, 58)}`;
}

/**
 * Derives the structural exact profile of one exact-only definition.
 *
 * The contracts fix this shape: origin `exact`, policy family `exact`, no
 * evaluator bindings, and the definition hash. No calibration plan, dataset,
 * or evaluation report applies, because no measured error source exists. The
 * qualification states the structural basis. It makes no claim about the
 * quality of the requirement.
 */
function synthesizeExactProfile(info: DefinitionInfo): Profile {
  const artifact: Omit<Profile, "content_hash"> = {
    schema_version: 1,
    id: exactProfileId(info.name, info.definitionHash),
    origin: "exact",
    intended_use: `Exact rules of the definition ${info.name}. No stochastic calibration applies.`,
    definition: { name: info.name, content_hash: info.definitionHash },
    bindings: [],
    policy: { family: "exact" },
    execution: EXACT_EXECUTION,
    qualification: {
      status: "validated_for_scope",
      scope:
        "Any input that satisfies the definition input schema. The reason records one structural basis, not one quality claim about the requirement.",
      reasons: ["exact_rules_only"],
    },
  };
  const contentHash = throughCore(() =>
    nativeComputeSelfHash("profile", JSON.stringify(artifact)),
  );
  const profile: Profile = { ...artifact, content_hash: contentHash };
  deepFreeze(profile);
  return profile;
}

/**
 * Reads one bound profile artifact.
 *
 * The wrapper verifies the self-hash through the core first, so the text is
 * the artifact that its generator signed. This reader then checks only the
 * fields of the binding. Full profile validation belongs to the Rust core.
 */
function readProfileArtifact(text: string): Profile {
  const value: unknown = JSON.parse(text);
  if (!isPlainObject(value)) {
    throw new ValidationError(
      "invalid_field_type",
      "The profile artifact must hold one JSON object.",
      "/profile",
    );
  }
  if (value["schema_version"] !== 1) {
    throw new ValidationError(
      "unsupported_schema_version",
      "The profile states one schema version that this package does not support. The v0 contracts use version 1.",
      "/profile/schema_version",
    );
  }
  requiredString(value, "id", "/profile");
  requiredWord(value, "origin", "/profile", ["exploration", "calibration", "exact"] as const);
  requiredString(value, "intended_use", "/profile");
  const bound = requiredObject(value, "definition", "/profile");
  requiredString(bound, "name", "/profile/definition");
  requiredString(bound, "content_hash", "/profile/definition");
  const policyMap = requiredObject(value, "policy", "/profile");
  requiredWord(policyMap, "family", "/profile/policy", ["probability_mass_v0", "exact"] as const);
  const executionMap = requiredObject(value, "execution", "/profile");
  requiredWholeNumber(executionMap, "max_active", "/profile/execution", 1);
  requiredWholeNumber(executionMap, "max_pending", "/profile/execution", 0);
  requiredWholeNumber(executionMap, "deadline_ms", "/profile/execution", 1);
  requiredWholeNumber(executionMap, "max_attempts", "/profile/execution", 1, 10);
  requiredWholeNumber(executionMap, "backoff_ms", "/profile/execution", 0);
  const qualificationMap = requiredObject(value, "qualification", "/profile");
  requiredWord(qualificationMap, "status", "/profile/qualification", [
    "unvalidated",
    "insufficient_evidence",
    "criteria_not_met",
    "validated_for_scope",
  ] as const);
  requiredString(value, "content_hash", "/profile");
  const rawBindings = field(value, "bindings");
  if (rawBindings !== undefined) {
    if (!Array.isArray(rawBindings)) {
      throw new ValidationError(
        "invalid_field_type",
        "The field /profile/bindings must hold one array.",
        "/profile/bindings",
      );
    }
    for (const [index, entry] of rawBindings.entries()) {
      const base = `/profile/bindings/${index}`;
      if (!isPlainObject(entry)) {
        throw new ValidationError(
          "invalid_field_type",
          `Every entry of /profile/bindings must hold one object.`,
          base,
        );
      }
      requiredString(entry, "check", base);
      requiredString(entry, "evaluator", base);
    }
  }
  // The stored artifact keeps every field. The reads above check the fields
  // of the binding; full profile validation belongs to the Rust core.
  deepFreeze(value);
  return value as unknown as Profile;
}

/** Builds the failure of one profile that binds another definition. */
function definitionMismatch(profile: Profile, info: DefinitionInfo): ValidationError {
  if (profile.definition.name !== info.name) {
    return new ValidationError(
      "definition_mismatch",
      `The profile binds the definition ${JSON.stringify(profile.definition.name)}, but the loaded definition is ${JSON.stringify(info.name)}. Bind the profile that this definition produced.`,
      "/profile/definition",
    );
  }
  return new ValidationError(
    "definition_mismatch",
    `The profile binds another content revision of the definition ${JSON.stringify(info.name)}: the content hash differs from the loaded definition. Bind the profile of this revision.`,
    "/profile/definition",
  );
}

/**
 * Checks the structural compatibility of one bound profile.
 *
 * The order matches the compatibility fixtures of the shared states: an
 * exact-only definition checks the policy family first; a definition with
 * question checks verifies the definition binding first.
 */
function checkCompatibility(profile: Profile, info: DefinitionInfo): void {
  const binds =
    profile.definition.name === info.name &&
    profile.definition.content_hash === info.definitionHash;
  if (info.isExactOnly) {
    const structural =
      profile.policy.family === "exact" &&
      profile.origin === "exact" &&
      profile.bindings.length === 0;
    if (!structural) {
      throw new ValidationError(
        "policy_mismatch",
        "An exact-only definition takes the structural exact profile: origin exact, policy family exact, and no evaluator bindings.",
        "/profile/policy",
      );
    }
    if (!binds) {
      throw definitionMismatch(profile, info);
    }
    return;
  }
  if (!binds) {
    throw definitionMismatch(profile, info);
  }
  if (profile.policy.family === "exact" || profile.origin === "exact") {
    throw new ValidationError(
      "policy_mismatch",
      "One definition with question checks takes one profile with evaluator bindings, not the exact policy family.",
      "/profile/policy",
    );
  }
  if (profile.bindings.length > 0) {
    const binding = profile.bindings[0]!;
    // Evaluator registration arrives with its own task. Until it exists,
    // every bound evaluator reference names one unknown evaluator.
    throw new ValidationError(
      "evaluator_mismatch",
      `The profile binds the evaluator ${JSON.stringify(binding.evaluator)} for the check ${JSON.stringify(binding.check)}, but no evaluator is registered. Evaluator registration arrives with its own task.`,
      "/profile/bindings/0/evaluator",
    );
  }
}

// ---------------------------------------------------------------------------
// load and run.
// ---------------------------------------------------------------------------

/**
 * Loads one definition and returns the reviewer that runs its cases.
 *
 * Pass the result of `defineChecks` as one trusted import, or one explicit
 * path to a JSON definition file. An optional `profile` path binds one JSON
 * profile file. Without one, an exact-only definition receives its derived
 * structural exact profile, which `reviewer.profile` exposes for host
 * persistence.
 *
 * @throws {ValidationError} when one path names no JSON file, when one
 * artifact fails the core validation or its self-hash, or when one supplied
 * profile is incompatible with the definition.
 * @throws {Error} when one stated path stays unreadable.
 */
export function load<TCaseInput>(
  definition: DefinedChecks<TCaseInput>,
  options?: LoadOptions,
): Promise<Reviewer<TCaseInput>>;
export function load(
  definition: Definition | string,
  options?: LoadOptions,
): Promise<Reviewer<Readonly<Record<string, JSONValue>>>>;
export async function load(
  definition: Definition | string,
  options: LoadOptions = {},
): Promise<Reviewer<unknown>> {
  const files = options.files ?? defaultFiles;
  const now = options.now ?? Date.now;
  const nextRunId = options.nextRunId ?? defaultRunId;

  let definitionText: string;
  let artifact: Definition | undefined;
  if (typeof definition === "string") {
    requireJsonPath(definition, "/definition");
    definitionText = await readText(files, definition);
  } else {
    definitionText = jsonText(definition, "");
    artifact = definition;
  }
  // The core is the one validation authority for both input shapes.
  const info = throughCore(() => nativeValidateDefinition(definitionText));
  if (artifact === undefined) {
    const parsed: unknown = JSON.parse(definitionText);
    deepFreeze(parsed);
    artifact = parsed as Definition;
  }

  let profile: Profile | undefined;
  if (options.profile !== undefined) {
    requireJsonPath(options.profile, "/profile");
    const profileText = await readText(files, options.profile);
    throughCore(() => nativeVerifySelfHash("profile", profileText));
    profile = readProfileArtifact(profileText);
    checkCompatibility(profile, info);
  } else if (info.isExactOnly) {
    profile = synthesizeExactProfile(info);
  }

  return Object.freeze({
    definition: artifact,
    definitionHash: info.definitionHash,
    profile,
    async run(caseInput: RunCase<unknown>, runOptions: RunOptions = {}): Promise<RunReport> {
      const mode = runOptions.mode ?? "shadow";
      if (mode !== "shadow" && mode !== "enforcement") {
        throw new ValidationError(
          "invalid_field_type",
          "The run mode must be shadow or enforcement.",
          "/mode",
        );
      }
      // No evaluator registration exists in this delivery, so no question
      // check can run. The gate fires before any case work starts.
      const questionIndex = info.checkKinds.findIndex((entry) => entry.kind !== "rule");
      if (questionIndex >= 0) {
        const checkId = info.checkKinds[questionIndex]!.id;
        throw new ValidationError(
          "evaluator_mismatch",
          `The check ${JSON.stringify(checkId)} puts one question to an evaluator, but no evaluator is registered for this definition. Evaluator registration arrives with its own task; exact rules run today.`,
          `/checks/${questionIndex}`,
        );
      }
      // Every exact-only definition holds one profile, and the gate above
      // returned for every other definition.
      const bound = profile as Profile;
      if (mode === "enforcement" && bound.qualification.status !== "validated_for_scope") {
        throw new ValidationError(
          "qualification_insufficient",
          `The profile ${JSON.stringify(bound.id)} holds the qualification ${bound.qualification.status}. Enforcement needs one profile validated for the declared scope.`,
          "/profile/qualification/status",
        );
      }

      const caseText = jsonText(caseInput, "");
      const caseInfo = throughCore(() => nativeValidateCase(definitionText, caseText));
      const caseReference = JSON.stringify({
        id: caseInfo.id,
        input_hash: caseInfo.inputHash,
      });
      const profileReference = JSON.stringify({
        id: bound.id,
        content_hash: bound.content_hash,
      });
      const runState = throughCore(() =>
        nativeCreateRunState(
          definitionText,
          caseReference,
          profileReference,
          nextRunId(),
          mode,
          bound.execution.max_attempts,
        ),
      );
      const rules = throughCore(() => nativeAssessRuleChecks(definitionText, caseText));
      for (const rule of rules) {
        throughCore(() => runStartAttempt(runState, rule.check, caseReference, profileReference));
        throughCore(() => runAcceptResult(runState, rule.check, rule.record));
      }
      throughCore(() => runComplete(runState, terminalTime(now)));
      const reportText = runState.reportText();
      if (reportText === null) {
        throw new Error("measuretwice reached no terminal run state.");
      }
      const report: unknown = JSON.parse(reportText);
      deepFreeze(report);
      return report as RunReport;
    },
  });
}
