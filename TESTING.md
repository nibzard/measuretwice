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
| Native boundary | `packages/measuretwice/test/native.test.ts` | Vitest | The NAPI-RS surface: valid requests, malformed data, the stable failure translation, numeric and string behavior, the profile validation and compatibility operations, the runtime traces replayed through the run state class, and the clear loading error outside the declared targets. |
| Authoring | `packages/measuretwice/test/define-checks.test.ts` | Vitest | The `defineChecks` boundary: inferred case-input types and `using` names at compile time, the documented TypeBox conversion, rejection of nonportable values and unsupported forms, and the shared TypeBox pairs executed through the built package with their published hashes. |
| Evaluator contract | `packages/measuretwice/test/evaluator.test.ts` | Vitest | The registration and execution contract: stable evaluator and adapter identities, the optional `translate` operation, the frozen registry, and every registration rejection. The dispatched request of each question kind: the validated question, only the projected inputs of `using`, the budget, and the cancellation signal. Label-only assessments with absent optionals preserved, operational failures, malformed adapter answers, and profile bindings against the registered evaluators. |
| Test evaluators | `packages/measuretwice/test/test-evaluator.test.ts` | Vitest | The shipped test adapters and the adapter conformance cases of `fixtures/adapters/conformance.json`: every scripted control with success, review, malformed, error, and delayed responses; the label-only answers with no invented confidence, distribution, usage, or evidence; the separately specified decision rule for label-only assessments; identical requests and one definition hash across evaluators; and independent profile bindings when evaluator behavior changes. |
| Jev translation | `packages/measuretwice/test/jev.test.ts` | Vitest | The versioned translation of one question check into one Jev question: every translation case of `fixtures/translations/jev.json` through the dispatched request and the public translation, with the canonical text and the translation-domain digest computed by the Rust core; the evidence state with exactly the projected inputs of `using`; the identity variants that change the digest and the evaluator binding while the definition stays, and the load-time translation comparison that refuses one changed binding with `translation_mismatch`; the state rejections that keep labels and baselines out; and the wire shapes tied to the pinned SDK record. |
| Jev normalization | `packages/measuretwice/test/jev-assessment.test.ts` | Vitest | The normalization of one Jev answer into one typed assessment: every case of `fixtures/adapters/jev-normalization.json` through the Jev adapter and the dispatch contract with one injected clock and one fake call boundary, so the Rust core validates each assessment against its check; the operational record with the resolved model, the per-request usage, and the adapter-measured latency; the sanitized provider errors that keep the class, the status, and the request identifier without one echoed body; and the abort and deadline paths that stop the adapter before one call. |
| Run path | `packages/measuretwice/test/run.test.ts` | Vitest | The `load` and `run` boundary: the typed import and the explicit JSON path, injected file access, clocks, and identifiers, YAML and TypeScript path rejection, profile self-hash verification, the complete profile contract and compatibility through the Rust core, case validation failures, the evaluator gate for question checks, the enforcement gate of the core, and report determinism and immutability. |
| Exploration profiles | `packages/measuretwice/test/exploration.test.ts` | Vitest | The `createExplorationProfile` boundary: the starter artifact with its definition reference, one evaluator binding per question check and none for exact rules, the canonical translated question with its translation hash from the adapter's `translate` operation or from the validated question of one adapter that translates nothing, the starter parameters, the effective execution configuration, and the `unvalidated` qualification with `starter_policy`; the deterministic generation, the unchanged stored artifact after shadow use and the enforcement refusal, the absence of any provider call, and every rejection with its code and field path. |
| Vertical slice | `packages/measuretwice/test/slice.test.ts` | Vitest | The complete Rust-to-TypeScript path as one slice: identical cases through TypeBox authoring and the exported JSON definition with equal canonical content, hashes, rule outcomes, and serialized reports; every exact string rule record and the Unicode boundaries through `load` and `run`; malformed requests and invalid cases with the same codes at both boundaries; and one child-process check that the slice uses no network, no credential read, and no provider package. |
| Repository checks | `tests/repo/` | Vitest | The frozen schemas, the conformance fixtures, the example cases, the formal model records, documentation links, the project name, and the prebuilt packages. |
| Packaging | `tests/repo/packaging.test.ts` | Vitest | The published shape: the three declared-target lists stay equal, the public manifest ships the built package without private content, every platform package carries its target fields and the license, the staged manifest selects the native artifact, and the packed tarballs hold the required content only. The suite runs the assembly script, so `npm run build` must run first. |
| Installation gate wiring | `tests/repo/install-gate.test.ts` | Vitest | The offline wiring of the clean-installation gate: the command exists, the check script imports installed packages only, the artifact workflow requires one clean installation per declared Node version, and the guides document the gate. |
| Conformance fixtures | `fixtures/` | Every wrapper, through the Rust core | Definitions, inputs, canonical hashing, string rules, TypeBox pairing, assessments, adapter conformance cases, Jev translations, Jev normalization, outcomes, profile states, and runtime traces. |
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
| `npm run smoke` | Run the exact-rule vertical-slice smoke check through the built package. |
| `npm run verify:install` | Build, assemble, pack, and verify one clean installation of the packed artifacts without Rust tooling. |
| `npm run typecheck` | Type-check the test code and the Vitest configs. |
| `npm run fmt` / `npm run fmt:check` | Format or check the Rust code. |
| `npm run lint` | Run clippy on the workspace with warnings denied. |
| `npm run check` | Run every gate that continuous integration runs. |

