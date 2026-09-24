// SPDX-License-Identifier: Apache-2.0
/**
 * Evaluate API tests.
 *
 * These tests cover task T044: one evaluation runs every record of one
 * labeled dataset through the same validated execution path as an ordinary
 * run, measures the outcomes against the reference labels in the Rust core,
 * and returns the evaluation report artifact beside one run report per
 * case. The tests pin the metric sets with their counts and denominators,
 * the reference matches, the slices, the operational failures, the latency
 * and the usage, and the boundary that stays closed: no evaluation changes
 * one qualification, selects one profile, or turns one error or one skip
 * into one pass. The adapter is the scripted test evaluator, so the tests
 * read local files only and stay offline and deterministic.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import {
  createExplorationProfile,
  createScriptedEvaluator,
  defineChecks,
  evaluate,
  load,
  registerEvaluators,
  ValidationError,
  type Definition,
  type Evaluator,
  type EvaluatorRequest,
  type ExecutionConfig,
  type FileAccess,
  type Profile,
  type RunReport,
} from "../src/index.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The fixed start time of every test evaluation: 24 September 2026, UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/**
 * One definition with one categorical question that carries one review
 * label, one binary question, and one exact rule, so one dataset reaches
 * every metric and every slice.
 */
const notes = defineChecks({
  version: 1,
  name: "evaluate-release-notes",
  inputs: Type.Object(
    { summary: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "summary-supported",
      name: "The summary states one supported change",
      using: ["summary"],
      question: "Does the summary state one supported change?",
      answers: {
        supported: "Every claim names its evidence.",
        contradicted: "One claim conflicts with the evidence.",
        incomplete: "Support for one claim is missing.",
      },
      accept: "supported",
      review: "incomplete",
    },
    {
      id: "change-customer-visible",
      name: "The change is visible to customers",
      using: ["summary"],
      question: "Is the change visible to customers?",
      answers: {
        yes: "Customers see the change.",
        no: "Customers see nothing.",
      },
      accept: "yes",
    },
    {
      id: "summary-free-of-todos",
      name: "The summary holds no work marker",
      using: ["summary"],
      rule: { excludes: "TODO" },
    },
  ],
});

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
  model_resolved: "scripted-1.4.0",
  usage: { input_tokens: 1200, output_tokens: 40 },
  latency_ms: 250,
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
  model_resolved: "scripted-1.4.0",
  latency_ms: 210,
};

/** One review categorical answer: the review label of the check. */
const INCOMPLETE = {
  assessment: {
    kind: "categorical" as const,
    label: "incomplete",
    distribution: [
      { name: "supported", mass: 0.05 },
      { name: "incomplete", mass: 0.9 },
      { name: "contradicted", mass: 0.05 },
    ],
  },
  model_resolved: "scripted-1.4.0",
  latency_ms: 180,
};

/** One failing binary answer. */
const NO = {
  assessment: { kind: "binary" as const, value: false },
  model_resolved: "scripted-1.4.0",
  latency_ms: 110,
};

/** One passing binary answer. */
const YES = {
  assessment: { kind: "binary" as const, value: true },
  model_resolved: "scripted-1.4.0",
  latency_ms: 120,
};

/** One in-memory file access that records every read. */
function memoryFiles(files: Record<string, string>): FileAccess & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(filePath: string): Promise<string> {
      reads.push(filePath);
      const text = files[filePath];
      if (text === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      }
      return text;
    },
  };
}

/** Runs one operation and returns the public failure it must throw. */
async function failureOf(operation: () => unknown): Promise<ValidationError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("the operation was accepted");
}

/** Builds one dataset metadata artifact. */
function metadata(kind: string): string {
  return JSON.stringify({
    schema_version: 1,
    id: "evaluate-cases",
    name: "Evaluation cases",
    revision: "2026-09-24.1",
    kind,
    intended_population: "Release note summaries of one product area.",
    sampling_method: "Selected from reviewed development work. No prevalence claim.",
    label_guidelines: "See docs/labeling.md revision 3.",
    languages: ["en"],
    splits: [{ id: "all", purpose: "fitting", groups: ["notes"] }],
  });
}

/** Builds one case record of the tests. */
function record(
  id: string,
  summary: string,
  tags: readonly string[],
  expected: unknown,
): string {
  return JSON.stringify({
    id,
    group: "notes",
    input: { summary },
    label: { author_type: "human", reviewed: true, reviewer: "reviewer-1" },
    ...(tags.length > 0 ? { tags } : {}),
    ...(expected === undefined ? {} : { expected }),
  });
}

/** Serializes records into one record file. */
function recordsFile(rows: readonly string[]): string {
  return rows.join("\n");
}

/** The options of one bound evaluation of the tests. */
interface BoundOptions {
  readonly steps?: readonly unknown[];
  readonly evaluator?: Evaluator;
  readonly execution?: Partial<ExecutionConfig>;
  readonly clock?: FakeClock;
}

/** One bound evaluation: the reviewer, the dataset files, and the calls. */
function bind(options: BoundOptions = {}): {
  readonly evaluateWith: (
    dataset: { metadata: string; records: string },
    evaluateOptions?: Record<string, unknown>,
  ) => ReturnType<typeof evaluate>;
  readonly calls: readonly EvaluatorRequest[];
  readonly profile: Profile;
  readonly files: FileAccess & { reads: string[] };
  readonly clock: FakeClock;
} {
  const clock = options.clock ?? new FakeClock(START_MS);
  const evaluator =
    options.evaluator ??
    createScriptedEvaluator({
      // One plain execution object wraps as one answer control, so the
      // tables below state their executions and their failures directly.
      steps: (options.steps ?? []).map((step) =>
        step !== null &&
        typeof step === "object" &&
        !("answer" in step) &&
        !("raw" in step) &&
        !("error" in step)
          ? { answer: step }
          : step,
      ) as never,
    });
  const scripted = evaluator as unknown as { calls?: EvaluatorRequest[] };
  const registry = registerEvaluators(evaluator);
  const profile = createExplorationProfile(notes, registry, {
    ...(options.execution !== undefined ? { execution: options.execution } : {}),
  });
  const files = memoryFiles({ "/profile.json": JSON.stringify(profile) });
  const reviewerPromise = load(notes, {
    profile: "/profile.json",
    evaluators: registry,
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
  });
  return {
    evaluateWith: (dataset, evaluateOptions) =>
      reviewerPromise.then((reviewer) =>
        evaluate(reviewer, {
          metadata: dataset.metadata,
          records: dataset.records,
          purpose: "independent_validation",
          files,
          ...evaluateOptions,
        } as never),
      ),
    calls: scripted.calls ?? [],
    profile,
    files,
    clock,
  };
}

