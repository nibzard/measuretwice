# Memory fidelity experiment program

Status: runnable exploration procedure. No live result or qualification claim is recorded here.
Read [the brief](BRIEF.md) for the broader experiment.

## Goal and required primitives

Detect when a memory changes uncertainty into a confirmed decision.

One source message, a proposed memory, and any source context needed to resolve its status.
The first trial uses one categorical check with three answers.
`supported` maps to pass, `contradicted` maps to fail, and `insufficient` maps to review.
Operational errors remain errors. None of these outcomes authorizes an application action.

## Procedure

1. Open [the shared setup and runner](../EXPERIMENT_SETUP.md).
2. Set `EXPERIMENT=memory-fidelity` before its clean-checkout commands.
3. Save the JSON below as `experiment.json` in the new trial folder.
4. Save the shared runner as `run.mjs` in that folder.
5. Run the offline commands below to verify the setup.
6. Review the references using this program's review procedure.
7. Run the optional live trial and record the observed outcomes.

The shared guide supplies complete dependency, credential, execution, and report instructions.
It creates a clean committed checkout and a new `examples/memory-fidelity/build/trial` folder.
All commands below run from that trial folder.

## Starter inputs

These cases and reference labels are synthetic model proposals, not human judgments.
The three variants share one group and are development cases only.

```json
{
  "name": "memory-fidelity",
  "revision": "starter-1",
  "question": "Does the proposed memory preserve whether the source confirms a decision or merely suggests it?",
  "languages": [
    "en"
  ],
  "cases": [
    {
      "id": "case-01",
      "group": "starter-scenario",
      "evidence": "Dana: We might move the launch to Friday. No decision has been made.",
      "candidate": "Dana suggested Friday for the launch; the date remains undecided.",
      "answer": "supported",
      "reason": "The memory preserves the suggestion and its uncertainty."
    },
    {
      "id": "case-02",
      "group": "starter-scenario",
      "evidence": "Dana: We might move the launch to Friday. No decision has been made.",
      "candidate": "Dana confirmed that the launch is Friday.",
      "answer": "contradicted",
      "reason": "The memory converts an explicit suggestion into a confirmed decision."
    },
    {
      "id": "case-03",
      "group": "starter-scenario",
      "evidence": "Dana: Friday. The preceding question and surrounding conversation are unavailable.",
      "candidate": "Dana confirmed that the launch is Friday.",
      "answer": "insufficient",
      "reason": "The isolated reply does not establish its subject or decision status."
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

1. Ask a reviewer to mark the source words that establish decision status.
2. Label attribution, uncertainty, and source omissions before reading evaluator answers.
3. Keep later information out of cases that assess an earlier source snapshot.

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
| `case-01` | pass | The memory preserves the suggestion and its uncertainty. |
| `case-02` | fail | The memory converts an explicit suggestion into a confirmed decision. |
| `case-03` | review | The isolated reply does not establish its subject or decision status. |

These are proposed reference outcomes, not promised evaluator results.
Record every disagreement and operational error. Do not change a label merely to match the evaluator.
If the provider is unavailable, retain the failure and mark the live trial blocked.

## Inspection and next experiment

Use the printed results path with the inspection commands in the shared guide.
Compare the raw evaluator label with the policy outcome on the same assessment.
Inspect reference disagreements before deciding whether they concern the check, evaluator, or proposed label.

Add attribution changes, scoped exceptions, delayed corrections, and incomplete source retrieval. Use the existing memory support example for integration.
Group candidate memories and corrections from the same source conversation together.
For new data, replace the runner's synthetic metadata and default label provenance before execution.
Keep validation cases untouched while changing requirements or thresholds.
The three starter cases cannot establish a deployment error rate.

## Completion record

Write `CONCLUSION.md` in the results directory using the shared guide's required fields.
Record setup effort, review effort, useful findings, counts, denominators, and unresolved problems.

Continue if reports distinguish a false decision claim from a source that simply lacks enough context.
Source fidelity does not establish source truth. A report does not authorize storing a memory.
