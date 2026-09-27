// SPDX-License-Identifier: Apache-2.0
// These synthetic cases and reference labels are unreviewed model proposals.
export const cases = [
  {
    id: "supported",
    input: { sources: "Dana confirms Friday for the launch.", candidate: "The launch is Friday." },
    reference: "pass",
  },
  {
    id: "contradicted",
    input: { sources: "Dana confirms Friday for the launch.", candidate: "The launch is Monday." },
    reference: "fail",
  },
  {
    id: "missing-evidence",
    input: { sources: "Dana says the date is undecided.", candidate: "The launch is Friday." },
    reference: "review",
  },
];
