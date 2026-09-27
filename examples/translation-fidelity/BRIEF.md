# Translation fidelity

Status: proposed experiment. No evaluator results or qualification evidence exist for this brief.

## Purpose

Test whether measuretwice detects changes to obligations, exceptions, negation, and uncertainty in translated text.
Assess preservation of meaning separately from writing style.

## Case and checks

Each case contains source text, a candidate translation, the language pair, and any required terminology.

- Does the translation preserve each material claim?
- Does it preserve who must or may perform each action?
- Does it preserve exceptions, conditions, negation, and uncertainty?
- Does it use required terms without changing their meaning?

Pass means the required meaning is preserved.
Fail means a material meaning changes or disappears.
Review means the source is ambiguous or the terminology cannot be resolved.
An execution failure remains an error.

## First experiment

1. Choose one language pair and one domain of short instructions.
2. Collect translations and separate variants with deliberate meaning changes.
3. Ask a bilingual reviewer to label them without evaluator results.
4. Keep variants from the same source document in one development or validation group.
5. Compare direct evaluation with measuretwice on missed changes, incorrect flags, and review effort.

Record reviewer qualifications, disagreements, and the origin of each candidate.
Keep labels and reviewer corrections out of evaluator inputs.
Report deliberate variants separately from naturally occurring translation errors.

## Decision and limits

Continue if the checks identify specific meaning changes that help a reviewer correct the translation.
The owner must state acceptable error and review limits before fitting a policy.
Evidence for one language pair or domain does not qualify another.
Meaning preservation alone does not establish readability or cultural suitability.
