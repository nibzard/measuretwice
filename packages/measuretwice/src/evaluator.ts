// SPDX-License-Identifier: Apache-2.0
/**
 * The evaluator registration and execution contract.
 *
 * One evaluator assesses one question check. It receives one validated
 * question, the projected inputs that the `using` list authorizes, one
 * execution budget, and one cancellation signal. It returns one typed
 * assessment or one operational failure. The contract states no provider
 * SDK type, no client, and no credential. The host adapter owns the
 * provider. The Rust core never sees this interface. It validates the
 * artifacts, and it validates one returned assessment before the assessment
 * enters one report.
 *
 * `registerEvaluators` builds the host allowlist. Registration is explicit
 * host code: one profile refers only to evaluators of the registry that
 * `load` received. One loaded file cannot install one evaluator, execute
 * code, or authorize one tool. One unknown reference fails `load` with
 * `evaluator_mismatch` before any execution.
 *
 * `dispatchAssessment` is internal. It builds one request from one
 * validated definition and one projected input set, calls the evaluator,
 * and normalizes the answer. The normalization freezes the result and maps
 * one broken adapter answer to one operational failure. It adds no field
 * and it invents no measurement: one label-only assessment stays
 * label-only, and one absent optional measurement stays absent. The Rust
 * assessment validation arrives with its own task.
 *
 * Failure behavior: one evaluator object outside the contract fails
 * registration with one {@link ValidationError} and one field path. The
 * dispatch helper reports one adapter that throws, resolves nothing, or
 * resolves one malformed record as one `evaluator_error` failure, so one
 * broken adapter cannot crash one run.
 */
import type { CheckDefinition, Definition, JSONValue } from "./define-checks.js";
import type { DefinitionInfo } from "./native.js";
import { ValidationError } from "./error.js";

/** One check kind of one validated definition, as the core reports it. */
type CheckKindEntry = DefinitionInfo["checkKinds"][number];

/** The identifier rule of the portable contracts: lowercase segments joined by single hyphens. */
const IDENTIFIER = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The greatest length of one identifier, from the portable contracts. */
const IDENTIFIER_LIMIT = 64;

/** The greatest length of one sanitized reason message, from the portable contracts. */
const MESSAGE_LIMIT = 500;

/** The operational failure codes that one evaluator may report. */
const FAILURE_CODES = ["evaluator_error", "evaluator_timeout"] as const;

// ---------------------------------------------------------------------------
// The execution contract types.
// ---------------------------------------------------------------------------

/** The kind of one assessed answer, as the assessment contract states it. */
export type AnswerKind = "categorical" | "binary" | "ordered";

/** One level of one ordered scale, with its description. */
export interface ScaleEntry {
  /** The scale level name. */
  readonly name: string;
  /** The description of the level. */
  readonly description: string;
}

/** One categorical question: named answers with their descriptions. */
export interface CategoricalQuestion {
  /** The answer kind of the check. */
  readonly kind: "categorical";
  /** The question put to the evaluator. */
  readonly question: string;
  /** Every named answer, by label. */
  readonly answers: Readonly<Record<string, string>>;
}

/** One binary question: the answers yes and no with their descriptions. */
export interface BinaryQuestion {
  /** The answer kind of the check. */
  readonly kind: "binary";
  /** The question put to the evaluator. */
  readonly question: string;
  /** The two declared answers. */
  readonly answers: Readonly<{ readonly yes: string; readonly no: string }>;
}

/** One ordered question: descriptive levels from lowest to highest. */
export interface OrderedQuestion {
  /** The answer kind of the check. */
  readonly kind: "ordered";
  /** The question put to the evaluator. */
  readonly question: string;
  /** The ordered levels. The array order carries meaning. */
  readonly scale: readonly ScaleEntry[];
}

/** The validated question of one check. The core established the kind. */
export type ValidatedQuestion = CategoricalQuestion | BinaryQuestion | OrderedQuestion;

/** Probability mass that one evaluator reported for one answer or level. */
export interface DistributionMass {
  /** The answer label or scale level. */
  readonly name: string;
  /** The reported mass. */
  readonly mass: number;
}

/** One evidence item that the evaluator selected inside one authorized input. */
export interface EvidenceReference {
  /** The input that holds the evidence. The `using` list names it. */
  readonly input: string;
  /** One stable reference inside the named input. */
  readonly reference: string;
}

