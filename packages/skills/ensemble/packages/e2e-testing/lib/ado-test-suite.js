'use strict';

/**
 * TRD-016: resolve-or-create decision logic for the story's Azure DevOps
 * Test Suite, for /ensemble:author-playwright-tests (REQ-007, AC-007-1's
 * Test Suite half).
 *
 * CRITICAL boundary this module is designed around: Azure DevOps MCP tools
 * (the `testplan_*` family — `testplan_list_test_suites`,
 * `testplan_create_test_suite`, etc.) are only invocable by an AI agent at
 * conversation time via the MCP protocol. There is no Node.js SDK/client for
 * them callable from a plain library module like this one (unlike `gh` in
 * pr-state.js or `git` in implementation-grounding.js, which are real CLI
 * binaries this package can shell out to). So this module does no I/O, no
 * shell-out, no MCP client code — it is pure decision/shaping logic over
 * plain data the orchestrator already fetched or received:
 *
 *   1. resolveOrCreateTestSuite - given the work item id, story title, the
 *      resolved Test Plan id (TRD-038's `ado-test-plan.js` — every Test Suite
 *      belongs to a plan; `testplan_list_test_suites`/`testplan_create_test_suite`
 *      both require one), and a list of existing suites the orchestrator
 *      already fetched (e.g. via `testplan_list_test_suites`), decide: does a
 *      suite for this work item already exist (`{action: 'resolve', ...}`),
 *      or does the orchestrator need to call the
 *      `testplan_create_test_suite`-equivalent MCP tool (`{action: 'create', ...}`)?
 *   2. recordCreatedSuite - given the MCP tool's response after the
 *      orchestrator actually created a suite, validate/normalize it into
 *      this module's tracked `{suiteId, suiteName, workItemId, planId}` shape.
 *
 * Suite naming convention (deterministic, used both to name a new suite and
 * to recognize an existing one by name when it has no stored `workItemId`
 * link — see matching notes on resolveOrCreateTestSuite): `Story
 * {workItemId} - {storyTitle}`, e.g. `Story 12345 - Claim intake validation`.
 *
 * TRD-039 (found live-dogfooding this feature: `resolveOrCreateTestSuite`
 * silently returned `action: 'create'` the moment no suite matched, with no
 * path for a human to say "actually, use this other suite instead"):
 * `input.selectedSuiteId` lets the orchestrator pass through a suite the QA
 * engineer explicitly chose to reuse — after being asked, per this TRD's own
 * QA-environment-verification precedent of confirming rather than silently
 * assuming. A selection always wins over the deterministic workItemId/name
 * match, since the QA engineer may be pointing at a suite this tool didn't
 * create and wouldn't otherwise recognize.
 *
 * Convention: plain functions over plain data, matching this package's style
 * (delegation-contract.js, manual-ac-tracker.js) — no class, no schema
 * library, no injectable I/O (there is no I/O to inject; the module
 * boundary itself is "already-fetched/already-returned data in, a decision
 * or normalized record out").
 */

/** Throw a single clear error listing every problem found, or return true. */
function assertNoErrors(label, errors) {
  if (errors.length > 0) {
    throw new Error(`Invalid ${label}: ${errors.join('; ')}`);
  }
  return true;
}

/**
 * Deterministic suite name for a story's work item. Exported so callers
 * (and this module's own matching logic) always derive it the same way.
 *
 * @param {string} workItemId
 * @param {string} storyTitle
 * @returns {string}
 */
function buildSuiteName(workItemId, storyTitle) {
  return `Story ${workItemId} - ${storyTitle}`;
}

/**
 * Validate one entry of `existingSuites`. Deliberately lenient about extra
 * fields (the orchestrator passes through whatever the MCP list call
 * returned) — only `id` is required, since a match with no usable id is
 * useless to the caller.
 *
 * @param {*} suite
 * @param {number} index
 * @returns {string[]} errors found (empty if valid)
 */
function validateExistingSuiteEntry(suite, index) {
  const errors = [];
  if (!suite || typeof suite !== 'object') {
    errors.push(`existingSuites[${index}] must be an object`);
    return errors;
  }
  if (
    (typeof suite.id !== 'string' && typeof suite.id !== 'number') ||
    String(suite.id).trim() === ''
  ) {
    errors.push(`existingSuites[${index}].id must be a non-empty string or number`);
  }
  if (suite.name !== undefined && typeof suite.name !== 'string') {
    errors.push(`existingSuites[${index}].name must be a string when present`);
  }
  if (
    suite.workItemId !== undefined &&
    typeof suite.workItemId !== 'string' &&
    typeof suite.workItemId !== 'number'
  ) {
    errors.push(`existingSuites[${index}].workItemId must be a string or number when present`);
  }
  return errors;
}

