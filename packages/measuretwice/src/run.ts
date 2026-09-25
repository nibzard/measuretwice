// SPDX-License-Identifier: Apache-2.0
/**
 * `load` and the run path: exact rules, question checks, and reports.
 *
 * `load` binds one validated definition to one profile and returns one
 * reviewer. The definition is a trusted import, the result of
 * `defineChecks`, or one explicit path to a JSON definition file. The
 * optional profile is one explicit path to a JSON profile file. Loaders
 * accept `.json` paths only. They load no YAML and execute no TypeScript
 * source, as the reason code `unsupported_format` states.
 *
 * One bound profile may name evaluators. The Rust core validates the
 * complete profile contract, its stored self-hash, and its compatibility
 * with the loaded definition: the evaluator references and their adapter
 * versions, the policy family and coverage, the translated questions of the
 * adapters that expose one, and the preprocessing identities. One unknown
 * reference, one changed version, or one changed translation fails `load`
 * with one compatibility reason code before any execution. One loaded file
 * cannot install one evaluator.
 *
 * `run` assesses one case through the complete path: the core validates the
 * case and projects each check's authorized inputs, the scheduler of
 * `scheduler.ts` bounds every attempt inside the effective execution
 * configuration of the profile, exact rules execute in the Rust core, and
 * every question check dispatches through its registered evaluator. The
 * core validates each returned assessment, decides it under the selected
 * `probability_mass_v0` parameters of the profile, and builds the record
 * with the assessment, the applied policy, the evaluator versions, the
 * timing, and the usage. One enforcement run repeats the compatibility
 * check of the core in enforcement mode first, so the declared scope, the
 * qualification clause, and the host-selection clause all refuse before
 * any case work starts: enforcement needs one profile validated for the
 * requested scope that the host selected by its reviewed content hash
 * through `selectedProfileHash`. No run promotes one profile, changes one
 * qualification, or selects one profile for the host. A definition
 * with one question check and no bound profile refuses the run before any
 * work starts, because no policy states how its answers decide.
 *
 * The wrapper owns the boundaries that the core does not. File access, the
 * clock, the run identifiers, and the deadline timer arrive as load or run
 * options, so tests and hosts inject their own. The wrapper stores no
 * report, reads no credential, and takes no application action. The host
 * consumes the report and decides.
 *
 * Private-data defaults: one report states no raw case content and no
 * credential. The case crosses as its identifier and its input hash alone,
 * every request keeps only the projected inputs of its `using` list, and
 * sanitized reasons keep the operational cause without one provider echo.
 * Replay runs through host storage: the host states one reference to its
 * own stored snapshot with the `snapshot` option, the report records it as
 * `case.snapshot`, and the wrapper itself persists no input, no report, and
 * no retention.
 *
 * Shadow integration: one shadow run records the new outcome beside the
 * existing decision of the host, and the existing decision path stays
 * untouched. The host states its decision and the revision of its path
 * through the `baseline` option, the report records both under `baseline`
 * exactly as stated, and no library code reads the baseline, compares it
 * with the new outcome, or acts on either. One shadow failure, review,
 * skip, or error is one record of the report, never one change to the host
 * decision. Agreement with the baseline is one more observation, not one
 * correctness claim, so the report holds no field that combines the two
 * outcomes. `run` is one awaited call: it holds its caller until the run
 * reaches one terminal state, its added latency is bounded by the total
 * deadline of the profile, and every check record states its queue wait and
 * its execution time. The library starts no detached job and owns no
 * background scheduler, so nonblocking shadow work runs through one queue
 * that the host owns: the host stores the case and its baseline, one worker
 * of the host awaits `run`, and the host persists the returned report.
 *
 * Failure behavior: every invalid artifact, invalid case, and incompatible
 * binding throws one public {@link ValidationError} with a stable reason
 * code and a field path, before any execution. One execution failure
 * becomes one component record: an operational failure records its error
 * after the bounded retries of the scheduler, and one assessment that the
 * selected policy cannot decide records one `invalid_assessment` error that
 * keeps the cause of the core refusal, because one retry returns through
 * the same answer. An unreadable file throws one ordinary `Error` that
 * names the path and keeps the cause, because file access is host
 * territory, not contract validation.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DefinedChecks, Definition, ExactRule, JSONValue } from "./define-checks.js";
import type { EvaluatorRegistry } from "./evaluator.js";
import { dispatchAssessment, validatedQuestion } from "./evaluator.js";
import { ValidationError } from "./error.js";
import {
  NativeFailure,
  nativeAssessRuleChecks,
  nativeCheckProfileCompatibility,
  nativeComputeSelfHash,
  nativeCreateRunState,
  nativeDecideQuestionCheck,
  nativeValidateCase,
  nativeValidateDefinition,
  nativeValidateProfile,
  nativeVerifySelfHash,
  type DefinitionInfo,
  type LiveBindingEntry,
} from "./native.js";
import {
  scheduleRun,
  type ScheduledAttempt,
  type ScheduledRecord,
  type ScheduledResolution,
} from "./scheduler.js";

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
  readonly case: Readonly<{
    readonly id: string;
    readonly input_hash: string;
    /**
     * The host-controlled reference to the host-stored snapshot of the case
     * input, for replay. Present only when the host stated one. The report
     * holds no raw case content.
     */
    readonly snapshot?: string;
  }>;
  /**
   * The shadow baseline, in shadow mode. The existing decision of the host
   * and the revision of its decision path, recorded beside the new outcome.
   * Agreement with the baseline is not correctness.
   */
  readonly baseline?: ShadowBaseline;
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

