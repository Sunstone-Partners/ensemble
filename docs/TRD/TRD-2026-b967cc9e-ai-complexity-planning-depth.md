---
document_id: TRD-2026-b967cc9e
label: trd-ai-complexity-planning-depth
prd_reference: docs/PRD/PRD-2026-b967cc9e-ai-complexity-planning-depth.md
version: 1.0.1
status: Draft
date: Wed Sep 2 2026 19:08:00 GMT-0500 (Central Daylight Time)
design_readiness_score: 4.8
kind: trd
---

# TRD-2026-b967cc9e: AI-Driven Complexity Analysis for Adaptive Planning Depth

**Foreman subject read:** `adhoc-24104290`

## Source PRD

- PRD: `docs/PRD/PRD-2026-b967cc9e-ai-complexity-planning-depth.md`
- PRD Document ID: `PRD-2026-b967cc9e`
- PRD Label: `prd-ai-complexity-planning-depth`
- PRD Readiness Score: 4.75 PASS
- Task Description: `Implement AI-driven complexity analysis that auto-adjusts Ensemble planning depth`

## PRD Validation Summary

| Check | Result | Notes |
|-------|--------|-------|
| Required sections | PASS | Product Summary, Research and Context, Requirements, Dependency Map, Adversarial Review, Readiness Scorecard present. |
| REQ numbering | PASS | REQ-001 through REQ-016 are sequential and unique. |
| Acceptance criteria | PASS | All requirements include Given/When/Then ACs. |
| Constraints and non-goals | PASS | Approval boundaries, no replacement of direct commands, and secret-safe behavior documented. |
| Readiness gate | PASS | Score 4.75 >= 4.0. |

## Domain Analysis

| Domain | Requirements | Design Implication |
|--------|--------------|--------------------|
| Command surface | REQ-001, REQ-002, REQ-006, REQ-007, REQ-010 | Add a new opt-in `/ensemble:analyze-complexity` YAML command and generated markdown. |
| Classification engine | REQ-003, REQ-004, REQ-005, REQ-013 | Add deterministic parsing, scoring, route mapping, confidence, and fallback helpers. |
| Foreman integration | REQ-002, REQ-005, REQ-010, REQ-011 | Read task metadata, preserve original subject/description, write phase and sidecar artifacts. |
| Configuration | REQ-008, REQ-009 | Add `adaptive_planning.enabled` lookup and `--no-adaptive-planning` invocation override. |
| Security | REQ-015 | Redact likely secrets before rationale/audit output. |
| Testing and docs | REQ-012, REQ-014, REQ-016 | Add Jest coverage, generate markdown, validate command schema/docs. |

**Companion domains:** none. No persistence schema or external technology comparison is required.

**Brownfield status:** brownfield. Existing command definitions, generated command docs, validation scripts, and Jest tests already exist.

## Capability Reuse Check

`node packages/development/lib/trd-graph-cli.js capabilities docs/TRD --json` returned an empty reusable foundational capability registry. No cross-TRD dependencies are required.

## Reused Capabilities

None.

## Architecture Alternatives

### Option A: Command-only Prompt Logic

- **Approach:** Put classification rubric, route mapping, and fallback instructions entirely in the new YAML command prose.
- **Pros:** Fastest to add; minimal code.
- **Cons:** Hard to test deterministically; higher drift risk; weak boundary/override validation.
- **Complexity impact:** Low initial effort, higher maintenance risk.
- **Risk profile:** Medium-high due to opaque scoring and poor unit-test leverage.

### Option B: Full Routing Orchestrator

- **Approach:** Build a JS CLI that performs scoring, command dispatch, artifact writes, and route orchestration end to end.
- **Pros:** Strong testability and deterministic behavior; clean machine-readable artifacts.
- **Cons:** More up-front surface area; risks duplicating existing command orchestration semantics.
- **Complexity impact:** High.
- **Risk profile:** Medium; biggest risk is overbuilding v1.

### Option C: Brownfield Command + Shared Helper CLI (Selected)

- **Approach:** Add the new YAML command as the user/Foreman entry point, backed by a small JS helper module/CLI for deterministic scoring, route mapping, redaction, config disable checks, and JSON sidecar generation. Let existing route commands remain owners of PRD/TRD/fix behavior.
- **Pros:** Testable core logic; preserves existing direct command behavior; small command surface; clear Foreman artifact contract.
- **Cons:** Requires source/generated sync and careful handoff to downstream commands.
- **Complexity impact:** Medium.
- **Risk profile:** Low-medium; matches current repo conventions.

