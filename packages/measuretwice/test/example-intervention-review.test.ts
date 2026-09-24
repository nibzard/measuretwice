// SPDX-License-Identifier: Apache-2.0
/**
 * The public intervention review example, executed offline.
 *
 * Task T059 ships the example under `examples/intervention-review`. This
 * suite builds the example through its own TypeScript configuration,
 * exactly as one host application does, then runs it against the offline
 * test evaluator. The suite checks the boundary that the example teaches:
 * the complete flagship definition with its Choice, Noul, Score, and exact
 * rule checks, the three projected input sets of the four question checks,
 * the explicitly unvalidated exploration profile, the recorded baseline
 * beside the unchanged host decision, the aggregate rule that no check
 * compensates for another, the host-owned storage of the profile and every
 * report, and the private-data defaults that keep case content out of
 * every stored report. It reads local files only, so it stays offline and
 * free. The run identifiers and the terminal times come from the host
 * defaults, so the suite compares structure, never one complete artifact.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  renderRunReport,
  type Definition,
  type Dataset,
  type Profile,
  type RunOptions,
  type RunReport,
  type ScriptedEvaluator,
  type ValidationError,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exampleDir = path.join(repoRoot, "examples", "intervention-review");
const builtHost = path.join(exampleDir, "build", "host.js");
const builtChecks = path.join(exampleDir, "build", "checks", "intervention.js");
const builtExport = path.join(exampleDir, "build", "export-definition.js");
const committedExport = path.join(exampleDir, "definitions", "intervention-review.json");
const packageEntry = path.join(repoRoot, "packages", "measuretwice", "dist", "index.js");
const cliEntry = path.join(repoRoot, "packages", "measuretwice", "dist", "cli.js");

/**
 * The compiled example result.
 *
 * The suite imports the compiled modules dynamically, because the example
 * owns its own build. This interface states the fields the suite reads.
 */
interface ExampleResult {
  readonly dataset: Dataset;
  readonly profile: Profile;
  readonly reviewer: { run(caseInput: unknown, options?: RunOptions): Promise<RunReport> };
  readonly evaluator: ScriptedEvaluator;
  readonly reports: readonly RunReport[];
  readonly storedProfile: string;
  readonly storedReports: readonly string[];
  readonly summary: string;
}

/** The compiled `runExample` operation of the example. */
type RunExample = (options: { readonly out: string; readonly log: (text: string) => void }) => Promise<ExampleResult>;

/** The compiled `exportDefinition` operation of the export script. */
type ExportDefinition = (options: { readonly out: string }) => Promise<string>;

/** The example run that every test reads. Built once, before the tests. */
let result: ExampleResult;

/** The compiled flagship definition, imported through the example build. */
let definition: Definition;

/** The directory that holds the stored profile and reports of the run. */
let out = "";

/** The case identifiers of the dataset, in file order. */
const CASE_IDS = [
  "eu-move-new-concern",
  "eu-move-already-discussed",
  "eu-move-overstated-record",
  "eu-move-replaced-decision",
  "eu-move-unrecorded-decision",
  "eu-move-verbose-message",
];

/** The identifiers of the question checks, in definition order. */
const QUESTION_CHECKS = ["decision-conflict", "message-supported", "adds-information", "consequence"];

/** Folds the component outcomes with the aggregate rule of MVP_SPEC.md section 9. */
function foldOutcome(outcomes: readonly string[]): string {
  if (outcomes.includes("fail")) {
    return "fail";
  }
  if (outcomes.includes("error")) {
    return "error";
  }
  if (outcomes.includes("review") || outcomes.includes("skipped")) {
    return "review";
  }
  return "pass";
}

beforeAll(async () => {
  expect(existsSync(packageEntry), "build the package before the tests").toBe(true);
  // One host application imports the definition through its own build, so
  // the suite builds the example the same way. One type error in the example
  // fails here, before any test runs.
  execFileSync(
    process.execPath,
    [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(exampleDir, "tsconfig.json")],
    { cwd: repoRoot, stdio: "pipe" },
  );
  const checks = (await import(pathToFileURL(builtChecks).href)) as { intervention: Definition };
  definition = checks.intervention;
  const host = (await import(pathToFileURL(builtHost).href)) as { runExample: RunExample };
  out = mkdtempSync(path.join(tmpdir(), "measuretwice-intervention-"));
  result = await host.runExample({ out, log: () => {} });
}, 120_000);

afterAll(() => {
  if (out !== "") {
    rmSync(out, { recursive: true, force: true });
  }
  rmSync(path.join(exampleDir, "build"), { recursive: true, force: true });
});

