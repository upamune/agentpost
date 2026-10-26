--------------------------- MODULE Idempotency ---------------------------
EXTENDS Naturals
CONSTANTS Provided, UnsafeRegenerate, UnsafeRetry
VARIABLES phase, key, submitted, surfaced, requests
vars == <<phase, key, submitted, surfaced, requests>>
Calls == {1, 2}
NoKey == 3
Init == /\ phase = [c \in Calls |-> "start"] /\ key = [c \in Calls |-> NoKey]
        /\ submitted = [c \in Calls |-> NoKey] /\ surfaced = [c \in Calls |-> NoKey]
        /\ requests = [c \in Calls |-> 0]

\* Collision-free UUIDv4 generation is abstracted to each call's identity.
\* Explicit caller keys are preserved; both calls may intentionally reuse 0.
Resolve(c) ==
  /\ phase[c] = "start" \* src/idempotency.ts:21 (program location / finite-run bound)
  /\ key' = [key EXCEPT ![c] = IF Provided THEN 0 ELSE c]
  /\ phase' = [phase EXCEPT ![c] = "prepared"]
  /\ UNCHANGED <<submitted, surfaced, requests>>
PreparationFailure(c) ==
  /\ phase[c] = "prepared" \* src/idempotency.ts:41 (program location / finite-run bound)
  /\ surfaced' = [surfaced EXCEPT ![c] = IF UnsafeRegenerate THEN NoKey ELSE key[c]]
  /\ phase' = [phase EXCEPT ![c] = "done"]
  /\ UNCHANGED <<key, submitted, requests>>
Submit(c) ==
  /\ phase[c] = "prepared" \/ (UnsafeRetry /\ phase[c] = "submitted" /\ requests[c] < 2) \* src/client.ts:162 (program location / finite-run bound)
  /\ submitted' = [submitted EXCEPT ![c] = key[c]]
  /\ requests' = [requests EXCEPT ![c] = @ + 1]
  /\ phase' = [phase EXCEPT ![c] = "submitted"]
  /\ UNCHANGED <<key, surfaced>>
Surface(c) ==
  /\ phase[c] = "submitted" \* src/client.ts:164 (program location / finite-run bound)
  /\ surfaced' = [surfaced EXCEPT ![c] = IF UnsafeRegenerate THEN NoKey ELSE key[c]]
  /\ phase' = [phase EXCEPT ![c] = "done"]
  /\ UNCHANGED <<key, submitted, requests>>
Next == \E c \in Calls: Resolve(c) \/ PreparationFailure(c) \/ Submit(c) \/ Surface(c)
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in [Calls -> {"start", "prepared", "submitted", "done"}]
          /\ key \in [Calls -> 0..3] /\ submitted \in [Calls -> 0..3]
          /\ surfaced \in [Calls -> 0..3] /\ requests \in [Calls -> 0..2]
\* Both successful results and sanitized failures expose this logical call's key.
KeyRetained == \A c \in Calls: phase[c] = "done" => surfaced[c] = key[c]
\* Preparation and transport never cause an implicit second send attempt.
NoImplicitRetry == \A c \in Calls: requests[c] <= 1
\* A submitted key is exactly the key selected before preparation or networking.
RequestKeyBound == \A c \in Calls: requests[c] > 0 => submitted[c] = key[c]
\* Two omitted calls differ; two intentionally provided equal keys stay equal.
SelectionPolicy == \A c \in Calls: phase[c] # "start" => key[c] = IF Provided THEN 0 ELSE c
=============================================================================
