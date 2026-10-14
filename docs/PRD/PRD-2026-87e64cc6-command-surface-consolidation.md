---
document_id: PRD-2026-87e64cc6
label: prd-command-surface-consolidation
version: 1.0.1
status: Draft
date: 2026-10-06
scale_depth: STANDARD
total_requirements: 19
readiness_score: 4.43
design_readiness_score: null
---

# PRD-2026-87e64cc6: Task-Oriented Command Surface Consolidation

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 15 |
| Should requirements | 3 |
| Could requirements | 1 |
| Won't requirements | 0 |
| AC coverage | 19/19 (100%) |
| Risk flags | REQ-001, REQ-002, REQ-006, REQ-009, REQ-010, REQ-013, REQ-014, REQ-017, REQ-019 |
| Cross-requirement dependencies | 32 |
| Unresolved clarification markers | 0 |
| Constitution compliance | passed |

## Product Summary

**Problem:** Ensemble's command surface has grown organically and now obscures intent. A developer seeing `ensemble-feature` (a linear, non-checkpointed idea-to-plan pipeline) and `ensemble-new-feature` (the newer resumable, checkpointed workflow) cannot tell which one starts "building a feature," and running what looks like the feature entry point can imply implementation work (it currently chains into plan-mode TRD implementation) rather than making the feature lifecycle's intent explicit. Issue-driven work — starting from a reported problem and evidence — shares implementation stages with feature work but follows a different recommended workflow, and today it also lacks the resumable, checkpointed run state the feature workflow has, so nothing in the surface communicates either distinction. `ensemble-prd` and `ensemble-trd` exist as document-oriented dispatcher commands (native, with discoverable subcommand completion), but `ensemble-feature` and `ensemble-new-feature` exist only as prompt commands and natural-language skills, so the feature workflow exposes no enumerable list of actions (`new`, `resume`, `status`, `abandon`) the way the dispatchers do, and users cannot discover what a feature run supports without reading its documentation.

**Solution:** Consolidate the command surface around task-oriented front doors backed by one canonical workflow each. `ensemble-feature` becomes the native, subcommand-discoverable entry point for the feature lifecycle (`new`, `resume`, `status`, `abandon`) and delegates, as a thin unmodified pass-through, to the existing resumable `ensemble-new-feature` workflow, which becomes the single canonical feature pipeline; the legacy linear `ensemble:feature` pipeline is retired outright as part of this effort rather than kept alive behind a compatibility window. `ensemble-issue` keeps issue-driven work (`fix`, `list`) as a separate task-oriented entry point, distinct from feature work because an issue starts from reported evidence while a feature starts from planned intent — and gains the same resumable, checkpointed run architecture the feature workflow already has, so `status`/`resume`/`abandon` have real state to act on. `ensemble-prd` and `ensemble-trd` remain direct document-oriented specialist tools for targeted expert use, and are explicitly not turned into catch-alls for every PRD/TRD operation. All four task-oriented/specialist commands converge on the same action-discoverability mechanism (a `dispatch.subcommands[]`-style YAML source), on the hosts where that mechanism exists.

**Value proposition:** A developer gets one obvious front door per task type — "I'm building a feature" vs. "I'm fixing an issue" — with enumerable actions surfaced natively and resumable state for both, while experts retain the composable document-level commands; maintainers keep one canonical feature pipeline instead of two drifting ones, and the feature/issue distinction is visible in the surface itself rather than in prose.

**Target users:**
- **Developer (primary):** starts features and fixes issues from the command line inside OMP/Pi; needs to pick the right entry point without memorizing which pipeline is current.
- **Expert power user:** works artifacts directly (`ensemble-prd create`, `ensemble-trd implement`, …) and needs those specialist entry points preserved and unambiguous.
- **Maintainer / release owner (approver):** owns the command surface and documentation; judges this product against the requirement that exactly one canonical feature workflow exists, issue work is independently resumable, and every surface entry point's intent is legible.

