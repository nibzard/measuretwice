// SPDX-License-Identifier: Apache-2.0
//! Thin Node binding for the measuretwice core.
//!
//! The binding exposes the serializable operations of the core: definition
//! and case validation, input projection, canonical content hashes, the
//! exact string rules, report construction, and run state validation. It
//! makes no provider calls, holds no credentials, and writes no files.
//! Loading the binding performs no I/O beyond loading the shared library.
//! Public TypeScript types live in the `measuretwice` package, never here.
//!
//! Artifacts cross the boundary as strict JSON text, the one input shape the
//! core already owns: the strict gate in `measuretwice_core::json` rejects
//! malformed text, repeated keys, non-finite numbers, and unpaired
//! surrogates before any parser runs. Small structured results, such as the
//! projected inputs, cross as plain values.
//!
//! Every domain failure is thrown as one native error whose message is the
//! failure serialized as JSON: `code`, `message`, and `field_path`, exactly
//! as the `ValidationError` contract states them. `native.ts` in the public
//! package parses that message back into one stable TypeScript error, so no
//! safe cause is lost. Failures of the bridge itself, such as a JavaScript
//! argument of the wrong type, throw ordinary native errors that carry no
//! domain data.

#[macro_use]
extern crate napi_derive;

use measuretwice_core::error::{ReasonCode, ValidationError};
use measuretwice_core::report::parse_check_record;
use measuretwice_core::run_state::AttemptResolution;
use measuretwice_core::{assessment, case, definition, hashing, json, report, rule, run_state};
use serde_json::Value;

// Every exported signature states `Result<T, napi::Error>` in full. The
// derive macro detects a thrown failure by reading the `Result` path, so a
// type alias would hide the error channel and return the failure as a value
// instead of throwing it.

/// Converts one validation failure into the thrown native error.
///
/// The message is the failure serialized as JSON. The wrapper layer is the
/// only reader of that message, and it rebuilds the failure from the same
/// three fields the Rust contract states.
fn failure(error: ValidationError) -> napi::Error {
    let reason = serde_json::to_string(&error).unwrap_or_else(|_| error.to_string());
    napi::Error::new(napi::Status::GenericFailure, reason)
}

/// Lifts one core result into the binding result.
fn lift<T>(result: Result<T, ValidationError>) -> Result<T, napi::Error> {
    result.map_err(failure)
}

/// Parses one artifact through the strict JSON gate.
fn strict(text: &str) -> Result<Value, napi::Error> {
    lift(json::parse_strict(text))
}

/// The kind of one check of a validated definition, as the contracts name it.
#[napi(object)]
pub struct CheckKindEntry {
    /// The check identifier.
    pub id: String,
    /// The semantic kind: rule, categorical, binary, or ordered.
    pub kind: String,
}

/// The result of validating one definition artifact.
#[napi(object)]
pub struct DefinitionInfo {
    /// The definition name.
    pub name: String,
    /// The definition-domain content hash.
    pub definition_hash: String,
    /// The effective uncertainty behavior. An omitted `when_uncertain`
    /// means review, the one documented default.
    pub effective_when_uncertain: String,
    /// Whether every check of the definition is an exact rule.
    pub is_exact_only: bool,
    /// The kind of every check, in definition order.
    pub check_kinds: Vec<CheckKindEntry>,
}

/// Returns the portable contract schema version implemented by the core.
#[napi]
pub fn contract_version() -> u32 {
    measuretwice_core::CONTRACT_SCHEMA_VERSION
}

/// Validates one definition artifact and establishes every check meaning.
///
/// The definition text must pass the strict JSON gate and every contract
/// invariant: unique check identifiers, declared inputs, disjoint label
/// selections, closed scales, and an input schema inside the supported
/// subset.
#[napi]
pub fn validate_definition(definition_text: String) -> Result<DefinitionInfo, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let artifact = validated.as_definition();
    Ok(DefinitionInfo {
        name: artifact.name.clone(),
        definition_hash: hashing::definition_hash(&validated),
        effective_when_uncertain: when_uncertain_word(validated.effective_when_uncertain())
            .to_owned(),
        is_exact_only: validated.is_exact_only(),
        check_kinds: artifact
            .checks
            .iter()
            .zip(validated.check_kinds())
            .map(|(check, kind)| CheckKindEntry {
                id: check.id.clone(),
                kind: check_word(*kind).to_owned(),
            })
            .collect(),
    })
}

