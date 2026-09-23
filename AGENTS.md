# Engineering instructions

These instructions apply to all work in this repository.

## Project name

The project name is **measuretwice**. Always use this exact spelling: one word, all lowercase.
Do not use "Measure Twice", "measure twice", "MeasureTwice", or another form as the project name.
Apply this rule to headings, documentation, interface text, examples, package descriptions, and responses.
Preserve exact external quotations and historical research records when source fidelity is required.

Read [MVP_SPEC.md](MVP_SPEC.md) before you change product behavior or architecture.
Treat [research/](research/index.md) as background material. It contains proposals that the current specification can replace.
Keep code, tests, examples, and the specification consistent. Make changes to product contracts explicit.

## 1. Use ASD-STE100 English

Always use ASD-STE100 Simplified Technical English for prose that you write for this project.
Apply this rule to responses, documentation, comments, reports, errors, and interface text.

- Use the approved vocabulary and writing rules where applicable.
- Use short sentences. Limit instructions to 20 words per sentence and descriptions to 25 words per sentence.
- Give each sentence one main idea.
- Use active voice. Name the person or component that does the action.
- Use the same term for the same concept. Do not introduce synonyms for variety.
- Define technical terms before you use them. Keep technical names and technical verbs consistent.
- Give one instruction per step. State conditions before the action when this helps the reader.
- Use direct statements. Avoid idioms, metaphors, marketing language, and vague claims.
- Explain a failure with its cause and the next useful action.
- Preserve exact code identifiers, external names, and quoted source text.

