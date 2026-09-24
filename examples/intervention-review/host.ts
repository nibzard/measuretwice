// SPDX-License-Identifier: Apache-2.0
/**
 * The host side of the intervention review example.
 *
 * This file is application code. It imports the definition through its own
 * TypeScript build, binds one evaluator, states its existing decision as
 * the baseline of one shadow run, and stores every report through its own
 * storage. measuretwice validates, assesses, and reports. It sends no
 * message, grants no permission, and writes no file besides the artifacts
 * that this host writes itself.
 *
 * The host keeps every responsibility of one intervention system: source
 * selection, attention eligibility, permissions, cooldowns, approval mode,
 * and delivery. A report authorizes no application action.
 *
 * Run the example offline in this repository:
 *
 *   npx tsc -p examples/intervention-review/tsconfig.json
 *   node examples/intervention-review/build/host.js
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
import { intervention } from "./checks/intervention.js";

/**
 * The root of the example, one level above the compiled module. Pass
 * explicit paths to `runExample` when your own build writes elsewhere.
 */
const EXAMPLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// The existing decision path of the host.
// ---------------------------------------------------------------------------

/** The revision of the existing intervention decision path of the host. */
const CASSANDRA_POLICY_REVISION = "cassandra-policy-1";

/** The trigger phrase of the existing policy. */
const POLICY_TRIGGER = "conflicts with";

/**
 * The existing decision path of the host.
 *
 * The current policy interrupts whenever the drafted message contains the
 * trigger phrase. It reads no decision record and no discussion, so it
 * cannot tell one acknowledged concern, one replaced decision, or one
 * overstated claim from one new conflict. The rule stays in host code, and
 * no library call changes it. One shadow run records the decision as its
 * baseline and changes nothing.
 */
function existingInterventionPolicy(proposedMessage: string): "interrupt" | "stay-quiet" {
  return proposedMessage.includes(POLICY_TRIGGER) ? "interrupt" : "stay-quiet";
}

// ---------------------------------------------------------------------------
// The offline test evaluator.
// ---------------------------------------------------------------------------

/** One entry of one reported distribution. */
interface MassEntry {
  /** The declared answer or level. */
  readonly name: string;
  /** The reported mass on that answer or level. */
  readonly mass: number;
}

/** One answer of one categorical check: the selected label and the distribution. */
interface ChoiceAnswer {
  /** The selected label. */
  readonly label: string;
  /** The reported distribution over every declared label. */
  readonly distribution: readonly MassEntry[];
}

/** One answer of one ordered check: the selected level and the distribution. */
interface ScoreAnswer {
  /** The selected level. */
  readonly level: string;
  /** The reported distribution over every declared level. */
  readonly distribution: readonly MassEntry[];
}

/** One answer group of one case: the four question checks, in check order. */
interface ScenarioAnswers {
  /** The answer of `decision-conflict`. */
  readonly conflict: ChoiceAnswer;
  /** The answer of `message-supported`. */
  readonly support: ChoiceAnswer;
  /** The answer of `adds-information`: one binary value, yes or no. */
  readonly novelty: boolean;
  /** The answer of `consequence`. */
  readonly consequence: ScoreAnswer;
}

/**
 * The scripted answers of the offline test evaluator, keyed by case.
 *
 * Each entry is synthetic adapter output. No model ran, and nothing was
 * measured. The answers state the case that each scenario teaches, and one
 * answer of the replaced-decision case disagrees with the reference label
 * of its check, so the printed summary shows one item for review. Replace
 * the evaluator to run the same checks against one real provider. See
 * [README.md](README.md).
 */
