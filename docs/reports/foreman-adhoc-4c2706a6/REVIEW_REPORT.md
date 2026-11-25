# Repository-rules review — `implement bead-health` (TRD-012)

Run `run-624e65078370c09d2be8b50f89887ee1`, task `adhoc-4c2706a6`, phase
`repo-rules-review` of the `implement-trd-slice` workflow.

## Review engine

- **Reviewer**: the repository-rules reviewer of this workflow phase. It applies
  this repository's own rules to the run's diff — the root `AGENTS.md`
  (generated-artifact policy), `CLAUDE.md` (regeneration and validation
  commands), `CONTRIBUTING.md` (pull-request checklist, changelog convention,
  pull-request size), `docs/standards/constitution.md` (Rules 1-9) — and the
  established idioms of the files the diff touches.
- **Diff reviewed**: `git diff "$FOREMAN_BASE_BRANCH"...HEAD` with
  `$FOREMAN_BASE_BRANCH=dev` — 19 files:
  `A docs/reports/foreman-adhoc-4c2706a6/{IMPLEMENT_1_REPORT.md,
  IMPLEMENT_2_REPORT.md, IMPLEMENT_3_REPORT.md, IMPLEMENT_4_REPORT.md,
  IMPLEMENT_5_REPORT.md, IMPLEMENT_6_REPORT.md, PLAN.md,
  REVIEW_CODERABBIT_REPORT.md}`, `M packages/development/lib/engine/groups/implement.js`,
  `M packages/development/lib/engine/messages.js`,
  `M packages/development/lib/engine/tracker.js`,
  `A packages/development/lib/engine/verbs/implement-bead-health.js`,
  `A packages/development/tests/engine-implement-bead-health.test.js`,
  `M packages/development/tests/fixtures/engine/tracker-stub.js`,
  `M packages/pi/vendor/lib/engine/groups/implement.js`,
  `M packages/pi/vendor/lib/engine/messages.js`,
  `M packages/pi/vendor/lib/engine/tracker.js`,
  `A packages/pi/vendor/lib/engine/verbs/implement-bead-health.js`,
  `M scripts/tests/ensemble-bundle-smoke.test.js`.
  No other range was reviewed; the phase's own fixes are the three files listed
  under **Fixed**.
- **Passes**: one read of that range against the repository's conventions; then
  the fixes below; then one re-read of the same range including the fixes, to
  confirm they introduce no new violation of the same rules.
- **Checks applied to the range**: error handling that reports a failure rather
  than hiding it behind a success value; a typed/structured boundary instead of
  ad hoc untyped data at the same interface; a declared configuration, manifest
  or enum value that no code reads; and documentation reconciled with the
  behaviour the diff adds, removes or renames.
- **Previous phase**: `docs/reports/foreman-adhoc-4c2706a6/REVIEW_CODERABBIT_REPORT.md`.
  Its 9 findings were re-verified against the code as it stands and carried
  forward into the findings block below, each keeping its original `source`.
- **Operator progress updates**: `foreman_inbox_send` and
  `foreman_task_add_comment` are not available in this phase, so no inbox note
  or task comment was sent; this report is the phase's only output.
- **Advisor**: an independent completion review was requested and could not
  run — the configured Anthropic credential fails to refresh (`HTTP 400
  invalid_grant`, "Refresh token expired"). The review below therefore rests
  on the repository evidence cited in it.

## Findings

Twelve findings: the 9 carried forward from the CodeRabbit phase, re-verified
here, and 3 raised by this review.

