---
document_id: TRD-2026-70e784f2
label: trd-code-review-process
kind: trd
prd_reference: docs/PRD/PRD-2026-70e784f2-code-review-process.md
prd_path: docs/PRD/PRD-2026-70e784f2-code-review-process.md
version: 1.0.1
status: Draft
date: 2026-10-27
design_readiness_score: 4.38
Constitution compliance: passed
---

# TRD-2026-70e784f2: Code Review Process Improvements

Based on PRD: docs/PRD/PRD-2026-70e784f2-code-review-process.md (version 1.0.1, readiness 4.25)

## Architecture Decision

**Chosen approach (Option C):** extend the pattern TRD-2026-82b6a138 established: **editable behavior in skills, agents and markdown; a small set of pure, deterministic libraries for what must not be self-certified by a model.**

- **User-owned (Constitution Rule 8), prose or data a maintainer edits without a toolchain:** per-area rules (`REVIEW.md` files), the policy block inside the root `REVIEW.md` (round cap, depth table, bot and maintainer logins, sensitive and High paths, Low-waiver state), severity definitions, reviewer, verifier, classifier and security-lane prompts, the PR template, the sweep and explainer procedures. All of it is read from the **target branch**, never from the PR head (REQ-024).
- **Enforcement (Rules 5 and 7), code that grades a model's claim:** vote tally, tier assignment with its sensitive-path floor and Low-waiver evidence, approval evaluation bound to a commit, the merge gate, round-cap derivation, repeat suppression, delta-range selection, depth bounds, slice coverage, metrics and eval scoring. Each is a pure CommonJS module in `packages/development/lib/`, exposed as a JSON-in/JSON-out subcommand of the existing `pr-review-cli.js`, following the 82b6a138 precedent. None performs network I/O or holds a timer.
- **Entry points (Rule 6):** every capability is reached through the one `pr-review-cycle` skill, which `fix-issue`, `implement-trd-beads` and `pr-merge` already invoke or will invoke (a new `MODE=gate` for `pr-merge`). YAML callers reference the skill only, never the CLI, as the existing parity tests require.
- **Recurrence (Rule 4):** nightly or weekly sweeps and daily eval runs are on-demand skills; a workflow template for the host repository is opt-in and scaffolded by init-project. Ensemble's own workflows gain no `schedule` trigger.

**Alternatives considered (user chose C):**

- **Option A -- prose-only skills and agents:** fewest files and fastest to ship. Rejected: the vote threshold, the tier floor, commit-bound approvals and the round cap would be prose a model can misread or skip, so none of these gates could be shown to fail (Rule 7), and "a bot approval never counts" would be a request, not a guarantee.
- **Option B -- a new TypeScript review engine in `agent-core`:** strongest typing and one runtime. Rejected: a new build and `dist` surface and cross-package coupling for a prompt-level feature, editable criteria pulled into code (against Rule 8), and drift toward an ensemble-owned dispatcher that competes with Foreman (Rule 4).

**Rationale:** Option C is the best fit for this brownfield repo. It adds only the code that grades claims, keeps everything a maintainer or adopting team would tune in files they can edit, adds no dependency (Constitution §4) and no CI secret, vendors into Pi automatically through the existing require-closure bundler, and each gate can be mutation-proven using the harness that already exists.

**Decisions taken where the PRD left a choice** (each is editable policy, not a hidden constant):

| Decision | Value | Where it lives |
|---|---|---|
| Policy format | Fenced `ensemble-review-policy` JSON block in the root `REVIEW.md` (no new parser dependency) | REVIEW.md, read from the base commit |
| "Cannot vouch for" a push (AC-010-3, AC-014-2) | Commit is unvouched when its tree differs from the reviewed tree and it is not a remediation commit recorded in the review-state report, or it is a merge commit | `pr-review-scope.js`, `pr-review-approvals.js` |
| Slice threshold for large PRs (AC-018-1) | 1500 changed lines, configurable | policy block |
| Area rules vs policy keys | Policy keys are read from the **root** file only; area files carry guidance, and the more restrictive instruction wins when areas conflict (AC-001-2) | skill prose |
| First PR that introduces REVIEW.md | No base copy exists, so strict defaults apply (Low treated as Medium, cap 3, default sensitive set) | `pr-review-policy.js` |
| Verifier majority | Strict majority of the expected verifier count (2 of 3, 3 of 5) | `pr-review-votes.js` |

## Domain Analysis

| Domain | Present? | Notes |
|---|---|---|
| Skill/prompt content | Yes | `pr-review-cycle` revisions; new `pr-review-eval`, `pr-review-sweep`, `pr-review-explainer` skills; `code-reviewer` agent; REVIEW.md, PR template and CODEOWNERS templates |
| Library/CLI (Node.js, pure functions) | Yes | 11 new `pr-review-*.js` modules, edits to ledger, status, scope and state, and 15 new CLI subcommands |
| Data model | Yes | New file formats: policy block, extended ledger finding, review-state tier record, eval case, metrics cohort input. File-based records, no database or migration; recorded in the data-model companion |
| Infrastructure / external services | Read-only | GitHub data is fetched with the already-authenticated `gh` CLI by the skill and passed to pure modules; the host-repo sweep workflow is an opt-in template |
| Security | Yes | PR content is untrusted; base-branch sourcing of rules and policy; secret redaction; reviewers and verifiers are read-only; bot approvals never count |
| Packaging/generation | Yes | `packages/full` symlinks, Pi vendor bundle and skill copies, Claude/Codex/OpenCode generation, four version files per touched package |
| UI | No | CLI and markdown only |

**Greenfield or brownfield:** brownfield.

**COMPANION_DOMAINS:** `data-model` (new persisted file formats and validation rules). `research` is not generated: the alternatives above are architectural, not a vendor or tool comparison.

## Companion Artifacts

- [Data model](TRD-2026-70e784f2-code-review-process-data-model.md)

## Reused Capabilities

No foundational TRD capabilities matched (`trd-graph-cli capabilities docs/TRD` returned an empty registry). Reused existing code instead: TRD-2026-82b6a138 (`pr-review-cycle` skill, `pr-review-cli.js`, ledger, status, scope, remote and state modules), the `pr-review-remediation` and `tool-path-resolution` skills, the `lib-bundler.ts` require-closure vendoring, the `pr-review-cycle-mutation.test.js` harness, the existing state redaction, and the `pr-merge` command.

## System Architecture

### Components and boundaries

New libraries (`packages/development/lib/`, pure, `require('./sibling')` only so the Pi bundler vendors them with no bundler edit):

1. **`pr-review-paths.js`** -- `classifyPaths`, `ownersFor`, the built-in default sensitive set. Glob matching is implemented locally; no dependency.
2. **`pr-review-policy.js`** -- `loadPolicy({ text, sourceSha, baseSha })` -> validated policy, warnings, or the strict defaults with `policy-not-from-base`.
3. **`pr-review-rules.js`** -- `resolveRuleFiles({ changedPaths, rulesFiles })` -> `applied[]`, `notes`.
4. **`pr-review-description.js`** -- `checkDescription(body)` -> `missing[]`, `directedBy`, `ready`.
5. **`pr-review-votes.js`** -- `tallyVotes({ findings, depth, expectedVerifiers })` -> per-finding `present|filtered|disputed|unverified`, plus `verification` status.
6. **`pr-review-depth.js`** -- `resolveDepth`, `checkBounds`, `planSlices`, `verifyCoverage`.
7. **`pr-review-tier.js`** -- `assignTier` and Low-waiver evidence.
8. **`pr-review-approvals.js`** -- `evaluateApprovals`, bound to head SHA or tree.
9. **`pr-review-gate.js`** -- `evaluateGate`: open Important and security findings, approvals, description.
10. **`pr-review-metrics.js`** -- `computeMetrics`, `compareCohorts`.
11. **`pr-review-eval.js`** -- `validateCase`, `scoreEval`, `compareEval`, `staleCases`.

Modified libraries: `pr-review-ledger.js` (taxonomy, resolution records, repeat and class handling), `pr-review-status.js` (`DEFAULT_ROUND_CAP` and `roundCap` fact replace `MAX_AUTO_ROUNDS`), `pr-review-scope.js` (`chooseReviewRange`), `pr-review-state.js` (tier record, remediation commit list), `pr-review-cli.js` (15 subcommands).

Prose and agents: `pr-review-cycle/SKILL.md` (gains guidance resolution, multi-reviewer discovery, verification, delta re-review, `MODE=gate`), `pr-review-eval`, `pr-review-sweep`, `pr-review-explainer` skills, `code-reviewer.yaml`, `pr-merge.yaml`, the tech-lead quality loop and `beads-build-wave`, `init-project.md`, and the repository's own `REVIEW.md`, PR template and CODEOWNERS.

### Data flow

```
caller (fix-issue | implement-trd-beads | pr-merge) --context--> pr-review-cycle SKILL.md
SKILL.md --git show <baseSha>:path--> REVIEW.md files, policy block, sensitivity declaration, CODEOWNERS
SKILL.md --JSON--> pr-review-cli.js policy | rules | paths | description        (guidance)
SKILL.md --subagents--> N reviewers (fresh context) --candidate findings--> ledger
SKILL.md --subagents--> M verifiers --votes--> pr-review-cli.js votes          (verification)
SKILL.md --> pr-review-cli.js depth | slices | ledger | status                 (bounds, rounds, repeats)
MODE=gate: SKILL.md --gh reads--> reviews, threads, checks --> tier | approvals | gate --> mergeable?
pr-merge --requires mergeable:true + existing checks--> gh pr merge
SKILL.md --> .ensemble/pr-review/<key>.json (untracked: tier, votes, rounds, remediation commits)
host automation (opt-in) --> sweep / eval skills --> findings tagged Pre-existing, eval scores
```

### Interface contracts (CLI, all JSON on stdin and stdout)

| Subcommand | Input (key fields) | Output (key fields) |
|---|---|---|
| `policy` | `{ text, sourceSha, baseSha }` | `{ ok, policy, warnings[], reason? }` |
| `rules` | `{ changedPaths[], rulesFiles[] }` | `{ applied[], notes[] }` |
| `paths` | `{ changedPaths[], declaration, codeowners?, baseSha }` | `{ sensitive[], high[], declarationChanged }` |
| `description` | `{ body, agentAuthored }` | `{ missing[], directedBy, ready }` |
| `votes` | `{ findings[{ id, severity, security, kind, reviewer, votes[{ verifier, verdict }] }], depth }` | `{ verification, findings[{ id, outcome, votes, reason }] }` |
| `depth` | `{ tier, requested?, used? }` | `{ mode, bounds, violations[] }` |
| `slices` | `{ paths[{ path, lines }], threshold, areas }` | `{ slices[], uncovered[] }` |
| `tier` | `{ kinds[{ kind, paths[] }], secondAssessment{ needsAnotherPerson, reason, evidencePaths[] }, paths, proposedTier?, waiver, author }` | `{ tier, effectiveTier, reasons[], raised[] }` (unknown kind = `other`; non-boolean assessment = true) |
| `approvals` | `{ reviews[], headSha, headTreeSha, tier, botLogins, directedBy? }` | `{ required, counted[], ignored[{ login, reason }], satisfied }` |
| `gate` | `{ ledger, approvals, tier, description, security }` | `{ mergeable, blockers[{ code, detail, nextAction }] }` (missing data = `review-data-unavailable`) |
| `metrics` / `metrics-compare` | merged-PR arrays; baseline and post-change cohorts | metrics; `{ targets, guardrail, cohortOk }` |
| `eval-score` / `eval-compare` / `eval-stale` | cases and per-case reviewer findings; two runs; rules hashes | scores; `{ regression, flipped[] }`; stale case ids |

- **Failure semantics (unchanged from 82b6a138):** request-shape errors exit 1 with `{ error }`; graded facts that are missing or malformed fail closed in-band with exit 0 and a blocking result. No subcommand returns a passing result for `null`, an array, a scalar or a `__proto__` payload.
- **Fail-closed examples:** an unknown severity stays actionable; an unrecognised verdict is not a vote; a policy that is not from the base commit is replaced by strict defaults; an approval whose commit tree cannot be confirmed does not count.

### Integration points (existing files, edited at source)

