# CodeRabbit review report

Task: `ensemble-pdf-f10-toolchain-cli-object-output` · Run: `run-2badb1b8e88c1d0389c78a75ac012371` · Phase 2 (`coderabbit-review`)
Diff base: `FOREMAN_BASE_BRANCH=dev` (resolved to `fe5aea4f` = `origin/dev`). Review run from the worktree root.

## Review engine

Command actually executed, from the worktree root:

```
coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"
```

- Binary: `/Users/ldangelo/.local/bin/coderabbit` (CodeRabbit CLI 0.9.6), present on `PATH`.
- Exit code: `0`. Full JSONL stream captured at `~/.omp/cr-f10-round1.txt`.
- Terminal record: `{"type":"complete","status":"review_completed","findings":0,"reviewedFiles":["docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md","packages/codex/.codex/skills/vendor/lib/toolchain-cli.js","packages/development/lib/toolchain-cli.js","packages/development/tests/toolchain-cli.test.js","packages/pi/vendor/lib/toolchain-cli.js"],"outcome":"completed"}`
- No authentication error and no non-zero exit, so the "engine unavailable" fallback path was not taken.

## Rounds

### Round 1

- Findings received: **0** (engine reviewed 5 files, `findings: 0`, `outcome: completed`).
- Fixed: none — nothing to fix.
- Declined: none — no findings to triage.

Stopped after round 1 per the phase rule "stop early when a round yields no `Critical` or `Major` finding you fixed". Rounds 2 and 3 were not run.

### Independent re-verification of the diff (engine was silent)

A zero-finding result is not evidence the change is right, so the diff `dev...HEAD` was verified by hand against the task requirements:

- `packages/development/lib/toolchain-cli.js` (source, lines ~1101-1114): `printResult`'s `run` success arm now writes
  `(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)) + '\n'`.
  This matches the required behaviour: non-strings print as 2-space-indented JSON, strings print unchanged, the `--json` envelope arm (`if (json) { ... }`) is untouched (verified by `git diff` — only the human-readable arm and its comment/header doc changed).
