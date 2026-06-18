---
document_id: TRD-2026-023
prd_reference: docs/PRD/PRD-2026-023-multi-trd-beads-workstream.md
version: 1.0.0
status: Draft
date: 2026-06-17
design_readiness_score: 4.75
architecture_option: C - Balanced brownfield extraction
---

# TRD-2026-023: Multi-TRD Beads Workstream

## Document Overview

This TRD translates `PRD-2026-023` into a brownfield implementation plan for extending `/ensemble:implement-trd-beads` with combined workstream mode. The implementation preserves current single-TRD behavior while enabling two or more TRDs to be scaffolded into one Beads release train with separate TRD epics, preserved PRD/TRD traceability, cross-TRD dependency edges, `bv --robot-*` validation, and stacked-PR-aware UX.

**MCP enhancement:** skipped (no MCP tools detected in current tool surface).

## Architecture Decision

### Selected Approach: Option C — Balanced Brownfield Extraction

Extend `packages/development/commands/implement-trd-beads.yaml` for command orchestration, while extracting complex deterministic logic into small Node helpers under `packages/development/lib/` and test coverage under `packages/development/tests/`.

### Alternatives Considered

| Option | Summary | Pros | Cons | Decision |
|--------|---------|------|------|----------|
| A: Inline extension | Put all multi-TRD logic directly in `implement-trd-beads.yaml` | Fastest, fewest files | Command becomes hard to test; dependency resolution brittle | Rejected |
| B: Full workflow module extraction | Move most command logic into reusable JS modules | Highest maintainability | Larger rewrite; higher regression risk for single-TRD flow | Rejected for MVP |
| C: Balanced brownfield | Keep command as orchestrator; extract validation, release train planning, cross-TRD dependency resolution, and status shaping | Good testability with limited surface-area change | Requires command/lib contract discipline | Selected |

### Rationale

The existing command already uses `trd-cli.js`, `trd-parser.js`, `scaffold-planner.js`, `phase-tracker.js`, and `pr-strategy.js` for deterministic parsing and planning. Combined workstream mode should follow that pattern: command prose handles tool calls and user prompts; pure JS helpers compute plans, validate inputs, and produce JSON instructions. This reduces fragile markdown/prose parsing and protects single-TRD behavior.

## System Architecture

```text
User input: /ensemble:implement-trd-beads <TRD_A> <TRD_B> ... [--plan|--execute|--status]
    |
    v
[Command argument router in implement-trd-beads.yaml]
    |-- one TRD path --> existing single-TRD flow unchanged
    |-- 2+ TRD paths --> combined workstream mode
    v
[Multi-TRD preflight]
    - file existence/readability
    - deterministic parse via trd-cli.js / trd-parser.js
    - readiness/staleness validation
    - stacked PR readiness check
    v
[workstream-planner.js]
    - release train title/slug
    - one TRD epic per source TRD
    - PR/story/task scaffold plan per TRD
    - source-qualified IDs and metadata
    v
[cross-trd-deps.js]
    - parse <trd-slug>#TRD-NNN and <trd-slug>#PR-N references
    - resolve to planned beads
    - detect ambiguity/conflicts
    v
[br mutation phase]
    - create/update release train bead
    - create/update TRD root epics
    - create/update stories/tasks
    - br dep add hierarchy and dependency edges
    - br sync --flush-only
    v
[bv validation]
    - bv --robot-plan / --robot-insights / --robot-alerts
    - report cycles/order issues
    - prompt user on conflicts
    v
[Status/execution]
    - combined banner and release train context
    - stacked PR strategy or fallback choice
    - existing task execution loop remains graph-driven
```

## Component Boundaries

| Component | Location | Responsibility |
|-----------|----------|----------------|
| Command orchestrator | `packages/development/commands/implement-trd-beads.yaml` | Argument routing, tool calls, prompts, br/bv invocation, no heavy parsing |
| TRD parser | `packages/development/lib/trd-parser.js` | Existing single-TRD parse contract; extended only if fields needed for source-qualified deps |
| TRD CLI | `packages/development/lib/trd-cli.js` | JSON CLI for command prose; add multi-TRD subcommands |
| Workstream planner | `packages/development/lib/workstream-planner.js` | Pure plan for release train, TRD epics, scaffold nodes, metadata |
| Cross-TRD dependency resolver | `packages/development/lib/cross-trd-deps.js` | Resolve source-qualified references; detect missing/ambiguous refs/conflicts |
| Combined status presenter | `packages/development/lib/workstream-status.js` | Shape release train/epic/task progress from br JSON for status output |
| Tests | `packages/development/tests/*workstream*.test.js` | Unit/integration coverage for planner, resolver, CLI, command contracts |

