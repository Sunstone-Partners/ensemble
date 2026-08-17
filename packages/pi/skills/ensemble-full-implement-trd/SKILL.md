---
name: ensemble-full-implement-trd
description: >-
  This command implements a complete Technical Requirements Document (TRD) using
  modern git-town feature branch workflow. It creates a feature branch and
  delegates to ensemble-orchestrator which routes to tech-lead-orchestrator for
  structured TDD-based development including planning, implementation, testing,
  and quality gates.
disable-model-invocation: true
---
<!-- Command: ensemble:implement-trd | Version: 2.4.0 -->
<!-- Description: Complete TRD implementation using git-town workflow with ensemble-orchestrator delegation and TDD methodology -->

# ensemble:implement-trd

> **Mission:** This command implements a complete Technical Requirements Document (TRD) using modern git-town feature branch workflow. It creates a feature branch and delegates to ensemble-orchestrator which routes to tech-lead-orchestrator for structured TDD-based development including planning, implementation, testing, and quality gates.

## Phase 1: Prerequisites & Feature Branch Setup

### Step 1: Git Town Verification

Check git-town installation and configuration using validation script; resolve branching strategy and PR backend via resolve-sdlc

**Actions:**
1. Resolve TRD_CLI (reusing implement-trd-beads.yaml Preflight's exact convention): first try the canonical monorepo root via `git rev-parse --show-toplevel 2>/dev/null` + `/packages/development/lib/trd-cli.js`; if that fails, fall back to the legacy CWD-relative `packages/development/lib/trd-cli.js`; finally check `${CLAUDE_PLUGIN_ROOT}/lib/trd-cli.js`. If none exist OR 'which node' fails: print 'ERROR: Node.js and the TRD CLI (lib/trd-cli.js) are required. Ensure Node.js is installed and the ensemble-development plugin is present.' and exit 1.
2. Execute validation script - bash "$(git rev-parse --show-toplevel 2>/dev/null)/packages/git/skills/git-town/scripts/validate-git-town.sh"; capture its exit code as GIT_TOWN_EXIT_CODE (0-4).
3. Exit codes 3 (version mismatch) and 4 (not a git repo) are unaffected by this feature — escalate with a specific error message and HALT exactly as before. Exit codes 0 (success), 1 (not installed), and 2 (not configured) no longer escalate/HALT here — they are passed to resolve-sdlc below.
4. Detect ask_user availability: set INTERACTIVE=true if available, INTERACTIVE=false otherwise. (This file has no other existing INTERACTIVE detection to reuse, so this is the minimal equivalent of implement-trd-beads.yaml's mechanism — same technique: is ask_user available.)
5. Run: REMOTE_URL=$(git remote get-url origin 2>/dev/null); if REMOTE_URL is empty (no origin configured), set REMOTE_URL to the literal string 'none' — resolve-sdlc requires a non-empty --remote-url, and any non-URL string is treated as 'no unsupported host detected'.
6. Run: node "$TRD_CLI" resolve-sdlc --git-town-exit-code "$GIT_TOWN_EXIT_CODE" --remote-url "$REMOTE_URL"; parse the single JSON object from stdout as RESOLVE_SDLC_RESULT.
7. If RESOLVE_SDLC_RESULT has an 'error' key (trd-cli.js's shared failure contract — a thrown Error caught by main(), printed as {"error":"<msg>"} with exit 1; NOT {ok:false,error:...}): print the error and HALT. This should not normally happen since GIT_TOWN_EXIT_CODE and REMOTE_URL are always well-formed here, but never swallow it.
8. If RESOLVE_SDLC_RESULT.branchingStrategy.action == 'halt': print RESOLVE_SDLC_RESULT.branchingStrategy.message and HALT.
9. If RESOLVE_SDLC_RESULT.prBackend.needsResolution == true: If INTERACTIVE=true, call ask_user with id='pr_backend', question='This repository's remote is not supported by git-town's PR automation. How should pull requests be created?', options=[{label:'ado',description:'Use the azure-devops MCP tool to create the PR (falls back to printing manual az repos/portal steps if the MCP tool is not connected)',preview:'ENSEMBLE_PR_BACKEND=ado'},{label:'manual',description:'Always print manual PR-creation steps instead of automating PR creation',preview:'ENSEMBLE_PR_BACKEND=manual'},{label:'proceed with gh anyway (not recommended)',description:'Use the gh CLI even though the remote host is not GitHub — will likely fail',preview:'ENSEMBLE_PR_BACKEND=gh'},{label:'abort',description:'Stop without resolving a PR backend',preview:'Abort'}], multi=false, recommended=0. Parse the answer: 'ado' -> PR_BACKEND=ado; 'manual' -> PR_BACKEND=manual; 'proceed with gh anyway (not recommended)' -> PR_BACKEND=gh; 'abort' -> print 'Aborted — no git side effects.' and HALT. If INTERACTIVE=false, or INTERACTIVE detection is itself uncertain (always default to this branch when in doubt — never risk a hung prompt): print 'PR backend could not be auto-resolved for this repository's remote. Set one of the following to proceed non-interactively:', then each of 'ENSEMBLE_PR_BACKEND=ado', 'ENSEMBLE_PR_BACKEND=manual', 'ENSEMBLE_PR_BACKEND=gh' on its own line, then the persistence hint '...set this in your shell profile/CI config to skip this prompt on future invocations.', and HALT.
10. If RESOLVE_SDLC_RESULT.prBackend.needsResolution == false: set PR_BACKEND=RESOLVE_SDLC_RESULT.prBackend.backend (no prompt, no HALT).
11. Set BRANCHING_STRATEGY=RESOLVE_SDLC_RESULT.branchingStrategy.strategy. Both BRANCHING_STRATEGY and PR_BACKEND are re-resolved fresh on every invocation and are read by later steps in this file (Feature Branch Creation, Sprint PR Stacking) — never cached across sessions.
12. If RESOLVE_SDLC_RESULT.consolidatedMessage is non-null: print it. If it is null (the pure-default case — git-town configured and remote is GitHub): print nothing new at all, matching today's exact output for existing git-town+GitHub users.
13. Ensure clean working directory (git status)

### Step 2: TRD Staleness Gate

Check TRD freshness before creating a feature branch. Skip if branch already exists (resume).
Algorithm defined in packages/development/skills/staleness-gate/SKILL.md.

**Actions:**
1. Derive TRD_PATH from $ARGUMENTS (the .md path argument).
2. Derive TRD_SLUG from TRD_PATH filename (lowercase, replace non-alphanumeric with hyphens).
3. Resume detection: run 'git branch --list feature/<TRD_SLUG>-sprint-1'. If this returns a branch name: IS_RESUME=true. If empty: IS_RESUME=false.
4. Execute the TRD Staleness Gate per packages/development/skills/staleness-gate/SKILL.md using TRD_PATH and IS_RESUME.
5. On HALT from skill: do not proceed. Implementation stops.
6. On RETURN from skill: continue to step 3 (Feature Branch Creation).

### Step 3: Feature Branch Creation

Create sprint-1 feature branch using git-town skill interview template

**Actions:**
1. Load interview template from packages/git/skills/git-town/templates/interview-branch-creation.md
2. Extract TRD slug from TRD filename (lowercase, hyphens replacing spaces/underscores)
3. Read ENSEMBLE_USE_STACKED_PRS env var: STACKED_PRS=true only if its value equals 'true' (case-insensitive), else false (DEFAULT — single PR). Log: 'Stacked PRs: <enabled if STACKED_PRS else disabled (single PR)>'.
4. Set CURRENT_SPRINT=1. If STACKED_PRS=true: set CURRENT_BRANCH=feature/<trd-slug>-sprint-1. If STACKED_PRS=false: set CURRENT_BRANCH=feature/<trd-slug> (single branch for the whole TRD).
5. Validate branch name against pattern - ^[a-z0-9-]+(/[a-z0-9-]+)*$
6. Set base_branch to main (or current default branch)
7. Execute, config-driven on BRANCHING_STRATEGY (resolved in Preflight step 1, not exit-code-only): if BRANCHING_STRATEGY=='git-town', run git town hack <CURRENT_BRANCH> [UNCHANGED] (creates the first branch off the default branch); if BRANCHING_STRATEGY=='plain-git', run git checkout -b <CURRENT_BRANCH> <base_branch> unconditionally (no git town attempt at all — zero git town commands issued anywhere in this run).
8. Verify branch creation successful (check git branch output)

### Step 4: TRD Ingestion

Parse and analyze existing TRD document with checkbox tracking

### Step 5: Technical Feasibility Review

Validate implementation approach and architecture

### Step 6: Resource Assessment

Identify required specialist agents and tools

## Phase 2: Ensemble Orchestrator Delegation

### Step 1: Strategic Request Analysis

ensemble-orchestrator analyzes TRD requirements

### Step 2: Development Project Classification

Identifies as development project requiring full methodology

### Step 3: Tech Lead Orchestrator Delegation

Routes to tech-lead-orchestrator for development methodology

## Phase 3: Progressive Implementation with TDD

### Step 1: Planning & Architecture Validation

Validate TRD architecture against current system

### Step 2: Task Status Assessment

Review completed work before proceeding

**Actions:**
1. Check which tasks are already completed
2. Identify blockers and dependencies
3. Prioritize next tasks

### Step 3: Test-Driven Implementation

Follow TDD Red-Green-Refactor cycle for all code

**Actions:**
1. RED - Write failing tests first
2. GREEN - Implement minimal code to pass
3. REFACTOR - Improve code quality

### Step 4: Quality Gates

Code review, security scanning, DoD enforcement

### Step 5: Sprint Review

Mark completed tasks and validate objectives

### Step 6: Sprint PR Stacking

After quality gate passes, create a stacked PR for the current sprint and advance to
the next sprint branch. PR creation branches on PR_BACKEND (resolved in Preflight step
1, matching implement-trd-beads.yaml's TRD-010 behaviors exactly): 'gh' uses git town
propose under BRANCHING_STRATEGY==git-town (unchanged) or a standalone gh pr create
under plain-git; 'ado' prefers the azure-devops MCP tool's repo_create_pull_request when
connected, else prints manual az repos pr create/portal steps and continues (never
HALTs); 'manual' always prints manual instructions at every sprint boundary and never
attempts automation. The next-sprint branch creation (previously git town append) is
config-driven on BRANCHING_STRATEGY, matching TRD-018's line-55 pattern.

**Actions:**
1. Pre-PR test gate (runs before ANY PR creation, both modes): run 'npm run test --workspaces --if-present'. If exit code != 0: print 'ERROR: Local tests failed — PR creation blocked. Fix failing tests and re-run the sprint review to retry.' and HALT. If exit code == 0: print 'Pre-PR test gate: PASSED.'
2. If STACKED_PRS=true: SPRINT_TITLE="feat(<trd-slug>){{colon}} Sprint <CURRENT_SPRINT> implementation"; SPRINT_BODY="Sprint <CURRENT_SPRINT> of TRD complete. Stacked PR targeting <base_branch>.". Branch on PR_BACKEND:
3. PR_BACKEND=='gh' AND BRANCHING_STRATEGY=='git-town' [UNCHANGED]: run git town propose --title "<SPRINT_TITLE>" --body "<SPRINT_BODY>"; record PR URL as SPRINT_PR_MAP[CURRENT_SPRINT].
4. PR_BACKEND=='gh' AND BRANCHING_STRATEGY=='plain-git': run git push -u origin <CURRENT_BRANCH>, then run gh pr create --title "<SPRINT_TITLE>" --base <base_branch> --body "<SPRINT_BODY>" (a standalone gh call, not routed through any git town command); record PR URL as SPRINT_PR_MAP[CURRENT_SPRINT].
5. PR_BACKEND=='ado': run git push -u origin <CURRENT_BRANCH>; scan available tool names for any name starting with 'mcp__azure-devops' (the same 'scan available tool names' technique create-trd.yaml's MCP Enhancement phase uses for the 'mcp__' prefix). If found: call its repo_create_pull_request tool with title="<SPRINT_TITLE>", source branch=<CURRENT_BRANCH>, target branch=<base_branch>, description="<SPRINT_BODY>"; record the returned PR URL as SPRINT_PR_MAP[CURRENT_SPRINT]. If NOT found: print 'Azure DevOps MCP tool not connected — create this PR manually:' then 'az repos pr create --source-branch <CURRENT_BRANCH> --target-branch <base_branch> --title "<SPRINT_TITLE>"' then 'Or via the portal: Repos > Pull Requests > New Pull Request, source=<CURRENT_BRANCH>, target=<base_branch>'; do NOT HALT, do NOT attempt any other shell-out; SPRINT_PR_MAP[CURRENT_SPRINT] remains unset.
6. PR_BACKEND=='manual': print 'PR backend is manual — create this PR yourself:' then 'git push -u origin <CURRENT_BRANCH>' then 'gh pr create --title "<SPRINT_TITLE>" --base <base_branch>' (or the ADO CLI/portal equivalent if the remote is Azure DevOps); do NOT push or create the PR automatically; SPRINT_PR_MAP[CURRENT_SPRINT] remains unset. This prints at EVERY sprint boundary, not only the final one.
7. If STACKED_PRS=true AND more sprints remain: set NEXT_SPRINT=CURRENT_SPRINT+1; ensure currently on feature/<trd-slug>-sprint-<CURRENT_SPRINT> (git switch if needed); if BRANCHING_STRATEGY=='git-town': run git town append feature/<trd-slug>-sprint-<NEXT_SPRINT> [UNCHANGED]; if BRANCHING_STRATEGY=='plain-git': run git checkout -b feature/<trd-slug>-sprint-<NEXT_SPRINT> unconditionally (stacked directly off the currently-checked-out sprint branch — zero git town commands issued); set CURRENT_BRANCH=feature/<trd-slug>-sprint-<NEXT_SPRINT>; set CURRENT_SPRINT=NEXT_SPRINT; continue to next sprint
8. If STACKED_PRS=true AND no more sprints: print stacked PR summary with all SPRINT_PR_MAP entries (any sprint with no entry — PR_BACKEND=='manual', or 'ado' with the MCP tool absent that sprint — prints 'not auto-created — see manual instructions printed at that sprint boundary' instead of a URL); implementation complete
9. If STACKED_PRS=false: do NOT propose a PR or create a new branch per sprint. Stay on CURRENT_BRANCH=feature/<trd-slug> and continue to the next sprint's tasks. When NO more sprints remain: FINAL_TITLE="feat(<trd-slug>){{colon}} <trd-title>"; FINAL_BODY="Implements TRD <trd-slug>. All sprints complete.". Branch on PR_BACKEND (same four cases as above, target branch is <base_branch> / main, source branch is CURRENT_BRANCH): 'gh'+git-town runs git town propose [UNCHANGED]; 'gh'+plain-git runs git push -u origin <CURRENT_BRANCH> then gh pr create (standalone); 'ado' pushes then prefers the azure-devops MCP tool's repo_create_pull_request, else prints manual az repos pr create/portal steps and continues; 'manual' always prints manual push+PR instructions. When a URL is obtained: print 'Single PR created: <PR_URL>'. When none is obtained (manual, or ado with the MCP tool absent): print 'Single PR not auto-created — see manual instructions above'. implementation complete
