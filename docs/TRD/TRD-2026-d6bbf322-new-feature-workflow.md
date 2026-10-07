---
document_id: TRD-2026-d6bbf322
label: trd-new-feature-workflow
kind: trd
prd_reference: PRD-2026-d6bbf322
prd_path: docs/PRD/PRD-2026-d6bbf322-new-feature-workflow.md
version: 1.0.0
status: Draft
date: 2026-09-30
design_readiness_score: 4.6
ensemble_implement_trd_beads:
  branch_name: feature/trd-2026-d6bbf322-new-feature-workflow
  use_proposed: true
  stacked_prs: false
---

# TRD-2026-d6bbf322: Resumable New-Feature Workflow for Ensemble

Source PRD: [PRD-2026-d6bbf322](../PRD/PRD-2026-d6bbf322-new-feature-workflow.md) (readiness 4.58, PASS).

PRD: docs/PRD/PRD-2026-d6bbf322-new-feature-workflow.md

## Reused Capabilities

None. `node packages/development/lib/trd-graph-cli.js capabilities docs/TRD --json` returns an empty registry — no `kind: foundational` TRD exists in this repo, so there is no shared capability to reference instead of rebuilding.

This TRD does reuse existing, non-foundational patterns directly (not via the capability-reuse mechanism, since they are not foundational TRDs): `fix-issue.yaml`'s orchestrating-skill structure and its `gh pr create` invocation; `packages/core/lib/refinement-review/session.js`'s `writeJsonAtomic` + `mutateSession` atomic-write/optimistic-concurrency primitives; `packages/agent-core/src/cqrs/proposal-store.ts`'s `.ensemble/<kind>/<ref>.json` storage convention; and the `ask_user` tool pattern already used by create-prd/refine-prd/create-trd/refine-trd and fix-issue's own user-interview step.

## Architecture Decision

**Chosen: Option C — hardened in-session stage composition with a dedicated atomic run-index store.**

`new-feature` is authored the same way every other product command in this repo is authored: a single orchestrating skill (`packages/development/commands/new-feature.yaml`, generated to runtime-specific prompts exactly like `fix-issue.yaml`) that executes each stage's existing skill body in-session — the same mechanism that loaded `ensemble-refine-prd`'s content into this session and had the agent execute its Phases directly. This is forced, not merely preferred: Pi's `ExtensionAPI` has no completion/invoke primitive that would let an extension programmatically run another skill and get its result back (confirmed — no `pi.invokeCommand` or equivalent exists); the only code-level "run a skill" mechanism, `createAgentPort()`, spawns a bounded, disposable `omp -p --no-session --no-extensions` subprocess in an isolated worktree, and does not fit a long-lived, project-resident workflow whose PRD/TRD stages use the interactive `--collab` review server.

