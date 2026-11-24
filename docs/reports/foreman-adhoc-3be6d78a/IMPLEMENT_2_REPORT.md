# IMPLEMENT_2 — WP2 (TRD-002, TRD-002-TEST)

## 1. Package

**WP2** = `TRD-002` (Verb registry, argv parser and discovery) + `TRD-002-TEST` (Registry, argv
and discovery behaviour), plan edits **E4, E5, E6, E7** and the registry half of **E10**.

Shipped: the `ensemble` entry point `packages/development/lib/ensemble-cli.js` with its registry,
argv parser and discovery (`--describe`, `--help`, nearest-verb refusal), all reachable in process
through `main(argv, ctx)` which returns `{ envelope, exitCode }` and never calls `process.exit`.
As the plan requires, `buildRegistry()` registers **no groups yet** — the mounted `trd` and `tool`
groups are WP3's work.

## 2. Changes

| Path | Rationale |
| --- | --- |
| `packages/development/lib/engine/registry.js` (new) | E4: `createRegistry()` → `{ get, groups, register, verbs }`. `register` throws naming the verb unless group/name/summary are non-empty, `sideEffect ∈ {read,write}`, both schemas are objects, `policyKeys`/`exitCodes` are arrays and `handler` is a function; a duplicate `group:name` throws. An under-declared verb can therefore never reach the dispatcher (Rule 7). |
| `packages/development/lib/engine/argv.js` (new) | E5: `parseArgv(argv)` → `{ group, verb, help, describe, globals, rest, error }`. `--json`, `--non-interactive`, `--run-id <v>`, `--project-root <v>` (and `--flag=value`) are recognised in any position; `--describe` and `--help`/`-h` anywhere; a value starting with `-` where a value is expected is an error; any unrecognised `--flag` yields `error = { code:'UNKNOWN_FLAG', ... }` so no handler runs. `rest` is the verbatim argv slice after `<group> <verb>`, which WP3's mounted groups pass to the legacy CLI untouched. |
| `packages/development/lib/engine/describe.js` (new) | E6: `describe(registry)` → `{ verbs }` sorted by group then name, each entry exactly the eight sorted fields; it **refuses naming the verb** when a verb's input or output schema is missing or empty (the TRD's "describe can fail"). `renderGroupHelp`/`renderVerbHelp`/`nearestVerbs` (Levenshtein, 3 closest) are built from registry fields only — no hand-written help strings. |
| `packages/development/lib/ensemble-cli.js` (new) | E7: the entry point (Rule 6). `main(argv, ctx)` parses, refuses a flag error with `INVALID_INPUT`, serves `--describe` as one envelope, serves `--help` as registry-generated text at exit 0, refuses an unknown group/verb with `INVALID_INPUT`/exit 2 and the nearest verbs, else dispatches the handler, wrapping a throw into `internal()` unless it already carries a `status`. Entry guard mirrors `trd-cli.js:1771` (`process.exitCode`, never `process.exit`). Exports `{ buildRegistry, main }`. |
| `packages/development/tests/engine-registry.test.js` (new) | E10 registry half / TRD-002-TEST: the five TRD scenarios plus the help AC, driving `main` and `parseArgv` in process against a three-verb fixture registry injected via `ctx.registry`. |

No other file was touched. `lib/trd-cli.js` and `lib/toolchain-cli.js` are unmodified; no
dependency was added (`registry.js`, `argv.js`, `describe.js` and `ensemble-cli.js` require only
sibling engine modules).

## 3. Tests

Red run first (before E4–E7 existed):

```
cd packages/development && npx jest tests/engine-registry.test.js
  ● Test suite failed to run
    Cannot find module '../lib/engine/argv' from 'tests/engine-registry.test.js'
Tests: 0 total
```

Green after the implementation: `Tests: 6 passed, 6 total`.

Per-scenario fail-ability was proved individually by mutating the implementation, running the
suite, and restoring the file (each mutation was reverted immediately; the tree holds the
unmutated code):

