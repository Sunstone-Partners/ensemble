---
name: pr-review-eval
description: Add an escaped bug (incident or revert) to the reviewer eval set as a code-owner-confirmed case, and run the eval set when reviewer rules, prompts or model change - score each case, compare with the previous run, report regressions. Use when a maintainer says "add this incident to the eval set" or "run the reviewer eval"; do not use to review a PR (that is `pr-review-cycle`) or to compute cohort review metrics (that is `pr-review-cli.js metrics`).
---

<!-- DO NOT EDIT - Generated from authoritative package sources by npm run generate:skills -->

First read [the execution contract](../../ensemble/CONTRACT.md).

Read and follow [the full skill](../../ensemble/packages/development/skills/pr-review-eval/SKILL.md); its relative resources resolve against that file. Pass the user's input as ARGUMENTS.

Required/optional capabilities: see ../../ensemble/manifest.json for this skill and check the concrete operations before execution.
