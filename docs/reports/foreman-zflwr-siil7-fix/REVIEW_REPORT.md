**Phase 4 (`repo-rules-review`) done.**

**Range**: `git diff dev...HEAD` (base `a0d6a213`, HEAD `19d1cd5c`) — 7 files, +702/−31.

**Fixed (4, uncommitted)**
- `packages/permitter/README.md` — Parse Errors table + `normalizeSegment()` doc now match code: `ZDOTDIR` added; rows for `shell invocation not supported` + `shell -c behind a wrapper not supported`; skips-row widened to all expanded shells.
- `packages/permitter/lib/command-parser.js:907` — unreleased msg `bash -c with more than one inner command…` → `shell -c with more than one inner command…` (fires for every shell now). 2 test regexes tightened: red → green.
- `packages/permitter/CHANGELOG.md:29-30` — bullet fixed: `bash +e -c` / `-O extglob` are read as options (inner cmd expanded, not refused); trusted dirs = `/bin,/usr/bin,/sbin,/usr/sbin`.

**Declined (3)**: root `CHANGELOG.md` entry (PR #466 precedent); untested `COMMAND_PREFIX_COMMANDS` export (existing pattern); README nested-subshell row (already stale on dev).

**Open (1, operator)**: branch carries 287 lines of `docs/reports/...` phase artifacts though task prompt forbids plan/report docs in PR.

**Carried forward**: all 9 CodeRabbit findings (`source: coderabbit`, 6 fixed / 3 declined) — recovered from commit `c645dc12`; working-tree CR report had been clobbered by `19d1cd5c`.

**Verification**: security.test.js 552/552 (0) · permitter suite 965/965 (0) · eslint (0, lib eslint-ignored) · markdownlint (1 — pre-existing MD026 `README.md:94`, unrelated) · `generate:validate` (0) · `validate` (0) · report JSON blocks parsed + key/line schema checked (17 findings, 0 problems).

**Report**: `docs/reports/foreman-zflwr-siil7-fix/REVIEW_REPORT.md` (untracked; Foreman commits). No commit/PR made by me — phase contract says Foreman commits.

**Notes**: `foreman_inbox_send` sent (`msg_bBa1L-xjjEy3_ruupRf2dg`); `foreman_task_add_comment` failed `Task external_id is malformed` (known defect, noted in report). `ask_advisor` unavailable — Anthropic refresh token expired (`invalid_grant`); review proceeded on code verification only.