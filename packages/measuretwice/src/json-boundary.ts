// SPDX-License-Identifier: Apache-2.0
/**
 * The strict JSON serialization boundary of the wrapper.
 *
 * Every artifact, case, baseline, and assessment that crosses into the Rust
 * core crosses as strict JSON text. `JSON.stringify` alone accepts values it
 * cannot preserve: it drops `undefined`-valued and function-valued fields,
 * drops symbol-keyed properties, converts one `Date` or any object with one
 * `toJSON` operation into another value, turns one non-finite number into
 * `null`, renders one array hole as `null`, and throws on one big integer.
 * A dropped field can even bypass the closed input schema, because the core
 * never sees the key that vanished.
 *
 * `jsonText` walks the value, rejects every such loss with the stable reason
 * code `nonportable_value` and one field path, and emits the strict JSON
 * text itself. The walk mirrors the authoring boundary of
 * `define-checks.ts`, so both crossings state the same contract: one value
 * that JSON cannot preserve refuses before serialization, and no coercion
 * happens silently. The emitter writes object keys directly. A key such
 * as `__proto__` stays visible to the core instead of following the
 * prototype accessor. Big integers are outside the portable JSON contract.
 */
import { ValidationError } from "./error.js";

/** The greatest nesting depth the boundary walks, in parity with fixtures. */
const MAX_DEPTH = 64;

/** Returns true when the value is one plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Names the constructor of one nonportable value, when it has one. */
function constructorOf(value: object): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  const name: unknown = (prototype as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof name === "string" && name !== "" ? name : "object";
}

/** Rejects with the reason code for one value that JSON cannot preserve. */
function nonportable(path: string, what: string): ValidationError {
  return new ValidationError(
    "nonportable_value",
    `The value ${path === "" ? "at the root" : `at ${path}`} holds ${what}. JSON cannot preserve it. Pass one JSON value.`,
    path,
  );
}

/**
 * Walks one value, rejects what JSON serialization would lose, and emits
 * the strict JSON text.
 *
 * The walk accepts `null`, strings, booleans, finite numbers,
 * and walks arrays and plain objects. It rejects `undefined`,
 * functions, symbols, non-finite numbers, symbol-keyed properties, array
 * holes, and objects outside the JSON data model, such as one `Date`, one
 * `Map`, or one class instance. One cycle refuses as one nesting failure,
 * and one value nested past the depth cap refuses instead of exhausting the
 * stack.
 */
function emit(value: unknown, path: string, ancestors: Set<object>, depth: number): string {
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw nonportable(path, "a number that is not finite");
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw nonportable(path, `a value of type ${typeof value}`);
  }
  if (value === null) {
    return "null";
  }
  if (ancestors.has(value) || depth >= MAX_DEPTH) {
    throw nonportable(path, "one value that nests past the depth the boundary walks");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // The index loop reads every slot, so one hole routes its implicit
      // `undefined` through the refusal instead of crossing as `null`.
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(emit(value[index], `${path}/${index}`, ancestors, depth + 1));
      }
      return `[${items.join(",")}]`;
    }
    if (!isPlainObject(value)) {
      throw nonportable(path, `one ${constructorOf(value)} value`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw nonportable(path, "one object with one symbol-keyed property");
    }
    const parts: string[] = [];
    for (const key of Object.keys(value)) {
      // The emitted key states itself, so one key such as `__proto__` stays
      // one named field of the JSON text. The core then refuses it where it
      // is not declared, instead of the boundary dropping it in silence.
      parts.push(`${JSON.stringify(key)}:${emit(value[key], `${path}/${key}`, ancestors, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Serializes one value and rejects what JSON cannot preserve.
 *
 * The walk and the emission are one pass, so one value that
 * `JSON.stringify` would silently drop or coerce refuses with
 * `nonportable_value` and the field path of the offending value.
 */
export function jsonText(value: unknown, fieldPath: string): string {
  return emit(value, fieldPath, new Set(), 0);
}
