# Fix Report — ensemble-pdf-f7-f11-bundle-path-hygiene-r5

Task: reporter findings 7 and 11 (packages/full bundle path hygiene) plus the release-pace install smoke test.
Branch: Foreman's run branch in the run worktree. Changes are left uncommitted for Foreman.

## Root cause

`packages/full` is the installable plugin bundle: a symlink farm over the sibling
packages. `claude plugin install` copies the directory with the symlinks
dereferenced and never runs `npm install` (see the header of
`scripts/vendor-bundle-deps.js`), so the installed bundle is a flat `lib/`
directory that has to contain every file the shipped skills, agents and commands
name.

Two shipped surfaces named files the bundle did not carry:

- **F7** — `packages/full/skills/ensemble-reqnroll-tdd/SKILL.md`,
  `ensemble-generate-reqnroll-bindings/SKILL.md` and `ensemble-check-binding-drift/SKILL.md`
  resolve `REQNROLL_CLI` to `${CLAUDE_PLUGIN_ROOT}/lib/reqnroll-cli.js` first, and
  `packages/full/lib` had no `reqnroll-cli.js` at all (it lives in
  `packages/product/lib/`, together with `reqnroll-gen.js`, `reqnroll-run.js`,
  `feature-gen.js`, `drift.js` and `prd-parser.js`).
  `packages/full/skills/ensemble-generate-feature-tests/SKILL.md` and
  `ensemble-check-feature-drift/SKILL.md` resolve `PRD_CLI` to
  `${CLAUDE_PLUGIN_ROOT}/lib/prd-cli.js` first, and that mirror pointed at
  `packages/development/lib/prd-cli.js` — the registry CLI
  (`list`/`status`/`migrate-frontmatter` only). The `generate-features` and
  `check-drift` subcommands only exist in `packages/product/lib/prd-cli.js`, so
  the shipped feature skills ran a CLI that does not implement them.
- **F11** — `packages/full/agents/e2e-testing/playwright-tester.yaml` (lines 57,
  70, 93, 121) and `playwright-tester.md` describe contracts in
  `packages/e2e-testing/lib/delegation-contract.js`, `test-runner-mode.js` and
  `grounded-marker-checker.js`; none of them were in `packages/full/lib`.

Two structural facts made the obvious fix wrong, and they drove the shape of
this change:

1. **The bundle namespace is flat.** `packages/full/lib/prd-parser.js` and
   `packages/product/lib/prd-parser.js` were two different files with two
   different APIs (`extractPrdContext`/`extractReqPriorities` versus
   `parsePRD`/`deriveLabel`). In a checkout Node resolves relative requires
   against a file's realpath, so each package saw its own copy; in a
   dereferenced install only one of them can exist at `<plugin>/lib/prd-parser.js`.
   The shipped `completion-verification` skill runs
   `<dir of $TRD_CLI>/prd-parser.js` at runtime and needs
   `extractReqPriorities`, and `packages/development/lib/trd-cli.js:47` needs
   `extractPrdContext`, so the bundle's `prd-parser.js` has to be the
   development one. The product's parser had to get a different name.
2. **The two `prd-cli.js` files are not a superset of each other.** They are
   different tools with different output contracts (registry: one JSON object
   on stdout, `{"error":"<msg>"}` and exit 1 on failure; feature pipeline:
   human-readable unless `--json`). The shipped skills call the registry half
   through `lib/prd-cli.js` (the `ensemble-create-trd` reference runs
   `node "$PRD_CLI" list --type prd`) and the feature half through the same
   path, so one file has to serve both.

Nothing checked either gap: `scripts/validate-all.js` verified that every
development lib file had *an* entry in `packages/full/lib`, but not that the
entry pointed at the owning package, and nothing at all checked that a lib
file named by shipped prose was in the bundle.

## Change

