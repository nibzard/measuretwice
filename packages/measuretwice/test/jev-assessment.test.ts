// SPDX-License-Identifier: Apache-2.0
/**
 * Jev assessment normalization tests.
 *
 * These tests cover task T026: the Jev adapter normalizes one response of
 * the pinned SDK into one typed assessment with its operational record, or
 * into one operational failure that names the defect. Every case of
 * `fixtures/adapters/jev-normalization.json` runs through the adapter and
 * the dispatch contract, so the Rust core validates each normalized
 * assessment against its check. The responses come from the synthetic
 * provider fixtures, the clock is injected, and the Jev boundary is one
 * fake function, so every test stays offline: no SDK import, no credential,
 * no network access.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJevEvaluator,
  JEV_ADAPTER_VERSION,
  JEV_DEFAULT_MODEL,
  mapJevError,
  normalizeJevExecution,
  translateJevQuestion,
  type EvaluatorExecution,
  type EvaluatorFailure,
  type JevCall,
  type JevRequestOptions,
  type JevSystemOneRequest,
  type JSONValue,
  type ValidatedQuestion,
} from "../src/index.js";
import { dispatchAssessment } from "../src/evaluator.js";
import { nativeValidateCase, nativeValidateDefinition } from "../src/native.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The normalization fixture, the one source of truth for this suite. */
const doc = JSON.parse(
  readFileSync(path.join(repoRoot, "fixtures", "adapters", "jev-normalization.json"), "utf8"),
) as {
  cases: {
    note: string;
    origin: string;
    provider_case: string;
    check: string;
    using: string[];
    question: ValidatedQuestion;
    case_input: Record<string, JSONValue>;
    response: {
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      answers: Record<string, Record<string, unknown>>;
    };
    expected: {
      assessment?: Record<string, unknown>;
      failure?: { code: string; message_contains: string };
      record_fields?: string[];
    };
  }[];
  rules: { never_invented: string[] };
};

/** The synthetic provider fixtures, for the referenced response records. */
const providerCases = JSON.parse(
  readFileSync(path.join(repoRoot, "providers", "jev", "fixtures", "responses.json"), "utf8"),
) as { cases: { id: string; response: unknown }[] };

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** The elapsed time of every fake Jev call, in milliseconds. */
const CALL_MS = 1500;

/** The budget of every dispatched request in this suite. */
const BUDGET = { attempt: 1, max_attempts: 2, deadline_at_ms: START_MS + 30000 };

/** One mutable fake clock. */
function clock(): { now: () => number; advance(ms: number): void } {
  let time = START_MS;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** Builds one definition artifact that declares the question of one case. */
function definitionOf(record: (typeof doc.cases)[number]): string {
  const properties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record.case_input)) {
    properties[name] = Array.isArray(value)
      ? { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
      : { type: "string", minLength: 1 };
  }
  const question = record.question;
  const check: Record<string, unknown> = {
    id: record.check,
    name: "The normalized question of the fixture case",
    using: record.using,
    question: question.question,
  };
  if (question.kind === "ordered") {
    check.scale = question.scale.map((level) => ({ [level.name]: level.description }));
    check.accept = { at_least: question.scale[question.scale.length - 1]!.name };
  } else {
    check.answers = question.answers;
    check.accept = question.kind === "binary" ? "yes" : Object.keys(question.answers)[0];
  }
  return JSON.stringify({
    schema_version: 1,
    name: "jev-normalization-case",
    inputs: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    checks: [check],
  });
}

/** One recorded fake Jev boundary that answers with one fixed response. */
interface FakeBoundary {
  readonly requests: JevSystemOneRequest[];
  readonly options: (JevRequestOptions | undefined)[];
  readonly call: JevCall;
}

/** Builds one fake Jev boundary that advances the clock and answers. */
function boundary(response: () => unknown, time: { advance(ms: number): void }): FakeBoundary {
  const requests: JevSystemOneRequest[] = [];
  const options: (JevRequestOptions | undefined)[] = [];
  return {
    requests,
    options,
    call: async (request, callOptions) => {
      requests.push(request);
      options.push(callOptions);
      time.advance(CALL_MS);
      return response();
    },
  };
}

