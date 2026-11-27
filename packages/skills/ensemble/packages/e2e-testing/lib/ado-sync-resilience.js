'use strict';

/**
 * TRD-019: ADO sync retry/flag decision logic for
 * /ensemble:author-playwright-tests (REQ-008).
 *
 * CRITICAL boundary (same as ado-test-suite.js / ado-test-case-sync.js):
 * Azure DevOps MCP tools are only invocable by the orchestrating agent at
 * conversation time. This module does not call `testplan_*` itself and does
 * not retry the MCP call — it only tracks retry-attempt state across calls
 * the orchestrator makes and returns a decision telling the orchestrator what
 * to do next. "Troubleshooting" between retries (AC-008-2) is agent judgment
 * exercised at conversation time (e.g. checking ADO auth, connectivity, work
 * item/suite ids) — there is nothing to encode as JS for that; this module
 * only counts attempts and carries the error history forward.
 *
 * *** INVARIANT (AC-008-1): NEVER ROLLBACK ***
 * A local test file that has already landed (via spec-writer.js) is NEVER
 * rolled back/deleted/reverted because an ADO sync call failed — that
 * decision belongs entirely to the orchestrator's behavior (don't touch the
 * spec file on sync failure), not to any return value from this module.
 * Enforced here by construction: every function in this module only ever
 * returns one of `VALID_DECISIONS` below, and none of them is a rollback/
 * delete/undo instruction of any kind. There is no code path in this module
 * that produces, or could be repurposed to produce, an instruction to revert
 * a landed test. The self-check below asserts this explicitly.
 *
 * Retry cap (AC-008-2): MAX_SYNC_ATTEMPTS = 3 total attempts (the initial
 * attempt plus up to 2 retries) before flagging unsynced. This is
 * deliberately small — REQ-008 scopes this as "retry before the session
 * ends," not a long-running resilience system, so no exponential backoff,
 * jitter, or circuit breaker is implemented here.
 *
 * Two functions:
 *   1. recordSyncAttempt(state, outcome) - given the accumulator `state`
 *      returned by the previous call (or null for the first attempt) and the
 *      outcome `{success, error}` of the sync call the orchestrator just
 *      made, returns `{state, decision, note?}` where `decision` is
 *      'synced' (this attempt succeeded), 'retry' (failed, under the cap —
 *      try again, after troubleshooting), or 'flag-unsynced' (failed, cap
 *      exhausted).
 *   2. flagUnsynced(acId, state) - given an exhausted retry `state`, produces
 *      the final per-AC 'unsynced' record — a distinct per-AC outcome
 *      alongside this package's other per-AC concepts: resume-scan.js's
 *      confirmed/pending sets, implementation-grounding.js's grounded/gap
 *      flag, and manual-ac-tracker.js's literal 'manual' status.
 *
 * Plain functions over plain data, matching this package's convention
 * (ado-test-suite.js, ado-test-case-sync.js, manual-ac-tracker.js) — no
 * class, no schema library, no I/O.
 */

const MAX_SYNC_ATTEMPTS = 3; // initial attempt + up to 2 retries — see header

const VALID_DECISIONS = Object.freeze(['synced', 'retry', 'flag-unsynced']);

const RETRY_NOTE =
  'Troubleshoot the failure (e.g. verify ADO auth, work item/suite ids, network reachability) before retrying the sync call. The local test file stays as-is regardless.';

const UNSYNCED_NOTE =
  'ADO sync did not complete after retries. Run a future refine-tests session or sync this Test Case/Suite manually. The local test file was NOT rolled back.';

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

/**
 * Validate/normalize a retry-tracker `state`. Returns a fresh `{attempts: 0,
 * errors: []}` accumulator when `state` is null/undefined and `allowNull` is
 * true (the first attempt); otherwise validates the shape returned by a
 * previous `recordSyncAttempt` call and returns a defensive copy.
 *
 * @param {*} state
 * @param {string[]} errors - mutated with any problems found
 * @param {{allowNull: boolean}} options
 * @returns {{attempts: number, errors: string[]}|null} null if invalid
 */
function validateState(state, errors, { allowNull }) {
  if (state === null || state === undefined) {
    if (allowNull) return { attempts: 0, errors: [] };
    errors.push('state must be the object returned by recordSyncAttempt after at least one failed attempt (not null/undefined)');
    return null;
  }
  if (typeof state !== 'object') {
    errors.push('state must be an object (or null for the first attempt)');
    return null;
  }
  if (!Number.isInteger(state.attempts) || state.attempts < 0) {
    errors.push('state.attempts must be a non-negative integer');
  }
  if (!Array.isArray(state.errors) || state.errors.some((entry) => typeof entry !== 'string')) {
    errors.push('state.errors must be an array of strings');
  }
  if (errors.length > 0) return null;
  return { attempts: state.attempts, errors: state.errors.slice() };
}

