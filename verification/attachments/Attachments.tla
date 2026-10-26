--------------------------- MODULE Attachments ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Scenario, UnsafePut, UnsafeIsolation, UnsafeIdempotency,
          UnsafeIntegrity, UnsafeAvailability, UnsafeSnapshot
VARIABLES objects, uploadPC, overwrites, requestPC, observed, accepted,
          queued, readObject, prepared, sendPC, dispatched, faulted
vars == <<objects, uploadPC, overwrites, requestPC, observed, accepted,
          queued, readObject, prepared, sendPC, dispatched, faulted>>

Inboxes == {"mine", "other"}
Files == {"report", "image"}
Slots == Inboxes \X Files
Actors == {1, 2}
None == "absent"
Corrupt == "corrupt"
Unavailable == "unavailable"
ObjectValues == Files \cup {None, Corrupt, Unavailable}
Target == <<"mine", "report">>
Offered(a) == IF a = 1 THEN "report" ELSE "image"
Source(a) == IF Scenario = "isolation" /\ a = 2 THEN "other" ELSE "mine"

\* Collision-free SHA256 and canonical metadata abstract to (inbox,file).
\* A file represents immutable bytes plus filename/type/size; two distinct
\* files cannot have the same identity. Parsing/size/format arithmetic are
\* exercised against TypeScript separately; no cryptographic proof is claimed.
Init ==
  /\ objects = [s \in Slots |-> IF Scenario = "upload" THEN None ELSE s[2]]
  /\ uploadPC = [a \in Actors |-> "head"]
  /\ overwrites = 0
  /\ requestPC = [a \in Actors |-> "lookup"]
  /\ observed = [a \in Actors |-> None]
  /\ accepted = {}
  /\ queued = IF Scenario = "prepare" THEN "report" ELSE None
  /\ readObject = None /\ prepared = None /\ sendPC = "get"
  /\ dispatched = {} /\ faulted = FALSE

\* src/attachments.ts:61-65 uploadAttachment: HEAD is an awaited observation, not
\* a lock. Both upload requests can observe the same missing object.
UploadHead(a) ==
  /\ Scenario = "upload" /\ uploadPC[a] = "head"
  /\ uploadPC' = [uploadPC EXCEPT ![a] = IF objects[Target] = None THEN "put" ELSE "done"]
  /\ UNCHANGED <<objects, overwrites, requestPC, observed, accepted,
                  queued, readObject, prepared, sendPC, dispatched, faulted>>

\* src/attachments.ts:67-72 uploadAttachment: R2 conditional put is atomic. An
\* unsuccessful conditional put leaves the existing immutable object intact.
UploadPut(a) ==
  /\ Scenario = "upload" /\ uploadPC[a] = "put"
  /\ objects' = IF objects[Target] = None \/ UnsafePut
                 THEN [objects EXCEPT ![Target] = "report"] ELSE objects
  /\ overwrites' = IF objects[Target] # None /\ UnsafePut THEN overwrites + 1 ELSE overwrites
  /\ uploadPC' = [uploadPC EXCEPT ![a] = "done"]
  /\ UNCHANGED <<requestPC, observed, accepted, queued, readObject,
                  prepared, sendPC, dispatched, faulted>>

\* src/api.ts:351-362 findOrCreateOutbox: existing row lookup and validation await
\* separately. Request 2 supplies a foreign-inbox reference; identity() and
\* the inbox-prefixed R2 key must both bind it to the authorized inbox.
Lookup(a) ==
  /\ Scenario \in {"queue", "isolation"} /\ requestPC[a] = "lookup"
  /\ observed' = [observed EXCEPT ![a] = queued]
  /\ requestPC' = [requestPC EXCEPT ![a] = IF queued = None THEN "validate" ELSE "check"]
  /\ UNCHANGED <<objects, uploadPC, overwrites, accepted, queued,
                  readObject, prepared, sendPC, dispatched, faulted>>

Validate(a) ==
  \* src/api.ts:228-235 authorizes the owner; src/attachments.ts:23-41 binds
  \* the queried object key and validated descriptor to that same inbox.
  /\ Scenario \in {"queue", "isolation"} /\ requestPC[a] = "validate"
  /\ requestPC' = [requestPC EXCEPT ![a] = IF Source(a) = "mine" \/ UnsafeIsolation
                     THEN "insert" ELSE "done"]
  /\ UNCHANGED <<objects, uploadPC, overwrites, observed, accepted, queued,
                  readObject, prepared, sendPC, dispatched, faulted>>

\* src/api.ts:363-368 INSERT OR IGNORE uses (inbox,idempotency_key) uniqueness. The subsequent
\* SELECT observes the winner; an earlier SELECT cannot reserve that key.
Insert(a) ==
  /\ Scenario \in {"queue", "isolation"} /\ requestPC[a] = "insert"
  /\ queued' = IF queued = None THEN Offered(a) ELSE queued
  /\ requestPC' = [requestPC EXCEPT ![a] = "reread"]
  /\ UNCHANGED <<objects, uploadPC, overwrites, observed, accepted,
                  readObject, prepared, sendPC, dispatched, faulted>>
