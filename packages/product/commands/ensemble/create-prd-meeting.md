---
name: ensemble:create-prd-meeting
description: Create a PRD from a meeting summary instead of a live interview
version: 1.0.0
category: planning
last-updated: 2026-07-13
model: opus
---
<!-- DO NOT EDIT - Generated from create-prd-meeting.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Create a Product Requirements Document from a meeting summary rather than a live
interactive interview -- the asynchronous counterpart to create-prd, for capturing
requirements discussed in a meeting a human wasn't available to interview about
afterward. Extracts what the summary actually states, marks every gap create-prd's
live interview would normally have filled with [NEEDS CLARIFICATION], and produces
the same PRD structure and Implementation Readiness Gate as create-prd so a later
human-run refine-prd pass closes the gaps interactively. Source-agnostic by design:
works from any adapter that normalizes its meeting-summary output into the expected
shape, not tied to any one meeting platform.

## Workflow

### Phase 1: Meeting Summary Intake

**1. Parse Meeting Summary**
   Read and structurally parse the provided meeting summary

   - Read the meeting summary from $ARGUMENTS -- either inline text or a file path
   - Expect a normalized shape with some subset of: meeting title/date/attendees, Decisions, Open Questions, Discussion Points (optionally grouped by topic), Action Items (optionally tagged with an owner). Different adapters populate different subsets of this shape -- do not fail if one section is missing, just note what's absent
   - If $ARGUMENTS is empty or does not resemble a meeting summary (no Decisions/Discussion Points/Action Items section found at all), stop and tell the user this command needs a meeting summary, not a free-form product description -- suggest /ensemble:create-prd for that instead

**2. Scale Detection (inferred, not asked)**
   Infer project complexity from the summary's own scope, since there is no one to ask

   - Estimate depth from signal richness: count distinct decisions + discussion topics + action items combined. Roughly: 3 or fewer total items => LIGHT, 4-10 => STANDARD, more than 10 or explicit enterprise/multi-team language in the summary => DEEP
   - Default to STANDARD if the signal is ambiguous rather than guessing at the extremes
   - State the inferred depth AND the reasoning behind it in the PRD's Notes section, so a human reviewing it can override during a later refine-prd pass -- this is an inference, not a live-confirmed choice like in create-prd

**3. Extraction**
   Map meeting content onto create-prd's Problem Space questions, marking anything unaddressed

   - For each of create-prd's five Problem Space questions (problem/pain and who feels it, primary users, success metrics, constraints, prior solutions tried), search the summary for an answer
   - Where the summary answers a question, use that content directly and note which part of the summary it came from
   - Where the summary does NOT answer a question, do not guess -- record it as a [NEEDS CLARIFICATION: <the original question, reworded to the specific gap>] to be inserted at the relevant point in the PRD, exactly as create-prd's own Ambiguity Marking Pass would
   - Do NOT attempt create-prd's SCAMPER/failure-scenario elicitation interactively -- there is no one to ask follow-up creative-elicitation questions of here. If the summary happens to surface an edge case, risk, or alternative considered, capture it as a requirement or risk flag; if it doesn't, that's simply outside what this pass covers, not a gap to interview around

### Phase 2: Research and Context

**1. Codebase Reconnaissance**
   Understand existing patterns and constraints before writing requirements

   - Check for existing codebase (package.json, src/, app/, lib/) and identify the tech stack
   - Read CLAUDE.md or CONTRIBUTING.md for coding standards the PRD should respect
   - Identify existing authentication, authorization, and data patterns the new feature must integrate with
   - If no codebase exists (greenfield), note this and skip to step 2

**2. Existing PRD Review**
   Maintain consistency with prior product documentation

   - Check docs/PRD/ for existing PRDs -- read the most recent one for style and conventions
   - Generate a collision-resistant micro UUID for the document id: 8 lowercase hex characters from a UUID/random source (e.g., `node -e "console.log(require('crypto').randomUUID().replace(/-/g,'').slice(0,8))"`). Do NOT scan for highest sequence numbers or increment NNN; teams create PRDs concurrently
   - Set Document ID to PRD-{current_year}-{micro_uuid}, for example PRD-2026-a1b2c3d4
   - Note any cross-cutting requirements from existing PRDs that this feature must respect
   - If the meeting summary itself references an existing PRD or feature by name, flag that as a candidate for /ensemble:refine-prd-meeting instead -- this command is for new PRDs, not extending an existing one