- `packages/development/skills/pr-review-cycle/SKILL.md`, `packages/development/lib/pr-review-{ledger,status,scope,state,cli}.js` and their tests, including the string-anchored mutants in `pr-review-cycle-mutation.test.js` that pin `status.js` text.
- `packages/git/commands/pr-merge.yaml` (round cap default, merge step, new gate), `packages/development/agents/tech-lead-orchestrator.yaml` quality loop, `packages/development/commands/beads-build-wave.yaml`.
- `packages/development/commands/fix-issue.yaml` and `implement-trd-beads.yaml` (PR body sections, `Directed by:` line). Their tests forbid direct CLI references; callers invoke the skill.
- `packages/quality/agents/code-reviewer.yaml` (read-only tools, structured output, coverage thresholds aligned to the constitution).
- `packages/core/commands/ensemble/init-project.md` (hand-authored, not generated; templates stay outside the constitution fence checked by `init-project-constitution.test.js`).
- Packaging: `packages/full/lib` and `packages/full/skills` symlinks, `packages/pi/tests/lib-bundler.test.ts` expected counts, `npm run generate`, `generate:pi`, `generate:codex`, `generate:opencode` from the repo root, and version bumps across package.json, `.claude-plugin/plugin.json` and marketplace files.

### Security and trust

- Rules, policy, sensitivity declaration and CODEOWNERS come from the base commit; a PR cannot loosen its own review (REQ-024). A PR that edits the declaration is itself sensitive (AC-003-3).
- Reviewers and verifiers are read-only subagents; the `code-reviewer` agent loses Write and Edit (AC-004-3). All PR text is data, per the existing untrusted-input rules.
- Secrets are redacted with the existing state redaction before any finding, reason or report is written (Rule 1).
- **Honest limit:** these gates run where ensemble commands run. Server-side enforcement of required approvals needs branch protection in the host repository; `pr-merge` reports when it is absent and the docs recommend it.

## Master Task List

### PR 1: Review Guidance, Sensitivity and Policy
**Shippable State:** A maintainer can add a REVIEW.md (per-area rules plus a policy block) and a sensitive-path declaration, scaffold them with a PR template through `/ensemble:init-project`, and every review reads rules and policy from the target branch, reports which rules applied, and checks that PR descriptions carry Testing, Risk and How-to-revert.

- [ ] **TRD-001** Path matching, owner and sensitivity resolution (`pr-review-paths.js`) [satisfies REQ-003] (4h)
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-003-3
  - Implementation AC:
    - [ ] Given an owner-declared sensitive or High path list and a set of changed paths, when `classifyPaths` runs, then each changed path is reported as sensitive or not and the matching declaration entry is named
    - [ ] Given no owner declaration, when `classifyPaths` runs on CI workflow definitions, release gates, installers, generation scripts or the constitution file, then they are sensitive through the built-in default set
    - [ ] Given a changed path equal to the declaration file itself, when `classifyPaths` runs with a declaration read from the base branch, then the PR is sensitive and the declaration in force is the base copy
    - [ ] Given a CODEOWNERS text, when `ownersFor` runs on a path, then the last matching rule wins and the owner list is returned; a malformed line is reported and skipped, never guessed

- [ ] **TRD-001-TEST** Sensitive-area resolution [Verifies TRD-001] [Satisfies REQ-003] [Depends: TRD-001] (4h)
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-003-3
  - Test AC:
    - [ ] Scenario: AC-003-1 Owner-declared sensitive areas -- Given an owner declares a path as sensitive, When a PR touches it, Then the PR is treated as sensitive by every review and approval rule that consults sensitivity
    - [ ] Scenario: AC-003-2 Owner-declared sensitive areas -- Given CI workflow definitions, release gates, installers, the generation pipeline and the project constitution, When no owner has declared them, Then they are still treated as sensitive by default
    - [ ] Scenario: AC-003-3 Owner-declared sensitive areas -- Given a PR changes the sensitivity declaration itself, When it is reviewed, Then it is treated as sensitive and the declaration in force is the one on the target branch, not the one in the PR

- [ ] **TRD-002** Review policy loader (`pr-review-policy.js`) [satisfies REQ-001, REQ-009, REQ-016, REQ-024] [Depends: TRD-001] (6h)
  - Validates PRD ACs: AC-001-3, AC-009-2, AC-009-3, AC-016-2, AC-024-1
  - Implementation AC:
    - [ ] Given the text of a root REVIEW.md with a fenced `ensemble-review-policy` JSON block, when `loadPolicy` runs, then it returns the validated policy (round cap, depth table, bot and maintainer logins, sensitive and High paths, Low-waiver state) with every unset key filled from strict defaults
    - [ ] Given a configured round cap outside 1 to 5 or not an integer, when `loadPolicy` runs, then the default of 3 is used and a warning is returned; given a valid cap, then that single value is returned for every consumer
    - [ ] Given a policy whose `sourceSha` differs from the review `baseSha`, or has no source identity, when `loadPolicy` runs, then it is rejected and the strict defaults apply with reason `policy-not-from-base`
    - [ ] Given an unknown key, a wrong type or a depth bound that raises Quick above one reviewer or any verifier, when `loadPolicy` runs, then the key is rejected with its name and the default applies; no key is ever executed or evaluated as code

- [ ] **TRD-002-TEST** Policy loading and validation [Verifies TRD-002] [Satisfies REQ-001, REQ-009, REQ-016, REQ-024] [Depends: TRD-002] (5h)
  - Validates PRD ACs: AC-001-3, AC-009-2, AC-009-3, AC-016-2, AC-024-1
  - Test AC:
    - [ ] Scenario: AC-001-3 Area-specific review rules -- Given a maintainer wants to change what the reviewer cares about, When they edit the rules file, Then the next review reflects the change without a code change, rebuild or release
    - [ ] Scenario: AC-009-2 One round policy for every review procedure -- Given no repository setting, When the cap applies, Then it is 3 rounds; a repository may configure any value from 1 to 5, and a value outside that range is ignored with a warning and the default is used
    - [ ] Scenario: AC-009-3 One round policy for every review procedure -- Given a repository sets a different cap in its review rules, When review runs, Then that value is used by every procedure and no procedure keeps a private number
    - [ ] Scenario: AC-016-2 Review depth modes -- Given a maintainer wants to redefine a mode, When they edit its definition, Then the change takes effect without a code change
    - [ ] Scenario: AC-024-1 PR content is untrusted; no secrets -- Given a PR description, diff, comment or the PR's own copy of the rules file contains text addressed to the reviewer, When review runs, Then that text is treated as data and does not alter reviewer behavior; rules and sensitivity declarations come from the target branch

- [ ] **TRD-003** Applicable review-rules resolver (`pr-review-rules.js`) [satisfies REQ-001] [Depends: TRD-001] (3h)
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-001-4
  - Implementation AC:
    - [ ] Given changed paths and the list of REVIEW.md files present at the base commit, when `resolveRuleFiles` runs, then each path maps to its nearest ancestor rules file plus the root file, and the union (deduplicated, root first) is returned as `applied[]`
    - [ ] Given a PR touching two areas that each have rules, when `resolveRuleFiles` runs, then both files are returned in a stable order so the skill can apply both and let the more restrictive instruction win
    - [ ] Given no rules file for an area and no root file, when `resolveRuleFiles` runs, then `applied` is empty and `notes` states that no area-specific rules were found

- [ ] **TRD-003-TEST** Rules resolution [Verifies TRD-003] [Satisfies REQ-001] [Depends: TRD-003] (3h)
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-001-4
  - Test AC:
    - [ ] Scenario: AC-001-1 Area-specific review rules -- Given a repository contains a review rules file for an area, When a PR touching that area is reviewed, Then the reviewer applies those rules and the review report names which rules file(s) were applied
    - [ ] Scenario: AC-001-2 Area-specific review rules -- Given a PR touches two areas that each have rules, When it is reviewed, Then both sets of rules apply and the more restrictive instruction wins on conflict
    - [ ] Scenario: AC-001-4 Area-specific review rules -- Given no rules file exists for an area, When a PR is reviewed, Then review proceeds using repository-wide guidance and the report states that no area-specific rules were found

- [ ] **TRD-004** PR description checker (`pr-review-description.js`) [satisfies REQ-002] (3h)
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-002-3
  - Implementation AC:
    - [ ] Given a PR body, when `checkDescription` runs, then it returns `missing[]` naming each absent section among Testing, Risk and How to revert (heading match is case-insensitive and ignores trailing punctuation); an empty section counts as missing
    - [ ] Given a PR body with a `Directed by:` line naming a login, when `checkDescription` runs, then `directedBy` is returned; given an agent-authored PR with no such line, then `missing` includes `directed-by`
    - [ ] Given any body, when `checkDescription` runs, then `ready` is true only when `missing` is empty

- [ ] **TRD-004-TEST** PR description sections [Verifies TRD-004] [Satisfies REQ-002] [Depends: TRD-004] (3h)
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-002-3
  - Test AC:
    - [ ] Scenario: AC-002-1 PR description captures testing, risk and rollback -- Given a PR is opened by a human or an agent, When its description is created, Then it contains Testing, Risk and How-to-revert sections
    - [ ] Scenario: AC-002-2 PR description captures testing, risk and rollback -- Given an agent drafts those sections, When the PR is ready for human approval, Then the person who directed the agent is identified as the one accountable for them
    - [ ] Scenario: AC-002-3 PR description captures testing, risk and rollback -- Given a PR description is missing any of the three sections, When its review status is computed, Then the PR is reported as not ready for approval and names the missing section

- [ ] **TRD-005** CLI subcommands `policy`, `rules`, `paths`, `description` (`pr-review-cli.js`) [satisfies REQ-001, REQ-002, REQ-003] [Depends: TRD-001, TRD-002, TRD-003, TRD-004] (4h)
  - Validates PRD ACs: AC-001-4, AC-002-3, AC-003-2
  - Implementation AC:
    - [ ] Given JSON on stdin, when `policy|rules|paths|description` runs, then it delegates to the matching module and prints one JSON object; the handlers are registered in the frozen HANDLERS map and listed in both usage strings
    - [ ] Given an unparseable, null, array, scalar or `__proto__` payload, when any new subcommand runs, then it exits non-zero or returns a fail-closed result and never a clean pass (the existing adversarial sweep covers the new subcommands)
    - [ ] Given the same input, when run through the CLI and through the module directly, then the results are identical

- [ ] **TRD-005-TEST** Guidance CLI end to end [Verifies TRD-005] [Satisfies REQ-001, REQ-002, REQ-003] [Depends: TRD-005] (3h)
  - Validates PRD ACs: AC-001-4, AC-002-3, AC-003-2
  - Test AC:
    - [ ] Scenario: AC-001-4 Area-specific review rules -- Given no rules file exists for an area, When a PR is reviewed, Then review proceeds using repository-wide guidance and the report states that no area-specific rules were found
    - [ ] Scenario: AC-002-3 PR description captures testing, risk and rollback -- Given a PR description is missing any of the three sections, When its review status is computed, Then the PR is reported as not ready for approval and names the missing section
    - [ ] Scenario: AC-003-2 Owner-declared sensitive areas -- Given CI workflow definitions, release gates, installers, the generation pipeline and the project constitution, When no owner has declared them, Then they are still treated as sensitive by default

- [ ] **TRD-006** Skill and caller integration for guidance (pr-review-cycle, fix-issue, implement-trd-beads) [satisfies REQ-001, REQ-002, REQ-024] [Depends: TRD-005] (6h)
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-024-1
  - Implementation AC:
    - [ ] Given a review starts, when the skill resolves guidance, then it reads REVIEW.md files, the policy block and the sensitivity declaration with `git show <baseSha>:<path>` (never from the PR head), passes them through `policy` and `rules`, and the report names every rules file applied or states none were found
    - [ ] Given text addressed to the reviewer inside the diff, a PR description, a comment or the PR's own copy of a rules file, when the skill reviews, then it is treated as data under the existing untrusted-input rules and does not change reviewer behavior
    - [ ] Given `fix-issue` or `implement-trd-beads` builds a PR body, when it is generated, then it contains Testing, Risk and How-to-revert sections and a `Directed by:` line for agent-authored PRs; the YAML callers reference the skill only, never the CLI

- [ ] **TRD-006-TEST** Guidance reaches review and PR creation [Verifies TRD-006] [Satisfies REQ-001, REQ-002, REQ-024] [Depends: TRD-006] (5h)
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-024-1
  - Test AC:
    - [ ] Scenario: AC-001-1 Area-specific review rules -- Given a repository contains a review rules file for an area, When a PR touching that area is reviewed, Then the reviewer applies those rules and the review report names which rules file(s) were applied
    - [ ] Scenario: AC-001-2 Area-specific review rules -- Given a PR touches two areas that each have rules, When it is reviewed, Then both sets of rules apply and the more restrictive instruction wins on conflict
    - [ ] Scenario: AC-002-1 PR description captures testing, risk and rollback -- Given a PR is opened by a human or an agent, When its description is created, Then it contains Testing, Risk and How-to-revert sections
    - [ ] Scenario: AC-002-2 PR description captures testing, risk and rollback -- Given an agent drafts those sections, When the PR is ready for human approval, Then the person who directed the agent is identified as the one accountable for them
    - [ ] Scenario: AC-024-1 PR content is untrusted; no secrets -- Given a PR description, diff, comment or the PR's own copy of the rules file contains text addressed to the reviewer, When review runs, Then that text is treated as data and does not alter reviewer behavior; rules and sensitivity declarations come from the target branch

