// SPDX-License-Identifier: Apache-2.0
/**
 * The host side of the plan review example.
 *
 * This file is application code of one second, unrelated application: one
 * vendor that drafts implementation plans for customers. It supplies the
 * three documents of one case, keeps its own storage, keeps its own
 * existing decision path, and keeps every action on the plan. measuretwice
 * validates, assesses, calibrates, and reports. It sends no plan, grants no
 * permission, and writes no file besides the artifacts that this host
 * writes itself.
 *
 * The run walks the complete workflow of the contracts on one synthetic
 * dataset, offline:
 *
 * 1. Author the definition in TypeScript and export the portable artifact.
 * 2. Load the labeled cases of dataset revision 2026-09-25.1.
 * 3. Generate one exploration profile and run every case in shadow mode
 *    beside the existing delivery review.
 * 4. Evaluate the same dataset under the exploration profile.
 * 5. Calibrate one candidate profile on the fitting split and validate it
 *    on the holdout of the same revision.
 * 6. Revise the policy under one tighter error goal, measure one fresh
 *    validation split of dataset revision 2026-09-25.2, and read the
 *    revision comparison.
 * 7. Check the retained evidence of the revised profile.
 *
 * The host keeps every responsibility of one delivery review: where the
 * requirements and the capability documentation come from, who may see one
 * customer document, where every artifact is stored, and what happens to
 * one plan after one report. A report authorizes no application action.
 *
 * Run the example offline in this repository:
 *
 *   npx tsc -p examples/plan-review/tsconfig.json
 *   node examples/plan-review/build/host.js
 *
 * The run reads local files only. It opens no network connection, reads no
 * credential, and spends no API budget. See [README.md](README.md) for the
 * opt-in Jev variant and for the recorded integration friction.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  calibrate,
  checkEvidence,
  createExplorationProfile,
  createScriptedEvaluator,
  evaluate,
  load,
  loadDataset,
  registerEvaluators,
  renderProfileSummary,
  renderRunReport,
  revise,
  type Calibration,
  type CaseInput,
  type Dataset,
  type DatasetCase,
  type Evaluation,
  type EvaluatorExecution,
  type EvaluatorRequest,
  type EvidenceCheck,
  type Profile,
  type Revision,
  type Reviewer,
  type RunReport,
  type ScriptedEvaluator,
  type ShadowBaseline,
  type TestEvaluatorControl,
} from "measuretwice";
import { planReview } from "./checks/plan.js";

/**
 * The root of the example, one level above the compiled module. Pass
 * explicit paths to `runExample` when your own build writes elsewhere.
 */
const EXAMPLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// The existing decision path of the host.
// ---------------------------------------------------------------------------

/** The revision of the existing delivery review of the host. */
const DELIVERY_REVIEW_REVISION = "delivery-review-2";

/** The trigger phrase of the existing review. */
const REVIEW_TRIGGER = "custom integration";

/**
 * The existing decision path of the host.
 *
 * The current review escalates one plan whenever the plan text contains the
 * phrase of one custom work item, because custom work needs one exception
 * approval. It reads no requirements and no capability documentation, so it
 * cannot tell one missed requirement, one undocumented limit, or one sketch
 * from one complete plan. The rule stays in host code, and no library call
 * changes it. One shadow run records the decision as its baseline and
 * changes nothing.
 */
function existingDeliveryReview(proposedPlan: string): "approve" | "escalate" {
  return proposedPlan.includes(REVIEW_TRIGGER) ? "escalate" : "approve";
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
  /** The answer of `requirement-coverage`. */
  readonly coverage: ChoiceAnswer;
  /** The answer of `capability-fit`. */
  readonly capability: ChoiceAnswer;
  /** The answer of `unrequested-work`: one binary value, yes or no. */
  readonly unrequested: boolean;
  /** The answer of `delivery-readiness`. */
  readonly readiness: ScoreAnswer;
}

