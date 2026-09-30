# Ensemble Behavior and Habits Architecture

- **Status:** Proposed design and implementation plan
- **Date:** 2026-09-30
- **Repository:** Ensemble
- **Audience:** Ensemble maintainers and implementers
- **Local agent hosts:** Pi first; OMP through a separately verified adapter
- **Related control plane:** Foreman

## 1. Executive decision

Evolve Ensemble toward a **behavior-driven local harness**, not a larger collection of provider-specific commands and not a replacement for Pi or OMP's agent loop. A behavior is a versioned, data-driven workflow that says which trusted event facts it reacts to, which bounded steps it runs, which tools it may request, and what outcomes it may produce.

Adopt these boundaries:

1. **Host trigger adapters observe and normalize.** Use the host's native extension and lifecycle APIs as the default integration. Keep hook systems such as `pi-yaml-hooks` optional adapters for event sources or user-authored mappings where they provide a real gap-filling benefit. Hook configuration is executable/trusted input when it can run shell code.
2. **Ensemble owns the local behavior runtime.** It owns portable behavior packages, schema validation, event normalization, deterministic matching, dispatch, a constrained workflow interpreter, local run visibility, and the typed command/policy boundary.
3. **Agent sessions perform bounded steps.** A session is an execution substrate, not a behavior definition, event bus, authorization boundary, or sandbox by itself. Separate sessions require explicit supervision, tool grants, lifecycle handling, and, for write access, real workspace/process isolation.
4. **Communication is a replaceable port.** Start with the smallest transport that works for the Pi daily-driver path. Treat `pi-intercom` or a similar project as a candidate session-message transport, not as the canonical event log or behavior dispatcher. Adopt it only after a focused compatibility and failure-semantics spike.
5. **CQRS remains the effect boundary.** Skills, prompts, triggers, and agent sessions may form requests. Effects go through registered typed commands. Authoritative handlers validate policy and evidence, perform the operation, and only then report the resulting fact/event.
6. **Foreman remains the durable production coordinator.** Ensemble's local dispatcher and run tracking must not grow durable production activation, leases, scheduling, recovery, approvals of record, or audit history.

Do not fork either Pi or a hook/communication project as the starting point. First prove the host APIs and adapters, then contribute upstream or publish a narrow Ensemble-owned adapter only if a documented gap remains.

## 2. Problem and intended product

Today, a command-oriented design makes each reaction look like another command or another special runtime branch. That leads to behavior logic coupled to a specific host, behavior-specific TypeScript, duplicated orchestration paths, and confusion about whether a skill, background task, hook, message, or session owns a workflow.

The intended model is:

```text
host facts / explicit domain requests
              |
              v
optional trigger-source adapters
              |
              v
Ensemble event ingress and validation
              |
              v
trusted local dispatcher + policy + bounded workflow runtime
              |
              +--> notify or steer the existing main session
              +--> invoke a bounded read-only handler session
              +--> request a typed command through the shared command registry
              +--> wait for a human decision through an approval adapter
              |
              v
validated results and evidence; never an unmediated state mutation
```

Example: the main agent changes code while a test process is being monitored. A test runner/monitor observes a structured failed result, attaches the test-run identity and evidence, and submits a `test.failure.observed` event. Ensemble validates the event and workspace identity, matches the configured behavior, and routes an evidence-backed notification to the main session or starts a bounded read-only investigator. Any proposed fix or constitution amendment remains a typed, reviewable proposal. A monitor's message is not proof that a fix succeeded, and an agent's claim is not a verified test result.

## 3. Scope and ownership

| Concern | Ensemble | Foreman | Pi/OMP host or adapter |
| --- | --- | --- | --- |
| Behavior authoring, package schema, prompt assets | Owns | Consumes immutable validated package snapshot | Loads packaged guidance as configured |
| Local event normalization and matching | Owns local implementation and contracts | Owns authoritative production matching | Supplies observed host facts through supported APIs |
| Local workflow execution | Owns bounded, opt-in local runtime | Owns production execution lifecycle | Supplies agent loop/session primitives |
| Local run display and cancellation | Owns local session-scoped state | Owns durable execution record | Supplies cancellation/session lifecycle APIs |
| Production event ingestion and durable activation | Does not own | Owns | No authority |
| Durable scheduling, leases, retry, recovery | Does not own | Owns | No authority |
| Approval of record and production audit | Does not own | Owns | May provide a UI or human response adapter |
| Provider-specific types | Keep inside host adapters | Keep out of domain model | Owns its native API |
| Message delivery between sessions | Uses a port/adapter; does not define message truth | May transport execution requests/results through AgentRuntime | Provides or integrates session messaging if supported |

There must be exactly one durable coordinator for a Foreman deployment: Foreman. A local Ensemble run ledger is useful for current-run observability and bounded local deduplication; it is not a second Foreman database or a durability guarantee.

## 4. Terms and authority classes

Keep these concepts distinct in code, package schemas, and documentation:

- **Trigger source:** Host API, runner monitor, filesystem/process observer, or explicit typed tool that supplies an observation to ingress.
- **Trigger mapping:** User-editable, validated configuration mapping supported source facts to canonical event types and constrained predicates. It does not execute behavior code or grant authority.
- **Event:** A versioned record with provenance, correlation, scope, payload, and authority classification. “Event” does not imply it is trusted, durable, or actionable.
- **Behavior:** A package of matching rules, workflow data, prompts, requested capabilities, policy declarations, and outcomes.
- **Dispatcher:** Ensemble code that validates events, deterministically matches enabled behaviors, checks local policy/bounds, and creates local runs. It is not a hook engine or transport.
- **Workflow interpreter:** Ensemble code that executes a small supported set of step types. New primitives require reviewed code and tests; behavior-specific sequencing uses package data.
- **Handler session:** A bounded agent invocation that performs reasoning or work under a specific tool grant and execution context. A fresh session is not necessarily isolated.
- **Transport:** A mechanism that delivers a notification/request/result between processes or sessions. Transport acceptance is not domain-event commitment, approval, or completion.
- **Typed command:** A closed-schema request for a specific operation. Its code-owned handler enforces capability, mutation class, preconditions, approval, and evidence rules.
- **Observed, reported, verified, applied:** Separate facts. Host observation or agent report cannot impersonate a verifier or authoritative mutation handler.

An LLM can analyze evidence and propose a command. The LLM cannot assign runtime-owned event identity, claim approval, expand its tool grant, or declare its own result verified.

## 5. Architecture recommendation

### 5.1 Components and responsibilities

```text
Pi lifecycle / custom tools     OMP lifecycle / tools      optional hook adapter
           \                           |                           /
            +---- host-specific source adapters and monitors ----+
                                      |
                                      v
                           EventSourceAdapter
                                      |
                                      v
                  EventNormalizer + schema/provenance checks
                                      |
                                      v
                       Local EventIngress / bounded sink
                                      |
                                      v
                   TriggerConfig + deterministic matcher
                                      |
                                      v
                        Local Dispatcher / policy gate
                                      |
                                      v
                    BehaviorRun + constrained interpreter
                         /             |                \
                        /              |                 \
             AgentSessionPort    CommandRegistry    ApprovalPort
                    |                 |                 |
            Pi/OMP adapter     typed handler/effect   human adapter
                    |                 |
                    +---- TransportPort (optional) ---+
                                      |
                         local evidence/run status
```

**Event ingress** validates source, version, payload size, event type, workspace/session identity, evidence references, and route hints. It distinguishes host-observed facts from agent-reported semantic content. Invalid or unknown inputs fail closed and produce diagnostics.

**Trigger mapping** is declarative data. It specifies a source/event mapping, constrained predicates, debounce or coalescing where supported, and enablement. It cannot name an arbitrary function, shell command, tool grant, or mutation class.

**Dispatcher** is the one local routing authority. It evaluates validated event envelopes against validated behavior packages in stable order, applies local concurrency/reentrancy limits, and creates a run with the behavior/package digest and event correlation. Hooks and transports never dispatch directly.

**Workflow interpreter** supports a deliberately small, versioned set of steps: bounded agent invocation, typed command call, condition over structured step results, approval wait, and typed outcome. It rejects unknown steps and invalid references. It does not evaluate arbitrary JavaScript or model prose as policy.

**Command registry** is the only route to behavior effects. Tool calls from an agent and command steps from a workflow resolve through the same descriptors and handlers. A result distinguishes accepted/proposed from completed/applied; success events are emitted only after the handler confirms the transition.

**Agent/session adapters** bridge provider-neutral requests to host-specific APIs. Provider-specific session objects stay behind adapters. Pi is the initial implementation target; OMP support is claimed only after its own conformance tests.

**Transport port** delivers messages or requests when sessions/processes cannot communicate directly. It does not replace ingress, matching, run state, policy, command handling, or Foreman's durable event store.

### 5.2 Separation of trigger, dispatch, workflow, session, and transport

| Layer | Owns | Must not be mistaken for |
| --- | --- | --- |
| Pi/OMP lifecycle extension | Observe host lifecycle/tool facts; register governed tools | Configurable universal behavior engine |
| YAML hook integration | Optional source trigger/mapping adapter | Trusted dispatcher, durable bus, or session sandbox |
| Ensemble dispatcher | Event validation, deterministic matching, local policy and run creation | A message broker or Foreman production coordinator |
| Behavior workflow | Declarative sequence of supported steps | Arbitrary code or a privileged command |
| Background monitor/job | Execute a bounded observation task and report structured evidence | The behavior itself or the authoritative domain state machine |
| Handler session | Reason or execute within an explicit tool/workspace grant | Isolation solely because it is a separate session |
| Intercom/message transport | Deliver inter-session notifications/requests | Event authority, policy, durable delivery, or proof of completion |
| Foreman | Durable activation, execution governance, recovery, and audit | Behavior authoring or Pi session internals |

## 6. Trigger and extension strategy

### 6.1 Recommendation

Use Ensemble's native TypeScript host extension as the primary Pi integration and maintain a small provider-neutral adapter contract. Use host-native lifecycle and custom-tool APIs where they can provide the needed observation or control. OMP receives a separate adapter only after a compatibility spike shows that the same contract can be implemented faithfully.

Keep trigger definitions outside the trusted Ensemble dispatcher so users can customize supported mappings without editing Ensemble code. That does **not** require adopting a third-party hook package as the mandatory trigger engine. The integration boundary is an `EventSourceAdapter` that submits canonical, provenance-tagged envelopes to Ensemble ingress.

