---
Document ID: PRD-2026-1234589e
Title: Meeting-Summary-Driven PRD Drafting and Refinement
Version: 1.0.1
Status: Draft
Date: 2026-07-14
Scale Depth: DEEP (inferred from signal richness -- see Notes; requirement count below DEEP's typical range, see Notes)
Total Requirements: 5
Readiness Score: 4.0 (PASS, up from 3.25 CONCERNS)
Branch: feature/create-refine-prd-meeting
Author: Claude Code (via create-prd-meeting, meeting-sourced; refined via refine-prd-meeting)
---

# Meeting-Summary-Driven PRD Drafting and Refinement — Product Requirements Document

> **WORKED EXAMPLE -- not a real feature request.** This PRD is a test fixture included
> with this PR to demonstrate `create-prd-meeting` and `refine-prd-meeting` end-to-end
> against real and fictional input. It is not something to build, review as a genuine
> product ask, or merge as a live PRD.

> Drafted asynchronously via `/ensemble:create-prd-meeting` from the real AI-generated
> recap of "Claude Code & Ensemble Framework Next Steps" (2026-07-13, organized by
> the meeting host) -- then refined via `/ensemble:refine-prd-meeting` against a fictional
> follow-up meeting summary constructed as a second test fixture (see Changelog and
> Source). It is itself a PRD for the meeting-to-PRD capability the real meeting
> discussed -- the clearest single product-shaped ask surfaced in an otherwise
> wide-ranging strategy discussion. See Notes for what was deliberately excluded and why.

## PRD Health Summary

- **Requirements by priority:** Must (4), Should (1), Could (0), Won't (0)
- **AC coverage:** 5/5 requirements have acceptance criteria (100%)
- **Risk flags:** 0 (REQ-003's risk resolved this pass -- see Changelog)
- **Cross-requirement dependencies:** 2
- **Open clarifications:** 2 (see Clarification Agenda) -- down from 4

## Product Summary

**Problem.** Product/BA teams already discuss requirements live in meetings, but capturing
those requirements into a PRD today requires a separate, later interactive interview via
`/ensemble:create-prd` -- duplicating effort and risking loss of detail already covered in
the meeting. [NEEDS CLARIFICATION: the meeting does not state how often this duplication
actually happens today or how much time it costs -- no baseline metric given]

**Solution.** Two new asynchronous Ensemble commands -- `create-prd-meeting` and
`refine-prd-meeting` -- that take a meeting summary as input and produce (or update) a PRD
using the same structure, MoSCoW tagging, acceptance-criteria discipline, and Readiness Gate
as the existing live-interview commands, marking anything the summary doesn't answer with
`[NEEDS CLARIFICATION]` instead of guessing.

**Value.** Removes the redundant re-interview step for requirements already discussed live,
while preserving the same quality bar (Readiness Gate, AC coverage) as a live-interview PRD.
[NEEDS CLARIFICATION: no specific value/success metric stated in the meeting -- e.g. target
time saved per PRD, or target reduction in re-interview sessions]

## User Analysis

| Role | Relationship to feature |
|---|---|
| Product/BA team members | Primary users -- run `/ensemble:create-prd-meeting` after a requirements-discussion meeting instead of a separate live interview |
| Engineering teams | Downstream consumers -- receive the resulting PRD as TRD input, same as today |

**Pain point:** requirements already discussed in a meeting must be re-elicited live to
produce a PRD. **Success metric:** [NEEDS CLARIFICATION: not stated in the meeting].

## Goals and Non-Goals

**Goals:**
- Draft a PRD from a meeting summary without a live interview (`create-prd-meeting`)
- Refine an existing PRD using a meeting summary as the feedback source (`refine-prd-meeting`)
- Preserve the existing PRD quality contract (Health Summary, MoSCoW, GWT ACs, Readiness Gate)

**Non-Goals (explicitly out of scope for this PRD):**
- ~~Automated linkage/creation of Azure DevOps work items~~ -- **moved to REQ-003 as of the 2026-07-14 refinement.** Originally scoped out here as org-specific integration work; the follow-up meeting decided otherwise (User Story type, Product-team ownership, `ado-boards` bridge) and promoted it to a Must. Left struck through rather than deleted so the scope change itself stays visible, not just its result.
- Evaluating Ensemble's session logs for training/debugging value -- a separate, unrelated discussion thread from the same meeting
- Resolving the broader "agentic tools vs. SDLC process" balance question, or the general ADO-value-vs-overhead assessment -- both raised as open strategic questions in the meeting, neither specific to this feature
- Steering committee formation, recurring meeting cadence, and other meeting logistics -- organizational outcomes, not product requirements

## Requirements by Feature Area

### Meeting-to-PRD Drafting

#### REQ-001: Draft a PRD from a meeting summary without a live interview
**Priority:** Must | **Complexity:** Low

Given a normalized meeting summary is provided, the system produces a Draft-status PRD
following the standard PRD structure, without requiring interactive question-and-answer.

- AC-001-1: Given a meeting summary containing at least one Decision or Discussion Point, when `/ensemble:create-prd-meeting` is invoked with it, then a Draft-status PRD is produced with the standard frontmatter, Health Summary, and Readiness Scorecard.
- AC-001-2: Given a meeting summary with no identifiable Decisions, Discussion Points, or Action Items, when `/ensemble:create-prd-meeting` is invoked, then the command stops and directs the user to `/ensemble:create-prd` instead of producing a low-quality draft.

#### REQ-002: Mark unanswered gaps instead of guessing
**Priority:** Must | **Complexity:** Low

Given the meeting summary does not address one of the standard PRD elicitation questions
(problem, users, success metrics, constraints, prior attempts), the draft marks that gap
explicitly rather than inventing an answer.

- AC-002-1: Given a Problem Space question the meeting summary does not answer, when the draft PRD is generated, then a `[NEEDS CLARIFICATION: ...]` marker is inserted at the relevant location instead of a fabricated answer.
- AC-002-2: Given the draft is complete, when it is saved, then the total count of `[NEEDS CLARIFICATION]` markers is printed to the user.

### Meeting-to-PRD Refinement

#### REQ-003: Link resulting PRDs to Azure DevOps work items downstream
**Priority:** Must (was Should) | **Complexity:** Medium

Given a PRD has been drafted or refined from a meeting summary, a corresponding Azure
DevOps **User Story** (not a Feature) is created or linked via the existing `ado-boards`
skill, owned by the Product team lead, so the PRD is visible in the team's existing
backlog tooling. Resolved by the 2026-07-14 follow-up meeting: a User Story fits since
this tracks a single deliverable rather than a themed grouping of work, `ado-boards`
already has the necessary ADO project context wired up, and backlog visibility was
identified as the actual adoption blocker -- promoting this from a nice-to-have to a
launch requirement.

- AC-003-1: Given a PRD created or refined via a meeting-sourced command, when the PRD is saved, then a corresponding ADO User Story is created or linked via the `ado-boards` skill, owned by the Product team lead.

#### REQ-004: Refine an existing PRD using a meeting summary instead of a live interview
**Priority:** Must | **Complexity:** Low

Given an existing PRD and a meeting summary discussing it, the system applies whatever
the summary resolves and leaves the rest for a later live refinement pass, rather than
guessing at unaddressed findings.

- AC-004-1: Given an existing PRD's Synthesis findings and a meeting summary, when `/ensemble:refine-prd-meeting` is invoked, then each finding is classified as either resolved by the meeting content or left open, and only resolved findings are applied.
- AC-004-2: Given a finding the meeting summary does not address, when the refinement is saved, then that finding's content (including any `[NEEDS CLARIFICATION]` marker) remains unchanged.

#### REQ-005: Report what was resolved vs. what remains open
**Priority:** Should | **Complexity:** Low

Given a meeting-sourced refinement pass has completed, the user is told what was applied
and what still requires a live refinement session.

- AC-005-1: Given a completed `/ensemble:refine-prd-meeting` run, when the summary is printed, then it states the count of findings resolved from the meeting and the count still open.

## Dependency Map

- REQ-002 (clarification marking) is a cross-cutting behavior applied within REQ-001 (create) and REQ-004 (refine) -- not a standalone deliverable
- REQ-005 depends on REQ-004 (nothing to report on until refinement runs)
- REQ-003 (ADO linkage) depends on REQ-001/REQ-004 producing a PRD to link. No longer excluded from build scope as of the 2026-07-14 refinement -- see the struck-through Non-Goal above

## Readiness Scorecard

| Dimension | Score | Basis |
|---|---|---|
| Completeness | 4/5 (was 3) | All feature areas now have fully specified requirements; the 2 remaining gaps are Product Summary business-case framing, not missing feature coverage |
| Testability | 4/5 (was 3) | Every requirement now has a concrete, verifiable AC -- REQ-003's AC-003-1 no longer carries an inline clarification |
| Clarity | 4/5 (was 3) | ADO linkage mechanism, work-item type, and ownership are now stated plainly; two developers could build this identically |
| Feasibility | 4/5 (unchanged) | Nothing suggests a technical blocker; the "no new integration work needed" note from the follow-up meeting reinforces this |
| **Overall** | **4.0 -> PASS (up from 3.25 CONCERNS)** | Improved by resolving both REQ-003 clarifications this pass |

**Gate result: PASS.** Worth a judgment call, not just accepting the number: this PASSes
even though 2 of the original 4 clarifications remain open (Product Summary's baseline-cost
and success-metric gaps). That's because the Readiness Gate's dimensions
(Completeness/Testability/Clarity/Feasibility) are about whether the *requirements* are
buildable, not whether the *business case* is fully quantified -- the two still-open
markers are business-case framing, not missing requirement detail. Flagging this because
it's a real interpretive question: should an unquantified business case hold back PASS
even when every requirement is otherwise complete and testable? This PRD's gate says no;
a human reviewing it may reasonably disagree.

## Clarification Agenda

2 `[NEEDS CLARIFICATION]` markers remain, for a human-run `/ensemble:refine-prd` pass
(down from 4 -- both REQ-003 markers were resolved by the 2026-07-14 follow-up meeting):

1. No baseline stated for how often/how costly today's duplicate-interview problem actually is (Product Summary)
2. No success metric stated for this feature (Product Summary, User Analysis)

## Notes

- **Scale Depth was inferred as DEEP** from signal richness (2 Decisions + 4 Open Questions + 5 discussion topics + 10 action items = 21 total signals, plus explicit "across portfolio companies" multi-team language) -- but this PRD only carries 5 requirements, well below DEEP's typical 25+. That's intentional: the meeting's signal volume is real, but most of it is organizational/logistical (steering committee, recurring meetings, Leo's background) or belongs to unrelated Ensemble threads (session logs), not additional detail on *this* feature. Writing 25 requirements would have meant inventing content the meeting doesn't actually support -- the `[NEEDS CLARIFICATION]` discipline governs here over hitting a target count.
- **Design gap found by running this for real:** `refine-prd`'s original CONCERNS branch says "ask user if they want to address them or proceed" -- `create-prd-meeting`'s YAML explicitly overrode that for FAIL, but never explicitly overrode it for CONCERNS. Running this end-to-end surfaced the gap: there's no live user to ask in an unattended run. This run just reported CONCERNS and saved as Draft, matching the FAIL behavior in spirit rather than the letter of the YAML. Worth patching the YAML to state this explicitly for CONCERNS too, not just FAIL.
- Per Non-Goals, several real discussion threads from the meeting were deliberately excluded from this PRD rather than forced in: session-log evaluation, the agentic-tools-vs-SDLC-process balance question, general ADO overhead assessment, and steering-committee/meeting-cadence logistics.

## Changelog

### 1.0.1 -- 2026-07-14 (meeting-sourced refinement via `/ensemble:refine-prd-meeting`)

Synthesis found 4 open findings (all `[NEEDS CLARIFICATION]` markers). Checked each
against the "ADO Linkage Follow-up" meeting summary (2026-07-14): **2 resolved from the
meeting, 2 still open.**

- Resolved: REQ-003's mechanism/ownership gap -- User Story work item type, Product team
  ownership, `ado-boards` as the sync bridge (per the follow-up meeting's Decisions)
- Resolved: REQ-003's "worth building at all" gap -- promoted Should -> Must; the meeting
  identified backlog visibility as the actual adoption blocker
- REQ-003's `[RISK]` tag removed -- the specific uncertainty it flagged (undecided
  mechanism) is what got resolved
- Non-Goals reconciled: the ADO-linkage exclusion is struck through, not left standing
  alongside a Must requirement that directly contradicts it -- resolving a finding means
  updating everywhere it's referenced, not just the requirement itself
- Readiness Score: 3.25 (CONCERNS) -> 4.0 (PASS)
- Left untouched, per this command's constraints: the two Product Summary clarifications
  (baseline cost, success metric) -- the follow-up meeting didn't address either, so
  nothing was guessed at

## Source

Meeting: "Claude Code & Ensemble Framework Next Steps," 2026-07-13, organized by the
meeting host. Drafted via `/ensemble:create-prd-meeting` from the AI-generated meeting
recap (Teams Intelligent Recap / Loop notes), retrieved via `workiq`.

Refined via `/ensemble:refine-prd-meeting` using a fictional follow-up meeting summary,
"ADO Linkage Follow-up," 2026-07-14 -- constructed as a test fixture, not a real meeting,
to validate that this command correctly separates resolvable findings from ones it must
leave alone.
