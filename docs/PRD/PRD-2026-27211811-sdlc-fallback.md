---
document_id: PRD-2026-27211811
label: prd-sdlc-fallback
version: 1.0.1
status: Draft
date: 2026-08-17
scale_depth: STANDARD
total_requirements: 17
readiness_score: 4.6
---

# PRD-2026-27211811: Graceful SDLC Fallback for implement-trd's Branching Strategy and PR Backend

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 13 |
| Should requirements | 4 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 17/17 (100%) |
| Risk flags | 7 |
| Cross-requirement dependencies | 11 |
| [NEEDS CLARIFICATION] markers | 0 |

**Source beads:** `br-fs1` and `br-n00` (both P1, bug) — found across two live ProgenyHealth sessions
(ClaimsImport, CRIBsFunctions, 2026-08-12 through 2026-08-17) running `implement-trd-beads` against a
real `dev.azure.com` remote on git-town v23.0.3.

## Product Summary

**Problem:** `implement-trd-beads.yaml`, `beads-build.yaml`, and `implement-trd.yaml` all assume a
GitHub-shaped, git-town-managed world with no escape hatch, at two separate points:

1. **Preflight (br-n00):** all three, plus the `git-workflow` agent, gate on
   `packages/git/skills/git-town/scripts/validate-git-town.sh`, which HALTs (exit 2) if
   `git-town.main-branch` isn't configured — and tells the user to run `git town config setup`, a
   command that does not exist in git-town v23 (`git-town config` only has `get-parent`/`remove`).
   The real entry point, `git town init`, is a full-screen interactive TUI with no non-interactive
   flags at all — confirmed live to hang indefinitely under an agentic command-execution path. There
   is currently no way for an unattended agent to get past this gate on its own, in *any* repo,
   supported forge or not, unless a human already ran `git town init` interactively beforehand. The
   git-town skill's own `SKILL.md` Quick Start compounds this with a second dead command
   (`git town config set-main-branch main`), and its `migration-git-flow.md` guide actively frames
   GitFlow as something to migrate *away from* — the opposite of what a GitFlow shop needs from this
   tool.

2. **PR creation (br-fs1):** `implement-trd-beads.yaml` (Quality Gate step 3, Completion step 3) and
   `implement-trd.yaml` (lines 130-133) unconditionally shell out to `git town propose`/`git town
   append` against the `PR_ACTIONS` plan produced by `packages/development/lib/pr-strategy.js`'s pure
   `planPrActions()`. git-town has no Azure DevOps forge driver at all (`forge-type` only accepts
   `github`/`gitlab`/`gitea`/`bitbucket`) — confirmed live: `git town propose --help` against a real
   ADO remote lists the supported hosts, and ADO isn't one. `beads-build.yaml` already sidesteps
   auto-invoking `git town propose` (it just prints a `gh pr create` reminder), but that reminder is
   still GitHub-CLI-specific — no help to an ADO user.

Per the workspace this was discovered in, ~87 of 89 repos are Azure-DevOps-hosted — this is the
default hosting story for the tool's real user base, not an edge case. The manual workaround used
live in ClaimsImport (push the branch, run `az repos pr create` by hand) is exactly the step this
feature should make automatic-or-instructed, not silent-and-undocumented.

**Solution:** Two independent, config-driven fallback axes, resolved fresh at Preflight on every
invocation:

- **Branching strategy** (`git-town` default, `plain-git` fallback) — auto-detected from git-town's
  installed/configured state, overridable via `ENSEMBLE_BRANCHING_STRATEGY`.
- **PR backend** (`gh` default, `ado`, `manual`) — auto-detection sniffs the origin remote for hosts
  git-town's `forge-type` cannot support (not "anything non-GitHub" — GitLab/Bitbucket/Gitea/Forgejo
  already work today via git-town's own driver), overridable via `ENSEMBLE_PR_BACKEND`.

git-town + `gh`-shaped behavior remains the unconditional default for every existing user — nothing
about today's happy path changes.

**Value proposition:** A developer on an enterprise SDLC that isn't git-town's default trunk-based
GitHub model — ADO plus a GitFlow-derived branching model, in the concrete case this was found in —
can run `implement-trd-beads`/`beads-build`/`implement-trd` end-to-end with zero manual git-town
setup and zero failed shell-outs, either automatically or via one env var.

