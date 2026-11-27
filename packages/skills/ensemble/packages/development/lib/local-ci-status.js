'use strict';

/**
 * Local CI status publisher: posts the commit status on the exact head SHA
 * with the maintainer's OWN `gh` login (`gh api -X POST repos/OWNER/REPO/statuses/<sha>`),
 * run as an argv array (never a shell). There is no App, JWT, key or token handling
 * here: gh reads its own login and the token is never placed on argv.
 *
 * HONEST-ACTOR trust model: this module cannot prove who posted a status, and
 * pr-merge does not verify it either. FAIL CLOSED: any failure => published:false
 * with redacted text; nothing here ever throws. Tokens never appear in anything
 * returned.
 */

const { spawnSync } = require('child_process');

const STATES = ['error', 'failure', 'pending', 'success'];
const MAX_DESCRIPTION = 100;
const TIMEOUT_MS = 30000;
const CANNOT_ATTEST = 'cannot attest';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

// PEM and JWT redaction are kept as defense in depth (secret_names redaction relies on this module).
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const PATTERNS = [
  PEM_RE,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi,
];
const SENSITIVE_KEY = /token|secret|password|private[-_]?key|authorization|credential/i;

function envSecrets(env) {
  const out = [];
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const v = env && env[k];
    if (typeof v === 'string' && v.length >= 4) out.push(v);
  }
  return out;
}

function redactString(s, secrets) {
  let acc = s;
  for (const secret of secrets) acc = acc.split(secret).join('[REDACTED]');
  return PATTERNS.reduce((a, p) => a.replace(p, '[REDACTED]'), acc);
}

/** Deep-redacts token-shaped strings, Bearer values, PEM/JWT and (optionally) the GH_TOKEN/GITHUB_TOKEN values in `env`. */
function redact(value, env) {
  const secrets = envSecrets(env);
  const walk = (v) => {
    if (typeof v === 'string') return redactString(v, secrets);
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Error) return redactString(String(v.message), secrets);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = typeof x === 'string' && SENSITIVE_KEY.test(k) ? '[REDACTED]' : walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

function defaultRun(cmd, argv, opts) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: TIMEOUT_MS, ...(opts || {}), shell: false });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Post a commit status as the maintainer's gh login on the exact head SHA. Never throws. */
function postStatus({ repo, sha, state, context, description, run = defaultRun, env = process.env } = {}) {
  const refuse = (reason) => ({ published: false, reason: redact(String(reason), env) });
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return refuse('repo must be owner/name');
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return refuse('sha must be 7-64 hex characters');
  if (!STATES.includes(state)) return refuse(`state must be one of ${STATES.join(', ')}`);
  if (typeof context !== 'string' || context.trim() === '') return refuse('context must be non-empty text');
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) {
    return refuse(`description must be text of at most ${MAX_DESCRIPTION} characters`);
  }
  const argv = ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description}`];
  let result;
  try {
    result = run('gh', argv, { env, encoding: 'utf8', timeout: TIMEOUT_MS });
  } catch (err) {
    return refuse(`could not run gh: ${err && err.message ? err.message : err}`);
  }
  if (!result || typeof result !== 'object') return refuse('gh returned no result');
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 300);
    return refuse(`gh api exited with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  let body;
  try {
    body = JSON.parse(String(result.stdout));
  } catch {
    return refuse('gh api output was not JSON');
  }
  if (!body || typeof body !== 'object' || body.id === undefined || body.id === null) return refuse('gh api output had no status id');
  return { published: true, repo, sha, state, context, id: body.id };
}

module.exports = { postStatus, redact, STATES, MAX_DESCRIPTION, CANNOT_ATTEST };