**Foreman mode: auto-selected Option C (brownfield command backed by shared deterministic helper CLI).**

## Architecture Decision

Implement adaptive planning as a new opt-in command surface, `/ensemble:analyze-complexity`, with source command YAML at `packages/development/commands/analyze-complexity.yaml`, generated markdown from `npm run generate`, and deterministic helper code at `packages/development/lib/complexity-analyzer.js`. Existing route commands remain downstream owners of PRD/TRD/fix behavior; the analyzer prepares a dispatch plan and never bypasses approval boundaries.

### Rationale

- Existing direct commands must remain backward compatible.
- The scoring rubric, boundary bands, overrides, and fallback behavior need unit tests.
- Foreman requires non-interactive metadata handling and exact artifact writes.
- A helper CLI enables repeatable JSON fixtures without forcing downstream implementation in this planning TRD.
- Placing the command in `packages/development/commands/` matches the existing planning and fix workflow ownership (`create-trd`, `refine-trd`, and `fix-issue`).

## System Architecture

### Components

| Component | Responsibility | Interfaces |
|-----------|----------------|------------|
| `packages/development/commands/analyze-complexity.yaml` command source | User and Foreman workflow entry point; validates inputs; prints disclosure; selects route. | Command args, `--route`, `--no-adaptive-planning`, `--foreman`, Foreman env vars. |
| `packages/development/lib/complexity-analyzer.js` helper | Normalizes task metadata, computes dimension scores, final score, confidence, route band, fallback decision, and redacted rationale. | JS functions plus CLI mode: `node packages/development/lib/complexity-analyzer.js analyze --json`. |
| Config resolver | Reads Ensemble config and applies invocation precedence. | `adaptive_planning.enabled`, command flags. |
| Route dispatcher plan | Emits the downstream command sequence and approval stop state without changing direct command behavior. | `/ensemble:fix-issue`, `/ensemble:create-prd`, `/ensemble:create-trd`, `/ensemble:refine-prd`, `/ensemble:refine-trd`. |
| Foreman artifact writer | Writes human-readable phase report and machine-readable classification sidecar. | `FOREMAN_ARTIFACT_PATH`, `<FOREMAN_ARTIFACT_PATH basename>.classification.json`, original subject/description metadata. |
| Tests | Verifies scoring, boundaries, overrides, fallback, redaction, and generated artifact sync. | Jest fixtures and command validation scripts. |
| Docs/help | Documents score bands, route controls, disable controls, and Foreman metadata behavior. | README or command help generated from YAML. |

### Data Flow

1. Command receives args or Foreman env metadata.
2. Input normalizer selects subject/description and halts if neither is present.
3. Secret redactor creates safe display/rationale text without mutating downstream original subject/description.
4. Config resolver decides whether adaptive planning is enabled.
5. Analyzer computes four sub-scores: scope size, dependencies, risk factors, team size.
6. Route mapper converts final score to Simple, Medium, or Complex with documented inclusive bands.
7. Override resolver applies `--route simple|medium|complex` or interactive override, while preserving AI recommendation.
8. Disclosure prints score, route, confidence, override status, and rationale before downstream side effects.
9. Foreman mode writes classification details to the phase report and sidecar artifact.
10. Selected route hands original subject/description to existing commands and stops at the PRD/TRD approval boundaries required by the PRD.

### Interfaces and Data Formats

- Analyzer output JSON:

```json
{
  "subject": "string",
  "descriptionPresent": true,
  "score": 6,
  "band": "medium",
  "confidence": "high|medium|low",
  "selectedRoute": "simple|medium|complex",
  "recommendedRoute": "simple|medium|complex",
  "override": { "applied": false, "source": null },
  "dimensions": {
    "scopeSize": { "score": 1, "label": "low", "evidence": [] },
    "dependencies": { "score": 1, "label": "low", "evidence": [] },
    "riskFactors": { "score": 1, "label": "low", "evidence": [] },
    "teamSize": { "score": 1, "label": "low", "evidence": [] }
  },
  "missingDetails": [],
  "rationale": [],
  "redactions": []
}
```

- Override values: only `simple`, `medium`, `complex`.
- Score bands: 1-3 Simple, 4-6 Medium, 7-10 Complex.
- Foreman subject source: `FOREMAN_TASK_TITLE` and `FOREMAN_TASK_DESCRIPTION`.
- Sidecar artifact: JSON adjacent to `FOREMAN_ARTIFACT_PATH` using the same basename plus `.classification.json` (example: `phase-4.md` -> `phase-4.classification.json`).

### Generated Artifact Boundary