| Path | Rationale |
| --- | --- |
| `packages/product/lib/prd-feature-parser.js` (renamed from `packages/product/lib/prd-parser.js`) | Frees the bundle's flat `lib/prd-parser.js` name for the development parser, which the shipped `completion-verification` skill and `development/lib/trd-cli.js` require at runtime. |
| `packages/product/lib/prd-registry.js` (new) | Carries the registry half (`runList`/`runStatus`/`runMigrateFrontmatter`) in the product package, so the product's `prd-cli.js` can serve the registry commands without importing the development package (both publish standalone). Mirrors `packages/product/lib/config-path.js`, which already mirrors `packages/core/lib/config-path.js` for the same reason. |
| `packages/product/lib/prd-cli.js` | Now the bundle's single `prd-cli.js`: dispatches `list`/`status`/`migrate-frontmatter` to `prd-registry.js` with the registry's JSON contract and keeps `parse`/`generate-features`/`check-drift`. Exports the union (`runList`, `runStatus`, `runMigrateFrontmatter` alongside the existing `parseArgs`/`deriveSlug`, which `reqnroll-cli.js` imports). |
| `packages/product/lib/{feature-gen,reqnroll-cli,reqnroll-gen,drift}.js` | Require paths and doc references follow the parser rename. |
| `packages/product/tests/{prd-feature-parser,feature-gen,reqnroll-gen,binding-drift,binding-migration}.test.js` | Follow the parser rename (`prd-parser.test.js` was renamed to `prd-feature-parser.test.js`). |
| `packages/product/tests/prd-cli-registry.test.js` (new) | Differential proof that the product CLI is a superset of the development CLI for every subcommand a shipped skill or command calls. |
| `packages/development/lib/prd-parser.js` | Comment now points at the renamed product parser. |
| `packages/e2e-testing/lib/prd-ac-parser.js` | Comment now points at the renamed product parser. |
| `packages/full/lib/prd-cli.js` | Mirror repointed from `../../development/lib/prd-cli.js` to `../../product/lib/prd-cli.js`. |
| `packages/full/lib/{prd-feature-parser,prd-registry,feature-gen,drift,reqnroll-cli,reqnroll-gen,reqnroll-run}.js` (new mirrors) | F7: the product libraries the shipped skills name are now inside the bundle. |
| `packages/full/lib/{delegation-contract,test-runner-mode,grounded-marker-checker,evidence-capture,spec-writer}.js` (new mirrors) | F11: the e2e-testing contract libraries the shipped `playwright-tester` agent names, plus `evidence-capture.js`'s own dependency `spec-writer.js`. |
| `scripts/validate-all.js` | `validateFullLibMirror` now checks the mirror *target*, not just the presence of an entry, with a documented owner exception for `prd-cli.js`; new `validateFullLibReferences` fails when a shipped skill, agent or command names a lib file the bundle does not carry. |
| `scripts/tests/validate-full-lib-references.test.js` (new) | Unit and tree-level tests for the two rules above. |
| `scripts/tests/full-bundle-install-smoke.test.js` (new) | The install smoke test: dereference-copies `packages/full`, runs the toolchain resolver, and asserts every lib file the shipped prose names exists and parses. |
| `packages/full/CHANGELOG.md` | `[Unreleased]` entry stating what `full` now includes. |
| `evals/checks/*.js`, `evals/tests/skills/*.test.js` | Require paths follow the product parser rename. |
| `packages/pi/vendor/lib/prd-parser.js` | Regenerated (`npm run generate:pi`); comment-only change. |

## Tests

### Failing first

- `npx jest scripts/tests/full-bundle-install-smoke.test.js` on the pre-fix tree:
  **2 failed, 2 passed, 4 total** — the missing bundle entries
  (`reqnroll-cli.js`, `delegation-contract.js`, `test-runner-mode.js`,
  `grounded-marker-checker.js`) and the unknown `prd-cli.js` subcommands
  (`parse`, `generate-features`, `check-drift`). Transcript:
  `~/.omp/ensemble-pdf-f7-f11/red-smoke.txt`.