/// The authorized inputs of one check, projected for one evaluator request.
#[napi(object)]
pub struct ProjectedInputsEntry {
    /// The check that these inputs serve.
    pub check_id: String,
    /// The declared inputs of the check, by name. No other field appears
    /// here.
    pub inputs: Value,
}

/// The result of validating one case against one definition.
#[napi(object)]
pub struct CaseInfo {
    /// The stable case identifier.
    pub id: String,
    /// The input-domain content hash of the complete input object.
    pub input_hash: String,
    /// The projection of every check, in definition order.
    pub projected_inputs: Vec<ProjectedInputsEntry>,
}

/// Validates one case against one validated definition and projects the
/// authorized inputs of every check.
///
/// The case text must pass the strict JSON gate and the case envelope, and
/// the input object must satisfy the definition input schema and every
/// published data limit. Validation fails before any evaluator call.
#[napi]
pub fn validate_case(definition_text: String, case_text: String) -> Result<CaseInfo, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let validated_case = lift(case::validate_case_str(&case_text, &validated))?;
    Ok(CaseInfo {
        id: validated_case.id().to_owned(),
        input_hash: hashing::input_hash(validated_case.input()),
        projected_inputs: validated_case
            .projected_inputs()
            .into_iter()
            .map(|projected| ProjectedInputsEntry {
                check_id: projected.check_id,
                inputs: Value::Object(projected.inputs),
            })
            .collect(),
    })
}

/// One assessed exact rule with the record text that reports it.
#[napi(object)]
pub struct RuleAssessment {
    /// The assessed check identifier.
    pub check: String,
    /// The outcome of the executed rule: pass or fail.
    pub outcome: String,
    /// The executed rule with its parameter and its one input.
    pub applied_rule: Value,
    /// The sanitized explanation of the outcome.
    pub reason: String,
    /// The serialized check record of this result. Pass this text unchanged
    /// to `acceptResult`.
    pub record: String,
}

/// Assesses every exact rule of one case, in definition order.
///
/// Question checks stay outside, because they need an evaluator. A
/// definition and a case that validate cannot fail this step.
#[napi]
pub fn assess_rule_checks(
    definition_text: String,
    case_text: String,
) -> Result<Vec<RuleAssessment>, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let validated_case = lift(case::validate_case_str(&case_text, &validated))?;
    let results = lift(rule::assess_rule_checks(&validated_case))?;
    Ok(results
        .iter()
        .map(|result| RuleAssessment {
            check: result.check.clone(),
            outcome: result.outcome.as_str().to_owned(),
            applied_rule: serde_json::to_value(&result.applied_rule).expect("serializes"),
            reason: result.reason.clone(),
            record: serde_json::to_string(&report::CheckRecord::from_rule_result(result))
                .expect("serializes"),
        })
        .collect())
}

/// The result of validating one assessment against its check.
#[napi(object)]
pub struct AssessmentInfo {
    /// The assessed check identifier.
    pub check: String,
    /// The answer kind of the assessment, as the core read it.
    pub kind: String,
    /// The validated assessment, unchanged. The run report records this
    /// value exactly as it stands here.
    pub assessment: Value,
}

/// Validates one normalized assessment against the check that asked for it.
///
/// The definition text must pass the strict JSON gate and the definition
/// contract. The assessment text must pass the strict gate, the structural
/// assessment schema, and the semantic rules of its check: the matching
/// kind, the declared labels and levels, one position inside the scale, one
/// distribution that names declared answers or levels and sums to one, and
/// evidence references that the `using` list authorizes. A failure throws
/// `invalid_assessment` with the field path of the broken rule.
#[napi]
pub fn validate_assessment(
    definition_text: String,
    check_id: String,
    assessment_text: String,
) -> Result<AssessmentInfo, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let value = strict(&assessment_text)?;
    lift(assessment::validate_assessment(
        &validated, &check_id, &value,
    ))?;
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok(AssessmentInfo {
        check: check_id,
        kind,
        assessment: value,
    })
}

