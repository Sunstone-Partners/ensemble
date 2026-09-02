---
document_id: PRD-2026-a490035b
label: prd-quickstart-validation-artifact
version: 1.0.1
status: Draft
date: 2026-09-02
scale_depth: STANDARD
total_requirements: 12
readiness_score: 4.50
---

# PRD-2026-a490035b: quickstart.md Validation Artifact

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 8 |
| Should requirements | 3 |
| Could requirements | 1 |
| Won't requirements | 0 |
| AC coverage | 12/12 (100%) |
| Risk flags | 7 |
| Cross-requirement dependencies | 15 |
| Open PRD clarification markers | 0 |

## Product Summary

**Problem:** Ensemble can produce PRDs/TRDs and implement them, but it does not produce a derived QA runbook that turns the TRD's acceptance criteria into manual smoke-test scenarios. QA leads must manually translate ACs into test steps, which risks missed criteria, inconsistent coverage, and weak handoff from product/spec work to validation.

**Solution:** Extend the `implement-trd` flow to emit a `quickstart.md` validation artifact after implementation completion. The artifact is generated from the TRD's acceptance criteria and gives manual testers checkbox-driven scenarios with setup steps, actions, and expected results. Each acceptance criterion maps to at least one scenario, so the runbook is auditable against the source TRD.

**Primary users:**
- **QA lead / tester:** wants a concise manual smoke-test runbook covering all ACs.
- **PM / product owner:** wants confidence that acceptance criteria are testable and visibly represented in validation artifacts.
- **Implementation operator:** wants the completion phase to produce the artifact without doing implementation work outside the TRD loop.

**Success metrics:**
- 100% of parsed AC IDs from an implemented TRD appear in `quickstart.md` coverage.
- 100% of generated scenarios include setup, action, expected result, and checkbox fields.
- QA can execute the runbook manually without reading the full TRD for basic smoke coverage.

**Constraints and assumptions:**
- This PRD documents the desired product behavior only; it does not implement the feature.
- Node.js workspace conventions and YAML-driven command generation must be respected.
- Source command YAML must remain the edited source of truth when implementation occurs; generated markdown must be regenerated from YAML.
- Default artifact name is `quickstart.md` to match the Foreman task title and description.
- Artifact destination defaults to the implementation output context: when `FOREMAN_ARTIFACT_PATH` is present, write `quickstart.md` beside that phase artifact and report the path in the phase output; otherwise write beside the source TRD unless an explicit output path is supplied.

## Existing Context

Repository reconnaissance found a Node.js monorepo (`ensemble-plugins`) with workspaces under `packages/*`, command definitions under `packages/*/commands`, shared libraries under `packages/*/lib`, and generated command markdown under `packages/*/commands/ensemble`. Relevant existing workflows include:

- `packages/development/commands/implement-trd.yaml`
- `packages/development/commands/implement-trd-beads.yaml`
- `packages/development/commands/create-trd.yaml`
- `packages/development/lib/trd-parser.js`
- `packages/development/lib/scaffold-planner.js`

Existing docs style uses YAML frontmatter, `PRD-YYYY-<micro_uuid>` document IDs, `prd-<stem>` labels, requirement sections with `REQ-NNN` IDs, Given/When/Then ACs, readiness scorecards, and dependency maps.

## Goals and Non-Goals

### Goals

- Generate a manual smoke-test artifact named `quickstart.md` from TRD acceptance criteria.
- Ensure every parsed AC maps to at least one scenario.
- Make the artifact usable by QA without deep knowledge of Ensemble internals.
- Surface coverage gaps or unparseable ACs before reporting successful artifact generation.
- Preserve existing implementation behavior for normal operator runs unless quickstart generation is explicitly requested; enable quickstart generation by default for Foreman-mode `implement-trd` runs because Foreman is the QA/artifact-producing execution path.

### Non-Goals

- Do not execute QA tests automatically.
- Do not replace automated unit, integration, or E2E test gates.
- Do not change PRD or TRD authoring semantics except where needed to consume existing ACs.
- Do not infer product-specific setup data that is absent from the TRD; mark those gaps in the artifact.