Treat `pi-yaml-hooks` as a candidate optional adapter, not the architecture. Use it if the spike proves that its YAML mapping and host invocation model cover a needed source with acceptable trust, observability, and maintenance characteristics. Prefer native extension event subscriptions or upstream contributions where they offer a simpler, more maintainable route. Do not fork merely to make the package the center of the design.

### 6.2 Trigger configuration requirements

Trigger configuration must:

- Be versioned data with deterministic validation and diagnostics.
- Map only known host/source event kinds to a closed canonical event catalog.
- Express only constrained predicates over validated fields; no arbitrary expressions, shell, JavaScript, or model-defined routing.
- Declare source identity, provenance, expected payload schema, workspace scope, and whether the source is advisory or authoritative for that fact.
- Specify behavior enablement and documented debounce/coalescing rules within local scope.
- Use route hints only as requests; the dispatcher validates the target behavior and policy.
- Fail closed on unknown schemas, unsupported host capabilities, or invalid configuration.
- Be treated as executable/trusted configuration when the adapter can invoke shell code or external tools. Validation alone does not make an arbitrary hook safe.
- Support preview/simulation that never launches commands, sessions, or mutations.

Changing supported mapping data, prompts, workflow ordering, or bounded thresholds must not require rebuilding Ensemble. Adding a new trusted primitive, command handler, event schema, or enforcement capability does require code, tests, and versioning.

### 6.3 Adapter selection and publishing

The following are **design conclusions**, not claims that any third-party tool provides every required property:

| Option | Appropriate role | Decision |
| --- | --- | --- |
| Native Pi extension | Primary Pi lifecycle and governed-tool adapter | Build this first; use documented host APIs and test the exact supported version. |
| OMP extension/hooks | OMP-specific observation/control adapter | Spike separately; no parity claim from shared YAML alone. |
| `pi-yaml-hooks` | Optional user-configurable hook/source mapping | Evaluate for composition and coverage; do not make it a dependency until it passes conformance and trust review. |
| Ensemble-owned hook adapter | Narrow bridge when host APIs or upstream plugin leave a verified gap | Build only after a spike; keep its interface minimal and the dispatcher inside Ensemble. |
| Maintained fork | Required behavior blocked by upstream incompatibility or unacceptable latency | Last resort; define owner, rebase policy, compatibility matrix, and exit strategy first. |

If publishing adds leverage, publish a **thin, reusable adapter** that emits the stable Ensemble event envelope, not a competing dispatcher. Evaluate installation friction, Pi/OMP support, user configurability, safe defaults, trust model, API stability, maintenance cost, and whether upstream contribution is preferable. A publish decision is a sprint exit gate, not a prerequisite.

## 7. Events, behavior packages, and CQRS

### 7.1 Event classes and closed catalog

Maintain distinct classes:

1. **Harness facts** emitted by the adapter/runtime, such as session start, tool call/result, timeout, cancellation, and process exit.
2. **External observations** emitted by a source adapter, such as a structured test result or repository change.
3. **Agent reports/requests** submitted through a typed tool, such as an observation, diagnosis, proposal, blocked report, or approval request.
4. **Authoritative results** emitted by trusted command handlers or independent verifiers, such as change applied or tests verified.

The catalog is closed and versioned. Every event declares schema, producer/source class, authority class, allowed context, evidence requirements, and whether it can trigger a behavior. A generic internal event API may exist, but prompts must only reach typed wrappers that constrain the event types they can request. Unknown, deprecated, spoofed, or context-incompatible events fail closed.

An external or hook-derived `test.failure.observed` is a useful signal only when the monitor has a structured result and a matching workspace/test-run identity. A log line or a model statement that tests failed is a report, not a verified test outcome. A passing result is authoritative only when a verifier identifies the actual command/suite, target revision, exit status, and relevant evidence.

### 7.2 CQRS responsibilities

```text
skill / prompt / trigger / session
             |
             v
      typed command request
             |
             v
registered handler: validate schema, policy, capability, preconditions
             |
             v
perform or stage the authorized effect
             |
             v
emit truthful result/event with evidence and correlation
```

- **Skill:** instructions and task UX; never authorization.
- **Prompt:** replaceable reasoning guidance; never a tool grant or policy exception.
- **Command:** typed intent with input/result schemas, required capability, mutation class, idempotency characteristics, and emitted-event declarations.
- **Handler:** code-owned enforcement point for capability, policy, preconditions, approvals, effect, and result.
- **Event:** fact or request with provenance and authority; never an unrestricted imperative for mutation.
- **Behavior:** deterministic reaction to matching validated events, consisting of bounded reasoning and typed command requests.

Every effect initiated by a behavior, whether through a host tool or a workflow step, passes through the same authorization boundary. Do not retain a separate continuation path, special test-failure writer, or shell-based bypass.

### 7.3 Behavior package

A behavior package contains:

```text
behavior.yaml                 identity, trigger, policy, workflow, capabilities, outcomes
prompts/                       referenced editable prompt assets
skills/                        optional agent-facing guidance
fixtures/events/                representative source/canonical events
fixtures/expected/              matches, branches, denials, outcomes
README.md                       purpose, trust assumptions, setup, limitations
```

Illustrative shape (field names must be finalized against the existing package contract):

