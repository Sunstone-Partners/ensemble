---
document_id: PRD-2026-b967cc9e
label: prd-ai-complexity-planning-depth
version: 1.0.0
status: Draft
date: Wed Sep 2 2026 18:46:04 GMT-0500 (Central Daylight Time)
scale_depth: STANDARD
total_requirements: 16
readiness_score: 4.25
---

# PRD-2026-b967cc9e: AI-Driven Complexity Analysis for Adaptive Planning Depth

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 12 |
| Should requirements | 4 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 16/16 (100%) |
| Risk flags | 10 |
| Cross-requirement dependencies | 18 |
| [NEEDS CLARIFICATION] markers | 9 |

Ambiguity scan complete: 9 items marked for clarification.

## Product Summary

**Foreman subject read:** `adhoc-24104290`.

**Problem:** Ensemble currently relies on manual complexity classification before selecting a planning workflow. Developers and PMs must decide whether a work item belongs on a lightweight fix path, a PRD/TRD path, or a full high-review pipeline. That manual classification creates inconsistent planning depth, either under-planning risky work or over-planning simple fixes.

**Solution:** Add an AI-driven complexity-analysis entry point that reads a work description, scores complexity on a 1-10 scale, explains the score, maps it to Simple/Medium/Complex planning depth, shows the result before planning begins, and lets the user override it.

**Value proposition:** Planning effort scales to actual work risk and scope by default, while humans retain control over the final route.

**Primary users:**
- Developer: wants fast, accurate workflow selection without manually classifying every task.
- Product manager / planner: wants planning depth to match scope, dependencies, risks, and team impact.
- Foreman automation operator: wants non-interactive runs to choose predictable routes from task metadata.

**Assumptions auto-applied under `--foreman`:**
- STANDARD PRD depth selected because Foreman mode skips scale interview.
- The first product surface is an Ensemble slash command named `/ensemble:analyze-complexity` [NEEDS CLARIFICATION: Should the command name be exactly `/ensemble:analyze-complexity`, or should adaptive routing be exposed through another command such as `/ensemble:plan`?]
- Complexity is scored from four required dimensions named scope size, dependencies, risk factors, and team size.
- Medium route means PRD then TRD creation, with implementation requiring later approval [NEEDS CLARIFICATION: Should the Medium route stop after TRD creation, or continue into `implement-trd` only after an explicit approval gate?]
- Complex route means full PRD/refine/TRD/refine flow with extra review before implementation [NEEDS CLARIFICATION: Which exact command sequence constitutes the Complex “full pipeline with extra review”?]

**Non-goals (v1):**
- No implementation of the selected route in this PRD creation phase.
- No model fine-tuning or external paid classifier service.
- No replacement of existing direct commands such as `/ensemble:create-prd`, `/ensemble:create-trd`, or `/ensemble:fix-issue`.
- No automatic override of an explicit user-selected route.

## Research and Context

### Codebase Reconnaissance

Ensemble is a Node.js 20+ monorepo for modular Claude Code plugins. Planning and implementation workflows live under `packages/product/commands` and `packages/development/commands`. Generated markdown under `commands/ensemble/*.md` is produced from YAML sources, so future implementation should edit YAML command sources and run the repository generation/validation flow.

Relevant existing surfaces:
- `packages/product/commands/create-prd.yaml`: PRD creation command, including Foreman subject contract and readiness gate behavior.
- `packages/development/commands/create-trd.yaml`: TRD generation command with existing complexity/team-analysis concepts.
- `packages/development/commands/fix-issue.yaml`: lightweight fix workflow suitable for Simple route.
- `packages/development/tests/auto-team-complexity-analyzer.test.js`: precedent for deterministic classification tests around Simple/Medium/Complex tiers.

### Existing PRD Conventions

Recent PRDs use YAML frontmatter, `PRD-YYYY-<micro_uuid>` document IDs, `prd-<stem>` labels, a PRD Health Summary, grouped REQ headings, Given/When/Then acceptance criteria, dependency maps, and readiness scorecards. This PRD follows that convention.

### Technical Dependency Mapping

- Command definitions: `packages/product/commands/*.yaml`, `packages/development/commands/*.yaml`, and generated `commands/ensemble/*.md`.
- Existing route commands: `/ensemble:fix-issue`, `/ensemble:create-prd`, `/ensemble:create-trd`, `/ensemble:refine-prd`, `/ensemble:refine-trd`, implementation commands.
- Existing validation: `npm run generate`, `npm run validate`, and Jest command tests.
- Foreman integration: `FOREMAN_TASK_TITLE`, `FOREMAN_TASK_DESCRIPTION`, `FOREMAN_SOURCE_PRD_PATH`, and non-interactive command semantics.

## Requirements by Feature Area

### Complexity Analysis Entry Point

