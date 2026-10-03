# Review response plan

Date: 27 September 2026.
Status: software changes verified. External and empirical acceptance remain open.
Baseline: `75799ad`. The supplied review examined `94fce87`.

## Objective and scope

Make the requirement, evidence, assessment, and policy result easy to inspect and revise.
Preserve measurements at evaluator boundaries. Keep application authorization with the host.
Follow [the mission](mission.md) and [the specification](../../MVP_SPEC.md).

Complete correctness work before making new reliability claims.
Measure practical value against a direct evaluator integration before expanding the framework.
Use separate changes for each stage. Keep contract changes explicit and reviewable.

This plan adds no hosted service, agent protocol, language binding, or packaging strategy.
It does not lower thresholds to produce more decisive examples.

## Baseline evidence

The implementation started with three confirmed findings:

- Jev normalization converts binary probability to a boolean. Binary policy ignores distributions and derives masses of zero or one.
- General provider failures become `evaluator_error`. The scheduler treats that code as retryable.
- The CLI registers no evaluator. Its `calibrate` command cannot perform calibration.

The name scanner now uses tracked files and excludes untracked packaging transactions.
The scanner and Jev normalization suites passed locally: 16 tests across two files.
These checks do not establish semantic quality or reproduce concurrent macOS packaging.

The [mission audit](../reports/mission-audit.md) records previous software checks and open human experience criteria.
The supplied review's historical execution evidence remains separate from these local observations.

## Work sequence

| Stage | Priority | Deliverable | Depends on |
| --- | --- | --- | --- |
| 1 | P0 | Binary measurement contract and policy | None |
| 2 | P1 | Actionable failures and retry decisions | None |
| 3 | P1 | Truthful CLI and supported semantic execution | Stage 2 for recovery examples |
| 4 | P1 | Verification of test isolation | Existing scanner fix |
| 5 | P2 | Case inspection and clear qualification summaries | Stage 1 |
| 6 | P2 | Comparison with direct integration | Stages 1–5 |
| 7 | P2 | A second real evaluator integration | Stage 6 findings |
| 8 | P2 | Contributor instructions with task routes | None |

Stages 2 and 4 can proceed independently of stage 1.
Do not delay the binary fix for the product study.

## Stage 1: preserve binary probability

Expected behavior: a probability remains a measurement until the explicit policy applies its cutoffs.
An evaluator that supplies only a label does not supply a probability.

1. Define separate probability-bearing and label-only assessment capabilities. Document behavior when a mass policy receives only a label.
2. Add failing tests for validation, normalization, policy boundaries, and equivalent categorical assessments.
3. Preserve Jev's probability of yes. Derive yes and no masses from `p` and `1 - p` in Rust.
4. Update rendering, evaluation, fitting, qualification, fixtures, and examples that depend on binary semantics.
5. Version the changed contract, policy semantics, and adapter identity. Reject incompatible profiles before evaluator execution.
6. Update the specification, contract reference, API reference, and migration instructions together.

Acceptance evidence:

- With yes accepted and cutoffs of 0.8 and 0.6, probabilities 0.49, 0.50, and 0.51 produce review. Probability 0.99 produces pass.
- Tests cover both accepted answers, cutoff equality, range limits, nonfinite numbers, and absent probability.
- Equivalent binary and categorical probability information produces equal masses and outcomes, except for explicit review-label rules.
- Label-only assessments never gain invented masses. An incompatible assessment produces review or an explicit compatibility failure.
- Old profiles cannot acquire the new meaning through ordinary loading or execution. Existing records retain their original meaning.
- Provider probability remains distinct from measured correctness in reports and documentation.

Record the versioning decision in an architecture decision record.
Check the qualification model's applicability when profile compatibility changes. Update and run the model if its transitions change.

## Stage 2: preserve actionable failures

Expected behavior: a record states the cause and whether another attempt can help.
Permanent failures stop after the first attempt.

