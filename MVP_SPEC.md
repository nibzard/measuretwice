# measuretwice — MVP specification

Status: Implemented for v0 in this repository; deferred items state their own status  
Date: 23 September 2026 · status updated 25 September 2026  
Target: v0 · Rust core · TypeScript + TypeBox authoring · Jev first · Apache-2.0

## 1. Purpose

**Write what good looks like. Let AI help build and calibrate the checks. Understand the results before relying on them.**

measuretwice is a library and small CLI for introducing semantic checks into applications. Developers author readable checks in TypeScript. A shared Rust core validates data and applies decision rules. Evaluators assess cases. A separately evaluated profile determines when an assessment is reliable enough to use. Reports make the outcome and its basis inspectable.

**Job to be done:** When I add an AI judgment to my application, help me express what must be true, measure how well it works, and detect regressions before changing application behavior.

The experience should be easy to explain:

```text
Describe → draft checks → review → calibrate → shadow → use
                                      ↑                  │
                                      └──── improve ─────┘
```

A coding agent or capable LLM assists with authoring, example creation, calibration, and improvement. Jev performs the initial runtime judgments. Statistical code measures performance; humans establish requirements, review reference labels, and decide which tradeoffs are acceptable.

Cassandra is the first production-like test environment. Its concrete problem is whether a proposed memory or intervention is supported and useful. The library's vocabulary and interfaces remain independent of Discord, Cassandra's database, and its delivery system.

## 2. Principles

- Put intent in the check file and numerical tuning in an inspectable profile.
- A person should understand a check without knowing a model API or statistical terminology.
- TypeScript is the v0 authoring interface. Python is the next SDK delivery. Both use one portable JSON contract.
- Use TypeBox for TypeScript input schemas. Keep executable callbacks outside portable definitions.
- Defer YAML parsing and authoring. Users do not manage JSON exports in the normal library workflow.
- AI produces reviewable files, examples, analyses, and diffs. It never silently changes the meaning of an approved requirement.
- Preserve model-specific measurements without presenting them as universal confidence scores.
- Keep evaluators replaceable. Changing one requires new evaluation, not a rewrite of the requirement.
- Keep exact checks, statistical calculations, and authorization in ordinary code.
- Introduce only checks, cases, and reports in the getting-started guide. Explain profiles when the user moves from experimentation to reliance.
- Make the common integration small. Keep numerical details, resource settings, and diagnostic metadata available through progressive disclosure.

This specification preserves the readable, AI-assisted check-authoring workflow in the [original architecture](research/03-checks-yaml-architecture.md). It adds calibration profiles, shadow runs, and revision comparisons. The TypeScript-first design replaces YAML authoring in v0. Bayesian inference and adaptive investigation remain deferred.

## 3. Four responsibilities

| Layer | Responsibility | Artifact |
| --- | --- | --- |
| Check | Express the question, evidence, and acceptable outcomes. | TypeScript source that produces a portable JSON definition |
| Evaluator | Translate and execute a check using a model or deterministic method. | A registered adapter and versioned translation |
| Calibration profile | Bind an evaluator and decision rules to measured performance on a declared population. | Generated, versioned JSON plus an explanation |
| Report | Preserve the assessment, decision, evidence references, and operational result. | Structured record and readable rendering |

A case supplies the artifact and evidence. A labeled case additionally supplies reference answers and their provenance. The profile is a durable output of calibration, not a live AI judgment made on every request.

The v0 interfaces and file formats below are implemented and tested in this repository.
The frozen contracts live in [contracts/README.md](contracts/README.md).
The implemented signatures live in the [API reference](docs/reference/api.md).
Text below that still describes one proposal states that status, and no number is a measured result unless its source is stated.

## 4. Readable TypeScript definitions

The flagship example assesses a proposed intervention. A prior decision requires customer exports to remain in the EU. A conversation proposes moving an export worker to a US region.
The application supplies the original evidence, current discussion, and drafted message.

