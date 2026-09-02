---
document_id: TRD-2026-7f4708b4
label: trd-hard-enforce-constitution
kind: trd
prd_reference: PRD-2026-7f4708b4 (docs/PRD/PRD-2026-7f4708b4-hard-enforce-constitution.md v1.0.1)
version: 1.0.0
status: Draft
date: 2026-09-02
design_readiness_score: 4.75
---

# TRD-2026-7f4708b4: PRD-1: Hard-enforce constitution

**Foreman subject read:** `PRD-1: Hard-enforce constitution`
**Source PRD:** `docs/PRD/PRD-2026-7f4708b4-hard-enforce-constitution.md` (v1.0.1, readiness 4.75 PASS)
**Scope:** planning-only TRD for hard constitution gates in Ensemble PRD/TRD authoring commands. No implementation performed.

## Reused Capabilities

None. `node packages/development/lib/trd-graph-cli.js capabilities docs/TRD --json` returned an empty capability registry. Existing overlap output shows prior TRDs sharing command/test surfaces, but no foundational TRD exposes a reusable constitution-gate capability. This TRD keeps the work local to command YAML, generated command artifacts, and package tests instead of inventing a shared runtime library.

## 1. Architecture Decision

### 1.1 Chosen approach — Option C: shared gate contract embedded into both authoring commands

Foreman mode auto-selected Option C: best fit for the existing brownfield command architecture.

Ensemble's PRD/TRD authoring behavior is driven by YAML command sources plus generated markdown artifacts. The smallest safe hard-gate design is therefore a shared **Constitution Gate Contract** described once in each relevant YAML command flow and verified by package tests:

1. Add a pre-save constitution source discovery action to `packages/product/commands/create-prd.yaml` and `packages/development/commands/create-trd.yaml`.
2. Define the same source precedence in both commands: `docs/standards/constitution.md` first, fallback to `.specify/memory/constitution.md`, warn if both exist and differ, and fail as configuration error if neither exists.
3. Require every enforceable check to map to a source article heading identifier. A violation without an article id is itself a gate configuration failure.
4. Run the gate after the PRD/TRD draft exists but before repo-local artifact save, success messaging, or next-step output.
5. On violation, halt with article-specific remediation. No ask, override, skip flag, or Foreman default-proceed path is allowed.
6. Keep non-constitution CONCERNS readiness behavior unchanged: only constitution-backed failures become non-bypassable.
7. Regenerate command markdown from YAML and add tests that assert source + generated docs no longer expose constitution override semantics.

This approach avoids a larger runtime abstraction for a repo whose command logic is mostly declarative prose. It also satisfies the generated artifact policy: edit YAML first, then regenerate markdown.

### 1.2 Alternatives considered

**Option A — inline separate hard-gate prose in each command only.** Fastest and fewest files, but high drift risk: create-prd and create-trd could diverge on source precedence, missing-source behavior, or article-id formatting. Rejected because PRD REQ-001/REQ-002/REQ-009 need identical semantics across both phases.

**Option B — build a new executable `constitution-gate.js` parser/evaluator.** Strongest enforcement if command authors call it, but the current authoring commands are not JavaScript programs; they are agent-followed YAML workflows. A CLI would be unused unless the YAML still instructs the agent to call it, so it adds complexity without removing the prose enforcement surface. Rejected for this slice; a future foundational TRD can extract a real evaluator once article syntax stabilizes.

**Option C — command-level shared contract plus tests.** Chosen. It matches current architecture, keeps scope narrow, and still pins deterministic behavior through source tests, generated artifact tests, and fixture-driven hard-block scenarios.

### 1.3 Critical sequencing rule

The gate must run on the in-memory draft before file save. Failure may write an error phase report to `FOREMAN_ARTIFACT_PATH`, but must not claim a saved repo-local PRD/TRD artifact. Success may record constitution status in the saved document.

## 2. System Architecture

### 2.1 Components

