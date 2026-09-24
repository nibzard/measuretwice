# Profile-qualification model record

Model: [Qualification.tla](Qualification.tla). Checked on 23 September 2026.

Status: **complete**. The configuration finished with no error. All six
recorded negative controls fail as expected.

This record follows the seven steps that [AGENTS.md](../../AGENTS.md)
section 7 requires for each formal model. The model covers the profile
qualification, host selection, and mode admission boundary that
[MVP_SPEC.md](../../MVP_SPEC.md) sections 8 to 10 define. Task T008
publishes it before tasks T028, T029, T035, and T038 implement the
boundary.

## 1. Property, assumptions, and boundary

The model keeps three concepts separate, as the
[contracts README](../../contracts/README.md) requires: profile
qualification, host selection, and application authorization. It answers
five concrete risks:

| Risk | Checked invariant |
| --- | --- |
| An incompatible or unvalidated profile enters enforcement. | `EnforcementAdmissionSound` |
| A run, an evaluation, or a shadow report promotes a profile. | `RunsDoNotPromote` |
| A library step changes the host selection or grants application authorization. | `HostStateHostControlled` |
| A shadow pass authorizes an application action. | `ShadowPassNeverAuthorizes` |
| A model alias drifts and a stale binding keeps its qualification. | `DriftInvalidatesStaleBindings`, `ValidatedProfilesBindLoadedDefinition` |

Safety invariants also include `TypeOK`.

Assumptions:

- The library owns the admission gate only. The host owns the
  selection, the credentials, and every application action.
- The host may select any slot. Its review procedure is outside the
  model. Safety never depends on a careful host.
- A qualification flag is recorded evidence, not an authenticated
  approval. A forged dataset that claims `validated_for_scope` is
  indistinguishable here. The host review carries that trust.
- Qualification changes only in a qualification step or in the drift
  demotion. The environment may drift the model alias once, in one
  direction.
- A new candidate artifact never replaces the slot that the host
  selected. A slot models one artifact file.
- Time, retries, and run internals are absent. The
  [execution model](../execution/Execution.tla) owns them.

Boundary: the model stops at admission and state rules. It does not
model artifact parsing, hash checks, statistics, or report payloads.

## 2. State variables and transitions

| Variable | Meaning |
| --- | --- |
| `qual` | Qualification status per slot. |
| `boundDef`, `boundModel`, `scope` | Definition, resolved model, and declared use scope per slot. |
| `resolvedModel` | Current resolution of the model alias. |
| `selected` | Slot that the host selected for enforcement. |
| `authorized` | Application authorization. The host grants it alone. |
| `rejections` | Count of refused mode requests. |
| `lastEvent`, `prevQual`, `prevSelected`, `prevAuthorized` | Step monitor. Each action marks its class last. Run steps record the pre-step values. |
| `lastRunOutcome` | Outcome of the last accepted run. |
| `lastEnforce*` | Admission snapshot of the last accepted enforcement run. |

Transitions:

| Transition | Effect |
| --- | --- |
| `PublishStarter` | A new exploration artifact stays `unvalidated`. It binds the loaded definition and the current resolution. |
| `Qualify` | Frozen validation computes `insufficient_evidence`, `criteria_not_met`, or `validated_for_scope` for a new candidate artifact. |
| `RunEvaluation` | Evaluation admits any compatible profile. It changes no profile state. |
| `RunShadow` | Shadow admits any compatible profile and records its outcome. |
| `RunEnforcement` | Enforcement requires the full gate: compatible binding, matching scope, `validated_for_scope`, and the selected slot. |
| `RefuseRun` | A mode request that fails its gate is refused before execution. Only the refusal count changes. |
| `HostSelect`, `HostDeselect` | The host selects or withdraws a slot. |
| `HostAuthorize`, `HostRevoke` | The host grants or withdraws application authorization. |
| `ModelDrift` | The alias resolves to another model. Every stale binding becomes `unvalidated`. |

The gate:

```tla
EnforcementGate(p) ==
    /\ Compatible(p)
    /\ scope[p] = USE_SCOPE
    /\ qual[p] = "validated_for_scope"
    /\ selected = p
```

Design decisions from the model:

- Evaluation and shadow admit any compatible profile. The qualification
  status gates enforcement only, as MVP_SPEC.md section 8 requires for
  exploration profiles.
- The host selection admits nothing by itself. The gate rechecks every
  clause, so a careless or hostile selection cannot enable enforcement.
- Drift demotes every stale binding. The gate also refuses a stale
  binding. These are two independent barriers.

## 3. Safety and progress

TLC checked all seven invariants. The monitor invariants
(`RunsDoNotPromote`, `HostStateHostControlled`,
`ShadowPassNeverAuthorizes`) compare the recorded pre-step values with
the current values. In the correct module every run step leaves them
equal by construction. The negative controls show that TLC detects a
run step that breaks one.

No progress property is checked. The model has no terminal phase. The
lifecycle is ongoing: a demoted profile can requalify, and the host can
select again. AGENTS.md section 7 requires progress checks only when a
concrete progress risk exists. Termination of a single run belongs to
the [execution model](../execution/README.md). The specification
therefore carries no fairness assumption.

## 4. Tool version, configuration, and bounds

| Item | Value |
| --- | --- |
| TLA+ tools | `tla2tools.jar` from GitHub release v1.7.4 |
| TLC | TLC2 version 2.19 of 08 August 2024, revision `5a47802` |
| Java | OpenJDK 21.0.12.1, Linux x86-64 |
| Command | See [models/README.md](../README.md) |

Run the configuration from the repository root:

```sh
java -Xmx4g -XX:+UseParallelGC -cp <tla2tools.jar> tlc2.TLC \
  -deadlock -nowarning \
  -config models/qualification/Qualification.cfg \
  models/qualification/Qualification.tla
```

The `-deadlock` flag keeps the command uniform with the execution
model. The lifecycle has no terminal state, so a deadlock is not
expected here either.

Bounds:

| Configuration | NumProfiles | MaxRejections | Explores |
| --- | --- | --- | --- |
| [Qualification.cfg](Qualification.cfg) | 2 | 2 | The complete lifecycle: starter and candidate publication, all four statuses, host selection and withdrawal, all three modes, refusals, and one alias drift. |

The environment chooses the definition and the declared scope of each
slot in the initial state, so a foreign or wrong-scope artifact is
reachable from the start. The initial state set holds 16 states.
Refused events are capped at two, which keeps the reachable state set
finite. The model counts them and does not store their kind.

## 5. Results

| Configuration | States generated | Distinct states | Depth | Result |
| --- | --- | --- | --- | --- |
| `Qualification.cfg` | 4,760,528 | 211,024 | 14 | No error. All invariants hold. |

Completion status: complete. TLC explored the full state space in
about ten seconds. A checked model does not prove that the
implementation matches it.

Negative controls. Each control mutates one rule, keeps every
invariant unweakened, and reruns TLC:

| Control | Mutation | First violation | States generated |
| --- | --- | --- | --- |
| 1 | A shadow run with outcome `pass` promotes the profile. | `RunsDoNotPromote` after 37 states. | 37 |
| 2 | A shadow run with outcome `pass` grants application authorization. | `ShadowPassNeverAuthorizes` after 37 states. | 37 |
| 3 | The gate drops the qualification clause. | `EnforcementAdmissionSound` after 567 states. | 567 |
| 4 | The gate drops the scope clause. | `EnforcementAdmissionSound` after 9,813 states. | 9,813 |
| 5 | The alias drifts and no binding is demoted. | `DriftInvalidatesStaleBindings` after 658 states. | 658 |
| 6 | Control 5 plus a gate without the compatibility clause. | `EnforcementAdmissionSound` after 80,339 states. | 80,339 |

Control 6 needs two mutations. With the demotion in place, no single
reachable state holds a stale binding with a validated status. The
demotion and the compatibility clause are therefore two independent
barriers, and each one alone stops the silent reuse of an enforcement
profile.

## 6. Counterexamples and regression tests

The checked model produced no counterexample. Every counterexample
below comes from a negative control. Each one becomes a regression
scenario in a later task:

| Counterexample | Regression scenario |
| --- | --- |
| Control 1: a shadow `pass` moves a slot from `unvalidated` to `validated_for_scope` in one step. | T035 and T044: `run` and `evaluate` must leave every qualification status unchanged. |
| Control 2: a shadow `pass` sets `authorized` to `TRUE`. | T038: a shadow report must record its outcome and change no application action. |
| Control 3: the host selects an `unvalidated` slot and enforcement admits it. | T035: enforcement mode rejects an unvalidated profile with reason `qualification_insufficient`. |
| Control 4: enforcement admits a `validated_for_scope` profile that declares another scope. | T035 and T028: enforcement rejects the profile with reason `scope_mismatch`. |
| Control 5: after the drift, a stale binding keeps `validated_for_scope`. | T028: a changed model resolution invalidates the qualification. |
| Control 6: enforcement runs on a stale binding when both barriers are broken. | T035: enforcement rejects a stale binding with reason `model_resolution_changed`. |

One gap needed a decision in T035. The gate clause `selected = p` had no
stable reason code in the [contracts README](../../contracts/README.md).
T035 extended the registry through the permitted additive contract change
instead of reusing one existing code, because one missing selection is a
different defect from one unvalidated qualification: the new code
`profile_not_selected` names it. The regression scenarios below map to
the implemented gate, whose clause order is scope, then qualification,
then selection.

## 7. Mapping to the implementation

Rust owns the validation. The wrapper and the host own the actions.
Each transition maps to one implementation obligation:

| Transition | Owner | Implementation |
| --- | --- | --- |
| `PublishStarter` | Rust validates | T029: an exploration profile is generated `unvalidated` with reason `starter_policy`. |
| `Qualify` | Rust computes | T049, implemented: `measuretwice_core::qualification` computes the status of one frozen candidate on independent cases and returns the candidate unchanged. T050 wires the boundary into the calibrate API. |
| `RunEvaluation` | Wrapper runs, Rust validates | T044: `evaluate` reports metrics and changes no qualification and no selection. It reuses the shadow admission of the implemented gate. |
| `RunShadow` | Wrapper runs, Rust validates | T038: a shadow report records the outcome next to the baseline. No application action follows. |
| `RunEnforcement` | Rust admits | T035, implemented: enforcement mode checks the complete gate before any evaluator runs. The wrapper passes the requested scope and the host-selected hash through `RunOptions.scope` and `RunOptions.selectedProfileHash`. |
| `RefuseRun` | Rust refuses | T035 and T028, implemented: typed rejections before execution. See the reason mapping below. |
| `HostSelect`, `HostDeselect` | Host | T035, implemented: the host selects one reviewed profile hash through code or configuration review and states it per enforcement run. The library never selects, and no accepted run leaves one sticky selection. |
| `HostAuthorize`, `HostRevoke` | Host | T036 and T038: application authorization stays in the host application. No report or profile grants it. |
| `ModelDrift` | Rust detects | T028: a changed model resolution reports `model_resolution_changed` and invalidates the qualification. |

Refusal reasons map to the stable registry. Evaluation and shadow
refuse with `definition_mismatch` or `model_resolution_changed`.
Enforcement adds `qualification_insufficient`, `scope_mismatch`, and
`profile_not_selected`, the code that closes the section 6 gap.

Omitted behavior. The implementation must add what the model leaves
out:

- Artifact integrity. An edited or corrupted profile file with a wrong
  self-hash is not modelled. T028 validates `hash_mismatch` on load.
- The statistical basis of each status. Fitting, intervals, holdout
  reuse, and label provenance belong to T043, T047 to T049, and T052.
- The profile origins `exploration`, `calibration`, and `exact`. The
  model qualifies slots. T028 enforces the origin rules, such as the
  rejection of an exploration artifact that claims a qualification.
- Concurrency. The model serializes all steps. Several hosts, or one
  host with several selections, are outside the scope.
- Refusals are counted, not stored by kind. The implementation records
  the reason code of each refusal.
- Report payloads, usage, timing, and evaluator versions are absent.

## 8. Changes to this model

Update the module or this record when the implementation changes a
modelled transition. Do not weaken an invariant to obtain a passing
result. Task T078 rechecks the models against the implemented boundary
and updates this applicability record.
