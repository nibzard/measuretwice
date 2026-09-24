// SPDX-License-Identifier: Apache-2.0
/**
 * Semantic run orchestration tests.
 *
 * These tests cover the complete run path of task T034: one mixed
 * definition with one exact rule, one Choice question, one Noul question,
 * and one Score question, driven through one registered scripted evaluator
 * inside the bounds of one exploration profile. They pin the report
 * records (outcome, raw assessment, applied policy, evaluator versions,
 * timing, usage, attempts), the projected requests that the evaluators
 * receive, the decision table of the `probability_mass_v0` family, the
 * bounded retries and the permanent failures, the queue saturation skip,
 * the total deadline, the caller cancellation, and the immutable terminal
 * report. They read local files only, so they stay offline and
 * deterministic.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import {
  createExplorationProfile,
  createScriptedEvaluator,
  defineChecks,
  load,
  registerEvaluators,
  ValidationError,
  type Definition,
  type Evaluator,
  type EvaluatorRequest,
  type ExecutionConfig,
  type FileAccess,
  type Profile,
  type RunReport,
} from "../src/index.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/**
 * One mixed definition with every check shape: one exact rule, one Choice
 * question with one review label, one Noul question, and one Score
 * question. The `using` lists differ on purpose, so every request projects
 * one different input set.
 */
const mixed = defineChecks({
  version: 1,
  name: "semantic-intervention",
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
      using: ["conversation", "proposed_message"],
      question: "Has the conversation acknowledged this concern?",
      answers: {
        yes: "One participant recognizes the concern.",
        no: "No message recognizes the concern.",
      },
      accept: "no",
    },
    {
      id: "consequence",
      name: "The concern warrants one interruption",
      using: ["prior_decision", "conversation"],
      question: "What consequence does the concern have?",
      scale: [
        { minor: "No identified consequence." },
        { meaningful: "One coordination problem." },
        { serious: "One conflict with one commitment." },
      ],
      accept: { at_least: "meaningful" },
    },
    {
      id: "message-length",
      name: "The message fits the delivery limit",
      using: ["proposed_message"],
      rule: { maxLength: 280 },
    },
  ],
});

/** One case that satisfies every input constraint. */
const CASE_INPUT = {
  id: "case-1",
  input: {
    prior_decision: "Customer exports stay in the EU.",
    conversation: "The team proposes one export worker in the US region.",
    proposed_message: "The export worker moves to the US region.",
  },
};

/** One complete categorical assessment with its operational measurements. */
const SUPPORTED = {
  assessment: {
    kind: "categorical",
    label: "supported",
    distribution: [
      { name: "supported", mass: 0.9 },
      { name: "incomplete", mass: 0.05 },
      { name: "contradicted", mass: 0.05 },
    ],
    confidence: 0.9,
    evidence: [{ input: "prior_decision", reference: "decision-2026-03" }],
  },
  model_resolved: "jev-1.13.0",
  usage: { input_tokens: 1200, output_tokens: 40 },
  latency_ms: 250,
};

/** One passing binary answer: the conversation acknowledged nothing. */
const NOTHING_NEW = {
  assessment: { kind: "binary", value: false },
  model_resolved: "jev-1.13.0",
  usage: { input_tokens: 800, output_tokens: 8 },
  latency_ms: 120,
};

/** One passing ordered answer: the acceptable mass clears the cutoff. */
const MEANINGFUL = {
  assessment: {
    kind: "ordered",
    level: "meaningful",
    position: 1.5,
    distribution: [
      { name: "minor", mass: 0.1 },
      { name: "meaningful", mass: 0.55 },
      { name: "serious", mass: 0.35 },
    ],
  },
  model_resolved: "jev-1.13.0",
  usage: { input_tokens: 900, output_tokens: 12 },
  latency_ms: 180,
};

/** One in-memory file access. */
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

