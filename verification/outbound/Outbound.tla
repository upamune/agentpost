----------------------------- MODULE Outbound -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Workers, MaxAttempts, UnsafeClaim, UnsafeSerialization, UnsafeFence
VARIABLES status, active, pc, snapshot, result, attempts, submissions,
          acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown, owner, valid
vars == <<status, active, pc, snapshot, result, attempts, submissions,
          acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown, owner, valid>>

Init == /\ status = "pending" /\ active = TRUE
        /\ pc = [w \in Workers |-> "idle"]
        /\ snapshot = [w \in Workers |-> FALSE]
        /\ result = [w \in Workers |-> "none"]
        /\ attempts = 0 /\ submissions = 0 /\ acceptances = 0
        /\ ambiguous = FALSE /\ ambiguousAttempts = 0
        /\ badDisabled = FALSE /\ badUnknown = FALSE
        /\ owner = "none" /\ valid = [w \in Workers |-> TRUE]

Acquire(w) ==
  /\ pc[w] = "idle" /\ attempts < MaxAttempts \* src/coordinator.ts:18; bounded by outbound.ts:126 retry cap
  /\ owner = "none" \* src/coordinator.ts:18-23: mutex acquisition before awaited D1 claim
  /\ owner' = w /\ valid' = [valid EXCEPT ![w] = TRUE]
  /\ pc' = [pc EXCEPT ![w] = "claiming"]
  /\ UNCHANGED <<status, active, snapshot, result, attempts, submissions, acceptances,
                 ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

Claim(w) ==
  /\ pc[w] = "claiming" /\ attempts < MaxAttempts \* src/outbound.ts:99-104; awaited D1 claim completes, even after replacement
  /\ (status = "pending" \/ UnsafeClaim) \* src/outbound.ts:100; due-time abstracted away
  /\ status' = "sending" /\ attempts' = attempts + 1
  /\ pc' = [pc EXCEPT ![w] = "claimed"]
  /\ UNCHANGED <<active, snapshot, result, submissions, acceptances,
                 ambiguous, ambiguousAttempts, badDisabled, badUnknown, owner, valid>>

NoClaim(w) ==
  /\ pc[w] = "claiming" /\ status # "pending" /\ ~UnsafeClaim \* src/outbound.ts:104
  /\ pc' = [pc EXCEPT ![w] = "done"]
  /\ owner' = IF owner = w THEN "none" ELSE owner
  /\ UNCHANGED <<status, active, snapshot, result, attempts, submissions, acceptances,
                 ambiguous, ambiguousAttempts, badDisabled, badUnknown, valid>>

ReadActive(w) ==
  /\ pc[w] = "claimed" \* src/outbound.ts:105-107; a separate awaited SELECT
  /\ snapshot' = [snapshot EXCEPT ![w] = active]
  /\ pc' = [pc EXCEPT ![w] = "checked"]
  /\ UNCHANGED <<status, active, result, attempts, submissions, acceptances,
                 ambiguous, ambiguousAttempts, badDisabled, badUnknown, owner, valid>>

Dispatch(w) ==
  /\ pc[w] = "checked" /\ snapshot[w] \* src/outbound.ts:109
  /\ (valid[w] \/ UnsafeFence) \* src/coordinator.ts:29-35: synchronous ownership storage fence, then send without await
  \* src/outbound.ts:109-113; cached active inside the mutex, synchronous fence and provider call in one turn
  /\ submissions' = submissions + 1
  /\ badDisabled' = (badDisabled \/ ~active)
  /\ badUnknown' = (badUnknown \/ (status = "unknown"))
  /\ pc' = [pc EXCEPT ![w] = "waiting"]
  /\ UNCHANGED <<status, active, snapshot, result, attempts, acceptances,
                 ambiguous, ambiguousAttempts, owner, valid>>

RejectDisabled(w) ==
  /\ pc[w] = "checked" /\ ~snapshot[w] \* src/outbound.ts:109-115
  /\ result' = [result EXCEPT ![w] = "failed"]
  /\ pc' = [pc EXCEPT ![w] = "result"]
  /\ UNCHANGED <<status, active, snapshot, attempts, submissions, acceptances,
                 ambiguous, ambiguousAttempts, badDisabled, badUnknown, owner, valid>>

ProviderReply(w, outcome, effect) ==
  /\ pc[w] = "waiting" \* src/outbound.ts:25-85
  /\ outcome \in {"accepted", "failed", "retry", "unknown"}
  /\ effect \in (IF outcome = "accepted" THEN {1}
                 ELSE IF outcome = "unknown" THEN {0,1} ELSE {0})
  /\ result' = [result EXCEPT ![w] = outcome]
  /\ acceptances' = acceptances + effect
  /\ ambiguous' = (ambiguous \/ (outcome = "unknown"))
  /\ ambiguousAttempts' = IF ~ambiguous /\ outcome = "unknown" THEN attempts ELSE ambiguousAttempts
  /\ pc' = [pc EXCEPT ![w] = "result"]
  /\ UNCHANGED <<status, active, snapshot, attempts, submissions, badDisabled, badUnknown, owner, valid>>

