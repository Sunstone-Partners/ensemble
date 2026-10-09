---
name: ensemble-prd
description: >-
  Thin routing layer over the existing create-prd / create-prd-meeting /
  refine-prd / refine-prd-meeting commands. Reads and follows the matching
  sibling command's own generated file for this runtime, passing the rest of
  $ARGUMENTS unchanged, and does not re-implement any of their phases.
disable-model-invocation: true
---
<!-- Command: ensemble-prd | Version: 1.0.0 -->
<!-- Description: Dispatch to a PRD-authoring or PRD-refinement subcommand by keyword -->

# ensemble-prd

> **Mission:** Thin routing layer over the existing create-prd / create-prd-meeting / refine-prd / refine-prd-meeting commands. Reads and follows the matching sibling command's own generated file for this runtime, passing the rest of $ARGUMENTS unchanged, and does not re-implement any of their phases.

## Subcommands

- **`create`** - Create a new PRD through a live structured interview. run `/ensemble-create-prd` (`packages/pi/prompts/ensemble-create-prd.md`), passing the remaining arguments through as its $ARGUMENTS.
- **`create-meeting`** - Create a PRD from a meeting summary instead of a live interview. run `/ensemble-create-prd-meeting` (`packages/pi/prompts/ensemble-create-prd-meeting.md`), passing the remaining arguments through as its $ARGUMENTS.
- **`refine`** - Refine an existing PRD with stakeholder feedback. run `/ensemble-refine-prd` (`packages/pi/prompts/ensemble-refine-prd.md`), passing the remaining arguments through as its $ARGUMENTS.
- **`refine-meeting`** - Refine an existing PRD using a meeting summary as the feedback source. run `/ensemble-refine-prd-meeting` (`packages/pi/prompts/ensemble-refine-prd-meeting.md`), passing the remaining arguments through as its $ARGUMENTS.

## Phase 1: Dispatch

### Step 1: Route by first argument token

Parse $ARGUMENTS and hand off to the matching sibling command

**Actions:**
1. Parse $ARGUMENTS. The first whitespace-delimited token selects a subcommand by its keyword below; the remaining text, unmodified, becomes that subcommand's own argument input.
2. If the first token matches a keyword below: read and follow that subcommand's own generated command file for this runtime (see the Subcommands section this file renders), passing the remaining argument text through unmodified. Do not re-implement its phases here.
3. If the first token matches no keyword, or $ARGUMENTS is empty: print the keyword table below (keyword + one-line description) and HALT without side effects.
