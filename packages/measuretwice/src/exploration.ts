// SPDX-License-Identifier: Apache-2.0
/**
 * The explicit generation of exploration profiles.
 *
 * One exploration profile lets a developer try semantic checks before any
 * qualification evidence exists. It binds one validated definition to the
 * evaluators that the host registered, records one starter policy and the
 * effective execution configuration, and stays `unvalidated`. The starter
 * thresholds carry no qualification evidence: they are explicit numbers that
 * the host chose or took from the documented defaults, and the reason code
 * `starter_policy` says so inside the artifact. Evaluation and shadow use
 * accept the profile; enforcement refuses it through the qualification
 * clause of the Rust core, exactly as the checked qualification model
 * states.
 *
 * `createExplorationProfile` is one pure function of the definition
 * artifact, the registered evaluators, and the stated options. It reads no
 * clock, draws no identifier, and calls no provider: the Jev adapter
 * contributes its translated question through the offline `translate`
 * operation, and one adapter that translates nothing sends the validated
 * question unchanged, so the recorded translation states what the evaluator
 * receives. Generation resolves no model version, because nothing was
 * measured; the binding records the requested alias alone, and one later run
 * that states one resolution compares it.
 *
 * The generator owns no validation of its own. It signs the artifact with
 * the core self-hash, then runs the complete profile contract and the shadow
 * compatibility check of the core over the result, so the returned profile
 * is one artifact that `load` accepts. The returned value is frozen and
 * holds no credential and no case content. The host persists it, reviews it,
 * and selects it; no generated profile authorizes one application action,
 * and executing it changes nothing about its qualification.
 *
 * Failure behavior: one definition, registry, or option outside the contract
 * throws one public {@link ValidationError} with a stable reason code and a
 * field path, before any artifact exists.
 */
import type { Definition } from "./define-checks.js";
import type { Evaluator, EvaluatorRegistry, ValidatedQuestion } from "./evaluator.js";
import { validatedQuestion } from "./evaluator.js";
import { ValidationError } from "./error.js";
import {
  NativeFailure,
  nativeCanonicalForm,
  nativeCheckProfileCompatibility,
  nativeComputeSelfHash,
  nativeContentHash,
  nativeValidateDefinition,
  nativeValidateProfile,
  type DefinitionInfo,
  type LiveBindingEntry,
} from "./native.js";
import type { ExecutionConfig, Profile, ProfileBinding } from "./run.js";

// ---------------------------------------------------------------------------
// Public types of the generator.
// ---------------------------------------------------------------------------

/**
 * The starter numerical parameters of one exploration profile.
 *
 * Both cutoffs must exceed 0.5 and stay at most 1, as the profile contract
 * states. The numbers are explicit choices without qualification evidence;
 * `calibrate` replaces them with measured parameters.
 */
export interface ExplorationStarterPolicy {
  /** Minimum acceptable mass required to pass. */
  readonly accept_cutoff: number;
  /** Minimum unacceptable mass required to fail. */
  readonly rejection_cutoff: number;
  /** Optional abstention floor on reported confidence. Choice and Score answers only. */
  readonly confidence_floor?: number;
}

/** One evaluator binding that the generator records for one question check. */
export interface ExplorationBinding {
  /** The registered evaluator that serves the check. */
  readonly evaluator: string;
  /** The model alias that the binding requests, when the adapter takes one. */
  readonly model?: string;
  /** The preprocessing identity, when application preprocessing applies. */
  readonly preprocessing?: string;
}

/** The options of `createExplorationProfile`. Every field is optional. */
export interface ExplorationOptions {
  /** Stable profile identifier. Default: the definition name plus `-exploration`. */
  readonly id?: string;
  /** Declared population and scope. Default: one development-exploration text. */
  readonly intendedUse?: string;
  /**
   * One evaluator binding per question check, keyed by check identifier.
   * Default: every question check binds the single registered evaluator.
   * One stated map must name every question check and no other check.
   */
  readonly bindings?: Readonly<Record<string, string | ExplorationBinding>>;
  /** Starter parameters for every question check. Default: the documented starter policy. */
  readonly starter?: ExplorationStarterPolicy;
  /** Per-check starter parameters, overriding `starter` for the named check. */
  readonly starterChecks?: Readonly<Record<string, ExplorationStarterPolicy>>;
  /** Effective execution configuration overrides of the starter defaults. */
  readonly execution?: Partial<ExecutionConfig>;
}

/**
 * The documented starter policy: accept at 0.8 acceptable mass, reject at 0.6
 * unacceptable mass, and no confidence floor. The numbers state where a
 * developer starts. They carry no qualification evidence.
 */
