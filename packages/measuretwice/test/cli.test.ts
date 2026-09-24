// SPDX-License-Identifier: Apache-2.0
/**
 * CLI behavior tests, tasks T054 and T055. They cover both surfaces:
 *
 * - The compiled entry point, so `npm run build` must run before the tests.
 * - The imported `runCli` and `parseCliArguments`, with injected streams,
 *   which pin the parsing rules, the exit codes, the stream separation, and
 *   the diagnostic formats without one child process per case.
 *
 * The command tests of T055 drive `validate`, `run`, and `inspect` through
 * the imported `runCli` with injected streams. They pin the readable and
 * the JSON output of every command, the pass, fail, and review reports of
 * one completed run, the report artifact of `--out`, the malformed and
 * unreadable artifacts, the incompatible profile, the unavailable
 * evaluator, the enforcement refusal, and the privacy rule that no raw
 * case content crosses either stream. The error aggregate of one run needs
 * one evaluator execution; the CLI refuses evaluator runs by design, and
 * the renderer suite of T037 covers that view.
 */
import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseCliArguments, runCli, USAGE } from "../src/cli.js";
import type { CliIo } from "../src/cli.js";
import { createExplorationProfile } from "../src/exploration.js";
import { createLabelOnlyEvaluator } from "../src/test-evaluator.js";
import { load, registerEvaluators } from "../src/index.js";

const execFileAsync = promisify(execFile);

const cliPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/cli.js",
);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exactRulesPath = path.join(repoRoot, "fixtures", "definitions", "valid", "exact-rules.json");
const categoricalPath = path.join(
  repoRoot,
  "fixtures",
  "definitions",
  "valid",
  "categorical-question.json",
);
const orderedPath = path.join(repoRoot, "fixtures", "definitions", "valid", "ordered-scale.json");

interface ExecFailure extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

/** Captures the output of one in-process CLI run. */
function capturedIo(): { io: CliIo; out: () => string; err: () => string } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      writeOut(text: string): void {
        output.push(text);
      },
      writeErr(text: string): void {
        errors.push(text);
      },
    },
    out: () => output.join(""),
    err: () => errors.join(""),
  };
}

