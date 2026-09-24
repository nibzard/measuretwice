// SPDX-License-Identifier: Apache-2.0
/**
 * The opt-in Jev shadow experiment runner of the development checks.
 *
 * One experiment assesses the development cases through the pinned Jev
 * evaluator and records one shadow report per case. Nothing enforces and
 * nothing changes an application action: the generated profile stays
 * explicitly unvalidated, the runs state the `shadow` mode, and the reports
 * are stored beside the dataset, never inside it.
 *
 * The runner is opt-in because one experiment reads one credential and
 * spends one API budget. It refuses to run until the caller opts in with
 * `--yes` on the command line or `optIn: true` in code. The ordinary test
 * suites of this repository never cross that gate. Offline validation needs
 * no gate: run `node .measuretwice/build/validate.js`.
 *
 * The model stays pinned: the default is the versioned identifier of the
 * verified provider record, and one alias such as `jev-latest` is refused,
 * because aliases repoint without one code change. The report records the
 * version that answered, so one experiment stays reproducible.
 *
 * Expected labels and their explanations never reach the evaluator. Every
 * run starts from `dataset.runCase`, which holds one case identifier and
 * one input object alone. The reference labels appear only in the printed
 * comparison, marked for one human review on disagreement.
 *
 * Run it with the repository build and the pinned SDK installed:
 *
 *   npx tsc -p .measuretwice/tsconfig.json
 *   npm install @typesafe-ai/sdk@0.6.0
 *   node .measuretwice/build/jev-shadow.js --yes --check example-contract
 *
 * The client reads the credential from `TYPESAFE_API_KEY`, as the verified
 * provider record in `providers/jev/README.md` states. This module reads no
 * credential itself.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createExplorationProfile,
  createJevEvaluator,
  JEV_DEFAULT_MODEL,
  load,
  loadDataset,
  registerEvaluators,
  type Dataset,
  type Definition,
  type JevCall,
  type JevEvaluator,
  type JevRequestOptions,
  type JevSystemOneRequest,
  type Profile,
  type RunReport,
} from "measuretwice";
import { claimEvidence } from "./checks/claim-evidence.js";
import { exampleContract } from "./checks/example-contract.js";

/**
 * The root of the development checks, one level above the compiled module.
 * Pass one explicit `root` when your own build writes elsewhere.
 */
const CHECKS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** One development check that one experiment can run. */
const CHECKS: readonly {
  readonly name: string;
  readonly definition: Definition;
  readonly checkId: string;
  readonly metadata: string;
  readonly records: string;
}[] = [
  {
    name: "example-contract",
    definition: exampleContract,
    checkId: "example-matches-contract",
    metadata: "cases/example-contract.metadata.json",
    records: "cases/example-contract.jsonl",
  },
  {
    name: "claim-evidence",
    definition: claimEvidence,
    checkId: "claim-matches-evidence",
    metadata: "cases/claim-evidence.metadata.json",
    records: "cases/claim-evidence.jsonl",
  },
];

/** The pinned model of one experiment. One versioned identifier, no alias. */
const PINNED_MODEL = JEV_DEFAULT_MODEL;

/** Accepts one versioned Jev identifier only, such as `jev-1.13.0`. */
const VERSIONED_MODEL = /^jev-\d+\.\d+\.\d+$/;

/** The structural Jev client boundary that the pinned SDK exports. */
interface JevSdkClient {
  systemOne(request: JevSystemOneRequest, options?: JevRequestOptions): Promise<unknown>;
}

/** The options of one Jev shadow experiment run. */
export interface JevShadowOptions {
  /** True to opt in. One experiment reads one credential and spends budget. */
  readonly optIn?: boolean;
  /** One check name to run. Omit to run both checks. */
  readonly check?: string;
  /** One versioned model identifier. Default: the pinned version. */
  readonly model?: string;
  /** The maximum number of cases per check. Omit to run every case. */
  readonly limit?: number;
  /** The directory for the stored profile and reports. Default: `reports`. */
  readonly out?: string;
  /** The root that holds `cases`. Default: this folder. */
  readonly root?: string;
  /**
   * The host-supplied Jev call boundary. When omitted, the runner imports
   * the pinned SDK module and constructs its client.
   */
  readonly call?: JevCall;
  /** The SDK module specifier. Default: `@typesafe-ai/sdk`. */
  readonly sdkModule?: string;
  /** The sink of the printed summary. Default: `console.log`. */
  readonly log?: (text: string) => void;
}

/** One experiment: one check, its dataset, its profile, and its reports. */
export interface JevShadowExperiment {
  /** The definition name. */
  readonly name: string;
  /** The loaded dataset. Reference labels and provenance stay readable. */
  readonly dataset: Dataset;
  /** The generated exploration profile. Unvalidated, so shadow use only. */
  readonly profile: Profile;
  /** The pinned Jev evaluator that served every question. */
  readonly evaluator: JevEvaluator;
  /** One frozen report per run case, in dataset order. */
  readonly reports: readonly RunReport[];
  /** The path of the stored profile artifact. */
  readonly storedProfile: string;
  /** The path of every stored report, in run order. */
  readonly storedReports: readonly string[];
}