**Target users:**
- **Developers on a non-git-town-default enterprise SDLC** — the primary persona: an ADO-hosted,
  GitFlow-variant shop today, but the mechanism generalizes to any team whose branching model or PR
  host git-town doesn't natively cover.
- **Existing git-town + GitHub users** — must see zero behavior change; they are the regression-risk
  audience, not a beneficiary of the new behavior.

**Non-goals (v1) — this is a deliberately narrow, short-term unblock:**
- **No general pluggable adapter/strategy-registry architecture.** This PRD hard-codes exactly two
  branching strategies (`git-town`, `plain-git`) and three PR backends (`gh`, `ado`, `manual`) — no
  plugin interface, no registry for hypothetical future backends. A follow-on "pluggable SDLC
  architecture" effort is expected to generalize this later; **the eventual PR opened against
  `Sunstone-Partners/ensemble` should explicitly reference that follow-on effort and frame this
  change as a short-term fix to get the team working while that broader scoping/planning happens
  separately** — not as the final architecture.
- **No GitFlow branch-topology modeling.** `plain-git` fallback creates feature branches off the same
  base branch git-town would have used (e.g. `main`) — it does not model `develop`/`release`/`hotfix`
  long-lived branches or retarget PRs at anything other than the existing configured base. Full
  branch-topology awareness is deferred to the future pluggable-architecture effort.
- **No work-item/tracker linking.** This PRD fixes PR *creation* only — auto-linking a created PR to
  an ADO work item, or any other tracker-integration behavior, is out of scope.
- **No new hard dependencies.** No fallback path requires installing the `az` CLI or any other new
  binary; the `ado` backend relies solely on the already-connected `azure-devops` MCP tool, falling
  back to printed manual instructions.
- **No retroactive rewriting** of already-created branches or already-opened PRs when config changes
  mid-TRD — reconciliation (REQ-015) is informational only.
- **`implement-bead.yaml` is unaffected.** It already implements its own silent
  git-town-hack-with-plain-git-fallback for branch creation (line 83) and never calls the broken
  Preflight gate script — it has neither bug.
- **The `git-workflow` agent is unaffected directly** — it only calls the shared
  `validate-git-town.sh` script and does no PR creation of its own, so it inherits the Preflight fix
  for free once the shared script changes.

## User Analysis

| Role | Pain today | After |
|---|---|---|
| Developer on ADO + GitFlow-variant SDLC (primary persona) | Hard-blocked at Preflight by a remediation command that doesn't exist, or reaches Quality Gate/Completion and watches `git town propose` fail against an unsupported host with no config escape hatch. | Preflight silently or automatically resolves a working branching strategy and PR backend (or is told the exact env var to set), and the run completes with zero manual intervention. |
| Existing git-town + GitHub user | N/A — current experience is the happy path. | Unchanged. Every new check is additive and defaults to today's behavior. |

**Success metric:** An ADO-hosted, GitFlow-variant shop runs `implement-trd-beads` (and
`beads-build`, `implement-trd`) end-to-end with no manual git-town setup and zero failed tool calls.

**Prior attempts, and why they weren't enough:** `beads-build.yaml` already stopped auto-invoking
`git town propose` at Completion, replacing it with a printed `gh pr create` reminder — but that
reminder is still GitHub-CLI-specific, so it doesn't help an ADO user either. The only real prior
mitigation is the manual workaround performed live in ClaimsImport (push the branch, run
`az repos pr create` by hand) — undocumented, unrepeatable, and invisible to anyone who hasn't hit
the wall once already.

## Goals and Non-Goals

**Goals:**
- git-town + GitHub/`gh`-shaped behavior is the unconditional default; zero regression for existing users.
- Preflight never hard-blocks on git-town's install/config state — it falls back instead.
- PR creation never assumes GitHub; it resolves a backend (`gh`/`ado`/`manual`) that actually works for the detected or configured host.
- Both axes (branching strategy, PR backend) are independently configurable via env vars, following the existing `ENSEMBLE_USE_STACKED_PRS` convention — no new config-file format.
- No new hard dependency is introduced by any fallback path.

**Non-Goals:** see Product Summary above.

## Requirements by Feature Area

### Backward Compatibility

