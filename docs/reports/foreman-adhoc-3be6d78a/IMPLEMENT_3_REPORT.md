# IMPLEMENT_3 — WP3 (TRD-003, TRD-003-TEST)

## 1. Package

**WP3** = TRD-003 (Mount the `trd` and `tool` groups with legacy parity) + TRD-003-TEST (Legacy
parity across every mounted verb). Plan edits E8, E9 and the parity half of E10.

Shipped: `mountLegacyGroup` plus declared mount tables for `trd` (26 verbs) and `tool` (8 verbs),
registered by `buildRegistry()`, so `ensemble trd <verb> ...` and `ensemble tool <verb> ...`
produce stdout and exit codes byte-identical to the legacy CLIs while `--describe` publishes a
declared side-effect class for all 34 mounted verbs.

Earlier packages verified present before starting: `lib/engine/envelope.js`, `lib/engine/validate.js`
(WP1), `lib/engine/registry.js`, `lib/engine/argv.js`, `lib/engine/describe.js`,
`lib/ensemble-cli.js` with `buildRegistry`/`main` exports (WP2), plus their tests
`tests/engine-envelope.test.js` and `tests/engine-registry.test.js`.

## 2. Changes

| Path | Rationale |
| --- | --- |
| `packages/development/lib/engine/mount.js` (new) | E8: `mountLegacyGroup` registers each legacy subcommand as a passthrough verb whose handler `spawnSync`s `process.execPath <cliPath> <verb> ...rest` and copies the child's stdout/stderr through verbatim as Buffers; registration throws naming the verb when the declared `sideEffects` (or `summaries`) table has no entry. |
| `packages/development/lib/engine/groups/trd.js` (new) | E9: declared table only — `cliPath`, the 26 `HANDLERS` keys from `lib/trd-cli.js:1657`, the `read`/`write` side-effect column and one summary per verb. Requires nothing from the legacy module. |
| `packages/development/lib/engine/groups/tool.js` (new) | E9: same shape for `lib/toolchain-cli.js` (`HANDLERS` at :882 plus `trace` at :1165); `write` for `run`, `preflight`, `confirm-record`, `trace`. |
| `packages/development/lib/ensemble-cli.js` (modified) | E8/E9 wiring: `buildRegistry()` now mounts the two groups (it registered none in WP2); a `passthrough` verb returns the legacy exit code with no envelope, because wrapping legacy bytes would break parity ("Mounted groups keep their legacy output exactly", TRD line 91); and a parser flag error is passed through to a mounted verb instead of refusing, since the engine parser does not know the legacy CLI's flags. For an engine verb the flag error still refuses and no handler runs. |
| `packages/development/lib/engine/argv.js` (modified) | A parse error now `break`s the scan instead of returning immediately, so `group`, `verb` and `rest` are still finalised; `main` needs them to tell an engine verb's bad flag (refused) from a mounted legacy verb's own flag (`trd list --dir X`). Error code/message and all WP2 behaviour unchanged — `tests/engine-registry.test.js` still passes untouched. |
| `packages/development/tests/engine-mount-parity.test.js` (new) | E10 parity half: TRD-003-TEST scenarios. |
| `packages/development/tests/fixtures/engine/trd-parity.md` (new) | E10: a two-phase fixture TRD that `trd-cli.js parse`, `phase-status` and `list` all accept (exit 0). |

No `package.json` touched; no runtime dependency added. `lib/trd-cli.js` and `lib/toolchain-cli.js`
are unmodified (proved by the hash scenario below).

## 3. Tests

All commands run from `packages/development`.

First failure, before any WP3 source existed:
`npx jest tests/engine-mount-parity.test.js` →
`Cannot find module '../lib/engine/mount' from 'tests/engine-mount-parity.test.js'` (suite failed
to run, 0 tests).

| Scenario (TRD Test AC) | Before | After |
| --- | --- | --- |
| trd parity — `trd parse`, `trd phase-status`, `trd list` run through both entry points, stdout buffers and exit codes byte-equal | module-not-found; then `trd list` alone failed `expect(viaEngine.status).toBe(viaLegacy.status)` — `Expected: 0, Received: 2`, because the parser refused `--dir` as an unknown flag | 3/3 pass |
| tool parity — `tool resolve --json`, `tool explain --json` likewise | module-not-found | 2/2 pass |
| byte-equal CLI — `sha256` of `lib/trd-cli.js` and `lib/toolchain-cli.js` equals `sha256` of `git show HEAD:<path>`, computed in-test | module-not-found | 2/2 pass |
| mounting refuses a verb with no declared side-effect class (Implementation AC, exercised as a test) | module-not-found | passes; also asserts `registry.get('trd','frobnicate')` is `null` |
| `--describe` reports a declared `read`/`write` class and non-empty schemas for every mounted verb | module-not-found | passes (34 mounted verbs) |
| a legacy handler that writes `process.exit` cannot terminate the engine process | module-not-found | passes |

Fail-ability probes (each reverted immediately; `grep` confirmed the file was restored):
- Dropped `...call.rest` from the `spawnSync` argv in `mount.js` → 5 of 10 scenarios failed
  (all parity pairs plus the process-exit scenario). The parity comparison is live, not a golden.
- The `trd list` red above is itself evidence the parity scenarios bite: an engine-side argv bug,
  not a legacy change, turned exit 0 into exit 2.

