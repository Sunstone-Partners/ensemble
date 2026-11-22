## Status: No change required — already fixed on `dev` (verified on this branch)

Task (bead `ensemble-foreman-skill-foreman-env-detect-8c4d`, PR #458) is **not a defect on the current codebase**. Per the phase instruction "if work turns out already fixed on `dev` ... say so with evidence and stop without opening a PR; do not invent a change", no code, test, or CHANGELOG change was made and no PR was opened.

## Why: implemented and merged

PR #458 (branch `fix/foreman-env-detection-8c4d`, merge commit `9719382a`, merged 2026-11-20) is an ancestor of `origin/dev` (`git merge-base --is-ancestor 9719382a origin/dev` → exit 0) **and** of this run branch (`feature/foreman-fix-run-507f27af8cb8b10`, HEAD `b1096693`).

Caveat found while verifying: the bead's raw `description` still lists the original `FOREMAN = 1` bug at the *pre-PR line numbers* (`new-feature.yaml:71`, `e2e-ci-cd.yaml:27`, ...). That description is stale — it predates PR #458. It is the only contradiction to the code, and it is tracker metadata, not a source defect.

## Evidence

### 1. Source state on this branch (`git diff` against base is empty for these files)

All 16 bundled workflow files under `packages/development/workflows/` carry the env-first block at their `foreman-source:` line (verified line-by-line, line numbers recorded in scratchpad):

```jinja
foreman-source: |
  ...
  {% if FOREMAN_TASK_TITLE is defined and FOREMAN_TASK_TITLE %}
  FOREMAN=true
  FOREMAN_SOURCE=env
  {% elif ... %}
  FOREMAN=true
  FOREMAN_SOURCE=flag
  {% endif %}
```

`grep -rn -B2 -A1 "^  FOREMAN=1" packages/development/workflows/` → **no matches** (exit 1).

### 2. The required failing-first test already exists and is green

`packages/development/tests/workflows/foreman-env-var.test.js` (278 lines) is already in the repo and already satisfies the plan's DoD exactly:
- `describe("foreman-source env-first detection (PR #458)")` at lines 168–218, i.e. **before** `describe("foreman-source flag-based detection", ...)` at line 220 — so it is the first `foreman-source` block in the file.
- It is env-based: `const FOREMAN_ENV_WORKFLOWS = ALL_WORKFLOWS.filter(...)` (line 30) and `const FOREMAN_ENV_LINES = parseForemanSourceLines(FOREMAN_ENV_WORKFLOWS)` (line 31).
- `renderForemanSourceBlock` (lines 64–77) defaults `FOREMAN_TASK_TITLE` to `undefined`, so lines 170–177 ("renders FOREMAN=true and FOREMAN_SOURCE=env when FOREMAN_TASK_TITLE is non-empty") exercise the env branch **without** `FOREMAN_RUN_ID`/`FOREMAN_TASK_ID`; the flag-only default object lives at lines 105–113.
- The `foreman-source flag-based detection` block (lines 220–233) asserts `FOREMAN_SOURCE=flag` — the red-on-old-behaviour assertion.
- `describe("gate ordering: env before flag", ...)` (lines 239–277) asserts the env gate index is lower than the flag gate index in all 16 files.

No test was added, deleted, skipped, weakened or loosened.

### 3. Independent re-verification (commands run in this worktree)

| Command (from repo root unless noted) | Result |
|---|---|
| `node -e "require('jinja-js').render(<current foreman-source block>, { FOREMAN_TASK_TITLE: 'Fix the widget' })"` | `FOREMAN=true` + `FOREMAN_SOURCE=env`, `FOREMAN_TASK_ID` unset — the plan's red/green probe, **green on current source** |
| `cd packages/development && npx jest tests/workflows/foreman-env-var.test.js` | `Tests: 45 passed, 45 total` (exit 0) |
| `cd packages/development && npx jest tests/workflows` | `Tests: 551 passed, 551 total`, 28 suites passed (exit 0) |
| `npm run generate:validate` (root) | `Validation passed: 34 agent files, 33 command files, 17 skill files, 5 workflow files.` (exit 0) |
| `npm run validate` (root) | `=== Validation Summary === → ✅ All checks passed` (exit 0) |
| `cd packages/development && npx jest --env=node` (full package run) | `Tests: 1828 passed, 1828 total`, 138 suites passed (exit 0) |
| `git diff --name-only origin/dev...HEAD` / `git status --porcelain` | only this report file |

## One pre-existing, unrelated test-env defect found (NOT fixed — out of scope)

`packages/development/tests/helpers/foreman-invariants.js:119` (`readScriptDefaultForemanValue`) runs `bash -c "printenv"`. In this worktree (`~/.foreman/worktrees/.../workspace`, deeply nested, with a long `PATH` inherited from the Foreman worker env), `printenv` fails with `spawn ... ENOBUFS`/`stderr maxBuffer length exceeded`, so the helper returns `null` and `tests/zhilei-redis-removal.test.js` reports 1 failure — 2nd run, same failure, deterministic.

- It is **not** caused by anything in this task: `git diff --quiet origin/dev -- packages/development/tests/helpers/foreman-invariants.js` → exit 0 (byte-identical to `origin/dev`). It is a shell-environment fragility in the helper, reproduced in this run's worker env only.
- It does **not** contradict the ALREADY-FIXED verdict: `zhilei-redis-removal.test.js:41` asserts the flag branch (`FOREMAN_SOURCE=flag`), not the env branch, so it is irrelevant to the env-first requirement; `npm run validate`'s internal jest run (which uses `--env=node`) passed all 1298+ tests including it.
- Deliberately left untouched: it is outside this bead's described defect, the source-of-truth files and `scripts/prompt-budget-baseline.json` are unchanged, and hard-coding an empty env to make it pass would weaken the helper's real purpose (asserting the shipped `default: "1"` flags). Reported instead of silently patched. If the operator wants it hardened, the fix is in the helper (e.g. read the YAML value directly instead of shelling out to `printenv`).

## CHANGELOG

No entry added: `packages/development/CHANGELOG.md` already carries the PR #458 entry under `[Unreleased]` → `### Fixed → **Foreman env detection (PR #458)**` documenting both halves of the requirement (env-based detection with `FOREMAN_SOURCE=env`; `FOREMAN_SOURCE=flag` on flag-detected paths; "bead description line numbers were stale"). Adding a second entry for an unchanged behaviour would be a fabricated change.

## Generated artifacts

Not regenerated — nothing to regenerate from. `packages/development/scripts/generate-workflow-skills.js:151-152` has no `FOREMAN` literal and no workflow YAML changed, so the generated `.md` mirrors are already consistent; `npm run generate:validate` confirms this (exit 0). Nothing under `packages/pi/` changed, so no Pi version bump is due. `npm run generate` / `generate:pi` / `generate:opencode` were deliberately not run: with an empty source diff they can only churn unrelated files, which the stage-only-my-files rule forbids.

## Files changed

- `docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md` (this file, new) — only. No source, test, CHANGELOG or generated change; nothing staged or committed by this phase beyond the report Foreman commits; no PR opened.

## Concerns for the operator

1. **The bead should be closed as already-fixed, not re-implemented.** Consider correcting or annotating `ensemble-foreman-skill-foreman-env-detect-8c4d`'s description: its line numbers and bug list are pre-PR #458 and will keep steering agents into a no-op run.
2. **This is the second no-op in this run.** Phase 1 produced a plan whose verdict was "ALREADY FIXED — write no code and no tests"; this phase independently reproduced that. A workflow that re-dispatches a merged-and-verified bead burns a full plan+fix+review cycle to produce an empty diff; the bead state is the real fix.
3. **`printenv` helper fragility** (`foreman-invariants.js:119`) will keep failing `zhilei-redis-removal.test.js` in any deep worktree with a large inherited environment, including future Foreman runs on this repo. Worth a small follow-up bead (out of scope here).
4. **Progress tooling:** `foreman_inbox_send` succeeded (`msg-6f79482b`, `msg-b7b86005`); `foreman_task_add_comment` failed with `{"code":"INVALID_STATE","message":"Task external_id is malformed"}` for this coord-type task, so no Work Log comments were posted. `contact_supervisor` reports no supervisor session and `ask` is disallowed in headless mode, so this finding is reported only via this artifact.
