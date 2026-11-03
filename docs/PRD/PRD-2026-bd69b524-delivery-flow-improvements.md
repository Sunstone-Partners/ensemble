---
document_id: PRD-2026-bd69b524
label: prd-delivery-flow-improvements
version: 1.0.0
status: Draft
date: 2026-10-27
scale_depth: DEEP
total_requirements: 48
readiness_score: 4.0
design_readiness_score: null
---

# PRD-2026-bd69b524: Delivery-Flow Improvements Baked into Ensemble

## PRD Health Summary

- **Risk flags:** REQ-003, REQ-005, REQ-008, REQ-009, REQ-011, REQ-016, REQ-018, REQ-023, REQ-027
- **Dependencies:** 64 cross-requirement dependencies (see Dependency Map)
- **Unresolved clarification markers:** 6
- **Constitution compliance:** passed (`docs/standards/constitution.md`, Non-Negotiable Rules 1-9)

## Product Summary

**Problem:** In four days (2026-10-23 to 2026-10-27) the Foreman repository merged 46 PRs, and the measured limit on delivery was waiting for a human, not building or CI. Of 96.5 calendar hours, workers were alive 28.3 h (29%), the orchestrator was blocked on a question 21.2 h (22%), the owner was away or between turns 26.5 h (27%), the orchestrator worked alone 15.9 h (16%) and waited on CI with no worker 4.7 h (5%) (Review sec. 1). 63% of PR wall time (2,074 of 3,299 min) was green and unmerged, 44 of 46 PRs were merged by hand, and the CI cycle of about 11 min was not the long pole (Review sec. 1, 2.1). On 2026-10-27 the owner changed the Foreman repository by hand: required checks with auto-merge, bot review made advisory, private test databases per agent, one branch and one PR per workstream, the ledger flushed once by the parent, no retry or quarantine of flaky tests, and no blocking questions on reversible decisions. Ensemble's commands, skills, agents and documents still encode the old defaults: a human merges (`implement-trd-beads` says only a human confirming the merge may call a PR merged), every agent flushes the ledger, confirmation prompts block reversible actions, review waits on a remote service per push, there is no CI guidance and flow is not measured.

**Who feels it:** owners and maintainers of projects managed with ensemble (first the Foreman owner), orchestrating and worker agents, dispatchers that run ensemble skills unattended (Foreman), and ensemble maintainers who keep four runtimes consistent.

**Solution:** bake the measured improvements into ensemble in six forms: (1) defaults in the PR-producing and orchestration commands (auto-merge armed, a hand-off report, one branch and one PR per workstream, a single-writer ledger, time-boxed investigations); (2) three read-only checks (flow doctor, CI conformance audit, ledger audit) and a definition-of-done check; (3) editable policy skills (review, flaky tests, live verification, gates and interrupts); (4) guard rules where a runtime supports hooks and audits where it does not; (5) stack profiles that carry every stack-specific CI detail; (6) a repeatable flow report that also produces an owner digest.

**Headline outcome:** a whole workstream completes, is verified and merges with no human in the loop; the owner reviews finished work in batches through a digest; a closed list of conditions is the only thing that may interrupt the owner; CI time is the only machine-bound cost left. After hands-off merge removes the green-and-unmerged 63% and the interrupt policy removes blocked questions, the remaining ceiling is the owner's availability, so the owner's attention is spent on batches and not on individual PRs.

**Success:** measured by the table under Success Measures. No target is claimed met until a post-change cohort of 20 merged PRs exists (REQ-042).

