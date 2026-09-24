// SPDX-License-Identifier: Apache-2.0
/**
 * The host run of the Cassandra shadow adapter example.
 *
 * This file wires the example: the application with its records, its rules,
 * its queue, and its storage; the two existing decision paths that decide
 * and act; the shadow adapter that queues one job per decided proposal; and
 * the worker that drains the queue. The decision path blocks on no run, and
 * no run reaches one decision, one rule, or one action.
 *
 * Run the example offline in this repository:
 *
 *   npx tsc -p examples/cassandra-shadow/tsconfig.json
 *   node examples/cassandra-shadow/build/cassandra-shadow/host.js
 *
 * The run reads local files only. It opens no network connection, reads no
 * credential, and spends no API budget. See [README.md](README.md) for the
 * parts that one real deployment replaces.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderProfileSummary, renderRunReport, type ShadowReviewExport } from "measuretwice";
import { memorySupport } from "../memory-support/checks/memory-support.js";
import {
  createCassandraApplication,
  createReportStore,
  createShadowQueue,
  type ApplicationAction,
  type CassandraApplication,
  type ReportStore,
  type ShadowQueue,
} from "./cassandra.js";
import { CASSANDRA_RECORDS } from "./records.js";
import {
  createShadowSide,
  type ShadowOutcome,
  type ShadowSide,
} from "./adapter.js";

/**
 * The root of the example, one level above the compiled module. Pass one
 * explicit output directory to `runExample` when your own build writes
 * elsewhere.
 */
const EXAMPLE_ROOT = path.resolve(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "..",
);

/** The capacity of the shadow queue. The bound keeps one busy evaluator from growing it. */
const QUEUE_CAPACITY = 32;

/** The sample seed and the agreement size of the review exports. */
const REVIEW_SAMPLE = { seed: "cassandra-shadow-2026-09-24", agreements: 1 } as const;

/** The options of one example run. Every field is optional. */
export interface ExampleOptions {
  /** The directory for the stored profiles and reports. Default: `reports`. */
  readonly out?: string;
  /** The sink of the printed summary. Default: `console.log`. */
  readonly log?: (text: string) => void;
}

/** One decision of one existing path, and the shadow status of its proposal. */
export interface RecordedDecision {
  /** Which decision path decided. */
  readonly kind: "memory" | "intervention";
  /** The proposal that the path decided on. */
  readonly proposal_id: string;
  /** The decision word. */
  readonly outcome: string;
  /** Why the path decided as it did. */
  readonly reasons: readonly string[];
  /** Whether the shadow side queued one job for the proposal. */
  readonly shadow: "queued" | "queue-full" | "unmapped";
}

/** What one example run produced, and where the application stored it. */
export interface ExampleResult {
  /** The application with its records, its rules, and its action ledger. */
  readonly application: CassandraApplication;
  /** The bounded shadow queue of the application. */
  readonly queue: ShadowQueue & { readonly capacity: number };
  /** The storage that keeps the profiles and the reports. */
  readonly store: ReportStore & { readonly directory: string };
  /** The shadow adapter. */
  readonly shadow: ShadowSide;
  /** Every decision of the existing paths, in decision order. */
  readonly decisions: readonly RecordedDecision[];
  /** The jobs that waited in the queue when the decision path returned. */
  readonly queuedDepth: number;
  /** One completed job per drained queue entry, in drain order. */
  readonly outcomes: readonly ShadowOutcome[];
  /** The saturated replay of one decided intervention proposal. */
  readonly replay: ShadowOutcome;
  /** The review export of the memory shadow reports. */
  readonly memoryExport: ShadowReviewExport;
  /** The review export of the intervention shadow reports. */
  readonly interventionExport: ShadowReviewExport;
  /** The actions that the application took before any run started. */
  readonly actionsBeforeDrain: readonly ApplicationAction[];
  /** The actions after the drain. */
  readonly actionsAfterDrain: readonly ApplicationAction[];
  /** The actions after the saturated replay. */
  readonly actionsAfterReplay: readonly ApplicationAction[];
  /** The complete printed summary. */
  readonly summary: string;
}

/** States whether the application took one action for one decision. */
function actedOn(decision: RecordedDecision, actions: readonly ApplicationAction[]): boolean {
  return actions.some((action) => action.proposal_id === decision.proposal_id);
}

