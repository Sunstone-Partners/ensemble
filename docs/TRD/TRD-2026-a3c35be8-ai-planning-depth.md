---
document_id: TRD-2026-a3c35be8
label: trd-ai-planning-depth
kind: trd
prd_reference: PRD-2026-a3c35be8 (docs/PRD/PRD-2026-a3c35be8-ai-planning-depth.md v1.0.1)
version: 1.0.1
status: Draft
date: 2026-09-02
design_readiness_score: 4.8
ensemble_implement_trd_beads:
  branch_name: feature/trd-2026-a3c35be8-ai-planning-depth
  use_proposed: true
  stacked_prs: true
---

# TRD-2026-a3c35be8: adhoc-94ba81bd — AI-Driven Planning Depth Auto-Selection

**Source PRD:** `docs/PRD/PRD-2026-a3c35be8-ai-planning-depth.md` (v1.0.1, readiness 4.85 PASS)<br>
**Foreman subject:** `adhoc-94ba81bd`

## Reused Capabilities

No foundational TRDs are registered. `node packages/development/lib/trd-graph-cli.js capabilities docs/TRD --json` returned an empty capability registry. The implementation should reuse existing command-generation and command-orchestration patterns instead of duplicating them:

- `packages/product/commands/create-prd.yaml` for PRD creation path semantics.
- `packages/product/commands/feature.yaml` for planning pipeline orchestration precedent.
- `packages/development/commands/create-trd.yaml` and `packages/development/commands/create-trd-foreman.yaml` for TRD creation semantics.
- `packages/development/commands/refine-trd.yaml` for the Complex refinement gate.
- `packages/development/commands/fix-issue.yaml` for Simple path semantics.
- `scripts/generate-markdown.js` / `npm run generate` for generated command markdown.

## Architecture Decision

### Chosen approach — Option C: deterministic local analyzer plus explicit adaptive planning entrypoint

Foreman mode auto-selected Option C as the brownfield-safe default. The feature should add a local deterministic work-complexity analyzer and expose it through an operator-facing adaptive planning command. The v1 analyzer must not call a remote model. It scores free-text work descriptions from explicit, testable signals and returns structured factor rationale.

The routing layer sits before any downstream planning begins:

1. Parse the work description, `--depth`, `--no-auto-complexity`, `--foreman`, and optional config defaults.
2. Run local complexity analysis unless disabled.
3. Print or report score, selected depth, selected path, factor rationale, uncertainty, and override state.
4. Route by fixed score bands:
   - Simple score 1–3: `fix-issue`.
   - Medium score 4–6: `create-prd` → `create-trd`.
   - Complex score 7–10: `create-prd` → `refine-prd` → `create-trd` → `refine-trd`; implementation remains blocked until refined TRD approval.

This preserves direct manual command behavior while making adaptive routing auditable. Interactive use should report the chosen path before invoking downstream commands. Foreman use should record the same decision block in its phase artifact and must never prompt.

### Alternatives considered

**Option A — prose-only command instruction.** Add classifier instructions directly to command YAML and let the agent infer score each run. Fastest, but hard to test or tune. Rejected because REQ-012 requires deterministic fixtures.

**Option B — external LLM/provider classifier.** Use a model call for classification. More flexible, but adds cost, latency, nondeterminism, auth/config, and harder validation. Rejected for v1 because the PRD does not require a new paid service.

**Option C — local scoring library with command orchestration.** Selected. It gives deterministic tests, clear override precedence, and small integration points with existing command sources and generated markdown.

## System Architecture

### Components

