# Developing measuretwice

This guide is for contributors. It records the workspace layout, the
supported targets, the pinned dependencies, and the ordinary development
commands. [MVP_SPEC.md](MVP_SPEC.md) controls product scope.
[AGENTS.md](AGENTS.md) states the engineering rules. [TESTING.md](TESTING.md)
records the test suites and the verification commands. The task list is
`to-do.json`.

## Workspace layout

| Path | Content |
| --- | --- |
| `crates/measuretwice-core` | Shared Rust library. It owns contract validation, input projection, exact string rules, decision policy, profile validation and evaluator compatibility, outcome aggregation, canonical content hashes, and statistics. |
| `crates/measuretwice-node` | Thin NAPI-RS binding. It exposes serializable core operations to Node. The `npm/` directory below it holds the generated platform packages. |
| `packages/measuretwice` | The one public TypeScript package, with the CLI entry point. |
| `contracts/v0` | The frozen portable artifact contracts. |
| `fixtures` | Shared cross-language conformance fixtures for the portable contracts. Mandatory for every wrapper. |
| `providers` | Verified provider contracts and synthetic response fixtures for the evaluator adapters. Jev lives in `providers/jev/`. |
| `models` | TLA+ formal models with their records. See [models/README.md](models/README.md). |
| `scripts` | Standalone build and verification scripts, such as the exact-rule smoke check and the package assembly. |
| `.measuretwice` | Development checks for this repository: two definitions, two datasets on the frozen contract, their JSON exports, and the offline validation and opt-in Jev shadow runners. |
| `examples` | Public teaching examples. `examples/memory-support` holds the minimal memory support workflow, `examples/intervention-review` holds the full intervention review workflow, `examples/intervention-challenge` holds the public synthetic challenge set of that definition, and `examples/cassandra-shadow` holds the application integration with the queue, the storage, and the unchanged decision paths of one host. |
| `tests/repo` | Repository checks for schemas, examples, links, and names. |
| `tests/live` | Opt-in live evaluations. Empty until task T065. |

The Rust core never contains provider SDKs, network clients, credentials,
application storage, or rendering. The Node binding stays thin. Native types
never become public TypeScript types. The public API stays independent of
providers.

## Supported targets

Development needs Rust 1.88 or later and Node.js 20 or later.

The declared binary matrix for v0 covers five targets. Prebuilt packages must
cover all of them. Normal installation on these targets needs no Rust
compiler.

| Rust triple | Operating system | Architecture | libc |
| --- | --- | --- | --- |
| `x86_64-unknown-linux-gnu` | Linux | x86-64 | glibc |
| `aarch64-unknown-linux-gnu` | Linux | ARM64 | glibc |
| `x86_64-apple-darwin` | macOS | x86-64 | — |
| `aarch64-apple-darwin` | macOS | ARM64 | — |
| `x86_64-pc-windows-msvc` | Windows | x86-64 | — |

The packages declare Node.js 20 or later. Continuous integration must test
Node.js 20, 22, and 24. The workflow `.github/workflows/ci.yml` does this.
It runs the Linux Node.js matrix, one Windows job, one macOS job, and
cross-checks the declared Rust targets without a hosted native runner. It
reads no secrets and starts no live evaluation. The public package ships
ECMAScript modules. The native loader ships the loaders that NAPI-RS
generates. Browser, edge, and WebAssembly runtimes are outside v0.

The file `.gitattributes` normalizes every text file to LF on checkout.
The JSON exports and the hashing fixtures are byte-exact contracts, so a
Windows working tree must hold the committed bytes. Windows checkouts need
no `core.autocrlf` setting of their own.

## Prebuilt packages

Installation on a declared target needs no Rust compiler and no source
build. The public package `measuretwice` ships the compiled entry points,
the declarations, the contract schemas, and the generated NAPI-RS loader
`binding.cjs`. The loader selects the native binary of its platform: the
binary beside it in development, or the `measuretwice-<target>` platform
package after installation.

| Platform package | Target |
| --- | --- |
| `measuretwice-darwin-arm64` | `aarch64-apple-darwin` |
| `measuretwice-darwin-x64` | `x86_64-apple-darwin` |
| `measuretwice-linux-arm64-gnu` | `aarch64-unknown-linux-gnu` |
| `measuretwice-linux-x64-gnu` | `x86_64-unknown-linux-gnu` |
| `measuretwice-win32-x64-msvc` | `x86_64-pc-windows-msvc` |

The staging script `scripts/build-packages.mjs` assembles every package:

1. `napi create-npm-dirs` writes the platform package directories under
   `crates/measuretwice-node/npm/`.
2. Every built binary moves into its platform package, and every package
   receives the license.
3. The script stages the public package under `build/package/measuretwice`
   with the schemas and the `optionalDependencies` that select the native
   artifact of the installing platform.

The staged manifest carries the `optionalDependencies`, because the
platform packages reach the registry only with the first release. A
committed reference to an unpublished package breaks `npm ci` in the
workspace. `npm run build:artifacts` builds the release binaries of every
target the build host can produce: the host target natively, the other
targets through the zig cross toolchain. The artifact workflow pins one
zig release, because zig renamed its archives at 0.14 and older setup
actions request archive names that no longer exist. A Windows MSVC binary
needs a Windows host. The workflow `.github/workflows/build-artifacts.yml`
builds every declared target on a matching runner, collects the binaries,
and packs the assembled packages as workflow artifacts. It is the source of
truth for released binaries.

### Clean installation gate

A successful native installation is a delivery gate, not an assumption.
`scripts/verify-install.mjs` packs the assembled packages, creates one
empty project outside the repository, removes every Rust tool from the
installation environment, and installs the packed tarballs there with the
platform package of the host. It then runs `scripts/install-check.mjs`
inside that project: the public ECMAScript module import, the exact-rule
smoke case through both authoring paths, the shipped type declarations and
CLI entry, the CommonJS rejection, and the resolution of the native
artifact, compared by its sha256 digest against the packed binary. The
command `npm run verify:install` runs the whole chain locally. The gate
needs the registry for the pinned `typebox` dependency; measuretwice
itself loads from the packed tarballs only.

The install job of the artifact workflow requires one clean installation
per declared Node version: Node.js 20, 22, and 24 on Linux x64, Node.js 22
on Windows x64 and macOS ARM64, and one x64 build of Node on the macOS
ARM64 runner through Rosetta 2 for the darwin-x64 artifact. The
linux-arm64-gnu artifact has no matching hosted runner in that workflow;
the packaging checks verify its tarball content. No job of the gate
installs a Rust toolchain, and the verification script removes any
preinstalled one from the installation environment before it installs.

## Commands

| Command | Effect |
| --- | --- |
| `npm install` | Link the workspaces and install the development tools. |
| `npm run build:native` | Build the Rust core, the Node binding, and copy the loader into the public package. |
| `npm run build:ts` | Compile the public package to `dist/`. |
| `npm run build` | Run both builds in order. |
| `npm run build:artifacts` | Build one release binary for every target this host can produce. |
| `npm run build:packages` | Assemble the platform packages and stage the public package. |
| `npm run verify:install` | Build, assemble, pack, and verify one clean installation of the packed artifacts without Rust tooling. |
| `npm run fmt` and `npm run fmt:check` | Format or check the Rust code. |
| `npm run lint` | Run clippy on the workspace with warnings denied. |
| `npm run typecheck` | Type-check the test code and the Vitest configs. |
| `npm test` | Build, then run the Rust and TypeScript tests. |
| `npm run test:live` | Run the opt-in live evaluations. |
| `npm run smoke` | Print the exact-rule vertical-slice smoke result through the built package. |
| `npm run check` | Run every gate that continuous integration runs. |
| `npm run clean` | Remove generated build output. |

Build the native binding before the TypeScript. The copied
`binding.d.cts` is the type source for the binding import. [TESTING.md](TESTING.md)
explains the suites behind the test commands.

## Pinned dependencies

Every dependency below is pinned to an exact version. Record the reason when
you add or change one.

| Dependency | Version | Purpose | First used |
| --- | --- | --- | --- |
| `serde` | 1.0.229 | Serializable artifact types. | T009 |
| `serde_json` | 1.0.151, with `float_roundtrip` | Parse and serialize the JSON contracts with correctly rounded floats. | T009, T012 |
| `sha2` | 0.11.0 | SHA-256 over the tagged canonical form. | T012 |
| `napi` | 3.13.0 | Node runtime for the binding. | T004 |
| `napi-derive` | 3.6.9 | Export Rust functions to Node. | T004 |
| `napi-build` | 2.5.0 | Binding build support. | T004 |
| `typebox` | 1.3.34 | Author input schemas with inference. | T017 |
| `@typesafe-ai/sdk` | 0.6.0 | Jev evaluator adapter for the TypeScript SDK. | T024 |
| `@napi-rs/cli` | 3.10.5 | Build native artifacts. | T004 |
| `typescript` | 7.0.2 | Compile and type-check the package. | T004 |
| `@types/node` | 26.6.2 | Node type definitions. | T004 |
| `vitest` | 5.0.1 | TypeScript tests. | T005 |

Dependency decisions still open:

- The statistics routines for uncertainty intervals are not pinned yet.
  Select them with the interval methods in T043.

Decided in T009: the core uses no JSON Schema crate. A general validator
that ignores unknown keywords cannot enforce the supported subset, because
`contracts/v0/input-schema.md` requires rejection of unknown keywords. The
core therefore validates the frozen contracts directly over `serde_json`
values. `measuretwice_core::json` is the strict text gate, and each artifact
parser, such as `measuretwice_core::definition`, walks its schema with
stable reason codes and field paths. The strict gate maps the pinned
`serde_json` failure wording to registry codes; the conformance fixtures
cover every row of that mapping.

