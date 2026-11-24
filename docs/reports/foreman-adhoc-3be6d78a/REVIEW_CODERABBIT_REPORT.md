CodeRabbit review phase done.

**Report:** `docs/reports/foreman-adhoc-3be6d78a/REVIEW_CODERABBIT_REPORT.md` (26.5 KB)

**Engine:** `coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"` (base `dev`, set) — 3 rounds, 17 raw findings → 13 distinct.

**Fixed (8):**
- `validate.js` dangling symlink → path escape (major)
- `envelope.js` own `constructor` key bypassed redaction (major)
- `envelope.js` null-prototype record skipped by redaction (major)
- `envelope.js` custom `toJSON` emitted unredacted via `JSON.stringify` (r2+r3)
- `envelope.js` `__proto__` field lost
- `ensemble-cli.js` unknown `error.status` escaped → no envelope/exit code
- `validate.js` closed stdin hung forever
- exit-isolation test could not fail → now one child process + `ENGINE_SURVIVED` marker + fixture `tests/fixtures/engine/exit-cli.js`

**Declined (5):** PLAN.md `cd packages/development` sequence (operator-supplied plan, byte-identical copy); legacy-immutability test vs `HEAD` (PR-validation concern); argv refusing `-`-prefixed value (TRD:147 mandates); PLAN.md launcher entry point (stale — implemented launcher calls `run()`); mount `maxBuffer` 64 MiB ceiling (deliberate bound).

**Verification (exit codes):** narrow jest 32/32 → 0 · bundle smoke 11/11 → 0 · `npm run generate:pi` → 0 · `generate:validate` → 0 · `npm run validate` → 0 · eslint → 0 errors (repo ignores `**/lib/**`) · full `packages/development` jest → **1** (pre-existing, unrelated: `tests/local-ci-adversarial.test.js`; proven identical with changes stashed, imports only `lib/local-ci-*`).

**Risk:** MEDIUM — security-sensitive boundary; TRD-001 still needs human security reviewer + no auto-merge.

Fixes left uncommitted for Foreman. `foreman_inbox_send` / `foreman_task_add_comment` unavailable in this phase — noted in report.