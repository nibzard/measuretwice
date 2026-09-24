// SPDX-License-Identifier: Apache-2.0
/**
 * Exploration profile generation tests.
 *
 * These tests cover `createExplorationProfile`: the starter artifact that a
 * developer generates before any qualification evidence exists. The tests
 * prove the recorded content (definition reference, evaluator bindings,
 * translated questions, starter parameters, effective execution
 * configuration, and the unvalidated qualification with its reason), the
 * determinism of generation, the shadow admission and the enforcement
 * refusal through the public `load` and `run` boundary, the absence of any
 * provider call, and the rejections that name their codes and paths. They
 * read local files only, so they stay offline and deterministic.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import {
  createExplorationProfile,
  createJevEvaluator,
  createLabelOnlyEvaluator,
  defineChecks,
  load,
  registerEvaluators,
  translateJevQuestion,
  ValidationError,
  type Definition,
  type Evaluator,
  type FileAccess,
} from "../src/index.js";
import {
  nativeCanonicalForm,
  nativeContentHash,
  nativeValidateDefinition,
  nativeValidateProfile,
  nativeVerifySelfHash,
} from "../src/native.js";
import { validatedQuestion } from "../src/evaluator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Reads one fixture file as text. */
function fixtureText(relative: string): string {
  return readFileSync(path.join(repoRoot, "fixtures", relative), "utf8");
}

