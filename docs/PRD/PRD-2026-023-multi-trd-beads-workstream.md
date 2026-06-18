---
document_id: PRD-2026-023
version: 1.0.1
status: Draft
date: 2026-06-17
scale_depth: STANDARD
total_requirements: 16
readiness_score: 4.85
---

# PRD-2026-023: Multi-TRD Beads Workstream

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 12 |
| Should requirements | 4 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 16/16 (100%) |
| Risk flags | 4 |
| Cross-requirement dependencies | 13 |

## Product Summary

**Problem:** Product managers and developers need to load multiple related PRD/TRD pairs into Ensemble while preserving each PRD→TRD traceability chain, cross-TRD dependency graphs, and the release train. Combining multiple PRDs into one TRD loses the clean product-to-technical handoff boundary and makes future review, release tracking, and dependency reasoning harder.

**Solution:** Extend `/ensemble:implement-trd-beads` so one TRD path preserves current behavior and multiple TRD paths activate **combined workstream mode**. In combined workstream mode, each TRD becomes its own root epic in Beads, all TRD-local stories/tasks remain under that epic, cross-TRD dependencies are represented as Beads dependencies between epics/stories/tasks, and a parent release train bead groups all related TRD epics for status, planning, and execution.

**Value proposition:** Keep PRD/TRD traceability intact while giving users one graph-aware workstream for related work. Target outcomes: reduce PRD/TRD overhead by 25%, increase parallel work streams by 25%, and reduce release/merge complexity by 25%.

**Target users:** Product managers coordinating related PRD/TRD scope and developers executing graph-aware implementation with Beads, `bv`, git-town, and stacked PRs.

## Goals and Non-Goals

**Goals:**
- Allow `/ensemble:implement-trd-beads` to accept multiple TRD paths.
- Preserve existing single-TRD behavior exactly.
- Create one release train bead for a multi-TRD workstream.
- Create one root epic bead per TRD, preserving PRD→TRD→epic traceability.
- Preserve each TRD’s internal PR/story/task structure under its own epic.
- Encode cross-TRD dependencies as Beads dependencies, not merged documentation.
- Use `bv --robot-*` output to validate ordering and parallelism.
- Clearly notify users that stacked PRs are enabled and the command is running a combined workstream.
- Fast-fail before any scaffold/branch creation if any TRD is missing, stale, malformed, or not approved.

**Non-Goals:**
- Combining multiple PRDs into one TRD.
- Rewriting PRDs or TRDs during implementation.
- Auto-resolving dependency/release conflicts without user input.
- Replacing Beads with another task graph system.
- Requiring all TRDs to be implemented on a single branch.

---

## Requirements

### Input and Mode Handling

#### REQ-001: Preserve Single-TRD Behavior
**Priority:** Must | **Complexity:** Low

When `/ensemble:implement-trd-beads` receives exactly one TRD path, it behaves exactly as it does today.

- **AC-001-1:** Given one valid TRD path, when `/ensemble:implement-trd-beads <trd-path>` runs, then the existing single-TRD scaffold, plan, execute, status, and resume behavior remains unchanged.
- **AC-001-2:** Given one valid TRD path, when the command creates Beads, then it creates the same root epic/story/task hierarchy currently produced for a single TRD.

#### REQ-002: Multi-TRD Mode Trigger
**Priority:** Must | **Complexity:** Low

When `/ensemble:implement-trd-beads` receives two or more TRD paths, it enters combined workstream mode.

- **AC-002-1:** Given two or more TRD paths, when the command starts, then it announces combined workstream mode and lists all source TRDs.
- **AC-002-2:** Given combined workstream mode starts, then the command prints that PRD/TRD traceability will be preserved by creating separate TRD epics under one release train.

#### REQ-003: Combined Workstream UX Banner
**Priority:** Must | **Complexity:** Low

Combined workstream mode always makes the execution context visible to the user.

- **AC-003-1:** Given combined workstream mode is active and stacked PR support is available, when preflight completes, then the command prints `Combined workstream mode: stacked PRs enabled`.
- **AC-003-2:** Given combined workstream mode is active, when status or summary output is printed, then the release train name/ID and all source TRD epics are shown.

### Preflight Validation

#### REQ-004: Validate All TRDs Before Side Effects
**Priority:** Must | **Complexity:** Medium

