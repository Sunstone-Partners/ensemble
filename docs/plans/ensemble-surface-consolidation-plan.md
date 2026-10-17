# Ensemble Surface Consolidation Plan

Status: Draft for review. Extends PRD-2026-87e64cc6 (command-surface-consolidation, v1.0.1), which already shipped the `feature`/`issue`/`prd`/`trd` dispatchers and the `new-feature` de-advertisement pointer.

## 1. What the surface actually is

Edit sources only. Everything else is generated (see AGENTS.md Generated Artifact Policy).

| Layer | Source of truth | Generated / mirrored (do not edit) |
|---|---|---|
| Commands (48) | `packages/*/commands/*.yaml` | `commands/ensemble/*.md`, `pi/prompts/*.md` (48), `codex/.codex/skills/commands/*` (48) |
| Skills (77) | `packages/<pkg>/skills/<name>/SKILL.md` and `packages/<framework>/skills/SKILL.md` | `pi/skills/**` (125 = 77 + 48 command wrappers), `codex/.codex/skills/**` |
| Agents (37) | `packages/*/agents/*.yaml` (+ `development/agents/mobile-developer.md`, hand-authored) | `agents/*.md`, `pi/agents/*` |
| `packages/full/skills/*` | **Hand-maintained symlinks** (not generated); `scripts/validate-all.js` only reports drift | n/a |

Two hand-maintained files are easy to miss: `packages/router/lib/router-rules.json` (46 skill keys; its declared generator does not exist) and `packages/development/agents/mobile-developer.md` (24 skill names in frontmatter).

## 2. Why the surface feels inconsistent

1. Every `commands/*.yaml` is exposed; the generator (`packages/pi/src/generator.ts` ~L444-468) has no filter. Leaf commands and their dispatcher are both visible.
2. Skill naming has ~10 styles (`using-X`, `managing-X`, `developing-with-X`, bare `X`, `X-framework`, ...). 22 of 77 skills have no frontmatter.
3. Detectors emit bare tokens (`react`, `jest`, `aws`) while skills use different names, so `generate-codex` needs an 11-row rewrite table and several agents reference skills that do not exist (`react-framework`, `gcp-cloud`, `azure-cloud`, `react-native`, ...).
4. The same content is maintained twice in places (React, assess leaves).

## 3. Command visibility: hide leaves (decided; amends PRD-2026-87e64cc6 REQ-009)

- **REQ-004 conflict (decided).** AC-004-1 requires a PRD/TRD specialist command invoked **directly** to behave unchanged. Hiding on Claude Code (`user-invocable: false`) stops `/name` from running when typed, so it would violate AC-004-1. **Decision: do not hide REQ-004 specialists; merge instead.** REQ-004 is not amended.
- REQ-009 (de-advertise, not hide; AC-009-2 accepts "undocumented-but-reachable") is superseded: leaves not protected by REQ-004 are hidden.
- **Rule.** (a) Base specialists stay typable and unchanged: `create-prd`, `refine-prd`, `create-trd`, `refine-trd`, `analyze-requirements`, `validate-requirements`, `verify-requirements`, `requirement-status`, `analyze-complexity` (subject to the C-B overlap check). (b) Variants fold into flags on the base command and the variant is removed, not hidden: `-meeting` -> `--from-meeting`, `create-trd-foreman` -> `--foreman`, `create-workstream-trd` -> `--workstream` (already on `implement-trd-beads`). Each removal still needs a TRD-level equivalence check and a `CHANGELOG.md` replacement entry. (c) Hide only leaves REQ-004 does not protect: the beads execution set (`beads-plan`, `implement-bead`, `beads-build-wave`, and `beads-build` once merged).
- Consequence of hiding anything: the hidden name can no longer be typed on Claude Code, so scripts and muscle memory break. Each hidden leaf needs its replacement (dispatcher keyword or flag) listed in `CHANGELOG.md`.

**Hide mechanism (new, per host).** A `metadata.visibility: hidden` field in the command YAML, honored by each generator:

| Host | How a hidden leaf is hidden | Status |
|---|---|---|
| Claude Code | Two documented options; pick one in H0. **(A) Manifest:** each plugin's `plugin.json` `commands` accepts an explicit list of files (or an object map) and **replaces** the default `commands/` scan, so listing only visible commands leaves hidden ones unregistered (not typable); dispatchers still read the hidden leaf's file by path. **(B) Frontmatter:** `user-invocable: false` in the generated command `.md` (`scripts/lib/command-transformer.js` L32-76 builds frontmatter) hides it from the `/` menu and `/name` no longer runs; docs say legacy command files support the same frontmatter. | **(A)** is documented for plugins directly; open: how names like `ensemble:trd` (set by frontmatter `name`, files under `commands/ensemble/`) are derived once files are listed individually, and the generator would have to emit the list. **(B)** is documented for `.claude/commands/` files; docs do not state it for plugin `commands/`, so confirm on a real plugin install. Do not generalize either finding to Pi or Codex. |
| Pi/OMP | Generator omits the leaf from registered prompts / command skills while still emitting the file where `buildCommandPathMap` can resolve it (e.g. a non-registered subdir). | **Partly evidenced, unverified for packages.** OMP's config docs list prompt discovery as `prompts/*.md` (non-recursive), which suggests a subdirectory is not registered. Still to confirm with a real Pi package install: that `pi.prompts: ["./prompts"]` behaves the same, that command-wrapper skills in `skills/ensemble-*` need their own exclusion, and that the native dispatcher registration in `packages/pi-extension` is unaffected. |
| Codex | Generator skips the `ensemble-<name>` wrapper in `.codex/skills/commands/` for hidden leaves, or marks it non-implicit. | **Unverified. Codex is maintenance-only (decided):** no dedicated spike; do whatever is simplest in the generator and keep it generating without errors. |

**H0 status (2026-10-17): Claude spike not run.** The `claude` CLI hung (no output within 15 s, then 300 s) in the agent's environment, so neither Claude mechanism could be observed. Manual spike (about 15 minutes, on a machine where `claude` works): build a scratch plugin with `commands/a.md` (visible) and `commands/b.md` (frontmatter `user-invocable: false`); load it with `claude --plugin-dir <dir>`; run `claude -p "hi" --output-format stream-json --verbose --max-turns 1` and read the `slash_commands` list in the init event; confirm `b` is absent and `a` present; then repeat with a `plugin.json` `commands` list that names only `a.md`, and with a nested layout (`commands/ensemble/*.md` with frontmatter `name: "ensemble:x"`) to check that the `ensemble:` names survive. Record the result here before any generator change.

Open points on Claude Code: `user-invocable: false` keeps the description in Claude's context and lets Claude invoke the skill itself; add `disable-model-invocation: true` only if nothing legitimately invokes the leaf through the Skill tool (check `beads-build-wave`, which is dispatched by an agent, before setting it). Merges still apply where behavior is equivalent; hiding is for leaves that must remain as implementation behind a dispatcher.

## 4. Skills plan (77 -> ~68)

Source: Design-Plan-Skills. Spot-verified: assess-repo inlines all specialist tasks (L65-L432); smoke-test-runner `require()`s its leaf scripts (orchestrate-smoke-tests.js L12-16); `packages/full/skills/react` does not exist; router has 46 skill keys. Other file:line citations are agent-reported; re-check when executing each phase.

**Naming rule.** Directory name == frontmatter `name:`, lowercase kebab. Technology reference skills use the bare technology name (`react`, `jest`, `aws`, `jira`); procedures use `<verb>-<object>`. Tie-break: the survivor keeps whichever name has the most inbound references.

