// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";
import {
  createExplorationProfile,
  load,
  registerEvaluators,
  type Definition,
} from "../src/index.js";
import { nativeValidateCase } from "../src/native.js";

const definition: Definition = {
  schema_version: 1,
  name: "numeric-boundary",
  inputs: {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
    additionalProperties: false,
  },
  checks: [{
    id: "even-count",
    name: "The count is even",
    using: ["count"],
    question: "Is the count even?",
    answers: { yes: "Even.", no: "Odd." },
    accept: "yes",
  }],
};

test("case integers that hashing cannot preserve fail before projection", () => {
  for (const type of ["integer", "number"]) {
    const artifact = {
      ...definition,
      inputs: { ...definition.inputs, properties: { count: { type } } },
    };
    for (const count of ["9007199254740993", "-9007199254740993", "18446744073709551615", "-9223372036854775807"]) {
      expect(() => nativeValidateCase(
        JSON.stringify(artifact),
        `{"id":"case-1","input":{"count":${count}}}`,
      ), count).toThrow(expect.objectContaining({
        code: "invalid_field_type",
        fieldPath: "/input/count",
      }));
    }
    for (const count of ["9007199254740992", "-9007199254740992", "9223372036854775808"]) {
      expect(() => nativeValidateCase(
        JSON.stringify(artifact),
        `{"id":"case-1","input":{"count":${count}}}`,
      ), count).not.toThrow();
    }
  }
});

test("BigInt case values fail before evaluator execution", async () => {
  let calls = 0;
  const evaluators = registerEvaluators({
    id: "regression-test",
    adapter_version: "1",
    async assess() {
      calls += 1;
      return { assessment: { kind: "binary", value: true } };
    },
  });
  const reviewer = await load(definition, {
    evaluators,
    profile: createExplorationProfile(definition, evaluators),
  });
  await expect(reviewer.run({ id: "case-1", input: { count: 9007199254740993n } } as never))
    .rejects.toMatchObject({ code: "nonportable_value", fieldPath: "/input/count" });
  expect(calls).toBe(0);
});

test.each([
  [{ assessment: { kind: "binary", value: true, extra: undefined } }, "invalid_assessment"],
  [{ assessment: { kind: "binary", value: true, extra: Number.NaN } }, "invalid_assessment"],
  [{ assessment: { kind: "binary", value: "wrong" } }, "invalid_assessment"],
  [{ assessment: [] }, "evaluator_error"],
  [{}, "evaluator_error"],
  [{ failure: { code: "wrong", message: "Invalid code." } }, "evaluator_error"],
  [{ assessment: { kind: "binary", value: true }, failure: { code: "evaluator_error", message: "Conflicting result." } }, "evaluator_error"],
])("malformed answers retain valid execution measurements: %j", async (answer, code) => {
  const evaluators = registerEvaluators({
    id: "regression-test",
    adapter_version: "1",
    async assess() {
      return {
        ...answer,
        usage: { input_tokens: 100 },
        model_resolved: "model-1",
        latency_ms: 5,
      } as never;
    },
  });
  const reviewer = await load(definition, {
    evaluators,
    profile: createExplorationProfile(definition, evaluators, { execution: { max_attempts: 1 } }),
  });
  const report = await reviewer.run({ id: "case-1", input: { count: 2 } });
  expect(report.checks[0]).toMatchObject({
    outcome: "error",
    reason: { code },
    usage: { input_tokens: 100 },
    evaluator: { model_resolved: "model-1" },
    timing: { execution_ms: 5 },
  });
  expect(report.totals?.usage).toEqual({ input_tokens: 100 });
});
