// SPDX-License-Identifier: Apache-2.0
/**
 * The public memory support example, executed offline.
 *
 * Task T058 ships the example under `examples/memory-support`. This suite
 * builds the example through its own TypeScript configuration, exactly as
 * one host application does, then runs it against the offline test
 * evaluator. The suite checks the boundary that the example teaches: the
 * trusted import of the definition, the projected inputs of every evaluator
 * request, the explicitly unvalidated exploration profile, the recorded
 * shadow baseline beside the unchanged host decision, the host-owned
 * storage of the profile and every report, and the private-data defaults
 * that keep case content out of every stored report. It reads local files
 * only, so it stays offline and free. The run identifiers and the terminal
 * times come from the host defaults, so the suite compares structure, never
 * one complete artifact.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Dataset,
  type Profile,
  type RunOptions,
  type RunReport,
  type ScriptedEvaluator,
  type ValidationError,
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exampleDir = path.join(repoRoot, "examples", "memory-support");
const builtHost = path.join(exampleDir, "build", "host.js");
const packageEntry = path.join(repoRoot, "packages", "measuretwice", "dist", "index.js");

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

/** The example run that every test reads. Built once, before the tests. */
let result: ExampleResult;

/** The directory that holds the stored profile and reports of the run. */
let out = "";

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
  const host = (await import(pathToFileURL(builtHost).href)) as { runExample: RunExample };
  out = mkdtempSync(path.join(tmpdir(), "measuretwice-example-"));
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
  expect(result.dataset.definition.name).toBe("memory-support");
  expect(result.profile.definition.name).toBe("memory-support");
  expect(result.profile.definition.content_hash).toBe(result.dataset.definition.content_hash);
});

test("the cases cover pass, fail, and review with model-proposed provenance", () => {
  const cases = result.dataset.cases;
  expect(cases.map((record) => record.expected?.outcome)).toEqual(["pass", "fail", "review"]);
  expect(cases.map((record) => record.expected?.checks["memory-supported"]?.answer)).toEqual([
    "supported",
    "contradicted",
    "insufficient",
  ]);

  // The dataset is one development fixture. It supports no qualification
  // claim, and every reference is one unreviewed model proposal.
  const identity = result.dataset.identity;
  expect(identity.kind).toBe("development_fixture");
  expect(identity.population).toBe("development_fixture");
  expect(identity.supports_qualification).toBe(false);
  expect(identity.states_prevalence).toBe(false);
  const labels = result.dataset.labels;
  expect(labels.findings).toEqual([]);
  expect(labels.summary.records).toBe(3);
  expect(labels.summary.labeled).toBe(3);
  expect(labels.summary.model_unreviewed).toBe(3);
  expect(labels.summary.human_reviewed).toBe(0);
  expect(labels.summary.review_required).toBe(0);
});

test("the evaluator receives only the inputs that the check authorized", () => {
  const calls = result.evaluator.calls;
  expect(calls).toHaveLength(3);
  for (const request of calls) {
    expect(request.check).toBe("memory-supported");
    expect(request.using).toEqual(["original_sources", "candidate_text"]);
    expect(Object.keys(request.inputs).sort()).toEqual(["candidate_text", "original_sources"]);
    const question = request.question;
    if (question.kind !== "categorical") {
      throw new Error("the example check must ask one categorical question");
    }
    expect(Object.keys(question.answers).sort()).toEqual([
      "contradicted",
      "insufficient",
      "supported",
    ]);
    // No reference label, no provenance record, and no undeclared input
    // crosses the boundary.
    expect(JSON.stringify(request)).not.toContain("recent_context");
    expect(JSON.stringify(request)).not.toContain("expected");
    expect(JSON.stringify(request)).not.toContain("author_type");
  }
});

test("the generated profile is explicitly unvalidated", () => {
  expect(result.profile.origin).toBe("exploration");
  expect(result.profile.qualification.status).toBe("unvalidated");
  expect(result.profile.qualification.reasons).toEqual(["starter_policy"]);
  expect(result.profile.policy.family).toBe("probability_mass_v0");
  expect(result.profile.policy.checks).toEqual([
    { check: "memory-supported", accept_cutoff: 0.8, rejection_cutoff: 0.6 },
  ]);
  expect(result.profile.intended_use).toContain("Not a measured population");
});

