# FIX_REPORT — permitter PermissionRequest hook (packaging half)

Task: `ensemble-pdf-f6a2-permitter-hook-impl` · reporter finding 6 (packaging half).
Scope note: the shell-parser hardening is a **separate** task; the parser (`packages/permitter/lib/command-parser.js`) was **not** touched.

Status: **complete** — fix implemented, failing-first tests green, repo gates green.

## Root cause

Two independent defects, both present on `dev` (base `fe5aea4f`):

1. **Unquoted hook command.** `packages/full/hooks/hooks.json:9` and `packages/permitter/hooks/hooks.json:9` registered the hook as
   `"command": "${CLAUDE_PLUGIN_ROOT}/hooks/permitter.js"`. Claude Code runs the command through a shell, so an install path
   containing a space is split into two words; the hook is never found and the shell exits `127`. The sibling plugins in this repo
   (`packages/lifecycle-claude/hooks/hooks.json`, `packages/telemetry/hooks/hooks.json`, `packages/guards/hooks/hooks.json`) already
   use the quoted form — permitter was the outlier.

2. **Invalid `behavior: 'ask'`.** `packages/permitter/hooks/permitter.js` defined `DECISION.ASK`
   (`{hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'ask'}}}`) and returned it on **every**
   deferral path — MCP settings error, hook disabled, non-Bash tool, empty command, settings load error, parse error, zero
   commands extracted, Bash allowlist miss, MCP allowlist miss, post-`main()` fallback, fatal stdin JSON error, stdin error —
   and also on **denylist hits** (`ON DENYLIST: ... - showing normal dialog`). Claude Code 2.1.322 accepts only `allow` or `deny`
   in a `PermissionRequest` decision, so every one of those answers was an invalid response that got discarded: a denylist hit
   never blocked anything, and the "fail closed" paths produced no usable outcome either.

`packages/full/hooks/permitter.js` is a **symlink** (mode `120000`) to `packages/permitter/hooks/permitter.js`, so the hook body
has a single source. `packages/full/hooks/hooks.json` is a **regular file** (mode `100644`) — a genuine second copy that has to
carry the quoting itself.

## Change

| Path | Rationale |
|---|---|
| `packages/permitter/hooks/permitter.js` | Dropped `DECISION.ASK` entirely; added `DECISION.buildDeny(message)` (emits `behavior:'deny'` + `message`), `deferToPermissionPrompt()` (prints nothing, `process.exit(0)`), and `findDeniedPattern` / `findDeniedMcpPattern` so a deny can name the matched rule. Every former `ASK` site now defers; denylist hits now deny. Added `truncateForMessage()` so a very long command cannot produce an unbounded deny message (echoed text capped at 200 chars). The per-command loop was split into **two passes**: the denylist is checked over *every* extracted command first, then the allowlist — so a denied command is denied even when an earlier command misses the allowlist (`unknowncmd && rm -rf build`). |
| `packages/permitter/hooks/hooks.json` | Hook command quoted: `"command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/permitter.js\""` so a `CLAUDE_PLUGIN_ROOT` containing a space execs as one word. |
| `packages/full/hooks/hooks.json` | Same quoting in the shipped full bundle (real file copy, not a symlink). |
| `packages/permitter/README.md` | Rewrote the hook output/exit-code contract: only `allow` and `deny` (+`message`) are emitted, deferral is empty stdout + exit 0, denylist hit blocks, `PERMITTER_STRICT` is documented as reserved/not read (the code never read it), and the fail-closed table now shows the stdout column. Added a note that the deny message names the matched rule and that only the echoed command text is truncated at 200 characters (the rule name is always kept). |
| `packages/permitter/CHANGELOG.md` | Two `### Security` entries under `[Unreleased]` describing the invalid-`ask` removal and the quoted hook command, plus a new `### Changed` section recording the user-visible behaviour change: the hook always exits 0 and a denylist hit now blocks outright instead of falling back to a prompt. |
| `docs/HOOKS_GUIDE.md` | Example `hooks.json` now shows the quoted command, plus a sentence on why the path is quoted. |
| `docs/TRD/permitter.md` | Appendix E example updated to the quoted command; the stale "exit 1 = defer" prose corrected to the new contract (defer = exit 0 with empty stdout, deny = exit 0 with a `deny` decision). |
| `docs/guides/environment-variables.md` | `CLAUDE_PLUGIN_ROOT` row notes that the command string is quoted so a path with a space execs as one word. |
| `packages/permitter/tests/hook-contract.test.js` | Added five cases to the pre-existing contract suite (the 16 committed cases are byte-for-byte unchanged): the deny JSON shape asserted on the parsed object, deny-message length cap, deny precedence over allow for a compound command, deny precedence over allow for an MCP tool on both lists, and deny precedence when an earlier command in the same compound command misses the allowlist. |

