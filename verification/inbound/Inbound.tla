------------------------------ MODULE Inbound ------------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS MaxFaults, UnsafePoison, UnsafeDelete, UnsafeReady, UnsafeAttention
Keys == {0, 1, 2}
Good == {1, 2} \* Valid MIME within parser and 16 MiB parsed JSON limits (src/inbound.ts:117-137).
VARIABLES raw, indexed, parsed, ready, queued, attention, cursor, phase, faults, poisonPassed
vars == <<raw, indexed, parsed, ready, queued, attention, cursor, phase, faults, poisonPassed>>

\* Start after successful R2 puts: one poisoned original and two valid originals.
\* D1 indexing/queue publication may already have failed or the handler stopped.
Init == /\ raw = Keys /\ indexed = {} /\ parsed = {} /\ ready = {} /\ queued = {}
        /\ attention = {} /\ cursor = 0 /\ phase = "list" /\ faults = MaxFaults
        /\ poisonPassed = FALSE

ReadPage ==
  /\ phase = "list" \* src/inbound.ts repairRawIndex: R2 list of one object/page in this bound
  /\ phase' = "index"
  /\ UNCHANGED <<raw, indexed, parsed, ready, queued, attention, cursor, faults, poisonPassed>>

IndexGood(k) ==
  /\ phase = "index" /\ cursor = k /\ k \in Good
  /\ indexed' = indexed \cup {k} \* indexRaw: INSERT OR IGNORE, never replace ready state
  /\ phase' = "clear"
  /\ UNCHANGED <<raw, parsed, ready, queued, attention, cursor, faults, poisonPassed>>

ClearAttention(k) ==
  /\ phase = "clear" /\ cursor = k /\ k \in Good \* src/inbound.ts:169-171; separate D1 DELETE after index commit
  /\ attention' = attention \ {k} /\ phase' = "advance"
  /\ UNCHANGED <<raw, indexed, parsed, ready, queued, cursor, faults, poisonPassed>>

IndexPoison ==
  /\ phase = "index" /\ cursor = 0 /\ ~UnsafePoison
  /\ attention' = IF UnsafeAttention THEN attention ELSE attention \cup {0} \* repairRawIndex: persist failure before advancing
  /\ phase' = "advance"
  /\ UNCHANGED <<raw, indexed, parsed, ready, queued, cursor, faults, poisonPassed>>

IndexFault ==
  /\ phase \in {"index", "clear"} /\ faults > 0
  /\ faults' = faults - 1 /\ attention' = attention \cup {cursor}
  /\ phase' = "advance" \* transient per-object failure is recorded and retried next cycle
  /\ UNCHANGED <<raw, indexed, parsed, ready, queued, cursor, poisonPassed>>

AttentionFault ==
  /\ phase \in {"index", "clear"} /\ faults > 0 \* src/inbound.ts:176-180; attention write fails before cursor commit
  /\ phase' = "list" /\ faults' = faults - 1
  /\ UNCHANGED <<raw, indexed, parsed, ready, queued, attention, cursor, poisonPassed>>

CursorFault ==
  /\ phase = "advance" /\ faults > 0
  /\ faults' = faults - 1 /\ phase' = "list" \* cursor write fails: same page repeats safely
  /\ UNCHANGED <<raw, indexed, parsed, ready, queued, attention, cursor, poisonPassed>>

Advance ==
  /\ phase = "advance"
  /\ cursor' = (cursor + 1) % 3 \* repairRawIndex cursor commit, reset at end of listing
  /\ poisonPassed' = (poisonPassed \/ cursor = 0)
  /\ phase' = "list"
  /\ UNCHANGED <<raw, indexed, parsed, ready, queued, attention, faults>>

Republish(k) ==
  /\ k \in indexed \ ready /\ k \notin queued
  /\ queued' = queued \cup {k} \* maintenance republishInbound, queue publish succeeds eventually
  /\ UNCHANGED <<raw, indexed, parsed, ready, attention, cursor, phase, faults, poisonPassed>>

StoreParsed(k) ==
  /\ k \in queued /\ k \notin parsed
  /\ parsed' = parsed \cup {k} \* src/inbound.ts:137-144: bounded JSON succeeds; await parsed put before ready UPDATE
  /\ UNCHANGED <<raw, indexed, ready, queued, attention, cursor, phase, faults, poisonPassed>>

CommitReady(k) ==
  /\ k \in queued /\ k \notin ready /\ (k \in parsed \/ UnsafeReady)
  /\ ready' = ready \cup {k}
  /\ UNCHANGED <<raw, indexed, parsed, queued, attention, cursor, phase, faults, poisonPassed>>

Ack(k) ==
  /\ k \in ready /\ k \in queued \* src/index.ts:41: ack after the ready commit, duplicates may repeat this path
  /\ queued' = queued \ {k}
  /\ UNCHANGED <<raw, indexed, parsed, ready, attention, cursor, phase, faults, poisonPassed>>

JobFault(k) ==
  /\ k \in queued /\ faults > 0 \* worker crash, failed parsed write or failed D1 ready write
  /\ queued' = queued \ {k} /\ faults' = faults - 1
  /\ UNCHANGED <<raw, indexed, parsed, ready, attention, cursor, phase, poisonPassed>>

DeleteOriginal(k) ==
  /\ UnsafeDelete /\ k \in raw /\ k \in parsed
  /\ raw' = raw \ {k}
  /\ UNCHANGED <<indexed, parsed, ready, queued, attention, cursor, phase, faults, poisonPassed>>

Next == ReadPage \/ IndexPoison \/ IndexFault \/ AttentionFault \/ CursorFault \/ Advance
        \/ \E k \in Good: IndexGood(k) \/ ClearAttention(k) \/ Republish(k) \/ StoreParsed(k) \/ CommitReady(k) \/ Ack(k) \/ JobFault(k) \/ DeleteOriginal(k)
Fairness == /\ WF_vars(ReadPage) /\ WF_vars(IndexPoison) /\ WF_vars(Advance)
            /\ \A k \in Good: WF_vars(IndexGood(k)) /\ WF_vars(ClearAttention(k)) /\ WF_vars(Republish(k)) /\ WF_vars(StoreParsed(k)) /\ WF_vars(CommitReady(k))
Spec == Init /\ [][Next]_vars /\ Fairness
TypeOK == /\ raw \subseteq Keys /\ indexed \subseteq Good /\ parsed \subseteq Good
          /\ ready \subseteq Good /\ queued \subseteq Good /\ attention \subseteq Keys
          /\ cursor \in 0..2 /\ phase \in {"list", "index", "clear", "advance"}
          /\ faults \in 0..MaxFaults /\ poisonPassed \in BOOLEAN
\* Every original already persisted to R2 remains available through recovery.
OriginalRetained == raw = Keys
\* D1 never indexes mail whose original has not been persisted.
IndexHasOriginal == indexed \subseteq raw
\* A ready row is committed only after its parsed object is durable.
ReadyHasParsed == ready \subseteq parsed
\* Moving past poisoned metadata must leave durable operational attention.
PoisonVisible == ~poisonPassed \/ 0 \in attention
\* With finitely many faults and fair successful recovery, poison cannot starve good mail.
EventuallyReady == <> (ready = Good)
=============================================================================