```ts
import Type from "typebox";
import { defineChecks } from "measuretwice";

export const intervention = defineChecks({
  version: 1,
  name: "intervention-review",
  when_uncertain: "review",
  inputs: Type.Object({
    prior_decision: Type.String({ minLength: 1 }),
    conversation: Type.String({ minLength: 1 }),
    proposed_message: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  checks: [
    {
      id: "decision-conflict",
      name: "An earlier decision is being contradicted",
      using: ["prior_decision", "conversation"],
      question: "How does the new proposal relate to the earlier decision?",
      answers: {
        conflict: "It conflicts with a decision that still applies.",
        replaced: "The team explicitly replaced the earlier decision.",
        aligned: "It is compatible with the earlier decision.",
        unclear: "Applicability or the relationship cannot be established."
      },
      accept: "conflict",
      review: "unclear"
    },
    {
      id: "message-supported",
      name: "Our message accurately describes the evidence",
      using: ["prior_decision", "conversation", "proposed_message"],
      question: "Does every material claim in the proposed message follow from the evidence?",
      answers: {
        supported: "All claims are supported with appropriate certainty and attribution.",
        contradicted: "A material claim conflicts with the supplied evidence.",
        incomplete: "Support for a material claim is missing or ambiguous."
      },
      accept: "supported",
      review: "incomplete"
    },
    {
      id: "adds-information",
      name: "We are adding something new",
      using: ["conversation", "proposed_message"],
      question: "Has the conversation already acknowledged this concern?",
      answers: {
        yes: "A participant explicitly recognizes this specific concern.",
        no: "No supplied message explicitly recognizes this specific concern."
      },
      accept: "no"
    },
    {
      id: "consequence",
      name: "The concern warrants an interruption",
      using: ["prior_decision", "conversation", "proposed_message"],
      question: "What consequence does this concern have, based on the evidence?",
      scale: [
        { minor: "A wording or preference difference with no identified operational consequence." },
        { meaningful: "A coordination problem causing rework or delay." },
        { serious: "A conflict affecting an explicit customer commitment or operational requirement." }
      ],
      accept: {
        at_least: "meaningful"
      }
    }
  ],
});
```

The reader sees the question, available evidence, and acceptable outcomes. Jev primitive names and numerical cutoffs stay outside the check.
The scale uses an ordered array. Its order must survive serialization and canonicalization.

Exact requirements can use a rule instead of a question:

```ts
{
  id: "message-length",
  name: "The message fits our delivery limit",
  using: ["proposed_message"],
  rule: { maxLength: 900 },
}
```

The length limit expresses a product requirement. A model-confidence cutoff belongs in the profile.

### Definition semantics

- Each check has a stable `id`, a readable `name`, and a nonempty `using` list referring to declared inputs.
- Each check has exactly one of `question` or `rule`.
- Questions have either named `answers` or an ordered `scale`, never both.
- Exactly two answer keys, `yes` and `no`, declare a binary question. Other answer sets are categorical.
- `accept` selects one or more answer labels. `review` optionally selects disjoint labels. Remaining labels are unacceptable.
- For scales, `accept.at_least` identifies the first acceptable level. Higher levels are also acceptable.
- `when_uncertain: "review"` is the only uncertainty behavior in v0. It defaults to review when omitted.
- Acceptance defines meaning. It does not establish a probability of correctness.
- Unknown labels, duplicate IDs, overlapping accept/review sets, invalid scales, and empty check sets are definition errors.
- `inputs` is one JSON Schema object schema, authored with `Type.Object`. Its properties name the inputs available to `using`.
- Every top-level input is required. The top-level schema must set `additionalProperties: false`. Nested objects declare their own required properties.
- Rust performs runtime validation. TypeScript types do not replace validation at the native boundary.
- Initial exact rules are `maxLength`, `includes`, and `excludes` on one string input. They require no statistical calibration.
- Define Unicode length and matching semantics once in Rust. Preserve those semantics in every language wrapper.

This change replaced the earlier field-to-schema map with one complete object schema before the first published contract.
The examples and the generated contracts changed together. No migration applies.

### Portable schema boundary

TypeBox provides schema construction and TypeScript inference. The shared core receives plain JSON Schema, without TypeBox or provider objects.
Start with an explicit JSON Schema 2020-12 subset for strings, finite numbers, booleans, arrays, and objects.
Publish the supported keywords and constraints before implementation. Reject unsupported schema features with a field path and useful error.

Portable definitions cannot contain callbacks, closures, custom executable validators, transforms, or JavaScript-only values.
Do not silently drop an unsupported constraint. TypeBox authoring metadata may be removed only by a documented, tested conversion.
Application preprocessing remains outside the definition; profiles record its version when it affects assessments.

Validate definitions, schemas, cases, profiles, and assessments in Rust. Keep mutation, type coercion, and implicit input defaults disabled.
Use one canonicalization procedure in Rust for hashes. Define numeric limits, string handling, omitted values, and ordered arrays explicitly.
Use shared fixtures to prevent differences in serialization, validation, and hashing across languages.

