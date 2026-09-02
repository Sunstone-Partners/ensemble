---
document_id: TRD-2026-d63594c0
label: trd-standalone-trd-artifacts
prd_reference: PRD-2026-d63594c0
version: 1.0.0
status: Draft
date: 2026-09-02
design_readiness_score: 4.75
kind: trd
---

# TRD-2026-d63594c0: Standalone research.md and data-model.md Artifacts for create-trd

**Foreman task subject read:** `PRD-2: Standalone research.md data-model.md`

**Source PRD:** `docs/PRD/PRD-2026-d63594c0-standalone-trd-artifacts.md` (v1.0.1, readiness 4.75 — PASS)

## Domain Analysis

Detected domains: command/prompt contract, generated artifact output, file naming, traceability, generated-doc synchronization, and prompt-contract tests. This is a brownfield change in the Ensemble plugin repo. The implementation is primarily in `packages/development/commands/create-trd.yaml`, with generated command/skill artifacts refreshed through the existing generation pipeline and focused Jest coverage under `packages/development/tests/create-trd-command.test.js`.

MCP enhancement: skipped (no MCP tools detected).

## Reused Capabilities

`node packages/development/lib/trd-graph-cli.js capabilities docs/TRD --json` returned an empty capability registry. `overlap docs/TRD` found no foundational TRD providing create-trd companion artifact generation. **Reused Capabilities: none.** This work should stay in this TRD because it changes one existing command contract rather than creating a broadly reusable library capability.

## Architecture Decision

Foreman mode: auto-selected Option C (brownfield, prompt-contract-first update that extends the existing create-trd generation flow and validation tests without introducing a new runtime service).

### Alternatives Considered

| Option | Approach | Pros | Cons | Risk |
|---|---|---|---|---|
| A — Minimal prose-only | Add brief companion artifact instructions to `create-trd.yaml` and regenerate markdown | Fastest; very small diff | Weak parsing/traceability guarantees; likely to drift from Foreman artifact reporting | Medium |
| B — New artifact engine | Build a Node helper that parses PRDs and writes TRD companions independently of the command prompt | Stronger enforcement; reusable | Overbuilds a prompt-driven command; new CLI/API surface not requested | High |
| **C — Existing command contract extension (chosen)** | Extend `create-trd.yaml` phases to classify domains, derive deterministic companion paths, author templates, link artifacts, report outputs, self-check contract, then regenerate downstream artifacts and add focused tests | Matches existing architecture; safest for Pi/Claude plugin outputs; keeps source-of-truth in YAML; testable by contract assertions | Still relies on agents following command prose, mitigated by explicit self-check actions and tests | Low |

### Rationale

Option C aligns with the current architecture: command behavior is defined in YAML, generated markdown/skills are derived artifacts, and `create-trd-command.test.js` already pins critical command contract language. It avoids duplicating command logic in a separate engine while making companion artifact behavior explicit enough for Foreman and human operators to validate.

## System Architecture

### Components

| Component | Location | Responsibility |
|---|---|---|
| Create TRD command source | `packages/development/commands/create-trd.yaml` | Source of truth for domain detection, companion artifact generation, naming, linking, traceability, and Foreman reporting instructions |
| Generated command markdown | `packages/development/commands/ensemble/create-trd.md` | Claude/plugin command artifact generated from YAML |
| Pi prompt/skill artifacts | `packages/pi/prompts/ensemble-create-trd.md`, `packages/pi/skills/ensemble-create-trd/SKILL.md` | Pi-published generated artifacts refreshed by the existing pipeline |
| Command contract tests | `packages/development/tests/create-trd-command.test.js` | Jest assertions that lock domain trigger, template, naming, no-domain, and Foreman-report instructions |
| Existing generation pipeline | `scripts/generate-markdown.js`, package Pi generation scripts | Keeps source YAML and generated markdown/skill artifacts synchronized |
| Existing TRD parser check | `packages/development/lib/trd-cli.js parse` | Continues to validate Master Task List checkbox parseability |

### Data Flow

