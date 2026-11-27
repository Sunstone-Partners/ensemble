'use strict';

/**
 * CI as the tests fact -- for a review of someone else's PR (a review-only run).
 *
 * The review cycle normally records the exit code of a test run it made itself. On a PR somebody else pushed, the
 * host has usually run the tests already, and a green result for the EXACT head commit may stand in for a local run.
 * That result is never a flag a caller can set: it is DERIVED here from the check runs the host lists for that commit,
 * read the way `remote` reads a check run (`checkOutcome` in pr-review-remote.js), and `pr-review-status.js` derives it
 * again from the raw runs on every call -- a recorded `passed` is never read back as a fact.
 * NO side effects, NO shell, NO network calls: the caller supplies the already-read facts.
 *
 * FAIL CLOSED. Only a recognised good value counts. Anything missing, malformed or unrecognised is a reason the tests are
 * NOT shown passing, and a caller then needs a real local exit code (the status says `run-tests`).
 *
 *   headSha     REQUIRED. The commit the tests must be for: a full object id, never a ref.
 *   checkRuns   REQUIRED array: the host's check runs for that commit, each { id?, name?, commitSha, conclusion }.
 *               Pass `[]` for "none"; a missing or non-array value is not "none", it is unreadable.
 *   totalCount  REQUIRED non-negative integer: the total the host itself reported for that listing. The host pages its
 *               answer (30 a page unless asked for more), so a list shorter than that total has silently dropped runs --
 *               possibly the failing one. The list is complete only when its length equals the total.
 *
 * Verdict for each check run:
 *
 *   another commit     `commitSha` is text and is not headSha: it says nothing about this head and is ignored (counted
 *                      in `ignored`), whatever its conclusion. Comparison is exact: no case folding.
 *   success            bound to headSha: it counts as evidence.
 *   skipped, stale,    no verdict either way: neither evidence nor an objection (counted in `inert`). `neutral` is here
 *   neutral            too -- unlike a bot's review, a neutral run does not show that tests passed.
 *   failure, cancelled,  an objection: the tests are not shown passing.
 *   timed_out,
 *   action_required
 *   no conclusion      still running: not shown passing. Likewise an unrecognised conclusion.
 *   no commit identity `commitSha` missing, blank or not text: it cannot be shown to concern another commit, so an
 *                      objection from it still blocks, but it is never evidence (`unbound`).
 *   not an object      a malformed entry (a hole in a sparse array included) might be exactly the run that objects, so
 *                      it blocks and is never skipped silently.
 *
 * `passed` is true exactly when the facts are readable, the list is complete, nothing objected AND at least one run bound
 * to headSha concluded `success` -- the same shape as REMOTE_REVIEW_COMPLETE, so an empty or irrelevant list never passes.
 *
 * Honest limit: this sees only what the host lists. A workflow that has not started has no check run yet and so cannot
 * object, and every check run on the commit counts alike -- there is no way here to tell the repository's test job from
 * any other. The `counted` runs are returned by id and name so the report shows exactly which ones stood in for the tests.
 *
 * @param {Object} facts
 * @param {string} facts.headSha
 * @param {Array}  facts.checkRuns
 * @param {number} facts.totalCount
 * @returns {{passed: boolean, headSha: ?string, counted: Array<{id: (string|number|null), name: ?string}>, ignored: number,
 *   inert: number, unbound: number, total: ?number, reasons: string[]}}
 *   `reasons` is empty exactly when `passed` is true.
 */

const { isObjectId } = require('./pr-review-scope');
const { checkOutcome } = require('./pr-review-remote');

/** Most of the host's own text a reason or a counted entry will carry. */
const TEXT_LIMIT = 60;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** How a run reads in a reason: its quoted name, cut short; else its id; else its position. Nothing longer comes from the host. */
function describeRun(run, index) {
  if (isText(run.name)) return JSON.stringify(run.name.trim().slice(0, TEXT_LIMIT));
  if (typeof run.id === 'number' || isText(run.id)) return `#${String(run.id).slice(0, TEXT_LIMIT)}`;
  return `at position ${index + 1}`;
}

function evaluateCiTests(facts = {}) {
  const input = isObject(facts) ? facts : {};
  const reasons = [];
  const note = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  const headSha = isObjectId(input.headSha) ? input.headSha : null;
  if (headSha === null) note('headSha is not a full object id, so no check run can be bound to it');

  const counted = [];
  let ignored = 0;
  let inert = 0;
  let unbound = 0;
  let malformed = 0;
  let total = null;

  if (!Array.isArray(input.checkRuns)) {
    note('checkRuns must be an array (an empty one says there are none)');
  } else {
    const runs = input.checkRuns;
    total = runs.length;

    const reported = input.totalCount;
    if (!Number.isSafeInteger(reported) || reported < 0) {
      note('totalCount must be the host\'s own non-negative integer total: the list cannot be shown complete without it');
    } else if (reported !== runs.length) {
      note(`the check run list is incomplete or inconsistent: ${runs.length} listed, the host reports ${reported}`);
    }

    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      if (!isObject(run)) {
        malformed += 1;
        continue;
      }
      const bound = isText(run.commitSha);
      if (bound && run.commitSha !== headSha) {
        ignored += 1;
        continue;
      }

      const outcome = checkOutcome(run);
      if (outcome === 'failed') {
        note(`check run ${describeRun(run, index)} did not succeed (${run.conclusion.toLowerCase()})`);
      } else if (outcome === 'incomplete') {
        note(`check run ${describeRun(run, index)} has not concluded`);
      } else if (outcome === 'unrecognised') {
        note(`check run ${describeRun(run, index)} has an unrecognised conclusion`);
      } else if (outcome === 'inert' || run.conclusion.toLowerCase() !== 'success') {
        inert += 1;
      } else if (!bound) {
        unbound += 1;
      } else {
        counted.push({
          id: typeof run.id === 'number' || isText(run.id) ? run.id : null,
          name: isText(run.name) ? run.name.trim().slice(0, TEXT_LIMIT) : null,
        });
      }
    }

    if (malformed > 0) note(`checkRuns holds ${malformed} entr${malformed === 1 ? 'y' : 'ies'} that ${malformed === 1 ? 'is' : 'are'} not an object`);
    if (reasons.length === 0 && counted.length === 0) {
      note('no check run bound to the head commit concluded success');
    }
  }

  return { passed: reasons.length === 0, headSha, counted, ignored, inert, unbound, total, reasons };
}

module.exports = { evaluateCiTests };
