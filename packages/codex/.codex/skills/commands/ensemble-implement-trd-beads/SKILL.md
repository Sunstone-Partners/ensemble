---
name: ensemble-implement-trd-beads
description: Implement TRD with beads project management — persistent bead hierarchy, dependency-aware execution via toolchain-cli tracker/work-graph capabilities, and cross-session resumability (Codex skill for /ensemble:implement-trd-beads)
user-invocable: true
argument-hint: '[trd-path] [--plan] [--execute] [--branch=<name>] [--use-current-branch] [--status] [--reset-task TRD-XXX] [--list] [max parallel N] [--foreman] [<trd-path> <trd-path>... --workstream [--generate-only [--out <path>] [--allow-invalid]]]'
model: gpt-5.1-codex
capabilities:
  required:
    - tracker.list
    - tracker.create
    - tracker.comment
    - tracker.close
    - test-runner.run
    - package-runner.run-script
    - workflow.commit
    - workflow.merge-base
  optional:
    - work-graph.plan
    - work-graph.graph-health
    - tracker.stage-export
    - tracker.comments
    - tracker.dep-add
    - tracker.sync
---

# Ensemble Command: /ensemble:implement-trd-beads

This Codex skill mirrors the Ensemble slash command `/ensemble:implement-trd-beads`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from implement-trd-beads.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Parse a TRD, scaffold a beads hierarchy (epic -> stories -> tasks), hand
execution to /ensemble:beads-build, then run the phase quality gates, PR review
gates, completion verification and epic closure. State lives in beads; runs
resume across sessions. This command owns closure: beads-build is always invoked
with --defer-completion.

