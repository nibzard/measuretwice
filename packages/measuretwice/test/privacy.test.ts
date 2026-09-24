// SPDX-License-Identifier: Apache-2.0
/**
 * Private-data default canaries of task T036.
 *
 * These tests drive sensitive case content, credentials, and hostile
 * provider echoes through the public `run` path and assert what must cross
 * and what must not. The report keeps every required assessment
 * measurement, the case identity, and useful sanitized failures, while no
 * raw case body, no credential, and no provider echo enters it, any
 * generated profile, or any diagnostic text. Replay provenance crosses as
 * one host-controlled snapshot reference, never as one persisted input.
 *
 * The canary strings below mark private data. A test that finds one inside
 * a report, a profile, or one failure message fails. They read local files
 * only, so they stay offline and deterministic.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import {
  createExplorationProfile,
  createJevEvaluator,
  createScriptedEvaluator,
  defineChecks,
  load,
  registerEvaluators,
  ValidationError,
  type Definition,
  type EvaluatorExecution,
  type FileAccess,
  type Profile,
  type RunReport,
} from "../src/index.js";
import { nativeComputeSelfHash } from "../src/native.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** One credential canary: one shape that one leaked key takes. */
const API_KEY = "CANARY-API-KEY-sk-9f27a4";

/** One credential canary of one authorization header. */
const BEARER = "CANARY-BEARER-TOKEN-4d1c81";

/** One private case-content canary. */
const PATIENT = "CANARY-PATIENT-Doyle-7";

/** One private contact canary. */
const CONTACT = "canary@private.example";

/** Every canary string. No serialized report, profile, or failure holds one. */
const CANARIES = [API_KEY, BEARER, PATIENT, CONTACT] as const;

/** Asserts that one serialized artifact holds no canary string. */
function assertNoCanary(text: string, where: string): void {
  for (const canary of CANARIES) {
    expect(text, `${where} leaks ${canary}`).not.toContain(canary);
  }
}

/**
 * One review definition whose inputs carry the canaries: one categorical
 * question over two inputs and one exact length rule over the third.
 */
const review = defineChecks({
  version: 1,
  name: "privacy-review",
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
      using: ["prior_decision", "conversation"],
      question: "Does every claim follow from the evidence?",
      answers: {
        supported: "All claims are supported.",
        contradicted: "One claim conflicts with the evidence.",
        incomplete: "Support for one claim is missing.",
      },
      accept: "supported",
      review: "incomplete",
    },
    {
      id: "message-length",
      name: "The message fits the delivery limit",
      using: ["proposed_message"],
      rule: { maxLength: 280 },
    },
  ],
});

/** One case whose input holds every canary string. */
const SENSITIVE_CASE = {
  id: "case-sensitive-1",
  input: {
    prior_decision: `The clinic record of ${PATIENT} stays with the contact ${CONTACT}.`,
    conversation: `The integration uses the key ${API_KEY} for the export worker.`,
    proposed_message: `The export worker now reads through the token ${BEARER}.`,
  },
};

/** One complete categorical assessment with its operational measurements. */
const SUPPORTED: EvaluatorExecution = {
  assessment: {
    kind: "categorical",
    label: "supported",
    distribution: [
      { name: "supported", mass: 0.9 },
      { name: "incomplete", mass: 0.05 },
      { name: "contradicted", mass: 0.05 },
    ],
    confidence: 0.9,
    evidence: [{ input: "prior_decision", reference: "decision-2026-09-24" }],
  },
  model_resolved: "jev-1.13.0",
  usage: { input_tokens: 1100, output_tokens: 30 },
  latency_ms: 200,
};

/** One file access that records every read, so one test can prove isolation. */
function recordingAccess(textOf: (path: string) => string): {
  readonly access: FileAccess;
  readonly reads: readonly string[];
} {
  const reads: string[] = [];
  return {
    reads,
    access: {
      async read(filePath: string): Promise<string> {
        reads.push(filePath);
        return textOf(filePath);
      },
    },
  };
}

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

