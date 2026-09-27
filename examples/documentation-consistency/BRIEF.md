# Documentation consistency

Status: two live exploration revisions completed. No qualification evidence exists.

Read the executed revisions in [the results record](RESULTS.md).
Their labels remain unreviewed, and neither revision establishes qualification.

## Purpose

Test whether measuretwice finds differences between an example, its explanation, and its current contract.
Use repository files to start without collecting external data.

## Case and checks

Each case contains one example, its explanation, the relevant contract, and any recorded execution output.

- Does the example demonstrate the behavior promised by the explanation?
- Do its inputs and outputs match the supplied contract?
- Does each performance claim have supporting evidence?
- Does the explanation distinguish implemented behavior from proposed behavior?

Pass means the supplied artifacts agree on the stated behavior.
Fail means a concrete inconsistency exists.
Review means the contract or execution evidence cannot establish the claim.
An execution failure remains an error.

## First experiment

1. Select examples and their authoritative contracts from this repository.
2. Have a maintainer label the original cases independently of evaluator answers.
3. Create separate variants with plausible omissions or changed claims.
4. Keep variants of one example in the same development or validation group.
5. Compare a direct evaluator call with measuretwice and inspect every disagreement.

Record inserted defects separately from naturally occurring defects.
Measure missed inconsistencies, incorrect flags, review effort, and maintenance effort.
Keep reference labels and defect descriptions out of evaluator inputs.

## Decision and limits

Continue if reports identify concrete corrections at an acceptable review cost.
The owner must state acceptable error and review limits before fitting a policy.
Inserted defects test specific capabilities; they do not establish reliability on ordinary repository changes.
Run existing document and example checks separately.