| Component | Status | Responsibility |
|---|---|---|
| `packages/product/commands/create-prd.yaml` | modified | Adds PRD constitution source discovery, draft evaluation, hard failure handling, and success audit note before Output Management save |
| `packages/development/commands/create-trd.yaml` | modified | Adds TRD constitution source discovery, draft evaluation, hard failure handling, and success audit note before TRD File Save/Next Steps |
| `packages/product/commands/ensemble/create-prd.md` | regenerated | Generated command artifact reflecting PRD hard-gate wording |
| `packages/development/commands/ensemble/create-trd.md` | regenerated | Generated command artifact reflecting TRD hard-gate wording |
| `scripts/generate-markdown.js` | reused | Existing generator; no behavior change planned beyond regeneration execution |
| `packages/product/tests/create-prd-command.test.js` | modified | Source/generation assertions and PRD violation fixture expectations |
| `packages/development/tests/create-trd-command.test.js` | modified | Source/generation assertions and TRD violation fixture expectations |
| `packages/development/tests/trd-cli.test.js` | reused | Existing parse contract remains unchanged; used only if implementation needs parser validation |
| `docs/standards/constitution.md` | input | Canonical constitution source when present |
| `.specify/memory/constitution.md` | input | Fallback constitution source when canonical source absent |

### 2.2 Constitution Gate Contract

**Inputs**
- Draft artifact content: PRD or TRD markdown assembled in memory.
- Candidate constitution paths: `docs/standards/constitution.md`, `.specify/memory/constitution.md`.
- Execution mode: interactive or Foreman.
- Optional `FOREMAN_ARTIFACT_PATH` for failure report observability.

**Source resolution**
1. If `docs/standards/constitution.md` exists, load it as canonical.
2. Else if `.specify/memory/constitution.md` exists, load it as canonical fallback.
3. If both exist and their normalized content differs, print a warning naming both paths, but still use `docs/standards/constitution.md`.
4. If neither exists, hard-fail as `CONSTITUTION_CONFIG_ERROR` before save.

**Article extraction**
- Parse article heading identifiers from source headings, preserving repo-local text such as `Article I`, `Article 1`, or `A1`.
- Include the heading title when available.
- Each enforceable check must carry at least one article id.
- If a check fails with no article id, hard-fail as `CONSTITUTION_CONFIG_ERROR`.

**Violation output**
- Format each failure with: article id, article title if available, draft section, specific finding, and remediation hint.
- List all failing article ids; do not collapse to a generic error.
- Print no `Proceed anyway`, `Override`, `Skip`, or equivalent action.

**Save behavior**
- Passing gate: continue to existing readiness/save flow and record constitution compliance as passed in the saved artifact.
- Failing gate: do not write the repo-local PRD/TRD path, do not print downstream next steps, and return a failed phase report if Foreman artifact reporting is available.

### 2.3 Data flow

```text
create-prd.yaml / create-trd.yaml
  → draft markdown assembled in memory
  → Constitution Gate Contract
      → resolve source path
      → extract article ids/titles
      → evaluate draft checks mapped to article ids
      → PASS: annotate compliance and continue to save
      → FAIL: print article-specific hard-block error; optional Foreman failure report; halt
  → Output Management writes repo-local PRD/TRD only on PASS
  → npm run generate updates generated command markdown
```

### 2.4 Integration boundaries

- No CLI flag or environment variable is introduced to bypass constitution checks.
- `--foreman` still auto-proceeds through non-constitution CONCERNS gates and auto-picks TRD architecture Option C.
- `--foreman` never auto-proceeds through constitution violations.
- Implementation-phase completion verification overrides remain out of scope.
- Missing constitution is an explicit configuration error, not a silent pass.

## Master Task List

### PR 1: Shared hard-gate contract in authoring command sources

**Shippable State:** Running the PRD or TRD authoring command now exposes one documented constitution gate contract: it resolves the applicable constitution source, treats missing/unmapped article checks as configuration errors, and defines a non-bypassable failure path before any artifact save.

- [ ] **TRD-001** Add a Constitution Gate Contract section/action block to `packages/product/commands/create-prd.yaml` with source precedence, missing-source failure, divergence warning, article-id extraction, and no override path (1.5h) `[satisfies REQ-001] [satisfies REQ-002] [satisfies REQ-007] [satisfies REQ-008]`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-007-1, AC-007-2, AC-008-1
  - Implementation AC: Given `create-prd.yaml`, when read, then it states `docs/standards/constitution.md` is canonical, `.specify/memory/constitution.md` is fallback, divergence is warned, and absence blocks generation.
  - Implementation AC: Given the same source, when searched for constitution failure behavior, then no proceed/override/skip option is offered and Foreman mode is explicitly forbidden from auto-proceeding.

