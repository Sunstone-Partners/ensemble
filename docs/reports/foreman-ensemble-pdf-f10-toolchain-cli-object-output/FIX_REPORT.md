# Fix report :: `toolchain-cli run` printed `[object Object]` for mapped-object capabilities

- Task: `ensemble-pdf-f10-toolchain-cli-object-output` · Run: `run-2badb1b8e88c1d0389c78a75ac012371` · Phase: `fix` (1)
- Branch: `foreman/ensemble-pdf-f10-toolchain-cli-object-output` · Base: `fe5aea4f` (`origin/dev`)
- Machine tool versions exercised: `br 0.6.0`, `bv v0.26.0`, Node 26.13.1

**Scope note.** Reporter finding 10 has two halves. Only the `[object Object]` half is in scope and is
fixed here. The `BAD_OUTPUT` half **does not reproduce** on this machine against `br 0.6.0` /
`bv v0.26.0`; the evidence and the exact mismatch analysis are under **Follow-ups**. No adapter
`parse` block was changed.

## 1. Root cause

`printResult(subcommand, json, result)` in **`packages/development/lib/toolchain-cli.js`** printed the
`run` success payload with:

```js
process.stdout.write(String(result.data) + '\n');
```

Whether `result.data` is a string or an object is decided upstream, in
`mapAndValidateOutput()` in **`packages/development/lib/toolchain/runner.js`**:

- a capability whose adapter declares a `parse` block → `mapOutput()` returns a **mapped OBJECT**
  (`packages/development/lib/toolchain/mapping.js`);
- a capability **without** a `parse` block → the tool's raw stdout passes through as a **STRING**.

`String({...})` is literally `"[object Object]"`, so the human-readable (no `--json`) path destroyed
exactly the structured capabilities the beads skills consume without `--json` —
`work-graph.ready`, `work-graph.plan`, `work-graph.graph-health`, `tracker.show`, `tracker.create`,
… — while the raw-text capabilities (`tracker.list`, `tracker.sync`, `tracker.comments`,
`tracker.find-by-key`, `tracker.label`, `tracker.stage-export`) kept working.

The convention is documented in the adapter source
`packages/development/skills/adapter-tracker-beads/adapter.yaml` — e.g. line 136
(`Raw {issues:[...]} stdout, no parse block, same reason as tracker.list.`), lines 322-331
(`same remedy: no parse block, so runCapability leaves data as raw, Ajv-unvalidated stdout text`)
and line 365 (`no parse block, same CATEGORY_NORMALIZED_SCHEMA reason as tracker.list`) — and it is
asserted by the adapter contract tests
`scripts/tests/toolchain-adapter-tracker-beads-capabilities.test.js` and
`scripts/tests/toolchain-adapter-tracker-beads-manifest.test.js`.

The defect is in the **print path only**: the `--json` envelope arm (`if (json) { … }`) was and stays
correct.

## 2. Change

| Path | Change | Rationale |
| --- | --- | --- |
| `packages/development/lib/toolchain-cli.js` | `printResult`'s `run` success arm now writes `(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)) + '\n'`, plus an inline comment naming the two data shapes; the `run` doc comment (lines 163-168) now states "the tool's raw stdout verbatim when the capability's data is a string, JSON (2-space indent) when it is a mapped object". | One branch on payload type: mapped objects become parseable JSON, strings stay byte-for-byte identical. Narrowest possible change; the `--json` arm, exit codes and stderr envelopes are untouched. |
| `packages/development/tests/toolchain-cli.test.js` | New terminal describe `run(): human-readable printResult() of a mapped OBJECT (reporter finding 10 [object Object])` (lines 1684-1849): 3 real-CLI-subprocess tests (object → parseable JSON, raw string → unchanged, `--json` → unchanged) + 2 mutation-proof tests built on the repo's existing `makeMutantToolchainRoot` / `mutateAndRequire` fixture, each carrying a comment that the needle must track the source expression in `toolchain-cli.js`. | Failing-first regression test in the harness named by the task; the mutants prove the string/object branch is load-bearing rather than the assertion being tautological. The needle comments follow the repo's existing mutation-proof pattern (the same fixture is already used at lines 702/728/1011/1148/1185/1315/1601/1646 of the same file) and turn a future reformat of the source expression into a loud "needle not found" failure instead of a silent pass. |
| `packages/pi/vendor/lib/toolchain-cli.js`, `packages/codex/.codex/skills/vendor/lib/toolchain-cli.js` | Regenerated via `npm run generate:codex` and `npm run generate:pi` (15 +/- lines each) so the vendored mirrors carry the fix. | These are generated mirrors (`DO NOT EDIT` headers). `scripts/tests/toolchain-vendor-sync.test.js` fails while they are stale, so regeneration is mandatory, not cosmetic. |

