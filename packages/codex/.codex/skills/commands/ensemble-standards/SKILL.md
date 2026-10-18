---
name: ensemble-standards
description: Dispatch to a coding-standards subcommand by keyword (discover, inject, fold) (Codex skill for /ensemble:standards)
user-invocable: true
argument-hint: <discover|inject|fold> [subcommand args...]
---

# Ensemble Command: /ensemble:standards

This Codex skill mirrors the Ensemble slash command `/ensemble:standards`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

## Subcommands

- **`discover`** - Analyze the codebase and extract coding conventions into a standards/ directory with index.yml. see the `ensemble-discover-standards` skill (`packages/codex/.codex/skills/commands/ensemble-discover-standards/SKILL.md`).
- **`inject`** - Selectively inject relevant standards from standards/index.yml into agent context based on the current task. see the `ensemble-inject-standards` skill (`packages/codex/.codex/skills/commands/ensemble-inject-standards/SKILL.md`).
- **`fold`** - Optimize CLAUDE.md for token efficiency, standards discovery, and progressive context loading. see the `ensemble-fold-prompt` skill (`packages/codex/.codex/skills/commands/ensemble-fold-prompt/SKILL.md`).

<!-- DO NOT EDIT - Generated from standards.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Thin routing layer over the project coding-standards commands: discovering
conventions into a standards/ index, injecting the task-relevant subset into agent
context, and folding CLAUDE.md for token efficiency. Reads and follows the matching
sibling command's own generated file for this runtime, passing the rest of
$ARGUMENTS unchanged, and does not re-implement any of their phases.

## Workflow

### Phase 1: Dispatch

**1. Route by first argument token**
   Parse $ARGUMENTS and hand off to the matching sibling command

- Parse $ARGUMENTS. The first whitespace-delimited token selects a subcommand by its keyword below; the remaining text, unmodified, becomes that subcommand's own argument input.
- If the first token matches a keyword below: read and follow that subcommand's own generated command file for this runtime (see the Subcommands section this file renders), passing the remaining argument text through unmodified. Do not re-implement its phases here.
- If the first token matches no keyword, or $ARGUMENTS is empty: print the keyword table below (keyword + one-line description) and HALT without side effects.

## Usage

```
/ensemble:standards <discover|inject|fold> [subcommand args...]
```
