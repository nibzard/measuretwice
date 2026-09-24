// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduler tests.
 *
 * These tests cover the bounded scheduling that MVP_SPEC.md sections 5, 9,
 * and 12 assign to the TypeScript wrapper: active-work limits, pending-work
 * limits, saturation records, the attempt of every required check, bounded
 * retries with their backoff inside the total deadline, permanent failures
 * that record their error without one retry, the total deadline, and caller
 * cancellation. Every transition crosses the Rust run state boundary, so
 * one drifted offer, one late result, and one invalid record meet the core
 * refusal there.
 *
 * The tests stay offline and deterministic. One manual executor resolves
 * each execution by hand, one fake clock states the time and fires the
 * deadline wake-ups, and the shared runtime traces of
 * `fixtures/runtime/traces.json` drive the replayable rows. No test reads
 * the system clock and no test contacts one provider.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeAssessRuleChecks,
  nativeCreateRunState,
  nativeValidateCase,
  type RunState,
} from "../src/native.js";
import {
  scheduleRun,
  type SchedulerEvent,
  type ScheduledAttempt,
  type ScheduledResolution,
} from "../src/scheduler.js";
import type { ExecutionConfig, RunReport } from "../src/run.js";
import { FakeClock } from "./support/deterministic.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Reads one fixture file as text. */
function fixtureText(relative: string): string {
  return readFileSync(path.join(repoRoot, "fixtures", relative), "utf8");
}

/** Reads one fixture file as a JSON value. */
function fixtureDocument(relative: string): any {
  return JSON.parse(fixtureText(relative));
}

/** The fixed start time of every scheduled run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** One fixed profile binding for every scheduled run, as the native suite uses. */
const TRACE_PROFILE = JSON.stringify({ id: "trace-profile", content_hash: "1f".repeat(32) });

/** The shared fixture path of the exact-rule definition. */
const EXACT_RULES_PATH = "definitions/valid/exact-rules.json";

/** One case that passes every rule of the exact-rule definition. */
const PASSING_INPUT = {
  summary: "The delivery limit is 900 characters for this notice",
  notice: "Customer notice",
};

/** One complete execution configuration for the tests. */
function execution(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    max_active: 1,
    max_pending: 2,
    deadline_ms: 1000,
    max_attempts: 1,
    backoff_ms: 0,
    ...overrides,
  };
}

/** One prepared run: the run state, its binding texts, and the rule records. */
interface PreparedRun {
  readonly state: RunState;
  readonly caseReference: string;
  readonly runId: string;
  readonly ruleRecords: ReadonlyMap<string, Record<string, unknown>>;
  readonly checkIds: readonly string[];
}

/** Creates one run state through the core, with its binding texts. */
function prepare(
  definitionPath: string,
  caseInput: unknown,
  config: ExecutionConfig,
  runId = "scheduled-000001",
): PreparedRun {
  const definitionText = fixtureText(definitionPath);
  const caseText = JSON.stringify({ id: runId, input: caseInput });
  const caseInfo = nativeValidateCase(definitionText, caseText);
  const caseReference = JSON.stringify({ id: caseInfo.id, input_hash: caseInfo.inputHash });
  const state = nativeCreateRunState(
    definitionText,
    caseReference,
    TRACE_PROFILE,
    runId,
    "shadow",
    config.max_attempts,
    null,
  );
  const ruleRecords = new Map(
    nativeAssessRuleChecks(definitionText, caseText).map((result) => [
      result.check,
      JSON.parse(result.record) as Record<string, unknown>,
    ]),
  );
  return { state, caseReference, runId, ruleRecords, checkIds: state.checkIds() };
}

/** Builds one semantic record for one check: its rule record or one question record. */
function recordOf(
  run: PreparedRun,
  check: string,
  outcome: "pass" | "fail" | "review",
): Record<string, unknown> {
  const rule = run.ruleRecords.get(check);
  if (rule !== undefined) {
    return { ...rule, outcome };
  }
  return { check, kind: "question", outcome };
}

/** One resolution that records the stated semantic outcome. */
function result(
  run: PreparedRun,
  check: string,
  outcome: "pass" | "fail" | "review",
): ScheduledResolution {
  return { record: recordOf(run, check, outcome) as any };
}

/** One resolution that fails the attempt with one operational code. */
function failed(code: "evaluator_error" | "evaluator_timeout" | "invalid_assessment"): ScheduledResolution {
  return { failure: { code, message: `The scripted attempt failed with ${code}.` } };
}

/**
 * One executor that the test resolves by hand.
 *
 * Each call stays pending until the test resolves it. The executor records
 * every attempt, every event, and the greatest number of executions that
 * stayed in flight at one time.
 */
class ManualExecutor {
  /** Every attempt context received, in call order. */
  readonly calls: ScheduledAttempt[] = [];
  /** Every scheduler event observed, in emission order. */
  readonly events: SchedulerEvent[] = [];
  /** The greatest number of executions in flight at one time. */
  highWater = 0;
  #inFlight = 0;
  #pending: Array<{ readonly attempt: ScheduledAttempt; readonly resolve: (r: ScheduledResolution) => void }> = [];

