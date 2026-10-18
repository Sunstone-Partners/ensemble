---
name: ensemble-standards
description: >-
  Thin routing layer over the project coding-standards commands: discovering
  conventions into a standards/ index, injecting the task-relevant subset into
  agent context, and folding CLAUDE.md for token efficiency. Reads and follows
  the matching sibling command's own generated file for this runtime, passing
  the rest of $ARGUMENTS unchanged, and does not re-implement any of their
  phases.
disable-model-invocation: true
---
<!-- Command: ensemble-standards | Version: 1.0.0 -->
<!-- Description: Dispatch to a coding-standards subcommand by keyword (discover, inject, fold) -->

# ensemble-standards

> **Mission:** Thin routing layer over the project coding-standards commands: discovering conventions into a standards/ index, injecting the task-relevant subset into agent context, and folding CLAUDE.md for token efficiency. Reads and follows the matching sibling command's own generated file for this runtime, passing the rest of $ARGUMENTS unchanged, and does not re-implement any of their phases.

## Subcommands

- **`discover`** - Analyze the codebase and extract coding conventions into a standards/ directory with index.yml. run `/ensemble-discover-standards` (`packages/pi/prompts/_hidden/ensemble-discover-standards.md`), passing the remaining arguments through as its $ARGUMENTS.
- **`inject`** - Selectively inject relevant standards from standards/index.yml into agent context based on the current task. run `/ensemble-inject-standards` (`packages/pi/prompts/_hidden/ensemble-inject-standards.md`), passing the remaining arguments through as its $ARGUMENTS.
- **`fold`** - Optimize CLAUDE.md for token efficiency, standards discovery, and progressive context loading. run `/ensemble-fold-prompt` (`packages/pi/prompts/ensemble-fold-prompt.md`), passing the remaining arguments through as its $ARGUMENTS.

## Phase 1: Dispatch

### Step 1: Route by first argument token

Parse $ARGUMENTS and hand off to the matching sibling command

**Actions:**
1. Parse $ARGUMENTS. The first whitespace-delimited token selects a subcommand by its keyword below; the remaining text, unmodified, becomes that subcommand's own argument input.
2. If the first token matches a keyword below: read and follow that subcommand's own generated command file for this runtime (see the Subcommands section this file renders), passing the remaining argument text through unmodified. Do not re-implement its phases here.
3. If the first token matches no keyword, or $ARGUMENTS is empty: print the keyword table below (keyword + one-line description) and HALT without side effects.