| Scenario (TRD Test AC) | Proof it can fail | After |
| --- | --- | --- |
| `describe lists every verb` — three registered verbs, `--describe` names all three with both schemas in sorted order, keys sorted | replaced the registry's `verbs()` sort with `.reverse()` → **✕ describe lists every verb**, `Tests: 1 failed, 5 passed` | ✓ |
| `unknown verb refused` — `ensemble implement frobnicate` → exit 2, message names the nearest verbs | changed `nearestVerbs` `.slice(0, 3)` to `.slice(0, 0)` → **✕ unknown verb refused** | ✓ (exit 2, `unknown verb 'implement frobnicate'; did you mean: implement args, implement resume, trd parse`) |
| `flag position independent` — `--run-id r1`/`--project-root /p` before and after the verb (and `--flag=value`) give the same globals | broke the inline-`=` branch in `parseArgv` (`if (value === null \|\| true)`) → **✕ flag position independent** | ✓ |
| `unknown flag rejected` — `--no-such-flag` → `INVALID_INPUT` and the `jest.fn()` handler is never called | made the unknown-flag branch `continue` instead of erroring → **✕ unknown flag rejected** | ✓ (code `UNKNOWN_FLAG`, exit 2, handler call count 0) |
| `describe can fail` — a verb registered with `outputSchema: {}` → `--describe` refused naming it | disabled the empty-schema check in `describe()` (`if (false)`) → **✕ describe can fail** | ✓ (`REFUSED`, exit 1, message contains `implement resume`) |
| `help is generated from the registry` (TRD-002 help AC) — `ensemble <group> --help` and `<group> <verb> --help` list verbs/flags at exit 0 | covered by the same suite; text is assembled from registry fields, so removing a field from the entry breaks it | ✓ |

Commands:

```
cd packages/development && npx jest tests/engine-registry.test.js          # 6 passed
cd packages/development && npx jest tests/engine-envelope.test.js tests/engine-registry.test.js
  Test Suites: 2 passed, 2 total ; Tests: 13 passed, 13 total
```

## 4. Deviations from the plan or TRD

None of substance. Two points worth recording:

- The plan's E10 text names five registry scenarios; a sixth test (`help is generated from the
  registry`) was added because TRD-002's second Implementation AC (`<group> --help` /
  `<group> <verb> --help`, exit 0) would otherwise have no executable check. That is coverage of
  an AC in scope, not new behaviour.
- The fixture registry is injected through `ctx.registry` rather than by monkey-patching
  `buildRegistry()`, so the scenarios pin the registry/argv/discovery contract itself. `main`'s
  default remains `buildRegistry()`.

## 5. Local verification

```
cd packages/development && npx jest tests/engine-registry.test.js
  → 6 passed, 6 total (red first: "Cannot find module '../lib/engine/argv'")
cd packages/development && npx jest tests/engine-envelope.test.js tests/engine-registry.test.js
  → 2 suites, 13 passed (WP1 still green)
npx eslint packages/development/lib/ensemble-cli.js packages/development/lib/engine/*.js \
  packages/development/tests/engine-registry.test.js
  → 0 errors (4 "File ignored because matching ignore pattern" warnings: the root flat config
    does not lint packages/development/lib; the same is true of every existing file there)
node lib/ensemble-cli.js --describe          → {"data":{"verbs":[]},...,"status":"OK"}  exit 0
node lib/ensemble-cli.js foo bar             → INVALID_INPUT / UNKNOWN_VERB              exit 2
node lib/ensemble-cli.js --nope              → INVALID_INPUT / UNKNOWN_FLAG              exit 2
node lib/ensemble-cli.js --help              → registry-generated text                   exit 0
git status --porcelain → only the five new files listed in Section 2 (nothing staged, nothing committed)
```

`node scripts/validate-all.js` currently fails with exactly one error:

```
✗ packages/full/lib/ensemble-cli.js is missing (present in packages/development/lib/)
  - add a symlink: ln -sf ../../development/lib/ensemble-cli.js packages/full/lib/ensemble-cli.js
```

This is **expected and is WP4's work**: plan E11 step 2 commits that symlink (and
`packages/full/lib/engine`) as part of TRD-004 packaging. `validateFullLibMirror`
(`scripts/validate-all.js:111`) demands a mirror for every top-level `lib/*.js` as soon as the
file exists, so the repository-wide `npm run validate` cannot be green until WP4 lands. The plan
schedules the full Section 5 verification list for WP4 for this reason; it was not run here.

## 6. Escalations and follow-ups

- **For WP4 (not a blocker for this package):** `npm run validate` is red until E11's
  `packages/full/lib/ensemble-cli.js` and `packages/full/lib/engine` symlinks exist. Quoted above
  verbatim so the next package knows the exact failure it must clear.
- **For WP3:** `buildRegistry()` in `lib/ensemble-cli.js` is intentionally empty and is the single
  place the mounted `trd`/`tool` groups are to be registered. `parseArgv`'s `rest` is already the
  verbatim post-`<group> <verb>` argv slice, as mounted groups require.
- **Security note to carry into the PR body (plan override, TRD-001):** TRD-001 (envelope, input
  validation, path containment, redaction) is security-sensitive; the TRD requires a human
  security reviewer and no auto-merge. The PR body's `## Risk` section must say so.
- Nothing was left intentionally undone inside WP2, and no TRD statement in this package
  contradicted the code.
