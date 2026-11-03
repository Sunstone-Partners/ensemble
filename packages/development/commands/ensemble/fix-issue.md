---
name: "ensemble:fix-issue"
description: "Lightweight workflow for bug fixes and small issues"
version: "1.5.0"
category: "implementation"
last-updated: "2026-10-23"
capabilities-required: "host.change-request-create, host.change-request-view, host.change-request-list, workflow.branch-create, workflow.merge-base, workflow.commit, workflow.push"
model: "sonnet"
---
<!-- DO NOT EDIT - Generated from fix-issue.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Orchestrate a bug fix workflow from analysis to PR, delegating to specialized agents.
Resumable and checkpointed: a run's stage and outcome are recorded via issue-run-index.ts after each of the 3 named phases, so a later invocation can resume, report status, or abandon it.

## Arguments

- **`description`** (string, optional): Issue description (free text or omit if using --issue)
- **`issue`** (number, optional): GitHub issue number (e.g., --issue 34)
- **`branch`** (string, optional): Custom branch name (default auto-generated)
- **`skip-tests`** (boolean, optional, default: `false`): Skip test validation (not recommended)
- **`draft-pr`** (boolean, optional, default: `false`): Create draft PR instead of ready-for-review
- **`interactive`** (boolean, optional, default: `false`): Enable detailed user interviews during planning
- **`foreman`** (boolean, optional, default: `false`): Foreman-native non-interactive mode -- skip the user interview and always auto-commit + create the PR without pausing for confirmation. When --foreman is present and FOREMAN_ARTIFACT_PATH is set and non-empty, write the phase report to that exact path (creating parent directories) in addition to any repo-local report. Never invent or alter the path; an unset FOREMAN_ARTIFACT_PATH is not an error.
- **`status`** (boolean, optional, default: `false`): Show the active/most-recent issue run's stage, outcome, and references without advancing it.
- **`abandon`** (boolean, optional, default: `false`): Abandon the project's active/paused issue run after explicit confirmation.

## Workflow

### Phase 1: Entry Point Resolution

