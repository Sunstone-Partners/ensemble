# Changelog

## [Unreleased]

### Added
- Claude Code adapter for command lifecycle hooks: `UserPromptSubmit` starts a run for `/ensemble:<name>`; `Stop`, `StopFailure` and `SessionEnd` end it. Shell handlers only; same `.ensemble/hooks.yaml`, payload, redaction, timeouts and trust store as Pi.
- `trust` subcommand to record trust from a terminal.

### Fixed
- The bundle freshness test no longer fails on any bun other than the one that built the committed bundle: `scripts/build.mjs` records the bun version in `bundle/BUN_VERSION` and the test compares a fresh build only under that version.
