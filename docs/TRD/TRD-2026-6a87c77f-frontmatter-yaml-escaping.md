---
document_id: TRD-2026-6a87c77f
label: trd-frontmatter-yaml-escaping
kind: trd
prd_reference: PRD-2026-6a87c77f (docs/PRD/PRD-2026-6a87c77f-frontmatter-yaml-escaping.md v1.0.1)
version: 1.0.0
status: Draft
date: 2026-08-07
design_readiness_score: 4.63
---

# TRD-2026-6a87c77f: YAML-Safe Frontmatter Emission in the Markdown Generator

**Source PRD:** `docs/PRD/PRD-2026-6a87c77f-frontmatter-yaml-escaping.md` (v1.0.1, readiness 4.94 PASS)
**Source bead:** `br-command-frontmatter-yaml-i64`

## Reused Capabilities

None. `trd-graph-cli capabilities docs/TRD` returns an empty registry — no foundational TRDs exist
in this repository, so there is nothing to depend on by reference. This TRD introduces two small
modules that are candidates for future reuse but are not being extracted as foundational work.

## 1. Architecture Decision

### 1.1 Chosen approach — Option A: `JSON.stringify` scalar helper at the existing emit seam

Keep the hand-built frontmatter lines in both transformers. Introduce one helper that folds a value
to a single line and quotes it via `JSON.stringify`, and route every emitted value through it.
Separately, add a parse check at `generateMarkdown()` — the single funnel every artifact already
passes through — and reuse that same check in `validate-all.js`.

```js
// scripts/lib/yaml-scalar.js
const foldScalar  = (v) => String(v).replace(/\s+/g, ' ').trim();
const yamlScalar  = (v) => JSON.stringify(foldScalar(v));
```

**Why `JSON.stringify`:** a JSON string literal is a valid YAML 1.2 double-quoted scalar. The
escaping is therefore stdlib's, not ours — there is no hand-rolled quoting logic to get wrong, and
no "does this need quoting?" predicate. That predicate is precisely the defect in `packages/pi`
(PRD REQ-008).

**Verified** against eight adversarial inputs — mid-string `: `, bracket group with trailing
content, embedded newlines and blank lines, embedded double quotes and backslashes, a leading `*`
with `#`/`|`/`>`/`%`/`&`/`!` throughout, a bare `ensemble:feature`, leading/trailing whitespace,
and non-ASCII. All eight round-trip through `yaml.load` to the folded original exactly.

### 1.2 Alternatives considered

**Option B — serialize the frontmatter block with `js-yaml`'s `dump()`.**
Correct by construction with none of our own quoting logic, and measured to produce a *smaller*
diff than Option A (js-yaml quotes only when necessary, so previously-valid artifacts emit
byte-identically). Rejected on emitter-style coupling, measured empirically:

| Behaviour | `dump()` output | Consequence |
|---|---|---|
| Multi-line description | emits a `\|` block scalar | valid YAML, but violates REQ-003's single-line requirement; needs pre-folding anyway |
| `tools: [Read, Write]` | restyled to a block sequence (`- Read`) | changes every agent artifact's shape |
| `last-updated: 2026-03-15` | newly quoted | js-yaml decides, we don't |

Each is individually tunable, but the result is our code negotiating with a general-purpose
emitter's heuristics for a seven-key flat map. Option A has no heuristics at all.

> **PRD correction:** PRD v1.0.1's non-goal states `yaml.dump()` would produce "a much noisier
> diff." That rationale is wrong — measurement shows the opposite. The conclusion (don't use it)
> still holds, on the emitter-coupling grounds above. PRD corrected to match in v1.0.2.

**Option C — inline the quoting separately in each transformer.** Rejected by PRD REQ-001: three
emitters already exist and `packages/pi`'s copy has already drifted into incorrectness. One helper,
one rule.

