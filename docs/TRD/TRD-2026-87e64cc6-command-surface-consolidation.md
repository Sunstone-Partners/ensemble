---
document_id: TRD-2026-87e64cc6
label: trd-command-surface-consolidation
kind: trd
prd_reference: PRD-2026-87e64cc6
prd_path: docs/PRD/PRD-2026-87e64cc6-command-surface-consolidation.md
version: 1.0.1
status: Draft
date: 2026-10-06
design_readiness_score: 4.65
Constitution compliance: passed
---

# TRD-2026-87e64cc6: Task-Oriented Command Surface Consolidation

## Architecture Decision

**Chosen approach:** Two independent axes of work, both reusing existing, shipped mechanisms rather than inventing new ones.

1. **Front door (feature + issue discoverability/delegation):** Reuse the existing native-command pattern exactly as `ensemble-prd`/`ensemble-trd`/`ensemble-issue` already implement it — `registerDispatcherCommand` (completion dropdown, verbatim forward) + a `dispatch.subcommands[]`-bearing colon-named command YAML (Dispatch phase routes the first argument token to a sibling command/flag). `ensemble-feature`'s native registration and `ensemble:feature`'s dispatcher content are new; the underlying mechanism they ride on (`dispatcher-commands.ts`) is untouched.
2. **Issue resumability (REQ-019):** Option C — shared stage-agnostic I/O primitives extracted into a new `run-index-core.ts`; the existing feature `RunIndexStore` is refactored to call into it internally with its public API, `Stage`, and `RunRecord` unchanged; a new, independent `issue-run-index.ts` thin wrapper is built on the same core with its own `IssueStage`/`IssueRunRecord`. See the companion research doc for the full alternatives comparison (Option A: duplicate, Option B: fully generic store) and why C was selected live with the user during this phase.

**Alternatives considered:** Design Option A (duplicate everything, fastest, no shared plumbing) and Design Option B (fully generic parameterized store) were both presented and rejected in favor of Option C — see [Research: Run-Index Architecture](./TRD-2026-87e64cc6-command-surface-consolidation-research.md) for the full tradeoff analysis.

## Domain Analysis

| Domain | Present? | Notes |
|---|---|---|
| API layer | Yes | Command YAML `dispatch.subcommands[]` + native `registerCommand`/`getArgumentCompletions` (Pi/OMP only) |
| Data model | Yes | New `IssueRunRecord`/`IssueArtifactRef` schema (REQ-019) — see companion data-model doc |
| UI components | No | Terminal/chat command surface only |
| Infrastructure | No | No new deployment/hosting surface |
| Integrations | No | No new external system; Beads/GitHub references reuse existing `beadRefs`/`pr:` conventions |

**Companion domains detected:** `data-model` (new `IssueRunRecord` persistence), `research` (run-index architecture alternatives, decided live — recorded for reviewability independent of this TRD).

## Companion Artifacts

- [Research: Run-Index Architecture for REQ-019](./TRD-2026-87e64cc6-command-surface-consolidation-research.md)
- [Data Model: Task-Oriented Command Surface Consolidation](./TRD-2026-87e64cc6-command-surface-consolidation-data-model.md)

## Capability Reuse Check

No existing `kind: foundational` TRD declares a reusable `run-index`/`checkpoint` capability token (`docs/TRD/*.md` scanned for `capabilities:` frontmatter — none found covering this). The existing feature `RunIndexStore` (from `TRD-2026-d6bbf322-new-feature-workflow`) is `kind: trd`, not `foundational`, so it is referenced here as prior art to build on (Architecture Decision above), not depended on as a formal foundational TRD.

## System Architecture

**Components:**
- `packages/product/commands/feature.yaml` (`ensemble:feature`) — rewritten dispatcher content, replacing the retired linear pipeline in place.
- `packages/pi-extension/src/extension.ts` — one new `registerDispatcherCommand(...)` call for `ensemble-feature`, identical shape to the existing prd/trd/issue registrations.
- `packages/development/commands/new-feature.yaml` — gains a `--abandon` flag wired to the existing (currently unused by any CLI path) `RunIndexStore.abandon()`.
- `packages/agent-core/src/run-index-core.ts` (new) — shared, stage-agnostic I/O primitives.
- `packages/agent-core/src/new-feature/run-index.ts` — refactored internally to call the new core; public API unchanged.
- `packages/agent-core/src/fix-issue/issue-run-index.ts` (new) — issue workflow's own run-index store, built on the shared core.
- `packages/development/commands/fix-issue.yaml` / `packages/development/commands/issue.yaml` — gain `resume`/`status`/`abandon` entry-point resolution and dispatch entries.

**Data flow:** A developer types a native command (`ensemble-feature`/`ensemble-issue`) → the dispatcher-commands.ts registration forwards the raw text verbatim into the matching colon command (`/ensemble:feature`/`/ensemble:issue`) → that command's own Dispatch phase reads `dispatch.subcommands[]` from its own YAML and routes the first token → for feature/issue lifecycle actions, this reaches the resumable workflow's entry-point resolution (`ensemble:new-feature` / `ensemble:fix-issue`), which reads/writes its run-index store (feature or issue, never both) → the workflow dispatches to the eligible stage.

**Integration points:** None external; internal integration points are the two run-index stores (feature, issue) and the shared `run-index-core.ts` they both call into.

**Technology choices:** No new technology. TypeScript/Node.js, same `fs`-based atomic-write-and-JSON-file convention as the existing feature run-index store.

## Platform Availability (Native Command Surface)

