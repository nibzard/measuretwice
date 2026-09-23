--------------------------- MODULE Qualification ---------------------------
(***************************************************************************)
(* Formal model of profile qualification, host selection, and mode         *)
(* admission.                                                              *)
(*                                                                          *)
(* Purpose: check the boundary that MVP_SPEC.md sections 8 to 10 define    *)
(* before tasks T028, T029, T035, and T038 implement it. Qualification,    *)
(* host selection, and application authorization are three different       *)
(* concepts. The library owns the admission gate. The host owns the        *)
(* selection, the credentials, and every application action.               *)
(*                                                                          *)
(* Scope: one loaded definition, one requested use scope, and a registry   *)
(* of profile artifact slots. Each slot holds one artifact. A new          *)
(* candidate replaces the artifact of a slot that the host has not         *)
(* selected. Runs, evaluations, and shadow reports never change the        *)
(* qualification of a slot, the host selection, or the host authorization. *)
(*                                                                          *)
(* The record in models/qualification/README.md states the assumptions,    *)
(* the bounds, the results, and the mapping to the code.                   *)
(* AGENTS.md section 7 states the modelling rules.                         *)
(***************************************************************************)

EXTENDS Naturals

CONSTANTS
    \* Number of profile artifact slots in the modelled registry.
    NumProfiles,
    \* Limit on refused mode requests. Refused events are counted, not
    \* stored by kind. The cap keeps the set of reachable states finite.
    MaxRejections

PROFILES == 1..NumProfiles

\* Qualification statuses from the profile contract.
STATUSES == {"unvalidated", "insufficient_evidence", "criteria_not_met",
             "validated_for_scope"}

\* Statuses that frozen validation may compute. A starter profile is
\* always unvalidated.
COMPUTED == {"insufficient_evidence", "criteria_not_met",
             "validated_for_scope"}

\* Run outcomes. The model abstracts them to the semantic classes.
OUTCOMES == {"pass", "fail", "review"}

\* Request modes of the public run operation.
RUN_MODES == {"evaluation", "shadow", "enforcement"}

\* Definition identities that an artifact may bind. def-x is loaded.
DEFINITIONS == {"def-x", "def-y"}
LOADED_DEF == "def-x"

\* Resolutions that the model alias may take. m-1 is current at start.
MODELS == {"m-1", "m-2"}

\* Declared use scopes. use-scope matches the requested use.
SCOPES == {"use-scope", "other-scope"}
USE_SCOPE == "use-scope"

NO_PROFILE == 0

LIBRARY_EVENTS == {"starter", "qualify", "refuse", "drift"} \cup RUN_MODES
HOST_EVENTS == {"select", "deselect", "authorize", "revoke"}
EVENTS == {"none"} \cup LIBRARY_EVENTS \cup HOST_EVENTS

VARIABLES
    \* Qualification status per slot.
    qual,
    \* Definition, resolved model, and declared scope per slot.
    boundDef,
    boundModel,
    scope,
    \* Current resolution of the model alias. It may drift once.
    resolvedModel,
    \* Slot that the host selected for enforcement. NO_PROFILE is none.
    selected,
    \* TRUE after the host granted application authorization. The library
    \* never grants it.
    authorized,
    \* Count of refused mode requests.
    rejections,
    \* Class of the last step. Drives the monitor invariants.
    lastEvent,
    \* Qualification, selection, and authorization before the last step.
    prevQual,
    prevSelected,
    prevAuthorized,
    \* Outcome that the last accepted run recorded.
    lastRunOutcome,
    \* Admission snapshot of the last accepted enforcement run.
    lastEnforceProfile,
    lastEnforceQual,
    lastEnforceCompatible,
    lastEnforceScope,
    lastEnforceSelected

vars == <<qual, boundDef, boundModel, scope, resolvedModel, selected,
          authorized, rejections, lastEvent, prevQual, prevSelected,
          prevAuthorized, lastRunOutcome, lastEnforceProfile,
          lastEnforceQual, lastEnforceCompatible, lastEnforceScope,
          lastEnforceSelected>>

