WP3 done.

**Shipped** (TRD-003 + TRD-003-TEST):
- `lib/engine/mount.js` — `mountLegacyGroup`, spawnSync child, verbatim Buffer stdout/stderr, child exit code; throws naming any verb w/o declared side-effect class.
- `lib/engine/groups/trd.js` (26 verbs) + `groups/tool.js` (8 verbs) — declared tables only.
- `lib/ensemble-cli.js` — `buildRegistry()` mounts both groups; passthrough verbs return legacy exit code, no envelope.
- `lib/engine/argv.js` — parse error now `break`s so `group`/`verb`/`rest` finalise (legacy flags pass through; engine verbs still refuse).
- `tests/engine-mount-parity.test.js` + `tests/fixtures/engine/trd-parity.md`.

**Test-first evidence**: test written first → `Cannot find module '../lib/engine/mount'`; then `trd list` red (`Expected: 0, Received: 2`) from the argv gap; fail-ability probe (drop `...call.rest`) → 5/10 red.

**Verification**: `generate:validate` PASS; parity+registry+envelope 23/23; parity+trd-cli+toolchain-cli 95/95; full package 13280 tests, 3 suites red — 2 are the WP4 `packages/full/lib/ensemble-cli.js is missing` symlink (plan E11), 1 is the pre-existing `local-ci-adversarial` Node-26 failure WP1 already proved not run-caused.

**Escalations**: TRD-001 security-sensitive → PR body `## Risk` must state human security reviewer + no auto-merge. WP4 must land in this PR or `npm run validate` stays red. Reviewer should check deviation 1 (unknown-flag passthrough, scoped to `passthrough: true` verbs).

Report: `docs/reports/foreman-adhoc-3be6d78a/IMPLEMENT_3_REPORT.md`. Nothing staged or committed.