## 5. TypeScript integration and shared Rust core

The application imports its trusted definition through its normal build. `defineChecks` returns a validated, serializable definition with inferred TypeScript input types.
`load` accepts that definition directly. Users do not need to generate an intermediate file.

```ts
import { load } from "measuretwice";
import { intervention } from "./.measuretwice/checks/intervention.js";

const reviewer = await load(intervention, {
  profile: ".measuretwice/profiles/intervention.json",
});

const report = await reviewer.run({
  id: proposal.id,
  input: {
    prior_decision: priorDecisionWithSources,
    conversation: recentConversation,
    proposed_message: proposal.text,
  },
}, {
  mode: "shadow",
  baseline: { outcome: existingDecision, revision: "policy-1" },
});

await saveReport(report); // Application-owned storage.
```

The `.js` import names the emitted module from the application's TypeScript build.
`defineChecks` preserves type inference for case inputs and declared input names in `using`.
All public interfaces remain independent of Jev SDK classes and native binding types.

The main API is `defineChecks`, `load`, `run`, `calibrate`, `revise`, `evaluate`, and `compare`.
Inspection belongs to the profile and report interfaces, which also verify retained evidence. It does not require an orchestration framework.
`load` may also read an explicitly exported JSON definition. It does not load YAML or execute TypeScript source files.

### Responsibilities across the language boundary

| Component | Owns | Does not own |
| --- | --- | --- |
| Rust core | Contract validation, input projection, exact rules, profile compatibility, decision rules, outcome aggregation, canonical hashes, statistical calculations | Provider SDKs, network calls, credentials, application storage |
| TypeScript SDK | TypeBox authoring, inferred types, ordinary async API, evaluator registration, bounded scheduling, cancellation, file access, report rendering | Independent copies of core decision or calibration rules |
| Jev adapter | Versioned question translation, official SDK calls, assessment normalization, usage and error mapping | Application actions or profile promotion |
| Application | Trusted imports, preprocessing, credentials, storage, profile selection, permissions, delivery | Automatic approval from a passing report |

The Rust core is an ordinary library with serializable inputs and outputs. It needs no embedded JavaScript runtime or network client.
Use NAPI-RS for the Node binding. Keep the binding thin; Rust types do not become the public TypeScript API.
The wrapper sends validated projected requests to registered evaluators. It returns assessments or operational records to Rust for validation and report construction.

The wrapper owns queueing, deadlines, retries, and cancellation. Specify these behaviors in shared conformance cases for future wrappers.
Rust owns deterministic checks on valid run transitions and terminal results. A late result cannot change a completed or cancelled report.
Define this state boundary before implementation and model its critical invariants with TLA+.
Keep long calibration calculations off the Node event loop. Rust must not call back into arbitrary user code during those calculations.

### Python follows the TypeScript test MVP

Python is the next SDK delivery after the TypeScript pilot. It is a near-term product requirement.
Use PyO3 for bindings and maturin for packaging. Python authors definitions through an idiomatic wrapper that emits the same JSON contract.
Do not require Python users to execute TypeScript. Choose the Python schema-authoring integration when building that wrapper.

Python reuses Rust validation, rules, statistics, canonicalization, and reports. Its native provider adapter must pass the same translation and runtime conformance tests.
A shared core does not establish evaluator equivalence. Record actual adapter translations and versions, and requalify profiles when material bindings change.

Ship a declared platform matrix and prebuilt binaries for supported targets. Normal installation on those targets must not require a Rust compiler.
Python packaging tests are required before Python release. Browser, edge, and WebAssembly support are separate future work.

### Minimal dependency direction

- TypeScript authoring: `typebox`.
- Initial semantic adapter: the official `@typesafe-ai/sdk`.
- Node binding: NAPI-RS and the generated native package artifacts.
- Rust: serialization, JSON Schema validation, canonicalization/hashing, and the selected statistical routines.
- Development: TypeScript, Node types, Vitest, Rust tooling, and conformance fixtures.

Select and pin Rust crates after confirming the supported schema keywords, numerical methods, and target platforms.
Do not add Zod, Ajv, a YAML parser, or an agent framework to the TypeScript runtime for v0.
Rust owns authoritative validation. TypeBox is the schema-authoring interface.

## 6. Evaluators and Jev

