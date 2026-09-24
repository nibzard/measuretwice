// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded scheduling for one run of one case.
 *
 * The TypeScript wrapper owns the queue, and this module is that queue.
 * MVP_SPEC.md section 5 draws the boundary: the Rust core validates every
 * run transition and freezes the terminal report, while the wrapper bounds
 * concurrency, pending work, retries, and total execution time. The checked
 * model in `models/execution/Execution.tla` fixes the rules, and its record
 * in `models/execution/README.md` assigns the wrapper rows of task T030 to
 * this module: queue admission below `max_pending`, counted over
 * never-started work, and one `skipped` record with reason `queue_full`
 * when no slot can accept the work.
 *
 * `scheduleRun` drives one run state that its caller created with the run
 * binding. It states every event to the Rust boundary: each attempt start
 * offers that binding again, so the boundary refuses one drifted offer, and
 * each resolution crosses as one component record or one operational
 * failure. The scheduler keeps the model places itself. Submitted work
 * starts while active slots remain, waits in one first-in-first-out queue
 * while pending slots remain, and records one queue-full skip when both
 * limits are spent. Fresh work and retrying work share the queue, but only
 * never-started work counts against `max_pending`, because one retry of
 * started work is no new work.
 *
 * The scheduler attempts every required check. One semantic outcome, one
 * operational failure, and one skip change nothing about the admission of
 * the remaining checks, because MVP_SPEC.md section 9 forbids cost-based
 * short-circuiting and the aggregate needs every component record.
 *
 * Bounded retries arrived with task T032, and the wrapper owns their
 * policy. One failed attempt crosses the boundary first, so the boundary
 * keeps the attempt count and freezes the record contract. While the
 * boundary reports attempts left, the scheduler retries one failure when
 * and only when its reason code names one transient execution condition:
 * {@link isRetryableFailure} states the class. One retryable failure
 * waits one bounded backoff before it rejoins the shared queue, and each
 * retry restarts through the boundary with the same run binding, the same
 * projected request, and the remaining budget of the same total deadline,
 * so one retry can drift neither the binding nor the budget. One
 * permanent failure records its error at the failing attempt through the
 * permanent boundary transition, whatever attempts remain: one adapter
 * answer outside its contract would return from one retry through the
 * same broken path, so the retry would spend one attempt and change
 * nothing. The record keeps the operational code and the true attempt
 * count, and no dummy restart inflates either.
 *
 * The backoff between attempts is deterministic and bounded. The first
 * retry waits `backoff_ms`, every later retry doubles the delay, the
 * attempt limit bounds the doubling, and the total deadline bounds the
 * wait: one delay that reaches past the deadline instant never starts,
 * because the deadline wake-up ends the run first. The scheduler arms no
 * jitter, because the wrapper holds no random source and the deterministic
 * delay keeps one run replayable. A backoff of zero restarts the attempt
 * when one slot frees, exactly as one shared queue entry.
 *
 * One total deadline covers the complete attempt lifecycle: queue time,
 * every attempt, and the backoff between attempts, as MVP_SPEC.md section
 * 12 requires. The scheduler arms one wake-up at the deadline instant and
 * re-reads the injected clock before each resolution and each start, so
 * one delayed wake-up cannot admit one late result. At the deadline the
 * boundary ends the run: active work records one `deadline_exceeded`
 * error, never-started work records one `deadline_before_start` skip, and
 * completed records stay. A retry that waits in its backoff holds no
 * record, so the boundary assigns it the skip of never-started work at
 * the terminal instant. The caller cancels through one AbortSignal.
 * Cancellation propagates to every attempt context, clears the queue,
 * disarms every pending backoff, and ends the run through the `cancelled`
 * transition of the boundary.
 *
 * Every terminal path releases the wrapper resources. The run ends through
 * the boundary, the returned report is parsed from the frozen core report
 * and frozen again, the scheduler drops its queue, disarms its wake-up,
 * removes its listener on the caller signal, and aborts its cancellation
 * signal, so no adapter keeps one listener. One resolution that arrives
 * after any terminal path fits no valid transition, so the scheduler drops
 * it, states one `late_result_rejected` event, and the report stays
 * frozen: one adapter that ignores the signal cannot mutate one terminal
 * report.
 *
 * Failure behavior: one execution configuration outside the contract
 * bounds, one terminal run state, or one option outside its shape rejects
 * with one {@link ValidationError} before any work starts. One execution
 * that throws resolves as one `evaluator_error` failure, so one broken
 * executor cannot crash one run. One boundary refusal ends the run with
 * one explicit `Error`, because it states one internal inconsistency of
 * the wrapper, never one invalid input of the host. Task T034 wires this
 * module into the semantic run path of `run`.
 */
