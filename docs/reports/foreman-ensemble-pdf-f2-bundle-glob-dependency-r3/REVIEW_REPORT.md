# Repository-rules review — ensemble-pdf-f2-bundle-glob-dependency-r3

Run: `run-1d4e150682408d7c615738bdd8c2c867` · phase 3 `repo-rules-review` · base branch: `dev`

> **Branch status: not mergeable as it stands.** This branch carries **no
> implementation code** — the diff against `dev` is two report markdown files and
> nothing else (see `## Review engine`). The defect this bead names is still
> present on `dev` and untouched here. Phase 1 must be re-run (or the bead
> re-dispatched) before the run can produce a mergeable PR; this review phase
> does not implement the fix. Findings 1–6 below are the carried-forward,
> still-open items.
>
> **Fixed in this phase (uncommitted, for Foreman to commit):** the mangled
> phase-2 review artifact was restored from the phase-2 scratch mirror, and the
> empty `FIX_REPORT.md` now carries a one-line honest marker instead of two blank
> lines. Both are report-file fixes only — no source code changed.

## Review engine

Reviewer: the repository-rules pass defined by this phase — one manual review of
`git diff "$FOREMAN_BASE_BRANCH"...HEAD` against this repository's own written
conventions, with no external CLI. `$FOREMAN_BASE_BRANCH` was set to `dev`, so the
mandated diff base was used (no fallback substituted).

Diff range reviewed: `dev...HEAD` (three-dot, merge-base), i.e. commits `4a4de1bc`
(phase 1 `fix`), `cd008e85` and `116a30e8` (phase 2 `coderabbit-review`), plus
this phase's own uncommitted fixes, re-read as `git diff dev` after they were
applied.

Rules applied, in priority order:

1. `AGENTS.md` at the repository root (worktrees/scratch must never live under
   `/tmp`; Generated Artifact Policy — edit sources, never a file marked
   `DO NOT EDIT - Generated from ...`; surgical changes traceable to the task).
2. This run's own phase contracts (the `fix` phase's `FIX_REPORT.md` section
   contract, and the review phases' findings-marker block, which is the
   mechanism the next phase and the PR depend on).
3. Existing conventions in the files the diff touches.

**Headline finding, stated up front so it cannot be missed:** this branch contains
no implementation code. `git diff --stat dev...HEAD` at phase entry was
`2 files changed, 17 insertions(+)`, both of them report markdown under
`docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/`, and
`FIX_REPORT.md` was 2 bytes. The defect the bead describes is still present
unaltered on this branch. A rules review has very little code to review here, so
the substantive findings below are carried forward rather than fixed.

## Findings

