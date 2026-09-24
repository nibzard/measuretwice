// SPDX-License-Identifier: Apache-2.0
/**
 * The trusted export script of the development checks.
 *
 * The CLI reads JSON data files and executes no TypeScript source. This
 * script is repository code that you review: it serializes the result of
 * `defineChecks` and writes the committed artifacts through the Node file
 * APIs. The content hash covers the canonical content, so JSON formatting
 * changes no hash. The committed artifacts stay equal to the TypeScript
 * definitions, and the offline validation checks that equality.
 *
 * Run it with the repository build:
 *
 *   npx tsc -p .measuretwice/tsconfig.json
 *   node .measuretwice/build/export-definitions.js
 *
 * The script reads local files only. It opens no network connection, reads
 * no credential, and spends no API budget.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claimEvidence } from "./checks/claim-evidence.js";
import { exampleContract } from "./checks/example-contract.js";

/**
 * The root of the development checks, one level above the compiled module.
 * Pass one explicit `out` path when your own build writes elsewhere.
 */
const CHECKS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** One exported definition: its file name and its TypeScript value. */
const EXPORTS = [
  { name: "example-contract", definition: exampleContract },
  { name: "claim-evidence", definition: claimEvidence },
] as const;

/** The options of one export. Every field is optional. */
export interface ExportOptions {
  /** The output directory. Default: `definitions` inside the checks root. */
  readonly out?: string;
}

/**
 * Writes the portable definitions of the development checks as JSON
 * artifacts.
 *
 * The exported value is the validated definition itself, so
 * `measuretwice validate`, every inspection tool, and future wrappers read
 * the same artifact that the runners import.
 *
 * @returns the path of every written artifact, in export order.
 */
export async function exportDefinitions(options: ExportOptions = {}): Promise<readonly string[]> {
  const out = options.out ?? path.join(CHECKS_ROOT, "definitions");
  await mkdir(out, { recursive: true });
  const written: string[] = [];
  for (const entry of EXPORTS) {
    const file = path.join(out, `${entry.name}.json`);
    await writeFile(file, `${JSON.stringify(entry.definition, null, 2)}\n`, "utf8");
    written.push(file);
  }
  return written;
}

/** Runs the export when Node executes this module directly. */
async function main(): Promise<void> {
  const written = await exportDefinitions();
  for (const file of written) {
    process.stdout.write(`Wrote ${file}\n`);
  }
}

const entry = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entry === import.meta.url) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
