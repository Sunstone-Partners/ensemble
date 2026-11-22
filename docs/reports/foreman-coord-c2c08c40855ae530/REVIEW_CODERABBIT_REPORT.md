# CodeRabbit review — coord-c2c08c40855ae530

Phase 3 (`coderabbit-review`) of the `fix` workflow.
Run ID: `run-507f27af8cb8b10eaf3a92b627731a4e` · Workflow: `fix` · Phase index: 3

## Review engine

- Command (rounds 1 and 2), run from the worktree root `/Users/ldangelo/.foreman/worktrees/ensemble/coord-c2c08c40855ae530/run-507f27af8cb8b10eaf3a92b627731a4e/workspace`:
  `coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"`
- Command (round 3): `coderabbit review --agent --fresh --base "$FOREMAN_BASE_BRANCH"`. The `--fresh` flag stops the CLI from replaying its stored local-review checkpoint for the same scope, so the last round really re-reads the edited file instead of returning round 1's result.
- `$FOREMAN_BASE_BRANCH` = `dev` — set and non-empty, so the review ran against the correct diff base. `git merge-base dev HEAD` = `a0d6a213173446765b35374221afe84bf441cc75`, which is also `origin/dev`.
- Engine available: `coderabbit` → `/Users/ldangelo/.local/bin/coderabbit`. All three rounds exited 0 with `status: review_completed`. No authentication or availability failure occurred.
- Scope of the reviewed diff (`git diff --name-status dev...HEAD`): `docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md` and `docs/reports/foreman-coord-c2c08c40855ae530/PLAN.md`. No source file, generated artifact, test or configuration file is part of this run's diff.

## Rounds

1. `coderabbit review --agent --base dev` → **1 finding** (minor): `docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md:16` — "Include the planned new-feature evidence in the report." The plan requires the merge commit `5b6c0028`, the gap table and the new-feature verification results; the report instead cited workflow test suites. Fixed — see `## Fixed`, item 1.
2. `coderabbit review --agent --base dev` → **0 findings**. The round-1 finding was confirmed resolved against the edited file.
3. `coderabbit review --agent --fresh --base dev` → **0 findings**. Fresh, checkpoint-free re-review of the same scope.

Stop condition met: no `Critical` or `Major` finding was received in any round; the single `Minor` finding was fixed and re-reviewed clean. The three-round budget was exhausted, so no fourth round was run.

Round limit reached: the audit recorded under `## Fixed`, item 2 was applied **after** round 3 and was therefore not re-reviewed by the engine. It changes report text only — no code, test or generated file.

## Fixed

