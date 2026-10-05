---
name: ensemble-issue
description: Dispatch to an issue-management subcommand by keyword (Codex skill for /ensemble:issue)
user-invocable: true
argument-hint: <fix|list> [subcommand args...]
---

# Ensemble Command: /ensemble:issue

This Codex skill mirrors the Ensemble slash command `/ensemble:issue`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

## Subcommands

- **`fix`** - Fix a bug or small issue end to end (analysis, planning, delegated implementation, PR). see the `ensemble-fix-issue` skill (`packages/codex/.codex/skills/commands/ensemble-fix-issue/SKILL.md`).
- **`list`** - List open Beads issues via br/bv for triage. see the `ensemble-list-issue` skill (`packages/codex/.codex/skills/commands/ensemble-list-issue/SKILL.md`).

<!-- DO NOT EDIT - Generated from issue.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Thin routing layer over issue-related subcommands. "fix" delegates to the existing
fix-issue workflow; "list" is a one-paragraph passthrough to br/bv for triage, per this
repo's AGENTS.md (br handles creating/modifying/closing beads, bv handles triage).

## Workflow

### Phase 1: Dispatch

**1. Route by first argument token**
   Parse $ARGUMENTS and hand off to the matching sibling command

   - Parse $ARGUMENTS. The first whitespace-delimited token selects a subcommand by its keyword below; the remaining text, unmodified, becomes that subcommand's own argument input.
   - If the first token matches a keyword below: read and follow that subcommand's own generated command file for this runtime (see the Subcommands section this file renders), passing the remaining argument text through unmodified. Do not re-implement its phases here.
   - If the first token matches no keyword, or $ARGUMENTS is empty: print the keyword table below (keyword + one-line description) and HALT without side effects.

## Usage

```
/ensemble:issue <fix|list> [subcommand args...]
```
