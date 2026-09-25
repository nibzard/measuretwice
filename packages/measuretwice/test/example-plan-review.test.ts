// SPDX-License-Identifier: Apache-2.0
/**
 * The public plan review example, executed offline.
 *
 * Task T068 ships the second application under `examples/plan-review`. It
 * shares no domain with the memory and the intervention examples, so this
 * suite is the portability check of the same contracts: the authoring
 * format, the case records of two dataset revisions, the evaluator requests
 * of one workflow that revisits the same cases, the profile artifacts of
 * one exploration, one calibration, and one revision, and the report
 * semantics that keep the synthetic data from supporting one qualification
 * claim. The suite builds the example through its own TypeScript
 * configuration, exactly as one host application does, then runs it against
 * the offline test evaluator. It reads local files only, so it stays
 * offline and free. The run identifiers and the terminal times come from
 * the host defaults, so the suite compares structure, never one complete
 * artifact.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  load,
  registerEvaluators,
  renderRunReport,
  createScriptedEvaluator,
  type Definition,
  type Dataset,
  type Profile,
  type RunOptions,
  type RunReport,
  type ValidationError,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exampleDir = path.join(repoRoot, "examples", "plan-review");
const builtHost = path.join(exampleDir, "build", "host.js");
const builtChecks = path.join(exampleDir, "build", "checks", "plan.js");
const builtExport = path.join(exampleDir, "build", "export-definition.js");
const committedExport = path.join(exampleDir, "definitions", "plan-review.json");
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
  readonly revisedDataset: Dataset;
  readonly profile: Profile;
  readonly reviewer: { run(caseInput: unknown, options?: RunOptions): Promise<RunReport> };
  readonly reports: readonly RunReport[];
  readonly evaluation: {
    readonly report: {
      readonly profile: Readonly<{ readonly id: string }>;
      readonly purpose: string;
      readonly cases: readonly unknown[];
    };
    readonly unevaluated_records: number;
  };
  readonly calibration: {
    readonly profile: Profile;
    readonly fitting: {
      readonly plan_id: string;
      readonly case_count: number;
      readonly selected: {
        readonly candidate: { readonly accept_cutoff: number; readonly rejection_cutoff: number };
        readonly objective: { readonly numerator: number; readonly denominator: number };
        readonly constraints: readonly {
          readonly metric: string;
          readonly numerator: number;
          readonly denominator: number;
          readonly observed: number | null;
        }[];
      } | null;
    } | null;
    readonly qualification: {
      readonly status: string;
      readonly evidence: { readonly class: string; readonly statement: string };
    } | undefined;
  };
  readonly revision: {
    readonly profile: Profile;
    readonly fitting: {
      readonly selected: {
        readonly candidate: { readonly accept_cutoff: number; readonly rejection_cutoff: number };
      } | null;
    } | null;
    readonly reuse: {
      readonly stored_fitting_cases: number;
      readonly validation_split: { readonly record_count: number };
      readonly validation_data: { readonly disposition: string };
    };
    readonly runs: readonly RunReport[];
    readonly comparison: {
      readonly matching: { readonly matched_cases: number; readonly changed_cases: number };
      readonly changed: readonly {
        readonly id: string;
        readonly baseline_aggregate: string;
        readonly candidate_aggregate: string;
        readonly checks: readonly { readonly check: string }[];
      }[];
    };
    readonly qualification: {
      readonly status: string;
      readonly evidence: { readonly class: string };
    } | undefined;
  };
  readonly evidence: {
    readonly plan: { readonly id: string };
    readonly dataset: { readonly id: string; readonly revision: string };
    readonly splits: readonly { readonly id: string }[];
  };
  readonly evaluatorCalls: readonly {
    readonly check: string;
    readonly using: readonly string[];
    readonly inputs: Readonly<Record<string, unknown>>;
    readonly question: { readonly kind: string };
  }[];
  readonly stored: readonly string[];
  readonly summary: string;
}

/** The compiled `runExample` operation of the example. */
type RunExample = (options: { readonly out: string; readonly log: (text: string) => void }) => Promise<ExampleResult>;

/** The compiled `exportDefinition` operation of the export script. */
type ExportDefinition = (options: { readonly out: string }) => Promise<string>;

/** The example run that every test reads. Built once, before the tests. */
let result: ExampleResult;

/** The compiled definition, imported through the example build. */
let definition: Definition;

