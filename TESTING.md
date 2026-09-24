# Testing measuretwice

This guide records the test suites, the commands, and the rules that keep
the checks deterministic. [AGENTS.md](AGENTS.md) section 6 states the
general test rules. [DEVELOPING.md](DEVELOPING.md) records the workspace
layout.

## Rules for ordinary tests

- Ordinary tests need no credentials and spend no API budget.
- Ordinary tests read local files only. They open no network connection.
- Ordinary tests never read the system clock. They advance a fake clock.
- Ordinary tests never use real randomness. They seed a generator.
- Every test gives the same result on every run, on every supported target.

## Test suites

| Suite | Location | Runner | Checks |
| --- | --- | --- | --- |
| Rust unit tests | next to the code in `crates/` | `cargo test` | Core behavior and invariants. |
| Package tests | `packages/measuretwice/test/` | Vitest | Public package behavior, the CLI, and the test support itself. |
| Native boundary | `packages/measuretwice/test/native.test.ts` | Vitest | The NAPI-RS surface: valid requests, malformed data, the stable failure translation, numeric and string behavior, the profile validation and compatibility operations, the question decisions with their complete records through `decideQuestionCheck`, the shadow baseline of run creation with the enforcement refusal, the review export and the label validation of `exportShadowReviews` and `validateReviewLabels` over run state reports, the dataset measurement of `evaluateDataset` that refuses one malformed or foreign report and one empty evaluation, the interval boundary of `parseIntervalRequest` and `uncertaintyIntervals` with one bound per metric of every scope against one independent reference value and the broken requests with their field paths, the comparison of `compareEvaluations` over two stored evaluation reports with its changed cases, its cost from declared inputs, and its `/baseline` and `/candidate` refusals, the calibration boundary of `validatePlan`, `checkCalibrationBinding`, and `checkCalibrationDatasets` with the plan facts, the registered-evaluator and split-selection refusals, and the invalid plan rows, the fitting search of `fitPolicy` on the worker thread with the fixture facts and every invalid row, and the frozen validation of `qualifyCandidate` with the stated statuses, candidates, goal rows, and reason codes, the reused holdout under one stated split identity, and the refusals of one malformed request, one fitting assessment, and one missing validation assessment, the runtime traces replayed through the run state class, and the clear loading error outside the declared targets. |
| Authoring | `packages/measuretwice/test/define-checks.test.ts` | Vitest | The `defineChecks` boundary: inferred case-input types and `using` names at compile time, the documented TypeBox conversion, rejection of nonportable values and unsupported forms, and the shared TypeBox pairs executed through the built package with their published hashes. |
| Evaluator contract | `packages/measuretwice/test/evaluator.test.ts` | Vitest | The registration and execution contract: stable evaluator and adapter identities, the optional `translate` operation, the frozen registry, and every registration rejection. The dispatched request of each question kind: the validated question, only the projected inputs of `using`, the budget, and the cancellation signal. Label-only assessments with absent optionals preserved, operational failures, malformed adapter answers, and profile bindings against the registered evaluators. |
| Test evaluators | `packages/measuretwice/test/test-evaluator.test.ts` | Vitest | The shipped test adapters and the adapter conformance cases of `fixtures/adapters/conformance.json`: every scripted control with success, review, malformed, error, and delayed responses; the label-only answers with no invented confidence, distribution, usage, or evidence; the separately specified decision rule for label-only assessments; identical requests and one definition hash across evaluators; and independent profile bindings when evaluator behavior changes. |
| Jev translation | `packages/measuretwice/test/jev.test.ts` | Vitest | The versioned translation of one question check into one Jev question: every translation case of `fixtures/translations/jev.json` through the dispatched request and the public translation, with the canonical text and the translation-domain digest computed by the Rust core; the evidence state with exactly the projected inputs of `using`; the identity variants that change the digest and the evaluator binding while the definition stays, and the load-time translation comparison that refuses one changed binding with `translation_mismatch`; the state rejections that keep labels and baselines out; and the wire shapes tied to the pinned SDK record. |
| Jev normalization | `packages/measuretwice/test/jev-assessment.test.ts` | Vitest | The normalization of one Jev answer into one typed assessment: every case of `fixtures/adapters/jev-normalization.json` through the Jev adapter and the dispatch contract with one injected clock and one fake call boundary, so the Rust core validates each assessment against its check; the operational record with the resolved model, the per-request usage, and the adapter-measured latency; the sanitized provider errors that keep the class, the status, and the request identifier without one echoed body; and the abort and deadline paths that stop the adapter before one call. |
| Jev input boundaries | `packages/measuretwice/test/jev-boundaries.test.ts` | Vitest | The provider input limits and the call isolation of the Jev adapter: the flagship intervention-review definition with its four different projections, where every request holds only the inputs that its `using` list authorizes and exactly one question; the state budget counted in UTF-8 bytes, where evidence at the budget passes and one byte above is rejected before the provider call with `oversized_input` and without truncation; the isolation of two cases from unrelated access scopes, with no scope metadata crossing the boundary; partial provider failures that stay isolated per check; and embedded instructions inside supplied evidence that change no registered evaluator, no permission, and no request boundary. |
| Run path | `packages/measuretwice/test/run.test.ts` | Vitest | The `load` and `run` boundary: the typed import and the explicit JSON path, injected file access, clocks, and identifiers, YAML and TypeScript path rejection, profile self-hash verification, the complete profile contract and compatibility through the Rust core, case validation failures, the profile gate for question checks without one binding, the enforcement gate of the core, and report determinism and immutability. |
| Scheduler | `packages/measuretwice/test/scheduler.test.ts` | Vitest | The bounded scheduling of the wrapper: the active-work and pending-work limits of the effective execution configuration, queue-full saturation records, the never-started rule of the pending count, the attempt of every required check without cost-based short-circuiting, bounded retries with the retryable reason codes, the doubling backoff inside the total deadline, the permanent failure that records its error without one retry, the cancellation during one backoff, the deadline that ends one backoff, simultaneous submissions of two runs, one thrown execution as one operational failure, the released cancellation signal on the terminal path, the total deadline that ends active, queued, and completed work under one fake clock that fires the armed wake-ups and under one clock that passed the instant without one delivered wake-up, caller cancellation before any start, during one active execution, and after one partial completion, with the caller reason propagated to the adapters, one abort stated from inside the first attempt that stops the admission loop and returns the frozen cancelled report, the dropped late resolutions after the deadline, the cancellation, and the normal completion, and the nine shared runtime traces the scheduler reproduces. |
| Exploration profiles | `packages/measuretwice/test/exploration.test.ts` | Vitest | The `createExplorationProfile` boundary: the starter artifact with its definition reference, one evaluator binding per question check and none for exact rules, the canonical translated question with its translation hash from the adapter's `translate` operation or from the validated question of one adapter that translates nothing, the starter parameters, the effective execution configuration, and the `unvalidated` qualification with `starter_policy`; the deterministic generation, the shadow run through the label-only adapter that records the undecidable answer as one error while the qualification stays unchanged, the enforcement refusal, the absence of any provider call, and every rejection with its code and field path. |
| Semantic run path | `packages/measuretwice/test/semantic-run.test.ts` | Vitest | The complete orchestration of task T034: one mixed definition with one exact rule, one Choice, one Noul, and one Score question, driven through one registered scripted evaluator and one exploration profile, with every question record keeping its raw assessment, applied policy, evaluator versions, timing, and usage, and the exact-rule record keeping none; the projected requests of the differing `using` lists with the budget and the signal; the decision table of the `probability_mass_v0` family through the public boundary, including the review label, the boundary equality, and one confidence floor that abstains while one floor on one binary check refuses the profile; one retryable failure that retries inside the attempt budget and records the count, exhausted attempts that record `retries_exhausted`, one invalid assessment that is permanent and spends no retry, and one undecidable answer that keeps the cause and the field path of the core refusal; the queue-full skip, the total deadline with `deadline_exceeded` and `deadline_before_start` records, the caller cancellation with `run_cancelled` and `cancelled_before_start` records and the abort reaching the in-flight adapter, and the frozen terminal report that one late answer cannot change; and the invalid case that fails before any evaluator runs. |
| Profile selection | `packages/measuretwice/test/profile-selection.test.ts` | Vitest | The mode admission of task T035: every qualification status assesses cases in shadow mode, the admission that the evaluate operation will reuse, with the bound artifact unchanged after each run; enforcement refuses every status below `validated_for_scope` with `qualification_insufficient`, requires the reviewed content hash that the host selected through `selectedProfileHash` with `profile_not_selected` for one absent, foreign, or malformed selection, and compares the requested scope with `scope_mismatch`; stale evaluator bindings refuse at load; one enforced operational failure records one error outcome and never one pass; shadow passes, refused enforcement runs, and enforced runs promote no profile, write no frozen field, and leave no sticky selection; and the derived exact profile of one exact-only definition needs one selection too. |
| Privacy canaries | `packages/measuretwice/test/privacy.test.ts` | Vitest | The private-data defaults of task T036: one run over case input that holds credential and private-content canaries produces one serialized report that holds none of them, while the required assessment measurements (raw assessment, applied policy, evaluator versions, timing, usage) and the executed rule stay; one host-controlled snapshot reference records replay provenance as `case.snapshot` with no input copied and one absent option states no field, the wrapper opens no file while one run executes, and one snapshot outside the 1-to-256-character bound fails before any evaluator runs; one hostile provider error that quotes case content and credentials crosses sanitized with its class, status, and request identifier; validation failures name their field without echoing one value; operational failures keep their code and cause after sensitive content stays out; and generated profiles hold no credential and no case content, while one stored profile that carries one `api_key` or one case body fails `load` with `unknown_field`. |
| Rendering | `packages/measuretwice/test/render.test.ts` | Vitest | The renderers of task T037: one mixed run rendered as terminal text and as Markdown, where the summary leads with the check meaning of the definition, the component outcomes, the aggregate outcome with its explanation, the completion status, and the next useful action, and the detailed view exposes the executed rule with its parameters, the raw measurement with its answer, distribution, confidence, and evidence references as evaluator-selected support, the applied policy, the evaluator versions with the resolved model, the attempt counts with the timing and the usage, the identities with the complete content hashes, and the limitations; the default explanations from check criteria and executed policy for pass, fail, review-label, confidence-floor, and binary-mass records and for the stable reasons of error and skip records, the recorded aggregate explanation rendering as stored, and no raw case content in any view; every rejection, from the foreign definition with `definition_mismatch` and the disagreeing stored aggregate to the unknown check, the missing reason, the invalid detail level, and the edited profile with `hash_mismatch`; the exploration profile summary without one measured number and the shared insufficient-evidence calibration profile with its bindings, its evidence, its counts, and its slice limitations in both formats. |
| Shadow integration | `packages/measuretwice/test/shadow.test.ts` | Vitest | The shadow reports and host integration of task T038: one shadow run records the stated baseline beside the new outcome in every mode path, with no evaluator for exact rules and no field when the host states none; one pass, one fail, one review, one operational error, one queue-full skip, and one cancellation each leave the existing decision, its revision, and the host actions untouched, because the library holds no handle to any of them; the same case under two baselines measures identically, and no report field states one agreement, one accuracy, or one authorization; the awaited call records its per-check latency and never holds its caller past the total deadline; one resolved call disarms every wake-up it armed, so the library leaves no detached work; the public surface exports no delivery, permission, storage, or scheduling operation; one baseline in enforcement mode refuses under one selected qualified profile, and the malformed baselines refuse before any evaluator runs. |
| Vertical slice | `packages/measuretwice/test/slice.test.ts` | Vitest | The complete Rust-to-TypeScript path as one slice: identical cases through TypeBox authoring and the exported JSON definition with equal canonical content, hashes, rule outcomes, and serialized reports; every exact string rule record and the Unicode boundaries through `load` and `run`; malformed requests and invalid cases with the same codes at both boundaries; and one child-process check that the slice uses no network, no credential read, and no provider package. |
| Dataset loading | `packages/measuretwice/test/dataset.test.ts` | Vitest | The dataset loader of task T039: one metadata path and one JSONL records path through injected file access, the complete core validation of records and metadata, line and field locations on every failure, the record-count agreement, the published size limits, wrong path formats, unreadable paths, and the `runCase` strip that keeps reference labels and label provenance out of every evaluator request while the stripped case runs end to end. |
| Reference labels | `packages/measuretwice/test/dataset-labels.test.ts` | Vitest | The label meaning and provenance of task T040: the label review that `loadDataset` returns, where one reference whose acceptance meaning disagrees with its stated expected outcome loads, stays as written, and is flagged with its line, case, check, and field path; the overall outcome that disagrees with the stated check outcomes; the ambiguous references that keep their review marker and need one human review; the corrected references that keep their earlier provenance; the provenance summary that keeps human judgments apart from model proposals, so one dataset of proposals alone states no reviewed evidence; every reference that breaks the meaning of its check rejected with its code and field path; and the complete shared group `fixtures/datasets/labels.json` answered through the public boundary. |
| Dataset splits | `packages/measuretwice/test/dataset-splits.test.ts` | Vitest | The grouped splits and dataset identities of task T041: the identity and the split identities that one `loadDataset` computes, with the population statement that keeps targeted challenge sets apart from representative samples; the group rule that keeps related conversations inside one split; the group that no split covers, reported and not invented; the stored hash mismatch that fails one revision; the deterministic reproduction under any file order and the changed input that changes its split hash alone; the overlap detection and the refusal for one shared group or one duplicated case across two datasets; the evidence classification that marks one reused, renamed, challenge-set, or empty validation split as development data; the broken split selections with their field paths; and the split records running through the same `runCase` strip. |
| Evaluate API | `packages/measuretwice/test/evaluate.test.ts` | Vitest | The evaluate operation of task T044: one dataset run case by case through the same validated execution path as one shadow run, with the metric sets of every check and of the complete set, their counts, their denominators, and their null values at one zero denominator; the reference match of every check, `null` where no reference exists; the slices over the record tags; the operational failures over all attempts with the attempt count and the summed usage; the per-case run reports with the actual evaluator versions and the per-check timing; the label coverage and the population limits of every dataset kind, beside the artifact whose keys stay inside the frozen schema; provider errors and saturation skips that stay visible and never become one pass; one cancelled evaluation that keeps its partial result, counts its unevaluated records, and one cancellation before the first case that refuses with `insufficient_evidence`; the gates before any read and any run; and the boundary that no evaluation changes: the bound artifact stays byte-identical and one enforced run after one evaluation still refuses the unvalidated profile and still needs the selected reviewed hash. |
| Calibrate API | `packages/measuretwice/test/calibrate.test.ts` | Vitest | The calibrate operation of task T050: the plan and the dataset read through the bounded readers, the definition and evaluator checks of the plan before one dataset is read and the dataset checks before one case is measured, the measurement of both splits through the same validated execution path with no reference label in any evaluator request, the search over the development assessments, the frozen validation on the independent split, and the candidate profile with its complete evidence, its frozen policy, its measured performance, and its computed qualification; the successful qualification with `validated_for_scope`, the missing evidence below the plan minimum with `insufficient_evidence`, the unmet goal with `criteria_not_met`, the no-candidate result that spends no validation budget and records the objective-best candidate, the cancellation refusals before the first case and during one measurement, the evaluator failure with the record's own code, the two resolved model versions with `model_resolution_changed`, the binding refusals before any spend, the calculation above the published fitting budget that refuses with its count, the complete-procedure option checks, the definition as one explicit path, the deterministic content hash of one repeated calibration, and the closed boundary: the returned profile loads, shadow use admits it, and enforcement still needs the host selection and the matching scope. |
| Review export | `packages/measuretwice/test/review.test.ts` | Vitest | The shadow review export of task T045: one nine-case batch through the public boundary where every disagreement, every report without one baseline, and every candidate error is always exported and the agreements enter through the seeded sample alone; the sample pinned from the outside through the same SHA-256 rank, reproducible under one repeated call, unchanged under one reordered batch, empty at one zero size, complete above the agreement count, and monotone in size; the records with their stable case identifiers, input hashes, run identifiers, baseline revisions and meanings, candidate outcomes, and selection reasons; the audited composition that keeps baseline passes and silent baseline cases countable, with one silent baseline against one fail as one disagreement; the JSON Lines text that round-trips every record and states no merged outcome; no raw case content in any export, with the host snapshot reference carried alone and the stored reports unchanged; the refusals with their codes and `/reports/<index>` positions, including one enforcement report and one report of another profile; the returned labels validated against the meaning of their checks, with one label that contradicts the baseline outcome accepted, one conflicting reference kept as written and flagged, the provenance counts, and every broken return named by its line and field. |
| Comparison | `packages/measuretwice/test/compare.test.ts` | Vitest | The compare operation of task T046: two stored evaluation reports matched on equal case identifiers and equal input hashes, with one changed input hash never matching, listed under `changed_input_cases`, and excluded from the changed cases; the omitted cases listed per side; the errored and the skipped matched cases listed while their outcomes changed nothing; the changed component and aggregate outcomes with the changed checks; the metric rows that keep the numerator and the denominator of both sides beside every value, with different denominators over different case sets; the evidence class that one fitting declared purpose drops to fitting evidence; the usage and cost tradeoffs that appear only when recorded data and declared costs support them, with one uncovered usage key named by one limitation; the artifact keys inside the frozen comparison schema with no raw case content; and the refusals with their codes and paths, including the absent option gates, one report of another definition, two reports that share no case, and one edited stored report. |
| CLI | `packages/measuretwice/test/cli.test.ts` and `packages/measuretwice/test/cli-files.test.ts` | Vitest | The CLI surface of task T054: the compiled entry point through child processes and the imported `runCli` with injected streams; the parsing of every command with its resolved artifact paths, the `.measuretwice` name resolution, and the default metadata path of one records file; the usage failures with exit code 2 and their stable reason codes (`unknown_command`, `unsupported_option`, `missing_argument`, `unexpected_argument`, `invalid_argument`), the wrong-format paths with exit code 1 and `unsupported_format` before one read, and the stub dispatch with `not_implemented` for the commands of the later task; the exit codes 0, 1, and 2 with stdout reserved for results and stderr for diagnostics, in text form and as one JSON error object under `--format json`; the credential canaries, where one credential option is one unsupported option, one credential variable never leaks, and one artifact field fails through the core; and the bounded readers, where the size bound fires before and after one read with `oversized_input` and no truncation, one unreadable path keeps its cause, malformed JSON fails with its position and no content echo, definitions, profiles, and cases keep the reason codes and field paths of the core, one executable field and one credential field fail with `unknown_field`, one edited profile fails with `hash_mismatch`, one unregistered evaluator reference fails with `evaluator_mismatch`, and the plan and report readers gate the frozen structure. The commands of task T055: `validate` states the meaning of one exported definition in both formats, with the expanded scale acceptance and the kinds of the core, and refuses malformed, hostile, and unreadable files; `run` renders one passing and one failing report with exit code 0, keeps one queue-full skip visible as one review outcome, prints and writes the report artifact through `--out` with `unwritable_output` on one failed write and no result on stdout, leaks no raw case content on either stream, keeps the reason code and the field path of one invalid case, refuses the question check with `evaluator_mismatch` and the CLI evaluator boundary with and without one profile, refuses one profile of another definition with `definition_mismatch`, and refuses `--mode enforcement` with `profile_not_selected` and the host-selection boundary; `inspect` states the readable summary, adds the bindings, the policy, the execution limits, and the identity on `--detail detailed`, prints the stored artifact under `--format json`, and refuses one edited profile with `hash_mismatch`. One run of an evaluator-backed check ends in one error aggregate; the CLI refuses evaluator runs by design, so its suite covers the pass, fail, and review aggregates and the renderer suite of T037 covers the error view. |
| Memory support example | `packages/measuretwice/test/example-memory-support.test.ts` | Vitest | The public example of task T058, executed offline: the suite builds `examples/memory-support` through its own TypeScript configuration, as one host application does, and runs it against the scripted test evaluator. It checks the trusted import of the definition, the three synthetic references with their model-proposed provenance, the projected inputs of every evaluator request, the explicitly unvalidated exploration profile with its starter policy, the recorded baseline beside the unchanged host decision, the host-owned storage of the profile and every report, the private-data defaults that keep case content out of every stored report, the printed summary with its disagreement and its limits, and the enforcement refusal before any case work. |
| Intervention review example | `packages/measuretwice/test/example-intervention-review.test.ts` | Vitest | The flagship example of task T059, executed offline: the suite builds `examples/intervention-review` through its own TypeScript configuration and runs it against the scripted test evaluator. It checks the complete definition with its two Choice checks, one Noul check, one Score check, and one separate exact maxLength rule, the committed JSON export regenerated byte for byte by the trusted script and validated by the CLI, the six synthetic cases that cover accepted, duplicated, contradicted, replaced-decision, missing-evidence, and over-length scenarios, the three projected input sets of the four question checks with one question per request and no rule check on any evaluator, the explicitly unvalidated exploration profile that binds no rule check, the recorded baselines beside the unchanged host decisions, the aggregate fold recomputed for every report and re-verified through the shared renderer, the rule that the passed consequence check compensates no failed requirement, the review case through its review labels and one abstention, the named reference disagreement, the host-owned storage with no case content in any stored report, and the enforcement refusal before any case work. |
| Cassandra shadow example | `packages/measuretwice/test/example-cassandra-shadow.test.ts` | Vitest | The application integration example of task T061, executed offline: the suite builds `examples/cassandra-shadow` through its own TypeScript configuration, which compiles the two definitions of the other examples beside its own files, as one host application does. It checks the decisions and the actions of the two existing paths before any run starts, the gates that stay inside the application, the mapping of the stored records into the cases of both definitions with the bounded recent context that cuts nothing and the refusals that name the input bounds, the projected inputs of every evaluator request with no record field crossing the boundary, the recorded decision and revision of each host as the baseline with one snapshot reference of host storage, the outcome table of one pass, one fail, one review, one broken-answer error, and one saturated replay of four queue-full skips, the bounded queue that never blocks the decision path, the host-owned storage with no case content in any stored report or export, the review exports with the stated baseline meanings, the failed job that changes no application action, the dependency boundary where the package declares no Cassandra driver and the application module imports no measuretwice module, and the enforcement refusal before any case work. |
| Public challenge set | `packages/measuretwice/test/example-intervention-challenge.test.ts` | Vitest | The public synthetic challenge set of task T062, validated offline: the suite builds the runner of `examples/intervention-challenge` through its own TypeScript configuration and runs it against the committed portable export of the flagship definition. It checks the binding of both datasets to one definition content hash, the declared identity of one `synthetic_challenge` with the population statement of one targeted challenge set that states no prevalence, the one challenge split that holds every group with the three two-variant incidents inside one split, the coverage of the nine behaviors of MVP_SPEC.md section 13 with the consequence levels and the three languages, the separate labels of every component answer, every check outcome, and the overall outcome that the stated outcomes aggregate to, the unreviewed model-proposed provenance of every label with the synthetic generation record, the core classification of the challenge split as development data that supports no qualification claim, the stripped run cases, the three declared inputs with the delivery limit of every drafted message, the absence of private platform content, the published revision and both content hashes of the README, and the runner refusals for one missing required slice and for one label that claims one human review. |
| Development checks | `packages/measuretwice/test/development-checks.test.ts` | Vitest | The repository checks of task T060, executed offline: the suite builds `.measuretwice` through its own TypeScript configuration, so both draft definitions compile against the implemented package and validate through the core; the committed JSON exports regenerated byte for byte by the trusted script and validated by the CLI; the migrated case records against the frozen dataset contract, with every reference preserved as one unreviewed model proposal, no field of the provisional shape left, the development-fixture identity that supports no qualification claim, and the single fitting split that declares no independent validation data; the `runCase` strip that keeps reference labels, explanations, and provenance out of every case; the offline validation runner with its provenance counts and its limits; and the opt-in Jev shadow runner, where one run without consent refuses, one alias model refuses, one unknown check refuses, and one injected call boundary drives the complete pinned path — the unvalidated profile that requests the versioned model, the shadow reports without one baseline, the wire requests that carry the pinned model, the three declared answers, and the projected inputs alone, the host-owned storage with no case content, and the printed disagreements with the references. |
| Repository checks | `tests/repo/` | Vitest | The frozen schemas, the conformance fixtures, the example cases, the formal model records, documentation links, the project name, and the prebuilt packages. |
| Packaging | `tests/repo/packaging.test.ts` | Vitest | The published shape: the three declared-target lists stay equal, the public manifest ships the built package without private content, every platform package carries its target fields and the license, the staged manifest selects the native artifact, and the packed tarballs hold the required content only. The suite runs the assembly script, so `npm run build` must run first. |
| Installation gate wiring | `tests/repo/install-gate.test.ts` | Vitest | The offline wiring of the clean-installation gate: the command exists, the check script imports installed packages only, the artifact workflow requires one clean installation per declared Node version, and the guides document the gate. |
| Conformance fixtures | `fixtures/` | Every wrapper, through the Rust core | Definitions, inputs, dataset loading, reference labels, grouped splits and dataset identities, evaluation metrics, uncertainty intervals, calibration plans, the policy fitting search, canonical hashing, string rules, TypeBox pairing, assessments, adapter conformance cases, Jev translations, Jev normalization, outcomes, profile states, and runtime traces. |
| Live evaluations | `tests/live/` | Vitest with a separate config | Real evaluator runs. Opt-in only. No live test exists yet. |

