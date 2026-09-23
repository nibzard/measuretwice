#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * measuretwice command-line interface.
 *
 * Development build. The `validate`, `run`, `calibrate`, `evaluate`,
 * `compare`, and `inspect` commands are specified in MVP_SPEC.md section 11
 * but not implemented yet. This entry point establishes parsing, help text,
 * output, and exit behavior only.
 */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { contractVersion } from "./index.js";

const USAGE = `measuretwice — semantic checks with measured reliability

Usage:
  measuretwice --version
  measuretwice --help

Development build. No check commands are implemented yet.
Specified commands: validate, run, calibrate, evaluate, compare, inspect.

Options:
  --version   Print the package version and the contract schema version.
  --help      Print this help text.
`;

function fail(message: string): never {
  process.stderr.write(`measuretwice: ${message}\n`);
  process.exit(2);
}

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

let args;
try {
  args = parseArgs({
    options: {
      version: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (args.values.version) {
  process.stdout.write(
    `measuretwice ${packageJson.version} (contracts v${contractVersion()})\n`,
  );
  process.exit(0);
}

if (args.values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

process.stdout.write(USAGE);
process.exit(0);