Final: `npx jest tests/engine-mount-parity.test.js` → 10 passed.
`npx jest tests/engine-envelope.test.js tests/engine-registry.test.js tests/engine-mount-parity.test.js`
→ 3 suites, 23 passed.

## 4. Deviations from the plan or TRD

1. **`argv.js` touched (plan lists it under E5/WP2).** TRD-003's first two Implementation AC items
   ("stdout and exit code byte-identical to `node trd-cli.js <verb> ...`") cannot hold while the
   engine parser refuses the legacy CLIs' own flags: `trd list --dir <d>`, `tool resolve --json`,
   every `trd-cli.js` flag. The plan's own E5 text ("`rest` … is passed to mounted groups
   untouched") and E8 ("`...rest`") require passthrough, so the change is the minimum that makes
   E8 work: the error is no longer returned early, so `group`/`verb`/`rest` are finalised, and
   `ensemble-cli.js` decides. For an engine (non-passthrough) verb the behaviour is unchanged —
   `INVALID_INPUT`, exit 2, handler not called — and WP2's `tests/engine-registry.test.js`
   ("unknown flag rejected") passes unmodified.
2. **`passthrough: true` added to mounted registry specs and honoured in `main`.** Not named in the
   plan, but implied by TRD line 91 ("Mounted groups keep their legacy output exactly"): a mounted
   handler has already written the legacy bytes, so wrapping its return value in an envelope would
   append a second JSON object to stdout and break byte parity. Engine verbs still get the envelope.
3. **Per-group `exitCodes`.** The plan did not fix a value; `trd` declares `[0, 1]`
   (`trd-cli.js:1694` returns 0/1) and `tool` declares `[0, 1, 2]` (unknown subcommand returns 2 at
   `toolchain-cli.js:1382`), so `--describe` publishes what each CLI can actually return.
4. **`summaries` is also mandatory in `mountLegacyGroup`.** `registry.register` already refuses a
   spec with no non-empty summary (WP2), so mounting without one would throw anyway; failing in
   the mount with the group and verb named is the clearer refusal. No AC relaxed.

Nothing else: no second dispatcher (Rule 4), no new runtime dependency, no state written, no
generated file hand-edited, TRD-005+ untouched.

## 5. Local verification

From the repository root:
- `npm run generate:validate` → PASS (`✓ Validation passed (64 files)`, run-index matches).
- `npm run validate` → **1 error, carried from WP2, not WP3**:
  `✗ packages/full/lib/ensemble-cli.js is missing (present in packages/development/lib/)`. That
  symlink is plan E11, scheduled for WP4; the plan's full Section 5 list also runs once in WP4.
  Remaining output is pre-existing word-budget warnings.

From `packages/development`:
- `npx jest tests/engine-mount-parity.test.js tests/engine-registry.test.js tests/engine-envelope.test.js`
  → 3 suites, 23 tests, all pass.
- `npx jest tests/engine-mount-parity.test.js tests/trd-cli.test.js tests/toolchain-cli.test.js`
  → 3 suites, 95 tests, all pass (TRD-003 AC: existing legacy tests still pass).
- `npx jest` (whole package) → 314 suites / 13 280 tests, **3 suites failed**:
  - `tests/fix-issue-generated-parity.test.js` and
    `tests/implement-trd-tasks-generated-parity.test.js` — both fail only on the same
    `packages/full/lib/ensemble-cli.js is missing` validator error (confirmed by re-running
    `tests/fix-issue-generated-parity.test.js` and grepping its output): WP4/E11, not WP3.
  - `tests/local-ci-adversarial.test.js › GH_TOKEN and GITHUB_TOKEN … never reach a step` at
    `:288 expect(text).toContain('PATH')`, the `printenv` step exiting 1 on Node 26 — the same
    pre-existing environment failure WP1 recorded and proved was not run-caused.
  None of the three timing-sensitive files (`toolchain-detect.test.js`, `performance.test.js`,
  `toolchain-preflight-language-gate.test.js`) failed.
- `npx eslint <the six changed/added JS paths>` → 0 errors (eslint reports all six as "File ignored
  because matching ignore pattern"; `packages/*/lib` and `tests` are outside the lint scope).

Nothing committed or staged; `git status --porcelain` shows exactly the two modified and four new
paths listed in section 2.

## 6. Escalations and follow-ups

- **Carried from WP1/WP2 for the PR body (plan override):** TRD-001 (envelope, input validation,
  path containment, redaction) is security-sensitive. The TRD requires a **human security reviewer
  and no auto-merge** for it, so the PR body's `## Risk` section must say so.
- **WP4 must land in this PR or `npm run validate` stays red.** Two generated-parity test suites
  fail today purely because `packages/full/lib/ensemble-cli.js` does not exist yet (plan E11:
  symlinks, `packages/full/bin/ensemble`, `REQUIRED_COMMANDS`, `ENTRY_FILES`, the SKILL.md row,
  then `npm run generate && npm run generate:pi`).
- **Deviation 1 is the one judgement call a reviewer should check**: passing an unknown flag
  through to a mounted legacy verb is what makes byte parity possible, and it is scoped to verbs
  registered with `passthrough: true` (only `mountLegacyGroup` sets that). Engine verbs still
  refuse unknown flags.
- Nothing intentionally left undone inside WP3. `tests/local-ci-adversarial.test.js` was left
  failing deliberately — it is a pre-existing local-environment failure, and no test was weakened,
  skipped or deleted anywhere in this package.
