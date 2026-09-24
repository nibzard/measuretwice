// SPDX-License-Identifier: Apache-2.0
/**
 * defineChecks authoring tests.
 *
 * These tests cover the TypeBox authoring boundary of the public package:
 * inferred case-input types and `using` names at compile time, the documented
 * conversion into the portable definition, rejection of nonportable values
 * before serialization, and validation through the Rust core with the shared
 * hash fixtures. They read local files only, so they stay offline and
 * deterministic. The type assertions run under `npm run typecheck`.
 */
import { test, expect, expectTypeOf } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Type from "typebox";
import * as publicApi from "../src/index.js";
import { defineChecks, ValidationError, type CaseInput } from "../src/index.js";
import { NativeFailure, nativeValidateDefinition } from "../src/native.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The pinned TypeBox entry and the built package entry for the pair modules. */
const typeboxEntry = path.join(repoRoot, "node_modules", "typebox", "build", "index.mjs");
const packageEntry = path.join(repoRoot, "packages", "measuretwice", "dist", "index.js");

// ---------------------------------------------------------------------------
// Authored fixtures used across the tests.
// ---------------------------------------------------------------------------

/** The memory-length pair of the shared fixtures, authored inline. */
const memoryLength = defineChecks({
  version: 1,
  name: "memory-supported",
  inputs: Type.Object(
    {
      text: Type.String({ minLength: 1, description: "The proposed memory text" }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "text-length",
      name: "The memory fits the length limit",
      using: ["text"],
      rule: { maxLength: 10 },
    },
  ],
});

/** The all-input-types pair of the shared fixtures, authored inline. */
const releaseNotesReview = defineChecks({
  version: 1,
  name: "release-notes-review",
  inputs: Type.Object(
    {
      summary: Type.String({ minLength: 1, maxLength: 200 }),
      severity: Type.Integer({ minimum: 1, maximum: 5 }),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      breaking: Type.Boolean(),
      tickets: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 50 }),
      metadata: Type.Object(
        {
          team: Type.String({ minLength: 1 }),
          area: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "notes-complete",
      name: "The release notes identify the owning team",
      using: ["summary", "metadata"],
      question: "Do the notes name the team that owns the change?",
      answers: {
        yes: "The notes name the owning team.",
        no: "The notes do not name the owning team.",
      },
      accept: "yes",
    },
    {
      id: "summary-free-of-todos",
      name: "The summary carries no open work marker",
      using: ["summary"],
      rule: { excludes: "TODO" },
    },
  ],
});

// ---------------------------------------------------------------------------
// Compile-time behavior: inferred inputs and using names.
// ---------------------------------------------------------------------------

test("defineChecks infers the case input type from the TypeBox schema", () => {
  expectTypeOf<CaseInput<typeof memoryLength>>().toEqualTypeOf<{ text: string }>();
  expectTypeOf<CaseInput<typeof releaseNotesReview>>().toEqualTypeOf<{
    summary: string;
    severity: number;
    confidence: number;
    breaking: boolean;
    tickets: string[];
    metadata: { team: string; area?: string };
  }>();

  // The inferred type accepts one complete case input.
  const input: CaseInput<typeof releaseNotesReview> = {
    summary: "Fixes the login loop",
    severity: 2,
    confidence: 0.5,
    breaking: false,
    tickets: ["BUG-1"],
    metadata: { team: "core" },
  };
  expect(input.summary).toBe("Fixes the login loop");

  // A field outside the declared inputs stays a compile-time error.
  // @ts-expect-error the inferred input declares the authored fields only
  const wrong: CaseInput<typeof memoryLength> = { text: "Hello", weight: 3 };
  expect(wrong).toBeDefined();
});

test("unknown names in using fail at compile time and at the core boundary", () => {
  const unknownUsing = () =>
    defineChecks({
      version: 1,
      name: "unknown-using",
      inputs: Type.Object({ text: Type.String() }, { additionalProperties: false }),
      checks: [
        {
          id: "unknown-using",
          name: "The check names an undeclared input",
          // @ts-expect-error undeclared_input is not a declared input name
          using: ["undeclared_input"],
          question: "Does the check read a declared input?",
          answers: { yes: "It does.", no: "It does not." },
        },
      ],
    });
  // The suppression covers the compiler only. The Rust core still rejects
  // the artifact at run time, so a cast cannot bypass the contract.
  const failure = failureOf(unknownUsing);
  expect(failure.code).toBe("unknown_input_name");
  expect(failure.fieldPath).toBe("/checks/0/using");
});

// ---------------------------------------------------------------------------
// The shared TypeBox pairing fixtures, executed as authored modules.
// ---------------------------------------------------------------------------

test("each TypeBox pair converts to its definition artifact and published hash", async () => {
  expect(existsSync(typeboxEntry), "the pinned typebox entry exists").toBe(true);
  expect(existsSync(packageEntry), "build the package before the tests").toBe(true);
  const document = JSON.parse(
    readFileSync(path.join(repoRoot, "fixtures", "authoring", "typebox-pairs.json"), "utf8"),
  ) as { pairs: Array<{ note: string; definition: string; typebox: string; content_hash: string }> };
  expect(document.pairs.length).toBeGreaterThanOrEqual(3);

  const work = mkdtempSync(path.join(tmpdir(), "measuretwice-authoring-"));
  try {
    for (const [index, pair] of document.pairs.entries()) {
      // The fixture source is plain JavaScript. Point its two imports at the
      // built files, so the fixture stays the one source of truth.
      const source = pair.typebox
        .replace('from "typebox"', `from "${pathToFileURL(typeboxEntry).href}"`)
        .replace('from "measuretwice"', `from "${pathToFileURL(packageEntry).href}"`);
      const file = path.join(work, `pair-${index}.mjs`);
      writeFileSync(file, source);
      const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      const exported = Object.values(module).filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      );
      expect(exported.length, pair.note).toBe(1);
      const text = JSON.stringify(exported[0]);
      const artifact = JSON.parse(
        readFileSync(path.join(repoRoot, "fixtures", "definitions/valid", pair.definition), "utf8"),
      );
      expect(JSON.parse(text), pair.note).toEqual(artifact);
      expect(nativeValidateDefinition(text).definitionHash, pair.note).toBe(pair.content_hash);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The documented conversion.
// ---------------------------------------------------------------------------

test("the conversion keeps every supported constraint and the artifact identity", () => {
  const artifact = JSON.parse(
    readFileSync(path.join(repoRoot, "fixtures", "definitions/valid/memory-length.json"), "utf8"),
  );
  expect(memoryLength).toEqual(artifact);
  // The authoring field version becomes schema_version, and the omitted
  // when_uncertain stays absent from the serialized artifact.
  const serialized = JSON.parse(JSON.stringify(memoryLength));
  expect(Object.keys(serialized).sort()).toEqual(["checks", "inputs", "name", "schema_version"]);

  // The stated default serializes its field and keeps the one canonical hash.
  const stated = defineChecks({
    version: 1,
    name: "memory-supported",
    when_uncertain: "review",
    inputs: Type.Object({ text: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    checks: [
      { id: "text-length", name: "The memory fits the length limit", using: ["text"], rule: { maxLength: 10 } },
    ],
  });
  expect(Object.keys(stated).sort()).toEqual(["checks", "inputs", "name", "schema_version", "when_uncertain"]);
  expect(nativeValidateDefinition(JSON.stringify(stated)).definitionHash).toBe(
    nativeValidateDefinition(JSON.stringify(memoryLength)).definitionHash,
  );

  // Numeric bounds, arrays, booleans, and the nested optional property keep
  // their constraints, and the nested required list drops the optional name.
  expect(releaseNotesReview.inputs).toEqual({
    type: "object",
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 200 },
      severity: { type: "integer", minimum: 1, maximum: 5 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      breaking: { type: "boolean" },
      tickets: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 50 },
      metadata: {
        type: "object",
        properties: {
          team: { type: "string", minLength: 1 },
          area: { type: "string", minLength: 1 },
        },
        required: ["team"],
        additionalProperties: false,
      },
    },
    required: ["summary", "severity", "confidence", "breaking", "tickets", "metadata"],
    additionalProperties: false,
  });
});

test("the conversion removes only documented authoring metadata", () => {
  // Annotations and the readonly and immutable markers carry no constraint.
  // Their removal changes neither the artifact nor its hash.
  const annotated = defineChecks({
    version: 1,
    name: "annotated",
    inputs: Type.Object(
      {
        text: Type.Readonly(
          Type.String({ minLength: 1, title: "Memory text", description: "The proposal.", examples: ["One line."] }),
        ),
        extra: Type.Immutable(Type.Boolean()),
      },
      { additionalProperties: false, title: "Inputs", description: "The complete input." },
    ),
    checks: [
      { id: "text-length", name: "The memory fits the length limit", using: ["text"], rule: { maxLength: 10 } },
    ],
  });
  const plain = defineChecks({
    version: 1,
    name: "annotated",
    inputs: Type.Object(
      { text: Type.String({ minLength: 1 }), extra: Type.Boolean() },
      { additionalProperties: false },
    ),
    checks: [
      { id: "text-length", name: "The memory fits the length limit", using: ["text"], rule: { maxLength: 10 } },
    ],
  });
  expect(annotated).toEqual(plain);
  expect(nativeValidateDefinition(JSON.stringify(annotated)).definitionHash).toBe(
    nativeValidateDefinition(JSON.stringify(plain)).definitionHash,
  );

  // The serialized inputs hold no marker property and no annotation keyword.
  const scan = (value: unknown, visit: (key: string) => void): void => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item, visit);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        visit(key);
        scan(item, visit);
      }
    }
  };
  const found: string[] = [];
  scan(annotated.inputs, (key) => found.push(key));
  expect(found.filter((key) => key.startsWith("~") || ["title", "description", "examples"].includes(key)))
    .toEqual([]);
});

