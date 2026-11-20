# CodeRabbit Review Report — ensemble-pdf-f4-f5-jira-adapter-v2-r3

Run: `run-3502fb9eabc75f2b7ee006253aa1b31b` · Phase index 2 (`coderabbit-review`) · Base branch: `dev`

## Review engine

Command run from the worktree root:

```
coderabbit review --agent --base "dev"
```

CodeRabbit CLI 0.9.6 at `/Users/ldangelo/.local/bin/coderabbit`, exit code 0, terminal
JSONL record:

```
{"type":"complete","status":"review_completed","findings":0,
 "reviewedFiles":["docs/reports/foreman-ensemble-pdf-f4-f5-jira-adapter-v2-r3/FIX_REPORT.md"],
 "outcome":"completed","message":"Review completed"}
```

**This review is a null review, not a clean review.** `git diff --name-status dev...HEAD`
returns exactly one file:

```
A docs/reports/foreman-ensemble-pdf-f4-f5-jira-adapter-v2-r3/FIX_REPORT.md
```

`git diff --stat dev...HEAD` = `1 file changed, 2 insertions(+)`, and that file is 2 bytes
of whitespace (`cat -A` → two `$` lines) — the phase-1 deliverable was committed empty.
Phase-1 commits on this branch are `61e7470c [pi] Work in progress` and
`0da84c70 Foreman run run-3502fb9eabc75f2b7ee006253aa1b31b phase 1`; neither contains code.
CodeRabbit can only review code that exists on the branch, so `findings: 0` carries no
information about the task. Silence here must NOT be read as "the task is complete and
correct" — nothing of the task is on the branch yet.

## Rounds

### Round 1

- Findings received: 0 (terminal record `findings:0`, `reviewedFiles` = the empty
  `FIX_REPORT.md` only).
- Fixed: none — no Critical/Major findings existed to fix.
- Declined: none.
- Contract satisfied: stop early because no Critical or Major finding was fixed. No
  round 2 or 3 was run: re-reviewing the same one-file, zero-code diff would return the
  same null result.

### Pre-triage verification against the working tree (why the task is still open)

Because a 0-finding result on an empty diff is uninformative, the task's own named
defects were re-verified by hand on this tree at HEAD `0da84c70`:

- **F4 unimplemented.** `ls packages/full/bin` → `No such file or directory`. No `jira`
  executable is tracked anywhere in the repo (`git ls-files | grep '(^|/)bin/'` returns
  only `evals/skills/*/fixture/bin/*` fakes). So `binaries: - jira` /
  `allowlist: - bin: jira` in
  `packages/infrastructure/skills/adapter-tracker-jira/adapter.yaml:~27` and the health
  check `run: ["jira","--version"]` (~line 39) still resolve to a binary the bundle does
  not ship — `MISSING_BINARY: jira` in an installed plugin.
- **F5 unimplemented.** `grep -n "has no entry in parse.statusMap"
  packages/development/lib/toolchain/mapping.js` → still throws the bare message at
  `mapping.js:745` (`mapOutput: status value … has no entry in parse.statusMap`) with no
  mention of any user-settable config key. `grep -n "override"
  packages/development/toolchain/schemas/toolchain-config-schema.json` → no match; the
  schema is still `additionalProperties: false` with only string category→adapter
  selection, so a repo cannot extend `statusMap` or the write-side status names.
  `packages/infrastructure/skills/adapter-tracker-jira/adapter.yaml` still lists only the
  7 default statuses (To Do/Backlog/Open→open, In Progress/In Review→in_progress,
  Done/Closed→closed) and `tracker.set-status` still hardcodes `open → "To Do"`.
- **Skill note uncorrected.** `packages/infrastructure/skills/jira/SKILL.md` still says
  `**Tool**: jira CLI (installed globally via npm link from ~/utils/atlassian)`.

## Fixed

None. No CodeRabbit finding was valid against this branch, because the branch contains no
code for it to be valid against. No files were edited in this phase; the worktree is clean
apart from this untracked report, left for Foreman to commit.

## Declined

| # | Finding | Severity | File | Reason |
|---|---------|----------|------|--------|
| — | (none) | — | — | CodeRabbit returned `findings: 0`; there was nothing to triage. |

The unresolved items below are NOT CodeRabbit findings — they are the verified, still-open
defects carried forward from the task prompt and from phase 1 shipping empty. They are
listed so the next phase does not mistake the empty findings block for completion.

## Verification

| Command | Exit |
|---------|------|
| `coderabbit review --agent --base "dev"` | 0 |
| `git diff --stat dev...HEAD` | 0 (1 file, 2 insertions) |
| `git diff --name-status dev...HEAD` | 0 (`A …/FIX_REPORT.md`) |
| `cat -A docs/reports/foreman-ensemble-pdf-f4-f5-jira-adapter-v2-r3/FIX_REPORT.md` | 0 (2 bytes whitespace) |
| `ls packages/full/bin` | 2 (No such file or directory) |
| `grep -n "has no entry in parse.statusMap" packages/development/lib/toolchain/mapping.js` | 0 (hits at 745, 755) |
| `grep -n "override" packages/development/toolchain/schemas/toolchain-config-schema.json` | 1 (no match) |

No test or formatter run was applicable: this phase edited no source files. Per the phase
contract, the narrowest test command is scoped to changed files, and the changed set is
empty.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
- `docs/reports/foreman-ensemble-pdf-f4-f5-jira-adapter-v2-r3/FIX_REPORT.md:1` Critical — phase 1 committed a 2-byte empty report and zero code, so the entire F4/F5 deliverable (new `packages/full/bin/jira` executable, config-schema statusMap extension, failing-first tests, regenerated mirrors) is still unimplemented and this branch's diff vs `dev` is only that empty file.
- `packages/full/bin/jira:1` Critical — the bundle ships no `jira` binary at all (`ls packages/full/bin` → no such directory), so every Jira tracker call including the adapter's own health check `jira --version` fails with `MISSING_BINARY: jira` in an installed plugin.
- `packages/development/lib/toolchain/mapping.js:745` Major — a Jira status outside the 7 built-in defaults (e.g. "Code Review") still throws `mapOutput: status value … has no entry in parse.statusMap` (`BAD_OUTPUT`), and the message names no config key the user can set to fix it.
- `packages/development/toolchain/schemas/toolchain-config-schema.json:6` Major — the config schema is still `additionalProperties: false` with only string category→adapter selection, giving a repo no way to extend `parse.statusMap` or the write-side status names without duplicating the whole adapter under `.ensemble/adapters`.
- `packages/infrastructure/skills/adapter-tracker-jira/adapter.yaml:180` Major — `tracker.set-status` still hardcodes the write mapping `open → "To Do"`, `in_progress → "In Progress"`, `closed → "Done"`, which a custom Jira workflow may not contain.
- `packages/infrastructure/skills/jira/SKILL.md:10` Minor — the skill still documents `jira` as "installed globally via npm link from `~/utils/atlassian`" (a private package that 404s on npm) and names none of the `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` variables the new binary is supposed to authenticate from.
- `scripts/validate-all.js:840` Minor — the bundle-content validator enumerates only `['agents','commands','hooks','lib','skills']`, so a new `packages/full/bin/` directory would be unvalidated (and `scripts/vendor-bundle-deps.js` only writes `packages/full/lib/node_modules`); both need the `bin` case handled when F4 is implemented.
<!-- FOREMAN_REVIEW_FINDINGS_END -->
