'use strict';

/**
 * Shared run-id charset validator (TRD-2026-8d825f54 TRD-014/TRD-015, PR 3 review round 2,
 * Finding 3). `preflight.js`, `ledger.js` and `toolchain-cli.js` each build a filesystem path
 * under `.ensemble/state/toolchain/` out of a caller-supplied run id
 * (`preflight-<runId>.json`, `ledger-<runId>.jsonl`, `failure-<runId>.json`) and each used to
 * run its OWN, narrower, separately-maintained check (reject only `/`, `\`, `..`). That let
 * through two real problems a shared, stricter charset closes:
 * - Filename collisions: a run id of `VICTIM.json` builds the exact same `preflight-` prefixed
 *   path as a run id of `VICTIM` once this module's own literal `.json` suffix is appended
 *   (`preflight-VICTIM.json.json` was never the collision; `preflight-VICTIM.json` built from
 *   the id `VICTIM.json` IS identical to the path built from the id `VICTIM` with its own
 *   `.json` suffix). Forbidding `.` entirely removes every such suffix-collision, not just the
 *   one example found.
 * - Unprintable/control characters and raw newlines, which the old checks never considered,
 *   reaching a JSON record's `runId` field or a filename.
 *
 * This module is the SINGLE shared definition: `preflight.js#isSafeRunId`,
 * `ledger.js#assertValidRunId` and `toolchain-cli.js`'s `run` subcommand handler all call
 * `isValidRunId`/`invalidRunIdMessage` here; none keeps its own regex.
 *
 * Charset: `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` -- starts with an alphanumeric character, every
 * following character is alphanumeric, `_` or `-`, 1-128 characters total. No dots (closes the
 * suffix-collision above and every other extension-style collision, not just `.json`), no path
 * separators, no control characters, no non-ASCII. This comfortably accepts every run-id shape
 * already used in this repo's own tests and fixtures (`r1`, `run-1`, `real-run-ac3-first`, a
 * UUID, a Foreman-style run id) and the TRD's own generic `R` placeholder (TRD System
 * Architecture data-flow step 4: `toolchain-cli run ... --run-id R`); neither the TRD nor the
 * PRD defines a stricter or different run-id format.
 */

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * @param {unknown} runId
 * @returns {boolean} whether `runId` is safe to interpolate into a
 *   `.ensemble/state/toolchain/` filename and collision-free against every other id this
 *   module accepts.
 */
function isValidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_PATTERN.test(runId);
}

/**
 * The single, shared `INVALID_RUN_ID` message text every caller uses, naming the offending id
 * via `JSON.stringify` (so control characters, quotes and non-ASCII are escaped for safe
 * display instead of printed raw into a terminal, log line or JSON envelope).
 *
 * @param {unknown} runId
 * @returns {string}
 */
function invalidRunIdMessage(runId) {
  return (
    `runId ${JSON.stringify(typeof runId === 'string' ? runId : String(runId))} is invalid: ` +
    'run ids must start with a letter or digit and contain only letters, digits, "_" or "-" ' +
    '(1-128 characters; no dots, no path separators, no control characters)'
  );
}

module.exports = { isValidRunId, invalidRunIdMessage, RUN_ID_PATTERN };