/** Drives one fixture case through the adapter and the dispatch contract. */
async function dispatchCase(
  record: (typeof doc.cases)[number],
  fake: FakeBoundary,
  time: { now(): number },
  signal: AbortSignal = new AbortController().signal,
): Promise<EvaluatorExecution> {
  const definitionText = definitionOf(record);
  const artifact = JSON.parse(definitionText);
  const info = nativeValidateDefinition(definitionText);
  const caseInfo = nativeValidateCase(
    definitionText,
    JSON.stringify({ id: "normalization-case-1", input: record.case_input }),
  );
  const projected = caseInfo.projectedInputs.find((entry) => entry.checkId === record.check)
    ?.inputs as Readonly<Record<string, JSONValue>>;
  const evaluator = createJevEvaluator({ call: fake.call, now: time.now });
  expect(evaluator.id).toBe("jev");
  expect(evaluator.adapter_version).toBe(JEV_ADAPTER_VERSION);
  return dispatchAssessment({
    artifact,
    checkKinds: info.checkKinds,
    checkId: record.check,
    projectedInputs: projected,
    evaluator,
    budget: BUDGET,
    signal,
  });
}

/** Narrows one execution to its failure. */
function failureOf(result: EvaluatorExecution): EvaluatorFailure {
  if (!("failure" in result)) {
    throw new Error("expected one failure execution");
  }
  return result.failure;
}

// ---------------------------------------------------------------------------
// The fixture cases through the adapter and the dispatch contract.
// ---------------------------------------------------------------------------

test("every normalization case reproduces its expected execution", async () => {
  expect(doc.cases.length).toBeGreaterThanOrEqual(20);
  const seenCodes = new Set<string>();
  for (const record of doc.cases) {
    const note = record.note;
    const time = clock();
    const fake = boundary(() => record.response, time);
    const result = await dispatchCase(record, fake, time);

    if (record.expected.assessment !== undefined) {
      if (!("assessment" in result)) {
        throw new Error(`${note}: expected one assessment execution`);
      }
      expect(result.assessment, note).toEqual(record.expected.assessment);
      // The operational record keeps what the call measured.
      expect(result.model_resolved, note).toBe(record.response.model);
      expect(result.usage, note).toEqual(record.response.usage);
      expect(result.latency_ms, note).toBe(CALL_MS);
      expect(Object.isFrozen(result.assessment), note).toBe(true);
    } else {
      const failure = failureOf(result);
      const wanted = record.expected.failure!;
      expect(failure.code, note).toBe(wanted.code);
      expect(failure.message, note).toContain(wanted.message_contains);
      seenCodes.add(failure.code);
      // The record keeps exactly the fields the case states, and no more.
      const kept = record.expected.record_fields ?? [
        "latency_ms",
        "model_resolved",
        "usage",
      ];
      for (const field of ["latency_ms", "model_resolved", "usage"]) {
        const present = (result as unknown as Record<string, unknown>)[field] !== undefined;
        expect(present, `${note}: ${field}`).toBe(kept.includes(field));
      }
      expect(result.latency_ms, note).toBe(CALL_MS);
    }
    expect(fake.requests, note).toHaveLength(1);
    expect(Object.isFrozen(result), note).toBe(true);
  }
  expect([...seenCodes].sort()).toEqual(["invalid_assessment"]);
}, 20000);

test("each case response matches its provider fixture record", () => {
  const byId = new Map(providerCases.cases.map((record) => [record.id, record.response]));
  const referenced = new Set<string>();
  for (const record of doc.cases) {
    referenced.add(record.provider_case);
    // The synthetic-variant case changes one field on purpose; every other
    // case normalizes the provider response. The answer arrives under the
    // check identifier of the case, because one real response echoes the
    // key of the request and the adapter keys its question by the check.
    const source = byId.get(record.provider_case) as {
      model?: string;
      usage?: unknown;
      answers: Record<string, unknown>;
    };
    const sourceKey = record.check.replace(/-/g, "_");
    if (record.origin !== "synthetic-variant") {
      expect(record.response.model, record.note).toEqual(source.model);
      expect(record.response.usage, record.note).toEqual(source.usage);
      expect(record.response.answers[record.check], record.note).toEqual(source.answers[sourceKey]);
    }
    expect(record.response.answers[record.check], record.note).toBeDefined();
  }
  // The group covers every provider case except one: one check whose
  // answers are exactly yes and no is binary and translates to Noul, so no
  // Choice question of this translation carries those labels.
  expect(referenced.has("choice-two-labels-null-criteria")).toBe(false);
  expect(referenced.size).toBe(providerCases.cases.length - 1);
});

