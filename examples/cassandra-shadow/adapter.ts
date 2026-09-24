// SPDX-License-Identifier: Apache-2.0
/**
 * The measuretwice side of the Cassandra shadow adapter.
 *
 * This file is the adapter that the application writes. It maps one stored
 * record of the application into one case of one definition, it states the
 * decision that the existing path already made as the shadow baseline, and
 * it runs the case through the public API of the library. It holds no
 * permission, no cooldown, no delivery, and no storage of its own: the
 * application keeps each of them, and one report authorizes no action.
 *
 * The adapter is the only file of the example that imports measuretwice. It
 * adds no dependency to the library, because the library knows nothing
 * about the application records that feed it.
 *
 * The two definitions come from the other examples of this repository. One
 * real application owns its definitions and imports them through its own
 * build, exactly as this adapter does.
 */
import {
  createExplorationProfile,
  createScriptedEvaluator,
  exportShadowReviews,
  load,
  registerEvaluators,
  type AgreementSample,
  type AggregateOutcome,
  type BaselineMeanings,
  type CaseInput,
  type Profile,
  type Reviewer,
  type RunReport,
  type ScriptedEvaluator,
  type ShadowBaseline,
  type ShadowReviewExport,
  type TestEvaluatorControl,
} from "measuretwice";
import { memorySupport } from "../memory-support/checks/memory-support.js";
import { intervention } from "../intervention-review/checks/intervention.js";
import {
  INTERVENTION_POLICY_REVISION,
  MEMORY_POLICY_REVISION,
  type CassandraApplication,
  type ExistingDecision,
  type InterventionDecision,
  type InterventionProposal,
  type MemoryDecision,
  type MemoryProposal,
  type ReportStore,
  type ShadowJob,
  type ShadowQueue,
  type StoredMessage,
} from "./cassandra.js";

// ---------------------------------------------------------------------------
// The mapping of one stored record into one case.
// ---------------------------------------------------------------------------

/**
 * The input bounds that the mapping enforces.
 *
 * The memory bounds mirror the input schema of the definition, which the
 * Rust core enforces again at run time. The intervention conversation bound
 * is one policy of the application: it sends at most one bounded transcript.
 * The drafted message holds no bound here, because the delivery limit of the
 * application is one exact check of the definition, not one mapping rule.
 */
const BOUNDS = {
  memory_sources: 4000,
  memory_context: 4000,
  memory_candidate: 1000,
  intervention_context: 4000,
} as const;

/** One mapped case: the stable identifier and the complete input object. */
export interface MappedCase<TInput> {
  /** The case identifier. The example uses the proposal identifier. */
  readonly case_id: string;
  /** The complete input object of the definition. */
  readonly input: TInput;
}

/** The mapping of one proposal into one case, or its recorded refusal. */
export type ProposalMapping<TInput> =
  | ({ readonly mapped: true } & MappedCase<TInput>)
  | { readonly mapped: false; readonly reason: string };

/** The month words of one date, January first. */
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Reads one stored time as one plain date: `22 September 2026`. */
function dateWords(stored_at: string): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})T/.exec(stored_at);
  if (parsed === null) {
    throw new Error(`the stored time ${JSON.stringify(stored_at)} breaks the RFC 3339 form`);
  }
  const month = MONTHS[Number(parsed[2]) - 1];
  if (month === undefined) {
    throw new Error(`the stored time ${JSON.stringify(stored_at)} states no month`);
  }
  return `${Number(parsed[3])} ${month} ${parsed[1]}`;
}

/** Reads one stored time as one plain time: `08:40 UTC`. */
function timeWords(stored_at: string): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(stored_at);
  if (parsed === null) {
    throw new Error(`the stored time ${JSON.stringify(stored_at)} breaks the RFC 3339 form`);
  }
  return `${parsed[4]}:${parsed[5]} UTC`;
}

/** Measures one text in Unicode code points, as the exact rules do. */
function lengthOf(text: string): number {
  return [...text].length;
}