Rules:
- Never hand-parse a TRD; every parse/plan/status comes from `node "$TRD_CLI"` JSON.
- Scheduling is delegated to beads-build, which uses work-graph.ready (graph-aware parallel tracks when the resolved tracker adapter exposes dependency links) or plan order when that is unavailable. Never read .beads/*.jsonl to schedule.
- Every `node "$TOOLCHAIN_CLI"` `run`/`confirm-*` call below carries `--run-id "$RUN_ID" $NON_INTERACTIVE_ARGS --json` even where not spelled out.
- Never stage broadly (no blanket, whole-directory or auto-staging commit). Stage beads only via `node "$TRD_CLI" beads-stage --match "[trd:<TRD_SLUG>"`; every commit is `node "$TOOLCHAIN_CLI" run workflow.commit --arg message="<message>"`.
- PR_REVIEW_SKILL = packages/development/skills/pr-review-cycle/SKILL.md (via tool-path-resolution); every pr-review-cycle call below reads it.
- FULL_TEST_COMMAND = `node "$TOOLCHAIN_CLI" run package-runner.run-script --arg script=test --run-id "$RUN_ID" $NON_INTERACTIVE_ARGS --json` (full suite): the Pre-PR test gate (non-ok or non-zero fails) and the pr-review-cycle TEST_COMMAND.
- In every `tracker.list` result the issue list is `data` parsed as JSON if it is an array, otherwise its `.issues` array.
- Scaffold work is delegated only to @beads-scaffold-specialist (never backend-developer); no product code is written during Scaffold.
- Branch intent, PR creation, workstream mode and resume/recovery detail: `implement-trd-beads-reference` skill; read only the section a step points at.

Terminal states: HALT (error printed, nothing further runs), EXIT (early-exit mode
finished), COMPLETE (epic closed, report printed).

## Arguments

- **`workstream`** (boolean, optional, default: `false`): With two or more TRD paths, generate one normalized executable workstream TRD (node "$TRD_CLI" create-workstream-trd) and implement that single TRD.
- **`generate-only`** (boolean, optional, default: `false`): Only with --workstream and two or more TRD paths (replaces the removed /ensemble:create-workstream-trd). Generate the workstream TRD, report, and EXIT before any tracker/git/branch/scaffold/commit/PR side effect. Accepts --out <path> and --allow-invalid.
- **`foreman`** (boolean, optional, default: `false`): Force non-interactive mode (INTERACTIVE=false) for Foreman orchestration. No HALT behavior changes: unresolved branch intent, unresolved PR backend and failed completion verification still HALT. When FOREMAN_ARTIFACT_PATH is set and non-empty, also write the phase report to that exact path (never alter it; unset is not an error).

## Workflow

### Phase 1: Preflight

**1. Arguments and early exits**
   Parse $ARGUMENTS and apply the first matching rule.


- `--plan` with `--execute`: print 'ERROR: --plan and --execute are mutually exclusive.' and EXIT. `--plan` sets PLAN_ONLY (scaffold, then stop); `--execute` sets EXECUTE_ONLY (skip scaffold, requires an existing epic).
- `--generate-only` together with any of `--plan`, `--execute`, `--status`, `--reset-task`, `--list`, `--branch=<name>`, `--use-current-branch`: print 'ERROR: --generate-only only generates the workstream TRD and cannot be combined with --plan, --execute, --status, --reset-task, --list, --branch or --use-current-branch.' and HALT before any tracker/git/scaffold side effect.
- TRD paths are the `.md` arguments (excluding the value after `--out`). Two or more without `--workstream`/`--legacy-multi`: print 'ERROR: Multiple TRDs passed directly. Direct multi-TRD execution is deprecated because it can lose fidelity across parser/runtime merge boundaries. Run /ensemble:implement-trd-beads --workstream --generate-only <trd1> <trd2> ... then /ensemble:implement-trd-beads <generated-workstream-trd>, or rerun with --workstream to generate and implement in one step.' and HALT before any tracker/git/scaffold side effect. `--legacy-multi` handling is reference section 4.
- `--workstream` with two or more TRD paths: resolve TRD_CLI per the tool-path-resolution skill (unresolvable or no Node.js runtime -> print 'ERROR: Node.js and the TRD CLI (lib/trd-cli.js) are required to generate the workstream TRD.' and HALT), run `node "$TRD_CLI" create-workstream-trd <TRD_PATHS...>` (with `--generate-only`, also pass `--out <path>` and `--allow-invalid` if given), parse `{ok,path,workstreamSlug,sourceTrds,errors}`. `ok` false, non-zero exit or malformed JSON -> print every error and HALT (no file is written on validation failure unless `--allow-invalid` in generate-only mode). Without `--generate-only`, continue as a single-TRD run on `path`. Generated content and details: reference section 4.
- `--generate-only` without `--workstream` and two or more TRD paths (or with `--legacy-multi`): print 'ERROR: --generate-only requires --workstream and two or more TRD paths.' and HALT.
- `--generate-only` after successful generation: print the generated path, the workstream slug, the source TRD count and the next step `/ensemble:implement-trd-beads <generated-path>`, then EXIT here: no later Preflight step runs, nothing is implemented, and no beads, branches, commits or PRs are created.
- `--list`: `node "$TRD_CLI" list --type trd` -> `{ok,items}`; print a table (ID/Name, Status, Score, Last Modified), ask via AskUserQuestion `id=trd_select` which to implement, and resolve `docs/TRD/<file>.md` by slug suffix/prefix match (unresolvable -> HALT).
- `--status`: single TRD: `node "$TRD_CLI" status <TRD_SLUG>` and print `completion_pct` and `bead_counts`; EXIT. Workstream form: reference section 4.
- `--reset-task TRD-XXX`: reference section 5; EXIT.
- `--branch=<name>` -> BRANCH_REQUESTED; `--use-current-branch` -> USE_CURRENT_BRANCH_REQUESTED; both together HALT before any tracker/git/scaffold side effect.
- `max parallel N` / `--max-parallel N` -> MAX_PARALLEL; else TRD frontmatter `max_parallel`; else 3.

**2. Tools**
   Resolve toolchain-cli, preflight required capabilities, detect interactivity, and verify remaining tooling.

- Resolve TOOLCHAIN_CLI (`packages/development/lib/toolchain-cli.js`) per the tool-path-resolution skill (`packages/development/skills/tool-path-resolution/SKILL.md`); unresolvable -> print 'ERROR: could not locate toolchain-cli' and HALT.
- Detect AskUserQuestion availability: INTERACTIVE=true if available else false (covers --foreman too); set NON_INTERACTIVE_ARGS=--non-interactive when INTERACTIVE=false else empty, appended to every toolchain-cli call below (never prompt when set). Then run: node "$TOOLCHAIN_CLI" preflight --require tracker.list --require tracker.create --require tracker.comment --require tracker.close --require test-runner.run --require package-runner.run-script --require workflow.commit --require workflow.merge-base $NON_INTERACTIVE_ARGS --json; parse PREFLIGHT_RESULT. {ok:false} -> print error.message and HALT; {ok:true} -> RUN_ID=PREFLIGHT_RESULT.runId, used as --run-id "$RUN_ID" on every later call. tracker.dep-add/sync are optional, degrade on {ok:false}.
- Resolve TRD_CLI (`packages/development/lib/trd-cli.js`) per the tool-path-resolution skill (`packages/development/skills/tool-path-resolution/SKILL.md`); unresolvable or no Node.js runtime -> HALT.
- Unless PLAN_ONLY: `beads-build-wave` must be among the Task tool's accepted subagent types (a file on disk does not prove it). If not: print 'ERROR: agent beads-build-wave is not registered in this session. Run /ensemble:reinstall-plugins and re-run.' and exit 1 before any bead is created.

**3. Git-town, PR backend and working tree**
   Resolve BRANCHING_STRATEGY, PR_BACKEND, INTERACTIVE and WORKTREE_STATUS. Procedure is reference section 1.

- Follow reference section 1. Exit codes 3/4 from validate-git-town.sh and `branchingStrategy.action=='halt'` HALT; an unresolvable PR backend asks (interactive) or HALTs with the `ENSEMBLE_PR_BACKEND=<ado|manual|gh>` options (non-interactive).

**4. TRD selection and validation**
   Locate the TRD and validate it before any side effect.

- TRD_FILE_PATH priority: `.md` argument -> name search in `docs/TRD/` -> the single in-progress TRD in `docs/TRD/` -> ask. It must exist, contain `## Master Task List` and at least one `- [ ] **TRD-` entry.
- TRD_SLUG = filename lowercased, non-alphanumerics -> `-`, trimmed of leading/trailing `-`. TRD_LABEL = TRD_SLUG: the label every scaffolded bead carries and the work-graph scheduler scopes by (not the TRD's display-only frontmatter Label).
- Design readiness (frontmatter `design_readiness_score`): >= 4.0 pass; 3.0-3.99 warn and ask to continue (non-interactive: continue); < 3.0 HALT suggesting /ensemble:refine-trd; absent: note and continue.
- Traceability: run `node "$TRD_CLI" validate "<TRD_FILE_PATH>"`. `error` key -> HALT. Print `errors`, `warnings` and `skipped`. `ok:false` -> HALT ('Fix orphaned [satisfies] annotations ... run /ensemble:validate-requirements for details'); warnings alone continue.
- `node "$TRD_CLI" resolve-bdd --trd "<TRD_FILE_PATH>"` -> BDD_MODE {enabled,source,message}; print `message`; `error` -> HALT.

**5. Resume detection, staleness gate, strategy**
   Decide fresh run vs resume, then gate on staleness and pick the strategy.

- Run: node "$TOOLCHAIN_CLI" run tracker.list; search its issue list for an open epic titled `[trd:<TRD_SLUG>]`.
- Call node "$TOOLCHAIN_CLI" confirm-status tracker.create before this command's first write outside the local working tree. If data.confirmed==false, data.required==true and INTERACTIVE=true: ask via AskUserQuestion (id=tracker_confirm, options=Yes/Abort); Abort HALTs; Yes calls node "$TOOLCHAIN_CLI" confirm-record tracker.create. Under NON_INTERACTIVE_ARGS never prompt.
- Found -> IS_RESUME=true, ROOT_EPIC_ID=its id, node "$TOOLCHAIN_CLI" run tracker.sync, print `node "$TRD_CLI" status <TRD_SLUG>` progress. Clean-tree gate (WORKTREE_STATUS from step 3): fresh run + dirty tree HALTs; resume + dirty tree notes it and continues (details: reference section 5).
- Fresh run only: run the staleness-gate skill (`packages/development/skills/staleness-gate/SKILL.md`, resolved per tool-path-resolution) with TRD_PATH and IS_RESUME=false. Skip it on resume.
- STRATEGY: `strategy=X` argument -> TRD explicit -> constitution -> auto-detect (legacy/brownfield -> characterization, bug fix -> bug-fix, refactor/tech debt -> refactor, prototype/spike -> test-after) -> tdd.

**6. Branch intent and feature branch**
   Resolve the target branch and PR topology before the first git mutation. Procedure is reference section 2.

- Follow reference section 2 (choices-read, pr-plan, intent resolution, reuse-mode PR_ACTIONS rewrite, checkout, choices-write). Produces STACKED_PRS, PR_ACTIONS, CURRENT_PHASE_BRANCH, PHASE_BRANCH_MAP, PHASE_PR_MAP. Runs on every invocation, including resumes.

**7. Team roster and agent aliases**
   Establish TEAM_ROLES and AGENT_ALIAS_MAP for delegation.

- TEAM_ROLES: the TRD's explicit `team:` block if present, else `resolveDefaultTeamRoles` from `packages/development/lib/team-defaults.js` (always-on 8-role roster; no single-agent mode). Log one line `Team mode (default roster|TRD roster): lead=..., architect=..., builders=<n>, reviewer=..., qa=..., advisor=..., pm=..., documentation=...`.
- AGENT_ALIAS_MAP maps each unqualified agent name to its runtime id `<plugin>:<name>` (e.g. `backend-developer` -> `ensemble-full:backend-developer`). Build it from `packages/*/agents/*.yaml` plus the runtime agents `~/.omp/plugins/node_modules/@*/*/agents/*.md` and `~/.omp/plugins/node_modules/*/agents/*.md`; an exact unqualified entry wins over an alias. beads-build resolves the wave-runner through it. Never pass a bare name to Task() when only the namespaced form is accepted; a missing alias HALTs.

### Phase 2: Scaffold

**1. Plan and create beads**
   Skipped when IS_RESUME or EXECUTE_ONLY. The scaffold-plan PLAN is authoritative; execute it, never re-derive titles, descriptions or edges.

- `node "$TRD_CLI" parse "<TRD_FILE_PATH>"` -> `trd` (title, slug, prFormat, phases[{n,title,shippableState,taskIds}], tasksById, warnings). Print warnings. `ok:false`/non-zero -> HALT.
- `node "$TRD_CLI" scaffold-plan "<TRD_FILE_PATH>"` -> `{ok, slug, plan}`; failure -> HALT. Print `plan.warnings`.
- Cache existing beads once: node "$TOOLCHAIN_CLI" run tracker.list, keyed by title prefix (`[trd:<slug>]`, `[trd:<slug>:pr:<N>]` or `[trd:<slug>:phase:<N>]`, `[trd:<slug>:task:<ID>]`). Never re-query per bead.
- Create in order `plan.epic`, `plan.stories[]`, `plan.tasks[]`, `plan.synthesizedTests[]`. Skip any entry whose titlePrefix is cached (use the cached id). Otherwise run node "$TOOLCHAIN_CLI" run tracker.create --arg title="<title>" --arg type=<type> --arg description="<description>" and capture `.data.id` (no priority/labels/externalRef arg; externalRef folds into description, labels backfilled later). Beads open with `## References`. HALT on any failure or empty id. Record ROOT_EPIC_ID, story ids by phase, TRD_TO_BEAD_MAP[task id], PHASE_TASK_IDS[phaseN].
- Then wire `plan.deps` once: each `{type, blockerId, blockedId}` has title-prefix endpoints (`[trd:<slug>]` -> epic, `...:pr:<n>`/`...:phase:<n>` -> story, `...:task:<id>` -> task bead); run node "$TOOLCHAIN_CLI" run tracker.dep-add --arg id=<blocked_bead_id> --arg dependsOnId=<blocker_bead_id> --arg type=blocks. `{ok:false,unavailable:true}` -> warn once, skip remaining edges. Otherwise: existing edges are a no-op; warn and skip unresolvable ones. Also remove stale inter-phase edges from older scaffolds (reference section 5).
- node "$TOOLCHAIN_CLI" run tracker.sync. Print epic id and story/task/dep counts.
- Test task beads (`isTest`) carry their `Test AC:` scenarios in the description. If BDD_MODE.enabled the specialist follows "TRD commands" in `packages/reqnroll/skills/reqnroll/SKILL.md`; otherwise it writes them in the repo's own framework and runs them with `test-runner.run`. RED before the paired implementation bead goes GREEN.

**2. Work-graph analysis and handoff**
   Optional graph planning, optional Foreman tagging, then stop if PLAN_ONLY.

- Run work-graph.plan (tracks) and work-graph.graph-health (cycle/stale-blocker findings) via node "$TOOLCHAIN_CLI" run <capability>; both optional. {unavailable:true} on either -> warn and skip it (no triage-style capability; its summary folds into graph-health's `findings`). {ok:true} -> print tracks, recommendations, findings. Non-empty `findings` HALT before execution until fixed (or /ensemble:refine-beads); unexpected blockers or priority/order mismatches ask continue / refine-beads / abort (non-interactive: continue).
- `--foreman` only: tag task beads for dispatch per reference section 6.
- PLAN_ONLY: print 'Plan complete. Bead hierarchy created. Run /ensemble:implement-trd-beads --execute to begin implementation.' and EXIT. `/ensemble:beads-build <ROOT_EPIC_ID> --plan` regenerates the analysis anytime.

### Phase 3: Execute

**1. Delegate to beads-build**
   One execution engine. beads-build owns wave scheduling and the builder/review pipeline; this command owns everything after it.

- TEAM_ROLES_JSON = compact JSON of TEAM_ROLES (deprecated `--builder` / frontmatter `builder_agent` fall back to a compatibility roster `{lead:{agents:['tech-lead-orchestrator'],owns:['planning','escalation']},builder:{agents:[<builder or 'tech-lead-orchestrator'>],owns:['implementation']},architect:{agents:['architect'],owns:['task-design']},documentation:{agents:['documentation-specialist'],owns:['pr-boundary-doc-maintenance']}}`). ROOT_EPIC_ID must be set, else HALT 'Cannot delegate to beads-build — ROOT_EPIC_ID missing.'
- Backfill labels for scaffolds that predate them (an unlabeled bead would make the scheduler sweep the whole repo): `node "$TRD_CLI" beads-label --label "<TRD_LABEL>" --match "[trd:<TRD_SLUG>"` -> `{ok,labeled,already}` on success. `{ok:false,unavailable:true,reason}` -> warn and continue. Any other failure -> HALT.
- References health check (reference section 7): warn with the count of open scoped beads lacking a `## References` block. Run `node "$TRD_CLI" bead-context --bead <ROOT_EPIC_ID> --trd <TRD_FILE_PATH>`; `ok:false` or non-zero -> print every `missing` entry and HALT before beads-build.
- Invoke `/ensemble:beads-build <ROOT_EPIC_ID> --trd <TRD_FILE_PATH> --max-parallel <MAX_PARALLEL> --team-roles '<TEAM_ROLES_JSON>' --label <TRD_LABEL> --defer-completion`. Without slash dispatch (Pi/OMP) call the `ensemble-beads-build` skill with `--epic <ROOT_EPIC_ID>` in place of the positional id and the same flags.
- Non-zero exit: print its output as a Debug Loop entry and HALT. Zero: read its summary (bead counts, branch state, last task closed). `--defer-completion` makes it skip epic closure and TRD checkbox sync; both run here after the gates. A blocked wave is handled per reference section 5.
- work-graph triage counts are global across all epics; never present them as this TRD's progress.

### Phase 4: Quality Gate

**1. Per-phase gate**
   After execution, process phases in order. A phase is done when `phase-status` reports it complete. Resume here after a blocked review.


- Closed task ids = TRD task ids whose beads are closed (tracker.list titles `[trd:<slug>:task:<id>]`, via node "$TOOLCHAIN_CLI" run tracker.list). `node "$TRD_CLI" phase-status "<TRD_FILE_PATH>" --closed "<comma-joined ids>"` -> `{ok,currentPhase,phases:[{n,complete}],phaseTaskIds}`. On failure treat the phase as not complete this cycle. Run the gate below for each complete, not-yet-closed phase N (story = its story bead).
- Tests: for this phase's files, run `node "$TOOLCHAIN_CLI" run test-runner.run --arg file=<phase files> --arg framework=<detected>` (the full suite); parse `{success,passed,failed,skipped,total,duration,failures}` and report pass/fail, failures by file:line. `gate_passed = success`; for strategy characterization or flexible it is informational (always passes).
- Record: node "$TOOLCHAIN_CLI" run tracker.comment --arg id=<STORY_BEAD_ID> --arg text="Quality gate result: <PASS|FAIL> | passed: <passed>/<total> | strategy: <strategy>", then tracker.sync the same way (optional). Not passed under tdd/refactor/bug-fix: print failures and pause for the user (fix / skip / abort).
- GATE_ACTION = PR_ACTIONS[N]. If `GATE_ACTION.createPr == false` (single-PR mode): node "$TOOLCHAIN_CLI" run tracker.close --arg id=<STORY_BEAD_ID> (no reason arg), then tracker.sync the same way (optional), `node "$TRD_CLI" beads-stage --match "[trd:<TRD_SLUG>"`, then commit via node "$TOOLCHAIN_CLI" run workflow.commit --arg message="chore(<bead_prefix> <N>): checkpoint (tests pass; passed <passed>/<total>)"; continue to the next phase on the single branch.
- If `GATE_ACTION.createPr == true` (stacked): do NOT close the story yet. (1) Pre-PR test gate FULL_TEST_COMMAND; failing -> HALT 'Local tests failed — PR creation blocked.' (2) On `GATE_ACTION.branch`, PARENT_PHASE_TIP_SHA = the `sha` output of node "$TOOLCHAIN_CLI" run workflow.merge-base --arg refA=HEAD --arg refB=<GATE_ACTION.parentBranch>; invoke the pr-review-cycle skill (PR_REVIEW_SKILL) with MODE='local', BASE_SHA=<PARENT_PHASE_TIP_SHA>, HEAD_SHA=<HEAD SHA>, PR_ID='<TRD_SLUG>-phase-<N>', TEST_COMMAND=<FULL_TEST_COMMAND>, FOREMAN=<true if --foreman or INTERACTIVE=false>. (3) It returns `{status, localPhase, reasons, reportPath}`. Only `localPhase=='LOCAL_REVIEW_COMPLETE'` passes; anything else is LOCAL_REVIEW_BLOCKED. Record node "$TOOLCHAIN_CLI" run tracker.comment --arg id=<STORY_BEAD_ID> --arg text="PR review gate: <result> | report: <reportPath>". BLOCKED -> print the reasons and report path and HALT with the story still open, no PR and no branch append. COMPLETE -> close the story (tracker.close, no reason arg), sync, beads-stage, checkpoint commit (`... local review complete`), then create the PR and append the next branch per reference section 3.

### Phase 5: Completion

**1. Completion verification**
   Sole authority for task inventory, requirements and tests. Runs before any epic closure or completion message.

- Invoke the completion-verification skill (packages/development/skills/completion-verification/SKILL.md via tool-path-resolution) with TRD_FILE_PATH, TRD_SLUG, TRACKING_MODE='beads', ROOT_EPIC_ID, TRD_TO_BEAD_MAP. It returns `{verdict, gapCount, reportPath}`.
- `INCOMPLETE`: print 'COMPLETION VERIFICATION FAILED: <gapCount> gap(s) found. Report: <reportPath>'. Interactive: ask 'Proceed anyway (override)' / 'Stop — fix gaps first'; only an explicit override sets COMPLETION_OVERRIDDEN. Otherwise (including non-interactive) HALT before Epic Closure: do not close the epic, sync checkboxes or print completion messaging.
- `COMPLETE`: print 'Completion verification: PASSED (0 gaps). Report: <reportPath>' and continue.

**2. PR review completion check**
   Whole-branch local review in single-PR mode; remote review status is informational only.

- COMPLETION_ACTION = the `PR_ACTIONS` entry with `kind=='completion'`. Skip the local gate ONLY when COMPLETION_ACTION exists and `createPr` is exactly false (stacked mode; each phase already passed its gate). A missing entry or any other `createPr` value is treated as LOCAL_REVIEW_BLOCKED, never skipped.
- Single-PR local gate: COMPLETION_BASE_SHA = the `sha` output of node "$TOOLCHAIN_CLI" run workflow.merge-base --arg refA=HEAD --arg refB=<default branch> (default = the remote's default branch minus `origin/`, else `main`); empty or unresolvable -> BLOCKED without calling the skill. Else invoke pr-review-cycle (PR_REVIEW_SKILL) with MODE='local', BASE_SHA=<COMPLETION_BASE_SHA>, HEAD_SHA=<HEAD SHA>, PR_ID='<TRD_SLUG>-completion', TEST_COMMAND=<FULL_TEST_COMMAND>, FOREMAN as above. COMPLETION_LOCAL_REVIEW is 'LOCAL_REVIEW_COMPLETE' only when `localPhase=='LOCAL_REVIEW_COMPLETE'`; any other, missing or unparseable result is BLOCKED -> print 'PR REVIEW GATE BLOCKED for the completion PR: <reasons>. Report: <reportPath>.' and HALT before Epic Closure (epic open, no completion PR, a later re-run reviews fresh).
- Remote status (never HALTs, never blocks closure): for each stacked phase with `PHASE_PR_MAP[N]` set, invoke pr-review-cycle with MODE='remote', PR_ID='<TRD_SLUG>-phase-<N>', PR_URL, HEAD_SHA=<head of that branch>, BOT_LOGINS=<configured review bots>, FOREMAN as above. `PR_REVIEW_STATUS[N]` = the returned `status` if exactly REVIEW_COMPLETE / REVIEW_PENDING / REVIEW_BLOCKED, else REVIEW_PENDING. Phases whose PR was never created (manual backend, ado without MCP) are 'PENDING (no PR created)'. Never call a PR merged or landed; only a human confirming the merge does. Single-PR mode has no remote PR yet; the report marks it REVIEW_PENDING at creation.

**3. Epic closure and TRD checkboxes**
   Close the epic only after verification and review gates held.

- Proceed only if (verdict COMPLETE, or INCOMPLETE with COMPLETION_OVERRIDDEN) AND (COMPLETION_ACTION.createPr is exactly false, or COMPLETION_LOCAL_REVIEW == 'LOCAL_REVIEW_COMPLETE').
- No open task or story bead for this TRD may remain: list open beads with `[trd:<TRD_SLUG>:task:` / `[trd:<TRD_SLUG>:story:` titles; a listing that fails or cannot be parsed counts as 'open beads remain'. If any, investigate instead of closing.
- node "$TOOLCHAIN_CLI" run tracker.close --arg id=<ROOT_EPIC_ID> (no reason arg), then tracker.sync the same way.
- Sync the TRD: for each Master Task List task whose bead is closed, change `- [ ] **<id>**` to `- [x] **<id>**`; then stage <TRD_FILE_PATH> (that file only), `node "$TRD_CLI" beads-stage --match "[trd:<TRD_SLUG>"`, and commit via node "$TOOLCHAIN_CLI" run workflow.commit --arg message="docs(TRD): sync checkboxes to bead closure state".

**4. Completion report**
   Final summary, completion PR (single-PR mode) and next steps.

- Write tracker.list's `data` to ISSUES_FILE; run `node "$TOOLCHAIN_CLI" run tracker.comments --arg id=<ROOT_EPIC_ID>`; on `{ok:true}` extract `req-verified:REQ-NNN` tokens into VERIFIED_REQS (else empty); run `node "$TRD_CLI" req-status "<TRD_FILE_PATH>" --issues-json <ISSUES_FILE> --verified <VERIFIED_REQS>` (omit when empty). Print TRD file, branch, strategy, epic id, `node "$TRD_CLI" status <TRD_SLUG>` progress, SATISFIED/NOT VERIFIED per requirement, and total.
- Single-PR mode (`COMPLETION_ACTION.createPr == true`): the whole-branch review already passed in step 2; do not re-run it. Pre-PR test gate FULL_TEST_COMMAND (failing -> HALT). Create the PR per `PR_BACKEND` using COMPLETION_ACTION (base = default branch, body `Implements TRD <TRD_SLUG>. Strategy: <strategy>. <phase_count> phases, <task_count> tasks — all complete. Bead: <ROOT_EPIC_ID>.`; reference section 3). Print a PR SUMMARY with the URL and 'Review: REVIEW_PENDING (head-bound remote review has not run; re-invoke pr-review-cycle MODE=remote for PR_ID <TRD_SLUG>-completion)', or, if no PR was auto-created, 'PR: not auto-created' and 'Review: PENDING (no PR created)'.
- Stacked mode (`STACKED_PRS=true`): print a STACKED PR SUMMARY, one line per `PHASE_BRANCH_MAP` entry: `<PR|Phase> <N>: <url or 'not auto-created — see manual instructions printed at that phase gate'> (branch -> parent) -- review: <PR_REVIEW_STATUS[N]>`, plus `Shippable: <state>` when PR_FORMAT is true. Say to merge PR 1 first (it targets the default branch); git-town auto-retargets the rest, plain-git needs manual retargeting.
- Remind user: after all PRs merge run `mv <trd_file> docs/TRD/completed/`. Beads-backed quickstart.md generation is unsupported.
- Remind user: node "$TOOLCHAIN_CLI" run tracker.sync (optional) && node "$TRD_CLI" beads-stage --match "[trd:<TRD_SLUG>" && node "$TOOLCHAIN_CLI" run workflow.commit --arg message="chore: final beads sync"

## Expected Output

**Format:** Beads hierarchy, feature branch(es) and PR(s), closed beads with quality-gate comments, TRD checkboxes synced, completion verification report and requirement satisfaction report

**Structure:**
- **Workstream TRD (--workstream --generate-only)**: Generated workstream TRD under docs/TRD/workstreams/ (or the --out path)

## Usage

```
/ensemble:implement-trd-beads [trd-path] [--plan] [--execute] [--branch=<name>] [--use-current-branch] [--status] [--reset-task TRD-XXX] [--list] [max parallel N] [--foreman] [<trd-path> <trd-path>... --workstream [--generate-only [--out <path>] [--allow-invalid]]]
```
