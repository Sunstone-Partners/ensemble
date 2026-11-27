---
name: assess-repo
description: orchestrate comprehensive repository assessment using parallel specialist analysis
---

# Role

Orchestrate a repository assessment: launch parallel specialist tasks, save each task's findings to files, then synthesize one report that references the outputs.

# Tool Guidance

Avoid `find ... -exec ...`, `xargs ...`, `wc -l | sort | head` and other complex shell pipelines (many runtimes restrict them); prefer dedicated file-discovery, read, structural-search, text-search and code-intelligence tools.

# Data Source Constraints

**IMPORTANT:** Know what data is available from local git vs requires API:

| Data | Local Git | Requires API |
|------|-----------|--------------|
| Code files | YES | — |
| Config files | YES | — |
| Test files | YES | — |
| CI/CD configs | YES | — |
| Coverage reports | NO | Run with coverage tool |
| Dependency graph | NO | `deptrac` or similar |

When data not available:
- Write: "No evidence found in local git" 
- Add: `[confidence: MEDIUM - requires tooling to verify]`
- Adjust score accordingly

---

# Token Optimization

Specialist reports: cite `file:line` and specific numbers, use tables, one-line score rationales, cap repeated patterns at 3 examples plus "N more similar", no filler.

# Orchestration Flow

## Phase 1: Create Assessment Directory

First, determine the report path:
```
docs/assessment/<repo-name>-<YYYY-MM-DD>.md
```

Each agent will also save its detailed findings to:
```
docs/assessment/<repo-name>-<YYYY-MM-DD>-<agent-name>.md
```

Check if `docs/assessment/` exists. Create it if needed.

## Phase 2: Purpose Analysis (First Agent)

Launch a `task` agent FIRST to run the `assess-purpose` skill and establish context for all other agents.

Every specialist task (here and in Phase 3) is a thin dispatch: it names the skill to load and adds only this run's rules; the skill itself holds the analysis steps, output format, and scoring rules. If your runtime cannot load a skill by name for a subagent, read that skill's `SKILL.md` file yourself and include its full text in the subagent prompt.

```markdown
Load the `assess-purpose` skill and follow it.

Run-specific rules:
- Save your findings to: docs/assessment/<REPORT_PREFIX>-purpose.md
- Cite specific file:line for evidence
- Save full findings to output file, return summary only
```

## Phase 3: Parallel Analysis

Launch 7 parallel `task` agents (see Specialist Tasks); each saves detailed findings to its output file and returns a summary only. Pass this context to all tasks:
```
REPO_ROOT: {cwd}
SCOPE: src/, tests/, configs/, docs/
TIMESTAMP: {current date}
BRANCH: {current branch}
COMMIT: {first 7 chars of HEAD}
OUTPUT_DIR: docs/assessment
REPORT_PREFIX: <repo-name>-<YYYY-MM-DD>
```
## Specialist Tasks
### Task 1: Architecture Analysis
```markdown
Load the `assess-architect` skill and follow it.

Run-specific rules:
- Save your detailed findings to: docs/assessment/<REPORT_PREFIX>-architecture.md
- Cite specific file:line for every finding
- Save full findings to output file, return summary only
```

### Task 2: Code Quality Analysis
```markdown
Load the `assess-code-quality` skill and follow it.

Run-specific rules:
- Save your detailed findings to: docs/assessment/<REPORT_PREFIX>-code-quality.md
- Cite specific file:line for every finding
- Save full findings to output file, return summary only
```

### Task 3: Testing Analysis
```markdown
Load the `assess-testing` skill and follow it.

Run-specific rules:
- Save your detailed findings to: docs/assessment/<REPORT_PREFIX>-testing.md
- Cite specific file:line for findings
- Save full findings to output file, return summary only
```

### Task 4: Security Analysis
```markdown
Load the `assess-security` skill and follow it.

Run-specific rules:
- Save your detailed findings to: docs/assessment/<REPORT_PREFIX>-security.md
- NEVER output actual secrets — report presence only
- Cite specific file:line for findings
- Save full findings to output file, return summary only
```

### Task 5: AI Readiness Analysis
```markdown
Load the `assess-ai-readiness` skill and follow it.

Run-specific rules:
- Save your detailed findings to: docs/assessment/<REPORT_PREFIX>-ai-readiness.md
- Cite specific file:line evidence for each dimension
- Save full findings to output file, return summary only
```

### Task 6: CI/CD Analysis
```markdown
Load the `assess-cicd` skill and follow it.

Run-specific rules:
- Save your detailed findings to: docs/assessment/<REPORT_PREFIX>-cicd.md
- Cite specific file:line for findings
- Save full findings to output file, return summary only
```

