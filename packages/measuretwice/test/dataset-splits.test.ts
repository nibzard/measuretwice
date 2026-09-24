// SPDX-License-Identifier: Apache-2.0
/**
 * `loadDataset` split and identity tests.
 *
 * These tests cover the grouped splits and dataset identities of task
 * T041: the identity and the split identities that one load computes, the
 * group rule that keeps related conversations inside one split, the content
 * hashes that bind one revision to its records and catch one changed
 * input, the deterministic reproduction of one split under any file order,
 * the population statement that keeps targeted challenge sets apart from
 * representative samples, the overlap detection between one fitting
 * selection and one validation selection, and the evidence classification
 * that marks one reused holdout as development data. They read no disk
 * file: every path runs through one injected file access.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import {
  classifyValidationEvidence,
  defineChecks,
  detectSplitOverlap,
  loadDataset,
  requireSeparatedSplits,
  ValidationError,
  type DatasetIdentity,
  type DatasetMetadata,
  type DatasetSplitIdentity,
  type FileAccess,
} from "../src/index.js";

/** One exact-rule definition with one closed input schema. */
const typedLimits = defineChecks({
  version: 1,
  name: "typed-delivery-limits",
  inputs: Type.Object(
    {
      summary: Type.String({ minLength: 1 }),
      notice: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "summary-length",
      name: "The summary fits the delivery limit",
      using: ["summary"],
      rule: { maxLength: 80 },
    },
  ],
});

/** One complete metadata artifact for the tests. */
const METADATA: DatasetMetadata = {
  schema_version: 1,
  id: "delivery-cases",
  name: "Delivery limit cases",
  revision: "2026-09-24.1",
  kind: "development_fixture",
  intended_population: "Release notices of the delivery pipeline.",
  sampling_method: "Selected from reviewed development work. No prevalence claim.",
  label_guidelines: "See docs/labeling.md revision 3.",
  languages: ["en"],
  splits: [
    { id: "fit", purpose: "fitting", groups: ["notices-a"] },
    { id: "holdout", purpose: "validation", groups: ["notices-b"] },
  ],
};

/** One record line of one group. */
function line(id: string, group: string, summary: string): string {
  return JSON.stringify({
    id,
    group,
    input: { summary, notice: "One notice." },
    label: { author_type: "human", reviewed: false },
  });
}

