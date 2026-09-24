// SPDX-License-Identifier: Apache-2.0
/**
 * The development checks of this repository, executed offline.
 *
 * Task T060 makes the draft checks under `.measuretwice` executable against
 * the implemented public package. This suite builds them through their own
 * TypeScript configuration, exactly as one host application does, and then
 * checks the promises of `.measuretwice/README.md`:
 *
 * - Both definitions compile against the implemented package, and the
 *   committed JSON exports stay equal to the TypeScript values.
 * - The migrated case records satisfy the frozen dataset contract, and the
 *   migration preserved every agent-proposed, unreviewed label record.
 * - The offline validation runner validates definitions, exports, and both
 *   datasets through the Rust core with no evaluator.
 * - The Jev shadow experiments stay opt-in and pinned: one run without
 *   consent refuses, one alias model refuses, and one injected call boundary
 *   proves the complete pinned path offline, with no reference label, no
 *   explanation, and no provenance record on any wire request.
 *
 * The suite reads local files only. The injected call boundary is synthetic
 * adapter output: no model ran, nothing was measured, and no live path was
 * touched. Run identifiers come from the host defaults, so the suite
 * compares structure, never one complete artifact.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  type Definition,
  type JevCall,
  type Profile,
  type RunReport,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const checksDir = path.join(repoRoot, ".measuretwice");
const packageEntry = path.join(repoRoot, "packages", "measuretwice", "dist", "index.js");
const cliEntry = path.join(repoRoot, "packages", "measuretwice", "dist", "cli.js");
const builtChecks = path.join(checksDir, "build", "checks");
const builtValidate = path.join(checksDir, "build", "validate.js");
const builtExport = path.join(checksDir, "build", "export-definitions.js");
const builtJevShadow = path.join(checksDir, "build", "jev-shadow.js");

/** The compiled validation result. This interface states the fields read. */
interface ValidationResult {
  readonly checks: readonly {
    readonly name: string;
    readonly contentHash: string;
    readonly outcomes: Readonly<{ pass: number; fail: number; review: number }>;
    readonly dataset: {
      readonly cases: readonly {
        readonly id: string;
        readonly label: Readonly<{ author_type: string; reviewed: boolean }>;
        readonly expected?: { readonly outcome?: string };
      }[];
      readonly identity: Readonly<{
        readonly kind: string;
        readonly supports_qualification: boolean;
        readonly group_assignments: readonly {
          readonly group: string;
          readonly split_id: string;
          readonly record_count: number;
        }[];
        readonly unassigned_groups: readonly unknown[];
      }>;
      readonly labels: {
        readonly summary: Record<string, number>;
        readonly findings: readonly unknown[];
      };
      runCase(record: unknown): { id: string; input: unknown };
    };
  }[];
  readonly summary: string;
}

/** The compiled export script entry. */
type ExportDefinitions = (options: { readonly out: string }) => Promise<readonly string[]>;

/** The compiled offline validation entry. */
type ValidateDevelopmentChecks = (options: {
  readonly log?: (text: string) => void;
}) => Promise<ValidationResult>;

/** The compiled opt-in Jev shadow entry. */
type RunJevShadowExperiments = (options: {
  readonly optIn?: boolean;
  readonly check?: string;
  readonly model?: string;
  readonly call?: JevCall;
  readonly out?: string;
  readonly log?: (text: string) => void;
}) => Promise<{
  readonly experiments: readonly {
    readonly name: string;
    readonly profile: Profile;
    readonly reports: readonly RunReport[];
    readonly storedProfile: string;
    readonly storedReports: readonly string[];
  }[];
  readonly model: string;
  readonly summary: string;
}>;

/** Reads one thrown error of one rejected call as one message string. */
async function rejectionOf(run: () => Promise<unknown>): Promise<string> {
  const error = await run().then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error, "the call must reject").toBeInstanceOf(Error);
  return (error as Error).message;
}

/** The compiled values, imported once after the build. */
let exampleContract: Definition;
let claimEvidence: Definition;
let validateDevelopmentChecks: ValidateDevelopmentChecks;
let runJevShadowExperiments: RunJevShadowExperiments;

/** The offline validation result that every test reads. Run once. */
let validation: ValidationResult;

