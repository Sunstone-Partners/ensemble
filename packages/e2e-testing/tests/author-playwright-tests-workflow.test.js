'use strict';

/**
 * TRD-030-TEST: structural completeness test guarding the orchestrator
 * wiring PR 5 (TRD-025 through TRD-030) added, against the exact regression
 * that was found in pre-merge verification -- every lib/*.js module built by
 * PR 2-4 was real and unit-tested, but none of them were ever referenced by
 * the orchestrator command (author-playwright-tests.yaml), so the shipped
 * command halted after the headed/headless prompt and did nothing further.
 *
 * This does not re-test any lib module's own logic (each already has its own
 * unit tests) -- it only asserts the orchestrator's workflow text actually
 * names every module from the TRD's Component Boundaries table, in the same
 * order as the TRD's own System Architecture pipeline diagram, and that no
 * step still reads as a deferred placeholder.
 */

const fs = require('fs');
const path = require('path');

const yamlPath = path.join(__dirname, '../commands/author-playwright-tests.yaml');
const text = fs.readFileSync(yamlPath, 'utf8');

// One entry per lib/*.js module in the TRD's Component Boundaries table
// (excluding index.js, which is plugin-skill boilerplate, not part of this
// pipeline), in the order each is first expected to appear per the TRD's
// System Architecture diagram.
const EXPECTED_MODULE_ORDER = [
  'pr-state',
  'prd-ac-parser',
  'implementation-grounding',
  'ac-gap-detector',
  'resume-scan',
  'session-summary',
  'qa-env-guard',
  'test-runner-mode',
  'req-batcher',
  'delegation-contract',
  'manual-ac-tracker',
  'ac-decision-loop',
  'grounded-marker-checker',
  'session-logger',
  'spec-writer',
  'traceability-tagger',
  'ado-test-plan',
  'ado-test-suite',
  'ado-test-case-sync',
  'ado-sync-resilience',
  'ac-gap-task-filer',
];

describe('author-playwright-tests.yaml orchestrator wiring (PR 5)', () => {
  test('every pipeline lib module is referenced by name', () => {
    for (const module of EXPECTED_MODULE_ORDER) {
      expect(text).toContain(module);
    }
  });

  test('every module is first referenced in pipeline order', () => {
    const firstIndex = EXPECTED_MODULE_ORDER.map((module) => text.indexOf(module));
    expect(firstIndex.every((index) => index !== -1)).toBe(true);

    for (let i = 1; i < firstIndex.length; i++) {
      expect(firstIndex[i]).toBeGreaterThan(firstIndex[i - 1]);
    }
  });

  test('delegates to @playwright-tester per the TRD-008/TRD-040 two-stage contract', () => {
    expect(text).toContain('agent: playwright-tester');
    expect(text).toContain('validateProposalRequest');
    expect(text).toContain('validateProposalResponse');
    expect(text).toContain('validateRunRequest');
    expect(text).toContain('validateRunResponse');
  });

  test('the pre-run decision happens before the confirmed test is ever run (TRD-040)', () => {
    const decisionIndex = text.indexOf("Record the QA Engineer's Pre-Run Decision");
    const runIndex = text.indexOf('Run the Confirmed Test');
    expect(decisionIndex).toBeGreaterThan(-1);
    expect(runIndex).toBeGreaterThan(-1);
    expect(decisionIndex).toBeLessThan(runIndex);
  });

  test('no step defers logic to "later TRD tasks" anymore', () => {
    expect(text).not.toMatch(/implemented in later TRD tasks/i);
    expect(text).not.toMatch(/placeholder step/i);
  });

  test('the full-session idempotence short-circuit runs before the REQ loop', () => {
    const idempotenceIndex = text.indexOf('isStoryFullyCovered');
    const reqBatchingIndex = text.indexOf('REQ Batching and Delegation');
    expect(idempotenceIndex).toBeGreaterThan(-1);
    expect(reqBatchingIndex).toBeGreaterThan(-1);
    expect(idempotenceIndex).toBeLessThan(reqBatchingIndex);
  });

  test('a landed test is never rolled back on ADO sync failure', () => {
    expect(text).toMatch(/NEVER rolled back/i);
  });
});

describe('helper modules resolve outside the ensemble monorepo (br-e2e-lib-path)', () => {
  test('no lib module is referenced by a bare CWD-relative monorepo path', () => {
    // The regression: every module was named as `packages/e2e-testing/lib/x.js`,
    // which only resolves when CWD is this monorepo. Run in a consuming repo
    // (e.g. an Azure-DevOps-hosted C# Playwright project) the very first action
    // failed, and the session reported the command "can't run here" -- masking
    // the fact that the modules ship inside the installed plugin.
    expect(text).not.toContain('packages/e2e-testing/lib/');
    expect(text).not.toContain('packages/e2e-testing/agents/');
  });

  test('E2E_LIB is resolved before the first module is used', () => {
    const resolveIndex = text.indexOf('Resolve E2E_LIB');
    expect(resolveIndex).toBeGreaterThan(-1);
    expect(text).toContain('${CLAUDE_PLUGIN_ROOT}/lib');

    const firstUse = text.indexOf('$E2E_LIB/');
    expect(firstUse).toBeGreaterThan(resolveIndex);
  });

  test('every module reference goes through $E2E_LIB', () => {
    for (const module of EXPECTED_MODULE_ORDER) {
      expect(text).toContain(`$E2E_LIB/${module}.js`);
    }
  });
});
