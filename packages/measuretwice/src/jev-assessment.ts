// SPDX-License-Identifier: Apache-2.0
/**
 * Normalization of Jev answers into typed assessments and operational
 * records.
 *
 * This module owns task T026 of the Jev adapter: it turns one response of
 * the pinned SDK, `@typesafe-ai/sdk` 0.6.0 as `providers/jev/README.md`
 * records, into one assessment of the evaluator contract, or into one
 * operational failure. The translation of task T025 builds the question; the
 * normalization reads the answer.
 *
 * The mapping:
 *
 * - One Choice answer becomes one `categorical` assessment. The selected
 *   label crosses as `label`, the distribution across every declared label
 *   becomes `distribution`, and the reported concentration becomes
 *   `confidence`. Confidence is one provider measurement, never one
 *   probability of correctness.
 * - One Noul answer becomes one `binary` assessment. The `noul` value is the
 *   probability of yes, so it selects the answer: one half or more selects
 *   yes, and less selects no. Noul defines no confidence field, so one
 *   response that carries one anyway changes nothing: the value is not
 *   consumed and `confidence` stays absent.
 * - One Score answer becomes one `ordered` assessment. The reported position
 *   crosses as `position` without rounding, the nearest level becomes
 *   `level` (one tie between two levels selects the higher level), and the
 *   distribution across the level indices becomes one `distribution` over
 *   the declared level names.
 *
 * One distribution is one measurement input, so this module invents none:
 * it records the masses the provider reported, over the names the check
 * declared. The sum check and every rule that needs the complete check stay
 * in the Rust core, which validates one normalized assessment against its
 * check before the assessment enters one report.
 *
 * The operational record keeps what the call measured: the model version
 * that answered (`model_resolved`, from the response field `model`), the
 * per-request token `usage`, and the adapter-measured `latency_ms`. No
 * response field states latency, so the adapter measures it and marks it as
 * adapter-measured. No per-question usage exists, so usage stays at request
 * level. An unavailable measurement stays absent.
 *
 * Failure behavior: one response that breaks the recorded SDK shapes, one
 * answer that breaks the assessment contract, one answer that names no
 * declared answer, one distribution with one undeclared name, one value
 * outside its documented range, one incomplete usage object, or one missing
 * model identifier becomes one `invalid_assessment` failure whose message
 * names the defect. One thrown provider error becomes `evaluator_error` or
 * `evaluator_timeout`. The sanitized text keeps the error class, the status,
 * and the request identifier, and it never copies the provider message, the
 * response body, or one header, because each can echo case content.
 */
import type { JSONValue } from "./define-checks.js";
import type {
  Assessment,
  Evaluator,
  EvaluatorFailure,
  EvaluatorFailureCode,
  EvaluatorRequest,
  ValidatedQuestion,
} from "./evaluator.js";
import { jevEvidenceState, translateJevQuestion } from "./jev.js";
import type { JevEvidenceState, JevQuestionValue, JevTranslation } from "./jev.js";

/**
 * The version of the Jev adapter. One changed normalization or translation
 * behavior changes this version, because a changed evaluator needs new
 * qualification. The version carries {@link JEV_TRANSLATION_VERSION}, so the
 * two move together.
 */
export const JEV_ADAPTER_VERSION = "0.1.0";

/**
 * The model the adapter requests when the host states none. It is one
 * versioned identifier, never one alias, because one alias repoints without
 * one code change. The response names the version that answered, which the
 * operational record keeps.
 */
export const JEV_DEFAULT_MODEL = "jev-1.13.0";

/** The token usage of one Jev request, as the response reports it. */
export interface JevUsage {
  /** The input tokens of the request. */
  readonly input_tokens: number;
  /** The output tokens of the request. */
  readonly output_tokens: number;
}

/** One Choice answer of the pinned SDK shape. */
export interface JevChoiceAnswer {
  /** The primitive discriminator of the answer. */
  readonly type: "choice";
  /** The selected label, one of the supplied criteria keys. */
  readonly choice: string;
  /** The reported distribution concentration. Absent when not reported. */
  readonly confidence?: number;
  /** The reported mass by supplied label. */
  readonly probabilities?: Readonly<Record<string, number>>;
}