### REQ-001: Analyze Complexity Command
**Priority:** Must | **Complexity:** Medium | **[RISK: a new command surface can drift from existing generated-command conventions if YAML and markdown are not kept in sync]**

The product must provide an AI-driven complexity-analysis entry point that accepts a work description and produces a route recommendation before planning begins.

- AC-001-1: Given a user provides a work description, when they invoke the complexity analyzer, then the analyzer returns a 1-10 score, a Simple/Medium/Complex label, confidence, rationale, and recommended route before any downstream planning document is created.
- AC-001-2: Given no work description is available from arguments or Foreman task metadata, when the analyzer is invoked, then it halts with a missing-subject error and creates no PRD, TRD, fix branch, or implementation artifact.

### REQ-002: Foreman and Interactive Input Contract
**Priority:** Must | **Complexity:** Medium | **[RISK: reading repository context instead of Foreman task metadata could create plausible but wrong automation outputs]**

The analyzer must honor Foreman task metadata when running under Foreman and normal command arguments otherwise.

- AC-002-1: Given `--foreman` is set and `FOREMAN_TASK_TITLE` is non-empty, when analysis starts, then the analyzer treats `FOREMAN_TASK_TITLE` as the subject and `FOREMAN_TASK_DESCRIPTION` as the work description.
- AC-002-2: Given `--foreman` is set and neither task metadata nor explicit arguments provide a subject, when analysis starts, then it halts rather than inferring a subject from repository files, git history, or prior PRDs.
- AC-002-3: Given normal interactive usage, when the user passes a work description as arguments, then the analyzer uses those arguments without requiring the user to repeat the description.

### REQ-003: Multi-Factor Score Rubric
**Priority:** Must | **Complexity:** High | **[RISK: opaque or inconsistent scoring will erode trust and make route changes hard to debug]**

The analyzer must score work on scope size, dependency count, risk factors, and team size, producing a single 1-10 score.

- AC-003-1: Given a work description with small single-file scope, no external dependencies, low risk, and one-person ownership, when scored, then the result is in the Simple range unless other evidence raises the score.
- AC-003-2: Given a work description with cross-cutting changes, multiple dependencies, user-facing risk, or multi-team ownership, when scored, then each factor contributing to the elevated score is listed in the rationale.
- AC-003-3: Given a score is emitted, when the user reads the output, then they can see each dimension's sub-score or qualitative level [NEEDS CLARIFICATION: Should each factor expose numeric sub-scores, qualitative labels, or both?]

### REQ-004: Score Bands and Route Mapping
**Priority:** Must | **Complexity:** Medium | **[RISK: route thresholds could under-plan borderline work if they are too rigid]**

The product must map score bands to planning routes.

- AC-004-1: Given score 1-3, when route mapping runs, then the recommended route is Simple and points to the lightweight `fix-issue` path.
- AC-004-2: Given score 4-6, when route mapping runs, then the recommended route is Medium and points to PRD then TRD planning.
- AC-004-3: Given score 7-10, when route mapping runs, then the recommended route is Complex and points to the full pipeline with extra review.
- AC-004-4: Given a score is exactly on a boundary such as 3, 4, 6, or 7, when mapping runs, then the output uses the documented inclusive bands 1-3, 4-6, and 7-10.

### REQ-005: Confidence and Low-Confidence Handling
**Priority:** Must | **Complexity:** Medium | **[RISK: low-confidence auto-routing can create costly planning churn or unsafe under-planning]**

The analyzer must report confidence and avoid silently routing when evidence is weak.

- AC-005-1: Given the work description lacks enough detail to score at least two required dimensions, when analysis completes, then the output flags low confidence and lists missing details.
- AC-005-2: Given low confidence in interactive mode, when the analyzer presents a recommendation, then it asks for clarification or explicit confirmation before executing downstream planning.
- AC-005-3: Given low confidence in Foreman mode, when the analyzer cannot ask questions, then it chooses the safer higher-depth route between the plausible candidates [NEEDS CLARIFICATION: Should Foreman low-confidence handling always choose the higher route, or halt for missing detail?]

### Planning Depth Presentation and Control

### REQ-006: Pre-Planning Disclosure
**Priority:** Must | **Complexity:** Low

The complexity decision must be shown before the selected planning route begins.

- AC-006-1: Given analysis completed successfully, when the command is about to start any downstream planning step, then it prints the score, route, confidence, and top rationale bullets first.
- AC-006-2: Given the user sees the disclosure in interactive mode, when they do not confirm or override, then no downstream planning side effect occurs.

### REQ-007: User Override
**Priority:** Must | **Complexity:** Medium | **[RISK: override syntax ambiguity can cause users to believe they selected a route when the command used another]**

Users must be able to override the AI classification.

