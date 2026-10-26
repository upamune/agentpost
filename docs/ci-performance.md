# CI performance

[English](ci-performance.md) | [日本語](ci-performance.ja.md)

CI keeps the same required check names, seven native executable targets, model bounds, safety/liveness properties, and real-code mutation assertions. Optimizations remove repeated work and run independent test processes concurrently.

## Formal checks

Each `verify:<area>:selftest` includes its complete baseline. CI invokes that command once and uploads both `result.json` and `selftest-result.json`. Running `verify:<area>` separately remains useful when investigating a baseline without running mutations.

Compatible properties share one TLC state-graph traversal. Successful grouped checks still produce a separate result for every named property. TLC stops at the first error, so a failed group reruns every property individually; an unvisited property cannot be reported as passing. Startup failures, missing completion output, missing replay cases, and runtime failures fail the check.

Outbound selftests run all ten original real-code replays once; inbound runs eight. The two additional outbound replays cover delayed disable projections and dispatch authorization across actor handoff. Every source mutation then runs in a fresh test process. Outbound mutants select only their designated replay files and retain a separate isolate per file. The selected population must match the corresponding original tests, and every designated case must trigger an assertion failure. No successful verification result is cached.

The original and grouped baseline traversals explored identical graphs before adding webhook behavior:

| Model    | Distinct states | Generated states | Maximum depth |
| -------- | --------------: | ---------------: | ------------: |
| Outbound |         130,184 |          389,783 |            71 |
| Inbound  |           3,104 |           10,877 |            28 |

These are bounded model checks, not a whole-program proof. See [formal verification](formal-verification.md) for assumptions, bounds, source mappings, and limitations.

## Tests and tool setup

`mise run test` runs the Worker and Bun suites in independent processes concurrently. Every existing test file remains registered, including the automatically generated idempotency-key regressions. `bun run test` runs the same suites sequentially for environments that do not use mise.

Each CI job installs only its required tools. PR executable builds and npm compatibility checks cache pinned tool downloads; release executable builds and publishing keep their existing uncached setup. Dependency installation still uses the frozen lockfile. Executable reproducibility, platform smoke tests, signatures, attestations, dependency/security checks, and release validation remain enabled.

## Measuring changes

Use an unchanged model and bounds for before/after comparisons. Record local command times separately from GitHub runner queueing and setup time. For example:

```sh
/usr/bin/time -p mise run verify:outbound:selftest
/usr/bin/time -p mise run verify:inbound:selftest
/usr/bin/time -p mise run verify:attachments:selftest
/usr/bin/time -p mise run test
```

Before tuning, the observed GitHub Actions jobs took 193 seconds for outbound formal checks, 72 seconds for inbound, 45 seconds for attachments, and 83 seconds for tests. Those historical job totals are a baseline, not a guarantee of future runner performance.

Local measurements on 2026-10-26 used the same bounds, one run per command, and no cached verification results. The old pipeline ran baseline and selftest separately; the new selftest includes both:

| Formal area | Previous baseline + selftest | Integrated selftest | Reduction |
| ----------- | ---------------------------: | ------------------: | --------: |
| Outbound    |                      89.41 s |             24.83 s |       72% |
| Inbound     |                      27.84 s |             13.25 s |       52% |
| Attachments |                      20.67 s |             18.06 s |       13% |

These timings describe the existing models before the webhook model was added. CI runner speed and later source/model changes can affect the totals.