| Component | Status | Responsibility |
|---|---|---|
| `packages/product/lib/work-complexity-analyzer.js` | new | Pure scoring module for description validation, factor extraction, score, depth, path, uncertainty, and override state |
| `packages/product/lib/index.js` | modified | Export analyzer helpers for tests and command use |
| `packages/product/commands/analyze-complexity.yaml` | new | Operator-facing command for score/rationale/path output before downstream planning |
| `packages/product/commands/feature.yaml` | modified | Advertise or invoke adaptive planning without changing explicit manual paths |
| `packages/product/tests/work-complexity-analyzer.test.js` | new | Deterministic analyzer fixtures for Simple, Medium, Complex, empty input, uncertainty, overrides, and disable behavior |
| `packages/product/tests/analyze-complexity-command.test.js` | new | Command-source tests for score output, Foreman artifact behavior, flags, and path mapping |
| `packages/product/commands/ensemble/analyze-complexity.md` | generated | Generated command markdown produced by `npm run generate` |
| `packages/product/README.md` and/or `docs/guides/environment-variables.md` | modified | Operator docs for scale, paths, overrides, disable config, Foreman behavior, generated artifact workflow |

### Analyzer contract

Input:

```js
{
  description: string,
  overrideDepth?: 'simple' | 'medium' | 'complex',
  disableAuto?: boolean,
  nonInteractive?: boolean,
  config?: {
    autoComplexity?: boolean,
    defaultDepth?: 'simple' | 'medium' | 'complex'
  }
}
```

Output:

```js
{
  score: number, // integer 1..10
  depth: 'Simple' | 'Medium' | 'Complex',
  path: ['fix-issue'] | ['create-prd', 'create-trd'] | ['create-prd', 'refine-prd', 'create-trd', 'refine-trd'],
  factors: {
    scope: { level: 'low'|'medium'|'high'|'uncertain', evidence: string[] },
    dependencies: { level: 'low'|'medium'|'high'|'uncertain', evidence: string[] },
    risk: { level: 'low'|'medium'|'high'|'uncertain', evidence: string[] },
    teamSize: { level: 'low'|'medium'|'high'|'uncertain', evidence: string[] }
  },
  rationale: string,
  uncertainty: string[],
  originalClassification?: { score: number, depth: string, path: string[] },
  overrideApplied: boolean,
  disabled: boolean
}
```

Suggested v1 scoring: each factor maps to 0–2 points, plus a 1-point base and a bounded uplift for severe automation/security/data-loss language. Clamp final score to 1–10. Band mapping is fixed: 1–3 Simple, 4–6 Medium, 7–10 Complex.

### Data flow

```text
User / Foreman work description
  -> analyze-complexity command argument parsing
  -> work-complexity-analyzer.js pure scoring or manual-depth fallback
  -> route selector maps score band to command path
  -> score/rationale block printed before planning side effects
  -> optional override/disable logic applies
  -> existing command path is invoked or reported as handoff
  -> Foreman phase report includes score/rationale/path/override audit block
```

### Integration and failure handling

- Empty or whitespace-only descriptions halt with a clear error and no selected path.
- Insufficient factor evidence records `uncertain`; it must not invent evidence.
- Existing direct `fix-issue`, `create-prd`, `create-trd`, and `refine-trd` invocations remain unchanged.
- Per-invocation flags (`--depth`, `--no-auto-complexity`) take precedence over global config.
- Non-interactive `--foreman` mode never asks; it uses the analyzer result or supplied override automatically.
- Foreman reports must include score, rationale, selected depth/path, override state, disable state, and uncertainty.
- Generated markdown must be regenerated from YAML with `npm run generate`.

## Master Task List

### PR 1: Deterministic analyzer library and fixture coverage

**Shippable State:** Maintainers can call a pure local analyzer in tests or scripts and receive a deterministic score, route, and factor rationale for any work description; no command routing is changed yet.

- [x] **TRD-001** Create `packages/product/lib/work-complexity-analyzer.js` with input validation and a structured analysis result (3h) `[satisfies REQ-001, REQ-002]`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2
  - Implementation AC: Given a non-empty work description, when `analyzeWorkComplexity` runs, then it returns an integer score from 1 through 10 with `depth`, `path`, `factors`, `rationale`, `uncertainty`, and `overrideApplied` fields.
  - Implementation AC: Given an empty description, when analysis runs, then it throws or returns a typed error that callers can display without selecting a path.

