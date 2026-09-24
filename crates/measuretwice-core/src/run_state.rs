// SPDX-License-Identifier: Apache-2.0
//! Deterministic run state transitions for one run of one case.
//!
//! This module is the Rust side of the state boundary that `MVP_SPEC.md`
//! section 5 defines: the wrapper owns the queue, the deadline, the backoff,
//! and the cancellation, and every run transition passes through this
//! boundary before it changes run state. The checked TLA+ model in
//! `models/execution/Execution.tla` fixes the rules. Its record in
//! `models/execution/README.md` maps each model transition to its
//! implementation obligation. This module discharges the rows that name
//! T015:
//!
//! | Boundary method | Model transitions |
//! | --- | --- |
//! | [`RunState::start_attempt`] | `SubmitStart`, `StartRetry` |
//! | [`RunState::start_attempt`] refusals | `SubmitDrift`, `RetryDrift` |
//! | [`RunState::skip_queue_full`] | `SubmitSkipped`, minus the queue arithmetic the wrapper owns |
//! | [`RunState::fail_attempt`] | `AttemptFail`, retry branch |
//! | [`RunState::fail_permanent`] | `AttemptFail`, permanent branch |
//! | [`RunState::accept_result`] | `AcceptResult` |
//! | [`RunState::accept_result`] refusals | `DuplicateResult`, `LateResult` |
//! | [`RunState::cancel`] | `Cancel` |
//! | [`RunState::deadline`] | `Deadline` |
//! | [`RunState::complete`] | `Complete` |
//!
//! The model leaves queue admission (`SubmitQueued`) to the wrapper, so the
//! one [`CheckPlace::Pending`] place covers the model places `unadmitted`
//! and `waiting`. The wrapper keeps their distinction for its pending-work
//! accounting. Time is an environment event in the model, so the boundary
//! reads no clock: the wrapper states the terminal time it observed.
//!
//! Four rules of the model hold here by construction:
//!
//! - The run binding is fixed at construction. The case identity, the case
//!   input hash, the profile identity, and the profile content hash of every
//!   accepted attempt equal the run binding, so a retry cannot switch either
//!   identity (`AttemptBindingStable`). A drifted offer is refused and changes
//!   no state.
//! - The wrapper owns the retry policy. One retryable failure returns the
//!   check to the wrapper while attempts remain; one permanent failure
//!   records its error at the failing attempt, whatever attempts remain, so
//!   one adapter defect never spends dummy attempts to reach a record.
//! - An error or a skipped record never becomes a pass, a fail, or a review
//!   (`NoErrorSkipToPass`). A recorded check accepts no further event.
//! - A terminal run accepts no transition (`TerminalReportFrozen`). The
//!   terminal methods build one immutable [`RunReport`] through
//!   [`ReportBuilder`], which offers read access only.
//! - A terminal report records every check of the run
//!   (`TerminalRecordsComplete`), because the terminal transitions assign a
//!   record to every check that holds none.
//!
//! Every refusal returns one [`ValidationError`] with a stable registry code
//! and changes no state, which is the model's refusal event: the wrapper
//! records the rejection and the report stays as it was. The boundary holds
//! no provider client, no clock, and no storage. It never calls wrapper code.

use crate::definition::ValidatedDefinition;
use crate::error::{ReasonCode, ValidationError};
use crate::report::{
    ArtifactReference, Baseline, CaseReference, CheckRecord, Completion, CompletionStatus, Outcome,
    ProfileReference, RecordKind, ReportBuilder, RunMode, RunReport, SanitizedReason,
};
use crate::rule::AppliedRule;

/// The cause of a `run_cancelled` error record.
const CANCELLED_WHILE_ACTIVE: &str = "The caller cancelled the run while this check was executing.";

/// The cause of a `cancelled_before_start` skip record.
const CANCELLED_BEFORE_START: &str = "The caller cancelled the run before this check started.";

/// The cause of a `deadline_exceeded` error record.
const DEADLINE_WHILE_ACTIVE: &str = "The total run deadline passed while this check was executing.";

/// The cause of a `deadline_before_start` skip record.
const DEADLINE_BEFORE_START: &str = "The total run deadline passed before this check started.";

/// The cause of a `queue_full` skip record.
const QUEUE_FULL: &str = "The pending-work limit stopped this check before it started.";

/// The execution limits that the state boundary validates.
///
/// The wrapper owns the queue, the total deadline, and the backoff. The one
/// limit the boundary needs is the attempt budget of a check, because a start
/// beyond the budget fits no valid transition.
///
/// The limits come from the effective execution configuration that
/// `profile.execution` states. They bind one run and never change inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunLimits {
    /// Attempts per check, counting the first attempt. At least 1.
    pub max_attempts: u32,
}

impl RunLimits {
    /// Checks the limits against their contract bounds.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_field_type` when the
    /// attempt limit is zero. A run with no attempt could record no outcome,
    /// so the model bounds attempts from below by one.
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.max_attempts == 0 {
            return Err(ValidationError::invalid_field_type(
                "/max_attempts",
                "The attempt limit must be at least 1.",
            ));
        }
        Ok(())
    }
}

/// The phase of one run: `running`, or one terminal phase.
///
/// The model phases are `running`, `completed`, `cancelled`, and `deadline`.
/// Every phase except `running` is terminal. A terminal run accepts no
/// transition, so its report cannot change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// The run accepts transitions.
    Running,
    /// Every check holds a record and no work is left.
    Completed,
    /// The caller cancelled the run.
    Cancelled,
    /// The total run deadline passed.
    DeadlineExceeded,
}

impl Phase {
    /// Returns true when this phase accepts no further transition.
    pub const fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }

    /// Returns the completion status of this phase, or `None` while the run
    /// is still running.
    pub const fn completion(self) -> Option<CompletionStatus> {
        match self {
            Self::Running => None,
            Self::Completed => Some(CompletionStatus::Completed),
            Self::Cancelled => Some(CompletionStatus::Cancelled),
            Self::DeadlineExceeded => Some(CompletionStatus::DeadlineExceeded),
        }
    }
}

/// Where one check of the run sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckPlace {
    /// The check holds no record and no attempt is in flight. This one place
    /// covers the model places `unadmitted` and `waiting`, because the
    /// wrapper owns the queue between them.
    Pending,
    /// One attempt of the check is in flight.
    Active,
    /// The check holds its terminal record.
    Recorded,
}

/// The observable state of one check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckStatus {
    /// Where the check sits.
    pub place: CheckPlace,
    /// Attempts started, counting the first attempt and every retry.
    pub attempts: u32,
}

/// The resolution of one failed attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptResolution {
    /// Attempts remain, so the check returns to the queue with its binding
    /// kept. The wrapper owns the retry policy and the backoff, and starts
    /// the next attempt only when it retries the failure.
    RetryQueued {
        /// Attempts started so far, counting the attempt that just failed.
        attempts: u32,
    },
    /// The attempt budget is spent. The check recorded one `error` outcome.
    Exhausted,
}

/// The per-check state that the boundary tracks. One slot exists for every
/// check of the definition, in definition order.
#[derive(Debug, Clone)]
struct CheckSlot {
    /// The check identifier.
    id: String,
    /// Whether the check puts a question or a rule to work.
    kind: RecordKind,
    /// The rule of the check, for a rule check. The records that the boundary
    /// constructs for an unexecuted rule check state the rule they did not
    /// run, as the report contract requires.
    applied_rule: Option<AppliedRule>,
    /// Where the check sits.
    place: CheckPlace,
    /// Attempts started, counting the first attempt.
    attempts: u32,
    /// The record of the check, once it holds one.
    record: Option<CheckRecord>,
}