// ---------------------------------------------------------------------------
// Rejections. Every row states the reason code and the field path.
// ---------------------------------------------------------------------------

/** The authoring argument type of defineChecks, for deliberate bad casts. */
type Authoring = Parameters<typeof defineChecks>[0];

/** One authoring with a single text input, for the rejection table. */
function textAuthoring(inputs: unknown, checks?: unknown[]): () => void {
  const source =
    checks === undefined
      ? textChecks(inputs)
      : { version: 1 as const, name: "probe", inputs, checks };
  return () => {
    defineChecks(source as unknown as Authoring);
  };
}

/** Builds the default single-rule checks for one input schema. */
function textChecks(inputs: unknown): { version: 1; name: string; inputs: unknown; checks: unknown[] } {
  return {
    version: 1,
    name: "probe",
    inputs,
    checks: [{ id: "probe", name: "The probe rule", using: ["text"], rule: { maxLength: 3 } }],
  };
}

const QUESTION_CHECK = {
  id: "probe",
  name: "The probe question",
  using: ["text"],
  question: "Does the input satisfy the record?",
  answers: { yes: "It does.", no: "It does not." },
};

/** Every rejection the authoring boundary reports, with its stable identity. */
const REJECTIONS: ReadonlyArray<readonly [string, () => void, string, string]> = [
  [
    "a pattern constraint",
    textAuthoring(Type.Object({ text: Type.String({ pattern: "a+" }) }, { additionalProperties: false })),
    "unsupported_keyword",
    "/inputs/properties/text",
  ],
  [
    "a union type",
    textAuthoring(Type.Object({ text: Type.Union([Type.String(), Type.Number()]) }, { additionalProperties: false })),
    "unsupported_keyword",
    "/inputs/properties/text",
  ],
  [
    "a literal type",
    textAuthoring(Type.Object({ text: Type.Literal("fixed") }, { additionalProperties: false })),
    "unsupported_keyword",
    "/inputs/properties/text",
  ],
  [
    "a Refine custom validator",
    textAuthoring(Type.Object({ text: Type.Refine(Type.String(), (value) => value.length > 2) }, { additionalProperties: false })),
    "nonportable_value",
    "/inputs/properties/text",
  ],
  [
    "a decode transform",
    textAuthoring(Type.Object({ text: Type.Decode(Type.String(), (value) => value.trim()) }, { additionalProperties: false })),
    "nonportable_value",
    "/inputs/properties/text",
  ],
  [
    "an encode transform",
    textAuthoring(Type.Object({ text: Type.Encode(Type.String(), (value: unknown) => String(value)) }, { additionalProperties: false })),
    "nonportable_value",
    "/inputs/properties/text",
  ],
  [
    "an Unsafe type",
    textAuthoring(Type.Object({ text: Type.Unsafe({ type: "string" }) }, { additionalProperties: false })),
    "unsupported_keyword",
    "/inputs/properties/text",
  ],
  [
    "the optional modifier on array items",
    textAuthoring(
      Type.Object({ text: Type.String(), tags: Type.Array(Type.Optional(Type.String())) }, { additionalProperties: false }),
    ),
    "unsupported_keyword",
    "/inputs/properties/tags/items",
  ],
  [
    "a regular expression bound",
    textAuthoring(Type.Object({ text: Type.String({ maxLength: /a/ as unknown as number }) }, { additionalProperties: false })),
    "nonportable_value",
    "/inputs/properties/text/maxLength",
  ],
  [
    "a bound that is not finite",
    textAuthoring(
      Type.Object({ text: Type.String(), weight: Type.Number({ minimum: Number.NaN }) }, { additionalProperties: false }),
    ),
    "nonportable_value",
    "/inputs/properties/weight/minimum",
  ],
  [
    "a bigint bound",
    textAuthoring(
      Type.Object({ text: Type.String(), weight: Type.Number({ minimum: 1n as unknown as number }) }, { additionalProperties: false }),
    ),
    "nonportable_value",
    "/inputs/properties/weight/minimum",
  ],
  [
    "an open root schema",
    textAuthoring(Type.Object({ text: Type.String() })),
    "missing_field",
    "/inputs/additionalProperties",
  ],
  [
    "an open nested schema",
    textAuthoring(
      Type.Object(
        { text: Type.String(), meta: Type.Object({ team: Type.String() }, { additionalProperties: true }) },
        { additionalProperties: false },
      ),
    ),
    "invalid_field_type",
    "/inputs/properties/meta",
  ],
  [
    "an optional root input beside a required one",
    textAuthoring(
      Type.Object({ text: Type.String(), note: Type.Optional(Type.String()) }, { additionalProperties: false }),
    ),
    "missing_field",
    "/inputs/required",
  ],
  [
    "a function in a check field",
    textAuthoring(
      Type.Object({ text: Type.String() }, { additionalProperties: false }),
      [{ ...QUESTION_CHECK, name: (() => "named") as unknown as string }],
    ),
    "nonportable_value",
    "/checks/0/name",
  ],
  [
    "a symbol in a check field",
    textAuthoring(
      Type.Object({ text: Type.String() }, { additionalProperties: false }),
      [{ ...QUESTION_CHECK, accept: Symbol("yes") as unknown as string }],
    ),
    "nonportable_value",
    "/checks/0/accept",
  ],
  [
    "a date object in a check field",
    textAuthoring(
      Type.Object({ text: Type.String() }, { additionalProperties: false }),
      [{ ...QUESTION_CHECK, accept: new Date("2026-01-01") as unknown as string }],
    ),
    "nonportable_value",
    "/checks/0/accept",
  ],
  [
    "an explicitly undefined optional field",
    textAuthoring(
      Type.Object({ text: Type.String() }, { additionalProperties: false }),
      [{ ...QUESTION_CHECK, accept: undefined }],
    ),
    "nonportable_value",
    "/checks/0/accept",
  ],
  [
    "a rule that reads two inputs",
    textAuthoring(
      Type.Object({ text: Type.String(), note: Type.String() }, { additionalProperties: false }),
      [{ id: "probe", name: "The probe rule", using: ["text", "note"], rule: { maxLength: 3 } }],
    ),
    "invalid_field_type",
    "/checks/0/using",
  ],
  [
    "a check with a question and a rule",
    textAuthoring(
      Type.Object({ text: Type.String() }, { additionalProperties: false }),
      [{ ...QUESTION_CHECK, rule: { maxLength: 3 } }],
    ),
    "invalid_field_type",
    "/checks/0",
  ],
  [
    "an unsupported schema version",
    () => {
      defineChecks({
        ...textChecks(Type.Object({ text: Type.String() }, { additionalProperties: false })),
        version: 2 as unknown as 1,
      } as unknown as Authoring);
    },
    "unsupported_schema_version",
    "/schema_version",
  ],
  [
    "an uncertainty behavior outside the contract",
    () => {
      defineChecks({
        ...textChecks(Type.Object({ text: Type.String() }, { additionalProperties: false })),
        when_uncertain: "guess" as unknown as "review",
      } as unknown as Authoring);
    },
    "invalid_field_type",
    "/when_uncertain",
  ],
  [
    "an omitted checks field",
    () => {
      defineChecks({
        version: 1,
        name: "probe",
        inputs: Type.Object({ text: Type.String() }, { additionalProperties: false }),
      } as unknown as Authoring);
    },
    "missing_field",
    "/checks",
  ],
];

