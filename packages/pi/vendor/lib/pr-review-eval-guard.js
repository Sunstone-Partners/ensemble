#!/usr/bin/env node
'use strict';

/**
 * Quality guard for the review pipeline: fails when an Important finding the
 * eval set expects is lost (kata cwd4, plan section 5, third bullet:
 * "A faster run that loses a real Important finding is a regression, not a
 * win").
 *
 * `pr-review-eval.js` grades; this module COLLECTS. It reads the eval cases,
 * CODEOWNERS and a pipeline's output, runs them through `validateCase`,
 * `scoreEval`, `staleCases` and `compareEval`, and turns the answer into a
 * process exit code. It is the one place the eval library touches files and
 * git, so those are injected (`deps`, as in `local-ci-runner.js`) and every
 * failure path can be driven without a repository.
 *
 * FAIL CLOSED, in the direction that costs the pipeline the benefit of the
 * doubt:
 *   - a case file that cannot be read or parsed, a case `validateCase`
 *     refuses, a case with no pinned commit, and an unreadable findings file
 *     are all failures -- never a smaller eval set that happens to pass;
 *   - a case whose expected Important finding is absent from the pipeline's
 *     output fails the run (exit 1), as does a case the history says an
 *     earlier run found but this run no longer lists (deleting a case file
 *     does not dodge the guard);
 *   - a pinned commit this checkout has (shallow clones lack old ones) must
 *     contain the case's file at the recorded lines, or the case is a
 *     `pin-mismatch` failure; a pinned commit it does not have is reported
 *     `unverifiable`, never `verified`;
 *   - a stale case (its rules file changed) is reported for owner re-review
 *     and does not fail by default, because a stale case is still evidence the
 *     pipeline must satisfy; `failOnStale` makes it fail.
 *
 * Usage:
 *   node pr-review-eval-guard.js --findings <file> [--cases <dir>] [--repo <root>]
 *        [--history <file>] [--reviewer <label>] [--fail-on-stale]
 *
 *   --findings  JSON `{ "findingsByCase": { "<case id>": [ finding... ] } }`
 *               (the shape `pr-review-eval` MODE=run collects); each finding
 *               carries `severity` and a `locationOrLink` of `file:line`.
 *   --cases     Case directory, relative to the repo; default `docs/review-eval/cases`.
 *   --history   JSONL eval history. The last entry is compared with this run
 *               (`compareEval`) and this run is appended -- failures included,
 *               so the false-negative rate over time is complete.
 *
 * Exit: 0 every expected Important finding present; 1 a finding lost or the
 * guard could not prove otherwise; 2 bad usage. One JSON object on stdout.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateCase, scoreEval, compareEval, staleCases, DEFAULT_EVAL_CASES_DIR } = require('./pr-review-eval');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** A 40-hex commit SHA anywhere in a case's `change` text: the commit the bug location is pinned to. */
const PINNED_SHA = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/i;

const CODEOWNERS_REL = '.github/CODEOWNERS';

function defaultDeps() {
  return {
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    readDir: (dir) => fs.readdirSync(dir),
    appendFile: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, text);
    },
    exists: (file) => fs.existsSync(file),
    git: (args, options) => {
      const result = spawnSync('git', args, {
        cwd: options && options.cwd,
        input: options && options.input,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      return {
        status: result.status === null ? 1 : result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
      };
    },
    now: () => new Date().toISOString(),
  };
}

function blocked(reason, extra) {
  return {
    ok: false,
    pass: false,
    reason,
    cases: 0,
    found: 0,
    missed: [],
    falseNegativeRate: null,
    stale: [],
    unloadable: [],
    invalid: [],
    pins: {},
    comparison: null,
    ...(extra || {}),
  };
}

/** Reads every `*.json` directly under `dir` as a case; a file that does not parse is `unloadable`, not skipped. */
function loadCases(deps, absDir, relDir) {
  let names;
  try {
    names = deps.readDir(absDir);
  } catch (err) {
    return { error: `cannot read the eval cases directory ${relDir}: ${err.message}` };
  }
  const cases = [];
  const files = {};
  const unloadable = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const rel = `${relDir.replace(/\/+$/, '')}/${name}`;
    try {
      const record = JSON.parse(deps.readFile(path.join(absDir, name)));
      if (!isObject(record)) throw new Error('not a JSON object');
      cases.push(record);
      files[rel] = record;
    } catch (err) {
      unloadable.push({ file: rel, reason: err.message });
    }
  }
  return { cases, files, unloadable };
}

