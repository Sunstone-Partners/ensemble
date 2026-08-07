---
document_id: PRD-2026-6a87c77f
label: prd-frontmatter-yaml-escaping
version: 1.0.2
status: Draft
date: 2026-08-07
scale_depth: LIGHT
total_requirements: 10
readiness_score: 4.94
---

# PRD-2026-6a87c77f: YAML-Safe Frontmatter Emission in the Markdown Generator

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 7 |
| Should requirements | 3 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 10/10 (100%) |
| Risk flags | 2 |
| Cross-requirement dependencies | 8 |
| [NEEDS CLARIFICATION] markers | 0 (resolved in v1.0.1) |

**Source bead:** `br-command-frontmatter-yaml-i64` (P1, bug) — found while dogfooding from `C:\dev\CRIBs`, 2026-08-07.

## Product Summary

**Problem:** `scripts/lib/command-transformer.js` and `scripts/lib/agent-transformer.js` build
frontmatter by raw string interpolation into hand-assembled lines — `lines.push(\`description: ${meta.description}\`)`.
No YAML escaping is applied anywhere. When a source value contains a construct YAML treats as
syntax, the emitted frontmatter block is unparseable, and Claude Code drops the **entire** command
or agent rather than degrading. It does so **silently** — no warning, no partial load.

Three surface symptoms, one flaw:

| Class | Trigger | Parser result | Example |
|---|---|---|---|
| 1 | `argument-hint` bracket group with trailing content | `[prd-path]` reads as a flow sequence, trailing text is a parse error | `argument-hint: [prd-path] [--team] [--foundational]` |
| 2 | `description` containing an unquoted `: ` | reads as a nested mapping | `description: Orchestrate the full idea-to-plan pipeline: create-prd, ...` |
| 3 | `description` sourced from a YAML block scalar | embedded newline emits as a column-0 continuation line | `git/release.yaml` uses `description: \|` |

A single bracket group (`[trd-path-or-slug]`) or an `<angle>` value parses fine, which is why the
failures looked random and read as a bad install.

**Verified impact (`main` @ `dfc4ed5`, 2026-08-07):** 19 of 73 generated command/agent artifacts
fail `yaml.load` on their frontmatter block.

| Package | Broken | Which |
|---|---|---|
| `development/commands` | 10 | `analyze-requirements`, `beads-build`, `beads-plan`, `configure-team`, `create-trd`, `create-trd-foreman`, `implement-trd-beads`, `refine-beads`, `trd-dependency-graph`, `validate-requirements` |
| `product/commands` | 6 | `check-binding-drift`, `check-feature-drift`, `feature`, `generate-feature-tests`, `generate-reqnroll-bindings`, `reqnroll-tdd` |
| `git/commands` | 2 | `claude-changelog`, `release` — **both**, so `ensemble-git` appears to have no commands at all |
| `infrastructure/agents` | 1 | `helm-chart-specialist` — an agent, not a command; outside the original bead's command-only walk |

The source bead reports 21 of 78, measured on the local `dev` branch. `dev` additionally carries
`check-playwright-drift` and `generate-playwright-tests`, which arrive on `main` with the in-flight
PR #10. They are the same defect and this fix covers them on arrival; the counts in this PRD are
`main`'s, since that is what the PR targets.

**Solution:** Route every emitted frontmatter value through one shared YAML-scalar helper in
`scripts/lib` that unconditionally quotes and folds to a single line, then add a parse check —
one implementation — invoked both by the generator (fail-fast on emit) and by `validate-all.js`
(so CI enforces it over committed artifacts).

**Value proposition:** Half the ensemble command surface stops being invisible, in every consuming
repo, and the failure mode becomes a loud build error at authoring time instead of a silent
absence that looks like a failed install.

**Target users:**
- **Ensemble consumers** — anyone running `/ensemble:*` in any repo. They are the ones losing the commands, and they have no way to detect or fix it.
- **Ensemble maintainers** — anyone running `npm run generate` or authoring a command/agent YAML. They are the ones who need the gate.