**Implementation context for the TRD:** The delegation layer and native action commands are command YAML, skill/prompt, and extension-registration artifacts (this repo already registers native dispatcher commands that forward to colon-named markdown commands and read subcommand metadata from the YAML's `dispatch.subcommands[]`). Making `ensemble-issue fix` resumable/checkpointed means giving it its own run-index store — distinct from, but architecturally mirroring, the feature workflow's `RunIndexStore` (same checkpoint/resume/abandon semantics) — the TRD decides whether that is a shared generic module parameterized by workflow, or a parallel implementation. The mechanism for retiring the superseded `ensemble:feature` pipeline and de-advertising the internal `ensemble-new-feature` name across generated plugin content (Claude Code / Pi / Codex / OpenCode targets) is also a TRD decision.

## User Analysis

**Roles and pain points:**
- Developer invoking a feature command today must know whether `ensemble-feature` or `ensemble-new-feature` is current, and that invoking the feature path lands in planning, not implementation — today this is tribal knowledge.
- A developer whose issue-fix session is interrupted today has no way to resume it — `ensemble-issue fix` has no checkpoint to return to, unlike the feature workflow.
- Scripts and muscle memory reference the older names; silently broken delegation ("command not found" or a mysterious downstream failure) is worse than a clear "not installed / unavailable" message.
- Skills (natural-language routers) cannot present a list of supported actions; users typing `/ensemble-fea…` get no completion affordance equivalent to `ensemble-prd`'s subcommand dropdown.

**Success metrics:**
- Zero duplicate canonical workflows in the documented surface: one feature lifecycle entry point, one issue entry point, both resumable.
- Every task-oriented command exposes its actions as an enumerable, discoverable list in the product (where the host supports it).
- Feature-work and issue-work entry points are distinguishable by name and action set alone, without documentation.

## Goals and Non-Goals

**Goals:**
- One canonical resumable feature workflow, fronted by a native `ensemble-feature` command with `new`/`resume`/`status`/`abandon` actions.
- `ensemble-issue` remains the separate task-oriented entry point for issue-driven work, and becomes checkpointed/resumable with the same action set, mirroring the feature workflow's architecture.
- `ensemble-prd`/`ensemble-trd` retained as direct document/capability-oriented specialist commands, unchanged in behavior.
- Delegation fails fast with an actionable error (including how to obtain the missing capability) when the underlying workflow is unavailable.
- The superseded linear `ensemble:feature` pipeline is retired outright, not maintained as a third path and not kept alive behind a compatibility window.
- Empty-state behavior (`status`/`resume` with no run) is a simple message plus how-to-start instructions; a project's first-ever run is treated as the ordinary case, not a warning condition.

**Non-Goals:**
- Do not change the resumable feature workflow's stage ordering, checkpoint semantics, or artifact lineage in this effort.
- Do not merge feature and issue workflows into one command.
- Do not add issue-specific actions beyond `fix`/`list`/`status`/`resume`/`abandon` (e.g. re-create) until their behavior is settled; name subcommands after actual operations, never ambiguous verbs.
- Do not implement, build, or execute any of this in the PRD itself.
- Do not specify the registration/deprecation mechanism, host APIs, or whether the issue run-index store is shared code or a parallel module; those belong in the TRD.

## Requirements by Feature Area

### Task-Oriented Entry Points

### REQ-001: Provide a single canonical feature-lifecycle front door
**Priority:** Must | **Complexity:** Medium | **[RISK: two synonymous "new feature" entry points invite drift and wrong-pipeline runs]**

- AC-001-1: Given a developer wants to start a feature from an idea, when they invoke the feature entry point with a description, then exactly one canonical resumable workflow is started and its run identifier is shown.
- AC-001-2: Given the product's documented command surface, when a developer searches for feature-lifecycle entry points, then only one is presented as the way to run the full lifecycle; any other name that performs the same lifecycle either delegates to it or no longer exists (REQ-008).

### REQ-002: Keep feature and issue work as distinct workflows
**Priority:** Must | **Complexity:** Low | **[RISK: merging them would silently route evidence-driven repairs through plan-first gates, or planned features through issue triage]**

- AC-002-1: Given an issue-driven repair is requested through the issue entry point, when it runs, then it follows the issue workflow (investigation and repair from reported evidence) and does not create a feature run record.
- AC-002-2: Given a planned feature is requested through the feature entry point, when it runs, then it follows the feature lifecycle (PRD, TRD, planning, approved implementation) and does not require an existing reported issue as input.

### REQ-003: Expose enumerable actions on every task-oriented command
**Priority:** Must | **Complexity:** Medium

- AC-003-1: Given a developer types the feature entry point without arguments or with an unrecognized action, when the command responds, then it lists its supported actions (`new`, `resume`, `status`, `abandon`) with one-line descriptions and takes no side effect.
- AC-003-2: Given a developer invokes any of the four task-oriented/specialist commands (`feature`, `issue`, `prd`, `trd`) with no or an unrecognized action, when it responds, then it lists its own supported actions the same way, as one product-wide invariant rather than feature-only behavior.

### REQ-004: Preserve document-oriented specialist commands
**Priority:** Must | **Complexity:** Low

- AC-004-1: Given a user invokes a PRD- or TRD-oriented specialist command directly (create, refine, analyze, implement, …), when it runs, then its existing behavior is unchanged and it is not silently redirected into either task-oriented lifecycle.
- AC-004-2: Given the task-oriented front doors exist, when a user consults the command surface, then the specialist commands remain listed and documented as the direct way to work on a single artifact.

### Delegation and Availability

### REQ-005: Delegate to the canonical workflow as a pure pass-through
**Priority:** Must | **Complexity:** Low

- AC-005-1: Given the feature front door runs any action, when work is performed, then it is performed by the underlying resumable workflow's existing entry logic and stage machine; the front door adds no parallel implementation of those stages.
- AC-005-2: Given the underlying workflow's argument conventions change in the future, when the front door forwards a call, then it passes arguments through unchanged rather than translating them — the front door's own syntax changes whenever the underlying workflow's does, in exchange for zero translation code to maintain.

### REQ-006: Fail fast and actionably when the delegated capability is missing
**Priority:** Must | **Complexity:** Medium | **[RISK: a half-installed surface producing a mysterious downstream error is worse than a loud upfront one]**

- AC-006-1: Given the canonical underlying workflow is not installed or not resolvable, when a user invokes any feature action, then no partial state is created and the output names the missing capability and states how to obtain it (installation instruction).
- AC-006-2: Given the delegated capability is available, when actions run, then no availability warning is printed.
- AC-006-3: Given the capability is available but this project has no prior run (no `.ensemble/` state yet), when `new` is invoked, then this is treated as the ordinary first-run case — the initial run is created silently, with no distinct warning or notice beyond the normal run-started output.

### REQ-007: Report run state accurately through `status`, `resume`, and `abandon`
**Priority:** Must | **Complexity:** Medium

- AC-007-1: Given a run exists (active, paused, or terminal), when the user asks for status, then the report shows the run identifier, current stage, last stage outcome (with detail for pending decisions or failures), and every recorded artifact and bead reference, never implying a PR exists when none does.
- AC-007-2: Given no run has ever existed for the project, when the user asks for status or resume, then a simple message states there is nothing to resume and shows how to start one.
- AC-007-3: Given the user invokes `abandon` on either the feature or the issue workflow (REQ-019), when invoked, then the command requires an explicit confirmation before the run reaches a terminal abandoned state; once confirmed, artifacts and history are retained and a later `status` shows the abandoned outcome with retained references.

### Compatibility and Retirement

### REQ-008: Retire the superseded linear pipeline outright
**Priority:** Must | **Complexity:** Medium

- AC-008-1: Given this effort ships, when a user looks for a feature-lifecycle command, then the legacy linear `ensemble:feature` pipeline is no longer present as a separate, independently-maintained path — it is either removed or reduced to a pointer that forwards into the canonical workflow, decided and executed in the same release, not phased behind a compatibility window.
- AC-008-2: Given the retirement ships, when the product surface is presented, then only the canonical `ensemble-feature` front door is advertised for the feature lifecycle.

### REQ-009: De-advertise the internal workflow name without relying on invisibility
**Priority:** Should | **Complexity:** Low | **[RISK: documentation cannot be enforced against direct invocation; hiding may be technically impossible on some hosts]**

- AC-009-1: Given the underlying resumable workflow becomes the internal implementation of the feature front door, when a user consults any product documentation, then the front-door command is presented as the entry point and the internal workflow is described as implementation detail.
- AC-009-2: Given a user invokes the internal workflow name directly (it may remain technically reachable), when it runs, then behavior is identical to going through the front door — the same canonical run record — with a one-line pointer to the front door; staying undocumented-but-reachable, rather than fully non-invocable, is an accepted outcome.

### Discoverability and Consistency

### REQ-010: Make commands, not just skills, the discoverable surface
**Priority:** Must | **Complexity:** Low | **[RISK: skills and commands drifting in name/description reintroduces the confusion this product removes]**

- AC-010-1: Given a skill exists that routes to a task-oriented command (e.g. natural-language "start a new feature"), when a user asks for or invokes the underlying capability either way, then it converges on the same canonical workflow and names the same front-door command.
- AC-010-2: Given the command list is inspected in the product, when a feature or issue action is sought, then the front-door commands appear with their descriptions in the product's native command listing, not only in generated plugin prose.

### REQ-011: Keep naming conventions uniform, and state the platform split plainly
**Priority:** Should | **Complexity:** Low

- AC-011-1: Given a new action is added to a task-oriented command, when it ships, then its name describes the actual operation (no ambiguous verbs such as "re-create" without a settled meaning).
- AC-011-2: Given the native, hyphenated command surface with live subcommand completion exists only on the Pi/OMP host (Codex and OpenCode have no equivalent registration mechanism and only receive the colon-named markdown-prompt commands), when this is documented, then the PRD/TRD state that platform split plainly rather than implying uniform discoverability across all hosts.

### Reachability and Verification

### REQ-012: Ship reachable from the product entry point
**Priority:** Must | **Complexity:** Medium | **[RISK: a workflow that passes tests but is unreachable from the shipped product surface is not done]**

- AC-012-1: Given the consolidated surface is installed, when a developer starts a fresh OMP session in this product, then invoking the feature front door end-to-end reaches the resumable workflow's stage machine (no separate manual registration step is required).
- AC-012-2: Given acceptance is evaluated, when a feature action is tested, then the assertion runs *through* the shipped command surface, not around it via internal APIs.

### REQ-013: Make every guard provably able to fail
**Priority:** Must | **Complexity:** Medium | **[RISK: a verification that cannot fail manufactures confidence]**

- AC-013-1: Given the delegation-availability guard (REQ-006), when its check is exercised against an installed capability, then the guard passes; when the capability is removed, then the guard demonstrably fails closed with the actionable message — both directions observable.
- AC-013-2: Given the canonical-run uniqueness behavior inherited from the resumable workflow (cross-developer concurrency is out of scope per the recommended one-worktree-per-feature workflow), when the front door forwards a second concurrent start attempt, then a shallow pass-through test asserts the front door surfaces the underlying workflow's existing refusal unchanged, without re-implementing or weakening it.

### Boundaries and Safety

### REQ-014: Keep the surface documentation-and-routing only; no durable coordination
**Priority:** Must | **Complexity:** Low | **[RISK: an entry layer that adds retries, scheduling, or autonomous recovery would breach the Ensemble/Foreman ownership boundary]**

- AC-014-1: Given any action of either task-oriented command (including the issue workflow's new checkpointing, REQ-019), when it completes or fails, then the command performs no automatic retry, background scheduling, or unattended continuation; every continuation is a user-invoked resume.
- AC-014-2: Given the feature lifecycle can reach implementation, when implementation begins, then the existing store-persisted implementation approval of the underlying workflow governs — the front door can neither grant nor bypass it, and claiming approval in prose without the recorded approval changes nothing.

### REQ-015: Validate command input at the boundary
**Priority:** Must | **Complexity:** Low

- AC-015-1: Given a user passes an unknown action token or unsupported flag to a task-oriented command, when the command validates options, then it is rejected before any run state is created or read, with the supported action list shown.

### REQ-016: Keep user-owned routing text editable, sourced from one mechanism
**Priority:** Should | **Complexity:** Low | **[RISK: hardcoding action lists or descriptions in code forces PRs for wording changes users should own]**

- AC-016-1: Given an action's name, description, or help text is wording a maintainer would plausibly tune, when it ships, then it lives in an editable prompt/command/skill artifact rather than requiring a rebuild.
- AC-016-2: Given the native command's action list is rendered, when the underlying editable artifact is the source, then `ensemble-feature` sources its action list from a `dispatch.subcommands[]`-style YAML entry, the same mechanism already used by `ensemble-prd`/`ensemble-trd`/`ensemble-issue`, rather than a second, differently-shaped source.

### Lifecycle and Completion

### REQ-017: Deliver the whole surface together
**Priority:** Must | **Complexity:** Low | **[RISK: shipping the feature front door without the issue/PRD/TRD story leaves the same intent-confusion half-solved]**

- AC-017-1: Given this effort completes, when the product surface is inspected, then `ensemble-feature` (with its actions), the resumable `ensemble-issue` story (REQ-019), and the retained `ensemble-prd`/`ensemble-trd` specialist entries all match this PRD's requirements simultaneously.
- AC-017-2: Given implementation work would expose commands the product doesn't yet ship, when the acceptance environment is checked, then the exit condition is the commands appearing in the installed product with correct actions, not merely passing tests in isolation.

### REQ-018: Keep existing standalone document commands untouched in behavior
**Priority:** Could | **Complexity:** Low

- AC-018-1: Given the consolidation ships, when a user runs any existing standalone PRD/TRD/beads command, then its output contract is byte-for-byte the documented behavior it had before, except for added pointer lines required by REQ-008/REQ-009.

### REQ-019: Make `ensemble-issue fix` resumable and checkpointed
**Priority:** Must | **Complexity:** High | **[RISK: a second, independently-built run-state mechanism risks drifting from the feature workflow's unless the TRD shares the underlying implementation]**

- AC-019-1: Given `ensemble-issue fix` starts a repair from an issue description, when it begins, then a checkpointed run record is created in its own run-index store, distinct from the feature workflow's (per REQ-002), tracking stage and outcome.
- AC-019-2: Given an issue run is interrupted or paused, when `ensemble-issue resume` (or a no-argument resume) is invoked, then the workflow continues from its last recorded checkpoint without re-deriving state from conversation history or file-presence guessing.
- AC-019-3: Given `ensemble-issue status` is invoked, when a run exists, then it reports the run identifier, current stage, last outcome, and recorded references the same way REQ-007 defines for the feature workflow.
- AC-019-4: Given `ensemble-issue abandon` is invoked, when confirmed (REQ-007-3), then the issue run reaches a terminal abandoned state with its history retained.

## Ambiguity Scan

Ambiguity scan complete: 0 items remain marked for clarification. All 8 originally-marked `[NEEDS CLARIFICATION: ...]` items were resolved during a live `refine-prd` interview (see Changelog); depth-level counts for STANDARD were interpolated from the command spec's LIGHT/DEEP guidance (3 SCAMPER angles + 3 failure scenarios) during the original live elicitation.

## Dependency Map

| REQ | Depends On | Notes |
|-----|------------|-------|
| REQ-001 | REQ-005, REQ-006 | Canonical front door requires working, fail-fast delegation |
| REQ-002 | REQ-001, REQ-014 | Distinct workflows must stay documentation-and-routing only |
| REQ-003 | REQ-010, REQ-016 | Action enumeration is the discoverability mechanism |
| REQ-004 | REQ-011 | Specialist retention relies on unambiguous naming |
| REQ-005 | REQ-001 | Delegation defines the front door |
| REQ-006 | REQ-013, REQ-015 | Fail-fast behavior must be provable and input-validated |
| REQ-007 | REQ-005, REQ-019 | Status/resume/abandon are shared semantics across both workflows |
| REQ-008 | REQ-001, REQ-009 | Retirement converges on the canonical run |
| REQ-009 | REQ-008 | De-advertisement is the retirement's end state |
| REQ-010 | REQ-003, REQ-012 | Command-vs-skill consistency verified through the product |
| REQ-011 | — | Naming convention and platform-split constraint |
| REQ-012 | REQ-001, REQ-003 | Reachability applies to the shipped surface |
| REQ-013 | REQ-006 | Guards must fail closed observably |
| REQ-014 | REQ-005 | Boundary applies to the delegation layer |
| REQ-015 | REQ-003 | Option validation gates everything else |
| REQ-016 | REQ-003, REQ-011 | Editable artifacts back the action surface |
| REQ-017 | REQ-001, REQ-002, REQ-003, REQ-004, REQ-012 | Whole-surface delivery |
| REQ-018 | REQ-004 | Compatibility with specialist commands |
| REQ-019 | REQ-002, REQ-014 | Issue resumability must preserve workflow separation and the no-autonomy boundary |

**Implementation clusters:** {REQ-001, REQ-005, REQ-006, REQ-007, REQ-015} front door + delegation + guards · {REQ-003, REQ-009, REQ-010, REQ-011, REQ-016} discoverability, naming, editable routing · {REQ-002, REQ-004, REQ-008, REQ-014, REQ-017, REQ-018} workflow separation, retirement, boundaries, delivery · {REQ-012, REQ-013} reachability and verification gates · {REQ-019} issue-workflow resumability.

No circular dependencies identified.

## Approvals and Decision Ownership

**Approver:** the repo maintainer (single-owner decision for this product). **Acceptance criteria:** the consolidated surface matches this PRD's requirements — one canonical feature workflow, a resumable issue workflow, retained specialist commands, enumerable actions — and all readiness scores exceed the agreed threshold (see Entry and Exit Criteria).

## Entry and Exit Criteria

**Entry:** working directory is clean (no unrelated uncommitted changes) before implementation begins; PRD readiness score > 4; TRD readiness score > 4. **Exit:** all consolidated commands — `ensemble-feature`, `ensemble-issue`, `ensemble-prd`, `ensemble-trd` — are available in the installed OMP product surface and their actions appear accordingly (observable in the product, not only in source), with the superseded `ensemble:feature` pipeline no longer present.

## Adversarial Review

| Issue | Category | Resolution |
|-------|----------|------------|
| Front door could re-implement stage logic as a copy. | Contradiction with "delegation" | REQ-005 makes the stage machine single-source, pass-through only (Option B, no translation layer). |
| Availability failure discovered only mid-run as a cryptic error. | Missing edge case | REQ-006 requires pre-state fail-fast with installation instructions; first-run (no prior state) is explicitly the ordinary case, not a failure (AC-006-3). |
| `status` implies more than happened (e.g. PR merged). | Testability / honesty | REQ-007-1 reuses the workflow's exact reference reporting; PR only when recorded. |
| Two "new feature" commands keep coexisting indefinitely. | Gap | REQ-001/REQ-008/REQ-009 force one canonical path with outright retirement, not a lingering compatibility window. |
| Hiding the internal workflow name may be technically impossible. | Feasibility | REQ-009 sets the honest goal: de-advertise + converge on the same run record, not invisibility. |
| Skills and commands drift apart in name/description. | Ambiguity | REQ-010 requires convergence regardless of entry route. |
| Adding retries/autonomy to make resume "smarter". | Safety / constitution | REQ-014 keeps the layer documentation-and-routing only; continuation is user-invoked, including for the new issue checkpointing (REQ-019). |
| Acceptance proven via internal APIs rather than the product. | Testability | REQ-012 asserts through the shipped entry point; REQ-013 requires guards to fail observably. |
| Issue actions invented before their semantics settle. | Scope | Non-Goals + REQ-011 naming rule defer new issue actions beyond `fix`/`list`/`status`/`resume`/`abandon`. |
| Making `ensemble-issue` resumable duplicates the feature workflow's run-state machinery. | Feasibility / scope | REQ-019 requires its own run-index store (preserving REQ-002's separation) but defers to the TRD whether that is shared, generic code or a parallel implementation — explicitly flagged as a drift risk to design against. |

## Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|-----------|:-:|-------|
| Completeness | 4.5 | All 8 clarification markers resolved; issue-workflow resumability gap (REQ-019) closed; covers entry points, delegation, availability, discoverability, retirement, boundaries, and delivery. |
| Testability | 4.6 | Every Must/Should requirement has observable GWT criteria including fail-closed and can-fail directions; REQ-019 adds 4 further GWT ACs. |
| Clarity | 4.6 | Feature/issue/specialist split is explicit; the platform split (REQ-011) and retirement-not-compatibility-window stance (REQ-008) are now stated plainly instead of left open. |
| Feasibility | 4.0 | Builds on the existing native-dispatcher registration pattern and the shipped resumable workflow; REQ-019 introduces real new scope (a second run-index store) whose implementation strategy is deliberately deferred to the TRD. |
| **Overall** | **4.43** | **PASS** (+0.13 vs. v1.0.0's 4.30) |

**Gate decision: PASS.** Recommended next step: `/ensemble:create-trd docs/PRD/PRD-2026-87e64cc6-command-surface-consolidation.md`.

## Constitution Gate

Constitution Gate: running

| Source | Check | Result |
|--------|-------|--------|
| §1 Core Principles | Ensemble remains a portable behavior-definition/packaging/validation/local-harness project, not a durable production scheduler. | PASS — REQ-014 keeps the surface documentation-and-routing only, including the new issue checkpointing (REQ-019); all continuation is user-invoked. |
| Rule 1: No secrets in code | Requirements embed no credentials. | PASS — no secrets specified. |
| Rule 2: Input validation required | External input validated at boundaries. | PASS — REQ-015 validates actions/options before any state access. |
| Rule 3: Tests accompany features | Acceptance criteria are testable. | PASS — every REQ has GWT ACs, including REQ-013's shallow pass-through test. |
| Rule 4: Ownership boundary preserved | No durable activation/scheduling/retries/second dispatcher. | PASS — REQ-014, extended to cover REQ-019's issue-run checkpointing. |
| Rule 5: Governed tool boundary at runtime | Approval cannot be claimed via prompt text. | PASS — REQ-014-2 inherits the store-persisted approval requirement. |
| Rule 6: Reachable from product entry point | Acceptance asserts through the entry point. | PASS — REQ-012. |
| Rule 7: Verification must be able to fail | Guards demonstrably reject. | PASS — REQ-013. |
| Rule 8: User-changeable behavior in editable artifacts | Wording/actions in prompts/skills, not TS. | PASS — REQ-016. |

Constitution compliance: passed

## Changelog

### 2026-10-06 — v1.0.1

Refined via live `refine-prd` interview against the `ensemble-new-feature` run `18d126c0f2ca04ce` (`prd_refine` stage). 10 findings addressed:

- Resolved all 8 `[NEEDS CLARIFICATION]` markers: REQ-003 action-listing is a product-wide invariant across all four commands (1); REQ-005 is a pure pass-through delegation with no translation layer (2); REQ-007 abandon requires confirmation (3); REQ-008 retires the legacy pipeline outright rather than running a compatibility window (4); REQ-009's undocumented-but-reachable fallback accepted (5); REQ-011 states the Pi/OMP-only native-command platform split plainly, verified against the codebase rather than assumed (6); REQ-013 keeps a shallow pass-through concurrency test rather than dropping it (7); REQ-016 standardizes on the existing `dispatch.subcommands[]` YAML mechanism (8).
- Added REQ-019 (new scope, user-directed): made `ensemble-issue fix` resumable and checkpointed, mirroring the feature workflow's architecture, so REQ-007's `abandon`/`status` apply to it meaningfully; updated REQ-007, Goals, Dependency Map, Adversarial Review, and the Constitution Gate accordingly.
- Added MoSCoW-adjacent complexity tags (Low/Medium/High) to every requirement, matching the sibling PRD convention.
- Corrected two pre-existing accuracy bugs in the v1.0.0 PRD Health Summary: the clarification-marker count (stated 7, actually 8) and the risk-flag list (omitted REQ-006 and REQ-009, which already carried `[RISK: ...]` tags in the body) and the cross-requirement dependency count (stated 22, actual table total was 29).
- Re-scored the Implementation Readiness Gate: 4.30 → 4.43 (Completeness 4.2→4.5, Testability 4.5→4.6, Clarity 4.3→4.6, Feasibility 4.2→4.0 reflecting REQ-019's new, TRD-deferred scope).

### 2026-10-06 — v1.0.0

- Initial STANDARD PRD from the `ensemble-new-feature` run `18d126c0f2ca04ce` (`prd_create` stage): consolidated requirement set from live Problem Space (5 questions), SCAMPER (Substitute/Combine/Eliminate), 3 failure scenarios, and scope-boundary interviews.
