---
document_id: TRD-2026-behavior-runtime
label: trd-behavior-runtime
version: 1.0.0
status: Draft
date: 2026-09-23
scale_depth: DEEP
total_requirements: 28
readiness_score: 0.0
prd_reference: PRD-2026-6940910d
---

# Ensemble Behavior Runtime

**Technical Requirements Document**

---

## TRD Health Summary

| Dimension | Status |
|---|---|
| PRD Coverage | 28/28 functional requirements mapped |
| Architecture phases | 4 implementation phases defined |
| Risk flags | REQ-007, REQ-015, REQ-021 (from PRD) |
| Constitution compliance | Pending validation |

---

## 1. Technical Architecture Overview

### Design Principles
- **Additive first:** Behaviors complement existing commands/workflows, not replace
- **Observable behavior:** All validation, matching, policy decisions produce inspectable outcomes
- **Non-bypassability:** Tool restrictions enforced at agent invocation boundary, cannot be expanded by prompts
- **Fail closed:** Unknown/invalid states default to block/suppress, never grant expanded authority

### System Boundaries
```
┌─────────────────────────────────────────────────────────────────┐
│ Behavior Authoring & Packaging (Ensemble)                       │
│  - behavior.yaml schema validation                              │
│  - package discovery & compilation                              │
│  - conformance test fixtures                                    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Behavior Matching & Policy (Local Execution)                    │
│  - event predicate evaluation                                   │
│  - policy enforcement (cooldown, concurrency, budgets)          │
│  - activation decisions                                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Agent Invocation & Tool Governance (Pi/OMP runtime)             │
│  - tool capability injection                                    │
│  - mutation authority checks                                    │
│  - execution isolation                                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Audit Trail & Observability                                     │
│  - invocation logging                                           │
│  - policy violation tracking                                    │
│  - compliance reporting                                         │
└─────────────────────────────────────────────────────────────────┘
```

**Scope Boundary:** This TRD covers **Ensemble-side behaviors** (schema, validation, matching, policy enforcement, audit logging). Foreman durable orchestration (event ingestion, activation ledger, execution graphs) deferred to separate TRD.

---

## 2. Implementation Phase 1: Schema Definition & Validation Compiler

**PRD Coverage:** REQ-001, REQ-002, REQ-003, REQ-004

### Technical Objectives
1. Define versioned `behavior.yaml` schema (JSON Schema or Elixir typed struct)
2. Implement package discovery and validation compiler
3. Enforce directory layout for behavior packages
4. Support semantic versioning and compatibility checks
5. Implement predicate language parser (constraint matching)

### Components

#### 2.1.1 Schema Definition
**File:** `packages/development/schemas/behavior.schema.json` (or `lib/ensemble/behavior/schema.ex`)

**Structure:**
```yaml
api_version: ensemble.sunstone.dev/v1  # schema version
kind: Behavior
metadata:
  name: string                          # unique behavior identifier
  version: semver                       # semantic version (1.0.0)
  description: string                   # human-readable summary

trigger:
  event_type: string                    # e.g. "test.failed"
  predicate: object                     # optional field-based constraints

policy:
  mode: enum(propose|execute|shadow)    # default: propose
  max_concurrent: positive_integer      # default: 1
  cooldown: duration                    # e.g. "24h", default: 0
  max_causal_depth: positive_integer    # default: 2
  max_children: non_negative_integer    # default: 0
  timeout: duration                     # e.g. "30m"
  retry:
    max_attempts: non_negative_integer  # default: 0
    retryable: array<string>            # failure codes

capabilities:
  tools: array<tool_id>                 # read, grep, bash.test, etc.
  mutation_classes: array<mutation_id>  # artifact.write, pr.open, constitution.propose

execution:
  graph: string                         # workflow reference (optional)

outcomes: array<event_type>             # expected emissions
```

**Validation Rules:**
- All fields typed and constrained
- Unknown fields rejected with location info
- `metadata.name` must be valid package identifier (kebab-case)
- `policy.cooldown` must parse as duration (h/m/s suffix)
- `capabilities.tools` must exist in tool registry (warning if unknown)

