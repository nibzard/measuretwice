# Run semantic checks from trusted host code

The data-only CLI runs exact checks. This host module runs semantic checks through the public library API.
It registers Jev explicitly and keeps credentials with the host client.
Definition data cannot load executable code.

## Run offline

From the repository root:

```sh
npm run build
node examples/semantic-runner/run.mjs
node examples/semantic-runner/run.mjs --json
```

The default uses fixed provider responses. It produces pass, fail, and review reports without credentials or network access.
The cases and references are synthetic and unreviewed. The results measure no model quality.
The readable view includes the supplied evidence locally. The JSON reports contain input hashes rather than private input text.

## Run live

Install the host client in a separate application that uses measuretwice:

```sh
npm install measuretwice @typesafe-ai/sdk@0.6.0
```

Copy the trusted runner and its first-check modules into that application.
Set `TYPESAFE_API_KEY` through your application's credential mechanism.
Pass `--live` to the runner. This option performs paid provider calls.
The runner uses three cases, one attempt per check, and a 30-second deadline per case.
The SDK receives disabled retries from the adapter. An unvalidated profile remains unvalidated after execution.

Live execution is not part of ordinary tests. No live result is claimed for this example.
For installation from a checkout, install the pinned client into your own host environment before using `--live`.

## Change your requirement

Edit the trusted check module and supply contrasting cases for your own requirement.
Generate a new exploration profile after a definition or evaluator change.
Inspect each report with the original input before changing the policy.
Use the [calibration workflow](../../docs/guides/calibration.md) when you need evidence for reliance.

The host exits 1 for execution errors or skipped checks. It treats fail and review as completed measurements.
The data-only CLI offers [declared outcome assertions](../../docs/reference/cli.md#assert-outcomes-in-continuous-integration) for exact runs.