/**
 * Decide whether the story's Test Suite already exists (resolve) or needs to
 * be created, given the resolved Test Plan id and a list of suites the
 * orchestrator already fetched (both plan-scoped — see TRD-038's
 * `ado-test-plan.js`).
 *
 * Matching order:
 *   0. `input.selectedSuiteId`, when present — the QA engineer explicitly
 *      chose to reuse this suite after being asked (TRD-039); their choice
 *      always wins over the automatic matches below, since they may be
 *      pointing at a suite this tool didn't create and wouldn't otherwise
 *      recognize.
 *   1. An existing suite whose `workItemId` matches (string-compared, so
 *      `12345` and `'12345'` are equivalent) — the authoritative link.
 *   2. Failing that, an existing suite whose `name` exactly equals this
 *      module's deterministic naming convention — a fallback for suites that
 *      don't carry a `workItemId` field (e.g. Azure DevOps static suites
 *      that aren't a requirement-based suite), but were plainly created by
 *      this same tool for this same story.
 * No match on any of the above -> `{action: 'create', ...}`. TRD-039: the
 * orchestrator must NOT treat this as permission to create outright — it
 * must first confirm with the QA engineer (offer the existing suites list as
 * an alternative), and only call the `testplan_create_test_suite`-equivalent
 * MCP tool once they confirm creating a new one (or re-call this function
 * with `selectedSuiteId` if they pick an existing suite instead).
 *
 * @param {object} input
 * @param {string|number} input.planId - the resolved Test Plan id every Test
 *   Suite call is scoped to (from `ado-test-plan.js`'s `resolveOrCreateTestPlan`/
 *   `recordCreatedPlan`)
 * @param {string|number} input.workItemId - the application's work item (Story) id
 * @param {string} input.storyTitle - the story's title, for the suite name
 * @param {Array<{id: string|number, name?: string, workItemId?: string|number}>} input.existingSuites
 *   - suites already fetched by the orchestrator (e.g. via `testplan_list_test_suites`)
 * @param {string|number} [input.selectedSuiteId] - an existing suite's id the
 *   QA engineer chose to reuse instead of creating a new one; must match one
 *   of `existingSuites`
 * @returns {{action: 'resolve', planId: string, suiteId: string, suiteName: string, workItemId: string}
 *          |{action: 'create', planId: string, suiteName: string, workItemId: string}}
 * @throws {Error} listing every missing/invalid field, when input is invalid
 */
function resolveOrCreateTestSuite(input) {
  const errors = [];

  if (!input || typeof input !== 'object') {
    return assertNoErrors('resolveOrCreateTestSuite input', ['input must be an object']);
  }

  if ((typeof input.planId !== 'string' && typeof input.planId !== 'number') || String(input.planId).trim() === '') {
    errors.push(
      'planId must be a non-empty string or number — every Test Suite belongs to a Test Plan; resolve or ' +
        'create one first (see ado-test-plan.js)'
    );
  }
  if (
    (typeof input.workItemId !== 'string' && typeof input.workItemId !== 'number') ||
    String(input.workItemId).trim() === ''
  ) {
    errors.push('workItemId must be a non-empty string or number');
  }
  if (typeof input.storyTitle !== 'string' || input.storyTitle.trim() === '') {
    errors.push('storyTitle must be a non-empty string');
  }
  if (!Array.isArray(input.existingSuites)) {
    errors.push('existingSuites must be an array (pass [] if none were fetched)');
  } else {
    input.existingSuites.forEach((suite, index) => {
      errors.push(...validateExistingSuiteEntry(suite, index));
    });
  }
  const hasSelected = input.selectedSuiteId !== undefined && input.selectedSuiteId !== null;
  if (
    hasSelected &&
    ((typeof input.selectedSuiteId !== 'string' && typeof input.selectedSuiteId !== 'number') ||
      String(input.selectedSuiteId).trim() === '')
  ) {
    errors.push('selectedSuiteId must be a non-empty string or number when present');
  }

  assertNoErrors('resolveOrCreateTestSuite input', errors);

  const planId = String(input.planId).trim();
  const workItemId = String(input.workItemId).trim();
  const suiteName = buildSuiteName(workItemId, input.storyTitle.trim());

  if (hasSelected) {
    const selectedSuiteId = String(input.selectedSuiteId).trim();
    const selected = input.existingSuites.find((suite) => String(suite.id).trim() === selectedSuiteId);
    if (!selected) {
      throw new Error(
        `selectedSuiteId '${selectedSuiteId}' does not match any of the fetched existingSuites — re-confirm ` +
          "the QA engineer's choice against the actual list rather than trusting a stale id"
      );
    }
    return {
      action: 'resolve',
      planId,
      suiteId: String(selected.id),
      suiteName: selected.name || suiteName,
      workItemId,
    };
  }

  const linkMatch = input.existingSuites.find(
    (suite) => suite.workItemId !== undefined && String(suite.workItemId).trim() === workItemId
  );
  const match =
    linkMatch ||
    input.existingSuites.find((suite) => suite.workItemId === undefined && suite.name === suiteName);

  if (match) {
    return {
      action: 'resolve',
      planId,
      suiteId: String(match.id),
      suiteName: match.name || suiteName,
      workItemId,
    };
  }

  return { action: 'create', planId, suiteName, workItemId };
}

