# CodeRabbit review report — foreman-zflwr-siil7-fix

Run: `run-9eb60acf3bad05a27ba0ce142b3dfc7d` · Task: `zflwr-siil7-fix` · Workflow: `fix` · Phase: 3 (`coderabbit-review`)

## Review engine

- Command, run from the worktree root `/Users/ldangelo/.foreman/worktrees/ensemble/zflwr-siil7-fix/run-9eb60acf3bad05a27ba0ce142b3dfc7d/workspace`:

  ```bash
  coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"
  ```

- `FOREMAN_BASE_BRANCH=dev` (base commit `a0d6a213`, `fix(full): ship the product CLI and e2e-testing contract libs in the bundle (#477)`), so the review covered the whole branch diff and not a guess at `main`/`HEAD~1`.
- Engine: CodeRabbit CLI 0.9.6 (`/Users/ldangelo/.local/bin/coderabbit`), exit code `0` in every round. Round logs: `~/.omp/zflwr-siil7-fix/cr_round1.log`, `cr_round2.log`, `cr_round3.log`.
- Round 1 reviewed the branch as phase 2 left it: the tracked diff was `docs/reports/foreman-zflwr-siil7-fix/{PLAN.md,FIX_REPORT.md}` only — the `fix` phase committed no product code, so the permitter defect was still open when this phase started.
- Because the review had nothing to look at, the permitter fix that the task asks for was implemented in this phase (failing-first, see **Fixed**), and rounds 2 and 3 reviewed that implementation. All findings below come from the same engine and the same base branch.

## Rounds

### Round 1 — 3 findings received, 0 fixed, 3 declined

All three were `minor` findings on the phase-1 plan document (`docs/reports/foreman-zflwr-siil7-fix/PLAN.md`); the diff contained no product code. Details under **Declined**.

### Round 2 — 3 findings received, 3 fixed, 0 declined

All three were `major` findings on the new `packages/permitter/lib/command-parser.js` code:

| # | Finding | Disposition |
|---|---------|-------------|
| 1 | Shell options before `-c` were not detected in the wrapper guard, so `env bash -e -c "rm -rf /tmp/target"` was judged as a plain `bash` executable and a `Bash(bash:*)` rule approved the hidden command | fixed |
| 2 | A `-c` that follows the script operand (`/bin/bash -- ./payload.sh -c "git status"`) was expanded as the shell's own command string | fixed |
| 3 | A program that is only *called* bash by path (`./tools/bash -c "git status"`) was expanded as a shell, so a `Bash(git:*)` rule approved an arbitrary program | fixed |

### Round 3 — 3 findings received, 3 fixed, 0 declined

All three were `major` findings on the same file:

| # | Finding | Disposition |
|---|---------|-------------|
| 1 | A startup-loading mode (`bash --rcfile ./payload.sh -ic "git status"`) was expanded, so the file the shell reads before the command was never judged | fixed |
| 2 | Option forms the parser could not read (`+e`, `-O extglob`) were treated as "no command string", so a wrapped `-c` fell back to being approved as a plain shell | fixed |
| 3 | A `ZDOTDIR` assignment pointed zsh at a startup file that ran before the inner command was judged | fixed |

The phase contract allows at most 3 rounds, so the review stopped here. The round-2 and round-3 fixes are covered by the package test suite (see **Verification**), not by a further review round — a fourth round was not run.

## Fixed

All fixes are in `packages/permitter/lib/command-parser.js` with their failing-first tests in `packages/permitter/tests/security.test.js`; `packages/permitter/CHANGELOG.md` records the user-visible change. `packages/full/lib/command-parser.js` was left as the git symlink `../../permitter/lib/command-parser.js` that `scripts/validate-all.js` requires, and `.beads/` was not touched.

1. **Inner redirects of a shell wrapper are refused** (`packages/permitter/lib/command-parser.js:899`, `:992`)
   - What was wrong: `checkRedirections()` only ran over the outer token list, so `bash -c "npm test > ~/.ssh/authorized_keys"` parsed to `[{npm, test}]` with the redirect dropped and was auto-allowable under `Bash(npm test:*)`.
   - What changed: the inner command text of a `-c` wrapper is tokenized once and passed to `checkRedirections()` before it is split into segments, in both `normalizeSegment()` and `classifySegment()`. A redirect to a path now throws exactly like the top level; `> /dev/null` and fd duplications (`2>&1`) stay allowed.

