# Canonical hashing and string semantics (v0)

Status: Frozen for v0 on 23 September 2026.

This contract defines the canonical form, the content hashes, and the exact
string semantics of measuretwice. One Rust procedure implements all of it.
Every wrapper delegates to that procedure. The machine-checkable companion for
conformance fixtures is [hashing.schema.json](hashing.schema.json). The parent
contract is the [contracts README](../README.md).

## Purpose and scope

Content hashes identify artifacts. Exact string rules assess inputs. Both need
one answer per question, given once, in Rust:

- What text is hashed, byte for byte.
- How a string is measured and matched.
- Which changes make a new identity.

The Rust core is the only implementation. The TypeScript SDK, the Python SDK,
and the CLI call the core. They never compute a hash or a length on their own.
JSON formatting does not establish a content hash.

This contract governs every `content_hash`, `input_hash`, and `translation_hash`
field in the artifact schemas. It also governs the `maxLength`, `includes`, and
`excludes` rules of a check definition.

## Canonical form

The canonical form of a value is a serialization of the parsed value, never of
the input spelling. Two files with the same value and different formatting
produce the same canonical form.

The canonical form follows JSON Canonicalization Scheme (JCS), RFC 8785,
with the rules restated here. Where this document is stricter, this document
governs.

1. The output is UTF-8 text with no whitespace between tokens.
2. Objects serialize each member once, in sorted key order.
3. Strings serialize with the two-character escapes `\"`, `\\`, `\b`, `\t`,
   `\n`, `\f`, and `\r`. Every other control character below U+0020
   serializes as `\u00xx`. Every other character serializes literally.
4. Numbers serialize by the ECMAScript `Number::toString` algorithm, as
   RFC 8785 section 3.2.2.6 specifies.
5. Arrays serialize in their order. Array order is never sorted away.
6. Literals are `null`, `true`, and `false`.

### Numbers

- Every number is a finite IEEE 754 binary64 value. A value that is not
  finite is rejected with reason code `invalid_field_type` before
  canonicalization. This repeats the limit in the
  [input schema subset](input-schema.md).
- A number with a zero fractional part and a magnitude below 2^53 serializes
  as a plain integer. For example, parsed `1.0` and parsed `1` both
  canonicalize as `1`.
- Negative zero canonicalizes as `0`. The sign of zero never reaches a hash.
- Large and small magnitudes use exponent notation, for example `1e+21` and
  `1e-7`. RFC 8785 fixes the exact format.

| Parsed value | Canonical text |
| --- | --- |
| `0` | `0` |
| `-0` | `0` |
| `1.0` | `1` |
| `0.5` | `0.5` |
| `900` | `900` |
| `1e21` | `1e+21` |
| `1e-7` | `1e-7` |

### Strings and Unicode

- Input text must be valid UTF-8. Ill-formed byte sequences are rejected with
  reason code `invalid_json`.
- No Unicode normalization is applied. Not NFC, not NFD, not any other form.
  Two strings that normalize to the same text but hold different code points
  are different content and hash differently. Normalization can change meaning
  silently, and its rules change between Unicode versions. Preservation is
  deterministic.
- A string holding an unpaired surrogate code point is rejected with reason
  code `nonportable_value`. Canonical UTF-8 text cannot carry it.

### Objects and keys

- Keys sort by UTF-16 code unit order, the RFC 8785 rule. For the ASCII
  identifiers of these contracts, this equals byte order.
- A parsed object with a duplicate key is rejected with reason code
  `invalid_json`. Otherwise two readers could keep different members and
  compute different hashes.
- An omitted optional field stays absent. Canonicalization inserts no value.
- One documented exception exists: an omitted `when_uncertain` in a definition
  canonicalizes as `"review"`. A definition that omits the field and a
  definition that states `when_uncertain: "review"` produce one canonical
  form and one hash. This is the only default in the contracts, as the
  [contracts README](../README.md) records. Every other omitted field means
  "absent", and absence stays absence in the canonical form.

### Arrays

- Every array serializes in its order. The scale order and the candidate-grid
  order carry meaning, and the canonical form preserves them.
