// SPDX-License-Identifier: Apache-2.0
/**
 * Shadow report and host integration tests.
 *
 * These tests cover task T038: one shadow run records the new outcome beside
 * the existing decision of the host, and the existing decision path stays
 * untouched. The host states its decision and the revision of its path
 * through the `baseline` option, the frozen report records both beside the
 * new outcome, and agreement with the baseline stays one observation, never
 * one correctness claim. The tests also pin the host integration boundary:
 * the awaited call and the latency it adds, the wake-ups it leaves behind,
 * and the application actions that stay outside the library. The adapter is
 * the scripted test evaluator, so the tests read local files only and stay
 * offline and deterministic.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import * as measuretwice from "../src/index.js";
import {
  createExplorationProfile,
  createScriptedEvaluator,
  defineChecks,
  load,
  registerEvaluators,
  renderRunReport,
  ValidationError,
  type Definition,
  type Evaluator,
  type EvaluatorRequest,
  type ExecutionConfig,
  type FileAccess,
  type Profile,
  type RunOptions,
  type RunReport,
  type ShadowBaseline,
} from "../src/index.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/**
 * One mixed definition with one categorical question that carries one review
 * label, one binary question, one ordered question, and one exact rule, so
 * one script reaches every outcome of the aggregate.
 */
const mixed = defineChecks({
  version: 1,
  name: "shadow-intervention",
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

/** One passing categorical answer with its mass over every declared label. */
const SUPPORTED = {
  assessment: {
    kind: "categorical" as const,
    label: "supported",
    distribution: [
      { name: "supported", mass: 0.9 },
      { name: "incomplete", mass: 0.05 },
      { name: "contradicted", mass: 0.05 },
    ],
  },
  model_resolved: "jev-1.13.0",
  usage: { input_tokens: 1200, output_tokens: 40 },
  latency_ms: 250,
};

/** One failing categorical answer. */
const CONTRADICTED = {
  assessment: {
    kind: "categorical" as const,
    label: "contradicted",
    distribution: [
      { name: "supported", mass: 0.05 },
      { name: "incomplete", mass: 0.05 },
      { name: "contradicted", mass: 0.9 },
    ],
  },
  model_resolved: "jev-1.13.0",
  latency_ms: 210,
};

/** One review-labelled categorical answer. */
const INCOMPLETE = {
  assessment: {
    kind: "categorical" as const,
    label: "incomplete",
    distribution: [
      { name: "supported", mass: 0.1 },
      { name: "incomplete", mass: 0.8 },
      { name: "contradicted", mass: 0.1 },
    ],
  },
  model_resolved: "jev-1.13.0",
  latency_ms: 190,
};

/** One passing binary answer: the conversation acknowledged nothing. */
const NOTHING_NEW = {
  assessment: { kind: "binary" as const, value: false },
  model_resolved: "jev-1.13.0",
  latency_ms: 120,
};

/** One passing ordered answer. */
const MEANINGFUL = {
  assessment: {
    kind: "ordered" as const,
    level: "meaningful",
    position: 1.5,
    distribution: [
      { name: "minor", mass: 0.1 },
      { name: "meaningful", mass: 0.55 },
      { name: "serious", mass: 0.35 },
    ],
  },
  model_resolved: "jev-1.13.0",
  latency_ms: 180,
};

/** One in-memory file access that records every read. */
function memoryFiles(files: Record<string, string>): FileAccess & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(filePath: string): Promise<string> {
      reads.push(filePath);
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

/**
 * One ledger of the wake-ups that the library arms.
 *
 * Every armed wake-up counts, and every disarm counts, so one test states
 * whether the library leaves one timer behind after its call resolves.
 */
function wakeLedger(clock: FakeClock): {
  readonly ledger: { armed: number; disarmed: number };
  readonly setTimer: (atMs: number, onWake: () => void) => () => void;
} {
  const ledger = { armed: 0, disarmed: 0 };
  const setTimer = (atMs: number, onWake: () => void): (() => void) => {
    ledger.armed += 1;
    const disarm = clock.setTimer(atMs, onWake);
    return () => {
      ledger.disarmed += 1;
      disarm();
    };
  };
  return { ledger, setTimer };
}

/**
 * One host decision path of the tests.
 *
 * The decision stands until host code changes it, and every application
 * action records itself. The library receives no handle to any of it, which
 * is the boundary under test: one shadow run reaches no decision and no
 * action. The `shadowCall` operation models the whole integration. The host
 * decides first, then it states its decision as the baseline, then it stores
 * the returned report through its own storage.
 */
function hostPath(outcome: string, revision: string) {
  const state = {
    decision: outcome,
    revision,
    deliveries: [] as string[],
    permissionGrants: [] as string[],
    stored: [] as string[],
  };
  return {
    state,
    /** The baseline that the host states for one shadow run. */
    baseline: (): ShadowBaseline => ({ outcome: state.decision, revision: state.revision }),
    /** Host storage. The library writes no report. */
    store(report: RunReport): void {
      state.stored.push(JSON.stringify(report));
    },
  };
}

/** Binds the mixed definition to one scripted evaluator and one clock. */
function bindScripted(
  steps: readonly unknown[],
  profileOptions: Parameters<typeof createExplorationProfile>[2] = {},
  clock: FakeClock = new FakeClock(START_MS),
): {
  readonly run: (caseInput: unknown, options?: RunOptions) => Promise<RunReport>;
  readonly calls: readonly EvaluatorRequest[];
  readonly remaining: () => number;
  readonly profile: Profile;
  readonly clock: FakeClock;
} {
  const evaluator = createScriptedEvaluator({
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
  const profile = createExplorationProfile(mixed, registry, profileOptions);
  const files = memoryFiles({ "/profile.json": JSON.stringify(profile) });
  const reviewerPromise = load(mixed, {
    profile: "/profile.json",
    evaluators: registry,
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
  });
  return {
    run: (caseInput, options) =>
      reviewerPromise.then((reviewer) => reviewer.run(caseInput as never, options)),
    calls: evaluator.calls,
    remaining: evaluator.remaining,
    profile,
    clock,
  };
}

/** One evaluator whose answers wait for one manual release. */
function blockingEvaluator(): {
  readonly evaluator: Evaluator;
  readonly calls: EvaluatorRequest[];
  release(): void;
} {
  const calls: EvaluatorRequest[] = [];
  const waiting: Array<() => void> = [];
  const evaluator: Evaluator = {
    id: "blocking-test",
    adapter_version: "0.1.0",
    async assess(request: EvaluatorRequest) {
      calls.push(request);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
      return SUPPORTED as never;
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
function bindBlocking(
  execution: Partial<ExecutionConfig> = {},
  clock: FakeClock = new FakeClock(START_MS),
): {
  readonly run: (options?: RunOptions) => Promise<RunReport>;
  readonly calls: readonly EvaluatorRequest[];
  release(): void;
  readonly clock: FakeClock;
} {
  const blocking = blockingEvaluator();
  const registry = registerEvaluators(blocking.evaluator);
  const profile = createExplorationProfile(mixed, registry, { execution });
  const files = memoryFiles({ "/profile.json": JSON.stringify(profile) });
  const reviewerPromise = load(mixed, {
    profile: "/profile.json",
    evaluators: registry,
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
  });
  return {
    run: (options) => reviewerPromise.then((reviewer) => reviewer.run(CASE_INPUT, options)),
    calls: blocking.calls,
    release: blocking.release,
    clock,
  };
}

/** Lets pending microtasks and awaited promises run once. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// The recorded baseline.
// ---------------------------------------------------------------------------

test("one shadow run records the baseline beside the new outcome", async () => {
  const host = hostPath("send", "policy-2026-03");
  const bound = bindScripted([SUPPORTED, NOTHING_NEW, MEANINGFUL]);

  // The host states the decision that its own path already made.
  const report = await bound.run(CASE_INPUT, { baseline: host.baseline() });
  expect(report.mode).toBe("shadow");
  expect(report.baseline).toEqual({ outcome: "send", revision: "policy-2026-03" });
  expect(report.aggregate.outcome).toBe("pass");
  // The new outcome is the aggregate of the component records alone.
  expect(report.checks.map((record) => record.outcome)).toEqual(["pass", "pass", "pass", "pass"]);

  // One run without one baseline states no field, and nothing else changes.
  const plainBound = bindScripted([SUPPORTED, NOTHING_NEW, MEANINGFUL]);
  const plain = await plainBound.run(CASE_INPUT);
  expect("baseline" in plain).toBe(false);
  expect(plain.aggregate.outcome).toBe("pass");
  expect(plain.checks.map((record) => record.outcome)).toEqual(
    report.checks.map((record) => record.outcome),
  );

  // The report is plain JSON data, and the renderer states both facts beside
  // each other: the new outcome as the aggregate, the baseline as identity.
  const text = renderRunReport(mixed, report, { detail: "detail" });
  expect(text).toContain("baseline: send · revision policy-2026-03");
  expect(text).toContain("Overall: PASS");
});

test("an exact-rule shadow run records one baseline with no evaluator", async () => {
  const rules = defineChecks({
    version: 1,
    name: "shadow-delivery-limits",
    inputs: Type.Object(
      { summary: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    checks: [
      {
        id: "summary-length",
        name: "The summary fits the delivery limit",
        using: ["summary"],
        rule: { maxLength: 80 },
      },
    ],
  });
  const files = memoryFiles({});
  const reviewer = await load(rules, {
    files,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const report = await reviewer.run(
    { id: "case-1", input: { summary: "The delivery limit is 900 characters" } },
    { baseline: { outcome: "silent", revision: "heuristic-v4" } },
  );
  expect(report.baseline).toEqual({ outcome: "silent", revision: "heuristic-v4" });
  expect(report.aggregate.outcome).toBe("pass");
  // The run read no file and wrote no report: storage stays with the host.
  expect(files.reads).toEqual([]);
});

// ---------------------------------------------------------------------------
// The existing decision path stays untouched.
// ---------------------------------------------------------------------------

test("shadow failures, reviews, skips, and errors preserve the decision path", async () => {
  const scripts: readonly {
    readonly note: string;
    readonly steps: readonly unknown[];
    readonly execution?: Partial<ExecutionConfig>;
    readonly expected: readonly string[];
    readonly aggregate: string;
  }[] = [
    {
      note: "every check passes",
      steps: [SUPPORTED, NOTHING_NEW, MEANINGFUL],
      expected: ["pass", "pass", "pass", "pass"],
      aggregate: "pass",
    },
    {
      note: "one check fails",
      steps: [CONTRADICTED, NOTHING_NEW, MEANINGFUL],
      expected: ["fail", "pass", "pass", "pass"],
      aggregate: "fail",
    },
    {
      note: "one check reviews",
      steps: [INCOMPLETE, NOTHING_NEW, MEANINGFUL],
      expected: ["review", "pass", "pass", "pass"],
      aggregate: "review",
    },
    {
      note: "one operational failure records one error",
      steps: [
        { failure: { code: "evaluator_timeout", message: "The first attempt timed out." } },
        NOTHING_NEW,
        MEANINGFUL,
        { failure: { code: "evaluator_timeout", message: "The second attempt timed out." } },
      ],
      execution: { max_attempts: 2, backoff_ms: 0 },
      expected: ["error", "pass", "pass", "pass"],
      aggregate: "error",
    },
  ];

  for (const entry of scripts) {
    const host = hostPath("send", "policy-2026-03");
    const bound = bindScripted(entry.steps, {
      ...(entry.execution !== undefined ? { execution: entry.execution } : {}),
    });
    const report = await bound.run(CASE_INPUT, { baseline: host.baseline() });
    host.store(report);

    // The run measured the case and recorded every component outcome.
    expect(report.checks.map((record) => record.outcome), entry.note).toEqual(entry.expected);
    expect(report.aggregate.outcome, entry.note).toBe(entry.aggregate);
    expect(report.completion.status, entry.note).toBe("completed");

    // The existing decision path stands exactly as it was. The host stored
    // one report through its own storage, and no delivery or permission
    // crossed, because the library holds no handle to either.
    expect(host.state.decision, entry.note).toBe("send");
    expect(host.state.revision, entry.note).toBe("policy-2026-03");
    expect(host.state.stored, entry.note).toHaveLength(1);
    expect(report.baseline, entry.note).toEqual({
      outcome: "send",
      revision: "policy-2026-03",
    });
  }

  // One skipped check follows the same rule: the queue limit stops the
  // checks that never started, the report records the skips, and the
  // existing decision stays.
  const host = hostPath("send", "policy-2026-03");
  const bound = bindBlocking({ max_active: 1, max_pending: 0 });
  const pending = bound.run({ baseline: host.baseline() });
  await tick();
  bound.release();
  const skipped = await pending;
  host.store(skipped);
  expect(skipped.checks.map((record) => [record.outcome, record.reason?.code])).toEqual([
    ["pass", undefined],
    ["skipped", "queue_full"],
    ["skipped", "queue_full"],
    ["skipped", "queue_full"],
  ]);
  expect(skipped.aggregate.outcome).toBe("review");
  expect(host.state.decision).toBe("send");
  expect(host.state.stored).toHaveLength(1);

  // One cancelled shadow run records its own terminal state and still
  // changes no decision, as MVP_SPEC.md section 10 requires.
  const cancelledHost = hostPath("send", "policy-2026-03");
  const cancelledBound = bindBlocking({ max_active: 1, max_pending: 4 });
  const controller = new AbortController();
  const cancelledRun = cancelledBound.run({
    baseline: cancelledHost.baseline(),
    signal: controller.signal,
  });
  await tick();
  controller.abort(new Error("the host stopped the run"));
  const cancelled = await cancelledRun;
  expect(cancelled.completion.status).toBe("cancelled");
  expect(cancelled.baseline).toEqual({ outcome: "send", revision: "policy-2026-03" });
  expect(cancelledHost.state.decision).toBe("send");
});

test("baseline agreement stays one observation and never one correctness claim", async () => {
  // The same case runs twice under two stated baselines: one agrees with the
  // measured outcome, one disagrees. The measurement is identical, because
  // the baseline enters no decision, no record, and no timing.
  const agreeing = bindScripted([SUPPORTED, NOTHING_NEW, MEANINGFUL]);
  const measured = await agreeing.run(CASE_INPUT, {
    baseline: { outcome: "pass", revision: "r1" },
  });
  const disagreeing = bindScripted([SUPPORTED, NOTHING_NEW, MEANINGFUL]);
  const other = await disagreeing.run(CASE_INPUT, {
    baseline: { outcome: "silent", revision: "r2" },
  });
  expect(measured.baseline).toEqual({ outcome: "pass", revision: "r1" });
  expect(other.baseline).toEqual({ outcome: "silent", revision: "r2" });
  expect(other.aggregate).toEqual(measured.aggregate);
  expect(other.checks).toEqual(measured.checks);

  // The serialized report holds no field that combines the two outcomes, so
  // no host can read one accuracy, one agreement, or one correctness claim
  // out of one report.
  for (const report of [measured, other]) {
    const serialized = JSON.stringify(report).toLowerCase();
    for (const forbidden of ["agrees", "agreement", "accuracy", "correct", "authorized", "approved"]) {
      expect(serialized.includes(forbidden), `${forbidden} inside one report`).toBe(false);
    }
  }

  // The published contract states the same rule in its own words.
  const schema = JSON.parse(
    readFileSync(path.join(repoRoot, "contracts", "v0", "run-report.schema.json"), "utf8"),
  ) as { properties: { baseline: { description: string } } };
  expect(schema.properties.baseline.description).toBe(
    "Shadow baseline. Agreement with the baseline is not correctness.",
  );
});

// ---------------------------------------------------------------------------
// The awaited call and its latency.
// ---------------------------------------------------------------------------

test("the awaited shadow call records its latency and never passes its deadline", async () => {
  const clock = new FakeClock(START_MS);
  const bound = bindScripted([SUPPORTED, NOTHING_NEW, MEANINGFUL], {}, clock);
  const report = await bound.run(CASE_INPUT, {
    baseline: { outcome: "send", revision: "policy-2026-03" },
  });

  // Every question record states the time its execution spent, as the
  // adapter measured it, and the queue wait before it. The awaited call adds
  // this duration to the caller path.
  expect(report.checks[0]?.timing).toEqual({ queued_ms: 0, execution_ms: 250 });
  expect(report.checks[1]?.timing).toEqual({ queued_ms: 0, execution_ms: 120 });
  expect(report.checks[2]?.timing).toEqual({ queued_ms: 0, execution_ms: 180 });

  // The total deadline bounds the added latency. One run that never finishes
  // returns at its deadline with an explicit terminal state, so the caller
  // waits the deadline and no longer.
  const slow = bindBlocking({ max_active: 1, max_pending: 4, deadline_ms: 1000 }, clock);
  const pending = slow.run({ baseline: { outcome: "send", revision: "policy-2026-03" } });
  await tick();
  clock.advanceMs(1000);
  const ended = await pending;
  expect(ended.completion).toEqual({
    status: "deadline_exceeded",
    completed_at: "2026-09-24T00:00:01.000Z",
  });
  expect(ended.aggregate.outcome).toBe("error");
  // The deadline report keeps the baseline: one terminal state is still one
  // recorded shadow run.
  expect(ended.baseline).toEqual({ outcome: "send", revision: "policy-2026-03" });
});

test("the library leaves no armed wake-up behind one resolved call", async () => {
  // One resolved call disarms every wake-up it armed, so the host owns what
  // runs next. The library starts no detached job and schedules no later
  // work: the complete lifecycle sits inside the awaited call.
  const bindWith = async (
    evaluator: Evaluator,
    execution: Partial<ExecutionConfig>,
    clock: FakeClock,
    setTimer: (atMs: number, onWake: () => void) => () => void,
  ) => {
    const registry = registerEvaluators(evaluator);
    const profile = createExplorationProfile(mixed, registry, { execution });
    return await load(mixed, {
      profile: "/profile.json",
      evaluators: registry,
      files: memoryFiles({ "/profile.json": JSON.stringify(profile) }),
      now: () => clock.nowMs(),
      nextRunId: sequenceIds("run"),
      setTimer,
    });
  };

  // One completed run: the scripted answers settle, then the run ends.
  const completedClock = new FakeClock(START_MS);
  const completedWakes = wakeLedger(completedClock);
  const completedReviewer = await bindWith(
    createScriptedEvaluator({
      steps: [SUPPORTED, NOTHING_NEW, MEANINGFUL].map((answer) => ({ answer })) as never,
    }),
    {},
    completedClock,
    completedWakes.setTimer,
  );
  const completed = await completedReviewer.run(CASE_INPUT, {
    baseline: { outcome: "send", revision: "policy-2026-03" },
  });
  expect(completed.completion.status).toBe("completed");
  expect(completedWakes.ledger.armed).toBeGreaterThan(0);
  expect(completedWakes.ledger.disarmed).toBe(completedWakes.ledger.armed);

  // One cancelled run and one run at its deadline: every terminal path
  // releases the same resources.
  for (const kind of ["cancelled", "deadline"] as const) {
    const clock = new FakeClock(START_MS);
    const wakes = wakeLedger(clock);
    const blocking = blockingEvaluator();
    const reviewer = await bindWith(
      blocking.evaluator,
      kind === "deadline"
        ? { max_active: 1, max_pending: 4, deadline_ms: 1000 }
        : { max_active: 1, max_pending: 4 },
      clock,
      wakes.setTimer,
    );
    const controller = new AbortController();
    const pending = reviewer.run(CASE_INPUT, {
      baseline: { outcome: "send", revision: "policy-2026-03" },
      ...(kind === "cancelled" ? { signal: controller.signal } : {}),
    });
    await tick();
    if (kind === "cancelled") {
      controller.abort(new Error("the host stopped the run"));
    } else {
      clock.advanceMs(1000);
    }
    const report = await pending;
    expect(report.completion.status, kind).toBe(
      kind === "cancelled" ? "cancelled" : "deadline_exceeded",
    );
    expect(wakes.ledger.armed, kind).toBeGreaterThan(0);
    expect(wakes.ledger.disarmed, kind).toBe(wakes.ledger.armed);
    expect(blocking.calls.length, kind).toBeGreaterThan(0);
    // The blocked answer settles after the terminal state, and the frozen
    // report stays as it was.
    const frozen = JSON.stringify(report);
    blocking.release();
    await tick();
    expect(JSON.stringify(report)).toBe(frozen);
  }
});

// ---------------------------------------------------------------------------
// Application actions stay outside the library.
// ---------------------------------------------------------------------------

test("delivery, permissions, and storage stay outside the library surface", async () => {
  // The public package exports no operation that delivers, permits, stores,
  // or schedules: each export names authoring, assessment, rendering, or
  // error handling. The host owns each of those actions.
  const forbidden =
    /deliver|dispatch|send|permit|authoriz|approv|store|persist|write|queue|worker|schedul|background|detach/i;
  for (const name of Object.keys(measuretwice)) {
    expect(forbidden.test(name), `the export ${name} names one application action`).toBe(false);
  }

  // The run itself opens no file, and the report it returns holds no
  // authorization concept. The host stores the report it receives.
  const evaluator = createScriptedEvaluator({
    steps: [SUPPORTED, NOTHING_NEW, MEANINGFUL].map((answer) => ({ answer })) as never,
  });
  const registry = registerEvaluators(evaluator);
  const profile = createExplorationProfile(mixed, registry);
  const files = memoryFiles({ "/profile.json": JSON.stringify(profile) });
  const reviewer = await load(mixed, {
    profile: "/profile.json",
    evaluators: registry,
    files,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const readsAfterLoad = [...files.reads];
  const report = await reviewer.run(CASE_INPUT, {
    baseline: { outcome: "send", revision: "policy-2026-03" },
  });
  expect(files.reads).toEqual(readsAfterLoad);
  const serialized = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  for (const forbiddenKey of ["authorized", "approved", "action", "delivery", "permission"]) {
    expect(forbiddenKey in serialized, `the report states ${forbiddenKey}`).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// Baseline validation at the boundary.
// ---------------------------------------------------------------------------

test("one baseline in enforcement mode refuses before any work starts", async () => {
  // The derived exact profile of one exact-only definition carries the
  // structural qualification, so the selection clause passes and the
  // baseline clause refuses on its own.
  const rules = defineChecks({
    version: 1,
    name: "shadow-enforced-limits",
    inputs: Type.Object(
      { summary: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    checks: [
      {
        id: "summary-length",
        name: "The summary fits the delivery limit",
        using: ["summary"],
        rule: { maxLength: 80 },
      },
    ],
  });
  const reviewer = await load(rules, { now: () => START_MS, nextRunId: sequenceIds("run") });
  const selection = reviewer.profile?.content_hash;
  expect(selection).toBeDefined();
  const failure = await failureOf(() =>
    reviewer.run(
      { id: "case-1", input: { summary: "One summary." } },
      {
        mode: "enforcement",
        ...(selection !== undefined ? { selectedProfileHash: selection } : {}),
        baseline: { outcome: "send", revision: "policy-2026-03" },
      },
    ),
  );
  expect(failure.code).toBe("invalid_field_type");
  expect(failure.fieldPath).toBe("/baseline");
  expect(failure.message).toContain("shadow-mode data");

  // The same reviewer still runs the case in shadow mode with the baseline.
  const shadow = await reviewer.run(
    { id: "case-2", input: { summary: "One summary." } },
    { baseline: { outcome: "send", revision: "policy-2026-03" } },
  );
  expect(shadow.baseline).toEqual({ outcome: "send", revision: "policy-2026-03" });
  expect(shadow.aggregate.outcome).toBe("pass");
});

test("one malformed baseline refuses before any evaluator runs", async () => {
  const rows: readonly { note: string; baseline: unknown; code: string; path: string }[] = [
    {
      note: "no revision names no decision path",
      baseline: { outcome: "send" },
      code: "missing_field",
      path: "/baseline/revision",
    },
    {
      note: "no outcome states no existing decision",
      baseline: { revision: "policy-2026-03" },
      code: "missing_field",
      path: "/baseline/outcome",
    },
    {
      note: "one empty outcome",
      baseline: { outcome: "", revision: "policy-2026-03" },
      code: "invalid_field_type",
      path: "/baseline/outcome",
    },
    {
      note: "one outcome above the bound",
      baseline: { outcome: "o".repeat(65), revision: "policy-2026-03" },
      code: "invalid_field_type",
      path: "/baseline/outcome",
    },
    {
      note: "one revision above the bound",
      baseline: { outcome: "send", revision: "r".repeat(129) },
      code: "invalid_field_type",
      path: "/baseline/revision",
    },
    {
      note: "one agreement field is unknown report data",
      baseline: { outcome: "send", revision: "policy-2026-03", agrees: true },
      code: "unknown_field",
      path: "/baseline/agrees",
    },
    {
      note: "one non-object baseline",
      baseline: "send",
      code: "invalid_field_type",
      path: "/baseline",
    },
  ];
  for (const row of rows) {
    const bound = bindScripted([SUPPORTED, NOTHING_NEW, MEANINGFUL]);
    const failure = await failureOf(() =>
      bound.run(CASE_INPUT, { baseline: row.baseline as never }),
    );
    expect(failure.code, row.note).toBe(row.code);
    expect(failure.fieldPath, row.note).toBe(row.path);
    // No scripted step was spent: the refusal crossed before any dispatch.
    expect(bound.remaining(), row.note).toBe(3);
  }
});