## Data Model

### Release Train Bead

Created with `br create --type=epic --priority=2` and title prefix:

```text
[release-train:<WORKSTREAM_SLUG>] <Release Train Title>
```

Required metadata is stored in the title and `br comment add` records because `br` has limited custom field support:

```text
workstream:combined source_trds:<csv> source_prds:<csv> child_epics:<csv> stacked_prs:<enabled|disabled> created:<iso8601>
```

### TRD Root Epic Bead

```text
[release-train:<WORKSTREAM_SLUG>:trd:<TRD_SLUG>] <TRD Title>
```

Metadata comment:

```text
source_trd:<path> source_prd:<path> trd_slug:<slug> workstream:<WORKSTREAM_SLUG>
```

### Story/Task Beads

Existing single-TRD title-prefix conventions remain, scoped by TRD slug:

```text
[trd:<TRD_SLUG>:pr:<N>] PR <N>: <title>
[trd:<TRD_SLUG>:task:<TRD-NNN>] <task description>
```

### Cross-TRD Dependency Reference Format

Supported explicit references:

```text
<trd-slug>#TRD-NNN
<trd-slug>#PR-N
```

Resolved edge metadata comment:

```text
cross_trd_dep source:<source-trd-path>#<source-id> target:<target-trd-path>#<target-id> source_bead:<id> target_bead:<id>
```

## Error Handling

- If any selected TRD fails preflight, stop before any `br create`, `br update`, `br dep add`, branch creation, or scaffold artifact.
- If a cross-TRD dependency is ambiguous, ask the user for a specific target before creating the edge.
- If the user declines conflict resolution, block affected scaffold/execution instead of guessing.
- If stacked PRs are unavailable, prompt: enable stacked PRs and continue, proceed single-branch per TRD, scaffold only/plan mode, or stop.
- Always call `br sync --flush-only` before `bv --robot-*` validation and after successful mutation batches.
- Never invoke bare `bv`; only `bv --robot-*` flags.

## Master Task List

### PR 1: Multi-TRD Input Routing and Preflight

**Shippable State:** Users can pass multiple TRD paths and receive a combined-mode preflight result without any Beads or branches being created.

- [ ] **TRD-001**: Add multi-path argument detection to `implement-trd-beads.yaml` while preserving one-path routing (2h) [satisfies REQ-001] [satisfies REQ-002]
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2
  - Target File: `packages/development/commands/implement-trd-beads.yaml`
  - Actions:
    1. Parse `$ARGUMENTS` for `.md` paths.
    2. Route exactly one TRD path to the existing flow unchanged.
    3. Route two or more TRD paths to `COMBINED_WORKSTREAM_MODE=true`.
    4. Print combined workstream mode banner and source TRD list.
  - Implementation AC:
    - Given one valid TRD path, when the command starts, then the existing single-TRD flow is selected.
    - Given two valid TRD paths, when the command starts, then combined workstream mode is selected and all source TRDs are listed.

- [ ] **TRD-001-TEST**: Add routing regression tests for one-path and multi-path invocation (1h) [verifies TRD-001] [satisfies REQ-001] [satisfies REQ-002] [depends: TRD-001]
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2
  - Target Files: `packages/development/tests/multi-trd-routing.test.js`
  - Test AC:
    - Given a one-path fixture invocation, when routing is evaluated, then existing single-TRD markers are preserved.
    - Given a two-path fixture invocation, when routing is evaluated, then combined mode and source TRD list are present.

- [ ] **TRD-002**: Add multi-TRD validation subcommand to `trd-cli.js` (3h) [satisfies REQ-004] [satisfies REQ-005]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-005-1, AC-005-2
  - Target Files: `packages/development/lib/trd-cli.js`, `packages/development/lib/workstream-planner.js`
  - Actions:
    1. Add `validate-workstream <trd-path...>` subcommand.
    2. Parse each TRD using existing `parseTRD`.
    3. Validate readability, PRD reference, Master Task List, PR sections, Shippable State lines, `design_readiness_score >= 4.0`, and non-blocked status.
    4. Return one JSON object with `ok`, `trds`, and `errors` arrays.
  - Implementation AC:
    - Given all TRDs are valid and ready, when validation runs, then JSON returns `ok:true` with one entry per TRD.
    - Given any TRD is missing readiness score or malformed, when validation runs, then JSON returns `ok:false` and every failure reason.