/** Returns the rate of one metric set. */
function rate(
  set: { rates: readonly { metric: string; numerator: number; denominator: number; value: number | null }[] },
  name: string,
): { metric: string; numerator: number; denominator: number; value: number | null } {
  const found = set.rates.find((entry) => entry.metric === name);
  if (found === undefined) {
    throw new Error(`the metric set states no ${name}`);
  }
  return found;
}

/** Lets pending microtasks and awaited promises run once. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Lets the load and read chain of one evaluation settle before a release. */
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// The measured evaluation.
// ---------------------------------------------------------------------------

/** The dataset of the main evaluation: four records, three labeled. */
function mainDataset(): { metadata: string; records: string } {
  return {
    metadata: "/datasets/metadata.json",
    records: "/datasets/cases.jsonl",
  };
}

test("one evaluation measures every check, slice, and denominator", async () => {
  const bound = bind({
    // One answer per question check, in case order.
    steps: [
      { answer: SUPPORTED },
      { answer: YES },
      { answer: SUPPORTED },
      { answer: NO },
      { answer: SUPPORTED },
      { answer: YES },
      { answer: SUPPORTED },
      { answer: YES },
    ],
  });
  const files = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      // Reference pass everywhere, predicted pass everywhere.
      record(
        "case-1",
        "The search index now refreshes nightly.",
        ["dates"],
        {
          checks: {
            "summary-supported": { answer: "supported" },
            "change-customer-visible": { answer: "yes" },
            "summary-free-of-todos": { outcome: "pass" },
          },
          outcome: "pass",
        },
      ),
      // Reference fail on the question, one predicted failure on the binary
      // answer, and one work marker that fails the exact rule.
      record(
        "case-2",
        "The search index TODO refreshes nightly.",
        ["dates"],
        {
          checks: {
            "summary-supported": { answer: "contradicted" },
            "change-customer-visible": { answer: "yes" },
            "summary-free-of-todos": { outcome: "pass" },
          },
          outcome: "fail",
        },
      ),
      // No reference labels at all.
      record("case-3", "The export worker moves data.", [], undefined),
      // One review marker on one check alone.
      record(
        "case-4",
        "One claim names no evidence.",
        ["limits"],
        {
          checks: {
            "summary-supported": { review: true },
            "change-customer-visible": { answer: "no" },
          },
          outcome: "review",
        },
      ),
    ]),
  });
  const evaluation = await bound.evaluateWith(mainDataset(), { files });

  // The artifact states the three identities and the declared purpose.
  const report = evaluation.report;
  expect(report.schema_version).toBe(1);
  expect(report.definition).toEqual({
    name: "evaluate-release-notes",
    content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(report.profile).toEqual({
    id: bound.profile.id,
    content_hash: bound.profile.content_hash,
  });
  expect(report.dataset).toEqual({
    id: "evaluate-cases",
    revision: "2026-09-24.1",
    content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(report.purpose).toBe("independent_validation");

  // One case per record, in evaluation order, with the predicted outcome of
  // every check and the reference match of every check.
  expect(report.cases.map((one) => one.id)).toEqual([
    "case-1",
    "case-2",
    "case-3",
    "case-4",
  ]);
  expect(report.cases.map((one) => one.aggregate)).toEqual([
    "pass",
    "fail",
    "pass",
    "pass",
  ]);
  expect(report.cases.map((one) => one.completion)).toEqual([
    "completed",
    "completed",
    "completed",
    "completed",
  ]);
  expect(report.cases[0]?.outcomes).toEqual({
    "summary-supported": "pass",
    "change-customer-visible": "pass",
    "summary-free-of-todos": "pass",
  });
  expect(report.cases[0]?.reference_match).toEqual({
    "summary-supported": true,
    "change-customer-visible": true,
    "summary-free-of-todos": true,
  });
  expect(report.cases[1]?.reference_match).toEqual({
    "summary-supported": false,
    "change-customer-visible": false,
    "summary-free-of-todos": false,
  });
  // One case without labels holds no reference and no match on any check.
  expect(report.cases[2]?.reference_match).toEqual({
    "summary-supported": null,
    "change-customer-visible": null,
    "summary-free-of-todos": null,
  });
  // One reference on one check alone leaves the other checks without one.
  expect(report.cases[3]?.reference_match).toEqual({
    "summary-supported": false,
    "change-customer-visible": false,
    "summary-free-of-todos": null,
  });

  // One metric set per check, then the complete check set.
  expect(report.metrics.map((set) => set.scope)).toEqual([
    "summary-supported",
    "change-customer-visible",
    "summary-free-of-todos",
    "all_checks",
  ]);

  // The categorical check: one reference fail, one reference review, one
  // reference pass, one unlabeled case, and four predicted passes.
  const question = report.metrics[0];
  expect(question?.counts).toEqual({
    pass: 4,
    fail: 0,
    review: 0,
    error: 0,
    skipped: 0,
  });
  const falseAcceptance = rate(question!, "false_acceptance_rate");
  expect(falseAcceptance).toEqual({
    metric: "false_acceptance_rate",
    numerator: 2,
    denominator: 2,
    value: 1,
  });
  // The same numerator over the labeled predicted passes: three.
  const accepted = rate(question!, "error_among_accepted");
  expect(accepted.numerator).toBe(2);
  expect(accepted.denominator).toBe(3);
  expect(accepted.value).toBeCloseTo(2 / 3, 12);
  expect(rate(question!, "false_rejection_rate").value).toBe(0);
  expect(rate(question!, "review_rate").value).toBe(0);
  expect(rate(question!, "automatic_coverage").value).toBe(1);
  // Three of four cases carry one reference for this check.
  const labelCoverage = rate(question!, "label_coverage");
  expect(labelCoverage.numerator).toBe(3);
  expect(labelCoverage.denominator).toBe(4);
  expect(labelCoverage.value).toBeCloseTo(0.75, 12);

  // The binary check: one predicted failure among two reference passes.
  const binary = report.metrics[1];
  expect(binary?.counts).toEqual({
    pass: 3,
    fail: 1,
    review: 0,
    error: 0,
    skipped: 0,
  });
  expect(rate(binary!, "false_rejection_rate")).toEqual({
    metric: "false_rejection_rate",
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });
  expect(rate(binary!, "false_acceptance_rate")).toEqual({
    metric: "false_acceptance_rate",
    numerator: 1,
    denominator: 1,
    value: 1,
  });

  // The exact rule: one predicted failure among two reference passes, and
  // no reference fail or review case, so the false acceptance rate holds
  // one zero denominator and no value.
  const rule = report.metrics[2];
  expect(rule?.counts).toEqual({
    pass: 3,
    fail: 1,
    review: 0,
    error: 0,
    skipped: 0,
  });
  expect(rate(rule!, "false_acceptance_rate")).toEqual({
    metric: "false_acceptance_rate",
    numerator: 0,
    denominator: 0,
    value: null,
  });
  expect(rate(rule!, "label_coverage").value).toBeCloseTo(0.5, 12);

  // The complete check set counts the aggregate outcomes.
  const complete = report.metrics[3];
  expect(complete?.counts).toEqual({
    pass: 3,
    fail: 1,
    review: 0,
    error: 0,
    skipped: 0,
  });
  expect(rate(complete!, "false_acceptance_rate")).toEqual({
    metric: "false_acceptance_rate",
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });

  // One metric row per slice tag of the evaluated records.
  expect(report.slices?.map((slice) => slice.tag)).toEqual(["dates", "limits"]);
  const dates = report.slices?.[0];
  expect(dates?.metrics.map((set) => set.scope)).toEqual([
    "summary-supported",
    "change-customer-visible",
    "summary-free-of-todos",
    "all_checks",
  ]);
  expect(dates?.metrics[0]?.counts.pass).toBe(2);
  expect(dates?.metrics[3]?.counts).toEqual({
    pass: 1,
    fail: 1,
    review: 0,
    error: 0,
    skipped: 0,
  });
  const limits = report.slices?.[1];
  expect(limits?.metrics[0]?.counts.pass).toBe(1);

  // Every case ran through the same execution path: one run report per
  // case, with the actual evaluator versions, the timing, and the usage.
  expect(evaluation.runs).toHaveLength(4);
  expect(evaluation.runs.map((run) => run.case.id)).toEqual([
    "case-1",
    "case-2",
    "case-3",
    "case-4",
  ]);
  for (const run of evaluation.runs) {
    expect(run.mode).toBe("shadow");
    expect(run.profile).toEqual({
      id: bound.profile.id,
      content_hash: bound.profile.content_hash,
    });
    const question = run.checks.find((check) => check.check === "summary-supported");
    expect(question?.evaluator).toEqual({
      id: "scripted-test",
      adapter_version: "0.1.0",
      model_resolved: "scripted-1.4.0",
    });
    expect(question?.timing).toEqual({ queued_ms: 0, execution_ms: 250 });
  }

  // The operational totals: no error, no retry, and the summed usage of
  // every case. No case states one elapsed time, so the evaluation states
  // none either.
  expect(report.operational?.errors).toEqual([]);
  expect(report.operational?.attempts).toBe(0);
  expect(report.operational?.usage).toEqual({
    input_tokens: 4800,
    output_tokens: 160,
  });
  expect("elapsed_ms" in (report.operational ?? {})).toBe(false);

  // Nothing is missing and nothing is silenced.
  expect(evaluation.unevaluated_records).toBe(0);
  expect(evaluation.population).toEqual({
    kind: "development_fixture",
    statement: "development_fixture",
    supports_qualification: false,
    states_prevalence: false,
    intended_population: "Release note summaries of one product area.",
    sampling_method: "Selected from reviewed development work. No prevalence claim.",
  });

  // The whole evaluation read the two dataset paths once, through the file
  // access the caller stated, and the bound reviewer read no file again.
  expect(files.reads).toEqual(["/datasets/metadata.json", "/datasets/cases.jsonl"]);
  expect(bound.files.reads).toEqual(["/profile.json"]);
});

test("one evaluation with provider errors keeps every failure visible", async () => {
  const bound = bind({
    execution: { max_attempts: 2, backoff_ms: 0 },
    // Both question checks take their first attempt at submission, then
    // each retry takes the next step, so every step fails.
    steps: [
      { failure: { code: "evaluator_timeout", message: "The first attempt of the categorical check timed out." } },
      { failure: { code: "evaluator_timeout", message: "The first attempt of the binary check timed out." } },
      { failure: { code: "evaluator_timeout", message: "The second attempt of the categorical check timed out." } },
      { failure: { code: "evaluator_timeout", message: "The second attempt of the binary check timed out." } },
    ],
  });
  const files = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      record(
        "case-1",
        "The search index now refreshes nightly.",
        [],
        {
          checks: {
            "summary-supported": { answer: "supported" },
            "change-customer-visible": { answer: "yes" },
            "summary-free-of-todos": { outcome: "pass" },
          },
          outcome: "pass",
        },
      ),
    ]),
  });
  const evaluation = await bound.evaluateWith(mainDataset(), { files });

  // Both question checks exhausted their attempts, and neither became one
  // pass: the counts state the errors, and the exact rule still ran.
  const report = evaluation.report;
  expect(report.cases[0]?.outcomes).toEqual({
    "summary-supported": "error",
    "change-customer-visible": "error",
    "summary-free-of-todos": "pass",
  });
  expect(report.cases[0]?.aggregate).toBe("error");
  expect(report.metrics[0]?.counts).toEqual({
    pass: 0,
    fail: 0,
    review: 0,
    error: 1,
    skipped: 0,
  });
  expect(report.metrics[1]?.counts.error).toBe(1);
  // The errored case stays in the denominator of every rate whose
  // population holds it, so the failure improves no rate.
  const falseAcceptance = rate(report.metrics[0]!, "false_acceptance_rate");
  expect(falseAcceptance.numerator).toBe(0);
  expect(falseAcceptance.denominator).toBe(0);
  expect(falseAcceptance.value).toBeNull();
  expect(rate(report.metrics[0]!, "label_coverage").value).toBe(1);

  // The operational failures state their sanitized reasons over all
  // attempts, and the attempts are counted.
  expect(report.operational?.errors).toEqual([
    {
      code: "retries_exhausted",
      message: expect.stringContaining("evaluator_timeout"),
    },
    {
      code: "retries_exhausted",
      message: expect.stringContaining("evaluator_timeout"),
    },
  ]);
  expect(report.operational?.attempts).toBe(4);

  // The run report keeps the full record of the failures.
  const failed = evaluation.runs[0]?.checks.find(
    (check) => check.check === "summary-supported",
  );
  expect(failed?.outcome).toBe("error");
  expect(failed?.attempts).toBe(2);
  expect(failed?.reason?.code).toBe("retries_exhausted");
});

