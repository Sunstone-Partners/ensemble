---
name: "ensemble:analyze-complexity"
description: "Score a work description and select Simple, Medium, or Complex planning depth before planning begins"
version: "1.0.0"
category: "planning"
last-updated: "2026-09-02"
argument-hint: "<description> [--depth simple|medium|complex] [--no-auto-complexity] [--foreman]"
model: "opus"
---
<!-- DO NOT EDIT - Generated from analyze-complexity.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Run deterministic local work-complexity analysis on a free-text work description,
display the numeric score and route rationale, then report the recommended
planning command path. Score bands are fixed: 1-3 Simple -> fix-issue,
4-6 Medium -> create-prd -> create-trd, and 7-10 Complex -> create-prd
-> refine-prd -> create-trd -> refine-trd. Complex output explicitly says
implementation remains blocked until the refined TRD is approved.

## Workflow

### Phase 1: Argument Parsing

**1. Parse description and flags**
   Parse $ARGUMENTS.

Supported flags:
- --depth simple|medium|complex: per-invocation override. This flag takes precedence over global config defaults and records both original AI classification and final selected classification.
- --no-auto-complexity: disable auto-complexity for this invocation. This flag takes precedence over global config autoComplexity settings and uses --depth when provided, else config.defaultDepth, else Medium.
- --foreman: non-interactive Foreman mode. Never prompt; use analyzer result or supplied override automatically.

Remove recognized flags from the remaining text. The remaining text is WORK_DESCRIPTION and must be preserved verbatim.
If WORK_DESCRIPTION is empty or blank, print exactly:
Work description is required before complexity analysis can select a planning path.
Then HALT without selecting a path and without invoking any downstream planning command.


### Phase 2: Complexity Analysis

**1. Run local analyzer**
   Call analyzeWorkComplexity from packages/product/lib/work-complexity-analyzer.js with:
{
  description: WORK_DESCRIPTION,
  overrideDepth: DEPTH_OVERRIDE when --depth is present,
  disableAuto: true when --no-auto-complexity is present,
  nonInteractive: true when --foreman is present,
  config: operator config when available
}

The analyzer output must include score, depth, path, factors, rationale,
uncertainty, overrideApplied, disabled, and originalClassification when
an override changes an automatic classification.


**2. Print score before planning begins**
   Before invoking or recommending any downstream planning command, print a block containing all of:
- Score: <score>/10
- Depth: <Simple|Medium|Complex>
- Path: <fix-issue OR create-prd -> create-trd OR create-prd -> refine-prd -> create-trd -> refine-trd>
- Rationale: <factor-level scope, dependencies, risk, teamSize evidence>
- Override applied: <yes|no>
- Auto disabled: <yes|no>
- Original classification: <score/depth/path> when an override is applied
- Uncertainty: <notes> when any factor is uncertain

This score/rationale/path output must appear before any downstream planning command begins.


### Phase 3: Route Selection

**1. Map score bands to planning paths**
   Use these exact score bands and route names:
- Scores 1, 2, or 3 -> Simple -> fix-issue path.
- Scores 4, 5, or 6 -> Medium -> create-prd -> create-trd path.
- Scores 7, 8, 9, or 10 -> Complex -> create-prd -> refine-prd -> create-trd -> refine-trd path.

For Complex, print this implementation block wording:
Implementation remains blocked until the refined TRD receives explicit approval.


**2. Preserve explicit manual paths**
   This adaptive entrypoint does not change direct invocations of:
- /ensemble:fix-issue
- /ensemble:create-prd
- /ensemble:create-trd
- /ensemble:refine-trd

Operators who want a manual path may call those commands directly or use --depth / --no-auto-complexity here.


### Phase 4: Foreman Report

**1. Write audit report in Foreman mode**
   If --foreman is present, produce a phase report containing:
- work description summary
- score
- rationale
- selected depth
- selected path
- override state
- disable state
- uncertainty
- original classification when present
- the route selected before planning begins

If FOREMAN_ARTIFACT_PATH is set and non-empty, write the phase report to that exact path, creating parent directories as needed, in addition to any repo-local report. Never invent, alter, or relocate the path. Never treat an unset FOREMAN_ARTIFACT_PATH as an error outside Foreman dispatch.


## Expected Output

**Format:** Complexity analysis and route recommendation

**Structure:**
- **Score**: Integer 1-10 complexity score
- **Depth**: Simple, Medium, or Complex planning depth
- **Path**: Exact downstream command path selected by the score band or override
- **Rationale**: Factor-level scope, dependencies, risk, and team-size evidence
- **Foreman Audit**: Non-interactive phase report written to exact FOREMAN_ARTIFACT_PATH when set

## Usage

```
/ensemble:analyze-complexity <description> [--depth simple|medium|complex] [--no-auto-complexity] [--foreman]
```