Persist(w) ==
  /\ pc[w] = "result" /\ status = "sending" \* src/outbound.ts:120-146 (settleSend)
  /\ status' = IF result[w] = "retry"
                THEN IF attempts < 8 THEN "pending" ELSE "failed"
                ELSE result[w]
  /\ pc' = [pc EXCEPT ![w] = "done"]
  /\ owner' = IF owner = w THEN "none" ELSE owner
  /\ valid' = valid
  /\ UNCHANGED <<active, snapshot, result, attempts, submissions, acceptances,
                 ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

StaleCompletion(w) ==
  /\ pc[w] = "result" /\ status # "sending" \* src/outbound.ts:129,137; conditional write affects zero rows
  /\ pc' = [pc EXCEPT ![w] = "done"]
  /\ owner' = IF owner = w THEN "none" ELSE owner
  /\ valid' = valid
  /\ UNCHANGED <<status, active, snapshot, result, attempts, submissions,
                 acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

Crash(w, effect) ==
  /\ pc[w] \in {"claiming", "claimed", "checked", "waiting", "result"} \* docs/operations.md: worker can stop at an await
  /\ effect \in (IF pc[w] = "waiting" THEN {0,1} ELSE {0})
  /\ pc' = [pc EXCEPT ![w] = "done"] /\ acceptances' = acceptances + effect
  /\ ambiguous' = (ambiguous \/ (pc[w] = "waiting"))
  /\ ambiguousAttempts' = IF ~ambiguous /\ pc[w] = "waiting" THEN attempts ELSE ambiguousAttempts
  /\ owner' = IF owner = w THEN "none" ELSE owner
  /\ valid' = valid
  /\ UNCHANGED <<status, active, snapshot, result, attempts, submissions, badDisabled, badUnknown>>

Cron ==
  /\ status = "sending" /\ (owner = "none" \/ UnsafeSerialization) \* src/coordinator.ts:59-66; enabled only once the 2-minute threshold has elapsed
  /\ status' = "unknown" /\ ambiguous' = TRUE
  /\ ambiguousAttempts' = IF ambiguous THEN ambiguousAttempts ELSE attempts
  /\ UNCHANGED <<active, pc, snapshot, result, attempts, submissions,
                 acceptances, badDisabled, badUnknown, owner, valid>>

Disable ==
  /\ active /\ (owner = "none" \/ UnsafeSerialization) \* src/coordinator.ts:45-53; one D1 UPDATE while holding the mutex
  /\ active' = FALSE
  /\ UNCHANGED <<status, pc, snapshot, result, attempts, submissions,
                 acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown, owner, valid>>

NextJob(w) ==
  /\ pc[w] = "done" /\ status = "pending" \* src/index.ts:32-34; queue redelivery after known rejection
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<status, active, snapshot, result, attempts, submissions,
                 acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown, owner, valid>>

Replace(w) ==
  /\ owner = w /\ valid[w] \* src/coordinator.ts:29-35; Cloudflare known-issues/global-uniqueness: replacement may leave a delayed event alive until storage access
  /\ owner' = "none" /\ valid' = [valid EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<status, active, pc, snapshot, result, attempts, submissions,
                 acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

FenceRejected(w) ==
  /\ pc[w] = "checked" /\ snapshot[w] /\ ~valid[w] /\ ~UnsafeFence \* src/coordinator.ts:29-35, outbound.ts:111
  /\ pc' = [pc EXCEPT ![w] = "done"]
  /\ UNCHANGED <<status, active, snapshot, result, attempts, submissions,
                 acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown, owner, valid>>

Next == \/ Disable \/ Cron
        \/ \E w \in Workers: Acquire(w) \/ Claim(w) \/ NoClaim(w) \/ ReadActive(w) \/ Dispatch(w) \/ Replace(w) \/ FenceRejected(w)
              \/ RejectDisabled(w) \/ Persist(w) \/ StaleCompletion(w) \/ NextJob(w)
              \/ (\E o \in {"accepted","failed","retry","unknown"}, e \in {0,1}: ProviderReply(w,o,e))
              \/ (\E e \in {0,1}: Crash(w,e))
Spec == Init /\ [][Next]_vars

TypeOK == /\ owner \in Workers \cup {"none"} /\ valid \in [Workers -> BOOLEAN]
          /\ status \in {"pending","sending","accepted","failed","unknown"}
          /\ active \in BOOLEAN /\ attempts \in 0..MaxAttempts
          /\ submissions \in 0..MaxAttempts /\ acceptances \in 0..MaxAttempts
          /\ pc \in [Workers -> {"idle","claiming","claimed","checked","waiting","result","done"}]
          /\ snapshot \in [Workers -> BOOLEAN]
          /\ result \in [Workers -> {"none","accepted","failed","retry","unknown"}]
          /\ ambiguous \in BOOLEAN /\ ambiguousAttempts \in 0..MaxAttempts
          /\ badDisabled \in BOOLEAN /\ badUnknown \in BOOLEAN
\* The same outbox request must not be accepted twice by the provider.
AtMostOneAcceptance == acceptances <= 1
\* After an ambiguous outcome, no new claim/retry may be created.
NoBlindRetry == ~ambiguous \/ attempts = ambiguousAttempts
\* A disabled inbox must not start a new provider call after disable completes.
NoDispatchAfterDisable == ~badDisabled
\* A stale worker must not start a new provider call after Cron declares its outcome unknown.
NoDispatchAfterUnknown == ~badUnknown
=============================================================================