/** Builds one source line: the author, the channel, the date, and the text. */
function sourceLine(stored: StoredMessage): string {
  return `Message from ${stored.author} in ${stored.channel} on ${dateWords(stored.stored_at)}: ${JSON.stringify(stored.text)}`;
}

/**
 * Builds the bounded recent context of one proposal.
 *
 * The application supplies the messages that it stored, oldest first. The
 * mapping keeps the newest messages that fit the bound and drops the older
 * ones, because one recent message carries more weight than one old one. It
 * refuses the proposal when the newest message alone breaks the bound. It
 * cuts no message and no line: one cut context would change the meaning
 * that the checks assess.
 */
function boundedContext(
  messages: readonly StoredMessage[],
  bound: number,
  input_name: string,
): { readonly context: string } | { readonly refusal: string } {
  const newest = [...messages].reverse().map((stored) => {
    const line = `${stored.author} at ${timeWords(stored.stored_at)}: ${stored.text}`;
    return { line, length: lengthOf(line) };
  });
  const kept: string[] = [];
  let total = lengthOf("Newest message last.");
  for (const entry of newest) {
    if (total + entry.length + 1 > bound) {
      if (kept.length === 0) {
        return {
          refusal:
            `the newest message of the recent context holds ${entry.length} code points, and ` +
            `the input ${input_name} of the definition bounds it at ${bound}`,
        };
      }
      break;
    }
    kept.unshift(entry.line);
    total += entry.length + 1;
  }
  return { context: `Newest message last.\n${kept.join("\n")}` };
}

/**
 * Maps one proposed memory into one case of the memory support definition.
 *
 * The citations and the storage times stay in the application record. The
 * case holds the source text, the bounded recent context, and the candidate
 * text, which is exactly what the declared inputs name.
 */
export function memoryCaseOf(
  proposal: MemoryProposal,
): ProposalMapping<CaseInput<typeof memorySupport>> {
  const sources = proposal.sources.map(sourceLine).join("\n");
  if (lengthOf(sources) > BOUNDS.memory_sources) {
    return {
      mapped: false,
      reason:
        `the original sources hold ${lengthOf(sources)} code points, and the input ` +
        `original_sources of the definition bounds them at ${BOUNDS.memory_sources}`,
    };
  }
  const context = boundedContext(
    proposal.recent_messages,
    BOUNDS.memory_context,
    "recent_context",
  );
  if ("refusal" in context) {
    return { mapped: false, reason: context.refusal };
  }
  if (proposal.candidate_text === "") {
    return { mapped: false, reason: "the candidate text is empty" };
  }
  if (lengthOf(proposal.candidate_text) > BOUNDS.memory_candidate) {
    return {
      mapped: false,
      reason:
        `the candidate text holds ${lengthOf(proposal.candidate_text)} code points, and the ` +
        `input candidate_text of the definition bounds it at ${BOUNDS.memory_candidate}`,
    };
  }
  return {
    mapped: true,
    case_id: proposal.proposal_id,
    input: {
      original_sources: sources,
      recent_context: context.context,
      candidate_text: proposal.candidate_text,
    },
  };
}

/**
 * Maps one drafted intervention into one case of the intervention review
 * definition.
 *
 * The recorded decision supplies the prior decision text, and the stored
 * messages supply the bounded conversation. The citations of the decision
 * stay in the application record.
 */
export function interventionCaseOf(
  proposal: InterventionProposal,
): ProposalMapping<CaseInput<typeof intervention>> {
  if (proposal.decision.text === "") {
    return { mapped: false, reason: "the recorded decision states no text" };
  }
  const context = boundedContext(
    proposal.recent_messages,
    BOUNDS.intervention_context,
    "conversation",
  );
  if ("refusal" in context) {
    return { mapped: false, reason: context.refusal };
  }
  if (proposal.drafted_message === "") {
    return { mapped: false, reason: "the drafted message is empty" };
  }
  return {
    mapped: true,
    case_id: proposal.proposal_id,
    input: {
      prior_decision: proposal.decision.text,
      conversation: context.context,
      proposed_message: proposal.drafted_message,
    },
  };
}

