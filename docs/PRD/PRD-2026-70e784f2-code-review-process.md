---
document_id: PRD-2026-70e784f2
label: prd-code-review-process
version: 1.0.1
status: Locked
date: 2026-10-27
scale_depth: STANDARD
total_requirements: 25
readiness_score: 4.25
design_readiness_score: null
---

# PRD-2026-70e784f2: Code Review Process Improvements (Verified Findings, Convergence, Risk-Tiered Approval)

## PRD Health Summary

- **Risk flags:** REQ-005, REQ-012, REQ-014, REQ-021
- **Dependencies:** 39 cross-requirement dependencies (see Dependency Map)
- **Unresolved clarification markers:** 0
- **Constitution compliance:** passed (`docs/standards/constitution.md`, Non-Negotiable Rules 1-9, §3 Quality Gates, §4 Approval Requirements)

## Product Summary

**Problem:** Landing a pull request takes too long. Ensemble's review loop (PRD-2026-82b6a138) bounds the number of rounds and records findings in a ledger, but it does not check that findings are real before an author or agent acts on them, it applies a different round cap in `pr-review-cycle` (2) than in `pr-merge` (5), it asks the same human approval of every change regardless of risk, and nothing tells reviewers what matters in a given area of the repository. Review noise, repeated rounds, uniform human attention and reviewers that never learn from escaped bugs all add to PR landing time. It is also unclear what an agent's "approved" means compared with a human's.

**Who feels it:** Ensemble maintainers who approve and merge PRs; the implementing agents and orchestrators (`fix-issue`, `implement-trd-beads`, `pr-merge`, Foreman-dispatched runs) that author PRs and answer findings; and teams in downstream repositories that adopt the ensemble review workflow.

**Solution:** Adopt, and adapt to ensemble, the practices described in "How the Claude Code team does code review" (Anthropic, 2026-10-15): move most reading to machines, spend human attention by risk, and make the reviewer measurable and improvable. Specifically: area-specific review rules, a PR template that captures testing, risk and rollback; multiple fresh-context reviewers whose findings are verified by independent voters before they reach the author; an Important/Nit/Pre-existing severity taxonomy; one convergence policy (round cap, diff-only re-review, no repeats, class-of-bug flags) shared by every review procedure; change-driven risk tiers with commit-bound human approvals that a bot can never satisfy; depth modes; a blocking security lane; review metrics; an incident-driven reviewer eval set; and on-demand sweeps and explainers. This builds on, and does not replace, PRD-2026-82b6a138.

**Success:** Against a baseline cohort captured before the change (see Entry Criteria): median human approvals per PR, and p95 wait-on-human time, go down; mean rounds-to-pass, PRs needing five or more rounds, and the reviewer noise rate all go down; and revert and incident rates do not go up. Revert and incident rates are the guardrail: if they rise, human time has only been moved, not saved.