/**
 * The scripted answers of the offline test evaluator, keyed by case.
 *
 * Each entry is synthetic adapter output. No model ran, and nothing was
 * measured. The answers state the case that each scenario teaches. Three
 * answers disagree with the reference of their check, so the printed summary
 * names them for review:
 *
 * - `atlas-assumed-export` reads one covered plan where the reference states
 *   one unaddressed requirement.
 * - `borealis-undocumented-limit` reads one sketch where the reference
 *   states one workable plan.
 * - `cirrus-doubtful-coverage` reads one covered plan where the reference
 *   states one unaddressed requirement.
 *
 * Replace the evaluator to run the same checks against one real provider.
 * See [README.md](README.md).
 */
const SCENARIO_ANSWERS: Readonly<Record<string, ScenarioAnswers>> = {
  // The fitting cases of engagement atlas. The coverage mass varies on
  // purpose, so the cutoff search has something to move: 0.95 and 0.70 both
  // sit above one 0.6 cutoff, and 0.75 sits between 0.6 and 0.8.
  "atlas-covered-plan": {
    coverage: choice("covered", [
      ["covered", 0.95],
      ["partial", 0.03],
      ["unaddressed", 0.02],
    ]),
    capability: choice("documented", [
      ["documented", 0.92],
      ["absent", 0.03],
      ["unclear", 0.05],
    ]),
    unrequested: false,
    readiness: score("complete", [
      ["sketch", 0.05],
      ["workable", 0.13],
      ["complete", 0.82],
    ]),
  },
  "atlas-thin-coverage": {
    coverage: choice("covered", [
      ["covered", 0.75],
      ["partial", 0.15],
      ["unaddressed", 0.1],
    ]),
    capability: choice("documented", [
      ["documented", 0.88],
      ["absent", 0.05],
      ["unclear", 0.07],
    ]),
    unrequested: false,
    readiness: score("workable", [
      ["sketch", 0.1],
      ["workable", 0.78],
      ["complete", 0.12],
    ]),
  },
  "atlas-missed-requirement": {
    coverage: choice("unaddressed", [
      ["covered", 0.07],
      ["partial", 0.15],
      ["unaddressed", 0.78],
    ]),
    capability: choice("documented", [
      ["documented", 0.9],
      ["absent", 0.04],
      ["unclear", 0.06],
    ]),
    unrequested: false,
    readiness: score("workable", [
      ["sketch", 0.1],
      ["workable", 0.75],
      ["complete", 0.15],
    ]),
  },
  "atlas-assumed-export": {
    coverage: choice("covered", [
      ["covered", 0.7],
      ["partial", 0.12],
      ["unaddressed", 0.18],
    ]),
    capability: choice("documented", [
      ["documented", 0.9],
      ["absent", 0.05],
      ["unclear", 0.05],
    ]),
    unrequested: false,
    readiness: score("workable", [
      ["sketch", 0.08],
      ["workable", 0.8],
      ["complete", 0.12],
    ]),
  },
  "atlas-open-mapping": {
    coverage: choice("partial", [
      ["covered", 0.3],
      ["partial", 0.55],
      ["unaddressed", 0.15],
    ]),
    capability: choice("documented", [
      ["documented", 0.86],
      ["absent", 0.06],
      ["unclear", 0.08],
    ]),
    unrequested: false,
    readiness: score("workable", [
      ["sketch", 0.1],
      ["workable", 0.7],
      ["complete", 0.2],
    ]),
  },
  // The validation cases of engagement borealis, dataset revision one.
  "borealis-clean-plan": {
    coverage: choice("covered", [
      ["covered", 0.92],
      ["partial", 0.04],
      ["unaddressed", 0.04],
    ]),
    capability: choice("documented", [
      ["documented", 0.9],
      ["absent", 0.05],
      ["unclear", 0.05],
    ]),
    unrequested: false,
    readiness: score("complete", [
      ["sketch", 0.05],
      ["workable", 0.15],
      ["complete", 0.8],
    ]),
  },
  "borealis-undocumented-limit": {
    coverage: choice("covered", [
      ["covered", 0.88],
      ["partial", 0.06],
      ["unaddressed", 0.06],
    ]),
    capability: choice("absent", [
      ["documented", 0.05],
      ["absent", 0.88],
      ["unclear", 0.07],
    ]),
    unrequested: false,
    readiness: score("sketch", [
      ["sketch", 0.6],
      ["workable", 0.3],
      ["complete", 0.1],
    ]),
  },
  "borealis-no-rollback": {
    coverage: choice("covered", [
      ["covered", 0.9],
      ["partial", 0.05],
      ["unaddressed", 0.05],
    ]),
    capability: choice("documented", [
      ["documented", 0.87],
      ["absent", 0.05],
      ["unclear", 0.08],
    ]),
    unrequested: false,
    readiness: score("workable", [
      ["sketch", 0.1],
      ["workable", 0.75],
      ["complete", 0.15],
    ]),
  },
  "borealis-unclear-region": {
    coverage: choice("covered", [
      ["covered", 0.85],
      ["partial", 0.1],
      ["unaddressed", 0.05],
    ]),
    capability: choice("unclear", [
      ["documented", 0.3],
      ["absent", 0.2],
      ["unclear", 0.5],
    ]),
    unrequested: false,
    readiness: score("workable", [
      ["sketch", 0.08],
      ["workable", 0.8],
      ["complete", 0.12],
    ]),
  },
  // The fresh validation cases of engagement cirrus, dataset revision two.
  "cirrus-ready-plan": {
    coverage: choice("covered", [
      ["covered", 0.93],
      ["partial", 0.04],
      ["unaddressed", 0.03],
    ]),
    capability: choice("documented", [
      ["documented", 0.91],
      ["absent", 0.04],
      ["unclear", 0.05],
    ]),
    unrequested: false,
    readiness: score("complete", [
      ["sketch", 0.05],
      ["workable", 0.1],
      ["complete", 0.85],
    ]),
  },
  "cirrus-unrequested-migration": {
    coverage: choice("covered", [
      ["covered", 0.9],
      ["partial", 0.06],
      ["unaddressed", 0.04],
    ]),
    capability: choice("documented", [
      ["documented", 0.88],
      ["absent", 0.07],
      ["unclear", 0.05],
    ]),
    unrequested: true,
    readiness: score("workable", [
      ["sketch", 0.08],
      ["workable", 0.78],
      ["complete", 0.14],
    ]),
  },
  "cirrus-doubtful-coverage": {
    coverage: choice("covered", [
      ["covered", 0.72],
      ["partial", 0.14],
      ["unaddressed", 0.14],
    ]),
    capability: choice("documented", [
      ["documented", 0.9],
      ["absent", 0.05],
      ["unclear", 0.05],
    ]),
    unrequested: false,
    readiness: score("workable", [
      ["sketch", 0.1],
      ["workable", 0.76],
      ["complete", 0.14],
    ]),
  },
  "cirrus-sketch-plan": {
    coverage: choice("covered", [
      ["covered", 0.86],
      ["partial", 0.08],
      ["unaddressed", 0.06],
    ]),
    capability: choice("documented", [
      ["documented", 0.85],
      ["absent", 0.08],
      ["unclear", 0.07],
    ]),
    unrequested: false,
    readiness: score("sketch", [
      ["sketch", 0.8],
      ["workable", 0.15],
      ["complete", 0.05],
    ]),
  },
};