#### 2.1.2 Package Directory Layout
**Pattern:**
```
packages/<domain>/behaviors/<behavior-id>/
├── behavior.yaml                       # required
├── prompts/                            # optional
│   └── *.md
├── skills/                             # optional
│   └── <skill-name>.md
├── fixtures/                           # recommended
│   ├── events/
│   │   └── *.event.json
│   ├── expected-matches/
│   │   └── *.expected.json
│   └── expected-outcomes/
│       └── *.expected.json
├── constitution-rules.yaml             # optional (merged into policy)
└── README.md                           # recommended
```

**Discovery Algorithm:**
1. Scan `packages/*/behaviors/*/behavior.yaml`
2. Parse each as YAML → validate against schema
3. Build behavior registry with metadata (name, version, file path, digest)
4. Cross-reference skills/prompts/workflows for conflicts
5. Report warnings (missing README, incomplete fixtures) without failing

#### 2.1.3 Predicate Language Evaluator
**Grammar:**
```
predicate := { field_constraint* }
field_constraint := field_path : constraint
constraint := { equals: value } | { not: value } | { matches: regex } | { gte: number } | { lte: number } | { contains: value }
```

**Evaluation:**
- Flatten event payload to `{path: value}` pairs (e.g. `command` → `"npm test"`, `exit_code` → `1`)
- For each predicate constraint, extract field value from payload
- Apply constraint (regex match, inequality, membership)
- Return `true` if all constraints satisfied, `false` otherwise

**Performance Target:** <10ms for 10+ constraints (REQ-024)

#### 2.1.4 Public API
**Module:** `Ensemble.Behavior.Compiler`

```elixir
@spec validate_behavior!(binary) :: {:ok, Behavior.t()} | {:error, ValidationError.t()}
def validate_behavior!(yaml_content)

@spec discover_behaviors!(binary) :: [Behavior.t()]
def discover_behaviors!(root_path)

@spec compile_package!(Behavior.t()) :: {:ok, map()} | {:error, CompilationError.t()}
def compile_package!(behavior)

@spec evaluate_predicate(map, map) :: boolean
def evaluate_predicate(event_payload, predicate)
```

### Tests
- ✅ Valid behavior fixture compiles deterministically (REQ-001, AC-001-M)
- ✅ Unknown/malformed fields fail validation with field name/location (REQ-001, AC-004-M)
- ✅ Predicate constraints evaluate correctly for 5 constraint types (REQ-004, AC-013-M to AC-016-S)
- ✅ Version changes produce immutable digest (REQ-003, AC-009-M)
- ✅ Missing safety fields receive conservative defaults (REQ-001)

### Risk Mitigations
- **Schema evolution:** Use `api_version` field to detect forward/backward incompatibility
- **Performance regression:** Benchmark predicate evaluation on 100-behavior registry

---

## 3. Implementation Phase 2: Event Matching & Policy Engine

**PRD Coverage:** REQ-005, REQ-006, REQ-007, REQ-008

### Technical Objectives
1. Implement event normalization adapters (GitHub, Beads, local agents)
2. Build behavior matcher (event → candidate behaviors)
3. Enforce policy constraints (cooldown, concurrency, budgets)
4. Record activation decisions with full audit trail
5. Support policy outcomes: activate, suppress, block, require_approval

### Components

#### 3.2.1 Event Normalization
**Envelope Structure:**
```elixir
%{
  event_id: binary(),                   # unique identifier for this fact
  event_type: binary(),                 # e.g. "test.failed"
  occurred_at: DateTime.t(),
  source: binary(),                     # "github", "beads", "local_agent"
  project_id: binary() | nil,
  subject_id: binary(),                 # repository, issue ID, run ID
  payload: map(),                       # normalized fields for predicates
  schema_version: pos_integer(),
  correlation_id: binary() | nil,       # cross-behavior tracking
  causation_id: binary() | nil,         # parent event
  actor: %{type: atom(), id: binary() | nil},
  deduplication_key: binary()           # stable hash for semantically equivalent events
}
```

**Adapters:**
- `Ensemble.Behavior.EventNormalizer.GitHub` → webhook payloads
- `Ensemble.Behavior.EventNormalizer.Beads` → issue status changes
- `Ensemble.Behavior.EventNormalizer.LocalAgent` → run completion events

