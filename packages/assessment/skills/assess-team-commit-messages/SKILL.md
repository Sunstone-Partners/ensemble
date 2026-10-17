---
name: assess-team-commit-messages
description: analyze commit message quality and standards compliance
---

# Soul

Analyze commit messages to assess adherence to standards, clarity, and documentation quality.

**Data Source:** Local git only

# Tool Guidance

**Avoid:** `find ... -exec ...`, `xargs ...`, and other complex shell pipelines; many coding-agent
runtimes restrict these.

**Prefer:** your runtime's dedicated file-discovery, read, and text-search capabilities where
available. Use the shell only for simple `git` commands.

# Analysis Protocol

## Phase 1: Sample Commit Messages

Sample 50-100 commits across multiple authors. Look for:
- Conventional commit format usage (feat:, fix:, docs:, etc.)
- Subject line length compliance (50-72 chars)
- Body explanation for complex changes
- Issue/ticket references
- Breaking change markers

## Phase 2: Categorize Message Quality

Classify each sampled commit:
- **Excellent**: Conventional format + body explanation + context
- **Good**: Conventional format or clear subject line
- **Acceptable**: Brief but descriptive
- **Poor**: "fix", "update", "WIP", "asdf", single char, empty

## Phase 3: Author Scoring

Score each author:
- % of commits following conventions
- Average message quality
- Improvement trends over time

# Scoring

Report every score — the dimension score and each per-author score cell — as `<1.0-5.0> / <Letter>`:
assign the number from evidence first, then derive the letter mechanically from
`skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter.

# Reporting Rules

- Cite specific file:line, not summarize
- Use tables over paragraphs; skip common knowledge; no filler prose
- Be specific with numbers: "127 commits without body", not "many"
- Truncate verbose output: cite 3 examples, state "47 more similar"
- One-line rationale for the score, e.g. "3.9 / B due to 40% missing conventional commits"
- Data not available from local git: write "No evidence found in local git" (not "N/A"), add
  `[confidence: MEDIUM - requires API to verify]`, and adjust the score accordingly

# Output Format

If the caller supplies an output path or a REPORT_PREFIX, save the full report there (a REPORT_PREFIX
means `docs/assessment/team-<REPORT_PREFIX>-commit-messages.md`) and return a summary only; if neither
is supplied, report the full findings in your response and save to
`docs/assessment/team-commit-messages.md` only if asked.

```markdown
# Team Assessment: Commit Message Standards

## Convention Adoption
| Author | Conventional % | Quality Score |
|--------|---------------|---------------|
| ... | X% | <1.0-5.0> / <Letter> |

## Message Quality Distribution
| Quality | Count | % |
|---------|-------|---|
| Excellent | N | X% |
| Good | N | X% |
| Acceptable | N | X% |
| Poor | N | X% |

## Common Issues
1. [Issue with 3 examples, "47 more similar"]
2. [Issue with 3 examples, "12 more similar"]

## Score: <1.0-5.0> / <Letter> (one line rationale; assign the number from evidence first, derive the letter mechanically from `skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter)

## Recommendations
1. [Priority]
2. [Secondary]
```

# Return Summary

When the full report was saved to a file, return only a summary (max 5 lines):
- % following conventional commits
- Top issue pattern
- Score: <1.0-5.0>/<Letter> with one-word rationale (numeric first; letter derived mechanically, never assigned directly)