The evaluator contract receives a validated question, the exact projected inputs authorized by `using`, an execution budget, and a cancellation signal. It returns a typed assessment or an execution error.

An assessment identifies the answer kind and preserves the backend's actual output: a label, a binary value, an ordered score, optional distributions, optional confidence, and optional evidence references. Unsupported measurements are absent, never invented. Raw provider confidence remains distinct from empirical evaluation evidence.

The first semantic evaluator lives in the TypeScript adapter and uses the official TypeSafe SDK:

| Check shape | Jev implementation |
| --- | --- |
| Named answers | Choice |
| Explicit yes/no answers | Noul |
| Ordered descriptive scale | Score |

Record the complete translated question, adapter version, and translation hash in the profile. Jev Noul has no separate confidence field. Score returns a position along its levels and a distribution; its mean alone can hide a split between very different levels.

The initial profile family uses probability mass on acceptable and unacceptable answers or levels. For Noul, derive the masses from its yes value and the check's accepted answer. For Score, sum the distribution over the acceptable named levels. Do not silently round a fractional score or equate an ordinal mean with a correctness probability.

Calibration chooses separate acceptance and rejection cutoffs from a documented, bounded candidate grid. For this v0 policy family both cutoffs must exceed 0.5, preventing simultaneous acceptance and rejection; otherwise the result is review. An explicitly review-labeled Choice answer remains review. Optional Choice/Score confidence floors may add abstention and must be recorded and evaluated. Provider distributions are measurement inputs, not automatically calibrated probabilities of correctness.

Other evaluator implementations can later use a generative model, structured/function calling, or a bounded tool workflow. Function calling is an output mechanism, not a new standard of evidence. No confidence score is required by the generic interface; label-only evaluators need their own evaluated decision rule. v0 ships Jev and deterministic rules only, plus a test adapter proving the core does not depend on Jev response shapes.

Profiles refer only to explicitly registered evaluators. A loaded file cannot install plugins, execute code, or authorize new tools. Future tool evaluators must expose tool permissions, budgets, and evidence contracts; a successful tool call does not by itself establish the check.

## 7. AI-assisted calibration

Calibration is a supported workflow in v0. A capable LLM or coding agent manages the process by invoking library/CLI operations and inspecting results. The user can use their existing coding agent; a built-in agent loop or second hosted-model integration is not required.

1. **Draft:** Read requirements, propose narrow checks, and identify uncovered requirements.
2. **Exercise:** Propose counterexamples and ambiguous cases, clearly marked synthetic and unreviewed.
3. **Label:** Help reviewers inspect cases and request judgments. Preserve attribution and distinguish human labels from model suggestions.
4. **Set goals:** Ask the owner what errors matter and how much review is tolerable. Translate the answers into an inspectable calibration plan.
5. **Fit:** Run the evaluator on development cases. Rust statistical code searches the bounded policy family against the agreed objectives.
6. **Validate:** Freeze the candidate and evaluate it on held-out cases. Compute counts, intervals, slice results, and goal satisfaction in code.
7. **Explain:** Produce a plain-language account of errors, review burden, uncertainty, and missing evidence, linked to calculated metrics.
8. **Propose:** Write a profile and comparison for review. Never promote a revision automatically.

The larger model may propose changes and explain results. It cannot assert statistical significance, invent metrics, treat its own labels as human judgments, weaken goals to qualify a candidate, or quietly tune against the holdout.

### Goals and statistical evidence

Goals are separate from both check meaning and provider configuration. A versioned plan declares the target population, error metric and denominator, allowed error bounds, desired review/coverage tradeoffs, confidence level, required sample counts, important slices, dataset splits, and the candidate policy family. There are no universally safe default error tolerances.

For example, the owner might prioritize limiting incorrect interventions among accepted candidates, then minimize human review subject to that constraint. The plan must specify whether this refers to error among accepted cases or acceptance among unacceptable cases; those are different quantities.

Use tested Rust statistical routines for uncertainty intervals. Validate them against independent reference fixtures. Record their method, assumptions, and confidence level. Where appropriate, qualification compares an upper error bound with the declared limit, rather than comparing the observed error rate alone. Zero observed errors is not proof of zero risk. Small or missing denominators yield insufficient evidence.

Split related examples by conversation/source group to avoid leakage. Distinguish targeted synthetic challenge sets from representative samples. Active selection of hard cases helps improve checks but changes sampling; it cannot silently become an estimate of production prevalence. Treat correlated cases through an explicit grouping/sampling strategy or report that the uncertainty assumptions are unsupported.

