# Formal-model applicability verification

Status: completed on 25 September 2026 by task T078. This record reports one
executed verification of the two published TLA+ models against the
implemented state behavior, the correspondence it confirmed, the
correspondence it found limited, and the decision it owes the release audit.

[AGENTS.md](../../AGENTS.md#7-use-tla-for-critical-state-behavior) section 7
requires each model to map to the code and to name the behavior it omits.
[MVP_SPEC.md](../../MVP_SPEC.md#5-typescript-integration-and-shared-rust-core)
sections 5, 8, and 12 define the two boundaries that the models cover.
[research/05](../../research/05-formal-verification-extension.md#6-the-hardest-issue-is-the-one-the-text-emphasizes-correspondence)
section 6 states the chain that this task walked:

```text
Formal property -> Formal model -> Production implementation
```

A checked model establishes the middle relationship only. This record states
what the last relationship covers, and what it does not.

## Method

1. Read every transition of
   [models/execution/Execution.tla](../../models/execution/Execution.tla) and
   [models/qualification/Qualification.tla](../../models/qualification/Qualification.tla)
   against the code that owns it: `measuretwice_core::run_state` and
   `measuretwice-node` for the execution boundary, `packages/measuretwice`
   `scheduler.ts`, `run.ts`, `evaluate.ts`, `calibrate.ts`, and `revise.ts`
   for the wrapper, and `measuretwice_core::profile` and `qualification` for
   the admission boundary.
2. Listed every implementation change to those files since each record was
   last updated, and sorted it into one modeled transition, one omitted
   behavior, or one payload change.
3. Reran the three declared TLC configurations with the pinned tools and the
   recorded commands, and compared the state counts with each record.
4. Recorded the excluded behavior and the limits below. Nothing below claims
   that a checked model proves the implementation.

## Execution model

Status: applicable. The module is unchanged since the record was last
updated, and every transition still has one implementation owner.

| Transition | Implementation today | Result |
| --- | --- | --- |
| `SubmitStart`, `StartRetry` | `RunState::start_attempt` in `crates/measuretwice-core/src/run_state.rs`, started by `startAttempt` in `packages/measuretwice/src/scheduler.ts`. The guard checks the phase, the place, the attempt budget, and the four identity fields of the run binding. | Matches. |
| `SubmitDrift`, `RetryDrift` | The same method refuses one offered case identifier, case input hash, profile identifier, or profile content hash that differs from the run binding. The refusal changes no state. | Matches. |
| `SubmitQueued` | The admission loop of `scheduleRun` queues work while active slots are busy, and counts only never-started work through `neverStarted`. | Matches. |
| `SubmitSkipped` | `RunState::skip_queue_full` records `skipped` with reason `queue_full` for work that never started. | Matches. |
| `AttemptFail` | `RunState::fail_attempt` returns `RetryQueued` while attempts remain and records the error when the budget is spent. `RunState::fail_permanent` records the permanent branch. The wrapper picks the branch through `isRetryableFailure`. | Matches. |
| `AcceptResult` | `RunState::accept_result` validates the check, the kind, the active attempt, and the semantic outcome. | Matches. |
| `DuplicateResult` | The same method refuses one result without an active attempt with `invalid_state_transition`. | Matches. |
| `LateResult` | The same method refuses one result after a terminal phase with `late_result_rejected`. The wrapper drops the resolution and emits the `late_result_rejected` event. | Matches. |
| `Cancel`, `Deadline` | `RunState::cancel` and `RunState::deadline`, stated by `terminate` in the wrapper. Active work records the error, never-started work records the skip, and completed records stay. | Matches. |
| `Complete` | `RunState::complete` requires one record for every check and freezes the report. | Matches. |

Changes since the record was last updated by task T034, reviewed one by one:

- Task T036 added sanitized reasons. Record payloads stay outside the model.
- Task T038 added the shadow baseline. It is report data that the constructor
  validates and that no transition reads, so the model needs no variable for
  it.
- Task T050 fixed the admission loop of `scheduleRun`: one run that ends
  during admission admits no further check. This moved the wrapper closer to
  the model, because every admission transition already carries the guard
  `phase = "running"`. Before the fix, the wrapper offered one refused
  crossing after a terminal event. The suite holds the case as
  `one abort inside the first attempt stops the admission loop` in
  `packages/measuretwice/test/scheduler.test.ts`.
- Tasks T050 and the revision workflow measure calibration and validation
  splits through the same `scheduleRun` path. Each measured case is one run
  of one case, which is the unit the model covers. The sequence of many runs
  stays an omitted behavior.

## Qualification model

Status: applicable. The module is unchanged since the record was last
updated, and every transition still has one implementation owner.

| Transition | Implementation today | Result |
| --- | --- | --- |
| `PublishStarter` | `createExplorationProfile` in `packages/measuretwice/src/exploration.ts` records one `unvalidated` artifact with reason `starter_policy`. | Matches. |
| `Qualify` | `measuretwice_core::qualification::qualify_candidate` computes the status of one frozen candidate on the validation split. `calibrate` and `revise` both end in this step. | Matches. |
| `RunEvaluation` | `evaluate` runs every record of the dataset as one shadow run of the bound reviewer. It states no selection and requests no enforcement. | Matches. |
| `RunShadow` | Shadow mode in `run.ts` admits any compatible profile and records the outcome beside the stated baseline. | Matches. |
| `RunEnforcement` | `check_enforcement_gate` in `crates/measuretwice-core/src/profile.rs` applies the clauses in the recorded order: scope, then qualification, then selection. `run.ts` repeats the complete compatibility check in enforcement mode before any case work. | Matches. |
| `RefuseRun` | Typed rejections with the registry codes, before any evaluator runs. | Matches. |
| `HostSelect`, `HostDeselect` | The host states `RunOptions.selectedProfileHash` per enforcement run. The library holds no selection state. | Matches. |
| `HostAuthorize`, `HostRevoke` | Host code alone. No report, profile, or library step grants an application action. | Matches. |
| `ModelDrift` | The live-binding comparison in `check_live_bindings` refuses one changed resolution with `model_resolution_changed`. | Matches with one limit below. |

Changes since the record was last updated by tasks T049 and T050, reviewed
one by one:

- Task T051 added the retained-evidence check, `check_evidence` in
  `crates/measuretwice-core/src/profile.rs`. It reads the retained plan,
  dataset metadata, and dataset records of one selected profile, compares
  every recorded identity with the computed identity, and changes nothing.
  It is one read-only verification, so it adds no modeled transition. It
  narrows the omitted behavior named "artifact integrity": the model still
  does not cover it, and the check verifies content consistency, not the
  truth of one forged dataset.
- The revision boundary, `measuretwice_core::revision` with the `revise` API
  in `packages/measuretwice/src/revise.ts`, added the policy-only path. It
  maps to transitions that the model already holds:
  `check_revision` refuses one changed definition, evaluator, adapter,
  translation, model resolution, preprocessing identity, or input before any
  replay, which is the `RefuseRun` side of the compatibility clauses. The
  replay itself runs no evaluator and changes no artifact, so no run step
  exists and `RunsDoNotPromote` cannot fire. The revision ends in `Qualify`
  for one new artifact. One consumed validation split is development data,
  so `validation_evidence` and `decide_status` in
  `crates/measuretwice-core/src/qualification.rs` return
  `insufficient_evidence` whatever the replayed numbers say, and
  `check_prior_claimed_validation` refuses one stated calibration that drops
  its validation measurements. One revision on one fresh split measures it
  through the same shadow admission and the same run boundary as one
  ordinary run. The suite holds the consumed-split case as
  `one consumed holdout never validates one revised policy` in
  `packages/measuretwice/test/revise.test.ts`.
- The slice intervals of `qualify_candidate` now come from the interval entry
  of each slice alone. That is one statistical refinement inside `Qualify`,
  not one state change.

## Checks run

Run from the repository root on 25 September 2026.

| Item | Value |
| --- | --- |
| TLA+ tools | `tla2tools.jar` from GitHub release v1.7.4 |
| TLC | TLC2 version 2.19 of 08 August 2024, revision `5a47802` |
| Java | OpenJDK 21.0.12.1, Linux x86-64 |
| Command | See [models/README.md](../../models/README.md) |

| Configuration | States generated | Distinct states | Depth | Result |
| --- | --- | --- | --- | --- |
| `Execution.cfg` | 6,225 | 2,024 | 13 | No error. All invariants and `RunTerminates` hold. |
| `ExecutionSaturation.cfg` | 15,840 | 4,300 | 11 | No error. All invariants and `RunTerminates` hold. |
| `Qualification.cfg` | 4,760,528 | 211,024 | 14 | No error. All invariants hold. |

Every count matches the published record, so the modules and the
configurations that this task read are the ones that TLC checked. Each run
reported zero states left on the queue, so the exploration finished. Nothing
here is inconclusive.

`RunTerminates` holds under the weak fairness that the execution record
states. The implementation provides no formal fairness: it relies on the
Node event loop, the armed wake-ups, and the abort listeners. The scheduler
suite drives those mechanisms with one controlled clock, and task T077
verified the terminal paths adversarially. Termination is therefore tested,
not proved.

## Limited correspondence

- The `ModelDrift` transition of the qualification model writes one demotion
  into the profile state. The implementation writes no state, because the
  library never edits one host file. The implemented barrier is the
  compatibility refusal, which fires in shadow and evaluation as well as
  enforcement, and again on every enforcement run. One stale artifact
  therefore keeps its recorded `validated_for_scope` text while it cannot
  run. The host sees one refusal, not one rewritten profile. The model's two
  independent barriers appear in the implementation as one barrier that
  covers more modes.
- The qualification model holds one selected slot in library state. The
  implementation holds no selection state at all. The host states one hash
  per enforcement run, so no library selection can go stale, and the model
  clause `selected = p` became the `profile_not_selected` refusal.
- Both models serialize their steps. The wrapper interleaves the attempts of
  one run on the event loop and may run several runs at one time. Each run
  keeps its own `RunState` value and its own queue, and the Rust boundary
  refuses one event that names a check outside its run. Cross-run scheduler
  sharing stays outside both models.
- The models stop at state validity. Report payloads, usage, timing,
  statistics, artifact parsing, canonical hashes, profile origins, and the
  retained-evidence check are excluded. The ordinary suites own them.
- Refused events are counted in the models and recorded by kind in the
  implementation.

A checked model does not prove that the implementation matches it. The
mapping tables above are one manual review that this record freezes. The
behaviors themselves stay held by the Rust and TypeScript suites, the shared
runtime traces, and the repository check
[tests/repo/models.test.ts](../../tests/repo/models.test.ts), which keeps
each record tied to its module and its configuration offline.

## Counterexamples and regression tests

The three runs produced no counterexample, so this task adds no new
regression test. The negative controls of both records already became
regression scenarios in earlier tasks, and the two behaviors that this
review rechecked against the models are covered:

- The admission fix of task T050: `one abort inside the first attempt stops
  the admission loop` in `packages/measuretwice/test/scheduler.test.ts`.
- The consumed holdout of the revision path: `one consumed holdout never
  validates one revised policy` in `packages/measuretwice/test/revise.test.ts`.

## Release-audit integration

Decided by this task, as [models/README.md](../../models/README.md) and
[TESTING.md](../../TESTING.md) record:

- Continuous integration keeps not running TLC. The jar is not part of the
  repository, and the ordinary checks must read local files only.
- The release audit of task T079 reruns the three recorded commands on one
  machine with Java 21 and the pinned jar, compares the state counts with
  the records, and records the result. A count that differs, one timeout, or
  one incomplete exploration is inconclusive and blocks the audit.
- The repository check `tests/repo/models.test.ts` stays the offline guard
  between audits.

## Limits

- The bounds stay small: two or three checks, one or two profiles, refusal
  caps of two or three. No larger configuration ran, so the models say
  nothing about state spaces beyond the recorded bounds.
- The verification read the implementation as it stands in the working tree
  of 25 September 2026. One later change to a modeled transition needs a new
  record entry, as section 8 of each record requires.
- The correspondence review is manual. No tool checks that a Rust method
  still implements one named transition. The regression tests named in each
  record are the executable part of that mapping.