/// One validated run of one case: the state machine of the execution model.
///
/// The value states that the run passed no transition outside this boundary.
/// Every method is one model transition or one model refusal:
///
/// 1. Construct with [`RunState::new`] at submit. The run binding, the case
///    reference plus the profile reference, is fixed here and never changes.
///    The shadow baseline of the run is fixed here too. It is report data,
///    recorded beside the new outcome at the terminal event, and no
///    transition reads it.
/// 2. The wrapper starts attempts with [`RunState::start_attempt`], offering
///    the binding of the attempt. The boundary refuses a drifted offer.
/// 3. The wrapper resolves each attempt with [`RunState::accept_result`],
///    [`RunState::fail_attempt`], or [`RunState::fail_permanent`]. A
///    duplicate or late result is refused.
/// 4. The wrapper may skip never-started work with
///    [`RunState::skip_queue_full`] when its queue cannot accept the work.
/// 5. One terminal method ends the run: [`RunState::cancel`],
///    [`RunState::deadline`], or [`RunState::complete`]. It assigns a record
///    to every check that holds none and builds the immutable report.
///
/// After the terminal method, [`RunState::report`] returns the frozen
/// [`RunReport`] and every further event is refused.
#[derive(Debug, Clone)]
pub struct RunState {
    /// One slot per check of the definition, in definition order.
    slots: Vec<CheckSlot>,
    /// The phase of the run.
    phase: Phase,
    /// The run identifier, supplied by the wrapper or host.
    run_id: String,
    /// How the host declared the run.
    mode: RunMode,
    /// The definition reference of the run.
    definition: ArtifactReference,
    /// The profile binding of the run.
    profile: ProfileReference,
    /// The case binding of the run.
    case: CaseReference,
    /// The shadow baseline of the run, present when the host stated one.
    baseline: Option<Baseline>,
    /// The effective execution limits.
    limits: RunLimits,
    /// The frozen report, present after the terminal transition.
    report: Option<RunReport>,
}