| # | Source | Severity | Finding | Disposition |
|---|--------|----------|---------|-------------|
| 1 | coderabbit | minor | The live-edge reader trusted `tracker.list` when only some scoped rows carried a `dependencies` array, so real edges were reported as missing drift (`implement-bead-health.js:68`). | fixed (previous phase) |
| 2 | coderabbit | minor | A live edge of a second bead carrying the same title prefix was credited to the selected bead, hiding a missing planned edge (`implement-bead-health.js:141`). | fixed (previous phase) |
| 3 | coderabbit | minor | A `tracker.show` answer that omitted `dependencies` was read as an empty edge set, reporting planned edges as missing instead of the tracker as unreadable (`implement-bead-health.js:103`). | fixed (previous phase) |
| 4 | coderabbit | minor | The reset-task filter read `issue.title` on a list row that is not an issue, throwing a `TypeError` on the null-row shape (`implement-bead-health.js:447`). | fixed (previous phase) |
| 5 | coderabbit | minor | The module header claimed a refused run has written nothing, which is false for a `--foreman` refusal that follows tags the tracker already stored (`implement-bead-health.js:16`). | fixed (previous phase) |
| 6 | coderabbit | minor | The reset-task filter matched the task marker anywhere in a title, so a bead that mentions it in prose can be selected for reopening (`implement-bead-health.js:438`). | declined — the TRD and the plan pin the rule as "the title contains the marker"; narrowing it would contradict the pinned wording |
| 7 | coderabbit | minor | The `foreman-exec` completeness check compares a `tracker.list` count with the number tagged rather than verifying the tagged bead ids (`implement-bead-health.js:416`). | declined — TRD-012 pins the count comparison |
| 8 | coderabbit | major | The `unavailableWarning` export was reported missing from the engine messages module (`messages.js:376`). | declined — stale: the export is present in the source and in the generated mirror |
| 9 | coderabbit | major | Reset-task resolves beads only from the open list, so a closed bead is reported as not found (`implement-bead-health.js:450`). | declined — plan escalation 13 defers the find-by-key fallback for closed beads |
| 10 | repo-rules | minor | The diff adds the user-facing `implement bead-health` verb and its three write flags but adds no changelog entry, which the repository's pull-request checklist requires (`CHANGELOG.md:16`). | fixed |
| 11 | repo-rules | nitpick | The `scopeBeads` JSDoc puts its prose paragraph between the `@param` tags and `@returns`, so it reads as part of the `@param slug` description instead of the function's own summary (`tracker.js:186`). | fixed |
| 12 | repo-rules | nitpick | The plan rows are read through `calls.json.creates \|\| []` and `calls.json.deps \|\| []`, so a malformed scaffold plan would degrade to an empty plan and report no drift (`implement-bead-health.js:536`). | declined — the contract guarantees arrays and the guard cannot fail |

## Fixed

1. **`CHANGELOG.md`** — what was wrong: the diff adds a user-facing verb
   (`ensemble implement bead-health <trd>`) and three write paths
   (`--label`, `--foreman`, `reset-task`) and the root `CHANGELOG.md` has an
   open `## [Unreleased]` → `### Added` section, but the diff left it
   untouched, while `CONTRIBUTING.md`'s pull-request checklist requires
   "CHANGELOG.md updated" (Keep a Changelog format). Nothing else in the
   repository documents the verb (no README or `docs/` page names it; the
   user-facing guide is a later TRD), so the changelog is the only place a
   user reads what the command does.
   What changed: one `### Added` entry at `CHANGELOG.md:16`, in the existing
   bold-lead-in style of its neighbours, stating accurately that the run
   changes nothing in the tracker unless `--label`, `--foreman` or
   `reset-task` is passed; that each write path refuses rather than reporting
   success when the tracker cannot do it; that `--label` writes through the
   ungated `beads-label` command rather than the toolchain's side-effect gate;
   and that the live edge diff needs a tracker whose list or `show` carries
   each bead's dependency links — the shipped `beads` and `kata` adapters
   carry none, so on those trackers the report answers `EDGES.checked: false`
   with a warning instead of claiming that no edge drifted.
2. **`packages/development/lib/engine/tracker.js`** — what was wrong: the
   `scopeBeads` JSDoc (line 186) put its prose paragraph *between* the
   `@param` tags and the `@returns` tag, so a doc reader (and a doc
   generator) sees the paragraph as part of the `@param slug` description;
   every other JSDoc block in the repository puts prose before the tags.
   What changed: the paragraph moved up into the prose block above the
   `@param` tags (`tracker.js:184-186`); the `@param` tags are now contiguous
   (`tracker.js:187-188`). Comment-only — no behaviour changed.
