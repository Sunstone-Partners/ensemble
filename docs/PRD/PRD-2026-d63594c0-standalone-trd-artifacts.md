---
document_id: PRD-2026-d63594c0
label: prd-standalone-trd-artifacts
version: 1.0.1
status: Draft
date: 2026-09-02
scale_depth: STANDARD
total_requirements: 14
readiness_score: 4.75
design_readiness_score: null
---

# PRD-2026-d63594c0: Standalone research.md and data-model.md Artifacts for create-trd

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 10 |
| Should requirements | 4 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 14/14 (100%) |
| Risk flags | 6 |
| Cross-requirement dependencies | 13 |
| Unresolved clarification markers | 0 |

## Product Summary

**Foreman task subject read:** `PRD-2: Standalone research.md data-model.md`.

**Problem:** Ensemble's `/ensemble:create-trd` command currently embeds research decisions and data-model details directly in the TRD body. Architects and DBAs must review the full TRD to find domain-specific decisions, which makes technology-decision review, schema approval, and audit trails harder than necessary. Spec-Kit-style workflows produce standalone artifacts that can be versioned, reviewed, and referenced independently.

**Solution:** Extend `create-trd` output so, when its domain analysis detects research or database/data-model scope in the source PRD, it writes standalone `research.md` and/or `data-model.md` companion artifacts next to the generated TRD and adds relative links between the TRD and those artifacts. The artifacts use consistent templates and preserve existing TRD behavior for PRDs with no matching domain.

**Value proposition:** TRD consumers get focused, separately reviewable artifacts for technology research and data-model decisions without losing the existing all-in-one TRD handoff path.

**Target users:**
- **Architects:** review technology options, tradeoffs, and decision rationale without reading every task detail in the TRD.
- **DBAs/data reviewers:** review entities, schema implications, migration concerns, and data ownership separately from implementation tasks.
- **TRD authors and implementers:** rely on generated relative links so the TRD remains the navigation hub for all planning artifacts.

**Assumptions auto-applied under Foreman mode:**
- Standard PRD depth selected because `--foreman` was active.
- Companion artifacts are generated only by `create-trd`, not by `create-prd` or implementation commands.
- Companion artifacts are saved beside the generated TRD in `docs/TRD/` using the same correlation family; no per-feature subdirectory is introduced in v1.
- Domain detection is keyword/requirement based in v1, using the existing create-trd Domain Analysis step rather than a new ML classifier.

## User Analysis

| User | Pain Today | Needed Outcome |
|------|------------|----------------|
| Architect | Research decisions are buried in long TRDs | Can open a focused `research.md` containing options, rationale, and open questions |
| DBA/data reviewer | Data-model implications are mixed with task breakdown | Can approve a focused `data-model.md` with entities, relationships, migrations, and data risks |
| Implementer | Separate docs can drift from the TRD | Gets clear bidirectional links and task references from the TRD to artifacts |
| Reviewer/auditor | Cannot tell whether research/schema sections changed independently | Can review artifact diffs independently in git/PR review |

## Goals and Non-Goals

**Goals:**
- Generate standalone `research.md` when research/technology-decision domains are detected.
- Generate standalone `data-model.md` when database/data-model domains are detected.
- Link the generated TRD to companion artifacts with relative references and link each artifact back to the TRD.
- Use consistent templates that are parseable by humans and stable in diffs.
- Preserve current behavior for TRDs without detected research or database domains.

**Non-Goals:**
- Do not implement the artifact generation in this PRD.
- Do not redesign the full TRD format.
- Do not create a separate review workflow, approval UI, or external storage system for artifacts.
- Do not require new paid infrastructure or external services.
- Do not migrate historical TRDs automatically.

## Requirements by Feature Area

### Domain Detection and Generation Triggers

### REQ-001: Detect database/data-model domain
**Priority:** Must | **Complexity:** Medium | **[RISK: false positives could create noisy data-model artifacts for features with incidental data wording]**

- AC-001-1: Given a source PRD contains requirements about entities, schemas, migrations, persistence, relationships, records, or database changes, when `create-trd` performs Domain Analysis, then it classifies the TRD as requiring a `data-model.md` companion artifact.
- AC-001-2: Given a source PRD mentions data only as read-only display text with no persistence/schema implications, when `create-trd` performs Domain Analysis, then it does not generate `data-model.md` unless another database signal is present.

### REQ-002: Detect research/technology-decision domain
**Priority:** Must | **Complexity:** Medium | **[RISK: weak research detection could miss architectural research that reviewers expect to inspect separately]**

- AC-002-1: Given a source PRD contains unresolved or comparative technology, integration, architecture, dependency, or vendor decisions, when `create-trd` performs Domain Analysis, then it classifies the TRD as requiring a `research.md` companion artifact.
- AC-002-2: Given a source PRD only needs routine implementation in existing patterns, when `create-trd` performs Domain Analysis, then it does not generate `research.md` solely because normal architecture rationale exists in the TRD.

