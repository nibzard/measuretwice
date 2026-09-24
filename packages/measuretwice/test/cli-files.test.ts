// SPDX-License-Identifier: Apache-2.0
/**
 * The bounded validated file readers of the CLI, task T054.
 *
 * Every reader takes one explicit path, checks the format before one read,
 * bounds the file size before and after the read, and validates the content
 * through the same Rust boundary the library uses. The tests cover the
 * format gate, the size bound, unreadable paths, malformed JSON, the
 * artifact contracts, credential fields, and unregistered evaluator
 * references.
 */
import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { defineChecks, load, registerEvaluators } from "../src/index.js";
import { createLabelOnlyEvaluator } from "../src/test-evaluator.js";
import { createExplorationProfile } from "../src/exploration.js";
import { ValidationError } from "../src/error.js";
import { nativeComputeSelfHash } from "../src/native.js";
import {
  CLI_JSON_LIMIT_BYTES,
  CliFailure,
  cliFailureOf,
  defaultCliFiles,
  readCaseFile,
  readDatasetFiles,
  readDefinitionFile,
  readPlanFile,
  readProfileFile,
  readReportFile,
  resolveCliPath,
  type CliFileAccess,
} from "../src/cli-files.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exactRulesPath = path.join(repoRoot, "fixtures", "definitions", "valid", "exact-rules.json");

/** Writes one file into one fresh temporary directory and returns its path. */
function tempFile(name: string, content: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "measuretwice-cli-"));
  const file = path.join(directory, name);
  writeFileSync(file, content, "utf8");
  return file;
}

/** The failure shape that every test inspects. */
interface CaughtFailure {
  readonly code: string;
  readonly fieldPath: string;
  readonly message: string;
  readonly exit: number;
}

/** Runs one async reader and returns the CLI failure it threw. */
async function failureOf(read: () => Promise<unknown>): Promise<CaughtFailure> {
  try {
    await read();
  } catch (error) {
    return asFailure(error);
  }
  throw new Error("the reader accepted the input");
}

/** Runs one synchronous operation and returns the CLI failure it threw. */
function failureOfSync(operation: () => unknown): CaughtFailure {
  try {
    operation();
  } catch (error) {
    return asFailure(error);
  }
  throw new Error("the operation accepted the input");
}

/** Reads one thrown failure in the stable CLI shape. */
function asFailure(error: unknown): CaughtFailure {
  const failure = error as { code?: unknown; fieldPath?: unknown; exit?: unknown };
  if (
    typeof failure?.code === "string" &&
    typeof failure?.fieldPath === "string" &&
    typeof failure?.exit === "number" &&
    error instanceof Error
  ) {
    return {
      code: failure.code,
      fieldPath: failure.fieldPath,
      message: error.message,
      exit: failure.exit,
    };
  }
  throw new Error(`the reader threw one unexpected error: ${String(error)}`);
}

/** One counting access: it records every read and every size request. */
function countingAccess(text: string): { access: CliFileAccess; reads: () => number; sizes: () => number } {
  const state = { reads: 0, sizes: 0 };
  const access: CliFileAccess = {
    async read(): Promise<string> {
      state.reads += 1;
      return text;
    },
    async size(): Promise<number> {
      state.sizes += 1;
      return Buffer.byteLength(text, "utf8");
    },
  };
  return { access, reads: () => state.reads, sizes: () => state.sizes };
}

/** One access that proves the reader never touched the file system. */
function refusingAccess(): CliFileAccess {
  const refuse = async (): Promise<never> => {
    throw new Error("the reader touched the file access");
  };
  return { read: refuse, size: refuse };
}

/** A minimal complete calibration plan artifact of the frozen schema. */
function planArtifact(): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "message-supported-plan",
    definition: { name: "message-supported", content_hash: "a".repeat(64) },
    intended_population: "Proposed messages in support conversations.",
    sampling_assumptions: "Records are one development fixture. No prevalence claim.",
    confidence_level: 0.9,
    constraints: [{ metric: "false_acceptance_rate", limit: 0.05, direction: "at_most" }],
    objective: { metric: "automatic_coverage", direction: "maximize" },
    minimum_samples: { validation_records: 100 },
    candidate_grid: {
      accept_cutoff: [0.8, 0.9],
      rejection_cutoff: [0.5, 0.6],
    },
    evaluator: { id: "label-only-test", adapter_version: "0.1.0" },
    datasets: {
      fitting: { dataset: "message-supported-cases", revision: "2026-09-24.1", split: "fitting" },
      validation: {
        dataset: "message-supported-cases",
        revision: "2026-09-24.1",
        split: "validation",
      },
    },
  };
}

