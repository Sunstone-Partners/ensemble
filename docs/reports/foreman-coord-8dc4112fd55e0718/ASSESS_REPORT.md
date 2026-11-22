# ASSESS_REPORT — task `coord-8dc4112fd55e0718`

**Phase:** `assess` / impact-analysis (phase 1) · **Run:** `run-c138a191dbdeb5c3096147b5f64e59b1`
**Task:** Verify on `dev` that three cancelled defects (inline MoSCoW priorities, TRD `prd_reference`/`prd_path`, Foreman env detection) are really fixed
**Date:** 2026-11-22 · **Mode:** read-only verification — no code changes, no PR

| Field | Value |
| --- | --- |
| Workspace | `/Users/ldangelo/.foreman/worktrees/ensemble/coord-8dc4112fd55e0718/run-c138a191dbdeb5c3096147b5f64e59b1/workspace` |
| Branch | `foreman/coord-8dc4112fd55e0718/run-c138a191dbdeb5c3096147b5f64e59b1` (0 commits, 0 changed files) |
| `HEAD` | `a0d6a213173446765b35374221afe84bf441cc75` |
| `dev` | `a0d6a213173446765b35374221afe84bf441cc75` |
| `origin/dev` | `a0d6a213173446765b35374221afe84bf441cc75` |
| Base ref drift | none — `git diff --stat dev HEAD` is empty; `dev == origin/dev == HEAD` |
| Toolchain | node `v26.13.1`, npm `11.20.0` (`engines.node` = `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` → satisfied) |

---

## 0. Task shape — what "impact" means for this phase

The task is a **read-only verification**, not an implementation. Consequences for this report:

- **No source file is expected to change.** §1 lists the files that must be *read* to justify a verdict, not edited. The only file this phase creates is this report.
- **"Impact"** = the code paths the three defects reach, so each verdict can be argued from implementation + a negative test rather than from a test name.
- **No discovery artifact existed.** `docs/reports/foreman-coord-8dc4112fd55e0718/` did not exist when this phase started, and no `DISCOVER_REPORT.md` is present in the tree. §1/§2 were therefore re-derived directly from source; this report carries its own evidence tables rather than referencing a discovery file.

### Hard constraints and their effect on this phase

| Constraint | Effect |
| --- | --- |
| Read-only: no code changes, no PR | zero edits; branch has no commits; no push |
| Work only in the own worktree; never create worktrees/clones/scratch under `/tmp` | scratch written only to `~/.omp/coord-8dc4112fd55e0718/` |
| Never claim a result not observed | every verdict in §6 cites a command whose real output is quoted in §4 |
| If the `pi` provider fails, report the reason explicitly instead of going silent | provider probed explicitly — see §4.5 (it succeeded) |
| Stage only files you changed, by name (AGENTS.md) | only `docs/reports/foreman-coord-8dc4112fd55e0718/ASSESS_REPORT.md` is new |

### Operator progress updates

| Tool | Result |
| --- | --- |
| `foreman_inbox_send` | **sent** — `{"status":"sent","message_id":"msg_X-sTBDoep80j-3TVS8vqAg"}` |
| `foreman_task_add_comment` | **failed** — `{"code":"INVALID_STATE","message":"Task external_id is malformed"}`; no task Work Log comment was written, so it is recorded here instead |

---

## 1. Scope

### 1.1 Files that will change

| File | Change |
| --- | --- |
| `docs/reports/foreman-coord-8dc4112fd55e0718/ASSESS_REPORT.md` | **new** (this report) |

No other file is written, staged or committed by this phase.

### 1.2 Files that must be read to reach a defensible verdict