**Where the source fix lives.** `git status` shows `packages/development/lib/toolchain-cli.js` as
*unmodified* because the one-branch fix is **already committed** on this branch in the phase-1
commit `e84de467` ("Foreman run … phase 1"), whose parent is the base `fe5aea4f` (`origin/dev`):

```
$ git log --oneline fe5aea4f..HEAD
e84de467 Foreman run run-2badb1b8e88c1d0389c78a75ac012371 phase 1
$ git diff fe5aea4f HEAD --stat
 packages/development/lib/toolchain-cli.js | 15 +++++++++++++--
 1 file changed, 13 insertions(+), 2 deletions(-)
```

So the **pull request against `dev` contains the source fix** (`e84de467`) plus the uncommitted work
of this phase (the regression test, the two regenerated vendor mirrors and this report), which
Foreman stages when it commits the phase:

```
$ git diff fe5aea4f --stat        # PR diff = committed fix + this phase's work (real output)
 .../.codex/skills/vendor/lib/toolchain-cli.js      |  15 +-
 packages/development/lib/toolchain-cli.js          |  15 +-
 packages/development/tests/toolchain-cli.test.js   | 181 +++++++++++++++++++++
 packages/pi/vendor/lib/toolchain-cli.js            |  15 +-
 4 files changed, 220 insertions(+), 6 deletions(-)
```

That is the **four tracked files** of the PR; the fifth file is this report, which is still
**untracked** (`?? docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/`) and must be
staged by Foreman's phase commit — otherwise it is lost from the PR.

No skill, command, agent or adapter **source** text changed, so no prompt-word-budget baseline was
touched. `npm run generate:pi` produced **no** Pi version bump (`packages/pi/package.json` stays
`1.6.29`): `scripts/bump-pi-version-if-changed.js` only diffs `packages/pi/{prompts,agents,skills,AGENTS.md}`,
and `packages/pi/vendor` is not one of them.

## 3. Tests

New describe: `run(): human-readable printResult() of a mapped OBJECT (reporter finding 10
[object Object])` in `packages/development/tests/toolchain-cli.test.js`.

1. `capability WITH a parse block: run WITHOUT --json prints the mapped object as JSON, never
   '[object Object]'` — real CLI subprocess over a fixture adapter whose `tracker.show` **has** a
   `parse` block. Asserts stdout does not contain `[object Object]`, starts with `{`/`[`, is valid
   `JSON.parse`, equals the mapped object `{id, status}`, is multi-line (2-space indent) and ends with
   a newline.
2. `capability WITHOUT a parse block: run WITHOUT --json still prints the tool raw stdout string
   verbatim (unchanged by the fix)` — the fixture adapter's `tracker.list` has no `parse` block;
   stdout must equal the stub binary's raw stdout byte-for-byte.
3. `--json output is unchanged by the fix (single-line JSON envelope on stdout)` — stdout is a
   single-line envelope, `ok === true`, `data` equals the same normalized object.
4. Mutation-proof `reverting it to bare String(result.data) …` — with the fix reverted in a mutated
   copy of the CLI, the no-`--json` run prints `[object Object]` again and `JSON.parse(stdout)` throws.
5. Mutation-proof `reverting it to JSON.stringify(result.data, null, 2) for EVERY result …` — with
   the branch removed, the raw-stdout path is double-encoded, so its output no longer starts with
   `{`/`[`.

