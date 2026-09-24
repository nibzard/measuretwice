// SPDX-License-Identifier: Apache-2.0
/**
 * The versioned translation of checks into Jev questions.
 *
 * One question check becomes exactly one Jev question. A categorical
 * question becomes Choice, one binary question with the answers yes and no
 * becomes Noul, and one ordered scale becomes Score. The translation keeps
 * the question wording, every answer description, and the scale order. It
 * changes no check meaning: the accept and review sets stay outside the
 * question, because acceptance defines meaning and no probability of
 * correctness follows from it.
 *
 * The translated question is plain JSON in the wire shape of the pinned
 * SDK, `@typesafe-ai/sdk` 0.6.0, as `providers/jev/README.md` records. The
 * module imports no SDK type and no SDK package, so the public package
 * keeps `typebox` as its only runtime dependency. The adapter that sends
 * the question arrives with its own task and builds the request as
 * `{ state, questions: { [check id]: question } }`.
 *
 * The evidence framing lives in the request state, not in the question.
 * `jevEvidenceState` wraps the projected inputs under one fixed `evidence`
 * key, so every supplied value arrives marked as untrusted evidence for
 * the question and never as instructions. It accepts exactly the inputs
 * that the `using` list names, so one label, one label explanation, one
 * baseline decision, or the case identifier can never enter the state.
 *
 * Each translation records the translation contract version and the
 * canonical content hash of the complete translated question, in the
 * translation domain of the Rust core. One changed translated question
 * changes the hash, so the profile binding that records it changes and
 * the prior qualification no longer applies. The shared cases live in
 * `fixtures/translations/jev.json`.
 *
 * Failure behavior: one question or one input set outside the contract
 * fails with one {@link ValidationError} and one field path, before any
 * request exists.
 */
import type { JSONValue } from "./define-checks.js";
import type { ValidatedQuestion } from "./evaluator.js";
import { ValidationError } from "./error.js";
import { NativeFailure, nativeContentHash } from "./native.js";

/**
 * The version of the Jev translation contract. One changed translation
 * behavior changes this version and the adapter version that carries it,
 * because the adapter owns the translation.
 */
export const JEV_TRANSLATION_VERSION = "0.1.0";

/** The Jev primitive that serves one question kind. */
export type JevPrimitive = "choice" | "noul" | "score";

/** One categorical question as one Jev Choice question. */
export interface JevChoiceQuestion {
  /** The primitive discriminator of the wire question. */
  readonly type: "choice";
  /** The question wording, unchanged from the check. */
  readonly instructions: string;
  /** Every answer label with its description, keyed by label. */
  readonly criteria: Readonly<Record<string, string>>;
}

/** One binary question as one Jev Noul question. */
export interface JevNoulQuestion {
  /** The primitive discriminator of the wire question. */
  readonly type: "noul";
  /** The question wording, unchanged from the check. */
  readonly instructions: string;
  /** The yes description under `true` and the no description under `false`. */
  readonly criteria: Readonly<{ readonly true: string; readonly false: string }>;
}

/** One ordered question as one Jev Score question. */
export interface JevScoreQuestion {
  /** The primitive discriminator of the wire question. */
  readonly type: "score";
  /** The question wording, unchanged from the check. */
  readonly instructions: string;
  /** The level descriptions in the declared order, indexed from zero. */
  readonly criteria: readonly string[];
}

/** One complete translated question in the wire shape of the pinned SDK. */
export type JevQuestionValue = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

/** One translated question of one check, with its identity. */
export interface JevTranslation {
  /** The translation contract version that produced the question. */
  readonly translation_version: string;
  /** The Jev primitive that serves the question kind. */
  readonly primitive: JevPrimitive;
  /** The complete translated question. Plain JSON, frozen. */
  readonly question: JevQuestionValue;
  /** The canonical content hash of the question, in the translation domain. */
  readonly content_hash: string;
}

/** The request state of one Jev call: the projected inputs, framed as evidence. */
export interface JevEvidenceState {
  /** The one fixed envelope key. Every supplied value sits under it. */
  readonly evidence: Readonly<Record<string, JSONValue>>;
}

// ---------------------------------------------------------------------------
// Translation.
// ---------------------------------------------------------------------------

/**
 * Translates one validated question into one Jev question.
 *
 * The wording, every answer description, and the scale order pass through
 * unchanged. The returned record holds the complete translated question
 * and its canonical translation hash. The record is frozen, and the hash
 * covers exactly the `question` value, so a host can store the canonical
 * text and the digest together in one profile binding.
 *
 * @throws {ValidationError} when the question states one kind outside the
 * contract, one empty wording, one missing or nonstring answer
 * description, or one scale with fewer than two described levels.
 */
export function translateJevQuestion(question: ValidatedQuestion): JevTranslation {
  validateQuestion(question);
  const wire = wireOf(question);
  return Object.freeze({
    translation_version: JEV_TRANSLATION_VERSION,
    primitive: wire.type,
    question: wire,
    content_hash: translationHash(wire),
  });
}

/** Builds the wire question of one validated question. */
function wireOf(question: ValidatedQuestion): JevQuestionValue {
  if (question.kind === "ordered") {
    return Object.freeze({
      type: "score",
      instructions: question.question,
      criteria: Object.freeze(question.scale.map((level) => level.description)),
    });
  }
  if (question.kind === "binary") {
    return Object.freeze({
      type: "noul",
      instructions: question.question,
      criteria: Object.freeze({
        true: question.answers.yes,
        false: question.answers.no,
      }),
    });
  }
  return Object.freeze({
    type: "choice",
    instructions: question.question,
    criteria: Object.freeze({ ...question.answers }),
  });
}