**The native, hyphenated command surface (`ensemble-feature`, `ensemble-issue`, `ensemble-prd`, `ensemble-trd`) exists only on the Pi and OMP hosts.** It is registered at runtime via `registerDispatcherCommand(...)` in `packages/pi-extension/src/extension.ts`, which provides live subcommand-argument completion (the dropdown noted in Domain Analysis above) and verbatim forwarding into the matching colon-named command.

**Codex and OpenCode have no equivalent registration mechanism.** They only receive the colon-named, markdown-prompt commands generated from `packages/product/commands/*.yaml` and `packages/development/commands/*.yaml` into `packages/development/ensemble/*.md` — e.g. `/ensemble:feature`, `/ensemble:issue`, `/ensemble:prd`, `/ensemble:trd` — with no native completion dropdown and no hyphenated alias. A developer on Codex or OpenCode invokes the colon form directly; the hyphenated form does not exist there at all.

This is a platform split, not a cosmetic naming difference: Pi/OMP get a discoverable, tab-completable native command backed by the same underlying workflow that Codex/OpenCode reach only through the full colon-named command, with no native-command-list entry and no completion. Nothing elsewhere in this TRD implies host-uniform discoverability — wherever "the native command" is discussed above (Architecture Decision, System Architecture), it refers specifically to the Pi/OMP registration path. Satisfies REQ-011/AC-011-2.

## Master Task List

### PR 1: Feature Front Door — Delegation, Guards, Concurrency Safety
**Shippable State:** A developer can run `ensemble-feature new <idea>`, `resume`, `status`, and `abandon` and get a real, checkpointed feature run with a fail-fast missing-capability error and a proven-unweakened concurrency guard; the legacy `ensemble:feature` pipeline is untouched by this PR (retired in PR 2).

- [ ] **TRD-001** Add `--abandon` to `ensemble:new-feature` [satisfies REQ-007] (2h)
  - Validates PRD ACs: AC-007-3
  - Implementation AC:
    - [ ] Given `--abandon` is passed with an active/paused run, when the command runs, then it asks for explicit confirmation before calling `RunIndexStore.abandon()`
    - [ ] Given confirmation is declined, when the prompt resolves, then no `mutate()`/`abandon()` call is made and the run is untouched
    - [ ] Given no active run exists, when `--abandon` is passed, then it reports nothing to abandon and makes no state change

- [ ] **TRD-001-TEST** Abandon confirmation gate [Verifies TRD-001] [Satisfies REQ-007] [Depends: TRD-001] (2h)
  - Validates PRD ACs: AC-007-3
  - Test AC:
    - [ ] Scenario: abandon with confirmation terminates the run -- Given an active run, When `--abandon` is confirmed, Then the run reaches `status: abandoned` with artifacts/history retained
    - [ ] Scenario: abandon declined leaves the run untouched -- Given an active run, When confirmation is declined, Then `revision`/`stage`/`stageOutcome` are unchanged
    - [ ] Scenario: abandon with no active run is a no-op -- Given no run exists, When `--abandon` is passed, Then no run file is created or mutated

- [ ] **TRD-002** Rewrite `ensemble:feature` as the canonical dispatcher [satisfies REQ-001, REQ-002, REQ-005, REQ-007, REQ-008] [Depends: TRD-001] (5h)
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-2, AC-005-1, AC-005-2, AC-007-1, AC-007-2, AC-008-1, AC-008-2
  - Implementation AC:
    - [ ] Given `feature new <description>`, when dispatched, then it forwards verbatim into `/ensemble:new-feature`'s existing idea-argument convention, unmodified
    - [ ] Given `feature resume`/`feature status`/`feature abandon`, when dispatched, then each forwards verbatim into the corresponding bare/`--status`/`--abandon` invocation
    - [ ] Given the forward happens, when work is performed, then zero stage-machine logic is re-implemented in this file

- [ ] **TRD-002-TEST** Feature dispatcher pass-through [Verifies TRD-002] [Satisfies REQ-001, REQ-002, REQ-005, REQ-007, REQ-008] [Depends: TRD-002] (3h)
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-2, AC-005-1, AC-005-2, AC-007-1, AC-007-2, AC-008-1, AC-008-2
  - Test AC:
    - [ ] Scenario: new starts exactly one canonical run -- Given a description, When `feature new` runs, Then one run is created and its id is shown
    - [ ] Scenario: only one canonical lifecycle is documented -- Given the shipped surface, When searched for feature entry points, Then only `ensemble-feature` is presented as the full-lifecycle path
    - [ ] Scenario: feature entry point needs no existing issue -- Given a planned feature, When started via `feature new`, Then no reported issue is required as input
    - [ ] Scenario: pure pass-through, no translation -- Given the underlying workflow's argument convention changes, When the front door forwards a call, Then it passes arguments through unchanged rather than translating
    - [ ] Scenario: delegation performs no parallel stage logic -- Given any action runs, When work is performed, Then it is the underlying workflow's own entry logic, not a reimplementation
    - [ ] Scenario: status is read-only -- Given a run exists, When `feature status` runs, Then no `mutate()` call occurs
    - [ ] Scenario: resume continues from checkpoint -- Given a paused run, When `feature resume` runs, Then it continues from the last recorded stage
    - [ ] Scenario: retirement target in place -- Given this dispatcher ships, When `ensemble:feature` is inspected, Then it contains no trace of the old 5-step linear pipeline
    - [ ] Scenario: only one path advertised after retirement -- Given the surface is presented, When searched, Then the legacy pipeline is absent, not merely deprecated-but-present

- [ ] **TRD-003** Register native `ensemble-feature` command [satisfies REQ-003, REQ-010, REQ-016] [Depends: TRD-002] (2h)
  - Validates PRD ACs: AC-003-1, AC-010-2, AC-016-1, AC-016-2
  - Implementation AC:
    - [ ] Given `extension.ts`, when `registerDispatcherCommand` is called for `ensemble-feature`, then it forwards to `ensemble:feature` with zero new routing logic
    - [ ] Given a repo without `packages/product/commands/feature.yaml`, when the extension loads, then `ensemble-feature` is not registered (existing no-op contract preserved)

