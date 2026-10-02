---
document_id: PRD-2026-d6bbf322
label: prd-new-feature-workflow
version: 1.0.0
status: Draft
date: 2026-09-30
scale_depth: STANDARD
total_requirements: 14
readiness_score: 4.55
design_readiness_score: null
---

# PRD-2026-d6bbf322: Resumable New-Feature Workflow for Ensemble

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 11 |
| Should requirements | 3 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 14/14 (100%) |
| Risk flags | 4 |
| Cross-requirement dependencies | 18 |
| Unresolved clarification markers | 0 |
| Constitution compliance | passed |

## Product Summary

**Problem:** Ensemble's existing feature-planning entry point coordinates several separate commands, but the handoffs depend on the user remembering which command ran, finding the right output among files, and manually reconstructing what remains. An interrupted or repeated run can use the wrong PRD/TRD, skip a required refinement, or duplicate planning work. Planning and implementation are also distinct decisions, while creating a pull request is a further external action; a linear command chain does not make those boundaries reliably resumable or explicit.

**Solution:** Add a `new-feature` workflow alongside existing product capabilities such as `fix-issue`. It coordinates the existing PRD/TRD authoring and refinement capabilities, bead planning, an explicitly approved implementation phase, and an optional separately approved pull-request creation phase. Each run records its stage and exact artifact references so it can resume from a known checkpoint rather than conversation history or newest-file heuristics.

**Value proposition:** A requester can move an idea through product and technical planning into implementation with visible checkpoints, reliable continuation after interruption, preserved artifact lineage, and explicit control over when implementation or an external PR write begins.

**Target users:**
- **Feature requester / product owner:** starts a feature from an idea, reviews and refines its PRD/TRD, and decides whether work proceeds.
- **Engineer / implementer:** resumes from the exact approved plan and bead references without reconstructing prior chat context.
- **Project maintainer:** configures approved event entry points and ensures the workflow stays inside the project's execution and approval boundaries.

**Implementation context for the TRD:** Keep the workflow contract provider-neutral while shipping the first host on OMP, as selected during discovery. Determine concrete host APIs, artifact metadata shape, project-index path/locking, and supported pull-request provider capability in the TRD. Treat `pi-workflow-kit` as a learning/integration candidate, not a required dependency or security boundary.

## Goals and Non-Goals

**Goals:**
- Provide one resumable product workflow for `create-prd → refine-prd → create-trd → refine-trd → implement-trd-beads`, with a distinct approval checkpoint before implementation.
- Track run state and exact PRD, TRD, and bead references in project-local persisted records.
- Resume only from a known run checkpoint; preserve completed artifacts when a stage fails or an artifact is revised.
- Permit manual starts and explicitly configured event-triggered starts without allowing event payloads to bypass human review or required elicitation.
- Make pull-request creation optional and require separate approval immediately before that external write.
- Preserve existing standalone commands and the separate `fix-issue` capability.

**Non-Goals:**
- Do not implement or change this workflow in this PRD.
- Do not replace or merge the `fix-issue` workflow with `new-feature`.
- Do not make Ensemble a durable production scheduler, autonomous retry/recovery service, or competing control plane to Foreman.
- Do not make `pi-workflow-kit` or a particular PR-hosting integration a required dependency.
- Do not infer resume stages from unindexed legacy files, conversation history, timestamps, or “newest file” selection.
- Do not create a pull request automatically as a side effect of completing implementation.
- Do not specify the implementation architecture, persistence technology, host API, or detailed sprint plan; those belong in the TRD.

## Requirements by Feature Area

### Workflow Entry and Stage Contract

### REQ-001: Start a feature run from an idea or a known run artifact
**Priority:** Must | **[RISK: accepting an unrelated or stale artifact could attach work to the wrong feature run]**

