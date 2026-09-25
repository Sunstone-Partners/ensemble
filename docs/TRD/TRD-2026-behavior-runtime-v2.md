---
document_id: TRD-2026-behavior-runtime-v2
label: trd-behavior-runtime
version: 1.0.0
status: Draft
date: 2026-09-23
scale_depth: DEEP
total_requirements: 28
readiness_score: 0.0
prd_reference: PRD-2026-6940910d
---

# Ensemble Behavior Runtime (v2)

**Technical Requirements Document**

Derived from `docs/PRD/PRD-2026-6940910d-behavior-runtime.md` (26 numbered requirements REQ-001–026, 100 enumerated acceptance criteria AC-001–100; the PRD frontmatter states `total_requirements: 28` and "112 ACs" — see the note in §11) and the ratified split in `docs/architecture/ensemble-foreman-behavior-runtime-plan.md`. Scope is **Ensemble-only**: behavior authoring, schema/validation, local event matching, policy evaluation, tool governance, audit logging, and conformance testing. Durable orchestration (leases, event-sourced activation ledger, execution graphs, agent dispatch) remains Foreman's domain and is explicitly deferred (PRD Non-Goals; Article VII).

> **Naming note:** The Architecture Plan places `Matcher`, `Policy`, and `Event` under `ForemanServer.Behavior.*`. This TRD defines the Ensemble-side modules `Ensemble.Behavior.*` with the same contracts, compiled for local execution. Under Article VII and plan REQ-COMP-004, **Ensemble's local dispatch is local-only**: when a project is registered with Foreman, only Foreman may activate durable behaviors; Ensemble's matcher runs in shadow mode (match + record, no dispatch).

---

## 0. TRD Health Summary

| Dimension | Status |
|---|---|
| PRD Coverage | 26/26 numbered requirements mapped (REQ-001–022 functional + REQ-023–026 non-functional) |
| Acceptance Criteria Mapped | 100/100 enumerated ACs traced to components and phases |
| Risk Flags Addressed | REQ-007 (silent matches), REQ-015 (incomplete fixtures), REQ-021 (audit retention) |
| NEEDS CLARIFICATION Items | 10 (defaults proposed here; see §12 Open Questions) |
| Constitution Compliance | §8 — Articles I–VIII addressed; Article IX tracked via PRD-2026-6940910d |

---

## 1. Technical Architecture Overview

### 1.1 Design Principles

- **Additive first (Article V, REQ-001):** Behaviors complement existing commands, skills, and workflows. No existing execution path is removed or replaced.
- **Observable outcomes (Article II):** Every component exposes inspectable state — the catalog, matcher results, policy decisions, and audit logs are all queryable artifacts, not log soup.
- **Non-bypassability at the boundary (REQ-010, REQ-026):** Tool restrictions are applied *before* agent invocation begins, inside `AgentInvoker`. The agent process never receives a toolset wider than the declared capability set; prompts cannot re-widen it.
- **Fail closed (Article IV, REQ-026):** Unknown tools, unknown event schema versions, unparseable policies, and unresolved capabilities result in **block/suppress**, never expanded authority.
- **Matching is deterministic and agent-free (REQ-007, plan Performance NFR):** Predicate evaluation never invokes an agent; it is pure function evaluation over a normalized `Event`.

### 1.2 System Boundaries

