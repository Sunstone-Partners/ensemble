---
name: pr-review-cycle
description: Deterministic local review, head-bound remote review and merge gate for a PR; a PR review never fixes, and fixing is a separate step, operator-selected unless pre-publication. Bounded-round status contract, resumable untracked review-state report. Use when a command needs REVIEW_COMPLETE/REVIEW_PENDING/REVIEW_BLOCKED before publishing or closing a PR; not for ad-hoc "review this diff" requests with no PR boundary (use `pr-review-remediation` directly).
---

<!-- DO NOT EDIT - Generated from authoritative package sources by npm run generate:skills -->

First read [the execution contract](../../ensemble/CONTRACT.md).

Read and follow [the full skill](../../ensemble/packages/development/skills/pr-review-cycle/SKILL.md); its relative resources resolve against that file. Pass the user's input as ARGUMENTS.

Required/optional capabilities: see ../../ensemble/manifest.json for this skill and check the concrete operations before execution.
