# Jev provider contract

Status: verified 24 September 2026 against `@typesafe-ai/sdk` 0.6.0.

This record is the verified provider contract for the Jev evaluator adapter.
It replaces the design-time assumptions in [MVP_SPEC.md](../../MVP_SPEC.md)
sections 5 and 6. Task T025 added the translation contract below, and task
T026 added the normalization contract. Both build on this record.

No repository code imports the SDK. The adapter of task T026 takes the Jev
boundary as one function that matches `systemOne` structurally, so the
public package keeps `typebox` as its only runtime dependency and no
dependency entry is needed. The host constructs the client and passes its
`systemOne` operation, which keeps the credential and the endpoint with the
host.

## Pin

| Property | Value |
| --- | --- |
| Package | `@typesafe-ai/sdk` |
| Pinned version | 0.6.0 |
| Dist-tag | `latest` (published 15 September 2026) |
| License | MIT |
| Runtime dependencies | None |
| Node.js requirement | 20 or later |
| Module formats | ECMAScript modules, CommonJS, TypeScript declarations |

Pin the version exactly. Add the dependency entry to
`packages/measuretwice/package.json` with the first adapter code that imports
it. Until then, the pin lives here and in the table in
[DEVELOPING.md](../../DEVELOPING.md). The repository check
`tests/repo/provider-fixtures.test.ts` ties the fixture provenance to that
table row.

Version 0.6.0 carries one breaking change: `ScoreQuestion.criteria` is an
ordered tuple, not a record keyed by integer. The adapter uses the tuple form.
Version 0.5.7 was the first public release. The registry lists no other
release.

## Supported model configuration

`TypeSafeClientConfig.defaultModel` selects the model. Its default is
`jev-latest`. The environment variable `TYPESAFE_DEFAULT_MODEL` overrides the
default. `SystemOneRequest.model` overrides the model for one request.

The response field `model` returns the versioned identifier that answered the
request. Write that identifier into the operational record. The adapter sends
a versioned identifier and never an alias, because aliases repoint without a
code change.

| Identifier | Meaning |
| --- | --- |
| `jev-1.13.0` | The current stable version. Pin this for profiles. |
| `jev-latest` | The newest stable release. This is the SDK default. |
| `jev-preview` | The newest build, official or not. It may run ahead. |

A versioned identifier works even when the model list does not name it.
`client.models.list()` returns `ModelCard` records. A card holds `name`,
`description`, and `release_date`. No card carries a deprecation field.

The client reads four environment variables: `TYPESAFE_API_KEY` (required
without `apiKey`), `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, and
`TYPESAFE_LOG_LEVEL`. Explicit options take precedence over environment
variables, then SDK defaults. Empty or whitespace-only environment values are
ignored. Log level `debug` logs bodies without redaction.

## Request and response shapes

One `client.systemOne(request, options?)` call carries one `state` value and a
nonempty map of questions. The declarations below come from the shipped
`dist/index.d.mts` of version 0.6.0.

```ts
type EntryType =
  | string
  | { [key: string]: JsonValue }
  | JsonValue[]
  | null;

interface SystemOneRequest<Q extends Questions = Questions> {
  state: EntryType;
  questions: Q;
  model?: string;
}

interface SystemOneResult<Q extends Questions> {
  readonly model: string;
  readonly answers: { readonly [K in keyof Q]: ResultFor<Q[K]> };
  readonly usage: Usage;
}

interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}
```

The three question helpers and their answers:

```ts
type ChoiceCriteria = { [label: string]: Description };
type ScoreCriteria = readonly [EntryType, EntryType, ...EntryType[]];

choice<T extends ChoiceCriteria>(instructions, criteria): ChoiceQuestion<T>;
noul(instructions?, criteria?): NoulQuestion;
score<T extends ScoreCriteria>(instructions, criteria): ScoreQuestion<T>;

interface ChoiceResponse<T> {
  readonly type: "choice";
  readonly choice: keyof T & string;
  readonly confidence: number;
  readonly probabilities: { readonly [label in keyof T]: number };
}

