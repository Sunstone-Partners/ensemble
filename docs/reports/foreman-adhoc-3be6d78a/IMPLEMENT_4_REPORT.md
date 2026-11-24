WP4 done.

**Shipped (TRD-004 + TRD-004-TEST):**
- `packages/full/bin/ensemble` (0755, shebang, one relative require, no bare non-builtin)
- `packages/full/lib/ensemble-cli.js` + `packages/full/lib/engine` mirror symlinks
- `scripts/validate-all.js`: `REQUIRED_COMMANDS = ['ensemble', 'jira']`
- `packages/pi/src/transformers/lib-bundler.ts`: `ENTRY_FILES` += `'ensemble-cli.js'`
- `ENSEMBLE_CLI` cheat-sheet row in `tool-path-resolution/SKILL.md` + regenerated mirrors/vendor
- `scripts/tests/ensemble-bundle-smoke.test.js` (11 tests, written first: 7 failed → all pass)

**One deviation:** `lib/ensemble-cli.js` entry guard extracted to exported `run(argv)`. Bare `require` from the launcher never fires `require.main === module`, so `bin/ensemble --describe` printed nothing. Caught by the test, not guessed.

**Verification:** `generate:validate` 0, `validate` 0, engine tests 23/23, legacy trd/toolchain 85/85, `packages/pi` 489/489, bundle smoke 11/11, generate drift `NO_DRIFT`.

**Pre-existing failures (reproduced on stashed clean tree, not mine):** `local-ci-adversarial.test.js` (1), `toolchain-detect.test.js` + `toolchain-config.test.js` (4; wall-clock-sensitive, re-run alone, same).

**Escalations:** (1) PR body must state TRD-001 security-sensitive, human security reviewer, no auto-merge; (2) `generate:pi` skipped the pi version bump — no network to `origin/main`; (3) report path held a stray `plain-git workflow.push` failure envelope, overwritten.

Report: `docs/reports/foreman-adhoc-3be6d78a/IMPLEMENT_4_REPORT.md`. Nothing committed.