---
name: assess-team-commit-volume
description: analyze git commit volume and patterns by developer
---

# Soul

Analyze git history to assess commit volume, frequency patterns, and activity distribution across developers.

**Data Source:** Local git only

# Tool Guidance

**Avoid:** `find ... -exec ...`, `xargs ...`, and other complex shell pipelines; many coding-agent
runtimes restrict these.

**Prefer:** your runtime's dedicated file-discovery, read, and text-search capabilities where
available. Use the shell only for simple `git` commands.

# Analysis Protocol

## Phase 1: Gather Commit Stats

Use `git log`/`git shortlog` (via shell) to get commit data. Focus on:
- Total commits per author
- Commits per time period (month/week)
- Activity distribution (who does the most work?)
- PR/merge patterns

## Phase 2: Identify Top Contributors

Rank developers by commit volume. Note:
- Core contributors (high volume)
- Occasional contributors (low volume)
- Disappeared contributors (stopped contributing)

## Phase 3: Activity Patterns

Analyze:
- Commit frequency trends
- Batching patterns (many commits in short bursts vs steady flow)
- Timezone hints from commit times
- Weekend vs weekday patterns

# Scoring

Report every score as `<1.0-5.0> / <Letter>`: assign the number from evidence first, then derive the
letter mechanically from `skill://assessment-report-suite`'s Scoring Scale — never assign a bare
letter.

# Reporting Rules

- Cite specific file:line, not summarize
- Use tables over paragraphs; skip common knowledge; no filler prose
- Be specific with numbers: "62% of commits from one author", not "most commits"
- Truncate verbose output: cite 3 examples, state "47 more similar"
- One-line rationale for the score, e.g. "3.2 / C+ due to 62% of commits from one author"
- Data not available from local git: write "No evidence found in local git" (not "N/A"), add
  `[confidence: MEDIUM - requires API to verify]`, and adjust the score accordingly

# Output Format

If the caller supplies an output path or a REPORT_PREFIX, save the full report there (a REPORT_PREFIX
means `docs/assessment/team-<REPORT_PREFIX>-commit-volume.md`) and return a summary only; if neither is
supplied, report the full findings in your response and save to `docs/assessment/team-commit-volume.md`
only if asked.

```markdown
# Team Assessment: Commit Volume

## Top Contributors by Commit Count
| Rank | Author | Commits | % of Total |
|------|--------|---------|------------|
| 1 | ... | N | X% |
| 2 | ... | N | X% |

## Activity Distribution
[Chart or description of how commits are distributed]

## Key Findings
1. [Finding] [confidence: HIGH/MEDIUM/LOW]
2. [Finding] [confidence: HIGH/MEDIUM/LOW]

## Score: <1.0-5.0> / <Letter> (one line rationale; assign the number from evidence first, derive the letter mechanically from `skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter)

## Recommendations
1. [Priority]
2. [Secondary]
```

# Return Summary

When the full report was saved to a file, return only a summary (max 5 lines):
- Top 2 contributors by volume
- Key insight (activity distribution)
- Score: <1.0-5.0>/<Letter> with one-word rationale (numeric first; letter derived mechanically, never assigned directly)
