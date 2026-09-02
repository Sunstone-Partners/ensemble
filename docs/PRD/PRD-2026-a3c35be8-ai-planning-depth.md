---
document_id: PRD-2026-a3c35be8
label: prd-ai-planning-depth
version: 1.0.0
status: Draft
date: 2026-09-02
scale_depth: STANDARD
total_requirements: 14
readiness_score: 4.40
design_readiness_score: null
---

# PRD-2026-a3c35be8: adhoc-94ba81bd — AI-Driven Planning Depth Auto-Selection

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 11 |
| Should requirements | 3 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 14/14 (100%) |
| Risk flags | 7 |
| Cross-requirement dependencies | 18 |
| [NEEDS CLARIFICATION] markers | 2 |

## Acceptance Criteria Summary

| REQ | Description | Priority | Complexity | AC Count |
|-----|-------------|----------|------------|----------|
| REQ-001 | Analyze Work Description Before Planning | Must | Medium | 2 |
| REQ-002 | Score Complexity on a 1–10 Scale | Must | High | 3 |
| REQ-003 | Evaluate Scope Size Signals | Must | Medium | 2 |
| REQ-004 | Evaluate Dependency Signals | Must | Medium | 2 |
| REQ-005 | Evaluate Risk Signals | Must | Medium | 2 |
| REQ-006 | Evaluate Team-Size Signals | Must | Low | 2 |
| REQ-007 | Map Scores 1–3 to Simple Fix-Issue Path | Must | Low | 2 |
| REQ-008 | Map Scores 4–6 to Medium PRD→TRD Path | Must | Low | 2 |
| REQ-009 | Map Scores 7–10 to Complex Full Pipeline | Must | Medium | 2 |
| REQ-010 | Show Score Before Planning Begins | Must | Low | 2 |
| REQ-011 | Allow Classification Override | Must | Medium | 3 |
| REQ-012 | Provide Deterministic Validation Fixtures | Should | Medium | 2 |
| REQ-013 | Preserve Backward Compatibility and Manual Paths | Should | Medium | 2 |
| REQ-014 | Document Operator-Facing Behavior | Should | Low | 2 |

## Product Summary

**Problem:** Ensemble planning currently depends on a manual complexity classification. Developers and PMs must decide whether work should take a lightweight fix path, a PRD→TRD planning path, or a fuller pipeline with extra review. That manual choice can over-plan small bugs, under-plan risky initiatives, and make Foreman automation depend on caller judgment rather than the work description itself.

**Solution:** Add an AI-driven complexity analysis capability that scores a work description from 1–10 using scope size, dependency count, risk indicators, and team-size signals. The score automatically selects the planning depth before planning begins: 1–3 maps to the Simple fix-issue path, 4–6 maps to the Medium PRD→TRD path, and 7–10 maps to the Complex full pipeline with extra review. The user sees the score, rationale, and selected path, then can override the classification.

**Value proposition:** Planning effort matches actual work complexity with less manual triage, fewer mismatched workflows, and clearer operator confidence before expensive planning starts.

**Foreman mode assumptions auto-applied:**
- STANDARD depth selected because this PRD was created under `--foreman`.
- Primary consumers are Ensemble command users and Foreman automation operators.
- Existing command YAML, generated markdown, and Node/Jest validation patterns should be reused; generated artifacts must be regenerated from source YAML when implementation later changes commands.

## User Analysis

- **Developer:** wants simple work to stay lightweight and avoid PRD/TRD overhead unless risk or scope justifies it.
- **PM / product owner:** wants planning rigor to scale with scope, dependencies, and risk rather than arbitrary manual labels.
- **Foreman operator:** wants non-interactive task dispatch to pick an appropriate workflow path from the task title/description and preserve an auditable rationale.
- **Ensemble maintainer:** needs deterministic tests and docs so the classifier does not become opaque, flaky, or hard to tune.

## Goals and Non-Goals

