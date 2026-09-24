// SPDX-License-Identifier: Apache-2.0
/**
 * The Cassandra side of the shadow adapter example.
 *
 * This file is application code. It stands in for the real Cassandra
 * service: the stored records, the channel rules, the two existing decision
 * paths, the actions they take, the queue that carries shadow work, and the
 * storage that keeps the shadow artifacts. It imports no measuretwice
 * module, and the library imports no Cassandra client. The example adds no
 * dependency to either side.
 *
 * The application keeps every responsibility that MVP_SPEC.md section 13
 * names: retrieval completeness, citations, freshness, permissions,
 * attention eligibility, memory lifecycle, cooldowns, approval mode, and
 * delivery. One measuretwice report authorizes none of them.
 *
 * The queue and the storage are the ports that the shadow adapter uses. One
 * real deployment binds them to the durable queue and the tables that the
 * application already runs. This file holds one in-process and one file
 * implementation, so the example runs offline.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// The stored records of the application.
// ---------------------------------------------------------------------------

/** One message that the application stored, with its citation and its time. */
export interface StoredMessage {
  /** The citation of the message. The application keeps the identifier. */
  readonly message_id: string;
  /** The channel that holds the message. */
  readonly channel: string;
  /** The author of the message. */
  readonly author: string;
  /** The time the application stored the message, in RFC 3339 UTC. */
  readonly stored_at: string;
  /** The message text. */
  readonly text: string;
}

/** One recorded decision of the application, with the citations that state it. */
export interface DecisionRecord {
  /** The identifier of the decision. */
  readonly decision_id: string;
  /** The time the application recorded the decision, in RFC 3339 UTC. */
  readonly recorded_at: string;
  /** The messages that the decision cites. */
  readonly citations: readonly string[];
  /** The decision text. */
  readonly text: string;
}

/**
 * The rules of one channel.
 *
 * Every field names one responsibility that stays inside the application.
 * No measuretwice request reads one of them.
 */
export interface ChannelRules {
  /** The channel that the rules govern. */
  readonly channel: string;
  /** Whether one intervention may draw the attention of this channel. */
  readonly attention_eligible: boolean;
  /** The earliest time one intervention may interrupt again. */
  readonly intervention_cooldown_until: string;
  /** Whether one human approves every stored memory of this channel. */
  readonly memory_approval_mode: "automatic" | "human";
  /** The authors that hold the memory permission of this channel. */
  readonly memory_authors: readonly string[];
}

/** One proposed memory of the application. */
export interface MemoryProposal {
  /** The identifier of the proposal. It becomes the case identifier. */
  readonly proposal_id: string;
  /** The channel of the proposal. */
  readonly channel: string;
  /** The author of the proposal. */
  readonly author: string;
  /** The time of the proposal, in RFC 3339 UTC. */
  readonly proposed_at: string;
  /** The original source messages that the proposal claims to follow. */
  readonly sources: readonly StoredMessage[];
  /** The recent messages of the channel, oldest first. */
  readonly recent_messages: readonly StoredMessage[];
  /** The candidate memory text. */
  readonly candidate_text: string;
}

/** One drafted intervention of the application. */
export interface InterventionProposal {
  /** The identifier of the proposal. It becomes the case identifier. */
  readonly proposal_id: string;
  /** The channel of the proposal. */
  readonly channel: string;
  /** The time of the proposal, in RFC 3339 UTC. */
  readonly proposed_at: string;
  /** The recorded decision that the draft speaks to. */
  readonly decision: DecisionRecord;
  /** The recent messages of the channel, oldest first. */
  readonly recent_messages: readonly StoredMessage[];
  /** The drafted message. */
  readonly drafted_message: string;
}

// ---------------------------------------------------------------------------
// The existing decision paths.
// ---------------------------------------------------------------------------

/** The outcome word of the existing memory decision path. */
export type MemoryDecision = "stored" | "skipped";

