--------------------------- MODULE Delivery ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS UnsafeFence, UnsafeClaim, UnsafeSettlement
VARIABLES owner, active, config, changed, status, claimToken, claims,
          phase, localToken, allowed, preparedTarget, dispatched,
          badClaim, staleSettlement
vars == <<owner, active, config, changed, status, claimToken, claims,
          phase, localToken, allowed, preparedTarget, dispatched,
          badClaim, staleSettlement>>
Actors == {1, 2}
Phases == {"idle", "claimed", "checked", "prepared", "waiting", "result", "done"}
Statuses == {"pending", "sending", "delivered", "failed", "cancelled"}
Target(c) == IF c = 1 THEN "original.example" ELSE "replacement.example"
Busy(a) == phase[a] \notin {"idle", "done"}

\* One immutable delivery is bound to (inbox, original configuration, message).
\* Two actors, two claims, one actor replacement, and one configuration change
\* suffice for stale preparation/results. There is no email resend action.
Init ==
  /\ owner = 1 /\ active = TRUE /\ config = 1 /\ changed = FALSE
  /\ status = "pending" /\ claimToken = 0 /\ claims = 0
  /\ phase = [a \in Actors |-> "idle"]
  /\ localToken = [a \in Actors |-> 0]
  /\ allowed = [a \in Actors |-> FALSE]
  /\ preparedTarget = [a \in Actors |-> "none"]
  /\ dispatched = {} /\ badClaim = FALSE /\ staleSettlement = FALSE

Claim(a) ==
  /\ owner = a /\ phase[a] = "idle" /\ claims < 2 \* src/webhook-delivery.ts:19 (program location / finite-run bound)
  /\ status = "pending" \/ (UnsafeClaim /\ status = "sending") \* src/webhook-delivery.ts:19 (program location / finite-run bound)
  /\ status' = "sending" /\ claims' = claims + 1 /\ claimToken' = claims + 1
  /\ localToken' = [localToken EXCEPT ![a] = claims + 1]
  /\ phase' = [phase EXCEPT ![a] = "claimed"]
  /\ badClaim' = (badClaim \/ status # "pending")
  /\ UNCHANGED <<owner, active, config, changed, allowed, preparedTarget,
                  dispatched, staleSettlement>>

ReadCurrent(a) ==
  /\ phase[a] = "claimed" \* src/webhook-delivery.ts:28 (program location / finite-run bound)
  /\ allowed' = [allowed EXCEPT ![a] = active /\ config = 1]
  /\ phase' = [phase EXCEPT ![a] = "checked"]
  /\ UNCHANGED <<owner, active, config, changed, status, claimToken, claims,
                  localToken, preparedTarget, dispatched, badClaim, staleSettlement>>

\* URL decryption, key import and HMAC generation are awaited. They operate on
\* the immutable original configuration, not the newest inbox destination.
Prepare(a) ==
  /\ phase[a] = "checked" \* src/webhook-delivery.ts:32 (program location / finite-run bound)
  /\ preparedTarget' = [preparedTarget EXCEPT ![a] = Target(1)]
  /\ phase' = [phase EXCEPT ![a] = IF allowed[a] THEN "prepared" ELSE "result"]
  /\ UNCHANGED <<owner, active, config, changed, status, claimToken, claims,
                  localToken, allowed, dispatched, badClaim, staleSettlement>>

\* No await separates the synchronous SQLite ownership fence and fetch().
Dispatch(a) ==
  /\ phase[a] = "prepared" \* src/webhook-delivery.ts:99 (program location / finite-run bound)
  /\ owner = a \/ UnsafeFence \* src/webhook-delivery.ts:99 (program location / finite-run bound)
  /\ dispatched' = dispatched \cup {<<a, config, active, preparedTarget[a]>>}
  /\ phase' = [phase EXCEPT ![a] = "waiting"]
  /\ UNCHANGED <<owner, active, config, changed, status, claimToken, claims,
                  localToken, allowed, preparedTarget, badClaim, staleSettlement>>

FenceReject(a) ==
  /\ phase[a] = "prepared" /\ owner # a /\ ~UnsafeFence \* src/webhook-delivery.ts:99 (program location / finite-run bound)
  /\ phase' = [phase EXCEPT ![a] = "done"]
  /\ UNCHANGED <<owner, active, config, changed, status, claimToken, claims,
                  localToken, allowed, preparedTarget, dispatched, badClaim, staleSettlement>>

