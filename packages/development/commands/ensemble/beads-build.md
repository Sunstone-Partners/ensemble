---
name: "ensemble:beads-build"
description: "Drive an existing bead hierarchy to completion through the full builder, code-review, and close pipeline"
version: "1.1.0"
category: "implementation"
last-updated: "2026-06-05"
allowed-tools: "Read, Write, Edit, Bash, Grep, Glob, Task"
argument-hint: "[epic-id|slug-pattern] [--trd trd-path] [--strategy tdd|characterization|bug-fix|refactor|test-after|flexible] [max parallel N]"
model: "sonnet"
---
<!-- DO NOT EDIT - Generated from beads-build.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Drive an existing bead hierarchy (epic -> stories -> tasks) to completion through
the full builder -> code-review -> close pipeline. This is the canonical build
engine — works for raw beads with no TRD required. implement-trd-beads --execute
is effectively a TRD-augmented version of this command.

Uses bv --robot-plan as the ONLY scheduler. Each wave partitions the ready set
into parallel tracks (up to --max-parallel; default 3) and dispatches each track
concurrently to a tech-lead-orchestrator Bead-Track subagent. A barrier sits
between waves: every track must complete before the next bv call. Records all
state transitions in beads for cross-session resumability. When --trd is
provided, enables TRD augmentations: traceability tokens, TRD checkbox sync,
and requirement satisfaction report.

Key behaviors:
- bv --robot-plan is the only scheduler; no br ready fallback. Each wave is
  a barrier: dispatch all tracks, wait for every track, then re-plan.
- Quality gates: phase completion triggers test delegation; results recorded as br comments
- Sync: br sync --flush-only before every bv call
- Hard requirement: bv is required for orchestration. There is no graceful-degradation path — if bv is missing, install it before invocation. br ready is never a fallback dispatcher; bv --robot-plan is the only scheduler.
- TRD mode: optional --trd flag enables traceability tokens, checkbox sync, requirement report

## Workflow

### Phase 1: Preflight

**1. Argument Parsing**
   Parse epic-id or slug pattern, --trd path, --strategy, and max parallel N

   - Parse $ARGUMENTS: if first token matches pattern beads-NNN or a numeric ID, treat as direct epic bead ID (EPIC_ID_MODE=true); otherwise treat as slug pattern (EPIC_ID_MODE=false)
   - Parse --trd <path> from $ARGUMENTS (optional); if present set TRD_MODE=true and TRD_PATH=<path>; if absent set TRD_MODE=false
   - Parse --strategy <value> from $ARGUMENTS (optional); valid values: tdd, characterization, bug-fix, refactor, test-after, flexible
   - Parse "max parallel N" from $ARGUMENTS (e.g., "max parallel 3") — default MAX_PARALLEL=1 if not present

**2. Tool Availability Check**
   Verify br is installed and detect bv availability

   - "which br || { echo 'ERROR: br (beads_rust) not installed. Install from https://github.com/Dicklesworthstone/beads_rust'; exit 1; }"
   - "br list --status=open > /dev/null 2>&1 || { echo 'ERROR: br not functional'; exit 1; }"
   - "which bv && BV_AVAILABLE=true || { echo 'WARNING: bv (beads_viewer) not installed. Graph-aware triage will be unavailable. Install from https://github.com/Dicklesworthstone/beads_viewer'; BV_AVAILABLE=false; }"

**3. Git-Town and Working Directory Verification**
   Verify git-town is installed and the working directory is clean

   - Run: bash packages/git/skills/git-town/scripts/validate-git-town.sh — handle exit codes 0 (ok), 1 (not installed), 2 (not configured), 3 (version mismatch), 4 (not git repo)
   - Run: git status --porcelain — HALT if output non-empty (dirty working directory)