Decided in T010: `measuretwice_core::input_schema` validates the supported
input schema subset and returns one typed schema tree. Case validation in
later tasks walks that tree, so the data rules and the schema rules cannot
drift apart. `measuretwice_core::definition::validate_definition` runs after
parsing, keeps the authored artifact unchanged, and establishes the kind of
every check. It adds no evaluator name and no numerical cutoff.

Decided in T011: `measuretwice_core::case` parses the run-case envelope,
which holds `id` and `input` only, and rejects every other field. The input
data walker `measuretwice_core::input_schema::validate_input` walks the typed
schema tree and enforces the published data limits. `ValidatedCase` owns
projection: each projected request copies only the inputs that the check
`using` list names, so no unvalidated case, label, or unrelated field can
reach an evaluator.

Decided in T012: `measuretwice_core::hashing` implements the frozen
canonical hashing contract alone. It covers RFC 8785 canonicalization, the
seven hash domains, the tagged SHA-256 digest, and each artifact boundary.
The definition domain materializes the `when_uncertain` default. Profiles
and plans compute and verify their self-hash. Dataset and split hashes
order records by case identifier. The core adds no canonicalization
dependency: Rust `{:e}` formatting gives the shortest round-trip digits,
and the module applies the ECMAScript `Number::toString` placement rules of
RFC 8785 section 3.2.2.6. Integers above 2^53 round to their binary64
value. The workspace also enables the serde_json `float_roundtrip`
feature. Without it, the default parser sits one unit in the last place
away from the binary64 value for many decimal texts, which silently changes
canonical forms and hashes. A differential check against Node
`JSON.stringify` over thousands of generated values found no difference.
The fixtures in `fixtures/hashing` and the worked examples in
`contracts/v0/hashing.md` pin every digest.

Decided in T013: `measuretwice_core::rule` implements the exact string
rules of `contracts/v0/hashing.md` alone. It owns the one length measure,
Unicode code points, and the one matching relation, containment of a code
point sequence. `parse_rule_parameter` is the single authority for rule
parameter validity, and the definition parser in
`measuretwice_core::definition` calls it, so an authored rule and a directly
constructed rule pass one gate. Assessment takes a validated projection,
records the executed rule as the `applied_rule` shape of the run report
contract, and explains the outcome with a sanitized reason. A rule produces
`pass` or `fail` and needs no evaluator, no confidence value, and no
calibration evidence.

Decided in T014: `measuretwice_core::report` owns the outcome vocabulary
and the immutable run report record. The component outcome, the aggregate
outcome, and the completion status are three separate types, and
`report::aggregate` folds components with the fixed order of the contracts:
fail, then error, then review or skipped, then pass. `ReportBuilder`
collects one record per check and finishes one `RunReport` that offers read
accessors only, so a late result cannot enter a completed record. The report
keeps every component outcome, including errors beside a fail, records the
stable identifiers, the content hashes, the raw assessments, the executed
rules, the applied policy parameters, the actual evaluator versions,
attempts, timing, usage, and sanitized reasons, and holds no application
authorization field. `report::parse_run_report` rebuilds a stored report,
enforces the conditional record rules, and rejects a stored aggregate that
disagrees with its component outcomes. The assessment stays recorded as
returned: the report boundary checks the structural assessment schema, and
the semantic normalization, such as evidence authorization against the
`using` list, stays with the evaluator adapter tasks.

Decided in T015: `measuretwice_core::run_state` applies the checked
execution model at the Rust boundary. One `RunState` value is one run of one
case: the run binding, the case reference plus the profile reference, is
fixed at construction, and every attempt start offers that binding again.
The boundary validates attempt starts, results, attempt failures, queue-full
skips, and the terminal transitions, and it refuses late, duplicate, or
mismatched events with a typed rejection that changes no state. The wrapper
keeps the queue, the deadline, the backoff, and the cancellation, so the
boundary reads no clock and runs no timer; the wrapper states the terminal
time it observed. A terminal transition assigns a record to every check and
builds the frozen `RunReport` through `ReportBuilder`. The module maps each
method to the transitions of `models/execution/Execution.tla`, the runtime
traces replay through the boundary in the Rust conformance suite, and the
negative control of the model record, a retry with a drifted binding, is a
regression test.

Decided in T016: `measuretwice-node` exposes the core through one thin
NAPI-RS surface of serializable operations: definition and case validation
with input projection, canonical forms and content hashes in every domain,
the exact rule assessments with the record text of each result, and one
`RunState` class that validates every run event against the checked
execution model. Artifacts cross the boundary as strict JSON text, the one
input shape the core already owns, so the strict gate rejects malformed
text before any parser runs. Small structured results cross as plain
values, which is why the `napi` dependency gains the `serde-json` feature.
A domain failure is thrown as one native error whose message holds the
serialized `ValidationError`; `packages/measuretwice/src/native.ts` is the
one reader of that message and rebuilds it into the stable `NativeFailure`
shape, so no safe cause is lost and no binding type becomes public API.
Every exported signature states `Result<T, napi::Error>` in full, because
the derive macro detects the error channel by reading the `Result` path; a
type alias would return the failure as a value instead of throwing it. The
core reference parsers became public so a run binding offered from
TypeScript meets the same rules as one stored inside a report.

Decided in T017: `defineChecks` in
`packages/measuretwice/src/define-checks.ts` owns the TypeBox authoring
conversion and nothing else. The conversion walks the authored schema,
drops the TypeBox markers and the annotation keywords `title`,
`description`, and `examples`, renames `version` to `schema_version`, and
copies every other keyword as it is. It adds no keyword, so an
unsupported keyword reaches the Rust core and fails with the same code and
field path as the equivalent JSON authoring; TypeBox and JSON cannot drift
apart. Before serialization the wrapper rejects what JSON would silently
lose: Refine checks and codec transforms hold callbacks, and values such as
regular expressions, class instances, `NaN`, big integers, symbols, and
`undefined` never cross. Those failures carry `nonportable_value`. An
`Unsafe` type and the optional modifier outside one object property carry
`unsupported_keyword`, because the subset cannot state them. The Rust core
then validates the complete artifact, and its `NativeFailure` becomes the
public `ValidationError` of `src/error.ts`; field paths use the contract
names. The return value is the definition artifact itself, deep-copied and
frozen, so `JSON.stringify` writes the portable contract and no native
type leaks. Inference stays TypeScript-only: `DefinedChecks` carries the
case-input type in one phantom property that the implementation never
sets, and the `using` names constrain to the declared input names, while
the Rust core re-checks both rules for values that arrived by cast.

Decided in T018: `load` and `run` in `packages/measuretwice/src/run.ts` own
the normal library workflow. `load` accepts the definition that
`defineChecks` returned as one trusted import, or one explicit `.json` path.
Every other path fails with `unsupported_format` before one read: loaders
accept no YAML and execute no TypeScript source. The wrapper owns the three
boundaries that the core does not, and all three are load options with Node
defaults: `files` for file access, `now` for the clock, and `nextRunId` for
run identifiers. Tests inject the fake clock, the identifier sequence, and
one in-memory file access. The wrapper writes nothing; report storage stays
with the host. Without one supplied profile, an exact-only definition
receives its derived structural exact profile, hashed through the core in
the profile domain and exposed as `reviewer.profile` for host persistence.
One supplied profile path is verified through the core self-hash first, then
structurally matched in the fixture order: an exact-only definition checks
the policy family first, one definition with question checks checks the
definition binding first. Every bound evaluator reference failed with
`evaluator_mismatch` until evaluator registration arrived with task T022.
`run` validates the case through the core, executes the exact rules, drives
the run state boundary attempt by attempt, and completes with the terminal
time of the injected clock. The returned report is parsed from the frozen
core report and deep-frozen again on the TypeScript side. A definition with
one question check and no bound profile fails `run` with `evaluator_mismatch`
before any work, and enforcement mode requires one `validated_for_scope`
qualification plus the host-selected reviewed hash through
`RunOptions.selectedProfileHash`, as the selection clause of the profile
gate states.

Decided in T019: the exact-rule vertical slice is verified as one path, not
as separate per-layer suites. `packages/measuretwice/test/slice.test.ts`
runs identical cases through TypeBox authoring and through the exported
JSON definition, then requires equal canonical content, equal definition
hashes, equal rule outcomes, and byte-equal serialized reports. Authoring
key order may differ, because canonical content states the identity. The
same suite drives every exact string rule record of the shared fixtures,
including the Unicode boundaries, through the complete public path, checks
that malformed requests fail with the same reason codes at the native
boundary and at the public loader, and runs one child process that poisons
`fetch`, refuses credential-like environment reads, and still completes the
slice while writing nothing. The public package depends on the native
binding and TypeBox only, so no provider package can enter the slice. The
command `npm run smoke` runs `scripts/smoke-exact-slice.mjs` through the
built package and prints the observable result: the definition hash, the
rule outcomes, the aggregate outcome `pass`, the completion, and
`serialized reports identical: yes`, ending with `SMOKE_OK`.