/** The snapshot reference of one proposed memory: host storage, no content. */
export function memorySnapshotOf(proposal_id: string): string {
  return `cassandra://memory-proposals/${proposal_id}`;
}

/** The snapshot reference of one drafted intervention: host storage, no content. */
export function interventionSnapshotOf(proposal_id: string): string {
  return `cassandra://intervention-proposals/${proposal_id}`;
}

// ---------------------------------------------------------------------------
// The offline test evaluators.
// ---------------------------------------------------------------------------

/** One mass entry of one scripted distribution. */
interface Mass {
  readonly name: string;
  readonly mass: number;
}

/** Builds one categorical control. */
function choice(label: string, distribution: readonly Mass[], latency_ms: number): TestEvaluatorControl {
  return {
    answer: {
      assessment: {
        kind: "categorical",
        label,
        distribution: distribution.map((entry) => ({ ...entry })),
      },
      latency_ms,
    },
  };
}

/** Builds one binary control. */
function noul(value: boolean, latency_ms: number): TestEvaluatorControl {
  return { answer: { assessment: { kind: "binary", value }, latency_ms } };
}

/** Builds one ordered control. */
function score(level: string, distribution: readonly Mass[], latency_ms: number): TestEvaluatorControl {
  return {
    answer: {
      assessment: {
        kind: "ordered",
        level,
        distribution: distribution.map((entry) => ({ ...entry })),
      },
      latency_ms,
    },
  };
}

/** Builds the one control of the one question check of the memory definition. */
function memoryAnswer(label: string, distribution: readonly Mass[]): TestEvaluatorControl {
  return choice(label, distribution, 40);
}

/**
 * The scripted answers of the memory cases, keyed by proposal.
 *
 * Each entry is synthetic adapter output. No model ran, and nothing was
 * measured. The entry of `on-call-rotation` holds one undeclared label, so
 * the core refuses the assessment and the check records one error: one
 * broken adapter answer is one operational record, never one invented
 * outcome.
 */
const MEMORY_ANSWERS: Readonly<Record<string, TestEvaluatorControl>> = {
  "deploy-freeze-window": memoryAnswer("supported", [
    { name: "supported", mass: 0.9 },
    { name: "contradicted", mass: 0.05 },
    { name: "insufficient", mass: 0.05 },
  ]),
  "data-region-move": memoryAnswer("contradicted", [
    { name: "supported", mass: 0.05 },
    { name: "contradicted", mass: 0.85 },
    { name: "insufficient", mass: 0.1 },
  ]),
  "quiet-hours": memoryAnswer("insufficient", [
    { name: "supported", mass: 0.1 },
    { name: "contradicted", mass: 0.1 },
    { name: "insufficient", mass: 0.8 },
  ]),
  "on-call-rotation": memoryAnswer("verified", [
    { name: "verified", mass: 0.95 },
    { name: "supported", mass: 0.05 },
  ]),
};

/** The scripted conflict distribution of one clear conflict. */
const CLEAR_CONFLICT: readonly Mass[] = [
  { name: "conflict", mass: 0.9 },
  { name: "replaced", mass: 0.03 },
  { name: "aligned", mass: 0.03 },
  { name: "unclear", mass: 0.04 },
];

/** The scripted support distribution of one supported message. */
const SUPPORTED_MESSAGE: readonly Mass[] = [
  { name: "supported", mass: 0.88 },
  { name: "contradicted", mass: 0.07 },
  { name: "incomplete", mass: 0.05 },
];

/** The scripted consequence distribution of one serious concern. */
const SERIOUS_CONCERN: readonly Mass[] = [
  { name: "minor", mass: 0.05 },
  { name: "meaningful", mass: 0.15 },
  { name: "serious", mass: 0.8 },
];

/**
 * The scripted answers of the intervention cases, keyed by proposal.
 *
 * Each entry holds one control per question check, in the definition order:
 * `decision-conflict`, `message-supported`, `adds-information`,
 * `consequence`.
 *
 * The `eu-export-already-raised` case answers `yes` on `adds-information`,
 * because the discussion acknowledged the concern, so the check fails. The
 * `eu-export-cooldown` case holds one open note instead of one decision, so
 * two answers select the review labels and one spread distribution meets
 * neither cutoff. The `saturation-replay` entry serves the saturated replay,
 * which starts one check alone.
 */
