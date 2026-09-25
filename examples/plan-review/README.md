# Plan review example

This is the second application of measuretwice. It shares no domain with
the memory and the intervention examples. One vendor drafts one
implementation plan for one customer. Five checks compare that plan with
two supplied documents: the requirements of the customer and the current
capability documentation. The host decides what happens to the plan.

The example exists to test portability, not to teach one domain. The same
authoring format, the same case records, the same evaluator requests, the
same profile artifacts, and the same report semantics carry one unrelated
workflow. [MVP_SPEC.md](../../MVP_SPEC.md) section 13 asks for this test
before any new abstraction.

Everything runs offline. The test evaluator answers from one scripted
table, so the workflow needs no credential and spends no API budget.

## Files

| File | Content |
| --- | --- |
| [checks/plan.ts](checks/plan.ts) | The definition: the inputs, the four questions, the answers, and the exact rollback rule. |
| [definitions/plan-review.json](definitions/plan-review.json) | The exported portable definition, written by the export script. |
| [export-definition.ts](export-definition.ts) | The trusted export script that writes the JSON definition. |
| [cases/plan-review.metadata.json](cases/plan-review.metadata.json) | The dataset metadata of revision `2026-09-25.1`: two splits and the label guidelines. |
| [cases/plan-review.jsonl](cases/plan-review.jsonl) | Nine case records: five fitting cases and four validation cases. |
| [cases/plan-review-revision.metadata.json](cases/plan-review-revision.metadata.json) | The dataset metadata of revision `2026-09-25.2`, with one fresh validation split. |
| [cases/plan-review-revision.jsonl](cases/plan-review-revision.jsonl) | The same five fitting records and four fresh validation cases. |
| [host.ts](host.ts) | The host side: evaluator registration, plan authoring, shadow runs, evaluation, calibration, revision, evidence check, and storage. |
| [tsconfig.json](tsconfig.json) | The TypeScript build of the example. |

## The checks

The definition declares three inputs: `customer_requirements`,
`capability_notes`, and `proposed_plan`. Every check names the inputs that
it may read in its `using` list:

| Check | Reads | Kind | Accepts |
| --- | --- | --- | --- |
| `requirement-coverage` | `customer_requirements`, `proposed_plan` | Choice | `covered`, reviews `partial` |
| `capability-fit` | `capability_notes`, `proposed_plan` | Choice | `documented`, reviews `unclear` |
| `unrequested-work` | `customer_requirements`, `proposed_plan` | Noul | `no` |
| `delivery-readiness` | all three inputs | Score | `workable` and higher |
| `rollback-section` | `proposed_plan` | exact rule | contains `Rollback` |

The exact rule of this example uses `includes`. The flagship example uses
`maxLength`. Together the two examples exercise every rule keyword of the
v0 contract except `excludes`.

Two checks read the same two inputs, so one adapter may batch the two
questions inside one identical authorized state. The other two question
checks read different sets, so one case still projects three different
authorized input sets.

## The cases

Every case is synthetic. Each one teaches one behavior:

| Case | Split | Teaches | Aggregate |
| --- | --- | --- | --- |
| `atlas-covered-plan` | fit | Every check passes. | Pass |
| `atlas-thin-coverage` | fit | Terse wording still covers every requirement. | Pass |
| `atlas-missed-requirement` | fit | One requirement maps to no step. | Fail |
| `atlas-assumed-export` | fit | The plan asserts one requirement needs no setup. | Fail |
| `atlas-open-mapping` | fit | One mapping stays open and another stays ambiguous. | Review |
| `borealis-clean-plan` | holdout | Every check passes. | Pass |
| `borealis-undocumented-limit` | holdout | The plan exceeds one documented limit. | Fail |
| `borealis-no-rollback` | holdout | The plan holds no rollback section. | Fail |
| `borealis-unclear-region` | holdout | The documentation neither offers nor excludes one region. | Review |
| `cirrus-ready-plan` | fresh holdout | Every check passes. | Pass |
| `cirrus-unrequested-migration` | fresh holdout | One step serves no stated requirement. | Fail |
| `cirrus-doubtful-coverage` | fresh holdout | One conditional step covers no requirement. | Fail |
| `cirrus-sketch-plan` | fresh holdout | The plan lists topics with no owners and no verification. | Fail |

