# measuretwice — MVP specification

Status: Draft  
Date: 23 September 2026  
Target: v0 · YAML and TypeScript · Jev first · Apache-2.0

## 1. Purpose

**Write what good looks like. Let AI help build and calibrate the checks. Understand the results before relying on them.**

measuretwice is a library and small CLI for introducing semantic checks into applications. Humans read the requirements in a check file. Evaluators assess cases. A separately evaluated profile determines when an assessment is reliable enough to use. Reports make the outcome and its basis inspectable.

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
- YAML and TypeScript express the same data and have the same semantics.
- AI produces reviewable files, examples, analyses, and diffs. It never silently changes the meaning of an approved requirement.
- Preserve model-specific measurements without presenting them as universal confidence scores.
- Keep evaluators replaceable. Changing one requires new evaluation, not a rewrite of the requirement.
- Keep exact checks, statistical calculations, and authorization in ordinary code.
- Introduce only checks, cases, and reports in the getting-started guide. Explain profiles when the user moves from experimentation to reliance.
- Make the common integration small. Keep numerical details, resource settings, and diagnostic metadata available through progressive disclosure.

This specification preserves the readable, AI-assisted check-authoring workflow in the [original architecture](research/03-checks-yaml-architecture.md). It adds calibration profiles, shadow runs, and revision comparisons. Bayesian inference and adaptive investigation are deferred.

## 3. Four responsibilities

| Layer | Responsibility | Artifact |
| --- | --- | --- |
| Check | Express the question, evidence, and acceptable outcomes. | YAML or a serializable TypeScript definition |
| Evaluator | Translate and execute a check using a model or deterministic method. | A registered adapter and versioned translation |
| Calibration profile | Bind an evaluator and decision rules to measured performance on a declared population. | Generated, versioned JSON plus an explanation |
| Report | Preserve the assessment, decision, evidence references, and operational result. | Structured record and readable rendering |

A case supplies the artifact and evidence. A labeled case additionally supplies reference answers and their provenance. The profile is a durable output of calibration, not a live AI judgment made on every request.

All APIs and file formats below are proposed interfaces, not published implementations.

## 4. The readable check file

The flagship example assesses a proposed intervention. A prior decision requires customer exports to remain in the EU; a new conversation proposes moving an export worker to a US region. The application supplies the original evidence, current discussion, and drafted message.

```yaml
# intervention.checks.yaml
version: 1
name: intervention-review
when_uncertain: review

inputs:
  prior_decision: { type: string, minLength: 1 }
  conversation: { type: string, minLength: 1 }
  proposed_message: { type: string, minLength: 1 }

checks:
  - id: decision-conflict
    name: An earlier decision is being contradicted
    using: [prior_decision, conversation]
    question: How does the new proposal relate to the earlier decision?
    answers:
      conflict: It conflicts with a decision that still applies.
      replaced: The team explicitly replaced the earlier decision.
      aligned: It is compatible with the earlier decision.
      unclear: Applicability or the relationship cannot be established.
    accept: conflict
    review: unclear

  - id: message-supported
    name: Our message accurately describes the evidence
    using: [prior_decision, conversation, proposed_message]
    question: Does every material claim in the proposed message follow from the evidence?
    answers:
      supported: All claims are supported with appropriate certainty and attribution.
      contradicted: A material claim conflicts with the supplied evidence.
      incomplete: Support for a material claim is missing or ambiguous.
    accept: supported
    review: incomplete

  - id: adds-information
    name: We are adding something new
    using: [conversation, proposed_message]
    question: Has the conversation already acknowledged this concern?
    answers:
      "yes": A participant explicitly recognizes this specific concern.
      "no": No supplied message explicitly recognizes this specific concern.
    accept: "no"

  - id: consequence
    name: The concern warrants an interruption
    using: [prior_decision, conversation, proposed_message]
    question: What consequence does this concern have, based on the evidence?
    scale:
      - minor: A wording or preference difference with no identified operational consequence.
      - meaningful: A coordination problem causing rework or delay.
      - serious: A conflict affecting an explicit customer commitment or operational requirement.
    accept:
      at_least: meaningful
```

The reader sees what is being asked, which evidence is available, and what counts as acceptable. Jev primitive names and confidence thresholds are absent. The scale uses an ordered list so its ordering survives parsing and canonicalization.

Exact requirements can use a rule instead of a question:

```yaml
id: message-length
name: The message fits our delivery limit
using: [proposed_message]
rule:
  maxLength: 900
```

That number belongs in the check because it expresses a product requirement. A model-confidence cutoff belongs in the profile because it expresses how a measurement is interpreted.

### Definition semantics

