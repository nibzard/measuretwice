// SPDX-License-Identifier: Apache-2.0
/**
 * Evaluator contract tests.
 *
 * These tests cover the registration and execution contract of task T022:
 * one host registers evaluator adapters with stable identities, one bound
 * profile names only registered evaluators, and one dispatched request
 * carries the validated question, the projected inputs of `using`, one
 * execution budget, and one cancellation signal. The returned assessment
 * stays exactly as the evaluator reported it: one label-only output keeps
 * its absent optional measurements, and one operational failure keeps its
 * stable code. The tests script every evaluator through the shared
 * `ScriptedBoundary`, so they stay offline and deterministic.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import {
  defineChecks,
  load,
  registerEvaluators,
  ValidationError,
  type Assessment,
  type Evaluator,
  type EvaluatorExecution,
  type EvaluatorFailure,
  type EvaluatorRequest,
  type FileAccess,
  type JSONValue,
} from "../src/index.js";
import { dispatchAssessment } from "../src/evaluator.js";
import { ScriptedBoundary } from "./support/deterministic.js";
import { nativeComputeSelfHash, nativeValidateCase, nativeValidateDefinition } from "../src/native.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Runs one operation and returns the public failure it must throw. */
async function failureOf(operation: () => unknown): Promise<ValidationError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("the operation was accepted");
}

/** Narrows one execution to its assessment. */
function assessmentOf(result: EvaluatorExecution): Assessment {
  if (!("assessment" in result)) {
    throw new Error("expected one assessment execution");
  }
  return result.assessment;
}

/** Narrows one execution to its failure. */
function failureOfExecution(result: EvaluatorExecution): EvaluatorFailure {
  if (!("failure" in result)) {
    throw new Error("expected one failure execution");
  }
  return result.failure;
}

/** One in-memory file access that records every read. */
function memoryFiles(files: Record<string, string>): FileAccess {
  return {
    async read(filePath: string): Promise<string> {
      const text = files[filePath];
      if (text === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      }
      return text;
    },
  };
}

/** One evaluator that answers through one scripted boundary. */
function scriptedEvaluator(
  id: string,
  adapterVersion: string,
  steps: readonly (EvaluatorExecution | Error)[],
): Evaluator & { calls: readonly EvaluatorRequest[]; remaining(): number } {
  const boundary = new ScriptedBoundary<EvaluatorRequest, EvaluatorExecution>([...steps]);
  return {
    id,
    adapter_version: adapterVersion,
    assess: (request) => boundary.call(request),
    calls: boundary.calls,
    remaining: () => boundary.remaining(),
  };
}

// ---------------------------------------------------------------------------
// One definition with one check of every question kind, and one case.
// ---------------------------------------------------------------------------

/** One definition with one categorical, one binary, and one ordered check. */
const questionChecks = defineChecks({
  version: 1,
  name: "typed-evaluator-questions",
  inputs: Type.Object(
    {
      prior_decision: Type.String({ minLength: 1 }),
      conversation: Type.String({ minLength: 1 }),
      proposed_message: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "message-supported",
      name: "Our message accurately describes the evidence",
      using: ["prior_decision", "conversation", "proposed_message"],
      question: "Does every material claim in the proposed message follow from the evidence?",
      answers: {
        supported: "All claims are supported.",
        contradicted: "A material claim conflicts with the supplied evidence.",
        incomplete: "Support for a material claim is missing.",
      },
      accept: "supported",
      review: "incomplete",
    },
    {
      id: "adds-information",
      name: "We are adding something new",
      using: ["conversation", "proposed_message"],
      question: "Has the conversation already acknowledged this concern?",
      answers: {
        yes: "One participant explicitly recognizes this specific concern.",
        no: "No supplied message explicitly recognizes this specific concern.",
      },
      accept: "no",
    },
    {
      id: "consequence",
      name: "The concern warrants an interruption",
      using: ["prior_decision", "conversation", "proposed_message"],
      question: "What consequence does this concern have, based on the evidence?",
      scale: [
        { minor: "One wording difference with no operational consequence." },
        { meaningful: "One coordination problem causing rework or delay." },
        { serious: "One conflict with one explicit customer commitment." },
      ],
      accept: { at_least: "meaningful" },
    },
  ],
});