/** Builds one categorical answer. */
function choice(label: string, mass: readonly (readonly [string, number])[]): ChoiceAnswer {
  return { label, distribution: mass.map(([name, value]) => ({ name, mass: value })) };
}

/** Builds one ordered answer. */
function score(level: string, mass: readonly (readonly [string, number])[]): ScoreAnswer {
  return { level, distribution: mass.map(([name, value]) => ({ name, mass: value })) };
}

/**
 * Builds the scripted controls of one case, in the definition order of the
 * question checks: `requirement-coverage`, `capability-fit`,
 * `unrequested-work`, `delivery-readiness`.
 */
function controlsOf(answers: ScenarioAnswers): readonly TestEvaluatorControl[] {
  return [
    {
      answer: {
        assessment: {
          kind: "categorical",
          label: answers.coverage.label,
          distribution: answers.coverage.distribution.map((entry) => ({ ...entry })),
        },
        latency_ms: 210,
      },
    },
    {
      answer: {
        assessment: {
          kind: "categorical",
          label: answers.capability.label,
          distribution: answers.capability.distribution.map((entry) => ({ ...entry })),
        },
        latency_ms: 230,
      },
    },
    {
      answer: {
        assessment: { kind: "binary", value: answers.unrequested },
        latency_ms: 90,
      },
    },
    {
      answer: {
        assessment: {
          kind: "ordered",
          level: answers.readiness.level,
          distribution: answers.readiness.distribution.map((entry) => ({ ...entry })),
        },
        latency_ms: 190,
      },
    },
  ];
}

