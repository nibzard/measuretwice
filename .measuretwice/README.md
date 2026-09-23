# Development checks

These checks assess changes to measuretwice examples and performance claims.
They use the proposed TypeScript and TypeBox format in [MVP_SPEC.md](../MVP_SPEC.md).

**Status:** Draft definitions and synthetic development cases. The imported measuretwice API is not implemented yet.
No live evaluator results or calibrated profiles exist for these checks.

## Files

| Definition | Cases | Purpose |
| --- | --- | --- |
| [example-contract.ts](checks/example-contract.ts) | [example-contract.jsonl](cases/example-contract.jsonl) | Compare an example with its stated contract. |
| [claim-evidence.ts](checks/claim-evidence.ts) | [claim-evidence.jsonl](cases/claim-evidence.jsonl) | Compare a claim with its supporting evidence. |

Each definition is independent. Supply only its declared inputs.
This avoids unrelated context and lets each check have its own evaluation history.

## Folder convention

Use `.measuretwice/` for a project's own checks and supporting files.
This is the measuretwice convention. It is not an external industry standard.
The library and CLI must also accept explicit paths.

```text
.measuretwice/
  checks/       TypeScript definitions with TypeBox input schemas
  definitions/  Optional JSON exports for the CLI or exchange
  cases/        Example cases and label provenance
  profiles/     Selected evaluator and policy bindings
  reports/      Generated results
  README.md     Local usage instructions
```

Commit definitions, cases approved for sharing, and selected profiles.
These initial cases are synthetic drafts; their label status remains explicit.
Generated reports are ignored by default.
Retain evidence needed by a selected profile in a stable, explicitly managed location.
Do not rely on ignored reports as the only copy of qualification evidence.
The profiles and reports folders are empty until their artifacts exist.
Public teaching examples belong in `examples/` when they are added.

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

Each JSONL line contains one complete case:

- `id`: Stable case identifier.
- `group`: Identifier for related cases. Keep a group in one dataset split.
- `tags`: Failure types and scope labels.
- `input`: Exactly the fields required by the definition.
- `expected`: Proposed answer and outcome for the check, plus the overall outcome.
- `label`: Origin, author type, human-review status, and a short explanation.

This fixture shape is provisional. It is not an implemented dataset schema.
All labels were proposed by a coding agent. No label is marked as human-reviewed.
All sample reports and API behaviors inside the cases are synthetic.
They are not measurements of measuretwice or Jev.

The contract cases use self-contained excerpts and deliberately limited hypothetical contracts.
Read the supplied contract for each case; do not substitute the current full specification.
Some cases intentionally conflict with current product behavior to exercise the checking rule.

Review each case and its expected answer before using it as a reference label.
Record the reviewer and any correction in the label record.
Preserve the distinction between an agent proposal and a human judgment.

## Use before the runner exists

The repository does not yet contain a runner for these files.
Read them as review checklists or use them to specify a direct Jev experiment.
The future library imports these definitions through the application build. The CLI reads explicitly exported JSON; it does not execute TypeScript.
The Rust core will validate inputs and apply the shared decision rules. YAML loading is deferred.
Do not report checklist review as a live model evaluation.

A future direct SDK experiment should translate `answers` into a Jev Choice question.
It must retain the question text, answer descriptions, and exact input fields.
Expected labels and their explanations must never be sent to the evaluator.
Record model output separately from the input dataset.

Use an explicitly unvalidated profile for exploration and shadow runs.
Do not use these draft checks to block changes automatically.
No API calls are required to read or validate these artifacts.

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
