// SPDX-License-Identifier: Apache-2.0
/**
 * Project-name checks.
 *
 * AGENTS.md fixes the project name as "measuretwice": one word, all
 * lowercase. These checks reject the other forms in the controlled source
 * files and confirm the manifest names.
 *
 * `research/` keeps historical records with their original wording, as
 * AGENTS.md allows, so the scan skips that directory. `package-lock.json`
 * is generated output, so the scan skips it too.
 */
import { test, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SCANNED_EXTENSIONS = new Set([".md", ".ts", ".json", ".toml", ".html", ".yml", ".yaml"]);
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "target", "dist"]);
// package-lock.json is generated. This test file itself enumerates the
// rejected forms to check the scan, so neither can hold a meaningful use.
const EXCLUDED_FILES = new Set([
  "package-lock.json",
  path.join("tests", "repo", "names.test.ts"),
]);

/**
 * Forms of the project name that AGENTS.md rejects. The spaced and
 * hyphenated forms match in any case. The one-word forms match only with
 * wrong case, because the correct lowercase name must stay allowed.
 */
const FORBIDDEN_NAMES: RegExp[] = [
  /measure[- ]twice/i,
  /MeasureTwice/,
  /Measuretwice/,
  /MEASURETWICE/,
];

function forbiddenForm(text: string): string | undefined {
  for (const pattern of FORBIDDEN_NAMES) {
    const match = pattern.exec(text);
    if (match !== null) {
      return match[0];
    }
  }
  return undefined;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  const stack = [repoRoot];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current)) {
      if (entry === "research" && current === repoRoot) {
        continue;
      }
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry)) {
          stack.push(full);
        }
      } else {
        const relative = path.relative(repoRoot, full);
        if (SCANNED_EXTENSIONS.has(path.extname(entry)) && !EXCLUDED_FILES.has(relative)) {
          files.push(relative);
        }
      }
    }
  }
  return files.sort();
}

function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, file), "utf8")) as unknown;
}

test("the manifests use the exact project name", () => {
  const workspace = loadJson("package.json") as { name?: string; workspaces?: string[] };
  expect(workspace.name).toBe("measuretwice-workspace");
  expect(workspace.workspaces).toEqual(["packages/*", "crates/measuretwice-node"]);

  const published = loadJson(path.join("packages", "measuretwice", "package.json")) as {
    name?: string;
  };
  expect(published.name).toBe("measuretwice");

  const binding = loadJson(path.join("crates", "measuretwice-node", "package.json")) as {
    name?: string;
  };
  expect(binding.name).toBe("measuretwice-node");

  const cargo = readFileSync(path.join(repoRoot, "Cargo.toml"), "utf8");
  expect(cargo).toContain('"crates/measuretwice-core"');
  expect(cargo).toContain('"crates/measuretwice-node"');
  expect(existsSync(path.join(repoRoot, "crates", "measuretwice-core"))).toBe(true);
  expect(existsSync(path.join(repoRoot, "crates", "measuretwice-node"))).toBe(true);
});

test("no controlled source file uses a rejected form of the project name", () => {
  const problems: string[] = [];
  for (const file of scannedFiles()) {
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    for (const [lineNumber, line] of text.split("\n").entries()) {
      // A form inside double quotes is a quotation of a name, not a use of
      // it. AGENTS.md quotes the rejected forms in the rule itself, and
      // external quotations keep their original wording.
      const unquoted = line.replaceAll(/"[^"]*"/g, "");
      const form = forbiddenForm(unquoted);
      if (form !== undefined) {
        problems.push(`${file}:${lineNumber + 1} holds ${JSON.stringify(form)}`);
      }
    }
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the name scan rejects every wrong form and keeps the correct name", () => {
  const rejected = [
    "MeasureTwice",
    "Measuretwice",
    "MEASURETWICE",
    "the measure twice project",
    "Measure Twice docs",
    "MEASURE-TWICE",
  ];
  for (const sample of rejected) {
    expect(forbiddenForm(sample), sample).toBeDefined();
  }
  expect(forbiddenForm("measuretwice")).toBeUndefined();
  expect(scannedFiles()).toContain(path.join("packages", "measuretwice", "package.json"));
});
