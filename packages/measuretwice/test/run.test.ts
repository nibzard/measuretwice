// SPDX-License-Identifier: Apache-2.0
/**
 * `load` and exact-rule run path tests.
 *
 * These tests cover the first complete library workflow: load one typed
 * definition or one explicit JSON path, validate one case, and return one
 * exact-rule report. They also cover the wrapper boundaries: injected file
 * access, injected clocks and identifiers, rejection of YAML and TypeScript
 * paths, profile self-hash verification, structural exact compatibility, and
 * the host ownership of storage and actions. They read local files only, so
 * they stay offline and deterministic.
 */
import { test, expect, expectTypeOf } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import {
  load,
  ValidationError,
  type CaseInput,
  type FileAccess,
  type Profile,
  type Reviewer,
  type RunCase,
} from "../src/index.js";
import { defineChecks } from "../src/index.js";
import {
  nativeComputeSelfHash,
  nativeValidateCase,
  nativeValidateDefinition,
} from "../src/native.js";
import { FakeClock, sequenceIds } from "./support/deterministic.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Reads one fixture file as text. */
function fixtureText(relative: string): string {
  return readFileSync(path.join(repoRoot, "fixtures", relative), "utf8");
}

/** Reads one fixture file as a JSON value. */
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

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** The delivery-limits pair of the shared fixtures, authored inline. */
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
    {
      id: "notice-hides-secrets",
      name: "The notice contains no secret marker",
      using: ["notice"],
      rule: { excludes: "SECRET" },
    },
  ],
});

/** A definition with one question check, for the paths that need an evaluator. */
const typedQuestions = defineChecks({
  version: 1,
  name: "typed-delivery-questions",
  inputs: Type.Object(
    {
      notice: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "notice-question",
      name: "The notice is fit to send",
      using: ["notice"],
      question: "Is the notice fit to send?",
      answers: { yes: "The notice is fit.", no: "The notice is not fit." },
    },
  ],
});

/** The shared fixture definition that holds exact rules only. */
const EXACT_RULES_PATH = "definitions/valid/exact-rules.json";

/** The shared fixture path of the ordered-scale definition. */
const ORDERED_SCALE_PATH = "definitions/valid/ordered-scale.json";

/** The shared fixture path of the categorical question definition. */
const CATEGORICAL_QUESTION_PATH = "definitions/valid/categorical-question.json";

/** One case that passes every rule of the delivery-limits definitions. */
const PASSING_INPUT = {
  summary: "The delivery limit is 900 characters",
  notice: "One notice.",
};

// ---------------------------------------------------------------------------
// The vertical slice: typed definition, validated case, exact-rule report.
// ---------------------------------------------------------------------------

