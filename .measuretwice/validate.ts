// SPDX-License-Identifier: Apache-2.0
/**
 * The offline validation runner of the development checks.
 *
 * The runner validates every development artifact through the public
 * package and its Rust core, with no evaluator and no provider call:
 *
 * 1. The trusted imports compile against the implemented package, and
 *    `defineChecks` validated both definitions inside this import.
 * 2. The committed JSON exports equal the TypeScript definitions, so the
 *    CLI and the runners read the same artifact.
 * 3. `loadDataset` validates both metadata files, every record line, every
 *    input object against the input schema of its definition, and every
 *    reference label against the meaning of its check.
 * 4. One flagged label conflict fails the validation, because one human
 *    must resolve it before the fixture serves as one reference.
 * 5. Every `runCase` value holds one identifier and one input object alone,
 *    so no reference label, no explanation, and no provenance record can
 *    reach one evaluator request.
 *
 * The runner states the limits of the fixtures on every run: they are
 * development data with agent-proposed, unreviewed labels. They are no
 * independent validation set and no automatic enforcement evidence.
 *
 * Run it with the repository build:
 *
 *   npx tsc -p .measuretwice/tsconfig.json
 *   node .measuretwice/build/validate.js
 *
 * The runner reads local files only. It opens no network connection, reads
 * no credential, writes no file, and spends no API budget.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadDataset,
  type Dataset,
  type Definition,
  type LabelFinding,
  type LabelSummary,
} from "measuretwice";
import { claimEvidence } from "./checks/claim-evidence.js";
import { exampleContract } from "./checks/example-contract.js";

/**
 * The root of the development checks, one level above the compiled module.
 * Pass one explicit `root` when your own build writes elsewhere.
 */
const CHECKS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** One development check with its cases and its definition. */
const CHECKS: readonly {
  readonly name: string;
  readonly definition: Definition;
  readonly metadata: string;
  readonly records: string;
}[] = [
  {
    name: "example-contract",
    definition: exampleContract,
    metadata: "cases/example-contract.metadata.json",
    records: "cases/example-contract.jsonl",
  },
  {
    name: "claim-evidence",
    definition: claimEvidence,
    metadata: "cases/claim-evidence.metadata.json",
    records: "cases/claim-evidence.jsonl",
  },
];

/** The validation of one development check. */
export interface CheckValidation {
  /** The definition name. */
  readonly name: string;
  /** The definition-domain content hash of the validated definition. */
  readonly contentHash: string;
  /** The loaded dataset. Reference labels and provenance stay readable. */
  readonly dataset: Dataset;
  /** The reference outcome counts of the cases: pass, fail, review. */
  readonly outcomes: Readonly<{ pass: number; fail: number; review: number }>;
}

/** The options of one validation run. Every field is optional. */
export interface ValidationOptions {
  /** The root that holds `definitions` and `cases`. Default: this folder. */
  readonly root?: string;
  /** The sink of the printed summary. Default: `console.log`. */
  readonly log?: (text: string) => void;
}

/** The result of one validation run. */
export interface ValidationResult {
  /** The validation of each development check, in declaration order. */
  readonly checks: readonly CheckValidation[];
  /** The label provenance counts of every dataset. */
  readonly labels: readonly LabelSummary[];
  /** The complete printed summary. */
  readonly summary: string;
}

/** Reads one committed export and rejects drift from the TypeScript value. */
async function requireEqualExport(
  root: string,
  name: string,
  definition: Definition,
): Promise<string> {
  const file = path.join(root, "definitions", `${name}.json`);
  const text = await readFile(file, "utf8");
  const exported = JSON.parse(text) as unknown;
  if (JSON.stringify(exported) !== JSON.stringify(definition)) {
    throw new Error(
      `The committed export ${JSON.stringify(file)} differs from the TypeScript definition ${JSON.stringify(name)}. Run node .measuretwice/build/export-definitions.js and commit the result.`,
    );
  }
  const parsed = definition as unknown as { readonly name?: unknown };
  if (parsed.name !== name) {
    throw new Error(
      `The definition name ${JSON.stringify(String(parsed.name))} does not match its file name ${JSON.stringify(name)}.`,
    );
  }
  return file;
}