interface NoulResponse {
  readonly type: "noul";
  readonly noul: number;
}

interface ScoreResponse<T> {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly legend: ScoreLegend<T>;
  readonly probabilities: { readonly [score in ScoreOf<T>]: number };
}
```

Verified semantics:

- `NoulResponse.noul` is the probability of a yes answer, from zero to one.
  Noul has no separate `confidence`. Near 0.5 means equal probability for yes
  and no, not medium intensity.
- `ScoreResponse.score` is a position along the ordered levels. It may fall
  between two levels. `probabilities` is the distribution across levels. Its
  mean alone can hide a split between very different levels.
- `ChoiceResponse.probabilities` is the distribution across every supplied
  label. The model never returns a value outside the supplied options or
  levels.
- `confidence` appears on Choice and Score only. It summarizes how
  concentrated the distribution is. It is not a probability of correctness.
  Keep it apart from evaluation evidence.

A criterion description is `EntryType`. A `null` entry leaves one label or one
score level undescribed. `ScoreCriteria` indexes descriptions by array
position from zero. A rubric needs at least two entries.

## Translation contract

Task T025 translates one question check into one Jev question. The module
`packages/measuretwice/src/jev.ts` owns the translation and nothing else.
It imports no SDK type, so the public package keeps `typebox` as its only
runtime dependency.

| Check shape | Jev primitive | Translation |
| --- | --- | --- |
| Named answers | Choice | The criteria keys are exactly the declared answer labels. Each value is the answer description. |
| Explicit yes and no answers | Noul | The yes description maps to `criteria.true` and the no description to `criteria.false`. |
| Ordered descriptive scale | Score | The criteria tuple holds the level descriptions in the declared order, indexed from zero. |

The translation preserves the question wording, every answer description,
and the scale order. The level names of a scale stay in the check meaning;
the adapter maps reported positions back to names when it normalizes one
assessment. The accept and review sets never enter the question, because
acceptance defines meaning and carries no probability of correctness.

The translated question is plain JSON in the wire shape above:
`{ type, instructions, criteria }`. Its canonical form is hashed in the
translation domain of the Rust core, as
[contracts/v0/hashing.md](../../contracts/v0/hashing.md) states. One
changed translated question changes the digest, so the profile binding
that records the digest and the complete question changes, and the prior
qualification no longer applies. A changed translation behavior also
changes the translation contract version, which the adapter version
carries.

The request state frames the supplied content as evidence. One fixed
`evidence` key holds exactly the projected inputs that the `using` list
names, so a label, a label explanation, a baseline decision, and the case
identifier never reach the provider. The envelope marks every supplied
value as evidence for the question, never as instructions. The adapter
sends one request as `{ state, questions: { [check id]: question } }`.

The shared translation cases live in
[fixtures/translations/jev.json](../../fixtures/translations/jev.json)
with the manifest group `translations-jev`. They pin the translated
question, the canonical text, and the digest of one categorical, one
binary, and one ordered check, together with the evidence state and the
identity variants that prove one changed element changes the digest. The
package suite in `packages/measuretwice/test/jev.test.ts`, the repository
checks in `tests/repo/fixtures.test.ts`, and the Rust integration tests in
`crates/measuretwice-core/tests/contract_fixtures.rs` keep them honest.
The later Python adapter must pass the same cases.

## Normalization contract

Task T026 normalizes one Jev answer into one typed assessment. The module
`packages/measuretwice/src/jev-assessment.ts` owns the normalization, the
operational record, and the adapter, and nothing else. Like the translation
module, it imports no SDK type and no SDK package: the adapter takes the
Jev boundary as one function that matches `client.systemOne` structurally,
so the public package keeps `typebox` as its only runtime dependency and the
host keeps the client, the credential, and the endpoint.

| Answer | Assessment | Rules |
| --- | --- | --- |
| Choice | `categorical` | `choice` crosses as `label`. `probabilities` becomes the `distribution` over every declared label, in the declared order. `confidence` crosses as `confidence`. |
| Noul | `binary` | `noul` is the probability of yes. One half or more selects yes; less selects no. No confidence crosses, because Noul defines none. No distribution is derived: the v0 policy derives the masses from the value, as MVP_SPEC.md section 6 states. |
| Score | `ordered` | `score` crosses as `position` without rounding. The nearest level becomes `level`; one tie between two levels selects the higher level. `probabilities` maps the level indices to the declared level names, in the declared order. `confidence` crosses as `confidence`. The `legend` is one echo of the sent descriptions and is consumed by nothing. |

Verified details behind the rules:

- One distribution must cover exactly the declared labels or level indices,
  with every mass inside the unit interval. A missing key, one undeclared
  key, or one mass outside the interval fails with `invalid_assessment`.
- The mass sum is not checked in the adapter. The Rust core
  (`measuretwice_core::assessment`) validates one normalized assessment
  against its check before it enters one report: the matching kind, the
  declared labels and levels, one position inside the scale, one
  distribution that names declared names and sums to one within 1e-6, and
  evidence references that the `using` list authorizes.
- One Noul answer that carries a confidence field anyway changes nothing.
  The value is consumed by no rule and `confidence` stays absent.
- One fractional score stays fractional in `position`. The nearest level is
  one recorded answer, never one replacement of the measurement.

The operational record of one call keeps what the call measured:

| Field | Source | Notes |
| --- | --- | --- |
| `model_resolved` | `response.model` | The versioned identifier that answered. One request may send one alias; the record keeps the resolved version. |
| `usage` | `response.usage` | `input_tokens` and `output_tokens`, per request. No per-question usage exists, so none is invented. One incomplete usage object fails the whole response. |
| `latency_ms` | Adapter clock | No response field states latency, so the adapter measures it with its injectable clock. |
| `requestId` | Error field | Kept inside the sanitized failure message of one provider error, never as one assessment field. |

Failure mapping:

| Cause | Code | Message |
| --- | --- | --- |
| One response or answer outside the recorded shapes, one undeclared label or level index, one value outside its range, one incomplete usage object, one missing model identifier, one unknown answer type | `invalid_assessment` | Names the defect. |
| `APIUserAbortError`, one aborted signal before or after one answer | `evaluator_timeout` | States the abort. One answer that arrives after one abort is dropped. |
| `APITimeoutError`, one spent attempt deadline | `evaluator_timeout` | States the timeout. |
| Every other thrown error | `evaluator_error` | The class name, the numeric `status`, and the string `requestId`. |

The adapter sanitizes provider error text by construction: it reads the
class name, the status, and the request identifier, and it reads no message,
no body, and no header, because each can quote case content or one
credential. The class, the status, and the request identifier keep the
operational reason visible, as the evaluator contract requires.

The adapter passes the caller `AbortSignal` on every call, bounds one
attempt with the remaining budget of the request, and disables the retry
loop of the SDK with `retry: { maxRetries: 0 }`, because the SDK retries
carry no total budget. The wrapper scheduler owns the attempts, the
backoff, and the total deadline, so one wrapper attempt is one SDK
request: hidden SDK retries cannot multiply the requests and the spend of
one budget the wrapper cannot see.

The shared cases live in
[fixtures/adapters/jev-normalization.json](../../fixtures/adapters/jev-normalization.json)
with the manifest group `jev-normalization`. Every case drives the adapter
through the dispatch contract, so the Rust core validates each normalized
assessment against its check. The responses come from the synthetic
fixtures of this record; one case answers under the check identifier,
because one real response echoes the key of the request and the adapter
keys its one question by the check identifier. One provider case stays
outside the group: `choice-two-labels-null-criteria`, because one check
whose answers are exactly yes and no is binary and translates to Noul, so
no Choice question of this translation carries those labels. The package
suite in `packages/measuretwice/test/jev-assessment.test.ts` and the
repository checks in `tests/repo/fixtures.test.ts` keep the group honest.
The later Python adapter must pass the same cases.

## Cancellation, timeout, and retries

```ts
interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  retry?: Partial<RetryPolicy>;
  headers?: Record<string, string>;
}
```

- `signal` cancels the request and every pending retry. The call then rejects
  with `APIUserAbortError`. That class extends `TypeSafeError`. Its default
  message is `Request was aborted.` Map it to run cancellation, never to an
  execution failure.
- `timeout` bounds one attempt in milliseconds. The default is 10000. No
  total budget exists across retries. Retries can extend elapsed time without
  a limit.
- The retry defaults are:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxRetries` | 2 | Retries after the first attempt. Zero disables retries. |
| `httpStatuses` | 408, 429, 500 to 599 | Statuses eligible for retry. |
| `apiConnectionError` | true | Retry connection failures. |
| `apiTimeoutError` | true | Retry attempt timeouts. |
| `backoffInitialMs` | 500 | First backoff delay. |
| `backoffMaxMs` | 5000 | Backoff delay cap. The delay doubles up to it. |
| `backoffJitter` | 0.25 | Random fraction subtracted from each delay. |
| `respectRetryAfter` | true | Honor `Retry-After` and `retry-after-ms`. |
| `maxRetryAfterMs` | 60000 | Server delay cap. Longer delays use backoff. |

