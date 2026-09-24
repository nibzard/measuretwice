// SPDX-License-Identifier: Apache-2.0
/**
 * TypeBox authoring for check definitions.
 *
 * `defineChecks` converts one authoring object into the portable definition
 * contract of `contracts/v0/definition.schema.json` and validates the result
 * through the Rust core. The Rust core stays the one validation authority:
 * this module removes only the authoring metadata that
 * `contracts/v0/input-schema.md` documents, and rejects every value that JSON
 * serialization would lose.
 *
 * Side effects: none. `defineChecks` reads its argument, calls the native
 * validator, and returns one frozen, serializable value.
 *
 * Failure behavior: invalid authoring throws one public
 * {@link ValidationError} with a stable reason code and a field path in the
 * portable contract. Authoring field paths use the contract field names. The
 * authoring field `version` reports under `/schema_version`, because the
 * conversion renames it.
 */
import type { Static, TObject } from "typebox";
import { NativeFailure, nativeValidateDefinition } from "./native.js";
import { ValidationError } from "./error.js";

/** One JSON value. The complete data model of the portable artifacts. */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | readonly JSONValue[]
  | { readonly [keyword: string]: JSONValue };

/** One schema of the supported input subset, as plain JSON data. */
export type JsonSchemaNode = { readonly [keyword: string]: JSONValue };

/** One level of an ordered scale. The single key names the level. */
export type ScaleLevel = { readonly [level: string]: string };

/** The exact string rules of the v0 definition contract. */
export type ExactRule =
  | { readonly maxLength: number }
  | { readonly includes: string }
  | { readonly excludes: string };

/** Accepted answers. Remaining answers are unacceptable. */
export type Acceptance = string | readonly string[] | { readonly at_least: string };

/** One check of a validated, serializable definition. Plain JSON data. */
export interface CheckDefinition {
  /** Stable check identifier. Unique inside the definition. */
  readonly id: string;
  /** Readable statement of the requirement. */
  readonly name: string;
  /** Declared inputs that this check may read, by name. */
  readonly using: readonly string[];
  /** Question put to the evaluator. Exactly one of question or rule. */
  readonly question?: string;
  /** Named answers with descriptions. */
  readonly answers?: Readonly<Record<string, string>>;
  /** Ordered levels, from lowest to highest. */
  readonly scale?: readonly ScaleLevel[];
  /** Accepted answers or the first acceptable scale level. */
  readonly accept?: Acceptance;
  /** Answers that produce review. Disjoint from accept. */
  readonly review?: string | readonly string[];
  /** Deterministic rule on exactly one string input. */
  readonly rule?: ExactRule;
}

/** A validated, serializable check definition. Plain JSON data. */
export interface Definition {
  /** The portable contract schema version. The v0 contracts use version 1. */
  readonly schema_version: 1;
  /** Definition name. Keep one name across revisions of one requirement set. */
  readonly name: string;
  /** The only uncertainty behavior in v0. Omitting the field has the same effect. */
  readonly when_uncertain?: "review";
  /** Root input schema of the supported subset. */
  readonly inputs: JsonSchemaNode;
  /** Every check of the definition, in authoring order. */
  readonly checks: readonly CheckDefinition[];
}

/**
 * The result of `defineChecks`.
 *
 * The value is the portable definition itself: `JSON.stringify` produces the
 * contract artifact, with no extra field. `caseInputs` is a phantom type
 * carrier. The implementation never sets it, so serialization skips it. Read
 * the inferred case-input type with {@link CaseInput}.
 */
export interface DefinedChecks<TCaseInput> extends Definition {
  /** Phantom type carrier. Never set. JSON serialization skips it. */
  readonly caseInputs?: TCaseInput;
}

/** Reads the inferred case-input type of one {@link DefinedChecks} value. */
export type CaseInput<T> = T extends DefinedChecks<infer TCaseInput> ? TCaseInput : never;

/** The declared input names of one TypeBox input schema. */
export type InputName<TInputs extends TObject> = Extract<keyof Static<TInputs>, string>;

