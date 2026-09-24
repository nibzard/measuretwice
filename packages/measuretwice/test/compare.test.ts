// SPDX-License-Identifier: Apache-2.0
/**
 * Compare API tests.
 *
 * These tests cover task T046: one comparison matches two stored
 * evaluation reports on equal case identifiers and equal input hashes,
 * and the Rust core owns the matching, the changed cases, and the metric
 * rows with their counts and their denominators. The tests pin the
 * matching rule with changed input hashes and missing cases, the errored
 * and the skipped matched cases, the changed component and aggregate
 * outcomes, the evidence class that separates fitting comparisons from
 * independent validation evidence, the cost tradeoff that appears only
 * when the recorded usage and the declared cost inputs support it, and
 * the refusals that keep one edited or foreign report out. The adapter
 * is the scripted test evaluator, so the tests stay offline and
 * deterministic.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import {
  compare,
  createExplorationProfile,
  createScriptedEvaluator,
  defineChecks,
  evaluate,
  load,
  registerEvaluators,
  ValidationError,
  type Definition,
  type Evaluation,
  type EvaluationPurpose,
  type EvaluationReport,
  type Evaluator,
  type EvaluatorRequest,
  type ExecutionConfig,
  type FileAccess,
} from "../src/index.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

/** The fixed start time of every test evaluation: 24 September 2026, UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/**
 * One definition with one categorical question that carries one review
 * label, one binary question, and one exact rule, so one comparison
 * reaches every metric row.
 */
