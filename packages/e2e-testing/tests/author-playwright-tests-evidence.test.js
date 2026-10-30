'use strict';

/**
 * Contract for the screenshot evidence wiring in /ensemble:author-playwright-tests: the command asks for it at the right
 * moments (helper before the first Run, scope in every proposal, screenshot required on every run, attach after the sync),
 * the agent knows how to produce it, and the TypeScript skill no longer defaults to failure-only screenshots.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PKG = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(PKG, ...p), 'utf8');
const doc = yaml.load(read('commands', 'author-playwright-tests.yaml'));

const phase = (name) => doc.workflow.phases.find((p) => p.name === name);
const step = (phaseName, title) => phase(phaseName).steps.find((s) => s.title === title);
const actions = (phaseName, title) => step(phaseName, title).actions.map(String).join('\n');
const stepIndex = (phaseName, title) => phase(phaseName).steps.findIndex((s) => s.title === title);

describe('the helper is in place before the first Run', () => {
  test('Execution Setup has an "Ensure the Screenshot Helper" step, after the QA environment is verified', () => {
    expect(stepIndex('Execution Setup', 'Ensure the Screenshot Helper')).toBeGreaterThan(
      stepIndex('Execution Setup', 'Resolve and Verify the QA Environment')
    );
  });

  test('it resolves the evidence directory and writes the helper into the E2E project when missing', () => {
    const text = actions('Execution Setup', 'Ensure the Screenshot Helper');
    expect(text).toContain('resolveEvidenceDir(process.env) from $E2E_LIB/evidence-capture.js');
    expect(text).toContain('evidenceDir');
    expect(text).toContain('renderEvidenceHelper({namespace})');
    expect(text).toContain('EvidenceCapture.cs');
  });

  test('the phase that runs tests comes after the phase that sets this up', () => {
    const names = doc.workflow.phases.map((p) => p.name);
    expect(names.indexOf('Execution Setup')).toBeLessThan(names.indexOf('Decision and Local Landing'));
  });

  test('step numbering stays sequential from 1 in every phase', () => {
    for (const p of doc.workflow.phases) {
      expect(p.steps.map((s) => s.order)).toEqual(p.steps.map((_, i) => i + 1));
    }
  });
});

describe('every proposal and every run carries the screenshot requirement', () => {
  test('the proposal request carries acId, the scope is required, and a test without it is re-delegated', () => {
    const text = actions('REQ Batching and Delegation', 'Delegate the Proposal (Ground + Author, No Run) to @playwright-tester');
    expect(text).toContain('{acText, groundingDiff, acId}');
    expect(text).toContain('await using var evidence = EvidenceCapture.For(page, acId);');
    expect(text).toContain('validateProposalResponse(res, req)');
    expect(text).toMatch(/re-delegate once with that error/);
  });

  test('the run request carries acId and evidenceDir, and the response must carry the screenshot', () => {
    const text = actions('Decision and Local Landing', 'Run the Confirmed Test');
    expect(text).toContain('slowMoMs, acId, evidenceDir}');
    expect(text).toContain('validateRunResponse(res, req)');
    expect(text).toMatch(/pass or fail, with no screenshot at runResult\.evidencePath/);
    expect(text).toContain('screenshot path (runResult.evidencePath) are shown to the QA engineer');
  });

  test('every $E2E_LIB module the command names exists in the package', () => {
    const text = read('commands', 'author-playwright-tests.yaml');
    const modules = new Set([...text.matchAll(/\$E2E_LIB\/([a-z-]+)\.js/g)].map((m) => m[1]));
    expect(modules.has('evidence-capture')).toBe(true);
    for (const m of modules) expect(fs.existsSync(path.join(PKG, 'lib', `${m}.js`))).toBe(true);
  });
});

describe('the screenshot reaches the ADO Test Case without an improvised upload (AC-015-2)', () => {
  const text = actions('Azure DevOps Test Plan Sync', "Sync Each Landed Test's Steps as a Test Case");

  test('tries an MCP attachment tool, then the user-configured command, then reports the gap', () => {
    const attach = text.slice(text.indexOf('Attach the AC'));
    expect(attach.indexOf('ADO MCP attachment-create tool')).toBeGreaterThan(-1);
    expect(attach.indexOf('resolveAttachCommand(process.env)')).toBeGreaterThan(attach.indexOf('ADO MCP attachment-create tool'));
    expect(attach.indexOf('report the capability gap (AC-015-2)')).toBeGreaterThan(attach.indexOf('resolveAttachCommand(process.env)'));
    expect(attach).toContain('buildAttachCommand(template, {workItemId: testCaseId, path})');
  });

  test('it logs the outcome and never rolls back the landed test', () => {
    expect(text).toContain('type: "evidence-attach"');
    expect(text).toMatch(/a failed attach never rolls back the landed test/);
  });

  test('it runs after the sync that creates the Test Case it attaches to', () => {
    expect(text.indexOf('recordSyncedTestCase')).toBeLessThan(text.indexOf('Attach the AC'));
  });
});

describe('the playwright-tester agent knows how to produce the screenshot', () => {
  const agent = read('agents', 'playwright-tester.yaml');

  test('runs with E2E_EVIDENCE_DIR set and returns evidencePath for a pass and a fail', () => {
    expect(agent).toContain('End-State Screenshot Evidence');
    expect(agent).toContain('E2E_EVIDENCE_DIR');
    expect(agent).toContain('runResult.evidencePath for a pass and for a fail');
  });

  test('the proposal stage opens the scope and the contract shapes name the new fields', () => {
    expect(agent).toContain('await using var evidence = EvidenceCapture.For(page, acId)');
    expect(agent).toContain('Request {acText, groundingDiff, acId?}');
    expect(agent).toContain('slowMoMs?, acId?, evidenceDir?}');
    expect(agent).toContain('groundedMarkersChecked?, evidencePath?}');
  });

  test('no longer advertises artifact capture it never performed', () => {
    expect(agent).not.toContain('Generate traces, screenshots, and videos for debugging');
  });
});

describe('the TypeScript skill captures every test, not only failures', () => {
  test.each([
    ['SKILL.md', ['skills', 'writing-playwright-tests', 'SKILL.md']],
    ['REFERENCE.md', ['skills', 'writing-playwright-tests', 'REFERENCE.md']],
    ['config.template.ts', ['skills', 'writing-playwright-tests', 'templates', 'config.template.ts']],
  ])('%s sets screenshot: \'on\' and no longer only-on-failure', (_name, parts) => {
    const text = read(...parts);
    expect(text).toContain("screenshot: 'on'");
    expect(text).not.toContain('only-on-failure');
  });
});

describe('the new environment variables are documented', () => {
  test('docs/guides/environment-variables.md names both, with what they do', () => {
    const guide = fs.readFileSync(path.join(PKG, '..', '..', 'docs', 'guides', 'environment-variables.md'), 'utf8');
    expect(guide).toContain('E2E_EVIDENCE_DIR');
    expect(guide).toContain('E2E_EVIDENCE_ATTACH_CMD');
    expect(guide).toContain('{workItemId}');
    expect(guide).toContain('{path}');
  });
});
