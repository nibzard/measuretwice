# Ergonomics update verification

Date: 27 September 2026.
Status: implementation and automated verification complete. Human usability remains unmeasured.

## Delivered changes

- The README starts with one requirement and an executable first-check example.
- `npm run example` builds the package and shows three cases beside their reports.
- `load` accepts a generated profile value without requiring a saved profile.
- Both profile input forms use the same hash, schema, binding, and enforcement checks.
- Review reports distinguish declared review answers, policy abstention, and skipped work.
- Semantic profile summaries provide a next inspection for their qualification status.
- The evidence guide explains complete claims, missing context, and label provenance.

The [mission record](../product/mission.md) defines the product direction and experience acceptance criteria.
The [specification](../../MVP_SPEC.md) records the additive profile input contract and report requirements.

## Verification

The verified implementation is commit `d6afd4c`, following commits `ea2fab3` and `842f9e9`.
A new local clone contained only committed files and no existing dependency or build directories.
The commands below completed in that clone:

```sh
npm ci
npm run example
npm run check
```

The example produced one pass, one fail, and one review report.
Each report appeared beside its public synthetic source and candidate.
The exploration profile remained unvalidated. The example made no provider call.

| Check | Recorded result |
| --- | --- |
| Rust formatting | passed |
| Rust lint with warnings denied | passed |
| Native and TypeScript builds | passed |
| TypeScript type checks | passed |
| Rust unit tests | 319 passed |
| Rust contract tests | 37 passed |
| TypeScript and repository tests | 572 passed across 48 files |
| Documentation links and reference examples | passed within the repository suite |
| Complete package README example | executed successfully in the development checkout |

New regression tests first failed before their implementations.
They cover direct profile loading, snapshot isolation, hash and binding rejection, and unchanged enforcement refusal.
Report tests cover evaluator review, policy abstention, skipped work, both output formats, and profile next actions.

The [formal applicability record](formal-applicability.md) explains why profile input transport adds no model transition.
No new formal model-check result is claimed.
This run verifies the local Linux target. It does not establish installation on every declared release target.

## Requirement revision follow-up

The [revision example](../../examples/first-check/README.md#revise-the-requirement) adds a speaker attribution requirement.
It rejects the original profile before any assessment, then generates an unvalidated profile for the revised requirement.
Three synthetic cases produce scripted fail, pass, and review outcomes.
This verifies the integration sequence. It measures no evaluator quality.

The new regression test failed before the example existed.
The example command, TypeScript type checks, and all 573 TypeScript and repository tests passed in the development checkout.
The suite now contains 49 test files.
No Rust implementation or critical state transition changed in this follow-up.
The clean-checkout results above describe the earlier implementation; this follow-up used the existing development checkout.

## Authoring guide follow-up

The authoring guide now starts with exploration and makes JSON exports and saved datasets optional at that stage.
Calibration still requires recorded data, label provenance, and owner-defined goals.
Revision comments now specify group declaration order and record order within each group.
The documentation, reference examples, naming checks, and Rust formatting checks passed for these documentation changes.

## What remains unverified

No new human usability study has run.
The owner received an optional question about evaluator answers and policy outcomes; no response was recorded at this update.
That question alone would not establish first-run usability or comparative effort.

The [human study procedure](../guides/usability.md) is the next test of the mission.
It must measure comprehension, setup effort, review effort, and revision work against a direct evaluator integration.
An agent session cannot replace human participant evidence.
These software changes establish no improvement in model accuracy or deployment qualification.
