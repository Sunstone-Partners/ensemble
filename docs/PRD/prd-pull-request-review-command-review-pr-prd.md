# PRD: Pull Request Review Command (`/review-pr`)

## Summary

A new command `/review-pr` for the Ensemble Plugins ecosystem that leverages the `gh` CLI to list and comprehensively review GitHub pull requests. When invoked without arguments, it lists all open PRs in the current repository. When given a PR number or URL, it performs an in-depth review covering code quality, coding standards, test coverage, documentation, and security.

This command belongs in the **ensemble-quality** package (Tier 2: Workflow Plugins), which already owns code review and quality enforcement concerns.

---

## Problem Statement

Developers using Ensemble Plugins currently lack an integrated, AI-augmented pull request review workflow. Reviewing PRs today requires:

1. Manually switching to GitHub's web UI or running ad-hoc `gh` commands.
2. Mentally tracking multiple review dimensions (security, tests, style) without a structured checklist.
3. No consistent, repeatable review standard across team members.

This leads to inconsistent review quality, missed security issues, and slower merge cycles.

---

## User Analysis

### Primary Users
- **Individual developers** using Claude Code with Ensemble Plugins who want fast, structured feedback on PRs before or during review.
- **Tech leads / senior engineers** who want to enforce consistent review standards across a team.

### Secondary Users
- **Open-source maintainers** triaging external contributions.
- **CI/CD pipelines** that could invoke the command for automated review gates.

### User Environment
- Terminal-based workflow inside Claude Code.
- GitHub repositories with `gh` CLI authenticated and available on `$PATH`.
- Node.js ≥ 20 (per `package.json` engine constraint).

---

## Goals

| # | Goal | Measurable Target |
|---|------|-------------------|
| G1 | Provide a zero-config way to list open PRs | Command with no args returns formatted PR list in < 3 seconds |
| G2 | Deliver structured, multi-dimensional PR reviews | Every review covers all 5 dimensions (quality, standards, tests, docs, security) |
| G3 | Integrate seamlessly with existing Ensemble conventions | Ships inside `ensemble-quality`; follows plugin manifest schema v5.x |
| G4 | Require no additional authentication beyond `gh` | Works wherever `gh auth status` succeeds |

## Non-Goals

- **Automated approval/merge** — the command is advisory only; it does not push review state to GitHub.
- **Non-GitHub providers** — GitLab, Bitbucket, etc. are out of scope for v1.
- **Inline comment posting** — v1 outputs the review to the terminal; posting review comments to the PR is a future enhancement.
- **Custom rule configuration** — v1 uses built-in heuristics; pluggable rulesets are deferred.

---

## Functional Requirements

### FR-1: List Open Pull Requests

```gherkin
Feature: List open pull requests

  Background:
    Given the user is in a directory that is a GitHub repository
    And the "gh" CLI is installed and authenticated

  Scenario: No arguments provided
    When the user runs "/review-pr"
    Then the command executes "gh pr list --state open"
    And displays a formatted table with columns: number, title, author, branch, updated date
    And the output is sorted by most recently updated first

  Scenario: gh CLI is not installed
    Given the "gh" CLI is not found on PATH
    When the user runs "/review-pr"
    Then the command displays an error: "gh CLI not found. Install it from https://cli.github.com"
    And exits with a non-zero status

  Scenario: Not a GitHub repository
    Given the current directory is not a Git repository or has no GitHub remote
    When the user runs "/review-pr"
    Then the command displays an error: "Not a GitHub repository"

  Scenario: No open pull requests
    Given the repository has zero open pull requests
    When the user runs "/review-pr"
    Then the command displays: "No open pull requests found"
```

### FR-2: Comprehensive Pull Request Review