test("saturation skips stay visible in every metric set", async () => {
  // One evaluator whose first answer waits for one manual release, with one
  // active slot and no pending slot, so the other checks never start.
  const calls: EvaluatorRequest[] = [];
  const waiting: Array<() => void> = [];
  const blocking: Evaluator = {
    id: "blocking-test",
    adapter_version: "0.1.0",
    async assess(request: EvaluatorRequest) {
      calls.push(request);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
      return SUPPORTED as never;
    },
  };
  const bound = bind({
    evaluator: blocking,
    execution: { max_active: 1, max_pending: 0 },
  });
  const files = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      record(
        "case-1",
        "The search index now refreshes nightly.",
        [],
        {
          checks: {
            "summary-supported": { answer: "supported" },
            "change-customer-visible": { answer: "yes" },
            "summary-free-of-todos": { outcome: "pass" },
          },
          outcome: "pass",
        },
      ),
    ]),
  });
  const pending = bound.evaluateWith(mainDataset(), { files });
  await flush();
  expect(calls).toHaveLength(1);
  waiting.shift()?.();
  const evaluation = await pending;

  // The skipped checks never became one pass, and the review rate counts
  // one skip the same way one review outcome counts.
  const report = evaluation.report;
  expect(report.cases[0]?.outcomes).toEqual({
    "summary-supported": "pass",
    "change-customer-visible": "skipped",
    "summary-free-of-todos": "skipped",
  });
  expect(report.cases[0]?.aggregate).toBe("review");
  expect(report.metrics[1]?.counts).toEqual({
    pass: 0,
    fail: 0,
    review: 0,
    error: 0,
    skipped: 1,
  });
  expect(rate(report.metrics[1]!, "review_rate")).toEqual({
    metric: "review_rate",
    numerator: 1,
    denominator: 1,
    value: 1,
  });
  expect(rate(report.metrics[1]!, "automatic_coverage").value).toBe(0);
  // One skip never matches one reference.
  expect(report.cases[0]?.reference_match).toEqual({
    "summary-supported": true,
    "change-customer-visible": false,
    "summary-free-of-todos": false,
  });
});