The package tests load the native binding and the compiled CLI. Run
`npm run build` before you run them.

## Commands

Run these commands from the repository root.

| Command | Effect |
| --- | --- |
| `npm run test` | Build, then run the Rust and TypeScript tests. |
| `npm run test:rs` | Run the Rust tests alone. |
| `npm run test:ts` | Run the Vitest suites alone. |
| `npm run test:live` | Run the opt-in live evaluations. |
| `npm run smoke` | Run the exact-rule vertical-slice smoke check through the built package. |
| `npm run verify:install` | Build, assemble, pack, and verify one clean installation of the packed artifacts without Rust tooling. |
| `npm run typecheck` | Type-check the test code and the Vitest configs. |
| `npm run fmt` / `npm run fmt:check` | Format or check the Rust code. |
| `npm run lint` | Run clippy on the workspace with warnings denied. |
| `npm run check` | Run every gate that continuous integration runs. |

## Vertical slice smoke check

The exact-rule vertical slice is the first complete Rust-to-TypeScript
workflow: TypeBox authoring, the exported JSON definition, core validation,
input projection, the exact rules, the run state boundary, and the frozen
report. The vertical-slice suite verifies it inside the test runner. One
command reproduces the same observation outside the runner:

1. Run `npm run build`.
2. Run `npm run smoke`.

