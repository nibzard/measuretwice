# Preserve measurements before policy

Date: 27 September 2026.
Status: implemented in the review response worktree; verification is recorded separately.

## Problem

The Jev adapter reduced the probability of yes to a boolean at 0.5.
The binary policy then treated the answer as probability mass of zero or one.
This discarded uncertainty before the explicit policy could use it.
A label-only evaluator also acquired certainty that it had not reported.

## Decision

Add optional `probability_yes` to the assessment contract.
A binary assessment states either that probability or a boolean `value`.
Reject duplicate probability representations and invalid probability values.
Keep a reported yes/no distribution available for other binary adapters.

Use `probability_mass_v1` for current execution.
Rust derives yes and no masses from `p` and `1 - p`, then applies the check's answer sets and policy cutoffs.
A binary label without probability produces review. It supplies no mass for fitting.
Jev adapter `0.2.0` returns the probability without selecting a label.
The translation version remains unchanged because the provider question remains unchanged.

Historical `probability_mass_v0` profiles remain readable for inspection.
Compatibility checks refuse their execution before any evaluator call.
New exploration profiles must be generated. Calibrated bindings need new fitting and qualification.
Existing reports and historical experiments retain their original contents.

The artifact format gains optional fields and a versioned policy family.
The format retains `schema_version: 1`. Semantic compatibility uses the explicit family and adapter versions.

## Related boundary decisions

Operational causes and retry decisions remain separate from assessment outcomes.
New report reasons retain a structured original cause, retry classification, and safe repair instruction.
Permanent failures use the scheduler's existing permanent transition.
Exhausted retries keep the last cause in structured form.

The CLI remains data-only. `validate-plan` validates data and its definition binding without measuring cases.
Trusted host code registers semantic evaluators. Explicit outcome assertions affect process exits only.

Local inspection accepts original input from the host and validates its hash before display.
It adds no private input to the stored report. It invents no evaluator rationale.

## Consequences and limits

Binary probabilities near 0.5 can now produce review instead of pass or fail.
Synthetic examples must supply explicit probability when they test decisive mass outcomes.
Existing label-only adapters remain valid measurements, but cannot support a mass decision without probability.
Provider probability does not establish calibrated correctness.

Compatibility and retry changes use existing formal transitions.
The models omit payload arithmetic, error mappings, private evidence display, and actual provider behavior.
Regression and contract tests cover those software boundaries.
See [the verification record](../reports/review-response.md) for checked models, software results, and missing external evidence.
