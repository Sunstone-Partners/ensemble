# CodeRabbit review report — ensemble-pdf-f6b2c-permitter-tokenizer-impl

Phase 2 (`coderabbit-review`) of the `fix` workflow for task `ensemble-pdf-f6b2c-permitter-tokenizer-impl`, run `run-43b4ff4f44f3a441f4a75375f1a420c0`.

Base branch: `dev` (`FOREMAN_BASE_BRANCH=dev`).

## Review engine

- Exact command, run from the worktree root once per round:

  ```bash
  coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"
  ```

- Engine: CodeRabbit CLI `0.9.6` (`coderabbit --version` → `0.9.6`) — the same engine as the GitHub PR bot, run locally against the working tree, so the findings arrived without a push.
- Exit code: `0` in all three rounds; each round ended with `review_completed`.
- Files the engine reviewed in every round: `docs/reports/foreman-ensemble-pdf-f6b2c-permitter-tokenizer-impl/FIX_REPORT.md`, `packages/permitter/CHANGELOG.md`, `packages/permitter/lib/command-parser.js`, `packages/permitter/tests/security.test.js`.
- The round logs are scratch files outside the repository (`~/.omp/ensemble-pdf-f6b2-review/round1.log`, `round2.log`, `round3.log`); nothing was written under `/tmp` and no scratch file is committed.
- Operator progress tools (`foreman_inbox_send`, `foreman_task_add_comment`) are not exposed in this phase, so no progress note or task comment was sent from here. Phase 1 already reported that `foreman_task_add_comment` fails with `Task external_id is malformed`.

## Rounds

Three rounds were run (the phase allows at most three). Every finding the engine reported was `Major`, each one was reproducible against the code as it stood, and each one was fixed, so no round hit the "no Critical or Major finding fixed" stop condition.

### Round 1 — 2 findings received, 2 fixed, 0 declined

- **Major** — `packages/permitter/lib/command-parser.js:456-457` — "Check append assignments before skipping the builtin." Bash's append form `NAME+=value` was not recognised as an assignment, so `export LD_PRELOAD+=/tmp/evil.so; git status` was classified as only `git status` and auto-allowed, although real bash does set `LD_PRELOAD` (verified in bash: `export LD_PRELOAD+=/tmp/evil.so` then `echo $LD_PRELOAD` prints `/tmp/evil.so`). Fixed as fix 1.
- **Major** — `packages/permitter/lib/command-parser.js:154` — "Preserve the original prefix before recognizing a comment." `parseCommand()` trimmed with `String.prototype.trim()`, which strips every JavaScript whitespace character, while bash separates words only with space, tab and newline. `"\u00a0#; curl https://example.invalid/\ngit status"` therefore lost its leading non-breaking space, the `#` moved to index 0, the tokenizer treated the rest of the line as a comment, and the `curl` was never classified — the line was auto-allowed on a `Bash(git:*)` allowlist. Fixed as fix 2.

### Round 2 — 2 findings received, 2 fixed, 0 declined

- **Major** — `packages/permitter/lib/command-parser.js:485-486` — "Refuse assignment targets supplied through expansion." `X=PATH=/tmp/evil; export $X; git status` was classified as only `git status`: bash expands `$X` before `export` runs, so `PATH` is set and the approved `git` is looked up in `/tmp/evil`. Reproduced end to end with a fake `git` binary, which printed `HIJACKED git ran`. Fixed as fix 3.
- **Major** — `packages/permitter/lib/command-parser.js:406` — "Reject subscripted mutations of dangerous variables." `declare 'PATH[0]=/tmp/evil'; git status` passed the dangerous-variable check because the name was matched without its subscript. Fixed as fix 4.

### Round 3 — 3 findings received, 3 fixed, 0 declined

- **Major** — `packages/permitter/lib/command-parser.js:407` — "Reject assignment subscripts that can change other variables." `a[PATH=0]=x; git status` — bash evaluates the subscript as an arithmetic expression, so this assigns `PATH`, while the parser saw only `a`. Fixed as fix 5.
- **Major** — `packages/permitter/lib/command-parser.js:504` — "Reject unsupported nameref declarations before skipping them." `declare -n p=LD_PRELOAD; p+=/tmp/evil.so; export LD_PRELOAD; git status` — `p` is an alias of `LD_PRELOAD`, so the assignment changes `LD_PRELOAD` and the following `export` puts it in the environment of the approved command. Fixed as fix 6.
- **Major** — `packages/permitter/lib/command-parser.js:551` — "Account for integer declarations before stripping assignments." `declare -i n; n+=PATH=0; git status` — with the integer attribute the value is an arithmetic expression, so `n+=PATH=0` assigns `PATH`. Fixed as fix 7.

