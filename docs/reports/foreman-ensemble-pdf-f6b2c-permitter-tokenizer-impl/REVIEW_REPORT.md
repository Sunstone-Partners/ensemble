# Repository-rules review — ensemble-pdf-f6b2c-permitter-tokenizer-impl

## Review engine

Reviewer: the Foreman `fix` workflow's phase-3 repository-rules agent, reviewing this
run's own committed work against this repository's own rules.

Diff range reviewed: `git diff dev...HEAD`, where `dev` is `$FOREMAN_BASE_BRANCH`
(tip `b05fd21a`, confirmed as the merge base by `git merge-base dev HEAD`) and
`HEAD` is `501e049c`. `git diff --shortstat dev...HEAD` reports
**5 files changed, 957 insertions(+), 17 deletions(-)**, per file
(`git diff --numstat dev...HEAD`):

| File | +/− |
| --- | --- |
| `packages/permitter/lib/command-parser.js` | +333 / −17 |
| `packages/permitter/tests/security.test.js` | +523 / −0 |
| `packages/permitter/CHANGELOG.md` | +13 / −0 |
| `docs/reports/foreman-ensemble-pdf-f6b2c-permitter-tokenizer-impl/FIX_REPORT.md` | +70 / −0 |
| `docs/reports/foreman-ensemble-pdf-f6b2c-permitter-tokenizer-impl/REVIEW_CODERABBIT_REPORT.md` | +18 / −0 |

Conventions applied, in this order: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, the
root `CHANGELOG.md` (Keep a Changelog), `packages/permitter/README.md`,
`packages/permitter/CHANGELOG.md`, and the permitter package's own module and test
conventions. The four checks named in the phase brief were applied to the range:
failure reporting versus hidden success values, a typed/structured boundary at the
same interface, declared configuration/manifest/enum values that no code reads, and
documentation reconciled with behavior the diff adds, removes, or renames.

Nothing in the range was skipped. `packages/full/lib/command-parser.js` is a git
symlink to `packages/permitter/lib/command-parser.js`, so it carries no separate
content; the diff touches no generated source, so no mirror regeneration was
required and `npm run generate` was deliberately not run. This phase's fixes are
left uncommitted and unstaged (`git diff --cached --name-only` is empty) for
Foreman to commit.

Carry-forward from the previous phase: the previous report is
`docs/reports/foreman-ensemble-pdf-f6b2c-permitter-tokenizer-impl/REVIEW_CODERABBIT_REPORT.md`.
It ended with three unresolved findings. All three are carried forward below and
into the unresolved-findings block, because none of them was fixed in this phase
and each is pre-existing on `dev` rather than a defect introduced by this run. The
fuller phase-2 report body is recoverable from git history
(`git show f89dc4ac:docs/reports/foreman-ensemble-pdf-f6b2c-permitter-tokenizer-impl/REVIEW_CODERABBIT_REPORT.md`);
the committed copy is the condensed version Foreman wrote over it.

## Findings

Eight findings were triaged: four fixed, four declined.

| # | Finding | Source | Disposition |
| --- | --- | --- | --- |
| 1 | Root `CHANGELOG.md` has no entry for this run's user-facing permitter behavior change | this phase | Fixed |
| 2 | `packages/permitter/README.md` is not reconciled with the diff's new API and refusal set | this phase | Fixed |
| 3 | The diff's two new exports are declared "for testing" but no test read them | this phase | Fixed |
| 4 | `checkRedirections` is exported but missing from the README require block | this phase | Fixed |
| 5 | `checkQuoteBalance()` counts quotes inside comments, so an apostrophe in a comment is refused as an unbalanced quote | this phase | Declined |
| 6 | `bash -c "git status; rm -rf /"` is classified from its first inner segment only | carried forward (phase 2) | Declined |
| 7 | The tokenizer leaves an empty token after a quoted token followed by an operator | carried forward (phase 2) | Declined |
| 8 | `typeset -i` integer attribute is not carried across hook invocations | carried forward (phase 2) | Declined |

Findings 5 to 8 were verified against the code as it currently is before being
declined; none of them describes code that no longer looks that way.

## Fixed

**1. `CHANGELOG.md` (repository root)**

