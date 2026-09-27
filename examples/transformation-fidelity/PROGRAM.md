# Transformation fidelity experiment program

Status: runnable exploration procedure. No live result or qualification claim is recorded here.
Read [the brief](BRIEF.md) for the broader experiment.

## Goal and required primitives

Detect when merging records removes an explicit condition.

Source descriptions, a transformation requirement, and a candidate merged description. Exact field validation remains separate.
The first trial uses one categorical check with three answers.
`supported` maps to pass, `contradicted` maps to fail, and `insufficient` maps to review.
Operational errors remain errors. None of these outcomes authorizes an application action.

## Procedure

1. Open [the shared setup and runner](../EXPERIMENT_SETUP.md).
2. Set `EXPERIMENT=transformation-fidelity` before its clean-checkout commands.
3. Save the JSON below as `experiment.json` in the new trial folder.
4. Save the shared runner as `run.mjs` in that folder.
5. Run the offline commands below to verify the setup.
6. Review the references using this program's review procedure.
7. Run the optional live trial and record the observed outcomes.

The shared guide supplies complete dependency, credential, execution, and report instructions.
It creates a clean committed checkout and a new `examples/transformation-fidelity/build/trial` folder.
All commands below run from that trial folder.

## Starter inputs

These cases and reference labels are synthetic model proposals, not human judgments.
The three variants share one group and are development cases only.

```json
{
  "name": "transformation-fidelity",
  "revision": "starter-1",
  "question": "Does the transformed description preserve the shipping condition stated in the source records without adding unsupported terms?",
  "languages": [
    "en"
  ],
  "cases": [
    {
      "id": "case-01",
      "group": "starter-scenario",
      "evidence": "Merge requirement: preserve every shipping condition. Product A record: free shipping for orders above EUR 50. Product A second record: delivery within Germany only.",
      "candidate": "Product A has free shipping above EUR 50, within Germany only.",
      "answer": "supported",
      "reason": "The merged description preserves both conditions."
    },
    {
      "id": "case-02",
      "group": "starter-scenario",
      "evidence": "Merge requirement: preserve every shipping condition. Product A record: free shipping for orders above EUR 50. Product A second record: delivery within Germany only.",
      "candidate": "Product A has free shipping on every order worldwide.",
      "answer": "contradicted",
      "reason": "The merged description contradicts both conditions."
    },
    {
      "id": "case-03",
      "group": "starter-scenario",
      "evidence": "Merge requirement: preserve every shipping condition. Product A record: free shipping. The referenced shipping policy is unavailable.",
      "candidate": "Product A has free shipping on every order worldwide.",
      "answer": "insufficient",
      "reason": "The supplied records do not establish the order or destination scope."
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

1. Ask a domain reviewer to list the source facts before viewing the transformed record.
2. Label each preserved, lost, or added condition.
3. Do not resolve an ambiguous source by assuming a familiar business rule.

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
| `case-01` | pass | The merged description preserves both conditions. |
| `case-02` | fail | The merged description contradicts both conditions. |
| `case-03` | review | The supplied records do not establish the order or destination scope. |

These are proposed reference outcomes, not promised evaluator results.
Record every disagreement and operational error. Do not change a label merely to match the evaluator.
If the provider is unavailable, retain the failure and mark the live trial blocked.

## Inspection and next experiment

Use the printed results path with the inspection commands in the shared guide.
Compare the raw evaluator label with the policy outcome on the same assessment.
Inspect reference disagreements before deciding whether they concern the check, evaluator, or proposed label.

Add real approved records with duplicate entities, conflicting descriptions, and omitted qualifiers. Separate merge correctness from entity identification.
Group all records and transformation variants for the same entity together.
For new data, replace the runner's synthetic metadata and default label provenance before execution.
Keep validation cases untouched while changing requirements or thresholds.
The three starter cases cannot establish a deployment error rate.

## Completion record

Write `CONCLUSION.md` in the results directory using the shared guide's required fields.
Record setup effort, review effort, useful findings, counts, denominators, and unresolved problems.

Continue if the assessment identifies meaning changes that schema validation accepts but a reviewer would correct.
A passing description assessment does not prove that two records refer to the same real entity or authorize updating storage.
