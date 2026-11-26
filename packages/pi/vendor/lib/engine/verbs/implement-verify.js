'use strict';

/**
 * TRD-014 (TRD-2026-d571763f): `ensemble implement verify <trd>`, the completion verification of
 * `skills/completion-verification/SKILL.md` run as a recipe rather than recited to an agent.
 *
 * The verdict is a conclusion from evidence this verb gathers itself: the TRD's own task list,
 * the status the tracker reports for each of those tasks right now, the PRD's requirements, and
 * a fresh run of the whole suite. Nothing is taken from an earlier phase's recorded claim.
 *
 * `INCOMPLETE` is an answer, not an error: the run succeeded in finding gaps, and the caller --
 * `implement close` next -- is what refuses. What is an error is not being able to look: a
 * tracker that cannot be read ends the run `UNAVAILABLE` rather than letting a verdict be built
 * over missing statuses.
 *
 * A TRD the parser may have misread is itself a gap (`PARSE-FAILURE`), not a refusal, because
 * the operator's question -- is this TRD finished -- has an honest answer in that case: no, and
 * here is why.
 */

const fs = require('fs');
const path = require('path');

const { isResult } = require('../result');
const { readIssues, scopeBeads } = require('../tracker');
const { requireTrd } = require('../trd-source');
const { runTrd } = require('../cli-json');
const { runVerification } = require('../verification');

/**
 * The parsed TRD, or null when the parser could not be trusted to have read it.
 *
 * `readParsedTrd` turns a parse failure into a refusal, which is right for a verb that cannot act
 * without the TRD. Verification can: the recipe's step 1 records the failure as a gap and skips
 * the steps that would have depended on it, so this reads the result itself.
 *
 * @param {object} call the dispatcher's call object
 * @param {string} trdPath
 * @returns {object|null}
 */
function parseTrd(call, trdPath) {
  const result = runTrd(call, ['parse', trdPath]);
  if (!result.json || result.json.ok !== true || !result.json.trd) return null;
  return result.json.trd;
}

/**
 * @param {object} call dispatcher's call object
 * @returns {object} the verification report, or a tagged engine result
 */
function handler(call) {
  const trd = requireTrd(call);
  if (isResult(trd)) return trd;
  const trdPath = trd.path;

  const parsed = parseTrd(call, trdPath);
  const text = fs.readFileSync(path.resolve(call.projectRoot, trdPath), 'utf8');
  const slug = String((parsed && parsed.slug) || require('../trd-source').slugOf(trdPath));

  // Closure is read from one live listing, never from a cached export: a status that changed
  // since the last sync is exactly what verification exists to notice.
  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listed;
  const beads = scopeBeads(listed.issues, slug);

  const report = runVerification(call, { beads, parsed, slug, text, trdPath });
  if (isResult(report)) return report;

  const epics = beads.filter(bead => bead.kind === 'epic');
  const rootEpic = epics.find(bead => bead.status !== 'closed') || epics[0] || null;
  return {
    ...report,
    ROOT_EPIC_ID: rootEpic ? rootEpic.id : null,
    TRD_FILE_PATH: trdPath,
    TRD_SLUG: slug,
    WARNINGS: parsed && Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
  };
}

const spec = {
  exitCodes: [0, 1, 2, 5],
  group: 'implement',
  handler,
  inputSchema: {
    additionalProperties: false,
    properties: {
      trd: { type: 'string', 'x-operand': true },
    },
    type: 'object',
  },
  name: 'verify',
  outputSchema: {
    additionalProperties: false,
    properties: {
      MESSAGE: { type: 'string' },
      ROOT_EPIC_ID: { type: ['string', 'null'] },
      SUITE_OUTPUT: { type: ['string', 'null'] },
      TASKS_CHECKED: { type: 'integer' },
      TRACKING_MODE: { enum: ['beads'], type: 'string' },
      TRD_FILE_PATH: { type: 'string' },
      TRD_SLUG: { type: 'string' },
      WARNINGS: { items: { type: 'string' }, type: 'array' },
      gapCount: { type: 'integer' },
      gaps: {
        items: {
          additionalProperties: false,
          properties: {
            class: {
              enum: [
                'PARSE-FAILURE',
                'REQ-PRIORITY-UNPARSED',
                'TASK-OPEN',
                'TEST-GAP',
                'REQ-UNSATISFIED',
                'TEST-SUITE-FAILURE',
              ],
              type: 'string',
            },
            detail: { type: 'string' },
            priority: { type: 'string' },
            req: { type: 'string' },
            task: { type: 'string' },
            testTask: { type: 'string' },
          },
          required: ['class', 'detail'],
          type: 'object',
        },
        type: 'array',
      },
      reportPath: { type: 'string' },
      verdict: { enum: ['COMPLETE', 'INCOMPLETE'], type: 'string' },
    },
    required: [],
    type: 'object',
  },
  // Verification always writes its report, which is the durable record of the verdict and the
  // evidence behind it; the declaration must say so (Constitution Rule 5).
  policyKeys: [],
  sideEffect: 'write',
  summary: 'verify a TRD is complete and write the completion report',
};

module.exports = { spec };
