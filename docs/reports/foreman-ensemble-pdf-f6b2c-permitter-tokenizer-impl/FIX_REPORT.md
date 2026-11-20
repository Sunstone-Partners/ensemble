# Fix Report — ensemble-pdf-f6b2c-permitter-tokenizer-impl

Phase: `fix` (phase 1), run `run-43b4ff4f44f3a441f4a75375f1a420c0`.
Branch: `foreman/ensemble-pdf-f6b2c-permitter-tokenizer-impl/run-43b4ff4f44f3a441f4a75375f1a420c0` (base commit `b05fd21a`).
Scope: reporter finding 6, security half, part A — permitter tokenizer and shell-wrapper hardening.

All changes are left **uncommitted** for Foreman to commit and open the PR.
`packages/full/lib/command-parser.js` is a git **symlink** to `packages/permitter/lib/command-parser.js`
(`ls -l` → `../../permitter/lib/command-parser.js`); only the permitter source was edited.
`packages/permitter/hooks/permitter.js`, `hooks.json` and the hook's output format were **not** touched.

## Root cause

All four defects live in `packages/permitter/lib/command-parser.js` — the shell parser that decides
whether a Bash command may be auto-allowed. The parser classified commands from a guess instead of
refusing what it could not prove, so a command that hides part of itself still produced an "allow"
decision.

### 1. No `#` comment branch in `tokenize()` (defect 1)

`tokenize()` (line 100) had no case for a `#` that begins a word. Consequences on the old code:

* `git status # don't run rm -rf /` — the apostrophe in the comment opened a single-quote run that
  never closed, so the whole tail became one token and the segment was classified as
  `executable: 'git'` → matched `Bash(git:*)` → **auto-allowed**. The hidden `rm -rf /` was never
  classified.
* `git status --pretty='%h` — an unterminated quote was silently accepted; the segment was again
  classified as `git` → **auto-allowed**.
* A comment was not skipped at all, so `npm test # verify` classified as `npm` with args
  `test # verify`.

### 2. `env` wrapper options were never parsed (defect 2)

`normalizeSegment()` (line 448) stripped only the literal `-u` flag (and dropped the following
token blindly); every other option fell through to the "first token is the executable" rule:

* `env -C /tmp git status` → the `-C` was not recognised as an option, so the executable became
  **`/tmp`** (the wrong program entirely) — the segment no longer matched `Bash(git:*)`, but it also
  mis-classified what would actually run.
* `env -S 'git status'`, `env -0`, `env -v`, `env --unset=PATH`, `env -PATH=/evil`, `env --` were
  all silently accepted with an unknown effect on the executed program.

`sudo` and `command` are not wrapper-stripped in this parser at all, so `sudo git status` classifies
as `executable: 'sudo'` and is refused by the allowlist — no change was needed there.

### 3. Leading `VAR=value` assignments were silently dropped (defect 3)

`normalizeSegment()` stripped every leading `KEY=value` token before classifying the program, so the
program was classified **as if the assignment were absent**:

* `PATH=/evil git status` → classified as `git` → **auto-allowed** (a hostile `PATH` would have been
  used to resolve `git`).
* `LD_PRELOAD=/evil.so git status`, `LD_LIBRARY_PATH=/evil git status`, `DYLD_INSERT_LIBRARIES=/evil.dylib git status`
  → **auto-allowed**.
* `IFS=$x git status` → **auto-allowed** (defect 4: a variable-valued `IFS=` was not recognised as
  dangerous, so the assignment was dropped and the command was classified as if `IFS` were unset).

### 4. Assignments inside a *skipped* command were never inspected

`normalizeSegment()` returned `null` for `SKIP_COMMANDS` (`export`, `set`, `unset`, `local`,
`declare`, `typeset`) *before* any assignment check, so a skipped command that changes the
environment of every command that follows it on the same line was invisible to the parser:

* `export PATH=/tmp/evil; git status` → the export was skipped, the segment was classified as
  `git` → **auto-allowed**, although `PATH` now points at the hostile directory for the rest of the
  line.
* `export LD_PRELOAD=/tmp/evil.so; git status`, `declare PATH=/tmp/evil; git status`,
  `typeset IFS=$x; git status`, `set PATH=/tmp/evil; git status` → same.
* `unset PATH; git status` → the variable is removed rather than assigned, but the effect on
  executable resolution is the same → **auto-allowed**.

### 5. The comment branch used JavaScript's word separators, not the shell's

