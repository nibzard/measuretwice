// SPDX-License-Identifier: Apache-2.0
/**
 * Report and profile rendering tests.
 *
 * These tests cover the renderers of task T037: one mixed run rendered as
 * terminal text and as Markdown, with the summary view leading with the
 * check meaning, the component outcomes, the aggregate outcome, and the
 * next useful action, and the detailed view exposing the applied rules,
 * the measurements, the identities, the versions, the counts, the evidence
 * references, and the limitations. The default explanations come from the
 * check criteria and the executed policy: the selected answer with its
 * authored description, the cutoff arithmetic, the executed rule, and the
 * stable reason of one error or skip. The profile renderers cover the two
 * inspection levels of an exploration profile and of the shared
 * insufficient-evidence calibration profile, and every renderer rejects a
 * definition, a report, or a profile that does not hold. They read local
 * files only, so they stay offline and deterministic.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExplorationProfile,
  createScriptedEvaluator,
  defineChecks,
  load,
  registerEvaluators,
  renderProfileSummary,
  renderProfileSummaryMarkdown,
  renderRunReport,
  renderRunReportMarkdown,
  ValidationError,
  type Definition,
  type FileAccess,
  type Profile,
  type RunCheckRecord,
  type RunReport,
} from "../src/index.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/**
 * One mixed definition with every check shape: one categorical question
 * with one review label, one binary question, one ordered question, and
 * one exact rule.
 */
const mixed = defineChecks({
  version: 1,
  name: "semantic-intervention",
  inputs: Type.Object(
    {
      prior_decision: Type.String({ minLength: 1 }),
      conversation: Type.String({ minLength: 1 }),
      proposed_message: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "message-supported",
      name: "Our message accurately describes the evidence",
      using: ["prior_decision", "conversation", "proposed_message"],
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
      id: "adds-information",
      name: "We are adding something new",
      using: ["conversation", "proposed_message"],
      question: "Has the conversation acknowledged this concern?",
      answers: {
        yes: "One participant recognizes the concern.",
        no: "No message recognizes the concern.",
      },
      accept: "no",
    },
    {
      id: "consequence",
      name: "The concern warrants one interruption",
      using: ["prior_decision", "conversation"],
      question: "What consequence does the concern have?",
      scale: [
        { minor: "No identified consequence." },
        { meaningful: "One coordination problem." },
        { serious: "One conflict with one commitment." },
      ],
      accept: { at_least: "meaningful" },
    },
    {
      id: "message-length",
      name: "The message fits the delivery limit",
      using: ["proposed_message"],
      rule: { maxLength: 280 },
    },
  ],
});

/** One case with canary content that no rendered view may echo. */
const CASE_INPUT = {
  id: "case-1",
  input: {
    prior_decision: "Customer exports stay in the EU. CANARY-PRIOR-9f31",
    conversation: "The team proposes one export worker in the US region. CANARY-TALK-77ac",
    proposed_message: "The export worker moves to the US region. CANARY-DRAFT-5e0d",
  },
};

/** One passing categorical answer with evidence and measurements. */
const SUPPORTED = {
  assessment: {
    kind: "categorical",
    label: "supported",
    distribution: [
      { name: "supported", mass: 0.9 },
      { name: "incomplete", mass: 0.05 },
      { name: "contradicted", mass: 0.05 },
    ],
    confidence: 0.9,
    evidence: [{ input: "prior_decision", reference: "decision-2026-03" }],
  },
  model_resolved: "jev-1.13.0",
  usage: { input_tokens: 1200, output_tokens: 40 },
  latency_ms: 250,
};

/** One passing binary answer. */
const NOTHING_NEW = {
  assessment: { kind: "binary", value: false },
  model_resolved: "jev-1.13.0",
  usage: { input_tokens: 800, output_tokens: 8 },
  latency_ms: 120,
};

/** One ordered answer that reviews between the two cutoffs. */
const MINOR = {
  assessment: {
    kind: "ordered",
    level: "minor",
    position: 0,
    distribution: [
      { name: "minor", mass: 0.45 },
      { name: "meaningful", mass: 0.1 },
      { name: "serious", mass: 0.45 },
    ],
  },
  model_resolved: "jev-1.13.0",
  usage: { input_tokens: 900, output_tokens: 12 },
  latency_ms: 180,
};

