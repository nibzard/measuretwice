// SPDX-License-Identifier: Apache-2.0
/**
 * The plan review definition: the second application of measuretwice.
 *
 * One vendor drafts one implementation plan for one customer. The plan
 * answers three supplied documents: the requirements of the customer, the
 * capability documentation of the current product, and the plan text that
 * the drafter wrote. Five checks decide whether the host may send the plan:
 *
 * 1. The plan addresses every stated requirement (`requirement-coverage`).
 * 2. The plan uses documented capabilities (`capability-fit`).
 * 3. The plan adds no unrequested work (`unrequested-work`).
 * 4. The plan is ready to deliver (`delivery-readiness`).
 * 5. The plan states one rollback step (`rollback-section`).
 *
 * This application shares no domain with the memory and intervention
 * examples. It exists to test the portability of the same contracts: the
 * authoring format, the case records, the evaluator requests, the profile
 * artifacts, and the report semantics. The definition names no provider,
 * no Jev primitive, and no numerical cutoff. The profile owns the evaluator
 * binding and the decision policy.
 *
 * The `using` lists differ on purpose. `requirement-coverage` and
 * `unrequested-work` read the same two inputs, so one adapter may batch the
 * two questions inside one identical authorized state. `capability-fit`
 * reads the documentation instead of the requirements, and
 * `delivery-readiness` reads all three inputs. One case projects three
 * different authorized input sets, so one request never carries one input
 * that its check did not declare.
 */
import Type from "typebox";
import { defineChecks } from "measuretwice";

export const planReview = defineChecks({
  version: 1,
  name: "plan-review",
  when_uncertain: "review",
  inputs: Type.Object(
    {
      customer_requirements: Type.String({ minLength: 1 }),
      capability_notes: Type.String({ minLength: 1 }),
      proposed_plan: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "requirement-coverage",
      name: "The plan addresses every stated requirement",
      using: ["customer_requirements", "proposed_plan"],
      question: "Does the plan address every requirement the customer stated?",
      answers: {
        covered: "Every stated requirement maps to one step of the plan.",
        partial: "The plan maps some requirements, and the mapping of another stays open or ambiguous.",
        unaddressed: "One stated requirement maps to no step of the plan.",
      },
      accept: "covered",
      review: "partial",
    },
    {
      id: "capability-fit",
      name: "The plan uses documented capabilities",
      using: ["capability_notes", "proposed_plan"],
      question: "Does every capability and limit the plan names appear in the supplied capability documentation?",
      answers: {
        documented: "Every named capability, limit, and configuration value appears in the documentation.",
        absent: "The plan names one capability or value that the documentation does not offer.",
        unclear: "The documentation neither offers nor excludes one named capability or value.",
      },
      accept: "documented",
      review: "unclear",
    },
    {
      id: "unrequested-work",
      name: "The plan adds no unrequested work",
      using: ["customer_requirements", "proposed_plan"],
      question: "Does the plan contain work that no stated requirement asks for?",
      answers: {
        yes: "The plan contains one work item that no stated requirement asks for.",
        no: "Every work item of the plan serves one stated requirement.",
      },
      accept: "no",
    },
    {
      id: "delivery-readiness",
      name: "The plan is ready to deliver",
      using: ["customer_requirements", "capability_notes", "proposed_plan"],
      question: "How ready is this plan for delivery as written?",
      scale: [
        { sketch: "The plan lists steps with no owners, no sequence, and no verification." },
        { workable: "The plan sequences the work with owners and one verification step." },
        { complete: "The plan also covers migration, rollback, and acceptance with the customer." },
      ],
      accept: {
        at_least: "workable",
      },
    },
    {
      id: "rollback-section",
      name: "The plan states one rollback step",
      using: ["proposed_plan"],
      rule: { includes: "Rollback" },
    },
  ],
});
