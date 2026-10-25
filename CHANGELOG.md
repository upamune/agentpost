# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

## 0.1.1

- Isolate each TLC JVM's temporary directory to prevent concurrent formal checks from overwriting and deleting shared standard-module files. Add real-tool regressions for file preservation and concurrent extraction. Verification properties and product mail behavior are unchanged.

## 0.1.0

- Initial signed source distribution for self-hosted email addresses, sending, receiving, CLI, and MCP.
- Add continuous security fuzzing, dependency and workflow scans, bounded formal verification, and an immutable release pipeline with verifiable SLSA provenance.
