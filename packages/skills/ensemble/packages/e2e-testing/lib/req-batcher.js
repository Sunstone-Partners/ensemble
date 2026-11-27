'use strict';

/**
 * TRD-009: REQ-level batching loop with checkpoints for
 * /ensemble:author-playwright-tests.
 *
 * Pure grouping/checkpoint logic only — no I/O, no prompt(), no shell-out.
 * "Asking the QA engineer whether to continue" is the orchestrating agent's own
 * conversational turn; this module just tells it, per REQ in order: which
 * ACs belong to it, whether it's fully done (checkpoint trigger, AC-004-1),
 * and a human-readable summary to print at that checkpoint.
 *
 * AC-004-2 (progress preserved across a stop) needs no new machinery here:
 * confirmedAcIds is expected to come from resume-scan.js's scanConfirmedAcs()
 * output (`.confirmed`), whose source of truth is the `@hash:` tags already
 * landed in spec files. Feeding the same parsePrdAcs()/scanConfirmedAcs()
 * output back into batchByReq() on a later run reproduces the same
 * `allDone: true` REQs with no re-processing — see the self-check below.
 *
 * Convention: plain functions over plain data, matching prd-ac-parser.js /
 * resume-scan.js / delegation-contract.js in this package.
 */

/**
 * Group a parsed PRD's REQs/ACs (prd-ac-parser.js's parsePrdAcs() shape)
 * against a set of already-confirmed AC ids (resume-scan.js's
 * scanConfirmedAcs() `.confirmed` shape) into per-REQ batches.
 *
 * @param {{reqs: Array<{id: string, acs: Array<{id: string, text: string}>}>}} parsedAcs
 * @param {string[]} confirmedAcIds - AC ids already confirmed (e.g. from a prior session)
 * @returns {Array<{reqId: string, acs: Array<{id: string, text: string}>, allDone: boolean, checkpointSummary: string}>}
 */
function batchByReq(parsedAcs, confirmedAcIds) {
  const confirmed = new Set((confirmedAcIds || []).map((id) => String(id).toUpperCase()));
  const reqs = (parsedAcs && parsedAcs.reqs) || [];

  return reqs.map((req) => {
    const acs = req.acs || [];
    const allDone = isReqComplete(acs, confirmed);
    return {
      reqId: req.id,
      acs,
      allDone,
      checkpointSummary: renderCheckpointSummary(req.id, acs, confirmed),
    };
  });
}

/**
 * A REQ is complete (checkpoint trigger, AC-004-1) once every one of its ACs
 * is in the confirmed set. A REQ with zero ACs is trivially complete.
 *
 * @param {Array<{id: string}>} acs
 * @param {Set<string>|string[]} confirmedAcIds
 * @returns {boolean}
 */
function isReqComplete(acs, confirmedAcIds) {
  const confirmed = confirmedAcIds instanceof Set
    ? confirmedAcIds
    : new Set((confirmedAcIds || []).map((id) => String(id).toUpperCase()));
  return (acs || []).every((ac) => confirmed.has(String(ac.id).toUpperCase()));
}

/**
 * Render the human-readable checkpoint summary printed once a REQ's ACs are
 * all done — "what was completed for that REQ" (AC-004-1).
 *
 * @param {string} reqId
 * @param {Array<{id: string, text: string}>} acs
 * @param {Set<string>|string[]} confirmedAcIds
 * @returns {string}
 */
function renderCheckpointSummary(reqId, acs, confirmedAcIds) {
  const confirmed = confirmedAcIds instanceof Set
    ? confirmedAcIds
    : new Set((confirmedAcIds || []).map((id) => String(id).toUpperCase()));
  const list = acs || [];

  if (list.length === 0) {
    return `${reqId}: no ACs found — nothing to checkpoint.`;
  }

  const lines = list.map((ac) => {
    const done = confirmed.has(String(ac.id).toUpperCase());
    const marker = done ? '[x]' : '[ ]';
    const text = ac.text ? `: ${ac.text}` : '';
    return `  ${marker} ${ac.id}${text}`;
  });

  const doneCount = list.filter((ac) => confirmed.has(String(ac.id).toUpperCase())).length;
  const header = `${reqId}: ${doneCount}/${list.length} ACs confirmed`;
  return [header, ...lines].join('\n');
}

module.exports = { batchByReq, isReqComplete, renderCheckpointSummary };

// ponytail self-check: `node packages/e2e-testing/lib/req-batcher.js` exercises
// batching + checkpoint detection + resume composability without a separate
// test file (TRD-009-TEST is a later task that formalizes this into Jest).
if (require.main === module) {
  const assert = require('assert');

  const parsed = {
    reqs: [
      {
        id: 'REQ-001',
        acs: [
          { id: 'AC-001-1', text: 'Given ... when ... then ...' },
          { id: 'AC-001-2', text: 'Given ... when ... then ...' },
        ],
      },
      {
        id: 'REQ-002',
        acs: [{ id: 'AC-002-1', text: 'Given ... when ... then ...' }],
      },
    ],
  };

  // Fresh session: nothing confirmed yet.
  const fresh = batchByReq(parsed, []);
  assert.strictEqual(fresh.length, 2);
  assert.strictEqual(fresh[0].reqId, 'REQ-001');
  assert.strictEqual(fresh[0].allDone, false);
  assert.strictEqual(fresh[1].allDone, false);

  // Resumed session (AC-004-2): REQ-001 fully confirmed by a prior session's
  // @hash: tags (as resume-scan.js's scanConfirmedAcs().confirmed would
  // report), REQ-002 still pending — REQ-001 must not be re-processed.
  const resumed = batchByReq(parsed, ['ac-001-1', 'AC-001-2']);
  assert.strictEqual(resumed[0].allDone, true);
  assert.ok(resumed[0].checkpointSummary.includes('2/2 ACs confirmed'));
  assert.ok(resumed[0].checkpointSummary.includes('[x] AC-001-1'));
  assert.strictEqual(resumed[1].allDone, false);
  assert.ok(resumed[1].checkpointSummary.includes('0/1 ACs confirmed'));

  // isReqComplete / renderCheckpointSummary standalone (splittable API surface).
  assert.strictEqual(isReqComplete(parsed.reqs[0].acs, new Set(['AC-001-1', 'AC-001-2'])), true);
  assert.strictEqual(isReqComplete(parsed.reqs[0].acs, ['AC-001-1']), false);
  assert.strictEqual(isReqComplete([], []), true); // no ACs -> trivially complete

  console.log('req-batcher.js self-check passed');
}