/**
 * Builds one scripted evaluator that answers one stated case order.
 *
 * The scripted adapter consumes one step per request, so one host that runs
 * several operations must state the visit order of every case. The registry
 * of each operation below builds its own evaluator with the same identifier
 * and the same adapter version, so one stored profile stays compatible with
 * the registry that serves the next operation. See [README.md](README.md)
 * for the recorded friction of this boundary.
 */
function evaluatorFor(caseIds: readonly string[], calls: EvaluatorRequest[]): ScriptedEvaluator {
  const steps = caseIds.flatMap((id) => {
    const answers = SCENARIO_ANSWERS[id];
    if (answers === undefined) {
      throw new Error(`the example holds no scripted answers for the case ${id}`);
    }
    return controlsOf(answers);
  });
  const scripted = createScriptedEvaluator({ steps });
  return {
    ...scripted,
    assess(request: EvaluatorRequest): Promise<EvaluatorExecution> {
      calls.push(request);
      return scripted.assess(request);
    },
  };
}

// ---------------------------------------------------------------------------
// The calibration plans of the host.
// ---------------------------------------------------------------------------

/** The identifier of the dataset that the plans bind. */
const DATASET_ID = "plan-review-cases";

/** The confidence level of both plans. */
const CONFIDENCE_LEVEL = 0.95;

/** The permitted cutoff family of both plans. */
const GRID = { accept_cutoffs: [0.6, 0.8], rejection_cutoffs: [0.6] };

/** The population statement that both plans declare. */
const INTENDED_POPULATION =
  "Proposed implementation plans of one delivery team, with the customer requirements and the capability documentation that they answer.";

/** The sampling statement that both plans declare. */
const SAMPLING_ASSUMPTIONS =
  "Cases grouped by customer engagement. Plans of one engagement correlate, so the engagement is the draw.";

/**
 * Writes the calibration plan of the first calibration.
 *
 * The goal limits the error among accepted plans to one third of the
 * accepted cases, needs two accepted cases at least, and minimizes the
 * review rate. The grid permits the 0.6 and the 0.8 accept cutoff.
 */
function calibrationPlan(definitionHash: string): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "plan-review-calibration",
    name: "Limit wrongly approved plans, then minimize review",
    definition: { name: "plan-review", content_hash: definitionHash },
    intended_population: INTENDED_POPULATION,
    sampling_assumptions: SAMPLING_ASSUMPTIONS,
    confidence_level: CONFIDENCE_LEVEL,
    constraints: [
      {
        metric: "error_among_accepted",
        comparison: "at_most",
        limit: 0.35,
        basis: "observed_value",
      },
    ],
    objective: { metric: "review_rate", direction: "minimize" },
    minimum_samples: { accepted_cases: 2 },
    candidate_grid: GRID,
    evaluator: { evaluator: "scripted-test", adapter_version: "0.1.0" },
    datasets: {
      fitting: { dataset: DATASET_ID, revision: "2026-09-25.1", split: "fit" },
      validation: { dataset: DATASET_ID, revision: "2026-09-25.1", split: "holdout" },
    },
  };
}

/**
 * Writes the revision plan.
 *
 * The revision keeps the definition, the evaluator, and the fitting split,
 * and tightens the error goal to one accepted case in ten. The 0.6 cutoff
 * that the first calibration selected accepts one plan with one unaddressed
 * requirement, so the tighter goal moves the policy to the 0.8 cutoff and
 * trades review effort for fewer wrongly approved plans.
 */