- `cd packages/product && npx jest tests/prd-cli-registry.test.js` on the
  pre-fix tree: **4 failed, 1 passed, 5 total** — the product CLI had no
  registry commands (exit 1, empty stdout). Transcript:
  `~/.omp/ensemble-pdf-f7-f11/red-product.txt`.
- The new validator rule on the pre-fix bundle state (the new mirrors removed
  again): `validateFullLibReferences()` reported `✓ 27/31 lib reference(s) …`
  with 4 failures and exit 1, naming the four missing entries and the exact
  `ln -sf` fix. Transcript: `~/.omp/ensemble-pdf-f7-f11/red-validator.txt`.

### Passing after

- `npx jest scripts/tests/full-bundle-install-smoke.test.js` — 4/4 passed.
- `cd packages/product && npx jest tests/prd-cli-registry.test.js` — 5/5 passed.
- `npx jest scripts/tests/validate-full-lib-references.test.js` — 11/11 passed.

## Local verification

All commands were run from the repository root
(`/Users/ldangelo/.foreman/worktrees/ensemble/ensemble-pdf-f7-f11-bundle-path-hygiene-r5/run-e6502fb94d08a8f1c8acb40fd293449b/workspace`,
HEAD `fe5aea4f`) with Node 22 (engines in `package.json`).

| Command | Result |
| --- | --- |
| `npm run generate` | EXIT=0 (64 files + 5 run-index files regenerated) |
| `npm run generate:pi` | EXIT=0 (tsc build, `dist/index.js`, version check: **no** version bump — `scripts/bump-pi-version-if-changed.js` only diffs `packages/pi/{prompts,agents,skills,AGENTS.md}`) |
| `npm run generate:validate; echo EXIT=$?` | **EXIT=0** — "✓ Validation passed (64 files)", run-index matches a fresh build |
| `npm run validate; echo EXIT=$?` | **EXIT=0** — "✓ All plugins validated successfully", including the two new lines "✓ 103/103 packages/development/lib/*.js file(s) mirrored in packages/full/lib/" and "✓ 31/31 lib reference(s) in shipped skills, agents and commands resolve inside packages/full/lib/" |
| `npx jest scripts/tests/full-bundle-install-smoke.test.js scripts/tests/validate-full-lib-references.test.js` | 2 suites, **15 tests, all passed** |
| `cd packages/product && npx jest` | 11 suites, **233 tests, all passed** |
| `cd packages/full && npx jest` | 1 suite, **25 tests, all passed** |
| `cd packages/e2e-testing && npx jest` | 27 suites, **674 tests, all passed** |
| `cd packages/development && npx jest` | 311 suites, 13200 tests: **2 suites / 2 tests failed** — both pre-existing, see below |
| `npx jest scripts/tests` | 96 suites (94 pre-existing + the 2 new ones), 1912 tests: **4 failed, 1 skipped, 1907 passed** — the 4 failures are the pre-existing toolchain-config/toolchain-detect pair, see below |
| `npx jest evals/tests/skills/ensemble-generate-feature-tests.test.js evals/tests/skills/ensemble-generate-reqnroll-bindings.test.js` | 2 suites, 50 tests: **1 failed** — pre-existing, proven below |
| `npx jest evals` (whole eval suite) | Exceeded a 10-minute wall clock; the suite spawns real CLIs per case. Not run to completion — the two files touched by this change were run narrowly instead. |
| `node packages/full/lib/toolchain-cli.js resolve --json` (in the install copy) | exit 0, `ok:true`, every category on its shipped default with `source !== 'user'` |

### Pre-existing failures (not caused by this change)

- `scripts/tests/toolchain-config.test.js` and `scripts/tests/toolchain-detect.test.js`
  (4 tests) — the operator's `~/.config/ensemble/toolchain.yaml` (`workflow: plain-git`)
  makes the toolchain resolver report `source: 'user'`. Re-run with a scrubbed
  `HOME`/`XDG_CONFIG_HOME`: **2 suites, 60 tests, all passed**. Same 2 suites /
  4 tests failed before this change (baseline on this tree).