#### 3.2.2 Behavior Matcher
**Module:** `Ensemble.Behavior.Matcher`

```elixir
@spec match(Behavior.Event.t(), [Behavior.t()]) :: [{Behavior.t(), match_reason :: map()}]
def match(event, behavior_registry) do
  behavior_registry
  |> Enum.filter(fn b -> b.trigger.event_type == event.event_type end)
  |> Enum.map(fn b -> {b, evaluate_predicate(event.payload, b.trigger.predicate)} end)
  |> Enum.filter(fn {_, matched} -> matched end)
  |> Enum.sort_by(fn {b, _} -> {b.metadata.name, b.metadata.version} end)
end
```

**Output:** Deterministic sorted list of matched behaviors with predicate evaluation details.

#### 3.2.3 Policy Engine
**Module:** `Ensemble.Behavior.Policy`

**Checks:**
1. **Cooldown:** Query activation ledger for last activation of this behavior+subject within cooldown window → suppress if found
2. **Concurrency:** Count active executions for this behavior → defer if at max_concurrent
3. **Causal depth:** Trace parent chain → block if depth exceeds max_causal_depth
4. **Budget:** Sum tokens/time for current behavior tree → block if exhausted

**Decision Types:**
```elixir
%{
  action: :activate | :suppress | :block | :require_approval,
  reason: binary(),
  policy_field: atom(),
  cooldown_until: DateTime.t() | nil
}
```

#### 3.2.4 Activation Ledger
**Storage:** SQLite or Erlax term storage (local file)

**Schema:**
```sql
CREATE TABLE activations (
  activation_id TEXT PRIMARY KEY,
  behavior_name TEXT,
  behavior_version TEXT,
  event_id TEXT,
  subject_id TEXT,
  occurred_at DATETIME,
  activated_at DATETIME,
  decision TEXT,                -- activate|suppress|block|require_approval
  reason TEXT,
  causal_root_id TEXT,
  parent_activation_id TEXT,
  deduplication_key TEXT,
  UNIQUE(behavior_name, deduplication_key)
);

CREATE INDEX idx_cooldown ON activations(behavior_name, subject_id, activated_at);
```

### Tests
- ✅ 5 behaviors registry, match completes <50ms (REQ-007, AC-025-M)
- ✅ Repeated delivery never creates duplicate activation (REQ-005, AC-019-M)
- ✅ Cooldown enforced at behavior+subject scope (REQ-008, AC-030-M)
- ✅ Concurrent limit defers 51st activation when max_concurrent=50 (REQ-008, AC-089-M)
- ✅ Causal-depth limit prevents runaway chains (REQ-008, AC-032-S)
- ✅ Policy failure defaults to block/suppress, never expanded authority (REQ-008)

### Risk Mitigations
- **REQ-007 (silent matches):** Every match recorded in audit log **before** activation decision
- **Deduplication window:** Default 5 minutes, configurable per behavior (REQ-005 [NEEDS CLARIFICATION])

---

## 4. Implementation Phase 3: Tool Governance & Non-Bypassability

**PRD Coverage:** REQ-009, REQ-010, REQ-026

### Technical Objectives
1. Build capability registry (tool IDs → permissions, mutation classes)
2. Implement tool injection at agent invocation boundary
3. Intercept tool calls and enforce declared capabilities
4. Block undeclared tool access with audit trail
5. Ensure prompts cannot expand authority

### Components

#### 4.3.1 Capability Registry
**File:** `packages/development/behaviors/registry.yaml`

```yaml
tools:
  read:
    description: "Read file contents"
    mutation_class: null
    permissions: [file.read]
  grep:
    description: "Search file patterns"
    mutation_class: null
    permissions: [file.read]
  bash.test:
    description: "Execute test commands"
    mutation_class: null
    permissions: [shell.exec_test]
  artifact.write:
    description: "Write to artifacts directory"
    mutation_class: artifact.write
    permissions: [file.write_artifacts]
  pr.open:
    description: "Open pull request"
    mutation_class: pr.open
    permissions: [github.write_pr]

mutation_classes:
  artifact.write:
    authority: write
    scope: project.artifacts
  pr.open:
    authority: propose
    scope: repository.branches
  constitution.propose:
    authority: propose
    scope: constitution.rules
    requires_approval: true
```

