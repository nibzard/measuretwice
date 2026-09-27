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
