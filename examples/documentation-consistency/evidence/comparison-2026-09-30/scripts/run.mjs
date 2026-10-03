// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import Type from "typebox";
import { createExplorationProfile, createJevEvaluator, defineChecks, load, registerEvaluators, renderRunReport } from "measuretwice";
import { MODEL, POLICY, QUESTION } from "./task.mjs";
import { runDirect } from "./direct.mjs";
import { prepare } from "./prepare.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");

export async function runPair(cases, call) {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 6) throw new Error("Use 1 to 6 cases per comparison.");
  const definition = defineChecks({ version: 1, name: "documentation-comparison",
    inputs: Type.Object({ evidence: Type.String({ minLength: 1, maxLength: 4000 }), candidate: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }),
    checks: [{ id: "requirement", name: "Documentation follows its contract", using: ["evidence", "candidate"],
      question: QUESTION.instructions, answers: QUESTION.criteria, accept: "supported", review: "insufficient" }],
  });
  const registry = registerEvaluators(createJevEvaluator({ model: MODEL, call }));
  const profile = createExplorationProfile(definition, registry, { starter: POLICY,
    execution: { max_active: 1, max_pending: 1, deadline_ms: 30000, max_attempts: 1, backoff_ms: 0 } });
  const reviewer = await load(definition, { profile, evaluators: registry });
  const direct = [], reports = [], rows = [];
  for (const [index, item] of cases.entries()) {
    let baseline, report;
    // Alternate execution order. This is an engineering run, with no participant observations.
    if (index % 2 === 0) {
      baseline = await runDirect(item, call);
      report = await reviewer.run({ id: item.id, input: item.input });
    } else {
      report = await reviewer.run({ id: item.id, input: item.input });
      baseline = await runDirect(item, call);
    }
    direct.push(baseline); reports.push(report);
    rows.push({ case: item.id, first: index % 2 === 0 ? "direct" : "measuretwice",
      direct: baseline.outcome, measuretwice: report.aggregate.outcome,
      direct_label: baseline.assessment?.label ?? null, measuretwice_label: report.checks[0].assessment?.label ?? null });
  }
  return { definition, profile, direct, reports, rows };
}

export function fixtureCall(request) {
  // Fixed raw measurements test policy abstention and execution. They assess no text.
  const text = request.state.evidence.candidate;
  const contradicted = text.includes("UTF-16 code units. One emoji") || text.includes("accept_cutoff 0.6");
  const omitted = !request.state.evidence.evidence.includes("Default: shadow") && text.includes("**Modes:");
  const label = contradicted ? "contradicted" : omitted ? "insufficient" : "supported";
  const probabilities = label === "supported" && text.includes("Default starter")
    ? { supported: 0.76, contradicted: 0.1, insufficient: 0.14 }
    : Object.fromEntries(Object.keys(QUESTION.criteria).map(name => [name, name === label ? 0.9 : 0.05]));
  return { model: MODEL, usage: { input_tokens: 0, output_tokens: 0 },
    answers: { requirement: { type: "choice", choice: label, probabilities } } };
}

async function main() {
  const mode = process.argv[2];
  if (!["offline", "live"].includes(mode) || process.argv.length !== 3) throw new Error("Use: node comparison/run.mjs offline|live");
  const prepared = await prepare();
  const outputRoot = path.resolve(directory, "../build/comparison");
  await mkdir(outputRoot, { recursive: true });
  const out = await mkdtemp(path.join(outputRoot, mode + "-"));
  const save = (name, data) => writeFile(path.join(out, name), JSON.stringify(data, null, 2) + "\n");
  await save("cases.json", prepared.cases); await save("proposed-references.json", prepared.references);
  await save("sources.json", prepared.sources); await writeFile(path.join(out, "REVIEW.md"), prepared.review);
  let call = fixtureCall;
  if (mode === "live") {
    if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Set TYPESAFE_API_KEY through the host credential mechanism.");
    const require = createRequire(path.resolve(directory, "../build/comparison-client/package.json"));
    if (require("@typesafe-ai/sdk/package.json").version !== "0.6.0") throw new Error("Install the pinned host SDK 0.6.0.");
    const { TypeSafeClient } = require("@typesafe-ai/sdk");
    const client = new TypeSafeClient({ logLevel: "off" });
    call = (request, options) => client.systemOne(request, options);
  }
  const invocations = [];
  const wrapped = async (request, options) => {
    invocations.push({ request, timeout_ms: options.timeout, sdk_retries: options.retry.maxRetries });
    return call(request, options);
  };
  const started = performance.now();
  const result = await runPair(prepared.cases, wrapped);
  const wall_ms = Math.round(performance.now() - started);
  const usage = records => records.reduce((sum, record) => ({
    input_tokens: sum.input_tokens + (record.usage?.input_tokens ?? 0),
    output_tokens: sum.output_tokens + (record.usage?.output_tokens ?? 0),
  }), { input_tokens: 0, output_tokens: 0 });
  const summary = { mode, case_count: prepared.cases.length, provider_calls: invocations.length, wall_ms,
    direct_usage: usage(result.direct), measuretwice_usage: usage(result.reports.map(run => run.checks[0])),
    integration_matches: result.rows.filter(row => row.direct === row.measuretwice).length,
    proposed_reference_matches: Object.fromEntries(["direct", "measuretwice"].map(integration => [integration,
      result.rows.filter((row, i) => row[integration] === ({ supported: "pass", contradicted: "fail", insufficient: "review" })[prepared.references[i].answer]).length])),
    operational_errors: result.rows.filter(row => row.direct === "error" || row.measuretwice === "error").length,
    qualification: "unvalidated", human_reviewed_labels: 0, participant_observations: 0,
    setup_effort: "not measured as a participant trial", currency_cost: "not measured" };
  const files = ["task.mjs", "prepare.mjs", "direct.mjs", "run.mjs"];
  await save("execution.json", { timestamp: new Date().toISOString(), model: MODEL, sdk: mode === "live" ? "0.6.0" : null,
    base_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    worktree: "uncommitted source snapshot; source hashes are recorded", max_provider_calls: 12,
    deadline_ms_per_call: 30000, max_attempts: 1, policy: POLICY,
    scripts: await Promise.all(files.map(async name => ({ name, sha256: createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex") }))) });
  for (const [name, data] of [["definition.json", result.definition], ["profile.json", result.profile], ["direct.json", result.direct],
    ["runs.json", result.reports], ["comparison.json", result.rows], ["requests.json", invocations], ["summary.json", summary]]) await save(name, data);
  await writeFile(path.join(out, "readable.txt"), result.reports.map((run, i) => renderRunReport(result.definition, run,
    { detail: "detail", caseInput: prepared.cases[i].input })).join("\n\n"));
  console.table(result.rows); console.log(JSON.stringify(summary)); console.log(`Saved: ${out}`);
  process.exitCode = summary.operational_errors > 0 ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("Comparison setup failed. Check the command, source excerpts, host SDK, and credentials."); process.exitCode = 1; });
}