**Source:** the Foreman delivery-flow process review ("Process review: Claude Projects parity, 2026-10-23 -> 10-27", read-only; sources: 46 merged PRs #633-#679, 175 CI runs, 20 job logs, branch protection, the ledger and 61 session transcripts), held by the owner at `/tmp/process-review.md` at authoring. Citations of the form "Review sec. N" and "Review R1" refer to its numbering: sec. 1 summary, sec. 2.1-2.8 measurements, R1-R12 ranked recommendations in sec. 3, sec. 4 quality-versus-overhead table, sec. 5 open questions. See OQ-7 on archiving it.

**Decisions already taken by the owner (not reopened here):**

- The Foreman base branch requires its three CI checks (non-strict, no required approvals, administrators enforced, linear history) with auto-merge and delete-branch-on-merge on (Review sec. 2.7).
- Bot auto-review and the changes-requested workflow are off in the Foreman repository (PR #679, merged).
- Sub-agents run with private test databases, one branch and one PR per workstream, a local gate and then auto-merge; beads are in_progress only while worked and are closed with evidence; the ledger is flushed once by the parent.
- Blanket retry and quarantine of flaky tests is rejected: a flaky test is a bug to fix at the root.
- `ask` is no longer used to block on reversible decisions.

These were recorded by the owner on 2026-10-27; the rule text was not yet in the Foreman main checkout's `AGENTS.md` at authoring.

**Out of scope (Won't, this release):** a durable scheduler, daemon, watchdog, retry or recovery inside ensemble; flaky-test retry, quarantine or skip; replacing or tuning a review service; automatic changes to repository or branch-protection settings; a dashboard or hosted service; changes to the Foreman repository; CI templates for hosts other than GitHub Actions [INFERENCE: the review's design and the doctor are GitHub-shaped]; any new constitution rule.

## Relationship to Other Documents

- **Builds on** PRD-2026-4dec59b8 (local-CI PR approval): it already makes bot reviews non-blocking, binds approval to the exact head commit and forbids a second dispatcher. This PRD arms auto-merge on whatever required context the repository defines (on ensemble's own `dev`, the unpinned `ensemble/local-ci` status), adds the doctor and the digest, and reuses its REQ-006, REQ-008 and REQ-012.
- **Relaxes in part** PRD-2026-82b6a138 (PR review cycle time): its head-bound remote-review status (`REVIEW_COMPLETE` requires a review of the current head) stays as reporting but no longer gates merge, and the local pre-publication review and finding ledger stay. A follow-up refine of that PRD records the change.
- **Depends on** PRD-2026-8d825f54 (tool abstraction layer): the new host capabilities (arm auto-merge, read protection settings) are optional and additive in the `host` contract with an explicit unavailable outcome, and the GitHub adapter allowlist change is security-sensitive.
- **Follows** PRD-2026-87e64cc6 (command surface consolidation): a new entry point follows the task-oriented front-door pattern (REQ-003).
- **Uses** PRD-2026-023 and PRD-2026-024 (beads workstream and refine-beads) for the ledger vocabulary.
- **Interfaces with** the Foreman repository's completed PRD-2026-3d41f677 (managed execution contract), REQ-020 to REQ-023 being the ensemble side of that contract.
- **Does not edit** `docs/standards/constitution.md`, which is a protected path (OQ-12).

## Transferable Policy and Stack-Specific Parameters

The review measured one repository on one stack. The requirements below are written so that the left column applies to any ensemble-managed project, and the right column is Foreman-shaped mechanics that become stack-profile parameters and worked examples (REQ-006), never universal rules.

| Transferable requirement | Foreman-shaped mechanics (profile parameters and examples) |
|---|---|
| Required checks plus auto-merge, non-strict; the flow doctor (REQ-001 to REQ-005) | Base branch `main`; the check names `foreman_server`, `jido_harness`, `foreman_cli`; AutoPR owning PR creation |
| Cache keys include toolchain identity and lockfile identity (REQ-007) | OTP and Elixir versions from the setup action, `mix.lock`, `deps` and `_build` caches |
| An aggregate required context over partitions where the runner supports them (REQ-008) | `mix test --partitions 4`, `MIX_TEST_PARTITION`, one Postgres service per leg |
| Docs-only skip by job-level conditions with explicit non-code and tests-read lists (REQ-009) | Foreman's lists (`docs/user-guide.md`, `docs/cli-reference.md`, `CLAUDE.md`, `README.md`, `AGENTS.md` are read by tests) |
| Per-test timing visibility and superseded-run cancellation (REQ-010) | `--slowest 25`; dropping `--cover` from PR runs |
| Stack-neutral CI audit (REQ-011) | A dialyzer PLT cache for the `jido_harness` job |
| Private resources per agent within shared limits (REQ-016) | Postgres `max_connections` 100, test `pool_size` 30, `TEST_DB_POOL_SIZE` |
| Review once per workstream on product code (REQ-012 to REQ-014) | CodeRabbit knobs: `request_changes_workflow`, `path_filters`, the 300-file limit |
| Replay handle and root-cause recipe (REQ-034, REQ-035) | ExUnit `--seed N`, `ProjectionLeakGuard` as the guard-only class |
| Ledger states, claims, evidence, single writer, audit (REQ-024 to REQ-028) | `br` and `bv` (beads) as the default tracker; `foreman-exec` dispatch label |
| Closed interrupt list, no blocking on reversible gates, digest (REQ-029 to REQ-032, REQ-040) | OMP `ask` tool and a user-level consent-gate skill |
| Two-hour time box, evidence first (REQ-018) | The FlowStep3Diagnose, azc2o and ResumeFlake investigations |

## User Analysis

| Role | Pain today | What this PRD gives them |
|---|---|---|
| Repository owner (here also the Foreman owner) | The pipeline waited on the owner: 44 of 46 merges by hand, 18 blocking questions, status audits assembled by hand | Hands-off merge, a closed list of interrupts, review in batches from one digest |
| Maintainer adopting ensemble on another stack | Rediscovers merge settings, CI shape and ledger rules by incident | A flow doctor, a CI audit with stack profiles and shipped policy skills |
| Orchestrating agent | Waits on green PRs, merges for workers, re-verifies their work, blocks on questions | A hand-off contract, state-read verification and an interrupt policy |
| Worker agent | Collides on shared test resources and the ledger, loops on investigations | Private resources, a single-writer ledger, a time box and an evidence-first rule |
| Dispatcher (Foreman) and its operator | Skills differ on `--foreman`, scheduling fallbacks and PR creation | One integration contract verified against both repositories |
| Reviewer (human or bot) | A review per push that blocks, goes stale or is skipped by quota | One review per workstream on the aggregate diff, gating only on defects |
| Ensemble maintainer | Four runtimes to keep consistent; rules that live only in prompts | Sources-first changes, guards plus audits and conformance checks |

**User stories** (each is satisfied by the acceptance criteria it cites):

| Story | As a | I want | So that | Done when |
|---|---|---|---|---|
| US-01 | Repository owner | a workstream to complete, be verified and merge with no human action | my availability is not the pipeline's ceiling | AC-001-1, AC-002-1, AC-015-1; 20 consecutive PRs with green required checks merge with no human action |
| US-02 | Repository owner | to review finished work in batches from one digest | I read evidence once instead of chasing each PR | AC-040-1, AC-040-2, AC-040-3 |
| US-03 | Repository owner | to be interrupted only for a closed list of reasons | a question with an obvious reversible default never idles the pipeline overnight | AC-029-1, AC-029-2, AC-030-1, AC-030-2, AC-030-3, AC-032-1 |
| US-04 | Maintainer adopting ensemble | one check that says whether my host allows hands-off merging | I fix settings once instead of finding a stuck PR | AC-003-1, AC-003-2, AC-003-3, AC-005-1 |
| US-05 | Maintainer of a slow CI | stack-profile templates and an audit | a stale cache, a renamed required context or a retry wrapper never costs days | AC-006-1, AC-007-1, AC-008-1, AC-009-1, AC-011-1 |
| US-06 | Maintainer | automated review once per workstream that gates only on defects | valid findings in product code are fixed and nits cost no review round | AC-012-2, AC-013-1, AC-013-2, AC-014-1 |
| US-07 | Orchestrating agent | dispatch rules and a fixed hand-off | workers do not collide and I verify claims by reading state | AC-015-1, AC-016-1, AC-018-1, AC-019-3 |
| US-08 | Worker agent | a hand-off shape and a single-writer ledger rule | my work is reported once and never conflicts on the ledger | AC-019-1, AC-024-2, AC-027-1 |
| US-09 | Dispatcher operator | skills that honor the dispatcher contract | `--foreman` runs never prompt, never fall back to a second scheduler and never open a second PR | AC-020-1, AC-021-1, AC-022-1 |
| US-10 | Owner reading the ledger | statuses that match reality and an audit that proves it | in_progress means someone is working it now | AC-024-1, AC-025-1, AC-028-1 |
| US-11 | Developer with a failing test | a replayable record and a recipe | I fix the root cause without retry or quarantine | AC-033-2, AC-034-1, AC-035-1 |
| US-12 | Maintainer judging the change | a repeatable flow report with a baseline | I can tell whether the improvements worked | AC-039-1, AC-042-1 |

## Goals and Non-Goals

**Goals:**

- A whole workstream completes, is verified and merges with no human in the loop (REQ-001 to REQ-005, REQ-015, REQ-019, REQ-038).
- The owner reviews in batches through a digest and is interrupted only by a closed list of conditions (REQ-029 to REQ-032, REQ-040).
- CI time is the only machine-bound cost left: stale caches, superseded runs, docs-only runs and serial test time are removed through stack-profile templates and an audit (REQ-006 to REQ-011).
- Review cost is proportional to defects found: one review per workstream, gating only on defects in product code (REQ-012 to REQ-014).
- Multi-agent runs do not collide on resources, the ledger or time (REQ-015 to REQ-019, REQ-027).
- Ensemble skills honor one dispatcher contract verified against the Foreman repository (REQ-020 to REQ-023).
- The ledger tells the truth (REQ-024 to REQ-028) and test failures are fixed at the root with replayable evidence (REQ-033 to REQ-035).
- Every claim of improvement is measured by a repeatable report that never claims a target on thin data (REQ-039 to REQ-042).

**Non-Goals:**

- No durable scheduler, daemon, watchdog, retry or recovery in ensemble (constitution rule 4). Foreman owns durable activation, retries, recovery and its own operator merge gate.
- No flaky-test retry, quarantine, skip, wider timeout or weaker assertion anywhere (REQ-033).
- No replacement for, tuning of, or new provider of automated review.
- No automatic change of repository or branch-protection settings: the doctor reads and explains.
- No dashboard or hosted service: the digest is a file.
- No change to the Foreman repository: its adoption is its own rollout, and REQ-020 to REQ-023 are only the ensemble side of the contract.
- No amendment of the constitution in this PRD (OQ-12).

## Success Measures

Baselines are the Foreman window of 2026-10-23 to 2026-10-27 unless noted. Targets marked [INFERENCE] were chosen by this PRD and need owner confirmation (OQ-11). No target is claimed met before the cohort rule of REQ-042.

| Measure | Baseline | Target | Requirements |
|---|---|---|---|
| PRs merged with no human action | 2 of 46 (4%) | at least 90% of PRs whose required checks pass; 0 manual merges in the first 20 PRs | REQ-001, REQ-002, REQ-004 |
| Idle-green share of PR wall time | 63% (2,074 of 3,299 min); median PR 22 min, p90 98 | median idle under 2 min; idle-green at most 5% of PR wall time; median created-to-merged about 14 min (review estimate, R1) | REQ-001 to REQ-005, REQ-041 |
| Orchestrator time blocked on questions | 18 questions, 22.3 h (21.2 h, 22% of calendar); 2 overnight questions, 19.8 h | 0 questions on reversible gates; every interrupt in the closed list and counted | REQ-029 to REQ-032 |
| Owner prompts asking what an agent is waiting for | 5 of 77 prompts | 0 per week; a digest for 100% of completed batches | REQ-040 |
| Longest stretch with no worker alive while work waited | 30.2 h (10-24T10:06 to 10-25T16:17) | none over 2 h while ready work exists [INFERENCE]; measured only where session data exists | REQ-029, REQ-030, REQ-039 |
| CI cycle of the largest job (Foreman example) | median 11.1 min, p90 16.7 | p90 at most 5 min (review estimate 4-4.5 min with 4 partitions, not run) | REQ-006 to REQ-008, REQ-010 |
| CI runs completing on superseded commits | 23 runs, 6.3 runner-h | 0 | REQ-010 |
| Stale dependency-cache regression | 71 of 160 sampled runs, +7 min each | 0 workflows with a toolchain-less cache key in the audit | REQ-007, REQ-011 |
| Non-code PRs run through heavy jobs | 10 of 46 PRs, 111 server-job min | 0 heavy-job minutes; a ledger-only PR merges in under 3 min (R6) | REQ-009 |
| Red required-job runs | 9.8% (12 of 123), 10 of them flakes | at most 3% (R5 target), every red recorded with test, handle and class, and 0 retries, quarantines or skips added | REQ-033, REQ-034 |
| Bot-review friction | 16 manual dismissals; 574 min of review loops; 245 min waiting on quota; 2 of 10 valid findings unfixed | 0 manual dismissals; at most one aggregate review per workstream; every valid finding fixed or tracked | REQ-012, REQ-013 |
| Investigations over 2 h without a recorded decision | 8 workers ran 2 h or more (311 min, 5.2 h and 5.5 h cases) | 0 | REQ-018 |
| Shared-resource exhaustion | 9 connection-limit failures in 6 agents | 0 | REQ-016 |
| Ledger accuracy | 60% wrong status (58 of 97 non-closed); 18 of 64 closed before merge; median closure lag 53.5 h; 63% of closures in six same-minute batches | wrong status at most 5%; 0 closed before merge; at least 90% closed within 24 h of merge; 0 bulk closures without per-bead evidence [INFERENCE] | REQ-024 to REQ-028, REQ-038 |
| Worktree and branch debt | 155 local branches, 18 worktrees, 53 remote branches; a 41.5 h triage stretch | 0 merged local branches after each batch; at most 1 triage session per week (R9) | REQ-017 |
| Live verification yield | 19.6 agent-h over 9 workstreams, 5 product defects | every live item names its defect class; evidence summary at most 50 lines | REQ-036, REQ-037 |
| Dispatcher contract conformance | 11 of 12 dispatchable commands declare `--foreman`; 1 PR-creating skill ignores dispatcher ownership | 12 of 12; 0 skills create a dispatcher-owned PR | REQ-020 to REQ-022 |
| Measurement | baseline assembled by hand from 46 PRs, 175 runs and 61 transcripts | one repeatable report; unmeasured items listed | REQ-039, REQ-042 |

Read together, the first five rows say the owner is no longer on the critical path, and the next four say that what remains is CI time.

## Research Context

*Context only; requirements do not depend on these tools by name.* Facts below were read from the repositories and the host at authoring (2026-10-27) unless marked [INFERENCE].

### Observed ensemble facts

- **Host settings** (read with `gh api`): the repository is public; auto-merge is permitted, delete-branch-on-merge is off, and squash, merge and rebase are all allowed. `dev` requires the single unpinned context `ensemble/local-ci` (non-strict, no required reviews, administrators enforced, no linear history). `main` requires `release-gate` and `source-branch` (strict, zero approvals with stale-review dismissal, administrators enforced) and is the distribution channel (`.github/workflows/release-gate.yml`).
- **Merge flow:** `/ensemble:pr-merge` (v2.1.0) decides on a verified local-CI status for the exact head, does not wait for hosted CI, treats bot reviews as non-blocking and a human CHANGES_REQUESTED as blocking, dispatches one subagent per finding for up to 5 rounds, and merges through `host.change-request-merge` after a confirm prompt unless `--foreman`. No ensemble command arms auto-merge.
- **GitHub host adapter** (`packages/git/skills/adapter-host-github/`): the allowlist has `pr create`, `pr view`, `pr list`, `pr checks`, `pr merge`, `auth status`, `api graphql` and `--version`; REST `api` is blocked; merge maps squash, merge and rebase only; create and merge were never executed live. The `host` contract is version 1.0 and additive-only (`docs/toolchain/contracts/host.md`).
- **PR-producing and orchestration commands:** `implement-trd-beads` v3.1.0 opens stacked PRs only when `ENSEMBLE_USE_STACKED_PRS` is true and otherwise one PR, and treats remote review status as informational; `beads-build` v1.4.0 never creates a PR; `beads-build-wave` v1.3.0 dispatches 3 tracks concurrently by default, creates no per-track worktree and refuses to run on the default branch; `tech-lead-orchestrator` in bead-track mode claims, closes and flushes the ledger itself.
- **Guards** (`packages/guards` 5.2.1): `protected-branch`, `bypass-flags`, `br-close-reason` (a non-empty reason only) and an opt-in `dod` stop gate, as Claude Code hooks, failing open on any internal error, configured in `.ensemble/guards.json`. **Telemetry** (`packages/telemetry` 5.2.1) is opt-in and records a timestamp, a session id, a kind and a name only.
- **Measurement building blocks:** `packages/development/lib/local-ci-baseline.js` (fail-closed cohort statistics, `unproven` unless every condition is proven), `local-ci-timing.js`, `estimate-actual.js` and `/ensemble:retro` v2.0.0 ("every number comes from a command you ran"), and `docs/guides/pr-review-cycle-time-pilot.md` (read-only `gh` queries).
- **Ledger tooling:** `br` 0.6.0 provides `stale`, `orphans`, `lint`, `coordination status` and `doctor`, and a closure-policy file honoured by `br close` (`--bypass-policy` works only when `.beads/policy.yaml` allows it). The beads adapter normalizes `deferred` to `open` and `in_review` to `in_progress`.
- **Ensemble's own CI:** `test.yml` is a Node 22 and 24 matrix with `npm ci`, no dependency cache and no concurrency group; `validate.yml` is the same; 5 of 17 workflows have a concurrency group and none uses a dependency cache. The local-CI approval set (`.ensemble/local-ci.yaml`) is `validate` plus `test` on Node 22 and 24, and the status is posted with the maintainer's own `gh` login.

### Dispatcher integration contract (verified at authoring)

| Pin | Foreman side | Ensemble side | State today |
|---|---|---|---|
| IC-1: dispatcher calls skills as `/skill:<name> <args> --foreman`; the flag means non-interactive, with the report path in `FOREMAN_ARTIFACT_PATH` | `packages/foreman_server/priv/defaults/workflows/implement-trd-beads.yaml:39`, `implement-trd.yaml:38`, `prd.yaml:46-60` | `packages/development/commands/implement-trd-beads.yaml:51-58`, `packages/product/commands/create-prd.yaml:13-25`; non-interactive triggers in `packages/development/lib/toolchain-cli.js` header | 11 of 12 dispatchable command sources declare the flag; `beads-build.yaml` does not (`:27` omits it, only mention `:93`) |
| IC-2: `bv --robot-plan` is the only scheduler; never `br ready`; no degraded path | Foreman's completed PRD-2026-3d41f677 AC-017-1 assumes the skill selects from a global `bv --robot-plan` result; Foreman's own task provider reads `br ready` for dispatch (completed PRD-2026-48f7b420, REQ-011), a separate concern from in-run scheduling | `adapter-tracker-beads/adapter.yaml:277,292`; `beads-build.yaml:67`; `beads-build-wave.yaml` Step 2 | the wave-runner agent brief still says bv is optional and falls back to `br ready` (`packages/development/agents/beads-build-wave.yaml`) |
| IC-3: `br sync --flush-only` before every `bv` call, for cross-session resumability | Foreman's watcher re-reads the exported JSONL from scratch on each event (`docs/user-guide.md`, Inbound sync) | `beads-build-wave.yaml` Step 1, `beads-build.yaml:191,202` | the flush exists but is "optional; skip silently" on failure |
| IC-4: a skill never creates the PR; Foreman's AutoPR owns it | `packages/foreman_server/lib/foreman_server/workflow/auto_pr.ex`; `docs/user-guide.md` "PR creation and merge reconciliation"; operator `approve-merge` gate | `beads-build.yaml:286-292` never creates one; `implement-trd-beads-reference/SKILL.md` sections 1 and 3 do | `implement-trd-beads` creates PRs under `--foreman` when the backend resolves to `gh` |
| IC-5: agents never flush the ledger in multi-agent runs | `docs/lessons/architecture-and-events.md`, Per-DB Beads lease: concurrent `br` or `bv` writers and writers alongside `bv --robot-plan` break SQLite's single-writer protocol, and writers outside the lease must observe single-writer discipline themselves; owner rule of 2026-10-27: the parent flushes | `tech-lead-orchestrator.yaml` bead-track mode and `AGENTS.md` step 5 tell every agent to flush | contradicted by shipped instructions |
| IC-6: `ensemble-beads-build` is a finished skill | bead "TRD-003: Update implement-trd-beads.yaml command to dispatch beads-build" (`.beads/issues.jsonl`) plans `ensemble-beads-build <epic> --foreman` | `beads-build.yaml` metadata version 1.4.0 (2026-10-23), wave loop labelled v1.2.0 at `:181`; Pi skill `packages/pi/skills/ensemble-beads-build/` | finished apart from the missing `--foreman` flag (IC-1) |
| IC-7: managed-run environment (`BEADS_DB`, `TRD_SCOPE`) | `docs/PRD/completed/PRD-2026-3d41f677-add-full-vcs-worktree-support-configured-via-wor.md` REQ-016, REQ-017 | no `TRD_SCOPE` or `FOREMAN_IMPLEMENTATION_KEY` in `packages/`, `docs/` or `scripts/` | scope filtering has no source in this repository |
| IC-8: skill names and flags are an interface | `packages/foreman_server/lib/foreman_server/workflow/validator.ex:13-21` known skills; `prd.yaml` skill names | Pi skills are named `ensemble-<command>` (`packages/pi/skills/`); `CONTRIBUTING.md` PR Flow requires a consumer check before a rename | Foreman calls `ensemble-full-*` names that no directory here carries [INFERENCE: the bundle prefix is added at install; not verified], and `prd.yaml` calls five `ensemble-*` names that are absent from the validator's list |

### Gate inventory (verified at authoring)

| Gate | Where | Blocks today | Class under REQ-029 and default |
|---|---|---|---|
| First tracker write per session (`confirm-status`) | `beads-build-wave.yaml` Step 1; `beads-build.yaml` Execute 1; `implement-trd-beads.yaml` Preflight 5 | asks unless `--foreman` | non-blocking (local, reversible): proceed under a standing authorization and log it |
| Merge of a PR (`confirm-status host.change-request-merge`) | `packages/git/commands/pr-merge.yaml`, Merge | asks unless `--foreman` | blocking unless the `merge on green` authorization exists |
| Retry of a failed new-feature stage | `packages/development/commands/new-feature.yaml`, No Arguments step | asks "Retry <stage>?" | non-blocking: the explicit resume is the retry request |
| PR creation and implementation approval | `new-feature.yaml` (`prApprovedAt`, `implementationApprovedAt`) | asks | per standing authorization, otherwise blocking |
| Quality gate failure under tdd, refactor or bug-fix | `implement-trd-beads.yaml` Quality Gate; `beads-build.yaml` Gate Result Recording | pauses for fix, skip or abort | non-blocking with default "fix"; never "skip"; escalates only as the stuck class |
| Debug loop exhausted or capability error | `beads-build.yaml` Debug Loop and Error Handling | pauses for a user decision | blocking only as the stuck class after the configured attempts |
| Completion verification incomplete | `implement-trd-beads.yaml` Completion step 1 | asks "Proceed anyway (override)" interactively | default stop and report; override only by a human |

### Data limits

- One repository, four days and one team. PR wall-time savings are upper bounds on calendar time because PR hours overlap (Review header).
- The CodeRabbit sample is judgmental: all 6 Major findings plus 8 others of 39 (Review sec. 2.4). The 4-partition CI estimate and the 8.4 h saving were not run (R3).
- Session-derived numbers (question time, workers alive, owner idle time) come from one agent host's transcripts and are not portable; the review lists what it did not measure (Review sec. 2.8).
- Ensemble facts above are reads of live settings and sources at authoring and are not durable.

## Requirements

**Scope tags:** `transferable` means the requirement applies to any ensemble-managed project; `per-stack` means it is a parameter or example set that lives in a stack profile (REQ-006), not a universal rule. Foreman check names, Elixir tooling and Postgres limits appear only as evidence and as examples.

### Hands-off merge

All requirements in this area are transferable: they apply to any repository whose base branch has required checks.

### REQ-001: Auto-merge is armed when a command opens its own PR
**Priority:** Must | **Scope:** transferable

When an ensemble command opens a PR itself (standalone or interactive use of `/ensemble:fix-issue` and `/ensemble:implement-trd-beads`) and the base branch passes the flow doctor (REQ-003), the command arms the host's native auto-merge on that PR at creation, with the repository's configured merge method, so the PR merges by itself once its required checks pass. When a dispatcher owns PR creation (REQ-022) the command opens no PR and arms nothing.

Basis: 63% of PR wall time (2,074 of 3,299 min) was green and unmerged; 44 of 46 PRs were merged by hand, and the two auto-merged ones merged 26 s (#679) and 5 min 16 s (#678) after the last required check (Review sec. 1, 2.1, 2.7). The review estimates about 35 h of PR wall time recoverable, an upper bound on calendar time (R1). Today `implement-trd-beads` ends by telling the user to merge PR 1 first and says only a human confirming the merge may call a PR merged (`packages/development/commands/implement-trd-beads.yaml`, Completion), and no ensemble command arms auto-merge.

- AC-001-1: Given a command opens a PR on a base branch that passes the flow doctor, when the command finishes, then auto-merge is armed on that PR and the hand-off report records the merge method.
- AC-001-2: Given the base branch fails the flow doctor, when the command opens a PR, then auto-merge is not armed, the hand-off report names the failed doctor item and the command does not merge the PR by any other route.
- AC-001-3: Given the host adapter cannot arm auto-merge, when a PR is opened, then the hand-off report states "auto-merge unavailable on this host" and the command neither merges the PR itself nor polls for it.
- AC-001-4: Given the repository configuration opts out, when a PR is opened, then no auto-merge is armed and the hand-off report says the opt-out applied.
- AC-001-5: Given arming is implemented for the shipped GitHub host adapter, when it is first used against a real protected branch, then the armed state and the later automatic merge are recorded as live evidence.

### REQ-002: Commands end at a hand-off, not at a wait
**Priority:** Must | **Scope:** transferable

A PR-producing command or worker ends with the PR open, auto-merge armed (or the reason it is not) and a hand-off report. It never holds a session open waiting for checks or for the merge, never calls the PR merged (the digest reports merged from host state), and the orchestrator never merges on a worker's behalf. A PR that goes red after arming is picked up by the rescue flow (`/ensemble:pr-merge`) from the failing contexts recorded in the hand-off report.

Basis: PRs #663 and #674 sat green for 117 min in total while the orchestrator waited with no blocker, and the orchestrator spent 27.2 h of its 83.6 h in `wait` on workers (Review sec. 2.1, 2.2). The review's rule: no long wait in the orchestrator while green PRs exist (R9).

- AC-002-1: Given a worker opened a PR and armed auto-merge, when its required checks are still running, then the worker ends with a hand-off report instead of waiting.
- AC-002-2: Given an armed PR, when the command reports, then it says "armed" and never "merged" or "landed", and a later merge is reported from host state.
- AC-002-3: Given a hand-off report records a failing required context after arming, when an operator runs the rescue flow, then the flow starts from the recorded contexts and the head commit.

### REQ-003: A flow doctor verifies merge prerequisites on the host
**Priority:** Must | **Scope:** transferable | `[RISK: reading protection settings needs elevated permission on some hosts and settings differ per host]`

A read-only flow doctor reports, for each base branch, whether the host is set up for hands-off merging: auto-merge permitted on the repository; required contexts present, named, and each produced by a workflow job or by the repository's local-CI status; strict (up-to-date) protection off; the number of required approving reviews; administrators enforced; and branch deletion on merge. Each item is reported pass, warn, fail or unverifiable with one remediation sentence. It changes no setting. The doctor, the CI audit, the ledger audit, the flow report and the definition-of-done check are delivered behind one task-oriented entry point [NEEDS CLARIFICATION: a new front door with subcommands, or modes of `/ensemble:pr-merge`, `/ensemble:retro` and the existing audit commands?].

Basis: after the 2026-10-27 settings change the Foreman base branch requires the contexts `foreman_server`, `jido_harness` and `foreman_cli` (non-strict), 0 approvals, administrators enforced, auto-merge and delete-branch-on-merge on (Review sec. 2.7). Ensemble's own `dev` branch requires the single unpinned context `ensemble/local-ci` (non-strict, no required reviews, administrators enforced), allows auto-merge and leaves delete-branch-on-merge off (read with `gh api` at authoring). The unexplained 5 min 16 s lag on #678 shows that correct settings do not by themselves predict merge timing (Review sec. 2.7). A manual protection check exists today only as a user-level skill outside this repository.

- AC-003-1: Given a repository with protection on its base branch, when the doctor runs, then it lists each required context by name and reports strict mode, required approvals, administrator enforcement, auto-merge permission and branch deletion as separate items.
- AC-003-2: Given a required context that no workflow job and no configured local-CI status can produce, when the doctor runs, then it reports "fail: a PR waits forever on <name>".
- AC-003-3: Given the caller cannot read protection settings, when the doctor runs, then the affected items are "unverifiable" and the overall result is not "ready".
- AC-003-4: Given strict protection is on, when the doctor runs, then it warns that each merge forces every open PR to update before it can merge.
- AC-003-5: Given any doctor run, when its run record is inspected, then it contains no host write call and no credential value.

### REQ-004: Advisory signals never block the merge
**Priority:** Must | **Scope:** transferable

A bot reviewer's CHANGES_REQUESTED, unresolved bot threads and any pending status that is not a required context never prevent arming or leave a command waiting; a human reviewer's CHANGES_REQUESTED still blocks. The doctor warns when the review bot's own configuration can request changes. This extends the manual-merge rules of PRD-2026-4dec59b8 (REQ-006) to the auto-merge path.

Basis: 16 manual dismissals of bot CHANGES_REQUESTED (101 min), 245 min waiting for a review that never came, and 22 of 46 PRs merged with no review at all (20 quota notices, 1 size limit, 1 disabled) (Review sec. 2.1, 2.4). PR #679, whose bot review was disabled, merged 26 s after green (sec. 2.7).

- AC-004-1: Given a PR with a bot CHANGES_REQUESTED review and every required context green, when a command evaluates the PR, then it does not treat the bot review as a blocker and lists it under advisory findings.
- AC-004-2: Given a human reviewer's latest decisive review is CHANGES_REQUESTED, when a command evaluates the PR, then it reports the PR as blocked by that reviewer and arms nothing.
- AC-004-3: Given the review bot's configuration is readable and enables a changes-requested workflow, when the doctor runs, then it warns and names the setting.

### REQ-005: Release channels stay explicit and the base branch keeps a semantic-conflict net
**Priority:** Must | **Scope:** transferable | `[RISK: with non-strict required checks two individually green PRs can break each other on the base branch]`

Ensemble commands never arm auto-merge on a branch declared a release channel (for example the branch consumers install from); release PRs keep their explicit release step. Because required checks are non-strict, the doctor verifies that a workflow runs on every push to the base branch, and a failed base-branch run becomes one tracked bead (PRD-2026-4dec59b8, REQ-008).

Basis: push-to-main CI ran 46 times (11.9 runner-hours) and failed 3 times, all flakes, with no semantic conflict found; the review keeps it as the only net while checks are non-strict (Review sec. 4, sec. 5 Q6). Ensemble's own `main` is the distribution channel: a merge there reaches installed machines with no tag, and it is protected by `release-gate` and `source-branch` (`.github/workflows/release-gate.yml`).

- AC-005-1: Given a base branch is declared a release channel, when a command opens a PR to it, then auto-merge is not armed and the hand-off report says the release step is explicit.
- AC-005-2: Given no workflow runs on pushes to the base branch, when the doctor runs, then it warns "no semantic-conflict net" and names the branch.
- AC-005-3: Given a push to the base branch produced a failed run, when the next flow command or report runs, then the failure is recorded once as a bead linked to the run.

### CI guidance, templates and audit

The rules in this area are stack-neutral. Everything that depends on a stack (toolchain version sources, lockfiles, cache paths, the test runner's partition and timing options, service containers, static-analysis caches) lives in a stack profile (REQ-006). Foreman's Elixir setup is one profile example and ensemble's Node setup another; neither is a universal requirement.

### REQ-006: Stack profiles carry every stack-specific CI detail
**Priority:** Must | **Scope:** per-stack

CI guidance, templates and the CI audit read an editable stack profile that declares: the toolchain version sources, the lockfile, the dependency and build cache paths, the test command with its partition option and per-test timing option when the runner has them, the service containers tests need, any static-analysis cache, and the non-code and tests-read path lists. The first release ships profiles for two stacks as worked examples: Node with npm (this repository) and Elixir with mix (the Foreman repository). Other stacks are added by editing a profile, not code.

Basis: Foreman's measured CI cost is stack-shaped: `mix test --cover` is 87% of the 607 s server job, a lockfile-only cache key survived a toolchain change, per-leg database service containers make partitions safe, and the jido job's dialyzer ran with no cache (190 s of a 4.0 min job) (Review sec. 2.3). Ensemble's own `test.yml` is a Node 22 and 24 matrix with `npm ci`, no dependency cache and no concurrency group (read at authoring). [INFERENCE: two profiles are enough to prove the mechanism; a third stack has not been tried.]

- AC-006-1: Given a stack profile, when a user edits one of its fields in the documented file, then the next template generation or audit run uses the edited value with no build step.
- AC-006-2: Given the shipped Elixir profile, when its Foreman-specific values are read, then they appear only in the profile and in examples and not in any rule text that applies to other stacks.
- AC-006-3: Given a repository whose stack has no profile, when the CI audit runs, then it reports "no profile" and applies only the stack-neutral rules.

### REQ-007: Dependency caches are keyed on the toolchain and the lockfile
**Priority:** Must | **Scope:** transferable

Templates build every dependency or build-cache key from the exact toolchain identity the profile names (runtime, compiler, operating-system image) plus the lockfile hash, with a restore fallback that never crosses a toolchain version, and save caches only from the base branch.

Basis: a lockfile-only key outlived a toolchain pin change, so 98 dependencies were recompiled on every run for 9 days (71 of 160 sampled runs, +7 min each; compile 441 s against 18 s) until an unrelated lockfile change replaced the entry (Review sec. 1, 2.3).

- AC-007-1: Given a workflow whose cache key contains no toolchain identity, when the CI audit runs, then it reports a finding naming the workflow, the key expression and the missing component.
- AC-007-2: Given a template generated from a profile, when it is read, then its cache key contains the toolchain identity and the lockfile hash and its restore fallback begins with the toolchain identity.
- AC-007-3: Given a PR changes the pinned toolchain version, when CI runs, then no cache saved under the previous toolchain is restored.

### REQ-008: Split test jobs report through one aggregate required context
**Priority:** Should | **Scope:** per-stack | `[RISK: running a file subset per runner changes ordering and can expose order-dependent tests]`

For stacks whose test runner can partition a suite, the profile lets a template split the test job into N parallel partitions, each with its own runner and service containers, plus one aggregate job that carries the exact name of the previously required context so branch protection needs no change. The aggregate fails unless every partition succeeded (failed, cancelled and skipped all count as failure), no partition job reuses the required name, and a scheduled full single-runner run remains available.

Basis: the Foreman server job took a median 11.1 min (p90 16.7), 87% of it in tests, and 93% of test time ran in non-async test files; each matrix leg gets its own runner and database, and the review estimates 4 partitions bring the job to about 4-4.5 min [estimate, not run], with a nightly single-runner run as the mitigation for order dependence (Review sec. 2.3, R3).

- AC-008-1: Given a partitioned workflow where one partition fails, when the run completes, then the aggregate context is failed and a PR requiring it cannot merge.
- AC-008-2: Given a partitioned workflow where one partition is cancelled or skipped, when the run completes, then the aggregate context is not success.
- AC-008-3: Given a template generated for a protected repository, when the aggregate job is read, then its name equals a context in the repository's required list and no partition job reuses that name.
- AC-008-4: Given the aggregate exists, when a mutation deliberately fails one partition on a scratch branch, then the aggregate shows failure and the evidence is recorded.

### REQ-009: Non-code changes skip heavy jobs without leaving a required context pending
**Priority:** Must | **Scope:** transferable | `[RISK: a document that tests read, mislabelled as non-code, would merge untested]`

Templates detect non-code changes in a first job and condition each heavy job on the result at job level, so a skipped job still reports a state that satisfies its required context. Workflow-level path filters are never used on a workflow that provides a required context. The non-code path list and the list of files that tests read are explicit and editable, and a file that tests read counts as code.

Basis: 10 of 46 PRs (strict subset 5) touched only ledger, plan, acceptance, e2e-script or review-config paths and cost 111 server-job minutes; tests read `docs/user-guide.md`, `docs/cli-reference.md`, `CLAUDE.md`, `README.md` and `AGENTS.md`. The review cites docs.github.com ("Using conditions to control job execution") for a conditionally skipped job counting as success while a path-filtered workflow leaves its required checks pending (R6; not re-verified here).

- AC-009-1: Given a PR that changes only paths on the non-code list, when CI runs, then every required context reports a passing state without the heavy jobs executing and the PR becomes mergeable.
- AC-009-2: Given a PR that changes a file on the tests-read list, when CI runs, then the heavy jobs run.
- AC-009-3: Given a workflow that provides a required context and uses a workflow-level path filter, when the CI audit runs, then it reports "fail: the required context can stay pending forever".
- AC-009-4: Given the skip logic is adopted, when a docs-only PR is opened on a real protected branch before adoption is declared done, then the observed required contexts and the PR's mergeability are recorded as evidence.

### REQ-010: Superseded runs are cancelled and slow tests are visible
**Priority:** Should | **Scope:** transferable

Templates give pull-request workflows a concurrency group keyed on the PR that cancels superseded runs (never base-branch runs), and make the test step print its N slowest tests with durations when the runner supports it, so slow tests surface without a separate profiling run.

Basis: 23 runs on superseded commits used 6.3 runner-hours because no concurrency group existed; no per-test timing existed while 15-24 silent gaps of 5 s or more per run made up 46-59% of test wall time, and tests grew 1.95x while test time grew 3.8x in 14 days (Review sec. 2.1, 2.3). Ensemble's own `test.yml` and `validate.yml` have no concurrency group; 5 of its 17 workflows do (read at authoring).

- AC-010-1: Given a pull-request workflow without a concurrency group, when the CI audit runs, then it reports a finding naming the workflow.
- AC-010-2: Given a template, when it is read, then cancellation applies only to pull-request events and never to base-branch runs.
- AC-010-3: Given a profile whose runner has a timing option, when the test step runs, then the log ends with the N slowest tests and their durations, where N defaults to 25 and is editable.

### REQ-011: A CI conformance audit keeps required contexts reporting
**Priority:** Must | **Scope:** transferable | `[RISK: static reading of workflow files cannot prove runtime behaviour]`

A read-only CI audit reads a repository's workflow files and reports findings for the rules of REQ-007 to REQ-010 and REQ-033, plus any change that renames, duplicates or drops a job whose name is a required context, and a partition set without an aggregate. It runs on demand and on workflow-changing PRs and fails when a finding is an error. The required-context list comes from the doctor or from repository configuration.

Basis: the review's own partition design keeps the aggregate named like the required context so protection is unchanged (R3); a renamed or duplicated context would leave the base branch waiting forever or let a red leg through [INFERENCE: the review reports no such incident]. 9.8% (12 of 123) of required-job runs were red (Review sec. 2.5).

- AC-011-1: Given a workflow change that renames a job whose name is in the required list, when the audit runs, then it fails and names the old and the new name.
- AC-011-2: Given two jobs that produce the same required context name, when the audit runs, then it reports the duplicate.
- AC-011-3: Given each audit rule, when it runs against a deliberately broken workflow fixture and against a conforming one, then it fails on the first and passes on the second.

### Review policy

All requirements in this area are transferable. Review-service settings (a changes-requested workflow, path filters, a file limit) are examples of one tool's knobs.

### REQ-012: Automated review is advisory and on demand
**Priority:** Must | **Scope:** transferable

Ensemble commands never wait for, request or re-request an automated review per push. When a repository uses an automated or in-house reviewer, it reviews once per workstream on the aggregate diff of product (logic-bearing) code, on demand or at workstream end, and its result is advisory for merge purposes.

Basis: review-loop time was 574 min across 12 PRs (plus 1,056 min overnight), one round trip took about 35 min (24 min to the next push plus about 11 min of CI), and the service skipped 22 of 46 PRs (Review sec. 2.1, 2.4, 4). The review's rule: review once per workstream on the aggregate diff (R7). [INFERENCE: the value of the local pre-publication review that ensemble's `pr-review-cycle` runs was not measured.]

- AC-012-1: Given a command pushed a fix commit, when it finishes, then it has neither requested nor waited for a new automated review of that push.
- AC-012-2: Given a workstream completes, when the end-of-workstream review is requested, then it covers the aggregate diff once and its findings are recorded per REQ-013.
- AC-012-3: Given an automated review is pending or unavailable because of quota or a size limit, when the hand-off report is produced, then it states the review status and the PR is not held for it.

### REQ-013: Only defects in logic-bearing code gate
**Priority:** Must | **Scope:** transferable

A finding gates the workstream's definition of done only when it concerns correctness, security, data integrity or concurrency in product code (including security-relevant scripts). Documentation wording, harness nits and style become one follow-up bead or are folded into the next change, with no extra review round. Every valid finding ends fixed, tracked in a bead, or declined with a reason. The categories and paths are an editable skill. Automated review found real defects, so it is kept for product code and not removed.

Basis: of 34 inline findings, 6 were Major and none Critical; 10 were in `lib/` and 8 of those were valid and fixed (3 lease or keeper correctness bugs, a jobsite 202 response, a prompt-injection boundary, a doctor check, a parser); 14 targeted scripts, 8 docs and 2 tests. In the 14-finding sample 10 were valid, 8 fixed in-PR and 2 still unfixed at review time (Review sec. 2.4, R7).

- AC-013-1: Given a finding about correctness, security, data integrity or concurrency in product code, when the workstream is evaluated for done, then it is fixed or carries a recorded adjudication.
- AC-013-2: Given a finding about documentation wording, harness code or style, when it is recorded, then it becomes a follow-up bead or a batched change and triggers no further review round.
- AC-013-3: Given a valid finding is not fixed within the workstream, when the hand-off report is produced, then it lists the finding with its bead id.
- AC-013-4: Given a maintainer edits the category or path list in the review-policy skill, when the next workstream is evaluated, then the edit applies with no code change.

### REQ-014: Review scope and size are controlled before a PR opens
**Priority:** Should | **Scope:** transferable

Before opening a PR, commands check the change against the configured review limits (file count, changed lines) and path filters (for example documentation and ledger paths excluded from automated review). A change over the limits is split or reviewed in-house on the aggregate diff instead of being skipped silently by the review service.

Basis: PR #667 changed 422 files (39k lines) and the review service declined it ("422 files > 300"); PRs of 501 or more changed lines took a median 62 min (excluding overnight) against 13 min for PRs of 30 lines or fewer (Review sec. 2.1, 2.4). Ensemble's advisory PR-size check already warns above 400 hand-written lines (`scripts/pr-size.js`).

- AC-014-1: Given a change over the configured file limit, when a command is about to open its PR, then it proposes a split or an in-house aggregate review and records which was chosen.
- AC-014-2: Given the review service's path filters are readable, when the doctor runs, then it reports whether ledger and documentation paths are excluded from automated review.

### Multi-agent orchestration

All requirements in this area are transferable. They govern orchestrating commands and the worker agents they dispatch (`/ensemble:implement-trd-beads`, `/ensemble:beads-build`, `/ensemble:beads-build-wave`, `/ensemble:implement-bead`, `/ensemble:fix-issue`).

### REQ-015: One branch, one PR and one owner per workstream
**Priority:** Must | **Scope:** transferable

Each delegated workstream owns one branch and one PR, and its worker carries it through local gate, PR, auto-merge and hand-off. In stacked mode each phase is a workstream; in single-PR mode the whole TRD is one. A small follow-up (30 changed lines or fewer, editable) to a workstream whose PR is still open is folded into that PR. A file that many workstreams edit (a hot file) has one writer per batch, and the other workers record their notes in their bead.

Basis: 9 of 46 PRs were 30 lines or fewer; 8 PRs (17%) were flake or red-main repairs; the user guide was touched by 25 of 46 PRs, `CLAUDE.md` by 13 and the acceptance index by 10; 8 merge-conflict lines hit 3 agents, 4 of them in hot docs (Review sec. 2.1, 2.2, 2.5, 2.6, R6, R9).

- AC-015-1: Given a workstream is dispatched, when it completes, then it produced exactly one branch and one PR and the hand-off report links both.
- AC-015-2: Given a follow-up of 30 changed lines or fewer targets a workstream whose PR is still open, when the follow-up is committed, then it lands on that PR's branch.
- AC-015-3: Given the dispatch plan names a hot file, when several workstreams need to change it, then one is the writer and the others append their notes to their bead.

### REQ-016: Concurrent agents get private test resources within shared limits
**Priority:** Must | **Scope:** transferable | `[RISK: shared service limits must be declared per repository and an undeclared limit cannot be checked]`

Every concurrently running agent uses private, uniquely named test resources (database, port range, temporary directory) and a bounded connection pool. The dispatch plan checks the declared per-agent demand against the declared limit of each shared service and caps parallelism up front instead of discovering exhaustion at run time. The limits are declared in repository configuration; a database server is one example of a shared service.

Basis: 9 `too_many_connections` failures in 6 agents (8 of them within 17 min) against a 100-connection server with a test pool of 30; peak 8 and mean 2.4 workers alive; the review's rule: at most 3 concurrent full test runs per database (3 x 30 < 100) or a pool of 8 for agent runs (Review sec. 2.2, R9). `beads-build-wave` dispatches 3 tracks concurrently by default and no `beads-build`, `beads-build-wave` or `tech-lead-orchestrator` source creates a private resource or worktree for them.

- AC-016-1: Given a repository declares a shared service limit and a per-agent pool, when a dispatch plan would exceed the limit, then the plan reduces parallelism and says which limit forced it.
- AC-016-2: Given an agent starts its test run, when the run connects to a database, then the database name is derived from the agent's run id and is not the shared default.
- AC-016-3: Given a connection-limit error appears in an agent's output, when the hand-off report is produced, then it records a resource-exhaustion finding naming the service and the run is not retried blindly.
- AC-016-4: Given no limit is declared for a shared service, when the dispatch plan is built, then it warns that capacity is unverified.

### REQ-017: Worktrees and branches are cleaned up after each batch
**Priority:** Should | **Scope:** transferable

Worktrees and branches that ensemble commands create are recorded when created. After a batch whose PRs have merged, merged local branches are removed and stale worktree records are pruned. Concurrent workers that edit code run in isolated worktrees [NEEDS CLARIFICATION: the parallel tracks of `beads-build-wave` share one working tree and branch today; should concurrent tracks move to per-track worktrees or stay serialised on one tree?].

Basis: 155 local branches, 18 worktrees and 53 remote branches had accumulated, and 41.5 h (2026-10-23T22:42 to 10-25T16:13) went to worktree and branch triage and red-main repairs (Review sec. 2.2, R9). `beads-build-wave` verifies one clean working directory and one feature branch and creates no worktree (`packages/development/commands/beads-build-wave.yaml`, Working Directory and Branch Verification).

- AC-017-1: Given a batch whose PRs have all merged, when the cleanup step runs, then merged local branches created by the batch are deleted, the worktree list is pruned and the hand-off report lists what was removed.
- AC-017-2: Given a branch has unmerged commits or a dirty worktree, when cleanup runs, then it is kept and listed with the reason.

### REQ-018: Investigations are time-boxed and evidence comes first
**Priority:** Must | **Scope:** transferable | `[RISK: a prompt-level rule can be ignored and REQ-043 forbids a watchdog]`

Every investigation, bisection or live loop starts with a recorded time box (default 2 hours, editable) and a stop rule. Evidence capture comes first (a harness that preserves logs, seeds and state, within 45 minutes), and repeated runs then proceed in the background while other work continues. At the time box, or when the clean runs reach 3/p for the failure rate p being excluded, the agent records a decision (continue with named new evidence, park the bead with the harness, or escalate) before running more. No timer or watchdog is added: the orchestrator checks elapsed time at each wave barrier and the ledger audit flags investigations past their box.

Basis: FlowStep3Diagnose ran 311 min (255 of them in `wait` on a loop script) and its evidence harness landed 3.6 h in; one failure stayed unreproduced after about 121 clean runs (5.2 h); a pair-bisection took 5.5 h; 8 workers ran 2 h or more (Review sec. 2.2, R4). Excluding a 1% flake takes about 300 runs (about 12 h) (R4).

- AC-018-1: Given an investigation is dispatched, when its brief is built, then it contains the time box, the stop rule and the evidence-first instruction.
- AC-018-2: Given an investigation reaches its time box, when the agent continues, then a decision entry with one of the three outcomes is already recorded in its bead.
- AC-018-3: Given a wave barrier is reached, when an in-flight investigation exceeds its time box without a decision, then the orchestrator reports it in the wave summary.
- AC-018-4: Given a time box passes while an agent is mid-run, when no decision exists, then nothing is killed by ensemble and the overrun is only reported.

### REQ-019: Every worker ends with a hand-off report in a fixed shape
**Priority:** Must | **Scope:** transferable

A worker's final output is one structured object with at least: the PR (number and link), the head commit, the auto-merge state, the required contexts and their states at hand-off, the beads touched with status and close reason, the evidence path, the decisions taken (gate, default chosen, how to reverse it), and findings left open. Unknown values are null, never omitted. The orchestrator verifies claims by reading host state, not by repeating the worker's checks.

Basis: the review's hand-off shape `{pr, head_sha, ci, beads, evidence_path, decisions}` with the rule that the orchestrator does not re-verify (R9); 5 of 77 owner prompts asked what an agent was waiting for (Review sec. 2.2). Today `beads-build-wave` emits one JSON summary line and `pr-merge` one final JSON line (their command sources) but no worker-level contract exists, and `pr-merge` never trusts a subagent's self-report, which this requirement keeps by reading host state.

- AC-019-1: Given a worker finishes, when its last output is read, then it is one valid JSON object containing every required key.
- AC-019-2: Given a value is unknown, when the report is produced, then the key is present with the value null.
- AC-019-3: Given an orchestrator receives a report, when it checks the claims, then it compares the reported head commit and auto-merge state with host state and flags any mismatch without re-running the worker's tests.
- AC-019-4: Given the report lists a decision, when the hand-off is read, then each decision carries the gate, the default taken and how to reverse it.

### Dispatcher integration contract

These requirements pin the interface between ensemble skills and a dispatcher that runs them unattended; Foreman is the first. Each was verified against both repositories at authoring (see Research Context for paths and current state). They are transferable: any dispatcher that follows the convention gets the same behaviour.

### REQ-020: Every dispatchable skill honors the `--foreman` convention
**Priority:** Must | **Scope:** transferable

Every ensemble command or skill a dispatcher can invoke as `/skill:<name> <arguments> --foreman` accepts the flag and treats it as: never prompt, take the documented default at every gate and record it, write the phase report to the path in `FOREMAN_ARTIFACT_PATH` when it is set (unset is not an error), and read the subject from `FOREMAN_TASK_TITLE` and `FOREMAN_TASK_DESCRIPTION` where the command has one. Task-level beads are tagged `foreman-exec` only under the flag, never epics or stories. A conformance check lists dispatchable commands that lack the flag.

Basis: Foreman's bundled workflows call `/skill:ensemble-full-implement-trd-beads ... --foreman` (`packages/foreman_server/priv/defaults/workflows/implement-trd-beads.yaml:39`) and six more skill calls with the flag (`implement-trd.yaml:38`, `prd.yaml:46-60`); 11 of the 12 dispatcher-relevant command sources declare the flag, but `beads-build.yaml` does not (its only mention is a parenthetical at line 93, "covers --foreman callers too", and its `argument_hint` omits it) while the Foreman bead "TRD-003: Update implement-trd-beads.yaml command to dispatch beads-build" (Foreman `.beads/issues.jsonl`) plans to call `ensemble-beads-build <epic> --foreman`.

- AC-020-1: Given each dispatchable command source, when the conformance check runs, then it passes only if the command declares the flag and states the non-interactive and report-path behaviour.
- AC-020-2: Given a dispatcher runs a command with `--foreman`, when a gate is reached, then no question is asked and the default taken appears in the hand-off report.
- AC-020-3: Given `--foreman` is absent, when a command tags beads, then it adds no `foreman-exec` label.

### REQ-021: The tracker's scheduler is the only scheduler, with no fallback
**Priority:** Must | **Scope:** transferable

Scheduling reads the work graph only through the resolved tracker adapter's work-graph capabilities, which for the beads tracker run `bv --robot-plan`. There is no `br ready` fallback, no degraded path and no scheduling from the ledger export file: when `bv` is missing or fails, the command stops with a message naming it. Agent briefs and command text contain no contrary statement.

Basis: both `work-graph.ready` and `work-graph.plan` of the beads adapter run `bv --robot-plan --format json` (`packages/development/skills/adapter-tracker-beads/adapter.yaml:277,292`) and `beads-build.yaml:67` forbids scheduling from the export; but the wave-runner agent brief says "bv is optional: when it is missing or fails, the command falls back to br ready" (`packages/development/agents/beads-build-wave.yaml`, Fail Loudly, Not Silently), contradicting the wave command, which falls back only from the plan capability to the ready capability (`packages/development/commands/beads-build-wave.yaml`, Step 2).

- AC-021-1: Given `bv` is missing, when a scheduling wave starts, then it stops with an error naming `bv` and schedules nothing.
- AC-021-2: Given the command and agent sources, when they are searched, then no instruction to use `br ready` for scheduling remains.
- AC-021-3: Given a tracker adapter other than beads, when a wave starts, then scheduling uses that adapter's own work-graph capability and still has no second scheduler.

### REQ-022: A dispatcher-owned PR is never created by a skill
**Priority:** Must | **Scope:** transferable

When a dispatcher owns PR creation and merge policy (signalled by `--foreman`), a skill commits on the dispatcher's branch and never pushes, creates a PR or arms auto-merge; it reports the branch, the head commit and the evidence. `beads-build` already never creates PRs; `implement-trd-beads` must stop doing so under the flag. `fix-issue` also opens PRs and accepts `--foreman`, but no bundled Foreman workflow calls it (read at authoring), so it stays outside this requirement until a dispatcher does.

Basis: Foreman's AutoPR opens the PR from the run's worktree branch (`packages/foreman_server/lib/foreman_server/workflow/auto_pr.ex`; Foreman `docs/user-guide.md`, "PR creation and merge reconciliation") and its merge gate waits for an operator `approve-merge` (same section). `beads-build.yaml:286-292` never auto-creates a PR, but `implement-trd-beads` creates PRs through `host.change-request-create` or `workflow.propose` (`packages/development/skills/implement-trd-beads-reference/SKILL.md`, sections 1 and 3) and its `--foreman` parameter changes no HALT behaviour, so a run whose PR backend resolves to `gh` can open a PR that AutoPR then duplicates [INFERENCE: not observed].

- AC-022-1: Given `--foreman` is present, when `implement-trd-beads` reaches a PR boundary or completion, then it neither pushes nor creates a change request and reports the branch and the head commit.
- AC-022-2: Given `--foreman` is present, when the hand-off report is produced, then it states that the dispatcher owns the PR and the `pr` value is null.
- AC-022-3: Given `--foreman` is absent, when the command reaches a PR boundary, then behaviour follows REQ-001.

### REQ-023: A dispatcher's managed-run environment is honored
**Priority:** Should | **Scope:** transferable | `[RISK: found during verification; this repository's sources show no scope support and location support may be implicit]`

When a dispatcher injects a frozen ledger location (`BEADS_DB`) and a run scope (`TRD_SCOPE`: the TRD slug plus the first 12 characters of the implementation key), every ledger and scheduler call uses that location and never rediscovers `.beads` from the working directory, and every candidate bead is filtered by the exact scope before selection.

Basis: Foreman's completed PRD requires it: the skill "MUST pass the frozen `BEADS_DB` explicitly to every `br` and `bv` invocation" and filter every resume, status, ready and robot-plan candidate by exact `TRD_SCOPE` (`docs/PRD/completed/PRD-2026-3d41f677-add-full-vcs-worktree-support-configured-via-wor.md`, REQ-016 and REQ-017). A search of this repository's `packages/`, `docs/` and `scripts/` finds no `TRD_SCOPE` or `FOREMAN_IMPLEMENTATION_KEY`, and the only `FOREMAN_WORKTREE` use is in `packages/development/lib/complexity-analyzer.js` [INFERENCE: `br --help` shows it reads `BEADS_DB` from the environment, so location may already be inherited by child processes, but scope filtering has no source].

- AC-023-1: Given `BEADS_DB` is set, when a ledger or scheduler call runs, then it uses that location and not a discovered one.
- AC-023-2: Given `TRD_SCOPE` is set and a global plan holds candidates from two TRDs, when the next bead is selected, then only candidates whose title carries the exact scope are considered.

### Beads ledger semantics and audit

The ledger is the project's work tracker; beads (`br` and `bv`) is the default tracker. The requirements are transferable to any tracker adapter that exposes the states needed, and an audit rule that needs a missing state is reported as unverifiable.

### REQ-024: The ledger has defined states and a claim protocol
**Priority:** Must | **Scope:** transferable

The shipped documentation defines each ledger state: open (not started, not blocked), in_progress (an agent or person is working it now and has claimed it), blocked (cannot proceed and names the blocker, normally a dependency), deferred (parked on purpose with a revisit trigger) and closed (delivered or dropped on purpose, with evidence). A bead is claimed in_progress only while it is worked, with a comment naming the agent, the worktree and the start time, and it is released to open (or closed) when the agent finishes or abandons it. Where a tracker adapter exposes fewer states (the beads adapter normalizes `deferred` to `open` and `in_review` to `in_progress`), the protocol uses the adapter's vocabulary.

Basis: an audit found 58 of 97 non-closed beads (60%) with the wrong status and closed 46 of them as delivered (median age 70 days); the only three in_progress beads were stale (created 10-13) at all nine ledger-touching merges on 10-26 while no bead an agent actually worked was ever in_progress on the base branch (Review sec. 2.6).

- AC-024-1: Given the shipped documentation, when a reader looks up any of the five states, then each has a definition and the evidence required to enter it.
- AC-024-2: Given a worker starts a bead, when it claims it, then the status becomes in_progress with a claim comment naming the agent, the worktree and the start time.
- AC-024-3: Given a worker finishes or abandons a bead, when it ends, then the bead is closed with evidence or released to open with a comment saying why.
- AC-024-4: Given a tracker adapter exposes only some of the states, when the claim protocol runs, then it uses the adapter's own vocabulary and records the mapping it used.

### REQ-025: Closing a bead requires evidence
**Priority:** Must | **Scope:** transferable

A bead is closed only with a reason that names its evidence: for delivered code, the merged PR and commit (`PR #N <sha>`) and the evidence path when the work crosses an external boundary; for non-code or dropped work, a reason code and one sentence. A bead is not closed before its PR has merged, and bulk closure without per-bead evidence is refused.

Basis: 81 of 128 closures (63%) happened in six same-minute batches; of 64 beads closed after their PR merged, the median lag was 53.5 h (42 over 24 h, 16 over 7 days) and 18 more were closed before their PR merged (Review sec. 2.6, R11, R12). The shipped `br-close-reason` guard (`packages/guards/README.md`) requires only a non-empty `--reason`.

- AC-025-1: Given an agent runs a close command whose reason lacks an evidence reference, when the guard evaluates it, then it is blocked with the expected reason format.
- AC-025-2: Given a close reason cites a PR, when the ledger audit runs in check mode, then it fails if that PR is not merged or its commit is not on the base branch.
- AC-025-3: Given one command closes several beads with a single shared reason, when the guard evaluates it, then it is blocked unless each bead carries its own evidence.
- AC-025-4: Given a bead is closed for a non-code reason, when the reason names a reason code and one sentence, then the guard allows the close.

### REQ-026: Test beads are closed only with failing-before evidence
**Priority:** Must | **Scope:** transferable

A bead that exists to add or change a test (for example a `-TEST` task bead) is closed only with evidence that the test fails without the change under test and passes with it: the failing run output or the mutation used, and the passing run. The marker that identifies a test bead is an editable setting.

Basis: constitution rule 7 (a check that cannot fail manufactures confidence); 12 of 123 required-job runs were red and 10 were flakes (Review sec. 2.5). [INFERENCE: the review did not measure how many test beads lacked failing-before proof.]

- AC-026-1: Given a test bead is closed, when the ledger audit runs, then it reports a finding unless the close reason or comments reference a failing-before run and a passing run.
- AC-026-2: Given a maintainer edits the test-bead marker in the shipped setting, when the audit next runs, then it uses the edited marker.

### REQ-027: Workers never flush the ledger and the parent is the single writer
**Priority:** Must | **Scope:** transferable | `[RISK: today's shipped instructions tell every agent to flush, and guards exist only as Claude Code hooks]`

Worker and track agents change bead state (claim, comment, close) but never run the tracker's flush or sync and never edit or stage the ledger export. The parent flushes immediately before every scheduling read (a failed flush stops the wave instead of being skipped) and once more at batch end, and it stages only the workstream's beads in one ledger change per batch. A guard enforces the rule where the runtime supports hooks and the ledger audit detects violations elsewhere [NEEDS CLARIFICATION: is a harness-level hook available, or acceptable to add, on Pi/OMP, Codex and OpenCode, or is the rule detect-only there?].

Basis: 12 of 46 PRs touched the ledger export (3 were ledger-only) and 9 ledger-touching merges landed on one day (Review sec. 2.6, R6, R11). SQLite's single-writer protocol cannot tolerate concurrent `br` or `bv` writers or writers running alongside `bv --robot-plan`, and Foreman serializes admission per database with a lease while stating that writers outside it must observe single-writer discipline themselves (Foreman `docs/lessons/architecture-and-events.md`, Per-DB Beads lease). The shipped instructions have every agent flush (repository `AGENTS.md`, step 5 Sync; `packages/development/agents/tech-lead-orchestrator.yaml`, bead-track mode: "export with `br sync --flush-only`"); the wave command skips a failed pre-schedule flush silently (`packages/development/commands/beads-build-wave.yaml`, Step 1: "optional; {ok:false} -> skip silently"); Foreman's watcher re-reads the exported file from scratch on every filesystem event (Foreman `docs/user-guide.md`, Inbound sync) and `bv` auto-discovers the exported JSONL (repository `AGENTS.md`). [INFERENCE: concurrent claim and close calls from parallel tracks are the same class of risk; the review counted 0 merge conflicts in the export but did not look for lock errors.]

- AC-027-1: Given a worker in track mode, when it completes a bead, then it has run no flush or sync command.
- AC-027-2: Given a worker runs a flush or sync command under a runtime with hook support, when the guard evaluates it, then it is blocked with the single-writer explanation.
- AC-027-3: Given the parent is about to run a scheduling read, when it prepares the call, then it flushes first and stops the wave if the flush fails.
- AC-027-4: Given a runtime without hook support, when a ledger change made outside the parent's batch commit is audited, then the audit reports a single-writer violation.
- AC-027-5: Given the tracker's own tool regenerates its workflow block in `AGENTS.md`, when it does, then the single-writer rule is not lost because it lives outside the managed block or in command text.

### REQ-028: A read-only ledger audit command reports status accuracy
**Priority:** Must | **Scope:** transferable

On demand, a ledger audit reads the ledger and reports per rule: in_progress beads past the stale threshold (default 4 hours, editable) with no recent update or claim comment (ghost in_progress); the in_progress count against registered workers; open beads whose evidence shows delivery; closed beads lacking evidence (REQ-025 and REQ-026); parent and child consistency (a parent not closed over open children, child title prefixes matching the parent's slug, a story closed over an open task); beads closed before their PR merged; and investigations past their time box. In check mode it exits non-zero on error findings so a ledger change can be gated. It proposes tracker commands and never runs them.

Basis: the manual status audit of #678 took 3 agents about 13 min each plus a PR and found 58 wrong statuses in 97 non-closed beads; 3 in_progress beads were 18 hours old; 18 of 64 beads were closed before their PR merged (Review sec. 2.6, 4, R11). `br` already offers `stale`, `orphans`, `lint` and `coordination status` (br 0.6.0 `--help`) that the audit can read.

- AC-028-1: Given in_progress beads older than the stale threshold with no claim comment from a registered worker, when the audit runs, then each is listed with its last update, its last comment and a proposed release command.
- AC-028-2: Given a parent bead is closed while a child is open, when the audit runs, then it reports the pair.
- AC-028-3: Given the audit runs in check mode on a ledger change that closes a bead whose cited PR is not merged, when it completes, then it exits non-zero and names the bead.
- AC-028-4: Given any audit run, when the ledger bytes are compared before and after, then they are identical.
- AC-028-5: Given each rule, when it runs against a deliberately mislabelled fixture ledger, then the rule reports the defect.

### Interruption and consent

The gate rules apply to ensemble's own commands and to the policy skills it ships. The host agent's own question tool is outside ensemble's control: ensemble ships the policy and its commands obey it.

### REQ-029: Gates on reversible actions do not block
**Priority:** Must | **Scope:** transferable

Every point where a command may ask a human is classified as blocking (an irreversible or externally visible action with no safe default) or non-blocking (a reversible action with a safe default). At a non-blocking gate the command takes the default, records it in the PR or bead, keeps other lanes running and lists it under decisions in the hand-off report. At a blocking gate the command asks and holds only the affected lane. The classification of every gate the shipped commands contain is an editable skill (see the gate inventory in Research Context). A gate whose only proceeding option would ship failing tests or skip a required check defaults to stopping that workstream and reporting, never to proceeding.

Basis: 18 questions blocked the orchestrator for 22.3 h in total (21.2 h of the 96.5 calendar hours, 22%), two overnight questions took 19.8 h, and no worker was alive for 30.2 h (2026-10-24T10:06 to 10-25T16:17); 5 of 77 owner prompts asked what an agent was waiting for (Review sec. 1, 2.2, R2). The review's rule: ask only for irreversible or externally visible actions with no safe default; otherwise take the reversible default, record it, keep other lanes running and list "decisions needed" in the closing summary (R2b).

- AC-029-1: Given a gate on a reversible action with a safe default, when a command reaches it, then it proceeds with the default and the hand-off report lists the decision with how to reverse it.
- AC-029-2: Given a gate on an irreversible or externally visible action with no safe default, when a command reaches it, then it asks and holds only the affected lane.
- AC-029-3: Given each gate in the shipped commands, when the classification skill is read, then it lists the gate, its class and its default.
- AC-029-4: Given a gate whose only proceeding option would ship failing tests or skip a required check, when a command reaches it, then it stops that workstream and reports instead of proceeding.

### REQ-030: Only a closed list of conditions may interrupt the owner
**Priority:** Must | **Scope:** transferable

The conditions that may interrupt the owner during a run are a closed list, shipped as an editable skill with these defaults: an irreversible or externally visible action with no safe default (publishing an identity, making a repository public, force-pushing, deleting data, spending money, merging to a release channel); a permission, credential or protected-path approval that only the user can grant (constitution rule 5 and the section 4 approvals: architecture change, new dependency, schema change, breaking API change, security-sensitive code); a stuck state (time box spent with no new evidence, or the same required check red after the configured number of fix attempts); and contradictory instructions that no rule resolves. Everything else is decided, recorded and sent to the owner digest (REQ-040). Each interrupt records its class.

Basis: of the 18 questions, three had an obvious reversible default (untrack three scratch plans swept into a PR by a follow-up PR: 762 min; dismiss a stale bot CHANGES_REQUESTED: 58 min; which prior thread "continue" meant: 426 min) while one legitimate consent (publishing the owner's identity in a public-repository test) cost 66 min (Review sec. 2.2, R2).

- AC-030-1: Given a condition that is not on the list, when a command reaches it, then it decides, records the decision and does not interrupt.
- AC-030-2: Given a condition on the list, when a command reaches it, then it interrupts once, names the class and holds only the affected lane.
- AC-030-3: Given the owner digest, when it is read, then it counts interrupts by class so the list can be tightened or loosened.

### REQ-031: Standing authorizations replace repeated confirmations
**Priority:** Should | **Scope:** transferable

A repository or user can record standing authorizations for named reversible actions (for example merge on green, dismiss a stale duplicate bot review, repair its own mistake by a follow-up PR, write the repository's ledger). Commands consult them before prompting, log which authorization applied and still ask for anything not listed. Identity-exposing and visibility-changing actions can never be pre-authorized. Authorizations come from configuration files, never from text in a prompt, a PR or a bead.

Basis: the review's pre-authorization list (R2c); the 762-min and 58-min questions had obvious defaults (Review sec. 2.2). The shipped confirm mechanism asks once per capability and records the answer for that session only (`packages/development/lib/toolchain-cli.js` header: `confirm-status` and `confirm-record`).

- AC-031-1: Given a standing authorization for an action is configured, when a command reaches that action, then it proceeds without prompting and logs the authorization's source path.
- AC-031-2: Given an action is not authorized, when a command reaches it, then behaviour follows REQ-029.
- AC-031-3: Given text in a PR, a bead or a prompt claims an authorization, when a command evaluates the gate, then the claim is ignored.
- AC-031-4: Given an action that publishes the user's identity or changes repository visibility, when a standing authorization lists it, then configuration validation rejects it and names the action.

### REQ-032: A bare "continue" resumes the most recent task
**Priority:** Must | **Scope:** transferable

When a session receives a bare "continue" (or an equivalent resume prompt) and an in-flight task can be reconstructed from run records, in_progress beads or open PRs, the agent resumes the most recent one after stating the reconstructed task in one line, starting with read-only and low-risk lanes. It asks one question only when no task can be reconstructed or the next step is a blocking gate. Ensemble's own resume entry points resume the most recent active run without asking which.

Basis: one question, "which prior thread does 'continue' mean?", blocked the pipeline for 426 min right after a consent-gate skill told the agent not to proceed on a generic continue (Review sec. 2.2, R2a). That skill is a user-level skill outside this repository (a search of `packages/`, `docs/` and `scripts/` finds no copy), so this requirement ships the replacement behaviour as an ensemble skill and the owner edits the user-level one (OQ-8). Ensemble's `new-feature` already resumes the active run when given no arguments but asks "Retry <stage>?" for a failure-parked run (`packages/development/commands/new-feature.yaml`, No Arguments step).

- AC-032-1: Given a session with an active run record, an in_progress bead or an open PR from this session, when the user sends a bare "continue", then the agent resumes the most recent of them and states the reconstructed task before acting.
- AC-032-2: Given no in-flight task can be reconstructed, when the user sends a bare "continue", then the agent asks one question listing the candidates it found and blocks only on that.
- AC-032-3: Given two candidate tasks, when the agent resumes, then it picks the one with the latest recorded activity, says so and keeps the other listed under decisions.
- AC-032-4: Given a failure-parked run, when the user resumes it with no arguments, then the resume itself is the retry request and no "Retry?" question is asked.

### Flaky-test policy

Test failures are defects. The recipe's commands are stack-specific and live in the stack profile; the policy is transferable.

### REQ-033: Failing tests are fixed at the root and never retried, quarantined or loosened
**Priority:** Must | **Scope:** transferable

Ensemble's commands, agents and CI guidance never add automatic retries, quarantine tags, skips, wider timeouts or weaker assertions to make a failing test pass. A failed required test is a defect: reproduce it, fix the cause and push the fix. This extends the existing `pr-merge` constraint to every command and agent brief, and the CI audit flags retry wrappers and failure-tolerant flags on steps that feed a required context. A re-run of a required job after an infrastructure failure that occurred before the test command started is allowed only as a recorded operator action [NEEDS CLARIFICATION: may an operator re-run a required job after an infrastructure failure before the test command started, or is every re-run treated as a retry?].

Basis: 12 of 123 required-job runs were red (9.8%), 10 of them flakes, every one at the test step; 8 PRs (17%) were flake or red-main repairs; about 15 agent-hours of flake sweeps fixed about 12 test races and surfaced 2 product races (Review sec. 2.5, 4). The review's retry-once-and-quarantine recommendation (R5) was rejected by the owner on 2026-10-27 in favour of root-cause fixes. `/ensemble:pr-merge` already forbids deleting, skipping, disabling or weakening a test (`packages/git/commands/pr-merge.yaml`, constraints).

- AC-033-1: Given a workflow step that feeds a required context wraps the test command in a retry or sets it to continue on error, when the CI audit runs, then it reports an error naming the step.
- AC-033-2: Given an agent is asked to fix a failing test, when it proposes a change, then the change contains no skip, quarantine tag, retry, wider timeout or loosened assertion unless a human approves that specific change.
- AC-033-3: Given a required check failed on an auto-merge PR, when the hand-off report or the flow report is read, then the failure is visible as an open defect with its test and replay record and nothing re-runs it in the background.

### REQ-034: Every red test run leaves a replayable record
**Priority:** Must | **Scope:** transferable

When a required test run fails, the hand-off report and the bead record the failing test, the replay handle the runner printed (a random seed, an order file or a shard id), the command that replays it, the log location and a class: failing test, guard-only (the run exited non-zero after every test passed, for example a leak guard), or infrastructure (failed before the test command started). Replaying the logged handle on the single failing file comes before any bisection.

Basis: one failure was guard-only (6,136 tests passed and then a leak guard raised); a pair-bisection took 5.5 h; the review's rule: replay the seed printed in the log before bisecting (Review sec. 2.5, R4). Foreman's ExUnit seed is one example of a replay handle.

- AC-034-1: Given a red run whose log prints a replay handle, when the record is written, then it contains the test id, the handle, the replay command and the log path.
- AC-034-2: Given a run that exits non-zero with zero failed tests, when it is classified, then it is "guard-only" and names the guard that raised.
- AC-034-3: Given a suspected order-dependent failure, when an agent investigates, then it replays the logged handle on the single file before any bisection and records the result.

### REQ-035: A flake-reproduction recipe is a shipped, editable skill
**Priority:** Should | **Scope:** per-stack

A skill describes how to reproduce and root-cause an order or timing failure: a private database per run, a bounded pool, replay with the logged handle under CPU load, run counts with the confidence bound reached (zero failures in 3/p runs excludes rate p at 95%), the time box of REQ-018 and parking the bead with the harness. The commands are stack-specific and live in the stack profile.

Basis: 121 clean runs bound an unreproduced failure's rate below about 2.5% at 95%, and excluding a 1% flake takes about 300 runs; 93% of test time ran in non-async files and silent gaps of 5 s or more made up 46-59% of test wall time, some following connection-refused log lines [INFERENCE: backoff to a closed port] (Review sec. 2.3, R4).

- AC-035-1: Given a flake investigation starts, when the agent loads the skill, then its brief names the private database, the handle replay and the run-count rule.
- AC-035-2: Given a maintainer edits the recipe, when the next investigation starts, then the edit applies with no code change.

### Live verification and definition of done

### REQ-036: Live runs are reserved for what mocks cannot reach
**Priority:** Must | **Scope:** transferable

A live verification item (against a real external system) is allowed only if its brief names the defect class it can find and why a mock plus a recorded real fixture cannot. Live items run once per workstream on the integrated tree, not per PR, inside the REQ-018 time box. Live tests that publish to public repositories run under a configured throwaway identity so they need no consent; without one they ask.

Basis: 9 live workstreams cost 19.6 agent-hours and first exposed 5 product defects (merge-gate head pin, Create-PR button bypassing the gate, approvals expiring at 60 s, a fix agent without approval mode, a worker working-directory leak) while others were confirmatory or empty (three assertion-hardening PRs, one bead that took 6 PRs over 4.7 days, one unreproduced failure); one consent question about publishing the owner's identity took 66 min (Review sec. 2.2, 4, R10). The shipped GitHub host adapter's create and merge capabilities have never been executed live (`packages/git/skills/adapter-host-github/SKILL.md`, Known limits), so the arming capability of REQ-001 needs a real-host proof.

- AC-036-1: Given a live item is proposed, when its brief is built, then it contains the defect class and the reason mocks cannot reach it, or the orchestrator does not dispatch it.
- AC-036-2: Given a live item targets a public repository, when it runs, then it uses the configured throwaway identity or asks once before publishing any identity.
- AC-036-3: Given a workstream with several PRs, when live verification is planned, then one live run is scheduled on the integrated tree and not one per PR.

### REQ-037: Evidence is preserved on failure and kept out of PRs
**Priority:** Should | **Scope:** transferable

A live or end-to-end run that fails preserves its evidence (logs, transcripts, state) under a stable, ignored evidence path named by run and time before any cleanup or retry, and leaves a summary of at most 50 lines in the repository's acceptance documents. Raw transcripts are not committed to PRs.

Basis: the evidence-preserving harness landed 3.6 h into a 311-min investigation and produced the root cause; PR #667 (39k lines, 422 files) exceeded the review service's 300-file limit (Review sec. 2.1, R4, R10).

- AC-037-1: Given a live run fails, when cleanup begins, then the evidence directory already exists with the run's logs and state.
- AC-037-2: Given a summary is required, when it is written, then it is at most 50 lines and links the evidence path.
- AC-037-3: Given staged files include more raw evidence files than the configured limit, when a command prepares a PR, then it warns and names the paths.

### REQ-038: Done is evaluated from host and ledger state
**Priority:** Must | **Scope:** transferable

A workstream is done only when all hold: its PR is merged on the base branch; the base-branch run for that commit is green; its beads are closed with evidence (REQ-025); any user-facing change is documented; and, for work that crosses an external boundary, the live-evidence path is recorded. A read-only definition-of-done check reports each condition from host and ledger state.

Basis: 18 of 64 beads were closed before their PR merged and 42 of 64 more than 24 h after (16 over 7 days); one bead took 6 PRs over 112 h (Review sec. 2.6, R12). The repository's own definition of done (`docs/standards/constitution.md` section 3 and CONTRIBUTING "PR Flow") lists green required checks and the review stopping rule but not merge, the base-branch result or bead evidence.

- AC-038-1: Given a workstream's hand-off claims done, when the check runs, then each of the five conditions is reported met, not met or unverifiable with its source.
- AC-038-2: Given the PR is merged but the base-branch run is red or absent, when the check runs, then done is not reported.
- AC-038-3: Given a bead was closed before its PR merged, when the check runs, then it reports the ordering violation.

### Measurement and owner digest

### REQ-039: A repeatable, read-only flow report measures delivery
**Priority:** Must | **Scope:** transferable

On demand, a flow report computes for a repository and window: PR created-to-merged (median, mean, p90, max, sum), created-to-first-green, idle-green time, pushes and superseded runs per PR, required-job time per job and per step where the host exposes it, red-job rate with each red classified (REQ-034), review rounds and review-loop time, manual merges and manual dismissals, bead closure lag and status accuracy, branch and worktree counts, and, where a source exists, the time blocked on questions and the workers alive. Values whose source is unavailable are reported "not measured" with the missing source, never zero [NEEDS CLARIFICATION: which portable event records when a question was opened and answered, so blocked time is measurable without a host's session transcripts: opt-in telemetry timestamps or lifecycle hook events?].

Basis: every number in this PRD's baseline was assembled by hand from 46 PRs, 175 CI runs, 20 job logs, check suites, the ledger and 61 session transcripts, and the review lists what it could not measure: `--cover` overhead, per-test timings, token cost, review billing, owner availability, agents outside the registered sessions and the cause of the auto-merge lag (Review sec. 2.8). `local-ci-baseline.js` already provides fail-closed cohort statistics (median and p75 by linear interpolation) and `docs/guides/pr-review-cycle-time-pilot.md` the read-only `gh` queries; `ensemble-telemetry` records only a timestamp, a session, a kind and a name.

- AC-039-1: Given the same repository and window, when the report runs twice, then the metrics are identical.
- AC-039-2: Given a metric's source is unavailable, when the report runs, then that metric reads "not measured" and names the missing source.
- AC-039-3: Given the report runs, when host, repository and ledger state are compared before and after, then nothing changed.
- AC-039-4: Given a window with fewer PRs than the minimum sample, when the report runs, then each statistic shows its sample size and is flagged low-sample.

### REQ-040: The owner reviews finished work in batches through a digest
**Priority:** Must | **Scope:** transferable

At the end of every orchestrated batch and on demand, the report command produces an owner digest designed to be read in one sitting: first the interrupts and escalations still open, then the decisions taken by default (each with how to reverse it), then the work merged with its evidence (PR, head commit, base-branch result, beads closed with their evidence path), parked investigations with their harness, valid findings left open with their bead ids, and the measures against targets. A batch with nothing to review says so explicitly. The digest is written to a configured repository path or printed, never posted to an external system by ensemble, and it contains no prompt text, secret or path outside the repository.

Basis: the owner typed "read advisors concerns" 6 times and 5 of 77 owner prompts asked what an agent was waiting for (Review sec. 2.2, 4). After hands-off merge removes the green-and-unmerged 63% and the interrupt policy removes blocked questions, the remaining ceiling is the owner's availability, so the owner's review must be batchable (headline of this PRD).

- AC-040-1: Given a completed batch, when the digest is produced, then it lists open interrupts first, then default decisions with how to reverse each, then merged work with evidence, then parked investigations and open findings.
- AC-040-2: Given a batch with no decisions, no interrupts and no open findings, when the digest is produced, then it states that nothing needs review.
- AC-040-3: Given a digest, when its entries are compared with host and ledger state, then every merged PR and closed bead it lists exists there with the cited evidence.
- AC-040-4: Given a digest, when it is scanned, then it contains no prompt text, credential or path outside the repository.

### REQ-041: Idle-green time is attributed to a cause
**Priority:** Should | **Scope:** transferable

For each PR that merged more than 2 minutes (editable) after its last required check turned green, the report lists the candidate causes it can read from the host timeline (non-required statuses still pending, review or dismissal events, base-branch updates, approvals) and says "unexplained" when none fits.

Basis: #678 merged 5 min 16 s after green while #679 merged in 26 s under the same settings, and the cause was not found; of 2,074 idle minutes 1,580 were overnight, 245 waited for a review that never came, 101 were manual dismissals and 117 had no blocker found (Review sec. 2.1, 2.7).

- AC-041-1: Given a PR that merged 2 minutes or more after its last required check went green, when the report runs, then it lists the host timeline events inside that interval.
- AC-041-2: Given no event fits, when the report runs, then the PR is labelled "unexplained" and no cause is assigned.

### REQ-042: Targets are compared with a stored baseline and never claimed on thin data
**Priority:** Must | **Scope:** transferable

The report compares a window with a stored baseline snapshot and the success measures of this PRD and states each as met, not met or unproven. A target is unproven until the post-change cohort reaches the minimum sample (20 merged PRs after enablement [NEEDS CLARIFICATION: align with the 20 PRs and 30 days of PRD-2026-82b6a138 REQ-020, or use PRs alone?]) and is never claimed from historical durations alone.

Basis: PRD-2026-82b6a138 (REQ-020) and PRD-2026-4dec59b8 (REQ-013) already require a baseline and no claim on thin data, and `local-ci-baseline.js` reads `unproven` unless every condition is proven; this PRD's baseline covers one repository for four days (Review header, sec. 2.1).

- AC-042-1: Given a baseline snapshot and a post-change window under the minimum sample, when the report runs, then each target reads "unproven".
- AC-042-2: Given a baseline snapshot and a sufficient window, when a measure meets its target, then it reads "met" with both values and both sample sizes shown.
- AC-042-3: Given no baseline snapshot exists, when the report runs, then it says so and records the current window as the baseline only on an explicit request.

### Cross-cutting requirements

### REQ-043: Everything new is on demand, read-only and daemon-free
**Priority:** Must | **Scope:** transferable

The flow doctor, CI audit, ledger audit, flow report, owner digest and definition-of-done check run in the operator's session when invoked, read state through the existing governed tool boundary, propose but never apply changes, and add no scheduler, background process, retry or recovery (constitution rule 4: Foreman owns durable activation). Time-based rules (time box, stale threshold, idle-green threshold) are evaluated when a check runs or at a wave barrier. A scheduled full-suite workflow in a CI template runs on the CI host's own schedule and is not an ensemble process.

Basis: constitution rule 4; PRD-2026-4dec59b8 REQ-012 (no second dispatcher) and PRD-2026-8d825f54 non-goals (no recovery, retries or scheduling); the review's R5 retry mechanism and any watchdog are not adopted.

- AC-043-1: Given any new capability is installed, when no operator invokes it, then nothing runs in the background.
- AC-043-2: Given a check capability (doctor, audits, report, digest or definition-of-done check) ran, when its run record is inspected, then it holds no host or ledger write unless the operator confirmed a proposed command.

### REQ-044: Each new capability is reachable from its shipped entry point and can fail
**Priority:** Must | **Scope:** transferable

Every new capability and guard rule is reachable from the product's installed entry points on every supported runtime, and each is shown to fail on a deliberately broken input before it is trusted (constitution rules 6 and 7). Where a runtime cannot enforce a rule (no hook support), the rule is stated in the command text and detected by an audit, and the gap is listed in the documentation.

Basis: constitution rules 6 and 7; ensemble's guards ship as Claude Code hooks only (`packages/guards/hooks/hooks.json`) and fail open on any internal error (`packages/guards/README.md`); a search of `packages/pi/src`, `packages/pi-extension/src` and the Codex and OpenCode generators finds no guard equivalent [INFERENCE: a hook-capable extension point may exist in the Pi/OMP harness outside this repository].

- AC-044-1: Given the installed product on a supported runtime, when a user invokes the entry point of each capability, then it runs end to end and is not only unit-tested.
- AC-044-2: Given each check and guard rule, when it runs against a deliberately broken input, then it fails and the evidence is recorded in the phase's exit record.
- AC-044-3: Given a runtime without guard support, when the documentation is read, then it lists the rules that are detect-only there.

### REQ-045: Policy values live in editable skills and configuration
**Priority:** Must | **Scope:** transferable

Thresholds and lists ship with documented defaults in skills or repository configuration that a user can edit without a toolchain, a rebuild or a release (constitution rule 8): the investigation time box, the stale threshold, the idle-green threshold, the fold-in line limit, hot files, the non-code and tests-read path lists, gating finding categories, gate classification and interrupt classes, the test-bead marker, standing authorizations, shared service limits, release-channel branches and the stack profiles.

Basis: constitution rule 8; every threshold in this PRD comes from one repository's four-day window [INFERENCE: other repositories will need other values].

- AC-045-1: Given a default value, when a user edits it in the documented file, then the next run uses the edited value with no build step.
- AC-045-2: Given a configuration value is invalid or out of range, when a command loads it, then it stops and names the key and the allowed range.

### REQ-046: Generated artifacts for every runtime match their sources
**Priority:** Must | **Scope:** transferable

Command, agent and skill changes are made in their sources and regenerated for Claude Code, Pi/OMP, Codex and OpenCode; generation checks, validation and the version policy pass, and package versions are bumped together where required.

Basis: ensemble has three independent generators and CI fails on stale output (`.github/workflows/validate.yml` and `generated-drift.yml`, plus the Pi, Codex and OpenCode generation workflows); the Pi output is what OMP loads; `CLAUDE.md` lists the regeneration commands and the version-sync rule.

- AC-046-1: Given a source change, when generation runs for all runtimes, then a token unique to the change appears the same number of times in the source, the generated Markdown, the Codex skill and the Pi prompt.
- AC-046-2: Given generation and validation run, when they finish, then they pass and no unrelated artifact changed.

### REQ-047: Credentials, identities and inputs are protected
**Priority:** Must | **Scope:** transferable

No capability prints, stores or commits a credential or token; the doctor and the report use the operator's own host login; repository, branch, PR and configuration inputs are validated at the boundary; reports cite counts and identifiers, not secrets, prompt text or paths outside the repository.

Basis: constitution rules 1 and 2; the telemetry posture (opt-in; no prompt text, tool inputs or outputs, tokens or paths) and the local-CI status publisher's token redaction (`packages/development/lib/local-ci-status.js`); a standing authorization must not expose the operator's identity (REQ-031).

- AC-047-1: Given any run record or report, when it is scanned for token patterns, then none is found.
- AC-047-2: Given an invalid repository, branch, PR or configuration value, when a capability receives it, then it stops before any host call and names the invalid input.

### REQ-048: Changed defaults ship with documentation, an opt-out and a migration note
**Priority:** Should | **Scope:** transferable

Each changed default (auto-merge armed, advisory review, no flush by workers, non-blocking gates) is listed in the changelog and the user guide with its per-repository opt-out, and the release that changes defaults is marked according to the repository's version policy.

Basis: the 7.0.0 surface consolidation retired commands outright with changelog notes; here the owner wants the new behaviour as the default, so unconfigured repositories change behaviour [INFERENCE: a zero-change-when-unconfigured guarantee is not possible for defaults that arm auto-merge or stop agents flushing].

- AC-048-1: Given a repository that does nothing after upgrading, when a PR-producing command runs, then it applies the new defaults only where the doctor passes and says so in the hand-off report.
- AC-048-2: Given the changelog and the user guide, when a user searches for a changed default, then each lists its opt-out key.

## Acceptance Criteria Summary

| REQ | Description | Priority | Scope | AC Count |
|---|---|---|---|---|
| REQ-001 | Auto-merge is armed when a command opens its own PR | Must | transferable | 5 |
| REQ-002 | Commands end at a hand-off, not at a wait | Must | transferable | 3 |
| REQ-003 | A flow doctor verifies merge prerequisites on the host | Must | transferable | 5 |
| REQ-004 | Advisory signals never block the merge | Must | transferable | 3 |
| REQ-005 | Release channels stay explicit and the base branch keeps a semantic-conflict net | Must | transferable | 3 |
| REQ-006 | Stack profiles carry every stack-specific CI detail | Must | per-stack | 3 |
| REQ-007 | Dependency caches are keyed on the toolchain and the lockfile | Must | transferable | 3 |
| REQ-008 | Split test jobs report through one aggregate required context | Should | per-stack | 4 |
| REQ-009 | Non-code changes skip heavy jobs without leaving a required context pending | Must | transferable | 4 |
| REQ-010 | Superseded runs are cancelled and slow tests are visible | Should | transferable | 3 |
| REQ-011 | A CI conformance audit keeps required contexts reporting | Must | transferable | 3 |
| REQ-012 | Automated review is advisory and on demand | Must | transferable | 3 |
| REQ-013 | Only defects in logic-bearing code gate | Must | transferable | 4 |
| REQ-014 | Review scope and size are controlled before a PR opens | Should | transferable | 2 |
| REQ-015 | One branch, one PR and one owner per workstream | Must | transferable | 3 |
| REQ-016 | Concurrent agents get private test resources within shared limits | Must | transferable | 4 |
| REQ-017 | Worktrees and branches are cleaned up after each batch | Should | transferable | 2 |
| REQ-018 | Investigations are time-boxed and evidence comes first | Must | transferable | 4 |
| REQ-019 | Every worker ends with a hand-off report in a fixed shape | Must | transferable | 4 |
| REQ-020 | Every dispatchable skill honors the `--foreman` convention | Must | transferable | 3 |
| REQ-021 | The tracker's scheduler is the only scheduler, with no fallback | Must | transferable | 3 |
| REQ-022 | A dispatcher-owned PR is never created by a skill | Must | transferable | 3 |
| REQ-023 | A dispatcher's managed-run environment is honored | Should | transferable | 2 |
| REQ-024 | The ledger has defined states and a claim protocol | Must | transferable | 4 |
| REQ-025 | Closing a bead requires evidence | Must | transferable | 4 |
| REQ-026 | Test beads are closed only with failing-before evidence | Must | transferable | 2 |
| REQ-027 | Workers never flush the ledger and the parent is the single writer | Must | transferable | 5 |
| REQ-028 | A read-only ledger audit command reports status accuracy | Must | transferable | 5 |
| REQ-029 | Gates on reversible actions do not block | Must | transferable | 4 |
| REQ-030 | Only a closed list of conditions may interrupt the owner | Must | transferable | 3 |
| REQ-031 | Standing authorizations replace repeated confirmations | Should | transferable | 4 |
| REQ-032 | A bare "continue" resumes the most recent task | Must | transferable | 4 |
| REQ-033 | Failing tests are fixed at the root and never retried, quarantined or loosened | Must | transferable | 3 |
| REQ-034 | Every red test run leaves a replayable record | Must | transferable | 3 |
| REQ-035 | A flake-reproduction recipe is a shipped, editable skill | Should | per-stack | 2 |
| REQ-036 | Live runs are reserved for what mocks cannot reach | Must | transferable | 3 |
| REQ-037 | Evidence is preserved on failure and kept out of PRs | Should | transferable | 3 |
| REQ-038 | Done is evaluated from host and ledger state | Must | transferable | 3 |
| REQ-039 | A repeatable, read-only flow report measures delivery | Must | transferable | 4 |
| REQ-040 | The owner reviews finished work in batches through a digest | Must | transferable | 4 |
| REQ-041 | Idle-green time is attributed to a cause | Should | transferable | 2 |
| REQ-042 | Targets are compared with a stored baseline and never claimed on thin data | Must | transferable | 3 |
| REQ-043 | Everything new is on demand, read-only and daemon-free | Must | transferable | 2 |
| REQ-044 | Each new capability is reachable from its shipped entry point and can fail | Must | transferable | 3 |
| REQ-045 | Policy values live in editable skills and configuration | Must | transferable | 2 |
| REQ-046 | Generated artifacts for every runtime match their sources | Must | transferable | 2 |
| REQ-047 | Credentials, identities and inputs are protected | Must | transferable | 2 |
| REQ-048 | Changed defaults ship with documentation, an opt-out and a migration note | Should | transferable | 2 |

## Dependency Map

- REQ-001 depends on REQ-003, REQ-005, REQ-022.
- REQ-002 depends on REQ-001, REQ-019.
- REQ-003 depends on REQ-011.
- REQ-004 depends on REQ-003.
- REQ-005 depends on REQ-003.
- REQ-007 depends on REQ-006.
- REQ-008 depends on REQ-006.
- REQ-009 depends on REQ-006.
- REQ-010 depends on REQ-006.
- REQ-011 depends on REQ-006, REQ-007, REQ-008, REQ-009, REQ-010.
- REQ-012 depends on REQ-004.
- REQ-013 depends on REQ-012.
- REQ-014 depends on REQ-003, REQ-012.
- REQ-015 depends on REQ-019.
- REQ-017 depends on REQ-015.
- REQ-018 depends on REQ-045.
- REQ-022 depends on REQ-020.
- REQ-023 depends on REQ-020.
- REQ-025 depends on REQ-024.
- REQ-026 depends on REQ-025.
- REQ-027 depends on REQ-021, REQ-024.
- REQ-028 depends on REQ-018, REQ-024, REQ-025, REQ-026, REQ-027.
- REQ-029 depends on REQ-019.
- REQ-030 depends on REQ-029.
- REQ-031 depends on REQ-029, REQ-045, REQ-047.
- REQ-032 depends on REQ-029.
- REQ-033 depends on REQ-011.
- REQ-034 depends on REQ-019.
- REQ-035 depends on REQ-016, REQ-018, REQ-034.
- REQ-036 depends on REQ-018, REQ-029.
- REQ-037 depends on REQ-036.
- REQ-038 depends on REQ-005, REQ-019, REQ-025.
- REQ-039 depends on REQ-028, REQ-034.
- REQ-040 depends on REQ-019, REQ-030, REQ-039.
- REQ-041 depends on REQ-039.
- REQ-042 depends on REQ-039.
- REQ-044 depends on REQ-043.
- REQ-048 depends on REQ-001, REQ-012, REQ-027, REQ-029.

**Clusters implemented together:** {REQ-001 to REQ-005, REQ-022} hands-off merge and its dispatcher boundary; {REQ-006 to REQ-011} CI profiles, templates and audit; {REQ-012 to REQ-014} review policy; {REQ-015 to REQ-019} orchestration; {REQ-020 to REQ-023} dispatcher contract; {REQ-024 to REQ-028} ledger; {REQ-029 to REQ-032, REQ-040} interrupts and digest; {REQ-033 to REQ-038} flaky tests, live verification and done; {REQ-039 to REQ-042} measurement; {REQ-043 to REQ-048} cross-cutting.

**Circular dependencies:** none. Two pairs reference each other in prose (REQ-001 with REQ-022, REQ-030 with REQ-040); the edges above run one way only, from REQ-001 to REQ-022 and from REQ-040 to REQ-030, and REQ-022 and REQ-030 carry no edge back.

## Delivery Phases and Package Mapping

Requirement bodies stay free of implementation choices; this mapping is indicative and the TRD decides. Phases 1 to 3 can proceed in parallel after Phase 0; Phase 5 needs the outputs of Phases 2 to 4.

| Phase | Delivers | Where it lands (sources, never generated output) | Exit evidence | Requirements |
|---|---|---|---|---|
| 0. Decisions and baseline | PRD refined and locked, markers resolved (OQ-1 to OQ-6), design decisions confirmed, Foreman baseline frozen, ensemble baseline captured | `docs/PRD/`; the capture procedure of `docs/guides/pr-review-cycle-time-pilot.md` with `packages/development/lib/local-ci-baseline.js` | locked PRD; stored baseline snapshot | REQ-042 |
| 1. Dispatcher contract and small source fixes | `--foreman` on `beads-build`; the `br ready` sentence removed; a required, fail-closed pre-schedule flush; no PR creation or push by `implement-trd-beads` under `--foreman`; managed-run environment honored; a conformance check for dispatchable commands | `packages/development/commands/{beads-build,beads-build-wave,implement-trd-beads}.yaml`; `packages/development/agents/beads-build-wave.yaml`; `packages/development/skills/implement-trd-beads-reference/`; `packages/development/lib/` (conformance check) | the check passes and fails on a mutated command; a `--foreman` run of `beads-build` shows no prompt and no PR | REQ-020, REQ-021, REQ-022, REQ-023 |
| 2. Hands-off merge and the flow doctor | optional host capabilities (arm auto-merge, read protection and merge settings) with fallbacks; GitHub adapter variants (allowlist change needs explicit approval) and Azure DevOps declaring them unavailable; arming and hand-off in PR-producing commands; `/ensemble:pr-merge` as the rescue flow; the flow doctor and its entry point (OQ-1) | `packages/development/toolchain/categories/host.yaml` and regenerated `docs/toolchain/contracts/host.md`; `packages/git/skills/adapter-host-github/`; `packages/infrastructure/skills/adapter-host-azure-devops/`; `packages/git/commands/pr-merge.yaml`; `packages/development/commands/{fix-issue,implement-trd-beads}.yaml`; `packages/development/lib/`; `packages/pi-extension/src/extension.ts` if a front door is added; user guide and `CONTRIBUTING.md` PR Flow | the doctor run against ensemble's own `dev` reports every item; a real PR on a protected branch is armed and merges by itself (AC-001-5) | REQ-001 to REQ-005, REQ-043 |
| 3. Ledger and orchestration | single-writer and close-evidence guard rules; orchestrator, wave and worker sources updated (no worker flush, claim and release, hand-off, private resources, time box, cleanup); the ledger audit; state definitions; `AGENTS.md` guidance outside the tool-managed block | `packages/guards/{hooks,lib}`; `packages/development/agents/tech-lead-orchestrator.yaml`; `packages/development/commands/{beads-build,beads-build-wave,implement-bead}.yaml`; `packages/development/skills/adapter-tracker-beads/`; `packages/development/lib/`; `AGENTS.md` | a parallel wave runs with no worker flush; the guard blocks a worker flush under Claude Code and the audit flags it elsewhere; the audit run on this repository's ledger reports findings | REQ-015 to REQ-019, REQ-024 to REQ-028 |
| 4. CI guidance, review, flaky-test and live policies, done | stack profiles (Node with npm, Elixir with mix); CI templates and the CI audit; the review-policy, flake-recipe and live-verification skills; the definition-of-done check | new skills under `packages/development/skills/` and `packages/quality/skills/` (package choice in the TRD); `packages/development/lib/`; reuse of `packages/assessment/skills/assess-cicd`, `packages/quality/skills/pr-review-remediation` and `adapter-review-coderabbit` | each audit rule fails on a broken fixture; a docs-only PR on a real protected branch merges without heavy jobs (AC-009-4); a partition mutation turns the aggregate red (AC-008-4) | REQ-006 to REQ-014, REQ-033 to REQ-038 |
| 5. Interrupts, digest and measurement | gate classification and interrupt skills; standing authorizations in the confirm layer; the `new-feature` resume change; the flow report and owner digest; an optional timestamp-only telemetry kind (OQ-5); the first measured cohort | `packages/development/lib/toolchain/` confirm layer and `toolchain-cli.js`; command gate text in `new-feature`, `implement-trd-beads`, `beads-build` and `pr-merge`; `packages/development/lib/local-ci-baseline.js` reuse; `packages/telemetry` (optional) | a 20-PR post-change cohort is measured and every target reads met, not met or unproven | REQ-029 to REQ-032, REQ-039 to REQ-042 |

**Cross-runtime rules for every phase** (REQ-044, REQ-046): edit the YAML, `SKILL.md` and agent sources only, then run `npm run generate`, `npm run generate:codex`, `npm run generate:opencode` and `npm run generate:pi` from the repository root; bump each changed package's `package.json`, `.claude-plugin/plugin.json` and `marketplace.json` entry together and keep the release set aligned; run `npm run validate`, `npm run generate:validate` and the touched packages' tests. Guard rules ship as Claude Code hooks with an audit as the detective control on Pi/OMP, Codex and OpenCode. Keep each PR near 400 hand-written lines and give each new component (a guard rule, a CLI) its own PR (`CONTRIBUTING.md`, PR Flow).

## Risks

| Risk | Likelihood and impact | Mitigation | Requirements |
|---|---|---|---|
| R-01: non-strict required checks let two green PRs break each other on the base branch | possible, serious | a base-branch run verified by the doctor; a failed base run becomes a bead; Foreman's push CI caught 3 reds (all flakes) and 0 conflicts in 46 runs | REQ-003, REQ-005 |
| R-02: valid findings are lost when per-push review stops | likely, serious | one aggregate review per workstream; gating categories; unfixed valid findings tracked (2 of 10 were unfixed under per-push review) | REQ-012, REQ-013 |
| R-03: without retry or quarantine, flakes are visible stalls on auto-merge PRs (the review recommended retry-once and quarantine, R5, and the owner rejected it) | certain at a 9.8% red rate, moderate | failures are defects with a replayable record, a recipe and a digest entry; the cost is accepted and paid by root-cause fixes | REQ-033, REQ-034, REQ-035, REQ-040 |
| R-04: prompt-only rules are ignored; guards are Claude Code hooks only and fail open | likely, serious | detective audits, command text, a list of detect-only runtimes; OQ-3 on harness hooks | REQ-018, REQ-027, REQ-044 |
| R-05: standing authorizations widen the blast radius | possible, serious | reversible actions only, configuration files only, identity and visibility excluded, every use logged and digested | REQ-031 |
| R-06: the doctor cannot read settings (permission) or the host differs | likely, moderate | unverifiable is never pass; capabilities are optional with an explicit unavailable outcome | REQ-003 |
| R-07: partitioning exposes order dependence | possible, moderate | a scheduled full single-runner run; partitioning is a per-stack option (Should) | REQ-008 |
| R-08: a document that tests read is mislabelled non-code | possible, moderate | an explicit tests-read list, a conservative default and a live proof before adoption | REQ-009 |
| R-09: four days of one repository generalize poorly | likely, moderate | editable thresholds; targets unproven until a 20-PR cohort; stack-neutral rules separated from profiles | REQ-006, REQ-042, REQ-045 |
| R-10: conflicts with earlier PRDs and with Foreman's own operator merge gate | possible, moderate | the Relationship section, a follow-up refine of PRD-2026-82b6a138, OQ-9 | REQ-001, REQ-004 |
| R-11: time-based rules drift into a scheduler (constitution rule 4) | possible, serious | evaluated at checks and wave barriers only; no timer or watchdog | REQ-018, REQ-043 |
| R-12: the GitHub adapter allowlist change is security-sensitive | certain to need approval | explicit approval under constitution section 4; a narrow allowlist limited to arming and protection reads | REQ-001, REQ-003 |
| R-13: four runtimes drift apart | likely, moderate | sources-first changes, CI generation checks and token-count parity | REQ-046 |
| R-14: concurrent claim and close writes from parallel tracks hit SQLite lock errors [INFERENCE: not measured] | possible, moderate | single-writer discipline for flush; Foreman's lease for dispatched runs; count lock errors in the first cohort | REQ-027 |
| R-15: coupling to Foreman: skill names, flags and validator lists drift | likely, moderate | the IC-8 consumer check, the conformance check and OQ-10 | REQ-020, REQ-022 |

## Open Questions

Each question has a proposed default that the requirements already assume; none blocks refinement.

- **OQ-1 (REQ-003):** one new task-oriented front door with subcommands for the doctor, the audits, the report and the done check, or modes of `/ensemble:pr-merge`, `/ensemble:retro` and the existing audit commands? Proposed: one front door, following PRD-2026-87e64cc6.
- **OQ-2 (REQ-017):** per-track worktrees or serialised tracks for concurrent work in `beads-build-wave`? Proposed: isolated worktrees for independently dispatched workers; tracks of one wave stay on one tree until the first cohort shows collisions [INFERENCE].
- **OQ-3 (REQ-027):** is a harness-level hook available on Pi/OMP, Codex and OpenCode? Proposed: detect-only on those runtimes until one exists.
- **OQ-4 (REQ-033):** may an operator re-run a required job after an infrastructure failure before the test command started? Proposed: yes, as a recorded operator action, never automatic.
- **OQ-5 (REQ-039):** which portable event records when a question was opened and answered? Proposed: an opt-in telemetry kind with timestamps only (no prompt text), otherwise "not measured".
- **OQ-6 (REQ-042):** cohort size and duration. Proposed: 20 merged PRs after enablement and no day minimum, because the Foreman repository merged 46 PRs in 4 days and ensemble about 30 in 9 days (PRD-2026-4dec59b8 baseline).
- **OQ-7:** archive the Foreman review in this repository? It is public, names PRs and describes one unfixed finding. Proposed: not archived; this PRD carries the aggregate numbers, and a redacted copy under `docs/research/` is added only on request.
- **OQ-8 (REQ-032):** the owner's user-level consent-gate skill (its rule 3 holds on a generic "continue") contradicts REQ-032 and lives outside this repository. Proposed: the owner edits it in the same window.
- **OQ-9:** should Foreman's operator merge gate (`approve-merge`, Foreman `docs/user-guide.md`) honor the `merge on green` standing authorization of REQ-031? A Foreman-side decision; ensemble leaves merge policy to the dispatcher (REQ-022).
- **OQ-10 (REQ-020):** who aligns the skill names Foreman calls (`ensemble-full-*`) and the five `ensemble-*` names in its `prd.yaml` with the validator's known list and with the names this repository ships (IC-8)? A Foreman-side check; ensemble supplies the name list.
- **OQ-11:** confirm the thresholds taken from the review or chosen here: 2 h time box, 45 min evidence cap, 4 h stale threshold, 2 min idle-green, 30-line fold-in, 25 slowest tests, 20-PR cohort and the targets marked [INFERENCE]. Proposed: accept as editable defaults.
- **OQ-12:** add a constitution rule (for example "no gate blocks on a reversible action") or amend rule 4's wording on time-based checks? Proposed: no amendment now; `docs/standards/constitution.md` is a protected path and any change needs the user's `/ensemble-approve`.

## Approvals and Decision Ownership

- **Approver:** the Ensemble repository owner (maintainer); the Foreman repository owner for REQ-020 to REQ-023 (the same person at authoring).
- **Acceptance criteria the approver judges against:** (1) REQ-001 to REQ-005 demonstrated live on a protected branch (AC-001-5, AC-008-4, AC-009-4); (2) constitution rule 4 held (REQ-043); (3) the five design decisions under Notes confirmed; (4) the success measures read on a 20-PR cohort (REQ-042).
- **Constitution section 4:** the GitHub adapter allowlist change and the `host` contract addition need explicit approval before implementation; this PRD proposes no new dependency, schema change or breaking API change.

## Entry and Exit Criteria

**Entry (before work starts):**

- The owner confirms the design decisions under Notes and answers OQ-1 to OQ-6, or accepts the proposed defaults.
- The Foreman baseline is frozen (Success Measures) and ensemble's own baseline is captured with `docs/guides/pr-review-cycle-time-pilot.md`.
- The implementing branches start from a clean tree.
- Approval for the adapter allowlist and `host` contract change is recorded.

**Exit (observable conditions that end the work):**

- Each phase's exit evidence exists and every new check was shown to fail on a broken input.
- A post-change cohort of 20 merged PRs is measured and each target reads met, not met or unproven.
- Generated artifacts, versions, the user guide, the `CONTRIBUTING.md` PR Flow and the `AGENTS.md` guidance match the sources.
- Foreman's `ensemble-beads-build` integration runs against the shipped skill with `--foreman` (evidence kept in the Foreman repository).

## Adversarial Review

| Issue | Category | Resolution |
|---|---|---|
| Auto-merge with non-strict checks lets semantic conflicts reach the base branch | Gap, safety | REQ-005: a base-branch net and a bead per failed run; Foreman's push CI found 0 conflicts in 46 runs |
| A required context that nothing produces hangs every PR | Missing edge case | AC-003-2 and REQ-011 |
| An aggregate check passes when a partition is skipped or cancelled | Contradiction with "can fail" | AC-008-2 and the mutation proof AC-008-4 |
| Docs-only skip leaves a required context pending through path filters | Missing edge case | REQ-009 uses job-level conditions only; AC-009-3 audit; AC-009-4 live proof |
| "No retry" plus auto-merge turns flakes into silent stalls | Gap | AC-033-3 keeps the failure visible; REQ-034 record; REQ-040 digest; REQ-041 attribution |
| Removing per-push review loses valid findings (10 valid, 8 in product code) | Gap, quality | REQ-012 and REQ-013 keep one aggregate review and gate on defects; unfixed findings are tracked |
| Prompt-only rules are ignored; guards fail open and exist only for Claude Code | Testability | REQ-044, AC-027-4 audit, the detect-only list and OQ-3 |
| A time box without a timer is unenforceable | Feasibility | REQ-018 checks at barriers and in the audit; rule 4 forbids a watchdog |
| Default-taking gates take a wrong default | Safety | reversible-only classes, decisions listed with how to reverse them, real consents kept (REQ-029, REQ-030) |
| Standing authorizations forged from PR or bead text | Security | AC-031-3: configuration files only |
| Metrics from one host's transcripts are not portable | Ambiguity | REQ-039 reports "not measured" with the missing source; OQ-5 |
| This PRD contradicts PRD-2026-82b6a138 (remote review authoritative) | Contradiction | Relationship section: relaxed in part, follow-up refine |
| Skill and flag names are an interface to Foreman and a rename breaks dispatch silently | Gap | REQ-020 conformance check; IC-8; the `CONTRIBUTING.md` consumer check |
| Doctor reads need elevated permission and "unverifiable" could be read as pass | Ambiguity | AC-003-3 forbids "ready" when any item is unverifiable |
| Foreman's own operator merge gate may still hold PRs that ensemble considers hands-off | Gap | REQ-022 leaves PR and merge policy to the dispatcher; OQ-9 |
| Thresholds come from four days of one repository | Feasibility | REQ-045 makes them editable; [INFERENCE] marks; REQ-042 keeps targets unproven until a cohort exists |

## Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Completeness | 4.5 | The nine areas of the brief, the dispatcher contract and the digest and interrupt policy are covered with cited evidence; thresholds beyond the review's recommendations are marked [INFERENCE]. |
| Testability | 4.0 | Every Must and Should requirement has Given/When/Then criteria, including can-fail checks (AC-008-4, AC-011-3, AC-028-5); several targets depend on a 20-PR cohort that does not exist yet. |
| Clarity | 3.5 | Six open markers and unconfirmed thresholds; the entry-point name and enforcement parity on three runtimes are undecided. |
| Feasibility | 4.0 | Builds on existing seams (guards, toolchain adapters, `local-ci-baseline.js`, `br` audit commands); risks are that GitHub create and merge have never run live, hooks are absent on three runtimes and the partition estimate is untested. |
| **Overall** | **4.0** | **PASS** |

**Gate decision: PASS.** Recommended next step: `/ensemble:refine-prd docs/PRD/PRD-2026-bd69b524-delivery-flow-improvements.md` to resolve the six clarification markers.

## Constitution Gate

Constitution Gate: running

| Source | Check | Result |
|---|---|---|
| Section 1 Core principles | Ensemble remains a portable behavior-definition, packaging, validation and local-harness project, not a durable scheduler | PASS: REQ-043 keeps every new capability on demand and read-only |
| Rule 1: No secrets in code | Requirements embed no credentials | PASS: REQ-047 |
| Rule 2: Input validation required | External input validated at boundaries | PASS: REQ-047 (AC-047-2) and REQ-045 (AC-045-2) |
| Rule 3: Tests accompany features | Acceptance criteria are testable | PASS: every requirement has Given/When/Then criteria and each phase has exit evidence |
| Rule 4: Ownership boundary preserved | No durable activation, scheduling, retries, recovery or second dispatcher | PASS: REQ-043 and REQ-018 (checks at barriers, no watchdog), REQ-033 (no retries), REQ-022 (PR and merge policy stay with the dispatcher); auto-merge is the host's own feature |
| Rule 5: Governed tool boundary at runtime | Approval cannot be claimed through prompt text | PASS with a disclosed gap: REQ-031 takes authorizations from configuration only, REQ-027 enforces at the hook boundary where one exists, REQ-044 lists the detect-only runtimes, and the allowlist change needs explicit approval |
| Rule 6: Reachable from the product entry point | Acceptance asserts through the entry point | PASS: AC-044-1 and the live proofs in the phase exits |
| Rule 7: A verification must be able to fail | Checks demonstrably reject bad input | PASS: AC-044-2, AC-008-4, AC-011-3 and AC-028-5 |
| Rule 8: User-changeable behavior in editable artifacts | Thresholds, lists and policies in skills or configuration | PASS: REQ-045, REQ-006, AC-013-4 and REQ-029 |
| Rule 9: A test asserts only the order the code owns | No assertion pins another actor's write position | PASS: criteria assert guaranteed states (the aggregate result, the parent's own flush before its own read), not interleavings of concurrent actors |
| Section 4 Approval requirements | Architecture, dependency, schema, breaking-API and security-sensitive changes need approval | NOTED: the adapter allowlist and the `host` contract addition need explicit approval; no dependency, schema or breaking API change is proposed |

Constitution compliance: passed

## Notes

- **Depth:** DEEP, chosen because the brief spans nine areas plus a dispatcher contract and an owner digest (48 requirements).
- **Ambiguity scan complete:** 6 items marked for clarification (OQ-1 to OQ-6 correspond to the six inline markers; OQ-7 to OQ-12 are decisions or Foreman-side questions that change no requirement text).
- **Design decisions the owner should confirm (the five biggest):**
  1. Auto-merge is armed by default wherever the doctor passes, never on release channels or dispatcher-owned PRs, and commands report "armed" rather than "merged" (REQ-001, REQ-002, REQ-005, REQ-022).
  2. Automated review becomes advisory and runs once per workstream on product code, gating only on defects, which relaxes PRD-2026-82b6a138 (REQ-012, REQ-013).
  3. No retry, quarantine or skip anywhere, with a replayable record instead; the review's R5 is not adopted (REQ-033, REQ-034).
  4. The ledger has one writer: workers never flush, the parent flushes before every scheduling read, guards enforce on Claude Code and audits detect elsewhere; this reverses today's shipped instruction to flush after every mutation (REQ-027).
  5. A closed list of interrupt classes, no blocking on reversible gates, standing authorizations from configuration, a bare "continue" that resumes, and a batched owner digest (REQ-029 to REQ-032, REQ-040).
- **Secondary decisions:** stack profiles carry every stack-specific CI detail so Elixir and Postgres mechanics are examples and not rules (REQ-006); the dispatcher contract pins `--foreman`, a single scheduler, parent-only flush and dispatcher-owned PRs (REQ-020 to REQ-023).
- **What this PRD does not claim:** the review's savings are upper bounds and estimates, the 4-partition result was not run, the automated-review sample was judgmental, and Foreman's `ensemble-beads-build` integration is not complete. Data thinness is marked [INFERENCE] where it matters.
- **Grounding:** each requirement carries a Basis line. 36 of 48 cite the review by section or recommendation number; REQ-009 and REQ-042 cite it in short form (R6, "Review header"); REQ-020 to REQ-023 and REQ-043 to REQ-048 rest on verified repository facts (file paths and line numbers) and the owner's decisions of 2026-10-27, because the review motivates the behaviours they constrain without measuring them.
- **Registration:** PRDs in this repository are hash-named files under `docs/PRD/`; no index file lists them (the directory holds no index, the user guide names the directory only, and the TRD CLI lists PRDs by scanning the directory), so this change adds only this file.

## Changelog

| Date | Version | Changes |
|---|---|---|
| 2026-10-27 | 1.0.0 | Initial DEEP PRD from the Foreman delivery-flow process review, the owner's decisions of 2026-10-27, the verified dispatcher integration contract and the repository's existing guards, toolchain adapters and measurement tools. |
