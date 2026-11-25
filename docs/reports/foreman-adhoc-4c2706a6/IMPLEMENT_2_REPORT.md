# IMPLEMENT_2 — WP2: `implement bead-health` (read-only report)

## 1. Package

**WP2** of `/Users/ldangelo/.omp/ensemble-engine-trd/PLAN-pr3b-workpackages.md` — TRD-012 (read-only
half) and TRD-012-TEST (its scenarios).

Shipped: `ensemble implement bead-health <trd>` — a read-only report of how a TRD's beads differ
from `trd-cli scaffold-calls`' plan of record: live-edge diff (missing / extra / unresolved), the
work-graph step, the `## References` count with `bead-context` on the root epic, and the label
report. Registered in the `implement` group. No write path is reachable in this package; the write
flags (`--label`, `--foreman`, `reset-task`) are WP3.

WP1 check (plan Overrides: already in the tree): `lib/engine/tracker.js` exists and exports
`callCapability`, `classify`, `idOf`, `prefixOf`, `readIssues`; `lib/engine/verbs/implement-scaffold.js`
and `tests/fixtures/engine/tracker-stub.js` exist; `MESSAGES.scaffoldPlanFailed`,
`unavailableWarning` and `failedWarning` exist. Nothing was missing.

## 2. Changes

| Path | Why |
| --- | --- |
| `packages/development/lib/engine/verbs/implement-bead-health.js` (new) | E11: the verb — plan read, scoping, the three-step edge ladder, the work-graph step, references, labels, and its published input/output schemas. |
| `packages/development/lib/engine/groups/implement.js` | E12: registers the spec in `SPECS`, in file-name order (after `implement-args`), so the verb is reachable from the entry point (Rule 6). |
| `packages/development/lib/engine/tracker.js` | E9: adds `scopeBeads(issues, slug)`, `isClosed`, `isTaskLevel`, `depIdOf` — the shared readings WP3 reuses; `scopeBeads` carries the row's `dependencies` through so a tracker whose list holds the links needs no per-bead read. |
| `packages/development/lib/engine/messages.js` | E10: six authored texts (`notScaffolded`, `workGraphFindings`, `beadContextFailed`, `referencesWarning`, `labelsWarning`, `edgesUnreadable`), each with the source pattern it was authored from (plan Escalation 9). |
| `packages/development/tests/fixtures/engine/tracker-stub.js` | E13: adds the `tracker.show` capability and its manifest mapping, the `exposeDependencies` / `listDependencies` / `workGraph` options, and `removeIssue(id)` — the fixture levers each Test AC scenario needs. |
| `packages/development/tests/engine-implement-bead-health.test.js` (new) | E14: the TRD-012-TEST scenarios. |

`trd-cli.js`, `toolchain-cli.js`, `scaffold-planner.js` and the merged scaffold verb and its test
are untouched (`git status` lists exactly the six paths above).

## 3. Tests

`packages/development/tests/engine-implement-bead-health.test.js`, 15 tests. Every one drives the
real `main(argv, ctx)` of `lib/ensemble-cli.js` through the real `buildRegistry()` against a real
git repo whose tracker is the stateful stub and whose beads were created by a real
`implement scaffold` run. Nothing inside the engine is stubbed.

Command (all runs): `cd packages/development && env -u FOREMAN_ARTIFACT_PATH npx jest tests/engine-implement-bead-health.test.js`

**Before the implementation** (the verb did not exist): `-t 'registry publishes'` →
`TypeError: Cannot read properties of null (reading 'summary')` at line 331 (the registry had no
`implement.bead-health`); `-t 'dropped planned edge'` → `expect(exitCode).toBe(0)` received `2`
(`UNKNOWN_VERB`) at line 119. Every other scenario asserts on that same envelope and therefore
failed for the same reason.

**After**: 15 passed, 0 failed (128 s).