/** One bound reviewer over one exploration profile of one scripted adapter. */
async function boundReviewer(
  definition: Definition,
  steps: readonly unknown[],
  options: {
    readonly execution?: NonNullable<Parameters<typeof createExplorationProfile>[2]>["execution"];
    readonly profileText?: (path: string) => string;
  } = {},
): Promise<{
  readonly run: (caseInput: unknown, runOptions?: { readonly snapshot?: string }) => Promise<RunReport>;
  readonly remaining: () => number;
  readonly profile: Profile;
  readonly reads: readonly string[];
}> {
  const evaluator = createScriptedEvaluator({
    steps: steps.map((step) =>
      step !== null && typeof step === "object" && !("answer" in step) && !("error" in step)
        ? { answer: step }
        : step,
    ) as never,
  });
  const registry = registerEvaluators(evaluator);
  const profile = createExplorationProfile(definition, registry, {
    ...(options.execution !== undefined ? { execution: options.execution } : {}),
  });
  const textOf = options.profileText ?? (() => JSON.stringify(profile));
  const files = recordingAccess(textOf);
  const reviewer = await load(definition, {
    profile: "/profile.json",
    evaluators: registry,
    files: files.access,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => new FakeClock(START_MS).setTimer(atMs, onWake),
  });
  return {
    run: (caseInput, runOptions) => reviewer.run(caseInput as never, runOptions),
    remaining: evaluator.remaining,
    profile,
    reads: files.reads,
  };
}

// ---------------------------------------------------------------------------
// The default report.
// ---------------------------------------------------------------------------