/** The result of one opt-in run. */
export interface JevShadowResult {
  /** Every experiment, in declaration order. */
  readonly experiments: readonly JevShadowExperiment[];
  /** The pinned model identifier that every binding requested. */
  readonly model: string;
  /** The complete printed summary. */
  readonly summary: string;
}

/** Refuses one run that no caller opted into. */
function requireOptIn(optIn: boolean | undefined): void {
  if (optIn === true) {
    return;
  }
  throw new Error(
    "The Jev shadow experiment is opt-in. One experiment reads one credential and spends one API budget. " +
      "Pass --yes on the command line, or optIn: true in code. Offline validation needs no gate: " +
      "run node .measuretwice/build/validate.js.",
  );
}

/** Refuses one model identifier that is no pinned version. */
function requireVersionedModel(model: string): void {
  if (VERSIONED_MODEL.test(model)) {
    return;
  }
  throw new Error(
    `The model ${JSON.stringify(model)} is no versioned identifier. One experiment pins one exact version, ` +
      `because aliases repoint without one code change. Pass one versioned identifier, for example ${JSON.stringify(PINNED_MODEL)}.`,
  );
}

/** Loads the Jev call boundary from the pinned SDK module. */
async function sdkCallOf(sdkModule: string): Promise<JevCall> {
  let imported: { TypeSafeClient?: new () => JevSdkClient };
  try {
    imported = (await import(sdkModule)) as { TypeSafeClient?: new () => JevSdkClient };
  } catch (cause) {
    throw new Error(
      `The pinned SDK module ${JSON.stringify(sdkModule)} is not installed. Install @typesafe-ai/sdk 0.6.0, ` +
        "or supply one call boundary through the call option. The client reads its credential from TYPESAFE_API_KEY. " +
        `Install failure: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const constructor = imported.TypeSafeClient;
  if (typeof constructor !== "function") {
    throw new Error(
      `The module ${JSON.stringify(sdkModule)} exports no TypeSafeClient constructor. Verify the installed version against providers/jev/README.md.`,
    );
  }
  const client = new constructor();
  return (request, options) => client.systemOne(request, options);
}

/** Sums one usage field of every report, when the reports state usage. */
function usageTotal(reports: readonly RunReport[], field: string): number | undefined {
  let total = 0;
  let seen = false;
  for (const report of reports) {
    const value = report.totals?.usage?.[field];
    if (value !== undefined) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

/**
 * Runs the opt-in Jev shadow experiments.
 *
 * Every step goes through the public package: the dataset load validates
 * every record, the generated profile stays unvalidated with the reason
 * `starter_policy`, every run states the `shadow` mode, and the host-side
 * storage writes the profile and every report. Model output is stored
 * beside the dataset, never inside it.
 *
 * @throws {Error} when no caller opted in, when the model identifier is no
 * pinned version, when the pinned SDK is missing, and when one artifact
 * fails its validation.
 */
export async function runJevShadowExperiments(
  options: JevShadowOptions = {},
): Promise<JevShadowResult> {
  requireOptIn(options.optIn);
  const model = options.model ?? PINNED_MODEL;
  requireVersionedModel(model);
  const root = options.root ?? CHECKS_ROOT;
  const out = options.out ?? path.join(CHECKS_ROOT, "reports");
  const log = options.log ?? console.log;
  const selected = options.check === undefined
    ? CHECKS
    : CHECKS.filter((check) => check.name === options.check);
  if (selected.length === 0) {
    throw new Error(
      `The check ${JSON.stringify(options.check)} names no development check. The known names are: ${CHECKS.map((check) => check.name).join(", ")}.`,
    );
  }
  const call = options.call ?? (await sdkCallOf(options.sdkModule ?? "@typesafe-ai/sdk"));

  const lines: string[] = [
    "Development checks · Jev shadow experiments · opt-in",
    `Model requested: ${model} · one alias refuses to load`,
    "",
  ];
  const experiments: JevShadowExperiment[] = [];

  for (const check of selected) {
    const dataset = await loadDataset({
      definition: check.definition,
      metadata: path.join(root, check.metadata),
      records: path.join(root, check.records),
    });
    const evaluator = createJevEvaluator({ call, model });
    const registry = registerEvaluators(evaluator);
    // The binding requests the pinned version, and the starter policy
    // carries no qualification evidence.
    const profile = createExplorationProfile(check.definition, registry, {
      id: `${check.name}-jev-exploration`,
      bindings: { [check.checkId]: { evaluator: evaluator.id, model } },
    });

    const experimentOut = path.join(out, `${check.name}-jev-${model}`);
    await mkdir(experimentOut, { recursive: true });
    const storedProfile = path.join(experimentOut, `${profile.id}.json`);
    await writeFile(storedProfile, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    const reviewer = await load(check.definition, {
      profile: storedProfile,
      evaluators: registry,
    });

    const records = options.limit === undefined ? dataset.cases : dataset.cases.slice(0, options.limit);
    const reports: RunReport[] = [];
    const storedReports: string[] = [];
    for (const record of records) {
      // The run case holds one identifier and one input object alone, so no
      // reference label, no explanation, and no provenance record crosses.
      const report = await reviewer.run(dataset.runCase(record), { mode: "shadow" });
      const storedReport = path.join(experimentOut, `${report.run_id}.json`);
      await writeFile(storedReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      reports.push(report);
      storedReports.push(storedReport);
    }

    lines.push(
      `${check.name} · profile ${profile.id} · ${profile.qualification.status} · ${profile.qualification.reasons.join(", ")}`,
    );
    let disagreements = 0;
    for (const [index, report] of reports.entries()) {
      const record = records[index]!;
      const reference = record.expected?.outcome ?? "unlabeled";
      const disagrees = reference !== "unlabeled" && reference !== report.aggregate.outcome;
      if (disagrees) {
        disagreements += 1;
      }
      const completion = report.completion.status === "completed"
        ? ""
        : ` · completion ${report.completion.status}`;
      lines.push(
        `  ${report.case.id} · candidate ${report.aggregate.outcome} · reference ${reference}` +
          `${disagrees ? " (disagreement)" : ""}${completion}`,
      );
    }
    const resolved = reports
      .map((report) => report.checks[0]?.evaluator?.model_resolved)
      .find((value) => value !== undefined);
    const inputTokens = usageTotal(reports, "input_tokens");
    const outputTokens = usageTotal(reports, "output_tokens");
    lines.push(
      `  Model that answered: ${resolved ?? "none recorded"}.`,
      `  Usage: ${inputTokens === undefined ? "not reported" : `${inputTokens} input tokens`}` +
        `, ${outputTokens === undefined ? "not reported" : `${outputTokens} output tokens`}.`,
      `  Labels: ${dataset.labels.summary.model_unreviewed} model-proposed without one human review.`,
    );
    if (disagreements > 0) {
      lines.push(`  ${disagreements} candidate outcome disagrees with its reference label. Review it.`);
    }
    lines.push(`  Stored ${storedReports.length} reports and 1 profile in ${experimentOut}.`, "");
    experiments.push({
      name: check.name,
      dataset,
      profile,
      evaluator,
      reports,
      storedProfile,
      storedReports,
    });
  }

  lines.push(
    "The exploration profile carries no qualification evidence. Use it for exploration and shadow runs only.",
    "These cases are one development fixture. Do not read them as one performance number.",
    "Reports were stored beside the dataset. The input records were not changed.",
    "One shadow run changed no application action and enforced nothing.",
  );
  const summary = lines.join("\n");
  log(summary);
  return { experiments, model, summary };
}

// ---------------------------------------------------------------------------
// The command-line entry point.
// ---------------------------------------------------------------------------

/** The usage text of the command line. */
const USAGE = `Usage: node jev-shadow.js --yes [--check <name>] [--model <version>]
                 [--limit <cases>] [--out <dir>] [--sdk <module>]

One experiment is opt-in: it reads one credential (TYPESAFE_API_KEY) and
spends one API budget. --yes states that you accept both costs. The model
must name one versioned identifier; one alias refuses to load. The default
model is the pinned version ${PINNED_MODEL}. Offline validation needs no
gate: run node .measuretwice/build/validate.js.
`;

/** Reads the value of one --option flag, when the command line states it. */
function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

/** Runs the experiments when Node executes this module directly. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const check = flagValue(args, "check");
  const model = flagValue(args, "model");
  const limitText = flagValue(args, "limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(
      `The value ${JSON.stringify(limitText)} of --limit names no positive whole number of cases.`,
    );
  }
  const out = flagValue(args, "out");
  const sdk = flagValue(args, "sdk");
  const result = await runJevShadowExperiments({
    optIn: args.includes("--yes"),
    ...(check === undefined ? {} : { check }),
    ...(model === undefined ? {} : { model }),
    ...(limit === undefined ? {} : { limit }),
    ...(out === undefined ? {} : { out }),
    ...(sdk === undefined ? {} : { sdkModule: sdk }),
  });
  const failed = result.experiments.flatMap((experiment) => experiment.reports).filter(
    (report) => report.aggregate.outcome === "error",
  );
  if (failed.length > 0) {
    process.stdout.write(
      `${failed.length} report(s) ended in one error outcome. Inspect them before you draw one conclusion.\n`,
    );
  }
}

const entry = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entry === import.meta.url) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