> **Note on the third emitter.** `scripts/generate-codex/index.js` already builds frontmatter with
> `yaml.dump(data, { lineWidth: 1000 })` — that is Option B, and it is correct by construction, so
> codex was never exposed to this bug class. Its artifacts only *look* unquoted because js-yaml
> quotes on demand. No change is needed there, and the repo-wide check in REQ-005 covers it anyway.

### 1.3 Two shapes that must not be conflated

The single highest-risk detail in this change. Two frontmatter keys look similar and are not:

| Key | Current emission | YAML type | Correct treatment |
|---|---|---|---|
| `allowed-tools` (command) | `allowed_tools.join(', ')` | **string** — `"Read, Write"` | `yamlScalar(joined)` — quote the whole joined string |
| `tools` (agent) | `[${tools.join(', ')}]` | **flow sequence** — `["Read","Write"]` | `[${tools.map(yamlScalar).join(', ')}]` — quote each element |

Quoting `tools` as a whole string would collapse a list into one string; bracketing `allowed-tools`
would promote a string into a list. Either silently changes tool permissions. Both are pinned by
dedicated ACs in TRD-002 and TRD-003.

## 2. System Architecture

### 2.1 Components

| Component | Status | Responsibility |
|---|---|---|
| `scripts/lib/yaml-scalar.js` | **new**, ~15 LOC | `foldScalar`, `yamlScalar`. No I/O, no deps. |
| `scripts/lib/frontmatter-check.js` | **new**, ~35 LOC | `extractFrontmatter(content)`, `checkFrontmatter(content, sourcePath)`. Throws on parse failure with path + reason. |
| `scripts/lib/command-transformer.js` | modified | Routes all seven emitted keys through `yamlScalar` |
| `scripts/lib/agent-transformer.js` | modified | Routes `name`, `description`, `tools` elements |
| `scripts/lib/markdown-generator.js` | modified | Calls `checkFrontmatter` on the generated string before returning |
| `scripts/validate-all.js` | modified | Repo-wide walk of `packages/**/*.md`, calls `checkFrontmatter` |
| `packages/pi/src/transformers/agent-transformer.ts` | modified | Mirrors the rule in TS; `dist/` rebuilt |

### 2.2 Data flow

```
command/agent .yaml
  → yaml-parser.js        (read, unchanged)
  → schema-validator.js   (validate, unchanged)
  → markdown-generator.js :: generateMarkdown()          ← single funnel
      → command-transformer / agent-transformer
          → yaml-scalar.js :: yamlScalar()               [REQ-001..003]
      → frontmatter-check.js :: checkFrontmatter()       [REQ-004] fail-fast, throws
  → file-utils.js :: writeFileAtomic()                   (unchanged)

npm run validate
  → validate-all.js → walk packages/**/*.md
      → frontmatter-check.js :: checkFrontmatter()       [REQ-005] same function
```

**Integration points.** `generateMarkdown()` is the only place both transformers converge before
write, so one call site there covers every command *and* agent artifact — no per-transformer
wiring. `checkFrontmatter` is a pure `(string, string) → void|throw`, which is what lets the
generator and the validator share it without either depending on the other.

**Failure protocol.** `checkFrontmatter` throws `GenerationError` (existing type in
`error-handler.js`) carrying `sourcePath` and the js-yaml `reason` string. `generate-markdown.js`
already handles `GenerationError` and exits non-zero; `validate-all.js` collects and reports them
in its existing error accumulator rather than throwing on the first.

**Technology choices.** `js-yaml` is already a direct dependency used by `yaml-parser.js` and
`schema-validator.js` — the check adds no new dependency. `JSON.stringify` is stdlib. No new
packages.

### 2.3 Deliberate coupling

Placing the check *inside* `generateMarkdown()` means a caller cannot generate without validating.
That is intentional — failing closed is the entire point of REQ-004 — and there is no existing
caller that wants raw unvalidated generation.

## Master Task List

### PR 1: Correct frontmatter emission and gate it

