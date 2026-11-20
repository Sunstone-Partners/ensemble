Phase 3 complete. Report written to `docs/reports/foreman-ensemble-pdf-f6b-permitter-parser-bypasses/REVIEW_REPORT.md` (untracked, left for Foreman to commit).

**What the review found**

`$FOREMAN_BASE_BRANCH` = `dev`. `git diff dev...HEAD` on this branch contains **only two files, both empty**: `FIX_REPORT.md` (2 bytes = two blank lines) and `REVIEW_CODERABBIT_REPORT.md` (1 byte, no `FOREMAN_REVIEW_FINDINGS_*` markers). Two Foreman commits exist but the tree is byte-identical to `dev` for `packages/permitter` and `packages/full`. So the security work this task asked for was never done, and the CodeRabbit phase produced nothing to carry forward.

**Why I did not implement the fix here** — the phase contract is "fix what a rules review legitimately finds," and "the entire task is missing" has no narrow fix; a six-case security hardening of a shared permission boundary needs failing-first tests, the source/mirror + generate steps and its own FIX_REPORT/PR body, and doing it here would mean reviewing my own code. The Advisor independently ruled the same way; I escalated severity to Critical and added real anchors.

**Findings left unresolved (8, in the block):**
- Critical: no code/tests in the run — the PR must not merge as a fix
- Major: both phase artifacts are empty
- Verified-open defects with current line numbers: no `#` comment branch (`:63`), `env -C` misclassification (`:388`, `env -C /tmp git status` → executable `/tmp`), silent `PATH=`/`LD_PRELOAD=` drop (`:364`), no `${...}`/`$'...'` check (`:242`), `isEnvAssignment` misses variable-valued `IFS=` (`:332`), `bash -c` inspects only `innerSegments[0]` (`:430`)
- Declined as already fixed: the task's redirect-target case — `cat < $(echo /etc/passwd)` already throws via `checkUnsafe`/`checkRedirections`

Two premise corrections recorded: there is no `ANSI_C_QUOTING_RE` anywhere in `packages/`, and `$()`/backticks are already covered with quoted tests; `packages/full/lib/command-parser.js` is a git symlink to the permitter file, so permitter/lib is the only source.

Verification run: `npx jest packages/permitter` → 7 suites / 553 tests pass; `npm run validate` → EXIT=0. Both are baseline evidence — nothing was added to test.