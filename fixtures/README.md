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
| Dataset loading | [datasets/loading.json](datasets/loading.json) | JSONL case records and dataset metadata: labels, provenance, groups, line-numbered rejections, duplicate identifiers, oversized records, and invalid inputs. |
| Reference labels | [datasets/labels.json](datasets/labels.json) | Reference-label meaning and provenance: human-reviewed references, agent proposals, missing labels, ambiguous review markers, corrected history, flagged outcome conflicts kept as written, and answers or levels that break the meaning of their check. |
| Dataset splits | [datasets/splits.json](datasets/splits.json) | Grouped splits and dataset identities: computed identities, group assignments, and split hashes with pinned digests, unassigned groups, one group in two splits, stored-hash mismatches, validation evidence classes, and fitting or validation overlap across datasets. |
| Evaluation metrics | [metrics/evaluation.json](metrics/evaluation.json) | Counts, confusion matrices, and rates with numerators and denominators: every reference category against every predicted outcome, false acceptance among reference fail and review cases, error among accepted cases, false rejection among reference pass cases, review rate, automatic coverage, and label coverage over partial labels, zero denominators as null values, errors and skips preserved in every denominator, per-slice sets, and attempts, latency, and usage totals. |
| Uncertainty intervals | [metrics/intervals.json](metrics/intervals.json) | Wilson score bounds against independent reference values: zero observed errors with one upper bound above zero, small denominators, and observed-all counts; `independent_cases` over one case per group, `grouped_cases` with the group as the draw, and `unsupported_sampling` under one repeated group; `insufficient_evidence` for missing denominators and unmet minimums; rejected confidence levels, counts, and requests; and the counts, draws, methods, assumptions, and upper bounds of every scope and slice, with the complete method statement. |
| Calibration plans | [plans/validation.json](plans/validation.json) | Owner goals and the permitted policy family: metrics with their denominators, limits, bases, and confidence levels, minimum sample counts by denominator name, important slices, the bounded candidate grid with cutoffs above 0.5 and optional confidence floors, the candidate enumeration order with its tie-break rule, the fitting and validation selections, stored self-hash verification with the computed plan identity, and the definition, dataset, purpose, split hash, separation, and evaluator bindings. |
| Fitting search | [fitting/search.json](fitting/search.json) | The bounded grid search over the fitting split: one known feasible candidate, one tie between two cutoffs that decide the same outcomes, conflicting goals that no permitted candidate meets together, one unachievable goal, the plan minimum gating one goal, and the upper-bound basis reading the Wilson bound; the status, the selected candidate with its objective counts, goal rows, and per-scope outcome counts, one row per enumerated candidate with its unmet metrics and evidence states, and the refusals that keep validation data, absent splits, foreign revisions and definitions, and broken assessments out of the search. |
| Frozen validation | [qualification/validation.json](qualification/validation.json) | The frozen validation of one selected candidate on independent cases: one validated scope on the observed value and one on the upper confidence bound, one unmet goal with the frozen candidate unchanged, one plan minimum above the validation counts, one important slice below its own floor, one reused holdout as development data, one correlated-group validation that states `unsupported_sampling` under `independent_cases` and validates under `grouped_cases`; the status, the reason codes in decision order, the evidence class, the goal rows with counts, bounds, draws, and evidence states, the sample requirements, the slice floors, and the predicted outcome counts; and the refusals that keep wrong-purpose, absent, and foreign validation selections, fitting results of another plan or with one patched identity or one candidate outside the grid, searches with no feasible candidate, and broken assessments out of the validation. |
| Canonical hashing | [hashing/canonical.json](hashing/canonical.json) | Every hash domain, the canonical form, and the digest. Includes the two worked examples from [hashing.md](../contracts/v0/hashing.md). |
| Exact string rules | [hashing/string-rules.json](hashing/string-rules.json) | `maxLength`, `includes`, and `excludes` boundaries, including the table in [hashing.md](../contracts/v0/hashing.md). |
| Hashing rejections | [hashing/invalid.json](hashing/invalid.json) | Text and bytes that no hash may cover. |
| TypeBox pairing | [authoring/typebox-pairs.json](authoring/typebox-pairs.json) | TypeBox sources and equivalent JSON with identical canonical content and hashes. |
| Serialization | [serialization/round-trips.json](serialization/round-trips.json) | Round trips, ordered arrays, order strictness, absence, and rejected executable values. |
| Assessments | [assessments/samples.json](assessments/samples.json) | The assessment contract and `invalid_assessment` rejections. |
| Adapter conformance | [adapters/conformance.json](adapters/conformance.json) | The test-adapter controls, absent optional measurements, the label-only decision rule, evaluator replacement, and independent profile bindings. |
| Jev translations | [translations/jev.json](translations/jev.json) | The Choice, Noul, and Score translations of the question definitions, their canonical text and translation-domain digests, the evidence state envelope, and the excluded label and baseline fields. |
| Outcomes | [reports/outcomes.json](reports/outcomes.json) | The aggregate order, every check outcome, the completion statuses, the case references with and without one host snapshot reference, and the shadow baselines with the enforcement-mode refusal. |
| Profile states | [profiles/states.json](profiles/states.json) | Every qualification status, the calibration evidence with its measured sample counts and the plan's stated minimums, artifact rejections, self-hash verification, and compatibility failures with the live evaluator state, the requested scope, and the host-selected hash of the requested mode. |
| Runtime traces | [runtime/traces.json](runtime/traces.json) | Queue limits, deadlines, cancellation, retries, permanent failures, partial failure, and late results. |