beforeAll(async () => {
  expect(existsSync(packageEntry), "build the package before the tests").toBe(true);
  // One host application imports the definitions through its own build, so
  // the suite builds the development checks the same way. One type error in
  // one definition fails here, before any test runs.
  execFileSync(
    process.execPath,
    [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(checksDir, "tsconfig.json")],
    { cwd: repoRoot, stdio: "pipe" },
  );
  exampleContract = ((await import(pathToFileURL(path.join(builtChecks, "example-contract.js")).href)) as {
    exampleContract: Definition;
  }).exampleContract;
  claimEvidence = ((await import(pathToFileURL(path.join(builtChecks, "claim-evidence.js")).href)) as {
    claimEvidence: Definition;
  }).claimEvidence;
  validateDevelopmentChecks = (
    (await import(pathToFileURL(builtValidate).href)) as {
      validateDevelopmentChecks: ValidateDevelopmentChecks;
    }
  ).validateDevelopmentChecks;
  runJevShadowExperiments = (
    (await import(pathToFileURL(builtJevShadow).href)) as {
      runJevShadowExperiments: RunJevShadowExperiments;
    }
  ).runJevShadowExperiments;
  validation = await validateDevelopmentChecks({ log: () => {} });
}, 120_000);

afterAll(() => {
  rmSync(path.join(checksDir, "build"), { recursive: true, force: true });
});

test("both definitions compile against the implemented package and validate through the core", () => {
  for (const [definition, input, accept, review] of [
    [exampleContract, ["contract", "example"], "consistent", "incomplete"],
    [claimEvidence, ["claim", "evidence"], "supported", "insufficient"],
  ] as const) {
    expect(definition.schema_version).toBe(1);
    expect(definition.checks).toHaveLength(1);
    const check = definition.checks[0]!;
    expect(check.using).toEqual([...input]);
    expect(check.question).toBeDefined();
    expect(Object.keys(check.answers ?? {}).sort()).toEqual([accept, "conflicting", review].sort());
    expect(check.accept).toBe(accept);
    expect(check.review).toBe(review);
    const inputs = definition.inputs as { properties?: Record<string, unknown> };
    expect(Object.keys(inputs.properties ?? {}).sort()).toEqual([...input].sort());
  }
  // The definitions state no provider binding and no numerical cutoff: each
  // check holds one question and no rule, and no artifact field names one
  // provider. The question prose may still teach the evaluator about label
  // provenance, provider confidence, and untrusted input.
  for (const definition of [exampleContract, claimEvidence]) {
    for (const check of definition.checks) {
      expect(check.question).toBeDefined();
      expect(check.rule).toBeUndefined();
    }
    const text = JSON.stringify(definition);
    for (const forbidden of ["jev", "cutoff", "accept_cutoff", "probability"]) {
      expect(text, `the definition states no ${forbidden}`).not.toContain(forbidden);
    }
  }
});