test("the adapter sends the pinned translation inside the evidence envelope", async () => {
  const record = doc.cases[0]!;
  const time = clock();
  const fake = boundary(() => record.response, time);
  const controller = new AbortController();
  await dispatchCase(record, fake, time, controller.signal);

  const request = fake.requests[0]!;
  expect(Object.keys(request.questions)).toEqual([record.check]);
  expect(request.questions[record.check]).toEqual(
    translateJevQuestion(record.question).question,
  );
  expect(request.model).toBe(JEV_DEFAULT_MODEL);
  // The state frames exactly the projected inputs under the fixed key.
  expect(request.state).toEqual({ evidence: record.case_input });
  const text = JSON.stringify(request);
  expect(text).not.toContain("normalization-case-1");

  // The boundary receives the caller signal, one attempt timeout that
  // covers the remaining budget, and one retry policy that disables the
  // SDK retry loop: the wrapper scheduler owns the attempts, so one
  // wrapper attempt is one SDK request.
  const options = fake.options[0]!;
  expect(options.signal).toBe(controller.signal);
  expect(options.timeout).toBe(30000);
  expect(options.retry).toEqual({ maxRetries: 0 });
});

test("one requested model override reaches the boundary", async () => {
  const record = doc.cases[0]!;
  const time = clock();
  const fake = boundary(() => record.response, time);
  const definitionText = definitionOf(record);
  const artifact = JSON.parse(definitionText);
  const info = nativeValidateDefinition(definitionText);
  const caseInfo = nativeValidateCase(
    definitionText,
    JSON.stringify({ id: "normalization-case-1", input: record.case_input }),
  );
  const projected = caseInfo.projectedInputs.find((entry) => entry.checkId === record.check)
    ?.inputs as Readonly<Record<string, JSONValue>>;
  await dispatchAssessment({
    artifact,
    checkKinds: info.checkKinds,
    checkId: record.check,
    projectedInputs: projected,
    evaluator: createJevEvaluator({
      call: fake.call,
      now: time.now,
      model: "jev-1.12.9",
      id: "jev-pinned",
      adapter_version: "0.2.0",
    }),
    budget: BUDGET,
    signal: new AbortController().signal,
  });
  expect(fake.requests[0]!.model).toBe("jev-1.12.9");
});

// ---------------------------------------------------------------------------
// The normalization rules, directly.
// ---------------------------------------------------------------------------

test("one Noul value of one half selects yes and one tie between levels selects the higher level", () => {
  const binary: ValidatedQuestion = {
    kind: "binary",
    question: "Does the evidence support the claim?",
    answers: { yes: "The evidence states the fact.", no: "The evidence does not." },
  };
  const tie = normalizeJevExecution(
    {
      model: "jev-1.13.0",
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: { check: { type: "noul", noul: 0.5 } },
    },
    binary,
    "check",
    5,
  );
  if (!("assessment" in tie)) {
    throw new Error("expected one assessment execution");
  }
  expect(tie.assessment).toEqual({ kind: "binary", value: true });
  expect("confidence" in tie.assessment).toBe(false);

  const ordered: ValidatedQuestion = {
    kind: "ordered",
    question: "How severe is the reported problem?",
    scale: [
      { name: "minor", description: "No consequence." },
      { name: "meaningful", description: "One coordination problem." },
      { name: "serious", description: "One conflict." },
      { name: "critical", description: "One outage." },
    ],
  };
  const between = normalizeJevExecution(
    {
      model: "jev-1.13.0",
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: {
        check: {
          type: "score",
          score: 2.5,
          confidence: 0.7,
          legend: {},
          probabilities: { "0": 0.1, "1": 0.2, "2": 0.3, "3": 0.4 },
        },
      },
    },
    ordered,
    "check",
    5,
  );
  if (!("assessment" in between)) {
    throw new Error("expected one assessment execution");
  }
  expect(between.assessment.level).toBe("critical");
  expect(between.assessment.position).toBe(2.5);
});

