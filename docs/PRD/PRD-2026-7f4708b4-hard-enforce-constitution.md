---
document_id: PRD-2026-7f4708b4
label: prd-hard-enforce-constitution
version: 1.0.0
status: Draft
date: Wed Sep 02 2026 14:13:00 GMT-0500 (Central Daylight Time)
scale_depth: STANDARD
total_requirements: 14
readiness_score: 4.25
design_readiness_score: null
---

# PRD-2026-7f4708b4: PRD-1: Hard-enforce constitution

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 12 |
| Should requirements | 2 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 14/14 (100%) |
| Risk flags | 6 |
| Cross-requirement dependencies | 13 |
| [NEEDS CLARIFICATION] markers | 3 |

**Foreman subject read:** `PRD-1: Hard-enforce constitution`  
**Foreman mode:** STANDARD depth auto-selected; clarification interviews skipped.  
**Source description:** Implement hard-gate constitution enforcement in Ensemble spec/plan phases.

## Product Summary

**Problem:** Ensemble currently treats constitution violations as soft gates: spec/plan phase agents may pause, ask for override, or proceed after a human bypass. Spec-Kit's Nine Articles model treats constitutional compliance as a blocking phase gate. Teams using Ensemble for governed architecture need the same non-bypassable enforcement before PRD/TRD generation can report success.

**Who feels the pain:**
- **Developers** who depend on architecture standards being enforced consistently, not only suggested.
- **PMs and technical reviewers** who need spec reviews to catch violations before implementation planning begins.
- **Ensemble maintainers** who must remove ambiguity from command behavior so Foreman runs do not report successful artifacts after constitution failures.

**Solution overview:** Add hard constitution gates to `create-prd` and `create-trd` phase completion. If a draft violates a constitution article, generation blocks with an actionable error referencing the specific article number. The soft-gate path and override affordance are removed for constitution enforcement only; unrelated CONCERNS readiness flows stay unchanged unless they are constitution-backed.

**Success metrics:**
- A violating PRD generation attempt exits without saving a PRD artifact.
- A violating TRD generation attempt exits without saving a TRD artifact.
- Every violation message names at least one constitution article number.
- No user-facing skip/override flag or prompt remains for constitution violations.

## User Analysis

| Role | Pain Today | Desired Outcome |
|------|------------|-----------------|
| Developer | Architecture standards can be bypassed during spec/plan phases. | Violations block before misleading downstream work starts. |
| PM / Product reviewer | Spec reviews may miss policy breaches until implementation. | Constitutional compliance is visible and mandatory before phase completion. |
| Foreman operator | Automated runs can appear successful after soft-gated violations. | Runs fail clearly with article-specific remediation guidance. |
| Ensemble maintainer | Constitution behavior differs from Spec-Kit expectations. | A single hard-gate policy covers PRD and TRD generation. |

## Goals and Non-Goals

### Goals

- Hard-block `create-prd` generation when constitutional compliance fails.
- Hard-block `create-trd` generation when constitutional compliance fails.
- Produce actionable error messages that reference specific constitution article numbers.
- Remove soft-gate mode from constitution enforcement code and command prose.
- Preserve non-constitution readiness gate behavior where this PRD does not explicitly change it.

### Non-Goals

- Implementing a full new constitution authoring workflow.
- Changing implementation-phase completion verification override semantics.
- Rewriting all Spec-Kit Nine Articles; this PRD assumes an existing constitution source, likely `docs/standards/constitution.md` and/or `.specify/memory/constitution.md` [NEEDS CLARIFICATION: Should Ensemble enforce only `docs/standards/constitution.md`, only `.specify/memory/constitution.md`, or both with precedence?].
- Blocking implementation commands unless they currently execute spec/plan constitution gates.
- Adding organization-specific compliance policy beyond constitution article checks.

## Assumptions from Foreman Mode

- Constitution enforcement applies to Ensemble spec/plan phases: `ensemble:create-prd` and `ensemble:create-trd`.
- A violation means any failed check mapped to a constitution article.
- Blocking means no normal phase artifact is saved; a failure report may still be emitted to the Foreman artifact path for observability.
- Article identifiers follow a numeric article format compatible with Spec-Kit's Nine Articles [NEEDS CLARIFICATION: What exact article ID format should messages use: `Article I`, `Article 1`, `A1`, or repo-local headings?].
- Existing non-constitution soft confirmations, such as CONCERNS-band readiness prompts, remain intact unless they are masking a constitution violation.