**4. Epic Discovery**
   Locate the root epic bead using the provided ID or slug pattern, detect cross-session resume

   - If EPIC_ID_MODE=true: run br show <RAW_INPUT> to confirm epic exists; if exit code != 0 print "ERROR: Bead <RAW_INPUT> not found." and HALT; store ROOT_EPIC_ID=RAW_INPUT; derive EPIC_SLUG from bead title
   - If EPIC_ID_MODE=false: run br list --status=open --json; parse JSON array; scan .title fields for entries containing RAW_INPUT as substring (case-insensitive); collect matches
   - If zero matches found: print "ERROR: No open epic found matching slug pattern '<RAW_INPUT>'." and HALT
   - If multiple matches found: print "ERROR: Multiple epics match '<RAW_INPUT>':" followed by each matching title; HALT
   - If exactly one match: store ROOT_EPIC_ID from .id field; derive EPIC_SLUG (lowercase, replace non-alphanumeric with hyphens, strip leading/trailing hyphens)
   - Check for existing in-progress tasks: run br list --status=in_progress --json; filter by EPIC_SLUG prefix; count IN_PROGRESS_COUNT
   - If IN_PROGRESS_COUNT > 0: print "Resume detected: <IN_PROGRESS_COUNT> tasks already in_progress. Resuming from current state." and print bead IDs with their titles

**5. TRD Augmentation Setup**
   Validate TRD file and build traceability map when TRD_MODE is enabled

   - If TRD_MODE=false: set TASK_TRACEABILITY={} (empty); skip remaining steps in this phase step; print "TRD augmentations: disabled (no --trd flag)"
   - If TRD_MODE=true: verify TRD_PATH file exists on disk; if not found print "ERROR: TRD file not found at <TRD_PATH>" and HALT
   - Read TRD file; parse YAML frontmatter block (between --- delimiters) for design_readiness_score field
   - If score >= 4.0 (PASS): print "Design Readiness: PASS (<score>)" and continue
   - If score >= 3.0 AND < 4.0 (CONCERNS): print "WARNING: TRD has Design Readiness score of <score> (CONCERNS). Consider running /ensemble:refine-trd before implementation."
   - If score < 3.0 (FAIL): print "ERROR: TRD has Design Readiness score of <score> (FAIL). Run /ensemble:refine-trd to improve the TRD before implementation." and HALT
   - If no design_readiness_score found: print "NOTE: No Design Readiness score found (pre-v3.0.0 TRD). Consider running /ensemble:refine-trd." and continue
   - Build TASK_TRACEABILITY map: scan TRD for [satisfies REQ-NNN], [satisfies INFRA], [satisfies ARCH], [verifies TRD-NNN], "Validates PRD ACs:" fields, "Implementation AC:" blocks, "Proof of requirement:" fields per task; store in map keyed by task.id
   - Classify task type: if task.id ends in -TEST suffix, mark is_test_task=true; extract verifies_task_id and satisfies_req_id; store in TASK_TRACEABILITY[task.id]
   - Print "TRD augmentations: enabled (traceability, checkbox sync, requirement report)"

**6. TRD Staleness Gate**
   When TRD_MODE=true and first invocation, check TRD freshness before execution begins.
Skip when TRD_MODE=false or when resuming an existing epic.
Algorithm defined in packages/development/skills/staleness-gate/SKILL.md.


   - If TRD_MODE=false: skip this step entirely. Print "Staleness check: skipped (no --trd flag)" and continue to step 7.
   - If TRD_MODE=true AND ROOT_EPIC_ID was found in Preflight step 4 (Epic Discovery) — IS_RESUME=true: skip this step. Print "Staleness check: skipped (resume detected)" and continue to step 7.
   - If TRD_MODE=true AND no ROOT_EPIC_ID found in step 4 (first invocation): execute the TRD Staleness Gate per packages/development/skills/staleness-gate/SKILL.md using TRD_PATH from Preflight step 1 and IS_RESUME=false.
   - On HALT from skill: do not proceed. Implementation stops.
   - On RETURN from skill: continue to step 7 (Strategy Detection).