- [x] **TRD-002** Implement scope-size signal detection for isolated fixes, single commands, multiple features, workflows, packages, and user roles (2h) `[satisfies REQ-003] [depends: TRD-001]`
  - Validates PRD ACs: AC-003-1, AC-003-2
  - Implementation AC: Given a description of one isolated bug, when scoring runs, then the scope factor is low and contributes toward Simple.
  - Implementation AC: Given a description mentioning multiple features/workflows/packages/roles, when scoring runs, then the scope factor records evidence snippets and contributes toward a higher score.

- [x] **TRD-003** Implement dependency signal detection for integrations, shared libraries, generated artifacts, Foreman phases, and multiple commands (2h) `[satisfies REQ-004] [depends: TRD-001]`
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Implementation AC: Given dependency keywords, when scoring runs, then dependency evidence appears in factor rationale.
  - Implementation AC: Given no dependency evidence, when scoring runs, then dependency factor is low or uncertain and no dependency is invented.

- [x] **TRD-004** Implement risk and team-size signal detection with uncertainty handling (2.5h) `[satisfies REQ-005, REQ-006] [depends: TRD-001]`
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-006-1, AC-006-2
  - Implementation AC: Given security/data-loss/production/automation/user-visible workflow terms, when scoring runs, then risk increases or the rationale explicitly explains why it did not.
  - Implementation AC: Given multi-team/PM/QA/enterprise language, when scoring runs, then team-size factor increases; solo-maintainer language does not independently increase it.

- [x] **TRD-005** Implement band-to-path mapping and override/disable precedence in the analyzer module (2.5h) `[satisfies REQ-007, REQ-008, REQ-009, REQ-011, REQ-013] [depends: TRD-002, TRD-003, TRD-004]`
  - Validates PRD ACs: AC-007-1, AC-008-1, AC-009-1, AC-011-2, AC-011-3, AC-013-2
  - Implementation AC: Given score 1–3, 4–6, or 7–10, when route mapping runs, then it returns Simple/Medium/Complex with the exact command path required by the PRD.
  - Implementation AC: Given both global config and a per-invocation flag, when classification runs, then the command flag takes precedence and the result records original and final classification where applicable.

- [x] **TRD-001-TEST** Add unit tests for analyzer input validation, output schema, integer score bounds, and factor rationale fields (1.5h) `[verifies TRD-001] [satisfies REQ-001, REQ-002] [depends: TRD-001]`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2
  - Implementation AC: Given valid and empty descriptions, when tests run, then valid input returns the structured result and empty input fails without a path.

- [x] **TRD-002-TEST** Add deterministic scope fixture tests for small isolated and multi-workflow descriptions (1h) `[verifies TRD-002] [satisfies REQ-003] [depends: TRD-002]`
  - Validates PRD ACs: AC-003-1, AC-003-2
  - Implementation AC: Given small isolated and multi-workflow descriptions, when tests run, then scope factor levels and evidence match expectations without model calls.

- [x] **TRD-003-TEST** Add deterministic dependency fixture tests for integration and no-dependency descriptions (1h) `[verifies TRD-003] [satisfies REQ-004] [depends: TRD-003]`
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Implementation AC: Given dependency-rich and dependency-free descriptions, when tests run, then dependency evidence is captured or marked low/uncertain without invented dependencies.

- [x] **TRD-004-TEST** Add deterministic risk and team-size fixture tests (1.5h) `[verifies TRD-004] [satisfies REQ-005, REQ-006] [depends: TRD-004]`
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-006-1, AC-006-2
  - Implementation AC: Given risk-heavy, ambiguous-risk, multi-team, and solo-maintainer descriptions, when tests run, then factor levels and uncertainty notes match the scoring contract.

- [x] **TRD-005-TEST** Add mapping and override tests for Simple, Medium, Complex, non-interactive default, and precedence rules (2h) `[verifies TRD-005] [satisfies REQ-007, REQ-008, REQ-009, REQ-011, REQ-013] [depends: TRD-005]`
  - Validates PRD ACs: AC-007-1, AC-008-1, AC-009-1, AC-011-2, AC-011-3, AC-013-2
  - Implementation AC: Given forced scores and override combinations, when tests run, then paths and recorded original/final classifications match the PRD contract.

