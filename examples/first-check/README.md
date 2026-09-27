# First check

Try one requirement before preparing calibration data or application storage.
This example uses plain JavaScript with TypeBox schemas.
The same definition works in TypeScript with inferred case inputs.

From the repository root:

```sh
npm ci
npm run example
```

After the package build exists, run the example directly:

```sh
node examples/first-check/run.mjs
node examples/first-check/run.mjs --detail
```

The first command shows each source, candidate, proposed reference, and report.
The second adds recorded measurements and rules.
Expected outcomes are pass, fail, and review, in that order.
The profile remains unvalidated. No provider runs and no file is written.
Shadow mode records judgments and changes no application action.
The script intentionally prints the public synthetic inputs beside the reports.
The library report still contains no raw case text.

| File | What you change |
| --- | --- |
| [checks.mjs](checks.mjs) | The requirement, evidence inputs, and answer meanings |
| [cases.mjs](cases.mjs) | The synthetic sources, candidates, and proposed references |
| [run.mjs](run.mjs) | The evaluator and application integration |

The evaluator returns fixed answers regardless of the case text.
Editing a candidate therefore does not test the edited candidate's meaning.
The labels are model-proposed and unreviewed; this example establishes no reliability claim.

To assess changed text, supply a real evaluator using the [README integration](../../README.md#connect-a-real-evaluator).
Register it and generate a new exploration profile. A profile value needs no saved file.
For application-owned report storage and typed datasets, continue with [memory support](../memory-support/README.md).

Before expanding the check, use [the evidence guide](../../docs/guides/evidence.md).
Qualification uses separately reviewed cases and [the calibration workflow](../../docs/guides/calibration.md).

## Revise the requirement

The original check accepts a supported memory without naming its speaker.
The revised check also requires the candidate to name the speaker.
Read [checks-attribution.mjs](checks-attribution.mjs) to inspect the changed question and answer meanings.

After the package build exists, run:

```sh
node examples/first-check/revise.mjs
```

The script performs these steps:

1. Generate an exploration profile for the original requirement.
2. Try to load the revised requirement with that profile.
3. Confirm `definition_mismatch` before any evaluator call.
4. Generate a new exploration profile for the revised requirement.
5. Run three cases in shadow mode and print their reports.

| Candidate | Source speaker | Scripted outcome |
| --- | --- | --- |
| The launch is Friday. | Dana | fail |
| Dana confirms the launch is Friday. | Dana | pass |
| Dana confirms the launch is Friday. | Not identified | review |

The first candidate passed the original requirement. It now omits required attribution.
The last case lacks evidence for the speaker; absence alone establishes no contradiction.
Fixed answers illustrate these distinctions. They do not assess the text.

The new profile remains unvalidated. Earlier qualification does not transfer to a changed requirement.
For a real evaluator, reassess representative cases and review their labels against the revised answer meanings.
Use separate fitting and independent validation data before relying on the new profile.
Changing a requirement differs from tuning numerical rules; use [policy revision](../plan-review/README.md) for that workflow.
