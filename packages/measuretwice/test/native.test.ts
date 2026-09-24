// SPDX-License-Identifier: Apache-2.0
/**
 * Native-boundary tests.
 *
 * These tests drive the shared conformance fixtures through the NAPI-RS
 * binding and the internal wrapper in `src/native.ts`. They cover valid
 * requests, malformed data, the stable TypeScript failure shape, numeric
 * and string behavior across the boundary, and the run state transitions.
 * They read local files only, so they stay offline and deterministic.
 */
import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  NativeFailure,
  nativeAssessRuleChecks,
  nativeCanonicalForm,
  nativeComputeSelfHash,
  nativeContentHash,
  nativeCreateRunState,
  nativeDatasetHash,
  nativeSplitHash,
  nativeValidateCase,
  nativeValidateDefinition,
  nativeVerifySelfHash,
  runAcceptResult,
  runCancel,
  runComplete,
  runDeadline,
  runFailAttempt,
  runSkipQueueFull,
  runStartAttempt,
  type RunState,
} from "../src/native.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Reads one fixture file as text. */
function fixtureText(relative: string): string {
  return readFileSync(path.join(repoRoot, "fixtures", relative), "utf8");
}

/** Reads one fixture file as a JSON value. */
// The fixture documents are trusted repo data, so one broad value type is
// enough here.
function fixtureDocument(relative: string): any {
  return JSON.parse(fixtureText(relative));
}