import {
  NativeFailure,
  runAcceptResult,
  runCancel,
  runComplete,
  runDeadline,
  runFailAttempt,
  runFailPermanent,
  runSkipQueueFull,
  runStartAttempt,
  type RunState,
} from "./native.js";
import { ValidationError } from "./error.js";
import type { ExecutionConfig, RunCheckRecord, RunReport } from "./run.js";

// ---------------------------------------------------------------------------
// Public types of the scheduler.
// ---------------------------------------------------------------------------

/**
 * One component record that one execution resolved.
 *
 * The record holds one semantic outcome, as the run report contract states
 * it. The Rust boundary validates the record against the check that asked
 * for it, so one mismatched check, one mismatched kind, and one operational
 * outcome cross as one refusal.
 */
export type ScheduledRecord = Omit<RunCheckRecord, "outcome"> & {
  /** The semantic outcome that the execution reported. */
  readonly outcome: "pass" | "fail" | "review";
};

/**
 * One attempt that the scheduler started.
 *
 * The context states the execution budget that the evaluator contract
 * defines: the attempt number, the attempt limit of the configuration, and
 * the deadline instant of the run. The signal aborts when the run reaches
 * one terminal path.
 */
export interface ScheduledAttempt {
  /** The assessed check identifier. */
  readonly check: string;
  /** The attempt that this execution starts. The first attempt is 1. */
  readonly attempt: number;
  /** The greatest attempt number of the effective execution configuration. */
  readonly max_attempts: number;
  /** The epoch-millisecond instant when the run deadline passes. */
  readonly deadline_at_ms: number;
  /** The cancellation signal of the run. The execution stops when it aborts. */
  readonly signal: AbortSignal;
}

/**
 * The resolution of one execution: exactly one semantic record or one
 * operational failure. The failure message must satisfy the sanitized
 * reason contract, as the evaluator normalization already guarantees.
 */
export type ScheduledResolution =
  | { readonly record: ScheduledRecord }
  | {
      readonly failure: {
        readonly code: "evaluator_error" | "evaluator_timeout" | "invalid_assessment";
        readonly message: string;
      };
    };

/**
 * One scheduling decision or resolution that the scheduler stated.
 *
 * The event vocabulary follows the shared runtime traces of
 * `fixtures/runtime/traces.json`, so one observer log reads like one trace.
 * The `retry_scheduled` event names one retryable failure that entered its
 * bounded backoff, the `deadline` and `cancel` events name the terminal
 * transitions that the scheduler stated through the boundary, and
 * `late_result_rejected` names one resolution that arrived after one
 * terminal path and changed no record.
 */
export type SchedulerEvent =
  | { readonly type: "submit"; readonly checks: readonly string[] }
  | { readonly type: "check_queued"; readonly check: string }
  | { readonly type: "check_skipped"; readonly check: string; readonly code: "queue_full" }
  | { readonly type: "check_started"; readonly check: string; readonly attempt: number }
  | { readonly type: "attempt_failed"; readonly check: string; readonly code: string }
  | { readonly type: "retry_scheduled"; readonly check: string; readonly attempt: number; readonly delay_ms: number }
  | { readonly type: "check_result"; readonly check: string; readonly outcome: "pass" | "fail" | "review" }
  | { readonly type: "deadline" }
  | { readonly type: "cancel" }
  | { readonly type: "late_result_rejected"; readonly check: string };

/**
 * The operational reason codes that name one transient execution condition.
 *
 * `evaluator_error` covers the thrown provider failures, such as one
 * refused connection or one retryable status, and `evaluator_timeout`
 * covers the aborted and timed-out attempts. `invalid_assessment` is
 * absent on purpose: one adapter answer outside the contract of its check
 * is one defect of the adapter path, and one retry would return through
 * the same path, so the scheduler treats it as permanent.
 */
const RETRYABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "evaluator_error",
  "evaluator_timeout",
]);

/**
 * States whether the scheduler retries one operational failure.
 *
 * The retry policy is one wrapper decision, as MVP_SPEC.md section 5
 * draws the boundary: one retryable failure returns to the queue through
 * the run boundary while attempts remain, and one permanent failure
 * records its error at the failing attempt.
 */
