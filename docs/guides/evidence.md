# Prepare evidence for one check

Use this guide before changing a question or its decision rules.
An unchanged document can receive review when the supplied excerpt omits evidence for one of its claims.

## Assemble one case

1. State one requirement with its source and revision.
2. Select the complete candidate claim that the check assesses.
3. Supply evidence for every material part of that claim.
4. Preserve relevant conditions, exceptions, attribution, and uncertainty.
5. Keep the reference answer and its explanation outside evaluator inputs.
6. Have a reviewer assess the case without seeing the evaluator answer.
7. Preserve the original case and label when a correction creates a revision.

An excerpt must end at a complete statement.
If you omit supporting context deliberately, mark the case as a missing-evidence control.
Do not label an unsupported claim as false unless the evidence establishes a conflict.

## Example

Requirement: documentation must state the default timeout consistently with its contract.

| Evidence | Candidate | Proposed reference |
| --- | --- | --- |
| The default timeout is 1000 milliseconds. | The default timeout is 1000 milliseconds. | supported |
| The default timeout is 1000 milliseconds. | The default timeout is 5000 milliseconds. | contradicted |
| The timeout accepts positive integers. No default is stated. | The default timeout is 1000 milliseconds. | insufficient |

These labels are illustrative proposals, not human-reviewed measurements.
If the candidate also describes retry behavior, supply the retry contract or assess that claim separately.

## Investigate a disagreement

First inspect the source and candidate as the evaluator received them.
Stored reports omit raw case text by default, so your application must retain or display it when needed.

- If evidence is missing, fix the case assembly or collect the missing evidence.
- If the answer is declared for review, inspect its criteria against the evidence.
- If neither cutoff is met, inspect the distribution and the policy.
- If a confidence floor is not met, inspect that measurement and the evaluated policy.
- If execution fails or is skipped, inspect the recorded reason and resource limits.

A policy review does not establish that the source evidence is incomplete.
The renderer explains the recorded decision condition, not the evaluator's internal reasoning.
If no rationale exists, report that limit.
Do not change references or lower thresholds merely to obtain agreement.

## Preserve the evaluation meaning

Keep variants from the same source or incident in one group.
Separate deliberately inserted defects from naturally occurring defects.
Record whether each label is human-authored, human-reviewed, or model-proposed.
Inspecting results and revising cases is development work; it does not create independent validation evidence.

Use [calibration](calibration.md) when the requirement and cases are stable enough to assess reliance.
The [documentation results](../../examples/documentation-consistency/RESULTS.md) show why case assembly belongs before policy tuning.