Decided in T020: the prebuilt Node packages follow the generated loader of
NAPI-RS, not a hand-written selector. `napi.targets` in
`crates/measuretwice-node/package.json` declares the five targets, and
`napi.packageName` binds their names to the public package, so the loader
that `napi build` generates requires exactly the `measuretwice-<target>`
platform packages that `napi create-npm-dirs` writes. The loader ships
inside the public package as `binding.cjs` with `binding.d.cts`: in
development the copied host binary answers beside it, and after
installation the `optionalDependencies` of the platform matrix answer. The
private binding package therefore left the runtime dependencies; the
workspace link stays for development imports. `src/native.ts` wraps the one
require of the loader, so a failed load names the declared targets instead
of the generic missing-binary advice of the generated loader, and no Rust
compiler and no source build exists as a fallback. The release profile
strips debug information, so the prebuilt binaries stay small. The staging
script, not a committed manifest, adds the `optionalDependencies`: the
platform packages are absent from the registry until the first release,
and a committed reference would break `npm ci` in the workspace.

Decided in T021: the clean installation gate is one script, not a test
suite. `scripts/verify-install.mjs` owns the environment: it packs the
assembled packages or takes them with `--packages`, filters every Rust
tool out of `PATH`, proves with one probe that `cargo` and `rustc` no
longer resolve, and installs the public tarball and the host platform
tarball as `file:` dependencies of one empty project outside the
repository, so no workspace link and no development build can answer the
import. `scripts/install-check.mjs` owns the observation inside that
project. It imports only `measuretwice`, `typebox`, and the Node builtins,
so the copy stays runnable far from this repository. The pinned
`typebox` dependency comes from the registry like any user installation;
the four platform tarballs that no host needs stay absent and npm skips
them as optional dependencies. The artifact workflow runs the gate with
`--require-all`, so a dropped target tarball fails the pipeline before
any release.

Decided in T022: `packages/measuretwice/src/evaluator.ts` owns the
evaluator registration and execution contract and nothing else. One
evaluator is one host object with one stable identifier, one adapter
version, and one `assess` operation; it may hold any other field, such as
its provider client, because it never serializes. `registerEvaluators`
checks those three fields against the portable identifier and version
rules, rejects one shared identifier with `duplicate_id`, and returns one
frozen registry. Registration stays explicit host code: the host passes
the registry to `load` through its `evaluators` option, no global state
exists, and one loaded profile cannot install one evaluator or execute
code. `load` checks every binding against the registry and fails one
reference outside it, or one adapter version that differs, with
`evaluator_mismatch` before any execution. The internal
`dispatchAssessment` builds one request from one validated definition and
one projected input set of the core: the validated question with its kind
taken from the core check kinds, the `using` list, the projected inputs,
the execution budget, and the caller's `AbortSignal`. It normalizes only
the wrapper concerns: it freezes the answer, keeps one absent optional
measurement absent, and maps one thrown or malformed adapter answer to one
`evaluator_error` operational failure with one message inside the
sanitized reason limit. It adds no field and validates no contract,
because the Rust assessment validation arrived with task T026. The
semantic run path through registered evaluators arrived with task T034.

Decided in T023: `packages/measuretwice/src/test-evaluator.ts` owns the
two shipped test adapters and the separately specified decision rule for
label-only assessments, and nothing else. The module is product code that
leaves with the public package, because the CLI workflows, the host
examples, and the later Python wrapper need one offline evaluator.
`createScriptedEvaluator` validates its whole script at creation, records
every request, checks the cancellation signal at entry, and answers
through one control per step: one valid execution, one raw malformed
resolution, one thrown error, or one delayed response through one
injectable sleep. `createLabelOnlyEvaluator` answers from one fixed table
of check answers and returns exactly the answer kind and the selected
answer, so one absent confidence, distribution, position, evidence
reference, or usage amount stays absent. Neither adapter contacts one
provider, reads one credential, or ships one SDK type.
`labelRuleChecks` resolves the accept and review sets of one validated
definition, with scale acceptance expanded over the declared order, and
`decideLabelOnly` maps one selected answer to pass, review, or fail from
those sets alone. The rule is separate from the `probability_mass_v0`
family on purpose: it reads no confidence and no cutoff, one confidence
value cannot change its outcome, and it changes no check meaning, so
replacing one evaluator with another preserves the definition and its
hash while the profile binding, the adapter version, and the profile
content hash must change. The shared cases live in
`fixtures/adapters/conformance.json` with the manifest group
`adapters-conformance`; the package suite in
`packages/measuretwice/test/test-evaluator.test.ts` and the repository
checks in `tests/repo/fixtures.test.ts` keep them honest.

Decided in T024: the Jev SDK is `@typesafe-ai/sdk`, pinned to 0.6.0. The
version was verified against the live documentation, the npm registry, and
the shipped package on 24 September 2026. The verified contract record is
[providers/jev/README.md](providers/jev/README.md); it covers response
shapes, model resolution, usage fields, service limits, cancellation,
retries, and batching. No repository code imports the SDK yet. The package
entry lands in `packages/measuretwice/package.json` with the first adapter
code that imports it, in T025 or T026. Until then the public package keeps
`typebox` as its only runtime dependency, so the provider check of the
vertical slice stays valid. The SDK belongs to the adapter, never to the
core or the binding. The synthetic response fixtures with their provenance
live in `providers/jev/fixtures/responses.json`; the repository checks in
`tests/repo/provider-fixtures.test.ts` tie them to this pin.

Decided in T025: `packages/measuretwice/src/jev.ts` owns the versioned
translation of one question check into one Jev question, and nothing
else. A categorical question becomes Choice, one binary question with
exactly the answers yes and no becomes Noul, and one ordered scale
becomes Score, as the [provider record](providers/jev/README.md) states.
The module imports no SDK type, so the public package still keeps
`typebox` as its only runtime dependency; the adapter that sends the
questions arrives with task T026. The translated question is plain JSON
in the wire shape of the pinned SDK, and the Rust core computes its
canonical form and its translation-domain digest, so no wrapper hashes on
its own. The request state frames the supplied content as evidence under
one fixed `evidence` key that holds exactly the projected inputs of
`using`, so labels, label explanations, baseline decisions, and the case
identifier never reach the provider. One changed translated question
changes the digest, so the profile binding that records the digest and
the complete question changes and the prior qualification no longer
applies; the profile compatibility check of task T028 compares one
recorded translation against the live one at load. The shared cases live in
`fixtures/translations/jev.json` with the manifest group
`translations-jev`; the package suite in
`packages/measuretwice/test/jev.test.ts`, the repository checks in
`tests/repo/fixtures.test.ts`, and the Rust integration tests in
`crates/measuretwice-core/tests/contract_fixtures.rs` keep them honest.

Decided in T026: the Jev answer normalization is one module and one Rust
boundary. `packages/measuretwice/src/jev-assessment.ts` normalizes one
response of the pinned SDK into one assessment with its operational
record, or into one operational failure that names the defect, and
`createJevEvaluator` turns that into one registered evaluator. The adapter
takes the Jev boundary as one function that matches `client.systemOne`
structurally and imports no SDK package, so the public package keeps
`typebox` as its only runtime dependency and the host keeps the client and
the credential. Noul confidence never crosses and no binary distribution
is derived; one fractional score position stays unrounded while the
nearest level names the answer, with one tie selecting the higher level.
The operational record keeps the resolved model, the per-request usage,
and the adapter-measured latency, and the sanitized provider errors keep
the class, the status, and the request identifier without one echoed body.
`measuretwice_core::assessment::validate_assessment` owns the semantic
half of the assessment contract: the matching kind, the declared labels
and levels, one position inside the scale, one distribution that names
declared names and sums to one, and evidence references that the `using`
list authorizes. `dispatchAssessment` validates every adapter answer
through that boundary, so one assessment that breaks the contract of its
check becomes one `invalid_assessment` failure and never enters one
report; the adapter may report the operational measurements beside either
result, and the run report records them with its evaluator, timing, and
usage fields. The shared cases live in
`fixtures/adapters/jev-normalization.json` with the manifest group
`jev-normalization`, driven through the adapter and the dispatch contract
by `packages/measuretwice/test/jev-assessment.test.ts`; the repository
checks in `tests/repo/fixtures.test.ts` and the Rust integration tests of
`fixtures/assessments/samples.json` keep the two boundaries honest. The
semantic run path that schedules these executions is task T034, below.

Decided in T027: the v0 decision policy is one Rust module and no wrapper
rule. `measuretwice_core::policy` owns the `probability_mass_v0` family
over the same `AppliedPolicy` record that the run report stores, so the
numerical parameters keep one shape everywhere. `policy::decide` runs one
fixed order: the policy fit and its parameter ranges, the assessment
contract, one declared review label of one Choice answer, the optional
confidence floor, then the two cutoffs with acceptance first. The
acceptable and the unacceptable mass come from the accept and review sets
of the check and the reported distribution, with scale acceptance
expanded over the declared order. One binary answer derives exact
zero-one masses from its value and the accepted answer, because Noul
reports no distribution. One categorical or ordered answer without one
distribution fails with `missing_field`, because one reported label,
level, position, or ordinal mean is no mass. One confidence floor
abstains on Choice and Score answers only: one reported confidence below
the floor reviews, and one absent confidence reviews too, because it
cannot support the floor that the selected policy requires. One floor on
one binary check is one `policy_mismatch`, because Noul defines no
confidence field. The family claims no calibrated probability of
correctness. The unit tests of the module drive the cutoff, the boundary
equality, the review, the floor, and the failure tables, and the Rust
integration tests decide the assessment samples and reproduce the frozen
review record of `fixtures/reports/outcomes.json` through the same
boundary. The run path that applies the family to scheduled executions is
task T034, below.