The command validates every supplied TRD before creating any Beads, branches, or implementation artifacts.

- **AC-004-1:** Given multiple TRD paths, when preflight runs, then every TRD is checked for readability, parseability, PRD reference, Master Task List, PR sections, and Shippable State lines before scaffold creation.
- **AC-004-2:** Given any TRD fails validation, when preflight completes, then the command hard-stops all work and reports every failing TRD with a specific reason.

#### REQ-005: Fast-Fail on Stale or Unapproved TRD
**Priority:** Must | **Complexity:** Medium | [RISK: approval signal may vary across older TRD formats]

Combined workstream mode fast-fails if any TRD is stale or not approved/ready. A TRD is acceptable only when `design_readiness_score >= 4.0` and status is not `Failed` or `Blocked`; if readiness score is missing, the command fast-fails and tells the user to run `/ensemble:refine-trd`.

- **AC-005-1:** Given any selected TRD is stale under the existing TRD staleness gate rules, when combined workstream preflight runs, then the entire command stops before any Beads or branches are created.
- **AC-005-2:** Given any selected TRD has `design_readiness_score < 4.0`, missing `design_readiness_score`, or status `Failed`/`Blocked`, when preflight runs, then the entire command stops and tells the user which TRD must be refined or approved.

#### REQ-006: No Partial Scaffold on Preflight Failure
**Priority:** Must | **Complexity:** Low

Combined workstream mode is all-or-nothing during preflight.

- **AC-006-1:** Given at least one TRD fails preflight, when the command exits, then no release train bead, root epic bead, story bead, task bead, or branch is created.
- **AC-006-2:** Given all TRDs pass preflight, when scaffold begins, then all selected TRDs are eligible for scaffold creation in a single release train.

### Beads Model and Traceability

#### REQ-007: Release Train Parent Bead
**Priority:** Must | **Complexity:** Medium

Combined workstream mode creates one parent release train bead that groups all selected TRD epics. The release train bead includes metadata: label/type `release-train`, title from a common slug or user-provided name, source TRD paths, source PRD references, child epic IDs, stacked PR mode status, combined workstream flag, and created timestamp.

- **AC-007-1:** Given combined workstream mode scaffolds successfully, then one release train bead is created with metadata for label/type, title, source TRD paths, source PRD references, child epic IDs, stacked PR mode status, combined workstream flag, and created timestamp.
- **AC-007-2:** Given the user asks for status, then the release train bead shows aggregate progress across all child TRD epics.

#### REQ-008: One Root Epic Per TRD
**Priority:** Must | **Complexity:** Medium

Each selected TRD becomes its own root epic bead under the release train.

- **AC-008-1:** Given three selected TRDs, when scaffold completes, then exactly three TRD root epic beads exist under the release train.
- **AC-008-2:** Given a TRD root epic is viewed, then it includes the source TRD path, PRD reference, and traceability metadata.

#### REQ-009: Preserve TRD-Local Structure
**Priority:** Must | **Complexity:** Medium

Each TRD’s internal PR/story/task hierarchy remains under that TRD’s root epic.

- **AC-009-1:** Given a TRD contains multiple `### PR N:` sections, when scaffold runs, then those sections are represented under that TRD’s root epic without merging with another TRD’s sections.
- **AC-009-2:** Given a task originates from a TRD, when viewed in Beads, then it identifies its source TRD and source TRD task ID.

#### REQ-010: Cross-TRD Dependency Edges
**Priority:** Must | **Complexity:** High | [RISK: dependency references may be ambiguous across TRDs]

Cross-TRD dependencies are represented as Beads dependencies between epics, stories, or tasks. Dependency references use source-qualified formats: `<trd-slug>#TRD-NNN` for task references and `<trd-slug>#PR-N` for PR-section references. After scaffold, Beads metadata stores resolved source and target as TRD path plus bead ID.

- **AC-010-1:** Given TRD A depends on work from TRD B using `<trd-slug>#TRD-NNN` or `<trd-slug>#PR-N`, when scaffold completes, then Beads contains dependency edges from TRD A’s relevant bead(s) to TRD B’s relevant bead(s) and stores resolved TRD path plus bead ID metadata.
- **AC-010-2:** Given a cross-TRD dependency cannot be mapped unambiguously, when scaffold planning reaches it, then the command asks the user how to resolve it before creating the affected dependency edge.

