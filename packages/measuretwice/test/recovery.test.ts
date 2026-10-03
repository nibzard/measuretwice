// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";
import Type from "typebox";
import { createExplorationProfile, createJevEvaluator, defineChecks, load, mapJevError, registerEvaluators } from "../src/index.js";

const definition = defineChecks({ version: 1, name: "recovery",
  inputs: Type.Object({ evidence: Type.String() }, { additionalProperties: false }),
  checks: [{ id: "supported", name: "Supported", using: ["evidence"], question: "Is it supported?",
    answers: { yes: "Supported", no: "Unsupported" }, accept: "yes" }] });

function providerError(status: number): Error {
  return Object.assign(new Error("Private evidence and credentials"), { name: "APIError", status });
}

test.each([[401, "evaluator_authentication"], [403, "evaluator_permission"], [400, "evaluator_request"],
  [429, "evaluator_rate_limit"], [500, "evaluator_error"]])("provider status %s keeps a stable cause", (status, code) => {
  const failure = mapJevError(providerError(status as number));
  expect(failure.code).toBe(code);
  expect(failure.message).not.toContain("Private");
});

test.each([[401, "evaluator_authentication", "fix_credentials"], [403, "evaluator_permission", "fix_permissions"],
  [400, "evaluator_request", "fix_request"]])("permanent status %s stops after one attempt", async (status, code, remediation) => {
  let calls = 0;
  const evaluators = registerEvaluators(createJevEvaluator({ call: async () => { calls += 1; throw providerError(status as number); } }));
  const profile = createExplorationProfile(definition, evaluators, { execution: { max_attempts: 3 } });
  const reviewer = await load(definition, { profile, evaluators });
  const report = await reviewer.run({ id: "case-1", input: { evidence: "Source" } });
  expect(calls).toBe(1);
  expect(report.checks[0]).toMatchObject({ outcome: "error", attempts: 1,
    reason: { code, recovery: { cause_code: code, retryable: false, remediation } } });
});

test("oversized evidence stops locally and names the repair", async () => {
  let calls = 0;
  const evaluators = registerEvaluators(createJevEvaluator({ call: async () => { calls += 1; return {}; } }));
  const profile = createExplorationProfile(definition, evaluators, { execution: { max_attempts: 3 } });
  const reviewer = await load(definition, { profile, evaluators });
  const report = await reviewer.run({ id: "case-1", input: { evidence: "x".repeat(33000) } });
  expect(calls).toBe(0);
  expect(report.checks[0]).toMatchObject({ outcome: "error", attempts: 1,
    reason: { code: "oversized_input", recovery: { cause_code: "oversized_input", retryable: false, remediation: "reduce_evidence" } } });
});

test("exhausted retries preserve a structured transient cause", async () => {
  let calls = 0;
  const evaluators = registerEvaluators(createJevEvaluator({ call: async () => { calls += 1; throw providerError(429); } }));
  const profile = createExplorationProfile(definition, evaluators, { execution: { max_attempts: 2, backoff_ms: 0 } });
  const reviewer = await load(definition, { profile, evaluators });
  const report = await reviewer.run({ id: "case-1", input: { evidence: "Source" } });
  expect(calls).toBe(2);
  expect(report.checks[0]).toMatchObject({ outcome: "error", attempts: 2,
    reason: { code: "retries_exhausted", recovery: { cause_code: "evaluator_rate_limit", retryable: true, remediation: "retry_later" } } });
});
