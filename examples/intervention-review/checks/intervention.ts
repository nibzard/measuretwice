// SPDX-License-Identifier: Apache-2.0
/**
 * The flagship intervention review definition of measuretwice.
 *
 * One assistant drafts one intervention message for one team discussion.
 * The definition states the four requirements that the message must meet
 * before the host considers it, and one exact delivery requirement that
 * runs in code:
 *
 * 1. An earlier decision is being contradicted (`decision-conflict`).
 * 2. The message accurately describes the evidence (`message-supported`).
 * 3. The message adds something new (`adds-information`).
 * 4. The concern warrants an interruption (`consequence`).
 * 5. The message fits the delivery limit (`message-length`).
 *
 * The reader sees the question, the authorized evidence, and the acceptable
 * answers of every check. The definition names no provider, no Jev
 * primitive, and no numerical cutoff. The profile owns the evaluator
 * binding and the decision policy, so the same requirements run unchanged
 * against another evaluator or another calibrated policy.
 *
 * The `using` lists differ on purpose. One case projects three different
 * authorized input sets, so one request never carries an input that its
 * check did not declare, and the checks cannot share one call.
 */
import Type from "typebox";
import { defineChecks } from "measuretwice";

export const intervention = defineChecks({
  version: 1,
  name: "intervention-review",
  when_uncertain: "review",
  inputs: Type.Object(
    {
      prior_decision: Type.String({ minLength: 1 }),
      conversation: Type.String({ minLength: 1 }),
      proposed_message: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "decision-conflict",
      name: "An earlier decision is being contradicted",
      using: ["prior_decision", "conversation"],
      question: "How does the new proposal relate to the earlier decision?",
      answers: {
        conflict: "It conflicts with a decision that still applies.",
        replaced: "The team explicitly replaced the earlier decision.",
        aligned: "It is compatible with the earlier decision.",
        unclear: "Applicability or the relationship cannot be established.",
      },
      accept: "conflict",
      review: "unclear",
    },
    {
      id: "message-supported",
      name: "Our message accurately describes the evidence",
      using: ["prior_decision", "conversation", "proposed_message"],
      question: "Does every material claim in the proposed message follow from the evidence?",
      answers: {
        supported: "All claims are supported with appropriate certainty and attribution.",
        contradicted: "A material claim conflicts with the supplied evidence.",
        incomplete: "Support for a material claim is missing or ambiguous.",
      },
      accept: "supported",
      review: "incomplete",
    },
    {
      id: "adds-information",
      name: "We are adding something new",
      using: ["conversation", "proposed_message"],
      question: "Has the conversation already acknowledged this concern?",
      answers: {
        yes: "A participant explicitly recognizes this specific concern.",
        no: "No supplied message explicitly recognizes this specific concern.",
      },
      accept: "no",
    },
    {
      id: "consequence",
      name: "The concern warrants an interruption",
      using: ["prior_decision", "conversation", "proposed_message"],
      question: "What consequence does this concern have, based on the evidence?",
      scale: [
        { minor: "A wording or preference difference with no identified operational consequence." },
        { meaningful: "A coordination problem causing rework or delay." },
        { serious: "A conflict affecting an explicit customer commitment or operational requirement." },
      ],
      accept: {
        at_least: "meaningful",
      },
    },
    {
      id: "message-length",
      name: "The message fits our delivery limit",
      using: ["proposed_message"],
      rule: { maxLength: 900 },
    },
  ],
});
