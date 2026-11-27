'use strict';

/**
 * TRD-012: manual/not-automatable escape hatch for
 * /ensemble:author-playwright-tests (REQ-017).
 *
 * Consumer of ac-decision-loop.js's 'reject' outcome:
 * `recordDecision('reject', {acId, ...})` returns
 * `{outcome: 'manual-escape-hatch', acId}`; the orchestrator routes that here.
 *
 * Implementation AC (AC-017-1): an AC the QA engineer marks manual-only during the
 * walkthrough is recorded as a THIRD, distinct status — never silently
 * dropped, and never confused with either of this package's other two
 * per-AC outcomes:
 *   - 'confirmed' (resume-scan.js): a landed test, tagged with @hash: in a
 *     spec file.
 *   - 'gap' (implementation-grounding.js): the implementing code for a REQ
 *     couldn't be located at all — a grounding failure, not a deliberate
 *     choice not to automate a working feature.
 *   - 'manual' (this module): the feature exists and works, but the QA
 *     engineer has judged it not worth/not reasonably automatable (e.g. a visual check).
 *
 * Plain functions over plain data, matching this package's convention
 * (ac-decision-loop.js, req-batcher.js, delegation-contract.js).
 */

/**
 * Record one AC as manual-only.
 *
 * @param {string} acId - the AC id (e.g. "AC-017-1")
 * @param {string} [reason] - optional free-text reason the QA engineer gave; omitted
 *   entirely if they didn't give one (null, not a forced default string)
 * @returns {{acId: string, status: 'manual', reason: string|null}}
 * @throws {Error} if acId is missing/blank
 */
function markManual(acId, reason) {
  if (typeof acId !== 'string' || acId.trim() === '') {
    throw new Error('acId must be a non-empty string');
  }
  return {
    acId,
    status: 'manual',
    reason: typeof reason === 'string' && reason.trim() !== '' ? reason : null,
  };
}

/**
 * Minimal session-scoped accumulator for markManual() records, for an
 * orchestrator that would rather not manage its own array. Purely additive
 * sugar over markManual() — nothing here is required if a caller prefers to
 * push markManual()'s return value into its own array instead.
 *
 * @returns {{add: (acId: string, reason?: string) => object,
 *            list: () => object[],
 *            has: (acId: string) => boolean}}
 */
function trackManualAcs() {
  const records = [];
  return {
    add(acId, reason) {
      const record = markManual(acId, reason);
      records.push(record);
      return record;
    },
    list() {
      return records.map((r) => ({ ...r }));
    },
    has(acId) {
      const target = String(acId).toUpperCase();
      return records.some((r) => r.acId.toUpperCase() === target);
    },
  };
}

module.exports = { markManual, trackManualAcs };

// ponytail self-check: `node packages/e2e-testing/lib/manual-ac-tracker.js`
// exercises markManual() + trackManualAcs() without a separate test file
// (TRD-012 has no TRD-012-TEST sibling task per the TRD's dependency graph —
// TRD-010-TEST covers the integration with ac-decision-loop.js's
// 'manual-escape-hatch' outcome and depends on this task, but is a later,
// separate task).
if (require.main === module) {
  const assert = require('assert');

  // reason given
  assert.deepStrictEqual(markManual('AC-017-1', 'no camera in the QA environment'), {
    acId: 'AC-017-1',
    status: 'manual',
    reason: 'no camera in the QA environment',
  });

  // reason omitted -> null, never a forced default string
  assert.deepStrictEqual(markManual('AC-017-1'), { acId: 'AC-017-1', status: 'manual', reason: null });
  assert.deepStrictEqual(markManual('AC-017-1', ''), { acId: 'AC-017-1', status: 'manual', reason: null });

  // distinct from resume-scan.js's 'confirmed' and implementation-grounding.js's 'gap'
  assert.notStrictEqual(markManual('AC-017-1').status, 'confirmed');
  assert.notStrictEqual(markManual('AC-017-1').status, 'gap');

  assert.throws(() => markManual(''), /acId must be a non-empty string/);
  assert.throws(() => markManual(), /acId must be a non-empty string/);

  // accumulator: add/list/has across a session
  const tracker = trackManualAcs();
  assert.strictEqual(tracker.list().length, 0);
  const added = tracker.add('AC-017-1', 'visual-only check');
  assert.deepStrictEqual(added, { acId: 'AC-017-1', status: 'manual', reason: 'visual-only check' });
  tracker.add('AC-009-2');
  assert.strictEqual(tracker.list().length, 2);
  assert.ok(tracker.has('ac-017-1')); // case-insensitive
  assert.ok(!tracker.has('AC-999-9'));

  // list() returns a snapshot, not the live internal array
  const snapshot = tracker.list();
  snapshot.push(markManual('AC-000-0'));
  assert.strictEqual(tracker.list().length, 2);

  // list() records are also copies -- mutating one must not corrupt internal state
  snapshot[0].reason = 'MUTATED';
  assert.notStrictEqual(tracker.list()[0].reason, 'MUTATED');

  console.log('manual-ac-tracker.js self-check passed');
}
