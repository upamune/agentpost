# Continuous security checks

[English](security-checks.md) | [日本語](security-checks.ja.md)

[![CodeQL](https://github.com/upamune/agentpost/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/codeql.yml)
[![OSV-Scanner](https://github.com/upamune/agentpost/actions/workflows/osv.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/osv.yml)
[![Workflow security](https://github.com/upamune/agentpost/actions/workflows/zizmor.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/zizmor.yml)
[![Dependency audit](https://github.com/upamune/agentpost/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/audit.yml)
[![Dependency review](https://github.com/upamune/agentpost/actions/workflows/dependency-review.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/dependency-review.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/upamune/agentpost/badge)](https://scorecard.dev/viewer/?uri=github.com/upamune/agentpost)
[![Security fuzzing](https://github.com/upamune/agentpost/actions/workflows/fuzz.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/fuzz.yml)
[![Code complexity](https://github.com/upamune/agentpost/actions/workflows/complexity.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/complexity.yml)

Agentpost combines static analysis, dependency and secret scanning, adversarial tests, and bounded formal verification. The README badges link to current results. A passing badge means the corresponding check completed; it is not a security certification or proof of safe operator configuration.

## Automated coverage

| Check                                 | Coverage                                                                                                  | When                                               | Results                                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeQL, `security-extended`           | JavaScript/TypeScript data-flow and security queries                                                      | Main pushes, PRs, daily, manual                    | [Code scanning](https://github.com/upamune/agentpost/security/code-scanning), [workflow](https://github.com/upamune/agentpost/actions/workflows/codeql.yml)                     |
| OSV-Scanner                           | Resolved direct and transitive packages in `bun.lock`, including development dependencies                 | Main pushes, PRs, daily, manual                    | Code scanning and [workflow artifacts](https://github.com/upamune/agentpost/actions/workflows/osv.yml)                                                                          |
| Bun audit                             | Registry advisory checks against the resolved dependency tree                                             | Main pushes, PRs, daily, manual                    | [Dependency audit](https://github.com/upamune/agentpost/actions/workflows/audit.yml)                                                                                            |
| Dependency review                     | Newly introduced known vulnerabilities, including low severity                                            | PRs; manual base/head comparison                   | [Dependency review](https://github.com/upamune/agentpost/actions/workflows/dependency-review.yml)                                                                               |
| Dependabot                            | Bun and SHA-pinned GitHub Actions update PRs; advisory-driven security updates                            | Weekly version checks and new advisories           | [Dependabot alerts](https://github.com/upamune/agentpost/security/dependabot), dependency PRs                                                                                   |
| zizmor, auditor persona               | Workflow injection, dangerous triggers, permissions, credentials and Actions configuration                | Main pushes, PRs, weekly, manual; local CI offline | Code scanning and [Workflow security](https://github.com/upamune/agentpost/actions/workflows/zizmor.yml)                                                                        |
| OpenSSF Scorecard                     | Repository and software supply-chain practices                                                            | Main pushes, weekly, manual                        | [Public score](https://scorecard.dev/viewer/?uri=github.com/upamune/agentpost), code scanning, [workflow](https://github.com/upamune/agentpost/actions/workflows/scorecard.yml) |
| Gitleaks and GitHub secret protection | Reachable Git history and recognized accidentally committed credentials                                   | CI; server-side detection and push protection      | [CI](https://github.com/upamune/agentpost/actions/workflows/ci.yml), maintainer-only secret alerts                                                                              |
| Tests and TLA+                        | Adversarial boundary regressions, inbound/outbound invariants, real-code replays and mutation selftests   | Main pushes and PRs                                | CI and [formal verification](formal-verification.md)                                                                                                                            |
| cccc                                  | Cognitive/cyclomatic complexity with per-function debt caps; maintainability, not vulnerability detection | Main pushes, PRs, manual; local and release CI     | [Complexity policy](complexity.md), [workflow](https://github.com/upamune/agentpost/actions/workflows/complexity.yml)                                                           |

CodeQL, OSV, zizmor and Scorecard upload SARIF to GitHub. Security workflows have read-only repository access and only the job permissions needed to publish reports. Scorecard uses OIDC for publication. The separate source-release workflow also uses OIDC to sign provenance, with a read-only source build, an attestation job, and a publisher holding only release write access. No production mail credential is involved. Workflows do not use `pull_request_target`, install third-party GitHub Apps, or send scan comments to PRs. Action references are SHA-pinned with pinact.

A known OSV vulnerability or a reported low-or-higher zizmor finding fails its check. Dependency review blocks newly introduced advisories. CodeQL and Scorecard use GitHub's alert dashboard: a completed workflow alone does not mean their alert lists are empty. CodeQL/other code scanning alerts and repository rules must be reviewed as well. Findings must be investigated and fixed or given a narrowly documented, evidence-based disposition; do not add blanket ignores to obtain green badges.

These SARIF workflows are gated to public repositories, where the GitHub security integration is available without enabling a paid private-repository product. Private forks still have local checks, Gitleaks, Bun audit, tests and formal verification. See the official [CodeQL guidance](https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning), [OSV integration](https://google.github.io/osv-scanner/github-action/), [zizmor integration](https://docs.zizmor.sh/integrations/), and [Scorecard documentation](https://github.com/ossf/scorecard-action).

## Generative security fuzzing

[fast-check](https://github.com/dubzzz/fast-check) generates adversarial values and shrinks failures in `test/security.fuzz.ts`. Five properties exercise real JSON UTF-8 sizing (including lone surrogates), bounded streams and cancellation, bearer-token confinement, actual loopback redirects, and mailbox/header injection rejection. PRs and main run 10,000 cases per property; daily runs use 100,000. Local `mise run ci` includes the default 1,000 per property. No live service, mail recipient, or production secret is used.

Reproduce a failure using the reported seed and shrinking path, selecting the same test:

```sh
AGENTPOST_FUZZ_RUNS=10000 AGENTPOST_FUZZ_SEED=123 \
  AGENTPOST_FUZZ_PATH=0:1:2 mise exec -- bun test ./test/security.fuzz.ts \
  --test-name-pattern 'JSON preflight'
```

Counts accept 1–100,000 and seeds accept signed 32-bit integers; invalid configuration fails. Keep the same lockfile and generators for replay. This is generative property testing, not coverage-guided fuzzing of the entire Worker. Authorization and recovery have separate adversarial tests and formal verification. An initial 500,000-case run passed without a new product defect.

## Local checks

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise run ci
mise run security:dependencies
```

`ci` includes the offline zizmor workflow audit. OSV's separate command checks only the resolved `bun.lock`; it does not recursively inspect local private deployment files. OSV sends package names and resolved versions to its advisory service. Online workflow analysis in GitHub can find issues that offline analysis cannot.

Dependabot version updates wait seven days after an upstream release to reduce exposure to newly published malicious versions. Advisory-driven security updates are exempt from that cooldown. Local zizmor checks cover all of `.github`, including Dependabot configuration.

## Repository protection

The upstream repository is public. GitHub secret scanning, push protection, Dependabot alerts and security updates, and private vulnerability reporting are enabled. Actions require SHA-pinned references, use read-only default permissions, and require maintainer approval for workflows from all external contributors.

The active `main security checks` ruleset requires a PR, a branch up to date with main, resolved review conversations, and sixteen passing GitHub Actions checks: formatting, lint, types, tests, build, action pins, secrets, both formal-verification jobs, Bun audit, OSV, zizmor, CodeQL, dependency review, security fuzzing, and code complexity. CodeQL findings at any severity also block merges through a separate code-scanning rule. Force pushes and branch deletion are blocked, with no configured bypass actors. The repository has one operator, so the rule requires zero external approvals; this does not provide independent human review.

These are settings of the upstream GitHub repository, not settings automatically inherited by a clone or self-hosted deployment. Fork maintainers must configure their own repository protections.

Version tags have separate creation and integrity rules. Only the repository owner can currently create `v*` tags; no actor can update/delete them through normal Git operations. The future release App must be explicitly added to the creation rule, never the update/deletion rule. This prevents ordinary repository writers from substituting an off-main signing workflow through a new tag. Published releases are immutable. The pipeline verifies the live tag target and all three attested subjects, enforces an exact five-asset inventory, verifies downloaded bytes, and checks the final immutable state. See [releases](releases.md).

See [remaining scorecard conditions](scorecard-remediation.md) for evidence and prerequisites that cannot be manufactured by a code change.

## Reporting and triage

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/upamune/agentpost/security/advisories/new), as described in [SECURITY.md](../SECURITY.md). Keep live tokens, messages, deployment hostnames and working exploit details out of public issues and CI artifacts. The configured production credentials and private deployment helpers are not part of this repository or these scanners.

Review alerts after dependency or authentication changes and new advisories. A scanner outage is not a clean result. The owned OSV job preserves its exit status and uploads reports only for completed scans: 0 (clean) or 1 (vulnerabilities). Operational failures such as 127 fail even if the scanner wrote an empty report, and cannot publish a clean result. Three shell-execution regressions exercise this boundary. A score measures observable practices, not the absence of exploitable code; do not weaken checks or invent policy documents to raise it. Ordinary advisory triage and remediation remain maintainer work.

Release automation uses a main-only `release-automation` Environment for the future GitHub App private key. The existing App setup remains a separate operator step; no App key is required for security scanning. See [releases](releases.md).

## Publication audit — 2026-10-26

The audited code baseline is `61e305b62f0c98dde3ca1a84d7829f195fd70c01`. Three independent adversarial reviewers rechecked authentication/OAuth/MCP/ownership, clients and installation, and mail/recovery/domain-diagnostic boundaries. No new reproducible publication-blocking vulnerability was identified in that scope. The earlier remediations remain documented in the [2026-10-25 audit](security-audit.md).

Before publication, Gitleaks scanned all 21 reachable commits. A separate comparison of 441 reachable blobs against five known local credentials and selected live deployment identifiers found no matches; the values were never included in the report. The dependency checks reported no known advisories in Bun audit's 287 packages and OSV's 290 parsed lockfile entries. The independent reviewers exercised 39 auth/Event tests, 28 client/adversarial tests, 17 mocked diagnostic tests and 69 mail/diagnostic/security tests; overlapping tests are not unique coverage counts. No production probing or actual mail was involved in this audit. Local CI also passed 100 ordinary Worker tests, 28 client tests, inbound/outbound formal verification and mutation selftests.

Workflow hardening replaces direct matrix interpolation in shell source with quoted environment variables and moves the future release key behind a main-only Environment. The previous matrix was a fixed trusted list; this is preventive hardening, not a demonstrated remote code-execution finding.

The first hosted scan found four CodeQL filesystem-race alerts in the synthetic CLI download test. The test inspected a pathname before reading or replacing its fixture. Production downloads already use atomic exclusive creation (`open` with `wx`) and write through the returned handle. The test now checks permissions and content through one handle and uses a separate exclusively created fixture for overwrite and symlink assertions, without suppressing the query. The first zizmor run also detected an insufficient implicit Dependabot cooldown; both ecosystems now explicitly use seven days. Three additional shell regressions verify OSV's clean, vulnerable, and failed-scan paths; the resulting ordinary test suite has 100 Worker tests and 31 Bun tests.

The initial Scorecard snapshot also reported practice gaps, including the repository's young age, absent independent review history, missing continuous fuzzing, and no OpenSSF Best Practices registration. Continuous fuzzing and signed source releases have since been added; see the [remediation ledger](scorecard-remediation.md) for current evidence and remaining prerequisites. Practice findings do not by themselves establish exploitable application vulnerabilities.

The hosted analyses for [PR #1](https://github.com/upamune/agentpost/pull/1), revision `cb871cb`, completed with zero CodeQL, OSV, and zizmor results. Dependency review also passed on the PR and on a manual main-branch comparison. Repository protection settings were read back from GitHub, and all seven README badge endpoints returned SVG images successfully. Remaining Scorecard practice findings are tracked openly.

This is a source/publication audit. It does not prove whole-system absence of bugs, every MIME parser allocation bound, real Cloudflare platform isolation, backup restoration, mail deliverability, or safety of arbitrary agent actions based on hostile mail. Each operator must complete their own [deployment checks](deploy.md).