Keep policy fitting and final validation separate. Repeated tuning after inspecting a holdout turns it into development data; use fresh validation evidence for a new claim. Report practical error bounds and review burden first. Statistical significance is an optional analysis with a declared method, not a marketing label or an automatic release gate.

Numerical policy tuning is not synonymous with probability calibration. v0 measures decision performance and selects an abstention policy. It must not claim that a provider's 0.9 output means 90% correctness without a separately evaluated probability-calibration procedure.

## 8. Profiles, inspection, and promotion

A profile is generated JSON with a human-readable summary. It contains:

- Profile schema version, ID, content hash, and intended use.
- Check-definition hash and the exact per-check evaluator bindings.
- Provider/model identifiers, resolved versions, adapter version, translated prompts, and preprocessing identity.
- Decision-rule family, numerical parameters, and effective execution configuration.
- Calibration-plan hash, dataset/split hashes, label provenance, evaluation-report references, and statistical method.
- Observed performance, uncertainty, sample counts, per-slice limitations, and qualification status.

Keep credentials and private case content outside profiles. Refer to host-controlled snapshots when replay is required.

Qualification is `unvalidated`, `insufficient_evidence`, `criteria_not_met`, or `validated_for_scope`. An exploration profile uses an explicit starter policy, is marked unvalidated, and works only in evaluation or shadow mode. It lets a developer try the library before collecting labels without presenting initial thresholds as trustworthy.

`calibrate` produces a candidate profile and report even when goals cannot be established, with the appropriate status. If several feasible policies exist, use the plan's explicit optimization objective and tie-break rules. No feasible candidate is a valid result.

A profile may be selected for enforcement only when it is compatible with the loaded checks and validated for the declared scope. Its qualification flag is not an authenticated approval. The host controls trusted profile files and selects a specific reviewed hash through its normal code/configuration review. Runtime validation verifies content consistency and required report references, not the truth of a forged dataset.

The retained-evidence check verifies the artifacts behind one selected profile. The host states the explicit locations of its retained plan, dataset metadata, and dataset records. The check compares every recorded identity with the computed identity of the retained copy. One drift fails with `hash_mismatch`; one swapped definition binding fails with `definition_mismatch`. The check reads no report file and changes nothing, so one ignored folder holds no required copy of the evidence.

Changing question wording, criteria, schema, input projection, preprocessing, model, prompt translation, evaluator code, or relevant tool behavior invalidates the prior qualification. A model alias resolving to a different model is detected and cannot silently reuse an enforcement profile. Policy-only changes can reuse compatible stored assessments for fitting, but still require independent validation before promotion. Scope changes require new evidence; hashes alone cannot detect population drift.

`revise` implements the policy-only path. It refuses one changed definition, evaluator, adapter, translation, model, preprocessing, or input before any replay. It replays the stored assessments under one revised candidate from one revision plan, records one new profile, and edits no stored one. The validation split that the prior claim consumed is development data, so one new qualification claim needs fresh independent evidence.

Inspection has two levels:

```text
Intervention profile
Intended use: proposed interventions in the evaluated conversation population
Readiness: insufficient evidence
Reason: too few reviewed examples in the later-correction slice

Show details: exact rules, evaluator versions, datasets, counts, intervals
```

Summaries cite report fields. No illustrative performance number should be presented as a measured result.

## 9. Reports and application decisions

Each check returns `pass`, `fail`, `review`, `error`, or `skipped`:

- **Pass:** The assessment meets the check's acceptance meaning under the selected profile.
- **Fail:** It meets an unacceptable meaning under that profile.
- **Review:** The evidence or assessment does not support an automatic decision.
- **Error:** Execution or validation failed.
- **Skipped:** The check was not attempted, with a specific reason.

All checks are required in v0. Run them all; do not introduce cost-based short-circuiting. Overall outcome is fail if any check fails, otherwise error if any errors, otherwise review if any reviews or skips, otherwise pass. Always expose all component outcomes, including errors accompanying a fail. Completion status remains separate from the aggregate outcome.

An illustrative report:

```text
Intervention review

PASS    An earlier decision is being contradicted
PASS    Our message accurately describes the evidence
FAIL    We are adding something new
        The conversation already acknowledges this concern.
PASS    The concern warrants an interruption

Overall: FAIL
The candidate intervention repeats an acknowledged concern.

Details: evidence references · measurements · profile · evaluation history
```

