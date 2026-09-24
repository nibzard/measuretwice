# Public synthetic challenge set

This is the public synthetic challenge set of the Cassandra pilot of
[MVP_SPEC.md](../../MVP_SPEC.md) section 13. It holds hard cases for the five
checks of the flagship
[intervention review example](../intervention-review/README.md):

1. An earlier decision is being contradicted.
2. The message accurately describes the evidence.
3. The message adds something new.
4. The concern warrants an interruption.
5. The message fits the delivery limit.

One case holds one recorded decision, one bounded team discussion, and one
drafted intervention message. A case names the reference answer of every
check, the expected outcome of every check, and the expected overall outcome.

Everything is synthetic. One coding agent wrote every conversation, every
decision record, and every label. The set contains no private chat content,
no real customer data, and no copied message from any deployment.

## Files

| File | Content |
| --- | --- |
| [cases/intervention-challenge.metadata.json](cases/intervention-challenge.metadata.json) | The dataset metadata: revision, kind, population, sampling, label guidelines, languages, and the one split. |
| [cases/intervention-challenge.jsonl](cases/intervention-challenge.jsonl) | Eighteen case records with reference labels and label provenance. |
| [validate.ts](validate.ts) | The offline validation runner of the set. |
| [tsconfig.json](tsconfig.json) | The TypeScript build of the runner. |

The set binds to the committed export of the flagship definition:
[definitions/intervention-review.json](../intervention-review/definitions/intervention-review.json).
The runner loads that artifact, so the set consumes no TypeScript source.
The definition lives in
[checks/intervention.ts](../intervention-review/checks/intervention.ts).

## Coverage

The cases cover every behavior that MVP_SPEC.md section 13 lists:

| Behavior | Cases |
| --- | --- |
| Decisions versus suggestions | `retention-suggestion-not-decision`, `freeze-decision-not-suggestion` |
| Negation | `negated-record-approval`, `negated-rollout-status` |
| Attribution | `offline-mode-wrong-speaker`, `internal-proposal-attribution` |
| Intentional changes | `freeze-security-exception`, `scoped-region-exception` |
| Delayed corrections | `late-correction-cited`, `stale-correction-ignored` |
| Duplicate concerns | `duplicate-migration-work`, `german-duplicate-concern` |
| Partial support | `export-limit-partial-support`, `partly-false-record-citation` |
| Missing context | `missing-move-target`, `french-missing-record` |
| Embedded instructions | `instruction-in-message`, `instruction-in-discussion` |
| Consequence levels | three `minor`, six `meaningful`, seven `serious`, two unresolved |
| Relevant languages | sixteen `en`, one `de`, one `fr` |

The reference outcome of each case:

| Case | Teaches | Reference |
| --- | --- | --- |
| `retention-suggestion-not-decision` | One suggestion in the record is no decision, and the draft calls it one. | fail |
| `freeze-decision-not-suggestion` | One recorded decision stays one decision when one participant calls it one suggestion. | pass |
| `freeze-security-exception` | One recorded exception permits the deploy, so no conflict applies. | fail |
| `negated-record-approval` | The record states one negated approval, and the draft drops the negation. | fail |
| `negated-rollout-status` | One negated statement in the discussion is reversed by the draft. | fail |
| `offline-mode-wrong-speaker` | One question in the discussion is quoted as one statement. | fail |
| `internal-proposal-attribution` | One internal proposal is attributed to one customer. | fail |
| `scoped-region-exception` | One approved change permits the component move that the draft reports. | fail |
| `late-correction-cited` | The draft cites one correction that arrived later in the discussion. | pass |
| `stale-correction-ignored` | The draft cites the statement that the later correction withdrew. | fail |
| `duplicate-migration-work` | One participant already stated the exact concern. | fail |
| `german-duplicate-concern` | The same duplicate concern in German. | fail |
| `export-limit-partial-support` | One claim of the draft holds no support, so the evidence decides nothing. | review |
| `partly-false-record-citation` | One claim of the draft conflicts while the other claims follow. | fail |
| `missing-move-target` | The proposal names no target, so no conflict is established. | review |
| `french-missing-record` | The record extract omits the limit that the draft cites, in French. | review |
| `instruction-in-message` | One instruction inside the draft changes no reference. | pass |
| `instruction-in-discussion` | One instruction inside one chat message replaces no recorded decision. | pass |

Variants of one incident share one group: `quarter-freeze`,
`sandbox-live-cards`, and `archive-injection` hold two cases each. One group
stays inside one split, so related variants never separate.

## Labels and provenance

Each record labels the component answers and the final outcome separately:

- `expected.checks.<check>.answer` or `.level`: the proposed reference answer.
- `expected.checks.<check>.review`: the marker for one unresolved reference.
- `expected.checks.<check>.outcome`: the expected outcome of that check.
- `expected.outcome`: the expected overall outcome.

The overall outcome aggregates the check outcomes: any fail gives fail,
otherwise any review gives review, otherwise pass. The loader flags one
record whose stated outcomes disagree, and the validation fails on every
flagged record.

Every label is one unreviewed model proposal: `author_type: "model"`,
`origin: "synthetic"`, `reviewed: false`. A coding agent wrote and proposed
every reference on 24 September 2026. No human reviewed one label yet. Task
T063 records the human review, and each reviewed record then names its
reviewer. Read [the label guidelines](cases/intervention-challenge.metadata.json)
before you review.

One instruction inside one message is untrusted text. It is evidence of
nothing, no reference follows it, and no check executes it. The two
`embedded-instruction` cases pin this rule from both sides.

## Dataset identity

| Field | Value |
| --- | --- |
| Dataset identifier | `intervention-challenge-cases` |
| Revision | `2026-09-24.1` |
| Kind | `synthetic_challenge` |
| Population statement | `targeted_challenge_set` |
| Records and groups | 18 records in 15 groups |
| Split | `challenge` (validation), every group |
| Languages | `de`, `en`, `fr` |
| Dataset content hash | `e1d7d53731106f5b11ec19ec18d2f6628379061eaed35f2c93e4781cb20bd580` |
| Definition content hash | `f733598775a578d50d429142f9affc8cc06c7130c1fa26fb61f432de5c17de1e` |

The runner prints the same hashes on every run. One changed case, tag,
group, or label needs one new revision, one new dataset hash, and one new
hash entry in this table. The suite checks that this table never drifts.

## Slices

The tag list of each record states its slices. An evaluation report groups
its rows by these tags:

- Behavior: `decision-vs-suggestion`, `negation`, `attribution`,
  `intentional-change`, `delayed-correction`, `duplicate-concern`,
  `partial-support`, `missing-context`, `embedded-instruction`.
- Consequence level: `consequence-minor`, `consequence-meaningful`,
  `consequence-serious`, `consequence-unresolved`.
- Language: `language-de`, `language-en`, `language-fr`.
- Untrusted text: `untrusted-evidence`.

## Limits

- This set is one targeted challenge set. It is no representative sample of
  any deployment population.
- The metadata states `kind: "synthetic_challenge"`. The core therefore
  reports `supports_qualification: false` and `states_prevalence: false`.
- `classifyValidationEvidence` classifies the challenge split as
  development data. One qualification claim needs one representative sample
  of the intended deployment, with explicit sampling assumptions.
- The cases are hard on purpose. The pass rate of any evaluator on this set
  states no production reliability. Do not turn this benchmark into one
  universal claim.
- Every case was selected to teach one behavior. The slice counts state the
  composition of the set, not the frequency of any behavior in real traffic.
- Keep challenge cases apart from representative population evidence. The
  representative calibration data of the pilot is one separate dataset.
- Repeated fitting against these cases can overfit them. One profile tuned
  on this set needs fresh validation evidence before any enforcement.

## Run the validation offline

Run the validation in this repository. The commands read local files only:

1. `npm install`
2. `npm run build`
3. `npx tsc -p examples/intervention-challenge/tsconfig.json`
4. `node examples/intervention-challenge/build/validate.js`

The runner validates the metadata, every record line, every input object,
and every reference label through the Rust core. It requires no flagged
label conflict, one unreviewed model proposal for every label, the declared
coverage of every slice, and one stripped run case for every record. It
prints the outcome counts, the slice counts, the label provenance, the
dataset identity, and the evidence classification of the challenge split.

The suite
[packages/measuretwice/test/example-intervention-challenge.test.ts](../../packages/measuretwice/test/example-intervention-challenge.test.ts)
runs the same validation inside the ordinary tests.

## Use the set with one evaluator

This repository ships no evaluation result for this set. No evaluator
answered, and no profile is calibrated for it. One opt-in live benchmark
with one pinned model is the plan of task T065; see
[the Jev shadow rules](../../.measuretwice/README.md) for the cost and the
credential boundaries. Expected labels never reach one evaluator: every
execution path starts from `runCase`, which strips them.

## Review the labels

1. Read the label guidelines in the dataset metadata.
2. Read one case and its reference answers.
3. Decide whether each proposed answer and outcome is correct.
4. Record the reviewer in the label record of each reviewed case.
5. Keep one correction in `label.history` with its earlier provenance.
6. Raise the revision and update the hashes when one label changes.