/** Runs the CLI in-process and captures code, stdout, and stderr. */
async function cli(
  argv: readonly string[],
  options: { cwd?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  const streams = capturedIo();
  const code = await runCli(argv, { io: streams.io, cwd: options.cwd });
  return { code, out: streams.out(), err: streams.err() };
}

test("--version prints the package version and the contract version", async () => {
  const { stdout } = await execFileAsync("node", [cliPath, "--version"]);
  expect(stdout).toMatch(/^measuretwice \d+\.\d+\.\d+ \(contracts v1\)\n$/);
});

test("--help prints the usage text and exits with code 0", async () => {
  const { stdout } = await execFileAsync("node", [cliPath, "--help"]);
  expect(stdout).toContain("Usage:");
  expect(stdout).toContain("--version");
});

test("an unknown option fails with a message and exit code 2", async () => {
  let failure: ExecFailure | undefined;
  try {
    await execFileAsync("node", [cliPath, "--nope"]);
  } catch (error) {
    failure = error as ExecFailure;
  }
  expect(failure?.code).toBe(2);
  expect(failure?.stderr).toContain("measuretwice:");
});

test("the compiled entry point validates one exported definition", async () => {
  const { stdout } = await execFileAsync("node", [cliPath, "validate", exactRulesPath]);
  expect(stdout).toContain("delivery-limits · valid definition");
  expect(stdout).toMatch(/Content hash: [0-9a-f]{64}/);
});

test("the compiled entry point refuses one missing argument with exit code 2", async () => {
  let failure: ExecFailure | undefined;
  try {
    await execFileAsync("node", [cliPath, "validate"]);
  } catch (error) {
    failure = error as ExecFailure;
  }
  expect(failure?.code).toBe(2);
  expect(failure?.stderr).toContain("measuretwice:");
});

test("the compiled entry point leaks no credential from the environment", async () => {
  const canary = "CANARY-ENV-SECRET";
  let failure: ExecFailure | undefined;
  try {
    await execFileAsync("node", [cliPath, "validate", "checks/intervention.ts"], {
      env: { ...process.env, JEV_API_KEY: canary, EVALUATOR_API_KEY: canary },
    });
  } catch (error) {
    failure = error as ExecFailure;
  }
  expect(failure?.code).toBe(1);
  expect(failure?.stderr).toContain("unsupported_format");
  expect(`${failure?.stderr ?? ""}${failure?.stdout ?? ""}`).not.toContain(canary);
});

test("no arguments print the usage and exit with code 0", async () => {
  const result = await cli([]);
  expect(result.code).toBe(0);
  expect(result.out).toBe(USAGE);
  expect(result.err).toBe("");
});

test("--help after one command prints the usage and exits with code 0", async () => {
  const result = await cli(["run", "--help"]);
  expect(result.code).toBe(0);
  expect(result.out).toBe(USAGE);
});

test("parseCliArguments resolves every artifact path of every command", () => {
  const cwd = "/work";
  expect(parseCliArguments(["validate", "d.json"], { cwd })).toEqual({
    command: "validate",
    definition: "d.json",
    format: "text",
  });
  expect(
    parseCliArguments(["run", "intervention", "--case", "example", "--mode", "enforcement"], {
      cwd,
    }),
  ).toEqual({
    command: "run",
    definition: path.join(cwd, ".measuretwice", "definitions", "intervention.json"),
    case: path.join(cwd, ".measuretwice", "cases", "example.json"),
    mode: "enforcement",
    format: "text",
  });
  expect(
    parseCliArguments(["calibrate", "d.json", "--plan", "calibration-plan", "--out", "p.json"], {
      cwd,
    }),
  ).toEqual({
    command: "calibrate",
    definition: "d.json",
    plan: path.join(cwd, ".measuretwice", "calibration-plan.json"),
    out: "p.json",
    format: "text",
  });
  expect(
    parseCliArguments(
      [
        "evaluate",
        "d.json",
        "--cases",
        "holdout.jsonl",
        "--profile",
        "candidate",
        "--purpose",
        "fitting",
      ],
      { cwd },
    ),
  ).toEqual({
    command: "evaluate",
    definition: "d.json",
    cases: "holdout.jsonl",
    metadata: "holdout.json",
    profile: path.join(cwd, ".measuretwice", "profiles", "candidate.json"),
    purpose: "fitting",
    format: "text",
  });
  expect(parseCliArguments(["compare", "a.json", "b.json"], { cwd })).toEqual({
    command: "compare",
    baseline: "a.json",
    candidate: "b.json",
    format: "text",
  });
  expect(parseCliArguments(["inspect", "candidate", "--format", "json"], { cwd })).toEqual({
    command: "inspect",
    profile: path.join(cwd, ".measuretwice", "profiles", "candidate.json"),
    detail: "summary",
    format: "json",
  });
});

test("usage failures exit with code 2 and one stable reason code", async () => {
  const unknown = await cli(["frobnicate", "d.json"]);
  expect(unknown.code).toBe(2);
  expect(unknown.err).toContain("unknown_command");
  expect(unknown.err).toContain("measuretwice: unknown_command:");
  expect(unknown.out).toBe("");

  const missing = await cli(["validate"]);
  expect(missing.code).toBe(2);
  expect(missing.err).toContain("missing_argument");
  expect(missing.err).toContain("definition");

  const shortCompare = await cli(["compare", "baseline.json"]);
  expect(shortCompare.code).toBe(2);
  expect(shortCompare.err).toContain("candidate report");

  const extra = await cli(["validate", "a.json", "b.json"]);
  expect(extra.code).toBe(2);
  expect(extra.err).toContain("unexpected_argument");

  const noCase = await cli(["run", "d.json"]);
  expect(noCase.code).toBe(2);
  expect(noCase.err).toContain("missing_argument");
  expect(noCase.err).toContain("--case");

  const noPlan = await cli(["calibrate", "d.json"]);
  expect(noPlan.code).toBe(2);
  expect(noPlan.err).toContain("--plan");

  const noCases = await cli(["evaluate", "d.json"]);
  expect(noCases.code).toBe(2);
  expect(noCases.err).toContain("--cases");

  const wrongMode = await cli(["run", "d.json", "--case", "c.json", "--mode", "bogus"]);
  expect(wrongMode.code).toBe(2);
  expect(wrongMode.err).toContain("invalid_argument");
  expect(wrongMode.err).toContain("shadow");

  const wrongFormat = await cli(["validate", "d.json", "--format", "xml"]);
  expect(wrongFormat.code).toBe(2);
  expect(wrongFormat.err).toContain("--format");
});

test("one option of another command is one unsupported option", async () => {
  const result = await cli(["run", "d.json", "--case", "c.json", "--plan", "p.json"]);
  expect(result.code).toBe(2);
  expect(result.err).toContain("unsupported_option");
  expect(result.err).toContain("--plan");
  expect(result.out).toBe("");
});

test("one wrong file format fails with exit code 1 before one read", async () => {
  const ts = await cli(["validate", "checks/intervention.ts"]);
  expect(ts.code).toBe(1);
  expect(ts.err).toContain("unsupported_format");
  expect(ts.err).toContain("no TypeScript");

  const yaml = await cli(["inspect", "candidate.yaml"]);
  expect(yaml.code).toBe(1);
  expect(yaml.err).toContain("no YAML");
});

test("one accepted parse of one later task still reports the stub with exit code 1", async () => {
  const text = await cli([
    "calibrate",
    exactRulesPath,
    "--plan",
    "calibration-plan",
  ]);
  expect(text.code).toBe(1);
  expect(text.err).toContain("measuretwice: not_implemented:");
  expect(text.err).toContain("not implemented in this build");
  expect(text.out).toBe("");

  const json = await cli(["evaluate", "d.json", "--cases", "holdout.jsonl", "--format", "json"]);
  expect(json.code).toBe(1);
  expect(json.out).toBe("");
  const diagnostic = JSON.parse(json.err) as {
    tool: string;
    error: { code: string; message: string };
  };
  expect(diagnostic.tool).toBe("measuretwice");
  expect(diagnostic.error.code).toBe("not_implemented");
});

test("the JSON diagnostic of one usage failure carries the stable code", async () => {
  const result = await cli(["frobnicate", "d.json", "--format", "json"]);
  expect(result.code).toBe(2);
  expect(result.out).toBe("");
  const diagnostic = JSON.parse(result.err) as {
    error: { code: string; field_path: string };
  };
  expect(diagnostic.error.code).toBe("unknown_command");
});

test("one credential option is one unsupported option and leaks no value", async () => {
  const result = await cli(["validate", "d.json", "--api-key", "CANARY-OPTION-SECRET"]);
  expect(result.code).toBe(2);
  expect(result.err).toContain("unsupported_option");
  expect(result.err).not.toContain("CANARY-OPTION-SECRET");
  expect(result.out).toBe("");
});

test("the usage text documents commands, paths, formats, exit codes, and credentials", () => {
  for (const command of ["validate", "run", "calibrate", "evaluate", "compare", "inspect"]) {
    expect(USAGE).toContain(command);
  }
  expect(USAGE).toContain(".measuretwice");
  expect(USAGE).toContain("no YAML");
  expect(USAGE).toContain("Exit 0");
  expect(USAGE).toContain("Exit 1");
  expect(USAGE).toContain("Exit 2");
  expect(USAGE).toContain("credential");
  expect(USAGE).toContain("evaluator adapter");
  expect(USAGE).toContain("profile_not_selected");
  expect(USAGE).toContain("trusted application script");
});

// ---------------------------------------------------------------------------
// The validate command, task T055.
// ---------------------------------------------------------------------------

/** Writes one file into one fresh temporary directory and returns its path. */
function tempFile(name: string, content: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "measuretwice-cli-run-"));
  const file = path.join(directory, name);
  writeFileSync(file, content, "utf8");
  return file;
}