/**
 * Validate/normalize the MCP tool's response after the orchestrator actually
 * created a Test Suite (the `testplan_create_test_suite`-equivalent call
 * made from the `{action: 'create', ...}` decision above).
 *
 * @param {{action: 'create', suiteName: string, workItemId: string, planId: string}} decision
 *   - the decision this module previously returned with `action: 'create'`
 * @param {{id: string|number, name?: string}} mcpResponse - the MCP tool's response
 * @returns {{suiteId: string, suiteName: string, workItemId: string, planId: string}} normalized, tracked suite record
 * @throws {Error} if `decision` isn't a `'create'` decision, or `mcpResponse` lacks a usable id
 */
function recordCreatedSuite(decision, mcpResponse) {
  if (!decision || typeof decision !== 'object' || decision.action !== 'create') {
    throw new Error(
      "recordCreatedSuite requires the 'create' decision returned by resolveOrCreateTestSuite — " +
        "nothing was created for a 'resolve' decision, so there is nothing to record."
    );
  }
  if (typeof decision.suiteName !== 'string' || decision.suiteName.trim() === '') {
    throw new Error("decision.suiteName must be a non-empty string");
  }
  if (
    (typeof decision.workItemId !== 'string' && typeof decision.workItemId !== 'number') ||
    String(decision.workItemId).trim() === ''
  ) {
    throw new Error('decision.workItemId must be a non-empty string or number');
  }
  if (
    (typeof decision.planId !== 'string' && typeof decision.planId !== 'number') ||
    String(decision.planId).trim() === ''
  ) {
    throw new Error('decision.planId must be a non-empty string or number');
  }

  const errors = [];
  if (!mcpResponse || typeof mcpResponse !== 'object') {
    errors.push('mcpResponse must be an object');
  } else {
    if (
      (typeof mcpResponse.id !== 'string' && typeof mcpResponse.id !== 'number') ||
      String(mcpResponse.id).trim() === ''
    ) {
      errors.push('mcpResponse.id must be a non-empty string or number');
    }
    if (mcpResponse.name !== undefined && typeof mcpResponse.name !== 'string') {
      errors.push('mcpResponse.name must be a string when present');
    }
  }
  assertNoErrors('mcpResponse', errors);

  return {
    suiteId: String(mcpResponse.id),
    suiteName: (mcpResponse.name && mcpResponse.name.trim()) || decision.suiteName,
    workItemId: String(decision.workItemId).trim(),
    planId: String(decision.planId).trim(),
  };
}

module.exports = { buildSuiteName, resolveOrCreateTestSuite, recordCreatedSuite };

