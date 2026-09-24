---
document_id: TRD-2026-15aa5acd
label: trd-live-behavior-dispatch-autofix
kind: trd
prd_reference: PRD-2026-15aa5acd
prd_path: docs/PRD/PRD-2026-15aa5acd-live-behavior-dispatch-autofix.md
version: 1.0.0
status: Draft
date: 2026-09-24
design_readiness_score: 4.25
---

# TRD-2026-15aa5acd: Live Behavior Dispatch and Bounded Auto-Fix Loop

Source PRD: [PRD-2026-15aa5acd](../PRD/PRD-2026-15aa5acd-live-behavior-dispatch-autofix.md) (readiness 4.7, PASS).

## Reused Capabilities

None. `trd-graph-cli capabilities docs/TRD` returns an empty registry — no `kind: foundational` TRD exists in this repo, so there is no shared capability to reference instead of rebuilding.

One explicit **non-reuse** worth recording: `TRD-2026-0fc1c1d0` (behavior-runtime-pi-harness) targets the same two packages and nominally provides "behavior compile/load" and "tool grant enforcement." This TRD does **not** depend on those as delivered capabilities, because PRD REQ-009/REQ-010/REQ-011 exist specifically to repair them (the compile/load path has no production call sites; the example behavior's trigger is unsatisfiable; `mutation_classes` is unenforced). The relationship is *repairs*, not *reuses*.

## Architecture Decision

**Chosen: Option C — single enforcement seam, additive.**

A new `MutationGuard` chokepoint in `agent-core` is the one place `policy.mode`, `capabilities.mutation_classes` (via the existing `hasMutationAuthority()`), and protected-path rules are resolved. It is wired once at the loader boundary rather than replicated per tool registration. The translator, matcher, and auto-fix loop are added to `pi-extension`. Discovery roots and `execution.test_command` are additive changes to existing schema/discovery code. `ToolRegistry`, `outbox`, and the compiler are reused unchanged.

### Alternatives considered

| Option | Summary | Why not chosen |
|---|---|---|
| **A — In-place extension** | Enforce mode/mutation/path rules as wrapper checks inside `behavior-loader`'s per-tool `execute()` closures. | Enforcement scattered across call sites; every future tool registration must remember to wrap. The PRD's central failure mode is *guarantees that exist in one place but are not reached from another* — Option A reproduces exactly that shape. |
| **B — Governance kernel** | Route every mutation through a `MutationBroker` + `GovernedWorkspace` in `agent-core`; `pi-extension` becomes a thin adapter. | Strongest long-term design and the right eventual target, but it re-opens already-shipped code across every tool path for a ~6-7 PR refactor before a single PRD requirement is demonstrable. Deferred deliberately, not rejected. |
| **C — Single enforcement seam** *(chosen)* | One `MutationGuard` chokepoint, wired once; everything else additive. | Gets a single auditable chokepoint (Option B's main benefit) without Option B's refactor surface. Fits the existing `agent-core` / `pi-extension` split. |

### Architectural note carried from grounding

Two defects found while grounding this design are folded into PR 1 rather than left implicit:

1. `pi-events.ts` emits `runtime.tool_result` / `runtime.tool.called` / `runtime.tool.failed` / `runtime.tool.completed`, none of which appear in `HARNESS_EVENT_TYPES` (which defines `runtime.tool_call.started` / `runtime.tool_call.completed`). `normalizeEvent` does not currently reject uncatalogued types, so PRD AC-002-1's "validated against the closed catalog" would be vacuous. Addressed by TRD-001 (`[satisfies INFRA]`).
2. `behavior-loader.ts:79` calls `registry.grant(...)` unconditionally immediately before `registry.invoke(...)`, making the grant boundary a rubber stamp for behavior-governed tools (unlike the echo path, where the grant is CLI-flag-gated). Addressed by TRD-003.

## Component Design

| Component | Package | Responsibility | Key interface |
|---|---|---|---|
| `MutationGuard` | agent-core | Sole authorization chokepoint for mutations | `authorize(req: MutationRequest): MutationDecision` |
| `ProtectedPathPolicy` | agent-core | Classifies paths as test / guardrail / constitution / ordinary | `classify(path): PathClass` |
| `WorkspaceSnapshot` | agent-core | Pre-attempt capture, exact restore on rejection | `capture(paths)` / `restore()` |
| `package-discovery` (modified) | agent-core | Configurable search roots, default preserves monorepo layout | `discoverBehaviorPackages(rootDir, opts?)` |
| `schema` / `compiler` (modified) | agent-core | `execution.test_command`; refuse `mode: auto` without enforcement or test command | existing `compile()` |
| `EventTranslator` | pi-extension | `runtime.tool_call.completed` → `test.failure.observed` | `translate(event): DomainEvent \| null` |
| `LocalEventMatcher` | pi-extension | Session-bounded activation decision | `onOutboxAppend(event): void` |
| `AutoFixLoop` | pi-extension | Apply → full-suite verify → accept/reject → retry/escalate | `run(event, behavior)` |
| `IssueIdentity` | pi-extension | Stable retry key | `keyFor(failure): string` |
| `ApprovalGate` | pi-extension | `ui.confirm`, fail-closed when `hasUI === false` | `confirm(title, msg): Promise<boolean>` |
| `CommitPolicy` | pi-extension | Branch restriction + attribution | `commit(changes, attribution)` |

**Data contracts.** `MutationRequest = { mutationClass: string; path?: string; kind: "write" | "delete" | "commit" }`. `MutationDecision = { allowed: true } | { allowed: false; reason: string; escalate: boolean }`. `MutationGuard` exposes `enforcementActive: boolean`; the loader reads it to satisfy AC-011-2.

**Failure paths.** Every `authorize()` denial is terminal for that candidate (no retry-with-different-path). Translator returns `null` rather than throwing on non-matching events. `LocalEventMatcher` swallows no errors: a behavior invocation failure is recorded as a failed attempt and counts toward the retry budget.

## Master Task List

### PR 1: Activation and the enforcement seam

**Shippable State:** Loading the extension in a real Pi session now discovers, compiles, and loads the repo's behavior packages; a behavior whose manifest does not grant `bash` is actually prevented from running `bash` in that session; and a conformance fixture asserting against an event the runtime cannot emit now fails instead of passing.

- [ ] **TRD-001** Reconcile `pi-events.ts` normalized event types with `HARNESS_EVENT_TYPES`, and make `normalizeEvent` reject uncatalogued types (4h) [satisfies INFRA]
  - Validates PRD ACs: AC-002-1 (makes "validated against the closed catalog" non-vacuous)
  - Implementation AC: Given a normalized event whose type is absent from the catalog, when `normalizeEvent` is called, then it throws rather than returning an event.
- [ ] **TRD-001-TEST** Catalog-rejection and renamed-type regression tests (2h) [verifies TRD-001] [satisfies INFRA] [depends: TRD-001]
  - Implementation AC: Given each of the four previously-uncatalogued type strings, when normalized, then each is either catalogued or rejected — no silent pass-through remains.
- [ ] **TRD-002** Implement `MutationGuard` in agent-core with mutation-class authorization via `hasMutationAuthority()` and an `enforcementActive` flag (6h) [satisfies REQ-011]
  - Validates PRD ACs: AC-011-1
  - Implementation AC: Given a compiled manifest whose `mutation_classes` omits `artifact.write`, when `authorize({mutationClass:"artifact.write"})` is called, then the decision is `allowed: false` with a reason naming the missing class.
- [ ] **TRD-002-TEST** MutationGuard authorization tests incl. tool-vs-mutation separation (3h) [verifies TRD-002] [satisfies REQ-011] [depends: TRD-002]
  - Validates PRD ACs: AC-011-1, AC-011-3
  - Implementation AC: Given a behavior granted `bash` but not `artifact.write`, when a write is attempted through a bash invocation, then `authorize()` denies it.
- [ ] **TRD-003** Route behavior tool execution through `MutationGuard` at the loader boundary and remove the unconditional `registry.grant()` in `behavior-loader.ts` (5h) [satisfies REQ-011] [depends: TRD-002]
  - Validates PRD ACs: AC-011-1, AC-011-3
  - Implementation AC: Given a governed tool invocation, when it executes, then its grant derives from the compiled manifest rather than being issued unconditionally at call time.
- [ ] **TRD-003-TEST** Loader-boundary enforcement tests, including the removed rubber-stamp path (3h) [verifies TRD-003] [satisfies REQ-011] [depends: TRD-003]
  - Implementation AC: Given a tool absent from `capabilities.tools`, when invoked through the loader, then the result is `unauthorized`.
- [ ] **TRD-004** Loader fails closed: refuse to load a `mode: auto` manifest when `enforcementActive` is false (3h) [satisfies REQ-011] [depends: TRD-002]
  - Validates PRD ACs: AC-011-2
  - Implementation AC: Given `enforcementActive === false` and a `mode: auto` manifest, when loading is attempted, then it is refused with a diagnostic naming the manifest.
- [ ] **TRD-004-TEST** Fail-closed load-refusal tests (2h) [verifies TRD-004] [satisfies REQ-011] [depends: TRD-004]
  - Implementation AC: Given the same manifest with `mode: propose`, when loaded with enforcement inactive, then it loads (proving the refusal is mode-specific, not blanket).
- [ ] **TRD-005** Wire discovery → compile → load into `extension.ts` `activate()` (5h) [satisfies REQ-009] [depends: TRD-003]
  - Validates PRD ACs: AC-009-1
  - Implementation AC: Given a repo with one valid behavior package, when the production `activate()` runs, then `discoverBehaviorPackages`, `compileBehaviorToArtifacts`, and `loadCompiledBehavior` are each reached without a test harness.
- [ ] **TRD-005-TEST** Activation-path tests driven through `activate()`, not direct loader calls (4h) [verifies TRD-005] [satisfies REQ-009] [depends: TRD-005]
  - Validates PRD ACs: AC-009-1, AC-009-2
  - Implementation AC: Given a manifest that does not grant `bash`, when a native bash call is attempted in a session created via `activate()`, then it is blocked — the assertion path must fail if the wiring is removed.
- [ ] **TRD-006** Graceful activation when the repo contains no behavior packages (2h) [satisfies REQ-009] [depends: TRD-005]
  - Validates PRD ACs: AC-009-3
  - Implementation AC: Given a repo with zero behavior packages, when `activate()` runs, then tool registration completes and no error is raised.
- [ ] **TRD-006-TEST** Empty-repo activation test (2h) [verifies TRD-006] [satisfies REQ-009] [depends: TRD-006]
  - Implementation AC: Given zero packages, when `activate()` runs, then `echoTool` is still registered.
- [ ] **TRD-007** Add the fixture-constructibility conformance rule (5h) [satisfies REQ-010]
  - Validates PRD ACs: AC-010-2, AC-010-3
  - Implementation AC: Given a fixture event containing a field no translator can emit, when conformance runs, then that fixture fails with a message naming the offending field.
- [ ] **TRD-007-TEST** Conformance-rule tests, including the negative proof against today's `exit_code` fixture (3h) [verifies TRD-007] [satisfies REQ-010] [depends: TRD-007]
  - Validates PRD ACs: AC-010-3
  - Implementation AC: Given the pre-existing `exit_code` fixture, when the rule runs, then it fails — proving detection rather than passing on corrected inputs.

### PR 2: Portability primitives

**Shippable State:** A behavior package can declare its own test command and can live outside `packages/`; behaviors in a non-monorepo checkout are discovered and loaded by a real session.

- [ ] **TRD-008** Make discovery roots configurable, replacing the hardcoded `join(rootDir, "packages")` (4h) [satisfies REQ-013]
  - Validates PRD ACs: AC-013-1, AC-013-2
  - Implementation AC: Given no configuration, when discovery runs in this monorepo, then the same package set is found as before the change.
- [ ] **TRD-008-TEST** Discovery-root tests for default and non-monorepo layouts (3h) [verifies TRD-008] [satisfies REQ-013] [depends: TRD-008]
  - Validates PRD ACs: AC-013-2
  - Implementation AC: Given a fixture repo with behaviors outside `packages/` and no `packages/` directory, when discovery runs with that root configured, then the behaviors are found.
- [ ] **TRD-009** Add `execution.test_command` to the schema and plumb it through the compiler (3h) [satisfies REQ-012]
  - Validates PRD ACs: AC-012-1
  - Implementation AC: Given a package declaring a test command, when compiled, then the command is present on the compiled artifact with no `npm test` fallback anywhere in the path.
- [ ] **TRD-009-TEST** Schema and compiler plumbing tests (2h) [verifies TRD-009] [satisfies REQ-012] [depends: TRD-009]
  - Implementation AC: Given a non-npm command such as `mix test`, when compiled, then it round-trips unaltered.
- [ ] **TRD-010** Validation: a `mode: auto` manifest without a test command fails validation (2h) [satisfies REQ-012] [depends: TRD-009]
  - Validates PRD ACs: AC-012-2
  - Implementation AC: Given `mode: auto` and no `execution.test_command`, when validated, then validation fails rather than defaulting to a package-manager guess.
- [ ] **TRD-010-TEST** Auto-mode test-command validation tests (2h) [verifies TRD-010] [satisfies REQ-012] [depends: TRD-010]
  - Implementation AC: Given `mode: propose` and no test command, when validated, then it passes — proving the rule is scoped to `auto`.

### PR 3: Signal capture and translation

**Shippable State:** Running a failing test command in a live session produces a catalog-valid `test.failure.observed` event in the outbox, and the shipped `investigate-test-failure` behavior's trigger actually matches it.

- [ ] **TRD-011** Widen `fromToolResult()` / `fromToolExecutionEnd()` to carry `command` and `isError` (3h) [satisfies REQ-001] [depends: TRD-001]
  - Validates PRD ACs: AC-001-1, AC-001-2
  - Implementation AC: Given a failing native bash call, when its result event fires, then the normalized payload contains the command string and `isError: true`.
- [ ] **TRD-011-TEST** Normalization payload tests for pass and fail (2h) [verifies TRD-011] [satisfies REQ-001] [depends: TRD-011]
  - Validates PRD ACs: AC-001-1, AC-001-2
  - Implementation AC: Given a succeeding bash call, when normalized, then `isError` is `false`.
- [ ] **TRD-012** Implement `EventTranslator` producing catalog-validated `test.failure.observed`, appended to the outbox (6h) [satisfies REQ-002] [depends: TRD-011]
  - Validates PRD ACs: AC-002-1
  - Implementation AC: Given a bash result with `isError: true` and a command matching the configured test-runner pattern, when translated, then a valid `test.failure.observed` is appended with status `accepted_locally`.
- [ ] **TRD-012-TEST** Translator tests incl. non-matching commands and successful runs (4h) [verifies TRD-012] [satisfies REQ-002] [depends: TRD-012]
  - Implementation AC: Given a failing bash call whose command does not match the test-runner pattern, when translated, then no event is produced.
- [ ] **TRD-013** Change the example behavior's trigger predicate to `isError`, recompute its digest, and update both fixtures (3h) [satisfies REQ-010] [depends: TRD-012]
  - Validates PRD ACs: AC-010-1
  - Implementation AC: Given an event produced by `EventTranslator` from a real failing bash result, when matched against the example's trigger, then it matches; the digest is recomputed by `computeManifestDigest()`, never hand-written.
- [ ] **TRD-013-TEST** Example-behavior trigger and fixture-conformance tests (2h) [verifies TRD-013] [satisfies REQ-010] [depends: TRD-013]
  - Validates PRD ACs: AC-010-1, AC-010-2
  - Implementation AC: Given the updated fixtures, when the TRD-007 constructibility rule runs, then they pass.
- [ ] **TRD-014** Confirm translator portability: no `packages/`-relative assumptions on any path (2h) [satisfies REQ-002] [depends: TRD-008, TRD-012]
  - Validates PRD ACs: AC-002-2
  - Implementation AC: Given a checkout with no `packages/` directory, when a matching bash failure occurs, then the same event is produced.
- [ ] **TRD-014-TEST** Non-monorepo translator test (2h) [verifies TRD-014] [satisfies REQ-002] [depends: TRD-014]
  - Validates PRD ACs: AC-002-2
  - Implementation AC: Given the non-monorepo fixture repo, when a test failure occurs, then the outbox receives the identical event shape as in this monorepo.

### PR 4: Event matching and enforced mode semantics

**Shippable State:** A real test failure in a live session now invokes the matching behavior automatically; behaviors declaring `propose` or `shadow` are genuinely prevented from writing to disk, while `auto` behaviors are permitted within their declared mutation classes.

- [ ] **TRD-015** Implement `LocalEventMatcher`: per-session cached compile, match on outbox append, invoke matches in-session (7h) [satisfies REQ-003] [depends: TRD-012, TRD-005]
  - Validates PRD ACs: AC-003-1, AC-003-2
  - Implementation AC: Given a behavior whose trigger matches an appended event, when the append occurs, then its compiled artifact executes in the current session; given no match, then nothing is invoked and no error is raised.
- [ ] **TRD-015-TEST** Matcher invocation and no-match tests (4h) [verifies TRD-015] [satisfies REQ-003] [depends: TRD-015]
  - Validates PRD ACs: AC-003-1, AC-003-2
  - Implementation AC: Given two behaviors where only one matches, when the event is appended, then exactly one invocation occurs.
- [ ] **TRD-016** Guarantee non-durability: no event-to-behavior correlation is written to disk or any external store (4h) [satisfies REQ-003] [depends: TRD-015]
  - Validates PRD ACs: AC-003-3, AC-003-4
  - Implementation AC: Given a completed match-and-invoke cycle, when the process exits, then no correlation record is recoverable from disk.
- [ ] **TRD-016-TEST** Cross-process non-durability proof (4h) [verifies TRD-016] [satisfies REQ-003] [depends: TRD-016]
  - Validates PRD ACs: AC-003-3, AC-003-4
  - Implementation AC: Given a correlation created in process A, when process A exits and process B starts against the same repo, then process B can recover no trace of it — asserted independently of `LocalRunner`'s existing non-orphan proof.
- [ ] **TRD-017** Add mode branching to `MutationGuard`: `auto` permits within mutation classes, `propose` denies direct writes, `shadow` denies all (6h) [satisfies REQ-004] [depends: TRD-002]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-004-3
  - Implementation AC: Given `mode: shadow` and `mutation_classes: [artifact.write]`, when a write is attempted, then it is denied — mode outranks declared classes.
- [ ] **TRD-017-TEST** Mode-branching matrix tests across all three modes (4h) [verifies TRD-017] [satisfies REQ-004] [depends: TRD-017]
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-004-3
  - Implementation AC: Given each of the three modes paired with an identical write attempt, when authorized, then the decisions are permit / deny / deny respectively.
- [ ] **TRD-018** Implement the proposal-artifact path used by `mode: propose` (4h) [satisfies REQ-004] [depends: TRD-017]
  - Validates PRD ACs: AC-004-1
  - Implementation AC: Given `mode: propose` and an attempted write, when the behavior completes, then a proposal artifact exists and the target file is unmodified.
- [ ] **TRD-018-TEST** Proposal-artifact tests (3h) [verifies TRD-018] [satisfies REQ-004] [depends: TRD-018]
  - Implementation AC: Given a proposal artifact, when inspected, then it contains the intended diff and the target file's on-disk content is byte-identical to its pre-attempt state.

### PR 5: Write boundary, approval gate, and commit policy

**Shippable State:** Behavior-driven edits are confined in code: test files and guardrail sources are refused, a rejected attempt restores the working tree exactly, a constitution proposal in a headless session fails closed instead of silently proceeding, and no automated commit can land on the default branch.

- [ ] **TRD-019** Implement `ProtectedPathPolicy` classifying test files, guardrail sources, conformance fixtures, and `docs/standards/constitution.md` (5h) [satisfies REQ-015] [depends: TRD-017]
  - Validates PRD ACs: AC-015-1, AC-015-2
  - Implementation AC: Given each of the four protected categories, when classified, then each returns its category rather than `ordinary`.
- [ ] **TRD-019-TEST** Path-classification tests including near-miss ordinary paths (4h) [verifies TRD-019] [satisfies REQ-015] [depends: TRD-019]
  - Implementation AC: Given a source file whose name merely contains the substring `test`, when classified, then it is not misclassified as a test file.
- [ ] **TRD-020** Enforce protected-path refusal inside `MutationGuard` (4h) [satisfies REQ-015] [depends: TRD-019]
  - Validates PRD ACs: AC-015-1, AC-015-2, AC-015-4
  - Implementation AC: Given a candidate write to any protected path under `mode: auto`, when authorized, then the decision is `allowed: false` with `escalate: true`.
- [ ] **TRD-020-TEST** Adversarial protected-path tests that bypass the model entirely (4h) [verifies TRD-020] [satisfies REQ-015] [depends: TRD-020]
  - Validates PRD ACs: AC-015-4
  - Implementation AC: Given a hand-constructed candidate diff targeting `tool-grant-enforcement.ts`, when passed directly to `authorize()` with no model involved, then it is refused.
- [ ] **TRD-021** Implement `WorkspaceSnapshot` capture and exact restore (6h) [satisfies REQ-015]
  - Validates PRD ACs: AC-015-3, AC-005-4
  - Implementation AC: Given a set of files modified during an attempt, when `restore()` runs, then every file's content and mode is byte-identical to capture time, and files created during the attempt are removed.
- [ ] **TRD-021-TEST** Snapshot round-trip and partial-failure restore tests (4h) [verifies TRD-021] [satisfies REQ-015] [depends: TRD-021]
  - Validates PRD ACs: AC-015-3
  - Implementation AC: Given an attempt that writes three files then fails on the fourth, when restore runs, then all three writes are reverted.
- [ ] **TRD-022** Implement `ApprovalGate` on `ui.confirm`, failing closed when `hasUI === false` (4h) [satisfies REQ-014]
  - Validates PRD ACs: AC-014-1, AC-014-2
  - Implementation AC: Given `hasUI === false`, when confirmation is requested, then no PR is opened, no file is written, and `ensemble.request_approval` is invoked instead.
- [ ] **TRD-022-TEST** Fail-closed gate tests across `hasUI` true/false (3h) [verifies TRD-022] [satisfies REQ-014] [depends: TRD-022]
  - Validates PRD ACs: AC-014-2
  - Implementation AC: Given `hasUI === false`, when the gate is evaluated, then no code path returns a truthy confirmation.
- [ ] **TRD-023** Implement `CommitPolicy`: refuse default/`main`/`master`, require attribution in the message (5h) [satisfies REQ-016]
  - Validates PRD ACs: AC-016-1, AC-016-2, AC-016-3
  - Implementation AC: Given the current branch is the repository default, when a commit is attempted, then it is refused or redirected to a dedicated branch — never committed in place.
- [ ] **TRD-023-TEST** Branch-policy and attribution tests (3h) [verifies TRD-023] [satisfies REQ-016] [depends: TRD-023]
  - Validates PRD ACs: AC-016-2, AC-016-3
  - Implementation AC: Given an accepted fix, when committed, then the message contains behavior name, source event id, and attempt number.

### PR 6: Bounded auto-fix loop

**Shippable State:** A deliberately broken test is detected, auto-fixed, verified against the full suite, and committed to a dedicated branch with no manual step; three failed attempts on the same issue escalate to the operator instead of looping; the same pipeline is proven on a non-monorepo repo with a non-npm test command.

- [ ] **TRD-024** Implement `IssueIdentity`: stable key from test identifier plus normalized failure-signature hash (4h) [satisfies REQ-006]
  - Validates PRD ACs: AC-006-3
  - Implementation AC: Given two failures of the same test with identical normalized signatures, when keyed, then the keys are equal; given a different failure signature, then the keys differ.
- [ ] **TRD-024-TEST** Identity-stability tests incl. volatile-content normalization (3h) [verifies TRD-024] [satisfies REQ-006] [depends: TRD-024]
  - Implementation AC: Given two runs whose failure output differs only by timestamps and absolute paths, when keyed, then the keys are equal.
- [ ] **TRD-025** Apply a candidate fix through `MutationGuard` (staged apply, every write authorized) (5h) [satisfies REQ-005] [depends: TRD-017, TRD-021, TRD-015]
  - Validates PRD ACs: AC-005-1
  - Implementation AC: Given a candidate touching an unauthorized path, when applied, then the attempt aborts at the first denial with no partial write surviving.
- [ ] **TRD-025-TEST** Staged-apply authorization tests (4h) [verifies TRD-025] [satisfies REQ-005] [depends: TRD-025]
  - Implementation AC: Given a candidate whose third write is denied, when applied, then writes one and two are reverted.
- [ ] **TRD-026** Re-verify with the behavior-declared test command over the full suite; accept only on zero failures (5h) [satisfies REQ-005] [depends: TRD-025, TRD-009]
  - Validates PRD ACs: AC-005-2
  - Implementation AC: Given a candidate that fixes the target test, when the full declared suite reports zero failures, then the fix is accepted and a fix-applied outcome is recorded.
- [ ] **TRD-026-TEST** Full-suite verification tests (4h) [verifies TRD-026] [satisfies REQ-005] [depends: TRD-026]
  - Validates PRD ACs: AC-005-2
  - Implementation AC: Given the target test passes but the suite reports one unrelated failure, when evaluated, then the fix is not accepted.
- [ ] **TRD-027** Reject on regression or protected-path violation and restore the tree (4h) [satisfies REQ-005] [depends: TRD-026, TRD-021]
  - Validates PRD ACs: AC-005-1, AC-005-3, AC-005-4
  - Implementation AC: Given a rejected candidate, when rejection completes, then the working tree is byte-identical to its pre-attempt state and the attempt counts toward the retry budget.
- [ ] **TRD-027-TEST** Adversarial rejection tests, including the gut-the-assertion candidate (4h) [verifies TRD-027] [satisfies REQ-005] [depends: TRD-027]
  - Validates PRD ACs: AC-005-1, AC-005-4
  - Implementation AC: Given a candidate whose only change deletes the failing assertion, when evaluated, then it is rejected by the TRD-020 write boundary without relying on model judgment.
- [ ] **TRD-028** Enforce the 3-attempt retry budget and escalate via `ensemble.request_approval` (5h) [satisfies REQ-006] [depends: TRD-024, TRD-027]
  - Validates PRD ACs: AC-006-1, AC-006-2
  - Implementation AC: Given two rejected attempts for one issue key, when a third is rejected, then no further attempt occurs and an approval request is recorded.
- [ ] **TRD-028-TEST** Retry-budget and counter-reset tests (4h) [verifies TRD-028] [satisfies REQ-006] [depends: TRD-028]
  - Validates PRD ACs: AC-006-2
  - Implementation AC: Given success on attempt two, when the suite passes, then no third attempt occurs and that issue's counter resets.
- [ ] **TRD-029** Gate constitution-change proposals behind the inline confirmation; open a PR only on "yes" (6h) [satisfies REQ-007] [depends: TRD-022, TRD-018]
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3
  - Implementation AC: Given a "no" answer, when the gate resolves, then no PR is opened and `constitution.md` is unchanged; given "yes", then a PR is opened and `constitution.md` remains unmodified until merge.
- [ ] **TRD-029-TEST** Approval-gate tests across yes / no / no-UI (4h) [verifies TRD-029] [satisfies REQ-007] [depends: TRD-029]
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3
  - Implementation AC: Given `hasUI === false`, when a constitution change is proposed, then the outcome matches the "no" branch exactly.
- [ ] **TRD-030** Bound total verification time within the behavior's declared `policy.timeout` across attempts (3h) [satisfies NFR-4] [depends: TRD-026]
  - Implementation AC: Given a suite whose runtime would exceed the declared timeout, when the budget is exhausted, then the attempt is treated as failed and escalates rather than running unbounded.
- [ ] **TRD-030-TEST** Timeout-budget tests (2h) [verifies TRD-030] [satisfies NFR-4] [depends: TRD-030]
  - Implementation AC: Given an artificially slow suite, when the budget elapses, then the run is terminated with no orphaned process.
- [ ] **TRD-031** End-to-end portability proof on a non-monorepo fixture repo with a non-npm test command (6h) [satisfies REQ-008] [depends: TRD-014, TRD-028, TRD-023]
  - Validates PRD ACs: AC-008-1
  - Implementation AC: Given the fixture repo with no `packages/` directory and a non-npm declared test command, when a real test fails, then translate → match → auto-fix → full-suite reverify → commit-or-escalate completes with no code modification.
- [ ] **TRD-031-TEST** Portability happy-path and escalation-path tests (5h) [verifies TRD-031] [satisfies REQ-008] [depends: TRD-031]
  - Implementation AC: Given the same fixture repo where no fix succeeds within three attempts, when the loop ends, then it escalates rather than committing — covering the edge case PRD REQ-008's single AC omits.

## Sprint Planning

Informational grouping only; `implement-trd-beads` does not parse this section.

### Sprint 1: Foundations (PR 1, PR 2) — 46h

Repairs the E0-E2 defects and lands the portability primitives. Highest-risk-first: nothing else is demonstrable until PR 1 merges.

### Sprint 2: Signal to invocation (PR 3, PR 4) — 53h

Produces the first real event-to-behavior firing and gives `policy.mode` teeth.

### Sprint 3: Safety and the loop (PR 5, PR 6) — 88h

Write boundary before auto-apply, then the bounded loop and the portability proof.

## Acceptance Criteria Traceability

| REQ-NNN | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Widen `tool_result` normalization | TRD-011 | TRD-011-TEST |
| REQ-002 | Translate to closed-catalog domain event | TRD-012, TRD-014 | TRD-012-TEST, TRD-014-TEST |
| REQ-003 | `LocalEventMatcher` matching and invocation | TRD-015, TRD-016 | TRD-015-TEST, TRD-016-TEST |
| REQ-004 | Enforced `policy.mode` semantics | TRD-017, TRD-018 | TRD-017-TEST, TRD-018-TEST |
| REQ-005 | Auto-apply with full-suite re-verification | TRD-025, TRD-026, TRD-027 | TRD-025-TEST, TRD-026-TEST, TRD-027-TEST |
| REQ-006 | Bounded retry and escalation | TRD-024, TRD-028 | TRD-024-TEST, TRD-028-TEST |
| REQ-007 | Constitution-change approval gate | TRD-029 | TRD-029-TEST |
| REQ-008 | Repo portability | TRD-031 | TRD-031-TEST |
| REQ-009 | Activate pipeline from entry point | TRD-005, TRD-006 | TRD-005-TEST, TRD-006-TEST |
| REQ-010 | Triggerable example + fixture constructibility | TRD-007, TRD-013 | TRD-007-TEST, TRD-013-TEST |
| REQ-011 | Enforce `mutation_classes`; refuse unenforced `auto` | TRD-002, TRD-003, TRD-004 | TRD-002-TEST, TRD-003-TEST, TRD-004-TEST |
| REQ-012 | Behavior-declared test command | TRD-009, TRD-010 | TRD-009-TEST, TRD-010-TEST |
| REQ-013 | Configurable discovery root | TRD-008 | TRD-008-TEST |
| REQ-014 | Fail closed without a UI | TRD-022 | TRD-022-TEST |
| REQ-015 | Auto-fix write boundary and restore | TRD-019, TRD-020, TRD-021 | TRD-019-TEST, TRD-020-TEST, TRD-021-TEST |
| REQ-016 | Commit and branch policy | TRD-023 | TRD-023-TEST |
| NFR-4 | Bounded verification cost | TRD-030 | TRD-030-TEST |
| INFRA | Catalog/normalizer reconciliation | TRD-001 | TRD-001-TEST |

## Adversarial Review

### Architecture issues

1. **Normalizer and closed catalog disagree (resolved in scope).** `pi-events.ts` emits four event types absent from `HARNESS_EVENT_TYPES`, and `normalizeEvent` does not reject uncatalogued types — so PRD AC-002-1's catalog validation would have been vacuous. *Resolution:* TRD-001 reconciles both and makes rejection real, sequenced first in PR 1.
2. **Grant boundary is a rubber stamp for behavior tools (resolved in scope).** `behavior-loader.ts:79` grants unconditionally immediately before invoking, so `ToolRegistry`'s authorization check can never fail on that path. *Resolution:* TRD-003 removes the unconditional grant and derives authority from the compiled manifest.
3. **`WorkspaceSnapshot` and concurrent human edits (accepted risk).** If the developer edits files while an attempt is in flight, `restore()` could revert their work. *Resolution:* snapshot scope is restricted to paths the attempt itself writes (TRD-021), never a whole-tree checkout; documented as a constraint rather than silently broadened.

### Task coverage issues

1. **PRD REQ-008 carries only one AC**, below the PRD standard of two per Must requirement. *Resolution:* TRD-031-TEST explicitly adds the escalation edge case alongside the happy path rather than inheriting the gap.
2. **NFR-4 had no owning task** in the first pass of the breakdown (it is an NFR, not a REQ, so no `[satisfies REQ-NNN]` annotation would have caught it). *Resolution:* TRD-030 / TRD-030-TEST added with `[satisfies NFR-4]`.
3. Every REQ-001…REQ-016 has at least one implementation task and one test task; no task references a nonexistent REQ.

### Dependency and estimate issues

1. **TRD-031 has the deepest chain** (TRD-011 → TRD-012 → TRD-014 → … → TRD-031, depth 5). This is inherent to an end-to-end proof and is accepted, but it means PR 6 cannot start meaningfully until PR 3 and PR 5 are both merged; that is reflected in the sprint grouping.
2. **No task exceeds 8h.** TRD-025 was split into TRD-025 (staged apply, 5h) and TRD-026 (full-suite verification, 5h) precisely to avoid a single 8h+ blob in the riskiest area.
3. **Estimate-confidence caveat:** TRD-021 (`WorkspaceSnapshot`, 6h) is the least certain estimate — exact restore semantics around file modes, deletions, and untracked files often expand. Flagged rather than padded.

### Testability

All Implementation ACs are stated as observable pass/fail conditions. Two deliberately avoid subjective phrasing where it would have been easy: TRD-020-TEST specifies "passed directly to `authorize()` with no model involved," and TRD-027-TEST specifies rejection "without relying on model judgment" — both are the mechanical form the PRD demands.

## Design Readiness Scorecard

| Dimension | Score | Rationale |
|---|---|---|
| Architecture completeness | 4 | Components, interfaces, and data contracts defined; `WorkspaceSnapshot` restore semantics are the one under-specified area. |
| Task coverage | 5 | All 16 REQs plus NFR-4 and one INFRA item have implementation and test tasks; REQ-008's AC gap is compensated. |
| Dependency clarity | 4 | Explicit and acyclic; one depth-5 chain into TRD-031 is inherent to an end-to-end proof. |
| Estimate confidence | 4 | No task over 8h, consistent sizing across similar work; TRD-021 flagged as least certain. |
| **Overall** | **4.25** | **PASS** |

## Entry and Exit Criteria

- **Entry:** PRD-2026-15aa5acd approved at readiness 4.7. The E0-E2 codebase exists but its pipeline-activation, example-triggerability, and mutation-enforcement defects are treated as work to repair, not as prerequisites satisfied.
- **Exit:** All 62 tasks complete; a deliberately broken test in this repo is auto-fixed, full-suite verified, and committed to a non-default branch with attribution and no test file modified; an adversarial candidate targeting a protected path is refused in code; a rejected candidate leaves the working tree byte-identical; and the same pipeline runs unmodified on the non-monorepo fixture repo.
