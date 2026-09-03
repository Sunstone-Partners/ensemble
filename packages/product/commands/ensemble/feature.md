---
name: "ensemble:feature"
description: "Adaptive idea-to-plan entrypoint: score complexity, then route to fix-issue, PRD→TRD, or full PRD/TRD refinement planning"
version: "1.0.0"
category: "planning"
last-updated: "2026-03-15"
argument-hint: "<description> [--skip-refine] [--depth simple|medium|complex] [--no-auto-complexity] [--foreman]"
model: "opus"
---
<!-- DO NOT EDIT - Generated from feature.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Orchestrate adaptive idea-to-plan routing as a single command. First runs deterministic
local complexity analysis on the work description and prints score, rationale, selected
depth, and path before any downstream planning command begins. Scores 1-3 select the
Simple fix-issue path; scores 4-6 run create-prd then create-trd; scores 7-10 run the
full create-prd, refine-prd, create-trd, refine-trd planning pipeline. Existing explicit
manual commands remain unchanged. Interactive refinement steps may pause for user input;
Foreman mode passes --foreman to refinement commands and never prompts. Planning only -- no code
is executed. Terminates with a handoff message showing the produced PRD/TRD and approval block.

## Workflow

### Phase 1: Argument Parsing

**1. Parse Arguments and Set Variables**
   Parse $ARGUMENTS and initialize pipeline variables.

1. If $ARGUMENTS is empty or blank, print the following and exit without running any pipeline step:
   Usage: /ensemble:feature <description> [--skip-refine] [--depth simple|medium|complex] [--no-auto-complexity] [--foreman]

2. Scan $ARGUMENTS for supported flags and remove them from the remaining text:
   - --skip-refine sets SKIP_REFINE=true.
   - --depth simple|medium|complex sets DEPTH_OVERRIDE and takes precedence over global config.
   - --no-auto-complexity sets DISABLE_AUTO_COMPLEXITY=true and takes precedence over global config.
   - --foreman sets FOREMAN_MODE=true and INTERACTIVE=false; never prompt in Foreman mode.

3. Scan the remaining text for any other tokens that begin with --. If any unknown flag is found, print the following and exit without running any pipeline step:
   Error: Unknown flag '<flag>'. Supported flags: --skip-refine, --depth, --no-auto-complexity, --foreman.
   Usage: /ensemble:feature <description> [--skip-refine] [--depth simple|medium|complex] [--no-auto-complexity] [--foreman]

4. Set FEATURE_DESCRIPTION to the remaining argument text after removing supported flags. Preserve the description verbatim -- no transformation, truncation, or summarization.

5. If FEATURE_DESCRIPTION is empty or blank, print exactly:
   Work description is required before complexity analysis can select a planning path.
   Then halt before any downstream planning command.


### Phase 2: Adaptive Complexity Gate

**1. Analyze complexity before route selection**
   Call analyzeWorkComplexity from packages/product/lib/work-complexity-analyzer.js with FEATURE_DESCRIPTION, DEPTH_OVERRIDE, DISABLE_AUTO_COMPLEXITY, FOREMAN_MODE, and any operator config.

Print score/rationale/path before planning begins:
- Score: <score>/10
- Depth: <Simple|Medium|Complex>
- Path: <fix-issue OR create-prd -> create-trd OR create-prd -> refine-prd -> create-trd -> refine-trd>
- Rationale: <scope, dependencies, risk, teamSize factor evidence>
- Override applied: <yes|no>
- Auto disabled: <yes|no>
- Original classification: <score/depth/path> when an override changes the analyzer result
- Uncertainty: <uncertainty notes when present>

If FOREMAN_MODE=true and FOREMAN_ARTIFACT_PATH is set and non-empty, write this same audit block to the exact FOREMAN_ARTIFACT_PATH, creating parent directories as needed. Never treat an unset FOREMAN_ARTIFACT_PATH as an error.


**2. Select adaptive route**
   Set SELECTED_DEPTH and SELECTED_PATH from the analyzer result.
- Simple: print the recommended manual path `/ensemble:fix-issue <FEATURE_DESCRIPTION>` and stop without creating PRD/TRD artifacts. This preserves fix-issue's explicit approval/implementation contract.
- Medium: run create-prd then create-trd. Skip refine-prd and refine-trd.
- Complex: run create-prd -> refine-prd -> create-trd -> refine-trd. Implementation remains blocked until the refined TRD receives explicit approval.

Direct invocations of /ensemble:fix-issue, /ensemble:create-prd, /ensemble:create-trd, and /ensemble:refine-trd remain unchanged; only this adaptive entrypoint requires pre-planning classification.


### Phase 3: Pipeline Execution

**1. Step 1 - create-prd**
   Print: [Step 1/4] create-prd...

If FOREMAN_MODE=false: invoke /ensemble:create-prd with FEATURE_DESCRIPTION as the argument. Pass the description verbatim with no modification.

If FOREMAN_MODE=true: invoke /ensemble:create-prd with FEATURE_DESCRIPTION and --foreman. Pass the description verbatim with no modification, and never prompt in Foreman mode.

