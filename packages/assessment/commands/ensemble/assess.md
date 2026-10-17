---
name: "ensemble:assess"
description: "Dispatch to a repository, team, config, or report assessment by keyword; repo --only <dimension> runs a single dimension"
version: "1.0.0"
category: "analysis"
last-updated: "2026-10-17"
argument-hint: "<repo|team|config|report> [--only <dimension>] [args...]"
---
<!-- DO NOT EDIT - Generated from assess.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Single entry point for the ensemble-assessment skills. The first argument keyword
(repo, team, config, report) loads the matching assessment skill by name and follows
it; `repo --only <dimension>` runs one repository dimension through its leaf skill
instead of the full parallel assessment. Passes the rest of $ARGUMENTS through
unchanged and does not re-implement any assessment logic.

## Workflow

### Phase 1: Dispatch

**1. Route by first argument token**
   Parse $ARGUMENTS; the first token selects the assessment skill to load

- Parse $ARGUMENTS. The first whitespace-delimited token selects an assessment by its keyword below; the remaining text, unmodified, becomes that skill's own input (for example the path or scope the user wants assessed).
- If the first token matches no keyword, or $ARGUMENTS is empty: print the keyword table below (keyword + one-line description) and HALT without side effects.
- `repo` -> `skill://assess-repo` - Full repository assessment: purpose first, then architecture, code quality, testing, security, AI readiness and CI/CD in parallel, synthesized into one report under docs/assessment/
- `team` -> `skill://assess-team` - Full team assessment: commit volume and messages, code quality, test coverage, AI adoption, documentation, incidents and code review by developer
- `config` -> `skill://assess-config` - Create portfolio-local assessment configuration: code roots, repository and issue-tracker hosts, secret-safe credential wiring and local output paths
- `report` -> `skill://assessment-report-suite` - End-to-end executive package: assess-repo and assess-team, the AI Readiness Diagnostic workbook, a markdown executive summary and a PowerPoint brief

**2. Resolve a single-dimension repo run**
   --only <dimension> applies to repo only; it replaces the full assessment with one leaf skill

- `--only <dimension>` is accepted with `repo` only. When it is present, remove it and its value from the argument text that is passed through.
- If `--only` is present with any other keyword: say that `--only` applies to `repo` only, and HALT without side effects.
- If `--only` has no value, or its value is not a dimension below: print the dimension table below (dimension + leaf skill) and HALT without side effects.
- `purpose` -> `skill://assess-purpose` - Infer the repository's purpose, domain and target audience from code alone
- `architecture` (alias `architect`) -> `skill://assess-architect` - Architecture and structure
- `code-quality` -> `skill://assess-code-quality` - Code quality, patterns and technical debt
- `testing` -> `skill://assess-testing` - Test coverage and quality
- `security` -> `skill://assess-security` - Security patterns and vulnerabilities
- `ai-readiness` -> `skill://assess-ai-readiness` - AI agent compatibility
- `cicd` -> `skill://assess-cicd` - CI/CD pipelines and deployment automation
- A valid `--only <dimension>` replaces the `repo` route: load that dimension's leaf skill instead of `assess-repo` and run it stand-alone. Do not load `assess-repo`, do not launch the parallel dimension tasks and do not write the combined report. This command supplies no output path or REPORT_PREFIX, so the leaf reports its findings in the response and saves docs/assessment/<dimension>.md only if the user asks.

**3. Load the skill and follow it**
   Hand off to the selected skill by name, with the remaining argument text

- Load the selected skill by name (the `skill://<name>` form above, or your runtime's skill loader) and follow it, passing the remaining argument text through unmodified. Do not re-implement any of its phases here.
- If your runtime cannot load a skill by name, read that skill's `SKILL.md` file yourself (it ships under `skills/<name>/` in the ensemble-assessment package) and follow its full text.

## Usage

```
/ensemble:assess <repo|team|config|report> [--only <dimension>] [args...]
```
