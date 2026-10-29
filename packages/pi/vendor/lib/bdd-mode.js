'use strict';

/**
 * bdd-mode.js — decide whether a TRD run uses the Reqnroll/BDD test path.
 *
 * BDD stays ON by default, exactly as before this was configurable; this only gives a repo a way to
 * opt out (a Playwright + xUnit repo, a Node or Rails repo). `create-trd` and `implement-trd-beads`
 * both call `trd-cli resolve-bdd`, which wraps `resolveBdd` below, so the two commands always agree.
 * First match wins:
 *
 *   1. `flag`     — `--bdd` / `--no-bdd` (create-trd only; the CLI maps them to 'bdd' | 'no-bdd')
 *   2. `env`      — ENSEMBLE_BDD = 1|true|on|yes (on) or 0|false|off|no (off)
 *   3. `trd`      — the TRD's `test_approach` frontmatter (`bdd-reqnroll` | `standard`), which
 *                   create-trd writes when the choice was explicit (flag or env) so the TRD stays
 *                   self-describing and implement-trd-beads honours an opt-out without the env var
 *   4. `default`  — on
 *
 * Pure and injectable (`env`) so tests never touch process state.
 */

const fs = require('fs');
const path = require('path');
const { splitFrontmatter, normalizeLineEndings, getFrontmatterField } = require('./trd-parser');

const ENV_VAR = 'ENSEMBLE_BDD';
const STAMP_KEY = 'test_approach';
const STAMP_BDD = 'bdd-reqnroll';
const STAMP_STANDARD = 'standard';

const ENV_ON = new Set(['1', 'true', 'on', 'yes']);
const ENV_OFF = new Set(['0', 'false', 'off', 'no']);

const toPosix = (p) => p.split(path.sep).join('/');

/** @returns {boolean|null} true/false for a recognised value, null when unset or unrecognised */
function parseEnv(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (ENV_ON.has(v)) return true;
  if (ENV_OFF.has(v)) return false;
  return null;
}

/** Read the TRD's `test_approach` frontmatter. @returns {{value:boolean|null, raw:string|null}} */
function readStamp(trdPath) {
  let raw;
  try {
    const { frontmatter } = splitFrontmatter(normalizeLineEndings(fs.readFileSync(trdPath, 'utf8')));
    raw = getFrontmatterField(frontmatter, STAMP_KEY);
  } catch {
    return { value: null, raw: null };
  }
  if (raw == null || String(raw).trim() === '') return { value: null, raw: null };
  const v = String(raw).trim().toLowerCase();
  if (v === STAMP_BDD) return { value: true, raw: v };
  if (v === STAMP_STANDARD) return { value: false, raw: v };
  return { value: null, raw: String(raw) };
}

/**
 * Build the result. `message` is the one line the commands print (the warning, if any, first), so
 * the wording lives here rather than in two command prompts. The default says how to opt out.
 */
function decide(enabled, source, evidence, warning) {
  const out = { enabled, source };
  if (evidence) out.evidence = evidence;
  if (warning) out.warning = warning;
  const where = source === 'default' ? 'default; opt out with --no-bdd or ENSEMBLE_BDD=0' : source;
  out.message = `${warning ? `Warning: ${warning}\n` : ''}Test approach: ${enabled ? 'BDD (Reqnroll)' : 'standard'} [${where}]`;
  return out;
}

/**
 * @param {object} [opts]
 * @param {'bdd'|'no-bdd'} [opts.flag]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.trdPath]   consult this TRD's `test_approach`
 * @returns {{enabled:boolean, source:'flag'|'env'|'trd'|'default', evidence?:string, warning?:string, message:string}}
 */
function resolveBdd(opts = {}) {
  const { flag, env = process.env, trdPath } = opts;
  let warning;

  if (flag === 'bdd' || flag === 'no-bdd') return decide(flag === 'bdd', 'flag');

  const envValue = parseEnv(env[ENV_VAR]);
  if (envValue !== null) return decide(envValue, 'env');
  if (env[ENV_VAR] != null && String(env[ENV_VAR]).trim() !== '') {
    warning = `${ENV_VAR}='${env[ENV_VAR]}' is not one of 1/true/on/yes or 0/false/off/no; ignored`;
  }

  if (trdPath) {
    const stamp = readStamp(trdPath);
    if (stamp.value !== null) return decide(stamp.value, 'trd', toPosix(trdPath));
    if (stamp.raw !== null) {
      warning = `${STAMP_KEY} '${stamp.raw}' in ${toPosix(trdPath)} is not '${STAMP_BDD}' or '${STAMP_STANDARD}'; ignored`;
    }
  }

  return decide(true, 'default', undefined, warning);
}

module.exports = { resolveBdd, ENV_VAR, STAMP_KEY, STAMP_BDD, STAMP_STANDARD };