const SCENARIO_ANSWERS: Readonly<Record<string, ScenarioAnswers>> = {
  // The accepted case: every check passes.
  "eu-move-new-concern": {
    conflict: {
      label: "conflict",
      distribution: [
        { name: "conflict", mass: 0.9 },
        { name: "replaced", mass: 0.03 },
        { name: "aligned", mass: 0.03 },
        { name: "unclear", mass: 0.04 },
      ],
    },
    support: {
      label: "supported",
      distribution: [
        { name: "supported", mass: 0.88 },
        { name: "contradicted", mass: 0.07 },
        { name: "incomplete", mass: 0.05 },
      ],
    },
    novelty: false,
    consequence: {
      level: "serious",
      distribution: [
        { name: "minor", mass: 0.05 },
        { name: "meaningful", mass: 0.15 },
        { name: "serious", mass: 0.8 },
      ],
    },
  },
  // The duplicated case: the concern is real, but the discussion
  // acknowledged it, so the novelty check fails.
  "eu-move-already-discussed": {
    conflict: {
      label: "conflict",
      distribution: [
        { name: "conflict", mass: 0.87 },
        { name: "replaced", mass: 0.04 },
        { name: "aligned", mass: 0.05 },
        { name: "unclear", mass: 0.04 },
      ],
    },
    support: {
      label: "supported",
      distribution: [
        { name: "supported", mass: 0.9 },
        { name: "contradicted", mass: 0.06 },
        { name: "incomplete", mass: 0.04 },
      ],
    },
    novelty: true,
    consequence: {
      level: "serious",
      distribution: [
        { name: "minor", mass: 0.06 },
        { name: "meaningful", mass: 0.12 },
        { name: "serious", mass: 0.82 },
      ],
    },
  },
  // The contradicted case: one claim of the message conflicts with one
  // explicit statement, so the support check fails while the serious
  // consequence passes.
  "eu-move-overstated-record": {
    conflict: {
      label: "conflict",
      distribution: [
        { name: "conflict", mass: 0.85 },
        { name: "replaced", mass: 0.05 },
        { name: "aligned", mass: 0.06 },
        { name: "unclear", mass: 0.04 },
      ],
    },
    support: {
      label: "contradicted",
      distribution: [
        { name: "supported", mass: 0.05 },
        { name: "contradicted", mass: 0.85 },
        { name: "incomplete", mass: 0.1 },
      ],
    },
    novelty: false,
    consequence: {
      level: "serious",
      distribution: [
        { name: "minor", mass: 0.06 },
        { name: "meaningful", mass: 0.14 },
        { name: "serious", mass: 0.8 },
      ],
    },
  },
  // The replaced-decision case: the scripted adapter reads one conflict in
  // the March decision and misses the approved change of May, so its
  // conflict answer disagrees with the reference label `replaced`. The
  // support and consequence answers still fail the message, so the
  // aggregate agrees with the reference outcome.
  "eu-move-replaced-decision": {
    conflict: {
      label: "conflict",
      distribution: [
        { name: "conflict", mass: 0.82 },
        { name: "replaced", mass: 0.05 },
        { name: "aligned", mass: 0.08 },
        { name: "unclear", mass: 0.05 },
      ],
    },
    support: {
      label: "contradicted",
      distribution: [
        { name: "supported", mass: 0.06 },
        { name: "contradicted", mass: 0.86 },
        { name: "incomplete", mass: 0.08 },
      ],
    },
    novelty: false,
    consequence: {
      level: "minor",
      distribution: [
        { name: "minor", mass: 0.85 },
        { name: "meaningful", mass: 0.1 },
        { name: "serious", mass: 0.05 },
      ],
    },
  },
  // The missing-evidence case: two review answers and one spread
  // distribution that meets neither cutoff.
  "eu-move-unrecorded-decision": {
    conflict: {
      label: "unclear",
      distribution: [
        { name: "conflict", mass: 0.2 },
        { name: "replaced", mass: 0.1 },
        { name: "aligned", mass: 0.2 },
        { name: "unclear", mass: 0.5 },
      ],
    },
    support: {
      label: "incomplete",
      distribution: [
        { name: "supported", mass: 0.3 },
        { name: "contradicted", mass: 0.15 },
        { name: "incomplete", mass: 0.55 },
      ],
    },
    novelty: false,
    consequence: {
      level: "minor",
      distribution: [
        { name: "minor", mass: 0.45 },
        { name: "meaningful", mass: 0.3 },
        { name: "serious", mass: 0.25 },
      ],
    },
  },
  // The over-length case: every question check passes and the exact rule
  // fails the message in code.
  "eu-move-verbose-message": {
    conflict: {
      label: "conflict",
      distribution: [
        { name: "conflict", mass: 0.9 },
        { name: "replaced", mass: 0.03 },
        { name: "aligned", mass: 0.04 },
        { name: "unclear", mass: 0.03 },
      ],
    },
    support: {
      label: "supported",
      distribution: [
        { name: "supported", mass: 0.88 },
        { name: "contradicted", mass: 0.06 },
        { name: "incomplete", mass: 0.06 },
      ],
    },
    novelty: false,
    consequence: {
      level: "serious",
      distribution: [
        { name: "minor", mass: 0.05 },
        { name: "meaningful", mass: 0.11 },
        { name: "serious", mass: 0.84 },
      ],
    },
  },
};