- [ ] **TRD-007** Init-project scaffolding and this repository's own review files [satisfies REQ-001, REQ-002, REQ-003] [Depends: TRD-005] (6h)
  - Validates PRD ACs: AC-002-4, AC-003-1, AC-001-3
  - Implementation AC:
    - [ ] Given `/ensemble:init-project` runs in a repository without them, when scaffolding completes, then `.github/pull_request_template.md` (Testing, Risk, How to revert), a root `REVIEW.md` with the policy block and an example area rule, and `.github/CODEOWNERS` are created; the templates sit outside the constitution fence so the init-project constitution test still passes
    - [ ] Given any of those files already exists, when init-project runs without force, then it shows the difference and merges or skips and never overwrites
    - [ ] Given this repository, when the change merges, then it carries its own `REVIEW.md` (policy block, maintainers, sensitive paths for workflows, release gates, installers, generation pipeline and constitution), PR template and CODEOWNERS

- [ ] **TRD-007-TEST** Scaffolding adoption flow [Verifies TRD-007] [Satisfies REQ-001, REQ-002, REQ-003] [Depends: TRD-007] (4h)
  - Validates PRD ACs: AC-002-4, AC-003-1, AC-001-3
  - Test AC:
    - [ ] Scenario: AC-002-4 PR description captures testing, risk and rollback -- Given an adopting team runs the project init flow, When it completes, Then the PR template, review rules file and ownership declaration are scaffolded into their repository
    - [ ] Scenario: AC-003-1 Owner-declared sensitive areas -- Given an owner declares a path as sensitive, When a PR touches it, Then the PR is treated as sensitive by every review and approval rule that consults sensitivity
    - [ ] Scenario: AC-001-3 Area-specific review rules -- Given a maintainer wants to change what the reviewer cares about, When they edit the rules file, Then the next review reflects the change without a code change, rebuild or release

- [ ] **TRD-044** Baseline capture runbook and committed baseline result [satisfies REQ-019] (3h)
  - Validates PRD ACs: AC-019-1, AC-019-2
  - Implementation AC:
    - [ ] Given `docs/guides/pr-review-cycle-time-pilot.md`, when extended, then it defines the new metrics (human approvals per PR median and p95, human comments, wait-on-human time, rounds-to-pass, share needing 5+ rounds, noise rate by author response class, reverts and incidents) as `gh` and `jq` queries and states the cohort rule (at least 20 PRs and 30 days)
    - [ ] Given the runbook is followed on the repository's merged PRs, when the baseline is captured before PR 2 lands, then the result is committed as `docs/guides/review-baseline-<date>.json` and later comparisons read it
    - [ ] Given the PR 5 metrics library, when it runs on the same inputs, then it reproduces the committed baseline numbers (checked in TRD-030)

- [ ] **TRD-044-TEST** Baseline runbook produces the metric set [Verifies TRD-044] [Satisfies REQ-019] [Depends: TRD-044] (2h)
  - Validates PRD ACs: AC-019-1, AC-019-2
  - Test AC:
    - [ ] Scenario: AC-019-1 Review metrics with a revert and incident guardrail -- Given a cohort of merged PRs, When metrics are produced, Then they include human approvals per PR (median and p95), human comments, wait-on-human time, rounds-to-pass, and the share of PRs needing five or more rounds
    - [ ] Scenario: AC-019-2 Review metrics with a revert and incident guardrail -- Given findings were presented, When metrics are produced, Then each is classified by how the author responded (fixed, said wrong, said intentional, judged unimportant) and a noise rate is reported

- [ ] **TRD-008** PR 1 packaging, mirrors, generation and docs [satisfies ARCH] [Depends: TRD-006, TRD-007, TRD-044] (3h)
  - Implementation AC:
    - [ ] Given new libs under `packages/development/lib`, when packaging runs, then `packages/full/lib` symlinks exist for each, `packages/pi/tests/lib-bundler.test.ts` expected counts are updated, and `npm run validate` passes
    - [ ] Given YAML or skill sources changed, when `npm run generate`, `generate:pi`, `generate:codex` and `generate:opencode` run from the repo root, then generated artifacts are committed and `npm run generate:validate` shows no diff
    - [ ] Given the change ships, when docs are updated, then the development, core and full package READMEs and CHANGELOGs, the user guide init-project section and the four version files for touched packages are updated

### PR 2: Severity Taxonomy and Convergence
**Shippable State:** Reviewers report findings as Important, Nit or Pre-existing (Pre-existing never blocks), repeated findings are suppressed, class-of-bug findings list every instance, re-reviews cover only new changes when the history is trusted, and `pr-review-cycle` and `pr-merge` stop at one shared round cap (default 3) and ask the author to reconsider the approach.

- [ ] **TRD-009** Severity taxonomy and resolution records in the ledger (`pr-review-ledger.js`) [satisfies REQ-007, REQ-008, REQ-024] [Depends: TRD-002] (6h)
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3, AC-007-4, AC-008-2, AC-008-3, AC-024-2
  - Implementation AC:
    - [ ] Given a finding in code the PR did not introduce, when the ledger is validated, then it carries tag `pre-existing`, is never actionable, and is reported separately
    - [ ] Given findings, when presented, then they sort Important first, each anchored to a file and line; the severity words and their definitions are read from the editable skill/REVIEW.md text and the library only enforces the closed set Important, Nit, Pre-existing
    - [ ] Given a ledger written with Critical, Major, Minor or Nitpick, when it is read, then Critical and Major map to Important and Minor and Nitpick to Nit, with no finding lost and no blocking outcome changed (fail-closed: an unrecognised severity stays actionable)
    - [ ] Given a finding closed with a reason, when validated, then the reason is stored on the finding and it no longer blocks; given a later head whose changes fix the cited location, then the finding clears on re-review
    - [ ] Given a finding or reason containing text that matches credential patterns, when recorded, then the value is redacted using the existing state redaction

- [ ] **TRD-009-TEST** Severity taxonomy and resolutions [Verifies TRD-009] [Satisfies REQ-007, REQ-008, REQ-024] [Depends: TRD-009] (6h)
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3, AC-007-4, AC-008-2, AC-008-3, AC-024-2
  - Test AC:
    - [ ] Scenario: AC-007-1 Severity taxonomy with Pre-existing -- Given a finding exists in code the PR did not introduce, When it is classified, Then it is tagged Pre-existing and does not block the PR
    - [ ] Scenario: AC-007-2 Severity taxonomy with Pre-existing -- Given findings are presented, When the author views them, Then they are sorted with Important first and each is anchored to a file and line
    - [ ] Scenario: AC-007-3 Severity taxonomy with Pre-existing -- Given a maintainer wants to change what counts as Important versus Nit, When they edit the severity definitions, Then the change takes effect without a code change
    - [ ] Scenario: AC-007-4 Severity taxonomy with Pre-existing -- Given existing ledgers use the prior severity vocabulary (Critical, Major, Minor, Nitpick), When they are read, Then they map to the new taxonomy without losing any finding or changing any blocking outcome
    - [ ] Scenario: AC-008-2 Every finding is answered before merge -- Given an author resolves a finding with a reason, When the thread is closed, Then the reason is stored with the finding and the finding no longer blocks
    - [ ] Scenario: AC-008-3 Every finding is answered before merge -- Given a later commit fixes the issue a finding described, When the next review runs, Then the finding clears on its own
    - [ ] Scenario: AC-024-2 PR content is untrusted; no secrets -- Given a reviewer or verifier encounters a credential or token, When findings are reported, Then the secret value is not reproduced in any finding, comment or ledger entry

- [ ] **TRD-010** Cross-round repeat suppression and class-of-bug records (`pr-review-ledger.js`) [satisfies REQ-010, REQ-011] [Depends: TRD-009] (6h)
  - Validates PRD ACs: AC-010-2, AC-011-1, AC-011-2
  - Implementation AC:
    - [ ] Given a finding fingerprint (path, normalized failure mode, class) already recorded for this PR, when a later round reports it, then `recordRound` classifies it as a repeat, does not add it to the presented set and keeps the first record
    - [ ] Given findings sharing a class, when presented, then one class finding names the class and lists every instance location
    - [ ] Given the author fixes one instance of a class, when the next round finds another, then it is attached to the existing class finding and not opened as a new finding

- [ ] **TRD-010-TEST** Repeat suppression and class findings [Verifies TRD-010] [Satisfies REQ-010, REQ-011] [Depends: TRD-010] (5h)
  - Validates PRD ACs: AC-010-2, AC-011-1, AC-011-2
  - Test AC:
    - [ ] Scenario: AC-010-2 Diff-only re-review and no repeats -- Given a finding already recorded for this PR, When a later round sees the same defect, Then it is not posted again
    - [ ] Scenario: AC-011-1 Class-of-bug flagging -- Given a finding fits a repeatable class (the same mistake in several places), When it is presented, Then it names the class and lists the instances found
    - [ ] Scenario: AC-011-2 Class-of-bug flagging -- Given the author fixes one instance of a flagged class, When the next review runs, Then any remaining instance is reported against the existing class finding, not as a new finding

- [ ] **TRD-011** Delta-review range with unvouched fallback (`pr-review-scope.js`) [satisfies REQ-010] [Depends: TRD-009] (5h)
  - Validates PRD ACs: AC-010-1, AC-010-3
  - Implementation AC:
    - [ ] Given a previously reviewed head, a current head and commit facts, when `chooseReviewRange` runs after the first round, then it returns `lastReviewedSha..headSha` (delta)
    - [ ] Given any commit in that range that is a merge, is not one of the remediation commits recorded in the review-state report, or whose parent chain does not reach the reviewed head, when `chooseReviewRange` runs, then it returns the full base-correct range and the reason `unvouched-history`
    - [ ] Given the reviewed head is unknown or unreachable, when it runs, then it falls back to the full range and never guesses

- [ ] **TRD-011-TEST** Delta versus full re-review [Verifies TRD-011] [Satisfies REQ-010] [Depends: TRD-011] (4h)
  - Validates PRD ACs: AC-010-1, AC-010-3
  - Test AC:
    - [ ] Scenario: AC-010-1 Diff-only re-review and no repeats -- Given a round after the first completes, When the next re-review runs, Then it examines only the changes since the previously reviewed commit
    - [ ] Scenario: AC-010-3 Diff-only re-review and no repeats -- Given new commits on a PR the system cannot vouch for (for example an agent push or a hand-resolved merge), When re-review runs, Then it falls back to a full-diff review rather than trusting the prior one

- [ ] **TRD-012** Round-cap cutover: one shared cap in status, pr-merge and quality loop [satisfies REQ-009] [Depends: TRD-002, TRD-009] (6h)
  - Validates PRD ACs: AC-009-1, AC-009-2, AC-009-3, AC-009-4
  - Implementation AC:
    - [ ] Given `pr-review-status.js`, when the cap is read, then `MAX_AUTO_ROUNDS` is replaced by `DEFAULT_ROUND_CAP = 3` and `deriveStatus` takes the validated `roundCap` from facts; reaching the cap returns the escalation result (reconsider the approach) and never completes
    - [ ] Given `pr-merge.yaml`, the tech-lead quality loop and `beads-build-wave`, when they bound review rounds, then each takes the cap from the policy via the pr-review-cycle skill and none keeps a private number (the former 5 and 2 are removed)
    - [ ] Given PRD and TRD 82b6a138 that state a 2-round cap, when this task lands, then their text and the tests that pin the old constant (`pr-review-status.test.js`, vocabulary and mutation guards) are updated in the same change

- [ ] **TRD-012-TEST** Single round cap everywhere [Verifies TRD-012] [Satisfies REQ-009] [Depends: TRD-012] (5h)
  - Validates PRD ACs: AC-009-1, AC-009-2, AC-009-3, AC-009-4
  - Test AC:
    - [ ] Scenario: AC-009-1 One round policy for every review procedure -- Given any ensemble review procedure runs on a PR, When the round count reaches the cap, Then the reviewer stops iterating and asks the author to step back and reconsider the approach
    - [ ] Scenario: AC-009-2 One round policy for every review procedure -- Given no repository setting, When the cap applies, Then it is 3 rounds; a repository may configure any value from 1 to 5, and a value outside that range is ignored with a warning and the default is used
    - [ ] Scenario: AC-009-3 One round policy for every review procedure -- Given a repository sets a different cap in its review rules, When review runs, Then that value is used by every procedure and no procedure keeps a private number
    - [ ] Scenario: AC-009-4 One round policy for every review procedure -- Given PRD-2026-82b6a138 stated a 2-round cap, When this requirement ships, Then that PRD is updated so it no longer contradicts the shared cap