- [ ] **TRD-003-TEST** Native feature command registration [Verifies TRD-003] [Satisfies REQ-003, REQ-010, REQ-016] [Depends: TRD-003] (2h)
  - Validates PRD ACs: AC-003-1, AC-010-2, AC-016-1, AC-016-2
  - Test AC:
    - [ ] Scenario: no/unrecognized action lists all four actions -- Given `ensemble-feature` with no or an unrecognized action, When it responds, Then it lists `new`/`resume`/`status`/`abandon` with descriptions and no side effect
    - [ ] Scenario: command appears natively -- Given the YAML exists, When the product's native command list is inspected, Then `ensemble-feature` appears with its description
    - [ ] Scenario: action list is YAML-sourced -- Given the action list renders, When its source is checked, Then it comes from `dispatch.subcommands[]`, not a hardcoded TypeScript list
    - [ ] Scenario: wording is editable without a rebuild -- Given an action's description text changes in the YAML, When the command is invoked again, Then the new wording appears with no code change

- [ ] **TRD-004** Delegation-availability guard [satisfies REQ-006] [Depends: TRD-002] (3h)
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-006-3
  - Implementation AC:
    - [ ] Given `new-feature.yaml`/its generated runtime artifact is unresolvable, when any feature action runs, then it halts naming the missing capability and install instructions, creating no state
    - [ ] Given the capability is present, when actions run, then no availability warning prints
    - [ ] Given the capability is present but no `.ensemble/new-feature/` exists yet, when `new` runs, then this is the ordinary first-run case with no distinct warning

- [ ] **TRD-004-TEST** Availability guard behavior [Verifies TRD-004] [Satisfies REQ-006] [Depends: TRD-004] (2h)
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-006-3
  - Test AC:
    - [ ] Scenario: missing capability halts actionably -- Given the underlying workflow is absent, When any action runs, Then the output names it and states how to obtain it, with no partial state
    - [ ] Scenario: present capability is silent -- Given the capability resolves, When actions run, Then no availability warning is printed
    - [ ] Scenario: first-ever run is ordinary -- Given no prior `.ensemble/new-feature/` state, When `new` runs, Then the run is created silently with only the normal run-started output

- [ ] **TRD-005** Command input validation at the boundary [satisfies REQ-015] [Depends: TRD-002] (2h)
  - Validates PRD ACs: AC-015-1
  - Implementation AC:
    - [ ] Given an unknown action token or unsupported flag, when validated, then it is rejected before any run state is created or read, with the supported action list shown

- [ ] **TRD-005-TEST** Input validation boundary [Verifies TRD-005] [Satisfies REQ-015] [Depends: TRD-005] (2h)
  - Validates PRD ACs: AC-015-1
  - Test AC:
    - [ ] Scenario: unknown action rejected pre-state -- Given an unrecognized action token, When validated, Then it is rejected before any RunIndexStore read/mutate, action list shown
    - [ ] Scenario: unsupported flag rejected pre-state -- Given a valid action with an unsupported flag, When validated, Then it is rejected before state access
    - [ ] Scenario: empty input shows the action list -- Given no arguments at all, When validated, Then the supported action list is shown with no side effect

- [ ] **TRD-013** Shallow pass-through concurrency test [satisfies REQ-013] [Depends: TRD-002] (2h)
  - Validates PRD ACs: AC-013-1, AC-013-2
  - Implementation AC:
    - [ ] Given a second concurrent `feature new` in the same project, when forwarded, then the underlying workflow's existing `RUN_ALREADY_ACTIVE` refusal surfaces unchanged -- not re-implemented, not weakened, not swallowed

- [ ] **TRD-013-TEST** Concurrency guard pass-through [Verifies TRD-013] [Satisfies REQ-013] [Depends: TRD-013] (2h)
  - Validates PRD ACs: AC-013-1, AC-013-2
  - Test AC:
    - [ ] Scenario: availability guard passes when installed -- Given the capability is installed, When the guard checks, Then it passes
    - [ ] Scenario: availability guard fails closed when removed -- Given the capability is removed, When the guard checks, Then it fails closed with the actionable message
    - [ ] Scenario: second concurrent start is refused identically -- Given one active run, When a second `feature new` is attempted, Then it is refused naming the existing run, with the same message as direct `ensemble:new-feature` invocation

### PR 2: Discoverability, Naming, and Retirement
**Shippable State:** The legacy linear `ensemble:feature` pipeline no longer exists anywhere in the shipped surface; `ensemble-new-feature` is documented as internal implementation detail; all four task-oriented/specialist commands enforce the same no-arg/unrecognized-action behavior; the Pi/OMP-only native-command platform split is stated plainly in the docs.

- [ ] **TRD-006** Audit the product-wide action-list invariant [satisfies REQ-003] (3h)
  - Validates PRD ACs: AC-003-2
  - Implementation AC:
    - [ ] Given `ensemble:prd`/`ensemble:trd`/`ensemble:issue`'s existing "print table and halt" behavior, when audited against AC-003-2, then any of the three found non-compliant is fixed

- [ ] **TRD-006-TEST** Product-wide action-list invariant [Verifies TRD-006] [Satisfies REQ-003] [Depends: TRD-006] (3h)
  - Validates PRD ACs: AC-003-2
  - Test AC:
    - [ ] Scenario: ensemble-prd no-arg prints table and halts -- Given no/unrecognized action, When invoked, Then it lists its actions and halts with no side effect
    - [ ] Scenario: ensemble-trd no-arg prints table and halts -- Given no/unrecognized action, When invoked, Then it lists its actions and halts with no side effect
    - [ ] Scenario: ensemble-issue no-arg prints table and halts -- Given no/unrecognized action, When invoked, Then it lists its actions and halts with no side effect

