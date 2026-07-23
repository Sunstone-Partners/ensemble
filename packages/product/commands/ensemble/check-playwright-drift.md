---
name: ensemble:check-playwright-drift
description: Detect drift between a PRD's acceptance criteria and the Playwright spec files on disk
version: 1.0.0
category: testing
last-updated: 2026-07-23
argument-hint: [prd-path] [--out <dir>]
model: haiku
---
<!-- DO NOT EDIT - Generated from check-playwright-drift.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Re-derive the AC inventory from a PRD's current acceptance criteria and compare
it against the .playwright-trace.json manifest recorded the last time specs
were generated. Reports ADDED (new AC, no spec yet), REMOVED (spec exists, AC
gone from the PRD), and CHANGED (AC text edited since the spec was generated)
entries. This is the Playwright-side counterpart to /ensemble:check-binding-drift
and /ensemble:check-feature-drift -- same drift.js comparator, same manifest
shape, applied to the Playwright output tree. The CLI exit code (0 in-sync, 2
drift) lets the same check gate CI or a pre-commit hook.

## Workflow

### Phase 1: Check

**1. Resolve PRD and output directory**
   Determine the PRD and the e2e/ tree whose manifest to audit

   - If the user passed a PRD path, use it; otherwise look under docs/PRD/ and ask which to check
   - Pass through --out <dir> (default: e2e/) so the correct manifest is located

**2. Run the drift check**
   Invoke the deterministic CLI to diff PRD ACs against the manifest

   - Resolve PLAYWRIGHT_CLI to first existing path among: ${CLAUDE_PLUGIN_ROOT}/lib/playwright-cli.js, packages/product/lib/playwright-cli.js. If missing, print error and HALT.
   - Run: node "$PLAYWRIGHT_CLI" check-drift <prd-path> --json
   - Interpret exit code: 0 = IN_SYNC, 2 = drift detected, 1 = no manifest generated yet

**3. Report and recommend**
   Explain the drift and how to resolve it

   - If IN_SYNC: confirm the spec files cover the PRD's acceptance criteria
   - If ADDED: list the new ACs needing spec files -- re-run /ensemble:generate-playwright-tests to add them
   - If REMOVED: list spec files whose acceptance criterion was deleted from the PRD -- remove or repurpose them
   - If CHANGED: list ACs whose wording changed since generation -- re-run /ensemble:generate-playwright-tests to resync (this overwrites the spec's Given/When/Then steps)
   - If no manifest exists yet: tell the user to run /ensemble:generate-playwright-tests first

## Expected Output

**Format:** Playwright drift report

**Structure:**
- **Drift status**: IN_SYNC, or the lists of ADDED, REMOVED, and CHANGED acceptance criteria

## Usage

```
/ensemble:check-playwright-drift [prd-path] [--out <dir>]
```