#### REQ-001: Default behavior is unchanged for existing git-town + GitHub users
**Priority:** Must · **Complexity:** Low

When git-town is installed and configured (or `ENSEMBLE_BRANCHING_STRATEGY=git-town` is explicitly
set) and the origin remote is not a git-town-unsupported host (or `ENSEMBLE_PR_BACKEND=gh` is
explicitly set), `implement-trd-beads.yaml`, `beads-build.yaml`, and `implement-trd.yaml` behave
exactly as they do today — same commands, same output, no new prompts.

- AC-001-1: Given a repo with git-town installed and configured and a GitHub origin remote, when any of the three commands runs with no new env vars set, then it invokes `git town hack`/`propose`/`append` exactly as before and produces no new Preflight output.
- AC-001-2: Given the same setup, when compared against this feature's pre-implementation behavior, then no existing test in `packages/development/tests/` covering git-town happy-path behavior changes its expected output.

### Branching-Strategy Preflight Fallback

#### REQ-002: Preflight auto-detects git-town state and falls back without hard-blocking
**Priority:** Must · **Complexity:** Medium

Across `implement-trd-beads.yaml`, `beads-build.yaml`, and `implement-trd.yaml`, the Preflight
Git-Town Verification step is changed so that `validate-git-town.sh`'s exit codes 1 (not installed)
and 2 (not configured) never HALT the run. Not-installed falls back to the `plain-git` branching
strategy silently (no warning — this reflects the common case of git-town being present in name only,
installed on a recommendation but never adopted). Installed-but-unconfigured falls back to
`plain-git` after printing one warning. Exit codes 3 (version too old) and 4 (not a git repo) are
unaffected by this change.

- AC-002-1: Given git-town is not installed, when any of the three commands reaches Preflight, then it proceeds directly to branch resolution using the `plain-git` strategy with no warning printed and no HALT.
- AC-002-2: Given git-town is installed but `git-town.main-branch` is unset, when Preflight runs, then it prints exactly one warning and proceeds using the `plain-git` strategy — it does not HALT.
- AC-002-3 (end-to-end, mirrors the exact combined failure this was found in): Given an origin remote matching an unsupported host (REQ-007) and git-town either absent or installed-but-unconfigured, in a non-interactive session, when `implement-trd-beads` runs, then it reaches the Scaffold/Execute phase with zero HALTs on dead command text and zero attempted `git town propose` calls.