- [ ] **TRD-002-TEST**: Test all-or-nothing multi-TRD validation behavior (1.5h) [verifies TRD-002] [satisfies REQ-004] [satisfies REQ-005] [satisfies REQ-006] [depends: TRD-002]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-005-1, AC-005-2, AC-006-1, AC-006-2
  - Target Files: `packages/development/tests/workstream-validation.test.js`, `packages/development/tests/fixtures/`
  - Test AC:
    - Given one invalid TRD among valid TRDs, when validation runs, then the result reports all validation failures and no scaffold plan.
    - Given all TRDs pass validation, when validation runs, then all TRDs are marked eligible for one release train.

- [ ] **TRD-003**: Enforce no-side-effects preflight in command flow (1.5h) [satisfies REQ-004] [satisfies REQ-006]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-006-1, AC-006-2
  - Target File: `packages/development/commands/implement-trd-beads.yaml`
  - Actions:
    1. Run validation before git-town branch creation and before any `br` mutation.
    2. Print all failing TRDs and reasons before exit.
    3. Make scaffold phase unreachable when validation fails.
  - Implementation AC:
    - Given validation returns `ok:false`, when command flow continues, then no `br create`, `br dep add`, or branch command is reached.
    - Given validation returns `ok:true`, when command flow continues, then scaffold creation is allowed.

- [ ] **TRD-003-TEST**: Add command text guard tests for preflight ordering (1h) [verifies TRD-003] [satisfies REQ-004] [satisfies REQ-006] [depends: TRD-003]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-006-1, AC-006-2
  - Target Files: `packages/development/tests/multi-trd-command-contract.test.js`
  - Test AC:
    - Given generated command markdown, when order is inspected, then multi-TRD validation appears before Beads mutation instructions.
    - Given generated command markdown, when failure handling is inspected, then it hard-stops all work on any invalid TRD.

### PR 2: Release Train and Per-TRD Epic Scaffold

**Shippable State:** Users can scaffold a combined workstream into one release train with one root epic per TRD and preserved TRD-local hierarchy.

- [ ] **TRD-004**: Implement deterministic release train scaffold planning (3h) [satisfies REQ-007] [satisfies REQ-008]
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-008-1, AC-008-2
  - Target File: `packages/development/lib/workstream-planner.js`
  - Actions:
    1. Derive a workstream slug from user-provided name or common TRD slug prefix.
    2. Plan one release train bead with required metadata.
    3. Plan one TRD root epic per selected TRD.
    4. Return stable title prefixes for idempotency.
  - Implementation AC:
    - Given three parsed TRDs, when scaffold planning runs, then the plan contains one release train and exactly three TRD epic nodes.
    - Given the plan is serialized, when metadata is inspected, then source TRD paths, PRD refs, child epic placeholders, stacked PR status, and timestamp fields exist.

- [ ] **TRD-004-TEST**: Unit test release train planning and idempotency keys (1.5h) [verifies TRD-004] [satisfies REQ-007] [satisfies REQ-008] [depends: TRD-004]
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-008-1, AC-008-2
  - Target File: `packages/development/tests/workstream-planner.test.js`
  - Test AC:
    - Given repeated planning with the same TRD paths, when plan IDs are generated, then title prefixes are stable.
    - Given a TRD epic is planned, when its metadata is read, then source TRD path and PRD reference are present.

- [ ] **TRD-005**: Extend scaffold planner for TRD-local PR/story/task hierarchy under each TRD epic (3h) [satisfies REQ-009]
  - Validates PRD ACs: AC-009-1, AC-009-2
  - Target Files: `packages/development/lib/workstream-planner.js`, `packages/development/lib/scaffold-planner.js`
  - Actions:
    1. Reuse existing single-TRD scaffold plan per source TRD.
    2. Attach each TRD-local PR/story/task tree under that TRD root epic.
    3. Preserve source TRD task IDs and PR numbers in planned metadata comments.
  - Implementation AC:
    - Given a TRD with multiple `### PR N:` sections, when combined planning runs, then those sections remain under the same TRD epic.
    - Given a planned task node, when metadata is inspected, then source TRD path and source TRD task ID are present.

- [ ] **TRD-005-TEST**: Verify TRD-local hierarchy isolation across multiple TRDs (1.5h) [verifies TRD-005] [satisfies REQ-009] [depends: TRD-005]
  - Validates PRD ACs: AC-009-1, AC-009-2
  - Target File: `packages/development/tests/workstream-hierarchy.test.js`
  - Test AC:
    - Given two TRDs with `PR 1`, when planning runs, then each PR section belongs to its own TRD epic.
    - Given source tasks have the same `TRD-001` local ID in different TRDs, when planning runs, then task metadata remains unambiguous by TRD slug.

