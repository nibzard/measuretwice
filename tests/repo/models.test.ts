// SPDX-License-Identifier: Apache-2.0
/**
 * Formal-model record checks.
 *
 * TLC itself runs outside the ordinary suite, as `models/README.md`
 * records, because its jar is not part of the repository. These checks
 * keep the published record honest without executing TLC: every
 * transition, invariant, and property that the record names exists in
 * the module, every configuration declares them with bounded constants,
 * and the record states the tool version, the command, the results, and
 * the fairness. The checks read local files only.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const executionDir = path.join(repoRoot, "models", "execution");

const MODULE = "Execution.tla";
const CONFIGS = ["Execution.cfg", "ExecutionSaturation.cfg"];

/** The transitions the execution record names. */
const TRANSITIONS = [
  "SubmitStart", "SubmitDrift", "SubmitQueued", "SubmitSkipped",
  "StartRetry", "RetryDrift", "AttemptFail", "AcceptResult",
  "DuplicateResult", "LateResult", "Cancel", "Deadline", "Complete",
];

/** The safety invariants the execution record names. */
const INVARIANTS = [
  "TypeOK", "ActiveWithinLimit", "FreshPendingWithinLimit", "AttemptsBounded",
  "AttemptBindingStable", "StatePartition", "NoErrorSkipToPass",
  "TerminalReportFrozen", "TerminalRecordsComplete",
];

const CONSTANTS = ["NumChecks", "MaxActive", "MaxPending", "MaxAttempts"];

/**
 * The reason codes the module may write. They come from the stable
 * registry in `contracts/README.md`; the module may add no others.
 */
const STABLE_REASONS = new Set([
  "retries_exhausted", "run_cancelled", "deadline_exceeded",
  "queue_full", "cancelled_before_start", "deadline_before_start",
]);

function read(name: string): string {
  return readFileSync(path.join(executionDir, name), "utf8");
}

function defines(moduleText: string, name: string): boolean {
  return new RegExp(`^${name}(\\([^)]*\\))? ==`, "m").test(moduleText);
}

test("the execution module defines every transition and invariant the record names", () => {
  const moduleText = read(MODULE);
  for (const name of [...TRANSITIONS, ...INVARIANTS, "RunTerminates", "Init", "Next", "Spec", "Fairness", "vars"]) {
    expect(defines(moduleText, name), `${name} is not defined`).toBe(true);
  }
});

