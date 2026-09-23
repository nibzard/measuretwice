A good set of examples should prove that **MeasureTwice is not “Bayesian troubleshooting software.”** The same primitives should work across diagnosis, research, verification, acceptance, and operational decisions.

## 1. Integration troubleshooting

**JTBD:** *When an integration fails, help me determine the most likely cause and choose the cheapest useful diagnostic step before escalating or changing anything.*

```text
            "Sync stopped working"
                     |
                     v
              read symptoms
                     |
                     v
        +-------------------------+
        | Current beliefs         |
        |                         |
        | expired token      35%  |
        | API outage         25%  |
        | bad config         30%  |
        | unknown cause      10%  |
        +------------+------------+
                     |
                 choose()
                     |
          +----------+----------+
          |                     |
          v                     v
   Check credentials      Check service
      cost: low           status: cheap
          |                     |
          +----------+----------+
                     |
             highest value check
                     |
                     v
                 observe()
                     |
                     v
             update beliefs
```

```python
import measuretwice as mt

model = mt.Model("Integration failure")

expired = model.boolean("token_expired", prior=0.35)
outage = model.boolean("service_outage", prior=0.25)

auth_failed = model.boolean(
    "auth_probe_failed",
    given=expired,
    probability={
        False: 0.05,
        True: 0.90,
    },
)

case = model.case()

decision = case.choose(
    goal=mt.Goal.minimize("resolution_cost"),
    checks=[
        mt.Check("check_credentials", observes=auth_failed, cost=0.1),
        mt.Check("check_status_page", observes=outage, cost=0.02),
    ],
)

print(decision.explain())
```

The important part is not ranking root causes. MeasureTwice should tell the application **which observation is worth obtaining next**. If checking credentials will materially change the eventual action while rereading the error log will not, that distinction becomes explicit.

---

## 2. Supplier or company research

**JTBD:** *When evaluating a company or supplier, help me gather only the evidence that could change the decision and distinguish verified facts from unsupported claims.*

```text
        Supplier candidate
               |
               v
       documents + web data
               |
             read()
               |
               v
       +-------------------+
       | Evidence          |
       |                   |
       | ISO cert      ?   |
       | EU factory    yes |
       | capacity      ?   |
       | product fit   82% |
       +---------+---------+
                 |
              choose()
                 |
       Which missing fact matters?
          /            \
         v              v
   verify ISO       verify capacity
     €0.10             €2.00
         \              /
          +-----+------+
                |
        highest decision value
```

```python
import measuretwice as mt
from measuretwice_jev import Jev

jev = Jev(model="jev-1.13.0")

case = supplier_model.case()

reading = await case.read(
    source=mt.Source.url("https://supplier.example/specs"),
    question=mt.YesNo(
        "Does this source explicitly state that the supplier "
        "manufactures this product in the EU?"
    ),
    using=jev,
)

case.observe(
    reading,
    through=eu_manufacturing_sensor,
)

decision = case.choose(
    goal=qualification_goal,
    checks=[
        verify_iso_certificate,
        request_capacity_document,
        inspect_product_catalog,
    ],
)
```

This moves beyond “AI web research.” The system maintains uncertainty about the facts relevant to a decision and stops researching once additional evidence is unlikely to affect the outcome.

It also naturally distinguishes:

```text
not found  ≠  false
claimed    ≠  verified
3 copies of one claim  ≠  3 independent sources
```

---

## 3. Reviewing AI-generated work before release

**JTBD:** *When AI generates something consequential, help me determine whether there is enough independent evidence to release it or whether another check is required.*

```text
         AI-generated proposal
                 |
                 v
              read()
                 |
         +-------+-------+
         |               |
         v               v
  Requirement check   Config check
      passes             passes
         |               |
         +-------+-------+
                 |
          Same source?
              YES
                 |
                 v
       confidence should NOT
          simply multiply
                 |
              choose()
                 |
        verify live config
                 |
                 v
            release / stop
```

```python
import measuretwice as mt

case = release_model.case()

case.observe(
    requirement_match,
    True,
    source=mt.Source.document("proposal-v3"),
)

case.observe(
    config_claim,
    True,
    source=mt.Source.document(
        "proposal-v3",
        derived_from=["customer-config-2026-09-20"],
    ),
)

decision = case.choose(
    goal=release_goal,
    rules=[
        mt.Rule.require(customer_requirements_met),
        mt.Rule.require(configuration_supported),
    ],
    checks=[
        live_configuration_check,
        customer_approval_check,
    ],
)

print(decision.explain())
```

The interesting use case is not “run five LLM critics.” It is understanding whether those critics actually provide **new information**.

If every evaluator relied on the same outdated configuration snapshot, MeasureTwice should represent that dependence rather than manufacture confidence by counting five green checks.

---

## 4. Customer-support exception handling

**JTBD:** *When a support case does not fit the happy path, help me resolve routine uncertainty automatically and escalate only when human judgment is actually valuable.*

