

Phase complete. Report: `docs/reports/foreman-ensemble-pdf-f6a2-permitter-hook-impl/FIX_REPORT.md` (322 lines, all sections incl. `## PR body` → `Directed by: @ldangelo`).

## Root cause
- `packages/permitter/hooks/hooks.json:9` + `packages/full/hooks/hooks.json:9` — command unquoted → plugin root with a space execs as two words → exit 127.
- `packages/permitter/hooks/permitter.js` — `DECISION.ASK` emitted `behavior:"ask"`; Claude Code 2.1.322 accepts only allow/deny → every answer discarded, denylist hit never blocked.

## Change (9 files, 247 insertions / 81 deletions; +report = 10)
- both `hooks.json` → `"command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/permitter.js\""`
- hook source: `ASK` removed; `DECISION.buildDeny(message)`; `deferToPermissionPrompt()` (exit 0, empty stdout); `truncateForMessage()` (200-char cap on echoed command, rule name kept); denylist now checked over **all** parsed commands **before** the allowlist pass (MCP: deny list before allow list)
- docs: permitter README/CHANGELOG (new `### Changed`), `docs/HOOKS_GUIDE.md`, `docs/TRD/permitter.md` (stale "exit 1 = defer" prose), `docs/guides/environment-variables.md`
- `packages/permitter/tests/hook-contract.test.js`: +5 cases, 16 committed cases byte-for-byte unchanged
- shell parser untouched (separate task)

## Contract chosen
Defer = exit 0 + **empty stdout** (never allow, never ask). Deny = exit 0 + `behavior:"deny"` + message naming the matched rule. Exit code always 0 (per repo's own `docs/HOOKS_GUIDE.md` protocol: 0 success / 2 blocking).

## Tests (failing-first)
- HEAD source reverted: `14 failed, 2 passed, 16 total` — the 16 cases were committed by the prior phase as test-first for this finding.
- Fix in place: **21 passed, 21 total**; package run **8 suites / 574 tests passed**.
- New cases: deny JSON shape on parsed object · deny-message cap · deny beats allow (`ls && rm -rf build`) · deny beats allow (MCP tool on both lists) · deny beats earlier allowlist miss (`unknowncmd && rm -rf build`).

## Local verification (real exit codes)
`npm run generate` 0 · `npm run generate:validate` 0 · `npm run validate` 0 (only 7 pre-existing prompt-budget warnings, none permitter) · packages/permitter jest 574 · packages/full 25 · opencode hook-bridge 62 · scripts validate 37 · `git diff --check` 0 · markdownlint 0→0, 0→0, 1→1, 146→146 (no new findings).
E2E with a **space** in `CLAUDE_PLUGIN_ROOT`, command read straight from `hooks.json` and run via `sh -c`: allow/deny/defer all EXIT=0; old unquoted form EXIT=127.

## Follow-ups (not filed — tracker owned by Foreman)
`PERMITTER_STRICT` dead config (deferred) · stale exit-1/`ask` prose in `docs/PRD/completed/permitter.md` (recommended for filing) · no permitter hook in packages/pi + packages/codex · `packages/full/hooks/hooks.json` is a hand-maintained duplicate (test asserts both) · `console.log` + `process.exit(0)` flush pattern (safe: payload few hundred bytes).

Note: task Work Log comment could not be added — `foreman_task_add_comment` rejects with `Task external_id is malformed` (`external_id: null` for this task). Progress note **was** delivered via `foreman_inbox_send` (msg `msg_KGQxA9BhG5LvIVSKqN31_g`).

Changes left **uncommitted** for Foreman to commit and open the PR.