- [ ] **TRD-002** Add the matching Constitution Gate Contract block to `packages/development/commands/create-trd.yaml` with identical semantics and TRD-specific phase placement (1.5h) `[satisfies REQ-001] [satisfies REQ-002] [satisfies REQ-007] [satisfies REQ-008] [depends: TRD-001]`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-007-1, AC-007-2, AC-008-1
  - Implementation AC: Given `create-trd.yaml`, when read, then it contains the same source precedence, missing-source block, article-id requirement, and no-bypass language as `create-prd.yaml`.
  - Implementation AC: Given the TRD command flow, when the gate is located, then it runs after task/architecture draft generation and before File Save and Next Steps.

- [ ] **TRD-003** Define article-specific violation formatting in both commands, including article id, title, failing draft section, finding, and remediation hint (1h) `[satisfies REQ-009] [depends: TRD-001, TRD-002]`
  - Validates PRD ACs: AC-009-1, AC-009-2
  - Implementation AC: Given a single violation, when the command failure prose is read, then it requires article id, optional article title, section, finding, and remediation hint.
  - Implementation AC: Given multiple violations, when failure formatting is read, then it requires listing every failing article id without reducing them to a generic failure.

- [ ] **TRD-004** Preserve non-constitution readiness behavior by explicitly scoping existing CONCERNS auto-proceed prompts outside constitution violations (0.75h) `[satisfies REQ-010] [depends: TRD-001, TRD-002]`
  - Validates PRD ACs: AC-010-1, AC-010-2
  - Implementation AC: Given PRD readiness is CONCERNS and constitution passes, when `create-prd --foreman` is described, then the existing auto-proceed policy remains.
  - Implementation AC: Given TRD design readiness is CONCERNS and constitution passes, when `create-trd --foreman` is described, then the existing auto-proceed policy remains.

- [ ] **TRD-001-TEST** Add product command source tests that assert PRD constitution source precedence, missing-source hard block, and no constitution override path (1h) `[verifies TRD-001] [satisfies REQ-001] [satisfies REQ-002] [satisfies REQ-007] [satisfies REQ-008] [depends: TRD-001]`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-007-1, AC-007-2, AC-008-1
  - Implementation AC: Given `packages/product/tests/create-prd-command.test.js`, when run, then it fails if the PRD command source lacks canonical/fallback paths, missing-source block language, article mapping language, or explicit no-override language.

- [ ] **TRD-002-TEST** Add development command source tests that assert TRD constitution source precedence, missing-source hard block, and no constitution override path (1h) `[verifies TRD-002] [satisfies REQ-001] [satisfies REQ-002] [satisfies REQ-007] [satisfies REQ-008] [depends: TRD-002]`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-007-1, AC-007-2, AC-008-1
  - Implementation AC: Given `packages/development/tests/create-trd-command.test.js`, when run, then it fails if the TRD command source lacks the same required hard-gate wording.

- [ ] **TRD-003-TEST** Add formatting tests that pin article-specific error content in both command sources (0.75h) `[verifies TRD-003] [satisfies REQ-009] [depends: TRD-003]`
  - Validates PRD ACs: AC-009-1, AC-009-2
  - Implementation AC: Given both command YAML files, when scanned by tests, then each contains article id, article title, failing section, finding, remediation hint, and all-violations listing requirements.

- [ ] **TRD-004-TEST** Add regression tests proving non-constitution CONCERNS wording remains available in Foreman mode (0.5h) `[verifies TRD-004] [satisfies REQ-010] [depends: TRD-004]`
  - Validates PRD ACs: AC-010-1, AC-010-2
  - Implementation AC: Given both command YAML files, when scanned, then existing CONCERNS-band Foreman auto-proceed wording remains, but is explicitly scoped away from constitution violations.

### PR 2: PRD phase pre-save enforcement and observability

