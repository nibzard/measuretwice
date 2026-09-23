# Supported input schema subset (v0)

Status: Frozen for v0 on 23 September 2026.

This contract publishes the supported subset of JSON Schema 2020-12 for check
input schemas. JSON is JavaScript Object Notation. The machine-checkable form
of this document is [input-schema.schema.json](input-schema.schema.json). The
parent contract is the [contracts README](../README.md).

## Purpose and scope

The subset governs the `inputs` field of a check definition. It governs the
root schema and every schema inside it. The same rules apply wherever
measuretwice validates input data:

- `defineChecks`, during authoring.
- `load` and `run`, before execution.
- Case records, during dataset loading.

The Rust core is the authority for this subset. The schema file is the first
gate. Rust also enforces the cross-field rules and the limits in this
document.

Select validation dependencies against this subset. A validator that ignores
an unknown keyword does not satisfy this contract.

A schema outside the subset is rejected with a field path. No constraint is
dropped silently.

## Root schema

The root schema describes the complete input object of one case.

1. The root is an object schema. `type` is `object`.
2. `properties` declares one to 64 inputs. Each key follows the input name
   rules in [common.schema.json](common.schema.json).
3. `required` is present. It names every declared input. Every top-level
   input is required.
4. `additionalProperties` is `false`.
5. The root holds no other keyword.

```json
{
  "type": "object",
  "properties": {
    "prior_decision": {"type": "string", "minLength": 1},
    "conversation": {"type": "string", "minLength": 1},
    "proposed_message": {"type": "string", "minLength": 1}
  },
  "required": ["prior_decision", "conversation", "proposed_message"],
  "additionalProperties": false
}
```

## Supported keywords

Every nested schema states its `type`. The `type` value is one string. It is
never an array.

### Strings

| Keyword | Value | Rule |
| --- | --- | --- |
| `type` | `"string"` | Required. |
| `minLength` | Integer from 0 to 250,000 | Optional. |
| `maxLength` | Integer from 0 to 250,000 | Optional. |

The [canonical hashing and string contract](hashing.md) defines how a length
is counted. This document fixes only the range of the bounds.

### Numbers

| Keyword | Value | Rule |
| --- | --- | --- |
| `type` | `"number"` or `"integer"` | Required. |
| `minimum` | Number | Optional. Inclusive lower bound. |
| `maximum` | Number | Optional. Inclusive upper bound. |
| `exclusiveMinimum` | Number | Optional. Exclusive lower bound. |
| `exclusiveMaximum` | Number | Optional. Exclusive upper bound. |

- Every bound is a finite number. A parsed bound that is not finite is
  rejected with `invalid_field_type`.
- For `type: "integer"`, every bound is an integer.
- An `integer` schema accepts a number with a zero fractional part. This
  follows JSON Schema 2020-12.

### Booleans

| Keyword | Value | Rule |
| --- | --- | --- |
| `type` | `"boolean"` | Required. |

The values `true` and `false` are the only booleans. A number never matches a
boolean schema.

### Arrays

| Keyword | Value | Rule |
| --- | --- | --- |
| `type` | `"array"` | Required. |
| `items` | One schema | Required. The schema applies to every element. |
| `minItems` | Integer from 0 to 10,000 | Optional. |
| `maxItems` | Integer from 0 to 10,000 | Optional. |

Tuple validation is not supported. `items` holds one schema, never an array.

### Nested objects

| Keyword | Value | Rule |
| --- | --- | --- |
| `type` | `"object"` | Required. |
| `properties` | Map of one to 64 schemas | Required. |
| `required` | Array of property names | Optional. Names a subset of the declared properties. |
| `additionalProperties` | `false` | Required. Every nested object is closed. |

A nested object declares its own `required` list. A property absent from that
list may stay absent from the data. Nothing creates a default value for it.

### Cross-field rules

JSON Schema cannot compare sibling values. Rust enforces these rules:

- `minLength` is at most `maxLength`, when both are present.
- `minItems` is at most `maxItems`, when both are present.
- The lower numeric bound is at most the upper bound, when both are present.
- Every entry in `required` names a declared property of the same object
  schema.
- The root `required` entries equal the root `properties` keys.

## Unsupported features

The subset is closed. Rust rejects a keyword or a form outside the subset
with reason code `unsupported_keyword` and a field path.

- References and definitions: `$ref`, `$defs`, `$id`, `$anchor`,
  `$dynamicRef`, `$dynamicAnchor`.
- Combinations and conditions: `allOf`, `anyOf`, `oneOf`, `not`, `if`,
  `then`, `else`, `dependentSchemas`, `dependentRequired`.
