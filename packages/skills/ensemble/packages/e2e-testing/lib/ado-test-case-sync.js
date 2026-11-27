'use strict';

/**
 * TRD-017: Test Case creation/update decision logic from ordered plain-text
 * step descriptions, for /ensemble:author-playwright-tests (REQ-007,
 * AC-007-1's Test Case half — the Test Suite half is ado-test-suite.js,
 * TRD-016, whose resolved `suiteId` this module's decisions carry through).
 *
 * *** TERMINOLOGY INCONSISTENCY (same pattern as TRD-014 / spec-writer.js) ***
 * The TRD's System Architecture diagram and this task's own title say "Test
 * Case creation/update from `test.step()` narration". `test.step(title,
 * callback)` is a `@playwright/test` (TypeScript/JS test runner) API — it has
 * no equivalent in Microsoft.Playwright's .NET/NUnit bindings, which
 * TRD-014/spec-writer.js already established what the consuming
 * application's E2E test project actually is (C# NUnit, `[TestCategory("E2E")]`, `AuthenticatedPageTest`/
 * `PageTest`). There is no C# `test.step()`.
 *
 * Resolution (same approach as TRD-014): treat "test.step() narration" as
 * meaning the SPIRIT of the AC, not the literal JS API name — an ordered list
 * of plain-text step descriptions associated with a test, however the
 * orchestrator/generator captured them (e.g. from the AC's Given/When/Then
 * breakdown, or from step-marker comments/`TestContext.WriteLine` calls the
 * C# test generator embeds). Capturing exactly how those strings get
 * extracted from a C# test body is the orchestrator's job, not this module's
 * — this module's input contract starts one step later, from an
 * already-extracted `steps: string[]`.
 *
 * CRITICAL boundary (same as ado-test-suite.js): Azure DevOps MCP tools
 * (`testplan_create_test_case`, `testplan_add_test_cases_to_suite` per this
 * TRD's architecture diagram) are only invocable by the orchestrating agent
 * at conversation time via the MCP protocol — there is no Node.js SDK/client
 * for them callable from a plain library module. So, like ado-test-suite.js,
 * this module does no I/O and no MCP client code — it is pure decision/
 * shaping logic over plain data:
 *
 *   1. planTestCaseSync - given an AC's id/text, its ordered step
 *      descriptions, the resolved suiteId (from ado-test-suite.js), and an
 *      optional already-known ADO Test Case id (per AC-007-2, detected via
 *      the `@ado-testcase:<id>` tag — TRD-018's job, not this module's),
 *      decide: create a new Test Case (`{action: 'create', ...}`) or update
 *      an existing one (`{action: 'update', testCaseId, ...}`) — and render
 *      each step description into ADO's action/expectedResult step shape.
 *   2. recordSyncedTestCase - given the MCP tool's response after the
 *      orchestrator actually created/updated the Test Case (and added it to
 *      the suite), validate/normalize it into this module's tracked
 *      `{testCaseId, title, suiteId}` shape.
 *
 * Title convention: `${acId}: ${acText}`, truncated to Azure DevOps' 255-
 * character work-item Title field limit (with a trailing `...`) when longer
 * — documented here so both the title's construction and its truncation stay
 * predictable and in one place (see buildTestCaseTitle).
 *
 * Step rendering (AC-007-1: "each step description rendered as a
 * plain-English step" — Azure DevOps Test Case steps are action/
 * expectedResult pairs): deliberately NOT clause-splitting NLP, per the
 * task's own guidance. Two simple, predictable delimiters are recognized, in
 * this order, on the raw step text:
 *   1. An explicit arrow (`->` or `=>`) splits action / expectedResult at the
 *      first occurrence.
 *   2. A `, then ...` clause (case-insensitive "then") splits action / the
 *      text after "then" as expectedResult, at the first occurrence.
 * Neither present -> the whole step text is the action, and expectedResult
 * defaults to the generic 'Passes'. No other clause detection is attempted
 * (see renderStep).
 *
 * Convention: plain functions over plain data, matching ado-test-suite.js /
 * delegation-contract.js — no class, no schema library, no injectable I/O
 * (there is no I/O to inject; the module boundary is "already-known data in,
 * a decision or normalized record out").
 */

