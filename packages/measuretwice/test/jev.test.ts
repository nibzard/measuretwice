// SPDX-License-Identifier: Apache-2.0
/**
 * Jev translation tests.
 *
 * These tests cover task T025: the versioned translation of one question
 * check into one Jev question. Every case of
 * `fixtures/translations/jev.json` runs through the public translation and
 * the dispatch contract. The dispatched request supplies the validated
 * question and the projected inputs of the core, the translation returns
 * the complete wire question of the pinned SDK shape, and the Rust core
 * computes the canonical text and the translation-domain digest. The
 * evidence state carries exactly the projected inputs under one fixed
 * `evidence` key, so one label, one label explanation, one baseline
 * decision, and the case identifier never reach the provider. One changed
 * translated question changes the digest and the profile binding that
 * records it, while the definition stays unchanged: `load` compares the
 * recorded translation against the live one of one translating adapter
 * and refuses one changed binding with `translation_mismatch`. Every test
 * stays offline: no SDK import, no credential, no network access.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JEV_TRANSLATION_VERSION,
  jevEvidenceState,
  load,
  registerEvaluators,
  translateJevQuestion,
  ValidationError,
  type Assessment,
  type Evaluator,
  type EvaluatorRequest,
  type JSONValue,
  type ValidatedQuestion,
} from "../src/index.js";
import { dispatchAssessment } from "../src/evaluator.js";
import {
  nativeCanonicalForm,
  nativeComputeSelfHash,
  nativeContentHash,
  nativeValidateCase,
  nativeValidateDefinition,
} from "../src/native.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The Jev translation fixture, the one source of truth for this suite. */
const doc = JSON.parse(
  readFileSync(path.join(repoRoot, "fixtures", "translations", "jev.json"), "utf8"),
) as {
  translation_version: string;
  cases: {
    note: string;
    definition: string;
    check: string;
    kind: ValidatedQuestion["kind"];
    primitive: string;
    question: Record<string, unknown>;
    canonical: string;
    content_hash: string;
    case_input: Record<string, string>;
    using: string[];
    expected_state: { evidence: Record<string, JSONValue> };
  }[];
  identity: {
    note: string;
    base: string;
    check: string;
    changed_element: string;
    origin: "check" | "translation";
    variant_question?: ValidatedQuestion;
    question: Record<string, unknown>;
    canonical: string;
    content_hash: string;
  }[];
  state_rejections: {
    note: string;
    using: string[];
    inputs: Record<string, JSONValue>;
    expected: { reason_code: string; field_path: string };
  }[];
};

/** The synthetic provider fixtures of the pinned SDK, for the wire shapes. */
const providerCases = JSON.parse(
  readFileSync(path.join(repoRoot, "providers", "jev", "fixtures", "responses.json"), "utf8"),
) as { cases: { request: { questions: Record<string, Record<string, unknown>> } }[] };

/** The fixed start time of every test run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** The budget of every dispatched request in this suite. */
const BUDGET = { attempt: 1, max_attempts: 2, deadline_at_ms: START_MS + 30000 };

/** The case identifier of every dispatched case. It never enters one request. */
const CASE_ID = "translation-case-1";

/** Runs one operation and returns the public failure it must throw. */
function failureOf(operation: () => unknown): ValidationError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("the operation was accepted");
}

