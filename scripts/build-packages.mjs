#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Assembles the prebuilt Node packages of measuretwice.
 *
 * The script turns the declared NAPI-RS targets into publishable packages:
 *
 * 1. `napi create-npm-dirs` writes one package directory per declared
 *    target under `crates/measuretwice-node/npm/<target>`.
 * 2. Every built binary moves into its target directory. The script searches
 *    the binding crate and one optional `--artifacts` directory, so a
 *    continuous-integration run can collect the binaries of all runners.
 * 3. Every target directory receives the license file.
 * 4. The public package is staged under `build/package/measuretwice` with
 *    the contract schemas and the `optionalDependencies` that select the
 *    native artifact of the installing platform.
 *
 * The staged manifest carries the `optionalDependencies`, because the
 * platform packages do not exist on the registry before the first release.
 * A committed reference to them would break `npm ci` in the workspace. The
 * repository packaging test checks the staged manifest.
 *
 * Run `npm run build` first: the script needs the generated loader, the
 * declarations, the host binary, and the compiled package. Build the release
 * binaries of every declared target with `npm run build:artifacts` or the
 * artifact workflow. The script reports every target without a binary and
 * fails for a missing target when `--require-all` is set.
 */
import { NapiCli, parseTriple } from "@napi-rs/cli";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyBindingIntoPackage } from "./copy-binding.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = path.join(repoRoot, "crates", "measuretwice-node");
const crateNpmDir = path.join(crateDir, "npm");
const publicDir = path.join(repoRoot, "packages", "measuretwice");
const contractsDir = path.join(repoRoot, "contracts", "v0");
const stageDir = path.join(repoRoot, "build", "package", "measuretwice");

/** Parses the command line. */
function options() {
  const parsed = { artifactsDir: null, requireAll: false };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifacts") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--artifacts needs one directory path.");
      }
      parsed.artifactsDir = path.resolve(repoRoot, value);
      index += 1;
    } else if (arg === "--require-all") {
      parsed.requireAll = true;
    } else {
      throw new Error(`Unknown option ${arg}. Use --artifacts <dir> or --require-all.`);
    }
  }
  return parsed;
}

/** Reads and parses one JSON file. */
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** Writes one JSON value with one trailing newline. */
function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Fails with one message on the stderr stream. */
function fail(message) {
  process.stderr.write(`build-packages: ${message}\n`);
  process.exit(1);
}

/** The declared targets of the binding crate, in the declared order. */
function declaredTargets(crateManifest) {
  const triples = crateManifest.napi?.targets;
  if (!Array.isArray(triples) || triples.length === 0) {
    throw new Error("crates/measuretwice-node/package.json declares no napi.targets.");
  }
  return triples.map((triple) => {
    const parsed = parseTriple(triple);
    return { triple, abi: parsed.platformArchABI };
  });
}

/** Finds the built binary of one target in the search directories. */
function findBinary(abi, searchDirs) {
  for (const directory of searchDirs) {
    const candidate = path.join(directory, `index.${abi}.node`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Copies the contract schemas into the public package. */
function copySchemas() {
  const destination = path.join(publicDir, "schemas");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const schemas = readdirSync(contractsDir).filter((name) => name.endsWith(".schema.json"));
  for (const name of schemas) {
    copyFileSync(path.join(contractsDir, name), path.join(destination, name));
  }
  return schemas.length;
}

/**
 * Stages the public package for packing. The staged manifest gains the
 * `optionalDependencies` of the declared targets.
 */
function stagePublicPackage(targets, version) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const manifest = readJson(path.join(publicDir, "package.json"));
  manifest.optionalDependencies = Object.fromEntries(
    targets.map((target) => [`measuretwice-${target.abi}`, version]),
  );
  writeJson(path.join(stageDir, "package.json"), manifest);
  const shipped = ["dist", "schemas", "binding.cjs", "binding.d.cts", "LICENSE", "README.md"];
  for (const entry of shipped) {
    const source = path.join(publicDir, entry);
    if (!existsSync(source)) {
      throw new Error(`The public package is missing ${entry}. Run the build steps first.`);
    }
    cpSync(source, path.join(stageDir, entry), { recursive: true });
  }
}

async function main() {
  const settings = options();
  const crateManifest = readJson(path.join(crateDir, "package.json"));
  const publicManifest = readJson(path.join(publicDir, "package.json"));
  const targets = declaredTargets(crateManifest);

  for (const file of ["index.js", "index.d.ts"]) {
    if (!existsSync(path.join(crateDir, file))) {
      fail(`The generated binding file ${file} is missing. Run \`npm run build:native\` first.`);
    }
  }
  if (!existsSync(path.join(publicDir, "dist", "index.js"))) {
    fail("The compiled package is missing. Run `npm run build:ts` first.");
  }
  if (crateManifest.version !== publicManifest.version) {
    fail(
      `The binding crate version ${crateManifest.version} differs from the public ` +
        `package version ${publicManifest.version}. Align both versions first.`,
    );
  }

  await new NapiCli().createNpmDirs({ cwd: crateDir });

  const searchDirs = [crateDir];
  if (settings.artifactsDir !== null) {
    searchDirs.push(settings.artifactsDir);
  }
  const missing = [];
  for (const target of targets) {
    const targetDir = path.join(crateNpmDir, target.abi);
    const binaryPath = path.join(targetDir, `index.${target.abi}.node`);
    const binary = findBinary(target.abi, searchDirs);
    if (binary === null) {
      missing.push(target);
      rmSync(binaryPath, { force: true });
    } else {
      copyFileSync(binary, binaryPath);
    }
    const targetManifest = readJson(path.join(targetDir, "package.json"));
    if (targetManifest.name !== `measuretwice-${target.abi}`) {
      fail(`The target directory ${target.abi} holds the wrong package name ${targetManifest.name}.`);
    }
    if (targetManifest.version !== publicManifest.version) {
      fail(`The target package ${targetManifest.name} holds version ${targetManifest.version}.`);
    }
    if (!targetManifest.files.includes("LICENSE")) {
      targetManifest.files.push("LICENSE");
    }
    writeJson(path.join(targetDir, "package.json"), targetManifest);
    copyFileSync(path.join(repoRoot, "LICENSE"), path.join(targetDir, "LICENSE"));
  }

  copyBindingIntoPackage();
  const schemaCount = copySchemas();
  stagePublicPackage(targets, publicManifest.version);

  process.stdout.write("assembled packages:\n");
  for (const target of targets) {
    const state = missing.includes(target) ? "missing binary" : "binary ready";
    process.stdout.write(`  measuretwice-${target.abi} (${target.triple}): ${state}\n`);
  }
  process.stdout.write(
    `  measuretwice: staged at build/package/measuretwice with ${schemaCount} schemas\n`,
  );
  if (missing.length > 0) {
    const note =
      "Build the missing binaries with `npm run build:artifacts` where the toolchain exists, " +
      "or collect them with the artifact workflow.";
    if (settings.requireAll) {
      fail(`Missing binaries for: ${missing.map((target) => target.triple).join(", ")}. ${note}`);
    }
    process.stdout.write(`  note: ${note}\n`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