test("one cancelled evaluation keeps its partial result and stops", async () => {
  const calls: EvaluatorRequest[] = [];
  const waiting: Array<() => void> = [];
  const blocking: Evaluator = {
    id: "blocking-test",
    adapter_version: "0.1.0",
    async assess(request: EvaluatorRequest) {
      calls.push(request);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
      return SUPPORTED as never;
    },
  };
  const bound = bind({ evaluator: blocking });
  const files = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      record("case-1", "The search index now refreshes nightly.", [], undefined),
      record("case-2", "The export worker moves data.", [], undefined),
    ]),
  });
  const controller = new AbortController();
  const pending = bound.evaluateWith(mainDataset(), {
    files,
    signal: controller.signal,
  });
  await flush();
  // Both question checks of the first case are in flight and blocked.
  expect(calls).toHaveLength(2);
  controller.abort(new Error("the host stopped the evaluation"));
  const evaluation = await pending;

  // The case in flight froze with its cancelled terminal state, and the
  // record that never ran stays counted instead of silently missing.
  const report = evaluation.report;
  expect(report.cases).toHaveLength(1);
  expect(report.cases[0]?.id).toBe("case-1");
  expect(report.cases[0]?.completion).toBe("cancelled");
  expect(evaluation.runs[0]?.completion.status).toBe("cancelled");
  expect(evaluation.unevaluated_records).toBe(1);
  expect(evaluation.limitations.some((one) => one.includes("no evaluated outcome"))).toBe(true);

  // One evaluation cancelled before its first case ran states no report,
  // because no metric has one denominator.
  const refused = bind();
  const refusalFiles = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      record("case-1", "The search index now refreshes nightly.", [], undefined),
    ]),
  });
  const controllerBefore = new AbortController();
  controllerBefore.abort(new Error("the host stopped the evaluation"));
  const failure = await failureOf(() =>
    refused.evaluateWith(mainDataset(), {
      files: refusalFiles,
      signal: controllerBefore.signal,
    }),
  );
  expect(failure.code).toBe("insufficient_evidence");
  expect(failure.fieldPath).toBe("/cases");
});

