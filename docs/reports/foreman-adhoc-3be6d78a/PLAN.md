# Work packages for PR 1 (supplied and verified; do not re-plan)

This plan was produced by an earlier planning run on the same tree (HEAD `0a8e73a7`) and was checked against the code. The edits below are labelled E1 to E12. They group into work packages as follows. A package never depends on a later one.

- **WP1** = TRD-001 + TRD-001-TEST: edits E1, E2 and E3. Write `packages/development/tests/engine-envelope.test.js` first (Section 3, item 1).
- **WP2** = TRD-002 + TRD-002-TEST: edits E4, E5, E6, E7 and the registry half of E10 (`engine-registry.test.js`, Section 3 item 2). In WP2, `buildRegistry()` registers NO groups yet: the mounted `trd` and `tool` groups arrive in WP3. The registry test uses fixture verbs only.
- **WP3** = TRD-003 + TRD-003-TEST: edits E8, E9 and the parity half of E10 (`engine-mount-parity.test.js` and its fixture, Section 3 item 3). Extend `buildRegistry()` to register the mounted `trd` and `tool` groups.
- **WP4** = TRD-004 + TRD-004-TEST: edits E11 and E12 (Section 3 item 4), then the whole of Section 5 verification once, from the repository root.
- This slice has exactly four packages, numbered 1 to 4. A package number above 4 does not exist: a phase whose number is above 4 has nothing to do.

Overrides to the plan text below:

- The last paragraph of Section 5 (commit with conventional subjects, open ONE PR) does not apply. In this workflow the phases do not commit, push or open a pull request; Foreman does, after the reviews.
- Each package runs only its own test files. The full Section 5 list runs once, in WP4.
- The TRD-001 security-sensitivity statement for the PR body goes in the Escalations section of your report, so the reviewer sees it.

---

# PLAN — TRD-2026-d571763f PR 1: the `ensemble` binary and its protocol

Scope: TRD-001, -001-TEST, -002, -002-TEST, -003, -003-TEST, -004, -004-TEST. Nothing else.
Read `docs/standards/constitution.md` (Rules 4,5,6,7,8) and the PR-1 task block of
`docs/TRD/TRD-2026-d571763f-ensemble-engine-cli.md` (lines 85–243) before editing.
All paths below are relative to the repository root; `lib/` means `packages/development/lib/`.

## 1. Verdict

**Not a bug — new capability, implement as specified.** Verified on HEAD `0a8e73a7`:
`lib/engine/` and `lib/ensemble-cli.js` do not exist, `packages/full/bin/` holds only `jira`,
`grep -rn ENSEMBLE_CLI packages/` returns nothing. No new runtime dependency needed:
`packages/development/package.json` already depends on `ajv ^8.12.0` + `js-yaml ^4.1.0`, and both
are vendored in `packages/full/lib/node_modules/`.

## 2. Design facts the edits rely on

- `lib/trd-cli.js:1657` `HANDLERS` (26 verbs); `main(argv)` :1694 returns a number and writes one
  JSON line; entry guard :1771 sets `process.exitCode` (not `process.exit`).
- `lib/toolchain-cli.js:882` `HANDLERS` (7 verbs) + `trace` at :1165; `main(argv, ctx)` :1336
  returns number or Promise; entry guard :1410 calls `process.exit`.
  **Neither legacy file may be modified** (TRD-003 AC; the parity test hashes them).
- Redaction exists: `redactSecrets(text)` in `lib/complexity-analyzer.js:36` (exported).
  `lib/toolchain/ledger.js`'s recursive `redactRecord` is NOT exported — write a local recursive
  walker over `redactSecrets`; do not widen the ledger's exports.
- `scripts/validate-all.js:111 validateFullLibMirror` lists top-level `lib/*.js` only and demands a
  `packages/full/lib/<file>` symlink to `../../development/lib/<file>`. `:329` holds
  `const REQUIRED_COMMANDS = ['jira'];`. `:852 validateFullBundleRequires` demands every relative
  require under `packages/full` resolve inside it — hence the `engine` directory mirror (precedent:
  `packages/full/lib/toolchain -> ../../development/lib/toolchain`).
