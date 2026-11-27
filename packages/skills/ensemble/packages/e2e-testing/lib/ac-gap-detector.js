'use strict';

/**
 * TRD-020: AC-gap detection/tracking for /ensemble:author-playwright-tests
 * (REQ-009).
 *
 * SEMANTIC gap, not STRUCTURAL gap — read implementation-grounding.js (TRD-004)
 * first if you haven't. That module's `groundImplementation()` returns
 * `{grounded: false, gap: true, reason}` when the implementing CODE CAN'T BE
 * LOCATED AT ALL (no task satisfies the REQ, no target files, no resolvable
 * merge-base, etc.) — a grounding-*lookup* failure.
 *
 * THIS module covers the opposite case: grounding *succeeded*
 * (`grounded: true` — the diff/code was found), but an agent's judgment of
 * that grounded diff concludes it does NOT actually produce the AC's stated
 * Given/When/Then outcome (a stub, a TODO, an early-return that skips the
 * described logic, genuinely unrelated code, ...). Deciding *whether* grounded
 * code satisfies an AC is an LLM reasoning task at conversation time — the
 * same category as ac-decision-loop.js's accept/reject calls or the actual
 * test-authoring itself — not something a pure function computes. So this
 * module does NOT analyze diffs or make that judgment. It only tracks an
 * already-made judgment (`flagAcGap`) and implements the AC-009-2 review/
 * override state machine (`resolveGapReview`) on top of it, matching this
 * package's established pattern (manual-ac-tracker.js, ac-decision-loop.js).
 *
 * Status naming: this module's flagged status is `'ac-gap'` — deliberately
 * not just `'gap'`, to avoid colliding/being confused with
 * implementation-grounding.js's structural `gap: true` concept, and distinct
 * from resume-scan.js's `'confirmed'` and manual-ac-tracker.js's `'manual'`.
 * All four are legitimate, mutually exclusive per-AC outcomes in this package.
 *
 * Implementation AC (TRD-020):
 * - AC-009-1: the agent grounds a test in the real implementation, finds the
 *   code does NOT produce the AC's stated outcome, stops short of writing a
 *   test asserting behavior that doesn't exist, and flags the AC as a gap
 *   instead (`flagAcGap`).
 * - AC-009-2: the QA engineer reviews a flagged gap and either confirms it's real
 *   (routing to REQ-010/TRD-021's ADO task-filing — not implemented here,
 *   just signaled) or overrides it as a false read by pointing the agent at
 *   the correct code path (`resolveGapReview`).
 */

const VALID_REVIEW_DECISIONS = ['confirmed', 'override'];

/**
 * Flag an AC as a semantic gap, given the agent's already-made judgment that
 * grounded code does not satisfy the AC (AC-009-1).
 *
 * @param {string} acId - the AC id this gap applies to (e.g. "AC-009-1")
 * @param {object} context
 * @param {string} context.reqId - the REQ id the AC belongs to (e.g. "REQ-009")
 * @param {object} context.groundingResult - the result of a prior
 *   `implementation-grounding.js#groundImplementation()` call. Must be
 *   `{grounded: true, ...}` — see "Why groundingResult.grounded must be true"
 *   below for why a `grounded: false` structural gap is rejected here rather
 *   than silently accepted.
 * @param {string} context.reason - the agent's plain-text explanation of why
 *   the grounded code does not satisfy the AC (e.g. "handler is a stub that
 *   returns 501; the described validation logic doesn't exist yet")
 * @returns {{status: 'ac-gap', acId: string, reqId: string, reason: string,
 *            groundedFiles: string[], review: null}}
 * @throws {Error} if acId/reason are missing, or groundingResult is missing,
 *   malformed, or itself a structural (`grounded: false`) gap
 *
 * Why groundingResult.grounded must be true: a `grounded: false` result means
 * implementation-grounding.js never located the implementing code at all —
 * that's already a fully-handled, distinct situation (its own `gap: true`
 * reason string) and calling code should surface that directly rather than
 * re-wrapping it as a semantic AC-gap here. Passing one in is treated as a
 * caller error (thrown), not silently accepted, so the two gap concepts never
 * get conflated in the data.
 */