/** Names the action that one decision took, or the absence of one action. */
function actionWord(decision: RecordedDecision, actions: readonly ApplicationAction[]): string {
  if (!actedOn(decision, actions)) {
    return "no action";
  }
  return decision.kind === "memory" ? "memory stored" : "intervention delivered";
}

/** States whether two action lists hold the same actions in the same order. */
function sameActions(left: readonly ApplicationAction[], right: readonly ApplicationAction[]): boolean {
  return (
    left.length === right.length &&
    left.every((action, index) => {
      const other = right[index];
      return other !== undefined && action.kind === other.kind && action.proposal_id === other.proposal_id;
    })
  );
}

/**
 * Runs the complete example offline.
 *
 * The steps: build the application and its ports, build the shadow adapter,
 * run every existing decision path and take its action, queue one shadow job
 * per decided proposal, drain the queue through one worker, replay one
 * proposal under the saturated profile, export the review records, and print
 * one summary.
 *
 * @throws whatever the public API throws. One invalid artifact fails before
 * any evaluator runs.
 */
export async function runExample(options: ExampleOptions = {}): Promise<ExampleResult> {
  const out = options.out ?? path.join(EXAMPLE_ROOT, "reports");
  const log = options.log ?? console.log;
  const lines: string[] = [];

  // 1. The application, its queue, and its storage. The library receives no
  //    handle to any of them.
  const application = createCassandraApplication(CASSANDRA_RECORDS);
  const queue = createShadowQueue(QUEUE_CAPACITY);
  const store = createReportStore(out);

  // 2. The shadow adapter: two definitions, three unvalidated profiles, and
  //    two offline test evaluators.
  const shadow = await createShadowSide({ application, store, queue });

  // 3. The existing decision paths decide and act. Each decided proposal
  //    hands one job to the queue, which starts no run and blocks on
  //    nothing. The job carries the decision that the path already made.
  const decisions: RecordedDecision[] = [];
  for (const proposal of application.memory_proposals) {
    const decision = application.decideMemoryProposal(proposal);
    application.applyMemoryDecision(proposal, decision);
    decisions.push({
      kind: "memory",
      proposal_id: proposal.proposal_id,
      outcome: decision.outcome,
      reasons: decision.reasons,
      shadow: shadow.enqueueMemoryShadow(proposal, decision),
    });
  }
  for (const proposal of application.intervention_proposals) {
    const decision = application.decideInterventionProposal(proposal);
    application.applyInterventionDecision(proposal, decision);
    decisions.push({
      kind: "intervention",
      proposal_id: proposal.proposal_id,
      outcome: decision.outcome,
      reasons: decision.reasons,
      shadow: shadow.enqueueInterventionShadow(proposal, decision),
    });
  }

  // 4. The decision path returned. The ledger holds every action it took,
  //    and the queue holds the shadow work that no decision waited for.
  const actionsBeforeDrain = application.actions();
  const queuedDepth = queue.depth();

  // 5. One worker drains the queue. Each job maps its record, awaits one
  //    shadow run, and stores the returned report through the application
  //    storage.
  const outcomes = await shadow.drain();
  const actionsAfterDrain = application.actions();

  // 6. The saturated replay: the same case through the smallest execution
  //    configuration, so the records show what saturation produces.
  const replayProposal = application.interventionProposalOf("eu-export-move");
  if (replayProposal === undefined) {
    throw new Error("the example records hold no intervention proposal eu-export-move");
  }
  const replayDecision = application.decideInterventionProposal(replayProposal);
  const replay = await shadow.replayUnderSaturation(replayProposal, replayDecision);
  const actionsAfterReplay = application.actions();

  // 7. The review exports. Every disagreement, every report without one
  //    baseline, and every candidate error reaches one human, and one seeded
  //    sample of the agreements keeps the quiet cases auditable.
  const memoryExport = shadow.exportMemoryReviews(REVIEW_SAMPLE);
  const interventionExport = shadow.exportInterventionReviews(REVIEW_SAMPLE);

  // 8. Print the summary. Every line derives from the recorded data, and no
  //    line states one accuracy or one agreement claim.
  lines.push(
    "Cassandra shadow adapter example",
    "",
    `The application: ${application.memory_proposals.length} proposed memories and` +
      ` ${application.intervention_proposals.length} drafted interventions.`,
    "Existing decision paths: memory-policy-1 and cassandra-policy-1.",
    "",
    "The existing decisions, and the actions they took:",
  );
  for (const decision of decisions) {
    lines.push(
      `  ${decision.proposal_id} · ${decision.outcome} · ${actionWord(decision, actionsBeforeDrain)}`,
    );
  }
  lines.push(
    "",
    "The gates that stayed inside the application:",
    ...decisions
      .filter((decision) => !actedOn(decision, actionsBeforeDrain))
      .flatMap((decision) => decision.reasons.map((reason) => `  ${decision.proposal_id} · ${reason}`)),
    "",
    `The queue held ${queuedDepth} jobs when the decision path returned. No decision waited on one run.`,
    `One worker drained the queue and stored ${outcomes.length} reports.`,
    "",
    "Shadow outcomes beside their baselines:",
  );
  for (const outcome of outcomes) {
    const error = outcome.report.checks.find((record) => record.outcome === "error");
    lines.push(
      `  ${outcome.definition} ${outcome.proposal_id} · baseline ${outcome.baseline}` +
        ` · candidate ${outcome.outcome}` +
        (error?.reason !== undefined ? ` (${error.reason.code})` : ""),
    );
  }
  lines.push(
    "",
    "Mapping refusals, one per record that no case may carry:",
    ...(shadow.refusals.length === 0
      ? ["  None."]
      : shadow.refusals.map((refusal) => `  ${refusal.proposal_id} · ${refusal.reason}.`)),
    "",
    `The saturated replay of ${replay.proposal_id} under ${shadow.saturationProfile.id}:`,
  );
  for (const record of replay.report.checks) {
    lines.push(
      `  ${record.check} · ${record.outcome}` +
        (record.reason !== undefined ? ` (${record.reason.code})` : ""),
    );
  }
  lines.push(
    `  Aggregate ${replay.outcome}. The replay measured one record and authorized nothing.`,
    "",
    "Review exports for one human, with the stated baseline meanings:",
    exportLine("memory-support", memoryExport),
    exportLine("intervention-review", interventionExport),
    "Agreement with the baseline is one observation, not one accuracy claim.",
    "",
    `The application took ${actionsBeforeDrain.length} actions before any run:` +
      ` ${countKind(actionsBeforeDrain, "memory-stored")} stored memories and` +
      ` ${countKind(actionsBeforeDrain, "intervention-delivered")} delivered interventions.`,
    sameActions(actionsBeforeDrain, actionsAfterReplay)
      ? `The same ${actionsBeforeDrain.length} actions stand after the drain and after the replay.` +
          " No shadow outcome changed one application action."
      : "One application action changed. This is one defect of the example, not one library behavior.",
    `${decisions.length} synthetic proposals support no performance claim.`,
    "",
    renderProfileSummary(shadow.memoryProfile),
    "",
    "The report of one disagreement, the contradicted memory that the existing policy stored:",
    "",
    renderRunReport(memorySupport, highlightOf(outcomes)),
    "",
    `Stored ${store.reportPaths().length} reports and 3 profiles in ${store.directory}.`,
    "A shadow run changed no stored memory and delivered no intervention.",
  );
  const summary = lines.join("\n");
  log(summary);

  return {
    application,
    queue,
    store,
    shadow,
    decisions,
    queuedDepth,
    outcomes,
    replay,
    memoryExport,
    interventionExport,
    actionsBeforeDrain,
    actionsAfterDrain,
    actionsAfterReplay,
    summary,
  };
}

/** Writes one export line with its review counts. */
function exportLine(name: string, exported: ShadowReviewExport): string {
  return (
    `  ${name} · disagreements: ${exported.summary.disagreements}` +
    ` · candidate errors: ${exported.summary.candidate_errors}` +
    ` · without one baseline: ${exported.summary.missing_baselines}` +
    ` · sampled agreements: ${exported.sampling.selected} of ${exported.sampling.agreements}.`
  );
}

/** Counts the actions of one kind. */
function countKind(actions: readonly ApplicationAction[], kind: ApplicationAction["kind"]): number {
  return actions.filter((action) => action.kind === kind).length;
}

/** Reads the report of the contradicted memory, or the first stored report. */
function highlightOf(outcomes: readonly ShadowOutcome[]): ShadowOutcome["report"] {
  const contradicted = outcomes.find((outcome) => outcome.proposal_id === "data-region-move");
  const chosen = contradicted ?? outcomes[0];
  if (chosen === undefined) {
    throw new Error("the example produced no shadow report");
  }
  return chosen.report;
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
