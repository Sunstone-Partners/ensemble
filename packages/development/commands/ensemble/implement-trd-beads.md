---
name: implement-trd-beads
description: Execute TRD implementation with strategy awareness, direct specialist delegation, phase-end quality gates, and beads-based task tracking
version: 1.0.0
category: implementation
---

> **Usage:** `/implement-trd-beads` from project root with `docs/TRD/` directory.
> Hints: "resume", "strategy=characterization", "from TRD-015"

---

## User Input

```text
$ARGUMENTS
```

Examples: (no args), "resume", "strategy=tdd", "from TRD-015", "report status only"

---

## Flow

```
1. Preflight    → Load constitution, select TRD, ensure branch, detect strategy
2. Parse        → Extract tasks, build phases, load resume state from beads
3. Execute      → For each phase: create beads, delegate to specialists, update TRD checkboxes
4. Quality Gate → After phase: run tests, debug failures, check coverage
5. Checkpoint   → Update beads state, commit progress
6. Complete     → Final report with beads summary and next steps
```

---

## Step 1: Preflight

### 1.1 Constitution
Load `docs/standards/constitution.md` if present. Extract quality gates (coverage targets, security requirements). If absent, use defaults: 80% unit, 70% integration.

### 1.2 TRD Selection
Priority: $ARGUMENTS path → $ARGUMENTS name → in-progress TRD in docs/TRD/ → prompt user.
Validate: Must have "Master Task List" section with `- [ ] **TRD-XXX**: Description` format.

### 1.3 Branch
Ensure on `feature/<trd-name>` branch. Use `git town hack` or `git switch -c` as fallback.

### 1.4 Strategy

**Priority**: $ARGUMENTS override → TRD explicit → constitution → auto-detect → default (tdd)

| Strategy | Behavior | Best For |
|----------|----------|----------|
| `tdd` | Tests first, RED-GREEN-REFACTOR | Greenfield |
| `characterization` | Document current behavior AS-IS, no refactoring | Legacy/brownfield |
| `test-after` | Implement then test | Prototypes, UI |
| `bug-fix` | Reproduce → failing test → fix → verify | Regressions |
| `refactor` | Tests pass before AND after | Tech debt |
| `flexible` | No enforcement | Mixed work |

**Auto-detection rules** (first match wins):
1. TRD contains "legacy", "existing", "brownfield", "untested" → `characterization`
2. TRD contains "bug fix", "regression", "defect" → `bug-fix`
3. TRD contains "refactor", "optimize", "tech debt" → `refactor`
4. TRD contains "prototype", "spike", "POC" → `test-after`
5. Default → `tdd`

---

## Step 2: Parse Tasks

### 2.1 Extract from TRD
```yaml
Format: "- [ ] **TRD-XXX**: Description"
Extract: id, description, dependencies (if "Depends: TRD-YYY"), parallelizable (if "[P]")
```

### 2.2 Build Phases
Group by `### Phase N` or `### Sprint N` headings. If none, all tasks = Phase 1.
Sort by dependencies (topological order).

### 2.3 Resume State via Beads

Query beads to determine current execution state. No local state files are used.

```bash
# Find all beads for this TRD
bd list --label "trd:<trd-name>" --json
```

**Interpretation:**
- Tasks with status `closed` → already complete, skip
- Tasks with status `in_progress` → interrupted mid-execution, re-claim and continue
- Tasks with status `open` → pending, execute in phase order
- If no beads exist with label `trd:<trd-name>` → fresh run, create all task beads (see Step 3.0)

**Strategy mismatch**: If existing beads record a different strategy than current, warn the user and confirm before proceeding.

---

## Step 3: Execute Phase

For each phase, delegate tasks to appropriate specialists.

### 3.0 Initialize Task Beads (fresh run only)

On first run (no existing beads for this TRD), create a bead for each extracted task:

```bash
# For each TRD task:
bd create "TRD-XXX: {description}" \
  --type task \
  --label "trd:<trd-name>" \
  --label "phase:<N>" \
  --label "trd-implementation" \
  --description "TRD: {trd_file}
Strategy: {strategy}
Phase: {N}
Dependencies: {dep_list or none}" \
  --json
```

Record the returned bead ID alongside the TRD task ID for the session. On resume, reconstruct this mapping by querying:

```bash
bd list --label "trd:<trd-name>" --json
# Match bead title prefix "TRD-XXX:" to task IDs
```

### 3.1 Select Specialist

| Keywords | Specialist |
|----------|------------|
| backend, api, endpoint, database, server | @backend-developer |
| frontend, ui, component, react, vue, angular, web | @frontend-developer |
| mobile, flutter, react-native, ios, android, app | @mobile-developer |
| test, spec, e2e, playwright | @test-runner or @playwright-tester |
| refactor, optimize | @backend-developer or @frontend-developer |
| docs, readme | @documentation-specialist |
| infra, deploy, docker, k8s, aws, cloud | @infrastructure-developer |

**Project agents**: If `.claude/router-rules.json` defines project-specific agents with matching triggers, prefer them over global specialists.

### 3.2 File Conflict Detection

Before executing parallel tasks:

**Step 1: Infer file touches for each task**

| Source | Method |
|--------|--------|
| Explicit | Task contains `Files: path/to/file.ts` → use those paths |
| Keyword | "controller" → `**/controllers/**`, "model" → `**/models/**`, "service" → `**/services/**`, "test" → `**/*.test.*`, "component" → `**/components/**` |
| Domain | Backend tasks → `src/api/`, `src/services/`; Frontend tasks → `src/components/`, `src/pages/` |
| Query | If ambiguous, ask specialist before execution: "What files will you modify for task {task_id}?" |

**Step 2: Detect conflicts**
- If multiple tasks touch the same file → execute sequentially
- If file sets are disjoint → execute in parallel

**Step 3: Execute**
- Parallel limit: up to 2 concurrent tasks (or `max parallel N` from $ARGUMENTS)
- When conflict detected mid-execution: pause conflicting task, let first complete, then resume

### 3.3 Task Prompt

```
## Task: {task_id} - {task_description}

### Context
- TRD: {trd_file}
- Strategy: {strategy}
- Constitution: {quality_gates_summary or "defaults: 80% unit, 70% integration"}
- Completed: {completed_task_ids from this phase}

### Objective
{acceptance_criteria extracted from TRD task description}

### Files
{file_paths inferred from task description}

### Skills
Use the Skill tool to invoke the {matched_skill_1} skill.
Use the Skill tool to invoke the {matched_skill_2} skill.
{...for each matched skill from router-rules.json}

Report which skill(s) you used.

### Deliverables
1. Implementation complete per objective
2. Files changed (list paths)
3. Tests passing (yes/no/not applicable)
4. Outcome summary

### Strategy Instructions
{Include strategy-specific guidance based on detected strategy}

| Strategy | Instructions |
|----------|-------------|
| `tdd` | Follow Red-Green-Refactor: (1) Write failing test first, (2) Implement minimal passing code, (3) Refactor while keeping tests green |
| `characterization` | Document current behavior AS-IS: Write tests that capture EXISTING behavior. Do NOT refactor or "fix" the code. Tests should pass immediately. |
| `test-after` | Implement first, then add tests. Focus on coverage over test-first methodology. |
| `bug-fix` | (1) Write failing test that reproduces the bug, (2) Implement the fix, (3) Verify the test passes |
| `refactor` | Ensure all tests pass BEFORE changes. Make incremental changes. Run tests after each change. |
| `flexible` | Use your judgment. No strict methodology enforcement. |
```

### 3.4 Skill Matching

**Skill discovery order:**
1. Project-specific: `.claude/router-rules.json` (if exists)
2. Global plugin: `${CLAUDE_PLUGIN_ROOT}/router/lib/router-rules.json` (if exists)
3. Installed skills fallback (if no router-rules found)

**Matching algorithm:**
1. Tokenize task description (split on whitespace, lowercase)
2. For each skill's `triggers` array, check if any trigger is a substring of the task description
3. For each skill's `patterns` array, test regex against task description
4. Return all matching skills

**Fallback when no router-rules.json found:**

| Task Keywords | Skill |
|---------------|-------|
| JavaScript, TypeScript, Jest, React test | `jest` |
| Python, pytest, Django, Flask test | `pytest` |
| Ruby, RSpec, Rails test | `rspec` |
| Elixir, ExUnit, Phoenix test | `exunit` |
| C#, .NET, xUnit test | `xunit` |
| Playwright, E2E, browser test | `writing-playwright-tests` |
| No match | Omit Skills section from prompt |

### 3.5 On Task Completion

For each task lifecycle event, update beads AND the TRD file:

**Starting a task:**
```bash
bd update <bead-id> --status in_progress --json
```

**Task succeeds:**
```bash
# Update TRD file: - [ ] → - [x]
bd close <bead-id> --reason "Implemented in commit {sha}: {summary}" --json
```

**Task fails:**
```bash
bd update <bead-id> --notes "Failed: {error_message}" --json
# Leave status as open for retry
```

Commit after each successful task: `<type>(TRD-XXX): <description>`

---

## Step 4: Phase Quality Gate

After all tasks in a phase complete, execute the quality gate. The gate varies by strategy.

### 4.1 Quality Gate by Strategy

| Strategy | Quality Gate Behavior |
|----------|----------------------|
| `tdd` | Run tests. MUST pass. Coverage MUST meet threshold. Block on failure. |
| `characterization` | Run tests. Failures are INFORMATIONAL (documenting current behavior). Do not block. |
| `test-after` | Run tests. Warn if coverage below threshold. Do not block. |
| `bug-fix` | Run tests. Verify the specific bug-fix test passes. Block if regression. |
| `refactor` | Run tests. ALL tests must pass (no regressions). Block on any failure. |
| `flexible` | Run tests. Log results. Do not block. |

### 4.2 Test Execution

```
Delegate to @test-runner:

Run full test suite for files modified in this phase.
Files: {changed_files_this_phase}

Report:
- Pass/fail status
- Coverage percentages (unit, integration)
- Failure details with file:line references

Use the Skill tool to invoke the jest skill.
Use the Skill tool to invoke the pytest skill.
{...based on detected test framework}

Report which skill(s) you used.
```

