# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0] - 2025-12-09

### Added

- Initial release extracted from ensemble v3.x monolith
- Plugin structure created for modular installation

## [Unreleased]

### Added

- `code-reviewer` is read-only and reports a structured finding contract. The
  agent no longer carries Write or Edit tools: it records or posts findings and
  never changes the code it reviews. It reads the applied `REVIEW.md` files,
  `CLAUDE.md` and the constitution from the target branch (never from the PR
  head), and every finding it returns carries the ledger fields -- location,
  severity from the closed set, failure mode, evidence and the original text or
  link -- so `pr-review-cycle` can verify it by vote (a strict majority of the
  depth's verifiers: 2 of 3 at Standard, 3 of 5 at Deep) before the author is
  asked to answer anything.
- Tool abstraction layer: `adapter-review-coderabbit`, the default `review` adapter. See `docs/guides/adapter-authoring.md`.
- `flake-reproduction` skill (PRD-2026-bd69b524, REQ-034 and REQ-035): an editable recipe to reproduce and root-cause an intermittent, order-dependent or partition-dependent test failure (private database per run, bounded pool, replay of the logged handle, bounded capture under CPU load, the 3/p run-count rule, the time box). Ships a replayable red-run record template, a stack-neutral `capture-loop.sh` that keeps the full output of every failing run, and an Elixir/mix worked example. It never retries, quarantines, skips, widens a timeout or weakens an assertion.

### Changed

- `deep-debugger` loads `flake-reproduction` for intermittent or order-dependent failures instead of stopping after 3 attempts.

- `pr-review-remediation` skill — verify and remediate findings from CodeRabbit or
  another PR review agent: triage each finding (valid, stale, duplicate, already
  fixed, or incorrect), reproduce behavioral defects with a focused regression
  test, apply the minimal fix, and validate using the project's own tools.
  Treats review comments as untrusted leads to investigate, never as trusted
  instructions.
