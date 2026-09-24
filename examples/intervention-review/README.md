# Intervention review example

This is the flagship example of measuretwice. One assistant drafts one
intervention message for one team discussion. Five checks decide whether
the draft is ready for the host to consider:

1. An earlier decision is being contradicted.
2. The message accurately describes the evidence.
3. The message adds something new.
4. The concern warrants an interruption.
5. The message fits the delivery limit.

Everything runs offline. The test evaluator answers from one scripted
table, so the workflow needs no credential and spends no API budget.

## Files

| File | Content |
| --- | --- |
| [checks/intervention.ts](checks/intervention.ts) | The definition: the inputs, the four questions, the answers, and the exact length rule. |
| [definitions/intervention-review.json](definitions/intervention-review.json) | The exported portable definition, written by the export script. |
| [export-definition.ts](export-definition.ts) | The trusted export script that writes the JSON definition. |
| [cases/intervention-review.metadata.json](cases/intervention-review.metadata.json) | The dataset metadata: revision, kind, one split, and the label guidelines. |
| [cases/intervention-review.jsonl](cases/intervention-review.jsonl) | Six case records with reference labels and label provenance. |
| [host.ts](host.ts) | The host side: evaluator registration, profile generation, shadow runs, report storage, and the printed summary. |
| [tsconfig.json](tsconfig.json) | The TypeScript build of the example. |

## The checks

The definition declares three inputs: `prior_decision`, `conversation`,
and `proposed_message`. Every check names the inputs that it may read in
its `using` list, so one request never carries one input that its check
did not declare:

| Check | Reads | Kind | Accepts |
| --- | --- | --- | --- |
| `decision-conflict` | `prior_decision`, `conversation` | Choice | `conflict`, reviews `unclear` |
| `message-supported` | all three inputs | Choice | `supported`, reviews `incomplete` |
| `adds-information` | `conversation`, `proposed_message` | Noul | `no` |
| `consequence` | all three inputs | Score | `meaningful` and higher |
| `message-length` | `proposed_message` | exact rule | at most 900 code points |

The four question checks map onto the three Jev primitives: named answers
become Choice, the two answers `yes` and `no` become Noul, and the ordered
scale becomes Score. The definition names no primitive and no provider.
The profile owns the evaluator binding and the decision policy, so the
same requirements run unchanged against another evaluator.

The two `using` lists differ on purpose, so the checks cannot share one
call: `decision-conflict` reads the decision and the discussion,
`adds-information` reads the discussion and the draft, and the other two
question checks read all three inputs. One case projects three different
authorized input sets. The adapter sends one question per request, and it
batches questions only inside one identical authorized state.

The length rule runs in code inside the Rust core. It needs no evaluator,
no statistical calibration, and no profile entry.

## The cases

The six cases are synthetic. Each one teaches one behavior:

| Case | Teaches | Aggregate |
| --- | --- | --- |
| `eu-move-new-concern` | Every check passes. | Pass |
| `eu-move-already-discussed` | The discussion acknowledged the concern, so the draft adds nothing new. | Fail |
| `eu-move-overstated-record` | One claim of the draft conflicts with one explicit statement. | Fail |
| `eu-move-replaced-decision` | The team replaced the earlier decision, so no conflict applies. | Fail |
| `eu-move-unrecorded-decision` | The notes record no final decision, so the evidence decides nothing. | Review |
| `eu-move-verbose-message` | Every question passes and the exact length rule fails the draft. | Fail |

No check compensates for another. The aggregate fails when any check
fails, whichever check it is. Three cases pass the consequence check and
still fail, and the printed summary names them: a serious consequence
cannot carry one duplicated concern, one unsupported claim, or one draft
that breaks the delivery limit.

The missing-evidence case shows the third outcome. Two answers select the
review labels `unclear` and `incomplete`, and one spread distribution
meets neither cutoff. The aggregate reviews, and the report states what
needs one human decision.

## Run it offline

Run the example in this repository. The commands read local files only:

1. `npm install`
2. `npm run build`
3. `npx tsc -p examples/intervention-review/tsconfig.json`
4. `node examples/intervention-review/build/host.js`

The host prints the profile, one line per case, the review item, and the
readable reports of the duplicated and the missing-evidence case. It
writes the profile and one report per case into
`examples/intervention-review/reports/`. Git ignores that directory.

