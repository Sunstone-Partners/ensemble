---
name: ensemble-implement-trd-task
description: Single-task primitive for implement-trd.yaml. Runs ONE task through implement -> review -> close and emits a JSON summary. Non-recursive; the parent loop owns iteration. (Codex skill for /ensemble:implement-trd-task)
user-invocable: true
argument-hint: '--task <id> [--trd trd-path] [--strategy tdd|characterization|bug-fix|refactor|test-after|flexible]'
model: gpt-5.1-codex
---

# Ensemble Command: /ensemble:implement-trd-task

This Codex skill mirrors the Ensemble slash command `/ensemble:implement-trd-task`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from implement-trd-task.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Single-task primitive for the implement-trd execution engine. Each invocation
runs exactly one TRD task through the implement -> review -> close pipeline.
The subagent dispatched for the work is named via the parent's payload
(specialist resolved by parent from targetFiles). The task-runner owns the
review/close sequence and emits a JSON summary so the caller can decide
whether to dispatch another task.

This command is intentionally non-recursive: at no point does this command
call itself or any sibling subagent. The loop lives in the caller
(implement-trd.yaml Task Loop step), which checks the summary
task_state and dispatches another task-runner if more work remains. That
two-tier shape respects Codex max_depth=1 constraint and works uniformly
across claude/pi/codex/opencode via the universal Task() primitive.

Loop architecture: this is the second tier of a two-tier non-recursive dispatch
loop. The parent (implement-trd.yaml TASK LOOP) is depth 0; it dispatches
Task(subagent_type=implement-trd-task, prompt={task_id, ...}) on this command,
which runs at depth 1. The task-runner itself dispatches its own specialist
subagents (backend-developer, code-reviewer, deep-debugger) at depth 1 of its
own subtree. Sub-totals: parent -> task-runner -> specialist. That accounts for
two levels of nesting under the parent; the task-runner NEVER calls itself or
any sibling task-runner. This shape respects Codex max_depth=1 constraint and
works uniformly on claude/pi/codex/opencode.
across claude/pi/codex/opencode via the universal Task() primitive.

When invoked standalone (not from implement-trd), this command still
respects its single-task contract: it exits with a JSON summary once the
task reaches a terminal state. Callers re-invoke it themselves.

## Workflow

### Phase 1: Preflight

**1. Argument Parsing**
   Parse --task, --trd, --strategy

   - Parse $ARGUMENTS: --task <id> sets TASK_ID. If absent: print 'ERROR: --task <id> is required' and HALT.
   - Parse --trd <path> from $ARGUMENTS (required); set TRD_PATH=<path>. If absent: print "ERROR: --trd <path> is required" and HALT.
   - Parse --strategy <value> from $ARGUMENTS (optional); valid: tdd, characterization, bug-fix, refactor, test-after, flexible.
   - Print "Task-runner invoked for TASK=<TASK_ID> trd=<TRD_PATH> strategy=<STRATEGY or default>".

**2. Task Resolution**
   Confirm task exists in TRD; load full task context; honor resume state from TRD checkboxes

   - Run: node "$TRD_CLI" parse "<TRD_PATH>" and parse the JSON from stdout. If ok is false or exit non-zero: print the error and HALT. Set TRD_TASKS=trd.tasksById, SPRINTS=trd.phases.
   - Confirm TASK_ID is in TRD_TASKS. If not: print "ERROR: task <TASK_ID> not found in TRD." and HALT.
   - If the TRD file's Master Task List checkbox for TASK_ID is already "- [x]": print "Task <TASK_ID> already closed (resume)." and emit summary task_state="already_closed" then exit.
   - Locate TASK_ID's sprint: CURRENT_SPRINT = SPRINTS entry whose taskIds contains TASK_ID. If TASK_ID is not in any sprint: print "ERROR: task <TASK_ID> is not assigned to any sprint in the TRD." and HALT.
   - Load TASK_CONTEXT from TRD_TASKS[TASK_ID]: {id, description, isTest, satisfies, dependsOn, targetFiles, actions, implementationAc, testAc, type}.
   - Verify dependency-readiness: every id in TASK_CONTEXT.dependsOn must already have a "- [x]" checkbox in the TRD. If any are unchecked: emit summary task_state="blocked" with unmet_deps list and exit. The parent loop handles blocked-state recovery (it is the only place that knows the full sprint context).

