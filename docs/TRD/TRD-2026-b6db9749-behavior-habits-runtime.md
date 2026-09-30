---
document_id: TRD-2026-b6db9749
label: trd-behavior-habits-runtime
kind: trd
prd_reference: PRD-2026-b6db9749
prd_path: docs/PRD/PRD-2026-b6db9749-behavior-habits-runtime.md
version: 1.0.0
status: Draft
date: 2026-09-30
design_readiness_score: 4.25
---

# TRD-2026-b6db9749: Ensemble Behavior and Habits Runtime — Extensibility, Communication, and Cross-Platform Verification

Source PRD: [PRD-2026-b6db9749](../PRD/PRD-2026-b6db9749-behavior-habits-runtime.md) (readiness 4.5, PASS).

## Reused Capabilities

The following existing, verified capabilities are reused, not rebuilt:

| Capability | Source | Reused for |
|---|---|---|
| `LocalEventMatcher` (in-session, non-durable event-to-behavior matching) | `packages/agent-core/src/behavior/local-event-matcher.ts` | PR 1 — new trigger-source events enter through the same matcher, no second dispatcher |
| `CommandRegistry` + `MutationGuard` (single enforcement seam) | `packages/agent-core/src/cqrs/command-registry.ts`, `packages/agent-core/src/behavior/mutation-guard.ts` | PR 7 — new `fix.apply` command follows the same authorization path as every existing command |
| `ApprovalGate` + `SessionUiBridge` (fail-closed inline approval) | `packages/agent-core/src/behavior/approval-gate.ts`, `packages/pi-extension/src/session-ui.ts` | PR 7 — the same mechanism already gating `constitution.apply` gates the new `fix.apply` |
| `AgentPort` / `createAgentPort` (bounded, tool-scoped, isolated-worktree agent invocation) | `packages/pi-extension/src/agent-port.ts` | PR 2 — the existing `investigate` step's mechanism is hardened, not rebuilt |
| `ctx.ui.notify` (existing one-way notification primitive, `console.log` fallback) | `packages/pi-extension/src/extension.ts` (existing call sites) | PR 3 — the new notification-state module wraps this primitive; it is not reinvented |
| `runtime-status.ts` (pull-based lifecycle/status report) | `packages/pi-extension/src/runtime-status.ts` | PR 8 — extended to a role-agnostic plain-text surface |
| Workflow interpreter (`agent`/`command`/`condition`/`approval`/`outcome` steps) | `packages/agent-core/src/workflow/interpreter.ts` | PR 4, PR 5 — new reference behaviors are authored as declarative package data using existing step types; no new step type is added |
| Event translation structure (`pi-events.ts` → `event-translator.ts` → `normalizeEvent`) | `packages/agent-core/src/behavior/event-translator.ts` | PR 1 — the *structure* (adapter → normalize → matcher) is mirrored for new source types; the adapters themselves are new files (Option B) |

**One explicit non-reuse**, matching the precedent `TRD-2026-15aa5acd` set for its own non-reuse note: `packages/pi-extension/tests/portability.e2e.test.ts` already covers cross-repository / cross-language-runner portability (REQ-008/REQ-BEH-005 — no `packages/` directory, a non-npm `mix test` runner). This TRD's PR 10 (Windows/Linux/macOS conformance) is a **different axis** — operating-system portability, not repository-layout portability — and does not reuse that test or its fixtures. The two concerns are related in spirit (don't claim portability without evidence) but independent in mechanism.

`node packages/development/lib/trd-graph-cli.js capabilities docs/TRD --json` returns an empty registry (no `kind: foundational` TRD exists in this repo), consistent with `TRD-2026-15aa5acd`'s own finding — there is no foundational TRD to declare a dependency on via that mechanism; the reuse above is documented directly instead.

## Architecture Decision

**Chosen: Option B — dedicated adapter modules per new trigger-source type, plus a shared notification-state module.**

New `file-source-adapter.ts` and `release-source-adapter.ts` (under `packages/agent-core/src/behavior/`) each produce a `BehaviorEvent`, mirroring the existing `pi-events.ts` → `event-translator.ts` → `normalizeEvent` → `LocalEventMatcher` structure — adding adapter modules rather than widening the existing tool-result-scoped translator. A new `notification-state.ts` centralizes busy/duplicate/stale tracking around the existing `ctx.ui.notify` primitive, benefiting the already-shipped test-failure behavior as well as the two new reference behaviors. Quarantine gets its own small `package-quarantine.ts` beside `package-discovery.ts`.

### Alternatives considered

| Option | Summary | Why not chosen |
|---|---|---|
| **A — Widen the existing translator, inline notification** | Add file/release branches inside `event-translator.ts`; keep notification-state logic local to each `ctx.ui.notify` call site. | `event-translator.ts` would cover three unrelated source domains in one module; notification busy/dup/stale logic would be duplicated per behavior — reproducing the exact per-reaction duplication problem this PRD's Product Summary names as the thing to fix. |
| **B — Dedicated adapter modules + shared notification-state module** *(chosen)* | New adapter module per source type, all feeding the same ingress; one shared notification-state module for all behaviors. | Matches the existing module boundary convention (`agent-core` = provider-neutral logic, `pi-extension` = host-specific wiring); centralizes notification-state once instead of per-behavior. |
| **C — Single generic "external signal" adapter** | One configurable "watch path X for condition Y" abstraction covers both new source types. | Risks becoming an arbitrary-condition escape hatch against the closed, versioned event catalog (REQ-CQRS-005 / REQ-BEH-002); still leaves notification-state duplicated per call site. |

## Domain Analysis

**Technical domains touched:** event ingestion/adapters (new), CQRS command registry (extending with one new command), approval/authorization (reusing existing), agent-session invocation (hardening existing), CI/cross-platform verification (new), observability/status reporting (extending existing).

