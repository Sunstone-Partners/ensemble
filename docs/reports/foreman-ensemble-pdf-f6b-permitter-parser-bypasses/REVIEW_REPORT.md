# Repo-Rules Review Report — `ensemble-pdf-f6b-permitter-parser-bypasses`

Phase 3 (`repo-rules-review`) of Foreman run `run-aa020bc8812936558da29ea2cc0eda37`,
project `ensemble`, workflow `fix`.

## Review engine

- Reviewer: this `repo-rules-review` phase agent (no external CLI). It reviewed
  this run's own diff against the repository's written conventions.
- Rules applied: the repository-root `AGENTS.md` (also present: `CLAUDE.md`,
  `CONTRIBUTING.md`), plus the established patterns of the files the diff touches.
- Diff range reviewed: `git diff dev...HEAD` — i.e. `dev`
  (`$FOREMAN_BASE_BRANCH` = `dev`, confirmed non-empty) to `HEAD`
  (`065f9c48` "Foreman run ensemble-pdf-f6b-permitter-parser-bypasses phase 2",
  with parent `cb3fce63` "… phase 1") on branch
  `foreman/ensemble-pdf-f6b-permitter-parser-bypasses/run-aa020bc8812936558da29ea2cc0eda37`.
- **What the diff contains: two files, both without content.**
  `git diff dev...HEAD --stat` reports 3 insertions total, all of them blank
  lines, in `docs/reports/foreman-ensemble-pdf-f6b-permitter-parser-bypasses/FIX_REPORT.md`
  (2 bytes: two newline characters) and
  `docs/reports/foreman-ensemble-pdf-f6b-permitter-parser-bypasses/REVIEW_CODERABBIT_REPORT.md`
  (1 byte: one newline). `git diff dev...HEAD --name-only` lists nothing else, and
  the working tree is clean (`git status --porcelain` empty).
- **Therefore the review found ZERO repository-rule violations inside the diff
  itself** — a two-line-blank diff breaks no formatting, error-handling,
  generated-mirror, documentation-sync or commit-convention rule. That is not a
  clean bill of health for the run. The report-only diff means the task's
  security work is not in this branch at all, which is reported as unresolved
  findings below rather than hidden behind a passing review.
- Previous phase's report: `REVIEW_CODERABBIT_REPORT.md` **exists but is not
  usable** — it contains a single newline and no `FOREMAN_REVIEW_FINDINGS_START` /
  `FOREMAN_REVIEW_FINDINGS_END` markers, so the CodeRabbit phase emitted no
  findings to carry forward and (as far as the artifact shows) no review output
  at all. Nothing was copied forward from it for that reason.
- I cannot tell from the tree whether phases 1 and 2 crashed or exited
  successfully without doing the work; I did not investigate Foreman runtime
  state, and I am not guessing.

## Findings

Findings received: 0 from the previous phase (its artifact has no findings
block), and 0 conventional rule violations within the diff (it changes no code).
Triage of what the diff's emptiness implies produced 8 unresolved findings, all
of which describe work that is **absent** rather than code that is wrong, so
none was fixable by the narrowest-fix rule of this phase. They are listed under
Declined/Unresolved with verified anchors and current line numbers.

## Fixed

None. No source file was changed in this phase, so there is nothing to report as
fixed and nothing new to re-check in the diff.

Deliberate decision, with rationale: the missing work is a security-sensitive
change to a shared permission-boundary parser that the task explicitly requires
to land with failing-first tests (red on old code, green on fix), a per-case
behaviour contract, the source-vs-mirror and `npm run generate` /
`npm run generate:pi` steps, and a full `FIX_REPORT.md` including a PR body.
Implementing all six cases inside a rules-review pass would skip exactly the
verification this run is supposed to apply, and would have this phase reviewing
its own code. The phase contract is "fix what a rules review legitimately
finds"; "the entire task is missing" is not a finding with a narrow fix — it
belongs to a Fix run. Recorded instead as a Critical unresolved finding.