- [ ] **TRD-013** Skill integration: severity definitions, delta re-review, class flags, escalation [satisfies REQ-007, REQ-009, REQ-010, REQ-011] [Depends: TRD-010, TRD-011, TRD-012] (5h)
  - Validates PRD ACs: AC-007-2, AC-007-3, AC-009-1, AC-010-1, AC-011-1
  - Implementation AC:
    - [ ] Given the pr-review-cycle skill, when it runs rounds after the first, then it asks for `chooseReviewRange`, reviews only that range, reports repeats as suppressed, and flags classes so the batch fix covers every instance
    - [ ] Given the round cap is reached, when the skill continues, then it stops iterating, writes the next action asking the author to reconsider the approach, and reports REVIEW_PENDING or REVIEW_BLOCKED, never complete
    - [ ] Given the Important, Nit and Pre-existing definitions, when a maintainer edits them in the skill or REVIEW.md, then the next review uses the new wording with no code change

- [ ] **TRD-013-TEST** Convergence in the review loop [Verifies TRD-013] [Satisfies REQ-007, REQ-009, REQ-010, REQ-011] [Depends: TRD-013] (4h)
  - Validates PRD ACs: AC-007-2, AC-007-3, AC-009-1, AC-010-1, AC-011-1
  - Test AC:
    - [ ] Scenario: AC-007-2 Severity taxonomy with Pre-existing -- Given findings are presented, When the author views them, Then they are sorted with Important first and each is anchored to a file and line
    - [ ] Scenario: AC-007-3 Severity taxonomy with Pre-existing -- Given a maintainer wants to change what counts as Important versus Nit, When they edit the severity definitions, Then the change takes effect without a code change
    - [ ] Scenario: AC-009-1 One round policy for every review procedure -- Given any ensemble review procedure runs on a PR, When the round count reaches the cap, Then the reviewer stops iterating and asks the author to step back and reconsider the approach
    - [ ] Scenario: AC-010-1 Diff-only re-review and no repeats -- Given a round after the first completes, When the next re-review runs, Then it examines only the changes since the previously reviewed commit
    - [ ] Scenario: AC-011-1 Class-of-bug flagging -- Given a finding fits a repeatable class (the same mistake in several places), When it is presented, Then it names the class and lists the instances found

- [ ] **TRD-014** Gate-can-fail proofs for round cap and repeat suppression [satisfies REQ-025] [Depends: TRD-010, TRD-012] (4h)
  - Validates PRD ACs: AC-025-1, AC-025-2
  - Implementation AC:
    - [ ] Given the mutation harness in `pr-review-cycle-mutation.test.js`, when guards for the round cap and repeat suppression are added, then each applies an anchor-based mutant (cap check always false; repeat check removed), the control passes once, and the mutant fails exactly the named test
    - [ ] Given each guard, when a trivial case would pass, then a second case that must be refused is included and refused

- [ ] **TRD-014-TEST** Round and repeat gates fail when broken [Verifies TRD-014] [Satisfies REQ-025] [Depends: TRD-014] (3h)
  - Validates PRD ACs: AC-025-1, AC-025-2
  - Test AC:
    - [ ] Scenario: AC-025-1 Every new gate can fail -- Given each of the verification threshold, the round cap, the tier floor, commit-bound approval, the blocking security lane and the finding-answered merge block, When it is deliberately broken (for example a threshold set to always pass), Then its check fails
    - [ ] Scenario: AC-025-2 Every new gate can fail -- Given a gate's check passes only in a trivial case, When it is reviewed, Then a second case that must be refused is included and refused

- [ ] **TRD-015** PR 2 packaging, mirrors, generation and docs [satisfies ARCH] [Depends: TRD-013, TRD-014] (3h)
  - Implementation AC:
    - [ ] Given PR 2 changes, when packaging runs, then mirrors, generated artifacts, pi vendor bundle and version files are refreshed as in TRD-008 and `npm run validate` and the touched package tests pass
    - [ ] Given the shared cap, when docs are updated, then the development README (`pr-review-cli` section) and CHANGELOG describe the default 3 and the 1 to 5 range

### PR 3: Verified Findings, Depth and Scale
**Shippable State:** Review is performed by multiple fresh-context reviewers; every finding, including CodeRabbit's, is verified by independent voters before the author must answer it; filtered, disputed and unverified findings stay visible with their votes; Quick, Standard and Deep bound agent counts; large PRs are reviewed by area; reduced-capability runs say so.

- [ ] **TRD-016** Vote tally core: majority, non-findings and critical bypass (`pr-review-votes.js`) [satisfies REQ-005, REQ-006] [Depends: TRD-009] (4h)
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-006-2
  - Implementation AC:
    - [ ] Given candidate findings with verifier votes and a depth (Quick 0, Standard 3, Deep 5 verifiers), when `tallyVotes` runs, then a finding is `present` only if a strict majority of the expected verifiers voted real; a verifier may not be the finding's own reviewer, and a vote outside real, not-real or abstain is not a vote
    - [ ] Given style-only, diagnostic or cleanup findings, when tallied, then they are `filtered` with reason `non-finding`
    - [ ] Given a critical or security-relevant finding that splits or is rejected, when tallied, then it is `disputed` and still presented for human adjudication

- [ ] **TRD-016-TEST** Vote majority and critical bypass [Verifies TRD-016] [Satisfies REQ-005, REQ-006] [Depends: TRD-016] (3h)
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-006-2
  - Test AC:
    - [ ] Scenario: AC-005-1 Verification before posting -- Given candidate findings exist, When verification runs, Then each finding receives independent votes from verifiers who did not produce it, and a finding is presented to the author only if a majority of its verifiers judge it real; the number of verifiers is 0 at Quick, 3 at Standard and 5 at Deep
    - [ ] Scenario: AC-005-2 Verification before posting -- Given findings that are purely stylistic, diagnostic or cleanup, When verification completes, Then they are not presented as findings requiring an answer
    - [ ] Scenario: AC-006-2 Nothing is silently dropped; verification failure is visible -- Given a candidate finding is critical or security-relevant, When verifiers split or reject it, Then it is still presented for human adjudication, marked as disputed

- [ ] **TRD-039** Vote outcomes: visibility, per-finding degradation and ledger recording (`pr-review-votes.js`) [satisfies REQ-005, REQ-006] [Depends: TRD-016] (4h)
  - Validates PRD ACs: AC-005-4, AC-006-1, AC-006-3
  - Implementation AC:
    - [ ] Given a finding filtered by verification, when the ledger is written, then it is present with its votes, the threshold and the reason it was not presented, and the author view shows it as "verifier disagrees"
    - [ ] Given only some verifiers returned (timeout, tool failure) or depth Quick, when tallied, then only the affected findings are `unverified`, presented and marked; findings whose verifiers all returned keep their votes; the result carries `verification: partial|not-performed` with the reason, and nothing is ever dropped
    - [ ] Given any blocked or degraded result, when returned, then it names the recovery action (re-run verification, supply the missing votes)

- [ ] **TRD-039-TEST** Visible, degradable verification outcomes [Verifies TRD-039] [Satisfies REQ-005, REQ-006] [Depends: TRD-039] (3h)
  - Validates PRD ACs: AC-005-4, AC-006-1, AC-006-3
  - Test AC:
    - [ ] Scenario: AC-005-4 Verification before posting -- Given a finding fails verification, When the author views the review, Then it appears as "verifier disagrees" with the reason, not as a required fix
    - [ ] Scenario: AC-006-1 Nothing is silently dropped; verification failure is visible -- Given a finding is filtered out by verification, When the ledger is read, Then it is present with its votes and the reason it was not presented
    - [ ] Scenario: AC-006-3 Nothing is silently dropped; verification failure is visible -- Given verification cannot run (no subagent capability, tool failure or timeout), When the review completes, Then findings are presented marked "unverified" and the status states that verification was not performed; findings are never dropped on that account

- [ ] **TRD-017** Depth bounds and slice planner (`pr-review-depth.js`) [satisfies REQ-016, REQ-018] [Depends: TRD-002] (5h)
  - Validates PRD ACs: AC-016-1, AC-016-3, AC-018-1, AC-018-2
  - Implementation AC:
    - [ ] Given a tier and an optional requested mode, when `resolveDepth` runs, then the default is Low=Quick, Medium=Standard, High=Deep, a Low PR treated as Medium gets Standard, and an explicit request wins
    - [ ] Given planned or used reviewer and verifier counts, when `checkBounds` runs, then counts above the mode bound (Quick one reviewer and no verifiers; Standard at least two reviewers and 3 verifiers; Deep at least two reviewers and 5 verifiers) are reported as violations
    - [ ] Given changed paths with line counts and a policy slice threshold (default 1500 changed lines), when `planSlices` runs, then paths are partitioned by sensitive-area and rules boundaries, every changed path appears in exactly one slice, and `verifyCoverage` reports any unreviewed path

- [ ] **TRD-017-TEST** Depth modes and area slices [Verifies TRD-017] [Satisfies REQ-016, REQ-018] [Depends: TRD-017] (4h)
  - Validates PRD ACs: AC-016-1, AC-016-3, AC-018-1, AC-018-2
  - Test AC:
    - [ ] Scenario: AC-016-1 Review depth modes -- Given a mode is selected, When review runs, Then the number of reviewers and verifiers does not exceed that mode's bound (Quick: a single reviewer and no verifiers; Standard: at least two reviewers and 3 verifiers; Deep: at least two reviewers and 5 verifiers)
    - [ ] Scenario: AC-016-3 Review depth modes -- Given no mode is chosen, When review starts, Then the mode defaults from the PR's tier: Low=Quick, Medium=Standard, High=Deep; while Low is treated as Medium (REQ-013), a Low PR gets Standard
    - [ ] Scenario: AC-018-1 Large diffs are reviewed by area -- Given a PR is too large for one reviewer to cover in a pass, When review runs, Then it is split by area (using the sensitive-area and rules boundaries) and every slice is reviewed
    - [ ] Scenario: AC-018-2 Large diffs are reviewed by area -- Given a PR is sliced, When findings are presented, Then they are combined in one sorted list and the report states which slices were reviewed

- [ ] **TRD-018** CLI subcommands `votes`, `depth`, `slices` (`pr-review-cli.js`) [satisfies REQ-005, REQ-016, REQ-018] [Depends: TRD-016, TRD-039, TRD-017] (4h)
  - Validates PRD ACs: AC-005-1, AC-016-1, AC-018-1
  - Implementation AC:
    - [ ] Given JSON on stdin, when `votes|depth|slices` runs, then it delegates to the module and prints JSON, registered in HANDLERS and both usage strings
    - [ ] Given hostile or malformed payloads, when any of them runs, then it never returns a clean pass and the adversarial sweep covers them

- [ ] **TRD-018-TEST** Verification CLI end to end [Verifies TRD-018] [Satisfies REQ-005, REQ-016, REQ-018] [Depends: TRD-018] (3h)
  - Validates PRD ACs: AC-005-1, AC-016-1, AC-018-1
  - Test AC:
    - [ ] Scenario: AC-005-1 Verification before posting -- Given candidate findings exist, When verification runs, Then each finding receives independent votes from verifiers who did not produce it, and a finding is presented to the author only if a majority of its verifiers judge it real; the number of verifiers is 0 at Quick, 3 at Standard and 5 at Deep
    - [ ] Scenario: AC-016-1 Review depth modes -- Given a mode is selected, When review runs, Then the number of reviewers and verifiers does not exceed that mode's bound (Quick: a single reviewer and no verifiers; Standard: at least two reviewers and 3 verifiers; Deep: at least two reviewers and 5 verifiers)
    - [ ] Scenario: AC-018-1 Large diffs are reviewed by area -- Given a PR is too large for one reviewer to cover in a pass, When review runs, Then it is split by area (using the sensitive-area and rules boundaries) and every slice is reviewed

