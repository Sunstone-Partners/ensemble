---
document_id: PRD-2026-15aa5acd
label: prd-live-behavior-dispatch-autofix
status: Superseded
superseded_reason: Behavior-runtime/autofix-loop functionality removed from dev; retained on the pi-behaviors branch for future work.
---

# Superseded: Live Behavior Dispatch and Bounded Auto-Fix Loop

This PRD specified wiring a real Pi session event to a compiled behavior's invocation, including the bounded auto-fix loop (`packages/pi-extension/src/autofix-loop.ts`), issue-identity retry budgeting, and `policy.mode` (propose/auto/shadow) enforcement. That subsystem has been **removed from `dev`** and is retained on the `pi-behaviors` branch for future development.

To view this document and its implementation as last built on `dev`:

```sh
git show pi-behaviors:docs/PRD/PRD-2026-15aa5acd-live-behavior-dispatch-autofix.md
```

Or check out the branch directly:

```sh
git checkout pi-behaviors
```