/** Awaits one operation and returns the public failure it must reject with. */
async function asyncFailureOf(operation: () => Promise<unknown>): Promise<ValidationError> {
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

/** Builds one minimal valid assessment of one question kind. */
function answerOf(question: ValidatedQuestion): Assessment {
  if (question.kind === "binary") {
    return { kind: "binary", value: true };
  }
  if (question.kind === "ordered") {
    return { kind: "ordered", level: question.scale[0]!.name };
  }
  return { kind: "categorical", label: Object.keys(question.answers)[0]! };
}

/** Dispatches one fixture case and returns the request the evaluator saw. */
async function dispatchedRequest(record: (typeof doc.cases)[number]): Promise<EvaluatorRequest> {
  const definitionText = readFileSync(
    path.join(repoRoot, "fixtures", "definitions", "valid", record.definition),
    "utf8",
  );
  const artifact = JSON.parse(definitionText) as Parameters<typeof dispatchAssessment>[0]["artifact"];
  const info = nativeValidateDefinition(definitionText);
  const caseInfo = nativeValidateCase(
    definitionText,
    JSON.stringify({ id: CASE_ID, input: record.case_input }),
  );
  const projected = caseInfo.projectedInputs.find((entry) => entry.checkId === record.check)
    ?.inputs as Readonly<Record<string, JSONValue>>;
  let seen: EvaluatorRequest | undefined;
  const evaluator: Evaluator = {
    id: "capture-test",
    adapter_version: "0.1.0",
    async assess(request: EvaluatorRequest) {
      seen = request;
      return { assessment: answerOf(request.question) };
    },
  };
  await dispatchAssessment({
    artifact,
    checkKinds: info.checkKinds,
    checkId: record.check,
    projectedInputs: projected,
    evaluator,
    budget: BUDGET,
    signal: new AbortController().signal,
  });
  if (seen === undefined) {
    throw new Error("the evaluator saw no request");
  }
  return seen;
}

// ---------------------------------------------------------------------------
// The translated questions of the fixture cases.
// ---------------------------------------------------------------------------

test("the package ships the translation version of the fixture group", () => {
  expect(JEV_TRANSLATION_VERSION).toBe(doc.translation_version);
});

test("every fixture case translates through the dispatched request with the pinned digest", async () => {
  for (const record of doc.cases) {
    const request = await dispatchedRequest(record);
    // The dispatched request carries the projected inputs of using and no
    // other field of the case. The case identifier stays outside.
    expect([...Object.keys(request.inputs)].sort(), record.note).toEqual([...record.using].sort());
    expect(Object.keys(request.inputs), record.note).not.toContain("id");

    const translation = translateJevQuestion(request.question);
    expect(translation.translation_version, record.note).toBe(JEV_TRANSLATION_VERSION);
    expect(translation.primitive, record.note).toBe(record.primitive);
    expect(translation.question, record.note).toEqual(record.question);
    // The digest is the translation-domain hash of the complete question,
    // computed by the Rust core and never by this package.
    expect(translation.content_hash, record.note).toBe(record.content_hash);
    expect(translation.content_hash, record.note).toBe(
      nativeContentHash("translation", JSON.stringify(record.question)),
    );
    expect(nativeCanonicalForm(JSON.stringify(translation.question)), record.note).toBe(record.canonical);
    // The record is frozen: one caller cannot edit the translated question.
    expect(Object.isFrozen(translation)).toBe(true);
    expect(Object.isFrozen(translation.question)).toBe(true);
    expect(() => {
      (translation.question as { type?: string }).type = "noul";
    }).toThrow();
  }
}, 20000);

test("the evidence state frames exactly the projected inputs and nothing else", async () => {
  for (const record of doc.cases) {
    const request = await dispatchedRequest(record);
    const state = jevEvidenceState(request.using, request.inputs);
    expect(state, record.note).toEqual(record.expected_state);
    expect(Object.keys(state), record.note).toEqual(["evidence"]);
    expect(Object.isFrozen(state)).toBe(true);
    // The serialized state carries no case identifier and no field outside
    // the using list.
    const text = JSON.stringify(state);
    expect(text, record.note).not.toContain(CASE_ID);
    for (const key of Object.keys(record.case_input)) {
      expect(record.using.includes(key), `${record.note}: ${key} is unauthorized`).toBe(true);
    }
  }
}, 20000);

// ---------------------------------------------------------------------------
// Identity: one changed translated question changes the binding.
// ---------------------------------------------------------------------------

test("every identity variant changes the translation digest of its base case", () => {
  const baseHash = new Map(doc.cases.map((record) => [`${record.definition}/${record.check}`, record.content_hash]));
  for (const record of doc.identity) {
    const where = record.note;
    expect(record.content_hash, where).not.toBe(baseHash.get(`${record.base}/${record.check}`));
    expect(record.content_hash, where).toBe(
      nativeContentHash("translation", JSON.stringify(record.question)),
    );
    if (record.origin === "check") {
      // One changed check translates through the public path and produces
      // exactly the recorded variant question.
      const translation = translateJevQuestion(record.variant_question!);
      expect(translation.question, where).toEqual(record.question);
      expect(translation.content_hash, where).toBe(record.content_hash);
    }
  }
});

test("one changed translation changes the evaluator binding while the definition stays", async () => {
  const categorical = doc.cases[0]!;
  const reframed = doc.identity.find((record) => record.origin === "translation")!;
  expect(reframed.content_hash).not.toBe(categorical.content_hash);

  const definitionText = readFileSync(
    path.join(repoRoot, "fixtures", "definitions", "valid", categorical.definition),
    "utf8",
  );
  const info = nativeValidateDefinition(definitionText);
  const files: Record<string, string> = {};
  const evaluator: Evaluator = {
    id: "jev-choice",
    adapter_version: "0.1.0",
    async assess(request: EvaluatorRequest) {
      return { assessment: answerOf(request.question) };
    },
  };
  const registry = registerEvaluators(evaluator);

  /** Builds the exploration profile that binds one translation of the check. */
  const boundProfile = (translation: { content_hash: string; canonical: string }) => {
    const artifact = {
      schema_version: 1,
      id: "message-supported-exploration",
      origin: "exploration",
      intended_use: "Proposed intervention messages during development. Not a measured population.",
      definition: { name: info.name, content_hash: info.definitionHash },
      bindings: [
        {
          check: categorical.check,
          evaluator: evaluator.id,
          adapter_version: evaluator.adapter_version,
          translation: { content_hash: translation.content_hash, question: translation.canonical },
        },
      ],
      policy: {
        family: "probability_mass_v0",
        checks: [{ check: categorical.check, accept_cutoff: 0.75, rejection_cutoff: 0.65 }],
      },
      execution: { max_active: 4, max_pending: 16, deadline_ms: 30000, max_attempts: 2, backoff_ms: 200 },
      qualification: {
        status: "unvalidated",
        scope: "Development use in evaluation and shadow mode.",
        reasons: ["starter_policy"],
      },
    };
    return { ...artifact, content_hash: nativeComputeSelfHash("profile", JSON.stringify(artifact)) };
  };

  const first = boundProfile({ content_hash: categorical.content_hash, canonical: categorical.canonical });
  const second = boundProfile({ content_hash: reframed.content_hash, canonical: reframed.canonical });
  // The definition reference is identical; the binding and the profile
  // identity differ, because the translated question differs.
  expect(first.definition).toEqual(second.definition);
  expect(first.bindings[0]!.translation.content_hash).not.toBe(second.bindings[0]!.translation.content_hash);
  expect(first.content_hash).not.toBe(second.content_hash);

  // Both bindings load through the public path against the registered
  // evaluator, each with its own content hash. One binding that records the
  // other translation is a different profile. The evaluator states no live
  // translation, so the recorded ones compare against nothing here.
  const access = {
    async read(filePath: string): Promise<string> {
      const text = files[filePath];
      if (text === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      }
      return text;
    },
  };
  files["/first.json"] = JSON.stringify(first);
  files["/second.json"] = JSON.stringify(second);
  const artifact = JSON.parse(definitionText) as Parameters<typeof load>[0];
  const loadedFirst = await load(artifact, { profile: "/first.json", evaluators: registry, files: access });
  const loadedSecond = await load(artifact, { profile: "/second.json", evaluators: registry, files: access });
  expect(loadedFirst.definitionHash).toBe(info.definitionHash);
  expect(loadedFirst.profile?.content_hash).toBe(first.content_hash);
  expect(loadedSecond.profile?.content_hash).toBe(second.content_hash);
  expect(loadedFirst.profile?.bindings[0]?.translation.content_hash).toBe(categorical.content_hash);
  expect(loadedSecond.profile?.bindings[0]?.translation.content_hash).toBe(reframed.content_hash);

  // One evaluator that translates states the live translated question, so
  // load compares the recorded translation against the live one. The base
  // translation loads; the reframed one fails with translation_mismatch
  // before any execution.
  const translating: Evaluator = {
    id: evaluator.id,
    adapter_version: evaluator.adapter_version,
    translate: translateJevQuestion,
    async assess(request: EvaluatorRequest) {
      return { assessment: answerOf(request.question) };
    },
  };
  const translatingRegistry = registerEvaluators(translating);
  const dispatched = await dispatchedRequest(categorical);
  const liveTranslation = translating.translate!(dispatched.question);
  expect(liveTranslation.content_hash).toBe(categorical.content_hash);
  const reloaded = await load(artifact, {
    profile: "/first.json",
    evaluators: translatingRegistry,
    files: access,
  });
  expect(reloaded.profile?.bindings[0]?.translation.content_hash).toBe(categorical.content_hash);
  const failure = await asyncFailureOf(() =>
    load(artifact, { profile: "/second.json", evaluators: translatingRegistry, files: access }),
  );
  expect(failure.code).toBe("translation_mismatch");
  expect(failure.fieldPath).toBe("/profile/bindings/0/translation/content_hash");
});

// ---------------------------------------------------------------------------
// Rejections and the pinned wire shapes.
// ---------------------------------------------------------------------------

test("state rejections fail with the stated codes before any request exists", () => {
  for (const record of doc.state_rejections) {
    const failure = failureOf(() => jevEvidenceState(record.using, record.inputs));
    expect(failure.code, record.note).toBe(record.expected.reason_code);
    expect(failure.fieldPath, record.note).toBe(record.expected.field_path);
  }
});

test("the translation rejects one question outside the contract", () => {
  const categorical = doc.cases[0]!;
  const question = categorical.question as unknown as ValidatedQuestion;
  const table: readonly { note: string; question: unknown; fieldPath: string }[] = [
    { note: "one question that holds no object", question: "Which label?", fieldPath: "/question" },
    { note: "one unknown kind", question: { ...question, kind: "text" }, fieldPath: "/question/kind" },
    {
      note: "one empty wording",
      question: {
        kind: "categorical",
        question: "",
        answers: (question as unknown as { criteria: Record<string, string> }).criteria,
      },
      fieldPath: "/question/question",
    },
    {
      note: "one binary question without the yes description",
      question: { kind: "binary", question: "Supported?", answers: { no: "Nothing follows." } },
      fieldPath: "/question/answers/yes",
    },
    {
      note: "one ordered question with one level",
      question: {
        kind: "ordered",
        question: "How severe?",
        scale: [{ name: "minor", description: "No consequence." }],
      },
      fieldPath: "/question/scale",
    },
    {
      note: "one ordered level without one description",
      question: {
        kind: "ordered",
        question: "How severe?",
        scale: [
          { name: "minor", description: "No consequence." },
          { name: "serious", description: "" },
        ],
      },
      fieldPath: "/question/scale/1/description",
    },
  ];
  for (const record of table) {
    const failure = failureOf(() => translateJevQuestion(record.question as ValidatedQuestion));
    expect(failure.code, record.note).toBe("invalid_field_type");
    expect(failure.fieldPath, record.note).toBe(record.fieldPath);
  }
});

test("the state builder rejects one using list and inputs outside the contract", () => {
  const inputs = { text: "one message" };
  const emptyList = failureOf(() => jevEvidenceState([], inputs));
  expect(emptyList.code).toBe("invalid_field_type");
  expect(emptyList.fieldPath).toBe("/using");
  const nameType = failureOf(() => jevEvidenceState(["text", 7] as unknown as string[], inputs));
  expect(nameType.code).toBe("invalid_field_type");
  expect(nameType.fieldPath).toBe("/using/1");
  const inputShape = failureOf(() => jevEvidenceState(["text"], "one message" as unknown as Record<string, JSONValue>));
  expect(inputShape.code).toBe("invalid_field_type");
  expect(inputShape.fieldPath).toBe("/inputs");
});

test("the translated questions follow the wire shapes of the pinned SDK record", () => {
  const providerQuestions = providerCases.cases.flatMap((record) => Object.values(record.request.questions));
  const providerTypes = new Set(providerQuestions.map((question) => question.type));
  expect([...providerTypes].sort()).toEqual(["choice", "noul", "score"]);
  for (const record of doc.cases) {
    const ours = record.question;
    // One provider fixture question of the same primitive carries only field
    // names that the translated question also carries, and the criteria
    // match in shape: one object for Choice and Noul, one array for Score.
    const same = providerQuestions.filter((question) => question.type === ours.type);
    expect(same.length, record.note).toBeGreaterThan(0);
    expect(
      same.some((question) => {
        const keys = Object.keys(question);
        return (
          keys.every((key) => key in ours) &&
          Array.isArray(question.criteria) === Array.isArray(ours.criteria) &&
          (question.criteria === undefined) === (ours.criteria === undefined)
        );
      }),
      record.note,
    ).toBe(true);
    expect(Object.keys(ours).sort(), record.note).toEqual(["criteria", "instructions", "type"]);
  }
});