Fixtures are the repo's own: `mkProjectConfig` plus `writeNoWorkGraphTrackerStub` /
`writeWorkGraphTrackerControl` from
`scripts/tests/fixtures/toolchain/work-graph-fallback-tracker-stub.js`, plus a local
`mkPrintShapeTrackerAdapter` that installs a fixture adapter declaring one capability **with** a
`parse` block and one **without**, so one process exercises both data shapes.

### Failing-first evidence (red on the old code)

With the pre-fix source restored (`git show fe5aea4f:packages/development/lib/toolchain-cli.js`,
saved at `~/.omp/ensemble-pdf-f10-restore/toolchain-cli.prefix.js`) and only the new test added:

```
$ cd packages/development && npx jest tests/toolchain-cli.test.js -t 'printResult'
RED_EXIT=1
Test Suites: 1 failed, 1 total
Tests:       3 failed, 39 skipped, 2 passed, 44 total

✕ capability WITH a parse block: run WITHOUT --json prints the mapped object as JSON, never '[object Object]'
    expect(received).not.toContain(expected) // indexOf
    Expected substring: not "[object Object]"
    Received string:        "[object Object]
    "
      1753 |       expect(res.stdout).not.toContain('[object Object]');
✕ reverting it to bare String(result.data) makes run WITHOUT --json print '[object Object]' again …
✕ reverting it to JSON.stringify(result.data, null, 2) for EVERY result breaks the no-parse-block path …
```

Test 1 is red because the old code printed the literal `[object Object]`. The two mutation-proof
tests are red on the old code because the mutation needle
(`(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)) +`) does not
exist there — `mutateAndRequire: needle not found in …/packages/development/lib/toolchain-cli.js`.
Tests 2 and 3 pass before *and* after on purpose: they pin the behaviour that must **not** change
(raw-string passthrough and the `--json` envelope).

### Passing-after evidence (green)

```
$ cd packages/development && npx jest tests/toolchain-cli.test.js
GREEN_EXIT=0
Test Suites: 1 passed, 1 total
Tests:       44 passed, 44 total
```

All 5 new tests pass. No existing test was deleted, skipped, weakened or renamed.

## 4. Local verification

All commands were run from the repository root
`/Users/ldangelo/.foreman/worktrees/ensemble/ensemble-pdf-f10-toolchain-cli-object-output/run-2badb1b8e88c1d0389c78a75ac012371/workspace`
unless a `cd` is shown. Logs are retained under `~/.omp/ensemble-pdf-f10-restore/`. Nothing was
written to `/tmp`, and the repository's own `.beads/` was never touched (the scratch beads workspace
is `~/.omp/ensemble-pdf-f10/scratch/beadsws`).

