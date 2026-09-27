# Interruption usefulness

Status: proposed experiment. No evaluator results or qualification evidence exist for this brief.

## Purpose

Test whether measuretwice can assess the value of an interruption for one recipient.
Extend [intervention review](../intervention-review/README.md) with recipient preferences and attention costs.

## Case and checks

Each case contains a proposed alert, supporting evidence, recent messages, previous alerts, and explicit recipient preferences.

- Does the alert contain a supported concern relevant to the recipient?
- Does it add information that the supplied conversation has not acknowledged?
- Can the recipient take a useful action?
- Does the concern meet the recipient's stated interruption criteria?

Pass means the alert meets those criteria using the supplied context.
Fail means it clearly violates a criterion.
Review means relevance, novelty, urgency, or recipient preference remains unclear.
An execution failure remains an error.

## First experiment

1. Select historical candidate alerts with their original context.
2. Ask the recipient to label them without evaluator answers.
3. Sample delivered alerts and silent cases, recording how each was selected.
4. Separate incidents into development and validation groups.
5. Compare direct evaluation with measuretwice on unwanted alerts, missed useful alerts, and review effort.

Record the recipient and preference revision behind each label.
Keep later outcomes and reference labels out of evaluator inputs.
Run in shadow mode; send no alerts from this experiment.

## Decision and limits

Continue if the measured tradeoff matches the recipient's stated priorities.
The owner must state acceptable error and review limits before fitting a policy.
Historical silence is not a reference label for an incorrect alert.
Changed preferences or context require new evidence.