The first version of the `#` branch treated a `#` as a comment when the previous character matched
`/[\s;|&]/`. JavaScript's `\s` is wider than the shell's word separators (space, tab, newline): it
also matches a non-breaking space, a vertical tab, a form feed and a carriage return, none of which
separate words in the shell. A `#` after one of those characters therefore started a comment that
swallowed the rest of the line while the shell would have run it:

* `true; #; echo MARKER` → the parser classified only `true` → **auto-allowed**, while the shell
  runs `echo MARKER`.

This hole was introduced by the first fix and found by an adversarial review of that fix before the
phase ended; the branch now uses the shell's separators.

### 6. ANSI-C quoting was not implemented, and silently mis-tokenised

`$'…'` (ANSI-C quoting) and `$"…"` (locale quoting) are not part of the tokenizer's state machine,
so their word boundaries can differ from the shell's. The old code turned `echo $'a'` into the word
`$a` and had no rule that made the difference visible.

## Change

| Path | Rationale |
| --- | --- |
| `packages/permitter/lib/command-parser.js` | The parser itself: add a `#`-comment branch that ends at the newline and only starts at a shell word boundary, refuse unterminated quotes, parse the `env` wrapper options, refuse assignments to variables that change how the command is resolved or parsed (also inside a skipped command), and refuse ANSI-C quoting. |
| `packages/permitter/tests/security.test.js` | Pull in the failing-first regression tests written by the previous worker (unchanged) and add two table-driven blocks that pin the comment scope to one line and the shell semantics of comments, assignments and quoting. |
| `packages/permitter/CHANGELOG.md` | Project convention for permitter security fixes (see `f0c8abfc`): record the behaviour change under `## [Unreleased]` → `### Security`. |

### `packages/permitter/lib/command-parser.js`

1. **`const DANGEROUS_ASSIGNMENT_VARS = new Set(['PATH', 'IFS', 'BASH_ENV', 'ENV'])`** (line 26) plus
   `isDangerousAssignmentVar()` (line 402), `assertSafeAssignmentVar()` (line 414) and
   `assertSafeAssignment()` (line 426). A variable is dangerous when it is `PATH`, `IFS`,
   `BASH_ENV` or `ENV`, or its name starts with `LD_` (loader injection) or `DYLD_` (macOS loader
   injection). `BASH_ENV` and `ENV` were added because a shell sources them before it runs anything,
   so `BASH_ENV=/tmp/evil bash -c "ls"` executed an attacker-controlled file.
   `assertSafeAssignmentVar()` throws `Dangerous variable assignment not supported: <VAR>`.

