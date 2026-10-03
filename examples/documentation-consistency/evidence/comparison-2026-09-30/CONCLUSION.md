# Documentation integration comparison

Date: 30 September 2026.
Status: completed engineering trial. Human review and participant comparison remain open.

## Task and inputs

The trial used three statements from current measuretwice documentation and their source contracts.
It added two deliberately contradictory variants and one case with cropped evidence.
The statements concern Unicode length, starter cutoffs, and the default run mode.
Related variants retain the same group.
The cases reuse previously inspected development scenarios. They are not independent validation evidence.

[Cases](cases.json) preserve the exact supplied text.
[Source hashes](sources.json) identify the five repository files used by the extractor.
[Proposed references](proposed-references.json) retain model-authored labels with `reviewed: false`.
Give only the [review sheet](REVIEW.md) to the maintainer before labeling.
No human reviewed the references during this trial.

The question explicitly distinguishes a contradiction from absent evidence.
This is a development revision after the earlier fictional starter trial.
The thresholds remain 0.8 for acceptance and 0.6 for rejection.
The question change and case change prevent a causal comparison with that earlier trial.

## Execution

The trial used the current uncommitted worktree over `75799adeb051eb2b83ff5ff6d6f06e40ee5fe75a`.
It used Node.js 24.18.0 on Linux x64, SDK 0.6.0, and model `jev-1.13.0`.
The measuretwice adapter version is 0.2.0 and its policy family is `probability_mass_v1`.
The [execution record](execution.json) retains budgets and script hashes.
[Runtime provenance](runtime-provenance.json) identifies the compiled files used by the trial.
The [executed scripts](implementation-inventory.json) remain preserved in this directory.

The command was `node examples/documentation-consistency/comparison/run.mjs live`.
It completed with exit code zero, twelve provider calls, and no operational errors.
The paths made separate calls using the same question and evidence.
Execution order alternated between paths by case.
Each call had one attempt, a 30-second deadline, and disabled SDK retries.
The [request records](requests.json) contain public evidence and no reference labels or credentials.

The preceding offline command completed with matching outcomes on fixed measurements.
Its outputs test execution and policy abstention; they establish no semantic result.

## Observed outcomes

| Case | Content | Proposed reference | Direct outcome | measuretwice outcome |
| --- | --- | --- | --- | --- |
| doc-01 | Current Unicode length statement | pass | pass | pass |
| doc-02 | Current starter cutoff statement | pass | review | review |
| doc-03 | Current default-mode statement | pass | pass | pass |
| doc-04 | Inserted Unicode error | fail | fail | fail |
| doc-05 | Inserted cutoff error | fail | fail | fail |
| doc-06 | Default claim with cropped evidence | review | review | review |

Both paths matched each other on six of six outcomes.
Each path matched five of six unreviewed proposed references.
Each path flagged both inserted contradictions and reviewed the missing-evidence case.
Neither path established a defect in unchanged repository documentation.
Agreement between paths is not correctness.

For doc-02, the direct assessment selected `insufficient` with mass 0.80.
The measuretwice assessment selected `insufficient` with mass 0.75.
Both policies preserve the explicit review answer.
The evaluator supplied no textual rationale in either call.
A maintainer must review whether the supplied constant establishes the complete default behavior.
Keep the proposed reference and both measurements unchanged during that review.

Independent calls produced different probability measurements on several cases.
The matching outcomes therefore do not imply identical evaluator behavior.
Inspect the [direct records](direct.json), [measuretwice reports](runs.json), and [comparison rows](comparison.json).
The [direct readable view](direct-readable.txt) and [measuretwice readable view](readable.txt) include local evidence.

## Usage and effort

The [computed summary](summary.json) reports 3,390 ms of wall time across both integrations.
Each path reports 3,486 input tokens and 288 output tokens across six calls.
Currency cost was not measured.
Provider latency from one small run establishes no performance difference between integrations.

The direct implementation imports no measuretwice code.
The executed direct implementation contains 71 lines, including response validation, policy, timeout handling, and safe errors.
Shared task configuration, case extraction, and orchestration appear in the implementation inventory.
Line counts measure stored code size. They do not measure setup effort or maintenance effort.
The direct path supports this categorical task and model pin; it implements no qualification lifecycle.

Preparation used the existing checkout and its built public package.
The host SDK installation completed locally before the live command.
The installation command was `npm install --prefix examples/documentation-consistency/build/comparison-client --save-exact @typesafe-ai/sdk@0.6.0`.
The offline command was `node examples/documentation-consistency/comparison/run.mjs offline`.
The current authoring session is not a fresh agent session or a human participant session.
Participant setup time, diagnosis accuracy, review time, revision effort, and facilitator help remain unmeasured.

The initial tests failed because the new implementation files did not exist.
A later comparison test exposed a mass-sum tolerance mismatch in the direct implementation.
The direct implementation now uses the contract's tolerance of 0.000001.
The live trial had already completed. Its measurements sum to one and do not exercise that boundary.
The preserved executed script predates that correction.
The current comparator also adds a direct readable view and distinguishes fixture calls from provider calls.
These changes required no further paid trial.

## Software verification

`npm run check` passed after the completed changes.
It covered formatting, Clippy, native and TypeScript builds, type checks, 329 Rust unit tests, 37 contract tests, and 650 TypeScript tests.
The comparator suite contains twelve tests for policy boundaries, matching requests, malformed measurements, permanent failures, and late results.
The recorded requests form six equal pairs and contain no reference labels.
The recorded script files match every hash in the execution record.
The current extractor reproduces all six saved inputs.

The first full check exposed unused exclusions in the documentation scanner.
It incorrectly checked links inside the locally installed SDK.
A temporary fixture reproduced that failure. Applying the exclusions repaired the scan.
The final full check passed. Software verification establishes no semantic accuracy or participant advantage.

## Next action and limits

Have a maintainer label the review sheet without seeing the proposed references or evaluator output.
Use the participant procedure in the workflow study before making a developer or agent experience claim.
Retain this run as development evidence. Keep later validation cases untouched.
The profile remains unvalidated. No deployment reliability, comparative effort, or authorization claim is made.