/** One scripted evaluator plus the profile and file access that bind it. */
function bindScripted(
  definition: Definition,
  steps: readonly unknown[],
  profileOptions: Parameters<typeof createExplorationProfile>[2] = {},
  clock: FakeClock = new FakeClock(START_MS),
): {
  readonly run: (caseInput: unknown, options?: { mode?: "shadow" | "enforcement" }) => Promise<RunReport>;
  readonly calls: readonly EvaluatorRequest[];
  readonly remaining: () => number;
  readonly profile: Profile;
  readonly clock: FakeClock;
} {
  const evaluator = createScriptedEvaluator({
    // One plain execution object wraps as one answer control, so the tables
    // below state their executions directly.
    steps: steps.map((step) =>
      step !== null &&
      typeof step === "object" &&
      !("answer" in step) &&
      !("raw" in step) &&
      !("error" in step)
        ? { answer: step }
        : step,
    ) as never,
  });
  const registry = registerEvaluators(evaluator);
  const profile = createExplorationProfile(definition, registry, profileOptions);
  const files = memoryFiles({ "/profile.json": JSON.stringify(profile) });
  const reviewerPromise = load(definition, {
    profile: "/profile.json",
    evaluators: registry,
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
  });
  return {
    run: (caseInput, options) => reviewerPromise.then((reviewer) => reviewer.run(caseInput as never, options)),
    calls: evaluator.calls,
    remaining: evaluator.remaining,
    profile,
    clock,
  };
}

// ---------------------------------------------------------------------------
// The end-to-end mixed run.
// ---------------------------------------------------------------------------