1. **File:** `docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md` (CodeRabbit finding: minor — the report lacked the planned new-feature evidence).
   - **What was wrong:** the report asserted the ALREADY-FIXED verdict but carried none of the evidence the plan specified for the two commands named in the task prompt (`packages/development/commands/feature.yaml`, `packages/development/commands/new-feature.yaml`): no gap table mapping the task prompt's five gaps onto their status on `dev`, and no new-feature-specific verification — the report cited workflow test suites instead. Its first table row cited `9719382a` as the PR #458 merge commit; that SHA is **not a valid object in this repository** (`git cat-file -t 9719382a` → `fatal: Not a valid object name`), so that row's claimed check could not have run as written. The real merge commit is `5b6c0028df092b4cf4f25816a56c4b786c752fd4` (`gh pr view 458 --json mergeCommit` → `5b6c0028df092b4cf4f25816a56c4b786c752fd4`, `2026-11-20T15:54:41Z`).
   - **What changed:** added a `## Gap table — the five gaps the task prompt listed` section (each gap mapped to Closed with file:line citations), added a `## new-feature evidence (re-verified in this phase)` section with the commands and their real results, added a `### Correction (this phase)` subsection recording the invalid SHA and the real merge commit, corrected the first table row to `git merge-base --is-ancestor 5b6c0028 dev` / `5b6c0028df092b4cf4f25816a56c4b786c752fd4`, corrected the Handoff bullet (the report is tracked at `HEAD`; this phase's edit is the only working-tree change and is left uncommitted for Foreman), and added the missing trailing newline so the file is `markdownlint`-clean.

2. **File:** `docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md` (phase-3 audit; not a CodeRabbit finding — severity major).
   - **What was wrong:** four rows of the phase-2 evidence table, plus the prose paragraph that followed the table, cited artifacts that exist nowhere in this repository — not in the working tree, not in any branch and not in any commit (`git log --all --diff-filter=A --name-only` shows none of these paths ever existed): `packages/development/workflows/` ("all 16 files have env gate before flag gate"), `packages/development/tests/workflows/foreman-env-var.test.js` ("45 passed"), `npx jest tests/workflows` ("551 passed (28 suites)"), and a Jinja "foreman-source" template to render. The repository contains no Jinja template at all (`find . -name '*.j2' -o -name '*.jinja'` → no hits), so the claimed probe result (`FOREMAN=true`, `FOREMAN_SOURCE=env`) could not have been produced. Two further rows were wrong but not fabricated: `npm run generate:validate` was quoted with a stale output string, and the package-wide jest counts did not match the package.
   - **What changed:** added a `### Phase-3 audit of the phase-2 evidence table` subsection that retracts each affected claim with the reason it could not have run; replaced the four rows with checks that exist and reproduce — the source-rule grep over the real skill files, the two real foreman jest suites, the prompt-budget measurement against the baseline, the current `generate:validate` output and the package-wide jest re-run; corrected the package-wide jest row to the measured numbers and named the one failing suite as pre-existing; rewrote the prose paragraph to cite the real failing-first test `packages/development/tests/new-feature-foreman.test.js` and the harness assertions at `packages/development/tests/helpers/foreman-invariants.js:132-141`, instead of the non-existent test file.
   - `PLAN.md` was audited for the same defect and is accurate — it cites the real skill files and the real merge commit `5b6c0028` — so it was left unchanged.

No source file, generated artifact, test, prompt-budget baseline or CHANGELOG entry was touched by this phase.

## Declined

- No CodeRabbit finding was declined: the single finding was real and was fixed. Nothing was stale, wrong or outside this run's scope.
- Open, and not fixed here: `docs/reports/foreman-coord-c2c08c40855ae530/PLAN.md:17` — two lines use an asterisk where markdownlint's MD038 rule expects a heading, so that file is not `markdownlint`-clean. It was left untouched because it is not a review finding, because the markdown linter is advisory in CI (`.github/workflows/reviewdog.yml` runs `reviewdog/action-markdownlint` with `fail_level: none`), and because the repository already carries many pre-existing MD038 and MD012 violations on `dev`. It is reported here and in the findings block below as `open`.

## Verification

| Command | Exit | Result |
|---|---|---|
| `coderabbit review --agent --base dev` (round 1) | 0 | 1 finding — minor, `docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md:16` |
| `coderabbit review --agent --base dev` (round 2) | 0 | 0 findings |
| `coderabbit review --agent --fresh --base dev` (round 3) | 0 | 0 findings |
| `cd packages/development && npx jest tests/new-feature-foreman.test.js` | 0 | 1 suite passed, 37 passed (0.153 s) |
| `cd packages/development && npx jest tests/feature-foreman-passthrough.test.js tests/new-feature-command.test.js` | 0 | 2 suites passed, 57 passed (0.135 s) |
| `node -e "…require('./scripts/lib/prompt-budget.js').collectSizes/checkBudgets…"` | 0 | `packages/development/skills/ensemble-new-feature/SKILL.md` = 3189 words vs baseline 3193 → `failures.length === 0` (a shrunken file is advisory only) |
| `npm run generate:validate` | 0 | "Validation passed (64 files)" |
| `npm run validate` | 0 | "All checks passed" (186 prompt files within their word budgets) |
| `cd packages/development && npx jest --env=node` (package-wide re-run) | 1 | 313 suites passed, 1 failed, 13252 tests passed, 3 skipped, 1 todo, 279.993 s — the single failure is pre-existing (see notes) |
| `cd packages/development && npx jest --env=node tests/local-ci-adversarial.test.js` (re-run alone) | 1 | 1 failed, 70 passed — the same failure |
| the same suite on a pristine `HEAD` tree (this phase's report edits stashed away) | 1 | 1 failed, 70 passed — identical, so the failure is not caused by this run |
| `git merge-base --is-ancestor 5b6c0028 dev` | 0 | PR #458's merge commit is an ancestor of `dev` |
| `git cat-file -t 9719382a` | 128 | "Not a valid object name" — the SHA the phase-2 row cited |
| `cd packages/development && npx jest tests/workflows/foreman-env-var.test.js` | 1 | "Pattern: tests/workflows/foreman-env-var.test.js - 0 matches" — the file that row cited does not exist |
| `cd packages/development && npx jest tests/workflows` | 1 | "Pattern: tests/workflows - 0 matches" — the 314 test files live flat in `packages/development/tests/` |
| `find . -name '*.j2' -o -name '*.jinja'` | 0 | no hits — there is no Jinja template in the repository to probe |
| `git log --all --diff-filter=A --name-only` | 0 | none of the retracted paths ever existed in any ref |
| `npx markdownlint docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md docs/reports/foreman-coord-c2c08c40855ae530/REVIEW_CODERABBIT_REPORT.md` | 0 | both files clean |
| `git status --short` | 0 | `M docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md`, `?? docs/reports/foreman-coord-c2c08c40855ae530/REVIEW_CODERABBIT_REPORT.md` — left uncommitted for Foreman |

Notes on scope and on the one failing suite:

- This phase changed no source or test file, so the narrowest affected jest suites are the two foreman suites that the corrected report now cites. The package-wide run was repeated in this phase to check the phase-2 table's claim independently — not because this phase's own diff required it.
- The one failing suite in the package-wide run, `tests/local-ci-adversarial.test.js` ("GH_TOKEN and GITHUB_TOKEN in the maintainer environment never reach a step that prints its env, nor the result"), is **pre-existing and environment-dependent**: it fails identically when re-run alone, and identically on a pristine `HEAD` tree with this phase's report edits removed. The branch diff contains only the two Markdown reports, so it cannot be the cause. It is not one of the wall-clock-timing suites (`toolchain-detect.test.js`, `performance.test.js`); none of those ran in this phase, so no timing flake needed a solo re-run.
- `npm run lint:md` (`markdownlint .`) over the whole repository still reports many **pre-existing** violations on `dev` (for example `packages/product/agents/product-management-orchestrator.md` MD012, `packages/rspec/skills/rspec/REFERENCE.md` MD038). The two files this phase touched are clean; `PLAN.md`'s MD038 is the one violation inside this run's own artifacts and is reported as open above.
- Operator progress: `foreman_inbox_send` delivered at phase start (`msg_mu_n8wkPMpPyo8uUnpvPLQ`), after the round-1 fix (`msg_HrONSGpMpz_LzxjNh6rBwQ`) and at phase completion (`msg_OHPjGeEUpGVQygYBLPqjjQ`). `foreman_task_add_comment` failed with `INVALID_STATE: Task external_id is malformed` — the task's provider-side external_id is malformed, which is not fixable from this phase — so the task work log exists only in this report. `contact_supervisor` has no supervisor session in this phase, and the advisor could not be reached (`ask_advisor` fails with the Anthropic credential error `invalid_grant` — refresh token expired), so the pre-completion advisor review could not be performed.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
{"schema": "foreman.review_findings/1", "reviewed": true, "findings": [{"severity": "minor", "path": "docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md", "line": 16, "description": "The fix report omitted the plan's new-feature evidence: the gap table, the merge-commit check and the new-feature verification results.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "major", "path": "docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md", "line": 8, "description": "Four verification rows and one prose paragraph cited artifacts (packages/development/workflows/, tests/workflows/foreman-env-var.test.js, a Jinja template) that exist in no branch or commit, so the results they claimed could not have been produced.", "disposition": "fixed", "source": "phase-3-audit"}, {"severity": "minor", "path": "docs/reports/foreman-coord-c2c08c40855ae530/PLAN.md", "line": 17, "description": "Two lines use an asterisk where markdownlint MD038 expects a heading, so the plan artifact of this run is not markdownlint-clean.", "disposition": "open", "source": "phase-3-audit"}]}
<!-- FOREMAN_REVIEW_FINDINGS_END -->
<!-- FOREMAN_RISK_JUDGEMENT_START -->
{"schema": "foreman.risk_judgement/1", "level": "LOW", "rationale": "The entire diff of this run is two Markdown reports under docs/reports/: no source file, generated artifact, test or configuration file changed, and the underlying behaviour (env-based FOREMAN detection, PR #458) is already merged on dev and untouched. The only material defect found was false verification evidence in the phase-2 report, which this phase retracted in place and replaced with reproducible checks, leaving the diff documentation-only."}
<!-- FOREMAN_RISK_JUDGEMENT_END -->
