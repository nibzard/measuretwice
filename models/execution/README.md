# Execution-state model record

Model: [Execution.tla](Execution.tla). Checked on 23 September 2026.

Status: **complete**. Both configurations finished with no error. The
recorded negative control fails as expected.

This record follows the seven steps that [AGENTS.md](../../AGENTS.md)
section 7 requires for each formal model. The model covers the
execution-state boundary that [MVP_SPEC.md](../../MVP_SPEC.md) section 5
defines. Task T007 publishes it before task T015 implements the Rust
state validation.

## 1. Property, assumptions, and boundary

The model covers one run of one case against one fixed definition. It
answers four concrete risks:

| Risk | Checked invariant |
| --- | --- |
| The scheduler starts more work than the limit permits. | `ActiveWithinLimit`, `FreshPendingWithinLimit`, `AttemptsBounded` |
| A retry switches the case input or the profile binding. | `AttemptBindingStable` |
| An error or a skipped check later reports a pass. | `NoErrorSkipToPass` |
| A late or duplicate result changes a terminal report. | `TerminalReportFrozen`, `TerminalRecordsComplete` |

Safety invariants also include `TypeOK` and `StatePartition`. One
progress property, `RunTerminates`, is checked with explicit fairness.

Assumptions:

- Every transition passes the Rust state boundary. A transition guard is
  the Rust validation. The wrapper cannot change run state directly.
- The run binding is fixed at submit. The case input identity and the
  profile identity are opaque values. Each has one correct run value.
- The environment may deliver results, failures, cancellations,
  deadlines, and wrong bindings in any order and at any time.
- Time is an environment event, not a clock. One `Cancel` or one
  `Deadline` event ends the run. See the omitted behavior below.

Boundary: the model stops at state validity. It does not model input
projection, policy numbers, evaluator internals, or report payloads.

## 2. State variables and transitions

| Variable | Meaning |
| --- | --- |
| `phase` | `running`, `completed`, `cancelled`, or `deadline`. |
| `unadmitted` | Checks the scheduler has not admitted yet. |
| `waiting` | Admitted work without an active slot. Fresh work and retrying work share it. |
| `active` | Checks with one attempt in flight. |
| `attempts` | Started attempts per check, counting the first attempt. |
| `attemptCases`, `attemptProfiles` | Case input and profile identity of the latest started attempt. |
| `records`, `reasons`, `locked` | Recorded outcome per check, its reason code, and its sealed flag. |
| `rejections` | Count of refused events. |
| `finalRecords`, `finalReasons`, `finalAggregate`, `finalCompletion` | Report snapshot taken at termination. |

Transitions:

| Transition | Effect |
| --- | --- |
| `SubmitStart` | A free active slot admits new work. The attempt binds the run identities. |
| `SubmitDrift`, `RetryDrift` | The wrapper offers a wrong binding. The boundary refuses the start. |
| `SubmitQueued` | All active slots are busy, so new work waits. |
| `SubmitSkipped` | No active and no pending slot is free. The check records `queue_full`. |
| `StartRetry` | A waiting check starts its next attempt with the run binding. |
| `AttemptFail` | With attempts left, the check returns to the queue. Otherwise it records an error. |
| `AcceptResult` | An active attempt records a semantic outcome. |
| `DuplicateResult` | A result arrives without an attempt in flight. It is refused. |
| `LateResult` | A result arrives after a terminal state. It is refused. |
| `Cancel`, `Deadline` | The run ends. Active work records an error, waiting work records a skip. |
| `Complete` | Every check has a record. The run completes and takes the snapshot. |

Design decision from the model: only never-started work counts against
`max_pending`. A retry of in-flight work is not new work, so it does not
consume a pending slot. The wrapper tasks T030 and T032 must implement
this rule. The runtime traces in
[fixtures/runtime/traces.json](../../fixtures/runtime/traces.json)
agree: retries proceed while the queue holds no fresh work.

## 3. Safety and progress

TLC checked all invariants and the progress property. The fairness
assumptions are:

- Weak fairness on `SubmitStep(c)` for each check: admission proceeds.
- Weak fairness on `StartStep(c)` for each check: queued work starts.
- Weak fairness on `Resolve(c)` for each check: an active attempt
  receives a result or fails.
- Weak fairness on `Complete`: a drained run completes.

`Cancel`, `Deadline`, and the refused events are adversarial. They carry
no fairness. Under these assumptions, `RunTerminates` holds: the run
reaches a terminal phase and every check receives a record.

## 4. Tool version, configuration, and bounds

