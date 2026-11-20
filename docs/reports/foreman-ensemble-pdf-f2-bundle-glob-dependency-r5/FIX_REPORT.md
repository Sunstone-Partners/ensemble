# FIX_REPORT — ensemble-pdf-f2-bundle-glob-dependency-r5

Phase: `fix` (run `run-a41d4988732cf591689c4dd9ab26a742`), branch worktree
`ensemble-pdf-f2-bundle-glob-dependency-r5`, base `dev` at `fe5aea4f`.

## Root cause

`packages/core/skills/detect-stack/detect-stack.js` loaded the npm `glob`
package (`require('glob').glob`, old line 44) to answer every wildcard lookup
the framework, test, tooling and cloud axes need (`.csproj` and package
references, test-file patterns, `*.tf`, `Dockerfile*`, `helm/Chart.yaml`,
`*.razor`, …).

The full bundle is delivered by `claude plugin install`, which copies
`packages/full` with symlinks dereferenced and never runs `npm install`. Only
what `scripts/vendor-bundle-deps.js` vendors under
`packages/full/lib/node_modules` exists there (`ajv`, `js-yaml` and their
closure). `glob` was never vendored — the vendor script's own header said so —
so inside the installed plugin `require('glob')` throws `MODULE_NOT_FOUND`, the
skill answered with `degraded: 'glob-unavailable'`, and every wildcard signal
was silently empty.

The check that should have caught this did not:

- `scripts/validate-all.js` `validateBundleBareRequires()` only made
  unresolvable bare requires **blocking** for files under `packages/full/lib`
  and `packages/full/hooks`. A file under `packages/full/skills/` landed in a
  non-blocking advisory list, so the dead `require('glob')` never failed
  `npm run validate`.
- The scanner read **template literals** as code, so it could not tell
  `packages/jest/skills/jest/generate-test.js`'s *emitted*
  `from '@testing-library/react'` from a real dependency. That confusion is why
  skill files were excluded from the blocking set in the first place.

Two smaller honesty gaps in `packages/full/package.json`: `js-yaml` was the only
declared dependency although the vendored runtime also loads `ajv`, and the
20 `peerDependencies` name sibling packages that are not published (the reporter
said 21; the file holds 20).

## Change

| Path | Why |
| --- | --- |
| `packages/core/skills/detect-stack/glob.js` (new) | Dependency-free matcher for exactly the subset of `glob(10)` semantics `detect-stack` uses: brace alternatives, `**` (zero or more directories), `*`/`?` within a segment, the dot rule, `ignore` patterns, `nodir`, `absolute`, `maxDepth`. Symbolic links are never followed, matching `glob(10)`'s default. Directory reads run concurrently through one scheduler shared by the whole process, and the listing of each directory is cached for the call, so a brace pattern reads every directory once. |
| `packages/core/skills/detect-stack/detect-stack.js` | Loads `./glob` instead of the npm package. The `warnMissingGlob` helper, the literal-path fallback and the `glob_unavailable` / `degraded: 'glob-unavailable'` plumbing are gone: nothing is missing any more. |
| `packages/core/skills/detect-stack/__tests__/glob.test.js` (new) | Unit tests for `expandBraces`, `segmentMatcher`, `matchesSegments` and the `glob()` options. The file ships with the skill, so it must not require the npm package. |
| `packages/core/tests/detect-stack-glob-equivalence.test.js` (new) | Equivalence proof against npm `glob` 10.5.0 over every pattern `detect-stack` passes. It lives in `packages/core/tests` because the bundle ships `packages/core/skills/`, and a shipped test that requires `glob` would put an unresolvable require back into the bundle. |
| `packages/core/skills/detect-stack/__tests__/glob-optional.test.js` | Retargeted: with the `glob` package made unresolvable through a `Module._load` hook, the scan must still answer with the same evidence and no `degraded` flag. |
| `packages/core/skills/detect-stack/__tests__/framework.test.js` | The `glob` mock now targets `../glob`, the module the skill loads; the old `jest.mock('glob', …)` became inert. |
| `packages/core/skills/detect-stack/SKILL.md`, `REFERENCE.md` | The dependency note and the file tree now name `glob.js` and state that the skill has no npm dependency. `SKILL.md` stays at its 3733-word baseline. |
| `packages/core/package.json` | Declares the `glob` dev dependency the equivalence test compares against, so the test does not lean on the root's hoisted copy. |
| `packages/full/package.json` | `dependencies` now lists `ajv` and `js-yaml`, the two packages the vendored runtime really loads. The 20 `peerDependencies` stay: every range is satisfied by the workspace version, `CHANGELOG.md:416` records that the peers were moved there deliberately, `docs/VERSIONING_STRATEGY.md` §3.1/§3.2 makes them the cross-plugin compatibility convention, and no script in the repository reads them. |
| `package-lock.json` | Two lines: `ajv` under `packages/full`'s dependencies and `glob` under `packages/core`'s dev dependencies, so `npm ci` stays consistent with the manifests. |
| `scripts/vendor-bundle-deps.js` | The header comment no longer claims the bundle cannot resolve `glob`. The vendored list is unchanged: `glob` is no longer required by anything in the bundle. |
| `scripts/validate-all.js` | `bareSpecifiers()` reads code instead of strings, so an emitted import is not a dependency while a `require` hidden behind a regex literal or a `require.resolve` still is. `validateBundleBareRequires()` takes a fixture bundle directory and makes **every** bundle file blocking; the false-positive sources that forced the old carve-out are gone. A blocking gate needs a way out, so a line marked `// validate-bundle-ignore` is excused. Failures name `file:line` and the specifier, and Node's own `module.isBuiltin` decides what is a builtin, so builtin subpaths such as `fs/promises` and `node:path/posix` count as builtins. |
| `scripts/tests/validate-bundle-bare-requires.test.js` | 44 tests: the scanner's behaviour (emitted code, regex literals, divisions, `require.resolve`, the ignore marker, the line numbers) and the fixture-bundle cases (a missing package fails, an emitted specifier is not a dependency, a package installed in the repository does not count as vendored, an excused line passes, a builtin subpath passes, the failure names the file and the line). |
| `packages/pi/skills/detect-stack/{detect-stack.js,glob.js,SKILL.md,REFERENCE.md}` | Generated mirrors of the changed skill files (`npm run generate`, `npm run generate:pi`). |

