# Documentation consistency results

Date: 27 September 2026.
Status: two live exploration revisions completed. No qualification claim is made.

## Setup and evidence

The run used a clean local clone of commit `7797f94d24044824886b6d6b4a96108679668e64`.
`npm ci` and `npm run build` completed in that clone.
The scripted starter run produced pass, fail, and review as specified by [the program](PROGRAM.md).
The trial installed `@typesafe-ai/sdk` 0.6.0 locally.
Every live result records the resolved model `jev-1.13.0` and adapter version `0.1.0`.

The dataset contains three unchanged repository excerpts, two inserted errors, and one missing-evidence control.
The errors change Unicode length semantics and reverse the starter cutoffs.
The control omits evidence for the default run mode.
All reference labels are model-proposed and unreviewed. No human supplied labels.

The preserved inputs are [revision 1](cases/repository-docs-v1.json) and [revision 2](cases/repository-docs.json).
The [source manifest](cases/source-manifest.json) records SHA-256 hashes of the source files.
Related variants retain the same group.
The datasets are development fixtures, not representative validation samples.

## Results

Counts and timing sums were computed from the saved run records.
The Rust core computed the evaluation metrics in each evaluation artifact.
Execution time is the sum of recorded check execution times, not total setup or wall time.

| Measure | Revision 1 | Revision 2 |
| --- | --- | --- |
| Assessed cases | 6 | 6 |
| Pass | 0 | 1 |
| Fail | 2 | 2 |
| Review | 4 | 3 |
| Outcome matches with proposed references | 3 of 6 | 4 of 6 |
| Execution errors or skipped checks | 0 | 0 |
| Sum of check execution time | 1798 ms | 1926 ms |
| Reported input tokens | 3662 | 3533 |
| Reported output tokens | 294 | 288 |

Both revisions rejected both inserted errors and reviewed the missing-evidence control.
These counts describe selected cases only. Agreement with unreviewed model labels is not measured human-reference accuracy.
Both profiles remain `unvalidated`, with reason `starter_policy`.

## Revision 1 findings

All three unchanged passages received review outcomes.
Inspection found three problems in the case assembly:

- The Unicode candidate also described matching rules that its evidence did not contain.
- The cutoff candidate also described permitted numerical bounds that its evidence did not contain.
- The default-mode candidate ended halfway through a sentence.

Those problems limit the interpretation of the first run.
The evaluator returned no textual rationale, so these observations do not establish why it selected its answers.
The original inputs and labels remain preserved.

Revision 2 narrowed the candidates to complete statements covered by the selected evidence.
It changed no question, thresholds, model, or proposed reference answer.
This is a development iteration after inspecting results. It is not independent validation.

## Revision 2 findings

| Case | Proposed reference | Raw evaluator label | Policy outcome |
| --- | --- | --- | --- |
| Unicode documentation | pass | supported | pass |
| Starter cutoff documentation | pass | insufficient | review |
| Default run mode documentation | pass | supported | review |
| Inserted Unicode error | fail | contradicted | fail |
| Inserted cutoff error | fail | contradicted | fail |
| Missing default evidence | review | insufficient | review |

The unchanged cutoff statement remains unresolved against its model-proposed reference.
Its assessment assigns mass 0.71 to `insufficient` and 0.22 to `supported`.
The evaluator provides no rationale. A human must review the claim and supplied evidence before interpreting this as an evaluator mistake.

The default-mode assessment selects `supported` with mass 0.76.
The starter acceptance cutoff is 0.8, so the policy returns review.
This is an observable difference between the evaluator answer and the policy outcome.
No threshold was changed to obtain another result.

The raw-label comparison reuses each assessment. It is not a separate direct-provider integration experiment.
The run found no established defect in unchanged repository documentation.
The two detected defects were deliberately inserted into candidates.

## Artifacts and reproduction

Selected public artifacts are retained with this experiment:

- [Revision 1 evaluation](evidence/repository-exploration-1/evaluation.json) and [readable reports](evidence/repository-exploration-1/readable.txt).
- [Revision 2 evaluation](evidence/repository-exploration-2/evaluation.json) and [readable reports](evidence/repository-exploration-2/readable.txt).
- [Computed summary](evidence/summary.json), the [executed runner](evidence/run.mjs), and its [dependency lock file](evidence/package-lock.json).

These snapshots contain public repository excerpts and synthetic variants. They contain no private case data or credentials.
The runner differs from the shared sample only in its population and sampling metadata fields.
It reads those fields from the supplied configuration instead of describing every case as a synthetic starter case.
Individual label records preserve collected and synthetic origins.

To repeat revision 2, follow the clean setup in [the shared guide](../EXPERIMENT_SETUP.md).
Use `cases/repository-docs.json` as `experiment.json` and the shared runner as `run.mjs`.
Replace its two fixed population and sampling values with `config.intended_population` and `config.sampling_method`.
Install the pinned SDK, configure the host credential, and run `node run.mjs live` from the trial folder.
Use revision 1's input file to repeat that revision separately.
Stochastic outputs need not match these recorded outputs.

Each revision permits six provider calls, one per case, with no retries.
The recorded runs contain six completed check executions per revision.
All executions use shadow mode. They change no application action.
Currency cost and human review time were not measured.

## Conclusion

This experiment demonstrates the complete live path and detection of two simple inserted errors.
It also exposes sensitivity to evidence selection and an unresolved review burden for unchanged documentation.
The default-mode case demonstrates how the starter policy can request review after a supported evaluator answer.

The next useful step is human review of the cutoff case and labels, followed by new documentation cases.
More representative cases are needed before fitting thresholds or making a reliability claim.