| Defect | Primary implementation | Guard / covering test | Packaging surface |
| --- | --- | --- | --- |
| 1 — inline MoSCoW priority | `packages/development/lib/prd-parser.js:73` (`REQ_PRIORITY_LINE_RE`), `:78` (`REQ_PRIORITY_INLINE_RE`), `:89-95` (`normalizeMoscowTag`), `:105-137` (`extractReqPriorities`) | `packages/development/tests/prd-parser.test.js:204, 209, 215, 220, 225, 239, 244, 260, 275` | — (pure JS, no generated mirror) |
| 2 — TRD `prd_reference` / `prd_path` | `packages/development/lib/trd-parser.js:206` (`PRD_REFERENCE_KEYS`), `:212` (`PRD_PATH_KEYS`), `:382` (`looksLikePath`), `:402-437` (`extractPrdReference`) | `packages/development/tests/trd-frontmatter-key-spelling.test.js:87-137` (describe at `:93`), `:140-175` (`trd-cli` list/status) | — (pure JS) |
| 3 — Foreman env detection | `packages/development/skills/ensemble-new-feature/SKILL.md:30`; `skills/ensemble-new-feature/references/phase-1-entry-point-resolution.md:12`; `references/phase-3-execute-stage.md:40,51`; `skills/ensemble-feature/SKILL.md:37` (**the suspected gap**) | `packages/development/tests/helpers/foreman-invariants.js:132-143` (`envEntry` group), `:157-176` (`checkFrontDoor`); `tests/new-feature-foreman.test.js:41,136-147`; `tests/feature-foreman-passthrough.test.js` | skill-backed → mirrored into `packages/git/skills/**` and `packages/pi/skills/**` (generated) |

Manifests checked and found to be **thin pointers only** (no prompt text, therefore no `FOREMAN_TASK_TITLE` possible there):

- `packages/development/commands/feature.yaml` — 13 lines, ends with `skill: ensemble-feature`
- `packages/development/commands/new-feature.yaml` — 15 lines, ends with `skill: ensemble-new-feature`

---

## 2. Impact

| Affected module | Direct consumers | What a wrong verdict would hide |
| --- | --- | --- |
| `lib/prd-parser.js` → `extractReqPriorities` (exported at `:232`) | JS: only `tests/prd-parser.test.js`. Contract consumer: `packages/development/skills/completion-verification/SKILL.md:157-179` (Must/Should coverage gate + "every parsed REQ has `priority === null`" incompleteness check at `:171-179`) and the format spec at `:330-336` | the defect was exactly "the Must/Should gate had nothing to fire on" (`prd-parser.js:67`); a false FIXED would let a real coverage gate stay dark |
| `lib/trd-parser.js` → `extractPrdReference` → `parseTRD` (`:939`, field at `:1117`) | `lib/trd-cli.js`, `lib/workstream-trd.js`, `lib/workstream-planner.js`, `lib/trd-graph.js`; test surface spans ≥14 suites (`trd-cli.test.js`, `trd-graph.test.js`, `scaffold-*.test.js`, `workstream-*.test.js`, `bead-context.test.js`, `packages/full/tests/trd-cli-bundled.test.js`) | a TRD whose `prd_reference` is a document id would silently lose its PRD link in every one of those consumers |
| Foreman env detection → skill text | `skills/ensemble-new-feature/**`, `ensemble-create-trd:11`, `ensemble-refine-trd:16`, `ensemble-fix-issue:16`, `ensemble-implement-trd-tasks:37`, `ensemble-analyze-complexity:29`, `ensemble-pr-merge` → generated mirrors `packages/git/skills/**`, `packages/pi/skills/**` | approval-gated skills that stop auto-approving under Foreman dispatch → the run stalls waiting for a human that is not present (the whole point of the amendment) |
| `skills/ensemble-feature/SKILL.md` (front door, REQ-008) | dispatches only `../ensemble-new-feature/SKILL.md` (4 keywords: new/resume/status/abandon) | front door sets `FOREMAN = false` for env-only dispatch and forwards no `--foreman`; **no test asserts any env rule here** (`checkFrontDoor` covers extraction/insertion/ordinary-text only) |

---

## 3. Risks