**Shippable State:** A PRD authoring run with a constitution violation now fails before repo-local PRD save, prints article-specific remediation, writes only an optional Foreman failure report, and omits the create-TRD next step.

- [ ] **TRD-005** Reorder `create-prd.yaml` Output Management so constitution compliance runs after PRD draft/readiness scoring and before repo-local save or success messaging (1h) `[satisfies REQ-003] [satisfies REQ-004] [depends: TRD-001, TRD-003]`
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-004-1, AC-004-2
  - Implementation AC: Given a failing PRD draft, when the gate runs, then the command source says no `docs/PRD/...` file is written and no `/ensemble:create-trd` next step is printed.
  - Implementation AC: Given a passing PRD draft, when saved, then the final output occurs only after constitution compliance is recorded as passed.

- [ ] **TRD-006** Add PRD success audit status to saved PRD output instructions, e.g. health summary or notes line `Constitution compliance: passed` (0.5h) `[satisfies REQ-014] [depends: TRD-005]`
  - Validates PRD ACs: AC-014-1
  - Implementation AC: Given a compliant PRD run, when the saved document is inspected, then it contains a clear constitution compliance passed record.

- [ ] **TRD-007** Define PRD Foreman failure report behavior: write an error report to `FOREMAN_ARTIFACT_PATH` when set, without claiming a saved PRD artifact (0.75h) `[satisfies REQ-003] [depends: TRD-005]`
  - Validates PRD ACs: AC-003-2
  - Implementation AC: Given a PRD violation in Foreman mode with `FOREMAN_ARTIFACT_PATH` set, when failure handling is read, then it writes a failure report there while leaving repo-local PRD artifact unsaved.

- [ ] **TRD-005-TEST** Add violating PRD fixture/source regression coverage for no repo-local save and no create-TRD next step (1h) `[verifies TRD-005] [satisfies REQ-003] [satisfies REQ-004] [satisfies REQ-011] [depends: TRD-005]`
  - Validates PRD ACs: AC-003-1, AC-004-2, AC-011-1, AC-011-2
  - Implementation AC: Given a fixture PRD draft violating a constitution article, when product command tests run, then they assert the command source requires no repo-local PRD save, an article id in the error, and no `/ensemble:create-trd` next-step output.

- [ ] **TRD-006-TEST** Add product tests for PRD success audit status wording (0.5h) `[verifies TRD-006] [satisfies REQ-014] [depends: TRD-006]`
  - Validates PRD ACs: AC-014-1
  - Implementation AC: Given `create-prd.yaml`, when tested, then it contains explicit saved-document constitution compliance passed wording.

- [ ] **TRD-007-TEST** Add product tests for Foreman failure report semantics on PRD constitution violations (0.5h) `[verifies TRD-007] [satisfies REQ-003] [satisfies REQ-011] [depends: TRD-007]`
  - Validates PRD ACs: AC-003-2, AC-011-1, AC-011-2
  - Implementation AC: Given `create-prd.yaml`, when tested, then it distinguishes optional Foreman failure report output from successful repo-local PRD artifact save.

### PR 3: TRD phase pre-save enforcement and observability

**Shippable State:** A TRD authoring run with a constitution violation now fails before repo-local TRD save, prints article-specific remediation, writes only an optional Foreman failure report, and omits implementation next steps.

- [ ] **TRD-008** Reorder `create-trd.yaml` Output Management so constitution compliance runs after architecture/task draft and design gate, but before repo-local TRD save or implementation next-step messaging (1h) `[satisfies REQ-005] [satisfies REQ-006] [depends: TRD-002, TRD-003]`
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-006-1, AC-006-2
  - Implementation AC: Given a failing TRD draft, when the gate runs, then the command source says no `docs/TRD/...` file is written and no `/ensemble:implement-trd-beads` next step is printed.
  - Implementation AC: Given a passing TRD draft, when saved, then the final output occurs only after constitution compliance is recorded as passed.

- [ ] **TRD-009** Add TRD success audit status to saved TRD output instructions, e.g. validation section line `Constitution compliance: passed` (0.5h) `[satisfies REQ-014] [depends: TRD-008]`
  - Validates PRD ACs: AC-014-2
  - Implementation AC: Given a compliant TRD run, when the saved document is inspected, then it contains a clear constitution compliance passed record.