#### 4.3.2 Tool Injection Boundary
**Module:** `Ensemble.Behavior.AgentInvoker`

```elixir
@spec invoke(Behavior.t(), Event.t(), map()) :: {:ok, AgentResult.t()} | {:error, term()}
def invoke(behavior, event, context) do
  tools = resolve_tool_grant(behavior.capabilities.tools)
  
  # Create isolated agent session with restricted tool list
  Pi.session(
    tools: tools,
    system_prompt: build_system_prompt(behavior, event),
    # Tool access list immutable after session start
  )
end
```

**Key Invariant:** Tool list set at session creation, **cannot be modified by prompts**.

#### 4.3.3 Tool Call Interceptor
**Module:** `Ensemble.Behavior.ToolGuard`

```elixir
@spec check_access(atom(), [atom()]) :: :ok | {:error, :tool_not_granted}
def check_access(tool_id, granted_tools) do
  if tool_id in granted_tools do
    :ok
  else
    # Log violation with full context
    audit_violation(tool_id, granted_tools)
    {:error, :tool_not_granted}
  end
end
```

**Interception Point:** Pi/OMP adapter hooks `tool_call` event, calls `ToolGuard.check_access()` before execution.

#### 4.3.4 Audit Logging
**Module:** `Ensemble.Behavior.Audit`

```elixir
@spec log_violation(Behavior.t(), atom(), [atom()]) :: :ok
def log_violation(behavior, attempted_tool, granted_tools) do
  event_store.append(%ToolViolation{
    behavior_id: behavior.metadata.name,
    behavior_version: behavior.metadata.version,
    attempted_tool: attempted_tool,
    granted_tools: granted_tools,
    timestamp: DateTime.utc_now(),
    invocation_context: inspect_current_context()
  })
end
```

### Tests
- ✅ Behavior with `tools: [read, grep]` cannot call `bash.write` (REQ-010, AC-038-M)
- ✅ Prompt "ignore previous tool restrictions" does not expand access (REQ-010, AC-039-M)
- ✅ Tool violation logged with behavior identity, attempted tool, declared restrictions, timestamp (REQ-010, AC-040-M)
- ✅ Disabled behavior invocation blocked and logged (REQ-026, AC-095-M)

### Risk Mitigations
- **REQ-010 (bypass risk):** Enforcement at **invocation boundary**, not agent self-policing
- **Capability leakage:** Scope tool grants per-behavior, not global

---

## 5. Implementation Phase 4: Audit Logging & Conformance Testing

**PRD Coverage:** REQ-015, REQ-016, REQ-021, REQ-022

### Technical Objectives
1. Implement comprehensive audit trail for all behavior invocations
2. Build conformance test runner (fixtures → validation)
3. Support compliance reporting from audit logs
4. Ensure audit logs queryable by behavior_id, date range, event type
5. Generate real-time execution observability logs

### Components

#### 5.4.1 Audit Trail Storage
**Module:** `Ensemble.Behavior.AuditStore`

**Events Logged:**
```elixir
%ActivationRecord{
  behavior_id: binary(),
  behavior_version: binary(),
  event_id: binary(),
  activation_timestamp: DateTime.t(),
  final_status: :completed | :failed | :timeout | :suppressed | :blocked,
  duration_ms: non_neg_integer(),
  policy_decisions: [%{field: atom(), outcome: atom(), reason: binary()}],
  tool_calls: [%{tool: atom(), timestamp: DateTime.t(), success: boolean()}],
  outcomes_emitted: [binary()]
}

%ProposalLinkRecord{
  proposal_id: binary(),
  proposal_type: :pr | :constitution | :artifact,
  activation_id: binary(),
  created_at: DateTime.t(),
  status: :pending | :approved | :rejected | :deferred
}

%ToolViolationRecord{
  behavior_id: binary(),
  attempted_tool: atom(),
  granted_tools: [atom()],
  timestamp: DateTime.t(),
  invocation_context: map()
}
```

**Storage:** Append-only JSONL file or SQLite with retention policy.