/** The directory that holds every stored artifact of the run. */
let out = "";

/** The case identifiers of dataset revision one, in file order. */
const CASE_IDS = [
  "atlas-covered-plan",
  "atlas-thin-coverage",
  "atlas-missed-requirement",
  "atlas-assumed-export",
  "atlas-open-mapping",
  "borealis-clean-plan",
  "borealis-undocumented-limit",
  "borealis-no-rollback",
  "borealis-unclear-region",
];

/**
 * The case identifiers of the fresh validation split, in the identifier order
 * of the split, which is the order the revision measures.
 */
const FRESH_IDS = [
  "cirrus-doubtful-coverage",
  "cirrus-ready-plan",
  "cirrus-sketch-plan",
  "cirrus-unrequested-migration",
];

/** The identifiers of the question checks, in definition order. */
const QUESTION_CHECKS = [
  "requirement-coverage",
  "capability-fit",
  "unrequested-work",
  "delivery-readiness",
];

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
  const checks = (await import(pathToFileURL(builtChecks).href)) as { planReview: Definition };
  definition = checks.planReview;
  const host = (await import(pathToFileURL(builtHost).href)) as { runExample: RunExample };
  out = mkdtempSync(path.join(tmpdir(), "measuretwice-plan-review-"));
  result = await host.runExample({ out, log: () => {} });
}, 120_000);

afterAll(() => {
  if (out !== "") {
    rmSync(out, { recursive: true, force: true });
  }
  rmSync(path.join(exampleDir, "build"), { recursive: true, force: true });
});

test("the second application builds through its own TypeScript configuration", () => {
  expect(result.dataset.definition.name).toBe("plan-review");
  expect(result.profile.definition.name).toBe("plan-review");
  expect(result.profile.definition.content_hash).toBe(result.dataset.definition.content_hash);
  // The same authoring shape as the flagship: two Choice checks, one Noul
  // check, one Score check, and one exact rule that names no provider detail.
  expect(definition.checks.map((check) => check.id)).toEqual([
    ...QUESTION_CHECKS,
    "rollback-section",
  ]);
  expect(definition.checks[4]).toEqual({
    id: "rollback-section",
    name: "The plan states one rollback step",
    using: ["proposed_plan"],
    rule: { includes: "Rollback" },
  });
  const text = JSON.stringify(definition);
  for (const forbidden of ["jev", "model", "provider", "evaluator", "cutoff", "confidence"]) {
    expect(text, `the definition states no ${forbidden}`).not.toContain(forbidden);
  }
});

test("the committed export equals the definition and the CLI validates it", async () => {
  const exporter = (await import(pathToFileURL(builtExport).href)) as {
    exportDefinition: ExportDefinition;
  };
  const regenerated = path.join(out, "regenerated.json");
  await exporter.exportDefinition({ out: regenerated });
  expect(readFileSync(regenerated, "utf8")).toBe(readFileSync(committedExport, "utf8"));
  expect(JSON.parse(readFileSync(committedExport, "utf8"))).toEqual(definition);

  const run = await execFileAsync(process.execPath, [cliEntry, "validate", committedExport]);
  expect(run.stdout).toContain("plan-review · valid definition");
  expect(run.stdout).toContain("Checks: 5 (1 exact rules, 4 question checks)");
  expect(run.stdout).toContain('rule includes "Rollback" on proposed_plan');
}, 60_000);

test("the two dataset revisions share one fitting split and one provenance", () => {
  const identity = result.dataset.identity;
  const revised = result.revisedDataset.identity;
  expect(identity.revision).toBe("2026-09-25.1");
  expect(revised.revision).toBe("2026-09-25.2");
  expect(identity.content_hash).not.toBe(revised.content_hash);
  expect(identity.kind).toBe("development_fixture");
  expect(identity.supports_qualification).toBe(false);

  const fitting = result.dataset.splits.find((split) => split.purpose === "fitting");
  const revisedFitting = result.revisedDataset.splits.find((split) => split.purpose === "fitting");
  const holdout = result.dataset.splits.find((split) => split.purpose === "validation");
  const fresh = result.revisedDataset.splits.find((split) => split.purpose === "validation");
  expect(fitting?.case_ids).toHaveLength(5);
  expect(holdout?.groups).toEqual(["engagement-borealis"]);
  expect(fresh?.groups).toEqual(["engagement-cirrus"]);
  // The revision replays stored fitting assessments, so the fitting split of
  // the later revision carries the identical content hash.
  expect(revisedFitting?.content_hash).toBe(fitting?.content_hash);
  expect(fresh?.content_hash).not.toBe(holdout?.content_hash);

  expect(result.dataset.cases.map((record) => record.id)).toEqual(CASE_IDS);
  const labels = result.dataset.labels;
  expect(labels.findings).toEqual([]);
  expect(labels.summary.records).toBe(9);
  expect(labels.summary.labeled).toBe(9);
  expect(labels.summary.model_unreviewed).toBe(9);
  expect(labels.summary.human_reviewed).toBe(0);
});