export function isRetryableFailure(code: string): boolean {
  return RETRYABLE_FAILURE_CODES.has(code);
}

/** The options of `scheduleRun`. */
export interface ScheduleOptions {
  /** The run state of the core, created with the run binding and the attempt limit. */
  readonly state: RunState;
  /** The serialized case reference of the run binding. Each attempt offers it again. */
  readonly caseReferenceText: string;
  /** The serialized profile reference of the run binding. Each attempt offers it again. */
  readonly profileReferenceText: string;
  /** The effective execution configuration of the bound profile. */
  readonly execution: ExecutionConfig;
  /** Executes one started attempt. The scheduler bounds how many run at one time. */
  readonly execute: (attempt: ScheduledAttempt) => Promise<ScheduledResolution>;
  /** The clock of the wrapper, in epoch milliseconds. */
  readonly now: () => number;
  /** The cancellation signal of the caller. The run cancels when it aborts. Optional. */
  readonly signal?: AbortSignal;
  /**
   * Arms one wake-up at one epoch-millisecond instant, and returns one
   * operation that cancels the wake-up. The default arms one Node timer
   * for the remaining time of the injected clock. Controlled-clock tests
   * inject one timer queue that fires when the clock advances.
   */
  readonly setTimer?: (atMs: number, onWake: () => void) => () => void;
  /** One observer of the scheduling decisions. Optional. */
  readonly observe?: (event: SchedulerEvent) => void;
}

// ---------------------------------------------------------------------------
// The scheduler.
// ---------------------------------------------------------------------------

/**
 * Schedules one run of one case inside the bounds of its effective
 * execution configuration, and returns the frozen run report.
 *
 * The caller creates the run state with the same attempt limit that the
 * configuration states, so the boundary holds the budget that the attempt
 * contexts report. Every admission, every attempt start, every resolution,
 * and every terminal transition cross the Rust boundary. The returned
 * promise settles when the run reaches one terminal path: completion,
 * caller cancellation through `signal`, or the total deadline.
 *
 * @throws {ValidationError} when the execution configuration breaks its
 * contract bounds, when the run state already reached one terminal phase,
 * or when one option breaks its shape. Every failure happens before any
 * work starts.
 */
