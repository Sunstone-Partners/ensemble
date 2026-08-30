---
name: "ensemble:create-trd"
description: "Create Technical Requirements Document from PRD with architecture design and adversarial review"
version: "3.2.0"
category: "planning"
last-updated: "2026-08-22"
argument-hint: "[prd-path] [--team] [--foundational] [--list] [--foreman]"
model: "opus"
---
<!-- DO NOT EDIT - Generated from create-trd.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Create a Technical Requirements Document (TRD) from a Product Requirements Document (PRD).
Performs PRD validation, architecture design with alternatives, task breakdown with traceability,
optional MCP enhancement, adversarial self-review with a Design Readiness Gate, and structured
output with traceability matrices. Team configuration is handled separately by
/ensemble:configure-team. All outputs are saved to docs/TRD/.
--foreman also carries an artifact contract: when FOREMAN_ARTIFACT_PATH is set
and non-empty, write the phase report to that exact path (creating parent
directories as needed) IN ADDITION TO any repo-local report this command
already writes -- Foreman computes that path and reads it back to confirm the
phase produced an artifact. Never invent, alter, or relocate the path, and
never treat an unset FOREMAN_ARTIFACT_PATH as an error (outside Foreman
dispatch it is simply absent and behavior is unchanged).
Foreman subject contract: under --foreman, FOREMAN_TASK_TITLE and
FOREMAN_TASK_DESCRIPTION carry the dispatched task's title and description (Foreman
dispatch sets them; nothing else does). When FOREMAN_TASK_TITLE is set and non-empty
the TRD must plan exactly that task, and you print the title you read before
writing anything. FOREMAN_SOURCE_PRD_PATH, when set and non-empty, is the absolute path
of the PRD the previous Foreman phase actually produced: it is an INPUT to consume, not
an output path to write, and it is the only PRD you may read. Confirm that PRD's own
subject matches FOREMAN_TASK_TITLE before consuming it; if they describe different
work, STOP and report the mismatch quoting both subjects rather than planning the wrong
PRD. If FOREMAN_SOURCE_PRD_PATH is set but missing on disk, STOP and report the path --
never fall back to a directory scan. If NEITHER a prd-path was passed as arguments NOR
FOREMAN_SOURCE_PRD_PATH is set, STOP and report that no source PRD was delivered.
NEVER choose a PRD by recency, glob, or plausibility. Outside Foreman dispatch these
variables are absent and behavior is unchanged.

## Workflow

### Phase 1: PRD Ingestion and Validation

**1. List Available PRDs**
   If --list is passed, show available PRDs and exit

   - If $ARGUMENTS contains '--list': Resolve PRD_CLI per the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md) for packages/development/lib/prd-cli.js. If none of the 4 tiers resolve: fall back to resolving TRD_CLI via the same skill for packages/development/lib/trd-cli.js. If neither resolves, print 'ERROR: Neither prd-cli.js nor trd-cli.js found — cannot list PRDs.' and HALT.
   - If $ARGUMENTS contains '--list': run node "$PRD_CLI" list --type prd and parse {ok,type,items}. If ok is false or JSON is malformed, print the error and HALT. Print a formatted table of PRDs (columns: ID/Name, Status, Score, Version, Last Modified).
   - If $ARGUMENTS contains '--list' AND does NOT contain '--foreman': call AskUserQuestion with id='prd_select', question='Select a PRD to use as the basis for TRD creation:', options=items.map(i => ({id:i.slug, label:i.id||i.slug, description: 'Status: ' + i.status + (i.design_readiness_score != null ? ' | Score: ' + i.design_readiness_score : '') + (i.version ? ' | Version: ' + i.version : '') + (i.last_modified ? ' | Modified: ' + i.last_modified.split('T')[0] : '')})), multi=false, recommended=0. Parse answer id as the selected PRD_SLUG.
   - If $ARGUMENTS contains both '--list' and '--foreman': there is no human present to pick interactively. If items has exactly one entry, auto-select it as PRD_SLUG and print 'Foreman mode: auto-selected PRD <slug> (only candidate).' If items has zero or 2+ entries, print 'ERROR: --list with --foreman requires an unambiguous PRD. Candidates: <id/slug list>. Pass a specific prd-path instead.' and HALT.
   - If $ARGUMENTS contains '--list' (either branch above resolved a PRD_SLUG): derive PRD_FILE_PATH as docs/PRD/<basename matching the selected slug>.md (find by suffix/prefix match). If derived path does not exist, print 'ERROR: Could not resolve path for slug <PRD_SLUG>' and HALT. Set the derived path as the $ARGUMENTS prd-path and continue.