- [ ] **TRD-007** De-advertise `ensemble-new-feature` [satisfies REQ-009, REQ-010] [Depends: TRD-002] (3h)
  - Validates PRD ACs: AC-009-1, AC-009-2, AC-010-1
  - Implementation AC:
    - [ ] Given product documentation, when updated, then `ensemble-feature` is presented as the entry point and `ensemble-new-feature` is described as implementation detail
    - [ ] Given `ensemble-new-feature` is invoked directly, when it runs, then it behaves identically (same canonical run record) and prints a one-line pointer to `ensemble-feature`

- [ ] **TRD-007-TEST** De-advertisement and convergence [Verifies TRD-007] [Satisfies REQ-009, REQ-010] [Depends: TRD-007] (2h)
  - Validates PRD ACs: AC-009-1, AC-009-2, AC-010-1
  - Test AC:
    - [ ] Scenario: direct invocation still works and converges -- Given `ensemble-new-feature` is invoked directly, When it runs, Then it produces the same run record as going through `ensemble-feature`, with the pointer printed
    - [ ] Scenario: docs no longer list it as top-level -- Given product documentation, When reviewed, Then `ensemble-new-feature` is absent from the top-level entry-point list
    - [ ] Scenario: skill and command converge -- Given a natural-language "start a new feature" request, When routed via the skill, Then it reaches the same canonical workflow and names the same front-door command

- [ ] **TRD-008** Document the Pi/OMP-only native-command platform split [satisfies REQ-011] [Depends: TRD-003] (1h)
  - Validates PRD ACs: AC-011-1, AC-011-2
  - Implementation AC:
    - [ ] Given the native hyphenated command surface exists only on Pi/OMP, when documented, then this TRD/PRD and relevant docs state that plainly rather than implying host-uniform discoverability

- [ ] **TRD-008-TEST** Platform split and naming convention [Verifies TRD-008] [Satisfies REQ-011] [Depends: TRD-008] (1h)
  - Validates PRD ACs: AC-011-1, AC-011-2
  - Test AC:
    - [ ] Scenario: docs state the platform split -- Given the docs, When read, Then Codex/OpenCode are described as markdown-command-only, Pi/OMP as native-with-completion
    - [ ] Scenario: new action names describe the operation -- Given a new action is proposed, When named, Then it is not an ambiguous verb such as "re-create" without a settled meaning

- [ ] **TRD-009** Retire the legacy linear pipeline content [satisfies REQ-008] [Depends: TRD-002] (2h)
  - Validates PRD ACs: AC-008-1, AC-008-2
  - Implementation AC:
    - [ ] Given `packages/product/commands/feature.yaml`'s old 5-step orchestration (Argument Parsing, 5-step Pipeline Execution), when this task completes, then it no longer exists in the file -- replaced entirely by TRD-002's dispatcher content

- [ ] **TRD-009-TEST** Legacy pipeline absence [Verifies TRD-009] [Satisfies REQ-008] [Depends: TRD-009] (2h)
  - Validates PRD ACs: AC-008-1, AC-008-2
  - Test AC:
    - [ ] Scenario: old orchestration behavior is gone -- Given the shipped surface, When searched for the old `--skip-refine` 5-step pipeline, Then it is not found anywhere
    - [ ] Scenario: only the canonical command is advertised -- Given the product surface, When presented, Then only `ensemble-feature` is advertised for the feature lifecycle

### PR 3: Issue Workflow Resumability
**Shippable State:** `ensemble-issue fix` runs are checkpointed and resumable via an independent run-index store; `status`/`resume`/`abandon` work for issue runs the same way they do for feature runs.

- [ ] **TRD-014** Extract shared run-index core primitives [satisfies REQ-019] (8h — flagged for breakdown: split into (a) atomic-write + lock acquire/release extraction, (b) mutate/revision-conflict + corruption-validation extraction and feature-store refactor)
  - Validates PRD ACs: AC-019-1
  - Implementation AC:
    - [ ] Given `run-index-core.ts`, when created, then it exposes atomic write, active-lock acquire/release, revision-conflict `mutate()`, and corrupt-file validation, generic over a caller-supplied runs-dir resolver and shape validator
    - [ ] Given `new-feature/run-index.ts`, when refactored to call the new core internally, then its public API, `Stage`, and `RunRecord` shape are unchanged

- [ ] **TRD-014-TEST** Core extraction regression and can-fail proof [Verifies TRD-014] [Satisfies REQ-019] [Depends: TRD-014] (4h)
  - Validates PRD ACs: AC-019-1
  - Test AC:
    - [ ] Scenario: existing feature-store suite passes unmodified -- Given the refactored core, When the existing `run-index.test.ts` suite runs, Then it passes without modification
    - [ ] Scenario: deliberately broken core primitive fails the suite -- Given the lock-acquire primitive is deliberately broken, When the suite runs, Then it fails, proving the check can fail (Constitution Rule 7)
    - [ ] Scenario: on-disk shape unchanged -- Given existing `.ensemble/new-feature/*.json` files, When loaded post-refactor, Then they load unmodified

- [ ] **TRD-015** Implement `issue-run-index.ts` [satisfies REQ-019, REQ-002] [Depends: TRD-014] (5h)
  - Validates PRD ACs: AC-019-1, AC-002-1
  - Implementation AC:
    - [ ] Given `IssueStage`/`IssueRunRecord`/`IssueArtifactRef` per the data-model doc, when implemented on the shared core, then `.ensemble/fix-issue/` is its own independent run-file directory with its own `active.lock`
    - [ ] Given an issue run and a feature run active simultaneously in the same project, when each store checks exclusivity, then each enforces it independently (no cross-store coupling)

