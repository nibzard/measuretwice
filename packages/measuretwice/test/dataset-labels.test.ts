// SPDX-License-Identifier: Apache-2.0
/**
 * Reference-label meaning and provenance tests.
 *
 * These tests cover task T040: the label review that `loadDataset`
 * returns. The Rust core checks every reference label against the meaning
 * of its check, flags one reference whose acceptance meaning disagrees with
 * its stated expected outcome instead of changing it, and counts the
 * provenance that keeps human judgments apart from model proposals. The
 * second half drives the shared conformance group
 * `fixtures/datasets/labels.json` through the public boundary, so the
 * binding answers the same fixtures the Rust core answers. Every path runs
 * through one injected file access, so the tests stay offline and
 * deterministic.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import {
  defineChecks,
  loadDataset,
  ValidationError,
  type DatasetMetadata,
  type FileAccess,
  type LabelSummary,
} from "../src/index.js";

/** One categorical question with one accepted, one review, and one
 * unacceptable answer. */
const messageReview = defineChecks({
  version: 1,
  name: "message-review",
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
      name: "Our message describes the evidence",
      using: ["prior_decision", "conversation", "proposed_message"],
      question: "Does every material claim in the proposed message follow from the evidence?",
      answers: {
        supported: "All claims are supported.",
        contradicted: "A material claim conflicts with the supplied evidence.",
        incomplete: "Support for a material claim is missing or ambiguous.",
      },
      accept: "supported",
      review: "incomplete",
    },
  ],
});

/** One complete metadata artifact for the tests. */
const METADATA: DatasetMetadata = {
  schema_version: 1,
  id: "label-cases",
  name: "Label provenance cases",
  revision: "2026-09-24.1",
  kind: "development_fixture",
  intended_population: "Proposed messages in support conversations.",
  sampling_method: "Selected from reviewed development work. No prevalence claim.",
  label_guidelines: "See docs/labeling.md revision 3.",
  languages: ["en"],
  splits: [
    { id: "fit", purpose: "fitting", groups: ["dates"] },
    { id: "holdout", purpose: "validation", groups: ["limits"] },
  ],
};

/** The input object of the categorical question. */
const INPUT = {
  prior_decision: "Ship on Friday.",
  conversation: "We agreed to ship on Thursday.",
  proposed_message: "We now ship on Thursday.",
};

/** One human-reviewed provenance record. */
const HUMAN_REVIEWED = {
  author_type: "human",
  origin: "collected",
  reviewed: true,
  reviewer: "Reviewer One",
  reason: "The answer follows from the supplied evidence.",
} as const;

/** One agent proposal that no human reviewed. */
const PROPOSAL = {
  author_type: "model",
  origin: "synthetic",
  reviewed: false,
  reason: "Agent proposal. No human review yet.",
} as const;

/** One corrected provenance record that keeps its earlier proposal. */
const CORRECTED = {
  author_type: "model",
  origin: "synthetic",
  reviewed: true,
  reviewer: "Reviewer One",
  reason: "The reference is ambiguous, so the check reviews.",
  history: [
    { author_type: "model", origin: "synthetic", reviewed: false, reason: "First proposal." },
  ],
} as const;

/** One record line with one reference of the question check. */
function labeledLine(
  id: string,
  reference: Record<string, unknown>,
  label: unknown,
  outcome?: string,
): string {
  return JSON.stringify({
    id,
    group: "dates",
    input: INPUT,
    expected: {
      checks: { "message-supported": reference },
      ...(outcome === undefined ? {} : { outcome }),
    },
    label,
  });
}

/** One record line without reference labels. */
function plainLine(id: string, label: unknown = PROPOSAL): string {
  return JSON.stringify({ id, group: "limits", input: INPUT, label });
}

/** Loads one records text through one in-memory file access. */
function loadRecords(records: string) {
  return loadDataset({
    definition: messageReview,
    metadata: ".measuretwice/cases/metadata.json",
    records: ".measuretwice/cases/records.jsonl",
    files: {
      async read(filePath: string): Promise<string> {
        if (filePath.endsWith("records.jsonl")) {
          return records;
        }
        if (filePath.endsWith("metadata.json")) {
          return JSON.stringify(METADATA);
        }
        throw new Error(`ENOENT: ${filePath}`);
      },
    },
  });
}