- [ ] **TRD-006**: Add command scaffold actions for release train and TRD epics via `br` (3h) [satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-009]
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-008-1, AC-008-2, AC-009-1, AC-009-2
  - Target File: `packages/development/commands/implement-trd-beads.yaml`
  - Actions:
    1. Use JSON scaffold plan to create or reuse release train bead.
    2. Create or reuse each TRD root epic.
    3. Add `br dep add <trd-epic> <release-train>` hierarchy edges.
    4. Create TRD-local story/task beads under each TRD epic.
    5. Add metadata comments after creation.
  - Implementation AC:
    - Given combined scaffold runs, when `br` mutations complete, then one release train and one epic per TRD exist.
    - Given status is requested, when release train metadata is read, then aggregate child epic IDs are available.

- [ ] **TRD-006-TEST**: Add dry-run/mocked `br` scaffold contract tests (2h) [verifies TRD-006] [satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-009] [depends: TRD-006]
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-008-1, AC-008-2, AC-009-1, AC-009-2
  - Target File: `packages/development/tests/workstream-br-scaffold.test.js`
  - Test AC:
    - Given a scaffold plan, when command actions are simulated, then release train creation precedes TRD epic creation.
    - Given TRD epics are created, when dependency commands are inspected, then each epic is attached to the release train.

### PR 3: Cross-TRD Dependency Resolution and Graph Validation

**Shippable State:** Users can scaffold source-qualified cross-TRD dependencies and receive `bv --robot-*` validation before execution proceeds.

- [ ] **TRD-007**: Implement cross-TRD dependency parser and resolver (4h) [satisfies REQ-010] [satisfies REQ-011]
  - Validates PRD ACs: AC-010-1, AC-010-2, AC-011-1, AC-011-2
  - Target File: `packages/development/lib/cross-trd-deps.js`
  - Actions:
    1. Parse `<trd-slug>#TRD-NNN` and `<trd-slug>#PR-N` references from explicit `[depends: ...]` annotations.
    2. Resolve references to planned task/story/PR beads.
    3. Return unresolved, ambiguous, and resolved dependency collections.
    4. Preserve existing Beads graph dependencies on resume unless user approves changes.
  - Implementation AC:
    - Given TRD A references `trd-b#TRD-003`, when resolution runs, then the target resolves to TRD B's planned task bead.
    - Given a reference matches multiple or zero targets, when resolution runs, then it is returned as ambiguous/unresolved and no edge command is generated.

- [ ] **TRD-007-TEST**: Unit test source-qualified dependency resolution cases (2h) [verifies TRD-007] [satisfies REQ-010] [satisfies REQ-011] [depends: TRD-007]
  - Validates PRD ACs: AC-010-1, AC-010-2, AC-011-1, AC-011-2
  - Target File: `packages/development/tests/cross-trd-deps.test.js`
  - Test AC:
    - Given valid task and PR references, when resolved, then the output contains source and target planned node IDs.
    - Given resume mode with existing edge metadata, when resolution runs, then existing edges are preserved unless changes are explicitly approved.

- [ ] **TRD-008**: Add user conflict prompts for ambiguous dependencies and release order conflicts (2h) [satisfies REQ-010] [satisfies REQ-013]
  - Validates PRD ACs: AC-010-2, AC-013-1, AC-013-2
  - Target File: `packages/development/commands/implement-trd-beads.yaml`
  - Actions:
    1. Detect resolver output with `ambiguous` or `conflict` entries.
    2. Ask user a specific resolution question before any affected edge is created.
    3. Block unresolved affected scaffold/execution rather than guessing.
  - Implementation AC:
    - Given a dependency has two possible targets, when command reaches dependency planning, then the user is asked to choose one.
    - Given the user declines to resolve, when scaffold would create the edge, then affected edge creation is skipped/blocked.

- [ ] **TRD-008-TEST**: Test conflict prompt text and blocked-edge behavior (1h) [verifies TRD-008] [satisfies REQ-010] [satisfies REQ-013] [depends: TRD-008]
  - Validates PRD ACs: AC-010-2, AC-013-1, AC-013-2
  - Target File: `packages/development/tests/workstream-conflicts.test.js`
  - Test AC:
    - Given generated command markdown, when conflict handling is inspected, then a user prompt is required before edge creation.
    - Given no user resolution is available, when conflict handling is inspected, then affected scaffold/execution is blocked.