/** One record file of two groups with two records each. */
function recordsFile(): string {
  return [
    line("notice-001", "notices-a", "The delivery limit is 900 characters"),
    line("notice-002", "notices-a", "A second summary"),
    line("notice-003", "notices-b", "A third summary"),
    line("notice-004", "notices-b", "A fourth summary"),
  ].join("\n");
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

/** Loads one dataset from one metadata value and one records text. */
function loadFiles(metadata: unknown, records: string) {
  return loadDataset({
    definition: typedLimits,
    metadata: ".measuretwice/cases/metadata.json",
    records: ".measuretwice/cases/records.jsonl",
    files: memoryFiles({
      ".measuretwice/cases/metadata.json": JSON.stringify(metadata),
      ".measuretwice/cases/records.jsonl": records,
    }),
  });
}

/** The identity of one split of one loaded dataset. */
function splitOf(splits: readonly DatasetSplitIdentity[], id: string): DatasetSplitIdentity {
  const split = splits.find((entry) => entry.split === id);
  expect(split, `the split ${id}`).toBeDefined();
  return split!;
}

test("one load returns the dataset identity and the split identities", async () => {
  const dataset = await loadFiles(METADATA, recordsFile());
  const identity = dataset.identity;
  expect(identity.dataset_id).toBe("delivery-cases");
  expect(identity.revision).toBe("2026-09-24.1");
  expect(identity.kind).toBe("development_fixture");
  expect(identity.population).toBe("development_fixture");
  expect(identity.supports_qualification).toBe(false);
  expect(identity.states_prevalence).toBe(false);
  expect(identity.intended_population).toBe("Release notices of the delivery pipeline.");
  expect(identity.sampling_method).toContain("No prevalence claim");
  expect(identity.record_count).toBe(4);
  expect(identity.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    identity.group_assignments.map((assignment) => [
      assignment.group,
      assignment.split_id,
      assignment.record_count,
    ]),
  ).toEqual([
    ["notices-a", "fit", 2],
    ["notices-b", "holdout", 2],
  ]);
  expect(identity.unassigned_groups).toEqual([]);

  const fitting = splitOf(dataset.splits, "fit");
  expect(fitting.dataset).toBe("delivery-cases");
  expect(fitting.revision).toBe("2026-09-24.1");
  expect(fitting.purpose).toBe("fitting");
  expect(fitting.groups).toEqual(["notices-a"]);
  expect(fitting.record_count).toBe(2);
  expect(fitting.case_ids).toEqual(["notice-001", "notice-002"]);
  expect(fitting.content_hash).toMatch(/^[a-f0-9]{64}$/);
  const validation = splitOf(dataset.splits, "holdout");
  expect(validation.purpose).toBe("validation");
  expect(validation.case_ids).toEqual(["notice-003", "notice-004"]);

  // Every returned value is frozen.
  expect(Object.isFrozen(dataset.identity)).toBe(true);
  expect(Object.isFrozen(dataset.splits)).toBe(true);
  expect(Object.isFrozen(dataset.splits[0])).toBe(true);
});

test("one representative sample states a population the other kinds deny", async () => {
  const sample = await loadFiles(
    { ...METADATA, kind: "representative_sample" },
    recordsFile(),
  );
  expect(sample.identity.population).toBe("representative_sample");
  expect(sample.identity.supports_qualification).toBe(true);
  expect(sample.identity.states_prevalence).toBe(true);

  const challenge = await loadFiles(
    { ...METADATA, kind: "synthetic_challenge" },
    recordsFile(),
  );
  expect(challenge.identity.population).toBe("targeted_challenge_set");
  expect(challenge.identity.supports_qualification).toBe(false);
  expect(challenge.identity.states_prevalence).toBe(false);
});

test("one record group that no split declares is reported, not invented", async () => {
  const dataset = await loadFiles(METADATA, [
    line("notice-001", "notices-a", "The delivery limit is 900 characters"),
    line("notice-009", "notices-c", "One summary of one unassigned group"),
  ].join("\n"));
  expect(dataset.identity.unassigned_groups).toEqual([
    { group: "notices-c", record_count: 1, first_line: 2 },
  ]);
  // The declared group without records keeps its assignment, and the empty
  // split stays visible with zero records.
  expect(dataset.identity.group_assignments).toEqual([
    { group: "notices-a", split_id: "fit", record_count: 1 },
    { group: "notices-b", split_id: "holdout", record_count: 0 },
  ]);
  expect(splitOf(dataset.splits, "holdout").record_count).toBe(0);
});

test("one group that two splits declare fails the load", async () => {
  const overlapping = {
    ...METADATA,
    splits: [
      { id: "fit", purpose: "fitting", groups: ["notices-a"] },
      { id: "holdout", purpose: "validation", groups: ["notices-a", "notices-b"] },
    ],
  };
  const error = await failureOf(() => loadFiles(overlapping, recordsFile()));
  expect(error.code).toBe("duplicate_id");
  expect(error.fieldPath).toBe("/splits/1/groups/0");
  expect(error.message).toContain("notices-a");
});

test("one stored hash that differs fails with hash_mismatch", async () => {
  const dataset = await loadFiles(METADATA, recordsFile());
  const wrong = "0".repeat(64);

  const declared = {
    ...METADATA,
    content_hash: wrong,
  };
  const error = await failureOf(() => loadFiles(declared, recordsFile()));
  expect(error.code).toBe("hash_mismatch");
  expect(error.fieldPath).toBe("/content_hash");

  const declaredSplit = {
    ...METADATA,
    splits: [
      { id: "fit", purpose: "fitting", groups: ["notices-a"] },
      {
        id: "holdout",
        purpose: "validation",
        groups: ["notices-b"],
        content_hash: wrong,
      },
    ],
  };
  const splitError = await failureOf(() => loadFiles(declaredSplit, recordsFile()));
  expect(splitError.code).toBe("hash_mismatch");
  expect(splitError.fieldPath).toBe("/splits/1/content_hash");

  // A stored hash that agrees changes nothing: the host writes the computed
  // hashes into the next revision.
  const agreed = {
    ...METADATA,
    content_hash: dataset.identity.content_hash,
    splits: [
      {
        id: "fit",
        purpose: "fitting",
        groups: ["notices-a"],
        content_hash: splitOf(dataset.splits, "fit").content_hash,
      },
      { id: "holdout", purpose: "validation", groups: ["notices-b"] },
    ],
  };
  const reloaded = await loadFiles(agreed, recordsFile());
  expect(reloaded.identity.content_hash).toBe(dataset.identity.content_hash);
});

test("one changed input changes the hash and splits reproduce under any order", async () => {
  const dataset = await loadFiles(METADATA, recordsFile());
  const shuffled = await loadFiles(METADATA, [
    line("notice-004", "notices-b", "A fourth summary"),
    line("notice-002", "notices-a", "A second summary"),
    line("notice-003", "notices-b", "A third summary"),
    line("notice-001", "notices-a", "The delivery limit is 900 characters"),
  ].join("\n"));
  expect(shuffled.identity.content_hash).toBe(dataset.identity.content_hash);
  expect(shuffled.splits.map((split) => split.content_hash)).toEqual(
    dataset.splits.map((split) => split.content_hash),
  );
  expect(shuffled.splits.map((split) => split.case_ids)).toEqual(
    dataset.splits.map((split) => split.case_ids),
  );

  // One changed input of the validation group changes the dataset hash and
  // the validation hash, never the fitting hash.
  const changed = await loadFiles(METADATA, [
    line("notice-001", "notices-a", "The delivery limit is 900 characters"),
    line("notice-002", "notices-a", "A second summary"),
    line("notice-003", "notices-b", "The changed summary"),
    line("notice-004", "notices-b", "A fourth summary"),
  ].join("\n"));
  expect(changed.identity.content_hash).not.toBe(dataset.identity.content_hash);
  expect(splitOf(changed.splits, "holdout").content_hash).not.toBe(
    splitOf(dataset.splits, "holdout").content_hash,
  );
  expect(splitOf(changed.splits, "fit").content_hash).toBe(
    splitOf(dataset.splits, "fit").content_hash,
  );
});

test("separated selections report no overlap and pass the requirement", async () => {
  const dataset = await loadFiles(METADATA, recordsFile());
  const overlap = detectSplitOverlap(
    splitOf(dataset.splits, "fit"),
    splitOf(dataset.splits, "holdout"),
  );
  expect(overlap.same_dataset).toBe(true);
  expect(overlap.separated).toBe(true);
  expect(overlap.shared_groups).toEqual([]);
  expect(overlap.shared_cases).toEqual([]);
  expect(() =>
    requireSeparatedSplits(
      splitOf(dataset.splits, "fit"),
      splitOf(dataset.splits, "holdout"),
    ),
  ).not.toThrow();
});

test("one shared group between two datasets is refused overlap", async () => {
  const first = await loadFiles(
    { ...METADATA, revision: "2026-09-24.1" },
    recordsFile(),
  );
  const second = await loadFiles(
    {
      ...METADATA,
      id: "delivery-cases-b",
      revision: "2026-09-24.2",
      splits: [
        { id: "fit", purpose: "fitting", groups: ["notices-c"] },
        { id: "holdout", purpose: "validation", groups: ["notices-a"] },
      ],
    },
    [
      line("notice-101", "notices-c", "One fitting summary"),
      line("notice-102", "notices-a", "One validation summary"),
    ].join("\n"),
  );
  const overlap = detectSplitOverlap(
    splitOf(first.splits, "fit"),
    splitOf(second.splits, "holdout"),
  );
  expect(overlap.same_dataset).toBe(false);
  expect(overlap.separated).toBe(false);
  expect(overlap.shared_groups).toEqual(["notices-a"]);
  const error = await failureOf(() =>
    requireSeparatedSplits(splitOf(first.splits, "fit"), splitOf(second.splits, "holdout")),
  );
  expect(error.code).toBe("duplicate_id");
  expect(error.fieldPath).toBe("/datasets/validation");
});

test("one duplicated case across two datasets is refused overlap", async () => {
  const fitting = await loadFiles(
    { ...METADATA, id: "fitting-cases", splits: [{ id: "fit", purpose: "fitting", groups: ["notices-a"] }] },
    [
      line("notice-001", "notices-a", "The delivery limit is 900 characters"),
      line("notice-002", "notices-a", "A second summary"),
    ].join("\n"),
  );
  const validation = await loadFiles(
    {
      ...METADATA,
      id: "validation-cases",
      revision: "2026-09-24.2",
      splits: [{ id: "holdout", purpose: "validation", groups: ["notices-b"] }],
    },
    [
      // The same case identifier reached both files under another group.
      line("notice-002", "notices-b", "A second summary"),
      line("notice-003", "notices-b", "A third summary"),
    ].join("\n"),
  );
  const overlap = detectSplitOverlap(
    splitOf(fitting.splits, "fit"),
    splitOf(validation.splits, "holdout"),
  );
  expect(overlap.shared_groups).toEqual([]);
  expect(overlap.shared_cases).toEqual(["notice-002"]);
  expect(overlap.separated).toBe(false);
  const error = await failureOf(() =>
    requireSeparatedSplits(splitOf(fitting.splits, "fit"), splitOf(validation.splits, "holdout")),
  );
  expect(error.code).toBe("duplicate_id");
  expect(error.message).toContain("notice-002");
});

test("a fresh validation split of one representative sample is independent evidence", async () => {
  const dataset = await loadFiles(
    { ...METADATA, kind: "representative_sample" },
    recordsFile(),
  );
  const holdout = splitOf(dataset.splits, "holdout");
  const evidence = classifyValidationEvidence(holdout, dataset.identity);
  expect(evidence.class).toBe("independent_validation");
  expect(evidence.representative_sample).toBe(true);
  expect(evidence.record_count).toBe(2);
  expect(evidence.reused_from).toEqual([]);
  expect(evidence.needs_fresh_evidence).toBe(false);
  expect(evidence.statement).toContain("2 records");
});

test("one reused holdout is development data that needs fresh evidence", async () => {
  const dataset = await loadFiles(
    { ...METADATA, kind: "representative_sample" },
    recordsFile(),
  );
  const holdout = splitOf(dataset.splits, "holdout");
  const identity: DatasetIdentity = dataset.identity;

  // The host states the holdout that the first claim consumed.
  const reused = classifyValidationEvidence(holdout, identity, [holdout]);
  expect(reused.class).toBe("development");
  expect(reused.needs_fresh_evidence).toBe(true);
  expect(reused.reused_from).toEqual([
    "delivery-cases revision 2026-09-24.1 split holdout",
  ]);
  expect(reused.statement).toContain("development data");

  // One renamed split of one other dataset that holds the same records is
  // the same holdout, because the content hash decides.
  const renamed: DatasetSplitIdentity = {
    ...holdout,
    dataset: "other-cases",
    revision: "2026-09-25.1",
    split: "holdout-2",
  };
  const renamedReuse = classifyValidationEvidence(holdout, identity, [renamed]);
  expect(renamedReuse.class).toBe("development");
  expect(renamedReuse.reused_from).toHaveLength(1);

  // One changed validation split is fresh content.
  const changed = await loadFiles(
    { ...METADATA, kind: "representative_sample" },
    [
      line("notice-001", "notices-a", "The delivery limit is 900 characters"),
      line("notice-002", "notices-a", "A second summary"),
      line("notice-003", "notices-b", "A third summary"),
      line("notice-004", "notices-b", "A fourth summary"),
      line("notice-005", "notices-c", "A fifth summary of one new group"),
    ].join("\n"),
  );
  // The new group must join one split, so the metadata declares it for the
  // validation split: the validation content changed.
  const extended = await loadFiles(
    {
      ...METADATA,
      kind: "representative_sample",
      splits: [
        { id: "fit", purpose: "fitting", groups: ["notices-a"] },
        { id: "holdout", purpose: "validation", groups: ["notices-b", "notices-c"] },
      ],
    },
    [
      line("notice-001", "notices-a", "The delivery limit is 900 characters"),
      line("notice-002", "notices-a", "A second summary"),
      line("notice-003", "notices-b", "A third summary"),
      line("notice-004", "notices-b", "A fourth summary"),
      line("notice-005", "notices-c", "A fifth summary of one new group"),
    ].join("\n"),
  );
  expect(changed.identity.unassigned_groups).toHaveLength(1);
  const fresh = classifyValidationEvidence(
    splitOf(extended.splits, "holdout"),
    extended.identity,
    [holdout],
  );
  expect(fresh.class).toBe("independent_validation");
  expect(fresh.needs_fresh_evidence).toBe(false);
});

test("one challenge set and one empty split support no qualification claim", async () => {
  const challenge = await loadFiles(
    { ...METADATA, kind: "synthetic_challenge" },
    recordsFile(),
  );
  const evidence = classifyValidationEvidence(
    splitOf(challenge.splits, "holdout"),
    challenge.identity,
  );
  expect(evidence.class).toBe("development");
  expect(evidence.representative_sample).toBe(false);
  expect(evidence.needs_fresh_evidence).toBe(true);
  expect(evidence.statement).toContain("targeted_challenge_set");

  // One split without records carries no evidence, even of one
  // representative sample.
  const empty = await loadFiles(
    { ...METADATA, kind: "representative_sample" },
    [
      line("notice-001", "notices-a", "The delivery limit is 900 characters"),
      line("notice-002", "notices-a", "A second summary"),
    ].join("\n"),
  );
  const emptyEvidence = classifyValidationEvidence(
    splitOf(empty.splits, "holdout"),
    empty.identity,
  );
  expect(emptyEvidence.class).toBe("development");
  expect(emptyEvidence.statement).toContain("no record");
});

test("one broken split selection fails with its field path", async () => {
  const dataset = await loadFiles(METADATA, recordsFile());
  const holdout = splitOf(dataset.splits, "holdout");

  const brokenHash = await failureOf(() =>
    detectSplitOverlap(splitOf(dataset.splits, "fit"), { ...holdout, content_hash: "nothex" }),
  );
  expect(brokenHash.code).toBe("invalid_field_type");
  expect(brokenHash.fieldPath).toBe("/content_hash");

  const brokenCount = await failureOf(() =>
    classifyValidationEvidence({ ...holdout, record_count: 9 }, dataset.identity),
  );
  expect(brokenCount.code).toBe("invalid_field_type");
  expect(brokenCount.fieldPath).toBe("/record_count");

  const brokenPopulation = await failureOf(() =>
    classifyValidationEvidence(holdout, {
      ...dataset.identity,
      population: "challenge" as never,
    }),
  );
  expect(brokenPopulation.code).toBe("invalid_field_type");
  expect(brokenPopulation.fieldPath).toBe("/population");

  const brokenUse = await failureOf(() =>
    classifyValidationEvidence(holdout, dataset.identity, [{ ...holdout, split: "Bad Id" }]),
  );
  expect(brokenUse.code).toBe("invalid_field_type");
  expect(brokenUse.fieldPath).toBe("/used/0/split");
});

test("the records of one split run through the same run case boundary", async () => {
  const dataset = await loadFiles(METADATA, recordsFile());
  const fitting = splitOf(dataset.splits, "fit");
  const members = dataset.cases.filter((entry) => fitting.case_ids.includes(entry.id));
  expect(members.map((entry) => entry.id)).toEqual(["notice-001", "notice-002"]);
  for (const member of members) {
    const runCase = dataset.runCase(member);
    expect(Object.keys(runCase)).toEqual(["id", "input"]);
  }
});