/** One Noul answer of the pinned SDK shape. */
export interface JevNoulAnswer {
  /** The primitive discriminator of the answer. */
  readonly type: "noul";
  /** The probability of one yes answer, from zero to one. */
  readonly noul: number;
}

/** One Score answer of the pinned SDK shape. */
export interface JevScoreAnswer {
  /** The primitive discriminator of the answer. */
  readonly type: "score";
  /** The reported position along the ordered levels. It may be fractional. */
  readonly score: number;
  /** The reported distribution concentration. Absent when not reported. */
  readonly confidence?: number;
  /** The level descriptions the response echoes, keyed by level index. */
  readonly legend?: Readonly<Record<string, JSONValue>>;
  /** The reported mass by level index, keyed from zero. */
  readonly probabilities?: Readonly<Record<string, number>>;
}

/** One answer of one Jev response, in the wire shape of the pinned SDK. */
export type JevAnswerValue = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

/** One complete response of one `systemOne` call of the pinned SDK. */
export interface JevSystemOneResult {
  /** The versioned identifier of the model that answered. */
  readonly model: string;
  /** The token usage of the complete request. */
  readonly usage: JevUsage;
  /** One answer per question key of the request. */
  readonly answers: Readonly<Record<string, JevAnswerValue>>;
}

/** The request options that the adapter passes to the Jev boundary. */
export interface JevRequestOptions {
  /** The cancellation signal of the run. The boundary stops when it aborts. */
  readonly signal?: AbortSignal;
  /** The attempt timeout in milliseconds, derived from the run budget. */
  readonly timeout?: number;
  /**
   * The retry policy of the boundary, structurally the `retry` field of the
   * pinned SDK `RequestOptions`. The adapter disables the retry loop of
   * the SDK, so one wrapper attempt is one SDK request.
   */
  readonly retry?: Readonly<{ readonly maxRetries: number }>;
}

/** One request of one `systemOne` call. */
export interface JevSystemOneRequest {
  /** The evidence state of the projected inputs. */
  readonly state: JevEvidenceState;
  /** One question per assessed check, keyed by check identifier. */
  readonly questions: Readonly<Record<string, JevQuestionValue>>;
  /** The versioned model identifier. Never one alias. */
  readonly model?: string;
}

/**
 * One Jev call boundary.
 *
 * The value matches the `systemOne` operation of the pinned SDK structurally:
 * pass `client.systemOne` of one constructed client, or one function with
 * the same shape. The adapter sends the request and the options and takes
 * the answer back for normalization. The adapter imports no SDK type and no
 * SDK package, so the public package keeps `typebox` as its only runtime
 * dependency, and the host keeps the client, the credential, and the
 * endpoint.
 */
export type JevCall = (
  request: JevSystemOneRequest,
  options?: JevRequestOptions,
) => Promise<unknown>;

/** The operational record of one Jev call, as the adapter measured it. */
export interface JevOperationalRecord {
  /** The model version that answered, from the response field `model`. */
  readonly model_resolved: string;
  /** The per-request token usage, from the response field `usage`. */
  readonly usage: Readonly<Record<string, number>>;
  /** The adapter-measured execution time of the call, in milliseconds. */
  readonly latency_ms: number;
}

/**
 * One normalized Jev execution: one assessment or one operational failure,
 * with the measurements that the call produced. A failure that happened
 * after one response keeps the readable parts of the record, and one failure
 * before any response keeps the latency only.
 */
export type JevExecution =
  | ({ readonly assessment: Assessment } & JevOperationalRecord)
  | ({ readonly failure: EvaluatorFailure } & Partial<JevOperationalRecord>);

// ---------------------------------------------------------------------------
// Normalization.
// ---------------------------------------------------------------------------

/**
 * Normalizes one Jev response into one assessment, or one operational
 * failure that names the defect.
 *
 * The question is the validated question of the check, so its declared
 * answers or levels close the distribution names and the selected answer.
 * The latency is the adapter-measured time of the call. The returned record
 * is frozen. Every measurement that the response does not state stays
 * absent; nothing is derived and nothing is invented.
 */