## Tests

Failing first, with the final test files:

| Check | Old code | Fixed code |
| --- | --- | --- |
| `cd packages/core && npx jest skills/detect-stack/__tests__/glob-optional.test.js` | **9 failed, 1 passed** (10 total) | 10 passed |
| `npx jest scripts/tests/validate-bundle-bare-requires.test.js` | **7 failed, 37 passed** (44 total) | 44 passed |

The red runs were produced by restoring the pre-fix files from `HEAD`
(`git checkout HEAD -- packages/core/skills/detect-stack/detect-stack.js
scripts/validate-all.js`) and running the new tests against them. The seven
validator failures on the old code are `a line marked validate-bundle-ignore is
excused`, `a finding carries the line the specifier sits on`, `a specifier a
generator emits is not a dependency of the file`, `require.resolve names the
package it resolves`, `a skill that requires a package the bundle cannot resolve
fails the check`, `a package installed in the repository does not count as
vendored`, and `the failure names the file and the line, so a false positive is
one look away`.

Added or updated tests:

- `packages/core/tests/detect-stack-glob-equivalence.test.js` — 24 tests: every
  pattern `detect-stack` passes (21 cases over a fixture tree with nesting, dot
  directories, ignored directories, a symlinked file, a symlinked directory and
  a symlink loop) compared against `require('glob').glob`, plus the absolute
  path case, the `nodir` case and the sorted-order contract. All 24 match the
  npm package exactly.
- `packages/core/skills/detect-stack/__tests__/glob.test.js` — 12 unit tests
  for `expandBraces`, `segmentMatcher`, `matchesSegments` and the `glob()`
  options. The file ships with the skill, so it requires no npm package.
- `packages/core/skills/detect-stack/__tests__/glob-optional.test.js` — 10
  tests: with the `glob` package unresolvable every axis still answers with
  its file evidence, a scan with the package present answers identically, the
  cached tooling replay is identical, and no warning is written.
- `packages/core/skills/detect-stack/__tests__/framework.test.js` — the mock
  now drives `../glob`.
- `scripts/tests/validate-bundle-bare-requires.test.js` — 44 tests (5 scanner
  cases and 3 fixture-bundle cases added earlier, plus the ignore marker, the
  line numbers, the builtin subpath and the file:line diagnostics).

## Local verification

Every command below was run from the repository root unless stated otherwise.