**Brownfield.** This extends the already-shipped `agent-core`/`pi-extension` packages built by `PRD-2026-0fc1c1d0` and `PRD-2026-15aa5acd`, refined by the `br-behavior-runtime-cqrs-xl24` epic. Verified directly against source (not against PRD/TRD planning text alone, which in `TRD-2026-15aa5acd`'s case was found to be partially stale relative to current implementation): `LocalEventMatcher`, `CommandRegistry`, `MutationGuard`, `ApprovalGate`, `SessionUiBridge`, `AgentPort`, `ctx.ui.notify`, and `runtime-status.ts` all exist and are exercised by passing tests today (see Reused Capabilities above).

**Companion domain detected:** none requiring a separate data-model document — this TRD's new state (quarantine flag, notification-state tracking, turnaround timestamps) is small enough to fold into the existing schemas it extends, unlike `TRD-2026-0fc1c1d0`'s companion `-data-model.md`.

## System Architecture

### Components

```text
packages/agent-core/src/behavior/
  +-- file-source-adapter.ts      - NEW: file/artifact-change -> BehaviorEvent
  +-- release-source-adapter.ts   - NEW: release signal -> BehaviorEvent
  +-- event-translator.ts         - existing, UNCHANGED (tool-result scope only)
  +-- local-event-matcher.ts      - existing, UNCHANGED (reused as-is)
  +-- package-quarantine.ts       - NEW: quarantine record, checked at discovery time
  +-- package-discovery.ts        - existing, MODIFIED (checks quarantine before returning a package)
  +-- approval-gate.ts            - existing, UNCHANGED (reused by fix.apply)

packages/agent-core/src/cqrs/
  +-- command-registry.ts         - existing, MODIFIED (registers fix.apply descriptor)

packages/pi-extension/src/
  +-- notification-state.ts       - NEW: busy/duplicate/stale tracking around ctx.ui.notify
  +-- agent-port.ts               - existing, MODIFIED (LLM-unreachable failure path, orphan cleanup on timeout)
  +-- runtime-status.ts           - existing, MODIFIED (plain-text/no-dev-tooling surface)
  +-- extension.ts                - existing, MODIFIED (wires new adapters/commands/notification-state)

packages/<domain>/behaviors/<behavior-id>/
  +-- documentation-freshness/    - NEW: package data only (behavior.yaml + prompts), no new TypeScript
  +-- coverage-regression/        - NEW: package data only, proves REQ-004/REQ-018/REQ-028
```

### Data flow

1. A file/artifact change or a release signal occurs. The corresponding new adapter (`file-source-adapter.ts` / `release-source-adapter.ts`) produces a `BehaviorEvent`, exactly as `event-translator.ts` does today for tool-results.
2. The event passes through the same `normalizeEvent` validation and reaches `LocalEventMatcher` — no new dispatcher, no new ingress point.
3. A matched behavior (documentation-freshness or coverage-regression, authored as package data using existing `agent`/`command`/`condition`/`outcome` workflow steps) runs its investigation via the existing `AgentPort`, now hardened against an unreachable model provider and against orphaned processes on timeout.
4. A user-relevant result is reported through `notification-state.ts`, which wraps `ctx.ui.notify` with busy/duplicate/stale tracking, never claiming an unverified outcome.
5. If a code-fix candidate exists and passes verification, `fix.apply` (new typed command, `CommandRegistry`-registered, `MutationGuard`-checked) becomes callable — but only proceeds after `ApprovalGate` returns `approved: true`. Rejection leaves the working tree byte-identical, mirroring the existing rejected-candidate guarantee.
6. A finding from any authorized behavior (investigator, documentation-freshness, coverage-regression) can now source a `constitution.propose` evidence payload, refused if it originates from a quarantined package (`package-quarantine.ts` checked at discovery time, before any event can reach that package's behaviors at all).
7. `runtime-status.ts`'s rendering is extended into a surface reachable without developer tooling, so a PM/QA role can see active behaviors and dispatch decisions.
8. The whole path above is run against Windows, Linux, and macOS CI runners independently; no cross-platform claim is made without that per-OS run's own evidence.

### Integration points

- **Pi extension API** (external dependency, unchanged from prior TRDs): no new required capability beyond what `TRD-2026-0fc1c1d0`/`TRD-2026-15aa5acd` already documented as available (`ui.notify`, `ui.confirm`, tool registration, lifecycle hooks).
- **OMP adapter**: PR 12 adds its own independent conformance suite; no shared-YAML-alone parity claim.
- **Foreman protocol (future)**: out of scope, as in both prior PRDs; PR 12 only reaffirms Ensemble never asserts Foreman commitment from a local result.

## Master Task List

### PR 1: Trigger-source extensibility

**Shippable State:** A behavior package can be triggered by a file/artifact change or a release signal, validated through the existing canonical ingress, and a third behavior reusing an existing source type requires zero new Ensemble code.

- [ ] **TRD-001** Extend the behavior-package trigger schema for file/artifact predicates, then implement `file-source-adapter.ts`: watched-path-change → validated `BehaviorEvent` (5h) [satisfies REQ-001] [depends: none]
  - Target Files: `packages/agent-core/src/behavior/schema.ts` (add `file_change` trigger predicate shape), `packages/agent-core/src/behavior/file-source-adapter.ts`
  - Validates PRD ACs: AC-001-1, AC-001-2
  - Implementation AC:
    - [ ] Given a `file_change` trigger predicate in `behavior.yaml`, when the manifest is validated, then the schema accepts it as a first-class predicate shape, not a raw/untyped field.
    - [ ] Given a behavior package configured with a file/artifact-based trigger, when the watched artifact changes, then the adapter calls the same `normalizeEvent` entry point tool-result events use.
    - [ ] Given no supported host API can observe the configured change, when the package is validated, then it fails closed with a named diagnostic, never a silent no-op trigger.
- [ ] **TRD-001-TEST** Adapter unit + fail-closed tests (2h) [verifies TRD-001] [satisfies REQ-001] [depends: TRD-001]
  - Target Files: `packages/agent-core/tests/file-source-adapter.test.ts`
  - Test AC:
    - [ ] Scenario: watched-path change produces a validated event indistinguishable in shape from a tool-result-derived event.
    - [ ] Scenario: unobservable change configuration fails validation with a specific field-level error.
- [ ] **TRD-002** Implement `release-source-adapter.ts`: release signal → validated `BehaviorEvent` (4h) [satisfies REQ-002] [depends: none]
  - Target Files: `packages/agent-core/src/behavior/release-source-adapter.ts`
  - Validates PRD ACs: AC-002-1, AC-002-2
  - Implementation AC:
    - [ ] Given a release-based trigger and a real release occurs, when the adapter runs, then a canonical event carries the release identity as evidence.
    - [ ] Given no release occurs, when other events are evaluated, then no release-triggered behavior fires.
- [ ] **TRD-002-TEST** Release adapter tests (2h) [verifies TRD-002] [satisfies REQ-002] [depends: TRD-002]
  - Target Files: `packages/agent-core/tests/release-source-adapter.test.ts`
  - Test AC:
    - [ ] Scenario: a real release event produces a matching canonical event.
    - [ ] Scenario: absence of a release never fires a release-triggered behavior.
- [ ] **TRD-003** Wire both adapters exclusively through the existing single validated ingress; reject any direct-dispatch attempt; measure dispatch latency; bound the event backlog (5h) [satisfies REQ-003] [depends: TRD-001, TRD-002]
  - Target Files: `packages/agent-core/src/behavior/local-event-matcher.ts` (import-boundary enforcement, bounded-backlog handling), `packages/agent-core/src/normalize.ts`
  - Validates PRD ACs: AC-003-1, AC-003-2
  - Implementation AC:
    - [ ] Given an event from either new adapter, when ingested, then it passes identical schema/provenance/freshness validation as an existing tool-result-derived event.
    - [ ] Given a source adapter attempts to call a behavior directly, bypassing ingress, when attempted, then the call is rejected.
    - [ ] Given NFR-001 has no confirmed target from elicitation, when dispatch runs (event validated → matched → run created), then the actual p99 latency is measured and reported, establishing the missing baseline rather than asserting an arbitrary pass/fail threshold.
    - [ ] Given NFR-002's bounded-backlog requirement, when the in-memory event queue reaches its configured bound, then the oldest non-in-progress queued event is dropped with a visible diagnostic — never silently, and never growing without limit.
- [ ] **TRD-003-TEST** Ingress-parity, direct-dispatch-rejection, latency-measurement, and bounded-backlog tests (3h) [verifies TRD-003] [satisfies REQ-003] [depends: TRD-003]
  - Target Files: `packages/agent-core/tests/local-event-matcher.test.ts` (extended)
  - Test AC:
    - [ ] Scenario: file- and release-sourced events validate identically to tool-result-sourced events.
    - [ ] Scenario: a direct-dispatch call bypassing ingress is rejected.
    - [ ] Scenario: a synthetic burst beyond the configured bound drops the oldest non-in-progress event with a visible diagnostic, and no unbounded memory growth occurs.
- [ ] **TRD-004** Verify a new behavior using an existing adapter type requires zero Ensemble source changes (3h) [satisfies REQ-004] [depends: TRD-001, TRD-002, TRD-012, TRD-013]
  - Target Files: `packages/agent-core/tests/config-only-behavior-addition.test.ts`
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Implementation AC:
    - [ ] Given the file-source adapter already exists, when a new behavior package uses it with a new predicate, then no Ensemble code change is required.
    - [ ] Given documentation-freshness and coverage-regression are both added, when diffed, then neither required an Ensemble source change beyond the two new adapter modules.
- [ ] **TRD-004-TEST** Config-only-addition regression test (2h) [verifies TRD-004] [satisfies REQ-004] [depends: TRD-004]
  - Target Files: same as TRD-004
  - Test AC:
    - [ ] Scenario: git diff of Ensemble source (excluding the two adapter modules and package data) is empty after both reference behaviors are added.

### PR 2: Read-only investigator hardening

**Shippable State:** An investigator session's finding is safe to use as evidence (constitution-proposal or otherwise), with proven timeout, offline-model, and orphan-cleanup behavior — not just a happy-path demo.

- [ ] **TRD-005** Add explicit LLM-unreachable failure handling to `AgentPort` (3h) [satisfies REQ-005] [depends: none]
  - Target Files: `packages/pi-extension/src/agent-port.ts`
  - Validates PRD ACs: AC-005-3
  - Implementation AC:
    - [ ] Given the model provider is unreachable, when an investigator session is invoked, then it fails with a distinct, visible error state within a bounded timeout.
    - [ ] Given the same condition, when checked, then no stale or fabricated finding is ever returned.
- [ ] **TRD-005-TEST** Offline/unreachable-provider tests (2h) [verifies TRD-005] [satisfies REQ-005] [depends: TRD-005]
  - Target Files: `packages/pi-extension/tests/agent-port.test.ts` (extended)
  - Test AC:
    - [ ] Scenario: simulated unreachable provider yields a bounded, distinct failure, never a hang.
- [ ] **TRD-006** Add orphan-cleanup verification for investigator timeout / host-shutdown (3h) [satisfies REQ-006] [depends: none]
  - Target Files: `packages/pi-extension/src/agent-port.ts`, `packages/pi-extension/src/shutdown-cancellation.ts` (existing)
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-006-3, AC-006-4
  - Implementation AC:
    - [ ] Given a read-only tool grant, when a native write is attempted, then it is blocked at the enforcement boundary (already covered by existing `write-sandbox.ts`; verify, do not rebuild).
    - [ ] Given a shell-based write attempt, when it occurs, then it is still blocked at the runtime boundary.
    - [ ] Given an investigator session times out or its host session shuts down, when cleanup runs, then no orphan process or session remains.
- [ ] **TRD-006-TEST** Adversarial fixture + orphan-cleanup tests (3h) [verifies TRD-006] [satisfies REQ-006] [depends: TRD-006]
  - Target Files: `packages/pi-extension/tests/hostile-tools.e2e.test.ts` (extended), `packages/pi-extension/tests/shutdown-cancellation.test.ts` (extended)
  - Test AC:
    - [ ] Scenario: adversarial fixture attempting write-through-shell against a read-only investigator is refused, proving the boundary rather than asserting it.
    - [ ] Scenario: process-listing after a timed-out investigator session shows no orphan.
- [ ] **TRD-007** Structure investigator findings as distinct from verified fixes (2h) [satisfies REQ-007] [depends: none]
  - Target Files: `packages/agent-core/src/workflow/interpreter.ts` (outcome typing, no new step type)
  - Validates PRD ACs: AC-007-1, AC-007-2
  - Implementation AC:
    - [ ] Given an investigator produces a finding, when recorded, then it is never represented as "applied" or "verified fix."
    - [ ] Given a finding references evidence, when inspected, then it is bounded and does not leak secrets.
- [ ] **TRD-007-TEST** Finding-vs-fix-result distinction tests (2h) [verifies TRD-007] [satisfies REQ-007] [depends: TRD-007]
  - Target Files: `packages/agent-core/tests/workflow-interpreter.test.ts` (extended)
- [ ] **TRD-008** Wire investigator findings as `constitution.propose` evidence source (3h) [satisfies REQ-008] [depends: TRD-007]
  - Target Files: `packages/agent-core/src/cqrs/decision-memory.ts`, `packages/agent-core/src/cqrs/proposal-store.ts`
  - Validates PRD ACs: AC-008-1, AC-008-2
  - Implementation AC:
    - [ ] Given an investigator finding identifies a candidate constitution rule gap, when a proposal is drafted, then it cites the finding as evidence.
    - [ ] Given such a proposal reaches apply, then it passes the same interactive approval gate as any other constitution-change proposal.
- [ ] **TRD-008-TEST** Investigator-sourced proposal tests (2h) [verifies TRD-008] [satisfies REQ-008] [depends: TRD-008]
  - Target Files: `packages/agent-core/tests/decision-propose.test.ts` (extended)

### PR 3: Notification-state module

**Shippable State:** Any behavior's result notification goes through one shared, evidence-verified, state-aware path instead of ad hoc `ctx.ui.notify` calls scattered per behavior.

- [ ] **TRD-009** Implement `notification-state.ts`: evidence-backed wrapper around `ctx.ui.notify` (5h) [satisfies REQ-009, REQ-012] [depends: none]
  - Target Files: `packages/pi-extension/src/notification-state.ts`
  - Validates PRD ACs: AC-009-1, AC-009-2, AC-012-1
  - Implementation AC:
    - [ ] Given a behavior produces a user-relevant result, when it completes, then the main session receives a concise message referencing specific evidence.
    - [ ] Given the message is delivered, when inspected, then it never claims an action was applied unless independently verified.
    - [ ] Given a message states an outcome, when reviewed, then every asserted fact traces to recorded evidence.
- [ ] **TRD-009-TEST** Evidence-backed notification content tests (2h) [verifies TRD-009] [satisfies REQ-009, REQ-012] [depends: TRD-009]
  - Target Files: `packages/pi-extension/tests/notification-state.test.ts`
- [ ] **TRD-010** Add busy/delivered/duplicate/unavailable delivery-state tracking (4h) [satisfies REQ-010] [depends: TRD-009]
  - Target Files: `packages/pi-extension/src/notification-state.ts`
  - Validates PRD ACs: AC-010-1, AC-010-2, AC-010-3
  - Implementation AC:
    - [ ] Given the main session is busy, when notification is attempted, then delivery is reported busy, never silently dropped or retried indefinitely.
    - [ ] Given a duplicate identical notification arrives, when processed, then it is recognized as a duplicate.
    - [ ] Given the host cannot report a given state, when this gap exists, then it is documented as unsupported, not assumed handled.
- [ ] **TRD-010-TEST** Delivery-state tests (3h) [verifies TRD-010] [satisfies REQ-010] [depends: TRD-010]
  - Target Files: `packages/pi-extension/tests/notification-state.test.ts` (extended)
- [ ] **TRD-011** Add duplicate/stale suppression keyed on workspace fingerprint (3h) [satisfies REQ-011] [depends: TRD-010]
  - Target Files: `packages/pi-extension/src/notification-state.ts`, `packages/agent-core/src/behavior/workspace-snapshot.ts` (existing, read-only reuse)
  - Validates PRD ACs: AC-011-1, AC-011-2
  - Implementation AC:
    - [ ] Given two notifications reference the same event/evidence, when the second arrives, then no second local run is created.
    - [ ] Given the workspace fingerprint has since changed, when delivered, then it is marked stale, not acted on as current.
- [ ] **TRD-011-TEST** Duplicate/stale-notification tests (2h) [verifies TRD-011] [satisfies REQ-011] [depends: TRD-011]
  - Target Files: `packages/pi-extension/tests/notification-state.test.ts` (extended)

### PR 4: Reference behavior — documentation freshness

**Shippable State:** A release event triggers detection of stale documentation surfaces, and the main session is notified naming the specific file — no auto-mutation.

- [ ] **TRD-012** Author `documentation-freshness` behavior package: `behavior.yaml` + prompts, using existing `agent`/`condition`/`outcome` steps (6h) [satisfies REQ-013, REQ-014, REQ-015] [depends: TRD-002, TRD-009]
  - Target Files: `packages/<domain>/behaviors/documentation-freshness/behavior.yaml`, `.../prompts/*.md`, `.../fixtures/*`
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-014-1, AC-015-1
  - Implementation AC:
    - [ ] Given a release-based trigger fires, when documentation is checked, then specific stale surfaces are identified as evidence.
    - [ ] Given no stale documentation is found, when the behavior completes, then no notification is sent.
    - [ ] Given stale documentation is identified, when notified, then the message names the specific file/section.
    - [ ] Given this behavior is reviewed, then it required only package configuration and the existing file/release adapters — no other Ensemble source change.
- [ ] **TRD-012-TEST** Documentation-freshness conformance fixtures (3h) [verifies TRD-012] [satisfies REQ-013, REQ-014, REQ-015] [depends: TRD-012]
  - Target Files: `packages/<domain>/behaviors/documentation-freshness/fixtures/{events,expected-matches,expected-outcomes}/`

### PR 5: Reference behavior — coverage regression (extensibility proof)

**Shippable State:** Test-coverage regressions are detected and reported automatically, and a developer has a concrete, timed record that adding this third behavior required zero Ensemble source diffs.

- [ ] **TRD-013** Author `coverage-regression` behavior package (6h) [satisfies REQ-016, REQ-017] [depends: TRD-001, TRD-009]
  - Target Files: `packages/<domain>/behaviors/coverage-regression/behavior.yaml`, `.../prompts/*.md`, `.../fixtures/*`
  - Validates PRD ACs: AC-016-1, AC-016-2, AC-017-1
  - Implementation AC:
    - [ ] Given a coverage report artifact changes, when compared to baseline, then a configured-threshold decrease is detected as evidence. [NEEDS CLARIFICATION carried from PRD REQ-016: exact coverage metric — line/branch/statement/function — resolved here against this repo's existing Jest coverage output shape]
    - [ ] Given coverage is flat or improved, when the behavior runs, then no notification is sent.
    - [ ] Given a regression is detected, when notified, then the message states the specific delta and affected file/module.
- [ ] **TRD-013-TEST** Coverage-regression conformance fixtures (3h) [verifies TRD-013] [satisfies REQ-016, REQ-017] [depends: TRD-013]
  - Target Files: `packages/<domain>/behaviors/coverage-regression/fixtures/{events,expected-matches,expected-outcomes}/`
- [ ] **TRD-014** Record and verify config-only addition + timed turnaround for this third behavior (3h) [satisfies REQ-018, REQ-028] [depends: TRD-013, TRD-023]
  - Target Files: `packages/agent-core/tests/config-only-behavior-addition.test.ts` (extended, shared with TRD-004)
  - Validates PRD ACs: AC-018-1, AC-028-1
  - Implementation AC:
    - [ ] Given the file-source adapter and notification primitives already exist, when this behavior is added, then it is a package/config artifact with zero Ensemble source diffs.
    - [ ] Given the infrastructure from PR 1-3 exists, when this behavior is added, then it is verified end-to-end without any Ensemble source file being edited.
- [ ] **TRD-014-TEST** Zero-diff verification test (2h) [verifies TRD-014] [satisfies REQ-018, REQ-028] [depends: TRD-014]

### PR 6: Constitution-gate broadening, quarantine, and evidence integrity

**Shippable State:** Constitution-amendment proposals can originate from any authorized behavior's evidence; quarantined packages cannot poison that evidence; quarantine itself survives restarts within the checkout.

- [ ] **TRD-015** Broaden `constitution.propose` to accept evidence from any authorized behavior, not only the fix loop (4h) [satisfies REQ-019] [depends: TRD-008]
  - Target Files: `packages/agent-core/src/cqrs/proposal-store.ts`, `packages/agent-core/src/cqrs/event-authority.ts`
  - Validates PRD ACs: AC-019-1
  - Implementation AC:
    - [ ] Given a finding from the investigator or a reference behavior is used as evidence, when a proposal is drafted, then it is accepted by the same gate the fix-loop-sourced proposals already use.
- [ ] **TRD-015-TEST** Multi-source proposal acceptance tests (2h) [verifies TRD-015] [satisfies REQ-019] [depends: TRD-015]
  - Target Files: `packages/agent-core/tests/decision-propose.test.ts` (extended)
- [ ] **TRD-016** Reaffirm human-approval-required for every constitution-change source (2h) [satisfies REQ-020] [depends: TRD-015]
  - Target Files: `packages/pi-extension/src/constitution-apply-boundary.ts` (existing)
  - Validates PRD ACs: AC-020-1, AC-020-2
  - Implementation AC:
    - [ ] Given a constitution-change proposal from any evidence source, when it reaches apply, then an explicit inline yes/no is required before any PR opens (already covered by existing `constitution-apply-boundary.ts`; regression-test across the newly broadened sources, do not rebuild).
    - [ ] Given no confirmation, when evaluated, then `constitution.md` remains unmodified.
- [ ] **TRD-016-TEST** Cross-source approval-gate regression tests (2h) [verifies TRD-016] [satisfies REQ-020] [depends: TRD-016]
  - Target Files: `packages/pi-extension/tests/constitution-apply-boundary.test.ts` (extended)
- [ ] **TRD-017** Implement `package-quarantine.ts`: reject-and-quarantine persists within the local checkout across restarts (4h) [satisfies REQ-031] [depends: none]
  - Target Files: `packages/agent-core/src/behavior/package-quarantine.ts`, `packages/agent-core/src/behavior/package-discovery.ts` (modified: checks quarantine before returning a package)
  - Validates PRD ACs: AC-031-1, AC-031-2
  - Implementation AC:
    - [ ] Given a package is quarantined, when the process/session restarts against the same checkout, then it remains quarantined without automatic reload.
    - [ ] Given a quarantined package, when an operator inspects local state, then the quarantine and its cause are visible in plain text.
- [ ] **TRD-017-TEST** Quarantine persistence tests (2h) [verifies TRD-017] [satisfies REQ-031] [depends: TRD-017]
  - Target Files: `packages/agent-core/tests/package-quarantine.test.ts`
- [ ] **TRD-018** Refuse constitution-proposal evidence sourced from a quarantined/rejected package (2h) [satisfies REQ-020 AC-020-3] [depends: TRD-015, TRD-017]
  - Target Files: `packages/agent-core/src/cqrs/proposal-store.ts`
  - Validates PRD ACs: AC-020-3
  - Implementation AC:
    - [ ] Given a finding originates from a quarantined or rejected package, when a proposal is drafted, then it is refused as invalid evidence regardless of approval-gate outcome.
- [ ] **TRD-018-TEST** Quarantined-evidence-refusal test (2h) [verifies TRD-018] [satisfies REQ-020] [depends: TRD-018]

### PR 7: Verified fix application

**Shippable State:** A verified fix candidate can be applied to the working tree for the first time — but only after explicit human approval, with attribution, and with a byte-identical rollback guarantee on rejection.

- [ ] **TRD-019** Add `fix.apply` typed command: `CommandRegistry`-registered, `MutationGuard`-checked, `ApprovalGate`-gated (6h) [satisfies REQ-033] [depends: none]
  - Target Files: `packages/agent-core/src/cqrs/command-registry.ts`, `packages/agent-core/src/cqrs/commands.ts`
  - Validates PRD ACs: AC-033-1
  - Implementation AC:
    - [ ] Given a fix candidate has reached a verified outcome, when application is attempted, then it proceeds only after an explicit approval step distinct from verification.
    - [ ] Given the workspace state has changed since verification (REQ-SAFE-002 revalidation), when apply is attempted even after approval, then the candidate is revalidated against current workspace state and rejected if it no longer applies cleanly — approval alone never substitutes for revalidation.
- [ ] **TRD-019-TEST** Approval-gated apply tests (3h) [verifies TRD-019] [satisfies REQ-033] [depends: TRD-019]
  - Target Files: `packages/agent-core/tests/command-registry.test.ts` (extended)
- [ ] **TRD-020** Verify rejected apply leaves the working tree byte-identical (2h) [satisfies REQ-033] [depends: TRD-019]
  - Target Files: `packages/pi-extension/tests/reference-flow.e2e.test.ts` (extended)
  - Validates PRD ACs: AC-033-2
  - Implementation AC:
    - [ ] Given no approval is given, when evaluated, then the working tree is byte-identical to its pre-proposal state.
- [ ] **TRD-020-TEST** Byte-identical-rejection test (2h) [verifies TRD-020] [satisfies REQ-033] [depends: TRD-020]
- [ ] **TRD-021** Verify approved apply carries attribution to the originating run/event (2h) [satisfies REQ-033] [depends: TRD-019]
  - Target Files: `packages/pi-extension/src/commit-policy.ts` (existing)
  - Validates PRD ACs: AC-033-3
  - Implementation AC:
    - [ ] Given approval is given, when the fix is applied, then the resulting commit carries attribution tracing to the originating behavior run and event.
- [ ] **TRD-021-TEST** Attribution test (2h) [verifies TRD-021] [satisfies REQ-033] [depends: TRD-021]
  - Target Files: `packages/pi-extension/tests/commit-policy.test.ts` (extended)

### PR 8: Cross-role observability

**Shippable State:** A PM or QA role can see which behaviors are active and why a dispatch decision was made, without needing developer tools.

- [ ] **TRD-022** Extend `runtime-status.ts` rendering to a plain-text CLI/file surface reachable without developer tooling (4h) [RISK: may require a new CLI command-registration surface, not just extending the existing render function — reassess after design spike if this grows past 4h] [satisfies REQ-032] [depends: none]
  - Target Files: `packages/pi-extension/src/runtime-status.ts`
  - Validates PRD ACs: AC-032-1, AC-032-2
  - Implementation AC:
    - [ ] Given a PM/QA role with only repo read access, when they check active behaviors, then they do so via a readable file or CLI output, not a debugger.
    - [ ] Given a dispatch decision, when a non-developer inspects it, then the explanation is plain text.
- [ ] **TRD-022-TEST** Role-agnostic observability tests (2h) [verifies TRD-022] [satisfies REQ-032] [depends: TRD-022]
  - Target Files: `packages/pi-extension/tests/runtime-status.test.ts`

### PR 9: Success metric instrumentation

**Shippable State:** Behavior-authoring turnaround time is observable and computed for the third reference behavior, with the missing pre-infrastructure baseline explicitly flagged rather than assumed.

- [ ] **TRD-023** Add observable start/completion timestamps for behavior-authoring (3h) [satisfies REQ-029] [depends: none]
  - Target Files: `packages/agent-core/src/behavior/package-discovery.ts` (timestamp on first discovery), `packages/agent-core/src/behavior/fixture-conformance.ts` (timestamp on first passing conformance run)
  - Validates PRD ACs: AC-029-1
  - Implementation AC:
    - [ ] Given a developer begins authoring a package and later passes conformance, then both timestamps are observable without manual instrumentation.
- [ ] **TRD-023-TEST** Timestamp-observability tests (2h) [verifies TRD-023] [satisfies REQ-029] [depends: TRD-023]
- [ ] **TRD-024** Compute/report turnaround-time metric for the third behavior against available baseline (2h) [satisfies REQ-030] [depends: TRD-023, TRD-014]
  - Target Files: `packages/pi-extension/src/runtime-status.ts` (extended)
  - Validates PRD ACs: AC-030-1
  - Implementation AC:
    - [ ] Given the timestamps exist, when the third reference behavior is added, then turnaround time is computed and reported alongside whatever baseline is available. [NEEDS CLARIFICATION carried from PRD REQ-030: no pre-infrastructure baseline measurement exists; reported as "baseline: not established" rather than a fabricated number]
- [ ] **TRD-024-TEST** Metric-computation test (2h) [verifies TRD-024] [satisfies REQ-030] [depends: TRD-024]

### PR 10: Cross-platform (OS) conformance

**Shippable State:** Developers, PMs, and QA can trust the platform-support claims in project docs — Windows, Linux, and macOS each have their own real, independently-run conformance evidence backing any claim, or an explicit documented gap where support doesn't yet exist.

- [ ] **TRD-025** Run the existing e2e suite on a Linux CI runner; document results (3h) [satisfies REQ-021] [depends: PR 1-9 complete]
  - Target Files: `.github/workflows/` (new or extended matrix job)
- [ ] **TRD-025-TEST** Linux conformance run is itself the test artifact (1h) [verifies TRD-025] [satisfies REQ-021] [depends: TRD-025]
- [ ] **TRD-026** Run the existing e2e suite on a Windows CI runner; document results/gaps (5h) [RISK: 8h+ candidate for further breakdown if path-handling defects surface] [satisfies REQ-021, REQ-023] [depends: PR 1-9 complete]
  - Target Files: `.github/workflows/` (new or extended matrix job)
- [ ] **TRD-026-TEST** Windows conformance run + gap documentation (2h) [verifies TRD-026] [satisfies REQ-021, REQ-023] [depends: TRD-026]
- [ ] **TRD-027** Run the existing e2e suite on a macOS CI runner; document results (3h) [satisfies REQ-021] [depends: PR 1-9 complete]
  - Target Files: `.github/workflows/` (new or extended matrix job)
- [ ] **TRD-027-TEST** macOS conformance run is itself the test artifact (1h) [verifies TRD-027] [satisfies REQ-021] [depends: TRD-027]
- [ ] **TRD-028** Add a no-parity-without-evidence documentation/lint check (2h) [satisfies REQ-022] [depends: TRD-025, TRD-026, TRD-027]
  - Target Files: `scripts/validate-all.js` (extended)
  - Implementation AC:
    - [ ] Given documentation lists a supported platform, when validated, then a corresponding conformance-suite run is required to exist.
- [ ] **TRD-028-TEST** Lint-check regression test (1h) [verifies TRD-028] [satisfies REQ-022] [depends: TRD-028]

### PR 11: Extensibility proof (final integration)

**Shippable State:** All three reference behaviors (test-failure, documentation-freshness, coverage-regression) run end-to-end in a real session with zero unapproved mutations — the PRD's Exit Criteria is met.

- [ ] **TRD-029** End-to-end run of all three reference behaviors with zero unapproved mutations (4h) [satisfies REQ-027] [depends: TRD-012, TRD-013]
  - Target Files: `packages/pi-extension/tests/reference-flow.e2e.test.ts` (extended to cover all three behaviors in one sandboxed repo)
  - Validates PRD ACs: AC-027-1
- [ ] **TRD-029-TEST** Three-behavior integration test (3h) [verifies TRD-029] [satisfies REQ-027] [depends: TRD-029]

### PR 12: Foreman-boundary discipline and OMP conformance

**Shippable State:** Foreman operators (when Foreman is present) can trust that Ensemble never overstates what happened locally as a Foreman-committed fact; OMP users get their own independently verified conformance evidence rather than an inferred Pi-parity claim.

- [ ] **TRD-030** Reaffirm Ensemble never asserts Foreman commitment from a local result alone (2h) [satisfies REQ-026] [depends: none]
  - Target Files: `packages/agent-core/src/cqrs/event-authority.ts` (existing `acceptLocally`; regression-test only)
  - Validates PRD ACs: AC-026-1
- [ ] **TRD-030-TEST** Local-acceptance-never-Foreman-commitment regression test (1h) [verifies TRD-030] [satisfies REQ-026] [depends: TRD-030]
- [ ] **TRD-031** OMP adapter independent conformance suite (5h) [RISK: dependent on OMP extension-API gap discovery not yet confirmed] [satisfies REQ-024] [depends: none]
  - Target Files: `packages/pi-extension/tests/` (new OMP-specific suite, if the API gap allows)
- [ ] **TRD-031-TEST** OMP conformance suite is itself the test artifact (2h) [verifies TRD-031] [satisfies REQ-024] [depends: TRD-031]
- [ ] **TRD-032** Foreman local-acceptance/queued/delivered/committed contract (3h) [satisfies REQ-025] [depends: none]
  - Target Files: `packages/agent-core/src/cqrs/event-authority.ts` (extended status enum)
- [ ] **TRD-032-TEST** Contract-state regression test (2h) [verifies TRD-032] [satisfies REQ-025] [depends: TRD-032]

## Sprint Planning

### Sprint 1 (calendar time-box)
PR 1, PR 2, PR 3 — trigger-source extensibility, investigator hardening, notification-state foundation.

### Sprint 2
PR 4, PR 5, PR 6 — the two new reference behaviors, constitution-gate broadening, quarantine.

### Sprint 3
PR 7, PR 8, PR 9 — verified-fix application, cross-role observability, success-metric instrumentation.

### Sprint 4
PR 10, PR 11 — cross-platform conformance, final three-behavior integration proof.

### Sprint 5
PR 12 — Foreman-boundary discipline and OMP conformance (Should/Could priority; may slip without blocking the PRD's Exit Criteria, which PR 11 already satisfies).

## Acceptance Criteria Traceability

| REQ-NNN | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | File/artifact-based trigger sources | TRD-001 | TRD-001-TEST |
| REQ-002 | Release-based trigger sources | TRD-002 | TRD-002-TEST |
| REQ-003 | New sources reuse canonical ingress | TRD-003 | TRD-003-TEST |
| REQ-004 | New behavior via existing source type needs no code | TRD-004 | TRD-004-TEST |
| REQ-005 | Read-only investigator mode | TRD-005 | TRD-005-TEST |
| REQ-006 | Investigator cannot mutate workspace | TRD-006 | TRD-006-TEST |
| REQ-007 | Findings distinguishable from verified fixes | TRD-007 | TRD-007-TEST |
| REQ-008 | Findings source constitution proposals | TRD-008 | TRD-008-TEST |
| REQ-009 | Notify/steer main session | TRD-009 | TRD-009-TEST |
| REQ-010 | Delivery-state distinction | TRD-010 | TRD-010-TEST |
| REQ-011 | Duplicate/stale never create duplicate runs | TRD-011 | TRD-011-TEST |
| REQ-012 | Notification content never unverified | TRD-009 | TRD-009-TEST |
| REQ-013 | Detect documentation staleness | TRD-012 | TRD-012-TEST |
| REQ-014 | Notify specific stale surface | TRD-012 | TRD-012-TEST |
| REQ-015 | Composed package, not new code | TRD-012 | TRD-012-TEST |
| REQ-016 | Detect coverage decrease | TRD-013 | TRD-013-TEST |
| REQ-017 | Report specific delta/area | TRD-013 | TRD-013-TEST |
| REQ-018 | Third behavior needs no Ensemble edit | TRD-014 | TRD-014-TEST |
| REQ-019 | Constitution gate accepts any authorized evidence | TRD-015 | TRD-015-TEST |
| REQ-020 | No constitution change without explicit approval | TRD-016, TRD-018 | TRD-016-TEST, TRD-018-TEST |
| REQ-021 | OS conformance (Windows/Linux/macOS) | TRD-025, TRD-026, TRD-027 | TRD-025-TEST, TRD-026-TEST, TRD-027-TEST |
| REQ-022 | No parity claim without per-OS evidence | TRD-028 | TRD-028-TEST |
| REQ-023 | Platform gaps documented, not absorbed | TRD-026 | TRD-026-TEST |
| REQ-024 | OMP independent conformance | TRD-031 | TRD-031-TEST |
| REQ-025 | Local/Foreman state contract | TRD-032 | TRD-032-TEST |
| REQ-026 | Never assert Foreman commitment locally | TRD-030 | TRD-030-TEST |
| REQ-027 | Three behaviors end-to-end, zero unapproved mutation | TRD-029 | TRD-029-TEST |
| REQ-028 | Config-only addition verified | TRD-014 | TRD-014-TEST |
| REQ-029 | Authoring timestamps observable | TRD-023 | TRD-023-TEST |
| REQ-030 | Turnaround metric reported | TRD-024 | TRD-024-TEST |
| REQ-031 | Quarantine persists across restarts | TRD-017 | TRD-017-TEST |
| REQ-032 | Cross-role observability | TRD-022 | TRD-022-TEST |
| REQ-033 | Verified-fix application, approval-gated | TRD-019, TRD-020, TRD-021 | TRD-019-TEST, TRD-020-TEST, TRD-021-TEST |

**Traceability check:** 33 requirements covered, 0 uncovered, 0 orphaned annotations. Mechanically validated: `node packages/development/lib/trd-cli.js parse` against this document returns `ok: true`, 64 tasks parsed, zero warnings.

## Adversarial Review

### Architecture self-critique (3 issues found, all resolved in the task list above)

1. **Missing interface** — TRD-001/TRD-002 originally assumed the behavior-package schema already accepted file/release trigger predicates; it doesn't. Resolved: TRD-001 now explicitly extends `schema.ts` first.
2. **Missing recovery path** — TRD-019 originally covered approval-gating but not REQ-SAFE-002's required revalidation against current workspace state between verification and apply. Resolved: added as an explicit Implementation AC on TRD-019.
3. **Latent cross-platform risk** — the existing `event-translator.ts` shell-command regex patterns are POSIX-oriented; no task fixes this preemptively. Resolution: deliberately deferred rather than speculatively patched — PR 10 runs real CI evidence first (consistent with this repo's own "no claim without evidence" discipline); TRD-026 already carries an explicit `[RISK: 8h+ candidate]` flag for exactly this contingency rather than a false sense of completeness.

### Task coverage analysis

Every PRD REQ-NNN (33/33) has at least one implementation task and one test task, verified both manually (traceability matrix above) and mechanically (`trd-cli.js parse`, zero warnings). No TRD task references a nonexistent REQ-NNN.

**Gap found and resolved:** NFR-001 (dispatch latency) and NFR-002 (bounded-queue overflow) had zero verifying tasks. Resolved by extending TRD-003/TRD-003-TEST to measure/report latency (establishing the missing baseline rather than asserting an unconfirmed threshold) and to enforce/test the bounded-backlog behavior.

**Gap found and resolved:** PR 10 and PR 12's Shippable State lines originally read as documentation/evidence-focused rather than clearly user-observable capability. Reworded to name who benefits and what they can now trust.

No task is estimated at 8h+ outright; TRD-026 (5h) carries an explicit risk flag for growth past that line rather than a hidden one.

### Dependency and estimate review

**Dependency issue found and resolved:** TRD-029 (three-behavior integration) depended on TRD-014 (config-only/timing verification) unnecessarily; it only needs TRD-013's working behavior. Removed that edge, shortening the critical path by one hop. No circular dependencies were found across all 64 tasks.

**Estimate issue found and resolved:** TRD-022 (cross-role observability, 4h) may be underestimated if it requires a new CLI command-registration surface rather than extending an existing render function. Flagged with an explicit risk marker rather than left as false confidence. Estimates otherwise cluster consistently by complexity (1-3h for test tasks, 2-6h for implementation tasks).

### Testability review

All Implementation/Test ACs use Given/When/Then phrasing; no subjective terms ("fast", "good", "user-friendly") were found without an accompanying objective check. NFR-001's originally-unconfirmed latency target is handled honestly: TRD-003 measures and reports the real figure rather than asserting a fabricated pass/fail threshold. REQ-030's carried-forward clarification marker (no pre-infrastructure baseline) is preserved verbatim in TRD-024 rather than silently resolved with an invented number.

## Design Readiness Scorecard

| Dimension | Score (1-5) | Rationale |
|---|---|---|
| Architecture completeness | 4 | All components/interfaces/data-flows defined and grounded in verified current source, not assumed from stale PRD/TRD planning text; one cross-platform risk area is deliberately deferred to real CI evidence rather than fully resolved now. |
| Task coverage | 5 | 33/33 REQs covered with both implementation and test tasks, verified mechanically via `trd-cli.js parse` (0 warnings) and manually; the two NFR gaps found during review were closed before scoring. |
| Dependency clarity | 4 | Dependencies are explicit and acyclic; one unnecessary edge was found and removed during review. |
| Estimate confidence | 4 | Estimates are consistent and complexity-proportionate; the two likely-optimistic estimates are explicitly flagged rather than presented with false confidence. |

**Overall: 4.25 — PASS.**