/** Reads one fixture file as one definition artifact. */
function fixtureDefinition(relative: string): Definition {
  return JSON.parse(fixtureText(relative)) as Definition;
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

/** The shared fixture path of the categorical question definition. */
const CATEGORICAL_PATH = "definitions/valid/categorical-question.json";

/** The shared fixture path of the binary question definition. */
const BINARY_PATH = "definitions/valid/binary-question.json";

/** The shared fixture path of the exact-rule definition. */
const EXACT_RULES_PATH = "definitions/valid/exact-rules.json";

/** One typed definition with one question check and one exact rule. */
const mixed = defineChecks({
  version: 1,
  name: "typed-exploration-mixed",
  inputs: Type.Object(
    {
      notice: Type.String({ minLength: 1 }),
      summary: Type.String({ minLength: 1 }),
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
      accept: "yes",
    },
    {
      id: "summary-length",
      name: "The summary fits the delivery limit",
      using: ["summary"],
      rule: { maxLength: 80 },
    },
  ],
});

/** The validated question of one check of one artifact, for expected translations. */
function questionOf(definition: Definition, checkId: string) {
  const info = nativeValidateDefinition(JSON.stringify(definition));
  const entry = info.checkKinds.find((named) => named.id === checkId)!;
  const check = definition.checks.find((named) => named.id === checkId)!;
  return validatedQuestion(entry.kind, check);
}

/** Builds the canonical text of one JSON value through the core. */
function canonicalText(value: unknown): string {
  return nativeCanonicalForm(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// The starter artifact.
// ---------------------------------------------------------------------------

test("one starter profile records the binding, the starter policy, and no qualification", () => {
  const definition = fixtureDefinition(CATEGORICAL_PATH);
  const registry = registerEvaluators(
    createLabelOnlyEvaluator({ answers: { "message-supported": "supported" } }),
  );
  const profile = createExplorationProfile(definition, registry);

  // The artifact identity and the definition reference.
  expect(profile.schema_version).toBe(1);
  expect(profile.id).toBe("message-supported-exploration");
  expect(profile.origin).toBe("exploration");
  expect(profile.intended_use).toContain("message-supported");
  expect(profile.intended_use).toContain("no qualification evidence");
  expect(profile.definition).toEqual({
    name: "message-supported",
    content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });

  // One binding per question check, from the registry.
  expect(profile.bindings).toHaveLength(1);
  const binding = profile.bindings[0]!;
  expect(binding.check).toBe("message-supported");
  expect(binding.evaluator).toBe("label-only-test");
  expect(binding.adapter_version).toBe("0.1.0");
  expect(binding.model).toBeUndefined();
  expect(binding.preprocessing).toBeUndefined();

  // The adapter translates nothing, so the record states the validated
  // question that the adapter receives, and the hash covers that text.
  const question = questionOf(definition, "message-supported");
  expect(binding.translation.question).toBe(
    canonicalText(question),
  );
  expect(binding.translation.content_hash).toBe(
    nativeContentHash("translation", binding.translation.question),
  );

  // The starter policy and the effective execution configuration.
  expect(profile.policy.family).toBe("probability_mass_v0");
  expect(profile.policy.checks).toEqual([
    { check: "message-supported", accept_cutoff: 0.8, rejection_cutoff: 0.6 },
  ]);
  expect(profile.execution).toEqual({
    max_active: 4,
    max_pending: 16,
    deadline_ms: 30000,
    max_attempts: 2,
    backoff_ms: 200,
  });

  // The qualification stays unvalidated with the starter reason.
  expect(profile.qualification.status).toBe("unvalidated");
  expect(profile.qualification.reasons).toEqual(["starter_policy"]);
  expect(profile.qualification.scope).toContain("Evaluation and shadow use");

  // The core accepts the assembled artifact, self-hash included.
  const info = nativeValidateProfile(JSON.stringify(profile));
  expect(info.id).toBe(profile.id);
  expect(info.origin).toBe("exploration");
  expect(info.qualificationStatus).toBe("unvalidated");
  expect(info.contentHash).toBe(profile.content_hash);
  nativeVerifySelfHash("profile", JSON.stringify(profile));

  // The returned value is frozen.
  expect(Object.isFrozen(profile)).toBe(true);
  expect(() => {
    (profile as { mutable?: string }).mutable = "no";
  }).toThrow();
});

test("the jev adapter contributes its translated question and generation calls no provider", () => {
  const definition = fixtureDefinition(CATEGORICAL_PATH);
  let calls = 0;
  const jev = createJevEvaluator({
    async call() {
      calls += 1;
      throw new Error("generation must call no provider");
    },
  });
  const registry = registerEvaluators(jev);
  const profile = createExplorationProfile(definition, registry, {
    bindings: {
      "message-supported": { evaluator: "jev", model: "jev-1.13.0", preprocessing: "plain-v1" },
    },
  });

  expect(calls).toBe(0);
  const binding = profile.bindings[0]!;
  expect(binding.evaluator).toBe("jev");
  const translation = translateJevQuestion(questionOf(definition, "message-supported"));
  expect(binding.translation.content_hash).toBe(translation.content_hash);
  expect(binding.translation.question).toBe(canonicalText(translation.question));
  // The binding records the requested alias alone: generation measures
  // nothing, so no resolution exists to record.
  expect(binding.model).toEqual({ requested: "jev-1.13.0" });
  expect(binding.preprocessing).toBe("plain-v1");
  nativeVerifySelfHash("profile", JSON.stringify(profile));
});

test("one mixed definition binds and decides its question checks only", () => {
  const registry = registerEvaluators(
    createLabelOnlyEvaluator({ answers: { "notice-question": true } }),
  );
  const profile = createExplorationProfile(mixed, registry);

  const bound = profile.bindings.map((binding) => binding.check);
  const decided = (profile.policy.checks ?? []).map((entry) => entry.check);
  expect(bound).toEqual(["notice-question"]);
  expect(decided).toEqual(["notice-question"]);
  // The exact rule check records its executed rule and takes no evaluator
  // and no policy entry, exactly as the profile contract states.
  expect(profile.bindings.some((binding) => binding.check === "summary-length")).toBe(false);
  expect(decided.includes("summary-length")).toBe(false);
});

// ---------------------------------------------------------------------------
// Determinism and the absence of qualification drift.
// ---------------------------------------------------------------------------

test("generation is deterministic", () => {
  const definition = fixtureDefinition(CATEGORICAL_PATH);
  const registry = registerEvaluators(
    createLabelOnlyEvaluator({ answers: { "message-supported": "supported" } }),
  );
  const first = createExplorationProfile(definition, registry);
  const second = createExplorationProfile(definition, registry);
  expect(second).toEqual(first);
  expect(second.content_hash).toBe(first.content_hash);
});

test("using the profile changes nothing about its qualification", async () => {
  const definition = fixtureDefinition(CATEGORICAL_PATH);
  const registry = registerEvaluators(
    createLabelOnlyEvaluator({ answers: { "message-supported": "supported" } }),
  );
  const profile = createExplorationProfile(definition, registry);
  const stored = JSON.stringify(profile);

  // The stored artifact loads in shadow mode.
  const files = memoryFiles({ "/profile.json": stored });
  const reviewer = await load(definition, { profile: "/profile.json", evaluators: registry, files });
  expect(reviewer.profile?.content_hash).toBe(profile.content_hash);

  // Shadow use is admitted: the run fails on the pending semantic run path,
  // never on the profile or its qualification.
  const caseInput = {
    id: "case-1",
    input: {
      prior_decision: "Customer exports stay in the EU.",
      conversation: "The team proposes one export worker in the US region.",
      proposed_message: "The export worker moves to the US region.",
    },
  };
  const shadowFailure = await failureOf(() => reviewer.run(caseInput, { mode: "shadow" }));
  expect(shadowFailure.code).toBe("evaluator_mismatch");
  expect(shadowFailure.message).toContain("semantic run path");
  expect(shadowFailure.message).not.toContain("qualification");

  // Enforcement is refused on the qualification clause, before any case
  // work: even one invalid case cannot reach validation first.
  const enforcementFailure = await failureOf(() =>
    reviewer.run({ id: "case-2", input: {} }, { mode: "enforcement" }),
  );
  expect(enforcementFailure.code).toBe("qualification_insufficient");
  expect(enforcementFailure.fieldPath).toBe("/profile/qualification/status");
  expect(enforcementFailure.message).toContain("unvalidated");

  // After both uses, the stored artifact is unchanged: the self-hash still
  // verifies, the qualification stays unvalidated, and one fresh generation
  // from the same inputs produces the same artifact.
  nativeVerifySelfHash("profile", stored);
  const reread = nativeValidateProfile(stored);
  expect(reread.qualificationStatus).toBe("unvalidated");
  expect(reread.contentHash).toBe(profile.content_hash);
  const regenerated = createExplorationProfile(
    definition,
    registerEvaluators(
      createLabelOnlyEvaluator({ answers: { "message-supported": "supported" } }),
    ),
  );
  expect(regenerated.content_hash).toBe(profile.content_hash);
  expect(JSON.stringify(regenerated)).toBe(stored);
});

// ---------------------------------------------------------------------------
// Options.
// ---------------------------------------------------------------------------

test("options override the identifier, the use, the starter parameters, and the execution", () => {
  const definition = fixtureDefinition(CATEGORICAL_PATH);
  const registry = registerEvaluators(
    createLabelOnlyEvaluator({ answers: { "message-supported": "supported" } }),
  );
  const profile = createExplorationProfile(definition, registry, {
    id: "custom-exploration",
    intendedUse: "One declared development population.",
    starter: { accept_cutoff: 0.9, rejection_cutoff: 0.55 },
    execution: { deadline_ms: 5000, max_attempts: 3 },
  });
  expect(profile.id).toBe("custom-exploration");
  expect(profile.intended_use).toBe("One declared development population.");
  expect(profile.policy.checks).toEqual([
    { check: "message-supported", accept_cutoff: 0.9, rejection_cutoff: 0.55 },
  ]);
  expect(profile.execution).toEqual({
    max_active: 4,
    max_pending: 16,
    deadline_ms: 5000,
    max_attempts: 3,
    backoff_ms: 200,
  });

  // One per-check starter entry overrides the global starter for that check.
  const binary = fixtureDefinition(BINARY_PATH);
  const binaryProfile = createExplorationProfile(binary, registry, {
    starter: { accept_cutoff: 0.9, rejection_cutoff: 0.7 },
    starterChecks: { "adds-information": { accept_cutoff: 0.75, rejection_cutoff: 0.6 } },
  });
  expect(binaryProfile.policy.checks).toEqual([
    { check: "adds-information", accept_cutoff: 0.75, rejection_cutoff: 0.6 },
  ]);
});

// ---------------------------------------------------------------------------
// Rejections.
// ---------------------------------------------------------------------------

test("rejections name their codes and paths", async () => {
  const definition = fixtureDefinition(CATEGORICAL_PATH);
  const exactOnly = fixtureDefinition(EXACT_RULES_PATH);
  const labelOnly = registerEvaluators(
    createLabelOnlyEvaluator({ answers: { "message-supported": "supported" } }),
  );
  const twoEvaluators = registerEvaluators(
    createLabelOnlyEvaluator({ answers: { "message-supported": "supported" } }),
    createLabelOnlyEvaluator({ id: "second-test", answers: { "message-supported": "contradicted" } }),
  );
  const silentTranslate: Evaluator = {
    id: "silent-translate",
    adapter_version: "0.1.0",
    translate: () => ({ content_hash: "a".repeat(64) }),
    async assess() {
      throw new Error("no execution in this test");
    },
  };
  const lyingTranslate: Evaluator = {
    id: "lying-translate",
    adapter_version: "0.1.0",
    translate: (question) => ({
      content_hash: "b".repeat(64),
      question: { reframed: question.question },
    }),
    async assess() {
      throw new Error("no execution in this test");
    },
  };

  const rows: readonly (readonly [string, () => unknown, string, string])[] = [
    [
      "one exact-only definition",
      () => createExplorationProfile(exactOnly, labelOnly),
      "invalid_field_type",
      "/checks",
    ],
    [
      "one registry without one unambiguous evaluator",
      () => createExplorationProfile(definition, twoEvaluators),
      "evaluator_mismatch",
      "/bindings",
    ],
    [
      "one binding that names no registered evaluator",
      () =>
        createExplorationProfile(definition, labelOnly, {
          bindings: { "message-supported": "jev-choice" },
        }),
      "evaluator_mismatch",
      "/bindings/message-supported/evaluator",
    ],
    [
      "one binding that names no question check",
      () =>
        createExplorationProfile(mixed, labelOnly, {
          bindings: {
            "notice-question": "label-only-test",
            "summary-length": "label-only-test",
          },
        }),
      "evaluator_mismatch",
      "/bindings/summary-length",
    ],
    [
      "one stated map that misses one question check",
      () => createExplorationProfile(mixed, labelOnly, { bindings: {} }),
      "evaluator_mismatch",
      "/bindings/notice-question",
    ],
    [
      "one binding that states no evaluator identifier",
      () =>
        createExplorationProfile(definition, labelOnly, {
          bindings: { "message-supported": { evaluator: "" } },
        }),
      "invalid_field_type",
      "/bindings/message-supported/evaluator",
    ],
    [
      "one starter cutoff at one half",
      () =>
        createExplorationProfile(definition, labelOnly, {
          starter: { accept_cutoff: 0.5, rejection_cutoff: 0.6 },
        }),
      "invalid_field_type",
      "/policy/checks/0/accept_cutoff",
    ],
    [
      "one confidence floor on one binary check",
      () =>
        createExplorationProfile(fixtureDefinition(BINARY_PATH), labelOnly, {
          starter: { accept_cutoff: 0.8, rejection_cutoff: 0.6, confidence_floor: 0.7 },
        }),
      "policy_mismatch",
      "/profile/policy/checks/0/confidence_floor",
    ],
    [
      "one execution override outside its bounds",
      () =>
        createExplorationProfile(definition, labelOnly, {
          execution: { max_attempts: 11 },
        }),
      "invalid_field_type",
      "/execution/max_attempts",
    ],
    [
      "one identifier outside the artifact rule",
      () =>
        createExplorationProfile(definition, labelOnly, { id: "Not An Identifier" }),
      "invalid_field_type",
      "/id",
    ],
    [
      "one intended use beyond its bound",
      () =>
        createExplorationProfile(definition, labelOnly, { intendedUse: "x".repeat(2001) }),
      "invalid_field_type",
      "/intended_use",
    ],
    [
      "one adapter that translates but states no question",
      () =>
        createExplorationProfile(definition, registerEvaluators(silentTranslate), {
          bindings: { "message-supported": "silent-translate" },
        }),
      "invalid_field_type",
      "/bindings/message-supported/translation/question",
    ],
    [
      "one adapter whose stated hash covers another question",
      () =>
        createExplorationProfile(definition, registerEvaluators(lyingTranslate), {
          bindings: { "message-supported": "lying-translate" },
        }),
      "translation_mismatch",
      "/bindings/message-supported/translation/content_hash",
    ],
  ];
  for (const [note, operation, code, fieldPath] of rows) {
    const failure = await failureOf(operation);
    expect(failure.code, note).toBe(code);
    expect(failure.fieldPath, note).toBe(fieldPath);
    expect(failure.message.length, note).toBeGreaterThan(0);
  }
});