- Set-like arrays, such as `using`, `accept`, `review`, `required`, and
  `tags`, have no meaningful order, but the canonical form still uses the
  written order. A reordered list therefore hashes differently. This is a
  deliberate strictness. One uniform rule is safer to implement and to
  verify than per-field rules. Authors keep a stable order, and the shared
  fixtures pin it.

## Content hashes

A content hash is SHA-256 over the domain tag, one zero byte, and the
canonical form:

```text
digest = SHA-256( tag_utf8 || 0x00 || canonical_utf8 )
```

The hash is 64 lowercase hexadecimal characters, as
[common.schema.json](common.schema.json) requires. A raw zero byte cannot
occur inside canonical JSON text, because canonicalization escapes control
characters. The tag is therefore unambiguous. Domains keep artifacts with
equal content from sharing one hash across kinds.

A hash is computed only over validated content. The hash of invalid content
is undefined and never published.

### Hash domains and boundaries

| Domain | Tag | Boundary: the canonical form covers | Recorded in |
| --- | --- | --- | --- |
| Definition | `definition` | The complete validated definition artifact, one JSON value. | `profile.definition`, `plan.definition`, run and evaluation report `definition` |
| Input | `input` | The case `input` object alone. Not the case identifier, tags, labels, or expected outcomes. | Run report `case.input_hash`, evaluation report per-case `input_hash` |
| Translation | `translation` | One complete translated question value for one check, as the adapter contract defines it. For a whole definition, the array of translated question values ordered by check identifier. | Profile `bindings[].translation.content_hash`, `plan.evaluator.translation_hash` |
| Profile | `profile` | The complete profile artifact with its own `content_hash` field removed. | `profile.content_hash` |
| Plan | `plan` | The complete calibration plan with its own `content_hash` field removed. | `plan.content_hash`, profile `evidence.plan.content_hash` |
| Dataset | `dataset` | The complete validated case records as one array, ordered by case identifier. Not the metadata file. | `dataset.content_hash`, profile `evidence.datasets[].content_hash` |
| Split | `split` | The complete records of one split as one array, ordered by case identifier. | `dataset.splits[].content_hash`, plan `datasets.*.content_hash`, profile `evidence.splits[].content_hash` |

Boundary rules:

- The input hash covers the complete input object, including inputs that no
  check reads. A change to any declared input makes a changed case. A case
  identifier is not part of the input hash. Comparisons match on the
  identifier and the input hash together.
- Ordering a record array by case identifier uses the same UTF-16 code unit
  order as object keys. Reordering the JSONL file does not change the dataset
  hash. The loader rejects duplicate identifiers, so the order is total.
- The dataset hash covers records only. A metadata change, such as a new
  sampling description, requires a new revision string. A profile references
  a dataset by identifier, revision, and content hash together.
- A plan must record the same split hashes as the dataset metadata declares.
  A mismatch is a compatibility failure before execution.
- A profile binding must record the per-check translation hash of the
  translated question it carries.
- Reports and comparisons carry references, but they hold no content hash of
  their own in v0. Host storage locates them.

### Self-hash computation and verification

A profile and a plan hash themselves.

1. The generator validates every other field of the artifact.
2. The `content_hash` field is absent during hashing. It is absent, never
   `null` and never an empty string.
3. Rust canonicalizes the artifact without the field and computes the digest
   in the artifact's own domain.
4. The generator inserts the `content_hash` field. Key sorting makes the
   insertion position irrelevant.

A reader verifies a self-hash by removing the field, canonicalizing, computing
the digest, and comparing. A stored value that differs from the computed
digest fails validation with reason code `hash_mismatch`. The artifact is an
edited or corrupted copy. Its qualification claims carry no weight until the
host reviews the artifact against its source.

## Exact string semantics

One string input feeds each rule. The definition contract already requires
exactly one string input per rule check.

### Length counting

The length of a string is its number of Unicode code points. Not UTF-8 bytes.
Not UTF-16 code units. Not grapheme clusters.

- An astral-plane character, such as an emoji, counts once. JavaScript
  `String.length` counts two for the same character. A wrapper must not use
  `String.length`.
- A combining mark counts as its own code point. A base character plus a
  combining accent has length two. No normalization merges them.
