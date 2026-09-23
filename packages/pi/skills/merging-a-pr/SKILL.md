---
name: merging-a-pr
description: >-
  Getting a pull request merged. Use when the user says: "merge the PR", "get
  this PR green", "land the PR", "fix CI", "the PR is failing", "address review
  comments".
version: 1.0.0
phrases:
  - merge the PR
  - get this PR green
  - land the PR
  - fix CI
  - the PR is failing
  - address review comments
command: '/ensemble-pr-merge'
---

## Mission

Front the `/ensemble-pr-merge` command so a natural-language request reaches the same workflow a user gets by typing the slash command.

## Behavior

1. Run `/ensemble-pr-merge`, passing along whatever the user described as the feature or problem.
2. Do not restate, summarize, or reimplement that command's steps here — it owns its own workflow, gates, and output contract.
3. If the user already invoked the slash command directly, this skill has nothing to add; stay out of the way.