**Goals:**
- Score work descriptions on a 1–10 complexity scale before planning starts.
- Route planning depth automatically based on Simple, Medium, and Complex bands.
- Show the score, selected path, and rationale before planning begins.
- Allow explicit user or caller override of the AI classification.
- Provide verifiable fixtures proving simple and complex descriptions route correctly.

**Non-Goals:**
- Does not implement the selected downstream work itself.
- Does not replace PRD or TRD quality gates.
- Does not require a new paid service or external hosted classifier.
- Does not optimize team staffing after a TRD already exists; existing TRD task/team complexity analysis remains separate.

## Research and Context

### Existing Codebase

Ensemble is a Node.js monorepo (`package.json`, npm workspaces under `packages/*`) for modular Claude Code / Pi plugin workflows. Commands are authored mostly as YAML under `packages/*/commands/` and generated to markdown through `npm run generate`. Validation uses Node scripts plus Jest/Vitest-style workspace tests. Existing relevant commands include:

- `packages/product/commands/create-prd.yaml`
- `packages/development/commands/create-trd.yaml`
- `packages/development/commands/create-trd-foreman.yaml`
- `packages/development/commands/fix-issue.yaml`

Existing tests already cover TRD task/team complexity classification in `packages/development/tests/auto-team-complexity-analyzer.test.js`; that logic classifies TRDs after task breakdown by task count, domain count, hours, and CLI overrides. This PRD is different: it classifies the initial work description before planning begins.

### Existing PRD Conventions

Recent PRDs use YAML frontmatter, `REQ-NNN` H3 headings, Given/When/Then AC bullets, health summary, dependency map, readiness scorecard, and changelog. This document follows that format.

### Technical Dependencies

- Ensemble command YAML sources under `packages/product/commands/` and `packages/development/commands/`.
- Markdown generation via `npm run generate`.
- Workspace validation via `npm run validate` and targeted Jest tests.
- Existing `fix-issue`, `create-prd`, `create-trd`, and Foreman workflow entrypoints.
- No database, auth, or external API integration is required for v1 unless the later TRD intentionally chooses an existing local LLM/provider abstraction.

## Requirements by Feature Area

### Complexity Analysis Input and Scoring

### REQ-001: Analyze Work Description Before Planning
**Priority:** Must | **Complexity:** Medium | **[RISK: vague or short descriptions can be over-classified or under-classified if missing context is treated as evidence]**

- AC-001-1: Given a user invokes the planning entrypoint with a free-text work description, when planning starts, then the description is analyzed for complexity before any PRD, TRD, or fix workflow is selected.
- AC-001-2: Given the work description is empty or unavailable, when analysis is requested, then the command halts with a clear error rather than guessing a score.

### REQ-002: Score Complexity on a 1–10 Scale
**Priority:** Must | **Complexity:** High | **[RISK: a black-box score without stable criteria will be hard to test and tune]**

- AC-002-1: Given a valid work description, when complexity analysis runs, then it returns an integer score from 1 through 10.
- AC-002-2: Given the analyzer produces a score, when the result is displayed or recorded, then it includes factor-level rationale for scope size, dependencies, risk factors, and team-size signals.
- AC-002-3: Given evidence is insufficient for one factor, when scoring runs, then that factor is marked as uncertain instead of silently assigning a confident value.

### REQ-003: Evaluate Scope Size Signals
**Priority:** Must | **Complexity:** Medium | **[RISK: keyword-only scope detection may misclassify descriptions that use domain language without explicit size words]**

- AC-003-1: Given a work description mentions a small isolated bug or single command behavior, when scoring runs, then the scope-size factor contributes toward a lower complexity score.
- AC-003-2: Given a work description mentions multiple features, workflows, packages, or user roles, when scoring runs, then the scope-size factor contributes toward a higher complexity score.

### REQ-004: Evaluate Dependency Signals
**Priority:** Must | **Complexity:** Medium

- AC-004-1: Given a work description mentions integrations, shared libraries, generated artifacts, Foreman phases, or multiple commands, when scoring runs, then dependency signals are reflected in the rationale.
- AC-004-2: Given no dependencies are detectable, when scoring runs, then the dependency factor is recorded as low or uncertain rather than inventing dependencies.