After completion, use Glob to find the most recently modified .md file in docs/PRD/. Store the path as PRD_PATH.

If the command fails or no PRD file is found in docs/PRD/, print the following and halt the pipeline immediately:
[Step 1/4] create-prd failed. Pipeline halted.

Error details:
<error output from the failed step>

To retry from this step, run:
  /ensemble:create-prd <FEATURE_DESCRIPTION>


**2. Step 2 - refine-prd**
   Check SELECTED_DEPTH and SKIP_REFINE.

If SELECTED_DEPTH=Medium: Print [Step 2/4] refine-prd... (skipped for Medium route) and proceed to Step 3. Do not invoke refine-prd.

If SELECTED_DEPTH=Complex and SKIP_REFINE=true: Print [Step 2/4] refine-prd... (skipped) and proceed to Step 3. Do not invoke refine-prd.

If SELECTED_DEPTH=Complex and SKIP_REFINE=false and FOREMAN_MODE=false: Print [Step 2/4] refine-prd... (pausing for your input) and invoke /ensemble:refine-prd. The refine-prd command may use AskUserQuestion to conduct the interview. Wait for refine-prd to complete before proceeding.

If SELECTED_DEPTH=Complex and SKIP_REFINE=false and FOREMAN_MODE=true: Print [Step 2/4] refine-prd... (--foreman) and invoke /ensemble:refine-prd --foreman. Never prompt in Foreman mode. Wait for refine-prd to complete before proceeding.

If refine-prd fails, print the following and halt the pipeline immediately:
[Step 2/4] refine-prd failed. Pipeline halted.

Error details:
<error output from the failed step>

To retry from this step, run:
  /ensemble:refine-prd


**3. Step 3 - create-trd**
   Print: [Step 3/4] create-trd...

If FOREMAN_MODE=false: invoke /ensemble:create-trd with PRD_PATH (captured from Step 1) as the argument. Passing the explicit PRD path ensures create-trd reads the correct PRD and not a stale or unrelated document in docs/PRD/.

If FOREMAN_MODE=true: invoke /ensemble:create-trd with PRD_PATH and --foreman. Passing the explicit PRD path ensures create-trd reads the correct PRD and not a stale or unrelated document in docs/PRD/, and --foreman preserves non-interactive behavior.

After completion, use Glob to find the most recently modified .md file in docs/TRD/. Store the path as TRD_PATH.

If the command fails or no TRD file is found in docs/TRD/, print the following and halt the pipeline immediately:
[Step 3/4] create-trd failed. Pipeline halted.

Error details:
<error output from the failed step>

To retry from this step, run:
  /ensemble:create-trd <PRD_PATH>


**4. Step 4 - refine-trd**
   Check SELECTED_DEPTH and SKIP_REFINE.

If SELECTED_DEPTH=Medium: Print [Step 4/4] refine-trd... (skipped for Medium route) and proceed to Handoff. Do not invoke refine-trd.

If SELECTED_DEPTH=Complex and SKIP_REFINE=true: Print [Step 4/4] refine-trd... (skipped) and proceed to Handoff. Do not invoke refine-trd.

If SELECTED_DEPTH=Complex and SKIP_REFINE=false and FOREMAN_MODE=false: Print [Step 4/4] refine-trd... (pausing for your input) and invoke /ensemble:refine-trd. The refine-trd command may use AskUserQuestion to conduct the interview. Wait for refine-trd to complete before proceeding.

If SELECTED_DEPTH=Complex and SKIP_REFINE=false and FOREMAN_MODE=true: Print [Step 4/4] refine-trd... (--foreman) and invoke /ensemble:refine-trd --foreman. Never prompt in Foreman mode. Wait for refine-trd to complete before proceeding.

If refine-trd fails, print the following and halt the pipeline immediately:
[Step 4/4] refine-trd failed. Pipeline halted.

Error details:
<error output from the failed step>

To retry from this step, run:
  /ensemble:refine-trd


### Phase 4: Handoff

**1. Present Handoff Message**
   This step only executes if the selected route completed without error. If any step halted the pipeline, this phase is never reached.

Print the following handoff message. Ensure a blank line appears above and below the message block for visual separation:

Pipeline complete. Your planning artifacts are ready.

  PRD: <PRD_PATH>
  TRD: <TRD_PATH>

Implementation remains blocked until the refined TRD receives explicit approval.

To start implementation after approval:

  /ensemble:implement-trd-beads <TRD_PATH> --execute

Where <PRD_PATH> and <TRD_PATH> are the actual file paths captured from Steps 1 and 3 respectively.

After printing the handoff message, stop. Do not proceed with any implementation work.


## Expected Output

**Format:** Pipeline orchestration result

**Structure:**
- **Progress Indicators**: Progress line printed before each selected route step
- **PRD File**: PRD document created at docs/PRD/ by the create-prd step
- **TRD File**: TRD document created at docs/TRD/ by the create-trd step
- **Handoff Message**: Final message showing PRD path, TRD path, and implementation approval block

## Usage

```
/ensemble:feature <description> [--skip-refine] [--depth simple|medium|complex] [--no-auto-complexity] [--foreman]
```