- AC-001-1: Given the user manually starts `new-feature` with an idea and no active run exists for the project, when the start is accepted, then the workflow creates one run at the PRD-creation stage and identifies that run in its status output.
- AC-001-2: Given the user supplies an artifact path that is referenced by the project's active `new-feature` run record, when the user resumes, then the workflow opens that recorded run at its recorded stage and shows the matched artifact reference.
- AC-001-3: Given the user supplies a PRD or TRD that is not referenced by an indexed `new-feature` run, when the user attempts to resume from it, then the workflow rejects the input, explains that only indexed runs can be resumed, and neither creates nor advances a run.

### REQ-002: Follow a fixed, inspectable stage sequence
**Priority:** Must

- AC-002-1: Given a new run starts from an idea, when it advances successfully, then its required stages occur in this order: create PRD, refine PRD, create TRD, refine TRD, plan beads, obtain implementation approval, implement the approved bead work.
- AC-002-2: Given implementation is complete, when the user does not request PR creation, then the run can complete without entering PR creation; when the user requests it, then PR creation is offered only as an optional subsequent stage.
- AC-002-3: Given the current stage has not reached its completion outcome, when the workflow is resumed or invoked again, then no later required stage is run and no prerequisite is treated as satisfied merely because a similarly named file exists.

### REQ-003: Keep both refinement stages mandatory
**Priority:** Must

- AC-003-1: Given the user invokes `new-feature` with `--skip-refine` or an equivalent request to omit refinement, when the command validates its options, then it rejects the request and explains that both PRD and TRD refinement are mandatory in this workflow.
- AC-003-2: Given the user wants to omit orchestration but use individual authoring commands, when the skip request is rejected, then the workflow directs the user to invoke the existing standalone commands separately without changing their behavior.

### Artifact Lineage and Resume

### REQ-004: Bind every stage to explicit, traceable artifacts
**Priority:** Must | **[RISK: an incorrect artifact association can cause implementation of an unreviewed or unrelated plan]**

- AC-004-1: Given a stage produces or refines an artifact, when its outcome is recorded, then the run record identifies the exact artifact reference, artifact type, producing stage, and the run to which it belongs.
- AC-004-2: Given a later stage requires a PRD, TRD, or bead plan, when that stage begins, then it consumes the exact reference recorded by its prerequisite stage and not a path selected by recency, filename similarity, or conversation context.
- AC-004-3: Given a PRD or TRD is revised during its refinement stage, when the revised artifact is accepted, then the run's current reference is updated while the prior artifact/version remains available for review and recovery.

### REQ-005: Persist checkpoints and identify the active run from a project-local index
**Priority:** Must

- AC-005-1: Given any stage reaches a success, decline, failure, or approval-wait outcome, when the workflow records the checkpoint, then a project-local run index identifies the active run, exact current stage, stage outcome, and available PRD, TRD, and bead references.
- AC-005-2: Given the user starts or resumes the workflow in a later session, when the project index is valid, then the workflow discovers the active run and stage from that index without requiring prior chat history.
- AC-005-3: Given the project index is absent, malformed, or internally inconsistent, when the workflow tries to resume, then it fails closed with a recoverable diagnostic instead of guessing from files or advancing the run.

### REQ-006: Pause failures and resume only at the failed or pending stage
**Priority:** Must | **[RISK: automatic retries or inferred recovery could repeat side effects or bypass approval]**

- AC-006-1: Given a stage fails, when the workflow reports the outcome, then it pauses at that stage, preserves all previously completed artifacts and references, and shows the error and stage name.
- AC-006-2: Given a stage is paused after failure, when the user explicitly retries it or edits its input and resumes, then only that stage is rerun; completed earlier stages are not silently repeated and later stages remain blocked.
- AC-006-3: Given no user retry or resume action is made, when time passes or another event arrives, then the workflow does not autonomously retry, recover, or advance the paused run.

### REQ-007: Return declined or edited outputs to the same stage
**Priority:** Must