### PR 2: Operator-facing analyze-complexity command

**Shippable State:** Users and Foreman can run `/ensemble:analyze-complexity` to see a score, rationale, selected planning depth, and exact recommended command path before any downstream planning begins.

- [x] **TRD-006** Add `packages/product/commands/analyze-complexity.yaml` command source with argument parsing, empty-input halt, score display, and route output (3h) `[satisfies REQ-001, REQ-002, REQ-010] [depends: TRD-005]`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-010-1
  - Implementation AC: Given a valid description, when the command runs, then it prints score, depth, path, and factor rationale before any downstream command is invoked.
  - Implementation AC: Given no description, when the command runs, then it halts with the empty-input error.

- [x] **TRD-007** Add interactive and non-interactive override flags to the command (`--depth`, `--no-auto-complexity`, and `--foreman`) (2.5h) `[satisfies REQ-011, REQ-013] [depends: TRD-006]`
  - Validates PRD ACs: AC-011-1, AC-011-2, AC-011-3, AC-013-1, AC-013-2
  - Implementation AC: Given an interactive override, when selected, then the final depth changes and the original AI classification remains printed.
  - Implementation AC: Given `--foreman` or non-interactive use, when no override is provided, then no prompt appears and the AI-selected route is used.

- [x] **TRD-008** Add Foreman phase report block and artifact-path write instructions to `analyze-complexity.yaml` (2h) `[satisfies REQ-010, REQ-011] [depends: TRD-006, TRD-007]`
  - Validates PRD ACs: AC-010-2, AC-011-3
  - Implementation AC: Given `--foreman` and `FOREMAN_ARTIFACT_PATH`, when the command completes, then the phase report includes score/rationale/path/override state and is written exactly to that path in addition to any repo-local report.

- [x] **TRD-009** Regenerate command markdown and plugin manifests via `npm run generate` (1h) `[satisfies REQ-014] [depends: TRD-006, TRD-007, TRD-008]`
  - Validates PRD ACs: AC-014-1, AC-014-2
  - Implementation AC: Given source YAML changes, when `npm run generate` runs, then `packages/product/commands/ensemble/analyze-complexity.md` exists and generated command docs match the source.

- [x] **TRD-006-TEST** Add command-source tests for required score/rationale/path output and empty-input halt wording (1.5h) `[verifies TRD-006] [satisfies REQ-001, REQ-002, REQ-010] [depends: TRD-006]`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-010-1
  - Implementation AC: Given the command YAML, when tests scan it, then output and halt instructions are present before downstream planning steps.

- [x] **TRD-007-TEST** Add command-source tests for override flags, Foreman non-prompt behavior, and backward-compatible manual paths (1.5h) `[verifies TRD-007] [satisfies REQ-011, REQ-013] [depends: TRD-007]`
  - Validates PRD ACs: AC-011-1, AC-011-2, AC-011-3, AC-013-1, AC-013-2
  - Implementation AC: Given the command YAML, when tests scan it, then `--depth`, `--no-auto-complexity`, and `--foreman` semantics are documented and no Foreman prompt path exists.

- [x] **TRD-008-TEST** Add command-source tests for Foreman report and exact `FOREMAN_ARTIFACT_PATH` contract wording (1h) `[verifies TRD-008] [satisfies REQ-010, REQ-011] [depends: TRD-008]`
  - Validates PRD ACs: AC-010-2, AC-011-3
  - Implementation AC: Given the command YAML, when tests scan it, then it requires writing the phase report to the exact Foreman artifact path when set and never treating an unset path as an error.

- [x] **TRD-009-TEST** Verify generated markdown is clean and package validation passes (1h) `[verifies TRD-009] [satisfies REQ-014] [depends: TRD-009]`
  - Validates PRD ACs: AC-014-1, AC-014-2
  - Implementation AC: Given the implementation branch, when `npm run generate` and `npm run validate` run, then generated files are clean and validation exits zero.