Command implementation edits start in `packages/development/commands/analyze-complexity.yaml`. Generated markdown must be refreshed with `npm run generate` and validated with `npm run validate`; generated files are not hand-edited. Helper logic and fixtures live under `packages/development/lib/` and `packages/development/tests/` so deterministic behavior is covered outside prompt prose.

### Failure Handling

- Missing subject/description: halt with no route side effects.
- Invalid override: halt with valid choices.
- Analyzer model/malformed output: run deterministic heuristic if enough non-secret structural detail exists; otherwise halt safely.
- Low confidence interactive: ask for clarification or confirmation before executing route.
- Low confidence Foreman: select safer higher-depth plausible route and record missing details.
- Secret-like input: redact in rationale/audit output; preserve original description only for downstream command handoff where required.

### Architecture Diagram Description

User/Foreman input flows into `/ensemble:analyze-complexity`, then into input normalization and redaction. The normalized work item flows into `complexity-analyzer.js`, which emits JSON scoring. Config and override resolution combine with the recommendation to select a route. Disclosure and artifacts are emitted before the route dispatcher calls existing planning/fix commands. Existing commands remain downstream owners of PRD/TRD/fix outputs.

## Master Task List

### PR 1: Analyzer Command Skeleton and Input Contract
**Shippable State:** Users and Foreman runs can invoke `/ensemble:analyze-complexity` and receive validated missing-input or normalized-input disclosure without route side effects.

- [ ] **TRD-001**: Add `packages/development/commands/analyze-complexity.yaml` for `/ensemble:analyze-complexity` with args, `--foreman`, `--route`, and `--no-adaptive-planning` parameters (3h) [satisfies REQ-001, REQ-002, REQ-006, REQ-014]
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-002-3, AC-006-1, AC-014-1
  - Implementation ACs:
    - Given a description argument is present, when the command starts, then it identifies the argument as the work description before creating downstream artifacts.
    - Given `--foreman` and `FOREMAN_TASK_TITLE` are present, when the command starts, then it prints the Foreman subject before scoring.
    - Given no subject is available, when the command starts, then it halts with no route side effects.
- [ ] **TRD-001-TEST**: Add command input-contract tests for normal args, Foreman metadata, and missing-subject halt behavior (2h) [verifies TRD-001] [satisfies REQ-001, REQ-002, REQ-006, REQ-012] [depends: TRD-001]
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-002-3, AC-006-1, AC-012-1
  - Implementation ACs:
    - Given no work description exists, when tests execute the command fixture, then no downstream command marker is emitted.
    - Given Foreman env vars exist, when tests execute the fixture, then title and description are selected over repository context.

- [ ] **TRD-002**: Implement input normalization that preserves original subject/description and selects Foreman metadata only under Foreman mode (3h) [satisfies REQ-002, REQ-010]
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-010-4
  - Implementation ACs:
    - Given both command args and Foreman metadata exist under `--foreman`, when normalization runs, then Foreman metadata wins.
    - Given interactive args exist without Foreman mode, when normalization runs, then args are used unchanged.
- [ ] **TRD-002-TEST**: Add unit tests for normalization precedence and original-description preservation (2h) [verifies TRD-002] [satisfies REQ-002, REQ-010, REQ-012] [depends: TRD-002]
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-002-3, AC-010-4, AC-012-4
  - Implementation ACs:
    - Given mixed input sources, when the helper is called, then selected source and original values match expected fixtures.
    - Given a selected route dispatch payload is created, then it contains the original non-redacted description.

### PR 2: Deterministic Scoring and Route Mapping
**Shippable State:** Users can see a scored Simple/Medium/Complex recommendation with dimension detail and boundary-correct route mapping.

- [ ] **TRD-003**: Add `packages/development/lib/complexity-analyzer.js` scoring helpers for scope size, dependencies, risk factors, and team size (5h) [satisfies REQ-003, REQ-005, REQ-013]
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-003-3, AC-005-1, AC-013-1
  - Implementation ACs:
    - Given a single-file low-risk description, when scored, then all dimensions include numeric score, label, and evidence.
    - Given cross-cutting or risky text, when scored, then each elevated dimension lists concrete evidence.
- [ ] **TRD-003-TEST**: Add unit fixtures for low, medium, and high complexity dimension scoring (3h) [verifies TRD-003] [satisfies REQ-003, REQ-005, REQ-012, REQ-013] [depends: TRD-003]
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-003-3, AC-005-1, AC-012-1, AC-012-2, AC-013-1
  - Implementation ACs:
    - Given fixture text for simple, medium, and complex work, when tests score it, then expected score ranges and evidence fields are present.
    - Given repeated scoring of the same fixture, then the route band is stable.

