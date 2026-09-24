// SPDX-License-Identifier: Apache-2.0
/**
 * The offline validation runner of the public synthetic challenge set.
 *
 * The runner validates the challenge dataset of MVP_SPEC.md section 13
 * through the public package and its Rust core, with no evaluator and no
 * provider call:
 *
 * 1. `loadDataset` validates the metadata, every record line, every input
 *    object against the input schema of the flagship definition, and every
 *    reference label against the meaning of its check.
 * 2. One flagged label conflict fails the validation, because one human
 *    must resolve it before the challenge set serves as one reference.
 * 3. Every `runCase` value holds one identifier and one input object alone,
 *    so no reference label, no explanation, and no provenance record can
 *    reach one evaluator request.
 * 4. Every label stays one unreviewed model proposal until one human
 *    reviews it, so the provenance counts must state exactly that.
 * 5. One declared split holds every group, and every required challenge
 *    slice occurs: the nine behaviors of the specification, the consequence
 *    levels, and every declared language.
 * 6. The core classifies the challenge split, so the summary states what
 *    the kind of the dataset permits: one public challenge measures
 *    behavior, never production reliability.
 *
 * The runner states the limits of the set on every run: it is one public
 * synthetic challenge, not one representative sample. It states no
 * prevalence, supports no qualification claim, and measures no model.
 *
 * Run it with the repository build:
 *
 *   npx tsc -p examples/intervention-challenge/tsconfig.json
 *   node examples/intervention-challenge/build/validate.js
 *
 * The runner reads local files only. It opens no network connection, reads
 * no credential, writes no file, and spends no API budget.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyValidationEvidence,
  loadDataset,
  type Dataset,
  type LabelFinding,
  type LabelSummary,
  type ValidationEvidence,
} from "measuretwice";

/**
 * The root of the example, one level above the compiled module. Pass one
 * explicit `root` when your own build writes elsewhere.
 */
const EXAMPLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The name of the definition that the challenge set binds to. */
const DEFINITION_NAME = "intervention-review";

/** The split identifier that the dataset metadata declares. */
const SPLIT_ID = "challenge";

/** The challenge behaviors that MVP_SPEC.md section 13 lists. */
const BEHAVIOR_SLICES: readonly string[] = [
  "decision-vs-suggestion",
  "negation",
  "attribution",
  "intentional-change",
  "delayed-correction",
  "duplicate-concern",
  "partial-support",
  "missing-context",
  "embedded-instruction",
];

/** The consequence slices: the three declared levels and the unresolved marker. */
const CONSEQUENCE_SLICES: readonly string[] = [
  "consequence-minor",
  "consequence-meaningful",
  "consequence-serious",
  "consequence-unresolved",
];

/** The result of one validation run. */
export interface ChallengeValidation {
  /** The loaded challenge dataset with its reference labels and provenance. */
  readonly dataset: Dataset;
  /** The definition that validated every input object. */
  readonly definition: Readonly<{ readonly name: string; readonly content_hash: string }>;
  /** The reference outcome counts of the cases: pass, fail, review. */
  readonly outcomes: Readonly<{ pass: number; fail: number; review: number }>;
  /** The case count of every slice tag, ordered by tag. */
  readonly slices: Readonly<Record<string, number>>;
  /** The evidence classification of the challenge split. */
  readonly evidence: ValidationEvidence;
  /** The complete printed summary. */
  readonly summary: string;
}

