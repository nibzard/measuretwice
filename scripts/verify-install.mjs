#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Clean-installation gate for the prebuilt measuretwice packages.
 *
 * The gate makes one successful native installation a delivery check:
 *
 * 1. It collects the packed tarballs, either with `--packages <dir>` or by
 *    packing the current build outputs itself.
 * 2. It creates one empty project outside the repository, installs the
 *    public tarball and the platform tarball of the build host into it,
 *    and removes every Rust tool from the installation environment first.
 * 3. It copies `scripts/install-check.mjs` into that project and runs it
 *    there. The check exercises the public imports, the exact-rule smoke
 *    case, the module formats, the type declarations, the native artifact
 *    resolution, and the shipped CLI entry.
 *
 * The script needs the registry for the pinned `typebox` dependency of the
 * public package and for learning that platform packages without a local
 * tarball are absent; optional dependencies that resolve to nothing are
 * skipped. It loads measuretwice itself from the packed tarballs only. It
 * needs no credential and runs no provider call.
 *
 * Usage:
 *
 *   node scripts/verify-install.mjs [--packages <dir>] [--require-all] [--keep]
 *
 * Without `--packages`, run `npm run build` and `npm run build:packages`
 * first; the root command `npm run verify:install` does that for you. With
 * `--require-all`, a tarball of every declared target must be present.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { hostTarget } from "./copy-binding.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateNpmDir = path.join(repoRoot, "crates", "measuretwice-node", "npm");
const stageDir = path.join(repoRoot, "build", "package", "measuretwice");
const fixturePath = path.join(repoRoot, "fixtures", "definitions", "valid", "exact-rules.json");
const checkSource = path.join(repoRoot, "scripts", "install-check.mjs");

/** Parses the command line. */
function options() {
  const parsed = { packagesDir: null, requireAll: false, keep: false };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--packages") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--packages needs one directory path.");
      }
      parsed.packagesDir = path.resolve(value);
      index += 1;
    } else if (arg === "--require-all") {
      parsed.requireAll = true;
    } else if (arg === "--keep") {
      parsed.keep = true;
    } else {
      throw new Error(`Unknown option ${arg}. Use --packages <dir>, --require-all, or --keep.`);
    }
  }
  return parsed;
}

/** Fails with one message on the stderr stream. */
function fail(message) {
  process.stderr.write(`verify-install: ${message}\n`);
  process.exit(1);
}

