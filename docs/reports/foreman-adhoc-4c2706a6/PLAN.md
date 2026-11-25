# Work packages for PR 3 (supplied and verified; do not re-plan)

This plan was produced by a planning run on the clean reference tree (HEAD `34bbd020`, branch `dev`, PR 1 and PR 2 merged)
and every anchor below was re-read in the code, the prose or git history. Edits are labelled E1 to E26. They group into
three work packages, run in order, test first. A package never depends on a later one.

- **WP1** = TRD-011 + TRD-011-TEST: edits E1-E8. The shared tracker helper, `implement scaffold`, and the tracker stub
  fixture. Write `tests/engine-implement-scaffold.test.js` and `tests/fixtures/engine/tracker-stub.js` first.
- **WP2** = TRD-012 read-only half + its tests: edits E9-E14. `implement bead-health` in its default mode (edge diff,
  work-graph findings, `## References` count with `bead-context`, label report) and its registration.
- **WP3** = TRD-012 write paths + their tests: edits E15-E26. `--label`, `--foreman`, `--reset-task`; then packaging (the
  bundle-smoke pin, the pi vendor regeneration) and the whole-slice verification, once.
- This slice has exactly three packages, numbered 1 to 3. A package number above 3 does not exist: a phase whose number is
  above 3 has nothing to do.

Overrides to the plan text below:

- **WP1 is ALREADY IN THE TREE.** A previous run built package 1 (edits E1 to E8) and it is committed on the branch this run starts from: `lib/engine/tracker.js`, `lib/engine/verbs/implement-scaffold.js`, the edits to `trd-source.js`, `groups/implement.js`, `messages.js`, `implement-branch.js` and `implement-resume.js`, `tests/engine-implement-scaffold.test.js` and `tests/fixtures/engine/tracker-stub.js` all exist and their tests pass. For package 1: change nothing, run nothing except `git status` and `ls` to confirm those files exist, write a one-paragraph report saying "WP1 already in the tree" with that confirmation, and stop. Build packages 2 and 3 on top of it; where the plan says "WP1 creates X", X already exists, so read it and reuse it. Do not re-create, rewrite or reformat any WP1 file except where a package 2 or 3 edit in this plan names it.

