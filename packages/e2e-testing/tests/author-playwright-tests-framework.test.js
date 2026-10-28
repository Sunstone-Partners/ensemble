'use strict';

/**
 * Contract for the test-framework wiring in /ensemble:author-playwright-tests: the command detects the consuming
 * project's framework once, tells the authoring agent, and lands the test with spec-writer in that framework.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PKG = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(PKG, ...p), 'utf8');
const doc = yaml.load(read('commands', 'author-playwright-tests.yaml'));

const phase = (name) => doc.workflow.phases.find((p) => p.name === name);
const actions = (phaseName, title) => phase(phaseName).steps.find((s) => s.title === title).actions.map(String).join('\n');

describe('the framework is detected once, before any test is proposed', () => {
  const setup = actions('Execution Setup', 'Ensure the Screenshot Helper');

  test('Execution Setup detects it from the E2E project and defaults to NUnit', () => {
    expect(setup).toContain('detectE2eFrameworkInDir(');
    expect(setup).toContain('$E2E_LIB/e2e-framework.js');
    expect(setup).toContain('"nunit" when it returns null');
  });

  test('that setup runs before the proposals and the runs', () => {
    const names = doc.workflow.phases.map((p) => p.name);
    expect(names.indexOf('Execution Setup')).toBeLessThan(names.indexOf('REQ Batching and Delegation'));
  });
});

describe('the framework reaches the author and the writer', () => {
  test('the proposal request carries it, so an xUnit body builds its own page like the sibling tests', () => {
    const text = actions('REQ Batching and Delegation', 'Delegate the Proposal (Ground + Author, No Run) to @playwright-tester');
    expect(text).toContain('{acText, groundingDiff, acId, framework}');
    expect(text).toContain("framework is Phase 2 step 4's result");
    expect(text).toMatch(/xunit test builds its own page the way the project's sibling tests do/);
  });

  test('landing passes it to spec-writer and names what a new xUnit file needs', () => {
    const text = actions('Decision and Local Landing', 'Land the Confirmed, Passed Test');
    expect(text).toContain('specDetails.framework');
    expect(text).toContain('[Test] (nunit) or [Fact] (xunit)');
    expect(text).toContain('{collection, fixtureType} copied from a sibling spec class');
    expect(text).toMatch(/refuses to append the wrong framework to an existing file/);
  });

  test('the agent knows the field and what xunit means for the body', () => {
    const agent = read('agents', 'playwright-tester.yaml');
    expect(agent).toContain('Request {acText, groundingDiff, acId?, framework?}');
    expect(agent).toContain("framework 'xunit' means no PageTest `Page`");
  });
});

describe('the modules the command names exist', () => {
  test('e2e-framework.js is a real lib module the command resolves through $E2E_LIB', () => {
    expect(read('commands', 'author-playwright-tests.yaml')).toContain('$E2E_LIB/e2e-framework.js');
    expect(fs.existsSync(path.join(PKG, 'lib', 'e2e-framework.js'))).toBe(true);
  });
});
