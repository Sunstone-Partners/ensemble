---
name: implementing-a-trd
description: 'Executing a technical requirements document. Use when the user says: "implement the TRD", "build the TRD", "start implementation", "execute the plan".'
version: 1.0.0
phrases:
  - implement the TRD
  - build the TRD
  - start implementation
  - execute the plan
command: /ensemble:implement-trd
---

## Mission

Front the `/ensemble:implement-trd` command so a natural-language request reaches the same workflow a user gets by typing the slash command.

## Behavior

1. Run `/ensemble:implement-trd`, passing along whatever the user described as the feature or problem.
2. Do not restate, summarize, or reimplement that command's steps here — it owns its own workflow, gates, and output contract.
3. If the user already invoked the slash command directly, this skill has nothing to add; stay out of the way.