  /** The executor function that the scheduler receives. */
  readonly execute = (attempt: ScheduledAttempt): Promise<ScheduledResolution> => {
    this.calls.push(attempt);
    this.#inFlight += 1;
    this.highWater = Math.max(this.highWater, this.#inFlight);
    return new Promise<ScheduledResolution>((resolve) => {
      this.#pending.push({ attempt, resolve });
    });
  };

  /** The observer function that the scheduler receives. */
  readonly observe = (event: SchedulerEvent): void => {
    this.events.push(event);
  };

  /** Resolves the oldest in-flight execution of one check. */
  resolveCheck(check: string, resolution: ScheduledResolution): void {
    const index = this.#pending.findIndex((entry) => entry.attempt.check === check);
    if (index < 0) {
      throw new Error(`no execution of the check ${JSON.stringify(check)} is in flight`);
    }
    const [entry] = this.#pending.splice(index, 1);
    this.#inFlight -= 1;
    entry!.resolve(resolution);
  }

  /** The checks with one execution in flight, in call order. */
  inFlight(): readonly string[] {
    return this.#pending.map((entry) => entry.attempt.check);
  }
}

/** Lets the scheduler process every resolved execution before the test continues. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await Promise.resolve();
  }
}

/** Starts one scheduled run over one prepared run and returns its promise. */
function start(
  run: PreparedRun,
  config: ExecutionConfig,
  executor: ManualExecutor,
  clock: FakeClock,
  options: { readonly signal?: AbortSignal } = {},
): Promise<RunReport> {
  return scheduleRun({
    state: run.state,
    caseReferenceText: run.caseReference,
    profileReferenceText: TRACE_PROFILE,
    execution: config,
    execute: executor.execute,
    now: () => clock.nowMs(),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    observe: executor.observe,
  });
}

// ---------------------------------------------------------------------------
// Active-work limits.
// ---------------------------------------------------------------------------

test("the scheduler bounds active work and drains the queue in order", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 1, max_pending: 2 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  // One active slot admits the first check and queues the rest.
  expect(executor.calls.map((attempt) => attempt.check)).toEqual(["summary-length"]);
  expect(executor.inFlight()).toEqual(["summary-length"]);

  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  await flush();
  expect(executor.calls.map((attempt) => attempt.check)).toEqual([
    "summary-length",
    "summary-mentions-limit",
  ]);

  await executor.resolveCheck("summary-mentions-limit", result(run, "summary-mentions-limit", "pass"));
  await flush();
  expect(executor.calls.map((attempt) => attempt.check)).toEqual([
    "summary-length",
    "summary-mentions-limit",
    "notice-hides-secrets",
  ]);

  clock.advanceMs(25);
  await executor.resolveCheck("notice-hides-secrets", result(run, "notice-hides-secrets", "pass"));
  const report = await reportPromise;
  expect(executor.highWater).toBe(1);
  expect(report.completion).toEqual({
    status: "completed",
    completed_at: "2026-09-24T00:00:00.025Z",
  });
  expect(report.checks.map((record) => record.outcome)).toEqual(["pass", "pass", "pass"]);
  expect(report.aggregate.outcome).toBe("pass");
});

test("two active slots admit two checks and queue the third", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 2, max_pending: 2 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  expect(executor.calls.map((attempt) => attempt.check)).toEqual([
    "summary-length",
    "summary-mentions-limit",
  ]);
  expect(executor.inFlight()).toEqual(["summary-length", "summary-mentions-limit"]);
  expect(executor.highWater).toBe(2);
  expect(executor.events.map((event) => event.type)).toEqual([
    "submit",
    "check_started",
    "check_started",
    "check_queued",
  ]);

  // One freed slot starts the queued check before the run can complete.
  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  await flush();
  expect(executor.calls.map((attempt) => attempt.check)).toEqual([
    "summary-length",
    "summary-mentions-limit",
    "notice-hides-secrets",
  ]);

  await executor.resolveCheck("summary-mentions-limit", result(run, "summary-mentions-limit", "pass"));
  await executor.resolveCheck("notice-hides-secrets", result(run, "notice-hides-secrets", "pass"));
  const report = await reportPromise;
  expect(report.aggregate.outcome).toBe("pass");
  expect(executor.highWater).toBe(2);
});

// ---------------------------------------------------------------------------
// Pending-work limits and saturation records.
// ---------------------------------------------------------------------------

