# measuretwice CLI reference

Status: Reference for the implemented v0 package. Published on 24 September
2026.

The package ships the `measuretwice` command. This page documents every
command, its arguments, its options, its output formats, and its exit
behavior. The behavior is implemented, not proposed.

Run it through the package binary:

```sh
npx measuretwice --help
measuretwice validate .measuretwice/definitions/intervention.json
```

Related references:

- [API reference](api.md) records the library operations behind the commands.
- [Artifact schemas and semantics](artifacts.md) records the published
  schemas and the reason codes.
- [MVP_SPEC.md section 11](../../MVP_SPEC.md#11-small-cli-and-file-layout)
  specifies the command set.

## Rules that hold for every command

**Inputs:** every command reads explicit JSON data files. One argument that
holds one path separator or one dot names one explicit path. One bare
identifier resolves inside the `.measuretwice` convention folder of its
kind, relative to the working directory:

| Kind | Explicit path | Bare name resolves to |
| --- | --- | --- |
| Definition | `<path>.json` | `.measuretwice/definitions/<name>.json` |
| Profile | `<path>.json` | `.measuretwice/profiles/<name>.json` |
| Case | `<path>.json` | `.measuretwice/cases/<name>.json` |
| Dataset records | `<path>.jsonl` | `.measuretwice/cases/<name>.jsonl` |
| Dataset metadata | `<path>.json` | `.measuretwice/cases/<name>.json` |
| Calibration plan | `<path>.json` | `.measuretwice/calibration-plan.json` for the bare name `calibration-plan` |
| Report | `<path>.json` | `.measuretwice/reports/<name>.json` |

The CLI loads no YAML and executes no TypeScript source. One path that names
no accepted format fails with `unsupported_format` before the file is read.
Export the definition with one trusted application script first; the
[API reference](api.md#definechecks) records the authoring path.

**Boundaries:** the CLI registers no evaluator adapter, because one loaded
file installs no evaluator and the CLI executes no host code. It reads no
credential option and no credential variable. No command installs or invokes
an authoring agent, and no command selects one profile for the host.

**Read limit:** one JSON file holds at most 8,388,608 bytes. One larger file
fails with `oversized_input`. Nothing is truncated.

**Streams:** command results print to stdout. Diagnostics print to stderr.
One failure prints one human-readable line in text mode, and one JSON error
object on stderr with `--format json`:

```json
{
  "tool": "measuretwice",
  "error": { "code": "unsupported_format", "message": "…", "field_path": "/definition" }
}
```

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | The command completed. One completed `run` or `evaluate` exits with 0, whatever outcome its report states. |
| 1 | One failure of files, artifacts, or data. |
| 2 | One usage error: `unknown_command`, `unsupported_option`, `missing_argument`, `unexpected_argument`, or `invalid_argument`. |

**Output artifacts:** `--out` writes one artifact as JSON with two-space
indentation and one trailing newline. One failed write prints
`unwritable_output` on stderr and leaves no artifact behind, and the command
prints no result on stdout. The artifacts are plain JSON. The host owns
their storage.

## `validate`

```sh
measuretwice validate <definition> [--format text|json]
```

Checks one exported JSON definition and states the meaning that the Rust
core established for it. The command calls no evaluator and no provider.

The text form prints the definition name, the `valid definition` statement,
the content hash, the declared inputs, and one row per check with its kind
and its acceptable answers. One exact-only definition states that the CLI
runs its rules through the Rust core. One definition with one question check
states the evaluator boundary of the CLI.

The JSON form prints the summary object: `definition`, `content_hash`,
`exact_only`, `inputs`, and `checks` with one row per check.

Failures print the reason code and the field path of the core and exit with
1: `invalid_json` for malformed JSON with its position, the definition codes
for one contract breach, `unsupported_format` for one wrong path, and
`unreadable_file` for one unreadable path.

## `run`

```sh
measuretwice run <definition> --case <path> [--profile <path>]
  [--mode shadow|enforcement] [--out <path>] [--format text|json]
```

Assesses one case through the same validated `load` and `run` path as the
library, prints the readable report, and writes the run report artifact with
`--out`.

The case file holds one JSON object with `id` and `input`. The case
argument resolves through the case kind of the table above.

The text form prints the shared readable report: one row per check with its
outcome, the aggregate outcome with its explanation, the completion status,
and the next useful action. The JSON form prints the complete run report
artifact of [run-report.schema.json](../../contracts/v0/run-report.schema.json).

Exit behavior: one completed run exits with code 0, whatever outcome its
report states, because one report outcome is no command failure. One fail,
one review, one error, and one skip stay visible in the report.

Refusals: one definition with one question check refuses with
`evaluator_mismatch` before any work starts, with or without one profile,
because the CLI registers no evaluator. One profile of another definition
refuses with `definition_mismatch`. One invalid case refuses with its reason
code and field path. `--mode enforcement` refuses with
`profile_not_selected`, because enforcement selects one profile through host
review and the CLI states no selection. Run question checks and enforcement
through the library in your application.

## `calibrate`

```sh
measuretwice calibrate <definition> --plan <path> [--out <path>] [--format text|json]
```

Checks one calibration plan and states the evaluator boundary.

The command reads the definition and the plan through the bounded readers,
then crosses the same core boundary that one calibration crosses first: the
complete plan contract, the definition binding of the plan, and the
registered evaluator that serves it. The CLI registers no evaluator, so the
command refuses with `evaluator_mismatch` and writes no candidate profile.
No measurement ran, so one written candidate would look complete without one
stored assessment behind it.

Run `calibrate` through the library in your application, where your code
registers the evaluator that the plan names and states the sampling model.
The [API reference](api.md#calibrate) records the complete operation.

Failures keep the reason code and the field path of the core and add one
boundary sentence: one plan of another definition with
`definition_mismatch`, one edited signed plan with `hash_mismatch`, one
broken candidate grid with its field rule, one incomplete plan with
`missing_field`, and one unreadable plan with `unreadable_file`. An
exact-only definition refuses with `policy_mismatch`.

## `evaluate`

```sh
measuretwice evaluate <definition> --cases <path> [--metadata <path>]
  [--profile <path>] [--purpose exploration|fitting|independent_validation]
  [--out <path>] [--format text|json]
```

Assesses one dataset through the same validated path as the library, one
record at one time, and measures the outcomes against the reference labels
of the records in the Rust core.

`--cases` names the JSONL records file. `--metadata` names the metadata
file; the default replaces the `.jsonl` suffix of the records path with
`.json`.

`--purpose` declares why the evaluation ran. The default `exploration`
claims the least. `fitting` records that the result is development evidence.
`independent_validation` records validation evidence.

The text form prints the definition and profile identities, the dataset with
its revision and its evaluated and unevaluated counts, the counts and the
rates of every check and of the complete check set with their denominators,
the slices, the operational totals with attempts, elapsed time, usage, and
errors, and the limitations. The JSON form prints the complete evaluation
report artifact of
[evaluation-report.schema.json](../../contracts/v0/evaluation-report.schema.json).

Exit behavior: the command completes with exit code 0 whatever the metrics
state, because one measured error rate is no command failure. One error and
one skip stay visible in the report instead of becoming one pass.

Refusals: one definition with one question check refuses with
`evaluator_mismatch` and the same boundary sentence as `run`. One unreadable
dataset, one malformed line with its position, one foreign reference label,
and one empty dataset refuse with their reason codes and field paths.

## `compare`

```sh
measuretwice compare <baseline> <candidate> [--out <path>] [--format text|json]
```

Compares two stored evaluation reports on their matching cases and prints
the result. The Rust core rebuilds both artifacts through the evaluation
report contract, so one edited copy fails before any number computes.

The text form prints the evidence class, the two report sets with their
profiles, the matching with the matched, changed-input, missing, errored,
and skipped cases, every changed case with its changed checks and both
aggregate outcomes, one metric row per scope and metric with the counts and
the denominators of both sides, the tradeoffs, and the limitations. The JSON
form prints the complete comparison artifact of
[comparison.schema.json](../../contracts/v0/comparison.schema.json).

The evidence class follows the declared purposes of the two reports, so one
fitting report makes the whole comparison fitting evidence. The command
states no cost inputs, so no comparison computes one cost.

Refusals: one report of another definition with `definition_mismatch`, two
reports that share no case with `insufficient_evidence` at `/matching`, one
malformed file with `invalid_json`, and one edited stored count through the
rebuilt arithmetic.

## `inspect`

```sh
measuretwice inspect <profile> [--detail summary|detailed] [--format text|json]
```

Renders one profile artifact through the shared renderer.

The summary states the intended use, the readiness phrase of the
qualification, and the bound definition. `--detail detailed` adds the
evaluator bindings, the policy parameters, the execution limits, the
qualification evidence, and the recorded performance with its counts, its
intervals, and its limitations. The JSON form prints the stored artifact
itself, whatever `--detail` states.

Refusals: one edited profile fails with `hash_mismatch`, because the core
verifies the stored self-hash before it renders.

## Global options

| Option | Values | Effect |
| --- | --- | --- |
| `--format` | `text`, `json` | Selects the output format. The default is `text`. The JSON form prints the complete artifact of the command. |
| `--help` | — | Prints the complete usage text and exits with 0. |
| `--version` | — | Prints the package version and the contract schema version and exits with 0. |

`--help` and `--version` need no command. One command line with no argument
prints the usage text and exits with 0.