const STARTER_POLICY: ExplorationStarterPolicy = Object.freeze({
  accept_cutoff: 0.8,
  rejection_cutoff: 0.6,
});

/** The starter execution configuration of one exploration profile. */
const STARTER_EXECUTION: ExecutionConfig = Object.freeze({
  max_active: 4,
  max_pending: 16,
  deadline_ms: 30000,
  max_attempts: 2,
  backoff_ms: 200,
});

/** The qualification scope that every exploration profile declares. */
const EXPLORATION_SCOPE =
  "Evaluation and shadow use during development. Enforcement needs one profile validated for scope, which starter thresholds never are.";

// ---------------------------------------------------------------------------
// The generator.
// ---------------------------------------------------------------------------

/**
 * Generates one signed exploration profile from one validated definition and
 * the registered evaluators.
 *
 * The returned artifact binds one evaluator per question check, records the
 * translated question that the adapter states or the validated question that
 * one translating-free adapter receives, takes the starter policy of
 * `options.starter`, `options.starterChecks`, or the documented defaults,
 * and states the effective execution configuration. The qualification stays
 * `unvalidated` with the reason `starter_policy`. The core validates the
 * complete artifact and its compatibility with the definition before the
 * value returns, so the profile loads in shadow mode as generated.
 *
 * Generation is deterministic: the same definition, registry, and options
 * produce the same artifact and the same content hash on every call.
 *
 * @throws {ValidationError} when the definition holds no question check,
 * when one stated binding names no registered evaluator or no question
 * check, when one question check holds no stated binding, when one starter
 * parameter breaks the policy contract, or when the assembled artifact fails
 * the core validation or the shadow compatibility check.
 */
export function createExplorationProfile(
  definition: Definition,
  evaluators: EvaluatorRegistry,
  options: ExplorationOptions = {},
): Profile {
  const definitionText = jsonText(definition);
  const info = throughCore(() => nativeValidateDefinition(definitionText));

  if (info.isExactOnly) {
    throw new ValidationError(
      "invalid_field_type",
      `The definition ${JSON.stringify(info.name)} holds exact rules only. Exact rules take the structural exact profile that load derives, and an exploration profile binds one evaluator per question check. Author one question check, or load the definition without one profile.`,
      "/checks",
    );
  }
  const questionChecks = info.checkKinds.filter((entry) => entry.kind !== "rule");
  const assigned = assignEvaluators(questionChecks, evaluators, options.bindings);

  const bindings: ProfileBinding[] = [];
  const live: LiveBindingEntry[] = [];
  for (const entry of questionChecks) {
    const check = definition.checks.find((named) => named.id === entry.id);
    if (check === undefined) {
      throw new Error(
        `measuretwice found no check artifact for ${JSON.stringify(entry.id)}. The core validated the definition, so this is one internal inconsistency.`,
      );
    }
    const question = validatedQuestion(entry.kind, check);
    const assignment = assigned.get(entry.id)!;
    const evaluator = assignment.evaluator;
    const translation = recordedTranslation(evaluator, question, entry.id);
    // No resolved model is recorded: generation measures nothing. One later
    // run that states one resolution compares it against the request.
    const binding: ProfileBinding = {
      check: entry.id,
      evaluator: evaluator.id,
      adapter_version: evaluator.adapter_version,
      translation,
      ...(assignment.model !== undefined ? { model: { requested: assignment.model } } : {}),
      ...(assignment.preprocessing !== undefined
        ? { preprocessing: assignment.preprocessing }
        : {}),
    };
    bindings.push(binding);
    const liveEntry: LiveBindingEntry = {
      check: entry.id,
      evaluator: evaluator.id,
      adapter_version: evaluator.adapter_version,
    };
    if (typeof evaluator.translate === "function") {
      liveEntry.translation = translation.content_hash;
    }
    live.push(liveEntry);
  }

  const policyChecks = questionChecks.map((entry) => {
    const starter = starterOf(entry.id, options);
    return {
      check: entry.id,
      accept_cutoff: starter.accept_cutoff,
      rejection_cutoff: starter.rejection_cutoff,
      ...(starter.confidence_floor !== undefined
        ? { confidence_floor: starter.confidence_floor }
        : {}),
    };
  });
  const execution: ExecutionConfig = {
    ...STARTER_EXECUTION,
    ...definedEntries(options.execution),
  };

  const artifact: Omit<Profile, "content_hash"> = {
    schema_version: 1,
    id: options.id ?? explorationId(info),
    origin: "exploration",
    intended_use:
      options.intendedUse ??
      `Development exploration of the definition ${info.name}. Not a measured population, and starter thresholds carry no qualification evidence.`,
    definition: { name: info.name, content_hash: info.definitionHash },
    bindings,
    policy: { family: "probability_mass_v0", checks: policyChecks },
    execution,
    qualification: {
      status: "unvalidated",
      scope: EXPLORATION_SCOPE,
      reasons: ["starter_policy"],
    },
  };
  const contentHash = throughCore(() =>
    nativeComputeSelfHash("profile", JSON.stringify(artifact)),
  );
  const profile: Profile = { ...artifact, content_hash: contentHash };

  // The core is the one validation authority: the complete artifact contract
  // with the stored self-hash, then the shadow compatibility of the binding.
  // The returned profile is one artifact that load accepts as generated.
  const profileText = JSON.stringify(profile);
  const validated = throughCore(() => nativeValidateProfile(profileText));
  if (
    validated.id !== profile.id ||
    validated.origin !== "exploration" ||
    validated.qualificationStatus !== "unvalidated"
  ) {
    throw new Error(
      "measuretwice generated one profile that the core read differently. This is one internal inconsistency.",
    );
  }
  throughCore(() =>
    nativeCheckProfileCompatibility(profileText, definitionText, live, "shadow"),
  );
  deepFreeze(profile);
  return profile;
}

