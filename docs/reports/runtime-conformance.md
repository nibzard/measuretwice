# Runtime conformance and adversarial checks

Status: completed on 25 September 2026 by task T077. This record reports
one executed verification, the observations it produced, and the checks
that now hold it in the ordinary suites.

[MVP_SPEC.md](../../MVP_SPEC.md#12-runtime-boundaries) section 12 states
the runtime boundaries and
[AGENTS.md](../../AGENTS.md#10-make-failures-explicit) section 10 states
the failure rules behind them. The acceptance criteria of
[MVP_SPEC.md](../../MVP_SPEC.md#15-acceptance-criteria) section 15 name
the behaviors under test: cancellation, deadlines, retries, concurrency,
partial failures, the enforcement gate, and the replacement of one
evaluator with one test evaluator.

## Method

The verification attacked the runtime from the host side through the
public path: `load` and `run` over one mixed definition of three question
checks and two exact rules, the shipped scripted and label-only adapters,
the Jev adapter over one recorded call boundary, the shared fixtures of
`fixtures/`, and one workflow that shadows, evaluates, and calibrates the
same definition. Every run used one fake clock, one gated sleep that the
test releases by hand, and one in-memory file access that records every
read, so each attack is deterministic and replayable.

The suite is
[packages/measuretwice/test/runtime-adversarial.test.ts](../../packages/measuretwice/test/runtime-adversarial.test.ts),
and [TESTING.md](../../TESTING.md) states its row. Each test combines
hostile conditions in one run, because the task steps name the
combinations and not each condition alone.

The results below rest on the suites that existed before this task as
much as on the new one. The scheduler suite, the semantic run suite, the
native boundary suite, the Jev boundary suite, and the profile selection
suite already held most single conditions. The new suite closes the
combinations and the crossings that no earlier test joined: see the
coverage notes in each row.

## Results against the task steps

**Cancellation, deadlines, retries, saturation, malformed assessments,
and partial failure in combination.** One run held all of them at once:
one check failed one transient attempt, answered one undeclared label on
its second attempt, and recorded one permanent `invalid_assessment` error
with its true attempt count of 2; one check waited in one gated attempt
that never landed inside the total deadline; the deadline ended that
attempt with `deadline_exceeded`; one queued rule completed before the
deadline; and the zero-and-one pending limits skipped two checks with
`queue_full`. The aggregate folded to `error` beside one pass and two
skips. One second run cancelled during one backoff under one zero
pending limit: the retrying check recorded `cancelled_before_start`
because it held no record, the in-flight attempt recorded `run_cancelled`,
and the clock passing the disarmed backoff instant proved no further
attempt started.

**Repeated and late callbacks against immutable terminal reports.** Three
gated answers arrived one after another after the deadline froze the
report. The serialized report stayed byte-identical after every delivery,
the report object stayed deeply frozen, and advancing the clock past every
remaining instant fired no wake-up, because the terminal path disarmed
them. The same held for one late answer after one cancelled report. One
genuine duplicate result remains provable only at the core boundary,
because one adapter cannot resolve one attempt twice by construction: the
trace `duplicate-result` and the run-state refusals of the native suite
hold that case.

**Cross-case isolation, unauthorized input fields, embedded instructions,
and oversized evidence.** Two cases ran concurrently through one adapter
instance. Every dispatched request held exactly the projected inputs of
its own case under its own `using` list, no request mixed the two cases
or carried one case identifier, one baseline, or one foreign input, and
the two reports stayed separate down to their input hashes. One case with
one undeclared `label` field refused with `unknown_field` before any
evaluator ran, and one input above its declared bound refused with
`invalid_field_type`, both without consuming one scripted answer.
Evidence that carried one injection string and one JSON-looking
instruction object crossed as one string value: the dispatched question
stayed the authored question, the projection stayed the declared inputs,
and the exact rule read its own input as data and failed on the marker
inside it. One evidence state above the Jev state budget recorded one
operational error whose message keeps the stable code `oversized_input`
and the statement that the adapter truncates nothing, while the recorded
provider boundary received no call.

**Unvalidated profiles and changed model aliases cannot enter
enforcement.** The exploration profile refused enforcement with
`qualification_insufficient` at `/profile/qualification/status` both
without one selection and with its own content hash stated as the
selection, before any evaluator ran; shadow mode admitted the same
profile. One validated profile that records one resolved model refused
with `model_resolution_changed` at `/profile/bindings/0/model/resolved`
when the live state stated one changed resolution. One artifact that
edits its requested alias is one new artifact: its content hash differs,
so the reviewed selection of the host names another artifact and the run
refuses with `profile_not_selected` before any case work.

**Evaluation, calibration, and shadow execution change no host action and
no selected hash.** One workflow ran one shadow run with one baseline,
one evaluation of seven records, and one complete calibration over one
definition, against one host state that holds one decision, one action
ledger, and one stored profile. After every operation the decision was
unchanged, the action ledger was empty, and the stored profile bytes were
identical. The calibration returned one new candidate artifact and stored
nothing. Enforcement afterwards still refused the prior unvalidated
profile even with its own hash selected, refused the candidate without
one selection, and admitted the candidate only when the run stated the
reviewed hash of the loaded artifact and its declared scope. No
operation left one sticky selection.

**The shared fixtures through the three adapters, without live calls.**
One test drove all three shipped adapters in one place: the exact
definition fixture answered its shared trace case with no evaluator
registered, because exact rules stay in Rust; one definition authored
from the shared provider fixture ran through the Jev adapter over one
recorded call boundary, and the report kept the fixture assessment, the
resolved model, and one call with one question and the projected input
under the fixed evidence key; and the same definition and case ran
through the label-only adapter, which received the same request, recorded
one honest error under the mass policy because it invents no
distribution, and decided the same answer through the separately
specified test rule. Both evaluator-backed legs reported one definition
content hash.

## Observations

- After more than one failed attempt, the run record states
  `retries_exhausted` and one summary message, so the operational code of
  the last failure stays named in the message but its own message text
  does not cross. After one single failed attempt, the record keeps the
  operational code and its message. The runtime traces fix both shapes,
  so this is the specified contract and not one defect. One host that
  needs the stable sub-code of the last failure reads it before the
  attempt limit is spent, or states one attempt.
- The wrapper states no live resolved model at `load` and `run`, because
  no adapter resolves one model before one call. One changed alias
  resolution is therefore caught when the host states the live resolution
  through the compatibility boundary, and one edited alias is caught by
  the content hash of the artifact. Both crossings are under test.
- Four runtime traces stay boundary-level, as the scheduler suite
  records: `duplicate-result`, `late-result-after-completion`,
  `deadline-keeps-completed`, and `cancel-mid-run`. The wrapper cannot
  produce their event order from one adapter, so the native suite holds
  them.

## Commands and results

Run from the repository root on 25 September 2026.

| Command | Result |
| --- | --- |
| `npm run build` | Passed. |
| `npm run typecheck` | Passed. |
| `npx vitest run packages/measuretwice/test/runtime-adversarial.test.ts` | 13 tests passed. |
| `npm run test:ts` | Passed. Two parallel runs each lost one worker to SIGSEGV, the known host flake of the Vitest workers; each affected file passed alone. One complete run without file parallelism passed every file: 48 files, 564 tests. |
| `npm run test:rs` | Passed: 354 tests. |
| `npm run fmt:check` and `npm run lint` | Passed. No Rust code changed. |

## Limits

- The attacks are synthetic and written from the specification, not from
  one recorded attack. They prove the stated refusals, not the absence of
  every hostile input.
- No live evaluator ran. The Jev leg replayed the pinned provider
  fixtures of `fixtures/adapters/jev-normalization.json` through one
  recorded call boundary, so it verifies the adapter and the wrapper, not
  the service.
- The formal models stay outside this record. Task T078 owns their
  applicability to the implemented state behavior.
