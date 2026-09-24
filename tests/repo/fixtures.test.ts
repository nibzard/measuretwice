// SPDX-License-Identifier: Apache-2.0
/**
 * Fixture checks for the shared conformance suite in `fixtures/`.
 *
 * These checks verify the fixture data itself, the same way `schemas.test.ts`
 * verifies the frozen schemas: they state the documented invariants of this
 * repository, not a general validator. The authoritative validation of every
 * artifact stays in the Rust core. The digest checks below recompute SHA-256
 * over the published canonical text to keep the data honest; no product code
 * hashes or canonicalizes outside the core.
 */
import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesDir = path.join(repoRoot, "fixtures");

type Json = unknown;
type Err = { code: string; path: string };

function loadJson(file: string): Json {
  return JSON.parse(readFileSync(path.join(fixturesDir, file), "utf8")) as Json;
}

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObjects(value: Json): Record<string, Json>[] {
  return Array.isArray(value) && value.every(isObject) ? (value as Record<string, Json>[]) : [];
}

/** The stable reason-code registry from the contracts README. */
const REASON_CODES = new Set([
  // Validation reasons.
  "invalid_json", "unsupported_schema_version", "unknown_field", "missing_field",
  "invalid_field_type", "duplicate_id", "unknown_label", "unknown_input_name",
  "accept_review_overlap", "invalid_scale", "empty_check_set", "unsupported_keyword",
  "nonportable_value", "hash_mismatch", "oversized_input", "unsupported_format",
  // Execution reasons.
  "evaluator_error", "evaluator_timeout", "invalid_assessment", "retries_exhausted",
  "deadline_exceeded", "run_cancelled", "late_result_rejected", "invalid_state_transition",
  // Skip reasons.
  "queue_full", "cancelled_before_start", "deadline_before_start",
  // Compatibility reasons.
  "definition_mismatch", "evaluator_mismatch", "translation_mismatch",
  "model_resolution_changed", "policy_mismatch", "scope_mismatch", "qualification_insufficient",
  // Qualification reasons.
  "starter_policy", "measured_evidence", "exact_rules_only",
  // Statistics reasons.
  "insufficient_evidence", "zero_denominator", "unsupported_sampling", "criteria_not_met",
]);

/** Two digests published as worked examples in contracts/v0/hashing.md. */
const PUBLISHED_INPUT_HASH = "ebf29f3107f775b64d775c4acbe22d2ba495509039f10f93fb7a6b460547b558";
const PUBLISHED_DEFINITION_HASH = "2a9b1c7f4537bd4248a7c89ec1aae104b2cc92aad8c285a0b3ae9b9b17d83df6";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The digest formula from the hashing contract: SHA-256 over the domain tag,
 * one zero byte, and the canonical text. This verifies fixture data only.
 */
function digestOf(domain: string, canonical: string): string {
  return createHash("sha256").update(domain, "utf8").update(Buffer.from([0])).update(canonical, "utf8").digest("hex");
}

/** Deep equality that treats negative zero and zero as one value, as the hashing contract does. */
function deepEqualNumbers(first: Json, second: Json): boolean {
  if (typeof first === "number" && typeof second === "number") {
    return Object.is(first, second) || (first === 0 && second === 0);
  }
  if (Array.isArray(first) && Array.isArray(second)) {
    return first.length === second.length && first.every((item, index) => deepEqualNumbers(item, second[index]));
  }
  if (isObject(first) && isObject(second)) {
    const firstKeys = Object.keys(first);
    const secondKeys = Object.keys(second);
    return (
      firstKeys.length === secondKeys.length &&
      firstKeys.every((key) => Object.prototype.hasOwnProperty.call(second, key) && deepEqualNumbers(first[key], second[key]))
    );
  }
  return first === second;
}

/** The one documented default: an omitted when_uncertain canonicalizes as "review". */
function materializeWhenUncertain(value: Json): Json {
  if (!isObject(value) || value.when_uncertain !== undefined) return value;
  return { ...value, when_uncertain: "review" };
}