### REQ-003: Generate only required companion artifacts
**Priority:** Must | **Complexity:** Low

- AC-003-1: Given both database and research domains are detected, when `create-trd` saves outputs, then it writes both `data-model.md` and `research.md`.
- AC-003-2: Given only one domain is detected, when `create-trd` saves outputs, then it writes only the matching artifact and does not create an empty placeholder for the other domain.

### REQ-004: Preserve no-domain behavior
**Priority:** Must | **Complexity:** Low

- AC-004-1: Given no database or research domain is detected, when `create-trd` completes, then it writes the TRD exactly as before and prints an explicit informational no-op line: `No companion artifacts generated.`
- AC-004-2: Given an existing workflow expects only a TRD file, when no companion artifacts are generated, then existing parser and implementation commands continue to work without requiring configuration changes.

### Artifact Content and Templates

### REQ-005: Provide a consistent `data-model.md` template
**Priority:** Must | **Complexity:** Medium | **[RISK: an underspecified template could become a dumping ground and fail DBA review needs]**

- AC-005-1: Given `data-model.md` is generated, when a reviewer opens it, then it contains sections for Overview, Entities, Relationships, Data Ownership, Migration/Backfill Notes, Validation Rules, Privacy/Security Notes, and Open Questions.
- AC-005-2: Given the source PRD lacks enough information for a required section, when `data-model.md` is generated, then that section is present with a specific inline clarification placeholder using the command's standard needs-clarification convention rather than fabricated detail.

### REQ-006: Provide a consistent `research.md` template
**Priority:** Must | **Complexity:** Medium | **[RISK: poor separation between research and architecture decisions could duplicate or contradict the TRD]**

- AC-006-1: Given `research.md` is generated, when a reviewer opens it, then it contains sections for Decision Context, Options Considered, Evaluation Criteria, Recommendation, Tradeoffs/Risks, Rejected Alternatives, and Open Questions.
- AC-006-2: Given `create-trd` already documents the chosen architecture in the TRD, when `research.md` is generated, then the artifact expands comparative rationale and links to the TRD rather than replacing the TRD's architecture decision.

### REQ-007: Maintain deterministic artifact naming
**Priority:** Must | **Complexity:** Low

- AC-007-1: Given a TRD is saved as `docs/TRD/TRD-YYYY-<micro_uuid>-<slug>.md`, when companion artifacts are generated, then their filenames are `docs/TRD/TRD-YYYY-<micro_uuid>-<slug>-research.md` and/or `docs/TRD/TRD-YYYY-<micro_uuid>-<slug>-data-model.md`.
- AC-007-2: Given `create-trd` is rerun for the same source PRD, when the same domains are detected, then generated companion artifact paths remain stable.

### Linking, Traceability, and Versioning

### REQ-008: Link companion artifacts from the TRD
**Priority:** Must | **Complexity:** Low

- AC-008-1: Given one or more companion artifacts are generated, when the TRD is written, then it includes a Companion Artifacts section with relative links to each artifact.
- AC-008-2: Given no companion artifacts are generated, when the TRD is written, then it does not include broken links or references to missing files.

### REQ-009: Link artifacts back to the source TRD and PRD
**Priority:** Must | **Complexity:** Low

- AC-009-1: Given a companion artifact is generated, when a reviewer opens it, then its frontmatter or header names the source TRD document id and source PRD document id.
- AC-009-2: Given the artifact has a source TRD, when a reviewer opens it, then it includes a relative back-link to the TRD.

### REQ-010: Support independent git review
**Priority:** Should | **Complexity:** Low

- AC-010-1: Given a PR contains generated TRD companions, when a reviewer views the diff, then research and data-model changes appear in separate files from the TRD.
- AC-010-2: Given only research content changes between runs, when the artifact is regenerated, then unrelated data-model content remains unchanged unless its input changed.

### REQ-011: Preserve requirement traceability
**Priority:** Must | **Complexity:** Medium | **[RISK: standalone artifacts could become untraceable narrative docs if they omit REQ/AC references]**

- AC-011-1: Given a companion artifact describes decisions or data structures tied to source requirements, when it is generated, then it references the relevant `REQ-NNN` and/or `AC-NNN-M` identifiers.
- AC-011-2: Given a TRD task depends on a companion artifact decision, when the TRD is generated, then the task or architecture section references the artifact rather than duplicating the full content.

### Compatibility, Safety, and Operations

### REQ-012: Keep generated artifacts compatible with existing generated-doc policy
**Priority:** Should | **Complexity:** Low

- AC-012-1: Given a companion artifact is generated from command logic, when it is saved, then it includes a clear generated-artifact note stating that it was generated by `/ensemble:create-trd` from the source PRD/TRD context and should be regenerated from source inputs rather than hand-edited when command output changes.
- AC-012-2: Given command markdown is generated from YAML sources, when this feature is implemented, then source YAML and generated markdown stay synchronized through the existing generation pipeline.

