#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Public-import checks inside one clean installation of measuretwice.
 *
 * `scripts/verify-install.mjs` copies this file into a temporary project
 * that installed the packed tarballs, then runs it there. Resolution must
 * see that project only: run from the repository, the package name would
 * resolve to the development workspace link instead of the installation.
 *
 * The script exercises the package the way a user does: the public
 * ECMAScript module entry, the exact-rule smoke case, the type
 * declarations, the shipped command-line entry, and the native artifact
 * of the installing platform. It exits with status 0 only when every
 * expectation holds. It reads local files only and needs no credential.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { defineChecks, load } from "measuretwice";

const [abi, expectedBinarySha] = process.argv.slice(2);
if (abi === undefined || expectedBinarySha === undefined) {
  process.stderr.write("install-check: expected <target-abi> <sha256> arguments.\n");
  process.exit(2);
}

const problems = [];

/** Records one failed expectation. */
function expect(condition, message) {
  if (!condition) {
    problems.push(message);
  }
}

/** The fixed terminal time of the run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** Load options pinned to the fixed clock and one fresh identifier sequence. */
function options() {
  let next = 0;
  return {
    now: () => START_MS,
    nextRunId: () => `run-${String(++next).padStart(6, "0")}`,
  };
}

// The exact-rule smoke case, through both public authoring paths.
const typed = defineChecks({
  version: 1,
  name: "delivery-limits",
  inputs: Type.Object(
    {
      summary: Type.String({ minLength: 1 }),
      notice: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "summary-length",
      name: "The summary fits the delivery limit",
      using: ["summary"],
      rule: { maxLength: 80 },
    },
    {
      id: "summary-mentions-limit",
      name: "The summary states the delivery limit",
      using: ["summary"],
      rule: { includes: "delivery limit" },
    },
    {
      id: "notice-hides-secrets",
      name: "The notice contains no secret marker",
      using: ["notice"],
      rule: { excludes: "SECRET" },
    },
  ],
});

const caseInput = {
  id: "install-check-case",
  input: {
    summary: "The delivery limit is 900 characters",
    notice: "One notice.",
  },
};

const typedReviewer = await load(typed, options());
const jsonReviewer = await load(
  fileURLToPath(new URL("./exact-rules.json", import.meta.url)),
  options(),
);
const typedReport = await typedReviewer.run(caseInput);
const jsonReport = await jsonReviewer.run(caseInput);

const definitionHash = typedReviewer.definitionHash;
expect(
  definitionHash === jsonReviewer.definitionHash,
  "the TypeBox artifact and the exported JSON hash differently",
);
expect(
  JSON.stringify(typedReport) === JSON.stringify(jsonReport),
  "the two authoring paths serialized different reports",
);
expect(
  typedReport.aggregate.outcome === "pass",
  `the aggregate outcome is ${typedReport.aggregate.outcome}, not pass`,
);
expect(
  typedReport.completion.status === "completed",
  `the completion status is ${typedReport.completion.status}, not completed`,
);

// The installed package shape.
const requireHere = createRequire(import.meta.url);
const packageJsonPath = fileURLToPath(import.meta.resolve("measuretwice/package.json"));
const packageDir = path.dirname(packageJsonPath);
const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));

expect(manifest.type === "module", "the installed package is not an ECMAScript module package");
const entry = manifest.exports?.["."];
expect(
  JSON.stringify(Object.keys(entry ?? {}).sort()) === JSON.stringify(["import", "types"]),
  `the package entry exports ${JSON.stringify(Object.keys(entry ?? {}))}, not import and types`,
);
expect(entry?.import === "./dist/index.js", "the import condition does not name dist/index.js");
expect(entry?.types === "./dist/index.d.ts", "the types condition does not name dist/index.d.ts");
expect(
  JSON.stringify(manifest.bin ?? {}) === JSON.stringify({ measuretwice: "./dist/cli.js" }),
  "the bin entry does not name dist/cli.js",
);

for (const shipped of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/cli.js",
  "binding.cjs",
  "binding.d.cts",
  "LICENSE",
  "README.md",
  "package.json",
]) {
  expect(existsSync(path.join(packageDir, shipped)), `the installation is missing ${shipped}`);
}
expect(
  readdirSync(path.join(packageDir, "schemas")).some((name) => name.endsWith(".schema.json")),
  "the installation ships no contract schema",
);

