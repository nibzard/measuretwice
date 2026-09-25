// SPDX-License-Identifier: Apache-2.0
/**
 * Calibration workflow failure tests.
 *
 * These tests cover task T053: measurement integrity across the complete
 * fitting and validation boundary. Each test drives one complete
 * calibration through the public `calibrate` operation and checks one way
 * the evidence can fail to establish the declared goals: the empty
 * denominator, the zero-error bound, the small sample, the absent label,
 * the required slice without one case, the correlated group under the
 * independent model, the synthetic challenge set, the reused holdout, the
 * candidate tie, the exhausted search budget, the policy that no candidate
 * satisfies, and the aborted validation. Two further suites state the
 * integrity of the numbers themselves: the workflow statistics equal the
 * direct core operations on the same stored assessments, every reported
 * value traces to recorded counts and a declared method, and provider
 * confidence and baseline agreement never substitute for the measured
 * correctness that reference labels alone state. The adapter is the
 * scripted test evaluator, so the tests read local files only and stay
 * offline and deterministic.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import {
  calibrate,
  defineChecks,
  load,
  loadDataset,
  registerEvaluators,
  ValidationError,
  type Calibration,
  type CalibrateOptions,
  type CalibrationSampling,
  type DatasetSplitIdentity,
  type Definition,
  type Evaluator,
  type EvaluatorExecution,
  type EvaluatorRequest,
  type FileAccess,
  type RunCheckRecord,
  type RunReport,
} from "../src/index.js";
import { nativeFitPolicy, nativeQualifyCandidate } from "../src/native.js";
import { createScriptedEvaluator } from "../src/test-evaluator.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

/** The fixed start time of every test calibration: 24 September 2026, UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/**
 * One definition with one categorical question that carries one review
 * label and one exact rule, the same shape the calibrate suite binds: the
 * search replays both kinds, the aggregate folds them, and one dataset
 * reaches the error and the review denominators.
 */
const notes = defineChecks({
  version: 1,
  name: "message-supported",
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
      question: "Does every material claim follow from the evidence?",
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
      rule: { maxLength: 40 },
    },
  ],
});

/** One categorical execution with its mass on the three declared answers. */
function execution(
  supported: number,
  incomplete: number,
  contradicted: number,
  model = "scripted-1.4.0",
): EvaluatorExecution {
  let label = "supported";
  if (incomplete > supported && incomplete > contradicted) {
    label = "incomplete";
  } else if (contradicted > supported && contradicted > incomplete) {
    label = "contradicted";
  }
  return {
    assessment: {
      kind: "categorical",
      label,
      distribution: [
        { name: "supported", mass: supported },
        { name: "incomplete", mass: incomplete },
        { name: "contradicted", mass: contradicted },
      ],
    },
    ...(model === undefined ? {} : { model_resolved: model }),
  };
}

// ---------------------------------------------------------------------------
// The measured world: cases, references, datasets, and plans.
// ---------------------------------------------------------------------------

/** One case record of the tests. One absent reference states one unlabeled case. */
interface CaseSpec {
  readonly id: string;
  readonly group: string;
  /** The reference answer of the question check. Omit for one unlabeled case. */
  readonly reference?: "supported" | "contradicted";
  /** The case tags of the record, for the important slices of one plan. */
  readonly tags?: readonly string[];
  /** The text of the `prior_decision` input, the decision one host recorded before. */
  readonly prior?: string;
}

/** Builds one JSONL record: the stripped case input, the reference, and the review. */
function record(spec: CaseSpec): string {
  const value: Record<string, unknown> = {
    id: spec.id,
    group: spec.group,
    input: {
      prior_decision: spec.prior ?? "Customer exports stay in the EU.",
      conversation: "The new export worker stays in the EU region.",
      proposed_message: "The export worker serves EU customers.",
    },
    label: { author_type: "human", reviewed: true, reviewer: "reviewer-1" },
  };
  if (spec.tags !== undefined) {
    value.tags = [...spec.tags];
  }
  if (spec.reference !== undefined) {
    value.expected = {
      checks: {
        "message-supported": { answer: spec.reference },
        "message-length": { outcome: "pass" },
      },
      outcome: spec.reference === "supported" ? "pass" : "fail",
    };
  }
  return JSON.stringify(value);
}

/**
 * The designed fitting cases of the shared tests. Every number is stated in
 * the test that reads it.
 *
 * - `fit-1`: reference pass, mass 0.95 on `supported`.
 * - `fit-2`: reference pass, mass 0.75 on `supported`.
 * - `fit-3`: reference fail, mass 0.90 on `contradicted`.
 * - `fit-4`: reference fail, mass 0.90 on `supported`, so the evaluator is
 *   confidently wrong on one fail case.
 */
const FITTING_CASES: readonly CaseSpec[] = [
  { id: "fit-1", group: "conversation-a", reference: "supported" },
  { id: "fit-2", group: "conversation-a", reference: "supported" },
  { id: "fit-3", group: "conversation-a", reference: "contradicted" },
  { id: "fit-4", group: "conversation-a", reference: "contradicted" },
];

/**
 * The designed validation cases of the shared tests.
 *
 * - `hold-1`: reference pass, mass 0.95 on `supported`.
 * - `hold-2`: reference fail, mass 0.85 on `contradicted`.
 * - `hold-3`: reference fail, mass 0.80 on `supported`, so the frozen
 *   candidate accepts one wrong case.
 */
const VALIDATION_CASES: readonly CaseSpec[] = [
  { id: "hold-1", group: "conversation-b", reference: "supported" },
  { id: "hold-2", group: "conversation-b", reference: "contradicted" },
  { id: "hold-3", group: "conversation-b", reference: "contradicted" },
];

/** The scripted answers of the fitting split, in case order. */
const FITTING_STEPS: readonly EvaluatorExecution[] = [
  execution(0.95, 0.03, 0.02),
  execution(0.75, 0.15, 0.1),
  execution(0.05, 0.05, 0.9),
  execution(0.9, 0.05, 0.05),
];

/** The scripted answers of the validation split, in case order. */
const VALIDATION_STEPS: readonly EvaluatorExecution[] = [
  execution(0.95, 0.03, 0.02),
  execution(0.05, 0.1, 0.85),
  execution(0.8, 0.1, 0.1),
];

/** One dataset world: its kind, its splits, and any group leaked across the two. */
interface WorldSpec {
  /** The fitting cases. The groups of the cases form the fitting split. */
  readonly fitting?: readonly CaseSpec[];
  /** The validation cases. The groups of the cases form the validation split. */
  readonly validation?: readonly CaseSpec[];
  /** The dataset kind. The default is one representative sample. */
  readonly kind?: string;
  /** Groups that the validation split also declares, so the two splits share them. */
  readonly leakIntoValidation?: readonly string[];
}

