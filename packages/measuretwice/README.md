# measuretwice

Author readable checks in TypeScript. Run them through evaluators, and
calibrate before you rely on the results.

This is a development build. Author checks with `defineChecks`, load them,
run one case or one labeled dataset, and get frozen reports. The
`calibrate`, `evaluate`, and `compare` commands of the CLI arrive with
their task.

## Install

The package ships prebuilt native binaries. Installation needs no Rust
compiler and no source build.

```sh
npm install measuretwice
```

Node.js 20 or later is required. The declared targets are `darwin-arm64`,
`darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu`, and `win32-x64-msvc`.
Installation on another target fails with one clear loading error that
names the declared targets.

## Use

```ts
import { contractVersion } from "measuretwice";

contractVersion(); // 1
```

## The command-line interface

The package ships the `measuretwice` command. It reads explicit `.json`
and `.jsonl` files, and one bare name resolves inside the `.measuretwice`
convention of its kind. It loads no YAML and executes no TypeScript
source. It reads no credential: the host keeps its credentials in its own
mechanism.

```sh
npx measuretwice --help
npx measuretwice validate .measuretwice/definitions/intervention.json
npx measuretwice run .measuretwice/definitions/intervention.json \
  --case .measuretwice/cases/example.json --out .measuretwice/reports/run.json
npx measuretwice inspect .measuretwice/profiles/candidate.json --detail detailed
```

`validate` states the meaning that the Rust core established for one
exported definition: the content hash, the inputs, and every check with
its kind and its acceptable answers. It calls no evaluator and no
provider.

`run` assesses one case through the same validated path as the library,
prints the readable report, and writes the report artifact with `--out`.
One completed run exits with code 0, whatever outcome its report states.
The CLI executes exact rules through the Rust core. It registers no
evaluator adapter, because one loaded file installs no evaluator and the
CLI executes no host code, so one definition with one question check
refuses `run` with `evaluator_mismatch` before any work starts. Run
question checks through the library in your application. Enforcement
selects one profile through host review, and the CLI states no selection,
so `--mode enforcement` refuses with `profile_not_selected`.

`inspect` renders one profile. The summary states the intended use, the
readiness, and the bound definition. `--detail detailed` adds the
evaluator bindings, the policy parameters, the execution limits, the
qualification evidence, and the recorded performance. With `--format
json`, every command prints its complete artifact instead of the readable
view.

## Export one definition for the CLI

The CLI reads JSON data files, so export the result of `defineChecks`
with one trusted application script of your own build. The script is
application code that you review: the CLI never executes it.

```ts
// scripts/export-definition.mts — one trusted application script.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Type from "typebox";
import { defineChecks } from "measuretwice";

const checks = defineChecks({
  version: 1,
  name: "intervention",
  inputs: Type.Object(
    {
      conversation: Type.String({ minLength: 1 }),
      proposed_message: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  checks: [
    {
      id: "message-length",
      name: "The message fits the delivery limit",
      using: ["proposed_message"],
      rule: { maxLength: 280 },
    },
  ],
});

await mkdir(path.join(".measuretwice", "definitions"), { recursive: true });
await writeFile(
  path.join(".measuretwice", "definitions", "intervention.json"),
  `${JSON.stringify(checks, null, 2)}\n`,
  "utf8",
);
```

Run the script with your build, then commit the exported definition. The
content hash covers the canonical content, so JSON formatting changes no
hash.

The repository holds the development guides:

- [DEVELOPING.md](https://github.com/nibzard/measuretwice/blob/main/DEVELOPING.md)
  records the workspace and the build commands.
- [TESTING.md](https://github.com/nibzard/measuretwice/blob/main/TESTING.md)
  records the test suites.
- The complete memory support example lives in
  [examples/memory-support](https://github.com/nibzard/measuretwice/blob/main/examples/memory-support/README.md).
  It authors one definition, supplies three labeled cases, generates one
  unvalidated exploration profile, and runs one shadow case offline.
- The complete intervention review example lives in
  [examples/intervention-review](https://github.com/nibzard/measuretwice/blob/main/examples/intervention-review/README.md).
  It authors the flagship definition with its Choice, Noul, Score, and
  exact rule checks, exports the portable JSON definition through one
  trusted script, supplies six labeled scenarios, and runs every case as
  one shadow case offline.
- The Cassandra shadow adapter example lives in
  [examples/cassandra-shadow](https://github.com/nibzard/measuretwice/blob/main/examples/cassandra-shadow/README.md).
  It integrates one application that keeps its permissions, cooldowns,
  approval mode, and delivery, runs both definitions in shadow mode through
  one host-owned queue and one host-owned storage, and adds no dependency to
  the library.
- [README.md](https://github.com/nibzard/measuretwice/blob/main/README.md)
  is the first-run guide. It records the install targets, the offline
  memory example, and the path to one exploration shadow report.

## License

Apache-2.0. See [LICENSE](LICENSE).
