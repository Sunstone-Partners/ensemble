Phase 3 done.

**Engine:** `coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"` (`dev` @ a0d6a213), CLI 0.9.6, exit 0 × 3 rounds. Logs `~/.omp/zflwr-siil7-fix/cr_round{1,2,3}.log`.

**Why round 1 was empty of code:** phase 2 (fix) committed only `docs/reports/foreman-zflwr-siil7-fix/{PLAN.md,FIX_REPORT.md}` — zero product code. So the permitter fix the task asks for was unimplemented. Implemented it in this phase (failing-first), then rounds 2–3 reviewed it.

**Fixes (packages/permitter/lib/command-parser.js, + tests, + CHANGELOG):**
- inner redirects of `-c` wrappers now go through `checkRedirections` (fixes zflwr: `bash -c "npm test > ~/.ssh/authorized_keys"` no longer auto-allowed)
- `SHELL_EXECUTABLES` (bash/sh/zsh/dash/ksh/ash/mksh) — every shell expands inner segments (siil7 R1)
- shell `-c` behind sudo/doas/command/env/timeout/nohup → throw (R2), plain `sudo git status` / `command -v git` / `env git status` unchanged
- exported `normalizeSegment()` no longer drops inner segments (R3)
- CodeRabbit round 2+3 majors fixed: options before `-c`, `-c` after script operand, basename trust of a shell, `--rcfile`/`--init-file`, unreadable option forms, `ZDOTDIR`

**Verification:** red 30 failed → green `security.test.js` 552/552; full permitter suite 965/965; eslint 0; `npm run generate:validate` 0; `npm run validate` 0. `packages/full/lib/command-parser.js` still symlink, `.beads/` untouched.

**Declined (3 minor, PLAN.md):** all three are plan-doc text the bead overrides (bead requires wrapper cases to throw and `normalizeSegment` to stop returning `innerSegments[0]`); a throw is strictly stronger than the old result.

**Report:** `docs/reports/foreman-zflwr-siil7-fix/REVIEW_CODERABBIT_REPORT.md` — findings block (9 entries) + risk block `MEDIUM`, both raw JSON outside fences, parsed OK, nothing after the risk block. Changes left uncommitted for Foreman.

**For operator:** human security reviewer must read the diff; auto-merge off. `foreman_task_add_comment` failed (`Task external_id is malformed`) → no task Work Log comment; `foreman_inbox_send` sent.
