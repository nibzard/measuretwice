// SPDX-License-Identifier: Apache-2.0
/**
 * The public synthetic challenge set, validated offline.
 *
 * Task T062 ships the challenge set under `examples/intervention-challenge`,
 * as MVP_SPEC.md section 13 requires. This suite builds the validation
 * runner of the set through its own TypeScript configuration, exactly as one
 * host application does, and then checks the promises of its README:
 *
 * - The set loads against the committed portable definition of the flagship
 *   example, so it binds one definition revision by content hash.
 * - The dataset declares the kind `synthetic_challenge`, one challenge split
 *   that holds every group, and the population statement of one targeted
 *   challenge set with no prevalence.
 * - The cases cover every behavior of the specification, every consequence
 *   level, and every declared language.
 * - Every case labels the component answers and the final outcome
 *   separately, and the stated outcomes aggregate to the stated overall
 *   outcome.
 * - Every label stays one unreviewed model proposal of synthetic origin, and
 *   the runner refuses one dataset that claims one human review.
 * - The core classifies the challenge split as development data, so the set
 *   stays apart from representative population evidence.
 * - The published README states the current revision and both content hashes.
 *
 * The suite reads local files only, so it stays offline and free. One model
 * never answered, and nothing was measured.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyValidationEvidence, loadDataset } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exampleDir = path.join(repoRoot, "examples", "intervention-challenge");
const builtValidate = path.join(exampleDir, "build", "validate.js");
const readmeFile = path.join(exampleDir, "README.md");
const flagshipExport = path.join(
  repoRoot,
  "examples",
  "intervention-review",
  "definitions",
  "intervention-review.json",
);
const flagshipMetadata = path.join(
  repoRoot,
  "examples",
  "intervention-review",
  "cases",
  "intervention-review.metadata.json",
);
const flagshipRecords = path.join(
  repoRoot,
  "examples",
  "intervention-review",
  "cases",
  "intervention-review.jsonl",
);
const packageEntry = path.join(repoRoot, "packages", "measuretwice", "dist", "index.js");

/** The identifiers of the five checks of the flagship definition. */
const CHECK_IDS = [
  "decision-conflict",
  "message-supported",
  "adds-information",
  "consequence",
  "message-length",
] as const;

/** The case identifiers of the set, in file order. */
const CASE_IDS = [
  "retention-suggestion-not-decision",
  "freeze-decision-not-suggestion",
  "freeze-security-exception",
  "negated-record-approval",
  "negated-rollout-status",
  "offline-mode-wrong-speaker",
  "internal-proposal-attribution",
  "scoped-region-exception",
  "late-correction-cited",
  "stale-correction-ignored",
  "duplicate-migration-work",
  "german-duplicate-concern",
  "export-limit-partial-support",
  "partly-false-record-citation",
  "missing-move-target",
  "french-missing-record",
  "instruction-in-message",
  "instruction-in-discussion",
];

/** The challenge behaviors that MVP_SPEC.md section 13 lists. */
const BEHAVIOR_SLICES = [
  "decision-vs-suggestion",
  "negation",
  "attribution",
  "intentional-change",
  "delayed-correction",
  "duplicate-concern",
  "partial-support",
  "missing-context",
  "embedded-instruction",
];

/**
 * The compiled validation result. This interface states the fields the suite
 * reads, because the compiled runner answers through the built package.
 */