## Declined (unresolved — a human still needs to act)

Anchors below are the real, verified lines of the file on this branch
(`git diff dev -- packages/permitter/lib/command-parser.js` is empty, and the
tree is clean, so this file is identical to `dev` at the reviewed SHA).
`packages/full/lib/command-parser.js` is a git symlink mode `120000` →
`../../permitter/lib/command-parser.js`, so `packages/permitter/lib/command-parser.js`
is the only source; a fix there reaches the `full` package automatically and no
generated-file regeneration is involved.

1. **No code and no tests in this run — the PR must not be merged as a fix.**
   `packages/permitter/lib/command-parser.js:1` (whole file, unchanged vs `dev`)
   — Critical. The branch diff contains zero code and zero test changes for a
   security task whose entire point is that the permitter must stop printing an
   allow decision for six classes of command. A PR opened from this branch would
   advertise a security fix it does not contain. Needs a fresh Fix run.
2. **`FIX_REPORT.md` is empty, violating the run's own reporting requirement.**
   `docs/reports/foreman-ensemble-pdf-f6b-permitter-parser-bypasses/FIX_REPORT.md:1`
   — Major. The task required a non-empty report with Root cause, Change, Tests
   (failing-first evidence), Local verification, Follow-ups, Assumptions and a
   `## PR body`. It is two blank lines. I did not fill it in: writing the Fix
   phase's report here would invent verification history that did not happen.
3. **Comment tokenization: a raw `#` is not a comment, so it reaches the matcher
   as an ordinary character.** `packages/permitter/lib/command-parser.js:63`
   (the `case State.SINGLE_QUOTE:` branch; the `State.NORMAL` switch at
   `:62-196` has no `#` branch). Verified by execution:
   `parseCommand("git status # don't run rm -rf /")` returns
   `[{executable:'git', args:"status # dont run rm -rf /"}]`. Note this refines
   the task's claim: the parser does **not** silently drop the tail here — the
   apostrophe is consumed as part of the token and `# dont run rm -rf /` is
   visible as args, so whether an allow is printed for this input depends on
   `matchesPattern` in `packages/permitter/lib/command-matcher.js`, which this
   phase did not audit. The unconditional shell rule that unquoted `#` starts a
   comment is still unimplemented, and the apostrophe is lost from the token, so
   the classification is not faithful to the real command either way.
4. **Wrapper options and assignments are dropped without constraint.**
   `packages/permitter/lib/command-parser.js:364` (the leading
   `isEnvAssignment` shift loop) and `:388` (`else if (wrapper === 'env')` with
   its flag loop at `:395-404`). Verified: `parseCommand("env -C /tmp git status")`
   → `[{executable:'/tmp', args:'git status'}]` (the classifier treats `/tmp` — a
   directory operand of `env -C` — as the program name), and
   `parseCommand("PATH=/evil git status")` → `[{executable:'git', …}]`, i.e. a
   `PATH`/`LD_PRELOAD` assignment is silently discarded and the command is
   classified as if it were absent. Still open.
