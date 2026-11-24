WP1 done.

**Shipped** (TRD-001 + TRD-001-TEST, plan edits E1/E2/E3):
- `packages/development/lib/engine/envelope.js` — frozen 7-status exit table, `exitCodeFor` throws on unknown (no fallback), deep key sort, deep redaction via existing `redactSecrets`, `data` XOR `error`, `internal()` keeps stack off stdout.
- `packages/development/lib/engine/validate.js` — 4 MiB stdin cap enforced *before* `JSON.parse`, ajv (`allErrors:false, strict:false`) naming the offending field, `resolveCallerPath` real-path containment to root / `.ensemble/state`, `PATH_ESCAPE`.
- `packages/development/tests/engine-envelope.test.js` — 6 TRD scenarios + 1 for the redaction Implementation AC that had no Test AC.

**Test-first**: red = `Cannot find module '../lib/engine/envelope'`, 0 tests. Green after impl: 7/7.

**Rule 7**: each of the 7 scenarios individually proved failable by breaking exactly what it guards (no key sort / `exitCodeFor` returns 0 / schema check bypassed / cap disabled / containment disabled / stack into envelope / redaction disabled) — each broke only its own scenario. Reverted from byte-identical backups, `diff` empty.

**Gates**: `npm run generate:validate` 0 · `npm run validate` 0 · `npx eslint` 0 · package suite 314/315 suites, 13259 passed.

**One pre-existing failure**: `tests/local-ci-adversarial.test.js › GH_TOKEN … never reach a step` (`:288 expect(text).toContain('PATH')`, `printenv` step exit 1 on Node 26). Proved not mine — with my two paths moved out and `git status` empty, it still fails. Not a timing-flake file; local `act`/Node-26 environment.

**Deviations** (3, all in report §4): added the redaction scenario (Rule 3, AC had no test); test drives the two modules via an in-test driver b/c `ensemble-cli.js` is WP2 — Rule 6 closes at WP2–WP4, flagged for the PR reviewer; `internal()` takes optional `streams`.

**Escalation**: TRD-001 is security-sensitive — TRD line 701 + Constitution §4 require a **human security reviewer, auto-merge off**; PR body `## Risk` must say so.

No commit, no branch op, no push — all 3 paths left untracked for Foreman.