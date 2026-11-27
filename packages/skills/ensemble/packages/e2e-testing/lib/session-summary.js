'use strict';

/**
 * TRD-022: session/REQ-checkpoint completion summary for
 * /ensemble:author-playwright-tests (REQ-012, AC-012-1).
 *
 * Pure aggregation/formatting only -- no I/O, no MCP calls. Composes counts
 * from concepts already built by earlier tasks in this TRD; this module
 * itself only takes already-accumulated arrays and renders a human-readable
 * summary. It does not know or care where each array's items came from:
 *   - testsWritten / testsConfirmed: whatever the orchestrator tracked as it
 *     wrote/ran tests (no dedicated "test record" module exists yet in this
 *     package -- plain strings, e.g. an acId or test name, are fine).
 *   - manualAcs: manual-ac-tracker.js's (TRD-012) markManual()/trackManualAcs()
 *     records, `{acId, status: 'manual', reason}`.
 *   - adoTestCasesSynced: ado-test-case-sync.js's (TRD-017) recordSyncedTestCase()
 *     records, `{testCaseId, title, suiteId}`.
 *   - gapTasksFiled: ac-gap-task-filer.js's (TRD-021) recordFiledGapTask()
 *     records, `{taskWorkItemId, title, parentWorkItemId, acId, reqId}`.
 *
 * AC-012-1 only requires COUNTS to be printed, but each category is accepted
 * as an array rather than a bare number: a caller building these up
 * incrementally across a session would otherwise have to track a count AND a
 * list in lockstep (and risk them drifting), so `array.length` is the only
 * source of truth for each count here.
 *
 * "session or REQ-checkpoint" (AC-012-1's own wording) is one function with
 * a `scope` param ('session' | 'checkpoint', default 'session') rather than
 * two near-identical functions -- the counts/rendering logic is identical
 * either way; only the header line differs. req-batcher.js's (TRD-009)
 * renderCheckpointSummary is the per-REQ precedent this module is the
 * session-wide analog of.
 *
 * Convention: plain functions over plain data, matching req-batcher.js /
 * manual-ac-tracker.js / ado-test-case-sync.js / ac-gap-task-filer.js.
 *
 * TRD-023 extension (AC-011-2): a story where resume-scan.js's
 * `isStoryFullyCovered()` reports every AC already confirmed/manual/gap
 * needs a distinct "already complete, no changes made" report rather than
 * the usual category counts -- an `alreadyComplete: true` flag on the input
 * short-circuits to that message (same header framing, scope/reqId still
 * apply). Deliberately a flag rather than a second top-level function: the
 * header logic (session vs. checkpoint) is identical either way, and a
 * caller building up an already-complete check alongside a normal summary
 * call shouldn't need to import two different functions for what's really
 * one report shape with two bodies.
 */

const CATEGORIES = [
  ['testsWritten', 'Tests written'],
  ['testsConfirmed', 'Tests confirmed passing'],
  ['manualAcs', 'Manual/not-automatable ACs'],
  ['adoTestCasesSynced', 'ADO test cases synced'],
  ['gapTasksFiled', 'AC-gap tasks filed'],
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Best-effort human-readable identifier for one item in a category array, so
 * a non-empty category renders more than just a count. Handles every shape
 * this TRD's other modules actually produce (see module header); falls back
 * to a plain string or JSON for anything else rather than throwing -- this
 * module never rejects an item just because its shape is unfamiliar.
 */
function describeItem(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    if (isNonEmptyString(item.acId)) return item.acId;
    if (item.testCaseId !== undefined) return `Test Case ${item.testCaseId}`;
    if (item.taskWorkItemId !== undefined) return `Task ${item.taskWorkItemId}`;
    if (isNonEmptyString(item.title)) return item.title;
  }
  return JSON.stringify(item);
}

/** Render one category's `  Label: N` line, plus an indented item list when non-empty. */
function renderCategory(label, items) {
  const header = `  ${label}: ${items.length}`;
  if (items.length === 0) return header;
  const lines = items.map((item) => `    - ${describeItem(item)}`);
  return [header, ...lines].join('\n');
}