2. **Every shell hides a command line, not only `bash` and `sh`** (`packages/permitter/lib/command-parser.js:641`, `:672`)
   - What was wrong: only `bash` and `sh` were `-c` wrappers, so `zsh -c "git status; rm -rf /"` stayed one segment with executable `zsh` and a `Bash(zsh:*)` rule approved it.
   - What changed: `SHELL_EXECUTABLES` (`bash`, `sh`, `zsh`, `dash`, `ksh`, `ash`, `mksh`) and `isShellExecutable()` decide what is a shell, and both the expansion branch and the guard use it.

3. **A shell `-c` behind a wrapper or a privilege prefix is refused** (`packages/permitter/lib/command-parser.js:854`, `:868`)
   - What was wrong: `sudo bash -c "git status; rm -rf /"`, `command bash -c ...`, `env bash -c ...`, `timeout 5 bash -c ...` and `nohup bash -c ...` were classified by their prefix alone, so the hidden command was never judged.
   - What changed: a shell that carries a command string behind `sudo`/`doas`/`command` or behind a wrapper (`env`, `timeout`, `time`, `nice`, `nohup`) throws `shell -c behind a wrapper not supported` and the hook falls back to the permission dialog. `sudo git status`, `sudo -u x git status`, `command -v git` and `env git status` keep their previous output.

4. **The exported `normalizeSegment()` no longer drops inner segments** (`packages/permitter/lib/command-parser.js:907`)
   - What was wrong: it returned only `innerSegments[0]`, so a wrapper with several inner commands was judged by its first one.
   - What changed: a wrapper with more than one inner command throws (`bash -c with more than one inner command is not supported`); `normalizeSegment(['bash', '-c', 'npm test'])` still returns `{executable: 'npm', args: 'test'}`.

5. **Shell options before `-c` are read, and a wrapper that cannot be read is refused** (round 2 finding 1 and round 3 finding 2; `packages/permitter/lib/command-parser.js:672`)
   - What was wrong: the guard looked for `-c` as the word right after the shell, so `env bash -e -c "rm -rf /tmp/target"` and `env bash +e -c ...` were judged as a plain `bash`, and an option form the parser did not understand was read as "there is no command string".
   - What changed: `readShellInvocation()` reads the invocation the way bash does — `--` and the script operand end the option scan, short clusters (`-e`, `-lc`, `-ic`) are read letter by letter, `+` forms are read as options, `-o`/`-O` consume their value, and an option form that cannot be read with certainty makes the invocation `uncertain`. An `uncertain` invocation throws `shell invocation not supported` instead of being guessed at.

6. **A `-c` after the script operand is the script's argument** (round 2 finding 2; `packages/permitter/lib/command-parser.js:672`)
   - What was wrong: `/bin/bash -- ./payload.sh -c "git status"` and `/bin/bash ./payload.sh -c "git status"` were expanded as if `git status` were the shell's command line, so a `Bash(git:*)` rule approved a script invocation.
   - What changed: `readShellInvocation()` stops at `--` and at the first operand, so those invocations are classified as a script and are not expanded; they stay unapprovable by an inner-command rule.

7. **A shell is only trusted by a bare name or a system path** (round 2 finding 3; `packages/permitter/lib/command-parser.js:641`)
   - What was wrong: matching the basename made `./tools/bash -c "git status"` a shell, so an arbitrary program in the working directory was expanded and approved by `Bash(git:*)`.
   - What changed: `isShellExecutable()` accepts a bare name (looked up in `PATH` like any other command) and an absolute path under `/bin`, `/usr/bin`, `/sbin` or `/usr/sbin`; a relative path or any other directory is not a shell, so `./tools/bash -c "git status"` stays a single segment with executable `./tools/bash` and is not auto-allowed.