/** One ordered answer that passes. */
const MEANINGFUL = {
  assessment: {
    kind: "ordered",
    level: "meaningful",
    position: 1.5,
    distribution: [
      { name: "minor", mass: 0.1 },
      { name: "meaningful", mass: 0.55 },
      { name: "serious", mass: 0.35 },
    ],
  },
  model_resolved: "jev-1.13.0",
  usage: { input_tokens: 900, output_tokens: 12 },
  latency_ms: 180,
};

/** One categorical answer on the declared review label. */
const INCOMPLETE = {
  assessment: {
    kind: "categorical",
    label: "incomplete",
    distribution: [
      { name: "supported", mass: 0.9 },
      { name: "incomplete", mass: 0.1 },
    ],
  },
  model_resolved: "jev-1.13.0",
};

/** One in-memory file access. */
function memoryFiles(files: Record<string, string>): FileAccess {
  return {
    async read(filePath: string): Promise<string> {
      const text = files[filePath];
      if (text === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      }
      return text;
    },
  };
}

/** Runs one mixed case with the stated scripted answers and renders later. */
async function runWith(
  steps: readonly unknown[],
  profileOptions: Parameters<typeof createExplorationProfile>[2] = {},
): Promise<{ readonly report: RunReport; readonly profile: Profile }> {
  const clock = new FakeClock(START_MS);
  const evaluator = createScriptedEvaluator({
    steps: steps.map((step) =>
      step !== null && typeof step === "object" && !("answer" in step) && !("error" in step) && !("raw" in step)
        ? { answer: step }
        : step,
    ) as never,
  });
  const registry = registerEvaluators(evaluator);
  const profile = createExplorationProfile(mixed, registry, profileOptions);
  const files = memoryFiles({ "/profile.json": JSON.stringify(profile) });
  const reviewer = await load(mixed, {
    profile: "/profile.json",
    evaluators: registry,
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
  });
  return { report: await reviewer.run(CASE_INPUT), profile };
}

/** Runs one renderer and returns the public failure it must throw. */
function failureOf(operation: () => unknown): ValidationError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("the renderer was accepted");
}

// ---------------------------------------------------------------------------
// The terminal summary of one failing run.
// ---------------------------------------------------------------------------

test("the terminal summary leads with meaning, outcomes, aggregate, and next action", async () => {
  const { report } = await runWith([SUPPORTED, { assessment: { kind: "binary", value: true } }, MINOR]);
  expect(report.aggregate.outcome).toBe("fail");
  const text = renderRunReport(mixed, report);

  // The header names the definition, the run, and the mode.
  expect(text).toContain("semantic-intervention · run run-000001 · shadow mode\n");

  // Every row leads with the readable check meaning, not the identifier.
  const lines = text.split("\n");
  expect(lines).toContain("PASS    Our message accurately describes the evidence");
  expect(lines).toContain("FAIL    We are adding something new");
  expect(lines).toContain("REVIEW  The concern warrants one interruption");
  expect(lines).toContain("PASS    The message fits the delivery limit");

  // One passing row states no explanation in the summary view.
  expect(lines).not.toContain(`${" ".repeat(8)}All claims are supported.`);

  // The default explanations come from the check criteria and the policy.
  expect(text).toContain(
    "The answer \"yes\": One participant recognizes the concern. Unacceptable mass 1 meets the rejection cutoff 0.6.",
  );
  expect(text).toContain(
    "The answer \"minor\": No identified consequence. Neither cutoff was met: acceptable mass 0.55, unacceptable mass 0.45.",
  );

  // The aggregate outcome, its explanation, the completion, and the action.
  expect(lines).toContain("Overall: FAIL");
  expect(text).toContain(
    "The check \"We are adding something new\" failed. A pass on another check cannot compensate.",
  );
  expect(text).toContain("Completion: completed at 2026-09-24T00:00:00.000Z");
  expect(text).toContain("Next: Inspect the failed check before you use this candidate.");
  expect(lines).toContain("A report authorizes no application action.");

  // The renderer is one pure function: the same report renders the same text.
  expect(renderRunReport(mixed, report)).toBe(text);
});