test("every evaluator request of every phase carries only the authorized inputs", () => {
  const calls = result.evaluatorCalls;
  // Shadow, evaluation, and calibration visit the nine cases of revision
  // one; the revision measures the four fresh cases alone.
  expect(calls).toHaveLength((9 + 9 + 9 + 4) * QUESTION_CHECKS.length);
  for (const call of calls) {
    const check = definition.checks.find((named) => named.id === call.check);
    expect(check, `the check ${call.check} belongs to the definition`).toBeDefined();
    expect(call.using).toEqual(check!.using);
    expect(Object.keys(call.inputs).sort()).toEqual([...check!.using].sort());
    // No reference label, no provenance record, and no undeclared input
    // crosses the boundary.
    expect(JSON.stringify(call)).not.toContain("expected");
    expect(JSON.stringify(call)).not.toContain("author_type");
  }
  // The three projected input sets of the guide.
  const projected = new Set(calls.map((call) => Object.keys(call.inputs).sort().join("+")));
  expect(projected).toEqual(
    new Set([
      "customer_requirements+proposed_plan",
      "capability_notes+proposed_plan",
      "capability_notes+customer_requirements+proposed_plan",
    ]),
  );
  // The question kinds match the authoring: two Choice questions, one Noul
  // question, and one Score question, in definition order.
  expect(calls.slice(0, 4).map((call) => call.question.kind)).toEqual([
    "categorical",
    "categorical",
    "binary",
    "ordered",
  ]);
  // The revision measured the fresh split through the registry, in the
  // identifier order of the split.
  const freshCalls = calls.slice(calls.length - FRESH_IDS.length * QUESTION_CHECKS.length);
  expect(freshCalls.map((call) => call.check)).toEqual(
    FRESH_IDS.flatMap(() => QUESTION_CHECKS),
  );
});

test("each shadow run records the host baseline beside the new outcome", () => {
  expect(result.reports).toHaveLength(9);
  expect(result.reports.map((report) => report.baseline?.revision)).toEqual(
    Array.from({ length: 9 }, () => "delivery-review-2"),
  );
  // The existing review escalates the one plan that proposes one custom
  // integration and approves the other eight.
  expect(result.reports.map((report) => report.baseline?.outcome)).toEqual([
    "approve",
    "approve",
    "approve",
    "approve",
    "approve",
    "approve",
    "escalate",
    "approve",
    "approve",
  ]);
  // The starter 0.8 policy: one pass per accepted case, one fail per broken
  // plan, and one review wherever the mass meets neither cutoff.
  expect(result.reports.map((report) => report.aggregate.outcome)).toEqual([
    "pass",
    "review",
    "fail",
    "review",
    "review",
    "pass",
    "fail",
    "fail",
    "review",
  ]);
  for (const report of result.reports) {
    expect(report.mode).toBe("shadow");
    expect(report.completion.status).toBe("completed");
    expect(report.checks.map((record) => record.check)).toEqual([
      ...QUESTION_CHECKS,
      "rollback-section",
    ]);
    for (const record of report.checks.slice(0, 4)) {
      expect(record).toMatchObject({
        kind: "question",
        evaluator: { id: "scripted-test", adapter_version: "0.1.0" },
        applied_policy: { accept_cutoff: 0.8, rejection_cutoff: 0.6 },
      });
    }
  }
  // The plan without one rollback section fails through the exact rule in
  // code, and no evaluator serves the rule check.
  const noRollback = result.reports[7]!.checks;
  expect(noRollback.map((record) => record.outcome)).toEqual([
    "pass",
    "pass",
    "pass",
    "pass",
    "fail",
  ]);
  expect(noRollback[4]).toMatchObject({
    kind: "rule",
    outcome: "fail",
    applied_rule: {
      rule: "includes",
      input: "proposed_plan",
      parameters: { includes: "Rollback" },
    },
  });
  expect(noRollback[4]?.evaluator).toBeUndefined();
});