- **Packaging overrides (PR 3's first half is merged as #498).** `'tracker.js'` and `'verbs/implement-scaffold.js'` are ALREADY in the `required` array of `scripts/tests/ensemble-bundle-smoke.test.js`, and their vendor copies, plus the vendor copies of the files WP1 edited, already exist and are committed. E21 therefore adds ONLY `'verbs/implement-bead-health.js'` to `required` (after `'verbs/implement-args.js'`); never add a second `'tracker.js'` or `'verbs/implement-scaffold.js'`. E22's scaffold probes already pass and stay as they are; add only the bead-health probes. E23's regeneration writes the new `packages/pi/vendor/lib/engine/verbs/implement-bead-health.js` and updates the vendor copies of any file this PR edits; it must not change the vendor copy of `tracker.js` or `implement-scaffold.js`. In D13 read "pin the new engine files" as "pin `verbs/implement-bead-health.js`". The tracker stub fixture `tests/fixtures/engine/tracker-stub.js` and `tests/engine-implement-scaffold.test.js` already exist: reuse the stub for TRD-012-TEST and do not edit the scaffold test except where this plan names it.

- Phases do not commit, push or open a pull request; Foreman does, after the reviews. Any closing step that says "commit" or
  "open the PR" does not apply.
- Each package runs only its own test files, the engine tests of every PR 1 / PR 2 file it edits (WP1 edits
  `trd-source.js`, `groups/implement.js`, `implement-branch.js` and `implement-resume.js`), and the syntax/lint checks named in
  its Verification. `npm run validate` and `generate:validate` may be red on pi-vendor drift until WP3; never hand-edit
  `packages/pi/vendor/**` or `packages/full/skills/**`, WP3 regenerates them.
- Any file that is already dirty when the run starts is not yours: never reset, stage or format it. "No drift" below means
  before/after comparisons, not an empty `git status`.
- ESLint ignores `**/lib/**`, `**/fixtures/**` and `packages/pi/vendor/**` (`eslint.config.mjs`, `ignores`): it checks only
  the new test files. The engine files and the stub fixture are checked with `node --check <file>` instead.
- All paths are relative to the repository root; `lib/` means `packages/development/lib/`. Do not write the literal text
  `require('./x')` inside a comment in any engine file: the pi bundler scans raw text (`RELATIVE_REQUIRE_RE` in
  `packages/pi/src/transformers/lib-bundler.ts`). Do not write `path.join(__dirname, 'literal', ...)` in a new engine file
  (`validate-all.js` `validateBundleDataPaths`); the new files read no data file.
- Do not touch `.beads/`, run `br` mutations, push to `dev` or `main`, or merge.

---

## 1. Verdict

**Not a bug: new capability, implement as specified, with the resolutions in sections 3, 4 and 5.** Verified on HEAD `34bbd020`:
`lib/engine/verbs/` holds `implement-{args,branch,env,resume,team}.js`; there is no `implement-scaffold.js`,
`implement-bead-health.js`, `lib/engine/tracker.js`, `tests/fixtures/engine/tracker-stub.js`, `tests/engine-implement-scaffold.test.js`
or `tests/engine-implement-bead-health.test.js` (`tests/fixtures/engine/` holds only `exit-cli.js` and `trd-parity.md`).
`groups/implement.js:12-17` registers five verbs. **`ensemble --describe` lists 43 verbs today**: `engine` 4, `implement` 5
(`args` read, `branch` write, `env` write, `resume` read, `team` read), `tool` 8, `trd` 26 (measured with
`node packages/development/lib/ensemble-cli.js --describe` in the main checkout at the same commit; the clean reference clone has
no `node_modules`). After PR 3 it lists **45**, `implement` 7 (`bead-health` and `scaffold` write); `--describe` takes 0.109 s
cold, against the 200 ms budget (TRD:678-680). No new runtime dependency.

## 2. Design facts the edits rely on

Prose of record (paths under `packages/development/skills/`): **P1** = `ensemble-implement-trd-tasks/references/phase-1-preflight.md`,
**P2** = `ensemble-implement-trd-tasks/references/phase-2-scaffold.md`, **P3** = `ensemble-implement-trd-tasks/references/phase-3-execute.md`,
**REF** = `implement-trd-tasks-reference/SKILL.md`. **TRD** = `docs/TRD/TRD-2026-d571763f-ensemble-engine-cli.md`.

- **Verb anatomy (PR 2).** A verb is a module exporting `{ spec }`, keys sorted: `exitCodes, group, handler, inputSchema, name,
  outputSchema, policyKeys, sideEffect, summary`. `groups/implement.js` lists the specs (`SPECS` :12-17) and `register` :24-26 hands
  them to the registry. `handler(call)` returns plain data (status `OK`) or a tagged result from `result.js` (`refused`,
  `unavailable`, `needsChoice`, `isResult`); `call` carries `input, projectRoot, env, globals` (`call.globals.runId` is the global
  `--run-id`). Models: `implement-env.js` (write verb driving `toolchain-cli`, spec :254-327), `implement-branch.js` (required `trd`
  operand, `selectTrd` :50-66, spec :434-533), `implement-resume.js` (`readEpic` :234-297, tracker unwrapping :246-265).
- **Child CLIs.** `cli-json.js`: `runJsonCli` :34 (`{exitCode, json, stderr}`; `json` is `null` unless stdout is a JSON object),
  `inheritedFlags` :61 (`--json`, `--run-id <id>` when the caller gave one, `--non-interactive` when the engine is non-interactive),
  `runToolchain` :79 and `runTrd` :93 (cwd = project root, env = `call.env`), `toolchainFailure` :120 (`INVALID_RUN_ID` and
  `INVALID_ARG` -> `INVALID_INPUT`; `PREFLIGHT_REQUIRED`, `CAPABILITY_NOT_REPORTED`, `CONFIRMATION_REQUIRED`, `NOT_ALLOWED` ->
  `REFUSED`; everything else -> `UNAVAILABLE`; message unchanged). `trd-cli` parses unknown flags as booleans, so the inherited
  `--run-id <id>` leaves the id as an ignored extra positional (`trd-cli.js:147-173`).
- **Gates on tracker writes.** `toolchain-cli run` refuses a side-effecting capability (contract `sideEffect: true`: every
  `tracker.*` write) unless (1) a passing preflight record exists for `--run-id` (`PREFLIGHT_REQUIRED`, `toolchain-cli.js:511-522`;
  record `<root>/.ensemble/state/toolchain/preflight-<runId>.json`, `toolchain/preflight.js:645`), (2) for a gated adapter (a
  health check with `jsonAssert`: kata) the record reported the capability (`CAPABILITY_NOT_REPORTED`, :524-538, `preflight.js:680,703`),
  (3) the adapter is confirmed or the call is non-interactive (`CONFIRMATION_REQUIRED`, :541-563, `toolchain/confirm.js:231,335`).
  Reads (`tracker.list`, `tracker.show`, `tracker.find-by-key`, `work-graph.*`) are not gated. A successful write is recorded in the
  run ledger under `.ensemble/state` (:588), which is self-ignoring. `trd-cli beads-label` is the exception: it runs the tracker
  in-process and omits every gate (`beads-label.js:25-37`, `trd-cli.js:84`).
- **Envelope and "unavailable".** A toolchain success is `{ok:true, capability, adapter, source, data}` (`runner.js:1378`): the
  adapter id is `json.adapter`. A declared-optional capability the adapter omits is `{ok:false, unavailable:true, fallback, ...}`
  only when its contract entry carries a `fallback`; otherwise it is `NOT_ALLOWED` with the message
  `capability '${capability}' is not declared by adapter '${adapterId}'` (`runner.js:950-994`). `tracker.yaml` gives `fallback` to
  `tracker.label`, `tracker.create-detailed` and `tracker.find-by-key`, and to none of `tracker.dep-add`, `tracker.dep-remove`,
  `tracker.set-status`, `tracker.sync`. `tracker-findings.js:50` already treats that `NOT_ALLOWED` text as "unavailable"
  (`UNDECLARED_RE`, `classify` :68-79). A missing binary at run time is `TOOL_FAILED` with `error.missingBinary` (`runner.js:1522-1525`).
  `work-graph.*` capabilities carry `fallback: work-graph-links-fallback`.
- **Tracker data.** beads `tracker.list` is `br list --all --limit 0 --json` (adapter.yaml:119-120): `data` is the raw JSON text
  `{issues:[...]}`; rows carry `id, title, description, status, labels, dependency_count` and NO `dependencies`
  (`scripts/tests/fixtures/toolchain/adapter-tracker-beads-samples/br-list.sample.json`). kata `tracker.list` is open-only
  (`kata list --status open ...`, adapter.yaml:257-258) and maps rows to `{items:[{id,title,status,labels,...}]}` without a
  description. `tracker.create` answers `data:{id}` on both (beads :147-154, kata :297-305). `tracker.show` is mapped to
  `id,title,description,type,status,labels` (beads :68-98, kata :207-241): **no adapter maps `dependencies`**, although
  `toolchain/schemas/normalized/work-item.json` and `work-graph-scan.js:28-41` define it (an item's `dependencies` entries are
  `{id, type?}` or bare ids, "this item is blocked by that id"). No capability lists edges; REF:68 says "No `tracker.dep-list`
  capability exists".
- **Planner (pure, through `trd-cli`).** `scaffold-plan <trd>` -> `{ok, slug, plan}` (`trd-cli.js:360`; plan =
  `{label, epic, stories, tasks, synthesizedTests, deps, warnings}`, `scaffold-planner.js:322`); `scaffold-calls <trd>` ->
  `{ok, slug, creates[{kind,titlePrefix,args{title,description,type,labels,priority,externalKey}}], deps[{type,blockerPrefix,blockedPrefix}]}`
  (:379, `scaffold-planner.js:601`); `scaffold-dep-args <trd> --ids <json>` -> `{ok, slug, deps[{id,dependsOnId,type:'blocks'}], unresolved[edge]}`
  (:397, `scaffold-planner.js:628`). Exactly four edge types (`scaffold-planner.js:507-565`): `story-blocks-epic`, `task-blocks-story`,
  `task-depends`, `synthtest-depends`. `trd-cli` failures print `{error: message}` and exit 1 (:1715-1722). `bead-context --bead <id>
  --trd <path>` -> `{ok, source, kind, missing[]}`, exit 1 when `ok:false` (:453, :1727); a broken reference yields e.g.
  `["TRD file docs/TRD/nope.md cannot be read: ENOENT"]` (template at `:551`: `TRD file ${trdRel} cannot be read: ${err.code || err.message}`). `beads-label --label <l> --match <s>` -> `{ok:true, label, matched, labeled,
  already}` or `{ok:false, unavailable:true, reason, label, matched}`; any other failure is `{error}` (:950, `beads-label.js:146-165`).
- **Pure helpers to import (D4 of PR 2).** `bead-refs.js`: `parseReferencesBlock` :96 (`null` when no `## References` block),
  `parseTitlePrefix` :157 (`{kind: epic|story|task|test|synth, slug, phaseN|taskId}`, anchored regex :145), `kindFromTitle` :173.
  `tracker-findings.js`: `findByKey(deps, {key})` :144 (injected `deps.run`; exact match on `item.external_ref`, zero/one/many, `AMBIGUOUS_KEY`
  with `ids`; kata maps `external_ref` from `metadata.ext_key`, adapter.yaml:351-375). Both are already vendored for pi.
- **Legacy `--arg` rules.** `toolchain-cli run <cap> --arg k=v` splits at the first `=`, refuses a value that starts with `--` and a
  malformed pair (`toolchain-cli.js:988-1000`); a multi-line value is fine (no shell).
- **Prose anchors.** P2:3 (kata gate), :5-:8 (kata bullets), :12, :16-:19 (default path), :26-:28; REF:66 (title-prefix idempotency),
  :67 (stale edges), :69 (`--reset-task`), :73 (Foreman), :77 (References); P3:8 (label backfill), :9 (References health), :12;
  P1:15 (`--reset-task` early exit), :24 (`tracker.dep-add/sync are optional, degrade on {ok:false}.`), :49 (`confirm-status`).
  The original wording of the stale-edge repair exists only in git history: `git show 02adb402^:packages/development/commands/implement-trd-beads.yaml`
  lines 640-641 (D5).
- **Test infrastructure.** `tests/helpers/engine-run.js` (`runMain`, `makeCtx`, `makeRoot`, `expectMatchesOutputSchema`) and
  `tests/helpers/engine-repo.js` (`makeRepo`, `initRepo`, `isolatedEnv`, `snapshotTree`, `trackerCalls`; `fixtureTracker` :219-255 is a
  READ-ONLY stub: it answers `--version` and `list`, logs and refuses every other call as `MUTATION`; its call log lives outside the
  project root, :182-190). No stateful tracker stub exists. A fixture child gets a `PATH` built from scratch (`HOST_TOOLS` :33-48:
  `node`, `git`, `bash`, ...) and the toolchain runner strips every env var an adapter does not declare, so a stub carries its file
  paths baked into its generated source. Write gates are crossed in tests the way `engine-implement-branch.test.js:186-194` does
  (a prior preflight for a run id) plus the global `--non-interactive`. A fixture adapter under `<root>/packages/<pkg>/skills/<dir>/`
  shadows a library adapter of the same id: installed roots list the project-relative `packages/*/skills` first
  (`toolchain/adapters.js:100-113, 424-431`). The message-source test pattern is `engine-implement-args.test.js:66-76`.
- **Counts and pins.** No engine test hard-codes a verb count (`engine-mount-parity.test.js:120` filters `trd`/`tool`;
  `engine-policy.test.js:217,286` compare with `registry.verbs()`, and every verb's `policyKeys` must be a subset of `POLICY_KEYS`). The
  only pinned list is `scripts/tests/ensemble-bundle-smoke.test.js:243-271` (`required`, byte-checked against `packages/pi/vendor/lib/engine`),
  plus the launcher probes :91-150. `packages/full/lib/engine` is a directory symlink, so new files are mirrored; `packages/pi/vendor/**`
  is committed and regenerated by `npm run generate:pi` (= `npm run generate --workspace=packages/pi` + the `postgenerate:pi` version
  hook, which only watches `packages/pi/{prompts,agents,skills,AGENTS.md}`, `scripts/bump-pi-version-if-changed.js:43-48`).

## 3. Decisions (fixed; each is recorded so later packages stay consistent)

- **D1 Registration and side-effect classes.** `SPECS` in `groups/implement.js` gains `implement-scaffold` (WP1) and
  `implement-bead-health` (WP2), kept in file-name order (`args, bead-health, branch, env, resume, scaffold, team`). A verb is registered
  in the package that creates it, because it cannot be driven through `main()` otherwise (Rule 6); the bundle pin and the pi
  regeneration happen once, in WP3 (the pin is red against a stale vendor tree until regeneration, as in PR 2). Both verbs are
  `sideEffect: 'write'` (PR 2 D7: the class describes capability, not default behaviour). `bead-health` writes only behind `--label`,
  `--foreman` and `--reset-task`, and its tests prove the tracker and the tree are unchanged without them; the PR body must say so
  (E26). `policyKeys: []` and `exitCodes: [0, 1, 2, 5]` for both (no `NEEDS_CHOICE`).
- **D2 Shared code, no second convention.** `lib/engine/tracker.js` (new) holds everything the two verbs and `resume` need from the
  tracker; `trd-source.js` gains `requireTrd(call)`. `implement-resume.js` `readEpic` and `implement-branch.js` `selectTrd` are migrated
  onto them in WP1 (behaviour and codes unchanged; their own tests stay green). No private copy of the `tracker.list` unwrapping or of the
  TRD-operand check remains.
- **D3 Plan sources and the creation procedure.** `scaffold-plan` is always the plan of record ("execute it, never re-derive", P2:12).
  The tracker adapter is `json.adapter` of the one `tracker.list` envelope; it is kata when it equals `'kata'` (P2:3, TRD:394). Default
  path (P2:16-17): one `tracker.list` cache keyed by title prefix, then `tracker.create` with `title`, `type`, `description` in that
  order; no external-key lookup (P2:16 "Never re-query per bead.", and a plain create carries no key: P2:17). Kata path (P2:5-6):
  `scaffold-calls` for the arguments, then per entry cache hit, else `findByKey` on `externalKey`, else `tracker.create-detailed` with
  `args` as `--arg k=v`, falling back to `tracker.create` when it is unavailable. Edges use `scaffold-dep-args` on BOTH paths (it
  resolves ids and reports `unresolved`; the default-path wording of P2:18 builds the identical `{id, dependsOnId, type:'blocks'}`).
  A title-prefix cache hit is reused whatever its status (beads lists closed beads; a finished TRD re-scaffolds to nothing); a row
  with no id is ignored; two rows with one prefix: first in list order wins and a warning names the ids.
- **D4 Failure classification (`tracker.js` `classify`).** `ok` | `unavailable` (`json.unavailable === true`, or `NOT_ALLOWED` whose message
  matches `UNDECLARED_RE`, or `error.missingBinary` is a string) | `gate` (`toolchainFailure` gives `REFUSED` or `INVALID_INPUT`: returned to
  the caller unchanged, because it says what to do: preflight, confirm, pass `--run-id`) | `failed` (any other `ok:false`) |
  `unreadable` (`json` is `null`). Per capability: `tracker.list` unreadable or failed -> `UNAVAILABLE` (never "empty tracker", PR 2 D12);
  `tracker.find-by-key` unavailable -> skip the lookup, one warning; any other failure -> `REFUSED LOOKUP_FAILED` (a failed lookup must not
  turn into a duplicate create); `tracker.create-detailed` unavailable -> fall back, one warning, and use `tracker.create` for every later
  entry; any create failure, gate included, and an empty id -> `REFUSED` naming the title prefix, nothing further created, details
  `{titlePrefix, created, reused, failure}` (a gate keeps its own code, e.g. `PREFLIGHT_REQUIRED`; `INVALID_INPUT` passes through);
  `tracker.dep-add` and `tracker.sync` unavailable or failed -> warning, remaining work skipped, status `OK` (P1:24 "degrade on
  {ok:false}", TRD:391); a gate on any write is returned unchanged.
- **D5 The stale inter-phase edge.** Origin (git history, `02adb402^`, `implement-trd-beads.yaml:640`): a pre-planner scaffold wired an
  inter-phase gate, "task→task deps of the form: 'first task of phase N' depends on 'last task of phase N-1'", and the command repaired it
  with `br dep remove <firstCurBead> <lastPrevBead>` (ignore "edge not found"), before wiring `PLAN.deps`, "the AUTHORITATIVE, complete set
  of dependency edges" (:641). The planner no longer emits it, so it is found by derivation, not by search (no capability enumerates edges).
  `PHASE_TASK_IDS[N]` = the ids of `plan.tasks` with `phaseN` in plan order, then the ids of `plan.synthesizedTests` with `phaseN`
  (synthesized tests come LAST). For each `N >= 2` in ascending order with both `PHASE_TASK_IDS[N]` and `PHASE_TASK_IDS[N-1]` non-empty
  (literal `N-1`: a gap in the numbering has no candidate): blocked = bead of `PHASE_TASK_IDS[N][0]`, blocker = bead of the LAST id of
  `PHASE_TASK_IDS[N-1]`. Removal runs BEFORE the plan edges are added (the historical order), through `tracker.dep-remove --arg id=<blocked>
  --arg dependsOnId=<blocker>`; a pair that is itself a planned edge is skipped (a TRD may declare `[depends: <last task of N-1>]` on the
  first task of N: removing it would delete a planned edge). `dep-remove` unavailable -> one warning, no removals; an edge-not-found
  failure (message matches `/not\s+found|no such|does not exist|no (?:such )?(?:dependency|edge|link)/i`) is ignored and counted
  `absent`; any other non-gate failure is counted `failed` with a warning and ignored; a gate is returned. `removed` counts accepted
  calls (an idempotent remove such as kata's accepts an absent edge, adapter.yaml:539-542, so there `removed` may include edges that never
  existed). Example on the TRD of record: phase 3's pair is `TRD-011` blocked by `TRD-010-TEST`; none of the five pairs is a planned edge.
- **D6 Scaffold output** (`outputSchema`, `additionalProperties:false`, all keys required): `ADAPTER` (string|null), `BEADS`
  `{created, reused, total}`, `EDGES` `{added, planned, skipped, unresolved[{blocked, blocker, type}]}` (`planned = added + skipped +
  unresolved.length`; `added` counts accepted `tracker.dep-add` calls, an already-present edge being a tracker no-op; `skipped` is the number
  of resolved edges not added after a warning), `PHASE_STORY_IDS` (`{"<phaseN>": storyId}`; the prose gives this map no variable name, P2:17
  says "story ids by phase"), `PHASE_TASK_IDS` (`{"<phaseN>": [taskId...]}`), `ROOT_EPIC_ID`, `STALE_EDGES` `{absent, candidates, failed, removed[{blocked,
  blocker}], skipped}`, `SYNCED` (boolean), `TRD_FILE_PATH`, `TRD_SLUG`, `TRD_TO_BEAD_MAP` (`{taskId: beadId}`, tasks then synthesized tests),
  `WARNINGS` (`plan.warnings` first). TRD:389's "created, reused and skipped counts" are `BEADS.created`, `BEADS.reused` and `EDGES.skipped`.
  Edge endpoints in output are title prefixes, never bead descriptions; arrays are in plan order, `unresolved` sorted. No clock, no random value.
- **D7 What counts as the TRD's beads, and the live-edge reader.** Scoped beads are the `tracker.list` rows whose
  `parseTitlePrefix(title).slug` equals `TRD_SLUG` (anchored, exact: `[trd:x]` never matches `[trd:x-v2]`); kinds from `kindFromTitle`
  (task-level = `task`, `test`, `synth`; `epic` and `story` are never task-level). Edges come from the first source that answers: (1) any scoped
  row with an array `dependencies` (rows without one contribute nothing); else (2) `tracker.show --arg id=<id>` for the first scoped bead as a
  probe and, only when its `data.dependencies` is an array, for every other scoped bead; else (3) `EDGES.checked:false` with a reason and one
  warning, and `missing`/`extra` stay empty (an unreadable tracker must not report every edge as missing). Entry shapes follow
  `work-graph-scan.js:28-41`: `{id}` objects or bare id strings, meaning "blocked by that id". Only edges whose two endpoints are both scoped
  beads are compared; planned edges are the unique `(blockedPrefix, blockerPrefix)` pairs of `scaffold-calls.deps`.
- **D8 The work-graph step.** `work-graph.plan` and `work-graph.graph-health`, no `scope` arg (P2:26; findings are repository-wide, P3:12), each
  classified by D4. `unavailable` -> one warning each, skipped; any other failure -> `toolchainFailure(error)` (the step did not succeed);
  a non-empty `findings` (an array with items; any other non-null, non-empty-object value fails closed as non-empty) -> `REFUSED WORK_GRAPH_FINDINGS`
  with `details {findings}`. Data: `WORK_GRAPH` `{dependencyAware, findings, orderingSource, skipped[], status: clean|partial|unavailable}`.
  "only after the work-graph step succeeded" (TRD:417) means it did not refuse and did not fail: a skipped step does not block `--foreman`.
- **D9 References and labels.** Open scoped beads are the non-closed ones. A bead lacks the block when `parseReferencesBlock(description) === null`; the
  description comes from the row when it is a string, else from `tracker.show` for that bead (a failed show leaves the count unknown: one warning).
  `bead-context` runs for the root epic only (P3:9), `--trd <path>`: `ok:false` or exit 1 -> `REFUSED BEAD_CONTEXT_FAILED` listing every `missing`
  entry; no JSON -> `UNAVAILABLE`. `LABELS` reports how many scoped beads lack the label `TRD_SLUG` (P1:39: "TRD_LABEL = TRD_SLUG").
- **D10 Write paths of `bead-health`.** Flags: boolean `label`, boolean `foreman`, string `reset-task` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, as `args`). `--reset-task`
  is exclusive with the other two (P1:15 "reference section 5; EXIT."): `refused('RESET_TASK_EXCLUSIVE', exclusive(...))`. Every
  check that can refuse (findings, `bead-context`) runs before any write. `--label`: `runTrd(['beads-label', '--label', <slug>, '--match', '[trd:<slug>'])`
  (P3:8): `ok:true` -> `LABEL`; `{ok:false, unavailable:true}` -> warning; anything else -> `REFUSED LABEL_FAILED`. `--foreman`: task-level scoped beads only,
  `tracker.label --arg ids=<id> --arg labels=foreman-exec` per bead lacking the label (REF:73; `foreman-exec` is a protocol constant), then `tracker.sync`,
  then a fresh `tracker.list`; the number of SCOPED rows carrying `foreman-exec` must equal the number of task-level scoped beads, else `REFUSED
  FOREMAN_TAGGING_INCOMPLETE`. A failed or unavailable `tracker.label` -> `REFUSED FOREMAN_TAGGING_FAILED` naming the bead (a dispatch tag cannot be
  partial). `reset-task <id>`: `tracker.list`, beads whose title contains `[trd:<slug>:task:<id>]` (exact, case-sensitive, closing bracket included);
  one -> `tracker.set-status --arg id=<id> --arg status=open`; none and several -> the REF:69 refusals. kata lists open items only, so a closed kata bead
  is not found: the engine replicates the recipe (Escalation 13).
- **D11 Messages.** `messages.js` keeps one constant per verbatim text with its source anchor and a substring test (PR 2 D11); the `ERROR: ` prefix is part
  of the text; a template with placeholders keeps the source text as its constant and substitutes with `.replace`. Texts with no verbatim source are
  authored in the pattern of the nearest source sentence, documented as authored, and listed under Escalation 9. The REF:69 and REF:73 texts are kept
  as the source prints them (em dash included), not as the TRD retypes them (Contradiction C9).
- **D12 Test infrastructure.** `tests/fixtures/engine/tracker-stub.js` (TRD-011-TEST) is reused by TRD-012-TEST (the TRD lists no fixture there, C13): a
  STATEFUL stub tracker behind a fixture adapter, selecting the real toolchain gates and envelopes. Its generated binary bakes in the paths of a state
  file and a call log OUTSIDE the project root (the `fixtureTracker` precedent). Tests call `main(argv, ctx)` with the real `buildRegistry()`; the oracle
  for "the plan" is `trd-cli scaffold-calls` spawned directly, never the engine. They assert only orders the engine owns (Rule 9): creates follow plan order,
  every create precedes the first `dep-add`; never the interleaving of stub writes with anything else. Every `main` run of a scaffold is about 35 child
  processes: keep the fixture TRD at 12 beads, group read-only assertions on one run, `jest.setTimeout(300000)`.
- **D13 Packaging (WP3).** Pin the three new engine files, regenerate the pi vendor tree with `npm run generate:pi`, prove no drift. Nothing hand-edited.
- **D14 Constitution mapping.** Rule 2: the TRD operand goes through `resolveCallerPath`, `reset-task` is pattern-checked, tracker output is shape-checked before
  use, no bead description is echoed. Rule 4: no store, no lock, no scheduler; state is re-derived from the tracker on every call (TRD:127). Rule 5: gates
  are the toolchain's; findings and the tagging count refuse in the engine. Rule 6: every verb is registered, driven through `main()` and probed through the bundle
  launcher. Rule 7: each gate has a mutation proof (E8, E14, E25). Rule 8: no policy key is added (the title-prefix scheme, `foreman-exec` and the
  `## References` heading are protocols other tools read, not user taste). Rule 9: see D12.

---

## WP1 - TRD-011 and TRD-011-TEST: tracker helper, `implement scaffold`, tracker stub

Files: new `lib/engine/tracker.js`, `lib/engine/verbs/implement-scaffold.js`; edits to `lib/engine/{trd-source.js,messages.js,groups/implement.js}`,
`lib/engine/verbs/implement-branch.js`, `lib/engine/verbs/implement-resume.js`; tests `tests/engine-implement-scaffold.test.js`,
`tests/fixtures/engine/tracker-stub.js` (both named by TRD-011-TEST).

Order inside this package: E7 and E8 first (red), then E1-E6 (green).

Failing check first: write E7 and E8, run `cd packages/development && npx jest tests/engine-implement-scaffold.test.js`; every scaffold scenario must fail
because the dispatcher answers `INVALID_INPUT` `UNKNOWN_VERB` for `implement scaffold` (`ensemble-cli.js:151`) [INFERENCE: not run in the planning pass].
Capture that run before implementing.

- **E1 `trd-source.js` `requireTrd(call)`; migrate `implement-branch.js`.** `requireTrd` is `selectTrd` of `implement-branch.js:50-66` moved: `call.input.trd`
  must be a string ending in `.md` (case-insensitive) else `refused('TRD_REQUIRED', "name the TRD as a '.md' path")`; `resolveCallerPath(call.projectRoot,
  operand)` (an escape is `INVALID_INPUT` `PATH_ESCAPE`, thrown as today); `fs.statSync` must say file else `refused('TRD_NOT_FOUND', "TRD '<operand>' does not
  exist")`; returns `{path: toProjectRelative(root, absolute)}`. `trd-source.js` newly requires `./result` and `./validate`. Delete `selectTrd` from
  `implement-branch.js`, call `requireTrd`, and remove the imports that become unused. `engine-implement-branch.test.js` is not edited and stays green.
- **E2 `tracker.js`** (new; D2, D4). Exports:
  - `UNDECLARED_RE = /^capability '[^']+' is not declared by adapter '/` (the text of `tracker-findings.js:50`; a comment cites `runner.js:990`).
  - `callCapability(call, capability, args = {}) -> {exitCode, json, stderr}`: `runToolchain(call, ['run', capability, ...Object.entries(args).flatMap(([k, v]) =>
    ['--arg', `${k}=${v}`])])`, so `--json`, `--run-id` and `--non-interactive` are inherited. Argument order is the object's insertion order.
  - `classify(result, capability) -> {kind:'ok', data, adapter} | {kind:'unavailable', message} | {kind:'gate', result} | {kind:'failed', code, message} |
    {kind:'unreadable', message}` (D4). The `unreadable` message is `<capability> produced no JSON result (exit <n>)` plus `: <stderr>` when there is stderr.
  - `readIssues(call) -> {adapter, issues} | tagged result`: the unwrapping of `implement-resume.js:234-265` moved unchanged (same three `TRACKER_UNREADABLE`
    messages, `toolchainFailure` for `ok:false`, a string `data` is parsed, array | `.issues` | `.items`), plus `adapter` = `json.adapter` when a string, else `null`.
  - `prefixOf(title) -> string|null` (`/^\s*(\[[^\]]+\])/`), `idOf(data) -> string` (an object with a string or number `id`, or a JSON string holding one; trimmed;
    `''` otherwise).
- **E3 migrate `implement-resume.js` `readEpic`** (:234-297): `const listed = readIssues(call); if (isResult(listed)) return listed;` then the existing epic and
  count loop over `listed.issues`. Delete the moved code. Codes and messages are unchanged (`engine-implement-resume.test.js` pins `MULTIPLE_OPEN_EPICS` and the outage
  `UNAVAILABLE` exit 5 and stays green).
- **E4 `messages.js`**: see Messages below.
- **E5 `verbs/implement-scaffold.js`** (new). `spec`: `exitCodes:[0,1,2,5]`, `group:'implement'`, `name:'scaffold'`, `policyKeys:[]`, `sideEffect:'write'` with a comment (D1),
  `summary: 'create the epic, story and task beads of a TRD, resuming without duplicates'`, `inputSchema` `{additionalProperties:false, properties:{trd:{type:'string','x-operand':true}},
  type:'object'}`, `outputSchema` per D6. Module top requires only `../messages`, `../result`, `../tracker`, `../trd-source`, `../cli-json`, `../../tracker-findings` (so `--describe`
  never loads `trd-cli`). Handler, first refusal wins:
  1. `requireTrd(call)`.
  2. `runTrd(call, ['scaffold-plan', trdPath])`: `json === null` -> `unavailable('SCAFFOLD_PLAN_UNREADABLE', ...)`; `json.ok !== true` -> `refused('SCAFFOLD_PLAN_FAILED',
     MESSAGES.scaffoldPlanFailed(trdPath, json.error))`. `TRD_SLUG = json.slug`; entries = `[plan.epic, ...plan.stories, ...plan.tasks, ...plan.synthesizedTests]`; `WARNINGS` starts with `plan.warnings`.
  3. `readIssues(call)`. Cache: first row with a non-empty id per `prefixOf(title)`; a repeated prefix adds the duplicate warning. `kata = listed.adapter === 'kata'`.
  4. kata only: `runTrd(call, ['scaffold-calls', trdPath])` into a `Map` titlePrefix -> `args`; an entry with no match -> `refused('PLAN_CALLS_MISMATCH', ...)`.
  5. Create loop in entry order (D3, D4): cache hit -> reuse; kata -> `findByKey({run: (cap, args) => callCapability(call, cap, args).json || failure}, {key: args.externalKey})`:
     found -> reuse (an item with no id -> `LOOKUP_FAILED`), not found -> create, `unavailable` -> one warning and no more lookups, `AMBIGUOUS_KEY` -> `refused('AMBIGUOUS_KEY',
     MESSAGES.ambiguousKey(prefix, error.message), {titlePrefix, ids})`; create: kata and not yet known unavailable -> `tracker.create-detailed` with `args` (insertion order), on
     `unavailable` one warning and `tracker.create`; otherwise `tracker.create` with `{title, type, description}`. `idOf(data) === ''` -> `refused('CREATE_NO_ID', MESSAGES.createNoId(prefix),
     details)`; a gate -> `refused(<gate code>, MESSAGES.createFailed(prefix, <gate message>), details)` (`INVALID_INPUT` unchanged); any other failure -> `refused('CREATE_FAILED',
     MESSAGES.createFailed(prefix, message), details)`.
  6. Maps (D6): `ROOT_EPIC_ID`, `PHASE_STORY_IDS`, `TRD_TO_BEAD_MAP`, `PHASE_TASK_IDS` (tasks first, then synthesized tests, D5).
  7. `runTrd(call, ['scaffold-dep-args', trdPath, '--ids', JSON.stringify(<prefix -> id, entry order>)])`: no JSON -> `unavailable('SCAFFOLD_DEP_ARGS_UNREADABLE', ...)`; `ok !== true` -> `refused('DEP_ARGS_FAILED',
     MESSAGES.depArgsFailed(json.error))`. Unique edges by `(id, dependsOnId)` in order. Exported pure helpers for the unit tests: `staleCandidates({phaseTaskIds, beadByTaskId, plannedPairs})`
     (D5) and `partitionEdges(depArgsResult)` -> `{edges, unresolved}`. Stale removal, then `tracker.dep-add` per unique edge (D4, D5), stopping at the first warning.
  8. `tracker.sync` once (D4): `SYNCED` true on `ok`.
  9. Return the data of D6. The verb never reads a file other than through `requireTrd` and writes nothing to the working tree.
- **E6 `groups/implement.js`**: add `require('../verbs/implement-scaffold').spec` to `SPECS` (file-name order).
- **E7 `tests/fixtures/engine/tracker-stub.js`** (new; D12). Exports `createTrackerStub(root, options)`, `runStubCli(argv, {state, log})`, `fixtureTrd(options)`.
  - `createTrackerStub(root, {adapter = 'fixture-tracker', issues = [], declare = {}, createParse = true})` writes, under `root`: the stub binary `<root>/fixture-bin/<bin>` (a generated 4-line
    wrapper that calls `runStubCli(process.argv.slice(2), {state, log})` with absolute paths baked in, state and log under `${root}-tracker/`, OUTSIDE the repository), the adapter manifest
    `packages/fixture-pkg/skills/<adapter>/adapter.yaml` and `SKILL.md`, and `.ensemble/toolchain.yaml` (`tracker: <adapter>`); call it BEFORE `initRepo` so the tree starts clean. Manifest skeleton:
    copy `engine-repo.js:233-249` (`adapter`, `version`, `categories:['tracker']`, `contract:{tracker:'1.0'}`, `binaries`, `allowlist` listing every subcommand below, `env:[]`, `health` = `--version`,
    `detect:[]`) and declare capabilities with flat positional argv modelled on `adapter-tracker-beads/adapter.yaml` (`tracker.create` :147-154 and `tracker.create-detailed` :163-185 with
    `parse {format:'json', root:'$', map:{id:'$.id'}}`; `tracker.dep-add`/`tracker.dep-remove` :347-363; `tracker.list`, `tracker.find-by-key`, `tracker.label`, `tracker.sync` with NO `parse` block, i.e. raw text
    `data`). `adapter:'kata'` names the adapter `kata` in the envelope (the fixture shadows the library kata adapter by discovery order, see section 2) and makes `list` answer open issues only while
    `find-by-key` answers every issue with its `external_ref`. `declare` switches individual capabilities off (`createDetailed`, `depAdd`, `depRemove`, `sync`, `findByKey`: all `true` by default); an
    omitted `tracker.dep-add` yields the `NOT_ALLOWED` "is not declared" envelope, an omitted `tracker.create-detailed` or `tracker.find-by-key` yields `unavailable:true`. `createParse:false`
    omits the `parse` block of `tracker.create`, so a stub answer of `{}` reaches the engine as text with no id.
  - Stub CLI (`--version`, `list`, `find-by-key <key>`, `create <title> <type> <description>`, `create-detailed <title> <type> <description> <labels> <priority> <externalKey>`, `dep-add <id> <dependsOnId>
    <type>`, `dep-remove <id> <dependsOnId>`, `sync`, `comment`, `close`): state `{seq, creates, issues[], control}` in JSON; ids `st-<n>`; `list` prints `{"issues":[...],"total":n}`; `create*` store
    `{id,title,description,type,status:'open',labels,external_ref,priority,dependencies:[]}` and print `{"id":"st-n"}`; `dep-add` is idempotent and prints `{"status":"ok","issue_id":...,"depends_on_id":...,"type":...,
    "action":"added"|"exists"}`; `dep-remove` of an absent edge exits 1 with `dependency not found` on stderr (an assumed shape: REF:67 says only "(ignore an edge-not-found failure)" and the real `br` wording was not captured, Escalation 10). Every call appends one
    JSON line to the log, and every write also appends `MUTATION <argv>`. `control.failCreateAt = n` makes the n-th create (plain or detailed, counted across runs in the state file) exit 1 once.
  - Handle methods: `issues()`, `byPrefix(prefix)`, `edges()` (`[{blocked, blocker}]` in bead ids), `calls()`, `mutations()`, `hash()` (sha256 of the state file), `failCreateAt(n)`, `seedEdge(blockedId, blockerId)`,
    `dropEdge(blockedId, blockerId)`, `setDescription(id, text)`, `setStatus(id, status)`, `adapterDir`, `root`, `log`, `state`.
  - `fixtureTrd({synth = true, interPhaseDepends = false, slug = 'widget-engine'})` returns TRD markdown in the shape of `engine-implement-branch.test.js` `trdDoc` (frontmatter `status: In Progress`,
    `design_readiness_score: 4.5`, `## Master Task List`, two `### Phase N:` sections each with a `**Shippable State:**` line): phase 1 = `TRD-001`, `TRD-001-TEST`, `TRD-002` (`[depends: TRD-001]`),
    `TRD-002-TEST`; phase 2 = `TRD-003`, `TRD-003-TEST`, `TRD-004` (`[depends: TRD-003]`), `TRD-004-TEST`; `synth` adds one loose nested checklist line containing a test keyword under `TRD-001`
    (-> synthesized `TRD-001-TEST-S1`); `interPhaseDepends` makes `TRD-003` declare `[depends: TRD-002-TEST]` and is meant to be used with `synth:false`. Result: 12 beads (1 epic, 2 stories, 8 tasks,
    1 synthesized test) and the plan's edges; the 10th create is `TRD-004`.
  - A first self-test block proves the stub itself: through `main(['tool','run','tracker.list'])` and a write behind a recorded preflight the real toolchain reaches the stub, returns `data` text with
    `issues`, and the `kata` variant reports `adapter: 'kata'` (this also proves the fixture shadows the library adapter).
- **E8 `tests/engine-implement-scaffold.test.js`** (new). Helper `trdRepo({adapter, declare, createParse, issues, synth, interPhaseDepends})`: `makeRepo({files:{README.md, package.json, docs/TRD/widget-engine.md: fixtureTrd(...)},
  init:false})`, `createTrackerStub(fx.root, ...)`, `initRepo(fx)`; `preflight(fx, 'r1')` records a passing preflight with `runMain(['tool','preflight','--require','tracker.list','--require','tracker.create',
  '--run-id','r1'], ctx)` (exit 0); `scaffold(fx, extra)` runs `['--run-id','r1','--non-interactive','implement','scaffold','docs/TRD/widget-engine.md', ...extra]`; `plan(fx)` spawns
  `trd-cli.js scaffold-calls` directly (cwd = root, env = `fx.env`) as the oracle. TRD scenarios, names as in TRD:400-408: **fresh scaffold** (stub holds exactly the plan's beads, in plan order, and the
  plan's edges; `BEADS` `{created:12, reused:0, total:12}`; `git status --porcelain` is empty afterwards), **re-run creates nothing** (`created 0`, `reused` equals the bead count, issue list unchanged), **resume
  after crash** (`failCreateAt(10)`: first run `REFUSED` naming the 10th prefix, exactly 9 beads exist; second run `OK`, no duplicate title, `reused 9`), **empty id refused** (`createParse:false`, stub answers `{}`:
  `REFUSED CREATE_NO_ID` naming the prefix, no later bead exists), **stale edge removed** (seed the D5 pair `TRD-003` blocked by `TRD-001-TEST-S1`: removed, `STALE_EDGES.removed` lists it, planned edges present),
  **map returned** (`TRD_TO_BEAD_MAP` covers every task id and the synthesized one; `PHASE_TASK_IDS['1']` ends with `TRD-001-TEST-S1`; `PHASE_STORY_IDS` has both phases), **kata path** (`adapter:'kata'`: log shows a
  `find-by-key` before each `create-detailed`, no plain `create`, same titles and edges as the default run), **detailed create unavailable** (kata, `declare.createDetailed:false`: plain `create` used, one warning,
  same end state), **stale edge not found ignored** (no legacy edge: every `dep-remove` fails with not-found, run `OK`, `STALE_EDGES.absent === candidates`). Extra scenarios: creates follow plan order and all
  precede the first `dep-add` (Rule 9); **dep-add unavailable** (`declare.depAdd:false`: `OK`, one warning, `EDGES.added 0`, `EDGES.skipped` equals planned, no `dep-add` in the log); **planned inter-phase edge survives**
  (`synth:false`, `interPhaseDepends:true`: the `TRD-003` <- `TRD-002-TEST` edge exists, no `dep-remove` was issued for that pair); a closed kata bead absent from the open-only list is found by key and reused,
  never created again; `AMBIGUOUS_KEY` refused (two stub rows with one `external_ref`); duplicate prefix: first wins and a warning names the ids; **tracker outage** (delete the stub state: `UNAVAILABLE`, exit 5, nothing created);
  gates (no `--run-id`: `REFUSED PREFLIGHT_REQUIRED` naming the first prefix, nothing created; no `--non-interactive` on an unconfirmed adapter: `CONFIRMATION_REQUIRED`); two consecutive re-runs are byte-equal; Rule 6 through
  `main()` (no operand `TRD_REQUIRED` exit 1, missing file `TRD_NOT_FOUND`, `../x.md` `PATH_ESCAPE` exit 2, the stub never called); registration (`engine verbs` lists `implement.scaffold` with side effect `write`;
  `engine schema implement.scaffold` equals the registry's schemas); every `OK` envelope validates against the published `outputSchema`; unit tests of `staleCandidates` (gap in numbering, a planned pair skipped, synthesized tests last)
  and `partitionEdges` (a canned `scaffold-dep-args` result with `unresolved` entries is reported, the AC no stub scenario can reach: the create guard refuses first).

**Messages (WP1).** No source prints a scaffold message: the prose only says "HALT on any failure or empty id." (P2:17). All texts below are AUTHORED in the pattern of `EXECUTE_NEEDS_SCAFFOLD`
(`REF:64`, `ERROR: --execute requires an existing bead scaffold. Run /ensemble:implement-trd-tasks --plan first.`), carry the `ERROR: ` prefix and are listed under Escalation 9. `error.code` and the title
prefix are what tests assert for them. The one verbatim text this flow prints stays in the skill, not in the engine: `Plan complete. Bead hierarchy created. Run /ensemble:implement-trd-tasks --execute to begin
implementation.` (P2:28).

| Function | Template |
|---|---|
| `scaffoldPlanFailed(trdPath, detail)` | `ERROR: could not plan the scaffold of '${trdPath}': ${detail}` |
| `createFailed(titlePrefix, detail)` | `ERROR: could not create bead '${titlePrefix}': ${detail}. Nothing further was created; run it again to resume.` |
| `createNoId(titlePrefix)` | `ERROR: the tracker returned no id for bead '${titlePrefix}'. Nothing further was created; run it again to resume.` |
| `lookupFailed(titlePrefix, detail)` | `ERROR: could not look up bead '${titlePrefix}' by its external key: ${detail}. Nothing further was created.` |
| `ambiguousKey(titlePrefix, detail)` | `ERROR: bead '${titlePrefix}': ${detail}` (`detail` is the `findByKey` text, `tracker-findings.js:209-212`) |
| `depArgsFailed(detail)` | `ERROR: could not resolve the dependency edges: ${detail}. The beads exist; run it again to wire the edges.` |
| `unavailableWarning(capability, detail, consequence)` | `${capability} is unavailable (${detail}); ${consequence}` |
| `failedWarning(capability, subject, detail, consequence)` | `${capability} failed for ${subject} (${detail}); ${consequence}` |
| `duplicatePrefixWarning(prefix, ids, reused)` | `title prefix '${prefix}' is carried by ${ids.length} beads (${ids.join(', ')}); reusing ${reused}` |

**Acceptance mapping (TRD-011, TRD:387-395).**

| AC | Satisfied by | Proved by |
|---|---|---|
| 387 created in plan order from `scaffold-plan`, nothing re-derived | E5 steps 2, 5 | fresh scaffold; plan-order scenario |
| 388 title prefix cache reuse, missing one looked up by external key before creating | E5 steps 3, 5 (key lookup on the kata path only: C2) | re-run creates nothing; closed kata bead reused |
| 389 crash then re-run, no duplicate, counts reported | E5 steps 3, 5, D6 | resume after crash |
| 390 edges added once, existing a no-op, unresolvable reported, stale removed | E5 step 7, D5 | fresh scaffold; stale edge removed; `partitionEdges` unit test |
| 391 `tracker.dep-add` unavailable: warned once, skipped, `OK` with skipped count | E5 step 7, D4 | dep-add unavailable |
| 392 create failure or empty id: `REFUSED` naming the prefix, nothing further | E5 step 5, D4 | empty id refused; resume after crash (first run) |
| 393 returns ROOT_EPIC_ID, story id per phase, TRD_TO_BEAD_MAP, PHASE_TASK_IDS | E5 step 6, D6 | map returned |
| 394 kata: `scaffold-calls`, `find-by-key`, `create-detailed` then `create`, `scaffold-dep-args` | E5 steps 4, 5, 7 | kata path; detailed create unavailable |
| 395 phase N >= 2: stale edge removed through `tracker.dep-remove`, not-found ignored | E5 step 7, D5 | stale edge removed; not found ignored; planned edge survives |

Fail-ability proof (Rule 7), each restored afterwards: make the cache lookup always miss -> "re-run creates nothing" goes red; drop the `return` after a failed create -> "empty id refused" (no later bead) goes red;
remove the planned-pair skip of `staleCandidates` -> "planned inter-phase edge survives" goes red; flip the kata predicate (`=== 'kata'`) -> "kata path" goes red.

Verification (WP1): `cd packages/development && npx jest tests/engine-implement-scaffold.test.js tests/engine-implement-resume.test.js tests/engine-implement-branch.test.js tests/engine-registry.test.js`;
from the root `npx eslint packages/development/tests/engine-implement-scaffold.test.js` and `node --check` on `tracker.js`, `trd-source.js`, `messages.js`, `groups/implement.js`,
`verbs/implement-scaffold.js`, `verbs/implement-branch.js`, `verbs/implement-resume.js` and `tests/fixtures/engine/tracker-stub.js` (all under `packages/development/`).

---

## WP2 - TRD-012 (read-only half) and its tests: `implement bead-health`

Files: new `lib/engine/verbs/implement-bead-health.js`; edits to `lib/engine/{tracker.js,messages.js,groups/implement.js}`; tests `tests/engine-implement-bead-health.test.js` (TRD-012-TEST),
extend `tests/fixtures/engine/tracker-stub.js`.

Order inside this package: E13 and E14 first (red), then E9-E12 (green).

Failing check first: `cd packages/development && npx jest tests/engine-implement-bead-health.test.js` -> every scenario red (`UNKNOWN_VERB` for `implement bead-health`) [INFERENCE: not run in the planning pass].

- **E9 `tracker.js` additions.** `scopeBeads(issues, slug) -> [{id, title, status, labels, description, kind, taskId, prefix}]` (D7: `parseTitlePrefix(title)` slug equality, rows with no id dropped,
  list order kept), `isClosed(bead)` (`String(status).toLowerCase() === 'closed'`), `isTaskLevel(kind)` (`task|test|synth`), `depIdOf(entry)` (`{id}` object or bare string; `null` otherwise).
- **E10 `messages.js`**: see Messages below.
- **E11 `verbs/implement-bead-health.js`** (new). `spec`: `exitCodes:[0,1,2,5]`, `name:'bead-health'`, `sideEffect:'write'` (D1, with the comment), `policyKeys:[]`,
  `summary: 'report how the beads of a TRD differ from its plan, and label, tag or reset them on request'`; `inputSchema` `{trd:{type:'string','x-operand':true}}` in this package (WP3 adds `foreman`, `label`,
  `reset-task`); `outputSchema` (additionalProperties:false; required `MODE`, `ROOT_EPIC_ID`, `TRD_FILE_PATH`, `TRD_SLUG`, `WARNINGS`): `BEADS {found, planned}`, `EDGES {checked, extra[{blocked, blocker}], live,
  missing[{blocked, blocker, type}], planned, reason (string|null), source ('list'|'show'|null), unresolved[{blocked, blocker, type}]}`, `LABELS {expected, missingCount}`, `MODE` (`health`), `REFERENCES {beadContext
  {checked, missing[], ok (boolean|null)}, missingCount (integer|null), openScoped}`, `ROOT_EPIC_ID` (string|null), `TRD_FILE_PATH`, `TRD_SLUG`, `WARNINGS`, `WORK_GRAPH` (D8). Handler, first refusal wins:
  1. `requireTrd(call)`.
  2. `runTrd(call, ['scaffold-calls', trdPath])`: `json === null` -> `unavailable('SCAFFOLD_CALLS_UNREADABLE', ...)`; `ok !== true` -> `refused('SCAFFOLD_PLAN_FAILED', ...)`; slug = `json.slug`; planned beads = `creates`, planned edges = `deps`.
  3. `readIssues(call)`; `scopeBeads`; none -> `refused('NOT_SCAFFOLDED', MESSAGES.notScaffolded(slug))`. `BEADS.found` = planned prefixes with a live bead (first in list order).
  4. Edges (D7): the ladder, then `missing` (both endpoints live, no live edge), `unresolved` (a planned endpoint has no live bead), `extra` (a live edge between two scoped beads that is not planned; this is where an old
     inter-phase edge shows up). All arrays sorted by `blocked` then `blocker` (prefix strings). Source 3 adds `EDGES.reason` and one warning.
  5. Work-graph step (D8): `work-graph.plan`, `work-graph.graph-health`; findings -> `REFUSED WORK_GRAPH_FINDINGS`.
  6. References (D9): `openScoped`, `missingCount`, warning when `> 0`, `bead-context` on `ROOT_EPIC_ID` (first scoped epic, an open one preferred; none -> `beadContext.checked:false` and a warning); failure -> `REFUSED BEAD_CONTEXT_FAILED`.
  7. `LABELS {expected: slug, missingCount}` from the row `labels` arrays (a row with no array counts as missing).
  8. Return the data. Nothing in this package writes: no `tracker.*` write is reachable.
- **E12 `groups/implement.js`**: add `require('../verbs/implement-bead-health').spec` to `SPECS` (file-name order: after `implement-args`).
- **E13 stub extension.** `tracker.show` (`show <id>` prints `{id,title,description,type,status,labels,dependencies:[{id,type}]}`; manifest `parse {format:'json', root:'$', map:{id, title, description:{path,optional:true}, type,
  status, labels:{path,default:[]}, dependencies:{path:'$.dependencies', optional:true}}, statusMap:{open:open, in_progress:in_progress, closed:closed}}`, modelled on beads :68-98). Options: `exposeDependencies` (default
  `true`; `false` leaves `dependencies` out of the manifest map, the shipped-adapter situation), `workGraph` (`'builtin'` default: the manifest omits the `work-graph` category, so the toolchain's links fallback computes
  `graph-health` from `tracker.list` plus `tracker.show`; `'unavailable'`: the manifest declares `work-graph` and no `work-graph.*` capability, so every call is `{ok:false, unavailable:true}`) [INFERENCE: the two work-graph
  behaviours follow `work-graph-resolve.js` and `runner.js:950-984`; the first red run confirms them].
- **E14 `tests/engine-implement-bead-health.test.js`** (new). Fixtures: `healthRepo()` builds the WP1 repo, runs a real `implement scaffold` through `main()` to create the hierarchy, then perturbs the stub.
  TRD-012-TEST scenarios of this package, names as in TRD:425-428: **edge drift reported** (`dropEdge` of one planned edge: `EDGES.missing` holds exactly it with its type; a seeded foreign edge, the D5 legacy pair, is in
  `EDGES.extra`), **cycle refused** (`seedEdge` closing a cycle between two beads: `REFUSED WORK_GRAPH_FINDINGS`, exit 1, `error.details.findings` non-empty), **references counted** (`setDescription` strips the block from two
  open beads: `REFERENCES.missingCount === 2`, one warning, status `OK`), **read only by default** (`hash()` of the stub, `mutations()` empty and `git status --porcelain` empty before and after). Extra: `bead-context` failure (the
  epic description points at `docs/TRD/missing.md`: `REFUSED BEAD_CONTEXT_FAILED`, the message contains `TRD file docs/TRD/missing.md cannot be read: ENOENT`); work-graph unavailable (`workGraph:'unavailable'`: `OK`, two
  warnings, `WORK_GRAPH.status 'unavailable'`); dependency data not exposed (`exposeDependencies:false`: `EDGES.checked false`, `missing` empty, a reason and one warning; never every edge missing); an edge whose endpoint bead was
  deleted from the stub is `unresolved`; `NOT_SCAFFOLDED` on an empty tracker; `LABELS.missingCount` equals the bead count right after a default-path scaffold; two runs byte-equal; Rule 6 through `main()` (`TRD_REQUIRED`,
  `TRD_NOT_FOUND`, `../x.md` `PATH_ESCAPE`; `--label` is `UNKNOWN_FLAG` exit 2 in this package); registration (`engine verbs` lists `implement.bead-health`, side effect `write`; `engine schema` equals the registry's);
  every `OK` envelope validates against `outputSchema`.

**Messages (WP2).** No source prints these; AUTHORED (Escalation 9), `ERROR: ` prefix on refusals. Patterns: `NOT_SCAFFOLDED` after `EXECUTE_NEEDS_SCAFFOLD` (REF:64); `WORK_GRAPH_FINDINGS` after "Non-empty `findings`
HALT before execution until fixed (or /ensemble:refine-beads)" (P2:26); the references warning after "warn with the count of open scoped beads lacking a `## References` block" (P3:9); the label warning after
"an unlabeled bead would make the scheduler sweep the whole repo" (P3:8).

| Function | Template |
|---|---|
| `notScaffolded(slug)` | `ERROR: no beads exist for TRD '${slug}'. Run /ensemble:implement-trd-tasks --plan first.` |
| `workGraphFindings(count)` | `ERROR: work-graph reports ${count} finding(s). Fix the dependencies, or run /ensemble:refine-beads, before execution.` |
| `beadContextFailed(beadId, missing)` | `ERROR: bead-context refused bead ${beadId}:` then one line `  ${entry}` per `missing` entry |
| `referencesWarning(count)` | `${count} open bead(s) of this TRD have no '## References' block` |
| `labelsWarning(count, label)` | `${count} bead(s) of this TRD do not carry the label '${label}'; run implement bead-health --label` |
| `edgesUnreadable(reason)` | `the tracker reports no dependency data (${reason}); the edge diff was skipped` |

**Acceptance mapping (TRD-012, TRD:413-418).**

| AC | Satisfied by | Proved by |
|---|---|---|
| 413 live edges diffed against the plan, missing and extra listed | E11 step 4, D7 | edge drift reported; dependency data not exposed (Escalation 3) |
| 414 work-graph findings returned, non-empty `REFUSED`, unavailable warned and skipped | E11 step 5, D8 | cycle refused; work-graph unavailable |
| 415 count lacking `## References`, `bead-context` failures with every missing entry | E11 step 6, D9 | references counted; `bead-context` failure |
| 418 without `--label` or `--foreman` the tracker is unchanged | E11 (no write reachable) | read only by default |
| Shippable State (TRD:382): "which edges, labels or reference blocks differ" | E11 steps 4, 6, 7 | the three scenarios above plus the label report |

Fail-ability proof: skip the `findings` check -> "cycle refused" goes red; make the reader report every planned edge missing when no source answers -> "dependency data not exposed" goes red; drop the scope filter
(use `includes`) -> a seeded `[trd:widget-engine-v2]` row is counted and the `BEADS` assertion goes red.

Verification (WP2): `cd packages/development && npx jest tests/engine-implement-bead-health.test.js tests/engine-implement-scaffold.test.js tests/engine-registry.test.js tests/engine-policy.test.js tests/engine-mount-parity.test.js`
(the last two prove `policyKeys` and the mounted groups are unaffected); `npx eslint packages/development/tests/engine-implement-bead-health.test.js`; `node --check` on the touched lib files and the fixture.

---

## WP3 - TRD-012 (write paths) and its tests; packaging; whole-slice verification

Files: edits to `lib/engine/verbs/implement-bead-health.js`, `lib/engine/messages.js`, `tests/engine-implement-bead-health.test.js`, `tests/fixtures/engine/tracker-stub.js`,
`scripts/tests/ensemble-bundle-smoke.test.js`; regenerated `packages/pi/vendor/**`.

Order inside this package: E19 and E20 (red), then E15-E18 (green); then E21 and E22 (pin and probes: red against the stale pi vendor copy), then E23 (regenerate: green), then E24-E26.

Failing check first: `cd packages/development && npx jest tests/engine-implement-bead-health.test.js` with the new scenarios -> red (`UNKNOWN_FLAG` for `--label`, `--foreman`, `--reset-task`) [INFERENCE].

- **E15 `messages.js`**: see Messages below (three verbatim constants, one function, authored texts). The substring test lives in `engine-implement-bead-health.test.js` (pattern of `engine-implement-args.test.js:66-76`).
- **E16 `--label`** (D10). `inputSchema` gains `label: {type:'boolean'}`. After every refusing check passed: `runTrd(call, ['beads-label', '--label', slug, '--match', `[trd:${slug}`])`. `json === null` ->
  `unavailable('LABEL_UNREADABLE', ...)`; `json.ok === true` -> `LABEL {already, label, labeled, matched, skipped:false}`; `json.ok === false && json.unavailable === true` -> `LABEL {..., skipped:true}` and a warning that
  names `json.reason`; any other result (`json.error`, exit 1) -> `refused('LABEL_FAILED', MESSAGES.labelFailed(detail))`. This path runs the tracker in-process and is NOT gated by the run id (Escalation 5).
- **E17 `--foreman`** (D10). `inputSchema` gains `foreman: {type:'boolean'}`; the name is the prose flag (REF:73), it does not imply `--non-interactive` here (the caller passes it, or `FOREMAN_TASK_TITLE` is set).
  After the checks and after `--label`: `taskBeads` = scoped task-level beads; for each bead whose `labels` lack `foreman-exec`, `tracker.label` with `{ids: <id>, labels: 'foreman-exec'}`: a gate is returned unchanged,
  any other non-`ok` kind -> `refused('FOREMAN_TAGGING_FAILED', MESSAGES.foremanTaggingFailed(prefix, message), {titlePrefix})` and no further call; then `tracker.sync` (a warning on failure); then `readIssues(call)` and
  count the scoped rows carrying `foreman-exec`; unequal to `taskBeads.length` -> `refused('FOREMAN_TAGGING_INCOMPLETE', MESSAGES.foremanTaggingIncomplete(tagged, listed), {tagged, listed})`. Data `FOREMAN {alreadyTagged,
  labelled, listed, tagged}`. The epic and the stories are never passed to `tracker.label`.
- **E18 `--reset-task`** (D10). `inputSchema` gains `'reset-task'`. Mode `reset-task`: `requireTrd`, slug from `slugOf` (lazy `trd-cli` `deriveSlug`, as `trd-source.js` does) , `readIssues`, candidates whose `title.includes('[trd:<slug>:task:<id>]')`.
  Zero -> `refused('RESET_TASK_NOT_FOUND', MESSAGES.resetTaskNotFound(id, slug))`; several -> `refused('RESET_TASK_AMBIGUOUS', MESSAGES.RESET_TASK_AMBIGUOUS, {ids})`; one -> `tracker.set-status` with
  `{id: <bead id>, status: 'open'}`: a gate is returned unchanged, `unavailable` -> `unavailable('RESET_TASK_UNAVAILABLE', ...)`, other failures -> `refused('RESET_TASK_FAILED', MESSAGES.resetTaskFailed(beadId, message))`.
  Data `MODE:'reset-task'`, `RESET_TASK {beadId, previousStatus, status:'open', taskId}`, `TRD_FILE_PATH`, `TRD_SLUG`, `WARNINGS`. `--reset-task` with `--label` or `--foreman` ->
  `refused('RESET_TASK_EXCLUSIVE', exclusive('--reset-task', '--label' | '--foreman'))` before any read. `outputSchema` gains `FOREMAN`, `LABEL`, `RESET_TASK` and `MODE`'s second value; in `reset-task` mode the health keys are absent
  (they are not in `required`).
- **E19 stub extension.** Capabilities `tracker.label` (`label <id> <label>`, raw text, adds to `labels`, idempotent), `tracker.set-status` (`set-status <id> <status>`, `parse {format:'json', root:'$', map:{id:'$.id', status:'$.status'},
  statusMap}`), declared by default; `declare.label:false` omits `tracker.label` (-> `{ok:false, unavailable:true}`), `declare.setStatus:false` omits `tracker.set-status` (-> `NOT_ALLOWED` undeclared); control `dropLabelFor(ids)`
  (the stub accepts the label call and silently does not store it: the tagging count mismatch) and `failLabel()` (the stub exits 1 on `label`, which `beads-label` sees as a hard failure).
- **E20 test extension** (TRD-012-TEST, names as in TRD:429-432): **label backfill** (default-path scaffold, then `--label`: `LABEL.labeled` equals the bead count, every stub bead carries the label; a re-run: `labeled 0`,
  `already` equals the count), **reset one bead** (`setStatus(id, 'closed')`, `--reset-task TRD-002` with a run id: set to `open`, `RESET_TASK.previousStatus 'closed'`), **reset none or ambiguous refused** (`TRD-999`: `REFUSED`,
  `error.message` equals `MESSAGES.resetTaskNotFound('TRD-999', 'widget-engine')`; a second seeded row with the same prefix: `error.message` equals `MESSAGES.RESET_TASK_AMBIGUOUS`; both also contain the REF:69 text), **foreman tags
  tasks only** (`--foreman` with a run id: no epic and no story carries `foreman-exec`, every task-level bead does, `tracker.sync` was called, `FOREMAN.tagged` equals the task count; with `dropLabelFor` on one task: `REFUSED
  FOREMAN_TAGGING_INCOMPLETE` whose message starts with the REF:73 text and carries both counts). Extra: `--label` with `declare.label:false` is `OK` with a warning (`LABEL.skipped`), with `failLabel()` it is `REFUSED LABEL_FAILED`;
  `--foreman` after a cycle finding is `REFUSED WORK_GRAPH_FINDINGS` and the log holds no `label` call (only after the work-graph step); with `workGraph:'unavailable'` tagging proceeds; `--foreman` and `--reset-task` without a run id are `REFUSED
  PREFLIGHT_REQUIRED` and the stub is unchanged; `--reset-task` with `--label` is `RESET_TASK_EXCLUSIVE` and nothing ran; a failing `tracker.label` is `FOREMAN_TAGGING_FAILED` naming the bead; the verbatim constants are substrings of
  `REF` (`MESSAGES.RESET_TASK_NOT_FOUND`, `RESET_TASK_AMBIGUOUS` at line 69, `FOREMAN_TAGGING_INCOMPLETE` at line 73); `outputSchema` check for every mode.
- **E21 `scripts/tests/ensemble-bundle-smoke.test.js:243-271`**: add `'tracker.js'` (between `'staleness.js'` and `'trd-source.js'`), `'verbs/implement-bead-health.js'` (after `implement-args`) and
  `'verbs/implement-scaffold.js'` (after `implement-resume`) to `required`. Red against the stale pi vendor tree.
- **E22 launcher probes** (same file, `the dereferenced bundle runs bin/ensemble`, :91-150): in the bundle copy, `engine schema implement.scaffold` and `engine schema implement.bead-health` exit 0 with `data.group 'implement'` and
  the verb's `name`; `implement bead-health` with no operand exits 1 with one JSON object whose `error.code` is `TRD_REQUIRED` (the handler really loads from the bundle); `--describe` lists `implement` `scaffold` and `bead-health`
  with side effect `write`.
- **E23 packaging.** From the repository root: `npm run generate:pi`; accept what it writes (new `packages/pi/vendor/lib/engine/{tracker.js,verbs/implement-scaffold.js,verbs/implement-bead-health.js}` and updated copies of
  `messages.js`, `trd-source.js`, `groups/implement.js`, `verbs/implement-branch.js`, `verbs/implement-resume.js`); no version bump is expected (the hook ignores `vendor/`, section 2). Never hand-edit a generated file.
  No command or skill YAML changes in this PR, so `npm run generate` must leave nothing new; `npm run generate:validate` proves it.
- **E24 whole-slice verification** (once, from the repository root, in order; each command must exit 0): `npm run generate:validate`; `npm run validate`; `cd packages/development && npx jest tests/engine` (the engine tests: policy,
  input-boundary, registry, envelope, mount-parity, fixture-env, team-without-js-yaml, args, env, resume, team, branch, scaffold, bead-health); `cd packages/development && npx jest`; `cd packages/pi && npx jest`; then from the
  root (`jest.config.js`; CI runs `npx jest scripts/tests`) first the bundle files `npx jest scripts/tests/ensemble-bundle-smoke.test.js scripts/tests/full-bundle-install-smoke.test.js
  scripts/tests/validate-bundle-data-paths.test.js scripts/tests/validate-bundle-bare-requires.test.js scripts/tests/validate-full-bundle-requires.test.js scripts/tests/validate-full-lib-references.test.js
  scripts/tests/validate-full-skills-mirror.test.js scripts/tests/toolchain-vendor-sync.test.js`, then `npx jest scripts/tests`. Then the launcher probe against the real checkout: `node packages/full/bin/ensemble --describe` lists 45
  verbs and 7 in `implement`, `node packages/full/bin/ensemble engine schema implement.scaffold` exits 0, `node packages/full/bin/ensemble implement bead-health` exits 1 with `TRD_REQUIRED`, and `--describe` stays under 200 ms
  (`time`). Legacy CLIs unchanged: `tests/engine-mount-parity.test.js` compares `trd-cli.js` and `toolchain-cli.js` with their committed blobs, and `git diff --exit-code <merge-base with dev> -- packages/development/lib/trd-cli.js
  packages/development/lib/toolchain-cli.js packages/development/lib/scaffold-planner.js packages/development/lib/beads-label.js packages/development/lib/tracker-findings.js packages/development/lib/bead-refs.js
  packages/development/toolchain packages/development/skills packages/development/commands` exits 0. Then the drift check: `git status --porcelain > before.txt`, run `npm run generate:pi` again, `git status --porcelain >
  after.txt`; `diff before.txt after.txt` must be empty (write both files under `~/.omp/<task-dir>/`, not in the repository). The slice is uncommitted until Foreman commits it, so an empty `git status --porcelain` is not the
  criterion: regeneration must be idempotent, and the status may list only files this plan names and the regenerated `packages/pi/vendor/**`. `toolchain-detect.test.js`, `performance.test.js` and
  `toolchain-preflight-language-gate.test.js` assert wall-clock timing: if one fails, re-run it alone before reporting.
- **E25 fail-ability proofs** (each restored afterwards): let `--foreman` label the epic -> "foreman tags tasks only" goes red; skip the count comparison -> the mismatch scenario goes red; remove the `RESET_TASK_EXCLUSIVE` check ->
  its scenario goes red; change one character of `RESET_TASK_AMBIGUOUS` -> the substring test goes red; remove the bundle pin entries once -> E21's list goes red against the vendor tree, then restore.
- **E26 the pull-request body** must state: (1) `implement scaffold` and `implement bead-health` are registered `write`, and `bead-health` writes only behind `--label`, `--foreman` and `--reset-task` (tests prove no write
  without them); (2) neither task is listed as security-sensitive by the TRD (TRD:701 names TRD-001 and TRD-016) but both write to the tracker through the existing gated capabilities, and `--label` uses the ungated in-process path;
  (3) the escalations below that need a human decision, in particular 3 (the edge diff on beads and kata) and 4 (confirmation); (4) the authored message texts; (5) `ensemble --describe` goes from 43 to 45 verbs.

**Messages (WP3).** The verbatim texts are copied from the file named, never retyped (each is ONE line there). The TRD's own wording differs from the source in the places marked; the engine prints the source (C9, C10).

| Constant | Printed verbatim | Source | TRD wording (not printed) |
|---|---|---|---|
| `RESET_TASK_NOT_FOUND` (template; `resetTaskNotFound(taskId, slug)` replaces `<ID>` and `<slug>`) | `ERROR: No bead found for TASK_ID=<ID> with TRD_SLUG=<slug>` | REF:69 | `No bead found for TASK_ID=<id> with TRD_SLUG=<slug>` (TRD:419) |
| `RESET_TASK_AMBIGUOUS` | `ERROR: Multiple beads match — ambiguous TASK_ID, please be more specific` (em dash U+2014) | REF:69 | `Multiple beads match - ambiguous TASK_ID, please be more specific` (ASCII hyphen, TRD:419) |
| `FOREMAN_TAGGING_INCOMPLETE` (+ authored count suffix) | `ERROR: foreman-exec tagging incomplete` | REF:73 | `foreman-exec tagging incomplete` (TRD:420) |

Authored (Escalation 9): `foremanTaggingIncomplete(tagged, listed)` = `${FOREMAN_TAGGING_INCOMPLETE} (tagged ${tagged}, tracker.list reports ${listed})` (REF:73: "with both counts"); `labelFailed(detail)` = `ERROR: could not label the
beads of this TRD: ${detail}`; `foremanTaggingFailed(titlePrefix, detail)` = `ERROR: could not tag bead '${titlePrefix}' with foreman-exec: ${detail}. Nothing further was tagged.`; `resetTaskFailed(beadId, detail)` = `ERROR: could not set bead
${beadId} to open: ${detail}`; the label-skipped warning is `unavailableWarning('beads-label', reason, 'the beads of this TRD stay unlabelled')`. The REF:69 refusals exit 1 in the prose (REF:69 "exit 1"); the engine's `REFUSED` is exit 1.
`FOREMAN_LABEL = 'foreman-exec'` is a constant in the verb with the anchor REF:73, not a message.

**Acceptance mapping (TRD-012, TRD:416-420).**

| AC | Satisfied by | Proved by |
|---|---|---|
| 416 `--label` through `beads-label`, unavailable a warning, any other failure `REFUSED` | E16, D10 | label backfill; label unavailable; label failed |
| 417 `--foreman` per the reference, only after the work-graph step succeeded | E17, D8, D10 | foreman after a cycle finding; unavailable work-graph proceeds |
| 419 `reset-task`: one set open, none and several `REFUSED` with the exact message | E18, D10, E15 | reset one bead; reset none or ambiguous; substring test |
| 420 only task-level beads labelled `foreman-exec`, tracker synced, count mismatch `REFUSED` | E17, D10 | foreman tags tasks only |

Verification (WP3): the whole-slice section E24 above; before it, `cd packages/development && npx jest tests/engine-implement-bead-health.test.js tests/engine-implement-scaffold.test.js`, `npx eslint
packages/development/tests/engine-implement-bead-health.test.js scripts/tests/ensemble-bundle-smoke.test.js`, and `node --check` on the touched lib files and the fixture.

---

## 4. Contradictions found (TRD text versus code or prose)

- **C1 The stale inter-phase edge.** TRD:395: "the stale edge from the first task bead of phase N to the last task bead of phase N-1 is removed through `tracker.dep-remove`, and an edge-not-found failure is ignored". Code: the plan has four
  edge types and none between phases (`scaffold-planner.js:29`, :507-565). Prose: "Also remove stale inter-phase edges from older scaffolds (reference section 5)." (P2:18) and "for phase N>=2" ... "(ignore an edge-not-found failure)." (REF:67).
  History (`02adb402^`, `implement-trd-beads.yaml:640`): "These are task→task deps of the form: 'first task of phase N' depends on 'last task of phase N-1'." Resolution: D5. The edge is an inter-phase gate of a pre-planner
  scaffold; it is derived from `PHASE_TASK_IDS`, not searched; a planned pair is never removed.
- **C2 External-key lookup.** TRD:388: "a missing one is looked up by external key before creating". Prose: the lookup exists only on the kata path ("tracker.find-by-key --arg key=<externalKey> (also sees closed items)", P2:6), and the default path says
  "Never re-query per bead." (P2:16) and creates with no key (P2:17). Resolution: kata only (D3); the default cache is complete (beads lists closed beads) and a per-bead `find-by-key` would list the whole tracker per bead.
- **C3 `scaffold-plan` or `scaffold-calls`.** TRD:387 says "from `scaffold-plan`"; TRD:394 and P2:5 use `scaffold-calls` on kata. Resolution: `scaffold-plan` always, `scaffold-calls` for the kata arguments, `scaffold-dep-args` for edges on both paths (D3).
- **C4 The counts.** TRD:389 "created, reused and skipped counts"; the prose has none (P2:19: "Print epic id and story/task/dep counts."). Resolution: D6 (`BEADS.created`, `BEADS.reused`, `EDGES.skipped`).
- **C5 "Unavailable" dep-add.** TRD:391 and P2:18 say `{ok:false,unavailable:true}`; the contract gives `tracker.dep-add` no fallback, so an adapter that omits it answers `NOT_ALLOWED` (`runner.js:985-993`), and P1:24 says "tracker.dep-add/sync are optional,
  degrade on {ok:false}." Resolution: D4 treats the "is not declared" `NOT_ALLOWED` as unavailable (the `tracker-findings.js:50` precedent) and degrades on any non-gate failure.
- **C6 The edge diff.** TRD:413 "live edges are diffed against the plan"; no prose source exists, no capability lists edges (REF:68), `tracker.show` maps no `dependencies` on beads or kata. Resolution: D7 ladder and Escalation 3.
- **C7 `bead-context`.** TRD:415 "`bead-context` failures are listed with every missing entry"; P3:9 "`ok:false` or non-zero -> print every `missing` entry and HALT before beads-build." Resolution: `REFUSED` listing every entry (D9), epic only as in the prose.
- **C8 Read-only default.** TRD:418 "the tracker is unchanged" without `--label` or `--foreman`; P3:8 backfills labels in the command flow. Resolution: the verb is read-only by default; the skill's backfill becomes a `--label` call in the later skill-thinning PR.
- **C9 `reset-task` texts.** TRD:419 `No bead found for TASK_ID=<id> with TRD_SLUG=<slug>` and `Multiple beads match - ambiguous TASK_ID, please be more specific`; REF:69 `ERROR: No bead found for TASK_ID=<ID> with TRD_SLUG=<slug>` and
  `ERROR: Multiple beads match — ambiguous TASK_ID, please be more specific`, exit 1. Differences: `ERROR: ` prefix, `<id>` casing, the em dash. The TRD's hyphen string is not in the repository outside the TRD. Resolution: the source text (D11); the thinned skill must keep printing what it prints.
- **C10 `foreman-exec` count.** TRD:420 and REF:73: "verify a `tracker.list` count for label `foreman-exec` equals tagged count" read literally compares a tracker-wide count with this run's count: another TRD's tagged beads would refuse a correct run.
  Resolution: scoped rows against the task-level scoped beads (D10), Escalation 7.
- **C11 "only after the work-graph step succeeded".** TRD:417 and REF:73 "Tag beads for dispatch only after `work-graph.plan`/`work-graph.ready` succeeds"; P2:26 "{unavailable:true} on either -> warn and skip it". Resolution: D8 (skipped does not block; failed or findings do).
- **C12 Capabilities outside the manifest.** The prose uses `tracker.dep-remove` (REF:67), `tracker.label` (REF:73) and `tracker.set-status` (REF:69); `commands/implement-trd-tasks.yaml:20-30` lists none as optional and `implement-env.js` mirrors that list. Resolution: not edited (editing regenerates
  the command mirrors); the verbs handle absence at call time (D4). Escalation 15.
- **C13 No fixture in TRD-012-TEST.** TRD:398 names `tracker-stub.js` for TRD-011-TEST only; TRD:423 lists the test file alone. Resolution: reuse and extend the same fixture (D12).
- **C14 `reset-task` has no file of its own.** TRD:410 names it in the title; TRD:411 lists only `implement-bead-health.js`. Resolution: `--reset-task <id>` on `bead-health` (D10, the flag name of `args`, `implement-args.js:283`).
- **C15 `args` only reports the early exit.** `implement-args.js:166-170` returns `{action:'reset-task', taskId}` and performs nothing (PR 2). Resolution: `bead-health --reset-task` performs it.
- **C16 Empty id.** TRD:392 "any create failure or empty id"; with a `parse` block an empty id never passes the schema gate (`work-item.json`, `id` `minLength 1`), it surfaces as a failure. Resolution: the engine guards `idOf` anyway (a raw-text adapter can answer no id); both end `REFUSED`.
- **C17 Story ids.** TRD:393 "the story id per phase"; the prose names no variable for it (P2:17 "story ids by phase"). Resolution: the key `PHASE_STORY_IDS` (D6).
- **C18 History-only texts.** The pre-thinning command printed `Removed stale inter-phase-gate dep: <lastPrevBead> → <firstCurBead>` (arrow U+2192) and `No stale inter-phase-gate dep to remove.` (`02adb402^:packages/development/commands/implement-trd-beads.yaml`, line 640, one bullet). They exist nowhere in the working tree, so
  they cannot be pinned by a source-substring test; they are NOT constants (the same facts are `STALE_EDGES` data).
- **C19 Scout errors corrected.** (a) The prose scout said `messages.js:20` differs from P1:8: it is a substring of P1:8 (checked), nothing to reconcile. (b) It said `bead-context` failures are per scoped bead: P3:9 runs it for the epic. (c) The libs scout said kata
  `find-by-key` filters server-side; it also maps `external_ref` and the caller still selects by exact key (`tracker-findings.js:202-218`). (d) PR 2's D12 (`PLAN-pr2-workpackages.md:161-162`) said of `confirm-status` and `tracker.sync` "both stay with the later mutating verbs": no TRD task owns `confirm-status`
  (Escalation 4); `tracker.sync` is implemented here as P2:19 has it.

## 5. Escalations (human decisions)

1. **Security sensitivity (tracker writes).** TRD:701 marks only TRD-001 and TRD-016 as security-sensitive (human security reviewer, auto-merge off); Constitution section 4 lists "Security-sensitive code" as needing approval. TRD-011 and TRD-012 write to the tracker
   (create, edge add and remove, sync, label, set-status) but add no boundary: they use the existing gated capabilities (D4), validate their inputs (D14) and spawn argument arrays. Default: not treated as security-sensitive; the PR body says they write (E26).
   The one point a reviewer may want to see is item 5.
2. **`bead-health` is registered `write`.** Its default mode writes nothing; the class describes capability (PR 2 D7). Default: registered `write`, the PR body says so (E26). Alternative: split a read verb `bead-health` from a write verb for `--label`, `--foreman` and `--reset-task`.
3. **The edge diff cannot read live edges on the shipped adapters.** No capability lists edges (REF:68), `br list` rows carry only `dependency_count`, and neither the beads nor the kata `tracker.show` mapping maps `dependencies` (D7). Default: the ladder of D7, an honest
   `EDGES.checked:false` plus a warning, and a stub that exposes `dependencies` so the diff is proven. Decision for the operator: map `dependencies` in those two `tracker.show` manifests (adapter and normalized-schema work, outside this PR). Reading `tracker.stage-export` (beads JSONL)
   was rejected: the export is the on-disk mirror (`cat .beads/issues.jsonl`, beads `adapter.yaml:421-423`) and can lag the database [INFERENCE].
4. **Confirmation.** `scaffold`, `--foreman` and `--reset-task` call side-effecting capabilities, so an interactive run on an unconfirmed adapter is refused with the toolchain's own `CONFIRMATION_REQUIRED` text and a run without `--run-id` with `PREFLIGHT_REQUIRED`. The verbs do not call
   `confirm-status` / `confirm-record` (P1:49 "Call node "$TOOLCHAIN_CLI" confirm-status tracker.create before this command's first write"): no TRD task owns it, the mounted `tool confirm-status` / `tool confirm-record` verbs exist, and PR 2's claim that the later mutating verbs own it
   is not backed by a task (C19d). Default: not implemented; the caller (skill or the later driver) confirms first, or passes `--non-interactive`.
5. **`--label` is ungated.** `trd-cli beads-label` runs `tracker.label` in-process and omits the preflight, confirmation and ledger gates (`beads-label.js:25-37`); the TRD asks for it ("labelled through `beads-label`", TRD:416). Default: as specified. Alternative: loop `tracker.label` through
   `toolchain-cli run` (gated, ledgered).
6. **External-key lookup only on the kata path** (C2). TRD:388 reads as general. Default: kata only.
7. **The `foreman-exec` verification is scoped to the TRD's beads** (C10). Default: scoped rows against task-level scoped beads. Alternative: the literal tracker-wide count.
8. **Message wording** (C9). Default: the source texts, `ERROR: ` prefix and em dash included, with `<ID>` and `<slug>` substituted; the TRD's retyped forms are not printed. A test pins each constant as a substring of REF.
9. **Authored message texts need wording review** (tables of WP1, WP2, WP3). `error.code`, the title prefix and the counts are what tests assert for them. Default: ship the authored texts; a rewording changes one constant in `messages.js`.
10. **Stale-edge rule choices** (D5): planned pairs are never removed (not in the prose); "edge not found" is recognised by a message pattern because the real `br dep remove` wording for an absent edge was not captured (only the success sample exists:
    `br-dep-remove.sample.json`); kata's remove is idempotent so `removed` may over-count there; literal `N-1` leaves a gap in the numbering without a candidate. Default: as listed (D5).
11. **`skipped` and `PHASE_STORY_IDS`** (C4, C17): the TRD's "skipped" is read as skipped edges; the story map name is authored. Default: as read.
12. **Degrade rules** (D4): any non-gate failure of `tracker.dep-add` or `tracker.sync` warns and continues (P1:24); a half-wired scaffold is visible in `EDGES.skipped` and in `bead-health` (when edges are readable, item 3). Default: warn and continue.
13. **`--reset-task` on kata** finds open beads only (`tracker.list` is open-only there): a closed kata bead reports `RESET_TASK_NOT_FOUND`. Default: replicate the recipe of REF:69; a `find-by-key` fallback is a later change.
14. **Work-graph scope** (D8): the capabilities run repository-wide, as in the prose (P2:26, P3:12), so a finding in another TRD's beads refuses this TRD's health check and `--foreman` tagging. Default: as the prose.
15. **The command manifest is not updated** (C12): `tracker.dep-remove`, `tracker.label`, `tracker.set-status` stay undeclared as optional capabilities. Default: not updated (editing it regenerates the command mirrors).
16. **Regeneration command.** The task text names `npm run generate --workspace=packages/pi`; the plan runs `npm run generate:pi` (the same command plus the `postgenerate:pi` hook, as PR 2's plan did). Nothing else is regenerated. Default: `npm run generate:pi`.
17. **Known limits.** The id map is passed inline to `scaffold-dep-args --ids`: a single argv string above about 128 KiB (roughly 1,800 beads) would fail on Linux (the CLI also accepts `--ids @file`, a later change). A scaffold run is about 35 child processes for 12
    beads (a real TRD of 52 beads and 125 edges is about 180): the tests keep to the 12-bead fixture and a 300 s test timeout. Default: accepted as stated.
18. **Docs and skill.** `docs/guides/ensemble-engine.md`, the changelog and versions (TRD-023), and the skill and command prose are not touched; module headers carry the contracts until then. Default: not touched.

## 6. Out of scope

- Everything after TRD-012: the gate, verification, closure, checkbox sync, PR creation, the hand-off protocol, `delegate` (TRD-019, which repeats the label backfill and the References check itself), `plan`/`next`, the thinned skill, `docs/guides/ensemble-engine.md`, versions and the changelog.
- The skill prose, the command manifest and the golden fixtures are not edited and nothing is regenerated from them: that includes the `PLAN_ONLY` completion text (P2:28), the "continue / refine-beads / abort" triage question (P2:26), `--status`, `--list` and the
  workstream scaffold (`workstream-plan`, `--legacy-multi`).
- Do NOT modify `lib/trd-cli.js`, `lib/toolchain-cli.js`, `lib/scaffold-planner.js`, `lib/beads-label.js`, `lib/tracker-findings.js`, `lib/bead-refs.js`, anything under `lib/toolchain/`, `packages/development/toolchain/` or any adapter manifest, and add no `tracker.dep-list`
  capability.
- No `confirm-status` / `confirm-record` calls, no `parse` call and no workstream edges in `scaffold` (`trd parse` warnings are not carried: `resume` and `validate` own TRD validation).
- No second dispatcher, daemon, lock or durable store (Rule 4): the only writes are tracker writes through the toolchain and, in tests, the fixture's own files.
- No edit to `packages/pi/vendor/**` or `packages/full/skills/**` by hand; WP3 regenerates.
- Do not touch `.beads/`, run `br` mutations, push to `dev` or `main`, or merge.