- AC-007-1: Given the user declines a generated or refined PRD or TRD, when the workflow records the decision, then it remains at that artifact's current stage and asks for the correction or input needed to continue.
- AC-007-2: Given the user edits or requests regeneration of a PRD or TRD, when the new version is produced, then the prior version remains referenced in run history and no dependent stage starts until the current version is accepted.

### REQ-008: Allow only one active feature run per project
**Priority:** Must

- AC-008-1: Given a project already has an active or paused `new-feature` run, when a user tries to start another run in that project, then the workflow blocks the second start and identifies how to resume or explicitly abandon the active run.
- AC-008-2: Given a run is explicitly abandoned or completed, when the project index records that terminal outcome, then a new run can be started without deleting the abandoned run's artifacts or history.
- AC-008-3: Given a run is merely interrupted or has not been updated recently, when another run is requested, then it remains active and is not automatically expired or abandoned.

### Triggering and Human Decisions

### REQ-009: Support manual and explicitly configured event-triggered starts
**Priority:** Must | **[RISK: event payloads can be incomplete, untrusted, or mistaken for user intent]**

- AC-009-1: Given no event mapping is configured, when an event occurs, then it does not start a `new-feature` run; manual invocation remains available.
- AC-009-2: Given a project explicitly configures an event mapping and an allowed event occurs, when the event is delivered, then the workflow presents the event source and payload for human review and completes required PRD elicitation before creating or advancing the PRD stage.
- AC-009-3: Given the event payload is invalid, incomplete, or declined by the user, when the workflow handles it, then it creates no PRD and does not advance the run; it reports which validation or review step is pending.

### REQ-010: Require explicit user approval before implementation
**Priority:** Must

- AC-010-1: Given PRD refinement, TRD refinement, and bead planning have completed, when the workflow reaches the implementation checkpoint, then it presents the accepted PRD/TRD references and bead plan and waits for an explicit approval to begin implementation.
- AC-010-2: Given implementation approval is absent or declined, when the workflow is invoked, then it does not execute implementation work and preserves the run at the approval checkpoint for later resume.
- AC-010-3: Given implementation is approved, when the workflow begins implementation, then the approval applies only to the presented plan and any material change to that plan returns to the approval checkpoint.

### REQ-011: Make PR creation optional and separately approved
**Priority:** Must | **[RISK: opening a PR is an externally visible write and may notify collaborators]**

- AC-011-1: Given all required implementation work is reported complete, when the user chooses not to create a PR, then the workflow records completion without making a PR-hosting service write.
- AC-011-2: Given the user requests PR creation and a supported PR-creation capability is configured, when the workflow is ready to create the PR, then it presents the target repository/branch and proposed title/body and obtains a separate, immediate explicit approval before the external create operation.
- AC-011-3: Given PR approval is absent, is declined, or no supported PR-creation capability is available, when the workflow reaches this optional stage, then it creates no PR, reports the outcome, and preserves the completed implementation record.

### Product Entry, Safety, and Compatibility

### REQ-012: Make run state and outcomes visible to the user
**Priority:** Should

- AC-012-1: Given the user asks for status or resumes a run, when the workflow responds, then it shows the run identifier, current stage, last stage outcome, pending decision or failure, and exact PRD/TRD/bead references that exist.
- AC-012-2: Given a run completes or is abandoned, when the final status is shown, then it identifies the terminal outcome and the retained artifact references without implying that an optional PR was created when it was not.

### REQ-013: Keep `new-feature` additive to existing product commands
**Priority:** Should

- AC-013-1: Given the new workflow is available, when a user invokes an existing standalone planning command or `fix-issue`, then its existing entry point and documented behavior remain available and are not redirected into `new-feature`.
- AC-013-2: Given a user invokes the `new-feature` product entry point, when the product loads its available commands, then the workflow is discoverable alongside the existing feature/issue capabilities.

### REQ-014: Enforce input and mutation boundaries independently of prompt instructions
**Priority:** Should | **[RISK: prompt-only safeguards can be bypassed by a model or malformed input]**