- AC-007-1: Given a user supplies an explicit override flag, when analysis completes, then the selected route follows the override while still recording the AI-recommended route.
- AC-007-2: Given interactive mode and a displayed recommendation, when the user chooses a different route, then the command proceeds with the user's selected route and notes that it was human-overridden.
- AC-007-3: Given invalid override input, when route selection runs, then the command rejects it with valid choices listed and performs no downstream side effects [NEEDS CLARIFICATION: Should override choices be `simple|medium|complex`, direct command names, or both?]

### REQ-008: Configurable Disable Controls
**Priority:** Should | **Complexity:** Medium | **[RISK: teams may need deterministic legacy behavior for CI or audited workflows]**

Teams should be able to disable adaptive classification globally or per invocation.

- AC-008-1: Given adaptive classification is disabled in configuration, when a user invokes an existing direct command, then existing behavior remains unchanged.
- AC-008-2: Given a per-invocation disable flag is present, when both config and flag could apply, then the invocation flag takes precedence [NEEDS CLARIFICATION: What exact config key and command flag names should control disable behavior?]

### REQ-009: Backward Compatibility for Existing Commands
**Priority:** Must | **Complexity:** Low

Existing direct planning and implementation commands must continue to work without adaptive routing.

- AC-009-1: Given a user invokes `/ensemble:create-prd` directly with its current arguments, when the command runs, then it uses existing PRD behavior rather than requiring complexity analysis first.
- AC-009-2: Given a user invokes `/ensemble:fix-issue` directly, when the command runs, then it follows its current lightweight workflow unless the user explicitly opts into adaptive routing.

### REQ-010: Route Execution Contract
**Priority:** Must | **Complexity:** High | **[RISK: automatically invoking downstream commands can violate approval gates if route boundaries are unclear]**

The adaptive route must define which downstream commands can run and where it must stop for approval.

- AC-010-1: Given Simple route is selected, when execution begins, then it invokes or instructs the lightweight fix workflow with the original work description preserved.
- AC-010-2: Given Medium route is selected, when execution begins, then it creates PRD/TRD planning artifacts only and stops before implementation unless explicit approval is provided.
- AC-010-3: Given Complex route is selected, when execution begins, then it includes extra review/refinement gates before implementation and records each gate's outcome.
- AC-010-4: Given any route is selected, when the first downstream command receives input, then it receives the original user/Foreman subject and description without rewriting meaning.

### REQ-011: Explainability and Audit Trail
**Priority:** Should | **Complexity:** Medium | **[RISK: users cannot improve or challenge the classifier if only the final route is visible]**

The analyzer should leave a concise audit trail of the decision.

- AC-011-1: Given a route recommendation is produced, when the command exits successfully, then the final output includes score, band, confidence, override status, and rationale.
- AC-011-2: Given Foreman mode is active, when a route is selected, then the phase report or console output includes the same classification details for later run inspection [NEEDS CLARIFICATION: Should the classification be written to a dedicated machine-readable artifact in Foreman runs?]

### Quality, Tests, and Operations

### REQ-012: Test Fixture Coverage
**Priority:** Must | **Complexity:** Medium

The feature must include repeatable tests for scoring, boundaries, overrides, and route mapping.

- AC-012-1: Given a simple bug description fixture, when tests run, then the analyzer scores it ≤3 and maps it to Simple / `fix-issue`.
- AC-012-2: Given a complex initiative description fixture, when tests run, then the analyzer scores it ≥7 and maps it to Complex / full pipeline with extra gates.
- AC-012-3: Given boundary score fixtures for 3, 4, 6, and 7, when tests run, then mappings match the documented bands.
- AC-012-4: Given an explicit override fixture, when tests run, then the selected route equals the override and the recommended route is still preserved.

### REQ-013: Deterministic Fallback Behavior
**Priority:** Must | **Complexity:** Medium | **[RISK: model variance can make the same task route differently across runs]**

The analyzer must minimize surprise from repeated scoring.

- AC-013-1: Given the same work description and same configuration, when analysis is repeated, then the output should remain in the same route band unless the model returns materially different rationale.
- AC-013-2: Given AI analysis fails or returns malformed output, when fallback runs, then the command either applies a conservative deterministic heuristic or halts safely with no downstream side effects [NEEDS CLARIFICATION: Should the fallback heuristic exist in v1, or should AI failure always halt?]

### REQ-014: Integration with Existing Generation Workflow
**Priority:** Must | **Complexity:** Low

Future implementation must respect Ensemble's source/generated artifact workflow.

- AC-014-1: Given command behavior is changed, when the source is edited, then YAML command sources are updated rather than hand-editing generated markdown only.
- AC-014-2: Given generated command artifacts are required, when validation runs, then `npm run generate` and `npm run validate` succeed.

### REQ-015: Security and Data Handling
**Priority:** Must | **Complexity:** Low