/// Builds the canonical form of one strict JSON document.
///
/// Two values with one parsed meaning produce one canonical form, whatever
/// their formatting, key order, or number spelling was. Array order stays.
#[napi]
pub fn canonical_form(text: String) -> Result<String, napi::Error> {
    let value = strict(&text)?;
    Ok(hashing::canonical_form(&value))
}

/// Reads one hash domain from its contract tag, or rejects the text.
fn domain_from_tag(tag: &str) -> Result<hashing::Domain, napi::Error> {
    hashing::Domain::from_tag(tag).ok_or_else(|| {
        failure(ValidationError::invalid_field_type(
            "/domain",
            "The domain must be definition, input, translation, profile, plan, dataset, or split.",
        ))
    })
}

/// Computes the content hash of one strict JSON document in one domain.
///
/// The result is the SHA-256 of the domain tag, one zero byte, and the
/// canonical form, written as 64 lowercase hexadecimal characters.
#[napi]
pub fn content_hash(domain: String, text: String) -> Result<String, napi::Error> {
    let value = strict(&text)?;
    let domain = domain_from_tag(&domain)?;
    Ok(hashing::content_hash(domain, &value))
}

/// Computes the self-hash of one profile or plan artifact.
///
/// The canonical form covers the complete artifact with its own
/// `content_hash` field removed. The generator validates every other field
/// first, then inserts the returned digest.
#[napi]
pub fn compute_self_hash(domain: String, artifact_text: String) -> Result<String, napi::Error> {
    let value = strict(&artifact_text)?;
    let domain = domain_from_tag(&domain)?;
    lift(hashing::compute_self_hash(domain, &value))
}

/// Verifies the stored self-hash of one profile or plan artifact.
///
/// A stored value that differs from the computed digest fails with
/// `hash_mismatch`. The artifact is an edited or corrupted copy.
#[napi]
pub fn verify_self_hash(domain: String, artifact_text: String) -> Result<(), napi::Error> {
    let value = strict(&artifact_text)?;
    let domain = domain_from_tag(&domain)?;
    lift(hashing::verify_self_hash(domain, &value))
}

/// Computes the dataset-domain content hash of one record set.
///
/// The boundary covers the complete case records as one array, ordered by
/// case identifier, so reordering the records does not change the hash.
/// The records text must hold one strict JSON array.
#[napi]
pub fn dataset_hash(records_text: String) -> Result<String, napi::Error> {
    let value = strict(&records_text)?;
    let Value::Array(records) = value else {
        return lift(Err(ValidationError::invalid_field_type(
            "",
            "The dataset must be one array of case records.",
        )));
    };
    lift(hashing::dataset_hash(&records))
}

/// Computes the split-domain content hash of one record set.
///
/// The boundary and the failures match `datasetHash`. The split tag keeps
/// the same records from sharing one hash with the complete dataset.
#[napi]
pub fn split_hash(records_text: String) -> Result<String, napi::Error> {
    let value = strict(&records_text)?;
    let Value::Array(records) = value else {
        return lift(Err(ValidationError::invalid_field_type(
            "",
            "The split must be one array of case records.",
        )));
    };
    lift(hashing::split_hash(&records))
}

/// The observable state of one check of a run.
#[napi(object)]
pub struct CheckStatusInfo {
    /// Where the check sits: pending, active, or recorded.
    pub place: String,
    /// Attempts started, counting the first attempt and every retry.
    pub attempts: u32,
}

/// The resolution of one failed attempt.
#[napi(object)]
pub struct AttemptOutcome {
    /// Whether the check returns to the queue, or its attempt budget is
    /// spent and it recorded one error outcome.
    pub resolution: String,
    /// Attempts started so far, counting the attempt that just failed. Only
    /// a retrying check states it.
    pub attempts: Option<u32>,
}

