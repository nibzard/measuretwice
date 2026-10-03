# Agent instructions

The project name is **measuretwice**: one word, all lowercase.
These instructions apply to every task in this repository.
The [engineering rules](docs/contributing/engineering.md) retain the complete project requirements.
Use this file to find the rules and source documents for your task.

## Rules for every task

- Preserve user changes. Keep unrelated work outside your change.
- Write short, direct English. Follow the [writing rules](docs/contributing/engineering.md#1-use-asd-ste100-english).
- Preserve actual measurements, provenance, uncertainty, and failures. Do not invent evidence or passing checks.
- Keep application authorization with the host. A report grants no permission.
- Validate external data. Keep private evidence and credentials outside default logs and committed examples.
- Implement the smallest complete solution. Add no abstraction without an observed need.
- Use `python3` for Python commands.

## Find the task rules

| Task | Read before changing it |
| --- | --- |
| Product behavior or architecture | [MVP_SPEC.md](MVP_SPEC.md), [mission](docs/product/mission.md), engineering rules sections 2–5 |
| Public artifacts or APIs | [Contracts](contracts/README.md), [API reference](docs/reference/api.md), engineering rules sections 4–5 and 8–10 |
| Behavioral fix | [Testing](TESTING.md), engineering rules section 6: reproduce with a failing test before implementation |
| Scheduling, retries, cancellation, qualification, or authorization | [Formal models](models/README.md), engineering rules section 7: model critical state changes before implementation |
| CLI or diagnosis | [CLI reference](docs/reference/cli.md), [operations](docs/guides/operations.md), engineering rules sections 3 and 10 |
| Calibration or empirical evaluation | [Calibration guide](docs/guides/calibration.md), engineering rules section 9 |
| Packaging or setup | [Development](DEVELOPING.md), [testing](TESTING.md) |
| Review response | [Review plan](docs/product/review-plan.md), [verification record](docs/reports/review-response.md) |

Research documents are historical background. The specification controls current behavior.
Read the relevant engineering sections and linked module documentation before making a change.
All engineering rules apply, including rules outside the task's initial reading path.

## Finish the task

Update code, tests, contracts, examples, and documentation together when behavior changes.
Follow [the completion checks](docs/contributing/engineering.md#11-completion-checks).
Report what changed, what passed, and what remains unverified.
Keep software checks, formal results, evaluator quality, and human usability evidence separate.