The command authors the delivery-limits checks once through TypeBox and
loads them once through the exported JSON fixture. It runs one case through
both paths and prints the observable result:

- `TypeBox authoring and exported JSON agree: yes`
- `rule outcomes: summary-length pass, summary-mentions-limit pass, notice-hides-secrets pass`
- `aggregate outcome: pass`
- `completion: completed at 2026-09-24T00:00:00.000Z`
- `serialized reports identical: yes`
- the last line `SMOKE_OK`

The exit status is 0 when every expectation holds. The command reads local
files only. It uses no credential, opens no network connection, and loads
no provider package.

## Clean installation gate

The prebuilt packages must install and run without a Rust compiler and
without the repository. `scripts/verify-install.mjs` enforces that as one
gate:

1. It packs the assembled packages, or takes packed tarballs with
   `--packages <dir>`.
2. It creates one empty project outside the repository and removes every
   Rust tool from the installation environment. One probe proves that
   `cargo` and `rustc` no longer resolve.
3. It installs the public tarball and the platform tarball of the host
   into that project. The tarballs answer every `measuretwice` import, so
   no workspace link can hide an installation problem.
4. It copies `scripts/install-check.mjs` into the project and runs it
   there. That check imports the public entry points, runs the exact-rule
   smoke case through TypeBox authoring and the exported JSON, rejects the
   CommonJS `require` of the package, checks the type declarations and the
   shipped CLI entry, and resolves the native artifact of the platform,
   compared by its sha256 digest against the packed binary.