| Command | Result |
| --- | --- |
| `npm run generate` | exit 0, "✓ Generated 64 file(s)" |
| `npm run generate:pi` | exit 0; `packages/pi/skills/detect-stack/glob.js` created, the other mirrors refreshed; no Pi version bump (the merge base against `origin/main` already carries a human bump, so `scripts/bump-pi-version-if-changed.js` leaves the version alone) |
| `npm run generate:validate` | exit 0 |
| `npm run validate` | exit 0, "✓ 298 skill(s) conform to the Agent Skills spec"; only the pre-existing prompt-budget advisories remain (assess-config, completion-verification, ensemble-beads-build, ensemble-fix-issue, ensemble-implement-bead, ensemble-new-feature, pr-review-cycle) |
| `npx jest scripts/tests/validate-bundle-bare-requires.test.js` | 44 passed |
| `cd packages/core && npx jest skills/detect-stack tests/detect-stack-glob-equivalence.test.js` | 7 suites, 226 tests passed |
| `cd packages/core && npx jest` | 18 suites, 468 tests passed |
| `npx jest scripts/tests` | 92 suites passed, 2 failed (`toolchain-config.test.js`, `toolchain-detect.test.js`): 4 failed, 1 skipped, 1912 passed, 1917 total. Both failures are pre-existing: they reproduce on a stashed, pristine tree, because the operator's `~/.ensemble/toolchain.yaml` makes the tests resolve source `user`. Re-run after the last edit to the change, on the final tree |
| `cd packages/pi && npx jest` | 20 suites passed, 1 failed (`tests/lib-bundler.test.ts:723`, 1 failed / 488 passed / 489 total). Pre-existing: it fails the same way on a stashed, pristine tree and touches the toolchain bundler, not `detect-stack`. Re-run after the last edit to the change, on the final tree |
| `npx eslint` on the 11 staged JS files (`git diff --cached --name-only -- '*.js' \| xargs npx eslint`) | exit 0: 0 errors, 3 warnings — two are "file ignored" for the generated `packages/pi/skills/…` mirrors, which `eslint.config.mjs` excludes, and one is `'error' is defined but never used` in `scripts/validate-all.js:1483`, which exists at `HEAD` as well |
| `npx markdownlint` on the 5 staged MD files (`git diff --cached --name-only -- '*.md' \| xargs npx markdownlint`) | exit 0 (the two skill `SKILL.md` files, the two `REFERENCE.md` files and this report) |
| `npm ci --dry-run --legacy-peer-deps` | exit 0 |
| `git diff HEAD --stat package-lock.json` | 2 insertions, 0 deletions (`ajv` for `packages/full`, `glob` for `packages/core`) |
| `grep -rnE` for `require('glob')`, `from 'glob'` and `import('glob')` under `packages/full --include='*.js'` | no match |
| the same grep on a `cp -RL packages/full …` dereferenced copy | no match |
| end-to-end probe: `cp -RL packages/full` → require the dereferenced `skills/core/detect-stack/detect-stack.js` with `glob`, `minimatch` and `fast-glob` forced to `MODULE_NOT_FOUND` → detect all four axes on a React/Jest/Docker/Helm/Terraform fixture | `test` → `jest` with the `testFiles` signal true, `tooling` → the `dockerfile_flyio` signal true, `cloud` → the `terraform` signal true, **no** `degraded` field on any axis |
| old-vs-new envelope comparison on the same fixture (pre-fix skill with the npm package against the new skill) | all four axes identical (the only difference is the removed `degraded` field) |
| `npm pack --dry-run packages/full` and `npm pack --dry-run packages/pi` | the npm-published `packages/full` ships 9 files and no skills (its `skills/` and `lib/` are symlinks); `packages/pi` ships 524 files including `skills/detect-stack/glob.js` and no `__tests__` |
| benchmark of the matcher against `glob(10)` on the repository (`~/.omp/ensemble-pdf-f2-r5/bench.js`) | `glob` 23–38 ms per pattern, local matcher 24–30 ms per pattern, identical result sets |
| axis timings on the repository (old skill / new skill) | framework 252 ms / 433 ms, test 358 ms / 375 ms, tooling 105 ms / 171 ms, cloud 200 ms / 194 ms |
| `ls -ld packages/full/lib` and `ls -l packages/full/lib` | a real directory of per-file symlinks to `../../development/lib` and `../../permitter/lib`; `packages/full/lib/detect-framework.js` is absent, so `packages/core/lib/detect-framework.js` is not part of the bundle |
| `grep -rn "validate-bundle-ignore"` over the repository (excluding `node_modules` and `docs/reports`) | only `scripts/validate-all.js` (the marker constant and its documentation) and `scripts/tests/validate-bundle-bare-requires.test.js` (the fixtures). The escape hatch is used nowhere in the shipped code, so nothing suppresses the new gate |