**Source:** Anthropic, "How the Claude Code team does code review" (https://claude.dev/blog/solving-code-review-at-anthropic/), reviewed against the current ensemble review surfaces and PRD-2026-82b6a138.

**Out of scope (Won't, this release):** replacing or reconfiguring CodeRabbit; a new external review provider; zero-human merges (the Low tier does not waive human approval until evidence supports it, see REQ-013); a durable scheduler or dispatcher owned by ensemble (Constitution Rule 4; recurring runs are on-demand or triggered by the host repository's own automation); hard spend caps on model usage; circuit breakers that tighten approval automatically when revert rates move; changes to Foreman.

## User Analysis

| Role | Pain today | What they need |
|---|---|---|
| Ensemble maintainer | Reads and re-reads PRs of unequal risk; unsure what a bot "approval" means | Human attention aimed where risk is; findings that are already verified |
| Implementing agent / orchestrator | Burns rounds on nits and false positives; no stop rule shared across commands | One convergence policy; findings it can act on without re-checking |
| Adopting team | No documented review conventions to copy | Reusable review rules, PR template and ownership declaration |

Primary success metrics: human approvals per PR (median, p95), wait-on-human time, rounds-to-pass, PRs needing 5+ rounds, reviewer noise rate; guardrail: reverts and incidents.

## Approvals and Decision Ownership

- **Approver:** The Ensemble repository owner (maintainer), together with a representative of an adopting team.
- **Acceptance criteria the approver judges against:** the PR-landing-time, human-time, noise and convergence targets in REQ-019 are met on a post-change pilot cohort with revert and incident rates not higher than baseline; the workflow is adoptable in a downstream repository without ensemble-specific assumptions; and Constitution Rules 4, 6, 7 and 8 are respected.

## Entry and Exit Criteria

**Entry (must be true before work starts):**
- The 82b6a138 review workflow (PRD-2026-82b6a138, currently document status Draft) is finished before this work starts: its implementation (the `pr-review-cycle` skill, supporting libraries and the `fix-issue` / `implement-trd-beads` wiring) is complete, its own pilot (REQ-020 of that PRD) has reported a post-change cohort, and its document status is updated from Draft. This PRD has a hard dependency on that behavior and does not replace it.
- A baseline metrics cohort is captured before any change: median and p95 human approvals per PR, wait-on-human time, rounds-to-pass, PRs needing 5+ rounds, reviewer noise rate, and revert/incident counts, over a cohort of at least 20 PRs and at least 30 days (see REQ-019).

**Exit (observable conditions that end the work):**
- A post-change pilot cohort shows the REQ-019 targets met with reverts and incidents not higher than baseline.
- Every new gate has been demonstrated to fail when deliberately broken (REQ-025).
- Every new review capability is reachable from `fix-issue`, `implement-trd-beads` and `pr-merge` on Claude Code, Pi, Codex and OpenCode (REQ-023).
- Generated artifacts match their sources and the repository's own test suite passes.

## Requirements

### Repository review guidance

### REQ-001: Area-specific review rules (Must)

A repository can state, per area of the code, what matters to a reviewer, in a plain editable file that every review reads.

- AC-001-1: Given a repository contains a review rules file for an area, when a PR touching that area is reviewed, then the reviewer applies those rules and the review report names which rules file(s) were applied.
- AC-001-2: Given a PR touches two areas that each have rules, when it is reviewed, then both sets of rules apply and the more restrictive instruction wins on conflict.
- AC-001-3: Given a maintainer wants to change what the reviewer cares about, when they edit the rules file, then the next review reflects the change without a code change, rebuild or release.
- AC-001-4: Given no rules file exists for an area, when a PR is reviewed, then review proceeds using repository-wide guidance and the report states that no area-specific rules were found.

### REQ-002: PR description captures testing, risk and rollback (Must)

Every PR records how it was tested, how risky it is, and how to undo it, and the person who requested the change signs off on that content.

- AC-002-1: Given a PR is opened by a human or an agent, when its description is created, then it contains Testing, Risk and How-to-revert sections.
- AC-002-2: Given an agent drafts those sections, when the PR is ready for human approval, then the person who directed the agent is identified as the one accountable for them.
- AC-002-3: Given a PR description is missing any of the three sections, when its review status is computed, then the PR is reported as not ready for approval and names the missing section.
- AC-002-4: Given an adopting team runs the project init flow, when it completes, then the PR template, review rules file and ownership declaration are scaffolded into their repository.

### REQ-003: Owner-declared sensitive areas (Must)

Code owners can declare which parts of the repository are sensitive, and those declarations are the single source for "always needs a person".

- AC-003-1: Given an owner declares a path as sensitive, when a PR touches it, then the PR is treated as sensitive by every review and approval rule that consults sensitivity.
- AC-003-2: Given CI workflow definitions, release gates, installers, the generation pipeline and the project constitution, when no owner has declared them, then they are still treated as sensitive by default.
- AC-003-3: Given a PR changes the sensitivity declaration itself, when it is reviewed, then it is treated as sensitive and the declaration in force is the one on the target branch, not the one in the PR.

### Verified findings

### REQ-004: Multiple fresh-context reviewers (Must)

A review is performed by more than one reviewer, each starting with fresh context rather than the context that produced the change.

- AC-004-1: Given a PR is reviewed at Standard depth or higher, when review runs, then at least two reviewers examine the same diff independently, each without the authoring session's conversation context.
- AC-004-2: Given reviewers disagree on whether something is a defect, when findings are collected, then every candidate finding from every reviewer is recorded with its source.
- AC-004-3: Given a reviewer or verifier runs, when it completes, then it has made no change to the repository or to PR state other than recording or posting findings.

### REQ-005: Verification before posting (Must) [RISK: a verifier that votes wrongly can suppress a real bug or admit noise]

Each candidate finding is checked by independent verifiers, and only findings enough of them judge real are presented to the author.

- AC-005-1: Given candidate findings exist, when verification runs, then each finding receives independent votes from verifiers who did not produce it, and a finding is presented to the author only if a majority of its verifiers judge it real; the number of verifiers is 0 at Quick, 3 at Standard and 5 at Deep.
- AC-005-2: Given findings that are purely stylistic, diagnostic or cleanup, when verification completes, then they are not presented as findings requiring an answer.
- AC-005-3: Given CodeRabbit has posted findings on the same PR, when verification runs, then those findings enter the same ledger and receive the same verification, without CodeRabbit's own comments being edited, resolved or suppressed.
- AC-005-4: Given a finding fails verification, when the author views the review, then it appears as "verifier disagrees" with the reason, not as a required fix.

### REQ-006: Nothing is silently dropped; verification failure is visible (Must)

Filtering never hides findings, and a review that could not be verified says so.

- AC-006-1: Given a finding is filtered out by verification, when the ledger is read, then it is present with its votes and the reason it was not presented.
- AC-006-2: Given a candidate finding is critical or security-relevant, when verifiers split or reject it, then it is still presented for human adjudication, marked as disputed.
- AC-006-3: Given verification cannot run (no subagent capability, tool failure or timeout), when the review completes, then findings are presented marked "unverified" and the status states that verification was not performed; findings are never dropped on that account.
- AC-006-4: Given the runtime lacks multi-reviewer capability, when review runs, then a single-pass review runs and the report carries a visible notice that reduced review was used.

### REQ-007: Severity taxonomy with Pre-existing (Must)

Findings carry one of Important, Nit or Pre-existing, so out-of-diff problems do not look like the author's fault.

- AC-007-1: Given a finding exists in code the PR did not introduce, when it is classified, then it is tagged Pre-existing and does not block the PR.
- AC-007-2: Given findings are presented, when the author views them, then they are sorted with Important first and each is anchored to a file and line.
- AC-007-3: Given a maintainer wants to change what counts as Important versus Nit, when they edit the severity definitions, then the change takes effect without a code change.
- AC-007-4: Given existing ledgers use the prior severity vocabulary (Critical, Major, Minor, Nitpick), when they are read, then they map to the new taxonomy without losing any finding or changing any blocking outcome.

### REQ-008: Every finding is answered before merge (Must)

An Important finding must be fixed or resolved with a stated reason before the PR can merge.

- AC-008-1: Given an Important finding is open, when merge is attempted, then it is refused and names the open finding.
- AC-008-2: Given an author resolves a finding with a reason, when the thread is closed, then the reason is stored with the finding and the finding no longer blocks.
- AC-008-3: Given a later commit fixes the issue a finding described, when the next review runs, then the finding clears on its own.
- AC-008-4: Given a finding is Nit or Pre-existing, when merge is attempted, then it does not block.

### Convergence

### REQ-009: One round policy for every review procedure (Must)

A single round cap governs `pr-review-cycle` and `pr-merge`, replacing the current 2 and 5.

- AC-009-1: Given any ensemble review procedure runs on a PR, when the round count reaches the cap, then the reviewer stops iterating and asks the author to step back and reconsider the approach.
- AC-009-2: Given no repository setting, when the cap applies, then it is 3 rounds; a repository may configure any value from 1 to 5, and a value outside that range is ignored with a warning and the default is used.
- AC-009-3: Given a repository sets a different cap in its review rules, when review runs, then that value is used by every procedure and no procedure keeps a private number.
- AC-009-4: Given PRD-2026-82b6a138 stated a 2-round cap, when this requirement ships, then that PRD is updated so it no longer contradicts the shared cap.

### REQ-010: Diff-only re-review and no repeats (Must)

After the first rounds, review examines only what changed since the last review and never re-reports what was already reported.

- AC-010-1: Given a round after the first completes, when the next re-review runs, then it examines only the changes since the previously reviewed commit.
- AC-010-2: Given a finding already recorded for this PR, when a later round sees the same defect, then it is not posted again.
- AC-010-3: Given new commits on a PR the system cannot vouch for (for example an agent push or a hand-resolved merge), when re-review runs, then it falls back to a full-diff review rather than trusting the prior one.

### REQ-011: Class-of-bug flagging (Must)

When a finding is an instance of a pattern, the reviewer names the pattern so the author fixes every instance in one round.

- AC-011-1: Given a finding fits a repeatable class (the same mistake in several places), when it is presented, then it names the class and lists the instances found.
- AC-011-2: Given the author fixes one instance of a flagged class, when the next review runs, then any remaining instance is reported against the existing class finding, not as a new finding.

### Risk-tiered approval

### REQ-012: Change-driven risk tier (Must) [RISK: a mislabelled tier merges risky code with too little human review]

Each PR is assigned a Low, Medium or High risk tier from the change itself, not from who wrote it.

- AC-012-1: Given a PR, when review begins, then a tier is assigned from the kind of change: Low for documentation, copy and additive changes behind a flag; Medium for ordinary product changes; High for sensitive areas (REQ-003) and any path an owner has listed as High.
- AC-012-2: Given two PRs with identical changes from different authors, when tiers are assigned, then they receive the same tier.
- AC-012-3: Given a second assessment indicates a Low or Medium PR nonetheless needs another person, when it is evaluated, then the tier is raised.

### REQ-013: Strict by default, raise-only, protected floor (Must)

The tier policy starts strict and can only be loosened with evidence.

- AC-013-1: Given fewer than 20 Low-tier PRs over 30 days have merged with zero reverts and zero incidents, when a Low PR is evaluated, then it is treated as Medium and requires one human approval; once that evidence exists and a code owner explicitly enables it, Low means "no human required".
- AC-013-2: Given an agent or the author proposes a tier, when it is lower than the assigned tier, then it is ignored; only a code owner can lower a tier.
- AC-013-3: Given a PR touches a sensitive area (REQ-003), when its tier is set, then the tier is High and two humans are required, regardless of what the classifier concluded.
- AC-013-4: Given tier relaxation is attempted without the recorded evidence, when approval is evaluated, then it is refused.

### REQ-014: Human approval means a person, on a specific commit (Must) [RISK: weak approval semantics let unreviewed code merge]

An approval is a person's decision about one commit, and an automated approval never fills a human slot.

- AC-014-1: Given an approval is recorded by an agent or automated account, when approval requirements are evaluated, then it does not count toward any required human approval; an account is automated if the repository's configured bot/agent list names it or the platform marks it as a bot.
- AC-014-2: Given an approval was given, when new commits are pushed that the system cannot vouch for, then the approval no longer counts and approval is requested again.
- AC-014-3: Given an agent authored a PR on a person's instruction, when approvals are counted, then that person counts as one of the required reviewers, as if they had written the code themselves.
- AC-014-4: Given a High-tier PR, when approvals are counted, then two distinct people are required.
- AC-014-5: Given the Low-tier waiver has been enabled (REQ-013), when a PR is evaluated, then the waiver applies only to PRs authored by repository maintainers; every other author's Low PR still requires one human approval.

### REQ-015: Tier decision is recorded (Must)

The tier, the reasons for it, and any raise are written where reviewers and metrics can read them.

- AC-015-1: Given a tier is assigned, when the PR's review state is read, then it contains the tier, the characteristics that drove it, and who or what assigned it.
- AC-015-2: Given a tier was raised by a sensitive path or a second assessment, when the record is read, then it shows the original and final tier and the reason.

### Depth, security and scale

### REQ-016: Review depth modes (Should)

Review effort scales with risk through Quick, Standard and Deep modes that bound how many reviewers and verifiers run.

- AC-016-1: Given a mode is selected, when review runs, then the number of reviewers and verifiers does not exceed that mode's bound (Quick: a single reviewer and no verifiers; Standard: at least two reviewers and 3 verifiers; Deep: at least two reviewers and 5 verifiers).
- AC-016-2: Given a maintainer wants to redefine a mode, when they edit its definition, then the change takes effect without a code change.
- AC-016-3: Given no mode is chosen, when review starts, then the mode defaults from the PR's tier: Low=Quick, Medium=Standard, High=Deep; while Low is treated as Medium (REQ-013), a Low PR gets Standard.

### REQ-017: Blocking security review lane (Should)

A security-focused review runs alongside the bug review and blocks merge while any of its findings is open.

- AC-017-1: Given a PR is reviewed, when the security review finds an issue, then merge is blocked until it is fixed or closed with a stated reason.
- AC-017-2: Given a later commit fixes the issue, when re-review runs, then the security finding clears on its own.
- AC-017-3: Given a security finding is a false positive, when the author closes it with a reason, then the reason is recorded in the ledger.

### REQ-018: Large diffs are reviewed by area (Should)

Big PRs are reviewed in slices by area so reviewers keep enough context to be useful.

- AC-018-1: Given a PR is too large for one reviewer to cover in a pass, when review runs, then it is split by area (using the sensitive-area and rules boundaries) and every slice is reviewed.
- AC-018-2: Given a PR is sliced, when findings are presented, then they are combined in one sorted list and the report states which slices were reviewed.

### Measurement and learning

### REQ-019: Review metrics with a revert and incident guardrail (Must)

The process reports the measures behind the success criteria, so improvement is shown rather than assumed.

- AC-019-1: Given a cohort of merged PRs, when metrics are produced, then they include human approvals per PR (median and p95), human comments, wait-on-human time, rounds-to-pass, and the share of PRs needing five or more rounds.
- AC-019-2: Given findings were presented, when metrics are produced, then each is classified by how the author responded (fixed, said wrong, said intentional, judged unimportant) and a noise rate is reported.
- AC-019-3: Given a post-change cohort and the baseline cohort, each of at least 20 PRs and at least 30 days, when compared, then targets are expressed relative to baseline: median human approvals and p95 human wait down, rounds-to-pass down by at least 30%, PRs needing five or more rounds down by at least 50%, and noise rate down by at least 30%.
- AC-019-4: Given the metrics are reported, when revert or incident counts for the cohort exceed baseline, then the report marks the cohort as failing the guardrail regardless of other results.

### REQ-020: Incident-driven reviewer eval set (Should)

Escaped bugs become cases that score the reviewer whenever it changes.

- AC-020-1: Given a PR that caused an incident or revert, when it is added to the eval set, then it records the change, the bug and where the bug lived, and is confirmed by the code owner of the affected area; the case is re-reviewed whenever that area's review rules change.
- AC-020-2: Given the reviewer's rules, prompts or model change, when the eval set is run, then each case is scored for whether the reviewer found the bug, and the result is reported.
- AC-020-3: Given a reviewer change lowers the eval score, when results are compared to the previous run, then the change is flagged as a regression.

### REQ-021: On-demand sweeps of existing code (Should) [RISK: scheduled behavior risks violating the ownership boundary with Foreman]

Review agents can sweep existing code to find old bugs, without ensemble owning the schedule.

- AC-021-1: Given a maintainer or the host repository's automation requests a sweep, when it runs, then reviewers examine existing code and report findings with the Pre-existing tag.
- AC-021-2: Given ensemble is installed, when no external trigger fires, then ensemble itself runs no recurring job (Constitution Rule 4); recurrence is the host repository's or Foreman's responsibility, with a recommended cadence of weekly and sensitive areas (REQ-003) swept first.

### REQ-022: Explainers for context sharing (Should)

Anyone can get an up-to-date explainer for a slice of the codebase, replacing line-by-line reading of trivial diffs for learning.

- AC-022-1: Given a maintainer requests an explainer for a named module, when it is produced, then it reflects the code as it is now and is delivered within minutes.
- AC-022-2: Given an explainer is produced, when it is read, then it names the files it was derived from.
- AC-022-3: Given a PR is High tier, when its review report is produced, then it offers an explainer for each touched sensitive module, and an explainer is generated only if requested.

### Cross-cutting requirements

### REQ-023: Reachable from the real entry points, on all runtimes (Must)

New review capability is delivered through the commands people run, on every supported runtime.

- AC-023-1: Given `fix-issue`, `implement-trd-beads` or `pr-merge` reaches its review step, when it runs, then it exercises the verified-findings, convergence and tier behavior (not just unit-tested code that nothing calls).
- AC-023-2: Given the capability is installed for Claude Code, Pi, Codex and OpenCode, when a review runs on each, then the behavior is equivalent or the report states what was reduced (REQ-006).
- AC-023-3: Given the review depends on repository automation that is not configured (for example a disabled hosted reviewer), when review runs, then the in-agent review still runs and no new CI secret is required.

### REQ-024: PR content is untrusted; no secrets (Must)

Everything a PR contains is data to examine, never instructions to follow, and reviewers never expose secrets.

- AC-024-1: Given a PR description, diff, comment or the PR's own copy of the rules file contains text addressed to the reviewer, when review runs, then that text is treated as data and does not alter reviewer behavior; rules and sensitivity declarations come from the target branch.
- AC-024-2: Given a reviewer or verifier encounters a credential or token, when findings are reported, then the secret value is not reproduced in any finding, comment or ledger entry.

### REQ-025: Every new gate can fail (Must)

Each gate this work adds is shown to block a bad case.

- AC-025-1: Given each of the verification threshold, the round cap, the tier floor, commit-bound approval, the blocking security lane and the finding-answered merge block, when it is deliberately broken (for example a threshold set to always pass), then its check fails.
- AC-025-2: Given a gate's check passes only in a trivial case, when it is reviewed, then a second case that must be refused is included and refused.

## Goals and Non-Goals

**Goals:**
- Reduce PR landing time by spending human attention where risk is and by presenting authors only findings that are verified.
- Make review converge: fewer rounds, no repeated findings, one stop rule across commands.
- Make human versus automated approval unambiguous and bound to a commit.
- Make the reviewer measurable, so improvement is demonstrated with reverts and incidents as the guardrail.
- Make the workflow reusable in repositories other than ensemble.

**Non-Goals:**
- Replacing CodeRabbit, adding a new review provider, or editing CodeRabbit's output.
- Zero-human merges, or automatic tightening of approval when revert rates change.
- An ensemble-owned scheduler for recurring work.
- Enforcing a model-spend budget.

## Dependency Map

- REQ-004 depends on REQ-001, REQ-024
- REQ-005 depends on REQ-004, REQ-007
- REQ-006 depends on REQ-005
- REQ-008 depends on REQ-006, REQ-007
- REQ-010 depends on REQ-009
- REQ-011 depends on REQ-007, REQ-010
- REQ-012 depends on REQ-002, REQ-003
- REQ-013 depends on REQ-003, REQ-012
- REQ-014 depends on REQ-012
- REQ-015 depends on REQ-012, REQ-013
- REQ-016 depends on REQ-004, REQ-012
- REQ-017 depends on REQ-005, REQ-008
- REQ-018 depends on REQ-004, REQ-016
- REQ-019 depends on REQ-007, REQ-009, REQ-012
- REQ-020 depends on REQ-005, REQ-019
- REQ-021 depends on REQ-004, REQ-016, REQ-024
- REQ-022 depends on REQ-023
- REQ-025 depends on REQ-005, REQ-008, REQ-009, REQ-013, REQ-014

**Clusters implemented together (each independently shippable):**
1. Guidance, severity and convergence: REQ-001, REQ-002, REQ-003, REQ-007, REQ-009, REQ-010, REQ-011
2. Verified findings, depth and scale: REQ-004, REQ-005, REQ-006, REQ-008, REQ-016, REQ-018
3. Risk tiers, approval semantics and the security lane: REQ-012, REQ-013, REQ-014, REQ-015, REQ-017
4. Metrics and eval set: REQ-019, REQ-020
5. Sweeps and explainers: REQ-021, REQ-022

REQ-023, REQ-024 and REQ-025 apply to every cluster.

**Circular dependencies:** none identified.

## Implementation Readiness Gate

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Completeness | 4.5 | All elicited practices covered; adoption mechanism, thresholds, cohort and sweep cadence now specified |
| Testability | 4 | Every Must has at least two Given/When/Then ACs and thresholds are now concrete; a few softer ACs remain (for example "delivered within minutes" in AC-022-1, "cannot vouch for" in AC-010-3 and AC-014-2) |
| Clarity | 4.5 | All clarification markers resolved in 1.0.1 |
| Feasibility | 4 | Within stated constraints; scope is large but split into five independently shippable clusters |
| **Overall** | **4.25** | **PASS** (was 4.0) |

## Changelog

| Date | Version | Changes |
|---|---|---|
| 2026-10-27 | 1.0.0 | Initial draft created via /ensemble:create-prd; Readiness Gate 4.0; Constitution Gate passed. |
| 2026-10-27 | 1.0.1 | Refinement: resolved all 13 clarification markers (setup via project init flow; majority vote with 0/3/5 verifiers at Quick/Standard/Deep; cap range 1-5; kind-of-change tiers; Low waiver after 20 PRs over 30 days with zero reverts/incidents, maintainers only, no trusted list; bot list plus platform bots; default depth by tier; cohort 20 PRs and 30 days with 30/50/30% targets; code-owner-confirmed eval cases; weekly sweeps; explainers offered on High-tier PRs); Entry now requires finishing 82b6a138 first; fixed AC-013-3 ambiguity (sensitive areas are High); readiness 4.0 -> 4.25. |
