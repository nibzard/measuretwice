# Transformation fidelity

Status: proposed experiment. No evaluator results or qualification evidence exist for this brief.

## Purpose

Test whether measuretwice detects meaning changes during data cleaning or record transformation.
Keep exact schema and field validation in ordinary code.

## Case and checks

Each case contains the source records, the transformation requirements, and the transformed record.

- Does the result preserve every fact required by the transformation?
- Does it avoid introducing unsupported facts?
- Does it preserve distinctions between people, locations, products, or events?
- Does it retain unresolved conflicts instead of silently choosing one value?

Pass means the result preserves the required meaning.
Fail means it loses, invents, or incorrectly merges material information.
Review means the source records or transformation rules are ambiguous.
An execution failure remains an error.

## First experiment

1. Choose one transformation, such as merging duplicate product descriptions.
2. Collect original records and candidate transformed records.
3. Have a domain reviewer label facts preserved, lost, added, or unresolved.
4. Keep records about the same entity in one development or validation group.
5. Compare direct evaluation with measuretwice alongside existing exact validation.

Measure missed meaning changes, incorrect flags, review effort, and processing cost.
Record label provenance and keep labels out of evaluator inputs.
Use synthetic or approved shareable records for committed examples.

## Decision and limits

Continue if semantic checks catch consequential changes that exact validation cannot express.
The owner must state acceptable error and review limits before fitting a policy.
A passing assessment does not establish real-world identity or authorize a record update.
