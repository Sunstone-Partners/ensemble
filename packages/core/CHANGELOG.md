# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/ensemble:init-project` Step 6 scaffolds the three files every pull-request review reads: `.github/pull_request_template.md`, the root `REVIEW.md` (carrying the fenced `ensemble-review-policy` block read only from the base branch) and `.github/CODEOWNERS`. Existing files are never overwritten: a missing file is written from the template, an existing file is diffed and merged (missing sections appended, no line removed) unless "force" is requested, and the PR template's `Testing` section fails the real description check (`pr-review-description.js`) when left as a comment, a bare list marker or blank.

## [5.0.0] - 2026-05-27

### Breaking Changes

- **Model alias rename**: `opus`, `sonnet`, and `haiku` aliases are replaced by `high`, `medium`, and `low`.
  Any configuration or command YAML using the old aliases must be updated.
  - Rename `opus` → `high`, `sonnet` → `medium`, `haiku` → `low` everywhere.
  - Run `/ensemble:migrate-model-config` to auto-migrate an existing `~/.config/ensemble/model-selection.json`.
  - Run `/ensemble:map-model` to create a new project-level `.claude/ensemble-model-config.json`.

- **Config path change**: Model tier mappings are now read from `<project_root>/.claude/ensemble-model-config.json`
  instead of `~/.config/ensemble/model-selection.json`. The old XDG user-level file is no longer read
  (a one-time stderr warning is shown if it is detected).

- **Per-command `commandOverrides` removed**: The `commandOverrides` block in the legacy config is not
  supported in the new format. Use each command's own YAML `metadata.model` field instead.

### Added

- `packages/core/lib/known-model-ids.js` — single source of truth for valid Claude model IDs
- `schemas/ensemble-model-config-schema.json` — JSON Schema for project-level model config
- `/ensemble:map-model` command — interactive wizard for tier remapping
- `/ensemble:migrate-model-config` command — one-shot migration from legacy config
- `npm run lint:model-ids` — CI lint script for retired model IDs

### Changed

- `packages/core/lib/config-loader.js` — rewrites project-root detection, new config path, tier-based defaults
- `packages/core/lib/model-resolver.js` — pre-flight validation, tier-alias-only env var
- All 18 command YAMLs migrated to `high`/`medium`/`low` tier aliases
- All 28 agent YAMLs now declare explicit `model:` tier
- `packages/core/lib/usage-logger.js` — hardcoded log path, updated MODEL_PRICING

## [4.0.0] - 2025-12-09

### Added

- Initial release extracted from ensemble v3.x monolith
- Plugin structure created for modular installation

## [Unreleased]

### Added

- Tool abstraction layer: `adapter-package-runner-npm`, the default `package-runner` adapter. See `docs/guides/adapter-authoring.md`.

- Plugin extraction and population (in progress)