**Contract chosen (and why).** For a `PermissionRequest` hook the only two valid behaviours are `allow` and `deny`
(`docs/HOOKS_GUIDE.md` "Protocol": exit `0` = success and stdout may carry JSON; exit `2` = blocking with stderr; any other
exit code = non-blocking error). Therefore:

- **Deferral = say nothing.** Empty stdout + exit `0`. Claude Code sees no decision and shows its own permission prompt, i.e.
  exactly the "ask the user" behaviour the old `ask` value was trying to request. The hook never emits `allow` on these paths,
  so fail-closed intent is preserved (a command that cannot be proven allowed is never auto-approved).
- **Denylist hit = `deny` + message.** A genuine deny is now expressed with the one behaviour Claude Code understands, and the
  message names the matched rule (e.g. `Permitter blocked "rm -rf build" (matched deny rule Bash(rm:*)).`).
- **Exit code is always `0`** for a processed event (the old "exit 1 = defer" wording in the docs was wrong for this hook type
  and was removed).
- **Deny messages are bounded.** The command text echoed into a deny message is truncated at 200 characters (`... (truncated)`),
  so a pathological command cannot produce an unbounded message. The matched rule name is always preserved.
- **Deny is checked before allow, over every command.** The hook runs two passes over the commands the parser extracted: first the
  denylist (all of them), then the allowlist. So `ls && rm -rf build` is denied even when `ls` is allowlisted, and
  `unknowncmd && rm -rf build` is **denied** rather than deferred — an earlier command that misses the allowlist can no longer
  mask a denied command later in the same compound command. The same ordering applies to MCP tools: the MCP denylist is consulted
  before the MCP allowlist, so a tool on both lists is denied. All three orderings are pinned by the contract tests.

## Tests

The failing-first contract tests were **already present in this worktree**, tracked and unmodified at HEAD (commit `4bed076b`,
`packages/permitter/tests/hook-contract.test.js`, 211 lines as committed) — they were pulled in from `wip/pdf-f6a-hook-contract-tests` by the
previous phase. They were **not** rewritten or weakened here. No existing test pinned the invalid `ask` output
(`grep -rn "DECISION" packages/permitter` → only `hooks/permitter.js`; no test referenced `behavior: 'ask'`), so no allow-path or
existing assertion had to be changed.

**Failing-first evidence (real run).** The three source files were reverted to HEAD (`git checkout HEAD -- packages/permitter/hooks/permitter.js
packages/permitter/hooks/hooks.json packages/full/hooks/hooks.json`) and the contract suite was run:

```
cd packages/permitter && npx jest tests/hook-contract.test.js
→ Test Suites: 1 failed, 1 total
  Tests:       14 failed, 2 passed, 16 total
```

The 14 failures were: both `hooks.json registers a quoted command` cases (permitter + full), `denylist hit is denied, not asked`,
`MCP denylist hit is denied, not asked`, `disabled hook defers silently instead of asking`, `non-Bash tool defers silently
instead of asking`, `empty command defers silently instead of asking`, `unparseable command defers silently instead of asking`,
`command with no commands extracted defers silently instead of asking`, `MCP tool with no allowlist match defers silently
instead of asking`, `malformed stdin JSON defers silently instead of asking`, `empty stdin defers silently instead of asking`,
`no allowlist match is still not approved`, `denylist hit reports a message naming the rule`. Representative assertion output:

```
expect(received).not.toContain(expected)
  Expected substring: not "\"behavior\":\"ask\""
  Received string:    "{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"decision\":{\"behavior\":\"ask\"}}}"
…
expect(received).toBe(expected)
  Expected: "deny"
  Received: "ask"
```

The 2 passing tests were the allow-path ones (`allowlisted command is still auto-approved`, `allowlisted MCP tool is still
auto-approved`), confirming the suite was not simply red everywhere.