Cases group by customer engagement, because plans of one engagement
correlate. The fitting split holds engagement `engagement-atlas`. The
validation split of revision `2026-09-25.1` holds `engagement-borealis`.
The fresh validation split of revision `2026-09-25.2` holds
`engagement-cirrus`.

## Run it offline

Run the example in this repository. The commands read local files only:

1. `npm install`
2. `npm run build`
3. `npx tsc -p examples/plan-review/tsconfig.json`
4. `node examples/plan-review/build/host.js`

The host prints the shadow results, the evaluation, the calibration, the
revision comparison, and one readable report. It writes every artifact into
`examples/plan-review/reports/`. Git ignores that directory.

The suite [packages/measuretwice/test/example-plan-review.test.ts](../../packages/measuretwice/test/example-plan-review.test.ts)
compiles and runs the same files. It also checks the boundary: the
projected inputs of every evaluator request, the identity of both dataset
revisions, the unvalidated exploration profile, the host-owned storage, and
the private-data defaults of the reports.

## Export the definition

The CLI reads JSON data files and executes no TypeScript source. The
script [export-definition.ts](export-definition.ts) is one trusted
application script that you review:

```sh
node examples/plan-review/build/export-definition.js
npx measuretwice validate examples/plan-review/definitions/plan-review.json
```

The content hash covers the canonical content, so JSON formatting changes
no hash. The committed artifact stays equal to the TypeScript definition,
and the suite checks that equality.

## The existing decision path

The host runs one shadow run beside its existing review. The current
review escalates one plan whenever the plan text contains the phrase
`custom integration`, because custom work needs one exception approval. It
reads no requirements and no capability documentation.

The existing review approves eight of the nine plans of revision one. The
approved plans include one plan that misses one requirement, one plan that
asserts one requirement needs no setup, and one plan with no rollback
section. One shadow run records the existing decision as the baseline and
changes nothing. A baseline is one more measurement, not one reference
answer.

## The measured workflow

The host walks the complete path of the contracts on the synthetic data:

1. Generate one exploration profile and run every case of revision one in
   shadow mode beside the existing review.
2. Evaluate the same dataset under the exploration profile, with the
   declared purpose `exploration`.
3. Author one calibration plan and calibrate one candidate on the fitting
   split. The plan limits the error among accepted plans to one third and
   minimizes the review rate. The search selects the 0.6 accept cutoff,
   which accepts three fitting plans and gets one wrong.
4. Author one revision plan with one tighter error goal and revise the
   policy. The fitting assessments replay from storage, the fresh
   validation split of revision two is measured, and the search selects the
   0.8 accept cutoff.
5. Check the retained evidence of the revised profile against the plan and
   the dataset that the host retains.

The revision comparison names the concrete change. Two fitting plans move
from one pass to one review under the tighter policy. One of them,
`atlas-assumed-export`, is the plan whose reference states one unaddressed
requirement. The tighter policy sends one doubtful plan to one human
instead of approving it.

Both qualification reports state `insufficient_evidence`. The dataset
declares the kind `development_fixture`, so no split of it is one
representative sample and no qualification claim can rest on it. This is
the honest result of one synthetic example. Enforcement refuses both
profiles until one host review selects one content hash of one profile with
measured evidence.

## Labels and provenance

A coding agent proposed every reference label and no human reviewed one.
The dataset records this: `author_type: "model"`, `origin: "synthetic"`,
`reviewed: false`. The loader counts the provenance, so the summary states
`9 model-proposed without one human review`.

Three scripted answers disagree with the reference of their check:

- `atlas-assumed-export` reads one covered plan where the reference states
  one unaddressed requirement.
- `borealis-undocumented-limit` reads one sketch where the reference states
  one workable plan.
- `cirrus-doubtful-coverage` reads one covered plan where the reference
  states one unaddressed requirement.

One further outcome disagrees while the answer agrees:
`atlas-thin-coverage` reviews one plan that the reference accepts, because
the starter 0.8 cutoff abstains on one reported mass of 0.75. The summary
names every disagreement of either kind for review.

