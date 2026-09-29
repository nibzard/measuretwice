# Plan: inspect, revise, and compare judgments

Status: proposed. This document authorizes no release and claims no implemented behavior beyond the inventory below.
Date: 29 September 2026.

## Objective

Make one complete workflow the main experience after the first check:

```text
Run cases → inspect a judgment → change one part → compare results
```

A developer must understand an unexpected outcome, revise the relevant part, and inspect the consequences without reading architecture documentation.
This work serves the [mission](mission.md): reduce the effort needed to define, inspect, and revise an AI judgment.
It applies to measuretwice itself. Completion does not depend on Cassandra or another application integration.

The user-supplied Jev interview motivates this plan.
Relevant sections discuss small decisions at 59:57, robustness at 41:24, and workflow-specific evaluation at 18:50.
The interview does not establish model performance or product demand.

## Product priorities

1. Make individual judgments easy to inspect.
2. Make changes and their consequences easy to compare.
3. Test whether judgments respond correctly to equivalent and materially different evidence.
4. Measure the effects of additional checks on the complete outcome.

Start with existing APIs and ordinary functions.
Add an abstraction only when the executable workflow demonstrates a missing capability.
Keep calibration and saved artifacts available without requiring them for initial exploration.

## Existing implementation and gaps

| Area | Existing implementation | Work to resolve |
| --- | --- | --- |
| First run | `createExplorationProfile`, `load`, and the first-check example support exploration without saved profiles. | Connect initial exploration to inspection and comparison. |
| Inspection | `renderRunReport` explains criteria, assessments, applied rules, and review conditions. | Present the exact authorized evidence beside these records through explicit host input. |
| Requirement changes | The first-check revision example rejects the old profile and reassesses the changed requirement. | Present the old and new requirements with their case outcomes together. |
| Policy revision | `revise` replays compatible assessments from a prior calibration or revision. | Establish a simple exploration path without requiring calibration artifacts first. |
| Comparison | `compare` compares evaluation reports with matching definitions and matching case IDs and input hashes. | Support inspection across definition changes without weakening existing comparison validation. |
| Evidence changes | Input hashes identify changed cases. | Show related cases without representing changed inputs as identical measurements. |
| Robustness | Existing challenge cases cover selected difficult behaviors. | Add explicit relations between variants and report whether expected relations hold. |

Implementation references:

- [Report rendering](../../packages/measuretwice/src/render.ts)
- [Policy revision](../../packages/measuretwice/src/revise.ts)
- [Evaluation comparison](../../packages/measuretwice/src/compare.ts)
- [First-check revision](../../examples/first-check/revise.mjs)
- [Public API](../reference/api.md)

The [specification](../../MVP_SPEC.md) remains authoritative.
Any public contract change requires an explicit specification update with implementation, examples, and relevant tests.

## Milestone 1: one complete judgment workflow

### 1. Establish the executable example

Use documentation consistency as the initial example.
Compare a documentation claim with explicitly supplied source evidence.
This task exercises measuretwice directly and needs no external application.

Include supported, contradicted, and insufficient-evidence cases.
Include a controlled assessment that selects an acceptable answer but produces review under the applied rule.
Use a scripted evaluator for reproducible workflow checks. Mark its outputs as scripted.
Offer live evaluation as an explicit option with declared credentials and request limits.

Reuse the [existing experiment](../../examples/documentation-consistency/RESULTS.md) where useful.
Preserve its limitations: reference labels remain unreviewed, and selected cases establish no deployment reliability.

### 2. Present an inspectable judgment

For each selected case, show:

- The requirement and declared answer meanings.
- The exact evidence inputs that the check may read.
- The evaluator answer and available measurements.
- The applied decision rule and resulting outcome.
- The recorded review or execution condition.
- The definition, input, evaluator, model, and profile identities needed for further inspection.

Keep ordinary output concise. Put full identities and measurements in a detailed view.
Keep raw case content host-owned and display it only through an explicit inspection operation.
Do not expand default logs or stored reports to include raw evidence automatically.
Verify identity before pairing supplied case content with a stored report.

Explain recorded conditions. State when the cause of an evaluator answer is unknown.
An evidence selection problem requires inspection; a missing-evidence label alone does not establish its cause.

### 3. Define revision behavior

| Change | Assessment handling | Evidence handling |
| --- | --- | --- |
| Thresholds only | Reuse stored assessments only when all relevant bindings remain compatible. | Treat replay as development evidence; require fresh independent validation for a new qualification claim. |
| Question or answer meanings | Obtain new assessments under a new definition and profile. | Review whether previous reference labels still apply. |
| Evidence selection or content | Obtain new assessments for affected checks and inputs. | Preserve both input identities and the declared relation between cases. |
| Model, evaluator, or translation | Obtain new assessments under the new binding. | Preserve the earlier results; require new qualification evidence. |

