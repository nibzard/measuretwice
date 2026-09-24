--------------------------- MODULE Execution ---------------------------
(***************************************************************************)
(* Formal model of one measuretwice run.                                    *)
(*                                                                          *)
(* Purpose: check the execution-state boundary that MVP_SPEC.md section 5  *)
(* defines before the state is implemented. The TypeScript wrapper owns    *)
(* the queue, the deadline, the retries, and the cancellation. The Rust    *)
(* core validates every transition and freezes terminal reports.          *)
(*                                                                          *)
(* Scope: one run of one case against one fixed definition. The run       *)
(* binding, the case input identity plus the profile identity, is fixed   *)
(* at submit. The environment may offer any binding when a later attempt  *)
(* starts. The model checks that no accepted attempt records another      *)
(* binding.                                                                *)
(*                                                                          *)
(* The record in models/execution/README.md states the assumptions, the   *)
(* bounds, the results, the fairness, and the mapping to the code.        *)
(* AGENTS.md section 7 states the modelling rules.                        *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets

CONSTANTS
    \* Number of checks in the modelled run.
    NumChecks,
    \* Limit on concurrently active attempts inside one run.
    MaxActive,
    \* Limit on never-started work that waits in the queue.
    MaxPending,
    \* Limit on attempts per check, counting the first attempt.
    MaxAttempts

CHECKS == 1..NumChecks

PHASES == {"running", "completed", "cancelled", "deadline"}

\* Semantic outcomes that an evaluator may return.
OUTCOMES == {"pass", "fail", "review"}

\* "none" marks a check without a record yet.
RECORDED == OUTCOMES \cup {"error", "skipped", "none"}

ERROR_REASONS == {"retries_exhausted", "run_cancelled", "deadline_exceeded"}
SKIP_REASONS == {"queue_full", "cancelled_before_start", "deadline_before_start"}
REASONS == ERROR_REASONS \cup SKIP_REASONS \cup {""}

\* The identities that the wrapper may offer for one attempt start.
CASE_INPUTS == {"case-x", "case-y"}
PROFILES == {"profile-a", "profile-b"}

\* The run binding is fixed at submit and never changes. The empty
\* string marks a check without a started attempt.
RUN_CASE == "case-x"
RUN_PROFILE == "profile-a"
UNBOUND == ""

\* Refused events are counted, not stored by kind. The cap keeps the
\* set of reachable states finite. The implementation records the kind.
REJECTION_CAP == 3

VARIABLES
    \* "running" or one terminal phase.
    phase,
    \* Checks that the scheduler has not admitted yet.
    unadmitted,
    \* Admitted work without an active slot. Fresh work and retrying
    \* work share this queue.
    waiting,
    \* Checks with one attempt in flight.
    active,
    \* Started attempts per check, counting the first attempt.
    attempts,
    \* Case input identity of the latest started attempt per check.
    attemptCases,
    \* Profile identity of the latest started attempt per check.
    attemptProfiles,
    \* Recorded outcome per check.
    records,
    \* Reason code for error and skipped records.
    reasons,
    \* TRUE after a check records error or skipped.
    locked,
    \* Count of refused events.
    rejections,
    \* Snapshot of the report at termination.
    finalRecords,
    finalReasons,
    finalAggregate,
    finalCompletion

vars == <<phase, unadmitted, waiting, active, attempts, attemptCases,
          attemptProfiles, records, reasons, locked, rejections,
          finalRecords, finalReasons, finalAggregate, finalCompletion>>

(***************************************************************************)
(* Derived state.                                                          *)
(***************************************************************************)

\* Only never-started work counts against the pending limit. A retry of
\* in-flight work is not new work, so it does not consume a pending slot.
FreshWaiting == {c \in waiting : attempts[c] = 0}

\* The fixed aggregate order from the run-report contract: any fail gives
\* fail, then any error, then any review or skip, then pass.
Aggregate(rs) ==
    LET outs == {rs[c] : c \in CHECKS}
    IN  IF "fail" \in outs THEN "fail"
        ELSE IF "error" \in outs THEN "error"
        ELSE IF "review" \in outs \/ "skipped" \in outs THEN "review"
        ELSE "pass"

(***************************************************************************)
(* Initial state.                                                          *)
(***************************************************************************)

Init ==
    /\ phase = "running"
    /\ unadmitted = CHECKS
    /\ waiting = {}
    /\ active = {}
    /\ attempts = [c \in CHECKS |-> 0]
    /\ attemptCases = [c \in CHECKS |-> UNBOUND]
    /\ attemptProfiles = [c \in CHECKS |-> UNBOUND]
    /\ records = [c \in CHECKS |-> "none"]
    /\ reasons = [c \in CHECKS |-> ""]
    /\ locked = [c \in CHECKS |-> FALSE]
    /\ rejections = 0
    /\ finalRecords = [c \in CHECKS |-> "no-final"]
    /\ finalReasons = [c \in CHECKS |-> ""]
    /\ finalAggregate = "no-final"
    /\ finalCompletion = "no-final"

(***************************************************************************)
(* Wrapper scheduling. Each guard names the validation that admits the     *)
(* transition at the Rust state boundary.                                  *)
(***************************************************************************)

\* A free active slot admits new work directly. The Rust boundary
\* validates the run binding at the attempt start.
SubmitStart(c) ==
    /\ phase = "running"
    /\ c \in unadmitted
    /\ Cardinality(active) < MaxActive
    /\ attempts[c] < MaxAttempts
    /\ unadmitted' = unadmitted \ {c}
    /\ active' = active \union {c}
    /\ attempts' = [attempts EXCEPT ![c] = @ + 1]
    /\ attemptCases' = [attemptCases EXCEPT ![c] = RUN_CASE]
    /\ attemptProfiles' = [attemptProfiles EXCEPT ![c] = RUN_PROFILE]
    /\ UNCHANGED <<phase, waiting, records, reasons, locked, rejections,
                    finalRecords, finalReasons, finalAggregate, finalCompletion>>

\* The wrapper offers a mismatched binding for a first attempt. The Rust
\* boundary refuses the start. No other state changes.
SubmitDrift(c, ci, p) ==
    /\ phase = "running"
    /\ c \in unadmitted
    /\ Cardinality(active) < MaxActive
    /\ (ci # RUN_CASE \/ p # RUN_PROFILE)
    /\ rejections < REJECTION_CAP
    /\ rejections' = rejections + 1
    /\ UNCHANGED <<phase, unadmitted, waiting, active, attempts,
                    attemptCases, attemptProfiles, records, reasons, locked,
                    finalRecords, finalReasons, finalAggregate, finalCompletion>>

\* All active slots are busy, so new work waits in the queue.
SubmitQueued(c) ==
    /\ phase = "running"
    /\ c \in unadmitted
    /\ Cardinality(active) >= MaxActive
    /\ Cardinality(FreshWaiting) < MaxPending
    /\ unadmitted' = unadmitted \ {c}
    /\ waiting' = waiting \union {c}
    /\ UNCHANGED <<phase, active, attempts, attemptCases, attemptProfiles,
                    records, reasons, locked, rejections, finalRecords,
                    finalReasons, finalAggregate, finalCompletion>>

\* All active slots and all pending slots are busy. The check cannot run,
\* so it records a skip with reason queue_full.
SubmitSkipped(c) ==
    /\ phase = "running"
    /\ c \in unadmitted
    /\ Cardinality(active) >= MaxActive
    /\ Cardinality(FreshWaiting) >= MaxPending
    /\ unadmitted' = unadmitted \ {c}
    /\ records' = [records EXCEPT ![c] = "skipped"]
    /\ reasons' = [reasons EXCEPT ![c] = "queue_full"]
    /\ locked' = [locked EXCEPT ![c] = TRUE]
    /\ UNCHANGED <<phase, waiting, active, attempts, attemptCases,
                    attemptProfiles, rejections, finalRecords, finalReasons,
                    finalAggregate, finalCompletion>>

\* A waiting check starts its next attempt. The Rust boundary validates
\* the run binding again, so a retry cannot switch the binding.
StartRetry(c) ==
    /\ phase = "running"
    /\ c \in waiting
    /\ Cardinality(active) < MaxActive
    /\ attempts[c] < MaxAttempts
    /\ waiting' = waiting \ {c}
    /\ active' = active \union {c}
    /\ attempts' = [attempts EXCEPT ![c] = @ + 1]
    /\ attemptCases' = [attemptCases EXCEPT ![c] = RUN_CASE]
    /\ attemptProfiles' = [attemptProfiles EXCEPT ![c] = RUN_PROFILE]
    /\ UNCHANGED <<phase, unadmitted, records, reasons, locked, rejections,
                    finalRecords, finalReasons, finalAggregate, finalCompletion>>

\* The wrapper offers a mismatched binding for a retry. The Rust boundary
\* refuses the start. The check stays in the queue.
RetryDrift(c, ci, p) ==
    /\ phase = "running"
    /\ c \in waiting
    /\ Cardinality(active) < MaxActive
    /\ (ci # RUN_CASE \/ p # RUN_PROFILE)
    /\ rejections < REJECTION_CAP
    /\ rejections' = rejections + 1
    /\ UNCHANGED <<phase, unadmitted, waiting, active, attempts,
                    attemptCases, attemptProfiles, records, reasons, locked,
                    finalRecords, finalReasons, finalAggregate, finalCompletion>>

(***************************************************************************)
(* Attempt resolution.                                                     *)
(***************************************************************************)

\* An attempt fails. With attempts left, the wrapper chooses: one retryable
\* failure returns the check to the queue with its binding kept, and one
\* permanent failure records an error at the failing attempt, because no
\* retry would change the defect. Without attempts left, it records an
\* error.
AttemptFail(c) ==
    /\ phase = "running"
    /\ c \in active
    /\ IF attempts[c] < MaxAttempts
          THEN \/ /\ active' = active \ {c}
                  /\ waiting' = waiting \union {c}
                  /\ UNCHANGED <<records, reasons, locked>>
               \/ /\ active' = active \ {c}
                  /\ waiting' = waiting
                  /\ records' = [records EXCEPT ![c] = "error"]
                  /\ reasons' = [reasons EXCEPT ![c] = "retries_exhausted"]
                  /\ locked' = [locked EXCEPT ![c] = TRUE]
          ELSE /\ active' = active \ {c}
               /\ waiting' = waiting
               /\ records' = [records EXCEPT ![c] = "error"]
               /\ reasons' = [reasons EXCEPT ![c] = "retries_exhausted"]
               /\ locked' = [locked EXCEPT ![c] = TRUE]
    /\ UNCHANGED <<phase, unadmitted, attempts, attemptCases, attemptProfiles,
                    rejections, finalRecords, finalReasons,
                    finalAggregate, finalCompletion>>

\* The evaluator returns a semantic outcome for an active attempt.
AcceptResult(c, o) ==
    /\ phase = "running"
    /\ c \in active
    /\ active' = active \ {c}
    /\ records' = [records EXCEPT ![c] = o]
    /\ UNCHANGED <<phase, unadmitted, waiting, attempts, attemptCases,
                    attemptProfiles, reasons, locked, rejections,
                    finalRecords, finalReasons, finalAggregate, finalCompletion>>

\* A result arrives without an attempt in flight. It fits no valid
\* transition, so the boundary refuses it.
DuplicateResult(c) ==
    /\ phase = "running"
    /\ c \notin active
    /\ rejections < REJECTION_CAP
    /\ rejections' = rejections + 1
    /\ UNCHANGED <<phase, unadmitted, waiting, active, attempts,
                    attemptCases, attemptProfiles, records, reasons, locked,
                    finalRecords, finalReasons, finalAggregate, finalCompletion>>

\* A result arrives after a terminal state. The report is frozen, so the
\* boundary refuses the result.
LateResult(c) ==
    /\ phase # "running"
    /\ rejections < REJECTION_CAP
    /\ rejections' = rejections + 1
    /\ UNCHANGED <<phase, unadmitted, waiting, active, attempts,
                    attemptCases, attemptProfiles, records, reasons, locked,
                    finalRecords, finalReasons, finalAggregate, finalCompletion>>

(***************************************************************************)
(* Terminal transitions. Each takes a snapshot of the report.              *)
(***************************************************************************)

Cancel ==
    /\ phase = "running"
    /\ phase' = "cancelled"
    /\ records' = [c \in CHECKS |->
         IF c \in active THEN "error"
         ELSE IF c \in waiting \union unadmitted THEN "skipped"
         ELSE records[c]]
    /\ reasons' = [c \in CHECKS |->
         IF c \in active THEN "run_cancelled"
         ELSE IF c \in waiting \union unadmitted THEN "cancelled_before_start"
         ELSE reasons[c]]
    /\ locked' = [c \in CHECKS |->
         locked[c] \/ records'[c] \in {"error", "skipped"}]
    /\ unadmitted' = {}
    /\ waiting' = {}
    /\ active' = {}
    /\ finalRecords' = records'
    /\ finalReasons' = reasons'
    /\ finalAggregate' = Aggregate(records')
    /\ finalCompletion' = "cancelled"
    /\ UNCHANGED <<attempts, attemptCases, attemptProfiles, rejections>>