**2. PRD Ingestion**
   Parse and analyze existing PRD document from $ARGUMENTS path

   - If FOREMAN_SOURCE_PRD_PATH is set and non-empty, that file is THE PRD to consume -- read it and no other, and let it override any --list selection. If it is set but absent on disk, print 'ERROR: FOREMAN_SOURCE_PRD_PATH points at a missing file: <path>' and HALT without falling back to a directory scan. If it is unset AND no prd-path argument was provided, print 'ERROR: no source PRD was delivered (FOREMAN_SOURCE_PRD_PATH unset, no prd-path argument)' and HALT. Never select a PRD by recency, glob, or plausibility. When FOREMAN_TASK_TITLE is set, verify the PRD's subject matches it and HALT on a mismatch, quoting both.
   - Read PRD file from specified path
   - If --foundational and no full PRD exists: accept a short capability brief instead (the shared work to build), skip PRD-structure validation for this run, and build a capability registry from the brief's named capabilities / scope / target files instead of REQ-NNN IDs
   - If a full PRD is provided: validate document structure (required sections present), extract key requirements with REQ-NNN IDs, and build requirements registry for traceability tracking

**3. Requirements Validation**
   Ensure completeness of functional and non-functional requirements

   - If --foundational with a short capability brief: skip this PRD-specific validation step
   - Otherwise validate all required sections present (Product Summary, User Analysis, Goals, Technical Requirements, Acceptance Criteria)
   - Otherwise check acceptance criteria are testable and use Given/When/Then format
   - Otherwise verify REQ-NNN format numbering is consistent and sequential
   - Otherwise verify constraints and non-goals are documented

**4. Acceptance Criteria Review**
   Validate testable acceptance criteria from the PRD before TRD generation

   - If --foundational with a short capability brief: skip this PRD-specific acceptance criteria review
   - Otherwise ensure each requirement has measurable acceptance criteria with Given/When/Then items
   - Otherwise verify AC-NNN-M sub-item format under each REQ-NNN
   - Otherwise check that every Must requirement has at least 2 ACs (happy path + edge case)
   - Do NOT validate TRD traceability here -- the TRD has not been generated yet

**5. Implementation Readiness Gate Check**
   Check if the PRD passed its own readiness gate before proceeding

   - If --foundational with a short capability brief: skip the PRD readiness score gate
   - Otherwise read PRD frontmatter for Readiness Score field
   - If score >= 4.0 (PASS): proceed normally
   - If score 3.0-3.9 (CONCERNS): warn user about PRD concerns, ask whether to proceed. If --foreman is set, skip the ask -- log the warning and proceed automatically.
   - If score < 3.0 (FAIL): halt and recommend running /ensemble:refine-prd first (this HALT is unaffected by --foreman)
   - If no readiness score in frontmatter, proceed with a note that PRD was not gate-checked

### Phase 2: Architecture Design

**1. Domain Analysis**
   Analyze requirements for technical domains and architectural scope

   - Scan all REQ-NNN requirements for technical domain keywords (API, UI, database, infrastructure, security, etc.)
   - Identify architectural patterns needed (API layer, data model, UI components, integrations)
   - Map requirements to technical domains for coverage tracking
   - Determine if project is greenfield or brownfield (check for existing codebase)
   - Summarize domain coverage and gaps

