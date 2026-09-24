// SPDX-License-Identifier: Apache-2.0
/**
 * The trusted export script of the intervention review example.
 *
 * The CLI reads JSON data files and executes no TypeScript source, so one
 * host that wants the CLI, one inspection tool, or another language
 * exports the portable definition. This script is application code that
 * you review: it serializes the result of `defineChecks` and writes it
 * through the Node file APIs. The content hash covers the canonical
 * content, so JSON formatting changes no hash.
 *
 * Run it with your own build:
 *
 *   npx tsc -p examples/intervention-review/tsconfig.json
 *   node examples/intervention-review/build/export-definition.js
 *
 * The script reads local files only. It opens no network connection and
 * reads no credential.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { intervention } from "./checks/intervention.js";

/**
 * The root of the example, one level above the compiled module. Pass one
 * explicit `out` path when your own build writes elsewhere.
 */
const EXAMPLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The options of one export. Every field is optional. */
export interface ExportOptions {
  /** The output path of the JSON artifact. Default: `definitions/intervention-review.json`. */
  readonly out?: string;
}

/**
 * Writes the portable definition of the example as one JSON artifact.
 *
 * The exported value is the validated definition itself, so
 * `measuretwice validate`, `run`, and every wrapper read the same artifact
 * that the host imported.
 *
 * @returns the path of the written artifact.
 */
export async function exportDefinition(options: ExportOptions = {}): Promise<string> {
  const out = options.out ?? path.join(EXAMPLE_ROOT, "definitions", "intervention-review.json");
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(intervention, null, 2)}\n`, "utf8");
  return out;
}

/** Runs the export when Node executes this module directly. */
async function main(): Promise<void> {
  const out = await exportDefinition();
  process.stdout.write(`Wrote ${out}\n`);
}

const entry = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entry === import.meta.url) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
