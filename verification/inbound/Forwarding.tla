----------------------------- MODULE Forwarding -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS UnsafeSnapshot, UnsafeClaim, UnsafeRetry, UnsafePolicy
Handlers == {1, 2}
Targets == {"off", "allowed", "forbidden"}
Phases == {"new", "admitted", "stored", "indexed", "prepared", "claimed", "called", "done"}
VARIABLES config, selected, raw, saved, status, phase, claims, calls, callTargets
vars == <<config, selected, raw, saved, status, phase, claims, calls, callTargets>>

Init == /\ config = "off" /\ selected = [h \in Handlers |-> "off"]
        /\ raw = "unset" /\ saved = "unset" /\ status = "none"
        /\ phase = [h \in Handlers |-> "new"] /\ claims = 0 /\ calls = 0 /\ callTargets = {}

\* src/forwarding-store.ts forwardingAdmission: one D1 snapshot per SMTP admission.
\* src/forwarding-store.ts:25; program counter/counter bounds abstract this operation.
Configure == /\ \E target \in Targets: config' = target
             /\ UNCHANGED <<selected, raw, saved, status, phase, claims, calls, callTargets>>
\* src/forwarding-store.ts:8; program counter/counter bounds abstract this operation.
Admit(h) == /\ phase[h] = "new" /\ selected' = [selected EXCEPT ![h] = config]
            /\ phase' = [phase EXCEPT ![h] = "admitted"]
            /\ UNCHANGED <<config, raw, saved, status, claims, calls, callTargets>>

\* src/inbound.ts receive: conditional R2 put freezes the winning admission metadata.
\* src/inbound.ts:46; program counter/counter bounds abstract this operation.
Store(h) == /\ phase[h] = "admitted"
            /\ raw' = IF raw = "unset" \/ UnsafeSnapshot THEN selected[h] ELSE raw
            /\ phase' = [phase EXCEPT ![h] = "stored"]
            /\ UNCHANGED <<config, selected, saved, status, claims, calls, callTargets>>

\* src/forwarding-store.ts indexForwarding: INSERT OR IGNORE from retained metadata.
\* src/forwarding-store.ts:72; program counter/counter bounds abstract this operation.
Index(h) == /\ phase[h] = "stored" /\ raw # "unset" \* src/inbound.ts:96; rawMetadata must exist before indexing.
            /\ saved' = IF status = "none" THEN raw ELSE saved
            /\ status' = IF status # "none" THEN status ELSE
                  IF raw = "off" THEN "skipped" ELSE
                  IF raw = "forbidden" /\ ~UnsafePolicy THEN "blocked" ELSE "pending"
            /\ phase' = [phase EXCEPT ![h] = "indexed"]
            /\ UNCHANGED <<config, selected, raw, claims, calls, callTargets>>

\* src/forwarding.ts pendingTarget: read and validate before a separate atomic claim.
\* src/forwarding.ts:14; program counter/counter bounds abstract this operation.
ReadPending(h) == /\ phase[h] = "indexed" /\ status = "pending" \* src/forwarding.ts:18
                  /\ (saved = "allowed" \/ UnsafePolicy) \* src/forwarding.ts:26
                  /\ phase' = [phase EXCEPT ![h] = "prepared"]
                  /\ UNCHANGED <<config, selected, raw, saved, status, claims, calls, callTargets>>
\* src/forwarding.ts forwardReceived: conditional pending -> sending, never reset.
\* src/forwarding.ts:42; program counter/counter bounds abstract this operation.
Claim(h) == /\ phase[h] = "prepared" /\ (status = "pending" \/ UnsafeClaim) /\ claims < 2
            /\ claims' = claims + 1 /\ status' = "sending"
            /\ phase' = [phase EXCEPT ![h] = "claimed"]
            /\ UNCHANGED <<config, selected, raw, saved, calls, callTargets>>
\* src/forwarding.ts message.forward: native provider invocation, not delivery.
\* src/forwarding.ts:56; program counter/counter bounds abstract this operation.
Call(h) == /\ phase[h] = "claimed" /\ calls < 2
           /\ calls' = calls + 1 /\ callTargets' = callTargets \cup {saved}
           /\ phase' = [phase EXCEPT ![h] = "called"]
           /\ UNCHANGED <<config, selected, raw, saved, status, claims>>
\* src/forwarding.ts settlement cannot replace a recovered unknown outcome.
\* src/forwarding.ts:62; program counter/counter bounds abstract this operation.
Complete(h) == /\ phase[h] = "called"
               /\ status' \in IF status = "sending" THEN {"accepted", "unknown"} ELSE {status}
               /\ phase' = [phase EXCEPT ![h] = "done"]
               /\ UNCHANGED <<config, selected, raw, saved, claims, calls, callTargets>>
\* Process interruption may happen at any await, before or after provider initiation.
\* src/inbound.ts:64; program counter/counter bounds abstract this operation.
Crash(h) == /\ phase[h] \notin {"new", "done"}
            /\ phase' = [phase EXCEPT ![h] = "done"]
            /\ UNCHANGED <<config, selected, raw, saved, status, claims, calls, callTargets>>
\* src/forwarding.ts recoverForwarding: ambiguity never becomes pending work again.
\* src/forwarding.ts:70; program counter/counter bounds abstract this operation.
Recover == /\ status \in {"pending", "sending", "unknown"}
           /\ status' = IF UnsafeRetry THEN "pending" ELSE
                         IF status = "pending" THEN "blocked" ELSE "unknown"
           /\ UNCHANGED <<config, selected, raw, saved, phase, claims, calls, callTargets>>
Next == Configure \/ Recover \/ \E h \in Handlers:
  Admit(h) \/ Store(h) \/ Index(h) \/ ReadPending(h) \/ Claim(h) \/ Call(h) \/ Complete(h) \/ Crash(h)
Spec == Init /\ [][Next]_vars
TypeOK == /\ config \in Targets /\ selected \in [Handlers -> Targets]
          /\ raw \in Targets \cup {"unset"} /\ saved \in Targets \cup {"unset"}
          /\ status \in {"none", "pending", "sending", "accepted", "unknown", "blocked", "skipped"}
          /\ phase \in [Handlers -> Phases] /\ claims \in 0..2 /\ calls \in 0..2 /\ callTargets \subseteq Targets
\* A native forwarding attempt requires an original already retained by the application.
RawBeforeForward == calls = 0 \/ raw # "unset"
\* A duplicate SMTP handler cannot overwrite the retained admission decision.
SnapshotPreserved == status = "none" \/ saved = raw
\* Mail can leave this model only for an operator-allowed external destination.
TrustedDestination == callTargets \subseteq {"allowed"}
\* Concurrent duplicates never start a second native forwarding call.
AtMostOneForward == calls <= 1
\* Even a crash before the native call cannot reset an ambiguous claim.
NoBlindRetry == claims <= 1
=============================================================================