## Vertical slice smoke check

The exact-rule vertical slice is the first complete Rust-to-TypeScript
workflow: TypeBox authoring, the exported JSON definition, core validation,
input projection, the exact rules, the run state boundary, and the frozen
report. The vertical-slice suite verifies it inside the test runner. One
command reproduces the same observation outside the runner:

1. Run `npm run build`.
2. Run `npm run smoke`.

The command authors the delivery-limits checks once through TypeBox and
loads them once through the exported JSON fixture. It runs one case through
both paths and prints the observable result:

- `TypeBox authoring and exported JSON agree: yes`
- `rule outcomes: summary-length pass, summary-mentions-limit pass, notice-hides-secrets pass`
- `aggregate outcome: pass`
- `completion: completed at 2026-09-24T00:00:00.000Z`
- `serialized reports identical: yes`
- the last line `SMOKE_OK`

The exit status is 0 when every expectation holds. The command reads local
files only. It uses no credential, opens no network connection, and loads
no provider package.

## Clean installation gate

The prebuilt packages must install and run without a Rust compiler and
without the repository. `scripts/verify-install.mjs` enforces that as one
gate:

1. It packs the assembled packages, or takes packed tarballs with
   `--packages <dir>`.
2. It creates one empty project outside the repository and removes every
   Rust tool from the installation environment. One probe proves that
   `cargo` and `rustc` no longer resolve.
3. It installs the public tarball and the platform tarball of the host
   into that project. The tarballs answer every `measuretwice` import, so
   no workspace link can hide an installation problem.
4. It copies `scripts/install-check.mjs` into the project and runs it
   there. That check imports the public entry points, runs the exact-rule
   smoke case through TypeBox authoring and the exported JSON, rejects the
   CommonJS `require` of the package, checks the type declarations and the
   shipped CLI entry, and resolves the native artifact of the platform,
   compared by its sha256 digest against the packed binary.
5. It prints the observation and `INSTALL_GATE_OK` when every expectation
   holds.

Run `npm run verify:install` locally. The command rebuilds first, so it
always verifies the current tree. The gate needs the registry for the
pinned `typebox` dependency and to learn that platform packages without a
local tarball are absent; optional dependencies that resolve to nothing
are skipped. It loads measuretwice itself from the packed tarballs only.
It uses no credential and runs no provider call, so it stays outside the
rules for ordinary tests but never becomes a live evaluation.

The install job of `.github/workflows/build-artifacts.yml` requires the
gate in continuous integration: one clean installation per declared Node
version, Node.js 20, 22, and 24 on Linux x64 and Node.js 22 on Windows
x64 and macOS ARM64, plus one x64 build of Node on the macOS ARM64 runner
through Rosetta 2 for the darwin-x64 artifact. It runs with
`--require-all`, so a missing platform tarball fails the pipeline. The
linux-arm64-gnu artifact has no matching hosted runner in that workflow;
the packaging checks verify its tarball content, and a matching runner
joins when one exists. The wiring itself is under test:
`tests/repo/install-gate.test.ts` keeps the command, the check script,
the workflow requirement, and this documentation together.

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
evaluator and adapter boundaries. The evaluator contract suite scripts
every adapter through it.

The two shipped test adapters are product code, not test support. They
live in `packages/measuretwice/src/test-evaluator.ts` and leave with the
public package, so hosts and the later CLI workflows exercise evaluator
bindings offline. `createScriptedEvaluator` answers through one control
list with success, malformed, error, and delayed controls, and
`createLabelOnlyEvaluator` answers from one fixed table of check answers.
Both stay offline and deterministic.

## Conformance fixtures

The shared fixtures in `fixtures/` pin the portable contracts before the
wrappers exist. The [fixture README](fixtures/README.md) lists every group and
its runner rule.