/**
 * Record the outcome of one ADO sync attempt and decide what happens next.
 * Never returns a rollback/delete/undo instruction — see module header.
 *
 * @param {{attempts: number, errors: string[]}|null} state - the accumulator
 *   returned by the previous call, or null for the first attempt
 * @param {object} outcome
 * @param {boolean} outcome.success - whether this sync attempt succeeded
 * @param {string} [outcome.error] - required (non-empty) when success is
 *   false; must be omitted when success is true
 * @returns {{state: {attempts: number, errors: string[]}, decision: 'synced'}
 *          |{state: {attempts: number, errors: string[]}, decision: 'retry', note: string}
 *          |{state: {attempts: number, errors: string[]}, decision: 'flag-unsynced'}}
 * @throws {Error} listing every missing/invalid field, when input is invalid
 */
function recordSyncAttempt(state, outcome) {
  const errors = [];
  const prior = validateState(state, errors, { allowNull: true });

  if (!outcome || typeof outcome !== 'object') {
    errors.push('outcome must be an object with a boolean `success` field');
  } else {
    if (typeof outcome.success !== 'boolean') {
      errors.push('outcome.success must be a boolean');
    }
    if (outcome.success === true && outcome.error !== undefined) {
      errors.push('outcome.error must not be provided when outcome.success is true');
    }
    if (outcome.success === false && !isNonEmptyString(outcome.error)) {
      errors.push('outcome.error must be a non-empty string when outcome.success is false');
    }
  }

  assertNoErrors('recordSyncAttempt input', errors);

  const attempts = prior.attempts + 1;

  if (outcome.success === true) {
    return { state: { attempts, errors: prior.errors }, decision: 'synced' };
  }

  const nextState = { attempts, errors: [...prior.errors, outcome.error.trim()] };

  if (attempts < MAX_SYNC_ATTEMPTS) {
    return { state: nextState, decision: 'retry', note: RETRY_NOTE };
  }

  return { state: nextState, decision: 'flag-unsynced' };
}

/**
 * Produce the final 'unsynced' record once retries are exhausted
 * (`recordSyncAttempt` returned `decision: 'flag-unsynced'`). A distinct
 * per-AC outcome, alongside this package's other per-AC concepts:
 * resume-scan.js's confirmed/pending sets, implementation-grounding.js's
 * grounded/gap flag, and manual-ac-tracker.js's literal 'manual' status.
 *
 * @param {string} acId - e.g. "AC-008-1"
 * @param {{attempts: number, errors: string[]}} state - an exhausted retry
 *   state (must have at least one recorded failure)
 * @returns {{acId: string, status: 'unsynced', attempts: number, lastError: string, note: string}}
 * @throws {Error} if acId is missing/blank, or state has no recorded failures
 */
function flagUnsynced(acId, state) {
  const errors = [];
  if (!isNonEmptyString(acId)) {
    errors.push('acId must be a non-empty string');
  }
  const normalized = validateState(state, errors, { allowNull: false });
  if (normalized && normalized.errors.length === 0) {
    errors.push('state.errors must contain at least one recorded failure — flagUnsynced is only for an exhausted retry state');
  }
  assertNoErrors('flagUnsynced input', errors);

  return {
    acId: acId.trim(),
    status: 'unsynced',
    attempts: normalized.attempts,
    lastError: normalized.errors[normalized.errors.length - 1],
    note: UNSYNCED_NOTE,
  };
}

module.exports = { MAX_SYNC_ATTEMPTS, VALID_DECISIONS, recordSyncAttempt, flagUnsynced };

