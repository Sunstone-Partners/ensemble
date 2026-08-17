---
document_id: TRD-2026-27211811
label: trd-sdlc-fallback
kind: trd
prd_reference: PRD-2026-27211811 (docs/PRD/PRD-2026-27211811-sdlc-fallback.md v1.0.1)
version: 1.0.0
status: Draft
date: 2026-08-17
design_readiness_score: 4.6
ensemble_implement_trd_beads:
  branch_name: feature/trd-2026-27211811-sdlc-fallback
  use_proposed: false
  stacked_prs: false
---

# TRD-2026-27211811: Graceful SDLC Fallback for implement-trd's Branching Strategy and PR Backend

**Source PRD:** `docs/PRD/PRD-2026-27211811-sdlc-fallback.md` (v1.0.1, readiness 4.6 PASS)
**Source beads:** `br-fs1`, `br-n00`

## Reused Capabilities

None declared. `trd-graph-cli capabilities docs/TRD --json` returns an empty registry. The git-town
skill itself (`packages/git/skills/git-town/`) was built by `docs/TRD/git-town-skill-extraction.md`
(2025-12-29) — a pre-capability-registry TRD with no `capabilities:` frontmatter to depend on by
reference. This TRD **modifies** that existing infrastructure (`validate-git-town.sh`'s remediation
text, `SKILL.md`'s Quick Start) rather than duplicating it, and does not introduce a new reusable
capability of its own — the new resolution logic is scoped narrowly to this PRD's two fallback axes,
per the PRD's explicit non-goal against a general pluggable architecture.

## 1. Architecture Decision

### 1.1 Chosen approach — Option C: extend the existing `pr-strategy.js` / `trd-cli.js` seam

The two axes this PRD needs — branching-strategy resolution and PR-backend resolution — are pure
decisions over a small set of inputs (env vars, a git-town exit code, a remote URL). This codebase
already has exactly the right seam for that shape of logic:

- **`packages/development/lib/pr-strategy.js`** already owns branch/PR-plan decisions
  (`useStackedPrs()`, `branchName()`, `planPrActions()`) as pure, side-effect-free, fully unit-tested
  functions — its own doc comment states the contract explicitly: "NO side effects, NO shell, NO
  br/git calls." The two new resolution concerns are the same shape of problem and belong in the
  same file.
- **`packages/development/lib/trd-cli.js`** already exposes a `HANDLERS` dispatch table
  (`parse`, `pr-plan`, `choices-read`, etc., `packages/development/lib/trd-cli.js:505-517`) that
  YAML-driven commands call via `node "$TRD_CLI" <subcommand> ...` and parse one JSON object from
  stdout — exactly the calling convention every one of this PRD's three consumer commands already
  uses for `pr-plan`/`choices-read`.
- **`packages/git/skills/git-town/scripts/validate-git-town.sh`** keeps its existing role unchanged:
  it detects git-town's raw installed/configured state and returns an exit code (0-4). Only its
  exit-code-2 remediation *text* is wrong (`git town config setup` doesn't exist) — the detection
  logic itself is correct and stays exactly as-is. The new JS layer treats this exit code as a plain
  input, the same way it already exists in every YAML command's Preflight step today.

Concretely: `pr-strategy.js` gains three new pure functions (`resolveBranchingStrategy`,
`isUnsupportedForgeHost`, `resolvePrBackend`) plus one composing helper
(`buildConsolidatedResolutionMessage`). `trd-cli.js` gains one new subcommand, `resolve-sdlc`, that
wraps them — a thin CLI adapter, matching every existing subcommand's shape exactly. Zero new files.
All three consumer YAML commands (`implement-trd-beads.yaml`, `beads-build.yaml`, `implement-trd.yaml`)
call the identical one subcommand, so there is exactly one place the decision logic lives — the same
"fix once, where all callers route through" principle the source beads themselves recommend.

**One deliberate boundary:** whether the `azure-devops` MCP tool is actually connected in the current
session is a Claude-Code-runtime fact, not something a plain `node` subprocess can observe — so it is
NOT a `resolve-sdlc` input. `resolve-sdlc` only resolves *which backend* applies (`gh`/`ado`/`manual`)
from config + remote host. The later, separate check of "is the MCP tool available right now" happens
inline in the Quality-Gate/Completion YAML steps themselves, the same way `create-trd.yaml`'s own MCP
Enhancement phase already does its own "scan available tool names for any name starting with `mcp__`"
check in prose rather than through a CLI call.

### 1.2 Alternatives considered

**Option A — inline per-command bash/prose.** Duplicate the detection and fallback logic directly
inside each of the three YAML commands' Preflight steps, no new shared code. Fastest to write in
isolation, but triples the exact same logic across three files — the precise copy-paste-drift shape
that produced `br-fs1`/`br-n00` in the first place (one file's fix doesn't reach its siblings).
Rejected: violates "fix once, where all callers route through."

**Option B — new standalone module + new CLI.** A brand-new `sdlc-resolver.js` plus a new CLI entry
point, called by all three commands. Fully centralized and just as testable as Option C, but adds two
new files and a second CLI dispatcher where `trd-cli.js`'s existing one already does this exact job
for `pr-plan`/`choices-read`. Rejected: doesn't reuse what's already there for no added benefit over
Option C.

**Option C — extend `pr-strategy.js` + `trd-cli.js` (chosen).** See §1.1. Zero new files, reuses two
already-tested, already-consumed-by-all-three-commands seams.

### 1.3 The interaction that matters — REQ-002 vs. REQ-003

`resolveBranchingStrategy()` must encode one precedence rule precisely, per the refined PRD:

| `ENSEMBLE_BRANCHING_STRATEGY` | git-town exit code | Result |
|---|---|---|
| unset | 0 (configured) | `git-town`, silent (today's behavior) |
| unset | 1 (not installed) | `plain-git`, **silent** (no warning) |
| unset | 2 (not configured) | `plain-git`, **warn once** |
| `plain-git` | any | `plain-git`, silent — explicit request always honored, git-town state is irrelevant |
| `git-town` | 0 | `git-town`, silent — explicit request matches reality |
| `git-town` | 1 or 2 | **HALT** — explicit request cannot be honored; REQ-002's fallback is deliberately NOT applied here (PRD §REQ-003, AC-003-2/AC-003-3) |
| any | 3 or 4 | unaffected by this feature — existing HALT behavior for version-mismatch / not-a-git-repo is unchanged |

This table IS the function's test matrix (TRD-001-TEST enumerates each row).

### 1.4 Interactive prompt / non-interactive HALT decision

`resolvePrBackend()` returns `needsResolution: true` only when `ENSEMBLE_PR_BACKEND` is unset AND
`isUnsupportedForgeHost(remoteUrl)` is true. The calling YAML step is responsible for the
interactive-vs-non-interactive branch (it already has `INTERACTIVE` detection for branch-intent
resolution — REQ-008 reuses that exact variable, not a new detection mechanism):

- Interactive: `AskUserQuestion` with the four options `ado` / `manual` /
  `proceed with gh anyway (not recommended)` / `abort` (PRD AC-008-1).
- Non-interactive: HALT, printing the exact `ENSEMBLE_PR_BACKEND=<value>` line to set (PRD AC-008-2).
- Either path's message ends with the persistence hint from PRD AC-008-3 ("...set this in your shell
  profile/CI config to skip this prompt on future invocations").
- Per PRD AC-017-2: if `INTERACTIVE` detection is itself uncertain, treat it as `false` (HALT path) —
  never risk a hung prompt.

## 2. System Architecture

### 2.1 Components

| Component | Status | Responsibility |
|---|---|---|
| `packages/development/lib/pr-strategy.js` | modified | Add `resolveBranchingStrategy()`, `isUnsupportedForgeHost()`, `resolvePrBackend()`, `buildConsolidatedResolutionMessage()` — all pure, no shell/side effects, matching the file's existing contract |
| `packages/development/lib/trd-cli.js` | modified | Add `resolve-sdlc` subcommand to the `HANDLERS` dispatch table, wrapping the four new `pr-strategy.js` functions |
| `packages/git/skills/git-town/scripts/validate-git-town.sh` | modified (text only) | Exit-code-2 remediation text corrected; exit codes 0-4 and their meaning are **unchanged** |
| `packages/git/skills/git-town/SKILL.md` | modified (text only) | Quick Start's dead `git town config set-main-branch main` reference corrected |
| `docs/guides/environment-variables.md` | modified | New rows for `ENSEMBLE_BRANCHING_STRATEGY`, `ENSEMBLE_PR_BACKEND` |
| `packages/development/commands/implement-trd-beads.yaml` | modified | Preflight, Feature Branch Creation, Quality Gate, Completion steps wired to the new resolver (PR 1) |
| `packages/development/commands/beads-build.yaml` | modified | Same wiring (PR 2), reusing PR 1's proven pattern |
| `packages/development/commands/implement-trd.yaml` | modified | Same wiring (PR 3) |
| `packages/development/commands/ensemble/*.md` | regenerated | `npm run generate` output for the three YAML changes above |
| `packages/development/tests/pr-strategy.test.js` | modified | New test cases for all four new functions, including the full §1.3 precedence matrix |
| `packages/development/tests/trd-cli.test.js` | modified | New `resolve-sdlc` subcommand coverage |

### 2.2 Data flow

```
Preflight (each of the three consumer commands, identically):
  1. Run validate-git-town.sh (UNCHANGED script) -> capture exit code (0-4), do NOT HALT on 1/2 anymore
  2. Run: git remote get-url origin -> REMOTE_URL
  3. Run: node "$TRD_CLI" resolve-sdlc --git-town-exit-code <code> --remote-url <REMOTE_URL>
       reads ENSEMBLE_BRANCHING_STRATEGY / ENSEMBLE_PR_BACKEND from process.env internally
       -> trd-cli.js::runResolveSdlc()
            -> pr-strategy.js::resolveBranchingStrategy()   [REQ-002, REQ-003]
            -> pr-strategy.js::isUnsupportedForgeHost()      [REQ-007]
            -> pr-strategy.js::resolvePrBackend()            [REQ-006, REQ-008]
            -> pr-strategy.js::buildConsolidatedResolutionMessage()  [REQ-013]
       -> stdout: { ok, branchingStrategy: {...}, prBackend: {...}, consolidatedMessage }
  4. If branchingStrategy.action == 'halt': print message, HALT.                    [REQ-003]
  5. If prBackend.needsResolution: interactive prompt or non-interactive HALT       [REQ-008]
  6. If consolidatedMessage is non-null: print it (nothing prints on pure defaults) [REQ-013]
  7. Set BRANCHING_STRATEGY, PR_BACKEND for the rest of this run — re-resolved fresh
     on every invocation, including resumed TRDs (never cached across sessions)      [REQ-014]

Feature Branch Creation:
  BRANCHING_STRATEGY == 'git-town' -> git town hack / append (UNCHANGED)             [REQ-001]
  BRANCHING_STRATEGY == 'plain-git' -> git checkout -b / git switch -c              [REQ-004]

Quality Gate / Completion (PR creation):
  PR_BACKEND == 'gh'     -> BRANCHING_STRATEGY==git-town: git town propose (UNCHANGED)
                             BRANCHING_STRATEGY==plain-git: gh pr create (standalone) [REQ-011]
  PR_BACKEND == 'ado'    -> azure-devops MCP repo_create_pull_request if connected,
                             else print manual az-repos/portal steps                 [REQ-009]
  PR_BACKEND == 'manual' -> always print manual steps, every phase-gate + completion [REQ-010]
```

### 2.3 Integration points

- **git-town CLI** (existing) — `git town hack`/`propose`/`append`, unchanged, used only when
  `BRANCHING_STRATEGY == 'git-town'`.
- **`gh` CLI** (existing) — now invoked as a standalone `gh pr create` when
  `BRANCHING_STRATEGY == 'plain-git'`, not only as a side effect of `git town propose`.
- **`azure-devops` MCP tool** (existing MCP server, new integration point for this feature) —
  `repo_create_pull_request`, checked for availability inline at the PR-creation step, never assumed.
- **Plain `git`** (existing) — `checkout -b` / `switch -c` / `push`, the `plain-git` strategy's entire
  mechanism.

### 2.4 Deliberate limitations

- No config-persistence mechanism is introduced (matches PRD non-goal: no new config file). The
  interactive prompt / HALT message always states the exact env var to set; the user sets it in their
  own shell/CI, same as `ENSEMBLE_USE_STACKED_PRS` today.
- `resolve-sdlc` never shells out itself and never queries MCP availability — it is a pure decision
  function over inputs the caller already has. This keeps it unit-testable with zero mocking, matching
  `pr-strategy.js`'s existing test style exactly.
- No retroactive rewriting of already-created branches/PRs (PRD non-goal) — REQ-014/REQ-015's
  "config re-resolved fresh, reconciliation notice on drift" is informational only, not a rewrite
  mechanic.

## Master Task List

### PR 1: Core resolver logic, live in implement-trd-beads

**Shippable State:** Running `/ensemble:implement-trd-beads` against a repo where git-town is absent,
unconfigured, or pointed at an Azure DevOps remote no longer hard-fails at Preflight or hard-fails
mid-run on `git town propose` — it falls back automatically, warns once, or prompts for one env var,
and completes end-to-end. Existing git-town + GitHub users see zero behavior change.

- [ ] **TRD-001** Add `resolveBranchingStrategy()` and `isUnsupportedForgeHost()` to `pr-strategy.js` (2h) `[satisfies REQ-002] [satisfies REQ-003] [satisfies REQ-007]`
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-003-1, AC-003-2, AC-003-3, AC-007-1, AC-007-2
  - Implementation AC: Given the full §1.3 precedence table (7 input combinations: env unset × exit 0/1/2, env=plain-git × any exit, env=git-town × exit 0/1/2), when `resolveBranchingStrategy()` is called with each combination, then it returns the exact `{strategy, source, action, message}` the table specifies — including `action: 'halt'` for both the not-installed AND installed-but-unconfigured cases when `ENSEMBLE_BRANCHING_STRATEGY=git-town` is explicit.
  - Implementation AC: Given a remote URL matching `dev.azure.com` vs. `github.com`/`gitlab.com`/a self-hosted Bitbucket/Gitea host, when `isUnsupportedForgeHost()` is called on each, then only the `dev.azure.com` case returns `true`.

- [ ] **TRD-001-TEST** Unit-test `resolveBranchingStrategy()` and `isUnsupportedForgeHost()` against the full precedence table and host list (1.5h) `[verifies TRD-001] [satisfies REQ-002] [satisfies REQ-003] [satisfies REQ-007] [depends: TRD-001]`
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-003-1, AC-003-2, AC-003-3, AC-007-1, AC-007-2
  - Implementation AC: Given `packages/development/tests/pr-strategy.test.js`, when run, then it contains one test case per row of §1.3's table (7 rows) asserting the exact returned `action` and `strategy`.
  - Implementation AC: Given the same test file, when run, then `isUnsupportedForgeHost()` is asserted `true` for `https://dev.azure.com/org/project/_git/repo` and `false` for `https://github.com/org/repo`, `https://gitlab.com/org/repo`, and a self-hosted Bitbucket URL.

- [ ] **TRD-002** Add `resolvePrBackend()` to `pr-strategy.js` (1.5h) `[satisfies REQ-006] [satisfies REQ-008] [depends: TRD-001]`
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-008-1, AC-008-2, AC-008-3
  - Implementation AC: Given `ENSEMBLE_PR_BACKEND` set to `gh`/`ado`/`manual`, when `resolvePrBackend()` runs, then it returns that backend with `source: 'env'` and `needsResolution: false`, regardless of remote URL.
  - Implementation AC: Given `ENSEMBLE_PR_BACKEND` unset, when `resolvePrBackend()` runs against an unsupported-host remote, then it returns `{backend: null, source: 'auto-detect', needsResolution: true}`; against a supported-host remote, `{backend: 'gh', source: 'auto-detect', needsResolution: false}`.

- [ ] **TRD-002-TEST** Unit-test `resolvePrBackend()` (1h) `[verifies TRD-002] [satisfies REQ-006] [satisfies REQ-008] [depends: TRD-002]`
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-008-1, AC-008-2
  - Implementation AC: Given all combinations of `{unset, gh, ado, manual} x {supported-host, unsupported-host}`, when `resolvePrBackend()` is called, then each returns the exact backend/source/needsResolution triple this task's Implementation ACs specify.

- [ ] **TRD-003** Add `buildConsolidatedResolutionMessage()` to `pr-strategy.js` (1.5h) `[satisfies REQ-001] [satisfies REQ-013] [depends: TRD-001, TRD-002]`
  - Validates PRD ACs: AC-013-1, AC-013-2
  - Implementation AC: Given both a `resolveBranchingStrategy()` result and a `resolvePrBackend()` result that are both pure defaults (`source` implies no env override, no fallback, no prompt), when `buildConsolidatedResolutionMessage()` runs, then it returns `null` (no output at all — matches PRD REQ-001's zero-new-output requirement).
  - Implementation AC: Given at least one of the two results is non-default (a fallback fired, an override was set, or a prompt/HALT occurred), when the function runs, then it returns one formatted string naming both resolved values and each one's source — never two separate strings.

- [ ] **TRD-003-TEST** Unit-test `buildConsolidatedResolutionMessage()` (0.75h) `[verifies TRD-003] [satisfies REQ-001] [satisfies REQ-013] [depends: TRD-003]`
  - Validates PRD ACs: AC-013-1, AC-013-2
  - Implementation AC: Given the pure-default case and at least 3 non-default cases (branching fallback only, backend prompt only, both non-default), when each is passed to the function, then the pure-default case returns `null` and every other case returns exactly one non-null string containing both axes' resolved values.

- [ ] **TRD-004** Add `resolve-sdlc` subcommand to `trd-cli.js`'s `HANDLERS` dispatch table (2h) `[satisfies ARCH] [depends: TRD-001, TRD-002, TRD-003]`
  - Implementation AC: Given `node trd-cli.js resolve-sdlc --git-town-exit-code <0-4> --remote-url <url>` (using the file's existing `parseArgs()` helper, same as `runPrPlan`), when invoked with `ENSEMBLE_BRANCHING_STRATEGY`/`ENSEMBLE_PR_BACKEND` set in `process.env`, then stdout is exactly one JSON object: `{ ok: true, branchingStrategy: {...}, prBackend: {...}, consolidatedMessage: string|null }`, mirroring `pr-plan`'s existing shape.
  - Implementation AC: Given missing/malformed required flags, when invoked, then it returns `{ ok: false, error: <message> }` and a non-zero exit code, matching every other subcommand's error contract.

- [ ] **TRD-004-TEST** Unit-test the `resolve-sdlc` subcommand end-to-end (1h) `[verifies TRD-004] [satisfies ARCH] [depends: TRD-004]`
  - Implementation AC: Given `packages/development/tests/trd-cli.test.js`, when run, then it asserts `resolve-sdlc`'s JSON output shape for at least one default case and one fallback case, plus the malformed-flags error case.

- [ ] **TRD-005** Fix `validate-git-town.sh`'s exit-code-2 remediation text (0.5h) `[satisfies REQ-005]`
  - Validates PRD ACs: AC-005-1
  - Implementation AC: Given the script's exit-code-2 branch, when read, then it no longer prints `git town config setup`; it states `git town init` is the real (interactive, optional — Preflight no longer requires it) setup entry point.

- [ ] **TRD-005-TEST** Assert the dead command reference is gone (0.25h) `[verifies TRD-005] [satisfies REQ-005] [depends: TRD-005]`
  - Implementation AC: Given the script's raw text, when scanned, then it contains zero occurrences of the literal string `git town config setup`.

- [ ] **TRD-006** Fix `git-town/SKILL.md`'s Quick Start dead command reference (0.5h) `[satisfies REQ-005]`
  - Validates PRD ACs: AC-005-1
  - Implementation AC: Given `SKILL.md`'s Quick Start section, when read, then it no longer cites `git town config set-main-branch main`; it references `git town init` (or the correct current-CLI equivalent, verified against `git-town --help`) instead, and notes this step is now optional.

- [ ] **TRD-006-TEST** Assert the dead command reference is gone (0.25h) `[verifies TRD-006] [satisfies REQ-005] [depends: TRD-006]`
  - Implementation AC: Given `SKILL.md`'s raw text, when scanned, then it contains zero occurrences of the literal string `git town config set-main-branch main`.

- [ ] **TRD-007** Add `ENSEMBLE_BRANCHING_STRATEGY` and `ENSEMBLE_PR_BACKEND` rows to `docs/guides/environment-variables.md` (0.5h) `[satisfies INFRA]`
  - Implementation AC: Given the User-Facing Variables table, when read, then it contains both new variables with default, purpose, and example columns filled in, matching the existing `ENSEMBLE_USE_STACKED_PRS` row's format.

- [ ] **TRD-007-TEST** Assert the new rows exist (0.25h) `[verifies TRD-007] [satisfies INFRA] [depends: TRD-007]`
  - Implementation AC: Given the guide's raw text, when scanned, then it contains both `ENSEMBLE_BRANCHING_STRATEGY` and `ENSEMBLE_PR_BACKEND` as table row headers.

- [ ] **TRD-008** Rewire `implement-trd-beads.yaml`'s Preflight "Git-Town and Working Directory Verification" step: never HALT on `validate-git-town.sh` exit 1/2, sniff the origin remote, call `resolve-sdlc`, implement the interactive-prompt/non-interactive-HALT branch for PR backend, print the consolidated message (5h) `[satisfies REQ-002] [satisfies REQ-003] [satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-013] [satisfies REQ-016] [satisfies REQ-017] [depends: TRD-004]`
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-002-3, AC-003-2, AC-003-3, AC-007-1, AC-007-2, AC-008-1, AC-008-2, AC-008-3, AC-013-1, AC-013-2, AC-016-1, AC-016-2, AC-017-1, AC-017-2
  - Implementation AC: Given the Preflight step's actions, when read, then exit codes 1 and 2 from `validate-git-town.sh` no longer HALT — the step instead runs `git remote get-url origin` and `node "$TRD_CLI" resolve-sdlc --git-town-exit-code <code> --remote-url <url>`, parses the JSON, and branches per §2.2's data flow (HALT only on `branchingStrategy.action=='halt'`, or on the pre-existing exit codes 3/4 which are unaffected).
  - Implementation AC: Given `prBackend.needsResolution==true` and `INTERACTIVE=true` (reusing the existing branch-intent `INTERACTIVE` detection variable — no new detection mechanism), when Preflight runs, then `AskUserQuestion` presents exactly the four options from §1.4; given `INTERACTIVE=false` or uncertain, then it HALTs with the exact env var to set, per AC-017-2.
  - Implementation AC: Given a non-interactive session with git-town unconfigured/absent AND an unsupported-host remote (the exact combination from the source beads), when the run executes, then it reaches Feature Branch Creation with zero HALTs on dead command text and zero attempted `git town propose` calls — this is the single AC that directly reproduces the PRD's stated success metric.

- [ ] **TRD-008-TEST** Test the rewired Preflight step (2h) `[verifies TRD-008] [satisfies REQ-002] [satisfies REQ-003] [satisfies REQ-008] [satisfies REQ-017] [depends: TRD-008]`
  - Implementation AC: Given `implement-trd-beads.yaml`'s raw text, when scanned, then the Preflight step no longer contains an unconditional HALT instruction tied to `validate-git-town.sh` exit codes 1 or 2, and does contain the `resolve-sdlc` invocation and the four-option `AskUserQuestion` block.
  - Implementation AC: Given the source beads' exact repro scenario described in the PRD's Testability Note (ADO remote + git-town unconfigured/absent + non-interactive), when simulated via the underlying `resolve-sdlc`/`resolveBranchingStrategy`/`resolvePrBackend` calls this step drives, then the combined result never HALTs on dead command text and never signals a `git town propose` call.

- [ ] **TRD-009** Update `implement-trd-beads.yaml`'s Feature Branch Creation to support the `plain-git` strategy (2.5h) `[satisfies REQ-004] [satisfies REQ-011] [depends: TRD-008]`
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-011-2
  - Implementation AC: Given `BRANCHING_STRATEGY=='plain-git'` (resolved in TRD-008), when a new branch is needed (initial creation or a phase-gate `append`-equivalent transition), then the action list uses `git checkout -b`/`git switch -c` targeting the same base branch `git-town` would have used, and issues zero `git town` commands anywhere in the run.
  - Implementation AC: Given `BRANCHING_STRATEGY=='plain-git'` with stacked PRs enabled, when the run completes, then the resulting branch topology matches the shape `git-town` strategy would have produced (same branch count, same parent relationships) — only the underlying commands differ.

- [ ] **TRD-009-TEST** Test plain-git branch creation (1.5h) `[verifies TRD-009] [satisfies REQ-004] [depends: TRD-009]`
  - Implementation AC: Given `implement-trd-beads.yaml`'s raw text, when scanned, then the Feature Branch Creation step contains a `BRANCHING_STRATEGY=='plain-git'` branch using only `git checkout -b`/`git switch -c`/`git push`, with zero `git town` references in that branch.

- [ ] **TRD-010** Update `implement-trd-beads.yaml`'s Quality Gate + Completion PR-creation steps to branch on `PR_BACKEND` (4h) `[satisfies REQ-009] [satisfies REQ-010] [satisfies REQ-011] [satisfies REQ-012] [depends: TRD-008]`
  - Validates PRD ACs: AC-009-1, AC-009-2, AC-010-1, AC-010-2, AC-011-1, AC-011-2, AC-012-1
  - Implementation AC: Given `PR_BACKEND=='ado'`, when a phase-gate or Completion PR is due, then the step attempts `repo_create_pull_request` via the `azure-devops` MCP tool if it is present in the current tool list (checked inline, the same "scan available tool names" pattern `create-trd.yaml`'s MCP Enhancement phase already uses), recording the PR URL into `PHASE_PR_MAP`/`SINGLE_PR_URL` exactly as `git town propose`'s output is recorded today; if the tool is absent, it prints exact manual `az repos pr create`/portal steps instead and continues (no HALT, no shell-out attempt).
  - Implementation AC: Given `PR_BACKEND=='manual'`, when a PR is due at ANY phase-gate point (not only Completion) with stacked PRs enabled, then manual instructions print at that point too, not only once at the end.
  - Implementation AC: Given `PR_BACKEND=='gh'` and `BRANCHING_STRATEGY=='plain-git'`, when a PR is due, then `gh pr create` is invoked directly (a standalone call, not routed through any `git town` command); given `BRANCHING_STRATEGY=='git-town'`, behavior is unchanged (`git town propose`).
  - Implementation AC: Given the step descriptions themselves, when read, then they name all three backends and their distinct behavior explicitly, not only the `gh`/git-town path.

- [ ] **TRD-010-TEST** Test the PR-backend branching logic (2h) `[verifies TRD-010] [satisfies REQ-009] [satisfies REQ-010] [satisfies REQ-011] [depends: TRD-010]`
  - Implementation AC: Given `implement-trd-beads.yaml`'s raw text, when scanned, then Quality Gate step 3 and Completion step 3 each contain distinct branches for `gh`, `ado`, and `manual`, and the `ado` branch names both the MCP-tool-present and MCP-tool-absent sub-cases.

- [ ] **TRD-011** Implement cross-session config-freshness and the reconciliation notice in `implement-trd-beads.yaml`'s resume path (2.5h) `[satisfies REQ-014] [satisfies REQ-015] [depends: TRD-008]`
  - Validates PRD ACs: AC-014-1, AC-014-2, AC-015-1
  - Implementation AC: Given Preflight's Resume Detection step (existing), when a TRD resumes, then it re-runs the full `resolve-sdlc` resolution exactly as a first invocation would — it never reuses a strategy/backend value cached from the TRD's persisted `choices-read` state.
  - Implementation AC: Given a resumed TRD whose persisted `branch_name`/`use_proposed`/`stacked_prs` choices were made under a different resolution than the current run's, when Preflight completes resolution, then it prints a notice naming both the prior and current resolution and stating explicitly that already-created branches/PRs are unaffected going forward.

- [ ] **TRD-011-TEST** Test resume-path config freshness (1.5h) `[verifies TRD-011] [satisfies REQ-014] [satisfies REQ-015] [depends: TRD-011]`
  - Implementation AC: Given `implement-trd-beads.yaml`'s raw text, when scanned, then the Resume Detection / Feature Branch Creation steps contain no code path that skips `resolve-sdlc` on resume, and the reconciliation-notice action exists and references both prior and current resolution values.

- [ ] **TRD-012** Regenerate `packages/development/commands/ensemble/implement-trd-beads.md` via `npm run generate` (0.25h) `[satisfies INFRA] [depends: TRD-008, TRD-009, TRD-010, TRD-011]`
  - Implementation AC: Given the edited `implement-trd-beads.yaml`, when `npm run generate` runs, then the regenerated markdown reflects every change above verbatim and `npm run validate` exits zero.

- [ ] **TRD-012-TEST** Verify regeneration is clean (0.25h) `[verifies TRD-012] [satisfies INFRA] [depends: TRD-012]`
  - Implementation AC: Given the PR head, when `npm run generate` is re-run, then `git status` reports no further changes to `implement-trd-beads.md`.

**PR 1 total: 24 tasks (12 implementation, 12 test), ~31.75h.** No task exceeds 5h; none is an 8h+
breakdown candidate.

### PR 2: Same fallback in beads-build

**Shippable State:** Running `/ensemble:beads-build` (standalone, without a TRD) gets the identical
graceful branching-strategy and PR-backend fallback `implement-trd-beads` now has — no separate
design, the proven PR 1 pattern reused verbatim against a second consumer.

- [ ] **TRD-013** Rewire `beads-build.yaml`'s Preflight "Git-Town and Working Directory Verification" step, reusing PR 1's exact pattern (2h) `[satisfies REQ-002] [satisfies REQ-003] [satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-013] [satisfies REQ-016] [satisfies REQ-017] [depends: TRD-004]`
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-002-3, AC-003-2, AC-003-3, AC-007-1, AC-007-2, AC-008-1, AC-008-2, AC-008-3, AC-013-1, AC-013-2, AC-016-1, AC-017-1
  - Implementation AC: Given `beads-build.yaml`'s Preflight step, when read, then it matches `implement-trd-beads.yaml`'s TRD-008 pattern exactly (same `resolve-sdlc` call, same HALT/prompt/consolidated-message logic) — verified by diffing the two steps' resolution logic for behavioral equivalence.

- [ ] **TRD-013-TEST** Test the rewired Preflight step (1h) `[verifies TRD-013] [satisfies REQ-002] [satisfies REQ-008] [depends: TRD-013]`
  - Implementation AC: Given `beads-build.yaml`'s raw text, when scanned, then it contains the `resolve-sdlc` invocation and no longer HALTs unconditionally on `validate-git-town.sh` exit 1/2.

- [ ] **TRD-014** Update `beads-build.yaml`'s branch creation for the `plain-git` strategy (1.5h) `[satisfies REQ-004] [depends: TRD-013]`
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Implementation AC: Given `BRANCHING_STRATEGY=='plain-git'`, when a branch is needed, then plain `git checkout -b`/`git switch -c` is used, matching TRD-009's pattern.

- [ ] **TRD-014-TEST** Test plain-git branch creation in beads-build (1h) `[verifies TRD-014] [satisfies REQ-004] [depends: TRD-014]`
  - Implementation AC: Given `beads-build.yaml`'s raw text, when scanned, then a `plain-git` branch-creation path exists with zero `git town` references.

- [ ] **TRD-015** Update `beads-build.yaml`'s Completion PR-reminder text to reflect the resolved backend instead of always suggesting `gh pr create` (1.5h) `[satisfies REQ-009] [satisfies REQ-010] [satisfies REQ-011] [satisfies REQ-012] [depends: TRD-013]`
  - Validates PRD ACs: AC-009-2, AC-010-1, AC-012-1
  - Implementation AC: Given `PR_BACKEND=='ado'`, when Completion prints its PR reminder (`beads-build.yaml` already defers PR creation to the user — "Do NOT auto-create PR"), then the reminder names the `az repos pr create`/portal steps instead of `gh pr create`; given `PR_BACKEND=='manual'` or `'gh'`, the reminder matches REQ-010/REQ-011's respective behavior.

- [ ] **TRD-015-TEST** Test the backend-aware completion reminder (1h) `[verifies TRD-015] [satisfies REQ-009] [satisfies REQ-012] [depends: TRD-015]`
  - Implementation AC: Given `beads-build.yaml`'s raw text, when scanned, then the Completion Report step names all three backends' distinct reminder text, not only `gh pr create`.

- [ ] **TRD-016** Regenerate `packages/development/commands/ensemble/beads-build.md` (0.25h) `[satisfies INFRA] [depends: TRD-013, TRD-014, TRD-015]`
  - Implementation AC: Given the edited `beads-build.yaml`, when `npm run generate` runs, then the regenerated markdown reflects every change above and `npm run validate` exits zero.

- [ ] **TRD-016-TEST** Verify regeneration is clean (0.25h) `[verifies TRD-016] [satisfies INFRA] [depends: TRD-016]`
  - Implementation AC: Given the PR head, when `npm run generate` is re-run, then `git status` reports no further changes to `beads-build.md`.

**PR 2 total: 8 tasks (4 implementation, 4 test), ~7.5h.**

### PR 3: Same fallback in implement-trd

**Shippable State:** Running `/ensemble:implement-trd` (the git-town-workflow-based, non-beads command)
gets the identical graceful fallback — the third and final consumer of the shared resolver, closing
the scope gap found during this PRD's adversarial review (neither source bead named this file, but it
carries the exact same `git town propose`/`hack`/`append` hardcoding at lines 55 and 130-133).

- [ ] **TRD-017** Rewire `implement-trd.yaml`'s Preflight Git-Town Verification step, reusing PR 1's pattern (2h) `[satisfies REQ-002] [satisfies REQ-003] [satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-013] [satisfies REQ-016] [satisfies REQ-017] [depends: TRD-004]`
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-002-3, AC-003-2, AC-003-3, AC-007-1, AC-007-2, AC-008-1, AC-008-2, AC-008-3, AC-013-1, AC-013-2, AC-016-1, AC-017-1
  - Implementation AC: Given `implement-trd.yaml`'s Preflight step, when read, then it matches TRD-008's pattern exactly, verified the same way as TRD-013.

- [ ] **TRD-017-TEST** Test the rewired Preflight step (1h) `[verifies TRD-017] [satisfies REQ-002] [satisfies REQ-008] [depends: TRD-017]`
  - Implementation AC: Given `implement-trd.yaml`'s raw text, when scanned, then it contains the `resolve-sdlc` invocation and no longer HALTs unconditionally on `validate-git-town.sh` exit 1/2.

- [ ] **TRD-018** Update `implement-trd.yaml` line 55's branch creation (`git town hack <CURRENT_BRANCH>`) for the `plain-git` strategy (1.5h) `[satisfies REQ-004] [depends: TRD-017]`
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Implementation AC: Given `BRANCHING_STRATEGY=='plain-git'`, when the initial branch is created, then `git switch -c <CURRENT_BRANCH>` is used unconditionally (this line already has a `git-town unavailable -> fallback` clause per `implement-bead.yaml`'s precedent — this task makes that fallback config-driven instead of exit-code-only).

- [ ] **TRD-018-TEST** Test plain-git branch creation in implement-trd (1h) `[verifies TRD-018] [satisfies REQ-004] [depends: TRD-018]`
  - Implementation AC: Given `implement-trd.yaml`'s raw text, when scanned, then line 55's action honors `BRANCHING_STRATEGY` explicitly, not only a raw git-town exit-code check.

- [ ] **TRD-019** Update `implement-trd.yaml` lines 130-133's PR creation (`git town propose`/`append`) to branch on `PR_BACKEND` (3h) `[satisfies REQ-009] [satisfies REQ-010] [satisfies REQ-011] [satisfies REQ-012] [depends: TRD-017]`
  - Validates PRD ACs: AC-009-1, AC-009-2, AC-010-1, AC-010-2, AC-011-1, AC-011-2, AC-012-1
  - Implementation AC: Given each of `PR_BACKEND` `gh`/`ado`/`manual` combined with each `BRANCHING_STRATEGY`, when a sprint-boundary or final PR is due, then behavior matches TRD-010's equivalent implementation for `implement-trd-beads.yaml` exactly (same MCP-preferred/manual-fallback for `ado`, same standalone `gh pr create` for `gh`+`plain-git`, same every-phase-gate manual printing for `manual`).

- [ ] **TRD-019-TEST** Test the PR-backend branching logic in implement-trd (1.5h) `[verifies TRD-019] [satisfies REQ-009] [satisfies REQ-010] [satisfies REQ-011] [depends: TRD-019]`
  - Implementation AC: Given `implement-trd.yaml`'s raw text, when scanned, then lines 130-133's region contains distinct `gh`/`ado`/`manual` branches, matching TRD-010-TEST's assertion shape.

- [ ] **TRD-020** Regenerate `packages/development/commands/ensemble/implement-trd.md` (0.25h) `[satisfies INFRA] [depends: TRD-017, TRD-018, TRD-019]`
  - Implementation AC: Given the edited `implement-trd.yaml`, when `npm run generate` runs, then the regenerated markdown reflects every change above and `npm run validate` exits zero.

- [ ] **TRD-020-TEST** Verify regeneration is clean (0.25h) `[verifies TRD-020] [satisfies INFRA] [depends: TRD-020]`
  - Implementation AC: Given the PR head, when `npm run generate` is re-run, then `git status` reports no further changes to `implement-trd.md`.

**PR 3 total: 8 tasks (4 implementation, 4 test), ~10.5h.**

**Grand total: 40 tasks (20 implementation, 20 test), ~49.75h.**

## 3. Sprint Planning

*Informational grouping only — not parsed by `implement-trd-beads`.*

### Sprint 1 (PR 1 — the core work, ~1 week)

- **Session 1** — TRD-001 → TRD-007 and their paired tests: the pure resolver functions, the CLI
  subcommand, and the two doc-fix tasks. All independent of any YAML wiring; land these first so
  PR 2/3 have a stable, tested target to reuse.
- **Session 2** — TRD-008 → TRD-012 and their paired tests: full `implement-trd-beads.yaml` wiring.
  PR 1 ships here.

### Sprint 2 (PR 2 and PR 3 — thin wiring, ~2-3 days combined)

- **Session 3** — TRD-013 → TRD-016 (`beads-build.yaml`), then TRD-017 → TRD-020 (`implement-trd.yaml`).
  Both reuse PR 1's proven pattern; expect these to move faster than their hour estimates suggest once
  the pattern is established.

## 4. Acceptance Criteria Traceability

| REQ-NNN | Description | Priority | Implementation Tasks | Test Tasks |
|---|---|---|---|---|
| REQ-001 | Default behavior unchanged | Must | TRD-003 | TRD-003-TEST, TRD-001-TEST, TRD-008-TEST |
| REQ-002 | Auto-detect fallback, never hard-block | Must | TRD-001, TRD-008, TRD-013, TRD-017 | TRD-001-TEST, TRD-008-TEST, TRD-013-TEST, TRD-017-TEST |
| REQ-003 | ENSEMBLE_BRANCHING_STRATEGY override | Must | TRD-001, TRD-008, TRD-013, TRD-017 | TRD-001-TEST, TRD-008-TEST |
| REQ-004 | plain-git branching behavior | Must | TRD-009, TRD-014, TRD-018 | TRD-009-TEST, TRD-014-TEST, TRD-018-TEST |
| REQ-005 | Fix dead remediation text | Should | TRD-005, TRD-006 | TRD-005-TEST, TRD-006-TEST |
| REQ-006 | ENSEMBLE_PR_BACKEND selection | Must | TRD-002 | TRD-002-TEST |
| REQ-007 | Sniff targets unsupported hosts only | Must | TRD-001 | TRD-001-TEST |
| REQ-008 | Prompt or HALT, never silent guessing | Must | TRD-002, TRD-008, TRD-013, TRD-017 | TRD-002-TEST, TRD-008-TEST |
| REQ-009 | ado backend MCP-preferred, manual fallback | Must | TRD-010, TRD-015, TRD-019 | TRD-010-TEST, TRD-015-TEST, TRD-019-TEST |
| REQ-010 | manual backend always manual | Must | TRD-010, TRD-015, TRD-019 | TRD-010-TEST, TRD-015-TEST, TRD-019-TEST |
| REQ-011 | gh backend standalone | Must | TRD-009, TRD-010, TRD-019 | TRD-010-TEST, TRD-019-TEST |
| REQ-012 | Docs state resolved backend | Should | TRD-010, TRD-015, TRD-019 | TRD-010-TEST, TRD-015-TEST |
| REQ-013 | Consolidated Preflight message | Should | TRD-003, TRD-008, TRD-013, TRD-017 | TRD-003-TEST, TRD-008-TEST |
| REQ-014 | Config re-resolved fresh, incl. resume | Must | TRD-011 | TRD-011-TEST |
| REQ-015 | Reconciliation notice on drift | Should | TRD-011 | TRD-011-TEST |
| REQ-016 | No new hard dependency | Must | TRD-008 (verified, no dedicated implementation) | TRD-008-TEST |
| REQ-017 | Never blocks non-interactively | Must | TRD-008 | TRD-008-TEST |

**Traceability check: 17 requirements covered, 0 uncovered, 0 orphaned annotations.**
`TRD-004`/`TRD-007`/`TRD-012`/`TRD-016`/`TRD-020` and their tests use `[satisfies INFRA]`
(CLI-plumbing and doc/regeneration tasks with no direct REQ) — not orphans, per convention.

## 5. Quality Requirements

- **Testing.** Jest, matching `packages/development`'s existing convention.
  `pr-strategy.test.js`/`trd-cli.test.js` gain the new pure-function/subcommand coverage; the three
  YAML-wiring test tasks follow this repo's established pattern of `toContain`/`not.toContain`
  assertions over the raw YAML text (see `create-trd-command.test.js`'s precedent, used identically in
  `TRD-2026-7e107138`).
- **Security.** No new dependency (REQ-016). The `ado` backend's only new integration surface is the
  already-connected `azure-devops` MCP tool — no new credentials, no new network egress path beyond
  what that MCP server already has.
- **Performance.** One extra `node` subprocess call per Preflight run (`resolve-sdlc`), on top of the
  `pr-plan`/`choices-read` calls already made there. Immaterial.
- **Compatibility.** Zero change to `validate-git-town.sh`'s exit-code contract, `pr-strategy.js`'s
  existing exported functions, or `trd-cli.js`'s existing subcommands — every current caller is
  unaffected (REQ-001).
- **Reliability.** REQ-017 is the hard constraint: no new code path introduced by this TRD may block
  on interactive input in a non-interactive session. Every new prompt point reuses the existing
  `INTERACTIVE` detection variable rather than introducing a new one.
- **Style.** Conventional commits, `fix(git-town):`/`fix(development):`/`test(development):` scopes as
  appropriate per file touched.

## 6. Adversarial Review Findings

### 6.1 Architecture

1. **`resolve-sdlc` cannot know MCP availability, but REQ-009 needs an MCP-availability check.**
   *Resolution:* §1.1's deliberate boundary — MCP-tool-presence is checked inline, at the moment a PR
   is actually being created (TRD-010/015/019), not inside the pure resolver. `resolve-sdlc` only
   decides *which backend applies*, never *whether its dependency is reachable right now*.
2. **REQ-002 and REQ-003 could contradict each other** (auto-detect says "warn and fall back",
   explicit override could be read as "also fall back") for the installed-but-unconfigured case.
   *Resolution:* §1.3's precedence table makes this a single, explicit, tested branch — an explicit
   `git-town` request HALTs instead of falling back, full stop, for both "not installed" and
   "installed but unconfigured."
3. **Three near-identical Preflight rewrites (TRD-008/013/017) risk drifting from each other despite
   calling the same `resolve-sdlc` subcommand**, if their surrounding prose diverges. *Resolution:*
   TRD-013 and TRD-017's Implementation ACs explicitly require diffing against TRD-008's pattern for
   behavioral equivalence, not just independently re-deriving similar-sounding prose.

### 6.2 Coverage

1. **Does every Must/Should REQ have both an implementation and a test task?** Yes — verified via §4's
   traceability table; every row has at least one entry in both columns.
2. **REQ-001 (backward compatibility) is mostly an emergent property, not a thing to build** — but
   its one concrete, testable mechanism is `buildConsolidatedResolutionMessage()` returning `null` on
   the pure-default case (§2.4's "nothing prints on pure defaults"). *Resolution:* TRD-003/TRD-003-TEST
   carry the `[satisfies REQ-001]` tag for exactly that mechanism, rather than leaving REQ-001 with
   zero direct task coverage in the traceability matrix.
3. **Every `### PR N:` section has a Shippable State line** describing user-observable behavior (not
   "scaffolding complete") — verified for all three PRs above.

### 6.3 Dependencies and estimates

1. **Longest dependency chain:** TRD-001 → TRD-002 → TRD-003 → TRD-004 → TRD-008 → TRD-009/010/011 →
   TRD-012, depth 6 (well within the "depth > 3 flagged" threshold as a known, deliberate, linear
   build-up — not a risk, since each step is a small, independently-testable increment, not a fragile
   long chain of assumptions).
2. **No task exceeds 5h**; the largest (TRD-008, TRD-010, both 4-5h) are the two Preflight/PR-creation
   rewrites carrying the most distinct behaviors — both already broken into per-behavior Implementation
   ACs rather than one monolithic "make it work" AC, so no further breakdown is needed.
3. **Estimate consistency check:** the three Preflight-rewiring tasks are 5h (TRD-008, first time),
   2h (TRD-013), 2h (TRD-017, both reuse-of-proven-pattern) — the estimate drop between PR 1 and
   PR 2/3 for structurally identical work is intentional (§3, Sprint 2 note) and not an inconsistency.

### 6.4 Testability

Every Implementation AC above resolves to a concrete function-return-value assertion, a raw-text
`toContain`/`not.toContain` assertion, or a process exit code / JSON-shape assertion. No subjective
language ("clean", "correct", "works well") appears unqualified. AC-008-3's "exact env var line" and
REQ-015's reconciliation-notice wording are the two places exact phrasing is left to implementation —
both already flagged as acceptable in the PRD's own Clarity notes, not new gaps introduced here.

## 7. Design Readiness Scorecard

| Dimension | Score | Notes |
|---|---|---|
| Architecture completeness | 4.5 | All components, interfaces (the `resolve-sdlc` JSON contract), and data flows are fully specified; the one deliberate boundary (MCP-availability checked inline, not in the pure resolver) is explicit rather than an oversight. |
| Task coverage | 4.75 | Every REQ-NNN has implementation and test tasks (§4); REQ-001's "no dedicated task" is explained, not silently missing; every PR has a genuine Shippable State. |
| Dependency clarity | 4.5 | Explicit, acyclic, depth-6 chain in PR 1 is deliberate incremental build-up, not fragility — called out directly in §6.3 rather than left for a reviewer to notice. |
| Estimate confidence | 4.5 | Estimates are consistent within each PR and the PR-1-vs-PR-2/3 estimate drop is explained (pattern reuse), not an unexplained discrepancy. No task exceeds 5h. |
| **Overall** | **4.6** | **PASS** |

## 8. Next Steps

```
/ensemble:implement-trd-beads docs/TRD/TRD-2026-27211811-sdlc-fallback.md
```

`/ensemble:configure-team` is optional here — this is single-track sequential work (one resolver, then
three near-identical wirings) with no natural role split (no frontend/backend/infra specialization
needed); a single builder track is likely sufficient, but team configuration remains available if
parallelizing PR 2 and PR 3 against each other (both depend only on PR 1, not on each other) is
desired.