This may be a successful quiet outcome for Cassandra. Pass means the proposal meets these checks; it never authorizes sending or bypasses other application policy. A serious consequence cannot compensate for an unsupported message.

Reports include stable case/check IDs, definition/profile/input hashes, raw assessments, applied rules, operational status, actual evaluator versions, timing, usage, and sanitized error reasons. A hash identifies content, not bit-for-bit reproducibility of stochastic behavior.

Default explanations use check criteria and the executed policy. Jev does not produce a bespoke textual rationale. Future generated explanations are labeled as such and cannot replace the measurements. Supplied source references are not presented as evaluator-selected support unless the evaluator actually returns validated references.

## 10. Evaluation, shadow runs, and comparisons

JSONL cases contain stable IDs, inputs, reference per-check answers or scale levels, expected policy outcomes where labeled, optional overall outcomes, slice/group tags, and label provenance. Keep policy labels consistent with the check's acceptance semantics; conflicts require review. Ambiguous reference cases may be labeled review. Dataset metadata records intended population, sampling method, revision, and label guidelines.

Evaluation reports include per-case results, confusion matrices, review rate, automatic coverage, errors, skips, latency, and usage. In particular, distinguish:

- **False acceptance rate:** Predicted passes among reference fail/review cases.
- **Error among accepted cases:** Reference fail/review cases among predicted passes.
- **False rejection rate:** Predicted failures among reference pass cases.

Every rate includes counts and denominators. Operational failures remain visible over all attempts. Missing labels are excluded only from metrics requiring those labels, with coverage reported explicitly. Zero denominators are unavailable. Evaluate the complete check set as well as individual checks; multiple apparently good checks do not establish aggregate reliability.

Shadow mode records the new outcome alongside the existing decision without performing application actions. Baseline agreement is not accuracy. Export disagreements and a reproducible sample of agreements for review; retain their sampling provenance. Audit baseline passes and silent cases too, not only suspicious cases.

An awaited shadow call can add latency. Use the host's existing durable queue for nonblocking work. v0 does not start detached jobs or provide a background scheduler. Shadow errors and skips do not alter the existing decision path.

Compare profiles on matching case IDs and input hashes. Expose missing, changed, errored, and skipped cases. Show quality, coverage, latency, and cost tradeoffs with actual changed cases. Keep profile fitting comparisons distinct from independent validation evidence. New measurements are required when evaluator behavior or inputs change.

Normal execution is reporting-only too: the host explicitly consumes a report. Enforcement integrations must handle all outcomes and operational failures; errors and skips never become passes. Promotion means selecting a reviewed profile, not enabling an autonomous action mechanism inside the library.

## 11. Small CLI and file layout

```text
.measuretwice/
  checks/intervention.ts        Readable TypeScript requirements and TypeBox inputs
  definitions/intervention.json Optional export for the CLI or another language
  cases/intervention.jsonl      Labeled examples with provenance
  calibration-plan.json         Goals, sampling, and evaluation procedure
  profiles/intervention.json    Evaluator bindings and measured decision policy
  reports/                      Generated evaluations and comparisons
  README.md                     Local usage instructions
```

Use `.measuretwice/` as the project convention. Explicit paths remain supported; this is not an external industry standard.
Commit definitions, shareable cases, and selected profiles. Ignore generated reports by default.
Retain qualification evidence referenced by selected profiles in an explicitly managed location.
Public examples belong in `examples/`; project development checks belong in `.measuretwice/`.

The library workflow imports TypeScript definitions directly. JSON export is optional for CLI use, inspection, or exchange with another language.
A trusted application script can serialize the result of `defineChecks` with `JSON.stringify` and write it through Node file APIs.
Hash canonical content through the Rust core; JSON formatting does not establish a content hash.

The CLI accepts JSON data files. It does not evaluate TypeScript modules or load YAML.
The following commands assume that the application has exported the definition to the shown path.

```bash
measuretwice validate .measuretwice/definitions/intervention.json
measuretwice calibrate .measuretwice/definitions/intervention.json --plan .measuretwice/calibration-plan.json --out .measuretwice/profiles/candidate.json
measuretwice run .measuretwice/definitions/intervention.json --profile .measuretwice/profiles/candidate.json --case example.json --mode shadow
measuretwice evaluate .measuretwice/definitions/intervention.json --profile .measuretwice/profiles/candidate.json --cases .measuretwice/cases/holdout.jsonl --out .measuretwice/reports/candidate.json
measuretwice compare .measuretwice/reports/baseline.json .measuretwice/reports/candidate.json
measuretwice inspect .measuretwice/profiles/candidate.json
```