/** Builds the dataset metadata and the records text of one world. */
function worldTexts(spec: WorldSpec = {}): { readonly metadata: string; readonly records: string } {
  const fitting = spec.fitting ?? FITTING_CASES;
  const validation = spec.validation ?? VALIDATION_CASES;
  const fittingGroups = [...new Set(fitting.map((entry) => entry.group))];
  const validationGroups = [
    ...new Set(validation.map((entry) => entry.group)),
    ...(spec.leakIntoValidation ?? []),
  ];
  return {
    metadata: JSON.stringify({
      schema_version: 1,
      id: "calibration-cases",
      name: "Calibration cases",
      revision: "2026-09-24.1",
      kind: spec.kind ?? "representative_sample",
      intended_population: "Proposed messages in support conversations.",
      sampling_method: "Sampled at random from reviewed traffic of one week.",
      label_guidelines: "See docs/labeling.md revision 3.",
      languages: ["en"],
      splits: [
        { id: "fit", purpose: "fitting", groups: fittingGroups },
        { id: "holdout", purpose: "validation", groups: validationGroups },
      ],
    }),
    records: [...fitting, ...validation].map(record).join("\n"),
  };
}

/** The permitted candidate grid of one plan. */
interface GridSpec {
  readonly accept?: readonly number[];
  readonly rejection?: readonly number[];
  readonly floors?: readonly number[];
}

/** The overridable fields of one plan artifact. */
interface PlanOverrides {
  readonly constraints?: unknown;
  readonly objective?: unknown;
  readonly minimumSamples?: unknown;
  readonly importantSlices?: unknown;
  readonly grid?: GridSpec;
  readonly fittingSplit?: string;
  readonly validationSplit?: string;
  readonly definitionHash?: string;
}

/** One constraint list that limits the observed error among accepted cases. */
function errorGoal(limit: number): readonly unknown[] {
  return [
    { metric: "error_among_accepted", comparison: "at_most", limit, basis: "observed_value" },
  ];
}

/** Builds one plan artifact over the shared definition and dataset. */
function plan(overrides: PlanOverrides = {}): string {
  if (overrides.definitionHash === undefined) {
    throw new Error("the plan of one test needs the definition hash");
  }
  const grid = overrides.grid ?? { accept: [0.6], rejection: [0.6] };
  return JSON.stringify({
    schema_version: 1,
    id: "message-supported-plan",
    name: "Limit wrong interventions, then minimize review",
    definition: { name: "message-supported", content_hash: overrides.definitionHash },
    intended_population: "Proposed messages in the reviewed support traffic.",
    sampling_assumptions:
      "Cases grouped by conversation. Groups are independent draws within one week of traffic.",
    confidence_level: 0.95,
    constraints:
      overrides.constraints ?? [
        {
          metric: "error_among_accepted",
          comparison: "at_most",
          limit: 0.5,
          basis: "observed_value",
        },
      ],
    objective: overrides.objective ?? { metric: "review_rate", direction: "minimize" },
    minimum_samples: overrides.minimumSamples ?? { accepted_cases: 2 },
    ...(overrides.importantSlices === undefined
      ? {}
      : { important_slices: overrides.importantSlices }),
    candidate_grid: {
      accept_cutoffs: grid.accept ?? [0.6],
      rejection_cutoffs: grid.rejection ?? [0.6],
      ...(grid.floors === undefined ? {} : { confidence_floors: grid.floors }),
    },
    evaluator: { evaluator: "scripted-test", adapter_version: "0.1.0" },
    datasets: {
      fitting: {
        dataset: "calibration-cases",
        revision: "2026-09-24.1",
        split: overrides.fittingSplit ?? "fit",
      },
      validation: {
        dataset: "calibration-cases",
        revision: "2026-09-24.1",
        split: overrides.validationSplit ?? "holdout",
      },
    },
  });
}

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

/** The inputs of one calibration of the tests. */
interface Setup {
  readonly world?: WorldSpec;
  readonly fittingSteps?: readonly EvaluatorExecution[];
  readonly validationSteps?: readonly EvaluatorExecution[];
  readonly plan?: PlanOverrides;
  readonly sampling?: CalibrationSampling;
  readonly previouslyUsed?: readonly DatasetSplitIdentity[];
  readonly options?: Record<string, unknown>;
  readonly evaluator?: Evaluator;
}

/** One bound calibration: the texts it reads, its files, its calls, and its runner. */
interface Bound {
  readonly definitionHash: string;
  readonly definitionText: string;
  readonly planText: string;
  readonly metadataText: string;
  readonly recordsText: string;
  readonly files: FileAccess & { reads: string[] };
  readonly calls: readonly EvaluatorRequest[];
  readonly clock: FakeClock;
  readonly options: (extra?: Record<string, unknown>) => Promise<Calibration>;
}

