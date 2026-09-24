// SPDX-License-Identifier: Apache-2.0
/**
 * Calibrate API tests.
 *
 * These tests cover task T050: one calibration reads the explicit plan and
 * the datasets, checks every binding of the plan against the loaded world,
 * measures the development cases through the registered evaluator, searches
 * the permitted candidate family in the Rust core off the Node event loop,
 * freezes the selected candidate, validates it on the independent split,
 * and returns one candidate profile with the fitting and qualification
 * reports. The tests pin the successful qualification, the missing-evidence
 * and unmet-goal results, the no-candidate result that spends no validation
 * budget, the cancellation and evaluator-failure refusals, the binding
 * failures that cross before any spend, and the boundary that stays closed:
 * no calibration promotes one profile, and enforcement still needs the host
 * selection. The adapter is the scripted test evaluator, so the tests read
 * local files only and stay offline and deterministic.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import {
  calibrate,
  defineChecks,
  load,
  registerEvaluators,
  ValidationError,
  type CalibrateOptions,
  type Definition,
  type Evaluator,
  type EvaluatorExecution,
  type EvaluatorRequest,
  type FileAccess,
} from "../src/index.js";
import { createScriptedEvaluator } from "../src/test-evaluator.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";
import type { Calibration } from "../src/index.js";

/** The fixed start time of every test calibration: 24 September 2026, UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/**
 * One definition with one categorical question that carries one review
 * label and one exact rule, so one calibration replays both kinds, the
 * aggregate folds them, and one dataset reaches the error and the review
 * denominators.
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

/** One categorical assessment with its mass on the three declared answers. */
function answer(
  supported: number,
  incomplete: number,
  contradicted: number,
  model = "scripted-1.4.0",
): { readonly answer: { readonly assessment: unknown; readonly model_resolved?: string } } {
  return {
    answer: {
      assessment: {
        kind: "categorical",
        label: labelOf(supported, incomplete, contradicted),
        distribution: [
          { name: "supported", mass: supported },
          { name: "incomplete", mass: incomplete },
          { name: "contradicted", mass: contradicted },
        ],
      },
      ...(model === undefined ? {} : { model_resolved: model }),
    },
  };
}

/** One categorical execution with its mass on the three declared answers. */
function execution(
  supported: number,
  incomplete: number,
  contradicted: number,
  model?: string,
): EvaluatorExecution {
  return {
    assessment: {
      kind: "categorical",
      label: labelOf(supported, incomplete, contradicted),
      distribution: [
        { name: "supported", mass: supported },
        { name: "incomplete", mass: incomplete },
        { name: "contradicted", mass: contradicted },
      ],
    },
    ...(model === undefined ? {} : { model_resolved: model }),
  };
}