impl RunState {
    /// Starts one run of one case against one validated definition.
    ///
    /// The check set comes from the definition, so the run cannot lose or
    /// invent a check. The run binding is the `case` reference plus the
    /// `profile` reference, and every accepted attempt repeats it. The
    /// optional `baseline` records the existing decision of the host beside
    /// the new outcome. It is shadow-mode data, and the boundary validates it
    /// here, so one broken baseline refuses the run before any attempt
    /// starts.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] when the run identifier breaks its
    /// bound, when the attempt limit is zero, when a reference breaks its
    /// contract rule, or when the baseline reaches the run in enforcement
    /// mode or outside its bounds.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        definition: &ValidatedDefinition,
        case: CaseReference,
        profile: ProfileReference,
        run_id: impl Into<String>,
        mode: RunMode,
        baseline: Option<Baseline>,
        limits: RunLimits,
    ) -> Result<Self, ValidationError> {
        limits.validate()?;
        let run_id = run_id.into();
        if run_id.is_empty() || run_id.chars().count() > 128 {
            return Err(ValidationError::invalid_field_type(
                "/run_id",
                "The run identifier must hold 1 to 128 characters.",
            ));
        }
        case.validate("/case")?;
        profile.validate("/profile")?;
        Baseline::validate_for_mode(mode, baseline.as_ref())?;

        let mut slots = Vec::new();
        for (check, kind) in definition
            .as_definition()
            .checks
            .iter()
            .zip(definition.check_kinds())
        {
            // A rule check keeps its rule, so the boundary can state the rule
            // in a record for work that never executed. Definition validation
            // guarantees that a rule check names exactly one using input.
            let applied_rule = check
                .rule
                .as_ref()
                .map(|rule| AppliedRule::new(rule.clone(), check.using[0].clone()));
            slots.push(CheckSlot {
                id: check.id.clone(),
                kind: RecordKind::of(*kind),
                applied_rule,
                place: CheckPlace::Pending,
                attempts: 0,
                record: None,
            });
        }
        Ok(Self {
            slots,
            phase: Phase::Running,
            run_id,
            mode,
            definition: ArtifactReference::for_definition(definition),
            profile,
            case,
            baseline,
            limits,
            report: None,
        })
    }

    /// Returns the phase of the run.
    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Returns the case binding of the run. Every accepted attempt repeats
    /// this identity and this input hash.
    pub fn binding_case(&self) -> &CaseReference {
        &self.case
    }

    /// Returns the profile binding of the run. Every accepted attempt repeats
    /// this identity and this content hash.
    pub fn binding_profile(&self) -> &ProfileReference {
        &self.profile
    }

    /// Returns the shadow baseline of the run, when the host stated one.
    ///
    /// The baseline records the existing decision beside the new outcome. No
    /// transition reads it, and it changes no record, so the run outcome and
    /// the baseline stay two separate facts of one report.
    pub fn baseline(&self) -> Option<&Baseline> {
        self.baseline.as_ref()
    }

    /// Returns the effective execution limits of the run.
    pub fn limits(&self) -> RunLimits {
        self.limits
    }

    /// Returns the identifiers of every check of the run, in definition
    /// order.
    pub fn check_ids(&self) -> impl Iterator<Item = &str> + '_ {
        self.slots.iter().map(|slot| slot.id.as_str())
    }

    /// Returns the observable state of one check, or `None` when the
    /// identifier names no check of this run.
    pub fn status(&self, check_id: &str) -> Option<CheckStatus> {
        self.slots
            .iter()
            .find(|slot| slot.id == check_id)
            .map(|slot| CheckStatus {
                place: slot.place,
                attempts: slot.attempts,
            })
    }

    /// Returns the recorded outcome of one check, or `None` when the check
    /// holds no record or names no check of this run.
    pub fn outcome_of(&self, check_id: &str) -> Option<Outcome> {
        self.slots
            .iter()
            .find(|slot| slot.id == check_id)
            .and_then(|slot| slot.record.as_ref())
            .map(|record| record.outcome)
    }

    /// Returns the frozen report, present once the run reached a terminal
    /// state. The report offers read access only, so no later event can
    /// change it.
    pub fn report(&self) -> Option<&RunReport> {
        self.report.as_ref()
    }

    /// Starts the next attempt of one check, offering the binding of the
    /// attempt. Implements `SubmitStart` and `StartRetry` with their drift
    /// refusals.
    ///
    /// The boundary validates that the run is still running, that the check
    /// is startable, that the attempt budget is not spent, and that the
    /// offered case and profile binding equal the run binding. An accepted
    /// start binds the attempt to the run binding and counts it.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_state_transition` when the
    /// run is terminal, when the identifier names no check of this run, when
    /// the check holds a record or an attempt is in flight, when the attempt
    /// budget is spent, or when the offered binding differs from the run
    /// binding. No refusal changes state.
    pub fn start_attempt(
        &mut self,
        check_id: &str,
        case: &CaseReference,
        profile: &ProfileReference,
    ) -> Result<u32, ValidationError> {
        self.ensure_running()?;
        let index = self.slot_index(check_id)?;
        let slot = &self.slots[index];
        match slot.place {
            CheckPlace::Pending => {}
            CheckPlace::Active => {
                return Err(invalid_state(
                    "/check",
                    "An attempt is already in flight for this check.",
                ));
            }
            CheckPlace::Recorded => {
                return Err(invalid_state(
                    "/check",
                    "The check already holds its record. A start fits no valid transition.",
                ));
            }
        }
        if slot.attempts >= self.limits.max_attempts {
            return Err(invalid_state(
                "/attempts",
                "The attempt budget of this check is spent.",
            ));
        }
        if case.id != self.case.id {
            return Err(invalid_state(
                "/case/id",
                "The offered case identifier differs from the run binding. An attempt cannot switch it.",
            ));
        }
        if case.input_hash != self.case.input_hash {
            return Err(invalid_state(
                "/case/input_hash",
                "The offered case input hash differs from the run binding. An attempt cannot switch it.",
            ));
        }
        if profile.id != self.profile.id {
            return Err(invalid_state(
                "/profile/id",
                "The offered profile identifier differs from the run binding. An attempt cannot switch it.",
            ));
        }
        if profile.content_hash != self.profile.content_hash {
            return Err(invalid_state(
                "/profile/content_hash",
                "The offered profile content hash differs from the run binding. An attempt cannot switch it.",
            ));
        }
        let slot = &mut self.slots[index];
        slot.attempts += 1;
        slot.place = CheckPlace::Active;
        Ok(slot.attempts)
    }

    /// Resolves one in-flight attempt with an operational failure. Implements
    /// `AttemptFail`.
    ///
    /// With attempts left, the check returns to the queue with its binding
    /// kept and the wrapper schedules the retry. Without attempts left, the
    /// check records one `error` outcome. The record keeps the attempt count
    /// and states the final reason: `retries_exhausted` after more than one
    /// attempt, or the operational code of the single failed attempt, as the
    /// runtime traces fix both cases.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_state_transition` when the
    /// run is terminal or no attempt of the check is in flight, and one with
    /// `invalid_field_type` when the code names no operational failure. No
    /// refusal changes state.
    pub fn fail_attempt(
        &mut self,
        check_id: &str,
        code: ReasonCode,
        message: &str,
    ) -> Result<AttemptResolution, ValidationError> {
        self.ensure_running()?;
        require_operational_code(code)?;
        let index = self.slot_index(check_id)?;
        let slot = &self.slots[index];
        if slot.place != CheckPlace::Active {
            return Err(invalid_state(
                "/check",
                "No attempt is in flight for this check. A failure fits no valid transition.",
            ));
        }
        let attempts = slot.attempts;
        if attempts < self.limits.max_attempts {
            let slot = &mut self.slots[index];
            slot.place = CheckPlace::Pending;
            return Ok(AttemptResolution::RetryQueued { attempts });
        }
        let (final_code, final_message) = if attempts > 1 {
            (
                ReasonCode::RetriesExhausted,
                format!("All {attempts} attempts failed. The last failure reported {code}."),
            )
        } else {
            (code, message.to_owned())
        };
        let reason = SanitizedReason::new(final_code, final_message)?;
        let record = operational_record(slot, Outcome::Error, reason, Some(attempts as u64));
        let slot = &mut self.slots[index];
        slot.record = Some(record);
        slot.place = CheckPlace::Recorded;
        Ok(AttemptResolution::Exhausted)
    }

    /// Resolves one in-flight attempt with one permanent operational
    /// failure. Implements the permanent branch of `AttemptFail`.
    ///
    /// The wrapper owns the retry policy, so it states here that one failure
    /// is permanent: the check records one `error` outcome at the failing
    /// attempt, whatever attempts remain, and no retry starts. The record
    /// keeps the attempt count and the stated reason, so one adapter defect
    /// stays visible as itself instead of `retries_exhausted` after dummy
    /// restarts that execute nothing.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_state_transition` when the
    /// run is terminal or no attempt of the check is in flight, and one with
    /// `invalid_field_type` when the code names no operational failure. No
    /// refusal changes state.
    pub fn fail_permanent(
        &mut self,
        check_id: &str,
        code: ReasonCode,
        message: &str,
    ) -> Result<(), ValidationError> {
        self.ensure_running()?;
        require_operational_code(code)?;
        let index = self.slot_index(check_id)?;
        let slot = &self.slots[index];
        if slot.place != CheckPlace::Active {
            return Err(invalid_state(
                "/check",
                "No attempt is in flight for this check. A permanent failure fits no valid transition.",
            ));
        }
        let attempts = slot.attempts;
        let reason = SanitizedReason::new(code, message)?;
        let record = operational_record(slot, Outcome::Error, reason, Some(attempts as u64));
        let slot = &mut self.slots[index];
        slot.record = Some(record);
        slot.place = CheckPlace::Recorded;
        Ok(())
    }

    /// Resolves one in-flight attempt with its component record. Implements
    /// `AcceptResult` with the `DuplicateResult` and `LateResult` refusals.
    ///
    /// The record comes from the report layer: an exact-rule record from
    /// [`RuleResult`](crate::rule::RuleResult), or a question record the
    /// wrapper built from a validated assessment. The boundary validates that
    /// the run is still running, that an attempt of the check is in flight,
    /// that the record serves the same check with the same kind, and that its
    /// outcome is semantic. An accepted result stamps the true attempt count:
    /// a record states `attempts` only when the check needed more than one.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `late_result_rejected` when the run
    /// is terminal, and one with `invalid_state_transition` when the
    /// identifier names no check of this run, when the record names a
    /// different check or kind, when no attempt is in flight, or when the
    /// outcome is not semantic. No refusal changes state.
    pub fn accept_result(
        &mut self,
        check_id: &str,
        record: CheckRecord,
    ) -> Result<(), ValidationError> {
        if self.phase.is_terminal() {
            return Err(ValidationError::new(
                ReasonCode::LateResultRejected,
                "",
                "A result arrived after the run reached a terminal state. The report is frozen.",
            ));
        }
        let index = self.slot_index(check_id)?;
        let slot = &self.slots[index];
        if record.check != check_id {
            return Err(invalid_state(
                "/check",
                "The record names a different check than the event.",
            ));
        }
        if record.kind != slot.kind {
            return Err(invalid_state(
                "/kind",
                "The record kind does not match the check of this run.",
            ));
        }
        if slot.place != CheckPlace::Active {
            return Err(invalid_state(
                "/check",
                "No attempt is in flight for this check. A result without an active attempt fits no valid transition.",
            ));
        }
        if !matches!(
            record.outcome,
            Outcome::Pass | Outcome::Fail | Outcome::Review
        ) {
            return Err(invalid_state(
                "/outcome",
                "A result must state a semantic outcome. Error and skipped outcomes come from attempt failures, queue limits, and terminal events.",
            ));
        }
        let mut record = record;
        record.attempts = (slot.attempts > 1).then_some(slot.attempts as u64);
        let slot = &mut self.slots[index];
        slot.record = Some(record);
        slot.place = CheckPlace::Recorded;
        Ok(())
    }

    /// Records one `skipped` outcome with reason `queue_full` for work that
    /// never started. Implements `SubmitSkipped` for the state it leaves.
    ///
    /// The wrapper calls this when its queue cannot accept the work. The
    /// boundary validates that the run is still running and that the check
    /// never started, so a skip can replace no result.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_state_transition` when the
    /// run is terminal, when the identifier names no check of this run, or
    /// when the check already started or holds a record. No refusal changes
    /// state.
    pub fn skip_queue_full(&mut self, check_id: &str) -> Result<(), ValidationError> {
        self.ensure_running()?;
        let index = self.slot_index(check_id)?;
        let slot = &self.slots[index];
        if slot.place != CheckPlace::Pending {
            return Err(invalid_state(
                "/check",
                "Only work that never started can record a queue-full skip.",
            ));
        }
        let reason = SanitizedReason::new(ReasonCode::QueueFull, QUEUE_FULL)?;
        let record = operational_record(slot, Outcome::Skipped, reason, None);
        let slot = &mut self.slots[index];
        slot.record = Some(record);
        slot.place = CheckPlace::Recorded;
        Ok(())
    }

    /// Cancels the run. Implements `Cancel`.
    ///
    /// Every in-flight attempt records one `error` outcome with reason
    /// `run_cancelled`. Every check that never started records one `skipped`
    /// outcome with reason `cancelled_before_start`. Every completed record
    /// stays as it was. The run then holds one report with completion status
    /// `cancelled`, which the aggregate outcome does not change.
    ///
    /// `completed_at` states the terminal time that the wrapper observed. The
    /// boundary reads no clock.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_state_transition` when the
    /// run already reached a terminal state, and one with `invalid_field_type`
    /// when the terminal time is not one RFC 3339 date-time. A failure
    /// changes no state.
    pub fn cancel(&mut self, completed_at: Option<&str>) -> Result<(), ValidationError> {
        self.ensure_running()?;
        let records: Vec<CheckRecord> = self
            .slots
            .iter()
            .map(|slot| {
                terminal_record(
                    slot,
                    Outcome::Error,
                    ReasonCode::RunCancelled,
                    CANCELLED_WHILE_ACTIVE,
                    Outcome::Skipped,
                    ReasonCode::CancelledBeforeStart,
                    CANCELLED_BEFORE_START,
                )
            })
            .collect();
        self.commit_terminal(
            Phase::Cancelled,
            CompletionStatus::Cancelled,
            completed_at,
            records,
        )
    }

    /// Ends the run at its total deadline. Implements `Deadline`.
    ///
    /// Every in-flight attempt records one `error` outcome with reason
    /// `deadline_exceeded`. Every check that never started records one
    /// `skipped` outcome with reason `deadline_before_start`. Every completed
    /// record stays as it was.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_state_transition` when the
    /// run already reached a terminal state, and one with `invalid_field_type`
    /// when the terminal time is not one RFC 3339 date-time. A failure
    /// changes no state.
    pub fn deadline(&mut self, completed_at: Option<&str>) -> Result<(), ValidationError> {
        self.ensure_running()?;
        let records: Vec<CheckRecord> = self
            .slots
            .iter()
            .map(|slot| {
                terminal_record(
                    slot,
                    Outcome::Error,
                    ReasonCode::DeadlineExceeded,
                    DEADLINE_WHILE_ACTIVE,
                    Outcome::Skipped,
                    ReasonCode::DeadlineBeforeStart,
                    DEADLINE_BEFORE_START,
                )
            })
            .collect();
        self.commit_terminal(
            Phase::DeadlineExceeded,
            CompletionStatus::DeadlineExceeded,
            completed_at,
            records,
        )
    }

    /// Completes the run. Implements `Complete`.
    ///
    /// The boundary validates that the run is still running and that every
    /// check already holds its record. The report then states completion
    /// status `completed`; its aggregate outcome may still be `error` or
    /// `review`, because completion and outcome are separate facts.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_state_transition` when the
    /// run is terminal or a check still holds no record, and one with
    /// `invalid_field_type` when the terminal time is not one RFC 3339
    /// date-time. A failure changes no state.
    pub fn complete(&mut self, completed_at: Option<&str>) -> Result<(), ValidationError> {
        self.ensure_running()?;
        if self
            .slots
            .iter()
            .any(|slot| slot.place != CheckPlace::Recorded)
        {
            return Err(invalid_state(
                "/checks",
                "The run cannot complete while a check holds no record.",
            ));
        }
        let records: Vec<CheckRecord> = self
            .slots
            .iter()
            .map(|slot| {
                slot.record
                    .clone()
                    .expect("a recorded check holds its record")
            })
            .collect();
        self.commit_terminal(
            Phase::Completed,
            CompletionStatus::Completed,
            completed_at,
            records,
        )
    }

    /// Returns the slot index of one check identifier.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_state_transition` when the
    /// identifier names no check of this run.
    fn slot_index(&self, check_id: &str) -> Result<usize, ValidationError> {
        self.slots
            .iter()
            .position(|slot| slot.id == check_id)
            .ok_or_else(|| invalid_state("/check", "The event names a check outside this run."))
    }

    /// Refuses an event that is not a result when the run is terminal.
    ///
    /// # Errors
    ///
    /// Returns a [`ValidationError`] with `invalid_state_transition` when the
    /// run reached a terminal state.
    fn ensure_running(&self) -> Result<(), ValidationError> {
        if self.phase.is_terminal() {
            return Err(ValidationError::new(
                ReasonCode::InvalidStateTransition,
                "",
                "The run reached a terminal state. The report is frozen.",
            ));
        }
        Ok(())
    }

    /// Builds the terminal report, then commits it with the phase. A build
    /// failure leaves the run exactly as it was.
    fn commit_terminal(
        &mut self,
        phase: Phase,
        status: CompletionStatus,
        completed_at: Option<&str>,
        records: Vec<CheckRecord>,
    ) -> Result<(), ValidationError> {
        let completion = Completion {
            status,
            completed_at: completed_at.map(str::to_owned),
        };
        let mut builder = ReportBuilder::new(
            self.run_id.clone(),
            self.mode,
            self.definition.clone(),
            self.profile.clone(),
            self.case.clone(),
            completion,
        );
        if let Some(baseline) = &self.baseline {
            // The existing decision of the host crosses the report exactly as
            // the host stated it. The new outcome sits in the aggregate and
            // the component records, so the two facts never merge.
            builder = builder.baseline(baseline.clone());
        }
        for record in &records {
            builder = builder.check(record.clone());
        }
        let report = builder.finish()?;
        for (slot, record) in self.slots.iter_mut().zip(records) {
            slot.record = Some(record);
            slot.place = CheckPlace::Recorded;
        }
        self.phase = phase;
        self.report = Some(report);
        Ok(())
    }
}

