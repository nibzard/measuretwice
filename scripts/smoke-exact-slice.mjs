#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke check for the exact-rule vertical slice.
 *
 * The script runs one case through both authoring paths of the first
 * complete Rust-to-TypeScript workflow: TypeBox authoring through a trusted
 * import, and the exported JSON definition through one explicit file path.
 * It prints the observable result and exits with status 0 when every
 * expectation holds: equal definition hashes, byte-equal serialized reports,
 * aggregate outcome `pass`, and completion `completed`.
 *
 * The slice needs no credential, no network call, and no provider package.
 * Run `npm run build` first, because the script imports the built package.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Type from "typebox";

/** The fixed terminal time of the smoke run: 24 September 2026, midnight UTC. */
const START_MS = Date.UTC(2026, 8, 24, 0, 0, 0);

/** Load options pinned to the fixed clock and one fresh identifier sequence. */
function options() {
  let next = 0;
  return {
    now: () => START_MS,
    nextRunId: () => `run-${String(++next).padStart(6, "0")}`,
  };
}

const packageEntry = fileURLToPath(new URL("../packages/measuretwice/dist/index.js", import.meta.url));
if (!existsSync(packageEntry)) {
  process.stderr.write("measuretwice: the built package is missing. Run `npm run build` first.\n");
  process.exit(1);
}
const { defineChecks, load } = await import(packageEntry);

const definitionPath = fileURLToPath(
  new URL("../fixtures/definitions/valid/exact-rules.json", import.meta.url),
);

/** The delivery-limits checks of the shared fixtures, authored inline. */
const typed = defineChecks({
  version: 1,
  name: "delivery-limits",
  inputs: Type.Object(
    {
      summary: Type.String({ minLength: 1 }),
      notice: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "summary-length",
      name: "The summary fits the delivery limit",
      using: ["summary"],
      rule: { maxLength: 80 },
    },
    {
      id: "summary-mentions-limit",
      name: "The summary states the delivery limit",
      using: ["summary"],
      rule: { includes: "delivery limit" },
    },
    {
      id: "notice-hides-secrets",
      name: "The notice contains no secret marker",
      using: ["notice"],
      rule: { excludes: "SECRET" },
    },
  ],
});

const caseInput = {
  id: "smoke-case",
  input: {
    summary: "The delivery limit is 900 characters",
    notice: "One notice.",
  },
};

const typedReviewer = await load(typed, options());
const jsonReviewer = await load(definitionPath, options());
const typedReport = await typedReviewer.run(caseInput);
const jsonReport = await jsonReviewer.run(caseInput);

const problems = [];
if (typedReviewer.definitionHash !== jsonReviewer.definitionHash) {
  problems.push("the TypeBox artifact and the exported JSON hash differently");
}
if (JSON.stringify(typedReport) !== JSON.stringify(jsonReport)) {
  problems.push("the two authoring paths serialized different reports");
}
if (typedReport.aggregate.outcome !== "pass") {
  problems.push(`the aggregate outcome is ${typedReport.aggregate.outcome}, not pass`);
}
if (typedReport.completion.status !== "completed") {
  problems.push(`the completion status is ${typedReport.completion.status}, not completed`);
}

process.stdout.write(`measuretwice exact-rule vertical slice
definition: ${typedReport.definition.name} (contracts v${typedReport.schema_version})
definition content hash: ${typedReviewer.definitionHash}
TypeBox authoring and exported JSON agree: ${typedReviewer.definitionHash === jsonReviewer.definitionHash ? "yes" : "no"}
case: ${caseInput.id}
rule outcomes: ${typedReport.checks.map((record) => `${record.check} ${record.outcome}`).join(", ")}
aggregate outcome: ${typedReport.aggregate.outcome}
completion: ${typedReport.completion.status} at ${typedReport.completion.completed_at}
serialized reports identical: ${JSON.stringify(typedReport) === JSON.stringify(jsonReport) ? "yes" : "no"}
credentials: none, network: none, provider packages: none
`);

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`measuretwice: ${problem}.\n`);
  }
  process.exit(1);
}
process.stdout.write("SMOKE_OK\n");
