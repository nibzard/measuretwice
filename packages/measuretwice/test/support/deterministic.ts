// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic test support for the measuretwice package tests.
 *
 * These helpers mirror the Rust `measuretwice_core::testing` module. The
 * SplitMix64 stream is bit-identical in both languages, so both test suites
 * assert the same golden values. Product code never imports this file.
 */

/**
 * A manual clock. It moves only when the test advances it.
 *
 * The clock also holds one queue of armed wake-ups, so one component that
 * sleeps until one instant, such as the scheduler deadline, runs under
 * full clock control. One wake-up fires when the clock reaches its
 * instant. Advancing past several instants fires them in instant order.
 */
export class FakeClock {
  #nowMs: number;
  #wakeUps: Array<{ readonly atMs: number; onWake: () => void; armed: boolean }> = [];

  constructor(startMs: number) {
    this.#nowMs = startMs;
  }

  /** Returns the current time in milliseconds. */
  nowMs(): number {
    return this.#nowMs;
  }

  /**
   * Arms one wake-up at one epoch-millisecond instant.
   *
   * The wake-up fires when the clock reaches the instant. The returned
   * operation cancels the wake-up. One cancelled wake-up never fires.
   */
  setTimer(atMs: number, onWake: () => void): () => void {
    const entry = { atMs, onWake, armed: true };
    this.#wakeUps.push(entry);
    return () => {
      entry.armed = false;
    };
  }

  /** Moves the clock forward by `ms` milliseconds, then fires the due wake-ups. */
  advanceMs(ms: number): void {
    this.#nowMs += ms;
    const due = this.#wakeUps
      .filter((entry) => entry.armed && entry.atMs <= this.#nowMs)
      .sort((first, second) => first.atMs - second.atMs);
    for (const entry of due) {
      if (!entry.armed) {
        // One earlier callback cancelled this wake-up.
        continue;
      }
      entry.armed = false;
      this.#wakeUps.splice(this.#wakeUps.indexOf(entry), 1);
      entry.onWake();
    }
  }
}

/**
 * Creates a sequential identifier generator with the given prefix.
 *
 * Identifiers match the contract identifier rule: lowercase letters, digits,
 * and hyphens. The counter starts at 1 and is zero-padded to six digits.
 *
 * @throws When the prefix is empty or holds other characters.
 */
export function sequenceIds(prefix: string): () => string {
  if (!/^[a-z0-9-]+$/.test(prefix)) {
    throw new Error(
      `identifier prefix ${JSON.stringify(prefix)} holds characters outside lowercase letters, digits, and hyphens`,
    );
  }
  let next = 1;
  return () => `${prefix}-${String(next++).padStart(6, "0")}`;
}

const MASK64 = (1n << 64n) - 1n;
const GAMMA = 0x9e3779b97f4a7c15n;

/**
 * A SplitMix64 generator for tests. Equal seeds give equal streams.
 *
 * This is a test tool, not a cryptographic source. The implementation
 * matches `measuretwice_core::testing::SplitMix64` exactly.
 */
export class SplitMix64 {
  #state: bigint;

  constructor(seed: bigint | number) {
    this.#state = BigInt.asUintN(64, BigInt(seed));
  }

  /** Returns the next value of the stream. */
  nextU64(): bigint {
    this.#state = BigInt.asUintN(64, this.#state + GAMMA);
    let z = this.#state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return BigInt.asUintN(64, z ^ (z >> 31n));
  }

  /** Returns the next value as a fraction in `[0, 1)` with 53 bits. */
  nextFloat(): number {
    return Number(this.nextU64() >> 11n) / 2 ** 53;
  }

  /**
   * Returns the next value below `bound`, without modulo bias.
   *
   * @throws When `bound` is not a whole number of at least 1.
   */
  below(bound: number): number {
    if (!Number.isInteger(bound) || bound < 1) {
      throw new Error("below needs a whole bound of at least 1");
    }
    const bigBound = BigInt(bound);
    const threshold = ((1n << 64n) - bigBound) % bigBound;
    for (;;) {
      const value = this.nextU64();
      if (value >= threshold) {
        return Number(value % bigBound);
      }
    }
  }

  /** Shuffles `items` in place with an unbiased Fisher-Yates pass. */
  shuffle<T>(items: T[]): void {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const swap = this.below(index + 1);
      const held = items[index] as T;
      items[index] = items[swap] as T;
      items[swap] = held;
    }
  }
}

/** One scripted answer: a value to return, or an error to raise. */
export type ScriptedStep<T> = T | Error;

/** Options for a scripted boundary. */
export interface ScriptedBoundaryOptions {
  /** Delay before each answer. Defaults to no delay. */
  delayMs?: number;
  /** Sleep function for the delay. Tests inject a fake to stay offline. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A fake external boundary for tests, such as an evaluator call.
 *
 * The boundary records every request and answers with the scripted steps in
 * order. It never contacts a real service. When the script runs out, it
 * fails with an explicit error instead of inventing an answer.
 */
export class ScriptedBoundary<TRequest, TResponse> {
  /** Every request seen so far, in call order. */
  readonly calls: TRequest[] = [];
  #steps: ScriptedStep<TResponse>[];
  #delayMs: number;
  #sleep: (ms: number) => Promise<void>;

  constructor(steps: ScriptedStep<TResponse>[], options: ScriptedBoundaryOptions = {}) {
    this.#steps = [...steps];
    this.#delayMs = options.delayMs ?? 0;
    this.#sleep = options.sleep ?? (() => Promise.resolve());
  }

  /** Returns the number of scripted steps not used yet. */
  remaining(): number {
    return this.#steps.length;
  }

  /** Sends one request to the scripted boundary. */
  async call(request: TRequest): Promise<TResponse> {
    this.calls.push(request);
    const step = this.#steps.shift();
    if (step === undefined) {
      throw new Error(
        `scripted boundary ran out of answers after ${this.calls.length} calls`,
      );
    }
    if (this.#delayMs > 0) {
      await this.#sleep(this.#delayMs);
    }
    if (step instanceof Error) {
      throw step;
    }
    return step;
  }
}