## Requirements by Feature Area

### Artifact Generation

#### REQ-001: Generate quickstart.md after implementation completion
**Priority:** Must · **Complexity:** Medium · **[RISK: lifecycle placement must not report success before required artifact creation]**

The implementation command produces a `quickstart.md` artifact after the TRD implementation reaches its completion phase and before the final success report is emitted.

- AC-001-1: Given an `implement-trd` run completes successfully for a TRD with acceptance criteria, when the completion phase runs, then a `quickstart.md` artifact is written and the final report includes its path.
- AC-001-2: Given artifact generation fails, when the command prepares its final success report, then it reports the failure clearly and does not claim that quickstart generation succeeded.

#### REQ-002: Derive scenarios from parsed TRD acceptance criteria
**Priority:** Must · **Complexity:** Medium · **[RISK: hand-parsing would drift from existing parser contracts]**

The artifact generator uses the authoritative TRD parse output, not ad hoc text scanning, to identify AC IDs and their parent task/requirement context where available.

- AC-002-1: Given a TRD that `trd-cli.js parse` can parse, when quickstart generation runs, then the generator derives its source AC list from the parsed representation.
- AC-002-2: Given a TRD with no parsed ACs, when quickstart generation runs, then it emits a clear coverage error instead of writing an empty runbook as success.

#### REQ-003: Map each AC to one or more manual test scenarios
**Priority:** Must · **Complexity:** Medium · **[RISK: missing AC coverage defeats the core QA value]**

Every acceptance criterion in the parsed TRD has at least one corresponding manual scenario in `quickstart.md`.

- AC-003-1: Given a TRD with N parsed AC IDs, when quickstart generation completes, then the artifact contains at least N scenario entries and every AC ID appears in at least one entry.
- AC-003-2: Given one AC cannot be converted into a scenario because required context is absent, when the artifact is generated, then the AC still appears with a `[NEEDS CLARIFICATION: ...]` note instead of being omitted.

### Scenario Content

#### REQ-004: Include setup, actions, and expected results
**Priority:** Must · **Complexity:** Low

Each scenario is structured for manual execution with explicit setup/preconditions, user actions, expected results, and pass/fail checkbox fields.

- AC-004-1: Given any generated scenario, when a QA tester reads it, then it includes setup/preconditions, action steps, expected result, and an execution checkbox.
- AC-004-2: Given a negative or edge-case AC, when converted to a scenario, then the expected result describes safe failure or rejection behavior, not only the happy path.

#### REQ-005: Use checkbox-oriented manual runbook formatting
**Priority:** Must · **Complexity:** Low

The runbook is formatted in Markdown with checkboxes suitable for manual smoke-test execution and result tracking.

- AC-005-1: Given generated `quickstart.md`, when rendered in a Markdown viewer, then scenario pass/fail or completion state can be tracked with checkboxes.
- AC-005-2: Given multiple scenarios, when QA executes the runbook, then each scenario can be checked independently without modifying source TRD content.

#### REQ-006: Preserve traceability back to source ACs
**Priority:** Must · **Complexity:** Low

Each scenario names the source AC ID and, where available, the related REQ and TRD task IDs.

- AC-006-1: Given a scenario generated from `AC-003-2`, when QA reviews the runbook, then the scenario visibly references `AC-003-2`.
- AC-006-2: Given parser output includes parent task or requirement references, when the scenario is generated, then those references are included in scenario metadata.

### Coverage and Validation

#### REQ-007: Produce an AC coverage summary
**Priority:** Must · **Complexity:** Low

The top of `quickstart.md` includes a coverage summary showing total ACs parsed, total scenarios generated, unmapped ACs, and clarification markers.

- AC-007-1: Given successful artifact generation, when QA opens `quickstart.md`, then a summary table shows parsed AC count, scenario count, unmapped AC count, and coverage percentage.
- AC-007-2: Given any AC is unmapped, when the artifact is generated, then the summary shows coverage below 100% and lists the unmapped AC IDs.

#### REQ-008: Validate one-to-many coverage before success
**Priority:** Must · **Complexity:** Medium · **[RISK: success reporting can hide coverage defects if validation is informational only]**