### REQ-013: Validate artifact generation in tests
**Priority:** Should | **Complexity:** Medium | **[RISK: command behavior is mostly prompt/YAML-driven, so regressions can slip through without prompt-contract tests]**

- AC-013-1: Given the create-trd command contract changes, when tests run, then focused tests assert database-domain input requires `data-model.md` guidance and research-domain input requires `research.md` guidance.
- AC-013-2: Given no matching domain input, when tests run, then they assert the command contract does not require companion artifacts.

### REQ-014: Report generated artifact outcomes
**Priority:** Should | **Complexity:** Low

- AC-014-1: Given companion artifacts are generated, when `create-trd` finishes, then its terminal/phase summary prints the TRD path and each companion artifact path.
- AC-014-2: Given `FOREMAN_ARTIFACT_PATH` is set for the create-trd phase, when the phase report is written, then the report includes companion artifact paths so Foreman can surface them to operators.

## Ambiguity Scan

Ambiguity scan complete: 0 items marked for clarification after Foreman-mode defaults were applied.

## Dependency Map

| REQ | Depends On | Notes |
|-----|------------|-------|
| REQ-001 | — | Database trigger signal |
| REQ-002 | — | Research trigger signal |
| REQ-003 | REQ-001, REQ-002 | Output selection depends on domain classification |
| REQ-004 | REQ-003 | Compatibility path for no selected artifacts |
| REQ-005 | REQ-001, REQ-003 | Data-model content only exists if generated |
| REQ-006 | REQ-002, REQ-003 | Research content only exists if generated |
| REQ-007 | REQ-003 | Naming applies to selected artifacts |
| REQ-008 | REQ-003, REQ-007 | TRD links need known output paths |
| REQ-009 | REQ-007, REQ-008 | Back-links need source and paths |
| REQ-010 | REQ-005, REQ-006 | Independent review requires separate populated files |
| REQ-011 | REQ-005, REQ-006, REQ-008 | Traceability spans artifact content and TRD refs |
| REQ-012 | REQ-007 | Generated-doc policy depends on artifact shape/names |
| REQ-013 | REQ-001, REQ-002, REQ-003 | Tests pin trigger behavior |
| REQ-014 | REQ-003, REQ-007 | Summary reports actual generated paths |

**Implementation clusters:** {REQ-001, REQ-002, REQ-003, REQ-004} domain trigger contract · {REQ-005, REQ-006, REQ-011} artifact templates and traceability · {REQ-007, REQ-008, REQ-009, REQ-010, REQ-012, REQ-014} output/link/report behavior · {REQ-013} validation.

No circular dependencies identified.

## Adversarial Review

| Issue | Category | Resolution |
|-------|----------|------------|
| Artifact location is ambiguous if plain `research.md`/`data-model.md` are used in flat `docs/TRD/`. | Ambiguity | Resolved by requiring companion artifacts beside the generated TRD in `docs/TRD/` with correlation-family filenames. |
| Domain detection can over-generate artifacts for incidental words like “data”. | Missing edge case | Added AC-001-2 to prevent generation when there is no persistence/schema implication. |
| Research content could duplicate the TRD architecture decision and drift. | Contradiction | Added AC-006-2 requiring research to expand comparative rationale, not replace the TRD decision. |
| Standalone artifacts may lose REQ/AC traceability. | Gap | Added REQ-011 with REQ/AC reference requirements. |
| Foreman output could hide generated companion artifacts from operators. | Gap | Added REQ-014 with phase-summary/Foreman artifact reporting. |
| Prompt/YAML-only behavior may regress without tests. | Testability | Added REQ-013 focused tests for command contract behavior. |

All recommended resolutions above were auto-applied under Foreman mode. No unresolved clarification markers remain.

## Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|-----------|:-:|-------|
| Completeness | 4.8 | Covers detection, generation, templates, naming, links, traceability, compatibility, tests, and reporting with no open clarification markers. |
| Testability | 4.8 | Every Must/Should requirement has GWT ACs, including concrete no-domain, naming, reporting, and generated-note assertions. |
| Clarity | 4.7 | Artifact path, naming, no-domain logging, and generated-artifact policy are now explicit. |
| Feasibility | 4.7 | Fits existing create-trd YAML/markdown generation, docs/TRD outputs, Node tests, and Foreman artifact summaries without new infrastructure. |
| **Overall** | **4.75** | **PASS** |

**Gate decision: PASS.** Recommended next step: `/ensemble:create-trd docs/PRD/PRD-2026-d63594c0-standalone-trd-artifacts.md --foreman`.

## Changelog

### 2026-09-02 — v1.0.1

- Resolved all 4 Foreman-mode clarification markers with best-effort defaults.
- Fixed companion artifact location and naming to use `docs/TRD/TRD-YYYY-<micro_uuid>-<slug>-research.md` and `...-data-model.md` beside the generated TRD.
- Required no-domain runs to print `No companion artifacts generated.` without changing TRD output behavior.
- Required generated companion artifacts to include a clear generated-artifact note.
- Updated PRD Health summary and readiness score from 4.35 to 4.75.
