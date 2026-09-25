// SPDX-License-Identifier: Apache-2.0
/**
 * Evidence check tests.
 *
 * These tests cover task T051: one selected profile records its
 * qualification evidence, and the host retains that evidence at explicit
 * locations of its own. `checkEvidence` compares the recorded identities
 * with the retained artifacts through the Rust core, so one selected
 * profile never rests on one plan or one dataset that drifted after the
 * review. The tests build one real candidate profile through `calibrate`,
 * verify it against the artifacts that the calibration read, then break one
 * retained artifact at a time and pin the refusal with its reason code and
 * field path. They also pin the standing limits: the check authenticates
 * nothing, and the evaluation-report references name host storage that one
 * ignored report folder cannot serve.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import {
  calibrate,
  checkEvidence,
  createScriptedEvaluator,
  defineChecks,
  load,
  registerEvaluators,
  ValidationError,
  type Assessment,
  type CalibrateOptions,
  type FileAccess,
  type Profile,
} from "../src/index.js";
import { nativeComputeSelfHash } from "../src/native.js";

/** One definition with one categorical question check. */
const review = defineChecks({
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
  ],
});

/** One scripted control with its mass on the three declared answers. */
function answer(
  supported: number,
  incomplete: number,
  contradicted: number,
): { readonly answer: { readonly assessment: Assessment } } {
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
    },
  };
}