/** Builds one categorical answer control. */
function choice(answer: ChoiceAnswer, latencyMs: number): TestEvaluatorControl {
  return {
    answer: {
      assessment: {
        kind: "categorical",
        label: answer.label,
        distribution: answer.distribution.map((entry) => ({ ...entry })),
      },
      latency_ms: latencyMs,
    },
  };
}

/** Builds one binary answer control. */
function noul(value: boolean, latencyMs: number): TestEvaluatorControl {
  return { answer: { assessment: { kind: "binary", value }, latency_ms: latencyMs } };
}

/** Builds one ordered answer control. */
function score(answer: ScoreAnswer, latencyMs: number): TestEvaluatorControl {
  return {
    answer: {
      assessment: {
        kind: "ordered",
        level: answer.level,
        distribution: answer.distribution.map((entry) => ({ ...entry })),
      },
      latency_ms: latencyMs,
    },
  };
}

/**
 * Builds the scripted controls of one case, in the definition order of the
 * question checks: `decision-conflict`, `message-supported`,
 * `adds-information`, `consequence`.
 */
function controlsOf(answers: ScenarioAnswers): readonly TestEvaluatorControl[] {
  return [
    choice(answers.conflict, 240),
    choice(answers.support, 260),
    noul(answers.novelty, 110),
    score(answers.consequence, 200),
  ];
}

// ---------------------------------------------------------------------------
// The example run.
// ---------------------------------------------------------------------------