```yaml
api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: investigate-test-failure
  version: 1.0.0
trigger:
  event_type: test.failure.observed
  predicate:
    workspace_fingerprint: required
    result_status: failed
policy:
  mode: propose
  timeout: 10m
capabilities:
  tools: [read, grep, glob]
  mutation_classes: []
  commands: [ensemble.record_observation, ensemble.propose_change]
workflow:
  schema_version: "1.0.0"
  start: investigate
  steps:
    - id: investigate
      type: agent
      prompt: prompts/investigate.md
      tools: [read, grep, glob]
      timeout: 8m
    - id: record
      type: command
      command: ensemble.record_observation
      input: "${steps.investigate.result}"
    - id: finish
      type: outcome
      status: investigation_recorded
```

The example is read-only: the command may record a validated observation, but does not modify source files or constitution. A later proposal/apply flow must use separate typed operations and approval rules. Package authoring cannot grant capabilities that the host policy has not granted.

### 7.4 Configuration versus code changes

| Change | Editable package/configuration without rebuild? | Requires trusted runtime code and tests? |
| --- | --- | --- |
| Prompt/skill text, supported trigger predicates, behavior ordering, bounded timeouts within policy caps | Yes | No, but validate and include in package digest |
| Event schema or a new host-observation mapping class | No, if it changes trusted semantics | Yes; version, fixtures, adapter conformance |
| New workflow step type or condition operator | No | Yes; interpreter and schema version change |
| New typed command/effect, mutation invariant, tool enforcement boundary | No | Yes; code-owned handler, tests, policy review |
| A new behavior composed from existing primitives | Yes | No behavior-specific TypeScript branch |

Compute a package digest over the manifest and referenced assets. Every run records the immutable digest actually used. Reject unsupported schema/runtime versions rather than skipping steps.

## 8. Sessions, supervision, and security

### 8.1 Session architecture

Define a provider-neutral `AgentSessionPort` for a bounded invocation: request, context, tool grant, timeout, cancellation, structured output, usage, and normalized failure. Keep Pi and OMP types inside adapters. Reuse the existing Pi session where the product choice is “notify/steer the main agent”; create a child invocation only where isolation of reasoning/context is beneficial and the host API supports it.

The handler should not need direct raw access to other sessions. Inter-session handoffs should carry a small typed envelope containing correlation IDs, event/evidence references, workspace identity, requested operation, allowed capabilities, expiry, and reply semantics. Avoid forwarding unrestricted histories, secrets, or implicit authority.

Process supervision tracks child lifecycle, cancellation, timeout, bounded output, and cleanup. Supervision is not a sandbox. A new session may share the same filesystem, environment, credentials, network, or tools.

### 8.2 Isolation policy

| Handler mode | Default grant | Workspace/process boundary | Permitted result |
| --- | --- | --- | --- |
| Notification/steering | No extra tool access from the message itself | Existing main session; host's ordinary policy | Advisory notice and evidence links |
| Investigator | Read-only tools, bounded time/output | Dedicated session; shared workspace may still be readable | Diagnosis, evidence, typed observation |
| Candidate writer | No default availability | Disposable worktree/container or equivalent enforcement; explicit tools | Patch/proposal artifact for independent verification |
| Applier | Disabled in initial pilot | Governed command handler, approval and revalidation | Explicit, auditable apply result |

Never describe separate sessions as sandboxed unless tests prove the actual OS/process/tool boundary. Do not let the monitor, investigator, or main agent concurrently write the same canonical workspace. Prefer the main agent as the sole canonical writer; have child investigators return findings, or have a candidate writer use an isolated worktree and submit a proposal.

### 8.3 Security requirements

- Apply the effective tool grant at the real host tool invocation boundary; prompt language and manifest declarations alone are not enforcement.
- Separate tool grants from mutation classes. A `bash` grant does not imply write permission.
- Arbitrary shell can bypass application-level file monitors; require an OS/process sandbox or do not expose shell to a supposedly read-only handler.
- Bound invocation duration, step count, concurrency, retries, queue size, output, payload size, and child fan-out.
- Reject stale events and proposals using workspace fingerprint, branch/revision, behavior digest, and test-run identity.
- Avoid secrets in messages, evidence, and logs; minimize payloads and redact known credentials.
- Treat project trigger/behavior files and hook scripts as trusted code/config according to their capabilities. Show the source and effective behavior before enabling.
- Default to no autonomous mutation. “Propose” must be demonstrably non-mutating even through native tools, shell redirects, continuations, and background processes.
- Require explicit approval and revalidation before applying source, behavior, policy, or constitution changes. Verified tests do not imply approval to amend a constitution.

## 9. Communication and event-bus decision

### 9.1 Recommendation

Model the canonical event flow inside Ensemble with typed ingress, validation, matching, and local run state. Keep inter-session communication behind a replaceable `TransportPort`. A transport may deliver a notification or request, but its delivery mechanics do not define event semantics or behavior execution.

For the first vertical slice, prefer the host's supported direct session messaging/steering if it is adequate. If not, spike a candidate transport such as `pi-intercom` against a minimal contract before adoption. Do not make Intercom required merely because it is a convenient way to pass messages.

The transport contract must explicitly define:

- address/session identity and workspace/run correlation;
- message envelope version, type, size limit, and expiry;
- whether a receiver is busy, unavailable, or disconnected;
- accepted versus delivered versus consumed acknowledgement semantics;
- duplicate delivery and idempotency behavior;
- cancellation, shutdown, reconnection, and cleanup;
- trust/authentication assumptions and visibility to the user;
- whether messages are ephemeral or persisted and who owns retention.

Do not assume a transport provides durable storage, replay, exactly-once delivery, authorization, process supervision, or sandboxing. If delivery is at-least-once, idempotency and local duplicate suppression belong to the receiver/dispatcher. If delivery may be lost, surface the status and retain a local advisory run record; do not invent a durable retry service in Ensemble.

### 9.2 Event bus versus message transport

A useful distinction:

```text
canonical event ingress: structured facts -> validate -> match -> create local behavior run
session transport:       notification/request/result -> deliver to addressed session
```

A message can reference an event/run ID. A message alone is not a canonical event, and a successful transport send is not evidence that the requested action occurred. Conversely, an event may match a behavior without any inter-session message if the dispatcher starts a local handler directly.

The event handling path should be able to run using an in-process port for the initial implementation. Add broker-like transport or a published communication extension only if the need for cross-process/session communication is demonstrated by the spike and the same conformance contract can be maintained.

## 10. Reference vertical slice: monitored test failure

### 10.1 Flow

1. The main Pi/OMP session modifies code in a known workspace.
2. A monitor starts an explicitly owned test process or observes an explicitly instrumented test run. It records the command/suite, start/end time, exit status, target revision/workspace fingerprint, and bounded log/evidence references.
3. The source adapter emits a structured `test.failure.observed` event only when the monitor can classify the result. Unknown runner output is inconclusive, not failed/passed by guess.
4. Event ingress validates schema, source, workspace, run identity, and freshness.
5. The dispatcher matches the configured behavior once within its documented local scope and creates a bounded local run.
6. The default action is to notify/steer the main session with a concise evidence-backed message. Optionally, a read-only investigator analyzes the failure and returns a typed observation; it is not a competing writer.
7. The main agent decides how to proceed or requests a typed proposal. Any candidate fix is separately verified against the exact candidate/revision.
8. After a verified fix, an optional learning behavior may draft a constitution amendment proposal with rationale, evidence, affected rule, and diff. It never silently writes or approves that amendment.

### 10.2 Example sequence

```text
Main Pi/OMP session        Test monitor       Event adapter       Ensemble runtime       Main/handler session
       |                       |                   |                     |                       |
       |--- start/modify ----->|                   |                     |                       |
       |                       |--- structured failure ---------------->|                       |
       |                       |                   |--- canonical event ->|                       |
       |                       |                   |                     | validate + match     |
       |                       |                   |                     | create local run     |
       |<-------------------------- evidence-backed notification --------|                       |
       |                       |                   |                     |--- optional read-only investigation ->|
       |                       |                   |                     |<-- typed findings/proposal reference --|
       |--- typed proposal/apply request through shared command registry ----------------------->|
```

Transport is used only for the notification/handoff edge if the host's direct API cannot serve it. The monitor never decides which behavior executes; the dispatcher does. The behavior does not treat “test failure” as permission to edit. The test result cannot be reused after the workspace fingerprint changes without revalidation.

### 10.3 Pilot exclusions

The first pilot does not include auto-applying fixes, silently updating constitution, general arbitrary shell triggers, unrestricted child-agent graphs, a durable queue, cross-machine dispatch, or an Ensemble-managed production scheduler.

## 11. Local runtime state and Foreman boundary

Ensemble may keep bounded local records needed to show the current process/session's behavior run: run ID, event ID, behavior and package digest, selected route, timestamps, status, step summaries, evidence references, timeout/cancel state, and transport status. State retention and restart behavior must be explicit and modest.

Ensemble must not promise durable delivery, scheduled activation, cross-machine coordination, replay/recovery, leases, durable deduplication, approvals of record, or production audit. Do not create a second production event store. When Foreman is present, use the versioned provider-neutral package/event/invocation contracts; Foreman validates incoming facts and owns durable activation and execution governance.

The local-to-Foreman contract must distinguish `accepted locally`, `queued locally`, `delivered`, and `committed by Foreman`. Do not allow Ensemble to assert Foreman commitment merely because a local tool or transport returned success.

## 12. Implementation plan

Plan in two-week sprints as sequencing units, not delivery promises. Each sprint has an explicit exit gate. Preserve existing commands, skills, generated artifacts, and unrelated work. Do not begin with a Pi fork, a hook fork, or broad migration of every behavior.

### Sprint 0 — Evidence, host API, and adapter spikes

#### Story 0.1 — Map Pi and OMP event/control surfaces

Tasks:
- Inventory supported lifecycle, tool-call/result, turn-boundary, cancellation, and session-creation APIs in the pinned Pi/OMP versions.
- Record which facts can be observed and which actions can be controlled; mark unsupported or host-specific fields.
- Test event payload completeness, ordering, session identity, workspace identity, and shutdown behavior.
- Identify how the main session can be notified/steered and how a separate invocation can be started and cancelled.

Tests and evidence:
- Version-pinned fixtures for all events used by the proposed vertical slice.
- Adapter contract tests show deterministic normalization and fail-closed behavior for missing fields.
- No Pi/OMP parity statement without separate evidence.