test("invalid authoring fails with its stated reason code and field path", () => {
  const codes = new Set<string>();
  for (const [note, attempt, code, fieldPath] of REJECTIONS) {
    const failure = failureOf(attempt);
    expect(failure.code, note).toBe(code);
    expect(failure.fieldPath, note).toBe(fieldPath);
    expect(failure.message, note).not.toBe("");
    codes.add(failure.code);
  }
  // The authoring boundary reports both wrapper-side and core-side reasons.
  expect([...codes].sort()).toEqual([
    "invalid_field_type",
    "missing_field",
    "nonportable_value",
    "unsupported_keyword",
    "unsupported_schema_version",
  ]);
});

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
  throw new Error("the authoring was accepted");
}

// ---------------------------------------------------------------------------
// The public failure type, serialization, and immutability.
// ---------------------------------------------------------------------------

test("authoring failures throw the public validation error", () => {
  const failure = failureOf(() =>
    defineChecks({
      version: 1,
      name: "bad-scale",
      inputs: Type.Object({ text: Type.String() }, { additionalProperties: false }),
      checks: [
        {
          id: "bad-scale",
          name: "The scale repeats one level",
          using: ["text"],
          question: "Which level applies?",
          scale: [{ low: "Low." }, { low: "Low again." }],
          accept: { at_least: "low" },
        },
      ],
    }),
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(NativeFailure);
  expect(failure.name).toBe("ValidationError");
  expect(failure.code).toBe("invalid_scale");
  expect(failure.fieldPath).toBe("/checks/0/scale");
  // The public surface hides the native failure type completely.
  expect("NativeFailure" in publicApi).toBe(false);
});

test("the returned definition is serializable and immutable", () => {
  expect(Object.isFrozen(memoryLength)).toBe(true);
  expect(Object.isFrozen(memoryLength.inputs)).toBe(true);
  expect(Object.isFrozen(memoryLength.checks)).toBe(true);
  expect(Object.isFrozen(memoryLength.checks[0])).toBe(true);
  expect(() => {
    (memoryLength as unknown as { name: string }).name = "renamed";
  }).toThrow();
  expect(JSON.parse(JSON.stringify(memoryLength))).toEqual(
    JSON.parse(readFileSync(path.join(repoRoot, "fixtures", "definitions/valid/memory-length.json"), "utf8")),
  );
  // A second authoring of the same content gives the same identity.
  const again = defineChecks({
    version: 1,
    name: "memory-supported",
    inputs: Type.Object({ text: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    checks: [
      { id: "text-length", name: "The memory fits the length limit", using: ["text"], rule: { maxLength: 10 } },
    ],
  });
  expect(nativeValidateDefinition(JSON.stringify(again)).definitionHash).toBe(
    nativeValidateDefinition(JSON.stringify(memoryLength)).definitionHash,
  );
});

test("the package entry point exposes the authoring and run API without native types", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "JEV_ADAPTER_VERSION",
    "JEV_DEFAULT_MODEL",
    "JEV_STATE_BUDGET_BYTES",
    "JEV_TRANSLATION_VERSION",
    "ValidationError",
    "calibrate",
    "classifyValidationEvidence",
    "compare",
    "contractVersion",
    "createExplorationProfile",
    "createJevEvaluator",
    "createLabelOnlyEvaluator",
    "createScriptedEvaluator",
    "decideLabelOnly",
    "defineChecks",
    "detectSplitOverlap",
    "evaluate",
    "exportShadowReviews",
    "jevEvidenceState",
    "labelRuleChecks",
    "load",
    "loadDataset",
    "mapJevError",
    "normalizeJevExecution",
    "registerEvaluators",
    "renderProfileSummary",
    "renderProfileSummaryMarkdown",
    "renderRunReport",
    "renderRunReportMarkdown",
    "requireSeparatedSplits",
    "translateJevQuestion",
    "validateReviewLabels",
  ]);
  expect(publicApi.contractVersion()).toBe(1);
});
