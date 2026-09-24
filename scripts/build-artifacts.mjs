#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Builds the release binaries of every declared target this machine can
 * produce.
 *
 * The host target builds natively. The other declared targets build through
 * the zig cross toolchain of the NAPI-RS CLI, which needs one `zig` binary
 * on the path and the Rust standard library of the target. A Windows MSVC
 * binary needs a Windows host, so this script skips it everywhere else. The
 * artifact workflow in `.github/workflows/build-artifacts.yml` builds every
 * declared target on a matching runner. That workflow is the source of
 * truth for the released binaries.
 *
 * Each binary lands in `crates/measuretwice-node` as `index.<target>.node`.
 * Run `npm run build:packages` afterwards to place them into the platform
 * packages.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = path.join(repoRoot, "crates", "measuretwice-node");
const napiCli = path.join(repoRoot, "node_modules", "@napi-rs", "cli", "dist", "cli.js");

/** Reads and parses one JSON file. */
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** The Rust triple of the build host. */
function hostTriple() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  throw new Error(
    `This build host ${process.platform}-${process.arch} is not a declared target.`,
  );
}

/** Runs the NAPI-RS CLI and fails when it fails. */
function runNapi(arguments_) {
  const result = spawnSync(process.execPath, [napiCli, ...arguments_], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`napi ${arguments_.join(" ")} failed with status ${result.status}.`);
  }
}

/** Returns the installed Rust targets, or null when rustup is absent. */
function installedRustTargets() {
  const result = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  return new Set(result.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
}

function main() {
  if (!existsSync(napiCli)) {
    throw new Error("The NAPI-RS CLI is not installed. Run `npm install` first.");
  }
  const targets = readJson(path.join(crateDir, "package.json")).napi?.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("crates/measuretwice-node/package.json declares no napi.targets.");
  }
  const host = hostTriple();
  const zig = spawnSync("zig", ["version"], { encoding: "utf8" }).status === 0;
  const rustTargets = installedRustTargets();

  for (const triple of targets) {
    if (triple === host) {
      process.stdout.write(`building ${triple} natively\n`);
      runNapi([
        "build",
        "--platform",
        "--release",
        "-p",
        "measuretwice-node",
        "--package-json-path",
        "crates/measuretwice-node/package.json",
      ]);
      continue;
    }
    if (triple.includes("-pc-windows-")) {
      process.stdout.write(`skipping ${triple}: it needs a Windows host\n`);
      continue;
    }
    if (!zig) {
      process.stdout.write(`skipping ${triple}: zig is not installed\n`);
      continue;
    }
    if (rustTargets !== null && !rustTargets.has(triple)) {
      process.stdout.write(`skipping ${triple}: run \`rustup target add ${triple}\` first\n`);
      continue;
    }
    process.stdout.write(`building ${triple} through the zig cross toolchain\n`);
    runNapi([
      "build",
      "--platform",
      "--release",
      "-p",
      "measuretwice-node",
      "--package-json-path",
      "crates/measuretwice-node/package.json",
      "--target",
      triple,
      "--cross-compile",
    ]);
  }
  process.stdout.write(
    "done. Run `npm run build:packages` to place the binaries into the platform packages.\n",
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`build-artifacts: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}