### PR 3: Adaptive routing integration and docs

**Shippable State:** Operators can use the adaptive entrypoint to select Simple, Medium, or Complex planning depth from the work description while existing explicit manual commands still behave as before.

- [x] **TRD-010** Integrate adaptive classification into the appropriate product planning entrypoint without changing explicit `fix-issue`, `create-prd`, or `create-trd` invocations (3h) `[satisfies REQ-001, REQ-007, REQ-008, REQ-009, REQ-013] [depends: TRD-009]`
  - Validates PRD ACs: AC-001-1, AC-007-1, AC-008-1, AC-009-1, AC-013-1
  - Implementation AC: Given the adaptive entrypoint receives a description, when planning starts, then classification runs before downstream route selection.
  - Implementation AC: Given explicit legacy commands are invoked directly, when they run, then they retain prior documented behavior and do not require analyzer input.

- [x] **TRD-011** Implement Medium and Complex route handoff semantics, including implementation block after refined TRD for Complex (2.5h) `[satisfies REQ-008, REQ-009, REQ-010] [depends: TRD-010]`
  - Validates PRD ACs: AC-008-1, AC-008-2, AC-009-1, AC-009-2, AC-010-1
  - Implementation AC: Given Medium classification, when routing is reported, then the path is PRD→TRD.
  - Implementation AC: Given Complex classification, when routing is reported, then the path is create-prd → refine-prd → create-trd → refine-trd and implementation remains blocked pending approval.

- [x] **TRD-012** Add deterministic end-to-end route fixtures for simple bug, medium feature, and complex initiative descriptions (2.5h) `[satisfies REQ-007, REQ-008, REQ-009, REQ-012] [depends: TRD-010, TRD-011]`
  - Validates PRD ACs: AC-007-2, AC-008-2, AC-009-2, AC-012-1, AC-012-2
  - Implementation AC: Given the simple bug fixture, when tests evaluate the analyzer/route selector, then score is `<=3` and path is Simple/fix-issue.
  - Implementation AC: Given the complex initiative fixture, when tests evaluate the analyzer/route selector, then score is `>=7` and path is Complex/full pipeline.

- [x] **TRD-013** Update operator docs for scoring scale, route mapping, override mechanism, disable precedence, Foreman behavior, and generated-artifact workflow (2h) `[satisfies REQ-014, REQ-013] [depends: TRD-009, TRD-010, TRD-011]`
  - Validates PRD ACs: AC-014-1, AC-014-2, AC-013-1, AC-013-2
  - Implementation AC: Given README or generated command help is reviewed, when docs are read, then they explain score bands, paths, overrides, disable config, and Foreman non-interactive behavior.

- [x] **TRD-010-TEST** Add integration tests proving adaptive classification precedes route selection and manual commands remain backward compatible (2h) `[verifies TRD-010] [satisfies REQ-001, REQ-007, REQ-008, REQ-009, REQ-013] [depends: TRD-010]`
  - Validates PRD ACs: AC-001-1, AC-007-1, AC-008-1, AC-009-1, AC-013-1
  - Implementation AC: Given adaptive and explicit command paths, when tests run, then only adaptive path requires pre-planning classification.

- [x] **TRD-011-TEST** Add route-output tests for Medium and Complex handoff details and implementation block wording (1.5h) `[verifies TRD-011] [satisfies REQ-008, REQ-009, REQ-010] [depends: TRD-011]`
  - Validates PRD ACs: AC-008-1, AC-008-2, AC-009-1, AC-009-2, AC-010-1
  - Implementation AC: Given Medium/Complex fixtures, when output is rendered, then exact path wording and Complex implementation block are present.

- [x] **TRD-012-TEST** Add regression fixtures required by the PRD verification section (1.5h) `[verifies TRD-012] [satisfies REQ-012, REQ-007, REQ-009] [depends: TRD-012]`
  - Validates PRD ACs: AC-012-1, AC-012-2, AC-007-2, AC-009-2
  - Implementation AC: Given the PRD's simple and complex descriptions, when the test suite runs, then expected score bands and paths are asserted.