(***************************************************************************)
(* Variable groups for the UNCHANGED clauses.                              *)
(***************************************************************************)

binding == <<boundDef, boundModel, scope>>
hostState == <<selected, authorized>>
enforceSnap == <<lastEnforceProfile, lastEnforceQual,
                 lastEnforceCompatible, lastEnforceScope,
                 lastEnforceSelected>>

(***************************************************************************)
(* Derived state.                                                          *)
(***************************************************************************)

\* A slot is compatible when its artifact binds the loaded definition and
\* the current model resolution. Compatibility is a state property. It is
\* lost when the alias drifts.
Compatible(p) ==
    /\ boundDef[p] = LOADED_DEF
    /\ boundModel[p] = resolvedModel

\* The admission gate for enforcement. The library checks every clause.
\* The host selection alone admits nothing.
EnforcementGate(p) ==
    /\ Compatible(p)
    /\ scope[p] = USE_SCOPE
    /\ qual[p] = "validated_for_scope"
    /\ selected = p

(***************************************************************************)
(* Step monitors.                                                          *)
(*                                                                          *)
(* Run steps record the pre-step qualification and host state, so the      *)
(* monitor invariants below can compare them. Every other step resets     *)
(* the monitor to its post-step values. Each action applies its mark as    *)
(* the last conjunct: TLC binds the successor values of a step from left  *)
(* to right, and the reset reads the primed values.                        *)
(***************************************************************************)

MarkRun(e) ==
    /\ prevQual' = qual
    /\ prevSelected' = selected
    /\ prevAuthorized' = authorized
    /\ lastEvent' = e

MarkReset(e) ==
    /\ prevQual' = qual'
    /\ prevSelected' = selected'
    /\ prevAuthorized' = authorized'
    /\ lastEvent' = e

(***************************************************************************)
(* Initial state. Every artifact starts as an unvalidated candidate. The   *)
(* environment chooses the definition and the declared scope of each       *)
(* slot, so a foreign or wrong-scope artifact is reachable from the start. *)
(***************************************************************************)

Init ==
    /\ qual = [p \in PROFILES |-> "unvalidated"]
    /\ boundDef \in [PROFILES -> DEFINITIONS]
    /\ boundModel = [p \in PROFILES |-> "m-1"]
    /\ scope \in [PROFILES -> SCOPES]
    /\ resolvedModel = "m-1"
    /\ selected = NO_PROFILE
    /\ authorized = FALSE
    /\ rejections = 0
    /\ lastEvent = "none"
    /\ prevQual = qual
    /\ prevSelected = selected
    /\ prevAuthorized = authorized
    /\ lastRunOutcome = "none"
    /\ lastEnforceProfile = NO_PROFILE
    /\ lastEnforceQual = "none"
    /\ lastEnforceCompatible = FALSE
    /\ lastEnforceScope = "none"
    /\ lastEnforceSelected = NO_PROFILE

(***************************************************************************)
(* Qualification transitions. These are the only steps that may change     *)
(* a qualification status, besides the drift demotion. A new artifact      *)
(* never replaces the slot that the host selected.                         *)
(***************************************************************************)

\* calibrate or a developer tool publishes an exploration profile with a
\* starter policy. It stays unvalidated.
PublishStarter(p) ==
    /\ selected # p
    /\ qual' = [qual EXCEPT ![p] = "unvalidated"]
    /\ boundDef' = [boundDef EXCEPT ![p] = LOADED_DEF]
    /\ boundModel' = [boundModel EXCEPT ![p] = resolvedModel]
    /\ \E sc \in SCOPES : scope' = [scope EXCEPT ![p] = sc]
    /\ UNCHANGED <<resolvedModel, hostState, rejections, lastRunOutcome,
                    enforceSnap>>
    /\ MarkReset("starter")

