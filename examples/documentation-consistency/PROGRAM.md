# Documentation consistency experiment program

Status: runnable exploration procedure. No live result or qualification claim is recorded here.
Read [the brief](BRIEF.md) for the broader experiment.

Read [the results record](RESULTS.md) for two executed live development revisions on repository excerpts.

## Goal and required primitives

Detect disagreement between a documented default and its authoritative contract.

One authoritative contract excerpt and one candidate documentation excerpt. Retain the contract revision with later real cases.
The first trial uses one categorical check with three answers.
`supported` maps to pass, `contradicted` maps to fail, and `insufficient` maps to review.
Operational errors remain errors. None of these outcomes authorizes an application action.

## Procedure

1. Open [the shared setup and runner](../EXPERIMENT_SETUP.md).
2. Set `EXPERIMENT=documentation-consistency` before its clean-checkout commands.
3. Save the JSON below as `experiment.json` in the new trial folder.
4. Save the shared runner as `run.mjs` in that folder.
5. Run the offline commands below to verify the setup.
6. Review the references using this program's review procedure.
7. Run the optional live trial and record the observed outcomes.

The shared guide supplies complete dependency, credential, execution, and report instructions.
It creates a clean committed checkout and a new `examples/documentation-consistency/build/trial` folder.
All commands below run from that trial folder.

## Starter inputs

These cases and reference labels are synthetic model proposals, not human judgments.
The three variants share one group and are development cases only.

```json
{
  "name": "documentation-consistency",
  "revision": "starter-1",
  "question": "Does the candidate documentation state the timeout default consistently with the supplied contract?",
  "languages": [
    "en"
  ],
  "cases": [
    {
      "id": "case-01",
      "group": "starter-scenario",
      "evidence": "Contract revision 1: timeout_ms defaults to 1000 milliseconds when omitted.",
      "candidate": "If you omit timeout_ms, the timeout is 1000 milliseconds.",
      "answer": "supported",
      "reason": "The documented default equals the contract default."
    },
    {
      "id": "case-02",
      "group": "starter-scenario",
      "evidence": "Contract revision 1: timeout_ms defaults to 1000 milliseconds when omitted.",
      "candidate": "If you omit timeout_ms, the timeout is 5000 milliseconds.",
      "answer": "contradicted",
      "reason": "The documented default contradicts the contract."
    },
    {
      "id": "case-03",
      "group": "starter-scenario",
      "evidence": "Contract revision 1: timeout_ms accepts a positive integer in milliseconds. This excerpt states no default.",
      "candidate": "If you omit timeout_ms, the timeout is 1000 milliseconds.",
      "answer": "insufficient",
      "reason": "The supplied contract does not establish the claimed default."
    }
  ]
}
```

## Offline execution

```sh
node --check run.mjs
node run.mjs smoke
```

Expected: exit code zero, one unvalidated profile, and three reports with outcomes `pass`, `fail`, and `review`.
The scripted evaluator returns fixed answers. It does not assess the case text.
Use this stage to verify file paths, schema validation, report generation, and the outcome mapping.

## Reference review

1. Have a maintainer identify the authoritative statement in each evidence excerpt.
2. Review each proposed label without seeing evaluator output.
3. Keep inserted inconsistencies separate from errors found in unchanged repository documents.

Preserve the original proposed labels and record reviewer identity and corrections.
Follow the shared guide for the optional full `label` provenance record.
If nobody reviews the labels, record that limitation before interpreting the live results.

## Live execution

Install the pinned provider client and configure its credential as the shared guide describes.
The live command sends case content to the provider and can spend API budget.

```sh
node run.mjs live
```

Expected artifacts: a dataset snapshot, definition, profile, evaluation report, individual reports, and comparison rows.
The profile remains `unvalidated` even if every answer agrees with a reference.
The proposed reference outcomes are:

| Case | Proposed outcome | Reason |
| --- | --- | --- |
| `case-01` | pass | The documented default equals the contract default. |
| `case-02` | fail | The documented default contradicts the contract. |
| `case-03` | review | The supplied contract does not establish the claimed default. |

These are proposed reference outcomes, not promised evaluator results.
Record every disagreement and operational error. Do not change a label merely to match the evaluator.
If the provider is unavailable, retain the failure and mark the live trial blocked.

## Inspection and next experiment

Use the printed results path with the inspection commands in the shared guide.
Compare the raw evaluator label with the policy outcome on the same assessment.
Inspect reference disagreements before deciding whether they concern the check, evaluator, or proposed label.

Pair actual measuretwice examples with their current contracts. Add omissions, unsupported performance claims, and obsolete instructions as separate checks.
Group variants of the same example and contract revision together.
For new data, replace the runner's synthetic metadata and default label provenance before execution.
Keep validation cases untouched while changing requirements or thresholds.
The three starter cases cannot establish a deployment error rate.

## Completion record

Write `CONCLUSION.md` in the results directory using the shared guide's required fields.
Record setup effort, review effort, useful findings, counts, denominators, and unresolved problems.

Continue if reports identify exact statements that a maintainer can correct with the supplied contract.
The starter cases are fictional. Detecting their inserted inconsistencies does not establish performance on ordinary documentation changes.
