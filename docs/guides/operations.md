# Runtime operation and retention guide

Status: Guide for the implemented v0 package. Published on 25 September
2026.

This guide documents what happens while one run executes, and what you keep
after it ends. Read it when you move from one calibrated profile to one
integration that serves real traffic. Every behavior in this guide is
implemented.

The complete picture fits one rule. The library measures and reports, and
your application owns everything else. The library bounds one run, keeps
every failure visible, and returns one frozen report. Your application owns
the credential, the queue, the storage, the retention, the permissions, and
the delivery.

Related references:

- The [API reference](../reference/api.md) records every operation with its
  inputs, its limits, and its failure behavior.
- The [artifact reference](../reference/artifacts.md) records the published
  schemas and the reason codes.
- [contracts/README.md](../../contracts/README.md) owns the portable
  contracts, the
  [outcome and status distinctions](../../contracts/README.md#outcome-and-status-distinctions),
  and the
  [private data defaults](../../contracts/README.md#private-data-defaults).
- The [calibration and selection guide](calibration.md) owns the journey from
  reviewed cases to one selected profile hash.
- [examples/cassandra-shadow](../../examples/cassandra-shadow/README.md)
  shows one complete integration with one host-owned queue and storage.
- [MVP_SPEC.md section 12](../../MVP_SPEC.md#12-runtime-boundaries) states
  the runtime boundaries that this guide explains.

## What one run does

One run assesses one case:

1. `load` validates the definition, verifies the stored profile hash, and
   checks the binding against the registered evaluators.
2. `run` validates the case against the input schema of the definition. One
   invalid case refuses before any work starts.
3. The Rust core projects the inputs that each `using` list authorizes. No
   request carries one more field.
4. Exact rules execute inside the Rust core.
5. Question checks execute through the scheduler, inside the execution
   limits of the profile.
6. The core validates every returned assessment and decides it under the
   recorded policy.
7. One terminal transition freezes the report. The wrapper returns it, and
   your application stores it.

`load` reads the paths you state. One run reads no file and writes no file.
The wrapper holds no state between runs, and one adapter holds no state
between calls.

## 1. The bounds of one run

The effective execution configuration of the profile bounds one run. Five
limits apply:

| Limit | Bound | Effect when reached |
| --- | --- | --- |
| `max_active` | Integer of at least 1 | Further checks wait in the queue. |
| `max_pending` | Integer of at least 0 | One further check records one `skipped` outcome with `queue_full`. |
| `deadline_ms` | Integer of at least 1 | The run ends with `deadline_exceeded`. Completed components stay. See [terminal states](#3-failures-inside-one-report). |
| `max_attempts` | Integer from 1 to 10 | The check records `retries_exhausted` with the last reason. |
| `backoff_ms` | Integer of at least 0 | One bounded delay inside the total deadline. |

Four rules explain how the limits work together:

- One total deadline covers the complete attempt lifecycle: queue time,
  every attempt, and the backoff between attempts. The deadline ends the run
  even while one backoff waits.
- Only work that never started counts against `max_pending`. One retry of
  started work shares the queue and consumes no pending slot.
- One run assesses one case. Your application bounds how many runs it starts
  at one time. `evaluate` runs its cases one at one time, in record order,
  under the same limits.
- The starter configuration of one exploration profile is `max_active` 4,
  `max_pending` 16, `deadline_ms` 30000, `max_attempts` 2, and `backoff_ms`
  200. The derived exact profile uses the same bounds with one attempt and
  no backoff. One calibration profile records the configuration that its
  plan declared.

State your own bounds when you generate the profile:

```ts
import {
  createExplorationProfile,
  type EvaluatorRegistry,
} from "measuretwice";
import { intervention } from "./.measuretwice/checks/intervention.js";

declare const registry: EvaluatorRegistry;

const profile = createExplorationProfile(intervention, registry, {
  execution: { max_active: 2, max_pending: 8, deadline_ms: 5000 },
});
```

`calibrate` and `revise` accept the same `execution` option. One bound that
breaks its range refuses with `invalid_field_type` before any work starts.

### Oversized input

Three limits refuse large input instead of truncating it:

- The input schema of the definition bounds each input. One case outside its
  schema refuses with `invalid_field_type` and one field path, before any
  evaluator runs.
- The Jev adapter counts the serialized projected state plus the serialized
  question in UTF-8 bytes. One request above 32,000 bytes is rejected before
  the provider call with `oversized_input`. Nothing is cut, and the message
  states the measured size.
- The dataset loader refuses one record line above 8,388,608 bytes, one
  records file above 536,870,912 bytes, and more than 100,000 records, each
  with `oversized_input`.

Bound your inputs in the definition schema, because that refusal names the
field and costs no attempt. One adapter rejection inside one run is one
execution failure: with one attempt configured, the record states
`evaluator_error` and the message that names `oversized_input`; with retries
configured, the final record states `retries_exhausted` and names the last
code. Set `max_attempts` to 1 when you prefer the direct code.

## 2. Retries, backoff, and cancellation

The retry policy lives in the wrapper scheduler. One retryable failure
crosses the Rust boundary first, then waits one bounded backoff, then rejoins
the shared queue. The reason code alone names the class:

| Class | Codes | Behavior |
| --- | --- | --- |
| Retryable | `evaluator_error`, `evaluator_timeout` | The check retries while attempts remain. |
| Permanent | `invalid_assessment` | The check records its error at the failing attempt, whatever attempts remain. |

One answer outside the contract of its check is one defect of the adapter
path. One retry would return through the same path, so no retry starts, and
the record keeps the true attempt count. The provider retry loop is disabled
inside the Jev adapter, so one wrapper attempt is one provider request and
hidden retries cannot multiply your spend.

The backoff is deterministic and bounded:

1. The first retry waits `backoff_ms`.
2. Every later retry doubles the delay.
3. The attempt limit bounds the doubling.
4. The total deadline bounds the wait. One delay that reaches past the
   deadline instant never starts, because the deadline ends the run first.

The delay states no jitter, so one run stays replayable. One base delay of
zero restarts the attempt when one slot frees.

### Cancellation

Pass one `AbortSignal` to cancel one run. Cancellation is supported at every
level: the run, one evaluation, one calibration, and one revision. One
aborted signal stops every in-flight adapter, clears the queue, disarms every
pending backoff, and freezes the report with completion status `cancelled`.

```ts
import { load, type CaseInput, type EvaluatorRegistry } from "measuretwice";
import { intervention } from "./.measuretwice/checks/intervention.js";

declare const registry: EvaluatorRegistry;
declare const proposal: {
  readonly id: string;
  readonly input: CaseInput<typeof intervention>;
};

const reviewer = await load(intervention, {
  profile: ".measuretwice/profiles/intervention.json",
  evaluators: registry,
});

const controller = new AbortController();
setTimeout(() => controller.abort(), 2500).unref();

const report = await reviewer.run(
  { id: proposal.id, input: proposal.input },
  { mode: "shadow", signal: controller.signal },
);
report.completion.status; // "completed", "cancelled", or "deadline_exceeded"
```

Every terminal path releases the wrapper resources. The scheduler drops its
queue, disarms its wake-up, and removes its listener on your signal, so no
adapter keeps one listener after the run ends.

## 3. Failures inside one report

Every defined check appears in `checks`. The library runs every check, and no
cost-based short-circuiting exists. One failing check never hides one error
of its sibling, and one skip never hides one review.

| Outcome | Meaning | Your handling |
| --- | --- | --- |
| `pass` | The assessment meets the acceptance meaning under the profile. | Consume the report as one input to your decision. |
| `fail` | It meets one unacceptable meaning. | Consume the report. |
| `review` | The evidence supports no automatic decision. | One person decides. |
| `error` | Execution or validation of this check failed. | Treat as one operational failure. Never one pass. |
| `skipped` | The check was not attempted. The reason states why. | One person decides, the same way as one review. |

The aggregate outcome folds in one fixed order: any `fail` gives fail,
otherwise any `error` gives error, otherwise any `review` or `skipped` gives
review, otherwise pass. `completion` stays separate: one run completes, is
cancelled, or exceeds its deadline.

### Terminal states

| Terminal path | In-flight attempt | Check that never started | Completed record |
| --- | --- | --- | --- |
| `completed` | The check resolved with its record. | None. | Kept. |
| `cancelled` | `error` with `run_cancelled`. | `skipped` with `cancelled_before_start`. | Kept. |
| `deadline_exceeded` | `error` with `deadline_exceeded`. | `skipped` with `deadline_before_start`. | Kept. |

One report in one terminal state is immutable. One result that arrives after
the terminal transition changes nothing: the scheduler drops it and states
`late_result_rejected`, so one adapter that ignores your signal cannot mutate
one frozen report.

### Sanitized reasons

One `error` or `skipped` record carries one sanitized reason: one stable
code, one field path when one validation failed, and one short cause of at
most 500 characters. What stays and what never enters:

| Kept | Never enters |
| --- | --- |
| The raw assessment, the applied policy, the evaluator versions, the attempt count, the timing, the usage. | Raw case content. One report names the case by identifier and input hash alone. |
| The operational cause: the code, the attempt count, the last failure. | Credentials. |
| The class, the status, and the request identifier of one thrown provider error. | The provider message, the response body, and the headers, because each can echo case content. |

One hostile provider error that quotes your case content crosses as its
class, its status, and its request identifier, and the record keeps its
operational cause. Failures stay useful after sensitive content is removed.
Read the complete registry in
[stable reason codes](../../contracts/README.md#stable-reason-codes).

## 4. What the host owns

| Responsibility | Rule |
| --- | --- |
| Credentials | Your client owns them. The Jev adapter reads no credential, and the command-line interface (CLI) reads no credential option and no credential variable. Profiles hold none: one stored profile with one credential field fails `load` with `unknown_field`. |
| Evaluator registration | You register evaluators through code you review. One loaded file installs no evaluator, and one embedded instruction inside supplied evidence stays one string value that reaches no permission and no tool. |
| Storage | The wrapper persists no report. The writer of one report is your application. The wrapper reads the paths you state and writes nothing. |
| Snapshots | You store the case input and state one reference of 1 to 256 characters through the `snapshot` option. The report records it as `case.snapshot`. Replay needs the stored report and this reference, because no report holds one copy of the case content. |
| Retention | Retention of reports and of sensitive metadata is your decision. Keep the evidence of one selected profile for as long as you rely on it. |
| Permissions and delivery | Permissions, approval modes, attention eligibility, cooldowns, freshness, citations, and delivery stay in your code. One passing report authorizes no application action. |
| Datasets | Calibration and evaluation read the explicit local files you state. Nothing collects case content on its own. |

State the snapshot beside the baseline of each shadow run:

```ts
import type { Reviewer, RunReport, ShadowBaseline } from "measuretwice";

declare const reviewer: Reviewer<Record<string, unknown>>;
declare const proposal: { readonly id: string; readonly input: Record<string, unknown> };
declare function storeCaseSnapshot(id: string, input: unknown): Promise<string>;
declare function storeReport(report: RunReport): Promise<void>;

const baseline: ShadowBaseline = { outcome: "stored", revision: "policy-7" };

// Your storage keeps the input, the report names the reference, and one
// later replay reads both.
const snapshot = await storeCaseSnapshot(proposal.id, proposal.input);
const report = await reviewer.run(
  { id: proposal.id, input: proposal.input },
  { mode: "shadow", baseline, snapshot },
);
await storeReport(report);
```

## 5. Shadow latency and the durable queue

`run` is one awaited call. It returns when the run reaches one terminal
state, so its added latency stays inside the total deadline of the profile.
Each question record states its queue wait (`queued_ms`) and its execution
time (`execution_ms`), so one slow run shows where the time went.

The library starts no detached job and owns no background scheduler. Route
nonblocking shadow work through one queue that your application owns:

```ts
import type { Reviewer, RunReport } from "measuretwice";

// One job record of your queue. Your decision path writes it and returns.
interface ShadowJob {
  readonly case_id: string;
  readonly snapshot: string;          // where your storage holds the input
  readonly baseline_outcome: string;  // what your path already decided
  readonly baseline_revision: string;
}

declare const reviewer: Reviewer<Record<string, unknown>>;
declare function enqueue(job: ShadowJob): boolean; // false when the queue is full
declare function readCaseSnapshot(snapshot: string): Promise<Record<string, unknown>>;
declare function storeReport(report: RunReport): Promise<void>;

// One worker of your queue owns the awaited call. One worker at one time
// bounds your spend, and one bounded queue bounds your backlog.
async function runOne(job: ShadowJob, signal: AbortSignal): Promise<void> {
  const input = await readCaseSnapshot(job.snapshot);
  const report = await reviewer.run(
    { id: job.case_id, input },
    {
      mode: "shadow",
      baseline: { outcome: job.baseline_outcome, revision: job.baseline_revision },
      snapshot: job.snapshot,
      signal,
    },
  );
  await storeReport(report);
}
```

Four rules keep the queue honest:

- `enqueue` stores one job and returns. It blocks on nothing and starts no
  work. One full queue refuses the job, so one busy evaluator cannot grow
  the queue without limit.
- Your decision path decides first, then states its own decision as the
  baseline. No library code reads the baseline, compares the two outcomes,
  or acts on either.
- One shadow error, skip, review, or pass changes no stored decision. Your
  decision path keeps its authority.
- Agreement with the baseline is one observation, not one accuracy claim.
  Export the disagreements and one seeded sample of agreements through
  `exportShadowReviews`, and audit the baseline passes and the silent
  decisions too.

[examples/cassandra-shadow](../../examples/cassandra-shadow/README.md) runs
this pattern end to end, and its
[replacement section](../../examples/cassandra-shadow/README.md#what-one-real-deployment-replaces)
names what one real deployment replaces: the in-process queue becomes your
durable queue, the directory storage becomes your tables, and the scripted
evaluators become the Jev adapter with your client.

## 6. Requalification and retained evidence

One selected profile carries the evidence that justified it. When one
material identity changes, the qualification ends, and no hash alone can
detect one population change:

| Change | What happens |
| --- | --- |
| Question wording, criteria, schema, or projection | One new definition hash. The prior profile refuses `load` with `definition_mismatch`. |
| Evaluator code, adapter version, or translated question | The prior profile refuses with `evaluator_mismatch` or `translation_mismatch`. |
| One model alias that resolves to another version | The report records the resolved version that answered. One alias that resolved to two versions during one measurement refuses with `model_resolution_changed`. Request one versioned identifier, never one alias. |
| Preprocessing that affects assessments | The compatibility check refuses. The profile records the preprocessing identity of every binding. |
| Policy parameters alone | `revise` replays the stored fitting assessments under one revised plan. One new qualification claim needs fresh independent validation. |
| Intended scope or population | New evidence for the new scope is required. The enforcement gate refuses one wrong scope with `scope_mismatch`. |

The [calibration and selection
guide](calibration.md#what-ends-one-qualification) owns the complete table
and the criteria for fresh validation evidence.

Retained references close the loop:

1. One calibration profile records its plan, its datasets, its splits, its
   label provenance, its statistical method, and its evaluation-report
   references. Each reference names storage that your application manages.
2. State where you keep the evaluation reports through the
   `evaluationReports` option of `calibrate` and `revise`.
3. Verify the retained artifacts against the recorded identities with
   `checkEvidence`. One edited plan, one edited record, and one renamed split
   fail with `hash_mismatch` at the recorded reference. The check reads no
   report file, so the report copies stay under your own review.
4. Keep one reviewed copy of the fitting report and the qualification report
   beside the selected profile. One folder that version control ignores
   holds no required copy.
5. Keep the complete evidence set for as long as you rely on the profile.
   One later dispute reads the evidence, not one summary.

## 7. Four claims that stay distinct

No number substitutes for another. Keep these four apart in every report you
write and every dashboard you build:

| Claim | What it is | What it is not |
| --- | --- | --- |
| Provider confidence | One optional measurement that one adapter reported. It enters one assessment as data. | Not one measured correctness. One confidence floor may abstain, and one evaluated procedure alone can support one probability claim. |
| Measured correctness | One rate of one evaluation report, with its counts, its denominator, and its interval. | Not one property of one single report, and never one provider output. |
| Source completeness | One fact about your retrieval: whether the supplied inputs cover the case. | Not established by one passing check. One assessment binds to the inputs it received, and one missing source changes no outcome by itself. Multiple checks that read the same sources are not independent evidence. |
| Application authorization | One decision of your application: permissions, approvals, delivery. | Never granted by one report, one profile, or one qualification flag. |

Read the complete eight-row table of
[outcome and status distinctions](../../contracts/README.md#outcome-and-status-distinctions).

## Checklist before you rely on one integration

1. The execution limits of the profile match the latency and the spend your
   traffic tolerates, and you stated them yourself.
2. Your integration handles all five outcomes, the two other completion
   states beside `completed`, and every operational reason code it can meet.
3. One `error` and one `skipped` component never become one pass, and one
   `review` and one `skipped` outcome both reach one human decision.
4. Your decision path writes one queue job and returns. One worker owns the
   awaited call, and one full queue refuses work instead of growing.
5. Your storage holds the case snapshots, the reports, and the reviewed
   qualification evidence, and `checkEvidence` passes beside the selected
   profile.
6. Credentials live in your credential mechanism alone, and no profile and
   no report carries one.
7. No code path delivers, permits, or approves anything because one report
   passed.
