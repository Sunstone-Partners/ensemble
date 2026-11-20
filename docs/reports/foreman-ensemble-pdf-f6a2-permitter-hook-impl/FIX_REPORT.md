# FIX_REPORT — ensemble-pdf-f6a2-permitter-hook-impl

Status: **Fixed.** Both defects from reporter finding 6 (packaging half) are corrected on this
branch, covered by a failing-first regression test, and verified. The parser hardening was a
separate task and was **not** touched.

## Root cause

Two defects in the `PermissionRequest` hook shipped in the full bundle, both still present on `dev`:

1. **Unquoted hook command.** `packages/full/hooks/hooks.json` (and the package copy
   `packages/permitter/hooks/hooks.json`) declared
   `"command": "${CLAUDE_PLUGIN_ROOT}/hooks/permitter.js"`. The path is expanded by Claude Code and
   exec'd through a shell, so an install path containing a space was split into two words and the
   hook exited `127` before it ever ran.
2. **Invalid `ask` decision.** `packages/permitter/hooks/permitter.js` answered the
   `PermissionRequest` hook with
   `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"ask"}}}`.
   Claude Code accepts only `allow` or `deny` from a `PermissionRequest` hook — the version
   reported by this task's reporter finding is 2.1.322 — so every
   `ask` answer was an invalid response and was discarded. The same `ask` value was returned for a
   denylist hit (so a denied command was **not** blocked) and for the fail-closed paths (unparseable
   command, unsafe construct, unknown operator, settings error), so those cases silently fell back
   to Claude Code's own prompt instead of the documented contract.

## Change

Paths and one-line rationale each (`git diff --numstat dev`: 10 files, 739 insertions / 130 deletions;
the review report below is an eleventh, untracked file):

| Path | Rationale |
|---|---|
| `packages/permitter/hooks/hooks.json` | Quote the hook command path so `CLAUDE_PLUGIN_ROOT` with a space execs as one word. |
| `packages/full/hooks/hooks.json` | Same quoting in the full-bundle copy of the hook definition. |
| `packages/permitter/hooks/permitter.js` | Never emit the invalid `ask` behavior: defer = no stdout decision + exit `0`; a denylist hit = `behavior: "deny"` with a message; the denylist is scanned over **every** extracted command before the allowlist pass so a denied command cannot be masked by an unmatched earlier command; the echoed command in the deny message is truncated at 200 characters. |
| `packages/permitter/tests/hook-contract.test.js` | New failing-first regression tests (21) for the quoted command, the defer paths, the deny paths and deny precedence. |
| `packages/permitter/README.md` | Document the stdout decision contract (`allow`/`deny`/empty), exit code `0`, the fail-closed table and the real test file names. |
| `packages/permitter/CHANGELOG.md` | Record the protocol change and the now-invalid `ask` behavior. |
| `docs/TRD/permitter.md` | Align the design doc with the shipped hook: interface example, matching-pipeline diagram, output contract, fail-closed table, acceptance criteria, the `ENSEMBLE_PERMITTER_DISABLE` enable switch and the test locations that actually exist. |
| `docs/HOOKS_GUIDE.md` | Document the escaped-quote requirement for hook command paths. |
| `docs/guides/environment-variables.md` | Note that the hook command string is quoted. |
| `docs/reports/foreman-ensemble-pdf-f6a2-permitter-hook-impl/FIX_REPORT.md` | This report. |
| `docs/reports/foreman-ensemble-pdf-f6a2-permitter-hook-impl/REVIEW_CODERABBIT_REPORT.md` | CodeRabbit review report: per-round findings, fixes, declines, verification and the unresolved-findings block. |

### Contract chosen (and why)

- **Defer** (previously `ask`): exit `0` with **no stdout output**. Claude Code then shows its own
  permission prompt, which is exactly the "ask the user" intent of the old `ask` value — implemented
  through the mechanism Claude Code actually supports instead of an invalid decision object. The
  hook never emits `allow` on these paths.
