Phase complete. Summary:

## What was wrong

`packages/full` is a symlink farm; `claude plugin install` dereferences it and never runs `npm install` → the installed bundle is a flat `lib/` that must contain every file the shipped prose names. It didn't:

- **F7** — no `reqnroll-cli.js` in `packages/full/lib`; `lib/prd-cli.js` mirrored the **development** registry CLI (no `generate-features`/`check-drift`, which live only in the product CLI).
- **F11** — `playwright-tester` agent named `delegation-contract.js`, `test-runner-mode.js`, `grounded-marker-checker.js`; absent from the bundle.

Two traps: the bundle's `lib/` is a **flat namespace** (`prd-parser.js` existed in two packages with different APIs) and the two `prd-cli.js` were **not** supersets.

## Fix

- Bundle's `prd-parser.js` must stay the **development** parser (pinned by shipped `completion-verification` skill + `development/lib/trd-cli.js:47`) → renamed the **product** parser to `prd-feature-parser.js`.
- New `packages/product/lib/prd-registry.js` mirrors the registry half into the product package (both publish standalone; same pattern as `config-path.js`); `packages/full/lib/prd-cli.js` → `../../product/lib/prd-cli.js`, now serving all six subcommands.
- 12 new bundle mirrors (7 product, 5 e2e-testing incl. `evidence-capture.js`→`spec-writer.js`).
- `scripts/validate-all.js`: mirror **target** now checked (`FULL_LIB_MIRROR_OWNERS`), plus new `validateFullLibReferences` — a shipped skill/agent/command naming an unbundled lib file now fails `npm run validate`.
- New tests: `scripts/tests/full-bundle-install-smoke.test.js` (4), `scripts/tests/validate-full-lib-references.test.js` (11), `packages/product/tests/prd-cli-registry.test.js` (5, differential vs the development CLI).

## Verification (real results)

| Command | Result |
|---|---|
| `npm run generate` / `generate:pi` | EXIT=0, **no** Pi version bump (vendor/ not a content path) |
| `npm run generate:validate` | **EXIT=0** |
| `npm run validate` | **EXIT=0** (103/103 mirrors, 31/31 lib refs resolve) |
| new jest files | 15 + 5 tests pass |
| `npx jest scripts/tests` | 1912 tests, 1907 passed, **4 failed = pre-existing** (operator's `~/.config/ensemble/toolchain.yaml` → `source:'user'`; both suites pass 60/60 with scrubbed HOME) |
| packages/product / full / e2e-testing | 233 / 25 / 674 pass |
| packages/development | 2 failures, both pre-existing (`trd-cli` AC-2 = same config issue, 41/41 with scrubbed HOME; `local-ci-adversarial` clones its own copy) |
| evals (2 touched files) | 1 failure = 5000 ms jest timeout, **proven pre-existing** via `git stash` (identical failure on base content; diff verified byte-identical after restore) |

Red-first transcripts: `~/.omp/ensemble-pdf-f7-f11/red-{smoke,product,validator}.txt`.

**Follow-ups:** finding 2's `glob` is allowlisted (not fixed here); the registry half now exists in two packages (kept in sync by hand); full `npx jest evals` exceeded a 10-min window.

Report: `docs/reports/foreman-ensemble-pdf-f7-f11-bundle-path-hygiene-r5/FIX_REPORT.md` (19012 B, markdownlint 0 issues, includes `## PR body`). 38 files staged, **nothing committed** — HEAD still `fe5aea4f`.