- [x] **TRD-013-TEST** Verify documentation and generated artifacts are current (1h) `[verifies TRD-013] [satisfies REQ-014] [depends: TRD-013]`
  - Validates PRD ACs: AC-014-1, AC-014-2
  - Implementation AC: Given docs and generated markdown, when `npm run generate -- --validate` or equivalent validation runs, then docs are synchronized with command sources.

**Total: 26 tasks (13 implementation, 13 test), 46.5h.** No task is estimated at 8h+.

## Sprint Planning

### Sprint 1: Analyzer foundation

Deliver PR 1. Focus: pure scoring module, factor rationale, path mapping, and deterministic fixtures.

### Sprint 2: Command surface

Deliver PR 2. Focus: `/ensemble:analyze-complexity`, Foreman report behavior, override flags, and generated markdown.

### Sprint 3: Adaptive routing and docs

Deliver PR 3. Focus: integrate adaptive entrypoint, route handoff semantics, compatibility proof, and operator docs.

## Acceptance Criteria Traceability

| REQ-NNN | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Analyze Work Description Before Planning | TRD-001, TRD-006, TRD-010 | TRD-001-TEST, TRD-006-TEST, TRD-010-TEST |
| REQ-002 | Score Complexity on a 1–10 Scale | TRD-001, TRD-006 | TRD-001-TEST, TRD-006-TEST |
| REQ-003 | Evaluate Scope Size Signals | TRD-002 | TRD-002-TEST |
| REQ-004 | Evaluate Dependency Signals | TRD-003 | TRD-003-TEST |
| REQ-005 | Evaluate Risk Signals | TRD-004 | TRD-004-TEST |
| REQ-006 | Evaluate Team-Size Signals | TRD-004 | TRD-004-TEST |
| REQ-007 | Map Scores 1–3 to Simple Fix-Issue Path | TRD-005, TRD-010, TRD-012 | TRD-005-TEST, TRD-010-TEST, TRD-012-TEST |
| REQ-008 | Map Scores 4–6 to Medium PRD→TRD Path | TRD-005, TRD-011 | TRD-005-TEST, TRD-011-TEST |
| REQ-009 | Map Scores 7–10 to Complex Full Pipeline | TRD-005, TRD-011, TRD-012 | TRD-005-TEST, TRD-011-TEST, TRD-012-TEST |
| REQ-010 | Show Score Before Planning Begins | TRD-006, TRD-008, TRD-011 | TRD-006-TEST, TRD-008-TEST, TRD-011-TEST |
| REQ-011 | Allow Classification Override | TRD-005, TRD-007, TRD-008 | TRD-005-TEST, TRD-007-TEST, TRD-008-TEST |
| REQ-012 | Provide Deterministic Validation Fixtures | TRD-012 | TRD-012-TEST |
| REQ-013 | Preserve Backward Compatibility and Manual Paths | TRD-005, TRD-010, TRD-013 | TRD-005-TEST, TRD-007-TEST, TRD-010-TEST |
| REQ-014 | Document Operator-Facing Behavior | TRD-009, TRD-013 | TRD-009-TEST, TRD-013-TEST |

Traceability check: 14 requirements covered, 0 uncovered, 0 orphaned annotations.

## Quality Requirements

- **Testing:** Jest tests belong under `packages/product/tests/`. Pure analyzer tests must avoid agent/model calls. Command-source tests should inspect YAML for workflow contracts that cannot run as ordinary unit tests.
- **Security:** Do not send work descriptions to external services in v1. Avoid logging secrets if descriptions include credentials; docs should warn operators not to paste secrets.
- **Reliability:** Analyzer output must be deterministic for identical input and config. Unknown factors must be marked uncertain, not hallucinated.
- **Compatibility:** Existing manual commands remain callable. Generated markdown must come from YAML sources.
- **Observability:** Foreman report includes score, rationale, selected depth/path, override state, disable state, and uncertainty for audit.

