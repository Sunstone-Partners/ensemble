---
document_id: PRD-2026-024
version: 1.0.1
status: Draft
date: 2026-06-17
scale_depth: STANDARD
total_requirements: 19
readiness_score: 4.8
---

# PRD-2026-024: refine-beads Command

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 15 |
| Should requirements | 4 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 19/19 (100%) |
| Risk flags | 3 |
| Cross-requirement dependencies | 12 |

## Product Summary

**Problem:** Developers need a way to review and refine the Beads dependency graph before executing tasks. Existing planning commands can analyze graph state, but they do not provide a structured, approval-gated workflow for detecting hierarchy gaps, dependency inconsistencies, missing requirements, and PR-boundary mismatches, then applying approved repairs directly to Beads.

**Solution:** Add `/ensemble:refine-beads`, a graph refinement command that uses `br` for Beads reads/updates and `bv --robot-*` for dependency graph analysis. The command analyzes a selected epic/release-train subtree by default, presents findings and proposed repairs, asks for user approval, applies approved fixes via `br`, verifies each update, syncs Beads, and re-runs graph validation. It never executes implementation tasks.

**Value proposition:** Developers can review and repair the dependency graph before execution, improving confidence that `beads-build`, `implement-trd-beads`, or Foreman will run the right work in the right order.

**Target users:** Developers managing Beads-backed Ensemble implementation plans.

## Goals and Non-Goals

**Goals:**
- Add `/ensemble:refine-beads` as an approval-gated Beads graph refinement command.
- Use `br` for all Beads updates.
- Use `bv --robot-*` for dependency graph analysis; never launch bare interactive `bv`.
- Detect cycles, orphaned tasks, missing blockers, stale blockers, PR-boundary mismatches, missing traceability, duplicate tasks, and priority/order mismatches.
- Require explicit approval before dependency updates.
- Apply approved fixes directly to Beads and verify each command.
- Support scoped refinement by epic/release train and optional whole-project mode.
- Never execute implementation tasks.

**Non-Goals:**
- Replacing `beads-plan` or `beads-build`.
- Running implementation, tests, builders, or reviewers.
- Auto-applying dependency changes without user approval.
- Editing PRD/TRD files directly.
- Rewriting the full Beads graph without incremental approved changes.

---

## Requirements

### Command Scope and Inputs

#### REQ-001: Provide refine-beads Command
**Priority:** Must | **Complexity:** Low

Ensemble provides `/ensemble:refine-beads` for graph refinement before execution.

- **AC-001-1:** Given the command registry is generated, when users list Ensemble commands, then `/ensemble:refine-beads` is available with description and argument hint.
- **AC-001-2:** Given `/ensemble:refine-beads` runs, when it completes successfully, then no implementation tasks have been executed.

#### REQ-002: Scoped Epic or Release Train Selection
**Priority:** Must | **Complexity:** Medium

The command accepts an epic ID, release train ID, or slug pattern and defaults to subtree scope.

- **AC-002-1:** Given an epic ID or slug pattern, when the command starts, then it resolves exactly one open epic/release train or stops with a clear message.
- **AC-002-2:** Given no argument is supplied, when the command starts, then it lists candidate open epics/release trains and asks the user to select one.

#### REQ-003: Project Scope Mode
**Priority:** Should | **Complexity:** Low | [RISK: project-wide repairs may affect unrelated work]

The command supports optional project-wide analysis with explicit warning.

- **AC-003-1:** Given `--scope project` is supplied, when analysis begins, then the command warns that proposed fixes may affect unrelated epics.
- **AC-003-2:** Given project mode is selected, when repairs are proposed, then findings identify affected epic/release-train context for each fix.

### Tooling and Safety

#### REQ-004: Require br and Use br for Updates
**Priority:** Must | **Complexity:** Low

The command requires `br` and applies all approved updates through `br` commands.

- **AC-004-1:** Given `br` is unavailable or nonfunctional, when preflight runs, then the command halts before analysis.
- **AC-004-2:** Given a fix is approved, when it is applied, then the underlying operation is expressed and executed as one or more `br` commands.

#### REQ-005: Use bv Robot Flags for Graph Analysis
**Priority:** Must | **Complexity:** Low