**After the fix:** the same command reports `Tests: 21 passed, 21 total` (16 pre-existing cases + the five cases added below).

**Tests added by this change.** Five cases in `packages/permitter/tests/hook-contract.test.js` — the 16 committed cases are left
byte-for-byte unchanged:

1. `deny message stays bounded for a very long command` — pins the deny-message length cap (echoed command text truncated at 200
   characters). Failing-first evidence: with `packages/permitter/hooks/permitter.js` reverted to HEAD the case fails
   (`Expected: "deny" / Received: "ask"`).
2. `deny decision has exactly the shape Claude Code accepts` — parses stdout and asserts
   `hookSpecificOutput.hookEventName === 'PermissionRequest'`, `decision.behavior === 'deny'`, `decision.message` is a string,
   the decision carries no `ask` field, and stdout holds exactly one JSON object. Failing-first evidence: reverted to HEAD it
   fails (`Expected: "deny" / Received: "ask"`).
3. `a denied command in a compound command is denied even when the first command is allowlisted` (sandbox allow `Bash(ls:*)`,
   deny `Bash(rm:*)`, command `ls && rm -rf build`) — pins that deny is checked per parsed command, so an allowlisted first
   command cannot carry a denied second command through. Failing-first evidence: reverted to HEAD it fails
   (`Expected substring: not "\"behavior\":\"ask\""`).
4. `an MCP tool on both the allowlist and the denylist is denied` (allow and deny both `mcp__playwright__*`) — pins that the
   MCP denylist is consulted before the MCP allowlist. Failing-first evidence: reverted to HEAD it fails
   (`Expected substring: not "\"behavior\":\"ask\""`).
5. `a denied command is denied even when an earlier command is not allowlisted` (sandbox allow `Bash(ls:*)`, deny `Bash(rm:*)`,
   command `unknowncmd && rm -rf build`) — pins that the denylist is checked over **all** extracted commands before the allowlist
   is consulted, so a command that misses the allowlist cannot defer away a denied command later in the same compound command.
   Failing-first evidence: against the single-pass hook this case fails with `Matcher error: received value must be a non-null
   object / Received has value: null` — the hook deferred instead of denying.

With `packages/permitter/hooks/permitter.js` reverted to HEAD the two new `deny rules win over allow rules` cases report
`Tests: 2 failed, 18 skipped, 20 total`; the shape case reports `1 failed`. With the fix in place all four of those cases pass. No
existing test was deleted, skipped, weakened or rewritten.

Case 5 was added after that first round and is failing-first against the **single-pass** hook of this same change: with the
two-pass restructure reverted it reports `Tests: 1 failed, 20 skipped, 21 total` (`Received has value: null`); with the two-pass
restructure in place the whole contract suite reports `Tests: 21 passed, 21 total`.

Apart from those five cases, the contract suite is **pre-existing** (committed at HEAD by the previous phase) and already covered
(a) the quoted command in both `hooks.json` copies, (b) "no `ask` anywhere" on every deferral path, (c) empty stdout + exit 0 on
deferral, (d) `deny` on a denylist hit, (e) `deny` carries a message, and (f) unchanged allow behaviour. The fix was implemented to
satisfy that suite.

## Local verification

Every command below was run from the repo root
`/Users/ldangelo/.foreman/worktrees/ensemble/ensemble-pdf-f6a2-permitter-hook-impl/run-86255df946c9a098b47aa1ca3633e0db/workspace`
(node `v26.13.1`; repo `engines.node` = `^22.22.2 || ^24.15.0 || >=26.0.0` → satisfied).

