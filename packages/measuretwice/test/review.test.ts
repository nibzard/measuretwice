// SPDX-License-Identifier: Apache-2.0
/**
 * Review export tests.
 *
 * These tests cover task T045: the export selects the stored shadow reports
 * that need one human review, and the validation checks the labels that
 * return. One export always carries every disagreement, every report
 * without one baseline, and every report whose candidate aggregate outcome
 * is an error. The agreements enter through one reproducible seeded sample,
 * so baseline passes and silent baseline cases stay auditable and not only
 * suspicious cases reach one reviewer. The host states the meaning of its
 * own decision vocabulary, the records hold no raw case content, and the
 * returned labels are validated against the meaning of their checks without
 * treating baseline agreement as correctness. The adapter is the scripted
 * test evaluator, so the tests read local files only and stay offline and
 * deterministic.
 */
import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import Type from "typebox";
import {
  createExplorationProfile,
  createScriptedEvaluator,
  defineChecks,
  exportShadowReviews,
  load,
  registerEvaluators,
  validateReviewLabels,
  ValidationError,
  type FileAccess,
  type RunOptions,
  type RunReport,
} from "../src/index.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/**
 * One mixed definition with one categorical question and one exact rule, so
 * one script reaches pass, fail, review, and error aggregates.
 */
const mixed = defineChecks({
  version: 1,
  name: "review-intervention",
  inputs: Type.Object(
    {
      conversation: Type.String({ minLength: 1 }),
      proposed_message: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "message-supported",
      name: "Our message accurately describes the evidence",
      using: ["conversation", "proposed_message"],
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
      id: "message-length",
      name: "The message fits the delivery limit",
      using: ["proposed_message"],
      rule: { maxLength: 280 },
    },
  ],
});

