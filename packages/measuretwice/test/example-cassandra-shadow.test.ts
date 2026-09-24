// SPDX-License-Identifier: Apache-2.0
/**
 * The Cassandra shadow adapter example, executed offline.
 *
 * Task T061 ships the example under `examples/cassandra-shadow`. This suite
 * builds the example through its own TypeScript configuration, exactly as
 * one host application does, then runs it against the offline test
 * evaluators. The suite checks the integration boundary that the example
 * teaches: the mapping of the application records into the cases of the two
 * definitions, the bounded recent context that cuts nothing, the decision
 * and the revision of each existing path as the recorded baseline, the
 * queue that takes the shadow work off the decision path, the host-owned
 * storage of the profiles and the reports, the review export with the
 * stated meanings of the decision words, and the rule that no error, no
 * skip, no review, and no pass changes one application action. It reads
 * local files only, so it stays offline and free. The run identifiers and
 * the terminal times come from the host defaults, so the suite compares
 * structure, never one complete artifact.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** One stored message of the example application. */
interface StoredMessage {
  readonly message_id: string;
  readonly channel: string;
  readonly author: string;
  readonly stored_at: string;
  readonly text: string;
}

/** One proposed memory of the example application. */
interface MemoryProposal {
  readonly proposal_id: string;
  readonly channel: string;
  readonly author: string;
  readonly proposed_at: string;
  readonly sources: readonly StoredMessage[];
  readonly recent_messages: readonly StoredMessage[];
  readonly candidate_text: string;
}

/** One recorded decision of the example application. */
interface DecisionRecord {
  readonly decision_id: string;
  readonly text: string;
}

/** One drafted intervention of the example application. */
interface InterventionProposal {
  readonly proposal_id: string;
  readonly channel: string;
  readonly proposed_at: string;
  readonly decision: DecisionRecord;
  readonly recent_messages: readonly StoredMessage[];
  readonly drafted_message: string;
}

/** One shadow job of the example application. */
interface ShadowJob {
  readonly kind: "memory" | "intervention";
  readonly proposal_id: string;
  readonly baseline: Readonly<{ readonly outcome: string; readonly revision: string }>;
}

