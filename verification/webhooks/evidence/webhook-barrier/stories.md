## 1. An obsolete or replaced worker started the webhook request

Rule broken: Neither a delayed old projection nor a new owner can invalidate a dispatched snapshot.
In the model, one step leads into this bug: "Fence current ownership and start the captured request synchronously". The steps below are the shortest path that TLC found.

0. Start: idle; inbox enabled; original webhook; worker 1; config update 0; inbox update 0; no old change in flight
1. Old worker starts an awaited webhook change or inbox disable. Now: idle; inbox enabled; original webhook; worker 1; config update 0; inbox update 0; old change still in flight
2. A replacement worker takes ownership. Now: idle; inbox enabled; original webhook; worker 2; config update 0; inbox update 0; old change still in flight
3. Read and sign the captured original webhook. Now: prepared; inbox enabled; original webhook; worker 2; config update 0; inbox update 0; old change still in flight
4. Reserve an ownership sequence for the dispatch barrier. Now: verified; inbox enabled; original webhook; worker 2; config update 0; inbox update 0; old change still in flight
5. The old configuration or inbox write finally reaches D1. Now: verified; inbox disabled; original webhook; worker 2; config update 0; inbox update 1; no old change in flight
6. Fence current ownership and start the captured request synchronously. Now: An obsolete or replaced worker started the webhook request

In Guarded implementation, step 4 (Reserve an ownership sequence for the dispatch barrier) takes you to: barrier; inbox enabled; original webhook; worker 2; config update 0; inbox update 0; old change still in flight.
