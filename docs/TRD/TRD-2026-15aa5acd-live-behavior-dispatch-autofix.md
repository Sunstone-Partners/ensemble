---
document_id: TRD-2026-15aa5acd
label: trd-live-behavior-dispatch-autofix
kind: trd
prd_reference: PRD-2026-15aa5acd (docs/PRD/PRD-2026-15aa5acd-live-behavior-dispatch-autofix.md)
status: Superseded
superseded_reason: Behavior-runtime/autofix-loop functionality removed from dev; retained on the pi-behaviors branch for future work.
---

# Superseded: Live Behavior Dispatch and Bounded Auto-Fix Loop

This TRD specified the implementation of the live dispatch and bounded auto-fix loop (`packages/pi-extension/src/autofix-loop.ts`, `packages/pi-extension/src/issue-identity.ts`, `packages/agent-core/src/behavior/workspace-snapshot.ts`). That subsystem has been **removed from `dev`** and is retained on the `pi-behaviors` branch for future development.

To view this document and its implementation as last built on `dev`:

```sh
git show pi-behaviors:docs/TRD/TRD-2026-15aa5acd-live-behavior-dispatch-autofix.md
```

Or check out the branch directly:

```sh
git checkout pi-behaviors
```
