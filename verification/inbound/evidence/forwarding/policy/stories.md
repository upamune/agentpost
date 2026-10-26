## 1. Mail forwarded to an unapproved mailbox

Rule broken: Mail can leave this model only for an operator-allowed external destination.
In the model, one step leads into this bug: "Start the native forwarding call". The steps below are the shortest path that TLC found.

0. Start: SMTP delivery arrived; original not retained
1. Operator changes the default. Now: SMTP delivery arrived; original not retained
   (1 hidden step: Capture the admission setting)
2. Retain original and its admission decision. Now: Awaiting forwarding index; original destination = unapproved mailbox; 0 claims; 0 native calls
3. Index the retained decision. Now: Waiting for native claim; original destination = unapproved mailbox; 0 claims; 0 native calls
   (1 hidden step: Read and validate pending destination)
4. Atomically claim native forwarding. Now: Claimed; outcome pending; original destination = unapproved mailbox; 1 claims; 0 native calls
5. Start the native forwarding call. Now: Mail forwarded to an unapproved mailbox

With the fix, step 3 (Index the retained decision) takes you to: Forwarding blocked; original destination = unapproved mailbox; 0 claims; 0 native calls.