**3. Technical Dependency Mapping**
   Identify integration points and technical constraints

   - List external services, APIs, or databases the feature will interact with
   - Identify shared components or libraries the feature should reuse
   - Flag any technical constraints that limit design options (e.g., must work offline, must support IE11, max 100ms latency)
   - For LIGHT depth: bullet list of dependencies is sufficient
   - For DEEP depth: create a dependency matrix showing interaction direction and data flow

### Phase 3: Requirements Definition

**1. Functional Requirements**
   Define what the product must do, grouped by feature area, drawing only from Phase 1's extraction

   - Group requirements by feature area (e.g., 'User Management', 'Data Import', 'Reporting'), not just 'Functional' vs 'Non-Functional'
   - Assign REQ-NNN IDs as H3 headings: '### REQ-001: Description'
   - Tag each requirement with MoSCoW priority: Must, Should, Could, Won't (this release) -- infer from how the meeting summary discussed it (e.g., a Decision implies Must, an Open Question implies the priority itself may need clarification)
   - Tag each requirement with complexity: Low, Medium, High
   - Flag requirements with risk indicators where applicable: [RISK: description]
   - Write requirements as user-observable behaviors, not implementation details
   - For LIGHT depth: 5-10 requirements, Must/Should only
   - For STANDARD depth: 10-25 requirements, full MoSCoW
   - For DEEP depth: 25+ requirements, full MoSCoW with risk flags on every Medium/High complexity item

**2. Non-Functional Requirements**
   Define performance, security, accessibility, and operational requirements

   - Use the same REQ-NNN numbering sequence (continue from functional requirements)
   - Cover these categories as applicable, but only where the meeting summary actually touched on them -- do not invent NFRs the meeting never discussed
   - Tag each with MoSCoW priority and complexity, same as functional requirements
   - If the meeting summary is silent on a category a real product would typically need (e.g., security, accessibility), mark it with [NEEDS CLARIFICATION: no NFR discussion found for <category> -- confirm requirements] rather than fabricating one

**3. Acceptance Criteria**
   Create measurable, testable acceptance criteria for every requirement

   - Write ACs as sub-items under each requirement in Given/When/Then format
   - Format: '- AC-NNN-M: Given <context>, when <action>, then <outcome>'
   - Every Must requirement needs at least 2 ACs (happy path + one edge case)
   - Every Should requirement needs at least 1 AC
   - Where the meeting summary doesn't give enough detail to write a real edge-case AC, write the happy-path AC from what's known and mark the missing edge case with [NEEDS CLARIFICATION] rather than inventing one
   - For LIGHT depth: 1 AC per requirement minimum
   - For DEEP depth: 2-4 ACs per requirement including edge cases and error paths

**4. Ambiguity Marking Pass**
   Review every requirement and AC written in this phase for unresolved ambiguity,
same discipline as create-prd -- but expect a HIGHER marker count here than a
live create-prd run would produce, since there was no interview to resolve
things in real time. That is expected, not a defect in this command.

For each place where the PRD author made an assumption rather than having it
stated explicitly in the meeting summary:
- "Insert [NEEDS CLARIFICATION: <specific question>] as an inline marker immediately after the ambiguous text"
- The question must be specific enough that a "yes/no" or brief answer fully resolves it
- Do NOT silently resolve ambiguity with a best-guess -- mark it instead

After marking: count the total [NEEDS CLARIFICATION] markers and print:
"Ambiguity scan complete: N items marked for clarification (meeting-sourced draft -- expect more than a live create-prd run)."
These markers become the structured interview agenda in a later, human-run /ensemble:refine-prd.


**5. Dependency Map**
   Document which requirements depend on each other

   - For each requirement, list any prerequisites: 'REQ-003 depends on REQ-001'
   - Identify requirement clusters that should be implemented together
   - Flag any circular dependencies as issues to resolve
   - For LIGHT depth: simple bullet list of dependencies
   - For DEEP depth: dependency table with columns: REQ, Depends On, Blocked By, Notes