The generator validates that every parsed AC has at least one scenario before declaring quickstart generation successful.

- AC-008-1: Given a generated runbook missing a scenario for one parsed AC, when coverage validation runs, then it fails and reports the missing AC ID.
- AC-008-2: Given every parsed AC has at least one scenario, when coverage validation runs, then it passes and records 100% AC coverage.

#### REQ-009: Flag source ACs that are not manually testable
**Priority:** Should · **Complexity:** Medium · **[RISK: vague ACs may produce low-value scenarios without human follow-up]**

When an AC lacks enough detail to produce clear setup/actions/expected results, the artifact retains the AC and marks the scenario with a clarification prompt.

- AC-009-1: Given an AC with vague success behavior, when scenario generation runs, then the scenario includes `[NEEDS CLARIFICATION: What observable result proves this AC passed?]` or a similarly specific prompt.
- AC-009-2: Given one or more scenario clarification prompts exist, when the coverage summary is generated, then their count is shown.

### Integration and Configuration

#### REQ-010: Support implement-trd and implement-trd-beads paths consistently
**Priority:** Should · **Complexity:** High · **[RISK: the two implementation commands have different control flow and artifact contracts]**

The feature works for both standard `implement-trd` and beads-backed `implement-trd-beads` completion flows, or explicitly documents any unsupported path before release.

- AC-010-1: Given a successful `implement-trd` run, when quickstart generation is enabled, then the artifact is produced in the completion path.
- AC-010-2: Given a successful `implement-trd-beads` run in v1, when quickstart generation is requested, then the command documents that beads-backed quickstart generation is intentionally unsupported and points operators to standard `implement-trd` for v1 quickstart artifacts.

#### REQ-011: Make artifact path visible to Foreman
**Priority:** Should · **Complexity:** Medium · **[RISK: Foreman may treat a phase as missing output if artifact location is not reported through its contract]**

When running under Foreman, the final phase output includes the `quickstart.md` path and coverage summary so Foreman can expose or archive the validation artifact.

- AC-011-1: Given `--foreman` and `FOREMAN_ARTIFACT_PATH` are set, when implementation completion reports artifacts, then the quickstart path and AC coverage summary are included in the Foreman phase report.
- AC-011-2: Given Foreman variables are absent, when the command runs normally, then artifact reporting still works without requiring Foreman-specific environment variables.

#### REQ-012: Provide deterministic output ordering
**Priority:** Could · **Complexity:** Low

Scenarios appear in deterministic TRD/AC order so diffs are stable and QA can compare artifacts between runs.

- AC-012-1: Given the same TRD input and no implementation changes, when quickstart generation runs twice, then scenario order is identical.
- AC-012-2: Given AC IDs are sequential, when the artifact is generated, then scenarios are ordered by source task/requirement order and then AC ID.

## Acceptance Criteria Summary

| REQ | Description | Priority | Complexity | AC Count |
|---|---|---|---|---:|
| REQ-001 | Generate quickstart.md after implementation completion | Must | Medium | 2 |
| REQ-002 | Derive scenarios from parsed TRD acceptance criteria | Must | Medium | 2 |
| REQ-003 | Map each AC to one or more manual test scenarios | Must | Medium | 2 |
| REQ-004 | Include setup, actions, and expected results | Must | Low | 2 |
| REQ-005 | Use checkbox-oriented manual runbook formatting | Must | Low | 2 |
| REQ-006 | Preserve traceability back to source ACs | Must | Low | 2 |
| REQ-007 | Produce an AC coverage summary | Must | Low | 2 |
| REQ-008 | Validate one-to-many coverage before success | Must | Medium | 2 |
| REQ-009 | Flag source ACs that are not manually testable | Should | Medium | 2 |
| REQ-010 | Support implement-trd and implement-trd-beads paths consistently | Should | High | 2 |
| REQ-011 | Make artifact path visible to Foreman | Should | Medium | 2 |
| REQ-012 | Provide deterministic output ordering | Could | Low | 2 |

## Dependency Map