test("saturation records queue-full skips for work that no slot accepts", async () => {
  const clock = new FakeClock(START_MS);
  // The saturation configuration of the checked model: one active slot, no
  // pending slot, and single attempts.
  const config = execution({ max_active: 1, max_pending: 0 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  expect(executor.calls.map((attempt) => attempt.check)).toEqual(["summary-length"]);
  expect(executor.events.filter((event) => event.type === "check_skipped")).toEqual([
    { type: "check_skipped", check: "summary-mentions-limit", code: "queue_full" },
    { type: "check_skipped", check: "notice-hides-secrets", code: "queue_full" },
  ]);

  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  const report = await reportPromise;
  expect(report.checks).toMatchObject([
    {
      check: "summary-length",
      outcome: "pass",
      applied_rule: { rule: "maxLength", input: "summary", parameters: { maxLength: 80 } },
    },
    { check: "summary-mentions-limit", outcome: "skipped", reason: { code: "queue_full" } },
    { check: "notice-hides-secrets", outcome: "skipped", reason: { code: "queue_full" } },
  ]);
  // One skip keeps the run usable: the run completes and the aggregate reviews.
  expect(report.completion.status).toBe("completed");
  expect(report.aggregate.outcome).toBe("review");
});

test("the pending limit counts only work that never started", async () => {
  const clock = new FakeClock(START_MS);
  // Two pending slots hold the two queued checks. The first check fails and
  // retries, so the queue holds three waiting checks while only the two
  // never-started ones count against the limit. The model record fixes this
  // rule, and one dropped retry would leave the run without one record.
  const config = execution({ max_active: 1, max_pending: 2, max_attempts: 2 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  expect(executor.inFlight()).toEqual(["summary-length"]);
  expect(executor.events.filter((event) => event.type === "check_queued").map((e) => e.check)).toEqual([
    "summary-mentions-limit",
    "notice-hides-secrets",
  ]);

  // The failure returns the check to the shared queue without one fresh slot.
  await executor.resolveCheck("summary-length", failed("evaluator_timeout"));
  await flush();
  expect(executor.inFlight()).toEqual(["summary-mentions-limit"]);

  await executor.resolveCheck("summary-mentions-limit", result(run, "summary-mentions-limit", "pass"));
  await flush();
  expect(executor.inFlight()).toEqual(["notice-hides-secrets"]);

  await executor.resolveCheck("notice-hides-secrets", result(run, "notice-hides-secrets", "pass"));
  await flush();
  // The retry starts with the same run binding and records its attempt count.
  expect(executor.inFlight()).toEqual(["summary-length"]);
  expect(executor.calls.at(-1)?.attempt).toBe(2);

  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  const report = await reportPromise;
  expect(report.checks.map((record) => record.outcome)).toEqual(["pass", "pass", "pass"]);
  expect(report.checks[0]?.attempts).toBe(2);
  expect(report.aggregate.outcome).toBe("pass");
});

// ---------------------------------------------------------------------------
// Every required check runs; no cost-based short-circuiting.
// ---------------------------------------------------------------------------

test("a failing check stops no sibling and every check is attempted", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 1, max_pending: 2 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  // The first check fails semantically. The siblings still run, because a
  // semantic outcome triggers no cost-based short-circuit.
  await executor.resolveCheck("summary-length", result(run, "summary-length", "fail"));
  await flush();
  expect(executor.calls.map((attempt) => attempt.check)).toEqual([
    "summary-length",
    "summary-mentions-limit",
  ]);
  await executor.resolveCheck("summary-mentions-limit", result(run, "summary-mentions-limit", "pass"));
  await flush();
  await executor.resolveCheck("notice-hides-secrets", result(run, "notice-hides-secrets", "pass"));

  const report = await reportPromise;
  expect(report.checks.map((record) => record.outcome)).toEqual(["fail", "pass", "pass"]);
  expect(report.aggregate.outcome).toBe("fail");
  expect(report.completion.status).toBe("completed");
});

test("one exhausted attempt records its error beside the passing siblings", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 1, max_pending: 2 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  await executor.resolveCheck("summary-length", failed("evaluator_error"));
  await flush();
  await executor.resolveCheck("summary-mentions-limit", result(run, "summary-mentions-limit", "pass"));
  await flush();
  await executor.resolveCheck("notice-hides-secrets", result(run, "notice-hides-secrets", "pass"));

  const report = await reportPromise;
  expect(report.checks[0]).toMatchObject({
    check: "summary-length",
    outcome: "error",
    reason: { code: "evaluator_error" },
  });
  expect(report.checks[1]?.outcome).toBe("pass");
  expect(report.aggregate.outcome).toBe("error");
  expect(report.completion.status).toBe("completed");
});

// ---------------------------------------------------------------------------
// Bounded retries, permanent failures, and backoff inside the deadline.
// ---------------------------------------------------------------------------

test("a retryable failure waits its bounded backoff before the retry starts", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 1, max_pending: 2, max_attempts: 3, backoff_ms: 50 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  // The first attempt fails at millisecond 10. The freed slot starts the
  // next queued check at once, and the retry enters its backoff.
  clock.advanceMs(10);
  await executor.resolveCheck("summary-length", failed("evaluator_timeout"));
  await flush();
  expect(executor.inFlight()).toEqual(["summary-mentions-limit"]);
  expect(executor.events.filter((event) => event.type === "retry_scheduled")).toEqual([
    { type: "retry_scheduled", check: "summary-length", attempt: 2, delay_ms: 50 },
  ]);

  // Every attempt of one run states the same attempt budget and the same
  // deadline instant, so one retry drifts neither the budget nor the run.
  for (const call of executor.calls) {
    expect(call.max_attempts).toBe(3);
    expect(call.deadline_at_ms).toBe(START_MS + config.deadline_ms);
  }

  // The queue drains while the backoff holds: millisecond 59 comes and
  // goes before the retry instant at millisecond 60.
  clock.advanceMs(49);
  await executor.resolveCheck("summary-mentions-limit", result(run, "summary-mentions-limit", "pass"));
  await flush();
  expect(executor.inFlight()).toEqual(["notice-hides-secrets"]);
  clock.advanceMs(1);
  await flush();
  expect(executor.inFlight()).toEqual(["notice-hides-secrets"]);
  expect(executor.calls.filter((call) => call.check === "summary-length")).toHaveLength(1);

  // The backoff passed, so the retry joins the shared queue and starts
  // when the active check frees its slot. The boundary accepted the same
  // run binding for the restart.
  clock.advanceMs(10);
  await executor.resolveCheck("notice-hides-secrets", result(run, "notice-hides-secrets", "pass"));
  await flush();
  expect(executor.inFlight()).toEqual(["summary-length"]);
  expect(executor.calls.at(-1)?.attempt).toBe(2);

  // The second failure doubles the delay: the third attempt waits 100.
  clock.advanceMs(10);
  await executor.resolveCheck("summary-length", failed("evaluator_error"));
  await flush();
  expect(executor.events.filter((event) => event.type === "retry_scheduled")).toEqual([
    { type: "retry_scheduled", check: "summary-length", attempt: 2, delay_ms: 50 },
    { type: "retry_scheduled", check: "summary-length", attempt: 3, delay_ms: 100 },
  ]);

  // The second backoff ends at millisecond 180, inside the total deadline,
  // and one pass on the third attempt records the true count.
  clock.advanceMs(100);
  await flush();
  expect(executor.inFlight()).toEqual(["summary-length"]);
  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  const report = await reportPromise;
  expect(report.checks[0]).toMatchObject({
    check: "summary-length",
    outcome: "pass",
    attempts: 3,
  });
  expect(report.checks.map((record) => record.outcome)).toEqual(["pass", "pass", "pass"]);
  expect(report.aggregate.outcome).toBe("pass");
  expect(report.completion).toEqual({
    status: "completed",
    completed_at: "2026-09-24T00:00:00.180Z",
  });
});

test("one permanent failure records its error without one retry", async () => {
  const clock = new FakeClock(START_MS);
  // Three attempts are available, but one answer outside the contract of
  // its check is one adapter defect: one retry would return through the
  // same broken path and spend one attempt for nothing.
  const config = execution({ max_active: 1, max_pending: 2, max_attempts: 3, backoff_ms: 50 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  clock.advanceMs(20);
  await executor.resolveCheck("summary-length", failed("invalid_assessment"));
  await flush();
  // No backoff and no second execution of the failed check: the next
  // sibling started at once.
  expect(executor.calls.map((call) => call.check)).toEqual([
    "summary-length",
    "summary-mentions-limit",
  ]);
  expect(executor.events.filter((event) => event.type === "retry_scheduled")).toEqual([]);

  await executor.resolveCheck("summary-mentions-limit", result(run, "summary-mentions-limit", "pass"));
  await flush();
  await executor.resolveCheck("notice-hides-secrets", result(run, "notice-hides-secrets", "pass"));
  const report = await reportPromise;

  // The record keeps the operational code and the true attempt count, and
  // the run stays usable: it completes with the visible defect.
  expect(report.checks[0]).toMatchObject({
    check: "summary-length",
    outcome: "error",
    attempts: 1,
    reason: { code: "invalid_assessment" },
  });
  expect(report.checks[1]?.outcome).toBe("pass");
  expect(report.aggregate.outcome).toBe("error");
  expect(report.completion.status).toBe("completed");

  // The clock passes the backoff instant that never armed, and the failed
  // check still holds no further execution.
  clock.advanceMs(200);
  await flush();
  expect(executor.calls.map((call) => call.check)).toEqual([
    "summary-length",
    "summary-mentions-limit",
    "notice-hides-secrets",
  ]);
});

test("cancellation during one backoff ends the run and disarms the backoff", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 1, max_pending: 2, max_attempts: 2, backoff_ms: 100 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const caller = new AbortController();
  const reportPromise = start(run, config, executor, clock, { signal: caller.signal });

  // The first attempt fails at millisecond 50, so the retry waits until
  // millisecond 150. The freed slot started the second check.
  clock.advanceMs(50);
  await executor.resolveCheck("summary-length", failed("evaluator_timeout"));
  await flush();
  expect(executor.inFlight()).toEqual(["summary-mentions-limit"]);
  expect(executor.events.filter((event) => event.type === "retry_scheduled")).toEqual([
    { type: "retry_scheduled", check: "summary-length", attempt: 2, delay_ms: 100 },
  ]);

  clock.advanceMs(20);
  caller.abort();
  const report = await reportPromise;
  expect(report.completion).toEqual({
    status: "cancelled",
    completed_at: "2026-09-24T00:00:00.070Z",
  });
  // The retrying check holds no record and no attempt in flight, so the
  // boundary assigns it the skip of never-started work. The active
  // sibling records the cancellation error.
  expect(report.checks).toMatchObject([
    { check: "summary-length", outcome: "skipped", reason: { code: "cancelled_before_start" } },
    { check: "summary-mentions-limit", outcome: "error", reason: { code: "run_cancelled" } },
    { check: "notice-hides-secrets", outcome: "skipped", reason: { code: "cancelled_before_start" } },
  ]);
  expect(report.aggregate.outcome).toBe("error");

  // The terminal path disarmed the backoff: the clock passes its instant
  // and the retry never executes.
  clock.advanceMs(200);
  await flush();
  expect(executor.calls.map((call) => call.check)).toEqual([
    "summary-length",
    "summary-mentions-limit",
  ]);
});

test("the deadline ends one backoff that outlives it", async () => {
  const clock = new FakeClock(START_MS);
  // The base delay outlives the total deadline, so the retry can never
  // start: the deadline wake-up ends the run first.
  const config = execution({
    max_active: 1,
    max_pending: 2,
    max_attempts: 2,
    backoff_ms: 200,
    deadline_ms: 100,
  });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  clock.advanceMs(40);
  await executor.resolveCheck("summary-length", failed("evaluator_timeout"));
  await flush();
  expect(executor.events.filter((event) => event.type === "retry_scheduled")).toEqual([
    { type: "retry_scheduled", check: "summary-length", attempt: 2, delay_ms: 200 },
  ]);

  clock.advanceMs(60);
  const report = await reportPromise;
  expect(report.completion).toEqual({
    status: "deadline_exceeded",
    completed_at: "2026-09-24T00:00:00.100Z",
  });
  expect(report.checks).toMatchObject([
    { check: "summary-length", outcome: "skipped", reason: { code: "deadline_before_start" } },
    { check: "summary-mentions-limit", outcome: "error", reason: { code: "deadline_exceeded" } },
    { check: "notice-hides-secrets", outcome: "skipped", reason: { code: "deadline_before_start" } },
  ]);
  expect(report.aggregate.outcome).toBe("error");
  expect(executor.calls.map((call) => call.check)).toEqual([
    "summary-length",
    "summary-mentions-limit",
  ]);
});

// ---------------------------------------------------------------------------
// Simultaneous submissions.
// ---------------------------------------------------------------------------

test("simultaneous runs keep separate queues and separate bounds", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 1, max_pending: 2 });
  const first = prepare(EXACT_RULES_PATH, PASSING_INPUT, config, "scheduled-000001");
  const second = prepare(EXACT_RULES_PATH, PASSING_INPUT, config, "scheduled-000002");
  const executor = new ManualExecutor();
  const firstPromise = start(first, config, executor, clock);
  const secondPromise = start(second, config, executor, clock);

  // Both runs submitted their first check before any resolution arrived.
  expect(executor.calls.map((attempt) => attempt.check)).toEqual([
    "summary-length",
    "summary-length",
  ]);
  // Each run admits its own single active slot, so two executions fly at once.
  expect(executor.highWater).toBe(2);
  const firstSignal = executor.calls[0]?.signal;
  const secondSignal = executor.calls[1]?.signal;
  expect(firstSignal).toBeDefined();
  expect(secondSignal).toBeDefined();
  expect(firstSignal).not.toBe(secondSignal);
  expect(executor.calls[0]?.deadline_at_ms).toBe(START_MS + config.deadline_ms);

  // The runs drain independently: run one starts its second check while the
  // second run still holds its first.
  await executor.resolveCheck("summary-length", result(first, "summary-length", "pass"));
  await flush();
  expect(executor.inFlight()).toEqual(["summary-length", "summary-mentions-limit"]);
  await executor.resolveCheck("summary-length", result(second, "summary-length", "pass"));
  await flush();
  expect(executor.inFlight()).toEqual(["summary-mentions-limit", "summary-mentions-limit"]);

  for (const run of [first, second]) {
    await executor.resolveCheck("summary-mentions-limit", result(run, "summary-mentions-limit", "pass"));
    await flush();
    await executor.resolveCheck("notice-hides-secrets", result(run, "notice-hides-secrets", "pass"));
    await flush();
  }
  const [firstReport, secondReport] = await Promise.all([firstPromise, secondPromise]);
  expect(firstReport.run_id).toBe("scheduled-000001");
  expect(secondReport.run_id).toBe("scheduled-000002");
  expect(firstReport.checks.map((record) => record.outcome)).toEqual(["pass", "pass", "pass"]);
  expect(secondReport.checks.map((record) => record.outcome)).toEqual(["pass", "pass", "pass"]);
});

