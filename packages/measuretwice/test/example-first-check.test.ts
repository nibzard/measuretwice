// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import type { Profile, RunReport } from "../src/index.js";

test("a requirement revision rejects the old profile before assessing new cases", async () => {
  const entry = fileURLToPath(new URL("../../../examples/first-check/revise.mjs", import.meta.url));
  const host = await import(entry) as {
    runRequirementRevision(options: { log: (text: string) => void }): Promise<{
      oldProfileError: { code: string };
      callsBeforeNewProfile: number;
      profile: Profile;
      reports: RunReport[];
      summary: string;
    }>;
  };
  const result = await host.runRequirementRevision({ log: () => {} });
  expect(result.oldProfileError.code).toBe("definition_mismatch");
  expect(result.callsBeforeNewProfile).toBe(0);
  expect(result.profile.qualification.status).toBe("unvalidated");
  expect(result.reports.map(report => report.aggregate.outcome)).toEqual(["fail", "pass", "review"]);
  expect(result.reports.every(report => report.mode === "shadow")).toBe(true);
  expect(result.summary).toContain("The launch is Friday.");
  expect(result.summary).toContain("Dana confirms the launch is Friday.");
  expect(result.summary).toContain("Reassess cases under the revised requirement.");
});
