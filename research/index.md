# Research and design notes

**Status: historical record, written before the current specification.**
These notes describe one planned Apache-2.0 Python library and CLI named
measuretwice. The delivered v0 is TypeScript-first with a shared Rust core,
and Python follows the TypeScript pilot. [MVP_SPEC.md](../MVP_SPEC.md)
controls the current scope, and it replaces these proposals where the two
disagree. Each document keeps its original wording as a research record.

## Reading order

The numbers give the order in which the documents make most sense. The order follows how the documents reference each other: the report came first, the positioning response cites both the report and the YAML design, and the formal-verification text builds on the check abstraction that the earlier documents define.

| # | File | Was | Contents |
|---|------|-----|----------|
| 1 | [01-prior-art-landscape-report.md](01-prior-art-landscape-report.md) | `3.md` | External research report on prior art and competitors. It surveys six interpretations of an unspecified idea. It finds a mature landscape for uncertainty-aware, adaptive information gathering: GeNIe, Pyro OED, EDDI, Elicit, RISELENS, and patents from 2005–2013. It concludes the broad concept is not new, and points at integration and implementation as the possible opening. |
| 2 | [02-use-case-examples.md](02-use-case-examples.md) | `5.md` | Six cross-domain use cases with code and diagrams: integration troubleshooting, supplier research, review of AI-generated work, support exception handling, invoice extraction, and incident response. All six reduce to one small grammar: `read()` → `observe()` → `ask()`/`choose()` → `check()`/`act()` → repeat. |
| 3 | [03-checks-yaml-architecture.md](03-checks-yaml-architecture.md) | `4.md` | The core architecture. A strong "author" model drafts provider-neutral `checks.yaml`; a human approves it; cheap graders run it at scale. Defines three check kinds (deterministic, semantic, belief), the sensor/calibration step that turns a grader result into probabilistic evidence, the draft/approve/run/evaluate lifecycle, and the CLI grammar. |
| 4 | [04-positioning-response.md](04-positioning-response.md) | `1.md` | The response to the prior-art report. It accepts that the methods are established and that Promptfoo and Inspect already cover much of the check-authoring workflow. It shifts the product claim to reviewed, evaluated check packages, lists concrete design changes (typed check meanings, hash-bound approval, grader-swap recalibration, robustness in v1, precise stopping reasons), and sets next deliverables: a comparative prototype, a separating benchmark, and a release gate. |
| 5 | [05-formal-verification-extension.md](05-formal-verification-extension.md) | `2.md` | How formal verification (Lean, TLA+) extends the design without a pivot. A check becomes a claim plus a verification method; results get typed outcomes (`proof_checked`, `model_checked`, `counterexample`, …) instead of PASS/FAIL; correspondence between model and code stays a tracked human responsibility. Recommends the project's own execution subsystem as the first pilot. |

## Assets

- [checks-field-manual.html](checks-field-manual.html) — "The Checks Field Manual", a self-contained HTML page (inline styles and scripts). Saved from an AXINBOX drop.
- [moodboard.png](moodboard.png) — visual moodboard for the project.