5. It prints the observation and `INSTALL_GATE_OK` when every expectation
   holds.

Run `npm run verify:install` locally. The command rebuilds first, so it
always verifies the current tree. The gate needs the registry for the
pinned `typebox` dependency and to learn that platform packages without a
local tarball are absent; optional dependencies that resolve to nothing
are skipped. It loads measuretwice itself from the packed tarballs only.
It uses no credential and runs no provider call, so it stays outside the
rules for ordinary tests but never becomes a live evaluation.

The install job of `.github/workflows/build-artifacts.yml` requires the
gate in continuous integration: one clean installation per declared Node
version, Node.js 20, 22, and 24 on Linux x64 and Node.js 22 on Windows
x64 and macOS ARM64, plus one x64 build of Node on the macOS ARM64 runner
through Rosetta 2 for the darwin-x64 artifact. It runs with
`--require-all`, so a missing platform tarball fails the pipeline. The
linux-arm64-gnu artifact has no matching hosted runner in that workflow;
the packaging checks verify its tarball content, and a matching runner
joins when one exists. The wiring itself is under test:
`tests/repo/install-gate.test.ts` keeps the command, the check script,
the workflow requirement, and this documentation together.

## Red, green, refactor

Use this cycle for every behavioral change, as AGENTS.md section 6 requires.