Decided in T028: profile validation and evaluator compatibility are one
Rust module and one wrapper call. `measuretwice_core::profile` owns the
complete artifact contract: every field rule, the cross-field origin rules
(an exploration profile stays `unvalidated`, an exact profile binds no
evaluator and takes the `exact` family, one calibration profile records
its complete evidence), the cutoff bounds through the shared
`AppliedPolicy` validation, and the stored self-hash, which is verified
last so one field defect names its own field and one edited copy fails
with `hash_mismatch`. `profile::check_compatibility` compares one
validated profile against one loaded definition and the live evaluator
state in one fixed order: the definition reference (or, for one exact-only
definition, the structural exact rule first), the registered evaluator and
its adapter version, the preprocessing identity, the translated question,
the resolved model version, the binding coverage, the policy coverage and
fit, then, for enforcement, the declared scope, the qualification, and
the host selection. The
live state crosses as data, one entry per bound check, because the core
never sees an evaluator object. Shadow mode compares the bindings alone;
enforcement adds the scope, qualification, and selection clauses of the
checked qualification model. The comparison verifies content consistency
and authenticates nothing: one forged dataset that states
`validated_for_scope` passes, and the host review owns that trust. The
Node binding exposes `validateProfile` and `checkProfileCompatibility`;
`load` in the wrapper routes every supplied profile through both and
builds the live entries from the registry. One adapter that translates
exposes the optional `translate` operation of the evaluator contract, so
`load` compares the recorded translation of one bound profile against the
live one; the Jev adapter exposes `translateJevQuestion` this way. The
`run` repeats the
check in enforcement mode, so the qualification clause refuses one
unvalidated profile through the same boundary. Decided in T035: the
selection clause closes the gate. One enforcement run must state the
reviewed content hash of the bound profile through
`RunOptions.selectedProfileHash`, and may state its requested use scope
through `RunOptions.scope`; one absent or foreign selection refuses with
`profile_not_selected` at `/profile/content_hash` before any case work.
The gate keeps its clause order, so one refusal names one clause: the
scope, then the qualification, then the selection. The exact profile of
one exact-only definition needs one selection too, because the host
selects every enforced hash. No run selects, promotes, or rewrites one
profile: the wrapper holds no profile state beyond the frozen artifact
that `load` read. The shared
`fixtures/profiles/states.json` compatibility rows carry the live state,
the mode, the requested scope, and the selected hash, and the Rust,
native-boundary, and repository suites run
every row through the boundary.

Decided in T029: exploration profiles are generated, never hand-authored.
`packages/measuretwice/src/exploration.ts` owns
`createExplorationProfile` and nothing else. The generator is one pure
function of one validated definition artifact, the registered evaluators,
and the stated options: it reads no clock, draws no identifier, and calls
no provider, so the same inputs produce the same artifact and the same
content hash on every call. One binding per question check records the
registered evaluator, its adapter version, and the complete translated
question in canonical text with its translation hash: one adapter that
translates states the question through the optional `question` field of
its `translate` result, and the stated hash must cover the stated
question; one adapter that translates nothing receives the validated
question unchanged, so that question is recorded and hashed in the same
domain. The binding records the requested model alias alone, because
generation measures nothing and resolves no version. The starter policy
comes from the per-check entry, the global option, or the documented
defaults of 0.8 acceptable mass, 0.6 unacceptable mass, and no confidence
floor; the effective execution configuration comes from the starter
defaults plus the stated overrides. The qualification stays `unvalidated`
with the reason `starter_policy`, and the default intended use states that
starter thresholds carry no qualification evidence. The generator owns no
validation of its own: it signs the artifact with the core self-hash, then
runs the complete profile contract and the shadow compatibility check of
the core over the result, so one returned profile loads as generated and
one broken option fails with the code and field path of the core. `run`
now applies the enforcement gate of the core before the pending
semantic-path gate, so one exploration profile in enforcement mode refuses
with `qualification_insufficient` before any case work, whatever checks
the definition holds. Executing the profile changes nothing: the artifact
is frozen and rewritten by nothing, and the calibration API (task T050)
replaces the starter numbers with measured parameters as one new profile
with its own hash.

Decided in T030: bounded scheduling is one wrapper module and no core
change. `packages/measuretwice/src/scheduler.ts` owns `scheduleRun`,
which drives one run state that its caller created with the run binding.
The scheduler discharges the wrapper rows of the model record: it admits
submitted checks in definition order while active slots remain, queues
them while pending slots remain, and records one `queue_full` skip
through the core boundary when both limits are spent. Fresh work and
retrying work share one first-in-first-out queue, and only never-started
work counts against `max_pending`, because one retry of started work is
no new work. Every event crosses the Rust boundary: each attempt start
offers the run binding again, each resolution crosses as one component
record or one operational failure, and the completion states the terminal
time of the injected clock. The scheduler attempts every check of the
definition regardless of sibling outcomes, so no semantic result triggers
cost-based short-circuiting. One thrown execution becomes one
`evaluator_error` failure, so one broken executor records one error
instead of crashing the run. One failed attempt with attempts left returns
to the shared queue and restarts when one slot frees. Task T032 added the
bounded backoff to that restart, and task T034 wired the module into the
complete run path of `run`: every run, exact rules included, crosses it.

Decided in T031: the total deadline and the cancellation are wrapper
state beside the queue, with no core change. One deadline covers queue
time, every attempt, and the backoff between attempts, as MVP_SPEC.md
section 12 requires. The scheduler arms one wake-up at the deadline
instant through one injectable timer operation, and it re-reads the
injected clock before each resolution and each start, so one delayed
wake-up admits no late result: the clock, not the timer delivery, guards
the invariant. At the deadline the boundary ends the run, so active work
records one `deadline_exceeded` error, never-started work records one
`deadline_before_start` skip, and completed records stay. The caller
cancels through one AbortSignal option. Cancellation aborts every attempt
context with the reason of the caller, clears the queue, and ends the run
through the `cancelled` transition of the boundary. Every terminal path
disarms the wake-up, removes the listener on the caller signal, and drops
one resolution that arrives afterwards with one `late_result_rejected`
event, so one adapter that ignores the signal cannot mutate one terminal
report. The suite drives the deadline and the cancellation with one fake
clock that fires armed wake-ups, and it replays the eight shared runtime
traces the scheduler reproduces, beside its own deadline, cancellation,
and late-result tests.

Decided in T032: bounded retries are one wrapper policy over one extended
boundary transition, with no attempt spent on one permanent defect. The
retry policy lives in `scheduleRun` and names its class by reason code
alone: `evaluator_error` and `evaluator_timeout` are retryable transient
conditions, and `invalid_assessment` is permanent, because one adapter
answer outside the contract of its check returns from one retry through
the same broken path. One retryable failure crosses the boundary first,
then waits one bounded backoff before it rejoins the shared queue: the
first retry waits `backoff_ms`, every later retry doubles the delay, the
attempt limit bounds the doubling, and the total deadline bounds the wait,
because the deadline wake-up ends the run before one late backoff can
start work. The delay states no jitter, because the wrapper holds no
random source and one deterministic delay keeps one run replayable. A
zero base delay restarts the attempt when one slot frees. Each retry
starts through the boundary with the same case reference and the same
profile reference, so the drift refusal of the core guards every restart,
and the attempt context repeats the same budget and the same deadline
instant. One permanent failure crosses one new boundary transition,
`failPermanent`: the check records its error at the failing attempt with
the operational code and the true attempt count, whatever attempts
remain, so no dummy restart inflates the count and no defect hides behind
`retries_exhausted`. The checked model gained that branch of `AttemptFail`
and TLC rechecked both configurations without one error. The Jev adapter
configures the SDK retry loop once and disables it: one wrapper attempt
is one SDK request, so hidden SDK retries cannot multiply the requests
and the spend of one budget the wrapper cannot see. The shared trace
`permanent-failure` pins the record shape for every wrapper, and the
scheduler suite drives the backoff, its doubling, the permanent record,
the cancellation during one backoff, and the deadline that ends one
backoff.

Decided in T033: the provider input limits and the call isolation live in
the Jev adapter, with the stable validation code preserved across the
dispatch boundary. `createJevEvaluator` measures every request against
`JEV_STATE_BUDGET_BYTES`, 32,000: the recorded service limit of 32,000
tokens for the state plus the longest question, counted in UTF-8 bytes over
the serialized evidence state plus the serialized question, because the
adapter holds no tokenizer and one token of UTF-8 text covers at least one
byte, so the byte count bounds the token count from above. Evidence above
the budget is rejected before the provider call with one `ValidationError`
of code `oversized_input` and path `/inputs`, and nothing is truncated, as
MVP_SPEC.md section 12 requires. `dispatchAssessment` keeps the stable code
and the field path of one thrown `ValidationError` inside its
`evaluator_error` failure message, so one deterministic rejection stays
distinguishable from one transient adapter defect; the run path of T034
adds the wrapper-level limit validation of the effective execution
configuration before any attempt starts, through the scheduler gate. The
adapter implements no batching: one request carries exactly one question,
keyed by its check, so the different projections of the flagship
intervention-review definition need separate calls, and one later batch
operation may group questions only inside one case and one access scope
under one identical authorized projected state. Every request derives from
exactly one check of one case, the adapter holds no state between calls,
and the boundary options carry only the signal, the attempt timeout, and
the retry policy, so no credential, case identifier, or scope metadata
crosses. Embedded instructions inside supplied evidence stay one string
value inside the fixed `evidence` envelope: they reach no question
instructions, no registered evaluator, and no permission, because
registration is host code and the request shape is fixed. The suite
`packages/measuretwice/test/jev-boundaries.test.ts` pins every rule with
the flagship definition; [providers/jev/README.md](providers/jev/README.md)
records the enforcement and the isolation contract.

