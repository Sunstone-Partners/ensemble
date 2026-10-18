---
name: assess-team-incidents
description: analyze incident response patterns and production contributions by developer
---

# Soul

Analyze incident response patterns — who handles production issues, MTTR, hotfix frequency, production ownership.

**Data Source:** Local git only

# Tool Guidance

**Avoid:** `find ... -exec ...`, `xargs ...`, and other complex shell pipelines; many coding-agent
runtimes restrict these.

**Prefer:** your runtime's dedicated file-discovery, read, and text-search capabilities where
available. Use the shell only for simple `git` commands.

# Analysis Protocol

## Phase 1: Incident Detection

Find incident-related commits:
- Hotfix branches and emergency merges
- Emergency releases (tagged as hotfix, emergency, patch)
- Production-related commits (mentioning prod, production, hotfix, emergency, incident)
- Quick turnarounds (commits merged within hours of creation)

## Phase 2: Author Attribution

Attribute incident work:
- Who does hotfixes?
- Who merges emergency PRs?
- Who touches production configs?
- Time-to-merge for critical fixes

## Phase 3: Response Analysis

Assess:
- MTTR (Mean Time To Recovery) patterns — local git only yields a proxy (time to merge)
- Hotfix frequency by author
- Production ownership concentration
- Quality of emergency fixes (quick fix vs proper fix)

# Scoring

Report every score — the dimension score and each per-author score cell — as `<1.0-5.0> / <Letter>`:
assign the number from evidence first, then derive the letter mechanically from
`skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter.

# Reporting Rules

- Cite specific file:line, not summarize
- Use tables over paragraphs; skip common knowledge; no filler prose
- Be specific with numbers: "11 of 14 hotfixes merged by one author", not "mostly one person"
- Truncate verbose output: cite 3 examples, state "47 more similar"
- One-line rationale for the score, e.g. "2.6 / C- due to 11 of 14 hotfixes merged by one author"
- Data not available from local git: write "No evidence found in local git" (not "N/A"), add
  `[confidence: MEDIUM - requires API to verify]`, and adjust the score accordingly

# Output Format

If the caller supplies an output path or a REPORT_PREFIX, save the full report there (a REPORT_PREFIX
means `docs/assessment/team-<REPORT_PREFIX>-incidents.md`) and return a summary only; if neither is
supplied, report the full findings in your response and save to `docs/assessment/team-incidents.md`
only if asked.

```markdown
# Team Assessment: Incident Response

## Incident Contributions by Author
| Author | Hotfixes | Emergency Merges | Prod Config Changes | Score |
|--------|----------|------------------|---------------------|-------|
| ... | N | N | N | <1.0-5.0> / <Letter> |

## MTTR Distribution (proxy)
| Author | Avg Time to Merge | Quick Fix % | Quality Score |
|--------|-------------------|-------------|---------------|
| ... | X hours | X% | <1.0-5.0> / <Letter> |

## Production Ownership
[Who owns production code? Concentration risk?]

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
- Top incident responder
- MTTR insight (proxy)
- Production ownership concentration
- Score: <1.0-5.0>/<Letter> with one-word rationale (numeric first; letter derived mechanically, never assigned directly)
