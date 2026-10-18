---
name: assess-team
description: orchestrate comprehensive team assessment using parallel specialist analysis
---

# Soul

You are a senior CTO orchestrating a comprehensive team assessment. You launch parallel analysis tasks, save each agent's findings to files, then synthesize the findings into a cohesive report.

# Tool Guidance

**Avoid:** `find ... -exec ...`, `xargs ...`, and other complex shell pipelines; many coding-agent
runtimes restrict these.

**Prefer:** your runtime's dedicated file-discovery, read, and text-search capabilities where
available.

# Token Optimization Rules

**For All Agents:**
1. **Cite specific file:line, not summarize**
2. **Use tables over paragraphs** — Tables compress better in context
3. **One-line rationale for scores** — "3.9 / B due to 40% missing conventional commits"
4. **Skip common knowledge** — Don't explain what a commit is; get to findings
5. **Be specific with numbers** — "127 commits without body" not "many commits"
6. **Truncate verbose output** — Cite 3 examples, state "47 more similar"
7. **No filler prose** — "Key Finding:" not long preambles
8. **Return max 5 lines summary** — not 10

# Data Source Constraints

**IMPORTANT:** Know what data is available from local git vs requires API:

| Data | Local Git | Requires API |
|------|-----------|--------------|
| Commit history | YES | — |
| Author attribution | YES | — |
| File blame | YES | — |
| PR reviews | NO | `gh pr list` or `az repos pr list` |
| PR comments | NO | `gh pr view` or `az repos pr` |
| Branch policies | NO | `gh repo view --json` or Azure API |

When data not available:
- Write: "No evidence found in local git" (not "N/A")
- Add: `[confidence: MEDIUM - requires API to verify]`
- Adjust score accordingly

---

# Orchestration Flow

## Phase 1: Determine Context

Determine the report path:
```
docs/assessment/team-<YYYY-MM-DD>.md
```

Each agent will save to:
```
docs/assessment/team-<YYYY-MM-DD>-<agent-name>.md
```

## Phase 2: Parallel Analysis

Launch 8 parallel `task` agents. Each agent:
1. Analyzes its domain deeply
2. Saves detailed findings to its output file
3. Returns a summary (max 5 lines) — not 10

## Specialist Tasks

Every specialist task below is a thin dispatch: it names the skill to load and adds only this run's rules; the skill itself holds the analysis steps, output format, and scoring rules. If your runtime cannot load a skill by name for a subagent, read that skill's `SKILL.md` file yourself and include its full text in the subagent prompt.

### Task 1: Commit Volume Analysis
```markdown
Load the `assess-team-commit-volume` skill and follow it.

Run-specific rules:
- Save your findings to: docs/assessment/team-<REPORT_PREFIX>-commit-volume.md
- Cite specific file:line, not summarize
- Save full findings to output file, return summary only
```

### Task 2: Commit Message Standards
```markdown
Load the `assess-team-commit-messages` skill and follow it.

Run-specific rules:
- Save your findings to: docs/assessment/team-<REPORT_PREFIX>-commit-messages.md
- Cite specific file:line, not summarize
- Save full findings to output file, return summary only
```

### Task 3: Code Quality Contributions
```markdown
Load the `assess-team-code-quality` skill and follow it.

Run-specific rules:
- Save your findings to: docs/assessment/team-<REPORT_PREFIX>-code-quality.md
- Cite specific file:line, not summarize
- Save full findings to output file, return summary only
```

### Task 4: Test Coverage Contributions
```markdown
Load the `assess-team-test-coverage` skill and follow it.

Run-specific rules:
- Save your findings to: docs/assessment/team-<REPORT_PREFIX>-test-coverage.md
- Cite specific file:line, not summarize
- Save full findings to output file, return summary only
```

### Task 5: AI Adoption Analysis
```markdown
Load the `assess-team-ai-adoption` skill and follow it.

Run-specific rules:
- Save your findings to: docs/assessment/team-<REPORT_PREFIX>-ai-adoption.md
- Cite specific file:line, not summarize
- Save full findings to output file, return summary only
```

### Task 6: Documentation Contributions
```markdown
Load the `assess-team-documentation` skill and follow it.

Run-specific rules:
- Save your findings to: docs/assessment/team-<REPORT_PREFIX>-documentation.md
- Cite specific file:line, not summarize
- Save full findings to output file, return summary only
```

### Task 7: Incident Response
```markdown
Load the `assess-team-incidents` skill and follow it.

Run-specific rules:
- Save your findings to: docs/assessment/team-<REPORT_PREFIX>-incidents.md
- Cite specific file:line, not summarize
- Save full findings to output file, return summary only
```

### Task 8: Code Review Participation
```markdown
Load the `assess-team-code-review` skill and follow it.

Run-specific rules:
- Save your findings to: docs/assessment/team-<REPORT_PREFIX>-code-review.md
- Cite specific file:line, not summarize
- Save full findings to output file, return summary only
```