## Record shapes

- A valid definition file holds one complete definition artifact. Load it as it
  is. No wrapper field wraps it.
- A rejection record holds `note`, the artifact under `raw` (or `raw_text` and
  `bytes_hex` when JSON cannot hold the data), and `expected` with the stable
  `reason_code` and the `field_path` of the rejected field.
- A hash record follows `hashes` in
[hashing.schema.json](../contracts/v0/hashing.schema.json): `note`, `domain`,
`value`, `canonical`, and `content_hash`.
- A dataset loading record holds `note`, the records text under `records`
(JSON Lines, one record per line), an optional `metadata` override of the
group's shared metadata artifact, and, for one invalid record, `expected`
with the stable `reason_code` and the `field_path`. A record with
`materialize` states one padded input field: the runner replaces
`input.<pad_field>` with `<pad_bytes>` filler characters, which puts the
serialized line above the published record limit.
- A reference-label record holds `note`, the records text under `records`,
an optional `definition` file name in `definitions/valid/`, and `expected`.
One invalid record states the stable `reason_code` and the `field_path` of
the reference that breaks the meaning of its check. One valid record states
`findings`, one list of `{kind, line, case, check, field_path}` conflicts
the loader keeps as written, and `summary`, the provenance counts `records`,
`labeled`, `unlabeled`, `human_reviewed`, `human_unreviewed`,
`model_reviewed`, `model_unreviewed`, `corrected`, and `review_required`.
The finding `kind` is `check_outcome_conflict` or
`overall_outcome_conflict`; `check` is null when the conflict belongs to the
overall outcome alone.
- An evaluation-metrics record holds `note`, the records text under
  `records`, the evaluated `outcomes` (one `{id, checks, aggregate,
  completion, attempts, elapsed_ms?, usage?}` object per evaluated case),
  and `expected`. The group states its shared `definition` file name and
  `metadata` artifact. One valid record states `case_count`,
  `unevaluated_records`, `attempts`, `latency_cases`, and optional
  `elapsed_ms` and `usage` totals, `scopes` with one `{scope, counts,
  confusion, rates}` set per check and one for `all_checks`, and optional
  `slices` with the same sets per tag. The `confusion` block holds one
  predicted-outcome count row per reference category `pass`, `fail`,
  `review`, and `unlabeled`. Every rate states `metric`, `numerator`,
  `denominator`, and `value`, and `value` is null when the denominator is
  zero. One invalid record states the stable `reason_code` and the
  `field_path`. The expectations come from one independent implementation
  of the metric definitions, not from the Rust core.
