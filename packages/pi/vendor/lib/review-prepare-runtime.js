'use strict';

/**
 * review-prepare-runtime.js -- the two pieces of the per-head preparation step
 * (pr-review-prepare.js) that are not pure logic:
 *
 *   defaultDeps    the real `git` and process runner. This is the ONLY place the
 *                  preparation step shells out; pr-review-prepare.js itself takes
 *                  them as injectable `deps` (the pattern of local-ci-runner.js),
 *                  so the `pr-review-*.js` modules stay free of `child_process`.
 *   PROBE_SOURCE   the text written to `probe.js`, the probe runner agents import.
 *                  It runs in a fresh process next to the snapshot, so it carries
 *                  its own `child_process` use.
 */

const { spawnSync } = require('child_process');

const DEFAULT_BASELINE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 1024 * 1024 * 1024;

function defaultDeps() {
  return {
    /** `git <args>` in `cwd`; `buffer: true` returns stdout as a Buffer (diffs and archives are bytes, not text). */
    git(args, { cwd, input, buffer = false } = {}) {
      const r = spawnSync('git', args, {
        cwd, input, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: MAX_BUFFER,
      });
      const text = (value) => (value === null || value === undefined ? '' : String(value));
      return {
        status: r.error ? 127 : r.status,
        stdout: r.stdout === null || r.stdout === undefined ? (buffer ? Buffer.alloc(0) : '') : r.stdout,
        stderr: text(r.stderr) || (r.error ? String(r.error.message) : ''),
      };
    },
    /** `argv[0] argv[1..]` with NO shell. A hung run is killed with its whole process group. */
    run(argv, { cwd, env, timeoutMs = DEFAULT_BASELINE_TIMEOUT_MS } = {}) {
      const r = spawnSync(argv[0], argv.slice(1), {
        cwd, env, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs, killSignal: 'SIGKILL', detached: true,
      });
      const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
      if (timedOut && r.pid) {
        try { process.kill(-r.pid, 'SIGKILL'); } catch { /* group already gone */ }
      }
      return {
        status: r.error ? null : r.status,
        signal: r.signal || null,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        timedOut,
        spawnError: r.error && !timedOut ? String(r.error.message) : null,
      };
    },
  };
}

/* -------------------------------------------------------------- probe runner */

/**
 * The probe runner written to `probe.js`: the one file an agent `require()`s instead of rebuilding a harness. It
 * is self-contained (node builtins only) and locates everything relative to itself, so it works wherever the
 * prepared directory is read. Its `chain` is the end-to-end pattern: a list of steps, each given the results of the
 * ones before it, run in order, every outcome recorded.
 */
const PROBE_SOURCE = `'use strict';
// Written by pr-review-prepare.js. A probe harness for the frozen snapshot next to it. Do not edit.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const dir = __dirname;
const snapshot = path.join(dir, 'snapshot');
const facts = JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8'));

// The snapshot carries no node_modules (nothing may be written inside it): third-party requires resolve from the
// repository the review runs in.
const nodeModules = facts.nodeModules || null;
if (nodeModules) {
  process.env.NODE_PATH = [nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
}

/** Absolute path of \`rel\` inside the snapshot; a path that escapes it is refused. */
function inSnapshot(rel) {
  const abs = path.resolve(snapshot, String(rel));
  if (abs !== snapshot && !abs.startsWith(snapshot + path.sep)) throw new Error('path escapes the snapshot: ' + rel);
  return abs;
}

/** \`require()\` a module of the reviewed head. */
function load(rel) { return require(inSnapshot(rel)); }

/** Text of a file of the reviewed head. */
function read(rel) { return fs.readFileSync(inSnapshot(rel), 'utf8'); }

/** Text of a file at the BASE commit, or null when the base has no such file. */
function readAtBase(rel) {
  const r = spawnSync('git', ['cat-file', 'blob', facts.baseSha + ':' + rel], { cwd: facts.repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Runs argv (no shell), by default inside the snapshot, which is read-only: a probe that tries to write there fails loudly. */
function run(argv, { input, cwd, env, timeoutMs = 120000 } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: cwd || snapshot, input, env: { ...process.env, ...(env || {}) }, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024,
  });
  return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: !!(r.error && r.error.code === 'ETIMEDOUT'), error: r.error && r.error.code !== 'ETIMEDOUT' ? String(r.error.message) : null };
}

/**
 * Runs steps in order. A step is { name, run(ctx) }; ctx = { results, facts, snapshot, load, read, readAtBase, run }
 * with results[name] holding each finished step's value. A step that throws is recorded as failed and ends the
 * chain unless it has \`continue: true\`.
 */
function chain(steps) {
  const results = {};
  const outcomes = [];
  const ctx = { results, facts, snapshot, load, read, readAtBase, run };
  let ok = true;
  for (const step of steps) {
    try {
      const value = step.run(ctx);
      results[step.name] = value;
      outcomes.push({ name: step.name, ok: true, value });
    } catch (err) {
      ok = false;
      outcomes.push({ name: step.name, ok: false, error: err && err.message ? err.message : String(err) });
      if (step.continue !== true) break;
    }
  }
  return { ok, steps: outcomes };
}

module.exports = { snapshot, facts, load, read, readAtBase, run, chain };
`;

module.exports = { defaultDeps, PROBE_SOURCE, DEFAULT_BASELINE_TIMEOUT_MS, MAX_BUFFER };
