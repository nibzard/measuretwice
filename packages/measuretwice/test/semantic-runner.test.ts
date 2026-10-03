// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test("the trusted semantic runner uses the built public package offline", () => {
  const result = JSON.parse(execFileSync(process.execPath,
    ["examples/semantic-runner/run.mjs", "--json"], { encoding: "utf8" }));
  expect(result.profile.qualification.status).toBe("unvalidated");
  expect(result.reports.map((report: { aggregate: { outcome: string } }) => report.aggregate.outcome))
    .toEqual(["pass", "fail", "review"]);
  expect(JSON.stringify(result.reports)).not.toContain("Dana confirms");
  expect(result.provider_calls).toBe(3);
  expect(result.profile.execution.max_attempts).toBe(1);
});
