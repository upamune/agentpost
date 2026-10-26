## 1. Another native forwarding claim was authorized

Rule broken: Even a crash before the native call cannot reset an ambiguous claim.
In the model, one step leads into this bug: "Atomically claim native forwarding". The steps below are the shortest path that TLC found.

0. Start: SMTP delivery arrived; original not retained
1. Operator changes the default. Now: SMTP delivery arrived; original not retained
   (1 hidden step: Capture the admission setting)
2. Retain original and its admission decision. Now: Awaiting forwarding index; original destination = trusted mailbox; 0 claims; 0 native calls
3. Index the retained decision. Now: Waiting for native claim; original destination = trusted mailbox; 0 claims; 0 native calls
   (5 hidden steps: Read and validate pending destination, Capture the admission setting, Retain original and its admission decision, Index the retained decision)
4. Atomically claim native forwarding. Now: Claimed; outcome pending; original destination = trusted mailbox; 1 claims; 0 native calls
5. Atomically claim native forwarding. Now: Another native forwarding claim was authorized

With the fix, step 5 (Atomically claim native forwarding) cannot happen, so you stay at: Claimed; outcome pending; original destination = trusted mailbox; 1 claims; 0 native calls.