/** Checks one case against the commit its location is pinned to. */
function checkPin(deps, repoRoot, record) {
  const location = isObject(record.location) ? record.location : {};
  const match = PINNED_SHA.exec(typeof record.change === 'string' ? record.change : '');
  if (match === null) return { status: 'no-pinned-sha' };
  const sha = match[0].toLowerCase();
  const have = deps.git(['cat-file', '-e', `${sha}^{commit}`], { cwd: repoRoot });
  if (have.status !== 0) return { status: 'unverifiable', sha };
  const blob = deps.git(['show', `${sha}:${location.path}`], { cwd: repoRoot });
  if (blob.status !== 0) return { status: 'pin-mismatch', sha, reason: 'path-absent-at-pinned-commit' };
  const lines = blob.stdout.split('\n').length - (blob.stdout.endsWith('\n') ? 1 : 0);
  if (location.endLine > lines) return { status: 'pin-mismatch', sha, reason: `file-has-${lines}-lines` };
  return { status: 'verified', sha };
}

/** The `rulesFile` -> git blob hash map `staleCases` needs; an unreadable file is left out, which makes its cases stale. */
function rulesHashesFor(deps, repoRoot, cases) {
  const hashes = {};
  for (const record of cases) {
    if (!isText(record.rulesFile)) continue;
    const rel = record.rulesFile.trim().replace(/^\.\//, '');
    if (Object.prototype.hasOwnProperty.call(hashes, rel)) continue;
    const abs = path.join(repoRoot, rel);
    if (!deps.exists(abs)) continue;
    const hashed = deps.git(['hash-object', '--no-filters', '--', rel], { cwd: repoRoot });
    if (hashed.status === 0 && isText(hashed.stdout)) hashes[rel] = hashed.stdout.trim();
  }
  return hashes;
}

/** The last parseable history entry, or null; a corrupt line is `unreadable`, never skipped silently. */
function lastHistoryEntry(deps, historyPath) {
  if (!deps.exists(historyPath)) return { entry: null };
  let text;
  try {
    text = deps.readFile(historyPath);
  } catch (err) {
    return { error: `cannot read the eval history: ${err.message}` };
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return { entry: null };
  try {
    const entry = JSON.parse(lines[lines.length - 1]);
    if (!isObject(entry) || !Array.isArray(entry.cases)) throw new Error('last entry has no cases');
    return { entry };
  } catch (err) {
    return { error: `the last eval history entry is unreadable: ${err.message}` };
  }
}

/**
 * Runs the guard.
 *
 * @param {Object} options
 * @param {string} options.repoRoot
 * @param {string} options.findingsPath  Pipeline output (absolute, or relative to cwd).
 * @param {string} [options.casesDir]    Relative to the repo; default `docs/review-eval/cases`.
 * @param {string} [options.historyPath] JSONL history to compare with and append to.
 * @param {string} [options.reviewer]    Label recorded in the history.
 * @param {boolean} [options.failOnStale]
 * @param {Object} [injected]            Overrides for `defaultDeps()`.
 * @returns {Object} `pass` is true only when every expected Important finding is present and nothing is unproven.
 */
function runGuard(options, injected) {
  const deps = { ...defaultDeps(), ...(injected || {}) };
  if (!isObject(options) || !isText(options.repoRoot) || !isText(options.findingsPath)) {
    return blocked('repoRoot and findingsPath are required');
  }
  const repoRoot = path.resolve(options.repoRoot);
  const casesDirRel = isText(options.casesDir) ? options.casesDir.trim() : DEFAULT_EVAL_CASES_DIR;

  // --- The cases ----------------------------------------------------------
  const loaded = loadCases(deps, path.join(repoRoot, casesDirRel), casesDirRel);
  if (loaded.error) return blocked(loaded.error);
  if (loaded.cases.length === 0) return blocked(`no eval cases under ${casesDirRel}`, { unloadable: loaded.unloadable });

  let codeowners;
  try {
    codeowners = deps.readFile(path.join(repoRoot, CODEOWNERS_REL));
  } catch (err) {
    return blocked(`cannot read ${CODEOWNERS_REL}: ${err.message}`);
  }

  const invalid = [];
  for (const [file, record] of Object.entries(loaded.files)) {
    const verdict = validateCase({ case: record, codeowners, path: file, evalCasesDir: casesDirRel });
    if (!verdict.ok) invalid.push({ file, caseId: verdict.caseId, errors: verdict.errors });
  }

  // --- The pipeline's output ----------------------------------------------
  let findingsByCase;
  try {
    const parsed = JSON.parse(deps.readFile(path.resolve(options.findingsPath)));
    findingsByCase = isObject(parsed) ? parsed.findingsByCase : undefined;
  } catch (err) {
    return blocked(`cannot read the pipeline findings ${options.findingsPath}: ${err.message}`, {
      cases: loaded.cases.length,
      unloadable: loaded.unloadable,
      invalid,
    });
  }
  if (!isObject(findingsByCase)) {
    return blocked('the pipeline findings file has no findingsByCase object', { cases: loaded.cases.length, invalid });
  }

  // --- Score, pins, staleness ---------------------------------------------
  const score = scoreEval({ cases: loaded.cases, findingsByCase, codeowners, evalCasesDir: casesDirRel });
  if (!score.ok) return blocked(`scoring failed: ${score.reason}`, { cases: loaded.cases.length, invalid });

  const missed = score.cases.filter((entry) => !entry.found).map((entry) => ({ id: entry.id, reason: entry.reason }));
  const pins = {};
  for (const record of loaded.cases) pins[record.id] = checkPin(deps, repoRoot, record);
  const badPins = Object.entries(pins)
    .filter(([, pin]) => pin.status === 'no-pinned-sha' || pin.status === 'pin-mismatch')
    .map(([id]) => id);

  const staleResult = staleCases({ cases: loaded.cases, rulesHashes: rulesHashesFor(deps, repoRoot, loaded.cases) });
  const stale = staleResult.ok ? staleResult.stale : loaded.cases.map((record) => record.id);

  // --- History: compare with the last run, then record this one -----------
  let comparison = null;
  let historyProblem = null;
  const historyPath = isText(options.historyPath) ? path.resolve(options.historyPath) : null;
  if (historyPath !== null) {
    const last = lastHistoryEntry(deps, historyPath);
    if (last.error) {
      historyProblem = last.error;
    } else if (last.entry !== null) {
      comparison = compareEval({ previous: { cases: last.entry.cases }, current: score });
      if (!comparison.ok) historyProblem = `comparison with the previous run failed: ${comparison.reason}`;
    }
  }

  const found = score.total.found;
  const total = score.total.cases;
  const falseNegativeRate = total === 0 ? null : Math.round(((total - found) / total) * 10000) / 10000;

  const problems = [];
  if (loaded.unloadable.length > 0) problems.push('unloadable-case-file');
  if (invalid.length > 0) problems.push('invalid-case');
  if (missed.length > 0) problems.push('important-finding-lost');
  if (badPins.length > 0) problems.push('case-not-pinned-to-a-commit');
  if (comparison !== null && comparison.ok && comparison.regression) problems.push('regression-against-previous-run');
  if (historyProblem !== null) problems.push('eval-history-unreadable');
  if (options.failOnStale === true && stale.length > 0) problems.push('stale-case');

  const result = {
    ok: true,
    pass: problems.length === 0,
    problems,
    cases: total,
    found,
    missed,
    falseNegativeRate,
    stale,
    staleReasons: staleResult.ok ? staleResult.reasons : {},
    unloadable: loaded.unloadable,
    invalid,
    pins,
    comparison,
    ...(historyProblem === null ? {} : { historyProblem }),
  };

  if (historyPath !== null && historyProblem === null) {
    const entry = {
      at: deps.now(),
      reviewer: isText(options.reviewer) ? options.reviewer.trim() : null,
      cases: score.cases.map((entry) => ({ id: entry.id, found: entry.found })),
      found,
      total,
      falseNegativeRate,
      missed: missed.map((entry) => entry.id),
      pass: result.pass,
    };
    deps.appendFile(historyPath, `${JSON.stringify(entry)}\n`);
    result.historyRecorded = true;
  }

  return result;
}

function parseArgs(argv) {
  const options = {};
  const valued = { '--findings': 'findingsPath', '--cases': 'casesDir', '--repo': 'repoRoot', '--history': 'historyPath', '--reviewer': 'reviewer' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fail-on-stale') {
      options.failOnStale = true;
    } else if (Object.prototype.hasOwnProperty.call(valued, arg) && index + 1 < argv.length) {
      options[valued[arg]] = argv[index + 1];
      index += 1;
    } else {
      return { error: `unknown or incomplete argument ${JSON.stringify(arg)}` };
    }
  }
  if (!isText(options.findingsPath)) return { error: '--findings <file> is required' };
  if (!isText(options.repoRoot)) options.repoRoot = process.cwd();
  return { options };
}

/** @returns {number} the process exit code */
function main(argv, injected) {
  const parsed = parseArgs(Array.isArray(argv) ? argv : []);
  if (parsed.error) {
    process.stdout.write(`${JSON.stringify({ ok: false, pass: false, error: parsed.error })}\n`);
    return 2;
  }
  const result = runGuard(parsed.options, injected);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.pass ? 0 : 1;
}

module.exports = { runGuard, main, parseArgs, checkPin, defaultDeps, PINNED_SHA };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
