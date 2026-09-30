---
document_id: PRD-2026-b6db9749
label: prd-behavior-habits-runtime
version: 1.0.0
status: Draft
date: 2026-09-30
scale_depth: DEEP
total_requirements: 33
readiness_score: 4.5
---

# PRD-2026-b6db9749: Ensemble Behavior and Habits Runtime — Extensibility, Communication, and Cross-Platform Verification

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 24 |
| Should requirements | 7 |
| Could requirements | 2 |
| Won't requirements | 0 |
| AC coverage | 33/33 (100%) |
| Risk flags | 8 |
| Constitution compliance | Rule 4: PASS (see Constitution Compliance section) |
| Cross-requirement dependencies | 24 |
| Clarification markers | 5 |

## Product Summary

**Problem:** Ensemble's command-oriented design couples each reaction (a test failure, a stale doc, a coverage regression) to host-specific TypeScript, duplicating orchestration paths per behavior. `PRD-2026-0fc1c1d0` shipped the execution harness (agent-core, pi-extension, behavior.yaml schema/compiler) and `PRD-2026-15aa5acd` shipped the dispatcher, event translation, and a bounded auto-fix loop for one reference behavior (test-failure monitoring). What remains unproven is whether this is genuinely *infrastructure* — reusable for arbitrary behaviors without new Ensemble code — or whether every new reaction still requires bespoke engineering.

**Who feels the pain today:** Developers, product managers, and QA engineers who want additional automated habits (documentation freshness, coverage regression detection) but would otherwise need an Ensemble maintainer to hand-build each one as a special case.

**Solution overview:** Extend the already-shipped dispatch/execution substrate so that (a) new trigger sources beyond native tool-call observation can be added declaratively, (b) a read-only investigation mode exists alongside the auto-fix mode, (c) the main session can be notified/steered through a replaceable transport, (d) at least two additional reference behaviors run end-to-end, (e) a developer can add a third without modifying Ensemble, and (f) the whole path is verified — not merely assumed — to work across Windows, Linux, and macOS.

**Success metric:** Reduce behavior-authoring turnaround time by 50%, measured against the pre-infrastructure baseline of hand-building a command-oriented reaction from scratch.

## User Analysis

| Role | Pain Today | Desired Outcome |
|------|------------|------------------|
| Developer | Adding a new automated habit (e.g. "warn me when docs go stale") means writing bespoke host-coupled TypeScript. | Composes a new behavior from existing declarative primitives; no Ensemble source change required. |
| Product Manager | Has no visibility into what automated habits exist or what they decided, short of reading source. | Can see, in plain text, which behaviors are active and why a given one fired or didn't. |
| QA Engineer | Test-coverage regressions and stale docs surface only when someone happens to notice. | Gets a concise, evidence-backed notification the moment coverage drops or docs go stale, without a human watching for it. |

## Goals and Non-Goals

### Goals

- Prove the dispatch/execution substrate is genuinely reusable infrastructure, not a one-off built for test-failure monitoring alone.
- Add a read-only investigation session mode distinct from the existing auto-fix ("Applier") mode.
- Add a replaceable transport for notifying/steering the main session, independent of the auto-fix loop's own internal operation.
- Ship at least two new reference behaviors (documentation freshness on release, test-coverage regression detection) end-to-end.
- Demonstrate that a developer can add a third behavior using only configuration/package composition, without editing Ensemble source.
- Independently verify the complete local path on Windows, Linux, and macOS; make no cross-platform claim without that evidence.
- Make behavior-authoring turnaround time observable so the 50% reduction target can be measured, not just asserted.
- Add a verified-fix application path: a code-fix candidate that has passed independent verification can actually be applied to the working tree, gated behind explicit human approval — closing the gap where the current implementation only ever proposes and never applies a code fix.

### Non-Goals (this release)