- [ ] **TRD-020** code-reviewer agent: read-only, structured findings, reads rules [satisfies REQ-004, REQ-001] [Depends: TRD-009] (4h)
  - Validates PRD ACs: AC-004-3, AC-004-2
  - Implementation AC:
    - [ ] Given `packages/quality/agents/code-reviewer.yaml`, when updated, then its tool list drops Write and Edit, it reads the applied REVIEW.md files, CLAUDE.md and the constitution, and its mission states it may record or post findings only
    - [ ] Given a review, when the agent reports, then findings use the ledger fields (id, source, location or link, severity tag, failure mode, evidence, original text or link) and the summary starts with a finding count or states plainly that nothing needs fixing
    - [ ] Given the YAML changed, when `npm run generate` runs, then the markdown, Pi and Codex copies are regenerated and the coverage thresholds in the agent match the constitution (60% unit, 50% integration)

- [ ] **TRD-020-TEST** Reviewer is read-only and structured [Verifies TRD-020] [Satisfies REQ-004, REQ-001] [Depends: TRD-020] (3h)
  - Validates PRD ACs: AC-004-3, AC-004-2
  - Test AC:
    - [ ] Scenario: AC-004-3 Multiple fresh-context reviewers -- Given a reviewer or verifier runs, When it completes, Then it has made no change to the repository or to PR state other than recording or posting findings
    - [ ] Scenario: AC-004-2 Multiple fresh-context reviewers -- Given reviewers disagree on whether something is a defect, When findings are collected, Then every candidate finding from every reviewer is recorded with its source

- [ ] **TRD-019** Skill: fresh-context multi-reviewer discovery and area slicing [satisfies REQ-004, REQ-016, REQ-018] [Depends: TRD-018, TRD-020] (4h)
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-018-2, AC-016-1
  - Implementation AC:
    - [ ] Given Standard depth or higher, when the skill reviews, then it dispatches at least two reviewers as subagents given only the diff, the applied rules and repository guidance (never the authoring conversation), and records every candidate finding with its source
    - [ ] Given the mode bounds from `depth`, when the skill dispatches, then it never exceeds the reviewer count for the mode
    - [ ] Given a PR above the slice threshold, when review runs, then it reviews each slice from `slices`, combines findings into one sorted list and reports which slices were reviewed

- [ ] **TRD-019-TEST** Fresh-context reviewers and slices [Verifies TRD-019] [Satisfies REQ-004, REQ-016, REQ-018] [Depends: TRD-019] (3h)
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-018-2, AC-016-1
  - Test AC:
    - [ ] Scenario: AC-004-1 Multiple fresh-context reviewers -- Given a PR is reviewed at Standard depth or higher, When review runs, Then at least two reviewers examine the same diff independently, each without the authoring session's conversation context
    - [ ] Scenario: AC-004-2 Multiple fresh-context reviewers -- Given reviewers disagree on whether something is a defect, When findings are collected, Then every candidate finding from every reviewer is recorded with its source
    - [ ] Scenario: AC-018-2 Large diffs are reviewed by area -- Given a PR is sliced, When findings are presented, Then they are combined in one sorted list and the report states which slices were reviewed
    - [ ] Scenario: AC-016-1 Review depth modes -- Given a mode is selected, When review runs, Then the number of reviewers and verifiers does not exceed that mode's bound (Quick: a single reviewer and no verifiers; Standard: at least two reviewers and 3 verifiers; Deep: at least two reviewers and 5 verifiers)

- [ ] **TRD-040** Skill: verification dispatch, CodeRabbit ingestion and degraded modes [satisfies REQ-005, REQ-006] [Depends: TRD-018, TRD-019, TRD-039] (4h)
  - Validates PRD ACs: AC-005-3, AC-006-4
  - Implementation AC:
    - [ ] Given candidates, when the skill verifies, then it dispatches the depth's verifiers (who did not produce the finding), feeds their votes to `votes`, and presents only `present`, `disputed` and `unverified` findings
    - [ ] Given CodeRabbit findings on the PR, when the skill builds the ledger, then they enter the same ledger and verification, and no CodeRabbit comment is edited, resolved or suppressed
    - [ ] Given a runtime without subagents, when review runs, then a single-pass review runs and the report and state carry a visible reduced-review notice

- [ ] **TRD-040-TEST** Verification dispatch and degraded modes [Verifies TRD-040] [Satisfies REQ-005, REQ-006] [Depends: TRD-040] (3h)
  - Validates PRD ACs: AC-005-3, AC-006-4
  - Test AC:
    - [ ] Scenario: AC-005-3 Verification before posting -- Given CodeRabbit has posted findings on the same PR, When verification runs, Then those findings enter the same ledger and receive the same verification, without CodeRabbit's own comments being edited, resolved or suppressed
    - [ ] Scenario: AC-006-4 Nothing is silently dropped; verification failure is visible -- Given the runtime lacks multi-reviewer capability, When review runs, Then a single-pass review runs and the report carries a visible notice that reduced review was used

- [ ] **TRD-021** Gate-can-fail proofs for the vote threshold [satisfies REQ-025] [Depends: TRD-016, TRD-039] (4h)
  - Validates PRD ACs: AC-025-1, AC-025-2
  - Implementation AC:
    - [ ] Given a mutation guard for `tallyVotes`, when the majority comparison is changed to always pass, then the contract test that expects a rejected finding to be `filtered` fails
    - [ ] Given a second case, when a critical finding is rejected by votes, then it must still be `disputed`; the mutant that drops the critical bypass fails that test

- [ ] **TRD-021-TEST** Vote gate fails when broken [Verifies TRD-021] [Satisfies REQ-025] [Depends: TRD-021] (3h)
  - Validates PRD ACs: AC-025-1, AC-025-2
  - Test AC:
    - [ ] Scenario: AC-025-1 Every new gate can fail -- Given each of the verification threshold, the round cap, the tier floor, commit-bound approval, the blocking security lane and the finding-answered merge block, When it is deliberately broken (for example a threshold set to always pass), Then its check fails
    - [ ] Scenario: AC-025-2 Every new gate can fail -- Given a gate's check passes only in a trivial case, When it is reviewed, Then a second case that must be refused is included and refused

- [ ] **TRD-022** PR 3 packaging, mirrors, generation and docs [satisfies ARCH] [Depends: TRD-019, TRD-020, TRD-021, TRD-039, TRD-040] (3h)
  - Implementation AC:
    - [ ] Given PR 3 changes, when packaging runs, then symlinks, vendor bundle counts, generated artifacts (code-reviewer md/toml) and version files for development and quality are refreshed and validation passes
    - [ ] Given verified review, when docs are updated, then the README and CHANGELOG describe depth modes and the vote thresholds

### PR 4: Risk Tiers, Approvals and Merge Gate
**Shippable State:** Every PR gets a recorded risk tier (sensitive areas are High; Low is treated as Medium until evidence exists); `/ensemble:pr-merge` refuses to merge until human approvals bound to the current commit meet the tier, open Important and security findings are answered, and a bot approval never counts.

- [ ] **TRD-023** Tier assignment: change kinds, sensitive floor and raise-only (`pr-review-tier.js`) [satisfies REQ-012, REQ-013, REQ-015] [Depends: TRD-001, TRD-002] (4h)
  - Validates PRD ACs: AC-012-1, AC-012-2, AC-012-3, AC-013-2, AC-013-3
  - Implementation AC:
    - [ ] Given classifier output `kinds[{ kind, paths[] }]` with kind in {docs, copy, additive-behind-flag, product, other} and path classification, when `assignTier` runs, then all-low kinds give Low, ordinary product changes Medium, and any sensitive or owner-listed High path gives High; a missing, unknown or uncited kind is treated as `other` (Medium); identical facts give an identical tier regardless of author
    - [ ] Given a second assessment `{ needsAnotherPerson, reason, evidencePaths[] }`, when `assignTier` runs, then exactly `true` raises the tier one level, `false` leaves it, and any other value is treated as `true` (fail toward more review)
    - [ ] Given a proposed tier lower than the computed one, when it runs, then the proposal is ignored; only a code-owner decision (supplied as CODEOWNERS-checked input) can lower it

- [ ] **TRD-023-TEST** Tier from change and floor [Verifies TRD-023] [Satisfies REQ-012, REQ-013, REQ-015] [Depends: TRD-023] (4h)
  - Validates PRD ACs: AC-012-1, AC-012-2, AC-012-3, AC-013-2, AC-013-3
  - Test AC:
    - [ ] Scenario: AC-012-1 Change-driven risk tier -- Given a PR, When review begins, Then a tier is assigned from the kind of change: Low for documentation, copy and additive changes behind a flag; Medium for ordinary product changes; High for sensitive areas (REQ-003) and any path an owner has listed as High
    - [ ] Scenario: AC-012-2 Change-driven risk tier -- Given two PRs with identical changes from different authors, When tiers are assigned, Then they receive the same tier
    - [ ] Scenario: AC-012-3 Change-driven risk tier -- Given a second assessment indicates a Low or Medium PR nonetheless needs another person, When it is evaluated, Then the tier is raised
    - [ ] Scenario: AC-013-2 Strict by default, raise-only, protected floor -- Given an agent or the author proposes a tier, When it is lower than the assigned tier, Then it is ignored; only a code owner can lower a tier
    - [ ] Scenario: AC-013-3 Strict by default, raise-only, protected floor -- Given a PR touches a sensitive area (REQ-003), When its tier is set, Then the tier is High and two humans are required, regardless of what the classifier concluded

- [ ] **TRD-041** Low-waiver evidence, effective tier and recorded decision (`pr-review-tier.js`) [satisfies REQ-013, REQ-015] [Depends: TRD-023] (4h)
  - Validates PRD ACs: AC-013-1, AC-013-4, AC-015-1, AC-015-2
  - Implementation AC:
    - [ ] Given a Low result and fewer than 20 Low PRs over 30 days with zero reverts and incidents, or the waiver not enabled by an owner, when `effectiveTier` runs, then the effective tier is Medium; given the evidence, owner enablement and a maintainer author, then Low means no human required, and any other author stays at one human
    - [ ] Given tier relaxation attempted without the recorded evidence, when approval is evaluated, then it is refused
    - [ ] Given an assignment, when the result is returned, then it contains tier, effective tier, the characteristics and paths that drove it, who or what assigned it, and original and final tier for every raise

- [ ] **TRD-041-TEST** Low waiver and recorded tier [Verifies TRD-041] [Satisfies REQ-013, REQ-015] [Depends: TRD-041] (3h)
  - Validates PRD ACs: AC-013-1, AC-013-4, AC-015-1, AC-015-2
  - Test AC:
    - [ ] Scenario: AC-013-1 Strict by default, raise-only, protected floor -- Given fewer than 20 Low-tier PRs over 30 days have merged with zero reverts and zero incidents, When a Low PR is evaluated, Then it is treated as Medium and requires one human approval; once that evidence exists and a code owner explicitly enables it, Low means "no human required"
    - [ ] Scenario: AC-013-4 Strict by default, raise-only, protected floor -- Given tier relaxation is attempted without the recorded evidence, When approval is evaluated, Then it is refused
    - [ ] Scenario: AC-015-1 Tier decision is recorded -- Given a tier is assigned, When the PR's review state is read, Then it contains the tier, the characteristics that drove it, and who or what assigned it
    - [ ] Scenario: AC-015-2 Tier decision is recorded -- Given a tier was raised by a sensitive path or a second assessment, When the record is read, Then it shows the original and final tier and the reason

- [ ] **TRD-024** Approval evaluator (`pr-review-approvals.js`) [satisfies REQ-014] [Depends: TRD-023, TRD-041] (6h)
  - Validates PRD ACs: AC-014-1, AC-014-2, AC-014-3, AC-014-4, AC-014-5
  - Implementation AC:
    - [ ] Given reviews, a head SHA and tree, a tier and the policy bot list, when `evaluateApprovals` runs, then approvals by a configured bot login or a platform-marked bot are returned in `ignored[]` with reason `automated` and never count
    - [ ] Given an approval bound to a commit other than the head whose tree differs from the head tree, when it runs, then it no longer counts (reason `stale-commit`); an approval whose commit tree equals the head tree still counts
    - [ ] Given an agent-authored PR with a `directedBy` person, when it runs, then that person fills one required human slot; Medium needs one human, High two distinct people, and an effective-Low PR needs none
    - [ ] Given the Low waiver is enabled, when the author is not a repository maintainer, then one human is still required