test("review answers, floors, and binary passes explain their criteria", async () => {
  // One declared review label explains the criteria, not a model rationale.
  const review = await runWith([INCOMPLETE, NOTHING_NEW, MEANINGFUL]);
  expect(review.report.aggregate.outcome).toBe("review");
  const reviewText = renderRunReport(mixed, review.report, { detail: "detail" });
  expect(reviewText).toContain(
    "The answer \"incomplete\": Support for one claim is missing. It is a review answer of this check.",
  );
  expect(reviewText).toContain(
    "The check \"Our message accurately describes the evidence\" needs review. The evidence did not support an automatic decision.",
  );
  expect(reviewText).toContain("Next: Review the supplied evidence before you decide on this candidate.");

  // One confidence floor below the reported confidence explains the floor.
  const floored = await runWith([SUPPORTED, NOTHING_NEW, MEANINGFUL], {
    starterChecks: {
      "message-supported": { accept_cutoff: 0.8, rejection_cutoff: 0.6, confidence_floor: 0.95 },
    },
  });
  const flooredText = renderRunReport(mixed, floored.report, { detail: "detail" });
  expect(flooredText).toContain(
    "The answer \"supported\": All claims are supported. Reported confidence 0.9 is below the confidence floor 0.95.",
  );

  // One binary pass names the accepted answer and its derived mass.
  const passing = await runWith([SUPPORTED, NOTHING_NEW, MEANINGFUL]);
  const passingText = renderRunReport(mixed, passing.report, { detail: "detail" });
  expect(passingText).toContain(
    "The answer \"no\": No message recognizes the concern. Acceptable mass 1 meets the accept cutoff 0.8.",
  );
  expect(passingText).toContain("The answer \"meaningful\": One coordination problem. Acceptable mass 0.9 meets the accept cutoff 0.8.");
});

// ---------------------------------------------------------------------------
// Errors, skips, and recorded explanations.
// ---------------------------------------------------------------------------

/** One error record with its stable reason. */
const ERROR_RECORD: RunCheckRecord = {
  check: "message-supported",
  kind: "question",
  outcome: "error",
  attempts: 2,
  reason: {
    code: "retries_exhausted",
    message: "The adapter failed 2 times with evaluator_error.",
  },
};

/** One skipped record with its stable reason. */
const SKIP_RECORD: RunCheckRecord = {
  check: "adds-information",
  kind: "question",
  outcome: "skipped",
  reason: { code: "queue_full", message: "The pending-work limit stopped this check." },
};

test("error and skip records keep their stable reasons and the run its status", async () => {
  const { report } = await runWith([SUPPORTED, NOTHING_NEW, MEANINGFUL]);
  const errored: RunReport = {
    ...report,
    checks: [ERROR_RECORD, SKIP_RECORD, report.checks[2]!, report.checks[3]!],
    aggregate: { outcome: "error" },
    completion: { status: "cancelled", completed_at: "2026-09-24T00:00:01.000Z" },
  };
  const text = renderRunReport(mixed, errored);
  expect(text).toContain(
    "Execution failed: retries_exhausted. The adapter failed 2 times with evaluator_error.",
  );
  expect(text).toContain("The check was not attempted: queue_full. The pending-work limit stopped this check.");
  expect(text).toContain("Overall: ERROR");
  expect(text).toContain(
    "The check \"Our message accurately describes the evidence\" ended in error. The run established no complete judgment.",
  );
  expect(text).toContain("Completion: cancelled at 2026-09-24T00:00:01.000Z");
  expect(text).toContain(
    "Next: Execution established no complete judgment. Inspect the recorded failure before you use this candidate.",
  );

  // One review aggregate names the review checks and the skipped checks.
  const REVIEW_RECORD: RunCheckRecord = {
    check: "message-supported",
    kind: "question",
    outcome: "review",
    assessment: { kind: "categorical", label: "incomplete" },
  };
  const asReview: RunReport = {
    ...report,
    checks: [REVIEW_RECORD, SKIP_RECORD, report.checks[2]!, report.checks[3]!],
    aggregate: { outcome: "review" },
  };
  const reviewText = renderRunReport(mixed, asReview);
  expect(reviewText).toContain(
    "The check \"Our message accurately describes the evidence\" needs review. " +
      "The check \"We are adding something new\" was not attempted. " +
      "The evidence did not support an automatic decision.",
  );
});