#### 5.4.2 Conformance Test Runner
**Command:** `ensemble test behavior:<id>`

**Module:** `Ensemble.Behavior.TestRunner`

```elixir
@spec run_conformance_tests(Behavior.t()) :: TestReport.t()
def run_conformance_tests(behavior) do
  behavior.fixtures
  |> Enum.flat_map(&load_event_fixtures/1)
  |> Enum.map(fn {fixture_name, event} ->
    matched = Behavior.Matcher.match(event, [behavior])
    outcome = simulate_execution(behavior, event)
    verify_against_expected(fixture_name, matched, outcome)
  end)
end
```

**Fixture Format:**
```json
{
  "event": {
    "event_type": "test.failed",
    "payload": { "command": "npm test", "exit_code": 1 }
  },
  "expected_matches": ["investigate-test-failure"],
  "expected_outcomes": ["test.failure.investigated"]
}
```

#### 5.4.3 Compliance Reporting
**Module:** `Ensemble.Behavior.Compliance`

```elixir
@spec generate_report(Date.t(), Date.t(), keyword()) :: Report.t()
def generate_report(start_date, end_date, opts) do
  query_audits(start_date, end_date, opts)
  |> Enum.group_by(& &1.behavior_id)
  |> Enum.map(fn {behavior_id, activations} ->
    %{
      behavior_id: behavior_id,
      total_invocations: length(activations),
      success_rate: success_rate(activations),
      violations: extract_violations(activations),
      constitution_mutation_proposals: count_proposals(activations, :constitution)
    }
  end)
end
```

**Report Types:**
- **Mutation Audit:** "All behaviors that mutated constitution in past 30 days"
- **Policy Violations:** "Tool access violations by behavior, last 7 days"
- **Success Rate:** "Completion status distribution per behavior"

#### 5.4.4 Real-time Observability
**Module:** `Ensemble.Behavior.Observability`

**Log Streams:**
- `behavior:<id>:predicate` — predicate evaluation results
- `behavior:<id>:activation` — activation decisions
- `behavior:<id>:execution` — step completions
- `behavior:<id>:outcome` — emitted outcomes

**Query API:**
```elixir
@spec tail_logs(behavior_id :: binary(), opts :: keyword()) :: Enumerable.t(LogEntry.t())
def tail_logs(behavior_id, opts \\ []) do
  # Stream from audit store, filter by behavior_id
end
```

### Tests
- ✅ Audit entry created for every activation (REQ-021, AC-081-M)
- ✅ Query by behavior_id returns results in chronological order (REQ-021, AC-084-M)
- ✅ Compliance report identifies each constitution mutation with accountability context (REQ-022, AC-085-S)
- ✅ Conformance test reports sufficient debug info on failure (REQ-016, AC-062-S)
- ✅ Behavior logs show real-time execution progress (REQ-025, AC-097-S)

### Risk Mitigations
- **REQ-021 (audit retention):** Default 90 days, configurable (REQ-021 [NEEDS CLARIFICATION])
- **REQ-015 (fixture completeness):** Warn if <3 event fixtures per behavior trigger path

---

## 6. Module Boundaries & Dependencies

```
Ensemble.Behavior.Compiler
  ├── Ensemble.Behavior.Schema (validation)
  ├── Ensemble.Behavior.Registry (capability lookup)
  └── Ensemble.Behavior.Discovery (package scanner)

Ensemble.Behavior.Matcher
  ├── Ensemble.Behavior.PredicateEvaluator
  ├── Ensemble.Behavior.EventNormalizer (adapters)
  └── Ensemble.Behavior.ActivationLedger (cooldown/concurrency queries)

Ensemble.Behavior.Policy
  ├── Ensemble.Behavior.ActivationLedger
  ├── Ensemble.Behavior.BudgetTracker
  └── Ensemble.Behavior.CausalChain

Ensemble.Behavior.AgentInvoker
  ├── Ensemble.Behavior.ToolGuard
  ├── Ensemble.Behavior.CapabilityResolver
  └── Pi.Session (external)

Ensemble.Behavior.Audit
  ├── Ensemble.Behavior.AuditStore
  └── Ensemble.EventStore (append-only)

Ensemble.Behavior.TestRunner
  ├── Ensemble.Behavior.Compiler
  ├── Ensemble.Behavior.Matcher
  ├── Ensemble.Behavior.Simulator
  └── ExUnit (external)

Ensemble.Behavior.Compliance
  └── Ensemble.Behavior.AuditStore (query interface)
```