- [ ] **TRD-009**: Apply cross-TRD dependency edges via `br dep add` with metadata comments (2h) [satisfies REQ-010] [satisfies REQ-011]
  - Validates PRD ACs: AC-010-1, AC-011-1, AC-011-2
  - Target File: `packages/development/commands/implement-trd-beads.yaml`
  - Actions:
    1. Convert resolved dependencies into ordered `br dep add <source> <target>` commands.
    2. Add `cross_trd_dep` metadata comments after edge creation.
    3. Skip existing equivalent edges on resume.
    4. Run `br sync --flush-only` after edge batch.
  - Implementation AC:
    - Given a resolved cross-TRD dependency, when scaffold completes, then Beads has a dependency edge with source and target context stored.
    - Given the same workstream is resumed, when existing edge metadata is found, then duplicate edge creation is skipped unless user approves change.

- [ ] **TRD-009-TEST**: Test generated `br dep add` command ordering and idempotency (1.5h) [verifies TRD-009] [satisfies REQ-010] [satisfies REQ-011] [depends: TRD-009]
  - Validates PRD ACs: AC-010-1, AC-011-1, AC-011-2
  - Target File: `packages/development/tests/workstream-dep-commands.test.js`
  - Test AC:
    - Given resolved dependency edges, when command plan is produced, then target beads exist before `br dep add` commands run.
    - Given an equivalent existing edge, when command plan is produced, then no duplicate `br dep add` command is emitted.

- [ ] **TRD-010**: Add `bv --robot-*` graph validation after scaffold (2h) [satisfies REQ-012] [satisfies REQ-013]
  - Validates PRD ACs: AC-012-1, AC-012-2, AC-013-1, AC-013-2
  - Target File: `packages/development/commands/implement-trd-beads.yaml`
  - Actions:
    1. Run `br sync --flush-only` before every `bv` call.
    2. Use `bv --robot-plan`, `bv --robot-insights`, or `bv --robot-alerts` only.
    3. Report cycles, unexpected blockers, and priority/order mismatches.
    4. Ask user how to proceed on graph issues.
  - Implementation AC:
    - Given `bv` is available, when graph validation runs, then only `--robot-*` commands are used.
    - Given `bv` reports a cycle, when validation completes, then the command reports it and asks the user for resolution.

- [ ] **TRD-010-TEST**: Add command guard test forbidding bare `bv` in combined validation (1h) [verifies TRD-010] [satisfies REQ-012] [depends: TRD-010]
  - Validates PRD ACs: AC-012-1, AC-012-2
  - Target File: `packages/development/tests/workstream-bv-contract.test.js`
  - Test AC:
    - Given generated command markdown, when `bv` invocations are scanned, then every invocation includes a `--robot-*` flag.
    - Given graph issue handling text is scanned, then cycles and order mismatches require user input.

### PR 4: Stacked PR UX, Alternatives, and Combined Status

**Shippable State:** Users see stacked-PR readiness, can choose fallback execution mode, and can inspect release train status with per-TRD blockers.

- [ ] **TRD-011**: Add stacked PR readiness preflight for combined workstreams (2h) [satisfies REQ-003] [satisfies REQ-014]
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-014-1, AC-014-2
  - Target File: `packages/development/commands/implement-trd-beads.yaml`
  - Actions:
    1. Read `ENSEMBLE_USE_STACKED_PRS` and git-town availability during combined preflight.
    2. Print `Combined workstream mode: stacked PRs enabled` when ready.
    3. Include release train name/ID and TRD epics in status and summary output.
  - Implementation AC:
    - Given stacked PRs are enabled and git-town is available, when combined preflight runs, then the stacked PR banner is printed.
    - Given combined status output is printed, then release train and all source TRD epics are shown.

- [ ] **TRD-011-TEST**: Test stacked PR banner and context output (1h) [verifies TRD-011] [satisfies REQ-003] [satisfies REQ-014] [depends: TRD-011]
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-014-1, AC-014-2
  - Target File: `packages/development/tests/workstream-stacked-prs.test.js`
  - Test AC:
    - Given stacked PR settings are enabled, when output is generated, then the required banner appears.
    - Given status output is generated, when inspected, then release train ID and source TRD epics are included.