#### REQ-003: ENSEMBLE_BRANCHING_STRATEGY overrides auto-detection
**Priority:** Must · **Complexity:** Medium
**[RISK: an explicit git-town request can now HALT the entire run if git-town isn't ready — this must fail loudly and immediately at Preflight, not deep into execution]**

A new env var, `ENSEMBLE_BRANCHING_STRATEGY` (`git-town` | `plain-git`), takes precedence over
Preflight's auto-detected git-town state whenever set, following the same override-precedence pattern
already used for `ENSEMBLE_USE_STACKED_PRS`. An explicit `git-town` request is a stronger signal than
auto-detection: if git-town cannot actually be used — not installed, OR installed but unconfigured —
Preflight HALTs with instructions rather than falling back to `plain-git` the way REQ-002's
auto-detect path does. This is the one case where "never hard-block" (REQ-002) is deliberately
overridden: the user asked for git-town by name, so silently substituting something else would
contradict their explicit choice.

- AC-003-1: Given git-town is installed and fully configured, when `ENSEMBLE_BRANCHING_STRATEGY=plain-git` is set, then Preflight uses the `plain-git` strategy and invokes no git-town commands.
- AC-003-2: Given git-town is not installed, when `ENSEMBLE_BRANCHING_STRATEGY=git-town` is explicitly set, then Preflight does not silently fall back — it reports that the explicit choice cannot be honored and HALTs with instructions, rather than silently substituting `plain-git` against the user's explicit request.
- AC-003-3: Given git-town is installed but NOT configured (`git-town.main-branch` unset), when `ENSEMBLE_BRANCHING_STRATEGY=git-town` is explicitly set, then Preflight HALTs with instructions (e.g. "run `git town init`, or unset `ENSEMBLE_BRANCHING_STRATEGY` to auto-fallback") — it does NOT apply REQ-002's warn-and-fallback treatment, because the request was explicit.

#### REQ-004: plain-git branching strategy behavior
**Priority:** Must · **Complexity:** Medium
**[RISK: plain-git's branch topology must exactly match git-town's shape (single vs. stacked) or downstream phase-gate tracking (PHASE_BRANCH_MAP) breaks]**

When the `plain-git` strategy is active, all branch creation and switching (feature branch creation,
phase-gate `append`-equivalent transitions) uses plain git (`git checkout -b` / `git switch` / `git
push`) targeting the same base branch git-town would have used — zero git-town commands are invoked
anywhere in the run.

- AC-004-1: Given `plain-git` strategy is active and a phase-gate transition needs a new branch, when Preflight/Feature Branch Creation runs, then the branch is created via `git checkout -b`/`git switch -c` and no `git town` command appears in any executed command.
- AC-004-2: Given `plain-git` strategy is active, when the run completes, then the resulting branch topology (single branch or stacked branches, per `ENSEMBLE_USE_STACKED_PRS`) is identical in shape to what the `git-town` strategy would have produced — only the underlying commands differ.

#### REQ-005: Fix dead remediation text in validate-git-town.sh
**Priority:** Should · **Complexity:** Low

`validate-git-town.sh`'s exit-code-2 remediation text (`git town config setup`) is replaced with
accurate guidance: `git town init` is the real (interactive, optional) setup entry point, explicitly
noted as optional now that Preflight no longer requires it. The git-town `SKILL.md` Quick Start's
similarly dead `git town config set-main-branch main` reference is corrected in the same pass.

- AC-005-1: Given the corrected script and skill doc, when scanned for git-town command references, then every cited command exists in git-town v23's actual CLI surface (verified against `git-town --help` / `git-town config --help`).

### PR/Tracker Backend Selection and Fallback

#### REQ-006: ENSEMBLE_PR_BACKEND selects the PR-creation backend independently of branching strategy
**Priority:** Must · **Complexity:** Medium

A new env var, `ENSEMBLE_PR_BACKEND` (`gh` | `ado` | `manual`), controls how PRs are created,
independent of `ENSEMBLE_BRANCHING_STRATEGY`. Unset defaults to `gh` — today's behavior.

- AC-006-1: Given `ENSEMBLE_PR_BACKEND` is unset and the origin remote is not a git-town-unsupported host, when a phase-gate or Completion PR is due, then behavior is identical to pre-implementation (`git town propose` when `git-town` strategy is active).
- AC-006-2: Given `ENSEMBLE_BRANCHING_STRATEGY=plain-git` and `ENSEMBLE_PR_BACKEND=ado` are both set, when a PR is due, then the `ado` backend is used exactly as it would be under the `git-town` strategy — the two settings do not interact or constrain each other.

#### REQ-007: Auto-detect sniff targets git-town-unsupported hosts, not "non-GitHub"
**Priority:** Must · **Complexity:** Low

Preflight sniffs `git remote get-url origin` against a pattern of hosts git-town's `forge-type`
cannot support (currently: `dev.azure.com`, expressed as a matchable pattern, not a one-off hardcoded
string check). GitHub, GitLab, Bitbucket, and Gitea/Forgejo remotes are never flagged by this check —
git-town already serves those natively.

- AC-007-1: Given an origin remote on `dev.azure.com`, when Preflight's sniff runs, then it is flagged as an unsupported host.
- AC-007-2: Given an origin remote on `github.com`, `gitlab.com`, or a self-hosted Bitbucket/Gitea instance, when Preflight's sniff runs, then it is NOT flagged, and no prompt or HALT occurs on that basis.

#### REQ-008: Unsupported host + unset backend resolves via prompt or HALT, never silent guessing
**Priority:** Must · **Complexity:** Medium
**[RISK: must never silently guess a PR backend — a wrong guess produces a confusing failure far from its cause]**

When REQ-007's sniff flags the origin remote AND `ENSEMBLE_PR_BACKEND` is unset: in an interactive
session, prompt the user to resolve the backend before continuing (following the same
`AskUserQuestion` pattern already used for branch-intent resolution). In a non-interactive session,
HALT with the exact env var and value needed to resolve it, mirroring the existing non-interactive
branch-intent HALT pattern in `implement-trd-beads.yaml`. Because this env var is not persisted
anywhere by ensemble itself (same as `ENSEMBLE_USE_STACKED_PRS` today — the user sets it in their own
shell profile/CI config/repo `.env`), an unset var means this same prompt or HALT recurs on every
future invocation until the user does so; the prompt must therefore tell the user exactly what to set
to make it stop recurring.

- AC-008-1: Given an interactive session and a sniffed unsupported host with `ENSEMBLE_PR_BACKEND` unset, when Preflight runs, then the user is prompted with exactly four options — `ado`, `manual`, `proceed with gh anyway (not recommended)`, `abort` — before Feature Branch Creation proceeds. The "proceed anyway" option exists for advanced users with their own downstream workaround; it is never the default/recommended choice.
- AC-008-2: Given a non-interactive session and the same sniff result, when Preflight runs, then it HALTs and prints the exact `ENSEMBLE_PR_BACKEND=` value(s) that would resolve it, without attempting any PR-creation call.
- AC-008-3: Given either AC-008-1's prompt is answered or AC-008-2's HALT is printed, when the resulting message is shown, then it includes the exact `ENSEMBLE_PR_BACKEND=<value>` line the user can set in their own environment so this prompt/HALT does not recur on future invocations in this repo.

#### REQ-009: ado backend prefers the connected MCP tool, falls back to manual instructions
**Priority:** Must · **Complexity:** High
**[RISK: MCP server connectivity varies by session/environment — must degrade cleanly, never crash or hang]**

When `ENSEMBLE_PR_BACKEND=ado` (explicit or resolved via REQ-008), PR creation is attempted via the
already-connected `azure-devops` MCP tool (`repo_create_pull_request`) when available. When the MCP
tool is not connected in the current session, print exact manual steps (`az repos pr create ...` and
the equivalent ADO portal steps) instead of attempting any new hard CLI dependency.

- AC-009-1: Given the `azure-devops` MCP server is connected, when a PR is due under the `ado` backend, then the PR is created via `repo_create_pull_request` and its URL is recorded exactly as `git town propose`'s URL is recorded today (`PHASE_PR_MAP[N]` / `SINGLE_PR_URL`).
- AC-009-2: Given the `azure-devops` MCP server is NOT connected, when a PR is due under the `ado` backend, then exact manual PR-creation steps are printed and the run continues (does not HALT, does not attempt any `az`/`gh` shell call).

#### REQ-010: manual backend always prints instructions, never attempts automation
**Priority:** Must · **Complexity:** Low

When `ENSEMBLE_PR_BACKEND=manual`, PR creation always prints exact manual steps for the detected
host and never attempts any automated call (MCP or CLI).

- AC-010-1: Given `ENSEMBLE_PR_BACKEND=manual`, when a PR is due, then manual instructions are printed and no automated PR-creation call of any kind is attempted, regardless of which host is detected.
- AC-010-2: Given stacked PRs are enabled (`ENSEMBLE_USE_STACKED_PRS=true`, multiple phase-gate PRs due across the run), when `ENSEMBLE_PR_BACKEND=manual`, then manual instructions are printed at EACH phase-gate PR point as it comes due, not just once at Completion.

#### REQ-011: gh backend is a standalone implementation, independent of branching strategy
**Priority:** Must · **Complexity:** Medium
**[RISK: this stands up a second "create a PR via gh" code path alongside git-town's existing `propose` call — the two must stay behaviorally in sync (title/body format, PR-URL recording) or diverge silently over time]**

`ENSEMBLE_PR_BACKEND=gh` is implemented as a direct `gh pr create` call, not merely "whatever
`git town propose` already does" — so it works correctly when `ENSEMBLE_BRANCHING_STRATEGY=plain-git`
and no git-town is present at all. (This does not change how the `ado` backend works — ADO PR
creation never went through `git town propose` to begin with, since git-town has no ADO driver.)

- AC-011-1: Given `ENSEMBLE_BRANCHING_STRATEGY=git-town` and `ENSEMBLE_PR_BACKEND=gh` (or unset), when a PR is due, then behavior is unchanged from today (`git town propose`).
- AC-011-2: Given `ENSEMBLE_BRANCHING_STRATEGY=plain-git` and `ENSEMBLE_PR_BACKEND=gh` (or unset) on a GitHub remote, when a PR is due, then `gh pr create` is invoked directly and succeeds with no git-town command attempted anywhere in the process.

#### REQ-012: Quality Gate/Completion docs state resolved PR-backend behavior explicitly
**Priority:** Should · **Complexity:** Low

The Quality Gate and Completion phase step descriptions in all three commands state which backend
produced the PR and how, rather than assuming GitHub — matching br-fs1's suggested fix.

- AC-012-1: Given the regenerated YAML and markdown for all three commands, when scanned for Quality Gate/Completion PR-creation actions, then each names all three possible backends and their distinct behavior, not just the `gh`/git-town path.

### Consolidated Preflight Reporting

#### REQ-013: Preflight prints one consolidated resolution block, only when there's something non-default to report
**Priority:** Should · **Complexity:** Low

Rather than separate, disjoint print statements for branching-strategy detection and PR-backend
detection, Preflight prints a single block showing both resolved values and how each was determined
(env var / auto-detect fallback / prompt) — this is also the sole audit point for which
strategy/backend a given run used. **This block is suppressed entirely when both axes resolve to pure
defaults with no fallback, warning, override, or prompt involved** — REQ-001's zero-new-output
requirement for existing git-town + GitHub users takes precedence in that case; this requirement only
governs what happens once there IS something non-default to report, and unifies it into one message
instead of scattering it across REQ-002's and REQ-008's independent print statements.

- AC-013-1: Given git-town is installed/configured and the remote is not a sniffed-unsupported host, and no `ENSEMBLE_BRANCHING_STRATEGY`/`ENSEMBLE_PR_BACKEND` are set, when Preflight completes both resolutions, then no consolidated block (or any new output) is printed — matching AC-001-1 exactly.
- AC-013-2: Given at least one axis resolves to anything other than its pure default (a fallback fired, an override was set, or a prompt occurred), when Preflight completes both resolutions, then exactly one consolidated block is printed (not two separate messages), showing both values and each one's resolution source.

### Cross-Session Config Consistency

#### REQ-014: Config is re-resolved fresh on every invocation, including resumed TRDs
**Priority:** Must · **Complexity:** Medium
**[RISK: a resumed TRD's persisted branch/PR choices were made under whatever config was active at scaffold time — honoring current config instead may require reconciling in-flight state]**

Preflight's branching-strategy and PR-backend resolution runs on every invocation — it never reuses a
value cached from a prior session's persisted TRD choices (`choices-read`/`choices-write`:
`branch_name`, `use_proposed`, `stacked_prs`).

- AC-014-1: Given a TRD scaffolded under `git-town`/`gh` defaults and resumed after `ENSEMBLE_BRANCHING_STRATEGY=plain-git` is set repo-wide, when the resumed run reaches Preflight, then it resolves and uses `plain-git` for this run, not the strategy in effect when the TRD was first scaffolded.
- AC-014-2: Given no config change between scaffold and resume, when a TRD resumes, then resolution produces the identical strategy/backend as the original run (no spurious drift).

#### REQ-015: Resuming under changed config prints an explicit reconciliation notice
**Priority:** Should · **Complexity:** Medium

When a TRD's persisted branch/PR choices were made under a different strategy/backend than what's
now active, print an explicit notice describing what changes going forward (future phase-gate/
completion actions use the new resolution) — already-created branches and already-opened PRs are
never retroactively modified.

- AC-015-1: Given the REQ-014-1 scenario, when the reconciliation notice prints, then it names both the prior and current resolution and states explicitly that existing branches/PRs are unaffected.

## Non-Functional Requirements

#### REQ-016: No new hard dependency introduced by any fallback path
**Priority:** Must · **Complexity:** Low

No fallback path (branching-strategy or PR-backend) requires installing a new binary. `plain-git`
uses only git itself; `ado` uses the already-connected MCP tool or prints instructions; `gh` continues
to rely on the `gh` CLI exactly as it does today (no new requirement introduced).

- AC-016-1: Given a clean environment with only git and (optionally) `gh` installed — no `az` CLI, no git-town — when any fallback path is exercised, then the run does not fail due to a missing binary that this feature would have newly required.
- AC-016-2: Given `gh` is NOT installed (a pre-existing dependency of the `gh` backend, not a new one introduced here) and `ENSEMBLE_PR_BACKEND` resolves to `gh`, when a PR is due, then a clear "`gh` CLI required for the `gh` backend" message is reported instead of a raw shell "command not found" error.

#### REQ-017: No path ever blocks on interactive input in a non-interactive session
**Priority:** Must · **Complexity:** Medium
**[RISK: this is br-n00's exact original failure mode — a TUI hang under an agentic execution path — regressing it would reintroduce the bug this PRD exists to fix]**

Every new detection, fallback, and prompt path checks interactive-session availability the same way
existing branch-intent resolution does (`INTERACTIVE=true/false`) before ever prompting — no new path
introduced by this feature can block waiting for a keypress or unanswered `AskUserQuestion` in a
non-interactive session.

- AC-017-1: Given a non-interactive session with git-town unconfigured and an ADO remote (the exact combination that hung previously), when the run executes, then it completes (or HALTs with printed instructions) within normal command latency — it never invokes `git town init` or waits on stdin.
- AC-017-2: Given interactive-session detection itself is uncertain (e.g. no TTY and no `AskUserQuestion` tool available, but not cleanly `INTERACTIVE=false` either), when any prompt-eligible decision point (REQ-003's HALT, REQ-008's backend prompt) is reached, then it defaults to the non-interactive HALT-with-instructions path rather than risking a hung prompt.

## Acceptance Criteria Summary

| REQ | Description | Priority | Complexity | ACs |
|---|---|---|---|---|
| REQ-001 | Default behavior unchanged for existing git-town + GitHub users | Must | Low | 2 |
| REQ-002 | Preflight auto-detects git-town state, falls back without hard-blocking | Must | Medium | 3 |
| REQ-003 | ENSEMBLE_BRANCHING_STRATEGY overrides auto-detection | Must | Medium | 3 |
| REQ-004 | plain-git branching strategy behavior | Must | Medium | 2 |
| REQ-005 | Fix dead remediation text in validate-git-town.sh / SKILL.md | Should | Low | 1 |
| REQ-006 | ENSEMBLE_PR_BACKEND selects PR-creation backend independently | Must | Medium | 2 |
| REQ-007 | Auto-detect sniff targets git-town-unsupported hosts only | Must | Low | 2 |
| REQ-008 | Unsupported host + unset backend resolves via prompt or HALT | Must | Medium | 3 |
| REQ-009 | ado backend prefers MCP, falls back to manual instructions | Must | High | 2 |
| REQ-010 | manual backend always prints instructions | Must | Low | 2 |
| REQ-011 | gh backend is standalone, independent of branching strategy | Must | Medium | 2 |
| REQ-012 | Quality Gate/Completion docs state resolved backend explicitly | Should | Low | 1 |
| REQ-013 | Single consolidated Preflight resolution block, only when non-default | Should | Low | 2 |
| REQ-014 | Config re-resolved fresh on every invocation, incl. resume | Must | Medium | 2 |
| REQ-015 | Reconciliation notice on resume under changed config | Should | Medium | 1 |
| REQ-016 | No new hard dependency introduced | Must | Low | 2 |
| REQ-017 | No path blocks on interactive input non-interactively | Must | Medium | 2 |

## Dependency Map

| REQ | Depends on | Notes |
|---|---|---|
| REQ-002 | — | Foundational Preflight change; ships first. |
| REQ-003 | REQ-002 | Override precedence is only meaningful once auto-detection (REQ-002) exists; when git-town is explicitly requested but unusable (absent or unconfigured), REQ-003 overrides REQ-002's warn-and-fallback with a HALT instead. |
| REQ-004 | REQ-002, REQ-003 | Defines what "plain-git" actually does once either path selects it. |
| REQ-005 | REQ-002 | Doc fix references the same script REQ-002 changes; ship together to avoid re-drift. |
| REQ-007 | — | Independent of the branching-strategy cluster; can ship in parallel. |
| REQ-008 | REQ-006, REQ-007 | Needs both the backend env var and the sniff to exist first. |
| REQ-009 | REQ-006 | Implements the `ado` value REQ-006 defines. |
| REQ-010 | REQ-006 | Implements the `manual` value REQ-006 defines. |
| REQ-011 | REQ-004, REQ-006 | Must work under `plain-git` (REQ-004), implementing the `gh` value REQ-006 defines. |
| REQ-012 | REQ-009, REQ-010, REQ-011 | Docs describe behavior that must exist first. |
| REQ-013 | REQ-002/003 (branching resolution), REQ-006/007/008 (backend resolution) | Consolidates both axes' output into one message. |
| REQ-014 | REQ-002, REQ-006 | Applies fresh-resolution requirement to both axes. |
| REQ-015 | REQ-014 | Reconciliation notice only applies when REQ-014 detects a drift. |
| REQ-016, REQ-017 | (cross-cutting) | Apply to every fallback path above; verified alongside each, not shipped as separate code. |

No circular dependencies.

## Constraints and Delivery Notes

- Edit the YAML sources (`implement-trd-beads.yaml`, `beads-build.yaml`, `implement-trd.yaml`,
  `validate-git-town.sh`, git-town `SKILL.md`), then run `npm run generate` to regenerate the derived
  markdown/Codex artifacts — both must change together, matching this repo's generated-artifact
  convention.
- New env vars (`ENSEMBLE_BRANCHING_STRATEGY`, `ENSEMBLE_PR_BACKEND`) follow the existing
  `ENSEMBLE_USE_STACKED_PRS` convention and must be added to `docs/guides/environment-variables.md`.
- Branch off `main`, not `dev` (`dev` is local dogfood aggregation, never a PR head); PR targets
  `Sunstone-Partners/ensemble` `main`. Separately merge the same branch into `dev` for local
  dogfooding — that merge never substitutes for the upstream PR.
- **The PR description must explicitly frame this as a short-term unblock**, referencing that a
  broader pluggable-SDLC-architecture effort (generalized strategy/backend registry) is being scoped
  and planned separately, and that this change intentionally does not preempt that design.
- No new hard dependencies (REQ-016) — the `ado` backend must not require installing the `az` CLI.

## Testability Note

REQ-002's AC-002-3 and REQ-017's AC-017-1 both directly reproduce the exact combined failure the
source beads were filed against (ADO remote + git-town unconfigured/absent, non-interactive session,
previously observed to hang indefinitely on `git town init`'s TUI). These are the two ACs that most
directly validate the stated success metric — everything else decomposes that scenario into
independently testable pieces.

## Readiness Scorecard

| Dimension | Score | Notes |
|---|---|---|
| Completeness | 4.75 | Covers both source beads' root causes, the `implement-trd.yaml` scope gap, the doc-accuracy defects, and (after refinement) the REQ-002/REQ-003 explicit-override interaction that was previously unaddressed. Tracker/work-item linking and full GitFlow topology remain explicitly deferred, not silently missing. |
| Testability | 4.75 | Every AC is now a runnable, observable assertion; the three Must requirements previously under the 2-AC minimum (REQ-010, REQ-016, REQ-017) each gained a concrete edge-case AC. |
| Clarity | 4.5 | The one [NEEDS CLARIFICATION] marker (REQ-008 prompt options) is resolved to a concrete four-option set; reconciliation-notice (REQ-015) exact wording remains implementation judgment, which is a reasonable altitude to leave open. |
| Feasibility | 4.5 | Unchanged — reuses existing seams (`pr-strategy.js`'s pure planner, the `ENSEMBLE_USE_STACKED_PRS` env-var pattern, the existing `AskUserQuestion`/non-interactive-HALT pattern for branch intent) — no new architecture, no new dependency. |
| **Overall** | **4.6** | **PASS** (up from 4.4) |

## Changelog

- **v1.0.1 (2026-08-17)** — `/ensemble:refine-prd` pass: resolved the REQ-008 `[NEEDS CLARIFICATION]` marker (prompt now offers `ado`/`manual`/`proceed with gh anyway (not recommended)`/`abort`); closed the REQ-002/REQ-003 scope gap for an explicit `git-town` request that's installed-but-unconfigured (now HALTs, new AC-003-3); added the missing second AC to the three under-covered Must requirements (REQ-010, REQ-016, REQ-017); added risk indicators to REQ-003, REQ-004, and REQ-011; corrected stale PRD Health summary counts (Must 12→13, Should 5→4, risk flags 3→7, clarification markers 1→0). Readiness 4.4 → 4.6.

## Next Step

```
/ensemble:create-trd docs/PRD/PRD-2026-27211811-sdlc-fallback.md
```
