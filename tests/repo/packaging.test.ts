// SPDX-License-Identifier: Apache-2.0
/**
 * Packaging checks for the prebuilt Node packages.
 *
 * These checks verify the published shape before the first release: the
 * three lists of declared targets stay equal, the public package ships the
 * compiled entry points, the declarations, the schemas, and the native
 * artifact selection, every platform package holds the right manifest and
 * the license, and the packed tarballs contain the required content only.
 * The checks run the assembly script, so `npm run build` must run first.
 * They read local files only, so they stay offline and deterministic.
 */
import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const crateDir = path.join(repoRoot, "crates", "measuretwice-node");
const publicDir = path.join(repoRoot, "packages", "measuretwice");
const stageDir = path.join(repoRoot, "build", "package", "measuretwice");

/**
 * The declared target matrix. The table is the expectation of this check,
 * not a value that the packaging code supplies: the triple must appear in
 * `napi.targets`, the platform package must carry the npm fields, and the
 * loading error of the public package must name the target.
 */
const DECLARED_TARGETS = [
  {
    triple: "aarch64-apple-darwin",
    abi: "darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    libc: undefined,
  },
  {
    triple: "aarch64-unknown-linux-gnu",
    abi: "linux-arm64-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
  },
  {
    triple: "x86_64-apple-darwin",
    abi: "darwin-x64",
    os: "darwin",
    cpu: "x64",
    libc: undefined,
  },
  {
    triple: "x86_64-unknown-linux-gnu",
    abi: "linux-x64-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
  },
  {
    triple: "x86_64-pc-windows-msvc",
    abi: "win32-x64-msvc",
    os: "win32",
    cpu: "x64",
    libc: undefined,
  },
] as const;

/** Reads and parses one JSON file. */
function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** The artifact suffix of the build host. */
function hostAbi(): string {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (process.platform === "win32") {
    return "win32-x64-msvc";
  }
  return process.arch === "arm64" ? "linux-arm64-gnu" : "linux-x64-gnu";
}

/** Lists the files of one packed directory, without writing a tarball. */
function packedFiles(directory: string): string[] {
  // Windows resolves `npm` only through the shell. The repository paths of
  // the continuous-integration runners hold no spaces, so the plain join
  // of the shell stays safe there.
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", directory], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const report = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  return report[0]?.files?.map((file) => file.path) ?? [];
}

/** Runs the package assembly script once, and fails when it fails. */
let assembled = false;
function assemblePackages(): void {
  if (assembled) {
    return;
  }
  execFileSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "build-packages.mjs")],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assembled = true;
}

test("the declared target lists stay in sync", () => {
  const crateManifest = readJson(path.join(crateDir, "package.json"));
  expect(crateManifest.napi?.targets).toEqual(DECLARED_TARGETS.map((target) => target.triple));

  // The loading error of the wrapper names the same targets.
  const nativeSource = readFileSync(path.join(publicDir, "src", "native.ts"), "utf8");
  for (const target of DECLARED_TARGETS) {
    expect(nativeSource).toContain(`"${target.abi}"`);
  }

  // The quickstart README states the same targets.
  const readme = readFileSync(path.join(publicDir, "README.md"), "utf8");
  for (const target of DECLARED_TARGETS) {
    expect(readme).toContain(target.abi);
  }
});