**1. Start New Run or Resume Active Run**
   `description` or `issue` given: call IssueRunIndexStore.createRun(projectRoot, issueDescription) (`description`, else the issue body read from the project's issue host). One active run per project: on RUN_ALREADY_ACTIVE print the existing runId, tell the user to resume with no arguments (or --status, or --abandon first), and stop. Otherwise the run starts at stage analysis_planning; proceed to Analysis & Planning.

None of description/issue/--status/--abandon given: call IssueRunIndexStore.findActive(projectRoot) and resume from the recorded checkpoint, never from conversation history. Exactly one branch applies, tested in this order:
- No active run: print "No issue run found for this project. Start one with --issue <number> or a free-text description." and stop.
- stageOutcome.kind is "failure" (paused by failure): print the parked stage and failure detail and ask "Retry <stage>? [yes/no]". Only an explicit yes re-executes that stage; no or no answer stops with stage, stageOutcome and revision unchanged. Never retry automatically.
- stage is "validation_delivery", stageOutcome.kind is "approval_wait" and its detail starts with "REVIEW_": a pending or blocked remote review. Call IssueRunIndexStore.loadRun(projectRoot, runId) and jump straight to Remote Review Disposition; never re-run Test Validation, Local Review and Batch Fix, or PR Creation (a second PR must never open for the same branch). That step reads the PR URL from the run's recorded `pr:` beadRef; with none recorded it halts and tells the user to find or supply the PR URL instead of restarting.
- anything else (success, pending, or a never-run fresh run): no gate; loadRun and resume at the recorded `stage`, from that stage's first step.


**2. --status -- Read-Only Run Report**
   Only when --status is set. Call IssueRunIndexStore.findActive(projectRoot); with no run print "No issue runs found for this project." and stop. Otherwise print the run identifier, stage, stageOutcome.kind (with detail when pending or failure), every artifacts[] and beadRefs[] entry, and "completed" or "abandoned" explicitly. No stage executes and no mutate() call is made.


**3. --abandon -- Explicit Confirmation Required**
   Only when --abandon is set. Call IssueRunIndexStore.findActive(projectRoot); with no active run print "No active issue run exists to abandon." and stop. Otherwise ask via AskUserQuestion "Abandon issue run <runId> at stage <stage>? [yes/no]"; no or no answer leaves the run unchanged with no mutate() call. On an explicit yes call IssueRunIndexStore.abandon(projectRoot, runId, reason) (reason defaults to "User abandoned run"); it sets status "abandoned" and releases active.lock. History is never deleted.


### Phase 2: Analysis & Planning

**1. Codebase Analysis**
   Identify affected files, related tests, framework, and scope (Grep, Glob, Read), optionally via tech-lead-orchestrator. Return a structured analysis with a scope estimate.

**2. Collaborative Planning**
   Produce the fix plan (approach, files to modify, test strategy, edge cases), consulting only the specialists the issue warrants -- product-management-orchestrator for unclear acceptance criteria, tech-lead-orchestrator or infrastructure-orchestrator for architecture or integration impact, test-runner for test strategy.

**3. User Interview (Conditional)**
   Only when the description is ambiguous (under 20 words, vague terms such as "doesn't work", or several interpretations) or --interactive is set. Ask clarifying questions ONE AT A TIME (max 5) with AskUserQuestion and fold the answers into the approach. Never when --foreman is set: proceed on best-effort assumptions.


**4. Record Stage Checkpoint**
   Persist this phase's outcome and advance the run via issue-run-index.ts: ONE call IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { record.artifacts.push({ type: "fix-plan", path: <fix plan output path>, recordedAt: now() }); record.stage = "execution"; record.stageOutcome = { kind: "success", recordedAt: now() }; }). A second mutate() with the same `revision` throws REVISION_CONFLICT, so batch. On a thrown error halt; never proceed unrecorded.


### Phase 3: Execution

**1. Branch Creation**
   Resolve TOOLCHAIN_CLI (RELATIVE_PATH packages/development/lib/toolchain-cli.js) via tool-path-resolution; node "$TOOLCHAIN_CLI" preflight --require host.change-request-create --require host.change-request-view --require host.change-request-list --require workflow.branch-create --require workflow.merge-base --require workflow.commit --require workflow.push --json [add --non-interactive when --foreman]; ok:false -> print it and HALT; RUN_ID = runId; every later toolchain-cli call passes --run-id "$RUN_ID" --json [add --non-interactive when --foreman].
Branch name is --branch if given, else fix/issue-{number}-{slugified-description} for --issue, else fix/{slugified-description}. If it already exists, ask the user to switch or pick another name; otherwise node "$TOOLCHAIN_CLI" run workflow.branch-create --arg name=<branch>.

**2. Task List Generation**
   Break the plan into 3-10 specific, testable tasks (implementation, test updates, validation), each tied to a file or component, tracked with TodoWrite.

**3. Task Execution**
   For each task set TodoWrite status "in_progress", delegate via Task (backend to backend-developer, frontend to frontend-developer, infrastructure to infrastructure-developer, else tech-lead-orchestrator), then set "completed". On failure leave it "in_progress", log the error, continue, and report failures at the end.

**4. Record Stage Checkpoint**
   Persist this phase's outcome and advance the run via issue-run-index.ts: IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { record.stage = "validation_delivery"; record.stageOutcome = { kind: "success", recordedAt: now() }; }). On a thrown error halt; never proceed unrecorded.


### Phase 4: Validation & Delivery

**1. Test Validation**
   Run the test suite with auto-fix retry; all tests must pass before the PR. Detect the framework and test command (package.json, pytest, ...), run, and parse pass/fail. On failure analyze, fix, and run once more (at most 2 attempts). If still failing: report the failures, call IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { record.stageOutcome = { kind: "failure", detail: <failure summary>, recordedAt: now() }; }) to park the run at the CURRENT stage (validation_delivery; do not advance `stage`, so a later bare invocation asks "Retry <stage>?"), HALT without creating a PR, and give recovery instructions. With --skip-tests warn and skip execution. When tests pass (or --skip-tests) proceed to Local Review and Batch Fix; only that step sets prApprovedAt.


**2. Local Review and Batch Fix**
   Independent local review of the complete diff, triage, and one batched fix pass -- before any commit, push, or PR creation. Invoke the shared pr-review-cycle skill, located at
packages/development/skills/pr-review-cycle/SKILL.md (via tool-path-resolution),
in pre-publication (local) mode; it composes pr-review-remediation for the fixes, so do not restate its triage/test/minimal-fix rules here.

Scope: DEFAULT_BRANCH is the remote's default branch minus "origin/", else "main"; BASE_SHA is the `sha` of `node "$TOOLCHAIN_CLI" run workflow.merge-base --arg refA=HEAD --arg refB=<DEFAULT_BRANCH>`. The reviewed head, SNAPSHOT_HEAD, is a snapshot commit of the working tree including untracked files, never a stash: build its tree in a TEMPORARY index (GIT_INDEX_FILE at a not-yet-existing path; real index, working tree and branches untouched). Tree equals HEAD's tree -> SNAPSHOT_HEAD is HEAD; else a synthetic commit of it with HEAD as sole parent, fixed author/committer ensemble <ensemble@localhost> and dates 2000-01-01T00:00:00Z (deterministic SHA). Never pushed.