```text
              Incoming case
                   |
                 read()
                   |
                   v
         +--------------------+
         | What's happening?  |
         |                    |
         | billing error  60% |
         | user mistake   20% |
         | product bug    15% |
         | other           5% |
         +---------+----------+
                   |
                choose()
                   |
      +------------+-------------+
      |            |             |
      v            v             v
 check account   ask user    human review
   $0.01          costly        $12
      |            |             |
      +------------+-------------+
                   |
           best next step
```

```python
import measuretwice as mt
from measuretwice_openai import OpenAIResponses

openai = OpenAIResponses(model="gpt-6-astra")

case = support_model.case()

ticket = await case.read(
    mt.Source.text(customer_message),
    into=SupportTicket,
    using=openai,
)

case.observe(
    ticket,
    through=support_ticket_sensor,
)

decision = case.choose(
    goal=support_goal,
    actions=[
        issue_credit,
        explain_configuration,
        escalate_engineering,
    ],
    checks=[
        inspect_account,
        inspect_recent_events,
        ask_customer_for_screenshot,
        human_review,
    ],
)
```

This is where the value-of-information idea becomes operationally useful.

A human review should not be the default “uncertain → escalate” branch. It is simply another possible investigation with a cost, delay, reliability profile, and potential value.

Sometimes a 10 ms database lookup eliminates the need for the human entirely.

---

## 5. Data extraction with targeted verification

**JTBD:** *When extracting structured data from messy documents, help me verify only the fields whose uncertainty could materially affect downstream decisions.*

```text
             Invoice PDF
                 |
               read()
                 |
                 v
        Extracted record
        +----------------+
        | vendor   ACME  |
        | total    8,420 |
        | tax      1,403 |
        | currency   ?   |
        +--------+-------+
                 |
              observe()
                 |
              choose()
                 |
       What is worth checking?
          /              \
         v                v
     vendor name       currency
   already certain   affects payout
         |                |
        stop          inspect page 2
                          |
                          v
                      observe()
```

```python
import measuretwice as mt
from measuretwice_openai import OpenAIResponses

reader = OpenAIResponses(model="gpt-6-astra")

case = invoice_model.case()

reading = await case.read(
    source=mt.Source.file("invoice.pdf"),
    into=InvoiceFields,
    using=reader,
)

case.observe(
    reading,
    through=invoice_extraction_sensor,
)

decision = case.choose(
    goal=payment_goal,
    checks=[
        verify_currency,
        verify_vendor_identity,
        recompute_totals,
    ],
)
```

The typical extraction pipeline treats every uncertain field similarly.

MeasureTwice could instead reason about **downstream consequence**. If a slightly uncertain company suffix changes nothing, don't spend another model call on it. If the currency is uncertain and determines whether €8,420 becomes $8,420, investigate it.

That turns extraction into:

```text
extract everything
      ↓
understand uncertainty
      ↓
verify what matters
      ↓
use the record
```

rather than:

```text
extract
  ↓
hope
```

---

## 6. Incident response / observability

**JTBD:** *When production starts failing, help me maintain competing explanations and select the next diagnostic that is most likely to change the remediation decision.*

```text
                  Alert
                    |
                    v
             Current evidence
                    |
                    v
        +-------------------------+
        | Possible causes         |
        |                         |
        | bad deploy         45%  |
        | dependency outage  30%  |
        | database issue     15%  |
        | traffic spike      10%  |
        +------------+------------+
                     |
                  choose()
                     |
        +------------+------------+
        |                         |
        v                         v
 compare deploy diff         query dependency
        |                         |
        +------------+------------+
                     |
                observation
                     |
                     v
                 rollback?
```

```python
case = incident_model.case()

case.observe(
    latency_spike,
    True,
    source=mt.Source.metric("api.p99", timestamp=now),
)

case.observe(
    error_rate_spike,
    True,
    source=mt.Source.metric("api.5xx", timestamp=now),
)

decision = case.choose(
    goal=mt.Goal.minimize(
        outage_minutes=10,
        bad_rollback=50,
        unnecessary_escalation=5,
    ),
    checks=[
        inspect_recent_deploy,
        query_dependency_health,
        inspect_database_waits,
    ],
    actions=[
        rollback,
        failover,
        escalate,
    ],
)
```

An LLM can interpret logs and suggest possible explanations. The probabilistic model holds the competing hypotheses. The decision layer decides whether another observation is worth the delay before taking a potentially expensive action.

---

# The common pattern

All six examples reduce to the same surprisingly small grammar:

```text
             MODEL
               |
               v

Source ---> read()
               |
               v
            Reading
               |
               | through a Sensor
               v
           observe()
               |
               v
             Case
               |
        +------+------+
        |             |
        v             v
      ask()        choose()
                      |
               +------+------+
               |             |
               v             v
            check()        act()
               |             |
               +------+------+
                      |
                   observe()
                      |
                      └──────► repeat
```

And that is a strong sign for the library abstraction.

The domain changes completely between an invoice, an integration failure, a supplier investigation, and an incident. But the application still needs to do the same fundamental things:

**represent uncertainty → incorporate evidence → understand what is still unknown → decide whether another observation is worth obtaining → act only when appropriate.**

That is the surface area I would optimize MeasureTwice around.

