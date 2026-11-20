# Repo-Rules Review — ensemble-pdf-f7-f11-bundle-path-hygiene-r3

## Review engine

Repository-rules reviewer: this phase (in-run `subagent-chat` agent, model `openai-codex/gpt-5.5` via the Foreman `repo-rules-review` phase), reviewing against this repository's own conventions file `AGENTS.md` (repo root) plus `CLAUDE.md`/`CONTRIBUTING.md` and the established patterns in the touched files. No external review CLI is used in this phase.

Diff range reviewed, exactly: `git diff "$FOREMAN_BASE_BRANCH"...HEAD` with `FOREMAN_BASE_BRANCH=dev`, i.e. `git diff dev...HEAD` at `HEAD = 90a9985f` ("Foreman run run-2eb3612b8628e9ea51a8567fc984fcb8 phase 2").

**What that range contains:** 2 files, 23 insertions, 0 deletions — `docs/reports/foreman-ensemble-pdf-f7-f11-bundle-path-hygiene-r3/FIX_REPORT.md` (2 bytes, empty) and `docs/reports/foreman-ensemble-pdf-f7-f11-bundle-path-hygiene-r3/REVIEW_CODERABBIT_REPORT.md`. **There is no source, skill, agent, command, script or test change in this run.**

**Review verdict on the diff itself:** the only rule violation the diff itself contains is that the run has no implementation to review (recorded as CR-1 below and in the findings block). No code-level rule violation exists in the diff, because the diff touches no code. A conventional "clean" here would be a false clean and is explicitly not what this section reports.

**Previous-phase artifact was read, but not as committed.** `REVIEW_CODERABBIT_REPORT.md` at `HEAD` is 3194 bytes and carries **no** `FOREMAN_REVIEW_FINDINGS_START` / `FOREMAN_REVIEW_FINDINGS_END` markers, so the carry-forward instruction could not be satisfied from the committed file. Its own text states the deliverable was 13197 bytes with md5 `80c4e7ee2faf709d253264e17911da0f`; that byte-size/md5 artifact survives only at `~/.omp/ensemble-pdf-f7-r3/REVIEW_CODERABBIT_REPORT.md` (verified md5 match). Every finding bullet was carried forward from that surviving copy, not from the committed copy. That size/md5 divergence is itself reported as CR-7.

**Independence caveat (material):** the implementation phase for this task did not produce work, so the only way to deliver fixes inside this phase would be for the reviewer to write them — which would leave ~6 files with no independent review pass. I did not do that. See CR-1 and the `## Declined` section.

## Findings

Findings received: 7 carried forward from the previous phase (CR-1…CR-7, numbered here for reference) + 2 new findings from this phase's own verification (NR-1, NR-2).

| ID | Severity | Status |
|---|---|---|
| CR-1 | Critical | Open (escalated — not fixable by a review phase) |
| CR-2 (F7a) | Critical | Verified reproducible on `HEAD`; open |
| CR-3 (F7b) | Critical | Verified reproducible on `HEAD`; open; prescribed fix is unsafe as written (see NR-2) |
| CR-4 (F11) | Major | Verified reproducible on `HEAD`; open |
| CR-5 | Major | Verified reproducible on `HEAD`; open |
| CR-6 | Major | Verified reproducible on `HEAD`; open |
| CR-7 | Minor (raised to Major by this phase) | Open; also blocks the carry-forward contract |
| NR-1 | Minor | Closed — root cause reproduced and fixed in the environment, not in the repo |
| NR-2 | Major | Open — design decision, needs owner input |

## Fixed

**None.** Zero files in this run were modified. `git status` is clean at the point of writing this section.

Rationale for the one item that looks like a "fix I could have made": CR-2/CR-3/CR-4 are mechanically small (add symlinks), but CR-3's prescribed remedy is wrong (NR-2), and the task's own acceptance contract requires a failing-first red run of a new install smoke test recorded in `FIX_REPORT.md`. A review phase that writes the fix destroys the pipeline property the previous phase deliberately preserved ("a review phase that writes the fix has nothing independently reviewing it"). So the correct action here is escalation, not a partial fix.

One non-repository action taken, listed for full transparency (it changes nothing in the repo, and is reversible):

- **Environment, not code:** `/Users/ldangelo/.config/ensemble/toolchain.yaml` (20 bytes, `workflow: plain-git`) moved aside to `~/.omp/ensemble-pdf-f7-r3/toolchain.yaml.moved-aside` to test the CR-6 hypothesis. Restore with `mv ~/.omp/ensemble-pdf-f7-r3/toolchain.yaml.moved-aside /Users/ldangelo/.config/ensemble/toolchain.yaml`.

## Declined