### Dependency Resolution and Graph Validation

#### REQ-011: Dependency Source Priority
**Priority:** Must | **Complexity:** Medium | [RISK: existing Beads graph may diverge from updated TRD dependency annotations on resume]

The command resolves dependencies using explicit TRD annotations first, existing Beads graph on resume second, and `bv --robot-*` validation after scaffold.

- **AC-011-1:** Given explicit `[depends: ...]` annotations exist in selected TRDs, when dependency resolution runs, then those annotations are the primary source of cross-TRD dependency edges.
- **AC-011-2:** Given an existing combined workstream is resumed, when dependency resolution runs, then existing Beads dependencies are preserved unless the user approves changes.

#### REQ-012: Graph Validation with bv Robot Output
**Priority:** Should | **Complexity:** Medium

After scaffold, the command uses `bv --robot-*` output to validate ordering, blocked work, and parallel-safe execution streams.

- **AC-012-1:** Given `bv` is available, when graph validation runs, then the command uses only `--robot-*` flags and never launches bare interactive `bv`.
- **AC-012-2:** Given `bv` reports cycles, unexpected blockers, or priority/order mismatches, when validation completes, then the command reports the issue and asks the user how to proceed.

#### REQ-013: Conflict Resolution Prompts
**Priority:** Must | **Complexity:** Low

Dependency conflicts and release-order conflicts require user input.

- **AC-013-1:** Given two TRDs imply conflicting release order or dependency direction, when planning detects the conflict, then the command asks the user a specific resolution question.
- **AC-013-2:** Given the user does not resolve the conflict, when planning would continue, then affected scaffold/execution is blocked rather than guessed.

### Stacked PR and Release Train Execution

#### REQ-014: Stacked PR Preflight
**Priority:** Must | **Complexity:** Medium | [RISK: git-town/stacked PR support varies by environment]

Combined workstream mode checks stacked PR readiness before scaffold/execution.

- **AC-014-1:** Given `ENSEMBLE_USE_STACKED_PRS=true` and git-town is available, when combined workstream preflight runs, then the command proceeds and prints `Combined workstream mode: stacked PRs enabled`.
- **AC-014-2:** Given stacked PR mode is not enabled or git-town cannot support the workstream, when preflight runs, then the command notifies the user and asks how to proceed.

#### REQ-015: Alternatives When Stacked PRs Are Not Ready
**Priority:** Should | **Complexity:** Low

If stacked PRs are not ready, the user receives explicit alternatives.

- **AC-015-1:** Given stacked PR mode is unavailable, when the command prompts the user, then it offers these choices: enable stacked PRs and continue, proceed single-branch per TRD, scaffold only/plan mode, or stop.
- **AC-015-2:** Given the user chooses scaffold only/plan mode, when the command continues, then it creates/plans Beads but does not create implementation branches.

#### REQ-016: Combined Workstream Status and Reporting
**Priority:** Should | **Complexity:** Medium

The command reports combined release train progress while preserving per-TRD detail.

- **AC-016-1:** Given a combined workstream exists, when status runs, then it shows release train progress, each TRD epic progress, blocked items, ready items, and parallel-safe streams.
- **AC-016-2:** Given the release train has cross-TRD dependencies, when status runs, then dependency blockers are shown with both source and target TRD context.

---

## Acceptance Criteria Summary

| REQ | Description | Priority | Complexity | AC Count |
|-----|-------------|----------|------------|----------|
| REQ-001 | Preserve single-TRD behavior | Must | Low | 2 |
| REQ-002 | Multi-TRD mode trigger | Must | Low | 2 |
| REQ-003 | Combined workstream UX banner | Must | Low | 2 |
| REQ-004 | Validate all TRDs before side effects | Must | Medium | 2 |
| REQ-005 | Fast-fail on stale/unapproved TRD | Must | Medium | 2 |
| REQ-006 | No partial scaffold on preflight failure | Must | Low | 2 |
| REQ-007 | Release train parent bead | Must | Medium | 2 |
| REQ-008 | One root epic per TRD | Must | Medium | 2 |
| REQ-009 | Preserve TRD-local structure | Must | Medium | 2 |
| REQ-010 | Cross-TRD dependency edges | Must | High | 2 |
| REQ-011 | Dependency source priority | Must | Medium | 2 |
| REQ-012 | Graph validation with bv robot output | Should | Medium | 2 |
| REQ-013 | Conflict resolution prompts | Must | Low | 2 |
| REQ-014 | Stacked PR preflight | Must | Medium | 2 |
| REQ-015 | Alternatives when stacked PRs are not ready | Should | Low | 2 |
| REQ-016 | Combined workstream status and reporting | Should | Medium | 2 |