Adapter rule: pass the caller `AbortSignal` on every call. Bound total
elapsed time with that signal, because retries carry no total budget.
State `retry: { maxRetries: 0 }` on every call, so the wrapper scheduler
owns attempts, backoff, and deadlines alone; the config fields appear in
`fixtures/runtime/traces.json`. Task T032 fixed that reconciliation: one
wrapper attempt is one SDK request, so the configured attempts never
multiply.

## Batching

Questions inside one request run in parallel. One question cannot read the
answer of another. The service ingests the state once. Response time grows
little when questions are added.

The documentation states no numeric limit for questions per request. The
64,000 token request budget covers the state and every question together.

The rule in MVP_SPEC.md section 12 stands. Batch questions only when their
authorized projected state is identical. The flagship example uses different
projections, so it needs separate calls.

## Service limits

| Limit | Value |
| --- | --- |
| Request budget | 64,000 tokens for state plus all questions. |
| State budget | 32,000 tokens for state plus the longest question. |
| Token rate | 250,000 tokens per second. |
| Request rate | 1,200 requests per minute. |
| Accepted input | Text, JSON objects, arrays of text. No images, audio, or video. |
| Billing | Input tokens only. Output tokens are free. |

An exceeded rate limit returns status 429 with `RateLimitError`. The limits
are dynamic. They can change without notice.

