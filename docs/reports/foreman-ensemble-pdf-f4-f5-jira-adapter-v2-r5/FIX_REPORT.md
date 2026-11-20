# Fix report — ensemble-pdf-f4-f5-jira-adapter-v2-r5

Task: `ensemble-pdf-f4-f5-jira-adapter-v2-r5` · Run: `run-19c8e17f91019654e3020fc2e519bd36` · Phase 1 (`fix`) · base commit `fe5aea4f` (`dev`)

Reporter findings F4 and F5 both live in the Jira tracker toolchain adapter. Both are fixed; both have a
failing-first regression test. Nothing is committed — the working tree holds the change for Foreman to
commit and open the PR.

Phase status note: `foreman_inbox_send` and `foreman_task_add_comment` are not exposed to this phase, so
no operator progress notes or task work-log comments were sent; this report is the only status channel.

---

## Root cause

### F4 — the adapter invoked a `jira` binary the bundle never shipped

`packages/infrastructure/skills/adapter-tracker-jira/adapter.yaml` declares `binaries: [jira]`, a
`jira-installed` health check (`jira --version`) and run templates such as `["jira","issues","read","${id}"]`,
but no package shipped a `jira` executable: `packages/full` had no `bin/` directory at all, and the
adapter skill documented the tool as "installed globally via npm link from `~/utils/atlassian`" — a
private package that 404s on npm. The operator's machine happens to have an unrelated `jira` binary on
`PATH` (`ankitpokhrel/jira-cli`, whose command shape is `jira issue view`, not the adapter's
`jira issues read`, and whose `jira --version` is unsupported), which masks the defect locally but not
in an installed plugin.

Reproduced before the fix (PATH deliberately without any `jira`):

```
$ PATH=<dir with only node> node packages/development/lib/toolchain-cli.js preflight --require tracker.show --project-root <repo>
MISSING_BINARY: jira: required binary 'jira' was not found on PATH (health check 'jira-installed'); install jira and make sure it is on PATH, or select a different adapter for this project
EXIT=1
```

### F5 — the adapter's status vocabulary was hard-coded to Jira's 7 default statuses

`adapter.yaml` repeats the same `parse.statusMap` (`To Do`/`Backlog`/`Open` → `open`,
`In Progress`/`In Review` → `in_progress`, `Done`/`Closed` → `closed`) in `tracker.show`,
`tracker.set-status` and `tracker.close`. `packages/development/lib/toolchain/mapping.js:745` throws
`BAD_OUTPUT` for any other provider status, and the write path always sends the literal names
`To Do` / `In Progress` / `Done`, which a custom workflow may not even have.

Reproduced before the fix (mock Jira issue whose status is `Code Review`, mapped through the adapter's
own `tracker.show` parse block):

```
THREW code=BAD_OUTPUT message=mapOutput: status value "Code Review" has no entry in parse.statusMap
```

A repository could only extend the vocabulary by duplicating the whole adapter under
`.ensemble/adapters/`; the toolchain config schema (`additionalProperties: false`) had no place to
express an override.

---

## Change

### F4 — ship the `jira` command with the bundle

| Path | Rationale |
| --- | --- |
| `packages/full/bin/jira` (new, mode 0755, `#!/usr/bin/env node`) | The executable the adapter manifest actually invokes: `issues read\|list\|create\|update`, `comments create\|list`, `--version`; node builtins + global `fetch` only, no new npm dependency; Jira Cloud REST v3 basic auth from `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (+ optional `JIRA_PROJECT_KEY`), with the legacy `ATLASSIAN_SITE_URL`/`ATLASSIAN_EMAIL`/`ATLASSIAN_AUTH_TOKEN` accepted as fallbacks so an existing setup keeps working; every failure prints exactly one line to stderr and exits non-zero. |
| `packages/infrastructure/skills/adapter-tracker-jira/adapter.yaml` | `env:` now declares the four `JIRA_*` names the shipped binary reads **and keeps the four legacy `ATLASSIAN_*` names** — `runner.js#buildChildEnv` forwards *only* names declared by the manifest, so dropping the old ones would silently strip a user's credentials from a user-provided `jira` CLI. Comments document the shipped binary and the override block. |
| `packages/infrastructure/skills/jira/SKILL.md` | Replaces the "installed globally via npm link from `~/utils/atlassian`" story with the bundled command, its exact covered subcommands, the `JIRA_*` auth contract and the legacy aliases. |
| `packages/infrastructure/skills/adapter-tracker-jira/SKILL.md` | Documents the shipped binary, the `JIRA_*` variables (plus the legacy aliases) and the new per-repo status-vocabulary override. |
| `scripts/validate-all.js` | New `validateBundleBinaries()` validator: every command in `packages/full/bin/` must exist, be executable, start with `#!/usr/bin/env node` and require nothing but node builtins (so a future bundle command cannot smuggle in an unvendored dependency). |
| `scripts/tests/toolchain-jira-bin.test.js` (new) | The F4 regression test (see Tests). |

