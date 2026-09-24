// SPDX-License-Identifier: Apache-2.0
/**
 * Exact-rule vertical-slice verification.
 *
 * These tests verify the first complete Rust-to-TypeScript path as one
 * slice, before any semantic execution arrives: identical cases run through
 * TypeBox authoring and through the exported JSON definition must give equal
 * canonical content, equal hashes, equal rule outcomes, and byte-equal
 * serialized reports. The suite also drives every exact string rule fixture
 * record, the Unicode boundaries, the malformed requests, and the invalid
 * cases through the complete public path, and it proves that the slice needs
 * no network, no credential, and no provider package. It reads local files
 * only, so it stays offline and deterministic.
 */
import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Type from "typebox";
import { defineChecks, load, ValidationError, type FileAccess } from "../src/index.js";
import {
  NativeFailure,
  nativeCanonicalForm,
  nativeValidateDefinition,
} from "../src/native.js";
import { sequenceIds } from "./support/deterministic.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Reads one fixture file as text. */
function fixtureText(relative: string): string {
  return readFileSync(path.join(repoRoot, "fixtures", relative), "utf8");
}

/** Reads one fixture file as one JSON value. */
function fixtureDocument(relative: string): any {
  return JSON.parse(fixtureText(relative));
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

/** Runs one native operation and returns the failure it must throw. */
function nativeFailureOf(operation: () => unknown): NativeFailure {
  try {
    operation();
  } catch (error) {
    if (error instanceof NativeFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("the native boundary was accepted");
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

/** The fixed terminal time of every slice run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** Load options pinned to the fixed clock and one fresh identifier sequence. */
function sliceOptions(): { now: () => number; nextRunId: () => string } {
  return { now: () => START_MS, nextRunId: sequenceIds("run") };
}

/** The shared fixture definition that holds all three exact rule types. */
const EXACT_RULES_PATH = "definitions/valid/exact-rules.json";

/**
 * The delivery-limits definition of the shared fixtures, authored inline.
 *
 * The authored key order differs from the exported file on purpose: TypeBox
 * emits `required` before `properties`. Canonical content, not authoring key
 * order, states the artifact identity.
 */
const typedDeliveryLimits = defineChecks({
  version: 1,
  name: "delivery-limits",
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
    {
      id: "summary-mentions-limit",
      name: "The summary states the delivery limit",
      using: ["summary"],
      rule: { includes: "delivery limit" },
    },
    {
      id: "notice-hides-secrets",
      name: "The notice contains no secret marker",
      using: ["notice"],
      rule: { excludes: "SECRET" },
    },
  ],
});

// ---------------------------------------------------------------------------
// TypeBox authoring against the exported JSON: one artifact identity.
// ---------------------------------------------------------------------------

test("TypeBox authoring and exported JSON give equal canonical content and hashes", () => {
  const typedText = JSON.stringify(typedDeliveryLimits);
  const exportedText = fixtureText(EXACT_RULES_PATH);

  // The contents agree. Authoring key order carries no meaning.
  expect(JSON.parse(typedText)).toEqual(JSON.parse(exportedText));
  expect(nativeCanonicalForm(typedText)).toBe(nativeCanonicalForm(exportedText));

  const typedInfo = nativeValidateDefinition(typedText);
  const exportedInfo = nativeValidateDefinition(exportedText);
  expect(typedInfo.definitionHash).toBe(exportedInfo.definitionHash);
  expect(typedInfo.checkKinds).toEqual(exportedInfo.checkKinds);
  expect(typedInfo.isExactOnly).toBe(true);

  // The identity is the published fixture hash, not one side's own value.
  const published = fixtureDocument("hashing/canonical.json").hashes.find(
    (record: { domain: string; value: { name: string } }) =>
      record.domain === "definition" && record.value.name === "delivery-limits",
  );
  expect(published).toBeDefined();
  expect(typedInfo.definitionHash).toBe(published?.content_hash);
});

/** One case of the equivalence matrix, with its expected aggregate. */
interface SliceCase {
  readonly note: string;
  readonly input: { readonly summary: string; readonly notice: string };
  readonly aggregate: "pass" | "fail";
}

/** Cases that cover every rule outcome mix and the Unicode boundaries. */
const SLICE_CASES: readonly SliceCase[] = [
  {
    note: "every rule passes",
    input: { summary: "The delivery limit is 900 characters", notice: "One notice." },
    aggregate: "pass",
  },
  {
    note: "the summary exceeds the length limit",
    input: { summary: "A".repeat(81), notice: "One notice." },
    aggregate: "fail",
  },
  {
    note: "the summary omits the required phrase",
    input: { summary: "A short summary.", notice: "One notice." },
    aggregate: "fail",
  },
  {
    note: "the notice carries the secret marker",
    input: { summary: "The delivery limit is 900 characters", notice: "handle with SECRET care" },
    aggregate: "fail",
  },
  {
    note: "astral-plane, accented, and null code points",
    input: {
      summary: "The delivery limit is 900 characters 😀 café!",
      notice: "café with a \u0000 null",
    },
    aggregate: "pass",
  },
];

test("identical cases give equal rule outcomes and byte-equal reports", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "measuretwice-slice-"));
  try {
    // One reviewer per authoring path: the trusted typed import, and the
    // exported JSON file read through the default file access.
    const definitionPath = path.join(work, "delivery-limits.json");
    writeFileSync(definitionPath, fixtureText(EXACT_RULES_PATH));
    const typedReviewer = await load(typedDeliveryLimits, sliceOptions());
    const jsonReviewer = await load(definitionPath, sliceOptions());
    expect(jsonReviewer.definitionHash).toBe(typedReviewer.definitionHash);
    expect(jsonReviewer.profile?.content_hash).toBe(typedReviewer.profile?.content_hash);

    for (const [index, slice] of SLICE_CASES.entries()) {
      const caseInput = { id: `slice-case-${index}`, input: slice.input };
      const typedReport = await typedReviewer.run(caseInput);
      const jsonReport = await jsonReviewer.run(caseInput);
      expect(typedReport.aggregate.outcome, slice.note).toBe(slice.aggregate);
      expect(typedReport.completion, slice.note).toEqual({
        status: "completed",
        completed_at: "2026-09-24T00:00:00.000Z",
      });
      // Equal component outcomes, executed rules, and serialized reports.
      expect(typedReport.checks.map((record) => [record.check, record.outcome]), slice.note).toEqual(
        jsonReport.checks.map((record) => [record.check, record.outcome]),
      );
      expect(
        typedReport.checks.map((record) => record.applied_rule),
        slice.note,
      ).toEqual(jsonReport.checks.map((record) => record.applied_rule));
      expect(JSON.stringify(jsonReport), slice.note).toBe(JSON.stringify(typedReport));
    }

    // The same reviewer keeps drawing identifiers from its sequence.
    const again = await typedReviewer.run({
      id: "slice-case-0",
      input: SLICE_CASES[0]!.input,
    });
    expect(again.run_id).toBe(`run-${String(SLICE_CASES.length + 1).padStart(6, "0")}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Every exact string rule and Unicode boundary through the complete path.
// ---------------------------------------------------------------------------

/** One record of the shared string rule fixtures. */
interface StringRuleRecord {
  readonly note: string;
  readonly rule: string;
  readonly parameter: number | string;
  readonly input: string;
  readonly outcome: string;
}

test("every exact string rule fixture holds through the complete public path", async () => {
  const records: StringRuleRecord[] = fixtureDocument("hashing/string-rules.json").string_rules;
  expect(records.length).toBeGreaterThanOrEqual(20);

  const files: Record<string, string> = {};
  for (const [index, record] of records.entries()) {
    files[`rules/rule-${index}.json`] = JSON.stringify({
      schema_version: 1,
      name: `rule-probe-${index}`,
      inputs: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      checks: [
        {
          id: "probe",
          name: "The probe rule",
          using: ["text"],
          rule: { [record.rule]: record.parameter },
        },
      ],
    });
  }
  const files0 = memoryFiles(files);

  const keywords = new Set<string>();
  let nonAsciiSeen = false;
  let nullSeen = false;
  let astralSeen = false;
  for (const [index, record] of records.entries()) {
    const reviewer = await load(`rules/rule-${index}.json`, {
      files: files0,
      now: () => START_MS,
      nextRunId: sequenceIds("rule"),
    });
    const report = await reviewer.run({ id: `rule-case-${index}`, input: { text: record.input } });
    expect(report.completion.status, record.note).toBe("completed");
    expect(report.aggregate.outcome, record.note).toBe(record.outcome);
    const check = report.checks[0];
    expect(check?.kind, record.note).toBe("rule");
    expect(check?.outcome, record.note).toBe(record.outcome);
    expect(check?.applied_rule?.rule, record.note).toBe(record.rule);
    expect(check?.applied_rule?.input, record.note).toBe("text");
    expect(check?.applied_rule?.parameters, record.note).toEqual({
      [record.rule]: record.parameter,
    });

    keywords.add(record.rule);
    nonAsciiSeen ||= /[^\u0000-\u007f]/u.test(record.input);
    nullSeen ||= record.input.includes("\u0000");
    astralSeen ||= [...record.input].some((point) => (point.codePointAt(0) ?? 0) > 0xffff);
  }
  // All three exact rule types ran, and the table reached its Unicode edges.
  expect([...keywords].sort()).toEqual(["excludes", "includes", "maxLength"]);
  expect(nonAsciiSeen).toBe(true);
  expect(nullSeen).toBe(true);
  expect(astralSeen).toBe(true);
});

// ---------------------------------------------------------------------------
// Malformed requests and invalid cases, before any execution.
// ---------------------------------------------------------------------------

test("malformed definition requests fail with the same codes at both boundaries", async () => {
  const artifact = JSON.parse(fixtureText(EXACT_RULES_PATH));
  const files: Record<string, string> = {
    "malformed.json": '{"schema_version": ',
    "array.json": "[]",
    "number.json": "42",
    "version.json": JSON.stringify({ ...artifact, schema_version: 2 }),
    "empty.json": JSON.stringify({ ...artifact, checks: [] }),
  };
  const table: ReadonlyArray<readonly [string, string, string]> = [
    ["malformed.json", "invalid_json", ""],
    ["array.json", "invalid_field_type", ""],
    ["number.json", "invalid_field_type", ""],
    ["version.json", "unsupported_schema_version", "/schema_version"],
    ["empty.json", "empty_check_set", "/checks"],
  ];
  for (const [filePath, code, fieldPath] of table) {
    // The native boundary and the public loader report the same failure.
    expect(nativeFailureOf(() => nativeValidateDefinition(files[filePath] ?? "")).code, filePath).toBe(
      code,
    );
    const failure = await failureOf(() =>
      load(filePath, { files: memoryFiles(files), now: () => START_MS }),
    );
    expect(failure.code, filePath).toBe(code);
    expect(failure.fieldPath, filePath).toBe(fieldPath);
    expect(failure.message, filePath).not.toBe("");
  }
  // A path that names no JSON file fails before one read.
  const format = await failureOf(() =>
    load("checks/intervention.yaml", { files: memoryFiles(files), now: () => START_MS }),
  );
  expect(format.code).toBe("unsupported_format");
  expect(format.fieldPath).toBe("/definition");
});

test("invalid cases fail through the core before any rule runs", async () => {
  const reviewer = await load(typedDeliveryLimits, sliceOptions());
  const passing = SLICE_CASES[0]!.input;
  const table: ReadonlyArray<readonly [string, unknown, string, string]> = [
    [
      "a missing input field",
      { id: "case-9", input: { summary: "Only one input." } },
      "missing_field",
      "/input/notice",
    ],
    [
      "an unknown input field",
      { id: "case-9", input: { ...passing, label: "expected pass" } },
      "unknown_field",
      "/input/label",
    ],
    [
      "a wrong input type",
      { id: "case-9", input: { summary: 5, notice: "One notice." } },
      "invalid_field_type",
      "/input/summary",
    ],
    ["a wrong case identifier type", { id: 42, input: passing }, "invalid_field_type", "/id"],
    [
      "a field outside the case envelope",
      { id: "case-9", input: passing, baseline: "pass" },
      "unknown_field",
      "/baseline",
    ],
    [
      "a lone surrogate in the input",
      { id: "case-9", input: { summary: "a\ud800b", notice: "One notice." } },
      "nonportable_value",
      "",
    ],
  ];
  for (const [note, badCase, code, fieldPath] of table) {
    const failure = await failureOf(() =>
      reviewer.run(badCase as { id: string; input: { summary: string; notice: string } }),
    );
    expect(failure.code, note).toBe(code);
    expect(failure.fieldPath, note).toBe(fieldPath);
  }
  // An unknown mode fails before any case work starts.
  const mode = await failureOf(() =>
    reviewer.run(
      { id: "case-9", input: passing },
      { mode: "audit" as unknown as "shadow" },
    ),
  );
  expect(mode.code).toBe("invalid_field_type");
  expect(mode.fieldPath).toBe("/mode");
});

// ---------------------------------------------------------------------------
// No credentials, no network, and no provider packages.
// ---------------------------------------------------------------------------

test("the public package depends on no provider package", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "packages", "measuretwice", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  // The runtime dependency of the public package is the authoring library.
  // The native binding ships beside the compiled code as `binding.cjs`, and
  // the private binding package is no dependency. A provider SDK belongs
  // to an adapter, never here.
  expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["typebox"]);
});

test("the complete slice runs with no network and no credential read", () => {
  const packageEntry = path.join(repoRoot, "packages", "measuretwice", "dist", "index.js");
  const typeboxEntry = path.join(repoRoot, "node_modules", "typebox", "build", "index.mjs");
  const definitionPath = path.join(repoRoot, "fixtures", "definitions", "valid", "exact-rules.json");
  const caseText = JSON.stringify({
    id: "offline-case",
    input: { summary: "The delivery limit is 900 characters", notice: "One notice." },
  });
  const child = `
globalThis.fetch = () => { throw new Error("network call attempted"); };
const realEnv = process.env;
Object.defineProperty(process, "env", {
  configurable: true,
  get() {
    return new Proxy(realEnv, {
      get(target, name) {
        const key = String(name);
        if (/(api[_-]?key|token|secret|credential|password)/i.test(key)) {
          throw new Error("credential environment read: " + key);
        }
        return target[name];
      },
    });
  },
});
const { defineChecks, load } = await import(${JSON.stringify(pathToFileURL(packageEntry).href)});
const Type = (await import(${JSON.stringify(pathToFileURL(typeboxEntry).href)})).default;
const typed = defineChecks({
  version: 1,
  name: "delivery-limits",
  inputs: Type.Object(
    { summary: Type.String({ minLength: 1 }), notice: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  checks: [
    { id: "summary-length", name: "The summary fits the delivery limit", using: ["summary"], rule: { maxLength: 80 } },
    { id: "summary-mentions-limit", name: "The summary states the delivery limit", using: ["summary"], rule: { includes: "delivery limit" } },
    { id: "notice-hides-secrets", name: "The notice contains no secret marker", using: ["notice"], rule: { excludes: "SECRET" } },
  ],
});
const options = () => ({
  now: () => Date.UTC(2026, 8, 24),
  nextRunId: (() => { let next = 0; return () => "run-" + String(++next).padStart(6, "0"); })(),
});
const typedReviewer = await load(typed, options());
const jsonReviewer = await load(${JSON.stringify(definitionPath)}, options());
if (typedReviewer.definitionHash !== jsonReviewer.definitionHash) {
  throw new Error("hash drift between the authoring paths");
}
const typedReport = await typedReviewer.run(JSON.parse(${JSON.stringify(caseText)}));
const jsonReport = await jsonReviewer.run(JSON.parse(${JSON.stringify(caseText)}));
if (JSON.stringify(typedReport) !== JSON.stringify(jsonReport)) {
  throw new Error("report drift between the authoring paths");
}
if (typedReport.aggregate.outcome !== "pass" || typedReport.completion.status !== "completed") {
  throw new Error("unexpected report");
}
console.log("SLICE_OFFLINE_OK");
`;
  const work = mkdtempSync(path.join(tmpdir(), "measuretwice-slice-offline-"));
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", child],
      { cwd: work, encoding: "utf8" },
    );
    expect(stdout).toContain("SLICE_OFFLINE_OK");
    // The slice wrote no application storage into its working directory.
    expect(readdirSync(work)).toEqual([]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