/** A minimal evaluation report artifact of the frozen schema. */
function reportArtifact(): Record<string, unknown> {
  return {
    schema_version: 1,
    definition: { name: "message-supported", content_hash: "b".repeat(64) },
    profile: { id: "message-supported-exploration", content_hash: "c".repeat(64) },
    dataset: {
      id: "message-supported-cases",
      revision: "2026-09-24.1",
      content_hash: "d".repeat(64),
    },
    purpose: "exploration",
    cases: [],
    metrics: [],
  };
}

test("readDefinitionFile validates one exported JSON definition through the core", async () => {
  const file = await readDefinitionFile(exactRulesPath);
  expect(file.path).toBe(exactRulesPath);
  expect(file.name).toBe("delivery-limits");
  expect(file.isExactOnly).toBe(true);
  expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(Object.isFrozen(file.artifact)).toBe(true);
  expect(file.artifact.name).toBe("delivery-limits");
  // The same hash that the library computes for the same file.
  const reviewer = await load(exactRulesPath);
  expect(file.contentHash).toBe(reviewer.definitionHash);
});

test("readDefinitionFile refuses one unreadable path with the cause", async () => {
  const missing = path.join(tmpdir(), "measuretwice-missing-definition.json");
  const failure = await failureOf(() => readDefinitionFile(missing));
  expect(failure.code).toBe("unreadable_file");
  expect(failure.exit).toBe(1);
  expect(failure.message).toContain("measuretwice cannot read");
});

test("readDefinitionFile keeps the reason code and field path of the core", async () => {
  const fixture = JSON.parse(
    readFileSync(path.join(repoRoot, "fixtures", "definitions", "invalid.json"), "utf8"),
  ) as {
    records: readonly { raw: unknown; expected: { reason_code: string; field_path: string } }[];
  };
  const first = fixture.records[0]!;
  const file = tempFile("invalid.json", JSON.stringify(first.raw));
  const failure = await failureOf(() => readDefinitionFile(file));
  expect(failure.code).toBe(first.expected.reason_code);
  expect(failure.fieldPath).toBe(first.expected.field_path);
  expect(failure.exit).toBe(1);
});

test("readDefinitionFile rejects one executable field without echoing its value", async () => {
  const valid = JSON.parse(readFileSync(exactRulesPath, "utf8")) as Record<string, unknown>;
  const hostile = { ...valid, script: "require('node:child_process').execSync('id')" };
  const file = tempFile("hostile.json", JSON.stringify(hostile));
  const failure = await failureOf(() => readDefinitionFile(file));
  expect(failure.code).toBe("unknown_field");
  expect(failure.fieldPath).toBe("/script");
  expect(failure.message).not.toContain("child_process");
  expect(failure.message).not.toContain("execSync");
});

test("the format gate fires before one read for YAML and TypeScript paths", async () => {
  for (const name of ["definition.yaml", "definition.yml", "definition.ts", "definition.mts"]) {
    const counting = countingAccess("{}");
    const failure = await failureOf(() => readDefinitionFile(name, { files: counting.access }));
    expect(failure.code, name).toBe("unsupported_format");
    expect(failure.exit).toBe(1);
    expect(counting.reads()).toBe(0);
    expect(counting.sizes()).toBe(0);
  }
  const yaml = await failureOf(() =>
    readDefinitionFile("definition.yaml", { files: refusingAccess() }),
  );
  expect(yaml.message).toContain("no YAML");
  const ts = await failureOf(() =>
    readDefinitionFile("definition.ts", { files: refusingAccess() }),
  );
  expect(ts.message).toContain("no TypeScript");
});

test("readDefinitionFile refuses malformed JSON without one content echo", async () => {
  const file = tempFile("broken.json", '{"name": "delivery-limits",\n');
  const failure = await failureOf(() => readDefinitionFile(file));
  expect(failure.code).toBe("invalid_json");
  expect(failure.message).toContain("broken.json");
  expect(failure.message).toMatch(/\(line \d+ column \d+\)/);
});

test("the size bound refuses one oversized file before and after the read", async () => {
  // Before the read: the stated size already exceeds the limit.
  const large = countingAccess("x".repeat(64));
  const refused = await failureOf(() =>
    readDefinitionFile("large.json", { files: large.access, limitBytes: 32 }),
  );
  expect(refused.code).toBe("oversized_input");
  expect(refused.message).toContain("32");
  expect(refused.message).toContain("No truncation");
  expect(large.reads()).toBe(0);
  expect(large.sizes()).toBe(1);

  // After the read: one access whose size understates the real text.
  const lying: CliFileAccess = {
    async read(): Promise<string> {
      return "x".repeat(64);
    },
    async size(): Promise<number> {
      return 1;
    },
  };
  const caught = await failureOf(() =>
    readDefinitionFile("lying.json", { files: lying, limitBytes: 32 }),
  );
  expect(caught.code).toBe("oversized_input");
});