## Fixed

1. `packages/permitter/lib/command-parser.js` — the append form `NAME+=value` was not an assignment, so a skip command (`export`, `declare`, `typeset`, `set`, `local`) dropped it and the dangerous-variable check never ran. Added `envAssignmentName(token)` (returns the variable name of an `=`/`+=` assignment) and used it in `isEnvAssignment()` and `assertSafeAssignment()`, so `export LD_PRELOAD+=/tmp/evil.so; git status` is refused with `Dangerous variable assignment not supported: LD_PRELOAD`.
2. `packages/permitter/lib/command-parser.js` — `parseCommand()` trimmed with `String.prototype.trim()`, which removes characters bash does not treat as word separators (U+00A0, U+000B, U+000C, U+FEFF, U+2028), which moved a leading `#` to the start of the string and hid the rest of the line. Added `trimShellBlanks()` (space, tab and newline only) and used it in `parseCommand()`.
3. `packages/permitter/lib/command-parser.js` — a declaration command whose argument expands (`export $X`, `export "$X"`, `unset $X`, `declare $X`) was skipped without resolving the expansion, so the variable it sets could not be established. Added `hasExpansion(token)` (single quotes are inert in bash) and `assertSafeSkipCommand()` now refuses such an argument with `dynamic <command> argument not supported: <token>`; literal assignments (`export FOO=bar`) stay allowed.
4. `packages/permitter/lib/command-parser.js` — an assignment carrying a subscript (`declare PATH[0]=/tmp/evil`) was matched on the name only, so the dangerous-variable check was skipped. `ENV_ASSIGNMENT_RE` now captures the subscript and `assertSafeAssignment()` refuses it with `Subscripted assignment not supported: <token>`.
5. `packages/permitter/lib/command-parser.js` — a subscript that bash evaluates as an arithmetic expression (`a[PATH=0]=x`) assigns another variable, which a name-only check cannot see. `assertSafeAssignment()` now refuses a subscript that is not a plain index, so the command line is refused instead of classified from a guess.
6. `packages/permitter/lib/command-parser.js` — `declare -n p=LD_PRELOAD` (nameref) and `declare -i n` (integer attribute) change how a later assignment is interpreted, and the parser skipped the declaration without tracking that. Added `assertSafeDeclarationOptions(segments)`, called from `parseCommand()`, which refuses the `-n` and `-i` options of `declare`/`typeset`/`local` with `Nameref declaration not supported: -n` and `Integer declaration not supported: -i`. The guard sits on the command line rather than inside `normalizeSegment()` because the declaration and the assignment that exploits it can be in different segments of the same line, and because `normalizeSegment()` keeps its existing contract — its existing test `packages/permitter/tests/command-parser.test.js:299` ("should skip typeset command", fixture `normalizeSegment(['typeset','-i','num'])` → `null`) is untouched and still green.
7. `packages/permitter/lib/command-parser.js` — an assignment whose value is itself an assignment (`n+=PATH=0`) is an arithmetic expression when the variable has the integer attribute, so it assigns `PATH`. `assertSafeAssignment()` now refuses such a value with `Arithmetic assignment not supported: n+=PATH=0`.

Tests added to `packages/permitter/tests/security.test.js`, each written before its fix and red on the old code:

- `Security: review round 1 findings (pdf-f6b2)` — 17 cases: append assignments for `export`/`declare`/`typeset`/`local`/`set`, the comment prefix behind a non-shell whitespace character (six characters), the hidden `curl` still being classified, and the allow paths `export FOO+=bar`, an indented comment followed by `git status` (`<two spaces># comment` then `git status`), `git status` preceded by two spaces, and `npm test` preceded by a tab.
- `Security: review round 2 findings (pdf-f6b2)` — 13 cases: expanded declaration targets for `export`/`declare`/`typeset`/`local`/`unset`, subscripted `PATH` for `declare`/`typeset`/`local`, and the allow paths `export FOO=bar`, `export FOO=$HOME/bin`, `declare FOO[0]=bar`.
- `Security: review round 3 findings (pdf-f6b2)` — 12 cases: a subscript that assigns another variable, nameref declarations, integer declarations, arithmetic assignment values, and the allow paths `declare FOO[0]=bar`, `declare -r FOO=bar`, `export FOO=bar`, `declare FOO=bar`, `FOO=bar git status`.