5. **`checkUnsafe` has no pattern for `${…}` expansion or ANSI-C `$'…'` quoting.**
   `packages/permitter/lib/command-parser.js:242-265` — the function tests only
   `/\$\(/`, /`` ` ``/, `/<</`, `/<\(/` and `/>\(/`. Verified:
   `parseCommand("echo ${HOME}")` → allowed with args `${HOME}`, and
   `parseCommand("echo $'foo bar'")` → allowed with args `$foo bar`.
   Two corrections to the task's premise: there is **no** `ANSI_C_QUOTING_RE`
   anywhere in `packages/` (grep across all non-node_modules JS returns nothing),
   and `$()` / backticks / `<<` / `<(`/`>(` **are** already covered — with
   quoted-instance coverage in `packages/permitter/tests/security.test.js:42-116`
   — so task case 3 is only half open.
6. **Variable-valued `IFS=` assignment is not recognized as an assignment, so it
   is not dropped *and* not treated as a separator.**
   `packages/permitter/lib/command-parser.js:332-341` (`isEnvAssignment`,
   `/^[A-Za-z_][A-Za-z0-9_]*=/`) — the function name is a misleading understatement
   of what it permits, and it accepts only a literal-name prefix followed by `=`,
   so `IFS=$'/\n'`-style values are neither stripped nor split on. Verified:
   `parseCommand("IFS=x; rm$IFS-y")` → `[{executable:'rm$IFS-y'}]`, and
   `parseCommand("git status; $IFS rm -rf /")` → `[{executable:'git',…},
   {executable:'$IFS', args:'rm -rf /'}]`. This differs from the task's
   description (it does **not** treat `IFS=` as a segment separator — only
   literal `;`, `&&`, `||`, `|`, `&`, `|&`, and newline are operators at `:24`),
   but the practical exposure is the same family: a segment containing a
   variable expansion is passed through as a single token instead of forcing a
   deny. Still open.
7. **The `bash -c` / `sh -c` sub-shell check normalizes only the first inner
   segment.** `packages/permitter/lib/command-parser.js:430-454` — the `bash -c`
   branch tokenizes the inner string, then explicitly `return
   normalizeSegment(innerSegments[0])` with the comment "If there are multiple
   commands in the inner shell, we need to return the first and the caller should
   handle the rest". Verified by reading: no caller in `parseCommand`
   (`:509-552`) re-inspects the inner string, so `sh -c "git status; rm -rf /"`
   can be judged on its first segment alone. Still open. (The task's case 6 as
   written — "`sh script.sh; rm -rf /`" — is actually safe already: a bare
   `sh script.sh` must match a `<sh> <subcommand>` pattern like any other
   executable, and `rm -rf /` is its own segment. The real defect is the
   `-c` inner string, which is the same underlying issue.)
8. **Task case 4 (redirect target containing a substitution) is already closed on
   this branch.** `packages/permitter/lib/command-parser.js:280-291`
   (`checkRedirections`: any redirect operator whose next token is not exactly
   `/dev/null` throws) and `:521` (`checkUnsafe` runs before tokenization).
   Verified: `parseCommand("cat < $(echo /etc/passwd)")` throws
   `Command substitution $() not supported`. Decline as already-fixed; the
   Follow-ups note below records the one remaining hole in that area.

## Verification

Commands actually run in this phase, with real exit codes (all in the run's own
worktree; no file was modified):

| Command | Exit | Result |
| --- | --- | --- |
| `echo "BASE=[$FOREMAN_BASE_BRANCH]"` | 0 | `BASE=[dev]` |
| `git rev-parse --abbrev-ref HEAD` | 0 | `foreman/ensemble-pdf-f6b-permitter-parser-bypasses/run-aa020bc8812936558da29ea2cc0eda37` |
| `git log --oneline dev..HEAD` | 0 | `065f9c48` phase 2, `cb3fce63` phase 1 |
| `git diff "$FOREMAN_BASE_BRANCH"...HEAD --stat` | 0 | 2 files changed, 3 insertions, both under `docs/reports/…` |
| `git diff "$FOREMAN_BASE_BRANCH"...HEAD --name-only` | 0 | the two report files only |
| `wc -c …/FIX_REPORT.md …/REVIEW_CODERABBIT_REPORT.md` | 0 | 2 and 1 bytes |
| `git diff dev...HEAD --name-only -- packages/permitter packages/full` | 0 | empty |
| `git ls-files -s …/command-parser.js …/full/lib/command-parser.js` | 0 | `100644` and `120000` (symlink) |
| `git diff dev -- packages/permitter/lib/command-parser.js packages/full/lib/command-parser.js` | 0 | empty (file identical to `dev`) |
| `git show dev:packages/full/lib/command-parser.js` | 0 | `../../permitter/lib/command-parser.js` |
| `git status --porcelain` | 0 | empty (clean tree) |
| `node -e` probe over 10 commands against `parseCommand` (tree clean ⇒ identical to `dev` content) | 0 | results quoted in findings 3-8 |
| `npx jest packages/permitter` | 0 | 7 suites / 553 tests passed, 1.064 s |
| `npm run validate; echo EXIT=$?` | 0 | `EXIT=0` (prompt-budget check: 0 violations) |

Because this phase changed no source files, no formatter, linter or narrower
jest run was required; the two runs above are baseline evidence that the branch
is green exactly as `dev` is green, which is itself part of the finding: nothing
was added to test.

`npm run generate:validate` was **not** run, since this phase touches neither a
generated source nor a generated mirror.

## Follow-ups (for the next Fix run, not acted on here)

- Implement the six required behaviours (cases 1, 2, 3-partial, 5, 6 as re-scoped
  above; case 4 already closed) table-driven in
  `packages/permitter/tests/security.test.js`, each red on `dev` first, plus the
  allow-path regressions for `git status`, `ls -la`, `npm test`.
- One gap the task did not name: `normalizeSegment` strips redirections and their
  targets at `:462-476` **after** `checkRedirections` has validated operators
  token-by-token at `:280-291`. A redirection whose operator carries an attached
  fd prefix (e.g. `3</some/path`) is a token whose first char is a digit, so
  `isRedirection` (`:343-346`) does not match it and `checkRedirections` does not
  treat it as an operator; `2<&0` is likewise accepted while `2<&3` throws. Worth
  a case in the same test table.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
- `packages/permitter/lib/command-parser.js:1` Critical — this run's diff contains no code and no tests, so the permitter parser hardening the task asked for is entirely absent; the PR must not be merged as a security fix and the task needs a fresh Fix run.
- `docs/reports/foreman-ensemble-pdf-f6b-permitter-parser-bypasses/FIX_REPORT.md:1` Major — the required Fix-phase report is two blank lines (no Root cause, no failing-first test evidence, no `## PR body`), and `REVIEW_CODERABBIT_REPORT.md:1` is one blank line with no findings markers, so neither phase produced usable output.
- `packages/permitter/lib/command-parser.js:63` Major — the tokenizer has no unquoted `#` comment branch, so `git status # don't run rm -rf /` classifies as `git` with args `status # dont run rm -rf /`, i.e. a shell comment is exposed to the matcher as arguments and the apostrophe is lost from the token.
- `packages/permitter/lib/command-parser.js:388` Critical — `env` wrapper options are stripped unconditionally, so `env -C /tmp git status` classifies the directory operand `/tmp` as the program name.
- `packages/permitter/lib/command-parser.js:364` Critical — leading `VAR=value` assignments are dropped with no allowlist of harmless variables, so `PATH=/evil git status` and `LD_PRELOAD=/evil.so git status` classify as plain `git status`.
- `packages/permitter/lib/command-parser.js:242` Critical — `checkUnsafe` has no pattern for `${ ... }` parameter expansion or ANSI-C `$'...'` quoting, so `echo ${HOME}` and `echo $'foo bar'` are allowed (`$()`, backticks, `<<`, `<(`, `>(` are already covered).
- `packages/permitter/lib/command-parser.js:332` Major — `isEnvAssignment` matches only a literal `NAME=` prefix, so a variable-valued assignment such as `IFS=$'/\n'` is neither stripped nor treated as a separator and `rm$IFS-y` passes through as a single program name.
- `packages/permitter/lib/command-parser.js:430` Critical — the `bash -c` / `sh -c` branch returns only `normalizeSegment(innerSegments[0])` and no caller re-inspects the inner string, so a later segment hidden inside `sh -c "git status; rm -rf /"` is never classified.
<!-- FOREMAN_REVIEW_FINDINGS_END -->