- Each check has a stable `id`, a readable `name`, and a nonempty `using` list referring to declared inputs.
- Each check has exactly one of `question` or `rule`.
- Questions have either named `answers` or an ordered `scale`, never both.
- Exactly two answer keys, `yes` and `no`, declare a binary question. Use explicit descriptions to resolve domain ambiguity. Other answer sets are categorical.
- `accept` selects one or more answer labels; `review` optionally selects disjoint labels. Remaining labels are unacceptable. Scale checks use `accept.at_least` to identify the first acceptable level; all higher levels are also acceptable.
- `when_uncertain: review` is the only uncertainty behavior in v0. It defaults to review when omitted.
- Acceptance describes the required meaning. It does not declare a numerical threshold or a probability that the requirement is met.
- Unknown labels, duplicate IDs, overlapping accept/review sets, invalid scales, and empty check sets are definition errors.
- Inputs use a documented JSON Schema subset for strings, numbers, booleans, arrays, and objects. Declared top-level inputs are required; extra top-level inputs are rejected. Nested objects declare their own required properties.
- Parse YAML 1.2 safely, reject duplicate mapping keys and arbitrary tags, and never execute embedded code. Runtime input validation is mandatory.
- Initial exact rules are `maxLength`, `includes`, and `excludes` on one string input. Document Unicode and matching semantics. They require no statistical calibration.

## 5. TypeScript and application integration

TypeScript constructs the same serializable definition. It does not expose Jev SDK classes:

```ts
import { defineChecks, load } from "measuretwice";

const checks = defineChecks({
  version: 1,
  name: "novelty-review",
  when_uncertain: "review",
  inputs: {
    conversation: { type: "string" },
    proposed_message: { type: "string" },
  },
  checks: [{
    id: "adds-information",
    name: "We are adding something new",
    using: ["conversation", "proposed_message"],
    question: "Has the conversation already acknowledged this concern?",
    answers: {
      yes: "A participant explicitly recognizes this specific concern.",
      no: "No supplied message explicitly recognizes this specific concern.",
    },
    accept: "no",
  }],
});

const reviewer = await load(checks, {
  profile: "profiles/novelty-production.json",
});
```

The equivalent YAML integration is:

```ts
import { load } from "measuretwice";

const reviewer = await load("intervention.checks.yaml", {
  profile: "profiles/intervention-production.json",
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

`defineChecks` provides editor guidance, type inference where possible, and runtime validation. Equivalent YAML and TypeScript produce identical canonical definitions and hashes. Applications import trusted TypeScript normally; the CLI does not execute arbitrary TypeScript files.

The main API is `defineChecks`, `load`, `run`, `calibrate`, `evaluate`, and `compare`. Profile and report inspection are methods/helpers on those artifacts, not another orchestration framework.

## 6. Evaluators and Jev

The evaluator contract receives a validated question, the exact projected inputs authorized by `using`, an execution budget, and a cancellation signal. It returns a typed assessment or an execution error.

An assessment identifies the answer kind and preserves the backend's actual output: a label, a binary value, an ordered score, optional distributions, optional confidence, and optional evidence references. Unsupported measurements are absent, never invented. Raw provider confidence remains distinct from empirical evaluation evidence.

The first semantic evaluator uses the official TypeSafe SDK:

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
5. **Fit:** Run the evaluator on development cases. Statistical code searches the bounded policy family against the agreed objectives.
6. **Validate:** Freeze the candidate and evaluate it on held-out cases. Compute counts, intervals, slice results, and goal satisfaction in code.
7. **Explain:** Produce a plain-language account of errors, review burden, uncertainty, and missing evidence, linked to calculated metrics.
8. **Propose:** Write a profile and comparison for review. Never promote a revision automatically.

The larger model may propose changes and explain results. It cannot assert statistical significance, invent metrics, treat its own labels as human judgments, weaken goals to qualify a candidate, or quietly tune against the holdout.

### Goals and statistical evidence

Goals are separate from both check meaning and provider configuration. A versioned plan declares the target population, error metric and denominator, allowed error bounds, desired review/coverage tradeoffs, confidence level, required sample counts, important slices, dataset splits, and the candidate policy family. There are no universally safe default error tolerances.

For example, the owner might prioritize limiting incorrect interventions among accepted candidates, then minimize human review subject to that constraint. The plan must specify whether this refers to error among accepted cases or acceptance among unacceptable cases; those are different quantities.

Use tested statistical routines for uncertainty intervals. Record their method, assumptions, and confidence level. Where appropriate, qualification compares an upper error bound with the declared limit, rather than comparing the observed error rate alone. Zero observed errors is not proof of zero risk. Small or missing denominators yield insufficient evidence.

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

Changing question wording, criteria, schema, input projection, preprocessing, model, prompt translation, evaluator code, or relevant tool behavior invalidates the prior qualification. A model alias resolving to a different model is detected and cannot silently reuse an enforcement profile. Policy-only changes can reuse compatible stored assessments for fitting, but still require independent validation before promotion. Scope changes require new evidence; hashes alone cannot detect population drift.

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
  checks/intervention.yaml      Human-readable requirements
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

The coding agent helps create and maintain these files. Users should not need to hand-author numerical profiles.
The following commands run from the project root.

```bash
measuretwice validate .measuretwice/checks/intervention.yaml
measuretwice calibrate .measuretwice/checks/intervention.yaml --plan .measuretwice/calibration-plan.json --out .measuretwice/profiles/candidate.json
measuretwice run .measuretwice/checks/intervention.yaml --profile .measuretwice/profiles/candidate.json --case example.json --mode shadow
measuretwice evaluate .measuretwice/checks/intervention.yaml --profile .measuretwice/profiles/candidate.json --cases .measuretwice/cases/holdout.jsonl --out .measuretwice/reports/candidate.json
measuretwice compare .measuretwice/reports/baseline.json .measuretwice/reports/candidate.json
measuretwice inspect .measuretwice/profiles/candidate.json
```

The calibration plan references fitting and validation datasets and registered evaluator configuration. The same operations exist in the library. `calibrate` performs the frozen-candidate validation step; a later `evaluate` command can assess a new independent dataset and does not silently update the profile's qualification. `inspect` defaults to a readable summary with an option for exact numerical details. Reports are JSON with terminal/Markdown renderers.

A starter example includes an explicitly unvalidated exploration profile. A full calibration and enforcement tutorial follows after the first successful shadow run. No CLI command installs or invokes an unrestricted authoring agent.

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

- One TypeScript package and CLI with readable YAML/TypeScript definitions and published schemas.
- Deterministic rules and a Jev evaluator using Choice, Noul, and Score behind the portable interface.
- A small evaluator extension contract and a fake/label-only adapter used to test independence from Jev.
- Versioned exploration and calibrated profiles, compatibility checks, and progressive inspection.
- Bounded numerical policy fitting, explicit statistical analysis, held-out validation, and qualification reporting.
- Coding-agent guides for authoring, labeling assistance, calibration, and proposed improvements.
- Evaluation, shadow comparison, JSONL review exchange, and readable reports.
- Memory and intervention examples, a public challenge set, and a Cassandra adapter example.

Defer additional production backends, a built-in generative agent service, unrestricted tool execution, Python, probability-recalibration models, Bayesian planning, formal verification, automatic claim extraction, general workflow orchestration, hosted dashboards, marketplaces, and cryptographic approval infrastructure.

Implement in this order:

1. Freeze the portable check, case, assessment, and report contracts with the readable examples.
2. Implement exact rules, Jev translation, bounded execution, and exploration profiles.
3. Add labeled evaluation, comparison, and the first shadow integration.
4. Add the bounded calibration routine, statistical validation, profile qualification, and inspection.
5. Exercise the complete AI-assisted workflow with Cassandra and refine ergonomics before release.

Calibration is required for the complete MVP, but the exploration path should be useful before a user has enough evidence to qualify a profile.

## 15. Acceptance criteria

1. A human can explain the flagship checks and acceptable outcomes without learning Jev primitives or numerical thresholds.
2. A coding agent can draft valid definitions and proposed examples from the published guide; provenance distinguishes its suggestions from human labels.
3. Equivalent YAML and TypeScript definitions produce identical canonical content and hashes, including scale order.
4. All three Jev primitives are exercised with no backend SDK types in the public check definition.
5. Tests cover schema/parser boundaries, exact rules, translations, policy cutoffs, uncertain answers, composition, cancellation, deadlines, retries, concurrency, and partial failures.
6. Statistical tests verify metric denominators, uncertainty calculations, grouped/split data handling, minimum evidence requirements, candidate selection, and insufficient-evidence outcomes against known fixtures.
7. A profile binds exact definitions, translations, evaluator versions, and numerical rules. Any material mismatch is caught before enforcement.
8. Replacing Jev with a test evaluator preserves check meaning while requiring an independently qualified profile. Missing confidence remains missing.
9. Unvalidated profiles can run in shadow mode but cannot be selected for enforcement. Shadow failures do not change the host's existing decision.
10. A live opt-in benchmark records the resolved model version and actual errors; ordinary tests spend no API budget.
11. One documented journey covers draft, reviewed cases, calibration, shadow operation, inspection, revision comparison, and explicit promotion.
12. A new developer can integrate an exploration shadow run in one working session. Production qualification is allowed to take longer because it depends on evidence.

The usability test is to hand someone the check file and a report without an architecture lecture. They should understand the requirement, supplied evidence, outcome, and next step. The advanced view must let a developer trace that same outcome to exact measurements and an evaluated policy.

## References

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

External API details were checked during the design discussion on 23 September 2026. Verify SDK contracts and service limits when implementation begins.
