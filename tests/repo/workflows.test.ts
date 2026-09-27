// SPDX-License-Identifier: Apache-2.0
/**
 * Workflow hardening checks.
 *
 * Every action reference in the CI and artifact workflows is pinned to one
 * full commit digest, with one trailing comment that names the upstream revision it came
 * from, so one moved or hijacked tag cannot change what one job runs. The
 * compiler channel stays stable independently of the action digest.
 * The checks also keep the declared
 * minimum Rust version of `Cargo.toml` compiled by its own CI job. They
 * read local files only, so they stay deterministic.
 */
import { test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Reads one repository file as text. */
function read(file: string): string {
  return readFileSync(path.join(repoRoot, file), "utf8");
}

/** Every workflow file of the repository, so one new file joins the rules. */
const WORKFLOWS = readdirSync(path.join(repoRoot, ".github", "workflows"))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => `.github/workflows/${name}`)
  .sort();

/** Every `uses:` reference of one workflow, with its line number. */
function usesReferences(workflow: string): Array<{ line: number; reference: string }> {
  return workflow
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter((entry) => /^\s*-?\s*uses:\s*\S/.test(entry.text))
    .map((entry) => ({
      line: entry.line,
      reference: entry.text.trim().replace(/^-?\s*uses:\s*/, "").split(/\s+/)[0] ?? "",
    }));
}

test("every action reference is pinned to one commit digest", () => {
  for (const file of WORKFLOWS) {
    const workflow = read(file);
    for (const { line, reference } of usesReferences(workflow)) {
      const [, revision] = reference.split("@");
      expect(
        revision !== undefined && /^[0-9a-f]{40}$/.test(revision),
        `${file}:${line} pins ${reference} by something other than one full commit digest`,
      ).toBe(true);
    }
  }
});

test("the pinned references keep their tag comments", () => {
  for (const file of WORKFLOWS) {
    const workflow = read(file);
    for (const line of workflow.split("\n")) {
      if (/^\s*-?\s*uses:\s*\S+@[0-9a-f]{40}/.test(line)) {
        expect(line.trim().match(/#\s*(?:v\d+(?:\.\d+)*|stable)$/), `${file}: ${line.trim()}`).not.toBeNull();
      }
    }
  }
});

test("the declared minimum rust version has its own CI job", () => {
  const manifest = read("Cargo.toml");
  const declared = manifest.match(/^rust-version\s*=\s*"([^"]+)"/m);
  expect(declared, "Cargo.toml states no rust-version").not.toBeNull();
  const workflow = read(".github/workflows/ci.yml");
  expect(workflow).toContain(`toolchain: "${declared![1]}"`);
  // The minimum-version job compiles every target, so test code that
  // needs one newer compiler cannot slip past it.
  expect(workflow).toContain("cargo check --workspace --all-targets");
});
