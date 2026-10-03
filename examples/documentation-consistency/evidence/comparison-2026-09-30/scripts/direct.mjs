// SPDX-License-Identifier: Apache-2.0
// This independent comparison baseline imports no measuretwice implementation.
import { MODEL, POLICY, QUESTION, requestFor } from "./task.mjs";

function invalid(code = "invalid_assessment") {
  throw Object.assign(new Error("The response does not meet the declared evaluator contract."), { code });
}

export function assessResponse(raw) {
  if (typeof raw?.model !== "string" || !raw.model) invalid();
  if (raw.model !== MODEL) invalid("model_resolution_changed");
  if (![raw.usage?.input_tokens, raw.usage?.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) invalid();
  const answer = raw.answers?.requirement;
  if (answer?.type !== "choice" || !Object.hasOwn(QUESTION.criteria, answer.choice)) invalid();
  const probabilities = answer.probabilities;
  if (!probabilities || Object.keys(probabilities).sort().join() !== Object.keys(QUESTION.criteria).sort().join()) invalid();
  const distribution = Object.keys(QUESTION.criteria).map(name => ({ name, mass: probabilities[name] }));
  if (!distribution.every(({ mass }) => Number.isFinite(mass) && mass >= 0 && mass <= 1)) invalid();
  if (Math.abs(distribution.reduce((sum, entry) => sum + entry.mass, 0) - 1) > 1e-9) invalid();
  const assessment = { kind: "categorical", label: answer.choice, distribution };
  if (answer.confidence !== undefined) {
    if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) invalid();
    assessment.confidence = answer.confidence;
  }
  const outcome = answer.choice === "insufficient" ? "review"
    : probabilities.supported >= POLICY.accept_cutoff ? "pass"
    : probabilities.contradicted >= POLICY.rejection_cutoff ? "fail" : "review";
  return { assessment, outcome, model_resolved: raw.model,
    usage: { input_tokens: raw.usage.input_tokens, output_tokens: raw.usage.output_tokens } };
}

function safeFailure(error) {
  const code = error?.code === "model_resolution_changed" ? "model_resolution_changed"
    : error?.code === "invalid_assessment" ? "invalid_assessment"
    : error?.name === "AbortError" || error?.name === "APITimeoutError" ? "evaluator_timeout"
    : error?.status === 401 ? "evaluator_authentication"
    : error?.status === 403 ? "evaluator_permission"
    : error?.status === 429 ? "evaluator_rate_limit"
    : error?.status >= 400 && error?.status < 500 ? "evaluator_request"
    : error?.status >= 500 || error?.name === "APIConnectionError" ? "evaluator_error" : "evaluator_unknown";
  const remediation = code === "evaluator_authentication" ? "fix_credentials"
    : code === "evaluator_permission" ? "fix_permissions"
    : code === "evaluator_request" ? "fix_request"
    : code === "model_resolution_changed" ? "requalify_binding"
    : ["evaluator_timeout", "evaluator_rate_limit", "evaluator_error"].includes(code) ? "retry_later" : "inspect_evaluator";
  return { code, remediation };
}

export async function runDirect(item, call, { deadlineMs = 30000 } = {}) {
  const request = requestFor(item);
  const started = performance.now();
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error("The attempt deadline passed."), { name: "AbortError" }));
      }, deadlineMs);
    });
    const raw = await Promise.race([Promise.resolve().then(() => call(request, {
      signal: controller.signal, timeout: deadlineMs, retry: { maxRetries: 0 },
    })), deadline]);
    return { case: item.id, ...assessResponse(raw), execution_ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { case: item.id, outcome: "error", reason: safeFailure(error),
      execution_ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}