Response(a) ==
  /\ phase[a] = "waiting" \* src/webhook-delivery.ts:101 (program location / finite-run bound)
  /\ phase' = [phase EXCEPT ![a] = "result"]
  /\ UNCHANGED <<owner, active, config, changed, status, claimToken, claims,
                  localToken, allowed, preparedTarget, dispatched, badClaim, staleSettlement>>

Settle(a) ==
  /\ phase[a] = "result" \* src/webhook-delivery.ts:111 (program location / finite-run bound)
  /\ LET accepts == status = "sending" /\ (localToken[a] = claimToken \/ UnsafeSettlement) \* src/webhook-delivery.ts:111 (program location / finite-run bound)
     IN /\ status' = IF accepts THEN IF allowed[a] THEN "delivered" ELSE "cancelled" ELSE status
        /\ staleSettlement' = (staleSettlement \/ (accepts /\ localToken[a] # claimToken))
  /\ phase' = [phase EXCEPT ![a] = "done"]
  /\ UNCHANGED <<owner, active, config, changed, claimToken, claims,
                  localToken, allowed, preparedTarget, dispatched, badClaim>>

Replace ==
  /\ owner = 1 /\ owner' = 2
  /\ UNCHANGED <<active, config, changed, status, claimToken, claims, phase,
                  localToken, allowed, preparedTarget, dispatched, badClaim, staleSettlement>>

\* Replacement/delete/inbox disable is serialized on the current actor. An old
\* actor can still resume after replacement; its final fence must reject it.
Change(kind) ==
  /\ ~changed /\ ~Busy(owner) \* src/coordinator.ts:68 (program location / finite-run bound)
  /\ kind \in {"replace", "delete", "disable"} \* src/coordinator.ts:68 (program location / finite-run bound)
  /\ config' = IF kind = "disable" THEN config ELSE 2
  /\ active' = IF kind = "disable" THEN FALSE ELSE active
  /\ status' = IF kind # "disable" /\ status \in {"pending", "sending"} THEN "cancelled" ELSE status
  /\ changed' = TRUE
  /\ UNCHANGED <<owner, claimToken, claims, phase, localToken, allowed,
                  preparedTarget, dispatched, badClaim, staleSettlement>>

\* A timed-out webhook may retry the same delivery ID. This is deliberately
\* at-least-once; the receiver deduplicates. Outbound email never does this.
Recover ==
  /\ owner = 2 /\ ~Busy(2) /\ status = "sending" \* src/webhook-delivery.ts:14 (program location / finite-run bound)
  /\ status' = "pending"
  /\ UNCHANGED <<owner, active, config, changed, claimToken, claims, phase,
                  localToken, allowed, preparedTarget, dispatched, badClaim, staleSettlement>>

Next == (\E a \in Actors: Claim(a) \/ ReadCurrent(a) \/ Prepare(a) \/
          Dispatch(a) \/ FenceReject(a) \/ Response(a) \/ Settle(a))
        \/ Replace \/ (\E kind \in {"replace", "delete", "disable"}: Change(kind)) \/ Recover
Spec == Init /\ [][Next]_vars
TypeOK == /\ owner \in Actors /\ active \in BOOLEAN /\ config \in {1, 2}
          /\ changed \in BOOLEAN /\ status \in Statuses
          /\ claimToken \in 0..2 /\ claims \in 0..2
          /\ phase \in [Actors -> Phases] /\ localToken \in [Actors -> 0..2]
          /\ allowed \in [Actors -> BOOLEAN]
          /\ preparedTarget \in [Actors -> {"none", Target(1), Target(2)}]
          /\ dispatched \subseteq Actors \X {1, 2} \X BOOLEAN \X {Target(1), Target(2)}
          /\ badClaim \in BOOLEAN /\ staleSettlement \in BOOLEAN
\* No new request starts using a superseded configuration or disabled inbox.
NoObsoleteDispatch == \A d \in dispatched: d[2] = 1 /\ d[3]
\* Already queued events never follow a replacement destination.
ImmutableDestination == \A d \in dispatched: d[4] = Target(1)
\* A queue delivery cannot steal an active claim without explicit stale recovery.
ConditionalClaim == ~badClaim
\* An old HTTP result cannot complete a newer delivery claim.
ClaimBoundSettlement == ~staleSettlement
=============================================================================