Decided in T034: the semantic run orchestration is one wrapper path over
three core boundaries, and no decision rule lives in TypeScript. `run` in
`packages/measuretwice/src/run.ts` validates the case through the core with
the input projection, creates the run state with the attempt limit of the
effective execution configuration, and hands every check to
`scheduleRun`: exact rules and question checks share the same bounded
queue, the same total deadline, the same retries, and the same terminal
report. One question attempt dispatches through `dispatchAssessment` with
the projected inputs of its `using` list, then crosses one new boundary,
`decideQuestionCheck`: the core validates the assessment against its
check, decides it under the `probability_mass_v0` parameters that the
bound profile records, and builds the complete question record with the
assessment, the applied policy, the evaluator versions (the binding
identity plus the model version that served the call), the timing (the
queue wait plus the adapter latency, or the wrapper-measured duration
when the adapter reports none), and the usage. `report::CheckRecord::
from_question` and `report::QuestionMeasurements` compose the record in
Rust, so the wrapper owns no record shape and no outcome arithmetic. One
answer that the selected policy cannot decide, such as one label-only
categorical answer without one distribution, resolves as one permanent
`invalid_assessment` failure that keeps the code and the field path of
the core refusal inside its message, because one retry returns through
the same answer; the error record itself keeps no assessment and no
policy, exactly as the record contract states. A definition with one
question check and no bound profile refuses the run with
`evaluator_mismatch` at `/profile` before any work, because no policy
states how its answers decide. Runs accept one caller `AbortSignal`
through `RunOptions.signal`, and `load` accepts one `setTimer` option so
one controlled clock drives the deadline wake-up. The suite
`packages/measuretwice/test/semantic-run.test.ts` pins the mixed run
(exact rule, Choice, Noul, Score) with its records and projected
requests, the decision table, the retries, the permanent failures, the
queue-full skip, the deadline, the cancellation, and the frozen terminal
report.

- Do not add Zod, Ajv, a YAML parser, or an agent framework to the
  TypeScript runtime. MVP_SPEC.md section 5 rules them out for v0.

Decided in T036: the private-data defaults are contract rules plus canaries,
not one sanitizing filter. One report states no raw case content and no
credential, because the `case` block of `contracts/v0/run-report.schema.json`
names identifier and input hash alone; assessment measurements stay, because
they are the record's purpose. Replay runs through host storage: the
additive, optional field `case.snapshot` holds one host-controlled reference
of 1 to 256 characters that `run` states through the `snapshot` option, the
Rust core validates it at the case-reference boundary (`/case/snapshot`), and
the wrapper itself persists no input, no report, and no retention. The file
access of `load` stays read-only, so the host owns every stored byte. The
Jev adapter keeps its constructed sanitization (class, status, request
identifier) and the wrapper keeps its field-path errors, so failures stay
useful after sensitive content stays out; one host adapter owns its own
failure text, because the wrapper cannot know which of its strings are
private. The suite
`packages/measuretwice/test/privacy.test.ts` drives credential and
private-content canaries through `run`: the serialized report, the
validation failures, and the generated profiles hold none, the measurements
and the sanitized causes stay, one stored profile with one `api_key` or one
case body fails `load`, and the case-reference rows of
`fixtures/reports/outcomes.json` pin the same rules for the later Python
wrapper.

Decided in T037: rendering is one pure module over validated artifacts,
and no view computes one decision. `packages/measuretwice/src/render.ts`
owns the four renderers `renderRunReport`, `renderRunReportMarkdown`,
`renderProfileSummary`, and `renderProfileSummaryMarkdown`, each with the
two inspection levels of MVP_SPEC.md section 8 through the `detail`
option. The summary view leads with the check meaning of the definition,
the component outcomes, the aggregate outcome with its explanation, the
completion status, and the next useful action of the outcome, and it ends
with the standing rule that one report authorizes no application action.
The detailed view adds the executed rule with its parameters, the raw
measurement (answer, distribution, confidence, evidence references), the
applied policy, the evaluator versions with the resolved model, the
attempt counts with the timing and the usage, the identities with the
complete content hashes, and the limitations of the view. The default
explanations come from the check criteria and the executed policy alone:
the selected answer with its authored description and the cutoff
arithmetic of the `probability_mass_v0` family, the executed parameters
of one exact rule, or the stable reason of one error or skip record. One
cutoff sentence renders only when the recorded masses support it, so one
record outside the decision table renders with the general sentence of
its outcome. The renderer invents no Jev rationale, and evidence
references render only as evaluator-selected support, because the Rust
core validated every reference against the `using` list of its check;
raw case content never renders, because the report holds none. Every
render verifies its inputs first: the definition crosses the core
validator and its content hash must equal the hash of the report
(`definition_mismatch`), every record must name one check of the
definition and every error or skip must carry its reason, and the
component outcomes must fold to the stored aggregate; one profile crosses
the core self-hash and the complete profile contract, so one edited copy
fails with `hash_mismatch`. The public `Profile` type gained the optional
`evidence` and `performance` fields of `contracts/v0/profile.schema.json`,
so the detailed view of one calibration profile states its plan, its
datasets, its splits, its label provenance, its evaluation reports, its
statistical method, and its recorded metrics with their counts and
denominators, while no summary view states one performance number. The
suite `packages/measuretwice/test/render.test.ts` covers the failing,
review, floor, and binary-pass explanations, the error and skip reasons,
the cancelled completion, the recorded aggregate explanation, both output
formats, the canary rule, every rejection, the exploration profile
without measured numbers, and the shared insufficient-evidence
calibration profile.

Decided in T038: one shadow run records the new outcome beside the
existing decision, and the existing decision path stays untouched. The
host states what its own path decided through the `baseline` option of
`run` (`{ outcome, revision }`), the Rust core validates it at run
creation through the same parser that owns the run report contract, and
every terminal report records it under `baseline` exactly as stated,
beside the aggregate that the component records produced. Three rules
keep the two facts separate. First, the baseline is shadow-mode data: an
enforcement run holds no existing decision, so one offered baseline
fails with `invalid_field_type` at `/baseline` before any work starts,
exactly as one baseline outside its bounds does. Second, the baseline
keeps the vocabulary of the host decision path, because the library
cannot know what one host decision means, so `outcome` stays one free
bounded string and `revision` names the decision path. Third, the report
computes no agreement, states no accuracy, and holds no field that
combines the two outcomes: baseline agreement is one more observation,
never one correctness claim, so the host compares the two recorded
values itself when it reviews disagreements. `measuretwice_core::
report::Baseline::validate_for_mode` owns the rules for both the
builder and the parse path, `measuretwice_core::run_state::RunState`
carries the baseline beside the run binding and stamps it into the
frozen report at the terminal event, and `createRunState` gained the
optional baseline text, so the later Python wrapper reuses the same
boundary. The suite `packages/measuretwice/test/shadow.test.ts` drives
one host decision path through the public `run`: one pass, one fail, one
review, one operational error, one queue-full skip, and one cancellation
each leave the existing decision, its revision, and the host actions
untouched; the same case under two baselines measures identically; the
malformed baselines refuse before any scripted evaluator runs; and the
enforcement refusal fires under one selected, qualified, exact profile.
`fixtures/reports/outcomes.json` grew the `baselines` group (four valid
rows with the two bound limits, eight invalid rows: two missing fields,
two unknown report data fields, one empty, two overlong, one mistyped),
and the Rust integration suite and `tests/repo/fixtures.test.ts` run
every row.

The host integration follows three rules of the same decision. First,
`run` is one awaited call: it holds its caller until the run reaches one
terminal state, so one shadow call inside one request path adds the
complete run duration to that request. The added latency is observable
(`timing.queued_ms` and `timing.execution_ms` per check record) and
bounded above by `execution.deadline_ms` of the profile, because the
total deadline ends the run with one explicit `deadline_exceeded`
report; the shadow suite pins both. Second, the library starts no
detached job, owns no background scheduler, and leaves no armed wake-up
behind one resolved call, so nonblocking shadow work runs through one
durable queue that the host already owns: the host enqueues the case
with its baseline and its decision revision, one queue worker of the
host loads the reviewer once and awaits `run`, and the host persists the
returned report next to the queued decision. The wrapper holds nothing
between two awaited calls, so one host worker owns the complete
lifecycle. Third, delivery, permissions, storage, and every other
application action stay outside the library: the public surface exports
no such operation, the file access of `load` stays read-only, and the
report holds no field that could carry one authorization.

One host worker that keeps the shadow call off the request path:

```ts
// Host code. The queue, the storage, and the delivery stay host territory.
const reviewer = await load(intervention, {
  profile: ".measuretwice/profiles/intervention.json",
  evaluators,
});

async function shadowWorker(job: QueueJob): Promise<void> {
  // The request path already decided and enqueued its decision.
  const report = await reviewer.run(
    { id: job.caseId, input: job.caseInput },
    { mode: "shadow", baseline: { outcome: job.decision, revision: job.decisionRevision } },
  );
  await storeReport(job.caseId, report); // Host storage.
}
```