`packages/full` has no `.npmignore` and no `files` allow-list, so `packages/full/bin/` ships: confirmed
with `npm pack --dry-run` in `packages/full`, which lists `13.4kB bin/jira`. Claude Code puts a plugin's
`bin/` directory on `PATH`, which is what makes the shipped command reachable in an installed plugin.

### F5 — let a repository extend the status vocabulary from `.ensemble/toolchain.yaml`

| Path | Rationale |
| --- | --- |
| `packages/development/toolchain/schemas/toolchain-config-schema.json` | Adds one root property, `adapters`: `{ "<adapterId>": { statusMap, statusNames } }`. `statusMap` is provider status name → normalized status (`open`\|`in_progress`\|`closed`, read direction); `statusNames` is normalized status → provider status name (write direction). Both levels are `additionalProperties: false`, so a malformed override is rejected by the schema rather than silently ignored. |
| `packages/development/lib/toolchain/config.js` | New `resolveAdapterOverrides(adapterId, ctx)` reads the **project** config (`.ensemble/toolchain.yaml`, or an already-read `ctx.projectConfig`) — the same layer `resolveCategory` reads — and returns `{statusMap, statusNames}`; a malformed block throws `invalid adapter overrides (…)`. Project-level only: a repository extends an adapter's vocabulary in its own checkout, never in the user-level file. |
| `packages/development/lib/toolchain/status-overrides.js` (new) | The override logic, kept out of the runner: `declaredStatusMap()` merges the adapter's own vocabulary across capabilities, `rewriteStatusArg()` rewrites the `--status` value the command will write, `applyStatusOverrides()` returns the effective `argv` + `parse` block. |
| `packages/development/lib/toolchain/runner.js` | Applies the overrides in `runCapability`/`runCapabilitySync`. Overrides are resolved **only** when the caller supplies `opts.projectRoot`/`opts.projectConfig` — a caller that does not know its project keeps the adapter's vocabulary byte for byte. A malformed override block fails the call with `CONFIG_INVALID` instead of silently falling back. A statusMap miss now names the config key that fixes it: `… has no entry in parse.statusMap (add it to \`adapters.jira.statusMap\` in .ensemble/toolchain.yaml)`. |
| `packages/development/lib/toolchain/mapping.js` | `badOutputError()` carries a machine-readable `detail` (`{kind:'statusMapMiss', field, value}`) so the runner can extend the message without re-parsing it; the two statusMap-miss throws now set it. |
| `packages/development/lib/toolchain/work-graph-resolve.js` | The built-in `work-graph-links-fallback` path now forwards `projectRoot` inside its `execOpts`. The Jira adapter declares no `work-graph` category, so **its** work-graph capabilities resolve through that built-in, whose own `tracker.show`/`tracker.list` calls would otherwise have skipped the overrides entirely. |
| `packages/development/lib/toolchain-cli.js`, `packages/development/lib/trd-cli.js` (×2), `packages/development/lib/tracker-findings.js`, `packages/development/lib/complexity-analyzer.js` | Pass the project root (`projectRoot`) into the capability call so the runner can find the repository's `.ensemble/toolchain.yaml`. |
| `packages/development/tests/toolchain-status-overrides.test.js` (new) | The F5 regression test (see Tests). |

