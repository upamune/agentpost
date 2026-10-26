# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

## 0.1.4

- Bound local mail and checkpoint file reads, reject devices/FIFOs, and enforce the complete serialized API request limit before submission. Preserve Unicode mail and stop on invalid saved checkpoints.
- Report stale `sending` requests through authenticated health without changing their outcomes or resending mail.
- Retain executable CI artifacts only for release assembly, select the exact npm archive version, and document Node-only skill installation.

## 0.1.3

- Fix the npm publisher's local archive path so npm does not interpret it as a GitHub shorthand. Add an actual offline npm publish dry-run regression using the workflow's maintained file argument.
- Publish the first npm CLI/MCP version through GitHub OIDC with provenance. Version 0.1.2's signed GitHub assets remain immutable.

## 0.1.2

- Publish the dependency-free Node.js CLI/MCP client as `@upamune/agentpost` with GitHub OIDC Trusted Publishing and npm provenance. Installation requires no lifecycle scripts or Bun.
- Distribute seven standalone executables for macOS, Linux glibc/musl, and Windows x64 with signed provenance and native smoke tests.

## 0.1.1

- Isolate each TLC JVM's temporary directory to prevent concurrent formal checks from overwriting and deleting shared standard-module files. Add real-tool regressions for file preservation and concurrent extraction. Verification properties and product mail behavior are unchanged.

## 0.1.0

- Initial signed source distribution for self-hosted email addresses, sending, receiving, CLI, and MCP.
- Add continuous security fuzzing, dependency and workflow scans, bounded formal verification, and an immutable release pipeline with verifiable SLSA provenance.