- `packages/pi/src/transformers/lib-bundler.ts:82 ENTRY_FILES` seeds a recursive relative-require
  closure, so `./engine/*` requires get vendored automatically.

## 3. Failing check first

Write each test file BEFORE its implementation and capture the red run:

1. `cd packages/development && npx jest tests/engine-envelope.test.js` → `Cannot find module
   '../lib/engine/envelope'`. Then E1/E2 make it green.
2. `cd packages/development && npx jest tests/engine-registry.test.js` → red, then E4–E7.
3. `cd packages/development && npx jest tests/engine-mount-parity.test.js` → red, then E8/E9.
4. `npx jest scripts/tests/ensemble-bundle-smoke.test.js` (root) → red, then E11.

## 4. Edits

### E1 — `lib/engine/envelope.js` (new, TRD-001)

- Frozen `const STATUS_EXIT = { OK:0, REFUSED:1, INVALID_INPUT:2, NEEDS_AGENT:3, NEEDS_CHOICE:4,
  UNAVAILABLE:5, INTERNAL:6 };` and `exitCodeFor(status)` that **throws** for a status not in the
  table (no fallback code — Rule 7 fail-ability).
- `sortKeys(value)` — deep; arrays preserved; plain objects rebuilt with `Object.keys(o).sort()`.
- `redact(value)` — deep walk; each string becomes `redactSecrets(str).text` from
  `require('../complexity-analyzer')`; keys are not rewritten.
- `buildEnvelope({ ok, status, verb, data, error, next })` → `sortKeys(redact({...}))` with exactly
  `ok`, `status`, `verb`, `data` **or** `error` (never both), `next` (default `null`);
  `error` is `{ code, message, details }`.
- `emit(envelope, streams)` writes `JSON.stringify(envelope) + '\n'` to stdout; nothing else ever
  reaches stdout.
- `invalidInput(verb, code, message, details)` and `internal(verb, error)`; `internal` puts only
  `error.message` in the envelope and writes `error.stack` to **stderr**, never stdout.

### E2 — `lib/engine/validate.js` (new, TRD-001)

- `const MAX_STDIN_BYTES = 4 * 1024 * 1024;`
- `readStdinCapped(stream)` — accumulate chunks and, as soon as accumulated bytes exceed the cap,
  destroy the stream and reject with `code: 'INPUT_TOO_LARGE'` **without calling `JSON.parse`**
  (the test asserts the refusal happens before parsing).
- `parseInput(text, schema)` — `ajv.compile(schema)`; on failure take the first error and emit
  `INVALID_INPUT` whose message names the offending field (`error.instancePath` or
  `error.params.additionalProperty`). Every verb schema is authored `additionalProperties: false`.
- `resolveCallerPath(projectRoot, candidate)` — refuse a value starting with `-`; `path.resolve`,
  then `fs.realpathSync.native` on the nearest existing ancestor; accept only `projectRoot` itself,
  anything under `projectRoot + path.sep`, or under
  `path.join(projectRoot, '.ensemble', 'state') + path.sep`; otherwise throw with
  `code: 'PATH_ESCAPE'`. Realpath `projectRoot` too so macOS `/var`→`/private/var` matches.
- One shared `new Ajv({ allErrors: false, strict: false })` at module scope (precedent
  `lib/toolchain/validate.js:85`).

### E3 — `packages/development/tests/engine-envelope.test.js` (new, TRD-001-TEST)