### Existing tests updated (none deleted, skipped or weakened)

| Path | Why |
| --- | --- |
| `scripts/tests/toolchain-adapter-tracker-jira-manifest.test.js` | The manifest's `env` list changed (now the four `JIRA_*` plus the four legacy `ATLASSIAN_*` names); the assertion (`toEqual([...])` + the names-only `^[A-Z][A-Z0-9_]*$` check) was updated, not relaxed. |
| `packages/development/tests/work-graph-module-dispatch.test.js` | Two assertions state the exact options object handed to the capability call / to the built-in fallback; they now also name the new `projectRoot` key (the assertions stay exact — every key is still named). |
| `packages/development/tests/toolchain-cli.test.js` | A mutation test replaces the exact source text of the `runCapability(...)` call in `toolchain-cli.js`; the needle/replacement were updated to the new source shape so the mutation still applies and still proves the same property. |
| `packages/development/tests/trd-cli-adapter-swap.test.js` | Same kind of source-text mutation needle on `trd-cli.js`; updated to the new source shape. |
| `scripts/tests/toolchain-cli-security-fixes-real.test.js` | Same kind of source-text mutation needle on `toolchain-cli.js`; updated to the new source shape. |
| `scripts/lint-provider-refs.baseline.json` | `node scripts/lint-provider-refs.js --update-baseline` shrank exactly one grandfathered count (`jira` skill `BINARY_IN_SKILL` 29 → 28) because the skill now mentions the binary one time fewer. No baseline was raised. |

### Generated mirrors (regenerated, not hand-edited)

`npm run generate` → `npm run generate:pi` → `npm run generate:codex` → `npm run generate:opencode` from
the repository root. Regenerated: `packages/pi/skills/{adapter-tracker-jira/{SKILL.md,adapter.yaml},jira/SKILL.md}`,
`packages/pi/vendor/lib/**` (incl. the new `packages/pi/vendor/lib/toolchain/status-overrides.js`),
`packages/pi/vendor/toolchain/schemas/toolchain-config-schema.json`,
`packages/codex/.codex/skills/adapter-tracker-jira/{SKILL.md,adapter.yaml}`,
`packages/codex/.codex/skills/vendor/lib/**` (incl. the new `status-overrides.js`),
`packages/codex/.codex/skills/vendor/toolchain/schemas/toolchain-config-schema.json`.
`npm run generate:pi` produced **no Pi version bump**: `scripts/bump-pi-version-if-changed.js` compares
against the `origin/main` merge-base (`fefa1f20`, version `1.6.28`) and defers when the branch already
carries a newer, human-set version (`1.6.29`).

---

## Tests

### F4 — failing first, then green

New file `scripts/tests/toolchain-jira-bin.test.js` (13 tests): the bundle ships `packages/full/bin/jira`
as an executable node script with no non-builtin `require`; `jira --version` exits 0 with an empty stderr;
and, against a **local `http` server started inside the test** (no real network), each subcommand's
request and its output shape are asserted — `issues read` → `GET /rest/api/3/issue/{key}` with Basic auth,
`issues list` → `GET /rest/api/3/search/jql` with `maxResults` and `project = "VA"`, `issues create` →
`POST /rest/api/3/issue` with an ADF description, `issues update --summary` → `PUT /rest/api/3/issue/{key}`,
`issues update --status` → `GET`+`POST .../transitions`, `comments create` → `POST .../comment`,
`comments list` → `GET .../comment`; the legacy `ATLASSIAN_*` names work as fallbacks; a missing config
and an HTTP 404 each produce exactly one stderr line and a non-zero exit. Every command's stdout is
additionally fed through the **adapter's own parse block**
(`mapOutput(stdout, MANIFEST.capabilities[…].parse)`) to prove the binary and the adapter agree.

Red (before `packages/full/bin/jira` existed):

```
$ npx jest scripts/tests/toolchain-jira-bin.test.js
Tests:       12 failed, 12 total
JEST_EXIT=1
```

