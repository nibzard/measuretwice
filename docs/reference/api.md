# measuretwice API reference

Status: Reference for the implemented v0 package. Published on 24 September
2026.

This page documents the public TypeScript API of the `measuretwice` package.
Every section states inputs, outputs, side effects, resource limits, modes,
and failure behavior of one operation. The behavior is implemented, not
proposed.

Related references:

- [Artifact schemas and semantics](artifacts.md) records the published
  schemas, the reason codes, the exact string semantics, and the profile
  compatibility rules.
- [CLI reference](cli.md) records the command surface.
- [contracts/README.md](../../contracts/README.md) owns the portable
  contracts that this package implements.
- The [operation guide](../guides/operations.md) documents the runtime
  behavior behind these limits: scheduling, failures, host responsibilities,
  and evidence retention.
- [MVP_SPEC.md](../../MVP_SPEC.md) records the product scope.

## Conventions

Every operation validates its inputs before it executes anything. Invalid
data throws one `ValidationError` with three fields:

- `code`, one stable reason code from the
  [registry](../../contracts/README.md#stable-reason-codes).
- `fieldPath`, one JSON Pointer to the rejected field. An empty path names
  the complete document.
- `message`, one short sanitized cause. It holds no credential and no raw
  case content.

One unreadable path throws one ordinary `Error` that names the path. File
access is host territory, not contract validation.

Side effects follow one rule: the package states every file it reads, stores
no report, and starts no network call. Only evaluators contact providers,
and only the host registers evaluators. See each operation for its exact
boundaries.

No public type names a provider SDK class or a native binding type. Every
artifact is plain JSON data.

## Resource limits

| Limit | Value | Effect when reached |
| --- | --- | --- |
| Active check executions | `profile.execution.max_active` | Work waits in the queue. |
| Pending check executions | `profile.execution.max_pending` | New work records one `skipped` outcome with `queue_full`. |
| Total deadline per case | `profile.execution.deadline_ms` | `deadline_exceeded`. Completed components are kept. |
| Attempts per check | `profile.execution.max_attempts` | `retries_exhausted` with the last reason. |
| Backoff between attempts | `profile.execution.backoff_ms`, doubling | Bounded delay inside the total deadline. |
| Jev evidence budget | 32,000 UTF-8 bytes of state plus question | `oversized_input` before the provider call. Nothing is truncated. |
| Dataset record line | 8,388,608 bytes | `oversized_input`. The line is refused. |
| Dataset records file | 536,870,912 bytes | `oversized_input`. The file is refused. |
| Dataset records | 100,000 | `invalid_field_type`. The dataset is refused. |
| Fitting candidate grid | 1,024 candidates | `invalid_field_type`. The search refuses the grid with its count. |
| Fitting decisions | 1,048,576 candidate-case decisions | `invalid_field_type`. The search refuses with its count. |
| Sanitized reason message | 500 characters | The message shortens without splitting one surrogate pair. |
| Identifiers | 64 characters, lowercase segments joined by hyphens | `invalid_field_type`. |

The starter execution configuration of an exploration profile is
`max_active` 4, `max_pending` 16, `deadline_ms` 30000, `max_attempts` 2, and
`backoff_ms` 200. The structural exact profile uses the same bounds with one
attempt and no backoff. One calibration profile records the effective
configuration that its plan declared. `createExplorationProfile`, `calibrate`,
and `revise` accept overrides through their `execution` option.

Cancellation is supported at every level. Pass one `AbortSignal`. A cancelled
run keeps its completed components and freezes with completion status
`cancelled`.

## `defineChecks`

```ts
import Type from "typebox";
import { defineChecks } from "measuretwice";

export const memorySupport = defineChecks({
  version: 1,
  name: "memory-support",
  when_uncertain: "review",
  inputs: Type.Object(
    {
      original_sources: Type.String({ minLength: 1, maxLength: 4000 }),
      candidate_text: Type.String({ minLength: 1, maxLength: 1000 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "memory-supported",
      name: "The proposed memory follows from its original sources",
      using: ["original_sources", "candidate_text"],
      question: "Does the supplied original evidence support the proposed memory?",
      answers: {
        supported: "The original sources establish every material claim.",
        contradicted: "One claim conflicts with an explicit statement.",
        insufficient: "The sources cannot establish one or more claims.",
      },
      accept: "supported",
      review: "insufficient",
    },
    {
      id: "memory-length",
      name: "The memory fits the storage limit",
      using: ["candidate_text"],
      rule: { maxLength: 1000 },
    },
  ],
});
```

**Inputs:** one authoring object. `inputs` is one TypeBox object schema.
`checks` holds one or more check objects. Each check states exactly one of
`question` or `rule`. Read the complete authoring rules in
[MVP_SPEC.md section 4](../../MVP_SPEC.md#4-readable-typescript-definitions)
and the definition contract in
[contracts/README.md](../../contracts/README.md#definition-contract).

**Output:** the validated, frozen, portable definition. The value is plain
JSON data. `JSON.stringify` writes the contract artifact, with no extra
field. `CaseInput<typeof definition>` reads the inferred case-input type, and
`InputName` constrains `using` to the declared input names at compile time.
The Rust core re-validates both rules at run time.

**Side effects:** none. The function reads its argument, calls the native
validator, and returns one frozen value.

**Conversion:** the TypeBox conversion removes the hidden TypeBox markers and
the annotations `title`, `description`, and `examples`. It removes nothing
else and adds no keyword. The authoring field `version` becomes
`schema_version`, so its failures report under `/schema_version`.

**Failure behavior:** throws `ValidationError` before any artifact exists.
Nonportable values fail with `nonportable_value`. Refine checks and codec
transforms fail with `nonportable_value`. Unsafe types and misplaced optional
modifiers fail with `unsupported_keyword`. Contract breaches fail with the
definition reason codes, such as `duplicate_id`, `unknown_label`,
`unknown_input_name`, `accept_review_overlap`, `invalid_scale`, and
`empty_check_set`.

## `registerEvaluators` and the evaluator contract

```ts
import { createLabelOnlyEvaluator, registerEvaluators } from "measuretwice";

const evaluator = createLabelOnlyEvaluator({
  answers: { "memory-supported": "supported" },
});
const registry = registerEvaluators(evaluator);
registry.ids; // ["label-only-test"]
```

**Inputs:** one or more evaluator objects. One evaluator states one `id`
inside the identifier rule, one nonempty `adapter_version` of at most 64
characters, one `assess` operation, and one optional `translate` operation.

**Output:** one frozen registry. `ids` lists every registered identifier in
registration order. `get` returns the evaluator of one identifier, or
`undefined`.

**Side effects:** none.

**The request:** `assess` receives one `EvaluatorRequest` with the validated
question of the check, the projected inputs that its `using` list authorizes
and no other field, one execution budget (`attempt`, `max_attempts`,
`deadline_at_ms`), and the cancellation signal of the run. One request holds
exactly one question.

**The answer:** one `EvaluatorExecution` holds exactly one assessment or one
failure, with optional operational measurements: `model_resolved`, `usage`,
and `latency_ms`. One assessment states its `kind`, the selected answer, and
only the measurements that the evaluator really reported. One absent
confidence stays absent. One absent distribution stays absent. A distribution
is one measurement input, not one calibrated probability of correctness.
Evidence references must name inputs of the `using` list.

**Failure behavior:** registration rejects one broken evaluator object with
`invalid_field_type` and one duplicate identifier with `duplicate_id`. During
one run, one thrown adapter error, one malformed answer, and one assessment
outside the contract of its check become one component failure record with
`evaluator_error` or `invalid_assessment`. One broken adapter never crashes
one run, and one invalid answer never enters one report.

**Compatibility:** one bound profile refers only to registered evaluators.
One unknown reference fails `load` with `evaluator_mismatch`. One changed
adapter version fails the same way. When the adapter exposes `translate`,
one changed translated question fails with `translation_mismatch`. One
loaded file installs no evaluator.

## `createJevEvaluator`

```ts
import { createJevEvaluator, registerEvaluators, type JevCall } from "measuretwice";

const call: JevCall = async () => {
  throw new Error("supply the systemOne call boundary of your host SDK client");
};
const evaluator = createJevEvaluator({ call, model: "jev-1.13.0" });
const registry = registerEvaluators(evaluator);
```

**Inputs:** one options object. `call` is the Jev call boundary,
structurally the `systemOne` operation of the pinned `@typesafe-ai/sdk`.
`model` is one versioned identifier; the default is `jev-1.13.0`. `id`
defaults to `jev`. `adapter_version` defaults to `0.1.0`. `now` overrides the
clock for tests.

**Output:** one evaluator with one `translate` operation. The adapter
translates one validated question into one versioned Jev question: named
answers become Choice, explicit yes and no answers become Noul, and one
ordered scale becomes Score. `JEV_TRANSLATION_VERSION` is `0.1.0`.
`translateJevQuestion` exposes the same translation as one offline function.

**Side effects:** the adapter calls the supplied boundary once per attempt.
It reads no credential. The host client owns the credential and the network.

**Resource limits:** evidence is counted in UTF-8 bytes. The serialized state
plus the serialized question must stay within 32,000 bytes. Evidence above
the budget is rejected before the provider call with `oversized_input`, and
nothing is truncated. Supplied messages are untrusted evidence. Embedded
instructions stay one string value and reach no permission and no tool.

**Failure behavior:** provider failures map to `evaluator_error` with one
sanitized message that keeps the class, the status, and the request
identifier, without one echoed body. One attempt above its budget records
`evaluator_timeout`. One answer outside the pinned SDK shape records
`invalid_assessment` or `evaluator_error`. The operational record keeps the
model version that answered and the usage of the request.

The verified provider contract, the pinned SDK version, and the answer
shapes are recorded in
[providers/jev/README.md](../../providers/jev/README.md).

## Test evaluators

```ts
import {
  createLabelOnlyEvaluator,
  createScriptedEvaluator,
  decideLabelOnly,
  labelRuleChecks,
  registerEvaluators,
  type Definition,
} from "measuretwice";

declare const definition: Definition;

// One fixed table of answers, by check identifier. Stays offline.
const table = createLabelOnlyEvaluator({
  answers: { "memory-supported": "insufficient" },
});

// One scripted control list, answered in order. Records every request.
const script = createScriptedEvaluator({ steps: [] });

const registry = registerEvaluators(table, script);

// The separately specified decision rule of one label-only assessment.
const rules = labelRuleChecks(definition);
const decision =
  rules.length > 0
    ? decideLabelOnly(rules[0]!, { kind: "categorical", label: "supported" })
    : "review";
```

The package ships two offline adapters: `createScriptedEvaluator`, which
answers through one fixed control list with success, review, malformed,
error, and delayed responses, and `createLabelOnlyEvaluator`, which answers
from one fixed table. Both record every request they receive. Both prove
that the core depends on no Jev response shape. `labelRuleChecks` resolves
the label rule of every question check of one definition, and
`decideLabelOnly` applies the separately specified decision rule for
label-only answers. These adapters are product code. Use them for offline
hosts and tests.

One control states exactly one of `answer`, `raw`, and `error`, and the
adapter validates the whole script when it is created. One call consumes one
step, in order. The `answer` control holds one assessment or one operational
failure, with the optional measurements that one real adapter reports:

```ts
import { createScriptedEvaluator, type TestEvaluatorControl } from "measuretwice";

// One control per expected request, answered in order.
const steps: readonly TestEvaluatorControl[] = [
  {
    // One valid answer. The assessment kind matches the check shape:
    // categorical with `label`, binary with `value`, ordered with `level`.
    answer: {
      assessment: {
        kind: "categorical",
        label: "supported",
        distribution: [
          { name: "supported", mass: 0.9 },
          { name: "contradicted", mass: 0.05 },
          { name: "insufficient", mass: 0.05 },
        ],
      },
      latency_ms: 4,
    },
  },
  {
    // One operational failure with one stable code and one sanitized cause.
    answer: {
      failure: { code: "evaluator_error", message: "the provider closed the stream" },
    },
  },
  {
    // One answer outside the contract. The dispatch records one failure.
    raw: { guess: "supported" },
  },
];

const evaluator = createScriptedEvaluator({ steps });
evaluator.calls; // every request seen so far, in call order.
evaluator.remaining(); // the steps that no call consumed yet.
```

Every optional measurement stays absent until you state it: `distribution`,
`confidence`, `evidence`, `position`, `latency_ms`, `usage`, and
`model_resolved`. Never copy one distribution from one case into another:
the values you state are the values the policy executes. One `delay_ms`
waits through the injected sleep before the step resolves, so one test can
observe one response that arrives late.

## `createExplorationProfile`

```ts
import {
  createExplorationProfile,
  type Definition,
  type EvaluatorRegistry,
} from "measuretwice";

declare const definition: Definition;
declare const registry: EvaluatorRegistry;

const profile = createExplorationProfile(definition, registry, {
  starter: { accept_cutoff: 0.8, rejection_cutoff: 0.6 },
});
profile.qualification.status; // "unvalidated"
```

**Inputs:** one validated definition, the evaluator registry, and optional
settings: `id` (default: the definition name plus `-exploration`), one
`intendedUse` statement, one `bindings` map from check identifier to
evaluator, `starter` and `starterChecks` policy parameters, and `execution`
overrides.

**Output:** one signed profile artifact that `load` accepts. The profile
binds one evaluator per question check, records the translated question of
each adapter that exposes one, and stays `unvalidated` with reason
`starter_policy`. The value is frozen and holds no credential and no case
content. Generation is deterministic: the same inputs produce the same
content hash on every call.

**Side effects:** none. The function reads no clock, draws no identifier,
and calls no provider.

**Modes:** evaluation and shadow use accept the profile. Enforcement refuses
it with `qualification_insufficient`, because starter thresholds carry no
qualification evidence.

**Default starter policy:** `accept_cutoff` 0.8 and `rejection_cutoff` 0.6,
with no confidence floor. Both cutoffs must exceed 0.5 and stay at most 1.

**Failure behavior:** one exact-only definition refuses with
`invalid_field_type` at `/checks`, because exact rules take the structural
exact profile that `load` derives. One binding that names no registered
evaluator or no question check, one question check without one binding, and
one starter parameter outside the policy contract throw `ValidationError`
with its field path.

## `load`

```ts
import { load } from "measuretwice";

const reviewer = await load(".measuretwice/definitions/memory-support.json", {
  profile: ".measuretwice/profiles/memory-support.json",
});
reviewer.definitionHash; // the definition-domain content hash
```

**Inputs:** one definition, and one options object. The definition is the
value of `defineChecks` as one trusted import, one definition artifact, or
one explicit `.json` path. The options state one optional profile path, the
evaluator registry that one bound profile refers to, and the boundaries that
tests inject: `files`, `now`, `nextRunId`, and `setTimer`.

**Output:** one reviewer. `reviewer.profile` holds the bound profile, or the
derived structural exact profile of one exact-only definition. It holds
`undefined` when no profile was stated and the definition holds one question
check; `run` then refuses.

**Side effects:** the wrapper reads the stated paths through the injected
file access. It writes nothing.

**Validation order:** the core validates the definition, then, for one stated
profile, verifies its stored self-hash, validates the complete profile
contract, and checks its compatibility with the definition in shadow mode.
One bound profile that names evaluators is compared against the live
registry: one unregistered reference, one changed adapter version, and one
changed translation fail before any execution.

**Modes:** none. `load` checks compatibility in shadow mode. `run` repeats
the check in enforcement mode with the additional gates.

**Failure behavior:** one path that names no `.json` file fails with
`unsupported_format`. Malformed JSON fails with `invalid_json`. One edited
profile fails with `hash_mismatch`. One profile of another definition fails
with `definition_mismatch`. One binding outside the registry fails with
`evaluator_mismatch`, and one changed translated question with
`translation_mismatch`. `load` loads no YAML and executes no TypeScript
source.

## `Reviewer.run`

```ts
import type { Reviewer, ShadowBaseline } from "measuretwice";

declare const reviewer: Reviewer<{ message: string }>;

const baseline: ShadowBaseline = {
  outcome: "stored",
  revision: "memory-policy-1",
};
const report = await reviewer.run(
  { id: "case-1", input: { message: "One proposed memory" } },
  { mode: "shadow", baseline },
);
report.aggregate.outcome; // "pass", "fail", "review", or "error"
```

**Inputs:** one case with one stable `id` and the complete `input` object,
and one options object: `mode`, `baseline`, `selectedProfileHash`, `scope`,
`signal`, and `snapshot`. The Rust core validates the case against the input
schema of the definition and projects each check's authorized inputs.

**Output:** one frozen run report. It names the case by identifier and input
hash alone, holds one record per defined check in definition order, the
applied policy or rule, the evaluator versions, the timing, the usage, and
one sanitized reason for every `error` and `skipped` outcome. The aggregate
outcome folds in one fixed order: any fail gives fail, otherwise any error
gives error, otherwise any review or skip gives review, otherwise pass.
`completion` is separate: `completed`, `cancelled`, or `deadline_exceeded`.
One report in one terminal state is immutable, and one late result cannot
change it.

**Side effects:** the wrapper executes evaluators through the registry and
persists nothing. The host stores the returned report. One report states no
raw case content and no credential. The optional `snapshot` option records
one host-controlled reference to the host-stored input, as `case.snapshot`.

**Modes:** `shadow` is the default. It records the existing decision of the
host through `baseline` beside the new outcome, and no library code reads the
baseline, compares the two, or acts on either. Agreement with the baseline is
not correctness. `enforcement` repeats the compatibility check in enforcement
mode first: it needs one profile with qualification `validated_for_scope`
whose scope matches the requested `scope`, and the reviewed content hash the
host selected through `selectedProfileHash`. The run refuses with
`qualification_insufficient`, `scope_mismatch`, or `profile_not_selected`
before any case work starts. One baseline reaches one enforcement run
nowhere; the option refuses with `invalid_field_type` at `/baseline`.

**Bounds:** the baseline `outcome` holds 1 to 64 characters and the baseline
`revision` holds 1 to 128 characters. The snapshot reference holds 1 to 256
characters.

**Latency:** `run` is one awaited call. It returns when the run reaches one
terminal state. Its added latency stays inside the total deadline of the
profile. The library starts no detached job and owns no background scheduler.
Route nonblocking shadow work through one queue that the host owns.

**Failure behavior:** an invalid case, one definition with one question check
and no bound profile, and every refused gate throw `ValidationError` before
any evaluator runs. One execution failure becomes one component record: one
retryable failure retries inside the attempt budget, exhausted attempts
record `retries_exhausted`, one invalid assessment records
`invalid_assessment` without one retry, and one undecidable answer records
one `invalid_assessment` error that keeps the cause. Saturation records one
`skipped` outcome with `queue_full`. A pass never authorizes an application
action. The host consumes the report and decides.

## `loadDataset` and the split helpers

```ts
import { classifyValidationEvidence, loadDataset, type Definition } from "measuretwice";

declare const definition: Definition;

const dataset = await loadDataset({
  definition,
  metadata: ".measuretwice/cases/memory-support.metadata.json",
  records: ".measuretwice/cases/memory-support.jsonl",
});
dataset.identity.revision; // the declared dataset revision
const runCase = dataset.runCase(dataset.cases[0]!); // labels stay out
const evidence = classifyValidationEvidence(
  dataset.splits[1]!,
  dataset.identity,
);
evidence.class; // "development" or "independent_validation"
```

**Inputs:** one options object with the definition (trusted import, one
artifact, or one explicit `.json` path), one explicit `.json` metadata path,
one explicit `.jsonl` records path, and the optional file access.

**Output:** one frozen dataset. It holds the validated metadata, the
`identity` with the revision, the kind, the population statement, the
sampling provenance, the content hash, and the group assignments, every
declared split with its identity, every case record with its reference
labels and label provenance, and the `labels` review. `runCase` strips every
label field, so reference labels and provenance never reach an evaluator
request.

**Side effects:** the wrapper reads the two stated paths. It retains the
complete parsed records in memory and writes no file.

**Validation:** the core validates the metadata contract, every record line,
the unique case identifiers, the declared record count, every input object
against the input schema, and every reference label against the meaning of
its check. One reference answer that conflicts with its stated expected
outcome loads, stays as written, and is flagged in `labels.findings`. The
provenance counts of `labels.summary` keep human judgments apart from model
proposals.

**Split helpers:** `detectSplitOverlap` reports the shared groups and shared
cases of two splits. `requireSeparatedSplits` refuses one shared group or
case with `duplicate_id`. `classifyValidationEvidence` states the evidence
class of one validation split: one reused holdout, one renamed split, one
synthetic challenge split, and one empty split are development data, so one
new qualification claim needs fresh validation evidence.

**Failure behavior:** one malformed line fails with its line number and one
field path. One stored dataset or split hash that differs from the computed
digest fails with `hash_mismatch`. One record line above the byte limit and
one file above the size limit fail with `oversized_input`. Nothing is
truncated. One records path that names no `.jsonl` file fails with
`unsupported_format`.

## `evaluate`

```ts
import { evaluate, type Reviewer } from "measuretwice";

declare const reviewer: Reviewer<Record<string, unknown>>;

const evaluation = await evaluate(reviewer, {
  metadata: ".measuretwice/cases/holdout.metadata.json",
  records: ".measuretwice/cases/holdout.jsonl",
  purpose: "independent_validation",
  intervals: { sampling: "grouped_cases", confidence_level: 0.95, minimum_samples: 10 },
});
evaluation.report.metrics[0]?.rates[0]?.value; // a rate, or null at zero denominator
```

**Inputs:** the bound reviewer of `load`, and one options object: the two
dataset paths, the required `purpose`, the optional `intervals` request, the
optional `signal`, and the optional file access. The purpose is
`exploration`, `fitting`, or `independent_validation`. Fitting results are
not validation evidence.

**Output:** one `Evaluation` with five parts. `report` is the evaluation
report artifact; `JSON.stringify` writes it. It holds the per-case outcomes
with their reference matches, one metric set per check and the `all_checks`
set, one row per slice tag, and the operational totals over all attempts.
`runs` holds one run report per evaluated case, in evaluation order.
`unevaluated_records` counts the records that never ran. `population` keeps
the population facts of the dataset, and `limitations` states the standing
limits of these numbers. `intervals` holds one Wilson score interval per
metric of every scope and slice, each with its method, confidence level,
sampling model, counts, and bounds, or the reason no bound computes.

**Metric rules:** missing labels leave only the metrics that need them. One
case that errored or was skipped stays in the denominator of every rate
whose population holds it, so one operational failure never improves one
rate. One rate with one zero denominator holds `null`. The metric names and
their denominators are fixed in
[contracts/README.md](../../contracts/README.md#evaluation-reports).

**Side effects:** the wrapper reads the two stated paths and executes the
evaluators of the bound profile. It stores nothing.

**Resource limits:** the cases follow each other in record order, one case
at one time. The effective execution configuration of the profile bounds
every case.

**Modes:** every case runs as one shadow run. The operation states no
selected profile hash, requests no scope, and changes no qualification and
no host selection.

**Failure behavior:** one absent or unknown purpose, one reviewer without
one bound profile, one wrong path format, and every dataset contract failure
throw `ValidationError` before any case runs. One empty dataset, one
evaluation where no case ran, and one cancellation before the first case
refuse with `insufficient_evidence` at `/cases`. One cancellation during the
run freezes the report of the case in flight and counts the records that
never ran. One interval request below its minimum draw count states
`insufficient_evidence`, and one sampling assumption that the dataset groups
break states `unsupported_sampling`. The confidence levels 0.9, 0.95, and
0.99 alone are accepted.

## `calibrate`

```ts
import {
  calibrate,
  createJevEvaluator,
  registerEvaluators,
  type Definition,
} from "measuretwice";

declare const definition: Definition;
const call = createJevEvaluator({ call: async () => {
  throw new Error("supply the systemOne call boundary of your host SDK client");
} });

const calibration = await calibrate(definition, {
  plan: ".measuretwice/calibration-plan.json",
  metadata: ".measuretwice/cases/intervention.metadata.json",
  records: ".measuretwice/cases/intervention.jsonl",
  evaluators: registerEvaluators(call),
  sampling: "grouped_cases",
  evaluationReports: ["reports/intervention-fitting.json", "reports/intervention-validation.json"],
});
calibration.profile.qualification.status; // what the evidence established
```

**Inputs:** the definition (trusted import, one artifact, or one explicit
`.json` path), and one options object. The required fields state the plan
path, the two dataset paths, the evaluator registry, the sampling model of
every validation interval, and the storage references of the evaluation
reports that the host keeps. The optional fields state the validation splits
that earlier claims consumed, the profile `id`, the `intendedUse`, execution
overrides, the `signal`, and the injected boundaries.

**Output:** one `Calibration`. `profile` is the signed candidate artifact,
loadable as generated. `fitting` is the fitting report of the bounded search.
`qualification` is the frozen validation on the independent split, or
`undefined` when no feasible candidate exists. `runs` holds one run report
per measured case. `limitations` states the standing limits. The
qualification is `validated_for_scope` only when every declared goal held on
its declared basis, and `insufficient_evidence` or `criteria_not_met`
otherwise. No feasible candidate is one valid result.

**Side effects:** the wrapper reads the stated artifacts, measures every case
of the two splits through the registered evaluator on the same validated
path as one ordinary shadow run, and stores nothing. The long calculations
run on one worker thread, so the Node event loop stays free and no callback
reaches user code. No reference label, tag, or provenance field reaches one
evaluator request.

**Resource limits:** the search covers the permitted candidate family of the
plan, at most 1,024 candidates and 1,048,576 candidate-case decisions. One
grid above the budget refuses with its count, and no silent truncation
occurs.

**Modes:** the measurement runs are shadow runs. The result promotes
nothing: the host reviews the recorded evidence, stores it, and selects one
reviewed content hash through its own code. Enforcement refuses the
candidate until the host selects it.

**Failure behavior:** one absent option, one plan or dataset that fails its
contract, one plan that binds another definition, evaluator, or dataset, and
one calculation above the fitting budget throw `ValidationError` with one
field path before or during the procedure. One evaluator failure on one
measured case refuses with the operational code of the record, because one
stored assessment is missing and no search may invent one. One model alias
that resolved to two versions during the measurements refuses with
`model_resolution_changed`. One aborted `signal` refuses with
`run_cancelled`, and one aborted before the first case with
`cancelled_before_start`.

The retention rule: the profile records the evaluation-report references,
and the host owns that storage. Keep one reviewed copy of the fitting and
qualification reports beside the selected profile. The
[first-run guide](../../README.md#from-exploration-to-reliance) records the
path from exploration to reliance.

## `revise`

```ts
import {
  createJevEvaluator,
  registerEvaluators,
  revise,
  type Calibration,
  type Definition,
} from "measuretwice";

declare const definition: Definition;
declare const prior: Calibration; // the value your calibrate call returned
const call = createJevEvaluator({ call: async () => {
  throw new Error("supply the systemOne call boundary of your host SDK client");
} });

const revision = await revise(definition, {
  prior,
  plan: ".measuretwice/revision-plan.json",
  metadata: ".measuretwice/cases/intervention.metadata.json",
  records: ".measuretwice/cases/intervention.jsonl",
  evaluators: registerEvaluators(call),
  sampling: "grouped_cases",
  evaluationReports: ["reports/intervention-revision.json"],
});
revision.reuse.statement; // what the revision replayed, with its counts
```

**Inputs:** the definition, and one options object that states the stored
prior calibration, the revision plan path, the two dataset paths, the
evaluator registry, the sampling model, and the evaluation-report references.
The optional fields match `calibrate`.

**Output:** one `Revision`. `profile` is one new artifact with its own
content hash; the prior artifact stays unchanged. `fitting` replays the
stored fitting assessments under the revised plan. `qualification` is the
frozen validation, or `undefined` when no feasible candidate exists. `runs`
holds one run report per freshly measured case. `reuse` states the verified
identity of everything the revision replayed. `comparison` states the
concrete cases that the revised policy changes against the prior policy.

**Reuse rules:** one changed question, criterion, schema, projection,
preprocessing, evaluator, adapter, translation, model, or input refuses
before one assessment is replayed, with the compatibility code of the
refused identity. The validation split decides what runs: the holdout the
prior claim consumed replays its stored assessments and declares itself
development data that one new claim cannot reuse, so the candidate states
`insufficient_evidence` with its counts. One fresh split of one later dataset
revision is measured through the registered evaluator. The prior validation
never validates one revised policy.

**Side effects:** the wrapper reads the stated artifacts, measures only the
fresh validation split, and stores nothing.

**Modes:** the measurement runs are shadow runs. The revision promotes
nothing.

**Failure behavior:** the identity refusals above, one prior artifact that
fails its contract, one plan or dataset that fails its contract, and one
calculation above the fitting budget throw `ValidationError` with one field
path. The operational refusals of `calibrate` apply to the fresh
measurements.

## `checkEvidence`

```ts
import { checkEvidence } from "measuretwice";

const check = await checkEvidence(".measuretwice/profiles/intervention.json", {
  plan: ".measuretwice/calibration-plan.json",
  metadata: ".measuretwice/cases/intervention.metadata.json",
  records: ".measuretwice/cases/intervention.jsonl",
});
check.statement; // what the check verified, with its counts
```

**Inputs:** the selected profile (one artifact or one explicit `.json`
path), and one options object that states the retained locations of the
plan, the dataset metadata, and the dataset records.

**Output:** one `EvidenceCheck`. It states the verified identity of the
profile, the definition hash, the retained plan, the retained dataset with
its revision, kind, and record count, every recorded split, the recorded
evaluation-report references, one `statement` of what the check verified,
and the `limitations` of the check.

**Side effects:** the wrapper reads the three stated paths. It reads no
evaluation report, changes no qualification status, and writes nothing.

**What it verifies:** content consistency alone. Every recorded identity
must equal the computed identity of the retained copy, the retained plan
must bind the definition that the profile binds, and the plan and the
dataset must state one consistent calibration. One edited plan, one edited
record, one renamed split, and one revised dataset fail with `hash_mismatch`
at the recorded reference. The check cannot verify the truth of one forged
dataset. Retention of the fitting and qualification reports stays with the
host.

**Failure behavior:** one path that names no accepted format fails with
`unsupported_format`. One profile without calibration evidence refuses with
`missing_field`. One unreadable path throws one ordinary `Error`.

## `exportShadowReviews`

```ts
import { exportShadowReviews, type RunReport } from "measuretwice";

declare const storedReports: readonly RunReport[];

const exported = exportShadowReviews(storedReports, {
  baselineMeanings: { stored: "pass", suppressed: "silent", deferred: "review" },
  sample: { seed: "review-2026-09", agreements: 12 },
});
exported.jsonl; // one review record per line, for the review tool of the host
```

**Inputs:** the stored shadow reports of one definition and one profile, and
one options object. `baselineMeanings` states one meaning for every word of
the host decision vocabulary: `pass`, `fail`, `review`, or `silent`, where
`silent` names one absent decision. `sample` states the seed and the number
of sampled agreements, from 0 to 100000.

**Output:** one `ShadowReviewExport`. It always exports every disagreement,
every report without one baseline, and every report whose candidate
aggregate outcome is an error, and selects the agreements through one
reproducible seeded rank. `records` holds the selected records, `jsonl`
holds them as JSON Lines text, `summary` counts the export, `sampling`
states the seed, the algorithm, the sizes, and the selection rules, and
`limitations` states the standing limits. Every record states the case
identifier, the input hash, the run identifier, the host snapshot reference
when one exists, the recorded baseline with its meaning, the candidate
outcomes, and its selection reason. The export holds no raw case content.

**Side effects:** none. The export reads the supplied reports and writes no
review record. Storage stays with the host.

**Failure behavior:** one absent option, one empty meaning map, one bound
breach of the seed or the sample size, one batch with no report, one
enforcement report, one repeated case identifier, one report of another
definition or another profile, and one baseline word with no stated meaning
throw `ValidationError` before any selection. Baseline agreement stays one
observation: no field of the result states one accuracy or one correctness
claim.

## `validateReviewLabels`

```ts
import { validateReviewLabels, type Definition, type ShadowReviewExport } from "measuretwice";

declare const definition: Definition;
declare const exported: ShadowReviewExport;
declare const returnedLabels: string; // the JSONL text the reviewers returned

const validation = validateReviewLabels({
  definition,
  exported,
  labels: returnedLabels,
});
validation.summary; // the provenance counts of the return
```

**Inputs:** one options object with the definition that owns the meaning of
every check, the review export that the labels answer, and the complete
JSONL return. Each nonempty line holds one `{ case_id, expected, label }`
object for one exported case.

**Output:** one `ReviewLabelValidation`. `labels` holds every validated
label, `summary` counts the provenance that keeps human judgments apart from
model proposals, `findings` flags every reference whose stated outcome
disagrees with the acceptance meaning of its check, and `limitations`
states the standing limits.

**Side effects:** none. The validation reads no case content and no
baseline. One label that contradicts the baseline outcome of its case is one
valid label, because baseline agreement is not correctness.

**Failure behavior:** one absent option, one return with no line, and every
broken label line throw `ValidationError`; one broken line names its line
number and its field path.

## `compare`

```ts
import { compare, type EvaluationReport } from "measuretwice";

declare const baseline: EvaluationReport;
declare const candidate: EvaluationReport;

const comparison = compare(baseline, candidate, {
  baselineReport: "reports/baseline.json",
  candidateReport: "reports/candidate.json",
});
comparison.report.matching.matched_cases; // matched on id and input hash
```

**Inputs:** two stored evaluation-report artifacts and one options object
that names where the host stored each report. The optional `costs` map
states one unit cost per usage key.

**Output:** one `Comparison`. `report` is the comparison artifact;
`JSON.stringify` writes it. `metrics` holds one row per scope and metric,
where each side keeps its numerator and its denominator beside its value.
`limitations` states the standing limits.

**Matching rule:** one case matches only when its identifier and its input
hash agree. One changed input hash never matches. The result lists the
changed-input cases, the cases each side omits, and the matched cases that
hold one error or one skipped component.

**Evidence class:** the declared purposes of the two reports decide it. Both
must state `independent_validation` for one comparison that counts as
independent validation evidence. One fitting evaluation makes the whole
comparison one fitting comparison.

**Tradeoffs:** latency and usage appear only when one report recorded them.
One cost of one side appears only when that report recorded usage and every
recorded key carries one declared cost.

**Side effects:** none. The comparison reads the two artifacts, changes no
qualification, and selects no profile.

**Failure behavior:** one absent option and one absent stored-report
reference throw `ValidationError` before any parse. One artifact that breaks
the evaluation-report contract throws with its field path under `/baseline`
or `/candidate`. Two reports of different definitions throw with
`definition_mismatch`. Two reports that share no case refuse with
`insufficient_evidence` at `/matching`. One broken cost input throws with
its key under `/costs`.

## Renderers

```ts
import {
  renderProfileSummary,
  renderProfileSummaryMarkdown,
  renderRunReport,
  renderRunReportMarkdown,
  type Definition,
  type Profile,
  type RunReport,
} from "measuretwice";

declare const definition: Definition;
declare const report: RunReport;
declare const profile: Profile;

const terminalText = renderRunReport(definition, report);
const markdown = renderRunReportMarkdown(definition, report, { detail: "detail" });
const profileText = renderProfileSummary(profile, { detail: "detail" });
const profileMarkdown = renderProfileSummaryMarkdown(profile);
```

`renderRunReport` renders one frozen run report of one bound definition as
terminal text. `renderRunReportMarkdown` renders the same view as Markdown.
`renderProfileSummary` and `renderProfileSummaryMarkdown` render one profile
artifact. Every renderer is one pure function of validated artifacts: it
reads no clock, opens no file, and calls no evaluator.

The `detail` option selects the two inspection levels. The summary view leads
with the check meaning, the component outcomes, the aggregate outcome with
its explanation, the completion status, and the next useful action. The
detail view adds the executed rules, the raw measurements, the applied
policy, the evaluator versions, the identities with their content hashes,
the counts, the limitations, and one key that defines the terms the view
uses: acceptable and unacceptable mass, the three zones between the two
cutoffs, the shadow mode, and the baseline. The key states one line only
when the report holds the fact that the line explains.

Every explanation comes from the check criteria and the executed policy. No
renderer invents one evaluator rationale. Supplied case content never
renders, because the report holds none. One absent measurement stays absent.

A renderer verifies its inputs before it renders. The definition crosses the
core validator, and its content hash must equal the hash that the report
names. The component outcomes must fold to the stored aggregate outcome. The
profile crosses the core self-hash and the complete profile contract, so one
edited copy fails with `hash_mismatch` instead of rendering as the reviewed
artifact. Every other invalid input throws `ValidationError` with one field
path, before any rendering.

## `contractVersion`

```ts
import { contractVersion } from "measuretwice";

contractVersion(); // 1
```

Returns the portable contract schema version that the Rust core implements.
The v0 contracts use version 1. The function reads the native boundary and
changes nothing.