## Phase 3: Read Agent Outputs
After all 7 tasks complete, read each agent's output file:
- `docs/assessment/<REPORT_PREFIX>-purpose.md`
- `docs/assessment/<REPORT_PREFIX>-architecture.md`
- `docs/assessment/<REPORT_PREFIX>-code-quality.md`
- `docs/assessment/<REPORT_PREFIX>-testing.md`
- `docs/assessment/<REPORT_PREFIX>-security.md`
- `docs/assessment/<REPORT_PREFIX>-ai-readiness.md`
- `docs/assessment/<REPORT_PREFIX>-cicd.md`

## Phase 4: Generate Final Report

Generate the comprehensive report that references agent outputs.

# Output Format

```markdown
# Repository Assessment Report

**Date:** YYYY-MM-DD
**Analyst:** Staff Engineer Review
**Scope:** src/, tests/, configs/
**Repository:** <name>
**Branch:** <branch>
**Commit:** <hash>
**Agent Outputs:** See docs/assessment/

---

## Executive Summary

[One paragraph: what the project does, key strengths, primary risks, main recommendation]

---

## Overall Scores

| Assessment | Score | Grade |
|------------|------:|-------|
| Overall | <1.0-5.0> | <Letter> |
| AI Readiness | <1.0-5.0> | <Letter> |

**Scoring:** numeric first (1.0-5.0), letter derived per the Scoring Scale in `skill://assessment-report-suite`; never a bare letter or an alternate mapping.

---

## Findings Summary

| Category | Score | Key Issues | Recommendation |
|----------|-------|------------|----------------|
| Architecture | <1.0-5.0>/<Letter> | 2-3 issues | 1-2 sentences |
| Code Quality | <1.0-5.0>/<Letter> | 2-3 issues | 1-2 sentences |
| Error Handling | <1.0-5.0>/<Letter> | 2-3 issues | 1-2 sentences |
| Observability | <1.0-5.0>/<Letter> | 2-3 issues | 1-2 sentences |
| Dependencies | <1.0-5.0>/<Letter> | 2-3 issues | 1-2 sentences |
| Scalability | <1.0-5.0>/<Letter> | 2-3 issues | 1-2 sentences |
| Testing | <1.0-5.0>/<Letter> | 2-3 issues | 1-2 sentences |
| CI/CD | <1.0-5.0>/<Letter> | 2-3 issues | 1-2 sentences |
| Security | <1.0-5.0>/<Letter> | 2-3 issues | 1-2 sentences |
| AI Readiness | <1.0-5.0>/<Letter> | 2-3 issues | 1-2 sentences |

---

## 1. Purpose Analysis

### Tech Stack
| Aspect | Finding |
|--------|---------|
| Language(s) | ... |
| Ecosystem | ... |
| Build Tool | ... |

### Inferred Purpose
Primary Function: [one sentence]
Domain: [Healthcare/Finance/DevOps/etc.]
Target Users: [Developers/End Users/Admins/etc.]

### Key Capabilities
1. ...
2. ...
3. ...

### Confidence Assessment
| Aspect | Level | Notes |
|--------|-------|-------|
| Purpose | HIGH/MEDIUM/LOW | ... |
| Domain | HIGH/MEDIUM/LOW | ... |
| Users | HIGH/MEDIUM/LOW | ... |

### Score: <1.0-5.0> / <Letter>

### Recommendations
1. Add [doc] to clarify [aspect]
2. Add [doc] to clarify [aspect]

---

## 2. Architecture Analysis
---

## 2. Code Quality Assessment

*Detailed findings available in: [code-quality.md](docs/assessment/<REPORT_PREFIX>-code-quality.md)*

[Summarize — largest files table, technical debt table]

### Largest Files
| File | Lines | Concern |
|------|-------|---------|
| ... | ... | ... |

### Technical Debt
| Type | Count | Severity |
|------|-------|----------|
| TODO | N | Medium |
| FIXME | N | High |

### Key Findings
1. [Finding with file:line reference]
2. [Finding with file:line reference]

### Score: <1.0-5.0> / <Letter>

### Recommendations
1. [Priority]
2. [Secondary]

---

## 3. Error Handling Assessment

[Summarize error handling patterns]

### Key Findings
1. [Finding with file:line reference]
2. [Finding with file:line reference]

### Score: <1.0-5.0> / <Letter>

### Recommendations
1. [Priority]

---

## 4. Logging and Observability