```text
Source PRD
  -> create-trd Domain Analysis classifies database/data-model and research domains
  -> output path derivation computes TRD-YYYY-<micro_uuid>-<slug>.md
  -> selected companion paths append -data-model.md and/or -research.md
  -> TRD Companion Artifacts section links to generated companion files
  -> companion artifacts include generated note, PRD/TRD ids, back-link, REQ/AC refs, template sections
  -> terminal summary and Foreman phase report include all generated paths
```

### Integration Points

| Integration | Protocol/Format | Notes |
|---|---|---|
| Filesystem writes | Markdown files under `docs/TRD/` | Companion artifacts live beside the TRD using deterministic correlation-family filenames |
| Foreman artifact contract | `FOREMAN_ARTIFACT_PATH` markdown phase report | Report must include TRD and companion artifact paths when present |
| Generated-doc policy | Source YAML + generated markdown/skill outputs | Source changed first, generated artifacts refreshed by `npm run generate` / Pi generation as applicable |
| Tests | Jest via package test script | Contract tests scan YAML source and generated artifacts for required language |

### Error Handling and Edge Cases

- If no companion domains are detected, only the TRD is written and the summary prints `No companion artifacts generated.`
- If one companion domain is detected, only that artifact is written; no empty placeholders.
- If required template details are absent from the source PRD/TRD context, the generated companion uses the command's standard needs-clarification placeholder convention instead of invented detail.
- If `FOREMAN_ARTIFACT_PATH` is unset, behavior remains unchanged outside Foreman.
- If generation changes source-derived markdown unexpectedly, tests fail until generated artifacts are synchronized.

## Master Task List

### PR 1: Domain trigger and output-path contract
**Shippable State:** Running `/ensemble:create-trd` on a PRD now has an explicit, reviewable contract for deciding whether companion artifacts are required and for deriving their deterministic paths; no artifact templates are emitted until PR 2.

- [ ] **TRD-001** Extend `packages/development/commands/create-trd.yaml` Domain Analysis actions to classify `database/data-model` and `research/technology-decision` companion domains using persistence/schema and comparative technology/integration signals, including explicit incidental-data and routine-architecture no-op cases [satisfies REQ-001, REQ-002, REQ-003, REQ-004] (4h)
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-003-1, AC-003-2, AC-004-1
  - Implementation AC: Given PRD text with entities, schemas, migrations, persistence, relationships, records, or database changes, when Domain Analysis runs, then it records `data-model.md` as required.
  - Implementation AC: Given PRD text with only read-only display data, when Domain Analysis runs, then it does not require `data-model.md` unless another persistence signal exists.
  - Implementation AC: Given PRD text with comparative technology, integration, architecture, dependency, or vendor decisions, when Domain Analysis runs, then it records `research.md` as required.

- [ ] **TRD-001-TEST** Add command-contract tests that assert the YAML contains database/data-model and research trigger language plus no-op guards for incidental data and routine architecture [verifies TRD-001] [satisfies REQ-001, REQ-002, REQ-003, REQ-004] [depends: TRD-001] (3h)
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-003-2, AC-004-1

- [ ] **TRD-002** Add companion output path derivation instructions to TRD Document Generation/File Save: reuse the TRD micro UUID and slug, write beside the TRD in `docs/TRD/`, and use `-research.md` / `-data-model.md` suffixes only for detected domains [satisfies REQ-003, REQ-007] [depends: TRD-001] (3h)
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-007-1, AC-007-2
  - Implementation AC: Given TRD path `docs/TRD/TRD-2026-d63594c0-standalone-trd-artifacts.md`, when both domains are detected, then companion paths are `docs/TRD/TRD-2026-d63594c0-standalone-trd-artifacts-research.md` and `docs/TRD/TRD-2026-d63594c0-standalone-trd-artifacts-data-model.md`.

- [ ] **TRD-002-TEST** Add tests that pin deterministic companion filename examples and stable rerun language in `create-trd.yaml` [verifies TRD-002] [satisfies REQ-003, REQ-007] [depends: TRD-002] (2h)
  - Validates PRD ACs: AC-003-1, AC-007-1, AC-007-2