#### Story 0.2 — Evaluate hook configuration and `pi-yaml-hooks`

Tasks:
- Pin the exact package revision under evaluation and review public docs/source, license, tests, host compatibility, and configuration execution behavior.
- Prototype a no-mutation mapping from a supported host observation into the Ensemble ingress envelope.
- Test malformed input, missing executables, timeouts, duplicate notifications, output limits, and hook shutdown.
- Compare native extension implementation, optional package composition, upstream contribution, and a narrow Ensemble adapter.
- Identify any need to fork and quantify the maintenance gap before proposing one.

Tests and evidence:
- Trigger mapping can be edited and validated without rebuilding the dispatcher.
- Preview mode executes no shell, process, agent, or mutation.
- Executable hooks are explicitly treated as trusted code and are not represented as sandboxed.

#### Story 0.3 — Evaluate communication and session supervision separately

Tasks:
- Prototype host-native messaging and `pi-intercom` (or another candidate) using two disposable sessions.
- Measure busy-session behavior, acknowledgement meanings, duplicates, disconnection/restart, cancellation, OMP compatibility, and cleanup.
- Separately test process supervision and actual filesystem/tool isolation; do not infer one from the other.
- Document whether a local in-process port is sufficient for the first vertical slice.

Tests and evidence:
- Contract tests for delayed, duplicate, malformed, expired, and unavailable messages.
- Host shutdown terminates owned monitor/child processes without orphan sessions.
- Delivery states distinguish sent, delivered, consumed, and unavailable to the extent the candidate supports them.

#### Sprint 0 exit gate

Select no mandatory hook or transport dependency until an adapter passes the conformance and trust matrix, has a clear owner, and provides material leverage over native APIs or a simple local port. Do not publish or fork based on feature overlap alone.

### Sprint 1 — Canonical event contract and editable trigger mappings

#### Story 1.1 — Define event envelope and source authority

Tasks:
- Define versioned event envelope with event ID, event type/schema, timestamp, source, workspace/session/run identity, correlation/causation, authority class, payload, and bounded evidence references.
- Separate host facts, agent reports/requests, verifier facts, and handler results.
- Define test-run result semantics and freshness/workspace fingerprint requirements.

#### Story 1.2 — Implement validated trigger mapping

Tasks:
- Define supported host source catalog and constrained predicate schema.
- Add configuration validation, enablement, user/project precedence, and trust diagnostics.
- Reject arbitrary code/expression fields and unsupported mappings.
- Add a side-effect-free preview command/UI path.

#### Story 1.3 — Add a single ingress API

Tasks:
- Add the provider-neutral adapter entry point selected by Sprint 0.
- Validate size, version, schema, source, workspace scope, evidence, and route hints.
- Emit visible diagnostics and report unsupported facts honestly.

Tests:
- Equivalent host fixtures normalize equivalently only for fields truly supported by each host.
- Invalid/unknown schemas and route hints fail closed.
- Preview produces no process/session/tool invocation.
- Spoofed runtime-owned fields are stripped/rejected and replaced by the runtime.

#### Sprint 1 exit gate

A no-op structured observation passes from one host adapter through mapping and ingress with provenance intact; it starts no behavior, process, or mutation.

### Sprint 2 — Dispatcher, package validation, and local run lifecycle

#### Story 2.1 — Validate and match behavior packages

Tasks:
- Validate package identity/version/digest, trigger references, predicates, workflow steps, prompt assets, tool requests, mutation classes, outcomes, time bounds, and result bindings.
- Match events deterministically and provide explanations for matched, skipped, disabled, invalid, or unauthorized behavior.
- Include the complete package/assets digest in each run.

#### Story 2.2 — Implement local dispatcher and `BehaviorRun`

Tasks:
- Create one local dispatcher; no adapter or message transport may dispatch directly.
- Track run correlation, step status, timeout, cancellation, bounded output, and terminal result.
- Define local dedup/reentrancy and concurrency limits without claiming durable delivery guarantees.
- Ensure event-trigger loops and child cycles are bounded.

#### Story 2.3 — Run one read-only handler

Tasks:
- Define the provider-neutral `AgentSessionPort` request/result.
- Launch one bounded read-only session with explicit tools and structured result/evidence.
- Add cancellation and cleanup for timeout, host shutdown, and session failure.
- Document the actual boundary; do not call a session sandboxed unless enforcement is tested.

Tests:
- Deterministic matching without an LLM invocation.
- One event creates at most one eligible active local run under documented local scope.
- Unknown behavior, invalid step, unauthorized capability, timeout, and stale event are observable and rejected/skipped.
- Read-only handler cannot write through native tools or shell in the demonstrated enforcement environment.
- Cancellation leaves no orphan processes and accurate local run status.

#### Sprint 2 exit gate

A fixture event produces one inspectable, correlated read-only handler run, with no project mutation and a complete explanation of the dispatch decision.

### Sprint 3 — Test-monitor vertical slice and main-session notification

#### Story 3.1 — Implement structured monitor adapter

Tasks:
- Support one selected test-runner observation path based on Sprint 0 evidence.
- Capture command/suite identity, exit status, target revision/workspace fingerprint, timestamps, and bounded evidence references.
- Return `inconclusive` for unrecognized or incomplete output; never infer success from a model statement.

#### Story 3.2 — Route to existing main session