## Errors

| Class | Status | Fact |
| --- | --- | --- |
| `APIError` | varies | Carries `status`, `headers`, `body`, and `requestId`. |
| `BadRequestError` | 400 | The request construction is invalid. |
| `AuthenticationError` | 401 | The credential is missing or invalid. |
| `PermissionDeniedError` | 403 | The account lacks access. |
| `NotFoundError` | 404 | The addressed resource is absent. |
| `RateLimitError` | 429 | Retried first; `Retry-After` is honored. |
| `UnprocessableEntityError` | 422 | The payload is semantically invalid. |
| `InternalServerError` | 5xx | The service failed. |
| `APIConnectionError` | none | The connection failed. Retried. |
| `APITimeoutError` | none | One attempt timed out. Retried. |
| `APIUserAbortError` | none | The caller aborted the request. |

`requestId` comes from the `x-typesafe-request-id` response header. It is
`undefined` when the header is absent. Keep it in the operational record.
Sanitize provider error text before it enters a reason code or a message
field, as the evaluator contract requires.

## Unavailable metadata

| Metadata | Status | Required handling |
| --- | --- | --- |
| Usage per question | Unavailable. Usage is per request. | Record usage at request level. Keep per-check usage absent. |
| Response latency | No response field exists. | Measure elapsed time at the adapter boundary. Mark it adapter-measured. |
| Evidence references | No response field exists. | Keep the assessment evidence absent. Never derive references from the state. |
| Noul confidence | Does not exist. | Keep it absent. Derive probability mass from the `noul` value. |
| Confidence meaning | Distribution concentration. | Keep it apart from evaluation evidence. Apply only recorded floors. |
| Model deprecation | `ModelCard` has no deprecation field. | Resolve the model by the identifier in `response.model`. |
| Retry events | The SDK exposes no retry event stream. | Record the final error only, with a sanitized message. |

