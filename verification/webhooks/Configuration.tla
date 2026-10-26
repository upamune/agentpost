--------------------------- MODULE Configuration ---------------------------
EXTENDS Naturals
CONSTANT UnsafeVersion
VARIABLES version, enabled, pending, completed, regressed
vars == <<version, enabled, pending, completed, regressed>>

\* Two coordinator incarnations allocate distinct monotonic SQLite fence
\* versions. Their awaited D1 writes may commit in either order. Version 1
\* installs a destination; version 2 deletes it using a retained tombstone.
\* The real-code replay covers the allocation/handoff, not this small projection.
Init == /\ version = 0 /\ enabled = FALSE /\ pending = {1, 2}
        /\ completed = {} /\ regressed = FALSE
Apply(n) ==
  /\ n \in pending \* src/webhook-store.ts:60 (program location / finite-run bound)
  /\ LET accepted == version < n \/ UnsafeVersion \* src/webhook-store.ts:60 (program location / finite-run bound)
     IN /\ version' = IF accepted THEN n ELSE version
        /\ enabled' = IF accepted THEN n = 1 ELSE enabled
        /\ regressed' = (regressed \/ (accepted /\ version > n))
  /\ pending' = pending \ {n} /\ completed' = completed \cup {n}
Next == \E n \in {1, 2}: Apply(n)
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in 0..2 /\ enabled \in BOOLEAN
          /\ pending \subseteq {1, 2} /\ completed \subseteq {1, 2}
          /\ regressed \in BOOLEAN
\* A late configuration write cannot resurrect a completed deletion.
NoStaleConfiguration == ~regressed /\ (2 \in completed => ~enabled /\ version = 2)
=============================================================================