- [ ] **TRD-012**: Implement fallback prompt when stacked PRs are not ready (1.5h) [satisfies REQ-014] [satisfies REQ-015]
  - Validates PRD ACs: AC-014-2, AC-015-1, AC-015-2
  - Target File: `packages/development/commands/implement-trd-beads.yaml`
  - Actions:
    1. Detect disabled stacked PR env or unsupported git-town state.
    2. Offer choices: enable stacked PRs and continue, proceed single-branch per TRD, scaffold only/plan mode, or stop.
    3. If scaffold-only is selected, skip implementation branch creation.
  - Implementation AC:
    - Given stacked PR mode is unavailable, when preflight runs, then the user sees all required fallback choices.
    - Given scaffold-only is selected, when command continues, then Beads are created/planned but implementation branches are not created.

- [ ] **TRD-012-TEST**: Test fallback choices and scaffold-only branch suppression (1h) [verifies TRD-012] [satisfies REQ-014] [satisfies REQ-015] [depends: TRD-012]
  - Validates PRD ACs: AC-014-2, AC-015-1, AC-015-2
  - Target File: `packages/development/tests/workstream-fallbacks.test.js`
  - Test AC:
    - Given stacked PRs are unavailable, when prompt text is inspected, then all four fallback choices are present.
    - Given scaffold-only mode is selected, when command plan is inspected, then branch creation is absent.

- [ ] **TRD-013**: Implement combined workstream status shaping (3h) [satisfies REQ-016]
  - Validates PRD ACs: AC-016-1, AC-016-2
  - Target File: `packages/development/lib/workstream-status.js`
  - Actions:
    1. Read `br list --status=open --json` and `br list --status=in_progress --json` outputs.
    2. Group progress by release train, TRD epic, blocked items, ready items, and parallel-safe streams.
    3. Include source and target TRD context for cross-TRD blockers.
    4. Return JSON suitable for command summary text.
  - Implementation AC:
    - Given a combined workstream exists, when status is shaped, then release train and each TRD epic have progress counts.
    - Given cross-TRD dependencies exist, when status is shaped, then blockers include both source and target TRD slugs.

- [ ] **TRD-013-TEST**: Unit test combined status grouping and blocker context (1.5h) [verifies TRD-013] [satisfies REQ-016] [depends: TRD-013]
  - Validates PRD ACs: AC-016-1, AC-016-2
  - Target File: `packages/development/tests/workstream-status.test.js`
  - Test AC:
    - Given br JSON fixture data, when status shaping runs, then each TRD epic has ready/blocked/progress counts.
    - Given a cross-TRD edge exists, when status shaping runs, then blocker output identifies both TRDs.

### PR 5: Generation, Documentation, and End-to-End Validation

**Shippable State:** Users can discover the documented multi-TRD workflow and generated command output passes validation with regression coverage.

- [ ] **TRD-014**: Update generated command docs and package references (1.5h) [satisfies REQ-002] [satisfies REQ-003] [depends: TRD-001, TRD-011]
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-003-1, AC-003-2
  - Target Files: `packages/development/README.md`, `packages/development/CHANGELOG.md`, generated `packages/development/commands/ensemble/implement-trd-beads.md`
  - Actions:
    1. Document multi-TRD invocation examples.
    2. Document combined workstream banner and release train status output.
    3. Run generator to update generated markdown from YAML.
  - Implementation AC:
    - Given users read docs, when they search for multi-TRD usage, then invocation examples are present.
    - Given generated command output is inspected, when multi-TRD mode is searched, then banner and mode behavior are documented.

- [ ] **TRD-014-TEST**: Validate generated markdown and package metadata (1h) [verifies TRD-014] [satisfies REQ-002] [satisfies REQ-003] [depends: TRD-014]
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-003-1, AC-003-2
  - Target File: `packages/development/tests/workstream-docs.test.js`
  - Test AC:
    - Given generated command markdown, when validated, then multi-TRD argument examples are present.
    - Given package docs are scanned, when searched, then combined workstream mode is documented.

- [ ] **TRD-015**: Add end-to-end fixture covering two TRDs with cross dependency (3h) [satisfies REQ-004] [satisfies REQ-007] [satisfies REQ-010] [satisfies REQ-012] [depends: TRD-006, TRD-009, TRD-010]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-007-1, AC-007-2, AC-010-1, AC-010-2, AC-012-1, AC-012-2
  - Target Files: `packages/development/tests/workstream-e2e.test.js`, `packages/development/tests/fixtures/workstream-*.md`
  - Actions:
    1. Create two ready TRD fixtures with PR sections and Shippable State lines.
    2. Add a valid `<trd-slug>#TRD-NNN` dependency.
    3. Validate parse, plan, dependency resolution, and `bv` command contract.
  - Implementation AC:
    - Given two fixture TRDs with one cross dependency, when E2E planning runs, then the plan includes release train, two epics, local tasks, and one cross edge.
    - Given graph validation is requested, when command contract is inspected, then `br sync --flush-only` precedes `bv --robot-*` validation.

