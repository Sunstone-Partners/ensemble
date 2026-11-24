# IMPLEMENT_1 — WP1 (TRD-001 + TRD-001-TEST)

## 1. Package

**WP1** = `TRD-001` (Envelope, exit codes and input validation boundary) + `TRD-001-TEST`
(Envelope, exit-code and validation behaviour), plan edits **E1, E2, E3**.

Shipped: the engine's result envelope (`buildEnvelope`/`emit`/`exitCodeFor`/`invalidInput`/
`internal`, deep key sorting, deep secret redaction, frozen seven-status exit table) and its
input-validation boundary (4 MiB stdin cap enforced before parsing, ajv schema check that names
the offending field, caller-path containment to the project root or `.ensemble/state`), with the
seven-scenario test file that pins them.

No earlier package exists (WP1 is first), so nothing to check for prerequisites;
`packages/development/lib/engine/` did not exist on `HEAD` (`ac9bc5d8`) as the plan stated.

## 2. Changes

| Path | Rationale |
| --- | --- |
| `packages/development/lib/engine/envelope.js` (new) | E1/TRD-001: the one-object-on-stdout protocol — `STATUS_EXIT` frozen table, `exitCodeFor` that throws rather than defaulting, deep `sortKeys`, deep `redact` over the existing `redactSecrets`, `buildEnvelope` (carries `data` **or** `error`, never both), `emit`, `invalidInput`, `internal` (message only in the envelope; stack to stderr). |
| `packages/development/lib/engine/validate.js` (new) | E2/TRD-001: `MAX_STDIN_BYTES = 4 MiB` with `readStdinCapped` destroying the stream the moment the cap is passed (so `JSON.parse` is never reached), `parseInput` (one module-scope `new Ajv({ allErrors: false, strict: false })`, first error names the field), `resolveCallerPath` (refuses flag-shaped values, real-paths the nearest existing ancestor, admits only the project root, below it, or `<root>/.ensemble/state`, else `PATH_ESCAPE`). |
| `packages/development/tests/engine-envelope.test.js` (new) | E3/TRD-001-TEST: the six TRD scenarios plus one for the redaction Implementation AC (see §4). |

No other file was touched. `lib/trd-cli.js` and `lib/toolchain-cli.js` are untouched
(`git status --porcelain` shows only the two new paths). No dependency change: `ajv ^8.12.0` is
already in `packages/development/package.json`.

## 3. Tests

Red run first (before any `lib/engine/` file existed):

```
cd packages/development && npx jest tests/engine-envelope.test.js
→ Test suite failed to run: Cannot find module '../lib/engine/envelope' from 'tests/engine-envelope.test.js'
  Test Suites: 1 failed, 1 total   Tests: 0 total
```

After E1 + E2: `Tests: 7 passed, 7 total` (same command).

Because a module-not-found red run proves nothing about each individual scenario, every scenario
was then proved able to fail on its own (Constitution Rule 7) by breaking exactly the thing it
guards and re-running; each probe was reverted from a byte-identical backup and the suite
re-verified green afterwards.

| Scenario (TRD name) | Proof it can fail | Passes after |
| --- | --- | --- |
| one object on stdout | `sortKeys` rebuilt with `Object.keys(value)` (no `.sort()`) → ✕ `one object on stdout` (key order assertion), other 6 ✓ | ✓ |
| exit codes match statuses | `exitCodeFor` returns `0` instead of throwing for an unknown status → ✕ `exit codes match statuses`, other 6 ✓ | ✓ |
| schema violation named | `parseInput` short-circuits `if (true) return parsed;` → ✕ `schema violation named`, other 6 ✓ | ✓ |
| oversize stdin refused | cap test `if (total > MAX_STDIN_BYTES)` → `if (false)` → ✕ `oversize stdin refused`, other 6 ✓ | ✓ |
| path escape refused | containment test `if (!contained)` → `if (false)` → ✕ `path escape refused`, other 6 ✓ | ✓ |
| internal error contained | `internal()` puts `err.stack` in the envelope message → ✕ `internal error contained`, other 6 ✓ | ✓ |
| token-shaped output redacted (added, §4) | `redact` returns the string unchanged → ✕ `token-shaped output redacted`, other 6 ✓ | ✓ |

Backups: `/Users/ldangelo/.omp/ensemble-engine-trd/{envelope,validate}.bak.js`; `diff` against the
restored working files is empty.

Scenario notes:

- *oversize stdin refused* asserts `jest.spyOn(JSON, 'parse')` was **never called** — the refusal
  must precede parsing, not follow it.
- *path escape refused* covers both the unit (`resolveCallerPath(tmpRoot, '../../etc/passwd')`
  throws `PATH_ESCAPE`) and an in-process verb run with `--result-file ../../etc/passwd`, asserting
  envelope status `INVALID_INPUT`, `error.code === 'PATH_ESCAPE'` and exit code 2. Positive cases
  (`out/result.json`, `.ensemble/state/result.json`) are asserted too, so the containment cannot be
  satisfied by refusing everything.
- *internal error contained* asserts stdout holds no `at <frame>` and no test filename, and that the
  stack **is** on stderr.
- Fixture trees are `fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-envelope-')))`,
  removed in `finally` (convention of `tests/toolchain-cli-project-root.test.js`). This is test
  scratch inside jest, not run scratch; no worktree, clone or report is written under `/tmp`.