function flagAcGap(acId, context) {
  if (typeof acId !== 'string' || acId.trim() === '') {
    throw new Error('acId must be a non-empty string');
  }
  if (!context || typeof context !== 'object') {
    throw new Error('context is required (must include reqId, groundingResult, reason)');
  }
  if (typeof context.reqId !== 'string' || context.reqId.trim() === '') {
    throw new Error('context.reqId must be a non-empty string');
  }
  if (typeof context.reason !== 'string' || context.reason.trim() === '') {
    throw new Error('context.reason must be a non-empty string');
  }

  const groundingResult = context.groundingResult;
  if (!groundingResult || typeof groundingResult !== 'object') {
    throw new Error('context.groundingResult is required (a result from implementation-grounding.js)');
  }
  if (groundingResult.grounded !== true) {
    throw new Error(
      "context.groundingResult must be a 'grounded: true' result — a 'grounded: false' structural gap " +
        "is implementation-grounding.js's own concept (the code couldn't be located at all) and should " +
        'be surfaced directly, not re-flagged as a semantic AC gap here'
    );
  }

  return {
    status: 'ac-gap',
    acId,
    reqId: context.reqId,
    reason: context.reason,
    groundedFiles: Array.isArray(groundingResult.files) ? [...groundingResult.files] : [],
    review: null,
  };
}

/**
 * Record the QA engineer's review decision on a previously-flagged AC gap (AC-009-2).
 *
 * @param {string} acId - the AC id being reviewed (e.g. "AC-009-1")
 * @param {'confirmed'|'override'} decision - strictly one of the two; no
 *   silent default (matching ac-decision-loop.js's strictness)
 * @param {object} [details]
 * @param {string} [details.note] - optional free-text note, valid for either decision
 * @param {string[]} [details.correctedTargetFiles] - required when decision is
 *   'override': the correct file(s) the QA engineer points the agent at, for the
 *   orchestrator to feed back into a fresh `groundImplementation()` call
 * @returns {{outcome: 'gap-confirmed', acId: string, note: string|null}
 *   | {outcome: 'gap-overridden', acId: string, correctedTargetFiles: string[], note: string|null}}
 * @throws {Error} if decision is not exactly 'confirmed' or 'override', or
 *   details.correctedTargetFiles is missing/empty when decision is 'override'
 */
function resolveGapReview(acId, decision, details) {
  if (typeof acId !== 'string' || acId.trim() === '') {
    throw new Error('acId must be a non-empty string');
  }
  if (!VALID_REVIEW_DECISIONS.includes(decision)) {
    throw new Error(
      `Invalid decision '${decision}': must be one of ${VALID_REVIEW_DECISIONS.map((d) => `'${d}'`).join(', ')}`
    );
  }

  const opts = details && typeof details === 'object' ? details : {};
  const note = typeof opts.note === 'string' && opts.note.trim() !== '' ? opts.note : null;

  if (decision === 'confirmed') {
    // Real gap — routes to REQ-010/TRD-021's ADO task-filing. This module
    // only signals that outcome; ac-gap-task-filer.js (TRD-021) owns filing.
    return { outcome: 'gap-confirmed', acId, note };
  }

  // decision === 'override': false read — the QA engineer points at the correct code
  // path, which the orchestrator feeds back into a fresh groundImplementation() call.
  if (!Array.isArray(opts.correctedTargetFiles) || opts.correctedTargetFiles.length === 0) {
    throw new Error("details.correctedTargetFiles is required (non-empty array) when decision is 'override'");
  }

  return {
    outcome: 'gap-overridden',
    acId,
    correctedTargetFiles: [...opts.correctedTargetFiles],
    note,
  };
}

module.exports = { flagAcGap, resolveGapReview, VALID_REVIEW_DECISIONS };

