# Advice review

Status: proposed experiment. No evaluator results or qualification evidence exist for this brief.

## Purpose

Test whether measuretwice can assess advice against a user's actual goal, constraints, and available evidence.
Start with the recommendations from the current measuretwice discussion.

## Case and checks

Each case contains a user request, relevant prior context, supplied source material, and one candidate answer.

- Does the answer address the requested decision?
- Does it respect every explicit constraint?
- Do factual claims follow from the supplied evidence?
- Does it distinguish observations, assumptions, and recommendations?
- Does it give a useful next action when the user requests one?

Pass means the answer meets the stated requirements.
Fail means it violates a requirement or makes an unsupported factual claim.
Review means the goal, evidence, or preference is too unclear for a decision.
An execution failure remains an error.

## First experiment

1. Select requests with explicit goals and constraints.
2. Prepare alternative answers, including plausible but unhelpful answers.
3. Ask the requester to label the answers without evaluator results.
4. Keep answers to the same request in one development or validation group.
5. Compare direct evaluation with measuretwice on errors, review effort, and useful corrections.

Record who supplied each preference and label.
Keep labels and evaluator-generated critiques out of evaluator inputs.

## Decision and limits

Continue if the checks explain specific failures that the requester considers important.
The owner must state acceptable error and review limits before fitting a policy.
One person's labels do not establish universal advice quality.
A well-supported answer can still omit a better option.
