# CodeRabbit Review — ensemble-pdf-f7-f11-bundle-path-hygiene-r3

Phase 2 (`coderabbit-review`), run `run-2eb3612b8628e9ea51a8567fc984fcb8`.
Base branch: `dev` (resolved, non-empty). Head under review: `40fa70b6`.

## Review engine

Command run from the worktree root (all three rounds, exit code 0 each):

```
coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"
```

`$FOREMAN_BASE_BRANCH` = `dev`. `coderabbit` 0.9.6 at `/Users/ldangelo/.local/bin/coderabbit`. No auth error.

Round 2 and round 3 additionally passed `--fresh`, because the first round-2
attempt returned `"reused": true` with `"No fresh detailed file review
performed in run"`. Round 3 was also run under an interactive login shell
(`zsh -ic`) to rule out suppressed environment variables.

Machine-readable tail of every round:

```json
{"type":"complete","status":"review_completed","findings":0, ...}
```

### Headline: the branch contains no code to review

`git diff dev...HEAD --stat` for this branch is:

```
docs/reports/.../FIX_REPORT.md | 2 ++
1 file changed, 2 insertions(+)
```

That file is 2 bytes — two blank lines. It has none of the sections the
implementation phase was required to produce (Root cause, Change, Tests,
Local verification, Follow-ups, Assumptions, PR body).

So **CodeRabbit's `findings: 0` is not evidence of a clean review.** The only
file in the review surface is an empty markdown report; there is no code diff
for it to analyse. `reviewedFiles` in every round lists `FIX_REPORT.md` alone.

Because the acceptance criteria are checkable from the diff and are not met,
this phase reports a blocking finding instead of a pass. It does not implement
the work itself: a review phase that writes the fix has nothing independent
reviewing it, the `prd-cli.js` question is a design decision that belongs to
the implementation phase, and the required failing-first smoke test has to show
its red run in `FIX_REPORT.md`, which only the implementation phase can do.

## Rounds

### Round 1 — `coderabbit review --agent --base dev`

- Findings received: 0 (1 file reviewed: `FIX_REPORT.md`).
- Fixed: none. Declined: none.

### Round 2 — `coderabbit review --agent --fresh --base dev`

- First attempt returned `"reused": true` (cached round-1 result), so it was
  re-run with `--fresh`.
- Findings received: 0. Fixed: none. Declined: none.

### Round 3 — `zsh -ic 'cd <worktree> && coderabbit review --agent --fresh --base dev'`

- Run to exclude the possibility that `HTTP_PROXY`/`NO_PROXY` handling in the
  non-login shell was silencing the engine.
- Findings received: 0. Fixed: none. Declined: none.

No `Critical` or `Major` CodeRabbit finding was produced in any round, so under
the round rule this phase would stop here. The blocking findings below come
from direct verification of the task's own acceptance criteria against the
working tree, not from CodeRabbit.

## Fixed

None. There is no code in this branch to fix, and no CodeRabbit finding to act
on. Nothing in the working tree was modified by this phase; `git status
--short` shows only this report as untracked.

## Declined

None declined. (No findings were returned to decline.)

## Verification

### Verification of the task's own acceptance criteria

Each claim below was executed in this worktree at head `40fa70b6`. Branch
content is identical to `dev` apart from the empty `FIX_REPORT.md` and this
report, so every statement below is equally true of `dev`.

### F7a — `reqnroll-cli.js` is not in the bundle

`packages/full/lib/` contains 109 entries and **no** `reqnroll-cli.js`,
`reqnroll-gen.js` or `reqnroll-run.js`. They exist only under
`packages/product/lib/`, where `reqnroll-cli.js` requires `./prd-parser`,
`./prd-cli`, `./reqnroll-gen` and `./reqnroll-run`.

Three shipped skills resolve `${CLAUDE_PLUGIN_ROOT}/lib/reqnroll-cli.js` first:

| Shipped path | Line |
| --- | --- |
| `packages/full/skills/ensemble-check-binding-drift/SKILL.md` | 39 |
| `packages/full/skills/ensemble-generate-reqnroll-bindings/SKILL.md` | 42 |
| `packages/full/skills/ensemble-reqnroll-tdd/SKILL.md` | 37 |

Each reads: *"Resolve REQNROLL_CLI to first existing path among:
`${CLAUDE_PLUGIN_ROOT}/lib/reqnroll-cli.js`, `packages/product/lib/reqnroll-cli.js`"*.
Inside an installed bundle the first path does not exist, so the skill falls
back to a repo-relative path that the installed plugin also will not have.

### F7b — `prd-cli.js` is not a superset, so the prescribed relink is unsafe