The calibration plan references fitting and validation datasets and registered evaluator configuration. The same operations exist in the library.
`calibrate` performs frozen-candidate validation. A later `evaluate` can assess independent data; it does not silently change profile qualification.
`inspect` starts with a readable summary and offers numerical details. Reports are JSON with terminal/Markdown renderers.

A starter example includes an explicitly unvalidated exploration profile. A calibration tutorial follows the first shadow run.
Users do not hand-author numerical profiles. No command installs or invokes an unrestricted authoring agent.

## 12. Runtime boundaries

- Validate definitions, profiles, and inputs before execution; reject incompatible bindings.
- Pass only inputs declared in `using`. Batch Jev questions only if their authorized projected state is identical. The flagship example deliberately uses different projections, so it may require multiple calls.
- Bound concurrency, pending work, retries, and total execution time. Saturation produces skipped records. Deadlines cover queue time, attempts, and backoff; cancellation is supported.
- Configure SDK retries once. Expose partial failures without turning them into semantic results.
- Reject oversized evidence rather than silently truncating it.
- Do not combine unrelated cases or access scopes into shared model state.
- Treat supplied messages as untrusted evidence. Exact operations and application permissions remain in code.
- Store no raw case content by default. The host controls source snapshots, report persistence, and retention of sensitive metadata. Calibration/evaluation files containing examples are explicitly supplied local artifacts.
- Profiles never contain credentials. Use the host's credential mechanism and allowlisted evaluator registration.
- Multiple checks or models using the same sources are not independent evidence. Source completeness and real-world truth are outside the claim established by an input-bound assessment.

## 13. Cassandra pilot and benchmark

Start with memory support as the minimal example, then evaluate the full intervention-review workflow. Cassandra supplies original sources, bounded recent context, and candidate text; it retains responsibility for retrieval completeness, citations, freshness, permissions, attention eligibility, memory lifecycle, cooldowns, approval mode, and delivery.

Begin in shadow mode. Fit and validate on separately reviewed cases before considering enforcement. Track interpretation errors caught, valid proposals rejected, missed useful interventions, review effort, latency, cost, and maintenance effort. Baseline silence is not sufficient evidence that a new proposed intervention is wrong.

Ship a public synthetic challenge set with human-reviewed labels and no private Discord content. Cover decisions versus suggestions, negation, attribution, intentional changes, delayed corrections, duplicate concerns, partial support, missing context, embedded instructions, consequence levels, and relevant languages. Label component answers as well as final outcomes. Publish methodology, hashes, versions, and failures.

The challenge set demonstrates behavior on those cases. Production qualification requires representative evidence for the intended deployment and explicit sampling assumptions. Do not turn a small synthetic benchmark into a universal reliability claim.

Compare integration and maintenance effort against Jev's SDK used directly. A second unrelated application should test portability before adding more abstractions.

### Development checks

Use the [development checks](.measuretwice/README.md) while building the MVP.
They compare examples with contracts and performance claims with evidence.
The initial files contain draft definitions and synthetic cases with agent-proposed labels.
They have no live evaluation results or calibrated profiles.
Use them for manual review and future shadow experiments. Keep independent software tests and formal models.

## 14. v0 scope and implementation sequence

Ship:

- A small shared Rust core, a Node binding, and one public TypeScript package with a CLI.
- TypeScript authoring with TypeBox, portable JSON contracts, and published schemas. YAML is outside v0.
- Prebuilt native packages for the declared Node platform matrix, with clean-install tests.
- Deterministic rules and a Jev evaluator using Choice, Noul, and Score behind the portable interface.
- A small evaluator extension contract and a fake/label-only adapter used to test independence from Jev.
- Versioned exploration and calibrated profiles, compatibility checks, and progressive inspection.
- Bounded numerical policy fitting, explicit statistical analysis, held-out validation, and qualification reporting.
- Coding-agent guides for authoring, labeling assistance, calibration, and proposed improvements.
- Evaluation, shadow comparison, JSONL review exchange, and readable reports.
- Memory and intervention examples, a public challenge set, and a Cassandra adapter example.