Green (after):

```
$ npx jest scripts/tests/toolchain-jira-bin.test.js
Tests:       13 passed, 13 total
EXIT=0
```

(The 13th test — the legacy-alias fallback — was added with the back-compatibility change in the review
round; it is green on the new code by construction and would fail on the pre-alias binary.)

### F5 — failing first, then green

New file `packages/development/tests/toolchain-status-overrides.test.js` (11 tests), using the existing
`packages/development/tests/toolchain-*.test.js` harness:

* `tracker.show` on a mock Jira issue whose status is `Code Review` maps to `in_progress` once the repo
  sets `adapters.jira.statusMap` (fails before the fix: `received false`).
* A status with no entry still fails `BAD_OUTPUT`, and the message names the config key
  (`adapters.jira.statusMap`) that fixes it.
* `tracker.set-status` with normalized status `open` writes the overridden name (`Backlog`).
* `tracker.close` writes the overridden name (`Resolved`).
* **No override ⇒ identical to before**: `In Review` still normalizes to `in_progress` and `set-status open`
  still writes `To Do`.
* `resolveAdapterOverrides()` returns empty maps when the project sets none.
* The schema rejects a malformed `statusMap` value and an unknown key inside the block.
* A runner call with a malformed project config fails `CONFIG_INVALID` instead of spawning anything.
* The built-in `work-graph` fallback forwards the project root to its tracker calls, so the overrides
  apply on the path the Jira adapter actually takes for `work-graph.*` capabilities.

Red (old code, new test): the tracked source changes were stashed, the new test kept:

```
$ cd packages/development && npx jest tests/toolchain-status-overrides.test.js
Tests:       8 failed, 2 passed, 10 total
JEST_EXIT=1
```

(the 8 red assertions: `Code Review` not normalized, the error message without the config-key hint,
`To Do` instead of `Backlog`, `Done` instead of `Resolved`, `TypeError: resolveAdapterOverrides is not a
function` ×3, and the malformed config not failing). The 2 that pass in red are the "defaults unchanged"
cases — they must pass before *and* after.

Green (after):

```
$ cd packages/development && npx jest tests/toolchain-status-overrides.test.js
Tests:       11 passed, 11 total
EXIT=0
```

Red (the built-in-fallback plumbing test, with `work-graph-resolve.js` reverted to its base content):

```
$ cd packages/development && npx jest tests/toolchain-status-overrides.test.js
  ● per-adapter status overrides: every tracker call path carries the project root ›
    the work-graph builtin fallback forwards the project root to its tracker calls
    Expected: "/some/project"
    Received: undefined
Tests:       1 failed, 10 passed, 11 total
```

Green after restoring the fix: `Tests: 11 passed, 11 total`.

---

## Local verification

Commands run from the repository root unless stated otherwise. Every result below is the real exit code.

