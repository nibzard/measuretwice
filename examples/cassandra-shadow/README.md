# Cassandra shadow adapter example

This example shows one application integration. Cassandra runs one memory
path and one intervention path today. measuretwice runs beside both paths in
shadow mode, and the library gains no Cassandra dependency: the application
keeps its records, its rules, and its actions, and the adapter is the only
file that imports the library.

The flow, end to end:

1. Each existing path decides on its own record and takes its action.
2. Each decided proposal hands one job to the queue of the application.
3. One worker drains the queue, runs one shadow assessment per job, and
   stores every report through the storage of the application.
4. The adapter exports the reports that need one human review.

Everything runs offline. Two scripted test evaluators answer from two
tables, so the workflow needs no credential and spends no API budget.

## Files

| File | Content |
| --- | --- |
| [cassandra.ts](cassandra.ts) | The application: the stored records, the channel rules, the two existing decision paths, the actions, the queue, and the storage. It imports no measuretwice module. |
| [records.ts](records.ts) | The synthetic records: five proposed memories, four drafted interventions, and the rules of four channels. |
| [adapter.ts](adapter.ts) | The measuretwice side: the mapping into cases, the baselines, the snapshot references, the profiles, the worker, and the review exports. |
| [host.ts](host.ts) | The run: decisions, actions, the queue, the drain, the saturated replay, the exports, and the printed summary. |
| [tsconfig.json](tsconfig.json) | The TypeScript build of the example. It compiles the two definitions of the other examples beside its own files, because one application imports its trusted definitions through its own build. |

The two definitions come from
[examples/memory-support](../memory-support/checks/memory-support.ts) and
[examples/intervention-review](../intervention-review/checks/intervention.ts).

## What the application keeps

measuretwice assesses and reports. The application keeps every other
responsibility that [MVP_SPEC.md](../../MVP_SPEC.md) section 13 names:

- Permissions and approval mode: the memory path checks the author against
  the memory authors of the channel, and one channel holds one human
  approval mode.
- Attention eligibility and cooldowns: the intervention path checks both
  before it reads its own trigger rule.
- Freshness and citations: each stored message carries its storage time and
  its citation identifier. Both stay in the record.
- Delivery: the application delivers each intervention itself.

No check reads one of these fields, because no case input holds one. One
report authorizes no application action.

## The mapping

The adapter maps one stored record into one case of one definition:

| Record | Definition | Case inputs |
| --- | --- | --- |
| One proposed memory | `memory-support` | `original_sources`, `recent_context`, `candidate_text` |
| One drafted intervention | `intervention-review` | `prior_decision`, `conversation`, `proposed_message` |

The original sources become one text per source: the author, the channel,
the date, and the message. The citation identifiers stay in the record. The
recent context becomes one bounded transcript that keeps the newest messages
first and cuts nothing:

- One message that alone breaks the bound refuses the proposal.
- One history that breaks the bound together drops its oldest messages and
  keeps the newest ones.
- One source set or one candidate that breaks the bound of the input schema
  refuses the proposal. The refusal states the measured length and the
  bound. No text is cut, because one cut would change the meaning that the
  checks assess.

The drafted message holds no mapping bound. The delivery limit of the
application is one exact check of the definition, not one mapping rule, so
one over-length draft reaches its check.

## The baseline and the queue

Each existing path runs before its shadow job. The job carries the decision
word and the path revision: `memory-policy-1` for memories and
`cassandra-policy-1` for interventions. The worker states both as the
baseline of the run, and the report records them beside the new outcome.

`run` is one awaited call, so the decision path never awaits it. The
application owns the queue:

- `enqueue` stores one job and returns. It blocks on nothing and starts no
  work. One full queue refuses the job, so one busy evaluator cannot grow
  the queue without limit.
- `drain` runs every queued job through one worker. This example uses one
  in-process queue. One real deployment binds the same interface to the
  durable queue it already runs.