Scenarios, names as in the TRD: *one object on stdout* (fixture verb writes a warning to stderr;
`JSON.parse(stdout)` succeeds, warning only in stderr); *exit codes match statuses* (loop the seven
statuses → exactly 0..6, and `exitCodeFor('MADE_UP')` throws); *schema violation named* (stdin
`{"nope":1}` ⇒ `INVALID_INPUT`, exit 2, message contains `nope`); *oversize stdin refused* (5 MiB
`Readable` ⇒ `INPUT_TOO_LARGE` and a `jest.spyOn(JSON,'parse')` never called); *path escape refused*
(`resolveCallerPath(tmpRoot,'../../etc/passwd')` throws `PATH_ESCAPE`, and an in-process run with
`--result-file ../../etc/passwd` ⇒ `INVALID_INPUT`/`PATH_ESCAPE`/exit 2); *internal error contained*
(fixture verb throws `new Error('boom')` ⇒ status `INTERNAL`, exit 6, stdout contains no `at `
stack frame). Fixture trees via `fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
'engine-envelope-')))`, removed in `finally` (convention of `tests/toolchain-cli-project-root.test.js`).

### E4 — `lib/engine/registry.js` (new, TRD-002)

`createRegistry()` → `{ register, get, groups, verbs }`. `register` **throws naming the verb**
unless the spec has non-empty `group`, `name`, `summary`, `sideEffect` ∈ {`read`,`write`},
`inputSchema`, `outputSchema`, array `policyKeys`, array `exitCodes`, function `handler`.
A duplicate `group:name` throws.

### E5 — `lib/engine/argv.js` (new, TRD-002)

`parseArgv(argv)` → `{ group, verb, help, describe, globals, rest, error }`. Globals recognised in
**any** position, before or after the verb: `--json`, `--non-interactive`, `--run-id <v>`,
`--project-root <v>` (and `--flag=value`). First two non-flag tokens are `group` then `verb`;
`--describe` and `--help`/`-h` detected anywhere; a value starting with `-` where a value is
expected is an error. Any unrecognised `--flag` yields
`error = { code:'UNKNOWN_FLAG', message:"unknown flag '--x'" }` — never ignored, and no handler
runs. `rest` (argv after `<group> <verb>`) is passed to mounted groups untouched.

### E6 — `lib/engine/describe.js` (new, TRD-002)

- `describe(registry)` → `{ verbs: [...] }` sorted by `group` then `name`, each entry
  `{ exitCodes, group, inputSchema, name, outputSchema, policyKeys, sideEffect, summary }`.
- It **refuses, naming the verb**, when any registered verb has a missing or empty `outputSchema`
  — the TRD's "describe can fail" scenario.
- `renderGroupHelp(registry, group)` / `renderVerbHelp(registry, group, verb)` build text from
  registry fields only (no hand-written help strings); both exit 0.
- `nearestVerbs(registry, group, verb)` — Levenshtein over `"group verb"` strings, 3 closest.

### E7 — `lib/ensemble-cli.js` (new, TRD-002; Rule 6 entry point)

`function main(argv, ctx = { cwd: process.cwd(), env: process.env, stdout, stderr })` **returns
`{ envelope, exitCode }` and never calls `process.exit`**. Flow: `parseArgv` → flag error ⇒
`INVALID_INPUT`; `--describe` ⇒ one envelope from `describe()`; `--help` ⇒ registry-generated text,
exit 0; unknown group/verb ⇒ `INVALID_INPUT`, exit 2, message
`unknown verb 'implement frobnicate'; did you mean: ...` from `nearestVerbs`; else dispatch the
handler, wrapping any throw into `internal()` unless it already carries a `status`.
`buildRegistry()` registers the mounted `trd` and `tool` groups and is exported for tests.
Entry guard mirroring `trd-cli.js:1771` (`process.exitCode`, so a large stdout drains):

```js
if (require.main === module) {
  const { envelope, exitCode } = main(process.argv.slice(2));
  if (envelope) process.stdout.write(JSON.stringify(envelope) + '\n');
  process.exitCode = exitCode;
}
module.exports = { main, buildRegistry };
```

### E8 — `lib/engine/mount.js` (new, TRD-003)

