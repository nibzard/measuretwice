# Coding-agent authoring guide

Status: Guide for the implemented v0 package. Published on 24 September
2026.

Use this guide to draft checks, inspect cases, and prepare human review.
Start with a requirement and a few contrasting cases.
Add dataset files and calibration goals when you need recorded evaluation evidence.
Work in the owner's project with its existing tools.
The command-line interface (CLI) provides optional file-based operations.

Two rules cover everything else:

- You propose. The owner decides. Every file you write is one draft until
  one human reviews it.
- An unreviewed label remains a model proposal. It cannot establish a human judgment or qualification claim.

If you direct one coding agent instead of being one, give this page to it
and read the owner duties yourself.

Related references:

- The [first-run guide](../../README.md) covers a check, contrasting cases, reports, and the boundary between exploration and reliance.
- The [calibration and selection guide](calibration.md) owns the journey
  from reviewed cases to one selected profile hash.
- The [API reference](../reference/api.md) records every library operation.
- The [CLI reference](../reference/cli.md) records every command.
- [contracts/README.md](../../contracts/README.md) owns the frozen
  artifact contracts.
- [MVP_SPEC.md section 7](../../MVP_SPEC.md#7-ai-assisted-calibration)
  states the eight workflow stages. This page covers the first three.
- The [original architecture record](../../research/03-checks-yaml-architecture.md)
  is historical background for the authoring idea.

## Who does what

| Stage | You, the coding agent | The owner or one reviewer |
| --- | --- | --- |
| Draft | Write the definition and the record of uncovered requirements. | Approve, edit, or reject each check. |
| Exercise | Write counterexamples and ambiguous cases. | Inspect them and correct the record. |
| Label | Prepare the review surface and record the judgments. | Judge each case and sign each label. |
| Set goals | Ask the goal questions and draft the plan. | Answer them and approve the plan. |

You stop at the fourth row. The
[calibration guide](calibration.md) owns fitting, validation, shadow
operation, revision, and selection.

## Start with one requirement

Use the [first-check example](../../examples/first-check/README.md) before preparing a dataset or calibration plan.

1. Identify one requirement and its source.
2. Draft a check that names its evidence inputs and answer meanings.
3. Prepare an acceptable case, an unacceptable case, and a missing-evidence case.
4. Run an exploration profile and show each case beside its report.
5. Record disagreements and inspect their evidence, answer meanings, and decision rules.
6. Propose a revision and repeat the cases under a new profile.

Keep proposed references separate from the case input.
State that the profile is unvalidated and that proposed labels are unreviewed.
A scripted evaluator verifies execution and reporting. It does not assess changed text.
Use a real evaluator to investigate semantic behavior.
Its answers still require evaluation against independently reviewed references before qualification.

When you change a requirement, the old profile fails its definition binding.
The [requirement revision example](../../examples/first-check/README.md#revise-the-requirement) shows this failure and the next exploration run.
Changing numerical rules uses the separate [policy revision workflow](../../examples/plan-review/README.md).

The remaining sections explain check authoring, coverage, recorded datasets, and the handoff for calibration.

## 1. Draft narrow checks from the requirements

Read the requirement sources of the owner first. Typical sources are one
product specification, team standards, one issue discussion, and examples
of good and bad output. Quote each requirement with its source, so one
reviewer can trace every check back.

For each requirement, answer four questions before you write any code:

1. What can go wrong here?
2. Can ordinary code decide it exactly?
3. Does it need one semantic judgment over evidence?
4. Which inputs does that judgment read?

Then apply three rules:

- Prefer one exact rule when code can decide. The v0 rules are `maxLength`,
  `includes`, and `excludes` on one string input. Never ask one model about
  one length. One definition of exact rules alone needs no evaluator, no
  profile entry, and no calibration. The CLI measures it end to end.
- Split one semantic requirement into narrow checks. One check holds one
  question. Write "Does the message conflict with one standing decision?"
  and "Does the message follow from the evidence?", not "Is this message
  good?".
- Name the evidence. The `using` list of each check names the inputs it may
  read, and one evaluator request carries nothing more.

Before proposing labels, follow [the evidence preparation guide](evidence.md).
Keep candidate statements complete and supply evidence for every material claim.
The [first-check example](../../examples/first-check/README.md) runs without dataset files or profile storage.

The definition states meaning alone. It names no evaluator, no model, and
no numerical cutoff. One generated profile owns those, and the owner
inspects it separately.

One number stays yours to write: the bound of one exact rule, such as
`maxLength: 1800` below, is part of the requirement and lives in the
definition. That bound is no evaluator cutoff. One cutoff belongs to one
profile, and no step of this guide writes one.

Author with `defineChecks` and TypeBox:

```ts
import Type from "typebox";
import { defineChecks } from "measuretwice";

export const releaseNotes = defineChecks({
  version: 1,
  name: "release-notes",
  when_uncertain: "review",
  inputs: Type.Object(
    {
      change_log: Type.String({ minLength: 1, maxLength: 4000 }),
      draft_notes: Type.String({ minLength: 1, maxLength: 2000 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "claims-match-log",
      name: "Every stated change appears in the change log",
      using: ["change_log", "draft_notes"],
      question: "Does every stated change in the draft notes agree with the change log?",
      answers: {
        matched: "Every stated change matches one change-log entry.",
        unmatched: "One stated change names no change-log entry.",
        contradicted: "One stated change conflicts with its change-log entry.",
      },
      accept: "matched",
      review: "unmatched",
    },
    {
      id: "notes-length",
      name: "The notes fit the delivery limit",
      using: ["draft_notes"],
      rule: { maxLength: 1800 },
    },
  ],
});
```

The checks above cover one categorical question and one exact rule. Read
the complete authoring rules in the
[API reference](../reference/api.md#definechecks) and the
[definition contract](../../contracts/README.md#definition-contract). The
rules that reject the most drafts:

- Each check states exactly one of `question` or `rule`.
- One question states named `answers` or one ordered `scale`, never both.
- The answer keys `yes` and `no` alone declare one binary question.
- `accept` and `review` name declared answers, and the two sets stay
  disjoint. Every other answer is unacceptable.
- One scale accepts through `accept.at_least`. Higher levels accept too.
- Every top-level input is required, and the root schema sets
  `additionalProperties: false`.
- No callbacks, no transforms, no custom validators. They fail with
  `nonportable_value` before any artifact exists.
- Identifiers hold at most 64 characters: lowercase segments joined by
  hyphens.

Keep each input inside one bound that its check can assess. One question
check with the Jev adapter holds at most 32,000 UTF-8 bytes of state and
question, and nothing above the bound truncates: it refuses with
`oversized_input`.

See the flagship check set for the remaining shapes:
[examples/intervention-review](../../examples/intervention-review/README.md)
covers one yes or no question, one ordered scale, and differing `using`
lists.

`defineChecks` validates the definition through the Rust core without an evaluator or provider call.
Use the returned definition directly with the library. A JSON export is optional.

For CLI validation or another language, export JavaScript Object Notation (JSON) with the project's trusted script:

```sh
npx measuretwice validate .measuretwice/definitions/release-notes.json
```

`validate` inspects that exported definition without an evaluator or provider call.
Fix an invalid definition. Preserve approved answer meanings when you correct its structure.

The definition is data. One hostile `script`, `tool`, `permission`, or
`plugin` field inside one generated file rejects as data, and nothing
executes. You cannot authorize one tool through one check file.

## 2. Report every uncovered requirement

Your draft is one proposal, and no proposal covers everything. Write one
record that states the coverage of each requirement. Keep it beside the
definition, for example
`.measuretwice/checks/release-notes.coverage.md` or one folder that your
owner assigns, and link it from the README of the folder.

| Requirement | Check | Status |
| --- | --- | --- |
| Every stated change appears in the change log | `claims-match-log` | Covered. |
| The notes fit the delivery limit | `notes-length` | Covered. |
| The notes name the owning team | none | Uncovered. The owner decides. |
| The notes use one release template | none | Uncovered. An exact rule may fit. |

Three rules keep the record honest:

- One requirement with no check stays visible. Never claim complete
  coverage and never let one passing run imply it.
- One row never invents one requirement. Each row names its source.
- One check never stretches over two requirements. Propose one second
  check instead.

One uncovered requirement needs one owner decision: add one check, accept
the gap, or change the requirement. Record the decision and its date in
the same file, so the next revision starts from one known state.

## 3. Propose counterexamples and ambiguous cases

One definition that never met one hard case proves nothing. Before anyone
collects labels, write cases that exercise the draft:

- One counterexample per meaningful answer. Write one case for each answer
  label and each important scale level, including the unacceptable ones.
  The `contradicted` answer above needs one case where the notes conflict
  with the log, not only cases where they match.
- Ambiguous cases on purpose. Cover missing evidence, partial support,
  attribution, negation, intentional changes, delayed corrections, and
  duplicated concerns. The public
  [challenge set](../../examples/intervention-challenge/README.md) shows
  one complete coverage table of these behaviors.

For an exploration run, ordinary case objects need only an identifier and the declared inputs.
Keep proposed references outside the input, as the [first example](../../examples/first-check/cases.mjs) shows.

When you need saved evaluation data, write records in the frozen case contract.
Each record holds a complete case, references, and label provenance:

```json
{"id": "log-omits-fix", "group": "log-omits-fix", "tags": ["missing-entry"], "input": {"change_log": "Release 1.4: fixed the login timeout; added the export filter.", "draft_notes": "Release 1.4: fixed the login timeout, added the export filter, and sped up the search index."}, "expected": {"checks": {"claims-match-log": {"answer": "unmatched", "outcome": "review"}, "notes-length": {"outcome": "pass"}}, "outcome": "review"}, "label": {"author_type": "model", "origin": "synthetic", "reviewed": false, "reason": "The change log names no search-index change, so one stated change names no entry."}}
```

The provenance rules hold for every record you write:

- `author_type` is `model`. One coding agent counts as one model author.
- `reviewed` is `false`. One human review turns it `true` and names the
  reviewer. You never mark your own proposal reviewed.
- `origin` is `synthetic` for one written case and `collected` for one
  case taken from real traffic. State which one holds.
- `reason` cites the evidence that decides the reference, so one reviewer
  can check it against the input.
- Every reference answer and expected outcome stays inside `expected`, and
  the provenance stays inside `label`. Nothing of either enters `input`.
  The input schema rejects one extra field, and one evaluator treats every
  supplied string as untrusted evidence, never as one instruction.

For a saved dataset, write its metadata file beside the records. The
[artifact reference](../reference/artifacts.md#one-case-record-and-its-reference-shapes)
shows one complete record and one complete metadata file, with the required
fields of each. Two fields carry the most weight:

- `kind` is `development_fixture` while you draft. One targeted challenge
  set states `synthetic_challenge`. Neither kind supports one performance
  claim. Only one `representative_sample` may support one qualification
  claim, and one owner decides when that is true.
- `intended_population` and `sampling_method` state what the data is.
  Write "written by one coding agent to cover the listed failure types",
  not one population claim.

Group related cases by their conversation or source. One group appears in
one split alone, so related cases cannot leak between fitting and
validation later.

Before evaluating saved records, validate the complete dataset offline:

```ts
import { loadDataset } from "measuretwice";
import { releaseNotes } from "./.measuretwice/checks/release-notes.js";

const dataset = await loadDataset({
  definition: releaseNotes,
  metadata: ".measuretwice/cases/release-notes.metadata.json",
  records: ".measuretwice/cases/release-notes.jsonl",
});

dataset.labels.summary.model_unreviewed; // your proposals, not evidence
dataset.labels.summary.human_reviewed;   // zero until one human signs
dataset.labels.findings;                 // every flagged conflict
```

Fix one invalid case by fixing the case. Never edit one record to silence
one finding, and never resolve one flagged conflict between one reference
answer and its stated outcome. One conflict stays as written, and one human
reviews it.

List disagreements between report outcomes and proposed references before the handoff.
With a real evaluator, inspect the check, evidence, assessment, and decision rules for each disagreement.
With a scripted evaluator, a disagreement concerns fixture consistency or execution behavior; it measures no semantic quality.
Use the [test evaluator reference](../reference/api.md#test-evaluators) for the shape of a scripted step.
Preserve unresolved findings for human review.

## 4. Hand the labels and the goals to humans

Label collection stays human work. You prepare it, and three rules bound
your part:

- You prepare one review surface, never one judgment. For each case, show
  the input, your proposed reference, your reason, and the open questions.
  Put the disagreements and the ambiguous cases first.
- One human judges. Record the result with its own provenance: the
  judgment names its reviewer, and one correction moves your earlier record
  into `label.history`. The original provenance stays readable after every
  correction.
- One ambiguous case may take one review marker as its reference. One
  reviewer who writes "this cannot be decided from the evidence" produced
  one valid label, not one failure.

Read the complete label rules in
[the calibration guide](calibration.md#1-prepare-reviewed-cases) and the
[case contract](../../contracts/README.md#case-records-and-datasets).

The calibration goals are one owner decision in the same way. Ask the four
questions of the
[calibration guide](calibration.md#2-write-the-owner-goals-into-one-calibration-plan):
which errors matter, how much review is tolerable, which slices must hold,
and which population the claim covers. Then draft the plan from the answers
alone. Every metric, limit, and minimum in one plan comes from the owner.
There are no default tolerances for you to fill in, and one limit you chose
because one candidate passes it is one weakened goal, not one plan.

You may draft the plan file. The owner reviews it before one calibration
reads it, and one edited plan later fails the evidence check of one
selected profile.

## What you never do while authoring

| Never | Do this instead |
| --- | --- |
| Present one model proposal as one human judgment. | Keep `reviewed: false` until one human signs. |
| State one performance number about your cases. | State the dataset kind and the provenance counts. |
| Put one reference label inside `input`. | Keep references in `expected` and `label`. |
| Name one evaluator or one cutoff inside one definition. | Leave meaning in the definition. One profile owns the numbers. |
| Execute code or authorize one tool through one generated file. | Definitions are data. Nothing in them runs. |
| Change one approved check silently. | Propose one diff. The owner reviews it. |
| Claim one requirement is covered when no check decides it. | Write the uncovered row. The owner decides. |

## Deliverables of one authoring session

For exploration, deliver:

1. A validated definition module.
2. Contrasting cases with separately recorded proposed references.
3. Readable reports and unresolved findings.
4. A coverage record when the session addresses several requirements.

When the owner asks for calibration, also deliver:

1. A saved dataset with metadata and label provenance.
2. A review surface for human judgments.
3. A plan draft based on the owner's stated goals.

Export the definition to JSON when the CLI, another language, or artifact storage needs it.

Every item is one draft for review. None of it qualifies one profile, and
none of it authorizes one application action. When the labels carry human
reviews, continue with the [calibration guide](calibration.md).