// ponytail self-check: `node packages/e2e-testing/lib/ado-test-suite.js`
// exercises the resolve/create decision (link match, name-fallback match,
// QA-engineer-selected override, no match) and recordCreatedSuite's
// normalization/validation. See tests/ado-test-suite.test.js (TRD-039-TEST)
// for the full Jest suite.
if (require.main === module) {
  const assert = require('assert');

  // naming convention
  assert.strictEqual(buildSuiteName('12345', 'Claim intake validation'), 'Story 12345 - Claim intake validation');

  // resolve via workItemId link match
  assert.deepStrictEqual(
    resolveOrCreateTestSuite({
      planId: 900,
      workItemId: 12345,
      storyTitle: 'Claim intake validation',
      existingSuites: [
        { id: 999, name: 'Some other suite' },
        { id: 42, name: 'Story 12345 - Claim intake validation', workItemId: '12345' },
      ],
    }),
    {
      action: 'resolve',
      planId: '900',
      suiteId: '42',
      suiteName: 'Story 12345 - Claim intake validation',
      workItemId: '12345',
    }
  );

  // resolve via deterministic-name fallback when no workItemId field is present
  assert.deepStrictEqual(
    resolveOrCreateTestSuite({
      planId: 900,
      workItemId: 12345,
      storyTitle: 'Claim intake validation',
      existingSuites: [{ id: 7, name: 'Story 12345 - Claim intake validation' }],
    }),
    {
      action: 'resolve',
      planId: '900',
      suiteId: '7',
      suiteName: 'Story 12345 - Claim intake validation',
      workItemId: '12345',
    }
  );

  // a QA-engineer-selected suite wins over the automatic workItemId/name match
  assert.deepStrictEqual(
    resolveOrCreateTestSuite({
      planId: 900,
      workItemId: 12345,
      storyTitle: 'Claim intake validation',
      existingSuites: [
        { id: 7, name: 'Story 12345 - Claim intake validation', workItemId: '12345' },
        { id: 999, name: 'Reused Regression Suite' },
      ],
      selectedSuiteId: 999,
    }),
    { action: 'resolve', planId: '900', suiteId: '999', suiteName: 'Reused Regression Suite', workItemId: '12345' }
  );

  // no match at all -> create decision (planId carried through, no suiteId yet)
  assert.deepStrictEqual(
    resolveOrCreateTestSuite({
      planId: 900,
      workItemId: 12345,
      storyTitle: 'Claim intake validation',
      existingSuites: [{ id: 999, name: 'Unrelated suite' }],
    }),
    { action: 'create', planId: '900', suiteName: 'Story 12345 - Claim intake validation', workItemId: '12345' }
  );

  // empty existingSuites -> create
  assert.deepStrictEqual(
    resolveOrCreateTestSuite({ planId: 900, workItemId: 1, storyTitle: 'X', existingSuites: [] }),
    { action: 'create', planId: '900', suiteName: 'Story 1 - X', workItemId: '1' }
  );

  // invalid inputs -> clear errors, never a silent guess
  assert.throws(() => resolveOrCreateTestSuite({}), /planId.*workItemId.*storyTitle.*existingSuites/s);
  assert.throws(
    () => resolveOrCreateTestSuite({ planId: 900, workItemId: 1, storyTitle: 'X', existingSuites: 'not-an-array' }),
    /existingSuites must be an array/
  );
  assert.throws(
    () => resolveOrCreateTestSuite({ planId: 900, workItemId: 1, storyTitle: 'X', existingSuites: [{ name: 'no id' }] }),
    /existingSuites\[0\]\.id must be a non-empty string or number/
  );

  // a selectedSuiteId that doesn't match any fetched suite is rejected, not trusted blindly
  assert.throws(
    () =>
      resolveOrCreateTestSuite({
        planId: 900,
        workItemId: 1,
        storyTitle: 'X',
        existingSuites: [{ id: 7 }],
        selectedSuiteId: 999,
      }),
    /does not match any of the fetched existingSuites/
  );

  // recordCreatedSuite: normalizes a valid MCP response
  const createDecision = resolveOrCreateTestSuite({ planId: 900, workItemId: 1, storyTitle: 'X', existingSuites: [] });
  assert.deepStrictEqual(recordCreatedSuite(createDecision, { id: 555, name: 'Story 1 - X' }), {
    suiteId: '555',
    suiteName: 'Story 1 - X',
    workItemId: '1',
    planId: '900',
  });

  // falls back to the decision's suiteName if the MCP response omits name
  assert.deepStrictEqual(recordCreatedSuite(createDecision, { id: 555 }), {
    suiteId: '555',
    suiteName: 'Story 1 - X',
    workItemId: '1',
    planId: '900',
  });

  // rejects recording against a 'resolve' decision (nothing was created)
  const resolveDecision = resolveOrCreateTestSuite({
    planId: 900,
    workItemId: 1,
    storyTitle: 'X',
    existingSuites: [{ id: 9, workItemId: '1' }],
  });
  assert.throws(() => recordCreatedSuite(resolveDecision, { id: 555 }), /nothing was created/);

  // rejects an mcpResponse with no usable id
  assert.throws(() => recordCreatedSuite(createDecision, {}), /mcpResponse\.id must be a non-empty string or number/);
  assert.throws(() => recordCreatedSuite(createDecision, null), /mcpResponse must be an object/);

  console.log('ado-test-suite.js self-check passed');
}