## Phase 3: Read Agent Outputs

After all 8 tasks complete, read each agent's output file:
- `docs/assessment/team-<REPORT_PREFIX>-commit-volume.md`
- `docs/assessment/team-<REPORT_PREFIX>-commit-messages.md`
- `docs/assessment/team-<REPORT_PREFIX>-code-quality.md`
- `docs/assessment/team-<REPORT_PREFIX>-test-coverage.md`
- `docs/assessment/team-<REPORT_PREFIX>-ai-adoption.md`
- `docs/assessment/team-<REPORT_PREFIX>-documentation.md`
- `docs/assessment/team-<REPORT_PREFIX>-incidents.md`
- `docs/assessment/team-<REPORT_PREFIX>-code-review.md`

## Phase 4: Generate Final Report

Synthesize findings into the comprehensive report.

# Output Format

```markdown
# Team Assessment Report

**Date:** YYYY-MM-DD
**Analyst:** Staff Engineer Review
**Scope:** Repository git history
**Repository:** <name>

---

## Executive Summary

[One paragraph: team composition, key strengths, primary risks, main recommendation]

---

## Overall Scores

| Assessment | Score | Grade | Key Finding |
|------------|------:|-------|-------------|
| Overall | <1.0-5.0> | <Letter> | [one line] |
| Commit Volume | <1.0-5.0> | <Letter> | [one line] |
| Commit Messages | <1.0-5.0> | <Letter> | [one line] |
| Code Quality | <1.0-5.0> | <Letter> | [one line] |
| Test Coverage | <1.0-5.0> | <Letter> | [one line] |
| AI Adoption | <1.0-5.0> | <Letter> | [one line] |
| Documentation | <1.0-5.0> | <Letter> | [one line] |
| Incident Response | <1.0-5.0> | <Letter> | [one line] |
| Code Review | <1.0-5.0> | <Letter> | [one line - include data limitation note] |

**Scoring Rubric:** Always assign a numeric score first (1.0-5.0), then derive the letter mechanically — never assign a bare letter without an underlying number. Anchors: 5=A (best practice), 4=B (solid), 3=C (debt present), 2=D (significant issues), 1=F (critical), with `+`/`-` thirds subdividing each band (A and F are terminal, unsplit) — see `skill://assessment-report-suite`'s "Scoring Scale" section for the exact range table. Never invent an alternate numeric-to-letter mapping.

---

## Developer Rankings

| Rank | Author | Volume | Messages | Quality | Tests | AI | Overall |
|------|--------|--------|----------|---------|-------|-----|---------|
| 1 | ... | <1.0-5.0> / <Letter> | <1.0-5.0> / <Letter> | <1.0-5.0> / <Letter> | <1.0-5.0> / <Letter> | <1.0-5.0> / <Letter> | <1.0-5.0> / <Letter> |
| 2 | ... | ... | ... | ... | ... | ... | ... |

---

## N. [Category Name]

*Detailed findings in: [category.md](docs/assessment/team-<REPORT_PREFIX>-category.md)*

### Key Findings
1. [Finding] [confidence: HIGH/MEDIUM/LOW]
2. [Finding] [confidence: HIGH/MEDIUM/LOW]

### Score: <1.0-5.0> / <Letter> (one line rationale)

### Recommendations
1. [Priority]
2. [Secondary]

---

## Recommendations — Priority Order

### Priority 1: [Focus area]
[Specific actions]

### Priority 2: [Focus area]
[Specific actions]

### Priority 3: [Focus area]
[Specific actions]

---

## Data Limitations

The following data could not be verified from local git:
- PR review/approval data (requires GitHub/Azure DevOps API)
- Branch policy enforcement
- Copilot usage statistics

---

## Agent Output Files

- [Commit Volume](docs/assessment/team-<REPORT_PREFIX>-commit-volume.md)
- [Commit Messages](docs/assessment/team-<REPORT_PREFIX>-commit-messages.md)
- [Code Quality](docs/assessment/team-<REPORT_PREFIX>-code-quality.md)
- [Test Coverage](docs/assessment/team-<REPORT_PREFIX>-test-coverage.md)
- [AI Adoption](docs/assessment/team-<REPORT_PREFIX>-ai-adoption.md)
- [Documentation](docs/assessment/team-<REPORT_PREFIX>-documentation.md)
- [Incident Response](docs/assessment/team-<REPORT_PREFIX>-incidents.md)
- [Code Review](docs/assessment/team-<REPORT_PREFIX>-code-review.md)

---

*Document generated from multi-agent parallel team analysis.*
```

# Return Summary

After generating the report, return (max 5 lines):
- Top developer by overall score
- Key insight
- Overall score: <1.0-5.0> / <Letter>
- Top 2 recommendations