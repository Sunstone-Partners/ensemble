# FIX_REPORT — ensemble-pdf-f6a2-permitter-hook-impl

Status: **in progress** (phase 1, `fix`). Root-cause recon done; failing-first run pending.

## Root cause

Unknown yet — being confirmed now. Two defects named in the task:

1. `packages/full/hooks/hooks.json` registers the PermissionRequest hook command unquoted (`${CLAUDE_PLUGIN_ROOT}/hooks/permitter.js`), so an install path containing a space execs as two shell words → exit 127.
2. `packages/permitter/hooks/permitter.js` emits `decision.behavior: 'ask'` on every fail-closed/defer path, which Claude Code (2.1.322) does not accept for a PermissionRequest hook (only `allow` | `deny`). Denylist hits were routed to `ask`, so a denylist hit never blocked.

## Change

TBD

## Tests

TBD (will record red run of `packages/permitter/tests/hook-contract.test.js`, pulled unchanged from `origin/wip/pdf-f6a-hook-contract-tests`).

## Local verification

TBD

## Follow-ups

TBD

## Assumptions

TBD

## PR body

TBD