The analyzer must not leak secrets or require sensitive data in work descriptions.

- AC-015-1: Given a work description contains likely secrets or tokens, when analysis runs, then the analyzer does not echo secret values in rationale or audit output.
- AC-015-2: Given the analyzer needs additional detail, when it asks for clarification, then it asks for non-secret structural details such as impacted systems, users, or risk rather than credentials.

### REQ-016: Documentation
**Priority:** Should | **Complexity:** Low

Users should understand when adaptive planning is used and how to override it.

- AC-016-1: Given the feature ships, when a user reads command help or repository docs, then they can see the score bands, selected routes, override controls, and disable controls.
- AC-016-2: Given a Foreman operator reads docs, when they configure an automated run, then they can see how Foreman task title/description are used by the analyzer.

## Dependency Map

| REQ | Depends On | Notes |
|-----|-----------|-------|
| REQ-001 | — | Entry point for the adaptive flow |
| REQ-002 | REQ-001 | Input contract required before scoring |
| REQ-003 | REQ-002 | Scoring needs normalized input |
| REQ-004 | REQ-003 | Route mapping depends on score |
| REQ-005 | REQ-003, REQ-004 | Confidence qualifies selected route |
| REQ-006 | REQ-004, REQ-005 | Disclosure presents route and confidence |
| REQ-007 | REQ-006 | Override happens after recommendation visibility |
| REQ-008 | REQ-001 | Disable controls wrap entry behavior |
| REQ-009 | REQ-008 | Backward compatibility requires opt-in/disable clarity |
| REQ-010 | REQ-004, REQ-007, REQ-009 | Execution needs selected route and compatibility boundaries |
| REQ-011 | REQ-003, REQ-004, REQ-007 | Audit records recommendation and override state |
| REQ-012 | REQ-003, REQ-004, REQ-007, REQ-013 | Tests cover classifier, bands, overrides, fallback |
| REQ-013 | REQ-003, REQ-005 | Fallback depends on scoring/confidence semantics |
| REQ-014 | REQ-010, REQ-012 | Source/generated workflow validates implementation |
| REQ-015 | REQ-002, REQ-011 | Sensitive input affects rationale/audit output |
| REQ-016 | REQ-004, REQ-007, REQ-008, REQ-011 | Docs need route, controls, and audit semantics |

**Implementation clusters:** {REQ-001, REQ-002} entry/input contract · {REQ-003, REQ-004, REQ-005, REQ-013} classifier/routing engine · {REQ-006, REQ-007, REQ-008, REQ-009, REQ-010} user control and route execution · {REQ-011, REQ-015, REQ-016} explainability, safety, docs · {REQ-012, REQ-014} validation and generated-artifact workflow.

No circular dependencies identified.

## Adversarial Review

| Issue | Category | Resolution |
|-------|----------|------------|
| Command name is not specified by the task. | Ambiguity | Auto-assumed `/ensemble:analyze-complexity` and marked for clarification. |
| Medium and Complex routes could accidentally cross into implementation. | Approval boundary | Added REQ-010 with explicit stop-before-implementation behavior. |
| AI scoring may be non-deterministic. | Missing edge case | Added REQ-013 deterministic fallback behavior and tests in REQ-012. |
| User override syntax is unspecified. | Ambiguity | Added REQ-007 and clarification marker for accepted override forms. |
| Foreman low-confidence behavior cannot ask questions. | Automation risk | Added REQ-005 with conservative higher-route default plus clarification marker. |
| Secrets could be echoed in classifier rationale. | Security gap | Added REQ-015 for secret-safe output. |
| Existing direct commands must not be forced through adaptive routing. | Backward compatibility | Added REQ-008 and REQ-009. |

All recommended resolutions above were auto-applied under Foreman mode; unresolved policy choices were marked inline with `[NEEDS CLARIFICATION]` markers.

## Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|-----------|:-:|-------|
| Completeness | 4.3 | Covers command surface, scoring, route bands, Foreman input, overrides, compatibility, tests, docs, and security. Exact command/config names remain open. |
| Testability | 4.6 | Every Must/Should requirement has Given/When/Then ACs, including supplied verification examples and boundary cases. |
| Clarity | 3.9 | Core behavior is clear, but route command sequence, override syntax, and artifact format need refinement. |
| Feasibility | 4.2 | Fits existing Node/YAML command architecture and can reuse existing command/test patterns. Main risk is AI output determinism. |
| **Overall** | **4.25** | **PASS** |

**Gate decision: PASS.** The PRD is ready for `/ensemble:refine-prd` to resolve the 9 clarification markers before TRD creation.

## Suggested Next Step

`/ensemble:refine-prd docs/PRD/PRD-2026-b967cc9e-ai-complexity-planning-depth.md`