2. **`checkQuoteBalance(command)`** (line 56) — a quote-aware scan (NORMAL / SINGLE_QUOTE /
   DOUBLE_QUOTE, `\` escapes honoured outside single quotes) that throws
   `Unbalanced quote not supported` when a quote is left open. Quote characters inside a comment are
   counted as well, because a stray apostrophe in a comment is exactly the shape that hides the tail
   from the parser. It is called from `parseCommand()` (line 632) and from the `bash -c` /
   `sh -c` inner-command branch of `normalizeSegment()` (line 448), because the inner command is
   parsed on its own. It is deliberately **not** called from `tokenize()`: the pre-existing test
   `should handle unclosed double quote (tokenize does not throw)` requires `tokenize()` to return
   malformed tokens rather than throw.
   Because a quote inside a comment is counted, `git status # don't run rm -rf /` is now
   **refused** — the hook asks the user instead of printing an allow decision. Bash would treat
   the whole tail as a comment and run only `git status`, so the parser is *stricter* than the
   shell here; the refusal is required by the pre-written test `comment apostrophe hides tail`,
   which pins that this shape must not be auto-allowed. See Follow-ups 6.

3. **`tokenize()` comment branch** (line 147) — a `#` that begins a word starts a comment that runs
   **to the end of that line**. The newline is left in place so it still separates commands: a later
   line is never swallowed by a comment. A `#` inside a word (`echo path/to/file#anchor`) is still a
   literal. The word-boundary test uses the **shell's** separators (space, tab, newline) plus the
   command separators `;`, `&`, `|`, not JavaScript's wider `\s`: a `#` after a non-breaking space,
   a vertical tab, a form feed or a carriage return is an ordinary argument, so the rest of the line
   stays a separate command.

4. **`normalizeSegment()` assignment stripping** — every leading assignment is now checked with
   `assertSafeAssignment()` before it is stripped, so `PATH=/evil git status` and `IFS=$x git status`
   are refused instead of being dropped. Non-dangerous assignments (`NODE_ENV=production npm test`)
   are still stripped as before.

5. **`normalizeSegment()` `env` branch** — rewritten as an explicit option loop. It accepts only the
   forms whose effect is understood: `VAR=value` assignments (checked as above), `-i`, and `-u NAME`
   (the name must be a valid identifier and must not be a dangerous variable). Every other option
   (`-C`, `--chdir`, `-S`, `--split-string`, `-0`, `-v`, `--unset=…`, `--`, …) throws
   `env option not supported: <opt>`, so the parser refuses instead of guessing which program would
   run.

6. **`module.exports`** now also exports `checkQuoteBalance` and `DANGEROUS_ASSIGNMENT_VARS`.

7. **`assertSafeSkipCommand(tokens)`** (new, next to `assertSafeAssignment()`) — called from
   `normalizeSegment()` before a skipped command (`export`, `set`, `unset`, `local`, `declare`,
   `typeset`) is skipped. Every assignment in the segment is checked with `assertSafeAssignment()`,
   and for `unset` every variable name in the segment is checked with `assertSafeAssignmentVar()`.
   `export PATH=/tmp/evil; git status` and `unset PATH; git status` are therefore refused, while
   `export FOO=bar; git status` is still allowed and still skipped.

8. **ANSI-C quoting refused** — `tokenize()` throws `ANSI-C quoting not supported` when it meets
   `$'` or `$"` in the NORMAL state. The tokenizer does not implement those quoting forms, so their
   word boundaries can differ from the shell's; refusing them removes the class of risk instead of
   relying on the quote-balance scan to happen to notice it.

Every new failure path **throws**, which is the parser's existing "unsafe / needs the user" result:
`packages/permitter/hooks/permitter.js` catches the parse error and falls back to the normal
permission dialog instead of printing an allow decision. The hook's output format is unchanged.

Note on error wording: the pre-existing fuzz tests in `tests/security.test.js` only tolerate thrown
errors whose message contains `not supported`, `Heredocs`, `Command substitution` or
`Process substitution`. All new messages therefore contain `not supported`.

### `packages/permitter/tests/security.test.js`

* Pulled in **unchanged** from `foreman/ensemble-pdf-f6b2-permitter-tokenizer-wrappers/run-2ac60bb430d56c4517687571cc857104`
  (`git fetch origin …; git checkout FETCH_HEAD -- packages/permitter/tests/security.test.js`):
  the `Security: comment and wrapper hardening (pdf-f6b2)` block (28 not-allowed cases, an
  allow-path block of 17 safe commands, and 3 explicit assertions).
* **Added** `Security: comment scope (pdf-f6b2)` — a table-driven block that pins the comment scope
  to a single line (4 tests): a comment must not hide the next line, every line must still be
  classified separately, and a comment ends at the newline.
* **Added** `Security: shell semantics hardening (pdf-f6b2)` — a table-driven block (20 tests) that
  pins the shell semantics found by the adversarial review: a `#` only starts a comment after a
  character the shell treats as a word separator (4 cases), an assignment inside a skipped command
  changes the environment of the commands that follow it (10 cases), a harmless `export` stays
  allowed (1 case), `BASH_ENV` / `ENV` assignments are refused (2 cases) and ANSI-C quoting is
  refused (3 cases).

## Tests

### Failing-first evidence (red on the old code)

The parser was temporarily reverted to the base-commit version (`git show HEAD:packages/permitter/lib/command-parser.js`)
with the final test file in place:

```
cd packages/permitter && npx jest tests/security.test.js
→ Test Suites: 1 failed, 1 total
  Tests:       33 failed, 186 passed, 219 total
```

The 33 failures are the 32 pre-written cases plus one new case (`a comment ends at the newline, not
at the end of command`). Failure names (abridged):

```
Security: comment and wrapper hardening (pdf-f6b2) › Parser must not allow (throw or classify honestly) ›
  not auto-allowed: comment apostrophe hides tail
  not auto-allowed: comment unbalanced quote
  not auto-allowed: PATH=/evil prefix
  not auto-allowed: PATH quoted value
  not auto-allowed: PATH split-brain
  not auto-allowed: PATH split quoted value
  not auto-allowed: PATH second assignment
  not auto-allowed: PATH via env wrapper
  not auto-allowed: IFS
  not auto-allowed: IFS prefix
  not auto-allowed: IFS split-brain quoted prefix
  not auto-allowed: IFS split-brain via env
  not auto-allowed: LD_PRELOAD
  not auto-allowed: LD_PRELOAD=/evil.so prefix
  not auto-allowed: LD_LIBRARY_PATH
  not auto-allowed: DYLD_* other prefix
  not auto-allowed: DYLD_INSERT_LIBRARIES prefix
  not auto-allowed: env -C with equals form
  not auto-allowed: env -S splits a string
  not auto-allowed: env -0 NUL delimited
  not auto-allowed: env -v verbose runs
  not auto-allowed: trailing unmatched single quote
  comment/quote case yields parse error or an executable not git: comment apostrophe
  comment/quote case yields parse error or an executable not git: trailing unmatched quote
Security: comment and wrapper hardening (pdf-f6b2) › Allow path stays useful ›
  dangerous assignment reported, not silently dropped
  unparseable env option reported, not silently dropped
  still auto-allowed: env -u LC_ALL FOO='bar baz' npm test
Security: comment wrapper hardening (pdf-f6b2) › Allow path stays useful ›
  comment truncated end line only
Security: comment scope (pdf-f6b2) › comment ends newline, not at end command
```

Earlier baseline, before the tests were pulled in (whole package, original parser):
`npx jest` → `Test Suites: 1 failed, 6 passed, 7 total; Tests: 32 failed, 573 passed, 605 total`.

### Failing-first evidence for the shell-semantics hardening (adversarial review round 2)

The review of the first fix found four more ways the parser could still approve a command that hides
a part of itself. The new block `Security: shell semantics hardening (pdf-f6b2)` was written first
and run against the **already-staged** parser (the "old code" for these defects, log
`~/.omp/perm-f6b2/red-round2.txt`):

```
cd packages/permitter && npx jest tests/security.test.js
→ Test Suites: 1 failed, 1 total
  Tests:       18 failed, 221 passed, 239 total
```

The 18 red cases:

```
a # after a non-breaking space does not start a comment
a # after a vertical tab does not start a comment
a # after a form feed does not start a comment
a # after a carriage return does not start a comment
export PATH must not be allowed through
export LD_PRELOAD must not be allowed through
export DYLD_INSERT_LIBRARIES must not be allowed through
export IFS must not be allowed through
declare PATH must not be allowed through
typeset IFS must not be allowed through
set PATH must not be allowed through
local PATH must not be allowed through
unset PATH must not be allowed through
unset IFS must not be allowed through
BASH_ENV assignment must not be allowed through
ENV assignment must not be allowed through
ANSI-C quoting $'...' is refused
ANSI-C quoting $"..." is refused
```

The two regression guards in the same block (`a harmless export is still allowed`, `ANSI-C quoting
does not hide the rest of the line`) were green before and after the fix.

### Failing-first evidence for the comment-scope hazard

The task warned that the previous worker's partial change used `break` in the `#` branch, which
discards **every** later line of the command. To prove the new branch does not reproduce that
hazard, the comment skip was temporarily mutated to swallow the rest of the whole command:

```
# HAZARD MUTATION: while (i < command.length) { i++; }   (instead of stopping at '\n')
cd packages/permitter && npx jest tests/security.test.js -t "comment scope"
→ Test Suites: 1 failed, 1 total
  Tests:       3 failed, 215 skipped, 1 passed, 219 total

  ● Security: comment scope (pdf-f6b2) › every line is still classified separately
    - Expected  - 1
    + Received  + 0
      Array [
        "git",
    -   "rm",
      ]
```

The mutation was reverted immediately afterwards (verified by re-running the suite green).

### Passing-after (green on the fix)

```
cd packages/permitter && npx jest tests/security.test.js
→ Test Suites: 1 passed, 1 total
  Tests:       239 passed, 239 total

cd packages/permitter && npx jest
→ Test Suites: 7 passed, 7 total
  Tests:       629 passed, 629 total
```

The pre-existing suites (`command-parser.test.js`, `integration.test.js`, `matcher.test.js`,
`allowlist-loader.test.js`, `docker-compose-command.test.js`, `performance.test.js`) and the
pre-existing `security.test.js` blocks all stay green. **No existing test was deleted, skipped,
weakened or loosened** — the pulled-in block is byte-identical to the previous worker's version.

Allow-path regression coverage (the hook must stay useful) is asserted by the pulled-in block and
passes: `git status`, `ls -la`, `npm test`, `npm run build`, `echo hello`, `npm test # verify`,
`npm test # commit message: fix it`, `echo 'a; b # c'`, `echo "a # b"`, `echo path/to/file#anchor`,
`NODE_ENV=production npm test`, `FOO=bar BAZ=qux npm test`, `env FOO=bar npm test`,
`env -u SOME_VAR npm test`, `env -i npm test`, `env -u LC_ALL FOO='bar baz' npm test`,
`timeout 30 npm test`, `nohup npm test`.

## Local verification

| Command | Result |
| --- | --- |
| `cd packages/permitter && npx jest tests/security.test.js` (original parser, final tests) | **red** — 33 failed, 186 passed, 219 total |
| `cd packages/permitter && npx jest tests/security.test.js` (fixed parser) | **green** — 239 passed, 239 total |
| `cd packages/permitter && npx jest` (fixed parser) | **green** — 7 suites, 629 passed, 629 total |
| `cd packages/permitter && npx jest` × 3 more runs | **green** — 609 passed each time (run before the round-2 hardening) |
| `cd packages/permitter && npx jest tests/security.test.js` (round-2 parser, final tests) | **red** — 18 failed, 221 passed, 239 total |
| `cd packages/permitter && npx jest tests/performance.test.js` × 5 | **green** — 19 passed each time |
| `cd packages/permitter && npx jest` (hazard mutation of the comment branch) | **red** — 3 failed (evidence above), mutation reverted |
| `npm run generate:validate; echo EXIT=$?` (repo root) | `EXIT=0` — `✓ Validation passed (64 files)`, `✓ packages/development/lib/run-index/ matches a fresh build` |
| `npm run validate; echo EXIT=$?` (repo root) | `EXIT=0` — `✓ All plugins validated successfully`, `✓ All release versions in sync: 10.0.0`, `✓ 186 prompt file(s) within word budgets` |
| `npx eslint packages/permitter/lib/command-parser.js packages/permitter/tests/security.test.js` (repo root) | 0 errors, 2 warnings — one is pre-existing (`'allowlist' assigned value but never used` at `tests/security.test.js:777`, in a pre-existing test, untouched) and one is `command-parser.js` being inside the eslint ignore list. `packages/permitter` has no `lint` script of its own. |
| `npm run generate` / `npm run generate:pi` | **Not run** — no generated source was changed (the permitter parser is not mirrored into `packages/pi`/`packages/full`; `packages/full/lib/command-parser.js` is a symlink to the edited file). `npm run generate:validate` confirms the generated tree is still in sync (`EXIT=0`). |
| Micro-benchmark of the added quote scan (scratch script, `~/.omp/perm-f6b2/perf-compare.js`) | `parseCommand` on 4 simple commands: p50 0.0024 ms → 0.0025 ms; long command: p50 0.0155 ms → 0.0163 ms (thresholds in `performance.test.js` are 5 ms / 20 ms) |
| Adversarial probe of the comment scope (scratch script, `~/.omp/perm-f6b2/probe2.js`) | `git status\ #; rm -rf /` → two segments `[git status #]`, `[rm -rf /]` (the escaped space means the `#` is not a comment, so the `rm` stays classified); `git commit -m "a #b"; rm x` and `git commit -m 'a #b'; rm x` → two segments (`#` literal inside quotes); `git status # note \` + newline + `rm -rf /` → two segments (the `rm` is classified and refused); `env LD_PRELOAD=x git status` and `FOO=1 env LD_PRELOAD=x git status` → throw `Dangerous variable assignment not supported: LD_PRELOAD`; `bash -c 'PATH=/evil git status'` → throw `Dangerous variable assignment not supported: PATH`; `env -uNAME`, `env --unset NAME`, `env -iu`, `env -` → throw `env option not supported: …`; `zsh -c "git status"` → `executable: 'zsh'` (refused by the allowlist) |
| `foreman_inbox_send` (phase-completion progress note) | sent OK |
| `foreman_task_add_comment` (task Work Log comment) | **failed** — server error `Task external_id is malformed` (the task record's `external_id` is null). The phase-completion progress note carries the same summary, so the work log is not lost. |
| Final re-run after the report amendments (code unchanged) | `npm run generate:validate; echo EXIT=$?` → `EXIT=0`; `npm run validate; echo EXIT=$?` → `EXIT=0`; `cd packages/permitter && npx jest tests/security.test.js` → `219 passed, 219 total`; `cd packages/permitter && npx jest` → `7 suites, 609 passed, 609 total`; `npx markdownlint <report> packages/permitter/CHANGELOG.md` → exit 0; `npx eslint <changed files>` → 0 errors, 2 warnings (both pre-existing: one `command-parser.js` ignore-pattern warning, one unused `allowlist` in a pre-existing test at `tests/security.test.js:777`) |
| Final re-run after the round-2 hardening (code unchanged since the run below) | `npm run generate:validate; echo EXIT=$?` → `EXIT=0`; `npm run validate; echo EXIT=$?` → `EXIT=0`; `cd packages/permitter && npx jest tests/security.test.js` → `239 passed, 239 total`; `cd packages/permitter && npx jest` → `7 suites, 629 passed, 629 total`; `npx eslint packages/permitter/lib/command-parser.js packages/permitter/tests/security.test.js` → 0 errors, 2 warnings (both pre-existing: the `command-parser.js` ignore-pattern warning and the unused `allowlist` in the pre-existing test at `tests/security.test.js:777`); `npx markdownlint <report> packages/permitter/CHANGELOG.md` → exit 0 |
| Bash-parity fuzz of the `#` rule (scratch script, `~/.omp/perm-f6b2/fuzz-comment.js`) | 36 generated commands (space, tab, newline, CR, VT, FF, NBSP, U+2028, `;`, `|`, `&`, no separator before the `#`) executed with real `bash -c` and compared with the parser: `checked=36 hidden=0` — every command bash ran is still classified by the parser. |
| Bash-parity fuzz of quoting and wrappers (scratch script, `~/.omp/perm-f6b2/fuzz-bash.js`) | 120 generated commands mixing `$'…'`, quotes, escapes, `;`, `&&`, `|` and comments executed with real `bash -c` and compared with the parser: `checked=120 bypasses=0` — no command that bash ran is hidden from the parser (the parser refuses the ANSI-C forms outright). |

One earlier full-package run reported `Tests: 1 failed, 608 passed, 609 total` while the machine was
busy; the failing test name was not captured (the output was tail-truncated). Five subsequent full
runs (609/609) and five isolated `performance.test.js` runs (19/19) were green, and the two timing
sensitive assertions in `performance.test.js` (`p50 < 0.5 ms` for `matchesPattern` and
`checkUnsafe`) are in code paths this change does not touch. Treated as the documented
wall-clock-timing flake, not a regression.

## Follow-ups

Intentionally left undone, all conservative (refuse, not allow) decisions:

1. **`env -u PATH` / `env -u LD_PRELOAD` are refused.** Unsetting is treated like assigning because
   removing `PATH` from the child's environment changes executable resolution the same way. If the
   product wants `env -u <var>` for non-dangerous variables only, this is the place to relax it.
2. **`env -i` (ignore environment) is allowed.** It is required to stay allowed by the pulled-in
   allow-path test, but it clears the environment (including `PATH`) for the child. `env -i` cannot
   redirect a hostile `PATH`, since the hostile value is gone with the rest of the environment, but
   it does change resolution to the system default path.
3. **Wrapper options other than `env`'s `-i`/`-u` are refused**, e.g. `timeout -k`, `nice -n`,
   `nohup` options are stripped as before, but `sudo`/`command` are not wrappers in this parser:
   `sudo git status` classifies as `executable: 'sudo'` and is refused unless the user explicitly
   allowlists `Bash(sudo:*)`. An allowlist entry for `sudo` therefore allows any `sudo` command —
   that is pre-existing allowlist semantics, not something the parser hides.
4. **`IFS` is treated as dangerous in every position.** `IFS=… cmd` is refused even though `IFS` is
   only consulted by the shell for word splitting of *its own* expansion; the parser cannot prove the
   effect is harmless, so it refuses.
5. **The `bash -c "…"` inner command is quote-checked separately**, which means `bash -c "npm test"`
   still parses, but an inner command with an unbalanced quote is refused.
6. **A comment that contains an apostrophe now asks the user.** `git status # don't run rm -rf /`
   is refused (`Unbalanced quote not supported`) because the apostrophe in the comment is counted
   as an opening quote. Bash would run only `git status` there, so this is a usability regression
   on an otherwise harmless command — accepted because the pre-written test `comment apostrophe
   hides tail` requires this shape not to be auto-allowed, and because the failure direction is
   refuse, not allow. Making the parser ignore comment text entirely (as bash does) would need an
   explicit product decision, because it re-opens the shape that test pins down.
7. **A backslash-newline inside a comment ends the comment in the parser, but not necessarily in
   bash.** `git status # note \` + newline + `rm -rf /` is classified as two commands by the
   parser (the `rm` is classified and refused), whereas bash processes the line continuation
   before removing the comment and would treat `rm -rf /` as comment text. The parser is stricter
   here (it refuses something bash allows); the opposite divergence — a comment hiding a command
   that bash would run — is impossible, because the comment never swallows the newline.
   Not verified empirically in this phase: the claim above is from reading bash's documented
   order of operations, not from an executed comparison.
8. **Assignments to variables outside the named danger list can still change how the program
   behaves.** The task named `PATH`, `LD_*`, `DYLD_*` and `IFS`; `BASH_ENV` and `ENV` were added
   on top of that list because a shell sources them before it runs anything. Still stripped and
   invisible to the parser: `GIT_SSH_COMMAND=…`, `GIT_EXTERNAL_DIFF=…`, `GIT_PAGER=…`, `PAGER=…`,
   `EDITOR=…`, `GIT_CONFIG_*`, `SHELLOPTS=…`, `NODE_OPTIONS=…`, `PYTHONPATH=…`, `PERL5OPT=…` and
   `git -c core.pager=…` / `git -c alias.…=…`. Closing that properly wants an *allowlist* of
   assignment names that cannot change resolution or execution (`NODE_ENV`, `FOO`, …) rather than
   a growing denylist — out of scope for this phase, recorded here.
9. **Pre-existing classification quirk (not introduced here).** A quoted argument followed by `;`
   leaves an empty first token in the next segment: `git commit -m "ab"; rm x` classifies as
   `[{executable:'git',…},{executable:'',args:'rm x'}]` — identical on the base commit, so it is
   not caused by this change. `packages/permitter/lib/matcher.js` then builds the match string as
   `" rm x"` (leading space), and an allowlist entry with an empty prefix (`Bash(:*)`) matches it
   (`' rm x'.startsWith(' ')`), so such an entry would allow that segment; ordinary entries
   (`Bash(git:*)`, `Bash(rm:*)`) do not match. Left untouched here — reported for a separate fix.
10. **ANSI-C quoting (`$'…'`) and locale quoting (`$"…"` ) are refused outright.** The tokenizer
    does not implement them, so refusing them removes the risk of a word-boundary divergence
    between the parser and the shell. The cost is a usability regression on a harmless but not
    rare idiom (`printf $'a\tb'` now asks the user). A bash-parity fuzz of 120 generated commands
    found no command that bash ran and the parser hid, so this is defence in depth rather than a
    fix for a proven bypass; it was still taken because the task asks for the conservative
    direction whenever a shape cannot be parsed safely.
11. **A `#` only starts a comment after a shell word separator.** Characters the shell does not
    treat as separators (non-breaking space, vertical tab, form feed, carriage return, U+2028) are
    part of the word, so the `#` stays an ordinary argument. This is the opposite direction of the
    JavaScript `\s` rule that the first version of the branch used, and it is the direction that
    matches the shell: the parser may now classify a command as separate that bash would join into
    one word. That is the safe direction — an over-classified command is checked against the
    allowlist, a hidden one is not checked at all.
12. **`unset` of a dangerous variable is refused, `unset` of any other variable is allowed.**
    `unset PATH` changes executable resolution for the rest of the line exactly like
    `PATH=/evil`, so it is refused; `unset FOO` is skipped as before.

## Assumptions

* "Assignments that change PATH, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_* or IFS must not be allowed
  through" is read as covering the whole `LD_*` and `DYLD_*` **prefixes** (e.g. `LD_AUDIT`,
  `DYLD_LIBRARY_PATH`), not only the two names spelled out. This matches the pre-written test cases
  (`DYLD_* other prefix`, `IFS prefix`).
