# measuretwice artifacts, schemas, and semantics

Status: Reference for the implemented v0 package. Published on 24 September
2026.

This page indexes the published artifact contracts of measuretwice and the
rules that cross every operation. The behavior is implemented, not proposed.
[contracts/README.md](../../contracts/README.md) owns every rule. This page
adds the package view: where each schema ships and how host code consumes
it.

Related references:

- [API reference](api.md) records the TypeScript operations that read and
  write these artifacts.
- [CLI reference](cli.md) records the command surface.

## The published schema set

Every artifact is plain JSON. Every schema states JSON Schema 2020-12. The
frozen set lives in [contracts/v0/](../../contracts/v0) and ships inside the
installed package at `measuretwice/schemas/`. The two sets stay equal; the
repository checks hold them together.

| Artifact | Schema | Written by | Read by |
| --- | --- | --- | --- |
| Check definition | [definition.schema.json](../../contracts/v0/definition.schema.json) | `defineChecks` or one trusted export | `load`, the CLI |
| Case record, one JSONL line | [case-record.schema.json](../../contracts/v0/case-record.schema.json) | The dataset author | `loadDataset` |
| Dataset metadata | [dataset.schema.json](../../contracts/v0/dataset.schema.json) | The dataset author | `loadDataset` |
| Assessment | [assessment.schema.json](../../contracts/v0/assessment.schema.json) | One registered evaluator | The run path |
| Calibration plan | [calibration-plan.schema.json](../../contracts/v0/calibration-plan.schema.json) | The owner, with agent help | `calibrate`, `revise`, `checkEvidence` |
| Profile | [profile.schema.json](../../contracts/v0/profile.schema.json) | `createExplorationProfile`, `calibrate`, `revise` | `load`, `inspect` |
| Run report | [run-report.schema.json](../../contracts/v0/run-report.schema.json) | `run` | The host, the renderers |
| Evaluation report | [evaluation-report.schema.json](../../contracts/v0/evaluation-report.schema.json) | `evaluate` | `compare`, the host |
| Comparison | [comparison.schema.json](../../contracts/v0/comparison.schema.json) | `compare` | The host |

Consume one schema from the installed package through its subpath export,
`measuretwice/schemas/<name>.schema.json`. One host build that resolves JSON
modules imports it directly; every other host reads the file with its own
file APIs.

The schema set is data for one general validator of the host. Authoritative
artifact validation belongs to the Rust core inside measuretwice. One
schema-valid artifact can still be invalid, because the core also enforces
the cross-field invariants.

Common rules that hold for every artifact:

- Encoding is UTF-8. One file holds one JSON value, or one object per line
  for JSONL.
- Every artifact states `schema_version`. The value is 1 in v0. One reader
  rejects an unknown or higher version with `unsupported_schema_version` and
  never coerces.
- Unknown fields are rejected. Values are never mutated during validation.
- One completed report, profile, or definition never changes in place. One
  revision is one new artifact with one new content hash.

## Supported input subset

The `inputs` field of one definition uses one published subset of JSON
Schema 2020-12. The root is one object schema with one to 64 properties,
every property required, and `additionalProperties: false`. Strings accept
`minLength` and `maxLength` from 0 to 250,000. Numbers and integers accept
the four bounds. Booleans, arrays, and objects complete the set.

The complete keyword tables, the limits, and the documented TypeBox
conversion live in the
[supported input schema subset](../../contracts/v0/input-schema.md). Its
machine-checkable form is
[input-schema.schema.json](../../contracts/v0/input-schema.schema.json).
One schema outside the subset is rejected with one field path, and no
constraint is dropped silently.

## One case record and its reference shapes

One dataset is one JSONL record file plus one metadata file. One complete
record states the input, the reference of every check, and the label
provenance. The reference shape follows the check kind:

- One categorical or binary question states `answer` and `outcome`, as in
  `{"answer": "conflict", "outcome": "pass"}`.
- One ordered question states `level` and `outcome`, as in
  `{"level": "serious", "outcome": "pass"}`.