### 4.3 Debug Loop on Failure

If tests fail AND strategy NOT IN [characterization, test-after, flexible]:

```
Delegate to @deep-debugger:

Tests failing after phase completion.
Strategy: {strategy}
Error output: {test_failure_details}
Files modified: {changed_files_this_phase}

Analyze root cause. Propose fix. Implement if straightforward.
Max retries: 2

Report: fix applied (yes/no), files changed, recommendation
```

**Retry logic**:
1. If debugger fixes issue → re-run tests
2. If tests pass → continue to checkpoint
3. If still failing after 2 retries → pause for user decision

### 4.4 Coverage Check

Compare against constitution targets (default: 80% unit, 70% integration).

| Strategy | Below Threshold Action |
|----------|----------------------|
| `tdd` | BLOCK until coverage improved |
| `refactor` | BLOCK (no regressions allowed) |
| `bug-fix` | WARN, continue |
| `test-after` | WARN, continue |
| `characterization` | SKIP (coverage not the goal) |
| `flexible` | LOG, continue |

### 4.5 Security Scan (optional)

```
Delegate to @code-reviewer:

Quick security review of phase changes.
Files: {changed_files_this_phase}
Focus: hardcoded secrets, injection vulnerabilities, input validation.

Report: issues found (list), severity, recommendations
```

### 4.6 Phase Checkpoint

If quality gate passes:
- Commit: `chore(phase N): checkpoint (tests pass; cov X%)`
- Update phase beads with coverage notes:
  ```bash
  bd update <phase-bead-id> --notes "Phase N checkpoint: tests pass, unit={X}%, integration={Y}%"
  ```

If quality gate fails:
- Report specific issues
- Pause for user decision: fix now, skip check, or abort

---

## Step 5: State Management via Beads

All task state is tracked in beads (`bd`). No local state files are created or needed.

### Beads Labels Convention

| Label | Meaning |
|-------|---------|
| `trd:<trd-name>` | All tasks for this TRD (e.g., `trd:feature-auth`) |
| `phase:<N>` | Phase number (e.g., `phase:1`) |
| `trd-implementation` | All TRD implementation tasks across all TRDs |

### Task Lifecycle

```bash
# Create task bead (on first run, before execution)
bd create "TRD-XXX: {description}" \
  --type task \
  --label "trd:<trd-name>" \
  --label "phase:<N>" \
  --label "trd-implementation" \
  --description "TRD: {trd_file}
Strategy: {strategy}
Phase: {N}" \
  --json

# Claim task (when starting execution)
bd update <id> --status in_progress --json

# Complete task (on success)
bd close <id> --reason "Implemented in commit {sha}: {summary}" --json

# Mark failed (leave open for retry, add notes)
bd update <id> --notes "Failed: {error}" --json
```

### Querying State

```bash
# All tasks for this TRD
bd list --label "trd:<trd-name>" --json

# Completed tasks only
bd list --label "trd:<trd-name>" --status closed --json

# Pending and in-progress tasks
bd list --label "trd:<trd-name>" --status open --json
bd list --label "trd:<trd-name>" --status in_progress --json

# Tasks for a specific phase
bd list --label "trd:<trd-name>" --label "phase:1" --json
```

### Resume Detection

On start, query beads to determine state:

1. `bd list --label "trd:<trd-name>" --json` → get all tasks
2. `closed` → complete, skip
3. `in_progress` → interrupted, re-claim (`bd update <id> --status in_progress`) and continue
4. `open` → pending, execute in phase order
5. No beads → fresh run, create all task beads from TRD

---

## Step 6: Completion

```
═══════════════════════════════════════════════════════
TRD Implementation Complete
═══════════════════════════════════════════════════════

TRD: feature-name.md
Branch: feature/feature-name
Strategy: {strategy}

Progress: {N} tasks completed, {M} failed

Quality:
  Unit Coverage:        {X}% (target: 80%)
  Integration Coverage: {Y}% (target: 70%)
  Security Scan:        {Clean/Issues found}

Beads Summary:
  bd list --label trd:<trd-name> --json

Next Steps:
  1. git diff main...feature/feature-name
  2. gh pr create
  3. After merge: mv docs/TRD/feature.md docs/TRD/completed/
═══════════════════════════════════════════════════════
```

---

## Error Handling

| Error | Response |
|-------|----------|
| No TRD found | List available TRDs, suggest /create-trd |
| Task failure | Report error, update bead notes, attempt debug loop, pause if unresolved |
| Coverage below threshold | Strategy-dependent: block, warn, or continue |
| Tests failing | Run @deep-debugger (max 2 retries), then pause for user |
| Beads state mismatch | Show TRD tasks vs beads, offer to reset by closing all open beads and recreating |
| File conflict in parallel | Serialize conflicting tasks automatically |

---

## Compatibility

- Delegates directly to specialists (no intermediary orchestrator)
- Works with/without constitution.md
- Works with/without router-rules.json
- Preserves git-town integration
- Existing TRDs work unchanged
- Uses beads (`bd`) for persistent task tracking across sessions — no local state files