| Phase | Cluster | Before -> After | Risk | Notes |
|---|---|---|---|---|
| S1 | Assessment | 22 -> 22 (dedupe, not delete) | medium | **Leaves are the single source; orchestrators delegate.** The inline specialist prompts in `assess-repo` / `assess-team` are the newer copy (1.0-5.0 scoring, tool guidance); the leaves are stale (`Score: A-F`). (1) Port the newer scoring/tool guidance into each leaf, keeping leaf-only depth (e.g. `assess-security` Sensitive Data Handling). (2) Replace each inline task prompt with a thin dispatch: load skill `<leaf>`, write to `docs/assessment/<prefix>-<dim>.md`, return summary; run-specific rules (no secret values, summary-only) stay in the orchestrator. (3) Single-dimension runs then work by invoking the leaf directly. Expected size: `assess-repo` ~830 -> ~400 lines (estimate). **Gate:** confirm a spawned subagent can load a skill by name in Claude Code, Pi/OMP and Codex with one dimension end to end; if not, orchestrator reads the leaf file and passes its text (still single source). Keep `assess-config`, the 3 report skills, `assessment-scoring-conflation-audit`. No skill-count reduction; hiding the leaves from discovery is a separate decision (Claude `user-invocable: false` would also block single-dimension runs by typing the leaf name, so do not hide them if that capability is wanted). |
| S2 | Smoke tests | 6 -> 1 | low | Keep `smoke-test-runner` (referenced by `release.yaml`, `release-agent`). Fold 5 leaves into sections; move scripts under the runner and rewrite the 5 `require()` paths. This is the only functional break. |
| S3 | Frameworks | 19 -> 18 | medium | Fold `developing-with-react` into `packages/react` (superset; templates/examples identical). Move `blazor/skills/dotnet-framework` to `packages/dotnet/skills/SKILL.md` as `dotnet` (that plugin's skills dir is empty). Rename `developing-with-{typescript,python,php,laravel,flutter}` and `styling-with-tailwind` to bare names. Keep framework packages (separately published plugins) and top-level layout (codex `copyFrameworkSkills` globs only `skills/SKILL.md`). Add missing `full/skills/react` symlink. Update `generate-codex/index.js` `AVAILABLE_SKILLS` / `FRAMEWORK_SKILL_REWRITES`. Flag `rspec`/`xunit` as 22-line stubs. |
| S4 | Detectors | 4 -> 1 | high | `detect-stack` in `packages/core` with `--axis=framework|test|tooling|cloud`. Three incompatible output schemas and colliding `detect-framework.js` / `framework-patterns.json` names. Claude Code's `plugin.json` supports a `dependencies` field (plugins that must be enabled), which none of this repo's manifests use yet, so infra-only installs can declare a dependency on `ensemble-core` on Claude Code; Pi has no verified equivalent. Do last or defer. |
| S5 | Vendor wrappers | 11 -> 11 | low | No true twins; rename only (`using-prisma` -> `prisma`, `managing-jira-issues` -> `jira`, ...). 13 router keys + infra agent references. |
| S6 | Assessment packaging | n/a | medium | **Decided:** `ensemble-full` keeps assessment (full includes everything); assessment is its own Pi-installable package and is NOT copied into `ensemble-pi`. Today `ensemble-assessment` is a published Claude plugin (own `plugin.json`, marketplace entry) but is Pi-incompatible as published and is bundled into both aggregates. Changes: (1) **Pi-installable:** add the `pi-package` keyword and a `pi` field (`skills: ["./skills"]`, plus `prompts` / `agents` when it has them) to `packages/assessment/package.json`, mirroring `packages/pi/package.json`; add the same dirs to `files`. (2) **Exclude from `ensemble-pi`:** add a package exclusion to `skill-copier.ts` (today it only skips `pi`) and to command/prompt generation, so installing both packages does not register every assessment skill twice. (3) **Keep in `ensemble-full`:** leave it included; recommended: replace the 22 per-skill symlinks with one whole-dir mirror `packages/full/skills/assessment -> ../../assessment/skills` (as `core`, `e2e-testing`, `infrastructure` already do) so S1 changes never need symlink upkeep; verify `validate-all.js` accepts it and that no skill appears twice. (4) **Commands:** author assessment commands in `packages/assessment/commands/*.yaml`; add `"commands": "./commands"` to its `plugin.json`; add `packages/full/commands/assessment -> ../../assessment/commands/ensemble`. The Pi generator writes prompts only to `packages/pi/prompts/`, so it needs a per-package output root (assessment prompts into `packages/assessment/prompts/`); this is a generator change, not just config. Planned first command: an `assess` dispatcher following the `prd` pattern (`repo`, `team`, `config`, `report`, plus `--only <dimension>`). (5) Update README/wiki references. Gate: install `ensemble-assessment` alone into a clean Pi/OMP environment and confirm skills load and the dispatcher resolves its subcommands. |

Also fix the pre-existing dangling skill references listed in the skills plan (backend-developer, frontend-developer, mobile-developer, infrastructure-developer, dotnet-backend-expert). Do this first; it is independent of consolidation.

## 5. Commands plan (48 -> ~30-34)

Source: my own inventory plus the commands subagents; their proposals were checked against the YAML and **several were wrong** (wrong package paths; claimed `refine-beads` is already a `trd` keyword - it is not; invented `--wave`/`--single` flags; invented commands `manage-vault`, `code-review`, `test`). Items below are candidates; each needs a short TRD-level check of behavioral equivalence before the YAML is removed.

| # | Cluster | Candidate change | Evidence / what to verify |
|---|---|---|---|
| C-A | Beads execution (`implement-trd-beads`, `beads-build`, `beads-build-wave`, `beads-plan`, `implement-bead`, `refine-beads`) | `beads-plan` -> `implement-trd-beads --plan` (flag already exists). `implement-bead` -> `beads-build` with a bead id. Keep `beads-build-wave` as the depth-1 helper (invoked via agent) and **hide** it (not REQ-004-protected; confirm nothing invokes it by name through the Skill tool before setting `disable-model-invocation`). Decide separately whether `beads-build` == `implement-trd-beads --execute` (flags `--strategy/--label/--trd` differ). | Confirm flag parity; `--wave`/`--single` do **not** exist today. Add `refine-beads` as a `trd` keyword (new, not existing). |
| C-B | Requirement traceability (`analyze-requirements`, `validate-requirements`, `verify-requirements`, `requirement-status`, `analyze-complexity`) | Merge `analyze-requirements` into `validate-requirements` only if their checks are a subset (analyze also covers beads). Others are distinct phases (pre / post / live); keep. | All five already routed via `trd` keywords. All live in `packages/development`. |
| C-C | PRD/TRD variants | `create-prd-meeting` / `refine-prd-meeting` -> `--from-meeting` on base command; `create-trd-foreman` -> `--foreman` (base commands already take `--foreman` in create-prd); `create-workstream-trd` duplicates `implement-trd-beads --workstream`. Variants are **removed**, not hidden (section 3 rule b). | Variants are separate workflows (e.g. 19KB vs 29KB); merging needs a TRD, not a find/replace. The variant names are not typable afterwards; base specialists are unaffected, so AC-004-1 holds for them. |
| C-D | Reqnroll / feature tests (`generate-feature-tests`, `check-feature-drift`, `generate-reqnroll-bindings`, `check-binding-drift`, `reqnroll-tdd`) - **missed in first pass** | One `reqnroll` (or `tests`) dispatcher with keywords; they already cross-reference each other. | Add as a new dispatcher following the `prd` pattern. |
| C-E | Core standards (`discover-standards`, `inject-standards`, `fold-prompt`) | One `standards` dispatcher; they reference each other. | |
| C-F | Metrics (3 commands, 1.2-1.8KB each) | One `metrics` dispatcher. | Confirm they are not stubs before investing. |
| C-G | E2E (`playwright-test` 2KB vs `author-playwright-tests` 31KB) | Fold the small one into the large as a mode, or remove it. | Different modes (automated vs interactive); check usage. |
| C-H | Odd ones | **Remove `claude-changelog`** (decided; tracks Claude product updates, unrelated to ensemble workflows; also remove its generated mirrors/prompts and list it in `CHANGELOG.md`). `init-project` and router commands exist as hand-written `.md` with **no YAML source**; migrate to YAML or document as exceptions. | |

**Naming convention.** Dispatcher = bare noun (`prd`, `trd`, `feature`, `issue`, + `reqnroll`, `standards`, `metrics`); leaf commands = `<verb>-<object>`; variants are flags (`--from-meeting`, `--foreman`), never name suffixes. Leaves behind a dispatcher are hidden via `metadata.visibility: hidden` (section 3).

## 6. Agents (37) - low confidence, do last

The subagent proposal (remove `release-agent`, `git-workflow`, `github-specialist`, `agent-meta-engineer`; fold `test-reader-agent`) was **not verified**: the wiki roster says `git-workflow` handles ad hoc commits, and `release.yaml` / `pr-merge.yaml` delegate to these agents. Per agent, check callers (`grep` handoffs in commands/agents) before removal. Realistic range 37 -> ~30; the earlier "24" target is not supported by the evidence.

## 7. Sequencing

1. **Fixes (no consolidation):** dangling skill references; missing `full/skills/react` symlink; `mobile-developer.md` and `router-rules.json` drift.
2. **S1 (after the subagent skill-loading gate) + S2** (S2 is the low-risk cut: -5 skills). **S6** can run before or with S1; do it before adding any assessment commands.
3. **S3 + S5** (renames + React/dotnet moves) in one PR with the router/agent/codex-generator edits.
4. **H0 (before any command change): hide mechanism.** Add `metadata.visibility`; choose Claude option A (manifest list) or B (frontmatter) after testing both on a real plugin install; then resolve the Pi and Codex rows in section 3 with a spike on each host. Gate: a hidden leaf is absent from the host's command list and still reachable through its dispatcher keyword.
5. **Commands.** C-H (remove `claude-changelog`) and C-D/C-E/C-F (new dispatchers) do not depend on H0, but the leaves behind new dispatchers only stop being visible once H0 chooses a mechanism, so they add surface until then; do C-H now and the dispatchers together with H0. Then **C-A** (hide the beads leaves), then **C-C, C-B** (each behind a TRD check). Update `docs/` PRD references (REQ-009 only; REQ-004 unchanged) and `CHANGELOG.md` migration notes per phase.
6. **S4** detectors; **agents** last.

Each phase: edit sources, run `npm run generate` from the repo root, run `scripts/validate-all.js`, update the `full/` symlinks by hand, and confirm no remaining references with `grep`.

## 8. Decisions needed

- **Decided:** hide leaves not protected by REQ-004 (supersedes REQ-009); merge variants into flags rather than hiding REQ-004 specialists; REQ-004 / AC-004-1 stay as written.
- **Decided:** framework packages stay separately published.
- **Decided:** detector merge (S4) proceeds; infra-only installs on Claude Code declare a `plugin.json` `dependencies` entry on `ensemble-core`; on Pi, users install core too (same approach as assessment).
- **Decided:** remove `claude-changelog`.
- **Decided:** Codex is maintenance-only; no Codex-specific spikes or features.
- **Decided:** H0 tests both Claude hide mechanisms (manifest list and frontmatter), then chooses.
- **Decided:** assessment leaf skills stay visible and directly invokable (single-dimension runs by name); do not hide them.
- **Decided:** execution starts with the independent fixes (section 7, step 1).
- Assessment packaging (S6) - **decided:** `ensemble-full` includes everything, so it keeps assessment; assessment is Pi-installable as `ensemble-assessment` itself (no separate `ensemble-pi-assessment` package).
- Assessment packaging (S6) - **decided:** no dependency between `ensemble-pi` and `ensemble-assessment`; users install both. Document this in both READMEs and the install docs.

## 9. Execution status (branch `chore/surface-consolidation-prework`)

Surface now: **68 source skills** (was 77), **47 commands** (was 48), **37 agents** (unchanged). Each phase below is its own commit and passed `npm run validate` plus the pi, codex, core, scripts and router test suites.

| Phase | Status | Notes |
|---|---|---|
| Fixes (dangling references, `full/skills/react`) | Done | `faba445` |
| S2 smoke tests 6 -> 1 | Done | `453e72f` |
| S6a assessment packaging (Pi-installable, excluded from `ensemble-pi`, whole-dir mirror in full) | Done | `d82ffae`; commands and the per-package prompt output root (S6 step 4) are **not** done |
| S1 assessment leaves as single source | Done | `52dbac6`; Pi/OMP subagent skill-loading gate passed, Claude Code and Codex not tested; orchestrators carry a fallback sentence |
| S3 frameworks + S5 vendor renames | Done | `30c82c8`; also fixed a Codex path-rewrite regression caused by the earlier reference fixes |
| H0 hide mechanism | **Blocked** | Claude spike not run (CLI hangs in the agent environment); procedure in section 3. Pi/OMP and Codex unverified |
| C-H remove `claude-changelog` | Done | `c1ff12f` |
| S4 detectors 4 -> 1 | Done | `fe942c3`; infra and quality manifests depend on `ensemble-core` |
| C-A/C-B/C-C command merges, C-D/E/F dispatchers, `assess` dispatcher (S6 step 4) | Not started | C-D/E/F add surface until H0 picks a hide mechanism; C-A/B/C each need a behavior-equivalence check first |
| Agent trim | Not started | Needs per-agent caller checks; realistic target about 30, not 24 |

Follow-ups found during execution: (1) the Pi generator never deletes mirrors of removed or renamed skills, so each phase needed manual orphan cleanup (find them by file age after generating); consider making `copySkills` prune. (2) `ensemble-dotnet` has no entry in `configure-team.yaml` (`domain_to_plugins`, `framework_keyword_to_plugin`) and `packages/full/package.json` peerDependencies lacks it. (3) The `ensemble-blazor` marketplace description ("Blazor/.NET framework skills") now overstates since `dotnet` moved out. (4) `rspec` and `xunit` skills are 22-line stubs. (5) Plugin versions were not bumped for the changed packages (only `ensemble-pi` auto-bumped); bump at release. (6) `packages/core/lib/index.js` calls a class without `new` in `detect()` (pre-existing).