export function normalizeJevExecution(
  result: unknown,
  question: ValidatedQuestion,
  check: string,
  latency_ms: number,
): JevExecution {
  if (typeof latency_ms !== "number" || !Number.isFinite(latency_ms) || latency_ms < 0) {
    return {
      failure: jevFailure(
        "evaluator_error",
        "The measured latency of the Jev call is not one finite number of zero or more.",
      ),
    };
  }
  if (!isPlainObject(result)) {
    return {
      failure: jevFailure("invalid_assessment", "The Jev response holds no object."),
      latency_ms,
    };
  }
  const model = field(result, "model");
  if (typeof model !== "string" || model === "" || model.length > 128) {
    return {
      failure: jevFailure(
        "invalid_assessment",
        "The Jev response states no model identifier, so the effective model version cannot be recorded.",
      ),
      latency_ms,
    };
  }
  const usage = readUsage(result);
  if (usage === undefined) {
    return {
      failure: jevFailure(
        "invalid_assessment",
        "The Jev response states incomplete token usage, so the operational record cannot state complete usage.",
      ),
      model_resolved: model,
      latency_ms,
    };
  }
  const answers = field(result, "answers");
  if (!isPlainObject(answers) || !Object.prototype.hasOwnProperty.call(answers, check)) {
    return withRecord(
      jevFailure(
        "invalid_assessment",
        `The Jev response holds no answer for the check ${JSON.stringify(check)}.`,
      ),
      model,
      usage,
      latency_ms,
    );
  }
  const answer = (answers as Record<string, unknown>)[check];
  if (!isPlainObject(answer)) {
    return withRecord(
      jevFailure("invalid_assessment", `The answer of the check ${JSON.stringify(check)} holds no object.`),
      model,
      usage,
      latency_ms,
    );
  }
  const type = field(answer, "type");
  if (type === "choice") {
    const normalized = normalizeChoice(answer, question);
    return finish(normalized, model, usage, latency_ms);
  }
  if (type === "noul") {
    const normalized = normalizeNoul(answer, question);
    return finish(normalized, model, usage, latency_ms);
  }
  if (type === "score") {
    const normalized = normalizeScore(answer, question);
    return finish(normalized, model, usage, latency_ms);
  }
  return withRecord(
    jevFailure(
      "invalid_assessment",
      `The answer type ${JSON.stringify(String(type))} is neither choice, noul, nor score.`,
    ),
    model,
    usage,
    latency_ms,
  );
}

/** Reads the token usage of one response, or `undefined` when incomplete. */
function readUsage(result: Record<string, unknown>): Readonly<Record<string, number>> | undefined {
  const usage = field(result, "usage");
  if (!isPlainObject(usage)) {
    return undefined;
  }
  const input = field(usage, "input_tokens");
  const output = field(usage, "output_tokens");
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isFinite(output) ||
    output < 0
  ) {
    return undefined;
  }
  const record: Record<string, number> = { input_tokens: input, output_tokens: output };
  return Object.freeze(record);
}

/** Normalizes one Choice answer against one categorical question. */
function normalizeChoice(
  answer: Record<string, unknown>,
  question: ValidatedQuestion,
): Assessment | EvaluatorFailure {
  if (question.kind !== "categorical") {
    return jevFailure(
      "invalid_assessment",
      `The Choice answer cannot serve the ${question.kind} question of the check.`,
    );
  }
  const label = field(answer, "choice");
  if (typeof label !== "string" || label === "") {
    return jevFailure("invalid_assessment", "The Choice answer states no selected label.");
  }
  if (!Object.prototype.hasOwnProperty.call(question.answers, label)) {
    return jevFailure(
      "invalid_assessment",
      `The Choice answer ${JSON.stringify(label)} names no declared answer of the check.`,
    );
  }
  const distribution = distributionOver(
    answer,
    Object.keys(question.answers),
    (name) => name,
    "The Choice answer states no probabilities distribution.",
  );
  if ("failure" in distribution) {
    return distribution.failure;
  }
  const assessment: Record<string, unknown> = {
    kind: "categorical",
    label,
    distribution: distribution.entries,
  };
  const confidence = readConfidence(answer);
  if ("failure" in confidence) {
    return confidence.failure;
  }
  if (confidence.value !== undefined) {
    assessment.confidence = confidence.value;
  }
  return Object.freeze(assessment) as unknown as Assessment;
}