Reread(a) ==
  /\ Scenario \in {"queue", "isolation"} /\ requestPC[a] = "reread"
  /\ observed' = [observed EXCEPT ![a] = queued]
  /\ requestPC' = [requestPC EXCEPT ![a] = "check"]
  /\ UNCHANGED <<objects, uploadPC, overwrites, accepted, queued,
                  readObject, prepared, sendPC, dispatched, faulted>>
Check(a) ==
  \* src/api.ts:388-389 rejects a changed attachment ID under an existing key.
  /\ Scenario \in {"queue", "isolation"} /\ requestPC[a] = "check"
  /\ accepted' = IF observed[a] = Offered(a) \/ UnsafeIdempotency
                   THEN accepted \cup {<<Source(a), Offered(a), observed[a]>>} ELSE accepted
  /\ requestPC' = [requestPC EXCEPT ![a] = "done"]
  /\ UNCHANGED <<objects, uploadPC, overwrites, observed, queued,
                  readObject, prepared, sendPC, dispatched, faulted>>

\* src/attachments.ts:97-101 providerAttachment: R2 GET captures one object's
\* metadata/body snapshot. Object replacement after GET cannot change it.
Read ==
  /\ Scenario = "prepare" /\ sendPC = "get"
  /\ readObject' = objects[Target] /\ sendPC' = "verify"
  /\ UNCHANGED <<objects, uploadPC, overwrites, requestPC, observed, accepted,
                  queued, prepared, dispatched, faulted>>
\* Raw storage faults can occur before/after any await. Only one fault per
\* finite run; each fault may delete, make inaccessible, corrupt, or replace
\* bytes with another file. Upload APIs themselves never perform these writes.
StorageFault(value) ==
  /\ Scenario = "prepare" /\ ~faulted
  /\ value \in {None, Corrupt, "image", Unavailable}
  /\ objects' = [objects EXCEPT ![Target] = value] /\ faulted' = TRUE
  /\ UNCHANGED <<uploadPC, overwrites, requestPC, observed, accepted,
                  queued, readObject, prepared, sendPC, dispatched>>
Verify ==
  \* src/attachments.ts:99-104 validates presence, metadata, size and digest.
  /\ Scenario = "prepare" /\ sendPC = "verify"
  /\ LET available == readObject \notin {None, Unavailable} \/ UnsafeAvailability
         integrity == readObject = queued \/ UnsafeIntegrity
     IN /\ prepared' = IF available /\ integrity THEN readObject ELSE None
        /\ sendPC' = IF available /\ integrity THEN "ready" ELSE "blocked"
  /\ UNCHANGED <<objects, uploadPC, overwrites, requestPC, observed,
                  accepted, queued, readObject, dispatched, faulted>>
\* src/outbound.ts:156-177 dispatchPrepared: provider receives the already verified
\* in-memory payload; it does not fetch live R2 bytes after the fence.
Dispatch ==
  /\ Scenario = "prepare" /\ sendPC = "ready"
  /\ dispatched' = dispatched \cup {IF UnsafeSnapshot THEN objects[Target] ELSE prepared}
  /\ sendPC' = "done"
  /\ UNCHANGED <<objects, uploadPC, overwrites, requestPC, observed,
                  accepted, queued, readObject, prepared, faulted>>

Next == (\E a \in Actors: UploadHead(a) \/ UploadPut(a) \/ Lookup(a) \/
          Validate(a) \/ Insert(a) \/ Reread(a) \/ Check(a))
        \/ Read \/ Verify \/ Dispatch \/ (\E value \in ObjectValues: StorageFault(value))
Spec == Init /\ [][Next]_vars

TypeOK == /\ objects \in [Slots -> ObjectValues]
          /\ uploadPC \in [Actors -> {"head", "put", "done"}]
          /\ overwrites \in 0..2
          /\ requestPC \in [Actors -> {"lookup", "validate", "insert", "reread", "check", "done"}]
          /\ observed \in [Actors -> Files \cup {None}]
          /\ accepted \subseteq Inboxes \X Files \X (Files \cup {None})
          /\ queued \in Files \cup {None}
          /\ readObject \in ObjectValues /\ prepared \in ObjectValues
          /\ sendPC \in {"get", "verify", "ready", "blocked", "done"}
          /\ dispatched \subseteq ObjectValues /\ faulted \in BOOLEAN
\* Concurrent retries cannot rewrite even an identical uploaded object.
ImmutableUploads == overwrites = 0
\* A reference from another inbox is never accepted by this inbox.
InboxIsolation == \A item \in accepted: item[1] = "mine"
\* An accepted retry always describes the original row, never new bytes.
IdempotencyStable == \A item \in accepted: item[2] = item[3]
\* Missing/inaccessible objects never become a provider request.
AvailableBeforeDispatch == dispatched \cap {None, Unavailable} = {}
\* Corrupt/substituted bytes cannot reach the provider under the queued ID.
IntegrityBeforeDispatch == dispatched \subseteq {"report"}
\* R2 mutation during preparation cannot change already prepared bytes.
PreparedSnapshotBound == \A bytes \in dispatched: bytes = prepared /\ bytes = queued
=============================================================================