- The repository checks in `tests/repo/fixtures.test.ts` verify the fixture
  data: the digest formula, the structural invariants, and the cross-file
  links. They are offline and deterministic.
- The native boundary suite in
  `packages/measuretwice/test/native.test.ts` runs the definition,
  input-validation, canonical-hash, hashing-rejection, string-rule,
  profile-state, and runtime-trace groups through the NAPI-RS binding, so
  the boundary itself answers the same fixtures. The profile-state group
  crosses through `validateProfile` and `checkProfileCompatibility`, so
  every artifact rejection and every compatibility pairing, live evaluator
  state and mode included, answers identically across the boundary. One child-process check
  proves that loading and exercising the binding makes no provider calls
  and writes no application storage.
- The authoring suite in
  `packages/measuretwice/test/define-checks.test.ts` executes the
  TypeScript source of every TypeBox pair through the built package, then
  compares the converted artifact and the definition-domain hash with the
  fixture records. The source is plain JavaScript, so the test rewrites
  its two imports to the pinned TypeBox entry and the built package entry,
  writes one temporary module, and imports it. The fixture stays the one
  source of truth for both sides.
- The Rust integration tests in
  `crates/measuretwice-core/tests/contract_fixtures.rs` run the fixture
  groups that the core owns so far: the valid definition artifacts with
  their check kinds, every definition rejection record, the input
  validation records through the complete case path, the hashing rejection
  records, the canonical hash fixtures across every domain, the exact
  string rule records through the Rust rules, the serialization round
  trips, the TypeBox pair hashes, the profile artifacts through the
  profile boundary (every valid artifact validates, every invalid record
  rejects with its stated code and path, one edited copy fails its stored
  self-hash), the compatibility pairings of the states group through
  `profile::check_compatibility` with the stated live evaluator state and
  mode, the outcome, check record, and completion samples through the
  report builder and parser, and the runtime traces replayed event by
  event through the run state boundary, compared on every expected record,
  the aggregate, the completion, and the rejected events. Each validation
  task adds its own groups when its boundary lands.
- Every wrapper runs every group through the Rust core. A wrapper never
  recomputes a rule, a canonical form, or a hash.
- The test evaluator suite in
  `packages/measuretwice/test/test-evaluator.test.ts` drives every adapter
  conformance case of `fixtures/adapters/conformance.json` through the
  dispatch contract and the shipped test adapters, decides every label-rule
  row with the separately specified test decision rule, and checks the
  replacement and binding invariants. The same cases are part of the
  adapter conformance that the later Python wrapper must reproduce.
- The Jev translation suite in
  `packages/measuretwice/test/jev.test.ts` drives every translation case
  of `fixtures/translations/jev.json` through the dispatched request and
  the public translation, compares the complete question, the canonical
  text, and the translation-domain digest with the Rust core, builds the
  evidence state from the projected inputs, and proves that one changed
  translated question changes the digest and the profile binding while
  the definition stays unchanged. The Rust integration tests hash the
  same questions through the core directly. The later Python adapter must
  pass the same cases.
- The Jev normalization suite in
  `packages/measuretwice/test/jev-assessment.test.ts` drives every case of
  `fixtures/adapters/jev-normalization.json` through the Jev adapter and
  the dispatch contract, so each normalized assessment crosses the Rust
  assessment validation against its check. The responses come from the
  synthetic provider fixtures, the clock is injected, and the Jev boundary
  is one fake function, so the suite stays offline. The later Python
  adapter must produce the same assessments and the same failures.
- The Rust integration tests in `crates/measuretwice-core/tests/contract_fixtures.rs`
  run the assessment samples of `fixtures/assessments/samples.json` through
  `measuretwice_core::assessment::validate_assessment`, one definition per
  answer kind, so the semantic rules of the assessment contract stay inside
  the core.
- The same integration tests decide the valid assessment samples through
  `measuretwice_core::policy::decide` under one `probability_mass_v0`
  policy, and reproduce the frozen review record of
  `fixtures/reports/outcomes.json` through the same boundary. The unit
  tests of `crates/measuretwice-core/src/policy.rs` hold the table-driven
  coverage of the family: cutoff decisions, boundary equality, review
  labels and levels, confidence floors, invalid parameters, unfit
  policies, and the explicit failures for missing distributions and Score
  means.
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

`.github/workflows/build-artifacts.yml` builds one release binary for every
declared target on a matching runner, assembles the platform packages and
the staged public package, and verifies one clean installation of the
packed tarballs per declared Node version without Rust tooling. It uploads
the tarballs as workflow artifacts. It reads no secrets and publishes
nothing. The [clean installation gate](#clean-installation-gate) section
records the coverage.