test("the next-state relation covers every transition", () => {
  const moduleText = read(MODULE);
  const start = moduleText.indexOf("Next ==");
  const end = moduleText.indexOf("(***", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const nextRelation = moduleText.slice(start, end);
  for (const name of TRANSITIONS) {
    expect(new RegExp(`\\b${name}\\b`).test(nextRelation), `${name} is outside the next-state relation`).toBe(true);
  }
});

test("each configuration declares the specification, the invariants, the property, and bounded constants", () => {
  const record = read("README.md");
  for (const config of CONFIGS) {
    const text = read(config);
    expect(text, config).toContain("SPECIFICATION Spec");
    expect(text, config).toContain("PROPERTY");
    expect(text, config).toContain("RunTerminates");
    for (const invariant of INVARIANTS) {
      expect(text, `${config} omits ${invariant}`).toContain(invariant);
    }
    const values: Record<string, number> = {};
    for (const constant of CONSTANTS) {
      const match = new RegExp(`^\\s*${constant} = (\\d+)$`, "m").exec(text);
      expect(match, `${config} omits ${constant}`).not.toBeNull();
      values[constant] = Number(match?.[1]);
    }
    expect(values.NumChecks).toBeGreaterThanOrEqual(1);
    expect(values.MaxActive).toBeGreaterThanOrEqual(1);
    expect(values.MaxPending).toBeGreaterThanOrEqual(0);
    expect(values.MaxAttempts).toBeGreaterThanOrEqual(1);
    expect(values.MaxAttempts).toBeLessThanOrEqual(3);
    expect(values.NumChecks).toBeLessThanOrEqual(3);
    // The bounds table in the record states the same numbers.
    const row = record.split("\n").find((line) => line.includes(`(${config})`));
    expect(row, `the record has no bounds row for ${config}`).toBeDefined();
    expect(row).toContain(
      `| ${values.NumChecks} | ${values.MaxActive} | ${values.MaxPending} | ${values.MaxAttempts} |`,
    );
  }
});

test("every reason code the module writes is a stable registry code", () => {
  const moduleText = read(MODULE);
  const written = [...moduleText.matchAll(/"([a-z]+(?:_[a-z]+)+)"/g)].map((match) => match[1] as string);
  const outside = written.filter((code) => !STABLE_REASONS.has(code));
  expect(new Set(written).size).toBeGreaterThan(0);
  expect(outside, `codes outside the registry: ${outside.join(", ")}`).toEqual([]);
});

test("the record states the tool version, the command, the results, and the fairness", () => {
  const record = read("README.md");
  expect(record).toContain("v1.7.4");
  expect(record).toContain("2.19 of 08 August 2024");
  expect(record).toContain("OpenJDK 21.0.12.1");
  expect(record).toContain("-deadlock");
  for (const config of CONFIGS) {
    expect(record).toContain(config);
  }
  for (const heading of [
    "## 3. Safety and progress",
    "## 4. Tool version, configuration, and bounds",
    "## 5. Results",
    "## 7. Mapping to the implementation",
  ]) {
    expect(record, `missing section ${heading}`).toContain(heading);
  }
  expect(record).toContain("Weak fairness");
  expect(record).toContain("No error");
});

test("the model index records the execution model and the run steps", () => {
  const index = readFileSync(path.join(repoRoot, "models", "README.md"), "utf8");
  expect(index).toContain("Execution.tla");
  expect(index).toContain("tla2tools.jar");
  expect(index).toContain("v1.7.4");
  for (const config of CONFIGS) {
    expect(index).toContain(config);
  }
});

const qualificationDir = path.join(repoRoot, "models", "qualification");

const QUAL_MODULE = "Qualification.tla";
const QUAL_CONFIGS = ["Qualification.cfg"];

/** The transitions the qualification record names. */
const QUAL_TRANSITIONS = [
  "PublishStarter", "Qualify", "RunEvaluation", "RunShadow", "RunEnforcement",
  "RefuseRun", "HostSelect", "HostDeselect", "HostAuthorize", "HostRevoke",
  "ModelDrift",
];

/** The safety invariants the qualification record names. */
const QUAL_INVARIANTS = [
  "TypeOK", "EnforcementAdmissionSound", "RunsDoNotPromote",
  "HostStateHostControlled", "ShadowPassNeverAuthorizes",
  "DriftInvalidatesStaleBindings", "ValidatedProfilesBindLoadedDefinition",
];

const QUAL_CONSTANTS = ["NumProfiles", "MaxRejections"];

/**
 * The qualification statuses with underscores that the module may write.
 * They come from the profile contract in `contracts/README.md`; the
 * module may add no others.
 */
const QUAL_REGISTRY_STATUSES = new Set([
  "insufficient_evidence", "criteria_not_met", "validated_for_scope",
]);

function readQualification(name: string): string {
  return readFileSync(path.join(qualificationDir, name), "utf8");
}

test("the qualification module defines every transition and invariant the record names", () => {
  const moduleText = readQualification(QUAL_MODULE);
  for (const name of [
    ...QUAL_TRANSITIONS,
    ...QUAL_INVARIANTS,
    "Compatible",
    "EnforcementGate",
    "MarkRun",
    "MarkReset",
    "Init",
    "Next",
    "Spec",
    "vars",
  ]) {
    expect(defines(moduleText, name), `${name} is not defined`).toBe(true);
  }
});

test("the qualification next-state relation covers every transition", () => {
  const moduleText = readQualification(QUAL_MODULE);
  const start = moduleText.indexOf("Next ==");
  const end = moduleText.indexOf("(***", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const nextRelation = moduleText.slice(start, end);
  for (const name of QUAL_TRANSITIONS) {
    expect(new RegExp(`\\b${name}\\b`).test(nextRelation), `${name} is outside the next-state relation`).toBe(true);
  }
});

test("the qualification configuration declares the specification, the invariants, and bounded constants", () => {
  const record = readQualification("README.md");
  for (const config of QUAL_CONFIGS) {
    const text = readQualification(config);
    expect(text, config).toContain("SPECIFICATION Spec");
    expect(text, config).not.toContain("PROPERTY");
    for (const invariant of QUAL_INVARIANTS) {
      expect(text, `${config} omits ${invariant}`).toContain(invariant);
    }
    const values: Record<string, number> = {};
    for (const constant of QUAL_CONSTANTS) {
      const match = new RegExp(`^\\s*${constant} = (\\d+)$`, "m").exec(text);
      expect(match, `${config} omits ${constant}`).not.toBeNull();
      values[constant] = Number(match?.[1]);
    }
    expect(values.NumProfiles).toBeGreaterThanOrEqual(1);
    expect(values.NumProfiles).toBeLessThanOrEqual(3);
    expect(values.MaxRejections).toBeGreaterThanOrEqual(1);
    expect(values.MaxRejections).toBeLessThanOrEqual(3);
    // The bounds table in the record states the same numbers.
    const row = record.split("\n").find((line) => line.includes(`(${config})`));
    expect(row, `the record has no bounds row for ${config}`).toBeDefined();
    expect(row).toContain(`| ${values.NumProfiles} | ${values.MaxRejections} |`);
  }
});

test("every qualification status the module writes is a stable registry status", () => {
  const moduleText = readQualification(QUAL_MODULE);
  const written = [...moduleText.matchAll(/"([a-z]+(?:_[a-z]+)+)"/g)].map((match) => match[1] as string);
  const outside = written.filter((code) => !QUAL_REGISTRY_STATUSES.has(code));
  expect(new Set(written).size).toBeGreaterThan(0);
  expect(outside, `statuses outside the registry: ${outside.join(", ")}`).toEqual([]);
  // All four contract statuses appear. "unvalidated" carries no underscore,
  // so the pattern above cannot see it.
  expect(moduleText).toContain('"unvalidated"');
});

test("the qualification record states the tool version, the command, the results, and the controls", () => {
  const record = readQualification("README.md");
  expect(record).toContain("v1.7.4");
  expect(record).toContain("2.19 of 08 August 2024");
  expect(record).toContain("OpenJDK 21.0.12.1");
  expect(record).toContain("-deadlock");
  for (const config of QUAL_CONFIGS) {
    expect(record).toContain(config);
  }
  for (const heading of [
    "## 3. Safety and progress",
    "## 4. Tool version, configuration, and bounds",
    "## 5. Results",
    "## 7. Mapping to the implementation",
  ]) {
    expect(record, `missing section ${heading}`).toContain(heading);
  }
  // The record explains why no progress property and no fairness exist.
  expect(record).toContain("No progress property is checked");
  expect(record).toContain("no fairness assumption");
  expect(record).toContain("No error");
  // The record names the negative controls and the invariants they break.
  expect(record).toContain("Negative controls");
  for (const invariant of QUAL_INVARIANTS.slice(1, 6)) {
    expect(record).toContain(invariant);
  }
});

test("the model index records the qualification model and the run steps", () => {
  const index = readFileSync(path.join(repoRoot, "models", "README.md"), "utf8");
  expect(index).toContain("Qualification.tla");
  for (const config of QUAL_CONFIGS) {
    expect(index).toContain(config);
  }
});