1. State the expected behavior and the failure cases in the task record.
2. Write the smallest test that fails for the stated reason.
3. Run the suite and confirm the new test fails for that reason only.
4. Write the least code that makes the test pass.
5. Run the whole suite and confirm it is green.
6. Refactor the code while the tests stay green.
7. Run `npm run check` before you report the change as complete.

Reproduce a bug with a failing regression test before you fix it. Do not
weaken an assertion to hide a failure.

## Deterministic test support

Two support modules give the same controls to both languages.

- The Rust module `measuretwice_core::testing` in
  `crates/measuretwice-core/src/testing.rs` provides a `FakeClock`, a
  `SequenceIds` generator, a seeded `SplitMix64` generator, and an unbiased
  `shuffle`.
- The TypeScript module in
  `packages/measuretwice/test/support/deterministic.ts` provides the same
  `FakeClock`, `sequenceIds`, and `SplitMix64`, plus a
  `ScriptedBoundary` that fakes one external call boundary.

`SplitMix64` produces identical streams in both languages. Both suites
assert the same golden values, so the parity is itself under test.

`ScriptedBoundary` records every request and answers with scripted results
in order. It fails with an explicit error when the script runs out. It
never invents an answer and it never contacts a service. Use it for
evaluator and adapter boundaries. The evaluator contract suite scripts
every adapter through it.

