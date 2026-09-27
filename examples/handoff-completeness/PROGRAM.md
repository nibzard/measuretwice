# Handoff completeness experiment program

Status: runnable exploration procedure. No live result or qualification claim is recorded here.
Read [the brief](BRIEF.md) for the broader experiment.

## Goal and required primitives

Detect a missing required next action before testing whether a recipient can continue the task.

One task contract, a handoff, and stated recipient access. Later observation needs a recipient and an observation sheet.
The first trial uses one categorical check with three answers.
`supported` maps to pass, `contradicted` maps to fail, and `insufficient` maps to review.
Operational errors remain errors. None of these outcomes authorizes an application action.

## Procedure

1. Open [the shared setup and runner](../EXPERIMENT_SETUP.md).
2. Set `EXPERIMENT=handoff-completeness` before its clean-checkout commands.
3. Save the JSON below as `experiment.json` in the new trial folder.
4. Save the shared runner as `run.mjs` in that folder.
5. Run the offline commands below to verify the setup.
6. Review the references using this program's review procedure.
7. Run the optional live trial and record the observed outcomes.

The shared guide supplies complete dependency, credential, execution, and report instructions.
It creates a clean committed checkout and a new `examples/handoff-completeness/build/trial` folder.
All commands below run from that trial folder.

## Starter inputs

These cases and reference labels are synthetic model proposals, not human judgments.
The three variants share one group and are development cases only.

```json
{
  "name": "handoff-completeness",
  "revision": "starter-1",
  "question": "Does the candidate handoff contain the next action and verification information required by the supplied task contract?",
  "languages": [
    "en"
  ],
  "cases": [
    {
      "id": "case-01",
      "group": "starter-scenario",
      "evidence": "Task contract: the handoff must name the file to inspect, the command to run, and the expected verification output. Recipient has the repository and terminal access.",
      "candidate": "Inspect notes.txt. Run wc -l notes.txt. Expect 3 lines.",
      "answer": "supported",
      "reason": "The handoff supplies all three required items."
    },
    {
      "id": "case-02",
      "group": "starter-scenario",
      "evidence": "Task contract: the handoff must name the file to inspect, the command to run, and the expected verification output. The candidate is the complete handoff.",
      "candidate": "Inspect notes.txt. No command or verification result is provided.",
      "answer": "contradicted",
      "reason": "The complete handoff explicitly lacks two required items."
    },
    {
      "id": "case-03",
      "group": "starter-scenario",
      "evidence": "Task contract: the handoff must name the file to inspect, the command to run, and the expected verification output. The attached checklist is unavailable.",
      "candidate": "Inspect notes.txt, then follow the attached checklist for the command and expected result.",
      "answer": "insufficient",
      "reason": "The unavailable checklist prevents assessing whether the required information is supplied."
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

1. Have a reviewer assess completeness against the stated contract before viewing evaluator answers.
2. For the observed trial, give a recipient the handoff and record each clarification question.
3. Classify missing information separately from tool failures or recipient access problems.

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
| `case-01` | pass | The handoff supplies all three required items. |
| `case-02` | fail | The complete handoff explicitly lacks two required items. |
| `case-03` | review | The unavailable checklist prevents assessing whether the required information is supplied. |

These are proposed reference outcomes, not promised evaluator results.
Record every disagreement and operational error. Do not change a label merely to match the evaluator.
If the provider is unavailable, retain the failure and mark the live trial blocked.

## Inspection and next experiment

Use the printed results path with the inspection commands in the shared guide.
Compare the raw evaluator label with the policy outcome on the same assessment.
Inspect reference disagreements before deciding whether they concern the check, evaluator, or proposed label.

Run the observed handoff procedure below. Use new tasks for later validation after reviewing the initial results.
Group task variants together and account for repeated recipients when interpreting dependence.
For new data, replace the runner's synthetic metadata and default label provenance before execution.
Keep validation cases untouched while changing requirements or thresholds.
The three starter cases cannot establish a deployment error rate.

## Completion record

Write `CONCLUSION.md` in the results directory using the shared guide's required fields.
Record setup effort, review effort, useful findings, counts, denominators, and unresolved problems.

Continue if failed checks predict missing information that actually blocks the recipient or requires clarification.
The three starter cases test written completeness only. They do not establish whether a person can complete a real task.

## Observed handoff trial

This stage requires another person. An agent-only run cannot establish human handoff usability.
Keep the recipient unaware of evaluator answers until their attempt finishes.

1. Create the task fixture in a separate folder with the commands below.
2. Prepare a new case with the real task path, recipient access, and complete handoff text.
3. Evaluate that case before the recipient attempts the task.
4. Give the recipient only the task fixture and handoff.
5. Record clarification questions and whether the recipient completes the next action.
6. Ask a reviewer whether each blocker came from missing handoff information.
7. Compare the recorded blockers with the earlier check outcomes.

```sh
mkdir observed-task
printf 'alpha\nbeta\ngamma\n' > observed-task/notes.txt
```

State before the trial that the recipient must verify the line count without asking for missing instructions.
Use an observation sheet with `case_id`, `recipient_id`, `clarification`, `blocker_cause`, and `completed` fields.
For the complete handoff, the proposed expectation is successful verification of three lines without clarification.
Missing instructions may cause questions, but that is an empirical outcome to observe rather than assume.
Do not expose the same task variants to one recipient and treat those attempts as independent evidence.