// ponytail self-check: `node packages/e2e-testing/lib/ado-sync-resilience.js`
// exercises the retry/flag decision sequence, invalid-input handling, and the
// never-rollback invariant — TRD-019-TEST is a later, separate task per the
// TRD's dependency graph, so this is interim/only coverage until then.
if (require.main === module) {
  const assert = require('assert');

  // --- happy path: succeeds on the first attempt ---
  const firstTry = recordSyncAttempt(null, { success: true });
  assert.deepStrictEqual(firstTry, { state: { attempts: 1, errors: [] }, decision: 'synced' });

  // --- failure sequence: retry, retry, then flag-unsynced at the cap ---
  let state = null;
  let result = recordSyncAttempt(state, { success: false, error: 'ECONNRESET' });
  assert.strictEqual(result.decision, 'retry');
  assert.deepStrictEqual(result.state, { attempts: 1, errors: ['ECONNRESET'] });
  assert.ok(isNonEmptyString(result.note));
  state = result.state;

  result = recordSyncAttempt(state, { success: false, error: '401 Unauthorized' });
  assert.strictEqual(result.decision, 'retry');
  assert.deepStrictEqual(result.state, { attempts: 2, errors: ['ECONNRESET', '401 Unauthorized'] });
  state = result.state;

  result = recordSyncAttempt(state, { success: false, error: '500 Internal Server Error' });
  assert.strictEqual(result.decision, 'flag-unsynced');
  assert.deepStrictEqual(result.state, {
    attempts: 3,
    errors: ['ECONNRESET', '401 Unauthorized', '500 Internal Server Error'],
  });
  assert.strictEqual(result.note, undefined); // no retry-troubleshooting note once exhausted
  state = result.state;

  // --- recovering after prior failures still reports 'synced', keeps history ---
  const recovered = recordSyncAttempt({ attempts: 1, errors: ['ECONNRESET'] }, { success: true });
  assert.deepStrictEqual(recovered, { state: { attempts: 2, errors: ['ECONNRESET'] }, decision: 'synced' });

  // --- flagUnsynced: builds the terminal 'unsynced' record from exhausted state ---
  const flagged = flagUnsynced('AC-008-1', state);
  assert.deepStrictEqual(flagged, {
    acId: 'AC-008-1',
    status: 'unsynced',
    attempts: 3,
    lastError: '500 Internal Server Error',
    note: UNSYNCED_NOTE,
  });

  // distinct from resume-scan.js's 'confirmed', implementation-grounding.js's
  // 'gap', and manual-ac-tracker.js's 'manual'
  assert.notStrictEqual(flagged.status, 'confirmed');
  assert.notStrictEqual(flagged.status, 'gap');
  assert.notStrictEqual(flagged.status, 'manual');

  // --- invalid recordSyncAttempt inputs collect every error, never a silent default ---
  assert.throws(() => recordSyncAttempt(null, {}), /outcome\.success must be a boolean/);
  assert.throws(
    () => recordSyncAttempt(null, { success: true, error: 'should not be here' }),
    /outcome\.error must not be provided when outcome\.success is true/
  );
  assert.throws(
    () => recordSyncAttempt(null, { success: false }),
    /outcome\.error must be a non-empty string when outcome\.success is false/
  );
  assert.throws(
    () => recordSyncAttempt({ attempts: -1, errors: [] }, { success: true }),
    /state\.attempts must be a non-negative integer/
  );
  assert.throws(
    () => recordSyncAttempt({ attempts: 1, errors: 'not-an-array' }, { success: true }),
    /state\.errors must be an array of strings/
  );

  // --- invalid flagUnsynced inputs ---
  assert.throws(() => flagUnsynced('', state), /acId must be a non-empty string/);
  assert.throws(
    () => flagUnsynced('AC-008-1', null),
    /state must be the object returned by recordSyncAttempt after at least one failed attempt/
  );
  assert.throws(
    () => flagUnsynced('AC-008-1', { attempts: 1, errors: [] }),
    /state\.errors must contain at least one recorded failure/
  );

  // --- AC-008-1 invariant: no return shape here is ever a rollback/delete/undo ---
  const forbiddenKeys = ['rollback', 'delete', 'revert', 'undo', 'remove'];
  const decisionsSeen = [firstTry, { decision: 'retry' }, { decision: 'flag-unsynced' }, recovered, flagged].map(
    (r) => r.decision || r.status
  );
  for (const outcome of [firstTry, recovered, flagged]) {
    for (const key of forbiddenKeys) {
      assert.ok(!(key in outcome), `unexpected forbidden key "${key}" found in a return value`);
    }
  }
  assert.deepStrictEqual(VALID_DECISIONS, ['synced', 'retry', 'flag-unsynced']);
  for (const decision of decisionsSeen) {
    assert.ok(
      VALID_DECISIONS.includes(decision) || decision === 'unsynced',
      `decision/status "${decision}" is not one of the documented, non-rollback outcomes`
    );
  }

  console.log('ado-sync-resilience.js self-check passed');
}