/** The options of one validation run. Every field is optional. */
export interface ValidationOptions {
  /** The root that holds `cases`. Default: this folder. */
  readonly root?: string;
  /** The sink of the printed summary. Default: `console.log`. */
  readonly log?: (text: string) => void;
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

/** Counts the cases of every slice tag, ordered by tag. */
function sliceCounts(dataset: Dataset): Record<string, number> {
  const counts = new Map<string, number>();
  for (const record of dataset.cases) {
    for (const tag of record.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort(([one], [other]) => one.localeCompare(other)));
}

/** Rejects one dataset whose flagged label conflicts need one human review. */
function requireNoFindings(findings: readonly LabelFinding[]): void {
  if (findings.length === 0) {
    return;
  }
  const lines = findings.map(
    (finding) =>
      `  line ${finding.line} ${finding.case_id} ${finding.kind}: ${finding.message}`,
  );
  throw new Error(
    `The challenge dataset holds ${findings.length} flagged label conflict(s). One human must review them:\n${lines.join("\n")}`,
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
 * Rejects one label provenance that no unreviewed model proposal states.
 *
 * The dataset ships with agent-proposed labels. Task T063 records the human
 * review, so until then every label states one model author and no review.
 */
function requireUnreviewedModelLabels(summary: LabelSummary): void {
  const problems: string[] = [];
  if (summary.labeled !== summary.model_unreviewed) {
    problems.push(
      `${summary.labeled - summary.model_unreviewed} labeled record(s) state one reviewed or human-written reference.`,
    );
  }
  if (summary.human_reviewed !== 0 || summary.human_unreviewed !== 0) {
    problems.push("one record states one human author.");
  }
  if (problems.length > 0) {
    throw new Error(
      `The challenge dataset records one human review or one human author: ${problems.join(" ")}. Record the review in each label record when one human reviews the labels.`,
    );
  }
}

/** Rejects one dataset whose groups leave the declared challenge split. */
function requireSingleChallengeSplit(dataset: Dataset): void {
  const split = dataset.splits.find((entry) => entry.split === SPLIT_ID);
  if (dataset.splits.length !== 1 || split === undefined) {
    throw new Error(
      `The challenge dataset declares ${dataset.splits.length} splits. It states one split ${JSON.stringify(SPLIT_ID)} alone.`,
    );
  }
  if (dataset.identity.unassigned_groups.length > 0) {
    const groups = dataset.identity.unassigned_groups.map((group) => group.group);
    throw new Error(
      `The challenge dataset holds groups that no split declares: ${groups.join(", ")}. One revision must assign every group.`,
    );
  }
  for (const assignment of dataset.identity.group_assignments) {
    if (assignment.split_id !== SPLIT_ID) {
      throw new Error(
        `The group ${assignment.group} belongs to the split ${assignment.split_id}. Every group belongs to the split ${SPLIT_ID}.`,
      );
    }
  }
}

/** Rejects one dataset that misses one required slice of the specification. */
function requireSliceCoverage(dataset: Dataset, slices: Readonly<Record<string, number>>): void {
  const missing: string[] = [];
  for (const tag of BEHAVIOR_SLICES) {
    if ((slices[tag] ?? 0) === 0) {
      missing.push(tag);
    }
  }
  for (const tag of CONSEQUENCE_SLICES) {
    if ((slices[tag] ?? 0) === 0) {
      missing.push(tag);
    }
  }
  for (const language of dataset.metadata.languages ?? []) {
    if ((slices[`language-${language}`] ?? 0) === 0) {
      missing.push(`language-${language}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `The challenge dataset covers no case of ${missing.length} required slice(s): ${missing.join(", ")}. Add one case for each, then raise the revision.`,
    );
  }
}

/**
 * Validates the public synthetic challenge set offline.
 *
 * Every failure throws with one message that names the artifact and the
 * next useful action. The Rust core reason codes and field paths of
 * `loadDataset` pass through without change.
 *
 * @returns the loaded dataset, the outcome and slice counts, the evidence
 * classification of the challenge split, and the printed summary.
 */
export async function validateChallengeDataset(
  options: ValidationOptions = {},
): Promise<ChallengeValidation> {
  const root = options.root ?? EXAMPLE_ROOT;
  const log = options.log ?? console.log;

  // 1. The dataset load validates the metadata, every record line, every
  //    input object, and every reference label through the Rust core. The
  //    challenge set binds to the committed portable export of the
  //    flagship definition, so it consumes no TypeScript source.
  const dataset = await loadDataset({
    definition: path.join(
      root,
      "..",
      "intervention-review",
      "definitions",
      `${DEFINITION_NAME}.json`,
    ),
    metadata: path.join(root, "cases", "intervention-challenge.metadata.json"),
    records: path.join(root, "cases", "intervention-challenge.jsonl"),
  });
  if (dataset.definition.name !== DEFINITION_NAME) {
    throw new Error(
      `The challenge dataset loaded against the definition ${JSON.stringify(dataset.definition.name)}. It binds to ${JSON.stringify(DEFINITION_NAME)}.`,
    );
  }

  // 2. The challenge cases claim consistency with their checks, so one
  //    flagged conflict fails the validation instead of loading quietly.
  requireNoFindings(dataset.labels.findings);

  // 3. Every execution path starts from one stripped run case.
  requireStrippedCase(dataset);

  // 4. The provenance states one unreviewed model proposal for every label.
  requireUnreviewedModelLabels(dataset.labels.summary);

  // 5. One declared split holds every group, and the required slices occur.
  requireSingleChallengeSplit(dataset);
  const outcomes = outcomeCounts(dataset);
  const slices = sliceCounts(dataset);
  requireSliceCoverage(dataset, slices);

  // 6. The core classifies the challenge split: one targeted challenge set
  //    supports no qualification claim, whatever its size.
  const split = dataset.splits.find((entry) => entry.split === SPLIT_ID);
  const evidence = classifyValidationEvidence(split!, dataset.identity);

  const summaryLabels = dataset.labels.summary;
  const languageLine = (dataset.metadata.languages ?? [])
    .map((language) => `${language} ${slices[`language-${language}`] ?? 0}`)
    .join(", ");
  const sliceLine = Object.entries(slices)
    .map(([tag, count]) => `  ${tag} ${count}`)
    .join("\n");
  const lines: string[] = [
    "Public synthetic challenge set · offline validation",
    "",
    `Definition ${dataset.definition.name} · hash ${dataset.definition.content_hash.slice(0, 12)}.`,
    `Dataset ${dataset.identity.dataset_id} revision ${dataset.identity.revision} · ${dataset.identity.kind}.`,
    `Population statement: ${dataset.identity.population} · prevalence: ${dataset.identity.states_prevalence ? "yes" : "none"}.`,
    `${dataset.identity.record_count} records in ${dataset.identity.group_assignments.length} groups · split ${SPLIT_ID} (${dataset.splits[0]?.purpose}).`,
    `References: ${outcomes.pass} pass, ${outcomes.fail} fail, ${outcomes.review} review.`,
    `Labels: ${summaryLabels.labeled} labeled, ${summaryLabels.model_unreviewed} model-proposed without one human review, ${summaryLabels.human_reviewed} human-reviewed.`,
    "Slices:",
    sliceLine,
    `Languages: ${languageLine}.`,
    `Evidence: ${evidence.statement}`,
    "",
    "This set is one public synthetic challenge, not one representative sample.",
    "It states no prevalence and supports no qualification claim.",
    "Production qualification needs one representative sample of the intended deployment.",
    "Every label is one agent proposal. Review the labels, then record the reviewer in each label record.",
    "Validation ran offline: no evaluator answered, so this run measures no model.",
  ];
  const summary = lines.join("\n");
  log(summary);
  return {
    dataset,
    definition: dataset.definition,
    outcomes,
    slices,
    evidence,
    summary,
  };
}

/** Runs the validation when Node executes this module directly. */
async function main(): Promise<void> {
  await validateChallengeDataset();
}

const entry = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entry === import.meta.url) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
