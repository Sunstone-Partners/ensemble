# Ensemble Project Constitution

---
**Version:** 1.0.0
**Status:** Draft — pending maintainer ratification
**Date:** 2026-09-23
**Canonical path:** `docs/standards/constitution.md`
---

## Purpose

This constitution is the durable engineering policy for the Ensemble repository. It
is the canonical source resolved by the Constitution Gate Contract in
`packages/product/commands/create-prd.yaml` and by the equivalent gates in
`refine-prd`, `create-trd`, and `implement-trd`.

Each article below carries a stable identifier (`Article I`…`Article IX`) and a
title. Every enforceable check listed under an article maps to that article's
identifier. A design document that violates an article is rejected at the gate;
there is no override, bypass, or `--foreman` auto-proceed path for a violation.

Articles state *what must be true of the work and its documentation*. They do not
prescribe implementation technique.

---

## Article I — Source Files Are Authoritative Over Generated Artifacts

Generated artifacts are derived state. The source file that produces them is the
only legitimate place to make a change.

- When a file declares `DO NOT EDIT - Generated from ...`, the referenced source is
  authoritative and the change is made there.
- Command and agent markdown under `packages/*/commands/` and `packages/*/agents/`
  is generated from YAML by `npm run generate`; the YAML is edited, then the
  generation step is run so derived artifacts stay in sync.
- A generated artifact is edited directly only when no source file exists, or when
  a human explicitly asks for that generated file itself to be edited.

**Enforceable checks (Article I):**

1. A design document must not specify hand-editing a generated artifact as the
   mechanism for delivering a requirement.
2. A design document that changes command, agent, or skill behavior must identify
   the YAML source of truth rather than the generated markdown.

---

## Article II — Requirements Describe Observable Behavior, Not Implementation

A requirement states what a user or operator can observe. The mechanism that
achieves it is a technical decision that belongs downstream.

- A PRD requirement must not name a framework, library, database, wire protocol,
  endpoint, schema, or file format as the requirement itself.
- Technology present in the repository is research *context*, never a requirement.
- Integration dependencies are named by capability and obligation, not by product
  or endpoint.
- Module names, type definitions, and directory layouts belong in a TRD.

**Enforceable checks (Article II):**

1. No requirement statement names a specific technology as the thing being
   required.
2. Each external dependency is expressed as a capability plus the obligation it
   carries.
3. Interface, schema, and data-flow design does not appear in a PRD.

---

## Article III — Every Requirement Is Independently Verifiable

Work that cannot be observed to be correct cannot be accepted as correct.

- Every requirement carries acceptance criteria in Given/When/Then form,
  co-located under that requirement.
- Every `Must` requirement carries at least two acceptance criteria: a success
  path and at least one edge, failure, or rejection path.
- Every `Should` requirement carries at least one acceptance criterion.
- An acceptance criterion describes an observable outcome. It must not reference a
  test file, harness, fixture, or internal function as the thing being satisfied.

**Enforceable checks (Article III):**

1. Every requirement heading is followed by at least one `AC-` entry in
   Given/When/Then form.
2. Every `Must` requirement has two or more acceptance criteria.
3. No acceptance criterion cites a test case, suite, or harness as its subject.

---

## Article IV — Authority Fails Closed and Is Never Self-Expanding

Automated systems in this repository act under granted authority. Ambiguity about
authority resolves toward refusal, never toward action.

- Unrecognized capabilities, permissions, policy fields, or schema versions must
  cause refusal, not a permissive default.
- No component may widen its own authority, and no component may grant itself a
  capability it was not issued.
- A capability grant is not a mutation grant: the ability to reach an effect
  through a tool does not authorize performing that effect.
- Changes to project policy, engineering guidance, or this constitution require
  explicit human approval and must remain blocked until approved, including
  across restarts.
- Recursive or self-triggering automation requires explicit, bounded depth and
  fan-out limits.

**Enforceable checks (Article IV):**

1. Any requirement granting an automated capability states its authority boundary
   and its failure-closed behavior.
