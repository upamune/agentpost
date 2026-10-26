--------------------------- MODULE Events ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS UnsafeInbox, UnsafeIdentity
VARIABLES ready, configuration, deliveries, changed
vars == <<ready, configuration, deliveries, changed>>
Inboxes == {"mine", "other"}
Configurations == {1, 2, 3}
Owner(c) == IF c = 2 THEN "other" ELSE "mine"
Message(i) == IF i = "mine" THEN "my-message" ELSE "other-message"
Delivery(i, c) == [inbox |-> i, message |-> Message(i), captured |-> c, target |-> c]

Init == /\ ready = {} /\ configuration = [i \in Inboxes |-> IF i = "mine" THEN 1 ELSE 2]
        /\ deliveries = {} /\ changed = FALSE

\* The D1 readiness UPDATE and AFTER UPDATE trigger share one database step.
\* A second parser that already sees ready does not fire the transition trigger.
Ready(i, c) ==
  /\ i \notin ready /\ c \in Configurations \* migrations/0006_inbox_webhooks.sql:33 (program location / finite-run bound)
  /\ c = configuration[i] \/ UnsafeInbox \* migrations/0006_inbox_webhooks.sql:33 (program location / finite-run bound)
  /\ ready' = ready \cup {i}
  /\ deliveries' = deliveries \cup {Delivery(i, c)}
  /\ UNCHANGED <<configuration, changed>>

\* Replacing this inbox's webhook affects subsequent readiness transitions;
\* it cannot rewrite the identity captured by a previous transition.
Replace ==
  /\ ~changed \* src/webhook-store.ts:60 (program location / finite-run bound)
  /\ configuration' = [configuration EXCEPT !["mine"] = 3]
  /\ deliveries' = IF UnsafeIdentity
        THEN {[d EXCEPT !.target = IF d.inbox = "mine" THEN 3 ELSE d.target] : d \in deliveries}
        ELSE deliveries
  /\ changed' = TRUE
  /\ UNCHANGED ready

Next == (\E i \in Inboxes, c \in Configurations: Ready(i, c)) \/ Replace
Spec == Init /\ [][Next]_vars
TypeOK == /\ ready \subseteq Inboxes
          /\ configuration \in [Inboxes -> Configurations]
          /\ deliveries \subseteq [inbox: Inboxes, message: {"my-message", "other-message"},
                                   captured: Configurations, target: Configurations]
          /\ changed \in BOOLEAN
\* Trigger-created events contain only a message owned by the configuration's inbox.
InboxIsolation == \A d \in deliveries: d.inbox = Owner(d.captured) /\ d.message = Message(d.inbox)
\* Configuration replacement never changes a previously captured destination identity.
ImmutableEventIdentity == \A d \in deliveries: d.target = d.captured
\* Concurrent parses cannot emit two events for one readiness transition.
OneEventPerTransition == \A i \in Inboxes: Cardinality({d \in deliveries: d.inbox = i}) <= 1
=============================================================================
