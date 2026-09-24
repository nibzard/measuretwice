// SPDX-License-Identifier: Apache-2.0
/**
 * Test evaluators for the evaluator execution contract.
 *
 * Two shipped adapters prove that the contract needs no Jev response
 * shape. `createScriptedEvaluator` builds one fake adapter that answers
 * through one scripted control list. `createLabelOnlyEvaluator` builds
 * one adapter that answers from one fixed table of check answers. Both
 * stay offline, hold no credential, and contact no provider. Hosts use
 * them to exercise one integration without API spend. The repository
 * drives them with the adapter conformance cases in
 * `fixtures/adapters/conformance.json`, which the later Python wrapper
 * must reproduce.
 *
 * The scripted adapter offers one control per step: one valid execution,
 * one raw malformed resolution, one thrown error, or one delayed
 * response. It records every request, validates the whole script before
 * the first call, and fails with one explicit error when the script runs
 * out, so one test never sees one invented answer.
 *
 * The label-only adapter returns exactly the answer kind and the selected
 * answer. It reports no confidence, no distribution, no usage amount, and
 * no evidence reference, so one absent measurement stays absent through
 * the complete path.
 *
 * `labelRuleChecks` and `decideLabelOnly` form the separately specified
 * test decision rule for label-only assessments. The selected answer
 * decides against the accept and review sets of the check meaning alone.
 * The rule reads no confidence and no cutoff, because one label-only
 * adapter reports none. Replacing one evaluator with another changes no
 * part of the rule and no part of the definition.
 */
import type { AnswerKind, Assessment, Evaluator, EvaluatorExecution, EvaluatorRequest } from "./evaluator.js";
import type { CheckDefinition, Definition } from "./define-checks.js";
import { ValidationError } from "./error.js";

/** The default identifier of the scripted adapter, as the fixtures state it. */
const SCRIPTED_ID = "scripted-test";

/** The default identifier of the label-only adapter, as the fixtures state it. */
const LABEL_ONLY_ID = "label-only-test";

/** The default adapter version of both test adapters, as the fixtures state it. */
const ADAPTER_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// The scripted adapter.
// ---------------------------------------------------------------------------

/**
 * One scripted control of the fake adapter.
 *
 * State exactly one of `answer`, `raw`, and `error`:
 *
 * - `answer` resolves as one valid execution: one assessment or one
 *   operational failure.
 * - `raw` resolves as the stated value, outside the contract, so the
 *   dispatch normalization must map it to one `evaluator_error` failure.
 * - `error` throws the stated error, so the dispatch normalization must
 *   map it to one `evaluator_error` failure that keeps the cause.
 *
 * `delay_ms` waits before the step resolves, through the injected sleep.
 * The delay control lets one test observe one response that arrives late.
 */
export type TestEvaluatorControl =
  | { readonly answer: EvaluatorExecution; readonly delay_ms?: number }
  | { readonly raw: unknown; readonly delay_ms?: number }
  | { readonly error: Error | string; readonly delay_ms?: number };