3. **`packages/pi/vendor/lib/engine/tracker.js`** — the generated mirror of
   fix 2, regenerated with `npm run generate:pi` from the repository root
   (never hand-edited, per `AGENTS.md`). `npm run generate:pi` changed only
   that file and did not bump the Pi version.

## Declined

1. **`packages/development/lib/engine/verbs/implement-bead-health.js:438`** —
   the finding: the reset-task filter matched the task marker anywhere in a
   title, so a bead that mentions it in prose can be selected for reopening.
   The reason: TRD-012's acceptance criteria
   (`docs/TRD/TRD-2026-d571763f-ensemble-engine-cli.md:419`) and the supplied
   plan both pin the rule as "the bead's title *contains*
   `[trd:<slug>:task:<id>]`", and the skill's own prose says "contains". A
   prose-mentioning title therefore matches by design: the behaviour is
   pinned, and the test at
   `packages/development/tests/engine-implement-bead-health.test.js:717`
   documents exactly that (the run is refused as ambiguous, listing both
   matches). Narrowing the match to an exact marker would contradict the TRD
   and the plan.
2. **`packages/development/lib/engine/verbs/implement-bead-health.js:416`** —
   the finding: the `foreman-exec` completeness check compares a
   `tracker.list` count with the number tagged rather than verifying the
   tagged bead ids. The reason: TRD-012's acceptance criteria (TRD line 420)
   pin the count comparison, and the supplied plan pins the same check.
3. **`packages/development/lib/engine/messages.js:376`** — the finding: the
   `unavailableWarning` export was reported missing from the engine messages
   module. The reason: stale — the export is present
   (`packages/development/lib/engine/messages.js:377`) in the source and in
   the generated mirror, and the reviewer's read of the file did not hold.
4. **`packages/development/lib/engine/verbs/implement-bead-health.js:450`** —
   the finding: reset-task resolves beads only from the open list, so a closed
   bead is reported as not found. The reason: plan escalation 13 defers the
   find-by-key fallback for closed beads; the scope of this PR is the plan's
   work packages, and adding the fallback would widen it.
5. **`packages/development/lib/engine/verbs/implement-bead-health.js:536`** —
   the finding: the plan rows are read through `calls.json.creates || []` and
   `calls.json.deps || []`, so a malformed scaffold plan would degrade to an
   empty plan and report no drift. The reason: the contract already
   guarantees arrays — `packages/development/lib/trd-cli.js:373` documents
   `scaffold-calls <trd-path>` as returning `{ ok: true, slug, creates, deps }`
   and `packages/development/lib/scaffold-planner.js:601` always returns
   arrays — and the sibling verb
   `packages/development/lib/engine/verbs/implement-scaffold.js:421` trusts
   the same contract. The verb already refuses a plan whose `ok` is not true
   (`SCAFFOLD_PLAN_FAILED`), so the guard would cover a shape the producer
   cannot emit, and no test could make it fail — a check that cannot fail is
   itself a violation of Constitution Rule 7.

## Verification

All commands ran with `env -u FOREMAN_ARTIFACT_PATH`, so the toolchain
ledger's failure mirror could not overwrite this report.

