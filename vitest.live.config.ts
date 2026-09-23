// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

// Opt-in live evaluation configuration. See TESTING.md.
//
// The tests under `tests/live` contact a real evaluator, spend an API
// budget, and may need credentials. They never run in continuous
// integration and `vitest run` never loads them. Start them with
// `npm run test:live`. No live test exists yet; `passWithNoTests` keeps the
// command usable until the first one arrives in T065.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    passWithNoTests: true,
  },
});