## 4. Deviations from the plan or TRD

1. **One scenario added beyond the TRD's six Test AC items**: `token-shaped output redacted`.
   TRD-001's fifth Implementation AC ("a token-shaped string … passes through the existing
   redaction") has no matching Test AC scenario, and Constitution Rule 3 requires tests covering the
   acceptance criteria. Without it the redaction code would be an unverified check. Nothing else was
   added.
2. **The test drives the two modules through a small in-test verb driver**, not through
   `lib/ensemble-cli.js`: that dispatcher is TRD-002 (WP2) and does not exist at this task. The
   protocol pinned here is owned by `envelope.js`/`validate.js`. Constitution Rule 6 (reachable from
   the entry point) is satisfied at WP2/WP3, where `ensemble-cli.js` and the mounted groups make
   these modules reachable from the real entry point; this is the plan's own package order, not a
   deviation from it. Flagged so the reviewer checks Rule 6 at the PR level, not at WP1.
3. `internal(verb, error, streams)` takes an optional `streams` argument (defaulting to
   `process.stderr`) so the stack can be routed to the caller's stderr collector; the plan names
   only `internal(verb, error)`. Same behaviour, testable without patching the global stream.

Otherwise: no deviation. No new runtime dependency, no change to any `package.json`, no second
dispatcher or scheduler (this code writes no state), no user-owned policy encoded in TypeScript
(Rule 8 — nothing user-configurable ships here; the exit-code table is protocol, not policy).

## 5. Local verification

From the repository root unless noted; all run after the implementation:

| Command | Result |
| --- | --- |
| `npm run generate:validate` | exit 0 — `✓ Validation passed (64 files)` |
| `npm run validate` | exit 0 (only pre-existing "baseline can shrink" hints) |
| `cd packages/development && npx jest tests/engine-envelope.test.js` | exit 0 — 7 passed |
| `cd packages/development && npx jest tests/engine-envelope.test.js tests/complexity-analyzer.test.js` | exit 0 — 94 passed (the redaction helper this package reuses still passes) |
| `npx eslint packages/development/tests/engine-envelope.test.js` | exit 0, no findings (`lib/**` is in the repo's eslint ignore set, so the two new lib files are reported "File ignored", as every other `lib/*.js` is) |
| `cd packages/development && npx jest` (full package suite) | **1 failed, 314 passed** suites; `Tests: 1 failed, 3 skipped, 1 todo, 13259 passed` |

The one failure is **pre-existing and unrelated**:
`tests/local-ci-adversarial.test.js › secrets and the environment › GH_TOKEN and GITHUB_TOKEN in the
maintainer environment never reach a step that prints its env, nor the result`
(`expect(text).toContain('PATH')` at `tests/local-ci-adversarial.test.js:288`; the run fails with
`step "printenv" failed on Node 26 … (exit 1)`). Proof it is not mine: with
`packages/development/lib/engine/` and `tests/engine-envelope.test.js` moved out of the tree
(`git status --porcelain` empty), the same test still fails —
`npx jest tests/local-ci-adversarial.test.js -t 'never reach a step'` → `Tests: 1 failed, 70
skipped`. Both files were moved back and the tree re-verified. The rest of that file's 70 tests
pass. This is not one of the three timing-sensitive files named in the project instructions; it
depends on the local `act`/Node-26 environment.

`prettier --check` reports the two new lib files and the test as unformatted, but prettier is not a
gate in this repository (no prettier config, not referenced by `package.json` scripts, CI workflows
or `scripts/ci-local.js`, and the existing `lib/toolchain/validate.js` and `lib/complexity-analyzer.js`
fail the same check). The repository's linter is eslint, which passes.

Not run (out of WP1 scope, and they belong to later packages per the plan): the registry, mount
parity and bundle smoke tests, `npm run generate:pi`, and the root-level `scripts/tests` jest run —
WP1 changes nothing that those gates cover. §5 of the plan runs the whole list once at WP4.

## 6. Escalations and follow-ups

- **TRD-001 is the security-sensitive task** (envelope, input validation, path containment,
  redaction). The TRD (line 701) and Constitution section 4 require a **human security reviewer
  before merge, with auto-merge off**. The PR body must say so under `## Risk`. Carried forward for
  whoever opens the PR; this phase does not commit or open it.
- **Rule 6 is not satisfied within WP1 alone**: `lib/engine/envelope.js` and
  `lib/engine/validate.js` have no call path from a product entry point until WP2 adds
  `lib/ensemble-cli.js`. Expected by the plan's package order; the PR-level reviewer should confirm
  it holds once WP2–WP4 land.
- **Plan source note (no action needed)**: at phase start `docs/reports/foreman-adhoc-3be6d78a/PLAN.md`
  read as a 414-byte phase note and `git status` showed it modified, so I read the plan from the
  supplied `/Users/ldangelo/.omp/ensemble-engine-trd/PLAN-pr1-workpackages.md` instead. By the end of
  the phase the working copy was complete again (17942 bytes, `git status` clean, `cmp` against the
  supplied plan → identical, matching `git show ac9bc5d8:…/PLAN.md`); it was a mid-write snapshot. I
  did not write to that file.
- **Pre-existing red test** `tests/local-ci-adversarial.test.js` (see §5). Left untouched; an
  operator decision whether it is an environment gap or a real defect.
- No ambiguity in TRD-001 forced a guess; nothing in WP1 was left undone.