- The null character U+0000 counts. A wrapper must not treat it as a string
  terminator.
- The empty string has length zero.

| Input (JSON text) | Length | Note |
| --- | --- | --- |
| `""` | 0 | Empty string. |
| `"export worker"` | 13 | Plain ASCII. |
| `"caf\u00e9"` | 4 | Precomposed accent is one code point. Shown as an escape, because the next row shows the same visible text. |
| `"cafe\u0301"` | 5 | Combining accent adds one code point. |
| `"caf\u00e9!"` | 5 | Mixed. |
| `"😀"` | 1 | Emoji is one code point. UTF-16 would count two. |
| `"a😀b"` | 3 | Mixing planes changes nothing. |
| `"a\u0000b"` | 3 | The null character counts. |

### `maxLength`

The parameter is a nonnegative integer. The check passes when the length of
the input is at most the parameter. It fails otherwise.

- `maxLength: 0` passes only for the empty string.
- The parameter bound in the definition has no fixed ceiling. A value above
  the safe integer range 2^53 minus 1 is rejected with reason code
  `invalid_field_type`.

### `includes` and `excludes`

The parameter is one nonempty string. The empty string is not a valid
parameter. The schema rejects it, and Rust rejects it with reason code
`invalid_field_type`, so no run ever evaluates it.

Matching is containment of a code point sequence. The check `includes` passes
when the parameter occurs inside the input as a contiguous sequence of code
points, and fails otherwise. The check `excludes` passes when the parameter
does not occur, and fails when it does.

- Matching is case-sensitive. The parameter `Error` does not match `error`.
- No normalization applies. The parameter `"caf\u00e9"` does not match
  `"cafe\u0301"`, because the code points differ.
- Matching is raw sequence containment. It respects no word boundaries,
  no punctuation, and no regular expression. An embedded instruction inside
  case content matches like any other text and never changes rule behavior.
- An empty input fails every `includes` and passes every `excludes`.
- An unpaired surrogate cannot occur in either side. Validation rejects it
  first.

### Rule outcomes

An exact rule produces `pass` or `fail`. It expresses no uncertainty, so it
never produces `review` on its own. It produces `error` or `skipped` only
through the operational limits of a run, such as a deadline, a queue limit,
or cancellation. An exact rule needs no evaluator, no confidence value, and
no calibration evidence.

## Nonportable values

Canonicalization accepts the JSON data model only: strings, finite numbers,
booleans, null, arrays, and objects. Authoring in TypeScript can produce
values outside that model. They are rejected before serialization with
reason code `nonportable_value` and a field path:

- Functions, classes, and closures.
- `RegExp`, `Date`, `Map`, `Set`, and other built-in objects.
- `bigint` values.
- `undefined`, as a property value or as an array element. JSON cannot
  preserve the difference between an absent property and a property with the
  value `undefined`. Dropping it silently would hide an author error.
- `NaN` and `Infinity`.
- Strings holding an unpaired surrogate.
- Symbols, with one documented exception. The TypeBox markers held in symbol
  properties are authoring metadata, and the documented conversion removes
  them. See the [input schema subset](input-schema.md). Every other symbol
  is rejected.

Negative zero is not on this list. It canonicalizes as `0`, because the JSON
number model keeps no sign for zero.

The rejection happens at two gates. Authoring rejects in-memory values before
serialization. Rust rejects values that arrive only in parsed text, such as a
lone surrogate escape. Nothing is dropped silently. A dropped constraint
would let a check pass without its stated requirement.

## Identity

A change that alters the canonical form alters the identity of the artifact.

| Change | Hash effect | Qualification effect |
| --- | --- | --- |
| Formatting, key order, indentation, number spelling | None. One canonical form. | None. |
| Omitting versus stating `when_uncertain` | None. One canonical form. | None. |
| Question wording, answers, accept or review sets | New definition hash. | Invalid. Bind a new profile. |
| Scale order | New definition hash. Order is meaning. | Invalid. |
| Input schema, declared inputs, `using` lists | New definition hash. | Invalid. |
| Rule parameters | New definition hash. | Invalid. |
| Order of a set-like array | New hash, by the uniform rule. | Invalid. Deliberate strictness. |
| Case input content | New input hash. | Comparisons treat the case as changed. Stored assessments are not reusable. |
| Case identifier | No input hash change. | A new identifier is a new case. |
| Dataset records or labels | New dataset hash and new split hashes. | Update the revision and the evidence references. |
| Dataset metadata text | No hash change. | Record a new revision. |
| Translated question content | New translation hash. | The binding changes. Requalify. |
| Any profile content | New profile self-hash. | The host selects the new hash explicitly. |
| A model alias resolving to a new version | No content hash change. | Runtime check `model_resolution_changed` catches it. Qualification invalid. |