**2. Capability Reuse Check**
   Reuse existing foundational work instead of duplicating it (dedup-by-reference)

   - Resolve TRD_GRAPH_CLI per the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md) for packages/development/lib/trd-graph-cli.js. If none of the 4 tiers resolve, print error and HALT.
   - Run: node "$TRD_GRAPH_CLI" capabilities docs/TRD --json to list capabilities already provided by foundational TRDs; if docs/TRD does not exist yet, treat the registry as empty and continue
   - For each technical capability this PRD needs (from Domain Analysis), check the registry: an EXPLICIT match is one of the listed capability tokens; otherwise judge an IMPLICIT match by comparing the needed work to existing foundational TRD labels/titles and their target files (also consult: node "$TRD_GRAPH_CLI" overlap docs/TRD)
   - If a foundational TRD already provides the capability: DO NOT generate duplicate tasks for it. Instead add a cross-TRD dependency [depends: <foundational-slug>#TRD-NNN] (or #PR-N) on the task that needs it, and record it under a '## Reused Capabilities' section (capability -> foundational TRD label + document id)
   - If a needed capability is clearly reusable across PRDs but no foundational TRD exists yet, recommend extracting it: suggest running /ensemble:create-trd <prd> --foundational to create a shared TRD, rather than embedding the work here
   - Reference foundational work by slug / document id only -- never by label (labels are display-only and may change)

**3. Architecture Alternatives**
   Present 2-3 architecture approaches with tradeoffs for user selection

   - Design Option A: simplest approach -- minimal components, fastest to build, may not scale
   - Design Option B: most scalable approach -- production-grade architecture, more upfront work
   - Design Option C: best fit for existing codebase (if brownfield) or balanced approach (if greenfield)
   - Present each option with pros, cons, estimated complexity impact, and risk profile
   - Ask user to choose one option or combine elements before proceeding. If --foreman is set, skip the ask -- automatically select Option C (best fit for existing codebase, or balanced approach for greenfield) as the recommended default, and print 'Foreman mode: auto-selected Option C (<summary>)' before continuing.

**4. System Architecture Design**
   Design detailed system architecture based on chosen approach

   - Define component boundaries and responsibilities
   - Design data flow between components (inputs, outputs, transformations)
   - Specify integration points with external systems and APIs
   - Document technology choices and rationale
   - Create architecture diagram description (component relationships, data flow direction)

### Phase 3: Task Breakdown and Planning

**1. Master Task List Generation**
   Generate comprehensive task list with TRD-NNN IDs and traceability annotations

   - Generate unique TRD-NNN IDs for every task (sequential numbering)
   - Every task line MUST begin with a GitHub checkbox -- `- [ ] ` (or `- [x] ` if already complete) -- immediately before **TRD-NNN**. Omitting the checkbox prefix makes the task invisible to trd-cli.js's TASK_LINE_RE parser and to implement-trd-beads, which will then create zero task beads for this TRD.
   - Each task includes: description, hour estimate (Nh), [satisfies REQ-NNN] annotation
   - Add Validates PRD ACs field listing AC-NNN-M items the task covers
   - Add Implementation AC checklist with Given/When/Then items specific to the implementation
   - Use [satisfies INFRA] or [satisfies ARCH] for infrastructure/architecture tasks without a direct REQ

**2. Test Task Generation**
   Generate paired test tasks for every user-facing implementation task

   - For every user-facing TRD-NNN implementation task, generate a TRD-NNN-TEST task
   - Every TRD-NNN-TEST line MUST begin with the same checkbox-prefix requirement as implementation tasks -- `- [ ] ` (or `- [x] ` if already complete) -- immediately before **TRD-NNN-TEST**.
   - Test tasks include: [verifies TRD-NNN] [satisfies REQ-NNN] [depends: TRD-NNN] annotations
   - Test task descriptions reference the specific ACs they verify
   - Ensure test tasks cover both happy path and edge case scenarios
   - Link test tasks to the PRD acceptance criteria they validate

**3. Dependency Mapping and PR Boundary Design**
   Organize tasks into shippable PR stack boundaries based on dependency order

   - Add [depends: TRD-NNN] annotations where tasks have prerequisites
   - Build dependency graph and identify the critical path
   - Flag tasks estimated at 8h+ as candidates for further breakdown
   - Draw PR boundaries around shippable vertical slices: each ### PR N: section must leave the codebase with passing tests, no half-implemented user-visible features, and be independently reviewable. Group by capability delivered, not calendar time.
   - Immediately after each ### PR N: heading, write a **Shippable State:** line: one sentence describing the visible capability available after this PR merges (e.g., 'Users can log in with email/password; profile editing is not yet available'). Infrastructure-only statements ('scaffolding complete') are not acceptable — the statement must describe user-observable behaviour.
   - Ensure no circular dependencies exist in the task graph
   - Verify each PR boundary passes the shippability test: (a) all its tests pass in isolation, (b) no public API or UI route returns 404/500 due to tasks deferred to a later PR, (c) the scope is small enough to be reviewed independently.

### Phase 4: MCP Enhancement (Optional)

**1. Check MCP Availability**
   Detect whether any MCP tools are available before attempting calls

   - Scan available tool names for any name starting with 'mcp__'
   - If none found, print 'MCP enhancement: skipped (no MCP tools detected)' and skip to Phase 5
   - If found, proceed with MCP-enhanced workflow steps below

**2. Inject Checkpoints (MCP)**
   Use inject_checkpoints tool to add review/validation checkpoints

   **MCP Tool:** `inject_checkpoints`
   Automatically inject checkpoint tasks into task breakdown:
- After major milestones
- Before deployments
- At integration points

   **Fallback:** Manually add checkpoint tasks using project patterns

**3. Assess Complexity (MCP)**
   Use assess_complexity tool to analyze task breakdown

   **MCP Tool:** `assess_complexity`
   Analyze overall project complexity:
- Estimate total hours
- Identify high-risk tasks
- Suggest sprint organization

   **Fallback:** Manually estimate complexity based on task estimates

**4. Generate Workflow Section (MCP)**
   Use generate_workflow_section tool to create execution workflow

   **MCP Tool:** `generate_workflow_section`
   Generate comprehensive workflow markdown:
- Sprint-by-sprint execution plan
- Task dependencies and ordering
- Checkbox tracking for progress

   **Fallback:** Manually structure workflow using TRD template patterns

### Phase 5: Adversarial Review and Design Gate

**1. Architecture Self-Critique**
   Identify architecture gaps and interface issues in the TRD

   - Find components that need to communicate but have no defined interface
   - Identify missing error handling or failure recovery paths between components
   - Check that every integration point has a defined protocol and data format
   - Flag architectural decisions that lack rationale or alternatives considered
   - Document at least 2 architecture issues with recommended resolutions

**2. Task Coverage Analysis**
   Verify PRD requirement coverage, task gaps, and PR shippability

   - Check every PRD REQ-NNN has at least one corresponding TRD task with [satisfies REQ-NNN]
   - Identify any TRD tasks that reference nonexistent REQ-NNN IDs
   - Find PRD requirements with no corresponding test tasks
   - Flag tasks estimated at 8h+ that should be broken down further
   - Verify every ### PR N: section in the Master Task List has a **Shippable State:** annotation
   - Flag any PR section whose Shippable State is infrastructure-only (e.g., 'scaffolding complete', 'setup done') with no user-observable capability — require a meaningful statement or a boundary split
   - Resolve TRD_CLI per the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md) for packages/development/lib/trd-cli.js. If none of the 4 tiers resolve OR `which node` fails: print "ERROR: Node.js and the TRD CLI (lib/trd-cli.js) are required. Ensure Node.js is installed and the ensemble-development or ensemble-pi plugin bundle is present." and HALT.
   - Write the current draft Master Task List to a scratch file (this session's scratchpad, NOT docs/TRD/ -- this is a disposable self-check copy, not the final save).
   - Run: node "$TRD_CLI" parse <scratch-path>. Parse {ok, trd:{tasksById, warnings}}.
   - If ok is false, tasksById is missing any task the draft intends, or warnings contains 'No tasks found in the TRD': report it as a Task Coverage issue naming the offending line(s) -- this means a task line is missing its required checkbox prefix. Report before the Design Readiness Gate score is presented.
   - If the check finds zero issues: proceed to the gate without blocking.
   - Document at least 2 coverage issues with recommended resolutions

**3. Dependency and Estimate Review**
   Check for dependency risks and estimate confidence issues

   - Identify tasks with long dependency chains (depth > 3)
   - Check for circular or implicit dependencies
   - Review hour estimates for consistency (similar tasks should have similar estimates)
   - Flag optimistic estimates on high-complexity tasks
   - Document at least 1 dependency or estimate issue with recommended resolution

**4. Testability Review**
   Verify all implementation ACs can be objectively verified

   - Check each Implementation AC for measurability (has specific pass/fail criteria)
   - Flag ACs that use subjective language (fast, good, user-friendly) without metrics
   - Verify test tasks have clear verification steps
   - Document any testability issues with recommended resolutions

**5. Design Readiness Gate**
   Score TRD on quality dimensions and determine readiness

   - Score architecture completeness (1-5): are all components, interfaces, and data flows defined?
   - Score task coverage (1-5): does every REQ-NNN have implementation and test tasks?
   - Score dependency clarity (1-5): are dependencies explicit and acyclic?
   - Score estimate confidence (1-5): are estimates consistent, reasonable, and granular enough?
   - Compute overall score: average of all four dimensions
   - PASS (4.0+): proceed to output
   - CONCERNS (3.0-3.9): list specific concerns, ask user whether to proceed or loop back. If --foreman is set, skip the ask -- log the concerns and proceed to output automatically.
   - FAIL (<3.0): identify weakest dimensions and loop back to fix before output (this HALT/loop-back is unaffected by --foreman)
   - Present the Design Readiness Scorecard to the user

### Phase 6: Output Management

**1. TRD Document Generation**
   Generate comprehensive TRD document with frontmatter and structured sections

   - Derive the TRD document micro UUID from the source PRD, so PRD/TRD artifacts share the same 8-hex correlation id. Parse the PRD filename or frontmatter Document ID for PRD-YYYY-<micro_uuid> where micro_uuid is 8 lowercase hex chars. If found, set TRD_MICRO_UUID to that value. Only if the PRD has a legacy sequence id or no parseable id, generate a new 8-hex micro UUID from a UUID/random source. Do NOT scan for highest TRD sequence number or increment NNN.
   - Derive the TRD Label from the source PRD's label so the pair reads as one effort: take the PRD's `label: prd-<stem>` (from its frontmatter, or derive prd-<stem> from the PRD title) and set TRD_LABEL = trd-<stem> (swap the prd- prefix for trd-, keep the same stem). The label is display-only and NEVER a reference key — cross-references use TRD_MICRO_UUID.
   - Include frontmatter: Document ID (TRD-YYYY-<TRD_MICRO_UUID>), Label (trd-<stem>), PRD reference, version 1.0.0, status Draft, date, Design Readiness Score, and kind (default `trd`)
   - If --foundational: this is a shared/reusable TRD not tied 1:1 to a PRD. Set frontmatter `kind: foundational`; the PRD reference is optional (treat the input as a capability brief if no full PRD exists); and add a `capabilities:` frontmatter list of the machine-matchable capability tokens this TRD provides (e.g. order-domain, money-value-object) so other TRDs' Capability Reuse Check can find and reference it
   - Generate Architecture Decision section documenting the chosen approach and alternatives considered
   - Generate Master Task List with all TRD-NNN tasks and TRD-NNN-TEST tasks, organized under ### PR N: headings (not ### Phase N: or ### Sprint N:). Each ### PR N: heading must be immediately followed by a **Shippable State:** line before the first task entry. This is the machine-parsed section used by implement-trd-beads to create stacked PRs.
   - Generate a ## Sprint Planning section (H2 heading) as a separate human-readable grouping for time-boxing PRs into calendar sprints. Use ## Sprint N: sub-headings (H2) within this section. This section is informational only — implement-trd-beads does not parse it.
   - File naming: docs/TRD/TRD-YYYY-<TRD_MICRO_UUID>-<slug>.md where TRD_MICRO_UUID is the source PRD micro UUID when available (no sequence number)

**2. Acceptance Criteria Traceability**
   Generate traceability matrix linking PRD requirements to TRD tasks

   - If --foundational with a short capability brief: skip the PRD acceptance criteria traceability matrix
   - Otherwise generate '## Acceptance Criteria Traceability' matrix table:
   - | REQ-NNN | Description | Implementation Tasks | Test Tasks |
   - Otherwise list each PRD requirement with its implementation TRD-NNN IDs and paired TRD-NNN-TEST IDs
   - Otherwise ensure every Must/Should requirement appears in the matrix

**3. Traceability Validation**
   Validate [satisfies] annotations against the PRD

   - If --foundational with a short capability brief: skip PRD REQ-NNN traceability validation
   - Otherwise scan all TRD tasks for [satisfies REQ-NNN] annotations
   - Otherwise validate that each REQ-NNN referenced in a [satisfies] annotation exists in the PRD
   - Otherwise warn (do NOT halt) if any PRD REQ-NNN has zero TRD task coverage
   - Otherwise warn (do NOT halt) if any [satisfies] annotation references a REQ-NNN not found in the PRD
   - Otherwise print summary: 'Traceability check: N requirements covered, M uncovered, K orphaned annotations'

**4. File Save and Next Steps**
   Save TRD and suggest follow-up commands

   - Create docs/TRD/ directory if it doesn't exist
   - Save TRD to docs/TRD/TRD-YYYY-<TRD_MICRO_UUID>-<slug>.md
   - Print: file path, task count, design readiness score, and source PRD correlation id (TRD_MICRO_UUID)
   - Suggest: '/ensemble:configure-team docs/TRD/TRD-YYYY-<TRD_MICRO_UUID>-slug.md to auto-configure the team'
   - Suggest: '/ensemble:implement-trd-beads docs/TRD/TRD-YYYY-<TRD_MICRO_UUID>-slug.md'
   - If --team flag was passed in $ARGUMENTS, auto-run /ensemble:configure-team on the saved TRD path

## Expected Output

**Format:** Technical Requirements Document (TRD)

**Structure:**
- **Architecture Decision**: Chosen architecture approach with alternatives considered, rationale, and tradeoffs
- **Master Task List**: Comprehensive task tracking with TRD-NNN IDs, [satisfies REQ-NNN] annotations, Validates PRD ACs fields, Implementation AC checklists, and paired TRD-NNN-TEST verification tasks
- **System Architecture**: Component design, data flow, integration points, and technology choices
- **Sprint Planning**: Organized development phases with task references and dependencies
- **Acceptance Criteria Traceability**: Matrix table linking REQ-NNN requirements to implementation tasks and test tasks
- **Quality Requirements**: Security, performance, accessibility, and testing standards
- **Design Readiness Scorecard**: Scores for architecture completeness, task coverage, dependency clarity, and estimate confidence

## Usage

```
/ensemble:create-trd [prd-path] [--team] [--foundational] [--list] [--foreman]
```
