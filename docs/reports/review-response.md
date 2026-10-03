# Review response verification

Date: 27 September 2026.
Baseline: `75799ad`. Changes remain in the shared worktree.
Status: software verification complete. External and empirical acceptance remain open.

The [review plan](../product/review-plan.md) defines the acceptance evidence.
The [measurement decision](../decisions/001-preserve-assessments.md) records contract and boundary choices.

## Implemented behavior

- Binary probability crosses normalization without thresholding. Label-only binary measurements produce review under the current mass policy.
- The new policy family and adapter identity prevent old profiles from acquiring new semantics through execution.
- Operational records distinguish permanent causes and retain structured recovery after exhausted retries.
- The CLI validates plans through `validate-plan`. Exact runs can use declared outcome assertions.
- The trusted semantic runner registers Jev explicitly and defaults to offline fixtures.
- Packaging suites use isolated temporary workspaces. The source scanner uses tracked files.
- Local case inspection checks the original input hash before display. Stored reports remain unchanged.
- Qualification summaries show recorded denominators, provenance, methods, and limitations.
- `AGENTS.md` routes contributors to relevant rules. The complete engineering rules remain in a linked document.

## Software checks

Environment: Linux x86_64, Node.js 24.18.0, Cargo 1.94.0.
All commands ran from the shared worktree above. No release or commit was made.

| Command or check | Result |
| --- | --- |
| `npm run check` | Passed formatting, Clippy, native and TypeScript builds, type checks, and all tests |
| Rust tests | 329 unit tests and 37 contract tests passed |
| TypeScript and repository tests | 637 tests across 54 files passed |
| `npm run verify:install` | Linux tarballs installed and ran with Rust tools removed from the test PATH |
| `node examples/first-check/run.mjs` | Passed; displayed pass, fail, review, and local evidence |
| `node examples/first-check/revise.mjs` | Passed; rejected the old binding before assessment and displayed revised outcomes |
| `node examples/semantic-runner/run.mjs` | Passed offline through the Jev adapter; made no network calls |
| `git diff --check` | Passed |

An earlier full check found two test and documentation issues.
The runner test expected an attempt field absent from successful records.
The revised test counts actual calls and checks the configured attempt limit.
The reference scanner also treated a runner option as a CLI option.
The option now appears in the runner documentation. The final full check passed.

## Formal checks

Tool: TLA+ tools 1.7.4. Configuration files and modules are unchanged.
The checks used the commands in [the model instructions](../../models/README.md#running-the-checks), with separate temporary state directories.

| Configuration | Generated states | Distinct states | Remaining states | Result |
| --- | --- | --- | --- | --- |
| Execution | 6,225 | 2,024 | 0 | Completed without an error |
| ExecutionSaturation | 15,840 | 4,300 | 0 | Completed without an error |
| Qualification | 4,760,528 | 211,024 | 0 | Completed without an error |

Error classification selects the existing retry or permanent branch. It adds no state transition.
Historical policy refusal uses the existing incompatible-profile boundary.
These models do not prove implementation correspondence or provider quality.

## Test isolation

Twenty concurrent scanner and packaging runs passed on Linux x64.
Two separate Vitest processes ran at a time. Each process used a separate packaging workspace.
Every run included the tracked-source scanner and all eight packaging tests.
The repeated command was `npx --no-install vitest run tests/repo/names.test.ts tests/repo/packaging.test.ts`.
A Python executor ran twenty invocations with `max_workers=2` and captured each exit code and log.
The repetition count was selected before the repeated checks.
No failed run was retried or excluded from this count.
macOS and Windows repetition checks remain unverified in this environment.

The shared filesystem filled during the initial isolated packaging check.
Cargo cleanup removed generated core artifacts before the repeated runs.
This setup failure is separate from the successful repetition result.

## Open evidence

- Human participants, a selected recurring task, reviewed cases, and declared study targets are not supplied.
- Fresh-agent comparative observations are not recorded.
- A second real provider and live-call budget are not selected.
- No new semantic quality, comparative effort, or deployment reliability result is claimed.

The [study protocol](../product/workflow-study.md) is prepared. Missing observations remain incomplete.

## Subsequent comparison work

On 30 September 2026, the documentation program gained an independent direct evaluator path and a blind review sheet.
The [engineering comparison](../../examples/documentation-consistency/evidence/comparison-2026-09-30/CONCLUSION.md) used six current-source cases and twelve live calls.
Both integrations returned the same six outcomes. Each disagreed with one unreviewed proposed reference.
Independent human labels and participant effort observations remain open.
This evidence does not complete the workflow study or establish comparative value.
The subsequent full `npm run check` passed with 329 Rust unit tests, 37 contract tests, and 650 TypeScript tests.
The first full check found unused documentation directory exclusions. A regression fixture and traversal fix resolved the failure.