- [ ] **TRD-015-TEST** Issue run-index store [Verifies TRD-015] [Satisfies REQ-019, REQ-002] [Depends: TRD-015] (4h)
  - Validates PRD ACs: AC-019-1, AC-002-1
  - Test AC:
    - [ ] Scenario: createRun/mutate/findActive/abandon round-trip -- Given a fresh project, When each operation runs in sequence, Then state persists and reloads correctly
    - [ ] Scenario: independent exclusivity from the feature store -- Given a feature run is active, When an issue run is also started, Then both succeed independently (no shared lock)
    - [ ] Scenario: corrupt file fails loud -- Given a malformed issue run file, When loaded, Then it throws `RUN_INDEX_CORRUPT` rather than guessing
    - [ ] Scenario: issue run creates no feature run record -- Given an issue-driven repair starts, When it runs, Then no feature `RunRecord` is created

- [ ] **TRD-016** Wire `fix-issue` entry-point resolution and checkpointing [satisfies REQ-019, REQ-007] [Depends: TRD-015] (6h)
  - Validates PRD ACs: AC-019-2, AC-019-3, AC-019-4, AC-007-3
  - Implementation AC:
    - [ ] Given `ensemble:fix-issue`, when given an issue description/no-arg/`--status`/`--abandon`, then it mirrors `ensemble:new-feature`'s entry-point resolution pattern
    - [ ] Given each of the 3 named phases (Analysis & Planning, Execution, Validation & Delivery) completes, when the next phase begins, then a checkpoint is recorded via `issue-run-index.ts`
    - [ ] Given `--abandon`, when invoked, then it requires explicit confirmation before reaching a terminal abandoned state

- [ ] **TRD-016-TEST** Issue workflow resumability [Verifies TRD-016] [Satisfies REQ-019, REQ-007] [Depends: TRD-016] (4h)
  - Validates PRD ACs: AC-019-2, AC-019-3, AC-019-4, AC-007-3
  - Test AC:
    - [ ] Scenario: interrupted run resumes from checkpoint -- Given a paused issue run, When resumed, Then it continues from the last recorded stage without re-deriving from conversation history
    - [ ] Scenario: status reports full state -- Given an issue run exists, When status is requested, Then run id, stage, last outcome, and references are reported
    - [ ] Scenario: abandon requires confirmation -- Given an active issue run, When `--abandon` is passed, Then confirmation is required before the terminal state is reached
    - [ ] Scenario: abandoned run retains history -- Given abandonment is confirmed, When a later status check runs, Then the abandoned outcome and retained references are shown

- [ ] **TRD-017** Add `resume`/`status`/`abandon` to `ensemble:issue` dispatch [satisfies REQ-003, REQ-019] [Depends: TRD-016] (2h)
  - Validates PRD ACs: AC-003-2
  - Implementation AC:
    - [ ] Given `packages/development/commands/issue.yaml`, when updated, then `resume`/`status`/`abandon` are added to `dispatch.subcommands[]` alongside `fix`/`list`, each forwarding into the new `fix-issue` flags

- [ ] **TRD-017-TEST** Issue dispatch completeness [Verifies TRD-017] [Satisfies REQ-003, REQ-019] [Depends: TRD-017] (2h)
  - Validates PRD ACs: AC-003-2
  - Test AC:
    - [ ] Scenario: no/unrecognized action lists all five actions -- Given `ensemble-issue` with no or an unrecognized action, When it responds, Then it lists `fix`/`list`/`resume`/`status`/`abandon`

- [ ] **TRD-018** Issue native-command completion for new actions [satisfies REQ-016] [Depends: TRD-017] (1h)
  - Validates PRD ACs: AC-016-2
  - Implementation AC:
    - [ ] Given the existing native `ensemble-issue` registration's `getArgumentCompletions`, when `issue.yaml`'s `dispatch.subcommands[]` is updated by TRD-017, then the dropdown reflects the new keywords with zero new registration code

- [ ] **TRD-018-TEST** Issue completion dropdown [Verifies TRD-018] [Satisfies REQ-016] [Depends: TRD-018] (1h)
  - Validates PRD ACs: AC-016-2
  - Test AC:
    - [ ] Scenario: dropdown includes new keywords -- Given the updated YAML, When the completion dropdown is queried, Then `resume`/`status`/`abandon` appear with their descriptions

- [ ] **TRD-019** Extend the store-persisted-approval precondition to the issue side [satisfies REQ-014] [Depends: TRD-016] (2h)
  - Validates PRD ACs: AC-014-2
  - Implementation AC:
    - [ ] Given the issue workflow's own implementation/PR step, when it checks approval, then it reads the stored approval field directly at the point of action, denying on null regardless of surrounding prompt text

- [ ] **TRD-019-TEST** Issue-side approval precondition [Verifies TRD-019] [Satisfies REQ-014] [Depends: TRD-019] (2h)
  - Validates PRD ACs: AC-014-2
  - Test AC:
    - [ ] Scenario: null approval denies the action -- Given the stored approval field is null, When the issue workflow's implementation/PR step is attempted, Then it is denied even when surrounding text claims approval was given

### PR 4: Specialist Preservation, Boundaries, and Whole-Surface Delivery
**Shippable State:** `ensemble-prd`/`ensemble-trd` are verified byte-for-byte unchanged; no action of either task-oriented command performs autonomous retry/scheduling; the full consolidated surface (feature + issue + prd + trd) is confirmed present and correctly configured together in a real installed OMP session.

