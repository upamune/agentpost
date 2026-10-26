## 1. A disabled inbox or replaced worker started an email request

Rule broken: Neither a delayed old projection nor a new owner can invalidate a dispatched snapshot.
In the model, one step leads into this bug: "Fence current ownership and start the email provider request". The steps below are the shortest path that TLC found.

0. Start: idle; inbox enabled; worker 1; inbox update 0; no old disable in flight
1. An old worker starts an awaited inbox disable. Now: idle; inbox enabled; worker 1; inbox update 0; old disable still in flight
2. A replacement worker takes ownership. Now: idle; inbox enabled; worker 2; inbox update 0; old disable still in flight
3. Read inbox state and prepare the email provider payload. Now: prepared; inbox enabled; worker 2; inbox update 0; old disable still in flight
4. Reserve an ownership sequence for the dispatch barrier. Now: barrier; inbox enabled; worker 2; inbox update 0; old disable still in flight
5. Confirm the snapshot and reject older pending writes atomically. Now: verified; inbox enabled; worker 2; inbox update 2; old disable still in flight
6. Another replacement occurs during awaited preparation. Now: verified; inbox enabled; worker 3; inbox update 2; old disable still in flight
7. Fence current ownership and start the email provider request. Now: A disabled inbox or replaced worker started an email request

In Guarded implementation, step 7 (Fence current ownership and start the email provider request) cannot happen, so you stay at: verified; inbox enabled; worker 3; inbox update 2; old disable still in flight.
