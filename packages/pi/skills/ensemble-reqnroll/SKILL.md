---
name: ensemble-reqnroll
description: >-
  Thin routing layer over the PRD-to-executable-acceptance-test commands:
  Gherkin feature generation, PRD-vs-feature drift checking, Reqnroll + xUnit
  binding scaffolding, feature-vs-binding drift checking, and the red-gated
  test-first loop that drives scaffolded bindings to green. Reads and follows
  the matching sibling command's own generated file for this runtime, passing
  the rest of $ARGUMENTS unchanged, and does not re-implement any of their
  phases. The subcommands are reached only through this dispatcher.
disable-model-invocation: true
---
<!-- Command: ensemble-reqnroll | Version: 1.0.0 -->
<!-- Description: Dispatch to a PRD-to-Reqnroll acceptance-test subcommand by keyword (features, feature-drift, bindings, binding-drift, tdd) -->

# ensemble-reqnroll

> **Mission:** Thin routing layer over the PRD-to-executable-acceptance-test commands: Gherkin feature generation, PRD-vs-feature drift checking, Reqnroll + xUnit binding scaffolding, feature-vs-binding drift checking, and the red-gated test-first loop that drives scaffolded bindings to green. Reads and follows the matching sibling command's own generated file for this runtime, passing the rest of $ARGUMENTS unchanged, and does not re-implement any of their phases. The subcommands are reached only through this dispatcher.

## Subcommands

- **`features`** - Generate Gherkin .feature files and a traceability manifest from a PRD's acceptance criteria. run `/ensemble-generate-feature-tests` (`packages/pi/prompts/_hidden/ensemble-generate-feature-tests.md`), passing the remaining arguments through as its $ARGUMENTS.
- **`feature-drift`** - Detect drift between a PRD's acceptance criteria and its generated Gherkin feature files. run `/ensemble-check-feature-drift` (`packages/pi/prompts/_hidden/ensemble-check-feature-drift.md`), passing the remaining arguments through as its $ARGUMENTS.
- **`bindings`** - Scaffold a runnable Reqnroll + xUnit test project (features, step stubs, project files) from a PRD. run `/ensemble-generate-reqnroll-bindings` (`packages/pi/prompts/_hidden/ensemble-generate-reqnroll-bindings.md`), passing the remaining arguments through as its $ARGUMENTS.
- **`binding-drift`** - Detect drift between a PRD's acceptance-criteria steps and the Reqnroll step bindings on disk. run `/ensemble-check-binding-drift` (`packages/pi/prompts/_hidden/ensemble-check-binding-drift.md`), passing the remaining arguments through as its $ARGUMENTS.
- **`tdd`** - Drive PRD acceptance criteria to green via an outside-in, red-gated Reqnroll + xUnit test-first loop. run `/ensemble-reqnroll-tdd` (`packages/pi/prompts/_hidden/ensemble-reqnroll-tdd.md`), passing the remaining arguments through as its $ARGUMENTS.

## Phase 1: Dispatch

### Step 1: Route by first argument token

Parse $ARGUMENTS and hand off to the matching sibling command

**Actions:**
1. Parse $ARGUMENTS. The first whitespace-delimited token selects a subcommand by its keyword below; the remaining text, unmodified, becomes that subcommand's own argument input.
2. If the first token matches a keyword below: read and follow that subcommand's own generated command file for this runtime (see the Subcommands section this file renders), passing the remaining argument text through unmodified. Do not re-implement its phases here.
3. If the first token matches no keyword, or $ARGUMENTS is empty: print the keyword table below (keyword + one-line description) and HALT without side effects.