- [ ] **TRD-010** Define TRD Foreman failure report behavior: write an error report to `FOREMAN_ARTIFACT_PATH` when set, without claiming a saved TRD artifact (0.75h) `[satisfies REQ-005] [depends: TRD-008]`
  - Validates PRD ACs: AC-005-2
  - Implementation AC: Given a TRD violation in Foreman mode with `FOREMAN_ARTIFACT_PATH` set, when failure handling is read, then it writes a failure report there while leaving repo-local TRD artifact unsaved.

- [ ] **TRD-008-TEST** Add violating TRD fixture/source regression coverage for no repo-local save and no implementation next step (1h) `[verifies TRD-008] [satisfies REQ-005] [satisfies REQ-006] [satisfies REQ-012] [depends: TRD-008]`
  - Validates PRD ACs: AC-005-1, AC-006-2, AC-012-1, AC-012-2
  - Implementation AC: Given a fixture TRD draft violating a constitution article, when development command tests run, then they assert the command source requires no repo-local TRD save, an article id in the error, and no `/ensemble:implement-trd-beads` next-step output.

- [ ] **TRD-009-TEST** Add development tests for TRD success audit status wording (0.5h) `[verifies TRD-009] [satisfies REQ-014] [depends: TRD-009]`
  - Validates PRD ACs: AC-014-2
  - Implementation AC: Given `create-trd.yaml`, when tested, then it contains explicit saved-document constitution compliance passed wording.

- [ ] **TRD-010-TEST** Add development tests for Foreman failure report semantics on TRD constitution violations (0.5h) `[verifies TRD-010] [satisfies REQ-005] [satisfies REQ-012] [depends: TRD-010]`
  - Validates PRD ACs: AC-005-2, AC-012-1, AC-012-2
  - Implementation AC: Given `create-trd.yaml`, when tested, then it distinguishes optional Foreman failure report output from successful repo-local TRD artifact save.

### PR 4: Generated docs and repo-wide validation

**Shippable State:** Published Ensemble command documentation now says constitution violations hard-block without override, generated artifacts are in sync with YAML sources, and the package test/validation suite proves no constitution bypass wording remains in the affected commands.

- [ ] **TRD-011** Regenerate command markdown with `npm run generate` after YAML source edits (0.5h) `[satisfies REQ-013] [satisfies INFRA] [depends: TRD-005, TRD-008]`
  - Validates PRD ACs: AC-013-1
  - Implementation AC: Given edited YAML sources, when `npm run generate` runs, then `packages/product/commands/ensemble/create-prd.md` and `packages/development/commands/ensemble/create-trd.md` reflect hard-block constitution wording.

- [ ] **TRD-012** Remove or rewrite generated command prose that suggests constitution failures can be skipped, overridden, or proceeded through (0.5h) `[satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-013] [depends: TRD-011]`
  - Validates PRD ACs: AC-007-1, AC-008-2, AC-013-2
  - Implementation AC: Given generated command docs, when searched for constitution-adjacent override language, then no supported bypass path is documented.

- [ ] **TRD-013** Run focused and repo validation gates: product command tests, development command tests, `npm run generate`, `npm run validate`, and `git diff --check` (1h) `[satisfies REQ-011] [satisfies REQ-012] [satisfies REQ-013] [depends: TRD-011, TRD-012]`
  - Validates PRD ACs: AC-011-1, AC-011-2, AC-012-1, AC-012-2, AC-013-1, AC-013-2
  - Implementation AC: Given the completed change, when validation runs, then targeted Jest tests, generator idempotence, repo validation, and whitespace checks pass.

- [ ] **TRD-011-TEST** Assert regenerated `create-prd.md` and `create-trd.md` contain hard-block constitution wording and source precedence (0.75h) `[verifies TRD-011] [satisfies REQ-013] [depends: TRD-011]`
  - Validates PRD ACs: AC-013-1, AC-013-2
  - Implementation AC: Given generated markdown files, when package tests scan them, then both contain hard-block constitution source and violation text.

