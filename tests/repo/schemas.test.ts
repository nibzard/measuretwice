// SPDX-License-Identifier: Apache-2.0
/**
 * Schema checks for the frozen contracts and the task file.
 *
 * These checks guard the frozen artifact set in `contracts/v0`. They stay
 * offline and need no JSON Schema library, because the rules below are the
 * documented invariants of this repository, not a general validator.
 * Authoritative artifact validation belongs to the Rust core.
 */
import { test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTodo } from "./support/todo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contractsDir = path.join(repoRoot, "contracts", "v0");

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const ID_PREFIX = "https://measuretwice.dev/contracts/v0/";

/** The frozen v0 artifact set. An additive change updates this list. */
const FROZEN_SCHEMAS = [
  "assessment.schema.json",
  "calibration-plan.schema.json",
  "case-record.schema.json",
  "common.schema.json",
  "comparison.schema.json",
  "dataset.schema.json",
  "definition.schema.json",
  "evaluation-report.schema.json",
  "hashing.schema.json",
  "input-schema.schema.json",
  "profile.schema.json",
  "run-report.schema.json",
];

type Json = unknown;

function loadJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves one JSON pointer against a parsed document. */
function resolvePointer(document: Json, pointer: string): Json | undefined {
  if (pointer === "") {
    return document;
  }
  let current: Json = document;
  for (const rawToken of pointer.split("/").slice(1)) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      current = current[index] as Json;
    } else if (isObject(current)) {
      current = current[token];
    } else {
      return undefined;
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/** Collects every `$ref` string in a parsed schema document. */
function collectRefs(node: Json, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRefs(item, refs);
    }
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        refs.push(value);
      } else {
        collectRefs(value, refs);
      }
    }
  }
  return refs;
}

const schemas = new Map<string, Record<string, Json>>();
for (const name of FROZEN_SCHEMAS) {
  schemas.set(name, loadJson(path.join(contractsDir, name)) as Record<string, Json>);
}

test("the contracts directory holds exactly the frozen schema set", () => {
  const present = readdirSync(contractsDir)
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  expect(present).toEqual([...FROZEN_SCHEMAS]);
});

test("every schema states the 2020-12 draft", () => {
  for (const [name, schema] of schemas) {
    expect(schema.$schema, name).toBe(DRAFT);
  }
});

test("every schema declares one unique identifier that matches its file name", () => {
  const seen = new Set<string>();
  for (const [name, schema] of schemas) {
    const id = schema.$id;
    expect(typeof id, name).toBe("string");
    expect(id, name).toBe(`${ID_PREFIX}${name}`);
    expect(seen.has(id as string), name).toBe(false);
    seen.add(id as string);
  }
});

test("every object-typed schema root rejects unknown fields", () => {
  // The contracts README states this rule for every schema except the input
  // schema envelope, which holds JSON Schema keywords. The two library
  // schemas without a root object type are that exception by construction.
  for (const [name, schema] of schemas) {
    if (schema.type === "object") {
      expect(schema.additionalProperties, name).toBe(false);
    }
  }
});

test("every reference resolves inside the contracts directory", () => {
  for (const [name, schema] of schemas) {
    for (const ref of collectRefs(schema)) {
      expect(ref.startsWith("http"), `${name}: ${ref} is remote`).toBe(false);
      const [file = "", pointer = ""] = ref.split("#");
      if (file === "") {
        expect(
          resolvePointer(schema, pointer ?? ""),
          `${name}: local pointer ${ref} does not resolve`,
        ).toBeDefined();
        continue;
      }
      const target = schemas.get(file);
      expect(target, `${name}: ${ref} names a missing file`).toBeDefined();
      expect(
        resolvePointer(target as Json, pointer ?? ""),
        `${name}: pointer ${ref} does not resolve`,
      ).toBeDefined();
    }
  }
});

test("to-do.json satisfies its schema and its dependency rules", () => {
  const document = loadJson(path.join(repoRoot, "to-do.json"));
  expect(validateTodo(document)).toEqual([]);
});

test("the task-file validator rejects invalid documents", () => {
  const validTask = {
    id: "T001",
    title: "Sample",
    priority: 1,
    status: "todo",
  };
  const invalid: Json[] = [
    { schema_version: 2, source_files: [], tasks: [] },
    { schema_version: 1, source_files: "x.md", tasks: [] },
    { schema_version: 1, source_files: [], tasks: {} },
    { schema_version: 1, source_files: [], tasks: [{ ...validTask, extra: true }] },
    { schema_version: 1, source_files: [], tasks: [{ ...validTask, priority: 9 }] },
    { schema_version: 1, source_files: [], tasks: [{ ...validTask, status: "open" }] },
    {
      schema_version: 1,
      source_files: [],
      tasks: [
        { ...validTask },
        { ...validTask, id: "T002", depends_on: ["T999"] },
      ],
    },
    {
      schema_version: 1,
      source_files: [],
      tasks: [{ ...validTask, id: "T002", updated_at: "2026-02-30T00:00:00Z" }],
    },
  ];
  for (const document of invalid) {
    expect(validateTodo(document), JSON.stringify(document)).not.toEqual([]);
  }
  expect(
    validateTodo({ schema_version: 1, source_files: [], tasks: [validTask] }),
  ).toEqual([]);
});