/// One validated run of one case, driven through the core state boundary.
///
/// The wrapper owns the queue, the deadline, the backoff, and the
/// cancellation. It states each event to this boundary, which validates it
/// against the checked execution model before any state changes. A refusal
/// throws and changes no state. After one terminal event, `reportText`
/// returns the frozen report and every further event is refused.
#[napi]
pub struct RunState {
    inner: run_state::RunState,
}

/// Starts one run of one case.
///
/// The definition text and both reference texts must pass the strict JSON
/// gate. The case reference plus the profile reference fix the run binding:
/// every accepted attempt repeats both, and a drifted offer is refused.
#[napi]
pub fn create_run_state(
    definition_text: String,
    case_reference_text: String,
    profile_reference_text: String,
    run_id: String,
    mode: String,
    max_attempts: f64,
) -> Result<RunState, napi::Error> {
    let validated = lift(definition::validate_definition_str(&definition_text))?;
    let case_reference = case_reference(&case_reference_text)?;
    let profile_reference = profile_reference(&profile_reference_text)?;
    let mode = report::RunMode::from_word(&mode).ok_or_else(|| {
        failure(ValidationError::invalid_field_type(
            "/mode",
            "The run mode must be shadow or enforcement.",
        ))
    })?;
    // The number is read as a double so that a fractional or wrapped value
    // cannot slip through an integer conversion unnoticed.
    if !max_attempts.is_finite()
        || max_attempts.fract() != 0.0
        || !(1.0..=u32::MAX as f64).contains(&max_attempts)
    {
        return lift(Err(ValidationError::invalid_field_type(
            "/max_attempts",
            "The attempt limit must be a whole number from 1 to 4294967295.",
        )));
    }
    let limits = run_state::RunLimits {
        max_attempts: max_attempts as u32,
    };
    let inner = lift(run_state::RunState::new(
        &validated,
        case_reference,
        profile_reference,
        run_id,
        mode,
        limits,
    ))?;
    Ok(RunState { inner })
}

/// Parses one case reference from its strict JSON text.
fn case_reference(text: &str) -> Result<report::CaseReference, napi::Error> {
    let value = strict(text)?;
    lift(report::parse_case_reference(Some(&value), "/case"))
}

/// Parses one profile reference from its strict JSON text.
fn profile_reference(text: &str) -> Result<report::ProfileReference, napi::Error> {
    let value = strict(text)?;
    lift(report::parse_profile_reference(Some(&value), "/profile"))
}

#[napi]
impl RunState {
    /// The phase of the run: running, completed, cancelled, or
    /// deadline_exceeded. Every phase except running is terminal.
    #[napi(getter)]
    pub fn phase(&self) -> String {
        match self.inner.phase() {
            run_state::Phase::Running => "running",
            run_state::Phase::Completed => "completed",
            run_state::Phase::Cancelled => "cancelled",
            run_state::Phase::DeadlineExceeded => "deadline_exceeded",
        }
        .to_owned()
    }

    /// The identifiers of every check of the run, in definition order.
    #[napi]
    pub fn check_ids(&self) -> Vec<String> {
        self.inner.check_ids().map(str::to_owned).collect()
    }

    /// The observable state of one check, or null when the identifier names
    /// no check of this run.
    #[napi]
    pub fn status(&self, check_id: String) -> Option<CheckStatusInfo> {
        self.inner.status(&check_id).map(|status| CheckStatusInfo {
            place: match status.place {
                run_state::CheckPlace::Pending => "pending",
                run_state::CheckPlace::Active => "active",
                run_state::CheckPlace::Recorded => "recorded",
            }
            .to_owned(),
            attempts: status.attempts,
        })
    }

    /// Starts the next attempt of one check, offering the run binding.
    ///
    /// The boundary refuses a drifted offer: the case identity, the case
    /// input hash, the profile identity, and the profile content hash must
    /// equal the run binding. Returns the attempts started so far.
    #[napi]
    pub fn start_attempt(
        &mut self,
        check_id: String,
        case_reference_text: String,
        profile_reference_text: String,
    ) -> Result<u32, napi::Error> {
        let case = case_reference(&case_reference_text)?;
        let profile = profile_reference(&profile_reference_text)?;
        lift(self.inner.start_attempt(&check_id, &case, &profile))
    }