// ---------------------------------------------------------------------------
// Operational failures and the terminal path.
// ---------------------------------------------------------------------------

test("one thrown execution becomes one operational failure, not one crash", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 3, max_pending: 2, max_attempts: 1 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const calls: ScheduledAttempt[] = [];
  const thrown = new Error("the scripted executor broke");
  const reportPromise = scheduleRun({
    state: run.state,
    caseReferenceText: run.caseReference,
    profileReferenceText: TRACE_PROFILE,
    execution: config,
    async execute(attempt: ScheduledAttempt): Promise<ScheduledResolution> {
      calls.push(attempt);
      if (attempt.check === "summary-length") {
        throw thrown;
      }
      return result(run, attempt.check, "pass");
    },
    now: () => clock.nowMs(),
  });

  const report = await reportPromise;
  expect(calls.map((attempt) => attempt.check)).toEqual([
    "summary-length",
    "summary-mentions-limit",
    "notice-hides-secrets",
  ]);
  expect(report.checks[0]).toMatchObject({
    outcome: "error",
    reason: { code: "evaluator_error" },
  });
  expect(report.aggregate.outcome).toBe("error");
});

test("the terminal path releases the signal and freezes the report", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 2, max_pending: 2 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  await executor.resolveCheck("summary-mentions-limit", result(run, "summary-mentions-limit", "pass"));
  await flush();
  await executor.resolveCheck("notice-hides-secrets", result(run, "notice-hides-secrets", "pass"));
  const report = await reportPromise;

  // Every stated attempt ran inside the run, and completion froze the core report.
  expect(run.state.phase).toBe("completed");
  expect(report).toStrictEqual(JSON.parse(run.state.reportText()!));
  // The terminal path releases the cancellation signal of every attempt.
  for (const attempt of executor.calls) {
    expect(attempt.signal.aborted).toBe(true);
  }
  // The returned report is immutable plain JSON data.
  expect(Object.isFrozen(report)).toBe(true);
  expect(Object.isFrozen(report.checks)).toBe(true);
});