| # | Sev | Failure mode | Evidence / mitigation |
| --- | --- | --- | --- |
| R1 | High | Verdict driven by test *names* instead of implementation → false "FIXED" | Each verdict in §6 requires (a) the code path that implements the behaviour and (b) a **negative** test that fails when the behaviour is removed (`tests/new-feature-foreman.test.js:136-147`; the prd-parser and trd-parser suites pin null/absent-priority paths) |
| R2 | High | Defect 3 reported "FIXED" because the `new-feature` chain does detect env, hiding the `ensemble:feature` front-door gap | Gap is exact and locatable: `skills/ensemble-feature/SKILL.md:37` — `FOREMAN = true` only when the token right after the keyword is literally `--foreman`; the string `FOREMAN_TASK_TITLE` does not occur anywhere in that file. `checkFrontDoor` (`tests/helpers/foreman-invariants.js:157`) asserts no env rule, so no test can fail on this gap → §6 reports **PARTIALLY FIXED**, not FIXED |
| R3 | Med | Verdict computed against a `dev` that is not the operator's `dev` (stale local ref) | `dev == origin/dev == HEAD == a0d6a213173446765b35374221afe84bf441cc75` at phase start; re-verify the SHA at verdict time and quote it |
| R4 | Med | Reading a truncated/corrupted working-tree copy of a report artifact (recurring in this repo — prior runs carried a 22-byte `FIX_REPORT.md` and a 48-byte tool-error wrapper) | Judge only tracked blobs via `git show <sha>:<path>`, or `git checkout -- <path>` before reading a tracked report |
| R5 | Med | Commit `bb052ad7` has a corrupted subject (`[pi] <synthetic_tool_result name="edit">Error: Could no...`) → could be misread as a broken half-applied change | Judged by the diff, not the subject: `packages/development/lib/trd-parser.js` (+23) and `tests/trd-frontmatter-key-spelling.test.js` (+54); `git merge-base --is-ancestor bb052ad7 dev` → true |
| R6 | Med | A runtime probe of the Foreman env path would write run state into the worktree (`.ensemble/new-feature/*.json` — 5 files already present) and breach the read-only constraint | Structural evidence only (skill text + invariant helper + suites). Do **not** invoke `ensemble:new-feature` inside this worktree |
| R7 | Low | The `pi` provider fails and the run truncates silently (task explicitly warns about this) | Probed: §4.5 — provider resolved and answered, exit 0. No provider blocker in this environment |
| R8 | Low | Operator/task progress notes silently undelivered | `foreman_inbox_send` delivered; `foreman_task_add_comment` failed (`INVALID_STATE: Task external_id is malformed`) → recorded in §0 |
| R9 | Low | Full-suite noise (timing-sensitive suites such as `toolchain-detect.test.js`, `performance.test.js`) misread as a regression | The three suites in §4 are pure and fast (0.196 s / 1.026 s / 0.561 s). Repo-wide suites are out of scope for a read-only verification |
| R10 | Low | Scope creep: the task says "if all three are fixed, say so plainly and open no PR" — but defect 3 is **not** fully fixed, so a follow-up PR is implied | Decision belongs to the operator; this phase and the verification phase open no PR either way |

---

## 4. Test plan

All commands run from the workspace root unless a `cwd` is given. Real, observed output is quoted; nothing is inferred.

### 4.1 Defect 1 — inline MoSCoW priorities

```bash
cd packages/development && npx jest tests/prd-parser.test.js
```

```
✓ reads MoSCoW priority written inline as "(Must)" at the end of the heading
✓ reads "(Should)" bracketed and "[Could]" inline tags
✓ reads inline tag when a "[RISK: ...]" suffix follows it
✓ normalizes unapostrophised inline tag "(Wont)" to "Won't"
✓ a heading with neither inline tag nor Priority line still resolves null
✓ the inline-tag PRD in docs/PRD resolves every REQ gatable priority

Test Suites: 1 passed, 1 total
Tests:       26 passed, 26 total
Time:        0.196 s
Ran all test suites matching /tests\/prd-parser.test.js/i.
```

Exit code `0`.