```gherkin
Feature: Comprehensive pull request review

  Background:
    Given the user is in a directory that is a GitHub repository
    And the "gh" CLI is installed and authenticated

  Scenario: Review by PR number
    When the user runs "/review-pr 42"
    Then the command fetches PR #42 metadata via "gh pr view 42 --json"
    And fetches the diff via "gh pr diff 42"
    And produces a review report with all required sections

  Scenario: Review by PR URL
    When the user runs "/review-pr https://github.com/org/repo/pull/42"
    Then the command extracts the PR identifier from the URL
    And produces the same review report as when invoked by number

  Scenario: PR not found
    When the user runs "/review-pr 99999"
    And no PR with that number exists
    Then the command displays: "Pull request #99999 not found"

  Scenario Outline: Review report sections
    When the user runs "/review-pr <pr>"
    Then the review report contains the following sections in order:
      | Section              | Contents                                                        |
      | Overview             | PR title, author, branch, description summary, file count       |
      | Code Quality         | Complexity, duplication, naming, structure, anti-patterns        |
      | Coding Standards     | Style consistency, linting adherence, conventional commits       |
      | Test Coverage        | New/modified tests present, coverage gaps, edge cases missed     |
      | Documentation        | README updates, JSDoc/comments, changelog entries                |
      | Security             | Dependency changes, secrets exposure, injection risks, auth gaps |
      | Summary & Verdict    | Overall assessment (approve / request changes / needs discussion)|

    Examples:
      | pr |
      | 42 |
```

### FR-3: Review Output Formatting

```gherkin
Feature: Review output formatting

  Scenario: Terminal output
    When a review is generated
    Then each section has a clearly labeled heading
    And issues are categorized by severity: critical, warning, info
    And critical issues are highlighted with ❌
    And warnings are highlighted with ⚠️
    And informational notes are highlighted with ℹ️
    And a summary score is shown (e.g., "3 critical, 5 warnings, 2 info")

  Scenario: Large pull request
    Given a PR with more than 1000 changed lines
    When the user runs "/review-pr <number>"
    Then the command displays a warning: "Large PR (X lines changed). Review may take longer."
    And still completes the review
```

### FR-4: Command Registration

```gherkin
Feature: Plugin integration

  Scenario: Command is registered via ensemble-quality manifest
    Given ensemble-quality plugin is installed
    When Claude Code loads plugins
    Then "/review-pr" is available as a registered command
    And it appears in the plugin's command list with description "Review pull requests"

  Scenario: Help text
    When the user runs "/review-pr --help"
    Then the command displays usage: "/review-pr [<number> | <url>]"
    And a brief description of each mode
```

---

## Non-Functional Requirements

| ID | Category | Requirement |
|----|----------|-------------|
| NFR-1 | **Performance** | PR listing completes in < 3 seconds for repositories with ≤ 100 open PRs |
| NFR-2 | **Performance** | Review of a PR with ≤ 500 changed lines completes in < 30 seconds |
| NFR-3 | **Reliability** | Gracefully handles network failures, rate limits, and malformed diffs |
| NFR-4 | **Compatibility** | Works with `gh` CLI v2.x; Node.js ≥ 20 |
| NFR-5 | **Security** | Never logs, caches, or transmits repository tokens; relies on `gh` auth |
| NFR-6 | **Testability** | Unit tests cover all parsing logic; integration tests mock `gh` CLI output |
| NFR-7 | **Maintainability** | Follows existing ensemble-quality package structure; uses shared utilities from ensemble-core |
| NFR-8 | **Accessibility** | Output is readable without color support (severity prefixes use text + emoji, not color alone) |

---

## Technical Notes

- **Package home:** `packages/quality/` within the monorepo.
- **Command manifest:** Added to `packages/quality/plugin.json` under the `commands` array, following the existing schema used by `/create-prd` and other commands.
- **Dependencies:** No new runtime dependencies; `gh` is a peer/system dependency. Child process execution uses Node built-in `child_process`.
- **Test framework:** Jest (already in `devDependencies`), consistent with the monorepo.
- **Validation:** Must pass `npm run validate` and `npm run lint` at the monorepo root.

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Adoption** | 50% of active ensemble-quality users invoke `/review-pr` within 30 days of release | Plugin telemetry (if enabled) or download delta |
| **Review completeness** | 100% of reviews include all 5 dimensions | Automated test assertion on output structure |
| **Issue detection rate** | Flags ≥ 80% of issues that a senior engineer would catch on the same diff | Benchmark against 20 manually-reviewed PRs |
| **User satisfaction** | ≥ 4.0 / 5.0 rating in post-review feedback (if collected) | Optional feedback prompt |
| **Error rate** | < 2% of invocations result in unhandled errors | Error logging |
| **Performance** | p95 review time < 30s for PRs under 500 lines changed | Timing instrumentation |