/**
 * The shadow baseline of one run: the existing decision of the host.
 *
 * The host states what its own decision path already decided and which
 * revision of that path made the decision. The run records both beside the
 * new outcome, and the two facts stay separate: agreement with the baseline
 * is not correctness, because the baseline is one more measurement, not one
 * reference answer. The library computes no agreement, states no accuracy,
 * and takes no action on the baseline. The host owns the meaning of its own
 * decision vocabulary, so the outcome stays one free string.
 */
export interface ShadowBaseline {
  /** The existing decision of the host decision path, 1 to 64 characters. */
  readonly outcome: string;
  /** The revision of the existing decision path, 1 to 128 characters. */
  readonly revision: string;
}

/** The options of one run. */
export interface RunOptions {
  /** How the host declares the run. The default is `shadow`. */
  readonly mode?: RunMode;
  /**
   * The existing decision that the host decision path already made, recorded
   * beside the new outcome as `baseline` of the report. Shadow mode alone
   * accepts one: an enforcement run refuses the option with
   * `invalid_field_type` at `/baseline`, because it holds no existing
   * decision to record. The core validates the shape and the bounds before
   * any work starts, and one run without the option states no field.
   * Agreement with the baseline is not correctness. Optional.
   */
  readonly baseline?: ShadowBaseline;
  /**
   * The reviewed profile content hash that the host selected for
   * enforcement, through its own code or configuration review. Enforcement
   * mode requires it: the run refuses with `profile_not_selected` when the
   * option is absent or names another hash, because the library never
   * selects one profile for the host. Shadow runs state no gate, so the
   * option changes nothing there. Optional.
   */
  readonly selectedProfileHash?: string;
  /**
   * The use scope that this run requests. Enforcement compares it with the
   * declared scope of the profile and refuses with `scope_mismatch` when
   * the two differ, because one hash cannot detect population drift.
   * Optional.
   */
  readonly scope?: string;
  /**
   * The cancellation signal of the caller. The run cancels when it aborts:
   * every in-flight adapter receives the abort, queued work records one
   * skip, and the report freezes with completion status `cancelled`.
   * Optional.
   */
  readonly signal?: AbortSignal;
  /**
   * The host-controlled reference to the host-stored snapshot of the case
   * input, recorded as `case.snapshot` of the report so one replay can find
   * the content through host storage. The wrapper persists no input and
   * copies no case content into any report, so replay needs this reference
   * and the stored report, never a copy inside it. One string of 1 to 256
   * characters. Optional.
   */
  readonly snapshot?: string;
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
  /** The registered evaluators that one bound profile may refer to. Optional. */
  readonly evaluators?: EvaluatorRegistry;
  /** The file access that reads the stated paths. The default uses Node APIs. */
  readonly files?: FileAccess;
  /** The clock of the wrapper, in epoch milliseconds. The default reads the system clock. */
  readonly now?: () => number;
  /** The identifier source of runs. The default draws one random identifier. */
  readonly nextRunId?: () => string;
  /**
   * Arms one wake-up at one epoch-millisecond instant, and returns one
   * operation that cancels the wake-up. Runs use it for the total deadline
   * of the effective execution configuration. The default arms one Node
   * timer for the remaining time of the clock. Controlled-clock tests
   * inject one timer queue that fires when the clock advances. Optional.
   */
  readonly setTimer?: (atMs: number, onWake: () => void) => () => void;
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

/** The qualification evidence of one calibration profile. */
export interface ProfileEvidence {
  /** The calibration plan that stated the goals. */
  readonly plan?: Readonly<{ readonly id: string; readonly content_hash: string }>;
  /** The datasets that the plan referenced. */
  readonly datasets?: readonly Readonly<{
    readonly id: string;
    readonly revision: string;
    readonly content_hash: string;
  }>[];
  /** The splits that separated fitting from validation data. */
  readonly splits?: readonly Readonly<{ readonly id: string; readonly content_hash: string }>[];
  /** The summary of the label sources and their review status. */
  readonly label_provenance?: string;
  /** References to the evaluation reports in host-managed storage. */
  readonly evaluation_reports?: readonly string[];
  /** The interval methods, their assumptions, and their confidence level. */
  readonly statistical_method?: string;
}

/** One recorded performance metric with its counts and denominators. */
export interface ProfileMetric {
  /** Check identifier, or `all_checks` for the complete set. */
  readonly scope: string;
  /** Published metric name. */
  readonly metric: string;
  /** Observed count. */
  readonly numerator: number;
  /** Denominator of the rate. */
  readonly denominator: number;
  /** The rate, or `null` when the denominator holds zero. */
  readonly value: number | null;
}

/** One recorded uncertainty interval of one metric. */
export interface ProfileInterval {
  /** Check identifier, or `all_checks` for the complete set. */
  readonly scope: string;
  /** Published metric name. */
  readonly metric: string;
  /** Named interval method, validated against reference fixtures. */
  readonly method: string;
  /** Confidence level of the interval. */
  readonly confidence_level: number;
  /** Lower bound. */
  readonly lower: number;
  /** Upper bound. */
  readonly upper: number;
}

/** The observed performance recorded with one profile. */
export interface ProfilePerformance {
  /** The recorded metrics with their counts and denominators. */
  readonly metrics?: readonly ProfileMetric[];
  /** The recorded uncertainty intervals. */
  readonly intervals?: readonly ProfileInterval[];
  /** The sample counts by name. */
  readonly sample_counts?: Readonly<Record<string, number>>;
  /**
   * The plan's stated minimum sample counts by denominator name. Read beside
   * `sample_counts`, so one reviewer sees which counts met their limits.
   */
  readonly sample_minimums?: Readonly<Record<string, number>>;
  /** The per-slice limits, such as small denominators or missing slices. */
  readonly slice_limitations?: readonly string[];
}

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
  /** Base backoff delay between attempts, in milliseconds. The delay doubles after every retry. */
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
 * artifact keeps every field it holds, and the Rust core owns its complete
 * validation: every field rule, the cross-field origin rules, and the
 * stored self-hash.
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
  /**
   * The qualification evidence. The contract requires it in full for one
   * calibration origin. Absent while the profile records none.
   */
  readonly evidence?: ProfileEvidence;
  /**
   * The observed performance recorded with the profile, with its counts,
   * its denominators, and its limitations. Absent while the profile records
   * none.
   */
  readonly performance?: ProfilePerformance;
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
   * Exact rules execute in the Rust core. Question checks dispatch through
   * their registered evaluators inside the bounds of the effective
   * execution configuration of the profile, and the core validates, decides,
   * and records every answer. The report is reporting-only: it authorizes
   * no application action, whatever its mode and outcome.
   *
   * One shadow run changes no existing decision. The host states its
   * existing decision through {@link RunOptions.baseline}, and the report
   * records it beside the new outcome. The call is awaited: it returns when
   * the run reaches one terminal state, and its added latency stays inside
   * the total deadline of the profile.
   *
   * @throws {ValidationError} when the case breaks the contract, when the
   * definition holds one question check and no bound profile states its
   * decision policy, when enforcement mode meets one profile that the
   * compatibility gate refuses: one scope it does not declare, one
   * qualification below `validated_for_scope`, or one content hash that the
   * host did not select through {@link RunOptions.selectedProfileHash}, or
   * when one baseline reaches an enforcement run or breaks its bounds.
   * Every failure happens before execution.
   */
  run(caseInput: RunCase<TInput>, options?: RunOptions): Promise<RunReport>;
}