Use the [official ASD-STE100 resources](https://www.asd-ste100.org/) to resolve questions about the standard.
Do not claim verified compliance unless the text was checked against the applicable rules and dictionary.

## 2. Keep the product simple

Apply the Keep It Simple, Stupid principle.
Implement the smallest complete solution that meets the current requirement.

- Prefer explicit data and ordinary functions.
- Add an abstraction when it represents a domain concept or removes demonstrated repetition.
- Do not build a framework for hypothetical future requirements.
- Keep dependencies few. Explain why each new dependency is necessary.
- Avoid hidden execution, global state, implicit network calls, and surprising defaults.
- Use one canonical representation for equivalent YAML and TypeScript definitions.
- Keep numerical controls available without putting them in the basic authoring workflow.
- Remove dead code and obsolete configuration when a change makes them unnecessary.

Simple code must still handle required failures, resource limits, and data validation.
Do not remove necessary checks to reduce line count.

## 3. Do not make the user think unnecessarily

Apply the Don't Make Me Think principle to APIs, files, commands, and reports.

- Use names that explain the purpose in domain language.
- Make the common task easy to find and complete.
- Keep similar operations consistent.
- Show useful defaults and explain their limits.
- Show advanced details only when the user needs them. Keep those details inspectable.
- Let a reader understand a check without learning a provider API.
- Show what happened, why the policy produced that result, and what the user can do next.
- Use a complete example to explain a workflow.
- Test the interface with someone who has not read the implementation.

If a basic operation requires a long explanation, review the design before adding more documentation.

## 4. Use domain-driven design

Start with domain meaning, rules, and ownership.
Use the same vocabulary in code, schemas, documentation, examples, and tests.

| Term | Meaning |
| --- | --- |
| Check | A requirement, its evidence inputs, and its acceptable outcomes. |
| Case | The input data supplied for assessment. |
| Assessment | The measurement returned by an evaluator. |
| Evaluator | The implementation that assesses a check. |
| Calibration plan | The goals, data procedure, and permitted policy family. |
| Profile | The evaluator binding, decision rules, and supporting evaluation evidence. |
| Report | The recorded execution and policy outcomes. |

- Keep check meaning separate from evaluator behavior and numerical policy.
- Keep application authorization separate from check outcomes.
- Define invariants before you design data structures.
- Put each invariant in the module that owns the relevant state.
- Validate data when it enters the system. Use types to preserve established constraints inside the system.
- Distinguish invalid input, execution failure, uncertain judgment, and rejection.
- Use explicit state types. Prevent invalid states where practical.
- Use immutable values for definitions, profiles, and completed records.
- Use classes, entities, and aggregates only when identity or lifecycle requires them.

Domain-driven design does not require a class hierarchy, microservices, or a repository interface for every value.

## 5. Keep modules independent

Organize modules by responsibility and domain ownership.
The domain core must not depend on provider SDKs, CLI output, storage, or Cassandra.

- Keep parsing, validation, assessment, policy, calibration, and rendering separate.
- Put provider SDKs behind evaluator adapters.
- Keep statistical calculations in deterministic functions with explicit inputs.
- Put clocks, identifiers, network access, and other external effects at clear boundaries.
- Use small public interfaces. Keep implementation details private.
- Pass dependencies explicitly. Avoid service locators and unnecessary dependency-injection frameworks.
- Prevent circular imports.
- Add adapter contract tests when multiple implementations share an interface.
- Introduce one implementation first when the specification does not require more.

Keep the application responsible for its storage, credentials, permissions, and business actions.

## 6. Use test-driven development

For behavioral changes, use the red, green, refactor cycle.

1. State the expected behavior and relevant failure cases.
2. Write the smallest meaningful test that fails for the expected reason.
3. Implement enough code to make that test pass.
4. Refactor while the tests remain green.
5. Run the checks required for the changed boundary.

- Reproduce a bug with a failing regression test before you fix it.
- Test observable behavior and invariants. Avoid tests that copy the implementation.
- Use table-driven tests for policy boundaries and outcome combinations.
- Use property-based tests when many input combinations can violate an invariant.
- Test canonicalization, serialization round trips, and adapter contracts.
- Test cancellation, timeouts, retries, partial failure, and resource saturation.
- Keep unit tests deterministic. Control time and randomness.
- Mock external boundaries when necessary. Prefer real domain code inside a test.
- Keep live model tests opt-in. Normal tests must not require credentials or API spend.
- Separate software correctness tests from empirical model-quality evaluations.
- Do not weaken an assertion or acceptance target to hide a failure.

Documentation-only changes need appropriate document checks, not artificial code tests.
Coverage numbers support review; they do not establish correctness.

## 7. Use TLA+ for critical state behavior

Use TLA+ to model critical state transitions before implementation or a material redesign.
Focus on concurrency, retries, cancellation, profile activation, and authorization boundaries.
Select a bounded model that addresses a concrete risk.

Relevant properties include:

- An incompatible profile cannot be used for enforcement.
- An unvalidated profile cannot become an enforcement profile through execution alone.
- A shadow run cannot authorize an application action.
- An error or skipped check cannot become a pass.
- A cancelled or completed run cannot accept a late result that changes its terminal state.
- Active execution cannot exceed the configured concurrency limit.
- A retry cannot silently switch the bound profile or case input.

For each model:

1. State the property, assumptions, and implementation boundary.
2. Define the state variables and transitions.
3. Check safety properties. Check progress properties when required, with explicit fairness assumptions.
4. Record the tool version, configuration, bounds, and completion status.
5. Map the model to the code and identify behaviors that the model omits.
6. Turn applicable counterexamples into regression tests.
7. Update the model or its applicability record when the implementation changes.

Do not weaken an invariant or omit a failing transition to obtain a successful result.
A checked model does not prove that the implementation matches it.
A timeout or incomplete exploration is inconclusive.

Do not require a formal model for ordinary formatting, rendering, or simple stateless transformations.
Use tests for those cases. Keep formal work proportional to the state risk.

## 8. Document extensively and maintain the documentation

Document the information needed to understand, use, change, and operate the project.
Update documentation in the same change as the behavior it describes.

Maintain these forms of documentation as the corresponding features are implemented:

- A short product explanation and a working quickstart.
- Complete examples for authoring, evaluation, calibration, shadow runs, and profile selection.
- Reference documentation for public APIs, schemas, commands, errors, and configuration.
- Domain definitions, module boundaries, and data-flow explanations.
- Architecture decision records for material choices and tradeoffs.
- Invariants, failure behavior, and the purpose of each important test or formal model.
- Calibration methodology, dataset provenance, sampling assumptions, metrics, and limitations.
- Migration instructions when a public contract changes.
- Reproducible setup and verification commands.

Public API documentation must state inputs, outputs, side effects, failure modes, and relevant resource limits.
Comments should explain intent, constraints, and reasons that the code cannot express clearly.
Avoid comments that repeat the code.
Link to one authoritative explanation instead of maintaining several copies.
Mark proposed, implemented, and experimentally measured behavior distinctly.

Extensive documentation means complete coverage of useful information. It does not mean unnecessary length.

## 9. Preserve measurement integrity

- Let AI propose checks, examples, and analyses. Compute numerical results with tested code.
- Preserve label provenance. Do not present model-generated labels as human judgments.
- Keep fitting data separate from independent validation data.
- Record metric definitions, denominators, sample counts, uncertainty methods, and population limits.
- Keep provider confidence separate from measured correctness.
- Treat insufficient evidence as a valid result.
- Bind evaluations to exact definitions, inputs, translations, models, and policies.
- Require new qualification when a material binding or intended population changes.
- Never fabricate benchmark results or infer accuracy from baseline agreement.

## 10. Make failures explicit

- Treat files, model outputs, and retrieved content as untrusted data.
- Validate external data with schemas and domain rules.
- Never execute code or authorize tools because a generated check file names them.
- Keep credentials and private content out of default logs and committed examples.
- Bound concurrency, queue size, input size, retries, and execution time.
- Use typed errors and stable reason codes. Preserve useful causes without exposing secrets.
- Make cleanup and cancellation behavior explicit.
- Prefer observable, recoverable failure to a silent fallback that changes meaning.
- Preserve user changes. Do not overwrite unrelated work.

## 11. Completion checks

Before you report a change as complete:

1. Confirm that the change meets the requested behavior and current specification.
2. Check domain boundaries, invariants, and public-contract compatibility.
3. Run the relevant tests, type checks, lint checks, and document checks that exist in the repository.
4. Run the relevant model checks when critical state behavior changed.
5. Review examples, error messages, and explanations for clarity and consistent terms.
6. Update documentation and record any material limitations.
7. Report what changed, what was verified, and what remains unverified.

Do not invent commands, passing tests, formal results, or performance claims.
If a required tool is unavailable, state the limitation and complete the useful checks that remain possible.