### 4.2 Defect 2 — TRD `prd_reference` / `prd_path`

```bash
cd packages/development && npx jest tests/trd-frontmatter-key-spelling.test.js
```

```
  parseTRD - prd_reference id plus prd_path
    ✓ falls back to prd_path when prd_reference is a document id
    ✓ a path-shaped prd_reference still wins over prd_path
    ✓ prd_path is ignored when a body reference exists
    ✓ stays null for an id-only reference with no path anywhere
    ✓ a body docs/PRD path takes precedence over prd_path
  trd-cli list and status accept Title-Case frontmatter keys
    ✓ runList reports id, version, prd_reference and status
    ✓ runStatus reports version, prd_reference and status

Test Suites: 1 passed, 1 total
Tests:       14 passed, 14 total
Time:        1.026 s
```

Exit code `0`.

### 4.3 Defect 3 — Foreman env detection

```bash
cd packages/development && npx jest tests/new-feature-foreman.test.js tests/feature-foreman-passthrough.test.js
```

```
PASS tests/feature-foreman-passthrough.test.js
PASS tests/new-feature-foreman.test.js

Test Suites: 2 passed, 2 total
Tests:       51 passed, 51 total
Time:        0.561 s
```

Exit code `0`.

The task also suggested `npx jest tests/helpers`. Real behaviour, for the record:

```bash
cd packages/development && npx jest tests/helpers
```

```
No tests found, exiting with code 1
Run with `--passWithNoTests` to exit with code 0
  501 files checked.
  testMatch: **/__tests__/**/*.[jt]s?(x), **/?(*.)+(spec|test).[tj]s?(x) - 314 matches
Pattern: tests/helpers - 0 matches
```

Exit code `1` — **expected**: `tests/helpers/` holds helper modules, not test files. The guards that matter are the two consuming suites in §4.3. This non-zero exit is a property of the command, not a failure of the code under test.

### 4.4 Generated-artifact drift (source ↔ `packages/pi` / `packages/git` mirrors)

```bash
npm run generate:validate
```

```
✓ Validation passed (64 files)
✓ packages/development/lib/run-index/ matches a fresh build of the agent-core run-index stores
```

Exit code `0` — the skill text that implements defect 3 is consistent with its generated mirrors.

### 4.5 `pi` provider readiness probe (the task's "report the reason instead of going silent" clause)

```bash
pi --provider litellm-stack --model MiniMax-M3 -p "reply with exactly: OK"
```

```
OK
```

Exit code `0`. The configured provider (`litellm-stack`, model `MiniMax-M3`) resolves and answers in this environment, so **no** run was blocked by a provider failure and no part of this verification was skipped for that reason.

### 4.6 Acceptance gate for the verification phase

| Gate | Required | Observed |
| --- | --- | --- |
| `tests/prd-parser.test.js` | all green | 26/26, exit 0 |
| `tests/trd-frontmatter-key-spelling.test.js` | all green | 14/14, exit 0 |
| `tests/new-feature-foreman.test.js` + `tests/feature-foreman-passthrough.test.js` | all green | 51/51, exit 0 |
| `npm run generate:validate` | exit 0, no drift | exit 0, 64 files validated |
| Verdict per defect | cites `file:line` of the fixing code **and** a command whose real output is quoted | §6 |
| Repo cleanliness | `git diff --stat dev HEAD` empty | empty (0 changed files) |

---

## 5. Rollback

| Aspect | State |
| --- | --- |
| Source changes | none — nothing to revert |
| Commits on the branch | none (branch `foreman/coord-8dc4112fd55e0718/run-c138a191dbdeb5c3096147b5f64e59b1` has 0 commits; `git diff --stat dev HEAD` is empty) |
| PR | none opened, none to close |
| Artifacts created by this phase | `docs/reports/foreman-coord-8dc4112fd55e0718/ASSESS_REPORT.md` (new file); scratch notes in `~/.omp/coord-8dc4112fd55e0718/` (outside the repo) |
| Discard procedure | `rm docs/reports/foreman-coord-8dc4112fd55e0718/ASSESS_REPORT.md && rmdir docs/reports/foreman-coord-8dc4112fd55e0718` — the directory did not exist before this phase, so removal is clean and loses nothing |
| Pre-existing state left untouched | `.ensemble/local-ci.yaml`, `.ensemble/new-feature/*.json` (5 files) — read only, unmodified |
| Migrations / persisted data | none; nothing outside the worktree was written |