/** Computes the translation-domain content hash of one wire question. */
function translationHash(wire: JevQuestionValue): string {
  try {
    return nativeContentHash("translation", JSON.stringify(wire));
  } catch (error) {
    if (error instanceof NativeFailure) {
      throw new ValidationError(error.code, error.message, error.fieldPath);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The evidence state.
// ---------------------------------------------------------------------------

/**
 * Builds the request state of one Jev call from the projected inputs.
 *
 * The state holds one fixed `evidence` key with exactly the inputs that
 * the `using` list names. Nothing else enters: one extra field fails with
 * `unknown_field` and one missing field fails with `missing_field`, so
 * one label, one label explanation, one baseline decision, or the case
 * identifier can never reach the provider. The returned state is frozen.
 *
 * @throws {ValidationError} when the `using` list is empty or holds one
 * nonstring name, when the inputs hold no object, when one named input is
 * absent, or when the inputs hold one field outside the `using` list.
 */
export function jevEvidenceState(
  using: readonly string[],
  inputs: Readonly<Record<string, JSONValue>>,
): JevEvidenceState {
  if (!Array.isArray(using) || using.length === 0) {
    throw new ValidationError(
      "invalid_field_type",
      "The using list of the state holds no nonempty array of input names.",
      "/using",
    );
  }
  for (const [index, name] of using.entries()) {
    if (typeof name !== "string" || name === "") {
      throw new ValidationError(
        "invalid_field_type",
        `The using entry ${index} holds no nonempty input name.`,
        `/using/${index}`,
      );
    }
  }
  if (!isPlainObject(inputs)) {
    throw new ValidationError(
      "invalid_field_type",
      "The projected inputs hold no JSON object.",
      "/inputs",
    );
  }
  const named = new Set(using);
  const evidence: Record<string, JSONValue> = {};
  for (const name of using) {
    if (!Object.prototype.hasOwnProperty.call(inputs, name)) {
      throw new ValidationError(
        "missing_field",
        `The projected inputs omit the input ${JSON.stringify(name)} that the using list names. The state never invents a value.`,
        `/inputs/${name}`,
      );
    }
    evidence[name] = inputs[name] as JSONValue;
  }
  for (const key of Object.keys(inputs)) {
    if (!named.has(key)) {
      throw new ValidationError(
        "unknown_field",
        `The projected inputs hold the field ${JSON.stringify(key)}, which the using list does not name. The state carries authorized evidence only.`,
        `/inputs/${key}`,
      );
    }
  }
  const state = { evidence };
  deepFreeze(state);
  return state;
}

// ---------------------------------------------------------------------------
// Input validation and helpers.
// ---------------------------------------------------------------------------

/** Validates one question against the shapes that the dispatch contract states. */
function validateQuestion(question: ValidatedQuestion): void {
  if (!isPlainObject(question)) {
    throw new ValidationError(
      "invalid_field_type",
      "The question holds no object. Pass the validated question of one check.",
      "/question",
    );
  }
  const kind = question.kind;
  if (kind !== "categorical" && kind !== "binary" && kind !== "ordered") {
    throw new ValidationError(
      "invalid_field_type",
      `The question states the kind ${JSON.stringify(String(kind))}. One question is categorical, binary, or ordered.`,
      "/question/kind",
    );
  }
  requireText(question.question, "/question/question", "the question wording");
  if (kind === "ordered") {
    const scale = question.scale;
    if (!Array.isArray(scale) || scale.length < 2) {
      throw new ValidationError(
        "invalid_field_type",
        "The ordered question states no scale of at least two described levels.",
        "/question/scale",
      );
    }
    for (const [index, level] of scale.entries()) {
      if (!isPlainObject(level)) {
        throw new ValidationError(
          "invalid_field_type",
          `The scale level ${index} holds no object with one name and one description.`,
          `/question/scale/${index}`,
        );
      }
      requireText(level.name, `/question/scale/${index}/name`, `the name of the scale level ${index}`);
      requireText(
        level.description,
        `/question/scale/${index}/description`,
        `the description of the scale level ${index}`,
      );
    }
    return;
  }
  const answers: Record<string, unknown> = question.answers;
  if (!isPlainObject(answers)) {
    throw new ValidationError(
      "invalid_field_type",
      `The ${kind} question states no answers object.`,
      "/question/answers",
    );
  }
  if (kind === "binary") {
    requireText(answers["yes"], "/question/answers/yes", "the yes answer description");
    requireText(answers["no"], "/question/answers/no", "the no answer description");
    return;
  }
  const labels = Object.keys(answers);
  if (labels.length === 0) {
    throw new ValidationError(
      "invalid_field_type",
      "The categorical question states no answers.",
      "/question/answers",
    );
  }
  for (const label of labels) {
    requireText(answers[label], `/question/answers/${label}`, `the description of the answer ${label}`);
  }
}

/** Reads one nonempty string or fails with one field path. */
function requireText(value: unknown, fieldPath: string, what: string): void {
  if (typeof value !== "string" || value === "") {
    throw new ValidationError(
      "invalid_field_type",
      `The field ${fieldPath} must hold ${what} as one nonempty string.`,
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
