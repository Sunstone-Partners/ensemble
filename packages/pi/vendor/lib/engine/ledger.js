'use strict';

/**
 * TRD-020 (TRD-2026-d571763f): the audit ledger.
 *
 * Every native verb that runs under a `--run-id` leaves one record under
 * `.ensemble/state/engine/<runId>/ledger/NNNN.json`: the verb, a hash of its input, a hash of the envelope
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

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { sortKeys } = require('./envelope');
const { runDirs, safeStateDir, sha256 } = require('./handoff');
const { isValidRunId } = require('../toolchain/run-id');

/** The directory name under the run directory. */
const LEDGER_DIR = 'ledger';

/** @param {*} value @returns {string} the sha256 of its canonical (key-sorted) JSON text */
function hashOf(value) {
  return sha256(JSON.stringify(sortKeys(value === undefined ? null : value)));
}

/**
 * Create `<dir>/NNNN.json` without ever replacing a file that is already there.
 *
 * Two verbs finishing at once under one run id must both leave a record. The body is written to
 * a private temporary file and then `link`ed to the target name: `link` fails with EEXIST rather
 * than replacing, so the number a writer lost to someone else is simply the next one tried. The
 * number is the whole file name, so no two records can share it.
 *
 * @returns {string} the path written
 */
function allocateRecord(dir, build) {
  const taken = fs
    .readdirSync(dir)
    .map(name => /^(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map(match => Number(match[1]));
  let seq = (taken.length === 0 ? 0 : Math.max(...taken)) + 1;
  for (let attempt = 0; attempt < 1000; attempt++, seq++) {
    const target = path.join(dir, `${String(seq).padStart(4, '0')}.json`);
    const tmp = path.join(dir, `.${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, build(seq), { flag: 'wx' });
      fs.linkSync(tmp, target);
      return target;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  throw new Error('ledger: no free record number');
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
    const inputHash = hashOf(call.input);
    const outputHash = hashOf(envelope);
    return allocateRecord(dir, seq =>
      `${JSON.stringify(
        sortKeys({
          input_sha256: inputHash,
          output_sha256: outputHash,
          seq,
          status: envelope.status,
          step: envelope.verb,
        }),
        null,
        2
      )}\n`
    );
  } catch {
    // A record that cannot be written must never change what the verb said.
    return null;
  }
}

module.exports = { LEDGER_DIR, hashOf, recordCall };