/** Normalizes one Noul answer against one binary question. */
function normalizeNoul(
  answer: Record<string, unknown>,
  question: ValidatedQuestion,
): Assessment | EvaluatorFailure {
  if (question.kind !== "binary") {
    return jevFailure(
      "invalid_assessment",
      `The Noul answer cannot serve the ${question.kind} question of the check.`,
    );
  }
  const value = field(answer, "noul");
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return jevFailure(
      "invalid_assessment",
      "The noul value sits outside the documented range from zero to one.",
    );
  }
  // A reported confidence field is not consumed: Noul defines none, so the
  // assessment keeps no confidence. The yes answer carries the reported
  // mass, and one tie at one half selects yes.
  return Object.freeze({ kind: "binary", value: value >= 0.5 }) as Assessment;
}

/** Normalizes one Score answer against one ordered question. */
function normalizeScore(
  answer: Record<string, unknown>,
  question: ValidatedQuestion,
): Assessment | EvaluatorFailure {
  if (question.kind !== "ordered") {
    return jevFailure(
      "invalid_assessment",
      `The Score answer cannot serve the ${question.kind} question of the check.`,
    );
  }
  const scale = question.scale;
  const last = scale.length - 1;
  const position = field(answer, "score");
  if (
    typeof position !== "number" ||
    !Number.isFinite(position) ||
    position < 0 ||
    position > last
  ) {
    return jevFailure(
      "invalid_assessment",
      `The score position sits outside the scale range from 0 to ${last}.`,
    );
  }
  // The nearest level names the answer. One tie between two levels selects
  // the higher level. The recorded position keeps the reported spelling
  // without rounding. The legend is one echo of the sent descriptions, so
  // the adapter reads no word of it.
  const level = scale[Math.min(last, Math.floor(position + 0.5))]!.name;
  const distribution = distributionOver(
    answer,
    scale.map((_, index) => String(index)),
    (index) => scale[Number(index)]!.name,
    "The Score answer states no probabilities distribution.",
  );
  if ("failure" in distribution) {
    return distribution.failure;
  }
  const assessment: Record<string, unknown> = {
    kind: "ordered",
    level,
    position,
    distribution: distribution.entries,
  };
  const confidence = readConfidence(answer);
  if ("failure" in confidence) {
    return confidence.failure;
  }
  if (confidence.value !== undefined) {
    assessment.confidence = confidence.value;
  }
  return Object.freeze(assessment) as unknown as Assessment;
}

/**
 * Reads one distribution that must cover exactly the stated keys.
 *
 * `keys` lists the required keys in their declared order and `nameOf` maps
 * one key to its assessment name. One absent key, one undeclared key, or
 * one mass outside the unit interval fails.
 */
function distributionOver(
  answer: Record<string, unknown>,
  keys: readonly string[],
  nameOf: (key: string) => string,
  absentMessage: string,
): { readonly entries: readonly { readonly name: string; readonly mass: number }[] } | { readonly failure: EvaluatorFailure } {
  const probabilities = field(answer, "probabilities");
  if (!isPlainObject(probabilities)) {
    return { failure: jevFailure("invalid_assessment", absentMessage) };
  }
  const seen = new Set(Object.keys(probabilities));
  for (const key of keys) {
    if (!seen.has(key)) {
      return {
        failure: jevFailure(
          "invalid_assessment",
          `The distribution omits the declared ${JSON.stringify(nameOf(key))}, so the reported mass is incomplete.`,
        ),
      };
    }
  }
  for (const key of seen) {
    if (!keys.includes(key)) {
      return {
        failure: jevFailure(
          "invalid_assessment",
          `The distribution names ${JSON.stringify(key)}, which the check does not declare.`,
        ),
      };
    }
  }
  const entries: { readonly name: string; readonly mass: number }[] = [];
  for (const key of keys) {
    const mass = (probabilities as Record<string, unknown>)[key];
    if (typeof mass !== "number" || !Number.isFinite(mass) || mass < 0 || mass > 1) {
      return {
        failure: jevFailure(
          "invalid_assessment",
          `The reported mass of ${JSON.stringify(nameOf(key))} sits outside the unit interval.`,
        ),
      };
    }
    entries.push(Object.freeze({ name: nameOf(key), mass }));
  }
  return { entries: Object.freeze(entries) };
}

