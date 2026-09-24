// SPDX-License-Identifier: Apache-2.0
/**
 * `loadDataset` tests.
 *
 * These tests cover the dataset loader of task T039: explicit file access
 * for one metadata path and one JSONL records path, the complete core
 * validation of metadata and records, line and field locations on every
 * failure, the published size limits, and the run-case strip that keeps
 * reference labels and provenance out of every evaluator request. They
 * read no disk file: every path runs through one injected file access, so
 * they stay offline and deterministic.
 */
import { test, expect } from "vitest";
import Type from "typebox";
import {
  defineChecks,
  load,
  loadDataset,
  ValidationError,
  type DatasetMetadata,
  type Definition,
  type FileAccess,
} from "../src/index.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

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

/** One record line with labels, provenance, and a group. */
const LABELED_LINE = JSON.stringify({
  id: "notice-001",
  group: "notices-a",
  tags: ["basic", "pass"],
  input: { summary: "The delivery limit is 900 characters", notice: "One notice." },
  expected: {
    checks: { "summary-length": { outcome: "pass" } },
    outcome: "pass",
  },
  label: {
    author_type: "model",
    origin: "synthetic",
    reviewed: true,
    reviewer: "Reviewer One",
    reason: "The summary is 34 characters long.",
    history: [{ author_type: "model", origin: "synthetic", reviewed: false }],
  },
});

/** One record line without a group and without labels. */
const PLAIN_LINE = JSON.stringify({
  id: "notice-002",
  input: { summary: "A second summary", notice: "A second notice." },
  label: { author_type: "human", reviewed: false },
});

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
function loadFiles(metadata: unknown, records: string, files?: FileAccess) {
  return loadDataset({
    definition: typedLimits,
    metadata: ".measuretwice/cases/metadata.json",
    records: ".measuretwice/cases/records.jsonl",
    files: files ?? memoryFiles({
      ".measuretwice/cases/metadata.json": JSON.stringify(metadata),
      ".measuretwice/cases/records.jsonl": records,
    }),
  });
}

test("a complete dataset loads with its records and metadata", async () => {
  const dataset = await loadFiles(METADATA, `${LABELED_LINE}\n${PLAIN_LINE}`);
  expect(dataset.metadata.revision).toBe("2026-09-24.1");
  expect(dataset.metadata.kind).toBe("development_fixture");
  expect(dataset.metadata.splits.map((split) => split.purpose)).toEqual([
    "fitting",
    "validation",
  ]);
  expect(dataset.definition.name).toBe("typed-delivery-limits");
  expect(dataset.definition.content_hash).toMatch(/^[a-f0-9]{64}$/);

  expect(dataset.cases).toHaveLength(2);
  const first = dataset.cases[0]!;
  const second = dataset.cases[1]!;
  expect(first.line).toBe(1);
  expect(first.id).toBe("notice-001");
  expect(first.group).toBe("notices-a");
  expect(first.tags).toEqual(["basic", "pass"]);
  expect(first.label.author_type).toBe("model");
  expect(first.label.reviewed).toBe(true);
  expect(first.label.reviewer).toBe("Reviewer One");
  expect(first.label.history).toHaveLength(1);
  expect(first.expected?.outcome).toBe("pass");
  expect(first.expected?.checks["summary-length"]?.outcome).toBe("pass");
  expect(first.input_hash).toMatch(/^[a-f0-9]{64}$/);

  // One record without a group forms its own group. Line numbers follow
  // the file, not the array.
  expect(second.group).toBe("notice-002");
  expect(second.line).toBe(2);
  expect(second.expected).toBeUndefined();
});

test("a declared record count must match the record file", async () => {
  const matching = await loadFiles(
    { ...METADATA, record_count: 2 },
    `${LABELED_LINE}\n${PLAIN_LINE}`,
  );
  expect(matching.cases).toHaveLength(2);

  const error = await failureOf(() =>
    loadFiles({ ...METADATA, record_count: 3 }, `${LABELED_LINE}\n${PLAIN_LINE}`),
  );
  expect(error.code).toBe("invalid_field_type");
  expect(error.fieldPath).toBe("/record_count");
});