- **`docs/reports/foreman-ensemble-pdf-f7-f11-bundle-path-hygiene-r3/FIX_REPORT.md:1` (CR-1)** — finding: implementation phase committed only a 2-byte empty report, zero code, none of the task's deliverables exist on the branch; not merge as a fix. **Not declined as wrong — accepted and escalated.** Reason it is not fixed here: authoring the whole task in a review phase forfeits independent review of that work, which is the exact reason phase 2 recorded for declining to implement. `AGENTS.md` ("Surgical changes: every changed line must trace to the task") and the task's own HOW TO WORK rules do not license a phase-3 reviewer to substitute for phase 1.
- **`packages/full/lib/prd-cli.js:1` (CR-3, as prescribed by the task)** — finding: repoint the symlink at `packages/product/lib/prd-cli.js`. **Declined as written** (verified reason below), with the underlying defect remaining open. The task conditions this on proving the product copy is a superset for every subcommand a shipped skill calls. It is not a superset — it is **disjoint**: `packages/development/lib/prd-cli.js:346-350` `HANDLERS = { list, status, 'migrate-frontmatter' }` versus `packages/product/lib/prd-cli.js:182-199` `parse | generate-features | check-drift`. Zero shared subcommands. A shipped caller needs the development copy: `packages/development/skills/ensemble-create-trd/references/phase-1-prd-ingestion-and-validation.md:8` runs `node "$PRD_CLI" list --type prd` and parses `{ok,type,items}`, and `packages/development/skills/tool-path-resolution/SKILL.md:70` maps `PRD_CLI` → `packages/development/lib/prd-cli.js`. A naive relink therefore converts one runtime failure into three while fixing one. Smallest safe fix is a real merge/aggregation, which is a design decision — captured as NR-2 rather than improvised here.
- **`/Users/ldangelo/.config/ensemble/toolchain.yaml` (CR-6)** — finding: operator config makes 4 toolchain tests resolve `source:'user'` and fail. **Declined as a repository defect** — confirmed not a defect and now root-caused, see NR-1.
- **`packages/full/skills/.../detect-stack` glob/dependency issue (finding 2)** — not re-raised here: the task explicitly assigns it to a separate task. Not carried forward to avoid duplicating another run's scope.

## Verification

Commands run in this phase, from the repository root of the run worktree unless noted, with real exit codes (no piping through `tail` for gate commands).

| Command | Exit | Result |
|---|---|---|
| `git diff dev...HEAD --stat` | 0 | 2 files, 23 insertions — no code |
| `git status --short` | 0 | clean |
| `ls packages/full/lib \| wc -l` | 0 | 109 entries |
| `ls packages/full/lib \| grep -Ei 'reqnroll'` | 1 | no match → CR-2 reproduced |
| `ls packages/full/lib \| grep -Ei 'delegation\|test-runner\|grounded'` | 1 | no match → CR-4 reproduced |
| `readlink packages/full/lib/prd-cli.js` | 0 | `../../development/lib/prd-cli.js` → CR-3 reproduced |
| `grep -n 'HANDLERS' packages/development/lib/prd-cli.js` | 0 | `list`, `status`, `migrate-frontmatter` (lines 346-350) |
| `sed -n '160,230p' packages/product/lib/prd-cli.js` | 0 | `parse`, `generate-features`, `check-drift` (lines 182-199) → CR-3/NR-2: disjoint, not superset |
| bundle-wide `${CLAUDE_PLUGIN_ROOT}/lib/*.js` reference sweep over `packages/full/{skills,agents,commands}` (symlink-following) | 0 | 5 referenced lib files; exactly 1 missing from the bundle: `reqnroll-cli.js` |
| `npx jest scripts/tests/toolchain-config.test.js scripts/tests/toolchain-detect.test.js` (with operator `toolchain.yaml` moved aside) | 0 | 2 suites / 60 tests passed — CR-6 root cause proven |
| `npm run generate:validate` | not run | nothing generated in this phase; no source edited |
| `npm run validate` | not run | no source edited; the previous phase already recorded it at exit 0 on this same tree |
| `npx jest scripts/tests` (full package suite) | not re-run | previous phase recorded 2 suites / 4 tests failing from the operator config; this phase proved that cause (row above) |

Not claimed: any `npm run generate*` run, any full-suite run, or any test I did not execute.

### Notes on verification gaps

- The full `npx jest scripts/tests` baseline was not re-executed under the cleaned environment; only the two named suites. The remaining 90 suites are assumed unaffected, since the recorded failures were all traced to the one config file.
- The `${CLAUDE_PLUGIN_ROOT}` sweep covers the `lib/` namespace only, and only `.js` file names. It does not cover `packages/<pkg>/lib/<x>.js`-style repo paths written in prose, nor non-`.js` assets. That is precisely the coverage the task asks the new install smoke test to add (CR-5), which does not exist yet.

## Follow-ups (for whoever re-runs phase 1)

