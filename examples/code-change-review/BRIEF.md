# Code change review

Status: proposed experiment. No evaluator results or qualification evidence exist for this brief.

## Purpose

Test whether measuretwice detects missing requirements and unrequested behavior in a code change.
Keep compiler results and software tests as separate evidence.

## Case and checks

Each case contains the request, relevant existing code, the proposed change, and available test results.

- Does the change implement each stated requirement?
- Does the change preserve the stated compatibility requirements?
- Does each behavior change serve the request?
- Does the supplied evidence support the claimed verification?

Pass means the supplied evidence supports the requirements.
Fail means the change violates a stated requirement.
Review means relevant code, requirements, or verification evidence is missing or ambiguous.
An execution failure remains an error.

## First experiment

1. Select completed changes with explicit requirements and human review findings.
2. Ask a developer to label each case without seeing evaluator answers.
3. Separate related changes into groups before assigning development and validation cases.
4. Compare a direct evaluator call with measuretwice on matching inputs.
5. Inspect missed defects, incorrect rejections, review effort, latency, and integration effort.

Keep review findings out of evaluator inputs.
Record reviewer identity and unresolved disagreements.
Previously accepted changes are not automatically correct reference cases.

## Decision and limits

Continue if the checks find useful omissions beyond existing tests at an acceptable review cost.
The owner must state acceptable error and review limits before fitting a policy.
A passing report does not establish complete code correctness or authorize a merge.
