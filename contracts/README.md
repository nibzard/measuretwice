# measuretwice portable contracts (v0)

Status: Frozen for v0 on 23 September 2026.

These contracts freeze the portable artifact formats for measuretwice.
[MVP_SPEC.md](../MVP_SPEC.md) controls scope. The [research records](../research/index.md)
give historical context only.

Every artifact is plain JavaScript Object Notation (JSON). Every schema file uses
JSON Schema 2020-12. The schemas live in [v0/](v0/) and are published as one set.
Resolve references from that directory.

## Artifact set

| Artifact | Schema | Written by | Immutable |
| --- | --- | --- | --- |
| Check definition | [definition.schema.json](v0/definition.schema.json) | `defineChecks` or a trusted export | Yes. A change makes a new hash. |
| Case record (one JSONL line) | [case-record.schema.json](v0/case-record.schema.json) | The dataset author | Yes |
| Dataset metadata | [dataset.schema.json](v0/dataset.schema.json) | The dataset author | Yes. A change makes a new revision. |
| Assessment | [assessment.schema.json](v0/assessment.schema.json) | A registered evaluator | Yes |
| Calibration plan | [calibration-plan.schema.json](v0/calibration-plan.schema.json) | The owner, with agent help | Yes |
| Profile | [profile.schema.json](v0/profile.schema.json) | `calibrate` or a profile generator | Yes |
| Run report | [run-report.schema.json](v0/run-report.schema.json) | `run` | Yes after a terminal state |
| Evaluation report | [evaluation-report.schema.json](v0/evaluation-report.schema.json) | `evaluate` | Yes |
| Comparison | [comparison.schema.json](v0/comparison.schema.json) | `compare` | Yes |

A completed report, profile, or definition never changes in place. A revision is a
new artifact with a new content hash. Old hashes keep their meaning.

## Common rules

- Encoding is UTF-8. A file holds one JSON value, or one object per line for JSONL.
- Every artifact states `schema_version`. The value is 1 in v0.
- A reader accepts only a `schema_version` it supports. It rejects an unknown or
  higher version with reason code `unsupported_schema_version`. It never coerces.
- Unknown fields are rejected. Every schema sets `additionalProperties: false`,
  except the input schema envelope, which holds JSON Schema keywords.
- Values are never mutated during validation. Validation is pass or fail.
- One documented default exists: an omitted `when_uncertain` means `review`.
  Every other omitted optional field means "absent", never a hidden value.
- Identifiers use lowercase letters, digits, and hyphens. Content hashes are 64
  lowercase hexadecimal characters. A hash identifies content. It does not prove
  a bit-for-bit replay of stochastic behavior.
- JSON Schema is the first gate. The Rust core also enforces the cross-field
  invariants in this document. A schema-valid artifact can still be invalid.

The [canonical hashing and string contract](v0/hashing.md) defines
canonicalization, the hash domains, the digest, and the exact string rules.
One Rust procedure implements it. Hash fields are canonical and content-bound,
not format-bound. Its machine-checkable fixture companion is
[hashing.schema.json](v0/hashing.schema.json).

### Authoring-to-contract conversion

The `defineChecks` example names the version field `version`. The portable
definition names it `schema_version`. One term per concept applies across all
nine artifacts. The conversion from the authoring field to the contract field is
part of the tested TypeBox conversion. TypeBox and equivalent JSON must produce
identical validated content.

## Definition contract

A definition names its inputs and checks. It contains no evaluator names, no
numerical cutoffs, and no executable values. Callbacks, closures, transforms,
custom validators, and JavaScript-only values are rejected before serialization.

Rust enforces these cross-field invariants beyond the schema file:

1. Check identifiers are unique inside the definition.
2. Every name in `using` is a declared input.
3. `accept` and `review` name existing answer labels. The two sets are disjoint.
4. `accept.at_least` names a level in `scale`.
5. Scale level names are unique. The array order is meaning.
6. Answers with keys `yes` and `no` only declare a binary question. Every other
   answer set declares a categorical question.
7. A rule check uses exactly one input. That input has string type.
8. `inputs.required` names every declared property. All top-level inputs are
   required. The root schema sets `additionalProperties: false`.
9. The input schemas use only keywords from the supported subset contract.
10. The check set is not empty.

The [supported input schema subset](v0/input-schema.md) lists the permitted
keywords, the limits, and the documented TypeBox conversion. Its
machine-checkable form is [input-schema.schema.json](v0/input-schema.schema.json).
TypeBox authoring metadata may be removed only by that documented conversion.
Unsupported constraints are never dropped silently.

## Case records and datasets