/**
 * One typed measurement of one evaluator execution.
 *
 * The fields follow `contracts/v0/assessment.schema.json`. One absent
 * optional field was not measured. Never invent one measurement: one
 * missing confidence stays missing and one missing distribution stays
 * missing. One distribution is one measurement input, not one calibrated
 * probability of correctness.
 */
export interface Assessment {
  /** The kind of the assessed answer. It matches the check shape. */
  readonly kind: AnswerKind;
  /** The selected answer label. Present when the kind is categorical. */
  readonly label?: string;
  /** The selected answer of one binary question. Present when the kind is binary. */
  readonly value?: boolean;
  /** The selected scale level. Present when the kind is ordered. */
  readonly level?: string;
  /** The reported position along the ordered levels. Fractional values stay unrounded. */
  readonly position?: number;
  /** The reported mass by answer or level, when the evaluator reports it. */
  readonly distribution?: readonly DistributionMass[];
  /** The confidence that the provider reported, when one exists. */
  readonly confidence?: number;
  /** The evidence that the evaluator selected, when it returns any. */
  readonly evidence?: readonly EvidenceReference[];
}

/** The stable codes of one operational failure of one evaluator execution. */
export type EvaluatorFailureCode = "evaluator_error" | "evaluator_timeout";

/**
 * One operational failure of one evaluator execution.
 *
 * A failure is not one semantic answer. It never becomes one pass. The
 * message keeps one short sanitized cause. It contains no credential and
 * no raw case content.
 */
export interface EvaluatorFailure {
  /** The stable reason code of the failure. */
  readonly code: EvaluatorFailureCode;
  /** One short sanitized cause. */
  readonly message: string;
}

/** One evaluator execution: exactly one assessment or one operational failure. */
export type EvaluatorExecution =
  | { readonly assessment: Assessment }
  | { readonly failure: EvaluatorFailure };

/** The execution budget of one evaluator request. */
export interface ExecutionBudget {
  /** The attempt that this request starts. The first attempt is 1. */
  readonly attempt: number;
  /** The greatest attempt number that the check may start. */
  readonly max_attempts: number;
  /** The epoch-millisecond instant when this attempt must finish. */
  readonly deadline_at_ms: number;
}

/** One request to one registered evaluator. Plain data plus the cancellation signal. */
export interface EvaluatorRequest {
  /** The assessed check identifier. */
  readonly check: string;
  /** The validated question of the check. */
  readonly question: ValidatedQuestion;
  /** The inputs that the check declared in its `using` list, by name. */
  readonly using: readonly string[];
  /** The projected inputs. No other field of the case appears here. */
  readonly inputs: Readonly<Record<string, JSONValue>>;
  /** The execution budget of this attempt. */
  readonly budget: ExecutionBudget;
  /** The cancellation signal of the run. The adapter stops when it aborts. */
  readonly signal: AbortSignal;
}

/**
 * One evaluator adapter that the host registered.
 *
 * The adapter owns its provider. It holds the client, reads the host
 * credential mechanism, and translates the question. It returns one typed
 * assessment or one operational failure. It stores nothing and it takes no
 * application action.
 */
export interface Evaluator {
  /** The stable registered identifier. The portable identifier rule governs it. */
  readonly id: string;
  /** The version of this adapter implementation. One changed version needs new qualification. */
  readonly adapter_version: string;
  /** Assesses one request. */
  assess(request: EvaluatorRequest): Promise<EvaluatorExecution>;
}