* A `#` "that begins a word" is a `#` at the start of the command or directly after a character the
  **shell** treats as a word separator (space, tab, newline) or a command separator (`;`, `&`, `|`).
  A `#` inside a word (`file#anchor`) stays literal, matching shell behaviour and the pre-written
  allow-path case. JavaScript's wider `\s` is deliberately not used: the shell does not treat a
  non-breaking space, vertical tab, form feed or carriage return as a separator, so a `#` after one
  of those is an ordinary argument and the rest of the line must stay a separate command.
* The comment ends at the newline; the newline remains a command separator so a later line is still
  classified (this is the specific hazard the task called out).
* "Refuse" means throwing from the parser, which is the parser's existing "unsafe / needs the user"
  outcome: the hook then falls back to the normal permission dialog. The hook's output format and
  `hooks.json` were not changed.
* An assignment inside a skipped command (`export`, `set`, `unset`, `local`, `declare`, `typeset`)
  is treated like an assignment in front of the program: it changes the environment of the
  commands that follow it on the same line, so a dangerous variable is refused. `export FOO=bar`
  stays allowed and stays skipped.
* `BASH_ENV` and `ENV` were added to the dangerous-variable list even though the task did not name
  them, because a shell sources them before it runs anything
  (`BASH_ENV=/tmp/evil bash -c "ls"`).