test("the example builds through its own TypeScript configuration and loads its definition", () => {
  // The compiled entry and the definition module exist, and the trusted
  // import crossed the core validation inside `defineChecks`.
  expect(result.dataset.definition.name).toBe("intervention-review");
  expect(result.profile.definition.name).toBe("intervention-review");
  expect(result.profile.definition.content_hash).toBe(result.dataset.definition.content_hash);
  // The complete flagship shape: four question checks of three kinds, and
  // one exact rule that names no provider detail.
  expect(definition.checks.map((check) => check.id)).toEqual([
    ...QUESTION_CHECKS,
    "message-length",
  ]);
  expect(definition.checks[4]).toEqual({
    id: "message-length",
    name: "The message fits our delivery limit",
    using: ["proposed_message"],
    rule: { maxLength: 900 },
  });
  // The definition states no provider detail: no primitive name, no model,
  // no evaluator, and no numerical cutoff. The profile owns both.
  const text = JSON.stringify(definition);
  for (const forbidden of ["jev", "model", "provider", "evaluator", "cutoff", "confidence"]) {
    expect(text, `the definition states no ${forbidden}`).not.toContain(forbidden);
  }
});

test("the committed export equals the definition and the CLI validates it", async () => {
  // The trusted export script writes the same artifact again, byte for
  // byte, so the committed JSON definition cannot drift from the
  // TypeScript definition.
  const exporter = (await import(pathToFileURL(builtExport).href)) as {
    exportDefinition: ExportDefinition;
  };
  const regenerated = path.join(out, "regenerated.json");
  await exporter.exportDefinition({ out: regenerated });
  expect(readFileSync(regenerated, "utf8")).toBe(readFileSync(committedExport, "utf8"));
  expect(JSON.parse(readFileSync(committedExport, "utf8"))).toEqual(definition);

  // The CLI reads the exported artifact. It executes no TypeScript source.
  const run = await execFileAsync(process.execPath, [cliEntry, "validate", committedExport]);
  expect(run.stdout).toContain("intervention-review · valid definition");
  expect(run.stdout).toContain("Checks: 5 (1 exact rules, 4 question checks)");
}, 60_000);

test("the cases cover the five scenario kinds with model-proposed provenance", () => {
  const cases = result.dataset.cases;
  expect(cases.map((record) => record.id)).toEqual(CASE_IDS);
  expect(cases.map((record) => record.expected?.outcome)).toEqual([
    "pass",
    "fail",
    "fail",
    "fail",
    "review",
    "fail",
  ]);
  // The decisive reference label of each scenario: one acknowledged
  // concern, one contradicted claim, one replaced decision, and one
  // unresolved consequence level.
  expect(cases[1]?.expected?.checks["adds-information"]).toMatchObject({ answer: "yes", outcome: "fail" });
  expect(cases[2]?.expected?.checks["message-supported"]).toMatchObject({
    answer: "contradicted",
    outcome: "fail",
  });
  expect(cases[3]?.expected?.checks["decision-conflict"]).toMatchObject({
    answer: "replaced",
    outcome: "fail",
  });
  expect(cases[4]?.expected?.checks["decision-conflict"]).toMatchObject({
    answer: "unclear",
    outcome: "review",
  });
  expect(cases[4]?.expected?.checks["consequence"]).toEqual({ review: true });
  expect(cases[5]?.expected?.checks["message-length"]).toEqual({ outcome: "fail" });

  // The dataset is one development fixture. It supports no qualification
  // claim, and every reference is one unreviewed model proposal.
  const identity = result.dataset.identity;
  expect(identity.kind).toBe("development_fixture");
  expect(identity.population).toBe("development_fixture");
  expect(identity.supports_qualification).toBe(false);
  expect(identity.states_prevalence).toBe(false);
  const labels = result.dataset.labels;
  expect(labels.findings).toEqual([]);
  expect(labels.summary.records).toBe(6);
  expect(labels.summary.labeled).toBe(6);
  expect(labels.summary.model_unreviewed).toBe(6);
  expect(labels.summary.human_reviewed).toBe(0);
});

