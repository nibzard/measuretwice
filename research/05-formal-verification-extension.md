**It relates very directly to MeasureTwice. The proposal describes a formal-verification version of the workflow we have been designing: AI drafts the checks, humans approve what must be true, and an independent mechanism evaluates the result.**

The important extension is:

> **Not every check should be graded by a language model. Some should be executed by a test runner, a model checker, or a proof checker.**

That does not replace our architecture. It makes the provider-and-extension design more useful—and sharpens what a MeasureTwice “check” actually means.

## 1. The shared idea: separate authoring from verification

The supplied proposal is not fundamentally “ask AI whether the software is correct.” It is:

**Ask AI to construct something that an established formal tool can check.**

That maps onto our current design almost exactly:

| The supplied proposal                                     | Its place in MeasureTwice                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| Write required properties in ordinary language            | Human-readable claims in `checks.yaml`                            |
| AI writes candidate models and proofs                     | The smart authoring provider creates supporting artifacts         |
| Humans approve the specification and modeling assumptions | Review of the claim, its formal translation, and its scope        |
| Lean or TLA+ tooling checks the artifacts                 | Optional verification extensions                                  |
| Failures are triaged before production changes            | Structured findings and a review workflow                         |
| AI proposes fixes and regression tests                    | An optional repair workflow, separate from approval               |
| Proofs are rerun and model drift is tracked               | Versioned checks, artifacts, results, and dependency invalidation |

The shared principle is **AI proposes; another mechanism checks; humans retain authority over the requirements and changes.**

For Lean, the independent checking mechanism is concrete: tactics produce proof terms that Lean’s kernel checks. The author of a proof can therefore be an AI without making the AI’s opinion the verification result. ([Lean Language][1])

### The architecture becomes broader than “smart model plus cheap model”

```text
               Requirements + project + examples
                              |
                              v
                      Smart author model
                              |
                              v
                Draft claims and check artifacts
                              |
                              v
                         Human review
                              |
                              v
                     Approved check bundle
                              |
             +----------------+----------------+
             |                |                |
             v                v                v
        Semantic check   Executable test   Formal check
             |                |                |
             v                v                v
        Jev / grader      Test runner      Lean / TLC
             |                |                |
             v                v                v
         Assessment       Test result     Proof result /
                                          model-check result
             |                |                |
             +----------------+----------------+
                              |
                              v
                     MeasureTwice report
                  preserves each result's meaning
```

**Jev remains valuable. It is simply not the verifier for every kind of claim.**

---

## 2. The biggest conceptual improvement: a check is a claim plus a verification method

Until now, we have sometimes used *check* to mean “a question sent to a grader.”

The formal-proof proposal suggests a stronger abstraction:

```text
Check
  |
  +-- Claim:       What should be true?
  |
  +-- Subject:     About which artifact or system?
  |
  +-- Scope:       Under which assumptions and conditions?
  |
  +-- Method:      How will we evaluate the claim?
  |
  +-- Evidence:    What artifacts support the result?
  |
  +-- Policy:      What happens if it fails or remains unresolved?
```

Consider three superficially similar questions:

| Claim                                                                         | Appropriate verification method                             |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| “The design document explains how retries avoid duplicate effects.”           | A semantic grader can assess the supplied document          |
| “This retry test does not apply the operation twice.”                         | An executable test evaluates that scenario                  |
| “No execution admitted by this retry model applies the same operation twice.” | A formal verification method evaluates the modeled property |

These are **different claims**, not merely different confidence levels for the same claim.

A document can describe a correct algorithm while the implementation is wrong. A test can pass while another interleaving fails. A formal result can establish a property of a model that omits a behavior of the production system.

**MeasureTwice should preserve those distinctions rather than collapse everything into a green checkmark.**

---

## 3. What changes about the two-model idea?

Our previous division still works:

```text
Smart model:       writes and improves checks
Cheap grader:     evaluates narrow semantic questions
```

But formal verification adds a third role:

```text
Formal tool:      checks a proof or explores a specified model
```

The smart model might produce Lean definitions, proof attempts, TLA+ specifications, configuration files, and proposed regression tests. It can iterate using tool feedback.

The grader might help organize review comments or identify ambiguous requirements. **It must not decide whether a proof is valid.**

```text
                    FORMAL AUTHORING LOOP

               Approved property + current code
                              |
                              v
                    Smart model proposes
                 model / proof / correction
                              |
                              v
                     Formal tool checks
                              |
                 +------------+-------------+
                 |                          |
                 v                          v
          Accepted result          Counterexample,
                 |                 unfinished proof,
                 |                 or execution error
                 |                          |
                 |                          v
                 |                    Triage finding
                 |                          |
                 |                    New proposal
                 |                          |
                 +--------------------------+
                              |
                              v
                    Human-reviewed artifact
```

This is compatible with our first-version provider decision. **OpenAI Responses can remain the smart authoring integration; Jev remains the semantic assessment integration.** Lean and TLA+ tools would be execution extensions, not additional AI providers.

