// SPDX-License-Identifier: Apache-2.0
/**
 * Internal access to the native measuretwice core.
 *
 * The binding is not public API. Never re-export its types or its values
 * from the package entry point. This module is the one place that turns the
 * failures of the Rust boundary into stable TypeScript errors.
 *
 * The binding itself is the NAPI-RS loader that `npm run build:native`
 * generates and copies next to the compiled package as `binding.cjs`. The
 * loader picks the prebuilt binary of its platform. Development finds the
 * locally built binary beside it. Installation finds the binary of the
 * matching `measuretwice-<target>` package.
 *
 * Every fallible binding call throws one native error whose message holds
 * the serialized `ValidationError` of the core: `code`, `message`, and
 * `field_path`. The helpers below rebuild that record into one
 * {@link NativeFailure}, so no safe cause is lost. A bridge failure, such as
 * a JavaScript argument of the wrong type, carries no domain data and passes
 * through unchanged.
 */
import { createRequire } from "node:module";
import type {
  CaseInfo,
  DefinitionInfo,
  RuleAssessment,
  RunState,
} from "../binding.cjs";

/**
 * The declared native targets of the published packages. The list matches
 * `napi.targets` in `crates/measuretwice-node/package.json` and the
 * `optionalDependencies` that `scripts/build-packages.mjs` injects. The
 * repository packaging test keeps the three lists equal.
 */
const DECLARED_NATIVE_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-x64-msvc",
] as const;

/**
 * Loads the generated NAPI-RS loader of this package.
 *
 * A failed load keeps its cause and names the declared targets, so an
 * unsupported platform reports one clear error instead of the generic
 * missing-binary advice of the generated loader.
 */
function loadBinding(): typeof import("../binding.cjs") {
  const requireBinding = createRequire(import.meta.url);
  try {
    // The loader is CommonJS. Named access works because it assigns every
    // export of the binary at the end of the file.
    return requireBinding("../binding.cjs") as typeof import("../binding.cjs");
  } catch (error) {
    const target = `${process.platform}-${process.arch}`;
    throw new Error(
      `measuretwice found no native binding for ${target}. ` +
        `The declared targets are: ${DECLARED_NATIVE_TARGETS.join(", ")}. ` +
        "When the target is declared, reinstall measuretwice so its binary package installs. " +
        "No Rust compiler and no source build exists as a fallback.",
      { cause: error },
    );
  }
}

const binding = loadBinding();

/** One typed failure reported by the Rust boundary. */
export class NativeFailure extends Error {
  /** Stable reason code from the published registry. */
  readonly code: string;
  /** JSON Pointer to the rejected field. Empty means the whole document. */
  readonly fieldPath: string;

  constructor(code: string, message: string, fieldPath: string) {
    super(message);
    this.name = "NativeFailure";
    this.code = code;
    this.fieldPath = fieldPath;
  }
}

/** The serialized failure shape of `measuretwice_core::ValidationError`. */
interface FailureRecord {
  code: string;
  message: string;
  field_path: string;
}

/** Reads one serialized failure out of one thrown native error. */
function failureRecord(error: unknown): FailureRecord | null {
  if (!(error instanceof Error)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.message);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Partial<FailureRecord>;
  if (
    typeof record.code !== "string" ||
    typeof record.message !== "string" ||
    typeof record.field_path !== "string"
  ) {
    return null;
  }
  return { code: record.code, message: record.message, field_path: record.field_path };
}

/** Runs one binding call and rethrows its domain failure in the stable shape. */
function call<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const record = failureRecord(error);
    if (record === null) {
      throw error;
    }
    throw new NativeFailure(record.code, record.message, record.field_path);
  }
}

/** Returns the contract schema version reported by the Rust core. */
export function nativeContractVersion(): number {
  return binding.contractVersion();
}

/** Validates one definition artifact and returns its meaning and hash. */
export function nativeValidateDefinition(definitionText: string): DefinitionInfo {
  return call(() => binding.validateDefinition(definitionText));
}

/** Validates one case and projects each check's authorized inputs. */
export function nativeValidateCase(definitionText: string, caseText: string): CaseInfo {
  return call(() => binding.validateCase(definitionText, caseText));
}

/** Assesses every exact rule of one case, with the record text of each result. */
export function nativeAssessRuleChecks(
  definitionText: string,
  caseText: string,
): RuleAssessment[] {
  return call(() => binding.assessRuleChecks(definitionText, caseText));
}

/** Builds the canonical form of one strict JSON document. */
export function nativeCanonicalForm(text: string): string {
  return call(() => binding.canonicalForm(text));
}

/** Computes the content hash of one strict JSON document in one domain. */
export function nativeContentHash(domain: string, text: string): string {
  return call(() => binding.contentHash(domain, text));
}

/** Computes the self-hash of one profile or plan artifact. */
export function nativeComputeSelfHash(domain: string, artifactText: string): string {
  return call(() => binding.computeSelfHash(domain, artifactText));
}

/** Verifies the stored self-hash of one profile or plan artifact. */
export function nativeVerifySelfHash(domain: string, artifactText: string): void {
  call(() => binding.verifySelfHash(domain, artifactText));
}

/** Computes the dataset-domain content hash of one record-set array. */
export function nativeDatasetHash(recordsText: string): string {
  return call(() => binding.datasetHash(recordsText));
}

/** Computes the split-domain content hash of one record-set array. */
export function nativeSplitHash(recordsText: string): string {
  return call(() => binding.splitHash(recordsText));
}

/** Starts one run of one case through the core state boundary. */
export function nativeCreateRunState(
  definitionText: string,
  caseReferenceText: string,
  profileReferenceText: string,
  runId: string,
  mode: string,
  maxAttempts: number,
): RunState {
  return call(() =>
    binding.createRunState(
      definitionText,
      caseReferenceText,
      profileReferenceText,
      runId,
      mode,
      maxAttempts,
    ),
  );
}

/** Starts the next attempt of one check, offering the run binding. */
export function runStartAttempt(
  run: RunState,
  checkId: string,
  caseReferenceText: string,
  profileReferenceText: string,
): number {
  return call(() => run.startAttempt(checkId, caseReferenceText, profileReferenceText));
}

/** Resolves one in-flight attempt with an operational failure. */
export function runFailAttempt(
  run: RunState,
  checkId: string,
  code: string,
  message: string,
): { resolution: string; attempts?: number } {
  return call(() => run.failAttempt(checkId, code, message));
}

/** Resolves one in-flight attempt with its component record. */
export function runAcceptResult(run: RunState, checkId: string, recordText: string): void {
  call(() => run.acceptResult(checkId, recordText));
}

/** Records one queue-full skip for work that never started. */
export function runSkipQueueFull(run: RunState, checkId: string): void {
  call(() => run.skipQueueFull(checkId));
}

/** Cancels the run and freezes its report. */
export function runCancel(run: RunState, completedAt?: string | null): void {
  call(() => run.cancel(completedAt ?? null));
}

/** Ends the run at its total deadline and freezes its report. */
export function runDeadline(run: RunState, completedAt?: string | null): void {
  call(() => run.deadline(completedAt ?? null));
}

/** Completes the run and freezes its report. */
export function runComplete(run: RunState, completedAt?: string | null): void {
  call(() => run.complete(completedAt ?? null));
}

export type { CaseInfo, DefinitionInfo, RuleAssessment, RunState };
