# CodeRabbit review report — ensemble-pdf-f6a2-permitter-hook-impl

Run: `run-86255df946c9a098b47aa1ca3633e0db`
Workflow: `fix` · Phase: 2 (coderabbit-review) · Base branch: `dev`
Worktree: `/Users/ldangelo/.foreman/worktrees/ensemble/ensemble-pdf-f6a2-permitter-hook-impl/run-86255df946c9a098b47aa1ca3633e0db/workspace`

## Review engine

The CodeRabbit CLI was available and ran successfully; no authentication error occurred.

```
$ coderabbit review --agent --base dev        # run from the worktree root, once per round
coderabbit v0.9.6 (/Users/ldangelo/.local/bin/coderabbit)
```

Exit code `0` in every round. The `foreman_inbox_send` progress tool was available and was used for
the phase-completion note (`message_id msg_Sf6jt0BmUu0wU1wa1H5zVw`); `foreman_task_add_comment`
was also available but failed with `Error: Task external_id is malformed`, so no Work Log comment
was added. The engine reviewed the working tree against `dev`
(`$FOREMAN_BASE_BRANCH=dev`), i.e. it saw this run's committed phase-1 work **and** the phase-2
fixes; the reviewed file set was the same in all three rounds — the ten files that differ from
`dev`:

```
docs/HOOKS_GUIDE.md
docs/TRD/permitter.md
docs/guides/environment-variables.md
docs/reports/foreman-ensemble-pdf-f6a2-permitter-hook-impl/FIX_REPORT.md
packages/full/hooks/hooks.json
packages/permitter/CHANGELOG.md
packages/permitter/README.md
packages/permitter/hooks/hooks.json
packages/permitter/hooks/permitter.js
packages/permitter/tests/hook-contract.test.js
```

## Rounds

Three rounds were run (the maximum allowed). **7 findings received; every finding is accounted for
below, one row per finding:**

- **5 fixed outright** — R1-1, R1-2, R2-1, R3-1, R3-2.
- **R2-2** — fixed in its documentation half (the TRD described a hook event the code does not use);
  its proposed remediation (switching the hook to the `PreToolUse` schema) declined — see `D1`.
- **R2-3** — declined in its proposed remediation; its documentation half was sharpened instead
  (F6) — see `D2`.

Finding locations in the tables below are the locations CodeRabbit reported, i.e. against the file
as it stood in that round; live line numbers for the code are cited in the `Fixed` section.

### Round 1 — 2 findings (2 minor)

| # | Location | Finding | Outcome |
|---|---|---|---|
| R1-1 | `packages/permitter/tests/hook-contract.test.js:57` | Reset the disable flag in the child environment. | **Fixed** (F1) |
| R1-2 | `docs/TRD/permitter.md:347` | Update the executable example to match the new output contract. | **Fixed** |

### Round 2 — 3 findings (3 major)

| # | Location | Finding | Outcome |
|---|---|---|---|
| R2-1 | `docs/TRD/permitter.md:411` | Check every command for deny rules before deferring. | **Fixed** (F3) |
| R2-2 | `docs/TRD/permitter.md:353` | Use the PreToolUse decision schema. | **Fixed** in its documentation half (F4) / **Declined** in its proposed remediation (D1) |
| R2-3 | `docs/TRD/permitter.md:909` | Do not describe error deferral as fail-closed in `bypassPermissions` mode. | **Declined** in its proposed remediation (D2); its documentation half was sharpened (F6) |

### Round 3 — 2 findings (2 minor)

| # | Location | Finding | Outcome |
|---|---|---|---|
| R3-1 | `docs/TRD/permitter.md:275` | Show the denylist scan before the allowlist scan. | **Fixed** |
| R3-2 | `docs/TRD/permitter.md:916` | Correct the settings-error guarantee. | **Fixed** (documentation only) |

Round 3 produced no `Critical` or `Major` finding, so the rounds stopped there as instructed.

After the rounds an advisor pass over this report flagged two remaining doc/code
inconsistencies that the CodeRabbit rounds had not covered. They are recorded as F7 so the
delivered documents describe the hook that actually ships.

## Fixed

### F1 — `packages/permitter/tests/hook-contract.test.js:63` (R1-1)

* **What was wrong:** `runHook` built the child environment as
  `{ ...process.env, HOME, PERMITTER_DEBUG, ...opts.env }`, so an operator-exported
  `ENSEMBLE_PERMITTER_DISABLE=1` was inherited by the hook. The hook then deferred before any
  permission decision, and 10 of the 21 allow/deny assertions failed for reasons that had nothing
  to do with the hook's behaviour.