/** Names the answer with the greatest mass. */
function labelOf(supported: number, incomplete: number, contradicted: number): string {
  let best: readonly [number, string] = [supported, "supported"];
  if (incomplete > best[0]) {
    best = [incomplete, "incomplete"];
  }
  if (contradicted > best[0]) {
    best = [contradicted, "contradicted"];
  }
  return best[1];
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
const FITTING_STEPS = [
  answer(0.95, 0.03, 0.02),
  answer(0.75, 0.15, 0.1),
  answer(0.05, 0.05, 0.9),
  answer(0.9, 0.05, 0.05),
];

/**
 * The designed validation cases of the shared tests.
 *
 * - `hold-1`: reference pass, mass 0.95 on `supported`.
 * - `hold-2`: reference fail, mass 0.85 on `contradicted`.
 * - `hold-3`: reference fail, mass 0.80 on `supported`, so the frozen
 *   candidate accepts one wrong case.
 */
const VALIDATION_STEPS = [
  answer(0.95, 0.03, 0.02),
  answer(0.05, 0.1, 0.85),
  answer(0.8, 0.1, 0.1),
];

/** One case record of the tests. `reference` names the reference answer. */
function record(id: string, group: string, reference: string): string {
  return JSON.stringify({
    id,
    group,
    input: {
      prior_decision: "Customer exports stay in the EU.",
      conversation: "The new export worker stays in the EU region.",
      proposed_message: "The export worker serves EU customers.",
    },
    expected: {
      checks: {
        "message-supported": { answer: reference },
        "message-length": { outcome: "pass" },
      },
      outcome: reference === "supported" ? "pass" : "fail",
    },
    label: { author_type: "human", reviewed: true, reviewer: "reviewer-1" },
  });
}

/** The dataset of the tests: one fitting and one validation split. */
function datasetTexts(): { readonly metadata: string; readonly records: string } {
  return {
    metadata: JSON.stringify({
      schema_version: 1,
      id: "calibration-cases",
      name: "Calibration cases",
      revision: "2026-09-24.1",
      kind: "representative_sample",
      intended_population: "Proposed messages in support conversations.",
      sampling_method: "Sampled at random from reviewed traffic of one week.",
      label_guidelines: "See docs/labeling.md revision 3.",
      languages: ["en"],
      splits: [
        { id: "fit", purpose: "fitting", groups: ["conversation-a"] },
        { id: "holdout", purpose: "validation", groups: ["conversation-b"] },
      ],
    }),
    records: [
      record("fit-1", "conversation-a", "supported"),
      record("fit-2", "conversation-a", "supported"),
      record("fit-3", "conversation-a", "contradicted"),
      record("fit-4", "conversation-a", "contradicted"),
      record("hold-1", "conversation-b", "supported"),
      record("hold-2", "conversation-b", "contradicted"),
      record("hold-3", "conversation-b", "contradicted"),
    ].join("\n"),
  };
}

/** One plan artifact over the shared definition and dataset. */
function plan(overrides: {
  readonly id?: string;
  readonly constraints?: unknown;
  readonly minimum_samples?: unknown;
  readonly evaluator?: unknown;
  readonly grid?: unknown;
  readonly definitionHash?: string;
  readonly fittingSplit?: string;
  readonly validationSplit?: string;
}): string {
  if (overrides.definitionHash === undefined) {
    throw new Error("the plan of one test needs the definition hash");
  }
  return JSON.stringify({
    schema_version: 1,
    id: overrides.id ?? "message-supported-plan",
    name: "Limit wrong interventions, then minimize review",
    definition: { name: "message-supported", content_hash: overrides.definitionHash },
    intended_population: "Proposed messages in the reviewed support traffic.",
    sampling_assumptions:
      "Cases grouped by conversation. Groups are independent draws within one week of traffic.",
    confidence_level: 0.95,
    constraints:
      overrides.constraints ??
      JSON.parse(
        '[{"metric": "error_among_accepted", "comparison": "at_most", "limit": 0.5, "basis": "observed_value"}]',
      ),
    objective: { metric: "review_rate", direction: "minimize" },
    minimum_samples: overrides.minimum_samples ?? { accepted_cases: 2 },
    candidate_grid: overrides.grid ?? { accept_cutoffs: [0.6, 0.8], rejection_cutoffs: [0.6] },
    evaluator: overrides.evaluator ?? { evaluator: "scripted-test", adapter_version: "0.1.0" },
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
interface CalibrationSetup {
  readonly steps?: readonly unknown[];
  readonly evaluator?: Evaluator;
  readonly planOverrides?: Omit<Parameters<typeof plan>[0], "definitionHash">;
  readonly options?: Record<string, unknown>;
}

/** One bound calibration: the definition hash, the plan, the files, and the calls. */
async function bind(setup: CalibrationSetup = {}): Promise<{
  readonly definitionHash: string;
  readonly planText: string;
  readonly files: FileAccess & { reads: string[] };
  readonly calls: readonly EvaluatorRequest[];
  readonly clock: FakeClock;
  readonly options: (extra?: Record<string, unknown>) => Promise<Calibration>;
}> {
  const clock = new FakeClock(START_MS);
  const dataset = datasetTexts();
  // The exploration-free load states the definition hash that the plan binds.
  const bare = await load(notes);
  const definitionHash = bare.definitionHash;
  const evaluator =
    setup.evaluator ??
    createScriptedEvaluator({
      steps: [...(setup.steps ?? []), ...FITTING_STEPS, ...VALIDATION_STEPS].map((step) =>
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
  const planText = plan({ definitionHash, ...setup.planOverrides });
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
    sampling: "grouped_cases",
    evaluationReports: ["reports/message-supported-validation.json"],
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
    ...(setup.options ?? {}),
  };
  return {
    definitionHash,
    planText,
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
// The successful qualification.
// ---------------------------------------------------------------------------

test("one calibration qualifies the frozen candidate and returns the artifact", async () => {
  const bound = await bind();
  const calibration = await bound.options();

  // The fitting search enumerated both candidates of the grid, measured the
  // four fitting cases, and selected the first candidate: 0.6 accepts
  // fit-2, so no case reviews and the review rate ties low at 0 of 4.
  const fitting = calibration.fitting;
  expect(fitting.status).toBe("feasible");
  expect(fitting.plan_id).toBe("message-supported-plan");
  expect(fitting.candidate_count).toBe(2);
  expect(fitting.case_count).toBe(4);
  expect(fitting.dataset).toBe("calibration-cases");
  expect(fitting.split).toBe("fit");
  expect(fitting.selected?.index).toBe(0);
  expect(fitting.selected?.candidate).toEqual({
    accept_cutoff: 0.6,
    rejection_cutoff: 0.6,
    confidence_floor: null,
  });
  // fit-4 is one wrong case among three accepted: 1 of 3 meets 0.5.
  const goal = fitting.selected?.constraints[0];
  expect(goal?.met).toBe(true);
  expect(goal?.numerator).toBe(1);
  expect(goal?.denominator).toBe(3);
  expect(fitting.candidates.map((candidate) => candidate.feasible)).toEqual([true, true]);

  // The frozen validation replayed the three validation cases under the
  // frozen policy: two accepted cases with one wrong among them meet the
  // declared goal and the plan minimum, so the evidence establishes the
  // declared scope.
  const qualification = calibration.qualification;
  expect(qualification).toBeDefined();
  expect(qualification?.method).toBe("frozen_validation");
  expect(qualification?.split).toBe("holdout");
  expect(qualification?.case_count).toBe(3);
  expect(qualification?.candidate).toEqual(fitting.selected?.candidate);
  expect(qualification?.status).toBe("validated_for_scope");
  expect(qualification?.reasons.map((reason) => reason.code)).toEqual(["measured_evidence"]);
  const validated = qualification?.goals[0];
  expect(validated?.met).toBe(true);
  expect(validated?.numerator).toBe(1);
  expect(validated?.denominator).toBe(2);
  expect(qualification?.sample_requirements).toEqual([
    { denominator: "accepted_cases", stated: 2, measured: 2, met: true },
  ]);
  expect(qualification?.evidence.class).toBe("independent_validation");

  // The candidate profile records the complete evidence, the frozen policy
  // on both question checks, the measured performance, and the computed
  // qualification. Nothing here promotes it.
  const profile = calibration.profile;
  expect(profile.schema_version).toBe(1);
  expect(profile.origin).toBe("calibration");
  expect(profile.id).toBe("message-supported-calibrated");
  expect(profile.qualification.status).toBe("validated_for_scope");
  expect(profile.qualification.reasons).toEqual(["measured_evidence"]);
  expect(profile.policy.family).toBe("probability_mass_v0");
  expect(profile.policy.checks).toEqual([
    { check: "message-supported", accept_cutoff: 0.6, rejection_cutoff: 0.6 },
  ]);
  expect(profile.evidence?.plan).toEqual({
    id: "message-supported-plan",
    content_hash: fitting.plan_content_hash,
  });
  expect(profile.evidence?.datasets).toEqual([
    {
      id: "calibration-cases",
      revision: "2026-09-24.1",
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  ]);
  expect(profile.evidence?.splits).toEqual([
    { id: "fit", content_hash: fitting.split_content_hash },
    { id: "holdout", content_hash: qualification?.split_content_hash },
  ]);
  expect(profile.evidence?.evaluation_reports).toEqual([
    "reports/message-supported-validation.json",
  ]);
  expect(profile.evidence?.statistical_method).toBe(qualification?.method_statement);
  // The plan states no model alias, so the binding records no model object.
  // The resolved version of the measurements stays in the run records.
  expect(profile.bindings[0]?.model).toBeUndefined();
  expect(calibration.runs[0]?.checks[0]?.evaluator?.model_resolved).toBe("scripted-1.4.0");
  const errorMetric = profile.performance?.metrics?.find(
    (metric) => metric.scope === "all_checks" && metric.metric === "error_among_accepted",
  );
  expect(errorMetric).toEqual({ scope: "all_checks", metric: "error_among_accepted", numerator: 1, denominator: 2, value: 0.5 });
  expect(profile.performance?.sample_counts).toEqual({ accepted_cases: 2 });

  // The measurement record: one run per case of both splits, in measurement
  // order, each holding one raw assessment of the question check and the
  // exact rule record beside it.
  expect(calibration.runs.map((run) => run.case.id)).toEqual([
    "fit-1",
    "fit-2",
    "fit-3",
    "fit-4",
    "hold-1",
    "hold-2",
    "hold-3",
  ]);
  expect(calibration.runs.every((run) => run.completion.status === "completed")).toBe(true);
  expect(calibration.runs[0]?.checks.map((check) => check.kind)).toEqual([
    "question",
    "rule",
  ]);
  expect(calibration.limitations).toContain(fitting.statement);
  expect(calibration.limitations).toContain(qualification?.statement ?? "");
});

test("the measurements carry no reference label and the event loop keeps running", async () => {
  const bound = await bind();
  let loopTurned = false;
  queueMicrotask(() => {
    loopTurned = true;
  });
  await bound.options();

  // Every evaluator request carries the projected inputs alone: no
  // reference label, no expected outcome, no group, and no provenance.
  expect(bound.calls.length).toBe(7);
  for (const request of bound.calls) {
    expect(request.check).toBe("message-supported");
    expect(Object.keys(request.inputs).sort()).toEqual([
      "conversation",
      "prior_decision",
      "proposed_message",
    ]);
    expect(JSON.stringify(request.inputs)).not.toContain("expected");
    expect(JSON.stringify(request.inputs)).not.toContain("reviewer-1");
  }
  // The native fitting and validation computations run off the event loop,
  // so the loop turned while the calibration ran.
  expect(loopTurned).toBe(true);
});

test("the same calibration returns the same candidate content hash", async () => {
  const first = await (await bind()).options();
  const second = await (await bind()).options();
  expect(second.profile.content_hash).toBe(first.profile.content_hash);
  expect(second.fitting).toEqual(first.fitting);
  expect(second.qualification).toEqual(first.qualification);
});

test("the returned profile loads and enforcement still needs the host selection", async () => {
  const bound = await bind();
  const calibration = await bound.options();
  const profileText = JSON.stringify(calibration.profile);

  // The host loads the stored artifact through the public boundary.
  const files = memoryFiles({ "/profiles/candidate.json": profileText });
  const reviewer = await load(notes, {
    profile: "/profiles/candidate.json",
    evaluators: registerEvaluators(
      createScriptedEvaluator({ steps: [answer(0.95, 0.03, 0.02)] as never }),
    ),
    files,
  });
  expect(reviewer.profile?.content_hash).toBe(calibration.profile.content_hash);
  const report = await reviewer.run({
    id: "case-after-calibration",
    input: {
      prior_decision: "Customer exports stay in the EU.",
      conversation: "The new export worker stays in the EU region.",
      proposed_message: "The export worker serves EU customers.",
    },
  });
  expect(report.checks[0]?.applied_policy).toEqual({
    accept_cutoff: 0.6,
    rejection_cutoff: 0.6,
  });

  // The calibration promoted nothing: enforcement refuses the validated
  // candidate until the host states the reviewed content hash itself, and
  // the scope clause still compares the requested scope.
  const noSelection = await failureOf(() =>
    reviewer.run(
      {
        id: "case-enforcement",
        input: {
          prior_decision: "Customer exports stay in the EU.",
          conversation: "The new export worker stays in the EU region.",
          proposed_message: "The export worker serves EU customers.",
        },
      },
      { mode: "enforcement" },
    ),
  );
  expect(noSelection.code).toBe("profile_not_selected");
  const wrongScope = await failureOf(() =>
    reviewer.run(
      {
        id: "case-enforcement",
        input: {
          prior_decision: "Customer exports stay in the EU.",
          conversation: "The new export worker stays in the EU region.",
          proposed_message: "The export worker serves EU customers.",
        },
      },
      {
        mode: "enforcement",
        selectedProfileHash: calibration.profile.content_hash,
        scope: "another population",
      },
    ),
  );
  expect(wrongScope.code).toBe("scope_mismatch");
});

// ---------------------------------------------------------------------------
// The results that establish no goal.
// ---------------------------------------------------------------------------

test("evidence below the plan minimum states insufficient evidence", async () => {
  // The plan demands three accepted cases. The fitting split meets it with
  // three, so one candidate is feasible; the validation split holds two, so
  // the plan itself declares the evidence too small and the goal rows and
  // the sample requirement state the counts.
  const bound = await bind({
    planOverrides: { minimum_samples: { accepted_cases: 3 } },
  });
  const calibration = await bound.options();

  expect(calibration.fitting.selected?.index).toBe(0);
  const qualification = calibration.qualification;
  expect(qualification?.status).toBe("insufficient_evidence");
  expect(qualification?.reasons.map((reason) => reason.code)).toContain("insufficient_evidence");
  expect(qualification?.sample_requirements[0]).toEqual({
    denominator: "accepted_cases",
    stated: 3,
    measured: 2,
    met: false,
  });
  expect(calibration.profile.qualification.status).toBe("insufficient_evidence");
  expect(calibration.profile.qualification.reasons).toContain("insufficient_evidence");
  // The policy stays the frozen one: the evidence fell short, the goals
  // stayed as declared, and nothing was retuned.
  expect(calibration.profile.policy.checks).toEqual([
    { check: "message-supported", accept_cutoff: 0.6, rejection_cutoff: 0.6 },
  ]);
});

test("one measured goal that fails its limit states criteria not met", async () => {
  // The limit 0.4 holds on the fitting split (1 of 3) and fails on the
  // validation split (1 of 2), so the frozen candidate is validated against
  // evidence that refuses it.
  const bound = await bind({
    planOverrides: {
      constraints: [
        {
          metric: "error_among_accepted",
          comparison: "at_most",
          limit: 0.4,
          basis: "observed_value",
        },
      ],
    },
  });
  const calibration = await bound.options();

  expect(calibration.fitting.selected?.index).toBe(0);
  const qualification = calibration.qualification;
  expect(qualification?.status).toBe("criteria_not_met");
  expect(qualification?.reasons.map((reason) => reason.code)).toEqual(["criteria_not_met"]);
  const goal = qualification?.goals[0];
  expect(goal?.met).toBe(false);
  expect(goal?.numerator).toBe(1);
  expect(goal?.denominator).toBe(2);
  expect(goal?.limit).toBe(0.4);
  expect(calibration.profile.qualification.status).toBe("criteria_not_met");
  // Validation feedback selected nothing: the policy is the candidate the
  // development data chose, not one the validation data prefers.
  expect(calibration.profile.policy.checks).toEqual([
    { check: "message-supported", accept_cutoff: 0.6, rejection_cutoff: 0.6 },
  ]);
});

test("no feasible candidate is one valid result that spends no validation budget", async () => {
  // The limit 0.2 fits no candidate of the grid: the first accepts one
  // wrong case of three and the second one of two. The calibration returns
  // one candidate profile with the unmet goals, and the validation split
  // stays unmeasured, because no frozen candidate exists to validate.
  const bound = await bind({
    planOverrides: {
      constraints: [
        {
          metric: "error_among_accepted",
          comparison: "at_most",
          limit: 0.2,
          basis: "observed_value",
        },
      ],
    },
  });
  const calibration = await bound.options();

  const fitting = calibration.fitting;
  expect(fitting.status).toBe("no_feasible_candidate");
  expect(fitting.selected).toBeNull();
  expect(fitting.candidates.every((candidate) => !candidate.feasible)).toBe(true);
  expect(calibration.qualification).toBeUndefined();
  // Only the four fitting cases were measured.
  expect(calibration.runs.map((run) => run.case.id)).toEqual([
    "fit-1",
    "fit-2",
    "fit-3",
    "fit-4",
  ]);
  expect(bound.calls.length).toBe(4);

  // The profile records the objective-best candidate of the family, marks
  // it criteria_not_met, and states the limit of that use.
  const profile = calibration.profile;
  expect(profile.qualification.status).toBe("criteria_not_met");
  expect(profile.qualification.reasons).toEqual(["criteria_not_met"]);
  expect(profile.policy.checks).toEqual([
    { check: "message-supported", accept_cutoff: 0.6, rejection_cutoff: 0.6 },
  ]);
  expect(profile.evidence?.statistical_method).toContain("No frozen validation ran");
  expect(profile.performance).toBeUndefined();
  expect(calibration.limitations.join(" ")).toContain(
    "No candidate of the permitted family meets the declared goals",
  );

  // The artifact still loads, and shadow use stays admitted while
  // enforcement refuses the qualification clause.
  const files = memoryFiles({ "/profiles/candidate.json": JSON.stringify(profile) });
  const reviewer = await load(notes, {
    profile: "/profiles/candidate.json",
    evaluators: registerEvaluators(
      createScriptedEvaluator({ steps: [answer(0.95, 0.03, 0.02)] as never }),
    ),
    files,
  });
  expect(reviewer.profile?.id).toBe("message-supported-calibrated");
  const refusal = await failureOf(() =>
    reviewer.run(
      {
        id: "case-enforcement",
        input: {
          prior_decision: "Customer exports stay in the EU.",
          conversation: "The new export worker stays in the EU region.",
          proposed_message: "The export worker serves EU customers.",
        },
      },
      {
        mode: "enforcement",
        selectedProfileHash: profile.content_hash,
      },
    ),
  );
  expect(refusal.code).toBe("qualification_insufficient");
});

// ---------------------------------------------------------------------------
// The refusals.
// ---------------------------------------------------------------------------

test("one aborted signal refuses the calibration without one candidate", async () => {
  // The signal aborts before the first case: nothing ran.
  const bound = await bind({ options: { signal: AbortSignal.abort() } });
  const before = await failureOf(() => bound.options());
  expect(before.code).toBe("cancelled_before_start");
  expect(bound.calls.length).toBe(0);

  // The signal aborts while one measurement is in flight: the run cancels,
  // the case stored no complete assessment set, and the calibration refuses
  // instead of fitting partial data.
  const controller = new AbortController();
  let seen = 0;
  const cancelling: Evaluator = {
    id: "scripted-test",
    adapter_version: "0.1.0",
    async assess(request: EvaluatorRequest) {
      seen += 1;
      if (seen === 3) {
        controller.abort();
      }
      return execution(0.95, 0.03, 0.02);
    },
  };
  const cancellingBound = await bind({
    evaluator: cancelling,
    options: { signal: controller.signal },
  });
  const during = await failureOf(() => cancellingBound.options());
  expect(during.code).toBe("run_cancelled");
  expect(during.fieldPath).toBe("/cases/fit-3");
  expect(seen).toBe(3);
});

test("one evaluator failure on one measured case refuses the calibration", async () => {
  // The third measurement reports one operational failure. One attempt is
  // stated, so the record keeps the evaluator code and the calibration
  // refuses with it: no search may invent the missing assessment.
  const bound = await bind({
    steps: [
      answer(0.95, 0.03, 0.02),
      answer(0.75, 0.15, 0.1),
      { failure: { code: "evaluator_timeout", message: "The provider timed out." } },
    ],
    options: { execution: { max_attempts: 1, backoff_ms: 0 } },
  });
  const failure = await failureOf(() => bound.options());
  expect(failure.code).toBe("evaluator_timeout");
  expect(failure.fieldPath).toBe("/assessments/fit-3/message-supported");
  expect(failure.message).toContain("The provider timed out.");
  expect(bound.calls.length).toBe(3);
});

test("two resolved model versions refuse the candidate binding", async () => {
  const steps = [
    answer(0.95, 0.03, 0.02, "scripted-1.4.0"),
    answer(0.75, 0.15, 0.1, "scripted-1.5.0"),
  ];
  const bound = await bind({
    steps: [...steps, ...FITTING_STEPS.slice(2), ...VALIDATION_STEPS],
  });
  const failure = await failureOf(() => bound.options());
  expect(failure.code).toBe("model_resolution_changed");
  expect(failure.message).toContain("scripted-1.4.0");
  expect(failure.message).toContain("scripted-1.5.0");
});

test("the binding checks of the plan cross before one case is measured", async () => {
  // One plan that names one unregistered evaluator.
  const unregistered = await bind({
    planOverrides: { evaluator: { evaluator: "jev-choice", adapter_version: "0.1.0" } },
  });
  const evaluatorFailure = await failureOf(() => unregistered.options());
  expect(evaluatorFailure.code).toBe("evaluator_mismatch");
  expect(evaluatorFailure.fieldPath).toBe("/plan/evaluator/evaluator");
  expect(unregistered.calls.length).toBe(0);

  // One plan whose fitting selection names the validation split.
  const swapped = await bind({
    planOverrides: { fittingSplit: "holdout", validationSplit: "fit" },
  });
  const splitFailure = await failureOf(() => swapped.options());
  expect(splitFailure.code).toBe("invalid_field_type");
  expect(splitFailure.fieldPath).toBe("/plan/datasets/fitting/split");
  expect(swapped.calls.length).toBe(0);

  // One plan that names one split the dataset does not declare.
  const absent = await bind({ planOverrides: { validationSplit: "absent" } });
  const absentFailure = await failureOf(() => absent.options());
  expect(absentFailure.code).toBe("invalid_field_type");
  expect(absentFailure.fieldPath).toBe("/plan/datasets/validation/split");
  expect(absent.calls.length).toBe(0);
});

test("one calibration states its complete procedure", async () => {
  const bound = await bind();
  const noSampling = await failureOf(() =>
    bound.options({ sampling: undefined as never }),
  );
  expect(noSampling.code).toBe("missing_field");
  expect(noSampling.fieldPath).toBe("/sampling");

  const unknownSampling = await failureOf(() =>
    bound.options({ sampling: "every_case" as never }),
  );
  expect(unknownSampling.code).toBe("invalid_field_type");

  const noReports = await failureOf(() =>
    bound.options({ evaluationReports: undefined as never }),
  );
  expect(noReports.code).toBe("missing_field");
  expect(noReports.fieldPath).toBe("/evaluationReports");

  const emptyReports = await failureOf(() => bound.options({ evaluationReports: [] }));
  expect(emptyReports.code).toBe("invalid_field_type");
  expect(emptyReports.fieldPath).toBe("/evaluationReports");

  const longReference = await failureOf(() =>
    bound.options({ evaluationReports: ["x".repeat(501)] }),
  );
  expect(longReference.code).toBe("invalid_field_type");
  expect(longReference.fieldPath).toBe("/evaluationReports/0");

  const noRegistry = await failureOf(() =>
    bound.options({ evaluators: {} as never }),
  );
  expect(noRegistry.code).toBe("invalid_field_type");
  expect(noRegistry.fieldPath).toBe("/evaluators");
});

test("an exact-only definition takes no calibration plan", async () => {
  const exact = defineChecks({
    version: 1,
    name: "delivery-limits",
    inputs: Type.Object(
      { text: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    checks: [
      {
        id: "text-length",
        name: "The text fits the limit",
        using: ["text"],
        rule: { maxLength: 10 },
      },
    ],
  });
  const bare = await load(exact);
  const bound = await bind();
  const failure = await failureOf(() =>
    calibrate(exact, {
      plan: "/plan/calibration-plan.json",
      metadata: "/datasets/metadata.json",
      records: "/datasets/cases.jsonl",
      evaluators: registerEvaluators(createScriptedEvaluator({ steps: [] })),
      sampling: "grouped_cases",
      evaluationReports: ["reports/delivery-limits.json"],
      files: memoryFiles({
        "/plan/calibration-plan.json": plan({
          definitionHash: bare.definitionHash,
          ...(() => {
            const artifact = JSON.parse(bound.planText);
            return { constraints: artifact.constraints, minimum_samples: artifact.minimum_samples };
          })(),
        }),
        "/datasets/metadata.json": JSON.stringify({
          schema_version: 1,
          id: "calibration-cases",
          revision: "2026-09-24.1",
          kind: "representative_sample",
          intended_population: "Delivery texts.",
          sampling_method: "Sampled at random.",
          label_guidelines: "See docs/labeling.md revision 3.",
          splits: [
            { id: "fit", purpose: "fitting", groups: ["conversation-a"] },
            { id: "holdout", purpose: "validation", groups: ["conversation-b"] },
          ],
        }),
        "/datasets/cases.jsonl": [
          JSON.stringify({
            id: "limit-case-1",
            group: "conversation-a",
            input: { text: "short" },
            expected: { checks: { "text-length": { outcome: "pass" } }, outcome: "pass" },
            label: { author_type: "human", reviewed: true },
          }),
          JSON.stringify({
            id: "limit-case-2",
            group: "conversation-b",
            input: { text: "also short" },
            expected: { checks: { "text-length": { outcome: "pass" } }, outcome: "pass" },
            label: { author_type: "human", reviewed: true },
          }),
        ].join("\n"),
      }),
    }),
  );
  expect(failure.code).toBe("policy_mismatch");
  expect(failure.fieldPath).toBe("/plan/candidate_grid");
});

test("a plan that binds another definition refuses before any spend", async () => {
  const other = defineChecks({
    version: 1,
    name: "consequence-level",
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
        id: "consequence-level",
        name: "The consequence level is bounded",
        using: ["proposed_message"],
        question: "How severe is the consequence?",
        scale: [
          { minor: "One user notices." },
          { moderate: "Several users notice." },
          { severe: "The service fails." },
        ],
        accept: { at_least: "minor" },
      },
    ],
  });
  const bound = await bind();
  const failure = await failureOf(() =>
    calibrate(other, {
      plan: "/plan/calibration-plan.json",
      metadata: "/datasets/metadata.json",
      records: "/datasets/cases.jsonl",
      evaluators: registerEvaluators(createScriptedEvaluator({ steps: [] })),
      sampling: "grouped_cases",
      evaluationReports: ["reports/consequence-level.json"],
      files: bound.files,
    }),
  );
  expect(failure.code).toBe("definition_mismatch");
  expect(failure.fieldPath).toBe("/plan/definition");
  expect(bound.calls.length).toBe(0);
});

// ---------------------------------------------------------------------------
// The definition artifact as one explicit path.
// ---------------------------------------------------------------------------

test("one calibration reads the definition from one explicit path", async () => {
  const bound = await bind();
  const artifact = (await load(notes)).definition as Definition;
  const files = memoryFiles({
    "/definitions/message-supported.json": JSON.stringify(artifact),
    "/plan/calibration-plan.json": bound.planText,
    "/datasets/metadata.json": await bound.files.read("/datasets/metadata.json"),
    "/datasets/cases.jsonl": await bound.files.read("/datasets/cases.jsonl"),
  });
  const calibration = await calibrate("/definitions/message-supported.json", {
    plan: "/plan/calibration-plan.json",
    metadata: "/datasets/metadata.json",
    records: "/datasets/cases.jsonl",
    evaluators: registerEvaluators(
      createScriptedEvaluator({
        steps: [...FITTING_STEPS, ...VALIDATION_STEPS] as never,
      }),
    ),
    sampling: "grouped_cases",
    evaluationReports: ["reports/message-supported-validation.json"],
    files,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  expect(calibration.profile.id).toBe("message-supported-calibrated");
  expect(calibration.qualification?.status).toBe("validated_for_scope");
  // The definition crossed as one explicit path, and the loader read it
  // exactly once.
  expect(files.reads).toContain("/definitions/message-supported.json");
});

test("one calculation above the published fitting budget refuses explicitly", async () => {
  // The plan permits more candidates than the fitting budget measures. The
  // core refuses the grid with its count instead of truncating the family,
  // and the refusal crosses the async boundary after the measurements, with
  // no candidate and no spend beyond them.
  const cutoffs = Array.from({ length: 1025 }, (_, index) =>
    Number((0.5 + (index + 1) / 2050).toFixed(10)),
  );
  const bound = await bind({
    planOverrides: {
      constraints: [
        {
          metric: "error_among_accepted",
          comparison: "at_most",
          limit: 1,
          basis: "observed_value",
        },
      ],
      minimum_samples: { accepted_cases: 1 },
      grid: { accept_cutoffs: cutoffs, rejection_cutoffs: [0.6] },
    },
  });
  const failure = await failureOf(() => bound.options());
  expect(failure.code).toBe("invalid_field_type");
  expect(failure.fieldPath).toBe("/plan/candidate_grid");
  expect(failure.message).toContain("1025");
  // The four fitting cases were measured, because the budget refusal comes
  // from the search itself.
  expect(bound.calls.length).toBe(4);
});

test("one plan that requests one model records the resolved version", async () => {
  const bound = await bind({
    planOverrides: {
      evaluator: {
        evaluator: "scripted-test",
        adapter_version: "0.1.0",
        model_requested: "scripted-alias",
      },
    },
  });
  const calibration = await bound.options();
  // The measurement profile requested the alias of the plan and the
  // executions resolved one version, so the candidate binding records both.
  expect(calibration.profile.bindings[0]?.model).toEqual({
    requested: "scripted-alias",
    resolved: "scripted-1.4.0",
  });
  expect(calibration.qualification?.status).toBe("validated_for_scope");
});
