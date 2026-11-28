'use strict';

/**
 * TRD-020 (TRD-2026-d571763f): the audit ledger.
 *
 * Every native verb that runs under a `--run-id` leaves one record under
 * `.ensemble/state/engine/<runId>/ledger/`: the verb, a hash of its input, a hash of the envelope
 * it answered with, and the status. The ledger exists so a person can see afterwards what a run
 * did; it is diagnostic only. NOTHING in the engine reads it to decide anything -- `implement
 * next` derives completion from the tracker, git and the TRD file (Constitution Rule 4), and a
 * test deletes the ledger to prove the answer does not move.
 *
 * The directory is created through the toolchain's `ensureStateDir`, which drops the
 * self-ignoring `.gitignore` at `.ensemble/state/`, and through the hand-off module's
 * `safeStateDir` / `writeFileSafely`, which refuse to follow a link out of the project. Recording
 * can never change what a verb answered: every failure here is swallowed.
 */

const fs = require('fs');
const path = require('path');

const { sortKeys } = require('./envelope');
const { runDirs, safeStateDir, sha256, writeFileSafely } = require('./handoff');
const { isValidRunId } = require('../toolchain/run-id');

/** The directory name under the run directory. */
const LEDGER_DIR = 'ledger';

/** @param {*} value @returns {string} the sha256 of its canonical (key-sorted) JSON text */
function hashOf(value) {
  return sha256(JSON.stringify(sortKeys(value === undefined ? null : value)));
}

/**
 * Record one verb call.
 *
 * @param {object} call the dispatcher's call object (needs `projectRoot`, `globals.runId`, `input`)
 * @param {object|null} envelope the envelope the verb answered with
 * @returns {string|null} the record's path, or null when nothing was recorded
 */
function recordCall(call, envelope) {
  try {
    const runId = call && call.globals && call.globals.runId;
    if (!isValidRunId(runId) || !call.projectRoot || !envelope) return null;

    const dir = safeStateDir(call, path.join(runDirs(call.projectRoot, runId).run, LEDGER_DIR));
    const seq = fs.readdirSync(dir).filter(name => name.endsWith('.json')).length + 1;
    const verb = String(envelope.verb || call.verb || '').replace(/[^A-Za-z0-9._-]+/g, '-');
    const target = path.join(dir, `${String(seq).padStart(4, '0')}-${verb}.json`);
    const record = {
      input_sha256: hashOf(call.input),
      output_sha256: hashOf(envelope),
      seq,
      status: envelope.status,
      step: envelope.verb,
    };
    writeFileSafely(target, `${JSON.stringify(sortKeys(record), null, 2)}\n`);
    return target;
  } catch {
    // A record that cannot be written must never change what the verb said.
    return null;
  }
}

module.exports = { LEDGER_DIR, hashOf, recordCall };
