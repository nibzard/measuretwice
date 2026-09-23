// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "vitest";
import { contractVersion } from "../src/index.js";

test("contractVersion reports the frozen v0 schema version", () => {
  // The v0 contracts state schema_version 1, as contracts/README.md records.
  expect(contractVersion()).toBe(1);
});