**Shippable State:** All 19 previously-unloadable ensemble commands and agents — including both of
`ensemble-git`'s, which made the plugin appear to have no commands at all — appear and are
invocable in a Claude Code session; and a contributor whose description would break frontmatter now
gets a build failure naming the file and the parser reason instead of a silently dead command.

- [x] **TRD-001** Create `scripts/lib/yaml-scalar.js` exporting `foldScalar` and `yamlScalar` (0.5h) `[satisfies REQ-001]`
  - Validates PRD ACs: AC-001-1, AC-001-2
  - Implementation AC: Given any string, when passed to `yamlScalar`, then the result is a valid YAML double-quoted scalar whose `yaml.load` equals `foldScalar` of the input.
  - Implementation AC: Given a value with newlines, tabs, or runs of spaces, when folded, then all whitespace runs collapse to single spaces and the result is trimmed.

- [x] **TRD-001-TEST** Unit tests for `yaml-scalar` over the eight adversarial inputs (0.5h) `[verifies TRD-001] [satisfies REQ-001] [depends: TRD-001]`
  - Validates PRD ACs: AC-001-1, AC-001-2
  - Implementation AC: Given each of mid-string `: `, `[a] [b]`, embedded `\n\n`, embedded `"` and `\`, leading `*` with `#|>%&!`, `ensemble:feature`, padded whitespace, and non-ASCII, when emitted as `key: <scalar>` and parsed, then each round-trips to the folded original.

- [x] **TRD-002** Route all seven command frontmatter keys through `yamlScalar`; keep `allowed-tools` a joined **string** (1h) `[satisfies REQ-002] [satisfies REQ-003] [depends: TRD-001]`
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-003-1, AC-003-2
  - Implementation AC: Given a command YAML with `category: "planning: internal"`, when generated, then the frontmatter parses and `category` round-trips exactly.
  - Implementation AC: Given a command with `allowed_tools: [Read, Write]`, when generated, then `yaml.load` returns the **string** `"Read, Write"` for `allowed-tools`, not an array.
  - Implementation AC: Given `git/release.yaml`'s block-scalar description, when generated, then `description` occupies exactly one line with no trailing blank line inside the block.

- [x] **TRD-002-TEST** Unit tests for command frontmatter emission (0.5h) `[verifies TRD-002] [satisfies REQ-002] [depends: TRD-002]`
  - Validates PRD ACs: AC-002-1, AC-002-2, AC-003-1, AC-003-2
  - Implementation AC: Given a fixture exercising all seven keys with hostile values, when generated, then the frontmatter parses and every key round-trips with its original YAML type.

- [x] **TRD-003** Route agent frontmatter through `yamlScalar`; keep `tools` a **flow sequence** with quoted elements (0.5h) `[satisfies REQ-002] [satisfies REQ-003] [depends: TRD-001]`
  - Validates PRD ACs: AC-002-1, AC-003-1
  - Implementation AC: Given an agent with `tools: [Read, Bash]`, when generated, then `yaml.load` returns the **array** `["Read","Bash"]`, not a string.
  - Implementation AC: Given `helm-chart-specialist`'s description, when generated, then its frontmatter parses.

- [x] **TRD-003-TEST** Unit tests for agent frontmatter emission (0.5h) `[verifies TRD-003] [satisfies REQ-002] [depends: TRD-003]`
  - Validates PRD ACs: AC-002-1, AC-003-1
  - Implementation AC: Given an agent fixture with a colon in the description and a tool name containing a space, when generated, then `description` is a string and `tools` remains an array of the original elements.

- [x] **TRD-004** Create `scripts/lib/frontmatter-check.js` with `extractFrontmatter` and `checkFrontmatter` (1h) `[satisfies REQ-004] [satisfies REQ-006]`
  - Validates PRD ACs: AC-004-1, AC-006-1
  - Implementation AC: Given content whose frontmatter fails to parse, when `checkFrontmatter` runs, then it throws a `GenerationError` whose message contains the source path and the js-yaml `reason` string.
  - Implementation AC: Given content with no `---` block at all, when `checkFrontmatter` runs, then it returns without throwing (absent frontmatter is not a defect).