test("one invalid execution configuration fails before any work starts", async () => {
  const clock = new FakeClock(START_MS);
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, execution());
  for (const [overrides, fieldPath] of [
    [{ max_active: 0 }, "/execution/max_active"],
    [{ max_pending: -1 }, "/execution/max_pending"],
    [{ max_attempts: 0 }, "/execution/max_attempts"],
    [{ max_attempts: 11 }, "/execution/max_attempts"],
    [{ deadline_ms: 0 }, "/execution/deadline_ms"],
  ] as const) {
    const executor = new ManualExecutor();
    const failure = await scheduleRun({
      state: run.state,
      caseReferenceText: run.caseReference,
      profileReferenceText: TRACE_PROFILE,
      execution: execution(overrides as Partial<ExecutionConfig>),
      execute: executor.execute,
      now: () => clock.nowMs(),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure, fieldPath).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code, fieldPath).toBe("invalid_field_type");
    expect((failure as { fieldPath?: string }).fieldPath, fieldPath).toBe(fieldPath);
    expect(executor.calls, fieldPath).toEqual([]);
  }
});

test("one invalid timer or signal option fails before any work starts", async () => {
  const clock = new FakeClock(START_MS);
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, execution());
  for (const [options, fieldPath] of [
    [{ setTimer: "no function" }, "/setTimer"],
    [{ signal: { aborted: "yes" } }, "/signal"],
    [{ signal: {} }, "/signal"],
  ] as const) {
    const executor = new ManualExecutor();
    const failure = await scheduleRun({
      state: run.state,
      caseReferenceText: run.caseReference,
      profileReferenceText: TRACE_PROFILE,
      execution: execution(),
      execute: executor.execute,
      now: () => clock.nowMs(),
      ...(options as Record<string, unknown>),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure, fieldPath).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code, fieldPath).toBe("invalid_field_type");
    expect((failure as { fieldPath?: string }).fieldPath, fieldPath).toBe(fieldPath);
    expect(executor.calls, fieldPath).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// The total deadline.
// ---------------------------------------------------------------------------

test("the total deadline ends active work and skips queued work", async () => {
  const clock = new FakeClock(START_MS);
  // One active slot runs one check while two wait, and the deadline of the
  // trace `deadline-before-start` passes before any resolution arrives.
  const config = execution({ max_active: 1, max_pending: 2, deadline_ms: 100 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  expect(executor.inFlight()).toEqual(["summary-length"]);
  clock.advanceMs(100);
  const report = await reportPromise;
  expect(report.checks).toMatchObject([
    { check: "summary-length", outcome: "error", reason: { code: "deadline_exceeded" } },
    { check: "summary-mentions-limit", outcome: "skipped", reason: { code: "deadline_before_start" } },
    { check: "notice-hides-secrets", outcome: "skipped", reason: { code: "deadline_before_start" } },
  ]);
  expect(report.aggregate.outcome).toBe("error");
  expect(report.completion).toEqual({
    status: "deadline_exceeded",
    completed_at: "2026-09-24T00:00:00.100Z",
  });
  expect(run.state.phase).toBe("deadline_exceeded");
  expect(executor.events.filter((event) => event.type === "deadline")).toEqual([{ type: "deadline" }]);
  // The terminal path released the cancellation signal of the attempt.
  expect(executor.calls[0]?.signal.aborted).toBe(true);
});

test("the deadline retains the completed record and ends the started work", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 2, max_pending: 2, deadline_ms: 500 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  // Two checks run, one completes before the deadline, and the freed slot
  // starts the queued check, so two executions outlive the deadline.
  clock.advanceMs(400);
  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  await flush();
  expect(executor.inFlight()).toEqual(["summary-mentions-limit", "notice-hides-secrets"]);

  clock.advanceMs(100);
  const report = await reportPromise;
  expect(report.checks).toMatchObject([
    { check: "summary-length", outcome: "pass" },
    { check: "summary-mentions-limit", outcome: "error", reason: { code: "deadline_exceeded" } },
    { check: "notice-hides-secrets", outcome: "error", reason: { code: "deadline_exceeded" } },
  ]);
  expect(report.aggregate.outcome).toBe("error");
  expect(report.completion.status).toBe("deadline_exceeded");
});

test("one resolution after the deadline changes no record", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 1, max_pending: 2, deadline_ms: 100 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const reportPromise = start(run, config, executor, clock);

  clock.advanceMs(100);
  const report = await reportPromise;
  const frozen = JSON.parse(run.state.reportText()!);

  // The adapter ignores the aborted signal and resolves anyway.
  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  await flush();
  expect(report).toStrictEqual(JSON.parse(run.state.reportText()!));
  expect(report).toStrictEqual(frozen);
  expect(report.checks[0]).toMatchObject({
    outcome: "error",
    reason: { code: "deadline_exceeded" },
  });
  expect(executor.events.filter((event) => event.type === "late_result_rejected")).toEqual([
    { type: "late_result_rejected", check: "summary-length" },
  ]);
});

test("the clock guards the deadline without one delivered wake-up", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 1, max_pending: 2, deadline_ms: 100 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  // The injected timer arms nothing, so one delayed wake-up cannot end the
  // run. The scheduler must still refuse work past the deadline instant.
  const reportPromise = scheduleRun({
    state: run.state,
    caseReferenceText: run.caseReference,
    profileReferenceText: TRACE_PROFILE,
    execution: config,
    execute: executor.execute,
    now: () => clock.nowMs(),
    setTimer: () => () => undefined,
    observe: executor.observe,
  });

  clock.advanceMs(250);
  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  const report = await reportPromise;
  expect(report.checks).toMatchObject([
    { check: "summary-length", outcome: "error", reason: { code: "deadline_exceeded" } },
    { check: "summary-mentions-limit", outcome: "skipped", reason: { code: "deadline_before_start" } },
    { check: "notice-hides-secrets", outcome: "skipped", reason: { code: "deadline_before_start" } },
  ]);
  expect(report.completion.status).toBe("deadline_exceeded");
  expect(executor.events.map((event) => event.type)).toContain("deadline");
  expect(executor.events.filter((event) => event.type === "late_result_rejected")).toEqual([
    { type: "late_result_rejected", check: "summary-length" },
  ]);
});

// ---------------------------------------------------------------------------
// Caller cancellation.
// ---------------------------------------------------------------------------

test("one pre-aborted caller signal cancels before any work starts", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 1, max_pending: 2 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const caller = new AbortController();
  caller.abort();

  const reportPromise = start(run, config, executor, clock, { signal: caller.signal });
  const report = await reportPromise;
  expect(executor.calls).toEqual([]);
  expect(report.checks).toMatchObject([
    { check: "summary-length", outcome: "skipped", reason: { code: "cancelled_before_start" } },
    { check: "summary-mentions-limit", outcome: "skipped", reason: { code: "cancelled_before_start" } },
    { check: "notice-hides-secrets", outcome: "skipped", reason: { code: "cancelled_before_start" } },
  ]);
  expect(report.aggregate.outcome).toBe("review");
  expect(report.completion.status).toBe("cancelled");
  expect(run.state.phase).toBe("cancelled");
  expect(executor.events.map((event) => event.type)).toEqual(["submit", "cancel"]);
});