**Non-goals (v1):**
- Not changing Claude Code's plugin loader — Ensemble does not control it. This PRD makes the artifacts valid; it does not make the loader warn.
- Not migrating frontmatter emission to `yaml.dump()`. Measured during TRD design, it in fact produces a *smaller* diff than always-quoting, because js-yaml quotes only when necessary. It is excluded on different grounds: it emits a multi-line description as a `|` block scalar, restyles agent `tools` into a block sequence, and decides date quoting itself — trading our own quoting logic for negotiation with a general-purpose emitter's heuristics. See TRD §1.2.
- Not adding a length limit or readability lint on folded descriptions.

**Accepted v1 loss:** folding `git/release.yaml`'s two-line block-scalar description produces one
~150-character line. That is accepted rather than editing the source YAML to be shorter.

## User Analysis

| Role | Pain today | After |
|---|---|---|
| Ensemble consumer | Half the commands never appear. Symptom is indistinguishable from a partial install; real time was lost repeatedly reinstalling plugins, which can never fix it. | Every generated command loads. |
| Command/agent author | Can write a description with a colon in it and ship a dead command with no signal. | `npm run generate` exits non-zero and names the file, field, and parser reason. |
| Reviewer / CI | A stale or hand-edited artifact with broken frontmatter merges clean. | `npm run validate` fails. |

**Success metric:** `yaml.load` succeeds on the frontmatter block of **100%** of generated
command/agent `.md` artifacts, and any regression fails the build.

**Prior attempts, and why they weren't enough:**
- *Reinstalling plugins* — cannot work. The `.md` files are present on disk and are themselves the defect.
- *Hand-patching the CRIBs machine's local plugin cache* (2026-08-07) — unblocked one machine, wiped by any reinstall, fixes nothing for anyone else.
- *`packages/pi`'s `descSafe` guard* — the only escaping anywhere in the repo, and it is **insufficient**: it quotes only when the description *starts* with a YAML-special character, so a mid-string `: ` still breaks it (verified). See REQ-008.

## Goals and Non-Goals

**Goals:**
- Zero unparseable frontmatter blocks in generated artifacts.
- The defect cannot be reintroduced silently — by a new field, a new value, or a hand edit.
- The fix reaches every raw-interpolated field, not only the two the bug report happened to name.

**Non-Goals:** see Product Summary above.

## Requirements by Feature Area

### Frontmatter Emission

#### REQ-001: Shared YAML scalar helper
**Priority:** Must · **Complexity:** Low

A single exported helper in `scripts/lib` converts any string value into a YAML-safe,
single-line, double-quoted scalar. It is the only place quoting rules live. Quoting is
**unconditional** — there is no "does this need quoting?" predicate, because that predicate is
precisely what `packages/pi` got wrong.

- AC-001-1: Given a value containing `: `, `[`, `]`, `#`, `"`, or a leading `*`/`&`/`!`/`|`/`>`/`%`, when the helper emits it as a frontmatter line, then `yaml.load` of that line returns the original string unchanged.
- AC-001-2: Given a value containing a double quote or backslash, when emitted, then the round-tripped value equals the input exactly.

#### REQ-002: Every emitted frontmatter field routes through the helper
**Priority:** Must · **Complexity:** Low

`generateCommandFrontmatter` currently raw-interpolates seven fields (`name`, `description`,
`version`, `category`, `last-updated`, `allowed-tools`, `model`); `agent-transformer` interpolates
`name`, `description`, and `tools`. All string-valued fields go through REQ-001's helper. Fields
whose shape is structural (`tools: [...]`, `allowed-tools:` joins) quote their **elements**, not
the brackets.

**Rationale:** one guard in the shared emitter is a smaller diff than auditing which fields the
schema happens to constrain today. A schema can loosen; this cannot.

- AC-002-1: Given any command or agent YAML source, when `npm run generate` runs, then no frontmatter line in any emitted `.md` contains an unquoted string value.
- AC-002-2: Given a source YAML whose `category` is `planning: internal`, when generated, then the artifact's frontmatter still parses and `category` round-trips exactly.

#### REQ-003: Multi-line source values fold to a single line
**Priority:** Must · **Complexity:** Low

A description authored as a YAML block scalar (`|` or `>`) arrives at the emitter containing
newlines. The helper collapses all runs of whitespace — including newlines — to single spaces and
trims, before quoting.