A dataset is one JSONL record file plus one metadata file. Each nonempty line
holds exactly one case record. An empty line is invalid.

- `input` holds only input data. Reference labels, expected outcomes, and label
  provenance never enter `input`. They never reach an evaluator.
- `label` records who produced the reference and whether a human reviewed it.
  A coding agent counts as a model author. Unreviewed model suggestions are not
  human judgments.
- `label.history` keeps earlier label records when a correction replaces a
  reference. Corrections keep the original provenance.
- A record without `group` forms its own group. One group appears in one split
  only. Related conversations stay in one split.
- `expected.checks` holds reference answers, review markers, or expected policy
  outcomes. A reference answer that conflicts with an expected outcome is kept
  and flagged for review. The conflict is not resolved silently.
- Validation checks every reference against the definition it loads with: one
  reference names a declared check, one answer names a declared answer, one
  level names a declared level, one answer or level fits the question kind of
  its check, and one rule check states an expected outcome alone. The loader
  reports the flagged conflicts and the provenance counts of the dataset, so a
  model proposal that no human reviewed never appears as one reviewed human
  judgment.
- The metadata file declares population, sampling method, revision, label
  guidelines, and splits. A synthetic challenge set is not a representative
  sample. Dataset kind states which one it is.
- The loader rejects malformed lines with the line number and a field path.
  It reports limits for record size, dataset size, and retained results.
- The published dataset limits: one record line holds at most 8,388,608
  bytes, the complete record file holds at most 536,870,912 bytes, and one
  dataset holds at most 100,000 records. Nothing is truncated. The loader
  retains the complete parsed records in memory and writes no file; report
  retention stays with the host.

## Assessments and the evaluator contract

An evaluator receives a validated question, the projected inputs authorized by
`using`, an execution budget, and a cancellation signal. It returns one typed
assessment or one execution failure.

- `kind` matches the check shape. Named answers give `categorical`. Explicit
  yes and no answers give `binary`. A descriptive scale gives `ordered`.
- Optional measurements are absent when the evaluator does not report them.
  A missing confidence stays missing. A missing distribution stays missing.
- A distribution is a measurement input. It is not a calibrated probability of
  correctness.
- Evidence references name inputs from the `using` list. Supplied source
  references are not evaluator-selected support.
- Label-only evaluators return a label and nothing else. The decision rule for
  a label-only evaluator is specified and evaluated separately.

The first semantic evaluator uses Jev. Named answers translate to Choice,
explicit yes and no answers translate to Noul, and an ordered scale translates
to Score. The profile records the complete translated question, the adapter
version, and the translation hash. A changed translation changes the binding.

## Calibration plans

A plan declares owner-selected goals. There are no universal default error
tolerances. The plan states the population, the metrics with their denominators,
the limits, the confidence level, and the minimum samples. It declares the
permitted candidate grid and the fitting and validation splits.

Rust enforces these cross-field invariants beyond the schema file:

1. Both cutoff families in `candidate_grid` exceed 0.5 for every value. This
   prevents simultaneous acceptance and rejection.
2. The fitting and validation selections use different splits of the declared
   datasets. The splits do not share a group.
3. Every constraint names a metric with an explicit denominator.
4. False acceptance rate and error among accepted cases are different metrics.
   The plan must state which one it constrains.
5. The referenced evaluator is registered and its configuration is complete.

Candidate enumeration follows the declared array order. The accept dimension is
the outer loop. The first candidate that meets all constraints and optimizes the
objective wins a tie. No feasible candidate is a valid result.

## Profiles and qualification

A profile binds one definition to evaluators, decision rules, execution limits,
and evidence. It contains no credentials and no private case content.

- `origin` is `exploration`, `calibration`, or `exact`. An exploration profile
  carries a starter policy, stays `unvalidated`, and works in evaluation and
  shadow use only. Starter thresholds have no qualification evidence. An exact
  profile binds exact rules only, as described below.
- A calibration profile records its plan, datasets, splits, label provenance,
  statistical method, and evaluation-report references.
- Qualification is `unvalidated`, `insufficient_evidence`, `criteria_not_met`,
  or `validated_for_scope`. The flag records measured evidence for a declared
  scope. It is not an authenticated approval.
- The host selects one reviewed profile hash for enforcement. An enforcement
  run states the selected hash, and the runtime admits the selected artifact
  alone: one absent or foreign selection fails with `profile_not_selected`.
  Runtime checks verify content consistency and required references. They
  cannot verify the truth of a forged dataset. No run selects, promotes, or
  rewrites one profile.
