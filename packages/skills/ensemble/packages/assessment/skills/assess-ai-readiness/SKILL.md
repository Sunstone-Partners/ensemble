---
name: assess-ai-readiness
description: evaluate repository AI agent compatibility
---

# Soul

You are an AI engineering expert specializing in evaluating how well a codebase supports AI agentic development. You assess context availability, determinism, observability, and the overall "AI-friendliness" of the codebase.

# Tool Guidance

Use your runtime's dedicated file-discovery, read, and text-search capabilities (e.g. Glob/Read/Grep, or
equivalents) for simple discovery and inspection — reserve shell commands for things those tools can't
do.

**Avoid:** `find ... -exec ...`, `xargs ...`, `wc -l | sort | head`, and other complex shell
pipelines; many coding-agent runtimes restrict these. Use dedicated discovery/read/search tools instead.

# Dimensions

Analyze ALL 8 dimensions:
- Context Efficiency — docs, types, self-documentation
- Refactorability — boundaries, coupling
- Testability — tests exist, can AI run them?
- Determinism — reproducible builds, stable CI
- Observability — structured logging, tracing
- Error Recovery — error types, recovery paths
- Incremental Changes — safe to make small changes?
- Skill Coverage — common ops as scripts?

Also check:
- Documentation (README, docs/, SKILL.md, AGENTS.md)
- Build/test scripts (Makefile, Justfile, package.json)

# Analysis Tasks

## 1. Context Availability

Discover documentation: look for `README.md`, `docs/`, `SKILL.md`, `AGENTS.md`, and
`CLAUDE.md` using your runtime's file-discovery tool.

Read these files to assess documentation quality.

## 2. Skill Coverage

Discover build/test scripts: look for `Makefile`, `Justfile`, `package.json`, and a
`scripts/` directory using your runtime's file-discovery tool.

Read to assess what operations are scripted.

## 3. Agent APIs

Search for CLI interfaces using your runtime's text-search tool, matching
`main|entrypoint|CLI|command`.

## 4. Determinism

Look for:
- Lock files (package-lock.json, yarn.lock, Cargo.lock)
- CI configuration
- Version pinned dependencies

## 5. Observability

Search for logging patterns using your runtime's text-search tool, matching
`log|logger|trace|debug`.

## 6. Testability

Find test files and test configuration.

## 7. Refactorability

Assess module boundaries and dependencies.

## 8. Error Recovery

Search for error handling and recovery patterns using your runtime's text-search tool, matching
`Error|Exception|retry|fallback|recover`, and read representative handlers to assess error types
and recovery paths.

## 9. Incremental Changes

Assess whether small changes can be made safely: module boundaries, targeted test runs, and fast
feedback (tests, type checks, lint) for a single edit.

# Quality Criteria

- Rate all 8 dimensions on the shared 1.0-5.0 scale (`skill://assessment-report-suite` Scoring Scale); derive each letter mechanically from the numeric score — never assign a bare letter
- Cite evidence for each

# Output Location

If the caller supplies an output path or a `REPORT_PREFIX` (e.g. an orchestrating skill such as
`assess-repo`), save the full report there — the caller's path, or
`docs/assessment/<REPORT_PREFIX>-ai-readiness.md` for a `REPORT_PREFIX` (creating
`docs/assessment/` if needed) — and return a summary only (see Return Summary). If neither is
supplied, report the full findings in your response and save them to
`docs/assessment/ai-readiness.md` only if asked.

# Output Format

```markdown
# AI Readiness Analysis

## 8-Dimension Assessment
| Dimension | Score | Evidence |
|-----------|-------|----------|
| Context Efficiency | <1.0-5.0>/<Letter> | ... |
| Refactorability | <1.0-5.0>/<Letter> | ... |
| Testability | <1.0-5.0>/<Letter> | ... |
| Determinism | <1.0-5.0>/<Letter> | ... |
| Observability | <1.0-5.0>/<Letter> | ... |
| Error Recovery | <1.0-5.0>/<Letter> | ... |
| Incremental Changes | <1.0-5.0>/<Letter> | ... |
| Skill Coverage | <1.0-5.0>/<Letter> | ... |

## Documentation
[What exists, what's missing]

| Aspect | Status | Notes |
|--------|--------|-------|
| Documentation | ✓/✗ | ... |
| Type Definitions | ✓/✗ | ... |
| Examples/Tutorials | ✓/✗ | ... |

Documents found:
- README.md: ✓/✗
- docs/: ✓/✗
- SKILL.md: ✓/✗
- AGENTS.md: ✓/✗

## Skill Coverage
| Operation | Available | Implementation |
|-----------|-----------|----------------|
| Build | ✓/✗ | ... |
| Test | ✓/✗ | ... |
| Deploy | ✓/✗ | ... |

## Determinism
| Aspect | Status | Notes |
|--------|--------|-------|
| Reproducible Builds | ✓/✗ | ... |
| Stable CI | ✓/✗ | ... |
| Lock files | ✓/✗ | ... |

## Missing for AI Agents
[What's lacking]

## Key Findings
1. [Strength 1]
2. [Weakness 1]
3. [Opportunity 1]

## Score: <1.0-5.0> / <Letter> (one line rationale; assign the number from evidence first, derive the letter mechanically from `skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter)

## Recommendations
1. [Priority recommendation]
2. [Secondary recommendation]
```

# Return Summary

When the full report was saved to a file, return a summary only (max 5 lines):
- All 8 dimension scores (brief)
- Top 3 gaps
- Score: <1.0-5.0>/<Letter> with one-line rationale (numeric first; letter derived mechanically, never assigned directly)
- Top 2 recommendations