function revisionPlan(definitionHash: string): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "plan-review-revision",
    name: "Tighten the error among accepted plans",
    definition: { name: "plan-review", content_hash: definitionHash },
    intended_population: INTENDED_POPULATION,
    sampling_assumptions: SAMPLING_ASSUMPTIONS,
    confidence_level: CONFIDENCE_LEVEL,
    constraints: [
      {
        metric: "error_among_accepted",
        comparison: "at_most",
        limit: 0.1,
        basis: "observed_value",
      },
    ],
    objective: { metric: "review_rate", direction: "minimize" },
    minimum_samples: { accepted_cases: 1 },
    candidate_grid: GRID,
    evaluator: { evaluator: "scripted-test", adapter_version: "0.1.0" },
    datasets: {
      fitting: { dataset: DATASET_ID, revision: "2026-09-25.2", split: "fit" },
      validation: { dataset: DATASET_ID, revision: "2026-09-25.2", split: "holdout" },
    },
  };
}

// ---------------------------------------------------------------------------
// The example run.
// ---------------------------------------------------------------------------

/** The options of one example run. Every field is optional. */
export interface ExampleOptions {
  /** The directory for the stored artifacts. Default: `reports`. */
  readonly out?: string;
  /** The dataset metadata path of revision one. Default: `cases/plan-review.metadata.json`. */
  readonly metadata?: string;
  /** The dataset records path of revision one. Default: `cases/plan-review.jsonl`. */
  readonly records?: string;
  /** The dataset metadata path of revision two. Default: `cases/plan-review-revision.metadata.json`. */
  readonly revisedMetadata?: string;
  /** The dataset records path of revision two. Default: `cases/plan-review-revision.jsonl`. */
  readonly revisedRecords?: string;
  /** The sink of the printed summary. Default: `console.log`. */
  readonly log?: (text: string) => void;
}