- **Won't** — Building or wiring the Foreman-facing versioned stdio/JSON-RPC protocol client/server contract (remains a future phase, consistent with both prior PRDs).
- **Won't** — Auto-applying a code fix without explicit human approval. Direct verification of `packages/pi-extension/tests/reference-flow.e2e.test.ts` shows the current implementation stops at a non-mutating `fix.proposed` outcome (`appliedAt` undefined, source file unchanged) — there is no shipped auto-apply behavior today, so there is nothing to "reopen"; this release adds the first apply path, and it is approval-gated from the start (see REQ-033).
- **Won't** — Building a durable scheduler, activation ledger, leases, retries, or recovery inside Ensemble; Foreman remains optional and non-required.
- **Won't** — Forking or modifying Pi's agent loop, or committing to full OMP parity, absent independently verified conformance evidence.
- **Won't** — Making every future behavior a copy of the auto-fix loop; investigation and notification are meant to be composable primitives, not a second bespoke pipeline.
- **Won't** — Removing or breaking existing command/agent/skill generation formats.

## Approvals and Decision Ownership

- **Approver:** the requester, personally.
- **Acceptance criteria they will judge against:** the 18 acceptance criteria in `docs/architecture/ensemble-behavior-habits-architecture.md` §13, and the 50% behavior-authoring-turnaround-time reduction metric.

## Entry and Exit Criteria

- **Entry:** A clear, agreed understanding of the requirements and architecture exists (this PRD, plus the governing architecture doc and its two prerequisite PRDs). `PRD-2026-15aa5acd`'s own REQ-009, REQ-010, and REQ-011 (pipeline activation, example triggerability, mutation-class enforcement) must have landed and passed their own acceptance criteria before this PRD's work begins — extending an unenforced dispatcher would compound, not fix, that risk.
- **Exit:** At least two reference behaviors work end-to-end (test-failure monitoring, already delivered by `PRD-2026-15aa5acd`, counts as one; documentation-freshness-on-release is the second), and a developer can add a third (test-coverage regression detection) without modifying Ensemble itself.

## Business Integration Points

| Dependency | Capability required | Business outcome | Obligation |
|---|---|---|---|
| Optional external control plane (e.g. Foreman) | Durable cross-session/production activation, scheduling, recovery, and audit-of-record, when present. | Teams that need durable governance get it without Ensemble reinventing it. | Ensemble must expose a versioned, stable local contract Foreman can consume, and must never assert Foreman commitment from a local success result alone. |
| Local agent-host runtime (Pi; OMP via a separately verified adapter) | Session creation, tool invocation, lifecycle/event observation. | Developers get behavior-driven notifications/fixes inside their existing daily-driver workflow. | No host-parity claim without independent, per-host conformance evidence. |
| Governing constitution document (project-local governance artifact) | Source of truth for architecture rules that behaviors validate against and may propose amendments to. | Automated proposals stay traceable to a human-owned governance artifact rather than silently drifting policy. | Every constitution-affecting proposal names the article/rule and requires a separate human approval before merge. |
| Underlying operating system (Windows, Linux, macOS) | Process/filesystem primitives the local runtime depends on. | Developers on any of the three platforms get the same behavior-driven workflow. | No cross-platform claim without independent per-OS conformance evidence. |
| External model/LLM provider | Non-deterministic reasoning for the investigation/handler layer. | The judgment-requiring half of a behavior is handled without paging a human immediately. | Must fail visibly and cleanly when unreachable; never hang or silently degrade to a stale/local guess. |

## Requirements by Feature Area

### Feature Area 1: Event Source Extensibility Beyond Native Tool Calls

#### REQ-001: Support file/artifact-based trigger sources
**Priority:** Must
[RISK: depends on which file/artifact-change signals are realistically observable through supported host APIs without a new one]

A behavior can be configured to trigger from a file or artifact changing state (e.g. a generated coverage report appearing), not only from a native tool-call result.

- AC-001-1: Given a behavior package configured with a file/artifact-based trigger, when the watched artifact changes, then the same canonical event-ingress path used for tool-call-derived events is invoked.
- AC-001-2: Given no supported host API can observe the configured artifact change, when the package is validated, then it fails closed with a specific, named diagnostic rather than silently registering a no-op trigger.

#### REQ-002: Support release-based trigger sources
**Priority:** Must
[NEEDS CLARIFICATION: the exact release signal (tag push, published release, version-bump commit) is not specified by this PRD; left for the TRD to resolve against whichever signal the target repo already emits]