- [x] **TRD-004-TEST** Unit tests for the check, one per PRD defect class (0.5h) `[verifies TRD-004] [satisfies REQ-004] [depends: TRD-004]`
  - Validates PRD ACs: AC-004-1, AC-006-1
  - Implementation AC: Given one fixture per defect class (bracket-with-trailing, mid-string colon, column-0 continuation), when checked, then each throws and each message names its file.

- [x] **TRD-005** Call `checkFrontmatter` inside `generateMarkdown()` before returning (0.5h) `[satisfies REQ-004] [depends: TRD-004]`
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Implementation AC: Given a deliberately corrupted emitter, when `npm run generate` runs, then it exits non-zero and no artifact is written for the failing source.
  - Implementation AC: Given the corrected sources, when `npm run generate` runs, then it exits zero and reports 73/73 frontmatter blocks parsed.

- [x] **TRD-005-TEST** Test that generation fails closed (0.5h) `[verifies TRD-005] [satisfies REQ-004] [depends: TRD-005]`
  - Validates PRD ACs: AC-004-1
  - Implementation AC: Given a stubbed transformer returning invalid frontmatter, when `generateMarkdown` is called, then it throws and `writeFileAtomic` is never reached.

- [x] **TRD-006** Add a repo-wide `packages/**/*.md` frontmatter walk to `validate-all.js` (1h) `[satisfies REQ-005] [depends: TRD-004]`
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-005-3
  - Implementation AC: Given a committed artifact hand-edited to break its frontmatter, when `npm run validate` runs, then it exits non-zero and names that file.
  - Implementation AC: Given a broken artifact under `packages/pi` or `packages/codex`, when `npm run validate` runs, then it exits non-zero — the walk is not scoped to `scripts/lib`'s output.
  - Implementation AC: Given the repository after TRD-007, when `npm run validate` runs, then it exits zero.

- [x] **TRD-006-TEST** Test the validate-side walk over a temp fixture tree (0.5h) `[verifies TRD-006] [satisfies REQ-005] [depends: TRD-006]`
  - Validates PRD ACs: AC-005-1, AC-005-3
  - Implementation AC: Given a fixture tree with one broken artifact outside `commands/` and `agents/`, when the walk runs, then it is reported.

- [x] **TRD-007** Regenerate all artifacts and verify the repro is clean (0.5h) `[satisfies REQ-007] [satisfies REQ-009] [depends: TRD-002, TRD-003, TRD-005]`
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-009-1
  - Implementation AC: Given the PR head, when the repro walk parses every generated command/agent frontmatter block, then 0 of 73 raise.
  - Implementation AC: Given the PR head, when `npm run generate` is re-run, then `git status` reports no changes.
  - Implementation AC: Given any previously-parseable artifact, when its diff is inspected, then every changed line lies inside the `---` frontmatter block.

- [x] **TRD-007-TEST** Assert the regenerated tree is clean and body-stable (0.5h) `[verifies TRD-007] [satisfies REQ-007] [depends: TRD-007]`
  - Validates PRD ACs: AC-007-1, AC-009-1
  - Implementation AC: Given every generated artifact, when the frontmatter block is stripped, then the remaining body is byte-identical to the pre-change body.

- [x] **TRD-008** Confirm the `last-updated` Date→string type change breaks no consumer (0.5h) `[satisfies REQ-009] [depends: TRD-002]`
  - Validates PRD ACs: AC-009-1
  - Implementation AC: Given a repo-wide search for readers of `last-updated`/`lastUpdated`, when run, then the only non-test match is the producer in `command-transformer.js` — recorded in the PR description. *(Pre-verified during design: one producer, zero consumers.)*

### PR 2: Extend the rule to the pi generator

**Shippable State:** Agent artifacts produced by the `packages/pi` pipeline survive a description
containing a colon instead of emitting frontmatter that would be dropped, and CI fails if any pi or
codex artifact's frontmatter ever becomes unparseable.

