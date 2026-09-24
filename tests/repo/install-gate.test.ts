// SPDX-License-Identifier: Apache-2.0
/**
 * Clean-installation gate checks.
 *
 * The gate itself installs packages and needs the registry, so it runs as
 * `npm run verify:install` and in the artifact workflow, never inside the
 * ordinary test suites. These offline checks keep the gate wired: the
 * command exists, the check script stays independent of the repository,
 * the workflow requires one clean installation per declared Node version
 * and hosted platform, and the guides document the gate. They read local
 * files only, so they stay deterministic.
 */
import { test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Reads one repository file as text. */
function read(file: string): string {
  return readFileSync(path.join(repoRoot, file), "utf8");
}

test("the root manifest exposes the clean-installation gate", () => {
  const manifest = JSON.parse(read(path.join("package.json"))) as {
    scripts?: Record<string, string>;
  };
  const command = manifest.scripts?.["verify:install"];
  expect(command).toContain("node scripts/verify-install.mjs");
  // The gate packs the current build itself, so it must build first.
  expect(command).toContain("npm run build");
  expect(command).toContain("npm run build:packages");
  expect(existsSync(path.join(repoRoot, "scripts", "verify-install.mjs"))).toBe(true);
  expect(existsSync(path.join(repoRoot, "scripts", "install-check.mjs"))).toBe(true);
});

test("the gate script accepts the workflow options and names the failure modes", () => {
  const source = read(path.join("scripts", "verify-install.mjs"));
  for (const option of ["--packages", "--require-all", "--keep"]) {
    expect(source).toContain(`"${option}"`);
  }
  // The environment must lose its Rust tooling before anything installs.
  expect(source).toContain('"cargo"');
  expect(source).toContain('"rustc"');
});

test("the installation check resolves only installed packages", () => {
  const source = read(path.join("scripts", "install-check.mjs"));
  // The script runs inside one clean project, so every import must resolve
  // from that installation, never from this repository.
  const imports = [...source.matchAll(/^import\s+(?:.*?\sfrom\s+)?"([^"]+)";$/gm)].map(
    (match) => match[1] as string,
  );
  expect(imports.length).toBeGreaterThan(0);
  for (const specifier of imports) {
    expect(
      specifier.startsWith("node:") ||
        specifier === "measuretwice" ||
        specifier === "typebox",
      `${specifier} is not an installed-package import`,
    ).toBe(true);
  }
});

test("the artifact workflow requires one clean installation per declared node version", () => {
  const workflow = read(path.join(".github", "workflows", "build-artifacts.yml"));
  expect(workflow).toContain("node scripts/verify-install.mjs --packages packages --require-all");
  expect(workflow).toContain("needs: packages");
  for (const nodeVersion of ['"20"', '"22"', '"24"']) {
    expect(workflow).toContain(`node: ${nodeVersion}`);
  }
  for (const runner of ["ubuntu-latest", "windows-latest", "macos-latest"]) {
    expect(workflow).toContain(`os: ${runner}`);
  }
  // The darwin-x64 artifact runs through one x64 build of Node on the
  // macOS ARM64 runner.
  expect(workflow).toContain("architecture: x64");
});

test("the guides document the gate and its coverage", () => {
  const testing = read("TESTING.md");
  expect(testing).toContain("npm run verify:install");
  expect(testing).toContain("scripts/verify-install.mjs");
  expect(testing).toContain("install-check.mjs");
  expect(testing).toContain("linux-arm64-gnu");

  const developing = read("DEVELOPING.md");
  expect(developing).toContain("npm run verify:install");
  expect(developing).toContain("scripts/verify-install.mjs");
});
