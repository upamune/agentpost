## 1. Inbox enabled; stored update 1; old enable finished; new disable completed

Rule broken: An old enable already in flight cannot undo a newer completed disable.
In the model, one step leads into this bug: "Old enable arrives late".

0. Start: Inbox enabled; stored update 0; old enable still in flight; new disable in flight
1. New disable commits. Now: Inbox disabled; stored update 2; old enable still in flight; new disable completed
2. Old enable arrives late. Now: Inbox enabled; stored update 1; old enable finished; new disable completed

With the fix, step 2 (Old enable arrives late) takes you to: Inbox disabled; stored update 2; old enable finished; new disable completed.
