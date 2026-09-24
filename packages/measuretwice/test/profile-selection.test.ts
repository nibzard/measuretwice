// SPDX-License-Identifier: Apache-2.0
/**
 * Profile selection and mode admission tests.
 *
 * These tests cover the boundary of task T035: one runtime mode admits one
 * profile only through the gate that the checked qualification model
 * states. Shadow mode, the admission that the `evaluate` operation of task
 * T044 reuses, admits every compatible profile whatever its qualification
 * status. Enforcement adds three clauses: the declared scope, the
 * `validated_for_scope` status, and the reviewed content hash that the
 * host selected. Every refusal crosses before any evaluator runs.
 *
 * The tests also pin the three concepts that stay separate: one
 * qualification flag records evidence, it authenticates no approval; one
 * host selection states one reviewed hash, it admits nothing by itself;
 * and one report authorizes no application action, whatever its mode and
 * outcome. No run promotes one profile or changes one selection: the
 * wrapper holds no profile state to change.
 *
 * The adapter is the scripted test evaluator, so the tests read local
 * files only and stay offline and deterministic.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import {
  createExplorationProfile,
  createScriptedEvaluator,
  defineChecks,
  load,
  registerEvaluators,
  ValidationError,
  type Definition,
  type EvaluatorRequest,
  type FileAccess,
  type Profile,
  type RunReport,
} from "../src/index.js";
import { nativeComputeSelfHash } from "../src/native.js";
import { sequenceIds } from "./support/deterministic.js";

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** The use scope that every calibrated artifact below declares. */
const SCOPE = "The pilot conversation population declared in the plan.";

/** Two content-hash-shaped digests for the recorded evidence identities. */
const EVIDENCE_HASH_A = "a5065efe5f955d002a550c9598efeb1217b0b402db10efda842f10682a2ec65b";
const EVIDENCE_HASH_B = "88c86b66dd45adbd34e4a409dd3a37a2cbe6f94990fefb35c7f0d97dcaf94970";

/**
 * One categorical definition with one question check. The shape mirrors
 * the public example, so the policy decides a `supported` answer with one
 * distribution.
 */
const message = defineChecks({
  version: 1,
  name: "message-quality",
  inputs: Type.Object(
    {
      message: Type.String({ minLength: 1 }),
      evidence: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "message-supported",
      name: "Our message accurately describes the evidence",
      using: ["message", "evidence"],
      question: "Does every material claim in the proposed message follow from the evidence?",
      answers: {
        supported: "All claims follow from the evidence.",
        contradicted: "One claim conflicts with the evidence.",
        incomplete: "Support for one claim is missing.",
      },
      accept: "supported",
      review: ["incomplete"],
    },
  ],
});

/** One case that satisfies the input schema. */
const CASE = { id: "case-1", input: { message: "The export worker moves.", evidence: "Decision 12 states the EU region." } };

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
    confidence: 0.9,
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

/** One complete evidence record of one calibration, as the contract states it. */
const EVIDENCE = {
  plan: { id: "message-quality-plan", content_hash: EVIDENCE_HASH_A },
  datasets: [
    { id: "message-quality-cases", revision: "2026-09-23", content_hash: EVIDENCE_HASH_B },
  ],
  splits: [
    { id: "fitting", content_hash: EVIDENCE_HASH_A },
    { id: "validation", content_hash: EVIDENCE_HASH_B },
  ],
  label_provenance: "Synthetic cases proposed by one agent, then human reviewed.",
  evaluation_reports: ["reports/message-quality-validation.json"],
  statistical_method: "Wilson score intervals at 95 percent confidence.",
};

/** One registered scripted evaluator, shared by every binding below. */
const evaluator = createScriptedEvaluator({ steps: [] });

/** The exploration starter artifact that fixes the definition binding. */
const exploration = createExplorationProfile(message, registerEvaluators(evaluator), {
  execution: { max_attempts: 1, backoff_ms: 0 },
});

/**
 * Builds one calibrated profile artifact with the stated qualification.
 *
 * The artifact keeps the definition binding of the exploration starter,
 * because the definition and the evaluator stay the same: only the
 * measured qualification differs. The single attempt keeps every run
 * deterministic, because one scripted step resolves one check.
 */
