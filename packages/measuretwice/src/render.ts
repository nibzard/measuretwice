// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal and Markdown renderers for run reports and profile summaries.
 *
 * A renderer is one pure function of validated artifacts: it reads no
 * clock, opens no file, and calls no evaluator. `renderRunReport` renders
 * one frozen run report of one bound definition as terminal text,
 * `renderRunReportMarkdown` renders the same view as Markdown, and
 * `renderProfileSummary` with `renderProfileSummaryMarkdown` renders one
 * profile artifact. The `detail` option selects the two inspection levels
 * of MVP_SPEC.md section 8: the summary leads with the check meaning, the
 * component outcomes, the aggregate outcome, and the next useful action,
 * and the detail view adds the applied rules, the measurements, the
 * identities, the versions, the counts, the evidence references, the key
 * of the view terms, and the limitations.
 *
 * Every explanation is generated from the check criteria of the definition
 * and the executed policy of the record. Jev produces no bespoke textual
 * rationale, so the renderer invents none: it states the selected answer,
 * its authored description, and the cutoff arithmetic of the
 * `probability_mass_v0` family, or the executed parameters of one exact
 * rule. Evidence references render as evaluator-selected support, because
 * the Rust core validates every reference against the `using` list of its
 * check. Supplied case content never renders, because the report holds
 * none, and one absent measurement stays absent.
 *
 * A renderer verifies its inputs before it renders. The definition crosses
 * the core validator, and its content hash must equal the hash that the
 * report names, so every check name states the meaning of the artifacts
 * that produced the report. The component outcomes must fold to the stored
 * aggregate outcome. The profile crosses the core self-hash and the
 * complete profile contract, so one edited copy fails with `hash_mismatch`
 * instead of rendering as the reviewed artifact.
 *
 * Side effects: none.
 *
 * Failure behavior: invalid data throws one public {@link ValidationError}
 * with a stable reason code and a field path, before any rendering.
 */
import type { CheckDefinition, Definition, JSONValue } from "./define-checks.js";
import { ValidationError } from "./error.js";
import {
  NativeFailure,
  nativeValidateDefinition,
  nativeValidateProfile,
  nativeVerifySelfHash,
} from "./native.js";
import type {
  AggregateOutcome,
  AppliedRuleRecord,
  CheckOutcome,
  Profile,
  QualificationStatus,
  RunCheckRecord,
  RunReport,
} from "./run.js";

/** The inspection levels of one rendered view. */
export type RenderDetail = "summary" | "detail";

/** The options of one renderer. */
export interface RenderOptions {
  /** The inspection level. The default is the summary view. */
  readonly detail?: RenderDetail;
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/** The column width of one outcome label in the terminal view. */
const LABEL_WIDTH = 8;

/** The indentation of every continuation line below one check row. */
const INDENT = " ".repeat(LABEL_WIDTH);

/** The component outcome words of the run report contract. */
const OUTCOME_WORDS = new Set(["pass", "fail", "review", "error", "skipped"]);

/** The readable readiness phrase of each qualification status. */
const READINESS: Record<QualificationStatus, string> = {
  unvalidated: "unvalidated",
  insufficient_evidence: "insufficient evidence",
  criteria_not_met: "criteria not met",
  validated_for_scope: "validated for scope",
};

/** The next useful action for each aggregate outcome. */
const NEXT_ACTION: Record<AggregateOutcome, string> = {
  pass: "Your application can consider this candidate. Its own permissions and delivery rules still apply.",
  fail: "Inspect the failed check before you use this candidate.",
  review: "Review the supplied evidence before you decide on this candidate.",
  error: "Execution established no complete judgment. Inspect the recorded failure before you use this candidate.",
};

/** Runs one core operation and rethrows its failure as the public error. */
function throughCore<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof NativeFailure) {
      throw new ValidationError(error.code, error.message, error.fieldPath);
    }
    throw error;
  }
}

/** Serializes one artifact and rejects what JSON cannot preserve. */
function jsonText(value: unknown, fieldPath: string): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new ValidationError(
      "nonportable_value",
      `The value ${fieldPath === "" ? "at the root" : `at ${fieldPath}`} holds one value that JSON cannot preserve: ${error instanceof Error ? error.message : String(error)}. Pass one JSON value.`,
      fieldPath,
    );
  }
}

/** Reads the detail level of one render call. */
function detailOf(options: RenderOptions | undefined): RenderDetail {
  const detail = options?.detail ?? "summary";
  if (detail !== "summary" && detail !== "detail") {
    throw new ValidationError(
      "invalid_field_type",
      "The detail level must be summary or detail.",
      "/detail",
    );
  }
  return detail;
}