## Requirements

### Constitution Source and Evaluation

### REQ-001: Detect applicable constitution source
The spec/plan commands must identify the constitution source before checking generated PRD or TRD content. **Priority:** Must | **Complexity:** Medium [RISK: constitution source precedence may affect repos with multiple constitution files]

- AC-001-1: Given a repo has the configured constitution file, when `create-prd` starts its compliance gate, then the gate loads that file before phase completion.
- AC-001-2: Given no supported constitution file exists, when a spec/plan command reaches the compliance gate, then it reports constitution enforcement cannot run and blocks or follows a documented no-constitution policy [NEEDS CLARIFICATION: Should missing constitution block generation, or should it be treated as no enforceable policy?].

### REQ-002: Map checks to article numbers
Every constitution check must be traceable to one or more article numbers. **Priority:** Must | **Complexity:** Medium [RISK: weak mapping would produce unhelpful hard-block errors]

- AC-002-1: Given a constitution article contains enforceable language, when the gate evaluates a draft, then any failure records the article number associated with that language.
- AC-002-2: Given a failed check cannot be mapped to an article number, when the gate formats errors, then validation fails as a gate configuration error rather than emitting an unreferenced violation.

### PRD Phase Enforcement

### REQ-003: Block violating PRD generation
The `create-prd` phase must fail hard when the generated PRD violates the constitution. **Priority:** Must | **Complexity:** High [RISK: changes artifact creation semantics in automated Foreman runs]

- AC-003-1: Given a generated PRD draft violates a constitution article, when `create-prd` reaches the constitution gate, then it does not save the repo-local PRD file.
- AC-003-2: Given a generated PRD draft violates a constitution article in Foreman mode, when the phase exits, then Foreman receives a failed phase report instead of a successful PRD artifact claim.

### REQ-004: Verify PRD compliance before completion
`create-prd` must run constitutional compliance after draft generation and before any success messaging. **Priority:** Must | **Complexity:** Medium

- AC-004-1: Given a compliant PRD draft, when `create-prd` completes, then the command records that constitution compliance passed before printing the final saved file path.
- AC-004-2: Given a failing PRD draft, when `create-prd` formats its final output, then no suggested `/ensemble:create-trd` next step is printed.

### TRD Phase Enforcement

### REQ-005: Block violating TRD generation
The `create-trd` phase must fail hard when the generated TRD violates the constitution. **Priority:** Must | **Complexity:** High [RISK: TRD currently has multiple soft confirmation and auto-pick paths]

- AC-005-1: Given a generated TRD draft violates a constitution article, when `create-trd` reaches the constitution gate, then it does not save the repo-local TRD file.
- AC-005-2: Given a generated TRD draft violates a constitution article in Foreman mode, when the phase exits, then Foreman receives a failed phase report instead of a successful TRD artifact claim.

### REQ-006: Verify TRD compliance before completion
`create-trd` must run constitutional compliance after architecture/task design and before any success messaging. **Priority:** Must | **Complexity:** Medium

- AC-006-1: Given a compliant TRD draft, when `create-trd` completes, then the command records that constitution compliance passed before printing the final saved file path.
- AC-006-2: Given a failing TRD draft, when `create-trd` exits, then no implementation next step is printed.

### User-Facing Failure Behavior

### REQ-007: Remove constitution override prompts
Users must not be offered a skip, override, or proceed-anyway path for constitution violations. **Priority:** Must | **Complexity:** Medium [RISK: existing command prose may contain generic override language]

- AC-007-1: Given a constitution violation occurs in interactive mode, when the error is presented, then no `Proceed anyway`, `Override`, `Skip`, or equivalent option is offered.
- AC-007-2: Given a constitution violation occurs in Foreman mode, when the phase exits, then it fails immediately without assuming default proceed behavior.

### REQ-008: Remove constitution override flags
No CLI flag, env var, or documented command parameter may bypass constitution enforcement. **Priority:** Must | **Complexity:** Low

- AC-008-1: Given a user passes any previous constitution skip/override mechanism, when the command runs, then the mechanism is rejected or ignored and enforcement still runs.
- AC-008-2: Given command docs are generated, when searched for constitution skip semantics, then no supported bypass path is documented.

