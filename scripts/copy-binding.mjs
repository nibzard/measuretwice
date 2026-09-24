#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Copies the generated NAPI-RS binding into the public package.
 *
 * `npm run build:native` generates the loader `index.js`, the type
 * declarations `index.d.ts`, and the host binary `index.<target>.node` in
 * `crates/measuretwice-node`. This script places the same three files next
 * to the compiled TypeScript as `binding.cjs`, `binding.d.cts`, and the
 * unchanged binary name. The loader finds the binary beside it in
 * development, and the binary of the matching platform package after
 * installation.
 *
 * Run this script after `napi build`. The root `build:native` command does
 * that for you.
 */
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = path.join(repoRoot, "crates", "measuretwice-node");
const packageDir = path.join(repoRoot, "packages", "measuretwice");

/**
 * Returns the artifact suffix of the build host. The names follow the
 * NAPI-RS platform mapping of the declared targets.
 */
export function hostTarget() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "win32-arm64-msvc" : "win32-x64-msvc";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "linux-arm64-gnu" : "linux-x64-gnu";
  }
  throw new Error(
    `This build host ${process.platform}-${process.arch} is not a declared target. ` +
      "Build on one of the declared targets in DEVELOPING.md.",
  );
}

/**
 * Copies the loader, the declarations, and the host binary into the public
 * package. Throws one clear error when a file is missing.
 */
export function copyBindingIntoPackage() {
  const target = hostTarget();
  const files = [
    ["index.js", "binding.cjs"],
    ["index.d.ts", "binding.d.cts"],
    [`index.${target}.node`, `index.${target}.node`],
  ];
  for (const [source, destination] of files) {
    const sourcePath = path.join(crateDir, source);
    if (!existsSync(sourcePath)) {
      throw new Error(
        `The generated binding file ${source} is missing. ` +
          "Run `npm run build:native` before you use the package.",
      );
    }
    copyFileSync(sourcePath, path.join(packageDir, destination));
  }
  return target;
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const target = copyBindingIntoPackage();
    process.stdout.write(`copied the binding for ${target} into packages/measuretwice\n`);
  } catch (error) {
    process.stderr.write(`copy-binding: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
