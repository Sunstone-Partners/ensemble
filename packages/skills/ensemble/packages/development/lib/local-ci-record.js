'use strict';

/**
 * Local CI run record: build, parse and verify the compact status description
 * `ci-local <12-hex> | set:<8-hex> | log:<12-hex>` (at most 100 characters).
 *
 *   ci-local  first 12 hex of the git blob hash of the maintainer's trusted .ensemble/local-ci.yaml: the WHOLE config
 *             (steps, matrix, equivalents, exclusions), so this one field binds the command list that ran. 12 hex (48 bits),
 *             not 8, because it is the only field that does; the workflow-set hash below covers file names only.
 *   set       first 8 hex of sha256 over the sorted, de-duplicated workflow set
 *   log       first 12 hex of sha256 of the run log (the log is never embedded)
 *
 * The head SHA is implicit: it is the commit the status was posted on.
 * Pure functions, no I/O. FAIL CLOSED: malformed input yields `ok:false`
 * with an error and never partial fields.
 */

const crypto = require('crypto');

const MAX_LENGTH = 100;
const RUNNER_HEX = 12;
const RECORD_RE = /^ci-local ([0-9a-f]{12}) \| set:([0-9a-f]{8}) \| log:([0-9a-f]{12})$/;
const HEX_RE = /^[0-9a-fA-F]+$/;
const SHA_RE = /^[0-9a-fA-F]{40}$/;

function fail(error) {
  return { ok: false, error };
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Order-independent hash of a workflow set (array of non-empty strings). */
function hashWorkflowSet(workflowSet) {
  if (!Array.isArray(workflowSet)) return fail('workflowSet must be an array');
  for (const name of workflowSet) {
    if (typeof name !== 'string' || name.trim() === '') {
      return fail('workflowSet entries must be non-empty strings');
    }
  }
  const canonical = JSON.stringify([...new Set(workflowSet)].sort());
  return { ok: true, hash: sha256Hex(canonical).slice(0, 8) };
}

function buildRecord(input) {
  if (input === null || typeof input !== 'object') return fail('input must be an object');
  const { runnerBlobSha, workflowSet, log } = input;
  if (typeof runnerBlobSha !== 'string' || runnerBlobSha.length < RUNNER_HEX || !HEX_RE.test(runnerBlobSha)) {
    return fail(`runnerBlobSha must be a hex git blob hash of at least ${RUNNER_HEX} characters`);
  }
  if (typeof log !== 'string') return fail('log must be a string');
  const set = hashWorkflowSet(workflowSet);
  if (!set.ok) return set;

  const fields = {
    runner: runnerBlobSha.slice(0, RUNNER_HEX).toLowerCase(),
    set: set.hash,
    log: sha256Hex(log).slice(0, 12),
  };
  const description = `ci-local ${fields.runner} | set:${fields.set} | log:${fields.log}`;
  if (description.length > MAX_LENGTH) return fail('description exceeds 100 characters');
  return { ok: true, description, fields };
}

function parseRecord(description) {
  if (typeof description !== 'string') return fail('description must be a string');
  if (description.length > MAX_LENGTH) return fail('description exceeds 100 characters');
  const m = RECORD_RE.exec(description);
  if (!m) return fail('description is not a well-formed local CI record');
  return { ok: true, fields: { runner: m[1], set: m[2], log: m[3] } };
}

/**
 * input: { description, statusCommitSha, headSha, workflowSet }
 * statusCommitSha is the commit the status was posted on.
 */
function verifyRecord(input) {
  if (input === null || typeof input !== 'object') return fail('input must be an object');
  const { description, statusCommitSha, headSha, workflowSet } = input;
  const parsed = parseRecord(description);
  if (!parsed.ok) return parsed;
  for (const [k, v] of [['statusCommitSha', statusCommitSha], ['headSha', headSha]]) {
    if (typeof v !== 'string' || !SHA_RE.test(v.trim())) return fail(`${k} must be a 40-hex commit SHA`);
  }
  const set = hashWorkflowSet(workflowSet);
  if (!set.ok) return set;

  const result = { ok: true, fields: parsed.fields };
  // Commit SHAs are hex: compare case-insensitively (lower-cased).
  if (statusCommitSha.trim().toLowerCase() !== headSha.trim().toLowerCase()) {
    result.ok = false;
    result.headMismatch = `status commit ${statusCommitSha} does not match PR head ${headSha}`;
  }
  if (set.hash !== parsed.fields.set) {
    result.ok = false;
    result.setMismatch = `recorded set:${parsed.fields.set} differs from configured set:${set.hash}`;
  }
  // REQUIRED: the record must have been produced under this exact trusted config blob. Without it nothing binds the
  // command list (the set hash covers workflow file names only), so a missing value is refused, never skipped.
  const want = input.runnerBlobSha;
  if (typeof want !== 'string' || want.length < RUNNER_HEX || !HEX_RE.test(want)) {
    return fail(`runnerBlobSha is required: a hex git blob hash of the trusted config, at least ${RUNNER_HEX} characters`);
  }
  if (want.slice(0, RUNNER_HEX).toLowerCase() !== parsed.fields.runner) {
    result.ok = false;
    result.runnerMismatch = `recorded config ${parsed.fields.runner} differs from trusted config ${want.slice(0, RUNNER_HEX).toLowerCase()}`;
  }
  return result;
}

module.exports = { MAX_LENGTH, buildRecord, parseRecord, verifyRecord, hashWorkflowSet };