Decided in T039: `measuretwice_core::dataset` loads one versioned JSONL
case dataset with its metadata artifact. The core owns the complete
contract: `parse_case_record` checks one record (identifier, group,
slice tags, input object, reference labels, label provenance),
`parse_dataset_metadata_str` checks the metadata artifact (population,
sampling method, revision, label guidelines, kind, languages, declared
record count, split declarations), and `load_dataset` reads the record
file line by line through the strict JSON gate. Every record failure
names its location: the field path states `/records/<line>` plus the
pointer inside the record, counted from line 1. One empty line, one
whitespace-only line, one malformed line, one repeated case identifier
(`duplicate_id` at the repeated line), and one oversized line each fail
before any later record is read. One file of no bytes holds one empty
dataset; one trailing newline ends the last line and adds no empty line.
`validate_dataset` then runs every input object through the run-case
boundary of one validated definition, so an invalid input fails at load
with its line and field, and the returned records project only the
inputs that each check `using` list names. Reference labels and label
provenance stay outside the input object, and the run-case envelope
accepts `id` and `input` alone, so no label reaches an evaluator
request; `runCase` of the public `Dataset` copies one identifier and one
input object only. The published limits: one record line holds at most
8,388,608 bytes, the complete record file holds at most 536,870,912
bytes, and one dataset holds at most 100,000 records. Nothing is
truncated, the loader retains the complete parsed records in memory and
writes no file, and report retention stays with the host. The deeper
split invariants, group coverage, and dataset content hashes arrive with
the split-identity task. `loadDataset` in
`packages/measuretwice/src/dataset.ts` reads one explicit `.json`
metadata path and one explicit `.jsonl` records path through the
injectable file access, `packages/measuretwice/test/dataset.test.ts`
drives the public boundary, and `fixtures/datasets/loading.json` pins
the shared group, including one materialized oversized record.

Decided in T040: the same `validate_dataset` call checks every reference
label against the meaning of the definition it loads with. One reference
that names no declared check fails with `unknown_field`, one answer or
level outside the declared labels of its check fails with `unknown_label`,
one answer or level on a check of the other question kind and one
reference answer, level, or review marker on one rule check fail with
`invalid_field_type`, and one answer beside one level fails the same way.
One reference whose acceptance meaning disagrees with its stated expected
outcome is no failure: the record keeps every field as written, and the
`LabelReview` of the validated dataset flags it. The acceptance meaning
comes from the same answer sets the `probability_mass_v0` policy reads, so
a reference and an assessment answer from one meaning. One review marker
states one ambiguous reference, so it implies one review outcome whatever
answer the record also states. The finding kinds are
`check_outcome_conflict`, for one reference against the expected outcome
of its check, and `overall_outcome_conflict`, for the stated overall
outcome against the aggregate of the stated per-check outcomes. Every
finding names its line, case, check, and field path, and no field of the
record changes. The review also summarizes the provenance of every
reference: counts by author and review status, the corrected references
that keep `label.history`, and the references that need one human review.
Only the reviewed counts are reviewed evidence, so one model proposal
that no human reviewed never appears as one reviewed human judgment;
`reviewed()` of the summary states that count directly. The Node binding
returns the review under `labels` of `validateDataset`, and the public
`Dataset` exposes it as `labels` with `summary` and `findings`, frozen
like the records. `fixtures/datasets/labels.json` pins the shared group,
`crates/measuretwice-core/tests/contract_fixtures.rs` runs it through the
core, and `packages/measuretwice/test/dataset-labels.test.ts` answers the
same group through the public boundary.

Decided in T041: `measuretwice_core::splits` owns the grouped splits and
the dataset identities. `dataset_splits` assigns every record to the split
of its group, so one group never spans two splits, and computes the dataset
content hash plus every split content hash through the shared hashing
boundary over the records exactly as the loader read them. The loader
therefore keeps the raw record objects beside the parsed records, because
an omitted `group` and a stated one hash differently; a host that hashes
its records with `datasetHash` gets the digest the identity verifies. One
stored hash that differs fails with `hash_mismatch`, so one changed input
cannot hide inside one revision, and reordering the record file changes no
hash, so one split reproduces deterministically. The metadata parser
rejects one group that two splits declare with `duplicate_id`, and the
identity reports the group assignments together with the groups that no
split covers, because an unassigned group is neither fitting nor
validation data and one revision must assign it.
`PopulationStatement` maps the dataset kind to the claims it supports: one
targeted synthetic challenge set and one development fixture state no
prevalence and support no qualification claim, whatever their size.
`split_overlap` and `require_separated` detect and refuse fitting and
validation overlap, across two datasets too, because a shared group name
breaks the declared grouping strategy and a shared case identifier is one
duplicated case that supplied both kinds of evidence. `validation_evidence`
classifies one validation split against the holdouts the host states,
because the core holds no clock and no storage: one reused holdout is
development data however it is renamed, since the content hash decides, and
one new qualification claim then needs fresh validation evidence.
`parse_split_identity` is the boundary contract of one split identity, the
words of one dataset selection of a calibration plan. The Node binding
returns the identity and the split identities inside `validateDataset` and
exposes `splitOverlap`, `requireSeparatedSplits`, and `validationEvidence`;
the public `Dataset` carries `identity` and `splits`, and
`detectSplitOverlap`, `requireSeparatedSplits`, and
`classifyValidationEvidence` keep the decision in Rust.
`fixtures/datasets/splits.json` pins the shared group with computed hashes.

Decided in T042: `measuretwice_core::metrics` owns the evaluation
measurement. `evaluate_metrics` takes one validated dataset and the
evaluated cases, and returns one metric set per check plus the
`all_checks` set, one set row per slice tag, and the operational totals.
The reference of one case resolves through `reference_outcome`: the stated
expected outcome wins, otherwise the acceptance meaning of the answer, the
level, or the review marker applies, read from the same answer sets the
`probability_mass_v0` policy reads; `overall_reference_outcome` takes the
stated overall outcome or aggregates the check references. The six rates of
`common.schema.json` each carry their numerator and their denominator, and
one zero denominator keeps the value absent, because unavailable is one
valid result. The three error rates count labeled cases alone; the review
rate, the automatic coverage, and the label coverage count every evaluated
case; one case that errored or was skipped stays in the denominator of
every rate whose population holds it, so an operational failure never
improves a rate. One review rate counts one predicted skip beside one
predicted review, because one skip needs one human decision and the
aggregate already folds one skip into review. The false acceptance rate
and the error among accepted cases share one numerator and state different
denominators, and the contracts README records both. Every result carries
the standing statement that no metric set of one evaluation states
independence between checks. `CaseOutcome::from_report` reads one
evaluated case out of one immutable run report, attempts, elapsed time, and
usage included. One outcome that names no dataset record or no check of
the definition, one repeated case identifier, one omitted check, one
negative elapsed time, and one negative usage amount fail with their field
paths under `/cases/<index>`, and one evaluation with no case fails with
`insufficient_evidence`. `fixtures/metrics/evaluation.json` pins the group
against expectations from one independent implementation of the metric
definitions; the evaluate API of task T044 assembles the report contract
from these sets.

Decided in T043: `measuretwice_core::intervals` owns the uncertainty half of
the measurement. The method is the Wilson score interval of one binomial
proportion, named `wilson_score` in the profile contract, at the three
confidence levels the plan contract declares, with their correctly rounded
standard normal quantiles stated in the source. One interval counts draws, not
cases alone: `independent_cases` declares that every case of one denominator
is one independent draw, and the core compares that declaration with the
groups of the dataset, so one group that holds two cases of the same
denominator leaves that metric `unsupported_sampling` instead of one bound
computed from an assumption the data breaks; `grouped_cases` makes the group
the draw and bounds the share of groups with at least one counted event,
beside the case counts of the rate. Evidence comes before arithmetic: one
metric without one denominator and one denominator below the declared minimum
of draws state `insufficient_evidence` with their counts, and zero observed
errors still bound one risk above zero, which is the point of the method. The
counts come from `metrics::rate_of`, the one function the metric sets and the
group folds read, so one interval and its stated rate can never disagree
about a denominator. Every row keeps the method, the level, the sampling
model, the counts, the draws, and either the bounds or the reason no bound
computes; the report carries the complete method statement, which one
evaluation report cites in its `method` field and one profile records in
`statistical_method`. One unsupported level, one count outside its shape, one
numerator above its denominator, and one sampling word outside the two models
reject with their field paths. `fixtures/metrics/intervals.json` pins the
bounds against values one implementation of the documented formula outside
the core computed. The Node binding exposes `parseIntervalRequest` and
`uncertaintyIntervals`; the evaluate API takes one optional `intervals`
request, checks it before one dataset is read and before one case runs, and
carries the rows beside the artifact.


owns the bounded evaluation. The host states one metadata path, one JSONL
records path, and one declared purpose of `exploration`, `fitting`, or
`independent_validation`. `loadDataset` was split into `readDatasetTexts`
and `datasetOf`, so one evaluation reads the dataset once and validates it
against the definition of the reviewer itself, which is the definition that
assesses the cases. Every record then runs through `reviewer.run` as one
shadow run, one case at one time in record order, so the effective
execution configuration of the profile bounds every case and the total work
stays bounded by the case count. The shadow admission of the run path
accepts every qualification status, one aborted `signal` cancels the case
in flight and stops the loop, and the records that never ran stay counted
under `unevaluated_records` instead of silently missing. The Node binding
`evaluateDataset` rebuilds every run report through the run report
contract, reads each evaluated case out of it through
`CaseOutcome::from_report`, and measures it through the new
`metrics::evaluate`, which returns the metric sets of `evaluate_metrics`
plus one `CaseReference` per case: the resolved reference of every defined
check and its match, read through the same `reference_outcome` the rates
read. The public value holds the contract artifact under `report`, whose
keys are exactly the properties of
`contracts/v0/evaluation-report.schema.json`, and keeps the per-case run
reports under `runs`, because the artifact holds no raw case content and
the actual evaluator versions, the per-check timing, the usage, and the
sanitized reasons live in the run reports. `operational` collects one
sanitized reason per predicted error over all attempts, the attempt count,
and the summed usage; `population` and `limitations` keep the population
statement, the prevalence and qualification limits, the standing
no-independence statement, the unevaluated records, and the fitting limit
beside the artifact. One evaluation with no case refuses with
`insufficient_evidence` at `/cases`, because the report contract holds no
empty evaluation. No evaluation changes one qualification and no host
selection: the reviewer keeps its frozen artifact, the artifact states the
identity alone, and one enforced run after one evaluation still passes
through the complete gate.

