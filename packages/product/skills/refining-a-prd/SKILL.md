---
name: refining-a-prd
description: 'Revising an existing product requirements document. Use when the user says: "refine the PRD", "review the PRD", "update the PRD", "PRD feedback", "iterate on requirements".'
version: 1.0.0
phrases:
  - refine the PRD
  - review the PRD
  - update the PRD
  - PRD feedback
  - iterate on requirements
command: /ensemble:refine-prd
---

## Mission

Front the `/ensemble:refine-prd` command so a natural-language request reaches the same workflow a user gets by typing the slash command.

## Behavior

1. Run `/ensemble:refine-prd`, passing along whatever the user described as the feature or problem.
2. Do not restate, summarize, or reimplement that command's steps here — it owns its own workflow, gates, and output contract.
3. If the user already invoked the slash command directly, this skill has nothing to add; stay out of the way.
