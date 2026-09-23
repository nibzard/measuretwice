// SPDX-License-Identifier: Apache-2.0
/**
 * CLI behavior tests. They run the compiled entry point, so
 * `npm run build` must run before the tests.
 */
import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const cliPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/cli.js",
);

interface ExecFailure extends Error {
  code?: number;
  stderr?: string;
}

test("--version prints the package version and the contract version", async () => {
  const { stdout } = await execFileAsync("node", [cliPath, "--version"]);
  expect(stdout).toMatch(/^measuretwice \d+\.\d+\.\d+ \(contracts v1\)\n$/);
});

test("--help prints the usage text and exits with code 0", async () => {
  const { stdout } = await execFileAsync("node", [cliPath, "--help"]);
  expect(stdout).toContain("Usage:");
  expect(stdout).toContain("--version");
});

test("an unknown option fails with a message and exit code 2", async () => {
  let failure: ExecFailure | undefined;
  try {
    await execFileAsync("node", [cliPath, "--nope"]);
  } catch (error) {
    failure = error as ExecFailure;
  }
  expect(failure?.code).toBe(2);
  expect(failure?.stderr).toContain("measuretwice:");
});
