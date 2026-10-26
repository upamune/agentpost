# Security and reliability review — 2026-10-26

[English](security-review-2026-10-26.md) | [日本語](security-review-2026-10-26.ja.md)

Baseline: `2332da0d25be512b4e132fb26b8af2f10fefecb0`. Three parallel source reviews covered authentication/API isolation, inbound/outbound recovery, and CLI/MCP/distribution boundaries. The parent reproduced and reviewed the fixes. All probes used synthetic data and local runtimes; no real email or production policy change was part of the audit.

## Findings and changes

| Finding                                  | Demonstrated impact                                                                                                                                                                              | Change                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health misses stalled sends              | An hour-old `sending` row returned HTTP 200 because only pending age and terminal failures contributed attention.                                                                                | Include the oldest `sending.updated_at` in the existing 15-minute health threshold and expose `oldest_sending`. Fresh claims remain healthy; health never mutates or resends a request.                                                                                           |
| Local input reads lack bounds            | CLI text/HTML and saved cursors used unbounded reads. A 524,289-byte text file produced a request above the API limit; devices/FIFOs could consume resources or block before contacting the API. | Read only regular files through one open handle, with nonblocking open, size checks and a limit-plus-one read bound. Preserve regular-file symlinks and Unicode. Bound each mail file at 512 KiB and the complete serialized request at 512 KiB, including JSON escaping.         |
| Checkpoint parsing exposes local content | A corrupt checkpoint's JSON parser could include its content in stderr. The saved cursor also lacked the API's length bound.                                                                     | Limit checkpoint files to 16 KiB and cursors to 2048 characters, return a generic parse error, and preserve the rejected file instead of resetting the subscription.                                                                                                              |
| CI stores unnecessary executables        | The repository held 112 executable artifacts totaling about 5.5 GB at review time. Every PR/main run uploaded the same seven-platform build outputs.                                             | Continue all native build/smoke checks; upload executables only when release assembly explicitly requests them. Release previews keep the same assembly path. Select the exact npm archive version rather than a glob. Existing evidence and immutable releases remain available. |

These are reliability and local resource-boundary findings. No remote authentication bypass or demonstrated mailbox disclosure was found. The file issues require a client invocation that selects problematic local input; they are not a demonstrated remote mail-sender exploit.

## Validation and scope

Regression coverage exercises fresh/stale sending timestamps without modifying outcomes; oversized/sparse and special-file inputs; UTF-8/JSON escape expansion before fetch; invalid checkpoints; and valid Unicode/file workflows. The standard CI also checks bounded outbound/inbound models, real-code replays and deliberately broken variants. These fixes do not change the modeled dispatch, ownership, recovery or persistence transitions.

The finalized MCP core remains 2026-07-28, checked separately from the pinned Events draft. The audit did not change either wire contract.

GitHub's open-alert state at the baseline contained no CodeQL finding and four Scorecard practice findings: independent code review, branch-review requirements, repository maintenance history, and OpenSSF Best Practices enrollment. Their [remaining prerequisites](scorecard-remediation.md) remain visible; agent reviews do not count as independent human approvals.

This review does not prove whole-system absence of vulnerabilities, deployed Cloudflare policy correctness, actual mail reachability, complete parser resource bounds, or backup recovery. Follow the [deployment](deploy.md) and [operations](operations.md) checks for each self-hosted installation.
