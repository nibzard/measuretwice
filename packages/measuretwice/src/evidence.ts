// SPDX-License-Identifier: Apache-2.0
/**
 * `checkEvidence`: one check of the retained qualification evidence.
 *
 * MVP_SPEC.md section 11 states the rule: the host retains the
 * qualification evidence that one selected profile references in one
 * stable, explicitly managed location, and one ignored report folder holds
 * no required copy. MVP_SPEC.md section 8 states what the runtime can do
 * about it: verify content consistency and the required references, never
 * the truth of a forged dataset. This module owns the host-facing half of
 * that rule and nothing else.
 *
 * The host states the explicit locations of its retained artifacts: the
 * plan, the dataset metadata, and the dataset records. The Rust core stays
 * the one authority: it validates the profile artifact, its stored
 * self-hash, the plan, and the dataset, then compares every recorded
 * identity with the computed identity of the retained copy. One edited plan,
 * one edited record, or one renamed split fails with `hash_mismatch` at the
 * field path of the recorded reference, so one selected profile never rests
 * on evidence that drifted after the review.
 *
 * The result states what the check verified, with the counts it read, and
 * the standing limits: the comparison authenticates no label, no population
 * claim, and no host approval, and the evaluation-report references name
 * host storage that this check reads none of. Retention of the reports
 * stays with the host.
 */
import { readDatasetTexts } from "./dataset.js";
import { ValidationError } from "./error.js";
import { nativeCheckProfileEvidence } from "./native.js";
import {
  deepFreeze,
  defaultFiles,
  jsonText,
  readText,
  requireJsonPath,
  throughCore,
  type FileAccess,
  type Profile,
} from "./run.js";

/**
 * The locations of the retained qualification evidence of one profile.
 *
 * Every field is required, because one check of retained evidence states
 * where every artifact lives. The paths follow the rules of `calibrate`:
 * one `.json` plan path, one `.json` metadata path, and one `.jsonl`
 * records path. The host manages the locations; the library reads the
 * stated paths and stores nothing.
 */
export interface CheckEvidenceOptions {
  /** One explicit path to the retained JSON calibration plan. */
  readonly plan: string;
  /** One explicit path to the retained JSON dataset metadata file. */
  readonly metadata: string;
  /** One explicit path to the retained JSONL dataset record file. */
  readonly records: string;
  /** The file access that reads the stated paths. The default uses Node APIs. */
  readonly files?: FileAccess;
}

/** The verified plan reference: the identity that the profile records. */
export interface EvidencePlan {
  /** Stable plan identifier. */
  readonly id: string;
  /** Computed identity of the plan in the plan domain. */
  readonly content_hash: string;
}

/** The verified dataset reference: the identity that the profile records. */
export interface EvidenceDataset {
  /** Stable dataset identifier. */
  readonly id: string;
  /** Dataset revision of the retained metadata. */
  readonly revision: string;
  /** Dataset kind, as the retained metadata states it. */
  readonly kind: string;
  /** Case records of the retained dataset. */
  readonly record_count: number;
  /** Computed hash of the retained records, in the dataset domain. */
  readonly content_hash: string;
}

/** One verified split reference: the identity that the profile records. */
export interface EvidenceSplit {
  /** Stable split identifier. */
  readonly id: string;
  /** Fitting or validation, as the retained dataset declares the split. */
  readonly purpose: string;
  /** Groups of the split, in the declared order. */
  readonly groups: readonly string[];
  /** Case records of the split. */
  readonly record_count: number;
  /** Computed hash of the split records, in the split domain. */
  readonly content_hash: string;
}

/** The result of one evidence check over one selected profile. */
export interface EvidenceCheck {
  /** Stable profile identifier. */
  readonly profile_id: string;
  /** Verified self-hash of the profile artifact. */
  readonly profile_content_hash: string;
  /** Content hash of the definition that the profile and the plan bind. */
  readonly definition_hash: string;
  /** The retained plan, with the recorded identity. */
  readonly plan: EvidencePlan;
  /** The retained dataset, with the recorded identity. */
  readonly dataset: EvidenceDataset;
  /** Every recorded split, with the identity of the retained dataset. */
  readonly splits: readonly EvidenceSplit[];
  /** The evaluation-report references, as the profile records them. */
  readonly evaluation_reports: readonly string[];
  /** What the check verified, with the counts it read. */
  readonly statement: string;
  /** The standing limits of this check. */
  readonly limitations: readonly string[];
}

