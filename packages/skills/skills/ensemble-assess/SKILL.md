---
name: ensemble-assess
description: Single entry point for the ensemble-assessment skills. The first argument keyword (repo, team, config, report) loads the matching assessment skill by name and follows it; `repo --only <dimension>` runs one repository dimension through its leaf skill instead of the full parallel assessment. Passes the rest of $ARGUMENTS through unchanged and does not re-implement any assessment logic.
---

<!-- DO NOT EDIT - Generated from authoritative package sources by npm run generate:skills -->

First read [the execution contract](../../ensemble/CONTRACT.md).

Read and follow [the full skill](../../ensemble/packages/assessment/skills/ensemble-assess/SKILL.md); its relative resources resolve against that file. Pass the user's input as ARGUMENTS.

Required/optional capabilities: see ../../ensemble/manifest.json for this skill and check the concrete operations before execution.