- AC-003-1: Given `git/release.yaml`'s two-line block-scalar description, when generated, then the emitted `description:` occupies exactly one line and its frontmatter parses.
- AC-003-2: Given a value with a trailing newline (the default for `|`), when emitted, then no trailing whitespace and no blank line appears inside the frontmatter block.

### Generation and Validation Gate

#### REQ-004: The generator fails on unparseable output
**Priority:** Must · **Complexity:** Low

A parse-check function in `scripts/lib` `yaml.load`s the frontmatter block of every artifact the
generator emits. `generate-markdown.js` calls it and exits non-zero if any block fails.

**Rationale:** this check alone would have caught all 19 at generation time.

- AC-004-1: Given a deliberately corrupted emitter, when `npm run generate` runs, then the process exits non-zero and no partially-written artifact is left claiming success.
- AC-004-2: Given the current sources with REQ-001–003 applied, when `npm run generate` runs, then it exits zero and reports 73/73 frontmatter blocks parsed.

#### REQ-005: CI enforces the same check over committed artifacts
**Priority:** Must · **Complexity:** Low

`scripts/validate-all.js` calls the **same** function from REQ-004 over the committed `.md`
artifacts, so `npm run validate` — which CI runs — fails on a stale or hand-edited artifact.
One implementation, two callers.

The walk is **repo-wide**: every `.md` under `packages/` carrying a frontmatter block, including
artifacts from the `packages/pi` and `packages/codex` pipelines. Repo-wide is both simpler (no
exclusion list) and the only thing that enforces REQ-008 — otherwise pi's escaper is fixed but
left ungated. Verified: all 145 pi/codex artifacts parse today, so enabling this surfaces no
pre-existing failures.

- AC-005-1: Given a committed artifact hand-edited to break its frontmatter, when `npm run validate` runs, then it exits non-zero and names that file.
- AC-005-2: Given the repository at HEAD after this PR, when `npm run validate` runs, then it exits zero.
- AC-005-3: Given a `packages/pi` or `packages/codex` artifact with unparseable frontmatter, when `npm run validate` runs, then it exits non-zero — the check is not scoped to `scripts/lib`'s output.

#### REQ-006: Failure messages are actionable
**Priority:** Should · **Complexity:** Low

A parse failure reports the artifact path, the offending field name where determinable, and the
underlying parser reason — not just "invalid YAML".

- AC-006-1: Given an artifact with an unquoted `: ` in its description, when the check fails, then the message contains the file path and the js-yaml reason string.

### Repository Artifacts

#### REQ-007: All artifacts regenerated in the same PR
**Priority:** Must · **Complexity:** Low

The PR regenerates every command/agent artifact. Because REQ-001 quotes unconditionally, this
touches all 73 files, not only the 19 broken ones — accepted, as the alternative is a
correctness-critical heuristic.

- AC-007-1: Given the repository at the PR head, when the repro walk `yaml.load`s every generated command/agent frontmatter block, then 0 of 73 raise.
- AC-007-2: Given the PR head, when `npm run generate` is re-run, then `git status` reports no changes to generated artifacts.

### Sibling Generators

#### REQ-008: `packages/pi` adopts the same rule
**Priority:** Should · **Complexity:** Low

`renderFrontmatter` in pi's agent transformer quotes only when the description *starts* with a
YAML-special character. A mid-string `: ` still produces unparseable output (verified). No current
agent description triggers it — this is latent, not live. Fix in `packages/pi/src/transformers/`
and rebuild `dist/`.

[RISK: pi is a separate TS package with its own `tsc` build, so `dist/` must be rebuilt before `npm run generate:pi` picks the change up. *(Resolved during implementation: `dist/` is gitignored with zero tracked files, so there is no committed build output that could diverge — the rebuild is local-only.)*]

- AC-008-1: Given an agent description containing `: ` mid-string, when pi generates its agent artifact, then the emitted frontmatter parses.

### Non-Functional

#### REQ-009: No behavioral change beyond frontmatter
**Priority:** Must · **Complexity:** Low

Artifact bodies, key ordering, key names, and generated header comments are unchanged. The only
diff in a previously-valid artifact is the quoting of its frontmatter values.

- AC-009-1: Given any previously-parseable artifact, when regenerated, then the diff is confined to lines inside the `---` frontmatter block.

