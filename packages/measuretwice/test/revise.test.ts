// SPDX-License-Identifier: Apache-2.0
/**
 * Revise API tests.
 *
 * These tests cover task T052: one policy-only revision reuses the stored
 * assessments of one compatible calibration for fitting, and one new
 * qualification claim still needs independent validation before promotion.
 * The tests build one real prior calibration through `calibrate`, revise
 * it over one fresh validation split of one later dataset revision and
 * over the consumed holdout of the same revision, and pin the reuse
 * identity refusals: one changed question, schema, or projection, one
 * changed adapter, translation, or model, and one edited fitting input
 * each refuse with the compatibility code of the registry before one
 * assessment is replayed. The consumed holdout never validates one revised
 * policy, however better the revised candidate looks on development data,
 * and every revision returns one new profile with its own content hash
 * while the prior artifact stays unchanged. The adapter is the scripted
 * test evaluator, so the tests read local files only and stay offline and
 * deterministic.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import {
  calibrate,
  defineChecks,
  load,
  registerEvaluators,
  revise,
  ValidationError,
  type Revision,
  type CalibrateOptions,
  type Calibration,
  type Definition,
  type Evaluator,
  type EvaluatorRequest,
  type FileAccess,
  type ReviseOptions,
} from "../src/index.js";
import { createScriptedEvaluator } from "../src/test-evaluator.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

/** The fixed start time of every test: 25 September 2026, UTC. */
const START_MS = Date.UTC(2026, 8, 25, 0, 0, 0);

/** The adapter version of the scripted evaluator of the prior calibration. */
const PRIOR_ADAPTER = "0.1.0";

/**
 * One definition with one categorical question and one exact rule, so one
 * revision replays both kinds and the changed cases state the aggregate.
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

/**
 * One definition with one changed question wording, one changed input
 * schema, and one changed projection: every mutation changes the content
 * hash of the definition.
 */