### PR 2: Companion artifact templates and generated-doc policy
**Shippable State:** When a detected domain requires a companion, `/ensemble:create-trd` now writes a complete standalone artifact with required sections, source IDs, generated-artifact note, and safe clarification placeholders.

- [ ] **TRD-003** Add `data-model.md` authoring instructions and template sections to `create-trd.yaml`: Overview, Entities, Relationships, Data Ownership, Migration/Backfill Notes, Validation Rules, Privacy/Security Notes, and Open Questions [satisfies REQ-005, REQ-009, REQ-011, REQ-012] [depends: TRD-002] (5h)
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-009-1, AC-009-2, AC-011-1, AC-012-1
  - Implementation AC: Given incomplete source context for any required data-model section, when generated, then the section exists with a specific standard needs-clarification placeholder rather than fabricated detail.
  - Implementation AC: Given generated `data-model.md`, when opened, then it names the source TRD id, source PRD id, relative TRD back-link, relevant REQ/AC refs, and generated-artifact note.

- [ ] **TRD-003-TEST** Add command-contract tests for every required `data-model.md` template section, generated note, source IDs, back-link, and clarification placeholder instruction [verifies TRD-003] [satisfies REQ-005, REQ-009, REQ-011, REQ-012] [depends: TRD-003] (3h)
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-009-1, AC-009-2, AC-011-1, AC-012-1

- [ ] **TRD-004** Add `research.md` authoring instructions and template sections to `create-trd.yaml`: Decision Context, Options Considered, Evaluation Criteria, Recommendation, Tradeoffs/Risks, Rejected Alternatives, and Open Questions [satisfies REQ-006, REQ-009, REQ-011, REQ-012] [depends: TRD-002] (5h)
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-009-1, AC-009-2, AC-011-1, AC-012-1
  - Implementation AC: Given generated `research.md`, when opened, then it expands comparative rationale, links back to the TRD architecture decision, and does not replace or contradict the TRD's chosen architecture section.
  - Implementation AC: Given generated `research.md`, when source details are insufficient, then Open Questions contains specific standard clarification placeholders.

- [ ] **TRD-004-TEST** Add command-contract tests for every required `research.md` template section, generated note, source IDs, back-link, and separation-from-TRD-architecture language [verifies TRD-004] [satisfies REQ-006, REQ-009, REQ-011, REQ-012] [depends: TRD-004] (3h)
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-009-1, AC-009-2, AC-011-1, AC-012-1

### PR 3: TRD linking, traceability, and reporting
**Shippable State:** Generated TRDs become the navigation hub for any companion artifacts, artifact contents remain traceable to PRD REQs/ACs, and Foreman/operator summaries list exactly what was written.

- [ ] **TRD-005** Add TRD `## Companion Artifacts` section instructions that include relative links only to artifacts actually generated, plus task/architecture references that point to companions instead of duplicating full artifact content [satisfies REQ-008, REQ-011] [depends: TRD-003, TRD-004] (4h)
  - Validates PRD ACs: AC-008-1, AC-008-2, AC-011-2
  - Implementation AC: Given no companion artifacts are generated, when the TRD is written, then the section is omitted or explicitly states no companions without broken links.
  - Implementation AC: Given a task depends on a research or data-model decision, when the task is written, then it references the companion artifact path and relevant REQ/AC ids rather than copying the entire artifact body.

- [ ] **TRD-005-TEST** Add tests that assert companion links are relative, conditional, and not emitted for no-domain cases [verifies TRD-005] [satisfies REQ-008, REQ-011] [depends: TRD-005] (3h)
  - Validates PRD ACs: AC-008-1, AC-008-2, AC-011-2

