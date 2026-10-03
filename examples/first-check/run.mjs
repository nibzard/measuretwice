// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from "node:url";
import {
  createExplorationProfile, createScriptedEvaluator, load,
  registerEvaluators, renderRunReport,
} from "measuretwice";
import { memorySupport } from "./checks.mjs";
import { cases } from "./cases.mjs";

export async function runFirstCheck({ detail = "summary", log = console.log } = {}) {
  // Fixed adapter output verifies the workflow. Reference labels do not reach the evaluator.
  const labels = ["supported", "contradicted", "insufficient"];
  const evaluator = createScriptedEvaluator({ steps: labels.map(label => ({
    answer: { assessment: {
      kind: "categorical", label,
      distribution: labels.map(name => ({ name, mass: name === label ? 0.9 : 0.05 })),
    } },
  })) });
  const evaluators = registerEvaluators(evaluator);
  const profile = createExplorationProfile(memorySupport, evaluators);
  const reviewer = await load(memorySupport, { profile, evaluators });
  const reports = [];
  const lines = [
    "First check: memory support",
    "Scripted evaluator: fixed answers, no model quality measurement.",
    "References: synthetic, model-proposed, and unreviewed.",
    "Profile: unvalidated. Use for exploration only.",
  ];
  for (const item of cases) {
    const report = await reviewer.run({ id: item.id, input: item.input });
    reports.push(report);
    lines.push("", `Case: ${item.id}`, `Sources: ${item.input.sources}`,
      `Candidate: ${item.input.candidate}`, `Proposed reference: ${item.reference}`,
      "", renderRunReport(memorySupport, report, { detail, caseInput: item.input }));
  }
  const summary = lines.join("\n");
  log(summary);
  return { profile, evaluator, reports, summary };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runFirstCheck({ detail: process.argv.includes("--detail") ? "detail" : "summary" });
}