export async function scheduleRun(options: ScheduleOptions): Promise<RunReport> {
  validateExecution(options.execution);
  if (typeof options.execute !== "function") {
    throw new ValidationError(
      "invalid_field_type",
      "The scheduler received no execute operation. Pass one function that executes one started attempt.",
      "/execute",
    );
  }
  if (typeof options.now !== "function") {
    throw new ValidationError(
      "invalid_field_type",
      "The scheduler received no clock. Pass one function that returns the epoch milliseconds.",
      "/now",
    );
  }
  if (options.setTimer !== undefined && typeof options.setTimer !== "function") {
    throw new ValidationError(
      "invalid_field_type",
      "The scheduler received no timer operation. Pass one function that arms one wake-up at one instant.",
      "/setTimer",
    );
  }
  if (options.signal !== undefined && !isAbortSignal(options.signal)) {
    throw new ValidationError(
      "invalid_field_type",
      "The scheduler received no caller cancellation signal. Pass one AbortSignal or nothing.",
      "/signal",
    );
  }
  if (typeof options.caseReferenceText !== "string" || options.caseReferenceText === "") {
    throw new ValidationError(
      "invalid_field_type",
      "The scheduler received no case reference text. Pass the serialized case reference of the run binding.",
      "/caseReferenceText",
    );
  }
  if (typeof options.profileReferenceText !== "string" || options.profileReferenceText === "") {
    throw new ValidationError(
      "invalid_field_type",
      "The scheduler received no profile reference text. Pass the serialized profile reference of the run binding.",
      "/profileReferenceText",
    );
  }
  if (options.state.phase !== "running") {
    throw new ValidationError(
      "invalid_state_transition",
      "The run state already reached one terminal phase. The scheduler drives one running run.",
      "/state",
    );
  }

  const checks = [...options.state.checkIds()];
  const deadlineAtMs = options.now() + options.execution.deadline_ms;
  const controller = new AbortController();
  const caller = options.signal;

  // The scheduler places of the model: active work, one shared queue, and
  // the never-started part of that queue, which alone counts against the
  // pending limit. `unfinished` counts the checks that hold no record yet.
  // `backoffWakes` holds the disarm operation of every pending backoff.
  let active = 0;
  let unfinished = checks.length;
  let ended = false;
  let settled = false;
  let disarmWake: (() => void) | undefined;
  const waiting: string[] = [];
  const neverStarted = new Set<string>();
  const backoffWakes: Array<() => void> = [];

  let resolveReport!: (report: RunReport) => void;
  let rejectReport!: (cause: Error) => void;
  const finished = new Promise<RunReport>((resolve, reject) => {
    resolveReport = resolve;
    rejectReport = reject;
  });

  /** Answers one caller cancellation: the run ends and every adapter stops. */
  const onCallerAbort = (): void => {
    terminate("cancel", caller?.reason);
  };

  /** Drops every wrapper resource of the run, and aborts the adapters. */
  const release = (reason?: unknown): void => {
    ended = true;
    disarmWake?.();
    disarmWake = undefined;
    for (const disarm of backoffWakes) {
      disarm();
    }
    backoffWakes.length = 0;
    caller?.removeEventListener("abort", onCallerAbort);
    controller.abort(reason);
    waiting.length = 0;
    neverStarted.clear();
  };

  /**
   * Ends the run through one terminal boundary transition: `cancel` or
   * `deadline`. The boundary assigns the records, freezes the report, and
   * the returned promise settles with that frozen report. One later event
   * changes nothing.
   */
  const terminate = (kind: "cancel" | "deadline", reason: unknown): void => {
    if (ended || settled) {
      return;
    }
    release(reason);
    if (kind === "cancel") {
      guarded("run cancellation", () => runCancel(options.state, terminalTime(options.now)));
      emit({ type: "cancel" });
    } else {
      guarded("run deadline", () => runDeadline(options.state, terminalTime(options.now)));
      emit({ type: "deadline" });
    }
    finishReport();
  };

  /** Builds the abort reason that states the total deadline of the run. */
  const deadlineReason = (): Error =>
    new Error(
      `measuretwice ended the run at its total deadline of ${options.execution.deadline_ms} milliseconds.`,
    );

  /** Ends the run at its total deadline when the injected clock reached it. */
  const enforceDeadline = (): void => {
    if (!ended && !settled && options.now() >= deadlineAtMs) {
      terminate("deadline", deadlineReason());
    }
  };

  /** Ends the run with one explicit failure. One later event changes nothing. */
  const failRun = (cause: unknown): void => {
    if (settled) {
      return;
    }
    release();
    settled = true;
    rejectReport(cause instanceof Error ? cause : new Error(String(cause)));
  };

  /**
   * Runs one boundary transition. One refusal states one internal
   * inconsistency of the wrapper, so it ends the run with one explicit
   * error instead of one silent state change.
   */
  const guarded = <T>(description: string, operation: () => T): T => {
    try {
      return operation();
    } catch (cause) {
      const error = cause instanceof NativeFailure
        ? new Error(
            `measuretwice scheduler stated one ${description} that the core run boundary refused: ${cause.message}`,
            { cause },
          )
        : cause instanceof Error
          ? cause
          : new Error(String(cause));
      failRun(error);
      throw error;
    }
  };

  const emit = (event: SchedulerEvent): void => {
    if (options.observe !== undefined) {
      options.observe(event);
    }
  };

  /** Starts the next attempt of one check through the boundary. */
  const startAttempt = (check: string): void => {
    const attempt = guarded(`attempt start of the check ${check}`, () =>
      runStartAttempt(options.state, check, options.caseReferenceText, options.profileReferenceText),
    );
    neverStarted.delete(check);
    active += 1;
    emit({ type: "check_started", check, attempt });
    let execution: Promise<ScheduledResolution>;
    try {
      execution = options.execute({
        check,
        attempt,
        max_attempts: options.execution.max_attempts,
        deadline_at_ms: deadlineAtMs,
        signal: controller.signal,
      });
    } catch (cause) {
      execution = Promise.resolve(thrownResolution(cause));
    }
    void Promise.resolve(execution).then(
      (resolution) => settle(check, resolution),
      (cause) => settle(check, thrownResolution(cause)),
    ).catch((cause: unknown) => {
      failRun(cause);
    });
  };

  /** Starts waiting work while active slots remain and the deadline stays ahead. */
  const drain = (): void => {
    enforceDeadline();
    while (!ended && active < options.execution.max_active && waiting.length > 0) {
      startAttempt(waiting.shift()!);
    }
  };

  /**
   * Returns one retrying check to the shared queue, after its bounded
   * backoff. The retry restarts through the boundary with the same run
   * binding, so no drift can cross, and the deadline wake-up bounds the
   * wait from above.
   */
  const scheduleRetry = (check: string, attemptsStarted: number): void => {
    const delayMs = backoffDelayMs(options.execution.backoff_ms, attemptsStarted);
    if (delayMs <= 0) {
      // One zero base delay restarts the attempt when one slot frees.
      waiting.push(check);
      return;
    }
    emit({ type: "retry_scheduled", check, attempt: attemptsStarted + 1, delay_ms: delayMs });
    const readyAtMs = options.now() + delayMs;
    backoffWakes.push(
      armWake(readyAtMs, () => {
        if (ended || settled) {
          return;
        }
        enforceDeadline();
        if (ended || settled) {
          return;
        }
        // The backoff passed inside the total deadline, so the retry joins
        // the shared queue and consumes no pending slot.
        waiting.push(check);
        drain();
      }),
    );
  };

  /** Resolves one in-flight attempt through the boundary. */
  const settle = (check: string, resolution: ScheduledResolution): void => {
    if (ended) {
      // One resolution after the terminal path fits no valid transition,
      // so the scheduler drops it and the report stays frozen.
      emit({ type: "late_result_rejected", check });
      return;
    }
    if (options.now() >= deadlineAtMs) {
      // The attempt outlived the total deadline. The run ends here, and
      // the late resolution changes no record.
      terminate("deadline", deadlineReason());
      emit({ type: "late_result_rejected", check });
      return;
    }
    active -= 1;
    if ("failure" in resolution) {
      if (!isRetryableFailure(resolution.failure.code)) {
        // One permanent failure ends the check at the attempt that
        // reported it: the record keeps the operational code and the true
        // attempt count, and no dummy restart spends the remaining budget.
        guarded(`permanent failure of the check ${check}`, () =>
          runFailPermanent(
            options.state,
            check,
            resolution.failure.code,
            resolution.failure.message,
          ),
        );
        emit({ type: "attempt_failed", check, code: resolution.failure.code });
        unfinished -= 1;
        drain();
        completeIfDrained();
        return;
      }
      const outcome = guarded(`attempt failure of the check ${check}`, () =>
        runFailAttempt(options.state, check, resolution.failure.code, resolution.failure.message),
      );
      emit({ type: "attempt_failed", check, code: resolution.failure.code });
      if (outcome.resolution === "retry_queued") {
        // Retrying work shares the queue and consumes no pending slot. The
        // freed slot still starts waiting work at once.
        scheduleRetry(check, outcome.attempts ?? 1);
        drain();
        return;
      }
      unfinished -= 1;
    } else {
      const recordText = guarded(`result record of the check ${check}`, () =>
        JSON.stringify(resolution.record),
      );
      guarded(`result of the check ${check}`, () =>
        runAcceptResult(options.state, check, recordText),
      );
      emit({ type: "check_result", check, outcome: resolution.record.outcome });
      unfinished -= 1;
    }
    drain();
    completeIfDrained();
  };

  /** Completes the run through the boundary when every check holds one record. */
  const completeIfDrained = (): void => {
    if (ended || unfinished > 0) {
      return;
    }
    release();
    guarded("run completion", () => runComplete(options.state, terminalTime(options.now)));
    finishReport();
  };

  /** Settles the returned promise with the frozen report of the core. */
  const finishReport = (): void => {
    const reportText = options.state.reportText();
    if (reportText === null) {
      settled = true;
      rejectReport(new Error("measuretwice ended the run, but the core stated no report."));
      return;
    }
    const report: unknown = JSON.parse(reportText);
    deepFreeze(report);
    settled = true;
    resolveReport(report as RunReport);
  };

  // The caller may cancel before the scheduler runs. No work starts: the
  // boundary assigns one cancellation record to every check, and the run
  // reports `cancelled`.
  if (caller?.aborted) {
    emit({ type: "submit", checks });
    terminate("cancel", caller.reason);
    return finished;
  }

  // The wake-up of the total deadline. The default arms one Node timer for
  // the remaining time of the injected clock; one injected timer keeps
  // controlled-clock tests deterministic.
  const nodeTimer = (atMs: number, onWake: () => void): (() => void) => {
    const handle = setTimeout(onWake, Math.max(0, atMs - options.now()));
    return () => clearTimeout(handle);
  };
  const armWake = options.setTimer ?? nodeTimer;
  disarmWake = armWake(deadlineAtMs, enforceDeadline);
  caller?.addEventListener("abort", onCallerAbort, { once: true });

  // Admission in definition order. One free active slot starts new work,
  // one free pending slot queues it, and one spent queue skips it.
  emit({ type: "submit", checks });
  for (const check of checks) {
    if (active < options.execution.max_active) {
      startAttempt(check);
    } else if (neverStarted.size < options.execution.max_pending) {
      waiting.push(check);
      neverStarted.add(check);
      emit({ type: "check_queued", check });
    } else {
      guarded(`queue-full skip of the check ${check}`, () =>
        runSkipQueueFull(options.state, check),
      );
      unfinished -= 1;
      emit({ type: "check_skipped", check, code: "queue_full" });
    }
  }
  completeIfDrained();
  return finished;
}

