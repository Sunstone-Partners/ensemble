---
name: ensemble-reqnroll
description: Dispatch to a PRD-to-Reqnroll acceptance-test subcommand by keyword (features, feature-drift, bindings, binding-drift, tdd) (Codex skill for /ensemble:reqnroll)
user-invocable: true
argument-hint: <features|feature-drift|bindings|binding-drift|tdd> [subcommand args...]
---

# Ensemble Command: /ensemble:reqnroll

This Codex skill mirrors the Ensemble slash command `/ensemble:reqnroll`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

## Subcommands

- **`features`** - Generate Gherkin .feature files and a traceability manifest from a PRD's acceptance criteria. see the `ensemble-generate-feature-tests` skill (`packages/codex/.codex/skills/commands/ensemble-generate-feature-tests/SKILL.md`).
- **`feature-drift`** - Detect drift between a PRD's acceptance criteria and its generated Gherkin feature files. see the `ensemble-check-feature-drift` skill (`packages/codex/.codex/skills/commands/ensemble-check-feature-drift/SKILL.md`).
- **`bindings`** - Scaffold a runnable Reqnroll + xUnit test project (features, step stubs, project files) from a PRD. see the `ensemble-generate-reqnroll-bindings` skill (`packages/codex/.codex/skills/commands/ensemble-generate-reqnroll-bindings/SKILL.md`).
- **`binding-drift`** - Detect drift between a PRD's acceptance-criteria steps and the Reqnroll step bindings on disk. see the `ensemble-check-binding-drift` skill (`packages/codex/.codex/skills/commands/ensemble-check-binding-drift/SKILL.md`).
- **`tdd`** - Drive PRD acceptance criteria to green via an outside-in, red-gated Reqnroll + xUnit test-first loop. see the `ensemble-reqnroll-tdd` skill (`packages/codex/.codex/skills/commands/ensemble-reqnroll-tdd/SKILL.md`).

<!-- DO NOT EDIT - Generated from reqnroll.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Thin routing layer over the PRD-to-executable-acceptance-test commands: Gherkin
feature generation, PRD-vs-feature drift checking, Reqnroll + xUnit binding
scaffolding, feature-vs-binding drift checking, and the red-gated test-first loop
that drives scaffolded bindings to green. Reads and follows the matching sibling
command's own generated file for this runtime, passing the rest of $ARGUMENTS
unchanged, and does not re-implement any of their phases. The subcommands are
reached only through this dispatcher.

## Workflow

### Phase 1: Dispatch

**1. Route by first argument token**
   Parse $ARGUMENTS and hand off to the matching sibling command

- Parse $ARGUMENTS. The first whitespace-delimited token selects a subcommand by its keyword below; the remaining text, unmodified, becomes that subcommand's own argument input.
- If the first token matches a keyword below: read and follow that subcommand's own generated command file for this runtime (see the Subcommands section this file renders), passing the remaining argument text through unmodified. Do not re-implement its phases here.
- If the first token matches no keyword, or $ARGUMENTS is empty: print the keyword table below (keyword + one-line description) and HALT without side effects.

## Usage

```
/ensemble:reqnroll <features|feature-drift|bindings|binding-drift|tdd> [subcommand args...]
```