/** Counts the reference outcomes of one dataset. */
function outcomeCounts(dataset: Dataset): { pass: number; fail: number; review: number } {
  const counts = { pass: 0, fail: 0, review: 0 };
  for (const record of dataset.cases) {
    const outcome = record.expected?.outcome;
    if (outcome === "pass" || outcome === "fail" || outcome === "review") {
      counts[outcome] += 1;
    }
  }
  return counts;
}

/** Rejects one dataset whose flagged label conflicts need one human review. */
function requireNoFindings(name: string, findings: readonly LabelFinding[]): void {
  if (findings.length === 0) {
    return;
  }
  const lines = findings.map(
    (finding) =>
      `  line ${finding.line} ${finding.case_id} ${finding.kind}: ${finding.message}`,
  );
  throw new Error(
    `The dataset ${JSON.stringify(name)} holds ${findings.length} flagged label conflict(s). One human must review them:\n${lines.join("\n")}`,
  );
}

/** Rejects one run-case value that carries one label field across the boundary. */
function requireStrippedCase(dataset: Dataset): void {
  for (const record of dataset.cases) {
    const runCase = dataset.runCase(record);
    const keys = Object.keys(runCase).sort();
    if (keys.length !== 2 || keys[0] !== "id" || keys[1] !== "input") {
      throw new Error(
        `The run case of ${JSON.stringify(record.id)} holds the fields ${keys.join(", ")}. Reference labels and provenance must stay outside every evaluator input.`,
      );
    }
    const text = JSON.stringify(runCase);
    if (text.includes("expected") || text.includes("author_type") || text.includes("reason")) {
      throw new Error(
        `The run case of ${JSON.stringify(record.id)} carries reference-label content. Expected labels and explanations must never reach one evaluator.`,
      );
    }
  }
}

/**
 * Validates both development checks offline.
 *
 * Every failure throws with one message that names the artifact and the
 * next useful action. The Rust core reason codes and field paths of
 * `loadDataset` pass through without change.
 *
 * @returns the loaded datasets, the label provenance counts, and the
 * printed summary.
 */
export async function validateDevelopmentChecks(
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const root = options.root ?? CHECKS_ROOT;
  const log = options.log ?? console.log;
  const lines: string[] = ["Development checks · offline validation", ""];
  const checks: CheckValidation[] = [];
  const labels: LabelSummary[] = [];

  for (const check of CHECKS) {
    // 1. The trusted import already validated the definition through the
    //    core. The committed export must hold the same artifact.
    await requireEqualExport(root, check.name, check.definition);

    // 2. The dataset load validates the metadata, every record line, every
    //    input object, and every reference label through the Rust core.
    const dataset = await loadDataset({
      definition: check.definition,
      metadata: path.join(root, check.metadata),
      records: path.join(root, check.records),
    });

    // 3. The fixtures claim consistency with their checks, so one flagged
    //    conflict fails the validation instead of loading quietly.
    requireNoFindings(check.name, dataset.labels.findings);

    // 4. Every execution path starts from one stripped run case.
    requireStrippedCase(dataset);

    const outcomes = outcomeCounts(dataset);
    const summary = dataset.labels.summary;
    lines.push(
      `${check.name} · ${dataset.cases.length} cases · hash ${dataset.definition.content_hash.slice(0, 12)}`,
      `  References: ${outcomes.pass} pass, ${outcomes.fail} fail, ${outcomes.review} review.`,
      `  Labels: ${summary.labeled} labeled, ${summary.model_unreviewed} model-proposed without one human review, ${summary.human_reviewed} human-reviewed.`,
      `  Dataset ${dataset.identity.dataset_id} revision ${dataset.identity.revision} · ${dataset.identity.kind}.`,
    );
    checks.push({
      name: check.name,
      contentHash: dataset.definition.content_hash,
      dataset,
      outcomes,
    });
    labels.push(summary);
  }

  lines.push(
    "",
    "These fixtures are development data. Their labels are agent-proposed and unreviewed.",
    "They are no independent validation set and support no qualification claim.",
    "Validation ran offline: no evaluator answered, so no live result exists.",
    "The checks change no application action. Enforcement needs one qualified, host-selected profile.",
  );
  const summary = lines.join("\n");
  log(summary);
  return { checks, labels, summary };
}

/** Runs the validation when Node executes this module directly. */
async function main(): Promise<void> {
  await validateDevelopmentChecks();
}

const entry = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entry === import.meta.url) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