The command uses `bv --robot-*` flags for dependency graph analysis and never uses bare `bv`.

- **AC-005-1:** Given `bv` is available, when graph analysis runs, then the command uses robot-safe flags such as `bv --robot-insights`, `bv --robot-plan`, `bv --robot-alerts`, or `bv --robot-suggest`.
- **AC-005-2:** Given command instructions are reviewed, when graph-analysis steps are inspected, then no action instructs running bare `bv` without a `--robot-*` flag.

#### REQ-006: Read-Only Analysis Before Approval
**Priority:** Must | **Complexity:** Low

The analysis phase is read-only and cannot modify Beads before approval.

- **AC-006-1:** Given analysis runs, when findings are generated, then no `br update`, `br dep add`, `br dep remove`, `br close`, or other mutating command has run.
- **AC-006-2:** Given analysis produces findings, when the user has not approved fixes, then Beads state remains unchanged except for optional `br sync --flush-only`.

### Finding Detection

#### REQ-007: Detect Dependency Graph Issues
**Priority:** Must | **Complexity:** High | [RISK: bv and br may expose graph facts at different abstraction levels]

The command detects dependency graph issues before execution.

- **AC-007-1:** Given the Beads graph has cycles, stale blockers, missing blockers, or contradictory priority/order recommendations, when analysis runs, then these are listed as findings.
- **AC-007-2:** Given `bv` reports cycles, unexpected blockers, or order/priority mismatches, when findings are presented, then each finding includes affected bead IDs and a recommended resolution when possible.

#### REQ-008: Detect Hierarchy Gaps
**Priority:** Must | **Complexity:** Medium

The command detects Beads hierarchy gaps.

- **AC-008-1:** Given tasks exist outside the selected epic/story hierarchy, when analysis runs, then orphaned tasks are reported.
- **AC-008-2:** Given stories or tasks are missing expected parent/child links, when analysis runs, then the missing hierarchy relationship is reported with affected bead IDs.

#### REQ-009: Detect PR Boundary and Release Train Gaps
**Priority:** Must | **Complexity:** Medium

The command checks whether dependencies map cleanly to PR boundaries and release sequencing.

- **AC-009-1:** Given a dependency edge skips or contradicts PR boundary ordering, when analysis runs, then the command reports a PR-boundary mismatch.
- **AC-009-2:** Given tasks/stories lack PR boundary metadata needed for stacked PR/release sequencing, when analysis runs, then the missing metadata is reported.

#### REQ-010: Detect Missing Requirements and Traceability
**Priority:** Must | **Complexity:** Medium

The command detects missing acceptance criteria or traceability metadata needed to verify requirements.

- **AC-010-1:** Given a task lacks requirement/AC traceability comments or metadata expected from TRD-generated beads, when analysis runs, then it reports a traceability gap.
- **AC-010-2:** Given a story/task lacks acceptance criteria or proof-of-requirement context, when analysis runs, then it reports a missing requirement detail finding.

#### REQ-011: Detect Duplicate or Near-Duplicate Tasks
**Priority:** Should | **Complexity:** Medium

The command identifies likely duplicate tasks for user review.

- **AC-011-1:** Given two tasks have near-identical titles/descriptions in the selected scope, when analysis runs, then they are reported as possible duplicates.
- **AC-011-2:** Given duplicates are reported, when proposed fixes are shown, then the command recommends merge, close, relink, or leave unchanged options rather than auto-closing.

### Approval and Repair Planning

#### REQ-012: Present Consolidated Findings and Proposed Fixes
**Priority:** Must | **Complexity:** Medium

The command presents findings and proposed repairs before editing Beads.

- **AC-012-1:** Given analysis completes, when results are shown, then findings are grouped by issue type with affected bead IDs, severity, proposed `br` commands, and expected graph effect.
- **AC-012-2:** Given no findings are detected, when analysis completes, then the command reports the graph is refinement-ready and suggests `/ensemble:beads-plan` or `/ensemble:beads-build`.

#### REQ-013: Approval-Gated Fix Selection
**Priority:** Must | **Complexity:** Low