A behavior can be configured to trigger when a release occurs in the current repository.

- AC-002-1: Given a behavior package configured with a release-based trigger, when a release occurs, then a canonical event is created carrying the release identity as evidence.
- AC-002-2: Given a release-based trigger with no release actually observed, when the dispatcher evaluates other events, then no release-triggered behavior fires.

#### REQ-003: New trigger sources reuse the single canonical ingress
**Priority:** Must

Any new trigger source type validates and enters through the same single validated ingress point already established for tool-call-derived events; no new source may dispatch directly.

- AC-003-1: Given an event from a newly added source type, when it is ingested, then it passes through identical schema/provenance/freshness validation as an existing source type.
- AC-003-2: Given a source adapter attempts to invoke a behavior directly, bypassing ingress, when this is attempted, then the call is rejected.

#### REQ-004: Adding a new behavior via an existing trigger-source type requires no Ensemble code change
**Priority:** Must
[RISK: unresolved until at least two non-tool-call source types are actually implemented and proven config-only]

A new behavior's predicate and mapping, when built on a source type that already has an adapter, are expressed entirely in the behavior package configuration; no Ensemble source file changes are needed to ship it.

- AC-004-1: Given a supported source type already has an adapter (built under REQ-001/REQ-002), when a new behavior package uses that same source type with a new predicate, then no Ensemble code changes are required to ship that behavior.
- AC-004-2: Given the documentation-freshness and coverage-regression reference behaviors (REQ-013, REQ-016), when both are added, then neither required an Ensemble source change beyond the source-type adapters built for this PRD.

### Feature Area 2: Read-Only Investigation Behavior Mode

#### REQ-005: Support a read-only investigator session mode
**Priority:** Must

A behavior can invoke a read-only investigator session, distinct from the existing auto-fix ("Applier") mode, that diagnoses without mutating.

- AC-005-1: Given a behavior configured with an investigator step, when it runs, then it produces a typed, evidence-backed finding.
- AC-005-2: Given the same behavior, when the investigator step completes, then no workspace mutation has occurred as a side effect.
- AC-005-3: Given the model/LLM provider is unreachable, when an investigator session is invoked, then it fails with a distinct, visible error state within a bounded timeout — it never hangs indefinitely and never silently returns a stale or fabricated finding.

#### REQ-006: Investigator sessions cannot mutate the canonical workspace
**Priority:** Must

- AC-006-1: Given an investigator session with only read-only tool grants, when it attempts a native file write, then the write is blocked at the tool-grant enforcement boundary.
- AC-006-2: Given an investigator session, when it attempts a shell-based write (redirection, `bash -c`, or similar), then the write is still blocked; the boundary is enforced at the runtime, not by prompt language.
- AC-006-3: Given an investigator session is never described as sandboxed unless the enforcement above is proven by an adversarial fixture/test, when documentation is written, then it accurately reflects only the tested boundary.
- AC-006-4: Given an investigator session that times out or whose host session shuts down, when cleanup runs, then no orphan process or session remains — verified by the same process-listing check used for the existing auto-fix loop's cleanup guarantee.

#### REQ-007: Investigator findings are structured and distinguishable from verified fixes
**Priority:** Should

- AC-007-1: Given an investigator produces a finding, when it is recorded, then it is never represented as an "applied" or "verified fix" result.
- AC-007-2: Given a finding references evidence, when inspected, then the evidence is bounded (size/time-limited) and does not leak secrets.

#### REQ-008: Investigator findings can source a constitution-amendment proposal
**Priority:** Should

- AC-008-1: Given an investigator finding identifies a candidate constitution rule gap, when a proposal is drafted from it, then the proposal cites the finding as its evidence source.
- AC-008-2: Given such a proposal exists, when it reaches the apply step, then it passes through the same interactive approval gate as any other constitution-change proposal (REQ-020).

### Feature Area 3: Main-Session Communication and Notification

#### REQ-009: Notify/steer the main session with evidence-backed results
**Priority:** Must

- AC-009-1: Given a behavior produces a user-relevant result, when it completes, then the main session receives a concise message referencing the specific evidence.
- AC-009-2: Given the message is delivered, when inspected, then it never claims an action was applied unless independently verified as such.