* **What changed:** the child environment now resets the flag before the per-test overrides:
  ```js
  env: {
    ...process.env,
    HOME: sandboxHome,
    PERMITTER_DEBUG: '0',
    // Keep the run hermetic: an operator-exported disable flag would make
    // every hook call defer. The disabled-hook test re-sets it via opts.env.
    ENSEMBLE_PERMITTER_DISABLE: '0',
    ...opts.env,
  },
  ```
  The disabled-hook test still passes `ENSEMBLE_PERMITTER_DISABLE: '1'` through `opts.env`, which
  wins because `...opts.env` is spread last (`packages/permitter/tests/hook-contract.test.js:121`).

### F2 — `docs/TRD/permitter.md:347` (R1-2)

* **What was wrong:** the §4.1 "Interface" example still implemented the old protocol — `return 1`
  to defer, `return 0` to allow, `process.exit(1)` on error — and never emitted a decision object.
  Appendix C also still claimed `- stdout: Ignored`, contradicting the shipped hook, which writes
  the `PermissionRequest` decision to stdout.
* **What changed:** the example now mirrors the shipped hook: a `decision(behavior, message)`
  helper builds `{ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } }`,
  `main()` returns the decision to print or `null` to defer, the caller prints the decision only
  when there is one and always exits `0`, and the header comment states "Exit code: 0 - Always.
  stdout carries the decision JSON; empty stdout defers to Claude Code's normal permission flow."
  Appendix C now reads "- stdout: PermissionRequest decision JSON (allow/deny); empty stdout
  defers" (`docs/TRD/permitter.md:1295`).

### F3 — `docs/TRD/permitter.md:411` (R2-1)

* **What was wrong:** the example evaluated the denylist and the allowlist in one per-command loop,
  so `git status && sudo whoami` appeared to defer on the unmatched `git status` before ever
  reaching the denied `sudo`. The shipped hook already scans the **whole** denylist over **all**
  extracted commands first (`packages/permitter/hooks/permitter.js:259`), so the documentation
  was behind the code.
* **What changed:** the example now has a deny pass over every command followed by an allowlist
  pass over every command, matching the shipped order and the shipped comment "Checking the whole
  denylist before the allowlist keeps a denied command from being masked by an earlier command
  that misses the allowlist".

### F4 — `docs/TRD/permitter.md:353` (R2-2, doc/code half)

* **What was wrong:** the TRD described the hook as a `PreToolUse` hook in five places
  (`:10`, `:16`, `:174` flow diagram, `:1260` Appendix C heading, `:1312` Appendix E
  `hooks.json` snippet), while both shipped hook definitions register a **`PermissionRequest`**
  hook (`packages/permitter/hooks/hooks.json`, `packages/full/hooks/hooks.json`) and the hook
  answers with the `PermissionRequest` decision schema. The document and the code disagreed.
* **What changed:** all five TRD references now say `PermissionRequest`, and
  `packages/permitter/README.md:22` no longer calls the hook a `PreToolUse` hook. The
  remediation proposed by the engine (switching the hook to the `PreToolUse` schema) was declined —
  see `Declined`.

### F5 — `docs/TRD/permitter.md:275` (R3-1)

* **What was wrong:** the §3.2 "Matching Pipeline" diagram still showed a single per-command
  decision flow, so a reader would conclude that `unknowncmd && rm -rf build` defers at
  `unknowncmd` and never reaches the deny rule — the opposite of the shipped behaviour.
* **What changed:** the diagram box now reads
  ```
  |   1. Denylist pass over ALL commands:                       |
  |        deny on the first match                              |
  |   2. Allowlist pass over all commands:                      |
  |        no match -> exit 0, no output (defer to normal flow) |
  ```

### F6 — `docs/TRD/permitter.md:916` and `packages/permitter/README.md:214` (R3-2)

* **What was wrong:** both documents claimed that a settings-file error always defers. In fact
  `loadJsonFile` catches a malformed/unreadable file and returns `null`, the allow/deny list
  loaders skip that file and merge the rest
  (`packages/permitter/lib/allowlist-loader.js:42-52`), so a command allowed by *another*
  settings file can still be auto-approved. The guarantee was overstated.
