# Shared conformance fixtures (v0)

Status: Frozen for v0 on 23 September 2026.

These fixtures pin the portable contracts in [contracts/v0](../contracts/v0).
They are language-neutral data. Every wrapper runs every group through the Rust
core and compares the results. The [manifest](manifest.json) lists the groups
and the runner rule for each one.

The same fixtures are mandatory for the TypeScript SDK and for the later Python
SDK. MVP_SPEC.md section 15 states this requirement. A wrapper that cannot run
one group through the Rust core is not conformant.

## What the fixtures cover

| Group | Files | Pins |
| --- | --- | --- |
| Valid definitions | [definitions/valid/](definitions/valid) | Each definition shape, each input type, and the `when_uncertain` default. |
| Invalid definitions | [definitions/invalid.json](definitions/invalid.json) | One rejection record per contract invariant, with reason code and field path. |
| Input validation | [inputs/validation.json](inputs/validation.json) | Data validation for each input type, code point length, closed objects, and size limits. |
| Canonical hashing | [hashing/canonical.json](hashing/canonical.json) | Every hash domain, the canonical form, and the digest. Includes the two worked examples from [hashing.md](../contracts/v0/hashing.md). |
| Exact string rules | [hashing/string-rules.json](hashing/string-rules.json) | `maxLength`, `includes`, and `excludes` boundaries, including the table in [hashing.md](../contracts/v0/hashing.md). |
| Hashing rejections | [hashing/invalid.json](hashing/invalid.json) | Text and bytes that no hash may cover. |
| TypeBox pairing | [authoring/typebox-pairs.json](authoring/typebox-pairs.json) | TypeBox sources and equivalent JSON with identical canonical content and hashes. |
| Serialization | [serialization/round-trips.json](serialization/round-trips.json) | Round trips, ordered arrays, order strictness, absence, and rejected executable values. |
| Assessments | [assessments/samples.json](assessments/samples.json) | The assessment contract and `invalid_assessment` rejections. |
| Adapter conformance | [adapters/conformance.json](adapters/conformance.json) | The test-adapter controls, absent optional measurements, the label-only decision rule, evaluator replacement, and independent profile bindings. |
| Outcomes | [reports/outcomes.json](reports/outcomes.json) | The aggregate order, every check outcome, and the completion statuses. |
| Profile states | [profiles/states.json](profiles/states.json) | Every qualification status, self-hash verification, and compatibility failures. |
| Runtime traces | [runtime/traces.json](runtime/traces.json) | Queue limits, deadlines, cancellation, retries, partial failure, and late results. |

## Record shapes

- A valid definition file holds one complete definition artifact. Load it as it
  is. No wrapper field wraps it.
- A rejection record holds `note`, the artifact under `raw` (or `raw_text` and
  `bytes_hex` when JSON cannot hold the data), and `expected` with the stable
  `reason_code` and the `field_path` of the rejected field.
- A hash record follows `hashes` in
[hashing.schema.json](../contracts/v0/hashing.schema.json): `note`, `domain`,
`value`, `canonical`, and `content_hash`.
- A string rule record follows `string_rules` in the same schema: `note`,
  `rule`, `parameter`, `input`, `outcome`, and `length` for `maxLength`.
- A TypeBox pair holds `note`, `definition` (a file name in
  `definitions/valid/`), `typebox` (TypeScript source), `canonical`, and
  `content_hash`. Both sides must produce the recorded canonical form and hash.
- A runtime trace holds `id`, `note`, `definition`, `case_input`, `config`,
  `events`, and `expected`. Events carry `at_ms` on the fake clock that
  [TESTING.md](../TESTING.md) defines. An event listed in `rejected_events`
  must not change the report.
- An adapter conformance case holds `note`, `adapter`, `definition` (a file
  name in `definitions/valid/`), `check`, `case_input`, `control`, and
  `expected`. A control is the string `script-empty` or one object with
  exactly one of `answer`, `raw`, `error`, and `answers`, plus one optional
  `delay_ms`. A case may state `signal: "aborted"`. An expected record holds
  one exact `assessment` or one `failure` with one code and one exact or
  contained message, plus the observed `delays_ms`.

## Digests

A content hash is `SHA-256( tag_utf8 || 0x00 || canonical_utf8 )`. Reproduce a
digest without the Rust core with this command:

```bash
printf 'input\0{"proposed_message":"Hello, EU export!"}' | sha256sum
```

The result is `ebf29f3107f775b64d775c4acbe22d2ba495509039f10f93fb7a6b460547b558`,
the worked example in [hashing.md](../contracts/v0/hashing.md). The definition
example `2a9b1c7f4537bd4248a7c89ec1aae104b2cc92aad8c285a0b3ae9b9b17d83df6`
appears with the same value in the hashing group.

This command verifies data only. Product code always delegates hashing to the
Rust core, as [hashing.md](../contracts/v0/hashing.md) requires.

## Cross-file links

The fixtures reference each other. A change to one file must keep these links:

- The `when_uncertain` pair in `definitions/valid/` holds two files with one
  canonical form and one hash.
- The adapter conformance cases, the label-rule table, the replacement
  pairs, and the binding table reference the question definitions of
  `definitions/valid/`, and the binding table rebinds the exploration
  profile of `profiles/states.json`.
- The exact profile in `profiles/states.json` records the definition hash of
  `definitions/valid/exact-rules.json`.
- The calibration profiles record the plan, dataset, and split digests from
  `hashing/canonical.json`.
- The exploration profile records the translation digest from the translation
  entry in `hashing/canonical.json`.
- Each TypeBox pair records the canonical form and hash of its definition file.

The repository checks in `tests/repo/fixtures.test.ts` verify these links, the
digest formula, and the structural invariants. They do not replace the Rust
validation that later tasks implement.

## Runner duties

1. Run every group in this directory through the Rust core. Do not reimplement
   a rule, a canonicalizer, or a hash in a wrapper.
2. Compare outcomes, canonical forms, digests, reason codes, and field paths
   exactly. A difference is a conformance failure.
3. Keep the run offline, deterministic, and free of credentials, as
   [TESTING.md](../TESTING.md) requires.
4. Report a missing group or an unrunnable group as a failure. Do not skip it.

## Changes

Follow the change rules in the [contracts README](../contracts/README.md). An
additive contract change updates the affected fixtures in the same change.
