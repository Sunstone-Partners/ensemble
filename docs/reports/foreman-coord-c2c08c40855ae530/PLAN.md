# PLAN — Foreman env detection in feature / new-feature (coord-c2c08c40855ae530)

## 1. Verdict

**ALREADY FIXED on `dev`. No code change. The implementer must stop and open no PR.**

The task prompt describes a cancelled thread whose work was to make `FOREMAN` true when
`--foreman` is present OR `FOREMAN_TASK_TITLE` is non-empty. That work was completed by a
*different*, later thread and merged into `dev` as **PR #458**, commit
`5b6c0028 fix(development): detect Foreman dispatch from FOREMAN_TASK_TITLE in approval-gated skills`.

Evidence (worktree is clean at `a0d6a213`, identical to `origin/dev`):

- `git merge-base --is-ancestor 5b6c0028 origin/dev` → ancestor (merged).
- `gh pr list --state all --search "foreman FOREMAN_TASK_TITLE"` → PR #458 `MERGED` 2026-11-20.
- Source prose carries the rule. `packages/development/skills/ensemble-new-feature/references/phase-1-entry-point-resolution.md:12`:
  `- Foreman mode: FOREMAN = true when `--foreman` is present or env FOREMAN_TASK_TITLE is non-empty (FOREMAN_SOURCE = flag|env, flag wins; none when false); same grants as the flag; CI/ENSEMBLE_NON_INTERACTIVE never imply it.`
- Per-entry-path approval detail strings exist at
  `packages/development/skills/ensemble-new-feature/references/phase-3-execute-stage.md:40` (implementation grant)
  and `:51` (PR grant), both with
  `... or, when FOREMAN_SOURCE is env, "... granted by Foreman dispatch (FOREMAN_TASK_TITLE set; no human present)"`.
- `packages/development/skills/ensemble-new-feature/SKILL.md:30` — the `foreman` argument says
  "also entered by non-empty env FOREMAN_TASK_TITLE (step 1.1)".

Each listed gap from the PARTIALLY_MET review is closed on `dev`:

| Reviewer gap | State on `dev` today |
|---|---|
| (2) derived artifacts never regenerated | Regenerated. `packages/pi/skills/ensemble-new-feature/**` and `packages/codex/.codex/skills/commands/ensemble-new-feature/**` carry the same `FOREMAN_TASK_TITLE` / `FOREMAN_SOURCE` prose. Running all four generators from the repo root left **zero** tracked drift (`git status --porcelain` empty). `npm run generate:validate` exits 0. |
| (2) "Nothing infers FOREMAN from the environment." still present | String does not exist anywhere in the repo: `grep -rn "Nothing infers" .` (excluding `node_modules`) → no match. |
| (3) no tests | `envEntry` invariant group exists in `packages/development/tests/helpers/foreman-invariants.js:130-141`, with three mutation proofs in `packages/development/tests/new-feature-foreman.test.js` (`a definition that ignores FOREMAN_TASK_TITLE is caught`, and `test.each(['implementation approval','PR approval'])('the %s grant that records only the flag path is caught')`). `npx jest tests/new-feature-foreman.test.js` → 37 passed. |
| (4) new-feature prose over prompt-budget baseline | Under baseline: validate reports `ensemble-new-feature/SKILL.md: 3189 words (SKILL.md plus 3 reference files) is below baseline 3193` (advisory only). `npm run validate` exits **0**. |
| (5) empty report, no CHANGELOG entry | `docs/reports/foreman-ensemble-skills-detect-foreman-env-v3/FIX_REPORT.md` is 91 lines. `CHANGELOG.md:18` under `## [Unreleased]` → `### Fixed` carries **"A Foreman dispatch that passes no `--foreman` flag is treated as a Foreman dispatch (`packages/development`, `packages/git`)."** |

### The two YAMLs named in the prompt

`packages/development/commands/feature.yaml` (13 lines) and
`packages/development/commands/new-feature.yaml` (15 lines) are **skill-backed manifests**
(`metadata:` + `skill:`) since `63da19f1 feat(commands): make the six dispatchers skill-backed (#312)`.
They contain no prompt prose and therefore no FOREMAN rule to carry — the prompt lives in
`packages/development/skills/ensemble-{feature,new-feature}/`. Editing those YAMLs to add
FOREMAN logic would be wrong: the manifest is not the prompt.