| Command | Result |
| --- | --- |
| `node packages/development/lib/toolchain-cli.js preflight --require tracker.show --project-root <repo>` with a PATH without `jira` (**before**) | `MISSING_BINARY: jira: required binary 'jira' was not found on PATH (health check 'jira-installed'); …` — exit 1 |
| same command with `packages/full/bin` on PATH (**after**) | `jira-installed` passes (no longer reported); `jira-auth` fails only because no Jira server is reachable: `HEALTH_FAILED: … request to http://127.0.0.1:9/rest/api/3/search/jql?… failed: fetch failed` — exit 1 |
| `packages/full/bin/jira --version` | `jira 1.0.0`, exit 0 |
| `npm pack --dry-run` (in `packages/full`) | tarball lists `13.4kB bin/jira` — the command ships |
| `npx jest scripts/tests/toolchain-jira-bin.test.js` | 13 passed, 13 total (red run before the binary existed: 12 failed) |
| `cd packages/development && npx jest tests/toolchain-status-overrides.test.js` | 11 passed, 11 total (red run on the old code: 8 failed, 2 passed; red run for the fallback plumbing test: 1 failed, 10 passed) |
| `npx jest scripts/tests/toolchain-jira-bin.test.js scripts/tests/toolchain-adapter-tracker-jira-manifest.test.js scripts/tests/toolchain-adapter-tracker-jira-capabilities.test.js scripts/tests/toolchain-vendor-sync.test.js scripts/tests/toolchain-runtime-parity.test.js` | 5 suites, 63 tests passed |
| `cd packages/development && npx jest tests/toolchain-status-overrides.test.js tests/work-graph-module-dispatch.test.js tests/trd-cli-adapter-swap.test.js tests/toolchain-cli.test.js` | 4 suites, 73 tests passed (these three suites needed the source-shape updates listed above) |
| `npm run generate:validate; echo EXIT=$?` | `EXIT=0` — "✓ Validation passed (64 files)" and the run-index matches a fresh build |
| `npm run validate; echo EXIT=$?` | `EXIT=0` — validators, version sync, provider-ref lint, taxonomy coverage, contract docs and skill-spec validation all pass. Only pre-existing advisory hints remain (prompt-budget "below baseline" notes). |
| `npm run generate` / `npm run generate:pi` / `npm run generate:codex` / `npm run generate:opencode` | exit 0 each; Pi version **not** bumped (branch already carries `1.6.29` over the `1.6.28` merge-base) |
| `npx jest scripts/tests` (full script suite) | 95 suites: **93 passed, 2 failed**; 1 910 tests: 1 905 passed, 4 failed, 1 skipped. The 4 failures are **pre-existing and environmental** — verified by re-running the same two suites with this change stashed: `TRD-003-TEST: provider selection precedence chain › Scenario: Shipped default fallback`, `detect signal types › git_config_set …` (×2) and `mutation-proof branches › OR semantics …` fail identically on the base tree. |
| `cd packages/development && npx jest` (full package) | 312 suites: **310 passed, 2 failed**; 13 211 tests: 13 205 passed, 2 failed, 3 skipped, 1 todo. Both failures are **pre-existing**, reproduced on the base tree: `runResolveSdlc › TRD-037 AC-2` (the operator's user-level toolchain config resolves source `user` instead of `detection`/`default` — the case the task brief calls out) and `secrets and environment › GH_TOKEN and GITHUB_TOKEN …` (the local-CI `printenv` step fails on this machine's Node v26.13.1; the repo's `engines` are 22/24). An earlier run of the same suite also hit a `kata-preflight` 5 s timeout flake under load; it passes when re-run alone (`npx jest tests/kata-preflight.test.js` → 11 passed) and did not reproduce in the final run. |
| `node scripts/validate-all.js` | exit 0 — "✓ 1/1 packages/full/bin/ command(s) executable and dependency-free" |

---

## Follow-ups

* **The bundled command ships with the `full` bundle only.** `packages/pi` and `packages/codex` are
  generated mirrors and do not carry a `bin/` directory, so a user who installs only the Pi or Codex
  plugin and selects the Jira tracker still needs a `jira` command on `PATH`. The task scoped the
  shipping requirement to the `full` bundle ("the 'full' bundle symlink farm must expose bin/jira");
  extending it to the other plugins means teaching each plugin to expose its `bin/` on `PATH`.
* **Name collision with a pre-existing `jira` CLI.** If the operator already has another `jira` on
  `PATH` (e.g. `ankitpokhrel/jira-cli`, whose `jira issue view` differs from the adapter's
  `jira issues read`), the adapter will call that tool instead of the bundled one whenever the plugin's
  `bin/` is not first on `PATH`; the `jira-installed` health check (`jira --version`) cannot tell the
  two apart. Resolving this robustly needs the runner to prefer a known bundle path over a bare `PATH`
  lookup — a runner change beyond this task's scope.
* `packages/full/bin/jira` implements exactly the command set the Jira adapter manifest invokes
  (`issues read|list|create|update`, `comments create|list`, `--version`). The `jira` *skill* documents a
  wider surface (`issues search`, `issues fetch`, `issues transitions`, `projects list`, `users list`); the
  bundled command deliberately does not implement those, and the skill now says so. Implementing them is
  a separate, larger piece of work.
* `tracker.list` returns items whose `status` is **not** normalized: `mapping.js` translates a status only
  at the top level of the mapped result, so per-item statuses inside an array keep the provider's spelling.
  The override therefore applies to `tracker.show`, `tracker.set-status` and `tracker.close` only. The
  task's required behaviour names `tracker.show` (and the write path), so per-item normalization stays a
  follow-up in `mapping.js` — it is the pre-existing gap the adapter skill's "Known limits" already
  documents.
* The bundled command talks to Jira Cloud REST v3 only (basic auth, no SSO/OAuth, no Jira Server/Data Center).
* The `jira-auth` health check (`jira issues list --limit 1`) needs reachable Jira credentials; a plugin
  installed without credentials reports `HEALTH_FAILED` for that check instead of `MISSING_BINARY`.
* Operational notes for Foreman: during this phase another run's files (task
  `ensemble-pdf-f2-bundle-glob-dependency-r5`) appeared in this worktree and a `git stash` round-trip lost
  the uncommitted work; it was recovered from the dropped stash commit (`02626449`) and the foreign files
  were removed after verifying they were byte-identical to that run's own worktree. Separately, this
  phase's `FIX_REPORT.md` was twice overwritten by an unrelated run's tool-error JSON envelope, so the
  report is written to `~/.omp/ensemble-pdf-f45-r5/FIX_REPORT.md` first and copied in afterwards.

