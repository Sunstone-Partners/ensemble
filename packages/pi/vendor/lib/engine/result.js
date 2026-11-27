'use strict';

/**
 * TRD-005 (TRD-2026-d571763f): how a native verb says something other than "OK".
 *
 * A verb handler returns plain data for the ordinary case, and one of these tagged results when
 * the answer is a refusal, an unavailable dependency or a choice the caller must make. The tag
 * is a registered symbol, so a handler cannot produce a refusal by accident: plain data shaped
 * like a refusal stays data.
 *
 * `NEEDS_CHOICE` is carried as `data`, not as an error, because the choice is the answer: the
 * caller is expected to re-run with one of the offered option's arguments appended.
 */

const { buildEnvelope } = require('./envelope');

/** The tag that distinguishes a deliberate result from plain data. */
const RESULT = Symbol.for('ensemble.engine.result');

/** The statuses that travel as an error rather than as data. */
const ERROR_STATUSES = Object.freeze(['REFUSED', 'UNAVAILABLE', 'INVALID_INPUT']);

/**
 * @param {*} value
 * @returns {boolean} true when `value` is a tagged engine result
 */
function isResult(value) {
  return Boolean(value) && typeof value === 'object' && value[RESULT] === true;
}

function make(status, code, message, details) {
  return { [RESULT]: true, code, details, message, status };
}

/**
 * The verb understood the request and declines it.
 * @param {string} code
 * @param {string} message
 * @param {*} [details]
 * @returns {object}
 */
function refused(code, message, details = null) {
  return make('REFUSED', code, message, details);
}

/**
 * A dependency the verb needs could not be reached. Never used to report "nothing found": an
 * outage that reads as an empty result is a check that cannot fail (Constitution Rule 7).
 * @param {string} code
 * @param {string} message
 * @param {*} [details]
 * @returns {object}
 */
function unavailable(code, message, details = null) {
  return make('UNAVAILABLE', code, message, details);
}

/**
 * The verb cannot decide alone and offers the caller the options it may pick from.
 * @param {{id: string, question: string, flag: string|null, options: object[]}} choice
 * @returns {object}
 */
function needsChoice(choice) {
  const result = make('NEEDS_CHOICE', null, null, null);
  result.data = { CHOICE: choice };
  return result;
}

/**
 * The verb has done every mechanical step it can and the model must do the rest (TRD-016).
 * The manifest is the answer, so it travels as `data` with the `next` command the model runs
 * once it has written the agents' result files.
 * @param {{agents: object[], baseHead: string, runId: string}} manifest
 * @param {*} next what to run after the agents finish (`implement accept ...`)
 * @returns {object}
 */
function needsAgent(manifest, next) {
  const result = make('NEEDS_AGENT', null, null, null);
  result.data = manifest;
  result.next = next === undefined ? null : next;
  return result;
}

/**
 * @param {string} verb the label the envelope carries
 * @param {object} res a tagged result
 * @returns {object} the envelope
 */
function toEnvelope(verb, res) {
  if (ERROR_STATUSES.includes(res.status)) {
    return buildEnvelope({
      error: { code: res.code, details: res.details, message: res.message },
      ok: false,
      status: res.status,
      verb,
    });
  }
  return buildEnvelope({
    data: res.data === undefined ? null : res.data,
    next: res.next === undefined ? null : res.next,
    ok: true,
    status: res.status,
    verb,
  });
}

/**
 * Build a throwable carrying an engine status, for the paths that must abort rather than return
 * (input resolution inside the dispatcher, a verb deep in a helper).
 * @param {string} status
 * @param {string} code
 * @param {string} message
 * @param {*} [details]
 * @returns {Error}
 */
function engineError(status, code, message, details = null) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  err.status = status;
  return err;
}

module.exports = {
  RESULT,
  engineError,
  isResult,
  needsAgent,
  needsChoice,
  refused,
  toEnvelope,
  unavailable,
};
