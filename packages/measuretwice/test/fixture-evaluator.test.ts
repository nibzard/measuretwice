// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "vitest";
import Type from "typebox";
import {
  createExplorationProfile, createFixtureEvaluator, defineChecks, load, registerEvaluators,
  type EvaluatorExecution,
} from "../src/index.js";

const checks = defineChecks({
  version: 1, name: "fixture-replay",
  inputs: Type.Object({ text: Type.String(), context: Type.String() }, { additionalProperties: false }),
  checks: [{ id: "supported", name: "The text is supported", using: ["text", "context"],
    question: "Does the context support the text?",
    answers: { supported: "Supported", rejected: "Rejected", unknown: "Unknown" },
    accept: "supported", review: "unknown" }],
});
const answer = (label: string): EvaluatorExecution => ({ assessment: {
  kind: "categorical", label,
  distribution: ["supported", "rejected", "unknown"].map(name => ({ name, mass: name === label ? 0.9 : 0.05 })),
} });

async function reviewerFor(evaluator: ReturnType<typeof createFixtureEvaluator>) {
  const evaluators = registerEvaluators(evaluator);
  return load(checks, { profile: createExplorationProfile(checks, evaluators, { execution: { max_attempts: 1 } }), evaluators });
}

test("fixtures replay by check and projected inputs across reordered, repeated, and concurrent runs", async () => {
  const evaluator = createFixtureEvaluator({ fixtures: [
    { check: "supported", inputs: { text: "Good", context: "Source" }, answer: answer("supported") },
    { check: "supported", inputs: { text: "Bad", context: "Source" }, answer: answer("rejected") },
  ] });
  const reviewer = await reviewerFor(evaluator);
  const reports = await Promise.all(["Bad", "Good", "Bad"].map((text, index) => reviewer.run({
    id: `case-${index}`, input: { context: "Source", text },
  })));
  expect(reports.map(report => report.aggregate.outcome)).toEqual(["fail", "pass", "fail"]);
  expect(evaluator.calls).toHaveLength(3);
  expect(evaluator.calls.every(request => !Object.hasOwn(request, "id"))).toBe(true);
});

test("unknown fixture inputs fail explicitly without exposing source text", async () => {
  const evaluator = createFixtureEvaluator({ fixtures: [] });
  const reviewer = await reviewerFor(evaluator);
  const report = await reviewer.run({ id: "unknown", input: { text: "Private candidate", context: "Private source" } });
  expect(report.aggregate.outcome).toBe("error");
  expect(report.checks[0]?.outcome).toBe("error");
  expect(JSON.stringify(report)).toContain("No fixture matches check supported");
  expect(JSON.stringify(report)).not.toContain("Private");
});

test("fixture entries are snapshots and repeated answers do not share mutable data", async () => {
  const fixture = { check: "supported", inputs: { text: "Good", context: "Source" }, answer: answer("supported") };
  const evaluator = createFixtureEvaluator({ fixtures: [fixture] });
  fixture.inputs.text = "Changed";
  fixture.answer = answer("rejected");
  const reviewer = await reviewerFor(evaluator);
  const report = await reviewer.run({ id: "original", input: { text: "Good", context: "Source" } });
  expect(report.aggregate.outcome).toBe("pass");
  const request = { ...evaluator.calls[0]!, signal: new AbortController().signal };
  const first = await evaluator.assess(request);
  if ("assessment" in first && first.assessment.kind === "categorical") {
    (first.assessment as { label: string }).label = "rejected";
  }
  expect(await evaluator.assess(request)).toEqual(answer("supported"));
});

test("duplicate fixtures and nonportable inputs are rejected at construction", () => {
  const fixture = { check: "supported", inputs: { text: "Good", context: "Source" }, answer: answer("supported") };
  expect(() => createFixtureEvaluator({ fixtures: [fixture, { ...fixture, inputs: { context: "Source", text: "Good" } }] }))
    .toThrow(/Duplicate fixture/);
  expect(() => createFixtureEvaluator({ fixtures: [{ ...fixture, inputs: { text: Number.NaN } }] }))
    .toThrow(/JSON/);
});

test("an aborted request returns timeout before fixture lookup", async () => {
  const evaluator = createFixtureEvaluator({ fixtures: [
    { check: "supported", inputs: { text: "Good", context: "Source" }, answer: answer("supported") },
  ] });
  const reviewer = await reviewerFor(evaluator);
  await reviewer.run({ id: "original", input: { text: "Good", context: "Source" } });
  const signal = AbortSignal.abort();
  const result = await evaluator.assess({ ...evaluator.calls[0]!, inputs: {}, signal });
  expect(result).toMatchObject({ failure: { code: "evaluator_timeout" } });
});

test("fixture validation rejects accessors without calling them", () => {
  let reads = 0;
  const inputs = { get text() { reads += 1; return "Private"; } };
  expect(() => createFixtureEvaluator({ fixtures: [{ check: "supported", inputs, answer: answer("supported") }] }))
    .toThrow(/accessors/);
  expect(reads).toBe(0);
});

test("fixture limits and unsupported JSON values fail before execution", () => {
  const fixture = { check: "supported", inputs: { text: "Good" }, answer: answer("supported") };
  expect(() => createFixtureEvaluator({ fixtures: Array(10_001).fill(fixture) })).toThrow(/10,000/);
  let nested: Record<string, unknown> = {};
  for (let index = 0; index < 65; index += 1) nested = { nested };
  const invalid = [new Date(), { text: undefined }, nested];
  for (const inputs of invalid) {
    expect(() => createFixtureEvaluator({ fixtures: [{ ...fixture, inputs } as never] })).toThrow(/JSON/);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => createFixtureEvaluator({ fixtures: [{ ...fixture, inputs: cyclic } as never] })).toThrow(/JSON/);
});
