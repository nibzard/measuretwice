# Test ergonomics with a new developer

Use this procedure to test [the mission](../product/mission.md) with observed human work.
The [automated verification record](../reports/ergonomics-update.md) establishes software behavior only.

## Prepare the task

Recruit a developer who has not read the implementation.
Record their TypeScript, model API, and statistics experience before the session.
Use the verified commit and a clean checkout for each integration.
Build the native package before timing authoring if compilation is outside the comparison scope.
Record installation and build effort separately.

Give the developer this task:

> Check whether a proposed memory preserves a decision from its supplied source.
> Try an acceptable memory, a contradictory memory, and a memory with missing evidence.
> Show each judgment beside the source and explain what you would inspect next.
> Then change the requirement to preserve attribution and evaluate new cases.

Prepare comparable source sets for the two integrations.
Have a separate reviewer label the cases before the session.
Keep those labels hidden until the developer produces their outcomes.
Do not treat synthetic setup answers as model-quality measurements.

## Run the session

1. Give the developer the requirement and README without an architecture explanation.
2. Record time to a valid check and the first inspected report.
3. Record documentation searches, retries, unexplained terms, and facilitator help.
4. Ask the developer to explain the requirement, evidence, evaluator answer, outcome, and next action.
5. Give the attribution change and observe how they revise the check and assess its effect.
6. Run the comparable direct-evaluator task with a fresh source set and the same declared scope.
7. Review the findings with the developer after both tasks finish.

If only the scripted evaluator is used, the session tests setup and comprehension.
For a live comparison, both integrations must use the same pinned model and case budget.
State the budget before execution. Keep network failures visible as operational failures.
Record model calls separately from human work.

Alternate integration order across participants and record the order.
With one participant, report the learning effect as a limitation rather than claiming a general advantage.
Do not coach the participant past a difficult step without recording the intervention.

## Record observations

Keep a session record with participant attribution or a consented identifier.
Record the commit, operating system, tool versions, task order, and supplied case identities.

| Observation | Record |
| --- | --- |
| Setup | Installation failures, build failures, and elapsed setup time |
| First judgment | Elapsed time, files created, and concepts learned |
| Comprehension | The participant's explanation and any incorrect inference |
| Review | Evidence inspected, questions asked, and elapsed investigation time |
| Revision | Changes made, evaluations repeated, and invalidated evidence identified |
| Facilitator help | Exact intervention and the point where work stopped |
| Direct integration | The same observations, including any added decision rules and report code |

Use observed timestamps for durations. Do not reconstruct missing time from memory.
Keep personal details and private sources outside committed public records.
Retain errors and unsuccessful attempts alongside completed tasks.

## Interpret the result

Declare acceptable effort and comprehension targets before comparing outcomes.
Report each task separately; a faster first report can still lead to slower investigation.
Use participant explanations to identify confusing distinctions and unsupported trust claims.
Fix observed obstacles, then use new tasks or participants to test the revision.
Do not present repeated sessions with one person as independent first-run trials.

Software tests, model-quality evaluation, and human usability answer different questions.
Keep their results and limitations separate.