**If the operator later asks for the defect-3 front-door gap to be fixed**, the reversible shape is: one additive edit to `packages/development/skills/ensemble-feature/SKILL.md`, a matching guard in `tests/helpers/foreman-invariants.js` (`checkFrontDoor`), then `npm run generate` + `npm run generate:pi` from the repository root (the Pi version bump must ride the same commit), gated by `npm run generate:validate`, `npm run validate`, and `npx jest tests/feature-foreman-passthrough.test.js tests/new-feature-foreman.test.js`. Reverting that single commit fully restores the current state — no data migration, no persisted state.

---

## 6. Preliminary verdicts (evidence-backed; to be restated in the verification artifact)

### Defect 1 — inline MoSCoW priorities → **FIXED**

- **Fixing code:** `packages/development/lib/prd-parser.js:105-137` — `extractReqPriorities` matches the H3/H4 `REQ-NNN:` heading, then reads the inline tag with `REQ_PRIORITY_INLINE_RE` (`:78`) and normalizes it via `normalizeMoscowTag` (`:89-95`); the `**Priority:** Must` line form still works via `REQ_PRIORITY_LINE_RE` (`:73`); no tag → `null`.
- **Introducing commit:** `4c9e2e78` ("Foreman run run-ec9d1ce7a3934aa9faf7c7ef68094a66 phase 2") — `git merge-base --is-ancestor 4c9e2e78 dev` → true; later touched by `a0d6a213`.
- **Covering test:** `packages/development/tests/prd-parser.test.js:204` ("reads a MoSCoW priority written inline as `"(Must)"` at the end of the heading"), plus `:209`, `:215`, `:220`, `:225`, `:239`, `:244`, `:260` and the end-to-end case `:275` ("the inline-tag PRD in docs/PRD resolves every REQ gatable priority", reading `docs/PRD/PRD-2026-82b6a138-*`).
- **Command + output:** §4.1 — 26/26 passed, exit 0.
- **Downstream effect:** the Must/Should coverage gate in `skills/completion-verification/SKILL.md:160-179` now receives non-null priorities, and the documented inline format at `:330-336` matches the implementation.

### Defect 2 — TRD `prd_reference` / `prd_path` → **FIXED** (with a precision caveat)