- One exact rule states `outcome` alone, because code decides it.
- One undecided reference states `review: true` alone. One human reviews it.

```json
{
  "id": "eu-move-unrecorded-decision",
  "group": "eu-move-unclear",
  "tags": ["missing-evidence", "unrecorded-decision"],
  "input": {
    "prior_decision": "Discussion notes of 9 March 2026: the team reviewed EU hosting for customer data. The notes record no final decision.",
    "conversation": "Channel data-platform on 22 September 2026. Dana: Let us move the export worker and its data to the US region. No reply followed.",
    "proposed_message": "Was EU hosting one final requirement? This move may conflict with it. Please confirm before the change."
  },
  "expected": {
    "checks": {
      "decision-conflict": { "answer": "unclear", "outcome": "review" },
      "message-supported": { "answer": "incomplete", "outcome": "review" },
      "adds-information": { "answer": "no", "outcome": "pass" },
      "consequence": { "review": true },
      "message-length": { "outcome": "pass" }
    },
    "outcome": "review"
  },
  "label": {
    "author_type": "model",
    "origin": "synthetic",
    "reviewed": false,
    "reason": "The notes record no final decision, so the relationship and the consequence level cannot be established from the supplied evidence. The references need one human review."
  }
}
```

The metadata file beside the records declares what the dataset is. One file
holds one JSON object:

```json
{
  "schema_version": 1,
  "id": "changelog-entry-cases",
  "name": "Changelog entry draft cases",
  "revision": "2026-09-25.1",
  "kind": "development_fixture",
  "intended_population": "Drafted changelog entries with the commit titles of one merge. Written to cover the listed failure types. No real pull request.",
  "sampling_method": "Written by one coding agent to cover one counterexample per declared answer. No sampling of any real population.",
  "label_guidelines": "Named: the entry names one change that one commit title states. Stronger: one claim needs the support of one commit title.",
  "languages": ["en"],
  "record_count": 14,
  "splits": [{ "id": "explore", "purpose": "fitting", "groups": ["changes-named"] }]
}
```