/** Reads one optional confidence value in the unit interval. */
function readConfidence(
  answer: Record<string, unknown>,
): { readonly value?: number } | { readonly failure: EvaluatorFailure } {
  const confidence = field(answer, "confidence");
  if (confidence === undefined) {
    return {};
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return {
      failure: jevFailure(
        "invalid_assessment",
        "The reported confidence sits outside the unit interval.",
      ),
    };
  }
  return { value: confidence };
}

/** Attaches the complete operational record to one normalized outcome. */
function finish(
  outcome: Assessment | EvaluatorFailure,
  model: string,
  usage: Readonly<Record<string, number>>,
  latency_ms: number,
): JevExecution {
  if ("kind" in outcome) {
    return Object.freeze({
      assessment: outcome,
      model_resolved: model,
      usage,
      latency_ms,
    }) as JevExecution;
  }
  return withRecord(outcome, model, usage, latency_ms);
}

/** Attaches one operational record to one failure. */
function withRecord(
  failure: EvaluatorFailure,
  model: string | undefined,
  usage: Readonly<Record<string, number>> | undefined,
  latency_ms: number,
): JevExecution {
  const record: Record<string, unknown> = { failure, latency_ms };
  if (model !== undefined) {
    record.model_resolved = model;
  }
  if (usage !== undefined) {
    record.usage = usage;
  }
  return Object.freeze(record) as JevExecution;
}

// ---------------------------------------------------------------------------
// Provider failures.
// ---------------------------------------------------------------------------

/**
 * Maps one thrown error of the Jev boundary to one operational failure.
 *
 * One user abort and one attempt timeout report `evaluator_timeout`; every
 * other error reports `evaluator_error`. The message keeps the operational
 * reason, never the provider text: the class name, the status, and the
 * request identifier state what failed without echoing one response body or
 * one header, because each can quote case content.
 */
export function mapJevError(cause: unknown): EvaluatorFailure {
  const name = errorName(cause);
  if (name === "APIUserAbortError" || name === "AbortError") {
    return jevFailure(
      "evaluator_timeout",
      "The Jev request was aborted before one answer arrived.",
    );
  }
  if (name === "APITimeoutError") {
    return jevFailure("evaluator_timeout", `One Jev attempt timed out. ${describeJevError(cause)}`);
  }
  return jevFailure("evaluator_error", `The Jev call failed. ${describeJevError(cause)}`);
}

/** Names the class of one thrown value. */
function errorName(cause: unknown): string {
  if (cause instanceof Error && cause.name !== "") {
    return cause.name;
  }
  return "an unknown error value";
}

/**
 * Describes one provider error from its safe parts.
 *
 * The description reads the class name, one numeric `status`, and one string
 * `requestId`. It reads no message, no body, and no header, and it strips
 * control characters and bounds every echoed identifier.
 */
function describeJevError(cause: unknown): string {
  const parts: string[] = [errorName(cause)];
  if (typeof cause === "object" && cause !== null) {
    const status = (cause as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      parts.push(`status ${status}`);
    }
    const requestId = sanitizeText((cause as { requestId?: unknown }).requestId);
    if (requestId !== undefined) {
      parts.push(`request id ${requestId}`);
    }
  }
  return `(${parts.join(", ")})`;
}

/** Reads one bounded, control-free identifier of one provider error. */
function sanitizeText(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128);
  return clean === "" ? undefined : clean;
}

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