## Dependency Map

- REQ-002 depends on REQ-001 (multi-path behavior must not break one-path behavior).
- REQ-003 depends on REQ-002 (UX banner only applies to combined mode).
- REQ-004, REQ-005, and REQ-006 form the preflight cluster and must be implemented together.
- REQ-007 depends on REQ-004/REQ-005/REQ-006 (release train only after clean preflight).
- REQ-008 depends on REQ-007 (TRD epics attach to release train).
- REQ-009 depends on REQ-008 (TRD-local structure belongs under each epic).
- REQ-010 depends on REQ-008 and REQ-009 (dependency edges link created epics/stories/tasks).
- REQ-011 depends on REQ-010 (dependency source priority controls edge creation).
- REQ-012 depends on REQ-007 through REQ-011 (bv validates the created graph).
- REQ-013 modifies REQ-010/REQ-011/REQ-012 (conflicts pause for user resolution).
- REQ-014 depends on REQ-002 and runs before branch creation.
- REQ-015 depends on REQ-014 (fallback choices when stacked PRs unavailable).
- REQ-016 depends on REQ-007 through REQ-012 (status reports release train + graph).

**Implementation clusters:**
- Input/preflight cluster: REQ-001 through REQ-006.
- Beads traceability cluster: REQ-007 through REQ-011.
- Graph/conflict cluster: REQ-012 and REQ-013.
- Execution/status cluster: REQ-014 through REQ-016.

## Technical Dependencies and Constraints

- Existing command: `packages/development/commands/implement-trd-beads.yaml`.
- Existing Beads tools: `br` for issue creation/update/dependencies; `bv --robot-*` for graph validation and planning.
- Existing stacked PR model: `ENSEMBLE_USE_STACKED_PRS=true` and git-town support.
- Existing parser contract: TRD `## Master Task List`, `### PR N:` headings, and `**Shippable State:**` lines.
- Existing staleness behavior: TRD staleness gate must apply to every selected TRD before combined scaffold.
- Cross-TRD dependency reference format: `<trd-slug>#TRD-NNN` and `<trd-slug>#PR-N`, resolved after scaffold to TRD path plus bead ID.

## Adversarial Review Resolutions

1. **Command surface:** extend `/ensemble:implement-trd-beads`; do not create a new command for this release.
2. **Beads model:** create one release train parent bead, one root epic per TRD, and cross-epic/story/task dependency edges.
3. **Dependency source:** explicit TRD `[depends: ...]` annotations first; existing Beads graph on resume; `bv --robot-*` validates after scaffold.
4. **Stacked PR UX:** combined mode requires/announces stacked PRs; if unavailable, notify user and present alternatives.
5. **Fast fail:** validate every TRD before any side effects; no partial scaffold if any TRD fails.

## Ambiguity Scan

Ambiguity scan complete: 0 items marked for clarification.

## Implementation Readiness Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Completeness | 4.85 | Covers input modes, preflight, Beads model, release train metadata, cross-TRD deps, stacked PR UX, status/reporting. |
| Testability | 4.85 | Every requirement has Given/When/Then ACs with explicit readiness, metadata, and dependency reference checks. |
| Clarity | 4.85 | Explicitly rejects merged-TRD approach and preserves PRD/TRD/epic traceability with source-qualified dependency refs. |
| Feasibility | 4.85 | Builds on existing `implement-trd-beads`, Beads, `bv`, and stacked PR conventions. |
| **Overall** | **4.85** | **PASS — ready for TRD handoff.** |

## Changelog

### 1.0.1 — 2026-06-17

- Added exact TRD readiness/approval signal for combined workstream preflight.
- Added release train bead metadata requirements.
- Added source-qualified cross-TRD dependency reference format.
- Added risk marker for dependency source priority on resume.
- Added changelog section and bumped readiness score to 4.85.