- [ ] **TRD-012-TEST** Add grep-style test coverage that rejects constitution-adjacent `Proceed anyway`, `Override`, or `Skip` bypass wording in affected source/generated docs (0.75h) `[verifies TRD-012] [satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-013] [depends: TRD-012]`
  - Validates PRD ACs: AC-007-1, AC-008-2, AC-013-2
  - Implementation AC: Given affected source/generated docs, when tests scan a bounded constitution context window, then no bypass phrase is accepted for constitution violations while unrelated non-constitution override prose may remain elsewhere.

- [ ] **TRD-013-TEST** Capture final validation commands and outputs in implementation notes or PR body (0.5h) `[verifies TRD-013] [satisfies REQ-011] [satisfies REQ-012] [satisfies REQ-013] [depends: TRD-013]`
  - Validates PRD ACs: AC-011-1, AC-011-2, AC-012-1, AC-012-2, AC-013-1, AC-013-2
  - Implementation AC: Given the implementation PR, when reviewed, then it lists the exact test/generation/validation commands run and their pass/fail outcomes.

**Total: 26 tasks (13 implementation, 13 test), 20.25h.** No task is 8h+; no breakdown candidate remains.

## 3. Sprint Planning

*Informational only — `implement-trd-beads` parses PR sections above, not this section.*

## Sprint 1: PR 1 and PR 2

- Establish shared hard-gate contract in both command sources.
- Implement PRD phase save-order/failure-report/success-audit instructions.
- Run product command tests for source semantics.

## Sprint 2: PR 3

- Implement TRD phase save-order/failure-report/success-audit instructions.
- Run development command tests for source semantics.

## Sprint 3: PR 4

- Regenerate generated command markdown.
- Add generated-doc and no-bypass scans.
- Run focused package tests, `npm run generate`, `npm run validate`, and `git diff --check`.

## Acceptance Criteria Traceability

| REQ-NNN | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Detect applicable constitution source | TRD-001, TRD-002 | TRD-001-TEST, TRD-002-TEST |
| REQ-002 | Map checks to article numbers | TRD-001, TRD-002 | TRD-001-TEST, TRD-002-TEST, TRD-003-TEST |
| REQ-003 | Block violating PRD generation | TRD-005, TRD-007 | TRD-005-TEST, TRD-007-TEST |
| REQ-004 | Verify PRD compliance before completion | TRD-005 | TRD-005-TEST |
| REQ-005 | Block violating TRD generation | TRD-008, TRD-010 | TRD-008-TEST, TRD-010-TEST |
| REQ-006 | Verify TRD compliance before completion | TRD-008 | TRD-008-TEST |
| REQ-007 | Remove constitution override prompts | TRD-001, TRD-002, TRD-012 | TRD-001-TEST, TRD-002-TEST, TRD-012-TEST |
| REQ-008 | Remove constitution override flags | TRD-001, TRD-002, TRD-012 | TRD-001-TEST, TRD-002-TEST, TRD-012-TEST |
| REQ-009 | Provide actionable article-specific errors | TRD-003 | TRD-003-TEST |
| REQ-010 | Preserve unrelated soft gates | TRD-004 | TRD-004-TEST |
| REQ-011 | Add violating PRD regression test | TRD-013 | TRD-005-TEST, TRD-007-TEST, TRD-013-TEST |
| REQ-012 | Add violating TRD regression test | TRD-013 | TRD-008-TEST, TRD-010-TEST, TRD-013-TEST |
| REQ-013 | Validate generated command docs | TRD-011, TRD-012, TRD-013 | TRD-011-TEST, TRD-012-TEST, TRD-013-TEST |
| REQ-014 | Report constitution gate status | TRD-006, TRD-009 | TRD-006-TEST, TRD-009-TEST |

**Traceability check:** 14 requirements covered, 0 uncovered, 0 orphaned annotations.

## 4. Quality Requirements