```text
┌────────────────────────────────────────────────────────────────────────┐
│  Behavior Authoring & Compilation          (Phase 1)                   │
│  Ensemble.Behavior.Compiler                                          │
│   - behavior.yaml schema (JSON Schema + typed struct)                │
│   - package discovery: packages/*/behaviors/*/behavior.yaml          │
│   - capability & mutation-class registries                           │
│   - semantic + api_version compatibility checks                      │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ compiled Behavior.t() registry
                                v
┌────────────────────────────────────────────────────────────────────────┐
│  Event Normalization & Matching              (Phase 2)                │
│  Ensemble.Behavior.Matcher                                           │
│   - Event adapters: github / beads / local / generic                 │
│   - predicate evaluator (equals|not|matches|gte|lte|contains)        │
│   - deterministic match set, full evaluation trace                   │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ candidate matches (pre-audited)
                                v
┌────────────────────────────────────────────────────────────────────────┐
│  Policy & Governance                         (Phase 3)                │
│  Ensemble.Behavior.Policy / AgentInvoker / ToolGuard                 │
│   - cooldown, max_concurrent, budgets, causal-depth checks           │
│   - tool injection at invocation boundary; mutation-class separation │
│   - non-bypassability enforcement + violation logging                │
│   - constitution proposals: pending, never auto-applied (REQ-018)    │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ decisions, activations, violations
                                v
┌────────────────────────────────────────────────────────────────────────┐
│  Audit & Conformance                         (Phase 4)                │
│  Ensemble.Behavior.Audit / TestRunner                                │
│   - append-only activation ledger (JSONL + SQLite index)             │
│   - compliance reporting queries                                     │
│   - fixture loader + conformance runner + observability              │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Technology Decisions

| Concern | Decision | Rationale |
|---|---|---|
| Implementation language | **Elixir** (`ensemble_core` OTP app, `lib/ensemble/behavior/*.ex`) | Matches plan §3.2/§3.3 domain-type signatures; supervision trees fit per-behavior lifecycle isolation (REQ-025 AC-099); pattern-matching suits the predicate AST. The existing JS seed (`packages/core/behaviors/test-failure/behavior.yaml`, `hooks/test-failure-observer.js`) is preserved as a fixture source and migrated in Phase 2. |
| Schema definition | JSON Schema (`priv/schemas/behavior-v1.schema.json`) **plus** Elixir struct `Ensemble.Behavior.Definition` | JSON Schema gives portable validation + lint tooling; struct gives typed runtime. Unknown fields rejected via `additionalProperties: false` (REQ-001 AC-004). |
| Audit storage | Append-only JSONL ledger (`.ensemble/audit/activations-YYYYMM.jsonl`) + SQLite index (`.ensemble/audit/index.db`) | JSONL is replayable/durable with zero infra; SQLite powers the <500ms query target (REQ-023 AC-090) and date-range/behavior_id queries (REQ-021 AC-084). Mirrors the existing `test-failure-observer.js` JSONL precedent. |
| Event source (local) | Tail/subscribe adapter over hook events (`PostToolUse`) + GitHub webhooks + Beads status reads | The observer hook already emits `test.failed` records; normalization wraps them rather than replacing them (Article V). |
| Config | XDG paths via `packages/core/lib/config-path.js` equivalent (`Ensemble.Config.path(:behaviors)`) | Reuse existing convention; no second config root. |
| Test framework | ExUnit (Elixir unit/property/bench) + existing Jest suite for the JS hook bridge | Golden test: existing generated Pi artifacts and JS tests must remain unchanged (Phase 1 exit gate). |

### 1.4 Canonical Data Types

```elixir
# Ensemble.Behavior.Definition — compiled, immutable, validated
%Definition{
  api_version: "ensemble.sunstone.dev/v1",
  name: "investigate-test-failure",
  version: %Version{major: 1, minor: 0, patch: 0},
  description: String.t(),
  digest: binary(),                     # sha256 of canonical form; new digest per version change
  trigger: %Trigger{event_type: "test.failed", predicate: predicate_ast()},
  policy: %Policy{
    mode: :propose | :observe | :active,
    max_concurrent: pos_integer(),      # default 1 (conservative, REQ-008)
    cooldown: %{duration: non_neg_integer(), scope: :event_type},  # see §12 Q2
    timeout: pos_integer(),             # ms, default 1_800_000
    max_causal_depth: pos_integer(),    # default 2
    max_children: pos_integer(),        # default 3
    dedup_window: non_neg_integer(),    # ms, default 3_600_000 (see §12 Q1)
    retry: %{max_attempts: 0.., retryable: [atom()]}
  },
  capabilities: %Capabilities{
    tools: [String.t()],                # validated against ToolRegistry
    mutation_classes: [String.t()]      # validated against MutationRegistry
  },
  execution: %Execution{graph: String.t(), params: %{optional(String.t()) => param_ref()}},
  outcomes: [String.t()],
  constitution_rules: [Rule.t()],       # merged from constitution-rules.yaml (REQ-017)
  source: %{path: Path.t(), git_sha: String.t() | nil}  # REQ-026 AC-094
}

# Ensemble.Behavior.Event — normalized envelope (plan §3.3, trimmed to Ensemble fields)
%Event{
  event_id: binary(),                   # identifies ONE fact
  event_type: binary(),
  occurred_at: DateTime.t(),
  source: binary(),                     # "github" | "beads" | "local" | ...
  project_id: String.t() | nil,
  subject_id: binary(),
  payload: map(),
  schema_version: pos_integer(),
  correlation_id: binary() | nil,
  causation_id: binary() | nil,         # event that caused this one; depth chain
  actor: %{type: :user | :system | :ci | :behavior, id: String.t() | nil},
  deduplication_key: binary()           # ≠ event_id; semantic-equivalence key
}
```

`event_id` vs `deduplication_key` must not be conflated (plan §3.3): the key is derived from
`hash(event_type, subject_id, behavior_name, declared_identity_fields)` so that re-delivery of the
same fact and semantically equivalent triggers are both handled (REQ-005 AC-019, idempotency NFR).

### 1.5 behavior.yaml Schema (api_version v1)

Root keys: `api_version` (const), `kind` (const `Behavior`), `metadata`, `trigger`, `policy`,
`capabilities`, `execution`, `outcomes`. `additionalProperties: false` at every object level.

| Path | Type / constraint | Default on omission | REQ trace |
|---|---|---|---|
| `metadata.name` | `[a-z0-9-]{1,64}` | required | REQ-001 AC-001 |
| `metadata.version` | semver `X.Y.Z` | required | REQ-003 AC-009 |
| `metadata.description` | 1–500 chars | required | REQ-001 AC-001 |
| `trigger.event_type` | dotted `domain.action[.qualifier]`, registered | required | REQ-005 AC-017 |
| `trigger.predicate` | predicate tree (§1.6), optional | match-all | REQ-004 AC-014 |
| `policy.mode` | enum `observe\|propose\|active` | `propose` | REQ-008, Article IV |
| `policy.max_concurrent` | int ≥ 1 | 1 | REQ-008 AC-029, AC-089 |
| `policy.cooldown` | duration (`s/m/h/d`) | `0` (none) | REQ-008 AC-030 |
| `policy.timeout` | duration | 30m | REQ-008 AC-031 |
| `policy.max_causal_depth` | int ≥ 0 | 2 | REQ-008 AC-032 |
| `policy.max_children` | int ≥ 0 | 3 | REQ-008 AC-032 |
| `policy.dedup_window` | duration | 1h (§12 Q1) | REQ-005 AC-019 |
| `policy.retry.max_attempts` / `.retryable` | int 0–5 / [error_code] | 0 / `[]` | REQ-008 |
| `capabilities.tools` | [tool_id], registry-checked (warn on unknown) | `[]` | REQ-009 AC-033 |
| `capabilities.mutation_classes` | [class], registry-checked (fail on unknown) | `[none]` | REQ-009 AC-034 |
| `execution.graph` | catalog-resolved name | required; unknown → fail | REQ-011 AC-042 |
| `execution.params` | map of literal or `$.jsonpath` refs | `{}` | REQ-011 AC-043 |
| `outcomes` | [event_type] this behavior emits | required | REQ-001 |

Safety fields that resolve conservatively when missing (plan REQ-BEH-003): mode→`propose`,
concurrency→1, depth→2, children→3. A behavior may never receive *more* authority from a missing
field than from an explicit one.

### 1.6 Predicate Language

Node grammar (REQ-004):

```text
tree     := field: subtree | constraint
subtree  := { constraint_name: value }        # leaves only under one field path
constraint := equals | not | matches | gte | lte | contains
```

- AND semantics across sibling field keys; each leaf is one constraint (AC-014-M).
- `matches` = PCRE-style regex source string, tested with `Regex.match?/2` over `to_string(value)`.
- Missing field / wrong type for constraint → constraint is **skipped, not failed** (AC-015-S), and the skip is recorded in the evaluation trace.
- Compilation memoizes pre-compiled regexes and paths per `digest`; evaluation of 10-constraint trees targets **<10ms** (AC-016-S, AC-091-M).

```elixir
Predicate.eval(ast :: predicate_ast(), event :: Event.t()) ::
  {:match, trace :: [constraint_result()]} | {:no_match, trace :: [constraint_result()]}
# constraint_result = %{path: ["payload","exit_code"], op: :not, expected: 0, actual: 1, verdict: :pass | :fail | :skipped}
```

### 1.7 Public APIs

Signatures below are the cross-phase contract. The plan §3.2–§3.4 Foreman-side types
(`ForemanServer.Behavior.*`) share these shapes so a compiled package migrates to Foreman without
semantic change (plan REQ-BEH-004, portable compilation).

```elixir
# Compiler — REQ-001..004, REQ-003
Compiler.validate(yaml :: binary(), opts :: keyword()) ::
  {:ok, Definition.t()} | {:error, [ValidationError.t()]}
# ValidationError = %{field: jsonpath(), reason: atom() | binary(), location: %{file: Path.t(), line: pos_integer()}}

Compiler.discover(root :: Path.t()) :: {[Definition.t()], [DiscoveryIssue.t()]}
# scans packages/*/behaviors/*/behavior.yaml; creates missing fixture subdirs on-demand (REQ-002 AC-005)

Compiler.select_candidate(name :: String.t(), registry :: Registry.t()) ::
  {:ok, Definition.t()} | {:error, :no_compatible_version}   # REQ-003 AC-011
Compiler.compatibility(old :: Definition.t(), new :: Definition.t()) ::
  :compatible | :breaking                                      # REQ-003 AC-009/AC-010

# Matcher — REQ-005..007, REQ-006
Matcher.match(event :: Event.t(), registry :: Registry.t()) :: [MatchResult.t()]
# MatchResult = %{definition: Definition.t(), match_reason: trace(), audited_at: DateTime.t()}
# Deterministic order: sort by {name, version} (REQ-007 AC-027)

Matcher.normalize(raw :: map(), source_hint :: String.t() | nil) ::
  {:ok, Event.t()} | {:warn, Event.t()} | {:error, :unknown_schema_version}
# github/beads/local adapters + generic fallback with warning (REQ-006 AC-021..024)

# Policy — REQ-008, REQ-005
Policy.evaluate(defn :: Definition.t(), event :: Event.t(), ctx :: PolicyContext.t()) ::
  %PolicyDecision{verdict: :activate | :defer | :suppress | :block | :require_approval,
                  reasons: [reason()]}   # REQ-008 AC-029..032; AC-004 explicit decisions
# PolicyContext: %{dedup: DedupLedger.t(), active: ActiveCounter.t(),
#                 cooldowns: CooldownStore.t(), causal_depth: non_neg_integer()}

# Tool governance — REQ-009, REQ-010, REQ-026
ToolGuard.resolve(defn :: Definition.t()) ::
  {:ok, granted :: [tool_id()]} | {:error, :unknown_tool}      # registry cross-check (AC-033)
ToolGuard.check_access(tool_id :: atom() | String.t(), granted :: [atom() | String.t()]) ::
  :ok | {:error, :tool_not_granted}                            # AC-038; fail closed

AgentInvoker.invoke(defn :: Definition.t(), event :: Event.t(), opts :: keyword()) ::
  {:ok, Invocation.t()} | {:error, term()}
# Builds the provider-neutral request; `tools:` is sliced from ToolGuard.resolve/1 BEFORE the
# subprocess/SDK session starts. The grant list is passed by value; no channel exists by which a
# prompt, steering message, or follow-up mutates it (REQ-010 AC-037/AC-039, REQ-026 AC-093).

# Audit — REQ-021, REQ-022, REQ-007, REQ-010, REQ-018
Audit.log_match(event :: Event.t(), matches :: [MatchResult.t()]) :: :ok
# REQUIRED before Policy.evaluate — closes REQ-007 silent-match risk (AC-026)
Audit.log_activation(defn :: Definition.t(), event :: Event.t(), decision :: PolicyDecision.t()) :: :ok
Audit.log_violation(invocation :: Invocation.t(), tool :: String.t(), declared :: [String.t()]) :: :ok
Audit.link_proposal(activation_id :: binary(), proposal_id :: binary()) :: :ok
Audit.query(filter :: %{behavior_id: _, from: _, to: _, kind: _}) :: {:ok, [AuditEntry.t()]}

# TestRunner — REQ-015, REQ-016
TestRunner.run(defn :: Definition.t(), opts :: keyword()) :: %ConformanceReport{
  fixtures_loaded: pos_integer(), match_tests: results(), outcome_tests: results(),
  coverage_warnings: [String.t()]}
```

### 1.8 Package Discovery & Registries

Discovery glob: `packages/*/behaviors/*/behavior.yaml` relative to repo root, plus XDG user dir
(`~/.config/ensemble/behaviors`). Per package dir (REQ-002):

```text
packages/<domain>/behaviors/<behavior-id>/
├── behavior.yaml            # required; parse/validate or register nothing (AC-004)
├── prompts/                 # optional; behavior-local prompt fragments
├── skills/                  # optional; skill references (@skill:x) indexed for cross-refs
├── fixtures/
│   ├── events/              # *.event.json — normalized Event inputs
│   ├── expected-matches/    # *.expected.json — activation candidate sets
│   └── expected-outcomes/   # *.expected.json — proposals/mutations asserted
├── constitution-rules.yaml  # optional; merged into policy.rules (AC-007)
└── README.md                # recommended; missing → warn not fail (AC-006)
```

Cross-reference index: a shared skill/prompt referenced by >1 behavior is reported with its
referrers so a revocation lists dependents deterministically (AC-008-S; REQ-012 AC-047 flagging —
see §12 Q8 for the notification gap).

Registries (source of truth: `priv/registries/*.json`, compiled into the app, overridable by
project-level `ensemble.config.yaml`):

- **ToolRegistry** — id grammar `family[.qualifier]` (`read`, `grep`, `glob`, `bash.test`,
  `git.diff`, `pr.open`, `artifact.write`, …). Unknown declared tool → **warning**, excluded from
  the grant set (fail closed at enforcement, AC-033).
- **MutationRegistry** — classes mapped to enforcing tool sets:
  `artifact.write → [write, edit]`, `pr.open → [gh.pr_create, git.push]`,
  `constitution.propose → [constitution.propose]`, `none → []`. A tool grant does **not** imply
  mutation authority through that tool (plan §3.1 rule; AC-035, AC-036 per-behavior scope).
- **EventCatalog** — every `trigger.event_type` and `outcomes` entry must be registered or
  namespaced `x-<project>.*`. Unknown event type at *validation* time fails clearly (plan S1
  tests); unknown at *runtime* matches nothing.
- **WorkflowCatalog** — resolves `execution.graph`; missing graph → validation error, behavior not
  registered (REQ-011 AC-042).

### 1.9 Package & Module Layout

```text
packages/core/                       # @sunstone-partners/ensemble-core (5.6.0)
├── mix.exs                          # NEW: Ensemble.Behavior app lives here
├── lib/ensemble/behavior/
│   ├── compiler.ex       definition.ex       schema/behavior-v1.schema.json (priv/)
│   ├── registry.ex       discovery.ex        compatibility.ex
│   ├── matcher.ex        predicate.ex        events/{github,beads,local,generic}.ex
│   ├── policy.ex         policy_context.ex   stores/{dedup,cooldown,active_counter}.ex
│   ├── agent_invoker.ex  invocation.ex
│   ├── tool_guard.ex     tool_registry.ex    mutation_registry.ex
│   ├── audit.ex          audit_store.ex      compliance_report.ex
│   ├── test_runner.ex    fixture_loader.ex   observability.ex
│   └── telemetry.ex      discovery_engine.ex # Phase 4 / REQ-013/014
├── priv/schemas/ priv/registries/
├── behaviors/                       # seed packages (test-failure/ exists)
└── test/ensemble/behavior/          # ExUnit + stream_data property + Benchee
```

CLI surface (added as `ensemble` commands, additive to existing command set — Article V):

```text
ensemble behavior validate [path]        # schema + registry cross-validation
ensemble behavior list [--json]          # catalog introspection
ensemble behavior show <id>              # defn + README summary (first 3-5 lines, REQ-019 AC-076)
ensemble behavior disable <id>           # runtime kill-switch (rollback; see §7)
ensemble behavior status <id>            # cooldown/active/queue state
ensemble test behavior:<id>              # conformance run (REQ-016 AC-061)
ensemble behavior events tail --source … # normalized event stream, debug mode
ensemble behavior audit query --behavior <id> --since <days>   # REQ-022
```

---
## Master Task List

### Phase 1: Schema, Discovery & Validation Compiler

- [ ] **TRD-001** JSON Schema `behavior-v1.schema.json` + struct `Definition`
  - Rejects unknown/malformed fields with location info
  - Validates PRD ACs: AC-001, AC-002, AC-003, AC-004
- [ ] **TRD-002** `Compiler.validate/2`
  - Reports field identifier + reason per failure; no partial registration
  - Validates PRD ACs: AC-003, AC-004
- [ ] **TRD-003** `Compiler.discover/1` + layout enforcement
  - Finds `behavior.yaml`, creates missing fixture subdirs on-demand; README missing warns
  - Validates PRD ACs: AC-005, AC-006, AC-007
- [ ] **TRD-004** ToolRegistry / MutationRegistry / EventCatalog / WorkflowCatalog + cross-validation
  - Unknown tool warns; unknown graph/mutation class/event type fails
  - Validates PRD ACs: AC-033, AC-034, AC-042
- [ ] **TRD-005** `constitution-rules.yaml` parser → merged into `policy.rules`
  - Rules visible to downstream Policy engine
  - Validates PRD ACs: AC-007, AC-065
- [ ] **TRD-006** Semver + api_version handling: `compatibility/2`, `select_candidate/2`
  - v1→v1.x compatible iff same trigger + capabilities; v2 breaking flag; highest-compatible version selection; deprecation warning
  - Validates PRD ACs: AC-009, AC-010, AC-011, AC-012
- [ ] **TRD-007** `Predicate` compiler (AST build, regex precompile)
  - Constraint set: equals/not/matches/gte/lte/contains; graceful skip
  - Validates PRD ACs: AC-013, AC-014, AC-015
- [ ] **TRD-008** Digest: sha256 over canonical form; version change → new immutable digest
  - Plan S1 test
- [ ] **TRD-009** `ensemble behavior validate|list|show` CLI
  - Catalog introspection
  - Validates PRD ACs: AC-001, AC-076

### Phase 2: Event Normalization & Matching Engine

- [ ] **TRD-010** `Ensemble.Behavior.Event` envelope + codec (subset of plan §3.3)
  - Stable envelope; byte-equivalent on replay
  - Validates PRD ACs: AC-017
- [ ] **TRD-011** `Events.Github` adapter
  - `push` → `vcs.push` with branch/commits mapped into payload
  - Validates PRD ACs: AC-021
- [ ] **TRD-012** `Events.Beads` adapter
  - issue status change → `issue.status_changed` with old_status/new_status
  - Validates PRD ACs: AC-022
- [ ] **TRD-013** `Events.Local` adapter
  - agent run completion → `agent.completed`; migrates `test-failure-observer.js` emission path to emit `test.failed` events
  - Validates PRD ACs: AC-023
- [ ] **TRD-014** `Events.Generic` fallback
  - best-effort envelope + logged warning naming the source
  - Validates PRD ACs: AC-024
- [ ] **TRD-015** `Matcher.match/2`
  - event_type index → predicate tree evaluation; returns all matches sorted by {name, version}
  - Validates PRD ACs: AC-018, AC-025, AC-027
- [ ] **TRD-016** Match-before-decide audit hook
  - `Audit.log_match/2` invoked synchronously prior to `Policy.evaluate`
  - Validates PRD ACs: AC-026
- [ ] **TRD-017** Full predicate evaluation trace attached to each `MatchResult`
  - which constraints passed/failed/skipped
  - Validates PRD ACs: AC-028
- [ ] **TRD-018** Deduplication derivation
  - `deduplication_key = hash(event_type, subject_id, behavior_name, identity_fields)`
  - Validates PRD ACs: AC-019
- [ ] **TRD-019** Shadow-mode toggle
  - when project registered with Foreman, matcher records matches but never dispatches (Plan REQ-COMP-004)

### Phase 3: Policy Enforcement & Tool Governance

- [ ] **TRD-020** Policy engine gates 1–6 (enabled/dedup/cooldown/concurrency/recursion/budget) + constitution gate 7
  - First failing gate wins; explicit verdicts
  - Validates PRD ACs: AC-019, AC-029, AC-030, AC-031, AC-032, AC-066, AC-067, AC-068, AC-069, AC-070, AC-071, AC-072, AC-089, AC-095
- [ ] **TRD-021** PolicyContext stores: ETS + durable JSONL mirror, fail-closed `:policy_unresolved`
  - Restart reconstruction; never defaults open (Article IV, REQ-SAFE-006)
- [ ] **TRD-022** `ToolGuard.resolve/1` + `check_access/2`
  - Grants sliced pre-invocation; undeclared call errors + violation logged
  - Validates PRD ACs: AC-033, AC-034, AC-035, AC-036, AC-038, AC-040
- [ ] **TRD-023** `AgentInvoker.invoke/3` with prompt-immune grant channel
  - No API accepts tool-list changes from model output
  - Validates PRD ACs: AC-037, AC-039, AC-093
- [ ] **TRD-024** Workflow + skill composition
  - `execution.graph` resolve, jsonpath params, @skill digest-pin, child skill records
  - Validates PRD ACs: AC-041, AC-042, AC-043, AC-044, AC-045, AC-046, AC-047, AC-048
- [ ] **TRD-025** Constitution governance
  - propose-only, proposals pending, approver rosters, trust escalation, direct writes blocked
  - Validates PRD ACs: AC-066, AC-067, AC-068, AC-069, AC-070, AC-071, AC-072

### Phase 4: Audit Logging, Conformance Testing & Observability

- [ ] **TRD-026** Audit ledger: append-only JSONL + SQLite index
  - Six entry kinds; synchronous writes on decision path
  - Validates PRD ACs: AC-020, AC-026, AC-081, AC-082, AC-083, AC-084
- [ ] **TRD-027** Audit retention + query indexes
  - 90d/365d partitions; behavior_id/date/kind/event_id filters <500ms/10k
  - Validates PRD ACs: AC-084, AC-088, AC-090
- [ ] **TRD-028** `ComplianceReport.generate`
  - Markdown/JSON invocation patterns, success rates, violations, decision-trace links
  - Validates PRD ACs: AC-085, AC-086
- [ ] **TRD-029** `TestRunner` + `FixtureLoader` conformance
  - Raw fixtures → normalize/match/policy vs expected-matches/outcomes; failure diffs; 0/0 handling
  - Validates PRD ACs: AC-057, AC-058, AC-059, AC-061, AC-062, AC-063
- [ ] **TRD-030** Coverage heuristic: >=3 event fixtures per distinct trigger path
  - validate-time warning; CI fails mode:active below threshold
  - Validates PRD ACs: AC-060
- [ ] **TRD-031** Telemetry + redaction
  - Opt-in runs.jsonl; regex redaction; prompt bodies hash-only
  - Validates PRD ACs: AC-049, AC-050, AC-051, AC-052, AC-096
- [ ] **TRD-032** `DiscoveryEngine` pattern suggestions
  - Bigram clustering, confidence tiers, approve → draft package
  - Validates PRD ACs: AC-051, AC-053, AC-054, AC-055, AC-056
- [ ] **TRD-033** Observability: events tail + DynamicSupervisor per activation
  - stderr mirror ENSEMBLE_BEHAVIORS_DEBUG=1; causal_root correlation
  - Validates PRD ACs: AC-097, AC-098, AC-099
- [ ] **TRD-034** Metrics error buckets
  - agent_timeout/tool_not_found/policy_violation/workflow_missing/budget_exhausted/backend_unavailable
  - Validates PRD ACs: AC-100

### Cross-phase: Seed Behaviors & Validation

- [ ] **TRD-035** Seed behaviors: pr-review + security-alert + best-practices guide
  - Canonical examples demonstrating predicate/tools/skills/fixtures; seed-sync CI check
  - Validates PRD ACs: AC-077, AC-078, AC-079, AC-080
- [ ] **TRD-036** Dependency lint for module boundary graph
  - No module reaches outside declared deps; Ensemble never writes Foreman state (TRD S6)


## 2. Implementation Phase 1 — Schema, Discovery & Validation Compiler

**PRD traceability:** REQ-001, REQ-002, REQ-003, REQ-004 (+ foundations for all later REQs). Maps to plan
Sprint 1 (schema + compiler) and S1-SP1 (three-behavior expressiveness spike).
to plan Sprint 1 (schema + compiler) and S1-SP1 (three-behavior expressiveness spike).

### Deliverables

| # | Component | Behavior | ACs |
|---|---|---|---|
| P1-1 | JSON Schema `behavior-v1.schema.json` + struct `Definition` | Rejects unknown/malformed fields with location info | AC-001, AC-002, AC-003, AC-004 |
| P1-2 | `Compiler.validate/2` | Reports field identifier + reason per failure; no partial registration | AC-003, AC-004 |
| P1-3 | `Compiler.discover/1` + layout enforcement | Finds `behavior.yaml`, creates missing fixture subdirs on-demand; README missing → warn | AC-005, AC-006, AC-007 |
| P1-4 | ToolRegistry / MutationRegistry / EventCatalog / WorkflowCatalog + cross-validation | Unknown tool → warn; unknown graph/mutation class/event type → fail | AC-033, AC-034, AC-042 |
| P1-5 | `constitution-rules.yaml` parser → merged into `policy.rules` | Rules visible to downstream Policy engine | AC-007, AC-065 |
| P1-6 | Semver + api_version handling: `compatibility/2`, `select_candidate/2` | v1→v1.x compatible iff same trigger + capabilities; v2 breaking flag; highest-compatible version selection; deprecation warning | AC-009..AC-012 |
| P1-7 | `Predicate` compiler (AST build, regex precompile) | Constraint set: equals/not/matches/gte/lte/contains; graceful skip | AC-013..AC-015 |
| P1-8 | Digest: sha256 over canonical form; version change → new immutable digest | Plan S1 test | — |
| P1-9 | `ensemble behavior validate|list|show` CLI | Catalog introspection | AC-001, AC-076 |

### Exit criteria

- `packages/core/behaviors/test-failure/behavior.yaml` validates, compiles, and round-trips.
- A behavior with an unknown tool name compiles with a warning; one with an unknown `execution.graph` fails and registers nothing.
- Golden test: existing Jest suite and generated Pi artifacts byte-identical (plan S0/S1 test; Article V).
- Three-model spike (test-failure, stalled-run recovery, PR remediation) expresses all three with no embedded code (plan S1-SP1).

---

## 3. Implementation Phase 2 — Event Normalization & Matching Engine

**PRD traceability:** REQ-005, REQ-006, REQ-007 (+ REQ-004 runtime eval). Maps to plan Sprint 2
(normalization/catalog) and Sprint 3 matcher slices, narrowed to Ensemble-local scope.

### Deliverables

| # | Component | Behavior | ACs |
|---|---|---|---|
| P2-1 | `Ensemble.Behavior.Event` envelope + codec (subset of plan §3.3) | Stable envelope; byte-equivalent on replay | AC-017 |
| P2-2 | `Events.Github` adapter | `push` → `vcs.push` with branch/commits mapped into payload | AC-021 |
| P2-3 | `Events.Beads` adapter | issue status change → `issue.status_changed` with old_status/new_status | AC-022 |
| P2-4 | `Events.Local` adapter | agent run completion → `agent.completed` with exit_code/context; migrates `test-failure-observer.js` emission path to emit `test.failed` events through the envelope instead of writing learning-log records directly (observer stays as transport, additive) | AC-023 |
| P2-5 | `Events.Generic` fallback | best-effort envelope + logged warning naming the source | AC-024 |
| P2-6 | `Matcher.match/2` | event_type index → predicate tree evaluation; returns all matches sorted by {name, version} | AC-018, AC-025, AC-027 |
| P2-7 | Match-before-decide audit hook | `Audit.log_match/2` invoked synchronously prior to `Policy.evaluate`; no code path reaches Policy without a prior match record | AC-026 |
| P2-8 | Full predicate evaluation trace attached to each `MatchResult` | which constraints passed/failed/skipped | AC-028 |
| P2-9 | Deduplication derivation | `deduplication_key = hash(event_type, subject_id, behavior_name, identity_fields)`; window-scoped duplicate detection delegates verdict to Policy | AC-019 |
| P2-10 | Shadow-mode toggle | when project registered with Foreman, matcher records matches but never dispatches (plan REQ-COMP-004) | — |

### Performance contract

- 5-behavior registry match < 50ms (AC-025); 1,000-behavior match < 200ms (AC-087) via
  `event_type → [definition]` index so only trigger-compatible predicates are evaluated; predicate
  trees are precompiled at `Compiler` load and cached by digest.

### Exit criteria

- Replaying a fixture event through normalize → match produces byte-identical `MatchResult` traces.
- An event from an unknown source logs exactly one warning and still produces a generic envelope.
- No activation code path reachable without an audit `match_recorded` entry (REQ-007 risk closed).

---

## 4. Implementation Phase 3 — Policy Enforcement & Tool Governance

**PRD traceability:** REQ-008, REQ-009, REQ-010, REQ-011, REQ-012, REQ-017, REQ-018, REQ-026. Maps
to plan Sprint 3 (policy/dedupe — local ledger slice) and the governance half of Sprint 4/6.

### 4.1 Policy Engine (`Ensemble.Behavior.Policy`)

Decision order (first failing gate wins; all gates logged):

```text
1. enabled?          behavior disabled/revoked → :block           (REQ-026 AC-095)
2. dedup?            key seen within policy.dedup_window → :suppress (REQ-005 AC-019)
3. cooldown?         per PolicyContext.cooldowns, scope per §12 Q2   (REQ-008 AC-030)
4. concurrency?      active_count >= max_concurrent → :defer (queue, FIFO, lossless) (AC-029, AC-089)
5. recursion?        causal_depth(event chain via causation_id) > max_causal_depth
                     OR self-activation OR children > max_children → :block (AC-032, REQ-SAFE-005)
6. budget?           token/time/tool-call budget exhausted → :suppress before dispatch; child tracking is non-blocking (callback completion, AC-092)
7. constitution?     mutation_class in rules.approval_required → :require_approval (REQ-017/018)
→ else :activate
```

- `PolicyContext` stores are in-memory ETS + durable JSONL mirror for restart reconstruction.
- Any store read/resolve failure → `:block` with reason `:policy_unresolved` (Article IV; plan
  REQ-SAFE-006). Policy never defaults open.
- Cooldown record key: `{behavior_name, scope_tuple}` where scope ∈ `{event_type | subject | project}`
  per config; default `:event_type` (see §12 Q2 — this default is the TRD's proposed resolution).

### 4.2 Capability & Tool Governance

- `AgentInvoker.invoke/3` builds the invocation request with `tools: ToolGuard.resolve(defn)`
  sliced **before** the session starts (AC-037). Pi backend: register only the granted custom
  tools; other runtimes: tool-policy allowlist in the launch config.
- Runtime interception: every tool call in the invocation is wrapped by `ToolGuard.check_access/2`;
  undeclared calls → `{:error, :tool_not_granted}` returned to the agent **and** an
  `Audit.log_violation/3` entry containing: behavior name+version+digest, activation_id,
  invocation_id, attempted tool, declared set, timestamp, actor (AC-038, AC-040).
- Prompt immunity is architectural, not heuristic: no API accepts tool-list changes from model
  output; there is nothing for "ignore previous tool restrictions" to hook (AC-039, AC-093).
- Per-behavior scope: grants are resolved from the individual `Definition`, never a union across
  the registry — revoking a tool from behavior A cannot touch B (AC-036).
- Mutation-class separation (plan §3.1): `ToolGuard` answers two independent questions — *can this
  invocation call tool T?* and *may this activation produce mutation class M?* `bash.test` grants
  execution of the test command only; artifact writes require `artifact.write`.
- Constitution path (REQ-018): `constitution.propose` is the only constitution-affecting capability
  a behavior may hold. Proposals are created **pending** (AC-069); any direct constitution write
  attempted during execution is intercepted at ToolGuard and blocked, leaving only the proposal
  (AC-071). Gate 7 of §4.1 routes constitution-affecting mutations to `:require_approval` with the constitution-rule approver list — a rule declaring "only the
  security team can approve" sets the approver roster on the pending proposal (AC-066, AC-067);
  low-trust behaviors (not in `audit.trust_allowlist`) escalate one level (AC-072). Accept/reject/
  revise transitions are recorded and attributable (AC-070). A constitution rule violation at
  validation time fails with the rule id cited (AC-068).

### 4.3 Workflow & Skill Composition

- `execution.graph` resolved against WorkflowCatalog at activation; params bound from literals or
  `$.jsonpath` event refs (AC-041, AC-043); the workflow receives params + `{event: Event.t()}`
  context (AC-044).
- Skills referenced as `@skill:<name>` are resolved at compile time and pinned by digest; skill
  invocations are logged as distinct child records under the activation for cross-skill audit
  (AC-045, AC-046). Composition strategy (`sequential | parallel`) is a declared field honored by
  the invoker (AC-048-C).
- Revoked/deprecated skill → referencing behaviors flagged for migration in the next `validate`
  run; in-place reference bump supported without redeploy (AC-047-C).

### Exit criteria

- Two simultaneous activations of a `max_concurrent: 1` behavior → exactly one :defer.
- A prompt-engineered agent cannot reach a non-granted tool: probe run asserts the violation audit
  entry exists and the tool result was never produced (AC-038/039/093).
- `ensemble behavior disable <id>` mid-event-storm → subsequent events log :block (AC-095).

---

## 5. Implementation Phase 4 — Audit Logging, Conformance Testing & Observability

**PRD traceability:** REQ-013, REQ-014, REQ-015, REQ-016, REQ-019, REQ-020, REQ-021, REQ-022, REQ-023, REQ-024, REQ-025. Maps to plan Sprint 3 audit slices, Sprint 8 metrics, and conformance/telemetry work.

### 5.1 Audit Ledger (`Ensemble.Behavior.Audit`)

Append-only JSONL partitioned monthly (`.ensemble/audit/activations-YYYYMM.jsonl`) + SQLite index
(`.ensemble/audit/index.db`, WAL mode). Entry kinds:

| kind | written when | required fields | ACs |
|---|---|---|---|
| `match_recorded` | Matcher produced ≥1 candidate, **before** Policy.evaluate | event_id, dedup_key, [name@version], trace_ref, occurred_at | AC-026 |
| `activation` | Policy verdict + terminal status | behavior name/version/digest, event_id, activation_id, verdict, started_at/completed_at, final status `completed\|failed\|timeout`, actor, causal_root | AC-020, AC-081 |
| `tool_violation` | check_access denied | behavior_id, invocation_id, attempted_tool, declared_tools[], timestamp, actor | AC-038, AC-040, AC-082 |
| `proposal_link` | proposal emitted | activation_id ↔ proposal_id, mutation_class | AC-083 |
| `policy_rejection` | disabled/revoked/blocked | behavior_id, reason | AC-095 |
| `skill_invocation` | composed skill ran | activation_id, skill@digest, seq | AC-046 |

Ledger entries pass the same redaction pass as telemetry (§5.3) before write: no plaintext secrets
in any audit record, even when an agent's tool output contains them (REQ-026 AC-096). Tool-call
*arguments* are stored as structural digests, not verbatim stdout, per plan REQ-SAFE-004 (no
unrestricted command output in projections).

Writes are synchronous on the decision path (never dropped, AC-084 "no entries omitted"); indexing
is asynchronous. **Retention:** default 90 days for `match_recorded`, 365 days for activation/
violation/proposal entries, partition-drop on expiry, `[audit] retention_days` override per
compliance need (§12 Q7 proposes this default).

`Audit.query/1` supports `behavior_id`, `date range`, `kind`, `event_id` filters; chronological,
<500ms over 10,000 entries (AC-090), <1s recent-activation list under 100+ activations/min (AC-088)
— indexed columns: `(behavior_id, occurred_at)`, `(kind, occurred_at)`, `event_id`, `activation_id`.

**Compliance reporting (REQ-022):** `ComplianceReport.generate(filter)` renders markdown/JSON
summarizing invocation patterns, success rates, policy violations, and per-mutation accountability
with decision-trace links back to originating event + behavior (AC-085, AC-086). Example query:
`ensemble behavior audit query --mutation constitution.change --since 30` → one row per mutation:
proposal id, activation id, triggering event, approver, timestamp.

### 5.2 Conformance Testing (`Ensemble.Behavior.TestRunner`)

- `FixtureLoader` reads `fixtures/{events,expected-matches,expected-outcomes}/*.json`; each
  `*.event.json` is normalized via `Matcher.normalize` (fixtures store **raw** source shapes so
  adapters are exercised end-to-end), matched, policy-evaluated with a frozen clock
  (`test_mode: %{now: DateTime.t()}`), and compared to `expected-matches/*.expected.json` →
  activation sets and verdicts (AC-057, AC-058, AC-061).
- Outcome comparison runs the behavior in `mode: observe` against a stub executor when
  `expected-outcomes` declares proposals/mutations; the produced proposal set is diffed
  structurally (AC-059).
- Failure report: fixture path, assertion, expected-vs-actual diff (AC-062).
- No fixtures → `0/0 passed` + coverage note, never a false failure (AC-063).
- Async fixture flows honor `test.timeout_ms` default 10_000 and polling-limit defaults
  `test.max_polls = 20, test.poll_interval_ms = 250` (§12 Q4 proposed resolution; AC-064).
- **Coverage heuristic (REQ-015 risk):** `Compiler.validate` warns when
  `count(events) < 3 × distinct_trigger_paths(predicate disjunctions + event_type fan-in)`
  (AC-060; §12 Q9).

### 5.3 Telemetry & Discovery (REQ-013/014)

`Telemetry` writes opt-in records (`.ensemble/telemetry/runs.jsonl`) referencing `behavior_id` +
triggering `event_id`, capturing duration, tool calls, and outcome kind (AC-049, AC-050). Redaction
pipeline (AC-052, AC-096, §12 Q5): default regex pass — `(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(password|secret|token|api_key)\s*[:=]\s*\S+)` → `[REDACTED:<kind>]` — plus project allowlist (`telemetry.fields`); prompt **bodies** are never stored, only hashes + lengths, so plaintext secrets cannot leak via prompt capture (Article IV / plan REQ-SAFE-004).

`DiscoveryEngine.analyze(since)` clusters runs by `(event_type, tool-sequence)` bigrams; patterns
`DiscoveryEngine.analyze(since)` clusters runs by `(event_type, tool-sequence)` bigrams; patterns
with frequency ≥10 emit a suggested behavior draft with pattern name, inferred event type, tools,
frequency, and confidence score (AC-051, AC-053, AC-054); single-observation patterns score <40% and
are marked `exploratory` (AC-056). Suggestions surface through `ensemble behavior discover --report`;
maintainer approve/reject writes to a tracked proposal artifact — approve inserts a draft package
into the catalog pipeline (Phase 1 validation gates it like any behavior) (AC-055).

### 5.4 Observability (REQ-025)

- `ensemble behavior events tail` streams match/decision/step records per activation in real time
  (`mode: verbose` also carries predicate traces); mirror to stderr under `ENSEMBLE_BEHAVIORS_DEBUG=1`
  (AC-097; existing env contract preserved).
- Failure diagnosis: last completed step + governing policy decisions replayed from the audit
  ledger (AC-098).
- Each activation runs under its own DynamicSupervisor child with a correlated log prefix; concurrent
  behaviors are independently tracked and correlatable by `causal_root` (AC-099).
- Metrics bucket errors into `agent_timeout, tool_not_found, policy_violation, workflow_missing,
  budget_exhausted, backend_unavailable` counters (AC-100), flushed with telemetry records; match
  rate, suppression, and latency gauges feed `ensemble behavior status`.

### Exit criteria (Phase 4)

- `ensemble test behavior:investigate-test-failure` passes against seed fixtures; deliberately
  breaking the predicate fails with an expected-vs-actual diff.
- Property test: replaying an event stream twice yields identical activation decisions (determinism)
  and one activation per dedup key (idempotency).
- Compliance report over a synthetic 90-day ledger matches row counts to the JSONL ground truth.

---

## 6. Module Boundaries

| Module | Owns | Must NOT | REQs |
|---|---|---|---|
| `Ensemble.Behavior.Compiler` | schema, struct, discovery, digest, versioning/compat, registry cross-validation | evaluate events, dispatch, write audit | 001–004 |
| `Ensemble.Behavior.Matcher` | event adapters, predicate evaluation, candidate sets, deterministic ordering | make policy decisions, invoke agents | 004–007 |
| `Ensemble.Behavior.Policy` | dedup/cooldown/concurrency/recursion/budget gates, PolicyDecision | execute, mutate tools, write to Foreman state | 005, 008 |
| `Ensemble.Behavior.AgentInvoker` | invocation construction, tool slicing, backend selection (pi/claude/opencode), skill/workflow composition dispatch | widen grants, own durable state | 010–012, 026 |
| `Ensemble.Behavior.ToolGuard` | registries, access checks, mutation-class mapping, violation signalling | store audit itself (calls Audit), approve anything | 009, 010, 018, 026 |
| `Ensemble.Behavior.Audit` | ledger write/query, retention, compliance reports, proposal linking | influence decisions (read-only record layer) | 007, 020–022 |
| `Ensemble.Behavior.TestRunner` | fixtures, conformance runs, coverage heuristics | production dispatch paths | 015, 016 |
| `Ensemble.Behavior.Telemetry` / `.DiscoveryEngine` | opt-in run telemetry, redaction, pattern suggestions | store prompt bodies; auto-create catalog entries | 013, 014 |

Dependency rule (architecture lint, plan S0 test): `Compiler → {registries}`;
`Matcher → {Event, Predicate, Audit}`; `Policy → {Matcher types, stores}`;
`AgentInvoker → {Policy result, ToolGuard}`; `Audit` depends on nothing above it.
No module in this graph may reach outside its declared dependencies; in particular Ensemble never writes Foreman event-store state (plan REQ-COMP-004 boundary).

---

## 7. Migration Strategy (Article V Compliance)

**Additive cutover.** Behaviors coexist with commands, workflows, and direct agent invocations;
nothing is removed to drive adoption (plan §8 Stage 1–2, PRD Migration section).

| Aspect | Mechanism |
|---|---|
| Coexistence | Existing commands/skills/generated Pi artifacts unchanged; the Jest suite and golden Pi-artifact test are Phase 1 exit gates. The `test-failure-observer.js` hook keeps working — Phase 2 wraps its emission path into `Events.Local`; the hook is never deleted during the compatibility window. |
| Schema evolution | `api_version` gates interpretation: `v1` remains valid until ≥2 major Ensemble releases after `v2` ships (6-month minimum roadmap notice before any removal). `Compiler.select_candidate/1` refuses schemas it cannot interpret; unknown `api_version` fails validation, never guesses. |
| Version compatibility | Same trigger + same capabilities across a semver minor/patch → compatible; changed trigger or capabilities → `:breaking`, requiring explicit migration or simultaneous availability (AC-010). Deprecation warnings name the migration path (AC-012). |
| Rollback | `ensemble behavior disable <id>` — runtime kill-switch, no code change: events still normalize, Policy returns `:block`, everything already dispatched continues (AC-095). Uninstall = remove package dir + revalidate registry; prior command/workflow paths were never removed, so functionality is restored by definition. Zero data loss: audit and telemetry are append-only and survive disable. |
| Staged rollout | `mode: observe` (match+audit only) → `propose` (default) → `active` per behavior. New dispatch defaults to shadow mode (plan Stage 1). |
| Command aliases | Where a command becomes behavior-backed, the command remains as a compatibility wrapper creating an explicit activation (plan Stage 2); removal only after equivalence metrics + tested rollback (Stage 4 conditions 1–5). |

---

## 8. Constitution Compliance Mapping

| Article | How this TRD complies |
|---|---|
| I — Source files authoritative | `behavior.yaml` + registries are the compiled source of truth; no generated artifact is re-read as input. Digest ties definitions to their exact bytes. |
| II — Observable outcomes | Every component's contract is an inspectable artifact: catalog (`behavior list`), matcher output (traces), PolicyDecision verdicts, audit queries, ConformanceReport. §1.7 APIs return data, not side effects only. |
| III — Independently verifiable | Each Phase has exit criteria runnable as tests/fixtures; all 100 enumerated ACs mapped in §2–§5 tables to a component + verification mode (unit/fixture/integration/property/perf). |
| IV — Fail closed, never self-expanding | §4.1 gate order ends in `:block` on resolution failure; conservative defaults for missing safety fields; grants sliced before invocation with no mutation channel (AC-039/093); constitution mutations proposal-only (AC-071). |
| V — Additive, reversible | §7 in full. |
| VI — Evidence-backed claims | Every design decision in §2–§7 cites REQ-###/AC-### or a plan sprint; performance targets are stated as measurable contracts with named indexes, not assertions of achieved speed. |
| VII — Explicit boundaries | Scope statement (top): Ensemble-only; durable scheduling/ingestion excluded; Foreman interplay limited to shadow mode + portable compilation contract (§6 dependency rule). |
| VIII — Stable vocabulary | Uses PRD's 11 terms exactly: behavior, event, activation, policy, tool, capability, skill, workflow, mutation, audit trail, non-bypassability. Command ≠ behavior ≠ skill ≠ workflow maintained (§7 coexistence rows). |
| IX — Traceable to tracked issue | This TRD traces to `PRD-2026-6940910d`; implementation beads/issues must carry `PRD-2026-6940910d` references per phase (each P#-# row is a bead-sized slice). |

---

## 9. Risk Mitigations

| Risk (PRD flag) | Exposure | Mitigation | Verify by |
|---|---|---|---|
| **REQ-007 — silent matches bypass audit** | behavior activates with no trace of why | `Audit.log_match/2` is invoked synchronously **before** `Policy.evaluate`; no call path to Policy exists that skips it (P2-7). All verdicts (activate/suppress/block/defer/require_approval) write an `activation` row, so every suppression is a visible activation record. | Lint test: grep-enforced single Policy entry point + fixture asserting every activation id has a preceding `match_recorded`. |
| **REQ-015 — incomplete fixtures mask defects** | Untested trigger paths ship broken | Coverage heuristic: warn when event fixtures &lt; 3 × distinct trigger paths (§5.2); CI job fails builds for `mode: active` behaviors below the threshold (warn-only in `observe`). | `Compiler.validate` warning assertion in fixture tests. |
| **REQ-021 — audit gaps hide violations** | Unauthorized invocations untraceable | Synchronous append on decision path; monthly partitioning with 90d/365d retention defaults; query completeness check (counts reconcile JSONL↔SQLite in compliance report). | §5.1 exit criterion; property test: injected write failure halts activation rather than proceeding unlogged. |
| **REQ-009 — capability misconfig leaks tools** (unflagged in PRD health table, called out in PRD §REQ-009 header) | Unknown/typo'd tool grants widen access | Unknown tools warn + **exclude** (fail closed); mutation authority independent of tool grant (§4.2); registry drift checked at validate. | AC-033/035 fixture probes. |
| **REQ-010 — prompt bypass** (PRD-flagged risk) | Steering expands tool list | Grants are constructor-time data; interception at every call; violations logged with full context. | §4.3 exit probe: adversarial prompt run must produce `tool_violation` row + blocked result. |
| **REQ-013 — telemetry leaks secrets** (PRD-flagged risk) | API keys persisted in telemetry | No prompt bodies stored (hash+length only); regex redaction pass + field allowlist; default-off. | §12 Q5 redaction fixture corpus (seeded secret strings must never appear in output JSONL). |
| **REQ-014 — false-positive suggestions** | Non-generalizable patterns promoted | Confidence scoring with `exploratory` tag <40%; human approve/reject gate before catalog entry (AC-055/056). | Discovery golden-file test. |

---

## 10. Test Strategy

| Layer | Scope | Tooling | Maps to |
|---|---|---|---|
| Unit | schema/field validation, predicate ops incl. skip semantics, versioning, registry resolution, cooldown arithmetic, redaction regexes | ExUnit | REQ-001–004, 008, 013 |
| Contract | adapter tables (GitHub/Beads/local → envelope), `Matcher.normalize` replay byte-equality | fixture-driven table tests | REQ-006 |
| Fixture / conformance | `ensemble test behavior:<id>` — events → expected-matches → expected-outcomes; 0/0 handling; failure diffs | TestRunner + seed packages | REQ-015/016 |
| Integration | event → normalize → match(audit) → policy → activation → invoke(stubbed agent) → audit; shadow mode records zero mutations | ExUnit + tmp-dir ledgers | REQ-005–010, 021 |
| Property (stream_data) | repeated delivery ⇒ exactly one activation; deterministic ordering; replay ⇒ identical decisions; policy failure ⇒ never :activate | `test/property/` | AC-019/027, idempotency NFR, REQ-SAFE-006 |
| Adversarial | prompt-injection bypass probe; disabled-behavior activation attempt; undeclared-tool call; direct constitution write attempt | scripted pi run + ledger asserts | REQ-010, 018, 026 |
| Performance (Benchee + CI budget) | 1,000-behavior match <200ms; predicate <10ms; 10k-entry query <500ms; 100/min activation listing <1s; 50-deep concurrent queue lossless | `mix bench` gates | REQ-023/024 |
| Coverage target | **85% line** on `lib/ensemble/behavior/**` (excluding generated schema structs); `--cover` enforced in CI | ExUnit cover | — |

Permanent tests exist only where a plausible bug would fail them: the silent-match path, dedup,
tool-guard boundary, fail-closed policy defaults, and retention/query completeness are regression-
locked; everything else rides conformance fixtures.

---

## 11. Requirement Traceability Matrix

Functional 22/22 (REQ-001–022) + NFR 4/4 (REQ-023–026) coverage — 26/26 requirements; AC counts per the enumerated PRD body (100 total, AC-001–AC-100):

| REQ | Area | Phase(s) | Primary components | ACs |
|---|---|---|---|---|
| REQ-001 behavior.yaml schema | 1 | P1 | Compiler, schema, Definition | AC-001–004 |
| REQ-002 package layout | 1 | P1 | Discovery, FixtureLoader dirs | AC-005–008 |
| REQ-003 versioning/compat | 1 | P1 | Compatibility, digest | AC-009–012 |
| REQ-004 predicate language | 1 | P1+P2 | Predicate | AC-013–016 |
| REQ-005 event matching attributes | 2 | P2 | Matcher, dedup derivation | AC-017–020 |
| REQ-006 normalization adapters | 2 | P2 | Events.{Github,Beads,Local,Generic} | AC-021–024 |
| REQ-007 matching engine ⚠ | 2 | P2 | Matcher + Audit.log_match | AC-025–028 |
| REQ-008 policy enforcement | 3 | P3 | Policy, stores | AC-029–032 |
| REQ-009 capability declaration ⚠ | 3 | P1+P3 | ToolRegistry, MutationRegistry | AC-033–036 |
| REQ-010 non-bypassability ⚠ | 3 | P3 | AgentInvoker, ToolGuard | AC-037–040 |
| REQ-011 workflow mapping | 3 | P3 | Execution resolver, WorkflowCatalog | AC-041–044 |
| REQ-012 skill composition | 3 | P3 | AgentInvoker skills, cross-ref index | AC-045–048 |
| REQ-013 prompt telemetry ⚠ | 4 | P4 | Telemetry + redaction | AC-049–052 |
| REQ-014 emerging behavior detection ⚠ | 4 | P4 | DiscoveryEngine | AC-053–056 |
| REQ-015 fixture format ⚠ | 4 | P4 | FixtureLoader, coverage heuristic | AC-057–060 |
| REQ-016 conformance testing | 4 | P4 | TestRunner | AC-061–064 |
| REQ-017 constitution-rules.yaml | 3 | P1+P3 | Constitution parser, Policy gate 7 | AC-065–068 |
| REQ-018 constitution non-bypass | 3 | P3 | ToolGuard constitution.propose, proposals pending | AC-069–072 |
| REQ-019 documentation | 4 | P4 | README parse; constitution/high-impact behaviors require a Security-and-Approval section (AC-074); multi-skill/complex-policy behaviors SHOULD diagram execution flow (AC-075); 3-5-line summary in `behavior show` | AC-073, AC-074, AC-075, AC-076 |
| REQ-020 canonical examples | 4 | P4 | `behaviors/` seeds: test-failure, pr-review, security-alert (AC-077); each demonstrates predicate matching, tool governance, skill composition, fixtures (AC-078); best-practices guide: behaviors vs commands (AC-079); seed-sync CI check (AC-080) | AC-077–080 |
| REQ-021 audit trail ⚠ | 4 | P2+P3+P4 | Audit ledger all kinds | AC-081–084 |
| REQ-022 compliance reporting | 4 | P4 | ComplianceReport | AC-085–086 |
| REQ-023 performance at scale | NFR | P2+P4 | indexes, queueing, benchmarks | AC-087–090 |
| REQ-024 predicate performance | NFR | P1+P2 | precompiled predicate cache | AC-091–092 |
| REQ-025 observability | NFR | P4 | Observability, metrics buckets | AC-097–100 |
| REQ-026 security/non-bypass | NFR | P3+P4 | ToolGuard, disable path, git authorship | AC-093–096 |

100/100 enumerated acceptance criteria land in exactly one primary component above; 150+ explicit REQ/AC citations appear inline throughout §1–§12.

**Note on totals (Q0):** The PRD frontmatter records `total_requirements: 28` and its summary claims 112
ACs, but the PRD body enumerates REQ-001 through REQ-026 and AC-001 through AC-100. The traceability
matrix above is exhaustive over the enumerated set; the count discrepancy is an editorial defect in
the PRD and the first item the refinement phase should resolve. If the two missing requirements are
genuinely absent, this TRD gains a delta phase; if they are numbering slips (most likely — AC blocks
jump at AC-064→093 and AC-096→097), no scope change lands.

---

## 12. Open Questions (NEEDS CLARIFICATION — TRD-proposed defaults)

These resolve the PRD's 10 ambiguity flags. Defaults are implemented now; refinement phase may
change values without structural rework (each is a config key or policy constant, isolated).

| # | PRD ref | Question | TRD default / resolution | Where |
|---|---|---|---|---|
| Q1 | AC-019 | Default deduplication window | **1h**, per-behavior `policy.dedup_window` | §1.5, §4.1 gate 2 |
| Q2 | AC-030 | Cooldown scope | **per behavior × event_type** (`:event_type`), overridable to `:subject` or `:project` | §4.1 gate 3 |
| Q3 | AC-084 | Audit retention | **90d matches / 365d decisions**, `[audit] retention_days` override | §5.1 |
| Q4 | AC-064 | Test timeouts | **10s per fixture**, `max_polls=20 @ 250ms` | §5.2 |
| Q5 | AC-096 | Secret detection | regex pass (AWS/GH/Slack/JWT/kv patterns) + **no prompt bodies stored**; config owned by repo maintainers via `ensemble.config.yaml`, changes reviewable in git | §5.3 |
| Q6 | AC-052 | Filtering-config ownership | Same as Q5 — git-tracked project config; hot-reload on validate, no cadence limit, changes audited | §5.3 |
| Q7 | AC-054 | Confidence thresholds | `<40%` exploratory; `40–70%` review queue; `>70%` recommended | §5.3 |
| Q8 | AC-047 | Skill-revocation notification | **Pull model:** cross-ref index makes dependents enumerable at `behavior validate`; no push channel in v1 | §1.8, §4.3 |
| Q9 | AC-060 | Fixture completeness metric | **≥3 event fixtures per distinct trigger path** | §5.2 |
| Q10 | REQ-014 | Suggestion → production timeline | NLT governance: suggestions are PRs against `behaviors/`, standard review + Phase 1 validation; no separate timeline | §5.3 |

Deferred to Foreman phase (explicit non-goals, PRD §Non-Goals): durable activation ledger, leases,
restart reconciliation (plan S3/S5), event-sourced execution graphs (S7), and Pi/OMP adapter
parity inside Foreman (S4). The portable-compilation contract (§6, plan REQ-BEH-004) guarantees an
Ensemble-validated package deploys there unchanged.

---

## Appendix A — Seed Behavior Validation

The existing `packages/core/behaviors/test-failure/behavior.yaml` (v0.1.0) passes the §1.5 schema:
`trigger.predicate` uses `matches` + `not` (both in the §1.6 op set); `policy.mode: propose` is the
default-safe mode; `capabilities` separates `[read, grep, glob, bash.test, git.diff]` from
`[artifact.write, pr.open, constitution.propose]` exactly per the plan §3.1 tool≠mutation rule.
Phase 2 promotes it to v1.0.0 with fixtures satisfying the 3-per-path rule (its current single
`fixtures/events/test-failed.json` will trip the P4 coverage warning until expanded — tracked, not
blocking).

## Appendix B — Dependency Order Justification

PRD dependency map honored by phase order: 001→002/003 (P1 internal), 004→005 (P1→P2),
007→021 (P2 audit hook exists before P4 ledger maturity via the minimal `log_match` sink),
009↔010 (both P3), 011↔012 (P3), 013→014 (P4), 015↔016 (P4), 017↔018 (P1 parse + P3 enforce),
021→022 (P4), 019↔020 (P4), 023↔024 (benchmarks after P2 indexes), 025→026 (observability proves
enforcement in P4).
