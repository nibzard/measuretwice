# measuretwice

Author readable checks in TypeScript. Run them through evaluators, and
calibrate before you rely on the results.

This is a development build. Author checks with `defineChecks`, load them,
run one case or one labeled dataset, calibrate one candidate policy, and
get frozen reports.

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

`calibrate` runs one complete calibration in the library. It reads your
calibration plan and your labeled dataset, measures the development cases
through the evaluator you registered, searches the permitted policy family
in the Rust core, and validates the frozen candidate on your independent
split. It returns one candidate profile with the fitting and qualification
reports, whatever the evidence established. It promotes nothing: review the
evidence, store it, and select one reviewed profile hash yourself.

```ts
import {
  calibrate,
  createJevEvaluator,
  defineChecks,
  registerEvaluators,
} from "measuretwice";

const calibration = await calibrate(intervention, {
  plan: ".measuretwice/calibration-plan.json",
  metadata: ".measuretwice/cases/intervention.json",
  records: ".measuretwice/cases/intervention.jsonl",
  evaluators: registerEvaluators(createJevEvaluator()),
  sampling: "grouped_cases",
  evaluationReports: [".measuretwice/reports/intervention-validation.json"],
});

calibration.profile.qualification.status; // "validated_for_scope"
```

The plan declares your goals, so no result weakens them. When the evidence
falls short, the status says so and the profile states the counts.

## Retain the qualification evidence

One selected profile references its evidence: the calibration plan, the
dataset with its splits, and the evaluation reports. You own the storage.
`checkEvidence` verifies that the artifacts you retained still carry the
identities that the profile records. One edited plan, one edited record, or
one renamed split fails with `hash_mismatch` at the recorded reference.

```ts
import { checkEvidence } from "measuretwice";

const check = await checkEvidence(".measuretwice/profiles/intervention.json", {
  plan: ".measuretwice/calibration-plan.json",
  metadata: ".measuretwice/cases/intervention.json",
  records: ".measuretwice/cases/intervention.jsonl",
});

check.statement; // what the check verified, with its counts
check.limitations; // the trust boundary and the retention rule
```

The check verifies content consistency alone. It cannot verify the truth of
a forged dataset, and it reads no evaluation report. Keep one reviewed copy
of the fitting and qualification reports beside the selected profile. One
folder that version control ignores holds no required copy of the
qualification evidence.

## Revise one calibrated policy

One policy-only change reuses the assessments that the prior calibration
stored. `revise` verifies that the prior profile, the revision plan, the
loaded definition, the live evaluator state, and the fitting inputs carry
one identity, then replays the stored assessments under the revised plan.
The validation split decides what runs: the holdout the prior claim
consumed replays its stored assessments and declares itself development
data that one new claim cannot reuse, and one fresh split of one later
dataset revision is measured through the evaluator you registered. The
result holds one new profile with its own content hash, the reuse
verification, and the revision comparison with its concrete changed cases.

```ts
import {
  createJevEvaluator,
  defineChecks,
  registerEvaluators,
  revise,
} from "measuretwice";

const revision = await revise(intervention, {
  prior: calibration, // the value that calibrate returned
  plan: ".measuretwice/revision-plan.json",
  metadata: ".measuretwice/cases/intervention.json",
  records: ".measuretwice/cases/intervention.jsonl",
  evaluators: registerEvaluators(createJevEvaluator()),
  sampling: "grouped_cases",
  evaluationReports: ["reports/intervention-revision.json"],
});

revision.reuse.statement; // what the revision replayed, with its counts
revision.comparison.changed; // the cases the revised policy changes
revision.profile.qualification.status; // what the evidence established
```

One changed question, schema, projection, evaluator, adapter, translation,
model, or input refuses before one assessment is replayed. The prior
validation never validates one revised policy, however better it looks on
development data: one new claim needs fresh independent evidence. The
revision promotes nothing, and the prior artifact stays unchanged.

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
npx measuretwice evaluate .measuretwice/definitions/intervention.json \
  --cases .measuretwice/cases/holdout.jsonl --out .measuretwice/reports/candidate.json
