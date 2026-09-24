// SPDX-License-Identifier: Apache-2.0
/**
 * The synthetic records of the example application.
 *
 * Every record is invented for this lesson. No real conversation exists
 * here, no measurement was taken, and no prevalence is stated. The records
 * exercise the gates of the application and the checks of the two
 * definitions at the same time.
 *
 * The memory proposals cover one stored candidate that follows its sources,
 * one stored candidate that contradicts them, one proposal that waits for
 * one human approval, one proposal from one author without permission, and
 * one proposal whose source log breaks the input bound of the definition.
 *
 * The intervention proposals cover one draft that interrupts and passes
 * every check, one draft that repeats one acknowledged concern, one draft
 * that one cooldown stopped, and one draft in one channel that is not
 * eligible for attention.
 */
import type {
  ApplicationRecords,
  StoredMessage,
} from "./cassandra.js";

/** Builds one stored message. */
function message(
  message_id: string,
  channel: string,
  author: string,
  stored_at: string,
  text: string,
): StoredMessage {
  return { message_id, channel, author, stored_at, text };
}

// ---------------------------------------------------------------------------
// The original sources and the recent messages.
// ---------------------------------------------------------------------------

/** The source message of the deploy freeze proposal. */
const FREEZE_SOURCE = message(
  "msg-101",
  "release-planning",
  "dana",
  "2026-09-22T08:30:00Z",
  "The deploy freeze runs until Friday 18:00 UTC. No production deploy starts before that time.",
);

/** The recent messages of the deploy freeze proposal. */
const FREEZE_RECENT = [
  message("msg-102", "release-planning", "marta", "2026-09-22T08:40:00Z", "When do deploys restart?"),
  message("msg-103", "release-planning", "dana", "2026-09-22T08:45:00Z", "The freeze ends on Friday at 18:00 UTC."),
];

/** The source message of the data region proposal. */
const REGION_SOURCE = message(
  "msg-201",
  "infra",
  "priya",
  "2026-09-21T16:00:00Z",
  "Customer data stays in the EU region. The new export worker reads from the EU replica only.",
);

/** The recent messages of the data region proposal. */
const REGION_RECENT = [
  message("msg-202", "infra", "leo", "2026-09-22T09:30:00Z", "May the export worker read the US replica?"),
  message("msg-203", "infra", "priya", "2026-09-22T09:35:00Z", "The EU replica is the only permitted source."),
];

/** The source message of the quiet hours proposal. */
const QUIET_SOURCE = message(
  "msg-301",
  "ops",
  "ana",
  "2026-09-20T12:00:00Z",
  "The on-call rotation covers the weekend. Page the secondary only when the primary does not answer within 15 minutes.",
);

/** The recent messages of the quiet hours proposal. */
const QUIET_RECENT = [
  message("msg-302", "ops", "tom", "2026-09-22T10:40:00Z", "Who covers the weekend on-call?"),
  message("msg-303", "ops", "ana", "2026-09-22T10:45:00Z", "The rotation covers it. Page the secondary after 15 minutes."),
];

/** The source message of the on-call rotation proposal. */
const ROTATION_SOURCE = message(
  "msg-104",
  "release-planning",
  "dana",
  "2026-09-22T07:00:00Z",
  "The on-call rotation changes to one weekly rhythm from October.",
);

/** The recent messages of the on-call rotation proposal. */
const ROTATION_RECENT = [
  message("msg-105", "release-planning", "marta", "2026-09-22T11:50:00Z", "Who is on call next week?"),
];

/** The recent messages of the oversized proposal. One ordinary message fits. */
const OVERSIZED_RECENT = [
  message("msg-902", "infra", "leo", "2026-09-22T12:35:00Z", "The deploy log of last night holds many lines."),
];

/**
 * The source log of the oversized proposal.
 *
 * The text repeats one sentence until it breaks the 4000 code point bound of
 * the `original_sources` input. The application stores the proposal because
 * its own policy reads the candidate length alone. The shadow mapping
 * refuses the source log instead of cutting it.
 */
const OVERSIZED_LOG = message(
  "msg-901",
  "infra",
  "priya",
  "2026-09-22T12:30:00Z",
  `${"The deploy log holds one line per deploy. ".repeat(105)}`.trimEnd(),
);

// ---------------------------------------------------------------------------
// The recorded decisions.
// ---------------------------------------------------------------------------

/** The recorded EU data location decision. */
const EU_DECISION = {
  decision_id: "decision-eu-data",
  recorded_at: "2026-03-03T10:00:00Z",
  citations: ["msg-001", "msg-002"],
  text: "Decision of 3 March 2026, recorded by Dana: customer export data must remain in the EU.",
};

/** The open note that records no final decision. */
const OPEN_NOTE = {
  decision_id: "note-export-worker",
  recorded_at: "2026-09-20T09:00:00Z",
  citations: ["msg-050"],
  text:
    "Notes of 20 September 2026, recorded by Sam: the export worker question stayed open. " +
    "No final decision was recorded.",
};

/** The recorded paging rule. */
const PAGING_DECISION = {
  decision_id: "decision-paging",
  recorded_at: "2026-09-20T12:00:00Z",
  citations: ["msg-301"],
  text: "Decision of 20 September 2026, recorded by Ana: page the secondary only after 15 minutes.",
};

/** The proposal of the data-platform channel that opened the export move. */
const EXPORT_PROPOSAL = message(
  "msg-401",
  "data-platform",
  "dana",
  "2026-09-22T13:50:00Z",
  "Let us move the export worker and its data to the US region.",
);