What is new, and is the one piece of real infrastructure this TRD adds: a `RunIndexStore` (`packages/agent-core/src/new-feature/run-index.ts`) built on the one proven concurrency-safe pattern in this repo — `session.js`'s temp-file-then-`renameSync` atomic write plus `expectedRevision`/409-style optimistic concurrency — rather than `ProposalStore`'s plain `writeFileSync` (no atomicity, no lock, not adequate for PRD AC-005-3's fail-closed-on-malformed-index requirement). Runs are stored at `.ensemble/new-feature/<run-id>.json`, mirroring `ProposalStore`'s `.ensemble/proposals/<ref>.json` convention (also excluded from `tree-baseline.ts` drift detection, so this is consistent runtime-owned state, not a project-source mutation).

### Alternatives considered

| Option | Summary | Why not chosen |
|---|---|---|
| A — Plain JSON checkpoint | Same in-session composition, but checkpoints are a single `writeFileSync`, no atomicity/locking. | Fastest to build, but a crash mid-write can corrupt the run index, which directly violates AC-005-3's "fail closed with a recoverable diagnostic" requirement — the repo's own `ProposalStore` already demonstrates this gap is real, not hypothetical. |
| B — Subprocess-dispatched stages | New orchestrator module dispatches every stage as a bounded `createAgentPort()` subprocess; advances the run index only after subprocess exit 0 + artifact-on-disk confirmation. | Most rigorous completion signal (a real process boundary instead of self-reported bookkeeping), but substantially more build effort, and does not fit the interactive `--collab` review-server stages `create-prd`/`refine-prd` already use — those are long-lived, human-attended HTTP sessions, not bounded one-shot subprocess work, and would need bespoke carve-out handling under this option. |
| **C — Hardened in-session composition** *(chosen)* | In-session stage execution (like every existing product command), backed by a dedicated atomic `RunIndexStore`. | Reuses 100% of the existing skill-composition and `ask_user`-approval infrastructure (including the `--collab` review server, which needs no special-casing), while fixing Option A's one real correctness gap with the repo's one proven atomic-write pattern. Matches user-confirmed direction. |

### Honest trust-boundary note

Because stage execution stays in-session (per Option C), the approval gates implemented by TRD-014/TRD-017/TRD-019 are enforced by the orchestrating skill's own conditional logic checking `RunIndexStore`-persisted approval fields before it issues an implementation or `gh pr create` tool call — not by a separate runtime authorization chokepoint like `agent-core`'s former `MutationGuard` (which gated CQRS-registered commands in this repo's now-removed behavior-runtime subsystem, retained on the `pi-behaviors` branch; `new-feature`'s mutating actions are ordinary skill-level tool calls, same as `fix-issue`'s own gated PR-creation step, not CQRS commands). This is the same trust boundary every existing Ensemble product command already operates under. Building a `MutationGuard`-equivalent chokepoint for skill-level tool calls is a materially larger investment this PRD does not request and no other product command has; REQ-014's "runtime authority" is satisfied here by making the check a required precondition over persisted, validated store state rather than over prompt claims — which is what AC-014-2 actually asks for — not by inventing a new enforcement subsystem.

## Component Design

| Component | Package | Responsibility | Key interface |
|---|---|---|---|
| `RunIndexStore` | agent-core | Atomic, concurrency-safe CRUD over project-local run records | `createRun(projectRoot, idea)`, `findActive(projectRoot)`, `resolveByArtifact(projectRoot, path)`, `mutate(runId, expectedRevision, updater)`, `abandon(runId, reason)`, `complete(runId)` |
| `RunRecord` (types) | agent-core | Schema for a run: stage, status, artifact refs, approval timestamps, revision | (types only, no runtime behavior) |
| `EventMappingConfig` | agent-core | Project-local, explicit opt-in schema for event-triggered starts | `loadEventMapping(projectRoot)`, `validateEventPayload(mapping, event)` |
| `PrProvider` | agent-core | Provider-neutral PR-creation seam | `isAvailable(): boolean`, `createPullRequest(params): Promise<{url}>` |
| `GhCliPrProvider` | agent-core | Concrete `gh`-CLI implementation, reusing `fix-issue.yaml`'s existing PR-creation invocation | implements `PrProvider` |
| `new-feature.yaml` | development/commands | Orchestrating skill: fixed stage sequence, in-session execution of each stage's existing skill body, checkpointing through `RunIndexStore`, approval gates via `ask_user` | generated to `commands/ensemble/new-feature.md`, `pi/prompts/ensemble-new-feature.md`, `codex/.codex/skills/commands/ensemble-new-feature/SKILL.md` |

**Data contracts.** `RunRecord = { runId: string; projectRoot: string; status: "active"|"paused"|"completed"|"abandoned"; stage: "prd_create"|"prd_refine"|"trd_create"|"trd_refine"|"beads_plan"|"implementation_approval"|"implementation"|"pr_approval"|"pr_create"|"done"; stageOutcome: { kind: "success"|"decline"|"failure"|"approval_wait"; detail?: string; recordedAt: string }; artifacts: Array<{ type: "prd"|"trd"; path: string; documentId: string; version: string; producingStage: string; recordedAt: string }>; beadRefs: string[]; implementationApprovedAt: string|null; prApprovedAt: string|null; revision: number; createdAt: string; updatedAt: string }`.

**Failure paths.** `RunIndexStore.mutate()` throws a typed `REVISION_CONFLICT` (mirroring `mutateSession`'s `{ code, status: 409, currentRevision }`) on a stale `expectedRevision`. Loading a malformed or internally inconsistent run file throws a typed `RUN_INDEX_CORRUPT` error instead of falling back to a directory scan or guessing (AC-005-3). `resolveByArtifact()` returns `undefined` (not a thrown error) for a path that is not referenced by any indexed run, which the calling stage in the orchestrating skill turns into AC-001-3's rejection message.

### Event-catalog honesty note

REQ-009 requires an explicit, project-local event-mapping contract with default-deny semantics (no mapping configured → no run starts), and this TRD delivers exactly that contract (TRD-012/TRD-013). It does **not** claim that a real event producer for "a feature idea arrived" exists today: per `packages/agent-core/src/behavior/event-disposition.ts`'s `EVENT_DISPOSITIONS` ledger, none of the semantic event families a feature-intake trigger would plausibly consume (`prd.*`, `trd.*`, `review.*`, `pull_request.*`) are in the `"keep"` (actually emitted) list — they are catalog vocabulary only. AC-009-1's default-deny behavior does not require a working producer to be correct; wiring an actual producer once one exists is out of scope for this TRD, consistent with the PRD's own instruction to defer provider/host specifics here rather than fabricate an integration this repo does not have.

## Master Task List

### PR 1: Entry, Ordered Stages, and Artifact/Index Foundation

**Shippable State:** A user can run `/ensemble:new-feature "<idea>"` and progress, checkpointed and resumable, through PRD creation, PRD refinement, TRD creation, TRD refinement, and bead planning, with exact artifact lineage recorded at every step. The run correctly halts at the implementation-approval checkpoint — no approval-granting mechanism exists yet in this PR, so nothing can reach implementation (PR 3 adds the mechanism that unblocks it). Supplying an unindexed PRD/TRD path is rejected rather than guessed at, and `--skip-refine` is rejected with guidance to the existing standalone commands.

- [x] **TRD-001**: Define `RunRecord`, `Stage`, `StageOutcome`, and `ArtifactRef` TypeScript types (1h) [satisfies REQ-005]
  - Target File: `packages/agent-core/src/new-feature/types.ts`
  - Actions:
    1. Declare the `RunRecord` interface and its nested types exactly as specified in Component Design's data contracts above.
    2. Declare the fixed `Stage` union in PRD stage order: `prd_create | prd_refine | trd_create | trd_refine | beads_plan | implementation_approval | implementation | pr_approval | pr_create | done`.
    3. Export all types from `packages/agent-core/src/index.ts`.

- [x] **TRD-002**: Implement `RunIndexStore` core (`createRun`, `findActive`, `resolveByArtifact`, `mutate`) on atomic-write + optimistic concurrency (6h) [depends: TRD-001] [satisfies REQ-005]
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-005-3
  - Target File: `packages/agent-core/src/new-feature/run-index.ts`
  - Actions:
    1. Implement `writeRunAtomic(filePath, value)` by porting `session.js`'s temp-file-then-`renameSync` pattern (`mkdirSync` recursive, `.${basename}.${pid}.${Date.now()}.tmp`, `fsyncSync` before rename).
    2. Implement `mutate(runId, expectedRevision, updater)`: load current record, reject a mismatched `expectedRevision` with a typed `REVISION_CONFLICT` (`{ code: "REVISION_CONFLICT", status: 409, currentRevision }`), else apply `updater`, bump `revision` by 1, `updatedAt = now()`, write atomically.
    3. Implement `findActive(projectRoot)`: read every `.ensemble/new-feature/*.json` under `projectRoot`, return the one record (if any) whose `status` is `"active"` or `"paused"`.
    4. Implement `resolveByArtifact(projectRoot, path)`: scan indexed runs' `artifacts[]` for an exact path match; return the owning `RunRecord` or `undefined`.
    5. On a malformed or internally inconsistent run file (JSON parse failure, missing required field, `stage` not in the fixed enum), throw a typed `RUN_INDEX_CORRUPT` error carrying the file path and reason — never silently skip or fall back to directory-scan guessing.
  - Implementation AC:
    - Given two `mutate()` calls against the same `runId` race with the same stale `expectedRevision`, when the second call applies, then it is rejected with `REVISION_CONFLICT` and the first writer's change is preserved.
    - Given a run file is truncated or has a non-enum `stage` value, when `findActive`/`resolveByArtifact` reads it, then a typed `RUN_INDEX_CORRUPT` error is thrown rather than the file being skipped or guessed at.
    - Given a process crash simulated by killing the writer between `openSync` and `renameSync`, when the store is reopened, then the prior valid run file is intact (the `.tmp` file, if any, is orphaned but never renamed over the real file).

- [x] **TRD-002-TEST**: Verify `RunIndexStore` atomicity, concurrency conflict detection, and fail-closed loading (3h) [verifies TRD-002] [satisfies REQ-005] [depends: TRD-002]
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-005-3
  - Target File: `packages/agent-core/tests/new-feature/run-index.test.ts`
  - Actions:
    1. Test `mutate()` with a stale `expectedRevision` throws `REVISION_CONFLICT` with `currentRevision` matching the on-disk value.
    2. Test loading a hand-corrupted run file (invalid JSON, and separately a missing `stage` field) throws `RUN_INDEX_CORRUPT` rather than returning `undefined`/guessing.
    3. Test `findActive` returns the correct single record among multiple terminal (`completed`/`abandoned`) runs on disk.
  - Test AC:
    - Given a malformed run file on disk, when `findActive(projectRoot)` is called, then it throws `RUN_INDEX_CORRUPT` and does not fall back to a directory scan.
    - Given a valid active run and two completed runs in the same `.ensemble/new-feature/` directory, when `findActive` is called, then only the active run is returned.

- [x] **TRD-003**: Implement the fixed stage-sequence state machine (4h) [depends: TRD-002] [satisfies REQ-002]
  - Validates PRD ACs: AC-002-1, AC-002-3
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. Define `workflow.phases` in the fixed PRD order: create PRD → refine PRD → create TRD → refine TRD → plan beads → obtain implementation approval → implement approved bead work, with an optional PR-creation phase strictly after implementation.
    2. On each invocation, read the current `RunRecord.stage` and `stageOutcome` from `RunIndexStore`; only the stage matching the current checkpoint is eligible to run next — a later stage is never entered because a similarly named output file happens to exist.
    3. Implement the optional-PR branch: completion without a PR request is a valid terminal state; a PR request only ever offers the PR-creation phase as a subsequent, separately gated stage (wired fully in PR 3; this PR only reserves the stage slot).
  - Implementation AC:
    - Given a new run advances successfully, when each stage completes, then the next stage entered matches the fixed order exactly (never skips or reorders).
    - Given the current stage has not reached a `success` outcome, when the command is invoked again, then no later stage runs, regardless of which artifact files exist on disk.

- [x] **TRD-003-TEST**: Verify stage ordering and no-skip-ahead behavior (3h) [verifies TRD-003] [satisfies REQ-002] [depends: TRD-003]
  - Validates PRD ACs: AC-002-1, AC-002-3
  - Target File: `packages/development/tests/new-feature-command.test.js`
  - Actions:
    1. Assert the parsed `workflow.phases` order matches the PRD's required sequence exactly.
    2. Simulate a run record parked at `trd_create` with a stray `beads_plan`-looking file present; verify the next invocation still executes `trd_create`, not `beads_plan`.
  - Test AC:
    - Given a `RunRecord` at `stage: "trd_create"` with `stageOutcome.kind` not `"success"`, when the command runs, then it executes the TRD-creation stage and does not treat any existing file as satisfying a later stage.

- [x] **TRD-004**: Implement inline stage execution and artifact-reference recording (5h) [depends: TRD-003] [satisfies REQ-004]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-004-3
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. For each of `prd_create`/`prd_refine`/`trd_create`/`trd_refine`/`beads_plan`, read that stage's existing skill body (`ensemble-create-prd`, `ensemble-refine-prd`, `ensemble-create-trd`, `ensemble-refine-trd`, the beads-planning skill) and execute its instructions in-session — the same mechanism that loaded `ensemble-refine-prd`'s content into this session.
    2. Immediately after a stage's outcome is `success`, call `RunIndexStore.mutate()` to append the produced artifact's exact `{ type, path, documentId, version, producingStage, recordedAt }` to `artifacts[]` before advancing `stage`.
    3. When a later stage consumes a PRD/TRD, pass it the exact recorded `artifacts[]` entry's `path` — never a path selected by globbing, recency, or conversational context.
    4. On a PRD/TRD revision during refinement, append the new artifact entry rather than overwriting the prior one; the prior entry remains in `artifacts[]` for history and recovery (AC-004-3).
  - Implementation AC:
    - Given `prd_create` completes, when the checkpoint is recorded, then `artifacts[]` gains an entry with `type: "prd"`, the exact file path, `documentId`, and `producingStage: "prd_create"`.
    - Given `trd_create` begins, when it needs the PRD, then it is invoked with the exact `path` from the `artifacts[]` entry recorded by `prd_refine`, not a freshly globbed path.
    - Given `prd_refine` revises the PRD, when the revision is accepted, then both the prior and the new artifact entries are present in `artifacts[]`.

- [x] **TRD-004-TEST**: Verify exact artifact-reference recording and consumption (3h) [verifies TRD-004] [satisfies REQ-004] [depends: TRD-004]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-004-3
  - Target File: `packages/agent-core/tests/new-feature/run-index.test.ts`
  - Actions:
    1. Drive a `RunRecord` through two simulated stage completions; assert `artifacts[]` contains exact-match entries with all required fields.
    2. Assert a stubbed later-stage consumer receives the recorded `path`, not a re-derived one.
    3. Assert a revision appends rather than replaces the prior artifact entry.
  - Test AC:
    - Given two sequential artifact-recording `mutate()` calls, when `artifacts[]` is inspected, then both entries are present with distinct `recordedAt` timestamps and correct `producingStage` values.

- [x] **TRD-005**: Implement manual start and resume entry (5h) [depends: TRD-002] [satisfies REQ-001]
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-001-3
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. Idea input (no active run for the project): call `RunIndexStore.createRun(projectRoot, idea)`, creating a run at `stage: "prd_create"`; print the new run's identifier.
    2. Artifact-path input: call `RunIndexStore.resolveByArtifact(projectRoot, path)`; if found, resume that run at its recorded `stage`, showing the matched artifact reference.
    3. Artifact-path input not found by `resolveByArtifact`: reject with an explanation that only indexed runs can be resumed; create no run and advance nothing.
  - Implementation AC:
    - Given a manual start with an idea and no active run, when accepted, then exactly one run is created at `prd_create` and its identifier is shown.
    - Given an artifact path matching an indexed run's recorded reference, when resumed, then the workflow opens that run at its recorded stage.
    - Given an artifact path not referenced by any indexed run, when resume is attempted, then it is rejected and no run is created or advanced.

- [x] **TRD-005-TEST**: Verify start/resume/reject-unindexed entry paths (3h) [verifies TRD-005] [satisfies REQ-001] [depends: TRD-005]
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-001-3
  - Target File: `packages/development/tests/new-feature-command.test.js`
  - Actions:
    1. Simulate a fresh project (no `.ensemble/new-feature/` runs); start with an idea; assert one run created at `prd_create`.
    2. Simulate an indexed run referencing a PRD path; resume with that exact path; assert the correct run/stage is opened.
    3. Resume with an arbitrary PRD path not in any run's `artifacts[]`; assert rejection and no run created.
  - Test AC:
    - Given an unindexed PRD path, when resume is attempted, then the rejection message explains that only indexed runs can be resumed.

- [x] **TRD-006**: Reject `--skip-refine` and equivalent flags (1h) [depends: TRD-003] [satisfies REQ-003]
  - Validates PRD ACs: AC-003-1, AC-003-2
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. In option validation, detect `--skip-refine` (and any documented equivalent) and reject the invocation before any stage runs.
    2. The rejection message states both PRD and TRD refinement are mandatory in this workflow, and directs the user to the existing standalone `create-prd`/`refine-prd`/`create-trd`/`refine-trd` commands (unchanged) if they want to skip orchestration but not refinement.
  - Implementation AC:
    - Given `--skip-refine` is passed, when options are validated, then the command rejects the request and names both mandatory refinement stages before any stage executes.

- [x] **TRD-006-TEST**: Verify `--skip-refine` rejection and standalone-command guidance (1h) [verifies TRD-006] [satisfies REQ-003] [depends: TRD-006]
  - Validates PRD ACs: AC-003-1, AC-003-2
  - Target File: `packages/development/tests/new-feature-command.test.js`
  - Actions:
    1. Invoke with `--skip-refine`; assert rejection and that the standalone commands are named, unmodified.
  - Test AC:
    - Given `--skip-refine`, when the command validates options, then it rejects and points to the standalone commands without changing their behavior.

### PR 2: Continuation and Run Lifecycle

**Shippable State:** Failed stages pause safely, preserve every previously completed artifact, and require an explicit user retry rather than silently repeating or advancing. Declined or edited PRD/TRD outputs correctly return to their own stage without corrupting run history or unblocking a dependent stage early. A project is protected from a second concurrent run while still permitting a fresh run once the prior one reaches a terminal state, and a merely-stale (not terminal) run is never auto-abandoned. `new-feature --status` gives full visibility into any run.

- [x] **TRD-007**: Implement failure pause (4h) [depends: TRD-004] [satisfies REQ-006]
  - Validates PRD ACs: AC-006-1
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. Wrap each stage's in-session execution; on an exception or reported failure, call `RunIndexStore.mutate()` recording `stageOutcome: { kind: "failure", detail: <error> }` at the current `stage`, leaving `artifacts[]` untouched.
    2. Print the error and stage name; do not advance, do not retry within the same invocation.
  - Implementation AC:
    - Given a stage throws, when the outcome is recorded, then the run is parked at that stage with `stageOutcome.kind === "failure"` and all prior `artifacts[]` entries are unchanged.

- [x] **TRD-007-TEST**: Verify failure pause preserves prior artifacts and does not auto-retry (3h) [verifies TRD-007] [satisfies REQ-006] [depends: TRD-007]
  - Validates PRD ACs: AC-006-1, AC-006-3
  - Target File: `packages/agent-core/tests/new-feature/run-index.test.ts`
  - Actions:
    1. Simulate a stage failure after two successful prior stages; assert both prior artifact entries survive and the failed stage's outcome is recorded.
    2. Simulate a second invocation with no user retry action; assert the run record is unchanged (no autonomous retry/advance).
  - Test AC:
    - Given a paused-by-failure run, when the command is invoked again with no retry/resume action from the user, then the run record's `stage`/`stageOutcome`/`revision` are unchanged.

- [x] **TRD-008**: Implement explicit-retry-only resume of a failed stage (3h) [depends: TRD-007] [satisfies REQ-006]
  - Validates PRD ACs: AC-006-2
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. On an explicit user retry (or edited input) for a paused-by-failure run, re-execute only the currently parked stage; completed earlier stages are not rerun and later stages remain blocked until this one succeeds.
  - Implementation AC:
    - Given a user explicitly retries a failed stage, when it succeeds, then only that stage's artifact/outcome changes; earlier stages' recorded artifacts are untouched.

- [x] **TRD-008-TEST**: Verify retry reruns only the paused stage (2h) [verifies TRD-008] [satisfies REQ-006] [depends: TRD-008]
  - Validates PRD ACs: AC-006-2
  - Target File: `packages/development/tests/new-feature-command.test.js`
  - Actions:
    1. Simulate a retry on a paused-by-failure run; assert only the parked stage re-executes and earlier artifacts are byte-identical before/after.
  - Test AC:
    - Given an explicit retry, when it completes, then earlier completed stages' artifact entries are unchanged.

- [x] **TRD-009**: Implement decline/edit handling for PRD/TRD stages (4h) [depends: TRD-004] [satisfies REQ-007]
  - Validates PRD ACs: AC-007-1, AC-007-2
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. On a user decline of a generated/refined PRD or TRD, record the decision and remain at that stage, asking for the correction/input needed to continue; do not advance.
    2. On an edit/regeneration request, produce the new version, append it to `artifacts[]` (preserving the prior version per TRD-004), and block any dependent stage from starting until the new version is explicitly accepted.
  - Implementation AC:
    - Given a decline, when recorded, then the run remains at the same stage and the run record shows no advance.
    - Given a regenerate/edit request, when the new version is produced, then the prior artifact entry remains in history and no dependent stage's outcome becomes `success` until acceptance.

- [x] **TRD-009-TEST**: Verify decline/edit stage-return and history preservation (3h) [verifies TRD-009] [satisfies REQ-007] [depends: TRD-009]
  - Validates PRD ACs: AC-007-1, AC-007-2
  - Target File: `packages/development/tests/new-feature-command.test.js`
  - Actions:
    1. Simulate a decline; assert the run stays at the current stage and requests correction.
    2. Simulate an edit/regenerate; assert both artifact versions are in history and the dependent stage has not started.
  - Test AC:
    - Given a dependent stage after an unaccepted edit, when the run is inspected, then that dependent stage has not been entered.

- [x] **TRD-010**: Enforce single-active-run-per-project with create-time exclusivity (3h) [depends: TRD-002] [satisfies REQ-008]
  - Validates PRD ACs: AC-008-1, AC-008-2, AC-008-3
  - Target File: `packages/agent-core/src/new-feature/run-index.ts`
  - Actions:
    1. `createRun()` first writes a marker file `.ensemble/new-feature/active.lock` using `fs.writeFileSync(path, runId, { flag: "wx" })` — write-exclusive, which fails atomically (`EEXIST`) if another active/paused run's marker already exists; this is the create-time exclusivity primitive `mutate()`'s `expectedRevision` check cannot provide (there is no prior revision for a brand-new file).
    2. On `EEXIST`, reject the second start, identifying the existing active/paused run's id and how to resume or abandon it.
    3. On `abandon()`/`complete()`, remove `active.lock` (but never delete the run's own `.json` history file), permitting a new `createRun()` to succeed.
    4. Never remove `active.lock` or mark a run abandoned based on elapsed time alone — only an explicit user/abandon action does so.
  - Implementation AC:
    - Given `active.lock` already exists, when `createRun()` is called, then it throws a typed "run already active" error naming the existing `runId` and does not write a second run file.
    - Given a run is completed or abandoned, when `active.lock` is removed, then a subsequent `createRun()` succeeds and the terminal run's `.json` file still exists on disk.
    - Given a run has not been updated in a long time but is still `active`/`paused`, when `createRun()` is called again, then it is still rejected (no auto-expiry).

- [x] **TRD-010-TEST**: Verify single-active-run exclusivity and terminal-state transitions (3h) [verifies TRD-010] [satisfies REQ-008] [depends: TRD-010]
  - Validates PRD ACs: AC-008-1, AC-008-2, AC-008-3
  - Target File: `packages/agent-core/tests/new-feature/run-index.test.ts`
  - Actions:
    1. Create a run, then attempt a second `createRun()`; assert rejection naming the first run.
    2. Complete/abandon the run, then `createRun()` again; assert success and that the first run's history file still exists.
    3. Simulate an old `updatedAt` on an active run; assert a second `createRun()` is still rejected.
  - Test AC:
    - Given two back-to-back `createRun()` calls with no terminal state in between, when the second runs, then it fails with the first run's identifier in the error.

- [x] **TRD-011**: Implement `new-feature --status` reporting (3h) [depends: TRD-002] [satisfies REQ-012]
  - Validates PRD ACs: AC-012-1, AC-012-2
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. On `--status` (or a bare resume with no idea/path argument), read the active/paused run (or the most recent terminal run if none is active) and print: run identifier, current stage, last stage outcome, pending decision/failure detail, and every recorded `artifacts[]`/`beadRefs` reference that exists.
    2. On a completed/abandoned run, state the terminal outcome and retained references without ever implying a PR was created unless `prApprovedAt` and a recorded PR artifact are both present.
  - Implementation AC:
    - Given `--status` on an active run, when it responds, then all five required fields (id, stage, outcome, pending decision, references) are present.
    - Given a completed run with no PR created, when status is shown, then nothing in the output implies a PR exists.

- [x] **TRD-011-TEST**: Verify status completeness and no-implied-PR wording (2h) [verifies TRD-011] [satisfies REQ-012] [depends: TRD-011]
  - Validates PRD ACs: AC-012-1, AC-012-2
  - Target File: `packages/development/tests/new-feature-command.test.js`
  - Actions:
    1. Assert `--status` output on an active run contains all five required fields.
    2. Assert a completed run with `prApprovedAt: null` produces status text that does not mention a PR as existing.
  - Test AC:
    - Given a completed run with no PR, when `--status` output is scanned, then it contains no PR-exists claim.

### PR 3: Triggers, Human Approval, and Mutation Boundaries

**Shippable State:** The implementation-approval checkpoint left halted by PR 1 can now actually be unblocked via explicit user approval, and a completed implementation can, optionally and separately, become a pull request via the `gh`-CLI provider. A project may opt into explicitly configured event-triggered starts, which still require full human review and PRD elicitation before anything is created, and a payload that is invalid, incomplete, or declined creates nothing. Every mutating action (implementation, PR write) is denied unless the corresponding approval is persisted in the run record, independent of what any prompt text claims.

- [x] **TRD-012**: Implement project-local event-mapping config (schema, validation, default-deny) (4h) [depends: TRD-005] [satisfies REQ-009]
  - Validates PRD ACs: AC-009-1
  - Target File: `packages/agent-core/src/new-feature/event-mapping.ts`
  - Actions:
    1. Define `EventMappingConfig = { allowedEventTypes: string[]; reviewRequired: true }`, loaded from a project-local file (e.g. `.ensemble/new-feature/event-mapping.json`), absent by default.
    2. `loadEventMapping(projectRoot)` returns `null` when the file is absent — the default-deny state — never a non-empty implicit default.
    3. Event entry path: when `loadEventMapping()` returns `null`, no event starts a run; manual invocation via TRD-005 remains available and untouched.
  - Implementation AC:
    - Given no `event-mapping.json` file exists, when any event is delivered, then no run is started and the manual entry path is unaffected.

- [x] **TRD-012-TEST**: Verify default-deny event entry (2h) [verifies TRD-012] [satisfies REQ-009] [depends: TRD-012]
  - Validates PRD ACs: AC-009-1
  - Target File: `packages/agent-core/tests/new-feature/event-mapping.test.ts`
  - Actions:
    1. With no config file present, deliver a synthetic event; assert no run is created and `loadEventMapping` returns `null`.
  - Test AC:
    - Given no event-mapping config, when an event arrives, then `RunIndexStore.findActive` shows no new run was created by it.

- [x] **TRD-013**: Implement event-triggered human review, PRD elicitation gate, and invalid-payload handling (5h) [depends: TRD-012] [satisfies REQ-009]
  - Validates PRD ACs: AC-009-2, AC-009-3
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. When a project has an explicit `event-mapping.json` and an allowed event type occurs, present the event source and full payload to the user via `ask_user` for review before any PRD-stage work begins.
    2. Require the same PRD elicitation (idea clarification) that manual `create-prd` invocation already requires — an event payload is never treated as a complete PRD input by itself.
    3. On an invalid, incomplete, or user-declined payload: create no PRD, advance no run, and report which validation or review step is pending.
  - Implementation AC:
    - Given an allowed configured event, when delivered, then the event source and payload are shown for human review and PRD elicitation completes before any PRD file is written.
    - Given an invalid/incomplete/declined payload, when handled, then no PRD exists afterward and the reported message names the specific pending step.

- [x] **TRD-013-TEST**: Verify event review gate and invalid-payload rejection (3h) [verifies TRD-013] [satisfies REQ-009] [depends: TRD-013]
  - Validates PRD ACs: AC-009-2, AC-009-3
  - Target File: `packages/agent-core/tests/new-feature/event-mapping.test.ts`
  - Actions:
    1. With a configured allowed event type, simulate delivery and a user decline; assert no PRD file and a correct pending-step report.
    2. Simulate an incomplete payload (missing a required field); assert the same no-PRD, named-pending-step behavior.
  - Test AC:
    - Given an incomplete event payload, when processed, then no PRD is created and the report names the missing validation step.

- [x] **TRD-014**: Implement the implementation-approval checkpoint (5h) [depends: TRD-002, TRD-004] [satisfies REQ-010]
  - Validates PRD ACs: AC-010-1, AC-010-2
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. At `stage: "implementation_approval"`, present the accepted PRD/TRD references and the bead plan via `ask_user`, then wait for an explicit approval response.
    2. On explicit approval, call `RunIndexStore.mutate()` setting `implementationApprovedAt = now()` and advance `stage` to `"implementation"`.
    3. On absent or declined approval, perform no implementation work and leave the run parked at `implementation_approval` for later resume.
  - Implementation AC:
    - Given the checkpoint is reached, when presented, then the exact PRD/TRD refs and bead plan shown match the run record's `artifacts[]`/`beadRefs`.
    - Given approval is declined or not given, when the command exits this turn, then `implementationApprovedAt` remains `null` and `stage` remains `"implementation_approval"`.

- [x] **TRD-014-TEST**: Verify approval persistence and no-work-without-approval (3h) [verifies TRD-014] [satisfies REQ-010] [depends: TRD-014]
  - Validates PRD ACs: AC-010-1, AC-010-2
  - Target File: `packages/agent-core/tests/new-feature/run-index.test.ts`
  - Actions:
    1. Simulate approval; assert `implementationApprovedAt` is set and `stage` advances.
    2. Simulate decline; assert `implementationApprovedAt` stays `null` and no implementation-stage artifact appears.
  - Test AC:
    - Given a declined approval, when the run record is inspected, then `stage` is still `"implementation_approval"`.

- [x] **TRD-015**: Implement material-plan-change re-approval (3h) [depends: TRD-014] [satisfies REQ-010]
  - Validates PRD ACs: AC-010-3
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. After approval, if the presented plan materially changes (a different TRD version, a different bead set) before implementation completes, clear `implementationApprovedAt` via `RunIndexStore.mutate()` and return `stage` to `"implementation_approval"`.
  - Implementation AC:
    - Given an approved plan changes materially before implementation finishes, when detected, then `implementationApprovedAt` is cleared and the run returns to the approval checkpoint rather than proceeding on stale approval.

- [x] **TRD-015-TEST**: Verify material-change detection clears stale approval (2h) [verifies TRD-015] [satisfies REQ-010] [depends: TRD-015]
  - Validates PRD ACs: AC-010-3
  - Target File: `packages/agent-core/tests/new-feature/run-index.test.ts`
  - Actions:
    1. Approve, then simulate a changed bead set; assert `implementationApprovedAt` is cleared and `stage` returns to `implementation_approval`.
  - Test AC:
    - Given a material plan change post-approval, when re-checked, then the run requires a fresh approval before implementation can proceed.

- [x] **TRD-016**: Implement `PrProvider` interface and `GhCliPrProvider` (3h) [depends: TRD-002] [satisfies REQ-011]
  - Validates PRD ACs: AC-011-2, AC-011-3
  - Target File: `packages/agent-core/src/new-feature/pr-provider.ts`
  - Actions:
    1. Define `interface PrProvider { isAvailable(): boolean; createPullRequest(params: { repo: string; branch: string; title: string; body: string }): Promise<{ url: string }> }`.
    2. Implement `GhCliPrProvider`, reusing `fix-issue.yaml`'s existing `gh pr create` invocation shape (same target-repo/branch/title/body construction) rather than a new integration.
    3. `isAvailable()` probes `gh auth status` exit code; a non-zero exit or missing `gh` binary reports unavailable rather than throwing when `createPullRequest` is later called.
  - Implementation AC:
    - Given `gh` is not installed or not authenticated, when `isAvailable()` is called, then it returns `false` and no exception is thrown.
    - Given `gh` is available, when `createPullRequest()` is called, then it constructs the same repo/branch/title/body shape `fix-issue.yaml`'s PR step already uses.

- [x] **TRD-016-TEST**: Verify provider availability probe and PR-creation shape (2h) [verifies TRD-016] [satisfies REQ-011] [depends: TRD-016]
  - Validates PRD ACs: AC-011-2, AC-011-3
  - Target File: `packages/agent-core/tests/new-feature/pr-provider.test.ts`
  - Actions:
    1. Stub `gh auth status` to fail; assert `isAvailable()` returns `false` without throwing.
    2. Stub a successful `gh pr create`; assert the constructed command/args match `fix-issue.yaml`'s existing pattern.
  - Test AC:
    - Given an unauthenticated `gh`, when `isAvailable()` is checked before any create call, then the caller can cleanly skip PR creation.

- [x] **TRD-017**: Implement the PR-creation checkpoint (4h) [depends: TRD-016, TRD-014] [satisfies REQ-011]
  - Validates PRD ACs: AC-011-1, AC-011-2, AC-011-3
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. PR creation is entered only if the user opts in after implementation completes; declining records completion with no `PrProvider` call made at all.
    2. On opt-in with `PrProvider.isAvailable() === true`, present the target repository/branch and proposed title/body via `ask_user`, then require a separate, immediate explicit approval before calling `createPullRequest()`.
    3. On `mutate()`, set `prApprovedAt = now()` only after that separate approval, immediately before the create call — never in the same approval step as implementation.
    4. On absent/declined approval, or `isAvailable() === false`, create no PR, report the outcome, and leave the completed implementation record untouched.
  - Implementation AC:
    - Given the user declines PR creation, when completion is recorded, then no `gh pr create` invocation occurs.
    - Given approval is granted, when the create call is made, then it is preceded by a presentation of the exact target repo/branch/title/body and a separate approval distinct from the implementation approval.
    - Given `isAvailable()` is `false`, when the PR stage is reached, then no PR is created and the implementation completion record is preserved unchanged.

- [x] **TRD-017-TEST**: Verify PR opt-in, separate approval, and unavailable-provider handling (4h) [verifies TRD-017] [satisfies REQ-011] [depends: TRD-017]
  - Validates PRD ACs: AC-011-1, AC-011-2, AC-011-3
  - Target File: `packages/agent-core/tests/new-feature/run-index.test.ts`
  - Actions:
    1. Simulate decline of PR creation; assert `prApprovedAt` stays `null` and no `createPullRequest` call occurs.
    2. Simulate approval; assert the presented repo/branch/title/body match the run's recorded references and `prApprovedAt` is set immediately before the (stubbed) create call.
    3. Simulate `isAvailable() === false`; assert no PR is created and the implementation record is untouched.
  - Test AC:
    - Given `prApprovedAt` is `null` at the time the stage is entered, when the stage runs, then `createPullRequest` is never invoked.

- [x] **TRD-018**: Implement boundary validation for event/artifact/path inputs (3h) [depends: TRD-012, TRD-005] [satisfies REQ-014]
  - Validates PRD ACs: AC-014-1
  - Target File: `packages/agent-core/src/new-feature/event-mapping.ts`
  - Actions:
    1. Every event payload, artifact reference, or user-supplied path crossing the workflow boundary (TRD-005's resume input, TRD-013's event payload) is validated against its schema/allow-list before it changes any `RunIndexStore` state or selects a tool to invoke.
    2. An invalid or disallowed value is rejected at the boundary function itself, before the caller can act on it — not after a partial state change.
  - Implementation AC:
    - Given a malformed event payload or a disallowed artifact path, when it is checked, then rejection happens before any `RunIndexStore.mutate()`/`createRun()` call is made.

- [x] **TRD-018-TEST**: Verify boundary validation precedes state mutation (2h) [verifies TRD-018] [satisfies REQ-014] [depends: TRD-018]
  - Validates PRD ACs: AC-014-1
  - Target File: `packages/agent-core/tests/new-feature/event-mapping.test.ts`
  - Actions:
    1. Feed a malformed payload/path; assert no `RunIndexStore` write occurred as a side effect of the rejected call.
  - Test AC:
    - Given a disallowed input, when validation runs, then no run-state file is created or modified.

- [x] **TRD-019**: Enforce store-persisted-approval precondition at every mutating call site (3h) [depends: TRD-014, TRD-017] [satisfies REQ-014]
  - Validates PRD ACs: AC-014-2
  - Target File: `packages/development/commands/new-feature.yaml`
  - Actions:
    1. The implementation-execution call site reads `RunIndexStore`'s current `implementationApprovedAt` immediately before acting; a `null` value denies the operation regardless of any prompt text claiming approval was given.
    2. The PR-creation call site performs the same check against `prApprovedAt` immediately before calling `PrProvider.createPullRequest()`.
  - Implementation AC:
    - Given prompt text claims implementation was approved but `implementationApprovedAt` is `null` in the store, when the implementation call site checks, then it denies the operation.

- [x] **TRD-019-TEST**: Verify denial on missing store-persisted approval despite prompt claims (3h) [verifies TRD-019] [satisfies REQ-014] [depends: TRD-019]
  - Validates PRD ACs: AC-014-2
  - Target File: `packages/agent-core/tests/new-feature/run-index.test.ts`
  - Actions:
    1. Construct a scenario where the surrounding context text asserts approval but `implementationApprovedAt` is `null`; assert the implementation call site still denies.
    2. Repeat for `prApprovedAt` and PR creation.
  - Test AC:
    - Given `implementationApprovedAt === null`, when the implementation call site is exercised regardless of accompanying prompt text, then the operation is denied.

- [x] **TRD-020**: Represent event-mapping and PR-provider selection as editable project-local config (2h) [depends: TRD-012, TRD-016] [satisfies REQ-014]
  - Validates PRD ACs: AC-014-3
  - Target File: `packages/agent-core/src/new-feature/event-mapping.ts`
  - Actions:
    1. `event-mapping.json`'s `allowedEventTypes` and any future provider selection are read from project-local files, never hardcoded constants requiring a code rebuild to change per project.
  - Implementation AC:
    - Given a project edits `event-mapping.json` to add an allowed event type, when the workflow next runs, then the new behavior takes effect with no code change.

- [x] **TRD-020-TEST**: Verify config-only behavior change (2h) [verifies TRD-020] [satisfies REQ-014] [depends: TRD-020]
  - Validates PRD ACs: AC-014-3
  - Target File: `packages/agent-core/tests/new-feature/event-mapping.test.ts`
  - Actions:
    1. Edit `event-mapping.json` between two test runs with no code change; assert the second run's behavior reflects the edit.
  - Test AC:
    - Given only a config-file edit between two invocations, when compared, then the second invocation's allowed-event behavior differs accordingly.

### PR 4: Product Compatibility and Discoverability

**Shippable State:** `new-feature` is discoverable in the product's command surface alongside `fix-issue` and every other existing command, and every existing standalone command's entry point and behavior remain exactly as they were before this feature shipped.

- [x] **TRD-021**: Wire `new-feature.yaml` into the existing generation pipeline (2h) [depends: TRD-003] [satisfies REQ-013]
  - Validates PRD ACs: AC-013-2
  - Target Files: `packages/development/commands/ensemble/new-feature.md`, `packages/pi/prompts/ensemble-new-feature.md`, `packages/codex/.codex/skills/commands/ensemble-new-feature/SKILL.md`
  - Actions:
    1. Run `npm run generate` (the same pipeline `fix-issue.yaml` already uses) to produce the three runtime-specific generated files, each carrying the standard "DO NOT EDIT — Generated from new-feature.yaml" banner.
    2. Confirm each generated file's frontmatter/metadata registers it as discoverable in its runtime's command list, the same discovery mechanism `fix-issue` already relies on (there is no separate catalog/manifest file in this repo).
  - Implementation AC:
    - Given `npm run generate` runs, when it completes, then all three runtime files exist with correct frontmatter and the generation banner.

- [x] **TRD-021-TEST**: Verify generated command is discoverable in each runtime (1h) [verifies TRD-021] [satisfies REQ-013] [depends: TRD-021]
  - Validates PRD ACs: AC-013-2
  - Target File: `packages/development/tests/new-feature-command.test.js`
  - Actions:
    1. Assert each generated file exists, carries the "DO NOT EDIT" banner, and its frontmatter name/category are present.
  - Test AC:
    - Given the generated files, when a runtime's command list is built, then `new-feature` appears alongside `fix-issue`.

- [x] **TRD-022**: Verify no existing standalone command changed (1h) [depends: TRD-021] [satisfies REQ-013]
  - Validates PRD ACs: AC-013-1
  - Target Files: `packages/development/commands/fix-issue.yaml`, `packages/development/commands/create-prd.yaml`, `packages/development/commands/refine-prd.yaml`, `packages/development/commands/create-trd.yaml`, `packages/development/commands/refine-trd.yaml`
  - Actions:
    1. Diff each of the above files against their pre-feature state; confirm zero changes.
  - Implementation AC:
    - Given the full diff of this feature's changes, when scoped to the files above, then it is empty.

- [x] **TRD-022-TEST**: Run each existing standalone command's own test suite unmodified (1h) [verifies TRD-022] [satisfies REQ-013] [depends: TRD-022]
  - Validates PRD ACs: AC-013-1
  - Target File: `packages/development/tests/fix-issue-command.test.js`
  - Actions:
    1. Run the existing `fix-issue-command.test.js` (and equivalents for create-prd/refine-prd/create-trd/refine-trd, where present) unmodified; confirm all pass.
  - Test AC:
    - Given the existing standalone-command test suites, when run unmodified after this feature lands, then all still pass.

## Sprint Planning

Informational grouping only; `implement-trd-beads` does not parse this section.

### Sprint 1 (PR 1 — ~36h): TRD-001 through TRD-006 and their TEST tasks. Foundation: run index, stage sequence, artifact recording, entry/resume, refine-skip rejection
### Sprint 2 (PR 2 — ~30h): TRD-007 through TRD-011 and their TEST tasks. Continuation, failure/decline handling, single-active-run, status
### Sprint 3 (PR 3 — ~55h): TRD-012 through TRD-020 and their TEST tasks. Event triggers, approval gates, PR-provider seam, mutation-boundary enforcement
### Sprint 4 (PR 4 — ~5h): TRD-021 and TRD-022 and their TEST tasks. Discoverability and compatibility verification

## Acceptance Criteria Traceability

| REQ-NNN | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Start a feature run from an idea or a known run artifact | TRD-005 | TRD-005-TEST |
| REQ-002 | Follow a fixed, inspectable stage sequence | TRD-003 | TRD-003-TEST |
| REQ-003 | Keep both refinement stages mandatory | TRD-006 | TRD-006-TEST |
| REQ-004 | Bind every stage to explicit, traceable artifacts | TRD-004 | TRD-004-TEST |
| REQ-005 | Persist checkpoints and identify the active run from a project-local index | TRD-001, TRD-002 | TRD-002-TEST |
| REQ-006 | Pause failures and resume only at the failed or pending stage | TRD-007, TRD-008 | TRD-007-TEST, TRD-008-TEST |
| REQ-007 | Return declined or edited outputs to the same stage | TRD-009 | TRD-009-TEST |
| REQ-008 | Allow only one active feature run per project | TRD-010 | TRD-010-TEST |
| REQ-009 | Support manual and explicitly configured event-triggered starts | TRD-012, TRD-013 | TRD-012-TEST, TRD-013-TEST |
| REQ-010 | Require explicit user approval before implementation | TRD-014, TRD-015 | TRD-014-TEST, TRD-015-TEST |
| REQ-011 | Make PR creation optional and separately approved | TRD-016, TRD-017 | TRD-016-TEST, TRD-017-TEST |
| REQ-012 | Make run state and outcomes visible to the user | TRD-011 | TRD-011-TEST |
| REQ-013 | Keep `new-feature` additive to existing product commands | TRD-021, TRD-022 | TRD-021-TEST, TRD-022-TEST |
| REQ-014 | Enforce input and mutation boundaries independently of prompt instructions | TRD-018, TRD-019, TRD-020 | TRD-018-TEST, TRD-019-TEST, TRD-020-TEST |

Traceability check: 14 requirements covered, 0 uncovered, 0 orphaned `[satisfies REQ-NNN]` annotations (every annotation above references a REQ-NNN that exists in the PRD).

## Adversarial Review

### Architecture issues

1. **Create-time race on single-active-run enforcement.** `session.js`'s `mutateSession` pattern assumes an existing file with a known `expectedRevision`; it has no answer for "reject a brand-new file's creation if a sibling marker already exists," which REQ-008 requires. **Resolution:** TRD-010 adds a separate `active.lock` marker written with `fs.writeFileSync(path, runId, { flag: "wx" })`, which fails atomically on a pre-existing file — a distinct primitive from `mutate()`'s revision check, not a reuse of it.
2. **PR-provider availability can throw instead of reporting unavailable.** Calling `gh pr create` against an unauthenticated or missing `gh` CLI would throw mid-approval rather than cleanly signaling "no supported PR-creation capability available," which AC-011-3 requires to be a clean no-PR outcome. **Resolution:** TRD-016 requires `isAvailable()` to probe `gh auth status` and return `false` rather than letting `createPullRequest()` be the first point of failure; TRD-017 only calls `createPullRequest()` after `isAvailable()` is true.

### Missing interfaces / error handling checked

- Every stage-to-stage handoff passes through `RunIndexStore.artifacts[]` (a defined data contract), not ad hoc parameters — no undefined interface between components.
- `resolveByArtifact()`'s `undefined` return (not a thrown error) for an unindexed path is the defined protocol TRD-005 relies on to produce AC-001-3's rejection message; documented above under Component Design → Failure paths.

## Design Readiness Gate

### Step 1: Architecture Self-Critique

Completed above (Adversarial Review → Architecture issues); both flagged gaps have task-level resolutions (TRD-010, TRD-016/TRD-017).

### Step 2: Task Coverage Analysis

- Every PRD requirement has at least one corresponding test task (`[satisfies REQ-NNN]` traceability table above, 0 uncovered).
- No `[satisfies REQ-NNN]` annotation references a nonexistent REQ-NNN (all 14 REQ-NNN IDs exist in the PRD and are used).
- No task is estimated at 8h+ (largest individual tasks are 5h — TRD-002, TRD-004, TRD-005, TRD-013, TRD-014 — each already a single, cohesive unit of work; none flagged for further breakdown).
- Every `### PR N:` section has a **Shippable State** line describing user-observable capability, not an infrastructure-only statement (PR 1's line explicitly documents its intentional implementation-approval halt as the observable boundary of that increment, not a "scaffolding complete" placeholder).

### Step 3: Dependency and Estimate Review

- No task has a dependency chain deeper than 4 hops (e.g., TRD-019 ← TRD-017 ← TRD-016/TRD-014 ← TRD-002/TRD-004 ← TRD-001/TRD-003).
- No circular dependencies: PR 1 has no external dependencies; PR 2 depends only on PR 1; PR 3 depends only on PR 1 and PR 2; PR 4 depends only on PR 1.
- Estimate confidence is consistent: store/schema tasks (TRD-001/TRD-002/TRD-010) and approval/boundary tasks (TRD-014/TRD-017/TRD-019) — the highest-complexity work identified during PRD refinement (REQ-004/005/008 High, REQ-009/011/014 High) — carry the largest estimates (3–6h) in this task list; low-complexity PRD requirements (REQ-003/012/013, PRD-rated Low) map to the smallest tasks (1–3h).

### Step 4: Testability Review

- Every Implementation AC and Test AC above is phrased as an objectively verifiable Given/When/Then; none relies on subjective language ("fast", "good", "user-friendly").
- Every test task specifies a concrete assertion target (a store error code, a file's presence/absence, a specific field value), not a vague "verify it works."

### Step 5: Design Readiness Gate — Score

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Architecture completeness | 4.6 | All components, data flows, and integration points defined; the two genuine gaps found (create-time exclusivity, PR-provider availability) have concrete task-level resolutions rather than being left implicit. |
| Task coverage | 5.0 | All 14 REQ-NNN requirements have implementation and test task coverage; 0 uncovered, 0 orphaned annotations. |
| Dependency clarity | 4.6 | Clean 4-PR structure with no cycles; PR 3's 9-task cluster has the deepest chain but is still acyclic and independently reviewable. |
| Estimate confidence | 4.4 | No task exceeds 5h; estimates track PRD-assessed complexity/risk consistently across all 22 implementation tasks. |
| **Overall** | **4.65** | **PASS — ready for implementation** |

## Entry and Exit Criteria

- **Entry:** PRD-2026-d6bbf322 approved at readiness 4.58 (PASS). No foundational TRD exists to reuse from; this is new-build work on an otherwise-unmodified existing product command surface.
- **Exit:** All 43 tasks complete; a user can run `new-feature` end-to-end from an idea through an approved, implemented bead plan with an optional, separately approved PR; every stage transition, approval, and artifact reference is recorded in a `RunIndexStore` run file that survives a simulated crash mid-write; a second concurrent run in the same project is rejected; and every existing standalone command (`create-prd`, `refine-prd`, `create-trd`, `refine-trd`, `fix-issue`) passes its own unmodified test suite.

## Changelog

### 2026-09-30 — v1.0.0

- Initial TRD for the resumable `new-feature` workflow, generated from PRD-2026-d6bbf322.
- Architecture Option C (hardened in-session stage composition + atomic `RunIndexStore`) chosen after user confirmation over Options A (unsafe plain-write checkpoint) and B (subprocess dispatch, doesn't fit `--collab` review stages).
- 22 implementation tasks + 21 paired test tasks across 4 PRs, full REQ-NNN → TRD-NNN traceability (14/14 covered).
- Design Readiness Gate: 4.65 (PASS).
