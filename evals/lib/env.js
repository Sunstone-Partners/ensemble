'use strict';

/**
 * Environment allowlist and secret redaction.
 * The agent process gets PATH, LANG, TERM, TMPDIR, HOME and the named credentials; nothing else is inherited.
 * Credential names come from evals/env-allowlist.json (editable) plus any `--allow-env NAME` flags.
 */

const fs = require('fs');
const path = require('path');

const BASE_NAMES = ['PATH', 'LANG', 'TERM', 'TMPDIR'];
const DEFAULT_CREDENTIALS = ['ANTHROPIC_API_KEY'];
const ALLOWLIST_FILE = path.join(__dirname, '..', 'env-allowlist.json');
const REDACTED = '[REDACTED]';
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Credential names from the allowlist file (falls back to the default when the file is absent) plus `extra`. */
function loadCredentialNames({ file = ALLOWLIST_FILE, extra = [] } = {}) {
  let names = DEFAULT_CREDENTIALS;
  if (fs.existsSync(file)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`env allowlist ${file} is not valid JSON: ${e.message}`); }
    if (!parsed || !Array.isArray(parsed.credentials)) throw new Error(`env allowlist ${file} must be { "credentials": [names] }`);
    names = parsed.credentials;
  }
  const all = [...names, ...extra];
  for (const n of all) if (typeof n !== 'string' || !NAME_RE.test(n)) throw new Error(`invalid environment variable name on allowlist: ${JSON.stringify(n)}`);
  return [...new Set(all)];
}

/** Hosted CI: CI=true or GITHUB_ACTIONS=true. */
function isCI(env = process.env) {
  const t = (v) => String(v || '').toLowerCase() === 'true';
  return t(env.CI) || t(env.GITHUB_ACTIONS);
}

/**
 * Build the agent environment from `parent`. `home` overrides HOME (used in CI, where it is a per-run temp dir).
 * Allowlisted names that are unset in the parent stay unset.
 */
function buildEnv({ parent = process.env, credentials = DEFAULT_CREDENTIALS, home } = {}) {
  const env = {};
  for (const n of [...BASE_NAMES, ...credentials]) if (parent[n] !== undefined) env[n] = parent[n];
  if (home !== undefined) env.HOME = home;
  else if (parent.HOME !== undefined) env.HOME = parent.HOME;
  return env;
}

/** Create the per-run HOME directory used in hosted CI, under `workdir`. Caller removes it. */
function makeCiHome(workdir) {
  fs.mkdirSync(workdir, { recursive: true });
  return fs.mkdtempSync(path.join(workdir, 'home-'));
}

/** Values of allowlisted credentials present in `env` (non-empty). */
function secretValues(env, credentials) {
  return [...new Set(credentials.map((n) => env[n]).filter((v) => typeof v === 'string' && v.length > 0))]
    .sort((a, b) => b.length - a.length);
}

/** Replace every secret value (raw and JSON-escaped form) in `text` by [REDACTED]. */
function redactText(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    out = out.split(s).join(REDACTED);
    const escaped = JSON.stringify(s).slice(1, -1);
    if (escaped !== s) out = out.split(escaped).join(REDACTED);
  }
  return out;
}

/** Deep copy of `value` with secrets removed from every string, key included. */
function redactDeep(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactText(k, secrets), redactDeep(v, secrets)]));
  }
  return value;
}

module.exports = {
  BASE_NAMES, DEFAULT_CREDENTIALS, ALLOWLIST_FILE, REDACTED,
  loadCredentialNames, isCI, buildEnv, makeCiHome, secretValues, redactText, redactDeep,
};