test("the recorded aggregate explanation renders as stored", async () => {
  const { report } = await runWith([SUPPORTED, { assessment: { kind: "binary", value: true } }, MINOR]);
  const stored: RunReport = {
    ...report,
    aggregate: { outcome: "fail", explanation: "The host stored this explanation with the report." },
  };
  const text = renderRunReport(mixed, stored);
  expect(text).toContain("The host stored this explanation with the report.");
  expect(text).not.toContain("A pass on another check cannot compensate.");
});

// ---------------------------------------------------------------------------
// The detailed view.
// ---------------------------------------------------------------------------

test("the detailed view exposes rules, measurements, identities, and limitations", async () => {
  const { report } = await runWith([SUPPORTED, { assessment: { kind: "binary", value: true } }, MINOR]);
  const text = renderRunReport(mixed, report, { detail: "detail" });

  // One question record exposes its meaning, its answer, and its numbers.
  expect(text).toContain("check: message-supported · question");
  expect(text).toContain("answer: supported (categorical)");
  expect(text).toContain("distribution: supported 0.9 · incomplete 0.05 · contradicted 0.05");
  expect(text).toContain("confidence: 0.9");
  expect(text).toContain("policy: accept >= 0.8 · reject >= 0.6");
  expect(text).toContain("evaluator: scripted-test · adapter 0.1.0 · model jev-1.13.0");
  expect(text).toContain("counts: queued 0 ms · executed 250 ms");
  expect(text).toContain("usage: input_tokens 1200 · output_tokens 40");
  expect(text).toContain("answer: minor (ordered · position 0)");

  // Evidence references render as evaluator-selected support.
  expect(text).toContain("evidence: prior_decision:decision-2026-03 (selected by the evaluator)");

  // One rule record exposes its executed rule.
  expect(text).toContain("check: message-length · rule");
  expect(text).toContain("rule: maxLength 280 on proposed_message");

  // The identity block cites the report fields with the complete hashes.
  expect(text).toContain(`definition: semantic-intervention · content hash ${report.definition.content_hash}`);
  expect(text).toContain(`profile: ${report.profile.id} · content hash ${report.profile.content_hash}`);
  expect(text).toContain(`case: case-1 · input hash ${report.case.input_hash}`);

  // The limitations state what the view generates and what it claims not.
  expect(text).toContain("Limitations");
  expect(text).toContain(
    "Explanations are generated from the check criteria and the executed policy. No evaluator rationale exists.",
  );
  expect(text).toContain(
    "Evidence references were selected by the evaluator. An absent reference means the evaluator returned none.",
  );
});

test("no rendered view echoes raw case content", async () => {
  const { report } = await runWith([SUPPORTED, NOTHING_NEW, MEANINGFUL]);
  const canaries = ["CANARY-PRIOR-9f31", "CANARY-TALK-77ac", "CANARY-DRAFT-5e0d"];
  for (const text of [
    renderRunReport(mixed, report),
    renderRunReport(mixed, report, { detail: "detail" }),
    renderRunReportMarkdown(mixed, report, { detail: "detail" }),
  ]) {
    for (const canary of canaries) {
      expect(text, canary).not.toContain(canary);
    }
  }
});

// ---------------------------------------------------------------------------
// Markdown rendering.
// ---------------------------------------------------------------------------

test("the Markdown views state the same content as the terminal views", async () => {
  const { report } = await runWith([SUPPORTED, { assessment: { kind: "binary", value: true } }, MINOR]);
  const summary = renderRunReportMarkdown(mixed, report);
  expect(summary).toContain("# semantic-intervention");
  expect(summary).toContain("Run `run-000001` · mode `shadow`");
  expect(summary).toContain("- **PASS** Our message accurately describes the evidence");
  expect(summary).toContain("- **FAIL** We are adding something new — ");
  expect(summary).toContain("**Overall: FAIL** — ");
  expect(summary).toContain("**Completion:** completed at 2026-09-24T00:00:00.000Z");
  expect(summary).toContain("**Next:** Inspect the failed check before you use this candidate.");

  const detail = renderRunReportMarkdown(mixed, report, { detail: "detail" });
  expect(detail).toContain("  - check: message-supported · question");
  expect(detail).toContain("  - rule: maxLength 280 on proposed_message");
  expect(detail).toContain("## Details");
  expect(detail).toContain(`- definition: semantic-intervention · content hash ${report.definition.content_hash}`);
  expect(detail).toContain("## Limitations");
});

// ---------------------------------------------------------------------------
// Rejections.
// ---------------------------------------------------------------------------

