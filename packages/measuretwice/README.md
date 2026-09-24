# measuretwice

Author readable checks in TypeScript. Run them through evaluators, and
calibrate before you rely on the results.

This is a development build. The exact-rule vertical slice works today:
author checks with `defineChecks`, load them, and run one case to get one
frozen report. Question checks, evaluation, calibration, and the CLI
commands arrive with their tasks.

## Install

The package ships prebuilt native binaries. Installation needs no Rust
compiler and no source build.

```sh
npm install measuretwice
```

Node.js 20 or later is required. The declared targets are `darwin-arm64`,
`darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu`, and `win32-x64-msvc`.
Installation on another target fails with one clear loading error that
names the declared targets.

## Use

```ts
import { contractVersion } from "measuretwice";

contractVersion(); // 1
```

The repository holds the development guides:

- [DEVELOPING.md](https://github.com/nibzard/measuretwice/blob/main/DEVELOPING.md)
  records the workspace and the build commands.
- [TESTING.md](https://github.com/nibzard/measuretwice/blob/main/TESTING.md)
  records the test suites.
- The first-run guide arrives with its task.

## License

Apache-2.0. See [LICENSE](LICENSE).
