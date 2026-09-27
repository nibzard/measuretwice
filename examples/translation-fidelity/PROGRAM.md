# Translation fidelity experiment program

Status: runnable exploration procedure. No live result or qualification claim is recorded here.
Read [the brief](BRIEF.md) for the broader experiment.

## Goal and required primitives

Detect a lost obligation in an English-to-French translation.

An English source, a French translation, and any context needed to resolve meaning. A bilingual reviewer is required for credible references.
The first trial uses one categorical check with three answers.
`supported` maps to pass, `contradicted` maps to fail, and `insufficient` maps to review.
Operational errors remain errors. None of these outcomes authorizes an application action.

## Procedure

1. Open [the shared setup and runner](../EXPERIMENT_SETUP.md).
2. Set `EXPERIMENT=translation-fidelity` before its clean-checkout commands.
3. Save the JSON below as `experiment.json` in the new trial folder.
4. Save the shared runner as `run.mjs` in that folder.
5. Run the offline commands below to verify the setup.
6. Review the references using this program's review procedure.
7. Run the optional live trial and record the observed outcomes.

The shared guide supplies complete dependency, credential, execution, and report instructions.
It creates a clean committed checkout and a new `examples/translation-fidelity/build/trial` folder.
All commands below run from that trial folder.

## Starter inputs

These cases and reference labels are synthetic model proposals, not human judgments.
The three variants share one group and are development cases only.

```json
{
  "name": "translation-fidelity",
  "revision": "starter-1",
  "question": "Does the French candidate preserve the obligation and timing stated by the English source, using supplied context where available?",
  "languages": [
    "en",
    "fr"
  ],
  "cases": [
    {
      "id": "case-01",
      "group": "starter-scenario",
      "evidence": "English source: You must save the file before closing the application.",
      "candidate": "Vous devez enregistrer le fichier avant de fermer l’application.",
      "answer": "supported",
      "reason": "The translation preserves the obligation to save before closing."
    },
    {
      "id": "case-02",
      "group": "starter-scenario",
      "evidence": "English source: You must save the file before closing the application.",
      "candidate": "Vous pouvez enregistrer le fichier après avoir fermé l’application.",
      "answer": "contradicted",
      "reason": "The translation changes obligation to permission and reverses the timing."
    },
    {
      "id": "case-03",
      "group": "starter-scenario",
      "evidence": "English source: You must do it before closing. The action referred to by it is unavailable.",
      "candidate": "Vous devez enregistrer le fichier avant de fermer l’application.",
      "answer": "insufficient",
      "reason": "The source does not establish that the required action is saving the file."
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

1. Ask a bilingual reviewer to identify obligation, action, and timing in both texts.
2. Have the reviewer correct the proposed labels without seeing evaluator answers.
3. Record unresolved linguistic ambiguity rather than forcing agreement.

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
| `case-01` | pass | The translation preserves the obligation to save before closing. |
| `case-02` | fail | The translation changes obligation to permission and reverses the timing. |
| `case-03` | review | The source does not establish that the required action is saving the file. |

These are proposed reference outcomes, not promised evaluator results.
Record every disagreement and operational error. Do not change a label merely to match the evaluator.
If the provider is unavailable, retain the failure and mark the live trial blocked.

## Inspection and next experiment

Use the printed results path with the inspection commands in the shared guide.
Compare the raw evaluator label with the policy outcome on the same assessment.
Inspect reference disagreements before deciding whether they concern the check, evaluator, or proposed label.

Add exceptions, negation, uncertain commitments, and domain terminology. Keep one language pair and domain for the first measured trial.
Group translations and variants from the same source document together.
For new data, replace the runner's synthetic metadata and default label provenance before execution.
Keep validation cases untouched while changing requirements or thresholds.
The three starter cases cannot establish a deployment error rate.

## Completion record

Write `CONCLUSION.md` in the results directory using the shared guide's required fields.
Record setup effort, review effort, useful findings, counts, denominators, and unresolved problems.

Continue if a bilingual reviewer confirms that the reports identify material meaning changes with useful corrections.
Without a bilingual reviewer, report model agreement only. Meaning preservation does not establish stylistic quality.
