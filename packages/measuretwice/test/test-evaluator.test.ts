// SPDX-License-Identifier: Apache-2.0
/**
 * Test evaluator and adapter conformance tests.
 *
 * These tests cover task T023: the two shipped test adapters and the
 * adapter conformance cases of `fixtures/adapters/conformance.json`. The
 * scripted adapter answers through one control list with success, review,
 * malformed, error, and delayed controls. The label-only adapter answers
 * from one fixed table and reports no optional measurement. The suite
 * drives every fixture case through the dispatch contract, decides every
 * label-rule row with the separately specified test decision rule, and
 * proves that replacing the evaluator changes no request field while one
 * changed evaluator needs one independent profile binding. Every adapter
 * stays offline, reads no credential, and contacts no provider.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLabelOnlyEvaluator,
  createScriptedEvaluator,
  decideLabelOnly,
  labelRuleChecks,
  load,
  registerEvaluators,
  ValidationError,
  type Assessment,
  type Evaluator,
  type EvaluatorExecution,
  type EvaluatorFailure,
  type FileAccess,
  type JSONValue,
  type LabelOnlyAnswer,
  type TestEvaluatorControl,
} from "../src/index.js";
import { dispatchAssessment } from "../src/evaluator.js";
import { nativeComputeSelfHash, nativeValidateCase, nativeValidateDefinition } from "../src/native.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The adapter conformance fixture, the one source of truth for this suite. */
const doc = JSON.parse(
  readFileSync(path.join(repoRoot, "fixtures", "adapters", "conformance.json"), "utf8"),
) as {
  adapters: { id: string; adapter_version: string }[];
  never_invented: string[];
  cases: {
    note: string;
    adapter: string;
    definition: string;
    check: string;
    case_input: Record<string, string>;
    signal?: string;
    control: unknown;
    expected: {
      assessment?: Assessment;
      failure?: { code: string; message?: string; message_contains?: string };
      delays_ms?: number[];
    };
  }[];
  label_rule: {
    table: { note: string; definition: string; check: string; assessment: Assessment; expected_outcome: string }[];
  };
  replacement: {
    pairs: { note: string; definition: string; check: string; adapters: string[]; definition_hash_equal: boolean }[];
  };
  binding: {
    table: {
      note: string;
      bound: { evaluator: string; adapter_version: string };
      registered: { evaluator: string; adapter_version: string };
      expected?: { reason_code: string; field_path: string };
      loads?: boolean;
      definition_hash_equal?: boolean;
      profile_content_hash_equal?: boolean;
    }[];
  };
};

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

/** Reads one definition fixture as text. */
function definitionText(file: string): string {
  return readFileSync(path.join(repoRoot, "fixtures", "definitions", "valid", file), "utf8");
}

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** The budget of every dispatched request in this suite. */
const BUDGET = { attempt: 1, max_attempts: 2, deadline_at_ms: START_MS + 30000 };