test("one mixed run decides every check shape and records its measurements", async () => {
  const bound = bindScripted(mixed, [SUPPORTED, NOTHING_NEW, MEANINGFUL]);
  const report = await bound.run(CASE_INPUT);

  // The report binds the same identities that load established.
  expect(report.definition.name).toBe("semantic-intervention");
  expect(report.definition.content_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(report.profile).toEqual({
    id: "semantic-intervention-exploration",
    content_hash: bound.profile.content_hash,
  });
  expect(report).toMatchObject({
    schema_version: 1,
    run_id: "run-000001",
    mode: "shadow",
    case: { id: "case-1" },
    aggregate: { outcome: "pass" },
    completion: { status: "completed", completed_at: "2026-09-24T00:00:00.000Z" },
  });

  // One record per check, in definition order: three question records and
  // one rule record.
  expect(report.checks.map((record) => [record.check, record.kind, record.outcome])).toEqual([
    ["message-supported", "question", "pass"],
    ["adds-information", "question", "pass"],
    ["consequence", "question", "pass"],
    ["message-length", "rule", "pass"],
  ]);

  // One question record keeps the raw assessment, the applied starter
  // policy, the evaluator versions with the resolved model, the timing, and
  // the usage that the adapter reported.
  const supported = report.checks[0]!;
  expect(supported.assessment).toEqual(SUPPORTED.assessment);
  expect(supported.applied_policy).toEqual({ accept_cutoff: 0.8, rejection_cutoff: 0.6 });
  expect(supported.evaluator).toEqual({
    id: "scripted-test",
    adapter_version: "0.1.0",
    model_resolved: "jev-1.13.0",
  });
  expect(supported.timing).toEqual({ queued_ms: 0, execution_ms: 250 });
  expect(supported.usage).toEqual({ input_tokens: 1200, output_tokens: 40 });
  expect(supported.attempts).toBeUndefined();
  expect(supported.reason).toBeUndefined();

  // The binary and ordered records keep their own measurements.
  expect(report.checks[1]?.assessment).toEqual(NOTHING_NEW.assessment);
  expect(report.checks[1]?.timing).toEqual({ queued_ms: 0, execution_ms: 120 });
  expect(report.checks[2]?.assessment).toEqual(MEANINGFUL.assessment);
  expect(report.checks[2]?.usage).toEqual({ input_tokens: 900, output_tokens: 12 });

  // The rule record states its executed rule and no evaluator metadata.
  const rule = report.checks[3]!;
  expect(rule.applied_rule).toEqual({
    rule: "maxLength",
    input: "proposed_message",
    parameters: { maxLength: 280 },
  });
  expect(rule.evaluator).toBeUndefined();
  expect(rule.timing).toBeUndefined();
  expect(rule.usage).toBeUndefined();

  // Every request holds exactly the projected inputs of its `using` list,
  // the validated question, the budget, and the signal: no case identifier
  // and no unrelated input crosses.
  expect(bound.calls).toHaveLength(3);
  expect(bound.calls.map((request) => request.check)).toEqual([
    "message-supported",
    "adds-information",
    "consequence",
  ]);
  expect(bound.calls[0]?.inputs).toEqual({
    prior_decision: CASE_INPUT.input.prior_decision,
    conversation: CASE_INPUT.input.conversation,
    proposed_message: CASE_INPUT.input.proposed_message,
  });
  expect(bound.calls[1]?.inputs).toEqual({
    conversation: CASE_INPUT.input.conversation,
    proposed_message: CASE_INPUT.input.proposed_message,
  });
  expect(bound.calls[2]?.inputs).toEqual({
    prior_decision: CASE_INPUT.input.prior_decision,
    conversation: CASE_INPUT.input.conversation,
  });
  expect(bound.calls[0]?.question).toEqual({
    kind: "categorical",
    question: "Does every claim follow from the evidence?",
    answers: {
      supported: "All claims are supported.",
      contradicted: "One claim conflicts with the evidence.",
      incomplete: "Support for one claim is missing.",
    },
  });
  expect(bound.calls[0]?.budget).toEqual({
    attempt: 1,
    max_attempts: 2,
    deadline_at_ms: START_MS + 30000,
  });
  // The attempt carried the cancellation signal of the run. The scheduler
  // aborts it on every terminal path, so it reads aborted after completion.
  expect(bound.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(bound.calls[0]?.signal.aborted).toBe(true);
  expect(bound.remaining()).toBe(0);

  // The report is frozen JSON data that authorizes nothing.
  expect(Object.isFrozen(report)).toBe(true);
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain("authorized");
  expect(serialized).not.toContain("credential");
});

test("identical inputs, clocks, and scripts give identical reports", async () => {
  const first = bindScripted(mixed, [SUPPORTED, NOTHING_NEW, MEANINGFUL]);
  const second = bindScripted(mixed, [SUPPORTED, NOTHING_NEW, MEANINGFUL]);
  const firstReport = await first.run(CASE_INPUT);
  const secondReport = await second.run(CASE_INPUT);
  expect(JSON.stringify(secondReport)).toBe(JSON.stringify(firstReport));
});

// ---------------------------------------------------------------------------
// The decision table of the probability_mass_v0 family.
// ---------------------------------------------------------------------------

/** Runs the mixed definition with one scripted answer per question check. */
async function decideWith(
  answers: [unknown, unknown, unknown],
  message: string,
  profileOptions: Parameters<typeof createExplorationProfile>[2] = {},
): Promise<string[]> {
  const bound = bindScripted(
    mixed,
    [answers[0], answers[1], answers[2]],
    profileOptions,
  );
  const report = await bound.run(CASE_INPUT);
  expect(report.completion.status, message).toBe("completed");
  return report.checks.slice(0, 3).map((record) => record.outcome);
}

test("reported mass decides pass, fail, and review per answer shape", async () => {
  // One clear categorical pass, one clear binary fail, one ordered review
  // between the cutoffs.
  expect(
    await decideWith(
      [
        SUPPORTED,
        { assessment: { kind: "binary", value: true } },
        {
          assessment: {
            kind: "ordered",
            level: "meaningful",
            position: 1.0,
            distribution: [
              { name: "minor", mass: 0.45 },
              { name: "meaningful", mass: 0.1 },
              { name: "serious", mass: 0.45 },
            ],
          },
        },
      ],
      "clear outcomes",
    ),
  ).toEqual(["pass", "fail", "review"]);

  // One declared review label reviews whatever the distribution reports.
  expect(
    await decideWith(
      [
        {
          assessment: {
            kind: "categorical",
            label: "incomplete",
            distribution: [
              { name: "supported", mass: 0.9 },
              { name: "incomplete", mass: 0.1 },
            ],
          },
        },
        NOTHING_NEW,
        MEANINGFUL,
      ],
      "review label",
    ),
  ).toEqual(["review", "pass", "pass"]);

  // One clear categorical fail beside one ordered fail below at_least.
  expect(
    await decideWith(
      [
        {
          assessment: {
            kind: "categorical",
            label: "contradicted",
            distribution: [
              { name: "supported", mass: 0.05 },
              { name: "incomplete", mass: 0.05 },
              { name: "contradicted", mass: 0.9 },
            ],
          },
        },
        NOTHING_NEW,
        {
          assessment: {
            kind: "ordered",
            level: "minor",
            position: 0.0,
            distribution: [
              { name: "minor", mass: 0.8 },
              { name: "meaningful", mass: 0.1 },
              { name: "serious", mass: 0.1 },
            ],
          },
        },
      ],
      "clear failures",
    ),
  ).toEqual(["fail", "pass", "fail"]);

  // Acceptable mass exactly at the cutoff passes: the starter policy cuts
  // at 0.8.
  expect(
    await decideWith(
      [
        {
          assessment: {
            kind: "categorical",
            label: "supported",
            distribution: [
              { name: "supported", mass: 0.8 },
              { name: "incomplete", mass: 0.2 },
            ],
          },
        },
        NOTHING_NEW,
        MEANINGFUL,
      ],
      "boundary equality",
    ),
  ).toEqual(["pass", "pass", "pass"]);
});

test("one declared confidence floor abstains where confidence is supported", async () => {
  // The floor sits above the reported confidence, so the categorical answer
  // reviews although its acceptable mass would pass. The binary and ordered
  // checks keep the global starter policy.
  const outcomes = await decideWith(
    [SUPPORTED, NOTHING_NEW, MEANINGFUL],
    "floor abstains",
    {
      starterChecks: {
        "message-supported": { accept_cutoff: 0.8, rejection_cutoff: 0.6, confidence_floor: 0.95 },
      },
    },
  );
  expect(outcomes).toEqual(["review", "pass", "pass"]);

  // One floor on one binary check fits no definition: Noul reports no
  // confidence, so the profile generation refuses the pairing before any
  // execution.
  const failure = await failureOf(() =>
    decideWith([SUPPORTED, NOTHING_NEW, MEANINGFUL], "binary floor", {
      starterChecks: {
        "adds-information": { accept_cutoff: 0.8, rejection_cutoff: 0.6, confidence_floor: 0.9 },
      },
    }),
  );
  expect(failure.code).toBe("policy_mismatch");
  expect(failure.fieldPath).toBe("/profile/policy/checks/1/confidence_floor");
});

// ---------------------------------------------------------------------------
// Operational failures, retries, and permanent failures.
// ---------------------------------------------------------------------------

test("one retryable failure retries inside the attempt budget and records the count", async () => {
  // The scripted steps state the consumption order: every check takes its
  // first step at submission, and each retry of the failing check takes the
  // next one when its freed slot restarts it.
  const bound = bindScripted(
    mixed,
    [
      { error: "connection refused" },
      NOTHING_NEW,
      MEANINGFUL,
      { failure: { code: "evaluator_timeout", message: "The attempt timed out." } },
      SUPPORTED,
    ],
    { execution: { max_attempts: 3, backoff_ms: 0 } },
  );
  const report = await bound.run(CASE_INPUT);
  expect(report.completion.status).toBe("completed");
  const supported = report.checks[0]!;
  expect(supported.outcome).toBe("pass");
  expect(supported.attempts).toBe(3);
  expect(scheduledCalls(bound.calls, "message-supported")).toBe(3);
  // The siblings needed one attempt each.
  expect(report.checks[1]?.attempts).toBeUndefined();
  expect(report.checks[2]?.attempts).toBeUndefined();
  expect(bound.remaining()).toBe(0);
});

test("exhausted attempts record retries_exhausted with the last cause", async () => {
  const bound = bindScripted(
    mixed,
    [
      { failure: { code: "evaluator_timeout", message: "The first attempt timed out." } },
      NOTHING_NEW,
      MEANINGFUL,
      { failure: { code: "evaluator_timeout", message: "The second attempt timed out." } },
    ],
    { execution: { max_attempts: 2, backoff_ms: 0 } },
  );
  const report = await bound.run(CASE_INPUT);
  expect(report.completion.status).toBe("completed");
  expect(report.checks[0]).toMatchObject({
    check: "message-supported",
    kind: "question",
    outcome: "error",
    attempts: 2,
    reason: { code: "retries_exhausted" },
  });
  expect(report.checks[0]?.reason?.message).toContain("evaluator_timeout");
  // The siblings still assessed, and the aggregate keeps the error visible
  // beside their passes.
  expect(report.checks[1]?.outcome).toBe("pass");
  expect(report.checks[2]?.outcome).toBe("pass");
  expect(report.checks[3]?.outcome).toBe("pass");
  expect(report.aggregate.outcome).toBe("error");
});

test("one invalid assessment is permanent and spends no retry", async () => {
  const bound = bindScripted(
    mixed,
    [
      { assessment: { kind: "categorical", label: "undeclared-answer" } },
      NOTHING_NEW,
      MEANINGFUL,
    ],
    { execution: { max_attempts: 3, backoff_ms: 0 } },
  );
  const report = await bound.run(CASE_INPUT);
  expect(report.checks[0]).toMatchObject({
    outcome: "error",
    attempts: 1,
    reason: { code: "invalid_assessment" },
  });
  expect(report.checks[0]?.reason?.message).toContain("names no declared answer");
  // The permanent failure started no retry, so no scripted step was spent.
  expect(bound.remaining()).toBe(0);
  expect(scheduledCalls(bound.calls, "message-supported")).toBe(1);
});

test("one answer the policy cannot decide keeps the cause of the refusal", async () => {
  // One label-only categorical answer states no distribution, so the
  // probability-mass policy cannot decide it: the error record keeps the
  // core cause with its field path.
  const bound = bindScripted(mixed, [
    { assessment: { kind: "categorical", label: "supported" } },
    NOTHING_NEW,
    MEANINGFUL,
  ]);
  const report = await bound.run(CASE_INPUT);
  expect(report.checks[0]).toMatchObject({
    outcome: "error",
    attempts: 1,
    reason: { code: "invalid_assessment" },
  });
  expect(report.checks[0]?.reason?.message).toContain("missing_field");
  expect(report.checks[0]?.reason?.message).toContain("/assessment/distribution");
  expect(report.checks[0]?.assessment).toBeUndefined();
});

/** Counts the recorded requests of one check. */
function scheduledCalls(calls: readonly EvaluatorRequest[], check: string): number {
  return calls.filter((request) => request.check === check).length;
}

// ---------------------------------------------------------------------------
// Bounds: saturation, deadline, cancellation, and input gates.
// ---------------------------------------------------------------------------

/** One evaluator whose answers wait for one manual release. */
function blockingEvaluator(id: string, answers: Record<string, unknown>): {
  readonly evaluator: Evaluator;
  readonly calls: EvaluatorRequest[];
  release(): void;
} {
  const calls: EvaluatorRequest[] = [];
  const waiting: Array<() => void> = [];
  const evaluator: Evaluator = {
    id,
    adapter_version: "0.1.0",
    async assess(request: EvaluatorRequest) {
      calls.push(request);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
      return answers[request.check] as never;
    },
  };
  return {
    evaluator,
    calls,
    release(): void {
      waiting.shift()?.();
    },
  };
}

/** Binds the mixed definition to one blocking evaluator and one clock. */
function bindBlocking(execution: Partial<ExecutionConfig> = {}) {
  const blocking = blockingEvaluator("blocking-test", {
    "message-supported": SUPPORTED,
    "adds-information": NOTHING_NEW,
    consequence: MEANINGFUL,
  });
  const registry = registerEvaluators(blocking.evaluator);
  const profile = createExplorationProfile(mixed, registry, { execution });
  const clock = new FakeClock(START_MS);
  const files = memoryFiles({ "/profile.json": JSON.stringify(profile) });
  const reviewerPromise = load(mixed, {
    profile: "/profile.json",
    evaluators: registry,
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
  });
  return { ...blocking, clock, profile, run: (options: { signal?: AbortSignal }) => reviewerPromise.then((reviewer) => reviewer.run(CASE_INPUT, options)) };
}

test("one spent pending queue skips never-started work with queue_full", async () => {
  const bound = bindBlocking({ max_active: 1, max_pending: 0 });
  const pending = bound.run({});
  // The first question check holds the only active slot; the remaining
  // checks fit no pending slot, so they record one queue_full skip.
  await tick();
  expect(bound.calls.map((request) => request.check)).toEqual(["message-supported"]);
  bound.release();
  const report = await pending;
  expect(report.completion.status).toBe("completed");
  const outcomes = report.checks.map((record) => [record.check, record.outcome]);
  expect(outcomes).toEqual([
    ["message-supported", "pass"],
    ["adds-information", "skipped"],
    ["consequence", "skipped"],
    ["message-length", "skipped"],
  ]);
  for (const skipped of report.checks.slice(1)) {
    expect(skipped.reason).toMatchObject({ code: "queue_full" });
  }
  expect(report.aggregate.outcome).toBe("review");
});

test("the total deadline ends active and queued work with explicit records", async () => {
  const bound = bindBlocking({ max_active: 1, max_pending: 4, deadline_ms: 1000 });
  const pending = bound.run({});
  await tick();
  expect(bound.calls).toHaveLength(1);
  // The deadline wake-up fires at the deadline instant of the profile.
  bound.clock.advanceMs(1000);
  const report = await pending;
  expect(report.completion).toEqual({
    status: "deadline_exceeded",
    completed_at: "2026-09-24T00:00:01.000Z",
  });
  expect(report.checks.map((record) => [record.outcome, record.reason?.code])).toEqual([
    ["error", "deadline_exceeded"],
    ["skipped", "deadline_before_start"],
    ["skipped", "deadline_before_start"],
    ["skipped", "deadline_before_start"],
  ]);
  expect(report.aggregate.outcome).toBe("error");

  // One answer that arrives after the deadline changes no record: the
  // blocked adapter resolves, the scheduler drops the late result, and the
  // frozen report stays byte-identical.
  const frozen = JSON.stringify(report);
  bound.release();
  await tick();
  const settled = await pending.catch((error: Error) => error);
  expect(settled).toBe(report);
  expect(JSON.stringify(report)).toBe(frozen);
});

test("caller cancellation aborts the adapters and freezes one cancelled report", async () => {
  const bound = bindBlocking({ max_active: 1, max_pending: 4 });
  const controller = new AbortController();
  const pending = bound.run({ signal: controller.signal });
  await tick();
  expect(bound.calls).toHaveLength(1);
  controller.abort(new Error("the host stopped the run"));
  const report = await pending;
  expect(report.completion).toEqual({
    status: "cancelled",
    completed_at: "2026-09-24T00:00:00.000Z",
  });
  expect(report.checks.map((record) => [record.outcome, record.reason?.code])).toEqual([
    ["error", "run_cancelled"],
    ["skipped", "cancelled_before_start"],
    ["skipped", "cancelled_before_start"],
    ["skipped", "cancelled_before_start"],
  ]);
  // The cancellation reached the in-flight adapter.
  expect(bound.calls[0]?.signal.aborted).toBe(true);

  // One answer that arrives after the cancellation changes no record.
  const frozen = JSON.stringify(report);
  bound.release();
  await tick();
  expect(JSON.stringify(report)).toBe(frozen);
});

test("an invalid case fails before any evaluator runs", async () => {
  const bound = bindScripted(mixed, [SUPPORTED, NOTHING_NEW, MEANINGFUL]);
  const missing = await failureOf(() =>
    bound.run({
      id: "case-9",
      input: { prior_decision: "Only one input." },
    }),
  );
  expect(missing.code).toBe("missing_field");
  expect(missing.fieldPath).toBe("/input/conversation");
  // The gate fired before any dispatch: no scripted step was spent.
  expect(bound.remaining()).toBe(3);
});

/** Lets pending microtasks and awaited promises run once. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