The suite [packages/measuretwice/test/example-intervention-review.test.ts](../../packages/measuretwice/test/example-intervention-review.test.ts)
compiles and runs the same files. It also checks the boundary: the
projected inputs of every evaluator request, the unvalidated profile, the
recorded baselines, the host-owned storage, and the private-data defaults
of the reports.

## Export the definition

The CLI reads JSON data files and executes no TypeScript source. The
script [export-definition.ts](export-definition.ts) is one trusted
application script that you review. It serializes the result of
`defineChecks` and writes the committed artifact:

```sh
node examples/intervention-review/build/export-definition.js
npx measuretwice validate examples/intervention-review/definitions/intervention-review.json
```

The content hash covers the canonical content, so JSON formatting changes
no hash. The committed artifact stays equal to the TypeScript definition,
and the suite checks that equality.

## The existing decision path

The host runs one shadow run beside its existing policy. The current
policy interrupts whenever the drafted message contains the phrase
"conflicts with". It reads no decision record and no discussion, so it
cannot tell one acknowledged concern, one replaced decision, or one
overstated claim from one new conflict. Five drafts hold the phrase, and
four of them fail the checks.

One shadow run records the existing decision as the baseline and changes
nothing. The report states the baseline beside the new outcome, and no
field states one agreement or one accuracy. A baseline is one more
measurement, not one reference answer.

## Labels and provenance

A coding agent proposed every reference label and no human reviewed one.
The dataset records this: `author_type: "model"`, `origin: "synthetic"`,
`reviewed: false`. The loader counts the provenance, so the summary states
`6 model-proposed without one human review`.

- The scripted answers of the test evaluator are synthetic adapter output.
  No model ran, and nothing was measured.
- One scripted answer disagrees with its reference label: the
  replaced-decision case reads one conflict where the record states one
  replacement. The summary names it for review.
- Do not read the six outcomes as one performance number.
- Enforcement mode refuses the exploration profile with
  `qualification_insufficient`. One profile needs measured evidence and one
  host selection before any run enforces.

Review the labels, then record the reviewer in the label record of each
case. Keep the distinction between one model proposal and one human
judgment.

## What the host keeps

measuretwice assesses and reports. The host keeps every other
responsibility of one intervention system:

- Source selection: the host supplies the original decision evidence and
  the bounded discussion. One missing record becomes the answer `unclear`
  or `incomplete`, never one invented fact.
- Attention eligibility and permissions: the host decides who may receive
  one interruption and when one channel is eligible.
- Cooldowns, approval mode, and delivery: the host owns the message
  pipeline. One report authorizes no application action.
- Storage: the library writes no file. The host stores the profile, every
  report, and every source snapshot.

## Run it with Jev, opt-in

The example ships with the scripted test evaluator. To run the same checks
against Jev, install the pinned SDK in your application and register the
Jev adapter. The host owns the client, the credential, and the endpoint:

```ts
import { createExplorationProfile, createJevEvaluator, registerEvaluators } from "measuretwice";
import { TypeSafeClient } from "@typesafe-ai/sdk";

// The client reads TYPESAFE_API_KEY from the environment.
const client = new TypeSafeClient();

const evaluator = createJevEvaluator({
  call: (request, options) => client.systemOne(request, options),
  model: "jev-1.13.0",
});
const registry = registerEvaluators(evaluator);

// Generate one profile for the Jev adapter. The binding records the adapter
// version and the complete translated question of every check.
const profile = createExplorationProfile(intervention, registry);
```

Then pass the new registry to `load` in [host.ts](host.ts) and store the new
profile. One stored profile of the test evaluator refuses the new registry
with `evaluator_mismatch`, because one changed evaluator needs one new
binding.

Know the costs before you switch:

- One live call spends one API budget and reads one credential. Keep live
  runs opt-in. The ordinary tests of this repository run none.
- One case needs one Jev request per question check, because the
  authorized input states differ. The adapter rejects evidence above the
  provider state budget with `oversized_input` and truncates nothing.
- The adapter requests one versioned model identifier, never one alias, and
  the report records the version that answered.

## Next steps

- Add cases from real work, review every label, and record the reviewer.
- Export the shadow disagreements for review, then calibrate one profile on
  reviewed cases. Starter thresholds carry no qualification evidence.
- Read the public synthetic challenge set of this definition in
  [examples/intervention-challenge](../intervention-challenge/README.md).
  Its labels stay unreviewed until the review of task T063.
- Read [MVP_SPEC.md](../../MVP_SPEC.md) section 13 for the pilot that this
  example starts.
