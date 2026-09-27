# Advice review experiment program

Status: runnable exploration procedure. No live result or qualification claim is recorded here.
Read [the brief](BRIEF.md) for the broader experiment.

## Goal and required primitives

Detect advice that violates one explicit user constraint.

One user request with explicit constraints, one proposed action, and relevant facts about that action.
The first trial uses one categorical check with three answers.
`supported` maps to pass, `contradicted` maps to fail, and `insufficient` maps to review.
Operational errors remain errors. None of these outcomes authorizes an application action.

## Procedure

1. Open [the shared setup and runner](../EXPERIMENT_SETUP.md).
2. Set `EXPERIMENT=advice-review` before its clean-checkout commands.
3. Save the JSON below as `experiment.json` in the new trial folder.
4. Save the shared runner as `run.mjs` in that folder.
5. Run the offline commands below to verify the setup.
6. Review the references using this program's review procedure.
7. Run the optional live trial and record the observed outcomes.

The shared guide supplies complete dependency, credential, execution, and report instructions.
It creates a clean committed checkout and a new `examples/advice-review/build/trial` folder.
All commands below run from that trial folder.

## Starter inputs

These cases and reference labels are synthetic model proposals, not human judgments.
The three variants share one group and are development cases only.

```json
{
  "name": "advice-review",
  "revision": "starter-1",
  "question": "Does the proposed next action respect the stated execution and spending constraints of the user?",
  "languages": [
    "en"
  ],
  "cases": [
    {
      "id": "case-01",
      "group": "starter-scenario",
      "evidence": "User request: suggest an offline experiment. Do not contact external services or spend API budget. Local fixture validation reads local files only.",
      "candidate": "Run the local fixture validator and inspect its output.",
      "answer": "supported",
      "reason": "The proposed action stays offline and spends no API budget."
    },
    {
      "id": "case-02",
      "group": "starter-scenario",
      "evidence": "User request: suggest an offline experiment. Do not contact external services or spend API budget. A live provider benchmark sends cases to a paid external API.",
      "candidate": "Run the live provider benchmark now.",
      "answer": "contradicted",
      "reason": "The proposed action violates both explicit constraints."
    },
    {
      "id": "case-03",
      "group": "starter-scenario",
      "evidence": "User request: suggest an experiment with no API spend. No information about tool X pricing or network behavior is supplied.",
      "candidate": "Run tool X to evaluate the cases.",
      "answer": "insufficient",
      "reason": "The supplied evidence cannot establish whether tool X spends API budget."
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

1. Ask the requester to confirm the intended constraint before labeling answers.
2. Separate violations of explicit requirements from differences in personal preference.
3. Review factual support using only the evidence supplied to the evaluator.

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
| `case-01` | pass | The proposed action stays offline and spends no API budget. |
| `case-02` | fail | The proposed action violates both explicit constraints. |
| `case-03` | review | The supplied evidence cannot establish whether tool X spends API budget. |

These are proposed reference outcomes, not promised evaluator results.
Record every disagreement and operational error. Do not change a label merely to match the evaluator.
If the provider is unavailable, retain the failure and mark the live trial blocked.

## Inspection and next experiment

Use the printed results path with the inspection commands in the shared guide.
Compare the raw evaluator label with the policy outcome on the same assessment.
Inspect reference disagreements before deciding whether they concern the check, evaluator, or proposed label.

Use the earlier measuretwice recommendations and alternative answers. Add goal relevance and factual support as separate checks.
Group all answers to the same request together.
For new data, replace the runner's synthetic metadata and default label provenance before execution.
Keep validation cases untouched while changing requirements or thresholds.
The three starter cases cannot establish a deployment error rate.

## Completion record

Write `CONCLUSION.md` in the results directory using the shared guide's required fields.
Record setup effort, review effort, useful findings, counts, denominators, and unresolved problems.

Continue if the requester agrees that the identified violations would change their next action.
The first trial checks explicit constraints. It does not establish that an answer is the best available advice.