Invoke the skill with MODE='local', BASE_SHA, HEAD_SHA=<SNAPSHOT_HEAD>, REVIEWED_TREE_SHA=<the tree SHA of SNAPSHOT_HEAD>, PR_ID=<repo-slug>-<branch-name> (no PR number exists yet), TEST_COMMAND=<command Test Validation detected>, SKIP_TESTS=<true under --skip-tests>, FOREMAN=<--foreman flag>. The batch fix changes the working tree, so re-resolve SNAPSHOT_HEAD after it and BEFORE the re-review (never plain HEAD, which cannot see uncommitted work). Tell the skill the post-fix SNAPSHOT_HEAD ends the re-review range and is headSha and reviewedHeadSha, its tree is REVIEWED_TREE_SHA (recorded as reviewedTreeSha so Remote Review Disposition can recognise PR Creation's real commit -- different SHA, same content -- by tree), and a review bound to the pre-fix snapshot or tree is stale and cannot complete. --skip-tests never skips this step: the skill records tests.skipped=true and never reports REVIEW_COMPLETE (REVIEW_PENDING, "tests skipped"), yet LOCAL_REVIEW_COMPLETE can still be reached.

Fail-closed gate on the skill's {status, localPhase, reasons, ledger, reportPath, headSha}; LOCAL_PHASE is null when nothing, an unparseable value, or no localPhase came back. Only LOCAL_PHASE == 'LOCAL_REVIEW_COMPLETE' (exact match) proceeds: call IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { record.prApprovedAt = now(); }) -- the only place prApprovedAt is set -- then go to PR Creation. EVERY other outcome (LOCAL_REVIEW_PENDING, LOCAL_REVIEW_BLOCKED, null, unrecognised) leaves prApprovedAt null and calls mutate to set record.stageOutcome = { kind: "failure", detail: `local review not complete (${LOCAL_PHASE ?? 'no localPhase returned'}): ${(reasons ?? []).join('; ')}`, recordedAt: now() } (stage stays validation_delivery). Then, under --foreman with FOREMAN_ARTIFACT_PATH set and non-empty, write { status, headSha, ledger } to that exact path (create parent directories; no prompt or wait; unset path: no-op) BEFORE halting: status is the skill's status when REVIEW_PENDING or REVIEW_BLOCKED, else REVIEW_BLOCKED; headSha is the returned one or the last SNAPSHOT_HEAD; ledger is the returned one or null. Finally HALT with nothing committed, pushed, or published, reporting the ledger, reportPath and next action.

**3. PR Creation**
   Commit, push, and open the change request via host/workflow toolchain adapters. Precondition: prApprovedAt (IssueRunIndexStore.loadRun(projectRoot, runId)) must be non-null, set only by Local Review and Batch Fix. Proceeds without pauses under --foreman.
TOOLCHAIN_CLI and RUN_ID come from Branch Creation's preflight (a resume runs it first).
Stage explicit paths only. First workflow write: confirm-status workflow.commit (if unconfirmed, AskUserQuestion "Allow commit/push this session? [yes/no]" (auto-confirmed under --foreman), then confirm-record workflow.commit). Run node "$TOOLCHAIN_CLI" run workflow.commit --arg message="fix: {description}", then node "$TOOLCHAIN_CLI" run workflow.push --arg branch="{branch-name}".
REQ-002 body PR_BODY: Problem/Solution/Changes/Testing/Risk/How to revert/Checklist, `Fixes #{issue-number}` and a `Directed by: @<login of whoever asked for this fix, never the agent>` line; template: the pr-review-cycle skill's `reference/fix-issue-pr-body.md`.
Body gate (REQ-002): hand PR_BODY to the pr-review-cycle skill (packages/development/skills/pr-review-cycle/SKILL.md (via tool-path-resolution)) with AGENT_AUTHORED=true and the BASE_SHA / HEAD_SHA / PR_ID Local Review and Batch Fix used; fill every section it reports missing, never create the PR on a body it reports not ready, never call the review CLI or its lib modules. Title "Fix #{number}: {description}" or "Fix: {description}". Same gate for host.change-request-create. Run node "$TOOLCHAIN_CLI" run host.change-request-create --arg baseBranch=<DEFAULT_BRANCH> --arg headBranch="{branch-name}" --arg title="<title>" --arg description="<body>"; URL = data.url. --draft-pr has no capability input (note in body). No URL -> say so; Remote Review Disposition owns that block.


**4. Remote Review Disposition**
   After the PR exists, evaluate the head-bound CodeRabbit review and decide whether the run may report success.

PR_URL is the URL PR Creation extracted, or on resume the last `pr:` beadRefs[] entry with the prefix stripped; only a value matching ^https?://\S+/pull/[0-9]+$ counts, anything else (empty, undefined, no entry) is "no PR URL". Never proceed with an undefined URL, write `pr:undefined`, or re-run PR Creation.

No PR URL: skip the skill; REVIEW_STATUS is REVIEW_BLOCKED with next action "no PR URL recorded -- find it (node $TOOLCHAIN_CLI run host.change-request-view --arg id=<branch>, else node $TOOLCHAIN_CLI run host.change-request-list, headBranch=<branch>) or create it via host.change-request-create, record its URL as a pr:<url> beadRef, then re-invoke with no arguments (or --abandon)"; take the non-complete path below (detail "REVIEW_BLOCKED: no PR URL recorded"). Never restart at Test Validation.

With a PR URL: first record it once, whatever the outcome, so a later resume finds the PR: IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { if (!record.beadRefs.includes(`pr:${prUrl}`)) record.beadRefs.push(`pr:${prUrl}`); }). Then invoke the shared pr-review-cycle skill, located at
packages/development/skills/pr-review-cycle/SKILL.md (via tool-path-resolution),
with MODE='remote', PR_ID=<the SAME repo-slug>-<branch-name> key Local Review used (never a PR number, so recorded local-phase facts carry forward), PR_URL, HEAD_SHA=<HEAD SHA>, HEAD_TREE_SHA=<HEAD tree SHA>, BOT_LOGINS=<configured review-bot usernames>, FOREMAN=<--foreman flag>. Pass no reviewed head or tree; the skill recovers them from the local report. PR Creation's real commit is not the snapshot Local Review bound to, so the review is fresh only when HEAD_SHA equals the recorded reviewedHeadSha or HEAD_TREE_SHA equals the recorded reviewedTreeSha; a different tree is stale (REVIEW_PENDING), never complete. Parse {status, localPhase, remotePhase, reasons, ledger, nextAction, reportPath, headSha} into REVIEW_STATUS, REVIEW_NEXT_ACTION, REVIEW_REPORT_PATH.

