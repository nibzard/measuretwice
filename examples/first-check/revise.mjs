// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from "node:url";
import {
  createExplorationProfile, createScriptedEvaluator, load,
  registerEvaluators, renderRunReport, ValidationError,
} from "measuretwice";
import { memorySupport } from "./checks.mjs";
import { attributedMemory } from "./checks-attribution.mjs";

export async function runRequirementRevision({ log = console.log } = {}) {
  // These synthetic cases and answers are unreviewed model proposals.
  const labels = ["contradicted", "supported", "insufficient"];
  const evaluator = createScriptedEvaluator({ steps: labels.map(label => ({
    answer: { assessment: {
      kind: "categorical", label,
      distribution: labels.map(name => ({ name, mass: name === label ? 0.9 : 0.05 })),
    } },
  })) });
  const evaluators = registerEvaluators(evaluator);
  const oldProfile = createExplorationProfile(memorySupport, evaluators);
  let oldProfileError;
  try {
    await load(attributedMemory, { profile: oldProfile, evaluators });
  } catch (error) {
    if (!(error instanceof ValidationError) || error.code !== "definition_mismatch") throw error;
    oldProfileError = error;
  }
  if (!oldProfileError) throw new Error("The revised requirement accepted the old profile.");
  const callsBeforeNewProfile = evaluator.calls.length;
  const profile = createExplorationProfile(attributedMemory, evaluators);
  const reviewer = await load(attributedMemory, { profile, evaluators });
  const cases = [
    { id: "speaker-missing", input: {
      sources: "Dana confirms Friday for the launch.", candidate: "The launch is Friday.",
    } },
    { id: "speaker-named", input: {
      sources: "Dana confirms Friday for the launch.", candidate: "Dana confirms the launch is Friday.",
    } },
    { id: "speaker-unknown", input: {
      sources: "The launch is Friday. No speaker is identified.", candidate: "Dana confirms the launch is Friday.",
    } },
  ];
  const lines = [
    "Requirement revision: the memory must now name the speaker.",
    `Old profile refused: ${oldProfileError.code}. No assessment ran.`,
    "Reassess cases under the revised requirement.",
    "New profile: unvalidated. Earlier qualification cannot transfer.",
    "Scripted answers verify the workflow, not model quality.",
    "Cases and labels: synthetic, model-proposed, and unreviewed.",
  ];
  const reports = [];
  for (const item of cases) {
    const report = await reviewer.run(item);
    reports.push(report);
    lines.push("", `Case: ${item.id}`, `Sources: ${item.input.sources}`,
      `Candidate: ${item.input.candidate}`, "", renderRunReport(attributedMemory, report));
  }
  const summary = lines.join("\n");
  log(summary);
  return { oldProfileError, callsBeforeNewProfile, profile, reports, summary };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runRequirementRevision();
}