/** The options of one Jev evaluator. */
export interface JevEvaluatorOptions {
  /** The Jev call boundary, structurally the `systemOne` operation. */
  readonly call: JevCall;
  /** The versioned model identifier to request. Defaults to one pinned version. */
  readonly model?: string;
  /** The registered evaluator identifier. Defaults to `jev`. */
  readonly id?: string;
  /** The adapter version. Defaults to {@link JEV_ADAPTER_VERSION}. */
  readonly adapter_version?: string;
  /** The clock. Defaults to the wall clock. Tests inject one fake clock. */
  readonly now?: () => number;
}

/** One Jev evaluator, with its normalized execution type. */
export interface JevEvaluator extends Evaluator {
  /** Assesses one request through one Jev call and one normalization. */
  assess(request: EvaluatorRequest): Promise<JevExecution>;
  /** Translates one validated question into its Jev wire question, offline. */
  translate(question: ValidatedQuestion): JevTranslation;
}

/**
 * Creates one Jev evaluator from one call boundary.
 *
 * The adapter translates the question, frames the projected inputs as
 * evidence, sends one request per check, and normalizes the answer. It
 * passes the caller `AbortSignal` on every call, bounds the attempt with
 * the remaining budget of the request, and disables the retry loop of the
 * SDK, so one wrapper attempt is one SDK request. The wrapper scheduler
 * owns the attempts, the backoff, and the total deadline, and one hidden
 * SDK retry would multiply the requests of one attempt inside one budget
 * that the wrapper cannot see. The adapter stores nothing, reads no
 * credential, and takes no application action.
 *
 * The adapter exposes its translation through the optional `translate`
 * operation of the evaluator contract, so `load` compares the recorded
 * translation of one bound profile against the live one. The operation is
 * offline: it calls no provider and reads no credential.
 */
export function createJevEvaluator(options: JevEvaluatorOptions): JevEvaluator {
  const now = options.now ?? (() => Date.now());
  const model = options.model ?? JEV_DEFAULT_MODEL;
  return {
    id: options.id ?? "jev",
    adapter_version: options.adapter_version ?? JEV_ADAPTER_VERSION,
    translate: translateJevQuestion,
    async assess(request: EvaluatorRequest): Promise<JevExecution> {
      if (request.signal.aborted) {
        return {
          failure: jevFailure(
            "evaluator_timeout",
            "The Jev adapter saw one aborted signal before it started. No request was sent.",
          ),
        };
      }
      const started = now();
      const remaining = request.budget.deadline_at_ms - started;
      if (remaining <= 0) {
        return {
          failure: jevFailure(
            "evaluator_timeout",
            "The attempt deadline passed before the Jev call started.",
          ),
        };
      }
      const translation = translateJevQuestion(request.question);
      const state = jevEvidenceState(request.using, request.inputs);
      const timeout = Math.max(1, Math.ceil(remaining));
      let result: unknown;
      try {
        result = await options.call(
          {
            state,
            questions: Object.freeze({ [request.check]: translation.question }),
            model,
          },
          { signal: request.signal, timeout, retry: NO_SDK_RETRIES },
        );
      } catch (cause) {
        return { failure: mapJevError(cause), latency_ms: now() - started };
      }
      const latency = now() - started;
      if (request.signal.aborted) {
        return {
          failure: jevFailure(
            "evaluator_timeout",
            "The caller aborted the request before the Jev answer was used. The answer was dropped.",
          ),
          latency_ms: latency,
        };
      }
      return normalizeJevExecution(result, request.question, request.check, latency);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * The retry policy the adapter states on every call: the SDK retries
 * nothing. The wrapper scheduler owns the attempts, the backoff, and the
 * total deadline, as MVP_SPEC.md section 12 requires one configured retry
 * count. One SDK retry inside one wrapper attempt would multiply the
 * requests and the spend of one budget that the wrapper cannot see.
 */
const NO_SDK_RETRIES: Readonly<{ maxRetries: number }> = Object.freeze({ maxRetries: 0 });

/** The greatest length of one sanitized reason message, from the contracts. */
const MESSAGE_LIMIT = 500;

/** Builds one frozen operational failure with one shortened message. */
function jevFailure(code: EvaluatorFailureCode, message: string): EvaluatorFailure {
  return Object.freeze({ code, message: shorten(message) });
}

/** Shortens one message without splitting one pair of surrogates. */
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
