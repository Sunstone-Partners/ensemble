'use strict';

/**
 * TRD-010: accept/request-changes/reject decision point per proposed test for
 * /ensemble:author-playwright-tests.
 *
 * A decision STATE per proposed test, not an I/O loop: plain data + plain
 * functions, matching this package's existing convention (delegation-contract.js,
 * req-batcher.js). The QA engineer's actual conversational turn (presenting
 * the test, reading their answer) belongs to the orchestrating command, not
 * this module.
 *
 * Implementation AC (TRD-010):
 * - AC-003-1: given an AC ready for authoring and a proposed test presented,
 *   requires one of three explicit choices before moving on.
 * - AC-003-2: request-changes signals a revise-and-re-present outcome, never
 *   a silent finalize of the original.
 * - AC-003-3: an outright reject routes to REQ-017's manual/not-automatable
 *   escape hatch (implemented later by TRD-012's manual-ac-tracker.js) via a
 *   well-defined outcome value this module produces but does not act on.
 *
 * Unbounded request-changes risk (PRD REQ-003 risk note): this module tracks
 * nothing across calls itself (it is stateless). A caller that wants to cap
 * iterations can do so by threading `iterationCount` through on each
 * request-changes round-trip and inspecting the returned value — no cap is
 * enforced here since none is specified as a requirement yet.
 */

const VALID_DECISIONS = ['accept', 'request-changes', 'reject'];

/**
 * @typedef {Object} DecisionContext
 * @property {string} acId - the AC id this decision applies to (e.g. "AC-003-1")
 * @property {string} proposedTest - the proposed test source being decided on
 * @property {string} [changeDescription] - required when decision is 'request-changes':
 *   the QA engineer's description of what to change
 * @property {number} [iterationCount] - how many request-changes rounds have
 *   already happened for this AC, if the caller is tracking one; echoed back
 *   unchanged on the 'revise' outcome so a caller can enforce its own cap
 */

/**
 * Record the QA engineer's decision on one proposed test and return the structured
 * outcome the orchestrator should act on next.
 *
 * @param {'accept'|'request-changes'|'reject'} decision
 * @param {DecisionContext} context
 * @returns {{outcome: 'accepted', acId: string, proposedTest: string}
 *   | {outcome: 'revise', acId: string, changeDescription: string, iterationCount: number}
 *   | {outcome: 'manual-escape-hatch', acId: string}}
 * @throws {Error} if `decision` is not exactly one of the three valid choices,
 *   or a decision-specific required field is missing (AC-003-1: never
 *   silently defaults an unrecognized/typo'd choice)
 */
function recordDecision(decision, context) {
  if (!VALID_DECISIONS.includes(decision)) {
    throw new Error(
      `Invalid decision '${decision}': must be one of ${VALID_DECISIONS.map((d) => `'${d}'`).join(', ')}`
    );
  }
  if (!context || typeof context !== 'object') {
    throw new Error('context is required (must include at least acId)');
  }
  if (typeof context.acId !== 'string' || context.acId.trim() === '') {
    throw new Error('context.acId must be a non-empty string');
  }

  switch (decision) {
    case 'accept': {
      if (typeof context.proposedTest !== 'string' || context.proposedTest.trim() === '') {
        throw new Error("context.proposedTest is required when decision is 'accept'");
      }
      return { outcome: 'accepted', acId: context.acId, proposedTest: context.proposedTest };
    }

    case 'request-changes': {
      if (typeof context.changeDescription !== 'string' || context.changeDescription.trim() === '') {
        throw new Error("context.changeDescription is required when decision is 'request-changes'");
      }
      return {
        outcome: 'revise',
        acId: context.acId,
        changeDescription: context.changeDescription,
        iterationCount: Number.isInteger(context.iterationCount) ? context.iterationCount : 0,
      };
    }

    case 'reject': {
      // AC-003-3: an outright reject (not a request for changes) — route to
      // REQ-017's manual/not-automatable escape hatch. This module only
      // signals that outcome; TRD-012's manual-ac-tracker.js owns recording it.
      return { outcome: 'manual-escape-hatch', acId: context.acId };
    }

    default:
      // Unreachable: guarded by the VALID_DECISIONS check above.
      throw new Error(`Unhandled decision '${decision}'`);
  }
}

module.exports = { recordDecision, VALID_DECISIONS };

// ponytail self-check: `node packages/e2e-testing/lib/ac-decision-loop.js`
// exercises all three decision paths plus the invalid-choice guard, without a
// separate test file (TRD-010-TEST is a later task blocked on TRD-012).
if (require.main === module) {
  const assert = require('assert');

  // accept -> accepted, ready for placement (TRD-014)
  assert.deepStrictEqual(
    recordDecision('accept', { acId: 'AC-003-1', proposedTest: "test('...', async () => {});" }),
    { outcome: 'accepted', acId: 'AC-003-1', proposedTest: "test('...', async () => {});" }
  );
  assert.throws(() => recordDecision('accept', { acId: 'AC-003-1' }), /proposedTest is required/);

  // request-changes -> revise, signals re-delegation + fresh decision point (AC-003-2)
  const revise = recordDecision('request-changes', {
    acId: 'AC-003-1',
    changeDescription: 'use the data-testid selector instead of text match',
    iterationCount: 1,
  });
  assert.deepStrictEqual(revise, {
    outcome: 'revise',
    acId: 'AC-003-1',
    changeDescription: 'use the data-testid selector instead of text match',
    iterationCount: 1,
  });
  // iterationCount defaults to 0 when the caller isn't tracking one yet
  assert.strictEqual(
    recordDecision('request-changes', { acId: 'AC-003-1', changeDescription: 'fix it' }).iterationCount,
    0
  );
  assert.throws(
    () => recordDecision('request-changes', { acId: 'AC-003-1' }),
    /changeDescription is required/
  );

  // reject -> manual-escape-hatch, routes to REQ-017 (AC-003-3), not a silent drop
  assert.deepStrictEqual(recordDecision('reject', { acId: 'AC-003-1' }), {
    outcome: 'manual-escape-hatch',
    acId: 'AC-003-1',
  });

  // AC-003-1: a 4th/typo'd choice is rejected, never silently defaulted
  assert.throws(() => recordDecision('maybe', { acId: 'AC-003-1' }), /Invalid decision 'maybe'/);
  assert.throws(() => recordDecision('Accept', { acId: 'AC-003-1' })); // case-sensitive, no fuzzy match

  console.log('ac-decision-loop.js self-check passed');
}