// ---------------------------------------------------------------------------
// Wrapper helpers.
// ---------------------------------------------------------------------------

/** Maps one thrown execution to one operational failure, so no broken executor crashes one run. */
function thrownResolution(cause: unknown): ScheduledResolution {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    failure: {
      code: "evaluator_error",
      message: `The execution of the check threw: ${message === "" ? "no message" : message}`,
    },
  };
}

/**
 * Computes the bounded backoff delay before the next attempt of one check.
 *
 * The first retry waits one base delay and every later retry doubles it.
 * The attempt limit of the contract bounds the doubling, and the total
 * deadline bounds the wait: one delay that reaches past the deadline
 * instant never starts an attempt, because the deadline wake-up ends the
 * run first. The delay states no jitter, because the wrapper holds no
 * random source and one deterministic delay keeps one run replayable.
 */
function backoffDelayMs(backoffMs: number, attemptsStarted: number): number {
  const doubling = Math.min(attemptsStarted - 1, 16);
  return backoffMs * 2 ** doubling;
}

/**
 * Checks one caller option against the shape of one AbortSignal: one
 * boolean `aborted` state and the two listener operations. The structural
 * check admits one signal of another environment, because the scheduler
 * reads no constructor identity.
 */
function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const signal = value as Partial<AbortSignal>;
  return (
    typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function"
  );
}