test("the default report holds no raw case content and no credential", async () => {
  const bound = await boundReviewer(review, [SUPPORTED]);
  const report = await bound.run(SENSITIVE_CASE);

  // The canaries reached the evaluator, so this run really assessed the
  // sensitive content: the privacy default is about the report, not about
  // refusing the work.
  const serialized = JSON.stringify(report);
  assertNoCanary(serialized, "the serialized report");
  expect(report.case).toEqual({
    id: "case-sensitive-1",
    input_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(Object.keys(report.case).sort()).toEqual(["id", "input_hash"]);
  expect(Object.isFrozen(report)).toBe(true);
});

test("the report keeps every required measurement while the case body stays out", async () => {
  const bound = await boundReviewer(review, [SUPPORTED]);
  const report = await bound.run(SENSITIVE_CASE);

  // The question record keeps the raw assessment with its evidence
  // reference, the applied policy, the evaluator versions with the resolved
  // model, the timing, and the usage.
  const question = report.checks[0]!;
  expect(question.check).toBe("message-supported");
  expect(question.assessment).toEqual(SUPPORTED.assessment);
  expect(question.applied_policy).toEqual({ accept_cutoff: 0.8, rejection_cutoff: 0.6 });
  expect(question.evaluator).toEqual({
    id: "scripted-test",
    adapter_version: "0.1.0",
    model_resolved: "jev-1.13.0",
  });
  expect(question.timing).toEqual({ queued_ms: 0, execution_ms: 200 });
  expect(question.usage).toEqual({ input_tokens: 1100, output_tokens: 30 });

  // The rule record keeps the executed rule.
  expect(report.checks[1]?.applied_rule).toEqual({
    rule: "maxLength",
    input: "proposed_message",
    parameters: { maxLength: 280 },
  });

  // The measurements carry no case text: the evidence reference names one
  // input and one stable reference inside it, and nothing else quotes one.
  assertNoCanary(JSON.stringify(question.assessment), "the recorded assessment");
});

// ---------------------------------------------------------------------------
// Host-controlled snapshot references.
// ---------------------------------------------------------------------------

test("one host snapshot reference records replay provenance and no input", async () => {
  const bound = await boundReviewer(review, [SUPPORTED, SUPPORTED], {
    execution: { backoff_ms: 0 },
  });
  const reference = "host-store://snapshots/case-sensitive-1/r7";
  const report = await bound.run(SENSITIVE_CASE, { snapshot: reference });

  expect(report.case).toEqual({
    id: "case-sensitive-1",
    input_hash: report.case.input_hash,
    snapshot: reference,
  });
  // The report holds the reference and no case content, and one report
  // without the option states no snapshot field at all.
  const serialized = JSON.stringify(report);
  expect(serialized).toContain(reference);
  assertNoCanary(serialized, "the serialized report with one snapshot reference");

  const plain = await bound.run(SENSITIVE_CASE);
  expect(plain.case).toEqual({
    id: "case-sensitive-1",
    input_hash: plain.case.input_hash,
  });
  expect(Object.keys(plain.case).sort()).toEqual(["id", "input_hash"]);
});

test("the wrapper reads no file and writes no report while one run executes", async () => {
  const bound = await boundReviewer(review, [SUPPORTED]);
  const report = await bound.run(SENSITIVE_CASE);

  // Load read the profile path alone. The run itself opened no file: the
  // wrapper holds no report storage, no input persistence, and no retention,
  // so the host owns every stored byte.
  expect(bound.reads).toEqual(["/profile.json"]);
  expect(report.completion.status).toBe("completed");
});

test("one snapshot reference outside the bound fails before any evaluator runs", async () => {
  const bound = await boundReviewer(review, [SUPPORTED]);
  for (const snapshot of ["", "x".repeat(257)]) {
    const failure = await failureOf(() => bound.run(SENSITIVE_CASE, { snapshot }));
    expect(failure.code).toBe("invalid_field_type");
    expect(failure.fieldPath).toBe("/case/snapshot");
    expect(failure.message).toContain("1 to 256 characters");
  }
  // The gate fired before any dispatch: no scripted step was spent.
  expect(bound.remaining()).toBe(1);
});

// ---------------------------------------------------------------------------
// Provider echoes and diagnostics.
// ---------------------------------------------------------------------------

test("one provider error that echoes case content and credentials crosses sanitized", async () => {
  // One binary question, so one Jev adapter serves the whole definition.
  const binary = defineChecks({
    version: 1,
    name: "privacy-binary",
    inputs: Type.Object(
      { conversation: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    checks: [
      {
        id: "adds-information",
        name: "We are adding something new",
        using: ["conversation"],
        question: "Has the conversation acknowledged this concern?",
        answers: {
          yes: "One participant recognizes the concern.",
          no: "No message recognizes the concern.",
        },
        accept: "no",
      },
    ],
  });

  // The hostile provider failure quotes the case text, the credential, and
  // one header value in every field that could carry an echo.
  const providerFailure = new Error(
    `Request rejected. The evidence ${PATIENT} with the contact ${CONTACT} failed validation. Used the key ${API_KEY} and the token ${BEARER}.`,
  );
  providerFailure.name = "APIError";
  (providerFailure as { status?: number }).status = 429;
  (providerFailure as { requestId?: string }).requestId = "req-canary-1";
  (providerFailure as { headers?: unknown }).headers = {
    "x-trace": "CANARY-TRACE-8e",
  };

  const clock = new FakeClock(START_MS);
  const evaluator = createJevEvaluator({
    call: () => Promise.reject(providerFailure),
    now: () => clock.nowMs(),
  });
  const registry = registerEvaluators(evaluator);
  const profile = createExplorationProfile(binary, registry, {
    execution: { max_attempts: 1, backoff_ms: 0 },
  });
  const reviewer = await load(binary, {
    profile: "/profile.json",
    evaluators: registry,
    files: {
      async read(): Promise<string> {
        return JSON.stringify(profile);
      },
    },
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
  });

  const report = await reviewer.run({
    id: "case-sensitive-2",
    input: { conversation: `The team discusses ${PATIENT} and the key ${API_KEY}.` },
  });

  // The failure stays useful: the record names the operational condition
  // with the error class, the status, and the request identifier, and the
  // aggregate keeps the error visible.
  const record = report.checks[0]!;
  expect(record.outcome).toBe("error");
  expect(record.reason?.code).toBe("evaluator_error");
  expect(record.reason?.message).toContain("APIError");
  expect(record.reason?.message).toContain("status 429");
  expect(record.reason?.message).toContain("request id req-canary-1");
  expect(report.aggregate.outcome).toBe("error");
  expect(report.completion.status).toBe("completed");

  // No provider message, body, or header crossed into the report.
  assertNoCanary(JSON.stringify(report), "the serialized report of the failed run");
  expect(record.reason?.message).not.toContain("CANARY-TRACE");
});

test("validation failures name the field and leak no case content", async () => {
  const bound = await boundReviewer(review, [SUPPORTED]);

  // One invalid case: the required conversation input is missing, while the
  // fields that do cross hold the canaries.
  const failure = await failureOf(() =>
    bound.run({
      id: "case-sensitive-3",
      input: {
        prior_decision: `The clinic record of ${PATIENT}.`,
        proposed_message: `The export worker reads through ${BEARER}.`,
      },
    }),
  );
  expect(failure.code).toBe("missing_field");
  expect(failure.fieldPath).toBe("/input/conversation");
  assertNoCanary(failure.message, "the validation failure message");
  expect(failure.message.length).toBeGreaterThan(0);

  // An invalid snapshot reference fails with its own field path, so the
  // caller can act on the defect without reading one echoed value.
  const snapshotFailure = await failureOf(() =>
    bound.run(SENSITIVE_CASE, { snapshot: "x".repeat(257) }),
  );
  expect(snapshotFailure.fieldPath).toBe("/case/snapshot");
  assertNoCanary(snapshotFailure.message, "the snapshot failure message");

  // The gate fired before any dispatch in both cases.
  expect(bound.remaining()).toBe(1);
});

test("operational failures keep their cause after sensitive content stays out", async () => {
  // One permanently invalid answer beside one exhausted retryable failure:
  // both records keep the operational code and one cause that names the
  // defect, and neither carries case text. The definition needs two
  // question checks, so both failures belong to question executions.
  const twoQuestions = defineChecks({
    version: 1,
    name: "privacy-two-questions",
    inputs: Type.Object(
      {
        prior_decision: Type.String({ minLength: 1 }),
        conversation: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    checks: [
      {
        id: "message-supported",
        name: "Our message accurately describes the evidence",
        using: ["prior_decision", "conversation"],
        question: "Does every claim follow from the evidence?",
        answers: {
          supported: "All claims are supported.",
          contradicted: "One claim conflicts with the evidence.",
          incomplete: "Support for one claim is missing.",
        },
        accept: "supported",
        review: "incomplete",
      },
      {
        id: "adds-information",
        name: "We are adding something new",
        using: ["conversation"],
        question: "Has the conversation acknowledged this concern?",
        answers: {
          yes: "One participant recognizes the concern.",
          no: "No message recognizes the concern.",
        },
        accept: "no",
      },
    ],
  });
  const bound = await boundReviewer(
    twoQuestions,
    [
      { assessment: { kind: "categorical", label: "undeclared-answer" } },
      { failure: { code: "evaluator_timeout", message: "The Jev attempt timed out." } },
      { failure: { code: "evaluator_timeout", message: "The Jev attempt timed out again." } },
    ],
    { execution: { max_attempts: 2, backoff_ms: 0 } },
  );
  const report = await bound.run({
    id: "case-sensitive-4",
    input: {
      prior_decision: SENSITIVE_CASE.input.prior_decision,
      conversation: SENSITIVE_CASE.input.conversation,
    },
  });

  const outcomes = report.checks.map((record) => [record.outcome, record.reason?.code]);
  expect(outcomes).toEqual([
    ["error", "invalid_assessment"],
    ["error", "retries_exhausted"],
  ]);
  expect(report.checks[0]?.reason?.message).toContain("names no declared answer");
  expect(report.checks[1]?.reason?.message).toContain("evaluator_timeout");
  expect(report.checks[1]?.attempts).toBe(2);
  assertNoCanary(JSON.stringify(report), "the serialized report of the failed run");
  expect(bound.remaining()).toBe(0);
});

// ---------------------------------------------------------------------------
// Profile artifacts.
// ---------------------------------------------------------------------------

test("generated profiles hold no credential and no private case content", async () => {
  const evaluator = createScriptedEvaluator({ steps: [{ answer: SUPPORTED }] });
  const registry = registerEvaluators(evaluator);
  const profile = createExplorationProfile(review, registry);

  // The artifact binds the definition, the evaluator versions, the policy,
  // and the execution limits. No field names one credential and no field
  // holds case content: the generator never sees one case.
  const serialized = JSON.stringify(profile);
  assertNoCanary(serialized, "the generated profile");
  for (const forbidden of ["api_key", "apikey", "credential", "authorization", "secret"]) {
    expect(serialized.toLowerCase(), `the profile names ${forbidden}`).not.toContain(forbidden);
  }
});

test("one stored profile that carries one credential or one case body fails load", async () => {
  const evaluator = createScriptedEvaluator({ steps: [{ answer: SUPPORTED }] });
  const registry = registerEvaluators(evaluator);
  const generated = createExplorationProfile(review, registry);

  // The injected field must carry one valid self-hash, so the refusal names
  // the unknown field and not one edited hash.
  const withField = (field: string, value: unknown): string => {
    const artifact = { ...generated, [field]: value } as Record<string, unknown>;
    delete artifact.content_hash;
    const contentHash = nativeComputeSelfHash("profile", JSON.stringify(artifact));
    return JSON.stringify({ ...artifact, content_hash: contentHash });
  };

  const cases = [
    {
      field: "api_key",
      value: API_KEY,
      path: "/api_key",
    },
    {
      field: "cases",
      value: [SENSITIVE_CASE],
      path: "/cases",
    },
  ];
  for (const injected of cases) {
    const failure = await failureOf(() =>
      load(review, {
        profile: "/profile.json",
        evaluators: registry,
        files: {
          async read(): Promise<string> {
            return withField(injected.field, injected.value);
          },
        },
        now: () => START_MS,
        nextRunId: sequenceIds("run"),
      }),
    );
    expect(failure.code).toBe("unknown_field");
    expect(failure.fieldPath).toBe(injected.path);
    assertNoCanary(failure.message, "the profile refusal message");
  }
});
