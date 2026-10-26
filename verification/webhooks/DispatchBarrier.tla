--------------------------- MODULE DispatchBarrier ---------------------------
EXTENDS Naturals
CONSTANTS EmailOnly, UnsafeBarrier, UnsafeFence
VARIABLES owner, config, active, configVersion, activeVersion, pending,
          kind, pc, newerChange, dispatched
vars == <<owner, config, active, configVersion, activeVersion, pending,
          kind, pc, newerChange, dispatched>>
Init == /\ owner = 1 /\ config = "original" /\ active = TRUE
        /\ configVersion = 0 /\ activeVersion = 0 /\ pending = FALSE
        /\ kind = "none" /\ pc = "idle" /\ newerChange = FALSE /\ dispatched = {}

\* An old actor starts a config/active-state D1 projection after allocating
\* synchronous SQLite sequence 1. That external write may outlive its actor.
StartOldProjection(k) ==
  /\ owner = 1 /\ ~pending /\ kind = "none" \* src/coordinator.ts:75 (program location / finite-run bound)
  /\ k \in (IF EmailOnly THEN {"disable"} ELSE {"replace", "disable"}) \* src/coordinator.ts:75 (program location / finite-run bound)
  /\ pending' = TRUE /\ kind' = k
  /\ UNCHANGED <<owner, config, active, configVersion, activeVersion, pc, newerChange, dispatched>>
Replace ==
  /\ owner = 1 /\ pending /\ owner' = 2 \* src/coordinator.ts:30 (actor handoff during the awaited projection)
  /\ UNCHANGED <<config, active, configVersion, activeVersion, pending, kind, pc, newerChange, dispatched>>
Prepare ==
  /\ owner = 2 /\ pc = "idle" \* src/webhook-delivery.ts:25 (program location / finite-run bound)
  /\ pc' = IF active /\ config = "original" THEN "prepared" ELSE "cancelled"
  /\ UNCHANGED <<owner, config, active, configVersion, activeVersion, pending, kind, newerChange, dispatched>>

\* Both the synchronous sequence reservation and the later D1 batch are
\* visible separately. A third actor can replace this one during the await.
ReserveBarrier ==
  /\ owner = 2 /\ pc = "prepared" \* src/coordinator.ts:63 (program location / finite-run bound)
  /\ pc' = IF UnsafeBarrier THEN "verified" ELSE "barrier"
  /\ UNCHANGED <<owner, config, active, configVersion, activeVersion, pending, kind, newerChange, dispatched>>
CommitBarrier ==
  /\ pc = "barrier" \* src/dispatch-barrier.ts:10 (program location / finite-run bound)
  /\ LET matches == active /\ activeVersion < 2 /\ (EmailOnly \/ (config = "original" /\ configVersion < 2)) \* src/dispatch-barrier.ts:10 (program location / finite-run bound)
     IN /\ activeVersion' = IF matches THEN 2 ELSE activeVersion
        /\ configVersion' = IF matches /\ ~EmailOnly THEN 2 ELSE configVersion
        /\ pc' = IF matches THEN "verified" ELSE "cancelled"
  /\ UNCHANGED <<owner, config, active, pending, kind, newerChange, dispatched>>

ApplyOldProjection ==
  /\ pending \* src/webhook-store.ts:60 (program location / finite-run bound)
  /\ config' = IF kind = "replace" /\ configVersion < 1 THEN "replacement" ELSE config
  /\ configVersion' = IF kind = "replace" /\ configVersion < 1 THEN 1 ELSE configVersion
  /\ active' = IF kind = "disable" /\ activeVersion < 1 THEN FALSE ELSE active
  /\ activeVersion' = IF kind = "disable" /\ activeVersion < 1 THEN 1 ELSE activeVersion
  /\ pending' = FALSE
  /\ UNCHANGED <<owner, kind, pc, newerChange, dispatched>>
ReplaceAgain ==
  /\ owner = 2 /\ owner' = 3
  /\ UNCHANGED <<config, active, configVersion, activeVersion, pending, kind, pc, newerChange, dispatched>>
NewOwnerChange ==
  /\ owner = 3 /\ ~newerChange \* src/coordinator.ts:68 (program location / finite-run bound)
  /\ config' = IF EmailOnly THEN config ELSE "replacement"
  /\ configVersion' = IF EmailOnly THEN configVersion ELSE 3
  /\ active' = FALSE /\ activeVersion' = 3
  /\ newerChange' = TRUE
  /\ UNCHANGED <<owner, pending, kind, pc, dispatched>>

\* A barrier without this final synchronous fence still permits replacement
\* during its D1 await. No await separates the fence and fetch initiation.
Dispatch ==
  /\ pc = "verified" /\ (owner = 2 \/ UnsafeFence) \* src/webhook-delivery.ts:99 (program location / finite-run bound)
  /\ dispatched' = dispatched \cup {<<config, active, owner>>}
  /\ pc' = "done"
  /\ UNCHANGED <<owner, config, active, configVersion, activeVersion, pending, kind, newerChange>>
FenceReject ==
  /\ pc = "verified" /\ owner # 2 /\ ~UnsafeFence \* src/webhook-delivery.ts:99 (program location / finite-run bound)
  /\ pc' = "cancelled"
  /\ UNCHANGED <<owner, config, active, configVersion, activeVersion, pending, kind, newerChange, dispatched>>
Next == (\E k \in (IF EmailOnly THEN {"disable"} ELSE {"replace", "disable"}): StartOldProjection(k)) \/ Replace \/ Prepare \/
        ReserveBarrier \/ CommitBarrier \/ ApplyOldProjection \/ ReplaceAgain \/
        NewOwnerChange \/ Dispatch \/ FenceReject
Spec == Init /\ [][Next]_vars
TypeOK == /\ owner \in 1..3 /\ config \in {"original", "replacement"} /\ active \in BOOLEAN
          /\ configVersion \in 0..3 /\ activeVersion \in 0..3 /\ pending \in BOOLEAN
          /\ kind \in {"none", "replace", "disable"}
          /\ pc \in {"idle", "prepared", "barrier", "verified", "cancelled", "done"}
          /\ newerChange \in BOOLEAN
          /\ dispatched \subseteq {"original", "replacement"} \X BOOLEAN \X (1..3)
\* Neither a delayed old projection nor a new owner can invalidate a dispatched snapshot.
NoObsoleteDispatch == \A d \in dispatched: d[1] = "original" /\ d[2] /\ d[3] = 2
=============================================================================