/** Returns true when the value is one plain JSON object. */
function isRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Formats one number for display, trimmed of floating-point noise. */
function num(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

/** Joins two sentence parts, keeping the space out of an empty part. */
function join(left: string, right: string): string {
  return left === "" ? right : `${left} ${right}`;
}

/** Formats one usage record as one display list. */
function usageText(usage: Readonly<Record<string, number>>): string {
  return Object.entries(usage)
    .map(([name, value]) => `${name} ${num(value)}`)
    .join(" · ");
}

/** Folds component outcomes with the fixed order of the contracts. */
function fold(outcomes: readonly CheckOutcome[]): AggregateOutcome {
  if (outcomes.includes("fail")) {
    return "fail";
  }
  if (outcomes.includes("error")) {
    return "error";
  }
  if (outcomes.some((outcome) => outcome === "review" || outcome === "skipped")) {
    return "review";
  }
  return "pass";
}

// ---------------------------------------------------------------------------
// Check meaning: the answer sets of one check.
// ---------------------------------------------------------------------------

/** The declared answers or levels of one check, in declared order. */
function declaredNamesOf(check: CheckDefinition): readonly string[] {
  if (check.answers !== undefined) {
    return Object.keys(check.answers);
  }
  return (check.scale ?? []).map((level) => Object.keys(level)[0] ?? "");
}

/** The accepted answers or levels of one check, with scale acceptance expanded. */
function acceptSetOf(check: CheckDefinition): readonly string[] {
  const accept = check.accept;
  if (typeof accept === "string") {
    return [accept];
  }
  if (accept !== undefined && "at_least" in accept) {
    // The at_least object names the first acceptable level of the scale.
    const levels = declaredNamesOf(check);
    const start = levels.indexOf(accept.at_least);
    return start === -1 ? [] : levels.slice(start);
  }
  return Array.isArray(accept) ? [...accept] : [];
}

/** The declared review answers or levels of one check. */
function reviewSetOf(check: CheckDefinition): readonly string[] {
  const review = check.review;
  if (review === undefined) {
    return [];
  }
  return typeof review === "string" ? [review] : [...review];
}

/** The authored description of one answer or level of one check. */
function descriptionOf(check: CheckDefinition, name: string): string | undefined {
  const answer = check.answers?.[name];
  if (typeof answer === "string") {
    return answer;
  }
  for (const level of check.scale ?? []) {
    const text = level[name];
    if (typeof text === "string") {
      return text;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The recorded measurements of one check record.
// ---------------------------------------------------------------------------

/** The probability mass on the two decisive answer sets of one check. */
interface Masses {
  readonly acceptable: number;
  readonly unacceptable: number;
}

/**
 * Reads the two decisive masses of one recorded assessment.
 *
 * The sets mirror the Rust policy: the acceptable mass covers the accepted
 * answers or levels, the unacceptable mass covers every declared answer or
 * level that is neither accepted nor review, and one binary value derives
 * exact zero-one masses. The function returns no value when the record
 * states no distribution, because one selected label, level, or position
 * is no mass.
 */
function massesOf(check: CheckDefinition, record: RunCheckRecord): Masses | undefined {
  const assessment = record.assessment;
  if (!isRecord(assessment)) {
    return undefined;
  }
  if (assessment.kind === "binary") {
    const accepted = acceptSetOf(check).includes("yes");
    const value = assessment.value === true;
    const acceptable = accepted === value ? 1 : 0;
    return { acceptable, unacceptable: 1 - acceptable };
  }
  const distribution = assessment.distribution;
  if (!Array.isArray(distribution)) {
    return undefined;
  }
  const accepted = new Set(acceptSetOf(check));
  const review = new Set(reviewSetOf(check));
  let acceptable = 0;
  let unacceptable = 0;
  for (const entry of distribution) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = entry.name;
    const mass = entry.mass;
    if (typeof name !== "string" || typeof mass !== "number") {
      continue;
    }
    if (accepted.has(name)) {
      acceptable += mass;
    } else if (!review.has(name)) {
      unacceptable += mass;
    }
  }
  return { acceptable, unacceptable };
}

/** Reads the selected answer of one recorded assessment, as one declared name. */
function selectedAnswerOf(record: RunCheckRecord): string | undefined {
  const assessment = record.assessment;
  if (!isRecord(assessment)) {
    return undefined;
  }
  if (typeof assessment.label === "string") {
    return assessment.label;
  }
  if (typeof assessment.level === "string") {
    return assessment.level;
  }
  if (typeof assessment.value === "boolean") {
    return assessment.value ? "yes" : "no";
  }
  return undefined;
}

/** Reads the recorded distribution of one check record. */
function distributionOf(
  record: RunCheckRecord,
): readonly { readonly name: string; readonly mass: number }[] | undefined {
  const distribution = record.assessment?.distribution;
  if (!Array.isArray(distribution)) {
    return undefined;
  }
  const entries = distribution.filter(
    (entry): entry is Record<string, JSONValue> =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      typeof entry.mass === "number",
  );
  return entries.map((entry) => ({
    name: entry.name as string,
    mass: entry.mass as number,
  }));
}

/** Reads the evidence references that the evaluator selected. */
function evidenceOf(
  record: RunCheckRecord,
): readonly { readonly input: string; readonly reference: string }[] | undefined {
  const evidence = record.assessment?.evidence;
  if (!Array.isArray(evidence)) {
    return undefined;
  }
  const entries = evidence.filter(
    (entry): entry is Record<string, JSONValue> =>
      isRecord(entry) &&
      typeof entry.input === "string" &&
      typeof entry.reference === "string",
  );
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map((entry) => ({
    input: entry.input as string,
    reference: entry.reference as string,
  }));
}

// ---------------------------------------------------------------------------
// Default explanations, from check criteria and executed policy.
// ---------------------------------------------------------------------------

/** Builds the criteria sentence of one question record from its selected answer. */
function criteriaSentence(check: CheckDefinition, record: RunCheckRecord): string {
  const selected = selectedAnswerOf(record);
  if (selected === undefined) {
    return "";
  }
  const description = descriptionOf(check, selected);
  return description === undefined
    ? `The selected answer is "${selected}".`
    : `The answer "${selected}": ${description}`;
}

/** Builds the default explanation of one exact-rule record. */
function ruleExplanation(record: RunCheckRecord): string {
  const applied = record.applied_rule;
  if (applied === undefined) {
    return "The rule check recorded no executed rule.";
  }
  const parameters = applied.parameters;
  if ("maxLength" in parameters) {
    return record.outcome === "fail"
      ? `The input ${applied.input} holds more than the maxLength bound of ${parameters.maxLength} code points.`
      : `The input ${applied.input} holds at most the maxLength bound of ${parameters.maxLength} code points.`;
  }
  if ("includes" in parameters) {
    return record.outcome === "fail"
      ? `The input ${applied.input} does not contain the required sequence "${parameters.includes}".`
      : `The input ${applied.input} contains the required sequence "${parameters.includes}".`;
  }
  const excluded = "excludes" in parameters ? parameters.excludes : "";
  return record.outcome === "fail"
    ? `The input ${applied.input} holds the excluded sequence "${excluded}".`
    : `The input ${applied.input} holds none of the excluded sequence "${excluded}".`;
}

/**
 * Builds the default explanation of one question record.
 *
 * The explanation states the recorded outcome and the arithmetic that the
 * executed policy performed. It claims one cutoff decision only when the
 * recorded masses support it, so one record outside the decision table
 * renders with the general sentence of its outcome.
 */
function questionExplanation(check: CheckDefinition, record: RunCheckRecord): string {
  const criteria = criteriaSentence(check, record);
  const policy = record.applied_policy;
  const masses = massesOf(check, record);
  const kind = record.assessment?.kind;
  const selected = selectedAnswerOf(record);

  if (record.outcome === "review") {
    if (selected !== undefined && reviewSetOf(check).includes(selected)) {
      return join(criteria, "It is a review answer of this check.");
    }
    if (
      policy?.confidence_floor !== undefined &&
      kind !== "binary" &&
      typeof record.assessment?.confidence !== "number"
    ) {
      return join(
        criteria,
        `The assessment reports no confidence, so the confidence floor ${num(policy.confidence_floor)} cannot be met.`,
      );
    }
    const confidence = record.assessment?.confidence;
    if (
      policy?.confidence_floor !== undefined &&
      kind !== "binary" &&
      typeof confidence === "number" &&
      confidence < policy.confidence_floor
    ) {
      return join(
        criteria,
        `Reported confidence ${num(confidence)} is below the confidence floor ${num(policy.confidence_floor)}.`,
      );
    }
    if (masses !== undefined) {
      return join(
        criteria,
        `Neither cutoff was met: acceptable mass ${num(masses.acceptable)}, unacceptable mass ${num(masses.unacceptable)}.`,
      );
    }
    return join(criteria, "The answer did not support an automatic decision.");
  }
  if (record.outcome === "pass") {
    if (masses !== undefined && policy !== undefined && masses.acceptable >= policy.accept_cutoff) {
      return join(
        criteria,
        `Acceptable mass ${num(masses.acceptable)} meets the accept cutoff ${num(policy.accept_cutoff)}.`,
      );
    }
    return join(criteria, "The check passed under the executed policy.");
  }
  if (masses !== undefined && policy !== undefined && masses.unacceptable >= policy.rejection_cutoff) {
    return join(
      criteria,
      `Unacceptable mass ${num(masses.unacceptable)} meets the rejection cutoff ${num(policy.rejection_cutoff)}.`,
    );
  }
  return join(criteria, "The check failed under the executed policy.");
}

/** Builds the default explanation of one check record from its sanitized reason. */
function operationalExplanation(record: RunCheckRecord): string {
  const reason = record.reason;
  if (reason === undefined) {
    return record.outcome === "error"
      ? "Execution failed, and the record states no reason."
      : "The check was not attempted, and the record states no reason.";
  }
  const at = reason.field_path !== undefined ? ` at ${reason.field_path}` : "";
  const lead = record.outcome === "error" ? "Execution failed" : "The check was not attempted";
  return `${lead}: ${reason.code}${at}. ${reason.message}`;
}

/** Builds the default explanation of one check record. */
function explainCheck(check: CheckDefinition, record: RunCheckRecord): string {
  if (record.outcome === "error" || record.outcome === "skipped") {
    return operationalExplanation(record);
  }
  if (record.applied_rule !== undefined) {
    return ruleExplanation(record);
  }
  return questionExplanation(check, record);
}

/** Names the checks of one outcome group, with the readable check meaning. */
function namedGroup(
  records: readonly RunCheckRecord[],
  nameOf: (record: RunCheckRecord) => string,
): string {
  const list = records.map((record) => `"${nameOf(record)}"`).join(", ");
  return records.length === 1 ? `The check ${list}` : `The checks ${list}`;
}

/**
 * Builds the default explanation of the aggregate outcome.
 *
 * One recorded explanation of the report renders as stored. The generated
 * text names the checks that decided the outcome, because one illustrative
 * performance sentence must never pose as a measured result.
 */
function explainAggregate(
  report: RunReport,
  nameOf: (record: RunCheckRecord) => string,
): string {
  if (report.aggregate.explanation !== undefined) {
    return report.aggregate.explanation;
  }
  const failed = report.checks.filter((record) => record.outcome === "fail");
  const errored = report.checks.filter((record) => record.outcome === "error");
  const reviewed = report.checks.filter((record) => record.outcome === "review");
  const skipped = report.checks.filter((record) => record.outcome === "skipped");
  switch (report.aggregate.outcome) {
    case "fail":
      return `${namedGroup(failed, nameOf)} failed. A pass on another check cannot compensate.`;
    case "error":
      return `${namedGroup(errored, nameOf)} ended in error. The run established no complete judgment.`;
    case "review": {
      const sentences: string[] = [];
      if (reviewed.length > 0) {
        const verb = reviewed.length === 1 ? "needs" : "need";
        sentences.push(`${namedGroup(reviewed, nameOf)} ${verb} review.`);
      }
      if (skipped.length > 0) {
        const verb = skipped.length === 1 ? "was" : "were";
        sentences.push(`${namedGroup(skipped, nameOf)} ${verb} not attempted.`);
      }
      sentences.push("The evidence did not support an automatic decision.");
      return sentences.join(" ");
    }
    default:
      return "Every check passed under the selected profile.";
  }
}

/** Formats the completion line of one report. */
function completionText(report: RunReport): string {
  const label =
    report.completion.status === "completed"
      ? "completed"
      : report.completion.status === "cancelled"
        ? "cancelled"
        : "ended at the deadline";
  return report.completion.completed_at !== undefined
    ? `${label} at ${report.completion.completed_at}`
    : label;
}

// ---------------------------------------------------------------------------
// The report binding check.
// ---------------------------------------------------------------------------

/** One validated pairing of one definition and one report. */
interface ReportBinding {
  /** The validated definition artifact. */
  readonly definition: Definition;
  /** The check artifacts of the definition, by identifier. */
  readonly byId: ReadonlyMap<string, CheckDefinition>;
}

/**
 * Validates the definition, binds it to the report, and checks the stored
 * record list against the contract rules that the renderer relies on.
 */
function bindReport(definition: Definition, report: RunReport): ReportBinding {
  const info = throughCore(() =>
    nativeValidateDefinition(jsonText(definition, "/definition")),
  );
  if (info.definitionHash !== report.definition.content_hash) {
    throw new ValidationError(
      "definition_mismatch",
      `The definition ${JSON.stringify(definition.name)} hashes to ${info.definitionHash}, and the report names ${JSON.stringify(report.definition.content_hash)}. Pass the definition that produced the report.`,
      "/definition/content_hash",
    );
  }
  const byId = new Map(definition.checks.map((check) => [check.id, check]));
  report.checks.forEach((record, index) => {
    if (typeof record.check !== "string" || !byId.has(record.check)) {
      throw new ValidationError(
        "unknown_field",
        `The record at /checks/${index} names the check ${JSON.stringify(record.check)}, which the definition does not hold.`,
        `/checks/${index}/check`,
      );
    }
    if (!OUTCOME_WORDS.has(record.outcome)) {
      throw new ValidationError(
        "invalid_field_type",
        `The outcome at /checks/${index}/outcome must hold one outcome word.`,
        `/checks/${index}/outcome`,
      );
    }
    if (
      (record.outcome === "error" || record.outcome === "skipped") &&
      record.reason === undefined
    ) {
      throw new ValidationError(
        "missing_field",
        `The ${record.outcome} record at /checks/${index} states no reason.`,
        `/checks/${index}/reason`,
      );
    }
  });
  if (report.aggregate.outcome !== fold(report.checks.map((record) => record.outcome))) {
    throw new ValidationError(
      "invalid_field_type",
      "The stored aggregate outcome disagrees with the component outcomes.",
      "/aggregate/outcome",
    );
  }
  return { definition, byId };
}

// ---------------------------------------------------------------------------
// The detail lines of one check record.
// ---------------------------------------------------------------------------

/** Formats the executed rule of one record. */
function ruleText(rule: AppliedRuleRecord): string {
  const parameters = rule.parameters;
  if ("maxLength" in parameters) {
    return `maxLength ${parameters.maxLength} on ${rule.input}`;
  }
  if ("includes" in parameters) {
    return `includes "${parameters.includes}" on ${rule.input}`;
  }
  return `excludes "${parameters.excludes}" on ${rule.input}`;
}

/** Builds the detail lines of one check record, indented for the terminal view. */
function checkDetailLines(check: CheckDefinition, record: RunCheckRecord): string[] {
  const lines: string[] = [];
  const push = (text: string): void => {
    lines.push(`${INDENT}${text}`);
  };
  push(`check: ${check.id} · ${record.kind}`);
  const assessment = record.assessment;
  if (isRecord(assessment)) {
    if (typeof assessment.label === "string") {
      push(`answer: ${assessment.label} (categorical)`);
    } else if (typeof assessment.value === "boolean") {
      push(`answer: ${assessment.value ? "yes" : "no"} (binary)`);
    } else if (typeof assessment.level === "string") {
      const position =
        typeof assessment.position === "number"
          ? ` · position ${num(assessment.position)}`
          : "";
      push(`answer: ${assessment.level} (ordered${position})`);
    }
    const distribution = distributionOf(record);
    if (distribution !== undefined) {
      push(
        `distribution: ${distribution.map((entry) => `${entry.name} ${num(entry.mass)}`).join(" · ")}`,
      );
    }
    if (typeof assessment.confidence === "number") {
      push(`confidence: ${num(assessment.confidence)}`);
    }
    const evidence = evidenceOf(record);
    if (evidence !== undefined) {
      push(
        `evidence: ${evidence.map((entry) => `${entry.input}:${entry.reference}`).join(", ")} (selected by the evaluator)`,
      );
    }
  }
  if (record.applied_rule !== undefined) {
    push(`rule: ${ruleText(record.applied_rule)}`);
  }
  if (record.applied_policy !== undefined) {
    const policy = record.applied_policy;
    const parts = [
      `accept >= ${num(policy.accept_cutoff)}`,
      `reject >= ${num(policy.rejection_cutoff)}`,
      ...(policy.confidence_floor !== undefined
        ? [`confidence floor ${num(policy.confidence_floor)}`]
        : []),
    ];
    push(`policy: ${parts.join(" · ")}`);
  }
  if (record.evaluator !== undefined) {
    const model =
      record.evaluator.model_resolved !== undefined
        ? ` · model ${record.evaluator.model_resolved}`
        : "";
    push(`evaluator: ${record.evaluator.id} · adapter ${record.evaluator.adapter_version}${model}`);
  }
  const counts: string[] = [];
  if (record.attempts !== undefined) {
    counts.push(`attempts ${record.attempts}`);
  }
  if (record.timing?.queued_ms !== undefined) {
    counts.push(`queued ${num(record.timing.queued_ms)} ms`);
  }
  if (record.timing?.execution_ms !== undefined) {
    counts.push(`executed ${num(record.timing.execution_ms)} ms`);
  }
  if (counts.length > 0) {
    push(`counts: ${counts.join(" · ")}`);
  }
  if (record.usage !== undefined) {
    push(`usage: ${usageText(record.usage)}`);
  }
  return lines;
}

/** The identity lines of one report, indented for the terminal view. */
function reportIdentityLines(report: RunReport): string[] {
  const lines = [
    `definition: ${report.definition.name} · content hash ${report.definition.content_hash}`,
    `profile: ${report.profile.id} · content hash ${report.profile.content_hash}`,
    `case: ${report.case.id} · input hash ${report.case.input_hash}`,
  ];
  if (report.case.snapshot !== undefined) {
    lines.push(`snapshot: ${report.case.snapshot}`);
  }
  if (report.baseline !== undefined) {
    lines.push(`baseline: ${report.baseline.outcome} · revision ${report.baseline.revision}`);
  }
  if (report.totals !== undefined) {
    const parts: string[] = [];
    if (report.totals.elapsed_ms !== undefined) {
      parts.push(`elapsed ${num(report.totals.elapsed_ms)} ms`);
    }
    if (report.totals.usage !== undefined) {
      parts.push(`usage ${usageText(report.totals.usage)}`);
    }
    if (parts.length > 0) {
      lines.push(`totals: ${parts.join(" · ")}`);
    }
  }
  return lines.map((line) => `  ${line}`);
}

/**
 * The key lines of one detailed report view.
 *
 * The new-developer test of 25 September 2026 showed that one reader of the
 * report alone cannot decode the policy arithmetic: "acceptable mass" and
 * the zone between the two cutoffs stayed undefined, and the shadow fields
 * carried no explanation. The key states those terms beside the records
 * that use them, so the detailed view explains itself. One line appears
 * only when the report holds the fact that it explains.
 */
function reportKeyLines(binding: ReportBinding, report: RunReport): string[] {
  const lines: string[] = [];
  const hasPolicy = report.checks.some((record) => record.applied_policy !== undefined);
  if (hasPolicy) {
    lines.push(
      "Acceptable mass: the assessed mass on the accepted answers of the check.",
      "Unacceptable mass: the assessed mass on every other declared answer.",
      "The policy passes at acceptable mass at or above the accept cutoff. It fails at unacceptable mass at or above the reject cutoff. Every other assessment reviews.",
      "The selected profile holds the cutoffs and the evaluator binding. The host application stores it.",
    );
  }
  const binary = [...binding.byId.values()].some(
    (check) =>
      check.answers !== undefined &&
      Object.keys(check.answers).every((key) => key === "yes" || key === "no"),
  );
  if (hasPolicy && binary) {
    lines.push("A binary question reports one answer and no distribution.");
  }
  if (report.mode === "shadow") {
    lines.push(
      "Shadow mode records this assessment beside the decision of the host application. It changes no application action.",
    );
  }
  if (report.baseline !== undefined) {
    lines.push(
      "The baseline states the decision that the host application made itself, with the revision of its own policy.",
    );
  }
  return lines;
}

/** The limitation lines of one report view. */
const REPORT_LIMITATIONS = [
  "Explanations are generated from the check criteria and the executed policy. No evaluator rationale exists.",
  "Evidence references were selected by the evaluator. An absent reference means the evaluator returned none.",
  "A content hash identifies content, not a replay of stochastic behavior.",
  "A report authorizes no application action.",
];

// ---------------------------------------------------------------------------
// Terminal report rendering.
// ---------------------------------------------------------------------------

/** Renders one run report as terminal text. */
function renderReportTerminal(
  binding: ReportBinding,
  report: RunReport,
  detail: RenderDetail,
): string {
  const nameOf = (record: RunCheckRecord): string =>
    binding.byId.get(record.check)?.name ?? record.check;
  const lines: string[] = [
    `${binding.definition.name} · run ${report.run_id} · ${report.mode} mode`,
    "",
  ];
  for (const record of report.checks) {
    const check = binding.byId.get(record.check);
    if (check === undefined) {
      continue;
    }
    lines.push(`${record.outcome.toUpperCase().padEnd(LABEL_WIDTH)}${check.name}`);
    if (detail === "detail" || record.outcome !== "pass") {
      lines.push(`${INDENT}${explainCheck(check, record)}`);
    }
    if (detail === "detail") {
      lines.push(...checkDetailLines(check, record));
    }
  }
  lines.push(
    "",
    `Overall: ${report.aggregate.outcome.toUpperCase()}`,
    explainAggregate(report, nameOf),
    `Completion: ${completionText(report)}`,
    `Next: ${NEXT_ACTION[report.aggregate.outcome]}`,
    "A report authorizes no application action.",
  );
  if (detail === "detail") {
    lines.push("", "Details", ...reportIdentityLines(report));
    const key = reportKeyLines(binding, report);
    if (key.length > 0) {
      lines.push("", "Key", ...key.map((line) => `  ${line}`));
    }
    lines.push("", "Limitations", ...REPORT_LIMITATIONS.map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown report rendering.
// ---------------------------------------------------------------------------

/** Builds the detail bullets of one check record for the Markdown view. */
function checkDetailBullets(check: CheckDefinition, record: RunCheckRecord): string[] {
  return checkDetailLines(check, record).map((line) =>
    line === "" ? line : `  - ${line.slice(INDENT.length)}`,
  );
}

/** Renders one run report as Markdown. */
function renderReportMarkdown(
  binding: ReportBinding,
  report: RunReport,
  detail: RenderDetail,
): string {
  const nameOf = (record: RunCheckRecord): string =>
    binding.byId.get(record.check)?.name ?? record.check;
  const blocks: string[] = [
    `# ${binding.definition.name}`,
    `Run \`${report.run_id}\` · mode \`${report.mode}\``,
  ];
  const items: string[] = [];
  for (const record of report.checks) {
    const check = binding.byId.get(record.check);
    if (check === undefined) {
      continue;
    }
    let item = `- **${record.outcome.toUpperCase()}** ${check.name}`;
    if (detail === "detail" || record.outcome !== "pass") {
      item = `${item} — ${explainCheck(check, record)}`;
    }
    items.push(item);
    if (detail === "detail") {
      items.push(...checkDetailBullets(check, record));
    }
  }
  blocks.push(items.join("\n"));
  blocks.push(
    `**Overall: ${report.aggregate.outcome.toUpperCase()}** — ${explainAggregate(report, nameOf)}`,
    `**Completion:** ${completionText(report)}`,
    `**Next:** ${NEXT_ACTION[report.aggregate.outcome]}`,
    "A report authorizes no application action.",
  );
  if (detail === "detail") {
    const identity = reportIdentityLines(report).map((line) => `- ${line.slice(2)}`);
    blocks.push("## Details", identity.join("\n"));
    const key = reportKeyLines(binding, report);
    if (key.length > 0) {
      blocks.push("## Key", key.map((line) => `- ${line}`).join("\n"));
    }
    blocks.push("## Limitations", REPORT_LIMITATIONS.map((line) => `- ${line}`).join("\n"));
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public report renderers.
// ---------------------------------------------------------------------------

/**
 * Renders one run report as terminal text.
 *
 * The summary view leads with the check meaning, the component outcomes,
 * the aggregate outcome with its explanation, the completion status, and
 * the next useful action. The detail view adds the executed rule, the
 * measurements, the evaluator versions, the counts, the evidence
 * references, the identities, and the limitations of every record. The
 * returned text ends with no newline.
 *
 * @throws {ValidationError} when the detail level is invalid, when the
 * definition fails the core validation or names another content hash than
 * the report, when one record names no check of the definition or breaks
 * one contract rule the view relies on, or when the stored aggregate
 * outcome disagrees with the component outcomes.
 */
export function renderRunReport(
  definition: Definition,
  report: RunReport,
  options?: RenderOptions,
): string {
  const detail = detailOf(options);
  const binding = bindReport(definition, report);
  return renderReportTerminal(binding, report, detail);
}

/**
 * Renders one run report as Markdown.
 *
 * The view states the same content as {@link renderRunReport} in Markdown
 * form: one heading with the definition name, one bullet per check with
 * the outcome and the default explanation, the aggregate outcome, the
 * completion status, the next useful action, and, in the detail view, the
 * details and the limitations of the record.
 *
 * @throws {ValidationError} under the same conditions as
 * {@link renderRunReport}.
 */
export function renderRunReportMarkdown(
  definition: Definition,
  report: RunReport,
  options?: RenderOptions,
): string {
  const detail = detailOf(options);
  const binding = bindReport(definition, report);
  return renderReportMarkdown(binding, report, detail);
}

// ---------------------------------------------------------------------------
// Profile rendering.
// ---------------------------------------------------------------------------

/**
 * Verifies one profile artifact through the core.
 *
 * The stored self-hash crosses first, so one edited copy fails with
 * `hash_mismatch`, then the complete profile contract, so one artifact
 * that breaks one rule fails with its own field path. The comparison
 * authenticates nothing: one forged dataset that states
 * `validated_for_scope` renders as recorded, and the host review owns
 * that trust.
 */
function bindProfile(profile: Profile): Profile {
  const text = jsonText(profile, "/profile");
  throughCore(() => nativeVerifySelfHash("profile", text));
  throughCore(() => nativeValidateProfile(text));
  return profile;
}

/** The summary lines of one profile, indented for the terminal view. */
function profileSummaryLines(profile: Profile): string[] {
  const lines = [
    `Intended use: ${profile.intended_use}`,
    `Readiness: ${READINESS[profile.qualification.status]} (${profile.qualification.status})`,
  ];
  if (profile.qualification.scope !== undefined) {
    lines.push(`Scope: ${profile.qualification.scope}`);
  }
  const reasons = profile.qualification.reasons.join(", ");
  lines.push(`Reasons: ${reasons === "" ? "(none recorded)" : reasons}`);
  lines.push(`Definition: ${profile.definition.name} (${profile.definition.content_hash.slice(0, 8)})`);
  return lines;
}

/** The binding lines of one profile, indented for the terminal view. */
function bindingLines(profile: Profile): string[] {
  if (profile.bindings.length === 0) {
    return ["  none (exact rules only)"];
  }
  return profile.bindings.map((binding) => {
    const model =
      binding.model === undefined
        ? ""
        : binding.model.resolved !== undefined
          ? ` · model ${binding.model.requested} (resolved ${binding.model.resolved})`
          : ` · model ${binding.model.requested}`;
    const preprocessing =
      binding.preprocessing !== undefined ? ` · preprocessing ${binding.preprocessing}` : "";
    return `  ${binding.check}: evaluator ${binding.evaluator} · adapter ${binding.adapter_version} · translation ${binding.translation.content_hash.slice(0, 8)}${model}${preprocessing}`;
  });
}

/** The policy lines of one profile, indented for the terminal view. */
function policyLines(profile: Profile): string[] {
  const lines = [`  family: ${profile.policy.family}`];
  for (const entry of profile.policy.checks ?? []) {
    const parts = [
      `accept >= ${num(entry.accept_cutoff)}`,
      `reject >= ${num(entry.rejection_cutoff)}`,
      ...(entry.confidence_floor !== undefined
        ? [`confidence floor ${num(entry.confidence_floor)}`]
        : []),
    ];
    lines.push(`  ${entry.check}: ${parts.join(" · ")}`);
  }
  return lines;
}

/** The execution lines of one profile, indented for the terminal view. */
function executionLines(profile: Profile): string[] {
  const execution = profile.execution;
  return [
    `  ${execution.max_active} active · ${execution.max_pending} pending · ${execution.deadline_ms} ms deadline · ${execution.max_attempts} attempts · ${execution.backoff_ms} ms backoff`,
  ];
}

/** The evidence lines of one profile, indented for the terminal view. */
function evidenceLines(profile: Profile): string[] | undefined {
  const evidence = profile.evidence;
  if (evidence === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  if (evidence.plan !== undefined) {
    lines.push(`  plan: ${evidence.plan.id} (${evidence.plan.content_hash.slice(0, 8)})`);
  }
  if (evidence.datasets !== undefined) {
    lines.push(
      `  datasets: ${evidence.datasets
        .map((dataset) => `${dataset.id} (revision ${dataset.revision}, ${dataset.content_hash.slice(0, 8)})`)
        .join(", ")}`,
    );
  }
  if (evidence.splits !== undefined) {
    lines.push(
      `  splits: ${evidence.splits
        .map((split) => `${split.id} (${split.content_hash.slice(0, 8)})`)
        .join(", ")}`,
    );
  }
  if (evidence.label_provenance !== undefined) {
    lines.push(`  label provenance: ${evidence.label_provenance}`);
  }
  if (evidence.evaluation_reports !== undefined && evidence.evaluation_reports.length > 0) {
    lines.push(`  evaluation reports: ${evidence.evaluation_reports.join(", ")}`);
  }
  if (evidence.statistical_method !== undefined) {
    lines.push(`  statistical method: ${evidence.statistical_method}`);
  }
  return lines.length === 0 ? undefined : lines;
}

/** The performance lines of one profile, indented for the terminal view. */
function performanceLines(profile: Profile): string[] | undefined {
  const performance = profile.performance;
  if (performance === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  for (const metric of performance.metrics ?? []) {
    const value = metric.value === null ? "unavailable" : num(metric.value);
    lines.push(`  ${metric.metric} (${metric.scope}): ${metric.numerator} of ${metric.denominator} = ${value}`);
  }
  for (const interval of performance.intervals ?? []) {
    lines.push(
      `  ${interval.metric} (${interval.scope}): ${num(interval.lower)} to ${num(interval.upper)} · ${interval.method} · confidence ${num(interval.confidence_level)}`,
    );
  }
  const counts = Object.entries(performance.sample_counts ?? {});
  if (counts.length > 0) {
    lines.push(`  sample counts: ${counts.map(([name, value]) => `${name} ${value}`).join(" · ")}`);
  }
  const minimums = Object.entries(performance.sample_minimums ?? {});
  if (minimums.length > 0) {
    lines.push(
      `  sample minimums: ${minimums.map(([name, value]) => `${name} ${value}`).join(" · ")}`,
    );
  }
  for (const limitation of performance.slice_limitations ?? []) {
    lines.push(`  slice limitation: ${limitation}`);
  }
  return lines.length === 0 ? undefined : lines;
}

/** The identity lines of one profile, indented for the terminal view. */
function profileIdentityLines(profile: Profile): string[] {
  return [
    `  profile id: ${profile.id}`,
    `  content hash: ${profile.content_hash}`,
    `  definition: ${profile.definition.name} (${profile.definition.content_hash})`,
  ];
}

/** The limitation lines of one profile view. */
function profileLimitations(profile: Profile): string[] {
  const lines = [
    "The qualification status is recorded evidence, not one authenticated approval. The host reviews and selects one profile hash.",
  ];
  if (profile.performance !== undefined) {
    lines.push(
      "Performance values cite their counts and their denominators. A zero denominator states one unavailable value.",
      "No performance number extends past its recorded scope.",
    );
  }
  if (profile.evidence?.evaluation_reports !== undefined) {
    lines.push(
      "The evaluation reports live in host storage at the recorded references. One folder that version control ignores holds no required copy of the qualification evidence.",
    );
  }
  if (profile.origin === "exact") {
    lines.push("The exact basis is structural. It states no quality claim about the requirement.");
  }
  return lines;
}

/** Renders one profile as terminal text. */
function renderProfileTerminal(profile: Profile, detail: RenderDetail): string {
  const lines: string[] = [
    `Profile ${profile.id} (${profile.origin})`,
    "",
    ...profileSummaryLines(profile),
  ];
  if (detail === "detail") {
    lines.push(
      "",
      "Bindings",
      ...bindingLines(profile),
      "Policy",
      ...policyLines(profile),
      "Execution",
      ...executionLines(profile),
    );
    const evidence = evidenceLines(profile);
    if (evidence !== undefined) {
      lines.push("Evidence", ...evidence);
    }
    const performance = performanceLines(profile);
    if (performance !== undefined) {
      lines.push("Performance", ...performance);
    }
    lines.push("Identity", ...profileIdentityLines(profile));
    lines.push(
      "",
      "Limitations",
      ...profileLimitations(profile).map((line) => `  ${line}`),
    );
  }
  return lines.join("\n");
}

/** Renders one profile as Markdown. */
function renderProfileMarkdown(profile: Profile, detail: RenderDetail): string {
  const blocks: string[] = [
    `# Profile ${profile.id} (${profile.origin})`,
    profileSummaryLines(profile)
      .map((line) => `- **${line.slice(0, line.indexOf(":"))}:**${line.slice(line.indexOf(":") + 1)}`)
      .join("\n"),
  ];
  if (detail === "detail") {
    blocks.push(
      "## Bindings",
      bindingLines(profile).map((line) => `- ${line.slice(2)}`).join("\n"),
      "## Policy",
      policyLines(profile).map((line) => `- ${line.slice(2)}`).join("\n"),
      "## Execution",
      executionLines(profile).map((line) => `- ${line.slice(2)}`).join("\n"),
    );
    const evidence = evidenceLines(profile);
    if (evidence !== undefined) {
      blocks.push("## Evidence", evidence.map((line) => `- ${line.slice(2)}`).join("\n"));
    }
    const performance = performanceLines(profile);
    if (performance !== undefined) {
      blocks.push("## Performance", performance.map((line) => `- ${line.slice(2)}`).join("\n"));
    }
    blocks.push(
      "## Identity",
      profileIdentityLines(profile).map((line) => `- ${line.slice(2)}`).join("\n"),
      "## Limitations",
      profileLimitations(profile).map((line) => `- ${line}`).join("\n"),
    );
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public profile renderers.
// ---------------------------------------------------------------------------

/**
 * Renders one profile artifact as terminal text.
 *
 * The summary view states the intended use, the readiness with its
 * qualification status and its stable reasons, the scope, and the bound
 * definition. The detail view adds the evaluator bindings with their
 * adapter versions, the policy parameters, the effective execution
 * configuration, the qualification evidence with its datasets and its
 * label provenance, the recorded performance with its counts and its
 * limitations, the identities, and the limitations of the view. The
 * returned text ends with no newline.
 *
 * @throws {ValidationError} when the detail level is invalid, when the
 * stored self-hash of the artifact fails, or when the artifact breaks the
 * profile contract.
 */
export function renderProfileSummary(profile: Profile, options?: RenderOptions): string {
  const detail = detailOf(options);
  const bound = bindProfile(profile);
  return renderProfileTerminal(bound, detail);
}

/**
 * Renders one profile artifact as Markdown.
 *
 * The view states the same content as {@link renderProfileSummary} in
 * Markdown form.
 *
 * @throws {ValidationError} under the same conditions as
 * {@link renderProfileSummary}.
 */
export function renderProfileSummaryMarkdown(profile: Profile, options?: RenderOptions): string {
  const detail = detailOf(options);
  const bound = bindProfile(profile);
  return renderProfileMarkdown(bound, detail);
}
