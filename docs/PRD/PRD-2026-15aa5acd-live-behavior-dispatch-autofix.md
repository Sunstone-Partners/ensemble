---
document_id: PRD-2026-15aa5acd
label: prd-live-behavior-dispatch-autofix
version: 1.1.0
status: Draft
date: 2026-09-25
scale_depth: LIGHT
total_requirements: 16
readiness_score: 4.7
---

# PRD-2026-15aa5acd: Live Behavior Dispatch and Bounded Auto-Fix Loop

## PRD Health Summary

| Metric | Value |
|---|---|
| Must requirements | 16 |
| Should requirements | 0 |
| Could requirements | 0 |
| Won't (this release) | 4 |
| AC coverage | 16/16 (100%) |
| Risk flags | 6 |
| Cross-requirement dependencies | 11 |
| Clarification markers | 0 |
| Constitution compliance | passed (Rule 4 — see Constitution Compliance section) |

## Problem Statement

`PRD-2026-0fc1c1d0` (Phases E0-E2) shipped the behavior schema, compiler, typed domain-tool vocabulary, local outbox, and tool-grant enforcement — but explicitly deferred (Phase E5, `Won't`) actually wiring a real event to a compiled behavior's invocation. Today, `investigate-test-failure` exists as a valid, conformance-tested example package, but nothing in a live Pi session ever notices a real test failure and invokes it. Investigation during this PRD's elicitation found the missing piece is narrower than originally assumed: Pi's native `tool_result` extension event already observes bash command completion (including a pass/fail signal) without any hook mechanism — the gap is purely translation and local event-to-behavior matching, plus giving `policy.mode` real enforced semantics (it is currently validated for presence only and rendered as decorative text).

### Prerequisite defects discovered by code review (v1.1.0)

A review of the E0-E2 deliverables against this PRD's assumptions found three defects that make this PRD unbuildable as originally drafted. They are now in scope as REQ-009, REQ-010, and REQ-011, sequenced ahead of all other work:

1. **The behavior pipeline is never activated in production.** `packages/pi-extension/src/extension.ts` registers only `echoTool`; `discoverBehaviorPackages()`, `compileBehaviorToArtifacts()`, and `loadCompiledBehavior()` have no call sites outside tests. Because `wireToolGrantEnforcement` is invoked from inside `loadCompiledBehavior`, REQ-018's manifest-driven blocking of *native* tools (bash/read/write) never runs in a live session. Scoped precisely: the narrower CLI-flag-gated grant check for the custom `echo` tool (`pi.registerFlag("ensemble-tool-grant")` → `registry.grant()`/`registry.invoke()`, with unauthorized calls throwing) **is** reachable from the production `activate()` and is unaffected by this finding.
2. **The one shipped example behavior cannot fire.** `investigate-test-failure`'s trigger predicate is `exit_code: { not: 0 }`, but no numeric exit code exists anywhere in Pi's API. Its conformance fixtures pass only because the fixture JSON is hand-authored to contain a field the runtime is structurally incapable of emitting.
3. **`mutation_classes` is declared, compiled, and never enforced.** `hasMutationAuthority()` is defined in `compiler.ts` with zero call sites. Together with `policy.mode` being presence-validated only, the entire governance model is currently documentation rather than enforcement — which makes shipping `mode: auto` auto-apply on top of it the riskiest possible build order.

### Who feels the pain today

- **Developers using Ensemble/Foreman-invoking skills** — behaviors are authorable and conformance-testable, but never fire from real activity; every test failure still requires a human to notice it and manually invoke a fix.
- **The PRD/TRD-2026-0fc1c1d0 author(s)** — shipped a schema, compiler, and vocabulary with no live consumer, which cannot be validated as fit-for-purpose without a real end-to-end firing.

### Alternatives considered

- **`@hsingjui/pi-hooks`** (Claude Code-compatible command hooks for Pi) — investigated directly. It adapts the same native `tool_call`/`tool_result` extension events this PRD already uses, into Claude's hook JSON config format, then shells out to an external command. Its `PostToolUse`/`PostToolUseFailure` payload (`tool_response: { content, details, is_error, output }`) exposes no more than the boolean `is_error` this PRD's translator already needs, and adds an external config format, a subprocess spawn per event, and a re-normalization step for zero new capability. Rejected as pure indirection.