/** One case for the question definition. Labels stay outside the input. */
const QUESTION_CASE = {
  id: "question-case",
  input: {
    prior_decision: "Customer exports stay in the EU.",
    conversation: "The team proposes one export worker in the US region.",
    proposed_message: "The export worker moves to the US region.",
  },
};

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** The budget of every dispatched request in this suite. */
const BUDGET = { attempt: 1, max_attempts: 2, deadline_at_ms: START_MS + 30000 };

/** The serialized definition artifact. */
function questionText(): string {
  return JSON.stringify(questionChecks);
}

/** Dispatches one question check of the shared definition to one evaluator. */
async function dispatch(
  evaluator: Evaluator,
  checkId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<EvaluatorExecution> {
  const info = nativeValidateDefinition(questionText());
  const caseInfo = nativeValidateCase(questionText(), JSON.stringify(QUESTION_CASE));
  const projected = caseInfo.projectedInputs.find((entry) => entry.checkId === checkId)
    ?.inputs as Readonly<Record<string, JSONValue>>;
  return dispatchAssessment({
    artifact: questionChecks,
    checkKinds: info.checkKinds,
    checkId,
    projectedInputs: projected,
    evaluator,
    budget: BUDGET,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Registration: stable identities, lookup, and rejection records.
// ---------------------------------------------------------------------------

test("registerEvaluators records stable identities and returns one frozen registry", () => {
  const first = scriptedEvaluator("jev-choice", "0.1.0", []);
  const second = scriptedEvaluator("jev-noul", "0.1.0", []);
  const registry = registerEvaluators(first, second);
  expect(registry.ids).toEqual(["jev-choice", "jev-noul"]);
  expect(registry.get("jev-choice")).toBe(first);
  expect(registry.get("jev-noul")).toBe(second);
  expect(registry.get("nowhere")).toBeUndefined();
  expect(Object.isFrozen(registry)).toBe(true);

  // One empty registration is one valid empty allowlist.
  const empty = registerEvaluators();
  expect(empty.ids).toEqual([]);
  expect(empty.get("jev-choice")).toBeUndefined();
});

test("registration rejects one evaluator outside the contract", async () => {
  const table: readonly {
    note: string;
    evaluator: unknown;
    code: string;
    fieldPath: string;
  }[] = [
    {
      note: "one identifier with one underscore",
      evaluator: { id: "jev_choice", adapter_version: "0.1.0", assess: () => Promise.resolve({}) },
      code: "invalid_field_type",
      fieldPath: "/evaluators/0/id",
    },
    {
      note: "one identifier with one uppercase segment",
      evaluator: { id: "jev-Choice", adapter_version: "0.1.0", assess: () => Promise.resolve({}) },
      code: "invalid_field_type",
      fieldPath: "/evaluators/0/id",
    },
    {
      note: "one identifier that starts with one digit",
      evaluator: { id: "1jev", adapter_version: "0.1.0", assess: () => Promise.resolve({}) },
      code: "invalid_field_type",
      fieldPath: "/evaluators/0/id",
    },
    {
      note: "one identifier above 64 characters",
      evaluator: {
        id: `jev-${"a".repeat(64)}`,
        adapter_version: "0.1.0",
        assess: () => Promise.resolve({}),
      },
      code: "invalid_field_type",
      fieldPath: "/evaluators/0/id",
    },
    {
      note: "one missing identifier",
      evaluator: { adapter_version: "0.1.0", assess: () => Promise.resolve({}) },
      code: "invalid_field_type",
      fieldPath: "/evaluators/0/id",
    },
    {
      note: "one empty adapter version",
      evaluator: { id: "jev-choice", adapter_version: "", assess: () => Promise.resolve({}) },
      code: "invalid_field_type",
      fieldPath: "/evaluators/0/adapter_version",
    },
    {
      note: "one adapter version that is not one string",
      evaluator: { id: "jev-choice", adapter_version: 1, assess: () => Promise.resolve({}) },
      code: "invalid_field_type",
      fieldPath: "/evaluators/0/adapter_version",
    },
    {
      note: "one missing assess operation",
      evaluator: { id: "jev-choice", adapter_version: "0.1.0" },
      code: "invalid_field_type",
      fieldPath: "/evaluators/0/assess",
    },
  ];
  for (const record of table) {
    const failure = await failureOf(() => registerEvaluators(record.evaluator as Evaluator));
    expect(failure.code, record.note).toBe(record.code);
    expect(failure.fieldPath, record.note).toBe(record.fieldPath);
    expect(failure.message, record.note).not.toBe("");
  }

  // Two adapters that share one identifier cannot both stay registered.
  const duplicate = await failureOf(() =>
    registerEvaluators(
      scriptedEvaluator("jev-choice", "0.1.0", []),
      scriptedEvaluator("jev-choice", "0.2.0", []),
    ),
  );
  expect(duplicate.code).toBe("duplicate_id");
  expect(duplicate.fieldPath).toBe("/evaluators/1/id");
});

// ---------------------------------------------------------------------------
// The dispatched request: validated question, projected inputs, budget, signal.
// ---------------------------------------------------------------------------

test("one categorical check delivers the validated question and only the authorized inputs", async () => {
  const evaluator = scriptedEvaluator("jev-choice", "0.1.0", [
    { assessment: { kind: "categorical", label: "supported" } },
  ]);
  await dispatch(evaluator, "message-supported");
  expect(evaluator.calls).toHaveLength(1);
  const request = evaluator.calls[0]!;
  expect(request.check).toBe("message-supported");
  expect(request.using).toEqual(["prior_decision", "conversation", "proposed_message"]);
  expect(request.question).toEqual({
    kind: "categorical",
    question: "Does every material claim in the proposed message follow from the evidence?",
    answers: {
      supported: "All claims are supported.",
      contradicted: "A material claim conflicts with the supplied evidence.",
      incomplete: "Support for a material claim is missing.",
    },
  });
  expect(request.inputs).toEqual(QUESTION_CASE.input);
  expect(request.budget).toEqual(BUDGET);
});

test("one check with one narrower using list receives only those inputs", async () => {
  const evaluator = scriptedEvaluator("jev-noul", "0.1.0", [
    { assessment: { kind: "binary", value: false } },
  ]);
  await dispatch(evaluator, "adds-information");
  const request = evaluator.calls[0]!;
  expect(request.using).toEqual(["conversation", "proposed_message"]);
  // The unauthorized input and the case identifier never reach the evaluator.
  expect(Object.keys(request.inputs)).toEqual(["conversation", "proposed_message"]);
  expect(request.inputs).toEqual({
    conversation: QUESTION_CASE.input.conversation,
    proposed_message: QUESTION_CASE.input.proposed_message,
  });
  const serialized = JSON.stringify(request.inputs);
  expect(serialized).not.toContain("prior_decision");
  expect(serialized).not.toContain("question-case");
  expect(request.question).toEqual({
    kind: "binary",
    question: "Has the conversation already acknowledged this concern?",
    answers: {
      yes: "One participant explicitly recognizes this specific concern.",
      no: "No supplied message explicitly recognizes this specific concern.",
    },
  });
});

test("one ordered check delivers the scale in its declared order", async () => {
  const evaluator = scriptedEvaluator("jev-score", "0.1.0", [
    { assessment: { kind: "ordered", level: "meaningful", position: 1.5 } },
  ]);
  await dispatch(evaluator, "consequence");
  const request = evaluator.calls[0]!;
  expect(request.question).toEqual({
    kind: "ordered",
    question: "What consequence does this concern have, based on the evidence?",
    scale: [
      { name: "minor", description: "One wording difference with no operational consequence." },
      { name: "meaningful", description: "One coordination problem causing rework or delay." },
      { name: "serious", description: "One conflict with one explicit customer commitment." },
    ],
  });
});

test("one dispatched request is plain data plus the passed cancellation signal", async () => {
  const evaluator = scriptedEvaluator("jev-choice", "0.1.0", [
    { assessment: { kind: "categorical", label: "supported" } },
  ]);
  const controller = new AbortController();
  await dispatch(evaluator, "message-supported", controller.signal);
  const request = evaluator.calls[0]!;
  expect(request.signal).toBe(controller.signal);
  const { signal, ...plain } = request;
  expect(signal.aborted).toBe(false);
  expect(Object.keys(plain).sort()).toEqual(["budget", "check", "inputs", "question", "using"]);
  // Everything beside the signal serializes as plain JSON data.
  expect(JSON.parse(JSON.stringify(plain))).toStrictEqual(plain);
  const text = JSON.stringify(plain).toLowerCase();
  for (const forbidden of ["credential", "token", "apikey", "secret"]) {
    expect(text, forbidden).not.toContain(forbidden);
  }
});

test("one aborted signal reaches the evaluator unchanged", async () => {
  const evaluator = scriptedEvaluator("jev-choice", "0.1.0", [
    { failure: { code: "evaluator_error", message: "The adapter saw the cancellation." } },
  ]);
  const controller = new AbortController();
  controller.abort();
  await dispatch(evaluator, "message-supported", controller.signal);
  expect(evaluator.calls[0]!.signal.aborted).toBe(true);
});

// ---------------------------------------------------------------------------
// Typed assessments and operational failures.
// ---------------------------------------------------------------------------

test("one label-only assessment returns unchanged with its optional measurements absent", async () => {
  const evaluator = scriptedEvaluator("jev-choice", "0.1.0", [
    { assessment: { kind: "categorical", label: "supported" } },
  ]);
  const result = await dispatch(evaluator, "message-supported");
  const assessment = assessmentOf(result);
  expect(assessment).toEqual({ kind: "categorical", label: "supported" });
  // No code invented one measurement that the evaluator did not report.
  expect(Object.keys(assessment)).toEqual(["kind", "label"]);
  for (const absent of ["value", "level", "position", "distribution", "confidence", "evidence"]) {
    expect(absent in assessment, absent).toBe(false);
  }
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(assessment)).toBe(true);
});

test("one assessment with every optional measurement returns unchanged", async () => {
  const assessment: Assessment = {
    kind: "ordered",
    level: "meaningful",
    position: 1.5,
    distribution: [
      { name: "minor", mass: 0.1 },
      { name: "meaningful", mass: 0.55 },
      { name: "serious", mass: 0.35 },
    ],
    confidence: 0.9,
    evidence: [{ input: "prior_decision", reference: "decision-2026-03" }],
  };
  const evaluator = scriptedEvaluator("jev-score", "0.1.0", [{ assessment }]);
  const result = await dispatch(evaluator, "consequence");
  // The fractional position stays unrounded and every measurement stays.
  expect(assessmentOf(result)).toStrictEqual(assessment);
});

test("one operational failure returns with its stable code and message", async () => {
  const evaluator = scriptedEvaluator("jev-choice", "0.1.0", [
    { failure: { code: "evaluator_timeout", message: "The provider did not answer inside the attempt budget." } },
  ]);
  const result = await dispatch(evaluator, "message-supported");
  expect(failureOfExecution(result)).toEqual({
    code: "evaluator_timeout",
    message: "The provider did not answer inside the attempt budget.",
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(failureOfExecution(result))).toBe(true);
});

test("one thrown adapter error becomes one operational failure", async () => {
  const evaluator = scriptedEvaluator("jev-choice", "0.1.0", [
    new Error("the provider connection refused the request"),
  ]);
  const result = await dispatch(evaluator, "message-supported");
  const failure = failureOfExecution(result);
  expect(failure.code).toBe("evaluator_error");
  expect(failure.message).toContain("the provider connection refused the request");
});

test("one malformed adapter resolution becomes one operational failure", async () => {
  const table: readonly { note: string; scripted: unknown }[] = [
    { note: "one missing result", scripted: undefined },
    { note: "one null result", scripted: null },
    { note: "one empty object", scripted: {} },
    { note: "one assessment that is not one object", scripted: { assessment: "supported" } },
    {
      note: "one assessment and one failure together",
      scripted: {
        assessment: { kind: "categorical", label: "supported" },
        failure: { code: "evaluator_error", message: "One failure." },
      },
    },
    { note: "one failure with one code outside the registry", scripted: { failure: { code: "provider_melted", message: "One failure." } } },
    { note: "one failure without one message", scripted: { failure: { code: "evaluator_timeout" } } },
  ];
  for (const record of table) {
    const evaluator = scriptedEvaluator("jev-choice", "0.1.0", [
      record.scripted as EvaluatorExecution,
    ]);
    const result = await dispatch(evaluator, "message-supported");
    const failure = failureOfExecution(result);
    expect(failure.code, record.note).toBe("evaluator_error");
    expect(failure.message, record.note).not.toBe("");
  }
});

test("one overlong failure message shortens to the sanitized reason limit", async () => {
  const evaluator = scriptedEvaluator("jev-choice", "0.1.0", [
    { failure: { code: "evaluator_error", message: "x".repeat(600) } },
  ]);
  const result = await dispatch(evaluator, "message-supported");
  const failure = failureOfExecution(result);
  expect(failure.code).toBe("evaluator_error");
  expect(Array.from(failure.message).length).toBe(500);
});

// ---------------------------------------------------------------------------
// Profile bindings against the registered evaluators.
// ---------------------------------------------------------------------------

/** The exploration profile fixture of the shared states. */
const EXPLORATION_PROFILE = JSON.parse(
  readFileSync(path.join(repoRoot, "fixtures", "profiles", "states.json"), "utf8"),
).profiles.find((profile: { id: string }) => profile.id === "message-supported-exploration") as Record<
  string,
  unknown
>;

/** Builds one exploration profile that binds the question definition. */
function boundProfile(): Record<string, unknown> {
  const info = nativeValidateDefinition(questionText());
  const artifact: Record<string, unknown> = {
    ...EXPLORATION_PROFILE,
    id: "typed-evaluator-questions-exploration",
    definition: { name: "typed-evaluator-questions", content_hash: info.definitionHash },
  };
  artifact["content_hash"] = nativeComputeSelfHash("profile", JSON.stringify(artifact));
  return artifact;
}

const PROFILE_PATH = "profiles/questions-exploration.json";

test("load rejects one profile that binds one evaluator outside the registry", async () => {
  const registry = registerEvaluators(scriptedEvaluator("test-choice", "0.1.0", []));
  const failure = await failureOf(() =>
    load(questionChecks, {
      profile: PROFILE_PATH,
      files: memoryFiles({ [PROFILE_PATH]: JSON.stringify(boundProfile()) }),
      evaluators: registry,
      now: () => START_MS,
    }),
  );
  expect(failure.code).toBe("evaluator_mismatch");
  expect(failure.fieldPath).toBe("/profile/bindings/0/evaluator");
  expect(failure.message).toContain("jev-choice");
});

test("load rejects one profile that binds one different adapter version", async () => {
  const registry = registerEvaluators(scriptedEvaluator("jev-choice", "0.2.0", []));
  const failure = await failureOf(() =>
    load(questionChecks, {
      profile: PROFILE_PATH,
      files: memoryFiles({ [PROFILE_PATH]: JSON.stringify(boundProfile()) }),
      evaluators: registry,
      now: () => START_MS,
    }),
  );
  expect(failure.code).toBe("evaluator_mismatch");
  expect(failure.fieldPath).toBe("/profile/bindings/0/adapter_version");
  expect(failure.message).toContain("0.1.0");
  expect(failure.message).toContain("0.2.0");
});

test("load binds one profile whose evaluator is registered, and run still refuses the question path", async () => {
  const evaluator = scriptedEvaluator("jev-choice", "0.1.0", []);
  const registry = registerEvaluators(evaluator);
  const reviewer = await load(questionChecks, {
    profile: PROFILE_PATH,
    files: memoryFiles({ [PROFILE_PATH]: JSON.stringify(boundProfile()) }),
    evaluators: registry,
    now: () => START_MS,
  });
  expect(reviewer.profile?.id).toBe("typed-evaluator-questions-exploration");
  expect(reviewer.profile?.bindings[0]?.evaluator).toBe("jev-choice");

  // The semantic run path arrives with its own task, so run refuses the
  // question check before any work starts and no evaluator runs.
  const failure = await failureOf(() => reviewer.run(QUESTION_CASE));
  expect(failure.code).toBe("evaluator_mismatch");
  expect(failure.fieldPath).toBe("/checks/0");
  expect(evaluator.calls).toEqual([]);
});