test("the evaluator receives only the inputs that the check authorized", () => {
  const calls = result.evaluator.calls;
  // Four question checks per case, one question per request, and the exact
  // rule consumes no evaluator call.
  expect(calls).toHaveLength(6 * QUESTION_CHECKS.length);
  expect(calls.map((request) => request.check)).toEqual(
    CASE_IDS.flatMap(() => QUESTION_CHECKS),
  );
  // The three projected input sets of the guide: the decision and the
  // discussion, the discussion and the draft, and all three inputs.
  const projected = new Set(calls.map((request) => Object.keys(request.inputs).sort().join("+")));
  expect(projected).toEqual(
    new Set(["conversation+prior_decision", "conversation+proposed_message", "conversation+prior_decision+proposed_message"]),
  );
  for (const request of calls) {
    const check = definition.checks.find((named) => named.id === request.check);
    expect(check, `the check ${request.check} belongs to the definition`).toBeDefined();
    expect(request.using).toEqual(check!.using);
    expect(Object.keys(request.inputs).sort()).toEqual([...check!.using].sort());
    // No reference label, no provenance record, and no undeclared input
    // crosses the boundary.
    expect(JSON.stringify(request)).not.toContain("expected");
    expect(JSON.stringify(request)).not.toContain("author_type");
  }
  // The question kinds match the guide: two Choice questions, one Noul
  // question, and one Score question.
  expect(calls.slice(0, 4).map((request) => request.question.kind)).toEqual([
    "categorical",
    "categorical",
    "binary",
    "ordered",
  ]);
});

test("the generated profile is explicitly unvalidated and binds no rule check", () => {
  expect(result.profile.origin).toBe("exploration");
  expect(result.profile.qualification.status).toBe("unvalidated");
  expect(result.profile.qualification.reasons).toEqual(["starter_policy"]);
  expect(result.profile.policy.family).toBe("probability_mass_v0");
  const policyChecks = result.profile.policy.checks ?? [];
  expect(policyChecks.map((entry) => entry.check)).toEqual(QUESTION_CHECKS);
  for (const entry of policyChecks) {
    expect(entry).toMatchObject({ accept_cutoff: 0.8, rejection_cutoff: 0.6 });
  }
  expect(result.profile.intended_use).toContain("Not a measured population");
});

test("each shadow run records the host baseline beside the new outcome", () => {
  expect(result.reports).toHaveLength(6);
  // The existing policy interrupts on the trigger phrase. The
  // missing-evidence draft holds none, so the host stayed quiet there.
  expect(result.reports.map((report) => report.baseline?.revision)).toEqual(
    Array.from({ length: 6 }, () => "cassandra-policy-1"),
  );
  expect(result.reports.map((report) => report.baseline?.outcome)).toEqual([
    "interrupt",
    "interrupt",
    "interrupt",
    "interrupt",
    "stay-quiet",
    "interrupt",
  ]);
  // The scripted answers decide one pass, three distinct failures, one
  // review, and one exact-rule failure.
  expect(result.reports.map((report) => report.aggregate.outcome)).toEqual([
    "pass",
    "fail",
    "fail",
    "fail",
    "review",
    "fail",
  ]);
  for (const report of result.reports) {
    expect(report.mode).toBe("shadow");
    expect(report.completion.status).toBe("completed");
    expect(report.checks.map((record) => record.check)).toEqual([
      ...QUESTION_CHECKS,
      "message-length",
    ]);
    for (const record of report.checks.slice(0, 4)) {
      expect(record).toMatchObject({
        kind: "question",
        evaluator: { id: "scripted-test", adapter_version: "0.1.0" },
        applied_policy: { accept_cutoff: 0.8, rejection_cutoff: 0.6 },
      });
    }
  }
  // The duplicated case fails through the binary answer alone: the value
  // `yes` carries all the mass on the one unacceptable answer.
  const duplicated = result.reports[1]!.checks;
  expect(duplicated.map((record) => record.outcome)).toEqual([
    "pass",
    "pass",
    "fail",
    "pass",
    "pass",
  ]);
  expect(duplicated[2]?.assessment).toEqual({ kind: "binary", value: true });
  // The over-length case passes every question and fails in code.
  const verbose = result.reports[5]!.checks;
  expect(verbose.map((record) => record.outcome)).toEqual([
    "pass",
    "pass",
    "pass",
    "pass",
    "fail",
  ]);
  expect(verbose[4]).toMatchObject({
    kind: "rule",
    outcome: "fail",
    applied_rule: {
      rule: "maxLength",
      input: "proposed_message",
      parameters: { maxLength: 900 },
    },
  });
  expect(verbose[4]?.evaluator).toBeUndefined();
});

test("the aggregate folds the component outcomes and shares the report semantics", () => {
  for (const report of result.reports) {
    const outcomes = report.checks.map((record) => record.outcome);
    expect(report.aggregate.outcome, `the aggregate of ${report.case.id}`).toBe(
      foldOutcome(outcomes),
    );
    // The shared renderer verifies the same report again: the definition
    // hash, the check names, and the stored aggregate must agree.
    expect(() => renderRunReport(definition, report)).not.toThrow();
  }
});

