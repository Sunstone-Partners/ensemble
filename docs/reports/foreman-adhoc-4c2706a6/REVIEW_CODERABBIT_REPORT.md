# CodeRabbit review — TRD-012 (`implement bead-health`) — task `adhoc-4c2706a6`

Run `run-624e65078370c09d2be8b50f89887ee1` · base branch `dev` (`$FOREMAN_BASE_BRANCH`) ·
reviewed range `dev...foreman/adhoc-4c2706a6/run-624e65078370c09d2be8b50f89887ee1`
(2 engine sources, 1 verb test, 1 tracker-stub fixture, the generated Pi mirror, the bundle
smoke test, and the phase reports).

## Review engine

Command, run from the worktree root in every round:

```
coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"
```

`FOREMAN_BASE_BRANCH` was set to `dev`, so the diff base is the branch this run was cut from.
Three rounds were run; each finished with `{"type":"complete","status":"review_completed",
"outcome":"completed"}` and exit code 0. Logs (outside the repo):
`~/.omp/ensemble-engine-trd/review/cr-round1.txt`, `cr-round2.txt`, `cr-round3.txt`.

CodeRabbit reported most findings against the generated mirror
`packages/pi/vendor/lib/engine/...`. That mirror is byte-for-byte identical to
`packages/development/lib/engine/...` (`scripts/tests/ensemble-bundle-smoke.test.js`, 13/13 green),
so every fix was made in the source and the mirror was regenerated with `npm run generate:pi`.
The findings below are listed with their source paths; the lines are the ones CodeRabbit
reported, which are the same lines in the source because the two files are identical.

## Rounds

| round | findings | severity | fixed | declined |
|---|---|---|---|---|
| 1 | 3 | 3 × minor | 2 | 1 |
| 2 | 4 | 4 × minor | 3 | 1 |
| 3 | 2 | 2 × major | 0 | 2 |

**Round 1** — "Require dependency coverage for every scoped bead" (fixed); "Match live edges
against the selected bead IDs" (fixed); "Match the parsed task prefix before resetting status"
(declined).

**Round 2** — "Validate dependencies for every `tracker.show` response" (fixed); "Verify the
original target IDs, not only the label count" (declined); "Guard null rows before reading
`issue.title`" (fixed); "Correct the write-free refusal guarantee in the header" (fixed — the
header claim; its two further suggestions are declined below).

**Round 3** — "Restore the `unavailableWarning` export" (declined, stale); "Include closed beads
when resolving `--reset-task`" (declined, the plan defers that fallback).

Nine findings in total: five fixed, four declined.

## Fixed

**F1 — the live-edge reader trusted `tracker.list` when only some scoped rows carried links**
· file `packages/development/lib/engine/verbs/implement-bead-health.js` (fast path, now line 72)
· wrong: `if (fromRows.length > 0)` accepted the list as the live edge set as soon as one scoped
row carried a `dependencies` array. A row without the field contributes no edge, so every planned
edge that runs through such a row was reported as missing — the false drift the plan's D7
rationale forbids ("an unreadable tracker must not report every edge as missing").
· changed: the list is trusted only when **every** scoped row carries its links
(`beads.length > 0 && fromRows.length === beads.length`); otherwise the verb falls through to the
per-bead `tracker.show` read it already had.
· pinned by the new test "a tracker whose list carries the links of some beads only is read bead
by bead too".

**F2 — a live edge of a duplicate-prefix bead was credited to the selected bead**
· file `packages/development/lib/engine/verbs/implement-bead-health.js` (now line 154)
· wrong: `diffEdges` mapped live edges from bead id to title prefix, so with two beads carrying
the same task prefix the edge of the second bead satisfied the planned edge of the first and a
genuinely missing edge was not reported.
· changed: a live edge is compared only when both of its endpoints are the beads the prefix
cache selected (`if (idByPrefix.get(blocked) !== blockedId || idByPrefix.get(blocker) !==
blockerId) continue;`).
· pinned by the new test "a live edge of a bead sharing a prefix is not credited to the selected
bead".