/// Builds one `invalid_state_transition` refusal.
fn invalid_state(field_path: &str, message: &str) -> ValidationError {
    ValidationError::new(ReasonCode::InvalidStateTransition, field_path, message)
}

/// Checks that one failure code names one operational failure of an adapter.
///
/// # Errors
///
/// Returns a [`ValidationError`] with `invalid_field_type` when the code
/// names no operational failure.
fn require_operational_code(code: ReasonCode) -> Result<(), ValidationError> {
    if matches!(
        code,
        ReasonCode::EvaluatorError | ReasonCode::EvaluatorTimeout | ReasonCode::InvalidAssessment
    ) {
        return Ok(());
    }
    Err(ValidationError::invalid_field_type(
        "/reason/code",
        "An attempt failure must carry an operational reason code: evaluator_error, evaluator_timeout, or invalid_assessment.",
    ))
}

/// Builds one record that the boundary constructs itself.
///
/// A rule check states the rule it did not execute, because the report
/// contract requires an `applied_rule` on every rule record. A question
/// check records no rule and no policy, because none executed.
fn operational_record(
    slot: &CheckSlot,
    outcome: Outcome,
    reason: SanitizedReason,
    attempts: Option<u64>,
) -> CheckRecord {
    CheckRecord {
        check: slot.id.clone(),
        kind: slot.kind,
        outcome,
        assessment: None,
        applied_rule: slot.applied_rule.clone(),
        applied_policy: None,
        evaluator: None,
        attempts,
        timing: None,
        usage: None,
        reason: Some(reason),
    }
}