`mountLegacyGroup(registry, { group, cliPath, verbs, sideEffects, summaries })`. For any name in
`verbs` with no `sideEffects[name]` entry it **throws**
``new Error(`${group}: verb '${name}' has no declared side-effect class`)`` — registration refused.
Handler: `spawnSync(process.execPath, [cliPath, verb, ...rest], { cwd, env, encoding:'buffer',
maxBuffer: 64*1024*1024 })`, then write `res.stdout` **verbatim as a Buffer** to stdout,
`res.stderr` to stderr, and return `res.status` as the exit code. The child process is what
satisfies "a legacy handler that writes `process.exit` cannot terminate the engine process"
(`toolchain-cli.js:1410` does exactly that) and what makes output byte-identical — mounted verbs
bypass the envelope deliberately ("Mounted groups keep their legacy output exactly", TRD line 91).
Registry entries for mounted verbs carry a passthrough `inputSchema`
(`{type:'object',properties:{argv:{type:'array',items:{type:'string'}}},additionalProperties:false}`)
and `outputSchema` `{type:'object',additionalProperties:true}`, so `--describe` does not refuse.

### E9 — `lib/engine/groups/trd.js` and `lib/engine/groups/tool.js` (new, TRD-003)

Declared tables only — no logic, no require of the legacy module.
- `trd.js`: `cliPath = path.join(__dirname, '..', '..', 'trd-cli.js')`; `verbs` = the 26 keys at
  `trd-cli.js:1657`; `sideEffects` = `write` for the disk-touching verbs `quickstart` (:745),
  `create-workstream-trd` (:928), `migrate-frontmatter` (:1293), `choices-write` (:1428),
  `verify` (:1626), `beads-label`, `beads-stage`; `read` for the other 19.
- `tool.js`: `cliPath = .../toolchain-cli.js`; verbs `resolve, explain, validate, run, preflight,
  confirm-status, confirm-record, trace`; `write` for `run`, `preflight`, `confirm-record`,
  `trace`; `read` for the rest.

### E10 — registry and parity tests (TRD-002-TEST, TRD-003-TEST)

- `packages/development/tests/engine-registry.test.js`: three fixture verbs → `--describe` names all
  three with both schemas, keys sorted (`expect(Object.keys(entry)).toEqual([...].sort())`);
  `main(['implement','frobnicate'])` ⇒ exit 2 with nearest verbs in the message; `--run-id r1`
  before and after the verb give deep-equal context; `--no-such-flag` ⇒ `INVALID_INPUT` with a
  `jest.fn()` handler never called; a verb registered without `outputSchema` ⇒ `--describe` refuses
  naming it.
- `packages/development/tests/engine-mount-parity.test.js` + fixture
  `packages/development/tests/fixtures/engine/trd-parity.md`: for `trd` (`parse`, `phase-status`,
  `list`) and `tool` (`resolve --json`, `explain --json`) run BOTH
  `spawnSync(node, [ensembleCli, group, verb, ...args])` and `spawnSync(node, [legacyCli, verb,
  ...args])` in the same test and assert `expect(a.stdout.equals(b.stdout)).toBe(true)` plus equal
  `status` — a live comparison, never a stored golden, so a legacy output change fails the test.
  Plus: `mountLegacyGroup` with one extra undeclared verb throws naming it; and `sha256` of
  `lib/trd-cli.js` / `lib/toolchain-cli.js` equals the hash of `execFileSync('git',['show',
  'HEAD:<path>'])` — computed in-test, not hard-coded.

### E11 — packaging (TRD-004)

1. `packages/full/bin/ensemble` (new, mode 0755): `#!/usr/bin/env node`, `'use strict';`,
   `require('../lib/ensemble-cli.js');` — builtins and relative bundle requires only, following
   `packages/full/bin/jira`.
2. Commit symlinks (not copies): `ln -s ../../development/lib/ensemble-cli.js
   packages/full/lib/ensemble-cli.js` and `ln -s ../../development/lib/engine packages/full/lib/engine`.
3. `scripts/validate-all.js:329`: `const REQUIRED_COMMANDS = ['jira'];` →
   `const REQUIRED_COMMANDS = ['ensemble', 'jira'];`