- [ ] **TRD-004**: Implement inclusive score-band route mapping for Simple 1-3, Medium 4-6, and Complex 7-10 (2h) [satisfies REQ-004, REQ-010]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-004-3, AC-004-4, AC-010-1, AC-010-2, AC-010-3
  - Implementation ACs:
    - Given scores 1 through 10, when mapping runs, then every score maps to exactly one documented route.
    - Given scores 3, 4, 6, and 7, when mapping runs, then boundary mappings match the PRD.
- [ ] **TRD-004-TEST**: Add boundary route-mapping tests for scores 3, 4, 6, and 7 (2h) [verifies TRD-004] [satisfies REQ-004, REQ-012] [depends: TRD-004]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-004-3, AC-004-4, AC-012-3
  - Implementation ACs:
    - Given boundary fixtures, when the mapping helper is called, then returned routes are Simple, Medium, Medium, and Complex respectively.

- [ ] **TRD-005**: Implement confidence detection and deterministic fallback for weak or malformed AI scoring output (5h) [satisfies REQ-005, REQ-013]
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-005-3, AC-013-2
  - Implementation ACs:
    - Given fewer than two scoreable dimensions, when analysis completes, then confidence is low and missing details are listed.
    - Given malformed AI output and enough structural detail, when fallback runs, then a conservative route is selected and marked as fallback.
    - Given malformed output and insufficient detail, when fallback runs, then it halts safely.
- [ ] **TRD-005-TEST**: Add low-confidence and fallback tests for interactive and Foreman modes (3h) [verifies TRD-005] [satisfies REQ-005, REQ-012, REQ-013] [depends: TRD-005]
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-005-3, AC-012-2, AC-013-2
  - Implementation ACs:
    - Given low-confidence interactive input, when tested, then the command requires confirmation or clarification before dispatch.
    - Given low-confidence Foreman input with plausible routes, when tested, then the selected route is the safer higher-depth route.

### PR 3: User Control, Config, and Backward Compatibility
**Shippable State:** Users can override or disable adaptive routing, and existing direct commands continue to work unchanged.

- [ ] **TRD-006**: Add pre-planning disclosure output before any route execution begins (2h) [satisfies REQ-006, REQ-011]
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-011-1
  - Implementation ACs:
    - Given a successful recommendation, when command output is rendered, then score, route, confidence, and top rationale appear before dispatch text.
    - Given interactive mode without confirmation or override, when disclosure is shown, then no route side effect occurs.
- [ ] **TRD-006-TEST**: Add output-order tests proving disclosure precedes dispatch markers (2h) [verifies TRD-006] [satisfies REQ-006, REQ-011, REQ-012] [depends: TRD-006]
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-011-1
  - Implementation ACs:
    - Given a captured command transcript, when assertions run, then disclosure text indexes before route invocation text.

- [ ] **TRD-007**: Implement route override validation and selection for `--route simple|medium|complex` plus interactive override recording (3h) [satisfies REQ-007, REQ-010, REQ-011]
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3, AC-010-4, AC-011-1
  - Implementation ACs:
    - Given a valid override, when route selection runs, then selected route equals the override and recommended route is preserved.
    - Given an invalid override, when route selection runs, then the command lists valid choices and performs no route side effect.
- [ ] **TRD-007-TEST**: Add override tests for valid, invalid, and recommended-route preservation cases (2h) [verifies TRD-007] [satisfies REQ-007, REQ-012] [depends: TRD-007]
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3, AC-012-4
  - Implementation ACs:
    - Given override fixtures, when tests run, then selected and recommended routes match expected values and invalid input halts.

- [ ] **TRD-008**: Add adaptive-planning disable resolution with config lookup and `--no-adaptive-planning` precedence (3h) [satisfies REQ-008, REQ-009]
  - Validates PRD ACs: AC-008-1, AC-008-2, AC-009-1, AC-009-2
  - Implementation ACs:
    - Given config disables adaptive planning, when an existing direct command is invoked, then no analyzer requirement is introduced.
    - Given `--no-adaptive-planning`, when config enables adaptive planning, then the invocation flag wins.
- [ ] **TRD-008-TEST**: Add config precedence and direct-command compatibility tests (2h) [verifies TRD-008] [satisfies REQ-008, REQ-009, REQ-012] [depends: TRD-008]
  - Validates PRD ACs: AC-008-1, AC-008-2, AC-009-1, AC-009-2
  - Implementation ACs:
    - Given direct command fixtures, when tests run, then existing command behavior snapshots are unchanged.
    - Given conflicting config and flag fixtures, then the flag result is selected.

