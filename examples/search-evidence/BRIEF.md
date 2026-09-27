# Search evidence sufficiency

Status: proposed experiment. No evaluator results or qualification evidence exist for this brief.

## Purpose

Test whether measuretwice distinguishes a relevant passage from evidence sufficient to answer a question.
Start with a fixed local collection so retrieval behavior remains separate.

## Case and checks

Each case contains a question, a retrieved passage, and available source context such as date and scope.

- Does the passage address the actual question?
- Does it supply the facts needed for an answer?
- Do its conditions and scope match the question?
- Does the supplied source context meet any stated freshness requirement?

Pass means the passage supplies sufficient evidence within the stated scope.
Fail means the passage clearly addresses a different question or an incompatible scope.
Review means evidence or source context is incomplete or ambiguous.
An execution failure remains an error.

## First experiment

1. Select questions with answers established in a local document collection.
2. Pair each question with sufficient, incomplete, and misleadingly relevant passages.
3. Have a reviewer label evidence sufficiency without evaluator answers.
4. Keep related questions and source documents apart across development and validation groups.
5. Compare direct evaluation with measuretwice on incorrect acceptance, coverage, and review effort.

Keep reference answers and labels out of evaluator inputs.
Record passage selection methods and label provenance.
Separate deliberately difficult passages from samples of actual search results.

## Decision and limits

Continue if the checks reject incomplete evidence without losing too many sufficient passages.
The owner must state acceptable error and review limits before fitting a policy.
This experiment does not measure retrieval completeness or source truth.
A passing passage assessment does not establish the correctness of a later generated answer.
