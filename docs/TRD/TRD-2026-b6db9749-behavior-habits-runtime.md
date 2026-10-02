---
document_id: TRD-2026-b6db9749
label: trd-behavior-habits-runtime
kind: trd
prd_reference: PRD-2026-b6db9749
prd_path: docs/PRD/PRD-2026-b6db9749-behavior-habits-runtime.md
version: 1.1.0
status: Draft
date: 2026-09-30
design_readiness_score: 4.25
constitution_compliance: passed
---

# TRD-2026-b6db9749: Ensemble Behavior and Habits Runtime — Extensibility, Communication, and Cross-Platform Verification

Source PRD: [PRD-2026-b6db9749](../PRD/PRD-2026-b6db9749-behavior-habits-runtime.md) — `docs/PRD/PRD-2026-b6db9749-behavior-habits-runtime.md` (readiness 4.5, PASS).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-30 | Initial draft (commit fb4bce1). |
| 1.1.0 | 2026-09-30 | Update in place. Option B and the 12-PR structure are kept. Every claim was re-checked against source at `ea46931` (after the #107 CQRS cutover). Corrected five stale claims: three modules called "existing" that don't exist, and `fix.apply` / `ApprovalGate`, which already exist. Resolved the PRD's release-signal and coverage-metric clarifications. Named the change-detection mechanism and the notification transport. Added TRD-033, a generic `artifact.compare` command, so the coverage behavior can be pure configuration. Wired the new pieces into `activate()` (Rule 6). Every TEST task now carries `Validates PRD ACs` and at least 3 Given/When/Then scenarios. Recorded the Constitution Gate and added a data-model companion. |

## Reused Capabilities

These existing capabilities were checked against source at `ea46931` and are reused, not rebuilt:

| Capability | Source | Reused for |
|---|---|---|
| `normalizeEvent`, the single closed-catalog ingress; it throws for any uncatalogued type | `packages/agent-core/src/normalize.ts:29` | PR 1: every new source enters here, so no second ingress |
| `LocalEventMatcher.onEvent` (in-session, non-durable matching) | `packages/agent-core/src/behavior/local-event-matcher.ts:75-99` | PR 1: new events use the same matcher, so no second dispatcher |
| Closed event catalog, which already contains `release.proposed/approved/completed` and `test.regression_detected` | `packages/agent-core/src/behavior/event-catalog.ts` | PR 1: the release adapter emits the existing `release.completed`; only `artifact.changed` is new |
| Tool-call-derived event pattern (`repository.changed` derived from a successful git command) | `packages/agent-core/src/behavior/event-translator.ts:425-448`, `trigger-producers.ts` | PR 1: the release adapter's tool-call half mirrors this, and every new trigger type registers a producer so it is never an inert trigger |
| `CommandRegistry`: capability check, mutation check, then `ApprovalGate` for **any** `requiresApproval: true` descriptor | `packages/agent-core/src/cqrs/command-registry.ts:255-296` | PR 6, PR 7 |
| **`fix.apply`, already implemented**: `requiresApproval: true`, class `artifact.write`, requires a passing verification, rejects stale writes | `packages/agent-core/src/cqrs/commands.ts` (`fixApply`), tested in `packages/agent-core/tests/commands.test.ts` and `command-registry.test.ts` | PR 7: nothing reaches it today because no behavior declares it. PR 7 declares it; it does not build it |
| `MutationGuard` policy modes: `propose` and `shadow` deny direct writes, `auto` allows them | `packages/agent-core/src/behavior/mutation-guard.ts:148-168` | PR 7: an apply behavior must run `mode: auto`, and approval is still required on top |
| `ApprovalGate` (fails closed without a UI) + `SessionUiBridge` (`confirm`, `select`) | `packages/agent-core/src/behavior/approval-gate.ts`, `packages/pi-extension/src/session-ui.ts` | PR 3 (adds `notify`), PR 6, PR 7 |
| `AgentPort`: isolated worktree, throwaway HOME, drift detection; reports a cancelled invocation separately from a failed one; always disposes the workspace and HOME | `packages/pi-extension/src/agent-port.ts` (catch/finally near lines 326-337) | PR 2: hardened and verified, not rebuilt |
| Shutdown cancellation: `shutdown.abort()` runs before `drainDispatches()`, and the signal reaches `agent.invoke` | `packages/pi-extension/src/workflow-dispatch.ts`, `packages/pi-extension/src/extension.ts` (session_shutdown); tested in `tests/shutdown-cancellation.test.ts` | PR 2 (AC-006-4) |
| Write confinement (Seatbelt, **macOS only**) | `packages/pi-extension/src/write-sandbox.ts` | PR 2; the gap on other platforms is recorded under PR 10 (REQ-023) |
| `doc.verify` command and the `doc-claim-check` pipeline: a read-only agent extracts claims, then a command adjudicates them | `packages/agent-core/src/cqrs/commands.ts` (`doc.verify`), `.ensemble/behaviors/doc-claim-check/` | PR 4: documentation-freshness reuses this with a release trigger. It is not a duplicate: `doc-claim-check` checks claims in *changed* docs on `repository.changed` |
| `InvocationBudget` (normalised issue key, per-issue and per-session caps) | `packages/pi-extension/src/invocation-budget.ts` | PR 3: the basis for "no duplicate run" (AC-011-1) |
| Workspace fingerprint | `packages/agent-core/src/behavior/workspace-snapshot.ts` | PR 3: staleness (AC-011-2) |
| `renderStatusReport` / `countStates`, including inert triggers ("loaded but cannot fire") | `packages/pi-extension/src/runtime-status.ts`, tested through `tests/package-authoring.e2e.test.ts` | PR 5, PR 8 |
| Package-data-only authoring harness (writes YAML and markdown, runs the real `activate()`) | `packages/pi-extension/tests/package-authoring.e2e.test.ts`, `tests/support/harness.ts` | PR 1, PR 5, PR 11: the zero-code-change proofs are built on it |
| `fixture-conformance.ts` (compares fixture events, matches and outcomes) | `packages/agent-core/src/behavior/fixture-conformance.ts` | PR 4, PR 5 fixtures; PR 9 timestamps |
| `acceptLocally` (`local-session` / `local-outbox`) | `packages/agent-core/src/cqrs/event-authority.ts:343-361` | PR 12 |

**Corrections in 1.1.0.** Three things 1.0.0 called existing are not files:
- `pi-extension/src/constitution-apply-boundary.ts`: the logic lives in `extension.ts` and `commands.ts` (`constitutionApply`).
- `pi-extension/src/shutdown-cancellation.ts`: the logic lives in `workflow-dispatch.ts` and `extension.ts`.
- `pi-extension/tests/agent-port.test.ts`: `AgentPort` coverage is spread across `agent-containment-env`, `dispatch-root`, `drift-fails-closed`, `hostile-tools.e2e` and `sandbox-fails-closed`.

Also: `fix.apply` is not new, and `ApprovalGate` is not specific to `constitution.apply`.

**Name collision to avoid.** `extension.ts` already has a `quarantine` map. It holds single protected-path **writes** that the write boundary reverted, so `/ensemble-approve <id>` can re-apply them. That is unrelated to REQ-031's **package** quarantine. `/ensemble-approve` does **not** call `ApprovalGate` or `CommandRegistry`, and it is not the approval path for `fix.apply` or `constitution.apply`.

**One explicit non-reuse**, following the precedent of `TRD-2026-15aa5acd`. `packages/pi-extension/tests/portability.e2e.test.ts` covers repository-layout portability (a repo with no `packages/`, a `mix test` runner). PR 10 is about operating-system portability. It does not reuse that test.

`node packages/development/lib/trd-graph-cli.js capabilities docs/TRD --json` returns an empty registry: no `kind: foundational` TRD exists. So there is no cross-TRD dependency to declare; reuse is documented directly above.

## Architecture Decision

**Chosen: Option B — dedicated adapter modules per new trigger-source type, plus a shared notification-state module.** Unchanged from 1.0.0.

New `file-source-adapter.ts` and `release-source-adapter.ts` under `packages/agent-core/src/behavior/` each produce a `BehaviorEvent` through `normalizeEvent`, mirroring the existing `pi-events.ts` → `event-translator.ts` → `normalizeEvent` → `LocalEventMatcher` chain. A new `notification-state.ts` in `pi-extension` centralises busy, duplicate and stale tracking for every behavior. Package quarantine gets its own `package-quarantine.ts` beside `package-discovery.ts`.

### Decisions added in 1.1.0

1. **How artifact changes are detected: content hashes checked at lifecycle points.** No `fs.watch`, no new dependency.
   - The adapter derives its watch set from the compiled `artifact.changed` triggers (the `path` predicate).
   - It hashes those files at `tool_result` and at `agent_end`, and emits an event when a digest differs from the last one seen in the session.
   - The hooks it relies on already exist, which is what AC-001-2 means by "supported host API".
   - It behaves the same on every OS (see REQ-023).
   - It needs no new dependency, which constitution §4 would require approval for.

   | Option | Why not chosen |
   |---|---|
   | `fs.watch` | Event semantics differ between macOS, Linux and Windows (rename-vs-change, recursive support). That is exactly the kind of per-platform behavior difference REQ-023 forbids absorbing silently. It also keeps a handle open for the whole session. |
   | `chokidar` | A new runtime dependency (constitution §4), for a problem that lifecycle-point hashing already solves. |

   The limitation, stated rather than hidden: a change is seen at the next tool call or at the end of the run, not instantly. NFR-001 measures from event validation, so this latency is outside its budget. TRD-003 reports it separately.

2. **Release signal (resolves the PRD's REQ-002 clarification): a new `v*` tag in local refs.** This matches this repo's `release.yml` (`on: push: tags: ['v*']`).
   - The tag pattern is a trigger predicate, so repositories with different conventions change configuration, not code (Rule 8).
   - It is detected two ways. First, from a successful tag-creating tool call (`git tag`, `gh release create`), in the same way `repository.changed` is derived today. Second, by diffing tag refs at session start and at `agent_end`, which covers tags that arrive by fetch.
   - It emits the **existing** catalog type `release.completed`, carrying `{ tag, sha, source }`.
   - One tag produces one event per session, whichever path sees it first.

3. **Coverage metric (resolves the PRD's REQ-016 clarification): Jest `json-summary` output, per file, `lines.pct` and `branches.pct` by default.**
   - Each package's `test:coverage` is `jest --coverage`. Jest's default reporters (`json`, `lcov`, `text`, `clover`) produce raw maps, not percentages.
   - So the behavior watches `coverage/coverage-summary.json`, and its README tells repositories to enable `json-summary`.
   - The metrics and the threshold (default 1.0 percentage point) are behavior configuration.
   - If the artifact never appears, the behavior shows up as an inert trigger in `/ensemble-status`; it is never silently idle.
   - The baseline is the previous snapshot seen **in the same session** (Rule 4). The first observation in a session only sets the baseline.

4. **The comparison is a generic command: `artifact.compare` (TRD-033).** It compares numeric JSON paths between the previous and current snapshot of an artifact and knows nothing about coverage.
   - The alternatives were rejected. Doing the comparison in an agent step would make the reported delta an unverified model claim (REQ-012). A coverage-specific command would make the third behavior need Ensemble code (REQ-018).
   - It lands in PR 1, which is why PR 5 can be configuration only.

5. **Notification transport** (REQ-009, REQ-010). `notification-state.ts` delivers to two sinks:
   - **The user**, through `SessionUiBridge.notify`, a new method that wraps `ctx.ui.notify`. Headless sessions fall back to the console.
   - **The model's context**, through `pi.sendMessage` with `display: true` and `triggerTurn: false`.

   `triggerTurn: false` is deliberate. #107 deleted the continuation path because a message that makes the agent act bypasses `MutationGuard` (`extension.ts:118-140`); a notification is data, never an instruction. Any test-derived text in a notification is fenced and labelled as data, a lesson from #94's live runs. `sendMessage` is added to `assertRequiredCapabilities`.

6. **Verified fix application** (REQ-033). This is configuration plus two small code changes.
   - A new behavior, `apply-verified-fix`, runs `mode: auto`. It triggers on `fix.verified` with the predicate `verdict: passed`, declares only `fix.apply` with no tools, and calls `fix.apply { proposalRef: ${event.payload.proposalRef} }`.
   - `CommandRegistry` then asks `ApprovalGate`. Today the prompt is only `descriptor.description` ("Apply a verified fix proposal…"), so the human would approve without seeing what changes. Code change 1 (TRD-019): the prompt names the proposal, its files and a diff summary.
   - `commit-policy.ts` has no importers today. Code change 2 (TRD-021): wire it in so an applied fix is committed with attribution.

### Alternatives considered (architecture)

| Option | Summary | Why not chosen |
|---|---|---|
| **A — Widen the existing translator, inline notification** | Add file and release branches inside `event-translator.ts`; keep notification-state logic at each `ctx.ui.notify` call site. | `event-translator.ts` would cover three unrelated source domains. Busy/duplicate/stale logic would be copied per behavior, which is the per-reaction duplication the PRD sets out to remove. |
| **B — Dedicated adapter modules + shared notification-state module** *(chosen)* | One adapter module per source type, all feeding the same ingress; one shared notification-state module. | Matches the existing boundary (`agent-core` = provider-neutral logic, `pi-extension` = host wiring), and centralises notification state once. |
| **C — Single generic "external signal" adapter** | One configurable "watch path X for condition Y" abstraction for both sources. | Risks becoming an arbitrary-condition escape hatch around the closed, versioned catalog (REQ-CQRS-005); still duplicates notification state. |

## Domain Analysis

**Technical domains touched:**
- event ingestion and adapters (new);
- the CQRS command catalog (one new command, `artifact.compare`);
- approval and authorization (reused);
- agent-session invocation (hardened);
- notification transport (new module over existing primitives);
- local policy state (package quarantine, authoring timestamps);
- CI / cross-platform verification (new);
- status reporting (extended).

**Brownfield.** This work extends `agent-core` and `pi-extension` as they stand after the #107 CQRS cutover, which left **one dispatch path**: event → matcher → declared workflow. The in-session continuation path (`pi.sendUserMessage`) that 1.0.0's world still partly assumed is gone, and nothing here brings it back. A model now takes part only through a workflow `agent` step, whose output is a candidate, not an edit.

**Companion domains detected:** `data-model`. REQ-031 persists a package quarantine record in the checkout. REQ-029 persists authoring timestamps. NFR-004 keeps notification records for the life of the checkout. Two new event payloads join the closed catalog. 1.0.0 folded these into prose; they are now specified in the companion. `research` was not detected: the comparative decisions above (change detection, release signal) are recorded inline and need no separate study.

## Companion Artifacts

- [Data model](TRD-2026-b6db9749-behavior-habits-runtime-data-model.md): event payloads, package quarantine record, authoring record, notification record, session-local snapshots.

## System Architecture

### Components

```text
packages/agent-core/src/behavior/
  +-- file-source-adapter.ts      - NEW: artifact content-hash change -> artifact.changed
  +-- release-source-adapter.ts   - NEW: new v* tag (tool call or ref diff) -> release.completed
  +-- event-catalog.ts            - MODIFIED: adds artifact.changed (closed catalog)
  +-- trigger-producers.ts        - MODIFIED: registers producers for artifact.changed, release.completed
  +-- event-translator.ts         - existing, UNCHANGED (tool-result scope only)
  +-- local-event-matcher.ts      - MODIFIED: bounded backlog (NFR-002); no new dispatch path
  +-- package-quarantine.ts       - NEW: package quarantine record, checked at discovery
  +-- package-discovery.ts        - MODIFIED: consults quarantine; records first-discovery time
  +-- fixture-conformance.ts      - MODIFIED: records first-passing time
  +-- mutation-guard.ts, approval-gate.ts - existing, UNCHANGED

packages/agent-core/src/cqrs/
  +-- commands.ts                 - MODIFIED: adds artifact.compare; fix.apply unchanged
  +-- command-registry.ts         - MODIFIED: approval prompt carries handler-supplied detail
  +-- event-authority.ts          - MODIFIED (PR 12 only): acceptance states

packages/pi-extension/src/
  +-- notification-state.ts       - NEW: busy/delivered/duplicate/stale/unavailable
  +-- session-ui.ts               - MODIFIED: SessionUiBridge.notify
  +-- agent-port.ts               - MODIFIED: distinct provider-unreachable and timed-out states
  +-- runtime-status.ts           - MODIFIED: also written to a plain-text status file
  +-- commit-policy.ts            - existing, WIRED for the first time (applied-fix commits)
  +-- extension.ts                - MODIFIED: wires adapters, notification-state, quarantine,
                                    status file; asserts sendMessage

packages/agent-core/behaviors/documentation-freshness/   - NEW: package data only (shipped reference)
.ensemble/behaviors/coverage-regression/                 - NEW: package data only (the developer path;
                                                           proves REQ-018 with zero packages/ diff)
.ensemble/behaviors/apply-verified-fix/                  - NEW: package data only (mode: auto, fix.apply)
```

### Data flow

1. A watched artifact changes, or a new `v*` tag appears. The matching adapter builds a raw event and calls `normalizeEvent`, the same ingress tool results use.
2. The validated `BehaviorEvent` reaches `LocalEventMatcher`. Excess events queue in a bounded, in-memory backlog (NFR-002). There is no new dispatcher.
3. The matched behavior runs its declared workflow:
   - **documentation-freshness:** a read-only `agent` step extracts claims from docs, then `doc.verify` adjudicates them;
   - **coverage-regression:** `artifact.compare` computes the deltas;
   - **investigator:** a read-only `agent` step goes through the hardened `AgentPort`.
4. A user-relevant result goes through `notification-state.ts`. Every asserted fact must map to a recorded evidence entry. Test-derived text is fenced as data. Delivery goes to the user (`SessionUiBridge.notify`) and to the model's context (`sendMessage`, `triggerTurn: false`), and each delivery records its state.
5. `fix.verify` with a passing verdict emits `fix.verified`. `apply-verified-fix` (`mode: auto`) calls `fix.apply`. `CommandRegistry` asks `ApprovalGate`, whose prompt now names the files and the diff. On approval, the handler rechecks staleness, writes, and `commit-policy` commits with attribution. On rejection, nothing is written.
6. A finding from any authorized behavior can be evidence for `constitution.propose`. Evidence from a quarantined or rejected package is refused.
7. The status report is written to `.ensemble/status.txt` after each dispatch, as well as shown by `/ensemble-status`, so someone without omp can read it.
8. The whole path runs on Linux, Windows and macOS CI runners; no platform is claimed without its own run.

### Integration points

- **Pi extension API.**
  - Used: `on` (`tool_result`, `agent_end`, `session_start`, `session_shutdown`), `registerCommand`, `registerTool`, `ui.notify`, `ui.confirm`, and `sendMessage`, which becomes a required capability in PR 3.
  - Not used: `sendUserMessage`.
- **Git** (local CLI, read-only): `git for-each-ref refs/tags` for the release ref diff.
- **OMP adapter:** PR 12, its own conformance suite.
- **Foreman protocol:** out of scope. PR 12 only reaffirms that no local result is reported as a Foreman commitment.

## Master Task List

### PR 1: Trigger-source extensibility

**Shippable State:** A behavior package can be triggered by an artifact change or a new release tag, both validated through the existing ingress and reachable from the real `activate()`. Numeric artifact comparisons need no behavior-specific code.

- [ ] **TRD-001** Add `artifact.changed` to the closed catalog and trigger schema, then implement `file-source-adapter.ts` using content hashes at lifecycle points (5h) [satisfies REQ-001] [depends: none]
  - Target Files: `packages/agent-core/src/behavior/event-catalog.ts`, `packages/agent-core/src/behavior/trigger-producers.ts`, `packages/agent-core/src/behavior/schema.ts`, `packages/agent-core/src/behavior/file-source-adapter.ts` (new)
  - Validates PRD ACs: AC-001-1, AC-001-2
  - Implementation AC:
    - [ ] Given an `artifact.changed` trigger whose `path` predicate names a file or glob inside the repo, when the package is compiled, then the adapter's watch set contains exactly those paths.
    - [ ] Given a watched file whose content hash differs from the last digest seen this session, when a lifecycle check runs (`tool_result` or `agent_end`), then the adapter calls `normalizeEvent` with an `artifact.changed` payload of `{ path, previousDigest, currentDigest }`.
    - [ ] Given an `artifact.changed` trigger with no concrete `path`, or one resolving outside the repo root, when the package is validated, then activation rejects it with a diagnostic naming `trigger.predicate.path`, and no watch is registered.
- [ ] **TRD-001-TEST** Artifact adapter tests (2h) [verifies TRD-001] [satisfies REQ-001] [depends: TRD-001]
  - Target Files: `packages/agent-core/tests/file-source-adapter.test.ts` (new)
  - Validates PRD ACs: AC-001-1, AC-001-2
  - Test AC:
    - [ ] Scenario: a changed artifact enters through the canonical ingress -- Given a package triggered on `artifact.changed` for `coverage/coverage-summary.json`, When the file's content changes between two lifecycle checks, Then exactly one `artifact.changed` event built by `normalizeEvent` reaches the matcher, carrying the path and both digests
    - [ ] Scenario: a byte-identical rewrite emits nothing -- Given the same watched file, When it is rewritten with identical bytes, Then no event is produced
    - [ ] Scenario: a trigger without a concrete path fails closed -- Given an `artifact.changed` trigger with no `path` predicate, When the package is validated, Then validation fails with a diagnostic naming `trigger.predicate.path` and no watch exists
    - [ ] Scenario: a path outside the repository is refused -- Given a `path` predicate of `../outside.json`, When the package is validated, Then it fails closed with a named diagnostic rather than watching outside the checkout
- [ ] **TRD-002** Implement `release-source-adapter.ts`: a new `v*` tag, from a tag-creating tool call or a tag-ref diff, becomes `release.completed` (4h) [satisfies REQ-002] [depends: none]
  - Target Files: `packages/agent-core/src/behavior/release-source-adapter.ts` (new), `packages/agent-core/src/behavior/trigger-producers.ts`
  - Validates PRD ACs: AC-002-1, AC-002-2
  - Implementation AC:
    - [ ] Given a successful `git tag vX.Y.Z` or `gh release create vX.Y.Z` tool result, when the adapter runs, then a `release.completed` event carries `{ tag, sha, source: "tool-call" }`.
    - [ ] Given a `v*` tag present in refs at `agent_end` that was absent at session start, when the ref diff runs, then a `release.completed` event carries `source: "ref-diff"`, and a tag already reported this session is not reported again.
    - [ ] Given no new tag matching the configured pattern, when other events are evaluated, then no `release.completed` event exists and no release-triggered behavior fires.
- [ ] **TRD-002-TEST** Release adapter tests (2h) [verifies TRD-002] [satisfies REQ-002] [depends: TRD-002]
  - Target Files: `packages/agent-core/tests/release-source-adapter.test.ts` (new)
  - Validates PRD ACs: AC-002-1, AC-002-2
  - Test AC:
    - [ ] Scenario: a tag created in-session becomes a release event -- Given a real git repository, When a tool result reports a successful `git tag v1.2.3`, Then one `release.completed` event carries tag `v1.2.3` and that tag's sha
    - [ ] Scenario: a fetched tag is caught by the ref diff -- Given a tag `v1.2.4` created outside the session, When the ref diff runs at `agent_end`, Then one `release.completed` event carries `source: "ref-diff"`
    - [ ] Scenario: one tag is one release -- Given `v1.2.3` was already reported from its tool call, When the ref diff later sees the same tag, Then no second event is produced
    - [ ] Scenario: no release means nothing fires -- Given only a non-matching tag `backup-1` is created, When events are evaluated, Then no `release.completed` event exists and a release-triggered behavior records no dispatch
- [ ] **TRD-003** Route both adapters only through `normalizeEvent`, wire them into `activate()`, bound the backlog, and measure dispatch latency (5h) [satisfies REQ-003] [depends: TRD-001, TRD-002]
  - Target Files: `packages/pi-extension/src/extension.ts` (adapter wiring on `tool_result`, `agent_end`, `session_start`), `packages/agent-core/src/behavior/local-event-matcher.ts` (bounded backlog), `packages/agent-core/tests/import-boundary.test.ts` (new)
  - Validates PRD ACs: AC-003-1, AC-003-2
  - Implementation AC:
    - [ ] Given an event from either new adapter, when it is ingested, then it passes the same schema, provenance and freshness validation in `normalizeEvent` as a tool-result event.
    - [ ] Given an adapter module, when the import-boundary check runs, then the adapter may import `normalizeEvent` but not `LocalEventMatcher`, the interpreter or the dispatcher; any such import fails the check.
    - [ ] Given the real `activate()`, when an artifact changes or a tag appears, then the adapters run from the session's own lifecycle hooks, not from a test-only entry point (Rule 6).
    - [ ] Given NFR-001 has no confirmed target, when dispatch runs (event validated → matched → run created), then p50/p99 latency is recorded in the runtime log and reported, not asserted against an invented threshold.
    - [ ] Given the in-memory backlog reaches its configured bound, when another event arrives, then the oldest queued event that is not in progress is dropped and a diagnostic names it; the queue never grows past the bound and is never persisted.
- [ ] **TRD-003-TEST** Ingress parity, import boundary, entry-point reachability, backlog and latency tests (3h) [verifies TRD-003] [satisfies REQ-003] [depends: TRD-003]
  - Target Files: `packages/agent-core/tests/local-event-matcher.test.ts` (extended), `packages/agent-core/tests/import-boundary.test.ts` (new), `packages/pi-extension/tests/trigger-sources.e2e.test.ts` (new)
  - Validates PRD ACs: AC-003-1, AC-003-2
  - Test AC:
    - [ ] Scenario: adapter events are validated exactly like tool-result events -- Given a malformed `artifact.changed` payload and an equally malformed tool-result payload, When both are ingested, Then `normalizeEvent` rejects both with the same class of error
    - [ ] Scenario: an adapter cannot dispatch directly -- Given a planted adapter that imports `LocalEventMatcher`, When the import-boundary test runs, Then it fails naming the import, and passes again once the import is removed (Rule 7)
    - [ ] Scenario: new sources are reachable from activate() -- Given the real `activate()` over a sandbox with an artifact-triggered package, When the artifact changes and a tool call completes, Then the behavior's dispatch appears in the status report
    - [ ] Scenario: an overflowing backlog drops the oldest with a diagnostic -- Given a backlog bound of 3, When 5 events arrive while one is in progress, Then the two oldest queued events are dropped, a diagnostic names each, and memory stays bounded
    - [ ] Scenario: latency is reported, not asserted -- Given 50 dispatches, When the run completes, Then p50 and p99 dispatch latency appear in the runtime log
- [ ] **TRD-033** Add the generic `artifact.compare` command: numeric JSON-path deltas between two snapshots of one artifact (4h) [satisfies REQ-004, REQ-016, REQ-017] [depends: TRD-001]
  - Target Files: `packages/agent-core/src/cqrs/commands.ts` (new descriptor, non-mutating), `packages/agent-core/src/behavior/file-source-adapter.ts` (keeps the previous snapshot for the session)
  - Validates PRD ACs: AC-004-1, AC-016-1, AC-017-1
  - Implementation AC:
    - [ ] Given `{ artifact, metrics: [json-path…], threshold, keyBy }`, when the command runs, then it returns one entry per key and metric whose decrease is at least `threshold`, as `{ key, metric, before, after, delta }`, and names nothing domain-specific.
    - [ ] Given a metric path absent from either snapshot, or malformed JSON, when the command runs, then the verdict is `inconclusive` and names the path; it is never reported as "no regression".
    - [ ] Given the first observation of an artifact in a session, when the command runs, then it returns `baseline-established` with no deltas.
- [ ] **TRD-033-TEST** `artifact.compare` tests (2h) [verifies TRD-033] [satisfies REQ-004, REQ-016, REQ-017] [depends: TRD-033]
  - Target Files: `packages/agent-core/tests/artifact-compare.test.ts` (new)
  - Validates PRD ACs: AC-004-1, AC-016-1, AC-017-1
  - Test AC:
    - [ ] Scenario: a decrease past the threshold is reported with its key and size -- Given two snapshots where `src/a.ts` `lines.pct` falls from 90 to 85 and the threshold is 1, When `artifact.compare` runs, Then it returns `{ key: "src/a.ts", metric: "lines.pct", before: 90, after: 85, delta: -5 }`
    - [ ] Scenario: flat or improved metrics report nothing -- Given snapshots where every metric is equal or higher, When the command runs, Then the regression list is empty
    - [ ] Scenario: a missing metric is inconclusive, never clean -- Given a snapshot lacking `branches.pct`, When the command runs, Then the verdict is `inconclusive` naming `branches.pct`
    - [ ] Scenario: invalid input is rejected at the boundary -- Given `threshold: -1`, When the command is invoked, Then `CommandRegistry` rejects it on input validation before the handler runs
- [ ] **TRD-004** Prove a new behavior on an existing source type needs no Ensemble code change (3h) [satisfies REQ-004] [depends: TRD-001, TRD-002, TRD-033, TRD-012, TRD-013]
  - Target Files: `packages/pi-extension/tests/config-only-behavior-addition.e2e.test.ts` (new, built on `tests/support/harness.ts`), `scripts/check-config-only.js` (new)
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Implementation AC:
    - [ ] Given the artifact adapter exists, when a new package using `artifact.changed` with a new predicate is written as YAML and markdown only, then the real `activate()` loads it and dispatches it with no TypeScript change.
    - [ ] Given the documentation-freshness and coverage-regression packages are added, when `scripts/check-config-only.js <base>` runs over their commits, then it reports no changes under `packages/*/src` or `scripts/` beyond the PR 1 adapters and `artifact.compare`.
- [ ] **TRD-004-TEST** Config-only addition tests (2h) [verifies TRD-004] [satisfies REQ-004] [depends: TRD-004]
  - Target Files: `packages/pi-extension/tests/config-only-behavior-addition.e2e.test.ts`, `scripts/tests/check-config-only.test.js` (new)
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Test AC:
    - [ ] Scenario: a package-data-only behavior runs -- Given a temp repo with only a new `behavior.yaml` and prompt, When the real `activate()` runs and the artifact changes, Then the behavior reaches its declared outcome
    - [ ] Scenario: the zero-diff check passes on package-only commits -- Given commits touching only behavior package files, When `check-config-only.js` runs, Then it exits 0
    - [ ] Scenario: the zero-diff check can fail -- Given a planted edit to `packages/agent-core/src/normalize.ts`, When `check-config-only.js` runs, Then it exits non-zero naming that file (Rule 7)

### PR 2: Read-only investigator hardening

**Shippable State:** An investigator's finding is safe to use as evidence. It reports an unreachable model or a timeout as its own visible state. It cannot change the working tree through any tool it was not granted. It leaves no process behind.

- [ ] **TRD-005** Give `AgentPort` distinct, bounded `provider-unreachable` and `timed-out` states, and prove a finding is typed and non-mutating (3h) [satisfies REQ-005] [depends: none]
  - Target Files: `packages/pi-extension/src/agent-port.ts` (today's catch reports only `cancelled` vs `agent invocation failed: …`)
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-005-3
  - Implementation AC:
    - [ ] Given an investigator step completes, when its output is recorded, then `investigation.record` stores a typed finding with evidence references.
    - [ ] Given the step completes, when the canonical workspace fingerprint is compared with the one before, then they are identical.
    - [ ] Given the model provider is unreachable, when the step is invoked, then it ends within the behavior's `policy.timeout` in a `provider-unreachable` state, distinct from `cancelled`, `timed-out` and `failed`, and no finding is recorded.
- [ ] **TRD-005-TEST** Investigator state and non-mutation tests (2h) [verifies TRD-005] [satisfies REQ-005] [depends: TRD-005]
  - Target Files: `packages/pi-extension/tests/agent-port-unreachable.test.ts` (new, following the existing purpose-named `AgentPort` test files)
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-005-3
  - Test AC:
    - [ ] Scenario: a finding is typed and evidence-backed -- Given a stub agent returning a diagnosis, When the investigator step runs, Then `investigation.record` holds a typed finding with at least one evidence reference
    - [ ] Scenario: investigation leaves the tree untouched -- Given a canonical workspace fingerprint taken before the run, When the investigator completes, Then the fingerprint after is identical
    - [ ] Scenario: an unreachable provider fails fast and visibly -- Given the provider endpoint refuses connections, When the step runs, Then it ends in `provider-unreachable` within the configured timeout and no finding is recorded
    - [ ] Scenario: a hung provider times out rather than hangs -- Given a provider that never responds, When the timeout elapses, Then the state is `timed-out`, not `cancelled`, and the step returns
- [ ] **TRD-006** Verify the investigator's write boundary on every tool path, and its cleanup on timeout and shutdown (3h) [satisfies REQ-006] [depends: none]
  - Target Files: `packages/pi-extension/src/agent-port.ts`, `packages/pi-extension/src/workflow-dispatch.ts` (signal plumbing), `packages/pi-extension/src/extension.ts` (`session_shutdown`: abort before drain), `packages/pi-extension/src/write-sandbox.ts` (verify only)
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-006-3, AC-006-4
  - Implementation AC:
    - [ ] Given an investigator granted only `read`, `grep`, `glob`, when it attempts a native write, then the call is refused at the tool-grant boundary.
    - [ ] Given the same investigator, when it attempts a shell write (redirection, `bash -c`), then the call is refused because `bash` is not granted; the canonical tree cannot be reached in any case, because the agent runs in an isolated worktree.
    - [ ] Given documentation describes the investigator, when it is reviewed, then it claims only what the adversarial fixture proves. It says "isolated worktree plus grant enforcement" on every OS, and "Seatbelt write confinement" on macOS only.
    - [ ] Given an investigator that times out, or whose session shuts down mid-invocation, when cleanup runs, then no child process remains in the process listing, and the worktree and throwaway HOME are removed.
- [ ] **TRD-006-TEST** Adversarial boundary and orphan-cleanup tests (3h) [verifies TRD-006] [satisfies REQ-006] [depends: TRD-006]
  - Target Files: `packages/pi-extension/tests/hostile-tools.e2e.test.ts` (extended), `packages/pi-extension/tests/shutdown-cancellation.test.ts` (extended)
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-006-3, AC-006-4
  - Test AC:
    - [ ] Scenario: a native write is refused -- Given an investigator granted `read, grep, glob`, When it calls `write` on a tracked file, Then the call is refused at the grant boundary and the file is unchanged
    - [ ] Scenario: a shell write is refused -- Given the same investigator, When it requests `bash -c 'echo x > src/a.ts'`, Then the call is refused and the canonical tree fingerprint is unchanged
    - [ ] Scenario: the canonical-tree assertion can fail -- Given the port created with an `isolate` stub returning `{ ok: false }` plus `allowUnisolated: true` (the pattern in `packages/pi-extension/tests/drift-fails-closed.test.ts:42-43`; `allowUnisolated` alone does not disable isolation, it only permits a live-tree run after isolation fails, `agent-port.ts:213`) and `bash` granted, When the same shell write runs, Then the canonical-tree assertion fails naming `src/a.ts`, proving the check detects a real write rather than passing unconditionally (Rule 7)
    - [ ] Scenario: a timed-out investigator leaves nothing behind -- Given an agent that sleeps past the timeout, When the step ends, Then the process listing shows no child and the worktree and HOME directories are gone
    - [ ] Scenario: shutdown mid-invocation aborts before draining -- Given a running investigator, When `session_shutdown` fires, Then the abort signal reaches `agent.invoke` before `drainDispatches` and no orphan remains
- [ ] **TRD-007** Keep investigator findings distinct from fixes, with bounded, redacted evidence (2h) [satisfies REQ-007] [depends: none]
  - Target Files: `packages/agent-core/src/cqrs/commands.ts` (`investigation.record` authority and evidence bounds), `packages/agent-core/src/workflow/interpreter.ts` (outcome typing, no new step type)
  - Validates PRD ACs: AC-007-1, AC-007-2
  - Implementation AC:
    - [ ] Given an investigator produces a finding, when it is recorded, then its authority is `observed` or `diagnostic`, never `verified` or `applied`.
    - [ ] Given a finding references evidence, when it is stored, then each item is size-bounded (truncation marked) and values matching secret patterns are redacted.
- [ ] **TRD-007-TEST** Finding-versus-fix tests (2h) [verifies TRD-007] [satisfies REQ-007] [depends: TRD-007]
  - Target Files: `packages/agent-core/tests/workflow-interpreter.test.ts` (extended), `packages/agent-core/tests/commands.test.ts` (extended)
  - Validates PRD ACs: AC-007-1, AC-007-2
  - Test AC:
    - [ ] Scenario: a finding is never a fix -- Given a recorded investigator finding, When its event is inspected, Then its authority is `observed` or `diagnostic`, and no `fix.applied` or `fix.verified` event exists for it
    - [ ] Scenario: oversized evidence is truncated visibly -- Given evidence of 1 MB, When it is recorded, Then it is cut to the configured bound and marked as truncated
    - [ ] Scenario: secrets do not leak into evidence -- Given evidence containing `GITHUB_TOKEN=ghp_…`, When it is recorded, Then the value is redacted
- [ ] **TRD-008** Allow investigator findings as `constitution.propose` evidence (3h) [satisfies REQ-008] [depends: TRD-007]
  - Target Files: `packages/agent-core/src/cqrs/decision-memory.ts`, `packages/agent-core/src/cqrs/proposal-store.ts`
  - Validates PRD ACs: AC-008-1, AC-008-2
  - Implementation AC:
    - [ ] Given a finding that identifies a candidate rule gap, when a proposal is drafted from it, then the proposal cites the finding's reference as its evidence source.
    - [ ] Given such a proposal, when it reaches apply, then `constitution.apply` goes through the same `ApprovalGate` as any constitution change.
- [ ] **TRD-008-TEST** Investigator-sourced proposal tests (2h) [verifies TRD-008] [satisfies REQ-008] [depends: TRD-008]
  - Target Files: `packages/agent-core/tests/decision-propose.test.ts` (extended)
  - Validates PRD ACs: AC-008-1, AC-008-2
  - Test AC:
    - [ ] Scenario: the proposal cites its finding -- Given an investigator finding `F1`, When a proposal is drafted from it, Then the proposal's evidence lists `F1`
    - [ ] Scenario: the proposal still needs a human -- Given that proposal, When `constitution.apply` runs and the approval is declined, Then `constitution.md` is byte-identical
    - [ ] Scenario: a proposal citing a missing finding is refused -- Given a proposal whose evidence reference does not resolve, When it is submitted, Then it is rejected as invalid evidence

### PR 3: Notification-state module

**Shippable State:** Every behavior's user-relevant result reaches the user and the model through one path. That path checks each claim against recorded evidence, reports delivery state, and never delivers the same result twice or a stale one as current.

- [ ] **TRD-009** Implement `notification-state.ts` with evidence-checked content and two sinks; add `SessionUiBridge.notify`; require `sendMessage` (5h) [satisfies REQ-009, REQ-012] [depends: none]
  - Target Files: `packages/pi-extension/src/notification-state.ts` (new), `packages/pi-extension/src/session-ui.ts` (`notify`), `packages/pi-extension/src/extension.ts` (both existing `ctx.ui.notify` call sites migrate; `assertRequiredCapabilities` gains `sendMessage`)
  - Validates PRD ACs: AC-009-1, AC-009-2, AC-012-1
  - Implementation AC:
    - [ ] Given a behavior produces a user-relevant result, when it completes, then a concise message referencing its evidence goes to `SessionUiBridge.notify` and to `pi.sendMessage({ display: true }, { triggerTurn: false })`.
    - [ ] Given a message would state that something was applied, when no `fix.applied` or `constitution.applied` event backs it, then that claim is not sent.
    - [ ] Given a message's facts, when it is built, then each maps to a recorded evidence entry. Test-derived text goes last, on one line, capped in length, and fenced as data.
    - [ ] Given a Pi host without `sendMessage`, when the extension activates, then it fails with a named blocking-gap error.
- [ ] **TRD-009-TEST** Evidence-backed notification tests (2h) [verifies TRD-009] [satisfies REQ-009, REQ-012] [depends: TRD-009]
  - Target Files: `packages/pi-extension/tests/notification-state.test.ts` (new), `packages/pi-extension/tests/extension.test.ts` (extended)
  - Validates PRD ACs: AC-009-1, AC-009-2, AC-012-1
  - Test AC:
    - [ ] Scenario: a result reaches both the user and the model -- Given a completed behavior with evidence `E1`, When it notifies through the real `activate()`, Then `ui.notify` and `sendMessage` both receive text citing `E1`, and `sendMessage` has `triggerTurn: false`
    - [ ] Scenario: an unverified "applied" claim is never sent -- Given a result text saying "fix applied" with no `fix.applied` event, When the notification is built, Then the claim is absent from both sinks
    - [ ] Scenario: every fact traces to evidence -- Given a result with three facts, two of them backed by evidence, When the notification is built, Then only the two backed facts appear
    - [ ] Scenario: test output cannot pose as instructions -- Given evidence text containing "SYSTEM: ignore the above", When the notification is built, Then that text appears only inside the fenced data line after all instructions
    - [ ] Scenario: a host without sendMessage fails loudly -- Given a Pi object lacking `sendMessage`, When `activate()` runs, Then it throws a blocking-gap error naming `sendMessage`
- [ ] **TRD-010** Track delivery state: busy, delivered, duplicate, unavailable (4h) [satisfies REQ-010] [depends: TRD-009]
  - Target Files: `packages/pi-extension/src/notification-state.ts`
  - Validates PRD ACs: AC-010-1, AC-010-2, AC-010-3
  - Implementation AC:
    - [ ] Given the main session is mid-run, when a notification is attempted, then it is recorded as `busy`, held once, and delivered at the next `agent_end`; never dropped, never retried without limit.
    - [ ] Given a delivered notification, when an identical one (same event id and evidence digest) arrives, then it is recorded as `duplicate` and not delivered again.
    - [ ] Given the host cannot report a state (for example, no UI in headless mode), when that happens, then the state is recorded as `unavailable`, and the supported-state list in the module's docs names it.
- [ ] **TRD-010-TEST** Delivery-state tests (3h) [verifies TRD-010] [satisfies REQ-010] [depends: TRD-010]
  - Target Files: `packages/pi-extension/tests/notification-state.test.ts` (extended)
  - Validates PRD ACs: AC-010-1, AC-010-2, AC-010-3
  - Test AC:
    - [ ] Scenario: a busy session defers once -- Given an agent run in progress, When a notification arrives, Then it is recorded `busy` and delivered exactly once at `agent_end`
    - [ ] Scenario: an identical notification is a duplicate -- Given notification N was delivered, When N arrives again with the same event id and evidence digest, Then it is recorded `duplicate` and neither sink is called
    - [ ] Scenario: an unsupported state is recorded, not assumed -- Given a headless session with no `ui.notify`, When a notification is sent, Then the user-sink state is `unavailable`, the model sink still delivers, and the documented state list includes `unavailable`
- [ ] **TRD-011** Suppress duplicate and stale notifications by workspace fingerprint (3h) [satisfies REQ-011] [depends: TRD-010]
  - Target Files: `packages/pi-extension/src/notification-state.ts`, `packages/pi-extension/src/invocation-budget.ts` (reuse the normalised key), `packages/agent-core/src/behavior/workspace-snapshot.ts` (read-only reuse)
  - Validates PRD ACs: AC-011-1, AC-011-2
  - Implementation AC:
    - [ ] Given two notifications referencing the same event and evidence, when the second arrives, then no second behavior run is created.
    - [ ] Given a notification whose workspace fingerprint no longer matches the tree, when it is delivered, then it is marked `stale` and not presented as current.
- [ ] **TRD-011-TEST** Duplicate and stale tests (2h) [verifies TRD-011] [satisfies REQ-011] [depends: TRD-011]
  - Target Files: `packages/pi-extension/tests/notification-state.test.ts` (extended)
  - Validates PRD ACs: AC-011-1, AC-011-2
  - Test AC:
    - [ ] Scenario: the same evidence never runs twice -- Given a notification for event E with evidence digest D, When a second notification for E and D arrives, Then the dispatch count for E stays 1
    - [ ] Scenario: a stale notification is marked stale -- Given a notification captured at fingerprint F1, When the tree changes to F2 before delivery, Then it is delivered marked `stale`
    - [ ] Scenario: different evidence for the same event type is not a duplicate -- Given two `test.failure.observed` events with different evidence, When both notify, Then both are delivered

### PR 4: Reference behavior — documentation freshness

**Shippable State:** When a release tag lands, the session is told which documentation files and sections are out of date with that release, named specifically, with no automatic edits.

- [ ] **TRD-012** Author the `documentation-freshness` package: a `release.completed` trigger, a read-only claim-extraction agent, then `doc.verify` (6h) [satisfies REQ-013, REQ-014, REQ-015] [depends: TRD-002, TRD-009]
  - Target Files: `packages/agent-core/behaviors/documentation-freshness/behavior.yaml`, `.../prompts/extract.md`, `.../fixtures/{events,expected-matches,expected-outcomes}/`
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-014-1, AC-015-1
  - Implementation AC:
    - [ ] Given a `release.completed` event, when the behavior runs, then a read-only agent (`read`, `grep`, `glob`) extracts checkable claims (versions, flags, commands, paths) from the configured doc globs, and `doc.verify` adjudicates each one against the tagged tree.
    - [ ] Given every claim holds, when the behavior completes, then no notification is sent.
    - [ ] Given a claim that does not hold, when the session is notified, then the message names the file and section (heading) and the claim, citing `doc.verify`'s verdict.
    - [ ] Given the package is added, when its diff is reviewed, then it contains only behavior package files. It reuses `doc.verify` and differs from `doc-claim-check` by trigger (release versus `repository.changed`) and scope (all configured docs versus changed docs).
- [ ] **TRD-012-TEST** Documentation-freshness conformance tests (3h) [verifies TRD-012] [satisfies REQ-013, REQ-014, REQ-015] [depends: TRD-012]
  - Target Files: `packages/agent-core/behaviors/documentation-freshness/fixtures/`, `packages/pi-extension/tests/documentation-freshness.e2e.test.ts` (new)
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-014-1, AC-015-1
  - Test AC:
    - [ ] Scenario: a stale claim is reported with its location -- Given a README section "Install" citing `v1.0.0` and a release tag `v1.1.0`, When the behavior runs, Then the notification names `README.md`, section "Install", and the claim
    - [ ] Scenario: fresh docs stay quiet -- Given docs whose every claim holds at the tag, When the behavior runs, Then no notification is sent and the outcome is recorded as succeeded
    - [ ] Scenario: an unverifiable claim is not called stale -- Given a claim `doc.verify` returns inconclusive for, When the behavior runs, Then it is listed as inconclusive, never as stale
    - [ ] Scenario: the package is configuration only -- Given the commit adding the package, When `check-config-only.js` runs, Then it reports no source changes

### PR 5: Reference behavior — coverage regression (extensibility proof)

**Shippable State:** A drop in test coverage is reported with the metric, the size of the drop and the file. A developer added this behavior with no change under `packages/`, and the time it took is recorded.

- [ ] **TRD-013** Author `coverage-regression` in `.ensemble/behaviors/`: an `artifact.changed` trigger on `coverage/coverage-summary.json`, then `artifact.compare` (6h) [satisfies REQ-016, REQ-017] [depends: TRD-001, TRD-033, TRD-009]
  - Target Files: `.ensemble/behaviors/coverage-regression/behavior.yaml`, `.../README.md` (enable Jest `json-summary`), `.../fixtures/{events,expected-matches,expected-outcomes}/`
  - Validates PRD ACs: AC-016-1, AC-016-2, AC-017-1
  - Implementation AC:
    - [ ] Given the summary artifact changes and a baseline exists this session, when `artifact.compare` runs with `metrics: [lines.pct, branches.pct]`, `keyBy: file` and `threshold: 1.0`, then each decrease at or above the threshold becomes evidence. The metrics and the threshold are behavior configuration.
    - [ ] Given coverage is flat or improved, or this is the first snapshot of the session, when the behavior runs, then no notification is sent.
    - [ ] Given a regression, when the session is notified, then the message states the metric, before, after, delta and file for each entry.
    - [ ] Given the repo does not produce `coverage-summary.json`, when the status report is read, then the behavior is listed as an inert trigger with the reason, not silently idle.
- [ ] **TRD-013-TEST** Coverage-regression conformance tests (3h) [verifies TRD-013] [satisfies REQ-016, REQ-017] [depends: TRD-013]
  - Target Files: `.ensemble/behaviors/coverage-regression/fixtures/`, `packages/pi-extension/tests/coverage-regression.e2e.test.ts` (new)
  - Validates PRD ACs: AC-016-1, AC-016-2, AC-017-1
  - Test AC:
    - [ ] Scenario: a drop is reported with metric, delta and file -- Given a baseline where `src/a.ts` has 90% lines, When a new summary shows 85%, Then the notification states `lines.pct`, 90 → 85 (-5), `src/a.ts`
    - [ ] Scenario: flat or improved coverage stays quiet -- Given a new summary equal to or above the baseline everywhere, When the behavior runs, Then no notification is sent
    - [ ] Scenario: the first snapshot only sets the baseline -- Given no previous snapshot this session, When the summary appears, Then no notification is sent and the outcome records `baseline-established`
    - [ ] Scenario: a missing artifact is visible -- Given a repo without `json-summary` enabled, When the status report renders, Then coverage-regression is listed as loaded but unable to fire, with the reason
- [ ] **TRD-014** Verify the coverage behavior was added with zero Ensemble source change, and record its authoring turnaround (3h) [satisfies REQ-018, REQ-028] [depends: TRD-013, TRD-023, TRD-004]
  - Target Files: `packages/pi-extension/tests/config-only-behavior-addition.e2e.test.ts` (extended), `scripts/check-config-only.js`
  - Validates PRD ACs: AC-018-1, AC-028-1
  - Implementation AC:
    - [ ] Given PR 1–3 are merged, when the commits adding `coverage-regression` are checked, then `check-config-only.js` reports no change under `packages/` or `scripts/`.
    - [ ] Given the package, when it runs end to end through the real `activate()` in a sandbox session, then it reaches its documented outcome, and its authoring start and completion timestamps are recorded.
- [ ] **TRD-014-TEST** Zero-diff and end-to-end tests (2h) [verifies TRD-014] [satisfies REQ-018, REQ-028] [depends: TRD-014]
  - Target Files: `packages/pi-extension/tests/config-only-behavior-addition.e2e.test.ts`
  - Validates PRD ACs: AC-018-1, AC-028-1
  - Test AC:
    - [ ] Scenario: the third behavior touched no Ensemble source -- Given the commit range adding `coverage-regression`, When the zero-diff check runs, Then it reports zero files under `packages/` and `scripts/`
    - [ ] Scenario: it works end to end through the product entry point -- Given a sandbox repo, When the real `activate()` runs and the summary regresses, Then the notification arrives and the dispatch shows in status
    - [ ] Scenario: the zero-diff proof can fail -- Given a planted one-line change in `packages/pi-extension/src/extension.ts` inside that commit range, When the check runs, Then it fails naming the file (Rule 7)

### PR 6: Constitution-gate broadening, quarantine, and evidence integrity

**Shippable State:** A finding from any authorized behavior can support a constitution proposal, still approved by a human. A package rejected for over-reaching stays quarantined across restarts, with its reason readable in plain text, and cannot supply evidence.

- [ ] **TRD-015** Broaden `constitution.propose` to accept evidence from any authorized behavior (4h) [satisfies REQ-019] [depends: TRD-008]
  - Target Files: `packages/agent-core/src/cqrs/proposal-store.ts`, `packages/agent-core/src/cqrs/event-authority.ts`
  - Validates PRD ACs: AC-019-1
  - Implementation AC:
    - [ ] Given a finding from the investigator, documentation-freshness or coverage-regression, from a behavior that declares `constitution.propose`, when a proposal is drafted, then the same gate that handles fix-sourced proposals accepts it.
    - [ ] Given a behavior that does not declare `constitution.propose`, when it tries to draft a proposal, then `CommandRegistry` refuses it on capability.
- [ ] **TRD-015-TEST** Multi-source proposal tests (2h) [verifies TRD-015] [satisfies REQ-019] [depends: TRD-015]
  - Target Files: `packages/agent-core/tests/decision-propose.test.ts` (extended)
  - Validates PRD ACs: AC-019-1
  - Test AC:
    - [ ] Scenario: an investigator finding is accepted -- Given an authorized investigator finding, When a proposal is drafted from it, Then the gate accepts it exactly as it accepts a fix-sourced proposal
    - [ ] Scenario: a reference-behavior finding is accepted -- Given a documentation-freshness finding from a behavior declaring `constitution.propose`, When a proposal is drafted, Then it is accepted
    - [ ] Scenario: an undeclared behavior is refused -- Given coverage-regression without `constitution.propose` in its capabilities, When it attempts a proposal, Then the registry denies it naming the missing capability
- [ ] **TRD-016** Reaffirm human approval for every constitution change, from any source (2h) [satisfies REQ-020] [depends: TRD-015]
  - Target Files: `packages/agent-core/src/cqrs/command-registry.ts` (generic `requiresApproval` gate, regression only), `packages/agent-core/src/cqrs/commands.ts` (`constitutionApply`), `packages/pi-extension/src/extension.ts` (write-boundary carve-out wiring)
  - Validates PRD ACs: AC-020-1, AC-020-2
  - Implementation AC:
    - [ ] Given a constitution-change proposal from any source, when it reaches apply, then `ApprovalGate` requires an explicit yes before anything is written or any PR is opened.
    - [ ] Given the approval is declined, dismissed or impossible (no UI), when evaluated, then `constitution.md` is unmodified.
- [ ] **TRD-016-TEST** Cross-source approval regression tests (2h) [verifies TRD-016] [satisfies REQ-020] [depends: TRD-016]
  - Target Files: `packages/pi-extension/tests/constitution-apply-boundary.test.ts` (extended)
  - Validates PRD ACs: AC-020-1, AC-020-2
  - Test AC:
    - [ ] Scenario: approval is asked for every source -- Given proposals sourced from a fix, an investigator and a reference behavior, When each reaches `constitution.apply`, Then `ui.confirm` is called once per proposal before any write
    - [ ] Scenario: declining leaves the constitution untouched -- Given the approval is declined, When apply is evaluated, Then `constitution.md` is byte-identical
    - [ ] Scenario: no UI fails closed -- Given a headless session with no `ui.confirm`, When apply runs, Then it is refused and `constitution.md` is unchanged
- [ ] **TRD-017** Implement `package-quarantine.ts`: a quarantine record local to the checkout, consulted at discovery (4h) [satisfies REQ-031] [depends: none]
  - Target Files: `packages/agent-core/src/behavior/package-quarantine.ts` (new), `packages/agent-core/src/behavior/package-discovery.ts`, `packages/pi-extension/src/extension.ts` (activation reads it), `.gitignore` (add `.ensemble/state/`)
  - Validates PRD ACs: AC-031-1, AC-031-2
  - Implementation AC:
    - [ ] Given a package rejected under NFR-003, when it is quarantined, then a record `{ package, digest, reason, at }` is written to `.ensemble/state/quarantine.json` (see the data-model companion), and the package is not loaded.
    - [ ] Given a restart against the same checkout, when discovery runs, then the package stays quarantined and no reload is attempted.
    - [ ] Given an operator inspects state, when they read the file or the status report, then the quarantine and its cause are plain text. Removing the record clears it, and a corrupt record keeps the package quarantined with a diagnostic.
    - [ ] Named distinctly from the existing write-boundary revert map in `extension.ts`, so the two quarantines are never confused.
- [ ] **TRD-017-TEST** Quarantine persistence tests (2h) [verifies TRD-017] [satisfies REQ-031] [depends: TRD-017]
  - Target Files: `packages/agent-core/tests/package-quarantine.test.ts` (new), `packages/pi-extension/tests/package-authoring.e2e.test.ts` (extended)
  - Validates PRD ACs: AC-031-1, AC-031-2
  - Test AC:
    - [ ] Scenario: quarantine survives a restart -- Given package P quarantined, When a new `activate()` runs on the same checkout, Then P is not loaded and no load of P is attempted
    - [ ] Scenario: the cause is readable -- Given P quarantined for requesting `bash` beyond its grant, When status is rendered, Then it shows P, the reason and the time in plain text
    - [ ] Scenario: clearing works and corruption fails closed -- Given the record is removed, When activation runs, Then P loads; and Given the record is corrupt JSON, When activation runs, Then P stays quarantined with a diagnostic
- [ ] **TRD-018** Refuse constitution-proposal evidence from a quarantined or rejected package (2h) [satisfies REQ-020] [depends: TRD-015, TRD-017]
  - Target Files: `packages/agent-core/src/cqrs/proposal-store.ts`
  - Validates PRD ACs: AC-020-3
  - Implementation AC:
    - [ ] Given a finding from a quarantined or rejected package, when a proposal is drafted from it, then it is refused as invalid evidence before any approval is asked.
- [ ] **TRD-018-TEST** Quarantined-evidence refusal tests (2h) [verifies TRD-018] [satisfies REQ-020] [depends: TRD-018]
  - Target Files: `packages/agent-core/tests/decision-propose.test.ts` (extended)
  - Validates PRD ACs: AC-020-3
  - Test AC:
    - [ ] Scenario: quarantined evidence is refused -- Given a finding from quarantined package P, When a proposal cites it, Then it is refused as invalid evidence
    - [ ] Scenario: refusal comes before approval -- Given the same proposal and an approver who would say yes, When it is submitted, Then `ui.confirm` is never called
    - [ ] Scenario: healthy evidence is still accepted -- Given a finding from a healthy package, When a proposal cites it, Then it is accepted (control)

### PR 7: Verified fix application

**Shippable State:** A fix that passed verification can be applied to the working tree for the first time. The human sees which files change before approving, a rejection leaves the tree byte-identical, and the resulting commit names the run and event behind it.

- [ ] **TRD-019** Reach the existing `fix.apply` through an `apply-verified-fix` behavior (`mode: auto`), and make its approval prompt show what changes (4h) [satisfies REQ-033] [depends: none]
  - Target Files: `.ensemble/behaviors/apply-verified-fix/behavior.yaml` (new; trigger `fix.verified`, predicate `verdict: passed`, `commands: [fix.apply]`, no tools), `packages/agent-core/src/cqrs/command-registry.ts` (approval request carries handler-supplied detail), `packages/agent-core/src/cqrs/commands.ts` (`fixApply` supplies proposal ref, files and diff summary)
  - Validates PRD ACs: AC-033-1
  - Implementation AC:
    - [ ] Given a `fix.verified` event with a passing verdict, when `apply-verified-fix` runs, then `fix.apply { proposalRef: ${event.payload.proposalRef} }` proceeds only after `ApprovalGate` returns approved. Approval is a separate step from verification.
    - [ ] Given the approval prompt, when it is shown, then it names the proposal, each target file and a diff summary; not only `descriptor.description`.
    - [ ] Given the tree changed since verification, when apply runs after approval, then the existing `staleWrites` check rejects it; approval never stands in for revalidation.
    - [ ] Security-sensitive per constitution §4: implementation starts only after the PRD approver signs off on this task.
- [ ] **TRD-019-TEST** Approval-gated apply tests (3h) [verifies TRD-019] [satisfies REQ-033] [depends: TRD-019]
  - Target Files: `packages/agent-core/tests/command-registry.test.ts` (extended), `packages/pi-extension/tests/apply-verified-fix.e2e.test.ts` (new)
  - Validates PRD ACs: AC-033-1
  - Test AC:
    - [ ] Scenario: a verified fix applies only after approval, and the prompt shows the change -- Given a verified proposal touching `src/a.ts`, When `apply-verified-fix` runs through the real `activate()`, Then `ui.confirm` is called with text naming `src/a.ts` and a diff summary, and nothing is written before it returns yes
    - [ ] Scenario: an unverified proposal never reaches approval -- Given a proposal whose verification failed, When `fix.apply` is invoked, Then it is refused before `ui.confirm` is called
    - [ ] Scenario: a stale proposal is rejected after approval -- Given a verified proposal and a later edit to `src/a.ts`, When apply is approved, Then it is rejected as stale and `src/a.ts` keeps the later edit
    - [ ] Scenario: propose mode cannot apply -- Given the same behavior switched to `mode: propose`, When it runs, Then `MutationGuard` denies the write (control proving the mode boundary)
- [ ] **TRD-020** Verify a declined apply leaves the tree byte-identical (2h) [satisfies REQ-033] [depends: TRD-019]
  - Target Files: `packages/pi-extension/tests/reference-flow.e2e.test.ts` (extended)
  - Validates PRD ACs: AC-033-2
  - Implementation AC:
    - [ ] Given no approval (declined, dismissed or no UI), when evaluated, then the working tree is byte-identical to its state before the proposal existed.
- [ ] **TRD-020-TEST** Byte-identical rejection tests (2h) [verifies TRD-020] [satisfies REQ-033] [depends: TRD-020]
  - Target Files: `packages/pi-extension/tests/reference-flow.e2e.test.ts`
  - Validates PRD ACs: AC-033-2
  - Test AC:
    - [ ] Scenario: declining changes nothing -- Given a verified proposal, When the approval is declined, Then a hash of every tracked and untracked file matches the hash taken before the proposal
    - [ ] Scenario: a dismissed dialog is a no -- Given the dialog is dismissed without an answer, When evaluated, Then the tree is byte-identical
    - [ ] Scenario: no UI fails closed -- Given a headless session, When apply is attempted, Then it is refused and the tree is byte-identical
- [ ] **TRD-021** Wire `commit-policy.ts` so an approved apply is committed with attribution (it has no importers today) (3h) [satisfies REQ-033] [depends: TRD-019]
  - Target Files: `packages/pi-extension/src/commit-policy.ts` (existing, unused), `packages/pi-extension/src/extension.ts` (commit after `fix.applied`)
  - Validates PRD ACs: AC-033-3
  - Implementation AC:
    - [ ] Given an approved apply, when the fix is written, then a commit is created whose attribution names the behavior, the run, the source event id and the attempt.
    - [ ] Given any attribution field is missing, when the commit is attempted, then `commit-policy` refuses it (existing rule) and the refusal is reported, not swallowed.
- [ ] **TRD-021-TEST** Attribution tests (2h) [verifies TRD-021] [satisfies REQ-033] [depends: TRD-021]
  - Target Files: `packages/pi-extension/tests/commit-policy.test.ts` (extended), `packages/pi-extension/tests/apply-verified-fix.e2e.test.ts`
  - Validates PRD ACs: AC-033-3
  - Test AC:
    - [ ] Scenario: the commit names its origin -- Given an approved apply, When the commit is inspected, Then its message carries the behavior name, run id, source event id and attempt
    - [ ] Scenario: missing attribution refuses the commit -- Given a source event id is missing, When the commit is attempted, Then it is refused and the refusal is reported to the user
    - [ ] Scenario: commit policy is reachable from the entry point -- Given the real `activate()`, When an apply is approved, Then `commit-policy` runs (Rule 6)

### PR 8: Cross-role observability

**Shippable State:** A PM or QA engineer with only repository access can read, in plain text, which behaviors are active and why each one fired, skipped or was rejected, without omp or any developer tooling.

- [ ] **TRD-022** Write the status report to `.ensemble/status.txt` after each dispatch, as well as serving `/ensemble-status` (4h) [RISK: may need a small CLI renderer if a snapshot file proves insufficient; reassess past 4h] [satisfies REQ-032] [depends: none]
  - Target Files: `packages/pi-extension/src/runtime-status.ts`, `packages/pi-extension/src/extension.ts`
  - Validates PRD ACs: AC-032-1, AC-032-2
  - Implementation AC:
    - [ ] Given someone with read access only, when they open `.ensemble/status.txt`, then it lists active, quarantined and inert behaviors in plain text.
    - [ ] Given a dispatch decision (matched, skipped, rejected), when it is written, then the reason is a plain sentence that needs no source knowledge, with no colour codes (NFR-004).
- [ ] **TRD-022-TEST** Status-file tests (2h) [verifies TRD-022] [satisfies REQ-032] [depends: TRD-022]
  - Target Files: `packages/pi-extension/tests/runtime-status-file.test.ts` (new)
  - Validates PRD ACs: AC-032-1, AC-032-2
  - Test AC:
    - [ ] Scenario: active behaviors are readable from a file -- Given two active behaviors and one quarantined, When a dispatch completes, Then `.ensemble/status.txt` lists all three with their states
    - [ ] Scenario: a skip explains itself in plain words -- Given a dispatch skipped by a condition, When the file is read, Then the reason names the condition in a sentence, without source identifiers
    - [ ] Scenario: nothing depends on colour -- Given the rendered file, When it is scanned, Then it contains no ANSI escape sequences

### PR 9: Success metric instrumentation

**Shippable State:** The time taken to author a new behavior is recorded automatically and reported. Where no pre-infrastructure baseline exists, the report says so rather than inventing one.

- [ ] **TRD-023** Record authoring start (first discovery) and completion (first passing conformance run) (3h) [satisfies REQ-029] [depends: none]
  - Target Files: `packages/agent-core/src/behavior/package-discovery.ts`, `packages/agent-core/src/behavior/fixture-conformance.ts`, `.ensemble/state/authoring.json` (see data-model)
  - Validates PRD ACs: AC-029-1
  - Implementation AC:
    - [ ] Given a new package is discovered for the first time, when discovery runs, then its start time is recorded once and never overwritten.
    - [ ] Given its fixture conformance first passes, when the run ends, then its completion time is recorded; a failing run records nothing.
- [ ] **TRD-023-TEST** Timestamp tests (2h) [verifies TRD-023] [satisfies REQ-029] [depends: TRD-023]
  - Target Files: `packages/agent-core/tests/authoring-timestamps.test.ts` (new)
  - Validates PRD ACs: AC-029-1
  - Test AC:
    - [ ] Scenario: first discovery sets the start -- Given a new package, When discovery runs, Then `authoring.json` has its start time
    - [ ] Scenario: the first passing conformance sets completion -- Given the package's fixtures pass, When conformance runs, Then completion is recorded
    - [ ] Scenario: re-discovery and failures change nothing -- Given start is already recorded, When discovery runs again and a conformance run fails, Then neither timestamp changes
- [ ] **TRD-024** Compute and report authoring turnaround against whatever baseline exists (2h) [satisfies REQ-030] [depends: TRD-023, TRD-014]
  - Target Files: `packages/pi-extension/src/runtime-status.ts` (extended)
  - Validates PRD ACs: AC-030-1
  - Implementation AC:
    - [ ] Given both timestamps exist, when the third reference behavior is added, then turnaround is computed and reported next to the baseline. [NEEDS CLARIFICATION carried from PRD REQ-030: no pre-infrastructure baseline exists; it is reported as "baseline: not established" rather than invented.]
- [ ] **TRD-024-TEST** Metric computation tests (2h) [verifies TRD-024] [satisfies REQ-030] [depends: TRD-024]
  - Target Files: `packages/pi-extension/tests/runtime-status-file.test.ts` (extended)
  - Validates PRD ACs: AC-030-1
  - Test AC:
    - [ ] Scenario: turnaround is computed -- Given start 10:00 and completion 12:30, When status renders, Then turnaround reads 2h30m
    - [ ] Scenario: a missing baseline is stated -- Given no baseline is configured, When status renders, Then it reads "baseline: not established"
    - [ ] Scenario: an unfinished package is pending -- Given a start but no completion, When status renders, Then turnaround reads "pending"

### PR 10: Cross-platform (OS) conformance

**Shippable State:** Developers, PMs and QA can trust the platform-support claims in project docs. Linux, Windows and macOS each have their own conformance run behind any claim, or a documented gap where support doesn't exist yet.

- [ ] **TRD-025** Run the conformance suite on a Linux runner and record the results (3h) [satisfies REQ-021] [depends: TRD-029]
  - Target Files: `.github/workflows/test.yml` (OS matrix job), `docs/platform-conformance.md` (new)
  - Validates PRD ACs: AC-021-1, AC-021-2
  - Implementation AC:
    - [ ] Given the matrix job on `ubuntu-latest`, when it runs, then the trigger, dispatch and notification e2e suite passes, and the run is recorded in `docs/platform-conformance.md` with its URL.
    - [ ] Given the job's steps, when a test fails, then the job fails on that command's own exit status: no pipes into `tail` (constitution Amendment 2026-09-29).
- [ ] **TRD-025-TEST** Linux conformance run (1h) [verifies TRD-025] [satisfies REQ-021] [depends: TRD-025]
  - Target Files: `.github/workflows/test.yml`
  - Validates PRD ACs: AC-021-1, AC-021-2
  - Test AC:
    - [ ] Scenario: Linux has its own passing run -- Given the matrix job on `ubuntu-latest`, When the suite runs, Then it passes and the results are uploaded as an artifact
    - [ ] Scenario: a failing test fails the job -- Given a planted failing test on a throwaway branch, When the job runs, Then it fails (Rule 7)
    - [ ] Scenario: the claim cites its run -- Given `docs/platform-conformance.md`, When Linux is listed as supported, Then the entry links a passing run
- [ ] **TRD-026** Run the conformance suite on a Windows runner, and document gaps instead of patching around them per platform (5h) [RISK: 8h+ candidate if path handling or POSIX-only shell patterns in `event-translator.ts` fail] [satisfies REQ-021, REQ-023] [depends: TRD-029]
  - Target Files: `.github/workflows/test.yml`, `docs/platform-conformance.md`
  - Validates PRD ACs: AC-021-1, AC-021-2, AC-023-1
  - Implementation AC:
    - [ ] Given the matrix job on `windows-latest`, when it runs, then results are recorded. Each failure is either fixed with the same semantics on every OS, or recorded as a named gap.
    - [ ] Given Seatbelt write confinement is macOS-only, when Windows is documented, then the gap is named ("no OS write confinement; isolated worktree and grant enforcement only").
- [ ] **TRD-026-TEST** Windows conformance run and gap documentation (2h) [verifies TRD-026] [satisfies REQ-021, REQ-023] [depends: TRD-026]
  - Target Files: `.github/workflows/test.yml`, `docs/platform-conformance.md`
  - Validates PRD ACs: AC-021-1, AC-021-2, AC-023-1
  - Test AC:
    - [ ] Scenario: Windows has its own run -- Given the matrix job on `windows-latest`, When the suite runs, Then its results are recorded separately from Linux and macOS
    - [ ] Scenario: a platform gap is named -- Given a capability unavailable on Windows (Seatbelt), When the doc is read, Then it names the gap and its effect
    - [ ] Scenario: no silent per-platform semantics -- Given a code path with an OS branch introduced to pass on Windows, When reviewed against the gap list, Then the branch either preserves behavior or appears as a documented gap
- [ ] **TRD-027** Run the conformance suite on a macOS runner and record the results (3h) [satisfies REQ-021] [depends: TRD-029]
  - Target Files: `.github/workflows/test.yml`, `docs/platform-conformance.md`
  - Validates PRD ACs: AC-021-1, AC-021-2
  - Implementation AC:
    - [ ] Given the matrix job on `macos-latest`, when it runs, then the suite passes, including the Seatbelt confinement tests, and the run is recorded.
- [ ] **TRD-027-TEST** macOS conformance run (1h) [verifies TRD-027] [satisfies REQ-021] [depends: TRD-027]
  - Target Files: `.github/workflows/test.yml`
  - Validates PRD ACs: AC-021-1, AC-021-2
  - Test AC:
    - [ ] Scenario: macOS has its own passing run -- Given the matrix job on `macos-latest`, When the suite runs, Then it passes and results are uploaded
    - [ ] Scenario: Seatbelt confinement is exercised -- Given `write-sandbox.test.ts`, When it runs on macOS, Then its confinement cases execute rather than skip
    - [ ] Scenario: no inferred parity -- Given Linux passed, When macOS support is documented, Then it cites the macOS run, not the Linux one
- [ ] **TRD-028** Add a validation check: no platform is listed as supported without a matching conformance run (2h) [satisfies REQ-022] [depends: TRD-025, TRD-026, TRD-027]
  - Target Files: `scripts/validate-all.js` (extended)
  - Validates PRD ACs: AC-022-1
  - Implementation AC:
    - [ ] Given docs or release notes list a supported platform, when `validate-all.js` runs, then each listed platform must have a recorded passing run in `docs/platform-conformance.md`.
- [ ] **TRD-028-TEST** Platform-claim validation tests (1h) [verifies TRD-028] [satisfies REQ-022] [depends: TRD-028]
  - Target Files: `scripts/tests/validate-all.test.js` (extended)
  - Validates PRD ACs: AC-022-1
  - Test AC:
    - [ ] Scenario: a claim without a run fails validation -- Given the README lists Windows and there is no Windows run, When validation runs, Then it fails naming Windows
    - [ ] Scenario: a claim with a run passes -- Given each listed platform has a recorded run, When validation runs, Then it passes
    - [ ] Scenario: the check can fail -- Given the macOS run entry is removed while macOS is still listed, When validation runs, Then it fails (Rule 7)

### PR 11: Extensibility proof (final integration)

**Shippable State:** All three reference behaviors (test-failure, documentation freshness, coverage regression) run end to end in one real session with no unapproved changes, which meets the PRD's exit criteria.

- [ ] **TRD-029** Run all three reference behaviors end to end with zero unapproved mutations (4h) [satisfies REQ-027] [depends: TRD-012, TRD-013]
  - Target Files: `packages/pi-extension/tests/reference-flow.e2e.test.ts` (extended to all three behaviors in one sandbox repo)
  - Validates PRD ACs: AC-027-1
  - Implementation AC:
    - [ ] Given test-failure, documentation-freshness and coverage-regression are active in one sandbox session through the real `activate()`, when each is triggered, then each reaches its documented outcome, and the tree changes only through an approved path.
- [ ] **TRD-029-TEST** Three-behavior integration tests (3h) [verifies TRD-029] [satisfies REQ-027] [depends: TRD-029]
  - Target Files: `packages/pi-extension/tests/reference-flow.e2e.test.ts`
  - Validates PRD ACs: AC-027-1
  - Test AC:
    - [ ] Scenario: every behavior reaches its outcome -- Given the three behaviors in one session, When each is triggered in turn, Then each records its documented outcome
    - [ ] Scenario: no unapproved change lands -- Given a tree fingerprint before the run, When all three complete without approvals, Then the fingerprint is unchanged
    - [ ] Scenario: an unapproved write is caught -- Given a planted behavior step that writes a protected path, When it runs, Then the write boundary reverts it and reports the violation

### PR 12: Foreman-boundary discipline and OMP conformance

**Shippable State:** Foreman operators, when Foreman is present, can trust that Ensemble never reports a local result as a Foreman commitment. OMP users get their own independently verified conformance evidence rather than an assumed parity with Pi.

- [ ] **TRD-030** Reaffirm that Ensemble never reports a local result as a Foreman commitment (2h) [satisfies REQ-026] [depends: none]
  - Target Files: `packages/agent-core/src/cqrs/event-authority.ts` (existing `acceptLocally`; regression test only)
  - Validates PRD ACs: AC-026-1
  - Implementation AC:
    - [ ] Given a local tool or transport success, when it is reported, then its acceptance scope is `local-session` or `local-outbox`, never a Foreman commitment, unless a Foreman-sourced confirmation exists.
- [ ] **TRD-030-TEST** Local-never-Foreman regression tests (1h) [verifies TRD-030] [satisfies REQ-026] [depends: TRD-030]
  - Target Files: `packages/agent-core/tests/event-authority.test.ts` (extended)
  - Validates PRD ACs: AC-026-1
  - Test AC:
    - [ ] Scenario: a local success stays local -- Given a successful governed command, When its acceptance is recorded, Then the scope is `local-session`
    - [ ] Scenario: status never says committed for local work -- Given only local results, When status is rendered, Then the word "committed" does not describe any of them
    - [ ] Scenario: a forged confirmation is ignored -- Given a payload field claiming Foreman confirmation from a non-Foreman source, When recorded, Then the scope stays local
- [ ] **TRD-031** Build an OMP adapter conformance suite separate from Pi's (5h) [RISK: depends on OMP extension-API gap discovery, not yet confirmed] [satisfies REQ-024] [depends: none]
  - Target Files: `packages/pi-extension/tests/omp-conformance/` (new)
  - Validates PRD ACs: AC-024-1, AC-024-2
  - Implementation AC:
    - [ ] Given the OMP adapter, when tested, then it has its own suite, and no parity is claimed from shared YAML alone.
    - [ ] Given a required capability OMP lacks, when found, then it is documented as a gap, not forked around.
- [ ] **TRD-031-TEST** OMP conformance suite (2h) [verifies TRD-031] [satisfies REQ-024] [depends: TRD-031]
  - Target Files: `packages/pi-extension/tests/omp-conformance/`
  - Validates PRD ACs: AC-024-1, AC-024-2
  - Test AC:
    - [ ] Scenario: OMP runs its own suite -- Given the OMP host, When the conformance suite runs, Then its results are reported separately from Pi's
    - [ ] Scenario: a missing capability is a documented gap -- Given OMP lacks a required capability, When the suite runs, Then the case is marked unsupported with a named gap, not passed
    - [ ] Scenario: parity is never inferred -- Given Pi's suite passed, When OMP support is documented, Then it cites only OMP's own run
- [ ] **TRD-032** Define the local-acceptance / queued / delivered / committed-by-Foreman states (3h) [satisfies REQ-025] [depends: none]
  - Target Files: `packages/agent-core/src/cqrs/event-authority.ts` (extend beyond today's `local-session` / `local-outbox`)
  - Validates PRD ACs: AC-025-1
  - Implementation AC:
    - [ ] Given a governed tool call succeeds locally, when its status is reported, then it is exactly one of "accepted locally", "queued locally", "delivered" or "committed by Foreman".
- [ ] **TRD-032-TEST** Contract-state tests (2h) [verifies TRD-032] [satisfies REQ-025] [depends: TRD-032]
  - Target Files: `packages/agent-core/tests/event-authority.test.ts` (extended)
  - Validates PRD ACs: AC-025-1
  - Test AC:
    - [ ] Scenario: each result has exactly one state -- Given results of every kind, When their status is reported, Then each is exactly one of the four states
    - [ ] Scenario: the outbox maps to queued -- Given a `local-outbox` acceptance, When reported, Then it reads "queued locally"
    - [ ] Scenario: committed needs Foreman -- Given no Foreman confirmation, When status is reported, Then no result reads "committed by Foreman"

## 4.1 Team Configuration

> Injected by `/ensemble:configure-team`. Review agent assignments and edit if needed.

**Complexity metrics:** task_count=66, estimated_hours=185, domain_count=4 (testing, documentation, backend, database), cross_cutting_count=2, dependency_depth=7 (TRD-001 → TRD-033 → TRD-013 → TRD-004 → TRD-014 → TRD-024 → TRD-024-TEST) → **tier: Complex**

Assignment notes (deviations from pure keyword ranking, so they can be reviewed):

- **testing → `test-runner`**, not `playwright-tester`. Keyword overlap ranks `playwright-tester` first, but every test in this TRD is Jest; there is no browser UI.
- **documentation → `documentation-specialist`**, not `api-documentation-specialist` (tied on overlap). The work is behavior-package prompts and platform docs, not API reference.
- **database** was detected from one word, "schema" in TRD-001, meaning the behavior *trigger* schema in YAML. There is no database in scope, so no `postgresql-specialist` is assigned; TRD-001 goes to `backend-developer`.
- **backend** was detected from "API" in TRD-031's risk note. `backend-developer` is still the right builder for the TypeScript runtime work in `agent-core` and `pi-extension`, which is most of the implementation tasks and which keyword detection does not otherwise classify.
- CI tasks (TRD-025–028) did not match any infrastructure keyword. Add `infrastructure-developer` as a builder if you want them owned separately.
- The block uses the `team.roles` list shape (`name`, `agents`, `owns`) that implement-trd-beads' shared parser (`parseTeamConfig`, `packages/development/tests/helpers/team-utils.js`) reads, with all 8 roles. The older `team_configuration.roles` map used in TRD-2026-0fc1c1d0 is not read by it. Complexity metrics are in the line above, not in the YAML.

Marketplace: 0 gaps. All 27 catalog plugins are present in this repository, every assigned agent exists in the local and plugin agent registries, and the Jest skills are present. No plugins suggested or installed.

```yaml
team:
  roles:
    - name: lead
      agents: [tech-lead-orchestrator]
      owns: [task-selection, architecture-review, final-approval]
    - name: builder
      agents: [backend-developer, test-runner, documentation-specialist]
      owns: [implementation]
    - name: architect
      agents: [architect]
      owns: [task-design, architecture-drift-detection]
    - name: reviewer
      agents: [code-reviewer]
      owns: [code-review, security-quality-gate]
    - name: qa
      agents: [qa-orchestrator]
      owns: [test-coverage-validation, bdd-scenario-verification]
    - name: advisor
      agents: [advisor]
      owns: [shortcut-detection, solution-quality, requirement-traceability]
    - name: pm
      agents: [product-management-orchestrator]
      owns: [requirement-clarification, scope-decisions, ambiguity-resolution]
    - name: documentation
      agents: [documentation-specialist]
      owns: [pr-boundary-doc-maintenance]
```

## Sprint Planning

### Sprint 1 (calendar time-box)
PR 1, PR 2, PR 3 — trigger sources and `artifact.compare`, investigator hardening, notification-state.

### Sprint 2
PR 4, PR 5, PR 6 — the two new reference behaviors, constitution-gate broadening, quarantine.

### Sprint 3
PR 7, PR 8, PR 9 — verified-fix application (security sign-off first), cross-role observability, metric instrumentation.

### Sprint 4
PR 11, then PR 10 — the three-behavior integration proof, then running it on three operating systems.

### Sprint 5
PR 12 — Foreman boundary and OMP conformance. These are Should/Could items, so they may slip without blocking the exit criteria, which PR 11 already meets.

## Acceptance Criteria Traceability

| REQ-NNN | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | File/artifact-based trigger sources | TRD-001 | TRD-001-TEST |
| REQ-002 | Release-based trigger sources | TRD-002 | TRD-002-TEST |
| REQ-003 | New sources reuse the canonical ingress | TRD-003 | TRD-003-TEST |
| REQ-004 | New behavior on an existing source type needs no code | TRD-004, TRD-033 | TRD-004-TEST, TRD-033-TEST |
| REQ-005 | Read-only investigator mode | TRD-005 | TRD-005-TEST |
| REQ-006 | Investigator cannot mutate the workspace | TRD-006 | TRD-006-TEST |
| REQ-007 | Findings distinct from verified fixes | TRD-007 | TRD-007-TEST |
| REQ-008 | Findings can source constitution proposals | TRD-008 | TRD-008-TEST |
| REQ-009 | Notify/steer the main session | TRD-009 | TRD-009-TEST |
| REQ-010 | Delivery states distinguished | TRD-010 | TRD-010-TEST |
| REQ-011 | Duplicate/stale never create duplicate runs | TRD-011 | TRD-011-TEST |
| REQ-012 | Notification content never unverified | TRD-009 | TRD-009-TEST |
| REQ-013 | Detect documentation staleness | TRD-012 | TRD-012-TEST |
| REQ-014 | Name the specific stale surface | TRD-012 | TRD-012-TEST |
| REQ-015 | Composed package, not new code | TRD-012 | TRD-012-TEST |
| REQ-016 | Detect a coverage decrease | TRD-013, TRD-033 | TRD-013-TEST, TRD-033-TEST |
| REQ-017 | Report the specific delta and area | TRD-013, TRD-033 | TRD-013-TEST, TRD-033-TEST |
| REQ-018 | Third behavior needs no Ensemble edit | TRD-014 | TRD-014-TEST |
| REQ-019 | Constitution gate accepts any authorized evidence | TRD-015 | TRD-015-TEST |
| REQ-020 | No constitution change without explicit approval | TRD-016, TRD-018 | TRD-016-TEST, TRD-018-TEST |
| REQ-021 | OS conformance (Linux/Windows/macOS) | TRD-025, TRD-026, TRD-027 | TRD-025-TEST, TRD-026-TEST, TRD-027-TEST |
| REQ-022 | No parity claim without per-OS evidence | TRD-028 | TRD-028-TEST |
| REQ-023 | Platform gaps documented, not absorbed | TRD-026 | TRD-026-TEST |
| REQ-024 | OMP independent conformance | TRD-031 | TRD-031-TEST |
| REQ-025 | Local/Foreman state contract | TRD-032 | TRD-032-TEST |
| REQ-026 | Never assert Foreman commitment locally | TRD-030 | TRD-030-TEST |
| REQ-027 | Three behaviors end to end, zero unapproved mutation | TRD-029 | TRD-029-TEST |
| REQ-028 | Config-only addition verified | TRD-014 | TRD-014-TEST |
| REQ-029 | Authoring timestamps observable | TRD-023 | TRD-023-TEST |
| REQ-030 | Turnaround metric reported | TRD-024 | TRD-024-TEST |
| REQ-031 | Quarantine persists across restarts | TRD-017 | TRD-017-TEST |
| REQ-032 | Cross-role observability | TRD-022 | TRD-022-TEST |
| REQ-033 | Verified-fix application, approval-gated | TRD-019, TRD-020, TRD-021 | TRD-019-TEST, TRD-020-TEST, TRD-021-TEST |

NFR coverage: NFR-001 and NFR-002 are covered by TRD-003. NFR-003 (reject and quarantine the whole package) is covered by TRD-017. NFR-004 (plain text, kept for the checkout's life) is covered by TRD-022 and the notification record in the data model. NFR-005 (offline) is covered by TRD-005, since every deterministic step is local. NFR-006 is covered by TRD-020: a rejected apply leaves nothing partial. NFR-007 is covered by TRD-022.

## Quality Requirements

- **Security:**
  - Every new write path goes through `MutationGuard` and `CommandRegistry`, and none bypasses them. That includes `fix.apply` through `apply-verified-fix`, and the quarantine and authoring records.
  - Notifications never trigger an agent turn.
  - Test-derived text is fenced as data.
  - Evidence is size-bounded and redacted.
  - TRD-019 needs security sign-off before implementation (constitution §4).
- **Performance:** dispatch latency is measured and reported (TRD-003). Lifecycle-point hashing reads only the configured watch set.
- **Accessibility:** plain-text status and notifications, no colour-only signals (NFR-004).
- **Testing:** every implementation task has a paired TEST task with at least 3 Given/When/Then scenarios. The constitution's coverage targets apply to the new modules: unit tests ≥60%, integration tests ≥50%.

## Adversarial Review

### Architecture self-critique

Issues from 1.0.0, still resolved:
1. The trigger schema needs extending first (TRD-001).
2. `fix.apply` rechecks staleness after approval (TRD-019).
3. POSIX-oriented shell patterns stay a deliberate PR 10 risk rather than a speculative fix (TRD-026).

Issues found in 1.1.0's source re-check, all resolved above:
4. **Stale "existing" claims.** Three target files did not exist (`constitution-apply-boundary.ts`, `shutdown-cancellation.ts`, `agent-port.test.ts`). Retargeted to where the logic actually lives.
5. **Work already done described as new.** `fix.apply` is implemented and approval-gated. PR 7 is now reachability (a behavior declaring it), a prompt that shows what changes, and commit wiring, not a new command. Its estimate fell from 6h to 4h.
6. **Missing interface.** The coverage behavior could not be configuration only: no existing command returns a structured numeric comparison. Resolved with the generic `artifact.compare` (TRD-033) in PR 1.
7. **Rule 6 gap.** Nothing wired the adapters, notification state, quarantine or status file into `activate()`. Now explicit in TRD-003, TRD-009, TRD-017, TRD-021 and TRD-022, and asserted through the entry point in their tests.
8. **Unspecified mechanisms.** "Watched-path change" and "release signal" named no mechanism. Both are now decided with their alternatives (Architecture Decision 1–2), which also resolves two PRD clarifications.
9. **Approval without substance.** The `fix.apply` prompt carried only the command description, so a human would approve blind. Fixed in TRD-019.
10. **Reuse missed.** `doc-claim-check`/`doc.verify`, `InvocationBudget`, the package-authoring harness and inert-trigger reporting now carry PR 3–5.
11. **Name collision.** The existing write-revert `quarantine` map and REQ-031's package quarantine are kept separate (TRD-017).

### Task coverage analysis

- 33 of 33 REQs have at least one implementation task and one test task.
- Every TEST task lists `Validates PRD ACs` and has between 3 and 5 scenarios, each on one line in Given/When/Then form.
- Every PR's Shippable State describes something a user can observe.

Gap in the source PRD, flagged rather than fixed here: 28 of its 33 requirements have fewer than the 3 ACs `/create-trd` expects. The affected REQs are:
- Must: REQ-001–004, 009, 011–014, 016–018, 021–022, 026–029, 031–032;
- Should: REQ-007, 008, 015, 019, 024;
- Could: REQ-023, 025, 030.

The TRD's scenarios cover each requirement's happy, edge and failure paths under its existing ACs. The PRD itself should gain the missing ACs through `/ensemble:refine-prd`.

### Dependency and estimate review

- **Dependency issue found and resolved:** PR 10 ran before PR 11 in 1.0.0's sprint plan, but it verifies PR 11's suite. TRD-025–027 now depend on TRD-029, and Sprint 4 orders PR 11 before PR 10.
- **Critical path** (computed from `[depends:]`, 7 tasks): TRD-001 → TRD-033 → TRD-013 → TRD-004 → TRD-014 → TRD-024 → TRD-024-TEST.
- No cycles among the 66 tasks.
- **Estimate issue:** TRD-022 may exceed 4h if a CLI renderer turns out to be needed; this is flagged.
- **Estimate issue:** TRD-026 is an 8h+ candidate; this is flagged.
- **Estimate change:** TRD-019 fell to 4h and TRD-021 rose to 3h, because `commit-policy.ts` needs wiring, not just a test.

### Testability review

- Every Implementation AC and scenario has an observable pass/fail condition.
- Gates that grade acceptance have a scenario that plants the defect and watches the gate fail (Rule 7): TRD-003, TRD-004, TRD-006, TRD-014, TRD-025, TRD-028.
- NFR-001 is measured, not asserted against an invented threshold.
- REQ-030's missing baseline is carried forward verbatim.

## Constitution Gate

Source: `docs/standards/constitution.md` (canonical; `.specify/memory/constitution.md` absent). The gate was evaluated against this draft before saving.

| Article | Check | Result |
|---|---|---|
| Rule 1 — No secrets in code | Evidence redaction (TRD-007); no credentials introduced | PASS |
| Rule 2 — Input validation | New events enter only through `normalizeEvent`; `artifact.compare` has an input schema; the quarantine record fails closed on corruption | PASS |
| Rule 3 — Tests accompany features | Every implementation task has a TEST task covering its ACs | PASS |
| Rule 4 — Ownership boundary | The backlog, snapshots and coverage baseline are session-local and in memory. Quarantine, authoring and notification records are checkout-local policy files with no scheduling, retry or recovery semantics. There is no second dispatcher (TRD-003 import boundary) | PASS |
| Rule 5 — Runtime-enforced tool boundary | Investigator grants and `MutationGuard` modes are enforced by the harness (TRD-006, TRD-019). Notifications cannot trigger a turn | PASS |
| Rule 6 — Reachable from the entry point | Adapters, notification state, quarantine, the apply behavior, commit policy and the status file are each wired into `activate()` and asserted through it | PASS |
| Rule 7 — A verification must be able to fail | Planted-defect scenarios on every acceptance gate (see Testability review) | PASS |
| Rule 8 — User-editable in config | Tag pattern, watch paths, metrics, threshold, doc globs and prompts live in `behavior.yaml` or prompts. Code holds only enforcement and grading | PASS |
| §2 Tech Stack | TypeScript/Node, Jest, GitHub Actions matrix; no new runtime dependency | PASS |
| §3 Quality Gates | Coverage targets stated for new modules (Quality Requirements) | PASS |
| §4 Approval Requirements | No new dependencies. Architecture kept as approved (Option B). TRD-019 is security-sensitive and gated on sign-off | PASS |
| Amendment 2026-09-29 | CI verdicts come from each command's own exit status, with no pipes (TRD-025–027). Suite grading reuses `verifyOutput` | PASS |

**Constitution compliance: passed.**

## Design Readiness Scorecard

| Dimension | Score (1-5) | Rationale |
|---|---|---|
| Architecture completeness | 4 | Components, interfaces and data flows are defined and re-checked against current source. The two mechanisms 1.0.0 left open (change detection, release signal) are decided with alternatives. Cross-platform behavior is still deliberately left to real CI evidence. |
| Task coverage | 5 | 33/33 REQs have implementation and test tasks. Every TEST task has `Validates PRD ACs` and 3–5 single-line Given/When/Then scenarios. `trd-cli.js parse` reports no warnings. The PRD's own AC shortfall is flagged above. |
| Dependency clarity | 4 | Explicit and acyclic. One ordering error (PR 10 before PR 11) was found and fixed. |
| Estimate confidence | 4 | Consistent and complexity-proportionate. Two estimates are explicitly flagged as possibly optimistic, and two were corrected after the source re-check. |

**Overall: 4.25 — PASS.**
