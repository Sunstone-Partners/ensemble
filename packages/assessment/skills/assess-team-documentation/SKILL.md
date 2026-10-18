---
name: assess-team-documentation
description: analyze documentation contributions and patterns by developer
---

# Soul

Analyze documentation contributions — who writes docs, who doesn't, quality of documentation.

**Data Source:** Local git + file discovery

# Tool Guidance

**Avoid:** `find ... -exec ...`, `xargs ...`, and other complex shell pipelines; many coding-agent
runtimes restrict these.

**Prefer:** your runtime's dedicated file-discovery, read, and text-search capabilities where
available. Use the shell only for simple `git` commands.

# Analysis Protocol

## Phase 1: Documentation Discovery

Find documentation files and their changes (`.md`, `docs/`, `README*`):
- `.md` files in root and docs/ directories
- README files
- API documentation
- Architecture decision records (ADRs)
- Runbooks and guides

## Phase 2: Author Attribution

Attribute documentation work:
- Git blame on doc files
- Commits touching docs/ directories
- README updates
- Wiki contributions (if applicable)

## Phase 3: Documentation Quality

Assess:
- Completeness (does it actually explain things?)
- Currency (when last updated?)
- Clarity (clear structure, examples?)
- Coverage (what's documented vs not; are key areas documented?)

# Scoring

Report every score as `<1.0-5.0> / <Letter>`: assign the number from evidence first, then derive the
letter mechanically from `skill://assessment-report-suite`'s Scoring Scale — never assign a bare
letter.

# Reporting Rules

- Cite specific file:line, not summarize
- Use tables over paragraphs; skip common knowledge; no filler prose
- Be specific with numbers: "6 of 9 services have no README", not "docs are sparse"
- Truncate verbose output: cite 3 examples, state "47 more similar"
- One-line rationale for the score, e.g. "2.6 / C- due to 6 of 9 services having no README"
- Data not available from local git: write "No evidence found in local git" (not "N/A"), add
  `[confidence: MEDIUM - requires API to verify]`, and adjust the score accordingly

# Output Format

If the caller supplies an output path or a REPORT_PREFIX, save the full report there (a REPORT_PREFIX
means `docs/assessment/team-<REPORT_PREFIX>-documentation.md`) and return a summary only; if neither is
supplied, report the full findings in your response and save to `docs/assessment/team-documentation.md`
only if asked.

```markdown
# Team Assessment: Documentation

## Documentation Contributions
| Author | Doc Commits | Files Created | Files Updated |
|--------|-------------|---------------|---------------|
| ... | N | N | N |

## Documentation Coverage
| Area | Documented | Last Updated |
|------|-----------|-------------|
| ... | Yes/No | date |

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
- Top doc contributor
- Coverage gap
- Score: <1.0-5.0>/<Letter> with one-word rationale (numeric first; letter derived mechanically, never assigned directly)