### PR 4: Route Dispatch and Foreman Audit Artifacts
**Shippable State:** Selected routes receive preserved work metadata and Foreman runs record human-readable and machine-readable classification artifacts.

- [ ] **TRD-009**: Implement route dispatch contract for Simple, Medium, and Complex routes while preserving approval stop points (4h) [satisfies REQ-010]
  - Validates PRD ACs: AC-010-1, AC-010-2, AC-010-3, AC-010-4
  - Implementation ACs:
    - Given Simple route selection, when dispatch is prepared, then it targets `/ensemble:fix-issue` with the original work description.
    - Given Medium route selection, when dispatch is prepared, then it creates PRD/TRD planning artifacts only and stops before implementation.
    - Given Complex route selection, when dispatch is prepared, then it includes refine/review gates before implementation approval.
- [ ] **TRD-009-TEST**: Add dispatch-plan tests for Simple, Medium, and Complex route stop points (3h) [verifies TRD-009] [satisfies REQ-010, REQ-012] [depends: TRD-009]
  - Validates PRD ACs: AC-010-1, AC-010-2, AC-010-3, AC-010-4
  - Implementation ACs:
    - Given route fixtures, when dispatch plans are generated, then command sequence and final stop state match the PRD.

- [ ] **TRD-010**: Add Foreman phase report and deterministic `<artifact>.classification.json` sidecar output with safe path handling (4h) [satisfies REQ-011]
  - Validates PRD ACs: AC-011-1, AC-011-2
  - Implementation ACs:
    - Given `FOREMAN_ARTIFACT_PATH` is set, when classification completes, then a phase report is written to that exact path.
    - Given Foreman mode is active, when classification completes, then a linked JSON sidecar named from the phase artifact basename contains score, route, confidence, override status, and rationale.
- [ ] **TRD-010-TEST**: Add Foreman artifact path and sidecar JSON tests (2h) [verifies TRD-010] [satisfies REQ-011, REQ-012] [depends: TRD-010]
  - Validates PRD ACs: AC-011-1, AC-011-2
  - Implementation ACs:
    - Given a temp artifact path, when tests run, then the report is written exactly there and JSON parses successfully.

- [ ] **TRD-011**: Implement secret redaction for rationale, disclosure, and audit output (3h) [satisfies REQ-015]
  - Validates PRD ACs: AC-015-1, AC-015-2
  - Implementation ACs:
    - Given likely tokens, keys, or bearer credentials in input, when rationale is rendered, then secret values are replaced with `[REDACTED]`.
    - Given clarification is needed, when prompts are generated, then they request non-secret structural details only.
- [ ] **TRD-011-TEST**: Add redaction and non-secret clarification prompt tests (2h) [verifies TRD-011] [satisfies REQ-015, REQ-012] [depends: TRD-011]
  - Validates PRD ACs: AC-015-1, AC-015-2
  - Implementation ACs:
    - Given secret-like fixtures, when output is captured, then raw values are absent and redaction markers are present.

### PR 5: Documentation, Generation, and Validation
**Shippable State:** The feature is documented, generated artifacts are in sync, and the validation/test suite proves route scoring and command behavior.

- [ ] **TRD-012**: Add or update user/operator documentation for score bands, route sequence, overrides, disable controls, and Foreman metadata (3h) [satisfies REQ-016, REQ-011]
  - Validates PRD ACs: AC-016-1, AC-016-2, AC-011-1, AC-011-2
  - Implementation ACs:
    - Given command help/docs are read, then they include bands 1-3, 4-6, 7-10 and valid override values.
    - Given Foreman operator docs are read, then they describe task title/description usage and artifact outputs.
- [ ] **TRD-012-TEST**: Add documentation presence checks for route bands, overrides, disable controls, and Foreman metadata (1h) [verifies TRD-012] [satisfies REQ-016, REQ-012] [depends: TRD-012]
  - Validates PRD ACs: AC-016-1, AC-016-2
  - Implementation ACs:
    - Given docs files, when tests or validation scripts scan them, then required terms are present.

- [ ] **TRD-013**: Run `npm run generate` to regenerate command markdown from YAML sources (1h) [satisfies REQ-014]
  - Validates PRD ACs: AC-014-1, AC-014-2
  - Implementation ACs:
    - Given YAML command sources changed, when generation runs, then generated command markdown updates from source.
    - Given generated output is checked, then no manual-only generated edits are required.