### REQ-005: Evaluate Risk Signals
**Priority:** Must | **Complexity:** Medium | **[RISK: missing safety/compliance/automation risks can route risky work into a lightweight path]**

- AC-005-1: Given a work description mentions data loss, security, production effects, automation, user-visible workflow changes, or irreversible operations, when scoring runs, then risk signals increase the score or require explicit rationale for not increasing it.
- AC-005-2: Given risk signals are ambiguous, when scoring runs, then the rationale includes an uncertainty note and the output remains overrideable.

### REQ-006: Evaluate Team-Size Signals
**Priority:** Must | **Complexity:** Low

- AC-006-1: Given a work description mentions multiple teams, PM review, QA review, enterprise rollout, or cross-functional ownership, when scoring runs, then team-size signals contribute toward a higher score.
- AC-006-2: Given a work description appears solo-maintainer scoped, when scoring runs, then team-size signals do not independently increase the score.

### Planning Path Selection

### REQ-007: Map Scores 1–3 to Simple Fix-Issue Path
**Priority:** Must | **Complexity:** Low

- AC-007-1: Given a score of 1, 2, or 3, when the routing decision is made, then the selected planning depth is Simple and the recommended path is `fix-issue`.
- AC-007-2: Given a simple bug description is analyzed in validation, when scoring completes, then the score is `<=3` and the selected path is Simple.

### REQ-008: Map Scores 4–6 to Medium PRD→TRD Path
**Priority:** Must | **Complexity:** Low

- AC-008-1: Given a score of 4, 5, or 6, when the routing decision is made, then the selected planning depth is Medium and the recommended path is PRD→TRD.
- AC-008-2: Given a medium-scope feature with moderate dependencies is analyzed, when scoring completes, then the score falls within 4–6 unless explicit risk signals justify Complex.

### REQ-009: Map Scores 7–10 to Complex Full Pipeline
**Priority:** Must | **Complexity:** Medium | **[RISK: full-pipeline semantics may differ by caller if “extra review” is not mapped to concrete commands]**

- AC-009-1: Given a score of 7, 8, 9, or 10, when the routing decision is made, then the selected planning depth is Complex and the recommended path is full pipeline with extra review [NEEDS CLARIFICATION: Should “extra review” mean refine-prd + create-trd + refine-trd before implementation, or a different concrete command sequence?].
- AC-009-2: Given a complex initiative description is analyzed in validation, when scoring completes, then the score is `>=7` and the selected path is Complex.

### REQ-010: Show Score Before Planning Begins
**Priority:** Must | **Complexity:** Low

- AC-010-1: Given complexity analysis completes, when planning continues, then the user or Foreman phase output shows the numeric score, selected depth, selected path, and short rationale before any downstream planning command begins.
- AC-010-2: Given the analyzer is used non-interactively, when a phase report is produced, then the report includes the same score/rationale block for auditability.

### REQ-011: Allow Classification Override
**Priority:** Must | **Complexity:** Medium | **[RISK: override behavior can break automation if interactive prompts are required in Foreman mode]**

- AC-011-1: Given an interactive user sees the score and selected path, when they choose a different path, then their override is used and the output records both the original AI classification and the final selected classification.
- AC-011-2: Given a non-interactive caller provides an explicit override flag or field, when analysis runs, then the override is applied without prompting.
- AC-011-3: Given no override is provided in non-interactive mode, when analysis runs, then the AI-selected classification is used automatically.

### Operability, Validation, and Documentation

### REQ-012: Provide Deterministic Validation Fixtures
**Priority:** Should | **Complexity:** Medium | **[RISK: AI scoring can be nondeterministic unless tests isolate the scoring contract from model prose]**

- AC-012-1: Given a simple bug description fixture, when the test suite evaluates analyzer behavior, then the expected result is score `<=3` and Simple path.
- AC-012-2: Given a complex initiative description fixture, when the test suite evaluates analyzer behavior, then the expected result is score `>=7` and Complex path with extra gates.