**3. Strategy Detection**
   Determine implementation strategy from arguments, TRD content, or auto-detection

   - Priority: --strategy arg -> TRD explicit (if declared in TRD header) -> auto-detect from task action text -> default (tdd)
   - Auto-detect: brownfield/legacy/untested -> characterization; bug fix/regression -> bug-fix; refactor/tech debt -> refactor; prototype/POC -> test-after; default -> tdd.
   - Store STRATEGY.

### Phase 2: Execute

**1. Single-Task Dispatch**
   Run exactly one TRD task. This is the entire body of work this command
performs. The caller (implement-trd.yaml Task Loop, or a human)
inspects the JSON summary and decides whether to invoke this command
again.

IMPORTANT — what this command does NOT do:
  - Does NOT loop. After one task reaches a terminal state, the command exits.
  - Does NOT call itself recursively.
  - Does NOT invoke any sibling task-runner subagent.
  - Does NOT advance to the next task. The caller re-invokes this command.
The caller owns the iteration. Lowering the per-iteration decision cost
(just a count check on the summary) is the design goal, not enforcing
continuation.


   - Step 1 (specialist dispatch): resolve the appropriate specialist from TASK_CONTEXT.targetFiles (backend-developer / frontend-developer / infrastructure-developer / etc. - same alias-resolution convention as implement-trd-beads.yaml Agent Alias Resolution: NEVER pass a bare specialist name to Task()). Build a delegation prompt containing {TASK_ID, task_description, task_actions, task_targetFiles, task_dependencies, task_implementationAc, task_testAc, TRD_PATH, STRATEGY}. Launch Task(subagent_type=<resolved_specialist>, prompt=<task_context>) and wait for its result.
   - Step 2 (RED -> GREEN -> REFACTOR): the specialist's own direction inside the subagent follows the same TDD pattern that implement-trd.yaml Task Loop Step 2 prescribes: write failing test per task.testAc, then minimal implementation per task.implementationAc, then refactor. This subagent owns TDD discipline for a single task. Do NOT re-state TDD here — trust the dispatched specialist.
   - Step 3 (review): delegate to code-reviewer with the diff for this task. Parse verdict (APPROVED / REJECTED). On REJECTED with fixable issues: delegate back to the original specialist with the reviewer's feedback (max 2 review rounds total, reflecting implement-trd-beads.yaml quality_loop contract). Skip review only when STRATEGY is characterization or flexible, OR when the task type is docs/documentation-only.
   - Step 4 (close): on APPROVED (or skip-eligible per Step 3): update the TRD file's checkbox for this task from "- [ ]" to "- [x]"; git commit -m "feat(<trd-slug>): <TASK_ID> — <short description>". Print "Task <TASK_ID> complete.".
   - Step 5 (automated remediation before halt): if 2 review rounds are exhausted in Step 3 and the task is still REJECTED: delegate to deep-debugger with the review feedback, failing tests, and changed files. If deep-debugger produces a fix: re-run Step 3 (review) once more. If still REJECTED after that single extra attempt: emit summary task_state="rejected_halt" with the reviewer feedback and exit. The parent loop handles the user-pause escalation (it is the only place that owns the full sprint context).
   - PM clarification loop guard: when a task re-enters clarification, count prior PM rounds for that task from the commit-trailer history. Maximum 3 PM clarification rounds per task. On the 4th request, emit summary task_state="pm_exhausted_halt" with the accumulated clarification history and exit. The parent loop handles lead escalation.
   - Step 6 (build summary): construct a JSON summary line and print it to stdout, then exit. The summary is the only output the caller reads.
   - Schema (one line, valid JSON): { task_id, root_trd_path, trd_slug, sprint_n, task_state ("approved_closed"|"rejected_halt"|"pm_exhausted_halt"|"blocked"|"already_closed"), review_rounds_used, pm_rounds_used, files_changed, commit_sha, elapsed_seconds, next_action_hint ("dispatch_next_task"|"stop_sprint_complete"|"stop_halt_user"|"stop_blocked") }.
   - Print the JSON summary as the LAST line of stdout, then exit. Do NOT print follow-up prose, summaries, or progress commentary after the JSON line — the summary is the contract.

## Expected Output

**Format:** Single JSON summary line, then exit

**Structure:**
- **JSON Summary**: One line of valid JSON describing task outcome; caller reads task_state and next_action_hint to decide next step

## Usage

```
/ensemble:implement-trd-task --task <id> [--trd trd-path] [--strategy tdd|characterization|bug-fix|refactor|test-after|flexible]
```