Tasks:
- Notify/steer the existing main session with an evidence-backed concise failure report.
- Use a typed transport port only if direct host APIs are insufficient.
- Surface busy, delivered, unavailable, duplicate, stale, and expired states honestly.
- Offer optional read-only diagnosis without launching a second writer.

#### Story 3.3 — Add behavior fixtures and deduplication

Tasks:
- Add success, failure, unknown, stale, duplicate, and changed-workspace fixtures.
- Define bounded local deduplication keys from test run/workspace/event identity.
- Ensure a new failure event cannot create parallel fix paths.

Tests:
- End-to-end edit/run/failure/event/match/notification with exactly one main-session notification.
- Test monitor failure or ambiguous output never reports a verified result.
- Duplicate/stale messages do not start duplicate runs or use obsolete evidence.
- Delivery while busy/disconnected follows tested documented behavior.
- Monitor, child process, session, and host shutdown leave no orphan task.

#### Sprint 3 exit gate

The monitored-test flow works on the proven Pi path and reports unsupported OMP/host components rather than implying parity. It does not auto-edit source or constitution.

### Sprint 4 — Typed command registry and proposal/verification flow

#### Story 4.1 — Unify workflow and tool command execution

Tasks:
- Route workflow command steps and agent tool calls through the same typed registry.
- Enforce schemas, capabilities, mutation classes, preconditions, approval requirements, and result semantics in code-owned handlers.
- Emit result events only after handler confirmation.

#### Story 4.2 — Add proposal and independent verification

Tasks:
- Make proposal creation non-mutating and evidence-backed.
- Add verifier result schema for exact candidate/workspace/test run.
- Require approval and revalidation before applying to canonical workspace.
- Use isolated worktree for candidate writes where feasible; detect stale bases/concurrent changes.

#### Story 4.3 — Evaluate a dedicated writer

Tasks:
- Compare candidate writer in isolated worktree against main-agent ownership and proposal-only approach.
- Prove tool/process boundary, patch provenance, merge/conflict behavior, cleanup, and user-visible handoff before implementing.
- Keep dedicated write session out of scope if any enforcement condition is unproven.

Tests:
- Propose mode cannot alter canonical project through native tools, shell redirection, continuation, or hook side effect in the declared test boundary.
- Stale proposal rejected and concurrent user edits preserved.
- Model claim cannot replace independent verifier result.
- Accepted/proposed is not reported as completed/applied; approval and apply are separate records.

#### Sprint 4 exit gate

No automatic apply until hostile-tool tests prove an actual enforcement boundary; otherwise keep the runtime proposal-only.

### Sprint 5 — Constitution learning, authoring UX, and optional interoperability

#### Story 5.1 — Add constitution proposal behavior

Tasks:
- Trigger only from a verified/accepted fix or other explicitly authorized evidence source.
- Produce rationale, source evidence, affected rule, diff, and scope as a typed proposal.
- Require a separate approval and apply workflow; never silently update canonical constitution.

#### Story 5.2 — Build authoring, simulation, and diagnostics

Tasks:
- Preview source event → normalized event → matching behaviors → policy → workflow steps → requested commands.
- Add fixture-based simulation for branch/result/authorization behavior.
- Explain disabled, rejected, skipped, queued, stale, failed, and inconclusive outcomes.
- Expose package digest and active source path without leaking secrets.

#### Story 5.3 — Decide publish/fork/upstream path

Tasks:
- Compare verified host gap, install friction, configuration flexibility, safety, Pi/OMP parity, ownership, and maintenance.
- Prefer upstream contribution or composition when viable.
- Publish a narrow `@ensemble/...` adapter only if it offers reusable user-facing capability beyond packaging a dependency.
- Approve a fork only with a named owner, compatibility/rebase plan, and exit conditions.

Tests:
- Constitution behavior cannot write without the explicit approved apply handler.
- Simulation is side-effect-free.
- Pi and OMP adapters have separate conformance suites.
- Trigger/behavior/prompt digest changes are deterministic and reflected in runs.
- Third-party adapter failure cannot bypass dispatcher policy or command registry.

#### Sprint 5 exit gate

Ship a package only when its trust, compatibility, maintenance, and user value are demonstrated; otherwise retain the stable internal adapter contract and document supported options.

### Sprint 6 — Compatibility and Foreman contract hardening

#### Story 6.1 — Preserve existing Ensemble outputs

Tasks:
- Run generated command/agent/skill snapshot and compatibility tests.
- Add migration guidance without deleting existing formats.
- Document what remains local versus what is delegated to Foreman.

#### Story 6.2 — Validate cross-repository protocol

Tasks:
- Verify behavior package digest, event envelope, command result, invocation, and acceptance status against the existing contract proposal.
- Keep local acceptance distinct from Foreman committed acceptance.
- Do not add scheduling, leases, recovery, or audit-of-record to Ensemble.

Tests:
- Contract tests run without a durable Foreman service.
- Existing artifact generation remains compatible.
- Adapter types do not leak into shared domain schemas.

#### Sprint 6 exit gate

A documented versioned contract is consumable by Foreman without introducing a second production coordinator or breaking the direct local Pi path.

## 13. Acceptance criteria

Broad implementation is ready only when:

1. Users can configure supported trigger mappings without changing/rebuilding Ensemble TypeScript.
2. Host facts preserve source, scope, timestamp, correlation, and authority classification.
3. Trigger adapters call a single validated Ensemble ingress; they do not dispatch behavior or authorize commands.
4. Dispatcher matching is deterministic and separately testable from model calls.
5. Behavior definitions use constrained, versioned workflow data; unsupported primitives fail closed.
6. Prompt/config/package changes alter the recorded package digest without code rebuild when existing primitives suffice.
7. Every mutation passes the same typed command registry and enforcement path regardless of invocation source.
8. Skills, prompts, agents, and message transports cannot grant authority or forge approval/verification.
9. A separate session is never called sandboxed without evidence of actual enforcement.
10. Test-monitor results are structured, correlated to a workspace/revision, bounded, and classified as inconclusive when ambiguous.
11. The main-session notification path avoids competing canonical writers and handles duplicates/stale evidence.
12. Proposal, verification, approval, and apply remain distinct states.
13. Constitution changes are evidence-backed proposals and require a separate approved apply path.
14. Cancellation/timeout/shutdown leave no owned orphan monitor or child process.
15. Local tracking makes no promise of Foreman-level durable recovery, scheduling, or audit.
16. Pi and OMP claims are based on independent adapter conformance results.
17. Adoption, publication, or fork decisions for hooks/transports are based on spikes, license/maintenance review, and measured capability gaps.
18. Existing commands, skills, and generated artifacts remain compatible during the initial migration.

## 14. Risks and unresolved decisions

| Question | Recommendation now | Evidence required to close |
| --- | --- | --- |
| Can native Pi hooks observe every required trigger? | Use native extension first; keep source adapters pluggable. | Version-pinned lifecycle matrix and real payload fixtures. |
| Does `pi-yaml-hooks` materially improve configurable trigger authoring? | Optional candidate only; no mandatory dependency. | Prototype, source/license review, execution/trust analysis, host support matrix. |
| Should Ensemble publish its own hook extension? | Not yet; publish only a narrow adapter if a user-facing gap remains. | Gap analysis, upstream alternatives, maintenance owner, conformance suite. |
| Is `pi-intercom` a useful transport? | Potentially; never the event store or dispatcher. | Busy/disconnected/duplicate/ack/restart/cancel/OMP tests. |
| Should failures notify the main session or launch an investigator? | Notify main session by default; optional read-only investigator. | UX and latency evaluation; no competing writer. |
| Can a handler session safely modify code? | Not in the initial pilot. | Isolated workspace, enforced tool boundary, stale-base handling, hostile-tool tests. |
| Which local facts persist across restart? | Keep local semantics explicit and modest; defer durable production guarantees. | User-visible need and reconciliation contract with Foreman. |
| What source identifies a test run? | Use structured monitor/runner adapter, not generic text guesswork. | Selected runner(s), stable command/result capture, workspace fingerprinting. |

## 15. Non-goals and guardrails

- Do not fork Pi, `pi-yaml-hooks`, or a messaging extension before proving a concrete gap.
- Do not treat workflow extensions, background jobs, hooks, behaviors, and transport as interchangeable concepts.
- Do not make every behavior a copy of the test-failure implementation.
- Do not make every behavior require custom TypeScript; new trusted primitives do, new compositions do not.
- Do not turn the behavior manifest into an arbitrary-code language.
- Do not allow hooks or messages to call privileged handlers outside Ensemble's dispatcher and command registry.
- Do not treat communication delivery as event commitment, workflow completion, or approval.
- Do not claim a separate session is isolated by default.
- Do not implement parallel writer paths for one canonical workspace.
- Do not add Foreman-like durable activation, scheduling, retry, recovery, or audit guarantees to Ensemble.
- Do not remove existing command, agent, or skill formats during the first migration.
- Do not auto-apply source or constitution changes in the monitored-test pilot.

## 16. Related design and research references

### Repository documents

- [Ensemble behavior runtime and Pi/OMP harness plan](./ensemble-behavior-runtime-plan.md)
- [Ensemble Behavior Runtime: CQRS and Declarative Workflow Requirements](./ensemble-behavior-cqrs-implementation-requirements.md)
- [Behavior runtime contract v1](./behavior-runtime-contract-v1.md)
- [Foreman Behavior Control Plane](./foreman-behavior-control-plane-plan.md)

This document specializes the trigger-adapter, dispatcher, session, and communication design. It preserves the CQRS and Foreman boundary above. Where older plans disagree about whether triggers are embedded in Ensemble or supplied through adapters, implement the stable Ensemble event/behavior contracts with optional source adapters; do not make a host-specific hook package the dispatcher.

### External projects and host documentation reviewed

- [Pi extensions documentation](https://pi.dev/docs/latest/extensions)
- [OMP hooks documentation](https://omp.sh/docs/hooks)
- [`pi-yaml-hooks` package](https://pi.dev/packages/pi-yaml-hooks)
- [`pi-intercom`](https://github.com/nicobailon/pi-intercom)
- [Agent Intercom Pi](https://github.com/dataforxyz/agent-intercom-pi)
- [`pi-background-tasks`](https://github.com/ismailsaleekh/pi-background-tasks)

These projects are inputs to adapter evaluation, not endorsed dependencies. Recheck the exact release, source, license, API behavior, and host compatibility during Sprint 0 before adding a dependency or making a product-support claim.