- **Fixing code:** `packages/development/lib/trd-parser.js:206` (`PRD_REFERENCE_KEYS = ['prd_reference', 'prd', 'source_prd']`), `:212` (`PRD_PATH_KEYS = ['prd_path']`), `:402-437` (`extractPrdReference`) — resolution order: body `docs/PRD/*.md` path → body `Based on PRD:` → body `PRD:` → frontmatter `prd_reference` **if path-shaped** (`looksLikePath`, `:382`) → frontmatter `prd_path` if path-shaped → `null`.
- **Introducing commits:** `712bd4bb` (#124, `PRD_REFERENCE_KEYS`) and `bb052ad7` (`PRD_PATH_KEYS` + 54 lines of test) — both ancestors of `dev`.
- **Covering test:** `packages/development/tests/trd-frontmatter-key-spelling.test.js:93-137` (describe "parseTRD - prd_reference id plus prd_path") and `:140-175` (`trd-cli` list/status with Title-Case keys).
- **Command + output:** §4.2 — 14/14 passed, exit 0.
- **Caveat that must survive into the verdict wording:** "parsed `prdReference` must not be null" holds **only when a path exists somewhere**. A `prd_reference` holding a bare document id *and* no `prd_path` still yields `null`, and that is the pinned behaviour (test "stays null for an id-only reference with no path anywhere"). Report this as "`prd_path` is honoured" — never as "`prdReference` is never null".

### Defect 3 — Foreman env detection → **PARTIALLY FIXED**

**Fixed part** (commit `5b6c0028`, "fix(development): detect Foreman dispatch from FOREMAN_TASK_TITLE in approval-gated skills (#458)", 2026-11-20, ancestor of `dev`):

- `packages/development/skills/ensemble-new-feature/SKILL.md:30` and `skills/ensemble-new-feature/references/phase-1-entry-point-resolution.md:12` state: `FOREMAN = true` when `--foreman` is present **or** env `FOREMAN_TASK_TITLE` is non-empty, with `FOREMAN_SOURCE = flag|env` (flag wins); CI / `ENSEMBLE_NON_INTERACTIVE` never imply it. `references/phase-3-execute-stage.md:40,51` carry the env-entered grant details.
- Same amendment applied to `ensemble-create-trd:11`, `ensemble-refine-trd:16`, `ensemble-fix-issue:16`, `ensemble-implement-trd-tasks:37`, `ensemble-analyze-complexity:29`, `ensemble-pr-merge`.
- Guard: `packages/development/tests/helpers/foreman-invariants.js:132-143` — the `envEntry` group requires the entry step to mention non-empty `FOREMAN_TASK_TITLE`, `FOREMAN_SOURCE` with `flag`/`env`, CI/`ENSEMBLE_NON_INTERACTIVE` never implying it, and both the implementation and PR grants to record the env-entered detail. Negative tests at `tests/new-feature-foreman.test.js:136-147` prove the guard bites; the group is registered at `:41`.
- Command + output: §4.3 — 51/51 passed, exit 0.

**Open gap (why this is not a clean FIXED):**

- `packages/development/skills/ensemble-feature/SKILL.md:37` (Foreman flag extraction, REQ-008) sets `FOREMAN = true` **only** when the token immediately after the keyword is exactly `--foreman`; otherwise `FOREMAN = false`. The string `FOREMAN_TASK_TITLE` does not occur anywhere in that file (grep over `skills/` returns no `ensemble-feature` hit). The front door is therefore env-blind.
- `tests/helpers/foreman-invariants.js:157-176` (`checkFrontDoor`) asserts only extraction order, insertion position and ordinary-text handling — **no env rule** — so nothing in the suite can fail on this gap either way.
- `packages/development/commands/feature.yaml` (13 lines) and `commands/new-feature.yaml` (15 lines) are manifests with a `skill:` pointer and no prompt text; they cannot detect `FOREMAN_TASK_TITLE` by construction. Answer to the task's question: **no** — detection lives in the SKILL.md, not the manifest.
- Behavioural consequence (analysis, not an observed failure): a Foreman dispatch that invokes `/ensemble:feature` without a literal `--foreman` token leaves the front door at `FOREMAN = false` and forwards no flag. The downstream `ensemble-new-feature` still enters Foreman mode from the env var, so the new-feature path stays non-interactive end-to-end; but the front door itself carries no `FOREMAN_SOURCE` and no test guards that entry path. No runtime probe was executed (see R6 — it would write `.ensemble/new-feature/` state and breach read-only).

---

## 7. Open items for the next phase

1. Restate the three verdicts in the verification artifact with the same `file:line` + command-output evidence (the task's required output format). Defect 3 must be stated as **PARTIALLY FIXED**, with the `ensemble:feature` front-door gap named explicitly.
2. Do **not** open a PR. The task says to open one only if all three are fixed; they are not, and the operator owns the decision on a follow-up.
3. If the operator wants the front-door gap closed, follow the rollback plan in §5 (single additive skill edit + `checkFrontDoor` guard + `npm run generate` / `npm run generate:pi` + validation gates).
4. Re-confirm `dev == origin/dev == <sha>` immediately before publishing the verdict, and quote the SHA in the artifact.