- [ ] **TRD-013-TEST**: Validate generated artifacts and command schema sync (1h) [verifies TRD-013] [satisfies REQ-014, REQ-012] [depends: TRD-013]
  - Validates PRD ACs: AC-014-1, AC-014-2
  - Implementation ACs:
    - Given `npm run generate` and `npm run validate`, when they run after implementation, then both complete successfully.

- [ ] **TRD-014**: Add comprehensive Jest coverage for scoring fixtures, boundary bands, overrides, fallback, config precedence, Foreman artifacts, and redaction (4h) [satisfies REQ-012]
  - Validates PRD ACs: AC-012-1, AC-012-2, AC-012-3, AC-012-4
  - Implementation ACs:
    - Given all required fixture categories, when Jest runs, then each PRD AC has at least one assertion.
    - Given boundary fixtures for 3, 4, 6, and 7, then mappings match documented bands.
- [ ] **TRD-014-TEST**: Run the focused adaptive-planning Jest tests and record validation output (1h) [verifies TRD-014] [satisfies REQ-012] [depends: TRD-014]
  - Validates PRD ACs: AC-012-1, AC-012-2, AC-012-3, AC-012-4
  - Implementation ACs:
    - Given focused tests are run, when they finish, then output shows pass/fail status for every adaptive-planning fixture group.

- [ ] **TRD-015**: Run repo validation gates for generated markdown, version sync, and model IDs (2h) [satisfies REQ-014]
  - Validates PRD ACs: AC-014-2
  - Implementation ACs:
    - Given implementation is complete, when `npm run validate` runs, then command schemas, generated artifacts, version sync, and model IDs pass.
    - Given validation fails, then failure output identifies a source file to fix rather than generated-only edits.
- [ ] **TRD-015-TEST**: Record final validation evidence for `npm run generate` and `npm run validate` (1h) [verifies TRD-015] [satisfies REQ-014, REQ-012] [depends: TRD-015]
  - Validates PRD ACs: AC-014-2
  - Implementation ACs:
    - Given final gates are run, then reports include command exit status and relevant validation output.

- [ ] **TRD-016**: Add final implementation notes and next-step handoff that no implementation starts without explicit approval (1h) [satisfies REQ-010, REQ-016]
  - Validates PRD ACs: AC-010-2, AC-010-3, AC-016-1, AC-016-2
  - Implementation ACs:
    - Given the feature plan is complete, when the handoff is read, then it states Medium/Complex stop before implementation approval.
    - Given docs mention next steps, then they do not imply automatic implementation from TRD creation.
- [ ] **TRD-016-TEST**: Verify handoff text preserves approval-gate language (1h) [verifies TRD-016] [satisfies REQ-010, REQ-016] [depends: TRD-016]
  - Validates PRD ACs: AC-010-2, AC-010-3, AC-016-1, AC-016-2
  - Implementation ACs:
    - Given handoff/docs text, when scanned, then approval-gate language is present and automatic implementation is not promised.

## Dependency Map

| Task | Depends On | Notes |
|------|------------|-------|
| TRD-001 | — | Command source starts the feature. |
| TRD-001-TEST | TRD-001 | Verifies command skeleton. |
| TRD-002 | TRD-001 | Normalization needs command inputs. |
| TRD-002-TEST | TRD-002 | Verifies precedence. |
| TRD-003 | TRD-002 | Scoring requires normalized text. |
| TRD-003-TEST | TRD-003 | Verifies scoring. |
| TRD-004 | TRD-003 | Route mapping consumes scores. |
| TRD-004-TEST | TRD-004 | Verifies boundaries. |
| TRD-005 | TRD-003, TRD-004 | Confidence/fallback uses scoring and routes. |
| TRD-005-TEST | TRD-005 | Verifies low-confidence behavior. |
| TRD-006 | TRD-004, TRD-005 | Disclosure uses route and confidence. |
| TRD-006-TEST | TRD-006 | Verifies output order. |
| TRD-007 | TRD-004, TRD-006 | Override happens after recommendation. |
| TRD-007-TEST | TRD-007 | Verifies override behavior. |
| TRD-008 | TRD-001 | Disable controls wrap command behavior. |
| TRD-008-TEST | TRD-008 | Verifies compatibility. |
| TRD-009 | TRD-006, TRD-007, TRD-008 | Dispatch depends on disclosure/control decisions. |
| TRD-009-TEST | TRD-009 | Verifies route stop points. |
| TRD-010 | TRD-006, TRD-009 | Artifacts report selected route. |
| TRD-010-TEST | TRD-010 | Verifies artifact writing. |
| TRD-011 | TRD-002, TRD-006, TRD-010 | Redaction protects output surfaces. |
| TRD-011-TEST | TRD-011 | Verifies redaction. |
| TRD-012 | TRD-004, TRD-007, TRD-008, TRD-010 | Docs need final controls and artifacts. |
| TRD-012-TEST | TRD-012 | Verifies docs. |
| TRD-013 | TRD-001, TRD-012 | Generation follows source edits. |
| TRD-013-TEST | TRD-013 | Verifies generated sync. |
| TRD-014 | TRD-003, TRD-004, TRD-005, TRD-007, TRD-008, TRD-010, TRD-011 | Test suite aggregates coverage. |
| TRD-014-TEST | TRD-014 | Runs focused tests. |
| TRD-015 | TRD-013, TRD-014 | Final repo validation after generation/tests. |
| TRD-015-TEST | TRD-015 | Records gate evidence. |
| TRD-016 | TRD-009, TRD-012, TRD-015 | Final handoff after implementation validation. |
| TRD-016-TEST | TRD-016 | Verifies approval language. |