// ---------------------------------------------------------------------------
// Wrapper boundaries.
// ---------------------------------------------------------------------------

/** The default file access: UTF-8 reads through the Node file APIs. */
export const defaultFiles: FileAccess = {
  async read(path: string): Promise<string> {
    return readFile(path, "utf8");
  },
};

/** Draws one default run identifier. Inject `nextRunId` for a stable sequence. */
function defaultRunId(): string {
  return `run-${randomUUID()}`;
}

/** Runs one core operation and rethrows its failure as the public error. */
export function throughCore<T>(operation: () => T): T {
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
export function jsonText(value: unknown, fieldPath: string): string {
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

/** Rejects one path that names no JSON file. */
export function requireJsonPath(filePath: string, fieldPath: string): void {
  if (!filePath.endsWith(".json")) {
    throw new ValidationError(
      "unsupported_format",
      `The path ${JSON.stringify(filePath)} names no JSON file. Loaders accept explicit .json paths only: they load no YAML and execute no TypeScript source. Export the artifact with one trusted application script first.`,
      fieldPath,
    );
  }
}

/** Reads one file through the injected access and keeps the cause of one failure. */
export async function readText(files: FileAccess, filePath: string): Promise<string> {
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
export function deepFreeze(value: unknown): void {
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

/** The greatest length of one sanitized reason message, from the portable contracts. */
const MESSAGE_LIMIT = 500;

/** Shortens one message to the sanitized reason limit without splitting one pair of surrogates. */
function shorten(message: string): string {
  if (message.length <= MESSAGE_LIMIT) {
    return message;
  }
  return Array.from(message).slice(0, MESSAGE_LIMIT).join("");
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
 * The wrapper verifies the self-hash and the complete profile contract
 * through the core first, so the text is one artifact that its generator
 * signed and that no edit changed. This reader parses the validated text
 * and freezes it: the stored artifact keeps every field it holds.
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
  deepFreeze(value);
  return value as unknown as Profile;
}

/**
 * Builds the live evaluator state of one bound profile.
 *
 * One entry per bound check that one registered evaluator serves, so the
 * core can compare the binding: the registered identifier, the adapter
 * version, and the live translated question of every adapter that exposes
 * the optional `translate` operation. One changed translation then fails
 * with `translation_mismatch` before any execution. One loaded file cannot
 * install one evaluator, so one reference outside the registry supplies no
 * entry and the core reports it.
 */
/**
 * Builds the live evaluator state of one profile, one entry per bound
 * check. Internal to the package: the revision workflow of `revise.ts`
 * states the live identity of the prior profile through the same reader,
 * and the package entry point re-exports none of it.
 */
export function liveEvaluatorBindings(
  profile: Profile,
  info: DefinitionInfo,
  artifact: Definition,
  evaluators: EvaluatorRegistry | undefined,
): LiveBindingEntry[] {
  const live: LiveBindingEntry[] = [];
  for (const binding of profile.bindings ?? []) {
    const evaluator = evaluators?.get(binding.evaluator);
    if (evaluator === undefined) {
      // The core reports the unregistered reference with its field path.
      continue;
    }
    const entry: LiveBindingEntry = {
      check: binding.check,
      evaluator: evaluator.id,
      adapter_version: evaluator.adapter_version,
    };
    const kind = info.checkKinds.find((named) => named.id === binding.check);
    const check =
      kind !== undefined && kind.kind !== "rule"
        ? artifact.checks.find((named) => named.id === binding.check)
        : undefined;
    if (check !== undefined && typeof evaluator.translate === "function") {
      entry.translation = evaluator.translate(validatedQuestion(kind!.kind, check)).content_hash;
    }
    live.push(entry);
  }
  return live;
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
  const setTimer = options.setTimer;
  const evaluators = options.evaluators;

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
  let profileText: string | undefined;
  if (options.profile !== undefined) {
    requireJsonPath(options.profile, "/profile");
    const text = await readText(files, options.profile);
    // The core is the one validation authority: the stored self-hash first,
    // then the complete profile contract, then the compatibility of the
    // binding. Every failure crosses before any execution.
    throughCore(() => nativeVerifySelfHash("profile", text));
    throughCore(() => nativeValidateProfile(text));
    profile = readProfileArtifact(text);
    profileText = text;
  } else if (info.isExactOnly) {
    profile = synthesizeExactProfile(info);
    profileText = JSON.stringify(profile);
  }
  // The live evaluator state of the binding, reused by the enforcement gate
  // of `run`.
  const liveBindings: LiveBindingEntry[] = [];
  const boundProfileText = profileText;
  if (profile !== undefined && boundProfileText !== undefined) {
    liveBindings.push(
      ...liveEvaluatorBindings(profile, info, artifact, options.evaluators),
    );
    throughCore(() =>
      nativeCheckProfileCompatibility(boundProfileText, definitionText, liveBindings, "shadow"),
    );
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
      // Enforcement runs the complete compatibility gate of the core again,
      // in enforcement mode: the bindings, then the declared scope, then
      // the qualification clause, then the host selection. One unvalidated
      // profile refuses with `qualification_insufficient`, and one run that
      // states no selected reviewed hash or another hash refuses with
      // `profile_not_selected`, before any case work starts, whatever
      // checks the definition holds.
      if (mode === "enforcement" && profile !== undefined && profileText !== undefined) {
        throughCore(() =>
          nativeCheckProfileCompatibility(
            profileText,
            definitionText,
            liveBindings,
            "enforcement",
            runOptions.scope,
            runOptions.selectedProfileHash,
          ),
        );
      }
      // One question check needs one bound profile: its binding names the
      // registered evaluator and its policy states how the answers decide.
      // The gate fires before any case work starts, so no evaluator runs
      // and no spend occurs.
      const questionIds = info.checkKinds
        .filter((entry) => entry.kind !== "rule")
        .map((entry) => entry.id);
      if ((profile === undefined || profileText === undefined) && questionIds.length > 0) {
        throw new ValidationError(
          "evaluator_mismatch",
          `The check ${JSON.stringify(questionIds[0])} puts one question to an evaluator, and no bound profile states its evaluator and its decision policy. Pass one profile through the profile option of load and register its evaluators.`,
          "/profile",
        );
      }
      // Every exact-only definition holds its derived profile, and the gate
      // above returned for every definition that holds one question check.
      const bound = profile as Profile;

      // The core validates the case and projects the authorized inputs of
      // every check before any work starts.
      const caseText = jsonText(caseInput, "");
      const caseInfo = throughCore(() => nativeValidateCase(definitionText, caseText));
      const projected = new Map(
        caseInfo.projectedInputs.map((entry) => [entry.checkId, entry.inputs]),
      );
      const caseReference = JSON.stringify({
        id: caseInfo.id,
        input_hash: caseInfo.inputHash,
        ...(runOptions.snapshot !== undefined ? { snapshot: runOptions.snapshot } : {}),
      });
      const profileReference = JSON.stringify({
        id: bound.id,
        content_hash: bound.content_hash,
      });
      // The shadow baseline crosses as data through the same boundary. The
      // core owns its contract, so one malformed baseline, one out-of-bounds
      // field, and one baseline in enforcement mode all refuse here, before
      // any evaluator runs and before any spend occurs.
      const baselineText =
        runOptions.baseline === undefined
          ? null
          : jsonText(runOptions.baseline, "/baseline");
      const runState = throughCore(() =>
        nativeCreateRunState(
          definitionText,
          caseReference,
          profileReference,
          nextRunId(),
          mode,
          bound.execution.max_attempts,
          baselineText,
        ),
      );

      // The deterministic rule results exist before the scheduler runs:
      // rules hold no evaluator, so the scheduler bounds only their record
      // transitions. Question checks dispatch per attempt, below.
      const ruleRecords = new Map(
        throughCore(() => nativeAssessRuleChecks(definitionText, caseText)).map((rule) => [
          rule.check,
          rule.record,
        ]),
      );
      const bindings = new Map(bound.bindings.map((binding) => [binding.check, binding]));
      const policies = new Map((bound.policy.checks ?? []).map((entry) => [entry.check, entry]));
      const submittedAtMs = now();

      /**
       * Executes one started attempt: one exact rule from the core, or one
       * question through its registered evaluator, decided by the core.
       */
      const execute = async (
        attempt: ScheduledAttempt,
      ): Promise<ScheduledResolution> => {
        const ruleRecord = ruleRecords.get(attempt.check);
        if (ruleRecord !== undefined) {
          return { record: JSON.parse(ruleRecord) as ScheduledRecord };
        }
        const binding = bindings.get(attempt.check);
        if (binding === undefined) {
          throw new Error(
            `measuretwice found no evaluator binding for the question check ${JSON.stringify(attempt.check)}. The compatibility check of load verified the coverage, so this is one internal inconsistency.`,
          );
        }
        const evaluator = evaluators?.get(binding.evaluator);
        if (evaluator === undefined) {
          throw new Error(
            `measuretwice found no registered evaluator ${JSON.stringify(binding.evaluator)} for the check ${JSON.stringify(attempt.check)}. The compatibility check of load verified the registry, so this is one internal inconsistency.`,
          );
        }
        const policy = policies.get(attempt.check);
        if (policy === undefined) {
          throw new Error(
            `measuretwice found no policy entry for the question check ${JSON.stringify(attempt.check)}. The compatibility check of load verified the policy coverage, so this is one internal inconsistency.`,
          );
        }
        const attemptStartMs = now();
        const execution = await dispatchAssessment({
          artifact,
          checkKinds: info.checkKinds,
          checkId: attempt.check,
          projectedInputs: projected.get(attempt.check) ?? {},
          evaluator,
          budget: {
            attempt: attempt.attempt,
            max_attempts: attempt.max_attempts,
            deadline_at_ms: attempt.deadline_at_ms,
          },
          signal: attempt.signal,
        });
        // The operational record of the execution: the bound evaluator
        // versions with the model version that served the call, the queue
        // wait and the execution time of this attempt, and the usage that
        // the adapter reported. One absent measurement stays absent.
        const measurements = JSON.stringify({
          evaluator: {
            id: binding.evaluator,
            adapter_version: binding.adapter_version,
            ...(execution.model_resolved !== undefined
              ? { model_resolved: execution.model_resolved }
              : {}),
          },
          timing: {
            queued_ms: Math.max(0, attemptStartMs - submittedAtMs),
            execution_ms:
              execution.latency_ms ?? Math.max(0, now() - attemptStartMs),
          },
          ...(execution.usage !== undefined ? { usage: execution.usage } : {}),
        });
        if ("failure" in execution) {
          return { failure: execution.failure };
        }
        const policyText = JSON.stringify({
          accept_cutoff: policy.accept_cutoff,
          rejection_cutoff: policy.rejection_cutoff,
          ...(policy.confidence_floor !== undefined
            ? { confidence_floor: policy.confidence_floor }
            : {}),
        });
        let decided;
        try {
          decided = nativeDecideQuestionCheck(
            definitionText,
            attempt.check,
            jsonText(execution.assessment, "/assessment"),
            policyText,
            measurements,
          );
        } catch (cause) {
          if (cause instanceof NativeFailure) {
            // One assessment that the selected policy cannot decide is one
            // permanent failure of this check: one retry would return
            // through the same answer, so the record keeps the operational
            // code with the cause and the field path of the core refusal.
            return {
              failure: {
                code: "invalid_assessment" as const,
                message: shorten(
                  `${cause.code}${cause.fieldPath === "" ? "" : ` (at ${cause.fieldPath})`}: ${cause.message}`,
                ),
              },
            };
          }
          throw cause;
        }
        return { record: JSON.parse(decided.record) as ScheduledRecord };
      };

      // The scheduler owns the bounds: the effective execution configuration
      // validates before any attempt starts, every attempt crosses the core
      // run boundary, and the terminal report freezes inside the core.
      return scheduleRun({
        state: runState,
        caseReferenceText: caseReference,
        profileReferenceText: profileReference,
        execution: bound.execution,
        execute,
        now,
        ...(runOptions.signal !== undefined ? { signal: runOptions.signal } : {}),
        ...(setTimer !== undefined ? { setTimer } : {}),
      });
    },
  });
}