Decided in T045: the shadow review export is one Rust module and two public
operations. `measuretwice_core::review` owns the selection and the label
validation. The host owns the meaning of its own decision vocabulary, so it
states one meaning for every baseline outcome word through the
`baselineMeanings` option of `exportShadowReviews`: `pass`, `fail`,
`review`, or `silent`, where `silent` names one absent decision. The core
classifies every stored report through one fixed rule order: one candidate
aggregate of `error` exports as `candidate_error`, whatever its baseline
states; one report without one baseline exports as `missing_baseline`; one
stated meaning that differs from the candidate aggregate exports as
`disagreement`, with one silent meaning matching one pass aggregate alone;
every other report is one agreement. Agreements enter through one
reproducible sample alone: every agreement is ranked by the SHA-256 of the
seed, the case identifier, and the input hash, and the first ranks up to
the stated size are selected, so baseline passes and silent baseline cases
stay auditable and not only suspicious cases reach one reviewer. The
records keep report order and the provenance travels inside the result:
the seed, the algorithm word `sha256_rank`, the sizes, the inclusion rule
sentence of every reason, and the stated meanings. Every record states the
case identifier, the input hash, the run identifier, the host snapshot
reference when the run stated one, the recorded baseline with its meaning,
the candidate outcomes, and its selection reason. The export holds no raw
case content, one baseline word with no stated meaning refuses with
`unknown_field` instead of one silent drop, one enforcement report and one
report of another definition or profile refuse before any selection, and
the batch must hold one report per case identifier. The public value adds
`jsonl`, the records as one JSON Lines text for the review tool of the
host, and the summary counts every classification and the selected
composition by reason and by baseline meaning. `validateReviewLabels`
closes the loop: one returned line states one `{ case_id, expected, label }`
object, the dataset label rules and the meaning checks of `loadDataset`
run unchanged over it through `dataset::validate_record_labels`, the
provenance counts keep human judgments apart from model proposals, and the
validation reads no baseline, because baseline agreement is not
correctness. The case content stays with the host: the host joins the
validated labels with its own stored inputs when it authors one dataset.
The Node binding `exportShadowReviews` rebuilds every report through the
run report contract and `validateReviewLabels` crosses the definition, the
exported case identifiers, and the complete return; the field paths
`/reports/<index>` and `/labels/<line>` state the position of every
refusal. The suite `packages/measuretwice/test/review.test.ts` drives one
nine-case batch through the public boundary with the scripted evaluator,
and the native suite runs both bindings through the run state boundary.

Decided in T046: `measuretwice_core::comparison` owns the comparison of
two evaluation reports on matching cases, and `compare` in
`packages/measuretwice/src/compare.ts` is its public operation.
`parse_evaluation_report` rebuilds one stored evaluation report artifact
through its contract before any number computes: the strict field set, the
identifier and hash rules, the fold of every stored aggregate from its
component outcomes, one uniform check set across every case, one metric
set per check plus the `all_checks` set, the stored counts against the
case outcomes, the rate arithmetic with one numerator inside its
denominator, the three whole-population denominators against the case
count, and the label coverage of one check against its labeled cases, so
one edited copy fails with its field path under `/baseline` or
`/candidate`. `compare_reports` matches the cases: one case matches only
when its identifier and its input hash agree, one changed input hash
never matches and appears under `changed_input_cases`, one case that one
report omits appears under `missing_in_candidate` or
`missing_in_baseline`, and one matched case with one error or one skip
component outcome on either side appears under `errored_cases` or
`skipped_cases`, because one error and one skip decided nothing. Every
matched case with one changed component outcome appears under `changed`
with its changed checks and both aggregate outcomes. The metric rows read
the stored rates, so the public value keeps the numerator and the
denominator of both sides beside every value, and the artifact states the
two values alone. The evidence class follows the declared purposes: both
reports must state `independent_validation` for one comparison that
counts as independent validation evidence, and one fitting evaluation
makes the whole comparison one fitting comparison that supports no
validation claim. The cost tradeoff computes per side only when that
report recorded usage and every recorded key carries one declared cost;
one uncovered key leaves the cost absent and one limitation names the
keys, and latency and usage appear only when one report recorded them.
Two reports that bind different definitions refuse with
`definition_mismatch`, two reports that share no case refuse with
`insufficient_evidence` at `/matching`, and the standing limits state the
denominator rule and that changed inputs alone are detectable: new
measurements are required when the evaluator, the resolved model, the
translation, or the preprocessing changed. The comparison holds no raw
case content, changes no qualification, and selects no profile. The Node
binding `compareEvaluations` crosses the two artifacts, the two
stored-report references, and the optional costs, and the suites
`packages/measuretwice/test/compare.test.ts` and the native suite pin
the matching rule, the tradeoffs, the evidence classes, and every
refusal.

Decided in T047: `measuretwice_core::plan` owns the versioned calibration
plan contract and nothing else. `validate_plan` walks the schema file and
the cross-field rules of the contracts README with the stable reason codes
and field paths: every required owner statement (population, sampling
assumptions, confidence level, constraints with metric, comparison, limit,
and basis, objective, minimum samples, important slices with their own
minimums, the bounded grid, the evaluator configuration, and the fitting
and validation selections), the cutoff bounds above 0.5 and at most 1 with
no repeated value, and the stored self-hash, verified last so one field
defect names its own field. The plan vocabulary stays closed where a typo
would silently weaken a goal: minimum sample counts key by one of the five
published denominator names, one plan that constrains one error metric
states the minimum of that denominator, one metric appears in one
constraint alone, the objective pairs with its improving direction, and
one `at_least` limit takes the observed value alone. `MetricName::
denominator` in `measuretwice_core::metrics` is the one mapping, so the
metric definitions and the plan goals cannot drift apart. The plan also
fixes the enumeration order of its candidate family, which the fitting
task searches: accept outer, rejection inner, floor innermost with no
floor first, so array order alone states the tie-break rule. Three binding
checks compare one validated plan with the loaded world before any data is
read: `check_plan_definition` (one exact-only definition takes no plan,
one foreign definition hash fails `definition_mismatch`),
`check_plan_datasets` (each selection names the offered dataset, revision,
split, and declared purpose, one stored split hash equals the computed
digest, and `splits::require_separated` refuses one shared group or one
shared case), and `check_plan_evaluator` (the registered evaluator and its
adapter version, `evaluator_mismatch` otherwise). One plan without one
stored digest still states its computed identity, which the calibration
output records. The module measures nothing and qualifies nothing;
fitting, frozen validation, and the candidate profile belong to the later
tasks, and the Node binding crosses this boundary with the calibrate API.
`fixtures/plans/validation.json` pins the group, with every digest, the
split hashes, and the candidate order stated by one implementation of the
hashing and enumeration rules outside the core.

Decided in T049: `measuretwice_core::qualification` owns the frozen
validation of one selected candidate and nothing else. `qualify_candidate`
takes one validated plan, one validated dataset, one immutable fitting
report, one validation request, and the stored assessments of the
validation split. The freeze runs first and refuses before one validation
case is read: the plan binds the loaded definition, the fitting report
binds the plan by identifier and computed content hash, the definition by
name and hash, the fitting split by dataset, revision, split, and computed
digest, and the selected candidate sits inside the permitted grid at its
recorded position. One plan edited after the search, one fit of another
plan, one patched identity, one candidate outside the family, and one
search with no feasible candidate each fail with their own code and path,
so validation feedback cannot retune the candidate. The validation split
comes through the plan's own validation selection, must carry the
validation purpose, and must share no group and no case with the fitting
split, and one assessment that names any other case fails with its path.
The replay then decides every validation case once under the frozen policy
through the same `policy::decide` one run reads, folds the outcomes
through the shared metric boundary, and computes the intervals through the
shared interval boundary under the declared sampling model and confidence
level, so one rate, one bound, and one denominator can never disagree. The
request states one draw at least, because the plan states its own evidence
floors per denominator and the module reads them per goal, per slice, and
for the complete validation. Evidence comes before arithmetic:
`splits::validation_evidence` classifies the validation split first, so a
reused holdout, a dataset that states no representative sample, and an
empty split are development data; every goal needs its denominator, the
plan minimum of that denominator, and one sampling model the validation
groups support; and the plan minimums and every important-slice floor gate
the validation as a whole, including one slice the validation holds no
case of. Each miss states `insufficient_evidence` with a calculated reason
that cites its counts, and one measured goal that fails its limit states
`criteria_not_met` with the value and the limit. `validated_for_scope`
records `measured_evidence`. `unvalidated` is the status of one
exploration profile; the frozen validation never sets it, exactly as the
checked qualification model records, and the module's tests pin the three
computed statuses. The result returns the candidate it received with its
applied policy, the complete identities of the plan, the definition, the
evaluator configuration, and both splits, the goal rows, the sample
requirements, the slice rows with their own statements, the metric sets,
the interval rows, and the standing candidate statement: the validation
selects nothing, changes no parameter, and owns no profile state, so the
host keeps the review and the selection. The plan and fitting boundaries
share one split locator and one case preparation through `fitting`, and
the qualification status serializes through `profile::Qualification`, the
one type that holds the four contract words.
`fixtures/qualification/validation.json` pins the group, with the statuses,
the reason codes, the goal rows, and every refusal stated by the Rust
boundary.

