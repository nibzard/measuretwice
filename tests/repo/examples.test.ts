// SPDX-License-Identifier: Apache-2.0
/**
 * Example checks for the development checks in `.measuretwice`.
 *
 * The case files are provisional fixtures, as `.measuretwice/README.md`
 * states. These checks hold the structural promises of that README: every
 * line is one JSON object, identifiers are unique kebab-case strings, and
 * each definition file names the measuretwice API. Full definition
 * validation is the job of the Rust core (T009, T010).
 */
import { test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const casesDir = path.join(repoRoot, ".measuretwice", "cases");
const checksDir = path.join(repoRoot, ".measuretwice", "checks");

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type Json = unknown;

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("every case line is one object with a unique kebab-case identifier", () => {
  const files = readdirSync(casesDir).filter((name) => name.endsWith(".jsonl")).sort();
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const text = readFileSync(path.join(casesDir, name), "utf8");
    const lines = text.split("\n");
    expect(lines.at(-1), `${name} must end with a new line`).toBe("");
    const records = lines.slice(0, -1);
    expect(records.length, `${name} holds no records`).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const [index, line] of records.entries()) {
      const lineNumber = index + 1;
      expect(line.trim(), `${name} line ${lineNumber} is empty`).not.toBe("");
      let record: Json;
      try {
        record = JSON.parse(line) as Json;
      } catch (error) {
        throw new Error(`${name} line ${lineNumber} is not valid JSON: ${String(error)}`);
      }
      expect(isObject(record), `${name} line ${lineNumber} is not an object`).toBe(true);
      const id = (record as Record<string, Json>).id;
      expect(typeof id, `${name} line ${lineNumber} has no string id`).toBe("string");
      expect(KEBAB.test(id as string), `${name} line ${lineNumber} id ${String(id)}`).toBe(true);
      expect(ids.has(id as string), `${name} repeats id ${String(id)}`).toBe(false);
      ids.add(id as string);
    }
  }
});

test("every case record holds input, expected, and label objects", () => {
  for (const name of readdirSync(casesDir).filter((value) => value.endsWith(".jsonl"))) {
    for (const [index, line] of readFileSync(path.join(casesDir, name), "utf8")
      .split("\n")
      .slice(0, -1)
      .entries()) {
      const record = JSON.parse(line) as Record<string, Json>;
      const where = `${name} line ${index + 1}`;
      expect(isObject(record.input), `${where} input`).toBe(true);
      expect(isObject(record.expected), `${where} expected`).toBe(true);
      expect(isObject(record.label), `${where} label`).toBe(true);
      const group = record.group;
      if (group !== undefined) {
        expect(typeof group, `${where} group`).toBe("string");
        expect(KEBAB.test(group as string), `${where} group ${String(group)}`).toBe(true);
      }
      const tags = record.tags;
      if (tags !== undefined) {
        expect(Array.isArray(tags), `${where} tags`).toBe(true);
        expect((tags as Json[]).every((tag) => typeof tag === "string"), `${where} tags`).toBe(true);
      }
    }
  }
});

test("every development definition imports and calls the measuretwice API", () => {
  const files = readdirSync(checksDir).filter((name) => name.endsWith(".ts")).sort();
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const text = readFileSync(path.join(checksDir, name), "utf8");
    expect(text.includes('from "measuretwice"'), `${name} imports measuretwice`).toBe(true);
    expect(text.includes("defineChecks("), `${name} calls defineChecks`).toBe(true);
    expect(text.includes('from "typebox"'), `${name} authors inputs with typebox`).toBe(true);
  }
});
