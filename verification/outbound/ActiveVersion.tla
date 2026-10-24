--------------------------- MODULE ActiveVersion ---------------------------
EXTENDS Naturals
CONSTANT UnsafeActiveVersion
VARIABLES active, dbVersion, oldPending, newPending, disabled, regressed
vars == <<active, dbVersion, oldPending, newPending, disabled, regressed>>
\* Start after a handoff allocated two versions and started both D1 writes.
\* The old enable has version 1, the new disable has version 2. Each may commit first.
\* Allocation/handoff are exercised in the real-code replay, not proved by this model.
Init == /\ active = TRUE /\ dbVersion = 0 /\ oldPending = TRUE
        /\ newPending = TRUE /\ disabled = FALSE /\ regressed = FALSE
ApplyNew ==
  /\ newPending \* src/coordinator.ts:49-53; pending program counter at the awaited D1 projection
  /\ active' = FALSE /\ dbVersion' = 2 /\ disabled' = TRUE /\ newPending' = FALSE
  /\ UNCHANGED <<oldPending, regressed>>
ApplyOld ==
  /\ oldPending \* src/coordinator.ts:49-53; pending program counter at the old D1 projection
  /\ active' = IF dbVersion < 1 \/ UnsafeActiveVersion THEN TRUE ELSE active
  /\ dbVersion' = IF dbVersion < 1 \/ UnsafeActiveVersion THEN 1 ELSE dbVersion
  /\ regressed' = (regressed \/ (disabled /\ UnsafeActiveVersion))
  /\ oldPending' = FALSE
  /\ UNCHANGED <<newPending, disabled>>
Next == ApplyNew \/ ApplyOld
Spec == Init /\ [][Next]_vars
TypeOK == /\ active \in BOOLEAN /\ dbVersion \in 0..2 /\ oldPending \in BOOLEAN
          /\ newPending \in BOOLEAN /\ disabled \in BOOLEAN /\ regressed \in BOOLEAN
\* An old enable already in flight cannot undo a newer completed disable.
NoStaleActiveWrite == ~regressed /\ (disabled => ~active)
=============================================================================
