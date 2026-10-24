----------------------------- MODULE Outbound -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Workers, MaxAttempts, UnsafeClaim
VARIABLES status, active, pc, snapshot, result, attempts, submissions,
          acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown
vars == <<status, active, pc, snapshot, result, attempts, submissions,
          acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

Init == /\ status = "pending" /\ active = TRUE
        /\ pc = [w \in Workers |-> "idle"]
        /\ snapshot = [w \in Workers |-> FALSE]
        /\ result = [w \in Workers |-> "none"]
        /\ attempts = 0 /\ submissions = 0 /\ acceptances = 0
        /\ ambiguous = FALSE /\ ambiguousAttempts = 0
        /\ badDisabled = FALSE /\ badUnknown = FALSE

Claim(w) ==
  /\ pc[w] = "idle" /\ attempts < MaxAttempts
  /\ (status = "pending" \/ UnsafeClaim) \* src/outbound.ts:86; due-time abstracted away
  /\ status' = "sending" /\ attempts' = attempts + 1
  /\ pc' = [pc EXCEPT ![w] = "claimed"]
  /\ UNCHANGED <<active, snapshot, result, submissions, acceptances,
                 ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

ReadActive(w) ==
  /\ pc[w] = "claimed" \* src/outbound.ts:91-93; a separate awaited SELECT
  /\ snapshot' = [snapshot EXCEPT ![w] = active]
  /\ pc' = [pc EXCEPT ![w] = "checked"]
  /\ UNCHANGED <<status, active, result, attempts, submissions, acceptances,
                 ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

Dispatch(w) ==
  /\ pc[w] = "checked" /\ snapshot[w] \* src/outbound.ts:94-95; cached active only
  /\ submissions' = submissions + 1
  /\ badDisabled' = (badDisabled \/ ~active)
  /\ badUnknown' = (badUnknown \/ (status = "unknown"))
  /\ pc' = [pc EXCEPT ![w] = "waiting"]
  /\ UNCHANGED <<status, active, snapshot, result, attempts, acceptances,
                 ambiguous, ambiguousAttempts>>

RejectDisabled(w) ==
  /\ pc[w] = "checked" /\ ~snapshot[w] \* src/outbound.ts:94-96
  /\ result' = [result EXCEPT ![w] = "failed"]
  /\ pc' = [pc EXCEPT ![w] = "result"]
  /\ UNCHANGED <<status, active, snapshot, attempts, submissions, acceptances,
                 ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

ProviderReply(w, outcome, effect) ==
  /\ pc[w] = "waiting" \* src/outbound.ts:39-84
  /\ outcome \in {"accepted", "failed", "retry", "unknown"}
  /\ effect \in (IF outcome = "accepted" THEN {1}
                 ELSE IF outcome = "unknown" THEN {0,1} ELSE {0})
  /\ result' = [result EXCEPT ![w] = outcome]
  /\ acceptances' = acceptances + effect
  /\ ambiguous' = (ambiguous \/ (outcome = "unknown"))
  /\ ambiguousAttempts' = IF ~ambiguous /\ outcome = "unknown" THEN attempts ELSE ambiguousAttempts
  /\ pc' = [pc EXCEPT ![w] = "result"]
  /\ UNCHANGED <<status, active, snapshot, attempts, submissions, badDisabled, badUnknown>>

Persist(w) ==
  /\ pc[w] = "result" /\ status = "sending" \* src/outbound.ts:97-117
  /\ status' = IF result[w] = "retry"
                THEN IF attempts < 8 THEN "pending" ELSE "failed"
                ELSE result[w]
  /\ pc' = [pc EXCEPT ![w] = "done"]
  /\ UNCHANGED <<active, snapshot, result, attempts, submissions, acceptances,
                 ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

StaleCompletion(w) ==
  /\ pc[w] = "result" /\ status # "sending" \* src/outbound.ts:100,108; conditional write affects zero rows
  /\ pc' = [pc EXCEPT ![w] = "done"]
  /\ UNCHANGED <<status, active, snapshot, result, attempts, submissions,
                 acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

Crash(w, effect) ==
  /\ pc[w] \in {"claimed", "checked", "waiting", "result"} \* docs/operations.md: worker can stop at an await
  /\ effect \in (IF pc[w] = "waiting" THEN {0,1} ELSE {0})
  /\ pc' = [pc EXCEPT ![w] = "done"] /\ acceptances' = acceptances + effect
  /\ ambiguous' = (ambiguous \/ (pc[w] = "waiting"))
  /\ ambiguousAttempts' = IF ~ambiguous /\ pc[w] = "waiting" THEN attempts ELSE ambiguousAttempts
  /\ UNCHANGED <<status, active, snapshot, result, attempts, submissions, badDisabled, badUnknown>>

Cron ==
  /\ status = "sending" \* src/maintenance.ts:23-26; enabled only once the 2-minute threshold has elapsed
  /\ status' = "unknown" /\ ambiguous' = TRUE
  /\ ambiguousAttempts' = IF ambiguous THEN ambiguousAttempts ELSE attempts
  /\ UNCHANGED <<active, pc, snapshot, result, attempts, submissions,
                 acceptances, badDisabled, badUnknown>>

Disable ==
  /\ active \* src/api.ts:179-182; one independent D1 UPDATE
  /\ active' = FALSE
  /\ UNCHANGED <<status, pc, snapshot, result, attempts, submissions,
                 acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

NextJob(w) ==
  /\ pc[w] = "done" /\ status = "pending" \* src/index.ts:27-29; queue redelivery after known rejection
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<status, active, snapshot, result, attempts, submissions,
                 acceptances, ambiguous, ambiguousAttempts, badDisabled, badUnknown>>

Next == \/ Disable \/ Cron
        \/ \E w \in Workers: Claim(w) \/ ReadActive(w) \/ Dispatch(w)
              \/ RejectDisabled(w) \/ Persist(w) \/ StaleCompletion(w) \/ NextJob(w)
              \/ (\E o \in {"accepted","failed","retry","unknown"}, e \in {0,1}: ProviderReply(w,o,e))
              \/ (\E e \in {0,1}: Crash(w,e))
Spec == Init /\ [][Next]_vars

TypeOK == /\ status \in {"pending","sending","accepted","failed","unknown"}
          /\ active \in BOOLEAN /\ attempts \in 0..MaxAttempts
          /\ submissions \in 0..MaxAttempts /\ acceptances \in 0..MaxAttempts
          /\ pc \in [Workers -> {"idle","claimed","checked","waiting","result","done"}]
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
