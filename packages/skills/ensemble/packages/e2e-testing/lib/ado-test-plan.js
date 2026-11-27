'use strict';

/**
 * TRD-038: resolve-or-create decision logic for the project's Azure DevOps
 * Test Plan, for /ensemble:author-playwright-tests (REQ-007's Test Plan
 * prerequisite — every Test Suite belongs to one; `testplan_list_test_suites`
 * and `testplan_create_test_suite` both require a `planId`).
 *
 * Found live-dogfooding this feature's Test Plan Sync phase against a real
 * project with zero existing Test Plans: `ado-test-suite.js` had no concept
 * of a parent plan at all, and the orchestrator jumped straight to
 * listing/creating suites as if one already existed. Not specific to any one
 * consuming application — any first-time use of this phase against a project
 * with no Test Plan yet hits the same wall.
 *
 * Unlike `ado-test-suite.js`'s deterministic per-story suite naming, this
 * module never invents a Test Plan name, iteration, or area path — a Test
 * Plan is shared, project-wide infrastructure, not a per-story artifact, so
 * naming/creating one is a real decision for the QA engineer to make, not
 * something this tool should decide unilaterally. This module only shapes
 * whatever choice the orchestrator already got from them (see
 * author-playwright-tests.yaml, Phase 5 Step 1).
 *
 * Same CRITICAL boundary as ado-test-suite.js: the `testplan_*` MCP tools are
 * only invocable by the orchestrating agent at conversation time — this
 * module does no I/O, no MCP client code, just plain decision logic over
 * already-fetched/already-chosen plain data.
 *
 * Convention: plain functions over plain data, matching ado-test-suite.js.
 */

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
 * Validate one entry of `existingPlans`. Deliberately lenient about extra
 * fields (the orchestrator passes through whatever `testplan_list_test_plans`
 * returned) — only `id` is required.
 *
 * @param {*} plan
 * @param {number} index
 * @returns {string[]} errors found (empty if valid)
 */
function validateExistingPlanEntry(plan, index) {
  const errors = [];
  if (!plan || typeof plan !== 'object') {
    errors.push(`existingPlans[${index}] must be an object`);
    return errors;
  }
  if (!isNonEmptyStringOrNumber(plan.id)) {
    errors.push(`existingPlans[${index}].id must be a non-empty string or number`);
  }
  if (plan.name !== undefined && typeof plan.name !== 'string') {
    errors.push(`existingPlans[${index}].name must be a string when present`);
  }
  return errors;
}

/**
 * Decide whether to reuse an already-existing Test Plan or create a new one —
 * always per an explicit choice the QA engineer already made, never an
 * auto-pick. A project's Test Plans are shared infrastructure; this module
 * refuses to guess which one to reuse or invent a name for a new one.
 *
 * @param {object} input
 * @param {Array<{id: string|number, name?: string}>} input.existingPlans -
 *   plans already fetched by the orchestrator (e.g. via `testplan_list_test_plans`)
 * @param {string|number} [input.selectedPlanId] - the id of an existing plan
 *   the QA engineer chose to reuse; must match one of `existingPlans`
 * @param {string} [input.newPlanName] - the name the QA engineer gave for a
 *   brand-new plan, when they chose to create one instead of reusing one
 * @returns {{action: 'resolve', planId: string, planName: string}
 *          |{action: 'create', planName: string}}
 * @throws {Error} if input is invalid, if neither `selectedPlanId` nor
 *   `newPlanName` is given, if both are given, or if `selectedPlanId` doesn't
 *   match any entry in `existingPlans`
 */
function resolveOrCreateTestPlan(input) {
  const errors = [];

  if (!input || typeof input !== 'object') {
    return assertNoErrors('resolveOrCreateTestPlan input', ['input must be an object']);
  }

  if (!Array.isArray(input.existingPlans)) {
    errors.push('existingPlans must be an array (pass [] if none were fetched)');
  } else {
    input.existingPlans.forEach((plan, index) => {
      errors.push(...validateExistingPlanEntry(plan, index));
    });
  }

  const hasSelected = input.selectedPlanId !== undefined && input.selectedPlanId !== null;
  const hasNewName = isNonEmptyString(input.newPlanName);

  if (hasSelected && hasNewName) {
    errors.push(
      'provide either selectedPlanId or newPlanName, not both — the QA engineer made one choice, not two'
    );
  }
  if (!hasSelected && !hasNewName) {
    errors.push(
      'selectedPlanId or newPlanName is required — this module never picks or names a Test Plan on its ' +
        'own; ask the QA engineer to choose an existing plan or name a new one first'
    );
  }
  if (hasSelected && !isNonEmptyStringOrNumber(input.selectedPlanId)) {
    errors.push('selectedPlanId must be a non-empty string or number when present');
  }

  assertNoErrors('resolveOrCreateTestPlan input', errors);

  if (hasNewName) {
    return { action: 'create', planName: input.newPlanName.trim() };
  }

  const selectedPlanId = String(input.selectedPlanId).trim();
  const match = input.existingPlans.find((plan) => String(plan.id).trim() === selectedPlanId);
  if (!match) {
    throw new Error(
      `selectedPlanId '${selectedPlanId}' does not match any of the fetched existingPlans — re-confirm ` +
        "the QA engineer's choice against the actual list rather than trusting a stale id"
    );
  }

  return { action: 'resolve', planId: selectedPlanId, planName: match.name || selectedPlanId };
}

