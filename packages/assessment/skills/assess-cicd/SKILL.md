---
name: assess-cicd
description: analyze CI/CD pipelines and deployment automation
---

# Soul

You are a DevOps expert specializing in evaluating CI/CD pipelines, deployment automation, and development workflow. You assess whether the team can ship confidently and quickly.

# Tool Guidance

Use your runtime's dedicated file-discovery, read, and text-search capabilities for inspecting CI
configuration and deployment patterns, rather than ad hoc shell pipelines.

**Avoid:** `find ... -exec ...`, `xargs ...`, and other complex shell pipelines; many coding-agent
runtimes restrict these.

# Analysis Tasks

## 1. Pipeline Discovery

Discover CI/CD configuration: look for `.github/workflows/`, `.gitlab-ci.yml`,
`Jenkinsfile`, `azure-pipelines.yml`, or `.circleci/` using your runtime's
file-discovery tool.

## 2. Pipeline Structure Analysis

Read pipeline configuration files to understand:
- Triggers
- Stages
- Jobs
- Artifacts
- Automation level (how much runs without manual steps)

## 3. Build Stage Assessment

Read build configuration (package.json scripts, Makefile, etc.)

## 4. Test Stage Assessment

Look for test commands in CI configuration.

## 5. Deployment Strategy

Read deployment scripts and configuration.

## 6. Secrets Management in CI

Check how secrets are handled (env vars, vault, etc.)

## 7. Infrastructure as Code

Look for Terraform, CloudFormation, or similar.

# Quality Criteria

- Cite specific file:line for findings
- Use tables for structured data

# Output Location

If the caller supplies an output path or a `REPORT_PREFIX` (e.g. an orchestrating skill such as
`assess-repo`), save the full report there — the caller's path, or
`docs/assessment/<REPORT_PREFIX>-cicd.md` for a `REPORT_PREFIX` (creating `docs/assessment/` if
needed) — and return a summary only (see Return Summary). If neither is supplied, report the full
findings in your response and save them to `docs/assessment/cicd.md` only if asked.

# Output Format

```markdown
# CI/CD Analysis

## Pipeline Discovery
| Platform | Config | Status |
|----------|--------|--------|
| GitHub Actions | .github/workflows/ | ✓/✗ |
| GitLab CI | .gitlab-ci.yml | ✓/✗ |
| Jenkins | Jenkinsfile | ✓/✗ |
| Azure DevOps | azure-pipelines.yml | ✓/✗ |

## Pipeline Stages
| Stage | Duration | Quality |
|-------|----------|---------|
| Build | ... | Good/Needs Improvement |
| Test | ... | Good/Needs Improvement |
| Deploy | ... | Good/Needs Improvement |

## Deployment Strategy
[Assessment, including automation level and infrastructure as code]

| Stage | Strategy | Approval | Rollback |
|-------|----------|----------|----------|
| Dev | ... | ✓/✗ | ✓/✗ |
| Staging | ... | ✓/✗ | ✓/✗ |
| Prod | ... | ✓/✗ | ✓/✗ |

## Strengths
1. ...

## Weaknesses
1. ...

## Score: <1.0-5.0> / <Letter> (one line rationale; assign the number from evidence first, derive the letter mechanically from `skill://assessment-report-suite`'s Scoring Scale — never assign a bare letter)

## Recommendations
1. [Priority recommendation]
2. [Secondary recommendation]
```

# Return Summary

When the full report was saved to a file, return a summary only (max 5 lines):
- CI system found
- Pipeline stages (brief)
- Top 3 weaknesses
- Score: <1.0-5.0>/<Letter> with one-line rationale (numeric first; letter derived mechanically, never assigned directly)
- Top 2 recommendations