- **Testing:** Jest source tests in `packages/product/tests/create-prd-command.test.js` and `packages/development/tests/create-trd-command.test.js`; generated-doc assertions after `npm run generate`; bounded grep tests for constitution-adjacent bypass wording.
- **Reliability:** Gate fails closed for missing constitution source, unmapped article checks, and draft violations.
- **Observability:** Failures include article-specific remediation; successes record `Constitution compliance: passed`; Foreman receives failure reports without successful artifact claims.
- **Maintainability:** YAML sources are authoritative; generated markdown is regenerated and checked for idempotence.
- **Compatibility:** Existing CONCERNS readiness auto-proceed behavior remains for non-constitution findings.
- **Security/Governance:** No new bypass flag/env var; old or generic bypass wording is rejected or scoped away from constitution failures.

## 5. Adversarial Review Findings

| Finding | Risk | Resolution |
|---|---|---|
| A prose-only gate could drift between PRD and TRD commands. | Different phase behavior could violate source precedence or error formatting requirements. | PR 1 pins a shared contract in both YAML files and adds tests for identical sentinel wording. |
| Missing constitution could block repos unexpectedly. | Hard enforcement changes behavior for repos without a source file. | PRD explicitly chooses fail-closed. Error names both supported paths and labels it a configuration error. |
| Generated docs could still advertise soft-gate bypass after YAML changes. | Users may rely on stale command docs. | PR 4 regenerates artifacts and tests generated markdown for hard-block/no-bypass wording. |
| Generic CONCERNS override language exists elsewhere. | A broad search could break unrelated, intentional soft gates. | Tests must scan bounded constitution context windows and preserve non-constitution CONCERNS semantics. |
| Foreman needs an artifact path even when repo-local artifact save is blocked. | A hard block could look like missing phase output instead of a clear failed report. | PRD/TRD failure paths write optional Foreman failure reports while explicitly not claiming repo-local PRD/TRD save. |
| Article mapping from free-form constitution prose is underspecified. | Violations without article ids would satisfy blocking but fail remediation. | Gate treats unmapped failures as configuration errors and preserves heading identifiers exactly. |

## 6. Dependency and Estimate Review

- Critical path: TRD-001 → TRD-002 → TRD-003 → TRD-005/TRD-008 → TRD-011 → TRD-012 → TRD-013. Depth exceeds 3 because source contract must precede phase-specific save semantics and generated-doc validation.
- No circular dependencies detected.
- Estimates are intentionally small because changes are command YAML and tests, not runtime services.
- Highest-risk tasks are TRD-005 and TRD-008 due to save-order semantics; each remains 1h because they edit existing command flow text only.
- If implementation discovers real executable gate code exists outside the searched command sources, create a follow-up bead instead of expanding this TRD beyond PRD/TRD authoring commands.

## 7. Testability Review

- All Implementation ACs use observable file content, generated artifact content, or command output semantics.
- No AC depends on subjective quality terms.
- Fixture tests must assert both error text article ids and artifact side effects.
- Bypass-wording tests must avoid false positives by only scanning constitution-adjacent sections, preserving unrelated completion verification override docs.

## 8. Design Readiness Scorecard

| Dimension | Score | Notes |
|---|---:|---|
| Architecture completeness | 5 | Defines source discovery, article mapping, violation formatting, save ordering, Foreman reporting, docs regeneration, and test surfaces. |
| Task coverage | 5 | Every PRD REQ has implementation and test coverage, with AC traceability. |
| Dependency clarity | 4 | Dependencies are explicit and acyclic; long chain is intentional due to source→phase→generated validation ordering. |
| Estimate confidence | 5 | All tasks are under 2h and match existing command-test patterns. |

**Overall score:** 4.75
**Gate decision:** PASS

## 9. Validation Notes

- MCP enhancement: skipped (no MCP tools detected in this Pi tool surface).
- PRD readiness gate: PASS (4.75).
- Architecture alternative: Foreman mode auto-selected Option C (shared command-level contract matching brownfield architecture).
- Task parser self-check: planned task lines include required `- [ ] **TRD-NNN**` and `- [ ] **TRD-NNN-TEST**` prefixes.
- Constitution compliance for this TRD artifact: not enforced by current command version; this TRD specifies the future hard gate and does not implement it.

## 10. Next Steps

After approval, run:

```bash
/ensemble:configure-team docs/TRD/TRD-2026-7f4708b4-hard-enforce-constitution.md
/ensemble:implement-trd-beads docs/TRD/TRD-2026-7f4708b4-hard-enforce-constitution.md
```