// ---------------------------------------------------------------------------
// Binding resolution.
// ---------------------------------------------------------------------------

/** One resolved binding assignment of one question check. */
interface Assignment {
  readonly evaluator: Evaluator;
  readonly model?: string;
  readonly preprocessing?: string;
}

/**
 * Resolves the evaluator of every question check.
 *
 * Without one stated map, every question check binds the single registered
 * evaluator. One stated map must name every question check and no other
 * check, and every named evaluator must be registered.
 *
 * # Errors
 *
 * Returns one {@link ValidationError} with `evaluator_mismatch` when the
 * registry holds no unambiguous evaluator for one check, and with
 * `invalid_field_type` when one stated binding breaks its shape.
 */
function assignEvaluators(
  questionChecks: readonly Readonly<{ readonly id: string }>[],
  evaluators: EvaluatorRegistry,
  stated: ExplorationOptions["bindings"],
): Map<string, Assignment> {
  const assigned = new Map<string, Assignment>();
  if (stated === undefined) {
    if (evaluators.ids.length !== 1) {
      throw new ValidationError(
        "evaluator_mismatch",
        `The registry holds ${evaluators.ids.length} evaluators (${evaluators.ids.map((id) => JSON.stringify(id)).join(", ")}), so one unambiguous binding exists for no question check. State one bindings entry per question check: the check identifier naming the registered evaluator that serves it.`,
        "/bindings",
      );
    }
    const evaluator = evaluators.get(evaluators.ids[0]!)!;
    for (const entry of questionChecks) {
      assigned.set(entry.id, { evaluator });
    }
    return assigned;
  }

  for (const [check, spec] of Object.entries(stated)) {
    const base = `/bindings/${check}`;
    if (!questionChecks.some((entry) => entry.id === check)) {
      throw new ValidationError(
        "evaluator_mismatch",
        `The bindings entry ${JSON.stringify(check)} names no question check of the definition. One entry per question check: exact rule checks record their executed rule and bind no evaluator.`,
        base,
      );
    }
    const id = typeof spec === "string" ? spec : spec?.evaluator;
    if (typeof id !== "string" || id === "") {
      throw new ValidationError(
        "invalid_field_type",
        `The bindings entry of the check ${JSON.stringify(check)} states no evaluator identifier. Pass one registered evaluator identifier, or one object with one evaluator field.`,
        `${base}/evaluator`,
      );
    }
    const evaluator = evaluators.get(id);
    if (evaluator === undefined) {
      throw new ValidationError(
        "evaluator_mismatch",
        `The check ${JSON.stringify(check)} names the evaluator ${JSON.stringify(id)}, but no registered evaluator holds that identifier. The registry holds: ${evaluators.ids.map((named) => JSON.stringify(named)).join(", ") || "no entry"}. One loaded file installs no evaluator.`,
        `${base}/evaluator`,
      );
    }
    const model = typeof spec === "string" ? undefined : spec?.model;
    if (model !== undefined && (typeof model !== "string" || model === "" || model.length > 128)) {
      throw new ValidationError(
        "invalid_field_type",
        `The model of the check ${JSON.stringify(check)} states no nonempty identifier of at most 128 characters.`,
        `${base}/model/requested`,
      );
    }
    const preprocessing =
      typeof spec === "string" ? undefined : spec?.preprocessing;
    if (
      preprocessing !== undefined &&
      (typeof preprocessing !== "string" || preprocessing === "" || preprocessing.length > 128)
    ) {
      throw new ValidationError(
        "invalid_field_type",
        `The preprocessing identity of the check ${JSON.stringify(check)} states no nonempty string of at most 128 characters.`,
        `${base}/preprocessing`,
      );
    }
    assigned.set(check, {
      evaluator,
      ...(model !== undefined ? { model } : {}),
      ...(preprocessing !== undefined ? { preprocessing } : {}),
    });
  }
  for (const entry of questionChecks) {
    if (!assigned.has(entry.id)) {
      throw new ValidationError(
        "evaluator_mismatch",
        `The stated bindings name no evaluator for the question check ${JSON.stringify(entry.id)}. One stated map binds every question check.`,
        `/bindings/${entry.id}`,
      );
    }
  }
  return assigned;
}