* ANSI-C quoting (`$'…'`) and locale quoting (`$"…"`) are refused rather than parsed, because the
  tokenizer does not implement them and their word boundaries can differ from the shell's.
* No design decision was deferred to the operator: every case that could not be parsed safely was
  resolved by refusing, as the task instructed.

## PR body

### Summary

Hardens the permitter's shell parser so a command that hides part of itself can never produce an
allow decision.

* `tokenize()` now understands a `#` that begins a word as a comment that runs to the **end of that
  line**; the newline stays a command separator, so a later line is still classified and never
  swallowed by a comment.
* A command with an unbalanced quote is refused (`Unbalanced quote not supported`) instead of being
  classified from a guess — `git status # don't run rm -rf /` previously matched `Bash(git:*)` and was
  auto-allowed. That shape now reaches the normal permission dialog (the hook asks the user), which
  is stricter than bash, where the comment would hide the tail; see the report's Follow-ups.
* The `env` wrapper's options are parsed explicitly: only `VAR=value`, `-i` and `-u NAME` are
  understood; everything else (`-C`, `-S`, `-0`, `-v`, `--unset=…`, `--`) is refused, so
  `env -C /tmp git status` (executable was mis-identified as `/tmp`) can no longer reach the
  allowlist.
* Leading `VAR=value` assignments are no longer silently dropped: assignments to `PATH`, `IFS`,
  `LD_*`, `DYLD_*`, `BASH_ENV` or `ENV` are refused instead of the program being classified as if
  the assignment were absent.