Deadline ==
    /\ phase = "running"
    /\ phase' = "deadline"
    /\ records' = [c \in CHECKS |->
         IF c \in active THEN "error"
         ELSE IF c \in waiting \union unadmitted THEN "skipped"
         ELSE records[c]]
    /\ reasons' = [c \in CHECKS |->
         IF c \in active THEN "deadline_exceeded"
         ELSE IF c \in waiting \union unadmitted THEN "deadline_before_start"
         ELSE reasons[c]]
    /\ locked' = [c \in CHECKS |->
         locked[c] \/ records'[c] \in {"error", "skipped"}]
    /\ unadmitted' = {}
    /\ waiting' = {}
    /\ active' = {}
    /\ finalRecords' = records'
    /\ finalReasons' = reasons'
    /\ finalAggregate' = Aggregate(records')
    /\ finalCompletion' = "deadline"
    /\ UNCHANGED <<attempts, attemptCases, attemptProfiles, rejections>>

\* Every check has a record and no work is left, so the run completes.
Complete ==
    /\ phase = "running"
    /\ unadmitted = {}
    /\ waiting = {}
    /\ active = {}
    /\ \A c \in CHECKS : records[c] # "none"
    /\ phase' = "completed"
    /\ finalRecords' = records
    /\ finalReasons' = reasons
    /\ finalAggregate' = Aggregate(records)
    /\ finalCompletion' = "completed"
    /\ UNCHANGED <<unadmitted, waiting, active, attempts, attemptCases,
                    attemptProfiles, records, reasons, locked, rejections>>