test("the normalization rejects one response outside the recorded shapes", () => {
  const categorical: ValidatedQuestion = {
    kind: "categorical",
    question: "What is this ticket about?",
    answers: { billing: "Charges.", technical: "The product." },
  };
  const table: readonly { note: string; result: unknown; message: string }[] = [
    { note: "one response that holds no object", result: "one text", message: "holds no object" },
    { note: "one answer that holds no object", result: {
      model: "jev-1.13.0",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: { check: "billing" },
    }, message: "holds no object" },
    { note: "one response without one answer for the check", result: {
      model: "jev-1.13.0",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: { other: { type: "choice", choice: "billing" } },
    }, message: "no answer for the check" },
    { note: "one distribution that omits one declared label", result: {
      model: "jev-1.13.0",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        check: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 1 } },
      },
    }, message: "is incomplete" },
    { note: "one confidence outside the unit interval", result: {
      model: "jev-1.13.0",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        check: {
          type: "choice",
          choice: "billing",
          confidence: 1.4,
          probabilities: { billing: 0.5, technical: 0.5 },
        },
      },
    }, message: "confidence" },
    { note: "one Noul answer for one categorical question", result: {
      model: "jev-1.13.0",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: { check: { type: "noul", noul: 0.9 } },
    }, message: "cannot serve the categorical" },
    { note: "one distribution that names one undeclared answer", result: {
      model: "jev-1.13.0",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        check: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.5, technical: 0.4, urgent: 0.1 },
        },
      },
    }, message: "does not declare" },
  ];
  for (const record of table) {
    const outcome = normalizeJevExecution(record.result, categorical, "check", 5);
    if (!("failure" in outcome)) {
      throw new Error(`${record.note}: the response was accepted`);
    }
    expect(outcome.failure.code, record.note).toBe("invalid_assessment");
    expect(outcome.failure.message, record.note).toContain(record.message);
  }
});

// ---------------------------------------------------------------------------
// Provider failures, cancellation, and the deadline.
// ---------------------------------------------------------------------------

/** Builds one provider-shaped error with one hostile message. */
function providerError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, extra);
}

test("provider errors map to sanitized failures that keep the operational reason", () => {
  const hostile =
    "429 too many requests body: the ticket text 'I was charged twice for one order' with key sk-SECRET-123";
  const rate = mapJevError(
    providerError("RateLimitError", hostile, { status: 429, requestId: "req-4711" }),
  );
  expect(rate.code).toBe("evaluator_error");
  expect(rate.message).toContain("RateLimitError");
  expect(rate.message).toContain("429");
  expect(rate.message).toContain("req-4711");
  // The provider message never crosses: it can quote case content and
  // credentials.
  expect(rate.message).not.toContain("charged twice");
  expect(rate.message).not.toContain("sk-SECRET-123");

  const timeout = mapJevError(providerError("APITimeoutError", hostile, { status: undefined }));
  expect(timeout.code).toBe("evaluator_timeout");
  expect(timeout.message).toContain("APITimeoutError");
  expect(timeout.message).not.toContain("charged twice");

  const abort = mapJevError(providerError("APIUserAbortError", "Request was aborted."));
  expect(abort.code).toBe("evaluator_timeout");
  expect(abort.message).toContain("aborted");

  const plainAbort = mapJevError(providerError("AbortError", "This operation was aborted"));
  expect(plainAbort.code).toBe("evaluator_timeout");

  const notAnError = mapJevError("the connection melted");
  expect(notAnError.code).toBe("evaluator_error");
  expect(notAnError.message).toContain("an unknown error value");

  // One overlong request identifier is bounded, and control characters
  // never enter the text.
  const noisy = mapJevError(
    providerError("InternalServerError", hostile, {
      status: 500,
      requestId: `r${"x".repeat(400)}\n${"y".repeat(10)}`,
    }),
  );
  expect(Array.from(noisy.message).length).toBeLessThanOrEqual(500);
  expect(noisy.message).not.toContain("\n");
});