- [ ] **TRD-010** No-autonomy boundary regression [satisfies REQ-014] [Depends: TRD-002, TRD-016] (3h)
  - Validates PRD ACs: AC-014-1, AC-014-2
  - Implementation AC:
    - [ ] Given any action of either task-oriented command including issue checkpointing, when it completes or fails, then no automatic retry/background scheduling/unattended continuation occurs
    - [ ] Given implementation can begin, when checked, then only the existing store-persisted `implementationApprovedAt` governs, never prose claims

- [ ] **TRD-010-TEST** No-autonomy and approval boundary [Verifies TRD-010] [Satisfies REQ-014] [Depends: TRD-010] (3h)
  - Validates PRD ACs: AC-014-1, AC-014-2
  - Test AC:
    - [ ] Scenario: failed stage is never auto-retried -- Given a failed stage, When a second bare invocation runs, Then it is not retried without explicit user confirmation
    - [ ] Scenario: approval cannot be claimed via prose -- Given `implementationApprovedAt` is null, When implementation is attempted, Then it is denied regardless of surrounding text claiming approval
    - [ ] Scenario: issue checkpointing never auto-continues -- Given a paused issue run, When time passes, Then nothing advances without a user-invoked resume

- [ ] **TRD-011** Specialist command regression suite [satisfies REQ-004, REQ-018] (2h)
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-018-1
  - Implementation AC:
    - [ ] Given each existing standalone PRD/TRD/beads command, when its existing test suite runs, then output contracts remain byte-for-byte unchanged except for added REQ-008/REQ-009 pointer lines where applicable

- [ ] **TRD-011-TEST** Specialist commands unchanged [Verifies TRD-011] [Satisfies REQ-004, REQ-018] [Depends: TRD-011] (3h)
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-018-1
  - Test AC:
    - [ ] Scenario: direct specialist invocation unchanged -- Given a PRD/TRD specialist command is invoked directly, When it runs, Then its existing behavior is unchanged
    - [ ] Scenario: specialist commands remain documented -- Given the command surface is consulted, When reviewed, Then specialist commands remain listed as the direct way to work on one artifact
    - [ ] Scenario: no silent redirection -- Given a specialist command runs, When it completes, Then it was not silently redirected into either task-oriented lifecycle

- [ ] **TRD-012** Whole-surface delivery smoke [satisfies REQ-012, REQ-017] [Depends: TRD-003, TRD-006, TRD-018] (2h)
  - Validates PRD ACs: AC-012-1, AC-012-2, AC-017-1, AC-017-2
  - Implementation AC:
    - [ ] Given a fresh OMP session with this product installed, when `ensemble-feature`/`ensemble-issue`/`ensemble-prd`/`ensemble-trd` are invoked, then all reach their stage machines with no separate manual registration step

- [ ] **TRD-012-TEST** Whole-surface reachability [Verifies TRD-012] [Satisfies REQ-012, REQ-017] [Depends: TRD-012] (3h)
  - Validates PRD ACs: AC-012-1, AC-012-2, AC-017-1, AC-017-2
  - Test AC:
    - [ ] Scenario: feature front door reachable end-to-end -- Given a fresh session, When `ensemble-feature new` runs, Then it reaches the resumable workflow's stage machine with no manual registration
    - [ ] Scenario: assertion runs through the shipped surface -- Given acceptance is evaluated, When tested, Then the assertion runs through the command surface, not internal APIs
    - [ ] Scenario: all four commands match the PRD together -- Given the installed product, When inspected, Then `ensemble-feature`, `ensemble-issue`, `ensemble-prd`, `ensemble-trd` all match this PRD's requirements simultaneously
    - [ ] Scenario: exit condition is product presence, not isolated tests -- Given the acceptance environment, When checked, Then commands appearing in the installed product is the exit condition, not merely passing tests in isolation

## Sprint Planning

### Sprint 1
- PR 1 (Feature Front Door) and PR 3 (Issue Workflow Resumability) run in parallel — no shared dependency.

### Sprint 2
- PR 2 (Discoverability and Retirement) — depends on PR 1.

### Sprint 3
- PR 4 (Specialist Preservation and Whole-Surface Delivery) — depends on PR 1, PR 2, and PR 3 (TRD-010 needs TRD-016 from PR 3; TRD-012 needs TRD-018 from PR 3).

This section is informational only; `implement-trd-beads` does not parse it.

## Dependency Mapping and PR Boundary Design

**Critical path:** TRD-014 → TRD-015 → TRD-016 → TRD-017 → TRD-018 → TRD-012 (longest chain, 6 tasks / 5 sequential hops, spanning PR 3 → PR 4). This chain is inherently linear — each step in the shared run-index-core build-out (core extraction → issue store → entry-point wiring → dispatch entries → completion dropdown) consumes the previous step's concrete output, so no parallelization is available; confirmed during refinement. PR 1 and PR 3 have no dependency on each other and can proceed in parallel; PR 2 depends only on PR 1; PR 4 depends on PR 1, PR 2, and PR 3 — no forward dependencies remain across PR boundaries.

| From | To | Reason |
|---|---|---|
| TRD-002 | TRD-001 | Dispatcher's `abandon` forward needs the flag to exist first |
| TRD-003 | TRD-002 | Native registration forwards to the dispatcher |
| TRD-004, TRD-005, TRD-013 | TRD-002 | Guards/validation/concurrency test wrap the dispatcher |
| TRD-007, TRD-009 | TRD-002 | De-advertisement and retirement act on the dispatcher's replacement content |
| TRD-008 | TRD-003 | Platform-split doc describes the native registration |
| TRD-010 | TRD-002, TRD-016 | Boundary regression spans both feature and issue sides |
| TRD-012 | TRD-003, TRD-006, TRD-018 | Whole-surface smoke needs every piece present |
| TRD-015 | TRD-014 | Issue store needs the shared core first |
| TRD-016 | TRD-015 | Entry-point wiring needs the store |
| TRD-017 | TRD-016 | Dispatch entries need the flags to exist |
| TRD-018 | TRD-017 | Completion reads the dispatch entries |
| TRD-019 | TRD-016 | Approval precondition needs the stage machine wired |