| Command | Result |
|---|---|
| `cd packages/permitter && npx jest tests/hook-contract.test.js` (on reverted HEAD sources) | **RED** — 14 failed, 2 passed, 16 total |
| `cd packages/permitter && npx jest tests/hook-contract.test.js` (after fix) | **GREEN** — 21 passed, 21 total (16 pre-existing + 5 added) |
| `cd packages/permitter && npx jest tests/hook-contract.test.js -t "deny rules win over allow rules"` (hook source reverted to HEAD) | **RED** — 2 failed, 18 skipped, 20 total (`Expected substring: not "\"behavior\":\"ask\""`) |
| `cd packages/permitter && npx jest tests/hook-contract.test.js -t "deny decision has exactly the shape"` (hook source reverted to HEAD) | **RED** — 1 failed (`Expected: "deny" / Received: "ask"`) |
| `cd packages/permitter && npx jest tests/hook-contract.test.js -t "a denied command is denied even when an earlier command is not allowlisted"` (two-pass restructure reverted) | **RED** — 1 failed, 20 skipped, 21 total (`Matcher error: received value must be a non-null object / Received has value: null` — the hook deferred instead of denying) |
| `cd packages/permitter && npx jest` (full package) | **GREEN** — 8 suites, 574 tests passed |
| `cd packages/full && npx jest` | **GREEN** — 1 suite, 25 tests passed |
| `cd packages/opencode && npx jest tests/hook-bridge.test.js` | **GREEN** — 1 suite, 62 tests passed |
| `cd scripts && npx jest tests/validate-full-bundle-requires.test.js tests/validate-bundle-bare-requires.test.js tests/generated-output-integrity.test.js` | **GREEN** — 3 suites, 37 tests passed |
| `npm run generate` | **EXIT=0** — "✓ Generated 64 file(s)", "✓ generated 5 file(s) into packages/development/lib/run-index/"; working tree unchanged afterwards (no generated mirror churn — no `packages/pi`, `packages/codex` or `packages/development/commands` source changed) |
| `npm run generate:validate` | **EXIT=0** — "✓ Validation passed (64 files)"; run-index matches a fresh build |
| `npm run validate` | **EXIT=0** — only pre-existing prompt-budget *warnings* (assess-config 1528<1532, completion-verification 1857<1899, ensemble-beads-build 4720<4727, ensemble-fix-issue 2708<2709, ensemble-implement-bead 1587<1605, ensemble-new-feature 3192<3193, pr-review-cycle 2641<2645); none relate to permitter, no baselines raised, no errors |
| `echo '{"tool_name":"Bash","tool_input":{"command":"echo hi"}}' \| HOME=~/.omp/ensemble-pdf-f6a2/fakehome node packages/full/hooks/permitter.js` | exit 0, empty stdout (defer) — the full-bundle symlink resolves and runs |
| `grep -rn "exit 1" packages/permitter --include="*.md"` | no hits (the stale exit-1 wording is gone from the permitter package docs) |
| `npx markdownlint docs/HOOKS_GUIDE.md docs/guides/environment-variables.md packages/permitter/README.md docs/TRD/permitter.md` (HEAD copy vs worktree copy, same repo config) | **no new findings** — `docs/HOOKS_GUIDE.md` 0 → 0, `docs/guides/environment-variables.md` 0 → 0, `packages/permitter/README.md` 1 → 1 (pre-existing MD026 at line 95), `docs/TRD/permitter.md` 146 → 146 (pre-existing, the file is a flattened markdown export) |
| `git diff --check` | **EXIT=0** — no whitespace errors |
| End-to-end shell proof of the quoting fix (sandbox under `~/.omp/ensemble-pdf-f6a2/e2e`, `CLAUDE_PLUGIN_ROOT` = a path **containing a space**, command string read straight out of `packages/permitter/hooks/hooks.json` and run through `sh -c "$CMD"`) | **GREEN** — allow `npm test` → stdout `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`, `EXIT=0`; deny `rm -rf build` → stdout `{"…","decision":{"behavior":"deny","message":"Permitter blocked \"rm -rf build\" (matched deny rule Bash(rm:*))."}}`, `EXIT=0`; defer → stdout **empty**, `EXIT=0`. The **old unquoted** command run the same way → `EXIT=127`, stderr `sh: line 1: <root>: No such file or directory` |
| Exit-code / stream proof over all four live paths (allow, deny, defer, malformed stdin) | **GREEN** — every path exited `0`; with `PERMITTER_DEBUG=1` all `[PERMITTER] …` lines went to **stderr** and stdout carried only the decision JSON (or nothing); `2>/dev/null` left stdout with just the decision JSON ⇒ `debugLog` never writes stdout |

Final `git diff --stat` — this block **excludes the report itself** (`docs/reports/…/FIX_REPORT.md` is the tenth changed file); it was
produced with `git diff --stat -- . ':(exclude)docs/reports'`:

```
 docs/HOOKS_GUIDE.md                                                |   4 +-
 docs/TRD/permitter.md                                              |  18 +--
 docs/guides/environment-variables.md                               |   2 +-
 packages/full/hooks/hooks.json                                     |   2 +-
 packages/permitter/CHANGELOG.md                                    |   6 +
 packages/permitter/README.md                                       |  62 +++++----
 packages/permitter/hooks/hooks.json                                |   2 +-
 packages/permitter/hooks/permitter.js                              | 173 +++++++++++++++++++------
 packages/permitter/tests/hook-contract.test.js                     |  59 +++++++++
 9 files changed, 247 insertions(+), 81 deletions(-)
```

`npm run generate:pi` was **not** run: no generated source changed (`packages/pi` contains no permitter hook mirror — `grep -rn
permitter packages/pi` matches only `packages/pi/AGENTS.md`, and `packages/pi/package.json` has no command/agent/skill
regeneration script for this content).

## Follow-ups

1. **`PERMITTER_STRICT` is dead configuration.** The hook never read it (`grep PERMITTER_STRICT packages/permitter/hooks/permitter.js`
   → only the header comment). It is now documented as reserved. Removing the env var entirely is a separate cleanup; it is out of
   this task's scope (the task is the packaging half of reporter finding 6).
2. **Stale exit-1 / `ask` prose in the completed PRD.** The stale "exit 1 = defer" prose in `docs/TRD/permitter.md` was corrected
   in this change (≈ lines 210, 275–277, 347, 427, 1014, 1030, 1254 → defer = exit 0 with empty stdout, deny = exit 0 with a
   `deny` decision). `docs/PRD/completed/permitter.md` was **left untouched** because it is a completed historical PRD (lines 108,
   140, 144, 147, 558 FR10.2, 559 FR10.3, 627, 883 AC5.1 still describe exit 1 / the `ask` value). The *current* contract lives in
   `packages/permitter/README.md` and `docs/HOOKS_GUIDE.md`, both updated. **Follow-up action:** recommended for filing as a tracked task — **not filed**
   in this phase (the tracker is owned by Foreman, and this phase deliberately did not touch `.beads/`).
3. **`packages/pi` / `packages/codex` do not ship the permitter hook.** Verified by grep: no copies exist there, and the OpenCode
   bridge deliberately does not bridge `PermissionRequest` (`scripts/generate-opencode/src/hook-bridge.js:36`). If a future
   runtime wants the same contract, it needs its own copy of the hook and the same quoting.
4. **Only `packages/permitter` and `packages/full` carry the hook.** `packages/full/hooks/hooks.json` is a hand-maintained copy
   of `packages/permitter/hooks/hooks.json`; the new contract test asserts the quoting in **both** copies, so a future divergence
   fails the build rather than silently shipping the 127 bug again.
5. **Task Work Log comment could not be added (Foreman-side data issue).** The operator progress note for this phase **was**
   delivered through `foreman_inbox_send` (message id `msg_KGQxA9BhG5LvIVSKqN31_g`). `foreman_task_add_comment` failed with
   `Task external_id is malformed`; `foreman_task_list` shows `external_id: null` for task `ensemble-pdf-f6a2-permitter-hook-impl`,
   so the server rejects the write before any phase content is checked. Nothing in this change depends on that comment, and this
   phase did not touch the tracker.
6. **The hook writes its decision with `console.log` followed by `process.exit(0)`.** On macOS, Node writes to a pipe
   asynchronously, so an immediate `process.exit` can truncate a large payload. The decision JSON is a few hundred bytes at most —
   far below the pipe buffer — so today's behaviour is safe. Switching to `process.stdout.write(json, () => process.exit(code))`,
   or setting `process.exitCode` and returning, would remove the theoretical hazard. Out of scope for this task (the pattern is
   pre-existing at HEAD); recorded here so it is not lost.

## Assumptions

1. **"Defer" = exit 0 with empty stdout.** The task asked to "verify against the repo's own docs and tests what the intended
   fail-closed contract is". `docs/HOOKS_GUIDE.md` (Protocol) and `CLAUDE.md` say exit `0` = success with optional JSON on stdout,
   exit `2` = blocking (stderr), other codes = non-blocking error. The pre-existing contract tests assert `stdout.trim() === ''`
   and `status === 0` for every deferral path, so empty-stdout + exit 0 is the repo's own chosen deferral. Exit 1 would have been
   a non-blocking error, not a deferral, so the old "exit 1 = defer" documentation was wrong and was corrected.