**Critical path:** TRD-001 → TRD-002 → TRD-003 → TRD-004 → TRD-005 → TRD-006 → TRD-007 → TRD-009 → TRD-010 → TRD-012 → TRD-013 → TRD-015 → TRD-016.

No circular dependencies identified. No implementation task is 8h or larger.

## Sprint Planning

## Sprint 1: Command and Analyzer Core

- PR 1: Analyzer Command Skeleton and Input Contract
- PR 2: Deterministic Scoring and Route Mapping

## Sprint 2: Controls and Foreman Artifacts

- PR 3: User Control, Config, and Backward Compatibility
- PR 4: Route Dispatch and Foreman Audit Artifacts

## Sprint 3: Docs and Validation

- PR 5: Documentation, Generation, and Validation

## Acceptance Criteria Traceability

| REQ | Description | Implementation Tasks | Test Tasks |
|-----|-------------|----------------------|------------|
| REQ-001 | Analyze Complexity Command | TRD-001 | TRD-001-TEST |
| REQ-002 | Foreman and Interactive Input Contract | TRD-001, TRD-002 | TRD-001-TEST, TRD-002-TEST |
| REQ-003 | Multi-Factor Score Rubric | TRD-003 | TRD-003-TEST |
| REQ-004 | Score Bands and Route Mapping | TRD-004, TRD-012 | TRD-004-TEST, TRD-012-TEST |
| REQ-005 | Confidence and Low-Confidence Handling | TRD-003, TRD-005 | TRD-003-TEST, TRD-005-TEST |
| REQ-006 | Pre-Planning Disclosure | TRD-001, TRD-006 | TRD-001-TEST, TRD-006-TEST |
| REQ-007 | User Override | TRD-007, TRD-012 | TRD-007-TEST, TRD-012-TEST |
| REQ-008 | Configurable Disable Controls | TRD-008, TRD-012 | TRD-008-TEST, TRD-012-TEST |
| REQ-009 | Backward Compatibility for Existing Commands | TRD-008 | TRD-008-TEST |
| REQ-010 | Route Execution Contract | TRD-002, TRD-004, TRD-007, TRD-009, TRD-016 | TRD-002-TEST, TRD-009-TEST, TRD-016-TEST |
| REQ-011 | Explainability and Audit Trail | TRD-006, TRD-007, TRD-010, TRD-012 | TRD-006-TEST, TRD-010-TEST |
| REQ-012 | Test Fixture Coverage | TRD-014 | TRD-001-TEST through TRD-016-TEST |
| REQ-013 | Deterministic Fallback Behavior | TRD-003, TRD-005 | TRD-003-TEST, TRD-005-TEST |
| REQ-014 | Integration with Existing Generation Workflow | TRD-001, TRD-013, TRD-015 | TRD-013-TEST, TRD-015-TEST |
| REQ-015 | Security and Data Handling | TRD-011 | TRD-011-TEST |
| REQ-016 | Documentation | TRD-012, TRD-016 | TRD-012-TEST, TRD-016-TEST |

Traceability check: 16 requirements covered, 0 uncovered, 0 orphaned annotations.

## MCP Enhancement

MCP enhancement: skipped (no MCP tools detected).

## Adversarial Review

### Architecture Self-Critique