    /// Resolves one in-flight attempt with an operational failure.
    ///
    /// The code must name an operational failure: evaluator_error,
    /// evaluator_timeout, or invalid_assessment. With attempts left, the
    /// check returns to the queue. Without attempts left, it records one
    /// error outcome.
    #[napi]
    pub fn fail_attempt(
        &mut self,
        check_id: String,
        code: String,
        message: String,
    ) -> Result<AttemptOutcome, napi::Error> {
        let code = ReasonCode::from_registry(&code).ok_or_else(|| {
            failure(ValidationError::invalid_field_type(
                "/code",
                "An attempt failure must carry an operational reason code: evaluator_error, evaluator_timeout, or invalid_assessment.",
            ))
        })?;
        lift(self.inner.fail_attempt(&check_id, code, &message)).map(
            |resolution| match resolution {
                AttemptResolution::RetryQueued { attempts } => AttemptOutcome {
                    resolution: "retry_queued".to_owned(),
                    attempts: Some(attempts),
                },
                AttemptResolution::Exhausted => AttemptOutcome {
                    resolution: "exhausted".to_owned(),
                    attempts: None,
                },
            },
        )
    }

    /// Resolves one in-flight attempt with its component record.
    ///
    /// The record text must hold one check record of the run report
    /// contract. An exact-rule record comes from `assessRuleChecks`; a
    /// question record comes from a validated assessment. The boundary
    /// refuses a late, duplicate, or mismatched result.
    #[napi]
    pub fn accept_result(
        &mut self,
        check_id: String,
        record_text: String,
    ) -> Result<(), napi::Error> {
        let value = strict(&record_text)?;
        let record = lift(parse_check_record(&value, ""))?;
        lift(self.inner.accept_result(&check_id, record))
    }

    /// Records one skipped outcome with reason queue_full for work that
    /// never started. The wrapper calls this when its pending-work limit
    /// cannot accept the check.
    #[napi]
    pub fn skip_queue_full(&mut self, check_id: String) -> Result<(), napi::Error> {
        lift(self.inner.skip_queue_full(&check_id))
    }

    /// Cancels the run and freezes its report.
    ///
    /// `completedAt` states the terminal time the wrapper observed. The
    /// boundary reads no clock.
    #[napi]
    pub fn cancel(&mut self, completed_at: Option<String>) -> Result<(), napi::Error> {
        lift(self.inner.cancel(completed_at.as_deref()))
    }

    /// Ends the run at its total deadline and freezes its report.
    #[napi]
    pub fn deadline(&mut self, completed_at: Option<String>) -> Result<(), napi::Error> {
        lift(self.inner.deadline(completed_at.as_deref()))
    }

    /// Completes the run and freezes its report. Every check must already
    /// hold its record.
    #[napi]
    pub fn complete(&mut self, completed_at: Option<String>) -> Result<(), napi::Error> {
        lift(self.inner.complete(completed_at.as_deref()))
    }

    /// The serialized run report, present once the run reached a terminal
    /// state. The report is immutable: no later event can change it.
    #[napi]
    pub fn report_text(&self) -> Option<String> {
        self.inner
            .report()
            .map(|report| serde_json::to_string(report).expect("the report serializes"))
    }
}

/// Names one check kind with its contract word.
fn check_word(kind: definition::CheckKind) -> &'static str {
    match kind {
        definition::CheckKind::Rule => "rule",
        definition::CheckKind::Categorical => "categorical",
        definition::CheckKind::Binary => "binary",
        definition::CheckKind::Ordered => "ordered",
    }
}

/// Names one uncertainty behavior with its contract word.
fn when_uncertain_word(value: definition::WhenUncertain) -> &'static str {
    match value {
        definition::WhenUncertain::Review => "review",
    }
}