`packages/full/lib/prd-cli.js` is a symlink to `../../development/lib/prd-cli.js`.

```
node packages/development/lib/prd-cli.js list   -> exit 0  {"ok":true,"type":"prd","items":[...]}
node packages/product/lib/prd-cli.js list       -> exit 1  "Usage: prd-cli <parse|generate-features|check-drift> ..."
```

The two CLIs are **disjoint**, not supersets:

| File | Dispatch | Subcommands |
| --- | --- | --- |
| `packages/development/lib/prd-cli.js:347-351` | `HANDLERS` map | `list`, `status`, `migrate-frontmatter` |
| `packages/product/lib/prd-cli.js:185-199` | `if` chains | `parse`, `generate-features`, `check-drift` |

Error shape differs too: development emits `{error:...}` JSON on stdout, product
prints a usage string to stderr. The task said to prove the product copy is a
superset **before** repointing `full/lib/prd-cli.js` at it. It is not, so the
literal fix as written would break `list`, `status` and `migrate-frontmatter`
for every consumer of `full/lib/prd-cli.js`. The skill that needs
`generate-features` is
`packages/full/skills/ensemble-generate-feature-tests/SKILL.md:41-42`.

### F11 — e2e-testing contract files are not in the bundle

`packages/full/agents/e2e-testing/playwright-tester.yaml` (shipped copy;
`packages/full/agents/e2e-testing` is a symlink to `../../e2e-testing/agents`)
names three files that `packages/full/lib/` does not contain:

| Referenced file | Lines in the shipped yaml |
| --- | --- |
| `packages/e2e-testing/lib/delegation-contract.js` | 57, 121 |
| `packages/e2e-testing/lib/test-runner-mode.js` | 70 |
| `packages/e2e-testing/lib/grounded-marker-checker.js` | 93 |

The markdown mirror `packages/full/agents/e2e-testing/playwright-tester.md`
carries the same references (lines 30 and 53).

### Required install smoke test — absent

`scripts/tests/` holds 43 suites and none dereference-copies `packages/full` or
asserts that a `${CLAUDE_PLUGIN_ROOT}/lib/<x>.js` reference resolves inside the
bundle. This is the test that would have caught all three findings.

### Validator gap — confirmed by a green `npm run validate`

`npm run validate` exits **0** on this tree while the bundle is broken, which is
the defect the task asks to close.

- `scripts/validate-all.js:65-90` `validateFullLibMirror()` walks
  `packages/development/lib/*.js` and asserts each has a mirror in
  `packages/full/lib/`. It is one-directional: it never looks at what skills or
  agents reference.
- `scripts/validate-all.js:551+` `validateFullBundleRequires()` only checks that
  bare `require()` calls inside bundled code resolve inside `packages/full`. It
  never scans skill or agent markdown for `${CLAUDE_PLUGIN_ROOT}/lib/<x>.js`.

### Also not done

`packages/full/CHANGELOG.md` has no `[Unreleased]` entry describing the new
bundle contents, and no `npm run generate` / `npm run generate:pi` mirror output
is present in the branch.

### Commands run and exit codes

| Command | Exit |
| --- | --- |
| `coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"` | 0 |
| `coderabbit review --agent --fresh --base dev` (rounds 2 and 3) | 0 |
| `npm run validate` | 0 |
| `npx jest scripts/tests` | 1 (pre-existing, see below) |
| `npx markdownlint-cli2 docs/reports/.../REVIEW_CODERABBIT_REPORT.md` | 0 |
| `node packages/development/lib/prd-cli.js list` | 0 |
| `node packages/product/lib/prd-cli.js list` | 1 |
| `git diff dev...HEAD --stat` | 0 (1 file, 2 insertions) |

### About the jest failures

`npx jest scripts/tests` → **Test Suites: 2 failed, 92 passed, 94 total;
Tests: 4 failed, 1 skipped, 1892 passed, 1897 total.**