/** What one example run produced, and where the host stored it. */
export interface ExampleResult {
  /** The loaded dataset of revision one, with its reference labels. */
  readonly dataset: Dataset;
  /** The loaded dataset of revision two, with its fresh validation split. */
  readonly revisedDataset: Dataset;
  /** The generated exploration profile. Unvalidated, so shadow use only. */
  readonly profile: Profile;
  /** The exploration reviewer that the host keeps for later runs. */
  readonly reviewer: Reviewer<CaseInput<typeof planReview>>;
  /** One frozen report per shadow case, in dataset order. */
  readonly reports: readonly RunReport[];
  /** The evaluation of revision one under the exploration profile. */
  readonly evaluation: Evaluation;
  /** The first calibration, with its candidate profile and its reports. */
  readonly calibration: Calibration;
  /** The policy revision over the fresh validation split of revision two. */
  readonly revision: Revision;
  /** The check of the retained evidence of the revised profile. */
  readonly evidence: EvidenceCheck;
  /** Every evaluator request of every phase, in call order. */
  readonly evaluatorCalls: readonly EvaluatorRequest[];
  /** Every path that the host wrote, in write order. */
  readonly stored: readonly string[];
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
function caseInputOf(record: DatasetCase): CaseInput<typeof planReview> {
  return record.input as CaseInput<typeof planReview>;
}

/** Writes one JSON artifact through host storage and returns its path. */
async function storeJson(out: string, name: string, value: unknown): Promise<string> {
  const target = path.join(out, name);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

/** Formats one rate as one fraction beside its value. */
function rateOf(row: { numerator: number; denominator: number; value?: number | null }): string {
  return row.value === undefined || row.value === null
    ? `${row.numerator}/${row.denominator} with no value`
    : `${row.numerator}/${row.denominator} (${row.value.toFixed(3)})`;
}

/** Formats one measured goal as one fraction beside its observed value. */
function goalOf(
  row: { numerator: number; denominator: number; observed?: number | null } | undefined,
): string {
  if (row === undefined) {
    return "unknown";
  }
  return row.observed === undefined || row.observed === null
    ? `${row.numerator}/${row.denominator} with no value`
    : `${row.numerator}/${row.denominator} (${row.observed.toFixed(3)})`;
}

/**
 * Runs the complete example offline.
 *
 * @throws whatever the public API throws. One invalid artifact, one invalid
 * record, one incompatible binding, and one unmet identity fail before any
 * evaluator runs.
 */
export async function runExample(options: ExampleOptions = {}): Promise<ExampleResult> {
  const metadata =
    options.metadata ?? path.join(EXAMPLE_ROOT, "cases", "plan-review.metadata.json");
  const records = options.records ?? path.join(EXAMPLE_ROOT, "cases", "plan-review.jsonl");
  const revisedMetadata =
    options.revisedMetadata ?? path.join(EXAMPLE_ROOT, "cases", "plan-review-revision.metadata.json");
  const revisedRecords =
    options.revisedRecords ?? path.join(EXAMPLE_ROOT, "cases", "plan-review-revision.jsonl");
  const out = options.out ?? path.join(EXAMPLE_ROOT, "reports");
  const log = options.log ?? console.log;
  const lines: string[] = [];
  const stored: string[] = [];

  // 1. Load the labeled cases of both dataset revisions. The Rust core
  //    validates every record line, every input object, and every reference
  //    label against the meaning of its check. Reference labels and
  //    provenance stay outside every evaluator request.
  const dataset = await loadDataset({ definition: planReview, metadata, records });
  const revisedDataset = await loadDataset({
    definition: planReview,
    metadata: revisedMetadata,
    records: revisedRecords,
  });

  // The plan of one calibration binds the definition by content hash, so the
  // host reads the hash through one load before it states its goals.
  const bare = await load(planReview);
  const definitionHash = bare.definitionHash;

  // 2. Bind the offline test evaluator, generate one exploration profile,
  //    store it, and load the definition with it. The qualification stays
  //    unvalidated with the reason `starter_policy`.
  const shadowIds = dataset.cases.map((record) => record.id);
  // The host records every evaluator request of every phase, so one review
  // can audit the projected inputs of the complete workflow.
  const evaluatorCalls: EvaluatorRequest[] = [];
  const shadowEvaluator = evaluatorFor(shadowIds, evaluatorCalls);
  const registry = registerEvaluators(shadowEvaluator);
  const profile = createExplorationProfile(planReview, registry);
  await mkdir(out, { recursive: true });
  const storedProfile = await storeJson(out, "plan-review-exploration.json", profile);
  stored.push(storedProfile);
  const reviewer = await load(planReview, {
    profile: storedProfile,
    evaluators: registry,
  });

  // 3. Run every case in shadow mode. The host decides first, states its own
  //    decision as the baseline, and then stores the returned report itself.
  const reports: RunReport[] = [];
  for (const record of dataset.cases) {
    const input = caseInputOf(record);
    const baseline: ShadowBaseline = {
      outcome: existingDeliveryReview(input.proposed_plan),
      revision: DELIVERY_REVIEW_REVISION,
    };
    const report = await reviewer.run({ id: record.id, input }, { mode: "shadow", baseline });
    stored.push(await storeJson(out, `${report.run_id}.json`, report));
    reports.push(report);
  }

  // 4. Evaluate the same dataset under the exploration profile. The purpose
  //    states exploration, so the report carries no validation claim.
  const evaluationRegistry = registerEvaluators(evaluatorFor(shadowIds, evaluatorCalls));
  const evaluationReviewer = await load(planReview, {
    profile: storedProfile,
    evaluators: evaluationRegistry,
  });
  const evaluation = await evaluate(evaluationReviewer, {
    metadata,
    records,
    purpose: "exploration",
  });
  stored.push(await storeJson(out, "plan-review-exploration-evaluation.json", evaluation.report));

  // 5. Calibrate one candidate. The host writes its plan, the operation
  //    measures both splits through the registered evaluator, the Rust core
  //    searches the permitted family, and the frozen validation runs on the
  //    holdout of the same revision.
  const calibrationPlanPath = path.join(out, "plan-review-calibration-plan.json");
  await writeFile(
    calibrationPlanPath,
    `${JSON.stringify(calibrationPlan(definitionHash), null, 2)}\n`,
    "utf8",
  );
  stored.push(calibrationPlanPath);
  const fittingSplit = dataset.splits.find((split) => split.purpose === "fitting");
  const holdoutSplit = dataset.splits.find((split) => split.purpose === "validation");
  if (fittingSplit === undefined || holdoutSplit === undefined) {
    throw new Error("the dataset of the example declares no fitting and no validation split");
  }
  const calibration = await calibrate(planReview, {
    plan: calibrationPlanPath,
    metadata,
    records,
    evaluators: registerEvaluators(
      evaluatorFor([...fittingSplit.case_ids, ...holdoutSplit.case_ids], evaluatorCalls),
    ),
    sampling: "grouped_cases",
    evaluationReports: [path.join(out, "plan-review-calibration-fitting.json")],
  });
  stored.push(await storeJson(out, "plan-review-calibration-fitting.json", calibration.fitting));
  if (calibration.qualification !== undefined) {
    stored.push(
      await storeJson(out, "plan-review-calibration-qualification.json", calibration.qualification),
    );
  }
  stored.push(await storeJson(out, "plan-review-calibrated.json", calibration.profile));

  // 6. Revise the policy under one tighter error goal. The fitting split of
  //    revision two carries the content hash that the prior profile records,
  //    so the search replays the stored assessments and measures nothing
  //    there. The fresh validation split of engagement cirrus was never
  //    measured, so the revision measures it through the registry.
  const revisionPlanPath = path.join(out, "plan-review-revision-plan.json");
  await writeFile(
    revisionPlanPath,
    `${JSON.stringify(revisionPlan(definitionHash), null, 2)}\n`,
    "utf8",
  );
  stored.push(revisionPlanPath);
  const freshSplit = revisedDataset.splits.find((split) => split.purpose === "validation");
  if (freshSplit === undefined) {
    throw new Error("the revised dataset of the example declares no validation split");
  }
  const revision = await revise(planReview, {
    prior: calibration,
    plan: revisionPlanPath,
    metadata: revisedMetadata,
    records: revisedRecords,
    evaluators: registerEvaluators(evaluatorFor(freshSplit.case_ids, evaluatorCalls)),
    sampling: "grouped_cases",
    evaluationReports: [path.join(out, "plan-review-revision-fitting.json")],
  });
  stored.push(await storeJson(out, "plan-review-revision-fitting.json", revision.fitting));
  if (revision.qualification !== undefined) {
    stored.push(
      await storeJson(out, "plan-review-revision-qualification.json", revision.qualification),
    );
  }
  stored.push(
    await storeJson(out, "plan-review-revised.json", revision.profile),
    await storeJson(out, "plan-review-revision-comparison.json", revision.comparison),
  );

  // 7. Check the retained evidence of the revised profile against the plan
  //    and the dataset that the host retains beside it.
  const evidence = await checkEvidence(revision.profile, {
    plan: revisionPlanPath,
    metadata: revisedMetadata,
    records: revisedRecords,
  });

  // 8. Print the summary. The host reads the reports. Nine synthetic cases
  //    support no performance claim, and the qualification states what the
  //    development fixture establishes: nothing.
  lines.push(
    "Plan review example, the second application",
    "",
    "Definition plan-review with 5 checks: 4 question checks and 1 exact rule.",
    `Profile ${profile.id} · ${profile.qualification.status} · ${profile.qualification.reasons.join(", ")}`,
    "Starter thresholds carry no qualification evidence. Use the profile for exploration and shadow runs.",
    "",
    `Shadow cases of dataset ${dataset.identity.revision}:`,
  );
  for (const [index, report] of reports.entries()) {
    const record = dataset.cases[index]!;
    const reference = record.expected?.outcome ?? "unlabeled";
    lines.push(
      `  ${record.id} · baseline ${report.baseline?.outcome ?? "none"} · candidate ${report.aggregate.outcome}` +
        ` · reference ${reference}`,
    );
  }
  const labelSummary = dataset.labels.summary;
  lines.push(
    "",
    `Reference labels: ${labelSummary.records} records, ${labelSummary.labeled} labeled,` +
      ` ${labelSummary.model_unreviewed} model-proposed without one human review.`,
    `Evaluation ${evaluation.report.profile.id}: ${evaluation.report.cases.length} cases measured,` +
      ` ${evaluation.unevaluated_records} unevaluated.`,
  );

  // The lesson of the baseline: the existing review reads one phrase alone,
  // so it approves plans whose reference states one fail. The summary
  // derives the line from the reports, so it stays true to the recorded
  // outcomes. Baseline agreement is one observation, not one correctness
  // claim, and the escalated plan is one agreement of two measurements.
  const approvedFailures = reports.filter((report, index) => {
    const reference = dataset.cases[index]!.expected?.outcome;
    return report.baseline?.outcome === "approve" && reference === "fail";
  });
  lines.push(
    `The existing review approved ${approvedFailures.length} plans whose reference states one fail:` +
      " one phrase carries no requirement check.",
    `  ${approvedFailures.map((report) => report.case.id).join(", ")}`,
  )

  // One candidate answer that disagrees with its reference label needs one
  // review, whatever the aggregate agrees on. The scan reads the shadow
  // reports of revision one and the measured reports of the fresh validation
  // split, so one disagreement of either phase stays visible.
  const measured: readonly { readonly report: RunReport; readonly record: DatasetCase }[] = [
    ...reports.map((report, index) => ({ report, record: dataset.cases[index]! })),
    ...revision.runs.map((report) => ({
      report,
      record: revisedDataset.cases.find((record) => record.id === report.case.id)!,
    })),
  ];
  let answerDisagreements = 0;
  for (const { report, record } of measured) {
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

  const calibrationCandidate = calibration.fitting.selected?.candidate;
  lines.push(
    "",
    `Calibration ${calibration.fitting.plan_id}: candidate accept ${calibrationCandidate?.accept_cutoff},` +
      ` reject ${calibrationCandidate?.rejection_cutoff}.`,
    `  Fitting: ${calibration.fitting.case_count} cases, error among accepted ` +
      `${goalOf(calibration.fitting.selected?.constraints[0])}, review rate ` +
      `${rateOf(calibration.fitting.selected?.objective ?? { numerator: 0, denominator: 0, value: null })}.`,
    `  Qualification: ${calibration.profile.qualification.status}.`,
    `  ${calibration.qualification?.evidence.statement ?? ""}`,
    "  Enforcement refuses the candidate until one host review selects its content hash.",
  );

  const revisionCandidate = revision.fitting.selected?.candidate;
  lines.push(
    "",
    `Revision ${revision.fitting.plan_id}: candidate accept ${revisionCandidate?.accept_cutoff},` +
      ` reject ${revisionCandidate?.rejection_cutoff}.`,
    `  ${revision.reuse.stored_fitting_cases} stored fitting assessments replayed, ` +
      `${revision.reuse.validation_data.disposition === "fresh"
        ? `fresh validation split of ${revision.reuse.validation_split.record_count} cases measured`
        : "consumed validation split replayed"}.`,
    `  Fitting: error among accepted ` +
      `${goalOf(revision.fitting.selected?.constraints[0])}, review rate ` +
      `${rateOf(revision.fitting.selected?.objective ?? { numerator: 0, denominator: 0, value: null })}.`,
    `  Comparison: ${revision.comparison.matching.changed_cases} changed cases of ` +
      `${revision.comparison.matching.matched_cases} replayed fitting cases.`,
  );
  for (const changed of revision.comparison.changed) {
    const checks = changed.checks.map((pair) => pair.check).join(", ");
    lines.push(
      `    ${changed.id} · ${changed.baseline_aggregate} to ${changed.candidate_aggregate} · ${checks}`,
    );
  }
  lines.push(
    `  Qualification: ${revision.profile.qualification.status}.`,
    `  ${revision.qualification?.evidence.statement ?? ""}`,
    "",
    `Evidence check: ${evidence.plan.id} and ${evidence.dataset.id} revision ${evidence.dataset.revision} verified,` +
      ` ${evidence.splits.length} splits.`,
    "  The host retains the plan and the dataset beside the profile, because one ignored",
    "  reports folder holds no required copy of the qualification evidence.",
    "",
    "Nine synthetic cases support no performance claim.",
    "",
    renderProfileSummary(revision.profile),
    "",
    "The report of the assumed export case:",
    "",
    renderRunReport(
      planReview,
      reports.find((report) => report.case.id === "atlas-assumed-export") ?? reports[0]!,
    ),
    "",
    `Stored ${stored.length} artifacts in ${out}.`,
    "A shadow run approved no plan. The existing review kept every decision.",
  );
  const summary = lines.join("\n");
  log(summary);

  return {
    dataset,
    revisedDataset,
    profile,
    reviewer,
    reports,
    evaluation,
    calibration,
    revision,
    evidence,
    evaluatorCalls,
    stored,
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