/** One exact-only definition for one enforcement report. */
const enforced = defineChecks({
  version: 1,
  name: "review-delivery-limits",
  inputs: Type.Object({ summary: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  checks: [
    {
      id: "summary-length",
      name: "The summary fits the delivery limit",
      using: ["summary"],
      rule: { maxLength: 80 },
    },
  ],
});

/** The meaning map of one test host decision vocabulary. */
const MEANINGS = { send: "pass", block: "fail", flag: "review", silent: "silent" } as const;

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
};

/** One operational failure. */
const TIMEOUT = { failure: { code: "evaluator_timeout", message: "The attempt timed out." } };

/** One case input that satisfies every input constraint. */
function inputFor(caseId: string): { id: string; input: Record<string, string> } {
  return {
    id: caseId,
    input: {
      conversation: `The team discusses the case ${caseId}.`,
      proposed_message: `The message of the case ${caseId} follows the evidence.`,
    },
  };
}

/** One in-memory file access that serves the stated profile. */
function memoryFiles(profile: unknown): FileAccess {
  return {
    async read(path: string): Promise<string> {
      if (path === "/profile.json") {
        return JSON.stringify(profile);
      }
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    },
  };
}

/**
 * Binds the mixed definition to one scripted evaluator and one clock.
 *
 * The script answers one question per run, in run order. The profile
 * option varies the artifact when one test needs another profile hash.
 */
async function bind(
  steps: readonly unknown[],
  profileOptions: Parameters<typeof createExplorationProfile>[2] = {},
): Promise<
  (caseInput: { id: string; input: Record<string, string> }, options?: RunOptions) => Promise<RunReport>
> {
  const evaluator = createScriptedEvaluator({
    // One plain object is one answer execution; one control that already
    // names answer, raw, or error crosses unchanged.
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
  const clock = new FakeClock(START_MS);
  const reviewer = await load(mixed, {
    profile: "/profile.json",
    evaluators: registry,
    files: memoryFiles(profile),
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
  });
  return (caseInput, options) =>
    reviewer.run(caseInput as never, options) as Promise<RunReport>;
}

/** Runs one operation and returns the public failure it must throw. */
function failureOf(operation: () => unknown): ValidationError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("the operation was accepted");
}

/**
 * Runs one batch of shadow cases and returns the stored reports, in batch
 * order.
 *
 * The batch covers every classification: three agreements (one baseline
 * pass, one silent baseline, one review flag), three disagreements (a pass
 * baseline against one fail, one silent baseline against one fail, one fail
 * baseline against one pass), one missing baseline, one candidate error,
 * and one disagreement with one host snapshot reference.
 */
async function batch(): Promise<RunReport[]> {
  // One attempt per check keeps the one operational failure terminal, so
  // the error case records its error aggregate without one retry.
  const run = await bind(
    [
      SUPPORTED, // case-send-pass: agreement
      SUPPORTED, // case-silent-pass: agreement, silent baseline decision
      INCOMPLETE, // case-flag-review: agreement
      CONTRADICTED, // case-send-fail: disagreement
      CONTRADICTED, // case-silent-fail: disagreement, silent baseline decision
      SUPPORTED, // case-block-pass: disagreement
      SUPPORTED, // case-missing: no baseline
      TIMEOUT, // case-error: candidate error
      CONTRADICTED, // case-snap: disagreement with one snapshot
    ],
    { execution: { max_attempts: 1, backoff_ms: 0 } },
  );
  const reports: RunReport[] = [];
  const cases: readonly {
    id: string;
    options?: RunOptions;
  }[] = [
    { id: "case-send-pass", options: { baseline: { outcome: "send", revision: "policy-2026-03" } } },
    { id: "case-silent-pass", options: { baseline: { outcome: "silent", revision: "heuristic-v4" } } },
    { id: "case-flag-review", options: { baseline: { outcome: "flag", revision: "policy-2026-03" } } },
    { id: "case-send-fail", options: { baseline: { outcome: "send", revision: "policy-2026-03" } } },
    { id: "case-silent-fail", options: { baseline: { outcome: "silent", revision: "heuristic-v4" } } },
    { id: "case-block-pass", options: { baseline: { outcome: "block", revision: "policy-2026-03" } } },
    { id: "case-missing" },
    { id: "case-error", options: { baseline: { outcome: "send", revision: "policy-2026-03" } } },
    {
      id: "case-snap",
      options: {
        baseline: { outcome: "send", revision: "policy-2026-03" },
        snapshot: "snapshots/case-snap",
      },
    },
  ];
  for (const entry of cases) {
    reports.push(await run(inputFor(entry.id), entry.options));
  }
  return reports;
}

/**
 * Computes the sampling rank of one agreement, with the same byte layout
 * the Rust core hashes, so the test pins the algorithm from the outside.
 */
function rank(seed: string, caseId: string, inputHash: string): string {
  return createHash("sha256")
    .update("measuretwice-review-sample\0")
    .update(`${seed}\0${caseId}\0${inputHash}`)
    .digest("hex");
}

/** Returns the case identifiers one seeded sample of the stated size selects. */
function sampledCaseIds(
  seed: string,
  agreements: readonly { caseId: string; inputHash: string }[],
  size: number,
): string[] {
  return [...agreements]
    .map((one) => ({ key: rank(seed, one.caseId, one.inputHash), caseId: one.caseId }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : left.caseId < right.caseId ? -1 : 1))
    .slice(0, Math.min(size, agreements.length))
    .map((one) => one.caseId);
}

/** The identifiers and input hashes of the agreements of the test batch. */
async function batchAgreements(): Promise<{ caseId: string; inputHash: string }[]> {
  const reports = await batch();
  const agreements = ["case-send-pass", "case-silent-pass", "case-flag-review"];
  return reports
    .filter((report) => agreements.includes(report.case.id))
    .map((report) => ({ caseId: report.case.id, inputHash: report.case.input_hash }));
}

// ---------------------------------------------------------------------------
// The selection.
// ---------------------------------------------------------------------------

test("one export selects the always-included reports and one seeded sample of agreements", async () => {
  const reports = await batch();
  const agreements = await batchAgreements();
  const seed = "review-seed-1";
  const expectedSample = sampledCaseIds(seed, agreements, 2);

  const exported = exportShadowReviews(reports, {
    baselineMeanings: MEANINGS,
    sample: { seed, agreements: 2 },
  });

  // The records keep report order and state one selection reason each.
  const reasons = new Map(exported.records.map((record) => [record.case_id, record.selection_reason]));
  expect(reasons.get("case-send-fail")).toBe("disagreement");
  expect(reasons.get("case-silent-fail")).toBe("disagreement");
  expect(reasons.get("case-block-pass")).toBe("disagreement");
  expect(reasons.get("case-missing")).toBe("missing_baseline");
  expect(reasons.get("case-error")).toBe("candidate_error");
  expect(reasons.get("case-snap")).toBe("disagreement");
  for (const caseId of expectedSample) {
    expect(reasons.get(caseId)).toBe("sampled_agreement");
  }
  // Four disagreements, one missing baseline, one candidate error, and the
  // two sampled agreements of three.
  expect(exported.records).toHaveLength(8);

  // One record states every required fact, and the two outcomes stay two
  // separate fields.
  const disagreement = exported.records.find((record) => record.case_id === "case-send-fail");
  expect(disagreement).toBeDefined();
  expect(disagreement?.input_hash).toBe(
    reports.find((report) => report.case.id === "case-send-fail")?.case.input_hash,
  );
  expect(disagreement?.run_id).toMatch(/^run-/);
  expect(disagreement?.baseline).toEqual({
    outcome: "send",
    revision: "policy-2026-03",
    meaning: "pass",
  });
  expect(disagreement?.candidate.aggregate).toBe("fail");
  expect(disagreement?.candidate.completion).toBe("completed");
  expect(disagreement?.candidate.checks).toEqual({
    "message-supported": "fail",
    "message-length": "pass",
  });

  // The missing baseline states no baseline field, and the error record
  // keeps its terminal status beside the error aggregate.
  const missing = exported.records.find((record) => record.case_id === "case-missing");
  expect(missing?.baseline).toBeUndefined();
  const errored = exported.records.find((record) => record.case_id === "case-error");
  expect(errored?.candidate.aggregate).toBe("error");
  expect(errored?.baseline?.meaning).toBe("pass");

  // The summary counts every classification and the selected composition.
  expect(exported.summary).toMatchObject({
    reports: 9,
    agreements: 3,
    disagreements: 4,
    missing_baselines: 1,
    candidate_errors: 1,
    selected: exported.records.length,
  });
  expect(exported.summary.selected_by_reason.disagreement).toBe(4);
  expect(exported.summary.selected_by_reason.missing_baseline).toBe(1);
  expect(exported.summary.selected_by_reason.candidate_error).toBe(1);
  expect(exported.summary.selected_by_reason.sampled_agreement).toBe(expectedSample.length);

  // The provenance retains the seed, the algorithm, the sizes, the rules,
  // and the stated meanings.
  expect(exported.schema_version).toBe(1);
  expect(exported.sampling.seed).toBe(seed);
  expect(exported.sampling.algorithm).toBe("sha256_rank");
  expect(exported.sampling.agreements).toBe(3);
  expect(exported.sampling.requested).toBe(2);
  expect(exported.sampling.selected).toBe(expectedSample.length);
  expect(exported.sampling.statement).toContain("reproducible");
  expect(exported.baseline_meanings).toEqual(MEANINGS);
  for (const reason of [
    "disagreement",
    "sampled_agreement",
    "missing_baseline",
    "candidate_error",
  ] as const) {
    expect(exported.inclusion_rules[reason]).toBeTruthy();
  }
  expect(exported.definition.name).toBe("review-intervention");
  expect(exported.definition.content_hash).toBe(reports[0]?.definition.content_hash);
  expect(exported.profile.id).toBe(reports[0]?.profile.id);
  expect(exported.limitations.length).toBeGreaterThan(0);
});

test("the seeded sample is reproducible, order independent, and size monotone", async () => {
  const reports = await batch();
  const agreements = await batchAgreements();
  const options = (seed: string, size: number) => ({
    baselineMeanings: MEANINGS,
    sample: { seed, agreements: size },
  });

  // The same inputs select the same records, byte for byte.
  const first = exportShadowReviews(reports, options("review-seed-1", 2));
  const repeated = exportShadowReviews(reports, options("review-seed-1", 2));
  expect(repeated).toEqual(first);

  // The selection follows the published rank over the seed, the case
  // identifier, and the input hash, for every stated seed.
  for (const seed of ["review-seed-1", "review-seed-2", "review-seed-3"]) {
    const exported = exportShadowReviews(reports, options(seed, 2));
    const sampled = exported.records
      .filter((record) => record.selection_reason === "sampled_agreement")
      .map((record) => record.case_id);
    expect(new Set(sampled)).toEqual(new Set(sampledCaseIds(seed, agreements, 2)));
  }

  // A reordered batch selects the same set, because the rank derives from
  // the case identity alone.
  const reordered = exportShadowReviews([...reports].reverse(), options("review-seed-1", 2));
  const idsOf = (exported: typeof first) =>
    exported.records.map((record) => record.case_id).sort();
  expect(idsOf(reordered)).toEqual(idsOf(first));

  // One zero size samples no agreement, and the agreements stay counted.
  const none = exportShadowReviews(reports, options("review-seed-1", 0));
  expect(none.records.map((record) => record.selection_reason)).not.toContain("sampled_agreement");
  expect(none.summary.agreements).toBe(3);
  expect(none.summary.selected).toBe(6);

  // One size above the agreement count samples every agreement, and the
  // fixed rank order makes one larger size one superset.
  const all = exportShadowReviews(reports, options("review-seed-1", 3));
  expect(all.summary.selected).toBe(9);
  expect(all.sampling.selected).toBe(3);
  const sampledOf = (exported: typeof first) =>
    exported.records
      .filter((record) => record.selection_reason === "sampled_agreement")
      .map((record) => record.case_id);
  const large = exportShadowReviews(reports, options("review-seed-1", 100));
  expect(large.records).toHaveLength(9);
  expect(sampledOf(large)).toEqual(expect.arrayContaining(sampledOf(first)));
  expect(sampledOf(all)).toEqual(expect.arrayContaining(sampledOf(first)));
});

test("baseline passes and silent baseline cases stay auditable", async () => {
  const reports = await batch();
  // One export that samples every agreement shows the audited composition:
  // baseline passes and silent baseline cases reach the reviewer, not only
  // the suspicious cases.
  const exported = exportShadowReviews(reports, {
    baselineMeanings: MEANINGS,
    sample: { seed: "review-seed-1", agreements: 3 },
  });
  expect(exported.summary.selected_by_baseline_meaning).toEqual({
    pass: 4,
    fail: 1,
    review: 1,
    silent: 2,
  });
  // One silent baseline against one fail candidate is one disagreement, and
  // one silent baseline against one pass candidate is one sampled
  // agreement: silence reads as one absent decision, never as one wrong
  // decision.
  const silentFail = exported.records.find((record) => record.case_id === "case-silent-fail");
  expect(silentFail?.selection_reason).toBe("disagreement");
  expect(silentFail?.baseline?.meaning).toBe("silent");
  const silentPass = exported.records.find((record) => record.case_id === "case-silent-pass");
  expect(silentPass?.selection_reason).toBe("sampled_agreement");
  expect(silentPass?.baseline?.meaning).toBe("silent");
});

test("the jsonl text holds one record per line and no record states one merged outcome", async () => {
  const reports = await batch();
  const exported = exportShadowReviews(reports, {
    baselineMeanings: MEANINGS,
    sample: { seed: "review-seed-1", agreements: 2 },
  });
  expect(exported.jsonl.endsWith("\n")).toBe(true);
  const lines = exported.jsonl.split("\n").filter((line) => line !== "");
  expect(lines).toHaveLength(exported.records.length);
  for (const [index, line] of lines.entries()) {
    expect(JSON.parse(line)).toEqual(exported.records[index]);
  }

  // No record field merges the two outcomes into one claim.
  for (const record of exported.records) {
    const text = JSON.stringify(record);
    for (const forbidden of ["accuracy", "correct", "authorized", "approved"]) {
      expect(text.includes(forbidden), `${forbidden} inside one record`).toBe(false);
    }
    expect(text.includes('"agrees"'), "one record states an agreement field").toBe(false);
  }

  // One export with no selected record states one empty text.
  const agreementsOnly: RunReport[] = reports.slice(0, 3);
  const empty = exportShadowReviews(agreementsOnly, {
    baselineMeanings: MEANINGS,
    sample: { seed: "review-seed-1", agreements: 0 },
  });
  expect(empty.records).toHaveLength(0);
  expect(empty.jsonl).toBe("");
});

test("the export holds no raw case content and carries the host snapshot alone", async () => {
  const reports = await batch();
  const exported = exportShadowReviews(reports, {
    baselineMeanings: MEANINGS,
    sample: { seed: "review-seed-1", agreements: 2 },
  });
  const snap = exported.records.find((record) => record.case_id === "case-snap");
  expect(snap?.snapshot).toBe("snapshots/case-snap");
  const without = exported.records.filter((record) => record.case_id !== "case-snap");
  for (const record of without) {
    expect("snapshot" in record).toBe(false);
  }
  // The complete export states no case body, so replay needs the explicit
  // host-supplied snapshot and the storage of the host.
  const text = JSON.stringify(exported);
  for (const caseId of ["case-send-pass", "case-error"]) {
    expect(text.includes(`The team discusses the case ${caseId}.`)).toBe(false);
  }
  expect(text.includes("proposed_message")).toBe(false);

  // The export changes no stored report: the input stays as it was.
  const before = JSON.stringify(reports);
  exportShadowReviews(reports, {
    baselineMeanings: MEANINGS,
    sample: { seed: "review-seed-1", agreements: 2 },
  });
  expect(JSON.stringify(reports)).toBe(before);
});

// ---------------------------------------------------------------------------
// Boundary refusals.
// ---------------------------------------------------------------------------

test("broken batches and options refuse before any selection", async () => {
  const reports = await batch();

  // One absent option refuses with its field.
  expect(failureOf(() => exportShadowReviews(reports, {} as never)).fieldPath).toBe(
    "/baselineMeanings",
  );
  expect(
    failureOf(() => exportShadowReviews(reports, { baselineMeanings: MEANINGS } as never))
      .fieldPath,
  ).toBe("/sample");

  // One empty meaning map states no vocabulary.
  const emptyMeanings = failureOf(() =>
    exportShadowReviews(reports, { baselineMeanings: {}, sample: { seed: "s", agreements: 1 } }),
  );
  expect(emptyMeanings.code).toBe("invalid_field_type");
  expect(emptyMeanings.fieldPath).toBe("/baselineMeanings");

  // The seed and the sample size keep their bounds.
  for (const seed of ["", "s".repeat(129)]) {
    const failure = failureOf(() =>
      exportShadowReviews(reports, {
        baselineMeanings: MEANINGS,
        sample: { seed, agreements: 1 },
      }),
    );
    expect(failure.code).toBe("invalid_field_type");
    expect(failure.fieldPath).toBe("/sample/seed");
  }
  for (const size of [-1, 1.5, 100001]) {
    const failure = failureOf(() =>
      exportShadowReviews(reports, {
        baselineMeanings: MEANINGS,
        sample: { seed: "s", agreements: size },
      }),
    );
    expect(failure.fieldPath).toBe("/sample/agreements");
  }

  // One batch with no report reviews nothing.
  const noReports = failureOf(() =>
    exportShadowReviews([], { baselineMeanings: MEANINGS, sample: { seed: "s", agreements: 1 } }),
  );
  expect(noReports.code).toBe("insufficient_evidence");
  expect(noReports.fieldPath).toBe("/reports");

  // One unmapped baseline word names no stated meaning. The second report
  // of the batch recorded the word `silent`.
  const unmapped = failureOf(() =>
    exportShadowReviews(reports.slice(0, 2), {
      baselineMeanings: { send: "pass" },
      sample: { seed: "s", agreements: 1 },
    }),
  );
  expect(unmapped.code).toBe("unknown_field");
  expect(unmapped.fieldPath).toBe("/reports/1/baseline/outcome");
  expect(unmapped.message).toContain("silent");

  // One repeated case identifier is one ambiguous review target.
  const firstReport = reports[0] as RunReport;
  const repeated = failureOf(() =>
    exportShadowReviews([firstReport, firstReport], {
      baselineMeanings: MEANINGS,
      sample: { seed: "s", agreements: 1 },
    }),
  );
  expect(repeated.code).toBe("duplicate_id");
  expect(repeated.fieldPath).toBe("/reports/1/case/id");

  // One report that breaks the run report contract names its position.
  const malformed = failureOf(() =>
    exportShadowReviews([{ schema_version: 1 } as never, ...reports.slice(1)], {
      baselineMeanings: MEANINGS,
      sample: { seed: "s", agreements: 1 },
    }),
  );
  expect(malformed.fieldPath).toBe("/reports/0/run_id");
});

test("one enforcement report and one foreign profile refuse the export", async () => {
  // One exact-only definition holds its derived profile, so one enforcement
  // run passes the complete gate and produces one enforcement report.
  const files = memoryFiles(undefined);
  const reviewer = await load(enforced, {
    files,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const selection = reviewer.profile?.content_hash;
  expect(selection).toBeDefined();
  const report = await reviewer.run(
    { id: "case-enforced", input: { summary: "One summary." } },
    {
      mode: "enforcement",
      ...(selection !== undefined ? { selectedProfileHash: selection } : {}),
    },
  );
  expect(report.mode).toBe("enforcement");
  const refusal = failureOf(() =>
    exportShadowReviews([report], {
      baselineMeanings: MEANINGS,
      sample: { seed: "s", agreements: 1 },
    }),
  );
  expect(refusal.code).toBe("invalid_field_type");
  expect(refusal.fieldPath).toBe("/reports/0/mode");
  expect(refusal.message).toContain("shadow");

  // One report of another profile breaks the provenance of one batch: the
  // sample of one export covers one candidate.
  const sameReports = await batch();
  const otherRun = await bind(
    [SUPPORTED, SUPPORTED, SUPPORTED, SUPPORTED, SUPPORTED, SUPPORTED, SUPPORTED, SUPPORTED, SUPPORTED],
    { execution: { deadline_ms: 12345 } },
  );
  const otherReport = await otherRun(inputFor("case-other"), {
    baseline: { outcome: "send", revision: "policy-2026-03" },
  });
  const foreign = failureOf(() =>
    exportShadowReviews([...sameReports, otherReport], {
      baselineMeanings: MEANINGS,
      sample: { seed: "s", agreements: 1 },
    }),
  );
  expect(foreign.fieldPath).toBe("/reports/9/profile/content_hash");
});

// ---------------------------------------------------------------------------
// The returned labels.
// ---------------------------------------------------------------------------

/** One label return line for one case. */
function labelLine(
  caseId: string,
  expected: Record<string, unknown>,
  label: Record<string, unknown>,
): string {
  return `${JSON.stringify({ case_id: caseId, expected, label })}\n`;
}

test("returned labels validate against the meaning of their checks", async () => {
  const reports = await batch();
  const exported = exportShadowReviews(reports, {
    baselineMeanings: MEANINGS,
    sample: { seed: "review-seed-1", agreements: 3 },
  });
  const labels = [
    labelLine(
      "case-send-fail",
      { checks: { "message-supported": { answer: "contradicted" } } },
      { author_type: "human", reviewed: true, reviewer: "dana", origin: "collected", reason: "One claim conflicts." },
    ),
    labelLine(
      "case-error",
      { outcome: "review" },
      { author_type: "model", reviewed: false, origin: "collected" },
    ),
    labelLine(
      "case-flag-review",
      { checks: { "message-supported": { review: true } } },
      { author_type: "human", reviewed: true, reviewer: "sam" },
    ),
  ].join("");
  const validation = validateReviewLabels({ definition: mixed, exported, labels });
  expect(validation.summary).toEqual({
    lines: 3,
    human_reviewed: 2,
    human_unreviewed: 0,
    model_reviewed: 0,
    model_unreviewed: 1,
    corrected: 0,
    review_required: 1,
  });
  expect(validation.findings).toHaveLength(0);
  expect(validation.labels.map((label) => label.case_id)).toEqual([
    "case-send-fail",
    "case-error",
    "case-flag-review",
  ]);
  expect(validation.labels[0]?.line).toBe(1);
  expect(validation.labels[0]?.expected.checks["message-supported"]?.answer).toBe("contradicted");
  expect(validation.labels[0]?.label.reviewer).toBe("dana");
  expect(validation.limitations.length).toBe(2);
});

test("one label that contradicts the baseline outcome is one valid label", async () => {
  const reports = await batch();
  const exported = exportShadowReviews(reports, {
    baselineMeanings: MEANINGS,
    sample: { seed: "review-seed-1", agreements: 3 },
  });
  // The baseline of case-block-pass recorded `block`, which the host mapped
  // to fail. The human labels the reference answer `supported`, which means
  // pass. The validation reads no baseline, so the label is valid.
  const labels = labelLine(
    "case-block-pass",
    { checks: { "message-supported": { answer: "supported" } } },
    { author_type: "human", reviewed: true, reviewer: "dana" },
  );
  const validation = validateReviewLabels({ definition: mixed, exported, labels });
  expect(validation.summary.lines).toBe(1);
  expect(validation.findings).toHaveLength(0);
  // No key of the result compares one label with one baseline or states one
  // accuracy. The summary field `corrected` names one correction count, so
  // the keys decide, not one substring.
  const hasKey = (value: unknown, key: string): boolean => {
    if (Array.isArray(value)) {
      return value.some((entry) => hasKey(entry, key));
    }
    if (typeof value === "object" && value !== null) {
      return (
        Object.prototype.hasOwnProperty.call(value, key) ||
        Object.values(value).some((entry) => hasKey(entry, key))
      );
    }
    return false;
  };
  for (const key of ["baseline", "agrees", "agreement", "accuracy", "correct"]) {
    expect(hasKey(validation, key), `the validation states ${key}`).toBe(false);
  }
});

test("one conflicting reference stays as written and is flagged", async () => {
  const reports = await batch();
  const exported = exportShadowReviews(reports, {
    baselineMeanings: MEANINGS,
    sample: { seed: "review-seed-1", agreements: 3 },
  });
  const labels = labelLine(
    "case-send-fail",
    { checks: { "message-supported": { answer: "supported", outcome: "fail" } } },
    { author_type: "human", reviewed: true, reviewer: "dana" },
  );
  const validation = validateReviewLabels({ definition: mixed, exported, labels });
  expect(validation.findings).toHaveLength(1);
  expect(validation.findings[0]).toMatchObject({
    line: 1,
    case_id: "case-send-fail",
    check_id: "message-supported",
    kind: "check_outcome_conflict",
    field_path: "/labels/1/expected/checks/message-supported/outcome",
  });
  expect(validation.summary.review_required).toBe(1);
  expect(validation.labels[0]?.expected.checks["message-supported"]?.outcome).toBe("fail");
});

test("broken label returns report their line and field", async () => {
  const reports = await batch();
  const exported = exportShadowReviews(reports, {
    baselineMeanings: MEANINGS,
    sample: { seed: "review-seed-1", agreements: 3 },
  });
  const good = { checks: { "message-supported": { answer: "supported" } } };
  const provenance = { author_type: "human", reviewed: false };
  const rows: readonly { note: string; labels: string; code: string; path: string }[] = [
    { note: "no line at all", labels: "", code: "insufficient_evidence", path: "/labels" },
    { note: "one blank line", labels: "\n", code: "invalid_json", path: "/labels/1" },
    {
      note: "no expected object",
      labels: `{"case_id":"case-send-fail","label":${JSON.stringify(provenance)}}\n`,
      code: "missing_field",
      path: "/labels/1/expected",
    },
    {
      note: "no provenance record",
      labels: `{"case_id":"case-send-fail","expected":${JSON.stringify(good)}}\n`,
      code: "missing_field",
      path: "/labels/1/label",
    },
    {
      note: "one field outside the label contract",
      labels: `{"case_id":"case-send-fail","expected":${JSON.stringify(good)},"label":${JSON.stringify(provenance)},"note":"x"}\n`,
      code: "unknown_field",
      path: "/labels/1/note",
    },
    {
      note: "one case outside the export",
      labels: labelLine("case-unknown", good, provenance),
      code: "unknown_field",
      path: "/labels/1/case_id",
    },
    {
      note: "one case labeled twice",
      labels: `${labelLine("case-send-fail", good, provenance)}${labelLine("case-send-fail", good, provenance)}`,
      code: "duplicate_id",
      path: "/labels/2/case_id",
    },
    {
      note: "one reference outside the definition checks",
      labels: labelLine("case-send-fail", { checks: { "unknown-check": { outcome: "pass" } } }, provenance),
      code: "unknown_field",
      path: "/labels/1/expected/checks/unknown-check",
    },
    {
      note: "one answer outside the declared labels",
      labels: labelLine("case-send-fail", { checks: { "message-supported": { answer: "unknown" } } }, provenance),
      code: "unknown_label",
      path: "/labels/1/expected/checks/message-supported/answer",
    },
    {
      note: "one expected object with no reference",
      labels: labelLine("case-send-fail", {}, provenance),
      code: "invalid_field_type",
      path: "/labels/1/expected",
    },
    {
      note: "one review without one reviewer",
      labels: labelLine("case-send-fail", good, { author_type: "human", reviewed: true }),
      code: "missing_field",
      path: "/labels/1/label/reviewer",
    },
  ];
  for (const row of rows) {
    const failure = failureOf(() =>
      validateReviewLabels({ definition: mixed, exported, labels: row.labels }),
    );
    expect(failure.code, row.note).toBe(row.code);
    expect(failure.fieldPath, row.note).toBe(row.path);
  }

  // One absent option refuses with its field before any core call.
  expect(failureOf(() => validateReviewLabels({} as never)).fieldPath).toBe("/definition");
  expect(
    failureOf(() => validateReviewLabels({ definition: mixed } as never)).fieldPath,
  ).toBe("/exported");
  expect(
    failureOf(() => validateReviewLabels({ definition: mixed, exported } as never)).fieldPath,
  ).toBe("/labels");
});