// ponytail self-check: `node packages/e2e-testing/lib/ac-gap-detector.js`
// exercises flagAcGap() + resolveGapReview() without a separate test file
// (TRD-020-TEST is a separate, later task providing full coverage).
if (require.main === module) {
  const assert = require('assert');

  const groundedResult = {
    grounded: true,
    reqId: 'REQ-009',
    files: ['src/handlers/submitClaim.js'],
    diffs: [{ file: 'src/handlers/submitClaim.js', diff: '+ return res.status(501).end(); // TODO' }],
    partialGaps: [],
  };

  // AC-009-1: flagging a gap on grounded code
  const flagged = flagAcGap('AC-009-1', {
    reqId: 'REQ-009',
    groundingResult: groundedResult,
    reason: 'handler is a 501 stub; described validation logic does not exist yet',
  });
  assert.deepStrictEqual(flagged, {
    status: 'ac-gap',
    acId: 'AC-009-1',
    reqId: 'REQ-009',
    reason: 'handler is a 501 stub; described validation logic does not exist yet',
    groundedFiles: ['src/handlers/submitClaim.js'],
    review: null,
  });

  // distinct from implementation-grounding.js's structural gap and this
  // package's other per-AC statuses
  assert.notStrictEqual(flagged.status, 'gap');
  assert.notStrictEqual(flagged.status, 'confirmed');
  assert.notStrictEqual(flagged.status, 'manual');

  // missing fields -> thrown, never silently accepted
  assert.throws(() => flagAcGap('', { reqId: 'REQ-009', groundingResult: groundedResult, reason: 'x' }));
  assert.throws(() => flagAcGap('AC-009-1', { groundingResult: groundedResult, reason: 'x' }));
  assert.throws(() => flagAcGap('AC-009-1', { reqId: 'REQ-009', groundingResult: groundedResult, reason: '' }));
  assert.throws(() => flagAcGap('AC-009-1', { reqId: 'REQ-009', reason: 'x' }));

  // a structural (grounded: false) gap must not be re-flagged as a semantic gap
  const structuralGap = {
    grounded: false,
    gap: true,
    reqId: 'REQ-009',
    trdPath: 'docs/TRD/whatever.md',
    reason: "No task in 'docs/TRD/whatever.md' satisfies REQ-009",
  };
  assert.throws(
    () => flagAcGap('AC-009-1', { reqId: 'REQ-009', groundingResult: structuralGap, reason: 'x' }),
    /grounded: true/
  );

  // AC-009-2: confirmed -> routes to REQ-010/TRD-021's ADO task-filing
  assert.deepStrictEqual(resolveGapReview('AC-009-1', 'confirmed'), {
    outcome: 'gap-confirmed',
    acId: 'AC-009-1',
    note: null,
  });
  assert.deepStrictEqual(resolveGapReview('AC-009-1', 'confirmed', { note: 'filed on Story 4821' }), {
    outcome: 'gap-confirmed',
    acId: 'AC-009-1',
    note: 'filed on Story 4821',
  });

  // AC-009-2: override -> false read, requires a corrected target file
  const overridden = resolveGapReview('AC-009-1', 'override', {
    correctedTargetFiles: ['src/handlers/validateClaim.js'],
    note: 'grounding looked at the wrong handler',
  });
  assert.deepStrictEqual(overridden, {
    outcome: 'gap-overridden',
    acId: 'AC-009-1',
    correctedTargetFiles: ['src/handlers/validateClaim.js'],
    note: 'grounding looked at the wrong handler',
  });
  assert.throws(
    () => resolveGapReview('AC-009-1', 'override'),
    /correctedTargetFiles is required/
  );
  assert.throws(
    () => resolveGapReview('AC-009-1', 'override', { correctedTargetFiles: [] }),
    /correctedTargetFiles is required/
  );

  // strictly one of the two decisions -- no silent default, no fuzzy match
  assert.throws(() => resolveGapReview('AC-009-1', 'maybe'), /Invalid decision 'maybe'/);
  assert.throws(() => resolveGapReview('AC-009-1', 'Confirmed'));

  console.log('ac-gap-detector.js self-check passed');
}