| Command | Exit | Result |
|---------|------|--------|
| `cd packages/development && npx jest tests/engine-implement-bead-health.test.js` | 0 | 36/36 passed (351s) — run once before the fixes and again after them; both green |
| `cd packages/development && npx jest tests/engine-implement-scaffold.test.js` | 0 | 24/24 passed (151s) — the sibling verb that reads the same tracker helper |
| `npx jest scripts/tests/ensemble-bundle-smoke.test.js` (repository root) | 0 | 13/13 passed (1.2s) — includes "every engine module the CLI requires is vendored byte-for-byte, so generate:pi leaves no drift" |
| `cd packages/development && npx jest` (the package's full run, 328 suites) | 1 | 327 suites passed, 1 failed; 13549 tests passed, 1 failed, 3 skipped, 1 todo (430s). The single failure is `tests/local-ci-adversarial.test.js:288`, which is **not** caused by this diff: it fails identically with this phase's three fixes stashed (`1 failed, 70 passed`, exit 1), it imports only `packages/development/lib/local-ci-{runner,config,cli}.js` and runs against its own synthetic fixture repository, and it reads none of the engine, `tracker.js` or `messages.js`. The previous phase saw the same failure on the base tree. |
| `npm run generate:validate` (repository root) | 0 | 64 files validated; the run index is in sync |
| `npm run validate` (repository root) | 0 | all plugins validated, versions in sync, model-id / provider-ref / taxonomy / contract-doc / skill-conformance checks pass |
| `npm run generate:pi` (repository root) | 0 | regenerated the Pi mirror; the only file it changed is `packages/pi/vendor/lib/engine/tracker.js`; no Pi version bump |
| `npx eslint <the 7 changed .js files>` | 0 | clean. The repository's `eslint.config.mjs` ignores `**/lib/**` and `**/fixtures/**`, so the two test files were the ones actually linted |
| `npm run lint:md` (repository root) | 1 | 1226 findings, all pre-existing in files this diff does not touch (`packages/quality/**`, `packages/reqnroll/**`, `packages/rspec/**`, `docs/PRD/**`); **no** finding in `CHANGELOG.md` |

<!-- FOREMAN_REVIEW_FINDINGS_START -->
{"schema": "foreman.review_findings/1", "reviewed": true, "findings": [{"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 68, "description": "The live-edge reader trusted tracker.list when only some scoped rows carried a dependencies array, so real edges were reported as missing drift.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 141, "description": "A live edge of a second bead carrying the same title prefix was credited to the selected bead, hiding a missing planned edge.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 438, "description": "The reset-task filter matched the task marker anywhere in a title, so a bead that mentions it in prose can be selected for reopening.", "disposition": "declined", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 103, "description": "A tracker.show answer that omitted dependencies was read as an empty edge set, reporting planned edges as missing instead of the tracker as unreadable.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 416, "description": "The foreman-exec completeness check compares a tracker.list count with the number tagged rather than verifying the tagged bead ids.", "disposition": "declined", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 447, "description": "The reset-task filter read issue.title on a list row that is not an issue, throwing a TypeError on the null-row shape.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 16, "description": "The module header claimed a refused run has written nothing, which is false for a --foreman refusal that follows tags the tracker already stored.", "disposition": "fixed", "source": "coderabbit"}, {"severity": "major", "path": "packages/development/lib/engine/messages.js", "line": 376, "description": "The unavailableWarning export was reported missing from the engine messages module.", "disposition": "declined", "source": "coderabbit"}, {"severity": "major", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 450, "description": "Reset-task resolves beads only from the open list, so a closed bead is reported as not found.", "disposition": "declined", "source": "coderabbit"}, {"severity": "minor", "path": "CHANGELOG.md", "line": 16, "description": "The diff adds the user-facing implement bead-health verb and its three write flags but adds no changelog entry, which the repository's pull-request checklist requires.", "disposition": "fixed", "source": "repo-rules"}, {"severity": "nitpick", "path": "packages/development/lib/engine/tracker.js", "line": 186, "description": "The scopeBeads JSDoc puts its prose paragraph between the @param tags and @returns, so it reads as part of the @param slug description instead of the function's own summary.", "disposition": "fixed", "source": "repo-rules"}, {"severity": "nitpick", "path": "packages/development/lib/engine/verbs/implement-bead-health.js", "line": 536, "description": "The plan rows are read through calls.json.creates || [] and calls.json.deps || [], so a malformed scaffold plan would silently degrade to an empty plan and report no drift.", "disposition": "declined", "source": "repo-rules"}]}
<!-- FOREMAN_REVIEW_FINDINGS_END -->

<!-- FOREMAN_RISK_JUDGEMENT_START -->
{"schema": "foreman.risk_judgement/1", "level": "MEDIUM", "rationale": "The change adds one verb that changes nothing in the tracker unless --label, --foreman or reset-task is passed, adds no runtime dependency, and refuses (never reports success) when the tracker, the work-graph gate or the label path cannot do what was asked. The level stays MEDIUM because the live-edge drift diff cannot be proven against the shipped beads and kata adapters, which expose no dependency links and therefore answer EDGES.checked:false with a warning, and because --label writes through the ungated beads-label command rather than the toolchain's side-effect gate."}
<!-- FOREMAN_RISK_JUDGEMENT_END -->