/** Reads one member out of one tar archive buffer, or null when absent. */
function tarMember(buffer, memberName) {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const fullName = prefix === "" ? name : `${prefix}/${name}`;
    const sizeText = header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    if (Number.isNaN(size)) {
      return null;
    }
    const isRegular = header[156] === 0x30 || header[156] === 0;
    if (fullName === memberName && isRegular) {
      return Buffer.from(buffer.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Reads one member out of one `.tgz` file, or null when absent. */
function tarballMember(tarballPath, memberName) {
  return tarMember(gunzipSync(readFileSync(tarballPath)), memberName);
}

/** Returns the sha256 hex digest of one buffer. */
function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Splits one packed file name into its package name and version.
 *
 * The names follow `npm pack`: `measuretwice-0.1.0.tgz` for the public
 * package and `measuretwice-<target>-0.1.0.tgz` for a platform package.
 */
function parseTarballName(fileName) {
  const match = /^measuretwice-(.+)\.tgz$/.exec(fileName);
  if (match === null) {
    return null;
  }
  const rest = match[1];
  if (/^\d+(\.\d+)+$/.test(rest)) {
    return { fileName, name: "measuretwice", version: rest };
  }
  const cut = rest.lastIndexOf("-");
  if (cut === -1) {
    return null;
  }
  const version = rest.slice(cut + 1);
  const abi = rest.slice(0, cut);
  if (!/^\d+(\.\d+)+$/.test(version)) {
    fail(`cannot read a plain version out of ${fileName}.`);
  }
  return { fileName, name: `measuretwice-${abi}`, version, abi };
}

/** Locates the npm command line of the running Node installation. */
function npmCli() {
  const candidates = [];
  const execPath = process.env.npm_execpath ?? "";
  if (execPath.endsWith("npm-cli.js")) {
    candidates.push(execPath);
  }
  const binDir = path.dirname(process.execPath);
  candidates.push(path.join(binDir, "node_modules", "npm", "bin", "npm-cli.js"));
  candidates.push(path.join(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return fail("cannot find npm-cli.js beside the running node executable.");
}

/** Runs npm with one argument list and the given environment. */
function runNpm(args, cwd, env, description) {
  const result = spawnSync(process.execPath, [npmCli(), ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    fail(`${description} failed with status ${result.status}.`);
  }
  return result;
}

/** The Rust executables that must not resolve in the clean environment. */
const RUST_TOOLS = ["cargo", "rustc", "rustup", "rustdoc", "cargo-clippy"];

/**
 * Builds one environment whose `PATH` holds no Rust tooling.
 *
 * Every directory that provides a Rust executable leaves the path, as does
 * every directory of a rustup installation. The probe afterwards proves
 * that no Rust tool resolves anymore.
 */
function rustFreeEnvironment() {
  const removed = [];
  const kept = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry !== "");
  const survivors = kept.filter((entry) => {
    const providesTool = RUST_TOOLS.some(
      (tool) => existsSync(path.join(entry, tool)) || existsSync(path.join(entry, `${tool}.exe`)),
    );
    const isRustDirectory = /(^|[\\/])\.cargo([\\/]|$)/.test(entry) || /rustup/i.test(entry);
    if (providesTool || isRustDirectory) {
      removed.push(entry);
      return false;
    }
    return true;
  });
  const env = {
    ...process.env,
    PATH: survivors.join(path.delimiter),
    npm_config_update_notifier: "false",
  };
  for (const tool of ["cargo", "rustc"]) {
    const probe = spawnSync(tool, ["--version"], { env, encoding: "utf8" });
    if (probe.error?.code !== "ENOENT") {
      fail(
        `cannot remove ${tool} from the installation environment: ` +
          `the probe answered with ${probe.error?.code ?? `status ${probe.status}`}.`,
      );
    }
  }
  return { env, removed };
}

/** Packs the staged public package and every platform package with a binary. */
function packLocalTarballs(destination) {
  if (!existsSync(path.join(stageDir, "package.json"))) {
    fail("the staged public package is missing. Run `npm run build:packages` first.");
  }
  const directories = [stageDir];
  for (const entry of readdirSync(crateNpmDir)) {
    const directory = path.join(crateNpmDir, entry);
    if (
      statSync(directory).isDirectory() &&
      existsSync(path.join(directory, `index.${entry}.node`))
    ) {
      directories.push(directory);
    }
  }
  runNpm(
    ["pack", "--pack-destination", destination, "--loglevel", "error", ...directories],
    repoRoot,
    process.env,
    "packing the assembled packages",
  );
  return destination;
}

/** One platform package tarball under review. */
function reviewPlatformTarball(tarball, publicVersion) {
  const manifest = JSON.parse(tarballMember(tarball.path, "package/package.json") ?? "null");
  if (manifest === null) {
    fail(`${tarball.fileName} holds no package.json.`);
  }
  if (manifest.name !== tarball.name) {
    fail(`${tarball.fileName} names ${manifest.name}.`);
  }
  if (manifest.version !== publicVersion) {
    fail(`${tarball.fileName} holds version ${manifest.version}, not ${publicVersion}.`);
  }
  for (const field of ["os", "cpu"]) {
    if (!Array.isArray(manifest[field]) || manifest[field].length !== 1) {
      fail(`${tarball.fileName} declares no single ${field}.`);
    }
  }
  if (manifest.main !== `index.${tarball.abi}.node`) {
    fail(`${tarball.fileName} mains ${manifest.main}.`);
  }
  if (tarballMember(tarball.path, `package/index.${tarball.abi}.node`) === null) {
    fail(`${tarball.fileName} holds no native binary.`);
  }
}

async function main() {
  const settings = options();
  const host = hostTarget();
  const npmVersion = runNpm(["--version"], repoRoot, process.env, "reading the npm version")
    .stdout.trim();

  const tarDir =
    settings.packagesDir !== null
      ? settings.packagesDir
      : packLocalTarballs(mkdtempSync(path.join(os.tmpdir(), "measuretwice-packed-")));
  if (!existsSync(tarDir)) {
    fail(`the package directory ${tarDir} does not exist.`);
  }

  const tarballs = readdirSync(tarDir)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => {
      const parsed = parseTarballName(name);
      if (parsed === null) {
        fail(`cannot read the package name out of ${name}.`);
      }
      return { ...parsed, path: path.join(tarDir, name) };
    });
  const publicTarball = tarballs.find((tarball) => tarball.name === "measuretwice");
  if (publicTarball === undefined) {
    fail(`the directory ${tarDir} holds no measuretwice tarball.`);
  }
  const publicManifestBuffer = tarballMember(publicTarball.path, "package/package.json");
  if (publicManifestBuffer === null) {
    fail(`${publicTarball.fileName} holds no package.json.`);
  }
  const publicManifest = JSON.parse(publicManifestBuffer.toString("utf8"));
  const declared = Object.keys(publicManifest.optionalDependencies ?? {}).sort();
  if (declared.length === 0) {
    fail(`${publicTarball.fileName} declares no platform packages.`);
  }
  const declaredAbis = declared.map((name) => name.replace(/^measuretwice-/, ""));
  for (const tarball of tarballs) {
    if (tarball.version !== publicTarball.version) {
      fail(`${tarball.fileName} holds version ${tarball.version}, not ${publicTarball.version}.`);
    }
  }

  const hostTarball = tarballs.find((tarball) => tarball.abi === host);
  if (hostTarball === undefined) {
    fail(
      `the directory ${tarDir} holds no measuretwice-${host} tarball for this host. ` +
        "Build the binary with `npm run build:artifacts`, or point --packages at the artifact download.",
    );
  }
  if (settings.requireAll) {
    const missing = declaredAbis.filter((abi) => !tarballs.some((tarball) => tarball.abi === abi));
    if (missing.length > 0) {
      fail(`missing platform tarballs for: ${missing.join(", ")}.`);
    }
  }
  const extra = tarballs
    .filter((tarball) => tarball.abi !== undefined && !declaredAbis.includes(tarball.abi))
    .map((tarball) => tarball.fileName);
  if (extra.length > 0) {
    fail(`undeclared platform tarballs present: ${extra.join(", ")}.`);
  }
  for (const tarball of tarballs) {
    if (tarball.abi !== undefined) {
      reviewPlatformTarball(tarball, publicTarball.version);
    }
  }
  const expectedBinarySha = sha256(
    tarballMember(hostTarball.path, `package/index.${host}.node`) ??
      fail(`${hostTarball.fileName} holds no native binary.`),
  );

  const { env, removed } = rustFreeEnvironment();

  const projectDir = mkdtempSync(path.join(os.tmpdir(), "measuretwice-install-"));
  const tgzDir = path.join(projectDir, "tgz");
  mkdirSync(tgzDir, { recursive: true });
  for (const tarball of [publicTarball, hostTarball]) {
    copyFileSync(tarball.path, path.join(tgzDir, tarball.fileName));
  }
  copyFileSync(fixturePath, path.join(projectDir, "exact-rules.json"));
  copyFileSync(checkSource, path.join(projectDir, "check.mjs"));
  const consumer = {
    name: "measuretwice-install-check",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: {
      measuretwice: `file:tgz/${publicTarball.fileName}`,
      [hostTarball.name]: `file:tgz/${hostTarball.fileName}`,
      typebox: publicManifest.dependencies?.typebox,
    },
  };
  if (typeof consumer.dependencies.typebox !== "string") {
    fail(`${publicTarball.fileName} declares no typebox dependency.`);
  }
  writeFileSync(path.join(projectDir, "package.json"), `${JSON.stringify(consumer, null, 2)}\n`);

  process.stdout.write(`clean installation gate
node ${process.version} on ${process.platform}-${process.arch}, npm ${npmVersion}
tarballs: ${tarDir} (${tarballs.length} packages; declared targets: ${declared.join(", ")})
rust tooling removed from the installation environment: ${removed.length} path entries
project: ${projectDir}
`);

  const install = runNpm(
    ["install", "--no-audit", "--no-fund", "--loglevel", "warn"],
    projectDir,
    env,
    "installing the packed artifacts in the clean environment",
  );
  for (const line of (install.stderr ?? "").split("\n")) {
    if (line.startsWith("npm warn")) {
      process.stdout.write(`  ${line}\n`);
    }
  }

  const check = spawnSync(process.execPath, [path.join(projectDir, "check.mjs"), host, expectedBinarySha], {
    cwd: projectDir,
    env,
    stdio: "inherit",
  });
  if (check.status !== 0) {
    fail(`the clean-installation checks failed with status ${check.status}. The project stays at ${projectDir}.`);
  }

  if (settings.keep) {
    process.stdout.write(`kept the project: ${projectDir}\n`);
  } else {
    rmSync(projectDir, { recursive: true, force: true });
    if (settings.packagesDir === null) {
      rmSync(tarDir, { recursive: true, force: true });
    }
  }
  process.stdout.write("INSTALL_GATE_OK\n");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