* **What changed:** the tables now distinguish the two cases — "Malformed settings file | (none) |
  File skipped; other settings files still apply" and "Settings load exception | (empty) | Normal
  permission flow" — and both documents state that only an unexpected exception while loading the
  settings defers. The §5.3 lead-in was sharpened to "The hook implements **fail-closed** security:
  a command it could not parse or evaluate is never auto-allowed", and the acceptance criterion
  `AC6` reads "Fail-closed on errors (a malformed settings file is skipped, not fatal)"
  (`docs/TRD/permitter.md:1054`). The loader's behaviour was deliberately **not** changed: it is
  intentional, covered by `packages/permitter/tests/allowlist-loader.test.js` ("should skip
  malformed files and continue"), and outside this run's scope.

### F7 — `docs/TRD/permitter.md` and `packages/permitter/README.md` (advisor pass, not a CodeRabbit finding)

* **What was wrong:** two inconsistencies between the documents and the shipped hook survived
  the CodeRabbit rounds. (a) The TRD still used the `PERMITTER_ENABLED` master switch (opt-in) in
  the §2 flow diagram (`:185`), the §4.1 example (`:368`), the environment table (`:448`) and the
  Sprint-1 exit criteria (`:984`), while the shipped hook is **enabled by default** and is turned
  off with `ENSEMBLE_PERMITTER_DISABLE=1` (`packages/permitter/hooks/permitter.js:194-200`) — the
  opposite polarity, so the example could not be run verbatim. (b) The §7.2 test matrix and the
  §11.2 deliverables checklist / Appendix D file tree pointed at `permitter.test.js`, a file that
  does not exist in the package.
* **What changed:** the diagram, the example, the environment table and the Sprint-1 criteria now
  use `ENSEMBLE_PERMITTER_DISABLE`; §7.1 keeps AC1's PRD wording ("Disabled by default") and adds
  a note that the shipped hook is enabled by default and is disabled with
  `ENSEMBLE_PERMITTER_DISABLE=1`, so the PRD mapping stays traceable; §7.2 now cites real test
  locations (`hook-contract.test.js::disabled hook defers silently instead of asking`,
  `hook-contract.test.js::allow-path behavior is unchanged`,
  `security.test.js::Security: Fail-Closed Behavior`) and marks the debug-output row as having no
  test yet; the deliverables checklist and the file tree name `hook-contract.test.js` instead of
  `permitter.test.js` (also `packages/permitter/README.md:846`).

## Declined

### D1 — `docs/TRD/permitter.md:353` — proposed schema switch (part of R2-2)

* **Finding:** "Use the PreToolUse decision schema … Claude Code expects `hookEventName:
  "PreToolUse"` with `permissionDecision` for that event."
* **Reason declined:** the shipped hook deliberately implements the `PermissionRequest`
  contract — that is the whole point of this run (the reporter finding is about the
  `PermissionRequest` hook, and Claude Code accepts only `allow`/`deny` from it — the version
  reported by this task's reporter finding is 2.1.322). Switching
  the hook to `PreToolUse` would move the decision off the permission-request path and, for the
  error cases the finding also proposes, would require emitting `ask` again — the invalid output
  this task exists to remove. The genuine defect the finding pointed at (documentation calling a
  `PermissionRequest` hook a `PreToolUse` hook) was fixed instead — see F4.

### D2 — `docs/TRD/permitter.md:909` — `bypassPermissions` fail-closed labelling (R2-3)

* **Finding:** "Do not describe error deferral as fail-closed in `bypassPermissions` mode … in that
  mode Claude Code shows no permission dialog and the PermissionRequest hook does not run, so stdout
  is never read and a parse error defers to a flow that runs the command … enforce it in an
  always-running PreToolUse hook (returning deny/ask on errors) or state that the guarantee applies
  only when a dialog is shown."
* **Reason declined:** the proposed remediation contradicts this run's scope: it needs a different
  hook event (`PreToolUse`) and an answer of `deny`/`ask` on errors — and `ask` is exactly the
  invalid behavior this task removes from the hook (Claude Code accepts only `allow`/`deny` from a
  `PermissionRequest` hook — version reported by this task: 2.1.322). `bypassPermissions` is also
  not a mode this repository supports
  or documents: `grep -rn "bypassPermissions" packages/permitter docs` returns no match, and the
  only permission mode in the repo is `--permission-mode` with the values `acceptEdits`, `default`,
  `plan` (`evals/lib/runners/claude.js:45`).

  What the finding got right — and what was applied — is that the fail-closed wording was too
  strong. Two statements in the docs were overstated and are now precise:

  - The guarantee is bounded by where the hook runs: §5.3 now says it is "limited to the situations
    in which the hook runs and Claude Code asks for permission", and only an unexpected exception
    while loading the settings defers (F6).
  - **A malformed or unreadable settings file is skipped, not fatal.** That is fail-open for
    security purposes: the remaining settings files still apply, so a command allowed by *another*
    settings file can still be auto-approved
    (`packages/permitter/lib/allowlist-loader.js:42-52`, covered by
    `packages/permitter/tests/allowlist-loader.test.js`). The docs now say so in the §5.3 table, in
    the README table and in AC6, and the PR body lists it under `## Risk`.

## Verification

Commands run from the repository root unless stated otherwise; exit codes are the real ones.

| Command | Exit | Result |
|---|---|---|
| `coderabbit review --agent --base dev` (round 1) | 0 | 2 findings, both minor; reviewed the ten changed files. |
| `coderabbit review --agent --base dev` (round 2) | 0 | 3 findings, all major; reviewed the ten changed files. |
| `coderabbit review --agent --base dev` (round 3) | 0 | 2 findings, both minor; reviewed the ten changed files; no Critical/Major finding → rounds stopped. |
| `npm run generate:validate` | 0 | `✓ Validation passed (64 files)`; the generated run-index mirrors still match a fresh build. |
| `npm run validate` | 0 | All validators passed. The `⚠` notices are pre-existing "skill is below baseline" warnings from unrelated skills (`assess-config`, `completion-verification`, `ensemble-beads-build`, `ensemble-fix-issue`, `ensemble-implement-bead`, `ensemble-new-feature`, `pr-review-cycle`). |
| `cd packages/permitter && npx jest tests/hook-contract.test.js` | 0 | Test Suites: 1 passed; Tests: 21 passed (21 total). |
| `cd packages/permitter && npx jest` | 0 | Test Suites: 8 passed, 8 total; Tests: 574 passed, 574 total. |
| `git checkout dev -- packages/permitter/hooks/permitter.js packages/permitter/hooks/hooks.json packages/full/hooks/hooks.json && cd packages/permitter && npx jest tests/hook-contract.test.js` | 1 | Failing-first proof for this run's own change: 19 failed, 2 passed (the new hook-contract tests are red on the old hook sources). Sources restored with `git checkout HEAD -- …` afterwards. |
| `ENSEMBLE_PERMITTER_DISABLE=1 npx jest tests/hook-contract.test.js` with F1 stashed | 1 | Failing-first proof for F1: 10 failed, 11 passed. |
| `markdownlint docs/TRD/permitter.md packages/permitter/README.md` | 1 | Both files already fail on `dev`: MD004 65, MD007 70, MD018 1, MD026 1, MD030 2, MD036 4, MD037 2, MD052 1, MD056 1 (147 findings). After the edits: MD004 69, MD007 74, MD018 1, MD026 1, MD030 1, MD036 4, MD037 2, MD052 1, MD056 1 (154 findings). Every MD004/MD007 hit (143 over 61 unique lines) is on a JavaScript sample line — the TRD writes its code fences as literal escaped backticks, so markdownlint parses the samples as markdown lists; `packages/permitter/README.md` has 0 such hits and no prose list was added by this change. The +8 delta is the larger §4.1 sample, and MD030 dropped by one. markdownlint is not part of the repo gate (`npm run validate`); `npm run lint:md` is a separate script. |
| `node --check` on the JavaScript blocks extracted from `docs/TRD/permitter.md` | 1 | Only the pre-existing sample blocks fail (regex char classes such as `/\$\\(/` and a `#!/usr/bin/env node` shebang inside a snippet). The rewritten §4.1 example itself parses. |

All four gates were re-run after the last edit to `FIX_REPORT.md` (its `Contract chosen` block and
the PR-body `## Risk` wording, the report files are inside the validator's `docs/reports/**` scan)
and returned the same exit codes: 0, 0, 0, 0. The only edit made after that re-run was to this
report's own text.

No generated mirror needed regeneration: the changed files are sources
(`packages/permitter/hooks/*`, `packages/permitter/{README,CHANGELOG}.md`, `docs/**`).
`packages/full/hooks/permitter.js` is a symlink to `packages/permitter/hooks/permitter.js`, so the
hook script has a single source of truth; `packages/full/hooks/hooks.json` and
`packages/permitter/hooks/hooks.json` are separate files and both were updated.

All changes are left **uncommitted** for Foreman to commit and open the PR against `dev`.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
- `docs/PRD/completed/permitter.md:103` Major — the completed PRD still documents Permitter as a PreToolUse hook that exits 1 to defer, so it no longer matches the shipped PermissionRequest contract and needs a separate docs reconciliation.
- `packages/permitter/lib/allowlist-loader.js:42` Minor — a malformed settings file is skipped rather than fatal, so another settings file can still auto-allow a command; the behaviour is intentional and test-covered, but a human may want to decide whether it should change.
- `docs/TRD/permitter.md:1226` Minor — the deliverables checklist and the file tree still list `packages/permitter/docs/SECURITY.md` and `packages/permitter/docs/TROUBLESHOOTING.md`, which do not exist in the package.
<!-- FOREMAN_REVIEW_FINDINGS_END -->
