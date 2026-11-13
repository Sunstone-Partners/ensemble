'use strict';

/**
 * Execution: process launching with a hard timeout that kills the whole process tree, plus the suite scheduler
 * that enforces the cost cap with per-run reservations under concurrency.
 * Limits (cap, timeout, per-run and judge reservations, concurrency) are read from evals/limits.json.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LIMITS_FILE = path.join(__dirname, '..', 'limits.json');
const FALLBACK_LIMITS = { maxUsdPerSuite: 50, timeoutSec: 900, runReserveUsd: 5, judgeReserveUsd: 0.5, concurrency: 4 };
const EPS = 1e-9;

/** Defaults from limits.json (fallback constants when the file is absent). */
function loadLimits(file = LIMITS_FILE) {
  if (!fs.existsSync(file)) return { ...FALLBACK_LIMITS };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`limits file ${file} is not valid JSON: ${e.message}`); }
  const limits = { ...FALLBACK_LIMITS, ...parsed };
  for (const k of Object.keys(FALLBACK_LIMITS)) {
    if (typeof limits[k] !== 'number' || !(limits[k] >= 0)) throw new Error(`limits file ${file}: "${k}" must be a non-negative number`);
  }
  if (!(limits.maxUsdPerSuite > 0) || !(limits.timeoutSec > 0) || !(limits.concurrency >= 1)) {
    throw new Error(`limits file ${file}: maxUsdPerSuite, timeoutSec and concurrency must be positive`);
  }
  return limits;
}

function killTree(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * Run a command in its own process group. On timeout the whole group (the process and its children) is killed.
 * Resolves { transcript, stderr, exitCode, timedOut }; never rejects.
 */
function runProcess(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child); // reap stragglers still in the group
      resolve({ transcript: out, stderr: err.slice(-2000), exitCode, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    child.on('error', (e) => { err += e.message; finish(null); });
    child.on('close', (code) => finish(code));
  });
}

/**
 * USD reserved while a run is in flight: the per-run budget, plus the judge allowance when the eval has an
 * active judged check. `agent` runs only; runs that call no model reserve nothing. Never above the cap.
 */
function reservationFor({ model = true, judged = false }, { runReserveUsd, judgeReserveUsd, capUsd }) {
  if (!model && !judged) return 0;
  return Math.min((model ? runReserveUsd : 0) + (judged ? judgeReserveUsd : 0), capUsd);
}

/**
 * Run `items` in order, at most `concurrency` at a time. A run starts only when spend + in-flight reservations
 * + its own reservation fit under `capUsd`; the first item that does not fit stops all starts (later items are
 * not reordered around it). When nothing is in flight and the next still does not fit, the rest are unstarted.
 *
 * `reserve(item)` -> USD, `run(item)` -> Promise of a result with `costUsd` (null counts as 0).
 * Returns { done: [{ item, result }], unstarted: [item], spent, peakCommitted }.
 */
async function runSuite(items, { concurrency, capUsd, reserve, run, onSettle }) {
  const done = [];
  const queue = [...items];
  const active = new Map(); // item -> reservation
  const inflight = new Set();
  let spent = 0;
  let reserved = 0;
  let peakCommitted = 0;

  const startNext = () => {
    const item = queue[0];
    const r = Math.min(reserve(item), capUsd);
    if (spent + reserved + r > capUsd + EPS) return false;
    queue.shift();
    active.set(item, r);
    reserved += r;
    peakCommitted = Math.max(peakCommitted, spent + reserved);
    const settle = (result) => {
      active.delete(item);
      reserved -= r;
      spent += (result && result.costUsd) || 0;
      done.push({ item, result });
      if (onSettle) onSettle(item, result, spent);
    };
    const p = Promise.resolve().then(() => run(item)).then(settle, (e) => settle({ error: e && e.message ? e.message : String(e), costUsd: 0 }));
    const tracked = p.then(() => inflight.delete(tracked));
    inflight.add(tracked);
    return true;
  };

  while (queue.length) {
    while (queue.length && active.size < concurrency && startNext()) { /* fill free slots */ }
    if (!queue.length) break;
    if (active.size === 0) break; // next item can never fit
    await Promise.race(inflight);
  }
  await Promise.all(inflight);
  return { done, unstarted: queue, spent, peakCommitted };
}

module.exports = { loadLimits, runProcess, reservationFor, runSuite, killTree, LIMITS_FILE };