No circular dependencies exist in this graph.

## Acceptance Criteria Traceability

| REQ-NNN | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Single canonical feature-lifecycle front door | TRD-002 | TRD-002-TEST |
| REQ-002 | Keep feature and issue work distinct | TRD-002, TRD-015 | TRD-002-TEST, TRD-015-TEST |
| REQ-003 | Enumerable actions on every task-oriented command | TRD-003, TRD-006, TRD-017 | TRD-003-TEST, TRD-006-TEST, TRD-017-TEST |
| REQ-004 | Preserve document-oriented specialist commands | TRD-011 | TRD-011-TEST |
| REQ-005 | Pure pass-through delegation | TRD-002 | TRD-002-TEST |
| REQ-006 | Fail fast when delegated capability missing | TRD-004 | TRD-004-TEST |
| REQ-007 | Report run state via status/resume/abandon | TRD-001, TRD-002, TRD-016 | TRD-001-TEST, TRD-002-TEST, TRD-016-TEST |
| REQ-008 | Retire the superseded linear pipeline outright | TRD-002, TRD-009 | TRD-002-TEST, TRD-009-TEST |
| REQ-009 | De-advertise the internal workflow name | TRD-007 | TRD-007-TEST |
| REQ-010 | Commands, not just skills, are discoverable | TRD-003, TRD-007 | TRD-003-TEST, TRD-007-TEST |
| REQ-011 | Uniform naming, platform split stated plainly | TRD-008 | TRD-008-TEST |
| REQ-012 | Reachable from the product entry point | TRD-012 | TRD-012-TEST |
| REQ-013 | Every guard provably able to fail | TRD-013 | TRD-013-TEST |
| REQ-014 | Documentation-and-routing only; no durable coordination | TRD-010, TRD-019 | TRD-010-TEST, TRD-019-TEST |
| REQ-015 | Validate command input at the boundary | TRD-005 | TRD-005-TEST |
| REQ-016 | Editable routing text, one mechanism | TRD-003, TRD-018 | TRD-003-TEST, TRD-018-TEST |
| REQ-017 | Deliver the whole surface together | TRD-012 | TRD-012-TEST |
| REQ-018 | Existing standalone document commands untouched | TRD-011 | TRD-011-TEST |
| REQ-019 | Make `ensemble-issue fix` resumable and checkpointed | TRD-014, TRD-015, TRD-016, TRD-017 | TRD-014-TEST, TRD-015-TEST, TRD-016-TEST, TRD-017-TEST |

## Traceability Validation

Traceability check: 19 requirements covered, 0 uncovered, 0 orphaned annotations. Every Must/Should requirement appears in the matrix above; every `[satisfies REQ-NNN]` annotation in the Master Task List references a REQ-NNN present in the source PRD.

## Adversarial Review and Design Gate

### Architecture Self-Critique

| Issue | Category | Resolution |
|---|---|---|
| `ensemble-feature abandon` has nothing to forward to (no `--abandon` flag exists on `ensemble:new-feature` today) | Gap | TRD-001 adds the flag first; TRD-002 depends on it |
| Shared core extraction (TRD-014) touches already-shipped, already-tested code | Missing error/failure-recovery path consideration | TRD-014-TEST runs the full existing suite unmodified plus a deliberate-break-to-prove-fail scenario |
| REQ-016's "zero new code" claim for the issue-side dropdown (TRD-018) is easy to assert without verifying | Testability | TRD-018-TEST explicitly asserts the dropdown reflects YAML changes with no registration code touched |
| REQ-011/REQ-015/REQ-018 each carry fewer than 3 PRD ACs, below the general BDD-coverage guideline | Testability | Corresponding TEST tasks (TRD-005-TEST, TRD-008-TEST, TRD-011-TEST) add supplementary edge/error scenarios beyond the literal PRD AC count |
| Whole-surface smoke (TRD-012) and the no-autonomy boundary regression (TRD-010) both originally depended on tasks placed in a later-numbered PR, violating the PR-stack shippability guarantee | Forward dependency across PR boundaries | Resolved during refinement (refine-trd) by swapping section order: Issue Workflow Resumability is now PR 3 (ships before) and Specialist Preservation/Boundaries/Whole-Surface Delivery is now PR 4; both dependencies are now backward |
| TRD-014 is estimated at 8h, at the review threshold for further breakdown | Missing granularity | Flagged in the task itself with a recommended two-way split (primitives extraction vs. feature-store refactor) |

### Task Coverage Analysis

Every PRD REQ-NNN has at least one corresponding TRD task (see Acceptance Criteria Traceability). No TRD task references a nonexistent REQ-NNN ID. No task is estimated above 8h without a flagged breakdown recommendation (TRD-014 is the only 8h+ task, and it carries one). Every `### PR N:` heading is immediately followed by a **Shippable State:** line.

### Dependency and Estimate Review

No circular or implicit dependencies exist (see graph above; verified acyclic). No two tasks with similar scope carry wildly divergent estimates (front-door wiring tasks: 2-5h; store/wiring tasks: 1-8h, consistent with their relative complexity). One estimate-confidence issue identified and flagged: TRD-014 (8h, recommended split) — see Architecture Self-Critique.

### Testability Review