All four failures are one environment cause, not four defects: this operator's
machine has a real user config at
`/Users/ldangelo/.config/ensemble/toolchain.yaml` containing `workflow:
plain-git`. `getEnsembleConfigRoot()`
(`packages/development/lib/toolchain/config-path.js:26-47`) prefers
`$XDG_CONFIG_HOME/ensemble`, so `resolveCategory()`
(`packages/development/lib/toolchain/config.js:143-171`, read at `:154-157`)
returns `{value:'plain-git', source:'user'}` where the tests expect
`{value:..., source:'default'}`. Failing cases:
`scripts/tests/toolchain-config.test.js:229` and three `git_config_set` /
multi-signal cases in `scripts/tests/toolchain-detect.test.js` (around `:379`
and `:434`). The task prompt anticipates exactly this condition ("A
`~/.ensemble/toolchain.yaml` on the operator's machine can make some toolchain
tests resolve source `user` and fail even on `origin/dev`"). Unrelated to bundle
paths; not chased, not in scope. There is no `~/.ensemble/toolchain.yaml` here —
the file lives under `.config/ensemble/`, which is the same XDG path the code
reads.

### Recommendation

Re-run the implementation phase. Options for `prd-cli.js` (the implementation
phase should choose, not this one):

1. Make `packages/product/lib/prd-cli.js` a superset that also serves
   `list`, `status` and `migrate-frontmatter`, with tests covering those three,
   then repoint `packages/full/lib/prd-cli.js` at it; or
2. Bundle the product CLI under a distinct name (e.g.
   `full/lib/prd-features-cli.js`) and update
   `packages/full/skills/ensemble-generate-feature-tests/SKILL.md:42` to call
   it, leaving `full/lib/prd-cli.js` on the development copy.

Also note for the operator: `foreman_task_list` shows three tasks titled *"fix(full):
make every lib path a shipped skill or agent names resolve inside the installed"* —
`run-8443f0c23e2e548e1e641eb95cb30b45` (`failed`),
`run-fa406d3e12dd1373808198e55b3a90ec` (`in_progress`, the `-r2` attempt) and this
`run-2eb3612b8628e9ea51a8567fc984fcb8` (`in_progress`). Check whether `-r2`
produced real work before a third implementation attempt is started.

### Status update delivery

`foreman_inbox_send` succeeded twice — start-of-phase note
(`msg_6mw7r0sQNDwlQgE-4P_VrA`) and completion note
(`msg_-MctrLF5MLtlOPkC_T_1VA`, severity `critical`) carrying the empty-phase
finding and the `-r2` still-in-progress fact.
`foreman_task_add_comment` failed twice: with the documented arguments
(`run_id`, `workflow_name`, `phase_name`, `description`) it returns
`Error: Task external_id is malformed`; adding `task_id` returns
`Error: Unknown arguments: task_id`. `foreman_task_list` shows
`external_id: null` for this task, so the tool has no Beads external id to
resolve — a Foreman-side data gap, not a phase error.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
- `docs/reports/foreman-ensemble-pdf-f7-f11-bundle-path-hygiene-r3/FIX_REPORT.md:1` Critical — the implementation phase committed only a 2-byte empty report and zero code, so none of this task's deliverables (bundle links, validator rule, install smoke test, CHANGELOG entry) exist on the branch and it must not merge as a fix.
- `packages/full/skills/ensemble-check-binding-drift/SKILL.md:39` Critical — the bundle has no `lib/reqnroll-cli.js` (nor `reqnroll-gen.js`/`reqnroll-run.js`), so this line and `ensemble-generate-reqnroll-bindings/SKILL.md:42` and `ensemble-reqnroll-tdd/SKILL.md:37` resolve a `${CLAUDE_PLUGIN_ROOT}/lib/reqnroll-cli.js` path that does not exist in an installed plugin; the files live only in `packages/product/lib/`.
- `packages/full/lib/prd-cli.js:1` Critical — it symlinks the development CLI (`list|status|migrate-frontmatter`, `packages/development/lib/prd-cli.js:347-351`) while `ensemble-generate-feature-tests/SKILL.md:42` calls `generate-features`, which exists only in `packages/product/lib/prd-cli.js:185-199`; the two CLIs are disjoint, so the prescribed relink would break `list`, `status` and `migrate-frontmatter` and needs a design decision first.
- `packages/full/agents/e2e-testing/playwright-tester.yaml:57` Major — the shipped agent directs the model to `packages/e2e-testing/lib/delegation-contract.js` (lines 57, 121), `test-runner-mode.js` (70) and `grounded-marker-checker.js` (93), none of which are mirrored into `packages/full/lib/`, so the contract is unresolvable in the installed bundle.
- `scripts/validate-all.js:65` Major — `validateFullLibMirror` is one-directional (`development/lib` -> `full/lib`) and `validateFullBundleRequires` (line 551+) checks only bare `require()` in bundled code, so `npm run validate` exits 0 while skills and agents name bundle files that do not exist, and no install smoke test exists under `scripts/tests/` to catch it.
- `packages/development/lib/toolchain/config.js:154` Minor — a real `~/.config/ensemble/toolchain.yaml` (`workflow: plain-git`) makes four toolchain assertions in `scripts/tests/toolchain-config.test.js:229` and `scripts/tests/toolchain-detect.test.js` resolve `source:'user'` and fail; pre-existing, operator-environment specific, explicitly out of this task's scope.
<!-- FOREMAN_REVIEW_FINDINGS_END -->