function calibrated(
  status: "insufficient_evidence" | "criteria_not_met" | "validated_for_scope",
): Profile {
  const reasons: Record<typeof status, string> = {
    insufficient_evidence: "insufficient_evidence",
    criteria_not_met: "criteria_not_met",
    validated_for_scope: "measured_evidence",
  };
  const artifact: Record<string, unknown> = {
    schema_version: 1,
    id: `message-quality-${status.replace(/_/g, "-")}`,
    origin: "calibration",
    intended_use: SCOPE,
    definition: exploration.definition,
    bindings: exploration.bindings,
    policy: exploration.policy,
    execution: { ...exploration.execution, max_attempts: 1, backoff_ms: 0 },
    evidence: EVIDENCE,
    qualification: { status, scope: SCOPE, reasons: [reasons[status]] },
  };
  artifact["content_hash"] = nativeComputeSelfHash("profile", JSON.stringify(artifact));
  return artifact as unknown as Profile;
}

/** Every qualification status of the contract, with one loadable artifact. */
const STATUSES: ReadonlyArray<{
  readonly status: string;
  readonly profile: Profile;
}> = [
  { status: "unvalidated", profile: exploration },
  { status: "insufficient_evidence", profile: calibrated("insufficient_evidence") },
  { status: "criteria_not_met", profile: calibrated("criteria_not_met") },
  { status: "validated_for_scope", profile: calibrated("validated_for_scope") },
];

/**
 * Loads one profile through one fresh scripted evaluator and returns its
 * run boundary with the evaluator, so each test observes the calls.
 */