**R2-F1 — a `tracker.show` answer without `dependencies` was read as "no links"**
· file `packages/development/lib/engine/verbs/implement-bead-health.js` (now line 104)
· wrong: only the first answer was checked for an array `dependencies`; a later answer that
omitted the field was read as an empty edge set, so the planned edges of that bead were reported
as missing instead of the tracker being reported as unreadable.
· changed: every answer is checked the same way; an answer without the links ends the read with
`EDGES.checked:false`, a reason naming the bead, one warning (`MESSAGES.edgesUnreadable`) and
empty `missing`/`extra`.
· pinned by the new test "a tracker whose show answers for some beads only says so instead of
reporting drift".

**R2-F3 — a list row that is not an issue was read as one**
· file `packages/development/lib/engine/verbs/implement-bead-health.js` (`resetTask` candidate
filter, now line 458)
· wrong: `issue && issue.title == null ? '' : issue.title` binds as
`issue && (issue.title == null)`, so a null row took the else branch and the filter threw a
TypeError while reading `issue.title`.
· changed: a row that is not an object is skipped; the title is read from the object it belongs
to.
· pinned by the new test "a tracker whose list carries a row that is not an issue is not read as
one".

**R2-F4a — the header claimed a refused run has written nothing**
· file `packages/development/lib/engine/verbs/implement-bead-health.js` (line 16)
· wrong: the header said "a run that refuses has written nothing", which is false for a
`--foreman` refusal: that mode tags beads and syncs before it counts the label, so a refusal can
follow tags the tracker already stored.
· changed: the header now says that a refusal before the first write leaves the tracker as it
was, while a refusal inside `--foreman` can follow stored tags, and that the messages name the
bead it stopped at and the counts the tracker reports.
· the finding's two further suggestions are declined below.

Test-support changes that belong to these fixes (fixture
`packages/development/tests/fixtures/engine/tracker-stub.js`): the stub's `list` verb can now
hide the links of named rows (`stripListDependenciesFor`), its `show` verb can hide them as well
(`stripShowDependenciesFor`), and its `list` verb can answer with a row that is not an issue
(`nullRowInList`). These are the shapes the findings describe.

## Declined

**F3 — "Match the parsed task prefix before resetting status"**
· file `packages/development/lib/engine/verbs/implement-bead-health.js` (line 438)
· the finding: the `title.includes(...)` filter selects a bead that merely mentions the marker in
its prose.
· reason: the behaviour is the contract, not a defect of this implementation.
`docs/TRD/TRD-2026-d571763f-ensemble-engine-cli.md:419` says "beads whose title contains
`[trd:<slug>:task:<id>]` are selected"; the plan pins it twice
(`PLAN-pr3b-workpackages.md:209`: "beads whose title contains `[trd:<slug>:task:<id>]` (exact,
case-sensitive, closing bracket included)" and `:458`: "candidates whose
`title.includes('[trd:<slug>:task:<id>]')`"); and the skill the verb reproduces says the same
(`packages/development/skills/implement-trd-tasks-reference/SKILL.md`, the `--reset-task TRD-XXX`
bullet: "pick beads whose title contains `[trd:<slug>:task:<ID>]`"). Narrowing the match to a
title *prefix* changes which bead gets reopened — a write — and would contradict the AC the TRD
states. The round-1 change that narrowed it was therefore reverted; only the null-row guard
(R2-F3) remains. The pinned rule is now pinned by a test: a bead that mentions the marker in
prose matches as well, so a second match is `REFUSED` as ambiguous and no bead is reopened.
· residual, for the operator: under the pinned "contains" rule, a bead whose title mentions the
marker in prose **and** is the only match would be reopened. The scaffold always puts the marker
in the title prefix, so the normal path is unaffected; removing the hazard is a change to the
TRD's rule and belongs to the plan, not to this review.