* The same rule now applies inside a skipped command: `export PATH=/tmp/evil; git status`,
  `declare IFS=$x; git status` and `unset PATH; git status` are refused, while
  `export FOO=bar; git status` stays allowed.
* A `#` only starts a comment after a character the shell treats as a word separator (space, tab,
  newline) or a command separator, so a `#` after a non-breaking space, vertical tab, form feed or
  carriage return no longer hides the rest of the line.
* ANSI-C quoting (`$'…'`) and locale quoting (`$"…"`) are not implemented by the tokenizer, so a
  command that uses them is refused instead of being classified from a guess.

Changes are confined to `packages/permitter/lib/command-parser.js` (the source;
`packages/full/lib/command-parser.js` is a symlink to it), the permitter tests and the permitter
CHANGELOG. The hook entrypoint, `hooks.json` and the hook's output format are unchanged — the
parser keeps using the existing "throw ⇒ ask the user" path.

### Testing

* Failing-first: with the parser reverted to the base-commit version, the pulled-in regression tests
  plus the new comment-scope block fail — `npx jest tests/security.test.js` → **33 failed, 186
  passed, 219 total**. The second hardening round was proven the same way against the already-staged
  parser: **18 failed, 221 passed, 239 total**.
* After the fix: `npx jest tests/security.test.js` → **239 passed**; full package
  `npx jest` → **7 suites, 629 passed, 629 total** (earlier rounds: 5 consecutive clean runs at
  609/609).
