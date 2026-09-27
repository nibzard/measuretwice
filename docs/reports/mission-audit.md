# Mission acceptance audit

Date: 27 September 2026.
Audited implementation: `8204af098f803a131ab2fb18a6820c35de097191`.
Status: software checks pass. Human experience criteria remain unverified.

The [mission](../product/mission.md) requires less effort to define, inspect, and revise an AI judgment.
Passing software tests does not establish that people understand the interface or need less effort.
This audit keeps those requirements separate.

## Clean-checkout verification

A new local clone contained no dependency directory, Rust build directory, or compiled TypeScript package.
These commands completed successfully from the clone:

```sh
npm ci
npm run example
node examples/first-check/revise.mjs
npm run check
```

The first example displayed its sources and candidates beside one pass, one fail, and one review report.
The revision example refused the old profile before assessment, then displayed one fail, one pass, and one review.
Both examples used fixed synthetic answers and unvalidated profiles. Neither called a provider.

| Check | Result |
| --- | --- |
| Rust formatting and lint | Passed |
| Native and TypeScript builds | Passed |
| TypeScript type checks | Passed |
| Rust unit tests | 320 passed |
| Rust contract tests | 37 passed |
| TypeScript and repository tests | 581 passed across 50 files |

Environment: Linux x64, Node.js 24.18.0, npm 11.16.0, Rust 1.94.0, and Cargo 1.94.0.
This run proves local source installation. It does not prove installation on every supported release target.

## Acceptance evidence

| Mission task | Current evidence | Remaining verification |
| --- | --- | --- |
| First run | The clean checkout executes the README command and produces three contrasting reports. | Observe a new developer's setup effort. |
| First judgment | `exploration.test.ts` runs a profile value without file access and tests binding, snapshot, and enforcement gates. | Measure the concepts a new developer needs before a report. |
| Understand a check | The check states its requirement, inputs, and answer meanings. | Record a new developer's explanation. No human session exists. |
| Understand a review | `render.test.ts` distinguishes evaluator review, policy abstention, and skipped execution in both views. | Observe whether a person interprets those distinctions correctly. |
| Inspect evidence | The first example displays the public source and candidate beside each report. | Observe the participant's investigation and next action. |
| Revise safely | The revision example and `example-first-check.test.ts` verify profile rejection before any evaluator call. | Observe requirement revision and identification of evidence that needs new evaluation. |
| Decide about reliance | Calibration, evaluation, and rendering tests preserve counts, denominators, insufficient evidence, and qualification limits. | Review the reports with an owner and record their interpretation. |

The implementation separates requirements, evaluator behavior, and numerical rules.
It preserves case provenance, unvalidated exploration, bounded execution, and explicit application authorization.
The [verification record](ergonomics-update.md) records each change and its tests.
The [formal applicability record](formal-applicability.md) states the limits of model correspondence.

## Human study handoff

Use [the study procedure](../guides/usability.md) with a developer who has not read the implementation.
The task includes first authoring, evidence inspection, an attribution change, and a comparable direct evaluator integration.
Declare effort and comprehension targets before the comparison. Record task order and facilitator help.
Keep timestamps, errors, participant explanations, and source identities.

No participant, session record, comparative effort result, or agreed study target has been supplied for this follow-up.
The participant request remains unanswered at this audit.
Existing agent sessions and synthetic model labels cannot supply that evidence.
The mission therefore remains open. No measured ergonomics advantage, human comprehension result, or deployment reliability is claimed.