4. `packages/pi/src/transformers/lib-bundler.ts:82`: append `'ensemble-cli.js'` to `ENTRY_FILES`.
5. `packages/development/skills/tool-path-resolution/SKILL.md:74`: add a row after `RUN_INDEX_CLI`,
   same column layout —
   ``| `ENSEMBLE_CLI` | `packages/development/lib/ensemble-cli.js` | `vendor/lib/ensemble-cli.js` |``
   The "If none of the four tiers resolve … HALTs/exits" paragraph at :57 already states the
   named-error/HALT rule; do not restate it.
6. From the REPOSITORY ROOT run `npm run generate && npm run generate:pi`; commit the regenerated
   `packages/full/skills/tool-path-resolution/SKILL.md`, `packages/pi/vendor/**` and any
   `packages/pi` version bump in the SAME commit.

### E12 — `scripts/tests/ensemble-bundle-smoke.test.js` (new, TRD-004-TEST)

Follow `scripts/tests/full-bundle-install-smoke.test.js`: scratch dirs via
`fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-ensemble-bundle-'))` — **never `os.tmpdir()`** here.
Scenarios: copy `packages/full` with symlinks dereferenced and assert
`spawnSync(node, [<copy>/bin/ensemble, '--describe'])` exits 0 and its stdout parses to an envelope
listing verbs; `validateBundleBinaries(<fixture full dir>)` fails naming a launcher that is not
executable and one that bare-requires a non-builtin; `validateFullLibMirror(<fixture packages dir>)`
fails naming an entry file whose `full/lib` mirror is absent; `vendor/lib/ensemble-cli.js` exists and
`git status --porcelain` is empty after a fresh `generate:pi`; `tool-path-resolution/SKILL.md`
contains the `ENSEMBLE_CLI` row and the HALT sentence. Import validators from
`require('../validate-all')` (already exported).

## 5. Verification

From the repository root, in order; every command must exit 0:

```
npm run generate:validate
npm run validate
cd packages/development && npx jest tests/engine-envelope.test.js tests/engine-registry.test.js tests/engine-mount-parity.test.js
cd packages/development && npx jest tests/trd-cli.test.js tests/toolchain-cli.test.js
cd packages/development && npx jest
cd ../.. && npx jest scripts/tests/ensemble-bundle-smoke.test.js scripts/tests/validate-all.test.js scripts/tests/full-bundle-install-smoke.test.js
git status --porcelain    # empty after generate + generate:pi
```

`toolchain-detect.test.js`, `performance.test.js` and `toolchain-preflight-language-gate.test.js`
assert wall-clock timing: if one fails, re-run it alone before reporting it, and say so.

Commit with conventional subjects (`feat(development): ...`, `feat(full): ...`), staging only the
files named above by path (`git add <path>`; never `-A`). Open ONE PR into `dev` with headings
`## Summary`, `## Testing`, `## Risk`, `## How to revert`, `## Directed by`, and exactly
`Directed by: @ldangelo`. Under `## Risk` state that **TRD-001 is security-sensitive (envelope,
input validation, path containment, redaction) and per the TRD requires a human security reviewer,
with auto-merge off.**

## 6. Out of scope

- Do NOT modify `lib/trd-cli.js` or `lib/toolchain-cli.js` (TRD-003 AC; the parity test hashes them).
- Do NOT start TRD-005+: no `lib/engine/policy.js`, `policy/defaults.json`, `groups/engine.js`,
  `.ensemble/engine.yaml` loader, handoff, roles, plan, ledger or `implement` group.
- No new runtime dependency; no change to any `package.json` dependency block.
- No second dispatcher, daemon or durable scheduler (Rule 4); PR-1 code writes no state.
- Do not hand-edit generated files (`packages/full/skills|commands|agents/**`,
  `packages/pi/vendor/**`, anything headed `DO NOT EDIT - Generated from ...`) — regenerate instead.
- Do not touch `.beads/`, do not run `br` mutations, do not push to `dev`/`main`, do not merge.