| REQ | Depends On | Blocked By | Notes |
|---|---|---|---|
| REQ-001 | — | — | Core artifact behavior. |
| REQ-002 | REQ-001 | Parser availability | Generation must know source ACs. |
| REQ-003 | REQ-002 | — | Coverage maps parsed ACs to scenarios. |
| REQ-004 | REQ-003 | — | Scenario fields depend on scenario creation. |
| REQ-005 | REQ-004 | — | Formatting wraps scenario fields. |
| REQ-006 | REQ-002, REQ-003 | — | Traceability requires parsed source IDs. |
| REQ-007 | REQ-003, REQ-006 | — | Summary depends on scenario/traceability data. |
| REQ-008 | REQ-003, REQ-007 | — | Validation checks coverage summary data. |
| REQ-009 | REQ-003, REQ-004 | — | Clarification markers apply to weak scenarios. |
| REQ-010 | REQ-001, REQ-002, REQ-008 | Command-flow differences | Both command paths need completion hooks. |
| REQ-011 | REQ-001, REQ-007 | Foreman artifact contract | Reporting uses generated path + coverage. |
| REQ-012 | REQ-002, REQ-003 | — | Stable order follows parsed order. |

No circular dependencies identified.

## Technical Dependency Mapping

| Dependency | Direction | Data / Contract | Notes |
|---|---|---|---|
| `trd-cli.js parse` / TRD parser | read | TRD tasks, AC IDs, traceability | Should remain authoritative source for AC extraction. |
| `implement-trd.yaml` | write/report | Completion phase produces artifact and reports path | Standard implementation path. |
| `implement-trd-beads.yaml` | write/report | Completion phase or delegated build completion produces artifact and reports path | Scope requires clarification for v1. |
| Foreman artifact path/reporting | report | `FOREMAN_ARTIFACT_PATH`, phase report content | Must expose quickstart path under Foreman. |
| Markdown filesystem output | write | `quickstart.md` | Destination needs product decision. |

## Adversarial Review

| Issue | Resolution Applied Under Foreman Mode |
|---|---|
| Artifact path is not specified by the task description. | Defaulted to `quickstart.md` beside `FOREMAN_ARTIFACT_PATH` in Foreman runs and beside the source TRD otherwise. |
| Scope across `implement-trd` vs `implement-trd-beads` is ambiguous. | Scoped v1 generation to standard `implement-trd`; `implement-trd-beads` must explicitly document unsupported status. |
| Generated scenarios could become superficial if source ACs are vague. | Added REQ-009 to preserve ACs and mark scenario-level clarification prompts. |
| Success could be reported even with incomplete AC coverage. | Added REQ-008 as a Must validation gate. |
| Foreman may not see the artifact if only a repo-local file is written. | Added REQ-011 to include path and coverage in phase report. |

Ambiguity scan complete: 3 product ambiguities auto-resolved under Foreman mode; 0 open PRD clarification markers remain. Scenario-level `[NEEDS CLARIFICATION: ...]` text remains as required generated artifact behavior, not open PRD ambiguity.

## Implementation Readiness Gate

| Dimension | Score | Notes |
|---|---:|---|
| Completeness | 4.5 | Covers artifact generation, AC mapping, scenario content, validation, reporting, and command-path integration with v1 scoping clarified. |
| Testability | 4.5 | Every Must/Should requirement has objective Given/When/Then criteria. |
| Clarity | 4.75 | Artifact destination, enablement mode, and beads-backed v1 scope are now explicit. |
| Feasibility | 4.25 | Reuses existing parser and standard command lifecycle; v1 avoids beads-backed implementation risk by documenting unsupported status. |
| **Overall** | **4.50** | **PASS** |

## Next Step

```bash
/ensemble:create-trd docs/PRD/PRD-2026-a490035b-quickstart-validation-artifact.md --foreman
```

## Changelog

### 2026-09-02 — v1.0.1

- Auto-applied Foreman refinement findings for artifact destination, enablement mode, and `implement-trd-beads` v1 scope.
- Updated PRD Health summary counts for risk flags, dependency edges, and open PRD clarification markers.
- Re-scored Implementation Readiness Gate from 4.25 to 4.50 after resolving open product ambiguity.
