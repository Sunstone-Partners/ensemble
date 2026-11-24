WP2 done.

**Package**: WP2 = TRD-002 + TRD-002-TEST (plan edits E4–E7 + registry half of E10).

**Shipped** (5 new files, uncommitted):
- `lib/engine/registry.js` — `createRegistry()`, `register` throws naming an under-declared or duplicate verb
- `lib/engine/argv.js` — `parseArgv`, globals in any position, `--flag=value`, unknown flag = `UNKNOWN_FLAG` error
- `lib/engine/describe.js` — `describe()` (8 sorted fields, refuses on empty schema), registry-generated help, `nearestVerbs` (Levenshtein)
- `lib/ensemble-cli.js` — entry point; `main(argv, ctx)` returns `{envelope, exitCode}`, never `process.exit`; `buildRegistry()` empty (groups are WP3)
- `tests/engine-registry.test.js` — 5 TRD scenarios + help AC

**Red first**: `Cannot find module '../lib/engine/argv'` → then 6 passed. Each scenario proved fail-able by individual mutation (sort reversed, `.slice(0,0)`, inline-`=` broken, unknown-flag `continue`, empty-schema check disabled) — each gave exactly 1 failure, each mutation reverted.

**Verification**: `npx jest tests/engine-envelope.test.js tests/engine-registry.test.js` → 13 passed. eslint 0 errors. CLI smoke: `--describe` 0, `foo bar` 2, `--nope` 2, `--help` 0.

**Known red, by design**: `node scripts/validate-all.js` → `✗ packages/full/lib/ensemble-cli.js is missing`. That symlink is plan E11 = WP4 packaging. Full Section 5 list is scheduled for WP4.

**Carry-forward**: TRD-001 security-sensitivity statement must appear in the PR body `## Risk` (human security reviewer, no auto-merge).

Report: `docs/reports/foreman-adhoc-3be6d78a/IMPLEMENT_2_REPORT.md`.