## Goals and Non-Goals

### Goals

- Widen native `tool_result` normalization in `packages/pi-extension` to carry the data (`command`, `isError`) a behavior trigger predicate needs.
- Translate a qualifying native `tool_result` into a typed, closed-catalog domain event (`test.failure.observed`), repo-portably (no hardcoded `packages/*` assumption).
- Match a translated event against compiled behaviors and invoke the match — via an explicit, named, session-bounded `LocalEventMatcher` (mirroring `match(event, catalog)`, the architecture doc's own sanctioned primitive), never a durable/cross-session dispatcher.
- Give `policy.mode` (`propose` | `auto` | `shadow`) real, harness-enforced semantics in place of today's presence-only validation.
- Auto-apply a fix under `mode: auto`, re-verify against the **entire** test suite (not just the originally-failing test), and reject any fix that weakens, removes, or skips an assertion rather than resolving the defect.
- Bound retries to 3 attempts on the same underlying issue, then escalate to the operator via the existing `ensemble.request_approval` tool.
- Gate any constitution-change proposal behind an inline yes/no confirmation inside the live session; only open a PR (never a direct `constitution.md` write) on "yes."
- Ensure all of the above works unmodified in any repo this package is installed into (e.g. Foreman/Elixir), not only this monorepo.

### Non-Goals

- **Won't** — A numeric `exit_code` predicate. Pi's public extension API exposes only a boolean `isError` on `tool_result`/`tool_execution_end`; no numeric exit code is available anywhere in the SDK. `investigate-test-failure`'s trigger predicate must be adapted to match on `isError`, not `exit_code`.
- **Won't** — Any durable, cross-session, or cross-process-restart event-behavior correlation, retry, or activation state. This PRD's `LocalEventMatcher` and retry counter exist only for the lifetime of one live Pi session process (Constitution Rule 4).
- **Won't** — Prompt-injection/abuse guardrails on auto-fix content. Explicitly delegated to the existing external litellm-layer guardrails; out of scope here.
- **Won't** — Any interactive approval gate for the *code fix* itself (`mode: auto` applies directly, no PR, no prompt) — only the constitution-change path is gated. This is an intentional asymmetry, not an oversight.
- Building or repairing a Claude-style hook compatibility layer (still Phase E3, still `Won't`, unaffected by this PRD).
- Building Foreman's protocol client/server (still Phase E4, still `Won't`).

## Success Metrics

- A deliberately broken test inside this repo (e.g. an `agent-core` jest test) is detected via native `tool_result`, translated, matched to `investigate-test-failure`, auto-fixed, full-suite re-verified green, and committed — with zero manual tool-call step — demonstrated live in this repo before use elsewhere.
- The same fix does not weaken, remove, or skip the originally-failing assertion, verified by an adversarial fixture where the "easy" fix would be to gut the assertion.
- A constitution-change proposal for the fixed issue class only becomes a PR after an explicit "yes" to an inline prompt; "no" produces no PR and no `constitution.md` change.
- The identical pipeline (translate → match → auto-fix → full-suite reverify → commit-or-escalate) runs unmodified against a repo with no `packages/` directory and a non-npm test command (e.g. `mix test`).
- A rejected candidate fix leaves the working tree byte-identical to its pre-attempt state, verified by a clean `git status` plus content hash comparison after an adversarial rejection.
- An auto-fix attempt that tries to modify a test file, a guardrail/enforcement source file, or `docs/standards/constitution.md` is refused by the harness in code (not by model judgment), verified adversarially.
- No auto-fix commit ever lands on `main`/`master` or the repository's default branch.

## User Analysis

| Role | Pain Today | Desired Outcome |
|---|---|---|
| Developer using Ensemble/Foreman-invoking skills | Behavior packages are valid but inert; failures require manual notice and manual fix invocation | A real test failure is auto-fixed and full-suite verified without manual intervention |
| Ensemble maintainer | `policy.mode` is decorative; nothing distinguishes `propose` from `auto` at runtime | `auto` genuinely grants direct mutation authority; `propose`/`shadow` are genuinely restricted, enforced at the harness boundary |
| Operator (this PRD's approver) | No way to review a proposed constitution change before it becomes a PR | An inline yes/no gate inside the live session, before any PR is written |

## Technical Dependency Mapping

- **`packages/agent-core`** (`discovery.ts#match`, `compiler.ts`, `domain-tool-vocabulary.ts`, `outbox.ts`) — existing, reused; `match(event, catalog)` is the architecture doc's own sanctioned primitive (§8).
- **`packages/pi-extension`** (`pi-events.ts`, `behavior-loader.ts`, `tool-grant-enforcement.ts`, `local-runner.ts`) — existing, extended; `LocalRunner`'s existing cancel/timeout/no-orphan guarantees are a precedent, not a substitute, for this PRD's `LocalEventMatcher`. Structural difference: `LocalRunner` executes one bounded step inside an already-triggered behavior; `LocalEventMatcher` additionally decides *which* behavior to trigger — an activation decision — so its non-durability is proven independently (AC-003-4), not inherited.
- **`investigate-test-failure`** example package (`packages/agent-core/behaviors/investigate-test-failure/`) — existing but currently un-triggerable; its trigger predicate must change from `exit_code: { not: 0 }` to an `isError`-shaped check (REQ-010, Non-Goals), and its `outcomes` need a real fix-applied outcome distinct from `constitution.change.proposed`.
- **External litellm-layer guardrails** — assumed present; abuse/injection defense is not built here.
- **`packages/pi-extension/src/extension.ts`** — existing; must gain the discovery/compile/load wiring that makes every other requirement here reachable in a live session (REQ-009).
- **`packages/agent-core/src/behavior/package-discovery.ts`** — existing; `discoverBehaviorPackages()` hardcodes `join(rootDir, "packages")`, which directly contradicts this PRD's portability goal and must become configurable (REQ-013).

## Feature Areas

### Feature Area 0: Prerequisite Remediation of PRD-2026-0fc1c1d0

These three requirements repair what the prior PRD reported as delivered. They are sequenced before every other feature area; nothing downstream is demonstrable until they land.

#### REQ-009: Activate the behavior pipeline from the extension entry point {#req-009}
**Priority:** Must | **Complexity:** Medium [RISK: every downstream requirement in this PRD is unobservable in a live session until this lands; treating unit-test coverage as evidence of delivery is the exact failure mode that produced this requirement]

`activate()` must discover, compile, and load behavior packages for the current repo at session start, so that the already-shipped compiler, loader, and grant-enforcement code paths are reachable in production rather than only from tests.

- AC-009-1: Given a repo containing a valid behavior package, when Pi loads the extension and the production `activate()` runs, then that package is discovered, compiled, and loaded with no test-only harness involved.
- AC-009-2: Given a loaded behavior manifest that does not grant `bash`, when the agent attempts a native bash call in that session, then `wireToolGrantEnforcement` blocks it — demonstrated through `activate()`, not through a direct unit call to the loader.
- AC-009-3: Given a repo containing no behavior packages, when `activate()` runs, then the extension activates normally, registers its tools, and raises no error.

#### REQ-010: Make the shipped example behavior triggerable, and fixtures provably constructible {#req-010}
**Priority:** Must | **Complexity:** Low

Change the example's trigger to a satisfiable predicate, and add a conformance rule preventing any future fixture from asserting against events the runtime cannot emit.

- AC-010-1: Given `investigate-test-failure`, when its trigger predicate is evaluated against an event produced by REQ-002's translator from a real failing bash `tool_result`, then it matches.
- AC-010-2: Given any behavior package fixture, when conformance runs, then every fixture event must be constructible by the translator from a real native payload; a fixture containing a field no translator can emit fails conformance.
- AC-010-3: Given the pre-existing `exit_code`-shaped fixture, when the new conformance rule runs against it, then it fails — proving the rule detects the actual defect rather than merely passing on corrected inputs.

#### REQ-011: Enforce `mutation_classes`, and refuse `mode: auto` until enforcement exists {#req-011}
**Priority:** Must | **Complexity:** Medium [RISK: this is the load-bearing safety prerequisite for REQ-005's unreviewed auto-apply; if it ships unenforced, every downstream mutation guarantee in this PRD is nominal]

Give `hasMutationAuthority()` real call sites at the mutation boundary, and make the loader fail closed rather than degrade to unenforced `auto`.

- AC-011-1: Given a behavior whose `mutation_classes` omits `artifact.write`, when it attempts a file write, then the write is blocked at the harness boundary via `hasMutationAuthority()`.
- AC-011-2: Given a manifest declaring `mode: auto`, when the harness has no active mutation-class enforcement, then the loader refuses to load the manifest rather than degrading to unenforced auto-apply.
- AC-011-3: Given a behavior granted `bash` but not `artifact.write`, when it attempts to achieve a file write *through* bash, then the write is still blocked — proving tool access is never mistakable for mutation authority.

### Feature Area 1: Native Signal Capture

#### REQ-001: Widen native `tool_result` normalization to carry command and error signal {#req-001}
**Priority:** Must | **Complexity:** Low

Extend `fromToolResult()`/`fromToolExecutionEnd()` in `pi-events.ts` to include `input` (specifically `command` for bash) and `isError` in the normalized `runtime.tool_result` payload, for native tool calls.

- AC-001-1: Given a native bash tool call that fails, when its `tool_result` event fires, then the normalized payload includes both the executed command string and `isError: true`.
- AC-001-2: Given a native bash tool call that succeeds, when its `tool_result` fires, then the normalized payload's `isError` is `false`.

### Feature Area 2: Event Translation

#### REQ-002: Translate a native `tool_result` into the closed-catalog domain event vocabulary {#req-002}
**Priority:** Must | **Complexity:** Medium [RISK: the translator can only key off boolean `isError`, not a numeric exit code (Pi's API ceiling per Non-Goals); any predicate or downstream logic assuming a specific exit code value is unbuildable]

A repo-portable translator maps a qualifying `runtime.tool_result` (bash, `isError: true`, command matching a configurable test-runner pattern) into a `test.failure.observed` domain event, validated against the closed catalog before appending to the outbox. Must not assume any monorepo-specific directory layout.

- AC-002-1: Given a bash `tool_result` with `isError: true` and a command matching a configurable test-runner pattern, when translated, then a valid `test.failure.observed` event is appended to the outbox with status `accepted_locally`.
- AC-002-2: Given the same translator running from a checkout with no `packages/` directory, when a matching bash failure occurs, then the translator still produces the same event.

### Feature Area 3: Local Event Matching and Invocation

#### REQ-003: Match translated events against compiled behavior triggers and invoke the match, as an explicit local-only event matcher {#req-003}
**Priority:** Must | **Complexity:** High [RISK: this is the requirement Constitution Rule 4 ("a second dispatcher competing with Foreman") most directly touches; every AC below is load-bearing for the Constitution Gate's PASS determination, not merely descriptive]

Implement `LocalEventMatcher`: on each outbox append, call `discoverBehaviorPackages()`/`compile()` (cached per session) against the current repo root, call `match(pkg, event)`, and for each match, invoke the compiled artifact inside the current live Pi session only. This performs an activation decision (which behavior fires), distinct from `LocalRunner`'s narrower scope of executing one bounded step inside a behavior already selected.

- AC-003-1: Given a compiled behavior whose trigger matches the translated event, when the event is appended, then that behavior's compiled artifact executes within the current session.
- AC-003-2: Given no compiled behavior matches, when the event is appended, then no behavior is invoked and no error is raised.
- AC-003-3: Given `LocalEventMatcher`, when inspected, then it has no code path capable of running once the originating Pi session process exits (proves non-durability, satisfies Constitution Rule 4).
- AC-003-4: Given an event-to-behavior correlation (which event matched which behavior, and the outcome), when the originating Pi session process exits and a new process starts, then no trace of that correlation is recoverable from disk or any external store — proven independently, not inherited from `LocalRunner`'s existing `isProcessAlive`-style non-orphan proof.

### Feature Area 4: Policy Mode Enforcement

#### REQ-004: Give `policy.mode` real, harness-enforced semantics {#req-004}
**Priority:** Must | **Complexity:** Medium

Replace presence-only validation of `policy.mode` with enforced branching: `auto` grants direct mutation authority within declared `mutation_classes`; `propose` restricts the invocation to producing a proposal artifact with no direct write; `shadow` blocks all mutation regardless of `mutation_classes`.

- AC-004-1: Given `mode: propose` with `mutation_classes: [artifact.write]`, when the behavior attempts a direct file write, then the write is blocked at the harness boundary and only a proposal artifact is produced.
- AC-004-2: Given `mode: auto` with `mutation_classes: [artifact.write]`, when the behavior applies a fix, then the write succeeds and is reflected on disk.
- AC-004-3: Given `mode: shadow`, when any mutation is attempted, then it is blocked regardless of declared `mutation_classes`.

### Feature Area 5: Bounded Auto-Fix Execution

#### REQ-005: Auto-apply a fix under `mode: auto` and re-verify against the full test suite, never weakening assertions {#req-005}
**Priority:** Must | **Complexity:** High

After generating a candidate fix, re-run the **entire** test suite (not just the originally-failing test) before treating the outcome as fixed. Reject any candidate that breaks a previously-passing test. The "must not weaken assertions" rule is *not* left to the fixing agent's self-certification — that is the same trust model the rule exists to defeat; it is enforced mechanically as a write boundary in REQ-015.

- AC-005-1: Given a candidate fix that makes the targeted test pass by deleting or weakening its assertion, when evaluated, then it is rejected, not committed, and counts toward the retry limit.
- AC-005-2: Given a candidate fix that resolves the underlying defect, when the full suite is re-run, then it must report zero failures before the fix is committed and a fix-applied outcome is recorded.
- AC-005-3: Given a candidate fix that resolves the target test but breaks a previously-passing test, when the full suite is re-run, then the fix is rejected and not committed.
- AC-005-4: Given any rejected candidate (AC-005-1 or AC-005-3), when it is rejected, then the working tree is restored per REQ-015 — rejection must leave no applied edits on disk, since "not committed" does not mean "not written."

### Feature Area 6: Bounded Retry and Escalation

#### REQ-006: Retry the same issue up to 3 times, then escalate to the operator {#req-006}
**Priority:** Must | **Complexity:** Medium [RISK: "retries" is named in Constitution Rule 4; qualified there by "production" — this requirement's retry state must remain in-memory/session-bounded per NFR-1, never durable]

Re-invoke `investigate-test-failure` on the same underlying issue (same failing-test identity) up to 3 attempts; on the 3rd consecutive rejected/failed attempt, call `ensemble.request_approval` and stop auto-retrying.

- AC-006-1: Given 2 consecutive rejected attempts for the same test, when a 3rd is also rejected, then no further automatic attempt occurs and an `ensemble.request_approval` event is recorded.
- AC-006-2: Given a fix succeeds on attempt 2, when the full suite passes, then no 3rd attempt occurs and the retry counter for that issue resets.
- AC-006-3: Given two failing-test observations, when the retry budget is evaluated, then "same underlying issue" resolves to a stable, explicitly defined key (test identifier plus a normalized failure-signature hash); identical keys share one 3-attempt budget, and a different key starts a fresh budget. An undefined identity makes the 3-attempt bound unenforceable.

### Feature Area 7: Interactive Constitution-Change Approval Gate

#### REQ-007: Require an inline yes/no confirmation before opening any constitution-change PR {#req-007}
**Priority:** Must | **Complexity:** Medium

When a behavior proposes a `constitution.md` update to prevent recurrence, it must present an inline yes/no prompt inside the live session first; only "yes" opens a PR containing the proposed diff (`mode` remains `propose`; `constitution.md` is never written directly).

- AC-007-1: Given a proposed constitution change, when the operator answers "no," then no PR is opened and `constitution.md` is unchanged.
- AC-007-2: Given a proposed constitution change, when the operator answers "yes," then a PR is opened with the proposed diff, and `constitution.md` itself is unmodified until that PR is merged.
- AC-007-3: Given a session where no interactive UI is available, when a constitution change is proposed, then the gate fails closed per REQ-014 — absence of a UI is never treated as implicit approval.

### Feature Area 8: Repo Portability

#### REQ-008: Event matcher, translator, and mode-enforcement logic must work unmodified in any repo {#req-008}
**Priority:** Must | **Complexity:** Medium

None of REQ-002 through REQ-007 may hardcode `packages/*`/npm-workspace assumptions; the auto-fix/reverify loop must invoke whatever test command the target repo's own behavior package declares (e.g. `mix test` for Foreman), not a hardcoded `npm test`.

- AC-008-1: Given the same event-matcher/translator/policy-enforcement code installed in a repo with no `packages/` directory and a `mix test` command declared in its own behavior package, when a real Elixir test fails, then the same pipeline (translate → match → auto-fix → full-suite reverify → commit-or-escalate) operates without modification.

### Feature Area 9: Behavior-Declared Test Command

#### REQ-012: Add a behavior-declared test command to the schema {#req-012}
**Priority:** Must | **Complexity:** Low

`BehaviorExecution` is currently `{ graph: string }` — there is no field in which a package can declare its own test command, which makes REQ-008 unbuildable as written. Add one, and require it wherever the auto-fix loop will run.

- AC-012-1: Given a behavior package declaring a test command, when it is compiled, then that command is available to the auto-fix/reverify loop without any hardcoded `npm test` fallback.
- AC-012-2: Given a manifest declaring `mode: auto` with no test command, when it is validated, then validation fails rather than silently defaulting to a package-manager guess.

### Feature Area 10: Configurable Discovery Root

#### REQ-013: Make behavior-package discovery root-configurable {#req-013}
**Priority:** Must | **Complexity:** Low

`discoverBehaviorPackages()` hardcodes `join(rootDir, "packages")`, so a repo without a `packages/` directory can never discover a behavior. Replace with a configurable search root/pattern whose default preserves today's monorepo layout.

- AC-013-1: Given this monorepo, when discovery runs with default configuration, then the same packages are found as today (no regression).
- AC-013-2: Given a repo with behaviors under a different path and no `packages/` directory at all, when discovery runs with that path configured, then the behaviors are found.

### Feature Area 11: Fail-Closed Approval Gate

#### REQ-014: Fail closed when no interactive UI is available {#req-014}
**Priority:** Must | **Complexity:** Low

Pi exposes `ui.confirm(title, message): Promise<boolean>`, so REQ-007's inline gate is feasible — but `ExtensionContext.hasUI` can be `false` in headless or Foreman-driven sessions. The behavior in that case must be specified, or the approval gate silently becomes a no-op.

- AC-014-1: Given `hasUI === false`, when a constitution change is proposed, then no PR is opened, no file is written, and the proposal escalates via `ensemble.request_approval` instead.
- AC-014-2: Given `hasUI === false`, when the gate is evaluated, then the absence of a UI is never interpreted as a "yes," under any code path.

### Feature Area 12: Auto-Fix Write Boundary

#### REQ-015: Constrain what an auto-applied fix may write, and restore the tree on rejection {#req-015}
**Priority:** Must | **Complexity:** High [RISK: the pilot runs unreviewed, repo-wide auto-fix inside the repository that contains its own guardrails — without an in-code exclusion list, a failing test could be "fixed" by editing the enforcement source, the conformance fixtures, or the constitution that constrains it]

Replace unverifiable "don't weaken the test" self-certification with diff-checkable write rules, and guarantee that rejection leaves no residue on disk.

- AC-015-1: Given a candidate diff under `mode: auto` that modifies any test file, when it is evaluated, then it is rejected and escalated — fixes change source, never tests.
- AC-015-2: Given a candidate diff that modifies any protected path (tool-grant enforcement, mode/mutation enforcement, the compiler, conformance fixtures, or `docs/standards/constitution.md`), when it is evaluated, then the write is refused.
- AC-015-3: Given any rejected candidate, when rejection occurs, then the working tree is restored to its exact pre-attempt state, with no partially applied edits remaining.
- AC-015-4: Given an adversarial candidate deliberately targeting a protected path, when it is evaluated, then refusal is performed by harness code, not by model judgment — verified by a test that bypasses the model entirely.

#### REQ-016: Commit and branch policy for unreviewed auto-fixes {#req-016}
**Priority:** Must | **Complexity:** Low

Because `mode: auto` fixes have no PR-review gate, where they land must be constrained rather than left to whatever branch the developer happens to be on.

- AC-016-1: Given an accepted fix, when it is committed, then it never lands on `main`, `master`, or the repository's default branch; it goes to a dedicated branch or the commit is refused.
- AC-016-2: Given an accepted fix, when it is committed, then the commit message carries the behavior name, source event id, and attempt number (NFR-2).
- AC-016-3: Given a repo state where the branch policy cannot be satisfied, when a fix is accepted, then it is escalated rather than committed anyway.

## Non-Functional Requirements

- **NFR-1 (Non-durability):** Retry counters, in-flight event-to-behavior correlations, and pending-approval state exist only for the lifetime of the live Pi session process; nothing persists across a process restart. This is the enforceable basis for the Constitution Rule 4 PASS determination below.
- **NFR-2 (Auditability):** Every auto-applied fix commit references the behavior name, source event id, and attempt number in its commit message, since `mode: auto` fixes have no PR-review gate.
- **NFR-3 (Guardrail boundary):** Abuse/prompt-injection defenses against malicious auto-fix content are explicitly out of scope; delegated to the existing external litellm-layer guardrails.
- **NFR-4 (Bounded verification cost):** Full-suite re-verification is time-bounded and must fit inside the behavior's declared `policy.timeout` across all attempts; exceeding the budget is treated as a failed attempt and escalates rather than running unbounded.
- **NFR-5 (No self-modification):** No auto-applied fix may modify the guardrail/enforcement sources that constrain it, or their tests. This is enforced in code (REQ-015) and proven adversarially before the pilot runs repo-wide.

## Dependency Map

| Requirement | Depends On | Blocked By | Notes |
|---|---|---|---|
| REQ-009 | — | — | Prerequisite; makes the shipped pipeline reachable in production |
| REQ-010 | REQ-009, REQ-002 | — | Predicate must match what the translator actually emits |
| REQ-011 | REQ-009 | — | Mutation enforcement must exist before any `auto` behavior loads |
| REQ-012 | — | — | Schema field the auto-fix loop reads |
| REQ-013 | — | — | Removes the hardcoded `packages/` assumption |
| REQ-001 | — | — | Foundational signal widening |
| REQ-002 | REQ-001, REQ-013 | — | Needs command/isError on the payload, and portable discovery |
| REQ-003 | REQ-002, REQ-009 | — | Needs a translated event and an activated pipeline |
| REQ-004 | REQ-011 | — | Mode semantics build on enforced mutation classes |
| REQ-005 | REQ-003, REQ-004, REQ-015 | — | Auto-apply requires matching, enforced `auto`, and a write boundary |
| REQ-006 | REQ-005 | — | Needs a fail/reject signal to count retries against |
| REQ-007 | REQ-004, REQ-014 | — | Needs enforced `propose` mode and a fail-closed gate |
| REQ-014 | — | — | Independent; gates REQ-007 |
| REQ-015 | REQ-004 | — | Write boundary layered on enforced mode semantics |
| REQ-016 | REQ-005 | — | Applies only to accepted fixes |
| REQ-008 | REQ-002 through REQ-007, REQ-012, REQ-013 | — | Cross-cutting constraint on all of the above |

## Implementation Sequencing

Build order is not the requirement-number order. Requirements REQ-009 through REQ-011 repair defects in already-delivered work and must land first; shipping unreviewed auto-apply on top of an unenforced mutation model would be the riskiest possible ordering.

1. **Remediation:** REQ-009 (activate the pipeline), REQ-011 (enforce mutation classes), and the conformance half of REQ-010 (AC-010-2, AC-010-3 — the fixture-constructibility rule, which fails loudly against today's `exit_code` fixture and pins the defect in place).
2. **Enabling schema/discovery:** REQ-012, REQ-013.
3. **Signal and translation:** REQ-001, REQ-002 — then close out REQ-010's AC-010-1, which can only be verified once the translator exists to produce the event the predicate must match.
4. **Matching and mode semantics:** REQ-003, REQ-004.
5. **Safety boundary before auto-apply:** REQ-014, REQ-015, REQ-016.
6. **Auto-fix loop last:** REQ-005, REQ-006, REQ-007, validated end-to-end by REQ-008.

A standing convention adopted from this review: **a requirement is not done until it is reachable from the product entry point**, asserted by a test that runs through `activate()`. Unit-test coverage of an unreachable library is not delivery.

## Constitution Compliance

**Rule 4** ("Ensemble must not implement durable production activation, scheduling, retries, recovery, or a second dispatcher competing with Foreman") — evaluated against architecture doc §1 and §8.

**Determination: PASS**, firm, non-conditional on future review — but structurally dependent on AC-003-3, AC-003-4, and NFR-1 remaining enforced, not merely descriptive. REQ-009's activation work does not alter this determination: it makes the already-sanctioned compile/load path reachable, and adds no durable or cross-session state.

A distinction stated precisely, not glossed over: the already-shipped `LocalRunner` executes one bounded step *inside an already-triggered* behavior — it never decides which behavior fires. This PRD's `LocalEventMatcher` does decide which behavior to invoke in response to an observed event — an activation decision, structurally closer to what `dispatch_production_behavior` names than to `LocalRunner`'s narrower scope. That distinction is real; `LocalEventMatcher`'s compliance cannot be inherited from `LocalRunner`'s precedent and must stand on its own.

Reasoning for PASS on its own terms:
- §8's "Preferred Ensemble responsibilities" explicitly lists `match(event, catalog)` — the operation `LocalEventMatcher` performs — as sanctioned, not prohibited.
- §8's named anti-patterns are `start_durable_activation(...)` and `dispatch_production_behavior(...)`, both explicitly "production-looking": they ingest durable, production-scope events independent of any live session and decide activation across an arbitrary production behavior population under Foreman's authority. `LocalEventMatcher` only ever matches events sourced from the current live session's own native tool activity, against the current repo's compiled behaviors, within that session's lifetime alone.
- §1's banned list qualifies retries/recovery/scheduling with "production." REQ-006's 3-attempt retry is in-memory, non-persistent, and scoped to one session (NFR-1).
- The naming convention required by §8 ("explicit and named as local/simulation-only") is honored: the component is named `LocalEventMatcher`, not "dispatcher," anywhere in this PRD, the schema, or the implementation.
- Non-durability of the activation decision itself — not just the retry counter — is now an explicit, independently testable acceptance criterion (AC-003-4), not inherited or assumed from `LocalRunner`.

If implementation drifts from AC-003-3, AC-003-4, or NFR-1 (e.g. `LocalEventMatcher` gains a background process, a persisted queue, or cross-session state), this PASS determination no longer holds and the gate must be re-run.

## Approvals and Decision Ownership

- **Approver:** the PRD's author (solo-scale project). Acceptance criterion: a deliberately broken test in this repo is watched, end-to-end, being auto-fixed.

## Entry and Exit Criteria

- **Entry:** `PRD-2026-0fc1c1d0`'s schema, compiler, typed domain-tool vocabulary, and outbox exist. They are **not** accepted as sound prerequisites: REQ-009, REQ-010, and REQ-011 must remediate the pipeline-activation, example-triggerability, and mutation-enforcement defects before any other feature area begins.
- **Exit:** A deliberately broken test in this repo is detected, translated, matched, auto-fixed, full-suite re-verified green without any test file being modified, committed to a non-default branch with full attribution, and a constitution-change proposal is gated behind an inline yes/no before any PR is opened. Additionally: an adversarial candidate targeting a protected path is refused in code, and a rejected candidate leaves the working tree byte-identical to its pre-attempt state. All demonstrated live in this repo before this package is installed in any other repo (e.g. Foreman).
