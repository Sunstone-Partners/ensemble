Phase complete.

## What the review found and fixed

Diff vs `FOREMAN_BASE_BRANCH=dev` (HEAD `606afe6c`) = **3 new Markdown reports, zero code**. Behaviour under review already on `dev` (PR #458, merge `5b6c0028`, verified ancestor).

**Fixed (4):**
1. **major** `FIX_REPORT.md:56` — the phase-2 "One caveat" paragraph was **fabricated a second time**: it claimed `tests/helpers/foreman-invariants.js:119` calls `printenv` via `execSync` and that `tests/zhilei-redis-removal.test.js` fails deterministically. Helper has no `printenv`/`execSync`; `grep -rn zhilei .` hits only that paragraph; file never existed in any ref → retracted in place with the reproducing greps, and the *one* genuine pre-existing env failure (`tests/local-ci-adversarial.test.js` GH_TOKEN case) named with its real mechanism.
2. **minor** `PLAN.md:17` — MD038: outer inline-code span wrapping nested `` `--foreman` `` → blockquote list item.
3. **minor** `REVIEW_CODERABBIT_REPORT.md:11` — stale `MD038=open` marker → now records closure by phase 4.
4. **minor** `REVIEW_CODERABBIT_REPORT.md:13` — MD047 missing trailing newline → appended.

**Declined (3):** empty `REVIEW_REPORT.md` in another run's dir (pre-existing on `dev`, out of scope); the two carried findings (stale — already resolved by phase 3, whose retractions I re-verified).

## Verification
| Command | Exit | Result |
|---|---|---|
| `npm run generate:validate` | 0 | Validation passed (64 files) |
| `npm run validate` | 0 | only 9 pre-existing below-baseline advisories (new-feature 3189 vs 3193) |
| `npx jest tests/new-feature-foreman.test.js tests/feature-foreman-passthrough.test.js tests/new-feature-command.test.js` | 0 | 3 suites, 94 tests (37+57) |
| `npx jest --env=node` (pkg-wide) | 1 | 313/314 suites, **13252 passed**, 1 pre-existing env failure, 318 s (first attempt hit the 900 s tool limit under load — not a failure) |
| `npx markdownlint` (4 files) | 0 | clean; whole repo ~1217 pre-existing errors elsewhere, **0** in this dir |

Artifact: `docs/reports/foreman-coord-c2c08c40855ae530/REVIEW_REPORT.md` — both JSON blocks parse, exactly 4 marker lines, 7 findings (4 fixed / 3 declined), risk **LOW**.

Fixes left **uncommitted** (3 modified + 1 new). `foreman_inbox_send`/`foreman_task_add_comment` not exposed; `ask_advisor` still dead (Anthropic `invalid_grant`), `contact_supervisor` has no supervisor — noted in the artifact.