# Coding-agent review guide

Status: Guide for the implemented v0 package. Published on 24 September
2026.

This page tells one coding agent how to measure, explain, and propose
changes for measuretwice. It continues the
[authoring guide](agent-authoring.md). The library ships no analysis
service, and no command runs one. You run the published library and CLI
operations, then read their artifacts.

One rule covers everything: every number you report comes from one library
or CLI artifact, and you name that artifact. You compute no rate, no
interval, and no significance of your own. Tested Rust code owns the
arithmetic, so one reviewer can trace every claim you make to one recorded
count.

If you direct one coding agent instead of being one, use this page as the
checklist for what it brings back.

Related references:

- The [authoring guide](agent-authoring.md) covers drafting checks and
  cases with honest provenance.
- The [calibration and selection guide](calibration.md) owns the complete
  journey: plan, fit, validate, shadow, compare, select.
- The [API reference](../reference/api.md) records every operation, its
  options, and its failures.
- The [CLI reference](../reference/cli.md) records every command.
- [contracts/README.md](../../contracts/README.md) owns the metrics, the
  intervals, and the reason codes.
- [MVP_SPEC.md section 7](../../MVP_SPEC.md#7-ai-assisted-calibration)
  states the limits of the larger model in this workflow.

## Who does what

| Stage | You, the coding agent | The owner or one reviewer |
| --- | --- | --- |
| Measure | Run the operations and store the artifacts. | Own the credential, the storage, and the spend. |
| Explain | Quote the artifacts with their counts and limits. | Ask the next question. |
| Propose | Write one new artifact and one diff. | Review, edit, or reject. |
| Select | Nothing. | Select one reviewed profile hash in host code. |

## 1. Compute through the library and the CLI

The tools divide the work:

- The CLI runs `validate`, `evaluate` for one exact-only definition,
  `compare`, and `inspect`. It registers no evaluator, so one definition
  with one question check refuses `run`, `evaluate`, and `calibrate` with
  `evaluator_mismatch`. Nothing is missing: the boundary exists because one
  loaded file installs no evaluator and the CLI executes no host code.
- The library runs everything else through one host script that registers
  the evaluator. You may draft that script. The owner reviews it, because
  it holds the client and the credential.

One live call spends one API budget and reads one credential. Run live
measurements only after the owner consents, and state the model version
that answered. Ordinary offline work uses the test evaluators of the
package.

A CLI session. `validate`, `compare`, and `inspect` serve every definition.
`run` and `evaluate` serve one exact-only definition alone, so the second
command uses one exact-only export:

```sh
npx measuretwice validate .measuretwice/definitions/release-notes.json
npx measuretwice evaluate notes-length-rules \
  --cases .measuretwice/cases/notes-length-rules.jsonl \
  --purpose fitting \
  --out .measuretwice/reports/notes-length-fitting.json
npx measuretwice compare .measuretwice/reports/release-notes-baseline.json \
  .measuretwice/reports/release-notes-candidate.json
npx measuretwice inspect .measuretwice/profiles/release-notes-candidate.json --detail detailed
```

The `notes-length-rules` export stands for one definition of exact rules
alone, with no question check. The `release-notes` definition of the
authoring guide holds one question check, so the CLI refuses to run or
evaluate it, and the library script below measures it instead.

A library script over one definition with question checks:

```ts
import {
  createJevEvaluator,
  evaluate,
  load,
  registerEvaluators,
  type JevCall,
} from "measuretwice";
import { releaseNotes } from "./.measuretwice/checks/release-notes.js";

declare const systemOne: JevCall; // the host client owns the credential

const registry = registerEvaluators(
  createJevEvaluator({
    call: (request, options) => systemOne(request, options),
    model: "jev-1.13.0",
  }),
);

const reviewer = await load(releaseNotes, {
  profile: ".measuretwice/profiles/release-notes-exploration.json",
  evaluators: registry,
});

const evaluation = await evaluate(reviewer, {
  metadata: ".measuretwice/cases/release-notes.metadata.json",
  records: ".measuretwice/cases/release-notes.jsonl",
  purpose: "fitting",
  intervals: { sampling: "grouped_cases", confidence_level: 0.95, minimum_samples: 10 },
});
```

State the purpose of every evaluation. `exploration` claims the least,
`fitting` records development evidence, and `independent_validation`
records validation evidence. The declared purposes decide the evidence
class of one comparison, so one fitting report makes the whole comparison
fitting evidence. Read
[calibrate](../reference/api.md#calibrate) and
[revise](../reference/api.md#revise) in the API reference before you run
either, and follow the complete journey in the
[calibration guide](calibration.md#3-run-one-calibration).

Store every artifact the operation returns, beside the evidence it names.
The owner owns that storage, and one ignored report folder holds no
required copy of qualification evidence.

## 2. Explain results with linked evidence

Quote first, interpret second. Every explanation follows seven rules:

1. Every rate names its numerator and its denominator. One rate with one
   zero denominator states no value, and you report the count, not one
   invented zero.
2. Errors and skips stay in the denominator of every rate whose population
   holds them. One operational failure never improves one rate. Say so
   when one summary looks better than its runs.
3. Every interval names its method, its confidence level, and its sampling
   model. One missing bound states its reason: `insufficient_evidence` or
   `unsupported_sampling`.
4. Zero observed errors is not zero risk. The upper bound stays above zero
   at every denominator.
5. `insufficient_evidence` is one result. Report it with its counts. Never
   treat it as one failure, and never rerun cases until one number turns
   acceptable.
6. No metric set states independence between checks. Read the `all_checks`
   row before you summarize one definition as reliable.
7. Quote the `limitations` field beside the numbers, not after them.

Read the metrics and their denominators in
[contracts/README.md](../../contracts/README.md#evaluation-reports).

Read the numbers from the returned artifacts:

```ts
import type { Evaluation } from "measuretwice";

declare const evaluation: Evaluation; // the value that evaluate returned

evaluation.report.metrics; // one metric set per check and all_checks
evaluation.intervals;      // one interval row per metric of every scope
evaluation.population;     // the population facts of the dataset
evaluation.limitations;    // the standing limits of these numbers
```

One summary that one owner can check. The numbers below show the shape of
the summary alone. They are not measurements. Fill every one from one
returned artifact:

```text
release-notes · dataset release-notes-cases revision 2026-09-24.1 · purpose fitting
all_checks: 137 evaluated, 121 labeled, label coverage 0.88
automatic_coverage 0.71 (97/137) · review_rate 0.29 (40/137)
error_among_accepted 3/97 · upper bound <from the interval row> at 95 percent
Limits: <quote evaluation.limitations here>
```

Keep three quantities apart. They never substitute for each other, and the
complete table is
[outcome and status distinctions](../../contracts/README.md#outcome-and-status-distinctions):

- Provider confidence is one measurement input. It is not one measured
  correctness.
- Baseline agreement is one observation of one shadow run. It is not one
  accuracy. Report the disagreement counts and the sampled agreements, and
  keep the audit of baseline passes in the export.
- One qualification flag states measured evidence for one declared scope.
  It is not one authenticated approval.

## 3. Propose changes as reviewable artifacts

Every change you propose is one new file plus one diff, in the review flow
that the project already uses. Completed artifacts never change in place,
and no command edits one stored artifact. One revision is one new content
hash.

| Change | What you write | What happens to the prior evidence |
| --- | --- | --- |
| Question wording, answers, scale, schema, or `using` | One new definition revision and one diff. | The definition hash changes. One prior profile refuses `load` with `definition_mismatch`. One new calibration is required. |
| Evaluator, adapter, translation, model, or preprocessing | One statement of the change and its reason. | The prior profile refuses with `evaluator_mismatch`, `translation_mismatch`, or `model_resolution_changed`. One new calibration is required. |
| Policy parameters alone | One revision plan, then `revise` replays the stored fitting assessments. | One new profile hash. The prior validation never validates the revised policy. One new claim needs fresh independent validation. |
| Goals, limits, or minimums | One question to the owner first. One plan draft after the answer. | One edited plan fails the evidence check of one selected profile with `hash_mismatch`. |

Three rules hold across every row:

- State the cost of the change honestly. One new wording invalidates the
  prior qualification, and one summary that hides that is one false
  summary.
- Never retune against one holdout. One holdout you inspected and tuned
  against is development data. State the consumed splits in the
  `previouslyUsed` option, and read
  [when fresh validation is required](calibration.md#when-fresh-validation-evidence-is-required).
- One goal change starts with one owner decision. One limit that moved
  after you saw the results is one weakened goal, and one candidate that
  qualifies only under it qualifies at nothing.

When one evaluation shows one weak check, the improvement is one normal
proposal: one changed question, one added case, one new revision. The
[calibration guide](calibration.md#7-compare-profiles-and-revise-the-policy)
records the revision operation, and the
[repository development checks](../../.measuretwice/README.md#evaluation-and-improvement)
record one working improvement loop.

## 4. Claims you never make

| Never claim | Because | Say instead |
| --- | --- | --- |
| One metric you computed yourself | Only tested code computes rates and bounds. | "The evaluation report states …" with the field. |
| One result is significant | Significance needs one declared method. Acceptance defines meaning, not probability. | Quote the interval with its method and level. |
| One human label where one model proposed | Provenance keeps the two apart, and the loader counts them. | "N model proposals, M human reviews." |
| One goal was met after the limit moved | Goals are owner decisions. | "The candidate misses the declared limit. One owner decision is required." |
| One profile is now selected or promoted | No run selects, promotes, or rewrites one profile. | "The evidence is ready for review. Selection is one host decision." |
| One accuracy from baseline agreement | Agreement is one observation of one shadow run. | "K disagreements over N runs. Read the export." |
| Production reliability from one synthetic set | The dataset kind states what data supports. | "One synthetic challenge set demonstrates these cases alone." |
| One passing run authorizes one action | One report never authorizes an application action. | "The case met every check. The host decides what happens." |

## Checklist before you report one result

1. Every number names its artifact and its field.
2. Every rate names its numerator and its denominator.
3. Every interval names its method, its level, and its sampling model.
4. Every label claim separates human judgments from model proposals.
5. Every change exists as one new artifact with one diff for review.
6. Nothing was promoted, selected, or authorized.
7. The limits of the data are quoted beside the numbers.

Selection is where your work ends. The owner reviews the plan, the
qualification report, and the limitations, then records one reviewed
profile hash in the application. Read
[the selection steps](calibration.md#8-select-one-profile-hash-for-enforcement)
before you prepare the final evidence for that review.