function mutatedNotes(mutation: "question" | "schema" | "projection"): Definition {
  const inputs = {
    prior_decision: Type.String({ minLength: 1 }),
    conversation: Type.String({ minLength: 1 }),
    proposed_message:
      mutation === "schema" ? Type.String({ minLength: 2 }) : Type.String({ minLength: 1 }),
  };
  return defineChecks({
    version: 1,
    name: "message-supported",
    inputs: Type.Object(inputs, { additionalProperties: false }),
    checks: [
      {
        id: "message-supported",
        name: "Our message accurately describes the evidence",
        using:
          mutation === "projection"
            ? (["prior_decision", "conversation"] as const)
            : (["prior_decision", "conversation", "proposed_message"] as const),
        question:
          mutation === "question"
            ? "Does every claim follow from the evidence?"
            : "Does every material claim follow from the evidence?",
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
}

/** One categorical step with its mass on the three declared answers. */
function answer(
  supported: number,
  incomplete: number,
  contradicted: number,
  model = "scripted-1.4.0",
): { readonly answer: { readonly assessment: unknown; readonly model_resolved?: string } } {
  const entries = [
    { name: "supported", mass: supported },
    { name: "incomplete", mass: incomplete },
    { name: "contradicted", mass: contradicted },
  ];
  const best = entries.reduce((top, entry) => (entry.mass > top.mass ? entry : top), entries[0]!);
  return {
    answer: {
      assessment: {
        kind: "categorical",
        label: best!.name,
        distribution: entries,
      },
      ...(model === undefined ? {} : { model_resolved: model }),
    },
  };
}

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

/**
 * The fitting cases of the shared tests. Every number is stated in the
 * test that reads it.
 *
 * - `fit-1`: reference pass, mass 0.95 on `supported`.
 * - `fit-2`: reference pass, mass 0.75 on `supported`.
 * - `fit-3`: reference fail, mass 0.90 on `contradicted`.
 * - `fit-4`: reference fail, mass 0.70 on `supported`, so the moderately
 *   confident wrong case accepts at one 0.6 cutoff and reviews at 0.8.
 */
const FITTING_RECORDS = [
  record("fit-1", "conversation-a", "supported"),
  record("fit-2", "conversation-a", "supported"),
  record("fit-3", "conversation-a", "contradicted"),
  record("fit-4", "conversation-a", "contradicted"),
];

/** The scripted answers of the fitting cases, in record order. */
const FITTING_STEPS = [
  answer(0.95, 0.03, 0.02),
  answer(0.75, 0.15, 0.1),
  answer(0.05, 0.05, 0.9),
  answer(0.7, 0.2, 0.1),
];

/** The validation cases of the prior dataset revision. */
const HOLDOUT_RECORDS = [
  record("hold-1", "conversation-b", "supported"),
  record("hold-2", "conversation-b", "contradicted"),
  record("hold-3", "conversation-b", "contradicted"),
];

/** The scripted answers of the prior validation cases, in record order. */
const HOLDOUT_STEPS = [
  answer(0.95, 0.03, 0.02),
  answer(0.05, 0.1, 0.85),
  answer(0.85, 0.1, 0.05),
];

/** The fresh validation cases of the later dataset revision. */
const FRESH_RECORDS = [
  record("fresh-1", "conversation-c", "supported"),
  record("fresh-2", "conversation-c", "contradicted"),
  record("fresh-3", "conversation-c", "contradicted"),
];

/** The scripted answers of the fresh validation cases, in record order. */
const FRESH_STEPS = [
  answer(0.95, 0.03, 0.02),
  answer(0.05, 0.05, 0.9),
  answer(0.65, 0.25, 0.1),
];

/** One metadata artifact of one dataset revision with two splits. */
function metadata(revision: string, validationGroup: string): string {
  return JSON.stringify({
    schema_version: 1,
    id: "calibration-cases",
    name: "Calibration cases",
    revision,
    kind: "representative_sample",
    intended_population: "Proposed messages in support conversations.",
    sampling_method: "Sampled at random from reviewed traffic of one week.",
    label_guidelines: "See docs/labeling.md revision 3.",
    languages: ["en"],
    splits: [
      { id: "fit", purpose: "fitting", groups: ["conversation-a"] },
      { id: "holdout", purpose: "validation", groups: [validationGroup] },
    ],
  });
}

/** One plan artifact over the shared definition. */
function plan(overrides: {
  readonly id?: string;
  readonly constraints?: unknown;
  readonly minimum_samples?: unknown;
  readonly grid?: unknown;
  readonly evaluator?: unknown;
  readonly definitionHash?: string;
  readonly revision?: string;
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
    evaluator: overrides.evaluator ?? { evaluator: "scripted-test", adapter_version: PRIOR_ADAPTER },
    datasets: {
      fitting: { dataset: "calibration-cases", revision: overrides.revision ?? "2026-09-24.1", split: "fit" },
      validation: {
        dataset: "calibration-cases",
        revision: overrides.revision ?? "2026-09-24.1",
        split: "holdout",
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

/**
 * Runs one complete prior calibration over the first dataset revision.
 *
 * The prior plan accepts the 0.6 cutoff: three accepted fitting cases
 * with one wrong among them meet the 0.5 error goal, the review rate ties
 * low at zero, and the frozen candidate validates on the holdout of the
 * same revision.
 */
async function priorCalibration(evaluator?: Evaluator): Promise<{
  readonly prior: Calibration;
  readonly definitionHash: string;
  readonly files: FileAccess;
}> {
  const clock = new FakeClock(START_MS);
  const bare = await load(notes);
  const definitionHash = bare.definitionHash;
  const files = memoryFiles({
    "/prior/plan/calibration-plan.json": plan({ definitionHash }),
    "/prior/datasets/metadata.json": metadata("2026-09-24.1", "conversation-b"),
    "/prior/datasets/cases.jsonl": [...FITTING_RECORDS, ...HOLDOUT_RECORDS].join("\n"),
  });
  const options: CalibrateOptions = {
    plan: "/prior/plan/calibration-plan.json",
    metadata: "/prior/datasets/metadata.json",
    records: "/prior/datasets/cases.jsonl",
    evaluators: registerEvaluators(
      evaluator ??
        createScriptedEvaluator({ steps: [...FITTING_STEPS, ...HOLDOUT_STEPS] as never }),
    ),
    sampling: "grouped_cases",
    evaluationReports: ["reports/message-supported-validation.json"],
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
  };
  const prior = await calibrate(notes, options);
  expect(prior.profile.qualification.status).toBe("validated_for_scope");
  return { prior, definitionHash, files };
}

/** The options of one revision of the shared tests. */
interface RevisionSetup {
  /** The evaluator of the revision registry. The prior calibration always measures with the shared adapter. */
  readonly revisionEvaluator?: Evaluator;
  readonly planOverrides?: Omit<Parameters<typeof plan>[0], "definitionHash">;
  readonly revision?: string;
  readonly validationGroup?: string;
  readonly records?: string;
  readonly options?: Record<string, unknown>;
}

/** One revision bound over one real prior calibration. */
interface Bound {
  readonly prior: Calibration;
  readonly definitionHash: string;
  readonly calls: readonly EvaluatorRequest[];
  readonly base: ReviseOptions;
  readonly options: (extra?: Record<string, unknown>) => Promise<Revision>;
}

/**
 * Binds one revision over one real prior calibration: the revision plan
 * and the dataset of the stated revision, with the calls of the scripted
 * evaluator of the revision registry. The prior calibration always
 * measures with the shared scripted adapter, so one changed registry
 * changes the live state alone.
 */
async function bound(setup: RevisionSetup = {}): Promise<Bound> {
  const { prior, definitionHash } = await priorCalibration();
  const revision = setup.revision ?? "2026-09-24.1";
  const validationGroup = setup.validationGroup ?? "conversation-b";
  const records =
    setup.records ??
    (validationGroup === "conversation-b"
      ? [...FITTING_RECORDS, ...HOLDOUT_RECORDS].join("\n")
      : [...FITTING_RECORDS, ...FRESH_RECORDS].join("\n"));
  const evaluator =
    setup.revisionEvaluator ??
    createScriptedEvaluator({
      steps: (validationGroup === "conversation-b" ? [] : FRESH_STEPS) as never,
    });
  const scripted = evaluator as unknown as { calls?: EvaluatorRequest[] };
  const clock = new FakeClock(START_MS);
  const files = memoryFiles({
    "/revision/plan/revision-plan.json": plan({
      definitionHash,
      id: "message-supported-revision",
      constraints: [
        {
          metric: "error_among_accepted",
          comparison: "at_most",
          limit: 0.25,
          basis: "observed_value",
        },
      ],
      minimum_samples: { accepted_cases: 1 },
      grid: { accept_cutoffs: [0.6, 0.8], rejection_cutoffs: [0.6] },
      revision,
      ...setup.planOverrides,
    }),
    "/revision/datasets/metadata.json": metadata(revision, validationGroup),
    "/revision/datasets/cases.jsonl": records,
  });
  const base: ReviseOptions = {
    prior,
    plan: "/revision/plan/revision-plan.json",
    metadata: "/revision/datasets/metadata.json",
    records: "/revision/datasets/cases.jsonl",
    evaluators: registerEvaluators(evaluator),
    sampling: "grouped_cases",
    evaluationReports: ["reports/message-supported-revision.json"],
    files,
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
    setTimer: (atMs, onWake) => clock.setTimer(atMs, onWake),
    ...(setup.options ?? {}),
  };
  return {
    prior,
    definitionHash,
    calls: scripted.calls ?? [],
    base,
    options: (extra) => revise(notes, { ...base, ...(extra ?? {}) } as never),
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
// The revision over one fresh validation split.
// ---------------------------------------------------------------------------

test("one revision over one fresh split reuses the fitting assessments", async () => {
  const bound = await boundRevision();
  const revision = await bound.options();

  // The fitting search replayed the four stored assessments and measured
  // nothing on the fitting split: only the three fresh validation cases
  // reached the evaluator.
  expect(bound.calls.length).toBe(3);
  expect(bound.calls.every((call) => call.check === "message-supported")).toBe(true);
  const reuse = revision.reuse;
  expect(reuse.prior_profile_id).toBe("message-supported-calibrated");
  expect(reuse.prior_profile_content_hash).toBe(bound.prior.profile.content_hash);
  expect(reuse.stored_fitting_cases).toBe(4);
  expect(reuse.validation_data).toEqual({ disposition: "fresh", });
  expect(reuse.fitting_split.id).toBe("fit");
  expect(reuse.validation_split.id).toBe("holdout");
  expect(reuse.validation_split.record_count).toBe(3);
  expect(reuse.resolved_models).toEqual(["scripted-1.4.0"]);
  expect(reuse.bindings[0]?.evaluator).toBe("scripted-test");
  expect(reuse.statement).toContain("4 cases");
  expect(reuse.statement).toContain("measures it through the registered evaluator");

  // The revised plan refuses the 0.6 cutoff its prior accepted: the error
  // among the three accepted fitting cases sits above the tighter 0.25
  // goal. The 0.8 cutoff accepts two cases without one error, so the
  // search freezes it.
  const fitting = revision.fitting;
  expect(fitting.status).toBe("feasible");
  expect(fitting.plan_id).toBe("message-supported-revision");
  expect(fitting.case_count).toBe(4);
  expect(fitting.selected?.candidate).toEqual({
    accept_cutoff: 0.8,
    rejection_cutoff: 0.6,
    confidence_floor: null,
  });
  expect(fitting.candidates.map((candidate) => candidate.feasible)).toEqual([false, true]);

  // The fresh validation cases never served one claim, so the frozen
  // candidate validates on fresh independent evidence.
  const qualification = revision.qualification;
  expect(qualification?.status).toBe("validated_for_scope");
  expect(qualification?.evidence.class).toBe("independent_validation");
  expect(qualification?.evidence.needs_fresh_evidence).toBe(false);
  expect(qualification?.split).toBe("holdout");
  expect(qualification?.case_count).toBe(3);
  expect(revision.runs.map((run) => run.case.id)).toEqual(["fresh-1", "fresh-2", "fresh-3"]);
});

// ---------------------------------------------------------------------------
// The new profile and the unchanged prior artifact.
// ---------------------------------------------------------------------------

test("one policy change records one new profile and edits no prior artifact", async () => {
  const bound = await boundRevision();
  const before = JSON.stringify(bound.prior);
  const revision = await bound.options();

  // The revised profile is one new artifact: its own identifier, its own
  // content hash, the frozen 0.8 policy, and the complete evidence of the
  // revision plan and the later dataset revision.
  const profile = revision.profile;
  expect(profile.id).toBe("message-supported-revised");
  expect(profile.origin).toBe("calibration");
  expect(profile.content_hash).not.toBe(bound.prior.profile.content_hash);
  expect(profile.qualification.status).toBe("validated_for_scope");
  expect(profile.policy.checks).toEqual([
    { check: "message-supported", accept_cutoff: 0.8, rejection_cutoff: 0.6 },
  ]);
  expect(profile.evidence?.plan).toEqual({
    id: "message-supported-revision",
    content_hash: revision.fitting.plan_content_hash,
  });
  expect(profile.evidence?.datasets).toEqual([
    {
      id: "calibration-cases",
      revision: "2026-09-24.2",
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  ]);
  expect(profile.evidence?.evaluation_reports).toEqual([
    "reports/message-supported-revision.json",
  ]);

  // The prior artifact stays byte-identical, and the revision promotes
  // nothing: the host loads the new artifact and enforcement still needs
  // one reviewed selection.
  expect(JSON.stringify(bound.prior)).toBe(before);
  const files = memoryFiles({ "/profiles/revised.json": JSON.stringify(profile) });
  const reviewer = await load(notes, {
    profile: "/profiles/revised.json",
    evaluators: registerEvaluators(
      createScriptedEvaluator({ steps: [answer(0.95, 0.03, 0.02)] as never }),
    ),
    files,
  });
  expect(reviewer.profile?.content_hash).toBe(profile.content_hash);
  const report = await reviewer.run({
    id: "case-after-revision",
    input: {
      prior_decision: "Customer exports stay in the EU.",
      conversation: "The new export worker stays in the EU region.",
      proposed_message: "The export worker serves EU customers.",
    },
  });
  expect(report.checks[0]?.applied_policy).toEqual({
    accept_cutoff: 0.8,
    rejection_cutoff: 0.6,
  });
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
      { mode: "enforcement", scope: "Proposed messages in the reviewed support traffic." },
    ),
  );
  expect(noSelection.code).toBe("profile_not_selected");
});

// ---------------------------------------------------------------------------
// The revision over the consumed holdout.
// ---------------------------------------------------------------------------

test("one consumed holdout never validates one revised policy", async () => {
  const bound = await boundConsumed();
  const revision = await bound.options();

  // The revision measured nothing at all: the fitting assessments and the
  // validation assessments of the consumed holdout replay under the
  // frozen candidate.
  expect(bound.calls.length).toBe(0);
  expect(revision.reuse.validation_data).toEqual({ disposition: "reused", cases: 3 });
  expect(revision.runs).toEqual([]);

  // The revised candidate appears better on development data: the tighter
  // 0.25 error goal that the prior candidate fails now holds with no
  // error among two accepted cases.
  const goal = revision.fitting.selected?.constraints[0];
  expect(goal?.met).toBe(true);
  expect(goal?.numerator).toBe(0);
  expect(goal?.denominator).toBe(1);
  const priorGoal = bound.prior.fitting.selected?.constraints[0];
  expect(priorGoal?.numerator).toBe(1);
  expect(priorGoal?.denominator).toBe(3);

  // The holdout was consumed by the prior claim, so it is development
  // data: the validation states insufficient evidence and needs fresh
  // independent evidence, whatever the development numbers show.
  const qualification = revision.qualification;
  expect(qualification?.status).toBe("insufficient_evidence");
  expect(qualification?.evidence.class).toBe("development");
  expect(qualification?.evidence.needs_fresh_evidence).toBe(true);
  expect(qualification?.evidence.reused_from.length).toBe(1);
  expect(qualification?.reasons[0]?.code).toBe("insufficient_evidence");

  // The new profile records the computed status, and enforcement refuses
  // it even with one stated selection, because one reused holdout
  // validates nothing.
  expect(revision.profile.qualification.status).toBe("insufficient_evidence");
  expect(revision.profile.qualification.reasons).toContain("insufficient_evidence");
  const files = memoryFiles({ "/profiles/revised.json": JSON.stringify(revision.profile) });
  const reviewer = await load(notes, {
    profile: "/profiles/revised.json",
    evaluators: registerEvaluators(
      createScriptedEvaluator({ steps: [answer(0.95, 0.03, 0.02)] as never }),
    ),
    files,
  });
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
        selectedProfileHash: revision.profile.content_hash,
        scope: "Proposed messages in the reviewed support traffic.",
      },
    ),
  );
  expect(refusal.code).toBe("qualification_insufficient");
});

// ---------------------------------------------------------------------------
// The revision comparison.
// ---------------------------------------------------------------------------

test("the revision comparison states concrete changed cases", async () => {
  const bound = await boundConsumed();
  const revision = await bound.options();
  const comparison = revision.comparison;

  // The two sides state their source and their policy.
  expect(comparison.evidence_class).toBe("fitting");
  expect(comparison.baseline.source.id).toBe("message-supported-calibrated");
  expect(comparison.baseline.source.content_hash).toBe(bound.prior.profile.content_hash);
  expect(comparison.candidate.source.id).toBe("message-supported-revision");
  expect(comparison.baseline.policy).toEqual([
    {
      check: "message-supported",
      policy: { accept_cutoff: 0.6, rejection_cutoff: 0.6 },
    },
  ]);
  expect(comparison.candidate.policy).toEqual([
    {
      check: "message-supported",
      policy: { accept_cutoff: 0.8, rejection_cutoff: 0.6 },
    },
  ]);
  expect(comparison.dataset).toBe("calibration-cases");
  expect(comparison.split).toBe("fit");

  // The 0.8 cutoff changes two concrete cases: fit-2 (0.75 mass on
  // `supported`) and fit-4 (0.70 mass with one fail reference) change
  // from one accepted case to one review, and their aggregates change
  // with them.
  expect(comparison.matching).toEqual({
    matched_cases: 4,
    changed_cases: 2,
    unchanged_cases: 2,
  });
  expect(comparison.changed.map((changed) => changed.id)).toEqual(["fit-2", "fit-4"]);
  const fit4 = comparison.changed[1];
  expect(fit4?.checks).toEqual([
    { check: "message-supported", baseline: "pass", candidate: "review" },
  ]);
  expect(fit4?.baseline_aggregate).toBe("pass");
  expect(fit4?.candidate_aggregate).toBe("review");

  // The metric rows keep the counts and the denominators of both sides
  // over the same four cases.
  const review = comparison.metrics.find(
    (row) => row.scope === "all_checks" && row.metric === "review_rate",
  );
  expect(review?.baseline).toEqual({ metric: "review_rate", numerator: 0, denominator: 4, value: 0 });
  expect(review?.candidate).toEqual({
    metric: "review_rate",
    numerator: 2,
    denominator: 4,
    value: 0.5,
  });
  expect(comparison.statement).toContain("fitting evidence");
  expect(comparison.limitations.length).toBe(2);
});

// ---------------------------------------------------------------------------
// The reuse identity refusals.
// ---------------------------------------------------------------------------

test("one changed question, schema, or projection refuses the reuse", async () => {
  const bound = await boundConsumed();
  for (const mutation of ["question", "schema", "projection"] as const) {
    const error = await failureOf(() => revise(mutatedNotes(mutation), bound.base));
    expect(error.code, mutation).toBe("definition_mismatch");
  }
});

test("one changed adapter version refuses the reuse", async () => {
  // The registry serves one later adapter version and the revision plan
  // names it, so the plan binding passes and the reuse check compares the
  // prior binding with the live state.
  const scripted = createScriptedEvaluator({ steps: [] as never });
  const evaluator: Evaluator = { ...scripted, adapter_version: "0.2.0" };
  const bound = await boundConsumed(evaluator, {
    evaluator: { evaluator: "scripted-test", adapter_version: "0.2.0" },
  });
  const error = await failureOf(() => bound.options());
  expect(error.code).toBe("evaluator_mismatch");
  expect(error.fieldPath).toBe("/plan/evaluator (the check message-supported)");
});

test("one changed translation refuses the reuse", async () => {
  // The adapter now translates the same question to one new version, so
  // the live translated question differs from the recorded binding.
  const scripted = createScriptedEvaluator({ steps: [] as never });
  const evaluator: Evaluator = {
    ...scripted,
    translate: (question) => ({
      content_hash: "b".repeat(64),
      question: { text: `${question.question} (v2)` },
    }),
  };
  const bound = await boundConsumed(evaluator);
  const error = await failureOf(() => bound.options());
  expect(error.code).toBe("translation_mismatch");
  expect(error.fieldPath).toBe("/prior/bindings/0/translation/content_hash");
});

test("one changed model resolution refuses the revision", async () => {
  // The fresh validation measurements resolve one later model version,
  // so the stored and the fresh assessments measured with two models.
  const bound = await boundRevision(
    createScriptedEvaluator({
      steps: FRESH_STEPS.map((step) =>
        step.answer.model_resolved === "scripted-1.4.0"
          ? { answer: { ...step.answer, model_resolved: "scripted-2.0.0" } }
          : step,
      ) as never,
    }),
  );
  const error = await failureOf(() => bound.options());
  expect(error.code).toBe("model_resolution_changed");
});

test("one changed fitting input refuses the reuse", async () => {
  // One edited fitting record changes the loaded fitting split, which the
  // prior profile no longer records.
  const edited = [
    ...FITTING_RECORDS.slice(0, 3),
    record("fit-4", "conversation-a", "supported"),
    ...HOLDOUT_RECORDS,
  ].join("\n");
  const bound = await boundConsumed(undefined, undefined, edited);
  const error = await failureOf(() => bound.options());
  expect(error.code).toBe("hash_mismatch");
  expect(error.fieldPath).toBe("/prior/evidence/splits");
});

test("one edited or incomplete prior calibration refuses", async () => {
  // One edited prior profile fails its stored self-hash first.
  const consumed = await boundConsumed();
  const edited = JSON.parse(JSON.stringify(consumed.prior)) as Calibration;
  const error = await failureOf(() =>
    consumed.options({ prior: { ...edited, profile: { ...edited.profile, id: "renamed" } } }),
  );
  expect(error.code).toBe("hash_mismatch");

  // One dropped measurement run leaves one fitting case without one
  // stored assessment.
  const errorRuns = await failureOf(() =>
    consumed.options({ prior: { ...edited, runs: edited.runs.slice(1) } }),
  );
  expect(errorRuns.code).toBe("missing_field");

  // One prior with no fitting report or no runs states no complete reuse.
  const noFitting = await failureOf(() =>
    consumed.options({ prior: { ...edited, fitting: undefined } }),
  );
  expect(noFitting.code).toBe("invalid_field_type");
  expect(noFitting.fieldPath).toBe("/prior");
});

test("the option checks refuse one absent or wrongly shaped input", async () => {
  const consumed = await boundConsumed();
  const base = consumed.base;
  await expect(revise(notes, { ...base, prior: undefined as never })).rejects.toMatchObject({
    code: "missing_field",
    fieldPath: "/prior",
  });
  await expect(revise(notes, { ...base, plan: undefined as never })).rejects.toMatchObject({
    code: "missing_field",
    fieldPath: "/plan",
  });
  await expect(revise(notes, { ...base, metadata: undefined as never })).rejects.toMatchObject({
    code: "missing_field",
    fieldPath: "/metadata",
  });
  await expect(revise(notes, { ...base, records: undefined as never })).rejects.toMatchObject({
    code: "missing_field",
    fieldPath: "/records",
  });
  await expect(
    revise(notes, { ...base, evaluators: undefined as never }),
  ).rejects.toMatchObject({ code: "invalid_field_type", fieldPath: "/evaluators" });
  await expect(revise(notes, { ...base, sampling: undefined as never })).rejects.toMatchObject({
    code: "missing_field",
    fieldPath: "/sampling",
  });
  await expect(
    revise(notes, { ...base, sampling: "clustered" as never }),
  ).rejects.toMatchObject({ code: "invalid_field_type", fieldPath: "/sampling" });
  await expect(
    revise(notes, { ...base, evaluationReports: undefined as never }),
  ).rejects.toMatchObject({ code: "missing_field", fieldPath: "/evaluationReports" });
  await expect(
    revise(notes, { ...base, evaluationReports: [] as never }),
  ).rejects.toMatchObject({ code: "invalid_field_type", fieldPath: "/evaluationReports" });
  await expect(
    revise(notes, { ...base, signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: "cancelled_before_start", fieldPath: "/cases" });
});

// ---------------------------------------------------------------------------
// The result without one feasible candidate.
// ---------------------------------------------------------------------------

test("one revision without one feasible candidate spends no validation budget", async () => {
  // No candidate of the permitted family accepts one case without one
  // error above the 0.0 goal, so the revision states the objective-best
  // candidate with `criteria_not_met` and measures no validation case.
  // The zero error goal holds for no candidate: the 0.6 cutoff accepts
  // one wrong case, and the 0.8 cutoff accepts two cases of the stated
  // three, so the plan minimum alone refuses it.
  const bound = await boundConsumed(undefined, {
    constraints: [
      {
        metric: "error_among_accepted",
        comparison: "at_most",
        limit: 0,
        basis: "observed_value",
      },
    ],
    minimum_samples: { accepted_cases: 3 },
  });
  const revision = await bound.options();

  expect(bound.calls.length).toBe(0);
  expect(revision.fitting.status).toBe("no_feasible_candidate");
  expect(revision.fitting.selected).toBe(null);
  expect(revision.qualification).toBeUndefined();
  expect(revision.runs).toEqual([]);
  expect(revision.profile.qualification.status).toBe("criteria_not_met");
  expect(revision.profile.policy.checks?.[0]?.accept_cutoff).toBe(0.6);
  // The comparison still states the development tradeoff of the
  // objective-best candidate.
  expect(revision.comparison.matching.matched_cases).toBe(4);
  expect(revision.limitations.join(" ")).toContain("No candidate");
  expect(revision.limitations.join(" ")).toContain("version control ignores");
});

// ---------------------------------------------------------------------------
// The shared binding helpers of the suites.
// ---------------------------------------------------------------------------

/** One revision bound over one fresh validation split of one later revision. */
async function boundRevision(revisionEvaluator?: Evaluator) {
  const value = await bound({
    revision: "2026-09-24.2",
    validationGroup: "conversation-c",
    ...(revisionEvaluator === undefined ? {} : { revisionEvaluator }),
  });
  return {
    prior: value.prior,
    definitionHash: value.definitionHash,
    calls: value.calls,
    options: value.options,
  };
}

/** One revision bound over the consumed holdout of the same revision. */
async function boundConsumed(
  revisionEvaluator?: Evaluator,
  planOverrides?: RevisionSetup["planOverrides"],
  records?: string,
) {
  const value = await bound({
    ...(revisionEvaluator === undefined ? {} : { revisionEvaluator }),
    ...(planOverrides === undefined ? {} : { planOverrides }),
    ...(records === undefined ? {} : { records }),
  });
  return {
    prior: value.prior,
    calls: value.calls,
    options: value.options,
    base: value.base,
  };
}