- Non-object edge cases behave the same as before: `undefined` → `undefined`, `null` → `null`, number → same digits, because `JSON.stringify` and `String` agree there. Arrays print as `[ ... ]`.
- `packages/development/tests/toolchain-cli.test.js`: +181 lines, 5 new tests (3 in the human-readable printResult block, 2 mutation-proof needle guards) — real behaviour assertions, not a grep for the fix wording.
- Generated mirrors `packages/pi/vendor/lib/toolchain-cli.js` and `packages/codex/.codex/skills/vendor/lib/toolchain-cli.js` are regenerated (+13/−2 each) and byte-checked by `scripts/tests/toolchain-vendor-sync.test.js`; `packages/full/lib/toolchain-cli.js` is a symlink to `packages/development/lib/toolchain-cli.js`, so it inherits the fix with no separate edit.
- Caller audit (the task's "confirm none depended on the broken output"). Counted every `node "$TOOLCHAIN_CLI" run ` occurrence in the skills and libs:
  - Callers that **parse** output all pass `--json`, i.e. they read the envelope arm, which this change does not touch: `packages/development/skills/ensemble-list-issue/SKILL.md:29` (`run work-graph.plan --json`, falling back to `run tracker.list --json`), `packages/development/skills/ensemble-beads-build-wave/references/phase-2-execute.md:14`, `packages/development/skills/ensemble-beads-build/references/phase-5-plan-mode.md:18,24`, `packages/development/skills/ensemble-implement-trd-tasks/references/phase-2-scaffold.md:16-19`, and the lib/adapter definitions `packages/development/lib/toolchain/work-graph-scan.js:10`, `packages/development/lib/toolchain/coverage.js:13`, `packages/development/skills/adapter-tracker-beads/adapter.yaml`.
  - The remaining invocations are **prose skill instructions a model executes by eye**, not code that parses stdout: `packages/development/skills/ensemble-beads-build/references/phase-1-preflight.md` (8 `run` refs), `phase-2-execute.md` (4), `phase-3-quality-gate.md` (3), `phase-4-completion.md` (10), `phase-5-plan-mode.md` (2), `packages/development/skills/ensemble-implement-trd-tasks/references/phase-2-scaffold.md` (6), `packages/development/skills/ensemble-list-issue/SKILL.md:36` ("printing `data.orderingSource` and `data.dependencyAware`"). A model reading `[object Object]` could not act on those steps at all; it can act on indented JSON, so these steps are improved, not broken.
  - Raw-text capabilities (`tracker.list`, `tracker.sync`, `tracker.dep-add` — no `parse` block) return raw stdout **strings**, and the string arm is unchanged, so their output is byte-for-byte what it was.
  - Conclusion: no caller depended on the broken `[object Object]`, and nothing in the repo parses the human-readable output of a `parse`-block capability, so the new JSON text cannot break an existing consumer.

## Fixed

None. CodeRabbit raised no findings and hand-verification found no defect in the diff, so no file was modified by this phase.

## Declined

None received — CodeRabbit raised no findings, so nothing was declined.

One observation that is **not** a CodeRabbit finding and is **not** fixed here, because phase 1 owns that artifact and this phase must not rewrite another phase's report: `docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md` at `HEAD` is a 19-line, 2461-byte chat-shaped blob (no trailing newline) starting "Phase complete. Status:" with zero markdown headings (no `##` headings at all) that lost the sections the fix phase was required to produce. Evidence: `git log --oneline -- <that path>` → `62c09352` (Foreman phase-1 commit) overwrote the 403-line structured report committed in `53a1e437`; `git show 53a1e437:<that path>` still holds the full version (403 lines, 31843 bytes) whose headings are `## 1. Root cause`, `## 2. Change`, `## 3. Tests`, `## 4. Local verification`, `## 5. Follow-ups`, `## 6. Assumptions`, `## PR body` → `## Summary` / `## Testing` / `## Risk` / `## How to revert` / `## Directed by` with `Directed by: @ldangelo` on line 403, so the restore below does produce a valid PR body. Likely cause (**inference, not verified**): the blob reads like an agent's final chat reply rather than a file write, i.e. the harness may capture the phase agent's last message into the report path when committing. That hypothesis could not be confirmed here: `packages/foreman_server` is not part of this repo, and the sibling-run report files this phase first thought it had seen are not on disk (`docs/reports/` in this worktree holds only `foreman-e3f22/`, this run's directory and the repo's pre-existing `trd-*`/`pr-review-*` docs; `git ls-files 'docs/reports/foreman-*/REVIEW_CODERABBIT_REPORT.md'` returns nothing, so there is no committed prior example to compare against). The verified facts are only that `62c09352` replaced a 403-line structured report with a 2461-byte chat-shaped blob. Either way this phase reports it rather than papering over it: if the cause is the harness, a phase-2 restore would not fix it and could be overwritten again when this phase's report is committed. Consequence for a human: the PR-opening phase has no `## PR body` block to lift the required `## Summary` / `## Testing` / `## Risk` / `## How to revert` / `## Directed by` (`Directed by: @ldangelo`) headings from, so PR creation either fails or produces a PR body that violates the repo's required headings. Restore (one-liner): `git show 53a1e437:docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md > docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md`.

## Verification

Commands run in this phase, from the repository root unless noted, with real results:

| Command | Result |
| --- | --- |
| `coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"` | EXIT=0, `findings: 0`, 5 files reviewed |
| `npm run generate:validate` | EXIT=0 |
| `npm run validate` | EXIT=0 (298 skills within prompt budgets; 64 files validated) |
| `cd packages/development && npx jest tests/toolchain-cli.test.js` | EXIT=0 — 44 passed / 44 total |
| `npx jest scripts/tests/toolchain-vendor-sync.test.js scripts/tests/generated-output-integrity.test.js` (root) | EXIT=0 — 2 suites / 6 tests passed |
| `cd packages/development && npx jest` (full package) | Test Suites: 2 failed, 309 passed, 311 total; Tests: 2 failed, 13199 passed — both failures pre-existing |
| `cd packages/development && npx jest tests/local-ci-adversarial.test.js tests/trd-cli.test.js` with dev's copies of the 3 changed `toolchain-cli.js` files checked out | 2 failed / 110 passed — same failures on base content, so pre-existing/environment (operator's `~/.config/ensemble/toolchain.yaml` makes `workflow.source` = `user`; `local-ci-adversarial` is a Node 26 / `ENSEMBLE_LOCAL_CI_RUN` env issue in the `printenv` step) |
| `git show HEAD:docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md \| wc -l -c` and `\| grep -c '^#'` | 19 lines of text (no trailing newline), 2461 bytes, 0 headings — confirms the committed fix report lost every required section |
| `git show 53a1e437:docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md \| grep -nE '^## PR body\|Directed by: @ldangelo\|^## (Summary\|Testing\|Risk\|How to revert)'` | matches at lines 320, 322, 343, 373, 384, 403 — the recommended restore does produce a valid PR body |
| `git log --oneline -- docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md` | `62c09352` (Foreman phase-1 commit) overwrote the 403-line report committed in `53a1e437` |
| `npx prettier --check` on phase 1's 4 changed files | warns — but the identical warning fires on the `dev` copies of the same files, so it is pre-existing repo-wide formatting state, not introduced here |

Pre-existing failure proof (no code changed by this phase): checking out `dev`'s copies of the three `toolchain-cli.js` files and re-running the two failing suites still fails — `npx jest tests/local-ci-adversarial.test.js tests/trd-cli.test.js` → `Test Suites: 2 failed, 2 total; Tests: 2 failed, 110 passed`. `tests/trd-cli.test.js` passes 41/41 with a clean `HOME` (the operator's user-scope `~/.config/ensemble/toolchain.yaml` sets `workflow.source: 'user'`), and `tests/local-ci-adversarial.test.js` fails on a Node 26 / `ENSEMBLE_LOCAL_CI_RUN` env assertion unrelated to this diff.

No formatter or linter was run *on this phase's* edits because this phase edited no source files — this phase only added this report. Prettier was still run on phase 1's changed files (row above) to confirm this diff did not introduce formatting drift. Working tree state at phase end: only this report file is new; the source fix and its tests were committed by phase 1 and are left untouched and un-reformatted here.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
- `docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md:1` Major — the committed fix report is a 19-line, 2461-byte chat-shaped blob (no trailing newline) that starts "Phase complete. Status:" and has zero markdown headings, so the required `## PR body` (with `## Summary`/`## Testing`/`## Risk`/`## How to revert`/`## Directed by` + `Directed by: @ldangelo`) is missing for PR creation; restore it with `git show 53a1e437:docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md > docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md` and check whether the harness overwrote it with the phase agent's last chat message (cause unverified: `foreman_server` is not in this repo). Note: this file is a phase artifact outside the code diff, so it does not affect the reviewed source change.
<!-- FOREMAN_REVIEW_FINDINGS_END -->