test("the committed JSON exports equal the definitions and the CLI validates them", async () => {
  const out = mkdtempSync(path.join(tmpdir(), "measuretwice-dev-checks-"));
  try {
    const exporter = (await import(pathToFileURL(builtExport).href)) as {
      exportDefinitions: ExportDefinitions;
    };
    const written = await exporter.exportDefinitions({ out });
    expect(written).toHaveLength(2);
    for (const [index, name] of ["example-contract", "claim-evidence"].entries()) {
      const regenerated = readFileSync(written[index]!, "utf8");
      const committed = readFileSync(path.join(checksDir, "definitions", `${name}.json`), "utf8");
      expect(regenerated).toBe(committed);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  const committed = [
    JSON.parse(readFileSync(path.join(checksDir, "definitions", "example-contract.json"), "utf8")),
    JSON.parse(readFileSync(path.join(checksDir, "definitions", "claim-evidence.json"), "utf8")),
  ] as unknown[];
  expect(committed[0]).toEqual(exampleContract);
  expect(committed[1]).toEqual(claimEvidence);

  for (const name of ["example-contract", "claim-evidence"]) {
    const run = await execFileAsync(process.execPath, [
      cliEntry,
      "validate",
      path.join(checksDir, "definitions", `${name}.json`),
    ]);
    expect(run.stdout).toContain(`${name} · valid definition`);
    expect(run.stdout).toContain("Checks: 1 (0 exact rules, 1 question checks)");
  }
}, 60_000);

test("the migrated records satisfy the frozen dataset contract with preserved provenance", () => {
  expect(validation.checks.map((check) => check.name)).toEqual([
    "example-contract",
    "claim-evidence",
  ]);
  for (const [check, expectedRecords, expectedGroups] of [
    [validation.checks[0]!, 8, 7],
    [validation.checks[1]!, 10, 9],
  ] as const) {
    expect(check.dataset.cases).toHaveLength(expectedRecords);
    expect(check.outcomes).toEqual(
      expectedRecords === 8 ? { pass: 2, fail: 4, review: 2 } : { pass: 2, fail: 6, review: 2 },
    );
    expect(check.dataset.identity.kind).toBe("development_fixture");
    expect(check.dataset.identity.supports_qualification).toBe(false);
    expect(check.dataset.identity.unassigned_groups).toEqual([]);
    // One fitting split holds every group: this fixture declares no
    // independent validation data.
    expect(check.dataset.identity.group_assignments).toHaveLength(expectedGroups);
    for (const assignment of check.dataset.identity.group_assignments) {
      expect(assignment.split_id).toBe("explore");
    }
    expect(check.dataset.labels.findings).toEqual([]);
    const summary = check.dataset.labels.summary;
    expect(summary.records).toBe(expectedRecords);
    expect(summary.labeled).toBe(expectedRecords);
    expect(summary.model_unreviewed).toBe(expectedRecords);
    expect(summary.human_reviewed).toBe(0);
    expect(summary.human_unreviewed).toBe(0);
    expect(summary.corrected).toBe(0);
    // The migration preserved every label record as the agent proposed it:
    // one model author, one synthetic origin, no human review.
    for (const record of check.dataset.cases) {
      expect(record.label.author_type).toBe("model");
      expect(record.label.reviewed).toBe(false);
      expect(record.expected?.outcome).toBeDefined();
    }
  }
  // The provisional shape left no field behind.
  for (const name of ["example-contract", "claim-evidence"]) {
    const text = readFileSync(path.join(checksDir, "cases", `${name}.jsonl`), "utf8");
    expect(text).not.toContain("human_review_status");
    expect(text).not.toContain("human_reviewer");
    expect(text).not.toContain("coding_agent");
  }
});

test("runCase carries one identifier and one input object alone", () => {
  for (const check of validation.checks) {
    for (const record of check.dataset.cases) {
      const runCase = check.dataset.runCase(record);
      expect(Object.keys(runCase).sort()).toEqual(["id", "input"]);
      const text = JSON.stringify(runCase);
      expect(text).not.toContain("expected");
      expect(text).not.toContain("author_type");
      expect(text).not.toContain("\"label\"");
    }
  }
});

test("the offline validation states the provenance and the limits", () => {
  expect(validation.summary).toContain("Development checks · offline validation");
  expect(validation.summary).toContain("example-contract · 8 cases");
  expect(validation.summary).toContain("claim-evidence · 10 cases");
  expect(validation.summary).toContain("8 model-proposed without one human review");
  expect(validation.summary).toContain("10 model-proposed without one human review");
  expect(validation.summary).toContain("development data");
  expect(validation.summary).toContain("no independent validation set");
  expect(validation.summary).toContain("no live result exists");
  expect(validation.summary).toContain("Enforcement needs one qualified, host-selected profile");
});

test("the Jev shadow experiment refuses one run without consent or with one alias", async () => {
  const gate = await rejectionOf(() => runJevShadowExperiments({ check: "example-contract" }));
  expect(gate).toContain("opt-in");
  expect(gate).toContain("optIn: true");

  const alias = await rejectionOf(() =>
    runJevShadowExperiments({
      optIn: true,
      model: "jev-latest",
      check: "example-contract",
      call: () => Promise.resolve({}),
    }),
  );
  expect(alias).toContain("no versioned identifier");
  expect(alias).toContain("jev-latest");

  const unknown = await rejectionOf(() =>
    runJevShadowExperiments({ optIn: true, check: "no-such-check" }),
  );
  expect(unknown).toContain("names no development check");
});

test("an injected pinned call runs one shadow experiment offline with no label on the wire", async () => {
  const out = mkdtempSync(path.join(tmpdir(), "measuretwice-dev-shadow-"));
  const wire: { model: string | undefined; questions: Record<string, unknown>; state: unknown }[] = [];
  // Synthetic adapter output. No model ran, and nothing was measured. The
  // boundary answers with the accepted label of each check, so every pass
  // disagreement with a fail or review reference stays visible.
  const accepted: Record<string, string> = {
    "example-matches-contract": "consistent",
    "claim-matches-evidence": "supported",
  };
  const call: JevCall = async (request) => {
    const check = Object.keys(request.questions)[0]!;
    wire.push({
      model: request.model,
      questions: JSON.parse(JSON.stringify(request.questions)) as Record<string, unknown>,
      state: JSON.parse(JSON.stringify(request.state)),
    });
    const labels = Object.keys(
      (request.questions[check] as { criteria: Record<string, unknown> }).criteria,
    );
    const choice = accepted[check] ?? labels[0]!;
    const probabilities: Record<string, number> = {};
    for (const label of labels) {
      probabilities[label] = label === choice ? 0.9 : 0.1 / (labels.length - 1);
    }
    return {
      model: "jev-1.13.0",
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: { [check]: { type: "choice", choice, confidence: 0.9, probabilities } },
    };
  };
  try {
    const result = await runJevShadowExperiments({
      optIn: true,
      check: "example-contract",
      call,
      out,
      log: () => {},
    });
    expect(result.model).toBe("jev-1.13.0");
    expect(result.experiments).toHaveLength(1);
    const experiment = result.experiments[0]!;
    expect(experiment.name).toBe("example-contract");

    // The generated profile stays unvalidated and requests the pinned model.
    expect(experiment.profile.qualification.status).toBe("unvalidated");
    expect(experiment.profile.qualification.reasons).toEqual(["starter_policy"]);
    expect(experiment.profile.bindings[0]).toMatchObject({
      check: "example-matches-contract",
      evaluator: "jev",
      model: { requested: "jev-1.13.0" },
    });

    // One shadow report per case, without one baseline: these checks own no
    // existing host decision to record.
    expect(experiment.reports).toHaveLength(8);
    for (const report of experiment.reports) {
      expect(report.mode).toBe("shadow");
      expect(report.completion.status).toBe("completed");
      expect(report.baseline).toBeUndefined();
      expect(report.checks[0]?.evaluator?.model_resolved).toBe("jev-1.13.0");
      expect(report.aggregate.outcome).toBe("pass");
    }

    // Every wire request carried the pinned model, the three declared
    // answers, the projected inputs alone, and no label field.
    expect(wire).toHaveLength(8);
    for (const request of wire) {
      expect(request.model).toBe("jev-1.13.0");
      const question = request.questions["example-matches-contract"] as {
        type: string;
        criteria: Record<string, string>;
      };
      expect(question.type).toBe("choice");
      expect(Object.keys(question.criteria).sort()).toEqual([
        "conflicting",
        "consistent",
        "incomplete",
      ]);
      const state = request.state as { evidence?: Record<string, string> };
      expect(Object.keys(state.evidence ?? {}).sort()).toEqual(["contract", "example"]);
      const text = JSON.stringify(request);
      expect(text).not.toContain("expected");
      expect(text).not.toContain("author_type");
      expect(text).not.toContain("reason");
    }

    // The host-side storage wrote the profile and every report, and no
    // stored report holds case content.
    const files = readdirSync(path.join(out, "example-contract-jev-jev-1.13.0"));
    expect(files).toHaveLength(9);
    for (const stored of experiment.storedReports) {
      const text = readFileSync(stored, "utf8");
      expect(text).not.toContain("Contract excerpt");
    }
    expect(readFileSync(experiment.storedProfile, "utf8")).toContain("jev-1.13.0");

    // The summary names the pinned model, the unvalidated profile, every
    // reference disagreement, and the limits of the fixture.
    expect(result.summary).toContain("Model requested: jev-1.13.0");
    expect(result.summary).toContain("unvalidated · starter_policy");
    expect(result.summary).toContain("6 candidate outcome disagrees with its reference label");
    expect(result.summary).toContain("8 model-proposed without one human review");
    expect(result.summary).toContain("One shadow run changed no application action");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