- Changed question wording, criteria, schema, projection, preprocessing, model
  resolution, translation, or evaluator code invalidates the qualification.
  Policy-only changes may reuse compatible stored assessments for fitting, but
  need independent validation before promotion. Scope changes need new evidence.

## Run reports

One run assesses one case. Every defined check appears in `checks`. All checks
are required in v0. Semantic failures never trigger cost-based short-circuiting.

The aggregate outcome follows a fixed order. Any fail gives fail. Otherwise any
error gives error. Otherwise any review or skip gives review. Otherwise pass.
Skipped checks surface as review in the aggregate, with their reason kept.

`completion` is separate from the aggregate outcome. A run completes, is
cancelled, or exceeds its deadline. A report in a terminal state is immutable.
A late result cannot change it.

Each component record keeps the raw assessment or the executed rule, the applied
policy parameters, the actual evaluator versions, attempts, timing, usage, and a
sanitized reason for error and skipped outcomes. Default explanations come from
check criteria and the executed policy, not from an invented evaluator rationale.

In shadow mode, `baseline` records the existing decision and its revision next
to the new outcome. Baseline agreement is not correctness. The baseline keeps
the vocabulary of the host decision path, the report computes no agreement, and
no field combines the two outcomes. A baseline is shadow-mode data: an
enforcement run states none, and one offered at run creation fails with
`invalid_field_type` at `/baseline` before any work starts, as one baseline
outside its bounds does. A pass never authorizes an application action. The
host consumes the report and decides.

### Private data defaults

A report states no raw case content and no credential. The `case` block names
the case by identifier and input hash alone. Assessment measurements stay,
because they are the record's purpose; case bodies do not enter it.

- Replay works through host storage. The optional `case.snapshot` field holds
  one host-controlled reference to the host's own stored snapshot of the
  input. The library writes no snapshot and copies no input into any report.
- The writer of a report is the host. The library persists no report, keeps no
  retention, and writes no log. Retention of reports and of sensitive
  metadata is a host decision.
- Datasets are explicit local artifacts. Calibration and evaluation read the
  files the host states; nothing collects case content on its own.
- Profiles stay free of credentials and private case content. The host keeps
  its credential mechanism and its evaluator allowlist.

## Evaluation reports

An evaluation runs labeled cases through the same validated execution path as
ordinary runs. It reports per-case outcomes, metrics with counts and
denominators, per-slice results, and operational failures over all attempts.

- Metrics cover each check and the complete check set, with scope `all_checks`.
- Missing labels are excluded only from the metrics that need them. Label
  coverage is reported.
- A zero denominator gives no value. The rate value is null.
- Errors and skips stay visible in every metric set.
- An evaluation never changes a qualification status or a host profile
  selection.

## Comparisons

A comparison matches cases by identifier and input hash. It lists changed,
missing, errored, and skipped cases. It shows changed component outcomes with
counts and metric denominators. Cost appears only when recorded usage and
declared cost inputs support it. The comparison records its evidence class.
A fitting comparison is not validation evidence.

## Outcome and status distinctions

Keep these eight concepts separate. They live at different levels and obey
different rules.

| Concept | Level | Values | What it is not |
| --- | --- | --- | --- |
| Invalid input | Before execution | Typed validation error with reason code and field path | Not an outcome. No evaluator runs. |
| Execution failure | Check outcome | `error` | Not a semantic answer. Never becomes a pass. |
| Uncertain judgment | Check outcome | `review` | Not an error. A human decides. |
| Rejection | Check outcome | `fail` | Not an execution problem. The assessment met an unacceptable meaning. |
| Not attempted | Check outcome | `skipped` with a reason | Not a pass. Saturation and cancellation skip work. |
| Completion status | Run | `completed`, `cancelled`, `deadline_exceeded` | Independent of the aggregate outcome. |
| Qualification | Profile | `unvalidated`, `insufficient_evidence`, `criteria_not_met`, `validated_for_scope` | Not an authenticated approval. Not a run result. |
| Application authorization | Host application | Host-defined | Never granted by a report or a profile. |

## Stable reason codes

Reason codes are lowercase words joined by underscores. A code keeps its
meaning across releases. New codes may be added. Codes are never renamed.
Every code below is stable from this freeze.

Validation reasons, reported before execution:

| Code | Meaning |
| --- | --- |
| `invalid_json` | The data is not valid JSON. |
| `unsupported_schema_version` | The artifact states an unsupported `schema_version`. |
| `unknown_field` | The artifact has a field outside its contract. |
| `missing_field` | A required field is absent. |
| `invalid_field_type` | A field has the wrong type or an invalid value. |
| `duplicate_id` | Two artifacts or checks share one identifier. |
| `unknown_label` | A selected answer label or level does not exist. |
| `unknown_input_name` | `using` names an input that is not declared. |
| `accept_review_overlap` | The accept and review sets are not disjoint. |
| `invalid_scale` | The scale is empty, short, or has duplicate levels. |
| `empty_check_set` | The definition has no checks. |
| `unsupported_keyword` | The input schema uses a keyword outside the supported subset. |
| `nonportable_value` | Authoring produced a value that JSON cannot preserve. |
| `hash_mismatch` | A stored self-hash differs from the computed digest. The artifact is an edited or corrupted copy. |
| `oversized_input` | An input or evidence item exceeds its published limit. No truncation occurs. |
| `unsupported_format` | A path names YAML or TypeScript source, which loaders do not accept. |

Execution reasons, reported in check records:

| Code | Meaning |
| --- | --- |
| `evaluator_error` | The evaluator reported an operational failure. |
| `evaluator_timeout` | One attempt exceeded its attempt budget. |
| `invalid_assessment` | The evaluator response did not match the assessment contract. |
| `retries_exhausted` | All attempts failed. The last reason is kept. |
| `deadline_exceeded` | The total run deadline passed. Completed components are kept. |
| `run_cancelled` | The caller cancelled the run. |
| `late_result_rejected` | A result arrived after a terminal state. It is recorded, not applied. |
| `invalid_state_transition` | An event does not fit the run state. |

Skip reasons, reported in check records:

| Code | Meaning |
| --- | --- |
| `queue_full` | The pending-work limit stopped this check from starting. |
| `cancelled_before_start` | The run was cancelled before this check started. |
| `deadline_before_start` | The deadline passed before this check started. |

Compatibility reasons, reported before execution:

| Code | Meaning |
| --- | --- |
| `definition_mismatch` | The profile binds a different definition hash. |
| `evaluator_mismatch` | A bound evaluator is not registered, or its version differs. |
| `translation_mismatch` | The translated question hash differs. |
| `model_resolution_changed` | A model alias resolved to a different version. |
| `policy_mismatch` | The policy family or parameters do not fit the definition. |
| `scope_mismatch` | The declared scope differs from the requested use. |
| `qualification_insufficient` | Enforcement needs a validated profile. |
| `profile_not_selected` | Enforcement needs the profile that the host selected by its reviewed content hash. |

Qualification reasons, recorded in profiles:

| Code | Meaning |
| --- | --- |
| `starter_policy` | The profile uses starter thresholds without qualification evidence. |
| `measured_evidence` | The qualification rests on recorded evaluation evidence. |
| `exact_rules_only` | The qualification rests on exact rules. No stochastic evaluator was measured. |

Statistics reasons, reported in evaluation and calibration results:

| Code | Meaning |
| --- | --- |
| `insufficient_evidence` | A denominator or sample requirement is not met. |
| `zero_denominator` | A rate has no value because its denominator is zero. |
| `unsupported_sampling` | The interval method does not support the declared sampling. |
| `criteria_not_met` | No feasible candidate satisfied the plan constraints. |

Error messages keep a short cause. They contain no credentials and no raw case
content. A sanitized message keeps the operational reason visible.

## Public operations

The public API is `defineChecks`, `load`, `run`, `calibrate`, `evaluate`, and
`compare`. Inspection belongs to the profile and report interfaces. All public
types stay independent of provider SDK classes and native binding types.

| Operation | Input | Output | Modes | Main failure behavior |
| --- | --- | --- | --- | --- |
| `defineChecks` | Authoring object with TypeBox inputs | Validated portable definition with inferred types | None | Rejects invalid definitions and nonportable values with field paths. |
| `load` | Trusted definition object, or an explicit JSON path; optional profile path | A bound reviewer | None | Rejects invalid artifacts, incompatible profiles, and unknown evaluator references. |
| `run` | One case with `id` and `input`; mode; shadow baseline; the host-selected profile hash and the requested scope for enforcement | Run report | `shadow`, `enforcement` | Rejects invalid cases and incompatible bindings before any evaluator call. Enforcement also rejects one wrong scope, one unvalidated qualification, and one profile the host did not select. Keeps operational failures in the report. |
| `calibrate` | Calibration plan, datasets, evaluator configuration | Candidate profile and calibration report | None | Invalid plans and dataset errors are explicit. No feasible policy is a valid result. Never promotes. |
| `evaluate` | Definition, profile, JSONL dataset, purpose | Evaluation report | None | Keeps errors, skips, and partial labels visible. Never changes qualification. |
| `compare` | Two stored report sets | Comparison | None | Lists unmatched and changed cases. Never matches on changed inputs. |

