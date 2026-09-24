# Development checks

These checks assess changes to measuretwice examples and performance claims.
They use the TypeScript and TypeBox authoring format of [MVP_SPEC.md](../MVP_SPEC.md).

**Status:** Draft definitions and synthetic development cases. Both
definitions compile against the implemented `measuretwice` package, and both
datasets satisfy the frozen dataset contract. The labels are agent-proposed
and unreviewed. No live evaluator result and no calibrated profile exists for
these checks.

## Files

| Kind | File | Purpose |
| --- | --- | --- |
| Definition | [checks/example-contract.ts](checks/example-contract.ts) | Compare an example with its stated contract. |
| Definition | [checks/claim-evidence.ts](checks/claim-evidence.ts) | Compare a claim with its supporting evidence. |
| Export | [definitions/example-contract.json](definitions/example-contract.json) | The portable definition, written by the export script. |
| Export | [definitions/claim-evidence.json](definitions/claim-evidence.json) | The portable definition, written by the export script. |
| Cases | [cases/example-contract.jsonl](cases/example-contract.jsonl) with [its metadata](cases/example-contract.metadata.json) | Eight example cases with reference labels. |
| Cases | [cases/claim-evidence.jsonl](cases/claim-evidence.jsonl) with [its metadata](cases/claim-evidence.metadata.json) | Ten claim cases with reference labels. |
| Runner | [validate.ts](validate.ts) | Validate every artifact offline. |
| Runner | [jev-shadow.ts](jev-shadow.ts) | Run opt-in shadow experiments with one pinned Jev model. |
| Runner | [export-definitions.ts](export-definitions.ts) | Write the committed JSON exports. |

Each definition is independent. Supply only its declared inputs.
This avoids unrelated context and lets each check have its own evaluation history.

## Folder convention

Use `.measuretwice/` for a project's own checks and supporting files.
This is the measuretwice convention. It is not an external industry standard.
The library and CLI must also accept explicit paths.

```text
.measuretwice/
  checks/       TypeScript definitions with TypeBox input schemas
  definitions/  JSON exports for the CLI or exchange
  cases/        JSONL records, dataset metadata, and label provenance
  profiles/     Selected evaluator and policy bindings
  reports/      Generated results
  README.md     Local usage instructions
```

Commit definitions, cases approved for sharing, and selected profiles.
These initial cases are synthetic drafts; their label status remains explicit.
Generated reports and the compiled `build/` directory are ignored by default.
Retain evidence needed by a selected profile in a stable, explicitly managed location.
Do not rely on ignored reports as the only copy of qualification evidence.
The profiles and reports folders are empty until their artifacts exist.
Public teaching examples belong in `examples/`.

## Prepare the inputs

For the example check:

1. Select the relevant schema and behavior rules from the current contract.
2. Include the contract revision or content hash in the case metadata.
3. Supply the exact example and its stated expected behavior.
4. Include exceptions and defaults that affect that example.

For the claim check:

1. Supply the exact sentence or short passage that makes the claim.
2. Supply the relevant report fields, metric definitions, and limitations.
3. Include the dataset, profile, model, and report identities when the claim depends on them.
4. Keep label provenance and sampling details visible.

Do not ask a semantic evaluator to verify arithmetic, hashes, or executable schema validity.
Use deterministic checks for those facts. Supply their results when they affect the semantic assessment.
The semantic check assesses whether the example or prose represents those facts correctly.

## Interpret the answers

| Meaning | Example check | Claim check | Intended outcome |
| --- | --- | --- | --- |
| Established agreement | `consistent` | `supported` | Pass |
| Definite conflict | `conflicting` | `conflicting` | Fail |
| Missing support | `incomplete` | `insufficient` | Review |

A missing source is not proof of a false statement.
A definite conflict takes precedence over missing details elsewhere.
A calibrated profile can return review when a model assessment is too uncertain to use.
Execution failures remain errors. They are not semantic answers.

## Case format and label status

The records follow the frozen dataset contract of
[contracts/v0/case-record.schema.json](../contracts/v0/case-record.schema.json).
Each JSONL line holds one complete case, and one metadata file declares its
dataset:

- `id`: Stable case identifier.
- `group`: Identifier for related cases. Keep a group in one dataset split.
- `tags`: Failure types and scope labels.
- `input`: Exactly the fields that the definition input schema declares.
- `expected`: Proposed answers and outcomes for each check, plus the overall outcome.
- `label`: `author_type` (`human` or `model`), `reviewed`, the `origin`, and a short `reason`.

The provisional shape is gone. The migration of 24 September 2026 moved each
record onto the frozen contract and changed no label meaning:

| Provisional field | Frozen field | Value kept |
| --- | --- | --- |
| `author_type: "coding_agent"` | `author_type: "model"` | A coding agent counts as one model author. |
| `human_review_status: "unreviewed"` | `reviewed: false` | No human reviewed one label. |
| `human_reviewer: null` | absent | One reviewer exists only after one review. |
| `origin`, `reason` | `origin`, `reason` | Unchanged text, as the agent proposed it. |

All labels were proposed by a coding agent. No label is marked as human-reviewed.
The metadata of each dataset states `kind: "development_fixture"`, so the
loader itself reports that the data supports no qualification claim.
All sample reports and API behaviors inside the cases are synthetic.
They are not measurements of measuretwice or Jev.

The contract cases use self-contained excerpts and deliberately limited hypothetical contracts.
Read the supplied contract for each case; do not substitute the current full specification.
Some cases intentionally conflict with current product behavior to exercise the checking rule.

Review each case and its expected answer before using it as a reference label.
Record the reviewer and any correction in the label record.
Preserve the distinction between an agent proposal and a human judgment.

## Run the checks offline

Build the package, then build and run the validation:

1. `npm install`
2. `npm run build`
3. `npx tsc -p .measuretwice/tsconfig.json`
4. `node .measuretwice/build/validate.js`

The runner validates both definitions and both datasets through the Rust
core, with no evaluator and no provider call. It checks that the committed
JSON exports equal the TypeScript definitions, that every reference label
matches its check meaning, and that every run case holds one identifier and
one input object alone. One failure names the artifact and exits with one
error. The suite
[packages/measuretwice/test/development-checks.test.ts](../packages/measuretwice/test/development-checks.test.ts)
runs the same validation in the ordinary tests.

The CLI reads the exported definitions and executes no TypeScript source:

```sh
node packages/measuretwice/dist/cli.js validate .measuretwice/definitions/example-contract.json
```

After you change one definition, write the export again and commit both:

```sh
node .measuretwice/build/export-definitions.js
```

## Run pinned Jev shadow experiments, opt-in

One shadow experiment assesses the same cases through the Jev evaluator and
stores one report per case beside the dataset. It is opt-in, because one run
reads one credential and spends one API budget:

```sh
npm install @typesafe-ai/sdk@0.6.0
node .measuretwice/build/jev-shadow.js --yes --check example-contract
```

The rules of the experiment:

- The runner refuses to run until you pass `--yes`. The ordinary tests never
  cross that gate.
- The model stays pinned to one versioned identifier, `jev-1.13.0` by
  default. One alias such as `jev-latest` refuses to load. The report
  records the version that answered.
- The generated profile is explicitly unvalidated, so the runs state shadow
  mode and enforce nothing.
- Expected labels and their explanations never reach the evaluator. Every
  run starts from `runCase`, which strips them. The reference labels appear
  only in the printed comparison.
- Model output is stored in `reports/`, never inside the dataset. Git
  ignores that directory.
- Use `--limit 2` for one first, cheap experiment.

See [providers/jev/README.md](../providers/jev/README.md) for the verified
provider contract. The client reads its credential from `TYPESAFE_API_KEY`.

## Evaluation and improvement

1. Review the proposed labels.
2. Run the same cases with the pinned evaluator and translation.
3. Inspect every disagreement and operational failure.
4. Record changes to questions or answer descriptions as a new definition revision.
5. Add cases from actual development work, including cases where the check appeared to pass correctly.
6. Collect independent validation cases before qualifying a profile.

These cases are development fixtures. They are not a held-out validation set.
Repeated edits against these cases can overfit them.
Do not infer production reliability from their small, selected sample.

Keep ordinary tests for schema validation, statistical calculations, and profile compatibility.
Keep focused TLA+ models for critical state behavior.
These semantic checks provide additional evidence; they do not establish the correctness of their own runner.