### Phase 4: Self-Review and Readiness Gate

**1. Self-Critique**
   Review the draft PRD and identify issues from the same 5 categories as
create-prd (gaps, contradictions, ambiguity, missing edge cases,
testability). Unlike create-prd, do NOT present these to the user for live
resolution -- there is no interview in this command. Resolve what's directly
resolvable from the meeting summary's own content; convert everything else
into an additional [NEEDS CLARIFICATION] marker instead of asking.


**2. Implementation Readiness Gate**
   Score the same 4 dimensions as create-prd (Completeness, Testability,
Clarity, Feasibility, 1-5 scale, averaged). Expect a LOWER score than a live
create-prd run would typically produce, roughly proportional to the
[NEEDS CLARIFICATION] marker count -- that reflects reality, not a failure
of this command.

PASS (4.0+): save as normal.
CONCERNS (3.0-3.9) or FAIL (below 3.0): save the PRD either way, with Status
set to Draft -- unlike create-prd, which asks the user to address CONCERNS or
proceed, and refuses to save outright on FAIL. Neither of those fits this
command: there is no live user to ask, and this command's entire purpose is
producing a starting draft for a human's later refine-prd pass, so refusing
to save a low-scoring async draft would defeat that purpose. Do NOT invoke
AskUserQuestion for this branch. Instead, report the FAIL/CONCERNS/PASS
result plainly, list the specific concerns (same categories create-prd would
list), and say clearly that a human refine-prd pass is expected next given
the score.


### Phase 5: Output Management

**1. PRD Document Generation**
   Generate the final PRD with frontmatter and health summary

   - Include document frontmatter block: Document ID (PRD-YYYY-<micro_uuid>), Version (1.0.0), Status (Draft), Date, Scale Depth, Total Requirements, Readiness Score
   - Generate PRD Health summary at the top of the document, same fields as create-prd
   - Add a Source line noting this PRD was drafted from a meeting summary -- name the meeting title and date if the input included them
   - State the [NEEDS CLARIFICATION] marker count in the Notes section, so a human can gauge how much refine-prd work remains before this is Development Ready
   - Generate Acceptance Criteria summary table: | REQ-NNN | Description | Priority | Complexity | AC Count |
   - Include the dependency map section
   - File naming: docs/PRD/PRD-YYYY-<micro_uuid>-<slug>.md (micro_uuid = 8 lowercase hex chars; no sequence number)

**2. File Organization**
   Save to docs/PRD/ directory and confirm

   - Create docs/PRD/ directory if it doesn't exist
   - Save the PRD to docs/PRD/PRD-YYYY-<micro_uuid>-<slug>.md
   - Print: file path, requirement count, readiness score, [NEEDS CLARIFICATION] marker count, and the suggested next step -- /ensemble:refine-prd on this file to close out the clarification markers interactively, not /ensemble:create-trd directly, given the marker count

## Expected Output

**Format:** Product Requirements Document (PRD), drafted from a meeting summary

**Structure:**
- **PRD Health Summary**: Requirement counts by priority, AC coverage percentage, risk flag count, dependency count
- **Product Summary**: Problem statement, solution overview, value proposition, target users -- drawn from the meeting summary, gaps marked rather than invented
- **User Analysis**: User roles, personas, pain points, success metrics
- **Goals and Non-Goals**: Objectives, success criteria, explicit scope boundaries
- **Requirements by Feature Area**: REQ-NNN identified requirements grouped by feature area with MoSCoW priority and complexity tags
- **Acceptance Criteria**: ACs co-located under each REQ-NNN in Given/When/Then format (AC-NNN-M), plus summary table
- **Dependency Map**: Cross-requirement dependencies and implementation clusters
- **Readiness Scorecard**: Implementation Readiness Gate scores for completeness, testability, clarity, and feasibility
- **Clarification Agenda**: Count and list of [NEEDS CLARIFICATION] markers -- the agenda for the human-run refine-prd pass this command expects to follow it

## Usage

```
/ensemble:create-prd-meeting
```
