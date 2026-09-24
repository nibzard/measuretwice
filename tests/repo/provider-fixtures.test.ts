// SPDX-License-Identifier: Apache-2.0
/**
 * Provider fixture checks.
 *
 * The Jev provider record in `providers/jev/` pins the verified SDK
 * contract and holds synthetic response fixtures. These checks keep that
 * data honest: the provenance stays complete, every record states its
 * synthetic origin, malformed records name their defect, and valid
 * responses follow the documented shapes of the pinned SDK version.
 *
 * The checks read local files only. They never install the SDK, open a
 * network connection, or read a credential.
 */
import { test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = path.join(repoRoot, "providers", "jev", "fixtures", "responses.json");
const recordPath = path.join(repoRoot, "providers", "jev", "README.md");
const developingPath = path.join(repoRoot, "DEVELOPING.md");

const PINNED_SDK_VERSION = "0.6.0";
const PINNED_MODEL = "jev-1.13.0";

interface Source {
  kind: string;
  url?: string;
  name?: string;
}

interface FixtureCase {
  id: string;
  note: string;
  origin: string;
  source: string;
  defect?: string;
  request: { state: unknown; questions: Record<string, unknown> };
  response: {
    model?: string;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
    answers: Record<string, Record<string, unknown>>;
  };
}

interface FixtureFile {
  schema_version: number;
  provenance: {
    sdk: string;
    sdk_version: string;
    model: string;
    checked_at: string;
    live_calls: boolean;
    contract_record: string;
    sources: Source[];
  };
  cases: FixtureCase[];
}

function loadFixtures(): FixtureFile {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureFile;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

test("the Jev provider record and fixtures exist", () => {
  expect(existsSync(fixturePath)).toBe(true);
  expect(existsSync(recordPath)).toBe(true);
});

test("the fixture provenance is complete and names no live call", () => {
  const fixtures = loadFixtures();
  expect(fixtures.schema_version).toBe(1);
  expect(fixtures.provenance.sdk).toBe("@typesafe-ai/sdk");
  expect(fixtures.provenance.sdk_version).toBe(PINNED_SDK_VERSION);
  expect(fixtures.provenance.model).toBe(PINNED_MODEL);
  expect(fixtures.provenance.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(fixtures.provenance.live_calls).toBe(false);
  expect(fixtures.provenance.sources.length).toBeGreaterThan(0);
  for (const source of fixtures.provenance.sources) {
    expect(source.kind).toBeTruthy();
    expect(source.url ?? source.name).toBeTruthy();
  }
  const recordDir = path.dirname(fixturePath);
  expect(existsSync(path.resolve(recordDir, fixtures.provenance.contract_record))).toBe(true);
});

test("every fixture record is synthetic and well formed", () => {
  const fixtures = loadFixtures();
  expect(fixtures.cases.length).toBeGreaterThan(0);
  const seen = new Set<string>();
  let malformed = 0;
  for (const fixtureCase of fixtures.cases) {
    expect(seen.has(fixtureCase.id)).toBe(false);
    seen.add(fixtureCase.id);
    expect(fixtureCase.note).toBeTruthy();
    expect(fixtureCase.origin).toBe("synthetic");
    expect(fixtureCase.source).toBeTruthy();
    expect(Object.keys(fixtureCase.request.questions).length).toBeGreaterThan(0);
    expect(fixtureCase.request).toHaveProperty("state");

    if (fixtureCase.defect !== undefined) {
      malformed += 1;
      expect(fixtureCase.defect).toBeTruthy();
      continue;
    }

    expect(fixtureCase.response.model).toMatch(/^jev-\d+\.\d+\.\d+$/);
    expect(isNumber(fixtureCase.response.usage?.input_tokens)).toBe(true);
    expect(isNumber(fixtureCase.response.usage?.output_tokens)).toBe(true);
    expect(Object.keys(fixtureCase.response.answers).length).toBeGreaterThan(0);
    for (const answer of Object.values(fixtureCase.response.answers)) {
      if (answer.type === "choice") {
        expect(typeof answer.choice).toBe("string");
        expect(isNumber(answer.confidence)).toBe(true);
        expect(answer.probabilities).toBeTypeOf("object");
      } else if (answer.type === "noul") {
        expect(isNumber(answer.noul)).toBe(true);
        // Noul defines no confidence field; a valid fixture must not add one.
        expect(answer).not.toHaveProperty("confidence");
      } else if (answer.type === "score") {
        expect(isNumber(answer.score)).toBe(true);
        expect(isNumber(answer.confidence)).toBe(true);
        expect(answer.legend).toBeTypeOf("object");
        expect(answer.probabilities).toBeTypeOf("object");
      } else {
        expect(answer.type, `unknown answer type in ${fixtureCase.id}`).toBeOneOf([
          "choice",
          "noul",
          "score",
        ]);
      }
    }
  }
  expect(malformed).toBeGreaterThan(0);
});

test("the pinned SDK version in the fixture matches the development guide", () => {
  const developing = readFileSync(developingPath, "utf8");
  expect(developing).toContain("`@typesafe-ai/sdk`");
  expect(developing).toContain(`| \`@typesafe-ai/sdk\` | ${PINNED_SDK_VERSION} |`);
  expect(developing).not.toContain("is not pinned yet");
  const record = readFileSync(recordPath, "utf8");
  expect(record).toContain(PINNED_SDK_VERSION);
  expect(record).toContain(PINNED_MODEL);
});
