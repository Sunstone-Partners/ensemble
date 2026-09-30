---
name: "ensemble:new-feature"
description: "Resumable, checkpointed workflow from an idea through PRD, TRD, bead planning, and approved implementation, with an optional PR."
version: "1.0.0"
category: "implementation"
last-updated: "2026-09-30"
model: "sonnet"
---
<!-- DO NOT EDIT - Generated from new-feature.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Chain the existing standalone create-prd, refine-prd, create-trd,
refine-trd, and beads-planning skills into one fixed-order, resumable
run -- the same in-session execution mechanism every other product
command in this repo already uses (see fix-issue.yaml), not a new
subprocess-orchestration layer. What's new is RunIndexStore: an atomic,
concurrency-safe checkpoint of which stage a run is at, its outcome, and
the exact artifact references each stage produced, so the workflow is
resumable across sessions and never guesses which stage to run next from
file-presence alone.

## Workflow

### Phase 1: Entry Point Resolution

**1. Reject Unsupported Flags Before Any Stage Runs**
   --skip-refine and equivalents are rejected in option validation, before createRun/resolveByArtifact are ever called.

**2. Idea Input -- Start a New Run**
   An `idea` argument with no active run for the project starts a fresh run at prd_create.

**3. Artifact-Path Input -- Resume an Indexed Run**
   A `path` argument resumes the exact run that indexed it, or is rejected if unindexed.

**4. No Arguments -- Resume Active or Show Status**
   Neither idea nor path resumes the project's active/paused run, or (with --status) reports it read-only -- a run parked by failure is shown, never auto-re-executed, until the user explicitly confirms (AC-006-3).

**5. Event-Triggered Entry (Opt-In)**
   A project may opt into event-triggered starts via .ensemble/new-feature/event-mapping.json (TRD-012); absent that file, this path never fires and the manual idea/path/status entry above is entirely unaffected. This step only applies when the invocation originates from a configured event delivery, not from interactive arguments.

### Phase 2: Stage Resolution

**1. Load Current Checkpoint**
   Read the run's current stage and stageOutcome from RunIndexStore before deciding anything else.

**2. Dispatch to the Eligible Stage**
   Route execution to exactly the one stage ELIGIBLE_STAGE names.

### Phase 3: Execute Stage

**1. Load and Execute the Stage's Existing Skill Body**
   Each of the five stages below wraps an existing, unmodified standalone skill.

**2. Record the Stage Outcome**
   Checkpoint success, decline, or failure through RunIndexStore immediately after the stage body returns.

**3. Handle Stage Failure**
   An exception or reported failure from Step 1 pauses the run at the failed stage; it is never auto-retried within the same invocation.

**4. Explicit-Retry-Only Resume of a Failed Stage**
   Only Entry Point Resolution step 4's explicit 'yes' confirmation reaches this phase for a failed run -- never an ambient auto-retry, never the completed stages before it.

**5. Implementation Approval Checkpoint**
   The implementation_approval stage is a bespoke human checkpoint, not one of the five document-producing stages Step 1 dispatches to -- nothing past this point runs without a recorded approval timestamp.

**6. PR Approval Checkpoint**
   PR creation is optional, entered only after the user opts in following implementation completion, and requires an approval distinct from implementation_approval's.

**7. Execute Stage: PR Creation**
   Only reached when prApprovedAt is already set by the PR Approval Checkpoint above.

## Usage

```
/ensemble:new-feature
```