1. Define a bounded failure contract with a safe cause code, retry classification, and remediation code.
2. Add failing tests for authentication, permissions, oversized input, invalid responses, connection failures, rate limits, and timeouts.
3. Map verified provider classes and statuses to that contract. Define explicit behavior for unknown failures.
4. Make the scheduler use the classification. Preserve the final structured cause when attempts are exhausted.
5. Keep raw provider messages, bodies, headers, credentials, and private evidence outside default records.
6. Update reason references, operations guidance, schemas, and migration instructions.

Acceptance evidence:

- Authentication, permission, and oversized-input failures do not retry. Oversized input causes no provider call.
- Transient failures stay within the existing attempt, deadline, queue, and cancellation limits.
- Structured output distinguishes smaller evidence, corrected credentials, and a later retry without parsing prose.
- Exhausted retries retain the last safe cause and classification.

Review the execution model before changing retry transitions.
Update its applicability record and run the relevant bounded models and regression tests.

## Stage 3: make CLI commands truthful

Use a data-only CLI as the initial design. Keep trusted evaluator registration in host code.
Provide one complete host-owned runner example that calls the public library API.
Do not load executable code because a definition file names it.

1. Replace the unusable calibration command with `validate-plan`. State that it validates data and produces no candidate profile.
2. Make exact-rule execution and semantic execution limits clear in help, errors, and documentation.
3. Add a documented semantic runner with explicit evaluator registration, credentials, budgets, and structured reports.
4. Add an opt-in outcome assertion for CLI runs. Let the caller select outcomes that produce a nonzero process exit.
5. Document command migration and test argument errors, output streams, outcome assertions, and unchanged default exit behavior.
6. Give a fresh agent the documented semantic task. Record command attempts, documentation searches, and completion evidence.

Acceptance evidence:

- Every advertised command performs its named operation.
- The semantic runner completes evaluation without invented flags or implementation searches.
- Process failures and assessment outcomes remain distinct in machine-readable output.
- Outcome assertions affect process exits only. They confer no application authorization.

Use failed agent attempts to revise the interface. An agent session does not establish human usability.

## Stage 4: verify test isolation

Keep the tracked-file scanner fix. Do not replace it with sleeps or blanket retries.

1. Inspect packaging tests for writes to shared source or generated directories.
2. Move conflicting packaging mutations to temporary workspaces. Preserve tests for missing tracked source files.
3. Run scanner and packaging suites concurrently on Linux, macOS, and Windows.
4. Record a declared repetition count, commits, environments, commands, and all failures.

Acceptance evidence:

- Temporary packaging transactions cannot enter the source scan.
- Concurrent packaging tests do not overwrite each other's artifacts.
- Twenty repeated concurrent runs pass on each available target. Unavailable targets remain explicitly unverified.

Repeated success supports the isolation change. It does not prove that all filesystem races are absent.

## Stage 5: improve inspection and qualification

First inspect the existing first-check example and report views. Extend them where they lack required information.
Avoid adding another public abstraction until the example demonstrates repeated integration work.

1. Present the requirement, exact supplied evidence, assessment, and policy result together.
2. Let host code resolve private evidence locally. Keep private content outside stored reports unless the host explicitly includes it.
3. Distinguish recorded execution failure, explicit review answers, and policy abstention. State when the underlying judgment cause is unknown.
4. Show available rationale and its provenance. State when the evaluator supplies no rationale.
5. Show qualification population, metric denominators, sample counts, uncertainty assumptions, human review, and unsupported claims.
6. Replace inaccurate signing language with content-hash language. Explain identity, authenticity, and declared provenance separately.

Acceptance evidence:

- Controlled examples show rejection, abstention, missing evidence, missing rationale, and execution failure without inventing explanations.
- A participant can identify the next useful inspection before changing a threshold.
- Group-level uncertainty and case-level metrics use explicit, distinct denominators.
- Calibration is described as policy fitting. A hash is not described as proof of approval.

## Stage 6: measure the workflow