Review the labels, then record the reviewer in the label record of each
case. Keep the distinction between one model proposal and one human
judgment.

## What the host keeps

measuretwice assesses and reports. The host keeps every other
responsibility of one delivery review:

- Document retrieval: the host selects and fetches the requirements and the
  capability documentation of one case from its own systems. One missing
  document becomes the answer `unclear` or `partial`, never one invented
  fact.
- Credentials and access: the host owns the evaluator client, the
  credential, and the endpoint. No artifact holds one.
- Storage: the library writes no file. The host stores the profile, every
  report, the plan, and both datasets.
- Actions: the host decides whether one plan goes to the customer, to one
  reviewer, or to one rewrite. One report authorizes no application action.

## Integration friction and missing requirements

This section records what the portability test found. Each entry names the
actual workaround of this example.

1. One calibration plan binds the definition by content hash. The host
   cannot state its goals before the definition exists, and one wording
   edit of one check invalidates every committed plan. This host computes
   the hash through `load` and writes its two plans beside its reports on
   every run. A host that commits its plans needs one regeneration script,
   exactly as the committed definition export of this example does.
2. The scripted test evaluator answers from one flat, ordered step list.
   One workflow that revisits the same cases through several operations
   must state the exact visit order of every case, or must build one
   evaluator per operation with the same identifier and the same adapter
   version. This host does the second. The flagship example hand-rolls the
   same table. That is one repeated need across two applications: one
   scripted table keyed by case identifier would remove the fragility.
   [MVP_SPEC.md](../../MVP_SPEC.md) section 13 asks for this test before
   any new abstraction, so the table stays one recorded candidate and not
   one shipped API.
3. One revision needs one later dataset revision whose fitting records
   stay byte-identical. The host maintains two record files whose first
   five lines must not drift. Nothing checks that drift until `revise`
   refuses with `hash_mismatch`. One helper that derives the next dataset
   revision from one stored one would remove the copy hazard.
4. One binary check reports one value and no distribution, so the
   `probability_mass_v0` family reads its mass as exactly zero or one. No
   candidate of one grid decides one binary check differently, so one whole
   grid dimension leaves `unrequested-work` untouched. This application
   needs no tunable yes or no question, so the check stays binary. A host
   that needs one tunable uncertainty on one yes or no question must author
   it as one categorical question or one ordered scale. The rule surfaces
   when the fitting report shows one check with identical counts under
   every candidate, not through one refusal.
5. The `sampling` option of `calibrate` and `revise` is required and
   changes the statistics. Plans of one engagement correlate, so this host
   states `grouped_cases` and the engagement is the draw. One host that
   states `independent_cases` on grouped data loses every interval bound,
   because one group holds several cases of one denominator. The failure
   cases suite of the repository covers that behavior with correlated
   validation groups. The option is one modeling decision, and the artifact
   records it.
6. The `evaluationReports` option states where the host will store the
   fitting report before that report exists. The profile records the
   reference, so the host must keep its own promise or the recorded
   reference names one absent file. One first run needs one moment of care.
7. One development fixture can never demonstrate enforcement. Both profiles
   of this example state `insufficient_evidence`, so the host selection
   path stays untested here. Demonstrating one selected profile needs
   representative data and one human review, which no synthetic example
   supplies.
8. The `changed` rows of one revision comparison arrive in the record order
   of the dataset file, while the stored fitting runs of the same
   calibration arrive in the identifier order of the split. Both orders are
   stable, and one host that prints the rows needs no assumption about
   either. The type comment of `changed` names one fitting order that the
   rows of this example do not follow, so one reader checks the artifact
   and not the comment alone.

## Run it with Jev, opt-in

The example ships with the scripted test evaluator. To run the same checks
against Jev, install the pinned SDK in your application and register the
Jev adapter. The host owns the client, the credential, and the endpoint.
See the Jev section of the
[intervention review example](../intervention-review/README.md#run-it-with-jev-opt-in)
for the verified steps and costs.

## Next steps

- Add cases from real engagements, review every label, and record the
  reviewer.
- Collect one representative sample before any qualification claim, and
  state the population and the sampling in the metadata.
- Review the recorded friction above before any new shared abstraction.