\* Frozen validation on independent data computes the status of a new
\* candidate artifact. No feasible policy and weak evidence are valid
\* results. The step never selects the artifact for the host.
Qualify(p, s) ==
    /\ selected # p
    /\ s \in COMPUTED
    /\ qual' = [qual EXCEPT ![p] = s]
    /\ boundDef' = [boundDef EXCEPT ![p] = LOADED_DEF]
    /\ boundModel' = [boundModel EXCEPT ![p] = resolvedModel]
    /\ \E sc \in SCOPES : scope' = [scope EXCEPT ![p] = sc]
    /\ UNCHANGED <<resolvedModel, hostState, rejections, lastRunOutcome,
                    enforceSnap>>
    /\ MarkReset("qualify")

(***************************************************************************)
(* Mode admission. Each guard names the validation that the library        *)
(* performs before any evaluator runs.                                     *)
(***************************************************************************)

\* evaluate uses any compatible profile. The qualification status does
\* not gate evaluation, and evaluation changes no profile state.
RunEvaluation(p) ==
    /\ Compatible(p)
    /\ lastRunOutcome' = "none"
    /\ UNCHANGED <<qual, binding, resolvedModel, hostState, rejections,
                    enforceSnap>>
    /\ MarkRun("evaluation")

\* A shadow run records its outcome next to the existing decision. It
\* performs no application action and grants no authorization.
RunShadow(p, o) ==
    /\ Compatible(p)
    /\ o \in OUTCOMES
    /\ lastRunOutcome' = o
    /\ UNCHANGED <<qual, binding, resolvedModel, hostState, rejections,
                    enforceSnap>>
    /\ MarkRun("shadow")

\* Enforcement requires the full admission gate. The snapshot records
\* what the gate admitted.
RunEnforcement(p, o) ==
    /\ EnforcementGate(p)
    /\ o \in OUTCOMES
    /\ lastRunOutcome' = o
    /\ lastEnforceProfile' = p
    /\ lastEnforceQual' = qual[p]
    /\ lastEnforceCompatible' = Compatible(p)
    /\ lastEnforceScope' = scope[p]
    /\ lastEnforceSelected' = selected
    /\ UNCHANGED <<qual, binding, resolvedModel, hostState, rejections>>
    /\ MarkRun("enforcement")

\* A mode request that fails its gate is refused before execution. The
\* library records the refusal. It changes no profile state.
RefuseRun(p, m) ==
    /\ m \in RUN_MODES
    /\ IF m = "enforcement" THEN ~EnforcementGate(p) ELSE ~Compatible(p)
    /\ rejections < MaxRejections
    /\ rejections' = rejections + 1
    /\ UNCHANGED <<qual, binding, resolvedModel, hostState,
                    lastRunOutcome, enforceSnap>>
    /\ MarkReset("refuse")

(***************************************************************************)
(* Host transitions. The library performs none of them. The host may      *)
(* select any slot: its review procedure is outside the model, and the    *)
(* admission gate does not trust the selection.                            *)
(***************************************************************************)

\* The host selects one reviewed profile hash for enforcement.
HostSelect(p) ==
    /\ selected # p
    /\ selected' = p
    /\ UNCHANGED <<qual, binding, resolvedModel, authorized, rejections,
                    lastRunOutcome, enforceSnap>>
    /\ MarkReset("select")

\* The host withdraws its selection.
HostDeselect ==
    /\ selected # NO_PROFILE
    /\ selected' = NO_PROFILE
    /\ UNCHANGED <<qual, binding, resolvedModel, authorized, rejections,
                    lastRunOutcome, enforceSnap>>
    /\ MarkReset("deselect")

\* The host grants application authorization through its own policy.
HostAuthorize ==
    /\ authorized = FALSE
    /\ authorized' = TRUE
    /\ UNCHANGED <<qual, binding, resolvedModel, selected, rejections,
                    lastRunOutcome, enforceSnap>>
    /\ MarkReset("authorize")

\* The host withdraws application authorization.
HostRevoke ==
    /\ authorized = TRUE
    /\ authorized' = FALSE
    /\ UNCHANGED <<qual, binding, resolvedModel, selected, rejections,
                    lastRunOutcome, enforceSnap>>
    /\ MarkReset("revoke")

(***************************************************************************)
(* Environment transition. The alias resolves to another model. The        *)
(* material change invalidates the qualification of every stale binding.  *)
(***************************************************************************)