Only user-approved fixes are applied.

- **AC-013-1:** Given proposed fixes are shown, when the user approves selected fixes, then only those fixes are applied.
- **AC-013-2:** Given dependency changes are proposed, when the user selects `all`, then dependency changes still require explicit confirmation before any `br dep` command runs.

#### REQ-014: User Resolution for Cycles and Contradictions
**Priority:** Must | **Complexity:** Low

Cycles and contradictory recommendations require user input.

- **AC-014-1:** Given `bv` finds a cycle or contradictory dependency recommendation, when findings are processed, then the command asks the user how to resolve it.
- **AC-014-2:** Given the user does not choose a resolution, when repair planning would continue, then the affected graph change is skipped or blocked rather than guessed.

### Applying Fixes and Recovery

#### REQ-015: Ordered br Repair Plan with Verification
**Priority:** Must | **Complexity:** Medium | [RISK: partial graph updates can leave temporary inconsistent state]

Approved fixes are applied as an ordered `br` repair plan with per-command verification.

- **AC-015-1:** Given fixes are approved, when apply begins, then the command runs `br sync --flush-only`, prints the ordered repair plan, and executes one `br` command at a time.
- **AC-015-2:** Given each `br` command runs, when it exits successfully, then the command verifies the intended bead/dependency state before continuing to the next command.

#### REQ-016: Failure Recovery Options
**Priority:** Must | **Complexity:** Medium

If a `br` update fails halfway through, the command notifies the user and offers recovery choices.

- **AC-016-1:** Given an approved `br` update fails, when the failure is detected, then the command stops applying further fixes and reports the failed command, stderr/stdout summary, and current progress.
- **AC-016-2:** Given a repair command fails, when the user is prompted, then choices include retry failed command, skip failed fix, print/run inverse commands when possible, cancel remaining fixes, or abort.

#### REQ-017: Post-Repair Sync and Graph Revalidation
**Priority:** Should | **Complexity:** Low

After successful repairs, the command syncs and revalidates the graph.

- **AC-017-1:** Given at least one fix succeeds, when repair application completes, then the command runs `br sync --flush-only`.
- **AC-017-2:** Given `bv` is available, when sync completes, then the command re-runs `bv --robot-*` validation and summarizes remaining issues.

### Output and Handoff

#### REQ-018: No Task Execution
**Priority:** Must | **Complexity:** Low

`refine-beads` never executes implementation work.

- **AC-018-1:** Given refinements complete, when the command exits, then it has not started builders, QA agents, reviewers, tests, git branches, or implementation loops.
- **AC-018-2:** Given refinement succeeds, when the final summary is printed, then it suggests `/ensemble:beads-plan` or `/ensemble:beads-build` as next steps.

#### REQ-019: Refinement Summary
**Priority:** Should | **Complexity:** Low

The command prints a concise summary of findings, applied fixes, skipped fixes, failures, and remaining risks.

- **AC-019-1:** Given the command completes, when the final summary is printed, then it includes counts for findings found, fixes approved, fixes applied, fixes skipped, failed fixes, and remaining graph issues.
- **AC-019-2:** Given dependency updates were applied, when the final summary is printed, then it lists each changed dependency edge with source and target bead IDs.

---

## Acceptance Criteria Summary

| REQ | Description | Priority | Complexity | AC Count |
|-----|-------------|----------|------------|----------|
| REQ-001 | Provide refine-beads command | Must | Low | 2 |
| REQ-002 | Scoped epic/release train selection | Must | Medium | 2 |
| REQ-003 | Project scope mode | Should | Low | 2 |
| REQ-004 | Require br and use br for updates | Must | Low | 2 |
| REQ-005 | Use bv robot flags for graph analysis | Must | Low | 2 |
| REQ-006 | Read-only analysis before approval | Must | Low | 2 |
| REQ-007 | Detect dependency graph issues | Must | High | 2 |
| REQ-008 | Detect hierarchy gaps | Must | Medium | 2 |
| REQ-009 | Detect PR boundary/release gaps | Must | Medium | 2 |
| REQ-010 | Detect missing requirements/traceability | Must | Medium | 2 |
| REQ-011 | Detect duplicate tasks | Should | Medium | 2 |
| REQ-012 | Present findings and proposed fixes | Must | Medium | 2 |
| REQ-013 | Approval-gated fix selection | Must | Low | 2 |
| REQ-014 | User resolution for cycles/contradictions | Must | Low | 2 |
| REQ-015 | Ordered br repair plan | Must | Medium | 2 |
| REQ-016 | Failure recovery options | Must | Medium | 2 |
| REQ-017 | Post-repair sync/revalidation | Should | Low | 2 |
| REQ-018 | No task execution | Must | Low | 2 |
| REQ-019 | Refinement summary | Should | Low | 2 |

