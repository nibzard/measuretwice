# Compare the judgment workflow

Status: prepared participant procedure. An engineering comparison is recorded separately. No participant observations exist for this change.

Use [the human study procedure](../guides/usability.md) for recruitment, consent, timing, and task order.
This protocol adds agent observations and the diagnosis tasks from [the review plan](review-plan.md).

## Declare the study before execution

The owner must supply these fields before collecting observations:

| Field | Required declaration |
| --- | --- |
| Recurring task | The requirement, application owner, intended population, and actual recurring cost |
| Participants | Human count, fresh agent count, inclusion criteria, and relevant experience |
| Versions | Candidate commit, direct harness revision, evaluator model, adapter, and policy |
| Evidence | Case identities, sources, reference author, human reviewer, and review status |
| Resources | Maximum provider calls, runtime budget, spend limit, and stop conditions |
| Targets | Permitted setup time, diagnosis errors, review time, and revision effort |
| Order | Assignment of equivalent case sets and alternating integration order |

These declarations remain open. Documentation consistency is a candidate task, not a selected population.
Do not choose targets after examining the results.

## Give both integrations the same tasks

1. Author a requirement for the owner's actual evidence and candidate data.
2. Assess an acceptable case and a contradictory case.
3. Inspect a case with missing evidence and select the next useful inspection.
4. Distinguish policy abstention from evaluator rejection using the recorded assessment.
5. Recover from a permanent credential or input failure without futile retries.
6. Revise the requirement and rerun contrasting cases.
7. Change a model or definition binding and identify evidence that needs new qualification.

Use the same evaluator, meanings, cases, cutoffs, and resource budgets in both paths.
The direct integration must include the decision and diagnosis requirements that the tasks need.
Record its added reporting and compatibility code as maintenance effort.
Do not count missing safeguards as an advantage in setup time.

Include adversarial evidence in the cases when it represents the owner's use.
Inspect actual environment state for coding tasks. A transcript claim does not establish successful execution.

## Record each session

Store private sources and personal identifiers outside the public repository.
Record a consented participant identifier and whether the participant is a human or an agent.
For agents, record the model, initial context, tool access, fresh-session status, and supplied instructions.
Give the participant the task and public documentation. Record every intervention.

| Measure | Definition |
| --- | --- |
| Setup effort | Elapsed installation time, commands, failures, files, and facilitator help |
| First useful judgment | Elapsed time until an outcome is inspected and its next useful action is correctly identified |
| Incorrect commands | Attempts rejected because a command or option does not exist or cannot perform its advertised task |
| Diagnosis accuracy | Correct diagnoses divided by attempted diagnoses, against separately reviewed task expectations |
| Revision effort | Elapsed time, edits, reruns, and invalidated evidence correctly identified |
| Review time | Time spent inspecting evidence before deciding the next action |
| Runtime cost | Provider calls, reported tokens, elapsed execution, and cost from declared prices |
| Maintenance effort | Changes needed after requirement or model changes, including custom harness code |

Keep failed tasks in the denominators. Do not reconstruct missing timestamps.
Record uncertainty and an unknown diagnosis as explicit results.
An accurate statement that more evidence is needed can satisfy a task expectation.

## Decide the next product change

Report human and agent results separately. Separate interface effort from evaluator quality.
Compare each task against the declared target and the direct integration.
State sample counts, learning effects, unresolved references, missing observations, and population limits.
Select further interface work from observed obstacles.

The offline [semantic runner](../../examples/semantic-runner/README.md) verifies execution and inspection mechanics.
It supplies no human observations and establishes no comparative advantage.
A second provider requires an owner-selected task, documented capabilities, and an approved live-call budget.

The [documentation comparator](../../examples/documentation-consistency/comparison/README.md) provides two executable integrations and a blind review sheet.
The [six-case engineering trial](../../examples/documentation-consistency/evidence/comparison-2026-09-30/CONCLUSION.md) records separate live calls and current source hashes.
Its matching outcomes do not supply participant effort measurements or human-reviewed correctness.