const MAX_TITLE_LENGTH = 255; // Azure DevOps work item Title field limit
const DEFAULT_EXPECTED_RESULT = 'Passes';

/** Throw a single clear error listing every problem found, or return true. */
function assertNoErrors(label, errors) {
  if (errors.length > 0) {
    throw new Error(`Invalid ${label}: ${errors.join('; ')}`);
  }
  return true;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isNonEmptyStringOrNumber(value) {
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim() !== '';
}

/**
 * Deterministic Test Case title for an AC. Exported so callers (and this
 * module's own logic) always derive it the same way.
 *
 * @param {string} acId - e.g. "AC-007-1"
 * @param {string} acText - the AC's full Given/When/Then text
 * @returns {string} `${acId}: ${acText}`, truncated to 255 chars with a
 *   trailing `...` if the AC text makes it longer than ADO's Title limit
 */
function buildTestCaseTitle(acId, acText) {
  const raw = `${acId}: ${acText}`;
  if (raw.length <= MAX_TITLE_LENGTH) return raw;
  return `${raw.slice(0, MAX_TITLE_LENGTH - 3)}...`;
}

const ARROW_RE = /^(.*?)\s*(?:->|=>)\s*(.+)$/;
const COMMA_THEN_RE = /^(.*?),\s*then\b\s*(.+)$/i;

/**
 * Render one plain-text step description into Azure DevOps' action/
 * expectedResult step shape. See module header "Step rendering" for the
 * exact (deliberately simple, non-NLP) rule.
 *
 * @param {string} stepText - a single already-extracted step description
 * @returns {{action: string, expectedResult: string}}
 */
function renderStep(stepText) {
  const text = stepText.trim();

  const arrowMatch = text.match(ARROW_RE);
  if (arrowMatch && arrowMatch[1].trim() !== '' && arrowMatch[2].trim() !== '') {
    return { action: arrowMatch[1].trim(), expectedResult: arrowMatch[2].trim() };
  }

  const thenMatch = text.match(COMMA_THEN_RE);
  if (thenMatch && thenMatch[1].trim() !== '' && thenMatch[2].trim() !== '') {
    return { action: thenMatch[1].trim(), expectedResult: thenMatch[2].trim() };
  }

  return { action: text, expectedResult: DEFAULT_EXPECTED_RESULT };
}

/** Push one error per invalid entry of `steps` into `errors` (mutates). */
function validateSteps(steps, errors) {
  if (!Array.isArray(steps)) {
    errors.push('steps must be an array of non-empty strings');
    return;
  }
  if (steps.length === 0) {
    errors.push('steps must contain at least one step description');
    return;
  }
  steps.forEach((step, index) => {
    if (!isNonEmptyString(step)) {
      errors.push(`steps[${index}] must be a non-empty string`);
    }
  });
}

/**
 * Decide whether the AC's Test Case needs to be created or updated, and
 * render its ordered step descriptions into ADO's action/expectedResult
 * shape (AC-007-1).
 *
 * @param {object} input
 * @param {string} input.acId - e.g. "AC-007-1"
 * @param {string} input.acText - the AC's full text, for the title
 * @param {string[]} input.steps - ordered plain-text step descriptions
 *   (however the caller captured them — see module header)
 * @param {string|number} input.suiteId - the Test Suite id this Test Case
 *   belongs to (already resolved by ado-test-suite.js)
 * @param {string|number} [input.existingAdoTestCaseId] - present when
 *   re-syncing an already-tagged test (AC-007-2); detecting/passing this in
 *   is TRD-018's job, not this module's — it only branches on presence
 * @returns {{action: 'create', title: string, steps: {action: string, expectedResult: string}[], suiteId: string}
 *          |{action: 'update', testCaseId: string, title: string, steps: {action: string, expectedResult: string}[], suiteId: string}}
 * @throws {Error} listing every missing/invalid field, when input is invalid
 */
function planTestCaseSync(input) {
  const errors = [];

  if (!input || typeof input !== 'object') {
    return assertNoErrors('planTestCaseSync input', ['input must be an object']);
  }

  if (!isNonEmptyString(input.acId)) {
    errors.push('acId must be a non-empty string');
  }
  if (!isNonEmptyString(input.acText)) {
    errors.push('acText must be a non-empty string');
  }
  validateSteps(input.steps, errors);
  if (!isNonEmptyStringOrNumber(input.suiteId)) {
    errors.push('suiteId must be a non-empty string or number');
  }
  if (
    input.existingAdoTestCaseId !== undefined &&
    !isNonEmptyStringOrNumber(input.existingAdoTestCaseId)
  ) {
    errors.push('existingAdoTestCaseId must be a non-empty string or number when present');
  }

  assertNoErrors('planTestCaseSync input', errors);

  const title = buildTestCaseTitle(input.acId.trim(), input.acText.trim());
  const steps = input.steps.map((step) => renderStep(step));
  const suiteId = String(input.suiteId).trim();

  if (input.existingAdoTestCaseId !== undefined) {
    return {
      action: 'update',
      testCaseId: String(input.existingAdoTestCaseId).trim(),
      title,
      steps,
      suiteId,
    };
  }

  return { action: 'create', title, steps, suiteId };
}

/**
 * Validate/normalize the MCP tool's response after the orchestrator actually
 * created or updated a Test Case (and added it to the suite via
 * `testplan_create_test_case`/`testplan_add_test_cases_to_suite`).
 *
 * @param {{action: 'create'|'update', title: string, suiteId: string}} decision
 *   - the decision this module previously returned from planTestCaseSync
 * @param {{id: string|number, title?: string}} mcpResponse - the MCP tool's response
 * @returns {{testCaseId: string, title: string, suiteId: string}} normalized, tracked Test Case record
 * @throws {Error} if `decision` isn't a decision from planTestCaseSync, or `mcpResponse` lacks a usable id
 */
function recordSyncedTestCase(decision, mcpResponse) {
  if (!decision || typeof decision !== 'object' || (decision.action !== 'create' && decision.action !== 'update')) {
    throw new Error(
      "recordSyncedTestCase requires the decision returned by planTestCaseSync ('create' or 'update')."
    );
  }
  if (!isNonEmptyString(decision.title)) {
    throw new Error('decision.title must be a non-empty string');
  }
  if (!isNonEmptyStringOrNumber(decision.suiteId)) {
    throw new Error('decision.suiteId must be a non-empty string or number');
  }

  const errors = [];
  if (!mcpResponse || typeof mcpResponse !== 'object') {
    errors.push('mcpResponse must be an object');
  } else {
    if (!isNonEmptyStringOrNumber(mcpResponse.id)) {
      errors.push('mcpResponse.id must be a non-empty string or number');
    }
    if (mcpResponse.title !== undefined && typeof mcpResponse.title !== 'string') {
      errors.push('mcpResponse.title must be a string when present');
    }
  }
  assertNoErrors('mcpResponse', errors);

  return {
    testCaseId: String(mcpResponse.id).trim(),
    title: (mcpResponse.title && mcpResponse.title.trim()) || decision.title,
    suiteId: String(decision.suiteId).trim(),
  };
}

module.exports = {
  buildTestCaseTitle,
  renderStep,
  planTestCaseSync,
  recordSyncedTestCase,
};

// ponytail self-check: `node packages/e2e-testing/lib/ado-test-case-sync.js`
// exercises title building/truncation, step rendering (arrow, comma-then,
// plain default), the create/update decision, and recordSyncedTestCase's
// normalization/validation — TRD-017-TEST is a later, separate task per the
// TRD's dependency graph, so this is interim/only coverage until then.
if (require.main === module) {
  const assert = require('assert');

  // --- buildTestCaseTitle ---
  assert.strictEqual(buildTestCaseTitle('AC-007-1', 'Short text'), 'AC-007-1: Short text');
  const longTitle = buildTestCaseTitle('AC-001-1', 'x'.repeat(300));
  assert.strictEqual(longTitle.length, 255);
  assert.ok(longTitle.endsWith('...'));

  // --- renderStep: arrow, comma-then, and plain-default cases ---
  assert.deepStrictEqual(renderStep('Submit the form -> a confirmation banner is shown'), {
    action: 'Submit the form',
    expectedResult: 'a confirmation banner is shown',
  });
  assert.deepStrictEqual(renderStep('Fill in the claim ID field, then the search results update'), {
    action: 'Fill in the claim ID field',
    expectedResult: 'the search results update',
  });
  assert.deepStrictEqual(renderStep('Click the "Submit" button'), {
    action: 'Click the "Submit" button',
    expectedResult: 'Passes',
  });

  // --- planTestCaseSync: create decision (no existingAdoTestCaseId) ---
  const createDecision = planTestCaseSync({
    acId: 'AC-007-1',
    acText: 'Given a test has been confirmed passing, when synced, then a Test Case exists.',
    steps: ['Click the "Submit" button', 'Submit the form -> a confirmation banner is shown'],
    suiteId: 42,
  });
  assert.strictEqual(createDecision.action, 'create');
  assert.strictEqual(createDecision.testCaseId, undefined);
  assert.strictEqual(createDecision.suiteId, '42');
  assert.strictEqual(createDecision.steps.length, 2);
  assert.strictEqual(createDecision.steps[1].expectedResult, 'a confirmation banner is shown');
  assert.ok(createDecision.title.startsWith('AC-007-1:'));

  // --- planTestCaseSync: update decision (existingAdoTestCaseId present, AC-007-2) ---
  const updateDecision = planTestCaseSync({
    acId: 'AC-007-2',
    acText: 'Given a test is later modified, when re-synced, then the same Test Case is updated.',
    steps: ['Re-run the test'],
    suiteId: '42',
    existingAdoTestCaseId: 555,
  });
  assert.deepStrictEqual(updateDecision, {
    action: 'update',
    testCaseId: '555',
    title: 'AC-007-2: Given a test is later modified, when re-synced, then the same Test Case is updated.',
    steps: [{ action: 'Re-run the test', expectedResult: 'Passes' }],
    suiteId: '42',
  });

  // --- planTestCaseSync: invalid inputs collect every error, never a silent default ---
  assert.throws(() => planTestCaseSync({}), /acId.*acText.*steps.*suiteId/s);
  assert.throws(
    () => planTestCaseSync({ acId: 'A', acText: 'B', steps: [], suiteId: 1 }),
    /steps must contain at least one step description/
  );
  assert.throws(
    () => planTestCaseSync({ acId: 'A', acText: 'B', steps: ['ok', ''], suiteId: 1 }),
    /steps\[1\] must be a non-empty string/
  );
  assert.throws(
    () => planTestCaseSync({ acId: 'A', acText: 'B', steps: ['ok'], suiteId: 1, existingAdoTestCaseId: '' }),
    /existingAdoTestCaseId must be a non-empty string or number/
  );

  // --- recordSyncedTestCase: normalizes a valid MCP response ---
  assert.deepStrictEqual(recordSyncedTestCase(createDecision, { id: 999, title: 'AC-007-1: Renamed by ADO' }), {
    testCaseId: '999',
    title: 'AC-007-1: Renamed by ADO',
    suiteId: '42',
  });

  // falls back to the decision's title if the MCP response omits title
  assert.deepStrictEqual(recordSyncedTestCase(createDecision, { id: 999 }), {
    testCaseId: '999',
    title: createDecision.title,
    suiteId: '42',
  });

  // works for an 'update' decision too
  assert.deepStrictEqual(recordSyncedTestCase(updateDecision, { id: 555 }), {
    testCaseId: '555',
    title: updateDecision.title,
    suiteId: '42',
  });

  // rejects a non-decision (e.g. a plain object without a valid action)
  assert.throws(
    () => recordSyncedTestCase({ title: 'X', suiteId: '1' }, { id: 1 }),
    /requires the decision returned by planTestCaseSync/
  );

  // rejects an mcpResponse with no usable id
  assert.throws(() => recordSyncedTestCase(createDecision, {}), /mcpResponse\.id must be a non-empty string or number/);
  assert.throws(() => recordSyncedTestCase(createDecision, null), /mcpResponse must be an object/);

  console.log('ado-test-case-sync.js self-check passed');
}