test("one thrown provider error reaches the dispatch contract as one failure", async () => {
  const record = doc.cases[0]!;
  const time = clock();
  const fake = boundary(() => {
    throw providerError("APIConnectionError", "fetch failed for ticket 4471", {
      requestId: "req-1",
    });
  }, time);
  const result = await dispatchCase(record, fake, time);
  const failure = failureOf(result);
  expect(failure.code).toBe("evaluator_error");
  expect(failure.message).toContain("APIConnectionError");
  expect(failure.message).not.toContain("4471");
  expect(result.latency_ms).toBe(CALL_MS);
});

test("one aborted signal and one spent deadline stop the adapter before one call", async () => {
  const record = doc.cases[0]!;

  const abortedTime = clock();
  const abortedBoundary = boundary(() => record.response, abortedTime);
  const controller = new AbortController();
  controller.abort();
  const aborted = await dispatchCase(record, abortedBoundary, abortedTime, controller.signal);
  expect(failureOf(aborted).code).toBe("evaluator_timeout");
  expect(failureOf(aborted).message).toContain("aborted");
  expect(abortedBoundary.requests).toHaveLength(0);

  const spentTime = {
    now: () => BUDGET.deadline_at_ms + 1,
    advance: () => undefined,
  };
  const spentBoundary = boundary(() => record.response, spentTime);
  const spent = await dispatchCase(record, spentBoundary, spentTime);
  expect(failureOf(spent).code).toBe("evaluator_timeout");
  expect(failureOf(spent).message).toContain("deadline");
  expect(spentBoundary.requests).toHaveLength(0);
});

test("one answer that arrives after one abort is dropped", async () => {
  const record = doc.cases[0]!;
  const time = clock();
  const controller = new AbortController();
  const fake: FakeBoundary = {
    requests: [],
    options: [],
    call: async (request, callOptions) => {
      fake.requests.push(request);
      fake.options.push(callOptions);
      time.advance(CALL_MS);
      controller.abort();
      return record.response;
    },
  };
  const result = await dispatchCase(record, fake, time, controller.signal);
  expect(failureOf(result).code).toBe("evaluator_timeout");
  expect(failureOf(result).message).toContain("aborted");
  expect(result.latency_ms).toBe(CALL_MS);
});

test("no failure message quotes one case input of the fixture cases", async () => {
  const secrets: string[] = [];
  for (const record of doc.cases) {
    for (const value of Object.values(record.case_input)) {
      if (typeof value === "string" && value.length >= 12) {
        secrets.push(value);
      }
    }
  }
  expect(secrets.length).toBeGreaterThan(5);
  const time = clock();
  const fake = boundary(() => {
    throw providerError("InternalServerError", `body echoed ${secrets[0]}`, { status: 500 });
  }, time);
  const record = doc.cases[0]!;
  const result = await dispatchCase(record, fake, time);
  const message = failureOf(result).message;
  for (const secret of secrets) {
    expect(message, secret.slice(0, 24)).not.toContain(secret);
  }
});

// ---------------------------------------------------------------------------
// What the adapter never invents.
// ---------------------------------------------------------------------------

test("the normalization invents no measurement the response does not state", async () => {
  const noul = doc.cases.find(
    (record) => record.provider_case === "noul-carries-confidence",
  )!;
  const time = clock();
  const fake = boundary(() => noul.response, time);
  const result = await dispatchCase(noul, fake, time);
  if (!("assessment" in result)) {
    throw new Error("expected one assessment execution");
  }
  // The hostile confidence field of the response is consumed by nothing.
  expect(Object.keys(result.assessment)).toEqual(["kind", "value"]);
  const text = JSON.stringify(result);
  for (const absent of ["confidence", "distribution", "position", "evidence", "legend"]) {
    expect(text, absent).not.toContain(`"${absent}"`);
  }
  // The recorded usage is the response usage, not one derived amount.
  expect(result.usage).toEqual(noul.response.usage);
});