Failing-first evidence on the old code (`cd packages/permitter && npx jest tests/security.test.js -t "review round N"`):

- round 1 → `Tests: 14 failed, 247 skipped, 3 passed, 264 total` (exit 1)
- round 2 → `Tests: 8 failed, 264 skipped, 5 passed, 277 total` (exit 1)
- round 3 → `Tests: 7 failed, 277 skipped, 5 passed, 289 total` (exit 1)

## Declined

None. Every finding was checked against the code as it stood before it was changed, reproduced, and fixed; none of them asked for work outside this run's scope.

## Verification

- `cd packages/permitter && npx jest tests/security.test.js -t "review round"` → `Tests: 42 passed, 247 skipped, 289 total` (exit 0)
- `cd packages/permitter && npx jest tests/security.test.js` → `Tests: 289 passed, 289 total` (exit 0)
- `cd packages/permitter && npx jest` → `Test Suites: 7 passed, 7 total`, `Tests: 679 passed, 679 total` (exit 0) — the 637 pre-existing tests are unchanged and green, 42 were added
- `npx eslint packages/permitter/lib/command-parser.js packages/permitter/tests/security.test.js` → exit 0; 0 errors and 2 warnings that are pre-existing (`command-parser.js` matches an eslint ignore pattern; the unused `allowlist` at `packages/permitter/tests/security.test.js:777` is present identically on `dev`)
- `npm run generate:validate` → `EXIT=0` ("Validation passed (64 files)")
- `npm run validate` → `EXIT=0` — only the pre-existing prompt-budget "below baseline" warnings for the `packages/development`, `packages/assessment` and `packages/git` skills, which this change does not touch
- `npx markdownlint docs/reports/foreman-ensemble-pdf-f6b2c-permitter-tokenizer-impl/REVIEW_CODERABBIT_REPORT.md` → exit 0
- Manual probes (scratch scripts under `~/.omp/ensemble-pdf-f6b2-review/`): every refused case above now throws from `parseCommand()`, and the allow paths still return their command. The hook fails closed on a parse error (`packages/permitter/hooks/permitter.js:177`), so a refused command reaches the permission dialog instead of being approved.
- `npm run generate` / `npm run generate:pi` were not run: this change touches no generated mirror (`packages/full/lib/command-parser.js` is a symlink to the edited `packages/permitter/lib/command-parser.js`, and no skill, command or agent file changed).
- Phase 1's `FIX_REPORT.md` had lost its required `## PR body` section (a later phase-1 commit truncated it from 570 to 28 lines) and carried 3 markdownlint errors, so the PR body could not describe the final change set. It was restored with the phase-2 changes, the final suite numbers and the required `## Summary` / `## Testing` / `## Risk` / `## How to revert` / `## Directed by` headings (`Directed by: @ldangelo`), and `npx markdownlint docs/reports/.../FIX_REPORT.md` now exits 0.

The fixes are left uncommitted for Foreman to commit.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
- `packages/permitter/lib/command-parser.js:701` Major — `bash -c "git status; rm -rf /"` is classified as only `git status`, because `normalizeSegment()` returns `normalizeSegment(innerSegments[0])` and drops every later inner segment, so the allowlist never sees the `rm -rf /` (pre-existing on `dev`, not introduced by this run, and not a CodeRabbit finding).
- `packages/permitter/lib/command-parser.js:270` Minor — the tokenizer leaves `inQuotedSection` set when a quoted token is followed by an operator, so the next segment starts with an empty token (`tokenize('echo "x y"; ls')` → `["echo","x y",";","","ls"]`, identical on `dev`) and that segment is classified with an empty executable that never matches a `Bash(...)` pattern, which causes false refusals (fails closed).
- `packages/permitter/lib/command-parser.js:797` Major — an integer-attribute variable declared in an earlier, human-approved command (`typeset -i n`) still evaluates its value as an arithmetic expression in a later command (`n+=$(echo PATH=0); git status` is auto-allowed), because the parser is stateless per command line and only refuses arithmetic values inside the line that declares them.
<!-- FOREMAN_REVIEW_FINDINGS_END -->
