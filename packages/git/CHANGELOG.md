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

- Tool abstraction layer adapters: `adapter-host-github`, `adapter-workflow-plain-git`, `adapter-workflow-git-town`, `adapter-worktree-plain-git` and `adapter-ci-local-act`; `/ensemble:pr-merge` and the `git-town` skill now name capabilities rather than `gh`/`git` binaries. See `docs/guides/adapter-authoring.md`.

- `/ensemble:pr-merge` — resolves an open PR's CI failures and review change-requests by dispatching one subagent per finding, routed through tech-lead-orchestrator (code), qa-orchestrator (tests), build-orchestrator/infrastructure-orchestrator (pipeline/infra), or github-specialist (PR mechanics), then re-verifies against live state and merges once green. Never deletes or weakens a test to force a check green.

- `/ensemble:pr-merge` now runs the shared review gate before it merges (TRD-2026-70e784f2, PR 4). It invokes `MODE=gate` of the `pr-review-cycle` skill against freshly read GitHub state and merges only on `mergeable: true`. The gate refuses — naming the blocker and a `nextAction` — on an open Important finding, an unanswered security finding, an incomplete description, human approvals short of the PR's risk tier, or review data it could not read; it never passes on missing data. Approvals count only when bound to the commit under review (a push invalidates them), bot approvals never count, and the author never fills a required slot. **Honest limit:** this runs where ensemble runs; server-side enforcement still needs a branch-protection rule, which `pr-merge` reports as absent and recommends but cannot create.

- Plugin extraction and population (in progress)
