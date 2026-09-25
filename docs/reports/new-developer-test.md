# New developer usability test

Status: completed on 25 September 2026 by task T076. This record reports
one executed test, its findings, and the fixes that followed.

[MVP_SPEC.md](../../MVP_SPEC.md#15-acceptance-criteria) section 15 states
the test: "hand someone the check file and a report without an architecture
lecture. They should understand the requirement, supplied evidence,
outcome, and next step. The advanced view must let a developer trace that
same outcome to exact measurements and an evaluated policy."
[AGENTS.md](../../AGENTS.md#3-do-not-make-the-user-think-unnecessarily)
section 3 states the rule behind it: test the interface with someone who
has not read the implementation.

## Method, and its limit

Four sessions ran on 25 September 2026. Each session was one fresh agent
context with no prior contact with this repository. Each participant
received one restricted reading list, one task, and one request to log
every confusion and every dead end. The facilitator verified every claim
that a tool output supports.

The participants were agent sessions, not human developers. That
substitution measures the artifacts: what one reader can decode from the
check file, the report views, and the published guides. It does not
measure human patience, prior knowledge, or time pressure. A session with
one human participant remains open, and no claim below states otherwise.

| Session | Participant brief | Materials | Measures |
| --- | --- | --- | --- |
| A1 | One developer who knows TypeScript, given no documentation. | The flagship check file, one summary report view, one detailed report view. | Comprehension and trace, MVP_SPEC.md criteria 1 and the advanced view. |
| A2 | One developer who knows TypeScript, given no documentation. | The memory support check file, one summary report view, one detailed report view. | The same measures over one smaller definition. |
| B | One developer new to the project, sent to `README.md`. | One clean repository copy, offline. | One exploration shadow run integrated inside one working session, criterion 12. |
| C | One coding agent working for one owner. | [The authoring guide](../guides/agent-authoring.md) and the documents it links. | Agent-assisted drafting and provenance, criterion 2. |

The comprehension materials were the committed files of the public
examples, plus one summary render and one detail render of one stored
report through `renderRunReport`. The first-run section of
[README.md](../../README.md#first-run-one-exploration-shadow-report) now
prints both views of the same report, so the material reproduces with the
documented commands.

## Results against the acceptance criteria

**Criterion 1, one human explains the checks and outcomes.** Both
comprehension participants listed every requirement of their check file,
named the input that each requirement reads, and stated the overall
outcome with its meaning. Both also answered the criterion's negative
bound: neither found one model name, one provider, or one policy cutoff
inside one definition. Both noted that the only numbers there are the
input bounds and the exact rule. Both verdicts on the full sentence ("I
can state what is required, what evidence was used, what was decided, why
the policy produced that result, and what to do next") were false, for the
reasons in the findings table below.

**The advanced view.** Both participants traced the failed check to its
exact measurement and its executed policy without help. One quoted the
distribution line and the policy line, reconstructed the arithmetic of
`acceptable mass 0.94 = 0.12 + 0.82` on one ordered scale, and named the
profile as the artifact that owns the cutoffs. The trace requirement of
section 15 passed before any fix.

**Criterion 12, one working session.** The integration participant
reported one complete exploration shadow run, with authoring, offline
validation through the CLI, three shadow runs with one stated baseline,
and host-stored reports. The reported working time was about 40 minutes to
the first stored report and about 60 minutes to completion, most of it
reading. No step forced one read of the library implementation. The
participant's verdict was true: one session was enough.

**Criterion 2, agent-assisted drafting.** The drafting participant
produced one validated definition module, one JSON export, one dataset of
14 records with metadata, one coverage record with uncovered boundaries,
and one label review surface. The facilitator verified the artifacts
independently: `measuretwice validate` accepted the export, and the public
loader reported `14 labeled, 14 model-proposed, 0 human-reviewed` with
zero findings. The participant withheld the calibration plan because the
owner stated no tolerances, which the guide requires. No label claimed one
human review, and no text stated one performance number.

## Findings and fixes

Each row names the sessions that reported the finding, the fix of this
change, or the reason no fix followed. Quoted text is verbatim from one
participant report.

| Finding | Sessions | Resolution |
| --- | --- | --- |
| "Unacceptable mass" and the two cutoffs carry no definition, and the zone between them is unexplained. Ranked worst by both comprehension participants. | A1, A2 | Fixed. The detail view of both renderers now ends with one key that defines acceptable mass, unacceptable mass, the three zones, and the artifact that owns the cutoffs. `packages/measuretwice/src/render.ts`. |
| "Shadow mode" and the "baseline" line of the report carry no explanation. | A1, A2 | Fixed. The same key states both terms when the report holds them. |
| No executed path shows the trace: the examples printed the summary view alone, and the detail view existed only in the API reference. | Facilitator | Fixed. The memory support example now prints the detailed view of its highlighted report beside the summary, and the README first-run output shows it. `examples/memory-support/host.ts`. |
| The scripted control list of the offline evaluator has no documented shape. "The offline evaluator is the documented path for offline validation, yet its input shape exists only in example code." | B, C | Fixed. The [test evaluators](../reference/api.md#test-evaluators) section documents one complete control list with one assessment, one failure, and one malformed answer, and the authoring guide links it. |
| The dataset metadata shape, and which of its fields are required, is stated nowhere. Two example files disagree about `record_count`. | B, C | Fixed. The [artifact reference](../reference/artifacts.md#one-case-record-and-its-reference-shapes) shows one complete record and one complete metadata file, lists the required fields, and states the optional ones. |
| The reference shape of one exact-rule check, `{"outcome": "pass"}` with no answer, is documented in no reference page. | B | Fixed. The same section shows every reference shape beside one real record. |
| `import Type from "typebox"` surprised both TypeScript readers, who expected `@sinclair/typebox`. | A1, A2 | Fixed. The README states the package name at the first example. |
| One answer that is neither `accept` nor `review` has no stated outcome. "contradicted is unmapped." | A2 | Fixed. The key states that unacceptable mass covers every other declared answer, so the mapping is complete in the view that executes it. |
| One binary check prints no `distribution:` line, which reads as one omission. | A1 | Fixed. The key states that one binary question reports one answer and no distribution. |
| The `maxLength` bound of the guide's own example sits beside the rule "name no cutoff inside one definition", which one first-time author reads as one ban. | C | Fixed. The guide states that one exact-rule bound is part of the requirement and is no evaluator cutoff. `docs/guides/agent-authoring.md`. |
| The guide sends the author to example source for the host pattern, because it shows no `load` call of its own. | C | Partly fixed. The guide now links the test evaluator reference and the artifact reference. The first-run README keeps the host pattern. |
| The case content stays invisible, so one reader cannot verify one verdict by hand against the input. | A1, A2 | No fix. The privacy default keeps case content out of every stored report, and the limitation states it. The host that owns the input can show it beside the report. |
| "Next:" names no concrete action and no person. | A1, A2 | No fix. One report authorizes no application action, so the next action belongs to the host. The line states the useful direction, and the key states who decides. |
| The report names the profile but holds no path to it. | A1, A2 | No fix. The host owns storage, so one stored path inside one report would state one fact that the library cannot keep. The key names the artifact that owns the cutoffs. |
| The memory support example declares `recent_context` and no check reads it. | A2 | No fix. One definition may declare inputs that no check reads; the case record stays complete for later checks. Recorded as one observed confusion. |

## Reproduction

1. Comprehension: copy one check file of `examples/intervention-review` or
   `examples/memory-support`, render one stored report at both detail
   levels with `renderRunReport`, and hand one reader the three files.
2. Integration: copy the repository, remove the build outputs, and follow
   [README.md](../../README.md) with one new requirement until one shadow
   report is stored.
3. Drafting: hand one fresh agent session
   [the authoring guide](../guides/agent-authoring.md) and one owner
   requirement that states no tolerances, then validate the deliverables
   with `measuretwice validate` and `loadDataset`.

Every session runs offline. None opens one network connection, reads one
credential, or spends one API budget.