**R2-F2 — "Verify the original target IDs, not only the label count"**
· file `packages/development/lib/engine/verbs/implement-bead-health.js` (line 416)
· the finding: the `foreman-exec` completeness check compares a `tracker.list` count with the
number tagged instead of verifying the ids that were tagged.
· reason: `TRD-2026-d571763f-ensemble-engine-cli.md:420` pins the count comparison ("a
`tracker.list` count for that label that differs from the number tagged is `REFUSED` with
`foreman-exec tagging incomplete`"), and the plan pins the same sequence and the same message.
An id-based criterion replaces the AC's criterion with a stricter one and changes the message
contract. It is a different rule, not a defect in this one.

**R2-F4b and R2-F4c — the failure details of a `--foreman` refusal, and rolling tags back**
· file `packages/development/lib/engine/verbs/implement-bead-health.js`
· the finding: add the ids that were already tagged to the failure details, and roll the tags
back when the count does not match.
· reason: the plan pins the exact refusal calls and their details
(`PLAN-pr3b-workpackages.md:455`: `refused('FOREMAN_TAGGING_FAILED',
MESSAGES.foremanTaggingFailed(prefix, message), {titlePrefix})` and
`refused('FOREMAN_TAGGING_INCOMPLETE', MESSAGES.foremanTaggingIncomplete(tagged, listed),
{tagged, listed})`), and the messages are the skill's own words, which the task prompt forbids
rewording. A rollback would add a compensating write the plan does not specify. The accurate
part of the finding — that a refusal can follow stored tags — is fixed in the header (R2-F4a).

**R3-F1 — "Restore the `unavailableWarning` export"** (major)
· file `packages/development/lib/engine/messages.js` (line 376)
· the finding: the `unavailableWarning` export is missing from the engine messages module.
· reason: stale. `unavailableWarning` is defined at `messages.js:183` and exported at `:377` in
the source, and at the same lines in the generated mirror
(`packages/pi/vendor/lib/engine/messages.js:183` and `:377`);
`typeof require(...).unavailableWarning === 'function'` holds for both. Nothing was changed.

**R3-F2 — "Include closed beads when resolving `--reset-task`"** (major)
· file `packages/development/lib/engine/verbs/implement-bead-health.js` (line 450)
· the finding: a `tracker.find-by-key` fallback would let a closed bead be found and reopened.
· reason: the plan's escalation 13 (`PLAN-pr3b-workpackages.md:583`) states the default this
phase was told to adopt: "`--reset-task` on kata finds open beads only (`tracker.list` is
open-only there): a closed kata bead reports `RESET_TASK_NOT_FOUND`. Default: replicate the
recipe of REF:69; a `find-by-key` fallback is a later change." The finding asks for exactly the
fallback the escalation defers.

## Verification

Every command was run with `env -u FOREMAN_ARTIFACT_PATH`: the repo's toolchain ledger mirrors a
failing side-effecting capability's record into that path and would overwrite this report.