The matcher was 6–18× slower than the npm package in its first version (a
sequential walk that re-read every directory for every brace alternative): the
framework axis took 4.9 s on this repository. The walk now reads directories
concurrently (32 at a time, through one scheduler shared by the process), caches
each directory listing for the call and counts depth instead of re-splitting
paths, which is why the numbers now match the npm package's.

The axis itself is still slower than before the change: the framework axis took
252 ms with the npm package and 433 ms now (+70%), the tooling axis 105 ms
against 171 ms. The cause is the cache lifetime: `glob(10)` keeps its path
cache warm across every call in the process, while the local matcher caches a
directory listing only for the duration of one `glob()` call, so the axes walk
the same directories again. The per-pattern cost is at parity (24–30 ms
against 23–38 ms), so the difference is repeated traversal, not a slower
matcher.

## Follow-ups

- `packages/core/lib/detect-framework.js:21` still does a module-scope
  `const { glob } = require('glob');`. The module is reached through
  `packages/core/lib/index.js:11`, and the `ensemble-core` plugin ships the
  whole `packages/core` directory (`.claude-plugin/marketplace.json` points at
  `./packages/core`), so the core plugin has the same defect. It is not part of
  the full bundle (`packages/full/lib` mirrors `packages/development/lib` and
  `packages/permitter/lib` only, and the dereferenced bundle contains no
  `detect-framework.js`), so it is outside this task's scope and is left
  untouched.
- Another task adds a dereferenced-bundle install smoke test under
  `scripts/tests/`; that file is not created here.
- `detect-stack` picks its primary framework from the first matching file it
  finds. With sorted results the choice is reproducible, but it is still
  "whichever file came first" rather than "the framework the project uses
  most". Choosing by rank or by evidence count would be better.
- The bundle ships `.ts` files (Playwright templates and examples) that a
  skill emits into the operator's project. They are not plugin runtime code, so
  `BUNDLE_CODE_EXTENSIONS` covers `.js`, `.cjs` and `.mjs` only. If a bundle
  ever ships runtime TypeScript, that set has to grow with it.
- `packages/full` keeps 20 `peerDependencies` on packages that are not
  published on npm. The ranges are consistent with the workspace and the
  versioning strategy documents them as the cross-plugin convention, so they
  stay; publishing the plugins and dropping the peer block is a separate
  decision.

## Assumptions

- **Result order.** The matcher returns its matches sorted; `glob(10)` returns
  them in directory-walk order. The sets are identical for every pattern
  `detect-stack` uses, but the skill samples the first ten matches and the
  first `.csproj` it finds, so on a tree with many matches (this repository, for
  example) the sampled file differs from the npm package's. Sorting was chosen
  because walk order depends on the file system and would make the sample
  unreproducible. The equivalence test pins the sorted contract.
- **Peer dependencies.** The reporter described 21 `peerDependencies`;
  `packages/full/package.json` holds 20. All 20 ranges are satisfied by the
  workspace versions in this repository, so they were kept and the reasoning is
  recorded above.
- **Scope of `glob` uses.** The reporter called the `require` in
  `detect-stack.js` the only one; `packages/core/lib/detect-framework.js:21` is
  the second, outside the bundle and outside this task's scope (see Follow-ups).
- **Node support.** The matcher uses only `fs.promises.readdir`, `path.resolve`
  and `RegExp`, so it runs on the Node versions the root `package.json` asks
  for (`^22.22.2 || ^24.15.0 || >=26.0.0`); `fs.glob` is experimental on Node
  22 and is not used. The code was exercised on macOS (Node 26.13.1). The
  platform-independent parts cover Windows and Linux (the matcher always
  returns `/`-separated paths like `glob(10)`, and the case-insensitive flag
  follows the platform), but no Windows run was made here.
- **The escape hatch.** A gate that blocks the build needs a way out. The
  marker `// validate-bundle-ignore` on a line excuses the bare specifiers on
  that line, which keeps a deliberate exception next to the code it excuses.