The two shipped test adapters are product code, not test support. They
live in `packages/measuretwice/src/test-evaluator.ts` and leave with the
public package, so hosts and the later CLI workflows exercise evaluator
bindings offline. `createScriptedEvaluator` answers through one control
list with success, malformed, error, and delayed controls, and
`createLabelOnlyEvaluator` answers from one fixed table of check answers.
Both stay offline and deterministic.

## Conformance fixtures

The shared fixtures in `fixtures/` pin the portable contracts before the
wrappers exist. The [fixture README](fixtures/README.md) lists every group and
its runner rule.

- The repository checks in `tests/repo/fixtures.test.ts` verify the fixture
  data: the digest formula, the structural invariants, and the cross-file
  links. They are offline and deterministic.
- The native boundary suite in
  `packages/measuretwice/test/native.test.ts` runs the definition,
  input-validation, canonical-hash, hashing-rejection, string-rule,
  profile-state, and runtime-trace groups through the NAPI-RS binding, so
  the boundary itself answers the same fixtures. The profile-state group
  crosses through `validateProfile` and `checkProfileCompatibility`, so
  every artifact rejection and every compatibility pairing, live evaluator
  state and mode included, answers identically across the boundary. One child-process check
  proves that loading and exercising the binding makes no provider calls
  and writes no application storage.
- The authoring suite in
  `packages/measuretwice/test/define-checks.test.ts` executes the
  TypeScript source of every TypeBox pair through the built package, then
  compares the converted artifact and the definition-domain hash with the
  fixture records. The source is plain JavaScript, so the test rewrites
  its two imports to the pinned TypeBox entry and the built package entry,
  writes one temporary module, and imports it. The fixture stays the one
  source of truth for both sides.