const notes = defineChecks({
  version: 1,
  name: "compare-release-notes",
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

/** One passing categorical answer with usage and latency. */
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

/** One failing categorical answer with one usage key of its own. */
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
  usage: { input_tokens: 900, requests: 2 },
  latency_ms: 210,
};

/** One passing binary answer. */
const YES = {
  assessment: { kind: "binary" as const, value: true },
  model_resolved: "scripted-1.4.0",
};

/** One failing binary answer. */
const NO = {
  assessment: { kind: "binary" as const, value: false },
  model_resolved: "scripted-1.4.0",
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

/** Builds one dataset metadata artifact. */
function metadata(): string {
  return JSON.stringify({
    schema_version: 1,
    id: "compare-cases",
    name: "Comparison cases",
    revision: "2026-09-24.1",
    kind: "development_fixture",
    intended_population: "Release note summaries of one product area.",
    sampling_method: "Selected from reviewed development work. No prevalence claim.",
    label_guidelines: "See docs/labeling.md revision 3.",
    languages: ["en"],
    splits: [{ id: "all", purpose: "fitting", groups: ["notes"] }],
  });
}

/** Builds one case record of the tests. */
function record(id: string, summary: string, expected: unknown): string {
  return JSON.stringify({
    id,
    group: "notes",
    input: { summary },
    label: { author_type: "human", reviewed: true, reviewer: "reviewer-1" },
    expected,
  });
}

/** One reference pass on every check, with one stated overall outcome. */
function passLabels(): unknown {
  return {
    checks: {
      "summary-supported": { answer: "supported" },
      "change-customer-visible": { answer: "yes" },
      "summary-free-of-todos": { outcome: "pass" },
    },
    outcome: "pass",
  };
}

/** One reference review on the question check alone. */
function reviewLabels(): unknown {
  return {
    checks: {
      "summary-supported": { review: true },
      "change-customer-visible": { answer: "yes" },
      "summary-free-of-todos": { outcome: "pass" },
    },
    outcome: "review",
  };
}

/** The default records of the tests: two reference passes and one review. */
function defaultRecords(): string {
  return [
    record("case-1", "The search index now refreshes nightly.", passLabels()),
    record("case-2", "The export worker moves data nightly.", passLabels()),
    record("case-3", "One claim names no evidence.", reviewLabels()),
  ].join("\n");
}

/** The options of one evaluation of the tests. */
interface EvaluateWith {
  readonly evaluator?: Evaluator;
  readonly evaluatorId?: string;
  readonly execution?: Partial<ExecutionConfig>;
  readonly purpose?: EvaluationPurpose;
  readonly records?: string;
  readonly definition?: Definition;
  readonly definitionName?: string;
}

/** The metadata and records paths of one evaluation. */
const DATASET = { metadata: "/datasets/metadata.json", records: "/datasets/cases.jsonl" };

/** Runs one evaluation over the stated records with the stated steps. */
async function evaluateWith(options: EvaluateWith & { readonly steps?: readonly unknown[] }): Promise<Evaluation> {
  const clock = new FakeClock(START_MS);
  const evaluator =
    options.evaluator ??
    createScriptedEvaluator({
      ...(options.evaluatorId === undefined ? {} : { id: options.evaluatorId }),
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
  const registry = registerEvaluators(evaluator);
  const definition = options.definition ?? notes;
  const profile = createExplorationProfile(definition, registry, {
    ...(options.execution === undefined ? {} : { execution: options.execution }),
  });
  const files = memoryFiles({
    "/profile.json": JSON.stringify(profile),
    "/datasets/metadata.json": metadata(),
    "/datasets/cases.jsonl": options.records ?? defaultRecords(),
  });
  const reviewer = await load(definition, {
    profile: "/profile.json",
    evaluators: registry,
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
  });
  return evaluate(reviewer, {
    metadata: DATASET.metadata,
    records: DATASET.records,
    purpose: options.purpose ?? "independent_validation",
    files,
  });
}

/** One metric row of a comparison, with both stored rates. */
interface Row {
  readonly scope: string;
  readonly metric: string;
  readonly baseline: { readonly metric: string; readonly numerator: number; readonly denominator: number; readonly value: number | null };
  readonly candidate: { readonly metric: string; readonly numerator: number; readonly denominator: number; readonly value: number | null };
}

/** Returns the metric row of one scope and one metric. */
function row(comparison: { metrics: readonly { scope: string; metric: string }[] }, scope: string, metric: string): Row {
  const found = comparison.metrics.find(
    (entry) => entry.scope === scope && entry.metric === metric,
  );
  if (found === undefined) {
    throw new Error(`the comparison states no ${metric} row for ${scope}`);
  }
  return found as Row;
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

/** Lets the load and run chain of the blocking evaluator settle. */
async function flush(): Promise<void> {
  for (let index = 0; index < 16; index += 1) {
    await Promise.resolve();
  }
}

/** The references of the two stored reports of the tests. */
const REFS = {
  baselineReport: ".measuretwice/reports/baseline.json",
  candidateReport: ".measuretwice/reports/candidate.json",
};

test("one comparison matches cases on equal identifiers and equal input hashes", async () => {
  // The baseline passes every case. The candidate fails the question
  // check of case-1 and the binary check of case-2, and leaves case-3.
  const baseline = await evaluateWith({
    evaluatorId: "baseline-evaluator",
    steps: [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });
  const candidate = await evaluateWith({
    evaluatorId: "candidate-evaluator",
    steps: [CONTRADICTED, YES, SUPPORTED, NO, SUPPORTED, YES],
  });
  const comparison = compare(baseline.report, candidate.report, REFS);

  // The artifact states the two report sets with the stored references.
  const report = comparison.report;
  expect(report.schema_version).toBe(1);
  expect(report.baseline).toEqual({
    profile: {
      id: expect.any(String),
      content_hash: baseline.report.profile.content_hash,
    },
    report: REFS.baselineReport,
  });
  expect(report.candidate).toEqual({
    profile: {
      id: expect.any(String),
      content_hash: candidate.report.profile.content_hash,
    },
    report: REFS.candidateReport,
  });
  expect(report.baseline.profile.content_hash).not.toBe(
    report.candidate.profile.content_hash,
  );

  // Every case matches: three identifiers, three equal input hashes.
  expect(report.matching).toEqual({
    matched_cases: 3,
    changed_input_cases: [],
    missing_in_candidate: [],
    missing_in_baseline: [],
    errored_cases: [],
    skipped_cases: [],
  });

  // The changed cases state their changed checks and both aggregates.
  expect(report.changed).toEqual([
    {
      id: "case-1",
      checks: [
        { check: "summary-supported", baseline: "pass", candidate: "fail" },
      ],
      baseline_aggregate: "pass",
      candidate_aggregate: "fail",
    },
    {
      id: "case-2",
      checks: [
        { check: "change-customer-visible", baseline: "pass", candidate: "fail" },
      ],
      baseline_aggregate: "pass",
      candidate_aggregate: "fail",
    },
  ]);

  // The metric rows keep the counts and the denominators of both sides.
  const rejection = row(comparison, "summary-supported", "false_rejection_rate");
  expect(rejection.baseline).toEqual({ metric: "false_rejection_rate", numerator: 0, denominator: 2, value: 0 });
  expect(rejection.candidate).toEqual({ metric: "false_rejection_rate", numerator: 1, denominator: 2, value: 0.5 });
  // Two values with different denominators cover different case sets.
  const accepted = row(comparison, "summary-supported", "error_among_accepted");
  expect(accepted.baseline).toEqual({ metric: "error_among_accepted", numerator: 1, denominator: 3, value: 1 / 3 });
  expect(accepted.candidate).toEqual({ metric: "error_among_accepted", numerator: 1, denominator: 2, value: 0.5 });
  // One row per scope and metric: three checks plus the complete set.
  expect(comparison.metrics).toHaveLength(24);
  expect(comparison.metrics.slice(0, 6).map((entry) => entry.scope)).toEqual(
    Array.from({ length: 6 }, () => "summary-supported"),
  );

  // The artifact tradeoffs state the two values beside each other.
  const tradeoff = report.tradeoffs.metrics.find(
    (entry) => entry.scope === "summary-supported" && entry.metric === "false_rejection_rate",
  );
  expect(tradeoff).toEqual({
    scope: "summary-supported",
    metric: "false_rejection_rate",
    baseline_value: 0,
    candidate_value: 0.5,
  });

  // The limitations state the denominator rule and the standing fact that
  // changed evaluator behavior needs new measurements.
  expect(comparison.limitations.length).toBeGreaterThanOrEqual(3);
  expect(comparison.limitations).toContainEqual(
    expect.stringContaining("New measurements are required"),
  );
});

test("one changed input hash never matches and the case needs new measurements", async () => {
  // The candidate dataset rewrote the input of case-2, so its hash
  // differs although its identifier agrees.
  const rewritten = [
    record("case-1", "The search index now refreshes nightly.", passLabels()),
    record("case-2", "The export worker moved data on one new schedule.", passLabels()),
    record("case-3", "One claim names no evidence.", reviewLabels()),
  ].join("\n");
  const baseline = await evaluateWith({
    steps: [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });
  const candidate = await evaluateWith({
    records: rewritten,
    steps: [CONTRADICTED, YES, CONTRADICTED, YES, SUPPORTED, YES],
  });
  const comparison = compare(baseline.report, candidate.report, REFS);

  expect(comparison.report.matching.matched_cases).toBe(2);
  expect(comparison.report.matching.changed_input_cases).toEqual(["case-2"]);
  // The changed input case appears under no changed entry, whatever its
  // outcomes state.
  expect(comparison.report.changed.map((entry) => entry.id)).toEqual(["case-1"]);
  // The limitation requires new measurements for the changed input.
  expect(comparison.limitations).toContainEqual(
    expect.stringContaining("1 case of the two reports holds one changed input hash"),
  );
});

test("one case that one report omits stays listed on its side", async () => {
  // The candidate omits case-3 and adds case-4.
  const renumbered = [
    record("case-1", "The search index now refreshes nightly.", passLabels()),
    record("case-2", "The export worker moves data nightly.", passLabels()),
    record("case-4", "The cache serves one new region.", passLabels()),
  ].join("\n");
  const baseline = await evaluateWith({
    steps: [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });
  const candidate = await evaluateWith({
    records: renumbered,
    steps: [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });
  const comparison = compare(baseline.report, candidate.report, REFS);

  expect(comparison.report.matching).toMatchObject({
    matched_cases: 2,
    missing_in_candidate: ["case-3"],
    missing_in_baseline: ["case-4"],
  });
  expect(comparison.report.changed).toEqual([]);
  expect(comparison.limitations).toContainEqual(
    expect.stringContaining("omits 1 case of the baseline"),
  );
});

test("errored and skipped matched cases stay listed and decided nothing", async () => {
  // The baseline loses both question checks of case-2 to provider
  // errors, and the candidate resolves them.
  const failures = [
    SUPPORTED,
    YES,
    { failure: { code: "evaluator_timeout", message: "The first attempt timed out." } },
    { failure: { code: "evaluator_timeout", message: "The first attempt timed out." } },
    { failure: { code: "evaluator_timeout", message: "The retry timed out." } },
    { failure: { code: "evaluator_timeout", message: "The retry timed out." } },
    SUPPORTED,
    YES,
  ];
  const baseline = await evaluateWith({
    execution: { max_attempts: 2, backoff_ms: 0 },
    steps: failures,
  });
  expect(baseline.report.cases[1]?.aggregate).toBe("error");
  const candidate = await evaluateWith({
    steps: [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });
  const errored = compare(baseline.report, candidate.report, REFS);

  expect(errored.report.matching.matched_cases).toBe(3);
  expect(errored.report.matching.errored_cases).toEqual(["case-2"]);
  expect(errored.report.matching.skipped_cases).toEqual([]);
  // The error changed into one pass, so the case appears under changed.
  expect(errored.report.changed.map((entry) => entry.id)).toEqual(["case-2"]);
  expect(errored.limitations).toContainEqual(
    expect.stringContaining("one error outcome"),
  );

  // One evaluator whose first answer waits for one manual release, with
  // one active slot and no pending slot, skips the other checks.
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
  const baselinePromise = evaluateWith({
    evaluator: blocking,
    execution: { max_active: 1, max_pending: 0 },
    records: [record("case-1", "The search index now refreshes nightly.", passLabels())].join("\n"),
  });
  await flush();
  expect(calls).toHaveLength(1);
  waiting.shift()?.();
  const skippedBaseline = await baselinePromise;
  expect(skippedBaseline.report.cases[0]?.outcomes).toEqual({
    "summary-supported": "pass",
    "change-customer-visible": "skipped",
    "summary-free-of-todos": "skipped",
  });
  const resolvedCandidate = await evaluateWith({
    records: [record("case-1", "The search index now refreshes nightly.", passLabels())].join("\n"),
    steps: [SUPPORTED, YES],
  });
  const skipped = compare(skippedBaseline.report, resolvedCandidate.report, REFS);
  expect(skipped.report.matching.matched_cases).toBe(1);
  expect(skipped.report.matching.skipped_cases).toEqual(["case-1"]);
  expect(skipped.report.changed.map((entry) => entry.id)).toEqual(["case-1"]);
  expect(skipped.limitations).toContainEqual(
    expect.stringContaining("one skipped outcome"),
  );
});

test("one fitting declared purpose makes the whole comparison fitting", async () => {
  const steps = [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES];
  const fittingBaseline = await evaluateWith({ purpose: "fitting", steps });
  const validationBaseline = await evaluateWith({ purpose: "independent_validation", steps });
  const validationCandidate = await evaluateWith({
    evaluatorId: "candidate-evaluator",
    purpose: "independent_validation",
    steps,
  });
  const explorationCandidate = await evaluateWith({
    evaluatorId: "candidate-evaluator",
    purpose: "exploration",
    steps,
  });

  // Two independent validations state one comparison of that class.
  const validation = compare(
    validationBaseline.report,
    validationCandidate.report,
    REFS,
  );
  expect(validation.report.evidence_class).toBe("independent_validation");
  expect(validation.limitations).toContainEqual(
    expect.stringContaining("Both reports declared independent_validation."),
  );

  // One fitting evaluation beside one validation makes the comparison
  // fitting evidence that supports no validation claim.
  const mixed = compare(fittingBaseline.report, validationCandidate.report, REFS);
  expect(mixed.report.evidence_class).toBe("fitting");
  const explored = compare(validationBaseline.report, explorationCandidate.report, REFS);
  expect(explored.report.evidence_class).toBe("fitting");
  for (const comparison of [mixed, explored]) {
    expect(comparison.limitations).toContainEqual(
      expect.stringContaining("This comparison is fitting evidence."),
    );
  }
});

test("usage and cost appear only when recorded data and declared costs support them", async () => {
  // The baseline records input and output tokens on every case. The
  // candidate adds one `requests` key on case-1 that no cost covers.
  const baseline = await evaluateWith({
    evaluatorId: "baseline-evaluator",
    steps: [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });
  expect(baseline.report.operational?.usage).toEqual({
    input_tokens: 3600,
    output_tokens: 120,
  });
  const candidate = await evaluateWith({
    evaluatorId: "candidate-evaluator",
    steps: [CONTRADICTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });
  expect(candidate.report.operational?.usage).toEqual({
    input_tokens: 3300,
    output_tokens: 80,
    requests: 2,
  });

  // Without declared costs no cost appears, and the usage still states
  // both sides.
  const bare = compare(baseline.report, candidate.report, REFS);
  expect(bare.report.tradeoffs.cost).toBeUndefined();
  expect(bare.report.tradeoffs.usage).toEqual({
    baseline: { input_tokens: 3600, output_tokens: 120 },
    candidate: { input_tokens: 3300, output_tokens: 80, requests: 2 },
  });

  // The declared costs cover the baseline records alone. The candidate
  // holds one uncovered key, so its cost stays absent and one limitation
  // names the fact.
  const priced = compare(baseline.report, candidate.report, {
    ...REFS,
    costs: { input_tokens: 0.001, output_tokens: 0.002 },
  });
  expect(priced.report.tradeoffs.cost?.baseline).toBeCloseTo(3.84, 10);
  expect(Object.keys(priced.report.tradeoffs.cost ?? {})).toEqual(["baseline"]);
  expect(priced.limitations).toContainEqual(
    expect.stringContaining("declared costs do not cover"),
  );

  // One cost input that covers every recorded key prices both sides.
  const covered = compare(baseline.report, candidate.report, {
    ...REFS,
    costs: { input_tokens: 0.001, output_tokens: 0.002, requests: 0.5 },
  });
  expect(covered.report.tradeoffs.cost?.baseline).toBeCloseTo(3.84, 10);
  expect(covered.report.tradeoffs.cost?.candidate).toBeCloseTo(4.46, 10);
});

test("one comparison refuses its gates, foreign definitions, and edited reports", async () => {
  const baseline = await evaluateWith({
    evaluatorId: "baseline-evaluator",
    steps: [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });
  const candidate = await evaluateWith({
    evaluatorId: "candidate-evaluator",
    steps: [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });

  // One evaluation of another definition, and one over rewritten inputs
  // that share no case with the baseline.
  const otherNotes = defineChecks({
    version: 1,
    name: "compare-other-notes",
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
    ],
  });
  const foreign = await evaluateWith({
    definition: otherNotes,
    records: [
      record("case-1", "The search index now refreshes nightly.", {
        checks: { "summary-supported": { answer: "supported" } },
      }),
      record("case-2", "The export worker moves data nightly.", {
        checks: { "summary-supported": { answer: "supported" } },
      }),
      record("case-3", "One claim names no evidence.", {
        checks: { "summary-supported": { review: true } },
      }),
    ].join("\n"),
    steps: [SUPPORTED, SUPPORTED, SUPPORTED],
  });
  const disjoint = await evaluateWith({
    records: [
      record("case-1", "One rewritten summary.", passLabels()),
      record("case-2", "Another rewritten summary.", passLabels()),
      record("case-3", "One more rewritten summary.", reviewLabels()),
    ].join("\n"),
    steps: [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });

  // The gates fire before any parse.
  const rows: readonly { note: string; operation: () => unknown; code: string; path: string }[] = [
    {
      note: "no baseline report reference",
      operation: () =>
        compare(baseline.report, candidate.report, {
          candidateReport: REFS.candidateReport,
        } as never),
      code: "missing_field",
      path: "/baselineReport",
    },
    {
      note: "no candidate report reference",
      operation: () =>
        compare(baseline.report, candidate.report, {
          baselineReport: REFS.baselineReport,
        } as never),
      code: "missing_field",
      path: "/candidateReport",
    },
    {
      note: "one negative cost",
      operation: () =>
        compare(baseline.report, candidate.report, {
          ...REFS,
          costs: { input_tokens: -1 },
        }),
      code: "invalid_field_type",
      path: "/costs/input_tokens",
    },
    {
      note: "one report of another definition",
      operation: () => compare(baseline.report, foreign.report, REFS),
      code: "definition_mismatch",
      path: "/candidate/definition/content_hash",
    },
    {
      note: "no case matches because every input changed",
      operation: () => compare(baseline.report, disjoint.report, REFS),
      code: "insufficient_evidence",
      path: "/matching",
    },
    {
      note: "one edited stored report fails under its own side",
      operation: () => {
        const edited = structuredClone(
          candidate.report as unknown as Record<string, unknown>,
        ) as unknown as EvaluationReport;
        (edited.cases[0] as { aggregate: string }).aggregate = "review";
        return compare(baseline.report, edited, REFS);
      },
      code: "invalid_field_type",
      path: "/candidate/cases/0/aggregate",
    },
    {
      note: "one stored count that disagrees with the cases",
      operation: () => {
        const edited = structuredClone(
          candidate.report as unknown as Record<string, unknown>,
        ) as unknown as EvaluationReport;
        const set = edited.metrics[0] as unknown as {
          counts: { pass: number };
        };
        set.counts.pass = 9;
        return compare(edited, baseline.report, REFS);
      },
      code: "invalid_field_type",
      path: "/baseline/metrics/0/counts",
    },
  ];
  for (const row of rows) {
    const failure = failureOf(row.operation);
    expect(failure.code, row.note).toBe(row.code);
    expect(failure.fieldPath, row.note).toBe(row.path);
  }
});

test("the comparison artifact keeps the frozen contract shape and no case content", async () => {
  const baseline = await evaluateWith({
    evaluatorId: "baseline-evaluator",
    steps: [SUPPORTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });
  const candidate = await evaluateWith({
    evaluatorId: "candidate-evaluator",
    steps: [CONTRADICTED, YES, SUPPORTED, YES, SUPPORTED, YES],
  });
  const comparison = compare(baseline.report, candidate.report, REFS);

  // The artifact keys stay inside the frozen schema, and the value
  // serializes with no extra field.
  const stored = JSON.parse(JSON.stringify(comparison.report)) as Record<string, unknown>;
  expect(Object.keys(stored).sort()).toEqual([
    "baseline",
    "candidate",
    "changed",
    "evidence_class",
    "matching",
    "schema_version",
    "tradeoffs",
  ]);
  expect(Object.keys(stored.tradeoffs as object).sort()).toEqual([
    "metrics",
    "usage",
  ]);
  // No case states one elapsed time, so the comparison states no latency
  // row for either side.
  expect("elapsed_ms" in (stored.tradeoffs as object)).toBe(false);

  // The comparison holds no raw case content: the identifiers, the
  // hashes, and the host references alone cross.
  const text = JSON.stringify(comparison);
  for (const forbidden of [
    "The search index now refreshes nightly",
    "One claim names no evidence",
    "scripted-1.4.0",
  ]) {
    expect(text).not.toContain(forbidden);
  }
  expect(text).toContain(REFS.baselineReport);
});