test("one evaluation changes no qualification and no host selection", async () => {
  const registry = registerEvaluators(
    createScriptedEvaluator({
      steps: [
        { answer: SUPPORTED },
        { answer: YES },
        { answer: CONTRADICTED },
        { answer: YES },
      ] as never,
    }),
  );
  const profile = createExplorationProfile(notes, registry);
  const files = memoryFiles({
    "/profile.json": JSON.stringify(profile),
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      record("case-1", "The search index now refreshes nightly.", [], undefined),
      record("case-2", "The export worker moves data.", [], undefined),
    ]),
  });
  const reviewer = await load(notes, {
    profile: "/profile.json",
    evaluators: registry,
    files,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const before = JSON.stringify(reviewer.profile);

  // The evaluation measures an unvalidated exploration profile, exactly as
  // the shadow admission of the run path accepts it.
  const evaluation = await evaluate(reviewer, {
    metadata: "/datasets/metadata.json",
    records: "/datasets/cases.jsonl",
    purpose: "fitting",
    files,
  });
  expect(evaluation.report.purpose).toBe("fitting");
  expect(evaluation.report.profile.content_hash).toBe(
    (reviewer.profile as Profile).content_hash,
  );

  // The bound artifact is unchanged, byte for byte.
  expect(JSON.stringify(reviewer.profile)).toBe(before);
  expect(reviewer.profile?.qualification.status).toBe("unvalidated");

  // No promotion happened: one enforcement run still refuses the unvalidated
  // profile before any work starts, whatever selection it states, because
  // the qualification clause fires before the selection clause.
  const withoutSelection = await failureOf(() =>
    reviewer.run(
      { id: "case-9", input: { summary: "One summary." } },
      { mode: "enforcement" },
    ),
  );
  expect(withoutSelection.code).toBe("qualification_insufficient");
  const withSelection = await failureOf(() =>
    reviewer.run(
      { id: "case-9", input: { summary: "One summary." } },
      {
        mode: "enforcement",
        selectedProfileHash: (reviewer.profile as Profile).content_hash,
      },
    ),
  );
  expect(withSelection.code).toBe("qualification_insufficient");

  // The artifact holds no field that states one promotion, one selection,
  // or one authorization.
  const serialized = JSON.stringify(evaluation.report).toLowerCase();
  for (const forbidden of [
    "validated_for_scope",
    "selected",
    "authoriz",
    "approv",
    "promot",
  ]) {
    expect(serialized.includes(forbidden), `${forbidden} inside one report`).toBe(false);
  }

  // The fitting limit stays stated beside the artifact.
  expect(
    evaluation.limitations.some((one) => one.includes("Fitting results are not validation evidence")),
  ).toBe(true);
});

test("population limits stay visible beside the measured rates", async () => {
  const rows: readonly { note: string; kind: string; statement: string; prevalence: boolean }[] = [
    {
      note: "one development fixture states no prevalence",
      kind: "development_fixture",
      statement: "development_fixture",
      prevalence: false,
    },
    {
      note: "one synthetic challenge set states no prevalence",
      kind: "synthetic_challenge",
      statement: "targeted_challenge_set",
      prevalence: false,
    },
    {
      note: "one representative sample states one prevalence",
      kind: "representative_sample",
      statement: "representative_sample",
      prevalence: true,
    },
  ];
  for (const row of rows) {
    const bound = bind({ steps: [{ answer: SUPPORTED }, { answer: YES }] });
    const files = memoryFiles({
      "/datasets/metadata.json": metadata(row.kind),
      "/datasets/cases.jsonl": recordsFile([
        record("case-1", "The search index now refreshes nightly.", [], undefined),
      ]),
    });
    const evaluation = await bound.evaluateWith(mainDataset(), { files });
    expect(evaluation.population.statement, row.note).toBe(row.statement);
    expect(evaluation.population.states_prevalence, row.note).toBe(row.prevalence);
    expect(evaluation.population.supports_qualification, row.note).toBe(row.prevalence);
    const noPrevalence = evaluation.limitations.some((one) =>
      one.includes("states no production prevalence"),
    );
    expect(noPrevalence, row.note).toBe(!row.prevalence);
    // The label coverage stays visible whatever the population states,
    // because one unlabeled case states no reference for any metric.
    expect(rate(evaluation.report.metrics[0]!, "label_coverage").value).toBe(0);
  }
});

// ---------------------------------------------------------------------------
// The gates before any work.
// ---------------------------------------------------------------------------

test("one evaluation refuses its gates before any read and any run", async () => {
  const files = memoryFiles({});

  // One absent purpose and one unknown purpose refuse before any read.
  const registry = registerEvaluators(
    createScriptedEvaluator({ steps: [{ answer: SUPPORTED }, { answer: YES }] as never }),
  );
  const profile = createExplorationProfile(notes, registry);
  const bound = memoryFiles({ "/profile.json": JSON.stringify(profile) });
  const reviewer = await load(notes, {
    profile: "/profile.json",
    evaluators: registry,
    files: bound,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const missing = await failureOf(() =>
    evaluate(reviewer, {
      metadata: "/datasets/metadata.json",
      records: "/datasets/cases.jsonl",
      files,
    } as never),
  );
  expect(missing.code).toBe("missing_field");
  expect(missing.fieldPath).toBe("/purpose");
  const unknown = await failureOf(() =>
    evaluate(reviewer, {
      metadata: "/datasets/metadata.json",
      records: "/datasets/cases.jsonl",
      purpose: "accuracy_check",
      files,
    } as never),
  );
  expect(unknown.code).toBe("invalid_field_type");
  expect(unknown.fieldPath).toBe("/purpose");
  expect(files.reads).toEqual([]);

  // One reviewer without one bound profile refuses before any read, because
  // no policy states how one answer decides.
  const unbound = await load(notes, {
    files,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const unboundFailure = await failureOf(() =>
    evaluate(unbound, {
      metadata: "/datasets/metadata.json",
      records: "/datasets/cases.jsonl",
      purpose: "exploration",
      files,
    }),
  );
  expect(unboundFailure.code).toBe("evaluator_mismatch");
  expect(unboundFailure.fieldPath).toBe("/profile");
  expect(files.reads).toEqual([]);

  // One wrong path format refuses with the loader reason code.
  const wrongFormat = await failureOf(() =>
    evaluate(reviewer, {
      metadata: "/datasets/metadata.yaml",
      records: "/datasets/cases.jsonl",
      purpose: "exploration",
      files,
    }),
  );
  expect(wrongFormat.code).toBe("unsupported_format");
  expect(wrongFormat.fieldPath).toBe("/metadata");

  // One dataset whose records break the definition refuses with the line
  // and the field of the record, before any case runs.
  const brokenFiles = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      JSON.stringify({
        id: "case-1",
        group: "notes",
        input: { summary: 7 },
        label: { author_type: "human", reviewed: false },
      }),
    ]),
  });
  const broken = await failureOf(() =>
    evaluate(reviewer, {
      metadata: "/datasets/metadata.json",
      records: "/datasets/cases.jsonl",
      purpose: "exploration",
      files: brokenFiles,
    }),
  );
  expect(broken.code).toBe("invalid_field_type");
  expect(broken.fieldPath).toBe("/records/1/input/summary");
});