test("the published limit for one CLI JSON file is the record-line limit", () => {
  expect(CLI_JSON_LIMIT_BYTES).toBe(8_388_608);
});

test("cliFailureOf maps one library ValidationError without changing its code", () => {
  const mapped = cliFailureOf(
    new ValidationError("unsupported_format", "The path names no JSON file.", "/definition"),
  ) as CliFailure;
  expect(mapped).toBeInstanceOf(CliFailure);
  expect(mapped.code).toBe("unsupported_format");
  expect(mapped.fieldPath).toBe("/definition");
  expect(mapped.exit).toBe(1);
});

test("readProfileFile verifies the stored self-hash and the profile contract", async () => {
  const reviewer = await load(exactRulesPath);
  const profile = reviewer.profile;
  expect(profile).toBeDefined();
  const file = tempFile("profile.json", JSON.stringify(profile));
  const read = await readProfileFile(file);
  expect(read.artifact.id).toBe(profile!.id);
  expect(read.artifact.content_hash).toBe(profile!.content_hash);
  expect(Object.isFrozen(read.artifact)).toBe(true);

  const edited = { ...profile!, intended_use: "an edited statement" };
  const tampered = tempFile("tampered.json", JSON.stringify(edited));
  const failure = await failureOf(() => readProfileFile(tampered));
  expect(failure.code).toBe("hash_mismatch");
  expect(failure.exit).toBe(1);
});

test("readProfileFile rejects one credential field with a valid self-hash", async () => {
  const reviewer = await load(exactRulesPath);
  const profile = reviewer.profile!;
  const artifact = { ...profile, api_key: "CANARY-PROFILE-SECRET" } as Record<string, unknown>;
  delete artifact.content_hash;
  const text = JSON.stringify({
    ...artifact,
    content_hash: nativeComputeSelfHash("profile", JSON.stringify(artifact)),
  });
  const file = tempFile("credential.json", text);
  const failure = await failureOf(() => readProfileFile(file));
  expect(failure.code).toBe("unknown_field");
  expect(failure.fieldPath).toBe("/api_key");
  expect(failure.message).not.toContain("CANARY-PROFILE-SECRET");
});

