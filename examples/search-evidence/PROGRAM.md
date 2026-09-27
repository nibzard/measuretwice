# Search evidence sufficiency experiment program

Status: runnable exploration procedure. No live result or qualification claim is recorded here.
Read [the brief](BRIEF.md) for the broader experiment.

## Goal and required primitives

Distinguish a passage that answers a question from one that merely discusses the topic.

One question, its target scope, and one retrieved passage. Use a fixed local collection before adding retrieval execution.
The first trial uses one categorical check with three answers.
`supported` maps to pass, `contradicted` maps to fail, and `insufficient` maps to review.
Operational errors remain errors. None of these outcomes authorizes an application action.

## Procedure

1. Open [the shared setup and runner](../EXPERIMENT_SETUP.md).
2. Set `EXPERIMENT=search-evidence` before its clean-checkout commands.
3. Save the JSON below as `experiment.json` in the new trial folder.
4. Save the shared runner as `run.mjs` in that folder.
5. Run the offline commands below to verify the setup.
6. Review the references using this program's review procedure.
7. Run the optional live trial and record the observed outcomes.

The shared guide supplies complete dependency, credential, execution, and report instructions.
It creates a clean committed checkout and a new `examples/search-evidence/build/trial` folder.
All commands below run from that trial folder.

## Starter inputs

These cases and reference labels are synthetic model proposals, not human judgments.
The three variants share one group and are development cases only.

```json
{
  "name": "search-evidence",
  "revision": "starter-1",
  "question": "Does the candidate passage supply enough evidence to answer the question for the stated product version and scope?",
  "languages": [
    "en"
  ],
  "cases": [
    {
      "id": "case-01",
      "group": "starter-scenario",
      "evidence": "Question: What is the default request timeout in version 2? Required scope: version 2.",
      "candidate": "Version 2 reference: requests time out after 10 seconds unless timeout_ms is set.",
      "answer": "supported",
      "reason": "The passage gives the default for the required version."
    },
    {
      "id": "case-02",
      "group": "starter-scenario",
      "evidence": "Question: What is the default request timeout in version 2? Required scope: version 2.",
      "candidate": "Version 1 reference only: requests time out after 5 seconds. This page does not describe version 2.",
      "answer": "contradicted",
      "reason": "The passage explicitly covers an incompatible version."
    },
    {
      "id": "case-03",
      "group": "starter-scenario",
      "evidence": "Question: What is the default request timeout in version 2? Required scope: version 2.",
      "candidate": "Version 2 supports configurable request timeouts through timeout_ms.",
      "answer": "insufficient",
      "reason": "The passage is relevant but states no default value."
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

1. Ask a reviewer to identify the exact passage span that answers each question.
2. Label scope mismatch separately from missing evidence.
3. Keep reference answers and explanations outside the evaluator input fields.

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
| `case-01` | pass | The passage gives the default for the required version. |
| `case-02` | fail | The passage explicitly covers an incompatible version. |
| `case-03` | review | The passage is relevant but states no default value. |

These are proposed reference outcomes, not promised evaluator results.
Record every disagreement and operational error. Do not change a label merely to match the evaluator.
If the provider is unavailable, retain the failure and mark the live trial blocked.

## Inspection and next experiment

Use the printed results path with the inspection commands in the shared guide.
Compare the raw evaluator label with the policy outcome on the same assessment.
Inspect reference disagreements before deciding whether they concern the check, evaluator, or proposed label.

Use questions answerable from repository documents. Include actual search results and a separate set of deliberately incomplete passages.
Group related questions and source documents together across dataset splits.
For new data, replace the runner's synthetic metadata and default label provenance before execution.
Keep validation cases untouched while changing requirements or thresholds.
The three starter cases cannot establish a deployment error rate.

## Completion record

Write `CONCLUSION.md` in the results directory using the shared guide's required fields.
Record setup effort, review effort, useful findings, counts, denominators, and unresolved problems.

Continue if reports distinguish sufficient evidence, incompatible scope, and relevant but incomplete passages.
This first trial does not run a search engine, measure retrieval completeness, or verify the truth of a source.
