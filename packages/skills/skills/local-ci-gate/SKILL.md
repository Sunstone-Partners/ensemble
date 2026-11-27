---
name: local-ci-gate
description: Run or check the local CI gate for a PR head. Runs ci:local in a clean clone at the exact head SHA via the runner, posts a commit status with the maintainer's own gh login, and decides merge-readiness; verified hosted results for that head may stand in. Use before merging a PR in a repo with .ensemble/local-ci.yaml; not for hosted-CI debugging.
---

<!-- DO NOT EDIT - Generated from authoritative package sources by npm run generate:skills -->

First read [the execution contract](../../ensemble/CONTRACT.md).

Read and follow [the full skill](../../ensemble/packages/development/skills/local-ci-gate/SKILL.md); its relative resources resolve against that file. Pass the user's input as ARGUMENTS.

Required/optional capabilities: see ../../ensemble/manifest.json for this skill and check the concrete operations before execution.