- [ ] **TRD-024-TEST** Commit-bound human approvals [Verifies TRD-024] [Satisfies REQ-014] [Depends: TRD-024] (6h)
  - Validates PRD ACs: AC-014-1, AC-014-2, AC-014-3, AC-014-4, AC-014-5
  - Test AC:
    - [ ] Scenario: AC-014-1 Human approval means a person, on a specific commit -- Given an approval is recorded by an agent or automated account, When approval requirements are evaluated, Then it does not count toward any required human approval; an account is automated if the repository's configured bot/agent list names it or the platform marks it as a bot
    - [ ] Scenario: AC-014-2 Human approval means a person, on a specific commit -- Given an approval was given, When new commits are pushed that the system cannot vouch for, Then the approval no longer counts and approval is requested again
    - [ ] Scenario: AC-014-3 Human approval means a person, on a specific commit -- Given an agent authored a PR on a person's instruction, When approvals are counted, Then that person counts as one of the required reviewers, as if they had written the code themselves
    - [ ] Scenario: AC-014-4 Human approval means a person, on a specific commit -- Given a High-tier PR, When approvals are counted, Then two distinct people are required
    - [ ] Scenario: AC-014-5 Human approval means a person, on a specific commit -- Given the Low-tier waiver has been enabled (REQ-013), When a PR is evaluated, Then the waiver applies only to PRs authored by repository maintainers; every other author's Low PR still requires one human approval

- [ ] **TRD-025** Merge gate with answered findings and security lane (`pr-review-gate.js`) [satisfies REQ-008, REQ-017, REQ-002] [Depends: TRD-009, TRD-016, TRD-024, TRD-004] (7h)
  - Validates PRD ACs: AC-008-1, AC-008-4, AC-017-1, AC-017-2, AC-017-3, AC-002-3
  - Implementation AC:
    - [ ] Given a ledger, approvals result, tier and PR description check, when `evaluateGate` runs, then `mergeable` is true only when no Important finding is open (including every open security-lane finding), approvals are satisfied, and no description section is missing; each blocker is returned with a code and the finding or section named
    - [ ] Given Nit and Pre-existing findings only, when it runs, then they do not block
    - [ ] Given a security-lane finding closed with a reason, when it runs, then the reason is required and recorded; given a later head that fixes it, then it clears; given a lane result of `not-run`, then the gate reports `security-review-missing` for Medium and High tiers
    - [ ] Given missing or unavailable review data (gh unreachable, rate-limited, or a required field absent), when `evaluateGate` runs, then `mergeable` is false with blocker `review-data-unavailable` naming what is missing, and every blocker carries a `nextAction` (re-run, grant access, supply the input); it never passes on missing data

- [ ] **TRD-025-TEST** Merge gate blockers [Verifies TRD-025] [Satisfies REQ-008, REQ-017, REQ-002] [Depends: TRD-025] (6h)
  - Validates PRD ACs: AC-008-1, AC-008-4, AC-017-1, AC-017-2, AC-017-3, AC-002-3
  - Test AC:
    - [ ] Scenario: AC-008-1 Every finding is answered before merge -- Given an Important finding is open, When merge is attempted, Then it is refused and names the open finding
    - [ ] Scenario: AC-008-4 Every finding is answered before merge -- Given a finding is Nit or Pre-existing, When merge is attempted, Then it does not block
    - [ ] Scenario: AC-017-1 Blocking security review lane -- Given a PR is reviewed, When the security review finds an issue, Then merge is blocked until it is fixed or closed with a stated reason
    - [ ] Scenario: AC-017-2 Blocking security review lane -- Given a later commit fixes the issue, When re-review runs, Then the security finding clears on its own
    - [ ] Scenario: AC-017-3 Blocking security review lane -- Given a security finding is a false positive, When the author closes it with a reason, Then the reason is recorded in the ledger
    - [ ] Scenario: AC-002-3 PR description captures testing, risk and rollback -- Given a PR description is missing any of the three sections, When its review status is computed, Then the PR is reported as not ready for approval and names the missing section

- [ ] **TRD-026** CLI subcommands `tier`, `approvals`, `gate` and tier record in the review-state report [satisfies REQ-015] [Depends: TRD-023, TRD-024, TRD-025, TRD-041] (4h)
  - Validates PRD ACs: AC-015-1, AC-015-2
  - Implementation AC:
    - [ ] Given JSON on stdin, when `tier|approvals|gate` runs, then it delegates to the module and prints JSON, registered in HANDLERS and both usage strings, and hostile payloads never produce a clean pass
    - [ ] Given a tier result, when `state-write` runs, then the report stores tier, reasons, original and final tier under the untracked `.ensemble/pr-review/` path and `state-read` returns them for the same head

- [ ] **TRD-026-TEST** Tier and gate CLI with recorded decision [Verifies TRD-026] [Satisfies REQ-015] [Depends: TRD-026] (3h)
  - Validates PRD ACs: AC-015-1, AC-015-2
  - Test AC:
    - [ ] Scenario: AC-015-1 Tier decision is recorded -- Given a tier is assigned, When the PR's review state is read, Then it contains the tier, the characteristics that drove it, and who or what assigned it
    - [ ] Scenario: AC-015-2 Tier decision is recorded -- Given a tier was raised by a sensitive path or a second assessment, When the record is read, Then it shows the original and final tier and the reason

- [ ] **TRD-027** pr-merge and skill integration: MODE=gate, classifier, second assessment, security lane [satisfies REQ-012, REQ-013, REQ-014, REQ-017, REQ-008] [Depends: TRD-026, TRD-019, TRD-040] (7h)
  - Validates PRD ACs: AC-012-3, AC-013-2, AC-014-3, AC-017-1, AC-008-1
  - Implementation AC:
    - [ ] Given the pr-review-cycle skill, when `MODE=gate` runs, then it classifies change kinds, runs the second "needs another person" assessment, runs the security lane reviewer, reads approvals and reviews from `gh`, and returns `evaluateGate` output; callers reference the skill only
    - [ ] Given `pr-merge.yaml`, when it reaches its merge step, then it requires `mergeable:true` from the gate in addition to the existing checks and reviewDecision conditions, re-reads GitHub state fresh, and never counts a self-report
    - [ ] Given the repository lacks branch protection for the required approvals, when pr-merge runs, then it reports that server-side enforcement is absent and recommends it (ensemble cannot enforce it)
    - [ ] Given a `gh` read fails, when the skill runs `MODE=gate`, then it retries that read once within the same run (no waiting loop, no scheduling), and if it still fails reports `review-data-unavailable` with the recovery action
    - [ ] Given the classifier and the second assessment, when the skill runs them, then each is a fresh-context subagent using the editable prompts in the skill and returns exactly the contract `assignTier` expects (closed kind enum with cited paths; `needsAnotherPerson` boolean with reason and evidence paths)

- [ ] **TRD-027-TEST** pr-merge refuses an unready PR [Verifies TRD-027] [Satisfies REQ-012, REQ-013, REQ-014, REQ-017, REQ-008] [Depends: TRD-027] (6h)
  - Validates PRD ACs: AC-012-3, AC-013-2, AC-014-3, AC-017-1, AC-008-1
  - Test AC:
    - [ ] Scenario: AC-012-3 Change-driven risk tier -- Given a second assessment indicates a Low or Medium PR nonetheless needs another person, When it is evaluated, Then the tier is raised
    - [ ] Scenario: AC-013-2 Strict by default, raise-only, protected floor -- Given an agent or the author proposes a tier, When it is lower than the assigned tier, Then it is ignored; only a code owner can lower a tier
    - [ ] Scenario: AC-014-3 Human approval means a person, on a specific commit -- Given an agent authored a PR on a person's instruction, When approvals are counted, Then that person counts as one of the required reviewers, as if they had written the code themselves
    - [ ] Scenario: AC-017-1 Blocking security review lane -- Given a PR is reviewed, When the security review finds an issue, Then merge is blocked until it is fixed or closed with a stated reason
    - [ ] Scenario: AC-008-1 Every finding is answered before merge -- Given an Important finding is open, When merge is attempted, Then it is refused and names the open finding

- [ ] **TRD-028** Gate-can-fail proofs for tier floor, approval binding, security block and answered findings [satisfies REQ-025] [Depends: TRD-023, TRD-024, TRD-025, TRD-041] (5h)
  - Validates PRD ACs: AC-025-1, AC-025-2
  - Implementation AC:
    - [ ] Given guards for `assignTier`, `evaluateApprovals` and `evaluateGate`, when the sensitive-path floor, the bot filter, the commit/tree comparison, the security block and the open-Important block are each mutated to pass, then the matching contract test fails and no other
    - [ ] Given each guard, when a refusable case is included, then it is refused: a sensitive path classified Low, a bot approval, a stale approval, an open security finding

- [ ] **TRD-028-TEST** Tier, approval and merge gates fail when broken [Verifies TRD-028] [Satisfies REQ-025] [Depends: TRD-028] (4h)
  - Validates PRD ACs: AC-025-1, AC-025-2
  - Test AC:
    - [ ] Scenario: AC-025-1 Every new gate can fail -- Given each of the verification threshold, the round cap, the tier floor, commit-bound approval, the blocking security lane and the finding-answered merge block, When it is deliberately broken (for example a threshold set to always pass), Then its check fails
    - [ ] Scenario: AC-025-2 Every new gate can fail -- Given a gate's check passes only in a trivial case, When it is reviewed, Then a second case that must be refused is included and refused

- [ ] **TRD-029** PR 4 packaging, mirrors, generation and docs [satisfies ARCH] [Depends: TRD-027, TRD-028] (3h)
  - Implementation AC:
    - [ ] Given PR 4 changes, when packaging runs, then symlinks, vendor bundle, generated pr-merge artifacts for Claude, Pi, Codex and OpenCode, and version files for development, git and full are refreshed and validation passes
    - [ ] Given tiers and approvals, when docs are updated, then the README, CHANGELOG and a short branch-protection recommendation describe the policy keys and the strict default

### PR 5: Review Metrics and Reviewer Eval Set
**Shippable State:** A maintainer can compute review metrics and a baseline-versus-post-change comparison with a revert and incident guardrail, and score the reviewer against an owner-confirmed incident eval set that flags regressions.

- [ ] **TRD-030** Per-cohort review metrics (`pr-review-metrics.js`) [satisfies REQ-019] [Depends: TRD-009, TRD-044] (4h)
  - Validates PRD ACs: AC-019-1, AC-019-2
  - Implementation AC:
    - [ ] Given arrays of merged-PR data (reviews with commit ids and bot flags, commits, review requests, finding responses), when `computeMetrics` runs, then it returns human approvals per PR (median and p95), human comments, wait-on-human hours, rounds-to-pass and the share needing five or more rounds, counting only non-bot reviewers
    - [ ] Given finding responses classified as fixed, wrong, intentional or unimportant, when `computeMetrics` runs, then noise rate is (wrong + intentional + unimportant) / presented
    - [ ] Given the committed baseline result file from TRD-044 and the same inputs, when `computeMetrics` runs, then it reproduces the baseline numbers exactly, so the library is checked against the runbook

- [ ] **TRD-030-TEST** Cohort metrics [Verifies TRD-030] [Satisfies REQ-019] [Depends: TRD-030] (3h)
  - Validates PRD ACs: AC-019-1, AC-019-2
  - Test AC:
    - [ ] Scenario: AC-019-1 Review metrics with a revert and incident guardrail -- Given a cohort of merged PRs, When metrics are produced, Then they include human approvals per PR (median and p95), human comments, wait-on-human time, rounds-to-pass, and the share of PRs needing five or more rounds
    - [ ] Scenario: AC-019-2 Review metrics with a revert and incident guardrail -- Given findings were presented, When metrics are produced, Then each is classified by how the author responded (fixed, said wrong, said intentional, judged unimportant) and a noise rate is reported

- [ ] **TRD-042** Cohort comparison and revert/incident guardrail (`pr-review-metrics.js`) [satisfies REQ-019] [Depends: TRD-030] (4h)
  - Validates PRD ACs: AC-019-3, AC-019-4
  - Implementation AC:
    - [ ] Given baseline and post-change cohorts, when `compareCohorts` runs, then cohorts under 20 PRs or 30 days are rejected as insufficient and targets are evaluated relative to baseline (rounds-to-pass at least 30% lower, 5+ round PRs at least 50% lower, noise at least 30% lower, human approvals and p95 wait lower)
    - [ ] Given any increase in reverts or incidents over baseline, when `compareCohorts` runs, then the cohort is `guardrail: failed` regardless of other results
    - [ ] Given PR records that carry a tier, when metrics are computed, then a per-tier breakdown is included; records without a tier are grouped as untiered and nothing fails

