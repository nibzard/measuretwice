# Calibration and selection guide

Status: Guide for the implemented v0 package. Published on 24 September
2026.

This guide documents one complete journey. You start from draft checks and
reviewed cases. You state the goals of the owner in one plan. You calibrate
one candidate policy, validate it on independent cases, run it in shadow
mode, and end with the profile hash that your application selects for
enforcement. Every operation in this guide is implemented.

The journey needs two things that code cannot supply. A person reviews the
reference labels. The owner states which errors matter and how much review
is tolerable. The library measures and records. It never decides for you.

Related references:

- The [first-run guide](../../README.md) covers installation and the first
  exploration shadow report.
- The [API reference](../reference/api.md) records every operation, its
  options, and its failure behavior.
- The [CLI reference](../reference/cli.md) records every command of the
  command-line interface (CLI).
- The [artifact reference](../reference/artifacts.md) records the published
  schemas and the reason codes.
- [contracts/README.md](../../contracts/README.md) owns the portable
  contracts behind every artifact.
- [MVP_SPEC.md section 7](../../MVP_SPEC.md#7-ai-assisted-calibration)
  states the calibration workflow that this guide walks through.

The example of this guide is the intervention review check set of
[examples/intervention-review](../../examples/intervention-review/README.md).
Substitute your own definition. The workflow stays the same.

## The journey at one glance

| Stage | What you do | What you get |
| --- | --- | --- |
| Draft | Author the checks and exercise counterexamples. | One validated definition. |
| Label | Collect cases and review the reference labels. | One dataset with provenance and splits. |
| Set goals | Ask the owner which errors matter. | One calibration plan. |
| Fit | Measure the fitting split and search the policy family. | One selected candidate. |
| Validate | Freeze the candidate and measure the holdout. | One qualification report. |
| Inspect and retain | Read the numbers and store the evidence. | One reviewed evidence set. |
| Shadow | Run beside the existing decision path. | Stored reports and one review export. |
| Compare and revise | Compare profiles, then revise the policy alone. | One new profile with its comparison. |
| Select | Record one reviewed profile hash in your application. | Enforcement runs that state it. |

Two loops return you to earlier stages. The review of shadow traffic
produces new labels, so it produces one new dataset revision. One revision
that changes only the policy replays the stored assessments, but its
qualification needs fresh independent evidence.

## Where the journey starts

You start from an exploration profile. It works for evaluation and shadow
runs, and it refuses enforcement. Its starter thresholds carry no
qualification evidence. Read
[From exploration to reliance](../../README.md#from-exploration-to-reliance)
for the entry path.

Calibration replaces the starter thresholds with measured ones. The
resulting profile records the evidence behind every number. The
qualification states what that evidence established, for the declared scope
alone. Use never strengthens it, and no run promotes it.

## 1. Prepare reviewed cases

A dataset is one JSON Lines (JSONL) record file plus one metadata file.
Each record is one line of JavaScript Object Notation (JSON) that holds the
input, the reference labels, and the label provenance. The metadata declares
the population, the sampling method, the revision, the label guidelines,
and the splits.

One record of the intervention example:

```json
{"id": "eu-move-0431", "group": "conv-0431", "tags": ["eu-export"], "input": {"prior_decision": "Customer exports stay in the EU.", "conversation": "We must move the export worker to the US region.", "proposed_message": "The export worker now serves customers from the US region."}, "expected": {"checks": {"decision-conflict": {"answer": "conflict", "outcome": "pass"}, "message-supported": {"answer": "contradicted", "outcome": "fail"}, "adds-information": {"answer": "no"}, "consequence": {"level": "serious"}, "message-length": {"outcome": "pass"}}, "outcome": "fail"}, "label": {"author_type": "human", "origin": "collected", "reviewed": true, "reviewer": "dana@example.org", "reason": "The proposal contradicts the standing export decision."}}
```

Four rules keep this data honest:

- Reference labels never enter `input`. They never reach an evaluator
  request. The loader strips every label field before one run.
- One label records who produced the reference and whether one human
  reviewed it. One coding agent counts as one model author. One model
  proposal without one human review is not reviewed evidence.
- One group holds related cases, such as one conversation. One group
  appears in one split alone, so related cases cannot leak between fitting
  and validation.
- One reference that conflicts with its stated outcome loads, stays as
  written, and is flagged for review. The conflict is never resolved
  silently.

The dataset kind states what the data may support. One
`representative_sample` may support one qualification claim. One
`synthetic_challenge` demonstrates behavior on targeted cases and states no
prevalence. One `development_fixture` supports no claim at all. The dataset
that ships with the intervention example is one development fixture. Write
one new dataset revision before you calibrate.

Load the dataset and read the label review before anything else runs:

```ts
import { loadDataset } from "measuretwice";
import { intervention } from "./.measuretwice/checks/intervention.js";

const dataset = await loadDataset({
  definition: intervention,
  metadata: ".measuretwice/cases/intervention-review.metadata.json",
  records: ".measuretwice/cases/intervention-review.jsonl",
});

dataset.labels.summary.model_unreviewed; // model proposals without review
dataset.labels.summary.human_reviewed;   // reviewed human judgments
dataset.labels.findings;                 // every flagged conflict
```

Only the reviewed counts are reviewed evidence. When `model_unreviewed` is
not zero, one human still owes those records one judgment.

## 2. Write the owner goals into one calibration plan

One plan declares owner-selected goals. There are no universal default
error tolerances, so nobody can write this file for the owner. Ask four
questions and write the answers down:

1. Which errors matter? One wrong accepted intervention and one rejected
   useful intervention are different losses.
2. How much human review is tolerable?
3. Which slices must hold on their own, such as one language or one
   failure type?
4. Which population does the claim cover?

Two metrics cause the most confusion, so name them exactly:

- `false_acceptance_rate` counts predicted passes among reference fail or
  review cases. Its denominator is every labeled case whose reference
  states fail or review.
- `error_among_accepted` counts reference fail and review cases among
  predicted passes. Its denominator is the labeled predicted passes.

The numerator is the same. The denominators differ. One limit without its
metric and its denominator bounds nothing. The plan contract refuses one
constraint that states no minimum for the denominator it constrains.

One complete plan of the intervention example:

```json
{
  "schema_version": 1,
  "id": "intervention-review-plan",
  "name": "Limit wrong interventions, then minimize review",
  "definition": {
    "name": "intervention-review",
    "content_hash": "f733598775a578d50d429142f9affc8cc06c7130c1fa26fb61f432de5c17de1e"
  },
  "intended_population": "Proposed intervention messages in the reviewed support traffic.",
  "sampling_assumptions": "Cases grouped by conversation. Groups are independent draws. Selection is random inside one week of traffic.",
  "confidence_level": 0.95,
  "constraints": [
    {
      "metric": "error_among_accepted",
      "comparison": "at_most",
      "limit": 0.05,
      "basis": "upper_confidence_bound"
    },
    {
      "metric": "false_rejection_rate",
      "comparison": "at_most",
      "limit": 0.1,
      "basis": "upper_confidence_bound"
    }
  ],
  "objective": {
    "metric": "review_rate",
    "direction": "minimize"
  },
  "minimum_samples": {
    "labeled_cases": 200,
    "accepted_cases": 80,
    "reference_pass_cases": 140,
    "reference_fail_or_review_cases": 60
  },
  "important_slices": [
    {
      "tag": "later-corrections",
      "minimum_samples": { "labeled_cases": 30 }
    }
  ],
  "candidate_grid": {
    "accept_cutoffs": [0.6, 0.7, 0.8, 0.9],
    "rejection_cutoffs": [0.6, 0.7, 0.8]
  },
  "evaluator": {
    "evaluator": "jev",
    "adapter_version": "0.1.0",
    "model_requested": "jev-1.13.0"
  },
  "datasets": {
    "fitting": {
      "dataset": "intervention-review-traffic",
      "revision": "2026-10-05.1",
      "split": "fitting"
    },
    "validation": {
      "dataset": "intervention-review-traffic",
      "revision": "2026-10-05.1",
      "split": "holdout"
    }
  }
}
```

Read the plan fields this way:

- The two constraints are the goals that one candidate must satisfy. The
  `upper_confidence_bound` basis compares the upper bound of the interval
  with the limit, not the observed rate alone. Zero observed errors are not
  proof of zero risk.
- The objective states what fitting optimizes after every constraint
  holds. One plan minimizes `review_rate` or maximizes
  `automatic_coverage`. The opposite direction refuses, because it works
  against the owner goal.
- `minimum_samples` keys every count by denominator name. The published
  names are `accepted_cases`, `evaluated_cases`, `labeled_cases`,
  `reference_fail_or_review_cases`, and `reference_pass_cases`. One count
  below one stated minimum yields insufficient evidence, whatever the
  observed rate states.
- `important_slices` names tags that must meet their own evidence
  requirements. One empty required slice yields insufficient evidence.
- Both cutoff families of `candidate_grid` exceed 0.5, so one answer cannot
  pass acceptance and rejection at once. The array order declares the
  enumeration order. The first candidate that meets every constraint and
  optimizes the objective wins one tie.
- The plan binds one definition by content hash, one registered evaluator,
  and two different splits of the declared dataset. One shared group or one
  shared case between the two splits refuses the plan.

An exact-only definition takes no plan. Exact rules have no measured error
source, so no cutoff family fits.

Keep the plan as one reviewed artifact beside the dataset. The calibration
computes its identity, and the candidate profile records the plan hash. One
edited plan later fails the evidence check of the selected profile.

## 3. Run one calibration

`calibrate` runs in the library, because one calibration measures through
the evaluator that the plan names. Only your code can register that
evaluator. The command `measuretwice calibrate` checks the plan and states
that boundary. It refuses with `evaluator_mismatch` and writes no
candidate, because no measurement ran.

Decide where the evidence reports live before you call. The profile records
the references that you state, and you own that storage. One folder that
version control ignores holds no required copy.

```ts
import {
  calibrate,
  createJevEvaluator,
  registerEvaluators,
  type JevCall,
} from "measuretwice";
import { intervention } from "./.measuretwice/checks/intervention.js";

// Your client owns the credential and the network. The library reads none.
declare const systemOne: JevCall;

const registry = registerEvaluators(
  createJevEvaluator({
    call: (request, options) => systemOne(request, options),
    model: "jev-1.13.0",
  }),
);

const calibration = await calibrate(intervention, {
  plan: ".measuretwice/calibration-plan.json",
  metadata: ".measuretwice/cases/intervention-review.metadata.json",
  records: ".measuretwice/cases/intervention-review.jsonl",
  evaluators: registry,
  sampling: "grouped_cases",
  evaluationReports: [
    ".measuretwice/evidence/intervention-fitting.json",
    ".measuretwice/evidence/intervention-qualification.json",
  ],
});
```

The procedure runs in one fixed order:

1. The core validates the definition, the plan, and the dataset. It checks
   every binding of the plan against the loaded world before one case runs.
   One refusal costs no spend.
2. Every case of the fitting split runs as one shadow run through the
   registered evaluator. The report of each run holds the raw assessment of
   every question check.
3. The Rust core searches the permitted candidate family over the stored
   assessments. The search runs on one worker thread, so the Node event
   loop stays free. No reference label, tag, or provenance field reaches
   one evaluator request.
4. The core freezes the selected candidate and validates it on the
   independent split. It re-runs the search over the same fitting
   assessments first, so the validated candidate is the selected one.

The result holds five parts:

- `profile` is the signed candidate artifact. It loads as generated.
- `fitting` is the fitting report. It states every enumerated candidate and
  its constraints. It is development evidence alone.
- `qualification` is the frozen validation. It is absent when no feasible
  candidate exists, because no candidate was frozen and the validation
  budget stayed unspent.
- `runs` holds one run report per measured case.
- `limitations` states the standing limits of these numbers.

Store the artifacts where the references point:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import type { Calibration } from "measuretwice";

declare const calibration: Calibration; // the value that calibrate returned

await mkdir(".measuretwice/evidence", { recursive: true });
await writeFile(
  ".measuretwice/profiles/intervention-candidate.json",
  `${JSON.stringify(calibration.profile, null, 2)}\n`,
  "utf8",
);
await writeFile(
  ".measuretwice/evidence/intervention-fitting.json",
  `${JSON.stringify(calibration.fitting, null, 2)}\n`,
  "utf8",
);
if (calibration.qualification !== undefined) {
  await writeFile(
    ".measuretwice/evidence/intervention-qualification.json",
    `${JSON.stringify(calibration.qualification, null, 2)}\n`,
    "utf8",
  );
}
```

One evaluator failure on one measured case refuses the calibration with the
operational code of the record. One model alias that resolved to two
versions during the measurements refuses with `model_resolution_changed`.
One calculation above the published budget refuses with its count. The
[API reference](../reference/api.md#calibrate) records every refusal.

## 4. Read the qualification, the intervals, and the slices

The qualification states what the evidence established. It selects nothing.

| Status | Meaning | Your next step |
| --- | --- | --- |
| `unvalidated` | Starter thresholds. No qualification evidence. | Explore and shadow only. |
| `insufficient_evidence` | One denominator or one stated minimum was not met. | Collect reviewed cases for the weak denominator or slice. |
| `criteria_not_met` | No feasible candidate existed, or one goal failed on its basis. | Change the checks, the evaluator, or the goals through one new plan. |
| `validated_for_scope` | Every goal held on its declared basis, for the declared scope alone. | Review the evidence and decide whether to select the profile. |

`insufficient_evidence` is one result, not one failure of the procedure. One
small denominator states no bound worth citing, so the procedure states the
counts instead.

Read the numbers beside their denominators:

```ts
import type { Calibration } from "measuretwice";

declare const calibration: Calibration; // the value that calibrate returned

const report = calibration.qualification;
if (report !== undefined) {
  report.evidence.statement;   // the class of the validation split
  report.sample_requirements;  // one row per stated minimum
  report.goals;                // one row per declared goal
  report.scopes;               // one metric set per check, then all_checks
  report.intervals;            // the interval rows of the complete set
  report.slices;               // one row per important slice
  report.reasons;              // one row per calculated reason
}
```

Three rules keep the arithmetic honest:

- Every rate states its numerator and its denominator. One case that
  errored or was skipped stays in the denominator of every rate whose
  population holds it, so one operational failure never improves one rate.
  One zero denominator gives no value.
- Every interval states its method, its confidence level, its sampling
  model, its draws, and its bounds. The method is the Wilson score interval
  of one binomial proportion. The sampling model states what counts as one
  draw: `independent_cases` needs every case of one denominator in its own
  group, and `grouped_cases` makes the group the draw. One dataset whose
  groups contradict the declared model states `unsupported_sampling`
  instead of one bound. Read the complete rules in
  [uncertainty intervals](../../contracts/README.md#uncertainty-intervals).
- Every important slice reports its own metrics and its own intervals,
  computed from its own cases. One empty required slice states no interval
  that implies observed cases. One slice below its stated minimum yields
  insufficient evidence.

Two limits deserve their own words. Zero observed errors is not proof of
zero risk, because the upper bound stays above zero at every denominator.
And no metric set states independence between checks. Several apparently
good checks do not establish the reliability of the complete check set, so
read the `all_checks` row too.

## 5. Inspect the candidate and retain the evidence

Read the candidate before you trust it. The CLI renders it:

```sh
npx measuretwice inspect .measuretwice/profiles/intervention-candidate.json --detail detailed
```

The summary states the intended use, the readiness phrase of the
qualification, and the bound definition. The detailed view adds the
evaluator bindings, the policy parameters, the execution limits, the
qualification evidence, and the recorded performance with its counts, its
intervals, and its limitations. No summary view states one performance
number.

The same view exists in the library:

```ts
import { renderProfileSummary, type Profile } from "measuretwice";

declare const profile: Profile; // the stored candidate artifact

const text = renderProfileSummary(profile, { detail: "detail" });
```

Then verify that the evidence you retained still matches the profile:

```ts
import { checkEvidence } from "measuretwice";

const check = await checkEvidence(".measuretwice/profiles/intervention-candidate.json", {
  plan: ".measuretwice/calibration-plan.json",
  metadata: ".measuretwice/cases/intervention-review.metadata.json",
  records: ".measuretwice/cases/intervention-review.jsonl",
});
check.statement;   // what the check verified, with its counts
check.limitations; // the trust boundary and the retention rule
```

The check verifies content consistency alone. Every recorded identity must
equal the computed identity of the retained copy. One edited plan, one
edited record, or one renamed split fails with `hash_mismatch` at the
recorded reference. The check cannot verify the truth of one forged
dataset, and it reads no evaluation report. It authenticates no label, no
population claim, and no host approval.

Keep one reviewed copy of the plan, the dataset, the fitting report, and
the qualification report beside the selected profile. The default
`.measuretwice/reports/` folder is ignored by version control, so it holds
no required copy.

## 6. Run shadow traffic and collect review

One candidate with `validated_for_scope` may still be one bad idea in your
application. Shadow mode answers that question without touching the
existing decision path.

Load the candidate profile and run one case beside the decision your
application already made:

```ts
import {
  load,
  type CaseInput,
  type EvaluatorRegistry,
  type RunReport,
  type ShadowBaseline,
} from "measuretwice";
import { intervention } from "./.measuretwice/checks/intervention.js";

declare const registry: EvaluatorRegistry;
declare const proposal: {
  readonly id: string;
  readonly input: CaseInput<typeof intervention>;
};
declare function storeReport(report: RunReport): Promise<void>;

const reviewer = await load(intervention, {
  profile: ".measuretwice/profiles/intervention-candidate.json",
  evaluators: registry,
});

// Your decision path decides first, then states its own decision.
const baseline: ShadowBaseline = {
  outcome: "stored",
  revision: "policy-7",
};
const report = await reviewer.run(
  { id: proposal.id, input: proposal.input },
  { mode: "shadow", baseline },
);
await storeReport(report); // your storage
```

Three facts hold for every shadow run:

- The report records the baseline beside the new outcome. No library code
  reads the baseline, compares the two, or acts on either. Agreement with
  the baseline is not correctness.
- One shadow failure, review, skip, or pass changes no stored decision.
  Your decision path keeps its authority.
- One awaited shadow call adds latency inside the total deadline of the
  profile. Route nonblocking work through one queue that your application
  owns. The library starts no detached job.

Export the stored reports for human review:

```ts
import { exportShadowReviews, type RunReport } from "measuretwice";

declare const storedReports: readonly RunReport[]; // your stored shadow reports

const exported = exportShadowReviews(storedReports, {
  baselineMeanings: { stored: "pass", suppressed: "silent", deferred: "review" },
  sample: { seed: "review-2026-10", agreements: 25 },
});
// One review record per line, for the review tool of your application.
exported.jsonl;
exported.sampling; // the seed, the algorithm, and the selection rules
```

The export holds every disagreement, every report without one baseline, and
every report whose candidate outcome is one error. It selects the sampled
agreements through one reproducible seeded rank. One baseline word with no
stated meaning fails, instead of one silent drop. The export holds no raw
case content.

Validate the labels that the reviewers return:

```ts
import { validateReviewLabels, type ShadowReviewExport } from "measuretwice";
import { intervention } from "./.measuretwice/checks/intervention.js";

declare const exported: ShadowReviewExport; // the export the reviewers answered
declare const returnedJsonl: string;        // the complete JSONL return

const validation = validateReviewLabels({
  definition: intervention,
  exported,
  labels: returnedJsonl,
});
validation.summary;  // the provenance counts of the return
validation.findings; // references that conflict with the check meaning
```

Audit the baseline passes and the silent decisions, not only the
suspicious cases. One label that contradicts the baseline outcome of its
case is one valid label, because baseline agreement is not correctness.

The reviewed labels close the first loop. Write them into one new dataset
revision with fresh groups, and calibrate against it.

## 7. Compare profiles and revise the policy

Produce one evaluation report per profile before you compare. The CLI runs
the dataset through the same validated path:

```sh
npx measuretwice evaluate .measuretwice/definitions/intervention-review.json \
  --cases .measuretwice/cases/intervention-review.jsonl \
  --profile .measuretwice/profiles/intervention-candidate.json \
  --purpose independent_validation \
  --out .measuretwice/evidence/intervention-candidate.json
```

`--purpose` declares why the evaluation ran. `independent_validation`
claims validation evidence. `fitting` records development evidence. The
declared purposes of two reports decide the evidence class of their
comparison, so one fitting report makes the whole comparison fitting
evidence.

Compare two stored reports on their matching cases:

```sh
npx measuretwice compare .measuretwice/evidence/intervention-baseline.json \
  .measuretwice/evidence/intervention-candidate.json \
  --out .measuretwice/reports/intervention-comparison.json
```

One case matches only when its identifier and its input hash agree. One
changed input hash never matches, because one changed input needs one new
measurement. The result lists the changed cases with their changed checks
and both aggregate outcomes, beside one metric row per scope with the
counts and the denominators of both sides.

When only the policy should change, run one revision instead of one new
calibration. `revise` verifies every identity first, then replays the
stored fitting assessments under the revised plan:

```ts
import { revise, type Calibration, type EvaluatorRegistry } from "measuretwice";
import { intervention } from "./.measuretwice/checks/intervention.js";

declare const calibration: Calibration; // the prior calibration you stored
declare const registry: EvaluatorRegistry;

const revision = await revise(intervention, {
  prior: calibration,
  plan: ".measuretwice/revision-plan.json",
  metadata: ".measuretwice/cases/intervention-review.metadata.json",
  records: ".measuretwice/cases/intervention-review.jsonl",
  evaluators: registry,
  sampling: "grouped_cases",
  evaluationReports: [".measuretwice/evidence/intervention-revision.json"],
});
revision.reuse.statement;      // what the revision replayed, with counts
revision.comparison.changed;   // the cases the revised policy changes
revision.profile.qualification.status;
```

The validation split decides what the revision measures:

- The holdout that the prior claim consumed replays its stored assessments
  and declares itself development data. The new candidate states
  `insufficient_evidence` with its counts. The prior validation never
  validates one revised policy, however better it looks on development
  data.
- One fresh split of one later dataset revision is measured through the
  registered evaluator, and the frozen validation reads that fresh
  evidence.

One changed question, criterion, schema, projection, preprocessing,
evaluator, adapter, translation, model, or input refuses before one
assessment is replayed. The revision records one new profile with its own
content hash. The prior artifact stays unchanged, and nothing is promoted.

## 8. Select one profile hash for enforcement

Selection is one decision of your application, made through your own code
and configuration review. The library verifies it. It never makes it.

Review the artifacts first:

1. Read the plan. Confirm that the goals are still the goals of the owner.
2. Read the qualification report. Confirm that every goal held on its
   declared basis and that every slice met its minimum.
3. Read the limitations. Confirm that the declared population matches the
   traffic you will enforce on.
4. Confirm that the evidence check passes against the retained artifacts.
5. Record the content hash of the reviewed profile in one reviewed constant
   of your application.

Then state the selection on every enforcement run. Store the reviewed
artifact at one stable path first, and name that path in your
configuration:

```ts
import {
  load,
  type CaseInput,
  type EvaluatorRegistry,
} from "measuretwice";
import { intervention } from "./.measuretwice/checks/intervention.js";

declare const registry: EvaluatorRegistry;
declare const selectedProfileHash: string; // your reviewed configuration
declare const proposal: {
  readonly id: string;
  readonly input: CaseInput<typeof intervention>;
};

const reviewer = await load(intervention, {
  profile: ".measuretwice/profiles/intervention.json",
  evaluators: registry,
});

const report = await reviewer.run(
  { id: proposal.id, input: proposal.input },
  {
    mode: "enforcement",
    selectedProfileHash,
    scope: "support-traffic-2026-10",
  },
);
```

The enforcement gate checks three clauses before any case work starts:

- The qualification must be `validated_for_scope`. One unvalidated or
  insufficient profile refuses with `qualification_insufficient`.
- The requested scope must match the declared scope. One wrong scope
  refuses with `scope_mismatch`.
- The run must state the reviewed content hash that the host selected. One
  absent or foreign selection refuses with `profile_not_selected`.

Your integration must handle every outcome. One `error` and one `skipped`
component never become one pass. One `review` outcome needs one human
decision, and one skip needs one human decision the same way. Handle the
`cancelled` and `deadline_exceeded` completion states beside the aggregate
outcome.

The qualification flag is not one authenticated approval. The runtime
verifies content consistency and the required references. It cannot verify
the truth of one forged dataset. Your review owns the trust.

## What ends one qualification

| Change | Effect |
| --- | --- |
| Question wording, criteria, input schema, or projection | One new definition hash. The prior profile refuses `load` with `definition_mismatch`. Calibrate again. |
| Evaluator code or adapter version | The prior profile refuses with `evaluator_mismatch`. Calibrate again. |
| Translated question | The prior profile refuses with `translation_mismatch`. Calibrate again. |
| One model alias resolving to another version | The enforcement gate refuses with `model_resolution_changed`. Calibrate again. |
| Preprocessing that affects assessments | The compatibility check refuses. Calibrate again. |
| Policy parameters alone | `revise` replays the stored fitting assessments. Fresh independent validation is required before any new claim. |
| Intended scope or population | One hash cannot detect population drift. New evidence for the new scope is required. |
| Reused holdout content | The validation classifies it as development data. One new claim needs fresh validation evidence. |

## When fresh validation evidence is required

Fresh independent evidence is required when any of these holds:

1. You inspected the holdout and tuned again. Repeated tuning after one
   holdout inspection turns that holdout into development data.
2. The validation split content was consumed by one earlier claim. State
   every consumed split in the `previouslyUsed` option of `calibrate`, so
   the frozen validation classifies it correctly.
3. One material change touched the definition, the translation, the
   evaluator, the preprocessing, or the model.
4. The declared scope changed.

State the consumed splits explicitly:

```ts
import { calibrate, loadDataset, type EvaluatorRegistry } from "measuretwice";
import { intervention } from "./.measuretwice/checks/intervention.js";

declare const registry: EvaluatorRegistry;

const dataset = await loadDataset({
  definition: intervention,
  metadata: ".measuretwice/cases/intervention-review.metadata.json",
  records: ".measuretwice/cases/intervention-review.jsonl",
});

const next = await calibrate(intervention, {
  plan: ".measuretwice/calibration-plan.json",
  metadata: ".measuretwice/cases/intervention-review.metadata.json",
  records: ".measuretwice/cases/intervention-review.jsonl",
  evaluators: registry,
  sampling: "grouped_cases",
  evaluationReports: [".measuretwice/evidence/intervention-fitting-2.json"],
  // One holdout that one earlier claim consumed. State it, whatever its name.
  previouslyUsed: dataset.splits.filter((entry) => entry.split === "holdout-2026-09"),
});
```

Keep one record of every qualification claim, its validation split, and its
profile hash. That record is the only way one later claim knows which
content was consumed.

## What one report never authorizes

One passing report authorizes no application action. It states that one
case met the acceptance meaning of every check, under the selected profile.
Your application consumes the report and decides. Delivery, permissions,
storage, and every other action stay in your code.

Three quantities stay separate, and no number substitutes for another:

- Provider confidence is one measurement input of one adapter. It is not
  one measured correctness.
- Baseline agreement is one observation of one shadow run. It is not one
  accuracy.
- One qualification flag states measured evidence for one declared scope.
  It is not one authenticated approval.

Read the complete distinction table in
[outcome and status distinctions](../../contracts/README.md#outcome-and-status-distinctions).

## Checklist before you select one profile

1. Every reference label of the dataset carries one recorded human review.
2. The plan states the goals of the owner, with one metric, one denominator,
   and one minimum for every constrained quantity.
3. The fitting and the validation splits share no group and no case.
4. Every declared goal held on its declared basis, and every important
   slice met its own minimum.
5. The retained plan, dataset, fitting report, and qualification report
   pass `checkEvidence` beside the profile.
6. Shadow traffic ran long enough to exercise the disagreements, and the
   review export produced labels that the checks explain.
7. One reviewed constant of your application names the content hash, and
   one enforcement run states it with one matching scope.

The profile you select is one frozen artifact. It carries the evidence that
justified it, and the evidence stays inspectable for as long as you rely on
it.