const INTERVENTION_ANSWERS: Readonly<Record<string, readonly TestEvaluatorControl[]>> = {
  "eu-export-move": [
    choice("conflict", CLEAR_CONFLICT, 240),
    choice("supported", SUPPORTED_MESSAGE, 260),
    noul(false, 110),
    score("serious", SERIOUS_CONCERN, 200),
  ],
  "eu-export-already-raised": [
    choice("conflict", CLEAR_CONFLICT, 235),
    choice(
      "supported",
      [
        { name: "supported", mass: 0.9 },
        { name: "contradicted", mass: 0.06 },
        { name: "incomplete", mass: 0.04 },
      ],
      250,
    ),
    noul(true, 105),
    score(
      "serious",
      [
        { name: "minor", mass: 0.06 },
        { name: "meaningful", mass: 0.12 },
        { name: "serious", mass: 0.82 },
      ],
      195,
    ),
  ],
  "eu-export-cooldown": [
    choice(
      "unclear",
      [
        { name: "conflict", mass: 0.2 },
        { name: "replaced", mass: 0.1 },
        { name: "aligned", mass: 0.2 },
        { name: "unclear", mass: 0.5 },
      ],
      230,
    ),
    choice(
      "incomplete",
      [
        { name: "supported", mass: 0.3 },
        { name: "contradicted", mass: 0.15 },
        { name: "incomplete", mass: 0.55 },
      ],
      245,
    ),
    noul(false, 100),
    score(
      "minor",
      [
        { name: "minor", mass: 0.45 },
        { name: "meaningful", mass: 0.3 },
        { name: "serious", mass: 0.25 },
      ],
      205,
    ),
  ],
  "paging-rule-reminder": [
    choice(
      "conflict",
      [
        { name: "conflict", mass: 0.86 },
        { name: "replaced", mass: 0.04 },
        { name: "aligned", mass: 0.06 },
        { name: "unclear", mass: 0.04 },
      ],
      225,
    ),
    choice(
      "supported",
      [
        { name: "supported", mass: 0.85 },
        { name: "contradicted", mass: 0.07 },
        { name: "incomplete", mass: 0.08 },
      ],
      240,
    ),
    noul(false, 108),
    score(
      "meaningful",
      [
        { name: "minor", mass: 0.18 },
        { name: "meaningful", mass: 0.72 },
        { name: "serious", mass: 0.1 },
      ],
      190,
    ),
  ],
  "saturation-replay": [choice("conflict", CLEAR_CONFLICT, 240)],
};

/** Reads the one scripted control of one case, or fails with one explicit error. */
function scriptedControl(
  table: Readonly<Record<string, TestEvaluatorControl>>,
  proposal_id: string,
): TestEvaluatorControl {
  const control = table[proposal_id];
  if (control === undefined) {
    throw new Error(`the example holds no scripted answer for the proposal ${proposal_id}`);
  }
  return control;
}

/** Reads the scripted controls of one case, or fails with one explicit error. */
function scriptedControls(
  table: Readonly<Record<string, readonly TestEvaluatorControl[]>>,
  proposal_id: string,
): readonly TestEvaluatorControl[] {
  const controls = table[proposal_id];
  if (controls === undefined) {
    throw new Error(`the example holds no scripted answer for the proposal ${proposal_id}`);
  }
  return controls;
}

// ---------------------------------------------------------------------------
// The shadow side.
// ---------------------------------------------------------------------------

/** The meanings that the application states for its own decision words. */
const MEMORY_BASELINE_MEANINGS: BaselineMeanings = {
  stored: "pass",
  skipped: "silent",
};

/** The meanings that the application states for its own intervention words. */
const INTERVENTION_BASELINE_MEANINGS: BaselineMeanings = {
  interrupt: "pass",
  "stay-quiet": "silent",
};