test("a serious consequence cannot compensate for one failed requirement", () => {
  // Three cases pass the consequence check and still fail: the duplicated
  // concern, the contradicted claim, and the over-length draft.
  const uncompensated = result.reports.filter((report) => {
    const consequence = report.checks.find((record) => record.check === "consequence");
    return consequence?.outcome === "pass" && report.aggregate.outcome === "fail";
  });
  expect(uncompensated.map((report) => report.case.id)).toEqual([
    "eu-move-already-discussed",
    "eu-move-overstated-record",
    "eu-move-verbose-message",
  ]);
  expect(result.summary).toContain(
    "The consequence check passed in 3 cases whose aggregate failed.",
  );
  expect(result.summary).toContain("A serious consequence cannot compensate for one failed requirement");
  // The renderer states the same rule beside the stored aggregate.
  const rendered = renderRunReport(definition, result.reports[1]!);
  expect(rendered).toContain("A pass on another check cannot compensate.");
});

test("the missing-evidence case reviews through its review labels and one abstention", () => {
  const review = result.reports[4]!;
  expect(review.checks.map((record) => record.outcome)).toEqual([
    "review",
    "review",
    "pass",
    "review",
    "pass",
  ]);
  // The two categorical answers select the declared review labels.
  expect(review.checks[0]?.assessment).toMatchObject({ kind: "categorical", label: "unclear" });
  expect(review.checks[1]?.assessment).toMatchObject({ kind: "categorical", label: "incomplete" });
  // The ordered distribution meets neither cutoff, so the policy abstains.
  const consequence = review.checks[3]!;
  expect(consequence.assessment).toMatchObject({ kind: "ordered", level: "minor" });
  const rendered = renderRunReport(definition, review);
  expect(rendered).toContain("It is a review answer of this check.");
  expect(rendered).toContain("Neither cutoff was met");
  expect(rendered).toContain("Overall: REVIEW");
});

test("the summary names the scripted answer that disagrees with its reference", () => {
  // The replaced-decision case reads one conflict where the record states
  // one replacement. The aggregate still fails through the other checks,
  // so only the per-check comparison exposes the disagreement.
  const replaced = result.reports[3]!;
  expect(replaced.checks[0]?.outcome).toBe("pass");
  expect(result.dataset.cases[3]?.expected?.checks["decision-conflict"]?.outcome).toBe("fail");
  expect(result.summary).toContain(
    "eu-move-replaced-decision · decision-conflict: candidate pass, reference fail. Review it.",
  );
});

test("the host stores the profile and every report, and no report holds case content", () => {
  expect(result.storedReports).toHaveLength(6);
  for (const [index, stored] of result.storedReports.entries()) {
    const text = readFileSync(stored, "utf8");
    expect(JSON.parse(text), `report ${index} round-trips through host storage`).toEqual(
      result.reports[index],
    );
    // The rule record names its input by its declared name, so the canaries
    // are case content, never input names.
    expect(text).not.toContain("customer export data");
    expect(text).not.toContain("US region");
    expect(text).not.toContain("Security blocked");
    expect(text).not.toContain("data-platform");
    expect(text).not.toContain("Dana");
  }
  const profileArtifact = JSON.parse(readFileSync(result.storedProfile, "utf8")) as Profile;
  expect(profileArtifact.content_hash).toBe(result.profile.content_hash);
  expect(profileArtifact.qualification.status).toBe("unvalidated");
});

test("the summary states the unvalidated profile, the provenance, and the limits", () => {
  expect(result.summary).toContain("unvalidated · starter_policy");
  expect(result.summary).toContain("baseline interrupt · candidate pass · reference pass");
  expect(result.summary).toContain("candidate fail · reference fail · failed: message-length");
  expect(result.summary).toContain("baseline stay-quiet · candidate review · reference review");
  expect(result.summary).toContain("6 model-proposed without one human review");
  expect(result.summary).toContain("Six synthetic cases support no performance claim.");
  expect(result.summary).toContain("A shadow run sent no message.");
});

test("enforcement refuses the unvalidated profile before any case work", async () => {
  const caseInput = result.dataset.runCase(result.dataset.cases[0]!);
  const failure = await result.reviewer
    .run(caseInput, { mode: "enforcement" })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  // The compiled example answers through the built package, so its error
  // class is one other module instance than the `ValidationError` of the
  // suite. The refusal crosses with its stable code and field path.
  expect(failure).toBeInstanceOf(Error);
  expect((failure as { code?: unknown }).code).toBe("qualification_insufficient");
  expect((failure as ValidationError).fieldPath).toBe("/profile/qualification/status");
});
