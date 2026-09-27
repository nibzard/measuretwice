# Memory fidelity

Status: proposed experiment. No evaluator results or qualification evidence exist for this brief.

## Purpose

Extend the [memory support example](../memory-support/README.md) with tests of attribution, uncertainty, scope, and later corrections.
Test whether a short memory preserves the meaning of its sources.

## Case and checks

Each case contains an ordered source conversation and one proposed memory.

- Does each material claim follow from the sources?
- Does the memory preserve who said or decided each claim?
- Does it preserve conditions, exceptions, and uncertainty?
- Does it account for explicit corrections within the supplied conversation?

Pass means the memory preserves the relevant source meaning.
Fail means it changes or contradicts that meaning.
Review means the sources cannot establish a material claim or resolve a correction.
An execution failure remains an error.

## First experiment

1. Prepare short conversations with decisions, suggestions, exceptions, and corrections.
2. Create candidate memories with subtle changes to those meanings.
3. Ask a human reviewer to label each claim and the overall memory.
4. Keep variants of one conversation in the same development or validation group.
5. Compare direct evaluation with measuretwice on incorrect acceptances, rejections, and review effort.

Record synthetic sources and model-proposed labels explicitly.
Use separate representative cases before making any deployment qualification claim.
Keep reference labels out of evaluator inputs.

## Decision and limits

Continue if the checks identify meaning changes that a simpler direct assessment misses.
The owner must state acceptable error and review limits before fitting a policy.
Source support does not establish source truth or retrieval completeness.
A report does not authorize storing a memory.