/** Dispatches one fixture case to one evaluator through the contract. */
async function dispatchCase(
  record: { definition: string; check: string; case_input: Record<string, string> },
  evaluator: Evaluator,
  signal: AbortSignal = new AbortController().signal,
): Promise<EvaluatorExecution> {
  const text = definitionText(record.definition);
  const artifact = JSON.parse(text);
  const info = nativeValidateDefinition(text);
  const caseInfo = nativeValidateCase(
    text,
    JSON.stringify({ id: "adapter-conformance-case", input: record.case_input }),
  );
  const projected = caseInfo.projectedInputs.find((entry) => entry.checkId === record.check)
    ?.inputs as Readonly<Record<string, JSONValue>>;
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

/** Builds the adapter of one fixture case, with one recording sleep. */
function adapterFor(
  record: (typeof doc.cases)[number],
): { evaluator: Evaluator; sleeps: number[] } {
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  if (record.adapter === "label-only-test") {
    const control = record.control as { answers?: Record<string, LabelOnlyAnswer> };
    return {
      evaluator: createLabelOnlyEvaluator({ answers: control.answers ?? {} }),
      sleeps,
    };
  }
  const steps: TestEvaluatorControl[] =
    record.control === "script-empty" ? [] : [record.control as TestEvaluatorControl];
  return { evaluator: createScriptedEvaluator({ steps, sleep }), sleeps };
}

// ---------------------------------------------------------------------------
// The conformance cases.
// ---------------------------------------------------------------------------

test("every adapter conformance case reproduces its expected execution", async () => {
  expect(doc.cases.length).toBeGreaterThanOrEqual(15);
  for (const record of doc.cases) {
    const note = record.note;
    const { evaluator, sleeps } = adapterFor(record);
    const controller = new AbortController();
    if (record.signal === "aborted") {
      controller.abort();
    }
    const result = await dispatchCase(record, evaluator, controller.signal);
    const expected = record.expected;
    if (expected.assessment !== undefined) {
      expect(assessmentOf(result), note).toEqual(expected.assessment);
    } else {
      const failure = failureOfExecution(result);
      const wanted = expected.failure!;
      expect(failure.code, note).toBe(wanted.code);
      if (wanted.message !== undefined) {
        expect(failure.message, note).toBe(wanted.message);
      } else {
        expect(failure.message, note).toContain(wanted.message_contains);
      }
    }
    expect(sleeps, note).toEqual(expected.delays_ms ?? []);
    // No execution carries one usage amount: one absent measurement stays absent.
    expect(JSON.stringify(result), note).not.toContain("usage");
    // The label-only adapter invents no optional measurement.
    if (record.adapter === "label-only-test" && expected.assessment !== undefined) {
      const text = JSON.stringify(result);
      for (const key of doc.never_invented) {
        expect(text, `${note}: ${key}`).not.toContain(`"${key}"`);
      }
    }
  }
});

test("the shipped adapters use the identities of the fixture table", () => {
  for (const entry of doc.adapters) {
    if (entry.id === "scripted-test") {
      const adapter = createScriptedEvaluator({ steps: [] });
      expect(adapter.id).toBe(entry.id);
      expect(adapter.adapter_version).toBe(entry.adapter_version);
    } else {
      const adapter = createLabelOnlyEvaluator({ answers: {} });
      expect(adapter.id).toBe(entry.id);
      expect(adapter.adapter_version).toBe(entry.adapter_version);
    }
  }
});

test("the scripted adapter validates its script before the first call", async () => {
  const table: readonly { note: string; step: unknown; fieldPath: string }[] = [
    { note: "one step with no control", step: {}, fieldPath: "/steps/0" },
    {
      note: "one step with two controls",
      step: { answer: { assessment: { kind: "categorical", label: "supported" } }, raw: null },
      fieldPath: "/steps/0",
    },
    {
      note: "one answer that is no execution object",
      step: { answer: "supported" },
      fieldPath: "/steps/0/answer",
    },
    { note: "one error that is no Error and no string", step: { error: 7 }, fieldPath: "/steps/0/error" },
    {
      note: "one negative delay",
      step: { answer: { assessment: { kind: "categorical", label: "supported" } }, delay_ms: -1 },
      fieldPath: "/steps/0/delay_ms",
    },
  ];
  for (const record of table) {
    const failure = await failureOf(() =>
      createScriptedEvaluator({ steps: [record.step as TestEvaluatorControl] }),
    );
    expect(failure.code, record.note).toBe("invalid_field_type");
    expect(failure.fieldPath, record.note).toBe(record.fieldPath);
    expect(failure.message, record.note).not.toBe("");
  }
});

test("the scripted adapter answers in order, records requests, and stays deterministic", async () => {
  const steps: TestEvaluatorControl[] = [
    { answer: { assessment: { kind: "categorical", label: "supported" } } },
    { answer: { failure: { code: "evaluator_timeout", message: "One budget ended." } } },
    { error: "one later failure" },
  ];
  const first = createScriptedEvaluator({ steps, sleep: async () => {} });
  const second = createScriptedEvaluator({ steps, sleep: async () => {} });
  const record = doc.cases[0]!;
  const results: EvaluatorExecution[] = [];
  for (const adapter of [first, second]) {
    results.push(await dispatchCase(record, adapter));
    results.push(await dispatchCase(record, adapter));
    results.push(await dispatchCase(record, adapter));
    expect(adapter.calls).toHaveLength(3);
    expect(adapter.calls[0]!.check).toBe(record.check);
    expect(adapter.remaining()).toBe(0);
  }
  expect(results.slice(0, 3)).toEqual(results.slice(3));
  expect(assessmentOf(results[0]!)).toEqual({ kind: "categorical", label: "supported" });
  expect(failureOfExecution(results[1]!).code).toBe("evaluator_timeout");
  expect(failureOfExecution(results[2]!).code).toBe("evaluator_error");

  // One aborted signal at entry consumes no scripted step.
  const controller = new AbortController();
  controller.abort();
  const aborted = await dispatchCase(record, first, controller.signal);
  expect(failureOfExecution(aborted).code).toBe("evaluator_timeout");
  expect(first.calls).toHaveLength(4);
  expect(first.remaining()).toBe(0);
});

// ---------------------------------------------------------------------------
// The separately specified decision rule for label-only assessments.
// ---------------------------------------------------------------------------

test("the label rule table decides every row from the check meaning alone", () => {
  expect(doc.label_rule.table.length).toBeGreaterThanOrEqual(8);
  for (const row of doc.label_rule.table) {
    const definition = JSON.parse(definitionText(row.definition));
    const check = labelRuleChecks(definition).find((entry) => entry.check === row.check);
    expect(check, row.note).toBeDefined();
    expect(decideLabelOnly(check!, row.assessment), row.note).toBe(row.expected_outcome);
    // One confidence value, had one adapter reported it, changes no outcome.
    const withConfidence: Assessment = { ...row.assessment, confidence: 0.99 };
    expect(decideLabelOnly(check!, withConfidence), row.note).toBe(row.expected_outcome);
  }
  const outcomes = [...new Set(doc.label_rule.table.map((row) => row.expected_outcome))].sort();
  expect(outcomes).toEqual(["fail", "pass", "review"]);
});

test("the label rule rejects one assessment without one selected answer", async () => {
  const definition = JSON.parse(definitionText("categorical-question.json"));
  const check = labelRuleChecks(definition).find((entry) => entry.check === "message-supported");
  const failure = await failureOf(() =>
    decideLabelOnly(check!, { kind: "categorical" } as Assessment),
  );
  expect(failure.code).toBe("invalid_assessment");
  expect(failure.fieldPath).toBe("/assessment");
});

// ---------------------------------------------------------------------------
// Replacing the evaluator changes no request and no definition identity.
// ---------------------------------------------------------------------------

test("the two adapters receive identical requests for one case", async () => {
  const categoricalCase = doc.cases[0]!;
  for (const pair of doc.replacement.pairs) {
    const oneCase = {
      definition: pair.definition,
      check: pair.check,
      case_input: categoricalCase.case_input,
    };
    const scripted = createScriptedEvaluator({
      steps: [{ answer: { assessment: { kind: "categorical", label: "supported" } } }],
      sleep: async () => {},
    });
    const labelOnly = createLabelOnlyEvaluator({ answers: { [pair.check]: "supported" } });
    const first = await dispatchCase(oneCase, scripted);
    const second = await dispatchCase(oneCase, labelOnly);
    expect(first, pair.note).toEqual(second);

    const requestA = scripted.calls[0]!;
    const requestB = labelOnly.calls[0]!;
    const { signal: signalA, ...plainA } = requestA;
    const { signal: signalB, ...plainB } = requestB;
    expect(signalA.aborted).toBe(false);
    expect(signalB.aborted).toBe(false);
    expect(plainA, pair.note).toEqual(plainB);
    expect(JSON.stringify(plainA), pair.note).toBe(JSON.stringify(plainB));

    // One definition keeps one content hash across every evaluator.
    expect(pair.definition_hash_equal, pair.note).toBe(true);
    const info = nativeValidateDefinition(definitionText(pair.definition));
    expect(info.definitionHash).toMatch(/^[a-f0-9]{64}$/);
  }
});

// ---------------------------------------------------------------------------
// One change of evaluator behavior needs one independent profile binding.
// ---------------------------------------------------------------------------

/** The exploration profile fixture of the shared states. */
const EXPLORATION_PROFILE = JSON.parse(
  readFileSync(path.join(repoRoot, "fixtures", "profiles", "states.json"), "utf8"),
).profiles.find((profile: { id: string }) => profile.id === "message-supported-exploration") as Record<
  string,
  unknown
>;

const PROFILE_PATH = "profiles/adapter-conformance.json";

/** Rebinds the exploration profile to one evaluator and rehashes it. */
function reboundProfile(evaluator: string, adapterVersion: string): Record<string, unknown> {
  const artifact = structuredClone(EXPLORATION_PROFILE) as {
    bindings: { evaluator: string; adapter_version: string }[];
    content_hash: string;
  };
  artifact.bindings[0]!.evaluator = evaluator;
  artifact.bindings[0]!.adapter_version = adapterVersion;
  artifact.content_hash = nativeComputeSelfHash("profile", JSON.stringify(artifact));
  return artifact;
}

test("the binding table enforces one independent binding per evaluator change", async () => {
  const definition = JSON.parse(definitionText("categorical-question.json"));
  const info = nativeValidateDefinition(definitionText("categorical-question.json"));
  // The exploration profile of the shared states binds this definition.
  expect(
    (EXPLORATION_PROFILE.definition as { content_hash: string }).content_hash,
  ).toBe(info.definitionHash);

  for (const row of doc.binding.table) {
    const artifact = reboundProfile(row.bound.evaluator, row.bound.adapter_version);
    const registry = registerEvaluators(
      createLabelOnlyEvaluator({
        id: row.registered.evaluator,
        adapter_version: row.registered.adapter_version,
        answers: {},
      }),
    );
    const files = memoryFiles({ [PROFILE_PATH]: JSON.stringify(artifact) });
    if (row.expected !== undefined) {
      const failure = await failureOf(() =>
        load(definition, {
          profile: PROFILE_PATH,
          files,
          evaluators: registry,
          now: () => START_MS,
        }),
      );
      expect(failure.code, row.note).toBe(row.expected.reason_code);
      expect(failure.fieldPath, row.note).toBe(row.expected.field_path);
    } else {
      const reviewer = await load(definition, {
        profile: PROFILE_PATH,
        files,
        evaluators: registry,
        now: () => START_MS,
      });
      expect(row.loads, row.note).toBe(true);
      expect(reviewer.profile?.bindings[0]?.evaluator, row.note).toBe(row.bound.evaluator);
      expect(row.definition_hash_equal, row.note).toBe(true);
      expect(reviewer.definitionHash).toBe(info.definitionHash);
      // The rebound profile is one new artifact with its own content hash.
      expect(row.profile_content_hash_equal, row.note).toBe(false);
      expect(artifact.content_hash).not.toBe(EXPLORATION_PROFILE.content_hash);
    }
  }
});