interface ChallengeResult {
  readonly dataset: {
    readonly metadata: {
      readonly id: string;
      readonly revision: string;
      readonly kind: string;
      readonly languages: readonly string[];
      readonly sampling_method: string;
    };
    readonly identity: Readonly<{
      readonly dataset_id: string;
      readonly revision: string;
      readonly kind: "development_fixture" | "synthetic_challenge" | "representative_sample";
      readonly population: "development_fixture" | "targeted_challenge_set" | "representative_sample";
      readonly supports_qualification: boolean;
      readonly states_prevalence: boolean;
      readonly intended_population: string;
      readonly sampling_method: string;
      readonly record_count: number;
      readonly content_hash: string;
      readonly group_assignments: readonly {
        readonly group: string;
        readonly split_id: string;
        readonly record_count: number;
      }[];
      readonly unassigned_groups: readonly {
        readonly group: string;
        readonly record_count: number;
        readonly first_line: number;
      }[];
    }>;
    readonly splits: readonly {
      readonly dataset: string;
      readonly revision: string;
      readonly split: string;
      readonly purpose: "fitting" | "validation";
      readonly groups: readonly string[];
      readonly record_count: number;
      readonly content_hash: string;
      readonly case_ids: readonly string[];
    }[];
    readonly definition: Readonly<{ readonly name: string; readonly content_hash: string }>;
    readonly cases: readonly {
      readonly id: string;
      readonly group: string;
      readonly tags: readonly string[];
      readonly input: Readonly<Record<string, unknown>>;
      readonly expected?: {
        readonly checks: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
        readonly outcome: string;
      };
      readonly label: Readonly<{
        readonly author_type: string;
        readonly reviewed: boolean;
        readonly origin?: string;
        readonly reviewer?: string;
        readonly reason?: string;
      }>;
    }[];
    readonly labels: {
      readonly summary: Record<string, number>;
      readonly findings: readonly unknown[];
    };
    runCase(record: unknown): { id: string; input: unknown };
  };
  readonly definition: Readonly<{ readonly name: string; readonly content_hash: string }>;
  readonly outcomes: Readonly<{ pass: number; fail: number; review: number }>;
  readonly slices: Readonly<Record<string, number>>;
  readonly evidence: Readonly<{
    readonly class: string;
    readonly representative_sample: boolean;
    readonly needs_fresh_evidence: boolean;
    readonly statement: string;
  }>;
  readonly summary: string;
}

/** The compiled validation entry of the example. */
type ValidateChallenge = (options?: {
  readonly root?: string;
  readonly log?: (text: string) => void;
}) => Promise<ChallengeResult>;

/** Reads one thrown error of one rejected call as one message string. */
async function rejectionOf(run: () => Promise<unknown>): Promise<string> {
  const error = await run().then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error, "the call must reject").toBeInstanceOf(Error);
  return (error as Error).message;
}

/** The compiled validation entry, imported once after the build. */
let validateChallenge: ValidateChallenge;

/** The validation result that every test reads. Run once. */
let validation: ChallengeResult;

/** The content hash of the flagship definition, computed by the same core. */
let flagshipDefinitionHash = "";

beforeAll(async () => {
  expect(existsSync(packageEntry), "build the package before the tests").toBe(true);
  // One host application imports the runner through its own build, so the
  // suite builds the example the same way. One type error in the runner
  // fails here, before any test runs.
  execFileSync(
    process.execPath,
    [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(exampleDir, "tsconfig.json")],
    { cwd: repoRoot, stdio: "pipe" },
  );
  validateChallenge = ((await import(pathToFileURL(builtValidate).href)) as {
    validateChallengeDataset: ValidateChallenge;
  }).validateChallengeDataset;
  validation = await validateChallenge({ log: () => {} });
  const flagship = await loadDataset({
    definition: flagshipExport,
    metadata: flagshipMetadata,
    records: flagshipRecords,
  });
  flagshipDefinitionHash = flagship.definition.content_hash;
}, 120_000);

afterAll(() => {
  rmSync(path.join(exampleDir, "build"), { recursive: true, force: true });
});

test("the challenge set loads against the committed flagship definition", () => {
  const dataset = validation.dataset;
  expect(dataset.definition.name).toBe("intervention-review");
  // The flagship fixture and the challenge set bind the same definition
  // revision: both loads read the committed export and hash it in the core.
  expect(dataset.definition.content_hash).toBe(flagshipDefinitionHash);
  expect(validation.definition.content_hash).toBe(flagshipDefinitionHash);
  // The set answers the complete flagship definition, not one subset.
  expect(dataset.cases.map((record) => Object.keys(record.expected?.checks ?? {}).sort())).toEqual(
    dataset.cases.map(() => [...CHECK_IDS].sort()),
  );
});

