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
| `crates/measuretwice-node` | Thin NAPI-RS binding. It exposes serializable core operations to Node. |
| `packages/measuretwice` | The one public TypeScript package, with the CLI entry point. |
| `contracts/v0` | The frozen portable artifact contracts. |
| `fixtures` | Shared cross-language conformance fixtures for the portable contracts. Mandatory for every wrapper. |
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

## Commands

| Command | Effect |
| --- | --- |
| `npm install` | Link the workspaces and install the development tools. |
| `npm run build:native` | Build the Rust core and the Node binding. |
| `npm run build:ts` | Compile the public package to `dist/`. |
| `npm run build` | Run both builds in order. |
| `npm run fmt` and `npm run fmt:check` | Format or check the Rust code. |
| `npm run lint` | Run clippy on the workspace with warnings denied. |
| `npm run typecheck` | Type-check the test code and the Vitest configs. |
| `npm test` | Build, then run the Rust and TypeScript tests. |
| `npm run test:live` | Run the opt-in live evaluations. |
| `npm run check` | Run every gate that continuous integration runs. |
| `npm run clean` | Remove generated build output. |

Build the native binding before the TypeScript. The generated
`index.d.ts` is the type source for the binding import. [TESTING.md](TESTING.md)
explains the suites behind the test commands.

## Pinned dependencies

Every dependency below is pinned to an exact version. Record the reason when
you add or change one.

| Dependency | Version | Purpose | First used |
| --- | --- | --- | --- |
| `serde` | 1.0.229 | Serializable artifact types. | T009 |
| `serde_json` | 1.0.151 | Parse and serialize the JSON contracts. | T009 |
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
- JSON Schema validation stays inside the core. A general validator that
  ignores unknown keywords cannot enforce the supported subset, because
  `contracts/v0/input-schema.md` requires rejection of unknown keywords.
  The core implements the subset directly. Decide the final split in T009.
- Do not add Zod, Ajv, a YAML parser, or an agent framework to the
  TypeScript runtime. MVP_SPEC.md section 5 rules them out for v0.

## Generated files

`git` ignores the generated output: `target/`, `node_modules/`, `dist/`,
`*.node`, the generated binding loaders, and `*.tsbuildinfo`. The NAPI-RS
loader files in `crates/measuretwice-node` are regenerated by
`npm run build:native`. Do not edit them. Prebuilt platform packages are a
later task, not a committed artifact.

## Licensing

The project is Apache-2.0. See [LICENSE](LICENSE). Source files carry the
SPDX identifier `Apache-2.0`. Package metadata states the license.