test("malformed and empty lines name their line number", async () => {
  const malformed = await failureOf(() =>
    loadFiles(METADATA, `${PLAIN_LINE}\n{"id": `),
  );
  expect(malformed.code).toBe("invalid_json");
  expect(malformed.fieldPath).toBe("/records/2");

  const empty = await failureOf(() => loadFiles(METADATA, `${PLAIN_LINE}\n\n`));
  expect(empty.code).toBe("invalid_json");
  expect(empty.fieldPath).toBe("/records/2");

  // One trailing newline ends the last line and adds no empty line.
  const trailing = await loadFiles(METADATA, `${PLAIN_LINE}\n`);
  expect(trailing.cases).toHaveLength(1);

  // One empty file holds one empty dataset.
  const none = await loadFiles(METADATA, "");
  expect(none.cases).toHaveLength(0);
});

test("a repeated case identifier names both lines", async () => {
  const error = await failureOf(() =>
    loadFiles(METADATA, `${LABELED_LINE}\n${LABELED_LINE}`),
  );
  expect(error.code).toBe("duplicate_id");
  expect(error.fieldPath).toBe("/records/2/id");
  expect(error.message).toContain("lines 1 and 2");
});

test("an invalid input names its line and field", async () => {
  const broken = JSON.stringify({
    id: "notice-003",
    input: { summary: "", notice: "One notice." },
    label: { author_type: "human", reviewed: false },
  });
  const error = await failureOf(() => loadFiles(METADATA, `${PLAIN_LINE}\n${broken}`));
  expect(error.code).toBe("invalid_field_type");
  expect(error.fieldPath).toBe("/records/2/input/summary");

  // One label that hides inside the input object fails the closed schema.
  const hidden = JSON.stringify({
    id: "notice-004",
    input: { summary: "One summary", notice: "One notice.", label: "pass" },
    label: { author_type: "human", reviewed: false },
  });
  const hiddenError = await failureOf(() => loadFiles(METADATA, hidden));
  expect(hiddenError.code).toBe("unknown_field");
  expect(hiddenError.fieldPath).toBe("/records/1/input/label");
});

test("broken metadata fails before any record is read", async () => {
  for (const field of ["revision", "kind", "intended_population", "sampling_method", "label_guidelines"]) {
    const metadata = { ...METADATA } as Record<string, unknown>;
    delete metadata[field];
    const error = await failureOf(() => loadFiles(metadata, PLAIN_LINE));
    expect(error.code, field).toBe("missing_field");
    expect(error.fieldPath, field).toBe(`/${field}`);
  }

  const error = await failureOf(() =>
    loadFiles({ ...METADATA, extra: 1 }, PLAIN_LINE),
  );
  expect(error.code).toBe("unknown_field");
  expect(error.fieldPath).toBe("/extra");
});

test("one record above the published line limit fails untruncated", async () => {
  const oversized = JSON.stringify({
    id: "notice-large",
    input: { summary: "a".repeat(9_000_000), notice: "One notice." },
    label: { author_type: "human", reviewed: false },
  });
  const error = await failureOf(() => loadFiles(METADATA, oversized));
  expect(error.code).toBe("oversized_input");
  expect(error.fieldPath).toBe("/records/1");
});

