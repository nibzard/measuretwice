# Code change review experiment program

Status: runnable exploration procedure. No live result or qualification claim is recorded here.
Read [the brief](BRIEF.md) for the broader experiment.

## Goal and required primitives

Detect a missing error branch in a small function before attempting repository-wide review.

One function requirement, a bounded code excerpt, and a candidate implementation. No code execution is needed for the first assessment.
The first trial uses one categorical check with three answers.
`supported` maps to pass, `contradicted` maps to fail, and `insufficient` maps to review.
Operational errors remain errors. None of these outcomes authorizes an application action.

## Procedure

1. Open [the shared setup and runner](../EXPERIMENT_SETUP.md).
2. Set `EXPERIMENT=code-change-review` before its clean-checkout commands.
3. Save the JSON below as `experiment.json` in the new trial folder.
4. Save the shared runner as `run.mjs` in that folder.
5. Run the offline commands below to verify the setup.
6. Review the references using this program's review procedure.
7. Run the optional live trial and record the observed outcomes.

The shared guide supplies complete dependency, credential, execution, and report instructions.
It creates a clean committed checkout and a new `examples/code-change-review/build/trial` folder.
All commands below run from that trial folder.

## Starter inputs

These cases and reference labels are synthetic model proposals, not human judgments.
The three variants share one group and are development cases only.

```json
{
  "name": "code-change-review",
  "revision": "starter-1",
  "question": "Does the candidate implement the supplied function requirement, including its specified failure behavior?",
  "languages": [
    "en"
  ],
  "cases": [
    {
      "id": "case-01",
      "group": "starter-scenario",
      "evidence": "Request: getName(user) returns user.name. If user is null, return \"unknown\". The supplied excerpt is the complete function.",
      "candidate": "function getName(user) { return user === null ? \"unknown\" : user.name; }",
      "answer": "supported",
      "reason": "The complete function handles the stated null case and returns the name otherwise."
    },
    {
      "id": "case-02",
      "group": "starter-scenario",
      "evidence": "Request: getName(user) returns user.name. If user is null, return \"unknown\". The supplied excerpt is the complete function.",
      "candidate": "function getName(user) { return user.name; }",
      "answer": "contradicted",
      "reason": "The complete function accesses a property on null instead of returning the required fallback."
    },
    {
      "id": "case-03",
      "group": "starter-scenario",
      "evidence": "Request: getName(user) returns user.name. If user is null, return \"unknown\". Only the changed line is supplied; surrounding guards are unavailable.",
      "candidate": "return user.name;",
      "answer": "insufficient",
      "reason": "The excerpt cannot establish whether another line handles null."
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

1. Ask a developer to inspect each complete function against the request.
2. Keep the partial excerpt labeled unresolved unless the missing context becomes available.
3. Record any executable regression test separately from the semantic assessment.

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
| `case-01` | pass | The complete function handles the stated null case and returns the name otherwise. |
| `case-02` | fail | The complete function accesses a property on null instead of returning the required fallback. |
| `case-03` | review | The excerpt cannot establish whether another line handles null. |

These are proposed reference outcomes, not promised evaluator results.
Record every disagreement and operational error. Do not change a label merely to match the evaluator.
If the provider is unavailable, retain the failure and mark the live trial blocked.

## Inspection and next experiment

Use the printed results path with the inspection commands in the shared guide.
Compare the raw evaluator label with the policy outcome on the same assessment.
Inspect reference disagreements before deciding whether they concern the check, evaluator, or proposed label.

Add real completed changes with explicit requirements. Preserve each request, relevant surrounding code, and independently reviewed findings.
Group revisions and variants of the same change together.
For new data, replace the runner's synthetic metadata and default label provenance before execution.
Keep validation cases untouched while changing requirements or thresholds.
The three starter cases cannot establish a deployment error rate.

## Completion record

Write `CONCLUSION.md` in the results directory using the shared guide's required fields.
Record setup effort, review effort, useful findings, counts, denominators, and unresolved problems.

Continue if reports identify concrete missed requirements without treating missing code as a proven defect.
The first trial does not prove code correctness, execute candidate code, or authorize a merge.