The required fields are `schema_version`, `id`, `revision`, `kind`,
`intended_population`, `sampling_method`, `label_guidelines`, and `splits`.
The fields `name`, `languages`, and `record_count` are optional. One
declared `record_count` that disagrees with the record file fails at
`/record_count`. One `content_hash` names one stored dataset identity,
and the loader verifies it against the loaded records. The `kind` values
carry the evidence class: `development_fixture` and `synthetic_challenge`
support no qualification claim; only `representative_sample` may, and one
owner decides when that is true. The complete rules live in the
[case-record contract](../../contracts/README.md#case-records-and-datasets).

## Validation errors and reason codes

Reason codes are lowercase words joined by underscores. One code keeps its
meaning across releases. New codes may be added; codes are never renamed.
The complete registry lives in
[contracts/README.md](../../contracts/README.md#stable-reason-codes) and
holds six classes:

| Class | Where it surfaces | Examples |
| --- | --- | --- |
| Validation | `ValidationError` before execution | `invalid_json`, `missing_field`, `unknown_field`, `invalid_field_type`, `unsupported_keyword`, `nonportable_value`, `hash_mismatch`, `oversized_input`, `unsupported_format` |
| Execution | One component record of one run report | `evaluator_error`, `evaluator_timeout`, `invalid_assessment`, `retries_exhausted`, `deadline_exceeded`, `run_cancelled`, `late_result_rejected` |
| Skip | One component record of one run report | `queue_full`, `cancelled_before_start`, `deadline_before_start` |
| Compatibility | `load` and the enforcement gate, before execution | `definition_mismatch`, `evaluator_mismatch`, `translation_mismatch`, `model_resolution_changed`, `policy_mismatch`, `scope_mismatch`, `qualification_insufficient`, `profile_not_selected` |
| Qualification | The profile artifact | `starter_policy`, `measured_evidence`, `exact_rules_only` |
| Statistics | Evaluation and calibration results | `insufficient_evidence`, `zero_denominator`, `unsupported_sampling`, `criteria_not_met` |

Every `ValidationError` states one code, one JSON Pointer field path, and
one sanitized message. The message holds no credential and no raw case
content and shortens at 500 characters.

The CLI adds its own usage codes with exit code 2 — `unknown_command`,
`unsupported_option`, `missing_argument`, `unexpected_argument`,
`invalid_argument` — and the file codes `unreadable_file` and
`unwritable_output` with exit code 1. The [CLI reference](cli.md) records
them.

## Exact string semantics

The three exact rules of one definition — `maxLength`, `includes`, and
`excludes` — run on exactly one string input. The length of one string is
its number of Unicode code points: not UTF-8 bytes, not UTF-16 code units,
not grapheme clusters. One emoji counts once. One combining mark counts as
its own code point. `maxLength` passes when the length stays at or below the
parameter. `includes` and `excludes` match by containment of one contiguous
code point sequence, case-sensitive and without normalization: `includes`
passes when the parameter occurs inside the input, and `excludes` passes
when it does not.

The Rust core is the only implementation of these rules. One wrapper never
computes one length or one match on its own.

## Canonicalization and content hashes

One content hash is SHA-256 over one domain tag, one zero byte, and the
canonical form of the validated artifact. The canonical form follows
RFC 8785: UTF-8, no whitespace, sorted object keys, preserved array order,
ECMAScript number formatting. No Unicode normalization is applied. Negative
zero canonicalizes as `0`. One omitted `when_uncertain` canonicalizes as
`"review"`; that is the only default.

JSON formatting changes no hash. A profile and a plan hash themselves; one
stored value that differs from the computed digest fails with
`hash_mismatch`. The hash domains, the boundaries of each domain, and the
string rules live in the
[canonical hashing and string contract](../../contracts/v0/hashing.md). Its
machine-checkable companion is
[hashing.schema.json](../../contracts/v0/hashing.schema.json).

## Profile compatibility

One profile binds one definition, one evaluator per question check, one
decision-rule family with its parameters, one execution configuration, and
its qualification evidence. `load` verifies, in this order:

1. The stored self-hash of the profile, with `hash_mismatch` on one edited
   copy.
2. The complete profile contract.
3. The compatibility with the loaded definition, in the requested mode.

The compatibility check compares the definition hash, every evaluator
reference against the live registry with its adapter version, the translated
question hash of every adapter that exposes one, the policy family and its
coverage, and the model resolution. One refused comparison names its code:
`definition_mismatch`, `evaluator_mismatch`, `translation_mismatch`,
`model_resolution_changed`, or `policy_mismatch`.

Enforcement adds three gates before any case work starts:

- The qualification must be `validated_for_scope`, or the run refuses with
  `qualification_insufficient`.
- The requested scope must match the declared scope, or the run refuses
  with `scope_mismatch`.
- The host must state the reviewed content hash it selected through
  `selectedProfileHash`, or the run refuses with `profile_not_selected`.

An exploration profile stays `unvalidated` and works in evaluation and
shadow use only. One exact-only definition needs no plan, dataset, or
evaluation report: `load` derives its structural exact profile, which
carries `validated_for_scope` with reason `exact_rules_only`. That reason
records one structural basis, not one quality claim. The host still selects
the reviewed profile hash for enforcement.

One changed question, criterion, schema, input projection, preprocessing,
model resolution, translation, or evaluator code invalidates the prior
qualification. One policy-only change can reuse compatible stored
assessments for fitting through `revise`, but it needs fresh independent
validation before promotion. One scope change needs new evidence, because
one hash cannot detect population drift.

The qualification rules, the evidence rules, and the retained-evidence check
of `checkEvidence` live in
[contracts/README.md](../../contracts/README.md#profiles-and-qualification).

## Evaluator registration

Profiles refer only to evaluators that the host registered in its own code
through `registerEvaluators`. One loaded file installs no evaluator,
executes no code, and authorizes no tool. One profile that names one
unregistered evaluator fails `load` with `evaluator_mismatch` before any
execution. The [API reference](api.md#registerevaluators-and-the-evaluator-contract)
records the registration contract and the shipped adapters.
