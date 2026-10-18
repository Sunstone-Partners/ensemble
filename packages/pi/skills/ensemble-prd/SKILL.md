---
name: ensemble-prd
description: >-
  Thin routing layer over the existing create-prd / refine-prd commands. Reads
  and follows the matching sibling command's own generated file for this
  runtime, passing the rest of $ARGUMENTS unchanged, and does not re-implement
  any of their phases. Meeting-sourced drafting and refinement are the
  --from-meeting flag on those two commands, not separate keywords: `create
  --from-meeting <summary>` and `refine <prd-path> --from-meeting <summary>`.
disable-model-invocation: true
---
<!-- Command: ensemble-prd | Version: 1.1.0 -->
<!-- Description: Dispatch to a PRD-authoring or PRD-refinement subcommand by keyword -->

# ensemble-prd

> **Mission:** Thin routing layer over the existing create-prd / refine-prd commands. Reads and follows the matching sibling command's own generated file for this runtime, passing the rest of $ARGUMENTS unchanged, and does not re-implement any of their phases. Meeting-sourced drafting and refinement are the --from-meeting flag on those two commands, not separate keywords: `create --from-meeting <summary>` and `refine <prd-path> --from-meeting <summary>`.

## Subcommands

- **`create`** - Create a new PRD through a live structured interview, or from a meeting summary with --from-meeting. run `/ensemble-create-prd` (`packages/pi/prompts/ensemble-create-prd.md`), passing the remaining arguments through as its $ARGUMENTS.
- **`refine`** - Refine an existing PRD with stakeholder feedback, or with a meeting summary as the feedback source via --from-meeting. run `/ensemble-refine-prd` (`packages/pi/prompts/ensemble-refine-prd.md`), passing the remaining arguments through as its $ARGUMENTS.

## Phase 1: Dispatch

### Step 1: Route by first argument token

Parse $ARGUMENTS and hand off to the matching sibling command

**Actions:**
1. Parse $ARGUMENTS. The first whitespace-delimited token selects a subcommand by its keyword below; the remaining text, unmodified, becomes that subcommand's own argument input.
2. If the first token matches a keyword below: read and follow that subcommand's own generated command file for this runtime (see the Subcommands section this file renders), passing the remaining argument text through unmodified. Do not re-implement its phases here.
3. If the first token matches no keyword, or $ARGUMENTS is empty: print the keyword table below (keyword + one-line description) and HALT without side effects.
