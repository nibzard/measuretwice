// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";
import {
  createExplorationProfile,
  load,
  registerEvaluators,
  type Definition,
  type EvaluatorRequest,
} from "../src/index.js";
import { nativeContentHash, nativeValidateCase } from "../src/native.js";

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


test.each([2 ** 63, -(2 ** 63), Number(1000000000000000128n), 1e21, Number.MAX_VALUE])(
  "public Number input agrees with raw JSON validation: %s", async (count) => {
    const exact = BigInt(count).toString();
    const core = nativeValidateCase(JSON.stringify(definition), `{"id":"case-1","input":{"count":${exact}}}`);
    const seen: unknown[] = [];
    const evaluators = registerEvaluators({
      id: "numeric-test",
      adapter_version: "1",
      async assess(request) {
        seen.push(request.inputs.count);
        return { assessment: { kind: "binary", value: true } };
      },
    });
    const reviewer = await load(definition, {
      evaluators, profile: createExplorationProfile(definition, evaluators),
    });
    const report = await reviewer.run({ id: "case-1", input: { count } });
    expect(seen).toEqual([count]);
    expect(report.case.input_hash).toBe(core.inputHash);
    expect(report.aggregate.outcome).toBe("pass");
  },
);

test("registration captures methods and preserves their host receiver", async () => {
  let original = 0;
  let replacement = 0;
  const host = {
    id: "identity-test", adapter_version: "1.0.0", answer: false,
    async assess(_request: EvaluatorRequest) {
      original += 1;
      return { assessment: { kind: "binary" as const, value: this.answer } };
    },
  };
  const evaluators = registerEvaluators(host);
  const reviewer = await load(definition, {
    evaluators, profile: createExplorationProfile(definition, evaluators),
  });
  host.assess = async () => {
    replacement += 1;
    return { assessment: { kind: "binary", value: true } };
  };
  const report = await reviewer.run({ id: "case-1", input: { count: 2 } });
  expect(report.aggregate.outcome).toBe("fail");
  expect(original).toBe(1);
  expect(replacement).toBe(0);
  host.adapter_version = "2.0.0";
  await expect(reviewer.run({ id: "case-2", input: { count: 2 } }))
    .rejects.toMatchObject({ code: "evaluator_mismatch", fieldPath: "/evaluators/0/adapter_version" });
  expect(original).toBe(1);
  expect(replacement).toBe(0);
});


test("registration captures the translation method", async () => {
  let original = 0;
  let replacement = 0;
  const host = {
    id: "translation-test", adapter_version: "1",
    translate(question: unknown) {
      original += 1;
      return { question, content_hash: nativeContentHash("translation", JSON.stringify(question)) };
    },
    async assess() { return { assessment: { kind: "binary" as const, value: true } }; },
  };
  const evaluators = registerEvaluators(host);
  const profile = createExplorationProfile(definition, evaluators);
  const reviewer = await load(definition, { evaluators, profile });
  host.translate = () => { replacement += 1; throw new Error("Replacement must not run."); };
  const report = await reviewer.run({ id: "case-1", input: { count: 2 } });
  expect(report.aggregate.outcome).toBe("pass");
  expect(original).toBeGreaterThan(0);
  expect(replacement).toBe(0);
});

test.each(["id", "preprocessing", "requested", "resolved"])(
  "registration rejects changed declarations: %s", async (field) => {
    let calls = 0;
    const host = {
      id: "declaration-test", adapter_version: "1", preprocessing: "plain-v1",
      model: { requested: "model-1", resolved: "model-1" },
      async assess() {
        calls += 1;
        return { assessment: { kind: "binary" as const, value: true }, model_resolved: "model-1" };
      },
    };
    const evaluators = registerEvaluators(host);
    const registered = evaluators.get(host.id)!;
    const reviewer = await load(definition, { evaluators, profile: createExplorationProfile(definition, evaluators) });
    if (field === "id") host.id = "changed-test";
    else if (field === "preprocessing") host.preprocessing = "plain-v2";
    else if (field === "requested") host.model.requested = "model-2";
    else host.model.resolved = "model-2";
    const code = field === "requested" || field === "resolved" ? "model_resolution_changed" : "evaluator_mismatch";
    await expect(reviewer.run({ id: "case-1", input: { count: 2 } })).rejects.toMatchObject({ code });
    expect(() => registered.assess({} as never)).toThrow(expect.objectContaining({ code }));
    expect(calls).toBe(0);
  },
);