| command (from the repo root unless stated) | exit | result |
|---|---|---|
| `cd packages/development && npx jest tests/engine-implement-bead-health.test.js` | 0 | 36/36 passed (350 s) |
| `cd packages/development && npx jest tests/engine-implement-scaffold.test.js tests/kata-pr3-shippable.test.js tests/kata-pr5-shippable.test.js tests/toolchain-cli.test.js` | 0 | 85/85 passed |
| `npx jest scripts/tests/ensemble-bundle-smoke.test.js` | 0 | 13/13 passed (mirror is byte-for-byte) |
| `npm run generate:pi` | 0 | mirror regenerated, no Pi version bump |
| `npm run generate:validate` | 0 | "✓ Validation passed (64 files)" |
| `npm run validate` | 0 | "✓ All plugins validated successfully" (pre-existing prompt word-budget warnings only) |
| `npx eslint` on the four changed files | 0 | 0 errors (three of the four are in the repo's eslint ignore set; the test file is clean) |
| `cd packages/development && npx jest` (whole package) | 1 | 13546 passed, 2 failed — see below |

Red-before-green for every fix (each test was run against the unfixed code first):

* F1 — "a tracker whose list carries the links of some beads only is read bead by bead too": red
  with `EDGES.source` `list` and the planned edge listed as missing.
* F2 — "a live edge of a bead sharing a prefix is not credited to the selected bead": red with
  `EDGES.missing` empty.
* R2-F1 — "a tracker whose show answers for some beads only says so instead of reporting drift":
  red with `Expected: false / Received: true` on `EDGES.checked`.
* R2-F3 — "a tracker whose list carries a row that is not an issue is not read as one": red with
  `Expected: 0 / Received: 6` on the exit code (the TypeError).
* The prose-bead test written in round 1 was **replaced** when F3 was declined: it now pins the
  documented rule (a prose mention matches, a second match is `REFUSED` as ambiguous, nothing is
  reopened) instead of the behaviour the finding asked for.

The two failures of the whole-package run are not caused by this review:

* `tests/local-ci-adversarial.test.js` (1 failed, 70 passed) — reproduced with the three review
  files reverted (`git checkout --`), so it fails on the base tree too.
* `tests/kata-timeouts.test.js` — passes in isolation; it asserts wall-clock behaviour and flakes
  under the load of the full-package run.

Advisor consultation was unavailable in this environment (the Anthropic OAuth refresh returns
`400 invalid_grant`, "Refresh token expired"), so every triage decision above was made against
the TRD and the plan's pins instead.

The fixes are left uncommitted; Foreman commits this phase's work.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
{"schema": "foreman.review_findings/1", "reviewed": true, "findings": [{"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 68, "description": "The live-edge reader trusted tracker.list when only some scoped rows carried a dependencies array, so real edges were reported as missing drift.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 141, "description": "A live edge of a second bead carrying the same title prefix was credited to the selected bead, hiding a missing planned edge.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 438, "description": "The reset-task filter matched the task marker anywhere in a title, so a bead that mentions it in prose can be selected for reopening.", "disposition": "declined", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 103, "description": "A tracker.show answer that omitted dependencies was read as an empty edge set, reporting planned edges as missing instead of the tracker as unreadable.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 416, "description": "The foreman-exec completeness check compares a tracker.list count with the number tagged rather than verifying the tagged bead ids.", "disposition": "declined", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 447, "description": "The reset-task filter read issue.title on a list row that is not an issue, throwing a TypeError on the null-row shape.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 16, "description": "The module header claimed a refused run has written nothing, which is false for a --foreman refusal that follows tags the tracker already stored.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "major", "path": "packages/development/lib/engine/messages.js", "line": 376, "description": "The unavailableWarning export was reported missing from the engine messages module.", "disposition": "declined", "source": "coderabbit"}, {"severity": "major", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 450, "description": "Reset-task resolves beads only from the open list, so a closed bead is reported as not found.", "disposition": "declined", "source": "coderabbit"}]}
<!-- FOREMAN_REVIEW_FINDINGS_END -->
<!-- FOREMAN_RISK_JUDGEMENT_START -->
{"schema": "foreman.risk_judgement/1", "level": "MEDIUM", "rationale": "The five fixes are narrow and local (edge reader, reset-task filter, module header) and each is pinned by a test shown red before the fix and green after; the development suite is green apart from one failure reproduced on the base tree. MEDIUM rather than LOW because the edge reader is now stricter than the plan's list-ladder wording (disclosed in the report) and one finding was declined, leaving the TRD's 'title contains the marker' selection rule in place, so a bead that mentions the marker in prose can still be reopened when it is the only match."}
<!-- FOREMAN_RISK_JUDGEMENT_END -->
