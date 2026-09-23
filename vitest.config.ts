// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

// Ordinary test configuration. These tests stay deterministic and offline.
// Live evaluation tests live in `tests/live` and run only through the
// separate `vitest.live.config.ts`, never through this file.
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/measuretwice/test/**/*.test.ts", "tests/repo/**/*.test.ts"],
  },
});