/** Runs one operation and returns the stable failure it must throw. */
function failureOf(operation: () => unknown): NativeFailure {
  try {
    operation();
  } catch (error) {
    if (error instanceof NativeFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("the operation was accepted");
}

/** Every valid definition fixture with its check kinds and exact-only flag. */
const VALID_KINDS: ReadonlyArray<readonly [string, string[], boolean]> = [
  ["all-input-types", ["binary", "rule"], false],
  ["binary-question", ["binary"], false],
  ["categorical-question", ["categorical"], false],
  ["exact-rules", ["rule", "rule", "rule"], true],
  ["memory-length", ["rule"], true],
  ["memory-length-explicit", ["rule"], true],
  ["ordered-scale", ["ordered"], false],
];

test("every valid definition validates with its stated kinds", () => {
  let exactOnlySeen = false;
  for (const [stem, kinds, exactOnly] of VALID_KINDS) {
    const info = nativeValidateDefinition(fixtureText(`definitions/valid/${stem}.json`));
    expect(info.checkKinds.map((entry) => entry.kind), stem).toEqual(kinds);
    expect(info.checkKinds.map((entry) => entry.id), stem).toHaveLength(kinds.length);
    // The one documented default: an omitted when_uncertain means review.
    expect(info.effectiveWhenUncertain, stem).toBe("review");
    expect(info.isExactOnly, stem).toBe(exactOnly);
    expect(info.definitionHash, stem).toMatch(/^[0-9a-f]{64}$/);
    exactOnlySeen ||= exactOnly;
  }
  expect(exactOnlySeen).toBe(true);
});

test("the when_uncertain default gives the pair one hash", () => {
  const omitted = nativeValidateDefinition(fixtureText("definitions/valid/memory-length.json"));
  const stated = nativeValidateDefinition(
    fixtureText("definitions/valid/memory-length-explicit.json"),
  );
  expect(omitted.name).toBe("memory-supported");
  expect(omitted.definitionHash).toBe(stated.definitionHash);
  // A definition that states the default hashes like the same artifact
  // through the generic definition domain.
  expect(stated.definitionHash).toBe(
    nativeContentHash("definition", fixtureText("definitions/valid/memory-length-explicit.json")),
  );
});

test("definition rejections report the stated codes and paths", () => {
  const records: Array<{ note: string; raw: unknown; expected: { reason_code: string; field_path: string } }> =
    fixtureDocument("definitions/invalid.json").records;
  expect(records.length).toBeGreaterThanOrEqual(20);
  const covered = new Set<string>();
  for (const record of records) {
    const failure = failureOf(() =>
      nativeValidateDefinition(JSON.stringify(record.raw)),
    );
    expect(failure.code, record.note).toBe(record.expected.reason_code);
    expect(failure.fieldPath, record.note).toBe(record.expected.field_path);
    expect(failure.message, record.note).not.toBe("");
    covered.add(failure.code);
  }
  for (const code of [
    "duplicate_id",
    "unknown_input_name",
    "accept_review_overlap",
    "unknown_label",
    "invalid_scale",
    "empty_check_set",
    "unsupported_keyword",
    "unsupported_schema_version",
    "unknown_field",
    "missing_field",
    "invalid_field_type",
  ]) {
    expect(covered, code).toContain(code);
  }
});

/** Builds one probe definition around one root input schema. */
function probeDefinition(inputs: unknown): string {
  const properties = (inputs as { properties: Record<string, unknown> }).properties;
  const first = Object.keys(properties)[0];
  expect(first).toBeDefined();
  return JSON.stringify({
    schema_version: 1,
    name: "input-validation",
    inputs,
    checks: [
      {
        id: "probe",
        name: "The probe check",
        using: [first],
        question: "Does the input satisfy the record?",
        answers: { yes: "It does.", no: "It does not." },
      },
    ],
  });
}

/** Materializes one oversized input object from its fixture description. */
function materializeOversized(record: {
  inputs: unknown;
  oversized: { kind: string; fill: string; utf8_bytes?: number; items?: number };
}): Record<string, unknown> {
  const properties = (record.inputs as { properties: Record<string, unknown> }).properties;
  const name = Object.keys(properties)[0];
  if (name === undefined) {
    throw new Error("the record declares no input");
  }
  if (record.oversized.kind === "string") {
    const fill = record.oversized.fill;
    const bytes = record.oversized.utf8_bytes;
    if (bytes === undefined) {
      throw new Error("the string record states no byte count");
    }
    return { [name]: fill.repeat(bytes / fill.length) };
  }
  const items = record.oversized.items;
  if (items === undefined) {
    throw new Error("the array record states no item count");
  }
  return { [name]: Array.from({ length: items }, () => record.oversized.fill) };
}

test("input validation records report the stated codes and paths", () => {
  const records: Array<{
    note: string;
    inputs: unknown;
    input?: Record<string, unknown>;
    valid: boolean;
    expected?: { reason_code: string; field_path: string };
    oversized?: { kind: string; fill: string; utf8_bytes?: number; items?: number };
  }> = fixtureDocument("inputs/validation.json").records;
  expect(records.length).toBeGreaterThanOrEqual(20);
  let oversizedSeen = false;
  for (const record of records) {
    const definitionText = probeDefinition(record.inputs);
    if (record.input === undefined && record.oversized === undefined) {
      throw new Error(`${record.note}: the record states no input and no size`);
    }
    const input =
      record.input ?? materializeOversized({ inputs: record.inputs, oversized: record.oversized! });
    const caseText = JSON.stringify({ id: "input-validation", input });
    if (record.valid) {
      const info = nativeValidateCase(definitionText, caseText);
      expect(info.projectedInputs, record.note).toHaveLength(1);
      expect(info.projectedInputs[0]?.checkId, record.note).toBe("probe");
      expect(info.projectedInputs[0]?.inputs, record.note).toHaveProperty(
        Object.keys(input)[0] ?? "",
      );
    } else {
      const failure = failureOf(() => nativeValidateCase(definitionText, caseText));
      expect(failure.code, record.note).toBe(record.expected?.reason_code);
      expect(failure.fieldPath, record.note).toBe(record.expected?.field_path);
      oversizedSeen ||= failure.code === "oversized_input";
    }
  }
  expect(oversizedSeen).toBe(true);
});

test("canonical fixtures match their forms and digests", () => {
  const records: Array<{
    note: string;
    domain: string;
    value: unknown;
    canonical: string;
    content_hash: string;
  }> = fixtureDocument("hashing/canonical.json").hashes;
  expect(records.length).toBeGreaterThanOrEqual(15);
  const domains = new Set<string>();
  for (const record of records) {
    const text = JSON.stringify(record.value);
    // The definition boundary materializes the when_uncertain default, so
    // its expected canonical form is proven through its digest below.
    if (record.domain !== "definition") {
      expect(nativeCanonicalForm(text), record.note).toBe(record.canonical);
    }
    let digest: string;
    switch (record.domain) {
      case "definition":
        digest = nativeValidateDefinition(text).definitionHash;
        break;
      case "profile":
      case "plan":
        digest = nativeComputeSelfHash(record.domain, text);
        break;
      case "dataset":
      case "split": {
        const ordered = [...(record.value as unknown[])];
        digest =
          record.domain === "dataset"
            ? nativeDatasetHash(text)
            : nativeSplitHash(text);
        // Reordering the record set does not change the hash.
        const reversed = JSON.stringify(ordered.reverse());
        const reversedDigest =
          record.domain === "dataset"
            ? nativeDatasetHash(reversed)
            : nativeSplitHash(reversed);
        expect(reversedDigest, record.note).toBe(digest);
        break;
      }
      default:
        digest = nativeContentHash(record.domain, text);
    }
    expect(digest, record.note).toBe(record.content_hash);
    domains.add(record.domain);
  }
  for (const tag of [
    "definition",
    "input",
    "translation",
    "profile",
    "plan",
    "dataset",
    "split",
  ]) {
    expect(domains, tag).toContain(tag);
  }
});

test("hashing rejections keep their codes at the boundary", () => {
  const records: Array<{ note: string; raw_text?: string; expected: { reason_code: string } }> =
    fixtureDocument("hashing/invalid.json").records;
  expect(records.length).toBeGreaterThanOrEqual(5);
  for (const record of records) {
    const text = record.raw_text;
    if (text === undefined) {
      // The ill-formed UTF-8 record cannot cross as JavaScript text. The
      // Rust suite owns it; the boundary owns every text rejection.
      continue;
    }
    const failure = failureOf(() => nativeCanonicalForm(text));
    expect(failure.code, record.note).toBe(record.expected.reason_code);
  }
  // A lone surrogate inside JavaScript text becomes an escaped surrogate in
  // the serialized artifact, and the strict gate rejects it.
  const escaped = JSON.stringify({ text: "\ud800" });
  expect(failureOf(() => nativeCanonicalForm(escaped)).code).toBe("nonportable_value");
});

test("profile states verify their self hash", () => {
  const document = fixtureDocument("profiles/states.json");
  const profiles: Array<Record<string, unknown>> = document.profiles;
  expect(profiles.length).toBeGreaterThanOrEqual(5);
  for (const profile of profiles) {
    const text = JSON.stringify(profile);
    const id = profile.id;
    expect(nativeComputeSelfHash("profile", text)).toBe(profile.content_hash);
    expect(() => nativeVerifySelfHash("profile", text)).not.toThrow();
    // An edited copy fails with hash_mismatch.
    const edited = { ...profile, intended_use: "Enforcement use." };
    const failure = failureOf(() => nativeVerifySelfHash("profile", JSON.stringify(edited)));
    expect(failure.code).toBe("hash_mismatch");
    expect(typeof id).toBe("string");
  }
});

/** Builds one single-rule definition and case around one string rule record. */
function ruleScenario(record: {
  rule: string;
  parameter: number | string;
  input: string;
}): { definitionText: string; caseText: string } {
  return {
    definitionText: JSON.stringify({
      schema_version: 1,
      name: "rule-probe",
      inputs: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      checks: [
        {
          id: "probe",
          name: "The probe rule",
          using: ["text"],
          rule: { [record.rule]: record.parameter },
        },
      ],
    }),
    caseText: JSON.stringify({ id: "rule-probe", input: { text: record.input } }),
  };
}

test("string rule records match their outcomes through complete runs", () => {
  const records: Array<{
    note: string;
    rule: string;
    parameter: number | string;
    input: string;
    outcome: string;
  }> = fixtureDocument("hashing/string-rules.json").string_rules;
  expect(records.length).toBeGreaterThanOrEqual(20);
  const keywords = new Set<string>();
  for (const record of records) {
    const { definitionText, caseText } = ruleScenario(record);
    const results = nativeAssessRuleChecks(definitionText, caseText);
    expect(results, record.note).toHaveLength(1);
    const result = results[0];
    expect(result?.check, record.note).toBe("probe");
    expect(result?.outcome, record.note).toBe(record.outcome);
    expect(result?.reason, record.note).not.toBe("");
    const applied = result?.appliedRule as { rule: string; input: string };
    expect(applied.rule, record.note).toBe(record.rule);
    expect(applied.input, record.note).toBe("text");
    // The record text parses back through the boundary.
    expect(JSON.parse(result?.record ?? "{}").outcome, record.note).toBe(record.outcome);
    keywords.add(record.rule);
  }
  for (const keyword of ["maxLength", "includes", "excludes"]) {
    expect(keywords, keyword).toContain(keyword);
  }
});

/** One fixed profile binding for the trace replays, as the Rust suite uses. */
const TRACE_PROFILE = JSON.stringify({ id: "trace-profile", content_hash: "1f".repeat(32) });

/** Builds the component record of one trace result. */
function traceRecord(
  rules: Map<string, { record: string }>,
  checkId: string,
  outcome: string,
): string {
  const rule = rules.get(checkId);
  if (rule !== undefined) {
    return rule.record;
  }
  // A question check records the trace outcome the wrapper observed.
  return JSON.stringify({ check: checkId, kind: "question", outcome });
}

test("runtime traces replay through the boundary", () => {
  const traces: Array<{
    id: string;
    definition: string;
    case_input: Record<string, unknown>;
    config: { max_attempts: number };
    events: Array<{ type: string; check?: string; outcome?: string; code?: string }>;
    expected: {
      checks: Array<Record<string, unknown>>;
      aggregate: string;
      completion: string;
      rejected_events: Array<{ event: number; reason_code: string }>;
    };
  }> = fixtureDocument("runtime/traces.json").traces;
  expect(traces.length).toBeGreaterThanOrEqual(10);

  const statuses = new Set<string>();
  const codes = new Set<string>();
  for (const trace of traces) {
    const note = trace.id;
    const definitionText = fixtureText(`definitions/valid/${trace.definition}`);
    const caseText = JSON.stringify({ id: note, input: trace.case_input });
    const caseInfo = nativeValidateCase(definitionText, caseText);
    const caseReference = JSON.stringify({ id: caseInfo.id, input_hash: caseInfo.inputHash });

    // The exact rules of the trace definition, when it holds any.
    const rules = new Map(
      nativeAssessRuleChecks(definitionText, caseText).map((result) => [result.check, result]),
    );

    const run = nativeCreateRunState(
      definitionText,
      caseReference,
      TRACE_PROFILE,
      note,
      "shadow",
      trace.config.max_attempts,
    );
    expect(run.phase, note).toBe("running");

    const rejections: Array<{ event: number; code: string }> = [];
    for (const [index, event] of trace.events.entries()) {
      const check = event.check;
      switch (event.type) {
        case "submit":
          expect(index, note).toBe(0);
          break;
        case "check_started":
          runStartAttempt(run, check!, caseReference, TRACE_PROFILE);
          break;
        case "check_result": {
          // The wrapper restarts a retrying check before its result.
          if (run.status(check!)?.place === "pending" && run.phase === "running") {
            runStartAttempt(run, check!, caseReference, TRACE_PROFILE);
          }
          try {
            runAcceptResult(run, check!, traceRecord(rules, check!, event.outcome!));
          } catch (error) {
            if (!(error instanceof NativeFailure)) {
              throw error;
            }
            rejections.push({ event: index, code: error.code });
          }
          break;
        }
        case "late_result": {
          if (run.phase === "running") {
            runComplete(run, null);
          }
          try {
            runAcceptResult(run, check!, traceRecord(rules, check!, event.outcome!));
          } catch (error) {
            if (!(error instanceof NativeFailure)) {
              throw error;
            }
            rejections.push({ event: index, code: error.code });
          }
          break;
        }
        case "attempt_failed": {
          if (run.status(check!)?.place === "pending") {
            runStartAttempt(run, check!, caseReference, TRACE_PROFILE);
          }
          const resolution = runFailAttempt(
            run,
            check!,
            event.code!,
            "The adapter failed the attempt.",
          );
          codes.add(resolution.resolution);
          break;
        }
        case "check_skipped":
          expect(event.code, note).toBe("queue_full");
          runSkipQueueFull(run, check!);
          break;
        case "cancel":
          runCancel(run, null);
          break;
        case "deadline":
          runDeadline(run, null);
          break;
        default:
          throw new Error(`${note}: unknown event type ${event.type}`);
      }
    }

    // A drained run completes; a terminal run is already frozen.
    if (run.phase === "running") {
      runComplete(run, null);
    }

    const report = JSON.parse(run.reportText() ?? "{}");
    statuses.add(report.completion.status);
    expect(report.completion.status, note).toBe(trace.expected.completion);
    expect(report.aggregate.outcome, note).toBe(trace.expected.aggregate);
    expect(report.run_id, note).toBe(note);
    expect(report.checks, note).toHaveLength(trace.expected.checks.length);
    for (const [record, want] of report.checks.map(
      (record: Record<string, unknown>, index: number) => [
        record,
        trace.expected.checks[index],
      ],
    )) {
      expect(record.check, note).toBe(want.check);
      expect(record.outcome, note).toBe(want.outcome);
      if (want.attempts !== undefined) {
        expect(record.attempts, note).toBe(want.attempts);
      }
      if ((want as { reason?: { code: string } }).reason !== undefined) {
        const code = (record as { reason?: { code: string } }).reason?.code;
        expect(code, note).toBe((want as { reason: { code: string } }).reason.code);
        codes.add(code ?? "");
      }
      if ((want as { applied_rule?: unknown }).applied_rule !== undefined) {
        expect(record.applied_rule, note).toEqual(want.applied_rule);
      }
    }

    // The refused events carry the stated indexes and reason codes.
    expect(rejections, note).toEqual(
      trace.expected.rejected_events.map((wanted) => ({
        event: wanted.event,
        code: wanted.reason_code,
      })),
    );
  }
  expect(statuses).toContain("completed");
  expect(statuses).toContain("cancelled");
  expect(statuses).toContain("deadline_exceeded");
  expect(codes).toContain("retry_queued");
  expect(codes).toContain("exhausted");
});

test("run state refuses drifted, late, and malformed events", () => {
  const definitionText = fixtureText("definitions/valid/exact-rules.json");
  const caseText = JSON.stringify({
    id: "boundary-case",
    input: { summary: "The delivery limit is 900 characters", notice: "One notice." },
  });
  const caseInfo = nativeValidateCase(definitionText, caseText);
  const caseReference = JSON.stringify({ id: caseInfo.id, input_hash: caseInfo.inputHash });
  const run = nativeCreateRunState(
    definitionText,
    caseReference,
    TRACE_PROFILE,
    "boundary-run",
    "shadow",
    2,
  );
  expect(run.checkIds()).toEqual([
    "summary-length",
    "summary-mentions-limit",
    "notice-hides-secrets",
  ]);
  expect(run.status("summary-length")).toEqual({ place: "pending", attempts: 0 });
  expect(run.status("missing-check")).toBeNull();

  // A drifted case binding is refused and changes no state.
  const drifted = JSON.stringify({ id: caseInfo.id, input_hash: "0".repeat(64) });
  const drift = failureOf(() => runStartAttempt(run, "summary-length", drifted, TRACE_PROFILE));
  expect(drift.code).toBe("invalid_state_transition");
  expect(drift.fieldPath).toBe("/case/input_hash");
  expect(run.status("summary-length")).toEqual({ place: "pending", attempts: 0 });

  // The run binding starts and retries inside its budget.
  expect(runStartAttempt(run, "summary-length", caseReference, TRACE_PROFILE)).toBe(1);
  const retried = runFailAttempt(run, "summary-length", "evaluator_error", "The adapter failed.");
  expect(retried).toEqual({ resolution: "retry_queued", attempts: 1 });
  expect(runStartAttempt(run, "summary-length", caseReference, TRACE_PROFILE)).toBe(2);

  // A malformed record text is refused before it can change state.
  const malformed = failureOf(() => runAcceptResult(run, "summary-length", "{\"check\": "));
  expect(malformed.code).toBe("invalid_json");
  const wrongShape = failureOf(() =>
    runAcceptResult(run, "summary-length", JSON.stringify({ check: "summary-length" })),
  );
  expect(wrongShape.code).toBe("missing_field");

  // A reason code outside the operational set is refused by the core
  // boundary, and a text outside the registry is refused by the binding.
  const badCode = failureOf(() =>
    runFailAttempt(run, "summary-length", "queue_full", "Not operational."),
  );
  expect(badCode.code).toBe("invalid_field_type");
  expect(badCode.fieldPath).toBe("/reason/code");
  const unknownCode = failureOf(() =>
    runFailAttempt(run, "summary-length", "not_a_code", "Unknown."),
  );
  expect(unknownCode.code).toBe("invalid_field_type");
  expect(unknownCode.fieldPath).toBe("/code");

  // The rule record of the assessment is accepted, and a repeat is refused.
  const [rule] = nativeAssessRuleChecks(definitionText, caseText);
  runAcceptResult(run, "summary-length", rule!.record);
  const duplicate = failureOf(() => runAcceptResult(run, "summary-length", rule!.record));
  expect(duplicate.code).toBe("invalid_state_transition");

  // The remaining checks skip and complete.
  runSkipQueueFull(run, "summary-mentions-limit");
  runSkipQueueFull(run, "notice-hides-secrets");
  runComplete(run, "2026-09-24T00:00:00Z");
  const report = JSON.parse(run.reportText() ?? "{}");
  expect(report.completion).toEqual({
    status: "completed",
    completed_at: "2026-09-24T00:00:00Z",
  });
  expect(report.aggregate.outcome).toBe("review");
  expect(report.checks[0]).toMatchObject({ check: "summary-length", outcome: "pass" });

  // A terminal run refuses every further event, including late results.
  expect(failureOf(() => runStartAttempt(run, "summary-length", caseReference, TRACE_PROFILE)).code)
    .toBe("invalid_state_transition");
  const late = failureOf(() => runAcceptResult(run, "summary-length", rule!.record));
  expect(late.code).toBe("late_result_rejected");
  const frozen = failureOf(() => runCancel(run, null));
  expect(frozen.code).toBe("invalid_state_transition");
  // The frozen report keeps its value.
  expect(JSON.parse(run.reportText() ?? "{}")).toEqual(report);
});

test("run creation validates its mode, limits, and references", () => {
  const definitionText = fixtureText("definitions/valid/exact-rules.json");
  const caseText = JSON.stringify({
    id: "boundary-case",
    input: { summary: "The delivery limit is 900 characters", notice: "One notice." },
  });
  const caseInfo = nativeValidateCase(definitionText, caseText);
  const caseReference = JSON.stringify({ id: caseInfo.id, input_hash: caseInfo.inputHash });

  expect(failureOf(() =>
    nativeCreateRunState(definitionText, caseReference, TRACE_PROFILE, "r", "fast", 1),
  ).code).toBe("invalid_field_type");
  const attempts = failureOf(() =>
    nativeCreateRunState(definitionText, caseReference, TRACE_PROFILE, "r", "shadow", 0),
  );
  expect(attempts.code).toBe("invalid_field_type");
  expect(attempts.fieldPath).toBe("/max_attempts");
  expect(
    failureOf(() =>
      nativeCreateRunState(definitionText, caseReference, TRACE_PROFILE, "r", "shadow", 1.5),
    ).code,
  ).toBe("invalid_field_type");
  const unknownField = failureOf(() =>
    nativeCreateRunState(
      definitionText,
      JSON.stringify({ id: caseInfo.id, input_hash: caseInfo.inputHash, extra: 1 }),
      TRACE_PROFILE,
      "r",
      "shadow",
      1,
    ),
  );
  expect(unknownField.code).toBe("unknown_field");
  expect(unknownField.fieldPath).toBe("/case/extra");
  const badHash = failureOf(() =>
    nativeCreateRunState(
      definitionText,
      JSON.stringify({ id: caseInfo.id, input_hash: "nope" }),
      TRACE_PROFILE,
      "r",
      "shadow",
      1,
    ),
  );
  expect(badHash.code).toBe("invalid_field_type");
  expect(badHash.fieldPath).toBe("/case/input_hash");
  expect(failureOf(() =>
    nativeCreateRunState(definitionText, caseReference, TRACE_PROFILE, "", "shadow", 1),
  ).fieldPath).toBe("/run_id");
});

test("numbers and strings keep their behavior across the boundary", () => {
  const definitionText = JSON.stringify({
    schema_version: 1,
    name: "boundary-values",
    inputs: {
      type: "object",
      properties: {
        text: { type: "string" },
        weight: { type: "number" },
        count: { type: "integer" },
        flag: { type: "boolean" },
      },
      required: ["text", "weight", "count", "flag"],
      additionalProperties: false,
    },
    checks: [
      { id: "text-length", name: "The text fits", using: ["text"], rule: { maxLength: 5 } },
      {
        id: "value-question",
        name: "The values satisfy the record",
        using: ["text", "weight", "count", "flag"],
        question: "Do the values satisfy the record?",
        answers: { yes: "They do.", no: "They do not." },
      },
    ],
  });

  // Astral-plane text keeps its exact code points, and every number keeps
  // its value inside the authorized projection of the question check.
  const caseText = JSON.stringify({
    id: "values",
    input: { text: "a😀b", weight: 0.5, count: 900, flag: true },
  });
  const info = nativeValidateCase(definitionText, caseText);
  expect(info.projectedInputs).toHaveLength(2);
  const projected = info.projectedInputs[1]?.inputs as Record<string, unknown>;
  expect(projected.text).toBe("a😀b");
  expect((projected.text as string).length).toBe(4); // UTF-16 units in JavaScript
  expect(projected.weight).toBe(0.5);
  expect(projected.count).toBe(900);
  expect(projected.flag).toBe(true);
  // The rule projection holds its one declared input, nothing else.
  expect(info.projectedInputs[0]?.inputs).toEqual({ text: "a😀b" });
  // The rule counts code points, not UTF-16 units: 3 pass maxLength 5.
  expect(nativeAssessRuleChecks(definitionText, caseText)[0]?.outcome).toBe("pass");

  // The input hash covers the original text, so case identity never depends
  // on JavaScript number handling.
  const exactText =
    '{"id":"values","input":{"text":"ab","weight":0.5,"count":9007199254740993,"flag":true}}';
  const exact = nativeValidateCase(definitionText, exactText);
  expect(exact.inputHash).toBe(
    nativeContentHash(
      "input",
      '{"text":"ab","weight":0.5,"count":9007199254740993,"flag":true}',
    ),
  );
  // An integer above the safe range crosses as one exact BigInt value, so
  // the wrapper receives the value the core read, not a rounded double.
  const exactProjected = exact.projectedInputs[1]?.inputs as Record<string, unknown>;
  expect(exactProjected.count).toBe(9007199254740993n);
  expect(String(exactProjected.count)).toBe("9007199254740993");

  // Numbers in canonical forms follow the hashing contract, not the
  // JavaScript spelling that arrived.
  expect(nativeCanonicalForm('{"weight":1.0}')).toBe('{"weight":1}');
  expect(nativeCanonicalForm('{"weight":-0.0}')).toBe('{"weight":0}');
  expect(nativeCanonicalForm('{"weight":1e21}')).toBe('{"weight":1e+21}');
  expect(nativeCanonicalForm('{"weight":1e-7}')).toBe('{"weight":1e-7}');
});

test("failures translate into stable TypeScript errors", () => {
  const failure = failureOf(() => nativeValidateDefinition("{"));
  expect(failure).toBeInstanceOf(Error);
  expect(failure.name).toBe("NativeFailure");
  expect(failure.code).toBe("invalid_json");
  expect(failure.fieldPath).toBe("");
  expect(failure.message).toContain("valid JSON");

  // An unknown domain is a domain failure, not a bridge failure.
  const domain = failureOf(() => nativeContentHash("outside", "{}"));
  expect(domain.code).toBe("invalid_field_type");
  expect(domain.fieldPath).toBe("/domain");

  // A bridge failure, such as a wrong argument type, carries no domain data
  // and passes through unchanged.
  let bridge: unknown;
  try {
    nativeValidateDefinition(42 as unknown as string);
  } catch (error) {
    bridge = error;
  }
  expect(bridge).toBeDefined();
  expect(bridge).not.toBeInstanceOf(NativeFailure);
  expect(bridge).toBeInstanceOf(Error);
});

test("loading and exercising the binding performs no provider calls or storage", () => {
  const bindingPath = path.join(
    repoRoot,
    "node_modules",
    "measuretwice-node",
    "index.js",
  );
  const definitionText = fixtureText("definitions/valid/exact-rules.json");
  const caseText = JSON.stringify({
    id: "offline",
    input: { summary: "The delivery limit is 900 characters", notice: "One notice." },
  });
  const child = `
globalThis.fetch = () => { throw new Error("provider call attempted"); };
const binding = await import(${JSON.stringify(pathToFileURL(bindingPath).href)});
const { nativeValidateDefinition, nativeValidateCase, nativeAssessRuleChecks,
        nativeCreateRunState, runStartAttempt, runAcceptResult, runComplete,
        NativeFailure } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "packages/measuretwice/dist/native.js")).href)});
const info = nativeValidateDefinition(${JSON.stringify(definitionText)});
const caseInfo = nativeValidateCase(${JSON.stringify(definitionText)}, ${JSON.stringify(caseText)});
if (info.definitionHash !== nativeValidateDefinition(${JSON.stringify(definitionText)}).definitionHash) {
  throw new Error("hash drift");
}
const rules = nativeAssessRuleChecks(${JSON.stringify(definitionText)}, ${JSON.stringify(caseText)});
const caseReference = JSON.stringify({ id: caseInfo.id, input_hash: caseInfo.inputHash });
const profile = JSON.stringify({ id: "offline-profile", content_hash: "1f".repeat(32) });
const run = nativeCreateRunState(${JSON.stringify(definitionText)}, caseReference, profile, "offline-run", "shadow", 1);
for (const rule of rules) {
  runStartAttempt(run, rule.check, caseReference, profile);
  runAcceptResult(run, rule.check, rule.record);
}
runComplete(run, "2026-09-24T00:00:00Z");
const report = JSON.parse(run.reportText());
if (report.aggregate.outcome !== "pass" || report.completion.status !== "completed") {
  throw new Error("unexpected report");
}
try {
  nativeValidateDefinition("{");
  throw new Error("no failure thrown");
} catch (error) {
  if (!(error instanceof NativeFailure) || error.code !== "invalid_json") {
    throw error;
  }
}
if (typeof binding.assessRuleChecks !== "function") {
  throw new Error("binding surface changed");
}
console.log("BOUNDARY_OK");
`;
  const work = mkdtempSync(path.join(tmpdir(), "measuretwice-boundary-"));
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", child],
      { cwd: work, encoding: "utf8" },
    );
    expect(stdout).toContain("BOUNDARY_OK");
    // The binding wrote no application storage into its working directory.
    expect(readdirSync(work)).toEqual([]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
