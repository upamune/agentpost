## 1. Retained and indexed destinations disagree

Rule broken: A duplicate SMTP handler cannot overwrite the retained admission decision.
In the model, one step leads into this bug: "Retain original and its admission decision". The steps below are the shortest path that TLC found.

0. Start: SMTP delivery arrived; original not retained
   (1 hidden step: Capture the admission setting)
1. Operator changes the default. Now: SMTP delivery arrived; original not retained
2. Retain original and its admission decision. Now: Awaiting forwarding index; original destination = off; 0 claims; 0 native calls
3. Index the retained decision. Now: Forwarding was off; original destination = off; 0 claims; 0 native calls
   (1 hidden step: Capture the admission setting)
4. Retain original and its admission decision. Now: Retained and indexed destinations disagree

With the fix, step 4 (Retain original and its admission decision) keeps you at: Forwarding was off; original destination = off; 0 claims; 0 native calls.