**7. Strategy Detection**
   Determine implementation strategy from arguments, TRD content, or auto-detection

   - Priority: --strategy arg -> TRD explicit (if TRD_MODE) -> auto-detect from bead titles/descriptions -> default (tdd)
   - Auto-detect: legacy/brownfield/untested -> characterization; bug fix/regression -> bug-fix; refactor/tech debt -> refactor; prototype/spike/POC -> test-after; default -> tdd
   - Store STRATEGY; print "Strategy: <STRATEGY>"

### Phase 2: Execute

**1. Track Orchestrator (bv --robot-plan scheduler + track dispatch)**
   Use bv --robot-plan as the ONLY scheduler. Each scheduling wave partitions the
TRD/epic-scoped ready set into parallel tracks (up to MAX_PARALLEL) and dispatches
each track concurrently to a tech-lead-orchestrator Bead-Track subagent. A barrier
sits between waves: every track must complete before the next bv --robot-plan call.
The orchestrator inside the track runs beads sequentially; it does NOT re-plan or
re-partition (the parent has already done that).


   - Run: br sync --flush-only (ensure JSONL is current before any bv call).
   - TASK_TRACEABILITY rebuild guard: if TRD_MODE=true AND TASK_TRACEABILITY is empty (cross-session resume), re-parse the TRD to rebuild TASK_TRACEABILITY (re-run Preflight step 5 passes for [satisfies], [verifies], validation ACs, and test task classification). Print: "NOTE: TASK_TRACEABILITY rebuilt from TRD (cross-session resume). Tasks: <N>".
   - If TRD_MODE=false: TASK_TRACEABILITY remains empty. Print: "NOTE: TRD augmentations disabled — traceability tokens will not be written."
   - WAVE LOOP — repeat until the scoped graph is complete or blocked:
   - Step 1 (each wave): run br sync --flush-only, then run bv --robot-plan --format toon. Treat a non-zero exit OR malformed JSON as a HARD FAILURE: print "ERROR: bv --robot-plan failed" with captured diagnostics and HALT. There is no br ready fallback — bv is the only scheduler.
   - Step 2 (parse and partition): parse the bv --robot-plan JSON. For each track in the response (up to MAX_PARALLEL tracks), collect the ordered list of bead IDs into TRACK_BEADS. Validate that no bead ID appears in more than one track — HALT with a clear error on duplicates. Then perform cross-track file-conflict detection: for each file path implied by the bead ids in TRACK_BEADS, if any file path appears in two or more tracks, HALT with a clear error (re-plan with bv --robot-plan will be required once the conflict is resolved).
   - Step 3 (build immutable track payload per plan step 6 schema):
   -   goal: <free-text from parent invocation>
   -   scope: { ROOT_EPIC_ID: <id>, EPIC_SLUG: <slug>, TRD_PATH: <path or null>, STRATEGY: <strategy> }
   -   track_beads: <ordered string[] of bead IDs for this track only>
   -   lifecycle_contract: literal br command sequence — claim via "br update <BEAD_ID> --status=in_progress", close via "br close <BEAD_ID>" after subagent success, sync via "br sync --flush-only" between operations
   -   quality_loop: pointer to packages/development/agents/tech-lead-orchestrator.* Quality Loop Execution expertise (lines 99-104 of the YAML source) — the orchestrator follows claim, implement, run tests, delegate to code-reviewer, parse verdict (APPROVED/REJECTED). On REJECTED with fixable issues, delegate back to original specialist with feedback (max 2 review rounds). Skip review only if strategy == "flexible" or task type is docs/documentation-only.
   - The payload is constructed once by the parent and never mutated. The orchestrator inside the track runs beads sequentially; it does NOT re-call bv --robot-plan or re-partition.
   - Step 4 (concurrent dispatch): for each track in the wave, launch Task(subagent_type="tech-lead-orchestrator", prompt=<track_payload>) WITHOUT waiting on any one. Start every track in the wave before waiting on any one.
   - Step 5 (barrier): wait for every track invocation in the wave to settle. Sibling-track failures are isolated — one failed track does not cancel successful sibling tracks. The next wave starts from the surviving bead graph.
   - Step 6 (reconcile and re-plan): run br sync --flush-only. Then call bv --robot-plan again so newly unblocked work forms the next wave. Never reuse a stale plan across waves.
   - Step 7 (empty-plan edge): a wave with zero actionable tracks must distinguish terminal states:
   -   - Complete: no open scoped beads remain (verify with br list --status=open filtered by EPIC_SLUG). Break the LOOP and proceed to Quality Gate.
   -   - Blocked: open scoped beads exist but bv returned no actionable tracks (unmet dependencies). Run bv --robot-insights for graph details and HALT with an explicit "blocked" status. Never loop on an empty plan.
   - Step 8 (context budget monitoring, informational only): after every 5 waves, print: "Context checkpoint: <N> waves completed this session. If quality is degrading, consider: (1) /compact to compress conversation context, (2) start a new session with /ensemble:beads-build <ROOT_EPIC_ID> (beads preserve all state)." Do not halt or pause execution based on this signal.
   - After the WAVE LOOP exits: run br sync --flush-only. Print: "=== Execution completed: <WAVE_COUNT> waves processed ===". Continue to Quality Gate.