/**
 * Records the translated question of one binding.
 *
 * One adapter that translates states the complete translated question and
 * its content hash; the recorded text is the canonical form of the stated
 * question, and the stated hash must cover exactly that text, so one
 * inconsistent adapter fails here instead of inside one stored profile. One
 * adapter that translates nothing receives the validated question unchanged,
 * so the record states that question, hashed in the same translation domain.
 */
function recordedTranslation(
  evaluator: Evaluator,
  question: ValidatedQuestion,
  check: string,
): { readonly content_hash: string; readonly question: string } {
  const base = `/bindings/${check}/translation`;
  if (typeof evaluator.translate !== "function") {
    const text = canonicalText(question, `${base}/question`);
    return {
      content_hash: throughCore(() => nativeContentHash("translation", text)),
      question: text,
    };
  }
  const translation = evaluator.translate(question);
  if (typeof translation !== "object" || translation === null) {
    throw new ValidationError(
      "invalid_field_type",
      `The evaluator ${JSON.stringify(evaluator.id)} resolved its translation of the check ${JSON.stringify(check)} without one result object.`,
      base,
    );
  }
  const stated = translation.question;
  if (stated === undefined) {
    throw new ValidationError(
      "invalid_field_type",
      `The evaluator ${JSON.stringify(evaluator.id)} translated the check ${JSON.stringify(check)} but stated no complete translated question. One binding records the complete question that the adapter sends, so its translate operation must return the question beside the content hash.`,
      `${base}/question`,
    );
  }
  const text = canonicalText(stated, `${base}/question`);
  const hash = throughCore(() => nativeContentHash("translation", text));
  if (hash !== translation.content_hash) {
    throw new ValidationError(
      "translation_mismatch",
      `The evaluator ${JSON.stringify(evaluator.id)} stated one content hash for the translated question of the check ${JSON.stringify(check)} that differs from the hash of the question it returned. The recorded pair must cover one question.`,
      `${base}/content_hash`,
    );
  }
  return { content_hash: translation.content_hash, question: text };
}

/** Reads the starter parameters of one check: the per-check entry, the global starter, or the documented default. */
function starterOf(
  check: string,
  options: ExplorationOptions,
): ExplorationStarterPolicy {
  return options.starterChecks?.[check] ?? options.starter ?? STARTER_POLICY;
}

/** Names one exploration profile after its definition. */
function explorationId(info: DefinitionInfo): string {
  const id = `${info.name}-exploration`;
  // The artifact identifier rule bounds the length at 64 characters.
  return id.length <= 64 ? id : `exploration-${info.definitionHash.slice(0, 51)}`;
}

// ---------------------------------------------------------------------------
// Wrapper helpers.
// ---------------------------------------------------------------------------

/** Runs one core operation and rethrows its failure as the public error. Mirrors the twin in `run.ts`. */
function throughCore<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof NativeFailure) {
      throw new ValidationError(error.code, error.message, error.fieldPath);
    }
    throw error;
  }
}

/** Serializes one artifact and rejects what JSON cannot preserve. Mirrors the twin in `run.ts`. */
function jsonText(value: unknown, fieldPath = ""): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new ValidationError(
      "nonportable_value",
      `The value ${fieldPath === "" ? "at the root" : `at ${fieldPath}`} holds one value that JSON cannot preserve: ${error instanceof Error ? error.message : String(error)}. Pass one JSON value.`,
      fieldPath,
    );
  }
}

/** Builds the canonical text of one translated question through the core. */
function canonicalText(value: unknown, fieldPath: string): string {
  return throughCore(() => nativeCanonicalForm(jsonText(value, fieldPath)));
}

/** Returns the defined entries of one partial record, without the absent keys. */
function definedEntries<T>(value: Readonly<Record<string, T>> | undefined): Record<string, T> {
  const entries: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry !== undefined) {
      entries[key] = entry;
    }
  }
  return entries;
}

/** Freezes one JSON value deeply. Mirrors the twins of the sibling modules. */
function deepFreeze(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    Object.freeze(value);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
}