- What was wrong: the diff changes user-facing permitter behavior — a command that
  uses a refused construct used to be auto-allowed or silently trimmed and now
  defers to the permission dialog. The package changelog records that in 13 entries
  under `packages/permitter/CHANGELOG.md` → `[Unreleased]` → `Security`, but the
  root `CHANGELOG.md` `[Unreleased]` section had no entry for it. The root file is
  the ecosystem-level record ("All notable changes to the Ensemble Plugins ecosystem
  will be documented in this file"), and the closest precedent — the previous
  `ensemble-permitter` allowlist-bypass security fix (#181), recorded at
  `CHANGELOG.md:348` under `### Fixed` — is recorded in both the root changelog and
  the package changelog.
- What changed: one `### Fixed` bullet added under `[Unreleased]`
  (`CHANGELOG.md:13`), in the same style as the existing entry, describing the
  hardening, the constructs that are now refused, and the behavior change.

**2. `packages/permitter/README.md`**

- What was wrong: the diff changed the module's public surface and its refusal set,
  but the README still documented the old behavior — the require block did not
  mention the new `checkQuoteBalance` export, "Unsafe Construct Detection" did not
  list the new refusal categories, "Parse Errors" did not list the new error
  messages, and the normalization-pipeline diagram still claimed that env var
  prefixes are always stripped (they are refused now when the variable is
  dangerous). `CONTRIBUTING.md` requires the README to stay complete.
- What changed (+54/−1): a paragraph after the pipeline diagram
  (`packages/permitter/README.md:176`) stating the comment, assignment and refusal
  rules; the diagram row now reads "Strips env var prefixes (when safe)"
  (`packages/permitter/README.md:161`); three new "Normalization Examples" rows
  (`npm test # build`, `PATH=/evil npm test`, `env -C /tmp npm test`); the require
  block lists `checkQuoteBalance` (`packages/permitter/README.md:281`); a new
  `#### checkQuoteBalance(command): void` section
  (`packages/permitter/README.md:342`); a `**Notes:**` block on `tokenize`; five new
  rows in "Unsafe Construct Detection" (`packages/permitter/README.md:635`) and ten
  new rows in "Parse Errors" (`packages/permitter/README.md:757`). Every error
  string in the new rows was copied from
  `packages/permitter/lib/command-parser.js:88,127,473,493,500,542,661,667,794,797`.

**3. `packages/permitter/tests/command-parser.test.js`**

- What was wrong: the diff added `checkQuoteBalance` and `DANGEROUS_ASSIGNMENT_VARS`
  to the module's exports with the comment "Export constants for testing"
  (`packages/permitter/lib/command-parser.js:866-871`), but no test read either of
  them. That breaks the package's own convention, where every exported constant has
  a `should export X set` test in `describe('Module Exports')`
  (`packages/permitter/tests/command-parser.test.js:707-732`).
- What changed (+20): the require block now imports `checkQuoteBalance` and
  `DANGEROUS_ASSIGNMENT_VARS`, and two new tests were added — `should export
  DANGEROUS_ASSIGNMENT_VARS set`
  (`packages/permitter/tests/command-parser.test.js:736`) and `should export
  checkQuoteBalance` (`packages/permitter/tests/command-parser.test.js:745`) — in
  the style of the neighbouring export tests.

**4. `packages/permitter/README.md` (require block)**

- What was wrong: the require block listed the module's importable API but omitted
  `checkRedirections`, which `packages/permitter/lib/command-parser.js:865` exports.
  The block was already being edited by finding 2, so the drift sat next to the
  change.
- What changed (+1): `checkRedirections,` added to the require block
  (`packages/permitter/README.md:280`).

## Declined

**1. `packages/permitter/lib/command-parser.js:88` — `checkQuoteBalance()` counts
quotes inside comments, so `git status # don't run rm -rf /` is refused as an
unbalanced quote.**

Declined: the behavior is deliberate and is already asserted by the diff's own
tests (`packages/permitter/tests/security.test.js` accepts either a parse error or
a non-`git` executable for that input), it fails closed — the hook maps a parse
error to `DECISION.ASK` (`packages/permitter/hooks/permitter.js:175-179`) — and it
is documented in `packages/permitter/CHANGELOG.md` ("A command with an unbalanced
quote now defers to the permission dialog instead of being classified from a
guess"). Relaxing it would undo a security refusal this run deliberately
introduced. The behavior is documented rather than changed: the root changelog
entry, the README pipeline paragraph and the new `checkQuoteBalance` section all
state that a comment containing an unmatched quote makes the whole command defer
to the permission dialog.

**2. `packages/permitter/lib/command-parser.js:701` — `bash -c "git status; rm -rf /"`
is classified from its first inner segment only.**

Declined: pre-existing on `dev` and unchanged by this diff; fixing it means
changing `normalizeSegment()`'s single-command return contract, a behavior change
beyond this run's scope. Carried forward.

**3. `packages/permitter/lib/command-parser.js:270` — the quote-exit branches leave
`inQuotedSection` set, so a segment that follows a quoted token and an operator
starts with an empty token and is refused even when it is safe.**

Declined: pre-existing on `dev` and unchanged by this diff; it fails closed, and
fixing the tokenizer's quote-state bookkeeping is outside this run's scope.
Carried forward.

**4. `packages/permitter/lib/command-parser.js:797` — an integer attribute the user
approved through the ASK dialog in an earlier invocation (`typeset -i n`) is not
known when a later invocation assigns to `n`.**

Declined: pre-existing on `dev`; the parser is stateless per hook invocation by
design, and carrying integer-attribute state across invocations is a larger design
change than this phase can make safely. Carried forward.

## Verification

All commands below were run in this worktree after the fixes; exit codes are the
real ones.

| Command | Result |
| --- | --- |
| `git diff --shortstat dev...HEAD` | `5 files changed, 957 insertions(+), 17 deletions(-)` |
| `git diff --numstat dev...HEAD` | 5 entries: 333/17, 523/0, 13/0, 70/0, 18/0 |
| `git merge-base dev HEAD` | `b05fd21a7abf8a6cb6c5910d355047a14c6af27f` (= `dev` tip) |
| `git diff --cached --name-only` | empty — nothing staged |
| `cd packages/permitter && npx jest tests/command-parser.test.js` | EXIT=0 — 1 suite, 121 tests passed (119 before this phase, plus the 2 new export tests) |
| `cd packages/permitter && npx jest tests/security.test.js` | EXIT=0 — 289 tests passed |
| `cd packages/permitter && npx jest` | EXIT=0 — 7 suites, 681 tests passed (679 before this phase, plus the 2 new export tests) |
| `npx eslint packages/permitter/tests/command-parser.test.js` | EXIT=0 — no errors, no warnings |
| `npx markdownlint packages/permitter/README.md` | EXIT=1 — one error, `packages/permitter/README.md:95:27 MD026/no-trailing-punctuation` on the heading `#### Example settings file:`. Proven pre-existing: the same single error is reported on the unmodified HEAD README (verified by stashing this phase's README change, re-running the linter, and restoring). This phase adds no new markdownlint finding. |
| `npx markdownlint docs/reports/foreman-ensemble-pdf-f6b2c-permitter-tokenizer-impl/REVIEW_REPORT.md` | EXIT=0 |
| `npm run generate:validate` | EXIT=0 — 64 generated files validated, run-index matches a fresh build |
| `npm run validate` | EXIT=0 — all plugin manifests valid, marketplace in sync, versions in sync, 298 skills conform. Warnings only: 10 pre-existing "words below baseline" notices for skills this run did not touch. |

The diff's own failing-first evidence was produced and recorded in the previous
phase (`REVIEW_CODERABBIT_REPORT.md`: 42 new tests, red counts 14, 8 and 7 across
three rounds, green after the fix). None of the four fixes in this phase is a
behavior change to the parser, so no new failing-first test applies: fixes 1, 2
and 4 are documentation, and fix 3 adds the coverage for exports whose behavior
the previous phase's tests already exercised.

The diff was re-read after the fixes (`git diff dev...HEAD` plus the working-tree
diff) to confirm that the fixes introduce no new violation: the changelog entry
follows the root file's existing style and the markdownlint ignore list excludes
`CHANGELOG.md`; the README changes add only rows, a paragraph and one API section
in the surrounding style; the test additions follow the neighbouring export tests
and change no production code. The changelog and README wording was additionally
corrected after review so that neither claims an apostrophe inside a comment is
parsed when the command is in fact refused for an unbalanced quote.

Unresolved findings — one bullet per finding a human still needs to act on:

<!-- FOREMAN_REVIEW_FINDINGS_START -->
- `packages/permitter/lib/command-parser.js:701` Major — `bash -c "git status; rm -rf /"` is classified from its first inner segment only, so the remaining inner command is never matched against the allowlist.
- `packages/permitter/lib/command-parser.js:270` Minor — the tokenizer's quote-exit branches leave `inQuotedSection` set, so a segment after a quoted token and an operator starts with an empty token and is refused even when it is safe.
- `packages/permitter/lib/command-parser.js:797` Minor — the parser is stateless across hook invocations, so an integer attribute the user approved through the ASK dialog in an earlier call (`typeset -i n`) is unknown when a later call assigns to `n`.
<!-- FOREMAN_REVIEW_FINDINGS_END -->