/**
 * Validate/normalize the MCP tool's response after the orchestrator actually
 * created a Test Plan (the `testplan_create_test_plan`-equivalent call made
 * from the `{action: 'create', ...}` decision above).
 *
 * @param {{action: 'create', planName: string}} decision
 *   - the decision this module previously returned with `action: 'create'`
 * @param {{id: string|number, name?: string}} mcpResponse - the MCP tool's response
 * @returns {{planId: string, planName: string}} normalized, tracked plan record
 * @throws {Error} if `decision` isn't a `'create'` decision, or `mcpResponse` lacks a usable id
 */
function recordCreatedPlan(decision, mcpResponse) {
  if (!decision || typeof decision !== 'object' || decision.action !== 'create') {
    throw new Error(
      "recordCreatedPlan requires the 'create' decision returned by resolveOrCreateTestPlan — " +
        "nothing was created for a 'resolve' decision, so there is nothing to record."
    );
  }
  if (!isNonEmptyString(decision.planName)) {
    throw new Error('decision.planName must be a non-empty string');
  }

  const errors = [];
  if (!mcpResponse || typeof mcpResponse !== 'object') {
    errors.push('mcpResponse must be an object');
  } else {
    if (!isNonEmptyStringOrNumber(mcpResponse.id)) {
      errors.push('mcpResponse.id must be a non-empty string or number');
    }
    if (mcpResponse.name !== undefined && typeof mcpResponse.name !== 'string') {
      errors.push('mcpResponse.name must be a string when present');
    }
  }
  assertNoErrors('mcpResponse', errors);

  return {
    planId: String(mcpResponse.id).trim(),
    planName: (mcpResponse.name && mcpResponse.name.trim()) || decision.planName,
  };
}

module.exports = { resolveOrCreateTestPlan, recordCreatedPlan };

// ponytail self-check: `node packages/e2e-testing/lib/ado-test-plan.js`
// exercises the resolve/create decision (selection, new-name, conflicting/
// missing choice) and recordCreatedPlan's normalization/validation.
if (require.main === module) {
  const assert = require('assert');

  // resolve via an explicit selectedPlanId
  assert.deepStrictEqual(
    resolveOrCreateTestPlan({
      existingPlans: [{ id: 7, name: 'Release 2026.08 Regression Plan' }],
      selectedPlanId: 7,
    }),
    { action: 'resolve', planId: '7', planName: 'Release 2026.08 Regression Plan' }
  );

  // create via an explicit newPlanName, even when other plans exist
  assert.deepStrictEqual(
    resolveOrCreateTestPlan({
      existingPlans: [{ id: 7, name: 'Unrelated Plan' }],
      newPlanName: 'Sprint 42 E2E Plan',
    }),
    { action: 'create', planName: 'Sprint 42 E2E Plan' }
  );

  // zero existing plans -> still requires an explicit choice, never auto-creates
  assert.throws(
    () => resolveOrCreateTestPlan({ existingPlans: [] }),
    /selectedPlanId or newPlanName is required/
  );

  // both given at once -> rejected, ambiguous
  assert.throws(
    () =>
      resolveOrCreateTestPlan({
        existingPlans: [{ id: 1 }],
        selectedPlanId: 1,
        newPlanName: 'X',
      }),
    /not both/
  );

  // selectedPlanId not present in existingPlans -> rejected, never trusted blindly
  assert.throws(
    () => resolveOrCreateTestPlan({ existingPlans: [{ id: 1 }], selectedPlanId: 99 }),
    /does not match any of the fetched existingPlans/
  );

  // invalid existingPlans entries -> clear errors
  assert.throws(
    () => resolveOrCreateTestPlan({ existingPlans: [{ name: 'no id' }], newPlanName: 'X' }),
    /existingPlans\[0\]\.id must be a non-empty string or number/
  );

  // recordCreatedPlan: normalizes a valid MCP response
  const createDecision = resolveOrCreateTestPlan({ existingPlans: [], newPlanName: 'Sprint 42 E2E Plan' });
  assert.deepStrictEqual(recordCreatedPlan(createDecision, { id: 321, name: 'Sprint 42 E2E Plan' }), {
    planId: '321',
    planName: 'Sprint 42 E2E Plan',
  });

  // falls back to the decision's planName if the MCP response omits name
  assert.deepStrictEqual(recordCreatedPlan(createDecision, { id: 321 }), {
    planId: '321',
    planName: 'Sprint 42 E2E Plan',
  });

  // rejects recording against a 'resolve' decision (nothing was created)
  const resolveDecision = resolveOrCreateTestPlan({
    existingPlans: [{ id: 7, name: 'Release 2026.08 Regression Plan' }],
    selectedPlanId: 7,
  });
  assert.throws(() => recordCreatedPlan(resolveDecision, { id: 321 }), /nothing was created/);

  // rejects an mcpResponse with no usable id
  assert.throws(() => recordCreatedPlan(createDecision, {}), /mcpResponse\.id must be a non-empty string or number/);
  assert.throws(() => recordCreatedPlan(createDecision, null), /mcpResponse must be an object/);

  console.log('ado-test-plan.js self-check passed');
}