| Issue | Impact | Resolution |
|-------|--------|------------|
| Analyzer and command prose could diverge if scoring rules are duplicated. | Route recommendations may become inconsistent. | Keep numeric scoring and route mapping in `complexity-analyzer.js`; command prose calls the helper and documents the contract. |
| Foreman artifact sidecar path could be ambiguous if derived without a deterministic rule. | Foreman may not find classification details. | Write the human report exactly to `FOREMAN_ARTIFACT_PATH`; derive JSON sidecar predictably and link it from the phase report. |
| Redaction could accidentally mutate the downstream work description. | Route commands might receive altered requirements. | Maintain separate `original` and `displaySafe` fields; only display/audit surfaces use redacted text. |

### Task Coverage Analysis

| Issue | Impact | Resolution |
|-------|--------|------------|
| Draft task parser can miss tasks if checkbox prefixes are omitted. | `implement-trd-beads` would create zero or partial beads. | Every implementation and test task line starts with `- [ ] **TRD-...**`; parser validation was run. |
| REQ-012 is broad and could be under-covered by only one aggregate test task. | Test fixture coverage may miss route-specific edge cases. | Paired tests are attached to each implementation task, with TRD-014 aggregating full fixture coverage. |
| PR boundaries can become infrastructure-only if command skeleton ships without visible behavior. | PR shippability would be weak. | PR 1 shippable state explicitly exposes invocation and missing-input/normalized-input disclosure behavior. |

### Dependency and Estimate Review

| Issue | Impact | Resolution |
|-------|--------|------------|
| Critical path spans analyzer, controls, dispatch, artifacts, docs, and validation. | Late failures in dispatch/artifacts can delay docs and validation. | PRs isolate vertical user-observable behavior; tests are paired early to catch regressions before final validation. |
| Foreman artifact behavior depends on disclosure/dispatch data. | Sidecar may omit selected route if implemented too early. | TRD-010 depends on TRD-006 and TRD-009 so the artifact writer receives final selected-route data. |
| Some helper estimates could be optimistic if existing config APIs are less direct than expected. | Under-estimated PR 3 risk. | Keep TRD-008 to config resolution only; do not refactor existing direct commands. |

### Testability Review

| Issue | Impact | Resolution |
|-------|--------|------------|
| "Safer higher-depth route" can be subjective without deterministic candidate ordering. | Low-confidence Foreman tests could be flaky. | Implement explicit route ordering `simple < medium < complex` and assert selected max plausible route. |
| Secret detection can never prove every secret pattern. | False negatives possible. | Use common token/key/bearer patterns and assert no raw fixture secret appears in output. |
| Output-order behavior can be hard to prove from prose-only commands. | Disclosure might accidentally move after side effects. | Add command transcript/snapshot tests that assert disclosure text precedes dispatch markers. |

## Design Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|-----------|:-:|-------|
| Architecture completeness | 4.8 | Components, interfaces, data flow, concrete file ownership, artifacts, failure modes, and redaction boundaries are defined. |
| Task coverage | 4.8 | Every REQ has implementation and test coverage with AC traceability. |
| Dependency clarity | 4.8 | Dependencies are explicit, acyclic, grouped into shippable PRs, and include deterministic sidecar naming. |
| Estimate confidence | 4.8 | Tasks are granular; no implementation task is >=8h; core helper estimates include tests and exact generation commands. |
| **Overall** | **4.8** | **PASS** |

**Gate decision: PASS.** TRD is ready for review and team configuration. No implementation has been performed.

## Output Summary

- TRD file: `docs/TRD/TRD-2026-b967cc9e-ai-complexity-planning-depth.md`
- Source PRD correlation id: `b967cc9e`
- Implementation tasks: 16
- Test tasks: 16
- Total tasks: 32
- Estimated implementation/test effort: 72h
- Design readiness score: 4.8 PASS

## Suggested Next Steps

1. `/ensemble-configure-team docs/TRD/TRD-2026-b967cc9e-ai-complexity-planning-depth.md`
2. After explicit approval only: `/ensemble-implement-trd-beads docs/TRD/TRD-2026-b967cc9e-ai-complexity-planning-depth.md`

## Change Log

### 2026-09-02 — v1.0.1

- Foreman mode auto-applied refinement findings without interactive prompts.
- Replaced ambiguous command-source ownership with `packages/development/commands/analyze-complexity.yaml`.
- Replaced generic helper reference with `packages/development/lib/complexity-analyzer.js` and CLI JSON contract.
- Added deterministic Foreman sidecar naming: `<FOREMAN_ARTIFACT_PATH basename>.classification.json`.
- Added generated-artifact boundary requiring source YAML edits, `npm run generate`, and `npm run validate`.
- Re-scored Design Readiness from 4.65 to 4.8 PASS.

Stop here. Await explicit approval before implementation.