// ---------------------------------------------------------------------------
// The uncertainty intervals of the measured rates.
// ---------------------------------------------------------------------------

/** One case record of the interval tests, with its own stated group. */
function groupedRecord(
  id: string,
  group: string,
  summary: string,
  tags: readonly string[],
  expected: unknown,
): string {
  return JSON.stringify({
    id,
    group,
    input: { summary },
    label: { author_type: "human", reviewed: true, reviewer: "reviewer-1" },
    ...(tags.length > 0 ? { tags } : {}),
    ...(expected === undefined ? {} : { expected }),
  });
}

/** The reference labels of one interval case: every check states pass. */
function allPass(): unknown {
  return {
    checks: {
      "summary-supported": { answer: "supported" },
      "change-customer-visible": { answer: "yes" },
      "summary-free-of-todos": { outcome: "pass" },
    },
    outcome: "pass",
  };
}

test("one evaluation computes the intervals of every scope and slice", async () => {
  // Four cases of four distinct groups, so every denominator holds one case
  // per group and the independent model applies.
  const bound = bind({
    steps: [
      // case-1: supported, yes.
      { answer: SUPPORTED },
      { answer: YES },
      // case-2: supported, yes.
      { answer: SUPPORTED },
      { answer: YES },
      // case-3: incomplete review label, yes.
      { answer: INCOMPLETE },
      { answer: YES },
      // case-4: supported, yes.
      { answer: SUPPORTED },
      { answer: YES },
    ],
  });
  const files = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      // One reference fail predicted pass on the categorical check.
      groupedRecord(
        "case-1",
        "thread-1",
        "The search index now refreshes nightly.",
        ["dates"],
        {
          checks: {
            "summary-supported": { answer: "contradicted" },
            "change-customer-visible": { answer: "yes" },
            "summary-free-of-todos": { outcome: "pass" },
          },
          outcome: "fail",
        },
      ),
      // One reference fail predicted pass on the binary check.
      groupedRecord(
        "case-2",
        "thread-2",
        "The export worker moves data.",
        ["dates"],
        {
          checks: {
            "summary-supported": { answer: "supported" },
            "change-customer-visible": { answer: "no" },
            "summary-free-of-todos": { outcome: "pass" },
          },
          outcome: "fail",
        },
      ),
      // One predicted review on the categorical check.
      groupedRecord(
        "case-3",
        "thread-3",
        "One claim names no evidence.",
        ["limits"],
        allPass(),
      ),
      // One reference fail predicted pass on the exact rule.
      groupedRecord(
        "case-4",
        "thread-4",
        "The search index TODO refreshes nightly.",
        ["limits"],
        {
          checks: {
            "summary-supported": { answer: "supported" },
            "change-customer-visible": { answer: "yes" },
            "summary-free-of-todos": { outcome: "fail" },
          },
          outcome: "fail",
        },
      ),
    ]),
  });
  const evaluation = await bound.evaluateWith(mainDataset(), {
    files,
    intervals: {
      sampling: "independent_cases",
      confidence_level: 0.95,
      minimum_samples: 3,
    },
  });

  // The interval report states its method, its level, its sampling model,
  // its assumption, and its minimum evidence.
  const intervals = evaluation.intervals;
  expect(intervals).toBeDefined();
  expect(intervals?.method).toBe("wilson_score");
  expect(intervals?.confidence_level).toBe(0.95);
  expect(intervals?.sampling).toBe("independent_cases");
  expect(intervals?.minimum_samples).toBe(3);
  expect(intervals?.assumption).toContain("independent draw");
  expect(intervals?.method_statement).toContain("Wilson score intervals at 95 percent");
  expect(intervals?.method_statement).toContain("Zero observed errors is not proof of zero risk");
  // One set per check plus the complete check set, one row per metric.
  expect(intervals?.scopes.map((set) => set.scope)).toEqual([
    "summary-supported",
    "change-customer-visible",
    "summary-free-of-todos",
    "all_checks",
  ]);
  for (const set of intervals?.scopes ?? []) {
    expect(set.intervals.map((row) => row.metric)).toEqual([
      "false_acceptance_rate",
      "error_among_accepted",
      "false_rejection_rate",
      "review_rate",
      "automatic_coverage",
      "label_coverage",
    ]);
  }

  // The categorical check. Zero observed rejections among three reference
  // pass cases still state one upper bound above zero, against the bound of
  // one independent implementation of the documented formula.
  const question = intervals?.scopes[0];
  const rejection = question?.intervals.find(
    (row) => row.metric === "false_rejection_rate",
  );
  expect(rejection).toMatchObject({
    scope: "summary-supported",
    method: "wilson_score",
    confidence_level: 0.95,
    sampling: "independent_cases",
    numerator: 0,
    denominator: 3,
    draws: 3,
    event_draws: 0,
    reason: null,
  });
  expect(Math.abs(rejection!.lower!)).toBeLessThan(1e-12);
  expect(rejection!.upper!).toBeCloseTo(0.5614970317550456, 12);

  // One denominator below the declared minimum states insufficient evidence
  // with its counts: the one reference fail case alone holds no interval.
  const acceptance = question?.intervals.find(
    (row) => row.metric === "false_acceptance_rate",
  );
  expect(acceptance).toMatchObject({
    numerator: 1,
    denominator: 1,
    draws: 1,
    event_draws: 1,
    lower: null,
    upper: null,
    reason: "insufficient_evidence",
  });

  // The same numerator over the labeled predicted passes holds three draws.
  const accepted = question?.intervals.find(
    (row) => row.metric === "error_among_accepted",
  );
  expect(accepted).toMatchObject({
    numerator: 1,
    denominator: 3,
    draws: 3,
    event_draws: 1,
    reason: null,
  });
  expect(accepted!.upper!).toBeCloseTo(0.7923403991979523, 12);

  // Every slice states its own rows: the dates slice holds one reference
  // pass case of the categorical check, below the minimum.
  const dates = intervals?.slices.find((slice) => slice.tag === "dates");
  const datesRejection = dates?.scopes
    .find((set) => set.scope === "summary-supported")
    ?.intervals.find((row) => row.metric === "false_rejection_rate");
  expect(datesRejection).toMatchObject({
    numerator: 0,
    denominator: 1,
    draws: 1,
    reason: "insufficient_evidence",
  });

  // The artifact cites the method statement, the rows stay beside it, and
  // the assumption joins the standing limitations.
  expect(evaluation.report.method).toBe(intervals?.method_statement);
  expect(evaluation.limitations).toContain(intervals?.assumption);
  expect(Object.isFrozen(intervals?.scopes)).toBe(true);
  expect(Object.isFrozen(intervals?.slices)).toBe(true);
});