| Command | Real result |
| --- | --- |
| `npm run generate:codex` | exit 0 — `Generated Codex artifacts: 24 agents, 40 command skills, 30 framework/workflow skills.` |
| `npm run generate:pi` | exit 0 — packages/pi build + `node dist/index.js`; the `postgenerate:pi` hook made **no** version bump (`packages/pi/package.json` still `1.6.29`). Re-running is idempotent (`git status` unchanged). |
| `npm run generate:validate; echo EXIT=$?` | `EXIT=0` — `✓ Validation passed (64 files)`; `✓ packages/development/lib/run-index/ matches a fresh build of the agent-core run-index stores`. Note: `generate:validate` only covers the markdown and run-index generators (`node scripts/generate-markdown.js --validate && node scripts/generate-run-index-lib.js --check`) — it does **not** cover the vendored toolchain mirrors. Verified: with the two vendor mirrors reverted to their stale `HEAD` state, `npm run generate:validate` still exits 0 while `scripts/tests/toolchain-vendor-sync.test.js` fails. The mirror gate is the jest test, not `generate:validate`. |
| `npm run validate; echo EXIT=$?` | `EXIT=0` — `✓ All plugins validated successfully`; `✓ All release versions in sync: 10.0.0`; `✓ 186 prompt file(s) within word budgets`; 7 pre-existing "below baseline" WARN lines only (`assess-config`, `completion-verification`, `ensemble-beads-build`, `ensemble-fix-issue`, `ensemble-implement-bead`, `ensemble-new-feature`, `pr-review-cycle`); no baseline was raised |
| `cd packages/development && npx jest tests/toolchain-cli.test.js` | `EXIT=0` — `Test Suites: 1 passed, 1 total; Tests: 44 passed, 44 total` (includes the 5 new tests) |
| `cd scripts && npx jest tests/toolchain-vendor-sync.test.js tests/toolchain-adapter-tracker-beads-capabilities.test.js tests/toolchain-adapter-tracker-beads-manifest.test.js` | `EXIT=0` — `Test Suites: 3 passed, 3 total; Tests: 49 passed, 49 total; Time: 5.783 s` |
| `cd packages/development && npx jest` (full package run) | `EXIT=1` — `Test Suites: 2 failed, 309 passed, 311 total; Tests: 2 failed, 3 skipped, 1 todo, 13199 passed, 13205 total; Time: 203.011 s`. The 2 failures are pre-existing/environmental — see below |
| `git stash push` (all 3 changed files) + `git checkout fe5aea4f -- packages/development/lib/toolchain-cli.js` + `cd packages/development && npx jest tests/trd-cli.test.js tests/local-ci-adversarial.test.js` | `EXIT=1` — `Test Suites: 2 failed, 2 total; Tests: 2 failed, 110 passed, 112 total`: **the same 2 failures on pure `origin/dev` content**, i.e. not caused by this change. Restored with `git checkout HEAD -- …` + `git stash pop` |
| `HOME=$HOME/.omp/ensemble-pdf-f10-restore/cleanhome XDG_CONFIG_HOME=$HOME/.omp/ensemble-pdf-f10-restore/cleanhome/.config sh -c 'cd packages/development && npx jest tests/trd-cli.test.js'` (empty scratch HOME so the operator's user-scope toolchain config is not read) | `CLEANHOME_EXIT=0` — `Test Suites: 1 passed, 1 total; Tests: 41 passed, 41 total` ⇒ failure A is caused **only** by `~/.config/ensemble/toolchain.yaml`, not by this change |
| Same clean-HOME run of `cd packages/development && npx jest tests/local-ci-adversarial.test.js` | Still fails, with the identical assertion `expect(text).toContain('PATH')` at `tests/local-ci-adversarial.test.js:288` and the local-ci report message `step "printenv" failed on Node 26 at 7a2a80897f04eb8017db329949704f5b2f15981a (exit 1)` (`nodes: [{node:26, ok:false, steps:[{name:"printenv", status:"FAIL"}]}]`) ⇒ failure B is a Node-26-on-this-machine local-ci issue, independent of HOME and of this change |
| Final re-run after the last edit (the two needle-sync comments): `cd packages/development && npx jest tests/toolchain-cli.test.js` | `NARROW_EXIT=0` — `Test Suites: 1 passed, 1 total; Tests: 44 passed, 44 total; Time: 18.962 s` |
| Final re-run after the last edit: `npm run generate:validate; echo EXIT=$?` / `npm run validate; echo EXIT=$?` | `GENVAL_EXIT=0` / `VALIDATE_EXIT=0` (unchanged by the comment-only edit) |
| Final re-run after the last edit: `cd scripts && npx jest tests/toolchain-vendor-sync.test.js tests/toolchain-adapter-tracker-beads-capabilities.test.js tests/toolchain-adapter-tracker-beads-manifest.test.js` | `SCRIPTS_EXIT=0` — `Test Suites: 3 passed, 3 total; Tests: 49 passed, 49 total; Time: 5.187 s` |
| `cat ~/.config/ensemble/toolchain.yaml` (machine cause of failure A) | `workflow: plain-git` — a **user-scope** toolchain config on the operator machine, so `tests/trd-cli.test.js`'s `TRD-037 AC-2` resolves `out.workflow.source === 'user'` and fails its `['detection','default']` assertion (exactly the "operator `toolchain.yaml` makes a toolchain test resolve `user`" case the task brief warned about). No `~/.ensemble/toolchain.yaml` exists here (only `~/.ensemble/locks/`, `trusted-hooks.json`) |
| `tests/local-ci-adversarial.test.js` (machine cause of failure B) | Fails because the local-ci `printenv` step exits 1 on Node 26 (`step "printenv" failed on Node 26 … (exit 1)`), so `expect(text).toContain('PATH')` cannot hold. Unrelated to `printResult`; also red on `origin/dev` content |
| Stash only the 2 vendor mirrors + `cd scripts && npx jest tests/toolchain-vendor-sync.test.js` | `EXIT=1` — `N vendored toolchain file(s) out of sync with packages/development/lib/toolchain{,-cli.js,/complexity-analyzer.js} / packages/development/toolchain -- run npm run generate:codex and …`. With the mirrors regenerated the same suite passes, so the regeneration is required, not cosmetic |

### Payload-type edge cases (old vs new expression, measured)

`old = String(d)`, `new = (typeof d === 'string' ? d : JSON.stringify(d, null, 2))`, each followed by
`'\n'`:

| `result.data` | old stdout | new stdout | same? |
| --- | --- | --- | --- |
| `'str'` | `"str\n"` | `"str\n"` | yes |
| `'with\n'` (raw stdout already ending in a newline) | `"with\n\n"` | `"with\n\n"` | yes (double newline is pre-existing behaviour, unchanged) |
| `null` | `"null\n"` | `"null\n"` | yes |
| `undefined` | `"undefined\n"` | `"undefined\n"` | yes |
| `42` / `true` / `false` | `"42\n"` / `"true\n"` / `"false\n"` | identical | yes |
| `[]` (array) | `"\n"` | `"[]\n"` | **no** — see Follow-ups; unreachable in practice |
| `{}` (object) | `"[object Object]\n"` | `"{}\n"` | **no** — this is the fix |

### Live old-vs-new CLI comparison

`br 0.6.0` + `bv v0.26.0`, scratch beads workspace `~/.omp/ensemble-pdf-f10/scratch/beadsws`
(3 beads: `beadsws-9f4`, `beadsws-nzp`, `beadsws-eal`):

```
# OLD code (pre-fix printResult restored), no --json:
run work-graph.ready               -> [object Object]                       exit 0
run tracker.show --arg id=beadsws-9f4 -> [object Object]                    exit 0
run tracker.list                   -> {"issues":[{"id":"beadsws-eal",...     exit 0   (raw string, correct)

# NEW code:
run work-graph.ready --json        -> {"ok":true,"capability":"work-graph.ready","adapter":"beads",
                                       "source":"default","data":{"items":[{"id":"beadsws-9f4",
                                       "title":"scratch bead two","priority":2,"status":"open","unblocks":[]}]}}
run work-graph.ready               -> {"items":[{"id":"beadsws-9f4",...            (2-space indented, parseable)
run work-graph.plan --json         -> {"ok":true, ... }                        (ok:true, no BAD_OUTPUT)
run tracker.list                   -> {"issues":[{"id":"beadsws-eal",...            byte-identical to OLD
```

### Caller audit — every consumer of `run` stdout without `--json`

Repo-wide grep for `run work-graph.` / `run tracker.` (excluding `node_modules`, `dist`), each hit
checked:

- `packages/development/skills/ensemble-beads-build/references/phase-5-plan-mode.md:8` — `run
  tracker.sync` then `run tracker.list`. **No** `parse` block → data is the raw stdout **string** →
  printed byte-for-byte unchanged by the fix. Not affected.
- `packages/development/skills/ensemble-beads-build/references/phase-5-plan-mode.md:9` — `run
  work-graph.ready`; "parse `WORK_GRAPH_RESULT`. … `{ok:true}` `READY_ITEMS=data.items`,
  `ORDERING_SOURCE=data.orderingSource`"; also `work-graph.plan` (optional) "same way". These **do**
  have `parse` blocks → pre-fix stdout was literally `[object Object]` — this is the broken consumer
  the reporter hit. Post-fix stdout is indented JSON, so `WORK_GRAPH_RESULT` / `data.items` is
  parseable. **Fixed; no prompt text change needed.**
- `packages/development/skills/ensemble-implement-trd-tasks/references/phase-2-scaffold.md:16` —
  `run tracker.list` (raw string, unchanged); `:17` — `run tracker.create … capture .data.id` (has a
  `parse` block → now JSON); `:18` — `tracker.dep-add` (has a `parse` block → now JSON); `:19` — `run
  tracker.sync` (raw string, unchanged); `:26` (Step 2.2) — `work-graph.plan` / `work-graph.graph-health`
  "via node \"$TOOLCHAIN_CLI\" run <capability>"; both have `parse` blocks → were `[object Object]`,
  now JSON.
- Every other reference in the repo already passes `--json`
  (`ensemble-onboard/SKILL.md`, `implement-trd-tasks-reference/SKILL.md`, `safe-migration/SKILL.md`,
  `ensemble-analyze-complexity/SKILL.md`, `evals/*`, `scripts/tests/*`) and is unaffected.
- A repo-wide grep for the literal `[object Object]` finds **no** caller that depended on the broken
  output (the only hits are the new test's own mutant strings). **No existing caller parsed the
  broken output**, so nothing else needs changing.

## 5. Follow-ups

1. **The `BAD_OUTPUT` half of reporter finding 10 does not reproduce on this machine** — no adapter
   `parse` block was changed. Exercised live against real `br 0.6.0` / `bv v0.26.0` in the scratch
   beads workspace `~/.omp/ensemble-pdf-f10/scratch/beadsws`:
   - `run work-graph.ready --json` → `{"ok":true,…,"data":{"items":[{"id":"beadsws-9f4",…}]}}`;
     `run work-graph.plan --json` → same envelope shape; `run work-graph.graph-health --json` →
     `ok:true`. `bv v0.26.0`'s `--robot-plan --format json` really does emit `plan.tracks[].items`,
     which matches `adapter.yaml`'s `work-graph.ready` `root: "$.plan.tracks[0].items"` +
     `emptyWhen: "$.plan.tracks"`.
   - `run tracker.show --arg id=beadsws-9f4 --json` → `ok:true`, `data` = `{id,title,type,status,labels}`;
     `br 0.6.0`'s `show` returns an array, matching `root: "$[0]"` (`br schema commands` confirms the
     `items_at: "."` single-ID shape).
   - `run tracker.create … --json` (after `preflight --require tracker.create`) → `ok:true`,
     `data` = `{"id":"beadsws-eal"}`; `br 0.6.0`'s create returns a bare object, matching `root: "$"`.
   - `run tracker.comments --arg id=… --json` → `ok:true`, `data` = `"[]\n"` (raw string, no `parse`
     block).
   So `packages/development/lib/toolchain/mapping.js` (~744-754) and the `adapter-tracker-beads`
   `parse` blocks did **not** need a one-line correction here, and per the task's instruction
   ("otherwise report the exact mismatch … and change nothing") nothing was changed. If the reporter
   saw `BAD_OUTPUT`, the cause was a different `br` build than 0.6.0 or a different `bv` output shape;
   the concrete shape that would break the current `parse` blocks is a `bv --robot-plan --format json`
   that does **not** nest items under `plan.tracks[]` (then `root: "$.plan.tracks[0].items"` yields
   nothing), or a `br show` that returns a **bare object** instead of an array (then `root: "$[0]"`
   raises `BAD_OUTPUT: mapOutput: path '$[0]' indexes '[0]' into a non-array value`). Worth a
   follow-up bead to pin a captured sample of the failing `bv`/`br` output.
2. **The other object-printing arm in `printResult` is unaffected and needs no change.** The only
   other place `result.data` reaches stdout is the fallback `renderTable(result.data)` (line ~1152,
   used by `resolve`/`explain`), which renders a `category`/`adapter`/`source` table — an object is
   exactly what it expects there. The `confirm-status` / `confirm-record` arm already uses
   `JSON.stringify(result.data)`. There is no `packs` subcommand in this CLI (grep: 0 hits).
3. **`packages/development/lib/toolchain-cli.js` has no lint/format gate of its own.** The repo ships
   no prettier/eslint config for `packages/development/lib/*.js`; the change was hand-matched to the
   surrounding file (2-space indent, ~100-column print width). `npm run validate` was run and passes.
4. **Two `packages/development` jest failures are environmental on this machine** (the user-scope
   `~/.config/ensemble/toolchain.yaml` with `workflow: plain-git`, and the local-ci `printenv` step
   exiting 1 on Node 26). Both are red on `origin/dev` content as well, and a clean-HOME run makes
   `tests/trd-cli.test.js` pass (41/41), so they were not chased, per the task brief.
5. **`result.data` is never an array in the current code path, so the one remaining behavioural
   difference (an array would print `"[]"` instead of the old empty line) is unreachable.** The
   measured table in section 4 shows that for every value the runner can actually produce — the raw
   stdout string, or an Ajv-validated mapped object — the old and new expressions print identical
   bytes. `mapAndValidateOutput()` returns either `stdout` (a string) or the plain object built by
   `mapOutput()` (`packages/development/lib/toolchain/mapping.js`), never an array, so the array
   case is not reachable without a future change to the runner's contract. Left as a documented
   difference rather than special-cased (and if it ever became reachable, printing `"[]"` instead of
   an empty line would be the better behaviour anyway).
   Related, also unchanged by this fix: a raw stdout string that already ends in `\n` still gets a
   second newline appended (`"with\n\n"` before and after). That is pre-existing behaviour of the
   print path and is out of scope here.
6. **This report file is currently untracked** (`?? docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/`).
   Foreman stages the phase's work when it commits; the report must be included in that commit or
   the PR will lose its fix report.
7. **The skill prompts that consume this output were left textually unchanged on purpose.** The
   non-`--json` consumers (`ensemble-beads-build` phase 5, `ensemble-implement-trd-tasks` step 2.2)
   already describe parsing a JSON payload (`WORK_GRAPH_RESULT`, `data.items`, `{ok:true}`), so the
   fix restores what they always expected; editing them would have been scope creep and would have
   burned prompt-word-budget headroom for nothing.

## 6. Assumptions

- **2-space indent** for non-string payloads is taken verbatim from the task's "Required behaviour"
  ("print it as JSON (JSON.stringify with 2-space indent) followed by a newline"), not chosen here.
- `result.data` is treated as *either* a string or a JSON-serialisable value. The measured table in
  section 4 shows that `null`, `undefined`, numbers and booleans print **identical bytes** under the
  old and the new expression (`null` → `"null\n"`, `undefined` → `"undefined\n"`, `42` → `"42\n"`),
  so no payload type silently changes shape. A `null`/`undefined` payload is in any case unreachable
  in practice, because every arm either returns the tool's raw stdout string or an Ajv-validated
  mapped object before `printResult` is reached (`mapAndValidateOutput` validates against
  `CAPABILITY_NORMALIZED_SCHEMA` / `CATEGORY_NORMALIZED_SCHEMA`). Flagged rather than
  special-cased.
- The failing-first requirement is satisfied by test 1 plus the two mutation-proof tests. Tests 2 and
  3 are deliberately green before *and* after: they pin the behaviour that must not regress
  (raw-string passthrough, `--json` envelope).
- "Do not change the `--json` output" was read as: the `--json` envelope arm stays byte-identical.
  Test 3 asserts exactly that.

## PR body

## Summary

`toolchain-cli run` printed the literal `[object Object]` in its human-readable (no `--json`) mode
for every capability whose adapter declares a `parse` block. `mapAndValidateOutput()` in
`packages/development/lib/toolchain/runner.js` returns a **mapped OBJECT** for those capabilities
and the tool's raw stdout **STRING** for the rest, but `printResult()` in
`packages/development/lib/toolchain-cli.js` printed both with `String(result.data)`. The skills that
consume those capabilities without `--json` — `ensemble-beads-build` phase 5
(`run work-graph.ready`, "parse `WORK_GRAPH_RESULT`") and `ensemble-implement-trd-tasks` step 2.2
(`work-graph.plan` / `work-graph.graph-health`) — therefore received unparseable output.

`printResult()` now branches on the payload type: strings are still printed byte-for-byte, objects
are printed as `JSON.stringify(data, null, 2)` plus a newline, so the same data `--json` emits is
readable without the flag. The `--json` envelope, exit codes and error envelopes are untouched. The
generated Pi and Codex vendor mirrors were regenerated to carry the fix.

Reporter finding 10's other half (`BAD_OUTPUT` against an unexpected `br 0.6.0` shape) does **not**
reproduce against real `br 0.6.0` / `bv v0.26.0` in a scratch beads workspace — every `parse` block
in `skills/adapter-tracker-beads/adapter.yaml` returned `ok: true` — so no adapter `parse` block was
changed; the exact shape that would break the current blocks is recorded under Follow-ups.

## Testing

- New failing-first regression tests in `packages/development/tests/toolchain-cli.test.js` (describe
  `run(): human-readable printResult() of a mapped OBJECT (reporter finding 10 [object Object])`),
  driven through a real CLI subprocess over a fixture adapter declaring one capability **with** a
  `parse` block and one **without**: the object payload prints valid indented JSON and never
  `[object Object]`; the raw-stdout payload still prints verbatim; the `--json` envelope is
  unchanged; two mutation-proof tests show the string/object branch is load-bearing.
- Red on the pre-fix source: `cd packages/development && npx jest tests/toolchain-cli.test.js -t
  'printResult'` → 3 failed, 39 skipped, 2 passed, 44 total (stdout was literally `[object Object]`).
  Green on the fix: `cd packages/development && npx jest tests/toolchain-cli.test.js` → 44 passed.
- `npm run generate:validate` → EXIT=0; `npm run validate` → EXIT=0 (186 prompt files within word
  budgets; no baseline raised).
- `cd scripts && npx jest tests/toolchain-vendor-sync.test.js
  tests/toolchain-adapter-tracker-beads-capabilities.test.js
  tests/toolchain-adapter-tracker-beads-manifest.test.js` → 3 suites / 49 tests passed.
- Full `cd packages/development && npx jest` → 309/311 suites, 13199 tests passed. The 2 failures
  (`tests/trd-cli.test.js` `TRD-037 AC-2`, `tests/local-ci-adversarial.test.js` `secrets environment`)
  are pre-existing: they fail identically with every change stashed and the source restored to
  `origin/dev` content, and with `HOME`/`XDG_CONFIG_HOME` pointed at an empty scratch directory
  `tests/trd-cli.test.js` passes 41/41. Their machine causes are the operator's user-scope
  `~/.config/ensemble/toolchain.yaml` (`workflow: plain-git` → workflow source resolves `user`) and
  the local-ci `printenv` step exiting 1 on Node 26.
- Live check against real `br 0.6.0` / `bv v0.26.0` in a scratch beads workspace outside the repo:
  `run work-graph.ready` printed `[object Object]` before the fix and prints parseable indented JSON
  after it; `run tracker.list` output is byte-identical before and after.
- PR diff (`git diff fe5aea4f --stat`): 4 tracked files, 220 insertions(+), 6 deletions(-) — the
  source fix, the regression test and the two regenerated vendor mirrors — plus this report, which
  is still untracked and must be staged by the phase commit.

## Risk

Low. The change is one branch inside the human-readable (`--json`-less) arm of `printResult()` in
`packages/development/lib/toolchain-cli.js`. The `--json` envelope, exit codes, stderr error
envelopes and the `resolve`/`explain` table rendering are untouched, and the raw-stdout capabilities
are asserted byte-identical by a new test. A repo-wide grep found **no** caller that depended on the
broken `[object Object]` output, so the only behaviour change is that previously unparseable output
becomes valid JSON — strictly additive for the skills that read it. Residual risk: a downstream
consumer somewhere outside this repo that scraped the literal `[object Object]` would now see JSON
instead; none exists in this repository.

## How to revert

The PR contains two commits: the source fix (`e84de467`, already on the branch) and this phase's
commit (regression test + regenerated mirrors + this report). Reverting both restores the previous
behaviour:

```
git revert <phase-commit>   # drops the test, the regenerated mirrors and the report
git revert e84de467         # drops the type branch, its inline comment and the doc-comment change
                            # in packages/development/lib/toolchain-cli.js
```

Reverting only the phase commit would leave the source fix in place but its vendor mirrors stale,
which `scripts/tests/toolchain-vendor-sync.test.js` fails on; run `npm run generate:codex &&
npm run generate:pi` if you keep the source fix and drop the mirrors. No migration or data change is
involved.

## Directed by

Directed by: @ldangelo