test("the aggregate folds the component outcomes and shares the report semantics", () => {
  for (const report of result.reports) {
    const outcomes = report.checks.map((record) => record.outcome);
    expect(report.aggregate.outcome, `the aggregate of ${report.case.id}`).toBe(
      foldOutcome(outcomes),
    );
    expect(() => renderRunReport(definition, report)).not.toThrow();
  }
});

test("the evaluation measures the dataset under the exploration profile", () => {
  expect(result.evaluation.report.profile.id).toBe("plan-review-exploration");
  expect(result.evaluation.report.purpose).toBe("exploration");
  expect(result.evaluation.report.cases).toHaveLength(9);
  expect(result.evaluation.unevaluated_records).toBe(0);
});

test("the calibration selects one candidate and states the fixture limit", () => {
  const fitting = result.calibration.fitting;
  expect(fitting?.plan_id).toBe("plan-review-calibration");
  expect(fitting?.case_count).toBe(5);
  expect(fitting?.selected?.candidate).toEqual({
    accept_cutoff: 0.6,
    rejection_cutoff: 0.6,
    confidence_floor: null,
  });
  // Three accepted fitting plans, one of them wrong, and one review.
  const goal = fitting?.selected?.constraints[0];
  expect(goal).toMatchObject({
    metric: "error_among_accepted",
    numerator: 1,
    denominator: 3,
    observed: 1 / 3,
  });
  expect(fitting?.selected?.objective).toMatchObject({ numerator: 1, denominator: 5 });

  // The dataset is one development fixture, so the frozen validation
  // supports no qualification claim, whatever the measured numbers state.
  const qualification = result.calibration.qualification;
  expect(qualification?.status).toBe("insufficient_evidence");
  expect(qualification?.evidence.class).toBe("development");
  expect(qualification?.evidence.statement).toContain("development_fixture");
  expect(result.calibration.profile.qualification.status).toBe("insufficient_evidence");
  expect(result.calibration.profile.origin).toBe("calibration");
  expect(result.calibration.profile.id).toBe("plan-review-calibrated");
});

test("the revision freezes one tighter policy and names the changed cases", () => {
  expect(result.revision.fitting?.selected?.candidate).toEqual({
    accept_cutoff: 0.8,
    rejection_cutoff: 0.6,
    confidence_floor: null,
  });
  // The fitting assessments replayed from storage and the fresh split of
  // engagement cirrus was measured through the registry.
  expect(result.revision.reuse.stored_fitting_cases).toBe(5);
  expect(result.revision.reuse.validation_data).toEqual({ disposition: "fresh" });
  expect(result.revision.reuse.validation_split.record_count).toBe(4);
  expect(result.revision.runs.map((run) => run.case.id)).toEqual(FRESH_IDS);

  // The comparison names the concrete change: the two fitting plans that
  // the tighter policy sends to one human instead of accepting.
  const comparison = result.revision.comparison;
  expect(comparison.matching).toEqual({ matched_cases: 5, changed_cases: 2, unchanged_cases: 3 });
  expect(comparison.changed.map((changed) => changed.id)).toEqual([
    "atlas-thin-coverage",
    "atlas-assumed-export",
  ]);
  for (const changed of comparison.changed) {
    expect(changed.baseline_aggregate).toBe("pass");
    expect(changed.candidate_aggregate).toBe("review");
    expect(changed.checks.map((pair) => pair.check)).toEqual(["requirement-coverage"]);
  }

  // One policy change records one new profile and reuses no validation.
  expect(result.revision.profile.id).toBe("plan-review-revised");
  expect(result.revision.profile.content_hash).not.toBe(
    result.calibration.profile.content_hash,
  );
  expect(result.revision.qualification?.status).toBe("insufficient_evidence");
  expect(result.revision.qualification?.evidence.class).toBe("development");
});

test("the evidence check verifies the retained plan and dataset", () => {
  const evidence = result.evidence;
  expect(evidence.plan.id).toBe("plan-review-revision");
  expect(evidence.dataset.id).toBe("plan-review-cases");
  expect(evidence.dataset.revision).toBe("2026-09-25.2");
  expect(evidence.splits.map((split) => split.id)).toEqual(["fit", "holdout"]);
});