/** The options of one example run. Every field is optional. */
export interface ExampleOptions {
  /** The directory for the stored profile and reports. Default: `reports`. */
  readonly out?: string;
  /** The dataset metadata path. Default: `cases/intervention-review.metadata.json`. */
  readonly metadata?: string;
  /** The dataset records path. Default: `cases/intervention-review.jsonl`. */
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
  readonly reviewer: Reviewer<CaseInput<typeof intervention>>;
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
function caseInputOf(record: DatasetCase): CaseInput<typeof intervention> {
  return record.input as CaseInput<typeof intervention>;
}

/** Names the failed checks of one report. */
function failedChecks(report: RunReport): readonly string[] {
  return report.checks.filter((record) => record.outcome === "fail").map((record) => record.check);
}

/**
 * Runs the complete example offline.
 *
 * The steps: load the labeled cases, generate one exploration profile for
 * the registered test evaluator, store the profile, load the definition
 * with it, run every case in shadow mode beside the existing decision of
 * the host, store every report, and print one summary.
 *
 * @throws whatever the public API throws. One invalid artifact, one invalid
 * record, and one incompatible binding fail before any evaluator runs.
 */
export async function runExample(options: ExampleOptions = {}): Promise<ExampleResult> {
  const metadata =
    options.metadata ?? path.join(EXAMPLE_ROOT, "cases", "intervention-review.metadata.json");
  const records = options.records ?? path.join(EXAMPLE_ROOT, "cases", "intervention-review.jsonl");
  const out = options.out ?? path.join(EXAMPLE_ROOT, "reports");
  const log = options.log ?? console.log;
  const lines: string[] = [];

  // 1. Load the labeled cases. The Rust core validates every record line,
  //    every input object, and every reference label against the meaning of
  //    its check. Reference labels and provenance stay outside every
  //    evaluator request.
  const dataset = await loadDataset({ definition: intervention, metadata, records });

  // 2. Bind the offline test evaluator and generate one exploration
  //    profile. The generator reads no clock, draws no identifier, and
  //    calls no provider. The qualification stays unvalidated with the
  //    reason `starter_policy`.
  const steps = dataset.cases.flatMap((record) => {
    const answers = SCENARIO_ANSWERS[record.id];
    if (answers === undefined) {
      throw new Error(`the example holds no scripted answers for the case ${record.id}`);
    }
    return controlsOf(answers);
  });
  const evaluator = createScriptedEvaluator({ steps });
  const registry = registerEvaluators(evaluator);
  const profile = createExplorationProfile(intervention, registry);

  // 3. Store the profile through host storage, then load the definition
  //    with it. The core verifies the stored self-hash before any run, so
  //    one edited copy refuses to load.
  await mkdir(out, { recursive: true });
  const storedProfile = path.join(out, "intervention-review-exploration.json");
  await writeFile(storedProfile, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  const reviewer = await load(intervention, { profile: storedProfile, evaluators: registry });

  // 4. Run every case in shadow mode. The host decides first, states its
  //    own decision as the baseline, and then stores the returned report
  //    itself. The awaited call returns when the run reaches one terminal
  //    state.
  const reports: RunReport[] = [];
  const storedReports: string[] = [];
  for (const record of dataset.cases) {
    const input = caseInputOf(record);
    const baseline: ShadowBaseline = {
      outcome: existingInterventionPolicy(input.proposed_message),
      revision: CASSANDRA_POLICY_REVISION,
    };
    const report = await reviewer.run({ id: record.id, input }, { mode: "shadow", baseline });
    const storedReport = path.join(out, `${report.run_id}.json`);
    await writeFile(storedReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    reports.push(report);
    storedReports.push(storedReport);
  }

  // 5. Print the summary. The host reads the report. Agreement with the
  //    baseline is one observation, not one correctness claim, and six
  //    synthetic cases support no performance claim.
  lines.push(
    "Intervention review example",
    "",
    "Definition intervention-review with 5 checks: 4 question checks and 1 exact rule.",
    `Profile ${profile.id} · ${profile.qualification.status} · ${profile.qualification.reasons.join(", ")}`,
    "Starter thresholds carry no qualification evidence. Use the profile for exploration and shadow runs.",
    "",
    "Cases:",
  );
  for (const [index, report] of reports.entries()) {
    const record = dataset.cases[index]!;
    const reference = record.expected?.outcome ?? "unlabeled";
    lines.push(
      `  ${record.id} · baseline ${report.baseline?.outcome ?? "none"} · candidate ${report.aggregate.outcome}` +
        ` · reference ${reference}` +
        (failedChecks(report).length > 0 ? ` · failed: ${failedChecks(report).join(", ")}` : ""),
    );
  }
  const labelSummary = dataset.labels.summary;
  lines.push(
    "",
    `Reference labels: ${labelSummary.records} records, ${labelSummary.labeled} labeled,` +
      ` ${labelSummary.model_unreviewed} model-proposed without one human review.`,
  );

  // One candidate answer that disagrees with its reference label needs one
  // review, whatever the aggregate agrees on.
  let answerDisagreements = 0;
  for (const [index, report] of reports.entries()) {
    const record = dataset.cases[index]!;
    for (const check of report.checks) {
      const expected = record.expected?.checks[check.check];
      if (expected?.outcome === undefined || expected.outcome === check.outcome) {
        continue;
      }
      answerDisagreements += 1;
      lines.push(
        `  ${record.id} · ${check.check}: candidate ${check.outcome}, reference ${expected.outcome}. Review it.`,
      );
    }
  }
  if (answerDisagreements === 0) {
    lines.push("  Every candidate outcome matches its reference label.");
  }

  // The lesson of the aggregate: one passed consequence check compensates
  // nothing. The summary derives the line from the reports, so it stays
  // true to the recorded outcomes.
  const uncompensated = reports.filter((report) => {
    const consequence = report.checks.find((record) => record.check === "consequence");
    return consequence?.outcome === "pass" && report.aggregate.outcome === "fail";
  });
  if (uncompensated.length > 0) {
    lines.push(
      "",
      `The consequence check passed in ${uncompensated.length} cases whose aggregate failed.` +
        " A serious consequence cannot compensate for one failed requirement:",
    );
    for (const report of uncompensated) {
      lines.push(`  ${report.case.id} · failed: ${failedChecks(report).join(", ")}`);
    }
  }

  lines.push(
    "",
    "Six synthetic cases support no performance claim.",
    "",
    renderProfileSummary(profile),
    "",
    "The report of the duplicated case:",
    "",
    renderRunReport(intervention, reports[1]!),
    "",
    "The report of the missing-evidence case:",
    "",
    renderRunReport(intervention, reports[4]!),
    "",
    `Stored ${storedReports.length} reports and 1 profile in ${out}.`,
    "A shadow run sent no message. The existing policy kept every decision.",
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
