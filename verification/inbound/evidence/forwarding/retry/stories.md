## 1. Another native forwarding claim was authorized

Rule broken: Even a crash before the native call cannot reset an ambiguous claim.
In the model, one step leads into this bug: "Atomically claim native forwarding". The steps below are the shortest path that TLC found.

0. Start: SMTP delivery arrived; original not retained
1. Operator changes the default. Now: SMTP delivery arrived; original not retained
   (1 hidden step: Capture the admission setting)
2. Retain original and its admission decision. Now: Awaiting forwarding index; original destination = trusted mailbox; 0 claims; 0 native calls
3. Index the retained decision. Now: Waiting for native claim; original destination = trusted mailbox; 0 claims; 0 native calls
   (1 hidden step: Read and validate pending destination)
4. Atomically claim native forwarding. Now: Claimed; outcome pending; original destination = trusted mailbox; 1 claims; 0 native calls
5. Record interrupted work for operator attention. Now: Waiting for native claim; original destination = trusted mailbox; 1 claims; 0 native calls
   (4 hidden steps: Capture the admission setting, Retain original and its admission decision, Index the retained decision, Read and validate pending destination)
6. Atomically claim native forwarding. Now: Another native forwarding claim was authorized

With the fix, step 5 (Record interrupted work for operator attention) takes you to: Outcome unknown; no automatic retry; original destination = trusted mailbox; 1 claims; 0 native calls.
