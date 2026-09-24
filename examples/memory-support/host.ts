// SPDX-License-Identifier: Apache-2.0
/**
 * The host side of the minimal memory support example.
 *
 * This file is application code. It imports the definition through its own
 * TypeScript build, binds one evaluator, states its existing decision as the
 * baseline of one shadow run, and stores every report through its own
 * storage. measuretwice validates, assesses, and reports. It changes no
 * stored memory, grants no permission, and writes no file.
 *
 * The host keeps the remaining responsibilities of a memory system:
 * retrieval completeness, citations, freshness, permissions, attention
 * eligibility, memory lifecycle, cooldowns, approval mode, and delivery.
 *
 * Run the example offline in this repository:
 *
 *   npx tsc -p examples/memory-support/tsconfig.json
 *   node examples/memory-support/build/host.js
 *
 * The run reads local files only. It opens no network connection, reads no
 * credential, and spends no API budget. See [README.md](README.md) for the
 * opt-in Jev variant.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createExplorationProfile,
  createScriptedEvaluator,
  load,
  loadDataset,
  registerEvaluators,
  renderProfileSummary,
  renderRunReport,
  type CaseInput,
  type Dataset,
  type DatasetCase,
  type Profile,
  type Reviewer,
  type RunReport,
  type ScriptedEvaluator,
  type ShadowBaseline,
  type TestEvaluatorControl,
} from "measuretwice";
import { memorySupport } from "./checks/memory-support.js";

/**
 * The root of the example, one level above the compiled module. Pass
 * explicit paths to `runExample` when your own build writes elsewhere.
 */
const EXAMPLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// The existing decision path of the host.
// ---------------------------------------------------------------------------

/** The revision of the existing memory decision path of the host. */
const MEMORY_POLICY_REVISION = "memory-policy-1";

/** The length limit of the existing memory policy, in Unicode code points. */
const MEMORY_POLICY_MAX_LENGTH = 60;

/**
 * The existing decision path of the host.
 *
 * The host stores one proposed memory when its text fits its own length
 * limit. The rule stays in host code, and no library call changes it. One
 * shadow run records the decision as its baseline and changes nothing. The
 * limit measures code points, as the exact rules of measuretwice do.
 */
function existingMemoryPolicy(candidateText: string): "stored" | "skipped" {
  return [...candidateText].length <= MEMORY_POLICY_MAX_LENGTH ? "stored" : "skipped";
}

// ---------------------------------------------------------------------------
// The offline test evaluator.
// ---------------------------------------------------------------------------

/**
 * The scripted answers of the offline test evaluator.
 *
 * Each entry is synthetic adapter output. No model ran, and nothing was
 * measured. The first answer passes, the second fails, and the third
 * disagrees with the reference label of its case, so the printed summary
 * shows one item for review. Replace the evaluator to run the same checks
 * against one real provider. See [README.md](README.md).
 */
const SCRIPTED_STEPS: readonly TestEvaluatorControl[] = [
  {
    answer: {
      assessment: {
        kind: "categorical",
        label: "supported",
        distribution: [
          { name: "supported", mass: 0.9 },
          { name: "contradicted", mass: 0.05 },
          { name: "insufficient", mass: 0.05 },
        ],
      },
      latency_ms: 4,
    },
  },
  {
    answer: {
      assessment: {
        kind: "categorical",
        label: "contradicted",
        distribution: [
          { name: "supported", mass: 0.05 },
          { name: "contradicted", mass: 0.85 },
          { name: "insufficient", mass: 0.1 },
        ],
      },
      latency_ms: 5,
    },
  },
  {
    answer: {
      assessment: {
        kind: "categorical",
        label: "supported",
        distribution: [
          { name: "supported", mass: 0.85 },
          { name: "contradicted", mass: 0.05 },
          { name: "insufficient", mass: 0.1 },
        ],
      },
      latency_ms: 4,
    },
  },
];

// ---------------------------------------------------------------------------
// The example run.
// ---------------------------------------------------------------------------

/** The options of one example run. Every field is optional. */
export interface ExampleOptions {
  /** The directory for the stored profile and reports. Default: `reports`. */
  readonly out?: string;
  /** The dataset metadata path. Default: `cases/memory-support.metadata.json`. */
  readonly metadata?: string;
  /** The dataset records path. Default: `cases/memory-support.jsonl`. */
  readonly records?: string;
  /** The sink of the printed summary. Default: `console.log`. */
  readonly log?: (text: string) => void;
}

/** What one example run produced, and where the host stored it. */
export interface ExampleResult {
  /** The loaded dataset with its reference labels and label provenance. */
  readonly dataset: Dataset;
  /** The generated exploration profile. Unvalidated, so shadow use only. */
  readonly profile: Profile;
  /** The reviewer that the host keeps for later runs. */
  readonly reviewer: Reviewer<CaseInput<typeof memorySupport>>;
  /** The offline test evaluator, with every request it received. */
  readonly evaluator: ScriptedEvaluator;
  /** One frozen report per case, in dataset order. */
  readonly reports: readonly RunReport[];
  /** The path of the stored profile artifact. */
  readonly storedProfile: string;
  /** The path of every stored report, in dataset order. */
  readonly storedReports: readonly string[];
  /** The complete printed summary. */
  readonly summary: string;
}

