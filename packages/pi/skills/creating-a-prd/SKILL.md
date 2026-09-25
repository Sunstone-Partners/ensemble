---
name: creating-a-prd
description: >-
  Authoring a product requirements document. Use when the user says: "create a
  PRD", "write a PRD", "product requirements document", "write product
  requirements", "draft requirements", "spec out a feature".
version: 1.0.0
phrases:
  - create a PRD
  - write a PRD
  - product requirements document
  - write product requirements
  - draft requirements
  - spec out a feature
command: '/ensemble-create-prd'
---

## Mission

Front the `/ensemble-create-prd` command so a natural-language request reaches the same workflow a user gets by typing the slash command.

## Behavior

1. Run `/ensemble-create-prd`, passing along whatever the user described as the feature or problem.
2. Do not restate, summarize, or reimplement that command's steps here — it owns its own workflow, gates, and output contract.
3. If the user already invoked the slash command directly, this skill has nothing to add; stay out of the way.