- The Rust integration tests in
  `crates/measuretwice-core/tests/contract_fixtures.rs` run the fixture
  groups that the core owns so far: the valid definition artifacts with
  their check kinds, every definition rejection record, the input
  validation records through the complete case path, the dataset loading
  records, the reference-label meaning and provenance records of
  `fixtures/datasets/labels.json` (every flagged conflict, every provenance
  count, and every reference that breaks the meaning of its check), the
  grouped splits and dataset identities of `fixtures/datasets/splits.json`
  (every computed identity, group assignment, and split hash, the
  deterministic reproduction under another file order, the changed input
  that changes its split hash alone, every rejection with its code and
  path, every evidence classification, and every overlap row with the
  refusal that follows it), the
  evaluation metrics of `fixtures/metrics/evaluation.json` (every metric
  set with its predicted outcome counts, its confusion matrix over the
  reference categories, and its six rates with numerators, denominators,
  and null values for zero denominators, the per-slice sets, the attempts,
  latency, and usage totals, and every rejection with its code and path,
  against expectations from one independent implementation of the metric
  definitions), the uncertainty intervals of
  `fixtures/metrics/intervals.json` (every count row against one
  independent implementation of the documented formula, every valid row
  with the interval rows of every scope and slice under its declared
  sampling model, confidence level, and minimum sample count, the complete
  method statement, and every rejected request with its code and path),
  the calibration plans of `fixtures/plans/validation.json` (every valid
  artifact with its stored self-hash and its derived facts, stated by one
  implementation of the hashing and enumeration rules outside the core:
  the candidate count, the head of the candidate enumeration in the
  declared order, the objective, the confidence level, and the denominator
  names; every invalid plan with its code and path; and every binding row
  against the stated loaded definition, the stated split identities of the
  shared datasets, or the stated registered evaluators),
  the fitting search of `fixtures/fitting/search.json` (every plan run
  through the Rust fitting boundary over the shared fitting split and the
  stored assessments, with the status, the case and candidate counts, the
  computed split hash, the selected candidate with its objective counts,
  its goal rows, and its per-scope outcome counts, one row per enumerated
  candidate with its feasible flag, its unmet metric words, and its
  evidence states; and every invalid row rejected with its stated code and
  path, covering validation data offered as fitting data, absent splits,
  foreign revisions and definitions, and broken assessments),
  the frozen validation of `fixtures/qualification/validation.json` (every
  plan fitted over the shared fitting split and qualified through the Rust
  qualification boundary with the stated request and validation
  assessments, with the status, the reason codes in decision order, the
  evidence class, the frozen candidate with its applied policy, every goal
  row with its counts, bounds, draws, and evidence state, the sample
  requirements, the slice floors, and the predicted outcome counts of the
  complete check set; and every invalid row rejected with its stated code
  and path, covering wrong-purpose, absent, and foreign validation
  selections, fitting results of another plan or with one patched identity
  or one candidate outside the grid, one search with no feasible
  candidate, and broken assessments),
  the hashing rejection
  records, the canonical hash fixtures across every domain, the exact
  string rule records through the Rust rules, the serialization round
  trips, the TypeBox pair hashes, the profile artifacts through the
  profile boundary (every valid artifact validates, every invalid record
  rejects with its stated code and path, one edited copy fails its stored
  self-hash), the compatibility pairings of the states group through
  `profile::check_compatibility` with the stated live evaluator state and
  mode, the outcome, check record, and completion samples through the
  report builder and parser, and the runtime traces replayed event by
  event through the run state boundary, compared on every expected record,
  the aggregate, the completion, and the rejected events. Each validation
  task adds its own groups when its boundary lands. The label suite in
  `packages/measuretwice/test/dataset-labels.test.ts` answers the same
  label group through the public boundary and the native binding, and the
  split suite in `packages/measuretwice/test/dataset-splits.test.ts`
  answers the same split group through the public boundary.
- Every wrapper runs every group through the Rust core. A wrapper never
  recomputes a rule, a canonical form, or a hash.
- The test evaluator suite in
  `packages/measuretwice/test/test-evaluator.test.ts` drives every adapter
  conformance case of `fixtures/adapters/conformance.json` through the
  dispatch contract and the shipped test adapters, decides every label-rule
  row with the separately specified test decision rule, and checks the
  replacement and binding invariants. The same cases are part of the
  adapter conformance that the later Python wrapper must reproduce.
- The Jev translation suite in
  `packages/measuretwice/test/jev.test.ts` drives every translation case
  of `fixtures/translations/jev.json` through the dispatched request and
  the public translation, compares the complete question, the canonical
  text, and the translation-domain digest with the Rust core, builds the
  evidence state from the projected inputs, and proves that one changed
  translated question changes the digest and the profile binding while
  the definition stays unchanged. The Rust integration tests hash the
  same questions through the core directly. The later Python adapter must
  pass the same cases.
- The Jev normalization suite in
  `packages/measuretwice/test/jev-assessment.test.ts` drives every case of
  `fixtures/adapters/jev-normalization.json` through the Jev adapter and
  the dispatch contract, so each normalized assessment crosses the Rust
  assessment validation against its check. The responses come from the
  synthetic provider fixtures, the clock is injected, and the Jev boundary
  is one fake function, so the suite stays offline. The later Python
  adapter must produce the same assessments and the same failures.
- The Jev boundary suite in
  `packages/measuretwice/test/jev-boundaries.test.ts` drives the flagship
  intervention-review definition of `mvp-guide.html`, with its four
  different input projections, through the Jev adapter and the dispatch
  contract. Every request holds only the projected inputs that its
  `using` list authorizes and exactly one question, evidence at the state
  budget passes while one byte above is rejected before the provider call
  with `oversized_input` and no truncation, two cases from unrelated
  access scopes never share one request and no scope metadata crosses,
  one thrown and one malformed provider answer fail their own check alone,
  and embedded instructions inside supplied evidence change no registered
  evaluator, no permission, and no request boundary. The later Python
  adapter must hold the same limits.
- The Rust integration tests in `crates/measuretwice-core/tests/contract_fixtures.rs`
  run the assessment samples of `fixtures/assessments/samples.json` through
  `measuretwice_core::assessment::validate_assessment`, one definition per
  answer kind, so the semantic rules of the assessment contract stay inside
  the core.
- The same integration tests decide the valid assessment samples through
  `measuretwice_core::policy::decide` under one `probability_mass_v0`
  policy, and reproduce the frozen review record of
  `fixtures/reports/outcomes.json` through the same boundary. The unit
  tests of `crates/measuretwice-core/src/policy.rs` hold the table-driven
  coverage of the family: cutoff decisions, boundary equality, review
  labels and levels, confidence floors, invalid parameters, unfit
  policies, and the explicit failures for missing distributions and Score
  means.