const entries = readdirSync(packageDir).sort();
expect(
  JSON.stringify(entries) ===
    JSON.stringify(["LICENSE", "README.md", "binding.cjs", "binding.d.cts", "dist", "package.json", "schemas"]),
  `the installed package holds unexpected entries: ${entries.join(", ")}`,
);

/** Collects every file below one directory, relative to it. */
function filesBelow(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push(path.relative(directory, full));
      }
    }
  };
  walk(directory);
  return files;
}

const shipped = filesBelow(packageDir);
expect(
  shipped.every((file) => !file.endsWith(".node")),
  `the public package ships native binaries: ${shipped.filter((file) => file.endsWith(".node")).join(", ")}`,
);
expect(
  shipped.every((file) => !file.startsWith(`test${path.sep}`) && !file.startsWith(`src${path.sep}`)),
  "the public package ships private sources or tests",
);

// Module formats: the import above worked, so the CommonJS require of the
// package must fail for the documented reason.
let requireFailure = null;
try {
  requireHere("measuretwice");
} catch (error) {
  requireFailure = error;
}
expect(
  requireFailure !== null,
  "require('measuretwice') resolved although the package ships ECMAScript modules only",
);
const requireCode = requireFailure?.code ?? "";
expect(
  requireCode === "ERR_PACKAGE_PATH_NOT_EXPORTED" || requireCode === "ERR_REQUIRE_ESM",
  `require('measuretwice') failed with ${requireCode || String(requireFailure?.message)}`,
);

// Native artifact resolution: the loader must answer with the binary of the
// platform package, not with one beside the public package.
const requireFromPackage = createRequire(packageJsonPath);
const binaryPath = requireFromPackage.resolve(`measuretwice-${abi}`);
expect(
  binaryPath ===
    path.join(path.dirname(packageDir), `measuretwice-${abi}`, `index.${abi}.node`) ||
    binaryPath.endsWith(path.join(`measuretwice-${abi}`, `index.${abi}.node`)),
  `the binding resolved ${binaryPath}`,
);
expect(
  !binaryPath.startsWith(packageDir + path.sep),
  "the binding loaded a binary inside the public package",
);
const platformDir = path.dirname(binaryPath);
const platformManifest = JSON.parse(readFileSync(path.join(platformDir, "package.json"), "utf8"));
expect(
  platformManifest.name === `measuretwice-${abi}`,
  `the platform package names ${platformManifest.name}`,
);
expect(
  platformManifest.version === manifest.version,
  `the platform package version ${platformManifest.version} differs from ${manifest.version}`,
);
const binarySha = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
expect(
  binarySha === expectedBinarySha,
  `the loaded binary hashes ${binarySha}, the packed artifact hashes ${expectedBinarySha}`,
);

// The shipped command-line entry runs from the installed tree.
const cli = spawnSync(process.execPath, [path.join(packageDir, "dist", "cli.js"), "--version"], {
  encoding: "utf8",
});
expect(cli.status === 0, `the shipped CLI exited with status ${cli.status}`);
expect(
  (cli.stdout ?? "").startsWith(`measuretwice ${manifest.version} (contracts v`),
  `the shipped CLI printed ${JSON.stringify(cli.stdout ?? "")}`,
);

process.stdout.write(`clean install: node ${process.version} on ${process.platform}-${process.arch}
measuretwice ${manifest.version} at ${packageDir}
module format: ECMAScript module import ok; require rejected with ${requireCode || "an error"}
type declarations: dist/index.d.ts and binding.d.cts present
native artifact: measuretwice-${abi} (${binarySha.slice(0, 16)}…) matches the packed binary
cli --version: ${(cli.stdout ?? "").trim()}
definition content hash: ${definitionHash}
TypeBox authoring and exported JSON agree: ${definitionHash === jsonReviewer.definitionHash ? "yes" : "no"}
rule outcomes: ${typedReport.checks.map((record) => `${record.check} ${record.outcome}`).join(", ")}
aggregate outcome: ${typedReport.aggregate.outcome}
completion: ${typedReport.completion.status} at ${typedReport.completion.completed_at}
`);

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`install-check: ${problem}.\n`);
  }
  process.exit(1);
}
process.stdout.write("INSTALL_OK\n");