ModelDrift ==
    /\ resolvedModel = "m-1"
    /\ resolvedModel' = "m-2"
    /\ qual' = [q \in PROFILES |->
         IF boundModel[q] = "m-1" THEN "unvalidated" ELSE qual[q]]
    /\ UNCHANGED <<binding, hostState, rejections, lastRunOutcome,
                    enforceSnap>>
    /\ MarkReset("drift")

(***************************************************************************)
(* Next-state relation.                                                    *)
(***************************************************************************)

Next ==
    \/ \E p \in PROFILES :
         PublishStarter(p) \/ RunEvaluation(p) \/ HostSelect(p)
    \/ \E p \in PROFILES, s \in COMPUTED : Qualify(p, s)
    \/ \E p \in PROFILES, o \in OUTCOMES :
         RunShadow(p, o) \/ RunEnforcement(p, o)
    \/ \E p \in PROFILES, m \in RUN_MODES : RefuseRun(p, m)
    \/ HostDeselect \/ HostAuthorize \/ HostRevoke \/ ModelDrift

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Safety invariants.                                                      *)
(***************************************************************************)

TypeOK ==
    /\ qual \in [PROFILES -> STATUSES]
    /\ boundDef \in [PROFILES -> DEFINITIONS]
    /\ boundModel \in [PROFILES -> MODELS]
    /\ scope \in [PROFILES -> SCOPES]
    /\ resolvedModel \in MODELS
    /\ selected \in {NO_PROFILE} \cup PROFILES
    /\ authorized \in BOOLEAN
    /\ rejections \in 0..MaxRejections
    /\ lastEvent \in EVENTS
    /\ prevQual \in [PROFILES -> STATUSES]
    /\ prevSelected \in {NO_PROFILE} \cup PROFILES
    /\ prevAuthorized \in BOOLEAN
    /\ lastRunOutcome \in OUTCOMES \cup {"none"}
    /\ lastEnforceProfile \in {NO_PROFILE} \cup PROFILES
    /\ lastEnforceQual \in STATUSES \cup {"none"}
    /\ lastEnforceCompatible \in BOOLEAN
    /\ lastEnforceScope \in SCOPES \cup {"none"}
    /\ lastEnforceSelected \in {NO_PROFILE} \cup PROFILES

\* Every accepted enforcement run passed the full admission gate: a
\* validated profile, a compatible binding, a matching scope, and the
\* selected hash. No other step writes the snapshot.
EnforcementAdmissionSound ==
    lastEnforceProfile = NO_PROFILE
    \/ /\ lastEnforceQual = "validated_for_scope"
       /\ lastEnforceCompatible
       /\ lastEnforceScope = USE_SCOPE
       /\ lastEnforceSelected = lastEnforceProfile

\* No run, evaluation, or shadow report promotes a profile. A status
\* changes only in a qualification step or in the drift demotion.
RunsDoNotPromote ==
    lastEvent \in RUN_MODES => qual = prevQual

\* No library step changes the host selection or the application
\* authorization. Both belong to the host alone.
HostStateHostControlled ==
    lastEvent \in LIBRARY_EVENTS =>
        /\ selected = prevSelected
        /\ authorized = prevAuthorized

\* A shadow run that ends in pass still grants no application
\* authorization. The host may act later, on its own steps only.
ShadowPassNeverAuthorizes ==
    (lastEvent = "shadow" /\ lastRunOutcome = "pass") =>
        authorized = prevAuthorized

\* After the alias drifted, every stale binding is unvalidated. A
\* material change cannot keep a qualification that it invalidated.
DriftInvalidatesStaleBindings ==
    (resolvedModel = "m-2") =>
        \A p \in PROFILES :
            boundModel[p] = "m-1" => qual[p] = "unvalidated"

\* Only an artifact that binds the loaded definition can hold a
\* validated status. Qualification against another definition does not
\* transfer.
ValidatedProfilesBindLoadedDefinition ==
    \A p \in PROFILES :
        qual[p] = "validated_for_scope" => boundDef[p] = LOADED_DEF

=============================================================================
