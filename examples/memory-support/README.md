# Memory support example

This is the first public example of measuretwice. It asks one question:
does one proposed memory follow from the original sources that the host
supplies with it?

The example shows the complete minimal workflow:

1. One definition in TypeScript with TypeBox inputs.
2. Three synthetic cases with reference labels and label provenance.
3. One generated exploration profile. The profile is explicitly unvalidated.
4. Shadow runs that record the existing decision of the host beside the new
   outcome.
5. Report storage that the host owns.

Everything runs offline. The test evaluator answers from one scripted list,
so the workflow needs no credential and spends no API budget.

## Files

| File | Content |
| --- | --- |
| [checks/memory-support.ts](checks/memory-support.ts) | The definition: the inputs, the question, the answers, and the acceptance meaning. |
| [cases/memory-support.metadata.json](cases/memory-support.metadata.json) | The dataset metadata: revision, kind, one split, and the label guidelines. |
| [cases/memory-support.jsonl](cases/memory-support.jsonl) | Three case records with reference labels and label provenance. |
| [host.ts](host.ts) | The host side: evaluator registration, profile generation, shadow runs, report storage, and the printed summary. |
| [tsconfig.json](tsconfig.json) | The TypeScript build of the example. |

## The check

The definition declares three inputs: `original_sources`, `recent_context`,
and `candidate_text`. The check `memory-supported` reads
`original_sources` and `candidate_text` only. Its `using` list authorizes
those two inputs, so no evaluator request carries the recent context, a
reference label, or the provenance record.

| Answer | Meaning | Outcome |
| --- | --- | --- |
| `supported` | The sources establish every material claim. | Pass |
| `contradicted` | One claim conflicts with one explicit statement. | Fail |
| `insufficient` | No conflict, and one claim has no support. | Review |

A missing source is not proof of a false statement. One definite conflict
takes precedence over missing details elsewhere. The definition states no
evaluator and no numerical cutoff. The profile owns both.

## Run it offline

Run the example in this repository. The commands read local files only:

1. `npm install`
2. `npm run build`
3. `npx tsc -p examples/memory-support/tsconfig.json`
4. `node examples/memory-support/build/host.js`

The host prints the profile, one line per case, and the readable report of
the case that disagrees with its reference label. It writes the profile and
one report per case into `examples/memory-support/reports/`. Git ignores
that directory.

The suite [packages/measuretwice/test/example-memory-support.test.ts](../../packages/measuretwice/test/example-memory-support.test.ts)
compiles and runs the same files. It also checks the boundary: the projected
inputs of every evaluator request, the unvalidated profile, the recorded
baseline, the host-owned storage, and the private-data defaults of the
reports.

## What the host keeps

measuretwice assesses and reports. The host keeps every other
responsibility of one memory system:

- Retrieval completeness: the host selects the original sources that it
  supplies. One missing source becomes the answer `insufficient`, never one
  invented fact.
- Citations and freshness: the host records where one memory came from and
  when it changed.
- Permissions and attention eligibility: the host decides who may read one
  memory and when one memory may surface.
- Memory lifecycle, cooldowns, approval mode, and delivery.
- Storage: the library writes no file. The host stores the profile and every
  report.

The existing decision path stays in host code. This example uses one
deterministic rule, `memory-policy-1`, which stores one proposed memory when
its text holds 60 code points or fewer. One shadow run records that decision
as its baseline and changes nothing. Agreement with the baseline is one
observation, not one correctness claim.

## Labels and provenance

The three cases are synthetic. A coding agent proposed every reference label
and no human reviewed one. The dataset records this: `author_type: "model"`,
`origin: "synthetic"`, `reviewed: false`. The loader counts the provenance,
so the summary states `3 model-proposed without one human review`.

- The cases cover one pass, one fail, and one review reference. They state
  no prevalence and support no qualification claim.
- The scripted answers of the test evaluator are synthetic adapter output.
  No model ran, and nothing was measured. The third answer disagrees with
  its reference label, so the summary shows one item for review.
- Do not read the three outcomes as one performance number.
- Enforcement mode refuses the exploration profile with
  `qualification_insufficient`. One profile needs measured evidence and one
  host selection before any run enforces.

Review the labels, then record the reviewer in the label record of each
case. Keep the distinction between one model proposal and one human
judgment.

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
// version and the complete translated question.
const profile = createExplorationProfile(memorySupport, registry);
```

Then pass the new registry to `load` in [host.ts](host.ts) and store the new
profile. One stored profile of the test evaluator refuses the new registry
with `evaluator_mismatch`, because one changed evaluator needs one new
binding.

Know the costs before you switch:

- One live call spends one API budget and reads one credential. Keep live
  runs opt-in. The ordinary tests of this repository run none.
- One Jev request holds one question per check. The adapter rejects evidence
  above the provider state budget with `oversized_input` and truncates
  nothing. Bound what you send.
- The adapter requests one versioned model identifier, never one alias, and
  the report records the version that answered.

## Next steps

- Add cases from real work, review every label, and record the reviewer.
- Collect enough reviewed cases, then calibrate one profile. Starter
  thresholds carry no qualification evidence.
- Read [MVP_SPEC.md](../../MVP_SPEC.md) section 13 for the pilot that this
  example starts.
- The full intervention review example lives in
  [examples/intervention-review](../intervention-review/README.md).