/** The outcome word of the existing intervention decision path. */
export type InterventionDecision = "interrupt" | "stay-quiet";

/** One decision of one existing path, with the reasons that made it. */
export interface ExistingDecision<TOutcome extends string> {
  /** The decision word of the path. */
  readonly outcome: TOutcome;
  /** Why the path decided as it did. One plain sentence per reason. */
  readonly reasons: readonly string[];
}

/** The revision of the existing memory decision path. */
export const MEMORY_POLICY_REVISION = "memory-policy-1";

/** The revision of the existing intervention decision path. */
export const INTERVENTION_POLICY_REVISION = "cassandra-policy-1";

/** The length limit of the existing memory policy, in Unicode code points. */
const MEMORY_POLICY_MAX_LENGTH = 60;

/** The trigger phrase of the existing intervention policy. */
const POLICY_TRIGGER = "conflicts with";

/** One action that one existing decision path took. */
export interface ApplicationAction {
  /** The action word. */
  readonly kind: "memory-stored" | "intervention-delivered";
  /** The proposal that the action touched. */
  readonly proposal_id: string;
}

/** The records and the rules that the example application holds. */
export interface ApplicationRecords {
  /** The rules of every channel. */
  readonly channels: readonly ChannelRules[];
  /** The proposed memories, in store order. */
  readonly memory_proposals: readonly MemoryProposal[];
  /** The drafted interventions, in store order. */
  readonly intervention_proposals: readonly InterventionProposal[];
}

/**
 * The application of the example.
 *
 * The two decision paths run in this code. They read their own records and
 * their own rules, they decide, and the application takes the action of
 * each decision. Shadow work never calls one of these operations.
 */
export interface CassandraApplication {
  /** Every proposed memory, in store order. */
  readonly memory_proposals: readonly MemoryProposal[];
  /** Every drafted intervention, in store order. */
  readonly intervention_proposals: readonly InterventionProposal[];
  /** Returns the memory proposal of one identifier, or undefined. */
  memoryProposalOf(proposal_id: string): MemoryProposal | undefined;
  /** Returns the intervention proposal of one identifier, or undefined. */
  interventionProposalOf(proposal_id: string): InterventionProposal | undefined;
  /**
   * Runs the existing memory decision path.
   *
   * The path checks the permission of the author, the approval mode of the
   * channel, and the length limit of its own policy. It reads no source
   * message, so it cannot tell one supported candidate from one
   * contradicted candidate.
   */
  decideMemoryProposal(proposal: MemoryProposal): ExistingDecision<MemoryDecision>;
  /**
   * Runs the existing intervention decision path.
   *
   * The path checks the attention eligibility of the channel, the cooldown,
   * and the trigger phrase of its own policy. It reads no decision record
   * and no discussion, so it cannot tell one acknowledged concern from one
   * new conflict.
   */
  decideInterventionProposal(
    proposal: InterventionProposal,
  ): ExistingDecision<InterventionDecision>;
  /** Takes the action of one memory decision. One skipped proposal acts nothing. */
  applyMemoryDecision(proposal: MemoryProposal, decision: ExistingDecision<MemoryDecision>): void;
  /** Takes the action of one intervention decision. One quiet path acts nothing. */
  applyInterventionDecision(
    proposal: InterventionProposal,
    decision: ExistingDecision<InterventionDecision>,
  ): void;
  /** Every action that the application took, in order. */
  actions(): readonly ApplicationAction[];
}

/** Finds the rules of one channel. */
function rulesOf(
  channels: readonly ChannelRules[],
  channel: string,
): ChannelRules | undefined {
  return channels.find((rules) => rules.channel === channel);
}

/** Measures one text in Unicode code points, as the exact rules do. */
function lengthOf(text: string): number {
  return [...text].length;
}

/**
 * Creates the application of the example.
 *
 * The state stays inside the returned object. The caller holds no handle to
 * the internals, and measuretwice receives none, so no library call can
 * reach one decision, one rule, or one action.
 */