/** Binds one calibration world: the plan, the dataset, the registry, and the runner. */
async function bind(setup: Setup = {}): Promise<Bound> {
  const clock = new FakeClock(START_MS);
  const dataset = worldTexts(setup.world);
  const bare = await load(notes);
  const evaluator =
    setup.evaluator ??
    createScriptedEvaluator({
      steps: [
        ...(setup.fittingSteps ?? FITTING_STEPS),
        ...(setup.validationSteps ?? VALIDATION_STEPS),
      ].map((step) => ({ answer: step })) as never,
    });
  const scripted = evaluator as unknown as { calls?: EvaluatorRequest[] };
  const planText = plan({ definitionHash: bare.definitionHash, ...setup.plan });
  const files = memoryFiles({
    "/plan/calibration-plan.json": planText,
    "/datasets/metadata.json": dataset.metadata,
    "/datasets/cases.jsonl": dataset.records,
  });
  const base: CalibrateOptions = {
    plan: "/plan/calibration-plan.json",
    metadata: "/datasets/metadata.json",
    records: "/datasets/cases.jsonl",
    evaluators: registerEvaluators(evaluator),
    sampling: setup.sampling ?? "grouped_cases",
    ...(setup.previouslyUsed === undefined ? {} : { previouslyUsed: setup.previouslyUsed }),
    evaluationReports: ["reports/message-supported-validation.json"],
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
    ...(setup.options ?? {}),
  };
  return {
    definitionHash: bare.definitionHash,
    definitionText: JSON.stringify(bare.definition as Definition),
    planText,
    metadataText: dataset.metadata,
    recordsText: dataset.records,
    files,
    calls: scripted.calls ?? [],
    clock,
    options: (extra) => calibrate(notes, { ...base, ...(extra ?? {}) } as never),
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

// ---------------------------------------------------------------------------
// Independent statistics: the published Wilson bound and the decision rule.
// ---------------------------------------------------------------------------

/** The two-sided standard normal quantile at 95 percent confidence. */
const Z_95 = 1.959_963_984_540_054_3;

/** Computes the Wilson score interval of `events` events over `draws` draws. */
function wilson(events: number, draws: number, z = Z_95): [number, number] {
  const observed = events / draws;
  const factor = (z * z) / draws;
  const scale = 1 + factor;
  const center = (observed + factor / 2) / scale;
  const half = (z / scale) * Math.sqrt((observed * (1 - observed)) / draws + factor / (4 * draws));
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  return [clamp(center - half), clamp(center + half)];
}

/** One replayed case: its reference outcome and its predicted aggregate outcome. */
interface FoldedCase {
  readonly reference: "pass" | "fail" | null;
  readonly predicted: "pass" | "fail" | "review";
}

/** Returns the mass one stored assessment states for one answer. */
function massOf(assessment: Readonly<Record<string, unknown>>, name: string): number {
  const distribution = assessment.distribution as readonly { name: string; mass: number }[];
  const entry = distribution.find((row) => row.name === name);
  return entry === undefined ? 0 : entry.mass;
}

/** Decides one stored categorical assessment under the published rule of the family. */
function decide(
  assessment: Readonly<Record<string, unknown>>,
  acceptCutoff: number,
  rejectionCutoff: number,
): "pass" | "fail" | "review" {
  if (assessment.label === "incomplete") {
    return "review";
  }
  if (massOf(assessment, "supported") >= acceptCutoff) {
    return "pass";
  }
  if (massOf(assessment, "contradicted") >= rejectionCutoff) {
    return "fail";
  }
  return "review";
}

/** Folds the component outcomes of one case into its aggregate outcome. */
function foldComponents(components: readonly string[]): "pass" | "fail" | "review" {
  if (components.includes("fail")) {
    return "fail";
  }
  if (components.includes("review") || components.includes("skipped")) {
    return "review";
  }
  return "pass";
}

/**
 * Replays the measured cases of one split under one candidate, from the
 * stored assessments of the run reports alone.
 *
 * The replay states the published decision rule of the `probability_mass_v0`
 * family and the published aggregate fold, so the recounted rates below are
 * one independent implementation of the published meanings, not one copy of
 * the core code.
 */
function replay(
  runs: readonly RunReport[],
  cases: readonly CaseSpec[],
  candidate: Readonly<{ accept_cutoff: number; rejection_cutoff: number }>,
): readonly FoldedCase[] {
  const byId = new Map(runs.map((run) => [run.case.id, run] as const));
  return cases.map((spec) => {
    const run = byId.get(spec.id);
    if (run === undefined) {
      throw new Error(`the runs state no case ${JSON.stringify(spec.id)}`);
    }
    const components = run.checks.map((check: RunCheckRecord) => {
      if (check.kind === "rule") {
        return check.outcome;
      }
      const assessment = check.assessment;
      if (assessment === undefined) {
        throw new Error(`the check record of ${JSON.stringify(spec.id)} states no assessment`);
      }
      return decide(assessment, candidate.accept_cutoff, candidate.rejection_cutoff);
    });
    return {
      reference:
        spec.reference === undefined ? null : spec.reference === "supported" ? "pass" : "fail",
      predicted: foldComponents(components),
    };
  });
}

/** One recounted rate: its numerator and its denominator. */
interface CountPair {
  readonly numerator: number;
  readonly denominator: number;
}

/** The six published rates of one replayed population. */
interface RecountedRates {
  readonly error_among_accepted: CountPair;
  readonly false_acceptance_rate: CountPair;
  readonly false_rejection_rate: CountPair;
  readonly review_rate: CountPair;
  readonly automatic_coverage: CountPair;
  readonly label_coverage: CountPair;
}

/** Recounts the six published rates of one replayed population. */
function recount(rows: readonly FoldedCase[]): RecountedRates {
  const wrongAccepted = rows.filter(
    (row) => row.predicted === "pass" && row.reference !== null && row.reference !== "pass",
  ).length;
  const labeledAccepted = rows.filter(
    (row) => row.predicted === "pass" && row.reference !== null,
  ).length;
  const referenceWrong = rows.filter((row) => row.reference !== null && row.reference !== "pass")
    .length;
  const referencePass = rows.filter((row) => row.reference === "pass").length;
  const referencePassRejected = rows.filter(
    (row) => row.reference === "pass" && row.predicted === "fail",
  ).length;
  const total = rows.length;
  return {
    error_among_accepted: { numerator: wrongAccepted, denominator: labeledAccepted },
    false_acceptance_rate: { numerator: wrongAccepted, denominator: referenceWrong },
    false_rejection_rate: { numerator: referencePassRejected, denominator: referencePass },
    review_rate: {
      numerator: rows.filter((row) => row.predicted === "review").length,
      denominator: total,
    },
    automatic_coverage: {
      numerator: rows.filter((row) => row.predicted === "pass" || row.predicted === "fail")
        .length,
      denominator: total,
    },
    label_coverage: {
      numerator: rows.filter((row) => row.reference !== null).length,
      denominator: total,
    },
  };
}

/** Reads the stored assessments of one split out of the run reports. */
function assessmentsOf(
  calibration: Calibration,
  caseIds: readonly string[],
): Record<string, Record<string, unknown>> {
  const byId = new Map(calibration.runs.map((run) => [run.case.id, run] as const));
  const value: Record<string, Record<string, unknown>> = {};
  for (const caseId of caseIds) {
    const run = byId.get(caseId);
    if (run === undefined) {
      throw new Error(`the runs state no case ${JSON.stringify(caseId)}`);
    }
    const byCheck: Record<string, unknown> = {};
    for (const check of run.checks) {
      if (check.kind !== "rule") {
        byCheck[check.check] = check.assessment;
      }
    }
    value[caseId] = byCheck;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The evidence failures: denominators, bounds, labels, and slices.
// ---------------------------------------------------------------------------

test("one validation that accepts no case states one zero denominator", async () => {
  // Every validation answer holds one clear majority on `contradicted`, so
  // the frozen candidate accepts no case: the error metric states no
  // denominator, no value exists, and no bound computes. The calibration
  // returns the candidate with `insufficient_evidence`, never one observed
  // error rate of zero read as one measured zero risk.
  const rejectsEverything = () => execution(0.3, 0.05, 0.65);
  const bound = await bind({
    validationSteps: [rejectsEverything(), rejectsEverything(), rejectsEverything()],
  });
  const calibration = await bound.options();

  expect(calibration.fitting.status).toBe("feasible");
  expect(calibration.fitting.selected?.index).toBe(0);
  const qualification = calibration.qualification;
  expect(qualification?.status).toBe("insufficient_evidence");
  expect(qualification?.reasons.map((reason) => reason.code)).toEqual([
    "zero_denominator",
    "insufficient_evidence",
  ]);
  const goal = qualification?.goals[0];
  expect(goal?.metric).toBe("error_among_accepted");
  expect(goal?.evidence).toEqual({ evidence: "zero_denominator" });
  expect(goal?.denominator).toBe(0);
  expect(goal?.numerator).toBe(0);
  expect(goal?.observed).toBeNull();
  expect(goal?.upper_bound).toBeNull();
  expect(goal?.met).toBe(false);
  // The plan minimum of the same denominator states the second reason.
  expect(qualification?.sample_requirements[0]).toEqual({
    denominator: "accepted_cases",
    stated: 2,
    measured: 0,
    met: false,
  });
  // The interval row states its own reason, and the rate states no value.
  const interval = qualification?.intervals?.intervals.find(
    (row) => row.metric === "error_among_accepted",
  );
  expect(interval?.reason).toBe("insufficient_evidence");
  expect(interval?.lower).toBeNull();
  expect(interval?.upper).toBeNull();
  expect(interval?.draws).toBe(0);
  const allChecks = qualification?.scopes.find((set) => set.scope === "all_checks");
  const rate = allChecks?.rates.find((row) => row.metric === "error_among_accepted");
  expect(rate).toEqual({
    metric: "error_among_accepted",
    numerator: 0,
    denominator: 0,
    value: null,
  });
  // The profile keeps the frozen policy and the computed status.
  expect(calibration.profile.qualification.status).toBe("insufficient_evidence");
  expect(calibration.profile.qualification.reasons).toContain("zero_denominator");
  expect(calibration.profile.policy.checks).toEqual([
    { check: "message-supported", accept_cutoff: 0.6, rejection_cutoff: 0.6 },
  ]);
});

test("zero observed errors on one small validation bound no zero risk", async () => {
  // Thirteen clean cases, each in its own group: the fitting split holds
  // ten accepted cases with no error, the validation split three. The plan
  // limits the upper bound of the error rate to 0.3. Ten draws bound the
  // risk below the limit, so one candidate is feasible; three draws do
  // not, so the observed zero errors state one unmet goal, not one pass.
  const fitting = Array.from({ length: 10 }, (_, index) => ({
    id: `fit-${index + 1}`,
    group: `fit-conversation-${index + 1}`,
    reference: "supported" as const,
  }));
  const validation = Array.from({ length: 3 }, (_, index) => ({
    id: `hold-${index + 1}`,
    group: `hold-conversation-${index + 1}`,
    reference: "supported" as const,
  }));
  const bound = await bind({
    world: { fitting, validation },
    fittingSteps: fitting.map(() => execution(0.95, 0.03, 0.02)),
    validationSteps: validation.map(() => execution(0.95, 0.03, 0.02)),
    plan: {
      constraints: [
        {
          metric: "error_among_accepted",
          comparison: "at_most",
          limit: 0.3,
          basis: "upper_confidence_bound",
        },
      ],
      minimumSamples: { accepted_cases: 3 },
    },
  });
  const calibration = await bound.options();

  // The fitting goal met its bound: the Wilson upper bound of zero errors
  // over ten groups stays under the declared limit.
  const fitted = calibration.fitting.selected?.constraints[0];
  expect(fitted?.evidence).toEqual({ evidence: "measured" });
  expect(fitted?.numerator).toBe(0);
  expect(fitted?.denominator).toBe(10);
  expect(fitted?.upper_bound).toBeCloseTo(wilson(0, 10)[1], 12);
  expect(fitted?.met).toBe(true);

  // The validation goal measured the same zero errors on fewer draws, and
  // the bound it states exceeds the limit: the goal fails.
  const qualification = calibration.qualification;
  expect(qualification?.status).toBe("criteria_not_met");
  expect(qualification?.reasons.map((reason) => reason.code)).toEqual(["criteria_not_met"]);
  expect(qualification?.reasons[0]?.statement).toContain("upper bound");
  const goal = qualification?.goals[0];
  expect(goal?.evidence).toEqual({ evidence: "measured" });
  expect(goal?.basis).toBe("upper_confidence_bound");
  expect(goal?.numerator).toBe(0);
  expect(goal?.denominator).toBe(3);
  expect(goal?.observed).toBe(0);
  expect(goal?.draws).toBe(3);
  expect(goal?.upper_bound).toBeCloseTo(wilson(0, 3)[1], 12);
  expect(goal?.upper_bound as number).toBeGreaterThan(0.3);
  expect(goal?.met).toBe(false);
  // The bound of the goal row is the bound of its interval row.
  const interval = qualification?.intervals?.intervals.find(
    (row) => row.metric === "error_among_accepted",
  );
  expect(interval?.upper).toBeCloseTo(goal?.upper_bound as number, 12);
  expect(calibration.profile.qualification.status).toBe("criteria_not_met");
});

test("absent validation labels below the plan minimum state insufficient evidence", async () => {
  // The first validation case carries no reference, so its acceptance
  // states no labeled denominator. The plan demands three labeled cases,
  // the validation holds two, and the goal row keeps the one labeled
  // accepted case it measured: one wrong case of one.
  const bound = await bind({
    world: {
      validation: [
        { id: "hold-1", group: "conversation-b" },
        { id: "hold-2", group: "conversation-b", reference: "contradicted" },
        { id: "hold-3", group: "conversation-b", reference: "contradicted" },
      ],
    },
    plan: { minimumSamples: { accepted_cases: 1, labeled_cases: 3 } },
  });
  const calibration = await bound.options();

  const qualification = calibration.qualification;
  expect(qualification?.status).toBe("insufficient_evidence");
  expect(qualification?.reasons.map((reason) => reason.code)).toEqual(["insufficient_evidence"]);
  expect(qualification?.reasons[0]?.statement).toContain("labeled_cases");
  expect(qualification?.sample_requirements).toEqual([
    { denominator: "accepted_cases", stated: 1, measured: 1, met: true },
    { denominator: "labeled_cases", stated: 3, measured: 2, met: false },
  ]);
  // The absent label left the accepted case out of the error denominator.
  const goal = qualification?.goals[0];
  expect(goal?.evidence).toEqual({ evidence: "measured" });
  expect(goal?.numerator).toBe(1);
  expect(goal?.denominator).toBe(1);
  expect(goal?.observed).toBe(1);
  expect(goal?.met).toBe(false);
  // The label coverage states the absent labels as one measured rate.
  const rates = qualification?.scopes
    .find((set) => set.scope === "all_checks")
    ?.rates.find((row) => row.metric === "label_coverage");
  expect(rates?.numerator).toBe(2);
  expect(rates?.denominator).toBe(3);
  expect(rates?.value).toBeCloseTo(2 / 3, 12);
  // The profile states the measured count beside the stated minimum.
  expect(calibration.profile.performance?.sample_counts).toEqual({
    accepted_cases: 1,
    labeled_cases: 2,
  });
  expect(calibration.profile.performance?.sample_minimums).toEqual({
    accepted_cases: 1,
    labeled_cases: 3,
  });
  expect(calibration.profile.qualification.status).toBe("insufficient_evidence");
});

test("required slices with no case and below the floor state insufficient evidence", async () => {
  // The plan declares three important slices. The validation split holds
  // no case of the first, one labeled case of the second against a floor
  // of two, and one case that meets the floor of the third. The two
  // unmet floors state `insufficient_evidence` with their counts, and the
  // met slice keeps its own metric set and interval rows.
  const bound = await bind({
    world: {
      validation: [
        { id: "hold-1", group: "conversation-b", reference: "supported", tags: ["reviewed-traffic"] },
        { id: "hold-2", group: "conversation-b", reference: "contradicted", tags: ["eu-traffic"] },
        { id: "hold-3", group: "conversation-b", reference: "contradicted" },
      ],
    },
    plan: {
      importantSlices: [
        { tag: "later-corrections", minimum_samples: { labeled_cases: 2 } },
        { tag: "eu-traffic", minimum_samples: { labeled_cases: 2 } },
        { tag: "reviewed-traffic", minimum_samples: { labeled_cases: 1 } },
      ],
    },
  });
  const calibration = await bound.options();

  const qualification = calibration.qualification;
  expect(qualification?.status).toBe("insufficient_evidence");
  expect(qualification?.reasons.map((reason) => reason.code)).toEqual([
    "insufficient_evidence",
    "insufficient_evidence",
  ]);
  expect(qualification?.reasons[0]?.statement).toContain("later-corrections");
  expect(qualification?.reasons[1]?.statement).toContain("eu-traffic");

  // The slice with no case states no interval that implies observed cases.
  const absent = qualification?.slices[0];
  expect(absent?.met).toBe(false);
  expect(absent?.denominators).toEqual({ labeled_cases: 0 });
  expect(absent?.intervals).toBeNull();
  expect(absent?.statement).toContain("no case of the slice");
  expect(absent?.metrics.counts).toEqual({ pass: 0, fail: 0, review: 0, error: 0, skipped: 0 });

  // The slice below its floor states the counts it holds.
  const short = qualification?.slices[1];
  expect(short?.met).toBe(false);
  expect(short?.denominators).toEqual({ labeled_cases: 1 });
  expect(short?.statement).toContain("of the stated 2");
  expect(short?.metrics.counts).toEqual({ pass: 0, fail: 1, review: 0, error: 0, skipped: 0 });

  // The met slice states its own measurement with its own interval rows.
  const met = qualification?.slices[2];
  expect(met?.met).toBe(true);
  expect(met?.statement).toContain("meets every stated minimum");
  expect(met?.metrics.counts).toEqual({ pass: 1, fail: 0, review: 0, error: 0, skipped: 0 });
  expect(met?.intervals?.intervals.every((row) => row.method === "wilson_score")).toBe(true);

  // The goal itself held, so the slices alone state the status.
  expect(qualification?.goals[0]?.met).toBe(true);
  expect(calibration.profile.qualification.status).toBe("insufficient_evidence");
  expect(calibration.profile.performance?.slice_limitations).toHaveLength(3);
});

// ---------------------------------------------------------------------------
// The sampling and reuse failures: leakage, correlation, and reuse.
// ---------------------------------------------------------------------------

test("one dataset whose two splits share one group refuses before one case is measured", async () => {
  // The validation split also declares the fitting group, so one
  // conversation would feed both the search and the validation. The
  // dataset contract refuses the shared group at load time, and the
  // calibration spends no evaluator call.
  const bound = await bind({
    world: { leakIntoValidation: ["conversation-a"] },
  });
  const failure = await failureOf(() => bound.options());
  expect(failure.code).toBe("duplicate_id");
  expect(failure.fieldPath).toBe("/splits/1/groups/1");
  expect(failure.message).toContain("conversation-a");
  expect(bound.calls.length).toBe(0);
});

test("correlated validation groups state unsupported sampling under independent cases", async () => {
  // The same measured world runs twice. Under `independent_cases`, the
  // three validation cases share one conversation, so the denominator of
  // the error rate correlates its cases and no bound may rest on the
  // broken assumption. Under `grouped_cases`, the same data with the
  // honest model supports the goal. The declared model changes the claim,
  // not the measurements.
  const independent = await bind({ sampling: "independent_cases" });
  const refused = await independent.options();
  const qualification = refused.qualification;
  expect(qualification?.sampling).toBe("independent_cases");
  expect(qualification?.assumption).toContain("independent draw");
  expect(qualification?.status).toBe("insufficient_evidence");
  expect(qualification?.reasons.map((reason) => reason.code)).toEqual(["unsupported_sampling"]);
  expect(qualification?.reasons[0]?.statement).toContain("groups correlate");
  const goal = qualification?.goals[0];
  expect(goal?.numerator).toBe(1);
  expect(goal?.denominator).toBe(2);
  expect(goal?.evidence).toEqual({ evidence: "unsupported_sampling" });
  expect(goal?.met).toBe(false);
  const interval = qualification?.intervals?.intervals.find(
    (row) => row.metric === "error_among_accepted",
  );
  expect(interval?.reason).toBe("unsupported_sampling");
  expect(interval?.lower).toBeNull();
  expect(interval?.upper).toBeNull();

  const grouped = await bind({ sampling: "grouped_cases" });
  const honest = await grouped.options();
  expect(honest.qualification?.status).toBe("validated_for_scope");
  expect(honest.qualification?.goals[0]?.evidence).toEqual({ evidence: "measured" });
  expect(honest.qualification?.goals[0]?.numerator).toBe(1);
  expect(honest.qualification?.goals[0]?.denominator).toBe(2);
});

test("one synthetic challenge validation is development data", async () => {
  // The dataset kind states one targeted synthetic challenge set, so the
  // validation split is no representative sample: the classification
  // marks it development data, the qualification needs fresh evidence,
  // and the standing limitations keep the prevalence claim out.
  const bound = await bind({ world: { kind: "synthetic_challenge" } });
  const calibration = await bound.options();

  const qualification = calibration.qualification;
  expect(qualification?.evidence.class).toBe("development");
  expect(qualification?.evidence.representative_sample).toBe(false);
  expect(qualification?.evidence.needs_fresh_evidence).toBe(true);
  expect(qualification?.evidence.statement).toContain("targeted_challenge_set");
  expect(qualification?.status).toBe("insufficient_evidence");
  expect(qualification?.reasons.map((reason) => reason.code)).toEqual(["insufficient_evidence"]);
  expect(qualification?.reasons[0]?.statement).toBe(qualification?.evidence.statement);
  expect(calibration.profile.qualification.status).toBe("insufficient_evidence");
  const limits = calibration.limitations.join(" ");
  expect(limits).toContain("states no production prevalence");
  expect(limits).toContain("supports no qualification claim");
});

test("one reused holdout is development data and needs fresh evidence", async () => {
  // The host states that one earlier claim consumed the holdout. The
  // classification marks the split development data and names the earlier
  // use, the measurements still ran, and the goals stay measured: the
  // status refuses the claim, not the arithmetic.
  const untouched = await bind();
  const holdout = (await loadDataset({
    definition: notes,
    metadata: "/datasets/metadata.json",
    records: "/datasets/cases.jsonl",
    files: untouched.files,
  })).splits.find((split) => split.split === "holdout");
  expect(holdout).toBeDefined();

  const bound = await bind({ previouslyUsed: [holdout as DatasetSplitIdentity] });
  const calibration = await bound.options();

  const qualification = calibration.qualification;
  expect(qualification?.evidence.class).toBe("development");
  expect(qualification?.evidence.reused_from).toEqual([
    "calibration-cases revision 2026-09-24.1 split holdout",
  ]);
  expect(qualification?.evidence.needs_fresh_evidence).toBe(true);
  expect(qualification?.evidence.statement).toContain("used before");
  expect(qualification?.status).toBe("insufficient_evidence");
  expect(qualification?.reasons.map((reason) => reason.code)).toEqual(["insufficient_evidence"]);
  // The measurements ran and the goal held, but one development split
  // supports no claim, whatever the goals state.
  expect(bound.calls.length).toBe(7);
  expect(qualification?.goals[0]?.met).toBe(true);
  expect(qualification?.goals[0]?.numerator).toBe(1);
  expect(qualification?.goals[0]?.denominator).toBe(2);
  expect(calibration.profile.qualification.status).toBe("insufficient_evidence");
  expect(calibration.limitations).toContain(qualification?.evidence.statement ?? "");
});

// ---------------------------------------------------------------------------
// The search failures: ties, budgets, feasibility, and cancellation.
// ---------------------------------------------------------------------------

test("one tie between two feasible candidates takes the first of the declared order", async () => {
  // Both cutoffs of the grid decide the four fitting cases the same way,
  // so both candidates are feasible with one identical objective. The
  // plan fixes the tie-break rule: the earlier candidate of the declared
  // enumeration order wins, and the profile records its parameters.
  const bound = await bind({
    plan: { grid: { accept: [0.6, 0.7], rejection: [0.6] } },
  });
  const calibration = await bound.options();

  const fitting = calibration.fitting;
  expect(fitting.candidate_count).toBe(2);
  expect(fitting.candidates.map((candidate) => candidate.feasible)).toEqual([true, true]);
  expect(fitting.candidates[1]?.objective).toEqual(fitting.candidates[0]?.objective);
  expect(fitting.selected?.index).toBe(0);
  expect(fitting.selected?.candidate.accept_cutoff).toBe(0.6);
  expect(calibration.profile.policy.checks).toEqual([
    { check: "message-supported", accept_cutoff: 0.6, rejection_cutoff: 0.6 },
  ]);
});

test("one search above the decision budget refuses with its counts", async () => {
  // The grid permits 1024 candidates and the fitting split holds 1025
  // cases, so the search states 1,049,600 policy decisions over the
  // published limit of 1,048,576. The core refuses the search with its
  // counts instead of measuring one narrowed family, after the
  // measurements it needed and before one validation case runs.
  const fitting = Array.from({ length: 1025 }, (_, index) => ({
    id: `bulk-fit-${index + 1}`,
    group: `bulk-conversation-${index + 1}`,
    reference: "supported" as const,
  }));
  const validation = [
    { id: "bulk-hold-1", group: "bulk-hold-conversation", reference: "supported" as const },
  ];
  const cutoffs = Array.from({ length: 1024 }, (_, index) =>
    Number((0.5 + (index + 1) / 2050).toFixed(10)),
  );
  const bound = await bind({
    world: { fitting, validation },
    fittingSteps: fitting.map(() => execution(0.95, 0.03, 0.02)),
    validationSteps: validation.map(() => execution(0.95, 0.03, 0.02)),
    plan: {
      constraints: errorGoal(1),
      minimumSamples: { accepted_cases: 1 },
      grid: { accept: cutoffs, rejection: [0.6] },
    },
  });
  const failure = await failureOf(() => bound.options());
  expect(failure.code).toBe("invalid_field_type");
  expect(failure.fieldPath).toBe("/plan/candidate_grid");
  expect(failure.message).toContain("1049600 policy decisions");
  expect(failure.message).toContain("1024 candidates and 1025 fitting cases");
  expect(failure.message).toContain("1048576");
  // The 1025 fitting cases were measured, because the budget refusal
  // comes from the search itself, and no validation case ran.
  expect(bound.calls.length).toBe(1025);
}, 120_000);

test("conflicting goals leave no feasible candidate and weaken no goal", async () => {
  // The plan demands one error rate of zero and one automatic coverage of
  // 0.9. The first two candidates accept one confidently wrong case, so
  // the error goal fails; the third rejects and reviews half the cases,
  // so the coverage goal fails. No candidate satisfies both demands, and
  // the report states every unmet goal with its limit unchanged.
  const bound = await bind({
    plan: {
      constraints: [
        ...errorGoal(0),
        {
          metric: "automatic_coverage",
          comparison: "at_least",
          limit: 0.9,
          basis: "observed_value",
        },
      ],
      grid: { accept: [0.6, 0.7, 0.95], rejection: [0.6] },
      minimumSamples: { accepted_cases: 1 },
    },
  });
  const calibration = await bound.options();

  const fitting = calibration.fitting;
  expect(fitting.status).toBe("no_feasible_candidate");
  expect(fitting.selected).toBeNull();
  expect(fitting.candidates.every((candidate) => !candidate.feasible)).toBe(true);
  // The first candidate meets the coverage goal and fails the error goal.
  const accepting = fitting.candidates[0]?.constraints;
  expect(accepting?.map((goal) => goal.met)).toEqual([false, true]);
  expect(accepting?.[0]?.numerator).toBe(1);
  expect(accepting?.[0]?.denominator).toBe(3);
  expect(accepting?.[0]?.limit).toBe(0);
  // The third candidate meets the error goal and fails the coverage goal.
  const abstaining = fitting.candidates[2]?.constraints;
  expect(abstaining?.map((goal) => goal.met)).toEqual([true, false]);
  expect(abstaining?.[0]?.evidence).toEqual({ evidence: "measured" });
  expect(abstaining?.[0]?.denominator).toBe(1);
  expect(abstaining?.[1]?.observed).toBeCloseTo(0.5, 12);
  expect(abstaining?.[1]?.limit).toBeCloseTo(0.9, 12);

  // No frozen candidate exists, so the validation budget stays unspent
  // and the profile records the objective-best candidate with the status.
  expect(calibration.qualification).toBeUndefined();
  expect(calibration.runs.map((run) => run.case.id)).toEqual([
    "fit-1",
    "fit-2",
    "fit-3",
    "fit-4",
  ]);
  expect(bound.calls.length).toBe(4);
  expect(calibration.profile.qualification.status).toBe("criteria_not_met");
  expect(calibration.profile.policy.checks).toEqual([
    { check: "message-supported", accept_cutoff: 0.6, rejection_cutoff: 0.6 },
  ]);
  expect(calibration.limitations.join(" ")).toContain(
    "No candidate of the permitted family meets the declared goals",
  );
});

test("one abort during the validation measurements refuses without one candidate", async () => {
  // The fitting phase completed and the search selected one candidate.
  // The signal aborts while the first validation case is in flight, so
  // the case stored no complete assessment set. The calibration refuses
  // instead of validating partial data, and no artifact exists.
  const controller = new AbortController();
  let seen = 0;
  const aborting: Evaluator = {
    id: "scripted-test",
    adapter_version: "0.1.0",
    async assess() {
      seen += 1;
      if (seen === 5) {
        controller.abort();
      }
      return execution(0.95, 0.03, 0.02);
    },
  };
  const bound = await bind({
    evaluator: aborting,
    options: { signal: controller.signal },
  });
  const failure = await failureOf(() => bound.options());
  expect(failure.code).toBe("run_cancelled");
  expect(failure.fieldPath).toBe("/cases/hold-1");
  expect(failure.message).toContain("hold-1");
  expect(failure.message).toContain("Nothing was promoted");
  // The four fitting cases and the first validation case measured, and
  // the sixth and seventh call never ran.
  expect(seen).toBe(5);
});

// ---------------------------------------------------------------------------
// The statistics: parity with the core and tracing to the counts.
// ---------------------------------------------------------------------------

test("the workflow statistics equal the direct core operations on the same assessments", async () => {
  // One calibration runs through the public workflow. The stored
  // assessments of its run reports then cross through the direct fitting
  // and qualification operations of the native boundary, with the same
  // plan, dataset, and definition texts. The Rust statistics answer
  // identically through both paths.
  const bound = await bind();
  const calibration = await bound.options();

  const fittingCases = FITTING_CASES.map((entry) => entry.id);
  const directFitting = JSON.parse(
    await nativeFitPolicy(
      bound.planText,
      bound.metadataText,
      bound.recordsText,
      bound.definitionText,
      JSON.stringify(assessmentsOf(calibration, fittingCases)),
    ),
  );
  expect(directFitting).toEqual(calibration.fitting);

  const directQualification = JSON.parse(
    await nativeQualifyCandidate(
      bound.planText,
      bound.metadataText,
      bound.recordsText,
      bound.definitionText,
      JSON.stringify(assessmentsOf(calibration, fittingCases)),
      JSON.stringify({ sampling: "grouped_cases" }),
      JSON.stringify(assessmentsOf(calibration, VALIDATION_CASES.map((entry) => entry.id))),
    ),
  );
  expect(directQualification).toEqual(calibration.qualification);
});

test("every reported rate traces to its counts, its method, and its declared basis", async () => {
  // One successful calibration, recounted from the stored assessments of
  // its run reports. Every rate of every scope equals the recorded counts
  // over those cases, every goal follows from its declared basis, every
  // bound equals the published Wilson formula, and the profile copies the
  // measured rows unchanged beside the declared method.
  const bound = await bind();
  const calibration = await bound.options();
  const fitting = calibration.fitting;
  const qualification = calibration.qualification;
  expect(fitting.method).toBe("bounded_grid_search");
  expect(fitting.interval_method).toBe("wilson_score");
  expect(qualification?.method).toBe("frozen_validation");
  expect(qualification?.interval_method).toBe("wilson_score");
  expect(qualification?.confidence_level).toBe(0.95);
  expect(qualification?.method_statement).toContain("Wilson score intervals at 95 percent");
  expect(qualification?.method_statement).toContain("Zero observed errors");

  // The replayed validation population: the stored assessments under the
  // frozen candidate, against the reference labels of the records.
  const candidate = qualification?.candidate as { accept_cutoff: number; rejection_cutoff: number };
  const folded = replay(calibration.runs, VALIDATION_CASES, candidate);
  const counted = recount(folded);
  const allChecks = qualification?.scopes.find((set) => set.scope === "all_checks");
  expect(allChecks?.counts).toEqual({ pass: 2, fail: 1, review: 0, error: 0, skipped: 0 });
  for (const [metric, counts] of Object.entries(counted)) {
    const rate = allChecks?.rates.find((row) => row.metric === metric);
    expect(rate?.numerator, metric).toBe(counts.numerator);
    expect(rate?.denominator, metric).toBe(counts.denominator);
  }
  // Every value of every scope states its counts: the outcomes of the
  // measured cases, the numerator over the denominator, or null at one
  // zero denominator.
  const sumOf = (counts: {
    pass: number;
    fail: number;
    review: number;
    error: number;
    skipped: number;
  }): number => counts.pass + counts.fail + counts.review + counts.error + counts.skipped;
  for (const set of fitting.selected?.scopes ?? []) {
    expect(sumOf(set.counts)).toBe(fitting.case_count);
    for (const rate of set.rates) {
      if (rate.denominator === 0) {
        expect(rate.value).toBeNull();
      } else {
        expect(rate.value).toBeCloseTo(rate.numerator / rate.denominator, 12);
      }
    }
  }
  for (const set of qualification?.scopes ?? []) {
    expect(sumOf(set.counts)).toBe(qualification?.case_count);
    for (const rate of set.rates) {
      if (rate.denominator === 0) {
        expect(rate.value).toBeNull();
      } else {
        expect(rate.value).toBeCloseTo(rate.numerator / rate.denominator, 12);
      }
    }
  }
  // The recounted fitting population states the objective and the goal of
  // the selected candidate.
  const fittingFolded = replay(calibration.runs, FITTING_CASES, candidate);
  const fittingCounted = recount(fittingFolded);
  const selectedGoal = fitting.selected?.constraints[0];
  expect(fitting.selected?.objective.numerator).toBe(fittingCounted.review_rate.numerator);
  expect(fitting.selected?.objective.denominator).toBe(fittingCounted.review_rate.denominator);
  expect(selectedGoal?.numerator).toBe(fittingCounted.error_among_accepted.numerator);
  expect(selectedGoal?.denominator).toBe(fittingCounted.error_among_accepted.denominator);
  // Every goal follows from its declared basis, never from another value.
  for (const goal of [
    ...fitting.candidates.flatMap((row) => row.constraints),
    ...(qualification?.goals ?? []),
  ]) {
    if (goal.evidence.evidence !== "measured") {
      expect(goal.met).toBe(false);
      continue;
    }
    const value = goal.basis === "upper_confidence_bound" ? goal.upper_bound : goal.observed;
    expect(value).not.toBeNull();
    const number = value as number;
    expect(goal.met).toBe(
      goal.comparison === "at_most" ? number <= goal.limit : number >= goal.limit,
    );
  }
  // Every bound equals the published Wilson formula over its own draws.
  for (const row of qualification?.intervals?.intervals ?? []) {
    if (row.reason === null) {
      const [lower, upper] = wilson(row.event_draws, row.draws);
      expect(row.lower).toBeCloseTo(lower, 12);
      expect(row.upper).toBeCloseTo(upper, 12);
      expect(row.method).toBe("wilson_score");
      expect(row.confidence_level).toBe(0.95);
      expect(row.sampling).toBe("grouped_cases");
    } else {
      expect(row.lower).toBeNull();
      expect(row.upper).toBeNull();
    }
  }
  // The sample requirements state the same denominators the recount read.
  expect(qualification?.sample_requirements).toEqual([
    {
      denominator: "accepted_cases",
      stated: 2,
      measured: counted.error_among_accepted.denominator,
      met: true,
    },
  ]);
  // The profile copies the measured rows beside the stated minimums and
  // the declared method, and states no number the reports do not hold.
  const performance = calibration.profile.performance;
  expect(performance?.metrics).toEqual(
    qualification?.scopes.flatMap((set) =>
      set.rates.map((rate) => ({
        scope: set.scope,
        metric: rate.metric,
        numerator: rate.numerator,
        denominator: rate.denominator,
        value: rate.value,
      })),
    ),
  );
  expect(performance?.sample_counts).toEqual({ accepted_cases: 2 });
  expect(performance?.sample_minimums).toEqual({ accepted_cases: 2 });
  expect(calibration.profile.evidence?.statistical_method).toBe(
    qualification?.method_statement,
  );
});

// ---------------------------------------------------------------------------
// The measurement integrity: confidence and agreement stay separate.
// ---------------------------------------------------------------------------

test("provider confidence never becomes measured correctness", async () => {
  // The evaluator accepts one case with mass 0.99 on the answer the
  // reviewed reference contradicts. The measurement counts the error
  // against the reference, whatever the provider believes: the goal
  // states one error of two accepted cases and fails its limit.
  const confidentlyWrong = await bind({
    validationSteps: [
      execution(0.99, 0.005, 0.005),
      execution(0.99, 0.005, 0.005),
      execution(0.3, 0.05, 0.65),
    ],
    plan: { constraints: errorGoal(0.4) },
  });
  const wrong = await confidentlyWrong.options();
  const wrongGoal = wrong.qualification?.goals[0];
  expect(wrongGoal?.numerator).toBe(1);
  expect(wrongGoal?.denominator).toBe(2);
  expect(wrongGoal?.observed).toBeCloseTo(0.5, 12);
  expect(wrongGoal?.met).toBe(false);
  expect(wrong.qualification?.status).toBe("criteria_not_met");

  // The same wrong answer at one barely sufficient mass of 0.61 changes
  // no count: the confidence level of one stored answer enters the
  // decision alone, never the measurement of correctness.
  const barelyWrong = await bind({
    validationSteps: [
      execution(0.99, 0.005, 0.005),
      execution(0.61, 0.2, 0.19),
      execution(0.3, 0.05, 0.65),
    ],
    plan: { constraints: errorGoal(0.4) },
  });
  const barely = await barelyWrong.options();
  expect(barely.qualification?.status).toBe(wrong.qualification?.status);
  expect(barely.qualification?.goals[0]?.numerator).toBe(1);
  expect(barely.qualification?.goals[0]?.denominator).toBe(2);
  expect(barely.qualification?.goals[0]?.observed).toBeCloseTo(0.5, 12);
  // The recorded performance keeps the reference-based rates alone: no
  // metric names the confidence of one provider, and no rate derives
  // from it.
  const words = (wrong.qualification?.scopes ?? []).flatMap((set) =>
    set.rates.map((rate) => rate.metric),
  );
  expect([...new Set(words)].sort()).toEqual([
    "automatic_coverage",
    "error_among_accepted",
    "false_acceptance_rate",
    "false_rejection_rate",
    "label_coverage",
    "review_rate",
  ]);
});

test("baseline agreement never becomes measured correctness", async () => {
  // Two worlds differ in the recorded prior decision alone: one text
  // agrees with the measured answers, one contradicts them. The
  // references, the answers, and the plans stay identical, so every
  // statistical row stays identical while the dataset content changes.
  // No reported number measures the agreement of one answer with one
  // recorded decision.
  const agreeing = await bind({
    world: {
      fitting: FITTING_CASES.map((entry) => ({
        ...entry,
        prior: "The earlier review accepted the message.",
      })),
      validation: VALIDATION_CASES.map((entry) => ({
        ...entry,
        prior: "The earlier review accepted the message.",
      })),
    },
  });
  const disagreeing = await bind({
    world: {
      fitting: FITTING_CASES.map((entry) => ({
        ...entry,
        prior: "The earlier review rejected the message.",
      })),
      validation: VALIDATION_CASES.map((entry) => ({
        ...entry,
        prior: "The earlier review rejected the message.",
      })),
    },
  });
  const agreed = await agreeing.options();
  const disagreed = await disagreeing.options();

  // The statistics are identical.
  expect(disagreed.fitting.candidates).toEqual(agreed.fitting.candidates);
  expect(disagreed.fitting.selected?.objective).toEqual(agreed.fitting.selected?.objective);
  expect(disagreed.fitting.selected?.constraints).toEqual(agreed.fitting.selected?.constraints);
  expect(disagreed.fitting.selected?.scopes).toEqual(agreed.fitting.selected?.scopes);
  expect(disagreed.qualification?.status).toBe(agreed.qualification?.status);
  expect(disagreed.qualification?.goals).toEqual(agreed.qualification?.goals);
  expect(disagreed.qualification?.scopes).toEqual(agreed.qualification?.scopes);
  expect(disagreed.qualification?.intervals).toEqual(agreed.qualification?.intervals);
  expect(disagreed.profile.performance).toEqual(agreed.profile.performance);
  // The measured content itself changed, so the identities differ.
  expect(disagreed.fitting.split_content_hash).not.toBe(agreed.fitting.split_content_hash);
  expect(disagreed.qualification?.split_content_hash).not.toBe(
    agreed.qualification?.split_content_hash,
  );
  // The plan binds the dataset by identifier and revision, so both worlds
  // calibrated the declared dataset.
  expect(disagreed.fitting.dataset).toBe("calibration-cases");
});