## Dependency Map

- REQ-002 depends on REQ-001 (scope selection belongs to the command).
- REQ-003 depends on REQ-002 (project scope is an alternate scope mode).
- REQ-004 and REQ-005 are preflight requirements for analysis/update.
- REQ-006 depends on REQ-004/REQ-005 (read-only analysis uses br/bv safely).
- REQ-007 through REQ-011 depend on REQ-006 (findings come from read-only analysis).
- REQ-012 depends on REQ-007 through REQ-011 (findings feed proposed fixes).
- REQ-013 depends on REQ-012 (approval selects fixes).
- REQ-014 modifies REQ-007 and REQ-013 (cycles/contradictions require user resolution).
- REQ-015 depends on REQ-013 (only approved fixes become repair commands).
- REQ-016 depends on REQ-015 (recovery handles failed repair commands).
- REQ-017 depends on REQ-015/REQ-016 (sync/revalidation after changes).
- REQ-018 applies globally to all phases.
- REQ-019 depends on REQ-012 through REQ-017 (summary reports analysis and repair results).

**Implementation clusters:**
- Command/preflight cluster: REQ-001 through REQ-006.
- Detection cluster: REQ-007 through REQ-011.
- Approval/repair cluster: REQ-012 through REQ-017.
- Handoff/output cluster: REQ-018 and REQ-019.

## Technical Dependencies and Constraints

- New command source: `packages/development/commands/refine-beads.yaml`.
- Generated command output: `packages/development/commands/ensemble/refine-beads.md`.
- Required Beads updater: `br`.
- Required graph sidecar for full graph analysis: `bv --robot-*` only; bare `bv` is forbidden.
- Must run `br sync --flush-only` before `bv` analysis and after successful Beads updates.
- Must not start implementation commands, agents, builders, tests, branches, or PR creation.
- Dependencies should map to PR boundaries where PR metadata exists.

## Adversarial Review Resolutions

1. **Approval scope:** analysis is read-only; only approved fixes run `br`; dependency changes always require explicit approval.
2. **Finding taxonomy:** detect cycles, orphans, missing blockers, stale blockers, PR-boundary mismatches, missing traceability/ACs, duplicates, and priority/order mismatches.
3. **Command scope:** default to subtree scope by epic/release-train; project mode allowed with warning; no-arg mode asks user to choose.
4. **Failure recovery:** apply ordered `br` commands one at a time; on failure offer retry, skip, inverse commands, cancel, or abort.
5. **Execution boundary:** never execute tasks; suggest `beads-plan` or `beads-build` after refinement.

## Ambiguity Scan

Ambiguity scan complete: 0 items marked for clarification.

## Implementation Readiness Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Completeness | 4.8 | Covers scope, br/bv usage, graph finding taxonomy, approval, repair, recovery, and handoff. |
| Testability | 4.8 | Every requirement has Given/When/Then ACs and concrete observable outputs. |
| Clarity | 4.8 | Read-only analysis vs approved mutation is explicit; dependency updates require approval. |
| Feasibility | 4.8 | Builds on existing Beads commands and bv robot analysis patterns. |
| **Overall** | **4.8** | **PASS — ready for TRD handoff.** |

## Changelog

### 2026-06-17 — v1.0.1

- Corrected frontmatter requirement count from 16 to 19.
- Recalculated PRD Health summary counts and AC coverage.
- Rewrote AC-005-2 into explicit Given/When/Then format.
- Re-scored Implementation Readiness Gate from 4.75 to 4.8 after structural cleanup.
