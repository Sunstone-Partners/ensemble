---
name: staleness-gate
description: Detect whether a TRD is stale before implementation and invoke /ensemble:refine-trd to refresh it, halting if refinement fails. Use before implementing a TRD; not after implementation is underway without a resume check.
---

<!-- DO NOT EDIT - Generated from authoritative package sources by npm run generate:skills -->

First read [the execution contract](../../ensemble/CONTRACT.md).

Read and follow [the full skill](../../ensemble/packages/development/skills/staleness-gate/SKILL.md); its relative resources resolve against that file. Pass the user's input as ARGUMENTS.

Required/optional capabilities: see ../../ensemble/manifest.json for this skill and check the concrete operations before execution.