/** One completed shadow job. */
export interface ShadowOutcome {
  /** The definition that assessed the case. */
  readonly definition: string;
  /** The profile that assessed the case. */
  readonly profile_id: string;
  /** The proposal that the job assessed. */
  readonly proposal_id: string;
  /** The decision word that the existing path recorded. */
  readonly baseline: string;
  /** The candidate aggregate outcome of the run. */
  readonly outcome: AggregateOutcome;
  /** The frozen report of the run. */
  readonly report: RunReport;
  /** The path of the stored report artifact. */
  readonly stored_report: string;
}

/** One proposal that mapped to no case. */
export interface MappingRefusal {
  /** The proposal that the mapping refused. */
  readonly proposal_id: string;
  /** Why the mapping refused it. */
  readonly reason: string;
}

/** One shadow job that failed before or during its run. */
export interface FailedJob {
  /** The job that failed. */
  readonly job: ShadowJob;
  /** Why the job failed. One plain sentence. */
  readonly reason: string;
}

/** The options of the shadow side. */
export interface ShadowSideOptions {
  /** The application that holds the records and the decision paths. */
  readonly application: CassandraApplication;
  /** The storage that keeps the profile and the report artifacts. */
  readonly store: ReportStore;
  /** The queue that carries the shadow jobs off the decision path. */
  readonly queue: ShadowQueue;
}

/** The shadow adapter that runs beside the two existing decision paths. */
export interface ShadowSide {
  /** The exploration profile of the memory definition. Unvalidated. */
  readonly memoryProfile: Profile;
  /** The exploration profile of the intervention definition. Unvalidated. */
  readonly interventionProfile: Profile;
  /**
   * The exploration profile of the saturated replay. It holds the smallest
   * execution configuration, so one replay shows the records that saturation
   * produces. Unvalidated.
   */
  readonly saturationProfile: Profile;
  /** The reviewer of the memory definition. */
  readonly memoryReviewer: Reviewer<CaseInput<typeof memorySupport>>;
  /** The reviewer of the intervention definition. */
  readonly interventionReviewer: Reviewer<CaseInput<typeof intervention>>;
  /** The offline test evaluator of the memory runs, with every request. */
  readonly memoryEvaluator: ScriptedEvaluator;
  /** The offline test evaluator of the intervention runs, with every request. */
  readonly interventionEvaluator: ScriptedEvaluator;
  /**
   * Adds one shadow job for one decided memory proposal. The operation maps
   * the record, records one refusal when the mapping fails, and hands the
   * job to the queue. It starts no run and blocks on nothing.
   */
  enqueueMemoryShadow(
    proposal: MemoryProposal,
    decision: ExistingDecision<MemoryDecision>,
  ): "queued" | "queue-full" | "unmapped";
  /** Adds one shadow job for one decided intervention proposal. */
  enqueueInterventionShadow(
    proposal: InterventionProposal,
    decision: ExistingDecision<InterventionDecision>,
  ): "queued" | "queue-full" | "unmapped";
  /** Drains the queue through one worker and returns every outcome. */
  drain(): Promise<readonly ShadowOutcome[]>;
  /**
   * Replays one decided intervention proposal under the saturated profile.
   * The replay measures the same case through one profile whose execution
   * configuration allows one active check and no queued check, so the
   * records show what saturation produces.
   */
  replayUnderSaturation(
    proposal: InterventionProposal,
    decision: ExistingDecision<InterventionDecision>,
  ): Promise<ShadowOutcome>;
  /** Every recorded mapping refusal, in refusal order. */
  readonly refusals: readonly MappingRefusal[];
  /** Every job that failed before or during its run, in failure order. */
  readonly failures: readonly FailedJob[];
  /** Exports the stored memory shadow reports for one human review. */
  exportMemoryReviews(sample: AgreementSample): ShadowReviewExport;
  /** Exports the stored intervention shadow reports for one human review. */
  exportInterventionReviews(sample: AgreementSample): ShadowReviewExport;
}

/** Reads one existing decision as the shadow baseline of its case. */
function baselineOf(decision: Readonly<{ outcome: string }>, revision: string): ShadowBaseline {
  return { outcome: decision.outcome, revision };
}