Defer additional production backends, a built-in generative agent service, unrestricted tool execution, YAML authoring, browser/edge runtimes, probability-recalibration models, Bayesian planning, a formal-verification evaluator, automatic claim extraction, general workflow orchestration, hosted dashboards, marketplaces, and cryptographic approval infrastructure.

Python follows this TypeScript test MVP as the next SDK delivery. Plan its shared contracts and fixtures now; do not ship two public SDKs in the pilot.

Implement in this order:

1. Freeze the portable contracts, TypeBox schema subset, readable TypeScript examples, and cross-language conformance fixtures.
2. Implement a vertical slice through Rust and the Node binding. Validate inputs, run an exact rule, and return a report.
3. Verify native packaging on the declared Node targets before expanding the API.
4. Add Jev translation, bounded execution, exploration profiles, evaluation, and the Cassandra shadow integration.
5. Add Rust calibration calculations, independent validation, qualification, and profile inspection.
6. Exercise the complete workflow with Cassandra and review the TypeScript API with a new developer.
7. Add the Python wrapper and packaging next. Require the shared conformance suite before release.

Calibration is required for the complete MVP, but the exploration path should be useful before a user has enough evidence to qualify a profile.

## 15. Acceptance criteria

1. A human can explain the flagship checks and acceptable outcomes without learning Jev primitives or numerical thresholds.
2. A coding agent can draft valid definitions and proposed examples from the published guide; provenance distinguishes its suggestions from human labels.
3. TypeBox-authored definitions and equivalent JSON produce identical validated content and Rust hashes, including scale order.
   The same fixtures become mandatory for the Python SDK.
4. All three Jev primitives are exercised with no backend SDK types in the public check definition.
5. Tests cover TypeBox conversion, the native boundary, JSON schemas, exact rules, translations, policy cutoffs, composition, cancellation, deadlines, retries, concurrency, and partial failures.
6. Statistical tests verify metric denominators, uncertainty calculations, grouped/split data handling, minimum evidence requirements, candidate selection, and insufficient-evidence outcomes against known fixtures.
7. A profile binds exact definitions, translations, evaluator versions, and numerical rules. Any material mismatch is caught before enforcement.
8. Replacing Jev with a test evaluator preserves check meaning while requiring an independently qualified profile. Missing confidence remains missing.
9. Unvalidated profiles can run in shadow mode but cannot be selected for enforcement. Shadow failures do not change the host's existing decision.
10. A live opt-in benchmark records the resolved model version and actual errors; ordinary tests spend no API budget.
11. One documented journey covers draft, reviewed cases, calibration, shadow operation, inspection, revision comparison, and explicit promotion.
12. A new developer can integrate an exploration shadow run in one working session. Production qualification is allowed to take longer because it depends on evidence.
13. TypeScript authoring preserves useful input inference and rejects unknown input names. Unsupported executable definitions fail explicitly.
14. Native packages install and run without a Rust toolchain on every declared supported target.
15. Rust contains the shared decision and statistical implementation. Wrapper tests verify the runtime behavior that Rust does not own.

The usability test is to hand someone the check file and a report without an architecture lecture. They should understand the requirement, supplied evidence, outcome, and next step. The advanced view must let a developer trace that same outcome to exact measurements and an evaluated policy.

## References

- [TypeBox](https://github.com/sinclairzx81/typebox)
- [NAPI-RS](https://napi.rs/)
- [PyO3](https://pyo3.rs/)
- [maturin](https://www.maturin.rs/)
- [Original checks architecture](research/03-checks-yaml-architecture.md)
- [Positioning and evaluation research](research/04-positioning-response.md)
- [Research index](research/index.md)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [Choice](https://docs.typesafe.ai/primitives/choice)
- [Noul](https://docs.typesafe.ai/primitives/noul)
- [Score](https://docs.typesafe.ai/primitives/score)
- [Batched questions](https://docs.typesafe.ai/patterns/fan-out)
- [Confidence semantics](https://docs.typesafe.ai/confidence)
- [Model versions and limits](https://docs.typesafe.ai/models)
- [Citation-checking cookbook](https://docs.typesafe.ai/cookbooks/citation_check)
- [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

External API details were checked during the design discussion on 23 September 2026. Verify SDK contracts and service limits when implementation begins. Task T024 verified the Jev SDK contract on 24 September 2026 and pinned `@typesafe-ai/sdk` to 0.6.0; the verified record is [providers/jev/README.md](providers/jev/README.md).