**2. Debug Loop (TRD-019)**
   Attempt automated fix on track failure via deep-debugger (max 2 retries). Sibling-track failures are isolated; only this track's beads are re-attempted.

   - When a track fails with an actual error (crash/exception) and beads in that track remain unclosed:
   -   1. Delegate to @deep-debugger with error details, changed files, strategy, bead IDs in the failing track
   -   2. If fix applied: re-launch the track with the same payload (the fix propagates via the surviving bead graph); continue to next wave
   -   3. After 2 retries: br comment add <each_unclosed_bead> "Debug loop exhausted after 2 retries. Root cause: <error_analysis>. Attempted fixes: <fix_attempts>. Manual intervention required."; br sync --flush-only; PAUSE for user decision

**3. Error Handling**
   Handle br command failures during execution

   - After any br command: if exit code != 0 AND prior br commands in session succeeded -> possible br failure
   - Print error message with br command that failed and its exit code
   - Print: check br status and .beads/ directory integrity
   - PAUSE for user decision (resume with /ensemble:beads-build <ROOT_EPIC_ID> after issue resolved)

### Phase 3: Quality Gate

**1. Phase Completion Detection**
   Detect when all tasks in a phase are closed

   - After each task completion: determine CURRENT_PHASE_N = the lowest-numbered phase/story with open tasks. Task beads carry NO phase prefix in their title — phase membership comes from the dependency children of the phase story bead (the task beads it blocks). Reconstruct the per-phase task id set from each STORY_BEAD_ID dependency children if not already tracked.
   - Phase N is complete when every task bead that is a dependency child of STORY_BEAD_IDs[N] has status==closed. Do NOT filter by a phase:<N> title prefix — task beads have no such segment.
   - If all tasks for phase N are closed: trigger the quality gate for STORY_BEAD_IDs[N].

**2. Test Execution**
   Delegate test suite execution to test-runner for the modified phase files

   - When a phase completes (Quality Gate step 1 triggers): delegate to @test-runner with: run full test suite (unit + integration) for files modified in this phase; report pass/fail, unit coverage %, integration coverage %, failures with file:line
   - gate_passed = tests_pass AND unit_cov >= target AND int_cov >= target
   - Exception: strategy=characterization or flexible -> gate_passed = true (informational only)