### REQ-009: Provide actionable article-specific errors
Violation errors must help users fix the PRD/TRD without reading source code. **Priority:** Must | **Complexity:** Medium

- AC-009-1: Given a violation is detected, when the command fails, then the error includes the article number, article title if available, failing artifact section, and remediation hint.
- AC-009-2: Given multiple articles fail, when the error is printed, then all failing article numbers are listed without collapsing to a generic constitution failure.

### REQ-010: Preserve unrelated soft gates
Existing non-constitution CONCERNS-band readiness behavior must remain unchanged. **Priority:** Should | **Complexity:** Medium [RISK: broad refactor could accidentally remove valid human confirmations]

- AC-010-1: Given PRD readiness is CONCERNS but constitution compliance passes, when `create-prd --foreman` runs, then the command still proceeds under the existing Foreman concerns policy.
- AC-010-2: Given TRD design readiness is CONCERNS but constitution compliance passes, when `create-trd --foreman` runs, then the command still proceeds under the existing Foreman concerns policy.

### Validation and Observability

### REQ-011: Add violating PRD regression test
The product test suite must prove violating PRDs hard-block. **Priority:** Must | **Complexity:** Medium

- AC-011-1: Given a fixture PRD draft that violates a constitution article, when the PRD constitution gate test runs, then it asserts no PRD file is saved.
- AC-011-2: Given the same fixture, when the error is inspected, then it asserts an article number appears in the message.

### REQ-012: Add violating TRD regression test
The development test suite must prove violating TRDs hard-block. **Priority:** Must | **Complexity:** Medium

- AC-012-1: Given a fixture TRD draft that violates a constitution article, when the TRD constitution gate test runs, then it asserts no TRD file is saved.
- AC-012-2: Given the same fixture, when the error is inspected, then it asserts an article number appears in the message.

### REQ-013: Validate generated command docs
Generated command artifacts must reflect hard-gate constitution behavior. **Priority:** Must | **Complexity:** Low

- AC-013-1: Given source YAML command changes are made, when `npm run generate` runs, then generated Pi/Claude command docs include hard-block constitution wording.
- AC-013-2: Given generated artifacts are searched, when constitution enforcement sections are found, then they do not contain override language for constitution violations.

### REQ-014: Report constitution gate status
Successful outputs should make constitution compliance auditable. **Priority:** Should | **Complexity:** Low

- AC-014-1: Given a PRD passes the constitution gate, when saved, then its health or notes section records constitution compliance as passed.
- AC-014-2: Given a TRD passes the constitution gate, when saved, then its validation section records constitution compliance as passed.

## Acceptance Criteria Summary

| REQ | Description | Priority | Complexity | AC Count |
|-----|-------------|----------|------------|----------|
| REQ-001 | Detect applicable constitution source | Must | Medium | 2 |
| REQ-002 | Map checks to article numbers | Must | Medium | 2 |
| REQ-003 | Block violating PRD generation | Must | High | 2 |
| REQ-004 | Verify PRD compliance before completion | Must | Medium | 2 |
| REQ-005 | Block violating TRD generation | Must | High | 2 |
| REQ-006 | Verify TRD compliance before completion | Must | Medium | 2 |
| REQ-007 | Remove constitution override prompts | Must | Medium | 2 |
| REQ-008 | Remove constitution override flags | Must | Low | 2 |
| REQ-009 | Provide actionable article-specific errors | Must | Medium | 2 |
| REQ-010 | Preserve unrelated soft gates | Should | Medium | 2 |
| REQ-011 | Add violating PRD regression test | Must | Medium | 2 |
| REQ-012 | Add violating TRD regression test | Must | Medium | 2 |
| REQ-013 | Validate generated command docs | Must | Low | 2 |
| REQ-014 | Report constitution gate status | Should | Low | 2 |

## Non-Functional Requirements

Covered by REQ-009 through REQ-014:
- **Reliability:** constitution failures must be deterministic and non-bypassable.
- **Observability:** outputs and failure reports must expose gate status and article references.
- **Maintainability:** generated docs and source YAML must stay in sync.
- **Security/Governance:** unauthorized policy bypass paths must be removed.

## Dependency Map