Do not silently relax `revise` or `compare` validation.
First demonstrate requirement changes with an explicit paired inspection view.
Keep each definition, report, and reference label bound to its own revision.
If a reusable comparison contract is needed, specify its matching and semantic limits before implementation.

### 4. Show the consequences

Show the changed requirement or rule before the changed outcomes.
List affected cases with both assessments and outcomes.
Keep assessment changes visible even when the final outcome stays the same.
Expose missing cases, changed inputs, errors, and skipped checks.
Separate reused assessments from fresh measurements.

Report outcome transitions without calling them improvements unless reviewed references support that conclusion.
Show review burden, latency, and usage when available.
Calculate currency cost only from recorded usage and explicit price inputs.
Do not compare accuracy directly when the requirement or reference meaning changed.

### Completion criteria

- [ ] One documented offline command runs the complete example after installation and build.
- [ ] Inspection displays authorized evidence, assessment, rule, and outcome together.
- [ ] The example distinguishes an acceptable evaluator answer from a policy review.
- [ ] A policy change demonstrates compatible assessment reuse without a new provider call.
- [ ] A requirement change demonstrates invalidation, new assessment, and paired inspection.
- [ ] Changed evidence remains identifiable and cannot appear as an unchanged matched input.
- [ ] Missing results and execution failures remain visible.
- [ ] The workflow states which conclusions remain unproven.
- [ ] README guidance links this workflow immediately after the first-check experience.

## Milestone 2: robustness within the same workflow

Robustness means preserving the expected judgment under irrelevant changes and responding correctly to meaningful changes.
Start with explicit paired cases. Defer automatic variant generation until the reporting workflow works.

Include these relations:

| Variant | Expected behavior |
| --- | --- |
| Equivalent wording or formatting | Preserve the reviewed answer meaning and expected outcome. |
| Irrelevant context | Preserve the judgment when the added content changes no relevant evidence. |
| Contradictory evidence | Change the answer according to the requirement. |
| Removed supporting evidence | Select insufficient evidence or another explicitly defined result. |

Record the original case, variant, transformation, expected relation, and review provenance.
Verify that a proposed irrelevant change is actually irrelevant to this requirement.
Keep related variants in the same group when separating fitting and validation data.

Report relation violations with counts and denominators.
Separate wrong changes, missed required changes, errors, and unavailable comparisons.
Show assessment changes and policy outcome changes separately.
Keep ordinary correctness evaluation beside robustness results: consistent answers can still be wrong.

### Completion criteria

- [ ] Each variant has an explicit relation and provenance.
- [ ] Equivalent and materially changed cases both appear in the executable example.
- [ ] The report opens each unexpected result in the same inspection and comparison workflow.
- [ ] Related variants cannot cross fitting and validation groups in the supplied dataset.
- [ ] Generated cases remain proposed tests until reviewed.
- [ ] Robustness results make no unsupported accuracy or qualification claim.

## Later work, driven by observed needs

Measure the effect of adding or removing a check on the complete outcome.
Report errors caught, valid cases rejected, review burden, latency, and usage.
Use reviewed references when describing an outcome change as beneficial.
Account for correlated errors. Additional checks do not automatically improve reliability.
Keep these experiments separate from the v0 rule that all configured checks are required.

Consider Jev batching when recorded usage or latency establishes a useful benefit.
Batch only independent checks with identical authorized evidence inputs and compatible request boundaries.
Preserve per-check outcomes and request-level usage.

Additional providers, model routing, agent orchestration, and a graphical application are outside these milestones.

## Verification and delivery

Implement milestone 1 before milestone 2.
For each behavioral change, write a failing test at the affected boundary before implementation.
Test identity mismatches, invalid reuse, changed definitions, absent measurements, and incomplete execution where affected.
Use controlled assessments to test software behavior. Keep live model evaluation separate and opt-in.
Run applicable repository checks and review the executable example from a clean checkout.

Observe a new developer using the completed workflow without an architecture explanation.
Ask them to explain an unexpected outcome, revise the relevant part, and identify required reevaluation.
Record completion time, errors, assistance, and unresolved confusion.
Human observation verifies usability; it does not block implementation or substitute for model-quality evidence.

Deliver implementation, an executable example, updated reference documentation, and a verification record together.
Distinguish implemented behavior, software verification, human observation, and empirical model results in that record.