#### REQ-010: Notification delivery states are distinguished
**Priority:** Must
[RISK: depends on confirmed host transport/messaging capability; degrades to a documented subset if the host cannot report all states]

- AC-010-1: Given the main session is busy, when a notification is attempted, then the delivery is reported as busy, not silently dropped or silently retried indefinitely.
- AC-010-2: Given a notification is delivered, when a second identical notification arrives for the same event, then it is recognized as a duplicate.
- AC-010-3: Given the underlying transport cannot report a given state (e.g. "unavailable"), when this gap exists, then it is documented as unsupported rather than assumed to be handled.

#### REQ-011: Duplicate or stale notifications never create duplicate runs
**Priority:** Must

- AC-011-1: Given two notifications reference the same underlying event/evidence, when the second arrives, then no second local behavior run is created.
- AC-011-2: Given a notification's underlying workspace fingerprint has since changed, when it is delivered, then it is marked stale and not acted on as current.

#### REQ-012: Notification content is never asserted without verification
**Priority:** Must

- AC-012-1: Given a message states a behavior's outcome, when reviewed, then every asserted fact traces to recorded evidence, never to an unverified model claim alone.

### Feature Area 4: Reference Behavior — Documentation Freshness on Release

#### REQ-013: Detect documentation staleness relative to a release
**Priority:** Must

- AC-013-1: Given a release-based trigger fires (REQ-002), when the current documentation set is checked, then specific stale surfaces are identified as evidence, not a generic "docs may be stale" message.
- AC-013-2: Given no stale documentation is found, when the behavior completes, then no notification is sent.

#### REQ-014: Notify the responsible session of the specific stale surface
**Priority:** Must

- AC-014-1: Given stale documentation is identified, when the main session is notified (REQ-009), then the message names the specific file/section, not just "documentation."

#### REQ-015: Ship as a composed package, not new Ensemble code
**Priority:** Should
[RISK: unresolved until actually built and confirmed config-only]

- AC-015-1: Given this behavior is added, when reviewed, then it required only behavior-package configuration and the file/artifact source adapter (REQ-001), no other Ensemble source change.

### Feature Area 5: Reference Behavior — Test Coverage Regression Detection