### REQ-013: Preserve Backward Compatibility and Manual Paths
**Priority:** Should | **Complexity:** Medium

- AC-013-1: Given an existing command invocation that already explicitly selects `fix-issue`, `create-prd`, or `create-trd`, when the new analyzer exists, then existing behavior remains available and documented.
- AC-013-2: Given a caller disables auto-complexity selection [NEEDS CLARIFICATION: Should the disable control be a global config setting, a command flag, or both?], when planning starts, then the manual classification path is used.

### REQ-014: Document Operator-Facing Behavior
**Priority:** Should | **Complexity:** Low

- AC-014-1: Given the feature is implemented, when generated command markdown or README command help is reviewed, then it explains the scoring scale, path mapping, override mechanism, and non-interactive Foreman behavior.
- AC-014-2: Given source command YAML changes, when implementation is complete, then `npm run generate` has been run so generated artifacts match source.

## Dependency Map

| REQ | Depends On | Notes |
|-----|------------|-------|
| REQ-001 | — | Entry point for analysis |
| REQ-002 | REQ-001 | Score requires valid input |
| REQ-003 | REQ-002 | Scope factor feeds score |
| REQ-004 | REQ-002 | Dependency factor feeds score |
| REQ-005 | REQ-002 | Risk factor feeds score |
| REQ-006 | REQ-002 | Team-size factor feeds score |
| REQ-007 | REQ-002 | Simple route maps score band |
| REQ-008 | REQ-002 | Medium route maps score band |
| REQ-009 | REQ-002 | Complex route maps score band |
| REQ-010 | REQ-007, REQ-008, REQ-009 | Display needs final route |
| REQ-011 | REQ-010 | Override happens after score visibility |
| REQ-012 | REQ-002, REQ-007, REQ-009 | Fixtures verify scoring and routing |
| REQ-013 | REQ-011 | Manual paths depend on override/disable controls |
| REQ-014 | REQ-010, REQ-011, REQ-013 | Docs must explain score, override, compatibility |

**Implementation clusters:** {REQ-001–REQ-006} analyzer contract · {REQ-007–REQ-011} routing and override UX · {REQ-012–REQ-014} validation, compatibility, docs.

No circular dependencies.

## Adversarial Review

Foreman mode auto-applied these resolutions without user interview:

1. **Issue:** “AI analyzes work description” could become opaque. **Resolution:** Require factor-level rationale and deterministic fixtures (REQ-002, REQ-012).
2. **Issue:** Simple/Medium/Complex route bands were defined, but timing was not. **Resolution:** Require analysis before any downstream planning starts (REQ-001, REQ-010).
3. **Issue:** User override could conflict with non-interactive Foreman. **Resolution:** Split interactive override from non-interactive override flag/field behavior (REQ-011).
4. **Issue:** Existing TRD team complexity logic may be confused with this feature. **Resolution:** Explicitly define this as pre-planning classification and mark existing TRD classifier as separate context.
5. **Issue:** “Full pipeline with extra review” is not concrete enough. **Resolution:** Added a clarification marker to force refinement before implementation chooses exact command sequence.
6. **Issue:** Backward compatibility could be lost if auto-analysis becomes mandatory everywhere. **Resolution:** Require manual/disable path preservation (REQ-013).

## Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|-----------|:-:|-------|
| Completeness | 4.4 | Covers input, scoring factors, routing bands, visibility, overrides, validation, compatibility, docs |
| Testability | 4.5 | Every requirement has GWT ACs; simple and complex fixtures are explicit |
| Clarity | 4.2 | Core bands are clear; two markers remain for exact full-pipeline sequence and disable-control shape |
| Feasibility | 4.5 | Fits existing YAML command + Node/Jest + generation patterns; no new infra required |
| **Overall** | **4.40** | **PASS** |

**Gate decision: PASS.** The PRD is ready for TRD handoff, with 2 refinement questions to resolve before implementation.

## Changelog

- **v1.0.0** (2026-09-02) — Initial draft via `ensemble-create-prd --foreman` for Foreman task `adhoc-94ba81bd`.
