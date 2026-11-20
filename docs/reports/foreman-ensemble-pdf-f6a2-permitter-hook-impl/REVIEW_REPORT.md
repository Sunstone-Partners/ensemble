# Repository Rules Review — ensemble-pdf-f6a2-permitter-hook-impl

## Review engine

Repository-rules reviewer: this phase (inline review, no external CLI). Diff range reviewed:
`git diff dev...HEAD` (`fe5aea4f` merge-base → `88093837`), i.e. the run's full diff: 11 files,
790 insertions / 130 deletions — `packages/permitter/hooks/permitter.js`, `packages/permitter/hooks/hooks.json`,
`packages/full/hooks/hooks.json`, `packages/permitter/tests/hook-contract.test.js`, `packages/permitter/README.md`,
`packages/permitter/CHANGELOG.md`, `docs/HOOKS_GUIDE.md`, `docs/guides/environment-variables.md`,
`docs/TRD/permitter.md`, and this run's `FIX_REPORT.md` / `REVIEW_CODERABBIT_REPORT.md`.

Rules applied, in order: root `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` (generated-mirror policy,
version-sync policy, changelog policy, "do not pin prompt wording", PR-size guidance), plus the
established idioms of the files touched. Previous phase's `REVIEW_CODERABBIT_REPORT.md` was read; its
findings block was taken from the version committed in `ebd198ae` (the copy at `HEAD` is a 30-line
summary with no markers — noted in the Verification section).

Scope note: `packages/full/hooks/permitter.js` is a symlink to `../../permitter/hooks/permitter.js`, so
the hook has one source of truth; `packages/full/hooks/hooks.json` is a second literal copy of the hook
definition and was checked against the quoting requirement too.

## Findings

Three findings were carried forward from the previous phase; seven more were raised by this pass.

1. **Carried (Major)** `docs/PRD/completed/permitter.md:103` — PRD documents a `PreToolUse` hook with the
   exit-1 defer protocol as current. → **Declined** (see Declined).
2. **Carried (Minor)** `packages/permitter/lib/allowlist-loader.js:42` — malformed settings file skipped
   silently. → **Declined** (see Declined).
3. **Carried (Minor)** `docs/TRD/permitter.md:1226` — deliverables list names two nonexistent
   `packages/permitter/docs/*.md` files. → **Declined** (see Declined).
4. **New (Minor)** `packages/permitter/hooks/permitter.js:269` — a deny message interpolates a pattern that
   the code itself types as possibly `null`. → **Fixed**.
5. **New (Minor)** `packages/permitter/hooks/permitter.js:237-279` and `tests/hook-contract.test.js` — the
   MCP denylist branch has no rule-identity or long-command coverage, unlike the Bash branch. → **Fixed**
   (test-only).
