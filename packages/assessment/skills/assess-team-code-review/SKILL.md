---
name: assess-team-code-review
description: analyze code review participation and quality by developer
---

# Soul

Analyze code review patterns — who reviews, who doesn't, review quality, turnaround time.

**Data Source:** Local git + file discovery

# Tool Guidance

**Avoid:** `find ... -exec ...`, `xargs ...`, and other complex shell pipelines; many coding-agent
runtimes restrict these.

**Prefer:** your runtime's dedicated file-discovery, read, and text-search capabilities where
available. Use the shell only for simple `git`, `gh`, or `az` commands.

# Critical: Data Source Constraints

**IMPORTANT:** Local git CANNOT verify PR reviews. Git history shows who merged, not who reviewed.

| Data | Local Git | Requires API |
|------|-----------|--------------|
| Who merged | YES | — |
| Who reviewed | NO | `gh pr list`, `az repos pr list` |
| Approval status | NO | GitHub/GitLab API |
| Review comments | NO | API |

To get review data, run `gh pr list --state merged` or `az repos pr list`.

When data not available:
- Write: "No evidence found in local git" (not "N/A")
- Add: `[confidence: MEDIUM - requires API to verify]`
- If review data cannot be obtained at all (tools unavailable or not authenticated), cap the numeric score
  at 2.0 (grade D) — go lower only if the data that IS verifiable is itself worse — and note
  "Cannot verify peer review from local git"

# Analysis Protocol

## Phase 1: Gather What Local Git Shows

Analyze:
- Merged PR commits (who merged, how many)
- Co-authored commits (indicate collaboration)
- Review participation rate (if verifiable)

Use `bash` git commands (simple patterns only):
```bash
git log --merges --format="%ae|%ae" -n 100  # merged PRs
git shortlog -sne HEAD  # author commit counts
```

## Phase 2: Document Limitations

Always include a "Data Availability" section noting what requires API access.

## Phase 3: Attribution

Score authors on what can be verified:
- Merge ownership (who completes PRs)
- Co-authored commits (Co-Authored-By: indicates collaboration)

# Scoring

Report every score — the dimension score and each per-author score cell — as `<1.0-5.0> / <Letter>`:
assign the number from evidence first, then derive the letter mechanically from
`skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter.

# Reporting Rules

- Cite specific file:line, not summarize
- Use tables over paragraphs; skip common knowledge; no filler prose
- Be specific with numbers: "9 of 12 merges by one author", not "merges are concentrated"
- Truncate verbose output: cite 3 examples, state "47 more similar"
- One-line rationale for the score, e.g. "2.0 / D due to no verifiable peer-review data"

# Output Format

If the caller supplies an output path or a REPORT_PREFIX, save the full report there (a REPORT_PREFIX
means `docs/assessment/team-<REPORT_PREFIX>-code-review.md`) and return a summary only; if neither is
supplied, report the full findings in your response and save to `docs/assessment/team-code-review.md`
only if asked.

```markdown
# Team Assessment: Code Review

## Data Availability
- PR review data: **NOT available from local git** [confidence: LOW - requires API]
- Review approval data: **NOT available from local git** [confidence: LOW - requires API]
- To get full data: run `gh pr list --state merged --limit 100` or `az repos pr list`

## Review Participation (local git only)
| Author | Merges | Co-authored | Participation Rate | Score |
|--------|--------|-------------|---------------------|-------|
| ... | N | N | X% | <1.0-5.0> / <Letter> |

## Review Distribution
[Analysis of review load distribution from available data]

## Key Findings
1. [Finding with evidence] [confidence: HIGH/MEDIUM/LOW]
2. [Finding with evidence] [confidence: HIGH/MEDIUM/LOW]

## Score: <1.0-5.0> / <Letter> (one line rationale; assign the number from evidence first, derive the letter mechanically from `skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter)

## Recommendations
1. Run `gh pr list --state merged --limit 100` for full review data
2. [Priority]
```

# Return Summary

When the full report was saved to a file, return only a summary (max 5 lines):
- Merge concentration insight
- Data limitation warning
- Score: <1.0-5.0>/<Letter> with one-word rationale (numeric first; letter derived mechanically, never assigned directly)
- One recommendation