- [ ] **TRD-006** Extend terminal output and Foreman phase report instructions to print the TRD path and each generated companion artifact path, while preserving the exact `FOREMAN_ARTIFACT_PATH` write contract [satisfies REQ-014] [depends: TRD-005] (3h)
  - Validates PRD ACs: AC-014-1, AC-014-2
  - Implementation AC: Given `FOREMAN_ARTIFACT_PATH` is set and companion artifacts are generated, when the phase report is written, then it includes the TRD path and all companion paths.
  - Implementation AC: Given no companion domains are detected, when the command completes, then it prints `No companion artifacts generated.`.

- [ ] **TRD-006-TEST** Add tests pinning companion artifact summary output, no-domain no-op output, and Foreman phase-report artifact path requirements [verifies TRD-006] [satisfies REQ-004, REQ-014] [depends: TRD-006] (2h)
  - Validates PRD ACs: AC-004-1, AC-014-1, AC-014-2

### PR 4: Generated artifacts sync and full validation
**Shippable State:** The source command contract, generated Claude/Pi artifacts, and tests all agree; reviewers can independently diff the generated research/data-model guidance and existing no-companion workflows remain compatible.

- [ ] **TRD-007** Regenerate derived command and Pi artifacts from the updated YAML using the existing generation pipeline, keeping generated markdown/skills synchronized with source [satisfies REQ-010, REQ-012] [depends: TRD-001, TRD-002, TRD-003, TRD-004, TRD-005, TRD-006] (3h)
  - Validates PRD ACs: AC-010-1, AC-012-2
  - Implementation AC: Given source YAML changes, when `npm run generate` and the repo's Pi generation step run, then `packages/development/commands/ensemble/create-trd.md` and Pi outputs reflect the new companion artifact contract.

- [ ] **TRD-007-TEST** Add/gate generated-artifact synchronization checks so rerunning generation leaves no uncommitted diffs for create-trd artifacts [verifies TRD-007] [satisfies REQ-012] [depends: TRD-007] (2h)
  - Validates PRD ACs: AC-012-2

- [ ] **TRD-008** Run and document focused validation for command-contract tests, parser self-check, generation cleanliness, and repo validation [satisfies REQ-010, REQ-013] [depends: TRD-007] (3h)
  - Validates PRD ACs: AC-010-2, AC-013-1, AC-013-2
  - Implementation AC: Given database-domain, research-domain, both-domain, and no-domain fixture snippets, when tests inspect the command contract, then they assert required companion behavior and absence of placeholder artifacts.

- [ ] **TRD-008-TEST** Ensure CI/focused Jest coverage includes database-domain requires `data-model.md`, research-domain requires `research.md`, both-domain emits both, and no-domain emits none [verifies TRD-008] [satisfies REQ-013] [depends: TRD-008] (4h)
  - Validates PRD ACs: AC-013-1, AC-013-2

## Dependency Graph and Critical Path

Critical path: TRD-001 → TRD-002 → TRD-003/TRD-004 → TRD-005 → TRD-006 → TRD-007 → TRD-008. No circular dependencies identified. No task is 8h or larger; no forced breakdown needed.

## Sprint Planning

## Sprint 1: Trigger/path contract

- PR 1: TRD-001 through TRD-002-TEST. Estimated 12h.

## Sprint 2: Templates

- PR 2: TRD-003 through TRD-004-TEST. Estimated 16h.

## Sprint 3: Links/reporting

- PR 3: TRD-005 through TRD-006-TEST. Estimated 12h.

## Sprint 4: Generation and validation

- PR 4: TRD-007 through TRD-008-TEST. Estimated 12h.

## Acceptance Criteria Traceability