8. **A startup file the shell reads is not judged, and a startup file variable is refused** (round 3 findings 1 and 3; `packages/permitter/lib/command-parser.js:38`, `:69`)
   - What was wrong: `bash --rcfile ./payload.sh -ic "git status"` ran a file of the command's own choosing before the command, and `ZDOTDIR=./payload zsh -c "git status"` (and `export ZDOTDIR=./payload; zsh -c ...`) pointed zsh at a startup file the parser never saw.
   - What changed: `--rcfile` and `--init-file` name a file the parser cannot judge, so the invocation is refused; `ZDOTDIR` joined `PATH`, `IFS`, `BASH_ENV` and `ENV` in `DANGEROUS_ASSIGNMENT_VARS`, so both the leading assignment and the `export` form are refused with `Dangerous variable assignment not supported: ZDOTDIR`.

## Declined

1. **`docs/reports/foreman-zflwr-siil7-fix/PLAN.md:244` — "Fix the verification working directories"** (`minor`)
   - Reason: the plan is a phase-1 artifact, not code, and the finding is about a redundant `cd` in the command list the plan describes. The commands in this phase were run from the worktree root and from `packages/permitter`, which is what the plan asked for; there is nothing in the plan to correct, and the task prompt puts `docs/reports/` outside the scope of this change.

2. **`docs/reports/foreman-zflwr-siil7-fix/PLAN.md:215` — "Preserve the existing wrapper assertions"** (`minor`)
   - Reason: the plan says the `env`/`timeout`/`nohup` + `bash -c` cases must keep their old result instead of throwing. The operator's task for this run requires the opposite: those cases must throw (`env bash -c "..."` now `expect(toThrow)` instead of `expect(executables).toHaveLength(1)`). A throw is strictly stronger than the old result — the hook defers to the permission dialog, so the command can no longer be auto-approved — and the "not auto-allowed" part of the assertion is kept.

3. **`docs/reports/foreman-zflwr-siil7-fix/PLAN.md:220` — "Preserve the required null result"** (`minor`)
   - Reason: the plan says `normalizeSegment(['bash', '-c', 'unset FOO; npm test'])` must keep returning `null`. The operator's task requires the exported `normalizeSegment()` to stop returning only `innerSegments[0]` for a multi-segment inner command; it now throws instead of silently dropping the segments after the first. The plan's own reasoning (a wrapper that hides segments must not be judged by its first inner command only) is what the throw implements.

## Verification

All commands were run from the worktree root unless stated otherwise. Exit codes are the ones observed.

| Command | Exit | Result |
|---|---|---|
| `cd packages/permitter && npx jest tests/security.test.js` (before the fix) | 1 | `Tests: 30 failed, 505 passed, 535 total` — the 30 failures are the new failing-first tests, each failing with "Received function did not throw" |
| `cd packages/permitter && npx jest tests/security.test.js -t 'a shell invocation is read the way bash reads it'` (round 2 tests, before the round-2 fix) | 1 | `Tests: 8 failed, 543 skipped, 2 passed, 552 total` — the 8 new round-2 cases fail, the 2 that pass already threw for another reason |
| `cd packages/permitter && npx jest tests/security.test.js -t 'a shell invocation the parser cannot read is refused'` (round 3 tests, before the round-3 fix) | 1 | `Tests: 7 failed, 543 skipped, 2 passed, 552 total` — the 7 new round-3 cases fail |
| `cd packages/permitter && npx jest tests/security.test.js` | 0 | `Tests: 552 passed, 552 total` |
| `cd packages/permitter && npx jest` | 0 | `Test Suites: 8 passed, 8 total`, `Tests: 965 passed, 965 total` |
| `npx eslint packages/permitter/lib/command-parser.js packages/permitter/tests/security.test.js` | 0 | 0 errors, 2 pre-existing warnings (`packages/permitter/lib/command-parser.js` is in the eslint ignore list; `packages/permitter/tests/security.test.js:782` unused `allowlist`) |
| `npm run generate:validate` | 0 | `✓ Validation passed (64 files)` |
| `npm run validate` | 0 | only pre-existing prompt-baseline drift warnings, unrelated to this change |

