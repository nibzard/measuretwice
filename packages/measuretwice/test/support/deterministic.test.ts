// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "vitest";
import {
  FakeClock,
  ScriptedBoundary,
  SplitMix64,
  sequenceIds,
} from "./deterministic.js";

test("a fake clock moves only when advanced", () => {
  const clock = new FakeClock(1_000);
  expect(clock.nowMs()).toBe(1_000);
  clock.advanceMs(250);
  expect(clock.nowMs()).toBe(1_250);
  clock.advanceMs(0);
  expect(clock.nowMs()).toBe(1_250);
});

test("equal fake clocks report equal times", () => {
  const first = new FakeClock(5);
  const second = new FakeClock(5);
  first.advanceMs(7);
  second.advanceMs(7);
  expect(first.nowMs()).toBe(second.nowMs());
});

test("a fake clock fires due wake-ups in instant order", () => {
  const clock = new FakeClock(1_000);
  const fired: string[] = [];
  clock.setTimer(1_050, () => fired.push("late"));
  clock.setTimer(1_020, () => fired.push("early"));

  clock.advanceMs(10);
  expect(fired).toEqual([]);
  clock.advanceMs(50);
  expect(fired).toEqual(["early", "late"]);
});

test("a cancelled fake-clock wake-up never fires", () => {
  const clock = new FakeClock(0);
  const fired: string[] = [];
  const cancel = clock.setTimer(5, () => fired.push("first"));
  clock.setTimer(5, () => fired.push("second"));

  cancel();
  clock.advanceMs(10);
  expect(fired).toEqual(["second"]);
});

test("sequence identifiers are ordered, unique, and kebab case", () => {
  const nextId = sequenceIds("case");
  expect(nextId()).toBe("case-000001");
  expect(nextId()).toBe("case-000002");
  expect(nextId()).toMatch(/^[a-z0-9-]+$/);
});

test("sequence identifiers reject invalid prefixes", () => {
  for (const prefix of ["", "Case", "case_id", "case id"]) {
    expect(() => sequenceIds(prefix)).toThrow(/prefix/);
  }
});

test("SplitMix64 matches the golden values shared with the Rust tests", () => {
  const seedZero = new SplitMix64(0n);
  expect(seedZero.nextU64()).toBe(0xe220a8397b1dcdafn);
  expect(seedZero.nextU64()).toBe(0x6e789e6aa1b965f4n);
  expect(seedZero.nextU64()).toBe(0x06c45d188009454fn);

  const seed42 = new SplitMix64(42n);
  expect(seed42.nextU64()).toBe(0xbdd732262feb6e95n);
  expect(seed42.nextU64()).toBe(0x28efe333b266f103n);
  expect(seed42.nextU64()).toBe(0x47526757130f9f52n);

  const seedDeadbeef = new SplitMix64(0xdeadbeefn);
  expect(seedDeadbeef.nextU64()).toBe(0x4adfb90f68c9eb9bn);
  expect(seedDeadbeef.nextU64()).toBe(0xde586a3141a10922n);
  expect(seedDeadbeef.nextU64()).toBe(0x021fbc2f8e1cfc1dn);
});

test("SplitMix64 streams follow the seed", () => {
  const first = new SplitMix64(7n);
  const second = new SplitMix64(7n);
  const other = new SplitMix64(8n);
  for (let index = 0; index < 8; index += 1) {
    const value = first.nextU64();
    expect(value).toBe(second.nextU64());
    expect(value).not.toBe(other.nextU64());
  }
});

test("SplitMix64 floats stay in range", () => {
  const random = new SplitMix64(1n);
  for (let index = 0; index < 1_000; index += 1) {
    const value = random.nextFloat();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  }
  expect(new SplitMix64(0n).nextFloat()).toBeCloseTo(0.8833108082136426, 15);
});

test("below stays inside the bound", () => {
  const random = new SplitMix64(99n);
  for (const bound of [1, 2, 7, 100, 1_000]) {
    for (let index = 0; index < 200; index += 1) {
      expect(random.below(bound)).toBeLessThan(bound);
    }
  }
  expect(() => random.below(0)).toThrow();
});

test("shuffle is deterministic and keeps every item", () => {
  const first = Array.from({ length: 64 }, (_unused, index) => index);
  const second = [...first];
  const third = [...first];

  new SplitMix64(5n).shuffle(first);
  new SplitMix64(5n).shuffle(second);
  new SplitMix64(6n).shuffle(third);

  expect(first).toEqual(second);
  expect(first).not.toEqual(third);
  expect([...first].sort((a, b) => a - b)).toEqual(third.sort((a, b) => a - b));
});

test("a scripted boundary answers in order and records requests", async () => {
  const boundary = new ScriptedBoundary<string, number>([41, new Error("provider down"), 43]);
  expect(await boundary.call("first")).toBe(41);
  await expect(boundary.call("second")).rejects.toThrow("provider down");
  expect(await boundary.call("third")).toBe(43);
  expect(boundary.calls).toEqual(["first", "second", "third"]);
  expect(boundary.remaining()).toBe(0);
});

test("a scripted boundary fails explicitly when the script runs out", async () => {
  const boundary = new ScriptedBoundary<string, number>([1]);
  await boundary.call("only");
  await expect(boundary.call("extra")).rejects.toThrow(/ran out of answers/);
});

test("a scripted boundary delays through the injected sleep function", async () => {
  const slept: number[] = [];
  const boundary = new ScriptedBoundary<string, number>([7, 8], {
    delayMs: 30,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  expect(await boundary.call("a")).toBe(7);
  expect(await boundary.call("b")).toBe(8);
  expect(slept).toEqual([30, 30]);
});