/**
 * Checks the effective execution configuration against the contract bounds
 * of the profile schema.
 *
 * # Errors
 *
 * Returns one {@link ValidationError} with `invalid_field_type` when one
 * limit breaks its bound. One bound failure rejects before any work starts,
 * because one limit of zero could admit no work and end no run.
 */
function validateExecution(execution: ExecutionConfig): void {
  const integer = (value: unknown): boolean => Number.isInteger(value);
  if (!integer(execution.max_active) || execution.max_active < 1) {
    throw new ValidationError(
      "invalid_field_type",
      "The active-work limit must hold one integer of at least 1.",
      "/execution/max_active",
    );
  }
  if (!integer(execution.max_pending) || execution.max_pending < 0) {
    throw new ValidationError(
      "invalid_field_type",
      "The pending-work limit must hold one integer of at least 0.",
      "/execution/max_pending",
    );
  }
  if (!integer(execution.deadline_ms) || execution.deadline_ms < 1) {
    throw new ValidationError(
      "invalid_field_type",
      "The total deadline must hold one integer of at least 1 millisecond.",
      "/execution/deadline_ms",
    );
  }
  if (!integer(execution.max_attempts) || execution.max_attempts < 1 || execution.max_attempts > 10) {
    throw new ValidationError(
      "invalid_field_type",
      "The attempt limit must hold one integer from 1 to 10.",
      "/execution/max_attempts",
    );
  }
  if (!integer(execution.backoff_ms) || execution.backoff_ms < 0) {
    throw new ValidationError(
      "invalid_field_type",
      "The backoff delay must hold one integer of at least 0 milliseconds.",
      "/execution/backoff_ms",
    );
  }
}

/** Formats one terminal time from the injected clock, in RFC 3339 UTC. Mirrors the twin in `run.ts`. */
function terminalTime(now: () => number): string {
  const value = now();
  try {
    return new Date(value).toISOString();
  } catch {
    throw new Error(`measuretwice received one invalid clock value: ${value}`);
  }
}

/** Freezes one JSON value deeply. Mirrors the twins in the sibling modules. */
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