/**
 * Reads one dataset record as one typed case input.
 *
 * The dataset loader already validated every input object against the input
 * schema of the definition through the Rust core, so this cast states one
 * proved fact. `CaseInput` reads the type that the TypeBox schema inferred,
 * so the compiler rejects one unknown or missing field in any literal.
 */
function caseInputOf(record: DatasetCase): CaseInput<typeof memorySupport> {
  return record.input as CaseInput<typeof memorySupport>;
}

/**
 * Runs the complete example offline.
 *
 * The steps: load the labeled cases, generate one exploration profile for
 * the registered test evaluator, store the profile, load the definition with
 * it, run every case in shadow mode beside the existing decision of the
 * host, store every report, and print one summary.
 *
 * @throws whatever the public API throws. One invalid artifact, one invalid
 * record, and one incompatible binding fail before any evaluator runs.
 */
export async function runExample(options: ExampleOptions = {}): Promise<ExampleResult> {
  const metadata = options.metadata ?? path.join(EXAMPLE_ROOT, "cases", "memory-support.metadata.json");
  const records = options.records ?? path.join(EXAMPLE_ROOT, "cases", "memory-support.jsonl");
  const out = options.out ?? path.join(EXAMPLE_ROOT, "reports");
  const log = options.log ?? console.log;
  const lines: string[] = [];

  // 1. Load the labeled cases. The Rust core validates every record line,
  //    every input object, and every reference label against the meaning of
  //    the check. Reference labels and provenance stay outside every
  //    evaluator request.
  const dataset = await loadDataset({ definition: memorySupport, metadata, records });

  // 2. Bind the offline test evaluator and generate one exploration profile.
  //    The generator reads no clock, draws no identifier, and calls no
  //    provider. The qualification stays unvalidated with the reason
  //    `starter_policy`.
  const evaluator = createScriptedEvaluator({ steps: SCRIPTED_STEPS });
  const registry = registerEvaluators(evaluator);
  const profile = createExplorationProfile(memorySupport, registry);

  // 3. Store the profile through host storage, then load the definition with
  //    it. The core verifies the stored self-hash before any run, so one
  //    edited copy refuses to load.
  await mkdir(out, { recursive: true });
  const storedProfile = path.join(out, "memory-support-exploration.json");
  await writeFile(storedProfile, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  const reviewer = await load(memorySupport, { profile: storedProfile, evaluators: registry });

  // 4. Run every case in shadow mode. The host decides first, states its own
  //    decision as the baseline, and then stores the returned report itself.
  //    The awaited call returns when the run reaches one terminal state.
  const reports: RunReport[] = [];
  const storedReports: string[] = [];
  for (const record of dataset.cases) {
    const input = caseInputOf(record);
    const baseline: ShadowBaseline = {
      outcome: existingMemoryPolicy(input.candidate_text),
      revision: MEMORY_POLICY_REVISION,
    };
    const report = await reviewer.run({ id: record.id, input }, { mode: "shadow", baseline });
    const storedReport = path.join(out, `${report.run_id}.json`);
    await writeFile(storedReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    reports.push(report);
    storedReports.push(storedReport);
  }

  // 5. Print the summary. The host reads the report. Agreement with the
  //    baseline is one observation, not one correctness claim, and three
  //    synthetic cases support no performance claim.
  lines.push(
    "Memory support example",
    "",
    `Definition ${memorySupport.name} with one question check.`,
    `Profile ${profile.id} · ${profile.qualification.status} · ${profile.qualification.reasons.join(", ")}`,
    "Starter thresholds carry no qualification evidence. Use the profile for exploration and shadow runs.",
    "",
    "Cases:",
  );
  let disagreements = 0;
  let highlight = reports[0]!;
  for (const [index, report] of reports.entries()) {
    const record = dataset.cases[index]!;
    const reference = record.expected?.outcome ?? "unlabeled";
    const disagrees = reference !== "unlabeled" && reference !== report.aggregate.outcome;
    if (disagrees) {
      disagreements += 1;
      highlight = report;
    }
    lines.push(
      `  ${record.id} · baseline ${report.baseline?.outcome ?? "none"} · candidate ${report.aggregate.outcome}` +
        ` · reference ${reference}${disagrees ? " (disagreement)" : ""}`,
    );
  }
  const labelSummary = dataset.labels.summary;
  lines.push(
    "",
    `Reference labels: ${labelSummary.records} records, ${labelSummary.labeled} labeled,` +
      ` ${labelSummary.model_unreviewed} model-proposed without one human review.`,
  );
  if (disagreements > 0) {
    lines.push(`${disagreements} candidate outcome disagrees with its reference label. Review it.`);
  }
  lines.push(
    "Three synthetic cases support no performance claim.",
    "",
    renderProfileSummary(profile),
    "",
    renderRunReport(memorySupport, highlight),
    "",
    `Stored ${storedReports.length} reports and 1 profile in ${out}.`,
    "A shadow run changed no stored memory. The existing policy kept every decision.",
  );
  const summary = lines.join("\n");
  log(summary);

  return {
    dataset,
    profile,
    reviewer,
    evaluator,
    reports,
    storedProfile,
    storedReports,
    summary,
  };
}

/** Runs the example when Node executes this module directly. */
async function main(): Promise<void> {
  await runExample();
}

const entry = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entry === import.meta.url) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