test("readProfileFile rejects one evaluator reference outside the registry", async () => {
  const checks = defineChecks({
    version: 1,
    name: "note-review",
    inputs: Type.Object(
      {
        note: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
    checks: [
      {
        id: "note-clear",
        name: "The note is clear",
        using: ["note"],
        question: "Is the note clear?",
        answers: {
          yes: "The note is clear.",
          no: "The note is not clear.",
        },
        accept: "yes",
        review: ["no"],
      },
    ],
  });
  const evaluator = createLabelOnlyEvaluator({ answers: {} });
  const registry = registerEvaluators(evaluator);
  const profile = createExplorationProfile(checks, registry);
  const file = tempFile("exploration.json", JSON.stringify(profile));

  const read = await readProfileFile(file, { evaluators: new Set([evaluator.id]) });
  expect(read.artifact.bindings[0]!.evaluator).toBe(evaluator.id);

  const failure = await failureOf(() =>
    readProfileFile(file, { evaluators: new Set(["some-other-evaluator"]) }),
  );
  expect(failure.code).toBe("evaluator_mismatch");
  expect(failure.fieldPath).toBe("/bindings/0/evaluator");
  expect(failure.message).toContain("note-clear");
  expect(failure.message).toContain("some-other-evaluator");
  expect(failure.exit).toBe(1);
});

test("readCaseFile validates one case file against the loaded definition", async () => {
  const definitionText = readFileSync(exactRulesPath, "utf8");
  const file = tempFile(
    "case.json",
    JSON.stringify({
      id: "case-1",
      input: { summary: "The summary states the delivery limit.", notice: "No secrets here." },
    }),
  );
  const read = await readCaseFile(file, definitionText);
  expect(read.caseId).toBe("case-1");
  expect(read.inputHash).toMatch(/^[0-9a-f]{64}$/);

  const invalid = tempFile(
    "invalid-case.json",
    JSON.stringify({ id: "case-2", input: { summary: "One summary alone." } }),
  );
  const failure = await failureOf(() => readCaseFile(invalid, definitionText));
  expect(failure.exit).toBe(1);
  expect(failure.fieldPath).toContain("/input");
});

test("readPlanFile gates the structure of one calibration plan", async () => {
  const file = tempFile("plan.json", JSON.stringify(planArtifact()));
  const read = await readPlanFile(file);
  expect(read.artifact.id).toBe("message-supported-plan");
  expect(Object.isFrozen(read.artifact)).toBe(true);

  const missing = planArtifact();
  delete missing.objective;
  const missingFile = tempFile("missing.json", JSON.stringify(missing));
  const failure = await failureOf(() => readPlanFile(missingFile));
  expect(failure.code).toBe("missing_field");
  expect(failure.fieldPath).toBe("/objective");

  const future = { ...planArtifact(), schema_version: 2 };
  const futureFile = tempFile("future.json", JSON.stringify(future));
  const version = await failureOf(() => readPlanFile(futureFile));
  expect(version.code).toBe("unsupported_schema_version");
});

test("readReportFile gates the structure of one evaluation report", async () => {
  const file = tempFile("report.json", JSON.stringify(reportArtifact()));
  const read = await readReportFile(file);
  expect(read.artifact.purpose).toBe("exploration");
  expect(Object.isFrozen(read.artifact)).toBe(true);

  const missing = reportArtifact();
  delete missing.metrics;
  const missingFile = tempFile("missing-metrics.json", JSON.stringify(missing));
  const failure = await failureOf(() => readReportFile(missingFile));
  expect(failure.code).toBe("missing_field");
  expect(failure.fieldPath).toBe("/metrics");
});

test("readDatasetFiles reads one metadata and records pair through the library gate", async () => {
  const fixture = JSON.parse(
    readFileSync(path.join(repoRoot, "fixtures", "datasets", "loading.json"), "utf8"),
  ) as {
    metadata: unknown;
    valid: readonly { records: string }[];
  };
  const metadata = tempFile("dataset.json", JSON.stringify(fixture.metadata));
  const records = tempFile("dataset.jsonl", fixture.valid[0]!.records);
  const source = await readDatasetFiles(metadata, records);
  expect(source.metadataText).toContain("message-supported-cases");
  expect(source.recordsText).toContain("message-supported-001");

  const yaml = await failureOf(() => readDatasetFiles("dataset.yaml", records));
  expect(yaml.code).toBe("unsupported_format");
  expect(yaml.message).toContain(".json");
});

test("defaultCliFiles reports the size of one real file", async () => {
  const size = await defaultCliFiles.size(exactRulesPath);
  const text = await defaultCliFiles.read(exactRulesPath);
  expect(size).toBe(Buffer.byteLength(text, "utf8"));
});

test("resolveCliPath maps one bare name into the .measuretwice convention", () => {
  const cwd = path.sep === "/" ? "/work" : "C:\\work";
  const join = path.join.bind(path);
  expect(resolveCliPath("definition", "intervention", cwd)).toBe(
    join(cwd, ".measuretwice", "definitions", "intervention.json"),
  );
  expect(resolveCliPath("profile", "candidate", cwd)).toBe(
    join(cwd, ".measuretwice", "profiles", "candidate.json"),
  );
  expect(resolveCliPath("case", "example", cwd)).toBe(
    join(cwd, ".measuretwice", "cases", "example.json"),
  );
  expect(resolveCliPath("dataset-records", "holdout", cwd)).toBe(
    join(cwd, ".measuretwice", "cases", "holdout.jsonl"),
  );
  expect(resolveCliPath("dataset-metadata", "holdout", cwd)).toBe(
    join(cwd, ".measuretwice", "cases", "holdout.json"),
  );
  expect(resolveCliPath("plan", "calibration-plan", cwd)).toBe(
    join(cwd, ".measuretwice", "calibration-plan.json"),
  );
  expect(resolveCliPath("report", "candidate", cwd)).toBe(
    join(cwd, ".measuretwice", "reports", "candidate.json"),
  );

  // Explicit paths stay as stated.
  expect(resolveCliPath("definition", join(cwd, "elsewhere", "d.json"), cwd)).toBe(
    join(cwd, "elsewhere", "d.json"),
  );
  expect(resolveCliPath("definition", ".measuretwice/definitions/d.json", cwd)).toBe(
    ".measuretwice/definitions/d.json",
  );

  // Wrong formats refuse with the registry code before one read.
  const yaml = failureOfSync(() => resolveCliPath("definition", "definitions/d.yaml", cwd));
  expect(yaml.code).toBe("unsupported_format");
  const yml = failureOfSync(() => resolveCliPath("dataset-records", "holdout.yml", cwd));
  expect(yml.code).toBe("unsupported_format");
  const ts = failureOfSync(() => resolveCliPath("definition", "definitions/d.ts", cwd));
  expect(ts.code).toBe("unsupported_format");
  const planName = failureOfSync(() => resolveCliPath("plan", "my-plan", cwd));
  expect(planName.code).toBe("unsupported_format");
  expect(planName.message).toContain(".measuretwice/calibration-plan.json");
});
