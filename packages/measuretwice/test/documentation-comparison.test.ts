// SPDX-License-Identifier: Apache-2.0
import { expect, test, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";

const directory = path.resolve("examples/documentation-consistency/comparison");
const moduleAt = (name: string) => import(pathToFileURL(path.join(directory, name)).href);
const response = (label: string, supported: number, contradicted: number) => ({
  model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 2 },
  answers: { requirement: { type: "choice", choice: label,
    probabilities: { supported, contradicted, insufficient: 1 - supported - contradicted } } },
});

test.each([
  ["supported", 0.8, 0.1, "pass"],
  ["supported", 0.76, 0.1, "review"],
  ["contradicted", 0.1, 0.6, "fail"],
  ["insufficient", 0.9, 0.05, "review"],
])("the direct policy preserves the measurement for %s", async (label, accepted, rejected, outcome) => {
  const { assessResponse } = await moduleAt("direct.mjs");
  expect(assessResponse(response(String(label), Number(accepted), Number(rejected))).outcome).toBe(outcome);
});

test.each(["missing-usage", "invalid-mass", "wrong-model"])("the direct path refuses %s without inventing an outcome", async defect => {
  const { runDirect } = await moduleAt("direct.mjs");
  const raw: Record<string, any> = response("supported", 0.9, 0.05);
  if (defect === "missing-usage") delete raw.usage;
  if (defect === "invalid-mass") raw.answers.requirement.probabilities.supported = 2;
  if (defect === "wrong-model") raw.model = "other-model";
  const result = await runDirect({ id: "test", input: { evidence: "Source", candidate: "Claim" } }, async () => raw);
  expect(result.outcome).toBe("error");
  expect(result.reason.code).toBe(defect === "wrong-model" ? "model_resolution_changed" : "invalid_assessment");
});

test("both integrations send the same evidence and question in separate calls", async () => {
  const { runPair } = await moduleAt("run.mjs");
  const requests: unknown[] = [];
  const call = async (request: unknown) => { requests.push(request); return response("supported", 0.76, 0.1); };
  const result = await runPair([{ id: "test", input: { evidence: "Source", candidate: "Claim" } }], call);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(JSON.stringify(requests)).not.toContain("reference");
  expect(result.rows[0]).toMatchObject({ direct: "review", measuretwice: "review" });
  expect(result.direct[0].assessment).toEqual(result.reports[0].checks[0].assessment);
  expect(result.profile.qualification.status).toBe("unvalidated");
});

test("both integrations accept the contract's mass-sum tolerance", async () => {
  const { runPair } = await moduleAt("run.mjs");
  const raw = response("supported", 0.9, 0.05);
  raw.answers.requirement.probabilities.insufficient += 0.0000005;
  const result = await runPair([{ id: "test", input: { evidence: "Source", candidate: "Claim" } }], async () => raw);
  expect(result.rows[0]).toMatchObject({ direct: "pass", measuretwice: "pass" });
});

test("the direct deadline records an error and ignores a late provider result", async () => {
  const { runDirect } = await moduleAt("direct.mjs");
  vi.useFakeTimers();
  try {
    let resolve: (value: unknown) => void = () => {};
    const late = new Promise(done => { resolve = done; });
    const pending = runDirect({ id: "test", input: { evidence: "Source", candidate: "Claim" } }, () => late, { deadlineMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    const result = await pending;
    expect(result).toMatchObject({ outcome: "error", reason: { code: "evaluator_timeout" } });
    resolve(response("supported", 0.9, 0.05));
    await late;
    expect(result.outcome).toBe("error");
  } finally { vi.useRealTimers(); }
});

test("provider failures retain safe causes and do not retry", async () => {
  const { runDirect } = await moduleAt("direct.mjs");
  let calls = 0;
  const result = await runDirect({ id: "test", input: { evidence: "Source", candidate: "Claim" } }, async () => {
    calls += 1; throw Object.assign(new Error("Private source and credential"), { status: 401 });
  });
  expect(calls).toBe(1);
  expect(result).toMatchObject({ outcome: "error", reason: { code: "evaluator_authentication", remediation: "fix_credentials" } });
  expect(JSON.stringify(result)).not.toContain("Private");
});

test("preparation uses current sources and hides proposed references from the review sheet", async () => {
  const { prepare } = await moduleAt("prepare.mjs");
  const prepared = await prepare();
  expect(prepared.cases).toHaveLength(6);
  expect(prepared.sources.every((source: { sha256: string }) => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
  expect(prepared.review).not.toContain("Proposed answer:");
  expect(prepared.review).not.toContain("Raw label:");
  expect(prepared.references.every((reference: { label: { author_type: string; reviewed: boolean } }) =>
    reference.label.author_type === "model" && reference.label.reviewed === false)).toBe(true);
});