/** Serializes one frozen artifact for host storage. */
function artifactText(artifact: unknown): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/** States why one thrown error crossed, in one plain sentence. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the shadow adapter of the application.
 *
 * The steps: build one offline test evaluator per definition from the
 * records of the application, generate one exploration profile per
 * evaluator, store every profile through host storage, and load the
 * reviewers with their stored paths. The qualification of every profile
 * stays unvalidated, so the runs state shadow mode and enforce nothing.
 *
 * @throws whatever the public API throws. One invalid artifact fails before
 * any evaluator runs.
 */
export async function createShadowSide(options: ShadowSideOptions): Promise<ShadowSide> {
  const { application, store, queue } = options;
  const outcomes: ShadowOutcome[] = [];
  const refusals: MappingRefusal[] = [];
  const failures: FailedJob[] = [];

  // One evaluator per definition, so the two scripts stay independent. The
  // steps follow the store order of the proposals that map, which is the
  // order of the queue, so each run meets its own scripted answer. The last
  // intervention step serves the saturated replay, which starts one check.
  const memorySteps = application.memory_proposals
    .filter((proposal) => memoryCaseOf(proposal).mapped)
    .map((proposal) => scriptedControl(MEMORY_ANSWERS, proposal.proposal_id));
  const interventionSteps = application.intervention_proposals
    .filter((proposal) => interventionCaseOf(proposal).mapped)
    .flatMap((proposal) => scriptedControls(INTERVENTION_ANSWERS, proposal.proposal_id))
    .concat(scriptedControls(INTERVENTION_ANSWERS, "saturation-replay"));

  const memoryEvaluator = createScriptedEvaluator({ id: "scripted-memory", steps: memorySteps });
  const interventionEvaluator = createScriptedEvaluator({
    id: "scripted-intervention",
    steps: interventionSteps,
  });
  const memoryRegistry = registerEvaluators(memoryEvaluator);
  const interventionRegistry = registerEvaluators(interventionEvaluator);

  // Generate one exploration profile per binding, store it through host
  // storage, and load the reviewer with the stored path. The core verifies
  // the stored self-hash, so one edited copy refuses to load.
  const memoryProfile = createExplorationProfile(memorySupport, memoryRegistry);
  const interventionProfile = createExplorationProfile(intervention, interventionRegistry);
  const saturationProfile = createExplorationProfile(intervention, interventionRegistry, {
    id: "intervention-review-saturation",
    execution: { max_active: 1, max_pending: 0 },
  });
  const storedMemoryProfile = await store.saveProfile(memoryProfile.id, artifactText(memoryProfile));
  const storedInterventionProfile = await store.saveProfile(
    interventionProfile.id,
    artifactText(interventionProfile),
  );
  const storedSaturationProfile = await store.saveProfile(
    saturationProfile.id,
    artifactText(saturationProfile),
  );
  const memoryReviewer = await load(memorySupport, {
    profile: storedMemoryProfile,
    evaluators: memoryRegistry,
  });
  const interventionReviewer = await load(intervention, {
    profile: storedInterventionProfile,
    evaluators: interventionRegistry,
  });
  const saturationReviewer = await load(intervention, {
    profile: storedSaturationProfile,
    evaluators: interventionRegistry,
  });

  /** Assesses one mapped case and stores the returned report. */
  const assess = async <TInput>(
    definition: string,
    reviewer: Reviewer<TInput>,
    boundProfile: Profile,
    mappedCase: MappedCase<TInput>,
    baseline: ShadowBaseline,
    snapshot: string,
  ): Promise<ShadowOutcome> => {
    const report = await reviewer.run(
      { id: mappedCase.case_id, input: mappedCase.input },
      { mode: "shadow", baseline, snapshot },
    );
    const stored_report = await store.saveReport(report.run_id, artifactText(report));
    return {
      definition,
      profile_id: boundProfile.id,
      proposal_id: mappedCase.case_id,
      baseline: baseline.outcome,
      outcome: report.aggregate.outcome,
      report,
      stored_report,
    };
  };

  /** Runs one queued job. The operation records every failure and throws nothing. */
  const runJob = async (job: ShadowJob): Promise<void> => {
    try {
      if (job.kind === "memory") {
        const proposal = application.memoryProposalOf(job.proposal_id);
        if (proposal === undefined) {
          throw new Error(`the application holds no memory proposal ${job.proposal_id}`);
        }
        const mapped = memoryCaseOf(proposal);
        if (!mapped.mapped) {
          refusals.push({ proposal_id: proposal.proposal_id, reason: mapped.reason });
          return;
        }
        outcomes.push(
          await assess(
            memorySupport.name,
            memoryReviewer,
            memoryProfile,
            mapped,
            job.baseline,
            memorySnapshotOf(proposal.proposal_id),
          ),
        );
        return;
      }
      const proposal = application.interventionProposalOf(job.proposal_id);
      if (proposal === undefined) {
        throw new Error(`the application holds no intervention proposal ${job.proposal_id}`);
      }
      const mapped = interventionCaseOf(proposal);
      if (!mapped.mapped) {
        refusals.push({ proposal_id: proposal.proposal_id, reason: mapped.reason });
        return;
      }
      outcomes.push(
        await assess(
          intervention.name,
          interventionReviewer,
          interventionProfile,
          mapped,
          job.baseline,
          interventionSnapshotOf(proposal.proposal_id),
        ),
      );
    } catch (error) {
      failures.push({ job, reason: reasonOf(error) });
    }
  };

  return {
    memoryProfile,
    interventionProfile,
    saturationProfile,
    memoryReviewer,
    interventionReviewer,
    memoryEvaluator,
    interventionEvaluator,
    refusals,
    failures,
    enqueueMemoryShadow(proposal, decision): "queued" | "queue-full" | "unmapped" {
      const mapped = memoryCaseOf(proposal);
      if (!mapped.mapped) {
        refusals.push({ proposal_id: proposal.proposal_id, reason: mapped.reason });
        return "unmapped";
      }
      return queue.enqueue({
        kind: "memory",
        proposal_id: proposal.proposal_id,
        baseline: baselineOf(decision, MEMORY_POLICY_REVISION),
      });
    },
    enqueueInterventionShadow(proposal, decision): "queued" | "queue-full" | "unmapped" {
      const mapped = interventionCaseOf(proposal);
      if (!mapped.mapped) {
        refusals.push({ proposal_id: proposal.proposal_id, reason: mapped.reason });
        return "unmapped";
      }
      return queue.enqueue({
        kind: "intervention",
        proposal_id: proposal.proposal_id,
        baseline: baselineOf(decision, INTERVENTION_POLICY_REVISION),
      });
    },
    async drain(): Promise<readonly ShadowOutcome[]> {
      await queue.drain(runJob);
      return Object.freeze([...outcomes]);
    },
    async replayUnderSaturation(proposal, decision): Promise<ShadowOutcome> {
      const mapped = interventionCaseOf(proposal);
      if (!mapped.mapped) {
        throw new Error(
          `the mapping refused the proposal ${proposal.proposal_id}: ${mapped.reason}`,
        );
      }
      const outcome = await assess(
        intervention.name,
        saturationReviewer,
        saturationProfile,
        mapped,
        baselineOf(decision, INTERVENTION_POLICY_REVISION),
        interventionSnapshotOf(proposal.proposal_id),
      );
      outcomes.push(outcome);
      return outcome;
    },
    exportMemoryReviews(sample: AgreementSample): ShadowReviewExport {
      return exportShadowReviews(
        outcomes
          .filter((outcome) => outcome.definition === memorySupport.name)
          .map((one) => one.report),
        { baselineMeanings: MEMORY_BASELINE_MEANINGS, sample },
      );
    },
    exportInterventionReviews(sample: AgreementSample): ShadowReviewExport {
      return exportShadowReviews(
        outcomes
          .filter(
            (outcome) =>
              outcome.definition === intervention.name &&
              outcome.profile_id === interventionProfile.id,
          )
          .map((one) => one.report),
        { baselineMeanings: INTERVENTION_BASELINE_MEANINGS, sample },
      );
    },
  };
}
