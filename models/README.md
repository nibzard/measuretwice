# Formal models

This directory holds the Temporal Logic of Actions (TLA+) models and
their records. [AGENTS.md](../AGENTS.md) section 7 requires a model
before critical state behavior is implemented. [MVP_SPEC.md](../MVP_SPEC.md)
section 5 names the execution state boundary as the first one.

Each model lives in its own directory with a record that states the
property, the assumptions, the bounds, the tool version, the results,
and the mapping to the code.

| Model | Path | Record | Status |
| --- | --- | --- | --- |
| Execution transitions | [execution/Execution.tla](execution/Execution.tla) | [execution/README.md](execution/README.md) | Checked, complete, 23 September 2026. |
| Profile qualification and host selection | [qualification/Qualification.tla](qualification/Qualification.tla) | [qualification/README.md](qualification/README.md) | Checked, complete, 23 September 2026. |

## Running the checks

The checks need Java 21 or later and the TLA+ tools. Download the pinned
release once:

```sh
mkdir -p ~/.cache/measuretwice-tla
curl -L -o ~/.cache/measuretwice-tla/tla2tools.jar \
  https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
```

Then run the TLA+ model checker TLC for each configuration:

```sh
java -Xmx4g -XX:+UseParallelGC \
  -cp ~/.cache/measuretwice-tla/tla2tools.jar tlc2.TLC \
  -deadlock -nowarning \
  -config models/execution/Execution.cfg models/execution/Execution.tla

java -Xmx4g -XX:+UseParallelGC \
  -cp ~/.cache/measuretwice-tla/tla2tools.jar tlc2.TLC \
  -deadlock -nowarning \
  -config models/execution/ExecutionSaturation.cfg models/execution/Execution.tla

java -Xmx4g -XX:+UseParallelGC \
  -cp ~/.cache/measuretwice-tla/tla2tools.jar tlc2.TLC \
  -deadlock -nowarning \
  -config models/qualification/Qualification.cfg \
  models/qualification/Qualification.tla
```

The `-deadlock` flag is expected. A terminal report has no outgoing
transition, so TLC would report an intended deadlock without the flag.
TLC writes a `states/` scratch directory into the working directory.
The repository ignores it.

Continuous integration does not run TLC. The ordinary checks read local
files only and need no network, as [TESTING.md](../TESTING.md) requires.
Task T078 decides the release-audit integration. The repository check
`tests/repo/models.test.ts` verifies that each record matches its module
and its configuration.