From the previous phase (`REVIEW_CODERABBIT_REPORT.md`, 6 bullets). All six are
still live against the code as it currently stands and are carried forward verbatim
into the findings block; one of them (the empty `FIX_REPORT.md`) is additionally
actioned in part — the file now carries an honest one-line marker instead of two
blank lines — while the defect it stands in for (an unimplemented bead) stays
open. One further finding was raised in this phase (the empty file also broke the
repository's own markdown linter) and is fixed.

| # | Finding | Disposition |
| - | ------- | ----------- |
| 1 | `docs/reports/.../FIX_REPORT.md:1` Critical — phase 1 shipped a 2-byte empty report with zero source changes | Partially fixed (the empty file now carries a one-line "NO IMPLEMENTATION" marker, which also clears the two `MD012` lint errors it added); the substantive defect — the bead is unimplemented — is **carried forward** |
| 2 | `packages/core/skills/detect-stack/detect-stack.js:44` Critical — still `require('glob').glob` | Declined (implementation scope) |
| 3 | `packages/core/lib/detect-framework.js:21` Major — module-level `require('glob')`, not named by the bead | Declined (implementation scope) |
| 4 | `packages/full/package.json:1` Major — `dependencies` only `js-yaml`; 20 unpublished sibling `peerDependencies`; no lockfile | Declined (implementation scope) |
| 5 | `scripts/validate-all.js:551` Major — `validateFullBundleRequires` cannot flag an unresolvable bare require | Declined (implementation scope) |
| 6 | `packages/core/skills/detect-stack/__tests__/glob-optional.test.js:1` Minor — asserts the degraded `glob-unavailable` end state the bead removes | Declined (must be retargeted by the implementation) |
| 7 | `docs/reports/.../REVIEW_CODERABBIT_REPORT.md:1` Major — committed phase-2 artifact was a mangled stub: required H2 sections gone, findings-marker block absent | **Fixed** |
| 8 | `docs/reports/.../FIX_REPORT.md:2` Minor — the 2-byte empty file also tripped the repository's own markdown linter (`MD012/no-multiple-blanks` at lines 2 and 3) on a file this branch adds | **Fixed** |

Findings 1–6 were re-verified against the code as it currently stands before being
triaged, so none of them is stale: `grep -n "require('glob')"` still matches
`packages/core/skills/detect-stack/detect-stack.js:44` and its generated mirror
`packages/pi/skills/detect-stack/detect-stack.js:44`,
`packages/core/lib/detect-framework.js:21` still has the module-level require, and
`packages/full/package.json` still declares `"dependencies": { "js-yaml": "^4.1.0" }`
with 20 `@sunstone-partners/ensemble-*` peer dependencies (verified with
`npm view`: all 20 return `npm error code E404 ... Not Found` on
`https://registry.npmjs.org`). The bead's "21" and this phase's predecessor
report both mis-stated the count; the verified list is: ai, core, product,
development, quality, infrastructure, git, e2e-testing, react, nestjs, rails,
phoenix, blazor, dotnet, jest, pytest, rspec, permitter, xunit, exunit.

**Two carry-forward mechanics, stated so nothing is read twice or trusted twice.**
(1) *Authoritative findings block.* The restored phase-2 file
`REVIEW_CODERABBIT_REPORT.md` carries its own marker block with the same six
bullets, so two files in this directory now contain a findings block. **This
report's block is the authoritative one** — it is the one the next phase reads,
it carries the same six findings plus the two this phase raised, and it is the
one attached to the pull request. The phase-2 block is a faithful copy of the
same content, not a second, different set.
(2) *One superseded number.* The restored phase-2 file states the sibling
`peerDependencies` count as "17 (not 21)". That number is wrong and is
**superseded by this report**: the verified count is **20** (every one confirmed
unpublished with `npm view` → `E404`, listed above). The restored file was
deliberately not edited, because it is a faithful copy of phase 2's output and
rewriting another phase's record would be as wrong as fabricating one; this
report carries the correction instead.

## Fixed

- `docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/FIX_REPORT.md` —
  **what was wrong:** the file committed by phase 1 is 2 bytes: two blank lines
  (`wc -c` = 2, `cat -A` shows only `$` `$`). Besides being empty where the `fix`
  phase contract asks for Root cause / Change / Tests / Local verification /
  Follow-ups / Assumptions / `## PR body`, it also broke the repository's own
  markdown linter: `npx markdownlint .` reported
  `FIX_REPORT.md:2 error MD012/no-multiple-blanks Multiple consecutive blank lines
  [Expected: 1; Actual: 2]` and the same error at line 3 — the only two lint
  errors anywhere in the repository that this branch introduces (the repo-wide run
  has 1206 pre-existing errors, all in files this branch does not touch; spot-checked
  `docs/comparison-bmad.md`, `docs/COMPONENT_INVENTORY.md`,
  `docs/plans/ensemble-surface-consolidation-plan.md` and
  `docs/PRD/completed/agent-progress-pane-rename.md` all exist on `dev` unmodified).
  CI job `.github/workflows/reviewdog.yml` (`runner / markdownlint`,
  `reviewdog/action-markdownlint@v0`, `filter_mode: added`, `fail_level: none`)
  lints added lines, so those two errors are reported on this pull request.
  **What changed:** the two blank lines were replaced by a single honest line
  (312 bytes) —

  ```
  NO IMPLEMENTATION - phase 1 shipped no implementation for bead ensemble-pdf-f2-bundle-glob-dependency-r3; the defect is still open. See docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/REVIEW_REPORT.md (the finding that reads "phase 1 shipped no implementation") and its unresolved-findings block.
  ```

  The line points at the bead id and at the finding's *text* rather than at a
  position ("finding 1"), so it cannot point at the wrong thing if this file or
  the review report is later reordered. It deliberately contains **no** contract
  sections — no `## PR body`, no Root cause / Change / Tests headings — so a
  downstream check that only verifies those headings cannot mistake it for a
  completed fix record; the file stays an honest "no work happened" signal
  rather than a fabricated change record, and it no longer adds lint errors to
  the branch. The substantive defect it stands in for (the bead is unimplemented)
  is carried forward as a Critical unresolved finding below.
- `docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/REVIEW_CODERABBIT_REPORT.md`
  — **what was wrong:** the version committed by `116a30e8` is 2113 bytes of
  prose summary: every level-2 heading (`##`) was flattened away, the required
  sections were absent, table rows were collapsed into run-on sentences, and —
  the part that actually breaks tooling — the findings-marker count on the
  committed file was **0**, so the carry-forward contract this phase depends on
  had no markers to read. That is a repository-convention violation in the diff
  itself: the repo's own review-phase contract requires the five named sections and
  the findings block. **What changed:** restored the full phase-2 report from the
  phase-2 scratch mirror at `~/.omp/ensemble-pdf-f2-r3/REVIEW_CODERABBIT_REPORT.md`
  (9713 bytes, md5 `597d3e21dc4e71c58071078638bd3ca7`; not from `/tmp`, per
  `AGENTS.md`). The restored file is byte-identical to that mirror — engine
  command and JSONL terminal record, round-1-only stop rationale, `## Review engine`,
  `## Rounds`, `## Fixed`, `## Declined`, `## Verification` table, escalation note,
  handoff sequence — with the six unresolved findings inside
  the findings-marker block, and the marker count on the restored file returning 2.
  (Caveat stated plainly: the mirror is treated as authoritative because phase 2
  wrote that file to it; the md5 match proves the copy is faithful to the mirror,
  not independently that the mirror equals phase 2's intended output.)
  No implementation code was written in this phase. No file under `packages/`, no
  script and no generated mirror was touched.

## Declined

- `docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/FIX_REPORT.md:1` —
  the finding is correct (a 2-byte file where the `fix` phase contract demands
  Root cause, Change, Tests, Local verification, Follow-ups, Assumptions and
  `## PR body`). Declined in part: the *content* of that report is the
  implementation record, and this phase ran no implementation, so writing a
  well-formed `FIX_REPORT.md` here would fabricate a change record that does not
  exist, and — worse — a well-formed file is exactly what a downstream
  section-presence check would accept, letting a branch with no fix in it look
  finished. The remedy is a re-run of phase 1 (or re-dispatch of the bead), not a
  cosmetic report: phase 1 must produce the implementation, and its report falls
  out of that work. What was applied instead is the placeholder form named in
  the previous phase's finding — a single line with no contract sections (see
  `## Fixed`), which keeps the honest "no work happened" signal, clears the two
  `MD012` lint errors the empty file added, and still cannot satisfy a
  section-presence check.
- `packages/core/skills/detect-stack/detect-stack.js:44` — real and current, but the
  fix is a dependency-free replacement for `glob.glob` covering `**/*.csproj`,
  `**/*.{ext,ext}`, `**/*{a,b}`, the `ignore` lists, `cwd`, `nodir` and `absolute`
  options, plus a failing-first test with `glob` made unresolvable. That is the
  `fix` phase's deliverable; dropping a hand-rolled matcher into a review phase
  would be exactly the "adjacent improvement bundled into a review" this contract
  forbids, and would land unreviewed.
- `packages/core/lib/detect-framework.js:21` — real (module-level
  `const { glob } = require('glob');`, used at lines 192, 273, 388, 411, 470, 487).
  Note for the implementer: `packages/core/package.json` declares **no**
  `dependencies` at all, so `glob` is undeclared there too, and `packages/full/lib`
  has no `core` entry — `grep -i detect` over it returns nothing — so
  `packages/core/lib` is not reachable from the full bundle. The blast radius is
  workspace consumers and anyone installing `@sunstone-partners/ensemble-core` from
  npm, not `claude plugin install`. Declined for the same scope reason, and because
  choosing between "share the new dependency-free matcher" and "declare glob in
  core" is a design decision the fix phase owns.
- `packages/full/package.json:1` — the declarations are dishonest as described
  (`ajv` is vendored by `scripts/vendor-bundle-deps.js` but not declared; the 20
  `@sunstone-partners/ensemble-*` peer dependencies are unpublished; there is no
  lockfile). Removing 20 manifest entries is a release-affecting
  decision that needs the `git log -S` / publish-script evidence trail the bead asks
  for, which belongs in an implementation phase with a regression test.
- `scripts/validate-all.js:551` — the gap is real and its cause is now identified:
  `validateFullBundleRequires` only resolves `RELATIVE_RE` specifiers, and
  `validateBundleBareRequires` (line 431) deliberately treats everything under
  `skills/` as `skillLevel` "reported, not vendored" — its own doc comment at lines
  425–427 names `glob` as the example. So `glob` is *known* to the validator and
  muted by policy. Declined here because closing it means turning a non-blocking
  report into a blocking gate over generated skill code, which will fail on other
  skills' bare requires until each is triaged; that is a considered change with its
  own negative test, not a review-phase edit.
- `packages/core/skills/detect-stack/__tests__/glob-optional.test.js:1` — the finding
  is that this file protects the end state the bead wants gone. It cannot be
  deleted or loosened (repository rule: never weaken a test to get green), and it
  cannot be retargeted before the behaviour it targets exists. Declined; the
  implementation phase retargets it with failing-first evidence.

## Verification

| Command | Exit | Result |
| ------- | ---- | ------ |
| `git diff --stat dev...HEAD` (phase entry) | 0 | `2 files changed, 17 insertions(+)` |
| `git diff --name-status dev...HEAD` (phase entry) | 0 | `A` `FIX_REPORT.md`, `A` `REVIEW_CODERABBIT_REPORT.md` |
| `wc -c docs/reports/.../FIX_REPORT.md` | 0 | `2` before the fix (two blank lines); `312` after (one-line "NO IMPLEMENTATION" marker) |
| `wc -c docs/reports/.../REVIEW_CODERABBIT_REPORT.md` (before fix) | 0 | `2113` |
| findings-marker count in `docs/reports/.../REVIEW_CODERABBIT_REPORT.md` (before fix) | 1 | `0` matches — the contract marker was absent |
| `grep -rn "require('glob')" packages/core packages/full scripts --include=*.js` | 0 | still matches `detect-stack.js:44`, `detect-framework.js:21`, `scripts/lib/file-discovery.js:11`, `scripts/generate-codex/index.js:7`, `scripts/generate-opencode/*` |
| `grep -n "glob" packages/core/lib/detect-framework.js` | 0 | line 21 require; uses at 192, 273, 388, 411, 470, 487 |
| `ls -la packages/full/lib \| grep -i detect` | 1 | no match — `packages/core/lib` is not in the full bundle |
| `npx markdownlint-cli2 docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/REVIEW_REPORT.md docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/REVIEW_CODERABBIT_REPORT.md` (after fix) | 0 | No problems found — `Summary: 0 issues in 0 files` |
| `npx markdownlint-cli2 "docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/*.md"` (after the `FIX_REPORT.md` marker) | 0 | `Linting: 3 files` → `Summary: 0 issues in 0 files` |
| `npx markdownlint .` (repository-wide, the repo's own `lint:md`) | 1 | 1208 `error MD` lines before the `FIX_REPORT.md` fix — of which exactly **2 came from a file this branch adds** (`FIX_REPORT.md:2` and `FIX_REPORT.md:3`, both `MD012/no-multiple-blanks`); the other 1206 are pre-existing on `dev` in files this branch does not touch. Re-run after the fix (and after the last edit to this report): **1206** `error MD` lines, and a `grep` for this run's directory over the same output returns **0** hits, i.e. no error comes from any file this branch adds — the untracked `REVIEW_REPORT.md` was present in that run and contributes nothing |
| `npx markdownlint docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/*.md` (the repository's own `lint:md` = `markdownlint .`, run on the three files this phase touches) | 0 | no output, exit 0 |
| `npm run validate` | 0 | "All plugins validated successfully"; release versions in sync 10.0.0; 186 prompt files within word budgets (the "below baseline" warnings are pre-existing advisories about other skills, not this diff) |
| `npm run generate:validate` | 0 | "✓ Validation passed (64 files)"; run-index matches a fresh build |
| `cd packages/core && npx jest skills/detect-stack` | 0 | `Test Suites: 5 passed, 5 total`; `Tests: 189 passed, 189 total` — the suite that covers the code findings 2, 3 and 6 point at, run to confirm this phase's markdown-only change did not disturb it |
| `npm view @sunstone-partners/ensemble-<peer> version` (20 peers) | 1 | every one returns `npm error code E404 ... 404 Not Found - GET https://registry.npmjs.org/@sunstone-partners%2fensemble-<peer> - Not found` |
| `git status --short` | 0 | three files under `docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/`: modified `REVIEW_CODERABBIT_REPORT.md`, modified `FIX_REPORT.md`, new `REVIEW_REPORT.md` — all left uncommitted for Foreman to commit |
| `npm test` (full workspace suite) | not run | no source or test file was edited; the narrowest affected suite (`packages/core` detect-stack) was run instead. The phase contract states: "Do not run the full test suite unless this repository's own conventions call for it or it is fast and known-reliable here" — it is neither, and the diff touches no code the suite exercises |
| `foreman_inbox_send` | 0 | **sent** — operator-facing BLOCKING note delivered to the run inbox (`{"status":"sent","message_id":"msg_FrPj-UX6GvXv1w8ER-3SVA"}`), stating that the bead is unimplemented, the branch is not mergeable, the two fixes are uncommitted, and that phase 1 must be re-run / the bead re-dispatched before a PR opens |
| `foreman_task_add_comment` | 1 | `Error: Task external_id is malformed` — the provider-backed task record carries a null `external_id`, so the Work Log comment could not be written. The same content went to the run inbox instead |

After the fixes, the diff was re-read once: `git diff --name-status dev` is still
the two report files under `docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/`
plus this artifact, so no new rule was violated — no generated file was hand-edited
(`packages/pi/**` and `packages/codex/**` untouched, and no mirror needed
regenerating because no source changed), no scratch file was written under `/tmp`
(the phase-2 mirror was read from `~/.omp/ensemble-pdf-f2-r3/`), and no source code
changed, so `npm run generate` / `generate:pi` produce nothing new for this diff.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
- `docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/FIX_REPORT.md:1` Critical — phase 1 shipped no implementation at all (its report was 2 bytes; it now carries only the one-line "NO IMPLEMENTATION" marker this phase added), so bead `ensemble-pdf-f2-bundle-glob-dependency-r3` is entirely unimplemented and this run still opens a PR with no fix in it.
- `packages/core/skills/detect-stack/detect-stack.js:44` Critical — the line still reads `globModule = require('glob').glob;`, so an installed full bundle (copied with symlinks dereferenced, `npm install` never run, `glob` not in the `scripts/vendor-bundle-deps.js` closure) cannot do wildcard detection at all.
- `packages/core/lib/detect-framework.js:21` Major — module-level `const { glob } = require('glob');` (used at lines 192, 273, 388, 411, 470, 487) is reached via `packages/core/lib/index.js:11`, and `packages/core/package.json` declares no `dependencies`, so `glob` is undeclared there too; the bead's claim that detect-stack holds the only glob use is wrong.
- `packages/full/package.json:1` Major — `dependencies` lists only `js-yaml` although `ajv` is vendored, 20 unpublished `@sunstone-partners/ensemble-*` siblings sit in `peerDependencies` (all 20 verified `E404` on npm), and with no lockfile an `npm install` of the installed plugin directory cannot succeed either.
- `scripts/validate-all.js:551` Major — `validateFullBundleRequires` resolves only relative specifiers while `validateBundleBareRequires` mutes everything under `skills/` as "reported, not vendored" (its own comment at lines 425–427 names `glob`), so an unresolvable bare require in a bundle-reachable file cannot fail `npm run validate`.
- `packages/core/skills/detect-stack/__tests__/glob-optional.test.js:1` Minor — the file asserts the degraded `glob-unavailable` end state that this bead intends to remove, so it must be retargeted to prove wildcard detection works with `glob` unresolvable, never deleted or loosened.
<!-- FOREMAN_REVIEW_FINDINGS_END -->
