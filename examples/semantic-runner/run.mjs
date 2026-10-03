// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from "node:url";
import {
  createExplorationProfile, createJevEvaluator, load,
  registerEvaluators, renderRunReport,
} from "measuretwice";
import { memorySupport } from "../first-check/checks.mjs";
import { cases } from "../first-check/cases.mjs";

// These fixed provider responses test execution only. They measure no semantic quality.
export async function fixtureCall(request) {
  const index = cases.findIndex(item =>
    item.input.sources === request.state.evidence.sources &&
    item.input.candidate === request.state.evidence.candidate);
  if (index < 0) throw new Error("The fixture holds no response for these inputs.");
  const labels = ["supported", "contradicted", "insufficient"];
  const label = labels[index];
  return {
    model: "jev-1.13.0", usage: { input_tokens: 0, output_tokens: 0 },
    answers: { supported: { type: "choice", choice: label,
      probabilities: Object.fromEntries(labels.map(name => [name, name === label ? 0.9 : 0.05])) } },
  };
}

/** Trusted host code owns the provider boundary and execution budget. */
export async function runSemanticCases({ call = fixtureCall } = {}) {
  let providerCalls = 0;
  const evaluators = registerEvaluators(createJevEvaluator({
    call: (request, options) => { providerCalls += 1; return call(request, options); }, model: "jev-1.13.0",
  }));
  const profile = createExplorationProfile(memorySupport, evaluators, {
    execution: { max_active: 1, max_pending: 3, deadline_ms: 30000, max_attempts: 1, backoff_ms: 0 },
  });
  const reviewer = await load(memorySupport, { evaluators, profile });
  const reports = [];
  for (const item of cases) reports.push(await reviewer.run({ id: item.id, input: item.input }));
  return { profile, reports, provider_calls: providerCalls };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !["--live", "--json"].includes(arg))) {
      throw new Error("Use: node examples/semantic-runner/run.mjs [--live] [--json]");
    }
    let call = fixtureCall;
    if (args.includes("--live")) {
      if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Set TYPESAFE_API_KEY in the host environment.");
      const { TypeSafeClient } = await import("@typesafe-ai/sdk");
      const client = new TypeSafeClient();
      call = (request, options) => client.systemOne(request, options);
    }
    const result = await runSemanticCases({ call });
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(args.includes("--live") ? "Live evaluator. Unvalidated profile; no reliability claim." :
        "Fixed provider fixtures. No model quality measurement.");
      for (const [index, report] of result.reports.entries()) {
        console.log(renderRunReport(memorySupport, report, { caseInput: cases[index].input }));
      }
    }
    // This host declares its own process assertion. A report grants no application permission.
    process.exitCode = result.reports.some(report =>
      report.checks.some(check => check.outcome === "error" || check.outcome === "skipped")) ? 1 : 0;
  } catch {
    console.error("The semantic runner failed. Check arguments, the host SDK installation, and credentials.");
    process.exitCode = 1;
  }
}