`packages/full/lib/command-parser.js` is still the git symlink `../../permitter/lib/command-parser.js` (`git status` shows no change to it); `.beads/` is untouched.

## Notes for the operator

- **A human security reviewer must read the diff before merge and auto-merge must stay off.** This change sits on the enforcement path of the permitter: it fails closed on many command forms that were previously auto-approved, so a mistake can refuse legitimate commands.
- **Residual risk (accepted, not a finding):** `zsh` still reads `~/.zshenv` from the user's home before it runs the inner command, the same way an interactive bash reads `~/.bashrc`. That file belongs to the user, not to the command; the attacker-controlled path to it (`ZDOTDIR`) is refused. The same class of exposure already exists for the merged `bash -c` expansion.
- **The branch carries Foreman's phase artifacts** (`docs/reports/foreman-zflwr-siil7-fix/{PLAN.md,FIX_REPORT.md,REVIEW_CODERABBIT_REPORT.md}`), committed by the plan and fix phases before this one. The task prompt says not to add report or plan documents to the pull request, so the phase that opens the PR has to decide whether they stay.
- `foreman_inbox_send` worked (a progress note was sent at phase start); `foreman_task_add_comment` failed with `Task external_id is malformed`, so no task Work Log comments were written.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
{"schema": "foreman.review_findings/1", "reviewed": true, "findings": [{"severity": "minor", "path": "docs/reports/foreman-zflwr-siil7-fix/PLAN.md", "line": 244, "description": "The plan repeats a cd into the directory it already cd'ed into.", "disposition": "declined", "source": "coderabbit"}, {"severity": "minor", "path": "docs/reports/foreman-zflwr-siil7-fix/PLAN.md", "line": 215, "description": "The plan says the env/timeout/nohup wrapper assertions must keep their old result instead of throwing.", "disposition": "declined", "source": "coderabbit"}, {"severity": "minor", "path": "docs/reports/foreman-zflwr-siil7-fix/PLAN.md", "line": 220, "description": "The plan says normalizeSegment(['bash','-c','unset FOO; npm test']) must keep returning null instead of refusing a wrapper with more than one inner command.", "disposition": "declined", "source": "coderabbit"}, {"severity": "major", "path": "packages/permitter/lib/command-parser.js", "line": 854, "description": "A shell option before -c (env bash -e -c \"rm -rf /tmp/target\") slipped past the wrapper guard, so a Bash(bash:*) rule could approve the hidden command.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "major", "path": "packages/permitter/lib/command-parser.js", "line": 672, "description": "A -c that follows the script operand (/bin/bash -- ./payload.sh -c \"git status\") was expanded as the shell's own command string.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "major", "path": "packages/permitter/lib/command-parser.js", "line": 641, "description": "A program called bash by path (./tools/bash -c \"git status\") was expanded as a shell, so a Bash(git:*) rule approved an arbitrary program.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "major", "path": "packages/permitter/lib/command-parser.js", "line": 38, "description": "A startup file option (bash --rcfile ./payload.sh -ic \"git status\") was expanded, so the file the shell read before the command was never judged.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "major", "path": "packages/permitter/lib/command-parser.js", "line": 672, "description": "Option forms the parser did not understand (+e, -O extglob) were read as the absence of a command string, so a wrapped -c was approved as a plain shell.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "major", "path": "packages/permitter/lib/command-parser.js", "line": 69, "description": "A ZDOTDIR assignment pointed zsh at a startup file that ran before the inner command was judged.", "disposition": "fixed", "source": "coderabbit"}]}
<!-- FOREMAN_REVIEW_FINDINGS_END -->
<!-- FOREMAN_RISK_JUDGEMENT_START -->
{"schema": "foreman.risk_judgement/1", "level": "MEDIUM", "rationale": "The change rewrites how the permitter reads a shell invocation and fails closed on many command forms that were previously auto-approved, so a mistake can refuse legitimate commands or leave a wrapper judged only by its own executable. It is confined to one parser file with 965 passing package tests, but it changes the enforcement path of a security plugin and needs a human security reviewer before merge."}
<!-- FOREMAN_RISK_JUDGEMENT_END -->