- `packages/development/tests/trd-cli.test.js` (1 test, "TRD-037 AC-2") — same
  cause: `out.workflow.source` is `'user'` because of the operator's toolchain
  config. Re-run with a scrubbed `HOME`/`XDG_CONFIG_HOME`: **41 tests, all passed**.
- `packages/development/tests/local-ci-adversarial.test.js` (1 test) — the
  local-CI harness clones its own copy of the repository (so it never sees this
  working tree's uncommitted changes) and its `printenv` step fails on Node 26
  in this environment; unrelated to the bundle work.
- `evals/tests/skills/ensemble-generate-feature-tests.test.js` (1 test, "manifest
  entries wrong document id, requirement, file, hash format extra AC fail
  manifest") — exceeds jest's 5000 ms timeout because the test runs five
  CLI-spawning eval cases in one test. Proven pre-existing: with this change
  stashed (`git stash push -u`, base content) the same test fails identically;
  the stash was restored and the tracked diff was verified byte-identical to the
  pre-stash patch.

## Follow-ups

- Finding 2 (the `glob` dependency of `detect-stack`) is owned by another task.
  The smoke test's bare-require assertion carries a named allowlist entry for
  it (`ALLOWED_UNRESOLVED_BARE_REQUIRES` in
  `scripts/tests/full-bundle-install-smoke.test.js`, citing finding 2) and no
  fix was made here. The installed bundle still cannot `require('glob')`.
- The two `prd-cli.js` implementations are now duplicated between the
  development and product packages (the registry half lives in
  `packages/development/lib/prd-cli.js` and in
  `packages/product/lib/prd-registry.js`). That is the repo-idiomatic pattern
  for packages that publish standalone, but it means the registry behaviour has
  to be kept in sync by hand. A shared package would remove the duplication; it
  would also change the published package layout, which is out of scope here.
- The full `npx jest evals` suite did not complete inside a 10-minute window on
  this machine. It is worth running once in CI to confirm the eval suite is
  unaffected beyond the two files this change touched.
- `packages/full/tests/trd-cli-bundled.test.js` still asserts the byte identity
  of a fixed list of development lib files; the new product mirrors are not
  covered by a byte-identity guard.

## Assumptions

- The bundle's `lib/prd-parser.js` stays the development parser: the shipped
  `completion-verification` skill and `development/lib/trd-cli.js` need it at
  runtime, while no shipped skill names the product's parser. The product's
  parser was renamed instead (`prd-parser.js` → `prd-feature-parser.js`).
- The product's `prd-cli.js` is the bundle's `prd-cli.js`, because the shipped
  skills resolve `PRD_CLI` to the plugin-root path first and call both the
  registry and the feature-pipeline subcommands through it.
- The registry implementation is mirrored into the product package rather than
  imported across packages: both packages publish standalone, and the repo
  already does this for `config-path.js`.
- The registry half keeps the development CLI's contract exactly (single JSON
  object on stdout, `{"error": "<msg>"}` and exit 1 on failure) so that the
  shipped skills and commands that call `list`/`status`/`migrate-frontmatter`
  behave the same in the installed plugin as in the checkout. The product's
  own `parse`/`generate-features`/`check-drift` output contract is unchanged.
- The validator's mirror rule keeps `development` as the default owner and
  documents `prd-cli.js` as the single exception; any future bundle file owned
  by another package needs an entry in `FULL_LIB_MIRROR_OWNERS`.

## PR body

## Summary

The `packages/full` plugin bundle shipped files that the installed plugin does
not contain: the shipped skills name `${CLAUDE_PLUGIN_ROOT}/lib/reqnroll-cli.js`
and the `generate-features`/`check-drift` subcommands of
`${CLAUDE_PLUGIN_ROOT}/lib/prd-cli.js`, and the shipped `playwright-tester`
agent names the e2e-testing contract libraries. `claude plugin install`
dereferences the bundle's symlinks and never runs `npm install`, so every one
of those names was a runtime failure in the installed plugin.

This change makes the bundle carry what its shipped prose names:

- the product CLI libraries (`reqnroll-cli.js`, `reqnroll-gen.js`,
  `reqnroll-run.js`, `feature-gen.js`, `drift.js`, `prd-registry.js`,
  `prd-feature-parser.js`) are mirrored into `packages/full/lib/`;
- `packages/full/lib/prd-cli.js` now points at the product's CLI, which serves
  the registry commands (`list`, `status`, `migrate-frontmatter`) as well as the
  feature-pipeline commands (`parse`, `generate-features`, `check-drift`), so
  one entry point works for every shipped skill;
- the e2e-testing contract libraries (`delegation-contract.js`,
  `test-runner-mode.js`, `grounded-marker-checker.js` and their dependency
  `evidence-capture.js` with `spec-writer.js`) are mirrored into the bundle;
- the product's PRD parser was renamed `prd-parser.js` → `prd-feature-parser.js`
  because the bundle's `lib/` is a flat namespace and the development parser
  has to stay reachable under its own name for the shipped
  `completion-verification` skill;
- `scripts/validate-all.js` now checks that a bundle mirror points at its
  owning package and that every lib file named by a shipped skill, agent or
  command is present in the bundle, and
  `scripts/tests/full-bundle-install-smoke.test.js` dereference-copies the
  bundle exactly like the installer does and asserts the shipped toolchain
  defaults resolve and every named lib file exists and parses.

## Testing

- New: `scripts/tests/full-bundle-install-smoke.test.js` (4 tests) — red on the
  old tree (missing `reqnroll-cli.js`, missing e2e contract files, unknown
  `prd-cli.js` subcommands), green after the fix.
- New: `scripts/tests/validate-full-lib-references.test.js` (11 tests) — unit
  and tree-level tests for the two new validator rules.
- New: `packages/product/tests/prd-cli-registry.test.js` (5 tests) — the product
  CLI is compared against the development CLI on identical fixtures for
  `list`, `status`, the error path and `migrate-frontmatter`.
- `npm run generate:validate` → exit 0; `npm run validate` → exit 0.
- `npx jest scripts/tests` → 1912 tests, 1907 passed, 4 failed
  (`toolchain-config`/`toolchain-detect`, pre-existing: the operator's
  `~/.config/ensemble/toolchain.yaml`; both suites pass 60/60 with a scrubbed
  `HOME`).
- `cd packages/product && npx jest` → 233 passed; `cd packages/full && npx jest`
  → 25 passed; `cd packages/e2e-testing && npx jest` → 674 passed;
  `cd packages/development && npx jest` → 2 pre-existing failures
  (`trd-cli` with a scrubbed `HOME` → 41/41 passed; `local-ci-adversarial`
  clones its own copy of the repo).

## Risk

- The bundle's `lib/prd-cli.js` changes owner, so anything that assumed the
  registry-only behaviour of that path now gets the superset CLI. The registry
  half keeps the registry's JSON contract, and the product commands keep their
  own, and the differential test pins the registry half to the development
  CLI's output.
- The product package now carries a copy of the registry implementation
  (`packages/product/lib/prd-registry.js`); the two copies have to be kept in
  sync by hand.
- The validator's new mirror-target rule is stricter than before: any bundle
  entry that points at the wrong package now fails `npm run validate`. It
  passes on the current tree (103/103).
- The smoke test copies the bundle into a temp directory under the worktree
  (not `/tmp`) and removes it afterwards.

## How to revert

Revert this commit. It only adds bundle mirrors, a new product file, a
validator rule and tests; no published interface is removed. If the product
parser rename has to be undone, restore
`packages/product/lib/prd-parser.js` and its test, and repoint the three
product lib files and the two eval files at it.

## Directed by

Directed by: @ldangelo