/** The reply that already acknowledged the EU concern. */
const EXPORT_ACKNOWLEDGMENT = message(
  "msg-402",
  "data-platform",
  "sam",
  "2026-09-22T13:55:00Z",
  "That conflicts with our EU requirement. We must keep the data in the EU.",
);

/** The messages of the export move discussion with no reply. */
const EXPORT_MOVE_RECENT = [EXPORT_PROPOSAL];

/** The messages of the export move discussion with one acknowledged concern. */
const EXPORT_RAISED_RECENT = [EXPORT_PROPOSAL, EXPORT_ACKNOWLEDGMENT];

/** The messages of the morning discussion inside the cooldown. */
const EXPORT_COOLDOWN_RECENT = [
  message("msg-405", "data-platform", "dana", "2026-09-22T07:55:00Z", "The export worker move needs one decision."),
  message("msg-406", "data-platform", "sam", "2026-09-22T07:58:00Z", "The notes state no final decision."),
];

/** The messages of the paging discussion. */
const PAGING_RECENT = [
  message("msg-304", "ops", "tom", "2026-09-22T15:30:00Z", "I paged the primary twice. No answer."),
  message("msg-305", "ops", "tom", "2026-09-22T15:35:00Z", "May I page the secondary now?"),
];

/** The drafted intervention of the export move. */
const EXPORT_DRAFT =
  "This move conflicts with our EU data location requirement. Keep the export data in the EU.";

// ---------------------------------------------------------------------------
// The records of the application.
// ---------------------------------------------------------------------------

/**
 * The records and the rules of the example application.
 *
 * The cooldown of `data-platform` ends at noon of 22 September 2026: one
 * incident interrupted the channel in the morning, so the 08:00 draft stayed
 * quiet and the later drafts interrupted.
 */
export const CASSANDRA_RECORDS: ApplicationRecords = {
  channels: [
    {
      channel: "release-planning",
      attention_eligible: true,
      intervention_cooldown_until: "2026-09-01T00:00:00Z",
      memory_approval_mode: "automatic",
      memory_authors: ["dana", "marta"],
    },
    {
      channel: "infra",
      attention_eligible: true,
      intervention_cooldown_until: "2026-09-01T00:00:00Z",
      memory_approval_mode: "automatic",
      memory_authors: ["priya"],
    },
    {
      channel: "data-platform",
      attention_eligible: true,
      intervention_cooldown_until: "2026-09-22T12:00:00Z",
      memory_approval_mode: "automatic",
      memory_authors: ["dana", "sam"],
    },
    {
      channel: "ops",
      attention_eligible: false,
      intervention_cooldown_until: "2026-09-01T00:00:00Z",
      memory_approval_mode: "human",
      memory_authors: ["ana"],
    },
  ],
  memory_proposals: [
    {
      proposal_id: "deploy-freeze-window",
      channel: "release-planning",
      author: "dana",
      proposed_at: "2026-09-22T09:00:00Z",
      sources: [FREEZE_SOURCE],
      recent_messages: FREEZE_RECENT,
      candidate_text: "Deploy freeze until Friday 18:00 UTC.",
    },
    {
      proposal_id: "data-region-move",
      channel: "infra",
      author: "priya",
      proposed_at: "2026-09-22T10:00:00Z",
      sources: [REGION_SOURCE],
      recent_messages: REGION_RECENT,
      candidate_text: "The export worker may read the US replica.",
    },
    {
      proposal_id: "quiet-hours",
      channel: "ops",
      author: "ana",
      proposed_at: "2026-09-22T11:00:00Z",
      sources: [QUIET_SOURCE],
      recent_messages: QUIET_RECENT,
      candidate_text: "The team avoids production deploys during quiet hours.",
    },
    {
      proposal_id: "on-call-rotation",
      channel: "release-planning",
      author: "leo",
      proposed_at: "2026-09-22T12:00:00Z",
      sources: [ROTATION_SOURCE],
      recent_messages: ROTATION_RECENT,
      candidate_text: "On-call rotation changes to one week per person.",
    },
    {
      proposal_id: "incident-log-oversized",
      channel: "infra",
      author: "priya",
      proposed_at: "2026-09-22T13:00:00Z",
      sources: [OVERSIZED_LOG],
      recent_messages: OVERSIZED_RECENT,
      candidate_text: "Deploy log holds one line per deploy.",
    },
  ],
  intervention_proposals: [
    {
      proposal_id: "eu-export-move",
      channel: "data-platform",
      proposed_at: "2026-09-22T14:00:00Z",
      decision: EU_DECISION,
      recent_messages: EXPORT_MOVE_RECENT,
      drafted_message: EXPORT_DRAFT,
    },
    {
      proposal_id: "eu-export-already-raised",
      channel: "data-platform",
      proposed_at: "2026-09-22T15:00:00Z",
      decision: EU_DECISION,
      recent_messages: EXPORT_RAISED_RECENT,
      drafted_message: EXPORT_DRAFT,
    },
    {
      proposal_id: "eu-export-cooldown",
      channel: "data-platform",
      proposed_at: "2026-09-22T08:00:00Z",
      decision: OPEN_NOTE,
      recent_messages: EXPORT_COOLDOWN_RECENT,
      drafted_message: EXPORT_DRAFT,
    },
    {
      proposal_id: "paging-rule-reminder",
      channel: "ops",
      proposed_at: "2026-09-22T16:00:00Z",
      decision: PAGING_DECISION,
      recent_messages: PAGING_RECENT,
      drafted_message:
        "This paging conflicts with our 15 minute rule. Page the secondary for the open incident.",
    },
  ],
};