test("the dataset declares one challenge set with one split that holds every group", () => {
  const dataset = validation.dataset;
  const identity = dataset.identity;
  expect(identity.dataset_id).toBe("intervention-challenge-cases");
  expect(identity.revision).toBe("2026-09-24.1");
  expect(identity.record_count).toBe(CASE_IDS.length);
  expect(dataset.metadata.id).toBe(identity.dataset_id);
  expect(dataset.metadata.revision).toBe(identity.revision);
  // The kind states the population claim: one targeted challenge set.
  expect(identity.kind).toBe("synthetic_challenge");
  expect(identity.population).toBe("targeted_challenge_set");
  expect(identity.supports_qualification).toBe(false);
  expect(identity.states_prevalence).toBe(false);
  // One declared split holds every group, and no group stays unassigned.
  expect(identity.unassigned_groups).toEqual([]);
  expect(identity.group_assignments).toHaveLength(15);
  for (const assignment of identity.group_assignments) {
    expect(assignment.split_id).toBe("challenge");
  }
  expect(dataset.splits).toHaveLength(1);
  const split = dataset.splits[0]!;
  expect(split).toMatchObject({ split: "challenge", purpose: "validation" });
  expect(split.record_count).toBe(CASE_IDS.length);
  expect(split.case_ids).toEqual([...CASE_IDS].sort());
  expect(split.groups.length).toBe(identity.group_assignments.length);
  // The three incidents with two variants keep one group each.
  const grouped = new Map(identity.group_assignments.map((entry) => [entry.group, entry.record_count]));
  for (const [group, count] of [
    ["quarter-freeze", 2],
    ["sandbox-live-cards", 2],
    ["archive-injection", 2],
  ] as const) {
    expect(grouped.get(group), `the group ${group} holds its two variants`).toBe(count);
  }
  expect([...grouped.values()].filter((count) => count === 1)).toHaveLength(12);
});

test("the cases cover every required behavior, consequence level, and language", () => {
  const slices = validation.slices;
  expect(validation.dataset.cases.map((record) => record.id)).toEqual(CASE_IDS);
  for (const slice of BEHAVIOR_SLICES) {
    expect(slices[slice], `the slice ${slice} holds two cases`).toBe(2);
  }
  // The three declared levels of the consequence scale and the unresolved
  // marker all occur, so one evaluation slices by level.
  for (const slice of [
    "consequence-minor",
    "consequence-meaningful",
    "consequence-serious",
    "consequence-unresolved",
  ]) {
    expect(slices[slice], `the slice ${slice} holds one case at least`).toBeGreaterThan(0);
  }
  expect(validation.dataset.metadata.languages).toEqual(["de", "en", "fr"]);
  expect(slices["language-de"]).toBe(1);
  expect(slices["language-fr"]).toBe(1);
  expect(slices["language-en"]).toBe(CASE_IDS.length - 2);
  // The reference outcomes mix all three outcome classes, so the set
  // exercises accepted, rejected, and unresolved drafts.
  expect(validation.outcomes).toEqual({ pass: 4, fail: 11, review: 3 });
});