/** The options of the scripted adapter. */
export interface ScriptedEvaluatorOptions {
  /** One identifier that overrides the default `scripted-test`. */
  readonly id?: string;
  /** One adapter version that overrides the default `0.1.0`. */
  readonly adapter_version?: string;
  /** The control list, answered in order. One call consumes one step. */
  readonly steps: readonly TestEvaluatorControl[];
  /** The sleep of the delay control. Inject one fake to stay offline. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The scripted adapter, with the recorded requests and the script state. */
export interface ScriptedEvaluator extends Evaluator {
  /** Every request seen so far, in call order. */
  readonly calls: readonly EvaluatorRequest[];
  /** Returns the number of scripted steps not used yet. */
  remaining(): number;
}

/** The default sleep of the delay control: one ordinary timer. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Returns true when the value is one plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Creates one fake adapter that answers through one scripted control list.
 *
 * The adapter never contacts one provider. It validates the whole script
 * when it is created, so one malformed control fails before any dispatch.
 * It checks the cancellation signal at entry: one already aborted signal
 * returns one `evaluator_timeout` failure and consumes no step. One delay
 * in flight is owned by the injected sleep, so one test can produce one
 * response that arrives after one abort.
 *
 * @throws {ValidationError} when one step states no single control, one
 * unreadable answer, one empty error, or one negative delay.
 */
export function createScriptedEvaluator(options: ScriptedEvaluatorOptions): ScriptedEvaluator {
  const steps = [...options.steps];
  for (const [index, step] of steps.entries()) {
    validateControl(step, index);
  }
  const sleep = options.sleep ?? defaultSleep;
  const calls: EvaluatorRequest[] = [];
  return {
    id: options.id ?? SCRIPTED_ID,
    adapter_version: options.adapter_version ?? ADAPTER_VERSION,
    calls,
    remaining: () => steps.length,
    async assess(request: EvaluatorRequest): Promise<EvaluatorExecution> {
      calls.push(request);
      if (request.signal.aborted) {
        return Object.freeze({
          failure: Object.freeze({
            code: "evaluator_timeout" as const,
            message:
              "The scripted evaluator saw one aborted signal before it started. No scripted step was used.",
          }),
        });
      }
      const step = steps.shift();
      if (step === undefined) {
        throw new Error(
          `the scripted evaluator ran out of scripted answers after ${calls.length} calls`,
        );
      }
      if (step.delay_ms !== undefined && step.delay_ms > 0) {
        await sleep(step.delay_ms);
      }
      if ("error" in step) {
        const cause = step.error;
        throw cause instanceof Error ? cause : new Error(cause);
      }
      if ("raw" in step) {
        return step.raw as EvaluatorExecution;
      }
      return step.answer;
    },
  };
}

/** Validates one scripted control at creation time. */
function validateControl(step: TestEvaluatorControl, index: number): void {
  const base = `/steps/${index}`;
  if (!isPlainObject(step)) {
    throw new ValidationError(
      "invalid_field_type",
      `The control at ${base} is not one object. State one answer, one raw resolution, or one error.`,
      base,
    );
  }
  const present = ["answer", "raw", "error"].filter((name) =>
    Object.prototype.hasOwnProperty.call(step, name),
  );
  if (present.length !== 1) {
    throw new ValidationError(
      "invalid_field_type",
      `The control at ${base} states ${present.length} controls. State exactly one of answer, raw, and error.`,
      base,
    );
  }
  const single = present[0] as "answer" | "raw" | "error";
  if (single === "answer") {
    const answer: unknown = (step as { answer?: unknown }).answer;
    if (!isPlainObject(answer)) {
      throw new ValidationError(
        "invalid_field_type",
        `The answer control at ${base} holds no execution object. State one assessment or one failure.`,
        `${base}/answer`,
      );
    }
  }
  if (single === "error") {
    const cause: unknown = (step as { error?: unknown }).error;
    if (!(cause instanceof Error) && !(typeof cause === "string" && cause !== "")) {
      throw new ValidationError(
        "invalid_field_type",
        `The error control at ${base} holds neither one Error nor one nonempty string.`,
        `${base}/error`,
      );
    }
  }
  const delay = step.delay_ms;
  if (delay !== undefined && !(typeof delay === "number" && Number.isFinite(delay) && delay >= 0)) {
    throw new ValidationError(
      "invalid_field_type",
      `The delay at ${base}/delay_ms must hold one finite number of at least zero.`,
      `${base}/delay_ms`,
    );
  }
}

// ---------------------------------------------------------------------------
// The label-only adapter.
// ---------------------------------------------------------------------------

/** One answer of the label-only adapter: one label, one level, or one yes/no value. */
export type LabelOnlyAnswer = string | boolean;

/** The options of the label-only adapter. */
export interface LabelOnlyEvaluatorOptions {
  /** One identifier that overrides the default `label-only-test`. */
  readonly id?: string;
  /** One adapter version that overrides the default `0.1.0`. */
  readonly adapter_version?: string;
  /** The scripted answer of each check, by check identifier. */
  readonly answers: Readonly<Record<string, LabelOnlyAnswer>>;
}

/** The label-only adapter, with the recorded requests. */
export interface LabelOnlyEvaluator extends Evaluator {
  /** Every request seen so far, in call order. */
  readonly calls: readonly EvaluatorRequest[];
}

/**
 * Creates one label-only adapter that answers from one fixed table.
 *
 * The adapter reads the validated question of the request and returns one
 * assessment that holds exactly the answer kind and the selected answer.
 * It invents nothing: one absent scripted answer, one answer of the wrong
 * type, and one answer that the check does not declare each return one
 * `evaluator_error` failure with one explicit message. No returned
 * assessment carries one confidence, one distribution, one position, or
 * one evidence reference, and no execution carries one usage amount.
 */
export function createLabelOnlyEvaluator(options: LabelOnlyEvaluatorOptions): LabelOnlyEvaluator {
  const answers: Readonly<Record<string, LabelOnlyAnswer>> = { ...options.answers };
  const calls: EvaluatorRequest[] = [];
  return {
    id: options.id ?? LABEL_ONLY_ID,
    adapter_version: options.adapter_version ?? ADAPTER_VERSION,
    calls,
    async assess(request: EvaluatorRequest): Promise<EvaluatorExecution> {
      calls.push(request);
      if (!Object.prototype.hasOwnProperty.call(answers, request.check)) {
        return labelFailure(
          `The label-only evaluator holds no scripted answer for the check ${JSON.stringify(request.check)}. It invents no answer.`,
        );
      }
      const answer = answers[request.check] as LabelOnlyAnswer;
      const question = request.question;
      if (question.kind === "binary") {
        if (typeof answer !== "boolean") {
          return labelFailure(
            `The check ${JSON.stringify(request.check)} asks one binary question, but its scripted answer is one ${describe(answer)}. Supply one boolean: true for yes and false for no.`,
          );
        }
        return execution({ kind: "binary", value: answer });
      }
      if (typeof answer !== "string") {
        return labelFailure(
          `The check ${JSON.stringify(request.check)} asks one ${question.kind} question, but its scripted answer is one ${describe(answer)}. Supply one ${question.kind === "ordered" ? "level" : "label"} as one string.`,
        );
      }
      if (question.kind === "ordered") {
        if (!question.scale.some((level) => level.name === answer)) {
          return labelFailure(
            `The scripted answer ${JSON.stringify(answer)} names no declared level of the ordered scale of the check ${JSON.stringify(request.check)}.`,
          );
        }
        return execution({ kind: "ordered", level: answer });
      }
      if (!Object.prototype.hasOwnProperty.call(question.answers, answer)) {
        return labelFailure(
          `The scripted answer ${JSON.stringify(answer)} names no declared answer of the check ${JSON.stringify(request.check)}.`,
        );
      }
      return execution({ kind: "categorical", label: answer });
    },
  };
}

/** Names the JavaScript type of one answer for one explicit failure message. */
function describe(answer: LabelOnlyAnswer): string {
  return typeof answer === "string" ? "string" : "boolean";
}

/** Builds one frozen execution that holds one label-only assessment. */
function execution(assessment: Assessment): EvaluatorExecution {
  return Object.freeze({ assessment: Object.freeze({ ...assessment }) });
}

/** Builds one frozen operational failure of the label-only adapter. */
function labelFailure(message: string): EvaluatorExecution {
  return Object.freeze({
    failure: Object.freeze({ code: "evaluator_error" as const, message }),
  });
}

// ---------------------------------------------------------------------------
// The separately specified decision rule for label-only assessments.
// ---------------------------------------------------------------------------

/** The resolved check meaning that the label-only decision rule reads. */
export interface LabelRuleCheck {
  /** The assessed check identifier. */
  readonly check: string;
  /** The answer kind of the check. */
  readonly kind: AnswerKind;
  /** Every acceptable label or level, in declaration order. */
  readonly accept: readonly string[];
  /** Every review label or level. The contract keeps it disjoint from `accept`. */
  readonly review: readonly string[];
}

/**
 * Resolves the label rule check of every question of one validated
 * definition.
 *
 * Scale acceptance expands `accept.at_least` over the declared order, so
 * one higher level stays acceptable. Exact rules hold no question, so they
 * never appear. The definition itself stays unchanged: this helper only
 * reads it.
 */
export function labelRuleChecks(definition: Definition): readonly LabelRuleCheck[] {
  const checks: LabelRuleCheck[] = [];
  for (const check of definition.checks) {
    if (check.question === undefined) {
      continue;
    }
    const levels = (check.scale ?? []).map((level) => Object.keys(level)[0]!);
    const labels = check.answers !== undefined ? Object.keys(check.answers) : levels;
    const kind: AnswerKind =
      check.scale !== undefined
        ? "ordered"
        : labels.length === 2 && labels.includes("yes") && labels.includes("no")
          ? "binary"
          : "categorical";
    checks.push({ check: check.id, kind, accept: acceptOf(check, levels), review: reviewOf(check) });
  }
  return checks;
}

/** Resolves the acceptable labels or levels of one check. */
function acceptOf(check: CheckDefinition, levels: readonly string[]): string[] {
  const accept = check.accept;
  if (accept === undefined) {
    return [];
  }
  if (typeof accept === "string") {
    return [accept];
  }
  if (Array.isArray(accept)) {
    return [...accept];
  }
  const scale = accept as { at_least: string };
  const start = levels.indexOf(scale.at_least);
  return start < 0 ? [] : levels.slice(start);
}

/** Resolves the review labels or levels of one check. */
function reviewOf(check: CheckDefinition): string[] {
  const review = check.review;
  if (review === undefined) {
    return [];
  }
  return typeof review === "string" ? [review] : [...review];
}

/**
 * Decides one label-only assessment with the separately specified test
 * decision rule.
 *
 * One acceptable label or level passes. One declared review label or level
 * reviews. Every other declared answer fails. The rule reads the selected
 * answer and nothing else: no confidence, no distribution, and no cutoff
 * can change the outcome, because one label-only adapter reports none.
 *
 * @throws {ValidationError} when the assessment states no selected
 * answer. The Rust assessment validation owns that rejection.
 */
export function decideLabelOnly(
  check: LabelRuleCheck,
  assessment: Assessment,
): "pass" | "fail" | "review" {
  const selected = selectedAnswerOf(assessment);
  if (selected === undefined) {
    throw new ValidationError(
      "invalid_assessment",
      `The assessment of the check ${JSON.stringify(check.check)} states no selected answer. The label-only decision rule decides one selected label, value, or level.`,
      "/assessment",
    );
  }
  if (check.accept.includes(selected)) {
    return "pass";
  }
  if (check.review.includes(selected)) {
    return "review";
  }
  return "fail";
}

/** Reads the selected answer of one assessment: one label, one level, or one yes/no value. */
function selectedAnswerOf(assessment: Assessment): string | undefined {
  if (assessment.label !== undefined) {
    return assessment.label;
  }
  if (assessment.level !== undefined) {
    return assessment.level;
  }
  if (typeof assessment.value === "boolean") {
    return assessment.value ? "yes" : "no";
  }
  return undefined;
}
