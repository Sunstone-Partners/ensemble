---
name: assess-team
description: orchestrate comprehensive team assessment using parallel specialist analysis
---

# Role

Orchestrate a team assessment: launch parallel specialist tasks, save each task's findings to files, then synthesize one report.

# Tool Guidance

Avoid `find ... -exec ...`, `xargs ...` and other complex shell pipelines (many runtimes restrict them); prefer dedicated file-discovery, read and text-search tools.

# Privacy and Use Guard

Report team-level aggregates by default. Individual (per-author) results only on explicit request, only for authors with at least 10 commits in scope (group the rest as "others"). Git signals are partial proxies: never present them as a performance rating or use them for HR decisions. There is no per-developer ranking, and no commit-volume or incident dimension: volume rewards activity not value, and local git has no incident data.

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

Final report: `docs/assessment/team-<YYYY-MM-DD>.md`. Each task saves to `docs/assessment/team-<REPORT_PREFIX>-<dimension>.md`.

## Phase 2: Parallel Analysis

Launch one parallel `task` per dimension below (6 tasks). Each is a thin dispatch: it loads the `assess-team-dimension` skill, which holds the probes, output format and scoring rules. If your runtime cannot load a skill by name for a subagent, read that skill's `SKILL.md` yourself and include its full text in the subagent prompt.

| Dimension | Output file |
|-----------|-------------|
| `commit-messages` | `docs/assessment/team-<REPORT_PREFIX>-commit-messages.md` |
| `code-quality` | `docs/assessment/team-<REPORT_PREFIX>-code-quality.md` |
| `test-coverage` | `docs/assessment/team-<REPORT_PREFIX>-test-coverage.md` |
| `ai-adoption` | `docs/assessment/team-<REPORT_PREFIX>-ai-adoption.md` |
| `documentation` | `docs/assessment/team-<REPORT_PREFIX>-documentation.md` |
| `code-review` | `docs/assessment/team-<REPORT_PREFIX>-code-review.md` |

```markdown
Load the `assess-team-dimension` skill and follow it.

Run-specific rules:
- Dimension: <dimension from the table>
- Save your findings to: <output file from the table>
- Save full findings to output file, return summary only
```

## Phase 3: Read Agent Outputs

After all 6 tasks complete, read each output file in the table.

## Phase 4: Generate Final Report

Synthesize findings into the report below.

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
| Commit Messages | <1.0-5.0> | <Letter> | [one line] |
| Code Quality | <1.0-5.0> | <Letter> | [one line] |
| Test Coverage | <1.0-5.0> | <Letter> | [one line] |
| AI Adoption | <1.0-5.0> | <Letter> | [one line] |
| Documentation | <1.0-5.0> | <Letter> | [one line] |
| Code Review | <1.0-5.0> | <Letter> | [one line - include data limitation note] |

**Scoring:** numeric first (1.0-5.0), letter derived per the Scoring Scale in `skill://assessment-report-suite`; never a bare letter or an alternate mapping.

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
- Incident response (not assessed: no data source in local git)

---

## Agent Output Files

- [Commit Messages](docs/assessment/team-<REPORT_PREFIX>-commit-messages.md)
- [Code Quality](docs/assessment/team-<REPORT_PREFIX>-code-quality.md)
- [Test Coverage](docs/assessment/team-<REPORT_PREFIX>-test-coverage.md)
- [AI Adoption](docs/assessment/team-<REPORT_PREFIX>-ai-adoption.md)
- [Documentation](docs/assessment/team-<REPORT_PREFIX>-documentation.md)
- [Code Review](docs/assessment/team-<REPORT_PREFIX>-code-review.md)

---

*Document generated from multi-agent parallel team analysis.*
```

# Return Summary

After generating the report, return (max 5 lines):
- Strongest and weakest dimension
- Key insight
- Overall score: <1.0-5.0> / <Letter>
- Top 2 recommendations