export function createCassandraApplication(records: ApplicationRecords): CassandraApplication {
  const storedMemories: ApplicationAction[] = [];
  const deliveredInterventions: ApplicationAction[] = [];
  return {
    memory_proposals: records.memory_proposals,
    intervention_proposals: records.intervention_proposals,
    memoryProposalOf(proposal_id: string): MemoryProposal | undefined {
      return records.memory_proposals.find((proposal) => proposal.proposal_id === proposal_id);
    },
    interventionProposalOf(proposal_id: string): InterventionProposal | undefined {
      return records.intervention_proposals.find(
        (proposal) => proposal.proposal_id === proposal_id,
      );
    },
    decideMemoryProposal(proposal: MemoryProposal): ExistingDecision<MemoryDecision> {
      const rules = rulesOf(records.channels, proposal.channel);
      if (rules === undefined) {
        return {
          outcome: "skipped",
          reasons: [`No channel rules cover the channel ${proposal.channel}.`],
        };
      }
      if (!rules.memory_authors.includes(proposal.author)) {
        return {
          outcome: "skipped",
          reasons: [
            `The author ${proposal.author} holds no memory permission in ${proposal.channel}.`,
          ],
        };
      }
      if (rules.memory_approval_mode === "human") {
        return {
          outcome: "skipped",
          reasons: [`Memories in ${proposal.channel} wait for one human approval.`],
        };
      }
      if (lengthOf(proposal.candidate_text) > MEMORY_POLICY_MAX_LENGTH) {
        return {
          outcome: "skipped",
          reasons: [
            `The candidate text exceeds ${MEMORY_POLICY_MAX_LENGTH} code points, the limit of ${MEMORY_POLICY_REVISION}.`,
          ],
        };
      }
      return {
        outcome: "stored",
        reasons: [
          `The candidate text fits ${MEMORY_POLICY_MAX_LENGTH} code points, the limit of ${MEMORY_POLICY_REVISION}.`,
        ],
      };
    },
    decideInterventionProposal(
      proposal: InterventionProposal,
    ): ExistingDecision<InterventionDecision> {
      const rules = rulesOf(records.channels, proposal.channel);
      if (rules === undefined) {
        return {
          outcome: "stay-quiet",
          reasons: [`No channel rules cover the channel ${proposal.channel}.`],
        };
      }
      if (!rules.attention_eligible) {
        return {
          outcome: "stay-quiet",
          reasons: [`The channel ${proposal.channel} is not eligible for attention.`],
        };
      }
      if (proposal.proposed_at < rules.intervention_cooldown_until) {
        return {
          outcome: "stay-quiet",
          reasons: [
            `The intervention cooldown of ${proposal.channel} runs until ${rules.intervention_cooldown_until}.`,
          ],
        };
      }
      if (!proposal.drafted_message.includes(POLICY_TRIGGER)) {
        return {
          outcome: "stay-quiet",
          reasons: [
            `The draft states no ${JSON.stringify(POLICY_TRIGGER)}, the trigger of ${INTERVENTION_POLICY_REVISION}.`,
          ],
        };
      }
      return {
        outcome: "interrupt",
        reasons: [
          `The draft holds ${JSON.stringify(POLICY_TRIGGER)}, the trigger of ${INTERVENTION_POLICY_REVISION}.`,
        ],
      };
    },
    applyMemoryDecision(
      proposal: MemoryProposal,
      decision: ExistingDecision<MemoryDecision>,
    ): void {
      if (decision.outcome === "stored") {
        storedMemories.push({ kind: "memory-stored", proposal_id: proposal.proposal_id });
      }
    },
    applyInterventionDecision(
      proposal: InterventionProposal,
      decision: ExistingDecision<InterventionDecision>,
    ): void {
      if (decision.outcome === "interrupt") {
        deliveredInterventions.push({
          kind: "intervention-delivered",
          proposal_id: proposal.proposal_id,
        });
      }
    },
    actions(): readonly ApplicationAction[] {
      return Object.freeze([...storedMemories, ...deliveredInterventions]);
    },
  };
}