test("each shadow run records the host baseline beside the new outcome", () => {
  expect(result.reports).toHaveLength(3);
  // The existing host policy stores one candidate of 60 code points or
  // fewer. The second case holds more, so the host skipped it.
  expect(result.reports.map((report) => report.baseline?.revision)).toEqual([
    "memory-policy-1",
    "memory-policy-1",
    "memory-policy-1",
  ]);
  expect(result.reports.map((report) => report.baseline?.outcome)).toEqual([
    "stored",
    "skipped",
    "stored",
  ]);
  // The scripted answers decide one pass, one fail, and one pass that
  // disagrees with the review reference of its case.
  expect(result.reports.map((report) => report.aggregate.outcome)).toEqual(["pass", "fail", "pass"]);
  for (const report of result.reports) {
    expect(report.mode).toBe("shadow");
    expect(report.completion.status).toBe("completed");
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({
      check: "memory-supported",
      kind: "question",
      evaluator: { id: "scripted-test", adapter_version: "0.1.0" },
      applied_policy: { accept_cutoff: 0.8, rejection_cutoff: 0.6 },
    });
  }
  // The failing case holds the mass that the starter policy rejects.
  const failed = result.reports[1]!.checks[0]!;
  expect(failed.outcome).toBe("fail");
  expect(failed.assessment).toMatchObject({ kind: "categorical", label: "contradicted" });
});

test("the host stores the profile and every report, and no report holds case content", () => {
  expect(result.storedReports).toHaveLength(3);
  for (const [index, stored] of result.storedReports.entries()) {
    const text = readFileSync(stored, "utf8");
    expect(JSON.parse(text), `report ${index} round-trips through host storage`).toEqual(
      result.reports[index],
    );
    expect(text).not.toContain("candidate_text");
    expect(text).not.toContain("recent_context");
    expect(text).not.toContain("Deploy freeze");
    expect(text).not.toContain("US region");
  }
  const profileArtifact = JSON.parse(readFileSync(result.storedProfile, "utf8")) as Profile;
  expect(profileArtifact.content_hash).toBe(result.profile.content_hash);
  expect(profileArtifact.qualification.status).toBe("unvalidated");
});

test("the summary states the unvalidated profile, the provenance, and the disagreement", () => {
  expect(result.summary).toContain("unvalidated · starter_policy");
  expect(result.summary).toContain("baseline stored · candidate pass · reference pass");
  expect(result.summary).toContain("baseline skipped · candidate fail · reference fail");
  expect(result.summary).toContain("candidate pass · reference review (disagreement)");
  expect(result.summary).toContain("3 model-proposed without one human review");
  expect(result.summary).toContain("Three synthetic cases support no performance claim.");
  expect(result.summary).toContain("A shadow run changed no stored memory.");
});

test("the summary prints the detailed view that traces the outcome to its policy", () => {
  // The printed summary follows one summary render with one detailed render
  // of the same report, so one reader traces the outcome without writing
  // code. The detailed view states the measurement, the executed policy,
  // and the key that defines the terms.
  expect(result.summary).toContain(
    "The detailed view of the same report traces every outcome to its measurement and its policy:",
  );
  expect(result.summary).toContain("answer: supported (categorical)");
  expect(result.summary).toContain("distribution: supported 0.85 · contradicted 0.05 · insufficient 0.1");
  expect(result.summary).toContain("policy: accept >= 0.8 · reject >= 0.6");
  expect(result.summary).toContain("Acceptable mass: the assessed mass on the accepted answers of the check.");
  expect(result.summary).toContain("Shadow mode records this assessment beside the decision of the host application.");
});

test("enforcement refuses the unvalidated profile before any case work", async () => {
  const caseInput = result.dataset.cases.map((record) => result.dataset.runCase(record))[0]!;
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