- **Deny** (denylist hit): exit `0` with a `PermissionRequest` decision
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"…"}}}`.
  The message names the matched rule and the command (truncated at 200 characters) so the user sees
  why the command was blocked.
- **Allow**: exit `0` with
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
  when every extracted command matches the allowlist and none matches the denylist.

The `hookSpecificOutput` wrapper is the contract Claude Code's `PermissionRequest` hook expects
(version reported by this task's reporter finding: 2.1.322); the decision object is only valid
inside it, so the hook always emits the wrapper — never a bare `{"behavior":…}` object.

## Tests

Existing harness: `packages/permitter/tests/` (jest). New file
`packages/permitter/tests/hook-contract.test.js` spawns the real hook (`spawnSync(process.execPath,
[HOOK])`) with a sandboxed `HOME` and asserts on stdout/exit code — it does not grep for the
implementation's own wording.

Failing-first evidence (hook sources reverted to `dev`, new test file kept):

```
$ git checkout dev -- packages/permitter/hooks/permitter.js packages/permitter/hooks/hooks.json packages/full/hooks/hooks.json
$ cd packages/permitter && npx jest tests/hook-contract.test.js
Test Suites: 1 failed, 1 total
Tests:       19 failed, 2 passed, 21 total        # EXIT=1
```

The 19 failures on the old code: `hooks.json hook command is shell-quoted` (both hook files),
`the hook never emits the invalid "ask" behavior` (disabled hook, non-Bash tool, empty command,
unparseable command, command with no commands extracted, malformed stdin JSON, empty stdin, MCP
tool with no allowlist match, MCP denylist hit, denylist hit), `deny decisions carry a reason`
(message names the rule, message stays bounded, decision has exactly the shape Claude Code
accepts), `deny rules win over allow rules` (denied command in a compound command, denied command
after a non-allowlisted command, MCP tool on both lists) and
`allow-path behavior is unchanged › no allowlist match is still not approved`.

With the fix restored:

```
$ cd packages/permitter && npx jest tests/hook-contract.test.js
Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total                   # EXIT=0
```

Regression test added by the review phase (CodeRabbit round 1): the child environment now resets
`ENSEMBLE_PERMITTER_DISABLE` to `'0'` before `...opts.env` so an operator-exported disable flag
cannot make every hook call defer. Failing-first proof for that one: with
`ENSEMBLE_PERMITTER_DISABLE=1` exported and the fix stashed, the same file reported
`10 failed / 11 passed` (EXIT=1); with the fix it reports `21 passed` (EXIT=0). The
explicit disabled-hook test still passes `ENSEMBLE_PERMITTER_DISABLE: '1'` through `opts.env`, which
wins because `...opts.env` is spread last.

## Local verification

Every command below was run from the repository root unless stated otherwise; exit codes are the
real ones.

| Command | Exit | Result |
|---|---|---|
| `npm run generate:validate` | 0 | `✓ Validation passed (64 files)`; `packages/development/lib/run-index/` matches a fresh build of the agent-core run-index stores. |
| `npm run validate` | 0 | All validators passed. The `⚠` lines are pre-existing "skill is below baseline" notices from unrelated skills (`assess-config`, `completion-verification`, `ensemble-beads-build`, `ensemble-fix-issue`, `ensemble-implement-bead`, `ensemble-new-feature`, `pr-review-cycle`) and are warnings, not failures. |
| `cd packages/permitter && npx jest tests/hook-contract.test.js` | 0 | Test Suites: 1 passed; Tests: 21 passed (21 total). |
| `cd packages/permitter && npx jest` | 0 | Test Suites: 8 passed, 8 total; Tests: 574 passed, 574 total (2.047 s). |
| Same four commands re-run after the review round's documentation pass (F7) | 0 / 0 / 0 / 0 | `✓ Validation passed (64 files)`; all validators passed; 21 passed in `tests/hook-contract.test.js`; 574 passed across 8 suites. |
| `git checkout dev -- <3 hook source files> && npx jest tests/hook-contract.test.js` | 1 | Failing-first: 19 failed, 2 passed (see above). Sources restored afterwards with `git checkout HEAD -- …`. |
| `markdownlint docs/TRD/permitter.md packages/permitter/README.md` | 1 | Both files already fail on `dev` (65 MD004, 70 MD007, 1 MD018, 1 MD026, 2 MD030, 4 MD036, 2 MD037, 1 MD052, 1 MD056). After the edits: 69 MD004, 74 MD007, 1 MD018, 1 MD026, 1 MD030, 4 MD036, 2 MD037, 1 MD052, 1 MD056 — same rule classes, only line shifts of the pre-existing violations (the file's escaped code fences make markdownlint read the JavaScript samples as markdown). markdownlint is not part of the repo gate (`npm run validate`), and `npm run lint:md` is a separate script. |
| `coderabbit review --agent --base dev` (3 rounds) | 0 | See `REVIEW_CODERABBIT_REPORT.md` for the per-round findings and how each was triaged. |

No generated mirror needed regeneration: the changed files are sources
(`packages/permitter/hooks/*`, `packages/permitter/README.md`, `packages/permitter/CHANGELOG.md`,
`docs/**`); `packages/full/hooks/permitter.js` is a symlink to
`packages/permitter/hooks/permitter.js`, so there is a single source of truth for the hook script.
`npm run generate:validate` confirms no generated output drifted.

## Follow-ups

- `docs/PRD/completed/permitter.md` still describes the old protocol (exit `1` on a parse error,
  `PERMITTER_ENABLED` as the master switch, `PreToolUse` wording). It is a completed PRD and was out
  of this task's scope; it should be reconciled with the shipped hook in a separate docs change.
- `docs/TRD/permitter.md` §11.2 and Appendix D still list `packages/permitter/docs/SECURITY.md` and
  `packages/permitter/docs/TROUBLESHOOTING.md`, which do not exist (the package ships no `docs/`
  directory). Left untouched to keep this change surgical.
- The settings loader still skips a malformed settings file instead of treating it as fatal
  (see the review report). That behaviour is intentional and covered by
  `packages/permitter/tests/allowlist-loader.test.js`; the documentation now states it precisely.

## Assumptions

- `$FOREMAN_BASE_BRANCH` is `dev`; the review diff base is `dev`.
- "Defer to Claude Code's normal permission prompt" means exit `0` with **empty stdout** — the
  hook's own stdout is the only channel Claude Code reads for a `PermissionRequest` decision, so
  silence is the defer signal. The hook never emits `allow` on those paths.
- The two `hooks.json` copies are independent files (both edited); only `permitter.js` is shared via
  a symlink.
- `packages/permitter` is a standalone package: its jest run needs no build step, and no generated
  mirror depends on the edited files.

## PR body

## Summary

- Quote the `PermissionRequest` hook command in both `hooks.json` copies so an install path with a
  space no longer exits `127`.
- Replace the invalid `behavior: "ask"` decision with the contract Claude Code actually honours:
  defer = exit `0` with no stdout decision, denylist hit = `behavior: "deny"` with a message,
  allow = `behavior: "allow"`. A denied command is now actually blocked.
- Scan the denylist over every extracted command before the allowlist so a denied command cannot be
  masked by an earlier command that misses the allowlist.
- Add `packages/permitter/tests/hook-contract.test.js` (21 tests) and align the hook docs
  (README, CHANGELOG, TRD, hooks guide, environment-variable guide).

## Testing

- `cd packages/permitter && npx jest tests/hook-contract.test.js` — 21 passed (EXIT=0).
- `cd packages/permitter && npx jest` — 8 suites / 574 tests passed (EXIT=0).
- Failing-first: with the hook sources reverted to `dev`, the new test file reports 19 failed /
  2 passed (EXIT=1).
- `npm run generate:validate` (EXIT=0) and `npm run validate` (EXIT=0) from the repository root.

## Risk

- Behaviour change for the hook: a denylist hit now blocks the command instead of falling back to a
  prompt, and a deferred case now produces no decision object. Callers that relied on the old
  `ask`/exit-`1` protocol are updated in the same change — every document that described it except
  the archived PRD `docs/PRD/completed/permitter.md`, which is listed as an unresolved finding for a
  separate docs reconciliation.
- `markdownlint` still reports the pre-existing violations in `docs/TRD/permitter.md` and
  `packages/permitter/README.md`; this change adds no new rule class. Measured per rule, `dev` →
  this change: MD004 65 → 69, MD007 70 → 74, MD018 1 → 1, MD026 1 → 1, MD030 2 → 1, MD036 4 → 4,
  MD037 2 → 2, MD052 1 → 1, MD056 1 → 1. Every MD004/MD007 hit is on a JavaScript sample line (the
  TRD writes code fences as literal escaped backticks, so markdownlint parses the samples as
  markdown lists); `packages/permitter/README.md` has none, and no prose list was added.
- **Fail-open corner, pre-existing and unchanged by this task:** a malformed or unreadable settings
  file is *skipped*, not fatal (`packages/permitter/lib/allowlist-loader.js:42-52`), so the
  remaining settings files still apply and a command allowed by *another* settings file can still be
  auto-approved. Only an unexpected exception while loading the settings defers to the permission
  prompt. The documents now state this precisely; the behaviour itself is out of this task's scope.

## How to revert

Revert the merge commit for this PR, or `git revert` the commits touching
`packages/permitter/hooks/permitter.js`, `packages/permitter/hooks/hooks.json`,
`packages/full/hooks/hooks.json`, `packages/permitter/tests/hook-contract.test.js` and the
`docs/**` / `packages/permitter/{README,CHANGELOG}.md` files. The change is self-contained: no
schema, config or dependency migration is involved.

## Directed by

Directed by: @ldangelo