(***************************************************************************)
(* Next-state relation.                                                    *)
(***************************************************************************)

Next ==
    \/ \E c \in CHECKS :
         SubmitStart(c) \/ SubmitQueued(c) \/ SubmitSkipped(c)
         \/ StartRetry(c) \/ AttemptFail(c)
         \/ DuplicateResult(c) \/ LateResult(c)
    \/ \E c \in CHECKS, ci \in CASE_INPUTS, p \in PROFILES :
         SubmitDrift(c, ci, p) \/ RetryDrift(c, ci, p)
    \/ \E c \in CHECKS, o \in OUTCOMES : AcceptResult(c, o)
    \/ Cancel \/ Deadline \/ Complete

(***************************************************************************)
(* Fairness. The wrapper makes progress on admission, on attempt starts,  *)
(* and on attempt resolution. Cancel, Deadline, and the refused events    *)
(* are adversarial. They carry no fairness.                               *)
(***************************************************************************)

SubmitStep(c) == SubmitStart(c) \/ SubmitQueued(c) \/ SubmitSkipped(c)

StartStep(c) == StartRetry(c)

Resolve(c) == (\E o \in OUTCOMES : AcceptResult(c, o)) \/ AttemptFail(c)

Fairness ==
    /\ \A c \in CHECKS : WF_vars(SubmitStep(c))
    /\ \A c \in CHECKS : WF_vars(StartStep(c))
    /\ \A c \in CHECKS : WF_vars(Resolve(c))
    /\ WF_vars(Complete)

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Safety invariants.                                                     *)
(***************************************************************************)

