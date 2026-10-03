# Compare two documentation integrations

This example runs measuretwice and an independent direct Jev integration.
Both paths use the same question, evidence, model, and numerical policy.
Each path makes its own provider call. The execution order alternates by case.

The case extractor reads current repository files and records their SHA-256 hashes.
It selects three documentation statements, adds two contradictory variants, and crops evidence for one default claim.
The cases reuse the earlier development scenarios. They form no independent validation set.
Proposed references remain model-authored and unreviewed.

## Run offline

Build the public package, then run from the repository root:

```sh
npm run build
node examples/documentation-consistency/comparison/run.mjs offline
```

The fixed measurements verify matching outcomes, policy abstention, and report inspection.
They assess no case meaning. The offline command makes no provider calls.
It writes a unique directory under `examples/documentation-consistency/build/comparison`.

## Run live

Install the host software development kit (SDK) in the ignored example directory:

```sh
npm install --prefix examples/documentation-consistency/build/comparison-client --save-exact @typesafe-ai/sdk@0.6.0
node examples/documentation-consistency/comparison/run.mjs live
```

Set `TYPESAFE_API_KEY` through your host's credential mechanism before the live command.
The command permits twelve provider calls: two calls for each of six cases.
Each call has one attempt, a 30-second deadline, and disabled SDK retries.
The model pin is `jev-1.13.0`. The acceptance and rejection cutoffs are 0.8 and 0.6.
Provider failures remain errors. Error outcomes make the command exit with code 1.
The command does not estimate currency cost.

## Inspect and review

The command prints its results directory.
Give only `REVIEW.md` to the maintainer before they label the cases.
Keep `proposed-references.json`, comparison rows, and evaluator reports hidden during that review.
Preserve the original proposals when recording human corrections.

`direct.json` and `runs.json` retain separate measurements from the two paths.
`requests.json` shows the public evidence sent to each evaluator call.
`readable.txt` and `direct-readable.txt` show the requirement, evidence, measurement, policy, and next inspection.
`execution.json` records versions, budgets, script hashes, and the base commit.
The `scripts` directory preserves the executed comparison code.
Private cases would require private artifact storage because these files explicitly include evidence text.

The direct implementation imports no measuretwice code.
It implements response validation, numerical policy, timeout handling, model pin checks, and safe failure codes.
It supports only this categorical check and this one-attempt experiment.
It does not implement qualification or the broader measuretwice lifecycle.
The remaining orchestration and input extraction serve both paths.

## Interpret the observations

Recorded calls and runtime describe this engineering trial.
They do not measure participant setup effort, diagnosis accuracy, or maintenance effort.
The current authoring session is neither a fresh agent session nor a human session.
Matching outcomes do not establish correctness. Both integrations can make the same mistake.
Use the [workflow study](../../../docs/product/workflow-study.md) for a participant comparison.
See the [executed trial](../evidence/comparison-2026-09-30/CONCLUSION.md) for observations and limitations.