- Do **not** implement CR-3 by a bare relink (see Declined). Options, cheapest first: (a) make `packages/product/lib/prd-cli.js` a true superset by adding the `list|status|migrate-frontmatter` handlers, then repoint `full/lib/prd-cli.js`; (b) keep two distinct bundle names (`lib/prd-cli.js` = development, `lib/prd-generate-cli.js` = product) and update the resolvers in the two `product` skills — which then requires `npm run generate` + `npm run generate:pi` for the codex/pi mirrors; (c) add a small aggregator shim in `full/lib` that dispatches to both. (a) is the smallest change that satisfies the task's own precondition.
- `reqnroll-cli.js` is not standalone: `packages/product/lib/reqnroll-cli.js:26` does `require('./prd-cli')` for `parseArgs`/`deriveSlug`. Whatever option is chosen above, the bundle must therefore also carry the product `prd-cli` under a resolvable name, or the new `reqnroll-cli.js` mirror will fail at require time inside the dereferenced install.
- The validator gap (`scripts/validate-all.js:65` one-directional mirror rule; `:551` requires-resolve rule) means nothing currently fails when a shipped skill names an unbundled lib file. Fix the validator in the same change as the links, or the next regression arrives the same silent way.

## Assumptions

- `FOREMAN_BASE_BRANCH=dev` is trusted as the correct base (it is set, so the stop condition did not trigger).
- The previous phase's statement that `packages/product/lib/reqnroll-cli.js` is the owning copy is taken as correct and re-verified by direct `ls`/`readlink`/`grep`, not assumed from the report alone.
- "Review this run's work" is read as "review the run's diff vs `dev`", not "review the task the run failed to do". Both readings are reported: the diff is empty of code (finding), and the intended work is described by the carried-forward findings.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
- `docs/reports/foreman-ensemble-pdf-f7-f11-bundle-path-hygiene-r3/FIX_REPORT.md:1` Critical — the implementation phase committed only a 2-byte empty report and zero code, so none of this task's deliverables (bundle links, validator rule, install smoke test, CHANGELOG entry) exist on the branch and it must not merge as a fix.
- `packages/full/skills/ensemble-check-binding-drift/SKILL.md:39` Critical — the bundle has no `lib/reqnroll-cli.js` (nor `reqnroll-gen.js`/`reqnroll-run.js`), so this line and `ensemble-generate-reqnroll-bindings/SKILL.md:42` and `ensemble-reqnroll-tdd/SKILL.md:37` resolve a `${CLAUDE_PLUGIN_ROOT}/lib/reqnroll-cli.js` path that does not exist in an installed plugin; the files live only in `packages/product/lib/`.
- `packages/full/lib/prd-cli.js:1` Critical — it symlinks the development CLI (`list|status|migrate-frontmatter`, `packages/development/lib/prd-cli.js:347-351`) while `ensemble-generate-feature-tests/SKILL.md:42` calls `generate-features`, which exists only in `packages/product/lib/prd-cli.js:185-199`; the two CLIs are disjoint, so the prescribed relink would break `list`, `status` and `migrate-frontmatter` and needs a design decision first.
- `packages/full/agents/e2e-testing/playwright-tester.yaml:57` Major — the shipped agent directs the model to `packages/e2e-testing/lib/delegation-contract.js` (lines 57, 121), `test-runner-mode.js` (70) and `grounded-marker-checker.js` (93), none of which are mirrored into `packages/full/lib/`, so the contract is unresolvable in the installed bundle.
- `scripts/validate-all.js:65` Major — `validateFullLibMirror` is one-directional (`development/lib` -> `full/lib`) and `validateFullBundleRequires` (line 551+) checks only bare `require()` in bundled code, so `npm run validate` exits 0 while skills and agents name bundle files that do not exist, and no install smoke test exists under `scripts/tests/` to catch it.
- `packages/development/lib/toolchain/config.js:154` Minor — a real `~/.config/ensemble/toolchain.yaml` (`workflow: plain-git`) makes four toolchain assertions in `scripts/tests/toolchain-config.test.js:229` and `scripts/tests/toolchain-detect.test.js` resolve `source:'user'` and fail; pre-existing, operator-environment specific, explicitly out of this task's scope.
- `docs/reports/foreman-ensemble-pdf-f7-f11-bundle-path-hygiene-r3/REVIEW_CODERABBIT_REPORT.md:1` Major — committed phase-2 artifact is 3194 bytes with no FOREMAN_REVIEW_FINDINGS markers while its own text claims 13197 bytes / md5 80c4e7ee2faf709d253264e17911da0f, so the carry-forward contract silently lost findings until recovered from the ~/.omp scratch copy.
- `packages/full/lib/prd-cli.js:1` Major — the task's prescribed relink to packages/product/lib/prd-cli.js would break the list/status/migrate-frontmatter callers at packages/development/skills/ensemble-create-trd/references/phase-1-prd-ingestion-and-validation.md:8 because the two prd-cli implementations are disjoint (development/lib/prd-cli.js:346-350 vs product/lib/prd-cli.js:182-199), so a merge/aggregation decision is needed first.
<!-- FOREMAN_REVIEW_FINDINGS_END -->