// ---------------------------------------------------------------------------
// The host-owned queue.
// ---------------------------------------------------------------------------

/** One shadow job: one proposal and the decision that its path already made. */
export interface ShadowJob {
  /** Which decision path the proposal crossed. */
  readonly kind: "memory" | "intervention";
  /** The identifier of the proposal. */
  readonly proposal_id: string;
  /**
   * The existing decision of the proposal, recorded when the job entered the
   * queue. The worker states it as the baseline of the run.
   */
  readonly baseline: Readonly<{ readonly outcome: string; readonly revision: string }>;
}

/** The bounded queue that takes shadow work off the decision path. */
export interface ShadowQueue {
  /**
   * Adds one job. The operation never blocks and never starts work: it
   * returns after it stores the job. One full queue refuses the job.
   */
  enqueue(job: ShadowJob): "queued" | "queue-full";
  /** The number of jobs that wait. */
  depth(): number;
  /**
   * Runs every queued job through one worker, one job at a time, until the
   * queue holds no job. The worker owns its own failures: one thrown job
   * ends the drain and leaves the remaining jobs queued.
   */
  drain(run: (job: ShadowJob) => Promise<void>): Promise<void>;
}

/**
 * Creates one in-process queue that stands in for the durable queue of the
 * application.
 *
 * MVP_SPEC.md section 10 draws the boundary: the library starts no detached
 * job and owns no scheduler, so the host runs nonblocking shadow work
 * through the queue it already owns. The capacity bounds the queue, so one
 * busy evaluator can never grow it without limit.
 */
export function createShadowQueue(capacity: number): ShadowQueue & {
  /** The stated capacity. */
  readonly capacity: number;
  /** Every refused job, in refusal order. */
  readonly refused: readonly ShadowJob[];
} {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error("the queue capacity must hold one integer of at least one");
  }
  const waiting: ShadowJob[] = [];
  const refused: ShadowJob[] = [];
  return {
    capacity,
    refused,
    enqueue(job: ShadowJob): "queued" | "queue-full" {
      if (waiting.length >= capacity) {
        refused.push(job);
        return "queue-full";
      }
      waiting.push(job);
      return "queued";
    },
    depth(): number {
      return waiting.length;
    },
    async drain(run: (job: ShadowJob) => Promise<void>): Promise<void> {
      while (waiting.length > 0) {
        const job = waiting.shift();
        if (job === undefined) {
          break;
        }
        await run(job);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The host-owned storage.
// ---------------------------------------------------------------------------

/** The storage that keeps the shadow artifacts of the application. */
export interface ReportStore {
  /** Stores one profile artifact and returns its path. */
  saveProfile(name: string, artifact: string): Promise<string>;
  /** Stores one report artifact and returns its path. */
  saveReport(run_id: string, artifact: string): Promise<string>;
  /** Every stored report path, in storage order. */
  reportPaths(): readonly string[];
}

/**
 * Creates one storage that writes JSON artifacts into one directory.
 *
 * The real application writes its tables. The interface stays the same: the
 * adapter hands over the artifact text, and the storage owns the location,
 * the format on disk, and the retention.
 */
export function createReportStore(directory: string): ReportStore & {
  /** The directory that holds the artifacts. */
  readonly directory: string;
} {
  const reportPaths: string[] = [];
  return {
    directory,
    async saveProfile(name: string, artifact: string): Promise<string> {
      const target = path.join(directory, `${name}.json`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, artifact, "utf8");
      return target;
    },
    async saveReport(run_id: string, artifact: string): Promise<string> {
      const target = path.join(directory, `${run_id}.json`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, artifact, "utf8");
      reportPaths.push(target);
      return target;
    },
    reportPaths(): readonly string[] {
      return Object.freeze([...reportPaths]);
    },
  };
}