npx measuretwice compare .measuretwice/reports/baseline.json \
  .measuretwice/reports/candidate.json
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
selects a profile through host review, and the CLI states no selection,
so `--mode enforcement` refuses with `profile_not_selected`.

`evaluate` runs one dataset through the same path, one record at one
time, and the Rust core measures the outcomes against the reference
labels of the records. The readable view states the counts and the rates
of every check with their denominators, the slices, the operational
totals, and the population limits. `--purpose` declares why the
evaluation ran and defaults to `exploration`, which claims the least.
`--out` writes the evaluation report artifact that `compare` reads. The
command completes with exit code 0 whatever the metrics state, and one
error or one skip stays visible in the report instead of becoming one
pass. One definition with one question check refuses with the same
evaluator boundary as `run`.

`compare` reads two stored evaluation reports, matches the cases on equal
identifiers and equal input hashes, and prints the matched, the missing,
the changed, and the errored cases beside every metric row with the counts
and the denominators of both sides. The evidence class follows the
declared purposes, so one fitting report makes the whole comparison
fitting evidence. `--out` writes the comparison artifact. The command
states no cost inputs, so no comparison computes one cost.

`calibrate` checks one plan and states one boundary. It reads the plan
through the bounded reader, crosses the core boundary that one calibration
crosses first — the complete plan contract and the definition binding —
and refuses with `evaluator_mismatch`, because one calibration measures
through the evaluator that the plan names and the CLI registers none. It
writes no candidate profile: no measurement ran. Run `calibrate` through
the library in your application, where your code registers the evaluator
of the plan.

`inspect` renders one profile. The summary states the intended use, the
readiness, and the bound definition. `--detail detailed` adds the
evaluator bindings, the policy parameters, the execution limits, the
qualification evidence, and the recorded performance. With `--format
json`, every command prints its complete artifact instead of the readable
view.

No command installs or invokes an authoring agent, and no command selects
one profile for the host. One failed `--out` write leaves no artifact
behind. The complete command reference, with every option, output format,
and exit code, lives in
[the CLI reference](https://github.com/nibzard/measuretwice/blob/main/docs/reference/cli.md).

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

## References

- The
  [API reference](https://github.com/nibzard/measuretwice/blob/main/docs/reference/api.md)
  documents every public operation with its inputs, outputs, side effects,
  resource limits, modes, and failure behavior.
- The
  [artifact reference](https://github.com/nibzard/measuretwice/blob/main/docs/reference/artifacts.md)
  documents the published schemas, the reason codes, the exact string
  semantics, and the profile compatibility rules. The package ships the
  same schema set under `measuretwice/schemas/`.
- [contracts/README.md](https://github.com/nibzard/measuretwice/blob/main/contracts/README.md)
  owns the portable artifact contracts that this package implements.
- The
  [calibration and selection guide](https://github.com/nibzard/measuretwice/blob/main/docs/guides/calibration.md)
  documents one journey from draft checks and reviewed cases to the profile
  hash that your application selects for enforcement.
- The
  [operation guide](https://github.com/nibzard/measuretwice/blob/main/docs/guides/operations.md)
  documents the runtime bounds of one run, the failure behavior of one
  report, the responsibilities of the host application, and the retention of
  the qualification evidence.
- The
  [coding-agent authoring guide](https://github.com/nibzard/measuretwice/blob/main/docs/guides/agent-authoring.md)
  and the
  [coding-agent review guide](https://github.com/nibzard/measuretwice/blob/main/docs/guides/agent-review.md)
  document how one existing coding agent drafts definitions and cases, and
  how it reports results that trace to recorded counts.

## License

Apache-2.0. See [LICENSE](LICENSE).