/** One check as authored, before conversion and validation. */
export interface CheckAuthoring<UsingName extends string = string> {
  /** Stable check identifier. Unique inside the definition. */
  id: string;
  /** Readable statement of the requirement. */
  name: string;
  /** Declared inputs that this check may read. TypeScript rejects unknown names. */
  using: readonly UsingName[];
  /** Question put to the evaluator. Exactly one of question or rule. */
  question?: string;
  /** Named answers with descriptions. */
  answers?: Record<string, string>;
  /** Ordered levels, from lowest to highest. The array order carries meaning. */
  scale?: ScaleLevel[];
  /** Accepted answers or the first acceptable scale level. */
  accept?: Acceptance;
  /** Answers that produce review. Disjoint from accept. */
  review?: string | readonly string[];
  /** Deterministic rule on exactly one string input. */
  rule?: ExactRule;
}

/** The authoring object that `defineChecks` converts and validates. */
export interface ChecksAuthoring<TInputs extends TObject> {
  /** Becomes `schema_version` of the portable definition. */
  version: 1;
  /** Definition name. */
  name: string;
  /** The only uncertainty behavior in v0. */
  when_uncertain?: "review";
  /** One TypeBox object schema. State `additionalProperties: false`. */
  inputs: TInputs;
  /** Every check. A definition with no checks is invalid. */
  checks: ReadonlyArray<CheckAuthoring<InputName<TInputs>>>;
}

/** The TypeBox markers that the pinned TypeBox holds in hidden properties. */
const MARKER_KIND = "~kind";
const MARKER_OPTIONAL = "~optional";
const MARKER_READONLY = "~readonly";
const MARKER_IMMUTABLE = "~immutable";
const MARKER_UNSAFE = "~unsafe";
const MARKER_REFINE = "~refine";
const MARKER_CODEC = "~codec";

/** The annotation keywords that the documented conversion removes. */
const REMOVED_ANNOTATIONS = new Set(["title", "description", "examples"]);

/** Returns true when the value is one plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Returns true when the object holds one own marker property. */
function hasMarker(node: object, marker: string): boolean {
  return Object.prototype.hasOwnProperty.call(node, marker);
}

/** Names the constructor of one nonportable value, when it has one. */
function constructorOf(value: object): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  const name: unknown = (prototype as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof name === "string" && name !== "" ? name : "object";
}

/** Rejects with the reason code for authoring values that JSON cannot keep. */
function nonportable(path: string, what: string): ValidationError {
  return new ValidationError(
    "nonportable_value",
    `The field ${path === "" ? "at the root" : path} holds ${what}. JSON cannot preserve it. Author the field with one JSON value.`,
    path,
  );
}

/**
 * Copies one authored value and rejects every value that JSON serialization
 * would lose or change: functions, symbols, big integers, `undefined`,
 * non-finite numbers, and objects outside the JSON data model, such as
 * regular expressions and class instances.
 */
function portableValue(value: unknown, path: string): JSONValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw nonportable(path, "a number that is not finite");
      }
      return value;
    case "object":
      break;
    default:
      throw nonportable(path, `a value of type ${typeof value}`);
  }
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => portableValue(item, `${path}/${index}`));
  }
  if (!isPlainObject(value)) {
    throw nonportable(path, `one ${constructorOf(value)} value`);
  }
  const copy: Record<string, JSONValue> = {};
  for (const key of Object.keys(value)) {
    copy[key] = portableValue(value[key], `${path}/${key}`);
  }
  return copy;
}

/**
 * Converts one TypeBox schema node into plain JSON Schema data.
 *
 * The conversion removes the TypeBox markers and the annotation keywords
 * `title`, `description`, and `examples`. It removes nothing else. It adds no
 * keyword. Unsupported keywords stay in the copy, so the Rust core rejects
 * them with the same reason code and field path as the equivalent JSON.
 *
 * `inProperty` states whether the node is the schema of one named property.
 * The optional modifier is legal there only; TypeBox has already applied it
 * to the `required` list of the parent object.
 */