Never invent a value for an unavailable field. Keep absent measurements
absent, as the assessment contract requires.

## Verification provenance

This record was verified without a live service call. No credential was read
and no request was sent. Live evaluation starts with task T065.

Method, executed 24 September 2026:

1. Read the live documentation pages listed below.
2. Query the npm registry for the released versions and dist-tags.
3. Install `@typesafe-ai/sdk@0.6.0` into one empty scratch project outside
   the repository. The manifest declares no runtime dependency, Node.js 20
   or later, and dual module formats.
4. Compile one probe program against the shipped declarations with the
   repository TypeScript 7.0.2 under `--strict`. Every field name in this
   record compiled. The probe covers the client constructor, the three
   question helpers, the request options, and all response fields.
5. Run one runtime probe with no network access. It confirmed: the `VERSION`
   export equals `0.6.0`; `defaultModel` is `jev-latest`; `baseURL` is
   `https://api.typesafe.ai`; the attempt timeout is 10000 ms; every retry
   default in the table above; the retried status set contains 408, 429, and
   500 through 599 and excludes 400 and 404; empty questions throw before a
   request is sent; an aborted signal rejects with `APIUserAbortError`, a
   `TypeSafeError`, with the message `Request was aborted.`

Response values were never observed. The fixtures in
[fixtures/responses.json](fixtures/responses.json) are synthetic. Their
shapes follow the shipped type declarations and the documentation.

A fixture record holds `id`, `note`, `origin`, `source`, `request`, and
`response`. Every record states `origin: "synthetic"`. A malformed record
adds one `defect` that names the broken invariant. A `request` names the
synthetic state and questions that its response answers. The file header
records the provenance: the SDK version, the model, the check date, and the
sources. The normalization expectations live in the shared group
[fixtures/adapters/jev-normalization.json](../../fixtures/adapters/jev-normalization.json);
this file carries the response data only.

## Sources

Read 24 September 2026:

- Documentation index: `https://docs.typesafe.ai/llms.txt`
- JavaScript SDK: `https://docs.typesafe.ai/sdk/javascript.md` and its
  changelog.
- SDK reference: the pages for `TypeSafeClient`, `TypeSafeClientConfig`,
  `RequestOptions`, `RetryPolicy`, `SystemOneRequest`, `SystemOneResult`,
  `Usage`, `ModelCard`, `Models`, `ChoiceQuestion`, `ChoiceResponse`,
  `NoulQuestion`, `NoulResponse`, `ScoreQuestion`, `ScoreResponse`,
  `ChoiceCriteria`, `ScoreCriteria`, `EntryType`, `ResultFor`, `APIError`,
  and `APIUserAbortError` under `https://docs.typesafe.ai/sdk/javascript/api/`.
- Primitives: `https://docs.typesafe.ai/primitives.md`
- Confidence: `https://docs.typesafe.ai/confidence.md`
- Batching: `https://docs.typesafe.ai/patterns/fan-out.md`
- Models and limits: `https://docs.typesafe.ai/models.md`
- Registry: `https://www.npmjs.com/package/@typesafe-ai/sdk`
- Package: the shipped declarations in `dist/index.d.mts` of version 0.6.0.

Recheck this record when the SDK pin changes or when the service limits
matter for a release. The models page states that limits can change without
notice.