/**
 * Checks the recorded evidence of one profile against the retained
 * artifacts.
 *
 * The host states where it retained the evidence: the plan, the dataset
 * metadata, and the dataset records. The core validates every artifact and
 * compares every recorded identity with the computed identity of the
 * retained copy, so one selected profile rests on the artifacts that the
 * review saw. The check reads no evaluation report and changes nothing: no
 * qualification status, no host selection, and no stored file.
 *
 * @param profile The profile artifact, or one explicit path to its JSON
 * file. The stored self-hash is verified first, so one edited copy fails
 * with `hash_mismatch` before one identity is compared.
 * @param options The explicit paths of the retained plan, metadata, and
 * records, and the optional file access.
 * @returns The frozen check result: the verified identities, the recorded
 * report references, the statement of what the check verified, and the
 * standing limits.
 * @throws {ValidationError} when one option is absent, when one path names
 * one wrong format, when the profile, the plan, or the dataset fails its
 * contract, when one recorded identity differs from the retained artifact,
 * or when the retained plan and the retained dataset state two different
 * calibrations.
 * @throws {Error} when one stated path stays unreadable.
 */
export async function checkEvidence(
  profile: Profile | string,
  options: CheckEvidenceOptions,
): Promise<EvidenceCheck> {
  checkOptions(options);
  const files = options.files ?? defaultFiles;
  const profileText = await profileTextOf(profile, files);
  const source = await readDatasetTexts(options.metadata, options.records, files);
  const planText = await readPlan(options.plan, files);
  const check = throughCore(() =>
    nativeCheckProfileEvidence(profileText, planText, source.metadataText, source.recordsText),
  );
  const value: EvidenceCheck = {
    profile_id: check.profileId,
    profile_content_hash: check.profileContentHash,
    definition_hash: check.definitionHash,
    plan: { id: check.plan.id, content_hash: check.plan.contentHash },
    dataset: {
      id: check.dataset.id,
      revision: check.dataset.revision,
      kind: check.dataset.kind,
      record_count: check.dataset.recordCount,
      content_hash: check.dataset.contentHash,
    },
    splits: check.splits.map((split) => ({
      id: split.id,
      purpose: split.purpose,
      groups: [...split.groups],
      record_count: split.recordCount,
      content_hash: split.contentHash,
    })),
    evaluation_reports: [...check.evaluationReports],
    statement: check.statement,
    limitations: [...check.limitations],
  };
  deepFreeze(value);
  return value;
}

/** Reads the profile text of one evidence check: one path or one artifact. */
async function profileTextOf(profile: Profile | string, files: FileAccess): Promise<string> {
  if (typeof profile === "string") {
    requireJsonPath(profile, "/profile");
    return readText(files, profile);
  }
  return jsonText(profile, "/profile");
}

/**
 * Checks the stated options before one read happens.
 *
 * # Errors
 *
 * Returns one {@link ValidationError} with `missing_field` when one stated
 * location is absent.
 */
function checkOptions(options: CheckEvidenceOptions): void {
  if (options.plan === undefined) {
    throw new ValidationError(
      "missing_field",
      "The evidence check states no plan path. State where the retained plan lives.",
      "/plan",
    );
  }
  if (options.metadata === undefined) {
    throw new ValidationError(
      "missing_field",
      "The evidence check states no dataset metadata path. State where the retained metadata lives.",
      "/metadata",
    );
  }
  if (options.records === undefined) {
    throw new ValidationError(
      "missing_field",
      "The evidence check states no dataset records path. State where the retained records live.",
      "/records",
    );
  }
}

/** Reads the retained plan through one `.json` path, checked before one read. */
async function readPlan(plan: string, files: FileAccess): Promise<string> {
  requireJsonPath(plan, "/plan");
  return readText(files, plan);
}