test("the host stores every artifact and no artifact holds case content", () => {
  expect(result.stored.length).toBeGreaterThanOrEqual(12);
  for (const stored of result.stored) {
    const text = readFileSync(stored, "utf8");
    // The canaries are case content and customer names, never input names.
    expect(text, `${stored} holds case content`).not.toContain("Northwind Retail");
    expect(text, `${stored} holds case content`).not.toContain("Helios Energy");
    expect(text, `${stored} holds case content`).not.toContain("Vela Logistics");
    expect(text, `${stored} holds case content`).not.toContain("25 requests per second");
    expect(text, `${stored} holds case content`).not.toContain("Priya");
    expect(text, `${stored} holds case content`).not.toContain("forecasting service");
  }
  const storedProfile = JSON.parse(
    readFileSync(path.join(out, "plan-review-exploration.json"), "utf8"),
  ) as Profile;
  expect(storedProfile.content_hash).toBe(result.profile.content_hash);
  expect(storedProfile.qualification.status).toBe("unvalidated");
});

test("the summary states the workflow, the provenance, and the limits", () => {
  expect(result.summary).toContain("unvalidated · starter_policy");
  expect(result.summary).toContain("baseline escalate · candidate fail · reference fail");
  expect(result.summary).toContain(
    "The existing review approved 3 plans whose reference states one fail",
  );
  expect(result.summary).toContain(
    "atlas-missed-requirement, atlas-assumed-export, borealis-no-rollback",
  );
  expect(result.summary).toContain("candidate review, reference fail. Review it.");
  expect(result.summary).toContain("9 model-proposed without one human review.");
  expect(result.summary).toContain("candidate accept 0.6, reject 0.6");
  expect(result.summary).toContain("candidate accept 0.8, reject 0.6");
  expect(result.summary).toContain("2 changed cases of 5 replayed fitting cases");
  expect(result.summary).toContain("atlas-assumed-export · pass to review · requirement-coverage");
  expect(result.summary).toContain("Nine synthetic cases support no performance claim.");
  expect(result.summary).toContain("A shadow run approved no plan.");
});

test("enforcement refuses every profile of this synthetic example", async () => {
  // The exploration profile refuses before any case work.
  const caseInput = result.dataset.runCase(result.dataset.cases[0]!);
  const exploration = await result.reviewer
    .run(caseInput, { mode: "enforcement" })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(exploration).toBeInstanceOf(Error);
  expect((exploration as { code?: unknown }).code).toBe("qualification_insufficient");
  expect((exploration as ValidationError).fieldPath).toBe("/profile/qualification/status");

  // The revised profile refuses even with one stated selection and one
  // matching scope, because one development fixture validates nothing.
  const storedRevised = path.join(out, "plan-review-revised.json");
  const reviewer = await load(definition, {
    profile: storedRevised,
    evaluators: registerEvaluators(
      createScriptedEvaluator({
        steps: [
          {
            answer: {
              assessment: {
                kind: "categorical",
                label: "covered",
                distribution: [
                  { name: "covered", mass: 0.95 },
                  { name: "partial", mass: 0.03 },
                  { name: "unaddressed", mass: 0.02 },
                ],
              },
              latency_ms: 10,
            },
          },
          {
            answer: {
              assessment: {
                kind: "categorical",
                label: "documented",
                distribution: [
                  { name: "documented", mass: 0.92 },
                  { name: "absent", mass: 0.03 },
                  { name: "unclear", mass: 0.05 },
                ],
              },
              latency_ms: 10,
            },
          },
          { answer: { assessment: { kind: "binary", value: false }, latency_ms: 10 } },
          {
            answer: {
              assessment: {
                kind: "ordered",
                level: "complete",
                distribution: [
                  { name: "sketch", mass: 0.05 },
                  { name: "workable", mass: 0.13 },
                  { name: "complete", mass: 0.82 },
                ],
              },
              latency_ms: 10,
            },
          },
        ] as never,
      }),
    ),
  });
  const revised = await reviewer
    .run(caseInput, {
      mode: "enforcement",
      selectedProfileHash: result.revision.profile.content_hash,
      scope: result.revision.profile.intended_use,
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(revised).toBeInstanceOf(Error);
  expect((revised as { code?: unknown }).code).toBe("qualification_insufficient");
});