| Scenario | Failed before → passes now |
| --- | --- |
| dropped planned edge is missing, unplanned one is extra | verb absent (exit 2) → `EDGES.source 'list'`, one `missing` entry with its `type`, one `extra` entry |
| planned edge whose endpoint bead is gone is unresolved, not missing | verb absent → `missing []`, two `unresolved` `story-blocks-epic`, `BEADS {found:11, planned:12}`, `ROOT_EPIC_ID null` |
| tracker that reports no dependency data says so | verb absent → `EDGES.checked false`, `source null`, `live 0`, a reason, and `MESSAGES.edgesUnreadable(reason)` warned; `missing`/`extra` stay empty |
| tracker whose list omits the links is read bead by bead | verb absent → `EDGES.source 'show'`, the dropped edge reported missing |
| dependency cycle is refused | verb absent → exit 1, `REFUSED WORK_GRAPH_FINDINGS`, a `cycle` finding in `details.findings` |
| unavailable work-graph backend is warned and skipped | verb absent → `OK`, `status 'unavailable'`, both capabilities in `skipped`, exactly two `work-graph.` warnings |
| healthy graph is clean and dependency aware | verb absent → `status 'clean'`, `dependencyAware true`, `orderingSource 'tracker-links'` |
| two open beads without a References block | verb absent → `REFERENCES.missingCount 2`, `openScoped 12`, `referencesWarning(2)` |
| bead-context failure is refused with every missing entry | verb absent → exit 1 `BEAD_CONTEXT_FAILED`, message and `details.missing` carry `TRD file docs/TRD/missing.md cannot be read: ENOENT` |
| unlabelled beads counted, a foreign TRD is not | verb absent → `LABELS {expected:'widget-engine', missingCount:12}`, `BEADS.found 12` (the `[trd:widget-engine-v2]` row excluded), `labelsWarning(12, slug)` |
| empty tracker is refused as not scaffolded | verb absent → exit 1 `NOT_SCAFFOLDED` with `MESSAGES.notScaffolded(slug)` |
| the report changes nothing | verb absent → stub state hash, mutation log and `git status --porcelain` unchanged across two runs, and the two `data` payloads byte-identical (no clock, no random) |
| registry publishes the verb and its schemas | `null` spec → `engine verbs` lists it `sideEffect 'write'`, `engine schema implement.bead-health` returns both schemas |
| missing / absent / escaping operand refused before the tracker is touched | verb absent → `TRD_REQUIRED`, `TRD_NOT_FOUND`, `PATH_ESCAPE` (exit 2), tracker call count unchanged |
| the write flags do not exist yet | verb absent → `--label` is exit 2 `UNKNOWN_FLAG`, mutation log empty (proves this package ships no write) |

Two assertions failed on the first green-making run and were fixed in the implementation, not in
the test: `EDGES.source` was `'show'` because `scopeBeads` dropped the row's `dependencies`
(fixed in `tracker.js`), and `labelsWarning` was never pushed (fixed in the verb).

## 4. Deviations from the plan or TRD

None. The plan's Overrides (WP1 already in the tree) were honoured; every Escalation default in
plan section 5 was adopted as written, in particular:

- E5 `--label` through the ungated `beads-label` — not reachable in this package (WP3).
- E9 the six messages are authored, each documented with the source pattern it follows.
- E13 (`reset-task` on kata) and E14 — WP3.
- Plan item 14: the work-graph capabilities run repository-wide, as the prose does.

## 5. Local verification

| Command (all with `env -u FOREMAN_ARTIFACT_PATH`) | Result |
| --- | --- |
| `cd packages/development && npx jest tests/engine-implement-bead-health.test.js` | 15/15 pass (128 s) |
| `cd packages/development && npx jest tests/engine-implement-scaffold.test.js tests/engine-registry.test.js tests/engine-policy.test.js tests/engine-mount-parity.test.js` | 4 suites, 64/64 pass |
| `npx eslint` on the six changed files (repo root) | 0 errors (5 "file ignored by pattern" warnings for the `lib/engine/**` and fixture paths — pre-existing ignore config) |
| `npm run generate:validate` (repo root) | ✓ validation passed (64 files); run-index matches a fresh build |
| `npm run validate` (repo root) | 186 passed / 31 warnings / 0 failures — all warnings pre-existing (skill word-count baselines, `BINARY_IN_SKILL` in `packages/infrastructure/skills/jira`), none in a changed file |
| `cd packages/development && npx jest` (full package) | 327 of 328 suites pass, 13528/13533 tests. One pre-existing failure: `tests/local-ci-adversarial.test.js` › "GH_TOKEN/GITHUB_TOKEN in the maintainer environment never reach the step" |
| `node --check` on each changed `lib` file and the fixture | OK |

The `local-ci-adversarial` failure is **pre-existing and unrelated**: with every change of this
package stashed (`git stash -u`), the same test fails identically on the clean tree
(`expect(text).toContain('PATH')` at `tests/local-ci-adversarial.test.js:288`; the step fails on
Node 26 before it prints). Not caused by WP2 and not in scope to fix.

## 6. Escalations and follow-ups

- **For the PR body (must be stated prominently):** the edge diff cannot read live edges on the
  shipped beads and kata adapters — no capability lists edges and neither `tracker.show` mapping
  carries `dependencies`. On those adapters `bead-health` reports `EDGES.checked:false` with the
  `edgesUnreadable` warning. Edge-drift detection is proven only against the test stub until those
  adapters expose `dependencies`; `bead-health` must not be described as doing working edge-drift
  detection on real trackers.
- **Also for the PR body:** "nothing is changed" holds for this verb only without `--label`,
  `--foreman` or `reset-task` (none of which exist yet — WP3), and `--label` will go through the
  ungated `beads-label` (plan Escalation 5).
- TRD-012's write half (`--label`, `--foreman`, `reset-task`, plan D10 and E15–E18) is WP3 and is
  intentionally left undone here.
- No human decision is required: no TRD statement contradicted the code, no runtime dependency was
  added, and no security-sensitive behaviour was introduced (the verb adds no input boundary and
  performs no write).