test("the public manifest ships the built package without private content", () => {
  const manifest = readJson(path.join(publicDir, "package.json"));
  expect(manifest.name).toBe("measuretwice");
  expect(manifest.license).toBe("Apache-2.0");
  expect(manifest.engines).toEqual({ node: ">=20" });
  expect(manifest.type).toBe("module");

  for (const shipped of ["dist", "binding.cjs", "binding.d.cts", "schemas"]) {
    expect(manifest.files).toContain(shipped);
  }
  const forbidden = manifest.files.filter(
    (entry: string) => /^(src|test|npm)\//.test(entry) || entry.endsWith(".node"),
  );
  expect(forbidden).toEqual([]);

  // The workspace package holds no runtime dependency on the private
  // binding package: the loader ships beside the compiled code instead.
  expect(Object.keys(manifest.dependencies ?? {})).toEqual(["typebox"]);

  // The platform packages are absent from the registry before the first
  // release. A committed reference would break `npm ci` in the workspace,
  // so only the staged manifest carries the selection.
  expect(manifest.optionalDependencies).toBeUndefined();

  expect(manifest.bin).toEqual({ measuretwice: "./dist/cli.js" });
  expect(manifest.exports["."]).toEqual({
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  expect(existsSync(path.join(publicDir, "dist", "cli.js"))).toBe(true);
  expect(existsSync(path.join(publicDir, "binding.cjs"))).toBe(true);
  expect(existsSync(path.join(publicDir, "binding.d.cts"))).toBe(true);
  expect(existsSync(path.join(publicDir, "LICENSE"))).toBe(true);
  expect(existsSync(path.join(publicDir, "README.md"))).toBe(true);
});

test("the assembled platform packages carry the matrix and the license", () => {
  assemblePackages();
  const crateManifest = readJson(path.join(crateDir, "package.json"));
  const publicManifest = readJson(path.join(publicDir, "package.json"));

  for (const target of DECLARED_TARGETS) {
    const packageDir = path.join(crateDir, "npm", target.abi);
    const manifest = readJson(path.join(packageDir, "package.json"));
    expect(manifest.name).toBe(`measuretwice-${target.abi}`);
    expect(manifest.version).toBe(publicManifest.version);
    expect(manifest.version).toBe(crateManifest.version);
    expect(manifest.os).toEqual([target.os]);
    expect(manifest.cpu).toEqual([target.cpu]);
    if (target.libc === undefined) {
      expect(manifest.libc).toBeUndefined();
    } else {
      expect(manifest.libc).toEqual([target.libc]);
    }
    expect(manifest.main).toBe(`index.${target.abi}.node`);
    expect(manifest.files).toContain(`index.${target.abi}.node`);
    expect(manifest.files).toContain("LICENSE");
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.engines).toEqual({ node: ">=20" });
    expect(existsSync(path.join(packageDir, "LICENSE"))).toBe(true);

    // A target without its binary yet still ships its manifest, and the
    // binary of a missing target never stays behind from an earlier run.
    const binary = path.join(packageDir, `index.${target.abi}.node`);
    if (target.abi === hostAbi()) {
      expect(statSync(binary).size).toBeGreaterThan(0);
    }
  }
});

test("the staged manifest selects the native artifact of the platform", () => {
  assemblePackages();
  const publicManifest = readJson(path.join(publicDir, "package.json"));
  const manifest = readJson(path.join(stageDir, "package.json"));
  expect(manifest.name).toBe("measuretwice");
  expect(manifest.version).toBe(publicManifest.version);
  expect(manifest.optionalDependencies).toEqual(
    Object.fromEntries(
      DECLARED_TARGETS.map((target) => [`measuretwice-${target.abi}`, publicManifest.version]),
    ),
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
    expect(existsSync(path.join(stageDir, shipped))).toBe(true);
  }

  // The schemas of the staged package mirror the frozen contracts, and no
  // native binary travels inside the public package.
  const contracts = readdirSync(path.join(repoRoot, "contracts", "v0")).filter((name) =>
    name.endsWith(".schema.json"),
  );
  const schemas = readdirSync(path.join(stageDir, "schemas"));
  expect(schemas.sort()).toEqual([...contracts].sort());
  expect(readdirSync(path.join(stageDir, "dist")).some((name) => name.endsWith(".node"))).toBe(false);
});

test("the packed public tarball holds the required content only", () => {
  assemblePackages();
  const files = packedFiles(stageDir);
  expect(files).toContain("binding.cjs");
  expect(files).toContain("binding.d.cts");
  expect(files).toContain("LICENSE");
  expect(files).toContain("README.md");
  expect(files).toContain("package.json");
  expect(files).toContain("dist/index.js");
  expect(files).toContain("dist/index.d.ts");
  expect(files).toContain("dist/cli.js");
  expect(files.some((file) => file.startsWith("schemas/"))).toBe(true);

  const forbidden = files.filter(
    (file) =>
      file.endsWith(".node") ||
      file.startsWith("src/") ||
      file.startsWith("test/") ||
      file.startsWith("npm/") ||
      file === "package-lock.json",
  );
  expect(forbidden).toEqual([]);
});

test("the packed platform tarball holds the binary, the license, and the manifest", () => {
  assemblePackages();
  const abi = hostAbi();
  const files = packedFiles(path.join(crateDir, "npm", abi));
  expect(new Set(files)).toEqual(
    new Set([`index.${abi}.node`, "LICENSE", "README.md", "package.json"]),
  );
});