- The unit tests of `crates/measuretwice-core/src/fitting.rs` hold the
  bounded search of task T048 over one definition with one question check
  and one exact rule: the known feasible candidate with its per-scope
  metric sets, the tie that takes the first candidate of the declared
  enumeration order, conflicting goals and one unachievable goal as valid
  no-feasible results with unmeasured goals kept visible, the plan minimum
  and the zero denominator as evidence states that gate one goal, the
  Wilson upper bound as the `upper_confidence_bound` basis, the refusals
  that keep validation data, absent splits, foreign revisions and
  definitions, and broken assessments outside the search, the explicit
  fitting-budget failures, the insufficient-evidence result of one empty
  split, partial labels, and the strict text gate of the assessment input.
- The unit tests of `crates/measuretwice-core/src/qualification.rs` hold
  the frozen validation of task T049 over the same definition shape: the
  validated scope with its goal rows, sample requirements, slice floors,
  metric sets, and interval rows, the upper-bound basis that qualifies and
  fails zero observed errors, the unmet goal that returns the frozen
  candidate unchanged while the validation data favors another permitted
  candidate, the plan minimum and the unlabeled validation as insufficient
  evidence with calculated reasons, the correlated groups that state
  `unsupported_sampling` under `independent_cases` and validate under
  `grouped_cases`, the reused holdout and the non-representative dataset
  as development data, the important slice below its floor and the slice
  the validation holds no case of, the empty validation split, the freeze
  refusals for one plan edited after the search, one fitting result of
  another plan, one patched definition, split, or digest, one candidate
  outside the grid, and one search with no feasible candidate, the
  validation-selection refusals, the assessment paths, the request parser,
  and the strict text gate. One test pins that the frozen validation
  computes the three measured statuses and never `unvalidated`, the status
  of one exploration profile.
- The same integration tests run the case-reference rows of
  `fixtures/reports/outcomes.json` through
  `measuretwice_core::report::parse_case_reference` and one built report:
  every valid row round-trips with and without one host snapshot
  reference, and every invalid row (raw case input, one credential field,
  one empty, overlong, or mistyped snapshot reference) refuses with its
  stated reason code and field path. The unit tests of the report module
  hold the same bounds at the builder boundary.
- The scheduler suite in
  `packages/measuretwice/test/scheduler.test.ts` replays the runtime
  traces that state no adversarial result ordering through the wrapper
  scheduler. The trace events script the resolutions by hand, and every
  expected check record, the aggregate, and the completion compare. The
  trace `permanent-failure` drives the permanent record of task T032
  through the wrapper policy, and the Rust and native suites replay it
  through the boundary transition `failPermanent`.
- The same fixtures are mandatory for the later Python SDK. MVP_SPEC.md
  section 15 states this requirement.
- A contract change updates the affected fixtures in the same change, as the
  [contracts README](contracts/README.md) requires.

## Formal models

The TLA+ models and their records live in [models/](models/README.md).
AGENTS.md section 7 requires them for critical state behavior. The
execution-state model and the profile-qualification model are published.

- The repository check `tests/repo/models.test.ts` verifies that each
  record matches its module and its configuration. It is offline and
  deterministic.
- TLC itself runs outside the ordinary suite, because the jar is not
  part of the repository. [models/README.md](models/README.md) records
  the pinned release and the exact commands.
- Continuous integration does not run TLC. Task T078 decides the
  release-audit integration.
- A checked model does not prove that the implementation matches it.
  The record for each model states what the model omits.

## Live evaluations are opt-in

A live evaluation contacts a real evaluator. It spends an API budget, and
it may need credentials. Ordinary tests never do this, and MVP_SPEC.md
section 15 requires the separation.

1. Put live tests in `tests/live/` only. The ordinary Vitest configuration
   never loads that directory.
2. Start them with `npm run test:live`. This command uses
   `vitest.live.config.ts`.
3. Read credentials from the process environment. Never commit them.
4. Record the resolved model version, the exact requests, and the actual
   errors with the results.
5. Keep live results out of the ordinary test fixtures. A measured result
   for one model version is not a permanent expectation.

Continuous integration never starts live evaluations. The first live
benchmark arrives with task T065. Do not report a checklist review as a
live evaluation.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. It runs the
Rust format, lint, and test gates, cross-checks the declared Rust targets
that no hosted runner executes natively, and builds the native binding with
Node.js 20, 22, and 24 on Linux, plus Windows and macOS, as
[DEVELOPING.md](DEVELOPING.md) declares. The jobs read no secrets, so the
whole pipeline stays deterministic and free.

`.github/workflows/build-artifacts.yml` builds one release binary for every
declared target on a matching runner, assembles the platform packages and
the staged public package, and verifies one clean installation of the
packed tarballs per declared Node version without Rust tooling. It uploads
the tarballs as workflow artifacts. It reads no secrets and publishes
nothing. The [clean installation gate](#clean-installation-gate) section
records the coverage.

Three platform rules keep that matrix green:

- Node.js 20 states no line and column in one JSON parse failure. The
  parse diagnostic derives `line L column C` from the position that
  Node.js 20 states, so the `invalid_json` failure reads the same on
  Node.js 20, 22, and 24.
- Fixture paths use "/" on every platform. The fixture walk in
  `tests/repo/fixtures.test.ts` reports forward slashes, because the
  manifest states forward slashes and Windows reports backslashes.
- Checkouts keep the committed bytes. `.gitattributes` normalizes text
  files to LF. Windows working trees then hold the committed bytes, and
  the byte-exact export and hashing checks compare equal content.

The cross binaries of the artifact workflow link through one pinned zig
release. Zig renamed its archives at 0.14, and an older setup action
requested names that no longer exist, so every cross build failed with 404
before the pin.