Every Implementation AC has specific pass/fail criteria (no subjective "fast"/"good"/"user-friendly" language used anywhere in this task list). Every TRD-NNN-TEST task's Test AC checklist has one `- [ ] Scenario: ...` item per AC-NNN-M in its Validates PRD ACs field, with every PRD AC scenario'd by at least one test task (cross-checked against the Acceptance Criteria Traceability matrix — 0 uncovered). REQ-011, REQ-015, and REQ-018 each have fewer than 3 PRD-level ACs; their TEST tasks add supplementary scenarios (TRD-005-TEST's empty-input scenario, TRD-008-TEST's naming-convention scenario, TRD-011-TEST's "no silent redirection" scenario) so each REQ still gets meaningful happy-path/edge/error coverage at the TRD level even where the PRD's own AC count is thin.

### Design Readiness Gate

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Architecture completeness | 4.6 | All components, data flows, and integration points defined; companion research/data-model docs back the one genuinely new subsystem (issue run-index) |
| Task coverage | 4.8 | 19/19 REQs covered by implementation and test tasks |
| Dependency clarity | 5.0 | Explicit, acyclic dependency graph; the forward-dependency-across-PR-boundary issue found during refinement (TRD-010/TRD-012 depending on later-numbered-PR tasks) was resolved by reordering PR sections rather than merely documented |
| Estimate confidence | 4.2 | Most tasks 1-6h; one 8h+ task flagged with a concrete breakdown recommendation |
| **Overall** | **4.65** | **PASS** |

**Gate decision: PASS (4.0+).** Proceeding to the Constitution Gate before output.

## Constitution Gate

Constitution Gate: running

Constitution source: `docs/standards/constitution.md` (canonical; no `.specify/memory/constitution.md` exists, no conflict to warn about).

| Source | Check | Result |
|---|---|---|
| §1 Core Principles | Ensemble remains a portable behavior-definition/packaging/validation/local-harness project, not a durable production scheduler | PASS — the shared run-index-core is local file-based checkpointing; no Foreman-competing dispatcher introduced |
| Rule 1: No secrets in code | No credentials in any task | PASS |
| Rule 2: Input validation required | External input validated at boundaries | PASS — TRD-005 |
| Rule 3: Tests accompany features | Every implementation task has a paired TEST task | PASS — 19/19 |
| Rule 4: Ownership boundary preserved | No durable activation/scheduling/retries/second dispatcher | PASS — TRD-010, TRD-019 explicitly test no autonomous continuation on both feature and issue sides |
| Rule 5: Governed tool boundary at runtime | Approval cannot be claimed via prompt text | PASS — TRD-019 extends the store-persisted precondition to the issue side |
| Rule 6: Reachable from product entry point | Acceptance asserts through the entry point | PASS — TRD-012 |
| Rule 7: Verification must be able to fail | Guards demonstrably reject | PASS — TRD-014-TEST's deliberate-break scenario, TRD-013-TEST's fail-closed scenario |
| Rule 8: User-changeable behavior in editable artifacts | Wording/actions in YAML, not hardcoded TypeScript | PASS — TRD-003, TRD-006, TRD-017, TRD-018 |

Constitution compliance: passed

Constitution Gate: PASSED

## Risk Register

| Risk | Mitigation |
|---|---|
| Shared run-index-core extraction regresses the existing, shipped feature workflow | TRD-014-TEST runs the full existing suite unmodified plus a deliberate-break-to-prove-fail check before merge |
| Retiring `ensemble:feature`'s old content breaks any external script/documentation still referencing its old behavior | TRD-009-TEST explicitly verifies the old behavior is gone and only the canonical path is advertised; REQ-008 was a deliberate, user-confirmed decision (no compatibility window) |
| Issue workflow resumability (REQ-019) is new scope with no prior implementation to copy exactly | Companion research doc records the architecture decision and rejected alternatives; TRD-015-TEST exercises the new store directly before it's wired into `fix-issue` |

## Companion Artifacts

- [Research: Run-Index Architecture for REQ-019](./TRD-2026-87e64cc6-command-surface-consolidation-research.md)
- [Data Model: Task-Oriented Command Surface Consolidation](./TRD-2026-87e64cc6-command-surface-consolidation-data-model.md)

## Changelog

### 2026-10-06 — v1.0.1

Refined via live `refine-trd` interview against the `ensemble-new-feature` run `18d126c0f2ca04ce` (`trd_refine` stage). 2 findings addressed:

- Resolved a forward-dependency-across-PR-boundary violation: TRD-010 and TRD-012 (originally PR 3) each depended on a task in the later-numbered PR 4. Swapped PR section order — Issue Workflow Resumability is now PR 3 (ships before), Specialist Preservation/Boundaries/Whole-Surface Delivery is now PR 4 — so both dependencies are backward, restoring the PR-stack shippability guarantee. Updated Sprint Planning and the Adversarial Review resolution accordingly.
- Corrected a critical-path miscount in Dependency Mapping: the actual longest chain is TRD-014→015→016→017→018→012 (6 tasks, 5 hops), not the originally stated 4-task/TRD-001→002→003→012 chain. Confirmed with the user that the chain is inherently linear (shared run-index-core build-out, each step consumes the prior step's output) with no parallelization opportunity.
- Re-scored the Design Readiness Gate: 4.53 → 4.65 (Dependency clarity 4.5→5.0, reflecting the structural fix rather than a documented workaround; other three dimensions unchanged).

### 2026-10-06 — v1.0.0

- Initial TRD from the `ensemble-new-feature` run `18d126c0f2ca04ce` (`trd_create` stage): 38 tasks across 4 PRs, Architecture Option C (shared run-index-core + thin wrappers) chosen via live alternatives interview, Design Readiness 4.53 PASS, Constitution Gate PASSED.