/// Builds the record of one check at a terminal transition: an error for
/// in-flight work, a skip for work that never started, and the existing
/// record for completed work.
fn terminal_record(
    slot: &CheckSlot,
    active_outcome: Outcome,
    active_code: ReasonCode,
    active_message: &str,
    pending_outcome: Outcome,
    pending_code: ReasonCode,
    pending_message: &str,
) -> CheckRecord {
    match slot.place {
        CheckPlace::Active => {
            let reason = SanitizedReason::new(active_code, active_message)
                .expect("a fixed terminal message is valid");
            operational_record(slot, active_outcome, reason, None)
        }
        CheckPlace::Pending => {
            let reason = SanitizedReason::new(pending_code, pending_message)
                .expect("a fixed terminal message is valid");
            operational_record(slot, pending_outcome, reason, None)
        }
        CheckPlace::Recorded => slot
            .record
            .clone()
            .expect("a recorded check holds its record"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::definition;
    use crate::error::ReasonCode;
    use crate::report;
    use serde_json::json;

    /// One validated definition with one rule check and one question check,
    /// so every record kind is exercised.
    fn definition() -> definition::ValidatedDefinition {
        let artifact = json!({
            "schema_version": 1,
            "name": "state-review",
            "inputs": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "minLength": 1},
                    "notice": {"type": "string", "minLength": 1}
                },
                "required": ["summary", "notice"],
                "additionalProperties": false
            },
            "checks": [
                {
                    "id": "summary-length",
                    "name": "The summary fits the delivery limit",
                    "using": ["summary"],
                    "rule": {"maxLength": 80}
                },
                {
                    "id": "notice-question",
                    "name": "The notice is fit",
                    "using": ["notice"],
                    "question": "Is the notice fit?",
                    "answers": {"yes": "Fit.", "no": "Not fit."}
                }
            ]
        });
        definition::validate_definition_str(&artifact.to_string())
            .expect("the definition validates")
    }

    /// One rule record that a run may accept for the rule check.
    fn rule_record(outcome: Outcome) -> CheckRecord {
        let mut record = CheckRecord::from_rule_result(&crate::rule::RuleResult {
            check: "summary-length".to_owned(),
            outcome: crate::rule::RuleOutcome::Pass,
            applied_rule: AppliedRule::new(
                crate::definition::Rule::MaxLength { max_length: 80 },
                "summary",
            ),
            reason: String::new(),
        });
        record.outcome = outcome;
        record
    }

    /// One question record with the stated outcome.
    fn question_record(outcome: Outcome) -> CheckRecord {
        CheckRecord {
            check: "notice-question".to_owned(),
            kind: RecordKind::Question,
            outcome,
            assessment: None,
            applied_rule: None,
            applied_policy: None,
            evaluator: None,
            attempts: None,
            timing: None,
            usage: None,
            reason: None,
        }
    }

    /// The run binding of every test run: one case and one profile.
    fn binding() -> (CaseReference, ProfileReference) {
        (
            CaseReference {
                id: "case-1".to_owned(),
                input_hash: "c".repeat(64),
                snapshot: None,
            },
            ProfileReference {
                id: "state-profile".to_owned(),
                content_hash: "b".repeat(64),
            },
        )
    }

    /// One running state with both checks pending.
    fn state(max_attempts: u32) -> RunState {
        let (case, profile) = binding();
        RunState::new(
            &definition(),
            case,
            profile,
            "state-000001",
            RunMode::Shadow,
            None,
            RunLimits { max_attempts },
        )
        .expect("the run state constructs")
    }

    /// One running shadow state that records one existing decision.
    fn shadow_state(max_attempts: u32, baseline: report::Baseline) -> RunState {
        let (case, profile) = binding();
        RunState::new(
            &definition(),
            case,
            profile,
            "state-000001",
            RunMode::Shadow,
            Some(baseline),
            RunLimits { max_attempts },
        )
        .expect("the run state constructs")
    }

    #[test]
    fn a_result_reaches_only_its_active_check() {
        let (case, profile) = binding();
        let mut run = state(1);
        assert_eq!(run.phase(), Phase::Running);

        let first = run
            .start_attempt("summary-length", &case, &profile)
            .expect("the first attempt starts");
        assert_eq!(first, 1);
        assert_eq!(
            run.status("summary-length"),
            Some(CheckStatus {
                place: CheckPlace::Active,
                attempts: 1
            })
        );
        run.accept_result("summary-length", rule_record(Outcome::Pass))
            .expect("the result is accepted");
        assert_eq!(run.outcome_of("summary-length"), Some(Outcome::Pass));
        // A semantic outcome can reach no other check.
        assert_eq!(run.outcome_of("notice-question"), None);

        run.start_attempt("notice-question", &case, &profile)
            .expect("the second attempt starts");
        run.accept_result("notice-question", question_record(Outcome::Review))
            .expect("the result is accepted");

        run.complete(None).expect("the run completes");
        let report = run.report().expect("the terminal report exists");
        assert_eq!(report.completion().status, CompletionStatus::Completed);
        assert_eq!(report.aggregate(), crate::report::AggregateOutcome::Review);
        assert_eq!(report.checks().len(), 2);
        // A rule record keeps its executed rule, and one attempt leaves the
        // default count absent, as the traces fix.
        let rule = &report.checks()[0];
        assert_eq!(rule.attempts, None);
        assert!(rule.applied_rule.is_some());
    }

    #[test]
    fn retries_preserve_the_binding_and_count_attempts() {
        let (case, profile) = binding();
        let mut run = state(2);

        run.start_attempt("notice-question", &case, &profile)
            .expect("the first attempt starts");
        let resolution = run
            .fail_attempt(
                "notice-question",
                ReasonCode::EvaluatorTimeout,
                "The adapter timed out.",
            )
            .expect("the failure resolves");
        assert_eq!(resolution, AttemptResolution::RetryQueued { attempts: 1 });
        assert_eq!(
            run.status("notice-question"),
            Some(CheckStatus {
                place: CheckPlace::Pending,
                attempts: 1
            })
        );

        // The retry starts with the same case and profile binding.
        let second = run
            .start_attempt("notice-question", &case, &profile)
            .expect("the retry starts");
        assert_eq!(second, 2);
        run.accept_result("notice-question", question_record(Outcome::Pass))
            .expect("the retried result is accepted");
        run.start_attempt("summary-length", &case, &profile)
            .expect("the rule attempt starts");
        run.accept_result("summary-length", rule_record(Outcome::Pass))
            .expect("the rule result is accepted");
        run.complete(None).expect("the run completes");
        let report = run.report().expect("the terminal report exists");
        let question = &report.checks()[1];
        assert_eq!(question.outcome, Outcome::Pass);
        assert_eq!(question.attempts, Some(2));
    }

    #[test]
    fn a_drifted_binding_cannot_start_or_retry() {
        // The negative control of the model record: a mutated StartRetry
        // stored the offered identities and TLC reported a violation of
        // AttemptBindingStable. The boundary refuses the same offers.
        let (case, profile) = binding();
        let mut run = state(2);

        // A drifted first offer: another case identifier.
        let mut other_case = case.clone();
        other_case.id = "case-2".to_owned();
        let error = run
            .start_attempt("summary-length", &other_case, &profile)
            .expect_err("the drifted case identifier was accepted");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
        assert_eq!(error.field_path, "/case/id", "{error}");

        // Another input hash on the same identifier.
        let mut edited_case = case.clone();
        edited_case.input_hash = "d".repeat(64);
        let error = run
            .start_attempt("summary-length", &edited_case, &profile)
            .expect_err("the drifted input hash was accepted");
        assert_eq!(error.field_path, "/case/input_hash", "{error}");

        // Another profile identifier and another profile hash.
        let mut other_profile = profile.clone();
        other_profile.id = "other-profile".to_owned();
        let error = run
            .start_attempt("summary-length", &case, &other_profile)
            .expect_err("the drifted profile identifier was accepted");
        assert_eq!(error.field_path, "/profile/id", "{error}");
        let mut edited_profile = profile.clone();
        edited_profile.content_hash = "e".repeat(64);
        let error = run
            .start_attempt("summary-length", &case, &edited_profile)
            .expect_err("the drifted profile hash was accepted");
        assert_eq!(error.field_path, "/profile/content_hash", "{error}");

        // Every refusal changed no state: nothing started, nothing recorded.
        assert_eq!(
            run.status("summary-length"),
            Some(CheckStatus {
                place: CheckPlace::Pending,
                attempts: 0
            })
        );
        assert_eq!(run.outcome_of("summary-length"), None);

        // The counterexample scenario: a retry that switches the case input.
        run.start_attempt("notice-question", &case, &profile)
            .expect("the first attempt starts");
        run.fail_attempt(
            "notice-question",
            ReasonCode::EvaluatorError,
            "The adapter reported a network failure.",
        )
        .expect("the failure queues a retry");
        let error = run
            .start_attempt("notice-question", &other_case, &profile)
            .expect_err("the drifted retry was accepted");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
        assert_eq!(
            run.status("notice-question"),
            Some(CheckStatus {
                place: CheckPlace::Pending,
                attempts: 1
            })
        );

        // The correct binding still starts, so a refusal blocks no recovery.
        run.start_attempt("notice-question", &case, &profile)
            .expect("the correct retry starts");
    }

    #[test]
    fn the_attempt_budget_is_enforced() {
        let (case, profile) = binding();
        let mut run = state(1);

        run.start_attempt("notice-question", &case, &profile)
            .expect("the attempt starts");
        let resolution = run
            .fail_attempt(
                "notice-question",
                ReasonCode::EvaluatorError,
                "The adapter reported a network failure.",
            )
            .expect("the single failure resolves");
        assert_eq!(resolution, AttemptResolution::Exhausted);

        // A single failed attempt keeps its operational reason, as the trace
        // partial-failure-mix fixes.
        assert_eq!(run.outcome_of("notice-question"), Some(Outcome::Error));
        assert_eq!(
            run.status("notice-question"),
            Some(CheckStatus {
                place: CheckPlace::Recorded,
                attempts: 1
            })
        );

        // A recorded check accepts no further start: the budget is spent and
        // the record is terminal. A retrying check can never sit in the queue
        // with a spent budget, because the boundary records the error at the
        // failing attempt instead.
        let error = run
            .start_attempt("notice-question", &case, &profile)
            .expect_err("the spent budget was accepted");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
        assert_eq!(error.field_path, "/check", "{error}");

        // With retries configured, the exhausted record states
        // retries_exhausted and the attempt count, as the trace
        // retries-exhausted fixes.
        let mut retried = state(2);
        retried
            .start_attempt("notice-question", &case, &profile)
            .expect("the first attempt starts");
        retried
            .fail_attempt(
                "notice-question",
                ReasonCode::EvaluatorTimeout,
                "The adapter timed out.",
            )
            .expect("the first failure queues a retry");
        retried
            .start_attempt("notice-question", &case, &profile)
            .expect("the retry starts");
        let resolution = retried
            .fail_attempt(
                "notice-question",
                ReasonCode::EvaluatorError,
                "The adapter reported a network failure.",
            )
            .expect("the last failure resolves");
        assert_eq!(resolution, AttemptResolution::Exhausted);
        retried
            .start_attempt("summary-length", &case, &profile)
            .expect("the rule attempt starts");
        retried
            .accept_result("summary-length", rule_record(Outcome::Pass))
            .expect("the rule result is accepted");
        retried.complete(None).expect("the run completes");
        let report = retried.report().expect("the terminal report exists");
        let question = &report.checks()[1];
        assert_eq!(question.outcome, Outcome::Error);
        assert_eq!(question.attempts, Some(2));
        let reason = question.reason.as_ref().expect("an error states a reason");
        assert_eq!(reason.code, ReasonCode::RetriesExhausted);
        assert_eq!(
            reason.message,
            "All 2 attempts failed. The last failure reported evaluator_error."
        );
    }

    #[test]
    fn a_permanent_failure_records_its_error_without_one_retry() {
        // Task T032: the wrapper states one permanent failure, so the check
        // ends at the failing attempt. The trace permanent-failure fixes the
        // wrapper-level shape of this record.
        let (case, profile) = binding();
        let mut run = state(3);

        run.start_attempt("notice-question", &case, &profile)
            .expect("the first attempt starts");
        run.fail_permanent(
            "notice-question",
            ReasonCode::InvalidAssessment,
            "The adapter answered outside the contract of its check.",
        )
        .expect("the permanent failure records at once");

        // The record keeps the operational code and the true attempt count,
        // whatever attempts remain.
        assert_eq!(run.outcome_of("notice-question"), Some(Outcome::Error));
        assert_eq!(
            run.status("notice-question"),
            Some(CheckStatus {
                place: CheckPlace::Recorded,
                attempts: 1
            })
        );
        // A recorded check starts no further attempt, and no failure or
        // result fits the recorded slot.
        let error = run
            .start_attempt("notice-question", &case, &profile)
            .expect_err("the recorded check restarted");
        assert_eq!(error.field_path, "/check", "{error}");
        let error = run
            .fail_permanent(
                "notice-question",
                ReasonCode::InvalidAssessment,
                "The adapter answered outside the contract of its check.",
            )
            .expect_err("the recorded check failed again");
        assert_eq!(error.field_path, "/check", "{error}");

        // No attempt is in flight for a check that never started.
        let error = run
            .fail_permanent(
                "summary-length",
                ReasonCode::InvalidAssessment,
                "The adapter answered outside the contract of its check.",
            )
            .expect_err("the unstarted check recorded one error");
        assert_eq!(error.field_path, "/check", "{error}");

        // A code outside the operational set is refused before any state read.
        let error = run
            .fail_attempt(
                "summary-length",
                ReasonCode::QueueFull,
                "The queue reported one skip.",
            )
            .expect_err("the non-operational code crossed");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/reason/code", "{error}");
        let error = run
            .fail_permanent(
                "summary-length",
                ReasonCode::QueueFull,
                "The queue reported one skip.",
            )
            .expect_err("the non-operational permanent code crossed");
        assert_eq!(error.field_path, "/reason/code", "{error}");

        // The run completes with the visible defect: no retry ran, no dummy
        // attempt spent the budget, and the reason names the defect itself.
        run.start_attempt("summary-length", &case, &profile)
            .expect("the rule attempt starts");
        run.accept_result("summary-length", rule_record(Outcome::Pass))
            .expect("the rule result is accepted");
        run.complete(None).expect("the run completes");
        let report = run.report().expect("the terminal report exists");
        let question = &report.checks()[1];
        assert_eq!(question.outcome, Outcome::Error);
        assert_eq!(question.attempts, Some(1));
        let reason = question.reason.as_ref().expect("an error states a reason");
        assert_eq!(reason.code, ReasonCode::InvalidAssessment);
    }

    #[test]
    fn a_duplicate_result_is_refused_and_keeps_the_first() {
        let (case, profile) = binding();
        let mut run = state(1);
        run.start_attempt("notice-question", &case, &profile)
            .expect("the attempt starts");
        run.accept_result("notice-question", question_record(Outcome::Review))
            .expect("the first result is accepted");
        let error = run
            .accept_result("notice-question", question_record(Outcome::Pass))
            .expect_err("the duplicate result was accepted");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
        assert_eq!(run.outcome_of("notice-question"), Some(Outcome::Review));

        // A result without any attempt is refused the same way.
        let error = run
            .accept_result("summary-length", rule_record(Outcome::Pass))
            .expect_err("the result without an attempt was accepted");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");

        // A record that serves another check, or another kind, is refused.
        run.start_attempt("summary-length", &case, &profile)
            .expect("the rule attempt starts");
        let error = run
            .accept_result("summary-length", question_record(Outcome::Pass))
            .expect_err("the mismatched record was accepted");
        assert_eq!(error.field_path, "/check", "{error}");
        let error = run
            .accept_result(
                "summary-length",
                CheckRecord {
                    check: "summary-length".to_owned(),
                    kind: RecordKind::Question,
                    ..question_record(Outcome::Pass)
                },
            )
            .expect_err("the mismatched kind was accepted");
        assert_eq!(error.field_path, "/kind", "{error}");

        // An operational outcome reaches no report through a result.
        let error = run
            .accept_result(
                "summary-length",
                CheckRecord {
                    outcome: Outcome::Skipped,
                    reason: Some(
                        SanitizedReason::new(ReasonCode::QueueFull, "Full.").expect("valid"),
                    ),
                    ..rule_record(Outcome::Pass)
                },
            )
            .expect_err("the skipped outcome was accepted");
        assert_eq!(error.field_path, "/outcome", "{error}");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
    }

    #[test]
    fn a_late_result_cannot_change_a_terminal_report() {
        let (case, profile) = binding();

        // A completed report stays frozen.
        let mut run = state(1);
        run.start_attempt("notice-question", &case, &profile)
            .expect("the attempt starts");
        run.accept_result("notice-question", question_record(Outcome::Review))
            .expect("the result is accepted");
        run.skip_queue_full("summary-length")
            .expect("the queue-full skip records");
        run.complete(None).expect("the run completes");
        let frozen = serde_json::to_value(run.report().expect("the report")).expect("serializes");
        let error = run
            .accept_result("notice-question", question_record(Outcome::Pass))
            .expect_err("the late result was accepted");
        assert_eq!(error.code, ReasonCode::LateResultRejected, "{error}");
        assert_eq!(
            serde_json::to_value(run.report().expect("the report")).expect("serializes"),
            frozen,
            "the late result changed the terminal report"
        );

        // A cancelled report is terminal the same way.
        let mut cancelled = state(1);
        cancelled
            .start_attempt("notice-question", &case, &profile)
            .expect("the attempt starts");
        cancelled.cancel(None).expect("the run cancels");
        let error = cancelled
            .accept_result("notice-question", question_record(Outcome::Pass))
            .expect_err("the late result was accepted");
        assert_eq!(error.code, ReasonCode::LateResultRejected, "{error}");
        assert_eq!(
            cancelled.outcome_of("notice-question"),
            Some(Outcome::Error),
            "the cancelled active check keeps its error"
        );
    }

    #[test]
    fn cancellation_keeps_completed_work_and_ends_the_run() {
        let (case, profile) = binding();
        let mut run = state(1);

        run.start_attempt("summary-length", &case, &profile)
            .expect("the rule attempt starts");
        run.accept_result("summary-length", rule_record(Outcome::Pass))
            .expect("the rule result is accepted");
        run.start_attempt("notice-question", &case, &profile)
            .expect("the question attempt starts");
        run.cancel(Some("2026-09-24T00:00:01.250Z"))
            .expect("the run cancels");

        let report = run.report().expect("the terminal report exists");
        assert_eq!(report.completion().status, CompletionStatus::Cancelled);
        assert_eq!(
            report.completion().completed_at.as_deref(),
            Some("2026-09-24T00:00:01.250Z")
        );
        // The completed component stays; the active check errors; the run
        // never started a third check, so none exists to skip.
        assert_eq!(report.checks()[0].outcome, Outcome::Pass);
        assert_eq!(report.checks()[1].outcome, Outcome::Error);
        let reason = report.checks()[1].reason.as_ref().expect("a reason");
        assert_eq!(reason.code, ReasonCode::RunCancelled);
        // Completion is independent of the aggregate outcome.
        assert_eq!(report.aggregate(), crate::report::AggregateOutcome::Error);

        // A run with nothing started skips every check instead.
        let mut fresh = state(1);
        fresh.cancel(None).expect("the run cancels");
        let report = fresh.report().expect("the terminal report exists");
        assert_eq!(report.completion().status, CompletionStatus::Cancelled);
        for record in report.checks() {
            assert_eq!(record.outcome, Outcome::Skipped);
            assert_eq!(
                record.reason.as_ref().expect("a reason").code,
                ReasonCode::CancelledBeforeStart
            );
        }
        assert_eq!(report.aggregate(), crate::report::AggregateOutcome::Review);
    }

    #[test]
    fn a_deadline_keeps_completed_work_and_ends_the_run() {
        let (case, profile) = binding();
        let mut run = state(1);

        run.start_attempt("summary-length", &case, &profile)
            .expect("the rule attempt starts");
        run.accept_result("summary-length", rule_record(Outcome::Pass))
            .expect("the rule result is accepted");
        run.start_attempt("notice-question", &case, &profile)
            .expect("the question attempt starts");
        run.deadline(None).expect("the deadline ends the run");

        let report = run.report().expect("the terminal report exists");
        assert_eq!(
            report.completion().status,
            CompletionStatus::DeadlineExceeded
        );
        assert_eq!(report.checks()[0].outcome, Outcome::Pass);
        assert_eq!(report.checks()[1].outcome, Outcome::Error);
        assert_eq!(
            report.checks()[1].reason.as_ref().expect("a reason").code,
            ReasonCode::DeadlineExceeded
        );
        // A rule record that never executed still states its rule.
        assert!(report.checks()[0].applied_rule.is_some());

        // Work that never started skips with the deadline reason.
        let mut queued = state(1);
        queued
            .start_attempt("summary-length", &case, &profile)
            .expect("the rule attempt starts");
        queued.deadline(None).expect("the deadline ends the run");
        let report = queued.report().expect("the terminal report exists");
        assert_eq!(report.checks()[1].outcome, Outcome::Skipped);
        assert_eq!(
            report.checks()[1].reason.as_ref().expect("a reason").code,
            ReasonCode::DeadlineBeforeStart
        );
    }

    #[test]
    fn a_queue_full_skip_completes_the_run() {
        let (case, profile) = binding();
        let mut run = state(1);

        run.start_attempt("summary-length", &case, &profile)
            .expect("the rule attempt starts");
        run.accept_result("summary-length", rule_record(Outcome::Pass))
            .expect("the rule result is accepted");
        run.skip_queue_full("notice-question")
            .expect("the queue-full skip records");
        run.complete(None).expect("the run completes");

        let report = run.report().expect("the terminal report exists");
        assert_eq!(report.completion().status, CompletionStatus::Completed);
        assert_eq!(report.checks()[1].outcome, Outcome::Skipped);
        assert_eq!(
            report.checks()[1].reason.as_ref().expect("a reason").code,
            ReasonCode::QueueFull
        );
        assert_eq!(report.checks()[1].attempts, None);
        assert_eq!(report.aggregate(), crate::report::AggregateOutcome::Review);

        // Only work that never started can take a queue-full skip.
        let mut started = state(1);
        started
            .start_attempt("notice-question", &case, &profile)
            .expect("the attempt starts");
        let error = started
            .skip_queue_full("notice-question")
            .expect_err("the active check was skipped");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
    }

    #[test]
    fn complete_is_refused_while_work_remains() {
        let (case, profile) = binding();
        let mut run = state(1);
        let error = run.complete(None).expect_err("the empty run completed");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
        assert_eq!(error.field_path, "/checks", "{error}");

        run.start_attempt("summary-length", &case, &profile)
            .expect("the attempt starts");
        let error = run.complete(None).expect_err("the active run completed");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
        assert_eq!(run.phase(), Phase::Running);
        assert_eq!(run.report(), None);

        run.accept_result("summary-length", rule_record(Outcome::Fail))
            .expect("the result is accepted");
        run.skip_queue_full("notice-question")
            .expect("the skip records");
        run.complete(Some("2026-09-24T00:00:02.500Z"))
            .expect("the drained run completes");
        assert_eq!(run.phase(), Phase::Completed);
    }

    #[test]
    fn a_terminal_run_refuses_every_event() {
        let (case, profile) = binding();
        // An event that names no check of the run is refused while running.
        let mut run = state(1);
        let error = run
            .start_attempt("unknown-check", &case, &profile)
            .expect_err("the unknown check was accepted");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
        assert_eq!(error.field_path, "/check", "{error}");

        run.cancel(None).expect("the run cancels");
        for error in [
            run.start_attempt("summary-length", &case, &profile)
                .expect_err("the terminal start was accepted"),
            run.fail_attempt(
                "summary-length",
                ReasonCode::EvaluatorError,
                "The adapter reported a network failure.",
            )
            .expect_err("the terminal failure was accepted"),
            run.skip_queue_full("summary-length")
                .expect_err("the terminal skip was accepted"),
            run.complete(None)
                .expect_err("the terminal completion was accepted"),
            run.cancel(None)
                .expect_err("the terminal cancellation was accepted"),
            run.deadline(None)
                .expect_err("the terminal deadline was accepted"),
            run.start_attempt("unknown-check", &case, &profile)
                .expect_err("the unknown check was accepted"),
        ] {
            assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
        }
        // The refused events changed nothing: the report stays frozen.
        assert_eq!(run.phase(), Phase::Cancelled);
        assert!(run.report().is_some());
    }

    #[test]
    fn the_run_header_is_validated_at_construction() {
        let definition = definition();
        let (case, profile) = binding();
        let error = RunState::new(
            &definition,
            case.clone(),
            profile.clone(),
            "",
            RunMode::Shadow,
            None,
            RunLimits { max_attempts: 1 },
        )
        .expect_err("the empty run identifier was accepted");
        assert_eq!(error.field_path, "/run_id", "{error}");

        let error = RunState::new(
            &definition,
            case.clone(),
            profile.clone(),
            "state-000001",
            RunMode::Shadow,
            None,
            RunLimits { max_attempts: 0 },
        )
        .expect_err("the zero attempt limit was accepted");
        assert_eq!(error.field_path, "/max_attempts", "{error}");

        let mut bad_case = case.clone();
        bad_case.input_hash = "not-a-hash".to_owned();
        let error = RunState::new(
            &definition,
            bad_case,
            profile,
            "state-000001",
            RunMode::Shadow,
            None,
            RunLimits { max_attempts: 1 },
        )
        .expect_err("the broken case reference was accepted");
        assert_eq!(error.field_path, "/case/input_hash", "{error}");
    }

    #[test]
    fn one_baseline_reaches_every_terminal_report_unchanged() {
        let (case, profile) = binding();
        let baseline = report::Baseline {
            outcome: "send".to_owned(),
            revision: "policy-2026-03".to_owned(),
        };

        // The completed run records the baseline beside the new outcome, and
        // the two facts stay separate fields of one report.
        let mut run = shadow_state(1, baseline.clone());
        assert_eq!(run.baseline(), Some(&baseline));
        run.start_attempt("summary-length", &case, &profile)
            .expect("the rule attempt starts");
        run.accept_result("summary-length", rule_record(Outcome::Pass))
            .expect("the rule result is accepted");
        run.start_attempt("notice-question", &case, &profile)
            .expect("the question attempt starts");
        run.accept_result("notice-question", question_record(Outcome::Fail))
            .expect("the question result is accepted");
        run.complete(None).expect("the run completes");
        let report = run.report().expect("the terminal report exists");
        assert_eq!(
            report.baseline(),
            Some(&report::Baseline {
                outcome: "send".to_owned(),
                revision: "policy-2026-03".to_owned(),
            })
        );
        // The new outcome stays the aggregate of the component records. The
        // baseline changes no record and no aggregate.
        assert_eq!(report.aggregate(), crate::report::AggregateOutcome::Fail);
        assert_eq!(report.checks()[1].outcome, Outcome::Fail);

        // The cancelled and deadline reports carry the same baseline beside
        // their own terminal records.
        let mut cancelled = shadow_state(1, baseline.clone());
        cancelled
            .start_attempt("notice-question", &case, &profile)
            .expect("the attempt starts");
        cancelled.cancel(None).expect("the run cancels");
        let cancelled_report = cancelled.report().expect("the terminal report exists");
        assert_eq!(cancelled_report.baseline(), Some(&baseline));
        assert_eq!(
            cancelled_report.checks()[1].outcome,
            Outcome::Error,
            "the shadow baseline kept one error out of the decision path"
        );

        let mut deadline = shadow_state(1, baseline.clone());
        deadline
            .start_attempt("notice-question", &case, &profile)
            .expect("the attempt starts");
        deadline.deadline(None).expect("the deadline ends the run");
        assert_eq!(
            deadline
                .report()
                .expect("the terminal report exists")
                .baseline(),
            Some(&baseline)
        );

        // One run without one baseline states no field.
        let mut plain = state(1);
        plain
            .start_attempt("notice-question", &case, &profile)
            .expect("the attempt starts");
        plain.cancel(None).expect("the run cancels");
        assert_eq!(
            plain
                .report()
                .expect("the terminal report exists")
                .baseline(),
            None
        );
    }

    #[test]
    fn one_baseline_is_refused_before_any_attempt_starts() {
        let definition = definition();
        let (case, profile) = binding();

        // The baseline is shadow-mode data. An enforcement run decides through
        // its report, so it states no existing decision.
        let error = RunState::new(
            &definition,
            case.clone(),
            profile.clone(),
            "state-000001",
            RunMode::Enforcement,
            Some(report::Baseline {
                outcome: "send".to_owned(),
                revision: "policy-2026-03".to_owned(),
            }),
            RunLimits { max_attempts: 1 },
        )
        .expect_err("the enforcement baseline was accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/baseline", "{error}");

        // The bounds refuse at construction, before any work starts.
        for (baseline, path) in [
            (
                report::Baseline {
                    outcome: String::new(),
                    revision: "policy-2026-03".to_owned(),
                },
                "/baseline/outcome",
            ),
            (
                report::Baseline {
                    outcome: "o".repeat(65),
                    revision: "policy-2026-03".to_owned(),
                },
                "/baseline/outcome",
            ),
            (
                report::Baseline {
                    outcome: "send".to_owned(),
                    revision: String::new(),
                },
                "/baseline/revision",
            ),
            (
                report::Baseline {
                    outcome: "send".to_owned(),
                    revision: "r".repeat(129),
                },
                "/baseline/revision",
            ),
        ] {
            let error = RunState::new(
                &definition,
                case.clone(),
                profile.clone(),
                "state-000001",
                RunMode::Shadow,
                Some(baseline),
                RunLimits { max_attempts: 1 },
            )
            .expect_err("the broken baseline was accepted");
            assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
            assert_eq!(error.field_path, path, "{error}");
        }
    }

    #[test]
    fn an_invalid_terminal_time_changes_no_state() {
        let mut run = state(1);
        let error = run
            .cancel(Some("not-a-time"))
            .expect_err("the invalid terminal time was accepted");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert!(error.field_path.starts_with("/completion"), "{error}");
        assert_eq!(
            run.phase(),
            Phase::Running,
            "the failed terminal event changed state"
        );
        assert_eq!(run.report(), None);
        run.cancel(Some("2026-09-24T00:00:01Z"))
            .expect("the valid terminal time is accepted");
    }

    #[test]
    fn attempt_failures_carry_operational_codes_only() {
        let (case, profile) = binding();
        let mut run = state(1);
        run.start_attempt("notice-question", &case, &profile)
            .expect("the attempt starts");
        let error = run
            .fail_attempt("notice-question", ReasonCode::QueueFull, "Full.")
            .expect_err("the skip code was accepted as a failure");
        assert_eq!(error.code, ReasonCode::InvalidFieldType, "{error}");
        assert_eq!(error.field_path, "/reason/code", "{error}");
        // The refusal changed no state: the attempt stays in flight.
        assert_eq!(
            run.status("notice-question"),
            Some(CheckStatus {
                place: CheckPlace::Active,
                attempts: 1
            })
        );
        // A failure without an attempt in flight is refused.
        let error = run
            .fail_attempt(
                "summary-length",
                ReasonCode::EvaluatorError,
                "The adapter reported a network failure.",
            )
            .expect_err("the failure without an attempt was accepted");
        assert_eq!(error.code, ReasonCode::InvalidStateTransition, "{error}");
    }
}