TypeOK ==
    /\ phase \in PHASES
    /\ unadmitted \subseteq CHECKS
    /\ waiting \subseteq CHECKS
    /\ active \subseteq CHECKS
    /\ attempts \in [CHECKS -> 0..MaxAttempts]
    /\ attemptCases \in [CHECKS -> CASE_INPUTS \cup {UNBOUND}]
    /\ attemptProfiles \in [CHECKS -> PROFILES \cup {UNBOUND}]
    /\ records \in [CHECKS -> RECORDED]
    /\ reasons \in [CHECKS -> REASONS]
    /\ locked \in [CHECKS -> BOOLEAN]
    /\ rejections \in 0..REJECTION_CAP
    /\ finalRecords \in [CHECKS -> RECORDED \cup {"no-final"}]
    /\ finalReasons \in [CHECKS -> REASONS]
    /\ finalAggregate \in {"no-final", "pass", "fail", "review", "error"}
    /\ finalCompletion \in {"no-final", "completed", "cancelled", "deadline"}

\* Active execution never exceeds its limit.
ActiveWithinLimit == Cardinality(active) =< MaxActive

\* Never-started waiting work never exceeds the pending limit.
FreshPendingWithinLimit == Cardinality(FreshWaiting) =< MaxPending

\* No check starts more attempts than the configured limit.
AttemptsBounded == \A c \in CHECKS : attempts[c] =< MaxAttempts