**No Circular Dependencies:** Compiler → Matcher → Policy → AgentInvoker → Audit → Compliance

---

## 7. Test Strategy Summary

| Test Type | Coverage | Tools |
|---|---|---|
| **Unit** | Schema validation, predicate evaluation, policy checks | ExUnit |
| **Fixture** | Conformance tests (behavior + fixtures → expected outcomes) | `ensemble test behavior:<id>` |
| **Integration** | Event → match → policy → activation → audit (end-to-end) | Local simulator |
| **Property** | Repeated delivery → single activation (idempotency) | StreamData |
| **Performance** | 1000 behaviors, match <200ms; 10-constraint predicate <10ms | Benched |

**Coverage Target:** 85% line coverage for `Ensemble.Behavior.*` modules.

---

## 8. Migration & Compatibility (Article V Compliance)

**Additive Strategy:**
- Behavior packages **coexist** with existing commands/workflows
- No existing functionality removed or replaced
- Opt-in adoption; teams migrate at own pace

**Backward Compatibility:**
- `api_version` field in behavior.yaml gates schema evolution
- v1 behaviors remain valid until v2 sunset notice (minimum 2 major releases)
- Deprecation warnings logged when invoking old versions

**Rollback Procedure:**
- Disable behavior packages via `ensemble behavior disable <id>`
- Existing runs continue; no new activations created
- No data loss (audit logs retained independently)

---

## 9. Constitution Compliance Mapping

| Article | TRD Evidence |
|---|---|
| **I: Source Authoritative** | This TRD is implementation source for Behavior Runtime code |
| **II: Observable Behavior** | All components expose inspectable state (registry, matcher output, audit logs) |
| **III: Independently Verifiable** | Every module has unit + fixture tests; conformance runner validates end-to-end |
| **IV: Fails Closed** | Tool guard blocks undeclared access; policy engine suppresses on ambiguity |
| **V: Additive & Reversible** | Section 8 specifies opt-in migration, 2+ release compatibility, disable rollback |
| **VI: Claims Backed by Evidence** | Every design decision cites PRD REQ-### |
| **VII: Scope Boundaries** | Section 1 explicitly defers Foreman durable orchestration to separate TRD |
| **VIII: Vocabulary Stable** | Uses PRD vocabulary consistently (behavior, event, activation, policy, tool, capability) |
| **IX: Traceable to Issue** | Each phase maps to Beads epic (to be created during `implement-trd-beads`) |

---

## 10. Open Questions (from PRD NEEDS CLARIFICATION)

1. **Deduplication window** (REQ-005): Default 5 minutes? Configurable per behavior?
2. **Cooldown scope** (REQ-008): Per behavior+subject, per behavior+event_type, or global?
3. **Audit retention** (REQ-021): Default 90 days? Compliance requirements mandate longer?
4. **Secret detection** (REQ-026): Regex patterns? Entropy-based? Manual allowlist?
5. **Test timeout defaults** (REQ-016): Per-behavior override or global limit?

**Resolution:** Address via `/ensemble:refine-prd` or document conservative defaults in this TRD.

---

## Implementation Readiness Checklist

- [ ] Schema validation implemented and tested
- [ ] Package discovery compiles deterministic registries
- [ ] Event normalization adapters cover 3+ sources
- [ ] Matcher + policy engine enforces cooldown/concurrency
- [ ] Tool guard blocks undeclared access at invocation boundary
- [ ] Audit trail logs all activations + violations
- [ ] Conformance test runner validates fixture scenarios
- [ ] Compliance reporting queries audit store
- [ ] Migration guide documents opt-in strategy
- [ ] All PRD ACs have corresponding implementation + test

---

**Document Status:** Draft  
**Next Step:** `/ensemble:refine-trd` — validate against Constitution, resolve open questions  
**Target Readiness:** >4.0 before `implement-trd-beads` dispatch