- [ ] **TRD-042-TEST** Cohort comparison and guardrail [Verifies TRD-042] [Satisfies REQ-019] [Depends: TRD-042] (3h)
  - Validates PRD ACs: AC-019-3, AC-019-4
  - Test AC:
    - [ ] Scenario: AC-019-3 Review metrics with a revert and incident guardrail -- Given a post-change cohort and the baseline cohort, each of at least 20 PRs and at least 30 days, When compared, Then targets are expressed relative to baseline: median human approvals and p95 human wait down, rounds-to-pass down by at least 30%, PRs needing five or more rounds down by at least 50%, and noise rate down by at least 30%
    - [ ] Scenario: AC-019-4 Review metrics with a revert and incident guardrail -- Given the metrics are reported, When revert or incident counts for the cohort exceed baseline, Then the report marks the cohort as failing the guardrail regardless of other results

- [ ] **TRD-031** Eval-set scorer and staleness (`pr-review-eval.js`) [satisfies REQ-020] [Depends: TRD-001, TRD-003] (6h)
  - Validates PRD ACs: AC-020-1, AC-020-2, AC-020-3
  - Implementation AC:
    - [ ] Given an eval case (change reference, bug description, bug location, code owner confirmation, rules file and its hash), when `validateCase` runs, then a case without owner confirmation by a CODEOWNERS owner of the affected path is rejected
    - [ ] Given the reviewer's findings per case, when `scoreEval` runs, then a case counts as found only when an Important finding overlaps the recorded bug location, and the run reports per-case results and a total
    - [ ] Given two runs, when `compareEval` runs, then a lower total than the previous run is flagged `regression` naming the cases that flipped; given a changed rules-file hash, when `staleCases` runs, then the affected cases are returned for owner re-review
    - [ ] Given the policy `evalCasesDir` (default `docs/review-eval/cases`), when cases are validated, then each `<id>.json` under that directory is checked and a case outside it is not loaded

- [ ] **TRD-031-TEST** Reviewer eval set [Verifies TRD-031] [Satisfies REQ-020] [Depends: TRD-031] (5h)
  - Validates PRD ACs: AC-020-1, AC-020-2, AC-020-3
  - Test AC:
    - [ ] Scenario: AC-020-1 Incident-driven reviewer eval set -- Given a PR that caused an incident or revert, When it is added to the eval set, Then it records the change, the bug and where the bug lived, and is confirmed by the code owner of the affected area; the case is re-reviewed whenever that area's review rules change
    - [ ] Scenario: AC-020-2 Incident-driven reviewer eval set -- Given the reviewer's rules, prompts or model change, When the eval set is run, Then each case is scored for whether the reviewer found the bug, and the result is reported
    - [ ] Scenario: AC-020-3 Incident-driven reviewer eval set -- Given a reviewer change lowers the eval score, When results are compared to the previous run, Then the change is flagged as a regression

- [ ] **TRD-032** CLI subcommands `metrics`, `metrics-compare`, `eval-score`, `eval-compare`, `eval-stale` and the metrics guide [satisfies REQ-019, REQ-020] [Depends: TRD-030, TRD-042, TRD-031] (5h)
  - Validates PRD ACs: AC-019-3, AC-019-4, AC-020-2
  - Implementation AC:
    - [ ] Given JSON on stdin, when each new subcommand runs, then it delegates to its module and prints JSON, registered in HANDLERS and both usage strings, and hostile payloads never produce a clean pass
    - [ ] Given `docs/guides/pr-review-metrics.md`, when a maintainer follows it, then it lists the `gh` queries that produce the module inputs (reviews with commit ids, review requests, threads, revert and incident lists), the baseline-capture procedure and the cohort rule (at least 20 PRs and 30 days), extending the existing pilot guide rather than duplicating it

- [ ] **TRD-032-TEST** Metrics and eval CLI end to end [Verifies TRD-032] [Satisfies REQ-019, REQ-020] [Depends: TRD-032] (3h)
  - Validates PRD ACs: AC-019-3, AC-019-4, AC-020-2
  - Test AC:
    - [ ] Scenario: AC-019-3 Review metrics with a revert and incident guardrail -- Given a post-change cohort and the baseline cohort, each of at least 20 PRs and at least 30 days, When compared, Then targets are expressed relative to baseline: median human approvals and p95 human wait down, rounds-to-pass down by at least 30%, PRs needing five or more rounds down by at least 50%, and noise rate down by at least 30%
    - [ ] Scenario: AC-019-4 Review metrics with a revert and incident guardrail -- Given the metrics are reported, When revert or incident counts for the cohort exceed baseline, Then the report marks the cohort as failing the guardrail regardless of other results
    - [ ] Scenario: AC-020-2 Incident-driven reviewer eval set -- Given the reviewer's rules, prompts or model change, When the eval set is run, Then each case is scored for whether the reviewer found the bug, and the result is reported

- [ ] **TRD-033** Eval procedure skill (`pr-review-eval`) and case template [satisfies REQ-020] [Depends: TRD-032] (4h)
  - Validates PRD ACs: AC-020-1, AC-020-2
  - Implementation AC:
    - [ ] Given the skill, when a maintainer adds an incident or revert case, then it walks them through the case record and the code-owner confirmation and writes `docs/review-eval/cases/<id>.json` (or the configured `evalCasesDir`)
    - [ ] Given the reviewer's rules, prompts or model change, when the skill runs the eval, then it runs the reviewer on each case, calls `eval-score` and `eval-compare` and reports regressions; recurrence is left to the host repository (Rule 4)

- [ ] **TRD-033-TEST** Eval skill adds and runs cases [Verifies TRD-033] [Satisfies REQ-020] [Depends: TRD-033] (3h)
  - Validates PRD ACs: AC-020-1, AC-020-2
  - Test AC:
    - [ ] Scenario: AC-020-1 Incident-driven reviewer eval set -- Given a PR that caused an incident or revert, When it is added to the eval set, Then it records the change, the bug and where the bug lived, and is confirmed by the code owner of the affected area; the case is re-reviewed whenever that area's review rules change
    - [ ] Scenario: AC-020-2 Incident-driven reviewer eval set -- Given the reviewer's rules, prompts or model change, When the eval set is run, Then each case is scored for whether the reviewer found the bug, and the result is reported

- [ ] **TRD-034** PR 5 packaging, mirrors, generation and docs [satisfies ARCH] [Depends: TRD-032, TRD-033] (3h)
  - Implementation AC:
    - [ ] Given PR 5 changes, when packaging runs, then symlinks for the new libs and the new skill, the pi skill copy, vendor counts and version files are refreshed and validation passes
    - [ ] Given metrics and eval, when docs are updated, then the README and CHANGELOG describe them and the baseline-capture entry criterion

### PR 6: Sweeps, Explainers and Cross-Runtime Reachability
**Shippable State:** A maintainer or host automation can run an on-demand sweep of existing code (a weekly host workflow template is provided), request module explainers (offered on High-tier PRs), and every new capability is proven reachable from fix-issue, implement-trd-beads and pr-merge on Claude Code, Pi, Codex and OpenCode.

- [ ] **TRD-035** Sweep skill (`pr-review-sweep`) and host workflow template [satisfies REQ-021] [Depends: TRD-019, TRD-040, TRD-001] (6h)
  - Validates PRD ACs: AC-021-1, AC-021-2
  - Implementation AC:
    - [ ] Given a request from a maintainer or host automation, when the sweep skill runs, then it reviews existing code, sensitive areas first, using the same reviewers and verification, and tags every finding Pre-existing
    - [ ] Given init-project, when the user opts in, then it can scaffold a weekly sweep workflow template into the host repository; ensemble's own `.github/workflows` contain no `schedule` trigger
    - [ ] Given the template requires agent credentials, when documented, then the guide states it is opt-in and the core review needs no new CI secret

- [ ] **TRD-035-TEST** On-demand sweeps without an ensemble scheduler [Verifies TRD-035] [Satisfies REQ-021] [Depends: TRD-035] (4h)
  - Validates PRD ACs: AC-021-1, AC-021-2
  - Test AC:
    - [ ] Scenario: AC-021-1 On-demand sweeps of existing code -- Given a maintainer or the host repository's automation requests a sweep, When it runs, Then reviewers examine existing code and report findings with the Pre-existing tag
    - [ ] Scenario: AC-021-2 On-demand sweeps of existing code -- Given ensemble is installed, When no external trigger fires, Then ensemble itself runs no recurring job (Constitution Rule 4); recurrence is the host repository's or Foreman's responsibility, with a recommended cadence of weekly and sensitive areas (REQ-003) swept first

- [ ] **TRD-036** Explainer skill (`pr-review-explainer`) and High-tier offer [satisfies REQ-022] [Depends: TRD-013] (5h)
  - Validates PRD ACs: AC-022-1, AC-022-2
  - Implementation AC:
    - [ ] Given a named module, when the skill runs, then it produces an explainer from the current code that names the files it was derived from
    - [ ] Given the request is for a module with no readable source, when the skill runs, then it says so and produces no explainer

- [ ] **TRD-036-TEST** Explainers on request [Verifies TRD-036] [Satisfies REQ-022] [Depends: TRD-036] (3h)
  - Validates PRD ACs: AC-022-1, AC-022-2
  - Test AC:
    - [ ] Scenario: AC-022-1 Explainers for context sharing -- Given a maintainer requests an explainer for a named module, When it is produced, Then it reflects the code as it is now and is delivered within minutes
    - [ ] Scenario: AC-022-2 Explainers for context sharing -- Given an explainer is produced, When it is read, Then it names the files it was derived from

- [ ] **TRD-043** High-tier explainer offer in the review report [satisfies REQ-022] [Depends: TRD-036, TRD-041] (2h)
  - Validates PRD ACs: AC-022-3
  - Implementation AC:
    - [ ] Given a High-tier PR, when the review report is produced, then it offers an explainer for each touched sensitive module and generates one only when requested
    - [ ] Given a PR that is not High tier, when the report is produced, then no explainer is offered

- [ ] **TRD-043-TEST** High-tier explainer offer [Verifies TRD-043] [Satisfies REQ-022] [Depends: TRD-043] (2h)
  - Validates PRD ACs: AC-022-3
  - Test AC:
    - [ ] Scenario: AC-022-3 Explainers for context sharing -- Given a PR is High tier, When its review report is produced, Then it offers an explainer for each touched sensitive module, and an explainer is generated only if requested

- [ ] **TRD-037** Cross-runtime reachability and no-new-secrets proof [satisfies REQ-023, REQ-024] [Depends: TRD-027, TRD-035, TRD-036, TRD-043] (7h)
  - Validates PRD ACs: AC-023-1, AC-023-2, AC-023-3, AC-024-2
  - Implementation AC:
    - [ ] Given `fix-issue`, `implement-trd-beads` and `pr-merge`, when each is traced from its entry command text through the skill to the CLI subcommands, then the verified-findings, convergence and tier behavior are reached (assert through the entry point, not around it)
    - [ ] Given the Claude, Pi, Codex and OpenCode generated artifacts, when compared, then the same procedures and subcommands are present or the report states what is reduced
    - [ ] Given no hosted reviewer configured and no new CI secret, when the in-agent review runs, then it completes; given credential-like text in findings across every new lib, then it is redacted

- [ ] **TRD-037-TEST** Capabilities reachable on every runtime [Verifies TRD-037] [Satisfies REQ-023, REQ-024] [Depends: TRD-037] (6h)
  - Validates PRD ACs: AC-023-1, AC-023-2, AC-023-3, AC-024-2
  - Test AC:
    - [ ] Scenario: AC-023-1 Reachable from the real entry points, on all runtimes -- Given `fix-issue`, `implement-trd-beads` or `pr-merge` reaches its review step, When it runs, Then it exercises the verified-findings, convergence and tier behavior (not just unit-tested code that nothing calls)
    - [ ] Scenario: AC-023-2 Reachable from the real entry points, on all runtimes -- Given the capability is installed for Claude Code, Pi, Codex and OpenCode, When a review runs on each, Then the behavior is equivalent or the report states what was reduced (REQ-006)
    - [ ] Scenario: AC-023-3 Reachable from the real entry points, on all runtimes -- Given the review depends on repository automation that is not configured (for example a disabled hosted reviewer), When review runs, Then the in-agent review still runs and no new CI secret is required
    - [ ] Scenario: AC-024-2 PR content is untrusted; no secrets -- Given a reviewer or verifier encounters a credential or token, When findings are reported, Then the secret value is not reproduced in any finding, comment or ledger entry

- [ ] **TRD-038** Final docs, changelog, user guide and version bumps [satisfies ARCH] [Depends: TRD-037] (3h)
  - Implementation AC:
    - [ ] Given all six PRs, when docs are finalized, then the user guide has a code-review-process chapter (REVIEW.md, policy block, tiers, approvals, metrics, eval, sweeps, explainers) and the wiki staging note is added per AGENTS.md
    - [ ] Given the release, when versions are bumped, then package.json, `.claude-plugin/plugin.json`, marketplace and sync files agree for every touched package and `npm run validate` passes

