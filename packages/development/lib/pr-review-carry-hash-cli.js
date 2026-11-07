#!/usr/bin/env node
'use strict';

/**
 * pr-review-carry-hash-cli.js -- entry point of the carry-hash step (kata qw98). JSON in on stdin, ONE JSON object out on
 * stdout (redacted with `redact` from pr-review-state.js), exit 0 when the request was read and hashed, 1 when it was not.
 *
 * It is NOT a subcommand of pr-review-cli.js: that CLI's modules are pure (no shell, no file reads), and hashing reads git
 * objects. Per-citation failures do not fail the run: that citation comes back with `hashError` and no hash (exit 0),
 * which `planCarry` treats as "re-verify".
 *
 * Usage: node pr-review-carry-hash-cli.js < payload.json
 *
 *   payload  { repoRoot?, headSha, citations:[{ id?, file, line?, lines?:[start,end], claim? }] }
 *            `repoRoot` defaults to the current directory; every other key is refused. Output:
 *            { ok, headSha, candidates:[{ ...citation, hunkHash?, depHashes?, hashError? }] } -- or { ok:false, error }.
 *            Contract, hunk definition and limits: pr-review-carry-hash.js (only what the cited file depends on is hashed;
 *            callers/importers and bare npm packages are not; the closure is capped at 200 files; an unresolved relative
 *            specifier is hashed as `absent`, so a path-looking string is harmless and a dangling import is invalidated
 *            when the file appears).
 */

const fs = require('fs');
const { hashCitations } = require('./pr-review-carry-hash');
const { redact } = require('./pr-review-state');

/** @param {Object} [io]  `{ readJson, emit, deps }`, replaced by tests. */
function main(io = {}) {
  const readJson = io.readJson || (() => JSON.parse(fs.readFileSync(0, 'utf8')));
  const emit = io.emit || ((value) => process.stdout.write(`${JSON.stringify(redact(value))}\n`));
  let payload;
  try {
    payload = readJson();
  } catch (err) {
    emit({ ok: false, error: `invalid JSON on stdin: ${err.message}` });
    return 1;
  }
  const result = hashCitations(payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? { repoRoot: process.cwd(), ...payload } : payload, io.deps);
  emit(result);
  return result.ok === true ? 0 : 1;
}

module.exports = { main };

if (require.main === module) {
  process.exit(main());
}