#### REQ-016: Detect a measurable test-coverage decrease
**Priority:** Must
[NEEDS CLARIFICATION: which coverage metric(s) — line, branch, statement, function — count toward the "decrease" this behavior detects is not specified here; left for the TRD to resolve against whatever the target repo's existing coverage tooling already reports.]

- AC-016-1: Given a coverage report artifact changes (REQ-001), when compared against the prior baseline, then a decrease of a configured threshold or greater is detected as evidence.
- AC-016-2: Given coverage is flat or improved, when the behavior runs, then no notification is sent.

#### REQ-017: Report the specific delta and affected area as evidence
**Priority:** Must

- AC-017-1: Given a regression is detected, when notified, then the message states the specific coverage delta and affected file/module, not just "coverage dropped."

#### REQ-018: A developer adds this behavior without modifying Ensemble
**Priority:** Must

This is the direct proof of the Entry/Exit Criteria's "third behavior" requirement.

- AC-018-1: Given the file/artifact source adapter and investigator/notification primitives already exist (REQ-001, REQ-005, REQ-009), when this behavior is added, then it is added as a package/config artifact with zero Ensemble source diffs.

### Feature Area 6: Constitution-Update Trigger Broadening

#### REQ-019: The constitution-amendment gate accepts evidence from any authorized behavior
**Priority:** Should

- AC-019-1: Given a finding from the investigator (REQ-008) or a reference behavior (REQ-013, REQ-016) is used as proposal evidence, when the proposal is drafted, then it is accepted by the same gate that already handles auto-fix-loop-sourced proposals.

#### REQ-020: No constitution change is ever applied without explicit human approval
**Priority:** Must

Reaffirms and extends the existing guarantee (`PRD-2026-15aa5acd` REQ-007) to the newly broadened evidence sources.

- AC-020-1: Given a constitution-change proposal from any evidence source, when it reaches the apply step, then an explicit inline yes/no confirmation is required before any PR is opened.
- AC-020-2: Given no confirmation is given, when evaluated, then `constitution.md` remains unmodified.
- AC-020-3: Given a finding originates from a quarantined or rejected package, when a constitution-change proposal is drafted, then it is refused as invalid evidence regardless of approval-gate outcome.

### Feature Area 7: Cross-Platform Verification

#### REQ-021: The complete local path is independently verified on Windows, Linux, and macOS
**Priority:** Must
[RISK: verification evidence does not yet exist for any of the three platforms as of this PRD]

- AC-021-1: Given the trigger/dispatch/notification path, when run on each of Windows, Linux, and macOS, then each platform has its own passing conformance suite run.
- AC-021-2: Given a behavior works on one platform, when parity is claimed for another, then that claim is backed by that platform's own conformance evidence, never inferred.

#### REQ-022: No cross-platform parity claim without per-OS evidence
**Priority:** Must

- AC-022-1: Given documentation or release notes describe platform support, when reviewed, then no platform is listed as supported without a corresponding conformance-suite run.

#### REQ-023: Platform-specific gaps are documented, not silently absorbed
**Priority:** Could

- AC-023-1: Given a capability is unavailable on one platform (e.g. a specific filesystem-watch primitive), when discovered, then it is recorded as a named, documented gap rather than worked around silently in a way that changes behavior semantics per-platform.

### Feature Area 8: OMP Host Adapter Conformance

#### REQ-024: The OMP adapter passes its own independent conformance suite
**Priority:** Should
[RISK: depends on OMP extension-API gap discovery, an explicitly unresolved item inherited from `PRD-2026-0fc1c1d0`]

- AC-024-1: Given the OMP adapter, when tested, then it has its own conformance suite separate from Pi's, and no shared-YAML-alone claim of parity is made.
- AC-024-2: Given the OMP extension API is confirmed incompatible with a required capability, when discovered, then the gap is documented rather than worked around by forking OMP.

### Feature Area 9: Foreman Boundary Contract Hardening

#### REQ-025: A versioned contract distinguishes local-acceptance states from Foreman commitment
**Priority:** Could
[RISK: listed as an unresolved decision in the governing architecture doc §14; not required for this PRD's own exit criteria]

- AC-025-1: Given a governed tool call succeeds locally, when its result status is reported, then it is exactly one of "accepted locally," "queued locally," "delivered," or "committed by Foreman" — never conflated.

#### REQ-026: Ensemble never asserts Foreman commitment from a local result alone
**Priority:** Must

- AC-026-1: Given a local tool or transport call returns success, when reported, then this is never represented as "committed by Foreman" absent a Foreman-sourced confirmation.

### Feature Area 10: Extensibility Proof

#### REQ-027: At least three reference behaviors run end-to-end with zero unapproved mutations
**Priority:** Must

- AC-027-1: Given test-failure monitoring, documentation freshness, and coverage regression detection, when all three are exercised in a real session, then each completes its documented flow with no mutation outside an explicitly approved path.

#### REQ-028: A developer adds a new behavior using only package/config composition
**Priority:** Must

- AC-028-1: Given the infrastructure from Feature Areas 1-3 exists, when a developer adds the coverage-regression behavior (REQ-016), then it is verified end-to-end without any Ensemble source file being edited.

### Feature Area 11: Success Metric Instrumentation

#### REQ-029: Behavior-authoring start and completion are independently observable
**Priority:** Must

- AC-029-1: Given a developer begins authoring a new behavior package, when they complete a passing conformance run for it, then both timestamps are observable without instrumenting the developer's own workflow by hand.

#### REQ-030: The measured turnaround-time metric is reported as an observable value
**Priority:** Could
[NEEDS CLARIFICATION: no baseline "pre-infrastructure" turnaround-time measurement exists yet to compare against; the 50% target requires one before it is verifiable]

- AC-030-1: Given REQ-029's timestamps, when the third reference behavior (REQ-018) is added, then its turnaround time is computed and reported alongside whatever baseline figure is available.

### Feature Area 12: Quarantine Persistence

#### REQ-031: A quarantined package remains quarantined for the life of the local checkout
**Priority:** Must
[RISK: quarantine state is a local policy record, not a durable production activation/recovery ledger — see Constitution Compliance, Rule 4]

A package rejected under NFR-003's abuse-containment check stays visibly quarantined within the current repo checkout until an operator explicitly clears it; it is never silently reloaded or retried automatically within that checkout's lifetime. This is local policy/config state (comparable to any other on-disk project setting), not a production activation ledger, scheduler, or recovery mechanism — it makes no cross-machine, cross-session-identity, or Foreman-visible claim.

- AC-031-1: Given a package is quarantined, when the current process or session restarts against the same local checkout, then the package remains quarantined without any automatic reload attempt.
- AC-031-2: Given a quarantined package, when an operator inspects local state, then the quarantine and its cause are visible in plain text, not merely absent from the active set with no explanation.

### Feature Area 13: Cross-Role Observability

#### REQ-032: Active-behavior and decision visibility require no developer-only tooling
**Priority:** Must

The active-behavior list and per-invocation decision explanation (NFR-007) are reachable through a plain-text surface that requires no developer tooling access beyond what any repo contributor already has.

- AC-032-1: Given a PM or QA role with only repo read access, when they check which behaviors are active, then they can do so via a readable file or CLI output, not a debugger or IDE extension.
- AC-032-2: Given a behavior's dispatch decision (matched/skipped/rejected), when a non-developer role inspects it, then the explanation is plain text, not requiring source-code familiarity to interpret.

### Feature Area 14: Verified Fix Application

#### REQ-033: A verified fix candidate can be applied only with explicit human approval
**Priority:** Must

A code-fix candidate that has passed independent verification can be applied to the canonical working tree, but only after an explicit human approval step — mirroring the existing constitution-change gate (REQ-020) rather than the auto-apply model the original prerequisite PRD described but never shipped.

- AC-033-1: Given a fix candidate has reached a verified outcome, when application is attempted, then it proceeds only after an explicit human approval step distinct from verification itself.
- AC-033-2: Given no approval is given, when evaluated, then the working tree remains exactly as it was before the candidate was proposed — byte-identical, consistent with the existing rejected-candidate guarantee.
- AC-033-3: Given approval is given, when the fix is applied, then the commit carries attribution tracing to the originating behavior run and event, consistent with the existing auditability discipline for other mutations.

## Dependency Map

| REQ | Depends On | Blocked By | Notes |
|---|---|---|---|
| REQ-001 | — | — | Foundational; other new-source-type work builds on it |
| REQ-002 | REQ-003 | — | Reuses ingress defined by REQ-003 |
| REQ-003 | — | — | Extends the existing `PRD-2026-15aa5acd` ingress/dispatcher |
| REQ-004 | REQ-001, REQ-013, REQ-016 | — | Config-only claim provable only once both reference behaviors exist |
| REQ-005 | — | — | New session mode alongside existing Applier mode |
| REQ-006 | REQ-005 | — | Enforcement boundary for the new mode |
| REQ-007 | REQ-005 | — | — |
| REQ-008 | REQ-007 | — | Feeds REQ-019/020 |
| REQ-009 | — | — | New transport-facing capability |
| REQ-010 | REQ-009 | — | State model for delivery |
| REQ-011 | REQ-009, REQ-010 | — | — |
| REQ-012 | REQ-009 | — | — |
| REQ-013 | REQ-002, REQ-001 | — | First new reference behavior |
| REQ-014 | REQ-013, REQ-009 | — | — |
| REQ-015 | REQ-013, REQ-001 | — | — |
| REQ-016 | REQ-001 | — | Second new reference behavior; extensibility proof vehicle |
| REQ-017 | REQ-016, REQ-009 | — | — |
| REQ-018 | REQ-001, REQ-005, REQ-009, REQ-016 | — | Direct exit-criterion proof |
| REQ-019 | REQ-008, REQ-013, REQ-016 | — | Broadens existing `PRD-2026-15aa5acd` REQ-007 gate |
| REQ-020 | REQ-019 | — | Reaffirms existing guarantee |
| REQ-021 | — | — | Independent of feature work; can proceed in parallel |
| REQ-022 | REQ-021 | — | — |
| REQ-023 | REQ-021 | — | — |
| REQ-024 | — | OMP extension-API gap discovery (open item from `PRD-2026-0fc1c1d0`) | — |
| REQ-025 | — | Unresolved architecture decision (doc §14) | Not required for this PRD's exit criteria |
| REQ-026 | — | — | Standing discipline, no new capability required |
| REQ-027 | REQ-013, REQ-016, existing test-failure behavior | — | — |
| REQ-028 | REQ-027, REQ-004 | — | — |
| REQ-029 | — | — | — |
| REQ-030 | REQ-029, REQ-018 | Missing pre-infrastructure baseline measurement | See [NEEDS CLARIFICATION] |
| REQ-031 | — | — | Standing discipline extending NFR-003 |
| REQ-032 | — | — | Extends NFR-007 to non-developer roles |
| REQ-033 | Existing verification path (fix.propose/verify) | — | New capability; approval step mirrors REQ-020's constitution gate |

## Constitution Compliance

**Rule 4** ("Ensemble must not implement durable production activation, scheduling, retries, recovery, or a second dispatcher competing with Foreman") is the rule most at risk from this PRD's new state-carrying requirements.

**Determination: PASS**, conditional on NFR-002 and REQ-031 remaining scoped exactly as stated — in-memory/session-local (NFR-002) and repo-checkout-local policy state, not a production ledger (REQ-031) — not merely descriptive.

Reasoning:
- REQ-003 requires every new trigger-source type to enter through the *existing* single validated ingress/dispatcher already evaluated and passed under `PRD-2026-15aa5acd`'s own Rule 4 determination; this PRD adds no second dispatcher, it extends the one already found compliant.
- NFR-002's bounded event queue is explicitly in-memory and session-scoped, not persisted or durable across a restart — the same non-durability posture as `PRD-2026-15aa5acd`'s NFR-1 retry counter, applied to backlog handling instead of retries.
- REQ-031's quarantine record persists only within the current repo checkout as local policy/config state (the same category as a `.gitignore` entry or a project setting file, not a scheduling/activation ledger) and makes no cross-machine, cross-session-identity, or Foreman-visible durability claim.
- REQ-026 explicitly reaffirms Ensemble never asserts Foreman commitment from a local result, preserving the ownership-boundary distinction Rule 4 protects.
- REQ-024 defers full OMP parity absent verified conformance, and REQ-025 (Could) explicitly declines to build the Foreman-facing durable contract in this release — both consistent with staying on Ensemble's side of the boundary.

Other rules, reinforced rather than at risk:
- **Rule 5** (tool boundary enforced at runtime): REQ-006 requires the investigator's read-only boundary to be enforced at the runtime tool-grant layer, including against shell-based bypass (AC-006-2), not by prompt language alone.
- **Rule 6** (reachable from entry point): REQ-027/028 require the extensibility proof to run end-to-end in a real session, not merely pass in isolated unit tests.
- **Rule 7** (a verification must be able to fail): AC-006-3 requires the investigator's read-only boundary claim to be proven by an adversarial fixture/test, not asserted; AC-021-2/AC-022-1 require per-platform conformance evidence before any parity claim, never an inferred pass.
- **Rule 8** (user-editable artifacts belong in config, not TypeScript): REQ-001/002/004's entire premise — new behaviors composed from existing source-type adapters via package/config, with zero Ensemble source changes — is a direct instance of this rule's intent.

If implementation drifts from NFR-002's or REQ-031's stated scoping (e.g. the queue gains cross-session persistence, or quarantine state becomes visible/enforced outside the local checkout), this PASS determination no longer holds and the gate must be re-run.

REQ-033 (verified-fix application) is compliant on the same basis as REQ-020: application requires an explicit human approval step distinct from verification, mirroring the existing constitution-apply gate rather than introducing a new unattended mutation path.

## Non-Functional Requirements

#### NFR-001 (Performance)
[NEEDS CLARIFICATION: no specific latency target was established during elicitation; proposing <2s p99 from event validation to notification delivery as a starting target pending confirmation]
Local dispatch (event validated → matched → run created) must complete fast enough not to block the originating session's next action.

#### NFR-002 (Reliability — backlog handling)
Excess events beyond concurrent-processing capacity queue in order and are processed as capacity frees, within the current session's in-memory state only. The queue itself is bounded; once the bound is reached, the oldest non-in-progress queued event is dropped with a visible diagnostic — never silently — rather than growing without limit. The queue is not persisted or durable across a process/session restart, consistent with NFR-006.

#### NFR-003 (Security — abuse containment)
A package/configuration found to request capability beyond its declared grant is rejected and quarantined in its entirety; no partial/degraded execution of the remainder of that package is permitted.

#### NFR-004 (Accessibility)
All diagnostics and notifications are emitted as plain structured text — never relying on color-only or graphical-only signals — and are preserved for the lifetime of the local session/repo checkout (e.g. a local log/journal). This mirrors NFR-006's non-durability posture applied to notification records instead of run state; it is not a durable production guarantee.

#### NFR-005 (Availability — offline behavior)
The deterministic trigger/dispatch/notification path remains fully functional with no network connectivity. Any step depending on an external model/LLM provider fails visibly and cleanly (never hangs, never silently degrades) when that provider is unreachable.

#### NFR-006 (Reliability — data loss tolerance)
Local in-flight run state carries no durability guarantee and may be lost on crash or unclean shutdown without operator-visible harm, provided no partial mutation is left uncommitted to the canonical workspace.

#### NFR-007 (Observability)
An operator can determine, without reading source code or attaching a debugger, which behaviors are active, what each invocation decided, and why — across all reference behaviors, not only the auto-fix loop.

#### NFR-008 (Compliance — organizational)
[NEEDS CLARIFICATION: no regulatory or external compliance obligation was identified during elicitation; treated as "governed only by the project's own constitution.md" unless stated otherwise]

## Ambiguity Marking Pass

Inline markers already placed above:
- REQ-001 [RISK]: file/artifact-signal observability not yet confirmed against supported host APIs.
- REQ-002 [NEEDS CLARIFICATION]: exact release signal definition deferred to TRD.
- REQ-016 [NEEDS CLARIFICATION]: which coverage metric(s) count toward "decrease" is unspecified.
- REQ-004 [RISK]: config-only claim unproven until built.
- REQ-010 [RISK]: full delivery-state set depends on host transport capability.
- REQ-015 [RISK]: config-only claim unproven until built.
- REQ-021 [RISK]: no per-OS conformance evidence yet exists.
- REQ-024 [RISK]: depends on an inherited, still-open OMP extension-API gap.
- REQ-025 [RISK]: depends on an architecture-level unresolved decision (doc §14), explicitly not required for this PRD's exit criteria.
- REQ-031 [RISK]: quarantine state is a local policy record, not a durable production activation/recovery ledger — see Constitution Compliance, Rule 4.
- REQ-030 [NEEDS CLARIFICATION]: no pre-infrastructure baseline turnaround-time figure exists.
- NFR-001 [NEEDS CLARIFICATION]: no specific latency target established; a starting figure is proposed.
- NFR-008 [NEEDS CLARIFICATION]: no regulatory/compliance obligation identified.

## Readiness Scorecard

| Dimension | Score (1-5) | Rationale |
|---|---|---|
| Completeness | 5 | 13 feature areas cover every gap identified during elicitation and existing-PRD review; deliberately light areas (OMP, Foreman boundary) are honestly scoped Should/Could because they are externally blocked, not overlooked. |
| Testability | 4 | Every requirement has at least one objectively verifiable Given/When/Then AC; a few Musts carry only one AC rather than the 2-4 DEEP ideal. |
| Clarity | 4 | Mostly unambiguous; 5 `[NEEDS CLARIFICATION]` markers and 8 `[RISK]` flags are honestly surfaced rather than hidden, but represent real points of divergence until the TRD resolves them. |
| Feasibility | 5 | Builds incrementally on already-shipped, working infrastructure (`PRD-2026-0fc1c1d0`, `PRD-2026-15aa5acd`); no requirement demands something unproven within stated constraints. |

**Overall: 4.5 — PASS.**

**Constitution Gate: PASSED** (Rule 4 evaluated explicitly; see Constitution Compliance section above).