- An uncertainty-interval record holds `note`, the records text under
  `records`, the evaluated `outcomes` in the shape of the metrics group,
  its interval request (`sampling`, `confidence_level`, `minimum_samples`),
  and `expected`. The group states its shared `definition` file name and
  `metadata` artifact. One valid record states the `method`,
  `confidence_level`, `sampling`, `minimum_samples`, and
  `method_statement` of the report, `scopes` with one `{scope, intervals}`
  set per check and one for `all_checks`, and optional `slices` with the
  same sets per tag. Every interval row states `metric`, the `numerator`
  and `denominator` of its rate, the `draws` and `event_draws` behind the
  interval, and either `lower` with `upper` or the `reason` no bound
  computes: `insufficient_evidence` or `unsupported_sampling`. A count row
  under `counts` states `numerator`, `denominator`, and `confidence_level`
  with the same expectation, and one invalid row states the stable
  `reason_code` and the `field_path` of its rejected `request`. The bounds
  come from one independent implementation of the documented formula with
  the stated quantiles, not from the Rust core.
- A calibration-plan record set holds one shared `definition` file name, one
  shared `dataset` with its `dataset_records` JSON Lines text, one optional
  `other_dataset` with `other_dataset_records`, a `plans` array of valid
  artifacts, a `facts` object keyed by plan identifier, an `invalid` array of
  rejection records, and a `bindings` array. One valid plan that carries
  `content_hash` states its computed self-hash in the plan domain. One facts
  entry states the computed identity, the `candidate_count`, the head of the
  `candidates` enumeration, the `objective`, the `confidence_level`, and the
  `denominators`. One rejection record holds `note`, the artifact under
  `plan`, and `expected` with the stable `reason_code` and the `field_path`.
  One binding row holds `note`, one plan under `plan_id` or `plan`, and any
  of `definition` (a file name in `definitions/valid/`), `fitting` with
  `validation` (split names of the primary dataset, or `other:<split>` of the
  second dataset), and `evaluators`; one absent `expected` means the pairing
  loads. The hashes and the candidate order come from one implementation of
  the hashing and enumeration rules outside the Rust core.
- A fitting-search record set holds one shared `definition` file name, one
  shared `dataset` with its `dataset_records` JSON Lines text, the
  `fitting_cases` identifiers, the stored `assessments` keyed by case and
  question check, a `plans` array of valid artifacts, a `facts` object keyed
  by plan identifier, and an `invalid` array of rejection records. One facts
  entry states the `status` word (`feasible` or `no_feasible_candidate`),
  the `case_count`, the `candidate_count`, the computed
  `split_content_hash`, the `selected` block, and one `candidates` row per
  enumerated candidate. The `selected` block states the `index`, the
  `candidate` parameters, the `objective` with its metric and counts, one
  `constraints` row per declared goal, and one `scopes` row per check and
  one for `all_checks` with the predicted outcome `counts`. Every goal row
  states `metric`, `met`, the `numerator` and `denominator` of its rate, the
  `observed` value and the `upper_bound` (null when absent), and the
  `evidence` word `measured`, `zero_denominator`, or `below_minimum` with
  `stated` and `measured`. Every candidate row states `index`, `candidate`,
  `feasible`, the objective counts, the `unmet` metric words, and the
  `evidence` words. One rejection record holds `note`, the artifact under
  `plan` or `plan_id`, an optional `assessments` override, and `expected`
  with the stable `reason_code` and the `field_path`.