## Sprint Planning

Informational only; `implement-trd-beads` does not parse this section. Hours are task estimates including paired BDD test tasks. PRs 5 and 6 depend on earlier PRs only for inputs (see Dependencies), so their library and skill work can start alongside PR 3 and PR 4; only the tier-dependent wiring (TRD-043) and the reachability proof (TRD-037) wait for PR 4.

## Sprint 1: PR 1 Review Guidance, Sensitivity and Policy (67h)

- PR 1: TRD-001, TRD-002, TRD-003, TRD-004, TRD-005, TRD-006, TRD-007, TRD-044, TRD-008

## Sprint 2: PR 2 Severity Taxonomy and Convergence (62h)

- PR 2: TRD-009, TRD-010, TRD-011, TRD-012, TRD-013, TRD-014, TRD-015

## Sprint 3: PR 3 Verified Findings, Depth and Scale (61h)

- PR 3: TRD-016, TRD-039, TRD-017, TRD-018, TRD-020, TRD-019, TRD-040, TRD-021, TRD-022

## Sprint 4: PR 4 Risk Tiers, Approvals and Merge Gate (72h)

- PR 4: TRD-023, TRD-041, TRD-024, TRD-025, TRD-026, TRD-027, TRD-028, TRD-029

## Sprint 5: PR 5 Review Metrics and Reviewer Eval Set and PR 6 Sweeps, Explainers and Cross-Runtime Reachability (81h)

- PR 5: TRD-030, TRD-042, TRD-031, TRD-032, TRD-033, TRD-034
- PR 6: TRD-035, TRD-036, TRD-043, TRD-037, TRD-038

PRD clusters map to PRs: cluster 1 (guidance, severity, convergence) = PR 1 and PR 2; cluster 2 (verified findings, depth, scale) = PR 3; cluster 3 (tiers, approvals, security lane) = PR 4; cluster 4 (metrics, eval) = PR 5; cluster 5 (sweeps, explainers) = PR 6. Each PR leaves the repository passing and shippable. Entry criteria still apply: PRD-2026-82b6a138 must be finished first, and the baseline metrics cohort is captured by TRD-044 (PR 1) before PR 2 lands.

## Acceptance Criteria Traceability

| REQ-NNN | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Area-specific review rules (Must) | TRD-002, TRD-003, TRD-005, TRD-006, TRD-007, TRD-020 | TRD-002-TEST, TRD-003-TEST, TRD-005-TEST, TRD-006-TEST, TRD-007-TEST, TRD-020-TEST |
| REQ-002 | PR description captures testing, risk and rollback (Must) | TRD-004, TRD-005, TRD-006, TRD-007, TRD-025 | TRD-004-TEST, TRD-005-TEST, TRD-006-TEST, TRD-007-TEST, TRD-025-TEST |
| REQ-003 | Owner-declared sensitive areas (Must) | TRD-001, TRD-005, TRD-007 | TRD-001-TEST, TRD-005-TEST, TRD-007-TEST |
| REQ-004 | Multiple fresh-context reviewers (Must) | TRD-020, TRD-019 | TRD-020-TEST, TRD-019-TEST |
| REQ-005 | Verification before posting (Must) | TRD-016, TRD-039, TRD-018, TRD-040 | TRD-016-TEST, TRD-039-TEST, TRD-018-TEST, TRD-040-TEST |
| REQ-006 | Nothing is silently dropped; verification failure is visible (Must) | TRD-016, TRD-039, TRD-040 | TRD-016-TEST, TRD-039-TEST, TRD-040-TEST |
| REQ-007 | Severity taxonomy with Pre-existing (Must) | TRD-009, TRD-013 | TRD-009-TEST, TRD-013-TEST |
| REQ-008 | Every finding is answered before merge (Must) | TRD-009, TRD-025, TRD-027 | TRD-009-TEST, TRD-025-TEST, TRD-027-TEST |
| REQ-009 | One round policy for every review procedure (Must) | TRD-002, TRD-012, TRD-013 | TRD-002-TEST, TRD-012-TEST, TRD-013-TEST |
| REQ-010 | Diff-only re-review and no repeats (Must) | TRD-010, TRD-011, TRD-013 | TRD-010-TEST, TRD-011-TEST, TRD-013-TEST |
| REQ-011 | Class-of-bug flagging (Must) | TRD-010, TRD-013 | TRD-010-TEST, TRD-013-TEST |
| REQ-012 | Change-driven risk tier (Must) | TRD-023, TRD-027 | TRD-023-TEST, TRD-027-TEST |
| REQ-013 | Strict by default, raise-only, protected floor (Must) | TRD-023, TRD-041, TRD-027 | TRD-023-TEST, TRD-041-TEST, TRD-027-TEST |
| REQ-014 | Human approval means a person, on a specific commit (Must) | TRD-024, TRD-027 | TRD-024-TEST, TRD-027-TEST |
| REQ-015 | Tier decision is recorded (Must) | TRD-023, TRD-041, TRD-026 | TRD-023-TEST, TRD-041-TEST, TRD-026-TEST |
| REQ-016 | Review depth modes (Should) | TRD-002, TRD-017, TRD-018, TRD-019 | TRD-002-TEST, TRD-017-TEST, TRD-018-TEST, TRD-019-TEST |
| REQ-017 | Blocking security review lane (Should) | TRD-025, TRD-027 | TRD-025-TEST, TRD-027-TEST |
| REQ-018 | Large diffs are reviewed by area (Should) | TRD-017, TRD-018, TRD-019 | TRD-017-TEST, TRD-018-TEST, TRD-019-TEST |
| REQ-019 | Review metrics with a revert and incident guardrail (Must) | TRD-044, TRD-030, TRD-042, TRD-032 | TRD-044-TEST, TRD-030-TEST, TRD-042-TEST, TRD-032-TEST |
| REQ-020 | Incident-driven reviewer eval set (Should) | TRD-031, TRD-032, TRD-033 | TRD-031-TEST, TRD-032-TEST, TRD-033-TEST |
| REQ-021 | On-demand sweeps of existing code (Should) | TRD-035 | TRD-035-TEST |
| REQ-022 | Explainers for context sharing (Should) | TRD-036, TRD-043 | TRD-036-TEST, TRD-043-TEST |
| REQ-023 | Reachable from the real entry points, on all runtimes (Must) | TRD-037 | TRD-037-TEST |
| REQ-024 | PR content is untrusted; no secrets (Must) | TRD-002, TRD-006, TRD-009, TRD-037 | TRD-002-TEST, TRD-006-TEST, TRD-009-TEST, TRD-037-TEST |
| REQ-025 | Every new gate can fail (Must) | TRD-014, TRD-021, TRD-028 | TRD-014-TEST, TRD-021-TEST, TRD-028-TEST |

## Quality Requirements

- **Testing:** every gate has a contract test and a mutation guard in the existing harness (Rules 3 and 7). Unit coverage targets follow the constitution (60% unit, 50% integration). Tests assert only orders the code under test owns (Rule 9).
- **Security:** base-branch sourcing, untrusted PR content, redaction, read-only reviewers, fail-closed defaults (Rules 1, 2, 5).
- **Performance:** each pure subcommand completes in under 1 second on a 200-finding ledger and a 50-review payload and makes no network call.
- **Portability:** one behavior across Claude Code, Pi, Codex and OpenCode, or a visible reduced-capability notice (REQ-006, REQ-023).
- **Accessibility/UI:** not applicable (CLI and markdown only).
- **Documentation:** README, CHANGELOG, user guide chapter and a wiki staging note (per AGENTS.md) ship with the change.

## Design Review Findings (resolved in 1.0.1)

**Architecture issues**

1. *Bootstrap:* the first PR that adds `REVIEW.md` has no base-branch copy, so its own policy cannot apply. Resolution: strict defaults apply (Low treated as Medium, cap 3, built-in sensitive set) and the PR is reviewed under them; documented in init-project and the guide.
2. *Independence of voters:* verifiers are independent in context, not in model, so they can share a blind spot. Resolution: critical and security findings bypass vote filtering (AC-006-2); the eval set (REQ-020) measures misses; distinct verifier prompts are policy-editable.
3. *Enforcement boundary:* a skill-driven gate only binds callers that consult it. Resolution: `pr-merge` requires the gate result, the CLI fails closed, and the docs recommend branch protection for server-side enforcement; the TRD does not claim ensemble can enforce it alone.

**Task coverage issues**

1. *Thin BDD coverage:* REQ-011, REQ-015, REQ-018, REQ-021, REQ-024, REQ-025 have fewer than the 3 PRD ACs the create-trd BDD rule expects (happy, edge, error). Their test tasks carry one scenario per existing AC; the gap is recorded in the scorecard and is a refine-prd candidate rather than invented scenarios.
2. *Non-testable wording:* AC-022-1 ("delivered within minutes") and the "cannot vouch for" wording of AC-010-3 and AC-014-2 are not directly assertable. Resolution: AC-010-3 and AC-014-2 are made testable by the tree-and-remediation-commit definition above; AC-022-1's timing is verified manually and not gated.
3. *Static guarantee:* AC-021-2 ("no recurring job") needs a check, not a hope. Resolution: TRD-035 includes a test that ensemble's own workflows contain no `schedule` trigger.

**Dependency and estimate issues**

1. Longest hour-weighted dependency chain: TRD-001 -> TRD-002 -> TRD-009 -> TRD-016 -> TRD-039 -> TRD-018 -> TRD-019 -> TRD-040 -> TRD-027 -> TRD-037 -> TRD-038 (53h). Tasks deeper than 3 levels: 25 (mostly per-PR packaging and docs tasks). Refinement did not shorten this critical path, which runs through PR 3, PR 4 and the reachability proof; it removed PRs 5 and 6 from it: TRD-030, 031, 035 and 036 no longer depend on PR 4 and the tier-dependent explainer offer is split into TRD-043, so PR 5 and PR 6 work can run in parallel with PR 3 and PR 4.
2. *Estimates:* the four 8h tasks were split (TRD-016/039, 019/040, 023/041, 030/042); no task is estimated at 8h or more. Eleven new modules with no prior in-repo analogue for votes and tiers still make estimates less certain than for 82b6a138.
3. *Cross-cutting churn:* every PR bumps package versions and regenerates mirrors; conflicts are likely between stacked PRs. Resolution: each PR has one packaging task (TRD-008, 015, 022, 029, 034, 038) and version bumps are applied once per PR, rebased with git-town.
4. *Entry dependency:* TRD-012 amends the 82b6a138 PRD and TRD, so PRD-2026-82b6a138 must be finished first (PRD entry criterion). The PRD baseline entry criterion is now a task (TRD-044, PR 1) with a committed result file, which TRD-030 later reproduces.

**Refinement decisions (1.0.1):** dependency order fixed (TRD-020 before TRD-019); `MODE=gate` fails closed on missing data with a next action and one in-run retry; partial verifier failure degrades per finding; the classifier and second-assessment contract is a closed enum with cited evidence (unknown = `other`, non-boolean = true); eval cases live in `docs/review-eval/cases/<id>.json` (policy `evalCasesDir`); the baseline result is committed as `docs/guides/review-baseline-<date>.json`.

## Design Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Architecture completeness | 4.5 | Components, contracts, data flow, trust boundaries and the enforcement limit are defined; data formats are in the companion |
| Task coverage | 4.5 | 25/25 REQs and 80/80 ACs mapped to implementation and test tasks; 6 REQs have fewer than 3 PRD ACs |
| Dependency clarity | 4.5 | Explicit and acyclic; the longest chain is long but sequential |
| Estimate confidence | 4 | New modules with no direct analogue; 0 tasks at 8h |
| **Overall** | **4.38** | **PASS** |

## Changelog

| Date | Version | Changes |
|---|---|---|
| 2026-10-27 | 1.0.0 | Initial TRD created via /ensemble:create-trd from PRD-2026-70e784f2 v1.0.1; Option C; Design Readiness 4.13; Constitution Gate passed. |
| 2026-10-27 | 1.0.1 | Refinement (8 findings): reordered TRD-020 before TRD-019; split the four 8h tasks (TRD-016/039, 019/040, 023/041, 030/042); decoupled PRs 5 and 6 from PR 4 and split TRD-043; added fail-closed gate error handling, per-finding verification degradation and one in-run gh retry; specified the classifier and second-assessment contract; set eval case location and baseline storage; added TRD-044 baseline capture runbook (PR 1); retired both data-model open questions; Design Readiness 4.13 -> 4.38. |