test("the renderers reject artifacts that do not hold", async () => {
  const { report } = await runWith([SUPPORTED, NOTHING_NEW, MEANINGFUL]);

  // One definition that names other content than the report: the same
  // checks with one changed question, so its content hash differs.
  const other: Definition = {
    ...mixed,
    checks: mixed.checks.map((check) =>
      check.id === "message-supported"
        ? { ...check, question: "Does every claim follow from the supplied record?" }
        : check,
    ),
  };
  const mismatch = failureOf(() => renderRunReport(other, report));
  expect(mismatch.code).toBe("definition_mismatch");
  expect(mismatch.fieldPath).toBe("/definition/content_hash");

  // One stored aggregate that disagrees with the component outcomes.
  const disagreeing: RunReport = { ...report, aggregate: { outcome: "fail" } };
  const aggregate = failureOf(() => renderRunReport(mixed, disagreeing));
  expect(aggregate.code).toBe("invalid_field_type");
  expect(aggregate.fieldPath).toBe("/aggregate/outcome");

  // One record that names no check of the definition.
  const unknown: RunReport = {
    ...report,
    checks: report.checks.map((record, index) =>
      index === 0 ? { ...record, check: "unknown-check" } : record,
    ),
  };
  const unknownCheck = failureOf(() => renderRunReport(mixed, unknown));
  expect(unknownCheck.code).toBe("unknown_field");
  expect(unknownCheck.fieldPath).toBe("/checks/0/check");

  // One error record without its reason.
  const unreasonable: RunReport = {
    ...report,
    checks: report.checks.map((record) =>
      record.check === "message-supported" ? { ...record, outcome: "error" as const } : record,
    ),
    aggregate: { outcome: "error" },
  };
  const reasonless = failureOf(() => renderRunReport(mixed, unreasonable));
  expect(reasonless.code).toBe("missing_field");
  expect(reasonless.fieldPath).toBe("/checks/0/reason");

  // One invalid detail level.
  const invalidDetail = { detail: "full" } as unknown as { readonly detail?: "summary" | "detail" };
  const level = failureOf(() => renderRunReport(mixed, report, invalidDetail));
  expect(level.code).toBe("invalid_field_type");
  expect(level.fieldPath).toBe("/detail");
});

// ---------------------------------------------------------------------------
// Profile summaries.
// ---------------------------------------------------------------------------

/** The shared profile fixtures of the repository. */
const states = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/profiles/states.json"),
    "utf8",
  ),
) as { readonly profiles: readonly Profile[] };

test("the exploration profile summary states its readiness without measured numbers", async () => {
  const registry = registerEvaluators(
    createScriptedEvaluator({ steps: [{ answer: SUPPORTED } as never] }),
  );
  const profile = createExplorationProfile(mixed, registry);
  const summary = renderProfileSummary(profile);
  const lines = summary.split("\n");
  expect(lines[0]).toBe("Profile semantic-intervention-exploration (exploration)");
  expect(lines).toContain("Intended use: Development exploration of the definition semantic-intervention. Not a measured population, and starter thresholds carry no qualification evidence.");
  expect(lines).toContain("Readiness: unvalidated (unvalidated)");
  expect(lines).toContain("Reasons: starter_policy");
  expect(summary).toContain(`Definition: semantic-intervention (${profile.definition.content_hash.slice(0, 8)})`);
  expect(summary).not.toContain("0 of");

  // The detailed view states the bindings, the policy, and the execution
  // configuration, and it omits the absent evidence and performance.
  const detail = renderProfileSummary(profile, { detail: "detail" });
  expect(detail).toContain("Bindings");
  expect(detail).toContain(
    "message-supported: evaluator scripted-test · adapter 0.1.0 · translation",
  );
  expect(detail).toContain("Policy");
  expect(detail).toContain("family: probability_mass_v0");
  expect(detail).toContain("message-supported: accept >= 0.8 · reject >= 0.6");
  expect(detail).toContain("Execution");
  expect(detail).toContain("4 active · 16 pending · 30000 ms deadline · 2 attempts · 200 ms backoff");
  expect(detail).not.toContain("Evidence");
  expect(detail).not.toContain("Performance");
  expect(detail).toContain("Identity");
  expect(detail).toContain(`content hash: ${profile.content_hash}`);

  // The generation stays deterministic, so the render stays deterministic.
  expect(renderProfileSummary(createExplorationProfile(mixed, registry))).toBe(summary);
});