/** Every object inside parsed canonical text sorts its keys in UTF-16 order. */
function keysAreSorted(node: Json): boolean {
  if (Array.isArray(node)) {
    return node.every(keysAreSorted);
  }
  if (isObject(node)) {
    const keys = Object.keys(node);
    const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return keys.every((key, index) => key === sorted[index]) && keys.every((key) => keysAreSorted(node[key]));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Manifest and file layout.
// ---------------------------------------------------------------------------

const manifest = loadJson("manifest.json") as { mandatory_for?: Json; groups?: { id: string; path: string }[] };
const groups = manifest.groups ?? [];

function fixtureJsonFiles(): string[] {
  const files: string[] = [];
  const stack = [fixturesDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else if (entry.endsWith(".json")) {
        files.push(path.relative(fixturesDir, full));
      }
    }
  }
  return files.sort();
}

test("the manifest lists every fixture group and the groups exist", () => {
  expect(groups.length).toBeGreaterThan(0);
  const listed = new Set<string>();
  for (const group of groups) {
    const fullPath = path.join(fixturesDir, group.path);
    expect(statSync(fullPath), group.path).toBeTruthy();
    if (statSync(fullPath).isDirectory()) {
      for (const name of readdirSync(fullPath)) {
        if (name.endsWith(".json")) listed.add(path.posix.join(group.path, name));
      }
    } else {
      listed.add(group.path);
    }
  }
  const present = new Set(fixtureJsonFiles().filter((file) => file !== "manifest.json"));
  expect([...listed].sort()).toEqual([...present].sort());
});

test("the fixtures are mandatory for the TypeScript SDK and the Python SDK", () => {
  expect(manifest.mandatory_for).toEqual(["typescript-sdk", "python-sdk"]);
});

// ---------------------------------------------------------------------------
// Definition invariants. These state the rules of the contracts README and
// contracts/v0/input-schema.md. The Rust core stays the authority.
// ---------------------------------------------------------------------------

const ARTIFACT_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const INPUT_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SUBSET_KEYWORDS: Record<string, Set<string>> = {
  string: new Set(["type", "minLength", "maxLength"]),
  number: new Set(["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]),
  integer: new Set(["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]),
  boolean: new Set(["type"]),
  array: new Set(["type", "items", "minItems", "maxItems"]),
  object: new Set(["type", "properties", "required", "additionalProperties"]),
};

function checkInputSchema(schema: Json, where: string, isRoot: boolean, errors: Err[]): void {
  if (!isObject(schema)) {
    errors.push({ code: "invalid_field_type", path: where });
    return;
  }
  const type = schema.type;
  if (typeof type !== "string" || !(type in SUBSET_KEYWORDS)) {
    errors.push({ code: "unsupported_keyword", path: where });
    return;
  }
  const allowed = SUBSET_KEYWORDS[type] as Set<string>;
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key)) {
      errors.push({ code: "unsupported_keyword", path: where });
    }
  }
  if (type === "string" || type === "number" || type === "integer") {
    const isString = type === "string";
    const lower = isString ? schema.minLength : schema.minimum;
    const upper = isString ? schema.maxLength : schema.maximum;
    const lowerOk = lower === undefined || (typeof lower === "number" && Number.isFinite(lower));
    const upperOk = upper === undefined || (typeof upper === "number" && Number.isFinite(upper));
    if (!lowerOk || !upperOk || (lower !== undefined && upper !== undefined && lower > upper)) {
      errors.push({ code: "invalid_field_type", path: where });
    }
  }
  if (type === "array") {
    if (schema.items === undefined) {
      errors.push({ code: "missing_field", path: `${where}/items` });
    } else {
      checkInputSchema(schema.items, `${where}/items`, false, errors);
    }
    for (const keyword of ["minItems", "maxItems"]) {
      const value = schema[keyword];
      if (value !== undefined && !(typeof value === "number" && value >= 0 && value <= 10000)) {
        errors.push({ code: "invalid_field_type", path: where });
      }
    }
    if (
      typeof schema.minItems === "number" && typeof schema.maxItems === "number" &&
      schema.minItems > schema.maxItems
    ) {
      errors.push({ code: "invalid_field_type", path: where });
    }
  }
  if (type === "object") {
    const properties = schema.properties;
    if (!isObject(properties)) {
      errors.push({ code: "missing_field", path: `${where}/properties` });
      return;
    }
    if (schema.additionalProperties !== false) {
      errors.push({ code: isRoot ? "missing_field" : "invalid_field_type", path: where });
    }
    const declared = new Set(Object.keys(properties));
    for (const [name, subschema] of Object.entries(properties)) {
      if (!INPUT_NAME.test(name)) {
        errors.push({ code: "invalid_field_type", path: `${where}/properties/${name}` });
      }
      checkInputSchema(subschema, `${where}/properties/${name}`, false, errors);
    }
    const required = schema.required;
    if (isRoot && !Array.isArray(required)) {
      errors.push({ code: "missing_field", path: `${where}/required` });
      return;
    }
    if (Array.isArray(required)) {
      required.forEach((name, index) => {
        if (typeof name !== "string" || !declared.has(name)) {
          errors.push({ code: "unknown_field", path: `${where}/required/${index}` });
        }
      });
      if (isRoot) {
        for (const name of declared) {
          if (!required.includes(name)) {
            errors.push({ code: "missing_field", path: `${where}/required` });
          }
        }
      }
    }
  }
}

function checkDefinition(definition: Json, errors: Err[]): void {
  if (!isObject(definition)) {
    errors.push({ code: "invalid_field_type", path: "" });
    return;
  }
  const known = new Set(["schema_version", "name", "when_uncertain", "inputs", "checks"]);
  for (const key of Object.keys(definition)) {
    if (!known.has(key)) {
      errors.push({ code: "unknown_field", path: `/${key}` });
    }
  }
  for (const key of ["schema_version", "name", "inputs", "checks"]) {
    if (definition[key] === undefined) {
      errors.push({ code: "missing_field", path: `/${key}` });
    }
  }
  if (definition.schema_version !== undefined) {
    if (typeof definition.schema_version !== "number") {
      errors.push({ code: "invalid_field_type", path: "/schema_version" });
    } else if (definition.schema_version !== 1) {
      errors.push({ code: "unsupported_schema_version", path: "/schema_version" });
    }
  }
  if (definition.name !== undefined && !(typeof definition.name === "string" && ARTIFACT_ID.test(definition.name))) {
    errors.push({ code: "invalid_field_type", path: "/name" });
  }
  if (definition.when_uncertain !== undefined && definition.when_uncertain !== "review") {
    errors.push({ code: "invalid_field_type", path: "/when_uncertain" });
  }
  if (definition.inputs !== undefined) {
    checkInputSchema(definition.inputs, "/inputs", true, errors);
  }
  const declaredInputs = new Set(
    isObject(definition.inputs) && isObject(definition.inputs.properties) ? Object.keys(definition.inputs.properties) : [],
  );
  if (definition.checks !== undefined) {
    if (!Array.isArray(definition.checks) || definition.checks.length === 0) {
      errors.push({ code: "empty_check_set", path: "/checks" });
      return;
    }
    const seen = new Map<string, number>();
    definition.checks.forEach((raw, index) => {
      const where = `/checks/${index}`;
      if (!isObject(raw)) {
        errors.push({ code: "invalid_field_type", path: where });
        return;
      }
      const knownCheck = new Set(["id", "name", "using", "question", "answers", "scale", "accept", "review", "rule"]);
      for (const key of Object.keys(raw)) {
        if (!knownCheck.has(key)) {
          errors.push({ code: "unknown_field", path: `${where}/${key}` });
        }
      }
      for (const key of ["id", "name", "using"]) {
        if (raw[key] === undefined) {
          errors.push({ code: "missing_field", path: `${where}/${key}` });
        }
      }
      if (typeof raw.id === "string") {
        if (!ARTIFACT_ID.test(raw.id)) {
          errors.push({ code: "invalid_field_type", path: `${where}/id` });
        } else if (seen.has(raw.id)) {
          errors.push({ code: "duplicate_id", path: `${where}/id` });
        } else {
          seen.set(raw.id, index);
        }
      }
      const using = raw.using;
      if (Array.isArray(using)) {
        for (const name of using) {
          if (typeof name !== "string" || !declaredInputs.has(name)) {
            errors.push({ code: "unknown_input_name", path: `${where}/using` });
          }
        }
      }
      const hasQuestion = raw.question !== undefined;
      const hasRule = raw.rule !== undefined;
      if (hasQuestion && hasRule) {
        errors.push({ code: "invalid_field_type", path: where });
      } else if (!hasQuestion && !hasRule) {
        errors.push({ code: "missing_field", path: `${where}/question` });
      }
      if (hasRule) {
        if (!Array.isArray(using) || using.length !== 1) {
          errors.push({ code: "invalid_field_type", path: `${where}/using` });
        } else {
          const only = using[0];
          const subschema =
            isObject(definition.inputs) && isObject(definition.inputs.properties)
              ? (definition.inputs.properties as Record<string, Json>)[String(only)]
              : undefined;
          if (!isObject(subschema) || subschema.type !== "string") {
            errors.push({ code: "invalid_field_type", path: `${where}/using` });
          }
        }
        const rule = raw.rule;
        if (isObject(rule)) {
          const keys = Object.keys(rule);
          if (keys.length === 1 && keys[0] === "maxLength") {
            const bound = rule.maxLength;
            if (!(typeof bound === "number" && Number.isInteger(bound) && bound >= 0)) {
              errors.push({ code: "invalid_field_type", path: `${where}/rule/maxLength` });
            }
          } else if (keys.length === 1 && (keys[0] === "includes" || keys[0] === "excludes")) {
            const parameter = rule[keys[0] as string];
            if (!(typeof parameter === "string" && parameter.length >= 1 && parameter.length <= 1000)) {
              errors.push({ code: "invalid_field_type", path: `${where}/rule/${keys[0] as string}` });
            }
          } else {
            errors.push({ code: "invalid_field_type", path: `${where}/rule` });
          }
        } else {
          errors.push({ code: "invalid_field_type", path: `${where}/rule` });
        }
      }
      const answers = raw.answers;
      const scale = raw.scale;
      const labels = new Set<string>();
      const levels: string[] = [];
      if (hasQuestion) {
        if (answers !== undefined && scale !== undefined) {
          errors.push({ code: "invalid_field_type", path: where });
          return;
        }
        if (answers === undefined && scale === undefined) {
          errors.push({ code: "missing_field", path: `${where}/answers` });
          return;
        }
        if (isObject(answers)) {
          const entries = Object.entries(answers);
          if (entries.length < 2 || !entries.every(([, text]) => typeof text === "string" && text.length >= 1)) {
            errors.push({ code: "invalid_field_type", path: `${where}/answers` });
          }
          for (const label of Object.keys(answers)) labels.add(label);
        }
        if (Array.isArray(scale)) {
          const levelNames = new Set<string>();
          let valid = scale.length >= 2;
          for (const level of scale) {
            const keys = isObject(level) ? Object.keys(level) : [];
            if (keys.length !== 1) valid = false;
            else {
              levels.push(keys[0] as string);
              if (levelNames.has(keys[0] as string)) valid = false;
              levelNames.add(keys[0] as string);
            }
          }
          if (!valid) {
            errors.push({ code: "invalid_scale", path: `${where}/scale` });
          }
          for (const level of levelNames) labels.add(level);
        }
        const accept = raw.accept;
        const accepted = new Set<string>();
        if (isObject(accept)) {
          // Scale acceptance: at_least names a level.
          const atLeast = accept.at_least;
          if (Object.keys(accept).length !== 1 || typeof atLeast !== "string" || !labels.has(atLeast)) {
            errors.push({ code: "unknown_label", path: `${where}/accept/at_least` });
          } else {
            accepted.add(atLeast);
            const position = levels.indexOf(atLeast);
            for (const level of levels.slice(position)) accepted.add(level);
          }
        } else if (typeof accept === "string") {
          if (!labels.has(accept)) {
            errors.push({ code: "unknown_label", path: `${where}/accept` });
          } else {
            accepted.add(accept);
          }
        } else if (Array.isArray(accept)) {
          for (const label of accept) {
            if (typeof label !== "string" || !labels.has(label)) {
              errors.push({ code: "unknown_label", path: `${where}/accept` });
            } else {
              accepted.add(label);
            }
          }
        }
        const review = raw.review;
        if (review !== undefined) {
          const reviewLabels = typeof review === "string" ? [review] : Array.isArray(review) ? review : [];
          for (const label of reviewLabels) {
            if (typeof label !== "string" || !labels.has(label)) {
              errors.push({ code: "unknown_label", path: `${where}/review` });
            } else if (accepted.has(label)) {
              errors.push({ code: "accept_review_overlap", path: `${where}/review` });
            }
          }
        }
      }
    });
  }
}

test("every valid definition satisfies the documented invariants", () => {
  const files = fixtureJsonFiles().filter((file) => file.startsWith("definitions/valid/"));
  expect(files.length).toBeGreaterThanOrEqual(6);
  for (const file of files) {
    const errors: Err[] = [];
    checkDefinition(loadJson(file), errors);
    expect(errors, `${file}: ${JSON.stringify(errors)}`).toEqual([]);
  }
});

test("every invalid definition fails with its stated reason code and field path", () => {
  const doc = loadJson("definitions/invalid.json") as { records?: Json[] };
  const records = asObjects(doc.records);
  expect(records.length).toBeGreaterThanOrEqual(20);
  const coveredCodes = new Set<string>();
  for (const record of records) {
    const expected = record.expected as { reason_code?: string; field_path?: string } | undefined;
    expect(expected, "each record states an expected failure").toBeDefined();
    expect(REASON_CODES.has(String(expected?.reason_code)), String(expected?.reason_code)).toBe(true);
    coveredCodes.add(String(expected?.reason_code));
    const errors: Err[] = [];
    checkDefinition(record.raw, errors);
    expect(errors.length, `${String(record.note)} produced no error`).toBeGreaterThan(0);
    expect(
      errors.some((error) => error.code === expected?.reason_code && error.path === expected?.field_path),
      `${String(record.note)}: no error matched ${JSON.stringify(expected)}`,
    ).toBe(true);
  }
  for (const code of [
    "duplicate_id", "unknown_input_name", "accept_review_overlap", "unknown_label",
    "invalid_scale", "empty_check_set", "unsupported_keyword", "unsupported_schema_version",
    "unknown_field", "missing_field", "invalid_field_type",
  ]) {
    expect(coveredCodes.has(code), `no fixture covers ${code}`).toBe(true);
  }
});

test("the when_uncertain pair covers each definition shape and every input type", () => {
  const definitions = fixtureJsonFiles()
    .filter((file) => file.startsWith("definitions/valid/"))
    .map((file) => ({ file, value: loadJson(file) as Record<string, Json> }));
  const shapes = new Set<string>();
  const inputTypes = new Set<string>();
  for (const definition of definitions) {
    const checks = Array.isArray(definition.value.checks) ? definition.value.checks : [];
    for (const raw of checks) {
      const check = raw as Record<string, Json>;
      if (check.rule !== undefined) shapes.add("rule");
      if (check.question !== undefined && check.answers !== undefined) {
        const answers = check.answers as Record<string, Json>;
        const keys = Object.keys(answers);
        shapes.add(keys.length === 2 && keys.includes("yes") && keys.includes("no") ? "binary" : "categorical");
      }
      if (check.question !== undefined && check.scale !== undefined) shapes.add("ordered");
    }
    const inputs = definition.value.inputs as Record<string, Json>;
    const properties = isObject(inputs.properties) ? (inputs.properties as Record<string, Json>) : {};
    for (const subschema of Object.values(properties)) {
      if (isObject(subschema) && typeof subschema.type === "string") inputTypes.add(subschema.type);
    }
  }
  expect([...shapes].sort()).toEqual(["binary", "categorical", "ordered", "rule"]);
  expect([...inputTypes].sort()).toEqual(["array", "boolean", "integer", "number", "object", "string"]);
});

// ---------------------------------------------------------------------------
// Input validation fixtures.
// ---------------------------------------------------------------------------

test("input fixtures use subset schemas and name registry reason codes", () => {
  const doc = loadJson("inputs/validation.json") as { records?: Json[] };
  const records = asObjects(doc.records);
  expect(records.length).toBeGreaterThanOrEqual(20);
  const dataCodes = new Set<string>();
  for (const record of records) {
    const errors: Err[] = [];
    checkInputSchema(record.inputs, "/inputs", true, errors);
    expect(errors, `${String(record.note)}: schema is outside the subset`).toEqual([]);
    if (record.valid !== true) {
      const expected = record.expected as { reason_code?: string } | undefined;
      expect(expected, `${String(record.note)} states no reason code`).toBeDefined();
      expect(REASON_CODES.has(String(expected?.reason_code))).toBe(true);
      dataCodes.add(String(expected?.reason_code));
    }
  }
  expect(dataCodes.has("oversized_input")).toBe(true);
});

// ---------------------------------------------------------------------------
// Hashing fixtures.
// ---------------------------------------------------------------------------

type HashFixture = {
  note?: string;
  domain?: string;
  value?: Json;
  canonical?: string;
  content_hash?: string;
};

test("every canonical fixture matches its value, the digest formula, and sorted keys", () => {
  const doc = loadJson("hashing/canonical.json") as { hashes?: HashFixture[] };
  const entries = doc.hashes ?? [];
  expect(entries.length).toBeGreaterThanOrEqual(20);
  const domains = new Set<string>();
  for (const entry of entries) {
    expect(entry.domain, JSON.stringify(entry.note)).toBeDefined();
    domains.add(String(entry.domain));
    const canonical = String(entry.canonical);
    const hash = String(entry.content_hash);
    expect(HASH_PATTERN.test(hash), hash).toBe(true);
    // The digest formula from hashing.md, checked over the published canonical text.
    expect(digestOf(String(entry.domain), canonical), String(entry.note)).toBe(hash);
    const parsed = JSON.parse(canonical) as Json;
    expect(keysAreSorted(parsed), `${canonical} holds unsorted keys`).toBe(true);
    const expected = entry.domain === "definition" ? materializeWhenUncertain(entry.value) : entry.value;
    expect(
      deepEqualNumbers(parsed, expected),
      `${String(entry.note)}: canonical text does not parse back to the value`,
    ).toBe(true);
  }
  expect([...domains].sort()).toEqual(["dataset", "definition", "input", "plan", "profile", "split", "translation"]);
});

test("the published worked examples appear unchanged", () => {
  const doc = loadJson("hashing/canonical.json") as { hashes?: HashFixture[] };
  const entries = doc.hashes ?? [];
  const input = entries.find((entry) => entry.domain === "input" && isObject(entry.value) && entry.value.proposed_message === "Hello, EU export!");
  expect(input?.content_hash).toBe(PUBLISHED_INPUT_HASH);
  const definition = entries.filter((entry) => entry.domain === "definition" && (entry.value as Record<string, Json>)?.name === "memory-supported");
  expect(definition.length).toBe(2);
  expect(definition[0]?.content_hash).toBe(PUBLISHED_DEFINITION_HASH);
  // The omitted and the stated when_uncertain produce one canonical form and one hash.
  expect(definition[0]?.content_hash).toBe(definition[1]?.content_hash);
  expect(definition[0]?.canonical).toBe(definition[1]?.canonical);
});

test("definition fixtures with a published hash match their artifact files", () => {
  const doc = loadJson("hashing/canonical.json") as { hashes?: HashFixture[] };
  const files = new Map<string, Json>();
  for (const file of fixtureJsonFiles().filter((name) => name.startsWith("definitions/valid/"))) {
    files.set(JSON.stringify(loadJson(file)), file);
  }
  let matched = 0;
  for (const entry of doc.hashes ?? []) {
    if (entry.domain !== "definition") continue;
    const file = files.get(JSON.stringify(entry.value));
    expect(file, `no artifact file matches the definition entry ${String(entry.note)}`).toBeDefined();
    matched += 1;
  }
  expect(matched).toBeGreaterThanOrEqual(5);
});

/** Code point containment, as the string contract defines matching. */
function containsCodePoints(haystack: string, needle: string): boolean {
  const text = [...haystack];
  const part = [...needle];
  if (part.length === 0) return false;
  outer: for (let start = 0; start <= text.length - part.length; start += 1) {
    for (let offset = 0; offset < part.length; offset += 1) {
      if (text[start + offset] !== part[offset]) continue outer;
    }
    return true;
  }
  return false;
}

test("string rule fixtures follow the documented length and matching semantics", () => {
  const doc = loadJson("hashing/string-rules.json") as { string_rules?: Json[] };
  const rules = asObjects(doc.string_rules);
  expect(rules.length).toBeGreaterThanOrEqual(20);
  for (const rule of rules) {
    const kind = String(rule.rule);
    const input = String(rule.input);
    const outcome = String(rule.outcome);
    expect(["pass", "fail"]).toContain(outcome);
    if (kind === "maxLength") {
      const parameter = rule.parameter;
      expect(typeof parameter === "number" && Number.isInteger(parameter) && parameter >= 0).toBe(true);
      expect(rule.length, `${JSON.stringify(input)} length`).toBeDefined();
      expect([...input].length, JSON.stringify(input)).toBe(Number(rule.length));
      expect(outcome, JSON.stringify(input)).toBe([...input].length <= Number(parameter) ? "pass" : "fail");
    } else {
      const parameter = rule.parameter;
      expect(typeof parameter === "string" && parameter.length >= 1 && parameter.length <= 1000).toBe(true);
      const contained = containsCodePoints(input, String(parameter));
      expect(outcome, `${kind} ${JSON.stringify(parameter)} in ${JSON.stringify(input)}`).toBe(
        kind === "includes" ? (contained ? "pass" : "fail") : contained ? "fail" : "pass",
      );
    }
  }
});

test("hashing rejection fixtures name registry codes and hold text or bytes", () => {
  const doc = loadJson("hashing/invalid.json") as { records?: Json[] };
  const records = asObjects(doc.records);
  expect(records.length).toBeGreaterThanOrEqual(5);
  const codes = new Set<string>();
  for (const record of records) {
    const expected = record.expected as { reason_code?: string } | undefined;
    expect(REASON_CODES.has(String(expected?.reason_code))).toBe(true);
    codes.add(String(expected?.reason_code));
    expect(record.raw_text !== undefined || record.bytes_hex !== undefined, String(record.note)).toBe(true);
  }
  expect([...codes].sort()).toEqual(["invalid_field_type", "invalid_json", "nonportable_value"]);
});

// ---------------------------------------------------------------------------
// TypeBox pairing and serialization.
// ---------------------------------------------------------------------------

test("each TypeBox pair matches its definition artifact, canonical form, and hash", () => {
  const canonicalDoc = loadJson("hashing/canonical.json") as { hashes?: HashFixture[] };
  const doc = loadJson("authoring/typebox-pairs.json") as { pairs?: Json[] };
  const pairs = asObjects(doc.pairs);
  expect(pairs.length).toBeGreaterThanOrEqual(3);
  for (const pair of pairs) {
    const name = String(pair.definition);
    const file = `definitions/valid/${name}`;
    const artifact = loadJson(file);
    const entry = (canonicalDoc.hashes ?? []).find(
      (candidate) => candidate.domain === "definition" && deepEqualNumbers(candidate.value, artifact),
    );
    expect(entry, `${file} has no canonical fixture`).toBeDefined();
    expect(pair.canonical).toBe(entry?.canonical);
    expect(pair.content_hash).toBe(entry?.content_hash);
    const source = String(pair.typebox);
    expect(source.includes("Type.Object(")).toBe(true);
    expect(source.includes("version: 1")).toBe(true);
    // The authoring field name never appears in the portable definition.
    expect(source.includes("schema_version")).toBe(false);
  }
});

test("round-trip values keep one canonical form and authoring kinds are rejected", () => {
  const doc = loadJson("serialization/round-trips.json") as Record<string, Json | undefined>;
  const values = asObjects(doc.values);
  expect(values.length).toBeGreaterThanOrEqual(3);
  for (const record of values) {
    const parsed = JSON.parse(String(record.canonical)) as Json;
    expect(deepEqualNumbers(parsed, record.value), String(record.note)).toBe(true);
  }
  for (const record of asObjects(doc.order_invariance)) {
    const parsed = JSON.parse(String(record.canonical)) as Json;
    expect(deepEqualNumbers(parsed, record.left)).toBe(true);
    expect(deepEqualNumbers(parsed, record.right)).toBe(true);
  }
  for (const record of asObjects(doc.order_strictness)) {
    expect(record.canonical_left).not.toBe(record.canonical_right);
    expect(record.same_hash).toBe(false);
  }
  for (const record of asObjects(doc.absent_stays_absent)) {
    expect(record.canonical_with).not.toBe(record.canonical_without);
    expect(record.same_hash).toBe(false);
  }
  const kinds = asObjects(doc.rejected_kinds);
  expect(kinds.length).toBeGreaterThanOrEqual(10);
  for (const record of kinds) {
    expect(String((record.expected as { reason_code?: string })?.reason_code)).toBe("nonportable_value");
  }
});

// ---------------------------------------------------------------------------
// Assessments, outcomes, profiles, and runtime traces.
// ---------------------------------------------------------------------------

test("valid assessments match their kind and invalid assessments are rejected", () => {
  const doc = loadJson("assessments/samples.json") as Record<string, Json | undefined>;
  const valid = asObjects(doc.valid);
  expect(valid.length).toBeGreaterThanOrEqual(4);
  for (const record of valid) {
    const assessment = record.assessment as Record<string, Json>;
    expect(new Set(["categorical", "binary", "ordered"]).has(String(assessment.kind))).toBe(true);
    if (assessment.kind === "categorical") expect(typeof assessment.label).toBe("string");
    if (assessment.kind === "binary") expect(typeof assessment.value).toBe("boolean");
    if (assessment.kind === "ordered") expect(typeof assessment.level).toBe("string");
  }
  const invalid = asObjects(doc.invalid);
  expect(invalid.length).toBeGreaterThanOrEqual(6);
  for (const record of invalid) {
    expect(String((record.expected as { reason_code?: string })?.reason_code)).toBe("invalid_assessment");
    expect(Array.isArray(record.using)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Adapter conformance cases.
// ---------------------------------------------------------------------------

/** The two shipped test adapters, as the conformance group names them. */
const TEST_ADAPTER_IDS = ["label-only-test", "scripted-test"];

/** Reads one question check of one definition fixture. */
function questionCheckOf(definitionFile: string, checkId: string): Record<string, Json> | undefined {
  const definition = loadJson(`definitions/valid/${definitionFile}`) as Record<string, Json>;
  const checks = Array.isArray(definition.checks) ? (definition.checks as Record<string, Json>[]) : [];
  return checks.find((check) => String(check.id) === checkId && check.question !== undefined);
}

/** Resolves the answer kind of one question check, as the core rule states it. */
function questionKindOf(check: Record<string, Json>): string {
  if (Array.isArray(check.scale)) return "ordered";
  const answers = isObject(check.answers) ? Object.keys(check.answers) : [];
  return answers.length === 2 && answers.includes("yes") && answers.includes("no") ? "binary" : "categorical";
}

/** Resolves the acceptable labels or levels of one question check. */
function acceptLabelsOf(check: Record<string, Json>): Set<string> {
  const levels = Array.isArray(check.scale)
    ? (check.scale as Record<string, Json>[]).map((level) => String(Object.keys(level)[0]))
    : [];
  const accept = check.accept;
  const accepted = new Set<string>();
  if (typeof accept === "string") accepted.add(accept);
  else if (Array.isArray(accept)) accept.forEach((label) => accepted.add(String(label)));
  else if (isObject(accept) && typeof accept.at_least === "string") {
    const start = levels.indexOf(String(accept.at_least));
    levels.slice(start < 0 ? levels.length : start).forEach((level) => accepted.add(level));
  }
  return accepted;
}

test("adapter conformance cases stay consistent with the question fixtures", () => {
  const doc = loadJson("adapters/conformance.json") as Record<string, Json | undefined>;
  const adapters = new Map(
    asObjects(doc.adapters as Json[]).map((adapter) => [String(adapter.id), adapter]),
  );
  expect([...adapters.keys()].sort()).toEqual(TEST_ADAPTER_IDS);
  for (const adapter of adapters.values()) {
    expect(ARTIFACT_ID.test(String(adapter.id)), String(adapter.id)).toBe(true);
    expect(typeof adapter.adapter_version === "string" && adapter.adapter_version !== "").toBe(true);
  }
  const neverInvented = new Set((doc.never_invented as Json[] | undefined)?.map(String) ?? []);
  expect([...neverInvented].sort()).toEqual(["confidence", "distribution", "evidence", "position", "usage"]);

  const cases = asObjects(doc.cases as Json[]);
  expect(cases.length).toBeGreaterThanOrEqual(15);
  const controls = new Set<string>();
  for (const record of cases) {
    const where = String(record.note);
    expect(adapters.has(String(record.adapter)), `${where} names no declared adapter`).toBe(true);
    const check = questionCheckOf(String(record.definition), String(record.check));
    expect(check, `${where} names no question check of its definition`).toBeDefined();
    const kind = questionKindOf(check as Record<string, Json>);
    expect(record.signal === undefined || record.signal === "aborted", where).toBe(true);
    if (record.signal === "aborted") controls.add("aborted");

    const control = record.control;
    if (control === "script-empty") {
      controls.add("script-empty");
    } else {
      expect(isObject(control), `${where} holds one malformed control`).toBe(true);
      const map = control as Record<string, Json>;
      const keys = Object.keys(map);
      const single = keys.filter((key) => ["answer", "raw", "error", "answers"].includes(key));
      expect(single.length, `${where} states ${single.length} controls`).toBe(1);
      controls.add(single[0] as string);
      const named = (single[0] as string) ?? "";
      if (named === "answers") {
        const answers = map.answers;
        expect(isObject(answers), `${where} holds no answer table`).toBe(true);
        const entries = Object.entries(answers as Record<string, Json>);
        for (const [checkId, answer] of entries) {
          expect(typeof answer === "string" || typeof answer === "boolean", `${where}: ${checkId}`).toBe(true);
          expect(checkId, `${where} names one answer outside the check`).toBe(String(record.check));
        }
        expect(String(record.adapter)).toBe("label-only-test");
      } else {
        expect(String(record.adapter)).toBe("scripted-test");
        if (named === "error") {
          expect(
            typeof map.error === "string" && map.error !== "",
            `${where} holds no usable error`,
          ).toBe(true);
        }
        const delay = map.delay_ms;
        if (delay !== undefined) {
          expect(typeof delay === "number" && Number.isFinite(delay) && delay >= 0, where).toBe(true);
          controls.add("delay_ms");
        }
      }
    }

    const expected = record.expected as Record<string, Json>;
    expect(isObject(expected), `${where} holds no expected record`).toBe(true);
    const held = ["assessment", "failure"].filter((key) => expected[key] !== undefined);
    expect(held.length, `${where} expects ${held.length} results`).toBe(1);
    if (held[0] === "assessment") {
      const assessment = expected.assessment as Record<string, Json>;
      expect(assessment.kind, where).toBe(kind);
      const answerKeys = ["label", "value", "level"].filter((key) => assessment[key] !== undefined);
      expect(answerKeys.length, `${where} expects one selected answer`).toBe(1);
      if (String(record.adapter) === "label-only-test") {
        expect(Object.keys(assessment).sort(), `${where} invents one measurement`).toEqual(
          ["kind", answerKeys[0] as string].sort(),
        );
        for (const forbidden of neverInvented) {
          expect(forbidden in assessment, `${where} invents ${forbidden}`).toBe(false);
        }
      }
    } else {
      const failure = expected.failure as Record<string, Json>;
      expect(REASON_CODES.has(String(failure.code)), `${where}: ${String(failure.code)}`).toBe(true);
      const messages = ["message", "message_contains"].filter((key) => typeof failure[key] === "string");
      expect(messages.length, `${where} states no message expectation`).toBe(1);
    }
    const delays = expected.delays_ms;
    if (delays !== undefined) {
      expect(Array.isArray(delays) && delays.every((ms) => typeof ms === "number"), where).toBe(true);
    }
  }
  for (const control of ["answer", "raw", "error", "answers", "delay_ms", "script-empty", "aborted"]) {
    expect(controls.has(control), `no case covers the control ${control}`).toBe(true);
  }
});

test("the label rule table decides from the check meaning alone", () => {
  const doc = loadJson("adapters/conformance.json") as Record<string, Json | undefined>;
  const rule = doc.label_rule as Record<string, Json>;
  expect(typeof rule.statement === "string" && rule.statement !== "").toBe(true);
  const table = asObjects(rule.table as Json[]);
  expect(table.length).toBeGreaterThanOrEqual(8);
  const outcomes = new Set<string>();
  for (const row of table) {
    const where = String(row.note);
    const check = questionCheckOf(String(row.definition), String(row.check));
    expect(check, `${where} names no question check of its definition`).toBeDefined();
    const question = check as Record<string, Json>;
    const accepted = acceptLabelsOf(question);
    const review = new Set<string>(
      typeof question.review === "string"
        ? [question.review]
        : Array.isArray(question.review)
          ? question.review.map(String)
          : [],
    );
    const assessment = row.assessment as Record<string, Json>;
    expect(assessment.kind, where).toBe(questionKindOf(question));
    const selected =
      assessment.label !== undefined
        ? String(assessment.label)
        : assessment.level !== undefined
          ? String(assessment.level)
          : assessment.value === true
            ? "yes"
            : assessment.value === false
              ? "no"
              : undefined;
    expect(selected, `${where} states no selected answer`).toBeDefined();
    const outcome = accepted.has(selected as string)
      ? "pass"
      : review.has(selected as string)
        ? "review"
        : "fail";
    expect(row.expected_outcome, where).toBe(outcome);
    outcomes.add(String(row.expected_outcome));
  }
  expect([...outcomes].sort()).toEqual(["fail", "pass", "review"]);
});

test("replacement pairs and binding rows keep the evaluator independence invariants", () => {
  const doc = loadJson("adapters/conformance.json") as Record<string, Json | undefined>;
  const adapters = new Set(asObjects(doc.adapters as Json[]).map((adapter) => String(adapter.id)));
  const replacement = doc.replacement as Record<string, Json>;
  for (const pair of asObjects(replacement.pairs as Json[])) {
    const where = String(pair.note);
    const named = (pair.adapters as Json[] | undefined)?.map(String) ?? [];
    expect(named.length, where).toBe(2);
    expect(new Set(named).size, where).toBe(2);
    for (const id of named) expect(adapters.has(id), `${where} names ${id}`).toBe(true);
    expect(questionCheckOf(String(pair.definition), String(pair.check)), where).toBeDefined();
    expect(pair.definition_hash_equal, where).toBe(true);
  }

  const binding = doc.binding as Record<string, Json>;
  const states = loadJson("profiles/states.json") as Record<string, Json | undefined>;
  const exploration = asObjects(states.profiles).find((profile) => profile.id === "message-supported-exploration");
  const explorationBinding = (exploration?.bindings as Record<string, Json>[] | undefined)?.[0];
  for (const row of asObjects(binding.table as Json[])) {
    const where = String(row.note);
    for (const side of ["bound", "registered"]) {
      const entry = row[side] as Record<string, Json>;
      expect(ARTIFACT_ID.test(String(entry.evaluator)), `${where}: ${side}`).toBe(true);
      expect(typeof entry.adapter_version === "string" && entry.adapter_version !== "").toBe(true);
    }
    const expected = row.expected as { reason_code?: string; field_path?: string } | undefined;
    if (expected !== undefined) {
      expect(REASON_CODES.has(String(expected.reason_code)), where).toBe(true);
      expect(typeof expected.field_path === "string" && expected.field_path !== "").toBe(true);
      expect(
        String((row.bound as Record<string, Json>).evaluator) !== String((row.registered as Record<string, Json>).evaluator) ||
          String((row.bound as Record<string, Json>).adapter_version) !== String((row.registered as Record<string, Json>).adapter_version),
        `${where} binds exactly what the registry holds`,
      ).toBe(true);
    } else {
      expect(row.loads, where).toBe(true);
      expect(row.definition_hash_equal, where).toBe(true);
      expect(row.profile_content_hash_equal, where).toBe(false);
    }
  }
  // The Jev-bound row rebinds the exploration profile of the shared states.
  const jevRow = asObjects(binding.table as Json[])[0]?.bound as Record<string, Json>;
  expect(String(jevRow.evaluator)).toBe(String(explorationBinding?.evaluator));
  expect(String(jevRow.adapter_version)).toBe(String(explorationBinding?.adapter_version));
});

test("the aggregate table follows the fixed order and the samples cover every outcome", () => {
  const doc = loadJson("reports/outcomes.json") as Record<string, Json | undefined>;
  const table = asObjects(doc.aggregate_table);
  expect(table.length).toBeGreaterThanOrEqual(15);
  const outcomesSeen = new Set<string>();
  for (const row of table) {
    const outcomes = (row.outcomes as string[]) ?? [];
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) outcomesSeen.add(outcome);
    const expected = outcomes.includes("fail")
      ? "fail"
      : outcomes.includes("error")
        ? "error"
        : outcomes.includes("review") || outcomes.includes("skipped")
          ? "review"
          : "pass";
    expect(row.expected_aggregate, JSON.stringify(outcomes)).toBe(expected);
  }
  expect([...outcomesSeen].sort()).toEqual(["error", "fail", "pass", "review", "skipped"]);
  for (const record of asObjects(doc.check_records)) {
    const check = record.record as Record<string, Json>;
    if (check.outcome === "error" || check.outcome === "skipped") {
      expect(check.reason, String(record.note)).toBeDefined();
    }
    if (check.kind === "rule") {
      expect(check.applied_rule, String(record.note)).toBeDefined();
    }
  }
  const completions = asObjects(doc.completion_samples).map((sample) => (sample.completion as Record<string, Json>).status);
  expect([...completions].sort()).toEqual(["cancelled", "completed", "deadline_exceeded"]);
});

function profileErrors(profile: Json): Err[] {
  const errors: Err[] = [];
  if (!isObject(profile)) return [{ code: "invalid_field_type", path: "" }];
  for (const key of ["schema_version", "id", "origin", "intended_use", "definition", "policy", "execution", "qualification"]) {
    if (profile[key] === undefined) errors.push({ code: "missing_field", path: `/${key}` });
  }
  if (profile.schema_version !== undefined && profile.schema_version !== 1) {
    errors.push({ code: "unsupported_schema_version", path: "/schema_version" });
  }
  if (profile.origin === "calibration" && profile.evidence === undefined) {
    errors.push({ code: "missing_field", path: "/evidence" });
  }
  if (profile.origin === "exploration" && isObject(profile.qualification) && profile.qualification.status !== "unvalidated") {
    errors.push({ code: "invalid_field_type", path: "/qualification/status" });
  }
  if (profile.origin === "exact") {
    if (Array.isArray(profile.bindings) && profile.bindings.length > 0) {
      errors.push({ code: "invalid_field_type", path: "/bindings/0" });
    }
    if (isObject(profile.policy) && profile.policy.family !== "exact") {
      errors.push({ code: "invalid_field_type", path: "/policy/family" });
    }
  }
  if (isObject(profile.policy) && profile.policy.family === "probability_mass_v0") {
    const checks = Array.isArray(profile.policy.checks) ? profile.policy.checks : [];
    if (checks.length === 0) {
      errors.push({ code: "missing_field", path: "/policy/checks" });
    }
    checks.forEach((raw, index) => {
      const check = raw as Record<string, Json>;
      for (const key of ["accept_cutoff", "rejection_cutoff"]) {
        const value = check[key];
        if (!(typeof value === "number" && value > 0.5 && value <= 1)) {
          errors.push({ code: "invalid_field_type", path: `/policy/checks/${index}/${key}` });
        }
      }
    });
  }
  return errors;
}

test("valid profiles cover every qualification status and invalid profiles fail with stated codes", () => {
  const doc = loadJson("profiles/states.json") as Record<string, Json | undefined>;
  const profiles = asObjects(doc.profiles);
  expect(profiles.length).toBeGreaterThanOrEqual(5);
  const statuses = new Set<string>();
  for (const profile of profiles) {
    expect(profileErrors(profile), String(profile.id)).toEqual([]);
    expect(HASH_PATTERN.test(String(profile.content_hash))).toBe(true);
    statuses.add(String((profile.qualification as Record<string, Json>).status));
  }
  expect([...statuses].sort()).toEqual(["criteria_not_met", "insufficient_evidence", "unvalidated", "validated_for_scope"]);
  for (const record of asObjects(doc.invalid)) {
    const expected = record.expected as { reason_code?: string; field_path?: string };
    const errors = profileErrors(record.profile);
    expect(
      errors.some((error) => error.code === expected.reason_code && error.path === expected.field_path),
      `${String(record.note)}: ${JSON.stringify(errors)}`,
    ).toBe(true);
  }
});

test("profile hashes and references stay consistent with the hashing fixtures", () => {
  const canonicalDoc = loadJson("hashing/canonical.json") as { hashes?: HashFixture[] };
  const entries = canonicalDoc.hashes ?? [];
  const states = loadJson("profiles/states.json") as Record<string, Json | undefined>;
  const profiles = asObjects(states.profiles);

  // The published profile-domain entry matches the exact profile and its self-hash.
  const profileEntry = entries.find((entry) => entry.domain === "profile");
  const exact = profiles.find((profile) => profile.origin === "exact");
  expect(exact).toBeDefined();
  const body = structuredClone(exact) as Record<string, Json>;
  delete body.content_hash;
  expect(deepEqualNumbers(profileEntry?.value, body)).toBe(true);
  expect(profileEntry?.content_hash).toBe(exact?.content_hash);

  // The exact profile binds the definition hash of the exact-rules artifact.
  const exactRulesHash = entries.find(
    (entry) => entry.domain === "definition" && (entry.value as Record<string, Json>)?.name === "delivery-limits",
  )?.content_hash;
  expect((exact?.definition as Record<string, Json>)?.content_hash).toBe(exactRulesHash);

  // The exploration binding records the published translation hash.
  const translationHash = entries.find((entry) => entry.domain === "translation")?.content_hash;
  const exploration = profiles.find((profile) => profile.origin === "exploration");
  const binding = (exploration?.bindings as Record<string, Json>[] | undefined)?.[0];
  expect((binding?.translation as Record<string, Json>)?.content_hash).toBe(translationHash);

  // Calibration evidence records the published plan, dataset, and split digests.
  const calibrated = profiles.find(
    (profile) => profile.origin === "calibration" && (profile.qualification as Record<string, Json>).status === "validated_for_scope",
  );
  const evidence = calibrated?.evidence as Record<string, Json>;
  expect((evidence.plan as Record<string, Json>)?.content_hash).toBe(
    entries.find((entry) => entry.domain === "plan")?.content_hash,
  );
  expect((evidence.datasets as Record<string, Json>[])?.[0]?.content_hash).toBe(
    entries.find((entry) => entry.domain === "dataset")?.content_hash,
  );
  const splitHashes = (evidence.splits as Record<string, Json>[]).map((split) => split.content_hash);
  const publishedSplits = entries.filter((entry) => entry.domain === "split").map((entry) => entry.content_hash);
  expect(splitHashes.every((hash) => publishedSplits.includes(String(hash)))).toBe(true);
});

test("compatibility fixtures pair valid profiles with the wrong definition", () => {
  const states = loadJson("profiles/states.json") as Record<string, Json | undefined>;
  const canonicalDoc = loadJson("hashing/canonical.json") as { hashes?: HashFixture[] };
  const entries = canonicalDoc.hashes ?? [];
  const byId = new Map(asObjects(states.profiles).map((profile) => [String(profile.id), profile]));
  const records = asObjects(states.compatibility);
  expect(records.length).toBeGreaterThanOrEqual(2);
  for (const record of records) {
    const profile = byId.get(String(record.profile_id));
    expect(profile, String(record.profile_id)).toBeDefined();
    const artifact = loadJson(`definitions/valid/${String(record.against_definition)}`) as Record<string, Json>;
    const artifactHash = entries.find(
      (entry) => entry.domain === "definition" && deepEqualNumbers(entry.value, artifact),
    )?.content_hash;
    const code = String((record.expected as { reason_code?: string })?.reason_code);
    if (code === "definition_mismatch") {
      expect((profile?.definition as Record<string, Json>)?.content_hash).not.toBe(artifactHash);
    }
    if (code === "policy_mismatch") {
      const allRules = (artifact.checks as Record<string, Json>[]).every((check) => check.rule !== undefined);
      expect(allRules, "the artifact is exact-only").toBe(true);
      expect((profile?.policy as Record<string, Json>)?.family).not.toBe("exact");
    }
  }
});

test("runtime traces cover every execution and skip reason and stay internally consistent", () => {
  const doc = loadJson("runtime/traces.json") as { traces?: Json[] };
  const traces = asObjects(doc.traces);
  expect(traces.length).toBeGreaterThanOrEqual(10);
  const reasonCodes = new Set<string>();
  for (const trace of traces) {
    const where = String(trace.id);
    const definition = loadJson(`definitions/valid/${String(trace.definition)}`) as Record<string, Json>;
    const checkIds = new Set(
      ((definition.checks as Record<string, Json>[]) ?? []).map((check) => String(check.id)),
    );
    expect(checkIds.size).toBeGreaterThan(0);

    const config = trace.config as Record<string, Json>;
    expect(config.max_active).toBeGreaterThanOrEqual(1);
    expect(config.deadline_ms).toBeGreaterThanOrEqual(1);
    expect(config.max_attempts).toBeGreaterThanOrEqual(1);

    const events = asObjects(trace.events);
    let last = -1;
    for (const event of events) {
      expect(Number(event.at_ms), `${where} events advance the clock`).toBeGreaterThanOrEqual(last);
      last = Number(event.at_ms);
      if (event.check !== undefined) {
        expect(checkIds.has(String(event.check)), `${where} names an unknown check`).toBe(true);
      }
    }

    const expected = trace.expected as Record<string, Json>;
    const records = asObjects(expected.checks);
    expect(records.map((record) => String(record.check)).sort()).toEqual([...checkIds].sort());
    const outcomes: string[] = [];
    for (const record of records) {
      const outcome = String(record.outcome);
      outcomes.push(outcome);
      if (outcome === "error" || outcome === "skipped") {
        const code = String((record.reason as Record<string, Json>)?.code);
        expect(REASON_CODES.has(code), `${where}: ${code}`).toBe(true);
        reasonCodes.add(code);
      }
      if (record.attempts !== undefined) {
        expect(Number(record.attempts)).toBeGreaterThanOrEqual(1);
        expect(Number(record.attempts)).toBeLessThanOrEqual(Number(config.max_attempts));
      }
    }
    const aggregate = outcomes.includes("fail")
      ? "fail"
      : outcomes.includes("error")
        ? "error"
        : outcomes.includes("review") || outcomes.includes("skipped")
          ? "review"
          : "pass";
    expect(expected.aggregate, where).toBe(aggregate);
    expect(new Set(["completed", "cancelled", "deadline_exceeded"]).has(String(expected.completion))).toBe(true);

    for (const rejected of asObjects(expected.rejected_events)) {
      const index = Number(rejected.event);
      expect(events[index], `${where} names a missing rejected event`).toBeDefined();
      const code = String(rejected.reason_code);
      expect(REASON_CODES.has(code), code).toBe(true);
      reasonCodes.add(code);
    }
  }
  for (const code of [
    "queue_full", "deadline_before_start", "deadline_exceeded", "cancelled_before_start",
    "run_cancelled", "retries_exhausted", "evaluator_error", "late_result_rejected",
    "invalid_state_transition",
  ]) {
    expect(reasonCodes.has(code), `no trace covers ${code}`).toBe(true);
  }
});