test("one abort inside the first attempt stops the admission loop", async () => {
  const clock = new FakeClock(START_MS);
  // Two active slots would admit two checks. The first execution aborts the
  // caller synchronously, before it returns control, so the run ends during
  // admission and the remaining checks cross no boundary: the frozen
  // cancelled report returns instead of one internal refusal.
  const config = execution({ max_active: 2, max_pending: 2 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const caller = new AbortController();
  let started = 0;
  const aborting = (attempt: ScheduledAttempt): Promise<ScheduledResolution> => {
    started += 1;
    if (started === 1) {
      caller.abort();
    }
    return executor.execute(attempt);
  };
  const reportPromise = scheduleRun({
    state: run.state,
    caseReferenceText: run.caseReference,
    profileReferenceText: TRACE_PROFILE,
    execution: config,
    execute: aborting,
    now: () => clock.nowMs(),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
    signal: caller.signal,
    observe: executor.observe,
  });

  const report = await reportPromise;
  expect(started).toBe(1);
  expect(report.completion.status).toBe("cancelled");
  expect(report.checks).toMatchObject([
    { check: "summary-length", outcome: "error", reason: { code: "run_cancelled" } },
    { check: "summary-mentions-limit", outcome: "skipped", reason: { code: "cancelled_before_start" } },
    { check: "notice-hides-secrets", outcome: "skipped", reason: { code: "cancelled_before_start" } },
  ]);
  expect(report.aggregate.outcome).toBe("error");
  expect(run.state.phase).toBe("cancelled");
});

test("caller cancellation propagates to adapters and clears queued work", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 1, max_pending: 2 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const caller = new AbortController();
  const reportPromise = start(run, config, executor, clock, { signal: caller.signal });

  expect(executor.inFlight()).toEqual(["summary-length"]);
  clock.advanceMs(300);
  caller.abort();
  const report = await reportPromise;
  expect(report.checks).toMatchObject([
    { check: "summary-length", outcome: "error", reason: { code: "run_cancelled" } },
    { check: "summary-mentions-limit", outcome: "skipped", reason: { code: "cancelled_before_start" } },
    { check: "notice-hides-secrets", outcome: "skipped", reason: { code: "cancelled_before_start" } },
  ]);
  expect(report.aggregate.outcome).toBe("error");
  expect(report.completion).toEqual({
    status: "cancelled",
    completed_at: "2026-09-24T00:00:00.300Z",
  });
  // The cancellation crossed to the adapter: the attempt signal aborted
  // with the reason of the caller.
  expect(executor.calls[0]?.signal.aborted).toBe(true);
  expect(executor.calls[0]?.signal.reason).toBe(caller.signal.reason);
  expect(executor.events.filter((event) => event.type === "cancel")).toEqual([{ type: "cancel" }]);

  // The adapter ignores the aborted signal and resolves afterwards. The
  // frozen report accepts no late change.
  const frozen = JSON.parse(run.state.reportText()!);
  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  await flush();
  expect(report).toStrictEqual(frozen);
  expect(report).toStrictEqual(JSON.parse(run.state.reportText()!));
  expect(executor.events.filter((event) => event.type === "late_result_rejected")).toEqual([
    { type: "late_result_rejected", check: "summary-length" },
  ]);
});

test("cancellation retains the records that completed before it", async () => {
  const clock = new FakeClock(START_MS);
  // Two active slots and no pending slot: the third check records its
  // queue-full skip at admission, so one record of each kind exists when
  // the caller cancels after one completion.
  const config = execution({ max_active: 2, max_pending: 0 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const caller = new AbortController();
  const reportPromise = start(run, config, executor, clock, { signal: caller.signal });

  expect(executor.inFlight()).toEqual(["summary-length", "summary-mentions-limit"]);
  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  await flush();
  // The queue holds no work, so the freed slot starts nothing.
  expect(executor.inFlight()).toEqual(["summary-mentions-limit"]);

  clock.advanceMs(100);
  caller.abort();
  const report = await reportPromise;
  expect(report.checks).toMatchObject([
    { check: "summary-length", outcome: "pass" },
    { check: "summary-mentions-limit", outcome: "error", reason: { code: "run_cancelled" } },
    { check: "notice-hides-secrets", outcome: "skipped", reason: { code: "queue_full" } },
  ]);
  expect(report.aggregate.outcome).toBe("error");
  expect(report.completion.status).toBe("cancelled");
});

test("one caller abort after one normal completion changes nothing", async () => {
  const clock = new FakeClock(START_MS);
  const config = execution({ max_active: 2, max_pending: 2 });
  const run = prepare(EXACT_RULES_PATH, PASSING_INPUT, config);
  const executor = new ManualExecutor();
  const caller = new AbortController();
  const reportPromise = start(run, config, executor, clock, { signal: caller.signal });

  await executor.resolveCheck("summary-length", result(run, "summary-length", "pass"));
  await executor.resolveCheck("summary-mentions-limit", result(run, "summary-mentions-limit", "pass"));
  await flush();
  await executor.resolveCheck("notice-hides-secrets", result(run, "notice-hides-secrets", "pass"));
  const report = await reportPromise;
  expect(report.completion.status).toBe("completed");

  // The terminal path removed the listener on the caller signal, so one
  // abort afterwards mutates no frozen report and states no event.
  caller.abort();
  await flush();
  expect(run.state.phase).toBe("completed");
  expect(report).toStrictEqual(JSON.parse(run.state.reportText()!));
  expect(executor.events.filter((event) => event.type === "cancel")).toEqual([]);
  expect(executor.events.filter((event) => event.type === "late_result_rejected")).toEqual([]);
});

// ---------------------------------------------------------------------------
// The shared runtime traces replay through the scheduler.
// ---------------------------------------------------------------------------

/**
 * The traces that the scheduler reproduces end to end. The environment
 * events it states itself are the wake-up of the total deadline, one
 * caller cancellation, and one resolution that one adapter delivers after
 * one terminal path. Four traces stay boundary-level rows of the native
 * suite: `duplicate-result` needs one second resolution of one execution,
 * `late-result-after-completion` needs one execution in flight after one
 * drained completion, and `deadline-keeps-completed` and `cancel-mid-run`
 * state one `check_started` order that disagrees with the
 * first-in-first-out drain of this scheduler.
 */
const REPLAYABLE_TRACE_IDS = new Set([
  "exact-all-pass",
  "queue-full",
  "deadline-before-start",
  "cancel-before-start",
  "retries-exhausted",
  "retry-then-success",
  "permanent-failure",
  "late-result-after-cancel",
  "partial-failure-mix",
]);

test("the shared runtime traces replay through the scheduler", async () => {
  const traces: Array<{
    id: string;
    definition: string;
    case_input: Record<string, unknown>;
    config: ExecutionConfig;
    events: Array<{ at_ms: number; type: string; check?: string; outcome?: string; code?: string }>;
    expected: {
      checks: Array<Record<string, unknown>>;
      aggregate: string;
      completion: string;
      rejected_events: Array<{ event: number; reason_code: string }>;
    };
  }> = fixtureDocument("runtime/traces.json").traces;

  const replayable = traces.filter((trace) => REPLAYABLE_TRACE_IDS.has(trace.id));
  expect(replayable.map((trace) => trace.id)).toEqual([
    "exact-all-pass",
    "queue-full",
    "deadline-before-start",
    "cancel-before-start",
    "retries-exhausted",
    "retry-then-success",
    "permanent-failure",
    "late-result-after-cancel",
    "partial-failure-mix",
  ]);

  for (const trace of replayable) {
    const clock = new FakeClock(START_MS);
    const run = prepare(`definitions/valid/${trace.definition}`, trace.case_input, trace.config);
    const executor = new ManualExecutor();
    const caller = new AbortController();
    // One cancel event that follows only the submit event precedes every
    // start, so the harness aborts the caller before the scheduler runs.
    const cancelBeforeStart = trace.events.some(
      (event, index) =>
        event.type === "cancel" &&
        trace.events.slice(0, index).every((prior) => prior.type === "submit"),
    );
    if (cancelBeforeStart) {
      caller.abort();
    }
    const reportPromise = start(run, trace.config, executor, clock, { signal: caller.signal });

    // The trace events that state scheduler decisions must appear in order.
    let cursor = 0;
    const advance = (expected: { type: string; check?: string }): void => {
      while (cursor < executor.events.length) {
        const observed = executor.events[cursor]!;
        cursor += 1;
        if (observed.type === "check_started" || observed.type === "check_skipped") {
          expect(`${trace.id}: ${observed.type} of ${observed.check}`).toBe(
            `${trace.id}: ${expected.type} of ${expected.check}`,
          );
          return;
        }
      }
      throw new Error(`${trace.id}: the scheduler stated no event for ${expected.type}`);
    };

    const rejections: Array<{ event: number; reason_code: string }> = [];
    let currentMs = 0;
    for (const [index, event] of trace.events.entries()) {
      clock.advanceMs(event.at_ms - currentMs);
      currentMs = event.at_ms;
      switch (event.type) {
        case "submit":
          expect(executor.events[0]?.type, trace.id).toBe("submit");
          break;
        case "check_started":
        case "check_skipped":
          advance(event);
          break;
        case "check_result":
          await executor.resolveCheck(
            event.check!,
            result(run, event.check!, event.outcome as "pass" | "fail" | "review"),
          );
          await flush();
          break;
        case "attempt_failed":
          await executor.resolveCheck(
            event.check!,
            failed(event.code as "evaluator_error" | "evaluator_timeout" | "invalid_assessment"),
          );
          await flush();
          break;
        case "deadline":
          // The clock advance fired the armed wake-up of the total deadline.
          expect(
            executor.events.filter((observed) => observed.type === "deadline"),
            trace.id,
          ).toEqual([{ type: "deadline" }]);
          break;
        case "cancel":
          caller.abort();
          await flush();
          expect(
            executor.events.filter((observed) => observed.type === "cancel"),
            trace.id,
          ).toEqual([{ type: "cancel" }]);
          break;
        case "late_result":
          await executor.resolveCheck(
            event.check!,
            result(run, event.check!, event.outcome as "pass" | "fail" | "review"),
          );
          await flush();
          expect(
            executor.events.filter((observed) => observed.type === "late_result_rejected"),
            trace.id,
          ).toEqual([{ type: "late_result_rejected", check: event.check }]);
          rejections.push({ event: index, reason_code: "late_result_rejected" });
          break;
        default:
          throw new Error(`${trace.id}: one unsupported event ${event.type}`);
      }
    }
    const report = await reportPromise;

    // Every expected check record, the aggregate, and the completion match.
    expect(report.checks, trace.id).toMatchObject(trace.expected.checks);
    expect(report.aggregate.outcome, trace.id).toBe(trace.expected.aggregate);
    expect(report.completion.status, trace.id).toBe(trace.expected.completion);
    expect(rejections, trace.id).toEqual(trace.expected.rejected_events);
  }
});