/** One application action of the example application. */
interface ApplicationAction {
  readonly kind: "memory-stored" | "intervention-delivered";
  readonly proposal_id: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exampleDir = path.join(repoRoot, "examples", "cassandra-shadow");
const builtHost = path.join(exampleDir, "build", "cassandra-shadow", "host.js");
const builtAdapter = path.join(exampleDir, "build", "cassandra-shadow", "adapter.js");
const builtRecords = path.join(exampleDir, "build", "cassandra-shadow", "records.js");
const builtCassandra = path.join(exampleDir, "build", "cassandra-shadow", "cassandra.js");
const packageManifest = path.join(repoRoot, "packages", "measuretwice", "package.json");
const applicationSource = path.join(exampleDir, "cassandra.ts");

/** The stored records of the example, as the compiled module states them. */
interface RecordsModule {
  readonly CASSANDRA_RECORDS: {
    readonly memory_proposals: readonly MemoryProposal[];
    readonly intervention_proposals: readonly InterventionProposal[];
  };
}

/** The mapped memory input of the compiled adapter. */
interface MemoryInput {
  readonly original_sources: string;
  readonly recent_context: string;
  readonly candidate_text: string;
}

/** The mapped intervention input of the compiled adapter. */
interface InterventionInput {
  readonly prior_decision: string;
  readonly conversation: string;
  readonly proposed_message: string;
}

/** The mapping operations of the compiled adapter. */
interface AdapterModule {
  memoryCaseOf(
    proposal: MemoryProposal,
  ):
    | { readonly mapped: true; readonly case_id: string; readonly input: MemoryInput }
    | { readonly mapped: false; readonly reason: string };
  interventionCaseOf(
    proposal: InterventionProposal,
  ):
    | { readonly mapped: true; readonly case_id: string; readonly input: InterventionInput }
    | { readonly mapped: false; readonly reason: string };
}

/** The queue factory of the compiled application module. */
interface CassandraModule {
  createShadowQueue(capacity: number): {
    enqueue(job: ShadowJob): "queued" | "queue-full";
    depth(): number;
    drain(run: (job: ShadowJob) => Promise<void>): Promise<void>;
    readonly capacity: number;
    readonly refused: readonly ShadowJob[];
  };
}

/** One evaluator request of a scripted test evaluator. */
interface RecordedRequest {
  readonly check: string;
  readonly question: { readonly kind: string };
  readonly inputs: Readonly<Record<string, string>>;
  readonly using: readonly string[];
}

/** The compiled result of one example run. The suite reads these fields. */
interface ExampleResult {
  readonly application: { actions(): readonly ApplicationAction[] };
  readonly queue: {
    enqueue(job: ShadowJob): "queued" | "queue-full";
    depth(): number;
    readonly capacity: number;
    readonly refused: readonly ShadowJob[];
  };
  readonly queuedDepth: number;
  readonly decisions: readonly {
    readonly kind: "memory" | "intervention";
    readonly proposal_id: string;
    readonly outcome: string;
    readonly reasons: readonly string[];
    readonly shadow: "queued" | "queue-full" | "unmapped";
  }[];
  readonly outcomes: readonly {
    readonly definition: string;
    readonly profile_id: string;
    readonly proposal_id: string;
    readonly baseline: string;
    readonly outcome: string;
    readonly report: {
      readonly run_id: string;
      readonly mode: string;
      readonly baseline?: { readonly outcome: string; readonly revision: string };
      readonly case: { readonly id: string; readonly snapshot?: string };
      readonly checks: readonly {
        readonly check: string;
        readonly outcome: string;
        readonly reason?: { readonly code: string };
      }[];
      readonly aggregate: { readonly outcome: string };
      readonly completion: { readonly status: string };
    };
    readonly stored_report: string;
  }[];
  readonly replay: ExampleResult["outcomes"][number];
  readonly actionsBeforeDrain: readonly ApplicationAction[];
  readonly actionsAfterDrain: readonly ApplicationAction[];
  readonly actionsAfterReplay: readonly ApplicationAction[];
  readonly store: { readonly directory: string; reportPaths(): readonly string[] };
  readonly shadow: {
    readonly memoryProfile: { readonly id: string; readonly qualification: { readonly status: string } };
    readonly interventionProfile: {
      readonly id: string;
      readonly qualification: { readonly status: string };
    };
    readonly saturationProfile: {
      readonly id: string;
      readonly qualification: { readonly status: string };
      readonly execution: { readonly max_active: number; readonly max_pending: number };
    };
    readonly memoryEvaluator: { readonly calls: readonly RecordedRequest[] };
    readonly interventionEvaluator: { readonly calls: readonly RecordedRequest[] };
    readonly refusals: readonly { readonly proposal_id: string; readonly reason: string }[];
    readonly failures: readonly { readonly job: ShadowJob; readonly reason: string }[];
    memoryReviewer: {
      run(
        caseInput: { readonly id: string; readonly input: unknown },
        options?: { readonly mode?: string },
      ): Promise<unknown>;
    };
    drain(): Promise<readonly ExampleResult["outcomes"][number][]>;
    exportMemoryReviews(sample: { readonly seed: string; readonly agreements: number }): {
      readonly summary: Record<string, number>;
      readonly jsonl: string;
      readonly records: readonly { readonly case_id: string; readonly selection_reason: string }[];
    };
    exportInterventionReviews(sample: { readonly seed: string; readonly agreements: number }): {
      readonly summary: Record<string, number>;
      readonly jsonl: string;
      readonly records: readonly { readonly case_id: string; readonly selection_reason: string }[];
    };
  };
  readonly summary: string;
}

/** The example run that every test reads. Built once, before the tests. */
let result: ExampleResult;

/** The compiled records, the mapping operations, and the queue factory. */
let records: RecordsModule;
let adapter: AdapterModule;
let cassandra: CassandraModule;

/** The directory that holds the stored profiles and reports of the run. */
let out = "";

beforeAll(async () => {
  expect(
    existsSync(path.join(repoRoot, "packages", "measuretwice", "dist", "index.js")),
    "build the package before the tests",
  ).toBe(true);
  // One host application builds the example through its own configuration,
  // so the suite builds it the same way. One type error in the example fails
  // here, before any test runs.
  execFileSync(
    process.execPath,
    [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(exampleDir, "tsconfig.json")],
    { cwd: repoRoot, stdio: "pipe" },
  );
  records = (await import(pathToFileURL(builtRecords).href)) as RecordsModule;
  adapter = (await import(pathToFileURL(builtAdapter).href)) as AdapterModule;
  cassandra = (await import(pathToFileURL(builtCassandra).href)) as CassandraModule;
  const host = (await import(pathToFileURL(builtHost).href)) as {
    runExample: (options: { readonly out: string; readonly log: (text: string) => void }) => Promise<ExampleResult>;
  };
  out = mkdtempSync(path.join(tmpdir(), "measuretwice-cassandra-"));
  result = await host.runExample({ out, log: () => {} });
}, 120_000);

afterAll(() => {
  if (out !== "") {
    rmSync(out, { recursive: true, force: true });
  }
  rmSync(path.join(exampleDir, "build"), { recursive: true, force: true });
});

/** The decision table of the existing paths, in decision order. */
const DECISIONS: readonly { readonly id: string; readonly outcome: string; readonly shadow: string }[] = [
  { id: "deploy-freeze-window", outcome: "stored", shadow: "queued" },
  { id: "data-region-move", outcome: "stored", shadow: "queued" },
  { id: "quiet-hours", outcome: "skipped", shadow: "queued" },
  { id: "on-call-rotation", outcome: "skipped", shadow: "queued" },
  { id: "incident-log-oversized", outcome: "stored", shadow: "unmapped" },
  { id: "eu-export-move", outcome: "interrupt", shadow: "queued" },
  { id: "eu-export-already-raised", outcome: "interrupt", shadow: "queued" },
  { id: "eu-export-cooldown", outcome: "stay-quiet", shadow: "queued" },
  { id: "paging-rule-reminder", outcome: "stay-quiet", shadow: "queued" },
];

/** The expected aggregate outcome of every shadow run, in drain order. */
const OUTCOMES: readonly { readonly id: string; readonly definition: string; readonly baseline: string; readonly outcome: string }[] = [
  { id: "deploy-freeze-window", definition: "memory-support", baseline: "stored", outcome: "pass" },
  { id: "data-region-move", definition: "memory-support", baseline: "stored", outcome: "fail" },
  { id: "quiet-hours", definition: "memory-support", baseline: "skipped", outcome: "review" },
  { id: "on-call-rotation", definition: "memory-support", baseline: "skipped", outcome: "error" },
  { id: "eu-export-move", definition: "intervention-review", baseline: "interrupt", outcome: "pass" },
  { id: "eu-export-already-raised", definition: "intervention-review", baseline: "interrupt", outcome: "fail" },
  { id: "eu-export-cooldown", definition: "intervention-review", baseline: "stay-quiet", outcome: "review" },
  { id: "paging-rule-reminder", definition: "intervention-review", baseline: "stay-quiet", outcome: "pass" },
];

test("the example runs the two existing paths and the shadow adapter beside them", () => {
  // The decisions and their actions crossed before any run started.
  expect(result.decisions.map((decision) => [decision.proposal_id, decision.outcome, decision.shadow])).toEqual(
    DECISIONS.map((row) => [row.id, row.outcome, row.shadow]),
  );
  // Eight jobs waited in the queue when the decision path returned: four
  // mapped memories and four mapped interventions. The oversized record
  // queued nothing, and no decision waited on one run.
  expect(result.queuedDepth).toBe(8);
  expect(result.decisions.filter((decision) => decision.shadow === "queued")).toHaveLength(8);
  // The application acted five times: three stored memories and two
  // delivered interventions, exactly what its own paths decided.
  expect(result.actionsBeforeDrain).toEqual([
    { kind: "memory-stored", proposal_id: "deploy-freeze-window" },
    { kind: "memory-stored", proposal_id: "data-region-move" },
    { kind: "memory-stored", proposal_id: "incident-log-oversized" },
    { kind: "intervention-delivered", proposal_id: "eu-export-move" },
    { kind: "intervention-delivered", proposal_id: "eu-export-already-raised" },
  ]);
  // Every generated profile is explicitly unvalidated, so no run enforces.
  for (const profile of [
    result.shadow.memoryProfile,
    result.shadow.interventionProfile,
    result.shadow.saturationProfile,
  ]) {
    expect(profile.qualification.status).toBe("unvalidated");
  }
});

test("every shadow run records the decision and the revision of its host as the baseline", () => {
  expect(result.outcomes.map((one) => [one.proposal_id, one.baseline, one.outcome])).toEqual(
    OUTCOMES.map((row) => [row.id, row.baseline, row.outcome]),
  );
  for (const [index, one] of result.outcomes.entries()) {
    const expected = OUTCOMES[index]!;
    const revision = expected.definition === "memory-support" ? "memory-policy-1" : "cassandra-policy-1";
    expect(one.report.mode, expected.id).toBe("shadow");
    expect(one.report.baseline, expected.id).toEqual({ outcome: expected.baseline, revision });
    expect(one.report.case.id, expected.id).toBe(expected.id);
    expect(one.report.completion.status, expected.id).toBe("completed");
    // The replay records one snapshot reference of host storage, and the
    // report holds no copy of the case content behind it.
    expect(one.report.case.snapshot, expected.id).toBe(
      expected.definition === "memory-support"
        ? `cassandra://memory-proposals/${expected.id}`
        : `cassandra://intervention-proposals/${expected.id}`,
    );
  }
});

test("the outcome table covers one pass, one fail, one review, one error, and one skip", () => {
  // The broken adapter answer of `on-call-rotation` records one error that
  // keeps the refusal of the core, and no answer becomes one pass.
  const broken = result.outcomes.find((one) => one.proposal_id === "on-call-rotation")!;
  expect(broken.outcome).toBe("error");
  expect(broken.report.checks[0]?.reason).toMatchObject({ code: "invalid_assessment" });
  // The saturated replay starts one check alone, so the pending-work limit
  // stops the other four with one queue_full record each.
  expect(result.replay.proposal_id).toBe("eu-export-move");
  expect(result.replay.profile_id).toBe("intervention-review-saturation");
  expect(result.shadow.saturationProfile.execution).toMatchObject({ max_active: 1, max_pending: 0 });
  expect(result.replay.report.checks.map((record) => [record.check, record.outcome, record.reason?.code])).toEqual([
    ["decision-conflict", "pass", undefined],
    ["message-supported", "skipped", "queue_full"],
    ["adds-information", "skipped", "queue_full"],
    ["consequence", "skipped", "queue_full"],
    ["message-length", "skipped", "queue_full"],
  ]);
  expect(result.replay.outcome).toBe("review");
});

test("the mapping builds the cases from the records and refuses what no bound admits", () => {
  const freeze = adapter.memoryCaseOf(records.CASSANDRA_RECORDS.memory_proposals[0]!);
  expect(freeze.mapped).toBe(true);
  if (freeze.mapped) {
    // The source line names the author, the channel, and the date. The
    // citation identifier and the storage time stay in the record.
    expect(freeze.input.original_sources).toContain("Message from dana in release-planning on 22 September 2026");
    expect(freeze.input.original_sources).not.toContain("msg-101");
    expect(freeze.input.recent_context.startsWith("Newest message last.")).toBe(true);
    expect(freeze.input.recent_context).toContain("marta at 08:40 UTC: When do deploys restart?");
    expect(freeze.input.candidate_text).toBe("Deploy freeze until Friday 18:00 UTC.");
  }
  // The oversized record refuses the mapping and names the bound. Nothing
  // was cut, and no case ran: the summary states the refusal.
  const oversized = adapter.memoryCaseOf(records.CASSANDRA_RECORDS.memory_proposals[4]!);
  expect(oversized.mapped).toBe(false);
  if (!oversized.mapped) {
    expect(oversized.reason).toContain("code points");
    expect(oversized.reason).toContain("4000");
  }
  expect(result.shadow.refusals.map((refusal) => refusal.proposal_id)).toEqual(["incident-log-oversized"]);
  expect(result.outcomes.map((one) => one.proposal_id)).not.toContain("incident-log-oversized");
  expect(result.summary).toContain("incident-log-oversized · the original sources hold");

  // One newest message that alone breaks the context bound refuses the
  // proposal instead of losing one line.
  const huge: StoredMessage = {
    message_id: "msg-huge",
    channel: "infra",
    author: "priya",
    stored_at: "2026-09-22T12:00:00Z",
    text: "x".repeat(4100),
  };
  const refused = adapter.memoryCaseOf({
    proposal_id: "oversized-context",
    channel: "infra",
    author: "priya",
    proposed_at: "2026-09-22T12:00:00Z",
    sources: [records.CASSANDRA_RECORDS.memory_proposals[0]!.sources[0]!],
    recent_messages: [huge],
    candidate_text: "One short candidate.",
  });
  expect(refused.mapped).toBe(false);

  // One long but bounded history keeps the newest messages alone.
  const long: MemoryProposal = {
    proposal_id: "long-history",
    channel: "infra",
    author: "priya",
    proposed_at: "2026-09-22T12:00:00Z",
    sources: [records.CASSANDRA_RECORDS.memory_proposals[0]!.sources[0]!],
    recent_messages: [0, 1, 2, 3, 4].map((index) => ({
      message_id: `msg-${index}`,
      channel: "infra",
      author: "leo",
      stored_at: "2026-09-22T12:00:00Z",
      text: `${"line of context ".repeat(60)}${index}`,
    })),
    candidate_text: "One short candidate.",
  };
  const bounded = adapter.memoryCaseOf(long);
  expect(bounded.mapped).toBe(true);
  if (bounded.mapped) {
    expect([...bounded.input.recent_context].length).toBeLessThanOrEqual(4000);
    expect(bounded.input.recent_context).toContain("line of context");
    // The mapping kept the newest lines and dropped the oldest ones.
    expect(bounded.input.recent_context).not.toContain("line of context ".repeat(60) + "0");
  }

  // The intervention mapping reads the recorded decision and the draft, and
  // the citations of the decision stay in the record.
  const move = adapter.interventionCaseOf(records.CASSANDRA_RECORDS.intervention_proposals[0]!);
  expect(move.mapped).toBe(true);
  if (move.mapped) {
    expect(move.input.prior_decision).toContain("customer export data must remain in the EU");
    expect(move.input.prior_decision).not.toContain("decision-eu-data");
    expect(move.input.proposed_message).toContain("conflicts with");
  }
});

test("every evaluator request carries only the projected inputs of its check", () => {
  // One memory run asks one question, so four runs make four requests.
  const memoryCalls = result.shadow.memoryEvaluator.calls;
  expect(memoryCalls.map((request) => request.check)).toEqual(
    Array.from({ length: 4 }, () => "memory-supported"),
  );
  for (const request of memoryCalls) {
    expect(request.using).toEqual(["original_sources", "candidate_text"]);
    expect(Object.keys(request.inputs).sort()).toEqual(["candidate_text", "original_sources"]);
  }
  // Four intervention runs of four question checks, and the saturated
  // replay starts one check alone: seventeen requests.
  const interventionCalls = result.shadow.interventionEvaluator.calls;
  expect(interventionCalls).toHaveLength(17);
  const projected = new Set(interventionCalls.map((request) => Object.keys(request.inputs).sort().join("+")));
  expect(projected).toEqual(
    new Set(["conversation+prior_decision", "conversation+proposed_message", "conversation+prior_decision+proposed_message"]),
  );
  // No field of the application records crosses the boundary: the gates,
  // the citation identifiers, and the record keys stay in the application.
  const serialized = JSON.stringify([...memoryCalls, ...interventionCalls]);
  for (const forbidden of [
    "memory_authors",
    "attention_eligible",
    "intervention_cooldown_until",
    "memory_approval_mode",
    "proposal_id",
    "message_id",
    "decision_id",
    "citations",
    "msg-101",
    "msg-401",
  ]) {
    expect(serialized, `no request states ${forbidden}`).not.toContain(forbidden);
  }
});

test("no shadow outcome changes one application action", () => {
  // The ledger holds the same actions in the same order after the drain and
  // after the saturated replay, through one pass, one fail, one review, one
  // error, and one skip.
  expect(result.actionsAfterDrain).toEqual(result.actionsBeforeDrain);
  expect(result.actionsAfterReplay).toEqual(result.actionsBeforeDrain);
  expect(result.summary).toContain("No shadow outcome changed one application action.");
});

test("the queue is bounded and never blocks the decision path", async () => {
  const queue = cassandra.createShadowQueue(1);
  const first: ShadowJob = {
    kind: "memory",
    proposal_id: "one",
    baseline: { outcome: "stored", revision: "memory-policy-1" },
  };
  const second: ShadowJob = {
    kind: "memory",
    proposal_id: "two",
    baseline: { outcome: "skipped", revision: "memory-policy-1" },
  };
  // The enqueue operations return at once. The second job meets one full
  // queue, so the queue records the refusal instead of blocking or growing.
  expect(queue.enqueue(first)).toBe("queued");
  expect(queue.enqueue(second)).toBe("queue-full");
  expect(queue.depth()).toBe(1);
  expect(queue.refused).toEqual([second]);
  const ran: string[] = [];
  await queue.drain(async (job) => {
    ran.push(job.proposal_id);
  });
  expect(ran).toEqual(["one"]);
  expect(queue.depth()).toBe(0);
  // The example run held its whole shadow load inside its capacity.
  expect(result.queuedDepth).toBeLessThanOrEqual(32);
});

test("the host owns the storage and no stored report holds case content", () => {
  // Eight drained runs and one saturated replay: nine stored reports.
  expect(result.store.reportPaths()).toHaveLength(9);
  for (const one of [...result.outcomes, result.replay]) {
    const text = readFileSync(one.stored_report, "utf8");
    expect(JSON.parse(text), `the report of ${one.proposal_id} round-trips through host storage`).toEqual(
      one.report,
    );
    for (const forbidden of [
      "deploy freeze runs until",
      "EU replica",
      "US region",
      "Page the secondary",
      "on-call rotation changes",
      "msg-401",
      "decision-eu-data",
    ]) {
      expect(text, `the report of ${one.proposal_id} states ${forbidden}`).not.toContain(forbidden);
    }
  }
  // The three profiles are stored artifacts of the same storage.
  for (const name of [
    "memory-support-exploration",
    "intervention-review-exploration",
    "intervention-review-saturation",
  ]) {
    const profile = JSON.parse(readFileSync(path.join(result.store.directory, `${name}.json`), "utf8")) as {
      qualification: { status: string };
    };
    expect(profile.qualification.status).toBe("unvalidated");
  }
});

test("the review export keeps the review load visible with the stated meanings", () => {
  const memory = result.shadow.exportMemoryReviews({ seed: "review-seed-1", agreements: 1 });
  expect(memory.summary).toMatchObject({
    reports: 4,
    disagreements: 2,
    candidate_errors: 1,
    missing_baselines: 0,
  });
  // The records keep report order: the sampled agreement of the first
  // report, then the always-included ones.
  expect(memory.records.map((record) => record.case_id)).toEqual([
    "deploy-freeze-window",
    "data-region-move",
    "quiet-hours",
    "on-call-rotation",
  ]);
  expect(memory.records.map((record) => record.selection_reason)).toEqual([
    "sampled_agreement",
    "disagreement",
    "disagreement",
    "candidate_error",
  ]);
  const intervention = result.shadow.exportInterventionReviews({ seed: "review-seed-1", agreements: 1 });
  // Four reports reached the export: the four drained runs alone. The
  // saturated replay of the same case ran under another profile, so it
  // stays out, and one repeated case identifier would refuse the export.
  expect(intervention.summary).toMatchObject({ reports: 4, disagreements: 2 });
  expect(intervention.records).toHaveLength(3);
  // The records carry the snapshot references of host storage and no case
  // content, so one reviewer can replay through the application.
  for (const exported of [memory, intervention]) {
    for (const forbidden of ["EU replica", "US region", "deploy freeze runs until"]) {
      expect(exported.jsonl, `the export states ${forbidden}`).not.toContain(forbidden);
    }
  }
  expect(memory.jsonl).toContain("cassandra://memory-proposals/data-region-move");
  expect(result.summary).toContain("Agreement with the baseline is one observation");
});

test("a failed shadow job records one failure and changes no application action", async () => {
  // One job that names no stored proposal reaches the worker of the
  // example. The worker records the failure, throws nothing, and reaches no
  // decision, no rule, and no action.
  const ghost: ShadowJob = {
    kind: "memory",
    proposal_id: "no-such-proposal",
    baseline: { outcome: "stored", revision: "memory-policy-1" },
  };
  expect(result.queue.enqueue(ghost)).toBe("queued");
  const drained = await result.shadow.drain();
  // The drain returns every outcome of the adapter, so the eight drained
  // runs and the one replay.
  expect(drained).toHaveLength(9);
  expect(result.shadow.failures.map((failure) => failure.job.proposal_id)).toEqual(["no-such-proposal"]);
  expect(result.shadow.failures[0]?.reason).toContain("no memory proposal no-such-proposal");
  expect(result.application.actions()).toEqual(result.actionsBeforeDrain);
  expect(result.store.reportPaths()).toHaveLength(9);
});

test("the example adds no dependency to the library", () => {
  // The public package declares no Cassandra driver, and the application
  // module of the example imports no measuretwice module. The integration
  // lives in the adapter, not in the library.
  const manifest = JSON.parse(readFileSync(packageManifest, "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const forbidden of ["cassandra-driver", "@datastax/cassandra-driver", "cassandra-compiler"]) {
    expect(declared[forbidden], `the package declares ${forbidden}`).toBeUndefined();
  }
  const source = readFileSync(applicationSource, "utf8");
  expect(source).not.toContain('from "measuretwice"');
});

test("enforcement refuses the unvalidated profile before any case work", async () => {
  const freeze = adapter.memoryCaseOf(records.CASSANDRA_RECORDS.memory_proposals[0]!);
  if (!freeze.mapped) {
    throw new Error("the first memory proposal must map");
  }
  const failure = await result.shadow.memoryReviewer
    .run({ id: freeze.case_id, input: freeze.input }, { mode: "enforcement" })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  // The compiled example answers through the built package, so its error
  // class is one other module instance than the `ValidationError` of the
  // suite. The refusal crosses with its stable code and field path.
  expect(failure).toBeInstanceOf(Error);
  expect((failure as { code?: unknown }).code).toBe("qualification_insufficient");
  expect((failure as { fieldPath?: unknown }).fieldPath).toBe("/profile/qualification/status");
});
