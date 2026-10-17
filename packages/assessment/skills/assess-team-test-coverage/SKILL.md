---
name: assess-team-test-coverage
description: assess test coverage contributions and patterns by developer
---

# Soul

Analyze test coverage patterns — who writes tests, who doesn't, quality of tests.

**Data Source:** Local git + file discovery

# Tool Guidance

**Avoid:** `find ... -exec ...`, `xargs ...`, and other complex shell pipelines; many coding-agent
runtimes restrict these.

**Prefer:** your runtime's dedicated file-discovery, read, and text-search capabilities where
available. Use the shell only for simple `git` commands.

# Analysis Protocol

## Phase 1: Test Files Discovery

Find test files and their authors via git blame:
- Unit test files
- Integration test files
- E2E test files
- Test coverage reports
- Test file to source file ratios

## Phase 2: Author Attribution

Attribute test contributions:
- Who writes the most tests?
- Who rarely writes tests?
- Who writes quality tests (not just for coverage)?
- Who introduced untested critical paths?

## Phase 3: Coverage Analysis

Assess:
- Test coverage by component/module
- Coverage gaps in critical paths
- Who owns testable vs untestable code?
- Patterns of test avoidance

# Scoring

Report every score — the dimension score and each per-author score cell — as `<1.0-5.0> / <Letter>`:
assign the number from evidence first, then derive the letter mechanically from
`skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter.

# Reporting Rules

- Cite specific file:line, not summarize
- Use tables over paragraphs; skip common knowledge; no filler prose
- Be specific with numbers: "2 of 14 authors own 81% of test lines", not "few people write tests"
- Truncate verbose output: cite 3 examples, state "47 more similar"
- One-line rationale for the score, e.g. "2.3 / D+ due to 2 of 14 authors owning 81% of test lines"
- Data not available from local git: write "No evidence found in local git" (not "N/A"), add
  `[confidence: MEDIUM - requires API to verify]`, and adjust the score accordingly

# Output Format

If the caller supplies an output path or a REPORT_PREFIX, save the full report there (a REPORT_PREFIX
means `docs/assessment/team-<REPORT_PREFIX>-test-coverage.md`) and return a summary only; if neither is
supplied, report the full findings in your response and save to `docs/assessment/team-test-coverage.md`
only if asked.

```markdown
# Team Assessment: Test Coverage

## Test Contribution by Author
| Author | Test Commits | Test Files | Lines Blamed | Score |
|--------|--------------|------------|--------------|-------|
| ... | N | N | N (X%) | <1.0-5.0> / <Letter> |

## Coverage Distribution
[Analysis of coverage across codebase]

## Untested Components
| Component | Risk | Owner |
|-----------|------|-------|
| ... | High/Med/Low | ... |

## Key Findings
1. [Finding with evidence] [confidence: HIGH/MEDIUM/LOW]
2. [Finding with evidence] [confidence: HIGH/MEDIUM/LOW]

## Score: <1.0-5.0> / <Letter> (one line rationale; assign the number from evidence first, derive the letter mechanically from `skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter)

## Recommendations
1. [Priority]
2. [Secondary]
```

# Return Summary

When the full report was saved to a file, return only a summary (max 5 lines):
- Test authorship concentration (top test contributors)
- Coverage gap
- Score: <1.0-5.0>/<Letter> with one-word rationale (numeric first; letter derived mechanically, never assigned directly)