`load` does not load YAML and does not execute TypeScript source. A JSON export
is optional for the command-line interface (CLI) and for exchange.

### Resource limits

The wrapper owns queues and scheduling. Rust owns the state checks. The
effective limits come from `profile.execution`.

| Limit | Owner | Effect when reached |
| --- | --- | --- |
| `max_active` executions | Wrapper scheduler | Work waits in the queue. |
| `max_pending` executions | Wrapper scheduler | New work returns a `skipped` record with `queue_full`. |
| `deadline_ms` per case | Wrapper | `deadline_exceeded`. Completed components are kept. |
| `max_attempts` per check | Wrapper and provider SDK, configured once | `retries_exhausted` with the last reason. |
| `backoff_ms` base delay | Wrapper | Bounded delay inside the total deadline. |
| Input and evidence size | Rust validation | `oversized_input`. No truncation. |
| Calculation budget for calibration | Rust | An explicit limit failure. No partial policy. |

Cancellation is supported at every level. A cancelled run keeps its completed
components and records `run_cancelled` or `cancelled_before_start` for the rest.

## Exact-only definitions and profile compatibility

An exact-only definition contains only rule checks. Its outcomes are
deterministic functions of the inputs. No stochastic evaluator assesses it.

For such a definition, profile compatibility is structural:

1. The profile records `origin` as `exact`, `policy.family` as `exact`, and an
   empty `bindings` list.
2. The profile definition hash equals the loaded definition hash.
3. No evaluator bindings or numerical policy parameters exist to compare.

No calibration plan, dataset, or evaluation report is required. Statistical
calibration is not applicable, because no measured error source exists. A
compatibility check that needs no evidence satisfies this case by design.

Such a profile may carry `validated_for_scope` with reason code
`exact_rules_only`. That reason records a structural basis. It makes no claim
about the quality of the requirement itself. The host still selects the
reviewed profile hash for enforcement.

## Delivery sequence and deferred features

TypeScript is the first authoring interface and the first SDK for the v0 pilot.
The shared Rust core owns validation, exact rules, decision policy, statistics,
canonical hashes, and report construction. The Node binding through NAPI-RS
stays thin. Python follows the TypeScript pilot as the next SDK delivery. It
will use PyO3 bindings and emit the same JSON contracts. The cross-language
conformance fixtures in [fixtures/](../fixtures/README.md) are mandatory for
Python. Do not ship two public SDKs in the pilot.

Deferred outside v0: additional production backends, a built-in generative agent
service, unrestricted tool execution, YAML authoring, browser and edge runtimes,
probability-recalibration models, Bayesian planning, a formal-verification
evaluator, automatic claim extraction, general workflow orchestration, hosted
dashboards, marketplaces, and cryptographic approval infrastructure.

## Changes to these contracts

These contracts are frozen for v0. Change them only through review.

1. An additive change keeps `schema_version` at 1. It adds optional fields or
   new reason codes. It updates the conformance fixtures in the same change.
2. A breaking change creates a new `schema_version` or a new contracts version
   directory. It ships migration instructions with the change.
3. Every implementation change that touches an artifact format updates the
   affected schema in the same change.

Related contracts published after this freeze:

- [Supported input schema subset](v0/input-schema.md), with the
  machine-checkable [meta-schema](v0/input-schema.schema.json). Published on
  23 September 2026.
- [Canonical hashing and string semantics](v0/hashing.md), with the
  machine-checkable [fixture schema](v0/hashing.schema.json). Published on
  23 September 2026. Adds the reason code `hash_mismatch`.
- The enforcement selection clause of task T035, published on 24 September
  2026. Adds the reason code `profile_not_selected` and the enforcement
  input of the host-selected profile hash.
- The private-data defaults of task T036, published on 24 September 2026.
  Adds the optional run-report field `case.snapshot`, one host-controlled
  reference for replay, and records that reports hold no raw case content
  and no credential.
- The dataset loader limits of task T039, published on 24 September 2026.
  States the published numbers for record size, dataset size, and retained
  results that the case-record section names.
- The reference-label meaning and provenance rules of task T040, published on
  24 September 2026. Adds the clause that validation checks every reference
  against the definition it loads with, records the flagged conflict kinds
  `check_outcome_conflict` and `overall_outcome_conflict`, and states that
  the loader reports the provenance counts that keep human judgments apart
  from model proposals.
- The cross-language conformance fixtures that pin these contracts, in
  [fixtures/](../fixtures/README.md). Published on 23 September 2026. They are
  mandatory for the TypeScript SDK and for the later Python SDK.