### Why a hash does not establish stochastic replay

A content hash is computed over content at rest. Execution adds state that no
content hash sees: sampled decoding, the resolved model version, provider
infrastructure, retry timing, and adapter code. Two runs of one case under one
profile, with equal definition, input, and profile hashes, can return
different assessments.

Equal hashes license bookkeeping, not reproducibility:

- A comparison may match two measured cases because their identifiers and
  input hashes agree. The measured outcomes can still differ.
- Replaying a run needs the host snapshots and the stored reports, not the
  hash.
- Qualification rests on recorded evaluation evidence, never on hash
  equality.
- Baseline agreement is not correctness, as the
  [contracts README](../README.md) records.

The hash guarantees this much, and only this: two parties that compute the
same hash over validated content hold the same canonical content. That is a
content identity, not a behavioral one.

## Errors and reason codes

| Situation | Reason code |
| --- | --- |
| A number is not finite, or a rule parameter is out of range | `invalid_field_type` |
| Parsed text holds a duplicate object key | `invalid_json` |
| Parsed text is ill-formed UTF-8 | `invalid_json` |
| A string holds an unpaired surrogate | `nonportable_value` |
| Authoring produces a value outside the JSON data model | `nonportable_value` |
| A stored self-hash differs from the computed digest | `hash_mismatch` |

The codes `hash_mismatch` and the other entries follow the stable registry in
the [contracts README](../README.md). This contract adds `hash_mismatch` as
an additive change under the freeze rules.

## Worked examples

Both digests below are reproducible with `sha256sum` over the shown tag and
canonical text. The shared fixtures extend these examples.

An input-domain hash. The case input object:

```json
{"proposed_message": "Hello, EU export!"}
```

Canonical form:

```text
{"proposed_message":"Hello, EU export!"}
```

Digest input: the tag `input`, one zero byte, then the canonical form.

```text
ebf29f3107f775b64d775c4acbe22d2ba495509039f10f93fb7a6b460547b558
```

A definition-domain hash. The definition as authored omits
`when_uncertain`, so the canonical form materializes it. Keys sort at every
level. The canonical form:

```text
{"checks":[{"id":"text-length","name":"The memory fits the length limit","rule":{"maxLength":10},"using":["text"]}],"inputs":{"additionalProperties":false,"properties":{"text":{"minLength":1,"type":"string"}},"required":["text"],"type":"object"},"name":"memory-supported","schema_version":1,"when_uncertain":"review"}
```

Digest input: the tag `definition`, one zero byte, then the canonical form.

```text
2a9b1c7f4537bd4248a7c89ec1aae104b2cc92aad8c285a0b3ae9b9b17d83df6
```

## Conformance fixtures

The shared fixtures use the record shapes in
[hashing.schema.json](hashing.schema.json). Every wrapper runs the same
fixtures through the Rust core. The fixtures cover, at minimum:

- Key order invariance and duplicate key rejection.
- Number boundaries: zero, negative zero, integers, fractions, exponents,
  and rejection of non-finite values.
- Unicode: precomposed against decomposed text, astral-plane characters,
  the null character, and lone surrogates.
- Ordered arrays: scale order and candidate-grid order.
- Every hash domain, with its boundary and its digest.
- Self-hash computation and `hash_mismatch` rejection.
- `maxLength`, `includes`, and `excludes` boundary cases, including empty
  strings and the table above.

TypeBox authoring and equivalent JSON must produce identical canonical
content and identical hashes from these fixtures. The same fixtures are
mandatory for the Python SDK.

## Changes

Follow the change rules in the [contracts README](../README.md).
