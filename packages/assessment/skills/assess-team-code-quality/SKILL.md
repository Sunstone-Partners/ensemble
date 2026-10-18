---
name: assess-team-code-quality
description: assess code quality contributions by developer
---

# Soul

Analyze code quality patterns by developer — who writes maintainable code vs technical debt.

**Data Source:** Local git only

# Tool Guidance

**Avoid:** `find ... -exec ...`, `xargs ...`, and other complex shell pipelines; many coding-agent
runtimes restrict these.

**Prefer:** your runtime's dedicated file-discovery, read, and text-search capabilities where
available. Use the shell only for simple `git` commands.

# Analysis Protocol

## Phase 1: Code Quality Indicators

Look for indicators in git history:
- PR/merge sizes (small focused vs large batch)
- Refactoring commits (cleanups, improvements)
- Bug fix patterns (quick fixes vs proper solutions)
- Technical debt introduction vs removal
- TODO/FIXME comment density
- Code review participation

## Phase 2: Author Attribution

Where possible, attribute code patterns:
- Who introduced large files?
- Who creates technical debt (TODO, FIXME comments)?
- Who does cleanup work?
- Who struggles with test coverage?

## Phase 3: Quality Distribution

Assess:
- Consistency of code quality across authors
- Patterns of improvement vs degradation
- Ownership of critical components

# Scoring

Report every score — the dimension score and each per-author score cell — as `<1.0-5.0> / <Letter>`:
assign the number from evidence first, then derive the letter mechanically from
`skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter.

# Reporting Rules

- Cite specific file:line, not summarize
- Use tables over paragraphs; skip common knowledge; no filler prose
- Be specific with numbers: "38 TODO/FIXME added vs 5 removed", not "lots of debt"
- Truncate verbose output: cite 3 examples, state "47 more similar"
- One-line rationale for the score, e.g. "2.6 / C- due to 38 TODO/FIXME added vs 5 removed"
- Data not available from local git: write "No evidence found in local git" (not "N/A"), add
  `[confidence: MEDIUM - requires API to verify]`, and adjust the score accordingly

# Output Format

If the caller supplies an output path or a REPORT_PREFIX, save the full report there (a REPORT_PREFIX
means `docs/assessment/team-<REPORT_PREFIX>-code-quality.md`) and return a summary only; if neither is
supplied, report the full findings in your response and save to `docs/assessment/team-code-quality.md`
only if asked.

```markdown
# Team Assessment: Code Quality

## Author Code Quality Profiles
| Author | Avg PR Size | Refactor % | Technical Debt | Quality Score |
|--------|-------------|------------|----------------|---------------|
| ... | N | X% | Low/Med/High | <1.0-5.0> / <Letter> |

## Quality Distribution
[Analysis of how quality is distributed across team]

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
- Top quality contributor
- Key risk
- Quality distribution insight
- Score: <1.0-5.0>/<Letter> with one-word rationale (numeric first; letter derived mechanically, never assigned directly)