/** The scripted answers of the measurement: four fitting, three validation. */
const STEPS = [
  answer(0.95, 0.03, 0.02),
  answer(0.75, 0.15, 0.1),
  answer(0.05, 0.05, 0.9),
  answer(0.9, 0.05, 0.05),
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
      checks: { "message-supported": { answer: reference } },
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
function planText(definitionHash: string): string {
  return JSON.stringify({
    schema_version: 1,
    id: "message-supported-plan",
    name: "Limit wrong interventions, then minimize review",
    definition: { name: "message-supported", content_hash: definitionHash },
    intended_population: "Proposed messages in the reviewed support traffic.",
    sampling_assumptions:
      "Cases grouped by conversation. Groups are independent draws within one week of traffic.",
    confidence_level: 0.95,
    constraints: [
      { metric: "error_among_accepted", comparison: "at_most", limit: 0.5, basis: "observed_value" },
    ],
    objective: { metric: "review_rate", direction: "minimize" },
    minimum_samples: { accepted_cases: 2 },
    candidate_grid: { accept_cutoffs: [0.6, 0.8], rejection_cutoffs: [0.6] },
    evaluator: { evaluator: "scripted-test", adapter_version: "0.1.0" },
    datasets: {
      fitting: { dataset: "calibration-cases", revision: "2026-09-24.1", split: "fit" },
      validation: { dataset: "calibration-cases", revision: "2026-09-24.1", split: "holdout" },
    },
  });
}

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

/** One retained evidence set: one calibration over the stated files. */
interface Retained {
  readonly profile: Profile;
  readonly files: FileAccess;
  readonly plan: string;
  readonly metadata: string;
  readonly records: string;
}

/** Runs one calibration and keeps the artifacts that it read. */
async function calibrated(files: Record<string, string> = {}): Promise<Retained> {
  const bare = await load(review);
  const dataset = datasetTexts();
  const plan = planText(bare.definitionHash);
  const store = {
    "/retained/plan/calibration-plan.json": plan,
    "/retained/datasets/metadata.json": dataset.metadata,
    "/retained/datasets/cases.jsonl": dataset.records,
    ...files,
  };
  const options: CalibrateOptions = {
    plan: "/retained/plan/calibration-plan.json",
    metadata: "/retained/datasets/metadata.json",
    records: "/retained/datasets/cases.jsonl",
    evaluators: registerEvaluators(createScriptedEvaluator({ steps: STEPS })),
    sampling: "grouped_cases",
    evaluationReports: ["/retained/reports/message-supported-validation.json"],
    files: memoryFiles(store),
  };
  const calibration = await calibrate(review, options);
  return {
    profile: calibration.profile,
    files: memoryFiles(store),
    plan,
    metadata: dataset.metadata,
    records: dataset.records,
  };
}

/** Runs one evidence check over one retained set and expects one refusal. */
async function evidenceError(
  retained: Retained,
  edits: Partial<Record<"plan" | "metadata" | "records", string>> & {
    readonly profile?: Profile | string;
  },
): Promise<ValidationError> {
  try {
    await checkEvidence(edits.profile ?? retained.profile, {
      plan: "/retained/plan/calibration-plan.json",
      metadata: "/retained/datasets/metadata.json",
      records: "/retained/datasets/cases.jsonl",
      files: memoryFiles({
        "/retained/plan/calibration-plan.json": edits.plan ?? retained.plan,
        "/retained/datasets/metadata.json": edits.metadata ?? retained.metadata,
        "/retained/datasets/cases.jsonl": edits.records ?? retained.records,
      }),
    });
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error("the evidence check accepted the drifted retained set");
}

test("the retained evidence of one calibration verifies", async () => {
  const retained = await calibrated();
  const check = await checkEvidence(retained.profile, {
    plan: "/retained/plan/calibration-plan.json",
    metadata: "/retained/datasets/metadata.json",
    records: "/retained/datasets/cases.jsonl",
    files: retained.files,
  });

  // The result states the artifacts it verified with the identities and the
  // counts it read: one plan, one dataset of seven records, two splits.
  expect(check.profile_id).toBe("message-supported-calibrated");
  expect(check.profile_content_hash).toBe(retained.profile.content_hash);
  expect(check.definition_hash).toBe(retained.profile.definition.content_hash);
  expect(check.plan.id).toBe("message-supported-plan");
  expect(check.plan.content_hash).toBe(retained.profile.evidence?.plan?.content_hash);
  expect(check.dataset.id).toBe("calibration-cases");
  expect(check.dataset.revision).toBe("2026-09-24.1");
  expect(check.dataset.kind).toBe("representative_sample");
  expect(check.dataset.record_count).toBe(7);
  expect(check.dataset.content_hash).toBe(retained.profile.evidence?.datasets?.[0]?.content_hash);
  expect(check.splits).toEqual([
    {
      id: "fit",
      purpose: "fitting",
      groups: ["conversation-a"],
      record_count: 4,
      content_hash: retained.profile.evidence?.splits?.[0]?.content_hash,
    },
    {
      id: "holdout",
      purpose: "validation",
      groups: ["conversation-b"],
      record_count: 3,
      content_hash: retained.profile.evidence?.splits?.[1]?.content_hash,
    },
  ]);
  expect(check.evaluation_reports).toEqual([
    "/retained/reports/message-supported-validation.json",
  ]);
  expect(check.statement).toContain("calibration-cases");
  expect(check.statement).toContain("7 case records");

  // The standing limits keep the trust boundary and the retention rule
  // visible beside every verified identity.
  expect(check.limitations.length).toBe(2);
  expect(check.limitations[0]).toContain("cannot verify the truth");
  expect(check.limitations[1]).toContain("version control ignores");

  // The check result holds identities, counts, and statements alone: no
  // case content, no reference label, and no reviewer name crosses.
  const serialized = JSON.stringify(check);
  for (const forbidden of [
    "Customer exports stay in the EU.",
    "The export worker serves EU customers.",
    "reviewer-1",
    "api_key",
  ]) {
    expect(serialized, `the check result names ${forbidden}`).not.toContain(forbidden);
  }
});

test("the evidence check reads no report file and changes no artifact", async () => {
  const retained = await calibrated();
  const before = JSON.stringify(retained.profile);
  const reads: string[] = [];
  const base = retained.files;
  const files: FileAccess = {
    async read(filePath: string): Promise<string> {
      reads.push(filePath);
      return base.read(filePath);
    },
  };
  await checkEvidence(retained.profile, {
    plan: "/retained/plan/calibration-plan.json",
    metadata: "/retained/datasets/metadata.json",
    records: "/retained/datasets/cases.jsonl",
    files,
  });
  // The check read the three stated artifacts alone. It opened no report
  // reference, because the reports name host storage that stays with the
  // host, and the profile artifact stayed unchanged.
  expect(reads.sort()).toEqual([
    "/retained/datasets/cases.jsonl",
    "/retained/datasets/metadata.json",
    "/retained/plan/calibration-plan.json",
  ]);
  expect(JSON.stringify(retained.profile)).toBe(before);
});

test("one edited plan or dataset fails its recorded identity", async () => {
  const retained = await calibrated();
  const editedPlan = retained.plan.replace("\"limit\":0.5", "\"limit\":0.4");
  expect(editedPlan).not.toBe(retained.plan);
  const planError = await evidenceError(retained, { plan: editedPlan });
  expect(planError.code).toBe("hash_mismatch");
  expect(planError.fieldPath).toBe("/evidence/plan/content_hash");

  const editedRecords = `${retained.records}\n${record("hold-4", "conversation-b", "contradicted")}`;
  const recordsError = await evidenceError(retained, { records: editedRecords });
  expect(recordsError.code).toBe("hash_mismatch");
  expect(recordsError.fieldPath).toBe("/evidence/datasets/0/content_hash");

  const revisedMetadata = retained.metadata.replace("2026-09-24.1", "2026-09-24.2");
  const revisionError = await evidenceError(retained, { metadata: revisedMetadata });
  expect(revisionError.code).toBe("hash_mismatch");
  expect(revisionError.fieldPath).toBe("/evidence/datasets/0/revision");
});

test("one edited profile copy fails before one identity is compared", async () => {
  const retained = await calibrated();
  const edited: Record<string, unknown> = JSON.parse(JSON.stringify(retained.profile));
  const evidence = edited.evidence as Record<string, unknown>;
  evidence.splits = [{ id: "holdout", content_hash: "0".repeat(64) }];
  delete edited.content_hash;
  const resigned = {
    ...edited,
    content_hash: nativeComputeSelfHash("profile", JSON.stringify(edited)),
  } as Profile;
  const error = await evidenceError(retained, { profile: resigned });
  expect(error.code).toBe("hash_mismatch");
  expect(error.fieldPath).toBe("/evidence/splits/0/content_hash");
});

test("one profile that records no evidence states what is missing", async () => {
  const retained = await calibrated();
  const unsigned = {
    schema_version: 1,
    id: "exploration-copy",
    origin: "exploration",
    intended_use: "Development use.",
    definition: retained.profile.definition,
    bindings: retained.profile.bindings,
    policy: retained.profile.policy,
    execution: retained.profile.execution,
    qualification: { status: "unvalidated", reasons: ["starter_policy"] },
  };
  const exploration = {
    ...unsigned,
    content_hash: nativeComputeSelfHash("profile", JSON.stringify(unsigned)),
  } as Profile;
  const error = await evidenceError(retained, { profile: exploration });
  expect(error.code).toBe("missing_field");
  expect(error.fieldPath).toBe("/evidence");
});

test("the option checks refuse one absent or wrongly shaped location", async () => {
  const retained = await calibrated();
  const base = {
    plan: "/retained/plan/calibration-plan.json",
    metadata: "/retained/datasets/metadata.json",
    records: "/retained/datasets/cases.jsonl",
    files: retained.files,
  };
  await expect(checkEvidence(retained.profile, { ...base, plan: undefined as never })).rejects
    .toMatchObject({ code: "missing_field", fieldPath: "/plan" });
  await expect(checkEvidence(retained.profile, { ...base, metadata: undefined as never })).rejects
    .toMatchObject({ code: "missing_field", fieldPath: "/metadata" });
  await expect(checkEvidence(retained.profile, { ...base, records: undefined as never })).rejects
    .toMatchObject({ code: "missing_field", fieldPath: "/records" });
  await expect(
    checkEvidence(retained.profile, { ...base, records: "/retained/datasets/cases.json" }),
  ).rejects.toMatchObject({ code: "unsupported_format", fieldPath: "/records" });
  await expect(
    checkEvidence(retained.profile, { ...base, plan: "/retained/plan/plan.yaml" }),
  ).rejects.toMatchObject({ code: "unsupported_format", fieldPath: "/plan" });
  await expect(
    checkEvidence("/retained/profiles/candidate.yaml", base),
  ).rejects.toMatchObject({ code: "unsupported_format", fieldPath: "/profile" });
});

test("one profile path loads and verifies through the same boundary", async () => {
  const retained = await calibrated();
  const files = memoryFiles({
    "/retained/plan/calibration-plan.json": retained.plan,
    "/retained/datasets/metadata.json": retained.metadata,
    "/retained/datasets/cases.jsonl": retained.records,
    "/retained/profiles/candidate.json": JSON.stringify(retained.profile),
  });
  const check = await checkEvidence("/retained/profiles/candidate.json", {
    plan: "/retained/plan/calibration-plan.json",
    metadata: "/retained/datasets/metadata.json",
    records: "/retained/datasets/cases.jsonl",
    files,
  });
  expect(check.profile_id).toBe("message-supported-calibrated");
});
