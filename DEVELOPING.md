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
| `crates/measuretwice-core` | Shared Rust library. It owns contract validation, input projection, exact string rules, decision policy, outcome aggregation, canonical content hashes, and statistics. |
| `crates/measuretwice-node` | Thin NAPI-RS binding. It exposes serializable core operations to Node. The `npm/` directory below it holds the generated platform packages. |
| `packages/measuretwice` | The one public TypeScript package, with the CLI entry point. |
| `contracts/v0` | The frozen portable artifact contracts. |
| `fixtures` | Shared cross-language conformance fixtures for the portable contracts. Mandatory for every wrapper. |
| `models` | TLA+ formal models with their records. See [models/README.md](models/README.md). |
| `scripts` | Standalone build and verification scripts, such as the exact-rule smoke check and the package assembly. |
| `.measuretwice` | Development checks for this repository. |
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
targets through the zig cross toolchain. A Windows MSVC binary needs a
Windows host. The workflow `.github/workflows/build-artifacts.yml` builds
every declared target on a matching runner, collects the binaries, and
packs the assembled packages as workflow artifacts. It is the source of
truth for released binaries. Clean installations of the packed artifacts
are verified by task T021.

## Commands

| Command | Effect |
| --- | --- |
| `npm install` | Link the workspaces and install the development tools. |
| `npm run build:native` | Build the Rust core, the Node binding, and copy the loader into the public package. |
| `npm run build:ts` | Compile the public package to `dist/`. |
| `npm run build` | Run both builds in order. |
| `npm run build:artifacts` | Build one release binary for every target this host can produce. |
| `npm run build:packages` | Assemble the platform packages and stage the public package. |
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
| `@napi-rs/cli` | 3.10.5 | Build native artifacts. | T004 |
| `typescript` | 7.0.2 | Compile and type-check the package. | T004 |
| `@types/node` | 26.6.2 | Node type definitions. | T004 |
| `vitest` | 5.0.1 | TypeScript tests. | T005 |

Dependency decisions still open:

- The Jev SDK (`@typesafe-ai/sdk`) is not pinned yet. Verify its contract and
  pin it in T024. It belongs to an adapter, never to the core.
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
definition binding first. Every bound evaluator reference fails with
`evaluator_mismatch`, because evaluator registration arrives with task T022.
`run` validates the case through the core, executes the exact rules, drives
the run state boundary attempt by attempt, and completes with the terminal
time of the injected clock. The returned report is parsed from the frozen
core report and deep-frozen again on the TypeScript side. A definition with
one question check fails `run` with `evaluator_mismatch` before any work,
and enforcement mode requires one `validated_for_scope` qualification.

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

- Do not add Zod, Ajv, a YAML parser, or an agent framework to the
  TypeScript runtime. MVP_SPEC.md section 5 rules them out for v0.

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