test("every case labels its component answers and its final outcome separately", () => {
  const dataset = validation.dataset;
  expect(dataset.labels.findings).toEqual([]);
  for (const record of dataset.cases) {
    const expected = record.expected;
    expect(expected, `the case ${record.id} states one expected object`).toBeDefined();
    const checks = expected!.checks;
    for (const check of CHECK_IDS) {
      const reference = checks[check];
      expect(reference, `the case ${record.id} labels the check ${check}`).toBeDefined();
      expect(reference!.outcome, `the check ${check} of ${record.id} states one outcome`).toBeDefined();
      if (check === "message-length") {
        // One rule check states one expected outcome alone. Its rule decides
        // the answer, and the suite verifies the length below.
        expect(reference!).toEqual({ outcome: "pass" });
        continue;
      }
      const component = ["answer", "level", "review"].filter((field) => reference![field] !== undefined);
      expect(component, `the check ${check} of ${record.id} states one proposed answer`).toHaveLength(1);
    }
    // The final outcome follows the stated component outcomes: any fail gives
    // fail, otherwise any review gives review, otherwise pass. The core flags
    // one disagreement, and this fold checks it without the core.
    const outcomes = Object.values(checks).map((reference) => reference!.outcome);
    const aggregate = outcomes.includes("fail")
      ? "fail"
      : outcomes.includes("review")
        ? "review"
        : "pass";
    expect(expected!.outcome, `the overall outcome of ${record.id} follows its checks`).toBe(aggregate);
  }
});

test("all labels are unreviewed model proposals of synthetic origin", () => {
  const dataset = validation.dataset;
  const summary = dataset.labels.summary;
  expect(summary.records).toBe(CASE_IDS.length);
  expect(summary.labeled).toBe(CASE_IDS.length);
  expect(summary.model_unreviewed).toBe(CASE_IDS.length);
  expect(summary.model_reviewed).toBe(0);
  expect(summary.human_reviewed).toBe(0);
  expect(summary.human_unreviewed).toBe(0);
  expect(summary.corrected).toBe(0);
  // Two cases state one review marker, so their references need one human.
  expect(summary.review_required).toBe(2);
  for (const record of dataset.cases) {
    expect(record.label.author_type, `the label of ${record.id} names one model author`).toBe("model");
    expect(record.label.origin, `the label of ${record.id} names one synthetic origin`).toBe("synthetic");
    expect(record.label.reviewed, `no human reviewed the label of ${record.id}`).toBe(false);
    expect(record.label.reviewer, `one reviewer exists only after one review`).toBeUndefined();
    expect(record.label.reason, `the label of ${record.id} states one reason`).toBeTruthy();
  }
  // The metadata records the generation provenance and the intended scope.
  const population = dataset.metadata.sampling_method;
  expect(population).toContain("coding agent");
  expect(population).toContain("24 September 2026");
  expect(population).toContain("states no prevalence");
});

test("the challenge set stays apart from representative population evidence", () => {
  const dataset = validation.dataset;
  // The core decides the class of the evidence, never the metadata alone.
  const evidence = classifyValidationEvidence(dataset.splits[0]!, dataset.identity);
  expect(evidence.class).toBe("development");
  expect(evidence.representative_sample).toBe(false);
  expect(evidence.needs_fresh_evidence).toBe(true);
  expect(evidence.statement).toContain("targeted_challenge_set");
  expect(evidence.statement).toContain("supports no qualification claim");
  expect(evidence.statement).toContain("states no prevalence");
  // The runner prints the same classification beside the limits.
  expect(validation.evidence).toMatchObject({
    class: "development",
    representative_sample: false,
    needs_fresh_evidence: true,
  });
  expect(validation.summary).toContain("not one representative sample");
  expect(validation.summary).toContain("Production qualification needs one representative sample");
});

test("runCase carries one identifier and one input object alone", () => {
  for (const record of validation.dataset.cases) {
    const runCase = validation.dataset.runCase(record);
    expect(Object.keys(runCase).sort()).toEqual(["id", "input"]);
    const text = JSON.stringify(runCase);
    expect(text).not.toContain("expected");
    expect(text).not.toContain("author_type");
    expect(text).not.toContain("\"label\"");
    expect(text).not.toContain("reason");
  }
});

test("every input object holds the three declared inputs and fits the delivery limit", () => {
  for (const record of validation.dataset.cases) {
    expect(Object.keys(record.input).sort()).toEqual([
      "conversation",
      "prior_decision",
      "proposed_message",
    ]);
    const message = record.input.proposed_message;
    expect(typeof message).toBe("string");
    // The exact rule counts code points, and every reference states one pass.
    const length = Array.from(message as string).length;
    expect(length, `the message of ${record.id} fits 900 code points`).toBeLessThanOrEqual(900);
  }
});

