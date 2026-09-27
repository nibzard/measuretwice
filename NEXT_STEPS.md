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

Add a host-owned way to save completed run reports during calibration.
Keep those reports available when a later case fails or the caller cancels the operation.
Define how a resumed operation checks definitions, inputs, evaluator bindings, and measurement profiles.
Refuse fitting when required assessments are missing.
Test failure, cancellation, saving, reloading, and resuming without duplicate measurements.
Update the public API documentation with the storage and recovery procedure.

## 3. Confirm the macOS test fix

Run continuous integration (CI) on macOS.
Confirm that the temporary-path assertion handles `/var` and `/private/var` consistently.
The local test passes, but macOS CI remains unverified.

## Current checkpoint

The previous work addressed these review findings:

- Qualification refuses group-level intervals for case-level upper-bound constraints.
- Qualification refuses unreviewed references and unresolved reference conflicts.
- Calibration checks a declared translation hash before evaluator calls.
- Revision results retain replay runs for another revision after saving and reloading.
- The temporary-path test resolves its root through the real path.
- Documentation distinguishes slice sample requirements from quality constraints.

The previous local verification passed:

- `npm run check`: 319 Rust unit tests, 37 contract tests, and 568 TypeScript tests.
- `npm run verify:install`: clean installation on Linux.
- `git diff --check`.

These results describe the previous verification run. Check the current repository state before resuming.