function portableSchema(node: unknown, path: string, inProperty: boolean): JSONValue {
  if (!isPlainObject(node)) {
    // A schema that is not one plain object, such as a boolean schema,
    // crosses as it is. The Rust core rejects it with its stable code.
    return portableValue(node, path);
  }
  // Markers never serialize. This wrapper is the only place that can reject
  // the ones that carry executable or unsupported meaning.
  if (hasMarker(node, MARKER_REFINE)) {
    throw new ValidationError(
      "nonportable_value",
      `The schema ${path} carries a Refine check. A custom validator callback cannot serialize. State the constraint with the keywords of the supported input schema subset.`,
      path,
    );
  }
  if (hasMarker(node, MARKER_CODEC)) {
    throw new ValidationError(
      "nonportable_value",
      `The schema ${path} carries a codec transform. A transform callback cannot serialize. Keep transforms in application preprocessing.`,
      path,
    );
  }
  if (hasMarker(node, MARKER_UNSAFE)) {
    throw new ValidationError(
      "unsupported_keyword",
      `The schema ${path} is an Unsafe type. Build the input with the supported TypeBox factories: Object, Array, String, Number, Integer, and Boolean.`,
      path,
    );
  }
  if (hasMarker(node, MARKER_OPTIONAL) && !inProperty) {
    throw new ValidationError(
      "unsupported_keyword",
      `The schema ${path} carries the optional modifier outside one object property. The supported subset states optional properties only.`,
      path,
    );
  }
  const copy: Record<string, JSONValue> = {};
  for (const key of Object.keys(node)) {
    if (key.startsWith("~") || REMOVED_ANNOTATIONS.has(key)) {
      // Markers (~kind, ~readonly, ~immutable) and documented annotations.
      continue;
    }
    const field = (node as Record<string, unknown>)[key];
    if (key === "properties" && isPlainObject(field)) {
      const properties: Record<string, JSONValue> = {};
      for (const name of Object.keys(field)) {
        properties[name] = portableSchema(field[name], `${path}/properties/${name}`, true);
      }
      copy.properties = properties;
      continue;
    }
    if (key === "items") {
      copy.items = portableSchema(field, `${path}/items`, false);
      continue;
    }
    copy[key] = portableValue(field, `${path}/${key}`);
  }
  return copy;
}

/** Reads one required authoring field and reports its contract field path. */
function requiredField(
  authoring: Record<string, unknown>,
  key: string,
  path: string,
  renamed: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(authoring, key)) {
    throw new ValidationError(
      "missing_field",
      `The authoring object omits ${renamed}.`,
      path,
    );
  }
  return authoring[key];
}

/** Freezes one copied JSON value deeply, so the returned definition stays immutable. */
function deepFreeze(value: JSONValue): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    Object.freeze(value);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, JSONValue>)[key]!);
    }
    Object.freeze(value);
  }
}

/**
 * Authors one check definition with a TypeBox input schema.
 *
 * The function converts the authoring object into the portable definition
 * contract, validates the result through the Rust core, and returns the
 * validated definition. The returned value is plain JSON data:
 * `JSON.stringify` produces the contract artifact. The value is frozen.
 *
 * TypeScript infers the case-input type from the TypeBox schema and rejects
 * unknown names in `using` at compile time. The Rust core re-validates both
 * rules at run time.
 *
 * @throws {ValidationError} when the authoring object holds a nonportable
 * value, or when the converted definition breaks one contract invariant.
 */
export function defineChecks<TInputs extends TObject>(
  authoring: ChecksAuthoring<TInputs>,
): DefinedChecks<Static<TInputs>> {
  if (!isPlainObject(authoring)) {
    throw nonportable("", "one value that is not one authoring object");
  }
  const version = portableValue(
    requiredField(authoring, "version", "/schema_version", "the version field, which becomes schema_version"),
    "/schema_version",
  );
  const name = portableValue(requiredField(authoring, "name", "/name", "the name field"), "/name");
  const whenUncertain = Object.prototype.hasOwnProperty.call(authoring, "when_uncertain")
    ? portableValue(authoring["when_uncertain"], "/when_uncertain")
    : undefined;
  const inputs = portableSchema(
    requiredField(authoring, "inputs", "/inputs", "the inputs field"),
    "/inputs",
    false,
  );
  const checks = portableValue(requiredField(authoring, "checks", "/checks", "the checks field"), "/checks");

  const definition: Record<string, JSONValue> = {
    schema_version: version,
    name,
    ...(whenUncertain === undefined ? {} : { when_uncertain: whenUncertain }),
    inputs,
    checks,
  };
  const text = JSON.stringify(definition);
  try {
    nativeValidateDefinition(text);
  } catch (error) {
    if (error instanceof NativeFailure) {
      throw new ValidationError(error.code, error.message, error.fieldPath);
    }
    throw error;
  }
  deepFreeze(definition["inputs"]!);
  deepFreeze(definition["checks"]!);
  Object.freeze(definition);
  // The Rust core validated the artifact, so the record holds the contract
  // shape that the declared return type states.
  return definition as unknown as DefinedChecks<Static<TInputs>>;
}
