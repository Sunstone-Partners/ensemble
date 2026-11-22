Phase 2 complete. **Outcome: no code change — task already fixed on `dev`; no PR opened** (per the phase's explicit stop-without-a-PR rule for that case).

## What I verified (independently, not just trusting the plan)

| Check | Result |
|---|---|
| `git merge-base --is-ancestor 9719382a origin/dev` and `... HEAD` | exit 0 — PR #458 is merged into `dev` **and** present on this branch |
| `grep -rn -B2 -A1 "^  FOREMAN=1" packages/development/workflows/` | no matches; all 16 files have env gate **before** flag gate |
| Jinja probe: current `foreman-source` block + only `FOREMAN_TASK_TITLE='Fix the widget'` | `FOREMAN=true`, `FOREMAN_SOURCE=env`, no `FOREMAN_TASK_ID` — the plan's red/green probe is green on current source |
| `npx jest tests/workflows/foreman-env-var.test.js` | 45 passed |
| `npx jest tests/workflows` | 551 passed (28 suites) |
| `npm run generate:validate` | "Validation passed: 34 agent files, 33 command files, 17 skill files, 5 workflow files." |
| `npm run validate` | "✅ All checks passed" |
| full `npx jest --env=node` in `packages/development` | **1828 passed**, 138 suites |

The required failing-first test already exists and meets the DoD exactly: env-first `describe` at `packages/development/tests/workflows/foreman-env-var.test.js:168-218` sits **before** the flag block at `:220`, renders with `FOREMAN_TASK_TITLE` alone (no `FOREMAN_RUN_ID/TASK_ID` via `FOREMAN_ENV_WORKFLOWS`, L30-31), and `:239-277` asserts env-gate index < flag-gate index in all 16 files. `CHANGELOG.md` already documents PR #458 under `[Unreleased]`. No test was added, deleted, skipped or loosened; nothing under `packages/pi/` changed so no Pi bump; `npm run generate*` deliberately not run since the source diff is empty (`generate:validate` already proves the mirrors are in sync).

## One caveat, reported not patched

`tests/helpers/foreman-invariants.js:119` shells out to `printenv` via `execSync`; in this deep worktree with the worker's long `PATH` it blows the maxBuffer and makes `tests/zhilei-redis-removal.test.js` fail deterministically (2 runs, identical). The helper is byte-identical to `origin/dev`, and that test asserts the **flag** branch — irrelevant to the env requirement — and `npm run validate`'s own jest run passes it. Left untouched as out of scope (hard-coding an empty env to silence it would weaken the helper's real purpose) and recorded in the report as a suggested follow-up.

## Handoff

- Report: `docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md` (8137 bytes, the only working-tree change; untracked — Foreman commits it)
- Operator notes sent via `foreman_inbox_send` (`msg-6f79482b`, `msg-b7b86005`). `foreman_task_add_comment` fails with `INVALID_STATE: Task external_id is malformed` for this `coord-*` task, so no Work Log comments; `contact_supervisor` has no supervisor session and `ask_advisor` is unusable (Anthropic refresh token expired), so the pre-completion review couldn't run — all noted in the report.
- Suggested operator action: close bead `ensemble-foreman-skill-foreman-env-detect-8c4d` as already-fixed and correct its stale description (it still lists the pre-PR #458 bug at `new-feature.yaml:71` etc., which is what steered this run into a no-op).