2. **No `ask`, ever.** The task says the hook "must never emit `allow` for these" and never emit `ask`; the implementation emits
   `allow` only when every extracted command matches the allowlist and none matches the denylist.
3. **Denylist hits block.** The reporter finding says "a denylist hit does not block", so a denylist hit is treated as a genuine
   deny → `behavior: 'deny'` with a message naming the matched rule. This is a behaviour change (previously the user was asked),
   intended by the finding.
4. **The shell parser was not touched.** `packages/permitter/lib/command-parser.js` is unchanged; the parser-hardening half of
   reporter finding 6 is a separate task.
5. **The contract test file was already committed** at HEAD (commit `4bed076b`) in this worktree, so the task's "pull the tests in
   unchanged" step needed no `git checkout FETCH_HEAD` here. The pre-existing 16 cases were left byte-for-byte as committed; this
   change **adds** five cases (`deny message stays bounded for a very long command`, `deny decision has exactly the shape Claude
   Code accepts`, and the three `deny rules win over allow rules` cases) and rewrites nothing.
6. **Scope.** Only the files named in the task were touched (hook source, the two `hooks.json` copies, the permitter
   README/CHANGELOG, the docs that describe the hook output, and the contract test). The stale prose in the completed PRD
   `docs/PRD/completed/permitter.md` is listed under Follow-ups, not edited.

## PR body

## Summary

Fixes the two packaging defects in the permitter `PermissionRequest` hook that ships in the full bundle:

- **Quoted hook command.** `packages/permitter/hooks/hooks.json` and `packages/full/hooks/hooks.json` now register
  `"command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/permitter.js\""`. Previously an install path containing a space was split into two
  shell words and the hook exited `127`. This matches the quoting already used by the sibling `lifecycle-claude`, `telemetry` and
  `guards` plugins.
- **No invalid `ask` behaviour.** `packages/permitter/hooks/permitter.js` no longer emits `decision.behavior: 'ask'`, which Claude
  Code (2.1.322) rejects for `PermissionRequest` (only `allow` and `deny` are valid). Every path that previously meant "ask the
  user" (unparseable command, unsafe construct, settings error, unknown operator, no allowlist match, hook disabled, malformed
  stdin) now prints **nothing** and exits `0`, so Claude Code shows its own permission prompt. A genuine **denylist hit** now emits
  `behavior: 'deny'` with a message naming the matched rule (the echoed command is truncated at 200 characters), so a denylisted
  command is actually blocked. The hook never emits `allow` on an error path.
- **Deny is checked before allow, over every extracted command.** The hook makes two passes: the denylist first (all commands),
  then the allowlist. So `unknowncmd && rm -rf build` is denied rather than deferred by the earlier allowlist miss.
- Docs updated to the new contract: `packages/permitter/README.md`, `packages/permitter/CHANGELOG.md` (new `### Changed` entry for the
  user-visible behaviour change), `docs/HOOKS_GUIDE.md`, `docs/TRD/permitter.md`, `docs/guides/environment-variables.md`.

The shell parser (`packages/permitter/lib/command-parser.js`) is **not** touched — that half of reporter finding 6 is a separate task.

## Testing