* The comment-scope hazard was proven separately: mutating the comment branch to swallow the rest of
  the command turns the new tests red (3 failed), and the mutation was reverted.
* Bash-parity fuzzing (scratch scripts under `~/.omp/perm-f6b2/`) compared the parser with real
  `bash -c` for 36 comment-boundary and 120 quoting/wrapper commands: **0 commands that bash ran
  were hidden from the parser**.
* `npm run generate:validate` → `EXIT=0`; `npm run validate` → `EXIT=0`;
  `npx eslint` on the changed files → 0 errors (2 pre-existing warnings).

### Risk

Low-to-moderate, and it fails closed. The parser now refuses a few command shapes it previously
classified: commands with an unbalanced quote (including a comment that contains an apostrophe,
e.g. `git status # don't run rm -rf /`, which bash would run as `git status` only — see
Follow-ups 6), `env` options other than `-i`/`-u`, assignments to
`PATH`/`IFS`/`LD_*`/`DYLD_*`/`BASH_ENV`/`ENV` (also inside `export`/`set`/`unset`/`local`/`declare`/
`typeset`), `unset PATH`, and ANSI-C quoting (`$'…'`). Those commands now reach the normal permission
dialog instead of being auto-allowed. Safe commands (`git status`, `ls -la`, `npm test`, `npm run
build`, `env FOO=bar npm test`, `env -u SOME_VAR npm test`, `timeout 30 npm test`, `nohup npm test`,
`NODE_ENV=production npm test`, `export FOO=bar; git status`) are still auto-allowed and are covered
by regression tests. The added quote scan changes the
`parseCommand` p50 from 0.0024 ms to 0.0025 ms for four simple commands (long command: 0.0155 ms
→ 0.0163 ms), far inside the thresholds in `performance.test.js` (5 ms / 20 ms).

### How to revert

Revert this commit. The change is confined to `packages/permitter/lib/command-parser.js`,
`packages/permitter/tests/security.test.js` and `packages/permitter/CHANGELOG.md`; no schema,
config, hook or generated artifact changes are involved, so reverting restores the previous parser
behaviour exactly.

### Directed by

Directed by: @ldangelo