## Assumptions

* **"No override ⇒ behaviour byte-identical to today"** is read as: the default mapping table and the
  spawned argv are unchanged. The `BAD_OUTPUT` *message* for an unmapped status intentionally gains the
  config-key hint, because the task requires the message to name the key that fixes it.
* The override lives in the **project** config (`.ensemble/toolchain.yaml`), not the user-level file: the
  requirement is "a repo extends the map in its toolchain config".
* `statusMap`/`statusNames` are keyed by **adapter id** (`adapters.jira.*`) rather than by category
  (`tracker.*`), because a category can be served by different adapters with different vocabularies; the
  per-adapter key is the smallest addition that fits the existing config layer (one new root property).
* The write-side override applies to every `--status` the adapter writes, including `tracker.close`'s
  literal `Done` — the adapter's own vocabulary is used to resolve which normalized status a written name
  means, so no capability-specific special-casing is needed.
* The normalized vocabulary stays `open` / `in_progress` / `closed` (the vocabulary the existing adapter,
  category contract and normalized-output schema already use); a repository maps *its* provider names onto
  those, it does not introduce new normalized statuses.
* `packages/full/bin/` is shipped by virtue of `packages/full` having no `.npmignore` and no `files`
  allow-list (proven with `npm pack --dry-run`); the new validator guards the file's mode, shebang and
  dependency-freedom rather than the packaging step.
* The legacy `ATLASSIAN_*` variable names stay declared in the manifest. They were the adapter's only
  declared names before this change, so removing them would silently strip an existing user's credentials
  from a user-provided `jira` CLI; keeping them costs nothing and the bundled command reads the three
  relevant ones as fallbacks.

---

## PR body

## Summary

Fixes reporter findings F4 and F5 in the Jira tracker toolchain adapter.

**F4 — the bundle shipped no `jira` command.** The adapter manifest declares `binaries: [jira]`, a
`jira-installed` health check (`jira --version`) and run templates like `jira issues read {id}`, but no
package provided that executable, so every Jira tracker call in an installed plugin failed with
`MISSING_BINARY: jira`. This adds `packages/full/bin/jira` — an executable, dependency-free node script
(node builtins + global `fetch`) that implements exactly the subcommands, flags and JSON shapes the
manifest invokes, plus `jira --version`, authenticating against Jira Cloud REST v3 with `JIRA_BASE_URL`,
`JIRA_EMAIL` and `JIRA_API_TOKEN` (the legacy `ATLASSIAN_SITE_URL`/`ATLASSIAN_EMAIL`/`ATLASSIAN_AUTH_TOKEN`
names still work as fallbacks, and the manifest keeps declaring the legacy `ATLASSIAN_*` names so an
existing setup does not lose its credentials). The `jira` skill and the adapter skill now document the
shipped command and its variables, and a new validator (`validateBundleBinaries`) requires every
`packages/full/bin/` command to be executable, shebanged and free of non-builtin imports.