/**
 * Build the human-readable session/checkpoint completion summary (AC-012-1).
 * Missing categories default to an empty array (zero counts are a normal,
 * expected end state -- not every session has manual ACs or gap tasks) --
 * only a category that's PRESENT but not an array is an error.
 *
 * @param {object} [input]
 * @param {'session'|'checkpoint'} [input.scope='session']
 * @param {string} [input.reqId] - required, non-empty, when scope is 'checkpoint'
 * @param {boolean} [input.alreadyComplete=false] - TRD-023/AC-011-2: when
 *   true, renders "Already complete -- no changes made." instead of the
 *   category counts below (set this from resume-scan.js's
 *   isStoryFullyCovered()). Category args are ignored when true.
 * @param {Array} [input.testsWritten]
 * @param {Array} [input.testsConfirmed]
 * @param {Array} [input.manualAcs]
 * @param {Array} [input.adoTestCasesSynced]
 * @param {Array} [input.gapTasksFiled]
 * @returns {string} multi-line summary, ready to print to the console
 * @throws {Error} if input isn't an object, scope is invalid, reqId is
 *   missing for a 'checkpoint' scope, alreadyComplete is present but not a
 *   boolean, or any present category isn't an array
 */
function buildSessionSummary(input = {}) {
  if (input === null || typeof input !== 'object') {
    throw new Error('buildSessionSummary input must be an object');
  }

  const scope = input.scope || 'session';
  if (scope !== 'session' && scope !== 'checkpoint') {
    throw new Error("buildSessionSummary: scope must be 'session' or 'checkpoint'");
  }
  if (scope === 'checkpoint' && !isNonEmptyString(input.reqId)) {
    throw new Error("buildSessionSummary: reqId must be a non-empty string when scope is 'checkpoint'");
  }
  if (input.alreadyComplete !== undefined && typeof input.alreadyComplete !== 'boolean') {
    throw new Error('buildSessionSummary: alreadyComplete must be a boolean when present');
  }

  const header = scope === 'checkpoint' ? `${input.reqId.trim()} checkpoint summary` : 'Session summary';

  if (input.alreadyComplete === true) {
    return [header, '  Already complete -- no changes made.'].join('\n');
  }

  const errors = [];
  const lists = {};
  CATEGORIES.forEach(([key]) => {
    const value = input[key];
    if (value === undefined) {
      lists[key] = [];
    } else if (Array.isArray(value)) {
      lists[key] = value;
    } else {
      errors.push(`${key} must be an array when present`);
    }
  });
  if (errors.length > 0) {
    throw new Error(`Invalid buildSessionSummary input: ${errors.join('; ')}`);
  }

  const body = CATEGORIES.map(([key, label]) => renderCategory(label, lists[key]));

  return [header, ...body].join('\n');
}

module.exports = { buildSessionSummary };

