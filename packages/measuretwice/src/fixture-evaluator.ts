// SPDX-License-Identifier: Apache-2.0
import type { JSONValue } from "./define-checks.js";
import type { Evaluator, EvaluatorExecution, EvaluatorRequest } from "./evaluator.js";
import { ValidationError } from "./error.js";
import { NativeFailure, nativeCanonicalForm } from "./native.js";

/** A fixed execution for one check and its exact projected inputs. */
export interface EvaluatorFixture {
  readonly check: string;
  readonly inputs: Readonly<Record<string, JSONValue>>;
  readonly answer: EvaluatorExecution;
}

/** Offline fixture configuration. No case identifier or reference label is needed. */
export interface FixtureEvaluatorOptions {
  readonly fixtures: readonly EvaluatorFixture[];
  readonly id?: string;
  readonly adapter_version?: string;
}

/** An offline evaluator with recorded requests. */
export interface FixtureEvaluator extends Evaluator {
  readonly calls: readonly EvaluatorRequest[];
}

/** Copy JSON data without getters, custom serialization, or silent replacements. */
function fixtureJson(value: unknown, path: string): string {
  const ancestors = new Set<object>();
  function copy(item: unknown, depth: number): JSONValue {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || depth > 64 || ancestors.has(item) ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) {
      throw new ValidationError("nonportable_value", "Fixture values must be finite, acyclic JSON data within 64 container levels.", path);
    }
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some(key => typeof key === "symbol") ||
      Object.values(descriptors).some(descriptor => descriptor.get !== undefined || descriptor.set !== undefined)) {
      throw new ValidationError("nonportable_value", "Fixture JSON cannot contain symbols or accessors.", path);
    }
    const result = Array.isArray(item)
      ? Array.from({ length: item.length }, (_, index) => copy(descriptors[String(index)]?.value, depth + 1))
      : Object.fromEntries(Object.entries(descriptors).filter(([, descriptor]) => descriptor.enumerable)
        .map(([key, descriptor]) => [key, copy(descriptor.value, depth + 1)]));
    ancestors.delete(item);
    return result;
  }
  return JSON.stringify(copy(value, 1));
}

/** Match object keys through the same canonical JSON rules as portable artifacts. */
function fixtureKey(check: string, inputs: Readonly<Record<string, JSONValue>>, path: string): string {
  try {
    return nativeCanonicalForm(fixtureJson({ check, inputs }, path));
  } catch (error) {
    if (error instanceof NativeFailure) throw new ValidationError(error.code, error.message, path);
    throw error;
  }
}

/**
 * Create fixed answers that replay regardless of case order or repetition.
 *
 * Snapshots match the check identifier and all projected inputs. No model runs.
 * Answers do not measure semantic quality. Dispatch validates each execution
 * against its check. Use the scripted evaluator for malformed or delayed controls.
 * At most 10,000 entries and 64 JSON container levels are accepted. Missing matches return evaluator_error.
 * Aborted requests return evaluator_timeout. Calls retain raw projected inputs
 * in memory for tests. The evaluator writes no file and makes no network call.
 */
export function createFixtureEvaluator(options: FixtureEvaluatorOptions): FixtureEvaluator {
  if (!Array.isArray(options.fixtures) || options.fixtures.length > 10_000) {
    throw new ValidationError("invalid_field_type", "Supply an array with at most 10,000 fixtures.", "/fixtures");
  }
  const answers = new Map<string, EvaluatorExecution>();
  for (const [index, supplied] of options.fixtures.entries()) {
    const path = `/fixtures/${index}`;
    const fixture = JSON.parse(fixtureJson(supplied, path)) as EvaluatorFixture;
    if (typeof fixture?.check !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixture.check) ||
      fixture.check.length > 64 || fixture.inputs === null || typeof fixture.inputs !== "object" ||
      Array.isArray(fixture.inputs) || fixture.answer === null || typeof fixture.answer !== "object" ||
      Array.isArray(fixture.answer)) {
      throw new ValidationError("invalid_field_type", "Each fixture needs a check identifier, input object, and execution object.", path);
    }
    const key = fixtureKey(fixture.check, fixture.inputs, `${path}/inputs`);
    if (answers.has(key)) {
      throw new ValidationError("invalid_field_type", "Duplicate fixture for the same check and projected inputs. Keep one answer.", path);
    }
    answers.set(key, fixture.answer);
  }
  const calls: EvaluatorRequest[] = [];
  return {
    id: options.id ?? "fixture-test",
    adapter_version: options.adapter_version ?? "0.1.0",
    calls,
    async assess(request) {
      calls.push(request);
      if (request.signal.aborted) {
        return { failure: { code: "evaluator_timeout", message: "The fixture request was aborted before lookup." } };
      }
      const answer = answers.get(fixtureKey(request.check, request.inputs, "/inputs"));
      if (answer === undefined) {
        return { failure: { code: "evaluator_error", message: `No fixture matches check ${request.check} and its projected inputs. Add a fixture or correct the case.` } };
      }
      return structuredClone(answer);
    },
  };
}
