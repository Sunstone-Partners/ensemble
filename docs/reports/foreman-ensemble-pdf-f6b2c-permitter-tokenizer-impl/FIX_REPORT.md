Phase 1 complete. Summary:

## What was already done vs. what I changed

**Branch state on arrival:** HEAD (`7ce56642`, Foreman's phase-1 commit) already contained the prior attempt's parser fix + canonical failing-first tests. I verified it: all 4 reported defects are covered and green — comment branch ends at newline only (not `break`), `env` options parsed, dangerous `VAR=value` refused, variable-valued `IFS` recognised.

**My contribution this run** (parser code untouched):

| File | Change |
|---|---|
| `packages/permitter/tests/security.test.js` (+86) | 8 new failing-first cases: `Security: env wrapper option completeness (pdf-f6b2)` (6) — missing *coverage* for options the staged parser already refuses (`env --`, `env -iu NAME`, `env --unset=NAME`, `env --chdir=/tmp` → throw `env option not supported`; not auto-allowed; whole-line comment → no command classified); `Security: permitter hook fails closed (pdf-f6b2)` (2) — spawns the real hook, asserts comment-only and refused commands yield `ask`, never `allow` |
| `docs/reports/.../FIX_REPORT.md` | Stale failing-first numbers → final measured; PR body headings `###` → `##` (exact `## Summary`/`## Testing`/`## Risk`/`## How to revert`/`## Directed by`); 5 markdownlint errors fixed (raw `\|` in code spans); "gap closed" wording corrected to "missing coverage" |

## Verification (real exit codes / counts)

- `origin/dev` parser + final tests → **55 failed, 192 passed, 247 total** (all 8 new cases red: `-- ends the option list`, `combined -i and -u`, `--unset= form`, `unknown long option`, `a dropped env option cannot make a command auto-allowed`, `a whole-line comment yields no command to classify`, 2 hook cases) — scratch baseline `~/.omp/ensemble-pdf-f6b2-rerun/baseline/`
- `cd packages/permitter && npx jest tests/security.test.js` → **247 passed / 247**
- `cd packages/permitter && npx jest` → **7 suites, 637 passed / 637**
- `npm run generate:validate` → `EXIT=0`; `npm run validate` → `EXIT=0`
- `npx eslint packages/permitter/lib/command-parser.js packages/permitter/tests/security.test.js` → 0 errors, 2 pre-existing warnings (`command-parser.js` ignore-pattern; unused `allowlist` at `tests/security.test.js:777`)
- `npx markdownlint <report> packages/permitter/CHANGELOG.md` → exit 0

## Notes

- Advisor review caught an inaccurate "gap closed" claim (it was a test gap, not a behavior gap) → report + inbox corrected; also added the hook-level fail-closed coverage it asked for. `hooks/permitter.js:182` (`commands.length === 0 → ASK`) and `:175` (parse error → ASK) now have end-to-end coverage.
- `foreman_inbox_send` sent twice (start/correction + completion). `foreman_task_add_comment` **failed**: `Task external_id is malformed` (task `external_id` is null) — re-attempted, same error; summary is in the inbox notes and the report.
- Both changed files are **staged by name, uncommitted**; no branch/push/PR ops, no `.beads/`, no generated mirrors (`npm run generate`/`generate:pi` not needed), `hooks.json` and hook output format untouched.

## Review phase changes (phase 2, CodeRabbit review)

The CodeRabbit review of this branch reported 7 `Major` findings, all in `packages/permitter/lib/command-parser.js`; every one was reproduced and fixed. Per-finding detail, the failing-first evidence and the final exit codes are in `docs/reports/foreman-ensemble-pdf-f6b2c-permitter-tokenizer-impl/REVIEW_CODERABBIT_REPORT.md`.

- `packages/permitter/lib/command-parser.js` — bash's append form `NAME+=value` is now an assignment (so `export LD_PRELOAD+=/tmp/evil.so; git status` is refused); only bash word separators are trimmed (so a non-breaking space before `#` can no longer hide the rest of the line); a declaration command whose argument expands is refused (`X=PATH=/tmp/evil; export $X; git status`); a subscripted assignment, a nameref declaration (`-n`), an integer declaration (`-i`) and an assignment value that is itself an assignment (`n+=PATH=0`) are refused.
- `packages/permitter/tests/security.test.js` — 42 failing-first cases in three describes (`Security: review round 1 findings (pdf-f6b2)`, `Security: review round 2 findings (pdf-f6b2)`, `Security: review round 3 findings (pdf-f6b2)`), each red before its fix.
- `packages/permitter/CHANGELOG.md` — the matching `Unreleased / Security` entries.

Every change is a refusal: a command the parser cannot classify safely now reaches the permission dialog instead of being auto-approved. No command that was refused before is now allowed. Final state of the package suite after the review phase: **7 suites, 679 passed / 679** (637 pre-existing + 42 added).

## PR body

## Summary

Hardens the permitter's Bash command parser so a command that hides part of itself is refused instead of auto-approved.

- A `#` that starts a word is a comment to the end of that line only; an apostrophe inside a comment no longer swallows the rest of the command.
- Leading `VAR=value` assignments that change `PATH`, `IFS`, `LD_*` or `DYLD_*` are refused, bash's append form `NAME+=value` is recognised, and a variable-valued `IFS=` assignment is classified.
- Wrapper options the parser cannot parse safely are refused (`env -C /tmp git status`, `env -S 'git status'`, `env --unset=PATH`).
- Declaration commands whose argument expands, subscripted assignments, nameref (`-n`) and integer (`-i`) declarations, and assignment values that are themselves assignments are refused.

Every change is a refusal: a command the parser cannot classify safely now reaches the permission dialog (`ask`) instead of being auto-approved by the allowlist. Plain safe commands (`git status`, `ls -la`, `npm test`) are still auto-approved. `hooks.json` and the hook's output format are untouched.

## Testing

- `cd packages/permitter && npx jest` → 7 suites, **679 passed / 679** (637 pre-existing, 42 added; each added case was red before its fix)
- `cd packages/permitter && npx jest tests/security.test.js` → **289 passed / 289**
- `npm run generate:validate` → `EXIT=0`
- `npm run validate` → `EXIT=0`
- `npx eslint packages/permitter/lib/command-parser.js packages/permitter/tests/security.test.js` → 0 errors, 2 pre-existing warnings

## Risk

Security hardening on the allowlist decision path: the parser refuses more commands, so a command that used to be auto-approved can now reach the permission dialog. The change never turns a previously refused command into an allowed one.

## How to revert

Revert this branch's commits. `packages/permitter/lib/command-parser.js` and `packages/permitter/tests/security.test.js` return to their previous state and the permitter keeps its previous behaviour.

## Directed by

Directed by: @ldangelo