[Summarize logging and monitoring]

### Key Findings
1. [Finding]
2. [Finding]

### Score: <1.0-5.0> / <Letter>

### Recommendations
1. [Priority]

---

## 5. Dependency Analysis

[Summarize dependencies — table with version, age, concern]

| Package | Version | Age | Concern |
|---------|---------|-----|---------|
| ... | ... | ... | ... |

### Key Findings
1. [Finding]
2. [Finding]

### Score: <1.0-5.0> / <Letter>

### Recommendations
1. [Priority]

---

## 6. Scalability Assessment

[Summarize scalability constraints]

### Key Findings
1. [Finding with file:line reference]
2. [Finding with file:line reference]

### Score: <1.0-5.0> / <Letter>

### Recommendations
1. [Priority]

---

## 7. Testing Assessment

*Detailed findings available in: [testing.md](docs/assessment/<REPORT_PREFIX>-testing.md)*

[Summarize]

| Project | Framework | Type | Coverage | Quality |
|---------|-----------|------|----------|---------|
| ... | ... | ... | ... | ... |

### Key Findings
1. [Finding]
2. [Finding]

### Score: <1.0-5.0> / <Letter>

### Recommendations
1. [Priority]
2. [Secondary]

---

## 8. CI/CD Assessment

*Detailed findings available in: [cicd.md](docs/assessment/<REPORT_PREFIX>-cicd.md)*

[Summarize]

### Pipeline Stages
| Stage | Duration | Quality |
|-------|----------|---------|
| ... | ... | ... |

### Key Findings
1. [Finding]
2. [Finding]

### Score: <1.0-5.0> / <Letter>

### Recommendations
1. [Priority]
2. [Secondary]

---

## 9. Security Assessment

*Detailed findings available in: [security.md](docs/assessment/<REPORT_PREFIX>-security.md)*

[Summarize]

### Key Findings
| Finding | Severity |
|---------|----------|
| [Finding 1] | HIGH/MEDIUM/LOW |
| [Finding 2] | HIGH/MEDIUM/LOW |

### Score: <1.0-5.0> / <Letter>

### Recommendations
1. [Priority]
2. [Secondary]

---

## 10. AI Readiness Assessment

*Detailed findings available in: [ai-readiness.md](docs/assessment/<REPORT_PREFIX>-ai-readiness.md)*

[Summarize all 8 dimensions]

| Dimension | Score | Notes |
|-----------|-------|-------|
| Context Efficiency | <1.0-5.0>/<Letter> | ... |
| Refactorability | <1.0-5.0>/<Letter> | ... |
| Testability | <1.0-5.0>/<Letter> | ... |
| Determinism | <1.0-5.0>/<Letter> | ... |
| Observability | <1.0-5.0>/<Letter> | ... |
| Error Recovery | <1.0-5.0>/<Letter> | ... |
| Incremental Changes | <1.0-5.0>/<Letter> | ... |
| Skill Coverage | <1.0-5.0>/<Letter> | ... |

### Key Findings
1. [Finding]
2. [Finding]

### Score: <1.0-5.0> / <Letter>

### Recommendations
1. [Priority]
2. [Secondary]

---

## Recommendations — Priority Order

### Priority 1: Reduce MTTR
[Consolidated from all agents]

### Priority 2: Improve Maintainability

### Priority 3: Enable Feature Velocity

### Priority 4: Scalability

### Priority 5: Observability

---

## Risk Matrix

| Risk | Severity | Impact | Effort | Owner |
|------|----------|--------|--------|-------|
| ... | ... | ... | ... | ... |

---

## Appendix: Quick Wins

| Issue | Fix | Effort |
|-------|-----|--------|
| ... | ... | ... |

---

## Next Steps

1. [Action 1]
2. [Action 2]
3. [Action 3]
4. [Action 4]

---

## Agent Output Files

- [Purpose Analysis](docs/assessment/<REPORT_PREFIX>-purpose.md)
- [Architecture Analysis](docs/assessment/<REPORT_PREFIX>-architecture.md)
- [Code Quality Analysis](docs/assessment/<REPORT_PREFIX>-code-quality.md)
- [Testing Analysis](docs/assessment/<REPORT_PREFIX>-testing.md)
- [Security Analysis](docs/assessment/<REPORT_PREFIX>-security.md)
- [AI Readiness Analysis](docs/assessment/<REPORT_PREFIX>-ai-readiness.md)
- [CI/CD Analysis](docs/assessment/<REPORT_PREFIX>-cicd.md)

---

*Document generated from multi-agent parallel analysis.*