- AC-014-1: Given an event payload, artifact reference, or user-supplied path crosses the workflow boundary, when it is accepted, then it is validated and an invalid or disallowed value is rejected before it changes run state or selects a tool.
- AC-014-2: Given a stage would perform implementation or create a PR, when runtime authority does not include the corresponding user-approved mutation, then the operation is denied even if prompt text requests or claims approval.
- AC-014-3: Given a user-owned strategy, review rubric, or authoring instruction is expected to vary between projects, when the workflow is packaged, then it is represented in an editable prompt, skill, or behavior artifact rather than requiring a code rebuild to specialize it.

## Ambiguity Scan

Ambiguity scan complete: 0 items marked for clarification. The initial-host selection and provider-neutral workflow contract were confirmed during discovery; host APIs, index format, and PR-provider implementation are deferred to the TRD. Unindexed legacy PRDs/TRDs are explicitly not resume records.

## Dependency Map

| REQ | Depends On | Notes |
|-----|------------|-------|
| REQ-001 | REQ-005 | Start/resume requires project index and run identity |
| REQ-002 | REQ-004, REQ-005 | Ordered stage transitions require exact prerequisites and checkpoints |
| REQ-003 | REQ-002 | Mandatory refinement is enforced by the stage contract |
| REQ-004 | REQ-005 | Artifact lineage is persisted with the run checkpoint |
| REQ-005 | — | Project-local source of active-run discovery |
| REQ-006 | REQ-004, REQ-005 | Retry must preserve prior outputs and checkpoint identity |
| REQ-007 | REQ-004, REQ-006 | Revision retains prior artifact and blocks dependent stages |
| REQ-008 | REQ-005 | Active-run uniqueness is enforced by the project index |
| REQ-009 | REQ-001, REQ-014 | Event start uses validated inputs and human review |
| REQ-010 | REQ-002, REQ-004, REQ-005 | Implementation approval follows the recorded plan checkpoint |
| REQ-011 | REQ-010, REQ-014 | PR is post-implementation and independently authorized |
| REQ-012 | REQ-005 | Status reports derive from persisted outcomes and references |
| REQ-013 | — | Additive compatibility constraint |
| REQ-014 | REQ-009, REQ-010, REQ-011 | Boundary validation and runtime authorization span trigger and mutation stages |

**Implementation clusters:** {REQ-001, REQ-002, REQ-003, REQ-004, REQ-005} entry, ordered stages, and artifact/index contract · {REQ-006, REQ-007, REQ-008, REQ-012} continuation and run lifecycle · {REQ-009, REQ-010, REQ-011, REQ-014} triggers, human approval, and mutation boundaries · {REQ-013} product compatibility.

No circular dependencies identified.

## Adversarial Review

| Issue | Category | Resolution |
|-------|----------|------------|
| A user may provide an old PRD/TRD and expect the workflow to infer where to continue. | Ambiguity / wrong-artifact risk | Explicitly reject unindexed documents as resume inputs; resume only when the supplied artifact is referenced by the active run index. |
| Newest-file lookup can select another feature's artifact or an obsolete revision. | Gap | Require exact run-linked artifact references for all stage prerequisites; disallow recency and filename heuristics. |
| A workflow-level failure retry could re-run completed side effects. | Missing edge case | Pause at the failed stage, preserve prior artifacts, and require user-initiated retry/resume; prohibit autonomous retry or recovery. |
| A sequence with mandatory refinements could still be bypassed with a convenience flag. | Contradiction | Make both refinements mandatory in `new-feature` and reject `--skip-refine`, while leaving standalone commands usable. |
| “Implementation approval” could be interpreted as approval for every later external action. | Safety gap | Separate the implementation gate from an immediate, distinct approval for optional PR creation. |
| An event trigger could turn an incomplete payload into a silently accepted product specification. | Missing edge case | Require payload validation, human review, and completion of PRD elicitation before creating/advancing a PRD. |
| A prompt may claim a user approved implementation or PR creation without a real authority grant. | Testability / security | Require runtime-enforced mutation authority and observable rejection when the corresponding user approval is absent. |
| A provider-specific PR API decision could prematurely bind the PRD to one integration. | Feasibility / scope | State the user-visible capability and unavailable-provider outcome; defer provider selection and integration design to the TRD. |