| Item | Value |
| --- | --- |
| TLA+ tools | `tla2tools.jar` from GitHub release v1.7.4 |
| TLC | TLC2 version 2.19 of 08 August 2024, revision `5a47802` |
| Java | OpenJDK 21.0.12.1, Linux x86-64 |
| Command | See [models/README.md](../README.md) |

Run each configuration from the repository root:

```sh
java -Xmx4g -XX:+UseParallelGC -cp <tla2tools.jar> tlc2.TLC \
  -deadlock -nowarning \
  -config models/execution/Execution.cfg models/execution/Execution.tla
```

The `-deadlock` flag is required. A terminal report intentionally has no
outgoing transition, so TLC would report an expected deadlock.

Bounds:

| Configuration | NumChecks | MaxActive | MaxPending | MaxAttempts | Explores |
| --- | --- | --- | --- | --- | --- |
| [Execution.cfg](Execution.cfg) | 2 | 1 | 1 | 2 | Queueing, retries, cancellation, deadlines, late and duplicate results. |
| [ExecutionSaturation.cfg](ExecutionSaturation.cfg) | 3 | 1 | 0 | 1 | `queue_full` skips under saturation and single attempts. |

The environment offers two case identities and two profile identities.
The run binding is `case-x` with `profile-a`. Any of the three other
combinations may be offered to a starting attempt. Refused events are
capped at three, which keeps the reachable state set finite.

## 5. Results

| Configuration | States generated | Distinct states | Depth | Result |
| --- | --- | --- | --- | --- |
| `Execution.cfg` | 5,213 | 1,680 | 13 | No error. Invariants and `RunTerminates` hold. |
| `ExecutionSaturation.cfg` | 15,840 | 4,300 | 11 | No error. Invariants and `RunTerminates` hold. |

Completion status: complete. TLC explored the full state space in both
configurations. A checked model does not prove that the implementation
matches it.

Negative control: a mutated module let `StartRetry` store the offered
identities instead of the run identities. TLC reported a violation of
`AttemptBindingStable` after four states. The counterexample shows a
retry that binds `case-y`. The invariants therefore detect binding drift.

## 6. Counterexamples and regression tests

The checked model produced no counterexample. The negative control above
produced one by construction. Task T015 must turn that scenario into a
failing Rust regression test: a retry with a changed case input or
profile identity must be refused. The runtime traces
`retry-then-success`, `late-result-after-completion`,
`late-result-after-cancel`, and `duplicate-result` are the matching
wrapper-level cases.

## 7. Mapping to the implementation

Rust owns the state validation. The wrapper owns the scheduling. Each
model transition maps to one implementation obligation:

| Transition | Owner | Implementation |
| --- | --- | --- |
| `SubmitStart`, `StartRetry` | Wrapper starts, Rust validates | T015 attempt validation: the run is active, the check is startable, the attempt count is below the limit, and the offered case input and profile binding equal the run binding. |
| `SubmitDrift`, `RetryDrift` | Rust refuses | T015 returns a typed rejection. The attempt does not start and no record changes. |
| `SubmitQueued` | Wrapper | T030 queue admission below `max_pending`, counted over never-started work. |
| `SubmitSkipped` | Wrapper | T030 `skipped` record with reason `queue_full`. |
| `AttemptFail` | Wrapper | T032 bounded retry and backoff inside the total deadline. |
| `AcceptResult` | Rust validates | T015 result validation for an active attempt. T014 constructs the record. |
| `DuplicateResult` | Rust refuses | T015 rejection with reason `invalid_state_transition`. |
| `LateResult` | Rust refuses | T015 rejection with reason `late_result_rejected`. The report stays frozen. |
| `Cancel`, `Deadline` | Wrapper acts, Rust validates | T031 cancellation and the total deadline. T015 validates the terminal transition and takes the snapshot. |
| `Complete` | Wrapper observes, Rust constructs | T014 report construction with the fixed aggregate order. |

Omitted behavior. The implementation must add what the model leaves out:

- Time is absent. Backoff delays, attempt budgets, and queue time before
  the deadline do not appear. One event ends the run.
- The model covers one run. The wrapper may interleave several runs.
  Cross-run scheduler sharing is untested here.
- A final error records the abstract reason `retries_exhausted`. The
  implementation keeps the last operational reason, as the runtime traces
  define for `evaluator_error` and `evaluator_timeout`.
- Refused events are counted, not stored by kind. The implementation
  records the reason code of each refusal.
- Report payloads, usage, timing, and evaluator versions are absent.
- Profile qualification and host selection are outside this model.
  Task T008 models them.
- The model checks state rules, not the numerical policy calculations.

## 8. Changes to this model

Update the module or this record when the implementation changes a
modelled transition. Do not weaken an invariant to obtain a passing
result. Task T078 rechecks the models against the implemented boundary
and updates this applicability record.