test("load runs a typed definition and returns one exact-rule report", async () => {
  const clock = new FakeClock(START_MS);
  const nextRunId = sequenceIds("run");
  const reviewer = await load(typedLimits, { now: () => clock.nowMs(), nextRunId });
  expectTypeOf(reviewer).toEqualTypeOf<Reviewer<{ summary: string; notice: string }>>();

  // The reviewer exposes the validated artifact and its structural profile.
  expect(reviewer.definition).toBe(typedLimits);
  expect(reviewer.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  expect(reviewer.profile?.origin).toBe("exact");
  expect(reviewer.profile?.id).toBe("typed-delivery-limits-exact");
  expect(reviewer.profile?.definition.content_hash).toBe(reviewer.definitionHash);
  expect(reviewer.profile?.content_hash).toMatch(/^[0-9a-f]{64}$/);

  clock.advanceMs(1500);
  const report = await reviewer.run({ id: "case-1", input: PASSING_INPUT });
  expect(report).toMatchObject({
    schema_version: 1,
    run_id: "run-000001",
    mode: "shadow",
    definition: {
      name: "typed-delivery-limits",
      content_hash: reviewer.definitionHash,
    },
    profile: {
      id: "typed-delivery-limits-exact",
      content_hash: reviewer.profile?.content_hash,
    },
    case: { id: "case-1" },
    aggregate: { outcome: "pass" },
    completion: { status: "completed", completed_at: "2026-09-24T00:00:01.500Z" },
  });
  expect(report.checks).toHaveLength(2);
  expect(report.checks[0]).toMatchObject({
    check: "summary-length",
    kind: "rule",
    outcome: "pass",
    applied_rule: { rule: "maxLength", input: "summary", parameters: { maxLength: 80 } },
  });
  expect(report.checks[1]).toMatchObject({
    check: "notice-hides-secrets",
    kind: "rule",
    outcome: "pass",
    applied_rule: { rule: "excludes", input: "notice", parameters: { excludes: "SECRET" } },
  });

  // The case reference hashes the complete input object through the core.
  const caseInfo = nativeValidateCase(
    JSON.stringify(typedLimits),
    JSON.stringify({ id: "case-1", input: PASSING_INPUT }),
  );
  expect(report.case.input_hash).toBe(caseInfo.inputHash);

  // The returned report is immutable JSON data and authorizes nothing.
  expect(Object.isFrozen(report)).toBe(true);
  expect(Object.isFrozen(report.checks)).toBe(true);
  expect(Object.isFrozen(report.checks[0])).toBe(true);
  expect(Object.keys(JSON.parse(JSON.stringify(report)))).not.toContain("authorized");
  expect(JSON.parse(JSON.stringify(report))).toStrictEqual(
    JSON.parse(JSON.stringify(report)),
  );
});

test("a failing input fails its rules and the aggregate keeps every record", async () => {
  const reviewer = await load(typedLimits, {
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const report = await reviewer.run({
    id: "case-2",
    input: { summary: "A".repeat(81), notice: "handle with SECRET care" },
  });
  expect(report.aggregate.outcome).toBe("fail");
  expect(report.checks.map((record) => record.outcome)).toEqual(["fail", "fail"]);
  expect(report.completion).toEqual({
    status: "completed",
    completed_at: "2026-09-24T00:00:00.000Z",
  });
  // A partial failure keeps the passing records beside the failing one.
  const mixed = await reviewer.run({
    id: "case-3",
    input: { summary: "B".repeat(81), notice: "One notice." },
  });
  expect(mixed.aggregate.outcome).toBe("fail");
  expect(mixed.checks.map((record) => record.outcome)).toEqual(["fail", "pass"]);
  expect(mixed.checks[1]?.applied_rule?.parameters).toEqual({ excludes: "SECRET" });
});

test("identical inputs and clocks give identical reports", async () => {
  const first = await load(typedLimits, {
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const second = await load(typedLimits, {
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const caseInput: RunCase<CaseInput<typeof typedLimits>> = {
    id: "same-case",
    input: PASSING_INPUT,
  };
  const firstReport = await first.run(caseInput);
  const secondReport = await second.run(caseInput);
  expect(JSON.stringify(secondReport)).toBe(JSON.stringify(firstReport));

  // The injected identifiers and the clock state the observable differences.
  const again = await first.run(caseInput);
  expect(again.run_id).toBe("run-000002");
  expect(again.completion.completed_at).toBe(firstReport.completion.completed_at);
});

// ---------------------------------------------------------------------------
// Explicit JSON paths and injected file access.
// ---------------------------------------------------------------------------

test("load reads one explicit JSON definition path through injected file access", async () => {
  const files = memoryFiles({ [EXACT_RULES_PATH]: fixtureText(EXACT_RULES_PATH) });
  const reviewer = await load(EXACT_RULES_PATH, {
    files,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  expect(files.reads).toEqual([EXACT_RULES_PATH]);
  expect(reviewer.definition.name).toBe("delivery-limits");
  expect(reviewer.definitionHash).toBe(
    fixtureDocument("hashing/canonical.json").hashes.find(
      (record: { domain: string; value: { name: string } }) =>
        record.domain === "definition" && record.value.name === "delivery-limits",
    )?.content_hash,
  );
  const report = await reviewer.run({ id: "fixture-case", input: PASSING_INPUT });
  expect(report.aggregate.outcome).toBe("pass");
  expect(report.definition.name).toBe("delivery-limits");
  // The run itself reads no file: the wrapper holds the artifact in memory.
  expect(files.reads).toEqual([EXACT_RULES_PATH]);
});

test("load reads one explicit JSON path with the default file access", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "measuretwice-load-"));
  try {
    const definitionPath = path.join(work, "delivery-limits.json");
    writeFileSync(definitionPath, fixtureText(EXACT_RULES_PATH));
    const reviewer = await load(definitionPath, {
      now: () => START_MS,
      nextRunId: sequenceIds("run"),
    });
    const report = await reviewer.run({ id: "disk-case", input: PASSING_INPUT });
    expect(report.aggregate.outcome).toBe("pass");
    expect(report.definition.name).toBe("delivery-limits");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("load rejects YAML and TypeScript paths with unsupported_format", async () => {
  for (const badPath of [
    ".measuretwice/checks/intervention.ts",
    ".measuretwice/checks/intervention.mts",
    "checks/intervention.yaml",
    "checks/intervention.yml",
    "checks/intervention",
  ]) {
    const failure = await failureOf(() => load(badPath, { now: () => START_MS }));
    expect(failure.code, badPath).toBe("unsupported_format");
    expect(failure.fieldPath, badPath).toBe("/definition");
    expect(failure.message, badPath).not.toBe("");
  }
  // A profile path follows the same rule.
  const profileFailure = await failureOf(() =>
    load(typedLimits, {
      profile: ".measuretwice/profiles/intervention.yml",
      now: () => START_MS,
    }),
  );
  expect(profileFailure.code).toBe("unsupported_format");
  expect(profileFailure.fieldPath).toBe("/profile");
});

test("a definition path with malformed JSON fails through the core gate", async () => {
  const files = memoryFiles({ "broken.json": "{\"schema_version\": " });
  const failure = await failureOf(() => load("broken.json", { files, now: () => START_MS }));
  expect(failure.code).toBe("invalid_json");
  const contractFailure = await failureOf(() =>
    load("contract.json", {
      files: memoryFiles({
        "contract.json": JSON.stringify({
          schema_version: 1,
          name: "empty-checks",
          inputs: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          checks: [],
        }),
      }),
      now: () => START_MS,
    }),
  );
  expect(contractFailure.code).toBe("empty_check_set");
});

// ---------------------------------------------------------------------------
// Supplied profiles: self-hash verification and structural compatibility.
// ---------------------------------------------------------------------------

/** The exact profile fixture of the shared states. */
const EXACT_PROFILE = fixtureDocument("profiles/states.json").profiles.find(
  (profile: { id: string }) => profile.id === "delivery-limits-exact",
) as Record<string, unknown>;

/** The exploration profile fixture of the shared states. */
const EXPLORATION_PROFILE = fixtureDocument("profiles/states.json").profiles.find(
  (profile: { id: string }) => profile.id === "message-supported-exploration",
) as Record<string, unknown>;

const PROFILE_PATH = "profiles/delivery-limits-exact.json";

test("load binds a supplied exact profile and verifies its self hash", async () => {
  const files = memoryFiles({
    [EXACT_RULES_PATH]: fixtureText(EXACT_RULES_PATH),
    [PROFILE_PATH]: JSON.stringify(EXACT_PROFILE),
  });
  const reviewer = await load(EXACT_RULES_PATH, {
    profile: PROFILE_PATH,
    files,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  expect(files.reads).toEqual([EXACT_RULES_PATH, PROFILE_PATH]);
  expect(reviewer.profile?.id).toBe("delivery-limits-exact");
  expect(reviewer.profile?.content_hash).toBe(EXACT_PROFILE.content_hash);
  const report = await reviewer.run({ id: "profiled-case", input: PASSING_INPUT });
  expect(report.profile).toEqual({
    id: "delivery-limits-exact",
    content_hash: EXACT_PROFILE.content_hash,
  });
  expect(report.aggregate.outcome).toBe("pass");

  // An edited profile no longer matches its stored hash.
  const edited = { ...EXACT_PROFILE, intended_use: "Changed after signing." };
  const editFailure = await failureOf(() =>
    load(EXACT_RULES_PATH, {
      profile: PROFILE_PATH,
      files: memoryFiles({
        [EXACT_RULES_PATH]: fixtureText(EXACT_RULES_PATH),
        [PROFILE_PATH]: JSON.stringify(edited),
      }),
      now: () => START_MS,
    }),
  );
  expect(editFailure.code).toBe("hash_mismatch");
});

test("profile compatibility follows the fixture expectations", async () => {
  // An exact profile against another definition fails on the definition.
  const wrongDefinition = await failureOf(() =>
    load(ORDERED_SCALE_PATH, {
      profile: PROFILE_PATH,
      files: memoryFiles({
        [ORDERED_SCALE_PATH]: fixtureText(ORDERED_SCALE_PATH),
        [PROFILE_PATH]: JSON.stringify(EXACT_PROFILE),
      }),
      now: () => START_MS,
    }),
  );
  expect(wrongDefinition.code).toBe("definition_mismatch");
  expect(wrongDefinition.fieldPath).toBe("/profile/definition");

  // A probability-mass policy cannot fit an exact-only definition.
  const wrongPolicy = await failureOf(() =>
    load(EXACT_RULES_PATH, {
      profile: "profiles/message-supported-exploration.json",
      files: memoryFiles({
        [EXACT_RULES_PATH]: fixtureText(EXACT_RULES_PATH),
        "profiles/message-supported-exploration.json": JSON.stringify(EXPLORATION_PROFILE),
      }),
      now: () => START_MS,
    }),
  );
  expect(wrongPolicy.code).toBe("policy_mismatch");

  // A profile that binds question checks names evaluators that exist nowhere
  // yet, so load rejects the unknown evaluator reference.
  const typedQuestionsHash = nativeValidateDefinition(
    JSON.stringify(typedQuestions),
  ).definitionHash;
  const boundProfile: Record<string, unknown> = {
    ...EXPLORATION_PROFILE,
    id: "typed-delivery-questions-exploration",
    definition: { name: "typed-delivery-questions", content_hash: typedQuestionsHash },
  };
  boundProfile["content_hash"] = nativeComputeSelfHash(
    "profile",
    JSON.stringify(boundProfile),
  );
  const unknownEvaluator = await failureOf(() =>
    load(typedQuestions, {
      profile: "profiles/questions-exploration.json",
      files: memoryFiles({
        "profiles/questions-exploration.json": JSON.stringify(boundProfile),
      }),
      now: () => START_MS,
    }),
  );
  expect(unknownEvaluator.code).toBe("evaluator_mismatch");
  expect(unknownEvaluator.fieldPath).toBe("/profile/bindings/0/evaluator");
});

// ---------------------------------------------------------------------------
// Question checks, invalid cases, and enforcement mode.
// ---------------------------------------------------------------------------

test("load validates one supplied profile through the core contract", async () => {
  // One exploration profile that claims one qualification: the artifact
  // breaks the cross-field origin rule, and the core names the field.
  const claiming: Record<string, unknown> = {
    ...EXPLORATION_PROFILE,
    qualification: { status: "validated_for_scope", scope: "Development use.", reasons: ["starter_policy"] },
  };
  claiming["content_hash"] = nativeComputeSelfHash("profile", JSON.stringify(claiming));
  const claimingPath = "profiles/claiming.json";
  const claimingFailure = await failureOf(() =>
    load(CATEGORICAL_QUESTION_PATH, {
      profile: claimingPath,
      files: memoryFiles({
        "definitions/valid/categorical-question.json": fixtureText(CATEGORICAL_QUESTION_PATH),
        [claimingPath]: JSON.stringify(claiming),
      }),
      now: () => START_MS,
    }),
  );
  expect(claimingFailure.code).toBe("invalid_field_type");
  // The artifact rules point into the artifact itself; the compatibility
  // rules point into the pairing under /profile.
  expect(claimingFailure.fieldPath).toBe("/qualification/status");

  // One profile whose stored self-hash covers other content fails before
  // any compatibility question, exactly as before.
  const edited = { ...EXPLORATION_PROFILE, intended_use: "Enforcement use." };
  const editedPath = "profiles/edited.json";
  const editedFailure = await failureOf(() =>
    load(CATEGORICAL_QUESTION_PATH, {
      profile: editedPath,
      files: memoryFiles({
        "definitions/valid/categorical-question.json": fixtureText(CATEGORICAL_QUESTION_PATH),
        [editedPath]: JSON.stringify(edited),
      }),
      now: () => START_MS,
    }),
  );
  expect(editedFailure.code).toBe("hash_mismatch");
  expect(editedFailure.fieldPath).toBe("/content_hash");

  // One profile that binds no evaluator for one question check of the
  // definition is one incompatible pairing, not one invalid artifact.
  const unbound: Record<string, unknown> = {
    ...EXPLORATION_PROFILE,
    id: "message-supported-unbound",
    bindings: [],
  };
  unbound["content_hash"] = nativeComputeSelfHash("profile", JSON.stringify(unbound));
  const unboundPath = "profiles/unbound.json";
  const unboundFailure = await failureOf(() =>
    load(CATEGORICAL_QUESTION_PATH, {
      profile: unboundPath,
      files: memoryFiles({
        "definitions/valid/categorical-question.json": fixtureText(CATEGORICAL_QUESTION_PATH),
        [unboundPath]: JSON.stringify(unbound),
      }),
      now: () => START_MS,
    }),
  );
  expect(unboundFailure.code).toBe("evaluator_mismatch");
  expect(unboundFailure.fieldPath).toBe("/profile/bindings");
});

test("run rejects one question check without one bound profile before any work starts", async () => {
  const reviewer = await load(typedQuestions, {
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const failure = await failureOf(() =>
    reviewer.run({ id: "question-case", input: { notice: "One notice." } }),
  );
  expect(failure.code).toBe("evaluator_mismatch");
  expect(failure.fieldPath).toBe("/profile");
  expect(failure.message).toContain("notice-question");
  expect(failure.message).toContain("profile");
});

test("run validates the case through the core before execution", async () => {
  const reviewer = await load(typedLimits, {
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const missing = await failureOf(() =>
    reviewer.run({
      id: "case-9",
      input: { summary: "Only one input." } as { summary: string; notice: string },
    }),
  );
  expect(missing.code).toBe("missing_field");
  expect(missing.fieldPath).toBe("/input/notice");

  const extra = await failureOf(() =>
    reviewer.run({
      id: "case-9",
      input: { ...PASSING_INPUT, label: "expected pass" },
    } as unknown as { id: string; input: { summary: string; notice: string } }),
  );
  expect(extra.code).toBe("unknown_field");
  expect(extra.fieldPath).toBe("/input/label");

  const envelope = await failureOf(() =>
    reviewer.run({ input: PASSING_INPUT } as unknown as {
      id: string;
      input: { summary: string; notice: string };
    }),
  );
  expect(envelope.code).toBe("missing_field");
  expect(envelope.fieldPath).toBe("/id");

  // One field outside the case envelope stays outside the input object.
  const outside = await failureOf(() =>
    reviewer.run({
      id: "case-9",
      input: PASSING_INPUT,
      label: "expected pass",
    } as unknown as { id: string; input: { summary: string; notice: string } }),
  );
  expect(outside.code).toBe("unknown_field");
  expect(outside.fieldPath).toBe("/label");
});

test("enforcement mode needs one validated profile", async () => {
  // The structural exact profile carries the structural basis, so an
  // enforcement run reports its mode when the host selects its hash.
  const reviewer = await load(typedLimits, {
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  const synthesized = reviewer.profile;
  expect(synthesized?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  const report = await reviewer.run(
    { id: "enforced-case", input: PASSING_INPUT },
    {
      mode: "enforcement",
      ...(synthesized !== undefined ? { selectedProfileHash: synthesized.content_hash } : {}),
    },
  );
  expect(report.mode).toBe("enforcement");
  expect(report.aggregate.outcome).toBe("pass");

  // An unvalidated profile cannot enter enforcement, and the qualification
  // clause refuses before the selection clause runs.
  const unvalidatedArtifact: Record<string, unknown> = {
    ...EXACT_PROFILE,
    definition: { name: "typed-delivery-limits", content_hash: reviewer.definitionHash },
    qualification: {
      status: "unvalidated",
      scope: "Development use.",
      reasons: ["starter_policy"],
    },
  };
  unvalidatedArtifact["content_hash"] = nativeComputeSelfHash(
    "profile",
    JSON.stringify(unvalidatedArtifact),
  );
  const unvalidated: Profile = unvalidatedArtifact as unknown as Profile;
  const unvalidatedPath = "profiles/unvalidated-exact.json";
  const unvalidatedReviewer = await load(typedLimits, {
    profile: unvalidatedPath,
    files: memoryFiles({ [unvalidatedPath]: JSON.stringify(unvalidated) }),
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  expect(unvalidatedReviewer.profile?.id).toBe("delivery-limits-exact");
  const failure = await failureOf(() =>
    unvalidatedReviewer.run(
      { id: "enforced-case", input: PASSING_INPUT },
      {
        mode: "enforcement",
        ...(unvalidatedReviewer.profile !== undefined
          ? { selectedProfileHash: unvalidatedReviewer.profile.content_hash }
          : {}),
      },
    ),
  );
  expect(failure.code).toBe("qualification_insufficient");
  // The same reviewer still runs in shadow mode, which states no gate.
  const shadow = await unvalidatedReviewer.run({ id: "shadow-case", input: PASSING_INPUT });
  expect(shadow.mode).toBe("shadow");
});

// ---------------------------------------------------------------------------
// Host ownership: storage, credentials, and actions stay outside.
// ---------------------------------------------------------------------------

test("load and run hold no credentials and take no application action", async () => {
  const files = memoryFiles({ [EXACT_RULES_PATH]: fixtureText(EXACT_RULES_PATH) });
  const reviewer = await load(EXACT_RULES_PATH, {
    files,
    now: () => START_MS,
    nextRunId: sequenceIds("run"),
  });
  files.reads.length = 0;
  const report = await reviewer.run({ id: "quiet-case", input: PASSING_INPUT });
  // A run reads no file, writes no file, and names no credential field.
  expect(files.reads).toEqual([]);
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain("credential");
  expect(serialized).not.toContain("token");
  expect(serialized).not.toContain("approve");
});