- [ ] **TRD-015-TEST**: Run package validation and test suite for development package (1h) [verifies TRD-015] [satisfies REQ-001] [satisfies REQ-016] [depends: TRD-015]
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-016-1, AC-016-2
  - Target Files: `packages/development/package.json`, test output
  - Test AC:
    - Given all implementation tasks are complete, when `npm test --workspace @ensemble/development` runs, then tests pass.
    - Given command generation runs, when validation completes, then generated command markdown is in sync with YAML.

## Sprint Planning

## Sprint 1: Input Routing and Validation

- **PR 1 tasks:** TRD-001, TRD-001-TEST, TRD-002, TRD-002-TEST, TRD-003, TRD-003-TEST
- **Estimated effort:** 10h
- **Outcome:** Combined workstream mode can be selected and validated safely without side effects.

## Sprint 2: Scaffold Model

- **PR 2 tasks:** TRD-004, TRD-004-TEST, TRD-005, TRD-005-TEST, TRD-006, TRD-006-TEST
- **Estimated effort:** 14h
- **Outcome:** Release train and per-TRD epics can be planned and scaffolded.

## Sprint 3: Dependency Graph

- **PR 3 tasks:** TRD-007, TRD-007-TEST, TRD-008, TRD-008-TEST, TRD-009, TRD-009-TEST, TRD-010, TRD-010-TEST
- **Estimated effort:** 15.5h
- **Outcome:** Cross-TRD dependency edges and graph validation are available.

## Sprint 4: UX, Status, and Release Hardening

- **PR 4 tasks:** TRD-011, TRD-011-TEST, TRD-012, TRD-012-TEST, TRD-013, TRD-013-TEST
- **PR 5 tasks:** TRD-014, TRD-014-TEST, TRD-015, TRD-015-TEST
- **Estimated effort:** 15.5h
- **Outcome:** Users can operate, inspect, and validate the combined workstream end-to-end.

## Acceptance Criteria Traceability

| REQ | Description | Implementation Tasks | Test Tasks |
|-----|-------------|----------------------|------------|
| REQ-001 | Preserve single-TRD behavior | TRD-001 | TRD-001-TEST, TRD-015-TEST |
| REQ-002 | Multi-TRD mode trigger | TRD-001, TRD-014 | TRD-001-TEST, TRD-014-TEST |
| REQ-003 | Combined workstream UX banner | TRD-011, TRD-014 | TRD-011-TEST, TRD-014-TEST |
| REQ-004 | Validate all TRDs before side effects | TRD-002, TRD-003, TRD-015 | TRD-002-TEST, TRD-003-TEST, TRD-015-TEST |
| REQ-005 | Fast-fail on stale/unapproved TRD | TRD-002 | TRD-002-TEST |
| REQ-006 | No partial scaffold on preflight failure | TRD-003 | TRD-002-TEST, TRD-003-TEST |
| REQ-007 | Release train parent bead | TRD-004, TRD-006, TRD-015 | TRD-004-TEST, TRD-006-TEST, TRD-015-TEST |
| REQ-008 | One root epic per TRD | TRD-004, TRD-006 | TRD-004-TEST, TRD-006-TEST |
| REQ-009 | Preserve TRD-local structure | TRD-005, TRD-006 | TRD-005-TEST, TRD-006-TEST |
| REQ-010 | Cross-TRD dependency edges | TRD-007, TRD-008, TRD-009, TRD-015 | TRD-007-TEST, TRD-008-TEST, TRD-009-TEST, TRD-015-TEST |
| REQ-011 | Dependency source priority | TRD-007, TRD-009 | TRD-007-TEST, TRD-009-TEST |
| REQ-012 | Graph validation with bv robot output | TRD-010, TRD-015 | TRD-010-TEST, TRD-015-TEST |
| REQ-013 | Conflict resolution prompts | TRD-008, TRD-010 | TRD-008-TEST, TRD-010-TEST |
| REQ-014 | Stacked PR preflight | TRD-011, TRD-012 | TRD-011-TEST, TRD-012-TEST |
| REQ-015 | Alternatives when stacked PRs are not ready | TRD-012 | TRD-012-TEST |
| REQ-016 | Combined workstream status and reporting | TRD-013 | TRD-013-TEST, TRD-015-TEST |

