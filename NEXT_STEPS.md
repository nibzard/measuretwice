# Next steps for measuretwice

Recorded on 2026-09-27. Resume this work when the required evidence is available.

## 1. Test with real evidence

Confirm whether a human-reviewed dataset and a live evaluator are available.
Record label provenance and resolve reference conflicts before qualification.
Freeze the validation procedure and keep fitting cases separate from validation cases.
Compare the selected policy with a simple baseline.

Measure these results with tested code:

- Error among accepted cases.
- False acceptance.
- Automated coverage and review burden.
- Cost and latency.

Record sample counts, uncertainty methods, and population limits.
A result where no policy meets the goal is useful evidence.
Local software tests do not establish evaluator quality on real cases.

## 2. Retain partial calibration measurements

The host-owned completed-run sink exists: `calibrate` and `revise` accept one
optional `onMeasurement` callback and await it once per measured case, after
the run passed every completeness check, so one later failure or one abort
no longer makes completed measurements inaccessible.
What remains open is verified resumption: define how a resumed operation
checks definitions, inputs, evaluator bindings, and measurement profiles,
reuses only verified completed runs, and measures the rest.
Refuse fitting when required assessments are missing.
Test failure, cancellation, saving, reloading, and resuming without duplicate measurements.
Update the public API documentation with the storage and recovery procedure.

## 3. Confirm the macOS test fix

One macOS leg of `ci.yml` (Node.js 22 on `macos-latest`) runs the complete
TypeScript suite, including the temporary-path assertion, on every push to
`main`. The cross-check leg compiles the `x86_64-apple-darwin` target, and
the `Build artifacts` workflow builds both darwin targets. Treat the Actions
tab as the record: check the latest run before relying on it.

## Current checkpoint

The previous work addressed these review findings:

- Qualification refuses group-level intervals for case-level upper-bound constraints.
- Qualification refuses unreviewed references and unresolved reference conflicts.
- Calibration checks a declared translation hash before evaluator calls.
- Revision results retain replay runs for another revision after saving and reloading.
- The temporary-path test resolves its root through the real path.
- Documentation distinguishes slice sample requirements from quality constraints.
- `load`, `calibrate`, and `revise` run one frozen snapshot of the definition
  text, so one caller mutation after load changes neither what runs nor what
  the report hashes bound.
- Registration pins evaluator identity, and every run repeats the live
  binding comparison, including the model configuration and the
  preprocessing identity the adapter declares.
- One response that names another model than the pinned resolved model
  fails with `model_resolution_changed` instead of passing.
- Failed attempts keep their reported usage: the error record carries it,
  and the run totals state the complete known usage.
- The JSON boundary rejects values that serialization would silently drop
  or coerce, instead of accepting them.
- One input named `__proto__` refuses at validation, because no JavaScript
  boundary can carry it as one own property.
- Package assembly prefers the collected `--artifacts` binaries over local
  builds, and the install gate verifies the packed platform binaries against
  the collected release artifacts by digest.

A second adversarial review pass over the same diff confirmed and fixed:

- The serialization walk defines every object key instead of assigning it,
  so one parsed `__proto__` data property stays one named field of the
  crossing text and the core refuses it, instead of the walk dropping it.
- Array holes refuse with `nonportable_value` and their slot path, instead
  of crossing as `null`.
- Big integers cross as their exact digits, and the exact parser accepts
  the strict number grammar alone (no leading zero, no bare or trailing
  dot).
- One failed attempt that reports no usage erases no accumulated usage,
  and one refused failure transition changes no state and counts its
  usage once.
- One floating usage sum that overflows keeps one serializable number.
- The post-response model check also enforces the resolved model the
  registration declared, not only the profile pin.
- The minimum-version CI job compiles every target, the workflow pinning
  guard reads the workflow directory, and the install gate states how many
  platform binaries it verified.

The previous local verification passed:

- `npm run check`: 326 Rust unit tests, 37 contract tests, and 594
  TypeScript and repository tests.
- `npm run verify:install`: clean installation on Linux.
- `git diff --check`.

These results describe the previous verification run. Check the current repository state before resuming.
