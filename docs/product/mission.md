# Mission

Reduce the effort needed to define, inspect, and revise an AI judgment.

Ergonomics and clarity guide measuretwice.
The requirement, supplied evidence, evaluator answer, and decision rule must remain understandable and inspectable.
A clear workflow must preserve measurement integrity and application authorization boundaries.

## Product decisions

- Start with one requirement, a few contrasting cases, and a readable report.
- Keep evaluator bindings and numerical rules separate from requirement meaning.
- Explain a review with its recorded condition and a useful next inspection.
- Keep uncertainty and missing evidence visible. State when a cause is unknown.
- Introduce datasets, calibration plans, and qualification when the user asks whether they can rely on the judgment.
- Require each new abstraction or artifact to solve an observed user problem.
- Preserve explicit budgets, credentials, storage ownership, and enforcement selection.

## Acceptance criteria

These criteria guide development. They are not claims of measured human usability.

| Task | Required experience | Verification |
| --- | --- | --- |
| First run | One documented command after dependency installation produces contrasting reports. | Execute the README command in a clean checkout. |
| First judgment | A generated profile value runs without a saved profile, dataset, or calibration plan. | Test the public API and validation gates. |
| Understand a check | A reader can state its requirement, evidence inputs, and acceptable answers. | Give a new developer the check and cases. |
| Understand a review | The report distinguishes a declared review answer, policy abstention, and skipped execution. | Test report views against controlled assessments. |
| Inspect evidence | The host can show the source and candidate beside the report. | Run the public first-check example. |
| Revise safely | A user can change a requirement and identify which evidence needs new evaluation. | Review the documented revision workflow with a new developer. |
| Decide about reliance | The user sees counts, denominators, qualification limits, and the required next evidence. | Review qualification reports with the owner. |

## Measure the mission

Give a new developer a real requirement and the README without an architecture explanation.
Observe their work rather than coaching them past obstacles.

1. Record time to the first valid check and stored or inspected report.
2. Record confusion, retries, and concepts the developer must learn before that report.
3. Ask them to explain the outcomes and identify the next useful change.
4. Change one requirement and observe their revision and evaluation work.
5. Compare effort with a direct evaluator integration using the same requirement and evidence.

Report setup, review, and maintenance effort separately from model quality.
Declare targets before the comparison. Keep raw findings and participant provenance.
An agent session does not establish human usability.
The existing [usability record](../reports/new-developer-test.md) used agent participants; a human study remains open.

## Current evidence and remaining work

The [documentation experiment](../../examples/documentation-consistency/RESULTS.md) demonstrates live execution and two inserted-error detections.
It also exposed incomplete case assembly, evaluator review, and policy abstention.
Its labels remain unreviewed, and its cases do not establish deployment reliability.

The first-check example and direct profile loading address first-run setup.
The [requirement revision example](../../examples/first-check/README.md#revise-the-requirement) demonstrates profile invalidation and reassessment without saved files.
The report view explains recorded review conditions.
The [verification record](../reports/ergonomics-update.md) records the clean-checkout checks.
The [acceptance audit](../reports/mission-audit.md) maps each mission task to its evidence and remaining verification.
Use [the human study procedure](../guides/usability.md) to test the experience with a new developer.
Human usability, direct-integration effort, and representative qualification evidence remain unmeasured.
These require participants and data; implementation alone cannot establish them.
The [review response plan](review-plan.md) separates correctness fixes from workflow validation and states their completion evidence.

Read [MVP_SPEC.md](../../MVP_SPEC.md) for the product contract and technical acceptance criteria.