\* Every started attempt binds the run case input and the run profile.
\* A retry never switches either identity.
AttemptBindingStable ==
    \A c \in CHECKS :
        /\ attemptCases[c] \in {UNBOUND, RUN_CASE}
        /\ attemptProfiles[c] \in {UNBOUND, RUN_PROFILE}

\* Each check is in exactly one scheduler place while it has no record,
\* and a recorded check holds no scheduler place.
StatePartition ==
    /\ unadmitted \cap waiting = {}
    /\ unadmitted \cap active = {}
    /\ waiting \cap active = {}
    /\ \A c \in CHECKS :
         (records[c] = "none") <=> (c \in unadmitted \union waiting \union active)

\* An error or a skipped record stays in its outcome class. It never
\* becomes a pass, a fail, or a review.
NoErrorSkipToPass ==
    \A c \in CHECKS :
        /\ (locked[c] => records[c] \in {"error", "skipped"})
        /\ (records[c] \in {"error", "skipped"} => locked[c])

\* A report in a terminal state never changes. The snapshot taken at
\* termination equals the live report in every later state.
TerminalReportFrozen ==
    phase # "running" =>
        /\ records = finalRecords
        /\ reasons = finalReasons
        /\ finalAggregate = Aggregate(records)
        /\ phase = finalCompletion

\* A terminal report records every check of the run.
TerminalRecordsComplete ==
    phase # "running" => \A c \in CHECKS : records[c] # "none"

(***************************************************************************)
(* Progress property.                                                     *)
(***************************************************************************)

\* Under the fairness above, the run reaches a terminal phase and every
\* check receives a record.
RunTerminates ==
    /\ <>(phase # "running")
    /\ \A c \in CHECKS : <>(records[c] # "none")

=============================================================================