test("paths must name the declared formats", async () => {
  const files = memoryFiles({
    ".measuretwice/cases/metadata.json": JSON.stringify(METADATA),
    ".measuretwice/cases/records.jsonl": PLAIN_LINE,
  });

  const recordsPath = await failureOf(() =>
    loadDataset({
      definition: typedLimits,
      metadata: ".measuretwice/cases/metadata.json",
      records: ".measuretwice/cases/records.json",
      files,
    }),
  );
  expect(recordsPath.code).toBe("unsupported_format");
  expect(recordsPath.fieldPath).toBe("/records");

  const metadataPath = await failureOf(() =>
    loadDataset({
      definition: typedLimits,
      metadata: ".measuretwice/cases/records.jsonl",
      records: ".measuretwice/cases/records.jsonl",
      files,
    }),
  );
  expect(metadataPath.code).toBe("unsupported_format");
  expect(metadataPath.fieldPath).toBe("/metadata");

  const definitionPath = await failureOf(() =>
    loadDataset({
      definition: ".measuretwice/checks/limits.ts",
      metadata: ".measuretwice/cases/metadata.json",
      records: ".measuretwice/cases/records.jsonl",
      files,
    }),
  );
  expect(definitionPath.code).toBe("unsupported_format");
  expect(definitionPath.fieldPath).toBe("/definition");
});

test("an unreadable path keeps its cause as one ordinary error", async () => {
  const missing = memoryFiles({});
  await expect(loadDataset({
    definition: typedLimits,
    metadata: ".measuretwice/cases/metadata.json",
    records: ".measuretwice/cases/records.jsonl",
    files: missing,
  })).rejects.toThrow(/cannot read the path/);
});

test("the definition may arrive as one explicit JSON path", async () => {
  const definitionText = JSON.stringify(typedLimits);
  const dataset = await loadDataset({
    definition: "build/limits.json",
    metadata: ".measuretwice/cases/metadata.json",
    records: ".measuretwice/cases/records.jsonl",
    files: memoryFiles({
      "build/limits.json": definitionText,
      ".measuretwice/cases/metadata.json": JSON.stringify(METADATA),
      ".measuretwice/cases/records.jsonl": PLAIN_LINE,
    }),
  });
  expect(dataset.definition.name).toBe("typed-delivery-limits");
  expect(dataset.cases).toHaveLength(1);
});

test("runCase strips every label field and runs through load", async () => {
  const dataset = await loadFiles(METADATA, LABELED_LINE);
  const runCase = dataset.runCase(dataset.cases[0]!);
  expect(runCase.id).toBe("notice-001");
  expect(runCase.input).toEqual({
    summary: "The delivery limit is 900 characters",
    notice: "One notice.",
  });
  expect(Object.keys(runCase)).toEqual(["id", "input"]);

  // The stripped case runs end to end. The full record cannot: its label
  // fields stay outside the run-case envelope.
  const clock = new FakeClock(Date.UTC(2026, 8, 24));
  const reviewer = await load(typedLimits as Definition, {
    now: () => clock.nowMs(),
    nextRunId: sequenceIds("run"),
  });
  const report = await reviewer.run(runCase, { mode: "shadow" });
  expect(report.aggregate.outcome).toBe("pass");
  await expect(reviewer.run(dataset.cases[0]! as never, { mode: "shadow" })).rejects.toMatchObject(
    { code: "unknown_field", fieldPath: "/expected" },
  );
});

test("the loaded dataset is frozen and holds no host file writes", async () => {
  const reads: string[] = [];
  const files: FileAccess = {
    async read(filePath: string): Promise<string> {
      reads.push(filePath);
      if (filePath.endsWith(".jsonl")) {
        return PLAIN_LINE;
      }
      if (filePath.endsWith("metadata.json")) {
        return JSON.stringify(METADATA);
      }
      throw new Error(`ENOENT: ${filePath}`);
    },
  };
  const dataset = await loadDataset({
    definition: typedLimits,
    metadata: ".measuretwice/cases/metadata.json",
    records: ".measuretwice/cases/records.jsonl",
    files,
  });
  expect(reads).toEqual([
    ".measuretwice/cases/metadata.json",
    ".measuretwice/cases/records.jsonl",
  ]);
  expect(Object.isFrozen(dataset)).toBe(true);
  expect(Object.isFrozen(dataset.cases[0])).toBe(true);
  expect(Object.isFrozen(dataset.cases[0]!.label)).toBe(true);
  expect(Object.isFrozen(dataset.metadata)).toBe(true);
});