- Object features: `patternProperties`, `propertyNames`,
  `unevaluatedProperties`, `minProperties`, `maxProperties`.
- Array features: `prefixItems`, the array form of `items`, `contains`,
  `minContains`, `maxContains`, `uniqueItems`, `unevaluatedItems`.
- String features: `pattern`, `format`. A regular expression dialect is not
  portable across the Rust core and every wrapper.
- Number features: `multipleOf`.
- Value sets and constants: `enum`, `const`.
- The `null` type. A null value never validates.
- Boolean schemas. The values `true` and `false` are not schemas here.
- Annotations: `title`, `description`, `examples`, `default`, `readOnly`,
  `writeOnly`, `deprecated`. The authoring conversion removes the first
  three. See the conversion rules below.

## Limits

Rust enforces these limits. Nothing is truncated.

Schema limits:

| Limit | Value |
| --- | --- |
| Nesting depth | 8. The root is depth 0. Each `properties` value and each `items` value adds 1. |
| Properties per object schema | 64 |
| Schemas in one input schema, root included | 1,024 |

Input data limits:

| Limit | Value | Reason code |
| --- | --- | --- |
| One string value | 1,048,576 bytes in UTF-8 encoding | `oversized_input` |
| One array value | 10,000 items | `oversized_input` |
| The complete input object | 4,194,304 bytes in UTF-8 encoding | `oversized_input` |
| One numeric value | A finite value in the IEEE 754 double format | `invalid_field_type` |

The [canonical hashing and string contract](hashing.md) defines the canonical
numeric representation.

## Validation behavior

Four behaviors are disabled everywhere:

1. Coercion. No value changes its type to satisfy a schema.
2. Mutation. Validation never edits the input value or the schema. Validation
   passes or fails.
3. Implicit input defaults. An absent property stays absent.
4. External schema retrieval. The subset has no references. Validation reads
   no file, no registry, and no network resource.

## Errors and field paths

Every validation error carries a reason code and a field path. A field path
is a JSON Pointer as RFC 6901 defines it. Schema errors point into the
definition. Input data errors point into the case record.

| Situation | Reason code |
| --- | --- |
| A keyword or a form outside the subset | `unsupported_keyword` |
| A supported keyword holds a wrong type or an out-of-range value | `invalid_field_type` |
| A required keyword is absent, for example `items` or `additionalProperties` | `missing_field` |
| Sibling values conflict, for example `minLength` above `maxLength` | `invalid_field_type` |
| `required` names a property that the object schema does not declare | `unknown_field` |
| An object schema is not closed with `additionalProperties: false` | `invalid_field_type` |
| An input value breaks a supported constraint | `invalid_field_type` |
| An input value exceeds a published size limit | `oversized_input` |

Examples of field paths:

- `/inputs/properties/prior_decision` points at the schema of one input.
- `/inputs/properties/tags/items` points at the element schema of one array.
- `/input/proposed_message` points at one value inside a case record.

## TypeBox authoring conversion

`defineChecks` accepts a TypeBox object schema. The conversion produces the
portable subset. It removes only these items:

- TypeBox markers that TypeBox holds in symbol properties. JSON serialization
  cannot carry symbols. The markers are not constraints.
- The TypeBox optional modifier. At the root, an optional input is an error,
  because every top-level input is required. In a nested object, the modifier
  removes the property from `required`.
- The annotation keywords `title`, `description`, and `examples`. An
  annotation carries no validation constraint.

The conversion also renames the authoring field `version` to
`schema_version`. The [contracts README](../README.md) records this mapping.

The conversion never adds a keyword and never removes a constraint:

- The author states `additionalProperties: false` on every object schema,
  root or nested. The conversion does not add it.
- An unsupported keyword stays an error.

```ts
Type.Object({
  prior_decision: Type.String({ minLength: 1, description: "The earlier decision text" }),
  tags: Type.Array(Type.String({ maxLength: 40 }), { minItems: 1 }),
}, { additionalProperties: false });
```

The conversion produces:

```json
{
  "type": "object",
  "properties": {
    "prior_decision": {"type": "string", "minLength": 1},
    "tags": {"type": "array", "items": {"type": "string", "maxLength": 40}, "minItems": 1}
  },
  "required": ["prior_decision", "tags"],
  "additionalProperties": false
}
```

The `description` annotation was removed. The `minLength`, `maxLength`, and
`minItems` constraints stay.

A value that JSON cannot preserve is rejected before serialization with
reason code `nonportable_value`. Examples are a function, a class, a regular
expression object, and any other JavaScript value outside the JSON data
model.

## Changes

Follow the change rules in the [contracts README](../README.md).