#### REQ-010: Existing suites stay green
**Priority:** Should · **Complexity:** Low

- AC-010-1: Given the PR head, when `npm test` runs, then no test fails that passes on `main`. Pre-existing `main` failures (`packages/product` `prd-parser.test.js`, `packages/router`'s Windows-incompatible `test` script) are out of scope.

## Acceptance Criteria Summary

| REQ | Description | Priority | Complexity | ACs |
|---|---|---|---|---|
| REQ-001 | Shared YAML scalar helper | Must | Low | 2 |
| REQ-002 | Every emitted field routes through it | Must | Low | 2 |
| REQ-003 | Multi-line values fold to one line | Must | Low | 2 |
| REQ-004 | Generator fails on unparseable output | Must | Low | 2 |
| REQ-005 | CI enforces the same check | Must | Low | 3 |
| REQ-006 | Failure messages are actionable | Should | Low | 1 |
| REQ-007 | All artifacts regenerated in-PR | Must | Low | 2 |
| REQ-008 | `packages/pi` adopts the same rule | Should | Low | 1 |
| REQ-009 | No behavioral change beyond frontmatter | Must | Low | 1 |
| REQ-010 | Existing suites stay green | Should | Low | 1 |

## Dependency Map

| REQ | Depends on | Notes |
|---|---|---|
| REQ-002 | REQ-001 | Nothing to route through until the helper exists |
| REQ-003 | REQ-001 | Folding is part of the helper's contract |
| REQ-004 | REQ-002, REQ-003 | Gate on a still-broken emitter fails the build immediately |
| REQ-005 | REQ-004 | Shares one implementation |
| REQ-006 | REQ-004 | Message quality of the same check |
| REQ-007 | REQ-002, REQ-003 | Regenerate only after the emitter is correct |
| REQ-009 | REQ-007 | Verified against the regenerated diff |
| REQ-008 | REQ-001 | Reuses the rule; may reuse the helper or mirror it in TS |

**Implementation clusters:**
1. **Emitter** — REQ-001, REQ-002, REQ-003. Ships together; artifacts still broken on disk at this point.
2. **Gate** — REQ-004, REQ-005, REQ-006. Must land with or after cluster 1, or CI goes red on the intermediate state.
3. **Artifacts** — REQ-007, REQ-009. Mechanical regeneration; the 73-file diff.
4. **Sibling** — REQ-008. Independent of 2 and 3; only needs REQ-001's rule.

No circular dependencies.

## Constraints and Delivery Notes

- **Branch off `main`, not `dev`.** `dev` is local dogfood aggregation and is never the head of a PR. This affects every ensemble user, so the PR targets `Sunstone-Partners/ensemble` `main`.
- Per repo convention, also merge the same branch into `dev` separately for local dogfooding. The dogfood merge never substitutes for the upstream PR.
- [RISK: the 73-file regeneration will conflict with the in-flight `feature/trd-2026-da72aa86-interactive-playwright-test-authoring` branch (PR #10) when both land on `dev`. Conflicts will be in generated artifacts only — resolve by regenerating, not by hand-merging.]

## Testability Note

"Commands are silently dropped at plugin load" is not directly observable from this repository —
Ensemble does not control Claude Code's loader. Every AC above therefore asserts against the
observable proxy the bead's own repro uses: `yaml.load` of the frontmatter block succeeds. That
proxy was verified to match reality — predicted-loadable and actually-loaded command counts agreed
exactly across all five packages during the original investigation.

## Readiness Scorecard

| Dimension | Score | Notes |
|---|---|---|
| Completeness | 5.0 | All three defect classes covered and the root cause generalized past them. Validate-side scope resolved in v1.0.1. |
| Testability | 5.0 | Every AC is a runnable `yaml.load` assertion; the untestable claim is called out and replaced with a verified proxy. |
| Clarity | 4.75 | Two developers would build the same thing. The only judgement left is helper placement/naming. |
| Feasibility | 5.0 | ~40 lines of change across 3 files plus regeneration. No external dependencies. |
| **Overall** | **4.94** | **PASS** |

## Next Step

```
/ensemble:create-trd docs/PRD/PRD-2026-6a87c77f-frontmatter-yaml-escaping.md
```