- A frozen-validation record set holds one shared `definition` file name,
  one shared `dataset` with its `dataset_records` JSON Lines text, one
  optional `other_dataset` with `other_dataset_records`, the
  `fitting_cases` and `validation_cases` identifiers, the stored
  `fitting_assessments` keyed by case, the stored `assessments` and
  `other_assessments` of the validation cases, one default `request` object
  (`sampling`, optional `previously_used` as split names of the plan's
  dataset), per-plan `requests` overrides, per-plan
  `assessment_overrides`, a `plans` array of valid artifacts, a `facts`
  object keyed by plan identifier, and an `invalid` array of rejection
  records. One facts entry states the `status` word, the `reasons` codes in
  decision order, the `evidence_class` word, the `case_count`, the
  `candidate_index`, the `candidate` parameters with the `applied` policy,
  one `goals` row per declared goal, the `sample_requirements` rows, the
  `slices` rows, and the predicted outcome `counts` of the complete check
  set. Every goal row states `metric`, `met`, the `numerator`,
  `denominator`, and `draws` of its rate, the `observed` value and the
  `upper_bound` (null when absent), and the `evidence` word `measured`,
  `zero_denominator`, `unsupported_sampling`, or `below_minimum` with
  `stated` and `measured`. One rejection record holds `note`, the artifact
  under `plan` or `plan_id`, any of `validation_split`, `foreign_`
  `validation_dataset`, and `edited_plan_limit` to move the offered plan,
  `fit_plan` to offer the fit of another plan, `fit_patch` to patch one
  identity or the selected candidate of the fit, and `assessment_patch`
  with `add` or `remove`, then `expected` with the stable `reason_code` and
  the `field_path`.
- A string rule record follows `string_rules` in the same schema: `note`,
  `rule`, `parameter`, `input`, `outcome`, and `length` for `maxLength`.
- A TypeBox pair holds `note`, `definition` (a file name in
  `definitions/valid/`), `typebox` (TypeScript source), `canonical`, and
  `content_hash`. Both sides must produce the recorded canonical form and hash.
- A runtime trace holds `id`, `note`, `definition`, `case_input`, `config`,
  `events`, and `expected`. Events carry `at_ms` on the fake clock that
  [TESTING.md](../TESTING.md) defines. An `attempt_failed` event may state
  `permanent: true`: the wrapper declined the retry, so the failure records
  its error at the failing attempt. An event listed in `rejected_events`
  must not change the report.
- An adapter conformance case holds `note`, `adapter`, `definition` (a file
  name in `definitions/valid/`), `check`, `case_input`, `control`, and
  `expected`. A control is the string `script-empty` or one object with
  exactly one of `answer`, `raw`, `error`, and `answers`, plus one optional
  `delay_ms`. A case may state `signal: "aborted"`. An expected record holds
  one exact `assessment` or one `failure` with one code and one exact or
  contained message, plus the observed `delays_ms`.
- A Jev translation case holds `note`, `definition` (a file name in
  `definitions/valid/`), `check`, `kind`, `primitive`, `question` (the
  complete translated question in the wire shape of the pinned SDK),
  `canonical`, `content_hash`, `case_input`, `using`, and `expected_state`.
  An identity record adds `base`, `changed_element`, and `origin`, which is
  `translation` for one changed translation of the same check or `check`
  for one changed check that also carries `variant_question`. A state
  rejection holds `using`, `inputs`, and the expected `reason_code` and
  `field_path`.

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
- The plans group carries the canonical plan of `hashing/canonical.json` with
  its published digest, and its other plans bind the definition hash of
  `definitions/valid/categorical-question.json`.
- The Jev translation cases reference the question definitions of
  `definitions/valid/`. The identity records of the translation group vary
  one preserved element at a time, so each changed element changes the
  translation digest. The exploration profile of `profiles/states.json`
  keeps its own synthetic translation binding; profile generation records
  real translations when it lands.
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
