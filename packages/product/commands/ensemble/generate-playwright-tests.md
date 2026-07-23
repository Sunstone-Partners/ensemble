---
name: ensemble:generate-playwright-tests
description: Scaffold Playwright test-stub specs (one per requirement) from a PRD's acceptance criteria
version: 1.0.0
category: testing
last-updated: 2026-07-23
argument-hint: [prd-path] [--out <dir>] [--dry-run] [--force]
model: haiku
---
<!-- DO NOT EDIT - Generated from generate-playwright-tests.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Generate a Playwright test-stub suite from a PRD's acceptance criteria. Reuses
the same deterministic PRD parse and AC fingerprint (hashAc) that the Reqnroll
and Gherkin generators use, so the same PRD edit registers as drift consistently
across every generator. Emits one *.spec.ts file per requirement, with one
`test.describe` and one tagged, hashed `test()` per acceptance criterion --
Given/When/Then rendered as `test.step()` calls -- plus a .playwright-trace.json
manifest for drift detection. Every test starts red (test.fixme), which is the
correct test-first starting point before bodies are filled in. Spec files are
write-once: once a requirement's tests are filled in, a later PRD edit to a
sibling AC won't silently discard that work -- re-run with --force to
deliberately resync a requirement's file.

## Workflow

### Phase 1: Generate

**1. Resolve PRD**
   Determine the PRD to scaffold tests from

   - If the user passed a PRD path, use it; otherwise look under docs/PRD/ and ask which to use if ambiguous

**2. Run the generator**
   Invoke the deterministic CLI to scaffold the spec files

   - Resolve PLAYWRIGHT_CLI to first existing path among: ${CLAUDE_PLUGIN_ROOT}/lib/playwright-cli.js, packages/product/lib/playwright-cli.js. If missing, print error and HALT.
   - Run: node "$PLAYWRIGHT_CLI" generate <prd-path> --json
   - Pass through --out <dir> (default: e2e/), --dry-run, and --force as requested
   - The CLI writes <REQ-NNN>.spec.ts and .playwright-trace.json under <out>/<prd-stem>/
   - An existing <REQ-NNN>.spec.ts is preserved (write-once) unless --force is passed -- only pass --force when the user explicitly wants a requirement's tests reset

**3. Report results**
   Summarize the scaffold and the next move

   - Report the output directory, spec-file count, and total test count
   - List any spec files that were preserved (write-once) versus newly created
   - Echo parser warnings and flag any AC tagged @needs-clarification -- these stay non-executable until the PRD is fixed
   - Point the user to fill in the test.fixme() bodies test-first, or /ensemble:check-playwright-drift to audit coverage later

## Expected Output

**Format:** Playwright test-stub suite

**Structure:**
- **<out>/<prd-stem>/<REQ-NNN>.spec.ts**: One test.describe per requirement, one tagged/hashed test.fixme() per acceptance criterion
- **<out>/<prd-stem>/.playwright-trace.json**: AC fingerprint manifest used by check-playwright-drift

## Usage

```
/ensemble:generate-playwright-tests [prd-path] [--out <dir>] [--dry-run] [--force]
```
