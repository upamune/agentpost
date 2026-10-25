# Code complexity checks

[English](complexity.md) | [日本語](complexity.ja.md)

[moznion/cccc](https://github.com/moznion/cccc) measures cognitive complexity (how difficult control flow is to follow) and cyclomatic complexity (independent control-flow paths). Agentpost pins version 1.8.4 and platform-specific release checksums in `mise.toml`. Mise also verifies available GitHub artifact attestations. These are maintainability signals, not vulnerability detection or proof of correctness.

## Run locally

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise run complexity
# Full native cccc JSON, without the policy gate:
mise run complexity:report
# Complexity plus the regular checks and formal verification:
mise run ci
```

The gate scans `src/`, `scripts/`, and `verification/` using the explicit `cccc.toml`. It includes the complexity checker itself and formal-check tooling. TypeScript test fixtures (`*.test.ts`, `*.bun.ts`, `*.fuzz.ts`) are excluded; their large synthetic cases are tested separately. Other directories, private operator files, dependencies, build output, and unsupported extensions are outside this scope. Caching and top-N/minimum filtering are disabled for the gate.

## Limits and eliminated debt

`complexity-baseline.json` sets limits of **8 cognitive / 6 cyclomatic per function identity**, including nested functions. There are **no exceptions**. The original 15/10 policy recorded 28 existing exceptions at product revision `59dfd626440963a76ac72edf6075975f9caa722c`, with CLI `main` at 90/56. The first refactor eliminated those exceptions and lowered limits to 12/8. A second pass refactored all 44 functions above 8/6. The current maximum is 8/6, and the cognitive 95th percentile is 5. No source directory was excluded to achieve these reductions.

CLI commands, DNS diagnostics, subscription state, bounded JSON sizing, and mail/authentication guards now have smaller operations with explicit responsibilities. Regression tests cover command requests, TXT decoding and MCP error mapping; send/receive formal models and real-code mutation replays check the preserved state transitions. Queue-handler regressions also check mixed-success batches, bounded retry delays, and duplicate acknowledgements/events.

An identity combines the normalized file path, enclosing function chain, kind, name, and occurrence among same-named sibling functions. Line-number-only movement preserves it. Anonymous functions and same-named methods have structural identities, not semantic or cryptographic identities: insertion, reordering, renaming, or moving functions needs careful diff review to avoid assigning an old allowance to different code. Metrics cannot replace that review.

- New identities use the default limits; they do not inherit a file-wide maximum.
- When an exception's measured complexity falls, reduce its stored values. If both metrics meet the defaults, remove the exception instead.
- Removing or renaming a function leaves a stale entry and fails until the baseline is reviewed and corrected.
- A necessary new exception or analyzer update requires an explicit reviewed change explaining the affected control flow and compatibility. There is no automatic baseline-update command in CI. Do not copy current output over the baseline to hide regressions.

## CI results and failures

The `complexity` check runs on PRs and main and is required by the upstream main ruleset. Release validation also runs it through `mise run ci`. Fork maintainers configure their own required checks.

A completed measurement writes `.complexity/report.json` with the full native report and policy failures. GitHub retains it as `code-complexity` for 14 days. This ignored output never enters source releases. `complexity:report` is an inspection command and does not enforce the baseline.

The gate returns 0 for a pass, 1 for policy violations, and 2 for tool/config/report failures. A version mismatch, nonzero analyzer exit, invalid/empty/inconsistent report, or any parse error cannot pass. A stale report is removed before analysis. Real-tool regressions cover nested functions, separate sibling budgets, increases/reductions/removal, partial parse output, and scanner failures even when accompanied by clean-looking JSON.