**F5 — the status vocabulary was hard-coded to Jira's 7 default statuses.** An issue in any other workflow
status (`Code Review`, `QA Testing`, …) failed `tracker.show` with `BAD_OUTPUT: status value "Code
Review" has no entry in parse.statusMap`, and writing a status always sent `To Do`/`In Progress`/`Done`.
A repository can now extend both directions from `.ensemble/toolchain.yaml` without duplicating the
adapter:

```yaml
adapters:
  jira:
    statusMap:            # provider status name -> normalized status (read)
      "Code Review": in_progress
    statusNames:          # normalized status -> provider status name (write)
      open: Backlog
```

The schema gains one root property (`adapters`, `additionalProperties: false` at both levels, so a
malformed override is rejected), `config.js` gains `resolveAdapterOverrides()` reading the project config
that `resolveCategory` already reads, and the runner applies the override to the effective `parse.statusMap`
and to the `--status` value it spawns — including on the built-in `work-graph` fallback path the Jira
adapter actually uses. Defaults are untouched when no override is present; a status with no entry still
fails loudly, and the message now names the config key that fixes it
(`(add it to \`adapters.jira.statusMap\` in .ensemble/toolchain.yaml)`). A malformed override block fails
the call with `CONFIG_INVALID` instead of silently falling back.

## Testing

* New `scripts/tests/toolchain-jira-bin.test.js` (13 tests, 12 red before the binary existed) drives the
  shipped command against a local `http` server and asserts each subcommand's request, its output shape and
  that the adapter's own parse block consumes that output.
* New `packages/development/tests/toolchain-status-overrides.test.js` (11 tests, 8 red on the old code)
  covers `tracker.show` with a `Code Review` status, `set-status`/`close` writing the overridden names,
  the unchanged defaults when no override is set, the schema rejecting malformed override blocks and the
  project-root plumbing on the built-in `work-graph` fallback path (1 red before that fix).
* Existing tests updated for the intentional contract changes (the manifest's `env` list, the exact
  capability-call options objects, and three source-text mutation needles); none deleted, skipped or weakened.
* `npm run generate:validate` → exit 0; `npm run validate` → exit 0; `npm pack --dry-run` in `packages/full`
  lists `bin/jira`; `npx jest scripts/tests` → 93/95 suites pass, the 4 failing tests fail identically on the
  base tree (operator-level toolchain config / global git config / Node 26 `printenv`);
  `cd packages/development && npx jest` → 310/312 suites pass, both failures pre-existing on the base tree.

## Risk

Low-to-moderate. The behavioural change is confined to the toolchain runner and its callers: the override
is resolved only when a caller passes a project root, so existing callers that do not are unaffected. The
`BAD_OUTPUT` message for an unmapped status gains a hint (message text only), and the manifest keeps the
legacy `ATLASSIAN_*` names declared so no existing credential setup is silently broken. The schema property
is additive, and an invalid override block fails loudly rather than silently. The shipped command is
dependency-free and only talks to Jira Cloud REST v3; it changes nothing for the `beads` adapter or any
other tracker adapter. Two known limits: the command ships with the `full` bundle only (the Pi/Codex
mirrors do not expose a `bin/` directory), and a pre-existing `jira` CLI earlier on `PATH` could still be
called instead of the bundled one.

## How to revert

Revert this commit (or `git revert` the PR merge). The change is self-contained: the new
`packages/full/bin/jira`, `packages/development/lib/toolchain/status-overrides.js`, the two new test files,
the `adapters` schema property, the runner/config/mapping/work-graph-resolve changes, the skill and
adapter-manifest edits, the `validateBundleBinaries` validator, and the regenerated mirrors. No data
migration, no persisted state.

## Directed by

Directed by: @ldangelo