test("the insufficient-evidence profile renders its readiness, evidence, and counts", () => {
  const profile = states.profiles.find((entry) => entry.id === "message-supported-insufficient");
  expect(profile).toBeDefined();
  const insufficient = profile!;

  // The summary states the readiness and its stable reasons, and no
  // performance number appears outside the detailed view.
  const summary = renderProfileSummary(insufficient);
  const lines = summary.split("\n");
  expect(lines[0]).toBe("Profile message-supported-insufficient (calibration)");
  expect(lines).toContain("Readiness: insufficient evidence (insufficient_evidence)");
  expect(lines).toContain("Reasons: measured_evidence, insufficient_evidence");
  expect(lines).toContain("Scope: The Cassandra pilot conversation population declared in the plan.");
  expect(summary).not.toContain("0 of 9");
  expect(summary).not.toContain("Wilson");

  // The detailed view exposes the exact rules, evaluator versions, datasets,
  // counts, and limitations of the spec's inspection levels.
  const detail = renderProfileSummary(insufficient, { detail: "detail" });
  expect(detail).toContain(
    "message-supported: evaluator jev-choice · adapter 0.1.0 · translation a5065efe · model jev-1.13 (resolved jev-1.13-2026-09-01)",
  );
  expect(detail).toContain("family: probability_mass_v0");
  expect(detail).toContain("message-supported: accept >= 0.8 · reject >= 0.7");
  expect(detail).toContain("Evidence");
  expect(detail).toContain("plan: message-supported-plan (de4bcb9a)");
  expect(detail).toContain(
    "datasets: message-supported-cases (revision 2026-09-23, 86075a4c)",
  );
  expect(detail).toContain("splits: fitting (923feb8e), validation (d9b765d1)");
  expect(detail).toContain(
    "label provenance: Synthetic cases proposed by a coding agent. A human reviewed and corrected the later-corrections case. Model suggestions are not human judgments.",
  );
  expect(detail).toContain("evaluation reports: reports/message-supported-fitting.json");
  expect(detail).toContain(
    "statistical method: Wilson score intervals at 95 percent confidence, computed on accepted cases. Cases grouped by conversation.",
  );
  expect(detail).toContain("Performance");
  expect(detail).toContain("error_among_accepted (message-supported): 0 of 9 = 0");
  expect(detail).toContain("sample counts: labeled_cases 9 · accepted_cases 9");
  expect(detail).toContain(
    "slice limitation: Nine labeled cases sit below the plan minimum of 200. Zero observed errors do not establish the goal.",
  );
  expect(detail).toContain(`content hash: ${insufficient.content_hash}`);
  expect(detail).toContain("Limitations");
  expect(detail).toContain(
    "The qualification status is recorded evidence, not one authenticated approval. The host reviews and selects one profile hash.",
  );
});

test("the profile Markdown views state the same content as the terminal views", () => {
  const insufficient = states.profiles.find(
    (entry) => entry.id === "message-supported-insufficient",
  )!;
  const summary = renderProfileSummaryMarkdown(insufficient);
  expect(summary).toContain("# Profile message-supported-insufficient (calibration)");
  expect(summary).toContain("**Readiness:** insufficient evidence (insufficient_evidence)");
  expect(summary).toContain("**Reasons:** measured_evidence, insufficient_evidence");

  const detail = renderProfileSummaryMarkdown(insufficient, { detail: "detail" });
  expect(detail).toContain("## Evidence");
  expect(detail).toContain("- plan: message-supported-plan (de4bcb9a)");
  expect(detail).toContain("## Performance");
  expect(detail).toContain("- error_among_accepted (message-supported): 0 of 9 = 0");
  expect(detail).toContain("## Limitations");
});

test("one edited profile fails the self-hash before it renders", () => {
  const insufficient = states.profiles.find(
    (entry) => entry.id === "message-supported-insufficient",
  )!;
  const edited: Profile = { ...insufficient, intended_use: "Edited after review." };
  const failure = failureOf(() => renderProfileSummary(edited));
  expect(failure.code).toBe("hash_mismatch");
  const markdownFailure = failureOf(() => renderProfileSummaryMarkdown(edited));
  expect(markdownFailure.code).toBe("hash_mismatch");
});