**3. Gate Result Recording**
   Record quality gate outcome as br comment and close story on pass

   - Run: br comment add <STORY_BEAD_ID> "Quality gate result: <PASS|FAIL> | unit: <X%> | integration: <Y%> | strategy: <strategy>"
   - Run: br sync --flush-only
   - If gate_passed: br close <STORY_BEAD_ID> --reason='Phase complete - quality gate passed'; br sync --flush-only; git commit -m "chore(phase <N>): checkpoint (tests pass; unit <X%>, int <Y%>)"
   - If NOT gate_passed AND blocking strategy (tdd/refactor/bug-fix): print gate failure details; PAUSE for user: fix/skip/abort

### Phase 4: Completion

**1. Epic Closure**
   Close the root epic when all children are done

   - Verify: br list --status=open --json filtered by EPIC_SLUG returns no open tasks
   - Run: br close <ROOT_EPIC_ID> --reason='Epic implementation complete'
   - Run: br sync --flush-only

**2. TRD Checkbox Sync**
   Update TRD file checkboxes to reflect bead closure state (TRD_MODE only)

   - If TRD_MODE=false: skip this step
   - If TRD_MODE=true: for each task in TRD Master Task List: if bead status == 'closed' -> replace "- [ ] **<task.id>**" with "- [x] **<task.id>**"
   - git commit -m "docs(TRD): sync checkboxes to bead closure state"

**3. Completion Report**
   Print final summary, requirement satisfaction table (if TRD_MODE), and PR reminder

   - Print completion report: EPIC_SLUG, branch, strategy, ROOT_EPIC_ID, task counts, coverage summary
   - If TRD_MODE=true: print Requirement Satisfaction Table:
   -   Scan ROOT_EPIC_ID comments for req-verified: tokens: run br comment list <ROOT_EPIC_ID>
   -   If br comment list fails: print "WARNING: Could not read root epic comments — req-verified data unavailable." Continue with empty VERIFIED_REQS.
   -   Parse each comment for tokens: req-verified:REQ-NNN, by:TRD-NNN-TEST, qa:<agent>, reviewer:<agent>, ac-proven:AC-NNN-M,...
   -   Build VERIFIED_REQS map keyed by REQ-NNN, capturing the verifier and proven ACs from each comment
   -   Print table:
   -     === REQUIREMENT SATISFACTION REPORT ===
   -     REQ-001: SATISFIED (TRD-001-TEST) — ACs: AC-001-1, AC-001-2
   -     REQ-002: NOT VERIFIED (TRD-002-TEST still open)
   -     TOTAL: <N> satisfied / <M> total requirements
   -     ========================================
   - If TRD_MODE=false: print "Requirement Satisfaction: N/A (no TRD — run with --trd <path> to enable traceability tracking)"
   - Run: br sync --flush-only
   - If BV_AVAILABLE: run bv --robot-triage --format toon for final progress summary
   - Remind user: git diff main...<branch>; gh pr create; after merge: move any TRD file to docs/TRD/completed/
   - Remind user: br sync --flush-only && git add .beads/ && git commit -m "chore: final beads sync"
   - TIP: The execution engine used here is also available via /ensemble:implement-trd-beads <trd-path> for TRD-driven workflows with full scaffold, traceability validation, and Design Readiness gate.
   - Do NOT auto-create PR — user must run gh pr create manually

## Expected Output

**Format:** Implemented features with quality gates and beads tracking

**Structure:**
- **Closed Beads**: All task and story beads closed with quality gate comments recorded via br comment add
- **Feature Branch**: Git feature branch with implementation commits and phase checkpoint commits
- **TRD Checkboxes**: TRD Master Task List updated with completed checkboxes synced to bead closure state (TRD_MODE only)
- **Completion Report**: Summary with epic ID, coverage metrics, PR creation reminder, and optional Requirement Satisfaction Table
- **Requirement Satisfaction Report**: Table of PRD REQ-NNN requirements with SATISFIED/NOT VERIFIED status, test task references, and proven AC sub-IDs (TRD_MODE only)

## Usage

```
/ensemble:beads-build [epic-id|slug-pattern] [--trd trd-path] [--strategy tdd|characterization|bug-fix|refactor|test-after|flexible] [max parallel N]
```