All issues were resolved using discovery decisions and explicit, provider-neutral requirements; no additional user decision is required for this PRD.

## Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|-----------|:-:|-------|
| Completeness | 4.6 | Covers entry modes, stage ordering, artifact lineage, checkpoints, failures, concurrency, triggers, approvals, optional PR creation, and compatibility. |
| Testability | 4.8 | All 14 requirements have observable Given/When/Then criteria, including rejection and no-side-effect cases. |
| Clarity | 4.4 | Resume rules and approval boundaries are explicit; concrete index and provider contracts remain appropriately deferred to the TRD. |
| Feasibility | 4.4 | Builds on existing planning capabilities and limits new scope to orchestration, persisted run identity, gates, and optional event/PR capabilities. |
| **Overall** | **4.55** | **PASS** |

**Gate decision: PASS.** Recommended next step: `/ensemble:create-trd docs/PRD/PRD-2026-d6bbf322-new-feature-workflow.md`.

## Constitution Gate

Constitution Gate: running

| Source | Check | Result |
|--------|-------|--------|
| `docs/standards/constitution.md` §1 Core Principles | Keep Ensemble a portable behavior-definition, packaging, validation, and local-harness project; do not assign it durable production coordination. | PASS — manual/local workflow and user-mediated continuation only; no durable scheduler or control-plane ownership is required. |
| Non-Negotiable Rule 1: No secrets in code | Ensure requirements do not embed credentials or require hard-coded secrets. | PASS — provider credentials are not specified or embedded; provider configuration is deferred to the TRD. |
| Non-Negotiable Rule 2: Input validation required | Validate external inputs at workflow boundaries. | PASS — REQ-009 and REQ-014 require event/artifact validation and fail-closed rejection. |
| Non-Negotiable Rule 3: Tests accompany features | Include testable acceptance conditions for feature behavior. | PASS — all Must and Should requirements have GWT acceptance criteria. |
| Non-Negotiable Rule 4: Ownership boundary is preserved | Avoid durable activation, scheduling, autonomous retries/recovery, and a competing dispatcher. | PASS — REQ-006 requires explicit user retry; Goals/Non-Goals preserve Foreman ownership of durable coordination. |
| Non-Negotiable Rule 5: Governed tool boundary is enforced at runtime | Do not rely on model instructions for mutation authority. | PASS — REQ-010, REQ-011, and REQ-014 require separate approvals and runtime-enforced denial. |
| Non-Negotiable Rule 6: Reachable from product entry point | Make the capability discoverable and verify it through the product entry point. | PASS — REQ-013 requires discoverability alongside existing capabilities. |
| Non-Negotiable Rule 7: A verification must be able to fail | Make acceptance checks capable of detecting bypass, bad references, and unauthorized writes. | PASS — rejection ACs specify observable failures for each guarded case. |
| Non-Negotiable Rule 8: User-changeable behavior belongs in editable artifacts | Do not hard-code project-specific strategies that users need to customize. | PASS — REQ-014 requires editable prompts, skills, or behavior artifacts for user-owned strategies. |
| Constitution amendment 2026-09-29: test verdicts use command exit status | Avoid introducing a test-monitoring verdict requirement based only on output text. | PASS — this PRD does not define test-monitoring verdicts; verification implementation remains subject to the constitution. |

Constitution compliance: passed

## Changelog

### 2026-09-30 — v1.0.0

- Initial STANDARD PRD for a resumable `new-feature` workflow.
- Defined mandatory PRD/TRD refinement, project-indexed checkpoints, explicit resume semantics, manual and configured event starts, and separate implementation/PR approvals.
- Deferred OMP host details, index representation, and PR-provider selection to the TRD.