Foreman artifact, for EVERY status and BEFORE any halt: under --foreman with FOREMAN_ARTIFACT_PATH set and non-empty, write { status: REVIEW_STATUS, headSha, ledger } to that exact path (create parent directories; no prompt or indefinite wait) ; headSha is the returned one or else the HEAD SHA, ledger the returned one or null, and a missing, null or unrecognised status is written as REVIEW_BLOCKED. Unset path: no-op.

Only exactly REVIEW_COMPLETE proceeds to Record Stage Checkpoint (which alone marks the run done; do not touch stageOutcome here). EVERY other outcome (REVIEW_PENDING, REVIEW_BLOCKED, null, empty, lowercase, unrecognised, unparseable) is a block, never a pass: never call IssueRunIndexStore.complete() or call the PR merged or landed. HALT_STATUS is REVIEW_STATUS when exactly REVIEW_PENDING or REVIEW_BLOCKED, else REVIEW_BLOCKED. Call IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { record.stageOutcome = { kind: "approval_wait", detail: `${HALT_STATUS}: ${REVIEW_NEXT_ACTION ?? 'review returned no recognised status'}`, recordedAt: now() }; }) -- `stage` stays "validation_delivery" and the detail starts with "REVIEW_" so a later bare invocation resumes here, not at "done" -- print the resumable report (status, next action, REVIEW_REPORT_PATH) and HALT.

**5. Record Stage Checkpoint**
   Persist this phase's outcome via issue-run-index.ts. Only reached when Remote Review Disposition's status is REVIEW_COMPLETE; a pending or blocked outcome halts there. Call IssueRunIndexStore.complete(projectRoot, runId) to mark the run completed and release active.lock. On a thrown error halt and report it.


## Expected Output

**Format:** Pull Request

**Structure:**
- **Git Branch**: fix/issue-{num}-{slug} branch
- **Code Changes**: Fix with test coverage
- **Pull Request**: PR with problem, solution, changes, and test plan

## Usage

```
/ensemble:fix-issue
```