## Adversarial Review Findings

### Architecture issues

1. **Issue:** A heuristic local analyzer can misclassify domain language that lacks obvious keywords. **Resolution:** keep factor-level evidence and uncertainty visible; add fixture coverage and document override controls.
2. **Issue:** Route execution could accidentally trigger implementation for Simple if it calls `fix-issue` directly. **Resolution:** make the adaptive entrypoint report or plan the chosen path first; retain explicit approval and downstream command contracts before implementation.
3. **Issue:** Command orchestration details differ between interactive and Foreman contexts. **Resolution:** encode non-interactive `--foreman` behavior in command YAML and phase report tests.
4. **Issue:** Override/disable behavior can drift between command parsing and analyzer behavior. **Resolution:** centralize precedence in the analyzer module, then test command docs/source against that contract.

### Coverage issues

1. **Issue:** REQ-012 fixture coverage could be deferred until routing, weakening early proof. **Resolution:** PR 3 explicitly includes the PRD-required simple and complex fixtures, and PR 1 includes factor-level fixtures.
2. **Issue:** REQ-013 backward compatibility might be claimed only in docs. **Resolution:** TRD-010-TEST requires integration proof that explicit commands remain unchanged.
3. **Issue:** Foreman auditability could be missed if only interactive output is tested. **Resolution:** TRD-008 and TRD-008-TEST require exact artifact-path behavior and report contents.

### Dependency and estimate issues

1. **Issue:** PR 3 depends on generated command output from PR 2, making a long path from TRD-001 through TRD-013. **Resolution:** split into three reviewable PRs; each PR has a user-observable shippable state and no task exceeds 3h.
2. **Issue:** Override precedence touches analyzer, command UX, and docs. **Resolution:** implement precedence once in the analyzer module, then assert command/docs reflect it.

### Testability issues

1. **Issue:** Terms like “AI-driven” could imply nondeterministic model output. **Resolution:** v1 treats the analyzer as deterministic local intelligence and tests score bands through fixed fixtures.
2. **Issue:** “Shown before planning begins” is a sequencing claim. **Resolution:** command-source tests assert score/rationale output appears before downstream route invocation instructions.

## Design Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|---|:-:|---|
| Architecture completeness | 4.8 | Components, data flow, analyzer contract, override/disable precedence, routing semantics, and Foreman behavior are defined. |
| Task coverage | 4.9 | All 14 PRD requirements have implementation and test coverage; no orphaned REQ annotations. |
| Dependency clarity | 4.8 | Dependencies are explicit and acyclic across three PRs; no forward dependency crosses a later PR boundary. |
| Estimate confidence | 4.7 | Tasks are granular, 1–3h each, with no 8h+ breakdown candidates. |
| **Overall** | **4.8** | **PASS** |

Gate decision: PASS.

## Foreman Refinement Log

Foreman mode auto-applied all refinement findings without interview:

1. Restored corrupted lower-half markdown (traceability, quality requirements, adversarial review, readiness, next steps) into valid TRD sections.
2. Made override/disable precedence explicit in the analyzer contract and task validation.
3. Tightened Foreman artifact/report obligations for the analyze-complexity command.
4. Re-scored design readiness from 4.65 to 4.8.

## Next Steps

1. Review and approve this TRD before implementation.
2. Optional team configuration: `/ensemble-configure-team docs/TRD/TRD-2026-a3c35be8-ai-planning-depth.md`.
3. Implementation planning: `/ensemble-implement-trd-beads docs/TRD/TRD-2026-a3c35be8-ai-planning-depth.md`.

## Changelog

- **v1.0.1** (2026-09-02) — Refined via `ensemble-refine-trd --foreman`; repaired corrupted markdown, clarified override/disable precedence and Foreman report contracts, refreshed traceability and readiness score.
- **v1.0.0** (2026-09-02) — Initial TRD via `ensemble-create-trd-foreman` for Foreman task `adhoc-94ba81bd`.