- **CI.** `.github/workflows/test.yml` runs `npm ci --legacy-peer-deps` at the
  repository root on Node 22 and 24, so the `glob` dev dependency the
  equivalence test compares against is installed in CI.

## PR body

### Summary

- `packages/full` could not resolve `glob` at run time, so every wildcard
  lookup the `detect-stack` skill needs answered "no match" and the skill
  flagged itself `degraded: 'glob-unavailable'`.
- `packages/core/skills/detect-stack/glob.js` implements the subset of
  `glob(10)` semantics `detect-stack` uses, with no npm dependency, and
  `detect-stack.js` loads it instead of the package. The degraded flag and the
  warning are gone: the axis now answers with evidence inside the installed
  plugin.
- `scripts/validate-all.js` now reads code instead of strings, so template
  literals it looks at for bare requires no longer look like dependencies; an
  unresolvable bare require is **blocking** for any file in the bundle, not
  only `lib/` and `hooks/`. The check also accepts a fixture bundle directory,
  so the negative case is covered by a test, and a line marked
  `// validate-bundle-ignore` is the explicit way out.
- `packages/full/package.json` declares `ajv` and `js-yaml`, the two packages
  the vendored runtime really loads; the 20 sibling `peerDependencies` stay
  because their ranges are satisfied by the workspace versions and the
  versioning strategy makes them the cross-plugin convention.

### Testing

- Failing first: the new `glob-optional.test.js` fails 9 of 10 tests against
  the pre-fix `detect-stack.js`, and the new validator tests fail 7 of 44
  against the pre-fix `scripts/validate-all.js`. Both pass after the change.
- `packages/core/tests/detect-stack-glob-equivalence.test.js` (24 tests)
  compares the new matcher against the npm `glob` package over every pattern
  `detect-stack` passes; the results are identical.
- `cd packages/core && npx jest` → 18 suites, 468 tests passed.
- `npx jest scripts/tests/validate-bundle-bare-requires.test.js` → 44 passed.
- `npm run generate:validate` and `npm run validate` → exit 0.
- `npx jest scripts/tests` → the only failures are the pre-existing
  `toolchain-config` and `toolchain-detect` suites, which fail the same way on
  a pristine tree; `cd packages/pi && npx jest` → the pre-existing
  `tests/lib-bundler.test.ts` failure.
- End to end: a dereferenced copy of `packages/full` with `glob`, `minimatch`
  and `fast-glob` made unresolvable answers every axis with its evidence and
  without a `degraded` field.

### Risk

- The validator now fails the build for an unresolvable bare require anywhere
  in the bundle. That is the point of the change, but it means a future skill
  that adds a dependency the bundle cannot resolve fails `npm run validate`
  instead of degrading at run time.
- The matcher returns its matches sorted, where `glob(10)` returns them in
  directory-walk order. The sets are identical; the sample the skill takes of
  them can differ on a tree with many matches (for example this repository,
  where the framework axis primary moved from `phoenix` to `blazor`). The
  choice is now reproducible instead of file-system dependent.
- Adding `ajv` to `packages/full`'s `dependencies` changes the published
  manifest of the meta-package.
- The scan of a project tree got slower: the framework axis took 252 ms before
  the change and 433 ms now (+70%), the tooling axis 105 ms against 171 ms.
  The cause is the cache lifetime — `glob(10)` keeps its path cache warm
  across every call in the process, the local matcher caches a directory
  listing only within one call, so the axes traverse the same directories
  again. The cost of a single pattern is at parity (24–30 ms against
  23–38 ms).
- `packages/core/lib/detect-framework.js` still requires `glob`. It is not part
  of the full bundle, but the `ensemble-core` plugin ships the same defect. It
  was left untouched and reported as a follow-up.

### How to revert

Revert the commit. The change is self-contained: `detect-stack.js` goes back
to requiring the `glob` package, the validator goes back to reporting
skill-level bare requires as a non-blocking advisory, and
`packages/full/package.json` goes back to declaring only `js-yaml`. The new
files (`packages/core/skills/detect-stack/glob.js`,
`packages/core/skills/detect-stack/__tests__/glob.test.js`,
`packages/core/tests/detect-stack-glob-equivalence.test.js`) go with it.

### Directed by

Directed by: @ldangelo