async function bind(
  profile: Profile,
  steps: readonly unknown[],
): Promise<{
  readonly run: (
    caseInput: unknown,
    options?: {
      readonly mode?: "shadow" | "enforcement";
      readonly selectedProfileHash?: string;
      readonly scope?: string;
    },
  ) => Promise<RunReport>;
  readonly calls: readonly EvaluatorRequest[];
  readonly remaining: () => number;
  readonly bound: Profile;
}> {
  const adapter = createScriptedEvaluator({
    steps: steps.map((step) =>
      step !== null && typeof step === "object" && !("answer" in step) && !("error" in step) && !("raw" in step)
        ? { answer: step }
        : step,
    ) as never,
  });
  const path = `/profiles/${profile.id}.json`;
  const reviewer = await load(message as unknown as Definition, {
    profile: path,
    evaluators: registerEvaluators(adapter),
    files: memoryFiles({ [path]: JSON.stringify(profile) }),
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  return {
    run: (caseInput, options) => reviewer.run(caseInput as never, options),
    calls: adapter.calls,
    remaining: adapter.remaining,
    bound: reviewer.profile as Profile,
  };
}

// ---------------------------------------------------------------------------
// Shadow admission, the admission that evaluation reuses.
// ---------------------------------------------------------------------------

test("every qualification status assesses cases in shadow mode", async () => {
  // Shadow mode, and the evaluate operation that reuses its admission,
  // gate the binding alone: every compatible profile runs whatever its
  // qualification states, as the checked model requires for exploration.
  for (const entry of STATUSES) {
    const bound = await bind(entry.profile, [SUPPORTED]);
    const report = await bound.run(CASE);
    expect(report.mode, entry.status).toBe("shadow");
    expect(report.aggregate.outcome, entry.status).toBe("pass");
    expect(report.checks[0]?.outcome, entry.status).toBe("pass");
    // The run changes no qualification: the bound artifact stays the
    // selected file, byte for byte, after its case assessed.
    expect(bound.bound, entry.status).toEqual(entry.profile);
  }
});

// ---------------------------------------------------------------------------
// The enforcement gate.
// ---------------------------------------------------------------------------

test("enforcement refuses every qualification status below validated_for_scope", async () => {
  for (const entry of STATUSES.filter((row) => row.status !== "validated_for_scope")) {
    const bound = await bind(entry.profile, [SUPPORTED]);
    // The exploration profile declares another scope, so its request
    // states none: the qualification clause must refuse first.
    const scope = entry.status === "unvalidated" ? undefined : SCOPE;
    const failure = await failureOf(() =>
      bound.run(CASE, {
        mode: "enforcement",
        selectedProfileHash: entry.profile.content_hash,
        ...(scope !== undefined ? { scope } : {}),
      }),
    );
    expect(failure.code, entry.status).toBe("qualification_insufficient");
    expect(failure.fieldPath, entry.status).toBe("/profile/qualification/status");
    expect(failure.message, entry.status).toContain(entry.status);
    // The refusal crosses before any case work: no evaluator ran.
    expect(bound.remaining(), entry.status).toBe(1);
  }
});

test("enforcement requires the reviewed hash that the host selected", async () => {
  const profile = calibrated("validated_for_scope");

  // One enforcement run that states no selection: the library never
  // selects one profile for the host.
  const unselected = await bind(profile, [SUPPORTED]);
  const missing = await failureOf(() =>
    unselected.run(CASE, { mode: "enforcement", scope: SCOPE }),
  );
  expect(missing.code).toBe("profile_not_selected");
  expect(missing.fieldPath).toBe("/profile/content_hash");
  expect(missing.message).toContain("no selection crossed");
  expect(unselected.remaining()).toBe(1);

  // One selection of another hash names another artifact. The reviewer
  // stays loadable, and shadow use keeps working beside the refusal.
  const foreign = await bind(profile, [SUPPORTED, SUPPORTED]);
  const otherHash = await failureOf(() =>
    foreign.run(CASE, {
      mode: "enforcement",
      scope: SCOPE,
      selectedProfileHash: EVIDENCE_HASH_B,
    }),
  );
  expect(otherHash.code).toBe("profile_not_selected");
  expect(otherHash.fieldPath).toBe("/profile/content_hash");
  const shadowBeside = await foreign.run(CASE);
  expect(shadowBeside.mode).toBe("shadow");
  expect(shadowBeside.aggregate.outcome).toBe("pass");

  // One selection outside the hash shape is one invalid option.
  const malformed = await bind(profile, [SUPPORTED]);
  const shape = await failureOf(() =>
    malformed.run(CASE, { mode: "enforcement", scope: SCOPE, selectedProfileHash: "reviewed" }),
  );
  expect(shape.code).toBe("invalid_field_type");
  expect(shape.fieldPath).toBe("/selected_profile_hash");

  // The selected hash admits the validated profile for its declared scope.
  const selected = await bind(profile, [SUPPORTED]);
  const report = await selected.run(CASE, {
    mode: "enforcement",
    scope: SCOPE,
    selectedProfileHash: profile.content_hash,
  });
  expect(report.mode).toBe("enforcement");
  expect(report.aggregate.outcome).toBe("pass");
  expect(report.profile).toEqual({ id: profile.id, content_hash: profile.content_hash });
  expect(selected.remaining()).toBe(0);
});

test("enforcement compares the requested scope with the declared scope", async () => {
  const profile = calibrated("validated_for_scope");
  const bound = await bind(profile, [SUPPORTED]);
  const failure = await failureOf(() =>
    bound.run(CASE, {
      mode: "enforcement",
      scope: "Development traffic of one other application.",
      selectedProfileHash: profile.content_hash,
    }),
  );
  expect(failure.code).toBe("scope_mismatch");
  expect(failure.fieldPath).toBe("/profile/qualification/scope");
  expect(bound.remaining()).toBe(1);
});

test("stale evaluator bindings refuse at load, whatever the host selects", async () => {
  // One registered adapter that states another version than the binding
  // refuses the load itself, before any mode question: one changed
  // binding needs new qualification. The native suite covers the changed
  // resolved model the same way, because the wrapper states no resolution.
  const adapter = createScriptedEvaluator({
    id: "scripted-test",
    adapter_version: "0.2.0",
    steps: [{ answer: SUPPORTED }],
  });
  const path = "/profiles/stale.json";
  const failure = await failureOf(() =>
    load(message as unknown as Definition, {
      profile: path,
      evaluators: registerEvaluators(adapter),
      files: memoryFiles({ [path]: JSON.stringify(calibrated("validated_for_scope")) }),
      now: () => START_MS,
    }),
  );
  expect(failure.code).toBe("evaluator_mismatch");
  expect(failure.fieldPath).toBe("/profile/bindings/0/adapter_version");
});

// ---------------------------------------------------------------------------
// Outcome handling and the limits of one report.
// ---------------------------------------------------------------------------

test("one enforced operational failure records an error and never a pass", async () => {
  const profile = calibrated("validated_for_scope");
  const bound = await bind(profile, [{ error: "The provider connection reset." }]);
  const report = await bound.run(CASE, {
    mode: "enforcement",
    scope: SCOPE,
    selectedProfileHash: profile.content_hash,
  });
  expect(report.checks[0]?.outcome).toBe("error");
  expect(report.checks[0]?.reason?.code).toBe("evaluator_error");
  expect(report.aggregate.outcome).toBe("error");
  expect(report.completion.status).toBe("completed");
  // The report states its records and nothing else: no field authorizes an
  // application action, and one error never became a pass.
  expect(Object.keys(report).sort()).toEqual([
    "aggregate",
    "case",
    "checks",
    "completion",
    "definition",
    "mode",
    "profile",
    "run_id",
    "schema_version",
  ]);
});

test("runs promote no profile and keep no selection of their own", async () => {
  const profile = calibrated("validated_for_scope");
  const bound = await bind(profile, [SUPPORTED, SUPPORTED, SUPPORTED]);
  const before = JSON.stringify(bound.bound);

  // One shadow pass, one refused enforcement, and one enforced pass.
  const shadow = await bound.run(CASE);
  expect(shadow.aggregate.outcome).toBe("pass");
  const refused = await failureOf(() =>
    bound.run(CASE, { mode: "enforcement", scope: SCOPE }),
  );
  expect(refused.code).toBe("profile_not_selected");
  const enforced = await bound.run(CASE, {
    mode: "enforcement",
    scope: SCOPE,
    selectedProfileHash: profile.content_hash,
  });
  expect(enforced.aggregate.outcome).toBe("pass");

  // No step of the run changed the bound artifact or its qualification,
  // and the frozen artifact takes no write.
  expect(JSON.stringify(bound.bound)).toBe(before);
  expect(bound.bound.qualification.status).toBe("validated_for_scope");
  expect(Object.isFrozen(bound.bound)).toBe(true);
  expect(() => {
    (bound.bound as unknown as Record<string, unknown>)["qualification"] = {
      status: "validated_for_scope",
      reasons: ["measured_evidence"],
    };
  }).toThrow();

  // The selection states itself per run: one accepted selection binds no
  // later run, so the host keeps sole control of its reviewed hash.
  const sticky = await failureOf(() =>
    bound.run(CASE, { mode: "enforcement", scope: SCOPE, selectedProfileHash: EVIDENCE_HASH_B }),
  );
  expect(sticky.code).toBe("profile_not_selected");
});

test("the exact structural profile needs one host selection too", async () => {
  // An exact-only definition holds no evaluator, so its derived profile
  // carries the structural basis. Enforcement still selects it: the host
  // states the reviewed hash of the derived artifact.
  const limits = defineChecks({
    version: 1,
    name: "notice-limits",
    inputs: Type.Object({ notice: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    checks: [
      {
        id: "notice-length",
        name: "The notice fits the delivery limit",
        using: ["notice"],
        rule: { maxLength: 80 },
      },
    ],
  });
  const reviewer = await load(limits, { now: () => START_MS, nextRunId: sequenceIds("run") });
  const unselected = await failureOf(() =>
    reviewer.run({ id: "case-2", input: { notice: "One short notice." } }, { mode: "enforcement" }),
  );
  expect(unselected.code).toBe("profile_not_selected");
  expect(unselected.fieldPath).toBe("/profile/content_hash");
  const derived = reviewer.profile;
  expect(derived?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  const report = await reviewer.run(
    { id: "case-2", input: { notice: "One short notice." } },
    {
      mode: "enforcement",
      ...(derived !== undefined ? { selectedProfileHash: derived.content_hash } : {}),
    },
  );
  expect(report.mode).toBe("enforcement");
  expect(report.aggregate.outcome).toBe("pass");
});
