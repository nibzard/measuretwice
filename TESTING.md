# Testing measuretwice

This guide records the test suites, the commands, and the rules that keep
the checks deterministic. [AGENTS.md](AGENTS.md) section 6 states the
general test rules. [DEVELOPING.md](DEVELOPING.md) records the workspace
layout.

## Rules for ordinary tests

- Ordinary tests need no credentials and spend no API budget.
- Ordinary tests read local files only. They open no network connection.
- Ordinary tests never read the system clock. They advance a fake clock.
- Ordinary tests never use real randomness. They seed a generator.
- Every test gives the same result on every run, on every supported target.

## Test suites

| Suite | Location | Runner | Checks |
| --- | --- | --- | --- |
| Rust unit tests | next to the code in `crates/` | `cargo test` | Core behavior and invariants. |
| Package tests | `packages/measuretwice/test/` | Vitest | Public package behavior, the CLI, and the test support itself. |
| Repository checks | `tests/repo/` | Vitest | The frozen schemas, the conformance fixtures, the example cases, the formal model records, documentation links, and the project name. |
| Conformance fixtures | `fixtures/` | Every wrapper, through the Rust core | Definitions, inputs, canonical hashing, string rules, TypeBox pairing, assessments, outcomes, profile states, and runtime traces. |
| Live evaluations | `tests/live/` | Vitest with a separate config | Real evaluator runs. Opt-in only. No live test exists yet. |

The package tests load the native binding and the compiled CLI. Run
`npm run build` before you run them.

## Commands

Run these commands from the repository root.

| Command | Effect |
| --- | --- |
| `npm run test` | Build, then run the Rust and TypeScript tests. |
| `npm run test:rs` | Run the Rust tests alone. |
| `npm run test:ts` | Run the Vitest suites alone. |
| `npm run test:live` | Run the opt-in live evaluations. |
| `npm run typecheck` | Type-check the test code and the Vitest configs. |
| `npm run fmt` / `npm run fmt:check` | Format or check the Rust code. |
| `npm run lint` | Run clippy on the workspace with warnings denied. |
| `npm run check` | Run every gate that continuous integration runs. |

## Red, green, refactor

Use this cycle for every behavioral change, as AGENTS.md section 6 requires.

1. State the expected behavior and the failure cases in the task record.
2. Write the smallest test that fails for the stated reason.
3. Run the suite and confirm the new test fails for that reason only.
4. Write the least code that makes the test pass.
5. Run the whole suite and confirm it is green.
6. Refactor the code while the tests stay green.
7. Run `npm run check` before you report the change as complete.

Reproduce a bug with a failing regression test before you fix it. Do not
weaken an assertion to hide a failure.

## Deterministic test support

Two support modules give the same controls to both languages.

- The Rust module `measuretwice_core::testing` in
  `crates/measuretwice-core/src/testing.rs` provides a `FakeClock`, a
  `SequenceIds` generator, a seeded `SplitMix64` generator, and an unbiased
  `shuffle`.
- The TypeScript module in
  `packages/measuretwice/test/support/deterministic.ts` provides the same
  `FakeClock`, `sequenceIds`, and `SplitMix64`, plus a
  `ScriptedBoundary` that fakes one external call boundary.

`SplitMix64` produces identical streams in both languages. Both suites
assert the same golden values, so the parity is itself under test.

`ScriptedBoundary` records every request and answers with scripted results
in order. It fails with an explicit error when the script runs out. It
never invents an answer and it never contacts a service. Use it for
evaluator and adapter boundaries when those features arrive.

## Conformance fixtures

The shared fixtures in `fixtures/` pin the portable contracts before the
wrappers exist. The [fixture README](fixtures/README.md) lists every group and
its runner rule.

- The repository checks in `tests/repo/fixtures.test.ts` verify the fixture
  data: the digest formula, the structural invariants, and the cross-file
  links. They are offline and deterministic.
- Every wrapper runs every group through the Rust core. A wrapper never
  recomputes a rule, a canonical form, or a hash.
- The same fixtures are mandatory for the later Python SDK. MVP_SPEC.md
  section 15 states this requirement.
- A contract change updates the affected fixtures in the same change, as the
  [contracts README](contracts/README.md) requires.

## Formal models

The TLA+ models and their records live in [models/](models/README.md).
AGENTS.md section 7 requires them for critical state behavior. The
execution-state model and the profile-qualification model are published.

- The repository check `tests/repo/models.test.ts` verifies that each
  record matches its module and its configuration. It is offline and
  deterministic.
- TLC itself runs outside the ordinary suite, because the jar is not
  part of the repository. [models/README.md](models/README.md) records
  the pinned release and the exact commands.
- Continuous integration does not run TLC. Task T078 decides the
  release-audit integration.
- A checked model does not prove that the implementation matches it.
  The record for each model states what the model omits.

## Live evaluations are opt-in

A live evaluation contacts a real evaluator. It spends an API budget, and
it may need credentials. Ordinary tests never do this, and MVP_SPEC.md
section 15 requires the separation.

1. Put live tests in `tests/live/` only. The ordinary Vitest configuration
   never loads that directory.
2. Start them with `npm run test:live`. This command uses
   `vitest.live.config.ts`.
3. Read credentials from the process environment. Never commit them.
4. Record the resolved model version, the exact requests, and the actual
   errors with the results.
5. Keep live results out of the ordinary test fixtures. A measured result
   for one model version is not a permanent expectation.

Continuous integration never starts live evaluations. The first live
benchmark arrives with task T065. Do not report a checklist review as a
live evaluation.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. It runs the
Rust format, lint, and test gates, cross-checks the declared Rust targets
that no hosted runner executes natively, and builds the native binding with
Node.js 20, 22, and 24 on Linux, plus Windows and macOS, as
[DEVELOPING.md](DEVELOPING.md) declares. The jobs read no secrets, so the
whole pipeline stays deterministic and free.