6. **New (Minor)** `packages/permitter/hooks/permitter.js:176` — `outputDecision(decision, exitCode = 0)`
   still takes an exit code no caller ever passes while the shipped contract is "always exit 0". → Declined
   (see Declined; also covered by finding 4's change).
7. **New (Minor)** `packages/permitter/hooks/permitter.js:55` — `DECISION.DENY` is declared and read by nothing.
   → Declined (pre-existing dead value, untouched by this run).
8. **New (Major)** `packages/permitter/README.md:83`, `packages/permitter/CHANGELOG.md:26`,
   `docs/TRD/permitter.md:450` — `PERMITTER_STRICT` is declared in three docs and read by no code.
   → Declined (pre-existing; see Declined).
9. **New (Minor)** `docs/TRD/permitter.md:31` — "Default State | Disabled | User explicitly opts in via env
   var" contradicts the shipped enabled-by-default hook. → Declined (pre-existing; see Declined).
10. **New (Major)** `docs/PRD/completed/permitter.md:54` — the same PRD advertises three env vars
    (`PERMITTER_ENABLED`, `PERMITTER_LOG`, `PERMITTER_STRICT`) and an opt-in default that no shipped code
    implements; `packages/permitter/hooks/permitter.js` reads only `ENSEMBLE_PERMITTER_DISABLE` and
    `PERMITTER_DEBUG`. → Declined (same reasoning as finding 1; this is the detail behind it).
11. **New (Minor)** version sync / root changelog — checked and clean: `scripts/version-sync.js` only requires
    `packages/<name>/package.json`, `.claude-plugin/plugin.json` and `marketplace.json` to agree (permitted
    exceptions), and `f0c8abfc`, the closest precedent (a previous `permitter` fix), touched only
    `packages/permitter/CHANGELOG.md` with no version bump and no root `CHANGELOG.md` entry. This run follows
    that precedent. No action.

Re-read after fixing: `git diff dev...HEAD` was reviewed once more (see Verification). The two fixes add one
guard and five tests; they introduce no new violation of the rules above — no generated mirror was touched
(`npm run generate:validate` still reports the artifacts in sync), no test was weakened or deleted, no prompt
wording is pinned, and no new undocumented knob was introduced.

## Fixed

- `packages/permitter/hooks/permitter.js` (`emitDenyForCommands`, ~line 269) — the deny message was built as
  `` (matched deny rule ${pattern}) `` where `pattern` is `string | null` (the return type of
  `findDeniedPattern`, which resolves a matched *command string* back to the rule that produced it). A
  template literal silently renders `null` as the text `null`, so a rule that matches through a variant the
  reverse lookup does not reproduce would tell the user the denylist rule was `null` instead of hiding the
  detail. This is the one place in the diff where a value the code admits it may not have is rendered as if
  it were present. Changed to append the clause only when a rule was actually resolved:
  `` `Permitter blocked "${truncateForMessage(cmd.command)}"${pattern ? ` (matched deny rule ${pattern})` : ''}` ``.
  The Bash deny test in `packages/permitter/tests/hook-contract.test.js` still asserts the rule name appears
  (`expect(message).toContain(DENY_RULE)`) and passes, so the resolved case is unchanged.
- `packages/permitter/tests/hook-contract.test.js` (new `describe` block, +76 lines) — added the missing
  MCP-branch coverage that the Bash branch already had: a denylist hit on an `mcp__*` tool returns
  `behavior: 'deny'` naming the rule, never emits `"behavior":"ask"`, and truncates a long tool input so the
  message stays bounded (`/permitter:deny/` and a 200-char cap). The assertions reuse the file's existing
  `runHook` helper and `readDecision`; no existing assertion was modified.

## Declined

- `docs/PRD/completed/permitter.md:103` (Major, carried) — the finding is accurate but the file is an
  *archived* PRD, untouched by this run, and its divergence from the shipped hook predates this change: the
  PRD also specifies `PERMITTER_ENABLED` opt-in, `PERMITTER_LOG` and the `PreToolUse` event, none of which the
  shipped hook ever implemented (it reads only `ENSEMBLE_PERMITTER_DISABLE` / `PERMITTER_DEBUG` and is enabled
  by default). The run's own surfaces — README, `CHANGELOG.md`, `docs/HOOKS_GUIDE.md`,
  `docs/guides/environment-variables.md`, `docs/TRD/permitter.md` §7.1 — all describe the new
  allow/deny/defer contract correctly. Reconciling a whole archived PRD is a separate documentation task, not
  a defect in this diff; carried forward unresolved so a human decides whether to annotate or move it to
  `docs/TRD/completed/`.
- `packages/permitter/lib/allowlist-loader.js:42` (Minor, carried) — skipping a malformed settings file is the
  documented, deliberately chosen contract, recorded by this run in `packages/permitter/README.md` ("Malformed
  settings file | (none) | File skipped; other settings files still apply") and in
  `docs/TRD/permitter.md` §7.1 AC6. Changing it to a hard failure would *add* friction to every Claude Code
  tool call on a single bad settings file, and a "block" decision is not this hook's role for unrelated files.
  Out of this run's scope; carried forward unresolved for a human decision.
- `docs/TRD/permitter.md:1226` (Minor, carried) — real (neither `packages/permitter/docs/SECURITY.md` nor
  `docs/TROUBLESHOOTING.md` exists), but it is a planning deliverables checklist from the original TRD, and
  this run neither added nor renamed it. Deleting planned deliverables from a TRD is a scope decision for the
  package owner. Carried forward unresolved.
- `packages/permitter/hooks/permitter.js:176` (Minor, new) — `outputDecision(decision, exitCode = 0)`'s second
  argument is unreachable (every call site omits it and the shipped contract is "always exit 0"), but the
  parameter is exported through `module.exports.outputDecision` as part of the module's surface and predates
  this run; removing it is an unrelated API cleanup. Left alone.
- `packages/permitter/hooks/permitter.js:55` (Minor, new) — `DECISION.DENY` has no readers anywhere in the
  repo (the deny paths use `DECISION.buildDeny`). It is pre-existing dead data that this run did not add; the
  task's own constraint is that every changed line trace to the named defect, so it was left for a dedicated
  cleanup.
- `packages/permitter/README.md:83`, `packages/permitter/CHANGELOG.md:26`, `docs/TRD/permitter.md:450` (Major,
  new) — `PERMITTER_STRICT` is indeed read by no code, and `docs/guides/environment-variables.md` correctly
  omits it. But the three lines this run touched already label it honestly ("Reserved; not read"), and the
  unread knob predates this run on `dev`; deleting the name from the README, changelog and TRD — or
  implementing it — is a separate decision from the quoted-path / invalid-`ask` defect this run was scoped to.
  Carried forward unresolved.
- `docs/TRD/permitter.md:31` (Minor, new) — the stale "Default State | Disabled" row is pre-existing and sits
  in the TRD's original design-decisions table, which this run did not touch; the run added the correcting
  note at §7.1 (lines 1059-1062). Left for the separate TRD reconciliation above. Carried forward unresolved.
- Version sync / root changelog (checked, no finding) — see Findings item 11.

## Verification

Commands run in this phase, from the repository root unless noted, with real exit codes:

| Command | Exit | Result |
| --- | --- | --- |
| `git diff --stat dev...HEAD` | 0 | 11 files, 790 insertions, 130 deletions (pre-fix) |
| `npm run generate:validate` | 0 | `✓ Generated files are in sync` |
| `npm run validate` | 0 | `Validation passed: generated artifacts, lint, markdown, package metadata` |
| `npx jest tests/hook-contract.test.js` (packages/permitter, pre-fix) | 0 | 21 passed |
| `npx jest tests/security.test.js tests/hook-contract.test.js` (packages/permitter) | 0 | 2 suites, 84 passed |
| `npx jest` (packages/permitter, full package run) | 0 | 8 suites, 574 passed |
| `npx markdownlint-cli2 docs/reports/foreman-ensemble-pdf-f6a2-permitter-hook-impl/REVIEW_REPORT.md` | 0 | no violations |
| `npx jest tests/hook-contract.test.js` (packages/permitter, post-fix) | 0 | 26 passed (21 existing + 5 new) |
| `npx jest` (packages/permitter, full package run, post-fix) | 0 | 8 suites, 579 passed |
| `npm run generate:validate` then `npm run validate` (post-fix, repo root) | 0, 0 | in sync / validation passed |
| `git diff --stat dev...HEAD` (post-fix re-read) | 0 | 11 files, 866 insertions, 130 deletions; no new rule violation |

Notes. No timing-sensitive suite (`toolchain-detect.test.js`, `performance.test.js`) failed, so no re-run in
isolation was needed. `packages/permitter/tests/` has no `permitter.test.js`, so nothing pre-existing pinned
`behavior: 'ask'`; the run's `hook-contract.test.js` asserts against spawned-hook stdout only and pins no
prompt wording, per `CONTRIBUTING.md`. `npm run generate` / `npm run generate:pi` were not re-run because this
phase edited no generated source — `npm run generate:validate` confirms the mirrors are in sync. The previous
phase's `REVIEW_CODERABBIT_REPORT.md` at `HEAD` (30 lines) carries no `FOREMAN_REVIEW_FINDINGS_*` markers; its
three bullets were recovered from the same path in the parent commit `ebd198ae` (lines 266-270) and are all
carried into the block below. `foreman_task_add_comment` remained unavailable in this phase ("Task
external_id is malformed"), so progress was reported via `foreman_inbox_send` only.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
- `docs/PRD/completed/permitter.md:103` Major — the archived PRD still documents a `PreToolUse` hook with the
  exit-1 defer protocol as current, which contradicts the shipped `PermissionRequest` allow/deny/defer contract
  and needs an explicit supersede annotation.
- `docs/PRD/completed/permitter.md:54` Major — the same PRD specifies `PERMITTER_ENABLED`, `PERMITTER_LOG` and
  an opt-in default that no shipped code implements (`packages/permitter/hooks/permitter.js` reads only
  `ENSEMBLE_PERMITTER_DISABLE` and `PERMITTER_DEBUG`), so the PRD overstates the package's configuration surface.
- `packages/permitter/README.md:83` Major — `PERMITTER_STRICT` is declared in `packages/permitter/README.md:83`,
  `packages/permitter/CHANGELOG.md:26` and `docs/TRD/permitter.md:450` but read by no code, so a human must
  decide whether to implement it or drop the name from all three docs.
- `docs/TRD/permitter.md:31` Minor — "Default State | Disabled | User explicitly opts in via env var" still
  contradicts the enabled-by-default hook and the correcting note the same file adds at §7.1.
- `docs/TRD/permitter.md:1226` Minor — the deliverables list names `packages/permitter/docs/SECURITY.md` and
  `packages/permitter/docs/TROUBLESHOOTING.md`, neither of which exists in the package.
- `packages/permitter/lib/allowlist-loader.js:42` Minor — a malformed settings file is skipped silently, so a
  human should confirm that fail-open-on-unrelated-file is the intended contract rather than a surfaced warning.
<!-- FOREMAN_REVIEW_FINDINGS_END -->