Traceability check: 16 requirements covered, 0 uncovered, 0 orphaned annotations.

## Dependency Graph

```text
TRD-001 -> TRD-002 -> TRD-003
TRD-001 -> TRD-014
TRD-002 -> TRD-004
TRD-004 -> TRD-005 -> TRD-006
TRD-006 -> TRD-007 -> TRD-008 -> TRD-009 -> TRD-010
TRD-001 -> TRD-011 -> TRD-012
TRD-006 -> TRD-013
TRD-011 -> TRD-013
TRD-006 + TRD-009 + TRD-010 -> TRD-015
TRD-014 + TRD-015 -> release validation
```

Critical path: TRD-001 → TRD-002 → TRD-004 → TRD-005 → TRD-006 → TRD-007 → TRD-009 → TRD-010 → TRD-015.

No circular dependencies identified.

## Architecture Self-Critique

1. **Issue:** Release train metadata stored in comments may be harder to query than first-class Beads fields.
   - **Resolution:** Use stable title prefixes for idempotency and a single machine-readable metadata comment format; tests validate comment parsing.
2. **Issue:** Cross-TRD dependency references may collide when two TRD filenames slugify similarly.
   - **Resolution:** Planner validates unique TRD slugs before scaffold and fails preflight with clear remediation if duplicates exist.
3. **Issue:** Existing single-TRD command may regress if multi-path parsing changes common preflight.
   - **Resolution:** PR 1 includes explicit one-path regression tests and routes one-path flow before combined-mode logic.

## Task Coverage Review

- Every PRD REQ-001 through REQ-016 has at least one implementation task and at least one test task.
- No task references nonexistent PRD requirements.
- No task estimate exceeds 8h.
- Every PR section includes a user-observable Shippable State.
- PR boundaries are vertical and independently reviewable: preflight, scaffold, dependencies, UX/status, hardening.

## Dependency and Estimate Review

- Longest dependency chain depth is 8 tasks; acceptable because PR boundaries split reviewable units and no single task exceeds 4h.
- Dependency risk concentrates in PR 3 around cross-TRD resolution; mitigated by isolated `cross-trd-deps.js` tests.
- Similar command-contract tasks are estimated consistently at 1–2h; resolver/planner tasks are 3–4h due to ambiguity handling.

## Testability Review

- Implementation ACs are objective and include observable command output, JSON plan shape, generated command text, or test suite results.
- `bv` safety is testable via generated markdown scan: every invocation must include `--robot-*`.
- Side-effect ordering is testable by command text guard tests plus mocked command plan checks.

## Design Readiness Gate

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture completeness | 4.75 | Components, data model, interfaces, br/bv flows, and fallback paths are defined. |
| Task coverage | 4.75 | All 16 PRD requirements map to implementation and test tasks. |
| Dependency clarity | 4.75 | Task dependencies are explicit and acyclic; critical path is documented. |
| Estimate confidence | 4.75 | Estimates are granular; no task exceeds 4h; risk concentrated in resolver with tests. |
| **Overall** | **4.75** | **PASS — ready for implementation planning.** |

## File Inventory

| Path | Change |
|------|--------|
| `packages/development/commands/implement-trd-beads.yaml` | Modify: multi-TRD orchestration, prompts, scaffold actions, status output |
| `packages/development/commands/ensemble/implement-trd-beads.md` | Generated output after YAML update |
| `packages/development/lib/trd-cli.js` | Modify: add `validate-workstream` and/or related subcommands |
| `packages/development/lib/workstream-planner.js` | New: release train and per-TRD scaffold planning |
| `packages/development/lib/cross-trd-deps.js` | New: source-qualified dependency resolution |
| `packages/development/lib/workstream-status.js` | New: combined status shaping |
| `packages/development/tests/workstream-*.test.js` | New: unit/contract/E2E tests |
| `packages/development/tests/fixtures/workstream-*.md` | New: multi-TRD fixtures |
| `packages/development/README.md` | Modify: document usage |
| `packages/development/CHANGELOG.md` | Modify: record feature |

## Next Steps

1. Run `/ensemble:implement-trd-beads docs/TRD/TRD-2026-023-multi-trd-beads-workstream.md --plan` to scaffold Beads only.
2. Optionally run `/ensemble:configure-team docs/TRD/TRD-2026-023-multi-trd-beads-workstream.md` before execution.
3. Run `/ensemble:implement-trd-beads docs/TRD/TRD-2026-023-multi-trd-beads-workstream.md --execute` after review approval.