2. Any requirement permitting mutation of policy, guidance, or this constitution
   requires an explicit human approval step.
3. Any requirement enabling recursive or self-triggering activity states its depth
   and fan-out bounds.

---

## Article V — Change Is Additive First and Reversible

Existing consumers keep working. Removal is the last stage of a migration, never
the first.

- New capability is introduced additively alongside the existing path.
- Existing artifacts, workflows, and public surfaces continue to function
  unchanged until a documented migration window has elapsed.
- Removal of a superseded path requires: an equivalent replacement in place,
  migration documentation, evidence from real use, and a tested rollback.
- Breaking changes are preceded by an additive deprecation period.

**Enforceable checks (Article V):**

1. A document proposing replacement of an existing capability states the
   additive-first path and the compatibility window.
2. Any removal requirement names its equivalent replacement, its rollback
   procedure, and the evidence required before removal.

---

## Article VI — Claims Are Backed by Evidence

An assertion that something works is not evidence that it works.

- A completion claim must cite the observable result that establishes it.
- Unverified assumptions are marked, not silently resolved. In design documents
  the marker is `[NEEDS CLARIFICATION: <specific question>]`; the question must be
  answerable briefly and completely.
- A numeric threshold, limit, timeout, or budget must carry its rationale or be
  marked as unresolved.
- Success metrics must state how they are measured and against what baseline.

**Enforceable checks (Article VI):**

1. Every numeric threshold in a requirement carries a rationale or a
   `[NEEDS CLARIFICATION: ...]` marker.
2. Every stated success metric identifies its measurement method and baseline.
3. Assumptions made without confirmation are marked rather than presented as
   settled.

---

## Article VII — Scope Boundaries Are Explicit

Undeclared scope is the primary source of disagreement about whether work is done.

- Every design document declares explicit non-goals.
- Every design document names the approver for the decision and the criteria that
  approver judges against.
- Every design document states its entry preconditions and the observable exit
  conditions that mark it delivered.
- Priority expresses business value only. Effort, complexity, and sizing
  judgements are excluded from a PRD.

**Enforceable checks (Article VII):**

1. An explicit non-goals section is present and non-empty.
2. Approval ownership and its judging criteria are named by role.
3. Entry and exit criteria are stated as observable conditions.
4. No requirement carries a complexity, effort, or sizing tag.

---

## Article VIII — Vocabulary Is Stable and Terms Are Not Collapsed

Distinct concepts keep distinct names. Collapsing them hides real design
disagreement behind apparent agreement.

- A document that introduces or depends on domain vocabulary defines each term
  once and uses it consistently thereafter.
- Terms with separate owners or lifecycles must not be used interchangeably.
- Cross-document references use stable identifiers, not display labels or titles.

**Enforceable checks (Article VIII):**

1. Domain terms used in requirements are defined in the document or in a cited
   source document.
2. A term is not used to mean two different things within one document.
3. Cross-document references cite stable document identifiers.

---

## Article IX — Work Is Traceable to a Tracked Issue and a Synchronized Version

- Issue tracking is Beads (`br`), with issues stored in `.beads/` and tracked in
  git. Graph-aware triage uses `bv --robot-*` output.
- Package versions must stay synchronized across `package.json`,
  `.claude-plugin/plugin.json`, and the `marketplace.json` entry. `npm run
  validate` fails on mismatch.
- Committing and pushing follow the repository's own git instructions. Tooling
  does not commit or push on its own initiative.

**Enforceable checks (Article IX):**

1. A delivery plan identifies how its work is tracked.
2. A requirement that changes a package's shipped content accounts for version
   synchronization across all three version-bearing files.

---

## Amendment

This constitution is amended by proposal and human approval, never by automated
edit. An amendment records: the triggering evidence, the proposed change, the
approving role, the resulting version, and the affected documents.

Amendments follow semantic versioning: a new or removed article is a major
change, a materially strengthened check is a minor change, and clarifying
language is a patch change.