test("one repeated group states unsupported sampling, not one bound", async () => {
  // Two cases of one group sit in every denominator, so the independent
  // model breaks. The binary check of the same cases keeps one reference
  // pass case per group, so its false rejection rate still holds one bound.
  const labels = {
    checks: {
      "summary-supported": { answer: "contradicted" },
      "change-customer-visible": { answer: "yes" },
      "summary-free-of-todos": { outcome: "pass" },
    },
    outcome: "fail",
  };
  const bound = bind({
    steps: [
      // The independent run and the grouped run read the same three cases,
      // so the scripted evaluator holds one answer pair per case per run.
      { answer: SUPPORTED },
      { answer: YES },
      { answer: SUPPORTED },
      { answer: YES },
      { answer: SUPPORTED },
      { answer: YES },
      { answer: SUPPORTED },
      { answer: YES },
      { answer: SUPPORTED },
      { answer: YES },
      { answer: SUPPORTED },
      { answer: YES },
    ],
  });
  const files = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      groupedRecord(
        "case-1",
        "thread-shared",
        "The search index now refreshes nightly.",
        [],
        labels,
      ),
      groupedRecord(
        "case-2",
        "thread-shared",
        "The export worker moves data.",
        [],
        labels,
      ),
      groupedRecord(
        "case-3",
        "thread-alone",
        "One claim names no evidence.",
        [],
        allPass(),
      ),
    ]),
  });
  const evaluation = await bound.evaluateWith(mainDataset(), {
    files,
    intervals: {
      sampling: "independent_cases",
      confidence_level: 0.9,
      minimum_samples: 1,
    },
  });
  const question = evaluation.intervals?.scopes[0];
  // The false acceptance denominator holds both cases of the shared group.
  expect(
    question?.intervals.find((row) => row.metric === "false_acceptance_rate"),
  ).toMatchObject({
    numerator: 2,
    denominator: 2,
    draws: 2,
    lower: null,
    upper: null,
    reason: "unsupported_sampling",
  });
  // Every denominator that counts every case breaks too.
  expect(
    question?.intervals.find((row) => row.metric === "label_coverage"),
  ).toMatchObject({ reason: "unsupported_sampling" });
  // The false rejection rate counts reference pass cases alone: one case of
  // one group, with one bound.
  expect(
    question?.intervals.find((row) => row.metric === "false_rejection_rate"),
  ).toMatchObject({
    numerator: 0,
    denominator: 1,
    draws: 1,
    reason: null,
  });

  // The grouped model makes the group the draw: the two reference fail
  // cases of the shared group become one draw with one event.
  const grouped = await bound.evaluateWith(mainDataset(), {
    files,
    intervals: {
      sampling: "grouped_cases",
      confidence_level: 0.9,
      minimum_samples: 1,
    },
  });
  const groupedQuestion = grouped.intervals?.scopes[0];
  expect(
    groupedQuestion?.intervals.find((row) => row.metric === "false_acceptance_rate"),
  ).toMatchObject({
    numerator: 2,
    denominator: 2,
    draws: 1,
    event_draws: 1,
    reason: null,
  });
  expect(grouped.intervals?.assumption).toContain("The group is the draw");
  expect(grouped.report.method).toBe(grouped.intervals?.method_statement);
});

test("one evaluation without an interval request states no interval field", async () => {
  const bound = bind({ steps: [{ answer: SUPPORTED }, { answer: YES }] });
  const files = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      record("case-1", "The search index now refreshes nightly.", [], allPass()),
    ]),
  });
  const evaluation = await bound.evaluateWith(mainDataset(), { files });
  expect(evaluation.intervals).toBeUndefined();
  expect("method" in evaluation.report).toBe(false);
});