- Failing-first: with the three source files reverted to HEAD, `cd packages/permitter && npx jest tests/hook-contract.test.js`
  reported **14 failed, 2 passed, 16 total** (both `hooks.json registers a quoted command` cases, every "defers silently instead of
  asking" case, and both denylist-deny cases). Those 16 cases were committed by the previous phase as the test-first half of this
  very finding, so 14 of them failing on the unfixed code is the expected pre-fix state — not a broken suite.
- After the fix the same command reports **21 passed, 21 total** (16 pre-existing cases + five cases added by this change).
- Added by this change (all five failing-first, with `packages/permitter/hooks/permitter.js` reverted to HEAD — the fifth against the
  single-pass hook of this same change):
  `deny message stays bounded for a very long command` (deny message length is capped; the echoed command is truncated at 200
  characters — fails on HEAD with `Expected: "deny" / Received: "ask"`); `deny decision has exactly the shape Claude Code accepts`
  (the decision JSON is asserted on the parsed object: `hookEventName`, `behavior`, a string `message`, no `ask` field, exactly one
  JSON object on stdout — fails on HEAD with `Expected: "deny" / Received: "ask"`); and three `deny rules win over allow rules` cases
  (a denied second command in `ls && rm -rf build` is denied even though `ls` is allowlisted; an MCP tool on both the allowlist
  and the denylist is denied — both fail on HEAD with `Expected substring: not "\"behavior\":\"ask\""`; and `unknowncmd && rm -rf build`
  is denied rather than deferred by the earlier allowlist miss — fails on the single-pass hook with
  `Matcher error: received value must be a non-null object / Received has value: null`).
- `cd packages/permitter && npx jest` → **8 suites / 574 tests passed**.
- `cd packages/full && npx jest` → **25 tests passed**; `cd packages/opencode && npx jest tests/hook-bridge.test.js` → **62 passed**;
  `cd scripts && npx jest tests/validate-full-bundle-requires.test.js tests/validate-bundle-bare-requires.test.js tests/generated-output-integrity.test.js` → **37 passed**.
- End-to-end shell proof of the quoting fix: with `CLAUDE_PLUGIN_ROOT` pointing at a path **containing a space**, the command
  string read straight out of `packages/permitter/hooks/hooks.json` and run through `sh -c "$CMD"` returns the allow decision,
  the deny decision, or empty stdout for a defer — all with `EXIT=0`. The old unquoted form in the same harness returns `EXIT=127`
  (`sh: line 1: <root>: No such file or directory`).
- Every live path (allow / deny / defer / malformed stdin) exits `0`; with `PERMITTER_DEBUG=1` the `[PERMITTER] …` lines go to
  stderr and stdout carries only the decision JSON.
- Gates from the repo root: `npm run generate` → EXIT=0 (no generated output changed), `npm run generate:validate` → EXIT=0,
  `npm run validate` → EXIT=0 (only pre-existing prompt-budget warnings unrelated to permitter; no baseline was raised).
- No test was deleted, skipped, weakened or rewritten: the contract suite was already committed at HEAD and was left untouched apart
  from the five added cases, and no existing test pinned the invalid `ask` output.

## Risk

Low, and contained to the permitter plugin.

- The behavioural change is that a **denylist hit now blocks** instead of prompting the user. That is the intent of the finding,
  but it will make previously-interactive denylisted commands fail outright, and users with broad deny rules will notice.
- The deny message echoes the command text (truncated at 200 characters), so a command that carries a secret — a token in
  `curl -H`, for example — has that secret repeated in the message. The model proposed that command, so it has already seen it;
  the risk stays low, but the message is not redacted.
- Because the denylist is now checked over **all** extracted commands before the allowlist, a compound command whose *first* part
  misses the allowlist but whose *later* part matches a deny rule is now denied instead of deferred to the prompt. That is the
  safer direction (a deny rule can no longer be masked), but it turns some previously-prompted commands into hard failures.
- Deferral now means "exit 0 with empty stdout" rather than "exit 1" (per the repo's own `docs/HOOKS_GUIDE.md` Protocol: exit 0 =
  success, exit 2 = blocking, other codes = non-blocking error). If any deployment depended on the old exit-1 behaviour it would
  now see a successful no-op, which is the correct "defer to the prompt" signal.
- `PERMITTER_STRICT` was never read by the code; it is now documented as reserved rather than removed. Removing it is deferred and
  recommended, not filed as a task in this phase.
- The decision is written with `console.log` followed by `process.exit(0)`. On macOS, Node writes to a pipe asynchronously, so an
  immediate exit can truncate a large payload; the decision JSON is a few hundred bytes at most — far below the pipe buffer — so
  the current behaviour is safe. Switching to `process.stdout.write(json, () => process.exit(code))` (or setting `process.exitCode`
  and returning) would remove the theoretical hazard; that is out of scope here and recorded as a follow-up.
- No change to the shell parser, the allowlist matcher, or the generated Pi/Codex/OpenCode mirrors (there is no permitter hook
  mirror in those runtimes).

## How to revert

Revert this commit. The change is self-contained in ten files (two `hooks.json`, the hook source, the permitter README/CHANGELOG, the
contract test and four docs); reverting restores the unquoted command and the `behavior: 'ask'` responses. If only the denylist
behaviour needs to be rolled back, drop the `DECISION.buildDeny(...)` calls in `packages/permitter/hooks/permitter.js` and route
those two branches to `deferToPermissionPrompt()`.

## Directed by

Directed by: @ldangelo