Choose one recurring task with an actual owner before recruiting participants.
Documentation consistency is a candidate. It is not yet the selected population or a qualification claim.
Adapt [the existing study procedure](../guides/usability.md) rather than creating a separate study framework.

1. Declare participant criteria, sample size, effort targets, correctness targets, case provenance, model pins, and runtime budgets.
2. Prepare a direct integration and measuretwice with the same evaluator, requirements, policies, and comparable cases.
3. Have humans and fresh agents author checks, inspect missing evidence, distinguish rejection from abstention, revise requirements, and rerun changed bindings.
4. Alternate task order. Record facilitator help, incorrect commands, unsuccessful tasks, and learning effects.
5. Measure installation effort, first useful judgment, diagnosis accuracy, revision effort, review time, provider calls, and runtime cost separately.
6. Publish observations with participant provenance, denominators, task identities, and limitations. Keep private data outside public records.
7. Compare results with declared targets. Select further interface work from observed obstacles.

Acceptance evidence:

- The study includes both human and agent observations. Missing participants leave that part incomplete.
- Both paths must satisfy the same decision and diagnosis requirements. A faster but incorrect diagnosis does not establish value.
- Human-reviewed references stay separate from model proposals. Development fixtures do not establish representative reliability.
- Adversarial evidence appears in empirical cases. Input isolation alone is not presented as protection from judgment manipulation.
- Installation uses the intended distribution in a clean supported environment. Toolchain failures and setup costs remain visible.

Participant access, an owner, reviewed cases, and a live-call budget are external requirements.
Do not substitute scripted evaluator output or another agent session for missing human evidence.

## Stage 7: test another evaluator boundary

Select a second real evaluator only when it serves the chosen task or tests an observed capability mismatch.
Use its documented measurements. Do not invent probability for label-only output.

Deliver one adapter, shared contract tests, explicit capability limits, and a binding-change example.
Requalify changed bindings. Record live results separately from software contract results.
Do not claim provider equivalence from shared schemas.

## Stage 8: improve contributor agent experience

Keep `AGENTS.md` short and use it as a map into the repository.
Preserve the complete engineering rules in a linked document.
Route behavioral, contract, formal, empirical, packaging, and documentation tasks to their relevant sources.
Repair existing instruction links and run document checks.

Acceptance evidence:

- The routing file retains essential constraints and links every task category to existing instructions.
- Detailed requirements remain binding and accessible. No evidence or testing requirement is removed.
- Contributor effort remains an empirical question. Future agent sessions record context reads, searches, retries, and completion accuracy.

## Completion checks

For each implementation change, follow red, green, refactor for behavioral tests.
Run the relevant suites, then the repository checks required by [AGENTS.md](../../AGENTS.md).

```sh
npm run check
```

Run relevant formal checks when critical transitions change.
Document commands, model bounds, tool versions, results, and unavailable environments.
Review the specification, public contracts, examples, errors, and migration guidance before marking a stage complete.

Keep software correctness, empirical evaluator quality, installation evidence, and usability evidence separate.
Report completion against the evidence above. Do not mark a study complete because its implementation work is complete.

## Implementation status

The [verification record](../reports/review-response.md) records implemented behavior and checks.
Stages 1 and 2 have software and formal verification.
Stage 3 has an offline execution route; fresh-agent observations remain open.
Stage 4 has twenty concurrent Linux checks; macOS and Windows checks remain open.
Stage 5 has software verification; participant diagnosis remains open.
Stage 6 has a prepared protocol and needs the owner's study inputs.
Its [engineering comparator](../../examples/documentation-consistency/comparison/README.md) now includes current-source cases, separate live calls, and a blind review sheet.
The [recorded trial](../../examples/documentation-consistency/evidence/comparison-2026-09-30/CONCLUSION.md) leaves human references and participant effort open.
Stage 7 needs a selected provider, task, and live-call budget.
Stage 8 has document verification; contributor effort remains unmeasured.