| Requirement | Depends On | Notes |
|-------------|------------|-------|
| REQ-001 | None | Foundation: source discovery. |
| REQ-002 | REQ-001 | Checks need loaded source. |
| REQ-003 | REQ-001, REQ-002 | PRD hard block needs evaluator and article map. |
| REQ-004 | REQ-003 | Defines ordering before success output. |
| REQ-005 | REQ-001, REQ-002 | TRD hard block needs evaluator and article map. |
| REQ-006 | REQ-005 | Defines ordering before success output. |
| REQ-007 | REQ-003, REQ-005 | User prompts removed after hard block semantics exist. |
| REQ-008 | REQ-003, REQ-005 | Bypass paths removed after hard block semantics exist. |
| REQ-009 | REQ-002, REQ-003, REQ-005 | Error quality depends on mapped violations. |
| REQ-010 | REQ-003, REQ-005 | Regression guard around adjacent soft gates. |
| REQ-011 | REQ-003, REQ-009 | PRD violation test. |
| REQ-012 | REQ-005, REQ-009 | TRD violation test. |
| REQ-013 | REQ-007, REQ-008 | Docs verify no override creep. |
| REQ-014 | REQ-004, REQ-006 | Audit status after passing gates. |

**Implementation clusters:**
1. Constitution source/evaluator: REQ-001, REQ-002, REQ-009.
2. PRD command hard gate: REQ-003, REQ-004, REQ-011, REQ-014.
3. TRD command hard gate: REQ-005, REQ-006, REQ-012, REQ-014.
4. Override/docs cleanup: REQ-007, REQ-008, REQ-010, REQ-013.

No circular dependencies detected.

## Adversarial Review

| Issue | Risk | Resolution Applied Under Foreman Mode |
|-------|------|---------------------------------------|
| Constitution source precedence is unspecified. | Teams may have both Ensemble and Spec-Kit constitution files. | Added REQ-001 plus clarification marker on source precedence. |
| Missing constitution policy is ambiguous. | Hard enforcement could block all repos without a constitution or silently do nothing. | Added AC-001-2 with clarification marker. |
| Article number format is unspecified. | Error messages may pass tests but not match operator expectations. | Added assumption and clarification marker for article ID format. |
| Removing soft gates too broadly could break legitimate CONCERNS workflows. | Existing Foreman behavior might regress outside constitution failures. | Added REQ-010 to preserve unrelated soft gates. |
| Foreman artifact semantics can conflict with "do not save PRD/TRD" on failure. | Foreman still needs a phase report even when artifact generation blocks. | Clarified in assumptions that failure reports may be emitted while repo-local PRD/TRD artifacts are not saved. |

## Implementation Readiness Gate

| Dimension | Score | Notes |
|-----------|-------|-------|
| Completeness | 4 | Covers PRD, TRD, errors, overrides, docs, and tests. Constitution source precedence remains open. |
| Testability | 5 | Every requirement has concrete Given/When/Then ACs. |
| Clarity | 4 | Hard-block semantics are explicit; three source/format questions need confirmation. |
| Feasibility | 4 | Fits existing Node/Jest/YAML generator architecture but may require evaluator design. |

**Overall score:** 4.25  
**Gate decision:** PASS

Ambiguity scan complete: 3 items marked for clarification.

## Technical Dependency Mapping

- `packages/product/commands/create-prd.yaml`: source workflow for PRD generation behavior.
- `packages/development/commands/create-trd.yaml`: source workflow for TRD generation behavior.
- `scripts/generate-markdown.js`: required after YAML source changes to keep generated artifacts current.
- `packages/product/tests/create-prd-command.test.js`: likely product command regression test surface.
- `packages/development/tests/create-trd-command.test.js`: likely TRD command regression test surface.
- `docs/standards/constitution.md` and `.specify/memory/constitution.md`: candidate constitution sources; final precedence TBD.
- Foreman phase artifact path (`FOREMAN_ARTIFACT_PATH`): failure reporting should remain observable without claiming a saved PRD/TRD artifact.

## Cross-Cutting Requirements from Existing PRDs

- Preserve generated artifact policy: edit YAML command sources, then regenerate markdown artifacts.
- Preserve Foreman subject contract: the dispatched task subject, not repo recency, controls PRD/TRD content.
- Preserve existing readiness gate semantics unless a constitution violation is present.

## Suggested Next Step

Resolve the 3 clarification markers, then run:

```bash
/ensemble:create-trd docs/PRD/PRD-2026-7f4708b4-hard-enforce-constitution.md --foreman
```
