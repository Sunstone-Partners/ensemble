---
name: ensemble-list-issue
description: >-
  Thin passthrough with no ensemble-specific workflow, per AGENTS.md's existing
  br/bv ownership of listing and triage. Integration section.
disable-model-invocation: true
---
<!-- Command: ensemble-list-issue | Version: 1.0.0 -->
<!-- Description: List open Beads issues for triage using this repo's standard br/bv CLI tools -->

# ensemble-list-issue

> **Mission:** Thin passthrough with no ensemble-specific workflow, per AGENTS.md's existing br/bv ownership of listing and triage. Integration section.

## Phase 1: Beads Work Discovery

### Step 1: Run br/bv listing for ranked or flat output

Run `br list --status=open --json` for a flat list, or `bv --robot-triage` for ranked/scored triage output, per the caller's preference (default to `br list --status=open --json` if $ARGUMENTS is empty).

**Actions:**
1. Present the result to the user as-is. Do not create, modify, or close any issues. Do not invoke bare `bv` without a --robot-* flag (it launches a blocking interactive TUI).