Decided in T050: `packages/measuretwice/src/calibrate.ts` owns the
calibration orchestration and nothing else. The Node binding crosses the
core boundaries the orchestration needs: `validatePlan` returns the
validated meaning of one plan with its computed identity, its grid size,
its evaluator configuration, and both dataset selections;
`checkCalibrationBinding` runs the definition and the evaluator checks of
the plan before one dataset is read, and `checkCalibrationDatasets` runs
the split checks before one case is measured, so one plan that the loaded
world refuses costs no spend. `fitPolicy` and `qualifyCandidate` run as
libuv worker tasks: the binding states them as `Task` implementations whose
`compute` reads the plan text, the dataset texts, and the stored assessments
and returns one serialized report, so the bounded search and the frozen
validation never block the Node event loop, no JavaScript runs during them,
and no callback reaches user code. The qualification task re-runs the
deterministic search over the same fitting assessments first, because the
search is one pure function of its inputs: the freeze holds by construction
and no serialized fit report can drift between the two phases of one
calibration. The async rejections cross through the same failure
translation as the sync ones.

The wrapper reads the plan, the dataset metadata, and the dataset records
through the bounded readers, then measures both splits through the same
validated execution path as one ordinary run: `createExplorationProfile`
derives one measurement profile that binds every question check to the
evaluator the plan names, with the model alias the plan requests, `load`
binds it through one synthetic path served by one delegating file access,
and every case runs as one shadow run inside the effective execution
configuration. The runs carry the bounds, the retries, the deadline, and
the cancellation, and their stored assessments, and nothing else, enter the
search: no reference label, no tag, and no provenance field reaches one
evaluator request. One case that ends without one stored assessment refuses
the calibration with the operational code of its own record, one aborted
signal refuses with `run_cancelled` and one pre-aborted signal with
`cancelled_before_start`, and two resolved model versions refuse with
`model_resolution_changed`, because one calibration measures with one model.

The candidate profile copies the measurement bindings with the resolved
model version, applies the frozen candidate to every question check,
records the complete evidence the profile contract requires, and states the
qualification the evidence computed. The label provenance is counted from
the loaded dataset, the statistical method statement comes from the
qualification report, and the host states the evaluation-report references,
because the host owns the storage and the contracts require the complete
evidence set. Every rate of every scope, the bounds of the complete check
set, the measured sample counts, and the statement of every important slice
cross into `performance` unchanged. The artifact is signed with the core
self-hash, validated through the complete contract, and loaded once through
the public boundary before it returns, so the host receives one profile
that binds as generated. No feasible candidate is one valid result: the
profile then records the objective-best candidate of the permitted family
with `criteria_not_met` and one method statement that names the missing
validation, and the calibration measures no validation case, because no
frozen candidate exists to validate. Whatever the status, the calibration
promotes nothing: the host reviews the evidence and selects one reviewed
content hash, and enforcement still refuses the candidate until then. The
scheduler admission loop stops after one run that ended during admission,
such as one caller abort stated from inside the first attempt, so that path
returns the frozen cancelled report instead of one internal refusal.

Decided in T054: the CLI is one entry module and one file module.
`packages/measuretwice/src/cli.ts` owns the surface and nothing else.
`parseCliArguments` maps one command line into one typed invocation of the
six commands that MVP_SPEC.md section 11 specifies, with per-command option
tables, enum validation, required options (`--case` for run, `--plan` for
calibrate, `--cases` for evaluate), and positional arity. `runCli` returns
the exit code: 0 for one completed command, 1 for one failure of files,
artifacts, or data, and 2 for one usage error. Command results print to
stdout and diagnostics print to stderr, so machine-readable output stays
separate from diagnostics. With `--format json`, one failure prints one
JSON error object on stderr that holds the tool name, the stable reason
code, the message, and the field path; the text mode prints one line with
the code. The entry executes only when Node runs the module as the program,
compared through one resolved real path, so one import stays free of side
effects and one installed bin symlink works. T055 implements the
`validate`, `run`, and `inspect` handlers; the `calibrate`, `evaluate`,
and `compare` commands report `not_implemented` with exit code 1 after one
accepted parse, and the help text states that limit.

`packages/measuretwice/src/cli-files.ts` owns the bounded validated reads.
`resolveCliPath` maps one bare identifier into the `.measuretwice` folder of
its kind, keeps one explicit path as stated, and refuses one explicit
`.yaml` or `.ts` path with the registry code `unsupported_format` before
any read. Every reader bounds its file twice, through the stated size
before the read and through the UTF-8 byte count after it, at the published
limit of one record line, 8,388,608 bytes: one oversized file fails with
`oversized_input`, and nothing is truncated. Definitions, profiles, and
cases cross the same Rust validators the library uses, so one executable
field or one credential field fails with `unknown_field`, one edited
profile fails with `hash_mismatch`, and one malformed artifact keeps the
reason code and the field path of the core. One profile reader that
receives one evaluator registry rejects every unregistered reference with
`evaluator_mismatch`, because one loaded file installs no evaluator. The
plan and report readers gate the frozen structure alone, one JSON object,
`schema_version` 1, and every required top-level field, until their
complete contracts arrive with their validation tasks. The CLI defines no
credential option and reads no credential variable; the canaries of the
suites pin that rule. The suites
`packages/measuretwice/test/cli.test.ts` and
`packages/measuretwice/test/cli-files.test.ts` pin the parsing table, the
exit codes, the stream separation, both diagnostic formats, and every
reader rule.

Decided in T055: the CLI implements `validate`, `run`, and `inspect` in
the entry module, so the CLI stays one entry module and one file module.
Every command reads its artifacts through the bounded readers, prints its
result on stdout, and keeps diagnostics on stderr. `validate` states the
meaning that the Rust core established for one exported definition: the
content hash, the input names, and one row per check with the resolved
kind, the executed rule, or the expanded scale acceptance, and it calls no
evaluator and no provider. `inspect` renders one profile through
`renderProfileSummary`, where `--detail detailed` selects the detailed
view and `--format json` prints the stored artifact. `run` reads the
definition, the case, and the optional profile, then crosses the same
`load` and `run` boundary as the library through one in-memory file access
that serves the texts the bounded readers already hold, so no unbounded
read happens and no file is read twice. The run renders its report through
`renderRunReport`, prints the report artifact under `--format json`, and
writes it with `--out`, where one failed write fails with the CLI code
`unwritable_output` and no result on stdout. One completed run exits with
code 0, whatever outcome its report states, because one report outcome is
no command failure.

The CLI registers no evaluator adapter, because one loaded file installs
no evaluator and the CLI executes no host code. A definition with one
question check therefore refuses `run` with `evaluator_mismatch` before
any work starts, and the CLI adds its boundary sentence to that failure
and to the `profile_not_selected` refusal of `--mode enforcement`, which
needs one host-selected profile hash that the CLI states on no option.
Both notes keep the stable code and the field path of the core. The run
command then reaches the pass and fail aggregates through exact rules and
the review aggregate through one queue-full skip of the structural exact
profile; the error aggregate needs one evaluator execution, which the CLI
refuses by design, and the renderer suite covers that view. The `run`
invocation gained the `--out` field that the T054 option table already
accepted. The package README documents the trusted application script
that serializes the result of `defineChecks` into
`.measuretwice/definitions/`, because the CLI loads no TypeScript source.

Decided in T060: the development checks of `.measuretwice` are executable
repository artifacts, not prose. Both draft definitions compile against
the implemented package through `.measuretwice/tsconfig.json`, the trusted
script `export-definitions.ts` writes the committed JSON exports, and the
runner `validate.ts` validates both datasets through the Rust core with
no evaluator. The case records moved onto the frozen dataset contract:
`author_type: "model"` replaces `coding_agent`, `reviewed: false` replaces
the unreviewed status, and every reason and origin stays as the agent
proposed it, so the loader counts 18 model-proposed references without one
human review. One dataset metadata file per records file declares the
`development_fixture` kind and one fitting split, so the fixtures state no
independent validation data. The runner `jev-shadow.ts` runs the pinned
Jev experiments: it refuses one run without explicit consent, refuses one
model alias, generates one unvalidated exploration profile, strips every
reference label through `runCase`, and stores every report beside the
dataset. The suite `packages/measuretwice/test/development-checks.test.ts`
builds the folder and pins those rules offline, with one injected call
boundary that drives the pinned path without one provider call. The local
instructions of `.measuretwice/README.md` state the limits: the fixtures
are development data, they are no independent validation set, and they
enforce nothing.

## Generated files

`git` ignores the generated output: `target/`, `node_modules/`, `dist/`,
`*.node`, the generated binding loaders, the platform package directories,
the staged packages, and `*.tsbuildinfo`. The NAPI-RS loader files in
`crates/measuretwice-node` and their copies `binding.cjs` and
`binding.d.cts` in the public package are regenerated by
`npm run build:native`. Do not edit them. `npm run build:packages`
regenerates `crates/measuretwice-node/npm/`, the copied contract schemas,
and `build/package/measuretwice`.

## Licensing

The project is Apache-2.0. See [LICENSE](LICENSE). Source files carry the
SPDX identifier `Apache-2.0`. Package metadata states the license.