// ponytail self-check: `node packages/e2e-testing/lib/session-summary.js`
// exercises the session/checkpoint header framing, zero-count defaults,
// mixed-shape item rendering, and input validation -- REQ-012 has no paired
// TEST task (see this TRD's requirements-traceability table), so this is the
// only coverage, matching delegation-contract.js's/ado-test-suite.js's
// precedent for tasks with no -TEST sibling.
if (require.main === module) {
  const assert = require('assert');

  // --- defaults: no args -> session scope, every category zero, no error ---
  const empty = buildSessionSummary();
  assert.ok(empty.startsWith('Session summary\n'));
  assert.ok(empty.includes('Tests written: 0'));
  assert.ok(empty.includes('Tests confirmed passing: 0'));
  assert.ok(empty.includes('Manual/not-automatable ACs: 0'));
  assert.ok(empty.includes('ADO test cases synced: 0'));
  assert.ok(empty.includes('AC-gap tasks filed: 0'));

  // --- session scope, populated with the real shapes this TRD's other
  // modules produce (manual-ac-tracker.js, ado-test-case-sync.js,
  // ac-gap-task-filer.js), plus plain strings for tests written/confirmed ---
  const populated = buildSessionSummary({
    testsWritten: ['AC-001-1', 'AC-001-2'],
    testsConfirmed: ['AC-001-1'],
    manualAcs: [{ acId: 'AC-017-1', status: 'manual', reason: 'visual-only check' }],
    adoTestCasesSynced: [{ testCaseId: '999', title: 'AC-007-1: ...', suiteId: '42' }],
    gapTasksFiled: [{ taskWorkItemId: '777', title: 'AC Gap: AC-009-1 (REQ-009)', acId: 'AC-009-1', reqId: 'REQ-009' }],
  });
  assert.ok(populated.includes('Tests written: 2'));
  assert.ok(populated.includes('    - AC-001-1'));
  assert.ok(populated.includes('Tests confirmed passing: 1'));
  assert.ok(populated.includes('Manual/not-automatable ACs: 1'));
  assert.ok(populated.includes('    - AC-017-1')); // acId preferred over other fields
  assert.ok(populated.includes('ADO test cases synced: 1'));
  assert.ok(populated.includes('    - Test Case 999')); // no acId on this shape -> testCaseId fallback
  assert.ok(populated.includes('AC-gap tasks filed: 1'));
  assert.ok(populated.includes('    - AC-009-1')); // acId present -> preferred over taskWorkItemId

  // --- checkpoint scope: header names the REQ, counts logic identical ---
  const checkpoint = buildSessionSummary({ scope: 'checkpoint', reqId: 'REQ-006', testsConfirmed: ['AC-006-1'] });
  assert.ok(checkpoint.startsWith('REQ-006 checkpoint summary\n'));
  assert.ok(checkpoint.includes('Tests confirmed passing: 1'));

  // --- TRD-023/AC-011-2: alreadyComplete short-circuits to a fixed message,
  // ignoring category counts entirely (a fully-covered story makes no
  // changes, so there's nothing to count) ---
  const alreadyDone = buildSessionSummary({ alreadyComplete: true, testsWritten: ['should be ignored'] });
  assert.strictEqual(alreadyDone, 'Session summary\n  Already complete -- no changes made.');
  const alreadyDoneCheckpoint = buildSessionSummary({
    scope: 'checkpoint',
    reqId: 'REQ-011',
    alreadyComplete: true,
  });
  assert.strictEqual(alreadyDoneCheckpoint, 'REQ-011 checkpoint summary\n  Already complete -- no changes made.');
  assert.throws(
    () => buildSessionSummary({ alreadyComplete: 'yes' }),
    /alreadyComplete must be a boolean when present/
  );

  // --- validation: never silently defaults on genuinely bad input ---
  assert.throws(() => buildSessionSummary(null), /input must be an object/);
  assert.throws(() => buildSessionSummary('nope'), /input must be an object/);
  assert.throws(() => buildSessionSummary({ scope: 'sprint' }), /scope must be 'session' or 'checkpoint'/);
  assert.throws(
    () => buildSessionSummary({ scope: 'checkpoint' }),
    /reqId must be a non-empty string when scope is 'checkpoint'/
  );
  assert.throws(
    () => buildSessionSummary({ scope: 'checkpoint', reqId: '  ' }),
    /reqId must be a non-empty string when scope is 'checkpoint'/
  );
  assert.throws(
    () => buildSessionSummary({ testsWritten: 'not-an-array' }),
    /testsWritten must be an array when present/
  );
  // collects every bad category in one error, doesn't stop at the first
  assert.throws(
    () => buildSessionSummary({ manualAcs: 1, gapTasksFiled: {} }),
    /manualAcs must be an array when present.*gapTasksFiled must be an array when present/s
  );

  // --- fallback rendering for an item shape none of the known modules produce ---
  const unknownShape = buildSessionSummary({ testsWritten: [{ weird: 'shape' }] });
  assert.ok(unknownShape.includes('    - {"weird":"shape"}'));

  console.log('session-summary.js self-check passed');
}