The library starts no detached job and schedules no work of its own, as
[MVP_SPEC.md](../../MVP_SPEC.md) section 10 states.

## Storage

The worker hands every report and every profile to the storage port of the
application. The library writes no file. One replay needs the stored report
and the snapshot reference of host storage, because no report holds one copy
of the case content. This example writes one directory; one real deployment
writes its tables.

## The outcomes

The scripted evaluators produce one of each outcome beside the unchanged
decisions:

| Proposal | Existing decision | Candidate outcome |
| --- | --- | --- |
| `deploy-freeze-window` | `stored` | Pass |
| `data-region-move` | `stored` | Fail: the sources contradict the candidate. |
| `quiet-hours` | `skipped` | Review: the sources establish no claim. |
| `on-call-rotation` | `skipped` | Error: the scripted answer names one undeclared label. |
| `eu-export-move` | `interrupt` | Pass. |
| `eu-export-already-raised` | `interrupt` | Fail: the discussion acknowledged the concern. |
| `eu-export-cooldown` | `stay-quiet` | Review: the recorded note states no decision. |
| `paging-rule-reminder` | `stay-quiet` | Pass. |
| `incident-log-oversized` | `stored` | No run: the mapping refused the source log. |

The host also replays `eu-export-move` under the smallest execution
configuration. One active check and no queued check produce four `queue_full`
skip records and one review aggregate.

No outcome changed one application action. The example prints the action
ledger before the drain and after the replay, and both state the same five
actions: three stored memories and two delivered interventions. One pass
authorized nothing, and one error, one skip, and one review changed nothing.

## The review export

The adapter exports the stored reports of each definition with the meanings
that the application states for its own decision words: `stored` and
`interrupt` mean pass, and `skipped` and `stay-quiet` mean one silent
baseline. Every disagreement, every report without one baseline, and every
candidate error always reaches one human. One seeded sample of the agreements
keeps the quiet cases auditable. Agreement with the baseline is one
observation, not one accuracy claim.

## Run it offline

Run the example in this repository. The commands read local files only:

1. `npm install`
2. `npm run build`
3. `npx tsc -p examples/cassandra-shadow/tsconfig.json`
4. `node examples/cassandra-shadow/build/cassandra-shadow/host.js`

The host prints the decisions, the gates, the shadow outcomes, the refusal,
the saturated replay, the review counts, and one rendered report. It writes
three profiles and nine reports into `examples/cassandra-shadow/reports/`.
Git ignores that directory.

The suite [packages/measuretwice/test/example-cassandra-shadow.test.ts](../../packages/measuretwice/test/example-cassandra-shadow.test.ts)
compiles and runs the same files. It checks the boundary: the projected
inputs of every evaluator request, the bounded context that cuts nothing,
the recorded baselines and snapshot references, the queue that never blocks,
the host-owned storage with no case content, the review export, and the rule
that no error, no skip, no review, and no pass changes one application
action.

## What one real deployment replaces

- The in-process queue becomes the durable queue of the application, with
  one worker process that drains it.
- The directory storage becomes the tables of the application.
- The scripted evaluators become the Jev adapter, which the application
  registers with its own client and credential. See
  [examples/memory-support](../memory-support/README.md) for the exact
  registration and its costs.
- The synthetic records become the proposals of the application, and the
  exploration profiles become calibrated profiles that the application
  selected through its own review.

## Limits

- The records and the scripted answers are synthetic. No model ran, and
  nothing was measured.
- Nine synthetic proposals support no performance claim, and baseline
  agreement supports no accuracy claim.
- The exploration profiles are explicitly unvalidated. Enforcement mode
  refuses them with `qualification_insufficient` before any case work.
- Collect reviewed cases, calibrate one profile, and keep the shadow runs
  running before any enforcement discussion. See
  [MVP_SPEC.md](../../MVP_SPEC.md#13-cassandra-pilot-and-benchmark) for the
  pilot that this example serves.