test("the cases hold synthetic content only", () => {
  const text = JSON.stringify(validation.dataset.cases.map((record) => record.input));
  // No private chat platform, no link, and no address appears in the set.
  expect(text).not.toMatch(/discord/i);
  expect(text).not.toContain("http");
  expect(text).not.toContain("@");
  for (const record of validation.dataset.cases) {
    expect(record.label.origin).toBe("synthetic");
  }
});

test("the published README states the current revision and both content hashes", () => {
  const readme = readFileSync(readmeFile, "utf8");
  expect(readme).toContain(validation.dataset.identity.content_hash);
  expect(readme).toContain(validation.definition.content_hash);
  expect(readme).toContain(validation.dataset.identity.revision);
  expect(readme).toContain("`synthetic_challenge`");
});

test("the runner summary states the coverage, the provenance, and the limits", () => {
  expect(validation.summary).toContain("Public synthetic challenge set · offline validation");
  expect(validation.summary).toContain("Definition intervention-review · hash");
  expect(validation.summary).toContain("synthetic_challenge");
  expect(validation.summary).toContain(`References: ${validation.outcomes.pass} pass, ${validation.outcomes.fail} fail, ${validation.outcomes.review} review.`);
  expect(validation.summary).toContain("18 model-proposed without one human review");
  expect(validation.summary).toContain("states no prevalence");
  expect(validation.summary).toContain("supports no qualification claim");
  expect(validation.summary).toContain("this run measures no model");
});

test("the runner refuses one dataset that misses one required slice", async () => {
  const root = await writeModifiedRecords((record) => {
    // Strip one behavior slice from every case, so the coverage guard fires.
    const tags = (record.tags as unknown[]).filter((tag) => tag !== "decision-vs-suggestion");
    return { ...record, tags };
  });
  try {
    const message = await rejectionOf(() => validateChallenge({ root, log: () => {} }));
    expect(message).toContain("required slice");
    expect(message).toContain("decision-vs-suggestion");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner refuses one dataset that claims one human review", async () => {
  const root = await writeModifiedRecords((record) => {
    if (record.id !== CASE_IDS[0]) {
      return record;
    }
    // One review without task T063 breaks the stated provenance of the set.
    const label = record.label as Record<string, unknown>;
    return { ...record, label: { ...label, reviewed: true, reviewer: "One Reviewer" } };
  });
  try {
    const message = await rejectionOf(() => validateChallenge({ root, log: () => {} }));
    expect(message).toContain("human review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Writes one runnable copy of the dataset with modified records.
 *
 * The copy keeps the committed metadata and the committed flagship export,
 * so one modified record alone decides what the runner rejects. The returned
 * root feeds the `root` option of the compiled runner.
 */
async function writeModifiedRecords(
  modify: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const parent = mkdtempSync(path.join(tmpdir(), "measuretwice-challenge-"));
  const root = path.join(parent, "intervention-challenge");
  mkdirSync(path.join(root, "cases"), { recursive: true });
  mkdirSync(path.join(parent, "intervention-review", "definitions"), { recursive: true });
  await writeFile(
    path.join(parent, "intervention-review", "definitions", "intervention-review.json"),
    readFileSync(flagshipExport, "utf8"),
    "utf8",
  );
  await writeFile(
    path.join(root, "cases", "intervention-challenge.metadata.json"),
    readFileSync(path.join(exampleDir, "cases", "intervention-challenge.metadata.json"), "utf8"),
    "utf8",
  );
  const records = readFileSync(path.join(exampleDir, "cases", "intervention-challenge.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.stringify(modify(JSON.parse(line) as Record<string, unknown>)))
    .join("\n");
  await writeFile(path.join(root, "cases", "intervention-challenge.jsonl"), `${records}\n`, "utf8");
  return root;
}