`ensemble-feature` (the dispatcher) deliberately keeps flag-only extraction
(`packages/development/skills/ensemble-feature/SKILL.md:37,43`). It is a pure router with no
approval gate and no `AskUserQuestion` of its own; a flagless dispatch with `FOREMAN_TASK_TITLE`
set still reaches Foreman mode because `new-feature` derives `FOREMAN` from the env itself.
PR #458's report states this explicitly
(`docs/reports/foreman-ensemble-skills-detect-foreman-env-v3/FIX_REPORT.md:74`). Adding env
detection to the dispatcher would duplicate the rule and burn prompt budget for no behaviour change.

## 2. Root cause

None to fix. The bead was filed against the cancelled thread's branch state, not against `dev`.
The defect it describes ("every runtime copy still carries the old flag-only rule") is false on
`dev`: the regenerated Pi and Codex mirrors carry the env rule.

## 3. Failing check first

Not applicable — there is no fix to prove. The regression coverage the reviewer asked for already
exists and is already red-provable by construction: the harness checks are pure functions over a
parsed document, and `new-feature-foreman.test.js` runs them against deliberately mutated clones.
The implementer may *run* (not write) this to confirm:

```
cd packages/development && npx jest tests/new-feature-foreman.test.js
```

Observed: `Test Suites: 1 passed, Tests: 37 passed`, including
`✓ a definition that ignores FOREMAN_TASK_TITLE is caught`,
`✓ the implementation approval grant that records only the flag path is caught`,
`✓ the PR approval grant that records only the flag path is caught`.

Writing a *new* test asserting the same `envEntry` facts would duplicate existing coverage and is
out of scope.

## 4. Edits

**None.** Do not edit any source, generated artifact, baseline, CHANGELOG or test.

The only file this task produces is the fix report required by the workflow:

1. `docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md` — write a non-empty report that
   states the ALREADY-FIXED verdict, names commit `5b6c0028` / PR #458, reproduces the gap table
   above, and lists the verification commands and results from §5. Do not leave it empty.

Explicitly do **not**:
- touch `packages/development/commands/feature.yaml` or `new-feature.yaml` (they are manifests);
- add FOREMAN env prose to `packages/development/skills/ensemble-feature/SKILL.md`;
- edit `scripts/prompt-budget-baseline.json` (the advisory "below baseline; lower baseline"
  warnings are pre-existing on `dev` across nine prompts and are not part of this task);
- add a second CHANGELOG entry for work `CHANGELOG.md:18` already records;
- open a PR.

## 5. Verification

Run from the repository root. All of these were run on this worktree at `a0d6a213`
(clean tree, identical to `origin/dev`) and are the evidence for the verdict:

| Command | Result |
|---|---|
| `npm run generate:validate` | exit 0 — `✓ Validation passed (64 files)`, run-index lib matches |
| `npm run validate` | exit **0** — `186 prompt file(s) within word budgets`; only advisory `below baseline` warnings, all pre-existing |
| `npm run generate && npm run generate:pi && npm run generate:codex && npm run generate:opencode` | all exit 0; `git status --porcelain` empty afterwards → **no generated drift**, so validate.yml / pi-generate.yml / codex-generate.yml / generated-drift.yml pass |
| `cd packages/development && npx jest tests/new-feature-foreman.test.js` | 1 suite, 37 tests passed |
| `cd packages/development && npx jest tests/feature-foreman-passthrough.test.js tests/new-feature-command.test.js` | 2 suites, 57 tests passed |

Success means: all of the above reproduce, and `git status --porcelain` shows only the new
`docs/reports/foreman-coord-c2c08c40855ae530/FIX_REPORT.md` (plus `PLAN.md`).

If the implementer wants the package-wide run for completeness: `cd packages/development && npx jest`.
Note `tests/toolchain-detect.test.js` and `tests/performance.test.js` assert wall-clock timing and
flake under load — re-run them alone before calling them failures, and say so.

## 6. Out of scope

- Any change to `packages/development/commands/*.yaml`, `packages/development/skills/**`,
  `packages/git/skills/**`, or any generated mirror.
- `scripts/prompt-budget-baseline.json` and the nine pre-existing "below baseline" advisories.
- The `ensemble-feature` dispatcher's flag-only extraction (intentional; see §1).
- The pre-existing `packages/development/tests/trd-cli.test.js` "TRD-037 AC-2" failure and the
  `scripts/tests/toolchain-*.test.js` failures recorded in PR #458's report — unrelated, on `dev`.
- Opening, pushing or merging anything. This task ends with the report file and a written finding.