/** Loads one records text and returns the public failure it must throw. */
async function failureOf(records: string): Promise<ValidationError> {
  try {
    await loadRecords(records);
  } catch (error) {
    if (error instanceof ValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("the dataset was accepted");
}

test("the summary keeps human judgments apart from model proposals", async () => {
  const dataset = await loadRecords(
    [
      labeledLine("case-1", { answer: "supported", outcome: "pass" }, HUMAN_REVIEWED, "pass"),
      labeledLine("case-2", { answer: "contradicted", outcome: "fail" }, PROPOSAL, "fail"),
      plainLine("case-3"),
    ].join("\n"),
  );
  expect(dataset.labels.summary).toEqual({
    records: 3,
    labeled: 2,
    unlabeled: 1,
    human_reviewed: 1,
    human_unreviewed: 0,
    model_reviewed: 0,
    model_unreviewed: 1,
    corrected: 0,
    review_required: 0,
  } satisfies LabelSummary);
  expect(dataset.labels.findings).toEqual([]);

  // One dataset of proposals alone states no reviewed evidence.
  const proposals = await loadRecords(
    labeledLine("case-1", { answer: "supported" }, PROPOSAL),
  );
  const summary = proposals.labels.summary;
  expect(summary.model_unreviewed).toBe(1);
  expect(summary.human_reviewed + summary.model_reviewed).toBe(0);
});

test("one conflicting outcome loads, stays as written, and is flagged", async () => {
  const dataset = await loadRecords(
    labeledLine("case-1", { answer: "supported", outcome: "fail" }, HUMAN_REVIEWED),
  );
  expect(dataset.labels.findings).toHaveLength(1);
  const finding = dataset.labels.findings[0]!;
  expect(finding.kind).toBe("check_outcome_conflict");
  expect(finding.line).toBe(1);
  expect(finding.case_id).toBe("case-1");
  expect(finding.check_id).toBe("message-supported");
  expect(finding.field_path).toBe("/records/1/expected/checks/message-supported/outcome");
  expect(finding.message).toContain("supported");
  expect(finding.message).toContain("fail");
  expect(Object.isFrozen(finding)).toBe(true);

  // Nothing was resolved: the record keeps both fields as written.
  const reference = dataset.cases[0]!.expected?.checks["message-supported"];
  expect(reference?.answer).toBe("supported");
  expect(reference?.outcome).toBe("fail");
  expect(dataset.labels.summary.review_required).toBe(1);
});

test("one overall outcome that disagrees with its checks is flagged", async () => {
  const dataset = await loadRecords(
    labeledLine("case-1", { answer: "supported", outcome: "pass" }, HUMAN_REVIEWED, "fail"),
  );
  expect(dataset.labels.findings).toHaveLength(1);
  const finding = dataset.labels.findings[0]!;
  expect(finding.kind).toBe("overall_outcome_conflict");
  expect(finding.check_id).toBeNull();
  expect(finding.field_path).toBe("/records/1/expected/outcome");
  expect(finding.message).toContain("pass");
  expect(finding.message).toContain("fail");
});

test("ambiguous references keep their review marker and need one review", async () => {
  const dataset = await loadRecords(
    labeledLine("case-1", { review: true }, PROPOSAL, "review"),
  );
  expect(dataset.labels.findings).toEqual([]);
  expect(dataset.cases[0]!.expected?.checks["message-supported"]?.review).toBe(true);
  expect(dataset.labels.summary.review_required).toBe(1);
  expect(dataset.labels.summary.model_unreviewed).toBe(1);

  // One ambiguous reference beside one passing outcome conflicts.
  const conflicting = await loadRecords(
    labeledLine("case-2", { review: true, outcome: "pass" }, HUMAN_REVIEWED),
  );
  expect(conflicting.labels.findings).toHaveLength(1);
  expect(conflicting.labels.findings[0]!.kind).toBe("check_outcome_conflict");
});

test("consistent references report no conflict", async () => {
  for (const [reference, outcome] of [
    [{ answer: "supported" }, "pass"],
    [{ answer: "incomplete" }, "review"],
    [{ answer: "contradicted" }, "fail"],
  ] as const) {
    const dataset = await loadRecords(
      labeledLine("case-1", { ...reference, outcome }, HUMAN_REVIEWED, outcome),
    );
    expect(dataset.labels.findings, JSON.stringify(reference)).toEqual([]);
  }
});

test("one corrected reference keeps its earlier provenance", async () => {
  const dataset = await loadRecords(
    labeledLine("case-1", { answer: "incomplete", outcome: "review" }, CORRECTED, "review"),
  );
  expect(dataset.labels.summary.corrected).toBe(1);
  expect(dataset.labels.summary.model_reviewed).toBe(1);
  const label = dataset.cases[0]!.label;
  expect(label.reviewer).toBe("Reviewer One");
  expect(label.history).toEqual([
    { author_type: "model", origin: "synthetic", reviewed: false, reason: "First proposal." },
  ]);

  // The review is frozen data, like the rest of the dataset.
  expect(Object.isFrozen(dataset.labels)).toBe(true);
  expect(Object.isFrozen(dataset.labels.summary)).toBe(true);
  expect(Object.isFrozen(dataset.labels.findings)).toBe(true);
});

test("references outside the check meaning fail with their line and field", async () => {
  const unknownCheck = await failureOf(
    labeledLine("case-1", { outcome: "pass" }, HUMAN_REVIEWED).replace(
      '"message-supported"',
      '"tone"',
    ),
  );
  expect(unknownCheck.code).toBe("unknown_field");
  expect(unknownCheck.fieldPath).toBe("/records/1/expected/checks/tone");

  const unknownAnswer = await failureOf(
    labeledLine("case-1", { answer: "maybe", outcome: "pass" }, HUMAN_REVIEWED),
  );
  expect(unknownAnswer.code).toBe("unknown_label");
  expect(unknownAnswer.fieldPath).toBe("/records/1/expected/checks/message-supported/answer");

  const levelOnAnswers = await failureOf(
    labeledLine("case-1", { level: "supported", outcome: "pass" }, HUMAN_REVIEWED),
  );
  expect(levelOnAnswers.code).toBe("invalid_field_type");
  expect(levelOnAnswers.fieldPath).toBe("/records/1/expected/checks/message-supported/level");

  const answerBesideLevel = await failureOf(
    labeledLine(
      "case-1",
      { answer: "supported", level: "minor", outcome: "pass" },
      HUMAN_REVIEWED,
    ),
  );
  expect(answerBesideLevel.code).toBe("invalid_field_type");
  expect(answerBesideLevel.fieldPath).toBe("/records/1/expected/checks/message-supported");
});

// ---------------------------------------------------------------------------
// The shared conformance group through the public boundary.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesDir = path.join(repoRoot, "fixtures");

/** Reads one fixture file as the file access of `loadDataset`. */
const fixtureFiles: FileAccess = {
  async read(filePath: string): Promise<string> {
    return readFileSync(path.join(repoRoot, filePath), "utf8");
  },
};

/** One parsed record of the shared label fixtures. */
type FixtureRecord = {
  note?: string;
  definition?: string;
  records?: string;
  metadata?: DatasetMetadata;
  expected?: {
    findings?: {
      kind?: string;
      line?: number;
      case?: string;
      check?: string | null;
      field_path?: string;
    }[];
    summary?: LabelSummary;
    reason_code?: string;
    field_path?: string;
  };
};

test("the shared label fixtures answer identically through the boundary", async () => {
  const document = JSON.parse(
    readFileSync(path.join(fixturesDir, "datasets/labels.json"), "utf8"),
  ) as { definition?: string; metadata?: DatasetMetadata; valid?: FixtureRecord[]; invalid?: FixtureRecord[] };
  const defaultDefinition = document.definition ?? "categorical-question.json";
  const defaultMetadata = document.metadata!;

  expect(document.valid!.length).toBeGreaterThanOrEqual(6);
  for (const record of document.valid!) {
    const note = record.note!;
    const dataset = await loadDataset({
      definition: path.join("fixtures/definitions/valid", record.definition ?? defaultDefinition),
      metadata: ".measuretwice/cases/metadata.json",
      records: ".measuretwice/cases/records.jsonl",
      files: {
        async read(filePath: string): Promise<string> {
          if (filePath.endsWith("records.jsonl")) {
            return record.records!;
          }
          if (filePath.endsWith("metadata.json")) {
            return JSON.stringify(record.metadata ?? defaultMetadata);
          }
          return fixtureFiles.read(filePath);
        },
      },
    });

    const findings = dataset.labels.findings;
    const stated = record.expected?.findings ?? [];
    expect(findings, note).toHaveLength(stated.length);
    for (const [index, finding] of findings.entries()) {
      expect(finding.kind, note).toBe(stated[index]!.kind);
      expect(finding.line, note).toBe(stated[index]!.line);
      expect(finding.case_id, note).toBe(stated[index]!.case);
      expect(finding.check_id, note).toBe(stated[index]!.check ?? null);
      expect(finding.field_path, note).toBe(stated[index]!.field_path);
      expect(finding.message.length, note).toBeGreaterThan(0);
    }
    expect(dataset.labels.summary, note).toEqual(record.expected?.summary);
  }

  expect(document.invalid!.length).toBeGreaterThanOrEqual(8);
  for (const record of document.invalid!) {
    const note = record.note!;
    const error = await failureOfFixture(record, defaultDefinition, defaultMetadata);
    expect(error.code, note).toBe(record.expected?.reason_code);
    expect(error.fieldPath, note).toBe(record.expected?.field_path);
  }
});

/** Loads one invalid fixture record and returns the failure it must throw. */
async function failureOfFixture(
  record: FixtureRecord,
  defaultDefinition: string,
  defaultMetadata: DatasetMetadata,
): Promise<ValidationError> {
  try {
    await loadDataset({
      definition: path.join("fixtures/definitions/valid", record.definition ?? defaultDefinition),
      metadata: ".measuretwice/cases/metadata.json",
      records: ".measuretwice/cases/records.jsonl",
      files: {
        async read(filePath: string): Promise<string> {
          if (filePath.endsWith("records.jsonl")) {
            return record.records!;
          }
          if (filePath.endsWith("metadata.json")) {
            return JSON.stringify(record.metadata ?? defaultMetadata);
          }
          return fixtureFiles.read(filePath);
        },
      },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("the dataset was accepted");
}