test("one broken interval request refuses before any read and any run", async () => {
  const files = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      record("case-1", "The search index now refreshes nightly.", [], allPass()),
    ]),
  });
  const rows: readonly {
    note: string;
    request: Record<string, unknown>;
    code: string;
    path: string;
  }[] = [
    {
      note: "one unsupported confidence level",
      request: {
        sampling: "independent_cases",
        confidence_level: 0.8,
        minimum_samples: 30,
      },
      code: "invalid_field_type",
      path: "/confidence_level",
    },
    {
      note: "one unsupported sampling word",
      request: { sampling: "bootstrap", confidence_level: 0.95, minimum_samples: 30 },
      code: "unsupported_sampling",
      path: "/sampling",
    },
    {
      note: "one minimum of zero draws",
      request: { sampling: "grouped_cases", confidence_level: 0.95, minimum_samples: 0 },
      code: "invalid_field_type",
      path: "/minimum_samples",
    },
    {
      note: "one request field outside the contract",
      request: {
        sampling: "grouped_cases",
        confidence_level: 0.95,
        minimum_samples: 30,
        stratified: true,
      },
      code: "unknown_field",
      path: "/stratified",
    },
  ];
  for (const row of rows) {
    const bound = bind({ steps: [{ answer: SUPPORTED }, { answer: YES }] });
    const failure = await failureOf(() =>
      bound.evaluateWith(mainDataset(), {
        files,
        intervals: row.request as never,
      }),
    );
    expect(failure.code, row.note).toBe(row.code);
    expect(failure.fieldPath, row.note).toBe(row.path);
    // The refusal crosses before any read and before any case runs.
    expect(bound.calls, row.note).toEqual([]);
    expect(files.reads, row.note).toEqual([]);
  }
});

test("the evaluation report artifact keeps the frozen contract shape", async () => {
  // The report is plain JSON data whose keys are exactly the declared
  // properties of the frozen schema, with no extra field.
  // The schema is trusted repo data, so one broad value type is enough.
  const schema = JSON.parse(
    readFileSync(path.join(repoRoot, "contracts", "v0", "evaluation-report.schema.json"), "utf8"),
  ) as any;
  const declared = new Set(Object.keys(schema.properties));
  const caseDeclared = new Set(Object.keys(schema.properties.cases.items.properties));

  const bound = bind({ steps: [{ answer: SUPPORTED }, { answer: YES }] });
  const files = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      record(
        "case-1",
        "The search index now refreshes nightly.",
        ["dates"],
        {
          checks: {
            "summary-supported": { answer: "supported" },
            "change-customer-visible": { answer: "yes" },
            "summary-free-of-todos": { outcome: "pass" },
          },
          outcome: "pass",
        },
      ),
    ]),
  });
  const evaluation = await bound.evaluateWith(mainDataset(), { files });
  const artifact = JSON.parse(JSON.stringify(evaluation.report)) as Record<string, unknown>;
  for (const key of Object.keys(artifact)) {
    expect(declared.has(key), `the artifact states the undeclared field ${key}`).toBe(true);
  }
  for (const one of artifact.cases as Record<string, unknown>[]) {
    for (const key of Object.keys(one)) {
      expect(caseDeclared.has(key), `one case states the undeclared field ${key}`).toBe(true);
    }
  }
  // The serialized wrapper value holds the artifact beside the run reports,
  // and the artifact alone holds no case content and no raw input.
  const artifactText = JSON.stringify(evaluation.report);
  expect(artifactText).not.toContain("The search index now refreshes nightly.");
  expect(evaluation.runs[0]).toBeDefined();
  expect(Object.isFrozen(evaluation.report)).toBe(true);
  expect(Object.isFrozen(evaluation.runs)).toBe(true);
  expect(Object.isFrozen(evaluation.limitations)).toBe(true);
});

test("one exact-only definition evaluates its records with no evaluator", async () => {
  const rules = defineChecks({
    version: 1,
    name: "evaluate-delivery-limits",
    inputs: Type.Object(
      { summary: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    checks: [
      {
        id: "summary-length",
        name: "The summary fits the delivery limit",
        using: ["summary"],
        rule: { maxLength: 40 },
      },
    ],
  });
  const files = memoryFiles({
    "/datasets/metadata.json": metadata("development_fixture"),
    "/datasets/cases.jsonl": recordsFile([
      record(
        "case-1",
        "The delivery limit is 900 characters.",
        [],
        { checks: { "summary-length": { outcome: "pass" } }, outcome: "pass" },
      ),
      record(
        "case-2",
        "The delivery limit is 900 characters and this summary exceeds it.",
        [],
        { checks: { "summary-length": { outcome: "pass" } }, outcome: "pass" },
      ),
    ]),
  });
  const reviewer = await load(rules, {
    files,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const evaluation = await evaluate(reviewer, {
    metadata: "/datasets/metadata.json",
    records: "/datasets/cases.jsonl",
    purpose: "exploration",
    files,
  });
  expect(evaluation.report.cases.map((one) => one.outcomes["summary-length"])).toEqual([
    "pass",
    "fail",
  ]);
  expect(evaluation.report.cases.map((one) => one.reference_match)).toEqual([
    { "summary-length": true },
    { "summary-length": false },
  ]);
  // One metric set per check plus the complete set, with one false
  // rejection among two reference passes.
  expect(evaluation.report.metrics.map((set) => set.scope)).toEqual([
    "summary-length",
    "all_checks",
  ]);
  expect(
    rate(evaluation.report.metrics[0]!, "false_rejection_rate"),
  ).toEqual({
    metric: "false_rejection_rate",
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });
  // The derived exact profile of one exact-only definition evaluates
  // without one registered evaluator and without one evaluator call.
  expect(evaluation.runs.every((run) => run.checks.every((check) => check.evaluator === undefined))).toBe(true);

  // The evaluation selected nothing for the host: the structurally
  // validated exact profile still needs one selected reviewed hash before
  // one enforced run starts.
  const selection = reviewer.profile?.content_hash;
  expect(selection).toBeDefined();
  const enforced = await failureOf(() =>
    reviewer.run(
      { id: "case-9", input: { summary: "One summary." } },
      { mode: "enforcement" },
    ),
  );
  expect(enforced.code).toBe("profile_not_selected");
  expect(enforced.fieldPath).toBe("/profile/content_hash");
});