| REQ | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Detect database/data-model domain | TRD-001 | TRD-001-TEST |
| REQ-002 | Detect research/technology-decision domain | TRD-001 | TRD-001-TEST |
| REQ-003 | Generate only required companion artifacts | TRD-001, TRD-002 | TRD-001-TEST, TRD-002-TEST |
| REQ-004 | Preserve no-domain behavior | TRD-001, TRD-006 | TRD-001-TEST, TRD-006-TEST |
| REQ-005 | Provide consistent `data-model.md` template | TRD-003 | TRD-003-TEST |
| REQ-006 | Provide consistent `research.md` template | TRD-004 | TRD-004-TEST |
| REQ-007 | Maintain deterministic artifact naming | TRD-002 | TRD-002-TEST |
| REQ-008 | Link companion artifacts from TRD | TRD-005 | TRD-005-TEST |
| REQ-009 | Link artifacts back to source TRD and PRD | TRD-003, TRD-004 | TRD-003-TEST, TRD-004-TEST |
| REQ-010 | Support independent git review | TRD-007, TRD-008 | TRD-007-TEST |
| REQ-011 | Preserve requirement traceability | TRD-003, TRD-004, TRD-005 | TRD-003-TEST, TRD-004-TEST, TRD-005-TEST |
| REQ-012 | Generated-artifact policy compatibility | TRD-003, TRD-004, TRD-007 | TRD-003-TEST, TRD-004-TEST, TRD-007-TEST |
| REQ-013 | Validate artifact generation in tests | TRD-008 | TRD-008-TEST |
| REQ-014 | Report generated artifact outcomes | TRD-006 | TRD-006-TEST |

Traceability check: 14 requirements covered, 0 uncovered, 0 orphaned annotations.

## Adversarial Review

### Architecture Self-Critique

| Issue | Severity | Resolution |
|---|---|---|
| Domain detection could be scattered across Domain Analysis and Output Management, causing contradictory generation decisions. | Medium | TRD-001 records companion-domain decisions once during Domain Analysis; TRD-002 and later tasks consume that recorded decision. |
| Generated companion content could contradict the TRD architecture decision if written as a second decision source. | Medium | TRD-004 requires `research.md` to expand comparative rationale and link to the TRD architecture decision, not replace it. |
| Foreman could miss companion paths if only terminal output changes. | Medium | TRD-006 explicitly updates both terminal summary and `FOREMAN_ARTIFACT_PATH` phase report instructions. |

### Task Coverage Analysis

Coverage is complete: every PRD REQ-001 through REQ-014 has at least one implementation task and one paired test task. All task lines use the required checkbox prefix and `TRD-NNN`/`TRD-NNN-TEST` IDs. Every PR section has a user-observable Shippable State.

Task coverage issues logged for design hygiene:

| Issue | Resolution |
|---|---|
| REQ-010 independent git review is partly an emergent outcome of separate files, not a standalone runtime feature. | Covered by TRD-007 generated artifact synchronization and TRD-008 validation; no extra implementation task needed. |
| No-domain compatibility could regress if summary/report logic assumes companion arrays are non-empty. | Covered by TRD-006 and TRD-006-TEST explicit no-domain no-op output. |

### Dependency and Estimate Review

Dependency depth reaches 7 along the critical path but each PR is independently shippable and estimates remain under 8h. The deepest chain is acceptable because later PRs depend on earlier contract text, templates, linking, and report language. Similar command-contract test tasks are consistently estimated at 2–3h; template tasks are 5h because they define multiple sections and cross-links.

### Testability Review

All implementation ACs have objective pass/fail checks based on source text, generated paths, generated file sections, or command summary/report content. No subjective-only acceptance criteria remain.

## Design Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|---|:-:|---|
| Architecture completeness | 4.8 | Components, data flow, integration points, path derivation, and Foreman reporting are defined. |
| Task coverage | 4.8 | All 14 PRD requirements have implementation and test coverage. |
| Dependency clarity | 4.7 | Dependencies are explicit and acyclic; critical path is long but intentional. |
| Estimate confidence | 4.7 | No task exceeds 5h except none; estimates are granular and consistent. |
| **Overall** | **4.75** | **PASS** |

**Gate decision:** PASS.

## Next Steps

- Review and approve this TRD before implementation.
- Suggested implementation command: `/ensemble-implement-trd-beads docs/TRD/TRD-2026-d63594c0-standalone-trd-artifacts.md`
- Optional team configuration: `/ensemble-configure-team docs/TRD/TRD-2026-d63594c0-standalone-trd-artifacts.md`
