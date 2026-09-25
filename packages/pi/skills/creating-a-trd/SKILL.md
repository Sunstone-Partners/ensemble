---
name: creating-a-trd
description: >-
  Authoring a technical requirements document. Use when the user says: "create a
  TRD", "write a TRD", "technical requirements document", "technical design
  doc", "how should we build this".
version: 1.0.0
phrases:
  - create a TRD
  - write a TRD
  - technical requirements document
  - technical design doc
  - how should we build this
command: '/ensemble-create-trd'
---

## Mission

Front the `/ensemble-create-trd` command so a natural-language request reaches the same workflow a user gets by typing the slash command.

## Behavior

1. Run `/ensemble-create-trd`, passing along whatever the user described as the feature or problem.
2. Do not restate, summarize, or reimplement that command's steps here — it owns its own workflow, gates, and output contract.
3. If the user already invoked the slash command directly, this skill has nothing to add; stay out of the way.
