# Interruption usefulness experiment program

Status: runnable exploration procedure. No live result or qualification claim is recorded here.
Read [the brief](BRIEF.md) for the broader experiment.

## Goal and required primitives

Detect whether an alert meets an explicit recipient rule about actionability and duplicate concerns.

One recipient rule, a bounded message history, incident evidence, and a proposed alert. A recipient must review later real cases.
The first trial uses one categorical check with three answers.
`supported` maps to pass, `contradicted` maps to fail, and `insufficient` maps to review.
Operational errors remain errors. None of these outcomes authorizes an application action.

## Procedure

1. Open [the shared setup and runner](../EXPERIMENT_SETUP.md).
2. Set `EXPERIMENT=interruption-usefulness` before its clean-checkout commands.
3. Save the JSON below as `experiment.json` in the new trial folder.
4. Save the shared runner as `run.mjs` in that folder.
5. Run the offline commands below to verify the setup.
6. Review the references using this program's review procedure.
7. Run the optional live trial and record the observed outcomes.

The shared guide supplies complete dependency, credential, execution, and report instructions.
It creates a clean committed checkout and a new `examples/interruption-usefulness/build/trial` folder.
All commands below run from that trial folder.

## Starter inputs

These cases and reference labels are synthetic model proposals, not human judgments.
The three variants share one group and are development cases only.

```json
{
  "name": "interruption-usefulness",
  "revision": "starter-1",
  "question": "Does the candidate alert meet the supplied recipient interruption criteria and add a concern not already acknowledged?",
  "languages": [
    "en"
  ],
  "cases": [
    {
      "id": "case-01",
      "group": "starter-scenario",
      "evidence": "Recipient rule: interrupt only for a new customer outage with an action assigned to me. Monitor: checkout is unavailable. Incident action: Dana must start rollback. Recipient: Dana. Complete current incident thread: no outage acknowledgment.",
      "candidate": "Checkout is unavailable. Dana, start the assigned rollback.",
      "answer": "supported",
      "reason": "The alert reports a new outage and the recipient has an explicit action."
    },
    {
      "id": "case-02",
      "group": "starter-scenario",
      "evidence": "Recipient rule: do not repeat an acknowledged incident. Recipient: Dana. Thread: Dana says checkout is unavailable and rollback is underway. No new incident facts exist.",
      "candidate": "Checkout is unavailable. Dana, start rollback.",
      "answer": "contradicted",
      "reason": "The alert repeats the acknowledged concern without new information."
    },
    {
      "id": "case-03",
      "group": "starter-scenario",
      "evidence": "Recipient rule: interrupt only for a new customer outage with an action assigned to me. Monitor: checkout is unavailable. Recipient, action owner, and recent thread are unavailable.",
      "candidate": "Checkout is unavailable. Start rollback.",
      "answer": "insufficient",
      "reason": "The evidence cannot establish recipient ownership or whether the concern is new."
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

1. Ask the intended recipient to state their interruption criteria before viewing alerts.
2. Have the recipient label alerts using only the supplied historical context.
3. Record changed preferences as new evidence rather than silently changing earlier labels.

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
| `case-01` | pass | The alert reports a new outage and the recipient has an explicit action. |
| `case-02` | fail | The alert repeats the acknowledged concern without new information. |
| `case-03` | review | The evidence cannot establish recipient ownership or whether the concern is new. |

These are proposed reference outcomes, not promised evaluator results.
Record every disagreement and operational error. Do not change a label merely to match the evaluator.
If the provider is unavailable, retain the failure and mark the live trial blocked.

## Inspection and next experiment

Use the printed results path with the inspection commands in the shared guide.
Compare the raw evaluator label with the policy outcome on the same assessment.
Inspect reference disagreements before deciding whether they concern the check, evaluator, or proposed label.

Replay real candidate alerts in shadow mode. Include delivered alerts and sampled silent cases, with recorded selection methods.
Group alerts from the same incident together. Record each recipient and preference revision.
For new data, replace the runner's synthetic metadata and default label provenance before execution.
Keep validation cases untouched while changing requirements or thresholds.
The three starter cases cannot establish a deployment error rate.

## Completion record

Write `CONCLUSION.md` in the results directory using the shared guide's required fields.
Record setup effort, review effort, useful findings, counts, denominators, and unresolved problems.

Continue if the recipient finds the reported tradeoff between unwanted alerts and missed useful alerts acceptable.
The synthetic recipient rule is not your actual preference. Send no alerts during this experiment.
