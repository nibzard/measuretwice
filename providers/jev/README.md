# Jev provider contract

Status: verified 24 September 2026 against `@typesafe-ai/sdk` 0.6.0.

This record is the verified provider contract for the Jev evaluator adapter.
It replaces the design-time assumptions in [MVP_SPEC.md](../../MVP_SPEC.md)
sections 5 and 6. Task T025 translates checks into Jev questions. Task T026
normalizes Jev assessments. Both build on this record.

No repository code imports the SDK yet. The public package keeps `typebox`
as its only runtime dependency until the adapter arrives.

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
elapsed time with that signal, because retries carry no total budget. The
wrapper scheduler owns attempts, backoff, and deadlines; the config fields
appear in `fixtures/runtime/traces.json`. Task T034 reconciles the SDK retry
defaults with that attempt budget.

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
sources. Task T026 adds the normalization expectations; this file carries
the data only.

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