/** The host allowlist of registered evaluators. One profile refers only to it. */
export interface EvaluatorRegistry {
  /** Every registered identifier, in registration order. */
  readonly ids: readonly string[];
  /** Returns the registered evaluator, or undefined when the identifier names none. */
  get(id: string): Evaluator | undefined;
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

/**
 * Registers evaluators and returns one frozen registry.
 *
 * Pass the registry to `load` through its `evaluators` option. Registration
 * is explicit host code, so one loaded profile cannot install one evaluator.
 * The registry reads only `id`, `adapter_version`, and `assess`. One adapter
 * may hold any other field, such as its client, because it never serializes.
 *
 * @throws {ValidationError} when one evaluator states one identifier or one
 * adapter version outside the contract, implements no `assess` operation,
 * or shares one identifier with one earlier registration.
 */
export function registerEvaluators(...evaluators: readonly Evaluator[]): EvaluatorRegistry {
  const registered = new Map<string, Evaluator>();
  for (const [index, evaluator] of evaluators.entries()) {
    const base = `/evaluators/${index}`;
    if (typeof evaluator !== "object" || evaluator === null) {
      throw new ValidationError(
        "invalid_field_type",
        `The evaluator at ${base} is not one object. Pass one evaluator adapter with one identifier, one adapter version, and one assess operation.`,
        base,
      );
    }
    const id = evaluator.id;
    if (
      typeof id !== "string" ||
      id.length > IDENTIFIER_LIMIT ||
      !IDENTIFIER.test(id)
    ) {
      throw new ValidationError(
        "invalid_field_type",
        `The evaluator at ${base}/id states one identifier outside the contract rule: one lowercase letter, then lowercase letters, digits, and hyphen-separated segments, at most ${IDENTIFIER_LIMIT} characters.`,
        `${base}/id`,
      );
    }
    const version = evaluator.adapter_version;
    if (typeof version !== "string" || version === "" || version.length > IDENTIFIER_LIMIT) {
      throw new ValidationError(
        "invalid_field_type",
        `The evaluator ${JSON.stringify(id)} states one adapter version that is not one nonempty string of at most ${IDENTIFIER_LIMIT} characters.`,
        `${base}/adapter_version`,
      );
    }
    if (typeof evaluator.assess !== "function") {
      throw new ValidationError(
        "invalid_field_type",
        `The evaluator ${JSON.stringify(id)} implements no assess operation. One evaluator receives one request and returns one assessment or one failure.`,
        `${base}/assess`,
      );
    }
    if (registered.has(id)) {
      throw new ValidationError(
        "duplicate_id",
        `Two registered evaluators share the identifier ${JSON.stringify(id)}. Give each adapter one stable identifier.`,
        `${base}/id`,
      );
    }
    registered.set(id, evaluator);
  }
  const registry: EvaluatorRegistry = {
    ids: Object.freeze([...registered.keys()]),
    get(id: string): Evaluator | undefined {
      return registered.get(id);
    },
  };
  return Object.freeze(registry);
}

// ---------------------------------------------------------------------------
// Dispatch: one validated request, one normalized answer.
// ---------------------------------------------------------------------------

/** The input of one evaluator dispatch. */
export interface EvaluatorDispatch {
  /** The validated definition artifact. */
  readonly artifact: Definition;
  /** The check kinds that the core reported for the artifact. */
  readonly checkKinds: readonly CheckKindEntry[];
  /** The dispatched check identifier. */
  readonly checkId: string;
  /** The projected inputs of this check, from the core case validation. */
  readonly projectedInputs: Readonly<Record<string, JSONValue>>;
  /** The evaluator that serves the check. */
  readonly evaluator: Evaluator;
  /** The execution budget of this attempt. */
  readonly budget: ExecutionBudget;
  /** The cancellation signal of the run. */
  readonly signal: AbortSignal;
}

/**
 * Builds one evaluator request and returns the normalized answer.
 *
 * The request carries the validated question of the check, the projected
 * inputs, the budget, and the signal. The answer comes back frozen. One
 * assessment stays exactly as the evaluator reported it. One broken answer
 * becomes one `evaluator_error` failure, and one thrown adapter error
 * becomes one too, so one adapter cannot crash one run.
 *
 * @throws {Error} when the stated check names no check of the artifact or
 * holds one exact rule. Both state one wrapper bug, because the core
 * validated the artifact and the caller chose the check.
 */
export async function dispatchAssessment(dispatch: EvaluatorDispatch): Promise<EvaluatorExecution> {
  const kindEntry = dispatch.checkKinds.find((entry) => entry.id === dispatch.checkId);
  if (kindEntry === undefined) {
    throw new Error(
      `measuretwice found no check ${JSON.stringify(dispatch.checkId)} in the validated definition.`,
    );
  }
  if (kindEntry.kind === "rule") {
    throw new Error(
      `The check ${JSON.stringify(dispatch.checkId)} holds one exact rule. Exact rules need no evaluator.`,
    );
  }
  const check = dispatch.artifact.checks.find((entry) => entry.id === dispatch.checkId);
  if (check === undefined) {
    throw new Error(
      `measuretwice found no check artifact for ${JSON.stringify(dispatch.checkId)}. The core validated the definition, so this is one internal inconsistency.`,
    );
  }
  const request: EvaluatorRequest = {
    check: check.id,
    question: validatedQuestion(kindEntry.kind, check),
    using: check.using,
    inputs: dispatch.projectedInputs,
    budget: dispatch.budget,
    signal: dispatch.signal,
  };
  let returned: unknown;
  try {
    returned = await dispatch.evaluator.assess(request);
  } catch (cause) {
    return failure("evaluator_error", `The evaluator threw: ${messageOf(cause)}`);
  }
  if (!isPlainObject(returned)) {
    return failure("evaluator_error", "The evaluator resolved without one result object.");
  }
  const assessment = field(returned, "assessment");
  const failureRecord = field(returned, "failure");
  if (assessment !== undefined && failureRecord !== undefined) {
    return failure(
      "evaluator_error",
      "The evaluator resolved with one assessment and one failure together. Return exactly one of the two.",
    );
  }
  if (failureRecord !== undefined) {
    const code = isPlainObject(failureRecord) ? field(failureRecord, "code") : undefined;
    const message = isPlainObject(failureRecord) ? field(failureRecord, "message") : undefined;
    if (
      typeof code === "string" &&
      (FAILURE_CODES as readonly string[]).includes(code) &&
      typeof message === "string" &&
      message !== ""
    ) {
      return failure(code as EvaluatorFailureCode, message);
    }
    return failure(
      "evaluator_error",
      "The evaluator reported one failure outside the failure contract. Report code evaluator_error or evaluator_timeout with one nonempty message.",
    );
  }
  if (assessment === undefined) {
    return failure(
      "evaluator_error",
      "The evaluator resolved with neither one assessment nor one failure.",
    );
  }
  if (!isPlainObject(assessment)) {
    return failure("evaluator_error", "The evaluator resolved with one assessment that is not one object.");
  }
  // The assessment crosses as it came back. The core validates it against
  // the assessment contract before it enters one report. This helper adds
  // no field, so one absent optional measurement stays absent.
  deepFreeze(assessment);
  return Object.freeze({ assessment: assessment as unknown as Assessment });
}

/** Builds the validated question of one check from its validated artifact. */
function validatedQuestion(kind: string, check: CheckDefinition): ValidatedQuestion {
  if (check.question === undefined) {
    throw new Error(
      `The check ${JSON.stringify(check.id)} states no question. The core validated the definition, so this is one internal inconsistency.`,
    );
  }
  if (kind === "ordered") {
    const scale = (check.scale ?? []).map((level): ScaleEntry => {
      const entries = Object.entries(level);
      if (entries.length !== 1) {
        throw new Error(
          `One scale level of the check ${JSON.stringify(check.id)} holds no single name. The core validated the definition, so this is one internal inconsistency.`,
        );
      }
      const [name, description] = entries[0]!;
      return { name, description };
    });
    return { kind: "ordered", question: check.question, scale };
  }
  const answers = check.answers ?? {};
  if (kind === "binary") {
    const yes = answers["yes"];
    const no = answers["no"];
    if (yes === undefined || no === undefined) {
      throw new Error(
        `The binary check ${JSON.stringify(check.id)} states no yes and no answer. The core validated the definition, so this is one internal inconsistency.`,
      );
    }
    return { kind: "binary", question: check.question, answers: { yes, no } };
  }
  return { kind: "categorical", question: check.question, answers };
}

/** Builds one frozen operational failure with one shortened message. */
function failure(code: EvaluatorFailureCode, message: string): EvaluatorExecution {
  return Object.freeze({
    failure: Object.freeze({ code, message: shorten(message) }),
  });
}

/** Reads the message of one thrown value without exposing one stack trace. */
function messageOf(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text === "" ? "no message" : text;
}

/** Shortens one message to the sanitized reason limit without splitting one pair of surrogates. */
function shorten(message: string): string {
  if (message.length <= MESSAGE_LIMIT) {
    return message;
  }
  return Array.from(message).slice(0, MESSAGE_LIMIT).join("");
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

/** Freezes one JSON value deeply. Mirrors the twins in `define-checks.ts` and `run.ts`. */
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