- [x] **TRD-009** Replace pi's `descSafe` predicate with the unconditional fold-and-quote rule in `packages/pi/src/transformers/agent-transformer.ts`; rebuild `dist/` (1h) `[satisfies REQ-008] [depends: TRD-001]`
  - Validates PRD ACs: AC-008-1
  - Implementation AC: Given an agent description containing a mid-string `: `, when pi generates its artifact, then the frontmatter parses.
  - Implementation AC: Given a rebuilt `dist/`, when `npm run generate:pi` runs, then the regenerated agent artifacts carry quoted frontmatter. *(`dist/` is gitignored — the rebuild is local-only, there is no committed build output.)*

- [x] **TRD-009-TEST** Unit test for pi's agent frontmatter (0.5h) `[verifies TRD-009] [satisfies REQ-008] [depends: TRD-009]`
  - Validates PRD ACs: AC-008-1
  - Implementation AC: Given the same eight adversarial inputs from TRD-001-TEST, when pi emits an agent frontmatter, then all eight round-trip.

- [x] **TRD-010** Full-suite regression confirmation (0.5h) `[satisfies REQ-010] [depends: TRD-007, TRD-009]`
  - Validates PRD ACs: AC-010-1
  - Implementation AC: Given the PR head, when `npm test` runs, then no test fails that passes on `main`. Pre-existing `main` failures (`packages/product` `prd-parser.test.js`, `packages/router`'s Windows-incompatible `test` script) are recorded as out of scope in the PR description.


**Total: 18 tasks (10 implementation, 8 test), 11.0h** — PR 1 is 9.0h, PR 2 is 2.0h. No task
exceeds 1h; none is an 8h+ breakdown candidate.

## 3. Sprint Planning

*Informational grouping only — not parsed by `implement-trd-beads`.*

### Sprint 1 (single sprint, ~12h)

Both PRs fit one sprint. PR 1 is the whole user-visible fix and should land first; PR 2 is
Should-priority parity work that can slip without blocking the fix.

- **Day 1** — TRD-001 → TRD-005 and their tests. Emitter correct, gate wired, artifacts still stale on disk.
- **Day 2** — TRD-006 → TRD-008. Validate-side walk, regeneration, type-change confirmation. PR 1 complete.
- **Day 2 (tail)** — TRD-009 → TRD-010. PR 2 complete.

## 4. Acceptance Criteria Traceability

| REQ-NNN | Description | Priority | Implementation Tasks | Test Tasks |
|---|---|---|---|---|
| REQ-001 | Shared YAML scalar helper | Must | TRD-001 | TRD-001-TEST |
| REQ-002 | Every emitted field routes through it | Must | TRD-002, TRD-003 | TRD-002-TEST, TRD-003-TEST |
| REQ-003 | Multi-line values fold to one line | Must | TRD-002, TRD-003 | TRD-002-TEST, TRD-003-TEST |
| REQ-004 | Generator fails on unparseable output | Must | TRD-004, TRD-005 | TRD-004-TEST, TRD-005-TEST |
| REQ-005 | CI enforces the same check | Must | TRD-006 | TRD-006-TEST |
| REQ-006 | Failure messages are actionable | Should | TRD-004 | TRD-004-TEST |
| REQ-007 | All artifacts regenerated in-PR | Must | TRD-007 | TRD-007-TEST |
| REQ-008 | `packages/pi` adopts the same rule | Should | TRD-009 | TRD-009-TEST |
| REQ-009 | No behavioral change beyond frontmatter | Must | TRD-007, TRD-008 | TRD-007-TEST |
| REQ-010 | Existing suites stay green | Should | TRD-010 | TRD-010 |

**Traceability check: 10 requirements covered, 0 uncovered, 0 orphaned annotations.**
Every task maps to a REQ; no `[satisfies ARCH]` or `[satisfies INFRA]` orphans remain.

## 5. Quality Requirements

- **Testing.** Jest, matching the existing `scripts/tests/` convention. New modules get unit tests; no integration harness required — every AC is a `yaml.load` assertion or a process exit code.
- **Security.** No new dependency, no network, no filesystem writes outside the existing `writeFileAtomic` path. `validatePathSecurity` in `file-utils.js` continues to govern write paths; the new walk is read-only.
- **Performance.** The check parses ~145 small frontmatter blocks. Immaterial against existing generation cost; no budget needed.
- **Compatibility.** Output remains valid YAML for any consumer. The only type change is `last-updated` (Date → string), verified to have zero consumers.
- **Style.** Conventional commits, `fix(generator):` / `test(generator):` scopes. Matches the surrounding CommonJS `'use strict'` idiom in `scripts/lib`.

## 6. Adversarial Review Findings

### 6.1 Architecture

1. **`allowed-tools` vs `tools` type divergence.** Conflating them silently changes tool permissions — a string becomes a list or vice versa. *Resolution:* pinned by explicit ACs in TRD-002 and TRD-003 asserting the parsed YAML **type**, not just parseability. Documented in §1.3.
2. **`last-updated` Date→string.** Bare `2026-03-15` parses as a JS `Date`; quoted it is a string. *Resolution:* TRD-008. Pre-verified — one producer, zero consumers.
3. **Check inside `generateMarkdown()` couples generation to validation.** No caller can opt out. *Resolution:* accepted deliberately; failing closed is REQ-004's purpose and no such caller exists. Documented in §2.3.
4. **Hand-authored `.md` files are in scope of the repo-wide walk.** The walk cannot distinguish generated from hand-written artifacts, so a hand-authored file with broken frontmatter will now fail CI. *Resolution:* accepted — that file would be equally dropped by the loader, so flagging it is correct behaviour, not a false positive.

### 6.2 Coverage

1. **REQ-009 is a Must with only one PRD-side AC** (the gate wants two for Musts). *Resolution:* TRD-007 and TRD-008 carry three implementation ACs between them, covering both the diff-confinement claim and the type-change risk. No PRD amendment needed.
2. **PRD v1.0.1's `yaml.dump()` rationale is factually wrong.** Measurement contradicts it. *Resolution:* corrected in PRD v1.0.2 during this design pass; the conclusion is unchanged, only the reasoning.

### 6.3 Dependencies and estimates

1. **One dependency chain of depth 4** — TRD-001 → TRD-002 → TRD-007 → TRD-010. *Resolution:* accepted; every link is ≤1h, so the critical path is ~3h. No circular dependencies exist.
2. Estimates are uniform (0.25–1h) and consistent across similar tasks. No task is flagged for breakdown.

### 6.4 Testability

All implementation ACs resolve to a `yaml.load` equality assertion, a parsed-type assertion, a
process exit code, or a `git status` result. No subjective language ("fast", "clean",
"user-friendly") appears in any AC.

## 7. Design Readiness Scorecard

| Dimension | Score | Notes |
|---|---|---|
| Architecture completeness | 5.0 | Components, the single funnel seam, failure protocol, and the two-shapes hazard are all specified. |
| Task coverage | 4.5 | All 10 REQs have implementation and test tasks. REQ-009's PRD-side AC deficit is absorbed by implementation ACs rather than a PRD amendment. |
| Dependency clarity | 4.5 | Explicit and acyclic; one depth-4 chain flagged and accepted. |
| Estimate confidence | 4.5 | Uniform 0.25–1h tasks, no 8h+ items. Regeneration hours are the least certain if the diff surprises. |
| **Overall** | **4.63** | **PASS** |

## 8. Next Steps

```
/ensemble:implement-trd-beads docs/TRD/TRD-2026-6a87c77f-frontmatter-yaml-escaping.md
```

`/ensemble:configure-team` is not warranted here — 18 tasks of single-package generator work does
not need a multi-role team configuration.