/** One case that satisfies every input constraint of the exact-rules fixture. */
function exactCaseFile(id: string, summary: string, notice: string): string {
  return tempFile(`${id}.json`, JSON.stringify({ id, input: { summary, notice } }));
}

test("validate states the meaning of one exact-only definition", async () => {
  const result = await cli(["validate", exactRulesPath]);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toContain("delivery-limits · valid definition");
  expect(result.out).toMatch(/Content hash: [0-9a-f]{64}/);
  expect(result.out).toContain("Inputs: summary, notice");
  expect(result.out).toContain("Checks: 3 (3 exact rules, 0 question checks)");
  expect(result.out).toContain('rule maxLength 80 on summary');
  expect(result.out).toContain('rule includes "delivery limit" on summary');
  expect(result.out).toContain('rule excludes "SECRET" on notice');
  expect(result.out).toContain("with no evaluator and no provider call");
});

test("validate expands the scale acceptance of one ordered question", async () => {
  const result = await cli(["validate", orderedPath]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("Checks: 1 (0 exact rules, 1 question checks)");
  expect(result.out).toContain(
    "ordered question on prior_decision, conversation, proposed_message · accepts meaningful, serious",
  );
  expect(result.out).toContain("The CLI registers none, so run this definition through the library");
});

test("validate prints one JSON summary object with the core kinds", async () => {
  const result = await cli(["validate", categoricalPath, "--format", "json"]);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  const summary = JSON.parse(result.out) as {
    definition: string;
    content_hash: string;
    exact_only: boolean;
    inputs: readonly string[];
    checks: readonly {
      readonly id: string;
      readonly kind: string;
      readonly accept: readonly string[];
      readonly review: readonly string[];
      readonly using: readonly string[];
    }[];
  };
  expect(summary.definition).toBe("message-supported");
  expect(summary.exact_only).toBe(false);
  expect(summary.inputs).toEqual(["prior_decision", "conversation", "proposed_message"]);
  expect(summary.checks).toHaveLength(1);
  expect(summary.checks[0]).toMatchObject({
    id: "message-supported",
    kind: "categorical",
    accept: ["supported"],
    review: ["incomplete"],
  });
});

test("validate refuses malformed, hostile, and unreadable files", async () => {
  const broken = tempFile("broken.json", '{"name": "delivery-limits",\n');
  const malformed = await cli(["validate", broken]);
  expect(malformed.code).toBe(1);
  expect(malformed.err).toContain("invalid_json");
  expect(malformed.out).toBe("");

  const fixture = JSON.parse(
    readFileSync(path.join(repoRoot, "fixtures", "definitions", "invalid.json"), "utf8"),
  ) as {
    records: readonly { raw: unknown; expected: { reason_code: string; field_path: string } }[];
  };
  const first = fixture.records[0]!;
  const invalid = tempFile("invalid.json", JSON.stringify(first.raw));
  const rejected = await cli(["validate", invalid]);
  expect(rejected.code).toBe(1);
  expect(rejected.err).toContain(first.expected.reason_code);

  const hostile = {
    ...JSON.parse(readFileSync(exactRulesPath, "utf8")) as Record<string, unknown>,
    script: "require('node:child_process').execSync('id')",
  };
  const executable = tempFile("hostile.json", JSON.stringify(hostile));
  const refused = await cli(["validate", executable]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("unknown_field");
  expect(refused.err).not.toContain("execSync");

  const missing = await cli(["validate", path.join(tmpdir(), "measuretwice-absent.json")]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("unreadable_file");
});

// ---------------------------------------------------------------------------
// The run command, task T055.
// ---------------------------------------------------------------------------

test("run renders one passing report and exits with code 0", async () => {
  const caseFile = exactCaseFile(
    "case-pass",
    "The summary states the delivery limit.",
    "No secrets here.",
  );
  const result = await cli(["run", exactRulesPath, "--case", caseFile]);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toContain("delivery-limits · run run-");
  expect(result.out).toContain("PASS    The summary fits the delivery limit");
  expect(result.out).toContain("Overall: PASS");
  expect(result.out).toContain("A report authorizes no application action.");
});

test("run renders one failing report with the same exit code 0", async () => {
  const caseFile = exactCaseFile(
    "case-fail",
    "This summary holds more than eighty characters, so the maxLength rule of the definition refuses it.",
    "one SECRET marker",
  );
  const result = await cli(["run", exactRulesPath, "--case", caseFile]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("Overall: FAIL");
  expect(result.out).toContain("The input summary holds more than the maxLength bound of 80 code points.");
});

test("run keeps one skipped check visible as one review outcome", async () => {
  // The structural exact profile admits 4 active and 16 pending checks, so
  // the twenty-first rule check records one queue_full skip and the report
  // states one review outcome.
  const checks = Array.from({ length: 21 }, (_, index) => ({
    id: `length-${index}`,
    name: `Length rule ${index}`,
    using: ["summary"],
    rule: { maxLength: 80 },
  }));
  const definition = tempFile(
    "wide-rules.json",
    JSON.stringify({
      schema_version: 1,
      name: "wide-rules",
      inputs: {
        type: "object",
        properties: { summary: { type: "string", minLength: 1 } },
        required: ["summary"],
        additionalProperties: false,
      },
      checks,
    }),
  );
  const caseFile = tempFile(
    "wide-case.json",
    JSON.stringify({ id: "wide-1", input: { summary: "one short summary" } }),
  );
  const result = await cli(["run", definition, "--case", caseFile]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("SKIPPED Length rule 20");
  expect(result.out).toContain("queue_full");
  expect(result.out).toContain("Overall: REVIEW");
});

test("run prints and writes the report artifact", async () => {
  const caseFile = exactCaseFile("case-artifact", "The summary states the delivery limit.", "ok");
  const out = path.join(path.dirname(caseFile), "report.json");
  const result = await cli(["run", exactRulesPath, "--case", caseFile, "--out", out, "--format", "json"]);
  expect(result.code).toBe(0);
  const printed = JSON.parse(result.out) as { aggregate: { outcome: string }; case: { id: string } };
  expect(printed.aggregate.outcome).toBe("pass");
  expect(printed.case.id).toBe("case-artifact");
  const written = JSON.parse(readFileSync(out, "utf8")) as { schema_version: number };
  expect(written).toEqual(printed);

  const failedDirectory = path.join(path.dirname(caseFile), "absent", "report.json");
  const refused = await cli(["run", exactRulesPath, "--case", caseFile, "--out", failedDirectory]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("unwritable_output");
  expect(refused.out).toBe("");
});

test("run leaks no raw case content on either stream", async () => {
  const canary = "CANARY-CASE-CONTENT";
  const caseFile = exactCaseFile("case-private", `The summary states the delivery limit. ${canary}`, "ok");
  const result = await cli(["run", exactRulesPath, "--case", caseFile, "--format", "json"]);
  expect(result.code).toBe(0);
  expect(result.out).not.toContain(canary);
  expect(result.err).not.toContain(canary);
});

test("run keeps the reason code and field path of one invalid case", async () => {
  const invalid = tempFile(
    "invalid-case.json",
    JSON.stringify({ id: "case-2", input: { summary: "One summary alone." } }),
  );
  const result = await cli(["run", exactRulesPath, "--case", invalid, "--format", "json"]);
  expect(result.code).toBe(1);
  const diagnostic = JSON.parse(result.err) as {
    error: { code: string; field_path: string };
  };
  expect(diagnostic.error.field_path).toContain("/input");

  const broken = tempFile("broken-case.json", '{"id": "case-3",');
  const malformed = await cli(["run", exactRulesPath, "--case", broken]);
  expect(malformed.code).toBe(1);
  expect(malformed.err).toContain("invalid_json");

  const missing = await cli([
    "run",
    exactRulesPath,
    "--case",
    path.join(tmpdir(), "measuretwice-absent-case.json"),
  ]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("unreadable_file");
});

/** Writes one exploration profile of the categorical fixture, bound to the test evaluator. */
async function explorationProfileFile(): Promise<string> {
  const definition = JSON.parse(readFileSync(categoricalPath, "utf8")) as never;
  const evaluator = createLabelOnlyEvaluator({ answers: {} });
  const profile = createExplorationProfile(definition, registerEvaluators(evaluator));
  return tempFile("exploration.json", JSON.stringify(profile));
}

test("run refuses one question check with the CLI evaluator boundary", async () => {
  const caseFile = tempFile(
    "question-case.json",
    JSON.stringify({
      id: "q-1",
      input: { prior_decision: "d", conversation: "c", proposed_message: "m" },
    }),
  );

  const withoutProfile = await cli(["run", categoricalPath, "--case", caseFile]);
  expect(withoutProfile.code).toBe(1);
  expect(withoutProfile.err).toContain("evaluator_mismatch");
  expect(withoutProfile.err).toContain("The CLI registers no evaluator adapter");
  expect(withoutProfile.out).toBe("");

  const profile = await explorationProfileFile();
  const withProfile = await cli([
    "run",
    categoricalPath,
    "--case",
    caseFile,
    "--profile",
    profile,
    "--format",
    "json",
  ]);
  expect(withProfile.code).toBe(1);
  expect(withProfile.out).toBe("");
  const diagnostic = JSON.parse(withProfile.err) as {
    error: { code: string; message: string; field_path: string };
  };
  expect(diagnostic.error.code).toBe("evaluator_mismatch");
  expect(diagnostic.error.field_path).toBe("/profile/bindings/0/evaluator");
  expect(diagnostic.error.message).toContain("label-only-test");
  expect(diagnostic.error.message).toContain("Run question checks through the library");
});

test("run refuses one profile that binds another definition", async () => {
  const caseFile = tempFile(
    "ordered-case.json",
    JSON.stringify({
      id: "o-1",
      input: { prior_decision: "d", conversation: "c", proposed_message: "m" },
    }),
  );
  const profile = await explorationProfileFile();
  const result = await cli([
    "run",
    orderedPath,
    "--case",
    caseFile,
    "--profile",
    profile,
    "--format",
    "json",
  ]);
  expect(result.code).toBe(1);
  const diagnostic = JSON.parse(result.err) as {
    error: { code: string; field_path: string };
  };
  expect(diagnostic.error.code).toBe("definition_mismatch");
  expect(diagnostic.error.field_path).toBe("/profile/definition");
});

test("run refuses enforcement mode with the host selection boundary", async () => {
  const caseFile = exactCaseFile("case-enforce", "The summary states the delivery limit.", "ok");
  const result = await cli([
    "run",
    exactRulesPath,
    "--case",
    caseFile,
    "--mode",
    "enforcement",
  ]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("profile_not_selected");
  expect(result.err).toContain("The CLI states no host profile selection");
  expect(result.out).toBe("");
});

// ---------------------------------------------------------------------------
// The inspect command, task T055.
// ---------------------------------------------------------------------------

/** Writes the structural exact profile of the exact-rules fixture. */
async function exactProfileFile(): Promise<string> {
  const reviewer = await load(exactRulesPath);
  return tempFile("exact-profile.json", JSON.stringify(reviewer.profile));
}

test("inspect states the readable summary of one profile", async () => {
  const profile = await exactProfileFile();
  const result = await cli(["inspect", profile]);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toContain("Profile delivery-limits-exact (exact)");
  expect(result.out).toContain("Readiness: validated for scope (validated_for_scope)");
  expect(result.out).toContain("Reasons: exact_rules_only");
});

test("inspect adds the bindings, policy, execution, and evidence on request", async () => {
  const exploration = await explorationProfileFile();
  const result = await cli(["inspect", exploration, "--detail", "detailed"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("Bindings");
  expect(result.out).toContain("evaluator label-only-test · adapter 0.1.0");
  expect(result.out).toContain("Policy");
  expect(result.out).toContain("family: probability_mass_v0");
  expect(result.out).toContain("accept >= 0.8 · reject >= 0.6");
  expect(result.out).toContain("Execution");
  expect(result.out).toContain("30000 ms deadline · 2 attempts · 200 ms backoff");
  expect(result.out).toContain("Identity");
  expect(result.out).toContain("content hash:");
  expect(result.out).toContain("Limitations");
  // The summary view states no numerical detail.
  const summary = await cli(["inspect", exploration]);
  expect(summary.out).not.toContain("Bindings");
  expect(summary.out).not.toContain("accept >= 0.8");
});

test("inspect prints the stored artifact as JSON", async () => {
  const profile = await exactProfileFile();
  const result = await cli(["inspect", profile, "--format", "json"]);
  expect(result.code).toBe(0);
  const artifact = JSON.parse(result.out) as {
    id: string;
    schema_version: number;
    qualification: { status: string };
  };
  expect(artifact.id).toBe("delivery-limits-exact");
  expect(artifact.schema_version).toBe(1);
  expect(artifact.qualification.status).toBe("validated_for_scope");
});

test("inspect refuses one edited profile with the registry code", async () => {
  const profile = await exactProfileFile();
  const artifact = JSON.parse(readFileSync(profile, "utf8")) as Record<string, unknown>;
  const edited = tempFile("edited.json", JSON.stringify({ ...artifact, intended_use: "edited" }));
  const result = await cli(["inspect", edited]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("hash_mismatch");
  expect(result.out).toBe("");
});

test("the compiled entry point runs one case and writes the report", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "measuretwice-cli-child-"));
  const caseFile = path.join(directory, "case.json");
  const out = path.join(directory, "report.json");
  writeFileSync(
    caseFile,
    JSON.stringify({
      id: "child-1",
      input: { summary: "The summary states the delivery limit.", notice: "No secrets here." },
    }),
    "utf8",
  );
  const { stdout } = await execFileAsync("node", [
    cliPath,
    "run",
    exactRulesPath,
    "--case",
    caseFile,
    "--out",
    out,
  ]);
  expect(stdout).toContain("Overall: PASS");
  const written = JSON.parse(readFileSync(out, "utf8")) as { case: { id: string } };
  expect(written.case.id).toBe("child-1");
});
