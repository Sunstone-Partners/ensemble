# FIX_REPORT — permitter hook quoting + invalid `ask` decision

Run: `run-77d5281a42dd1b835aaf092c2366f316` · Task: `ensemble-pdf-f6a-permitter-hook-output` · Phase 1 (fix)
Base: `fe5aea4f` (dev)

STATUS: in progress

## Root cause

Two independent defects in the PermissionRequest hook shipped in the full bundle (verify pending):

1. `packages/full/hooks/hooks.json` — hook `command` is `${CLAUDE_PLUGIN_ROOT}/hooks/permitter.js` with no
   quoting. Other bundles in this repo (`packages/guards`, `packages/telemetry`, `packages/lifecycle-claude`)
   all quote their paths. An install path containing a space execs as two words → exit 127.
2. `packages/permitter/hooks/permitter.js` — emits `decision.behavior: "ask"` (lines ~63-68, returned on the
   fail-closed paths and on a denylist hit). Claude Code 2.1.322 accepts only `allow` / `deny` for a
   PermissionRequest hook, so every `ask` is an invalid response and a denylist hit never blocks.

## Change

TBD

## Tests

TBD

## Local verification

TBD

## Follow-ups

TBD

## Assumptions

TBD

## PR body

TBD
