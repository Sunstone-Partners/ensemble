# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Pi/OMP installability: `pi-package` keyword and `pi` manifest in `package.json`. Install `@sunstone-partners/ensemble-assessment` together with `@sunstone-partners/ensemble-pi`; there is no dependency between them.
- Test covering orchestrator-to-leaf delegation (dispatched leaves exist, numeric-first scoring, `skill://` references resolve).

### Changed

- `assess-repo` and `assess-team` now delegate each dimension to its leaf skill instead of embedding a copy of the specialist prompt; the leaf skills are the single source and can be run directly for a single dimension. `assess-repo` is about 40% shorter and `assess-team` about 50% shorter.
- All leaf skills and the `assess-team` synthesis use numeric-first scoring (`<1.0-5.0> / <Letter>`) per `assessment-report-suite`; bare letter-only scores are gone.

### Removed

- Assessment skills are no longer bundled into `ensemble-pi`; they ship only in `ensemble-assessment` (still included in `ensemble-full`).

## [1.0.0] - 2026-10-09

### Added

- Initial release: 22 assessment skills covering repository assessment
  (architecture, code quality, testing, security, CI/CD, AI readiness,
  purpose inference), team assessment (commit volume/messages, code quality,
  test coverage, AI adoption, documentation, incidents, code review),
  portfolio-local configuration (`assess-config`), portfolio architecture
  synthesis (`architecture-overview-report`), scored Excel diagnostic
  reporting (`ai-readiness-diagnostic-report`), end-to-end executive package
  generation (`assessment-report-suite`), and assessment-scoring QA
  (`assessment-scoring-conflation-audit`).
- Local output paths (template/reports directories) are configurable via
  `.assessment/external-systems.yaml`'s `local_output` block instead of a
  hardcoded filesystem location.