One economic qualification: formal checking should not be advertised as universally cheap. Proof construction and model exploration have different resource profiles. TLC, for example, explicitly explores states; the configured state space matters. ([Leslie Lamport's Home Page][2])

---

## 4. How this fits the YAML format

**The YAML should describe the verification contract and reference native artifacts. It should not attempt to replace Lean or TLA+ with a new proof language.**

For example, an illustrative extension of our proposed format could look like this:

```yaml
version: measuretwice/v1
name: execution-safety

checks:
  - id: approval_matches_execution
    claim: >
      Every executed operation has authorization for its exact
      arguments and the applicable policy revision.

    subject:
      files:
        - src/executor.py
        - src/authorization.py

    verify:
      using: tla.tlc
      specification: verification/Executor.tla
      configuration: verification/Executor.cfg
      property: ApprovalMatchesExecution

    require:
      result: model_checked
      exploration: complete

  - id: rejected_action_preserves_state
    claim: >
      Rejecting an unauthorized action leaves the business
      state unchanged.

    subject:
      files:
        - src/authorization.py

    verify:
      using: lean
      project: verification/lean
      theorem: Authorization.reject_preserves_state

    require:
      result: proof_checked
      trust_policy: verification/lean-trust.json
```

These are proposed MeasureTwice fields, not an existing schema.

The first check references a TLA+ specification and its configuration. TLC configuration can specify constants, invariants, temporal properties, and restrictions on the explored state space. Those settings are part of what the result means. ([tlapl][3])

The second references a Lean theorem and an explicit trust policy.

The bundle would contain:

```text
checks.yaml                    Human-readable claims and execution contract

verification/
  Executor.tla                 Concurrent-system model
  Executor.cfg                 Configuration and scope
  lean/                        Definitions and proof artifacts
  lean-trust.json              Accepted proof assumptions

review/
  correspondence.md            How the model relates to the implementation
```

A human can start with the readable claim, then inspect the formal statement, assumptions, and correspondence notes. Reading the YAML alone should not be presented as sufficient formal review.

### The same CLI can orchestrate both paths

The existing `draft`, `validate`, `inspect`, `run`, and `explain` grammar still fits.

What changes is what `run` invokes and what its results can honestly say.

Approval should apply to the exact check bundle or revision through the project’s review process. A generated `status: approved` field is not evidence of human approval.

---

## 5. Results need more meaning than PASS or FAIL

This is one of the most important implementation consequences.

I would make verification results typed, with scope and supporting artifacts:

| Result               | Meaning                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| **`assessed`**       | A semantic evaluator returned a judgment                                               |
| **`test_passed`**    | The specified executable tests passed                                                  |
| **`model_checked`**  | The declared model-checking run completed without finding a violation within its scope |
| **`proof_checked`**  | A proof of the specified statement was accepted under the declared trust policy        |
| **`counterexample`** | A violating behavior was found in the checked model                                    |
| **`inconclusive`**   | The attempt did not establish the claim or a violation                                 |
| **`error`**          | The verification process did not run correctly                                         |

Then a separate policy decides whether that result satisfies the project’s acceptance requirements.

### A failed proof attempt is not necessarily a false claim

The supplied proposal correctly says that findings must be triaged between the specification, model, and implementation.

I would add another explicit possibility: **the prover or authoring agent simply did not finish the proof**.

A timeout, missing lemma, or unsuccessful tactic does not establish a software defect. A counterexample is more actionable, but still needs to be checked against the intended model and actual implementation.

### A model-check result is not automatically a general theorem

TLA+ is a specification language. TLC is its explicit-state model checker; TLAPS is a separate proof system. MeasureTwice must report which tool actually ran and what it established. ([Leslie Lamport's Home Page][2])

A complete exploration of a finite configured model can establish a property for that model. It does not automatically establish the property for every possible number of workers, queue sizes, or external-system behaviors.

A report should say something like:

```text
approval_matches_execution

Result:       MODEL_CHECKED
Method:       TLC exhaustive exploration
Scope:        Configuration in Executor.cfg
Completion:   Complete
Code mapping: Human-reviewed correspondence

Not established:
- Correctness outside the configured model
- Formal refinement from production code to this model
```

That is more useful than “99.9% confident the executor is safe.”

---

## 6. The hardest issue is the one the text emphasizes: correspondence

The proposal’s warning about proving the wrong model is central to MeasureTwice.

There are several separate relationships:

```text
Human requirement
        |
        | Does the statement express the intended requirement?
        v
Formal property
        |
        | Was it established under the stated assumptions?
        v
Formal model
        |
        | Does the implementation behave as this model says?
        v
Production implementation
```

Formal proof checking addresses a particular relationship inside that chain. It does not automatically establish every other relationship.

Lean’s own validation guidance explicitly distinguishes the validity of a proof from the meaning of its theorem statement. It also discusses stronger validation for unreviewed AI-generated artifacts. ([Lean Language][4])

### MeasureTwice should track correspondence, not claim to solve it automatically

My proposed product response would be to retain the exact code revision, specification version, formal property, tool configuration, proof dependencies, review record, and declared exclusions.

A relevant change would make the previous **code applicability** record stale. The proof may remain valid for the old model while no longer supporting a claim about the current implementation.

File hashes help detect change. They do not prove semantic correspondence.

Where available, generated implementations, verified translations, or explicit refinement arguments can provide stronger connections. But a manually modeled Python subsystem should be labeled honestly as such.

### The authoring agent must not make its own task easier

When a proof attempt fails, the AI must not silently remove a difficult transition, assume away a failure mode, weaken the theorem, or narrow the model configuration.

Changes to the approved claim or assumptions should be explicit proposals requiring review.

Likewise, “the Lean project built” is not sufficient. Lean supports `sorry` placeholders through `sorryAx`, and proofs can depend on other axioms. An adapter should inspect the actual theorem and its transitive assumptions, rather than merely scan a file for the word `sorry`. ([Lean Language][5])

Formal artifacts also need execution isolation. Lean’s documentation warns that tactics and other metaprograms can perform arbitrary actions; declarative YAML does not make the referenced project safe to build. ([Lean Language][4])

---

## 7. How this relates to our probabilistic reasoning layer

**Formal verification and probabilistic inference are complementary, but their outputs should not be mixed indiscriminately.**

A formal check asks:

> Does this specified property hold in the admitted model?

A probabilistic query asks:

> Given this probabilistic model and these observations, what should we currently believe?

Both depend on the model being appropriate. But they answer different questions.

### Formal properties can protect the uncertainty-handling system

For example, MeasureTwice might maintain uncertainty about whether credentials have expired while enforcing a separate invariant:

> An operation cannot proceed without the authorization required by the policy.

The operation’s expected benefit cannot override that requirement.

Similarly, the system can be uncertain about a diagnosis while requiring that duplicate evidence receipts never be applied twice.

### Probabilistic planning can help prioritize optional investigation

The decision layer could eventually help choose whether to run another diagnostic test, broaden a model-checking configuration, or request a specialist review—provided it has defensible estimates of the costs and possible outcomes.

It must not use those estimates to waive a required proof obligation.

```text
Rules define what cannot be skipped.

Probabilistic decisions optimize within those rules.
```

A checked proof also should not become an arbitrary `0.999` Bayesian observation. The theorem, assumptions, and applicability need to retain their own meaning.

This preserves the original purpose of MeasureTwice: **manage uncertainty explicitly, rather than manufacture certainty by combining unlike signals.**

---

## 8. The best pilot may be MeasureTwice itself

The supplied text advocates a bounded, high-value subsystem rather than verification of an entire product. I would follow that approach.

Our own case-state or execution subsystem offers a focused candidate.

For an execution pilot, the approved claims might be:

| Proposed property                                                  | Why it matters                                      |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| An approval authorizes only its exact operation and arguments      | Prevents reuse after an operation is changed        |
| A rejected operation does not mutate protected state               | Keeps authorization failure separate from execution |
| An outdated case revision cannot silently overwrite a newer one    | Protects concurrent agents from lost updates        |
| An uncertain external outcome is not recorded as confirmed success | Preserves the need for reconciliation               |

An illustrative counterexample could be:

```text
1. Operation A receives approval.
2. Another worker changes its arguments, producing operation B.
3. The executor reuses A's approval.
4. B executes without matching authorization.
```

A model checker could look for that behavior in a declared state machine. A reviewer would then determine whether the production implementation admits the same sequence.

That is the proposal’s loop applied directly:

```text
Claim -> model -> verification -> finding
                                |
                                v
                      Confirm against real code
                                |
                                v
                       Patch + regression test
                                |
                                v
                    Recheck and review correspondence
```

This would test both the usefulness of the integration and the honesty of our reporting.

---

## My recommendation

**Adopt the proposal as an extension of MeasureTwice, not as a pivot into an automatic proof product.**

The immediate architectural change should be to make a check consist of a **claim, scope, verification method, and evidence contract**. The core should preserve typed outcomes. Semantic grading, tests, model checking, and theorem proving can then be independently implemented extensions.

Keep the approachable entry point:

> **Write what must be true. Choose how to check it. Run the checks and inspect the evidence.**

The OpenAI author and Jev grader still provide the initial AI integrations. A formal-methods pilot can add one bounded verification extension without making Lean or TLA+ prerequisites for everyone.

The text strengthens our project most in this respect:

> **MeasureTwice should not ask one kind of model to judge every kind of correctness. It should help people express the claim, select an appropriate checking mechanism, and understand exactly what the result establishes.**

[1]: https://lean-lang.org/doc/reference/latest?utm_source=chatgpt.com "The Lean Language Reference"
[2]: https://lamport.azurewebsites.net/tla/tools.html?utm_source=chatgpt.com "TLA+ Tools"
[3]: https://docs.tlapl.us/using%3Atlc%3Aconfig_file "using:tlc:config_file - TLA+ Wiki"
[4]: https://lean-lang.org/doc/reference/latest/ValidatingProofs/?utm_source=chatgpt.com "Validating a Lean Proof"
[5]: https://lean-lang.org/doc/reference/latest/Axioms/?utm_source=chatgpt.com "Axioms"

